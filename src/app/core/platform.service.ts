import { Injectable } from '@angular/core';
import type { PlatformHttpResponse, PlatformInfo } from './models';

export interface NativeRequest {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  referrerPath?: string;
}

/** WLSAPlus is a macOS Electron app; every native capability goes through the preload bridge. */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  readonly info: PlatformInfo = {
    kind: 'electron',
    os: 'macos',
    supportsPowerSchool: true,
    supportsDesktopCards: false,
    supportsVpn: true,
    supportsScreenTranslation: false,
    supportsPhoneControl: false,
  };

  async request(options: NativeRequest): Promise<PlatformHttpResponse> {
    return this.bridge().powerschool.request(options);
  }

  async clearSession(baseUrl: string): Promise<void> {
    await this.bridge().powerschool.clearSession(baseUrl);
  }

  private bridge(): NonNullable<Window['wlsaplus']> {
    if (!window.wlsaplus) throw new Error('The WLSAPlus desktop bridge is unavailable.');
    return window.wlsaplus;
  }
}
