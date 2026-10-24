import { Injectable, computed, inject, signal } from '@angular/core';
import { LocalStore } from './local-store.service';
import { UI_MESSAGES, type ResolvedUiLang } from './i18n.messages';
import type { UiLang } from './models';

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly store = inject(LocalStore);
  /** Bumps when settings.uiLang or OS preference may have changed so templates refresh. */
  private readonly tick = signal(0);

  readonly lang = computed<ResolvedUiLang>(() => {
    this.tick();
    const settings = typeof this.store.settings === 'function' ? this.store.settings() : null;
    return this.resolve((settings?.uiLang as UiLang) || 'system');
  });

  constructor() {
    window.addEventListener('languagechange', () => this.tick.update((n) => n + 1));
    // Language preference follows navigator; listen for storage sync across windows.
    window.addEventListener('storage', () => this.tick.update((n) => n + 1));
  }

  /** Call after updateSettings({ uiLang }) so open views refresh without reload. */
  refresh(): void {
    this.tick.update((n) => n + 1);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = this.lang() === 'zh' ? 'zh-CN' : 'en';
    }
  }

  t(key: string, vars?: Record<string, string | number>): string {
    const pack = UI_MESSAGES[this.lang()] || UI_MESSAGES.zh;
    let text = pack[key] || UI_MESSAGES.zh[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  }

  private resolve(pref: UiLang): ResolvedUiLang {
    if (pref === 'zh' || pref === 'en') return pref;
    const nav = (navigator.languages?.length ? navigator.languages : [navigator.language || '']).join(',').toLowerCase();
    if (/(^|,)\s*zh/.test(nav)) return 'zh';
    if (/(^|,)\s*en/.test(nav)) return 'en';
    return 'zh';
  }
}
