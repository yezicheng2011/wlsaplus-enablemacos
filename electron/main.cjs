const { app, BrowserWindow, Notification, ipcMain, safeStorage, session, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const nodeHttps = require('node:https');
const nodeNet = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { autoUpdater } = require('electron-updater');
const { VPN_CONNECTION_MODES, buildVpnConfig } = require('./vpn-config.cjs');
const { updateFeed } = require('./update-config.cjs');
const { validateExternalHelpUrl } = require('./external-links.cjs');
const { getVpnSource, subscriptionUrl } = require('./vpn-sources.cjs');
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
const VPN_PORT = 17890;
let vpnProcess = null;
let vpnDisconnecting = false;
let vpnStatus = { state: 'idle', message: 'Ready', connectedAt: null, mode: 'full-tunnel' };
let vpnProcessError = '';
let quitAfterCleanup = false;
let updateInstallRequested = false;
let updateFeedSource = 'mirror';
const vpnDnsCache = new Map();
const updatesSupported = process.platform === 'win32' && app.isPackaged;
let updateStatus = {
  state: updatesSupported ? 'idle' : 'unsupported',
  message: updatesSupported ? 'Ready to check for updates.' : 'Automatic updates are not enabled in this macOS build.',
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
};

const preload = path.join(__dirname, 'preload.cjs');
const credentialFile = () => path.join(app.getPath('userData'), 'credentials.bin');
const vpnDirectory = () => path.join(app.getPath('userData'), 'vpn');
const vpnConfigFile = () => path.join(vpnDirectory(), 'config.json');
const vpnProxyStateFile = () => path.join(vpnDirectory(), 'proxy-state.json');
const powerSchoolSession = () => session.fromPartition('persist:powerschool');
const appSession = () => session.fromPartition('persist:wlsaplus');
const iconPath = () => path.join(__dirname, '..', 'build', 'icon.png');

function rendererIndexPath() {
  return path.join(__dirname, '..', 'dist', 'wlsaplus', 'browser', 'index.html');
}

function appUrl(route = '') {
  const dev = process.env.WLSAPLUS_DEV_URL;
  if (dev) return `${dev}/#/${route}`;
  return `file://${rendererIndexPath().replace(/\\/g, '/')}#/${route}`;
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

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function setVpnStatus(patch) {
  vpnStatus = { ...vpnStatus, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vpn:status', vpnStatus);
  }
  return vpnStatus;
}

function vpnCorePath() {
  const executable = 'sing-box';
  return app.isPackaged ? path.join(process.resourcesPath, 'vpn-core', executable) : path.join(__dirname, '..', 'build', 'vpn-core', executable);
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

function listClashProxyNodes(document) {
  if (!document || !Array.isArray(document.proxies)) return [];
  const nodes = [];
  const seen = new Set();
  for (const proxy of document.proxies) {
    const name = typeof proxy?.name === 'string' ? proxy.name.trim() : '';
    if (!name || seen.has(name)) continue;
    if (!proxy.server || !proxy.port) continue;
    seen.add(name);
    nodes.push({
      id: name,
      name,
      type: typeof proxy.type === 'string' ? proxy.type : 'unknown',
      server: String(proxy.server),
      port: Number(proxy.port),
    });
  }
  return nodes;
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

function applySelectedClashNode(document, nodeName) {
  const nodes = listClashProxyNodes(document);
  if (!nodes.length) throw new Error('The VPN subscription did not include any nodes.');
  const selected = nodes.some((node) => node.id === nodeName) ? nodeName : nodes[0].id;
  const next = { ...document };
  // Keep Mac TUN defaults if the subscription omitted them.
  next.tun = {
    enable: true,
    stack: 'gvisor',
    'auto-route': true,
    'auto-detect-interface': true,
    'dns-hijack': ['8.8.8.8:53', 'tcp://8.8.8.8:53'],
    ...(document.tun && typeof document.tun === 'object' ? document.tun : {}),
    enable: true,
  };
  if (Array.isArray(document['proxy-groups'])) {
    next['proxy-groups'] = document['proxy-groups'].map((group) => {
      if (!group || group.type !== 'select' || !Array.isArray(group.proxies) || !group.proxies.includes(selected)) {
        return group;
      }
      return { ...group, proxies: [selected, ...group.proxies.filter((name) => name !== selected)] };
    });
  }
  return { document: next, selected, nodes };
}

function parseClashShadowsocksProfile(body) {
  const document = parseClashDocument(body);
  const candidate = Array.isArray(document?.proxies)
    ? document.proxies.find((proxy) => proxy?.type === 'ss' && proxy.server && proxy.port && proxy.cipher && proxy.password)
    : null;
  if (!candidate) return null;
  const plugin = candidate.plugin ? String(candidate.plugin) : undefined;
  if (plugin && plugin !== 'v2ray-plugin') throw new Error(`The subscription requires an unsupported plugin: ${plugin}.`);
  return {
    server: String(candidate.server),
    serverPort: Number(candidate.port),
    method: String(candidate.cipher),
    password: String(candidate.password),
    plugin,
    pluginOptions: candidate['plugin-opts'] ? String(candidate['plugin-opts']) : undefined,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
  };
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
  let body = '';
  let nodes = [];
  try {
    body = await fetchSubscriptionBody(sourceId, 'clash');
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
  return { nodes, body, document };
}

async function fetchVpnProfile(sourceId = 'relay', nodeName = '') {
  try {
    const { document, nodes } = await fetchVpnNodes(sourceId);
    const selected = nodes.some((node) => node.id === nodeName) ? nodeName : nodes[0].id;
    const proxy = (document.proxies || []).find((item) => item?.name === selected);
    if (proxy?.type === 'ss' && proxy.server && proxy.port && proxy.cipher && proxy.password) {
      const plugin = proxy.plugin ? String(proxy.plugin) : undefined;
      if (plugin && plugin !== 'v2ray-plugin') throw new Error(`The selected node requires an unsupported plugin: ${plugin}.`);
      return {
        server: String(proxy.server),
        serverPort: Number(proxy.port),
        method: String(proxy.cipher),
        password: String(proxy.password),
        plugin,
        pluginOptions: proxy['plugin-opts'] ? String(proxy['plugin-opts']) : undefined,
        name: selected,
      };
    }
    // Non-SS nodes are still usable by the Mac clash helper via YAML selection.
    return { name: selected, clashDocument: document };
  } catch (error) {
    // Fall back to legacy SS-only parsing.
    const body = await fetchSubscriptionBody(sourceId, 'ss');
    const clashProfile = parseClashShadowsocksProfile(body);
    if (clashProfile) return clashProfile;
    const decoded = body.startsWith('ss://') ? body : decodeBase64Url(body);
    const profile = decoded.split(/\r?\n/).find((line) => line.startsWith('ss://'));
    if (!profile) throw new Error(`${getVpnSource(sourceId).name} did not return a usable Shadowsocks profile.`);
    return parseShadowsocksUri(profile);
  }
}

async function resolveVpnServer(profile) {
  if (nodeNet.isIP(profile.server)) return profile;
  const [address] = await resolvePublicIpv4(profile.server);
  return { ...profile, server: address };
}

async function writeVpnConfig(profile, mode) {
  const config = buildVpnConfig(profile, mode, VPN_PORT);
  await fs.mkdir(vpnDirectory(), { recursive: true });
  await fs.writeFile(vpnConfigFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}


function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', updateStatus);
  }
  return updateStatus;
}

async function validateVpnConfig(core) {
  try {
    await execFileAsync(core, ['check', '-c', vpnConfigFile()], { windowsHide: true });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || '').trim();
    throw new Error(detail || 'The generated VPN configuration is invalid.');
  }
}




async function restartVpnElevated(mode, sourceId = 'relay', nodeName = '') {
  if (process.platform !== 'darwin') {
    throw new Error('Administrator VPN restart is only available on macOS.');
  }

  const { execFile, execSync } = require('node:child_process');
  const fsSync = require('node:fs');

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

  try {
    execSync(`mkdir -p ${JSON.stringify(targetDir)}`);
    execSync(`tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(targetDir)}`);
    if (!fsSync.existsSync(execPath)) throw new Error('VPN helper binary was not found after extraction.');
    execSync(`chmod +x ${JSON.stringify(execPath)}`);
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

  const scriptContent = `#!/bin/bash
"${execPath}" -d "${clashPkgDir}" > /dev/null 2>&1 &
`;
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
    const applied = applySelectedClashNode(document, nodeName);
    const configPath = path.join(clashPkgDir, 'config.yaml');
    fsSync.writeFileSync(configPath, yaml.dump(applied.document, { lineWidth: -1, noRefs: true }), 'utf8');
    nodeName = applied.selected;
  } catch (err) {
    // Keep bundled config.yaml if subscription refresh fails — still try to pin node name locally.
    try {
      const configPath = path.join(clashPkgDir, 'config.yaml');
      if (fsSync.existsSync(configPath)) {
        const document = parseClashDocument(fsSync.readFileSync(configPath, 'utf8'));
        const applied = applySelectedClashNode(document, nodeName);
        fsSync.writeFileSync(configPath, yaml.dump(applied.document, { lineWidth: -1, noRefs: true }), 'utf8');
        nodeName = applied.selected;
      }
    } catch {
      /* continue with the packaged default config */
    }
  }

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

  const escapedScript = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', `do shell script "${escapedScript}" with administrator privileges`], (error, stdout) => {
      if (error) {
        const detail = String(error.message || error.stderr || '');
        if (/User canceled|user cancelled|-128|authorization canceled/i.test(detail) || error.code === 1 || error.code === 128) {
          resolve(setVpnStatus({
            state: 'idle',
            message: 'Administrator approval was cancelled. Tap Connect to try again.',
            connectedAt: null,
            mode,
            requiresElevation: true,
          }));
          return;
        }
        setVpnStatus({
          state: 'error',
          message: 'Could not start the macOS VPN after authorization.',
          connectedAt: null,
          mode,
          requiresElevation: true,
        });
        reject(error);
        return;
      }
      resolve(setVpnStatus({
        state: 'connected',
        message: nodeName ? `Connected · ${nodeName}` : 'Connected with macOS VPN helper',
        connectedAt: new Date().toISOString(),
        mode,
        sourceId: getVpnSource(sourceId).id,
        nodeName: nodeName || undefined,
        requiresElevation: false,
      }));
    });
  });
}

async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = nodeNet.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(400, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(180);
  }
  throw new Error('The VPN core did not start in time.');
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

async function probeVpnUrls(probeSession, urls, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.any(urls.map(async (url) => {
      const response = await probeSession.fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
      return response.status;
    }));
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function verifyVpnConnection(mode) {
  const probeSession = session.fromPartition('wlsaplus-vpn-probe');
  await probeSession.setProxy(mode === 'full-tunnel'
    ? { mode: 'direct' }
    : { mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${VPN_PORT};https=127.0.0.1:${VPN_PORT}` });
  try {
    const urls = [
      'https://www.gstatic.com/generate_204',
      'https://www.cloudflare.com/cdn-cgi/trace',
      'https://weixin.qq.com/',
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await probeSession.closeAllConnections().catch(() => {});
      await probeSession.clearHostResolverCache().catch(() => {});
      try {
        await probeVpnUrls(probeSession, urls, 10_000);
        return;
      } catch {
        if (attempt < 2) await delay(800 * (attempt + 1));
      }
    }
    throw new Error(`WLSAPlus relay started, but ${mode === 'full-tunnel' ? 'tunneled DNS' : 'the proxy'} did not become ready. Please reconnect.`);
  } finally {
    await probeSession.setProxy({ mode: 'direct' }).catch(() => {});
    await probeSession.closeAllConnections().catch(() => {});
  }
}




async function readMacProxy(service, kind) {
  const { stdout } = await execFileAsync('networksetup', [`-get${kind}proxy`, service]);
  const values = Object.fromEntries(stdout.split(/\r?\n/).map((line) => line.match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1].trim(), match[2].trim()]));
  return { enabled: values.Enabled === 'Yes', server: values.Server || '', port: Number(values.Port || 0) };
}

async function captureSystemProxyState() {
  if (process.platform !== 'darwin') throw new Error('VPN system proxy is only available on macOS.');
  const { stdout } = await execFileAsync('networksetup', ['-listallnetworkservices']);
  const services = stdout.split(/\r?\n/).slice(1).map((value) => value.trim()).filter((value) => value && !value.startsWith('*'));
  return { platform: 'darwin', services: await Promise.all(services.map(async (service) => ({ service, web: await readMacProxy(service, 'web'), secure: await readMacProxy(service, 'secureweb') }))) };
}

async function enableSystemProxy() {
  const state = await captureSystemProxyState();
  await fs.mkdir(vpnDirectory(), { recursive: true });
  await fs.writeFile(vpnProxyStateFile(), JSON.stringify(state), { mode: 0o600 });
  for (const item of state.services) {
    await execFileAsync('networksetup', ['-setwebproxy', item.service, '127.0.0.1', String(VPN_PORT)]);
    await execFileAsync('networksetup', ['-setsecurewebproxy', item.service, '127.0.0.1', String(VPN_PORT)]);
    await execFileAsync('networksetup', ['-setwebproxystate', item.service, 'on']);
    await execFileAsync('networksetup', ['-setsecurewebproxystate', item.service, 'on']);
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

async function restoreSavedSystemProxy() {
  const state = await readJson(vpnProxyStateFile(), null);
  if (state) await restoreSystemProxy(state);
}

async function stopVpnProcess() {
  const child = vpnProcess;
  vpnProcess = null;
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill();
  });
}

function normalizeVpnMode(value) {
  return VPN_CONNECTION_MODES.has(value) ? value : 'full-tunnel';
}

async function connectVpn(requestedMode = 'full-tunnel', requestedSource = 'relay', nodeName = '') {
  const mode = normalizeVpnMode(requestedMode);
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
  if (vpnProcess) await disconnectVpn();

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

async function disconnectVpn() {
  const mode = normalizeVpnMode(vpnStatus.mode);
  setVpnStatus({ state: 'disconnecting', message: 'Disconnecting...', mode, requiresElevation: false });
  vpnDisconnecting = true;
  await restoreSavedSystemProxy().catch(() => {});
  await stopVpnProcess();
  vpnDisconnecting = false;
  return setVpnStatus({ state: 'idle', message: 'Ready', connectedAt: null, mode, requiresElevation: false });
}

function updaterErrorMessage(error) {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (/net::|network|internet|ENOTFOUND|ETIMEDOUT|ECONN/u.test(detail)) return 'Could not check for updates. Check your internet connection.';
  return 'The update service is temporarily unavailable.';
}

function configureUpdateFeed(source) {
  autoUpdater.setFeedURL(updateFeed(source));
  updateFeedSource = source;
}

async function checkForAppUpdate() {
  if (!updatesSupported) return updateStatus;
  if (updateStatus.state === 'checking' || updateStatus.state === 'downloading' || updateStatus.state === 'ready') return updateStatus;
  setUpdateStatus({ state: 'checking', message: 'Checking for updates...', percent: null });
  try {
    configureUpdateFeed('mirror');
    await autoUpdater.checkForUpdates();
  } catch {
    setUpdateStatus({ state: 'checking', message: 'Update mirror unavailable. Trying GitHub...', percent: null });
    try {
      configureUpdateFeed('github');
      await autoUpdater.checkForUpdates();
    } catch (error) {
      setUpdateStatus({ state: 'error', message: updaterErrorMessage(error), percent: null });
    }
  }
  return updateStatus;
}

async function downloadAppUpdate() {
  if (!updatesSupported || updateStatus.state !== 'available') return updateStatus;
  setUpdateStatus({ state: 'downloading', message: `Downloading WLSAPlus ${updateStatus.version}...`, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    if (updateFeedSource !== 'mirror') {
      setUpdateStatus({ state: 'error', message: updaterErrorMessage(error), percent: null });
      return updateStatus;
    }
    const version = updateStatus.version;
    setUpdateStatus({ state: 'checking', message: 'Update mirror unavailable. Trying GitHub...', percent: null });
    try {
      configureUpdateFeed('github');
      await autoUpdater.checkForUpdates();
      setUpdateStatus({ state: 'downloading', message: `Downloading WLSAPlus ${version}...`, version, percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (fallbackError) {
      setUpdateStatus({ state: 'error', message: updaterErrorMessage(fallbackError), percent: null });
    }
  }
  return updateStatus;
}

async function cleanupBeforeUpdate() {
  if (updateInstallRequested) return;
  updateInstallRequested = true;
  isQuitting = true;
  if (vpnProcess || vpnStatus.state === 'connected') await disconnectVpn().catch(() => {});
  quitAfterCleanup = true;
}

async function installAppUpdate() {
  if (!updatesSupported || updateStatus.state !== 'ready') return updateStatus;
  setUpdateStatus({ state: 'installing', message: 'Closing WLSAPlus and installing the update...', percent: 100 });
  await cleanupBeforeUpdate();
  autoUpdater.quitAndInstall(false, true);
  return updateStatus;
}

function configureAppUpdater() {
  if (!updatesSupported) return;
  configureUpdateFeed('mirror');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'available', message: `WLSAPlus ${info.version} is available.`, version: info.version, percent: null }));
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'up-to-date', message: 'WLSAPlus is up to date.', version: null, percent: null }));
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
    setUpdateStatus({ state: 'downloading', message: `Downloading update: ${percent}%`, percent });
  });
  autoUpdater.on('update-downloaded', (info) => setUpdateStatus({ state: 'ready', message: `WLSAPlus ${info.version} is ready to install.`, version: info.version, percent: 100 }));
  autoUpdater.on('error', (error) => {
    if (updateStatus.state !== 'installing') setUpdateStatus({ state: 'error', message: updaterErrorMessage(error), percent: null });
  });
}


async function translateWithGoogle(value, source, target) {
  const params = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: value });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`);
  if (!response.ok) throw new Error('Google Translate is unavailable.');
  const result = await response.json();
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error('The translation response was invalid.');
  return { text: result[0].map((part) => Array.isArray(part) ? String(part[0] || '') : '').join(''), detectedLanguage: typeof result[2] === 'string' ? result[2] : source };
}

async function translateWithMyMemory(value, source, target) {
  const params = new URLSearchParams({ q: value, langpair: `${source === 'auto' ? 'Autodetect' : source}|${target}` });
  const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
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
  mainWindow = new BrowserWindow({ width: 1220, height: 820, minWidth: 380, minHeight: 600, backgroundColor: '#f7f8fa', title: 'WLSAPlus', icon: iconPath(), webPreferences: webPreferences() });
  configureExternalHelpLinks(mainWindow);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription} @ ${validatedURL}`);
  });
  const indexFile = rendererIndexPath();
  const { existsSync } = require('node:fs');
  if (!process.env.WLSAPLUS_DEV_URL && !existsSync(indexFile)) {
    console.error(`WLSAPlus UI missing at ${indexFile}. Run npm run build:web before packaging or starting Electron.`);
  }
  mainWindow.loadURL(appUrl(route));
}

function showMainWindow(route = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(route);
    return;
  }
  if (route) void mainWindow.loadURL(appUrl(route));
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

ipcMain.handle('credentials:get', async () => {
  try {
    const encrypted = await fs.readFile(credentialFile());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch { return null; }
});
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
  const response = await powerSchoolSession().fetch(requestUrl.toString(), {
    method: options.method === 'POST' ? 'POST' : 'GET',
    headers,
    body: options.method === 'POST' ? String(options.body || '') : undefined,
    redirect: 'follow',
  });
  return { status: response.status, url: response.url, text: await response.text() };
});
ipcMain.handle('powerschool:clear-session', async (_event, baseUrl) => {
  const origin = validateBaseUrl(baseUrl);
  await powerSchoolSession().clearStorageData({ origin, storages: ['cookies'] });
});

ipcMain.handle('vpn:status', () => vpnStatus);
ipcMain.handle('vpn:connect', (_event, mode, sourceId, nodeName) => connectVpn(mode, sourceId, nodeName));
ipcMain.handle('vpn:list-nodes', async (_event, sourceId) => {
  const { nodes } = await fetchVpnNodes(sourceId || 'relay');
  return nodes;
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
ipcMain.handle('vpn:restart-elevated', (_event, mode, sourceId, nodeName) => restartVpnElevated(normalizeVpnMode(mode), sourceId, nodeName));
ipcMain.handle('updater:status', () => updateStatus);
ipcMain.handle('updater:check', () => checkForAppUpdate());
ipcMain.handle('updater:download', () => downloadAppUpdate());
ipcMain.handle('updater:install', () => installAppUpdate());
ipcMain.handle('translator:translate', (_event, text, source, target) => translateText(text, source, target));
ipcMain.handle('translator:capture-region', () => Promise.reject(new Error('Screen translation is not available on macOS.')));

ipcMain.handle('notifications:show-class-reminder', (_event, options) => {
  if (process.platform !== 'darwin') return false;
  if (!Notification.isSupported()) return false;
  const title = String(options?.title || 'Class starting soon').slice(0, 120);
  const body = String(options?.body || '').slice(0, 240);
  const notification = new Notification({ title, body, silent: false });
  notification.show();
  return true;
});

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--prepare-update')) {
      void cleanupBeforeUpdate().finally(() => app.quit());
      return;
    }
    if (!commandLine.includes('--autostart')) showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (prepareUpdateMode) {
    await cleanupBeforeUpdate();
    app.quit();
    return;
  }
  configureAppUpdater();
  await restoreSavedSystemProxy().catch(() => {});
  await appSession().clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  if (!isAutostart || vpnAutoConnectMode) showMainWindow(vpnAutoConnectMode ? 'tools/vpn' : '');
  if (vpnAutoConnectMode) void connectVpn(vpnAutoConnectMode, vpnAutoConnectSource);
  if (updatesSupported && !vpnAutoConnectMode) {
    const updateTimer = setTimeout(() => void checkForAppUpdate(), 8_000);
    updateTimer.unref();
  }
  app.on('activate', showMainWindow);
});
app.on('before-quit', (event) => {
  isQuitting = true;
  if ((vpnProcess || vpnStatus.state === 'connected') && !quitAfterCleanup) {
    event.preventDefault();
    void disconnectVpn().finally(() => { quitAfterCleanup = true; app.quit(); });
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
