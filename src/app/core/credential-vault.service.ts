import { Injectable } from '@angular/core';
import type { PowerSchoolCredentials } from './models';

/**
 * PowerSchool credentials live only in the main process (Electron safeStorage / macOS Keychain).
 * Without the desktop bridge nothing is stored — never fall back to plain localStorage.
 */
@Injectable({ providedIn: 'root' })
export class CredentialVault {
  async get(): Promise<PowerSchoolCredentials | null> {
    return this.bridge().get();
  }

  async set(value: PowerSchoolCredentials): Promise<void> {
    return this.bridge().set(value);
  }

  async clear(): Promise<void> {
    return this.bridge().clear();
  }

  private bridge(): NonNullable<Window['wlsaplus']>['credentials'] {
    const credentials = window.wlsaplus?.credentials;
    if (!credentials) throw new Error('Secure credential storage is unavailable outside the WLSAPlus desktop app.');
    return credentials;
  }
}
