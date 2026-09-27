import { Injectable, inject, signal } from '@angular/core';
import { PlatformService } from './platform.service';
import type { VpnConnectionMode, VpnNode, VpnStatus, WeChatProbeResult } from './models';
import { VPN_SOURCES, vpnSource } from './vpn-sources';

const IDLE: VpnStatus = { state: 'idle', message: 'Ready', connectedAt: null, mode: 'unavailable' };
const NODE_KEY = 'wlsaplus:vpn-node';

@Injectable({ providedIn: 'root' })
export class VpnService {
  private readonly platform = inject(PlatformService);
  readonly status = signal<VpnStatus>(this.platform.info.supportsVpn ? IDLE : { ...IDLE, state: 'unavailable', message: 'Available in the desktop app.' });
  readonly mode = signal<VpnConnectionMode>('full-tunnel');
  readonly sources = VPN_SOURCES;
  readonly sourceId = signal<string>(this.readSource());
  readonly nodes = signal<VpnNode[]>([]);
  readonly selectedNodeId = signal<string>(this.readNode());
  readonly nodesLoading = signal(false);
  readonly latencyTesting = signal(false);
  readonly wechatTesting = signal(false);
  readonly wechatResult = signal<WeChatProbeResult | null>(null);

  constructor() {
    if (window.wlsaplus) {
      void window.wlsaplus.vpn.status().then((status) => this.applyStatus(status));
      window.wlsaplus.vpn.onStatus((status) => this.applyStatus(status));
      if (this.platform.info.supportsVpn) void this.refreshNodes();
    }
  }

  async refreshNodes(): Promise<void> {
    if (!window.wlsaplus?.vpn.listNodes) return;
    this.nodesLoading.set(true);
    try {
      const listed = await window.wlsaplus.vpn.listNodes(this.sourceId());
      this.nodes.set(listed);
      if (!listed.some((node) => node.id === this.selectedNodeId()) && listed[0]) {
        this.setNode(listed[0].id);
      }
    } catch (error) {
      this.status.set({
        ...this.status(),
        state: this.status().state === 'connected' ? 'connected' : 'idle',
        message: error instanceof Error ? error.message : 'Could not load VPN nodes.',
      });
    } finally {
      this.nodesLoading.set(false);
    }
  }

  async testWeChat(): Promise<void> {
    if (!window.wlsaplus?.vpn.testWeChat) return;
    this.wechatTesting.set(true);
    try {
      this.wechatResult.set(await window.wlsaplus.vpn.testWeChat());
    } catch (error) {
      this.wechatResult.set({
        reachable: false,
        latencyMs: null,
        viaVpn: this.status().state === 'connected',
        url: 'https://weixin.qq.com/',
        status: 0,
        message: error instanceof Error ? error.message : 'WeChat probe failed.',
      });
    } finally {
      this.wechatTesting.set(false);
    }
  }

  async testLatency(): Promise<void> {
    if (!window.wlsaplus?.vpn.testLatency || !this.nodes().length) return;
    this.latencyTesting.set(true);
    try {
      const measured = await window.wlsaplus.vpn.testLatency(this.nodes());
      this.nodes.set(measured);
    } finally {
      this.latencyTesting.set(false);
    }
  }

  async connect(): Promise<void> {
    if (!window.wlsaplus) return;
    const nodeName = this.selectedNodeId();
    this.status.set({
      ...this.status(),
      state: 'connecting',
      message: nodeName ? `Preparing “${nodeName}”…` : `Connecting to ${vpnSource(this.sourceId()).name}...`,
      mode: this.mode(),
      sourceId: this.sourceId(),
      nodeName: nodeName || undefined,
      requiresElevation: false,
    });
    try {
      this.applyStatus(await window.wlsaplus.vpn.connect(this.mode(), this.sourceId(), nodeName));
    } catch {
      // Prefer main-process status: pre-auth / waiting-approval must not become a scary error banner.
      try {
        const current = await window.wlsaplus.vpn.status();
        if (current.state === 'connecting' || current.state === 'connected' || current.state === 'idle') {
          this.applyStatus(current);
          return;
        }
        this.applyStatus(current);
      } catch {
        this.status.set({
          ...this.status(),
          state: 'idle',
          message: 'Waiting for macOS administrator approval…',
          requiresElevation: true,
        });
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!window.wlsaplus) return;
    this.status.set({ ...this.status(), state: 'disconnecting', message: 'Disconnecting...' });
    this.applyStatus(await window.wlsaplus.vpn.disconnect());
  }

  setSource(sourceId: string): void {
    const source = vpnSource(sourceId);
    this.sourceId.set(source.id);
    localStorage.setItem('wlsaplus:vpn-source', source.id);
    void this.refreshNodes();
  }

  setNode(nodeId: string): void {
    this.selectedNodeId.set(nodeId);
    localStorage.setItem(NODE_KEY, nodeId);
  }

  async restartElevated(): Promise<void> {
    if (!window.wlsaplus) return;
    const nodeName = this.selectedNodeId();
    this.status.set({
      ...this.status(),
      state: 'connecting',
      message: 'Waiting for macOS administrator approval…',
      mode: this.mode(),
      nodeName: nodeName || undefined,
      requiresElevation: true,
    });
    try {
      this.applyStatus(await window.wlsaplus.vpn.restartElevated(this.mode(), this.sourceId(), nodeName));
    } catch {
      try {
        const current = await window.wlsaplus.vpn.status();
        this.applyStatus(current);
      } catch {
        this.status.set({
          ...this.status(),
          state: 'idle',
          message: 'Administrator approval was cancelled. Tap Connect to try again.',
          requiresElevation: true,
        });
      }
    }
  }

  private applyStatus(status: VpnStatus): void {
    this.status.set(status);
    if (status.nodeName) this.selectedNodeId.set(status.nodeName);
    if (status.state !== 'idle' && status.mode === 'full-tunnel') this.mode.set(status.mode);
  }

  private readSource(): string {
    return vpnSource(localStorage.getItem('wlsaplus:vpn-source') || 'relay').id;
  }

  private readNode(): string {
    return localStorage.getItem(NODE_KEY) || '';
  }
}
