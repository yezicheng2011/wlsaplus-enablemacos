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

// Main-process runtime packages (and their transitive deps). Angular/web deps live in dist/,
// so the rest of node_modules must stay out of the asar — but blanketing all of
// node_modules made packaged apps crash on require('electron-updater') / require('js-yaml').
const RUNTIME_NODE_MODULES = new Set([
  'argparse',
  'builder-util-runtime',
  'debug',
  'electron-updater',
  'fs-extra',
  'graceful-fs',
  'has-flag',
  'js-yaml',
  'jsonfile',
  'lazy-val',
  'lodash.escaperegexp',
  'lodash.isequal',
  'ms',
  'sax',
  'semver',
  'supports-color',
  'tiny-typed-emitter',
  'universalify',
]);

const IGNORE_PATHS = [
  /^\/captures($|\/)/,
  /^\/src($|\/)/,
  /^\/public($|\/)/,
  /^\/scripts($|\/)/,
  /^\/powerschool-worker($|\/)/,
  /^\/vpn-subscription-worker($|\/)/,
  /^\/release-kit($|\/)/,
  // build/ holds packaging inputs. Only build/icon.png is read at runtime (window icon);
  // build/vpn-core (legacy sing-box/v2ray-plugin, unused on macOS) and icon.icns stay out of app.asar.
  /^\/build\/(?!icon\.png$).+/,
  /^\/electron\/.*\.test\.cjs$/,
  /^\/electron\/bin($|\/)/,
  /^\/output($|\/)/,
  /^\/out($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.github($|\/)/,
  /^\/\.angular($|\/)/,
  /^\/\.playwright-cli($|\/)/,
  /^\/\.tmp-angular($|\/)/,
  // dist/wlsaplus/browser/ocr (tesseract worker/core/lang data) MUST ship: translator.page.ts
  // loads OCR assets from new URL('ocr/', document.baseURI).
  /^\/(angular|ngsw|tsconfig).*\.(json|ts)$/,
  /^\/README\.md$/,
];

function isKeptNodeModule(file) {
  if (file === '/node_modules') return true;
  const match = file.match(/^\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/|$)/);
  if (!match) return false;
  return RUNTIME_NODE_MODULES.has(match[1]);
}

module.exports = {
  packagerConfig: {
    asar: true,
    // prune:true walks package.json production deps and bypasses our ignore() for
    // module roots — that pulled Angular/tesseract into asar. With prune:false the
    // RUNTIME_NODE_MODULES allow-list fully controls what ships for the main process.
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
    // plus LICENSE-mihomo.txt). sing-box/v2ray-plugin are not shipped.
    extraResource: [
      path.join(__dirname, 'electron', 'bin'),
    ],
    ignore: (file) => {
      // Packager usually prefixes '/', but normalize either form.
      const normalized = !file ? file : (file.startsWith('/') ? file : `/${file}`);
      if (normalized.startsWith('/node_modules')) return !isKeptNodeModule(normalized);
      return IGNORE_PATHS.some((pattern) => pattern.test(normalized));
    },
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { name: 'WLSAPlus' }, platforms: ['darwin'] },
  ],
};
