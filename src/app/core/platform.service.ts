import { Injectable } from '@angular/core';
import type { PlatformHttpResponse, PlatformInfo } from './models';

export const WEB_POWERSCHOOL_ORIGIN = 'https://ps.wlsash.org.cn';
export const WEB_POWERSCHOOL_GATEWAY = 'https://apiwlsaplus.02studio.xyz';
export const WEB_POWERSCHOOL_REFERRER_HEADER = 'x-wlsaplus-upstream-referrer';

export interface NativeRequest {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  referrerPath?: string;
}

@Injectable({ providedIn: 'root' })
export class PlatformService {
  readonly info: PlatformInfo = this.detect();

  async request(options: NativeRequest): Promise<PlatformHttpResponse> {
    if (window.wlsaplus) return window.wlsaplus.powerschool.request(options);

    const url = this.webGatewayUrl(options);
    const headers = { ...(options.headers ?? {}) };
    if (options.referrerPath) {
      const referrer = new URL(options.referrerPath, `${WEB_POWERSCHOOL_ORIGIN}/`);
      if (referrer.origin !== WEB_POWERSCHOOL_ORIGIN) {
        throw new Error('The web version cannot send a cross-origin PowerSchool referrer.');
      }
      headers[WEB_POWERSCHOOL_REFERRER_HEADER] = `${referrer.pathname}${referrer.search}`;
    }
    const response = await this.fetchWithTimeout(url, {
      method: options.method,
      headers,
      body: options.body,
      credentials: 'include',
      redirect: 'follow',
    }, 20_000);
    return { status: response.status, url: response.url, text: await response.text() };
  }

  async clearSession(baseUrl: string): Promise<void> {
    if (window.wlsaplus) {
      await window.wlsaplus.powerschool.clearSession(baseUrl);
      return;
    }

    this.assertWebPowerSchoolOrigin(baseUrl);
    const response = await this.fetchWithTimeout(`${WEB_POWERSCHOOL_GATEWAY}/api/powerschool/logout`, {
      method: 'POST',
      credentials: 'include',
    }, 15_000);
    if (!response.ok) throw new Error(await this.gatewayError(response));
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('PowerSchool request timed out. Check your network and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private detect(): PlatformInfo {
    if (window.wlsaplus) {
      const os = window.wlsaplus.platform.os;
      return {
        kind: 'electron',
        os,
        supportsPowerSchool: true,
        supportsDesktopCards: false,
        supportsVpn: os === 'macos',
        supportsScreenTranslation: false,
        supportsPhoneControl: false,
      };
    }
    return {
      kind: 'web',
      os: 'web',
      supportsPowerSchool: true,
      supportsDesktopCards: false,
      supportsVpn: false,
      supportsScreenTranslation: false,
      supportsPhoneControl: false,
    };
  }

  private webGatewayUrl(options: NativeRequest): string {
    this.assertWebPowerSchoolOrigin(options.baseUrl);
    const upstreamUrl = new URL(options.path, `${WEB_POWERSCHOOL_ORIGIN}/`);
    if (upstreamUrl.origin !== WEB_POWERSCHOOL_ORIGIN) {
      throw new Error('The web version cannot request a different PowerSchool server.');
    }

    const gatewayUrl = new URL(`/api/powerschool${upstreamUrl.pathname}`, WEB_POWERSCHOOL_GATEWAY);
    gatewayUrl.search = upstreamUrl.search;
    return gatewayUrl.toString();
  }

  private assertWebPowerSchoolOrigin(baseUrl: string): void {
    let origin: string;
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      throw new Error('Enter a valid PowerSchool address.');
    }
    if (origin !== WEB_POWERSCHOOL_ORIGIN) {
      throw new Error(`The web version supports only ${WEB_POWERSCHOOL_ORIGIN}.`);
    }
  }

  private async gatewayError(response: Response): Promise<string> {
    try {
      const value = await response.json() as { error?: unknown };
      if (typeof value.error === 'string' && value.error.trim()) return value.error;
    } catch {
      // Fall back to the HTTP status below.
    }
    return `PowerSchool gateway returned HTTP ${response.status}.`;
  }
}
