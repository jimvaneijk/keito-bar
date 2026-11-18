#!/usr/bin/env node
// npm run release            → Apple Silicon
// npm run release:universal  → Intel + Apple Silicon
//
// Signs with your "Developer ID Application" certificate, notarizes with Apple, and publishes
// the DMG + update files to GitHub Releases. Installed apps pick the update up automatically.

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const packageJson = require(path.join(__dirname, '..', 'package.json'));

const fail = (message) => {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
};
const success = (message) => console.log(`✔ ${message}`);

if (process.platform !== 'darwin') fail('Een release kan alleen op een Mac gebouwd worden.');

// 1. GitHub repo
const publishConfig = [].concat(packageJson.build.publish || [])[0] || {};
if (!publishConfig.owner || publishConfig.owner === 'VUL-IN') {
    fail('Vul in package.json bij build.publish de GitHub "owner" (account of organisatie) in, en controleer "repo".');
}
success(`GitHub-repo: ${publishConfig.owner}/${publishConfig.repo}`);

// 2. Developer ID certificate
let identities = '';
try {
    identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
} catch {
    /* none */
}
const developerIdentity = identities
    .split('\n')
    .map((line) => line.match(/"(Developer ID Application: [^"]+)"/)?.[1])
    .find(Boolean);
if (!developerIdentity) {
    fail(`Geen "Developer ID Application"-certificaat gevonden in je sleutelhanger.
  Maak er een aan: Xcode → Settings → Accounts → (je team) → Manage Certificates → + → Developer ID Application.
  (Alleen de Account Holder van het Apple Developer-team kan dit type aanmaken.)`);
}
success(`Certificaat: ${developerIdentity}`);

// 3. Notarization credentials (stored once with: xcrun notarytool store-credentials keito-notary …)
// electron-builder wants the name without the type prefix, e.g. "Joannes van Eijk (TEAMID)".
const env = { ...process.env, CSC_NAME: developerIdentity.replace(/^Developer ID Application:\s*/, '') };
delete env.KEITO_ADHOC;
if (!env.APPLE_API_KEY && !env.APPLE_ID) env.APPLE_KEYCHAIN_PROFILE = env.APPLE_KEYCHAIN_PROFILE || 'keito-notary';
if (env.APPLE_KEYCHAIN_PROFILE) {
    const check = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE], {
        encoding: 'utf8',
    });
    if (check.status !== 0) {
        fail(`Notarisatie-profiel "${env.APPLE_KEYCHAIN_PROFILE}" werkt niet. Sla het één keer op met:
  xcrun notarytool store-credentials keito-notary --apple-id <jouw-apple-id> --team-id <TEAM-ID> --password <app-specifiek-wachtwoord>
  (app-specifiek wachtwoord: account.apple.com → Inloggen en beveiliging → App-specifieke wachtwoorden)`);
    }
}
success('Notarisatie-gegevens gevonden');

// 4. GitHub token
if (!env.GH_TOKEN) {
    try {
        env.GH_TOKEN = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        /* gh not installed */
    }
}
if (!env.GH_TOKEN) {
    fail(`Geen GitHub-token. Log in met de GitHub CLI (brew install gh && gh auth login),
  of zet GH_TOKEN met een token dat "Contents: read and write" heeft op ${publishConfig.owner}/${publishConfig.repo}.`);
}
success('GitHub-token gevonden');

// 4b. Does the repo from package.json exist (and can this token see it)? Fail now, not after notarizing.
const repoCheck = spawnSync(
    'curl',
    [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-H',
        `Authorization: Bearer ${env.GH_TOKEN}`,
        `https://api.github.com/repos/${publishConfig.owner}/${publishConfig.repo}`,
    ],
    { encoding: 'utf8' },
);
if (repoCheck.stdout === '404') {
    let remote = '';
    try {
        remote = execSync('git remote get-url origin', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        /* no git repo */
    }
    fail(`GitHub-repo ${publishConfig.owner}/${publishConfig.repo} bestaat niet (of je token mag er niet bij).
  Controleer build.publish in package.json${remote ? ` (je git-remote is ${remote})` : ''}.`);
}
if (repoCheck.stdout === '200') success(`GitHub-repo ${publishConfig.owner}/${publishConfig.repo} gevonden`);

// 5. GitHub helper (curl; the token goes in via stdin, never on the command line)
const repoApi = `https://api.github.com/repos/${publishConfig.owner}/${publishConfig.repo}`;
function github(method, url, { body, file, contentType } = {}) {
    const args = ['-sS', '-X', method, '-H', '@-', '-H', 'Accept: application/vnd.github+json', '-w', '\n%{http_code}'];
    if (body) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
    if (file) args.push('-H', `Content-Type: ${contentType}`, '--data-binary', `@${file}`);
    args.push(url);
    const result = spawnSync('curl', args, {
        encoding: 'utf8',
        input: `Authorization: Bearer ${env.GH_TOKEN}\n`,
        maxBuffer: 64 * 1024 * 1024,
    });
    const output = result.stdout || '';
    const cut = output.lastIndexOf('\n');
    const status = Number(output.slice(cut + 1));
    let data = null;
    try {
        data = JSON.parse(output.slice(0, cut) || 'null');
    } catch {
        /* not JSON */
    }
    return { status, data };
}
const findRelease = (tag) => {
    const { status, data } = github('GET', `${repoApi}/releases?per_page=50`);
    if (status !== 200 || !Array.isArray(data)) fail(`Kon de releases op GitHub niet lezen (HTTP ${status}).`);
    return data.find((release) => release.tag_name === tag) || null;
};

// 6. Is this version new?
const version = packageJson.version;
const tag = `v${version}`;
const uploadOnly = process.argv.includes('--upload-only'); // complete a release whose upload broke off
let release = findRelease(tag);
if (release && !release.draft && !uploadOnly) {
    fail(`Versie ${version} staat al op GitHub.
  Verhoog eerst het versienummer: npm version patch --no-git-tag-version
  (Is die release onvolledig? Vul hem aan met: npm run release -- --upload-only)`);
}
try {
    const unpushed = execSync('git rev-list --count @{u}..HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (Number(unpushed) > 0) console.log(`⚠︎ Je hebt ${unpushed} commit(s) die nog niet gepusht zijn (git push).`);
} catch {
    /* no upstream */
}

// 7. Build, sign and notarize. Publishing is done below, one file at a time: electron-builder
//    uploads DMG and zip in parallel and both try to create the release (→ "must have a valid tag").
const archFlag = process.argv.includes('--universal') ? '--universal' : '--arm64';
const archName = archFlag.slice(2);
if (!uploadOnly) {
    console.log(`\n→ Keito Bar ${version} bouwen (${archName}), signeren en notariseren…`);
    console.log('  Notariseren duurt meestal 2–10 minuten.\n');
    const buildResult = spawnSync('npx', ['electron-builder', '--mac', archFlag, '--publish', 'never'], {
        stdio: 'inherit',
        env,
    });
    if (buildResult.status !== 0) fail('Bouwen, signeren of notariseren mislukt (zie hierboven).');
}

// 8. Collect the files; make sure the update file is there and belongs to this version
const fs = require('fs');
const { writeLatestMac } = require('./update-info');
const dist = path.join(__dirname, '..', 'dist');
const zipName = `Keito-Bar-${version}-${archName}.zip`;
const dmgName = `Keito-Bar-${version}-${archName}.dmg`;
for (const name of [zipName, dmgName]) {
    if (!fs.existsSync(path.join(dist, name)))
        fail(`${name} ontbreekt in dist/. Draai npm run release zonder --upload-only.`);
}
const latestPath = path.join(dist, 'latest-mac.yml');
if (!fs.existsSync(latestPath) || !fs.readFileSync(latestPath, 'utf8').startsWith(`version: ${version}\n`)) {
    writeLatestMac(dist, version, [zipName, dmgName]);
}
const assets = [
    [zipName, 'application/zip'],
    [`${zipName}.blockmap`, 'application/octet-stream'],
    [dmgName, 'application/x-apple-diskimage'],
    [`${dmgName}.blockmap`, 'application/octet-stream'],
    ['latest-mac.yml', 'application/x-yaml'], // last: apps only see the update once everything is there
].filter(([name]) => fs.existsSync(path.join(dist, name)));

// 9. One (draft) release, files one by one, then publish
if (!release) {
    const created = github('POST', `${repoApi}/releases`, {
        body: {
            tag_name: tag,
            target_commitish: 'main',
            name: `Keito Bar ${version}`,
            draft: true,
            body: `Keito Bar ${version}`,
        },
    });
    if (created.status !== 201)
        fail(`Kon de release niet aanmaken (HTTP ${created.status}): ${JSON.stringify(created.data)}`);
    release = created.data;
}
console.log(`\n→ Uploaden naar GitHub (${release.draft ? 'concept' : 'bestaande release'} ${tag})`);
for (const [name, contentType] of assets) {
    const filePath = path.join(dist, name);
    const size = fs.statSync(filePath).size;
    const existingAsset = (release.assets || []).find((asset) => asset.name === name);
    if (
        existingAsset &&
        existingAsset.size === size &&
        existingAsset.state === 'uploaded' &&
        name !== 'latest-mac.yml'
    ) {
        success(`${name} staat er al`);
        continue;
    }
    if (existingAsset) github('DELETE', `${repoApi}/releases/assets/${existingAsset.id}`);
    process.stdout.write(`  ${name} (${(size / 1024 / 1024).toFixed(1)} MB)… `);
    const uploadUrl = `https://uploads.github.com/repos/${publishConfig.owner}/${publishConfig.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    const uploaded = github('POST', uploadUrl, { file: filePath, contentType });
    if (uploaded.status !== 201) {
        console.log('');
        fail(
            `Upload van ${name} mislukt (HTTP ${uploaded.status}). Probeer opnieuw met: npm run release -- --upload-only`,
        );
    }
    console.log('✔');
}
if (release.draft) {
    const published = github('PATCH', `${repoApi}/releases/${release.id}`, {
        body: { draft: false, make_latest: 'true' },
    });
    if (published.status !== 200)
        fail(`Publiceren mislukt (HTTP ${published.status}): ${JSON.stringify(published.data)}`);
}

console.log(
    `\n✔ Keito Bar ${version} staat op https://github.com/${publishConfig.owner}/${publishConfig.repo}/releases/tag/${tag}`,
);
console.log('  Geïnstalleerde apps vinden de update binnen 4 uur (of via Instellingen → Controleer op updates).');
console.log('  Volgende keer eerst het versienummer ophogen: npm version patch --no-git-tag-version\n');
