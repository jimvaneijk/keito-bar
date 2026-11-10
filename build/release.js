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

// 5. Build, sign, notarize, publish
const arch = process.argv.includes('--universal') ? '--universal' : '--arm64';
console.log(`\n→ Keito Bar ${packageJson.version} bouwen (${arch.slice(2)}), signeren, notariseren en publiceren…`);
console.log('  Notariseren duurt meestal 2–10 minuten.\n');
const buildResult = spawnSync('npx', ['electron-builder', '--mac', arch, '--publish', 'always'], {
    stdio: 'inherit',
    env,
});
if (buildResult.status !== 0) fail('Build of publicatie mislukt (zie hierboven).');

console.log(
    `\n✔ Keito Bar ${packageJson.version} staat op https://github.com/${publishConfig.owner}/${publishConfig.repo}/releases`,
);
console.log('  Geïnstalleerde apps vinden de update binnen 4 uur (of via Instellingen → Controleer op updates).');
console.log('  Volgende keer eerst het versienummer ophogen: npm version patch --no-git-tag-version\n');
