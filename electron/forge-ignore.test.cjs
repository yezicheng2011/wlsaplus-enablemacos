const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

test('forge ignore keeps main-process runtime modules and dist UI', () => {
  const forge = require(path.join('..', 'forge.config.cjs'));
  const ignore = forge.packagerConfig.ignore;
  assert.equal(forge.packagerConfig.prune, false);
  assert.equal(ignore('/node_modules/electron-updater'), false);
  assert.equal(ignore('/node_modules/js-yaml'), false);
  assert.equal(ignore('/node_modules/electron-updater/node_modules/semver/index.js'), false);
  assert.equal(ignore('/dist/wlsaplus/browser/index.html'), false);
  assert.equal(ignore('/electron/main.cjs'), false);
  assert.equal(ignore('/electron/forum-config.cjs'), false);
  assert.equal(ignore('/electron/forum-sso.cjs'), false);
  assert.equal(ignore('/electron/forum-theme.cjs'), false);
  assert.equal(ignore('/electron/forum-theme.test.cjs'), true);
  assert.equal(ignore('/electron/forum-config.test.cjs'), true);
  assert.equal(ignore('/node_modules/tesseract.js'), true);
  assert.equal(ignore('/node_modules/rxjs'), true);
  assert.equal(ignore('/node_modules/@angular/core'), true);
  assert.equal(ignore('/src/app/app.ts'), true);
  assert.equal(ignore('node_modules/tesseract.js'), true); // no leading slash
});

test('forge keeps sing-box/v2ray-plugin out of the app; mihomo ships via Resources/bin', () => {
  const forge = require(path.join('..', 'forge.config.cjs'));
  const ignore = forge.packagerConfig.ignore;
  // build/icon.png is the runtime window icon (electron/main.cjs iconPath)
  assert.equal(ignore('/build'), false);
  assert.equal(ignore('/build/icon.png'), false);
  assert.equal(ignore('/build/icon.icns'), true);
  assert.equal(ignore('/build/vpn-core'), true);
  assert.equal(ignore('/build/vpn-core/sing-box'), true);
  assert.equal(ignore('/build/vpn-core/v2ray-plugin'), true);
  assert.equal(ignore('/electron/bin/mac-vpn.tar.gz'), true); // extraResource, not asar
  const extra = forge.packagerConfig.extraResource.map((entry) => path.relative(path.join(__dirname, '..'), entry));
  assert.deepEqual(extra, [path.join('electron', 'bin')]);
});

test('forge ships the OCR assets that translator.page.ts loads from ocr/', () => {
  const forge = require(path.join('..', 'forge.config.cjs'));
  const ignore = forge.packagerConfig.ignore;
  assert.equal(ignore('/dist/wlsaplus/browser/ocr'), false);
  assert.equal(ignore('/dist/wlsaplus/browser/ocr/worker.min.js'), false);
  assert.equal(ignore('/dist/wlsaplus/browser/ocr/tesseract-core-lstm.wasm.js'), false);
  assert.equal(ignore('/dist/wlsaplus/browser/ocr/eng.traineddata.gz'), false);
  assert.equal(ignore('/dist/wlsaplus/browser/ocr/chi_sim.traineddata.gz'), false);
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
