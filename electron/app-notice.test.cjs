const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { NOTICE_URL, NOTICE_TIMEOUT_MS, validateNotice, fetchAppNotice } = require('./app-notice.cjs');

const NOTICE = { id: 'release-1.0.9', title: 'WLSAPlus 1.0.9', content: 'Hello', type: 'info' };
const respond = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('notice comes from the official site with an 8s timeout', () => {
  assert.equal(NOTICE_URL, 'https://wlsaplus.spacehubxyz.hk/notice.json');
  assert.equal(NOTICE_TIMEOUT_MS, 8000);
});

test('validateNotice keeps only well-formed notices', () => {
  assert.deepEqual(validateNotice(NOTICE), NOTICE);
  assert.deepEqual(validateNotice({ ...NOTICE, type: 'evil', extra: 1 }), { id: NOTICE.id, title: NOTICE.title, content: NOTICE.content });
  assert.equal(validateNotice({ ...NOTICE, id: '' }), null);
  assert.equal(validateNotice({ ...NOTICE, title: 3 }), null);
  assert.equal(validateNotice({ ...NOTICE, content: 'x'.repeat(2001) }), null);
  assert.equal(validateNotice([NOTICE]), null);
  assert.equal(validateNotice(null), null);
});

test('fetchAppNotice fetches no-store with a cache-busting query', async () => {
  let seen;
  const notice = await fetchAppNotice({ now: () => 42, fetchImpl: async (url, init) => { seen = { url, init }; return respond(NOTICE)(); } });
  assert.deepEqual(notice, NOTICE);
  assert.equal(seen.url, `${NOTICE_URL}?ts=42`);
  assert.equal(seen.init.cache, 'no-store');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('fetchAppNotice returns null on HTTP errors, bad JSON, oversize bodies and network failures', async () => {
  assert.equal(await fetchAppNotice({ fetchImpl: respond(NOTICE, 404) }), null);
  assert.equal(await fetchAppNotice({ fetchImpl: respond('<html>') }), null);
  assert.equal(await fetchAppNotice({ fetchImpl: respond(' '.repeat(70 * 1024)) }), null);
  assert.equal(await fetchAppNotice({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('fetchAppNotice aborts after the timeout', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await fetchAppNotice({ fetchImpl: hang, timeoutMs: 20 }), null);
});

test('main exposes the notice over IPC and the site file matches the expected shape', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /ipcMain\.handle\('notice:get', \(\) => fetchAppNotice\(\)\)/);
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('notice:get'\)/);
  const forge = require(path.join('..', 'forge.config.cjs'));
  assert.equal(forge.packagerConfig.ignore('/electron/app-notice.cjs'), false);
});
