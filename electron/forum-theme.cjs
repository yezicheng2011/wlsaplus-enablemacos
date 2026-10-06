// WLSAPlus 论坛: make the forum follow the app's light/dark theme and mark embed mode.
// Cookie names live in forum-config.cjs (mirrored from src/app/core/forum.config.ts).

const {
  FORUM_ORIGINS,
  FORUM_THEME_COOKIE,
  FORUM_EMBED_COOKIE,
  FORUM_EMBED_COOKIE_VALUE,
} = require('./forum-config.cjs');

const FORUM_THEMES = new Set(['light', 'dark']);
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Only 'light' / 'dark' are accepted from the renderer. */
function validateForumTheme(value) {
  if (!FORUM_THEMES.has(value)) throw new Error('Unsupported forum theme.');
  return value;
}

/** Cookie details (Electron cookies.set) for every forum origin: theme + embed marker. */
function forumThemeCookies(theme, now = Date.now()) {
  validateForumTheme(theme);
  const expirationDate = Math.floor(now / 1000) + COOKIE_MAX_AGE_SECONDS;
  const base = { path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate };
  const cookies = [];
  for (const origin of FORUM_ORIGINS) {
    const url = `${origin}/`;
    cookies.push({ ...base, url, name: FORUM_THEME_COOKIE, value: theme });
    cookies.push({ ...base, url, name: FORUM_EMBED_COOKIE, value: FORUM_EMBED_COOKIE_VALUE });
  }
  return cookies;
}

/** Ask the guest page to prefer the given color scheme (best effort, per-webContents via CDP). */
async function emulateForumColorScheme(guest, theme) {
  if (!guest || (typeof guest.isDestroyed === 'function' && guest.isDestroyed())) return false;
  try {
    const dbg = guest.debugger;
    if (!dbg) return false;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    return true;
  } catch {
    return false; // DevTools open, guest gone, etc. Cookies/params still carry the theme.
  }
}

/**
 * Set the theme/embed cookies in the forum partition, then update every live forum guest.
 * Resolves after the cookies are written so the caller can load the forum right away.
 */
async function applyForumTheme({ session, guests = [], theme, now }) {
  validateForumTheme(theme);
  await Promise.all(forumThemeCookies(theme, now).map((cookie) => session.cookies.set(cookie)));
  await Promise.all([...guests].map((guest) => emulateForumColorScheme(guest, theme)));
  return theme;
}

module.exports = {
  FORUM_THEMES,
  validateForumTheme,
  forumThemeCookies,
  emulateForumColorScheme,
  applyForumTheme,
};
