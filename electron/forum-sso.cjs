// SSO for WLSAPlus 论坛 — see /workspace/wlsaplus-forum-brand/SSO_INTEGRATION.md §4.
//
// The app never signs identity (no secrets / client_id ship in the app). Main forwards the
// live PowerSchool session cookies (whitelisted names only) to the forum server, which checks
// them against ps.wlsash.org.cn/guardian/home.html and returns a 60 s one-time consume URL.
// The password never leaves the vault, and cookie values are never logged.
//
//   POST {baseUrl}sso/wlsaplus/issue  { cookies:[{name,value,domain}], schoolUrl, next:'/' }
//     200 { ok:true, url:'{baseUrl}sso/consume?token=…&next=%2F', expires_in:60 }
//     4xx/5xx { ok:false, code, error }
//   GET  {baseUrl}sso/consume?token=…&next=/   (opened by the <webview>, one-time)

const { isForumUrl } = require('./forum-config.cjs');

const PS_COOKIE_NAMES = new Set(['JSESSIONID', 'psaid', 'sl-session', 'current_locale', 'uiStateCookie']);
const SESSION_CHECK_TIMEOUT_MS = 2_000;
const ISSUE_TIMEOUT_MS = 6_500;
const SSO_TIMEOUT_MS = 9_000;
// Codes the forum team asked us to report (code + timestamp only).
const REPORTABLE_CODES = new Set(['invalid_session', 'identity_not_found']);

let lastStatus = null;

/** Record and log an SSO outcome. Only the code, HTTP status and time — never cookies or tokens. */
function reportSso(code, httpStatus = null) {
  lastStatus = { code: String(code), httpStatus: Number.isInteger(httpStatus) ? httpStatus : null, at: new Date().toISOString() };
  const line = `[forum-sso] ${lastStatus.at} code=${lastStatus.code}${lastStatus.httpStatus ? ` http=${lastStatus.httpStatus}` : ''}`;
  if (REPORTABLE_CODES.has(lastStatus.code)) console.warn(`${line} (report to the forum team)`);
  else if (lastStatus.code === 'ok' || lastStatus.code === 'already_logged_in' || lastStatus.code === 'signed_out') console.log(line);
  else console.warn(line);
  return lastStatus;
}

function getLastForumSsoStatus() { return lastStatus; }

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(error) {
  return error && error.name === 'AbortError' ? 'timeout' : 'network_error';
}

/** A consume URL is only accepted on the forum host we asked, at /sso/consume, with a token and a relative next. */
function isValidConsumeUrl(value, baseUrl) {
  if (!isForumUrl(value)) return false;
  const url = new URL(value);
  if (url.origin !== new URL(baseUrl).origin || url.pathname !== '/sso/consume' || !url.searchParams.get('token')) return false;
  const next = url.searchParams.get('next');
  return next === null || (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\'));
}

/** True when the forum partition already has a logged-in session (skip SSO). */
async function isForumLoggedIn(baseUrl, fetchImpl, timeoutMs) {
  try {
    const response = await fetchWithTimeout(fetchImpl, new URL('api/session', baseUrl).toString(), {
      method: 'GET', credentials: 'include', headers: { accept: 'application/json' },
    }, timeoutMs);
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return !!data && data.ok === true && data.logged_in === true;
  } catch {
    return false; // A failed pre-check never blocks SSO.
  }
}

/**
 * Ask the forum for a one-time login URL. Returns the consume URL, or null to open the forum
 * as-is (already logged in, no PowerSchool session, or any error = guest).
 */
async function requestForumLogin({ baseUrl, account, powerSchoolSession, fetch: fetchImpl, timeouts = {} }) {
  if (!fetchImpl || !powerSchoolSession) { reportSso('unavailable_in_app'); return null; }
  const sessionTimeout = timeouts.sessionCheckMs ?? SESSION_CHECK_TIMEOUT_MS;
  const issueTimeout = timeouts.issueMs ?? ISSUE_TIMEOUT_MS;

  if (await isForumLoggedIn(baseUrl, fetchImpl, sessionTimeout)) { reportSso('already_logged_in'); return null; }

  let psOrigin;
  try { psOrigin = new URL(account.schoolUrl).origin; } catch { reportSso('bad_school'); return null; }
  const psHost = new URL(psOrigin).hostname;
  const cookies = (await powerSchoolSession.cookies.get({ url: `${psOrigin}/` }))
    .filter((cookie) => PS_COOKIE_NAMES.has(cookie.name))
    // The forum only accepts domain = the PowerSchool host, so normalize (e.g. '.ps.wlsash.org.cn').
    .map((cookie) => ({ name: cookie.name, value: cookie.value, domain: psHost }));
  if (!cookies.some((cookie) => cookie.name === 'JSESSIONID' || cookie.name === 'psaid')) { reportSso('no_ps_session'); return null; }

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, new URL('sso/wlsaplus/issue', baseUrl).toString(), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cookies, schoolUrl: psOrigin, next: '/' }),
    }, issueTimeout);
  } catch (error) {
    reportSso(errorCode(error));
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok !== true) {
    const code = data && typeof data.code === 'string' && /^[a-z_]{1,40}$/.test(data.code) ? data.code : 'bad_response';
    reportSso(code, response.status);
    return null;
  }
  if (typeof data.url !== 'string' || !isValidConsumeUrl(data.url, baseUrl)) { reportSso('invalid_consume_url', response.status); return null; }
  reportSso('ok', response.status);
  return data.url;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Forum SSO timed out.'), { name: 'AbortError' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolve the URL the forum <webview> should open. Signed-out users, SSO errors,
 * timeouts and non-forum URLs all fall back to `baseUrl` (guest / existing session).
 */
async function resolveForumEntryUrl({ baseUrl, credentials, powerSchoolSession, fetch: fetchImpl, timeouts }, request = requestForumLogin, timeoutMs = SSO_TIMEOUT_MS) {
  if (!credentials || !credentials.username || !credentials.schoolUrl) { reportSso('signed_out'); return baseUrl; }
  try {
    const url = await withTimeout(Promise.resolve(request({
      baseUrl,
      account: { schoolUrl: String(credentials.schoolUrl), username: String(credentials.username) },
      powerSchoolSession,
      fetch: fetchImpl,
      timeouts,
    })), timeoutMs);
    if (url && isForumUrl(url)) return url;
    if (url) reportSso('invalid_consume_url');
  } catch (error) {
    reportSso(error && error.name === 'AbortError' ? 'timeout' : 'internal_error');
  }
  return baseUrl;
}

module.exports = {
  PS_COOKIE_NAMES,
  REPORTABLE_CODES,
  SSO_TIMEOUT_MS,
  requestForumLogin,
  resolveForumEntryUrl,
  isValidConsumeUrl,
  getLastForumSsoStatus,
};
