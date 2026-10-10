const { app, BrowserWindow, Notification, ipcMain, net, powerMonitor, safeStorage, session, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const nodeHttps = require('node:https');
const nodeNet = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { createMacUpdater, validMarkerPath, argValue } = require('./mac-updater.cjs');
const { validateExternalHelpUrl } = require('./external-links.cjs');
const {
  FORUM_PARTITION,
  isForumUrl,
  isWebUrl,
  forumBaseUrl,
  forumSsoNext,
  isForumWebviewAttachAllowed,
  hardenForumWebPreferences,
} = require('./forum-config.cjs');
const { resolveForumEntryUrl, getLastForumSsoStatus } = require('./forum-sso.cjs');
const { applyForumTheme, emulateForumColorScheme, validateForumTheme } = require('./forum-theme.cjs');
const { getVpnSource, subscriptionUrl } = require('./vpn-sources.cjs');
const { createClassReminderScheduler } = require('./class-reminders.cjs');
const { fetchAppNotice } = require('./app-notice.cjs');
const {
  MAC_CLASH_CONTROLLER_PORT,
  newControllerSecret,
  applyControllerSettings,
  listClashProxyNodes,
  applySelectedClashNode,
  controllerRequest,
  isCoreUp,
  waitForCore,
  groupsContainingNode,
  enforceSelectedNode,
  connectedStatusFor,
  tailLines,
  createWatchdog,
  isOsascriptAuthCancelled,
  appleScriptElevatedRun,
  stopMacClashProcess,
} = require('./mac-clash-controller.cjs');
const yaml = require('js-yaml');

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

const execFileAsync = promisify(execFile);

let mainWindow;
let isQuitting = false;
const isAutostart = process.argv.includes('--autostart');
const prepareUpdateMode = process.argv.includes('--prepare-update');
const vpnAutoConnectMode = process.argv.includes('--vpn-autoconnect=full-tunnel') ? 'full-tunnel' : null;
const vpnAutoConnectSource = getVpnSource((process.argv.find((argument) => argument.startsWith('--vpn-source=')) || '').slice('--vpn-source='.length)).id;
let vpnDisconnecting = false;
let vpnStatus = { state: 'idle', message: 'Ready', connectedAt: null, mode: 'full-tunnel' };
// macOS elevated mihomo core: per-connect controller secret (main memory only), watchdog, attempt id.
let macCoreController = null;
let macCoreWatchdog = null;
let macConnectAttempt = 0;
let macConnectOperation = null;
let vpnDisconnectOperation = null;
let quitAfterCleanup = false;
let quitCleanupPending = false;
let updateInstallRequested = false;
const vpnDnsCache = new Map();
// macOS self-update (electron/mac-updater.cjs). The CI end-to-end test also runs it against a loopback feed.
const updatesSupported = process.platform === 'darwin' && app.isPackaged;
// Set by update-helper.sh when it launches a freshly installed version: the app proves it started by writing
// this marker (after the window loaded; --wlsaplus-update-verify-only: right after start-up, then quits).
const updateMarkerArg = argValue(process.argv, 'wlsaplus-update-marker');
const updateVerifyOnly = process.argv.includes('--wlsaplus-update-verify-only');
let updateMarkerWritten = false;
let systemShuttingDown = false;
let macUpdater = null;
let updateStatus = {
  state: updatesSupported ? 'idle' : 'unsupported',
  message: updatesSupported ? 'Ready to check for updates.' : 'Automatic updates need the installed macOS app.',
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
  channel: 'stable',
};

const preload = path.join(__dirname, 'preload.cjs');
const credentialFile = () => path.join(app.getPath('userData'), 'credentials.bin');
const vpnDirectory = () => path.join(app.getPath('userData'), 'vpn');
const vpnProxyStateFile = () => path.join(vpnDirectory(), 'proxy-state.json');
const classRemindersFile = () => path.join(app.getPath('userData'), 'class-reminders.json');
const powerSchoolSession = () => session.fromPartition('persist:powerschool');
const appSession = () => session.fromPartition('persist:wlsaplus');
const forumSession = () => session.fromPartition(FORUM_PARTITION);
// Live forum <webview> guests and the app theme last reported by the renderer (light/dark).
const forumGuests = new Set();
let forumTheme = null;
const iconPath = () => path.join(__dirname, '..', 'build', 'icon.png');

function rendererIndexPath() {
  return path.resolve(__dirname, '..', 'dist', 'wlsaplus', 'browser', 'index.html');
}

async function loadRenderer(win, route = '') {
  const dev = process.env.WLSAPLUS_DEV_URL;
  if (dev) {
    await win.loadURL(`${dev.replace(/\/$/, '')}/#/${route}`);
    return;
  }
  const indexFile = rendererIndexPath();
  const { existsSync } = require('node:fs');
  if (!existsSync(indexFile)) {
    console.error(`WLSAPlus UI missing at ${indexFile}. Run npm run build:web before packaging or starting Electron.`);
  }
  // loadFile is the reliable way to open UI from asar on macOS.
  await win.loadFile(indexFile, { hash: route ? `/${route}` : '/' });
}

function webPreferences(overrides = {}) {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:wlsaplus', ...overrides };
}

function configureExternalHelpLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(validateExternalHelpUrl(url)); } catch { /* Ignore unapproved popup URLs. */ }
    return { action: 'deny' };
  });
}

// WLSAPlus 论坛: the only <webview> allowed is the forum, in its own partition,
// without the app preload. Popups and off-forum navigation go to the system browser.
function configureForumWebview(win) {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isForumWebviewAttachAllowed(params)) {
      console.warn(`Blocked <webview> attach for ${params?.src} (partition ${params?.partition}).`);
      event.preventDefault();
      return;
    }
    hardenForumWebPreferences(webPreferences);
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    forumGuests.add(guest);
    guest.once('destroyed', () => forumGuests.delete(guest));
    // Prefer the app's color scheme inside the forum page (re-applied after each navigation).
    if (forumTheme) void emulateForumColorScheme(guest, forumTheme);
    guest.on('did-navigate', () => { if (forumTheme) void emulateForumColorScheme(guest, forumTheme); });
    guest.setWindowOpenHandler(({ url }) => {
      if (isForumUrl(url)) void guest.loadURL(url);
      else if (isWebUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (isForumUrl(url)) return;
      event.preventDefault();
      if (isWebUrl(url)) void shell.openExternal(url);
    });
  });
}

function configureForumSession() {
  const forum = forumSession();
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  forum.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed.has(permission)));
  forum.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Request timed out. Check your network and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setVpnStatus(patch) {
  vpnStatus = { ...vpnStatus, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vpn:status', vpnStatus);
  }
  return vpnStatus;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').toString('utf8');
}

function parseShadowsocksUri(value) {
  const url = new URL(value.trim());
  if (url.protocol !== 'ss:') throw new Error('WLSAPlus relay returned an unsupported profile.');
  let method;
  let password;
  if (url.password) {
    method = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } else {
    const credentials = decodeBase64Url(decodeURIComponent(url.username));
    const separator = credentials.indexOf(':');
    if (separator < 1) throw new Error('WLSAPlus relay returned an invalid profile.');
    method = credentials.slice(0, separator);
    password = credentials.slice(separator + 1);
  }
  const plugin = decodeURIComponent(url.searchParams.get('plugin') || '');
  const [pluginName, ...pluginOptions] = plugin.split(';').filter(Boolean);
  if (pluginName && pluginName !== 'v2ray-plugin') throw new Error(`WLSAPlus relay requires an unsupported plugin: ${pluginName}.`);
  if (!url.hostname || !url.port || !method || !password) throw new Error('WLSAPlus relay returned an incomplete profile.');
  return { server: url.hostname, serverPort: Number(url.port), method, password, plugin: pluginName || undefined, pluginOptions: pluginOptions.join(';') || undefined };
}

function parseClashDocument(body) {
  try { return yaml.load(body); } catch { return null; }
}

function listShadowsocksUriNodes(body) {
  let text = body;
  if (!body.startsWith('ss://')) {
    try { text = decodeBase64Url(body); } catch { text = body; }
  }
  const nodes = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('ss://')) continue;
    try {
      const profile = parseShadowsocksUri(line);
      const hash = line.includes('#') ? line.slice(line.indexOf('#') + 1) : '';
      let name = `${profile.server}:${profile.serverPort}`;
      try { if (hash.trim()) name = decodeURIComponent(hash.trim()); } catch { /* keep fallback name */ }
      if (seen.has(name)) continue;
      seen.add(name);
      nodes.push({
        id: name,
        name,
        type: 'ss',
        server: profile.server,
        port: profile.serverPort,
      });
    } catch { /* skip malformed lines */ }
  }
  return nodes;
}

function measureTcpLatency(server, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = nodeNet.createConnection({ host: server, port: Number(port) });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Date.now() - started));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
  });
}

function isPublicIpv4(address) {
  if (!nodeNet.isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first !== 0
    && first !== 10
    && first !== 127
    && first < 224
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 168)
    && !(first === 198 && (second === 18 || second === 19));
}

async function resolvePublicIpv4(hostname) {
  if (nodeNet.isIPv4(hostname)) return [hostname];
  if (vpnDnsCache.has(hostname)) return vpnDnsCache.get(hostname);
  const resolvers = [
    { address: '223.5.5.5', servername: 'dns.alidns.com', path: `/resolve?name=${encodeURIComponent(hostname)}&type=A` },
    { address: '223.6.6.6', servername: 'dns.alidns.com', path: `/resolve?name=${encodeURIComponent(hostname)}&type=A` },
    { address: '1.12.12.12', servername: 'doh.pub', path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A` },
    { address: '120.53.53.53', servername: 'doh.pub', path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A` },
  ];
  for (const resolver of resolvers) {
    try {
      const response = await secureGetByAddress(resolver.address, resolver.servername, resolver.path, 'application/dns-json');
      if (response.status !== 200) continue;
      const result = JSON.parse(response.text);
      const publicAddresses = Array.isArray(result.Answer)
        ? result.Answer.filter((answer) => Number(answer?.type) === 1).map((answer) => String(answer.data)).filter(isPublicIpv4)
        : [];
      if (publicAddresses.length) {
        vpnDnsCache.set(hostname, publicAddresses);
        return publicAddresses;
      }
    } catch { /* Try the next direct encrypted resolver. */ }
  }
  throw new Error('Could not resolve the WLSAPlus relay server outside the system DNS.');
}

function secureGetByAddress(address, servername, requestPath, accept = 'text/plain') {
  return new Promise((resolve, reject) => {
    const request = nodeHttps.request({
      host: address,
      port: 443,
      servername,
      path: requestPath,
      method: 'GET',
      headers: { Host: servername, Accept: accept, 'User-Agent': `WLSAPlus/${app.getVersion()}` },
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchSubscriptionBody(sourceId = 'relay', format = 'clash') {
  const subscription = subscriptionUrl(sourceId, format);
  const addresses = await resolvePublicIpv4(subscription.hostname);
  let lastError;
  for (const address of addresses) {
    try {
      const response = await secureGetByAddress(address, subscription.hostname, `${subscription.pathname}${subscription.search}`);
      if (response.status !== 200) throw new Error(`${getVpnSource(sourceId).name} subscription returned ${response.status}.`);
      return response.text.trim();
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || 'Could not download the WLSAPlus relay subscription.');
}

async function fetchVpnNodes(sourceId = 'relay') {
  let document = null;
  let nodes = [];
  try {
    const body = await fetchSubscriptionBody(sourceId, 'clash');
    document = parseClashDocument(body);
    nodes = listClashProxyNodes(document);
  } catch { /* try ss fallback below */ }
  if (!nodes.length) {
    const ssBody = await fetchSubscriptionBody(sourceId, 'ss');
    nodes = listShadowsocksUriNodes(ssBody);
    if (!document) {
      document = parseClashDocument(ssBody);
      if (document) nodes = listClashProxyNodes(document).length ? listClashProxyNodes(document) : nodes;
    }
  }
  if (!nodes.length) throw new Error(`${getVpnSource(sourceId).name} did not return any VPN nodes.`);
  return { nodes, document };
}

function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', updateStatus);
  }
  return updateStatus;
}

function macCoreRequest(controller) {
  return (options) => controllerRequest({ port: controller.port, secret: controller.secret, ...options });
}

function stopMacCoreWatchdog() {
  macCoreWatchdog?.stop();
  macCoreWatchdog = null;
}

function startMacCoreWatchdog(controller, attempt) {
  stopMacCoreWatchdog();
  const request = macCoreRequest(controller);
  macCoreWatchdog = createWatchdog({
    check: () => isCoreUp(request),
    onDead: () => {
      macCoreWatchdog = null;
      // Never turn an intentional disconnect/reconnect into an error.
      if (attempt !== macConnectAttempt || vpnDisconnecting || vpnStatus.state !== 'connected') return;
      setVpnStatus({ state: 'error', message: 'VPN core exited unexpectedly', connectedAt: null, requiresElevation: false });
    },
  });
}

function readMacCoreLogTail(logPath) {
  try { return tailLines(require('node:fs').readFileSync(logPath, 'utf8'), 6); } catch { return ''; }
}

function restartVpnElevated(mode, sourceId = 'relay', nodeName = '') {
  if (isQuitting || vpnDisconnecting) return Promise.resolve(vpnStatus);
  // One pending approval/startup owns the config and script files. Duplicate clicks must not
  // launch another root process or overwrite a configuration being used by an earlier attempt.
  if (macConnectOperation) return macConnectOperation;
  const attempt = ++macConnectAttempt;
  macConnectOperation = Promise.resolve()
    .then(() => startVpnElevated({ attempt, mode, sourceId, nodeName }))
    .finally(() => { macConnectOperation = null; });
  return macConnectOperation;
}

async function startVpnElevated({ attempt, mode, sourceId, nodeName }) {
  if (process.platform !== 'darwin') {
    throw new Error('Administrator VPN restart is only available on macOS.');
  }

  const { execFile, execSync } = require('node:child_process');
  const fsSync = require('node:fs');
  const superseded = () => attempt !== macConnectAttempt || vpnDisconnecting || isQuitting;
  if (superseded()) return vpnStatus;
  stopMacCoreWatchdog();
  // Best-effort stop of a previous elevated helper so reconnect does not stack tunnels.
  await stopMacClashHelper({ elevated: false }).catch(() => {});
  if (superseded()) return vpnStatus;

  const candidateTars = [
    path.join(process.resourcesPath || '', 'bin', 'mac-vpn.tar.gz'),
    path.join(__dirname, 'bin', 'mac-vpn.tar.gz'),
    path.join(__dirname, '..', 'electron', 'bin', 'mac-vpn.tar.gz'),
  ];
  const tarPath = candidateTars.find((candidate) => {
    try { return fsSync.existsSync(candidate); } catch { return false; }
  });
  if (!tarPath) {
    setVpnStatus({
      state: 'error',
      message: 'macOS VPN package is missing (bin/mac-vpn.tar.gz). Rebuild the desktop app.',
      connectedAt: null,
      mode,
      requiresElevation: false,
    });
    throw new Error('macOS VPN package is missing.');
  }

  const targetDir = path.join(app.getPath('userData'), 'vpn-bin');
  const clashPkgDir = path.join(targetDir, 'clash_pkg');
  const execPath = path.join(clashPkgDir, 'clash');
  const scriptPath = path.join(targetDir, 'run.sh');
  const logPath = path.join(targetDir, 'core.log');
  const controller = { port: MAC_CLASH_CONTROLLER_PORT, secret: newControllerSecret() };

  try {
    execSync(`mkdir -p ${JSON.stringify(targetDir)}`);
    execSync(`tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(targetDir)}`);
    if (!fsSync.existsSync(execPath)) throw new Error('VPN helper binary was not found after extraction.');
    execSync(`chmod +x ${JSON.stringify(execPath)}`);
    // Older mac-vpn.tar.gz builds carried com.apple.quarantine in their tar headers, which macOS tar
    // restores; a quarantined helper can be blocked by Gatekeeper. Strip it (best effort).
    try { execSync(`xattr -dr com.apple.quarantine ${JSON.stringify(targetDir)}`, { stdio: 'ignore' }); } catch {}
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    setVpnStatus({
      state: 'error',
      message: `Could not prepare the macOS VPN helper. ${detail}`,
      connectedAt: null,
      mode,
      requiresElevation: false,
    });
    throw err;
  }

  // Runs as root: stop a stale core (root-owned, so the unprivileged pkill above cannot), then start
  // the new one with its output in core.log (truncated on every start) for diagnostics.
  const scriptContent = `#!/bin/bash
/usr/bin/pkill -f "${execPath}" > /dev/null 2>&1 && sleep 0.5
"${execPath}" -d "${clashPkgDir}" > "${logPath}" 2>&1 &
`;
  let selectedGroups = [];
  // Refresh proxies from the live subscription and pin the user-selected node.
  try {
    setVpnStatus({
      state: 'connecting',
      message: 'Downloading VPN nodes…',
      connectedAt: null,
      mode,
      sourceId: getVpnSource(sourceId).id,
      requiresElevation: false,
    });
    const { document } = await fetchVpnNodes(sourceId);
    if (superseded()) return vpnStatus;
    const applied = applySelectedClashNode(document, nodeName, { secret: controller.secret, port: controller.port });
    const configPath = path.join(clashPkgDir, 'config.yaml');
    fsSync.writeFileSync(configPath, yaml.dump(applied.document, { lineWidth: -1, noRefs: true }), 'utf8');
    nodeName = applied.selected;
    selectedGroups = groupsContainingNode(applied.document, nodeName);
  } catch (err) {
    if (superseded()) return vpnStatus;
    // Keep bundled config.yaml if subscription refresh fails — still try to pin node name locally.
    try {
      const configPath = path.join(clashPkgDir, 'config.yaml');
      if (fsSync.existsSync(configPath)) {
        const document = parseClashDocument(fsSync.readFileSync(configPath, 'utf8'));
        let next;
        try {
          const applied = applySelectedClashNode(document, nodeName, { secret: controller.secret, port: controller.port });
          next = applied.document;
          nodeName = applied.selected;
          selectedGroups = groupsContainingNode(next, nodeName);
        } catch {
          // No usable node list: still install the private controller so start-up can be verified.
          next = applyControllerSettings(document, controller.secret, controller.port);
        }
        fsSync.writeFileSync(configPath, yaml.dump(next, { lineWidth: -1, noRefs: true }), 'utf8');
      }
    } catch {
      /* continue with the packaged default config; start-up verification will report a failure */
    }
  }

  if (superseded()) return vpnStatus;
  try {
    if (fsSync.existsSync(scriptPath)) fsSync.rmSync(scriptPath, { force: true });
  } catch { /* ignore cleanup */ }
  fsSync.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  setVpnStatus({
    state: 'connecting',
    message: nodeName ? `Waiting for approval to connect “${nodeName}”…` : 'Waiting for macOS administrator approval…',
    connectedAt: null,
    mode,
    sourceId: getVpnSource(sourceId).id,
    requiresElevation: true,
  });

  return new Promise((resolve, reject) => {
    // Track ownership before approval: the helper may exist while the controller is still booting.
    macCoreController = controller;
    execFile('osascript', ['-e', appleScriptElevatedRun(scriptPath)], (error) => {
      // Disconnect waits for this operation, then stops any helper that was just authorized.
      if (superseded()) { resolve(vpnStatus); return; }
      if (error) {
        if (isOsascriptAuthCancelled(error)) {
          resolve(setVpnStatus({
            state: 'idle',
            message: 'Administrator approval was cancelled. Tap Connect to try again.',
            connectedAt: null,
            mode,
            requiresElevation: true,
          }));
          return;
        }
        const detail = String(error.stderr || error.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
        setVpnStatus({
          state: 'error',
          message: detail
            ? `Could not start the macOS VPN after authorization. ${detail}`.slice(0, 280)
            : 'Could not start the macOS VPN after authorization.',
          connectedAt: null,
          mode,
          requiresElevation: true,
        });
        reject(error);
        return;
      }
      resolve(verifyMacCoreStarted({ attempt, controller, logPath, mode, sourceId, nodeName, selectedGroups }));
    });
  });
}

async function verifyMacCoreStarted({ attempt, controller, logPath, mode, sourceId, nodeName, selectedGroups }) {
  const source = getVpnSource(sourceId).id;
  const superseded = () => attempt !== macConnectAttempt || vpnDisconnecting || isQuitting;
  if (superseded()) return vpnStatus;
  setVpnStatus({ state: 'connecting', message: 'Starting the VPN core…', connectedAt: null, mode, sourceId: source, requiresElevation: false });
  const request = macCoreRequest(controller);
  const up = await waitForCore(request, { cancelled: superseded });
  if (superseded()) return vpnStatus;
  if (!up) {
    const tail = readMacCoreLogTail(logPath);
    await stopMacClashHelper({ elevated: false }).catch(() => {});
    if (superseded()) return vpnStatus;
    return setVpnStatus({
      state: 'error',
      message: tail ? `The VPN core did not start.\n${tail}` : 'The VPN core did not start',
      connectedAt: null,
      mode,
      sourceId: source,
      requiresElevation: false,
    });
  }
  const enforcement = nodeName && selectedGroups.length
    ? await enforceSelectedNode(request, selectedGroups, nodeName)
    : { ok: !nodeName, actual: null, groups: [] };
  if (superseded()) return vpnStatus;
  macCoreController = controller;
  const connected = connectedStatusFor(nodeName, enforcement);
  const status = setVpnStatus({
    state: 'connected',
    message: connected.message,
    connectedAt: new Date().toISOString(),
    mode,
    sourceId: source,
    nodeName: connected.nodeName,
    requiresElevation: false,
  });
  startMacCoreWatchdog(controller, attempt);
  return status;
}

async function testWeChatConnectivity() {
  const WECHAT_URL = 'https://weixin.qq.com/';
  const viaVpn = vpnStatus.state === 'connected';
  const probeSession = session.fromPartition(`wlsaplus-wechat-probe-${viaVpn ? 'vpn' : 'direct'}-${Date.now()}`);
  // Mac clash TUN routes the whole system when connected, so Electron "direct"
  // still traverses the tunnel. When disconnected, this is a normal direct probe.
  await probeSession.setProxy({ mode: 'direct' });
  const started = Date.now();
  try {
    await probeSession.clearHostResolverCache().catch(() => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await probeSession.fetch(WECHAT_URL, {
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': `WLSAPlus/${app.getVersion()}`, Accept: 'text/html,*/*;q=0.8' },
      });
      const latencyMs = Date.now() - started;
      const reachable = response.status > 0 && response.status < 500;
      const pathLabel = viaVpn ? 'with VPN on' : 'with VPN off';
      return {
        reachable,
        latencyMs,
        viaVpn,
        url: WECHAT_URL,
        status: response.status,
        message: reachable
          ? `WeChat reachable (${latencyMs} ms, ${pathLabel})`
          : `WeChat unreachable (HTTP ${response.status}, ${pathLabel})`,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch (error) {
    const latencyMs = Date.now() - started;
    const pathLabel = viaVpn ? 'with VPN on' : 'with VPN off';
    const detail = error instanceof Error ? error.message : String(error || '');
    return {
      reachable: false,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      viaVpn,
      url: WECHAT_URL,
      status: 0,
      message: `WeChat unreachable (${pathLabel})${detail ? `: ${detail}` : ''}`,
    };
  } finally {
    await probeSession.closeAllConnections().catch(() => {});
  }
}

async function restoreSystemProxy(state) {
  if (!state || state.platform !== 'darwin' || process.platform !== 'darwin') {
    await fs.rm(vpnProxyStateFile(), { force: true });
    return;
  }
  for (const item of state.services || []) {
    for (const [kind, value] of [['web', item.web], ['secureweb', item.secure]]) {
      if (value?.server && value?.port) await execFileAsync('networksetup', [`-set${kind}proxy`, item.service, value.server, String(value.port)]);
      await execFileAsync('networksetup', [`-set${kind}proxystate`, item.service, value?.enabled ? 'on' : 'off']);
    }
  }
  await fs.rm(vpnProxyStateFile(), { force: true });
}

// Recover network settings left by older macOS versions that used a system proxy.
async function restoreSavedSystemProxy() {
  const state = await readJson(vpnProxyStateFile(), null);
  if (state) await restoreSystemProxy(state);
}

async function stopMacClashHelper({ elevated = true } = {}) {
  if (process.platform !== 'darwin') return { stopped: true, cancelled: false };
  const targetDir = path.join(app.getPath('userData'), 'vpn-bin');
  const execPath = path.join(targetDir, 'clash_pkg', 'clash');
  return stopMacClashProcess({ execPath, run: execFileAsync, elevated });
}

async function connectVpn(_requestedMode = 'full-tunnel', requestedSource = 'relay', nodeName = '') {
  if (isQuitting || vpnDisconnecting) return vpnStatus;
  if (macConnectOperation) return macConnectOperation;
  const mode = 'full-tunnel';
  const sourceId = getVpnSource(requestedSource).id;
  if (process.platform !== 'darwin') {
    return setVpnStatus({
      state: 'error',
      message: 'VPN is only available in the macOS desktop app.',
      connectedAt: null,
      mode,
      sourceId,
      requiresElevation: false,
    });
  }
  if (vpnStatus.state === 'connected' && vpnStatus.mode === mode && vpnStatus.sourceId === sourceId && (!nodeName || vpnStatus.nodeName === nodeName)) {
    return vpnStatus;
  }
  if (macCoreController || vpnStatus.state === 'connected') {
    await disconnectVpn();
    if (vpnStatus.state !== 'idle' || isQuitting) return vpnStatus;
  }

  setVpnStatus({
    state: 'connecting',
    message: 'Preparing macOS VPN…',
    connectedAt: null,
    mode,
    sourceId,
    nodeName: nodeName || undefined,
    requiresElevation: false,
  });
  try {
    return await restartVpnElevated(mode, sourceId, nodeName);
  } catch (error) {
    if (vpnStatus.state === 'connecting' || vpnStatus.state === 'idle') return vpnStatus;
    if (vpnStatus.state === 'error') return vpnStatus;
    const message = error instanceof Error ? error.message : `Could not connect to ${getVpnSource(sourceId).name}.`;
    return setVpnStatus({ state: 'error', message, connectedAt: null, mode, sourceId, requiresElevation: true });
  }
}

function disconnectVpn() {
  if (vpnDisconnectOperation) return vpnDisconnectOperation;
  vpnDisconnecting = true;
  ++macConnectAttempt;
  stopMacCoreWatchdog();
  vpnDisconnectOperation = performVpnDisconnect()
    .finally(() => { vpnDisconnecting = false; vpnDisconnectOperation = null; });
  return vpnDisconnectOperation;
}

async function performVpnDisconnect() {
  const mode = 'full-tunnel';
  const sourceId = vpnStatus.sourceId;
  const nodeName = vpnStatus.nodeName;
  const connectedAt = vpnStatus.connectedAt;
  setVpnStatus({ state: 'disconnecting', message: 'Disconnecting...', mode, sourceId, nodeName, requiresElevation: false });
  // An already displayed admin prompt can still launch a core after cancellation. Await its
  // completion before killing anything; canceled subscription fetches never reach that prompt.
  await macConnectOperation?.catch(() => {});
  await restoreSavedSystemProxy().catch(() => {});
  const macStop = await stopMacClashHelper({ elevated: true }).catch(() => ({ stopped: false, cancelled: false }));
  if (!macStop?.stopped) {
    return setVpnStatus({
      state: 'connected',
      message: macStop?.cancelled
        ? 'Disconnect was cancelled. VPN may still be running. Tap Disconnect to retry.'
        : 'Could not stop the VPN core. VPN may still be running. Tap Disconnect to retry.',
      connectedAt: connectedAt || new Date().toISOString(),
      mode,
      sourceId,
      nodeName,
      requiresElevation: true,
    });
  }
  macCoreController = null;
  return setVpnStatus({ state: 'idle', message: 'Ready', connectedAt: null, mode, requiresElevation: false });
}

function writeUpdateMarker() {
  if (updateMarkerWritten || !updateMarkerArg) return;
  const marker = validMarkerPath(app.getPath('userData'), updateMarkerArg);
  if (!marker) return;
  updateMarkerWritten = true;
  try {
    require('node:fs').mkdirSync(path.dirname(marker), { recursive: true });
    require('node:fs').writeFileSync(marker, `${app.getVersion()}\n`);
  } catch (error) {
    console.error('Could not write update marker:', error);
    return;
  }
  // The helper writes its result right after seeing the marker: show "Updated to …" in this session already.
  if (!updateVerifyOnly) setTimeout(() => void macUpdater?.consumeLastResult().catch(() => {}), 8_000).unref();
}

async function cleanupBeforeUpdate() {
  // Preparation can be canceled by a channel change while awaiting cleanup. Only the final
  // updater quit callback commits exit/install flags after its last eligibility check.
  const status = await disconnectVpn();
  if (status.state !== 'idle') throw new Error('Could not stop the VPN core. Disconnect the VPN before installing the update.');
}

function quitForUpdate() {
  updateInstallRequested = true;
  isQuitting = true;
  app.quit();
}

function runForUpdate(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim().split('\n').slice(-2).join(' ');
        reject(new Error(`${path.basename(command)} failed: ${detail}`.slice(0, 240)));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Update downloads use Chromium's network stack first (same proxy settings, VPN and certificate store as the
 * browser the user downloaded WLSAPlus with), then Node's fetch if Chromium cannot connect at all.
 */
const updateFetchLogged = new Set();
async function updateFetch(url, init = {}) {
  try {
    const response = await net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });
    if (!updateFetchLogged.has('net')) { updateFetchLogged.add('net'); void macUpdater?.log('network: using Chromium net.fetch'); }
    return response;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    void macUpdater?.log(`network: net.fetch failed for ${url}: ${error?.message || error}; retrying with Node fetch`);
    return fetch(url, init);
  }
}

function configureAppUpdater() {
  macUpdater = createMacUpdater({
    currentVersion: app.getVersion(),
    userData: app.getPath('userData'),
    exePath: app.getPath('exe'),
    arch: process.arch === 'arm64' || app.runningUnderARM64Translation ? 'arm64' : 'x64',
    systemVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null,
    supported: updatesSupported,
    run: runForUpdate,
    spawnDetached: (command, args) => spawn(command, args, { detached: true, stdio: 'ignore' }).unref(),
    helperSource: path.join(__dirname, 'update-helper.sh'),
    beforeInstall: cleanupBeforeUpdate,
    quit: quitForUpdate,
    onStatus: (status) => setUpdateStatus(status),
    launchedByUpdater: Boolean(updateMarkerArg),
    fetchImpl: updateFetch,
  });
  updateStatus = macUpdater.getStatus();
  void macUpdater.start().catch((error) => console.error('Updater failed to start:', error));
  if (updatesSupported) {
    powerMonitor.on('shutdown', () => { systemShuttingDown = true; });
    // E2E only (loopback feed): install as soon as the update is staged, as if "Restart" had been clicked.
    if (macUpdater.feed.test && process.env.WLSAPLUS_UPDATE_TEST_AUTOINSTALL === '1') {
      const poll = setInterval(() => {
        if (macUpdater.getStatus().state === 'ready') { clearInterval(poll); void macUpdater.install(); }
      }, 1000);
    }
  }
}

async function translateWithGoogle(value, source, target) {
  const params = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: value });
  const response = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?${params}`, {}, 12_000);
  if (!response.ok) throw new Error('Google Translate is unavailable.');
  const result = await response.json();
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error('The translation response was invalid.');
  return { text: result[0].map((part) => Array.isArray(part) ? String(part[0] || '') : '').join(''), detectedLanguage: typeof result[2] === 'string' ? result[2] : source };
}

async function translateWithMyMemory(value, source, target) {
  const params = new URLSearchParams({ q: value, langpair: `${source === 'auto' ? 'Autodetect' : source}|${target}` });
  const response = await fetchWithTimeout(`https://api.mymemory.translated.net/get?${params}`, {}, 12_000);
  if (!response.ok) throw new Error('Translation service is unavailable. Please try again later.');
  const result = await response.json();
  if (result?.responseStatus !== 200 || typeof result?.responseData?.translatedText !== 'string') {
    throw new Error(typeof result?.responseDetails === 'string' && result.responseDetails.trim() ? result.responseDetails : 'The translation response was invalid.');
  }
  return { text: result.responseData.translatedText, detectedLanguage: typeof result.responseData.detectedLanguage === 'string' ? result.responseData.detectedLanguage : source };
}

function splitTextByBytes(value, maximumBytes) {
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (chunk && chunkBytes + characterBytes > maximumBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function translateText(text, source, target) {
  const value = String(text || '').trim().slice(0, 5000);
  if (!value) return { text: '', detectedLanguage: String(source || 'auto') };
  const safeSource = /^[a-zA-Z-]{2,10}$/.test(source) ? source : 'auto';
  const safeTarget = /^[a-zA-Z-]{2,10}$/.test(target) ? target : 'en';
  try { return await translateWithGoogle(value, safeSource, safeTarget); }
  catch {
    const translations = [];
    let detectedLanguage = safeSource;
    for (const chunk of splitTextByBytes(value, 450)) {
      const translated = await translateWithMyMemory(chunk, safeSource, safeTarget);
      translations.push(translated.text);
      if (detectedLanguage === 'auto' && translated.detectedLanguage !== 'auto') detectedLanguage = translated.detectedLanguage;
    }
    return { text: translations.join(''), detectedLanguage };
  }
}

function createMainWindow(route = '') {
  mainWindow = new BrowserWindow({ width: 1220, height: 820, minWidth: 380, minHeight: 600, backgroundColor: '#f7f8fa', title: 'WLSAPlus', icon: iconPath(), webPreferences: webPreferences({ webviewTag: true }) });
  configureExternalHelpLinks(mainWindow);
  configureForumWebview(mainWindow);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription} @ ${validatedURL}`);
    const message = `WLSAPlus UI failed to load (${errorCode}): ${errorDescription}\n${validatedURL}\nIndex: ${rendererIndexPath()}`;
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset=utf-8><title>WLSAPlus load error</title><pre style="padding:24px;font:14px/1.4 system-ui">${message.replace(/</g, '&lt;')}</pre>`)}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`Renderer loaded: ${mainWindow.webContents.getURL()}`);
    if (mainWindow.webContents.getURL().startsWith('data:')) return; // load-error page: not a healthy start
    writeUpdateMarker();
  });
  console.log(`Loading UI from ${rendererIndexPath()} (packaged=${app.isPackaged})`);
  void loadRenderer(mainWindow, route).catch((error) => {
    console.error('WLSAPlus failed to load renderer:', error);
  });
}

function showMainWindow(route = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(route);
    return;
  }
  if (route) void loadRenderer(mainWindow, route).catch((error) => console.error('WLSAPlus failed to load renderer:', error));
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function validateBaseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' && !(process.env.WLSAPLUS_DEV_ALLOW_HTTP === '1' && url.protocol === 'http:')) throw new Error('Only HTTPS PowerSchool servers are allowed.');
  return url.origin;
}

ipcMain.handle('system:open-external', (_event, url) => shell.openExternal(validateExternalHelpUrl(url)));

async function readCredentials() {
  try {
    const encrypted = await fs.readFile(credentialFile());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch { return null; }
}

ipcMain.handle('credentials:get', () => readCredentials());
ipcMain.handle('credentials:set', async (_event, value) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential encryption is unavailable.');
  const credentials = { schoolUrl: String(value.schoolUrl), username: String(value.username), password: String(value.password) };
  await fs.writeFile(credentialFile(), safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
});
ipcMain.handle('credentials:clear', async () => { await fs.rm(credentialFile(), { force: true }); });

ipcMain.handle('powerschool:request', async (_event, options) => {
  const origin = validateBaseUrl(options.baseUrl);
  const requestUrl = new URL(String(options.path), origin);
  if (requestUrl.origin !== origin) throw new Error('Cross-origin PowerSchool request blocked.');
  const headers = { ...(options.headers || {}) };
  if (options.referrerPath) {
    const referrerUrl = new URL(String(options.referrerPath), `${origin}/`);
    if (referrerUrl.origin !== origin) throw new Error('Cross-origin PowerSchool referrer blocked.');
    headers.origin = origin;
    headers.referer = referrerUrl.toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await powerSchoolSession().fetch(requestUrl.toString(), {
      method: options.method === 'POST' ? 'POST' : 'GET',
      headers,
      body: options.method === 'POST' ? String(options.body || '') : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    return { status: response.status, url: response.url, text: await response.text() };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('PowerSchool request timed out. Check your network and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
});
ipcMain.handle('powerschool:clear-session', async (_event, baseUrl) => {
  const origin = validateBaseUrl(baseUrl);
  await powerSchoolSession().clearStorageData({ origin, storages: ['cookies'] });
});

ipcMain.handle('forum:sso-url', async (_event, options) => resolveForumEntryUrl({
  baseUrl: forumBaseUrl(options?.fallback === true),
  credentials: await readCredentials(),
  powerSchoolSession: powerSchoolSession(),
  fetch: (url, init) => forumSession().fetch(url, init),
  // After consume, land in embed mode with the app theme (forum §7.5).
  next: forumSsoNext(options?.theme),
}));
ipcMain.handle('forum:sso-status', () => getLastForumSsoStatus());
// Theme + embed cookies on every forum origin (forum partition only) and prefers-color-scheme for live guests.
ipcMain.handle('forum:set-theme', async (_event, theme) => {
  forumTheme = validateForumTheme(theme);
  await applyForumTheme({ session: forumSession(), guests: forumGuests, theme: forumTheme });
});
ipcMain.handle('forum:clear-session', async () => {
  const forum = forumSession();
  await forum.clearStorageData();
  await forum.clearCache();
});

ipcMain.handle('vpn:status', () => vpnStatus);
ipcMain.handle('vpn:connect', (_event, mode, sourceId, nodeName) => connectVpn(mode, sourceId, nodeName));
ipcMain.handle('vpn:list-nodes', async (_event, sourceId) => {
  try {
    const { nodes } = await fetchVpnNodes(sourceId || 'relay');
    return nodes;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || '');
    throw new Error(detail || 'Could not load VPN nodes. Check your network and try again.');
  }
});
ipcMain.handle('vpn:test-latency', async (_event, nodes) => {
  const list = Array.isArray(nodes) ? nodes.slice(0, 80) : [];
  const measured = [];
  for (const node of list) {
    const server = typeof node?.server === 'string' ? node.server : '';
    const port = Number(node?.port);
    let latencyMs = null;
    if (server && Number.isFinite(port) && port > 0) {
      latencyMs = await measureTcpLatency(server, port);
    }
    measured.push({ ...node, latencyMs });
  }
  // Faster nodes first; unknown latency goes last.
  measured.sort((a, b) => {
    if (a.latencyMs == null && b.latencyMs == null) return 0;
    if (a.latencyMs == null) return 1;
    if (b.latencyMs == null) return -1;
    return a.latencyMs - b.latencyMs;
  });
  return measured;
});
ipcMain.handle('vpn:test-wechat', async () => testWeChatConnectivity());
ipcMain.handle('vpn:disconnect', () => disconnectVpn());
ipcMain.handle('vpn:restart-elevated', (_event, mode, sourceId, nodeName) => connectVpn(mode, sourceId, nodeName));
ipcMain.handle('updater:status', () => macUpdater?.getStatus() ?? updateStatus);
ipcMain.handle('updater:check', () => macUpdater?.check() ?? updateStatus);
ipcMain.handle('updater:install', () => macUpdater?.install() ?? updateStatus);
ipcMain.handle('updater:reveal-log', async () => {
  const file = path.join(app.getPath('userData'), 'updates', 'update.log');
  try { await fs.access(file); shell.showItemInFolder(file); return true; } catch { return false; }
});
ipcMain.handle('updater:set-channel', (_event, channel) => macUpdater?.setChannel(channel === 'beta' ? 'beta' : 'stable') ?? updateStatus);
ipcMain.handle('translator:translate', (_event, text, source, target) => translateText(text, source, target));

// Notifications must stay referenced until dismissed, or their click handler can be garbage-collected.
const activeClassReminderNotifications = new Set();

function showClassReminderNotification(options) {
  if (process.platform !== 'darwin') return false;
  if (!Notification.isSupported()) return false;
  const title = String(options?.title || 'Class starting soon').slice(0, 120);
  const body = String(options?.body || '').slice(0, 240);
  const notification = new Notification({ title, body, silent: false });
  const release = () => activeClassReminderNotifications.delete(notification);
  activeClassReminderNotifications.add(notification);
  notification.on('click', () => { release(); showMainWindow(); });
  notification.on('close', release);
  notification.show();
  return true;
}

// Class reminders run in the main process so they survive the last window being closed on macOS
// (the app keeps running) and work after a windowless --autostart launch.
let classReminderScheduler = null;
function classReminders() {
  if (process.platform !== 'darwin') return null;
  if (!classReminderScheduler) {
    classReminderScheduler = createClassReminderScheduler({
      file: classRemindersFile(),
      showNotification: showClassReminderNotification,
    });
  }
  return classReminderScheduler;
}

ipcMain.handle('notice:get', () => fetchAppNotice());
ipcMain.handle('reminders:sync', async (_event, payload) => {
  const scheduler = classReminders();
  if (!scheduler) return false;
  return scheduler.sync(payload);
});

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--prepare-update')) {
      void cleanupBeforeUpdate().then(quitForUpdate).catch((error) => console.error('Could not prepare for update:', error));
      return;
    }
    if (!commandLine.includes('--autostart')) showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (updateVerifyOnly) {
    // Silent post-install check (update installed on quit): prove the new version starts, then exit.
    app.dock?.hide();
    writeUpdateMarker();
    app.exit(0);
    return;
  }
  if (prepareUpdateMode) {
    try { await cleanupBeforeUpdate(); quitForUpdate(); }
    catch (error) { console.error('Could not prepare for update:', error); showMainWindow('tools/vpn'); }
    return;
  }
  configureAppUpdater();
  await restoreSavedSystemProxy().catch(() => {});
  await appSession().clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  configureForumSession();
  const reminders = classReminders();
  if (reminders) {
    reminders.start();
    // Timers stall while the Mac sleeps; re-check as soon as it wakes.
    powerMonitor.on('resume', () => void reminders.tick().catch(() => {}));
  }
  if (!isAutostart || vpnAutoConnectMode) showMainWindow(vpnAutoConnectMode ? 'tools/vpn' : '');
  if (vpnAutoConnectMode) void connectVpn(vpnAutoConnectMode, vpnAutoConnectSource);
  app.on('activate', () => showMainWindow());
});
app.on('before-quit', (event) => {
  isQuitting = true;
  stopMacCoreWatchdog();
  if (!quitAfterCleanup) {
    event.preventDefault();
    if (quitCleanupPending) return;
    quitCleanupPending = true;
    void disconnectVpn().then((status) => {
      if (status.state === 'idle') { quitAfterCleanup = true; app.quit(); }
      else { isQuitting = false; updateInstallRequested = false; showMainWindow('tools/vpn'); }
    }).catch((error) => {
      isQuitting = false;
      updateInstallRequested = false;
      console.error('Could not clean up the VPN before quitting:', error);
      showMainWindow('tools/vpn');
    }).finally(() => { quitCleanupPending = false; });
  }
});
app.on('will-quit', () => {
  classReminderScheduler?.stop();
  stopMacCoreWatchdog();
  macUpdater?.stop();
  // A downloaded + verified update is installed after the app exits (not during a system shutdown/restart).
  if (!updateInstallRequested && !systemShuttingDown && !updateVerifyOnly) macUpdater?.installOnQuit();
});
// macOS: closing the last window keeps the app (and the class reminder scheduler) running.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
