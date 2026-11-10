// Local test builds only (npm run dist): ad-hoc sign the .app so it starts on Apple Silicon
// without an Apple certificate. Release builds (npm run release) are signed with your
// Developer ID by electron-builder itself, so this hook does nothing there.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
    if (process.env.KEITO_ADHOC !== '1') return;
    if (context.electronPlatformName !== 'darwin') return;
    if (/-temp$/.test(context.appOutDir)) return; // universal: only sign the merged app
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    console.log(`  • ad-hoc signing  ${app}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
