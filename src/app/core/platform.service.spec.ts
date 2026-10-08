import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformService } from './platform.service';

type Bridge = { powerschool: { request: ReturnType<typeof vi.fn>; clearSession: ReturnType<typeof vi.fn> } };

function installBridge(): Bridge {
  const bridge: Bridge = {
    powerschool: {
      request: vi.fn().mockResolvedValue({ status: 200, url: 'https://ps.wlsash.org.cn/guardian/home.html', text: 'ok' }),
      clearSession: vi.fn().mockResolvedValue(undefined),
    },
  };
  (window as unknown as { wlsaplus: unknown }).wlsaplus = bridge;
  return bridge;
}

describe('PlatformService (desktop bridge)', () => {
  afterEach(() => { delete (window as unknown as { wlsaplus?: unknown }).wlsaplus; });

  it('always describes the macOS Electron app', () => {
    const info = new PlatformService().info;
    expect(info.kind).toBe('electron');
    expect(info.os).toBe('macos');
    expect(info.supportsPowerSchool).toBe(true);
    expect(info.supportsVpn).toBe(true);
  });

  it('sends PowerSchool requests through the preload bridge', async () => {
    const bridge = installBridge();
    const options = { baseUrl: 'https://ps.wlsash.org.cn', path: '/guardian/home.html', method: 'GET' as const, referrerPath: '/guardian/scores.html' };
    const result = await new PlatformService().request(options);
    expect(result.text).toBe('ok');
    expect(bridge.powerschool.request).toHaveBeenCalledWith(options);
  });

  it('clears the PowerSchool session through the bridge', async () => {
    const bridge = installBridge();
    await new PlatformService().clearSession('https://ps.wlsash.org.cn');
    expect(bridge.powerschool.clearSession).toHaveBeenCalledWith('https://ps.wlsash.org.cn');
  });

  it('refuses to fall back to any network gateway without the bridge', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const service = new PlatformService();
      await expect(service.request({ baseUrl: 'https://ps.wlsash.org.cn', path: '/guardian/home.html', method: 'GET' })).rejects.toThrow('bridge is unavailable');
      await expect(service.clearSession('https://ps.wlsash.org.cn')).rejects.toThrow('bridge is unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
