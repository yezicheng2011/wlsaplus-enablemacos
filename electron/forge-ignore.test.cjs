const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const path = require('node:path');

const root = path.join(__dirname, '..');
const forge = require(path.join(root, 'forge.config.cjs'));
const ignore = forge.packagerConfig.ignore;

test('forge packages only runtime code, the renderer and license notices', () => {
  assert.equal(forge.packagerConfig.prune, false);
  for (const file of [
    '', '/', '/package.json', '/LICENSE', '/THIRD_PARTY_NOTICES.md',
    '/electron', '/electron/main.cjs', '/electron/preload.cjs',
    '/electron/mac-updater.cjs', '/electron/update-core.cjs', '/electron/update-config.cjs',
    '/electron/update-helper.sh', '/electron/forum-config.cjs', '/electron/forum-sso.cjs',
    '/electron/forum-theme.cjs', '/build', '/build/icon.png', '/dist', '/dist/wlsaplus',
    '/dist/wlsaplus/3rdpartylicenses.txt', '/dist/wlsaplus/browser',
    '/dist/wlsaplus/browser/index.html', '/dist/wlsaplus/browser/media/icons.woff2',
    '/node_modules', '/node_modules/js-yaml', '/node_modules/js-yaml/index.js',
    '/node_modules/js-yaml/lib', '/node_modules/js-yaml/lib/loader.js',
  ]) assert.equal(ignore(file), false, file);

  for (const file of [
    '/node_modules/argparse', '/node_modules/js-yaml/bin', '/node_modules/js-yaml/dist',
    '/node_modules/js-yaml/README.md', '/node_modules/rxjs', '/node_modules/@angular/core',
    '/electron/forum-theme.test.cjs', '/electron/entitlements.plist', '/build/icon.icns',
    '/src', '/src/app/app.ts', '/public', '/scripts', '/docs', '/release-kit',
    '/vpn-subscription-worker', '/release-assets/WLSAPlus.zip', '/e2e-logs/update.log',
    '/package-lock.json', '/forge.config.cjs', '/README.md', '/OVERNIGHT_SUMMARY.md',
    '/.git', '/.github', '/.angular', '/.env', '/unexpected-output',
    '/dist/wlsaplus/browser/main.js.map', '/dist/old-build/index.html',
  ]) assert.equal(ignore(file), true, file);
  assert.equal(ignore('node_modules/rxjs'), true);
  assert.equal(ignore('electron/main.cjs'), false);
});

test('VPN archive is copied once as Resources/bin', () => {
  assert.equal(ignore('/electron/bin'), true);
  assert.equal(ignore('/electron/bin/mac-vpn.tar.gz'), true);
  assert.deepEqual(forge.packagerConfig.extraResource.map((entry) => path.relative(root, entry)), [path.join('electron', 'bin')]);
});

test('removed OCR code and stale OCR assets stay out of the package', () => {
  for (const file of [
    '/node_modules/tesseract.js', '/node_modules/@tesseract.js-data',
    '/dist/wlsaplus/browser/ocr', '/dist/wlsaplus/browser/ocr/worker.min.js',
    '/dist/wlsaplus/browser/ocr/eng.traineddata.gz',
  ]) assert.equal(ignore(file), true, file);
  const angular = require(path.join(root, 'angular.json'));
  assert.equal(angular.projects.wlsaplus.architect.build.options.assets.some((asset) => asset.output === 'ocr'), false);
});

test('the packaged js-yaml subset can load and dump profiles without other modules', (t) => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsaplus-runtime-'));
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }));
  const source = path.join(root, 'node_modules', 'js-yaml');
  const destination = path.join(staging, 'node_modules', 'js-yaml');
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (file) => !ignore(`/${path.relative(root, file).split(path.sep).join('/')}`),
  });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const yaml = require(process.argv[1]);
    const profile = { proxies: [{ name: 'test', type: 'ss', port: 443 }], mode: 'rule' };
    assert.deepEqual(yaml.load(yaml.dump(profile)), profile);
  `, destination], { cwd: staging });
});

test('forge does not sign ad-hoc builds (working.command runs codesign itself)', () => {
  const configPath = require.resolve(path.join('..', 'forge.config.cjs'));
  const saved = { APPLE_IDENTITY: process.env.APPLE_IDENTITY, WLSAPLUS_SELF_SIGN: process.env.WLSAPLUS_SELF_SIGN };
  try {
    for (const env of [{}, { APPLE_IDENTITY: '-', WLSAPLUS_SELF_SIGN: '1' }]) {
      delete process.env.APPLE_IDENTITY;
      delete process.env.WLSAPLUS_SELF_SIGN;
      Object.assign(process.env, env);
      delete require.cache[configPath];
      const forge = require(configPath);
      assert.equal(forge.packagerConfig.osxSign, undefined);
      assert.equal(forge.packagerConfig.osxNotarize, undefined);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[configPath];
  }
});
