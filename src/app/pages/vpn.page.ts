import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { PlatformService } from '../core/platform.service';
import { VpnService } from '../core/vpn.service';

@Component({
  selector: 'app-vpn-page',
  imports: [DatePipe, FormsModule, RouterLink, MatButtonModule, MatProgressSpinnerModule, MatSelectModule],
  template: `
    <div class="page tool-page">
      <header class="page-header"><a class="back icon-button" routerLink="/tools" aria-label="Back to tools"><span class="material-symbols-rounded">arrow_back</span></a><div><h1 class="page-title">VPN</h1><span>WLSAPlus relay</span></div><span class="spacer"></span><a mat-stroked-button class="guide-link" [href]="guideUrl" target="_blank" rel="noopener noreferrer" (click)="openGuide($event)"><span class="material-symbols-rounded">help</span>How to use</a></header>

      @if (platform.info.supportsVpn) {
        <section class="node-panel surface">
          <div class="node-heading">
            <div><strong>Node</strong><span>Choose a relay node before connecting.</span></div>
            <div class="node-actions">
              <button mat-stroked-button type="button" (click)="vpn.refreshNodes()" [disabled]="vpn.nodesLoading() || busy()">Refresh</button>
              <button mat-stroked-button type="button" (click)="vpn.testLatency()" [disabled]="vpn.latencyTesting() || !vpn.nodes().length || busy()">{{ vpn.latencyTesting() ? 'Testing…' : 'Test latency' }}</button>
            </div>
          </div>
          @if (vpn.nodesLoading() && !vpn.nodes().length) {
            <div class="node-loading"><mat-spinner diameter="28"></mat-spinner><span>Loading nodes…</span></div>
          } @else if (!vpn.nodes().length) {
            <p class="node-empty">No nodes yet. Tap Refresh after you are online.</p>
          } @else {
            <mat-select [value]="vpn.selectedNodeId()" (selectionChange)="vpn.setNode($event.value)" [disabled]="busy()" aria-label="VPN node">
              @for (node of vpn.nodes(); track node.id) {
                <mat-option [value]="node.id">{{ nodeLabel(node) }}</mat-option>
              }
            </mat-select>
            <div class="node-list" role="list">
              @for (node of vpn.nodes(); track node.id) {
                <button type="button" class="node-row" role="listitem" [class.selected]="vpn.selectedNodeId() === node.id" (click)="vpn.setNode(node.id)" [disabled]="busy()">
                  <span class="node-name">{{ node.name }}</span>
                  <span class="node-meta">{{ node.type }}@if (node.latencyMs != null) { · {{ node.latencyMs }} ms } @else if (vpn.latencyTesting()) { · … }</span>
                </button>
              }
            </div>
          }
        </section>
      }

      <section class="vpn-panel surface" [class.connected]="status().state === 'connected'" [class.pending]="status().state === 'connecting' && status().requiresElevation">
        <div class="status-mark"><span class="material-symbols-rounded">{{ statusIcon() }}</span></div>
        <div class="status-copy"><span>{{ statusLabel() }}</span><h2>{{ status().message }}</h2>@if (status().connectedAt) { <time>Connected {{ status().connectedAt | date:'HH:mm' }}</time> }</div>
        @if (busy()) { <mat-spinner diameter="42"></mat-spinner> }
        @else if (status().state === 'connected') { <button mat-stroked-button (click)="vpn.disconnect()">Disconnect</button> }
        @else if (status().requiresElevation && status().state !== 'error') { <button mat-flat-button (click)="vpn.restartElevated()">Approve & connect</button> }
        @else { <button mat-flat-button (click)="vpn.connect()" [disabled]="status().state === 'unavailable' || (platform.info.supportsVpn && !vpn.selectedNodeId())">Connect</button> }
      </section>
      <div class="facts"><span><span class="material-symbols-rounded">shield</span>Encrypted connection</span><span><span class="material-symbols-rounded">public</span>Selectable nodes</span><span><span class="material-symbols-rounded">speed</span>Latency test</span></div>
      @if (platform.info.kind === 'web') { <p class="platform-note">Install the macOS app to use VPN.</p> }
    </div>
  `,
  styles: `
    .tool-page { max-width: 820px; } .page-header { justify-content: flex-start; } .page-header > div { min-width: 0; } .page-header > div span { color: var(--app-muted); font-size: 13px; } .back { margin-left: -10px; color: var(--app-text); text-decoration: none; } .guide-link { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; } .guide-link .material-symbols-rounded { font-size: 18px; }
    .node-panel { padding: 18px; margin-bottom: 14px; display: grid; gap: 14px; }
    .node-heading { display: flex; justify-content: space-between; gap: 12px; align-items: start; flex-wrap: wrap; } .node-heading strong { display: block; } .node-heading span { color: var(--app-muted); font-size: 13px; } .node-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .node-loading { display: flex; align-items: center; gap: 12px; color: var(--app-muted); } .node-empty { margin: 0; color: var(--app-muted); font-size: 13px; }
    .node-list { max-height: 240px; overflow: auto; border: 1px solid var(--app-border); border-radius: 8px; }
    .node-row { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 12px 14px; border: 0; border-bottom: 1px solid var(--app-border); background: transparent; color: var(--app-text); text-align: left; cursor: pointer; } .node-row:last-child { border-bottom: 0; } .node-row.selected { background: var(--app-accent-soft); } .node-name { font-size: 14px; } .node-meta { color: var(--app-muted); font-size: 12px; white-space: nowrap; }
    .vpn-panel { min-height: 220px; padding: 32px; display: grid; grid-template-columns: 64px minmax(0,1fr) auto; align-items: center; gap: 24px; } .status-mark { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 8px; background: var(--app-surface-raised); color: var(--app-muted); } .status-mark span { font-size: 34px; } .connected .status-mark { background: color-mix(in srgb, var(--app-success) 18%, var(--app-surface)); color: var(--app-success); } .pending .status-mark { color: var(--app-accent); }
    .status-copy { min-width: 0; } .status-copy > span { color: var(--app-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; } h2 { margin: 7px 0 6px; font-size: 25px; line-height: 1.2; } time { color: var(--app-muted); font-size: 13px; } button { min-width: 116px; height: 46px; }
    .facts { display: grid; grid-template-columns: repeat(3,1fr); margin-top: 14px; color: var(--app-muted); font-size: 12px; } .facts > span { min-height: 46px; display: flex; align-items: center; justify-content: center; gap: 7px; border-right: 1px solid var(--app-border); } .facts > span:last-child { border: 0; } .facts .material-symbols-rounded { font-size: 18px; } .platform-note { margin: 20px 0 0; color: var(--app-muted); font-size: 13px; text-align: center; }
    @media (max-width: 600px) { .vpn-panel { min-height: 280px; padding: 25px 20px; grid-template-columns: 1fr; justify-items: center; gap: 18px; text-align: center; } .facts { grid-template-columns: 1fr; } .facts > span { border-right: 0; border-bottom: 1px solid var(--app-border); } }
  `,
})
export class VpnPage {
  readonly vpn = inject(VpnService); readonly platform = inject(PlatformService); readonly status = this.vpn.status;
  readonly guideUrl = 'https://wlsaplus.02studio.xyz/blog/use-wechat-on-restricted-networks/';
  readonly busy = computed(() => this.status().state === 'connecting' || this.status().state === 'disconnecting');
  readonly statusLabel = computed(() => ({
    connected: 'Connected',
    connecting: this.status().requiresElevation ? 'Waiting for approval' : 'Connecting',
    disconnecting: 'Disconnecting',
    delegated: 'Opened',
    error: 'Connection error',
    unavailable: 'Unavailable',
    idle: 'Disconnected',
  })[this.status().state]);
  readonly statusIcon = computed(() => this.status().state === 'connected' ? 'verified_user' : this.status().state === 'error' ? 'error' : this.status().requiresElevation ? 'admin_panel_settings' : 'vpn_lock');
  nodeLabel(node: { name: string; type: string; latencyMs?: number | null }): string {
    return node.latencyMs != null ? `${node.name} (${node.latencyMs} ms)` : `${node.name} · ${node.type}`;
  }
  openGuide(event: MouseEvent): void {
    if (!window.wlsaplus) return;
    event.preventDefault();
    void window.wlsaplus.system.openExternal(this.guideUrl);
  }
}
