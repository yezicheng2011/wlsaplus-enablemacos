import { Injectable } from '@angular/core';
import type { PowerSchoolCredentials } from './models';

/**
 * PowerSchool credentials live only in the main process (Electron safeStorage / macOS Keychain).
 * Without the desktop bridge nothing is stored — never fall back to plain localStorage.
 */
@Injectable({ providedIn: 'root' })
export class CredentialVault {
  // IPC handlers may complete out of order. In particular, a clear must finish
  // after any credential write that was already started.
  private pending: Promise<unknown> = Promise.resolve();

  async get(): Promise<PowerSchoolCredentials | null> {
    return this.enqueue(() => this.bridge().get());
  }

  async set(value: PowerSchoolCredentials): Promise<void> {
    return this.enqueue(() => this.bridge().set(value));
  }

  async clear(): Promise<void> {
    return this.enqueue(() => this.bridge().clear());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private bridge(): NonNullable<Window['wlsaplus']>['credentials'] {
    const credentials = window.wlsaplus?.credentials;
    if (!credentials) throw new Error('Secure credential storage is unavailable outside the WLSAPlus desktop app.');
    return credentials;
  }
}
