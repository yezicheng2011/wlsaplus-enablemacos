const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExternalHelpUrl } = require('./external-links.cjs');

test('allows the bundled WLSAPlus help articles', () => {
  assert.equal(
    validateExternalHelpUrl('https://wlsaplus.02studio.xyz/blog/use-wechat-on-restricted-networks/'),
    'https://wlsaplus.02studio.xyz/blog/use-wechat-on-restricted-networks/',
  );
});

test('allows WLSAPlus forum pages (open in browser)', () => {
  assert.equal(validateExternalHelpUrl('https://lt.spacehubxyz.hk/t/1'), 'https://lt.spacehubxyz.hk/t/1');
  assert.equal(validateExternalHelpUrl('https://lt.spacehubxyz.xn--j6w193g/'), 'https://lt.spacehubxyz.xn--j6w193g/');
});

test('rejects arbitrary external URLs', () => {
  assert.throws(() => validateExternalHelpUrl('https://example.com/'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('javascript:alert(1)'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('http://lt.spacehubxyz.hk/'), /not allowed/);
});
