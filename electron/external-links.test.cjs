const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExternalHelpUrl } = require('./external-links.cjs');

test('allows the bundled WLSAPlus help articles', () => {
  assert.equal(
    validateExternalHelpUrl('https://wlsaplus.spacehubxyz.hk/guide/wechat/'),
    'https://wlsaplus.spacehubxyz.hk/guide/wechat/',
  );
});

test('help links live on the official site only (no legacy 02studio pages)', () => {
  assert.throws(() => validateExternalHelpUrl('https://wlsaplus.02studio.xyz/blog/use-wechat-on-restricted-networks/'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('https://wlsaplus.spacehubxyz.hk/guide/other/'), /not allowed/);
  assert.throws(() => validateExternalHelpUrl('http://wlsaplus.spacehubxyz.hk/guide/wechat/'), /not allowed/);
});

test('the VPN page opens the allowed WeChat guide', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'app', 'pages', 'vpn.page.ts'), 'utf8');
  const url = page.match(/readonly guideUrl = '([^']+)'/)[1];
  assert.equal(validateExternalHelpUrl(url), url);
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
