import { Injectable, computed, signal } from '@angular/core';
import type { UpdateChannel, UpdateStatus } from './models';

const UNSUPPORTED: UpdateStatus = {
  state: 'unsupported',
  message: 'Automatic updates need the installed macOS app.',
  currentVersion: '',
  version: null,
  percent: null,
  channel: 'stable',
};

/** Mirrors the main-process macOS self-updater (electron/mac-updater.cjs). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  readonly status = signal<UpdateStatus>(UNSUPPORTED);
  /** The floating banner only appears once an update is downloaded and verified (downloads run silently). */
  readonly actionable = computed(() => ['ready', 'installing'].includes(this.status().state));
  readonly supported = computed(() => this.status().state !== 'unsupported');
  readonly busy = computed(() => ['checking', 'downloading', 'installing'].includes(this.status().state));
  readonly channel = computed<UpdateChannel>(() => this.status().channel ?? 'stable');

  constructor() {
    if (!window.wlsaplus?.updater) return;
    void window.wlsaplus.updater.status().then((status) => this.status.set(status));
    window.wlsaplus.updater.onStatus((status) => this.status.set(status));
  }

  async check(): Promise<void> {
    if (window.wlsaplus?.updater) this.status.set(await window.wlsaplus.updater.check());
  }

  async download(): Promise<void> {
    if (window.wlsaplus?.updater) this.status.set(await window.wlsaplus.updater.download());
  }

  async install(): Promise<void> {
    if (window.wlsaplus?.updater) this.status.set(await window.wlsaplus.updater.install());
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (window.wlsaplus?.updater) this.status.set(await window.wlsaplus.updater.setChannel(channel));
  }
}
