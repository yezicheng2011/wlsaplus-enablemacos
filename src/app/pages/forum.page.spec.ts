import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForumPage } from './forum.page';
import { FORUM_FALLBACK_URL, FORUM_URL } from '../core/forum.config';

type Bridge = NonNullable<Window['wlsaplus']>;

function installBridge(ssoUrl: (options?: { fallback?: boolean }) => Promise<string>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(ssoUrl);
  window.wlsaplus = {
    platform: { os: 'macos' },
    system: { openExternal: vi.fn().mockResolvedValue(undefined) },
    forum: { ssoUrl: spy, clearSession: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Bridge;
  return spy;
}

async function render() {
  const fixture = TestBed.createComponent(ForumPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('ForumPage', () => {
  afterEach(() => { delete window.wlsaplus; TestBed.resetTestingModule(); });

  it('opens the URL main returns inside an isolated forum webview', async () => {
    const ssoUrl = installBridge(async () => `${FORUM_URL}sso/consume?token=t`);
    const fixture = await render();
    const view = (fixture.nativeElement as HTMLElement).querySelector('webview');
    expect(ssoUrl).toHaveBeenCalledWith({ fallback: false });
    expect(view?.getAttribute('partition')).toBe('persist:forum');
    expect(view?.getAttribute('src')).toBe(`${FORUM_URL}sso/consume?token=t`);
  });

  it('switches to the fallback host when the official host fails to load', async () => {
    const ssoUrl = installBridge(async (options) => (options?.fallback ? FORUM_FALLBACK_URL : FORUM_URL));
    const fixture = await render();
    const view = (fixture.nativeElement as HTMLElement).querySelector('webview')!;
    view.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true, validatedURL: FORUM_URL }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(ssoUrl).toHaveBeenLastCalledWith({ fallback: true });
    expect((fixture.nativeElement as HTMLElement).querySelector('webview')?.getAttribute('src')).toBe(FORUM_FALLBACK_URL);
  });

  it('shows an open-in-browser link on the web build', async () => {
    const fixture = await render();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[target="_blank"]');
    expect(fixture.nativeElement.querySelector('webview')).toBeNull();
    expect(link?.getAttribute('href')).toBe(FORUM_URL);
  });
});
