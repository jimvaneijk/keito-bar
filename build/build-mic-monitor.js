#!/usr/bin/env node
// Compiles native/mic-monitor.swift into resources/bin/mic-monitor (arm64 + x86_64 when possible).
// Runs automatically before `npm start`, `npm run dist` and `npm run release`.
// Without Xcode command line tools it only warns: Keito Bar then works without meeting detection.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'mic-monitor.swift');
const outputDirectory = path.join(root, 'resources', 'bin');
const output = path.join(outputDirectory, 'mic-monitor');

const warn = (message) => console.warn(`⚠︎ mic-monitor: ${message}`);

// Always create the folder, so electron-builder's extraResources never points at nothing.
fs.mkdirSync(outputDirectory, { recursive: true });

if (process.platform !== 'darwin') {
    warn('alleen te bouwen op macOS; meetingdetectie wordt overgeslagen.');
    process.exit(0);
}

if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
    process.exit(0); // up to date
}

const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
if (swiftc.status !== 0) {
    warn('geen Swift-compiler gevonden (installeer Xcode of: xcode-select --install). Meetingdetectie staat uit.');
    process.exit(0);
}

function compile(architecture) {
    const target = `${architecture}-apple-macos12`;
    const architectureOutput = `${output}-${architecture}`;
    const result = spawnSync('xcrun', ['swiftc', '-O', '-target', target, source, '-o', architectureOutput], {
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        console.error(result.stderr || result.stdout);
        return null;
    }
    return architectureOutput;
}

const builtArchitectures = ['arm64', 'x86_64'].map(compile).filter(Boolean);
if (!builtArchitectures.length) {
    warn('compileren mislukt (zie hierboven). Meetingdetectie staat uit.');
    process.exit(0);
}

if (builtArchitectures.length === 2) {
    const lipo = spawnSync('lipo', ['-create', ...builtArchitectures, '-output', output], { encoding: 'utf8' });
    if (lipo.status !== 0) {
        console.error(lipo.stderr);
        fs.copyFileSync(builtArchitectures[0], output);
    }
} else {
    fs.copyFileSync(builtArchitectures[0], output);
}
builtArchitectures.forEach((file) => fs.rmSync(file, { force: true }));
fs.chmodSync(output, 0o755);
console.log(`✔ mic-monitor gebouwd (${builtArchitectures.map((file) => file.split('-').pop()).join(' + ')})`);
