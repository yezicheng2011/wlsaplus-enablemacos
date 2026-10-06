// WLSAPlus 论坛 (forum) — single place for forum URLs and brand.
// Keep the URLs/partition in sync with electron/forum-config.cjs (checked by forum-config.test.cjs).
// Brand colors live in src/styles.scss as --forum-accent / --forum-accent-soft / --forum-on-accent.

export const FORUM_URL = 'https://wlsaforum.02studio.xyz/';
export const FORUM_FALLBACK_URL = 'https://34-81-212-116.sslip.io/';
export const FORUM_PARTITION = 'persist:forum';

export const FORUM_BRAND = {
  /** Full product name (page title, tooltip). */
  name: 'WLSAPlus 论坛',
  /** Short label for the navigation rail / bottom bar. */
  navLabel: 'Forum',
  /** Material Symbols Rounded icon name. Replace when the forum brand icon is available. */
  icon: 'forum',
} as const;
