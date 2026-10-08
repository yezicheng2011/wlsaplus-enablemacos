// In-app notice ("公告") served by the official WLSAPlus site. Fetched in the main process: the
// renderer runs from file:// (origin "null") and the site sends no CORS headers.
const NOTICE_URL = 'https://wlsaplus.spacehubxyz.hk/notice.json';
const NOTICE_TIMEOUT_MS = 8_000;
const MAX_NOTICE_BYTES = 64 * 1024;
const NOTICE_TYPES = new Set(['info', 'success', 'warning']);
const LIMITS = { id: 120, title: 200, content: 2000 };

/** Returns a clean notice or null when the JSON does not look like one. */
function validateNotice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, title, content, type } = value;
  for (const [key, field] of [['id', id], ['title', title], ['content', content]]) {
    if (typeof field !== 'string' || !field.trim() || field.length > LIMITS[key]) return null;
  }
  const notice = { id, title, content };
  if (typeof type === 'string' && NOTICE_TYPES.has(type)) notice.type = type;
  return notice;
}

async function fetchAppNotice({ fetchImpl = fetch, url = NOTICE_URL, timeoutMs = NOTICE_TIMEOUT_MS, now = Date.now } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}?ts=${now()}`, {
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_NOTICE_BYTES) return null;
    return validateNotice(JSON.parse(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { NOTICE_URL, NOTICE_TIMEOUT_MS, validateNotice, fetchAppNotice };
