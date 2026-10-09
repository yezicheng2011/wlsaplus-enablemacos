// Local mihomo (Clash Meta) controller helpers for the macOS VPN.
//
// The elevated core is started in the background by osascript, which returns immediately, so the
// app must ask the core itself whether it is running (GET /version) and which node it really uses
// (GET/PUT /proxies/<group>). The controller listens on loopback only and requires a per-connect
// secret that never leaves the main process.
const crypto = require('node:crypto');
const http = require('node:http');

const MAC_CLASH_CONTROLLER_HOST = '127.0.0.1';
const MAC_CLASH_CONTROLLER_PORT = 19097;
const CONTROLLER_REQUEST_TIMEOUT_MS = 1500;
const CORE_START_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const WATCHDOG_MAX_FAILURES = 2;

function newControllerSecret() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Forces a loopback-only, secret-protected controller and disables mihomo's store-selected, which
 * otherwise restores the previous selection from cache.db in the (root-owned, never reset) -d dir
 * and silently overrides the node the user picked.
 */
function applyControllerSettings(document, secret, port = MAC_CLASH_CONTROLLER_PORT) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid VPN configuration.');
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('Invalid VPN controller secret.');
  const next = { ...document };
  for (const key of ['external-controller-tls', 'external-controller-unix', 'external-controller-pipe', 'external-ui', 'external-ui-url', 'external-ui-name']) {
    delete next[key];
  }
  next['external-controller'] = `${MAC_CLASH_CONTROLLER_HOST}:${port}`;
  next.secret = secret;
  const profile = document.profile && typeof document.profile === 'object' && !Array.isArray(document.profile) ? document.profile : {};
  next.profile = { ...profile, 'store-selected': false };
  return next;
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

/**
 * Pins the selected node first in every select group that lists it (the default when
 * store-selected is off), keeps Mac TUN defaults, and — when a controller secret is given —
 * forces the loopback controller + store-selected:false so the choice cannot be overridden.
 */
function applySelectedClashNode(document, nodeName, { secret, port = MAC_CLASH_CONTROLLER_PORT } = {}) {
  const nodes = listClashProxyNodes(document);
  if (!nodes.length) throw new Error('The VPN subscription did not include any nodes.');
  const selected = nodes.some((node) => node.id === nodeName) ? nodeName : nodes[0].id;
  let next = { ...document };
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
  if (secret !== undefined) next = applyControllerSettings(next, secret, port);
  return { document: next, selected, nodes };
}

/** Minimal JSON client for the local controller. Resolves { status, body }; rejects on network errors. */
function controllerRequest({ port = MAC_CLASH_CONTROLLER_PORT, secret, method = 'GET', path: requestPath, body, timeoutMs = CONTROLLER_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const request = http.request({ host: MAC_CLASH_CONTROLLER_HOST, port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1_000_000) chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode || 0, body: parsed });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Controller request timed out.')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/** True only when OUR core answers (a 401 means some other process/secret owns the port). */
async function isCoreUp(request) {
  try {
    const response = await request({ method: 'GET', path: '/version' });
    return response.status === 200 && Boolean(response.body && typeof response.body === 'object' && response.body.version);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCore(request, { timeoutMs = CORE_START_TIMEOUT_MS, intervalMs = 500, now = () => Date.now(), wait = sleep, cancelled = () => false } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (cancelled()) return false;
    if (await isCoreUp(request)) return true;
    if (now() >= deadline) return false;
    await wait(intervalMs);
  }
}

/** Pure: select groups that list the node directly, in config order (the top group first). */
function groupsContainingNode(document, nodeName) {
  if (!document || !Array.isArray(document['proxy-groups']) || !nodeName) return [];
  return document['proxy-groups']
    .filter((group) => group && group.type === 'select' && typeof group.name === 'string' && Array.isArray(group.proxies) && group.proxies.includes(nodeName))
    .map((group) => group.name);
}

/**
 * PUTs the node into every group that contains it, then reads the groups back.
 * Returns { ok, actual, groups: [{ name, now }] } — ok means every group reports `now === selected`;
 * `actual` is what the primary (first) group really uses.
 */
async function enforceSelectedNode(request, groups, selected) {
  const results = [];
  for (const name of groups) {
    const groupPath = `/proxies/${encodeURIComponent(name)}`;
    try { await request({ method: 'PUT', path: groupPath, body: { name: selected } }); } catch { /* verified below */ }
    let now = null;
    try {
      const response = await request({ method: 'GET', path: groupPath });
      if (response.status === 200 && response.body && typeof response.body.now === 'string') now = response.body.now;
    } catch { /* unknown */ }
    results.push({ name, now });
  }
  const ok = results.length > 0 && results.every((item) => item.now === selected);
  const actual = results[0]?.now || null;
  return { ok, actual, groups: results };
}

/** Pure: status fields for a connected core given the enforcement result. */
function connectedStatusFor(selected, enforcement) {
  if (!selected) return { message: 'Connected with macOS VPN helper', nodeName: undefined };
  if (enforcement.ok) return { message: `Connected · ${selected}`, nodeName: selected };
  const actual = enforcement.actual || selected;
  return { message: `Connected · ${actual} (selected node could not be applied)`, nodeName: actual };
}

function tailLines(text, count = 6) {
  return String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-count).join('\n');
}

/** Polls `check` every interval; after `maxFailures` consecutive false results calls onDead once and stops. */
function createWatchdog({ check, onDead, intervalMs = WATCHDOG_INTERVAL_MS, maxFailures = WATCHDOG_MAX_FAILURES, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let failures = 0;
  let busy = false;
  let stopped = false;
  const timer = setIntervalFn(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const up = await check();
      if (stopped) return;
      failures = up ? 0 : failures + 1;
      if (failures >= maxFailures) {
        stop();
        onDead();
      }
    } finally {
      busy = false;
    }
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  }
  return { stop, isStopped: () => stopped };
}


/**
 * True only when the user dismissed the macOS admin password dialog.
 * Bare exit code 1 is NOT cancel: after a successful grant, `do shell script` still exits 1 when
 * the shell command fails (classic trap: an unquoted path under "Application Support").
 */
function isOsascriptAuthCancelled(error) {
  if (!error) return false;
  const detail = [error.message, error.stderr, error.stdout].map((value) => String(value || '')).join('\n');
  if (/User canceled\.?|user cancelled|authorization canceled|(?:^|[^0-9-])-128(?:\b|[^0-9])/i.test(detail)) {
    return true;
  }
  const code = error.code ?? error.status;
  return code === -128 || code === 128;
}

/**
 * AppleScript that runs a script file as root. `do shell script <string>` feeds the string to
 * `sh -c`, so paths with spaces (userData lives under Application Support) must be shell-quoted
 * via AppleScript `quoted form of` — not pasted raw into the -e string.
 */
function appleScriptElevatedRun(scriptPath) {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) throw new Error('Invalid elevate script path.');
  const escaped = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `do shell script quoted form of "${escaped}" with administrator privileges`;
}

module.exports = {
  MAC_CLASH_CONTROLLER_HOST,
  MAC_CLASH_CONTROLLER_PORT,
  CORE_START_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_MAX_FAILURES,
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
};
