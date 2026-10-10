import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VpnNode, VpnStatus } from './models';
import { VpnService } from './vpn.service';

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const idle: VpnStatus = { state: 'idle', message: 'Ready', connectedAt: null, mode: 'full-tunnel' };

describe('VpnService subscription failures', () => {
  afterEach(() => {
    delete (window as unknown as { wlsaplus?: unknown }).wlsaplus;
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it.each(['connecting', 'disconnecting'] as const)('keeps the native %s state when an older node request fails', async (state) => {
    let rejectNodes!: (error: Error) => void;
    let pushStatus!: (status: VpnStatus) => void;
    const nodes = new Promise<VpnNode[]>((_resolve, reject) => { rejectNodes = reject; });
    (window as unknown as { wlsaplus: unknown }).wlsaplus = {
      vpn: {
        status: vi.fn(async () => idle),
        listNodes: vi.fn(() => nodes),
        onStatus: (callback: (status: VpnStatus) => void) => { pushStatus = callback; },
      },
    };
    const service = TestBed.inject(VpnService);
    await flush();
    const pending: VpnStatus = { ...idle, state, message: state === 'connecting' ? 'Starting the VPN core…' : 'Disconnecting...' };
    pushStatus(pending);
    rejectNodes(new Error('Subscription unavailable'));
    await flush();

    expect(service.status()).toEqual(pending);
    expect(service.nodesLoading()).toBe(false);
  });

  it.each(['connected', 'error', 'idle'] as const)('reports the node error without changing the native %s state', async (state) => {
    const current: VpnStatus = { ...idle, state, message: 'Native status', connectedAt: state === 'connected' ? '2026-10-10T02:00:00Z' : null };
    (window as unknown as { wlsaplus: unknown }).wlsaplus = {
      vpn: {
        status: vi.fn(async () => current),
        listNodes: vi.fn(async () => { throw new Error('Subscription unavailable'); }),
        onStatus: vi.fn(),
      },
    };
    const service = TestBed.inject(VpnService);
    await flush();

    expect(service.status()).toEqual({ ...current, message: 'Subscription unavailable' });
    expect(service.nodesLoading()).toBe(false);
  });
});
