import { Component, NO_ERRORS_SCHEMA, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PlatformService } from '../core/platform.service';
import { FORUM_BRAND, FORUM_SSO_REPORTABLE_CODES, FORUM_URL } from '../core/forum.config';

/** Subset of Electron's <webview> element API used by the forum page. */
interface ForumWebview extends HTMLElement {
  canGoBack(): boolean;
  goBack(): void;
  reload(): void;
  getURL(): string;
}

interface WebviewFailEvent extends Event { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string }
interface WebviewNavigateEvent extends Event { url: string; isMainFrame?: boolean }

@Component({
  selector: 'app-forum-page',
  imports: [MatButtonModule, MatTooltipModule],
  // <webview> is an Electron built-in element (no dash, so CUSTOM_ELEMENTS_SCHEMA does not cover it).
  schemas: [NO_ERRORS_SCHEMA],
  template: `
    <section class="forum" [attr.aria-label]="brand.name">
      <header class="forum-bar">
        <img class="forum-logo" [src]="brand.logo" alt="" width="32" height="32">
        <h1>{{ brand.name }}</h1>
        <span class="spacer"></span>
        @if (desktop) {
          <button mat-icon-button type="button" (click)="back()" [disabled]="!canGoBack()" matTooltip="Back" aria-label="Back"><span class="material-symbols-rounded">arrow_back</span></button>
          <button mat-icon-button type="button" (click)="reload()" matTooltip="Reload" aria-label="Reload"><span class="material-symbols-rounded">refresh</span></button>
        }
        <button mat-icon-button type="button" (click)="openInBrowser()" matTooltip="Open in browser" aria-label="Open in browser"><span class="material-symbols-rounded">open_in_new</span></button>
      </header>
      <div class="forum-loading" [class.active]="loading()" aria-hidden="true"></div>
      @if (ssoIssue(); as issue) {
        <div class="forum-sso-issue" role="status">
          <span class="material-symbols-rounded" aria-hidden="true">info</span>
          <span>Automatic sign-in didn't work ({{ issue.code }}, {{ issue.time }}). You're browsing as a guest; please report this code to the forum team.</span>
          <button mat-icon-button type="button" (click)="ssoIssue.set(null)" aria-label="Dismiss"><span class="material-symbols-rounded">close</span></button>
        </div>
      }
      <div class="forum-body">
        @if (!desktop) {
          <div class="empty-state"><div><span class="material-symbols-rounded big">{{ brand.icon }}</span><p>The forum opens in your browser on the web version.</p><a mat-flat-button [href]="forumUrl" target="_blank" rel="noopener">Open {{ brand.name }}</a></div></div>
        } @else if (failed()) {
          <div class="empty-state"><div><span class="material-symbols-rounded big">cloud_off</span><p>{{ brand.name }} could not be reached. {{ failed() }}</p><button mat-flat-button type="button" (click)="retry()">Try again</button></div></div>
        } @else if (src()) {
          <webview #view class="forum-view" partition="persist:forum" allowpopups [attr.src]="src()"
            (did-start-loading)="loading.set(true)" (did-stop-loading)="onStopLoading()"
            (did-fail-load)="onFailLoad($event)" (did-navigate)="onNavigate($event)" (did-navigate-in-page)="onNavigate($event)"></webview>
        }
      </div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .forum { height: 100vh; display: flex; flex-direction: column; background: var(--app-bg); }
    .forum-bar { flex: 0 0 auto; min-height: 56px; display: flex; align-items: center; gap: 10px; padding: 6px 12px 6px 18px; background: var(--app-surface); border-bottom: 1px solid var(--app-border); }
    .forum-logo { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 8px; display: block; }
    .forum-sso-issue { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 4px 8px 4px 16px; background: var(--forum-accent-soft); color: var(--app-text); font-size: 13px; }
    .forum-sso-issue > span:nth-child(2) { flex: 1; }
    .forum-sso-issue > .material-symbols-rounded { color: var(--forum-accent); }
    h1 { margin: 0; font-size: 18px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .forum-loading { flex: 0 0 3px; background: transparent; }
    .forum-loading.active { background: linear-gradient(90deg, transparent, var(--forum-accent), transparent) 0 0 / 40% 100% no-repeat var(--forum-accent-soft); animation: forum-loading 1.1s linear infinite; }
    @keyframes forum-loading { from { background-position: -40% 0; } to { background-position: 140% 0; } }
    .forum-body { flex: 1 1 auto; min-height: 0; position: relative; display: flex; }
    .forum-view { flex: 1 1 auto; width: 100%; height: 100%; display: flex; border: 0; }
    .empty-state { flex: 1; } .empty-state p { margin: 10px 0 18px; } .big { font-size: 44px; color: var(--forum-accent); }
    @media (max-width: 899px) { .forum { height: calc(100vh - 72px - env(safe-area-inset-bottom)); } }
  `,
})
export class ForumPage implements OnInit {
  private readonly platform = inject(PlatformService);
  private readonly view = viewChild<ElementRef<ForumWebview>>('view');
  readonly brand = FORUM_BRAND;
  readonly forumUrl = FORUM_URL;
  readonly desktop = this.platform.info.kind === 'electron' && !!window.wlsaplus?.forum;
  readonly src = signal<string | null>(null);
  readonly loading = signal(false);
  readonly failed = signal<string | null>(null);
  readonly canGoBack = signal(false);
  readonly ssoIssue = signal<{ code: string; time: string } | null>(null);
  private currentUrl = FORUM_URL;
  private usingFallback = false;

  async ngOnInit(): Promise<void> {
    if (this.desktop) await this.open(false);
  }

  async retry(): Promise<void> {
    this.failed.set(null);
    this.src.set(null);
    await this.open(false);
  }

  back(): void {
    const view = this.view()?.nativeElement;
    if (view?.canGoBack()) view.goBack();
  }

  reload(): void {
    if (this.failed()) { void this.retry(); return; }
    this.view()?.nativeElement.reload();
  }

  openInBrowser(): void {
    // Never hand a one-time SSO link to the browser.
    const url = this.currentUrl && !this.currentUrl.includes('/sso/consume') ? this.currentUrl : FORUM_URL;
    if (window.wlsaplus) void window.wlsaplus.system.openExternal(url).catch(() => window.wlsaplus?.system.openExternal(FORUM_URL));
    else window.open(url, '_blank', 'noopener');
  }

  onStopLoading(): void {
    this.loading.set(false);
    this.updateHistory();
  }

  onNavigate(event: Event): void {
    const { url, isMainFrame } = event as WebviewNavigateEvent;
    if (isMainFrame === false || !url) return;
    this.currentUrl = url;
    this.updateHistory();
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
    let url: string;
    try {
      url = await window.wlsaplus!.forum.ssoUrl({ fallback });
    } catch {
      url = FORUM_URL;
    }
    this.src.set(url);
    await this.checkSsoStatus();
  }

  private async checkSsoStatus(): Promise<void> {
    try {
      const status = await window.wlsaplus?.forum.ssoStatus?.();
      if (status && FORUM_SSO_REPORTABLE_CODES.includes(status.code)) {
        this.ssoIssue.set({ code: status.code, time: new Date(status.at).toLocaleString() });
      }
    } catch { /* Status is informational only. */ }
  }

  private updateHistory(): void {
    try { this.canGoBack.set(!!this.view()?.nativeElement.canGoBack()); } catch { this.canGoBack.set(false); }
  }
}
