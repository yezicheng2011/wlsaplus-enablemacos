import { Injectable, effect, inject } from '@angular/core';
import { LocalStore } from './local-store.service';
import type { ClassReminderSession, ClassReminderSyncPayload } from './models';

/** Minutes before class start when the reminder fires (scheduled in electron/class-reminders.cjs). */
export const CLASS_REMINDER_LEAD_MINUTES = 5;

/** Dedupe keys kept by the old renderer-side timer; handed to the main process once, then removed. */
export const LEGACY_NOTIFIED_KEY = 'wlsaplus:class-reminders-notified';

/**
 * Class reminders are scheduled by the Electron main process so they keep firing after the last
 * window is closed (macOS keeps the app running) and after a windowless autostart. This service
 * only syncs the schedule and the on/off switch to the main process whenever they change.
 */
@Injectable({ providedIn: 'root' })
export class ClassReminderService {
  private readonly store = inject(LocalStore);
  private lastSynced: string | null = null;
  private legacyNotified: string[] | null = this.readLegacyNotified();

  constructor() {
    if (!window.wlsaplus?.reminders) return;
    effect(() => {
      const payload: ClassReminderSyncPayload = {
        enabled: this.store.settings().classRemindersEnabled,
        sessions: this.store.schedule().sessions.map(toReminderSession),
      };
      void this.sync(payload);
    });
  }

  private async sync(payload: ClassReminderSyncPayload): Promise<void> {
    const reminders = window.wlsaplus?.reminders;
    if (!reminders) return;
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastSynced) return;
    this.lastSynced = serialized;
    const legacy = this.legacyNotified;
    try {
      await reminders.sync(legacy?.length ? { ...payload, legacyNotified: legacy } : payload);
      if (legacy) {
        this.legacyNotified = null;
        localStorage.removeItem(LEGACY_NOTIFIED_KEY);
      }
    } catch {
      // Let the next change retry.
      if (this.lastSynced === serialized) this.lastSynced = null;
    }
  }

  private readLegacyNotified(): string[] | null {
    try {
      const raw = localStorage.getItem(LEGACY_NOTIFIED_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-2000) : [];
    } catch {
      return [];
    }
  }
}

function toReminderSession(session: ClassReminderSession): ClassReminderSession {
  return {
    id: session.id,
    startsAt: session.startsAt,
    courseName: session.courseName,
    room: session.room,
    teacher: session.teacher,
  };
}
