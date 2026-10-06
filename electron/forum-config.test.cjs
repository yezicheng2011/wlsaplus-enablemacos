const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORUM_URL, FORUM_FALLBACK_URL, FORUM_PARTITION,
  isForumUrl, isWebUrl, forumBaseUrl, isForumWebviewAttachAllowed, hardenForumWebPreferences,
} = require('./forum-config.cjs');

test('forum URLs are https on the official and fallback hosts', () => {
  assert.equal(FORUM_URL, 'https://wlsaforum.02studio.xyz/');
  assert.equal(FORUM_FALLBACK_URL, 'https://34-81-212-116.sslip.io/');
  assert.equal(forumBaseUrl(), FORUM_URL);
  assert.equal(forumBaseUrl(true), FORUM_FALLBACK_URL);
});

test('isForumUrl only accepts https forum origins', () => {
  assert.ok(isForumUrl('https://wlsaforum.02studio.xyz/post/42?x=1'));
  assert.ok(isForumUrl('https://34-81-212-116.sslip.io/login'));
  assert.ok(!isForumUrl('http://wlsaforum.02studio.xyz/'));
  assert.ok(!isForumUrl('https://wlsaforum.02studio.xyz.evil.com/'));
  assert.ok(!isForumUrl('https://evil.com/?https://wlsaforum.02studio.xyz/'));
  assert.ok(!isForumUrl('javascript:alert(1)'));
  assert.ok(!isForumUrl(undefined));
});

test('isWebUrl accepts only http(s)', () => {
  assert.ok(isWebUrl('https://example.com/'));
  assert.ok(isWebUrl('http://example.com/'));
  assert.ok(!isWebUrl('file:///etc/passwd'));
  assert.ok(!isWebUrl('javascript:alert(1)'));
});

test('webview attach requires the forum partition and a forum src', () => {
  assert.ok(isForumWebviewAttachAllowed({ partition: FORUM_PARTITION, src: FORUM_URL }));
  assert.ok(!isForumWebviewAttachAllowed({ partition: 'persist:wlsaplus', src: FORUM_URL }));
  assert.ok(!isForumWebviewAttachAllowed({ partition: FORUM_PARTITION, src: 'https://example.com/' }));
  assert.ok(!isForumWebviewAttachAllowed({ partition: FORUM_PARTITION, src: 'file:///tmp/x.html' }));
  assert.ok(!isForumWebviewAttachAllowed(null));
});

test('hardenForumWebPreferences strips preload and Node access', () => {
  const prefs = hardenForumWebPreferences({ preload: '/x.js', preloadURL: 'file:///x.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webviewTag: true, partition: 'persist:wlsaplus' });
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.preloadURL, undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.partition, FORUM_PARTITION);
});

test('renderer forum config matches the main-process config', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'core', 'forum.config.ts'), 'utf8');
  assert.match(source, new RegExp(`FORUM_URL = '${FORUM_URL.replace(/[.]/g, '\\.')}'`));
  assert.match(source, new RegExp(`FORUM_FALLBACK_URL = '${FORUM_FALLBACK_URL.replace(/[.]/g, '\\.')}'`));
  assert.match(source, new RegExp(`FORUM_PARTITION = '${FORUM_PARTITION}'`));
});
