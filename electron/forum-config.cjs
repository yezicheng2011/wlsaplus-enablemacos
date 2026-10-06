// WLSAPlus 论坛 (forum) configuration for the Electron main process.
// Keep FORUM_URL / FORUM_FALLBACK_URL in sync with src/app/core/forum.config.ts
// (forum-config.test.cjs enforces this).

const FORUM_URL = 'https://lt.spacehubxyz.hk/';
const FORUM_FALLBACK_URL = 'https://lt.spacehubxyz.xn--j6w193g/';
const FORUM_PARTITION = 'persist:forum';
// Theme/embed cookie contract with the forum server; names are owned by src/app/core/forum.config.ts.
const FORUM_THEME_COOKIE = 'wlsaplus_theme';
const FORUM_EMBED_COOKIE = 'wlsaplus_embed';
const FORUM_EMBED_COOKIE_VALUE = '1';
const FORUM_THEME_PARAM = 'theme';
const FORUM_EMBED_PARAM = 'embed';
const FORUM_EMBED_PARAM_VALUE = 'wlsaplus';

const FORUM_ORIGINS = new Set([new URL(FORUM_URL).origin, new URL(FORUM_FALLBACK_URL).origin]);

function parseUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return new URL(value); } catch { return null; }
}

/** True when the URL is an https page on one of the forum origins. */
function isForumUrl(value) {
  const url = parseUrl(value);
  return !!url && url.protocol === 'https:' && FORUM_ORIGINS.has(url.origin);
}

/** True for plain web links that may be handed to the system browser. */
function isWebUrl(value) {
  const url = parseUrl(value);
  return !!url && (url.protocol === 'https:' || url.protocol === 'http:');
}

/** Entry URL for the forum; `fallback` selects the backup host. */
function forumBaseUrl(fallback = false) {
  return fallback ? FORUM_FALLBACK_URL : FORUM_URL;
}

/**
 * `next` for the SSO issue request: land on the forum home in embed mode with the app theme
 * (SSO_INTEGRATION.md §7.5). Unknown themes just omit the theme param.
 */
function forumSsoNext(theme) {
  const params = new URLSearchParams({ [FORUM_EMBED_PARAM]: FORUM_EMBED_PARAM_VALUE });
  if (theme === 'light' || theme === 'dark') params.set(FORUM_THEME_PARAM, theme);
  return `/?${params.toString()}`;
}

/** Decide whether a <webview> may attach (only the forum, only in its own partition). */
function isForumWebviewAttachAllowed(params) {
  return !!params && params.partition === FORUM_PARTITION && isForumUrl(params.src);
}

/**
 * Harden the guest's webPreferences in place (called from will-attach-webview).
 * The forum page never gets the app preload, Node, or nested webviews.
 */
function hardenForumWebPreferences(webPreferences) {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  webPreferences.partition = FORUM_PARTITION;
  return webPreferences;
}

module.exports = {
  FORUM_URL,
  FORUM_FALLBACK_URL,
  FORUM_PARTITION,
  FORUM_ORIGINS,
  FORUM_THEME_COOKIE,
  FORUM_EMBED_COOKIE,
  FORUM_EMBED_COOKIE_VALUE,
  FORUM_THEME_PARAM,
  FORUM_EMBED_PARAM,
  FORUM_EMBED_PARAM_VALUE,
  forumSsoNext,
  isForumUrl,
  isWebUrl,
  forumBaseUrl,
  isForumWebviewAttachAllowed,
  hardenForumWebPreferences,
};
