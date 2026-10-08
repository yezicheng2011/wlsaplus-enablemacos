const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const config = require('./update-config.cjs');

test('stable feed is the official site; mirrors only as fallback; never github.com directly', () => {
  const feed = config.resolveUpdateBase({});
  assert.equal(feed.base, 'https://wlsaplus.spacehubxyz.hk');
  assert.equal(feed.test, false);
  assert.equal(config.stableLatestUrl(feed), 'https://wlsaplus.spacehubxyz.hk/api/latest');
  const urls = config.assetUrls(feed, 'v1.1.0-beta.1', 'WLSAPlus-1.1.0-beta.1-mac-arm64.zip');
  assert.equal(urls[0], 'https://wlsaplus.spacehubxyz.hk/download/v1.1.0-beta.1/WLSAPlus-1.1.0-beta.1-mac-arm64.zip?via=direct');
  assert.ok(urls.length >= 2);
  for (const url of urls) assert.notEqual(new URL(url).hostname, 'github.com');
  assert.ok(urls.slice(1).every((url) => url.includes('https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/download/')));
});

test('test feed override only accepts loopback URLs and disables mirrors', () => {
  assert.deepEqual(config.resolveUpdateBase({ WLSAPLUS_UPDATE_BASE_URL: 'http://127.0.0.1:8123/' }), { base: 'http://127.0.0.1:8123', mirrors: [], test: true });
  assert.equal(config.resolveUpdateBase({ WLSAPLUS_UPDATE_BASE_URL: 'http://localhost:9/x' }).test, true);
  for (const bad of ['https://evil.example.com', 'http://10.0.0.1:80', 'file:///tmp', 'not a url']) {
    assert.equal(config.resolveUpdateBase({ WLSAPLUS_UPDATE_BASE_URL: bad }).base, config.UPDATE_SITE, bad);
  }
  const testFeed = config.resolveUpdateBase({ WLSAPLUS_UPDATE_BASE_URL: 'http://127.0.0.1:8123' });
  assert.deepEqual(config.assetUrls(testFeed, 'channel-beta', 'update-manifest.json'), ['http://127.0.0.1:8123/download/channel-beta/update-manifest.json']);
});

test('embedded public key is a valid Ed25519 key and the codesign requirement pins the CI certificate', () => {
  const key = crypto.createPublicKey(config.UPDATE_PUBLIC_KEY_PEM);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.match(config.CODESIGN_CERT_SHA1, /^[0-9A-F]{40}$/);
  assert.equal(config.CODESIGN_REQUIREMENT, `identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"${config.CODESIGN_CERT_SHA1}"`);
  assert.equal(config.BETA_CHANNEL_TAG, 'channel-beta');
  assert.equal(config.MANIFEST_NAME, 'update-manifest.json');
});
