import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore } from '../core/local-store.service';
import type { ClassSession, ScheduleSnapshot } from '../core/models';
import { SchedulePage } from './schedule.page';

function session(id: string, localStart: string): ClassSession {
  const start = new Date(localStart);
  return {
    id, courseId: id, courseName: id, teacher: '', room: '',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
  };
}

async function render(sessions: ClassSession[]) {
  const schedule = signal<ScheduleSnapshot>({ syncedAt: '', weekStart: '', weekEnd: '', courses: [], sessions });
  TestBed.configureTestingModule({ providers: [{ provide: LocalStore, useValue: { schedule } }] });
  const fixture = TestBed.createComponent(SchedulePage);
  await fixture.whenStable();
  return fixture;
}

describe('SchedulePage local dates', () => {
  afterEach(() => TestBed.resetTestingModule());

  // TZ=Asia/Shanghai npm run ng -- test --watch=false --include src/app/pages/schedule.page.spec.ts
  // Run in Asia/Shanghai to cover 07:45 local stored as 23:45Z the day before,
  // and America/New_York to cover UTC rollover and daylight-saving transitions.
  it('shows an early morning class under the same Monday heading as later classes', async () => {
    const morning = session('morning', '2026-10-12T07:45:00');
    const later = session('later', '2026-10-12T09:00:00');
    const fixture = await render([morning, later]);

    expect(fixture.componentInstance.days()).toEqual([
      { date: '2026-10-12T12:00:00', sessions: [morning, later] },
    ]);
    const heading = (fixture.nativeElement as HTMLElement).querySelector('.day-heading');
    expect(heading?.textContent).toContain('Monday');
    expect(heading?.textContent).toContain('October 12');
    expect((fixture.nativeElement as HTMLElement).querySelector('.session-time strong')?.textContent).toBe('07:45');
    expect(fixture.componentInstance.matrixDays().find((day) => day.key === '2026-10-12')?.sessions).toEqual([morning, later]);
  });

  it('separates classes on opposite sides of local midnight', async () => {
    const before = session('before', '2026-10-11T23:45:00');
    const after = session('after', '2026-10-12T00:15:00');
    const fixture = await render([before, after]);

    expect(fixture.componentInstance.days()).toEqual([
      { date: '2026-10-11T12:00:00', sessions: [before] },
      { date: '2026-10-12T12:00:00', sessions: [after] },
    ]);
  });

  it.each(['2026-03-08', '2026-11-01'])('keeps the date consistent across the daylight-saving transition on %s', async (date) => {
    const early = session('early', `${date}T01:30:00`);
    const late = session('late', `${date}T23:30:00`);
    const fixture = await render([early, late]);

    expect(fixture.componentInstance.days()).toEqual([
      { date: `${date}T12:00:00`, sessions: [early, late] },
    ]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.day-heading strong')?.textContent).toBe('Sunday');
  });
});
