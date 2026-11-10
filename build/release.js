#!/usr/bin/env node
// npm run release            → Apple Silicon
// npm run release:universal  → Intel + Apple Silicon
//
// Signs with your "Developer ID Application" certificate, notarizes with Apple, and publishes
// the DMG + update files to GitHub Releases. Installed apps pick the update up automatically.

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));

const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };
const ok = (msg) => console.log(`✔ ${msg}`);

if (process.platform !== 'darwin') fail('Een release kan alleen op een Mac gebouwd worden.');

// 1. GitHub repo
const pub = [].concat(pkg.build.publish || [])[0] || {};
if (!pub.owner || pub.owner === 'VUL-IN') {
  fail('Vul in package.json bij build.publish de GitHub "owner" (account of organisatie) in, en controleer "repo".');
}
ok(`GitHub-repo: ${pub.owner}/${pub.repo}`);

// 2. Developer ID certificate
let identities = '';
try { identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' }); } catch { /* none */ }
const devId = identities.split('\n').map((l) => l.match(/"(Developer ID Application: [^"]+)"/)?.[1]).find(Boolean);
if (!devId) {
  fail(`Geen "Developer ID Application"-certificaat gevonden in je sleutelhanger.
  Maak er een aan: Xcode → Settings → Accounts → (je team) → Manage Certificates → + → Developer ID Application.
  (Alleen de Account Holder van het Apple Developer-team kan dit type aanmaken.)`);
}
ok(`Certificaat: ${devId}`);

// 3. Notarization credentials (stored once with: xcrun notarytool store-credentials keito-notary …)
const env = { ...process.env, CSC_NAME: devId };
delete env.KEITO_ADHOC;
if (!env.APPLE_API_KEY && !env.APPLE_ID) env.APPLE_KEYCHAIN_PROFILE = env.APPLE_KEYCHAIN_PROFILE || 'keito-notary';
if (env.APPLE_KEYCHAIN_PROFILE) {
  const check = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE], { encoding: 'utf8' });
  if (check.status !== 0) {
    fail(`Notarisatie-profiel "${env.APPLE_KEYCHAIN_PROFILE}" werkt niet. Sla het één keer op met:
  xcrun notarytool store-credentials keito-notary --apple-id <jouw-apple-id> --team-id <TEAM-ID> --password <app-specifiek-wachtwoord>
  (app-specifiek wachtwoord: account.apple.com → Inloggen en beveiliging → App-specifieke wachtwoorden)`);
  }
}
ok('Notarisatie-gegevens gevonden');

// 4. GitHub token
if (!env.GH_TOKEN) {
  try { env.GH_TOKEN = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* gh not installed */ }
}
if (!env.GH_TOKEN) {
  fail(`Geen GitHub-token. Log in met de GitHub CLI (brew install gh && gh auth login),
  of zet GH_TOKEN met een token dat "Contents: read and write" heeft op ${pub.owner}/${pub.repo}.`);
}
ok('GitHub-token gevonden');

// 5. Build, sign, notarize, publish
const arch = process.argv.includes('--universal') ? '--universal' : '--arm64';
console.log(`\n→ Keito Bar ${pkg.version} bouwen (${arch.slice(2)}), signeren, notariseren en publiceren…`);
console.log('  Notariseren duurt meestal 2–10 minuten.\n');
const r = spawnSync('npx', ['electron-builder', '--mac', arch, '--publish', 'always'], { stdio: 'inherit', env });
if (r.status !== 0) fail('Build of publicatie mislukt (zie hierboven).');

console.log(`\n✔ Keito Bar ${pkg.version} staat op https://github.com/${pub.owner}/${pub.repo}/releases`);
console.log('  Geïnstalleerde apps vinden de update binnen 4 uur (of via Instellingen → Controleer op updates).');
console.log('  Volgende keer eerst het versienummer ophogen: npm version patch --no-git-tag-version\n');
