const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveForumEntryUrl, requestForumLogin, isValidConsumeUrl, isRelativeForumPath, getLastForumSsoStatus, PS_COOKIE_NAMES,
} = require('./forum-sso.cjs');
const { FORUM_URL, FORUM_FALLBACK_URL } = require('./forum-config.cjs');

const PASSWORD = 'pw-DO-NOT-SEND-91';
const COOKIE_SECRET = 'cookie-SECRET-value-7731';
const credentials = { schoolUrl: 'https://ps.wlsash.org.cn', username: 'student1', password: PASSWORD };
const consume = (base = FORUM_URL) => `${base}sso/consume?token=tok123&next=%2F`;

function psSession(cookies = [
  { name: 'JSESSIONID', value: COOKIE_SECRET, domain: 'ps.wlsash.org.cn' },
  { name: 'psaid', value: `${COOKIE_SECRET}-psaid`, domain: '.ps.wlsash.org.cn' },
  { name: 'current_locale', value: 'en_US', domain: 'ps.wlsash.org.cn' },
  { name: 'tracking', value: 'not-whitelisted', domain: 'ps.wlsash.org.cn' },
]) {
  const calls = [];
  return { calls, cookies: { get: async (filter) => { calls.push(filter); return cookies; } } };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Mock fetch: routes /api/session and /sso/wlsaplus/issue; records requests. */
function mockFetch({ loggedIn = false, issue = () => json(200, { ok: true, url: consume(), expires_in: 60 }) } = {}) {
  const requests = [];
  const fn = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/session')) return json(200, { ok: true, logged_in: loggedIn });
    if (url.endsWith('/sso/wlsaplus/issue')) return issue(url, init);
    return json(404, { ok: false });
  };
  fn.requests = requests;
  return fn;
}

/** Capture everything written to console during fn(). */
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.map(String).join(' '));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, saved); }
}

async function run(fetch, extra = {}) {
  return captureLogs(() => resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials, powerSchoolSession: psSession(), fetch, ...extra }));
}

test('success: posts only whitelisted PowerSchool cookies and returns the consume URL', async () => {
  const fetch = mockFetch();
  const { result } = await run(fetch);
  assert.equal(result, consume());
  const issue = fetch.requests.find((r) => r.url.endsWith('/sso/wlsaplus/issue'));
  assert.equal(issue.url, 'https://lt.spacehubxyz.hk/sso/wlsaplus/issue');
  assert.equal(issue.init.method, 'POST');
  const body = JSON.parse(issue.init.body);
  assert.deepEqual(body.cookies.map((c) => c.name).sort(), ['JSESSIONID', 'current_locale', 'psaid']);
  assert.ok(body.cookies.every((c) => PS_COOKIE_NAMES.has(c.name) && c.domain === 'ps.wlsash.org.cn'));
  assert.equal(body.schoolUrl, 'https://ps.wlsash.org.cn');
  assert.equal(body.next, '/');
  assert.equal(getLastForumSsoStatus().code, 'ok');
});

test('SSO next lands in embed mode with the app theme; unsafe next values fall back to /', async () => {
  const sent = async (next) => {
    const fetch = mockFetch();
    await run(fetch, { next });
    return JSON.parse(fetch.requests.find((r) => r.url.endsWith('/sso/wlsaplus/issue')).init.body).next;
  };
  assert.equal(await sent('/?embed=wlsaplus&theme=dark'), '/?embed=wlsaplus&theme=dark');
  for (const bad of ['https://evil.com/', '//evil.com', '/\\evil.com', 'relative', '/a b', `/${'x'.repeat(600)}`, 42]) {
    assert.equal(await sent(bad), '/', String(bad));
  }
  assert.ok(isRelativeForumPath('/ai?embed=wlsaplus'));
  assert.ok(isValidConsumeUrl(`${FORUM_URL}sso/consume?token=t&next=${encodeURIComponent('/?embed=wlsaplus&theme=light')}`, FORUM_URL));
});

test('session pre-check runs first and skips SSO when already logged in', async () => {
  const fetch = mockFetch({ loggedIn: true });
  const { result } = await run(fetch);
  assert.equal(result, FORUM_URL);
  assert.deepEqual(fetch.requests.map((r) => r.url), ['https://lt.spacehubxyz.hk/api/session']);
  assert.equal(getLastForumSsoStatus().code, 'already_logged_in');
});

test('invalid_session and identity_not_found are surfaced with code + timestamp only', async () => {
  for (const [status, code] of [[401, 'invalid_session'], [502, 'identity_not_found']]) {
    const { result, lines } = await run(mockFetch({ issue: () => json(status, { ok: false, code, error: '中文提示' }) }));
    assert.equal(result, FORUM_URL);
    const last = getLastForumSsoStatus();
    assert.equal(last.code, code);
    assert.equal(last.httpStatus, status);
    assert.ok(!Number.isNaN(Date.parse(last.at)));
    const line = lines.find((l) => l.includes(`code=${code}`));
    assert.match(line, /^\[forum-sso\] \d{4}-\d\d-\d\dT[\d:.]+Z code=\w+ http=\d+ \(report to the forum team\)$/);
  }
});

test('timeout on the issue request falls back to guest', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const { result } = await run(mockFetch({ issue: hang }), { timeouts: { sessionCheckMs: 50, issueMs: 30 } });
  assert.equal(result, FORUM_URL);
  assert.equal(getLastForumSsoStatus().code, 'timeout');
});

test('a hung session pre-check does not block SSO', async () => {
  const fetch = async (url, init) => {
    if (url.endsWith('/api/session')) return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' }))));
    return json(200, { ok: true, url: consume(), expires_in: 60 });
  };
  const { result } = await run(fetch, { timeouts: { sessionCheckMs: 20, issueMs: 500 } });
  assert.equal(result, consume());
});

test('rejects consume URLs that are off-forum, wrong host, wrong path, or have an absolute next', async () => {
  const bad = [
    'https://evil.com/sso/consume?token=t',
    `${FORUM_FALLBACK_URL}sso/consume?token=t`, // asked the official host
    `${FORUM_URL}login?token=t`,
    `${FORUM_URL}sso/consume`,
    `${FORUM_URL}sso/consume?token=t&next=https%3A%2F%2Fevil.com`,
    `${FORUM_URL}sso/consume?token=t&next=%2F%2Fevil.com`,
    'http://lt.spacehubxyz.hk/sso/consume?token=t',
  ];
  for (const url of bad) {
    assert.equal(isValidConsumeUrl(url, FORUM_URL), false, url);
    const { result } = await run(mockFetch({ issue: () => json(200, { ok: true, url }) }));
    assert.equal(result, FORUM_URL, url);
    assert.equal(getLastForumSsoStatus().code, 'invalid_consume_url');
  }
  assert.ok(isValidConsumeUrl(consume(FORUM_FALLBACK_URL), FORUM_FALLBACK_URL));
});

test('cookie values and the password never appear in logs; the password is never sent', async () => {
  const scenarios = [
    mockFetch(),
    mockFetch({ loggedIn: true }),
    mockFetch({ issue: () => json(401, { ok: false, code: 'invalid_session' }) }),
    mockFetch({ issue: () => json(502, { ok: false, code: 'identity_not_found' }) }),
    mockFetch({ issue: () => { throw new Error(`network down ${COOKIE_SECRET}`); } }),
    mockFetch({ issue: () => new Response('<html>oops</html>', { status: 500 }) }),
  ];
  for (const fetch of scenarios) {
    const { lines } = await run(fetch);
    for (const line of lines) {
      assert.ok(!line.includes(COOKIE_SECRET), `cookie leaked into log: ${line}`);
      assert.ok(!line.includes(PASSWORD), `password leaked into log: ${line}`);
    }
    for (const request of fetch.requests) {
      assert.ok(!JSON.stringify(request).includes(PASSWORD), 'password sent to the forum');
    }
  }
});

test('no PowerSchool session cookie (JSESSIONID/psaid) means no issue request', async () => {
  const fetch = mockFetch();
  const { result } = await captureLogs(() => resolveForumEntryUrl({
    baseUrl: FORUM_URL, credentials, fetch,
    powerSchoolSession: psSession([{ name: 'current_locale', value: 'en_US', domain: 'ps.wlsash.org.cn' }]),
  }));
  assert.equal(result, FORUM_URL);
  assert.ok(!fetch.requests.some((r) => r.url.endsWith('/issue')));
  assert.equal(getLastForumSsoStatus().code, 'no_ps_session');
});

test('signed-out users open the plain forum without calling the hook', async () => {
  let called = false;
  const { result } = await captureLogs(() => resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials: null }, async () => { called = true; return consume(); }));
  assert.equal(result, FORUM_URL);
  assert.equal(called, false);
});

test('the hook receives account info without the password; outer timeout and errors fall back', async () => {
  let seen;
  const { result } = await captureLogs(() => resolveForumEntryUrl({ baseUrl: FORUM_FALLBACK_URL, credentials }, async (context) => { seen = context; return consume(FORUM_FALLBACK_URL); }));
  assert.equal(result, consume(FORUM_FALLBACK_URL));
  assert.deepEqual(seen.account, { schoolUrl: credentials.schoolUrl, username: 'student1' });
  assert.ok(!JSON.stringify(seen).includes(PASSWORD));
  assert.equal((await captureLogs(() => resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }, async () => { throw new Error('x'); }))).result, FORUM_URL);
  assert.equal((await captureLogs(() => resolveForumEntryUrl({ baseUrl: FORUM_URL, credentials }, () => new Promise(() => {}), 20))).result, FORUM_URL);
  assert.equal(getLastForumSsoStatus().code, 'timeout');
  assert.equal(await requestForumLogin({ baseUrl: FORUM_URL, account: { schoolUrl: credentials.schoolUrl, username: 'student1' } }).finally(() => {}), null);
});
