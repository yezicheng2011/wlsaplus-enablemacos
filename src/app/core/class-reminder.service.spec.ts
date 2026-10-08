import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassReminderService, LEGACY_NOTIFIED_KEY } from './class-reminder.service';
import { LocalStore } from './local-store.service';
import { PlatformService } from './platform.service';
import type { ClassReminderSyncPayload, PlatformInfo, ScheduleSnapshot } from './models';

const schedule: ScheduleSnapshot = {
  syncedAt: '2026-10-08T00:00:00.000Z',
  weekStart: '2026-10-05',
  weekEnd: '2026-10-09',
  sessions: [{ id: 's1', courseId: 'c1', courseName: 'Physics', teacher: 'Ms Li', room: 'B204', startsAt: '2026-10-08T08:00:00', endsAt: '2026-10-08T08:45:00' }],
  courses: [],
};

function setup(os: PlatformInfo['os'] = 'macos', kind: PlatformInfo['kind'] = 'electron') {
  const sync = vi.fn<(payload: ClassReminderSyncPayload) => Promise<boolean>>().mockResolvedValue(true);
  (window as unknown as { wlsaplus: unknown }).wlsaplus = { reminders: { sync } };
  TestBed.configureTestingModule({
    providers: [{ provide: PlatformService, useValue: { info: { kind, os } } }],
  });
  const store = TestBed.inject(LocalStore);
  const service = TestBed.inject(ClassReminderService);
  TestBed.tick();
  return { sync, store, service };
}

describe('ClassReminderService (main-process scheduler sync)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete (window as unknown as { wlsaplus?: unknown }).wlsaplus;
    TestBed.resetTestingModule();
  });

  it('syncs minimal session fields and the switch to the main process', async () => {
    const { sync, store } = setup();
    expect(sync).toHaveBeenLastCalledWith({ enabled: true, sessions: [] });

    store.saveSchedule(schedule);
    TestBed.tick();
    expect(sync).toHaveBeenLastCalledWith({
      enabled: true,
      sessions: [{ id: 's1', startsAt: '2026-10-08T08:00:00', courseName: 'Physics', room: 'B204', teacher: 'Ms Li' }],
    });

    store.updateSettings({ classRemindersEnabled: false });
    TestBed.tick();
    expect(sync.mock.lastCall?.[0].enabled).toBe(false);
  });

  it('does not resend an unchanged payload', () => {
    const { sync, store } = setup();
    const calls = sync.mock.calls.length;
    store.updateSettings({ color: 'purple' });
    TestBed.tick();
    expect(sync.mock.calls.length).toBe(calls);
  });

  it('hands legacy localStorage dedupe keys to main once, then removes them', async () => {
    localStorage.setItem(LEGACY_NOTIFIED_KEY, JSON.stringify(['s1|2026-10-08T08:00:00', 7]));
    const { sync } = setup();
    expect(sync.mock.calls[0][0].legacyNotified).toEqual(['s1|2026-10-08T08:00:00']);
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(LEGACY_NOTIFIED_KEY)).toBeNull();
  });

  it('keeps setEnabled writing the setting', () => {
    const { service, store } = setup();
    service.setEnabled(false);
    expect(store.settings().classRemindersEnabled).toBe(false);
  });

  it('stays off outside the macOS Electron app', () => {
    const { sync } = setup('windows');
    expect(sync).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    const web = setup('web', 'web');
    expect(web.sync).not.toHaveBeenCalled();
  });
});
