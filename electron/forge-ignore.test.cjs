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
  assert.equal(ignore('/node_modules/tesseract.js'), true);
  assert.equal(ignore('/node_modules/rxjs'), true);
  assert.equal(ignore('/node_modules/@angular/core'), true);
  assert.equal(ignore('/src/app/app.ts'), true);
  assert.equal(ignore('node_modules/tesseract.js'), true); // no leading slash
});
