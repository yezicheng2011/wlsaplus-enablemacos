import { Injectable, signal } from '@angular/core';
import type { AppNotice } from './models';

export type { AppNotice } from './models';

export const NOTICE_SEEN_KEY = 'wlsaplus:notice-seen';

/** Shows the notice published on the official site (fetched by the main process, see electron/app-notice.cjs). */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  readonly notice = signal<AppNotice | null>(null);
  readonly dismissed = signal(false);

  constructor() {
    void this.load();
  }

  dismiss(): void {
    const notice = this.notice();
    if (!notice) return;
    localStorage.setItem(NOTICE_SEEN_KEY, notice.id);
    this.dismissed.set(true);
  }

  private async load(): Promise<void> {
    const bridge = window.wlsaplus?.notice;
    if (!bridge) return;
    try {
      const value = await bridge.get();
      if (!value || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title
        || typeof value.content !== 'string' || !value.content) return;
      this.notice.set({ id: value.id, title: value.title, content: value.content, type: value.type });
      this.dismissed.set(localStorage.getItem(NOTICE_SEEN_KEY) === value.id);
    } catch {
      // No notice when offline or the site is unavailable.
    }
  }
}
