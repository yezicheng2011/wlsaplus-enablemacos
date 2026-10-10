import { Injectable, inject } from '@angular/core';
import type { PowerSchoolCredentials, ProgressCourse, ProgressSnapshot, ScheduleSnapshot } from './models';
import { CredentialVault } from './credential-vault.service';
import { LocalStore } from './local-store.service';
import {
  parseAssignmentLookupRequest,
  parsePowerSchoolCourseDetails,
  parsePowerSchoolProgress,
  parsePowerSchoolSchedule,
} from './powerschool-parser';
import { PlatformService } from './platform.service';

@Injectable({ providedIn: 'root' })
export class PowerSchoolService {
  private readonly platform = inject(PlatformService);
  private readonly vault = inject(CredentialVault);
  private readonly store = inject(LocalStore);
  private generation = 0;
  private sessionWork: Promise<unknown> = Promise.resolve();
  private activeConnection: Promise<ScheduleSnapshot> | null = null;
  private readonly sessionOrigins = new Set<string>();
  private sessionAccountKey: string | null = null;

  async connect(credentials: PowerSchoolCredentials): Promise<ScheduleSnapshot> {
    const normalized = { ...credentials, schoolUrl: this.normalizeUrl(credentials.schoolUrl), username: credentials.username.trim() };
    const generation = ++this.generation;
    return this.startConnection(() => this.connectAccount(normalized, generation));
  }

  private async connectAccount(normalized: PowerSchoolCredentials, generation: number): Promise<ScheduleSnapshot> {
    try {
      return await this.fetchAccount(normalized, generation);
    } catch (error) {
      // Authentication may have switched the shared session even when fetching
      // or saving the new account failed. Never fetch old courses with it.
      this.sessionAccountKey = null;
      try { await this.platform.clearSession(normalized.schoolUrl); } catch { /* Ownership remains invalid even if cleanup fails. */ }
      throw error;
    }
  }

  private async fetchAccount(normalized: PowerSchoolCredentials, generation: number): Promise<ScheduleSnapshot> {
    this.requireCurrent(generation);
    const previous = await this.vault.get();
    this.requireCurrent(generation);
    const accountKey = this.accountKey(normalized);
    this.sessionAccountKey = null;
    this.sessionOrigins.add(normalized.schoolUrl);
    await this.platform.clearSession(normalized.schoolUrl);
    this.requireCurrent(generation);
    const login = await this.platform.request({ baseUrl: normalized.schoolUrl, path: '/public/', method: 'GET' });
    this.requireCurrent(generation);
    this.requireSuccessful(login);
    const doc = new DOMParser().parseFromString(login.text, 'text/html');
    const field = (name: string): string => (doc.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
    const body = new URLSearchParams({
      dbpw: normalized.password,
      translator_username: '',
      translator_password: '',
      translator_ldappassword: '',
      returnUrl: field('returnUrl'),
      serviceName: field('serviceName') || 'PS Parent Portal',
      serviceTicket: field('serviceTicket'),
      pcasServerUrl: field('pcasServerUrl') || '/',
      credentialType: field('credentialType') || 'User Id and Password Credential',
      request_locale: field('request_locale'),
      account: normalized.username,
      pw: normalized.password,
      translatorpw: '',
    }).toString();
    const result = await this.platform.request({
      baseUrl: normalized.schoolUrl,
      path: '/guardian/home.html',
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    this.requireCurrent(generation);
    this.requireSuccessful(result);
    if (/name=["']account["']/i.test(result.text)) {
      throw new Error('Sign in failed. Check the server address, username, and password.');
    }
    // Drain both requests, including failures, before another login can use the
    // shared cookie session.
    const [scheduleResult, progressResult] = await Promise.allSettled([
      this.fetchSchedule(normalized.schoolUrl),
      this.fetchProgress(normalized.schoolUrl, result.text, accountKey),
    ]);
    this.requireCurrent(generation);
    if (scheduleResult.status === 'rejected') throw scheduleResult.reason;
    if (progressResult.status === 'rejected') throw progressResult.reason;
    const snapshot = scheduleResult.value;
    const progress = progressResult.value;
    if (previous && this.accountKey(previous) !== accountKey) await this.clearForumSession();
    this.requireCurrent(generation);
    await this.vault.set(normalized);
    this.requireCurrent(generation);
    this.store.saveSchedule(snapshot);
    this.store.saveProgress(progress);
    this.sessionAccountKey = accountKey;
    return snapshot;
  }

  async syncSaved(): Promise<ScheduleSnapshot> {
    // A timer refresh must not supersede an explicit account change.
    if (this.activeConnection) return this.activeConnection;
    const generation = ++this.generation;
    return this.startConnection(async () => {
      const credentials = await this.vault.get();
      this.requireCurrent(generation);
      if (!credentials) throw new Error('No saved PowerSchool account.');
      return this.connectAccount({ ...credentials, schoolUrl: this.normalizeUrl(credentials.schoolUrl), username: credentials.username.trim() }, generation);
    });
  }

  cancelPendingSync(): void {
    this.generation += 1;
    this.activeConnection = null;
  }

  async disconnect(): Promise<void> {
    this.cancelPendingSync();
    this.sessionAccountKey = null;
    this.store.clearAll();
    const credentials = this.vault.get().catch(() => null);
    const clearing = this.vault.clear();
    // Clear cookies after outstanding HTTP replies, which can themselves set
    // cookies, and before the next login. Local deletion never waits on HTTP.
    void this.queueSession(async () => {
      const saved = await credentials;
      if (saved) this.sessionOrigins.add(this.normalizeUrl(saved.schoolUrl));
      for (const origin of this.sessionOrigins) {
        try { await this.platform.clearSession(origin); } catch { /* Best-effort remote sign-out. */ }
      }
      this.sessionOrigins.clear();
    }).catch(() => undefined);
    await Promise.all([clearing, this.clearForumSession()]);
  }

  private startConnection(operation: () => Promise<ScheduleSnapshot>): Promise<ScheduleSnapshot> {
    const result = this.queueSession(operation).finally(() => {
      if (this.activeConnection === result) this.activeConnection = null;
    });
    this.activeConnection = result;
    return result;
  }

  private queueSession<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionWork.then(operation);
    this.sessionWork = result.catch(() => undefined);
    return result;
  }

  private requireCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('PowerSchool operation was cancelled.');
  }

  private accountKey(credentials: Pick<PowerSchoolCredentials, 'schoolUrl' | 'username'>): string {
    return JSON.stringify([this.normalizeUrl(credentials.schoolUrl), credentials.username.trim()]);
  }

  /** Signs the WLSAPlus 论坛 webview out so the next account doesn't inherit the forum login. */
  private async clearForumSession(): Promise<void> {
    try { await window.wlsaplus?.forum?.clearSession(); } catch { /* Forum data is best-effort. */ }
  }

  async loadCourse(courseId: string, force = false): Promise<ProgressCourse> {
    const generation = this.generation;
    return this.queueSession(() => this.loadAccountCourse(courseId, force, generation));
  }

  private async loadAccountCourse(courseId: string, force: boolean, generation: number): Promise<ProgressCourse> {
    this.requireCurrent(generation);
    const course = this.store.progress().courses.find((item) => item.id === courseId);
    if (!course) throw new Error('This course is no longer available.');
    if (!force && course.details && Date.now() - Date.parse(course.details.loadedAt) < 5 * 60_000) return course;
    if (!course.detailsPath) {
      const updated = this.store.updateProgressCourse(courseId, {
        details: { description: '', teacherComment: '', assignments: [], loadedAt: new Date().toISOString() },
      });
      if (!updated) throw new Error('This course is no longer available.');
      return updated;
    }
    const credentials = await this.vault.get();
    this.requireCurrent(generation);
    if (!credentials) {
      if (course.details) return course;
      throw new Error('Connect to PowerSchool to load this course.');
    }
    const accountKey = this.accountKey(credentials);
    if (this.store.progress().accountKey !== accountKey || this.sessionAccountKey !== accountKey) {
      if (course.details) return course;
      throw new Error('Refresh Progress to load courses for this account.');
    }
    this.sessionOrigins.add(this.normalizeUrl(credentials.schoolUrl));

    try {
      const page = await this.platform.request({
        baseUrl: credentials.schoolUrl,
        path: course.detailsPath,
        method: 'GET',
      });
      this.requireCurrent(generation);
      this.requireSuccessful(page);
      this.requireSignedIn(page.text);
      const lookup = parseAssignmentLookupRequest(page.text);
      let assignmentJson = '[]';
      if (lookup) {
        const assignments = await this.platform.request({
          baseUrl: credentials.schoolUrl,
          path: `/ws/xte/assignment/lookup?_=${Date.now()}`,
          method: 'POST',
          body: JSON.stringify(lookup),
          referrerPath: course.detailsPath,
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json;charset=UTF-8',
          },
        });
        this.requireCurrent(generation);
        this.requireSuccessful(assignments);
        assignmentJson = assignments.text;
      }
      const updated = this.store.updateProgressCourse(courseId, {
        details: parsePowerSchoolCourseDetails(page.text, assignmentJson),
      });
      if (!updated) throw new Error('This course is no longer available.');
      return updated;
    } catch (error) {
      this.requireCurrent(generation);
      if (course.details) return course;
      throw error;
    }
  }

  private async fetchSchedule(baseUrl: string): Promise<ScheduleSnapshot> {
    const [weekResult, matrixResult] = await Promise.allSettled([
      this.platform.request({ baseUrl, path: '/guardian/myschedule.html', method: 'GET' }),
      this.platform.request({ baseUrl, path: '/guardian/myschedulematrix.html', method: 'GET' }),
    ]);
    if (weekResult.status === 'rejected') throw weekResult.reason;
    if (matrixResult.status === 'rejected') throw matrixResult.reason;
    const week = weekResult.value;
    const matrix = matrixResult.value;
    this.requireSuccessful(week);
    this.requireSuccessful(matrix);
    if (!week.text.includes('tableStudentSchedMatrix')) {
      if (/name=["']account["']/i.test(week.text)) {
        throw new Error('Your PowerSchool session expired. Sign in again.');
      }
      throw new Error('The weekly schedule was not available for this account.');
    }
    const snapshot = parsePowerSchoolSchedule(week.text, matrix.text);
    if (!snapshot.sessions.length) throw new Error('PowerSchool returned an empty or unsupported schedule.');
    return snapshot;
  }

  private async fetchProgress(baseUrl: string, homeHtml: string, accountKey: string): Promise<ProgressSnapshot> {
    let attendanceHtml = '';
    try {
      const attendance = await this.platform.request({ baseUrl, path: '/guardian/attendance.html', method: 'GET' });
      if (attendance.status < 400 && !this.isSignInPage(attendance.text)) attendanceHtml = attendance.text;
    } catch {
      // Grade summaries remain useful when attendance history is temporarily unavailable.
    }
    const progress = { ...parsePowerSchoolProgress(homeHtml, attendanceHtml), accountKey };
    const cached = this.store.progress();
    if (!attendanceHtml && cached.accountKey === accountKey && cached.attendanceEvents.length) {
      return {
        ...progress,
        attendanceStart: cached.attendanceStart,
        attendanceEnd: cached.attendanceEnd,
        attendanceEvents: cached.attendanceEvents,
      };
    }
    return progress;
  }

  private normalizeUrl(value: string): string {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    return url.origin;
  }

  private requireSuccessful(response: { status: number; text: string }): void {
    if (response.status < 400) return;
    try {
      const value = JSON.parse(response.text) as { error?: unknown };
      if (typeof value.error === 'string' && value.error.trim()) throw new Error(value.error);
    } catch (error) {
      if (error instanceof Error && error.message !== 'Unexpected end of JSON input'
        && !(error instanceof SyntaxError)) throw error;
    }
    throw new Error(`PowerSchool returned HTTP ${response.status}.`);
  }

  private isSignInPage(html: string): boolean {
    return /name=["']account["']/i.test(html);
  }

  private requireSignedIn(html: string): void {
    if (this.isSignInPage(html)) throw new Error('Your PowerSchool session expired. Refresh Progress and try again.');
  }
}
