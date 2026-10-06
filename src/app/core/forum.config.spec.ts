import { describe, expect, it } from 'vitest';
import {
  FORUM_FALLBACK_URL, FORUM_URL, forumThemeMessageScript, isForumSsoConsumeUrl, withForumEntryParams,
} from './forum.config';

describe('forum.config theme/embed helpers', () => {
  it('adds theme + embed params to forum entry URLs on both hosts', () => {
    expect(withForumEntryParams(FORUM_URL, 'dark')).toBe(`${FORUM_URL}?theme=dark&embed=wlsaplus`);
    expect(withForumEntryParams(`${FORUM_FALLBACK_URL}ai?x=1`, 'light')).toBe(`${FORUM_FALLBACK_URL}ai?x=1&theme=light&embed=wlsaplus`);
    expect(withForumEntryParams(`${FORUM_URL}?theme=light&embed=wlsaplus`, 'dark')).toBe(`${FORUM_URL}?theme=dark&embed=wlsaplus`);
  });

  it('leaves SSO consume links and non-forum URLs untouched', () => {
    const consume = `${FORUM_URL}sso/consume?token=abc&next=%2F`;
    expect(isForumSsoConsumeUrl(consume)).toBe(true);
    expect(withForumEntryParams(consume, 'dark')).toBe(consume);
    expect(withForumEntryParams('https://example.com/', 'dark')).toBe('https://example.com/');
    expect(withForumEntryParams('http://wlsaforum.02studio.xyz/', 'dark')).toBe('http://wlsaforum.02studio.xyz/');
    expect(withForumEntryParams('not a url', 'dark')).toBe('not a url');
    expect(isForumSsoConsumeUrl(FORUM_URL)).toBe(false);
  });

  it('builds a postMessage script with a JSON payload only', () => {
    expect(forumThemeMessageScript('light')).toBe(`window.postMessage({"type":"wlsaplus-theme","theme":"light"}, location.origin); true;`);
  });
});
