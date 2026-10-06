const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wlsaplus', {
  platform: { os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' },
  system: {
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  },
  credentials: {
    get: () => ipcRenderer.invoke('credentials:get'),
    set: (value) => ipcRenderer.invoke('credentials:set', value),
    clear: () => ipcRenderer.invoke('credentials:clear'),
  },
  powerschool: {
    request: (options) => ipcRenderer.invoke('powerschool:request', options),
    clearSession: (baseUrl) => ipcRenderer.invoke('powerschool:clear-session', baseUrl),
  },
  forum: {
    ssoUrl: (options) => ipcRenderer.invoke('forum:sso-url', options),
    ssoStatus: () => ipcRenderer.invoke('forum:sso-status'),
    clearSession: () => ipcRenderer.invoke('forum:clear-session'),
  },
  vpn: {
    status: () => ipcRenderer.invoke('vpn:status'),
    listNodes: (sourceId) => ipcRenderer.invoke('vpn:list-nodes', sourceId),
    testLatency: (nodes) => ipcRenderer.invoke('vpn:test-latency', nodes),
    testWeChat: () => ipcRenderer.invoke('vpn:test-wechat'),
    connect: (mode, sourceId, nodeName) => ipcRenderer.invoke('vpn:connect', mode, sourceId, nodeName),
    disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
    restartElevated: (mode, sourceId, nodeName) => ipcRenderer.invoke('vpn:restart-elevated', mode, sourceId, nodeName),
    onStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('vpn:status', handler);
      return () => ipcRenderer.removeListener('vpn:status', handler);
    },
  },
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
  },
  translator: {
    translate: (text, source, target) => ipcRenderer.invoke('translator:translate', text, source, target),
    captureRegion: () => Promise.reject(new Error('Screen translation is not available on macOS.')),
  },
  notifications: {
    showClassReminder: (options) => ipcRenderer.invoke('notifications:show-class-reminder', options),
  },
});
