const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORUM_URL, FORUM_FALLBACK_URL, FORUM_PARTITION, FORUM_THEME_COOKIE, FORUM_EMBED_COOKIE, FORUM_EMBED_COOKIE_VALUE,
  FORUM_THEME_PARAM, FORUM_EMBED_PARAM, FORUM_EMBED_PARAM_VALUE, forumSsoNext,
  isForumUrl, isWebUrl, forumBaseUrl, isForumWebviewAttachAllowed, hardenForumWebPreferences,
} = require('./forum-config.cjs');

test('forum URLs are https on the official and fallback hosts', () => {
  assert.equal(FORUM_URL, 'https://lt.spacehubxyz.hk/');
  assert.equal(FORUM_FALLBACK_URL, 'https://lt.spacehubxyz.xn--j6w193g/');
  assert.equal(forumBaseUrl(), FORUM_URL);
  assert.equal(forumBaseUrl(true), FORUM_FALLBACK_URL);
});

test('isForumUrl only accepts https forum origins', () => {
  assert.ok(isForumUrl('https://lt.spacehubxyz.hk/post/42?x=1'));
  assert.ok(isForumUrl('https://lt.spacehubxyz.xn--j6w193g/login'));
  assert.ok(!isForumUrl('http://lt.spacehubxyz.hk/'));
  assert.ok(!isForumUrl('https://lt.spacehubxyz.hk.evil.com/'));
  assert.ok(!isForumUrl('https://evil.com/?https://lt.spacehubxyz.hk/'));
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
  assert.match(source, new RegExp(`FORUM_THEME_COOKIE = '${FORUM_THEME_COOKIE}'`));
  assert.match(source, new RegExp(`FORUM_EMBED_COOKIE = '${FORUM_EMBED_COOKIE}'`));
  assert.match(source, new RegExp(`FORUM_EMBED_COOKIE_VALUE = '${FORUM_EMBED_COOKIE_VALUE}'`));
  assert.match(source, new RegExp(`FORUM_THEME_PARAM = '${FORUM_THEME_PARAM}'`));
  assert.match(source, new RegExp(`FORUM_EMBED_PARAM = '${FORUM_EMBED_PARAM}'`));
  assert.match(source, new RegExp(`FORUM_EMBED_PARAM_VALUE = '${FORUM_EMBED_PARAM_VALUE}'`));
});

test('forumSsoNext targets the forum home in embed mode with the app theme', () => {
  assert.equal(forumSsoNext('dark'), '/?embed=wlsaplus&theme=dark');
  assert.equal(forumSsoNext('light'), '/?embed=wlsaplus&theme=light');
  assert.equal(forumSsoNext('purple'), '/?embed=wlsaplus');
  assert.equal(forumSsoNext(undefined), '/?embed=wlsaplus');
});
