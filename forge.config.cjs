const path = require('node:path');

const entitlementsPath = path.join(__dirname, 'electron', 'entitlements.plist');
const selfSign =
  process.env.WLSAPLUS_SELF_SIGN === '1' || process.env.APPLE_IDENTITY === '-';
const osxSign = selfSign
  ? { identity: '-', hardenedRuntime: false, entitlements: entitlementsPath }
  : process.env.APPLE_IDENTITY
    ? { identity: process.env.APPLE_IDENTITY, hardenedRuntime: true, entitlements: entitlementsPath }
    : undefined;
const osxNotarize = process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
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
  /^\/electron\/.*\.test\.cjs$/,
  /^\/electron\/bin($|\/)/,
  /^\/output($|\/)/,
  /^\/out($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.github($|\/)/,
  /^\/\.angular($|\/)/,
  /^\/\.playwright-cli($|\/)/,
  /^\/\.tmp-angular($|\/)/,
  /^\/dist\/wlsaplus\/browser\/ocr($|\/)/,
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
    // vpn-core -> Resources/vpn-core; electron/bin -> Resources/bin (mac-vpn.tar.gz)
    extraResource: [
      path.join(__dirname, 'build', 'vpn-core'),
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
