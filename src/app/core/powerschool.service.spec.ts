import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialVault } from './credential-vault.service';
import { LocalStore } from './local-store.service';
import type { PlatformHttpResponse, PowerSchoolCredentials } from './models';
import { PlatformService, type NativeRequest } from './platform.service';
import { PowerSchoolService } from './powerschool.service';

const accountA: PowerSchoolCredentials = { schoolUrl: 'https://school.example', username: 'alice', password: 'alice-password' };
const accountB: PowerSchoolCredentials = { ...accountA, username: 'bob', password: 'bob-password' };
const weekHtml = '<table id="tableStudentSchedMatrix"><tr><td class="scheduleClass1" name="attCell20260824">Algebra<br>Teacher<br>210<br>09:00 AM - 09:40 AM</td></tr></table>';
const homeHtml = '<table class="linkDescList grid"><tr><th>Meeting</th><th>Course</th><th>S1</th><th>Absences</th><th>Tardies</th></tr><tr id="ccid_42"><td>P1(Mon)</td><td>Algebra</td><td><a href="scores.html?frn=0042">A</a></td><td>1</td><td>0</td></tr></table>';
const attendanceHtml = '<table class="grid"><tr><th rowspan="2">Course</th><th rowspan="2">Meeting</th><th>Week</th></tr><tr><th title="Monday, 24 August 2026">Mon</th></tr><tr><td>Algebra<br>Teacher</td><td>P1(Mon)</td><td>X</td></tr></table>';
const response = (text: string, status = 200): PlatformHttpResponse => ({ status, text, url: accountA.schoolUrl });
const details = { description: 'Alice private details', teacherComment: '', assignments: [], loadedAt: new Date().toISOString() };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};

describe('PowerSchoolService account lifecycle', () => {
  let saved: PowerSchoolCredentials | null;
  let store: LocalStore;
  let service: PowerSchoolService;
  let bridge: {
    get: ReturnType<typeof vi.fn<() => Promise<PowerSchoolCredentials | null>>>;
    set: ReturnType<typeof vi.fn<(value: PowerSchoolCredentials) => Promise<void>>>;
    clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let platform: {
    clearSession: ReturnType<typeof vi.fn<(origin: string) => Promise<void>>>;
    request: ReturnType<typeof vi.fn<(request: NativeRequest) => Promise<PlatformHttpResponse>>>;
  };
  let attendanceAvailable: boolean;

  beforeEach(() => {
    localStorage.clear();
    saved = null;
    attendanceAvailable = true;
    bridge = {
      get: vi.fn(async () => saved),
      set: vi.fn(async (value) => { saved = value; }),
      clear: vi.fn(async () => { saved = null; }),
    };
    (window as unknown as { wlsaplus: unknown }).wlsaplus = { credentials: bridge, forum: { clearSession: vi.fn(async () => undefined) } };
    platform = {
      clearSession: vi.fn(async () => undefined),
      request: vi.fn(async (request) => {
        if (request.path === '/public/') return response('<form></form>');
        if (request.path === '/guardian/home.html') return response(homeHtml);
        if (request.path === '/guardian/myschedule.html') return response(weekHtml);
        if (request.path === '/guardian/myschedulematrix.html') return response('');
        if (request.path === '/guardian/attendance.html') return response(attendanceAvailable ? attendanceHtml : '', attendanceAvailable ? 200 : 503);
        if (request.path === '/guardian/scores.html?frn=0042') return response('<div class="comment"><pre>Fresh details</pre></div>');
        throw new Error(`Unexpected request: ${request.path}`);
      }),
    };
    store = new LocalStore();
    TestBed.configureTestingModule({ providers: [
      { provide: LocalStore, useValue: store },
      { provide: PlatformService, useValue: platform },
      { provide: CredentialVault, useValue: new CredentialVault() },
    ] });
    service = TestBed.inject(PowerSchoolService);
  });

  afterEach(() => {
    delete (window as unknown as { wlsaplus?: unknown }).wlsaplus;
  });

  it('clears data without waiting for an old HTTP response and never restores it afterward', async () => {
    await service.connect(accountA);
    store.addTodo('Private task');
    const pending = deferred<PlatformHttpResponse>();
    const original = platform.request.getMockImplementation()!;
    platform.request.mockImplementation((request) => request.path === '/guardian/myschedule.html' ? pending.promise : original(request));
    const syncing = service.syncSaved().catch((error: unknown) => error);
    await vi.waitFor(() => expect(platform.request.mock.calls.filter(([request]) => request.path === '/guardian/myschedule.html')).toHaveLength(2));

    await service.disconnect();
    expect(saved).toBeNull();
    expect(store.schedule().sessions).toEqual([]);
    expect(store.progress().attendanceEvents).toEqual([]);
    expect(store.todos()).toEqual([]);

    pending.resolve(response(weekHtml));
    expect(await syncing).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    expect(saved).toBeNull();
    expect(localStorage.getItem('wlsaplus:schedule')).toBeNull();
    expect(localStorage.getItem('wlsaplus:progress')).toBeNull();
  });

  it('does not restart saved-account sync when its credential read finishes after clearing', async () => {
    saved = accountA;
    const pending = deferred<PowerSchoolCredentials | null>();
    bridge.get.mockImplementationOnce(() => pending.promise);
    const syncing = service.syncSaved().catch((error: unknown) => error);
    await vi.waitFor(() => expect(bridge.get).toHaveBeenCalledOnce());
    const clearing = service.disconnect();
    pending.resolve(accountA);

    await clearing;
    expect(await syncing).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    expect(saved).toBeNull();
    expect(platform.request).not.toHaveBeenCalled();
    expect(bridge.set).not.toHaveBeenCalled();
  });

  it('fences a credential write that has already started before clearing', async () => {
    const pending = deferred<void>();
    bridge.set.mockImplementationOnce(async (value) => { await pending.promise; saved = value; });
    const connecting = service.connect(accountA).catch((error: unknown) => error);
    await vi.waitFor(() => expect(bridge.set).toHaveBeenCalledOnce());
    const clearing = service.disconnect();
    expect(store.schedule().sessions).toEqual([]);
    expect(bridge.clear).not.toHaveBeenCalled();

    pending.resolve();
    await clearing;
    expect(await connecting).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    expect(saved).toBeNull();
    expect(store.schedule().sessions).toEqual([]);
    expect(bridge.clear).toHaveBeenCalledOnce();
  });

  it('lets the newest account win and prevents background refresh from superseding it', async () => {
    const pending = deferred<PlatformHttpResponse>();
    platform.request.mockImplementationOnce(() => pending.promise);
    const connectingA = service.connect(accountA).catch((error: unknown) => error);
    await vi.waitFor(() => expect(platform.request).toHaveBeenCalledOnce());
    const connectingB = service.connect(accountB);
    const refreshing = service.syncSaved();
    pending.resolve(response('<form></form>'));

    expect(await connectingA).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    await Promise.all([connectingB, refreshing]);
    expect(saved).toEqual(accountB);
    expect(platform.request.mock.calls.filter(([request]) => request.path === '/guardian/home.html')).toHaveLength(1);
    expect(store.progress().accountKey).toBe(JSON.stringify([accountB.schoolUrl, accountB.username]));
  });

  it('does not carry attendance or matching course details into another account on HTTP 503', async () => {
    await service.connect(accountA);
    expect(store.progress().attendanceEvents).toHaveLength(1);
    store.updateProgressCourse('42', { details });
    attendanceAvailable = false;

    await service.connect(accountB);

    expect(saved).toEqual(accountB);
    expect(store.progress().attendanceEvents).toEqual([]);
    expect(store.progress().attendanceStart).toBe('');
    expect(store.progress().courses[0].details).toBeNull();
  });

  it('never fetches old-account courses with cookies from a new account whose schedule failed', async () => {
    await service.connect(accountA);
    const original = platform.request.getMockImplementation()!;
    platform.request.mockImplementation((request) => request.path === '/guardian/myschedule.html'
      ? Promise.resolve(response('<p>No schedule</p>')) : original(request));
    // Even a failed native cleanup must not allow B's session to be used as A.
    platform.clearSession.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Cookie cleanup failed'));

    await expect(service.connect(accountB)).rejects.toThrow('weekly schedule was not available');
    expect(saved).toEqual(accountA);
    expect(store.progress().accountKey).toBe(JSON.stringify([accountA.schoolUrl, accountA.username]));
    const requestCount = platform.request.mock.calls.length;

    await expect(service.loadCourse('42', true)).rejects.toThrow('Refresh Progress');

    expect(platform.request).toHaveBeenCalledTimes(requestCount);
    expect(store.progress().courses[0].details).toBeNull();
  });

  it('drains failed parallel requests and clears old cookies before starting the next login', async () => {
    const pending = deferred<PlatformHttpResponse>();
    const original = platform.request.getMockImplementation()!;
    let holdOldRequests = true;
    platform.request.mockImplementation((request) => {
      if (holdOldRequests && request.path === '/guardian/myschedule.html') return Promise.reject(new Error('Network failed'));
      if (holdOldRequests && request.path === '/guardian/attendance.html') return pending.promise;
      return original(request);
    });
    const connectingA = service.connect(accountA).catch((error: unknown) => error);
    await vi.waitFor(() => expect(platform.request.mock.calls.some(([request]) => request.path === '/guardian/attendance.html')).toBe(true));

    await service.disconnect();
    holdOldRequests = false;
    const connectingB = service.connect(accountB);
    expect(platform.request.mock.calls.filter(([request]) => request.path === '/guardian/home.html')).toHaveLength(1);
    expect(saved).toBeNull();
    pending.resolve(response(attendanceHtml));

    expect(await connectingA).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    await connectingB;
    expect(saved).toEqual(accountB);
    const clearOrders = platform.clearSession.mock.invocationCallOrder;
    const secondLoginIndex = platform.request.mock.calls.findIndex(([request], index) => request.path === '/public/' && index > 0);
    expect(clearOrders.length).toBe(4); // A starts, failed A cleanup, clear-device cleanup, B starts.
    expect(clearOrders[2]).toBeLessThan(platform.request.mock.invocationCallOrder[secondLoginIndex]);
  });

  it('reuses only a persisted cache with the same normalized school and username', async () => {
    await service.connect(accountA);
    const cached = new LocalStore().progress();
    expect(cached.accountKey).toBe(JSON.stringify([accountA.schoolUrl, accountA.username]));
    store.updateProgressCourse('42', { details });
    attendanceAvailable = false;

    await service.connect({ ...accountA, schoolUrl: ' SCHOOL.example/guardian/ ', username: ' alice ' });

    expect(saved).toEqual(accountA);
    expect(store.progress().attendanceEvents).toEqual(cached.attendanceEvents);
    expect(store.progress().courses[0].details).toEqual(details);
  });

  it('does not reuse attendance for the same username at a different school', async () => {
    await service.connect(accountA);
    attendanceAvailable = false;

    await service.connect({ ...accountA, schoolUrl: 'https://another.example' });

    expect(store.progress().attendanceEvents).toEqual([]);
  });

  it('does not reuse legacy attendance whose account is unknown', async () => {
    await service.connect(accountA);
    const { accountKey: _accountKey, ...legacy } = store.progress();
    store.saveProgress(legacy);
    attendanceAvailable = false;

    await service.syncSaved();

    expect(store.progress().attendanceEvents).toEqual([]);
  });

  it('discards late course details during account change even when course IDs match', async () => {
    await service.connect(accountA);
    const pending = deferred<PlatformHttpResponse>();
    const original = platform.request.getMockImplementation()!;
    platform.request.mockImplementation((request) => request.path.startsWith('/guardian/scores.html') ? pending.promise : original(request));
    const loading = service.loadCourse('42', true).catch((error: unknown) => error);
    await vi.waitFor(() => expect(platform.request.mock.calls.some(([request]) => request.path.startsWith('/guardian/scores.html'))).toBe(true));
    const connecting = service.connect(accountB);
    pending.resolve(response('<div class="comment"><pre>Alice private comment</pre></div>'));

    expect(await loading).toMatchObject({ message: 'PowerSchool operation was cancelled.' });
    await connecting;
    expect(store.progress().courses[0].details).toBeNull();
    expect(saved).toEqual(accountB);
  });

  it('continues clearing local data when secure credential deletion fails', async () => {
    await service.connect(accountA);
    bridge.clear.mockRejectedValueOnce(new Error('Keychain unavailable'));

    await expect(service.disconnect()).rejects.toThrow('Keychain unavailable');

    expect(store.schedule().sessions).toEqual([]);
    expect(store.progress().courses).toEqual([]);
  });
});
