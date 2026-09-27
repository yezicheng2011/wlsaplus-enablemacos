import { Injectable, effect, inject } from '@angular/core';
import { LocalStore } from './local-store.service';
import { PlatformService } from './platform.service';
import { ClockService } from './clock.service';

/** Minutes before class start when the reminder fires. */
export const CLASS_REMINDER_LEAD_MINUTES = 5;

const NOTIFIED_KEY = 'wlsaplus:class-reminders-notified';

@Injectable({ providedIn: 'root' })
export class ClassReminderService {
  private readonly store = inject(LocalStore);
  private readonly platform = inject(PlatformService);
  private readonly clock = inject(ClockService);
  private timer: number | null = null;
  private readonly notified = new Set<string>(this.readNotified());

  constructor() {
    if (this.platform.info.kind !== 'electron' || this.platform.info.os !== 'macos') return;
    effect(() => {
      // Re-arm when schedule or reminder setting changes.
      this.store.schedule();
      this.store.settings().classRemindersEnabled;
      this.arm();
    });
    this.timer = window.setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  setEnabled(enabled: boolean): void {
    this.store.updateSettings({ classRemindersEnabled: enabled });
  }

  private arm(): void {
    this.tick();
  }

  private tick(): void {
    if (!this.store.settings().classRemindersEnabled) return;
    if (!window.wlsaplus?.notifications) return;
    const sessions = this.store.schedule().sessions;
    if (!sessions.length) return;

    const now = this.clock.now().getTime();
    const leadMs = CLASS_REMINDER_LEAD_MINUTES * 60_000;
    // Fire when we are within the lead window and class has not started yet.
    for (const session of sessions) {
      const startsAt = Date.parse(session.startsAt);
      if (!Number.isFinite(startsAt)) continue;
      const key = `${session.id}|${session.startsAt}`;
      if (this.notified.has(key)) continue;
      const msUntilStart = startsAt - now;
      if (msUntilStart <= 0) continue;
      if (msUntilStart > leadMs) continue;

      const room = session.room ? ` · Room ${session.room}` : '';
      const teacher = session.teacher ? ` · ${session.teacher}` : '';
      const notifications = window.wlsaplus?.notifications;
      if (!notifications) return;
      void notifications.showClassReminder({
        title: 'Class starting soon',
        body: `${session.courseName} starts in ${CLASS_REMINDER_LEAD_MINUTES} minutes${room}${teacher}`,
        sessionId: key,
      }).then((shown) => {
        if (shown) this.markNotified(key);
      }).catch(() => { /* Ignore notification permission failures. */ });
    }
    this.pruneNotified(sessions.map((s) => `${s.id}|${s.startsAt}`));
  }

  private markNotified(key: string): void {
    this.notified.add(key);
    this.writeNotified();
  }

  private pruneNotified(activeKeys: string[]): void {
    const active = new Set(activeKeys);
    let changed = false;
    for (const key of [...this.notified]) {
      if (!active.has(key)) {
        this.notified.delete(key);
        changed = true;
      }
    }
    if (changed) this.writeNotified();
  }

  private readNotified(): string[] {
    try {
      const raw = localStorage.getItem(NOTIFIED_KEY);
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeNotified(): void {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...this.notified]));
  }
}
