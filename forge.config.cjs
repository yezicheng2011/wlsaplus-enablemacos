const path = require('node:path');

const osxSign = process.env.APPLE_IDENTITY
  ? { identity: process.env.APPLE_IDENTITY, hardenedRuntime: true, entitlements: path.join(__dirname, 'electron', 'entitlements.plist') }
  : undefined;
const osxNotarize = process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
  ? { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_APP_PASSWORD, teamId: process.env.APPLE_TEAM_ID }
  : undefined;

module.exports = {
  packagerConfig: {
    asar: true,
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
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/captures($|\/)/,
      /^\/src($|\/)/,
      /^\/public($|\/)/,
      /^\/scripts($|\/)/,
      /^\/phone-network($|\/)/,
      /^\/phone-relay-worker($|\/)/,
      /^\/powerschool-worker($|\/)/,
      /^\/vpn-subscription-worker($|\/)/,
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
    ],
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { name: 'WLSAPlus' }, platforms: ['darwin'] },
  ],
};
