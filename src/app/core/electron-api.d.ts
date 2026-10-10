import type {
  AppNotice,
  ClassReminderSyncPayload,
  PlatformHttpResponse,
  PowerSchoolCredentials,
  TranslationResult,
  UpdateStatus,
  VpnConnectionMode,
  VpnNode,
  VpnStatus,
  WeChatProbeResult,
} from './models';

declare global {
  interface Window {
    wlsaplus?: {
      system: {
        openExternal(url: string): Promise<void>;
      };
      credentials: {
        get(): Promise<PowerSchoolCredentials | null>;
        set(value: PowerSchoolCredentials): Promise<void>;
        clear(): Promise<void>;
      };
      powerschool: {
        request(options: {
          baseUrl: string;
          path: string;
          method: 'GET' | 'POST';
          body?: string;
          headers?: Record<string, string>;
          referrerPath?: string;
        }): Promise<PlatformHttpResponse>;
        clearSession(baseUrl: string): Promise<void>;
      };
      forum: {
        /** Forum entry URL: a one-time SSO login URL when available, else the plain forum URL. */
        ssoUrl(options?: { fallback?: boolean; theme?: 'light' | 'dark' }): Promise<string>;
        /** Last SSO outcome (code + time only), e.g. 'ok', 'already_logged_in', 'invalid_session'. */
        ssoStatus(): Promise<{ code: string; httpStatus: number | null; at: string } | null>;
        clearSession(): Promise<void>;
        /** Write the wlsaplus_theme / wlsaplus_embed cookies on the forum origins and set the guest's color scheme. */
        setTheme?(theme: 'light' | 'dark'): Promise<void>;
      };
      vpn: {
        status(): Promise<VpnStatus>;
        listNodes(sourceId?: string): Promise<VpnNode[]>;
        testLatency(nodes: VpnNode[]): Promise<VpnNode[]>;
        testWeChat(): Promise<WeChatProbeResult>;
        connect(mode: VpnConnectionMode, sourceId?: string, nodeName?: string): Promise<VpnStatus>;
        disconnect(): Promise<VpnStatus>;
        restartElevated(mode: VpnConnectionMode, sourceId?: string, nodeName?: string): Promise<VpnStatus>;
        onStatus(callback: (status: VpnStatus) => void): () => void;
      };
      updater: {
        status(): Promise<UpdateStatus>;
        check(): Promise<UpdateStatus>;
        install(): Promise<UpdateStatus>;
        setChannel(channel: 'stable' | 'beta'): Promise<UpdateStatus>;
        revealLog?(): Promise<boolean>;
        onStatus(callback: (status: UpdateStatus) => void): () => void;
      };
      translator: {
        translate(text: string, source: string, target: string): Promise<TranslationResult>;
      };
      /** In-app notice from the official site, fetched by the main process (null when unavailable). */
      notice: {
        get(): Promise<AppNotice | null>;
      };
      /** Class reminders are scheduled in the main process; the renderer only syncs schedule + switch. */
      reminders: {
        sync(payload: ClassReminderSyncPayload): Promise<boolean>;
      };
    };
  }
}

export {};
