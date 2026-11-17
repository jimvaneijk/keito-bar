// Writes dist/latest-mac.yml: the file installed apps read to discover an update
// (same format electron-builder produces).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha512Base64(file) {
    const hash = crypto.createHash('sha512');
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, bytesRead));
    fs.closeSync(handle);
    return hash.digest('base64');
}

/**
 * @param {string} distDirectory
 * @param {string} version
 * @param {string[]} fileNames  zip first (that is what the updater downloads), then dmg
 */
function writeLatestMac(distDirectory, version, fileNames) {
    const files = fileNames.map((name) => {
        const fullPath = path.join(distDirectory, name);
        return {
            url: name,
            sha512: sha512Base64(fullPath),
            size: fs.statSync(fullPath).size,
            mtime: fs.statSync(fullPath).mtime,
        };
    });
    const zip = files.find((file) => file.url.endsWith('.zip')) || files[0];
    const lines = [
        `version: ${version}`,
        'files:',
        ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
        `path: ${zip.url}`,
        `sha512: ${zip.sha512}`,
        `releaseDate: '${zip.mtime.toISOString()}'`,
    ];
    const output = path.join(distDirectory, 'latest-mac.yml');
    fs.writeFileSync(output, lines.join('\n') + '\n');
    return output;
}

module.exports = { writeLatestMac, sha512Base64 };

if (require.main === module) {
    // node build/update-info.js 0.3.0 arm64
    const [version, arch = 'arm64'] = process.argv.slice(2);
    const dist = path.join(__dirname, '..', 'dist');
    const written = writeLatestMac(dist, version, [
        `Keito-Bar-${version}-${arch}.zip`,
        `Keito-Bar-${version}-${arch}.dmg`,
    ]);
    console.log(fs.readFileSync(written, 'utf8'));
}
