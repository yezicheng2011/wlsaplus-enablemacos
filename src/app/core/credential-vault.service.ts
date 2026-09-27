import { Injectable } from '@angular/core';
import type { PowerSchoolCredentials } from './models';

const KEY = 'wlsaplus:credentials';

@Injectable({ providedIn: 'root' })
export class CredentialVault {
  async get(): Promise<PowerSchoolCredentials | null> {
    if (window.wlsaplus) return window.wlsaplus.credentials.get();
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as PowerSchoolCredentials) : null;
    } catch {
      return null;
    }
  }

  async set(value: PowerSchoolCredentials): Promise<void> {
    if (window.wlsaplus) return window.wlsaplus.credentials.set(value);
    localStorage.setItem(KEY, JSON.stringify(value));
  }

  async clear(): Promise<void> {
    if (window.wlsaplus) return window.wlsaplus.credentials.clear();
    localStorage.removeItem(KEY);
  }
}
