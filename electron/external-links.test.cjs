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
  assert.equal(validateExternalHelpUrl('https://wlsaforum.02studio.xyz/t/1'), 'https://wlsaforum.02studio.xyz/t/1');
  assert.equal(validateExternalHelpUrl('https://34-81-212-116.sslip.io/'), 'https://34-81-212-116.sslip.io/');
});

test('rejects arbitrary external URLs', () => {
  assert.throws(() => validateExternalHelpUrl('https://example.com/'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('javascript:alert(1)'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('http://wlsaforum.02studio.xyz/'), /not allowed/);
});
