// WLSAPlus 论坛 (forum) — single place for forum URLs and brand.
// Keep the URLs/partition in sync with electron/forum-config.cjs (checked by forum-config.test.cjs).
// Brand colors live in src/styles.scss as --forum-accent / --forum-accent-soft / --forum-on-accent.

export const FORUM_URL = 'https://lt.spacehubxyz.hk/';
export const FORUM_FALLBACK_URL = 'https://lt.spacehubxyz.xn--j6w193g/';
export const FORUM_PARTITION = 'persist:forum';

/**
 * Theme + embed contract with the forum server (aws&gcp).
 * electron/forum-config.cjs defines the cookies used by the main process.
 * - Cookies (set by main on every forum origin in the forum partition; Secure, Path=/, SameSite=Lax):
 *     wlsaplus_theme=light|dark, wlsaplus_embed=1
 * - Query params on the initial (non-SSO) entry URL: ?theme=light|dark&embed=wlsaplus
 * - SSO: issue request next = '/?embed=wlsaplus&theme=light|dark' (built in electron/forum-config.cjs forumSsoNext).
 * - Live change: window.postMessage({ type: 'wlsaplus-theme', theme }, location.origin) inside the forum page.
 * Contract: /workspace/wlsaplus-forum-brand/SSO_INTEGRATION.md §7.
 */
export type ForumTheme = 'light' | 'dark';
export const FORUM_THEME_PARAM = 'theme';
export const FORUM_EMBED_PARAM = 'embed';
export const FORUM_EMBED_PARAM_VALUE = 'wlsaplus';
export const FORUM_THEME_MESSAGE_TYPE = 'wlsaplus-theme';
/** One-time SSO consume path: never rewritten (the token is single-use); cookies carry theme/embed there. */
export const FORUM_SSO_CONSUME_PATH = '/sso/consume';

const FORUM_ORIGINS = new Set([new URL(FORUM_URL).origin, new URL(FORUM_FALLBACK_URL).origin]);

function parseForumUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && FORUM_ORIGINS.has(url.origin) ? url : null;
  } catch {
    return null;
  }
}

/** True for the one-time SSO login link (must be loaded exactly as issued). */
export function isForumSsoConsumeUrl(value: string): boolean {
  return parseForumUrl(value)?.pathname === FORUM_SSO_CONSUME_PATH;
}

/**
 * Add theme + embed params to a forum entry URL. Only https URLs on the forum origins are touched;
 * the SSO consume link is returned unchanged (theme/embed reach that flow via cookies).
 */
export function withForumEntryParams(value: string, theme: ForumTheme): string {
  const url = parseForumUrl(value);
  if (!url || url.pathname === FORUM_SSO_CONSUME_PATH) return value;
  url.searchParams.set(FORUM_THEME_PARAM, theme);
  url.searchParams.set(FORUM_EMBED_PARAM, FORUM_EMBED_PARAM_VALUE);
  return url.toString();
}

/** Script run inside the forum page (via <webview>.executeJavaScript) to announce a theme change. */
export function forumThemeMessageScript(theme: ForumTheme): string {
  // Target our own origin: the forum only accepts same-window / same-origin messages (§7.3).
  return `window.postMessage(${JSON.stringify({ type: FORUM_THEME_MESSAGE_TYPE, theme })}, location.origin); true;`;
}

/** SSO codes the forum team asked us to surface (report code + time, never cookie values). */
export const FORUM_SSO_REPORTABLE_CODES: readonly string[] = ['invalid_session', 'identity_not_found'];

export const FORUM_BRAND = {
  /** Full product name (page title, tooltip). */
  name: 'WLSAPlus 论坛',
  /** Short label for the navigation rail / bottom bar. */
  navLabel: 'Forum',
  /** Material Symbols Rounded icon name. Replace when the forum brand icon is available. */
  icon: 'forum',
} as const;
