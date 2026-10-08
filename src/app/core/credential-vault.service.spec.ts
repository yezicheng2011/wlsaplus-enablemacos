import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialVault } from './credential-vault.service';
import type { PowerSchoolCredentials } from './models';

const credentials: PowerSchoolCredentials = {
  schoolUrl: 'https://ps.wlsash.org.cn',
  username: 'student',
  password: 'saved-password',
};

describe('CredentialVault', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { delete (window as unknown as { wlsaplus?: unknown }).wlsaplus; });

  it('stores, reads and clears credentials only through the secure desktop bridge', async () => {
    let saved: PowerSchoolCredentials | null = null;
    const bridge = {
      get: vi.fn(async () => saved),
      set: vi.fn(async (value: PowerSchoolCredentials) => { saved = value; }),
      clear: vi.fn(async () => { saved = null; }),
    };
    (window as unknown as { wlsaplus: unknown }).wlsaplus = { credentials: bridge };
    const vault = new CredentialVault();

    await vault.set(credentials);
    expect(bridge.set).toHaveBeenCalledWith(credentials);
    expect(await vault.get()).toEqual(credentials);
    await vault.clear();
    expect(await vault.get()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('refuses to store the password in plain localStorage when the bridge is missing', async () => {
    const vault = new CredentialVault();
    await expect(vault.set(credentials)).rejects.toThrow('Secure credential storage is unavailable');
    await expect(vault.get()).rejects.toThrow('Secure credential storage is unavailable');
    await expect(vault.clear()).rejects.toThrow('Secure credential storage is unavailable');
    expect(localStorage.getItem('wlsaplus:credentials')).toBeNull();
  });
});
