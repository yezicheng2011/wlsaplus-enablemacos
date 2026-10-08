const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  MAC_CLASH_CONTROLLER_PORT,
  newControllerSecret,
  applyControllerSettings,
  applySelectedClashNode,
  controllerRequest,
  isCoreUp,
  waitForCore,
  groupsContainingNode,
  enforceSelectedNode,
  connectedStatusFor,
  tailLines,
  createWatchdog,
} = require('./mac-clash-controller.cjs');

const SUBSCRIPTION = yaml.load(`
external-controller: 0.0.0.0:9090
external-controller-tls: 0.0.0.0:9443
external-ui: ui
secret: ''
profile:
  store-fake-ip: true
proxies:
  - { name: HK-1, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: p }
  - { name: JP-2, type: ss, server: 2.2.2.2, port: 443, cipher: aes-128-gcm, password: p }
proxy-groups:
  - { name: 🔰 选择节点, type: select, proxies: [♻️ 自动选择, HK-1, JP-2] }
  - { name: ♻️ 自动选择, type: url-test, proxies: [HK-1, JP-2] }
  - { name: 🌍 国外媒体, type: select, proxies: [🔰 选择节点, JP-2, HK-1] }
  - { name: 🐟 漏网之鱼, type: select, proxies: [🔰 选择节点, DIRECT] }
`);

test('controller is loopback-only on a fixed port with a per-connect secret; store-selected is off', () => {
  const secret = newControllerSecret();
  assert.match(secret, /^[0-9a-f]{48}$/);
  assert.notEqual(secret, newControllerSecret());
  const next = applyControllerSettings(SUBSCRIPTION, secret);
  assert.equal(next['external-controller'], `127.0.0.1:${MAC_CLASH_CONTROLLER_PORT}`);
  assert.equal(MAC_CLASH_CONTROLLER_PORT, 19097);
  assert.equal(next.secret, secret);
  assert.deepEqual(next.profile, { 'store-fake-ip': true, 'store-selected': false });
  assert.equal(next['external-controller-tls'], undefined);
  assert.equal(next['external-ui'], undefined);
  assert.ok(!yaml.dump(next).includes('0.0.0.0'));
  assert.equal(SUBSCRIPTION['external-controller'], '0.0.0.0:9090', 'input is not mutated');
  assert.throws(() => applyControllerSettings(SUBSCRIPTION, ''), /secret/);
  assert.throws(() => applyControllerSettings(null, secret), /configuration/);
});

test('applySelectedClashNode pins the node, keeps TUN on and forces the controller', () => {
  const secret = newControllerSecret();
  const { document, selected, nodes } = applySelectedClashNode(SUBSCRIPTION, 'JP-2', { secret });
  assert.equal(selected, 'JP-2');
  assert.equal(nodes.length, 2);
  assert.deepEqual(document['proxy-groups'][0].proxies, ['JP-2', '♻️ 自动选择', 'HK-1']);
  assert.deepEqual(document['proxy-groups'][2].proxies, ['JP-2', '🔰 选择节点', 'HK-1']);
  assert.deepEqual(document['proxy-groups'][3].proxies, ['🔰 选择节点', 'DIRECT']);
  assert.equal(document.tun.enable, true);
  assert.equal(document.profile['store-selected'], false);
  assert.equal(document.secret, secret);
  // Unknown node falls back to the first; without a secret the controller is left alone (legacy callers).
  const fallback = applySelectedClashNode(SUBSCRIPTION, 'nope');
  assert.equal(fallback.selected, 'HK-1');
  assert.equal(fallback.document['external-controller'], '0.0.0.0:9090');
  assert.throws(() => applySelectedClashNode({ proxies: [] }, 'x', { secret }), /did not include any nodes/);
});

test('groupsContainingNode returns select groups listing the node, top group first', () => {
  assert.deepEqual(groupsContainingNode(SUBSCRIPTION, 'HK-1'), ['🔰 选择节点', '🌍 国外媒体']);
  assert.deepEqual(groupsContainingNode(SUBSCRIPTION, 'missing'), []);
  assert.deepEqual(groupsContainingNode(null, 'HK-1'), []);
});

test('connectedStatusFor reports a warning and the actual node when enforcement failed', () => {
  assert.deepEqual(connectedStatusFor('JP-2', { ok: true, actual: 'JP-2' }), { message: 'Connected · JP-2', nodeName: 'JP-2' });
  assert.deepEqual(connectedStatusFor('JP-2', { ok: false, actual: 'HK-1' }), { message: 'Connected · HK-1 (selected node could not be applied)', nodeName: 'HK-1' });
  assert.deepEqual(connectedStatusFor('', { ok: true, actual: null }), { message: 'Connected with macOS VPN helper', nodeName: undefined });
});

test('tailLines keeps the last non-empty lines', () => {
  assert.equal(tailLines('a\n\nb\nc\n', 2), 'b\nc');
  assert.equal(tailLines(undefined), '');
});

// --- Mock mihomo controller -------------------------------------------------------------------

function mockController({ secret, groups, ignorePut = false }) {
  const state = { requests: [], groups: structuredClone(groups) };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('{"message":"Unauthorized"}'); return; }
      if (req.method === 'GET' && req.url === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"meta":true,"version":"v1.19.0"}'); return; }
      const match = req.url.match(/^\/proxies\/(.+)$/);
      const name = match ? decodeURIComponent(match[1]) : '';
      const group = state.groups[name];
      if (!group) { res.writeHead(404); res.end('{"message":"Resource not found"}'); return; }
      if (req.method === 'PUT') {
        const wanted = JSON.parse(body).name;
        if (!ignorePut && group.all.includes(wanted)) group.now = wanted;
        res.writeHead(204); res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, type: 'Selector', ...group }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

const GROUPS = {
  '🔰 选择节点': { now: 'HK-1', all: ['♻️ 自动选择', 'HK-1', 'JP-2'] },
  '🌍 国外媒体': { now: '🔰 选择节点', all: ['🔰 选择节点', 'JP-2', 'HK-1'] },
};

test('controllerRequest sends the bearer secret and parses JSON', async (t) => {
  const secret = newControllerSecret();
  const mock = await mockController({ secret, groups: GROUPS });
  t.after(() => mock.server.close());
  const ok = await controllerRequest({ port: mock.port, secret, path: '/version' });
  assert.deepEqual(ok, { status: 200, body: { meta: true, version: 'v1.19.0' } });
  assert.equal(mock.state.requests[0].auth, `Bearer ${secret}`);
  const request = (options) => controllerRequest({ port: mock.port, secret, ...options });
  assert.equal(await isCoreUp(request), true);
  // A core with another secret (stale instance / other app on the port) is not "our" core.
  assert.equal(await isCoreUp((options) => controllerRequest({ port: mock.port, secret: 'wrong', ...options })), false);
});

test('isCoreUp is false when nothing listens; waitForCore gives up at the deadline', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const request = (options) => controllerRequest({ port, secret: 'x'.repeat(32), timeoutMs: 300, ...options });
  assert.equal(await isCoreUp(request), false);
  let clock = 0;
  const up = await waitForCore(request, { timeoutMs: 1000, intervalMs: 400, now: () => clock, wait: async (ms) => { clock += ms; } });
  assert.equal(up, false);
  assert.ok(clock >= 1000);
});

test('waitForCore succeeds once the core answers and stops when cancelled', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return calls < 3 ? Promise.reject(new Error('ECONNREFUSED')) : { status: 200, body: { version: 'v1' } }; };
  assert.equal(await waitForCore(request, { wait: async () => {} }), true);
  assert.equal(calls, 3);
  assert.equal(await waitForCore(request, { cancelled: () => true }), false);
});

test('enforceSelectedNode switches every group and verifies `now`', async (t) => {
  const secret = newControllerSecret();
  const mock = await mockController({ secret, groups: GROUPS });
  t.after(() => mock.server.close());
  const request = (options) => controllerRequest({ port: mock.port, secret, ...options });
  const result = await enforceSelectedNode(request, ['🔰 选择节点', '🌍 国外媒体'], 'JP-2');
  assert.equal(result.ok, true);
  assert.equal(result.actual, 'JP-2');
  const puts = mock.state.requests.filter((r) => r.method === 'PUT');
  assert.deepEqual(puts.map((r) => r.url), [`/proxies/${encodeURIComponent('🔰 选择节点')}`, `/proxies/${encodeURIComponent('🌍 国外媒体')}`]);
  assert.deepEqual(JSON.parse(puts[0].body), { name: 'JP-2' });
});

test('enforceSelectedNode reports the actual node when the core keeps another selection', async (t) => {
  const secret = newControllerSecret();
  const mock = await mockController({ secret, groups: GROUPS, ignorePut: true });
  t.after(() => mock.server.close());
  const request = (options) => controllerRequest({ port: mock.port, secret, ...options });
  const result = await enforceSelectedNode(request, ['🔰 选择节点'], 'JP-2');
  assert.equal(result.ok, false);
  assert.equal(result.actual, 'HK-1');
  assert.equal(connectedStatusFor('JP-2', result).message, 'Connected · HK-1 (selected node could not be applied)');
  const missing = await enforceSelectedNode(request, ['nope'], 'JP-2');
  assert.deepEqual(missing, { ok: false, actual: null, groups: [{ name: 'nope', now: null }] });
});

test('watchdog fires once after two consecutive failures and resets on success', async () => {
  let tick;
  let cleared = 0;
  const results = [false, true, false, false, false];
  let dead = 0;
  const watchdog = createWatchdog({
    check: async () => results.shift(),
    onDead: () => { dead += 1; },
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => { cleared += 1; },
  });
  await tick(); assert.equal(dead, 0);
  await tick(); assert.equal(dead, 0); // success resets the counter
  await tick(); assert.equal(dead, 0);
  await tick(); assert.equal(dead, 1);
  assert.equal(watchdog.isStopped(), true);
  assert.equal(cleared, 1);
  await tick(); assert.equal(dead, 1, 'stopped watchdog never fires again');
});

test('a stopped watchdog (intentional disconnect) never reports an error', async () => {
  let tick;
  let dead = 0;
  const watchdog = createWatchdog({ check: async () => false, onDead: () => { dead += 1; }, setIntervalFn: (fn) => { tick = fn; return 1; }, clearIntervalFn: () => {} });
  await tick();
  watchdog.stop();
  await tick();
  await tick();
  assert.equal(dead, 0);
});

test('main.cjs wires verification, watchdog and core.log for the mac helper', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /> "\$\{logPath\}" 2>&1 &/);
  assert.ok(!/clashPkgDir\}" > \/dev\/null/.test(main), 'core output is no longer discarded');
  assert.match(main, /resolve\(verifyMacCoreStarted\(/);
  assert.match(main, /'The VPN core did not start'/);
  assert.match(main, /'VPN core exited unexpectedly'/);
  const disconnect = main.slice(main.indexOf('async function disconnectVpn()'));
  assert.ok(disconnect.indexOf('stopMacCoreWatchdog()') < disconnect.indexOf('stopMacClashHelper('), 'watchdog stops before the helper is killed');
  const forge = require(path.join('..', 'forge.config.cjs'));
  assert.equal(forge.packagerConfig.ignore('/electron/mac-clash-controller.cjs'), false);
});
