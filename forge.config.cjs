const path = require('node:path');

const entitlementsPath = path.join(__dirname, 'electron', 'entitlements.plist');

// Ad-hoc builds (the working.command build kit, the self-sign CI workflow) are NOT signed by Forge:
// osxSign stays undefined and the scripts run
//   codesign --force --deep --sign - --entitlements electron/entitlements.plist WLSAPlus.app
// afterwards. The old ad-hoc osxSign block never took effect: @electron/osx-sign 1.3.3 ignores
// top-level hardenedRuntime/entitlements, and identity '-' without identityValidation:false throws
// "No identity found", which @electron/packager swallows (continueOnError defaults to true).
// Only a real Developer ID (release.yml with APPLE_IDENTITY secret) is signed by Forge, with
// per-file options in the shape osx-sign 1.3.x actually reads.
const developerIdentity =
  process.env.APPLE_IDENTITY && process.env.APPLE_IDENTITY !== '-' ? process.env.APPLE_IDENTITY : '';
const osxSign = developerIdentity
  ? {
      identity: developerIdentity,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: entitlementsPath }),
    }
  : undefined;
// Notarization needs a real signature, so it is only enabled together with a Developer ID.
const osxNotarize = osxSign && process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
  ? { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_APP_PASSWORD, teamId: process.env.APPLE_TEAM_ID }
  : undefined;

// The renderer is already bundled in dist. Ship only the main-process runtime,
// the production renderer, and license notices; new build outputs stay excluded.
const RUNTIME_FILES = new Set([
  '/package.json',
  '/LICENSE',
  '/THIRD_PARTY_NOTICES.md',
  '/build/icon.png',
  '/dist/wlsaplus/3rdpartylicenses.txt',
  '/electron/update-helper.sh',
  '/node_modules/js-yaml/package.json',
  '/node_modules/js-yaml/index.js',
  '/node_modules/js-yaml/LICENSE',
]);
const RUNTIME_DIRECTORIES = new Set([
  '/', '/build', '/dist', '/dist/wlsaplus', '/electron',
  '/node_modules', '/node_modules/js-yaml',
]);

function isRuntimeFile(file) {
  if (RUNTIME_FILES.has(file) || RUNTIME_DIRECTORIES.has(file)) return true;
  if (/^\/electron\/[^/]+\.cjs$/.test(file)) return !file.endsWith('.test.cjs');
  if (/^\/dist\/wlsaplus\/browser(?:$|\/)/.test(file)) {
    return !/\.map$/.test(file) && !/^\/dist\/wlsaplus\/browser\/ocr(?:$|\/)/.test(file);
  }
  // js-yaml's CJS entry uses only lib/. Its argparse dependency belongs to the
  // command-line executable, which the app never invokes.
  return /^\/node_modules\/js-yaml\/lib(?:$|\/)/.test(file);
}

module.exports = {
  packagerConfig: {
    asar: true,
    // prune:true walks package.json production deps and bypasses our ignore() for
    // module roots — that pulled renderer build dependencies into asar. With prune:false the
    // runtime allow-list fully controls what ships for the main process.
    prune: false,
    electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
    executableName: 'WLSAPlus',
    icon: path.join(__dirname, 'build', 'icon'),
    appBundleId: 'cn.org.wlsash.wlsaplus',
    appCategoryType: 'public.app-category.education',
    osxSign,
    osxNotarize,
    // `--arch universal` (working.command / CI) packages x64 + arm64 and merges them with
    // @electron/universal; no extra osxUniversal options are needed: app.asar is identical for both
    // arches (no native modules ship), and the universal mihomo core sits inside mac-vpn.tar.gz,
    // so it is copied as-is rather than lipo-merged. osxSign (Developer ID only) runs on the merged app.
    // electron/bin -> Resources/bin (mac-vpn.tar.gz = mihomo, the only macOS VPN core,
    // plus LICENSE-mihomo.txt).
    extraResource: [
      path.join(__dirname, 'electron', 'bin'),
    ],
    ignore: (file) => {
      // Packager usually prefixes '/', but normalize either form.
      const normalized = !file ? '/' : (file.startsWith('/') ? file : `/${file}`);
      return !isRuntimeFile(normalized);
    },
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { name: 'WLSAPlus' }, platforms: ['darwin'] },
  ],
};
