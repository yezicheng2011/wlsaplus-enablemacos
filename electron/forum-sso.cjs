// SSO hook for WLSAPlus 论坛.
//
// The app never signs identity itself (no secrets ship in the app). The forum
// owner is building a server-side flow; when it exists, replace the body of
// `requestForumLogin` ONLY. Everything else (validation, timeout, fallback to the
// plain forum URL) is already wired through the `forum:sso-url` IPC handler.
//
// Expected contract for the real implementation:
//   input:  { baseUrl, account: { schoolUrl, username }, powerSchoolSession, fetch }
//           - baseUrl: forum entry URL currently in use (official or fallback host)
//           - powerSchoolSession: Electron session ('persist:powerschool') holding the
//             live PowerSchool cookies, so the forum backend can be given proof of a
//             PowerSchool login without the password ever leaving the app's vault.
//   output: a one-time login URL on a forum origin (e.g.
//           `${baseUrl}sso/consume?token=<one-time-token>&next=/`), or null to stay a guest.

const { isForumUrl } = require('./forum-config.cjs');

const SSO_TIMEOUT_MS = 8_000;

// eslint-disable-next-line no-unused-vars
async function requestForumLogin(_context) {
  // TODO(forum-sso): call the forum's server-side SSO endpoint (see contract above).
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Forum SSO timed out.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolve the URL the forum <webview> should open. Signed-out users, SSO errors,
 * timeouts and non-forum URLs all fall back to `baseUrl` (guest view).
 */
async function resolveForumEntryUrl({ baseUrl, credentials, powerSchoolSession, fetch: fetchImpl }, request = requestForumLogin, timeoutMs = SSO_TIMEOUT_MS) {
  if (!credentials || !credentials.username || !credentials.schoolUrl) return baseUrl;
  try {
    const url = await withTimeout(Promise.resolve(request({
      baseUrl,
      account: { schoolUrl: String(credentials.schoolUrl), username: String(credentials.username) },
      powerSchoolSession,
      fetch: fetchImpl,
    })), timeoutMs);
    if (url && isForumUrl(url)) return url;
  } catch (error) {
    console.warn('Forum SSO unavailable, opening the forum as a guest:', error instanceof Error ? error.message : error);
  }
  return baseUrl;
}

module.exports = { requestForumLogin, resolveForumEntryUrl, SSO_TIMEOUT_MS };
