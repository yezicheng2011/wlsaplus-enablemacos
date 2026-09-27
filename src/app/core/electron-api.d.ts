import type {
  PlatformHttpResponse,
  PowerSchoolCredentials,
  TranslationResult,
  UpdateStatus,
  VpnConnectionMode,
  VpnNode,
  VpnStatus,
} from './models';

declare global {
  interface Window {
    wlsaplus?: {
      platform: { os: 'windows' | 'macos' | 'linux' };
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
      vpn: {
        status(): Promise<VpnStatus>;
        listNodes(sourceId?: string): Promise<VpnNode[]>;
        testLatency(nodes: VpnNode[]): Promise<VpnNode[]>;
        connect(mode: VpnConnectionMode, sourceId?: string, nodeName?: string): Promise<VpnStatus>;
        disconnect(): Promise<VpnStatus>;
        restartElevated(mode: VpnConnectionMode, sourceId?: string, nodeName?: string): Promise<VpnStatus>;
        onStatus(callback: (status: VpnStatus) => void): () => void;
      };
      updater: {
        status(): Promise<UpdateStatus>;
        check(): Promise<UpdateStatus>;
        download(): Promise<UpdateStatus>;
        install(): Promise<UpdateStatus>;
        onStatus(callback: (status: UpdateStatus) => void): () => void;
      };
      translator: {
        translate(text: string, source: string, target: string): Promise<TranslationResult>;
        captureRegion(): Promise<string | null>;
      };
      notifications: {
        showClassReminder(options: { title: string; body: string; sessionId: string }): Promise<boolean>;
      };
    };
  }
}

export {};
