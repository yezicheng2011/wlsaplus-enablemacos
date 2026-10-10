const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const {
  appleScriptElevatedCommand,
  macClashProcessPattern,
  stopMacClashProcess,
} = require('./mac-clash-controller.cjs');

const execPath = '/Users/demo/Library/Application Support/WLSAPlus/vpn-bin/clash_pkg/clash';
const missingProcess = () => Object.assign(new Error('No matching process'), { code: 1 });

test('helper stop avoids administrator approval when no helper exists', async () => {
  const calls = [];
  const result = await stopMacClashProcess({ execPath, run: async (command) => {
    calls.push(command);
    throw missingProcess();
  } });
  assert.deepEqual(result, { stopped: true, cancelled: false });
  assert.deepEqual(calls, ['/usr/bin/pgrep']);
});

test('successful unprivileged kill must wait until the process disappears', async () => {
  let probes = 0;
  let waits = 0;
  const result = await stopMacClashProcess({ execPath, wait: async () => { waits += 1; }, run: async (command) => {
    if (command === '/usr/bin/pgrep' && ++probes === 4) throw missingProcess();
    assert.notEqual(command, 'osascript');
  } });
  assert.deepEqual(result, { stopped: true, cancelled: false });
  assert.equal(probes, 4);
  assert.equal(waits, 2);
});

test('elevated stop quotes an exact executable regex through AppleScript and the shell', async () => {
  const specialPath = `/Users/O'Neil/Library/Application Support/a."b"[x]$(ignored)\\name/clash`;
  let running = true;
  let source;
  const result = await stopMacClashProcess({ execPath: specialPath, wait: async () => {}, run: async (command, args) => {
    if (command === '/usr/bin/pgrep' && !running) throw missingProcess();
    if (command === '/usr/bin/pkill') throw Object.assign(new Error('Operation not permitted'), { code: 1 });
    if (command === 'osascript') { source = args[1]; running = false; }
  } });
  assert.deepEqual(result, { stopped: true, cancelled: false });
  const literal = source.match(/^do shell script ("(?:[^"\\]|\\.)*") with administrator privileges$/)?.[1];
  assert.ok(literal, 'AppleScript contains one properly escaped command string');
  const command = JSON.parse(literal);
  assert.ok(command.startsWith('/usr/bin/pkill '));
  // Parse the command with a real shell without executing pkill, to verify the final argv.
  const args = execFileSync('/bin/sh', ['-c', `set -- ${command.slice('/usr/bin/pkill '.length)}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(args, ['-TERM', '-f', macClashProcessPattern(specialPath)]);
  const pattern = new RegExp(args[2]);
  assert.ok(pattern.test(`${specialPath} -d /somewhere`));
  assert.ok(!pattern.test(`${specialPath}-other -d /somewhere`));
  assert.ok(!pattern.test(`osascript -e ${command}`));
});

test('an elevated command returning success is not proof that the core exited', async () => {
  const result = await stopMacClashProcess({ execPath, run: async () => {}, wait: async () => {} });
  assert.deepEqual(result, { stopped: false, cancelled: false });
});

test('cancelled approval retains the running core; failed probes never imply a stopped core', async () => {
  const result = await stopMacClashProcess({ execPath, wait: async () => {}, run: async (command) => {
    if (command === 'osascript') throw new Error('execution error: User canceled. (-128)');
  } });
  assert.deepEqual(result, { stopped: false, cancelled: true });
  await assert.rejects(stopMacClashProcess({ execPath, run: async () => {
    throw Object.assign(new Error('pgrep unavailable'), { code: 'ENOENT' });
  } }), /pgrep unavailable/);
});

test('macOS compiler accepts the generated elevated stop AppleScript', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsaplus-stop-script-'));
  try {
    execFileSync('/usr/bin/osacompile', ['-o', path.join(dir, 'stop.scpt'), '-e', appleScriptElevatedCommand(`/usr/bin/pkill -TERM -f '${macClashProcessPattern(execPath)}'`)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), 'expected lifecycle operation to reach the next stage');
}

// Execute the actual main process with OS/network boundaries replaced, including its real IPC,
// app event registration and async connection/disconnection functions. No Electron or VPN starts.
function mainHarness({ fetchNodes, verifyCore } = {}) {
  const filename = path.join(__dirname, 'main.cjs');
  const localRequire = createRequire(filename);
  const windows = [];
  const statuses = [];
  const approvals = [];
  const state = { running: false, failStop: false, cancelledStop: false, stopCalls: 0, quitCalls: 0, verifying: false, fetches: 0 };
  let ready;
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    getVersion: () => '1.1.1',
    getPath: () => '/Users/demo/Library/Application Support/WLSAPlus',
    whenReady: () => ({ then: (callback) => { ready = callback; } }),
    quit: () => { state.quitCalls += 1; },
    isPackaged: false,
  });
  class Window {
    constructor() {
      this.loads = [];
      this.shown = 0;
      this.focused = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        send: (_channel, status) => statuses.push({ ...status }),
      });
      windows.push(this);
    }
    static getAllWindows() { return windows; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    async loadFile(file, options) { this.loads.push({ file, ...options }); }
  }
  const handlers = new Map();
  const electron = {
    app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    powerMonitor: new EventEmitter(),
  };
  const childProcess = {
    execFile(command, args, callback) {
      assert.equal(command, 'osascript');
      approvals.push({ source: args[1], finish(error) { if (!error) state.running = true; callback(error, ''); } });
    },
    execSync() {},
  };
  const fsSync = { existsSync: () => true, writeFileSync() {}, rmSync() {} };
  const fsPromises = { readFile: async () => { throw new Error('No saved proxy configuration'); } };
  const controller = {
    ...localRequire('./mac-clash-controller.cjs'),
    stopMacClashProcess: async ({ elevated }) => {
      state.stopCalls += 1;
      if (state.running && (!elevated || state.failStop)) return { stopped: false, cancelled: state.cancelledStop };
      state.running = false;
      return { stopped: true, cancelled: false };
    },
    waitForCore: async (_request, options) => { state.verifying = true; return verifyCore ? verifyCore(options) : true; },
    enforceSelectedNode: async (_request, _groups, selected) => ({ ok: true, actual: selected }),
    createWatchdog: () => ({ stop() {} }),
  };
  const hooks = {
    fetchNodes: async () => {
      state.fetches += 1;
      if (fetchNodes) return fetchNodes();
      return { document: { proxies: [{ name: 'HK-1', type: 'ss', server: 'example.test', port: 443 }], 'proxy-groups': [{ name: 'select', type: 'select', proxies: ['HK-1'] }] } };
    },
  };
  const context = {
    require: (id) => ({ electron, 'node:child_process': childProcess, 'node:fs': fsSync, 'node:fs/promises': fsPromises, './mac-clash-controller.cjs': controller }[id] || localRequire(id)),
    process: { platform: 'darwin', argv: [], env: {}, arch: 'arm64', resourcesPath: '/resources' },
    __dirname, module: { exports: {} }, hooks, console: { log() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer,
  };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}
    fetchVpnNodes = hooks.fetchNodes;
    configureAppUpdater = () => {};
    classReminders = () => null;
    module.exports = {
      connect: connectVpn, disconnect: disconnectVpn, cleanupBeforeUpdate, quitForUpdate,
      state: () => ({ status: { ...vpnStatus }, isQuitting, updateInstallRequested, quitAfterCleanup }),
    };
  `, context, { filename });
  return { ...context.module.exports, os: state, app, windows, statuses, approvals, ready: () => ready(), ipc: (name, ...args) => handlers.get(name)({}, ...args) };
}

test('disconnect during a subscription fetch prevents late startup or administrator approval', async () => {
  const nodes = deferred();
  const app = mainHarness({ fetchNodes: () => nodes.promise });
  const connect = app.connect();
  await until(() => app.os.fetches === 1);
  const disconnect = app.disconnect();
  nodes.reject(new Error('late network failure'));
  await Promise.all([connect, disconnect]);
  assert.equal(app.approvals.length, 0);
  assert.equal(app.state().status.state, 'idle');
});

test('disconnect waits for a pending authorization and cleans up the newly started core', async () => {
  const app = mainHarness();
  const connect = app.connect();
  await until(() => app.approvals.length === 1);
  const disconnect = app.disconnect();
  assert.equal(app.disconnect(), disconnect, 'concurrent disconnects share one cleanup operation');
  assert.equal(app.state().status.state, 'disconnecting');
  await app.connect();
  assert.equal(app.approvals.length, 1, 'connect cannot race a pending disconnect');
  app.approvals[0].finish();
  await Promise.all([connect, disconnect]);
  assert.equal(app.os.running, false);
  assert.equal(app.os.verifying, false, 'canceled startup never publishes connected');
  assert.equal(app.state().status.state, 'idle');
});

test('duplicate connects share one pending administrator approval', async () => {
  const app = mainHarness();
  const first = app.connect();
  const duplicate = app.ipc('vpn:restart-elevated', 'full-tunnel', 'relay', 'HK-1');
  await until(() => app.approvals.length === 1);
  app.approvals[0].finish();
  await Promise.all([first, duplicate]);
  assert.equal(app.os.fetches, 1);
  assert.equal(app.approvals.length, 1);
  assert.equal(app.state().status.state, 'connected');
});

test('failed or canceled stops retain a retryable connected status until exit is confirmed', async () => {
  for (const cancelled of [false, true]) {
    const app = mainHarness();
    const connect = app.connect();
    await until(() => app.approvals.length === 1);
    app.approvals[0].finish();
    await connect;
    app.os.failStop = true;
    app.os.cancelledStop = cancelled;
    const failed = await app.disconnect();
    assert.equal(failed.state, 'connected');
    assert.match(failed.message, /VPN may still be running/);
    assert.equal(app.os.running, true);
    app.os.failStop = false;
    assert.equal((await app.disconnect()).state, 'idle');
    assert.equal(app.os.running, false);
  }
});

test('quit during controller startup cancels verification and stops the root core before exit', async () => {
  const verification = deferred();
  const app = mainHarness({ verifyCore: () => verification.promise });
  const connect = app.connect();
  await until(() => app.approvals.length === 1);
  app.approvals[0].finish();
  await until(() => app.os.verifying);
  assert.equal(app.os.running, true);
  assert.equal(app.state().status.state, 'connecting');
  let prevented = 0;
  app.app.emit('before-quit', { preventDefault: () => { prevented += 1; } });
  app.app.emit('before-quit', { preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(app.os.quitCalls, 0);
  verification.resolve(true);
  await connect;
  await until(() => app.os.quitCalls === 1);
  assert.equal(app.os.running, false);
  assert.equal(app.state().status.state, 'idle');
});

test('quitting during an existing disconnect still exits after cleanup', async () => {
  const app = mainHarness();
  const connect = app.connect();
  await until(() => app.approvals.length === 1);
  const disconnect = app.disconnect();
  app.app.emit('before-quit', { preventDefault() {} });
  app.approvals[0].finish();
  await Promise.all([connect, disconnect]);
  await until(() => app.os.quitCalls === 1);
  assert.equal(app.os.running, false);
});

test('quit and update preparation do not proceed after failed core cleanup', async () => {
  const app = mainHarness();
  app.os.running = true; // includes stale cores after an earlier startup error
  app.os.failStop = true;
  await assert.rejects(app.cleanupBeforeUpdate(), /Disconnect the VPN before installing/);
  assert.equal(app.state().isQuitting, false);
  assert.equal(app.state().updateInstallRequested, false);
  app.app.emit('before-quit', { preventDefault() {} });
  await until(() => app.state().isQuitting === false);
  assert.equal(app.os.quitCalls, 0);
  assert.equal(app.state().status.state, 'connected');
  assert.equal(app.windows[0].loads[0].hash, '/tools/vpn');
});

test('update preparation cancels a pending connection and leaves quit flags untouched', async () => {
  const app = mainHarness();
  const connect = app.connect();
  await until(() => app.approvals.length === 1);
  const prepared = app.cleanupBeforeUpdate();
  app.approvals[0].finish();
  await Promise.all([connect, prepared]);
  assert.equal(app.os.running, false);
  assert.equal(app.state().isQuitting, false, 'channel cancellation can leave the app running');
  assert.equal(app.state().updateInstallRequested, false);
  assert.equal(app.state().quitAfterCleanup, false);
  assert.equal(app.os.quitCalls, 0);
  app.quitForUpdate();
  assert.equal(app.state().isQuitting, true);
  assert.equal(app.state().updateInstallRequested, true);
  assert.equal(app.os.quitCalls, 1);
});

test('Dock activation focuses the existing window without turning the event into a route', async () => {
  const app = mainHarness();
  await app.ready();
  assert.equal(app.windows.length, 1);
  const window = app.windows[0];
  assert.equal(window.loads.length, 1);
  app.app.emit('activate', { type: 'activate' }, true);
  assert.equal(window.loads.length, 1, 'current route and unsaved renderer state are preserved');
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
});
