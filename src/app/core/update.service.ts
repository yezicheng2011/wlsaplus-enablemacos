import { Injectable, computed, signal } from '@angular/core';
import type { UpdateChannel, UpdateState, UpdateStatus } from './models';

const UNSUPPORTED: UpdateStatus = {
  state: 'unsupported',
  message: 'Automatic updates need the installed macOS app.',
  currentVersion: '',
  version: null,
  percent: null,
  channel: 'stable',
};

/** Shown when a status arrives without a message, so the Updates row never goes blank. */
const FALLBACK_MESSAGES: Record<UpdateState, string> = {
  idle: 'Ready to check for updates.',
  checking: 'Checking for updates...',
  available: 'An update is available.',
  downloading: 'Downloading the update...',
  ready: 'The update is ready. Restart to update.',
  installing: 'Installing the update...',
  'up-to-date': 'WLSAPlus is up to date.',
  error: 'The update check failed. Try again later.',
  unsupported: 'Automatic updates need the installed macOS app.',
};

const STATES = new Set(Object.keys(FALLBACK_MESSAGES));

/** Mirrors the main-process macOS self-updater (electron/mac-updater.cjs). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  readonly status = signal<UpdateStatus>(UNSUPPORTED);
  /** The floating banner only appears once an update is downloaded and verified (downloads run silently). */
  readonly actionable = computed(() => ['ready', 'installing'].includes(this.status().state));
  readonly supported = computed(() => this.status().state !== 'unsupported');
  readonly busy = computed(() => ['checking', 'downloading', 'installing'].includes(this.status().state));
  readonly channel = computed<UpdateChannel>(() => this.status().channel ?? 'stable');
  readonly message = computed(() => this.status().message?.trim() || FALLBACK_MESSAGES[this.status().state] || FALLBACK_MESSAGES.error);

  constructor() {
    if (!window.wlsaplus?.updater) return;
    void window.wlsaplus.updater.status().then((status) => this.apply(status), () => {});
    window.wlsaplus.updater.onStatus((status) => this.apply(status));
  }

  /**
   * Status updates arrive both as events and as IPC replies; a reply can be older than the latest event, so
   * statuses carry an increasing `seq` and older ones are ignored. Malformed values are never shown.
   */
  apply(status: UpdateStatus | null | undefined): void {
    if (!status || typeof status !== 'object' || !STATES.has(status.state)) return;
    const current = this.status();
    if (typeof status.seq === 'number' && typeof current.seq === 'number' && status.seq < current.seq) return;
    this.status.set(status);
  }

  private fail(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.status.set({ ...this.status(), state: 'error', message: `${action}: ${detail}`.slice(0, 300), percent: null });
  }

  async check(): Promise<void> {
    if (!window.wlsaplus?.updater) return;
    try { this.apply(await window.wlsaplus.updater.check()); } catch (error) { this.fail('Could not check for updates', error); }
  }

  async download(): Promise<void> {
    if (!window.wlsaplus?.updater) return;
    try { this.apply(await window.wlsaplus.updater.download()); } catch (error) { this.fail('Could not download the update', error); }
  }

  async install(): Promise<void> {
    if (!window.wlsaplus?.updater) return;
    try { this.apply(await window.wlsaplus.updater.install()); } catch (error) { this.fail('Could not install the update', error); }
  }

  /** Shows updates/update.log in Finder (for bug reports). */
  async revealLog(): Promise<boolean> {
    try { return (await window.wlsaplus?.updater?.revealLog?.()) ?? false; } catch { return false; }
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (!window.wlsaplus?.updater) return;
    try { this.apply(await window.wlsaplus.updater.setChannel(channel)); } catch (error) { this.fail('Could not change the update channel', error); }
  }
}
