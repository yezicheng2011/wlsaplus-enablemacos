import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_SEEN_KEY, NoticeService } from './notice.service';
import type { AppNotice } from './models';

const NOTICE: AppNotice = { id: 'release-1.0.9-2026-10-08', title: 'WLSAPlus 1.0.9', content: '1.0.9 支持 Intel 和 Apple 芯片的 Mac。', type: 'info' };
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

function installBridge(get: () => Promise<AppNotice | null>) {
  const spy = vi.fn(get);
  (window as unknown as { wlsaplus: unknown }).wlsaplus = { notice: { get: spy } };
  return spy;
}

describe('NoticeService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete (window as unknown as { wlsaplus?: unknown }).wlsaplus;
    vi.unstubAllGlobals();
  });

  it('loads the official-site notice through the main-process bridge, never via renderer fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const get = installBridge(async () => NOTICE);
    const service = new NoticeService();
    await flush();
    expect(get).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.notice()).toEqual(NOTICE);
    expect(service.dismissed()).toBe(false);
  });

  it('remembers a dismissed notice by id', async () => {
    installBridge(async () => NOTICE);
    const service = new NoticeService();
    await flush();
    service.dismiss();
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe(NOTICE.id);
    const again = new NoticeService();
    await flush();
    expect(again.dismissed()).toBe(true);
  });

  it('shows nothing for a missing, malformed or failed notice', async () => {
    for (const get of [async () => null, async () => ({ ...NOTICE, title: '' }), async () => { throw new Error('offline'); }]) {
      installBridge(get as () => Promise<AppNotice | null>);
      const service = new NoticeService();
      await flush();
      expect(service.notice()).toBeNull();
    }
    delete (window as unknown as { wlsaplus?: unknown }).wlsaplus;
    const service = new NoticeService();
    await flush();
    expect(service.notice()).toBeNull();
  });
});
