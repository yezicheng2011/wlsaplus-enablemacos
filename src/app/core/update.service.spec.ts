import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UpdateService } from './update.service';
import type { UpdateStatus } from './models';

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const status = (patch: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', message: '', currentVersion: '1.1.0', version: null, percent: null, channel: 'stable', ...patch });

function installBridge(initial: UpdateStatus) {
  let listener: ((s: UpdateStatus) => void) | null = null;
  const bridge = {
    status: vi.fn(async () => initial),
    check: vi.fn(async () => status({ state: 'checking' })),
    download: vi.fn(async () => status({ state: 'checking' })),
    install: vi.fn(async () => status({ state: 'installing' })),
    setChannel: vi.fn(async (channel: 'stable' | 'beta') => status({ channel })),
    onStatus: vi.fn((callback: (s: UpdateStatus) => void) => { listener = callback; return () => { listener = null; }; }),
  };
  (window as unknown as { wlsaplus: unknown }).wlsaplus = { updater: bridge };
  return { bridge, push: (s: UpdateStatus) => listener?.(s) };
}

describe('UpdateService', () => {
  afterEach(() => { delete (window as unknown as { wlsaplus?: unknown }).wlsaplus; });

  it('is unsupported without the desktop bridge', () => {
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    expect(service.supported()).toBe(false);
    expect(service.actionable()).toBe(false);
  });

  it('shows the banner only once an update is ready, not while it downloads in the background', async () => {
    const { push } = installBridge(status({ state: 'downloading', percent: 40 }));
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    await flush();
    expect(service.status().state).toBe('downloading');
    expect(service.busy()).toBe(true);
    expect(service.actionable()).toBe(false);
    push(status({ state: 'ready', version: '1.1.1' }));
    expect(service.actionable()).toBe(true);
  });

  it('switches the test channel and installs through the bridge', async () => {
    const { bridge } = installBridge(status({}));
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    await flush();
    await service.setChannel('beta');
    expect(bridge.setChannel).toHaveBeenCalledWith('beta');
    expect(service.channel()).toBe('beta');
    await service.install();
    expect(bridge.install).toHaveBeenCalledOnce();
    expect(service.status().state).toBe('installing');
  });

  it('never lets an older IPC reply overwrite a newer status event', async () => {
    const { bridge, push } = installBridge(status({ state: 'idle', message: 'Ready to check for updates.', seq: 1 }));
    let reply: (s: UpdateStatus) => void = () => {};
    bridge.check.mockImplementationOnce(() => new Promise<UpdateStatus>((resolve) => { reply = resolve; }));
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    await flush();
    const pending = service.check();
    push(status({ state: 'checking', message: 'Checking for updates...', seq: 2 }));
    push(status({ state: 'error', message: 'Could not check for updates.', seq: 4 }));
    reply(status({ state: 'checking', message: 'Checking for updates...', seq: 2 }));
    await pending;
    expect(service.status().state).toBe('error');
    expect(service.message()).toBe('Could not check for updates.');
  });

  it('shows an error instead of going blank when the check call fails', async () => {
    const { bridge } = installBridge(status({ state: 'idle', message: 'Ready to check for updates.' }));
    bridge.check.mockRejectedValueOnce(new Error('No handler registered for updater:check'));
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    await flush();
    await service.check();
    expect(service.status().state).toBe('error');
    expect(service.busy()).toBe(false);
    expect(service.message()).toContain('Could not check for updates');
  });

  it('ignores malformed statuses and falls back to a message for every state', async () => {
    const { push } = installBridge(status({ state: 'idle', message: 'Ready to check for updates.' }));
    const service = TestBed.runInInjectionContext(() => new UpdateService());
    await flush();
    push(undefined as unknown as UpdateStatus);
    push({} as UpdateStatus);
    push('oops' as unknown as UpdateStatus);
    expect(service.status().state).toBe('idle');
    for (const state of ['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'up-to-date', 'error'] as const) {
      push(status({ state, message: '' }));
      expect(service.message().length).toBeGreaterThan(0);
    }
  });
});
