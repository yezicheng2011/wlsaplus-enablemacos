const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveForumEntryUrl, requestForumLogin } = require('./forum-sso.cjs');
const { FORUM_URL, FORUM_FALLBACK_URL } = require('./forum-config.cjs');

const credentials = { schoolUrl: 'https://ps.wlsash.org.cn', username: 'student1', password: 'secret' };

test('the stub SSO hook returns null (guest)', async () => {
  assert.equal(await requestForumLogin({}), null);
  assert.equal(await resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }), FORUM_URL);
});

test('signed-out users open the plain forum without calling the hook', async () => {
  let called = false;
  const url = await resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials: null }, async () => { called = true; return `${FORUM_URL}sso?t=1`; });
  assert.equal(url, FORUM_URL);
  assert.equal(called, false);
});

test('a forum login URL from the hook is used, and the password is never passed', async () => {
  let seen;
  const url = await resolveForumEntryUrl({ baseUrl: FORUM_FALLBACK_URL, credentials }, async (context) => { seen = context; return `${FORUM_FALLBACK_URL}sso/consume?token=abc`; });
  assert.equal(url, `${FORUM_FALLBACK_URL}sso/consume?token=abc`);
  assert.deepEqual(seen.account, { schoolUrl: credentials.schoolUrl, username: 'student1' });
  assert.equal(seen.baseUrl, FORUM_FALLBACK_URL);
  assert.ok(!JSON.stringify(seen).includes('secret'));
});

test('non-forum URLs, errors and timeouts fall back to the base URL', async () => {
  assert.equal(await resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }, async () => 'https://evil.com/'), FORUM_URL);
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }, async () => { throw new Error('down'); }), FORUM_URL);
    assert.equal(await resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }, () => new Promise(() => {}), 20), FORUM_URL);
  } finally { console.warn = warn; }
});
