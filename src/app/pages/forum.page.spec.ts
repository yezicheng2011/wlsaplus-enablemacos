import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForumPage } from './forum.page';
import { LocalStore } from '../core/local-store.service';
import { FORUM_FALLBACK_URL, FORUM_URL, forumThemeMessageScript } from '../core/forum.config';

type Bridge = NonNullable<Window['wlsaplus']>;
type SsoStatus = { code: string; httpStatus: number | null; at: string } | null;

const calls: string[] = [];

function installBridge(ssoUrl: (options?: { fallback?: boolean }) => Promise<string>, status: SsoStatus = null) {
  calls.length = 0;
  const spy = vi.fn(async (options?: { fallback?: boolean }) => { calls.push('ssoUrl'); return ssoUrl(options); });
  const setTheme = vi.fn(async (theme: 'light' | 'dark') => { calls.push(`setTheme:${theme}`); });
  window.wlsaplus = {
    platform: { os: 'macos' },
    system: { openExternal: vi.fn().mockResolvedValue(undefined) },
    forum: { ssoUrl: spy, ssoStatus: vi.fn().mockResolvedValue(status), clearSession: vi.fn().mockResolvedValue(undefined), setTheme },
  } as unknown as Bridge;
  return { ssoUrl: spy, setTheme };
}

const appTheme = signal<'light' | 'dark'>('light');

async function settle(fixture: ComponentFixture<ForumPage>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  }
}

async function render(setup?: (page: ForumPage) => void) {
  TestBed.configureTestingModule({ providers: [{ provide: LocalStore, useValue: { resolvedTheme: appTheme } }] });
  const fixture = TestBed.createComponent(ForumPage);
  setup?.(fixture.componentInstance);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<ForumPage>) => fixture.nativeElement as HTMLElement;

/** Give the jsdom <webview> the guest methods the page uses. */
function fakeGuest(view: Element, currentUrl: string, execute: () => Promise<unknown>) {
  return Object.assign(view, {
    executeJavaScript: vi.fn(execute),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: vi.fn(() => currentUrl),
  });
}

describe('ForumPage', () => {
  afterEach(() => { delete window.wlsaplus; appTheme.set('light'); TestBed.resetTestingModule(); });

  it('fills the page with the webview: no header / icon row', async () => {
    installBridge(async () => FORUM_URL);
    const fixture = await render();
    expect(el(fixture).querySelector('header, .forum-bar, img.forum-logo, h1')).toBeNull();
    expect(el(fixture).querySelectorAll('button').length).toBe(0);
    expect(el(fixture).querySelector('section.forum > webview.forum-view')).not.toBeNull();
  });

  it('sets theme/embed cookies before loading, and keeps the one-time SSO link intact', async () => {
    appTheme.set('dark');
    const { ssoUrl, setTheme } = installBridge(async () => `${FORUM_URL}sso/consume?token=t&next=%2F`);
    const fixture = await render();
    const view = el(fixture).querySelector('webview');
    expect(ssoUrl).toHaveBeenCalledWith({ fallback: false, theme: 'dark' });
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(calls.slice(0, 2)).toEqual(['setTheme:dark', 'ssoUrl']);
    expect(view?.getAttribute('partition')).toBe('persist:forum');
    expect(view?.getAttribute('src')).toBe(`${FORUM_URL}sso/consume?token=t&next=%2F`);
  });

  it('adds theme + embed params to a plain forum entry URL', async () => {
    installBridge(async () => FORUM_URL);
    const fixture = await render();
    expect(el(fixture).querySelector('webview')?.getAttribute('src')).toBe(`${FORUM_URL}?theme=light&embed=wlsaplus`);
  });

  it('switches to the fallback host when the official host fails to load', async () => {
    const { ssoUrl } = installBridge(async (options) => (options?.fallback ? FORUM_FALLBACK_URL : FORUM_URL));
    const fixture = await render();
    const view = el(fixture).querySelector('webview')!;
    view.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true, validatedURL: FORUM_URL }));
    await settle(fixture);
    expect(ssoUrl).toHaveBeenLastCalledWith({ fallback: true, theme: 'light' });
    expect(el(fixture).querySelector('webview')?.getAttribute('src')).toBe(`${FORUM_FALLBACK_URL}?theme=light&embed=wlsaplus`);
  });

  it('posts the new theme into the forum page when the app theme changes', async () => {
    const { setTheme } = installBridge(async () => FORUM_URL);
    const fixture = await render();
    const guest = fakeGuest(el(fixture).querySelector('webview')!, `${FORUM_URL}t/1`, async () => true);
    appTheme.set('dark');
    await settle(fixture);
    expect(setTheme).toHaveBeenLastCalledWith('dark');
    expect(guest.executeJavaScript).toHaveBeenCalledWith(forumThemeMessageScript('dark'));
    expect(forumThemeMessageScript('dark')).toContain('{"type":"wlsaplus-theme","theme":"dark"}');
    expect(guest.loadURL).not.toHaveBeenCalled();
  });

  it('reloads the current forum page with the new theme when the page cannot be scripted', async () => {
    installBridge(async () => FORUM_URL);
    const fixture = await render();
    const guest = fakeGuest(el(fixture).querySelector('webview')!, `${FORUM_URL}t/1?theme=light&embed=wlsaplus`, async () => { throw new Error('not ready'); });
    appTheme.set('dark');
    await settle(fixture);
    expect(guest.loadURL).toHaveBeenCalledWith(`${FORUM_URL}t/1?theme=dark&embed=wlsaplus`);
  });

  it('never replays a one-time SSO link when falling back to reload', async () => {
    installBridge(async () => `${FORUM_URL}sso/consume?token=t&next=%2F`);
    const fixture = await render();
    const guest = fakeGuest(el(fixture).querySelector('webview')!, `${FORUM_URL}sso/consume?token=t&next=%2F`, async () => { throw new Error('not ready'); });
    appTheme.set('dark');
    await settle(fixture);
    expect(guest.loadURL).not.toHaveBeenCalled();
  });

  it('shows reportable SSO failures as a small floating notice that hides itself', async () => {
    installBridge(async () => FORUM_URL, { code: 'invalid_session', httpStatus: 401, at: '2026-10-06T01:25:01.035Z' });
    const fixture = await render((page) => { page.ssoNoticeMs = 30; });
    const notice = el(fixture).querySelector('.forum-sso-issue');
    expect(notice?.textContent).toContain('invalid_session');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle(fixture);
    expect(el(fixture).querySelector('.forum-sso-issue')).toBeNull();
  });

  it('stays quiet for normal SSO outcomes', async () => {
    installBridge(async () => FORUM_URL, { code: 'already_logged_in', httpStatus: null, at: '2026-10-06T01:25:01.035Z' });
    const fixture = await render();
    expect(el(fixture).querySelector('.forum-sso-issue')).toBeNull();
  });
});
