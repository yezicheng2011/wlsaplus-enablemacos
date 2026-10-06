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
