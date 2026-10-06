import { Component, DestroyRef, NO_ERRORS_SCHEMA, ElementRef, OnInit, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { PlatformService } from '../core/platform.service';
import { LocalStore } from '../core/local-store.service';
import {
  FORUM_BRAND, FORUM_SSO_REPORTABLE_CODES, FORUM_URL, ForumTheme,
  forumThemeMessageScript, isForumSsoConsumeUrl, withForumEntryParams,
} from '../core/forum.config';

/** Subset of Electron's <webview> element API used by the forum page. */
interface ForumWebview extends HTMLElement {
  getURL(): string;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
}

interface WebviewFailEvent extends Event { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string }
interface WebviewNavigateEvent extends Event { url: string; isMainFrame?: boolean }

/** How long the SSO problem notice stays up before hiding itself. */
export const FORUM_SSO_NOTICE_MS = 8000;

@Component({
  selector: 'app-forum-page',
  imports: [MatButtonModule],
  // <webview> is an Electron built-in element (no dash, so CUSTOM_ELEMENTS_SCHEMA does not cover it).
  schemas: [NO_ERRORS_SCHEMA],
  template: `
    <section class="forum" [attr.aria-label]="brand.name">
      @if (!desktop) {
        <div class="empty-state"><div><span class="material-symbols-rounded big">{{ brand.icon }}</span><p>The forum opens in your browser on the web version.</p><a mat-flat-button [href]="forumUrl" target="_blank" rel="noopener">Open {{ brand.name }}</a></div></div>
      } @else if (failed()) {
        <div class="empty-state"><div><span class="material-symbols-rounded big">cloud_off</span><p>{{ brand.name }} could not be reached. {{ failed() }}</p><button mat-flat-button type="button" (click)="retry()">Try again</button></div></div>
      } @else if (src()) {
        <webview #view class="forum-view" partition="persist:forum" allowpopups [attr.src]="src()"
          (did-start-loading)="loading.set(true)" (did-stop-loading)="loading.set(false)"
          (did-fail-load)="onFailLoad($event)" (did-navigate)="onNavigate($event)" (did-navigate-in-page)="onNavigate($event)"></webview>
      }
      <div class="forum-loading" [class.active]="loading()" aria-hidden="true"></div>
      @if (ssoIssue(); as issue) {
        <div class="forum-sso-issue" role="status">
          <span class="material-symbols-rounded" aria-hidden="true">info</span>
          <span>Automatic sign-in didn't work ({{ issue.code }}, {{ issue.time }}). You're browsing as a guest; please report this code to the forum team.</span>
          <button type="button" (click)="dismissSsoIssue()" aria-label="Dismiss"><span class="material-symbols-rounded">close</span></button>
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .forum { position: relative; height: 100vh; display: flex; background: var(--app-bg); overflow: hidden; }
    .forum-view { flex: 1 1 auto; width: 100%; height: 100%; display: flex; border: 0; }
    .forum-loading { position: absolute; inset: 0 0 auto 0; height: 3px; pointer-events: none; background: transparent; }
    .forum-loading.active { background: linear-gradient(90deg, transparent, var(--forum-accent), transparent) 0 0 / 40% 100% no-repeat var(--forum-accent-soft); animation: forum-loading 1.1s linear infinite; }
    @keyframes forum-loading { from { background-position: -40% 0; } to { background-position: 140% 0; } }
    .forum-sso-issue { position: absolute; z-index: 2; left: 50%; bottom: 16px; transform: translateX(-50%); width: max-content; max-width: min(560px, calc(100% - 32px)); display: flex; align-items: center; gap: 8px; padding: 8px 6px 8px 12px; border-radius: 10px; background: var(--app-surface); color: var(--app-text); border: 1px solid var(--app-border); box-shadow: 0 8px 24px rgb(0 0 0 / 18%); font-size: 12px; line-height: 1.35; opacity: .96; }
    .forum-sso-issue > span:nth-child(2) { flex: 1; }
    .forum-sso-issue > .material-symbols-rounded { color: var(--forum-accent); font-size: 18px; }
    .forum-sso-issue button { flex: 0 0 auto; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--app-muted); cursor: pointer; }
    .forum-sso-issue button .material-symbols-rounded { font-size: 18px; }
    .empty-state { flex: 1; } .empty-state p { margin: 10px 0 18px; } .big { font-size: 44px; color: var(--forum-accent); }
    @media (max-width: 899px) { .forum { height: calc(100vh - 72px - env(safe-area-inset-bottom)); } }
  `,
})
export class ForumPage implements OnInit {
  private readonly platform = inject(PlatformService);
  private readonly store = inject(LocalStore);
  private readonly view = viewChild<ElementRef<ForumWebview>>('view');
  readonly brand = FORUM_BRAND;
  readonly forumUrl = FORUM_URL;
  readonly desktop = this.platform.info.kind === 'electron' && !!window.wlsaplus?.forum;
  readonly src = signal<string | null>(null);
  readonly loading = signal(false);
  readonly failed = signal<string | null>(null);
  readonly ssoIssue = signal<{ code: string; time: string } | null>(null);
  private currentUrl = FORUM_URL;
  private usingFallback = false;
  /** Theme the forum was last told about (cookie + param or postMessage). */
  private appliedTheme: ForumTheme | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Auto-hide delay for the SSO notice (overridable in tests). */
  ssoNoticeMs = FORUM_SSO_NOTICE_MS;

  constructor() {
    // Forum light/dark follows the app theme (user toggle or OS when set to "system").
    effect(() => {
      const theme = this.store.resolvedTheme();
      untracked(() => { if (this.desktop && this.appliedTheme && theme !== this.appliedTheme) void this.updateTheme(theme); });
    });
    inject(DestroyRef).onDestroy(() => this.clearNoticeTimer());
  }

  async ngOnInit(): Promise<void> {
    if (this.desktop) await this.open(false);
  }

  async retry(): Promise<void> {
    this.failed.set(null);
    this.src.set(null);
    await this.open(false);
  }

  dismissSsoIssue(): void {
    this.clearNoticeTimer();
    this.ssoIssue.set(null);
  }

  onNavigate(event: Event): void {
    const { url, isMainFrame } = event as WebviewNavigateEvent;
    if (isMainFrame === false || !url) return;
    this.currentUrl = url;
  }

  async onFailLoad(event: Event): Promise<void> {
    const failure = event as WebviewFailEvent;
    // -3 = aborted (e.g. redirect or user navigation); ignore subframe failures.
    if (!failure.isMainFrame || failure.errorCode === -3) return;
    this.loading.set(false);
    if (!this.usingFallback) {
      await this.open(true);
      return;
    }
    this.failed.set(failure.errorDescription ? `(${failure.errorDescription})` : '');
  }

  /** Ask main for the entry URL (SSO login URL when available, else the plain forum URL). */
  private async open(fallback: boolean): Promise<void> {
    this.usingFallback = fallback;
    this.loading.set(true);
    const theme = this.store.resolvedTheme();
    // Cookies first, so the very first forum response (including after SSO consume) is themed + embedded.
    await this.setThemeCookies(theme);
    let url: string;
    try {
      url = await window.wlsaplus!.forum.ssoUrl({ fallback });
    } catch {
      url = FORUM_URL;
    }
    this.appliedTheme = theme;
    this.currentUrl = url;
    this.src.set(withForumEntryParams(url, theme));
    await this.checkSsoStatus();
    // The app theme flipped while we were resolving the entry URL.
    const latest = this.store.resolvedTheme();
    if (latest !== theme) await this.updateTheme(latest);
  }

  /** App theme changed while the forum is open: update cookies, tell the page, reload as a fallback. */
  private async updateTheme(theme: ForumTheme): Promise<void> {
    this.appliedTheme = theme;
    await this.setThemeCookies(theme);
    const view = this.view()?.nativeElement;
    if (!view) return;
    try {
      await view.executeJavaScript(forumThemeMessageScript(theme));
    } catch {
      // Page not ready / script failed: reload on the current page with the new theme.
      // Never replay a one-time SSO link; the cookie already covers the page it redirects to.
      let current = this.currentUrl;
      try { current = view.getURL() || current; } catch { /* keep last known URL */ }
      if (isForumSsoConsumeUrl(current)) return;
      try { await view.loadURL(withForumEntryParams(current, theme)); } catch { /* best effort */ }
    }
  }

  private async setThemeCookies(theme: ForumTheme): Promise<void> {
    try { await window.wlsaplus?.forum.setTheme?.(theme); } catch { /* Theme is cosmetic; never block the forum. */ }
  }

  private async checkSsoStatus(): Promise<void> {
    try {
      const status = await window.wlsaplus?.forum.ssoStatus?.();
      if (status && FORUM_SSO_REPORTABLE_CODES.includes(status.code)) {
        this.ssoIssue.set({ code: status.code, time: new Date(status.at).toLocaleString() });
        this.clearNoticeTimer();
        this.noticeTimer = setTimeout(() => { this.noticeTimer = null; this.ssoIssue.set(null); }, this.ssoNoticeMs);
      }
    } catch { /* Status is informational only. */ }
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }
}
