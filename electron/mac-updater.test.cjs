const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { signPayload } = require('./update-core.cjs');
const { createMacUpdater, validMarkerPath, bundlePathFromExe, argValue } = require('./mac-updater.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const helperSource = path.join(__dirname, 'update-helper.sh');

function manifestFor(version, zip, { channel = 'stable', key = privateKey } = {}) {
  return JSON.stringify(signPayload({
    product: 'wlsaplus-macos',
    version,
    tag: `v${version}`,
    channel,
    minimumSystemVersion: '13.0',
    files: {
      arm64: { name: `WLSAPlus-${version}-mac-arm64.zip`, size: zip.length, sha256: sha(zip) },
      x64: { name: `WLSAPlus-${version}-mac-x64.zip`, size: zip.length, sha256: sha(zip) },
    },
  }, key));
}

/** Fake feed: { '/api/latest': json, '/download/<tag>/<name>': body } */
async function feedServer(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.push(url);
    const body = routes[url];
    if (body === undefined) { res.writeHead(404); res.end('nope'); return; }
    if (typeof body === 'function') { body(req, res); return; }
    res.writeHead(200);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
}

/** check() returns once the check is done; the download continues in the background. */
async function settled(updater) {
  await updater.check();
  return updater.idle();
}

function fakeMac({ plistVersion, archs = 'x86_64 arm64', codesignFails = false } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ditto') {
      fs.mkdirSync(path.join(args[3], 'WLSAPlus.app', 'Contents', 'MacOS'), { recursive: true });
      return '';
    }
    if (command === 'codesign' && codesignFails) throw new Error('codesign failed: invalid signature');
    if (command === '/usr/libexec/PlistBuddy') return args[1].includes('CFBundleIdentifier') ? 'cn.org.wlsash.wlsaplus\n' : `${plistVersion}\n`;
    if (command === 'lipo') return `${archs}\n`;
    return '';
  };
  return { run, calls };
}

function setup(t, { currentVersion = '1.1.0', routes, mac, argv = [], exePath = '/Applications/WLSAPlus.app/Contents/MacOS/WLSAPlus', fetchImpl = undefined, writable = true, supported = true, arch = 'arm64', launchedByUpdater = false, beforeInstall = async () => {}, accessImpl }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-upd-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const spawned = [];
  const statuses = [];
  const full = [];
  let quits = 0;
  let cleanups = 0;
  return feedServer(routes).then(({ server, hits, base }) => {
    t.after(() => server.close());
    const updater = createMacUpdater({
      currentVersion,
      userData,
      exePath,
      arch,
      systemVersion: '14.5',
      supported,
      env: { WLSAPLUS_UPDATE_BASE_URL: base },
      argv,
      run: mac.run,
      spawnDetached: (command, args) => spawned.push([command, ...args]),
      helperSource,
      beforeInstall: async () => { cleanups += 1; await beforeInstall(); },
      quit: () => { quits += 1; },
      onStatus: (status) => { statuses.push(status.state); full.push(status); },
      accessImpl: accessImpl || (async () => { if (!writable) throw new Error('EACCES'); }),
      publicKeyPem,
      launchedByUpdater,
      ...(fetchImpl ? { fetchImpl } : {}),
      pid: 4242,
    });
    return { updater, userData, spawned, statuses, full, hits, base, counts: () => ({ quits, cleanups }) };
  });
}

test('unsupported (dev / non-mac) builds never touch the network', async (t) => {
  const ctx = await setup(t, { routes: {}, mac: fakeMac(), supported: false });
  await ctx.updater.loadSettings();
  assert.equal((await settled(ctx.updater)).state, 'unsupported');
  assert.deepEqual(ctx.hits, []);
});

test('stable release without update-manifest.json (e.g. 1.0.9) means up to date', async (t) => {
  const ctx = await setup(t, { routes: { '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [{ name: 'wlsaplus1.0.9.zip' }] }) }, mac: fakeMac() });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'up-to-date');
  assert.equal(status.channel, 'stable');
  assert.ok(!ctx.hits.includes('/download/channel-beta/update-manifest.json'), 'stable channel never asks for the beta manifest');
});

test('stable update: download, verify, stage, then Restart spawns the helper and quits', async (t) => {
  const zip = crypto.randomBytes(5000);
  const mac = fakeMac({ plistVersion: '1.1.1' });
  const ctx = await setup(t, {
    mac,
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.version, '1.1.1');
  assert.ok(ctx.statuses.includes('downloading'));
  assert.ok(ctx.hits.includes('/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip'));
  const commands = mac.calls.map((c) => c.slice(0, 2).join(' '));
  assert.ok(commands.includes('ditto -x'));
  assert.ok(mac.calls.some((c) => c[0] === 'codesign' && c.includes('--strict')));
  assert.ok(mac.calls.some((c) => c[0] === 'codesign' && c.some((a) => a.startsWith('-R=identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"'))));
  const helper = path.join(ctx.userData, 'updates', 'update-helper.sh');
  assert.equal(fs.readFileSync(helper, 'utf8'), fs.readFileSync(helperSource, 'utf8'));
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(ctx.userData, 'updates', 'staging', '1.1.1', 'WLSAPlus-1.1.1-mac-arm64.zip')), false, 'zip removed after unpacking');

  await ctx.updater.install();
  assert.deepEqual(ctx.counts(), { quits: 1, cleanups: 1 });
  assert.equal(ctx.spawned.length, 1);
  const args = ctx.spawned[0];
  assert.equal(args[0], '/bin/bash');
  assert.equal(args[1], helper);
  const opt = (name) => args[args.indexOf(name) + 1];
  assert.equal(opt('--target'), '/Applications/WLSAPlus.app');
  assert.equal(opt('--pid'), '4242');
  assert.equal(opt('--mode'), 'restart');
  assert.equal(opt('--admin'), '0');
  assert.equal(opt('--version'), '1.1.1');
  assert.equal(opt('--from'), '1.1.0');
  assert.equal(opt('--staged'), path.join(ctx.userData, 'updates', 'staging', '1.1.1', 'app', 'WLSAPlus.app'));
  assert.ok(validMarkerPath(ctx.userData, opt('--marker')));
});

test('prerelease builds default to the beta channel and take the newest beta', async (t) => {
  const zip = crypto.randomBytes(3000);
  const ctx = await setup(t, {
    currentVersion: '1.1.0-beta.1',
    mac: fakeMac({ plistVersion: '1.1.1-beta.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [{ name: 'wlsaplus1.0.9.zip' }] }),
      '/download/channel-beta/update-manifest.json': manifestFor('1.1.1-beta.1', zip, { channel: 'beta' }),
      '/download/v1.1.1-beta.1/WLSAPlus-1.1.1-beta.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.channel, 'beta');
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.version, '1.1.1-beta.1');
});

test('a stable build ignores beta builds unless the test channel is switched on', async (t) => {
  const zip = crypto.randomBytes(3000);
  const ctx = await setup(t, {
    currentVersion: '1.1.0',
    mac: fakeMac({ plistVersion: '1.1.1-beta.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.0', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.0/update-manifest.json': manifestFor('1.1.0', zip),
      '/download/channel-beta/update-manifest.json': manifestFor('1.1.1-beta.1', zip, { channel: 'beta' }),
      '/download/v1.1.1-beta.1/WLSAPlus-1.1.1-beta.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  assert.equal((await settled(ctx.updater)).state, 'up-to-date');
  await ctx.updater.setChannel('beta');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.userData, 'updates', 'settings.json'), 'utf8')).channel, 'beta');
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.version, '1.1.1-beta.1');
});

test('--update-channel=beta launch flag enables the test channel', async (t) => {
  const ctx = await setup(t, { routes: {}, mac: fakeMac(), argv: ['--update-channel=beta'] });
  await ctx.updater.loadSettings();
  assert.equal(ctx.updater.getChannel(), 'beta');
  assert.equal(argValue(['--x=1', '--update-channel=beta'], 'update-channel'), 'beta');
});

test('a manifest signed with another key is rejected', async (t) => {
  const zip = crypto.randomBytes(100);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const ctx = await setup(t, {
    mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip, { key: other }),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'error');
  assert.match(status.message, /signature is invalid/);
  assert.ok(!ctx.hits.some((hit) => hit.endsWith('.zip')), 'nothing downloaded');
});

test('an app whose bundle version does not match the manifest is not staged', async (t) => {
  const zip = crypto.randomBytes(100);
  const ctx = await setup(t, {
    mac: fakeMac({ plistVersion: '9.9.9' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'error');
  assert.match(status.message, /contains version 9\.9\.9/);
  assert.equal(fs.existsSync(path.join(ctx.userData, 'updates', 'staging', '1.1.1')), false);
  await ctx.updater.install();
  assert.equal(ctx.spawned.length, 0);
});

test('codesign failures and wrong architectures block the update', async (t) => {
  const zip = crypto.randomBytes(100);
  const routes = {
    '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
    '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
    '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
  };
  const a = await setup(t, { mac: fakeMac({ plistVersion: '1.1.1', codesignFails: true }), routes });
  await a.updater.loadSettings();
  assert.match((await settled(a.updater)).message, /codesign failed/);
  const b = await setup(t, { mac: fakeMac({ plistVersion: '1.1.1', archs: 'x86_64' }), routes });
  await b.updater.loadSettings();
  assert.match((await settled(b.updater)).message, /built for x86_64/);
});

test('a translocated app asks to be moved to Applications instead of downloading', async (t) => {
  const zip = crypto.randomBytes(100);
  const ctx = await setup(t, {
    exePath: '/private/var/folders/xy/T/AppTranslocation/ABC/d/WLSAPlus.app/Contents/MacOS/WLSAPlus',
    mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  const status = await settled(ctx.updater);
  assert.equal(status.state, 'error');
  assert.match(status.message, /Applications folder/);
  assert.ok(!ctx.hits.some((hit) => hit.endsWith('.zip')));
});

test('non-writable install location: Restart uses the admin path, quit-install is skipped', async (t) => {
  const zip = crypto.randomBytes(100);
  const ctx = await setup(t, {
    writable: false,
    mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  assert.equal((await settled(ctx.updater)).state, 'ready');
  assert.equal(ctx.updater.installOnQuit(), false);
  await ctx.updater.install();
  const args = ctx.spawned[0];
  assert.equal(args[args.indexOf('--admin') + 1], '1');
});

test('install on quit spawns the helper in quit mode once', async (t) => {
  const zip = crypto.randomBytes(100);
  const ctx = await setup(t, {
    mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  assert.equal(ctx.updater.installOnQuit(), false, 'nothing staged yet');
  await settled(ctx.updater);
  assert.equal(ctx.updater.installOnQuit(), true);
  assert.equal(ctx.updater.installOnQuit(), false);
  const args = ctx.spawned[0];
  assert.equal(args[args.indexOf('--mode') + 1], 'quit');
  assert.equal(ctx.counts().quits, 0);
});

test('a rolled-back version is remembered and not offered again', async (t) => {
  const zip = crypto.randomBytes(100);
  const ctx = await setup(t, {
    mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  const updatesDir = path.join(ctx.userData, 'updates');
  fs.mkdirSync(path.join(updatesDir, 'backup', 'WLSAPlus.app'), { recursive: true });
  fs.writeFileSync(path.join(updatesDir, 'last-result.json'), JSON.stringify({ state: 'rolled_back', from: '1.1.0', to: '1.1.1' }));
  await ctx.updater.loadSettings();
  await ctx.updater.consumeLastResult();
  assert.equal(ctx.updater.getStatus().state, 'error');
  assert.match(ctx.updater.getStatus().message, /did not start/);
  assert.equal(fs.existsSync(path.join(updatesDir, 'last-result.json')), false);
  assert.equal(fs.existsSync(path.join(updatesDir, 'backup')), false, 'old backup cleaned up');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(updatesDir, 'settings.json'), 'utf8')).failedVersions, ['1.1.1']);
  assert.equal((await settled(ctx.updater)).state, 'up-to-date');
});

test('a successful update is reported once after restart', async (t) => {
  const ctx = await setup(t, { currentVersion: '1.1.1', routes: {}, mac: fakeMac() });
  fs.mkdirSync(path.join(ctx.userData, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(ctx.userData, 'updates', 'last-result.json'), JSON.stringify({ state: 'updated', from: '1.1.0', to: '1.1.1' }));
  await ctx.updater.loadSettings();
  await ctx.updater.consumeLastResult();
  assert.equal(ctx.updater.getStatus().state, 'up-to-date');
  assert.match(ctx.updater.getStatus().message, /Updated to WLSAPlus 1\.1\.1/);
});

test('marker paths are confined to the staging folder; bundle path comes from the executable', () => {
  const userData = '/Users/u/Library/Application Support/WLSAPlus';
  assert.equal(validMarkerPath(userData, `${userData}/updates/staging/1.1.1/launched.marker`), `${userData}/updates/staging/1.1.1/launched.marker`);
  assert.equal(validMarkerPath(userData, `${userData}/updates/staging/../../credentials.bin`), null);
  assert.equal(validMarkerPath(userData, '/etc/launched.marker'), null);
  assert.equal(validMarkerPath(userData, null), null);
  assert.equal(bundlePathFromExe('/Applications/WLSAPlus.app/Contents/MacOS/WLSAPlus'), '/Applications/WLSAPlus.app');
  assert.equal(bundlePathFromExe('/usr/local/bin/electron'), null);
});

test('an app launched by the helper keeps the staging folder (marker) and the backup (rollback)', async (t) => {
  const ctx = await setup(t, { currentVersion: '1.1.1', routes: {}, mac: fakeMac(), launchedByUpdater: true });
  const updatesDir = path.join(ctx.userData, 'updates');
  fs.mkdirSync(path.join(updatesDir, 'staging', '1.1.1'), { recursive: true });
  fs.mkdirSync(path.join(updatesDir, 'backup', 'WLSAPlus.app'), { recursive: true });
  await ctx.updater.loadSettings();
  await ctx.updater.consumeLastResult();
  assert.equal(fs.existsSync(path.join(updatesDir, 'staging', '1.1.1')), true);
  assert.equal(fs.existsSync(path.join(updatesDir, 'backup', 'WLSAPlus.app')), true);
});

// --- Regression tests for the beta.2 report: "Checking for updates..." then a blank row, no download ---

const readLog = (ctx) => { try { return fs.readFileSync(path.join(ctx.userData, 'updates', 'update.log'), 'utf8'); } catch { return ''; } };
const betaRoutes = (zip, extra = {}) => ({
  '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [{ name: 'wlsaplus1.0.9.zip' }] }),
  '/download/channel-beta/update-manifest.json': manifestFor('1.1.1-beta.3', zip, { channel: 'beta' }),
  ...extra,
});

test('check() returns as soon as the download starts; the download finishes in the background', async (t) => {
  const zip = crypto.randomBytes(4000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = await setup(t, {
    currentVersion: '1.1.0-beta.3',
    mac: fakeMac({ plistVersion: '1.1.1-beta.3' }),
    routes: betaRoutes(zip, {
      '/download/v1.1.1-beta.3/WLSAPlus-1.1.1-beta.3-mac-arm64.zip': (req, res) => { void gate.then(() => { res.writeHead(200); res.end(zip); }); },
    }),
  });
  await ctx.updater.loadSettings();
  const replied = await ctx.updater.check();
  assert.ok(['available', 'downloading'].includes(replied.state), `check() replied with ${replied.state}`);
  assert.equal(replied.version, '1.1.1-beta.3');
  assert.ok(replied.message.length > 0);
  // A second click while downloading is a no-op that also replies immediately.
  assert.equal((await ctx.updater.check()).state, ctx.updater.getStatus().state);
  release();
  const done = await ctx.updater.idle();
  assert.equal(done.state, 'ready', done.message);
  // Every status the UI received had a message and an increasing seq.
  assert.ok(ctx.full.every((s) => typeof s.message === 'string' && s.message.trim().length > 0));
  assert.ok(ctx.full.every((s, i) => i === 0 || s.seq > ctx.full[i - 1].seq));
});

test('every outcome of a check ends in a non-busy state with a visible message', async (t) => {
  const zip = crypto.randomBytes(1000);
  const cases = [
    ['up to date (beta)', { currentVersion: '1.1.1-beta.3', routes: betaRoutes(zip) }, 'up-to-date', /up to date \(test builds on\)/u],
    ['no test build published', { currentVersion: '1.1.0-beta.3', routes: { '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [] }) } }, 'up-to-date', /up to date/u],
    ['site down', { currentVersion: '1.1.0-beta.3', routes: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); } }, 'error', /Could not check for updates/u],
    ['bad signature', { currentVersion: '1.1.0-beta.3', routes: { '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [] }), '/download/channel-beta/update-manifest.json': manifestFor('1.1.1-beta.3', zip, { channel: 'beta', key: crypto.generateKeyPairSync('ed25519').privateKey }) } }, 'error', /signature/u],
    ['download fails', { currentVersion: '1.1.0-beta.3', routes: betaRoutes(zip) }, 'error', /Update failed/u],
    ['unexpected exception', { currentVersion: '1.1.0-beta.3', routes: betaRoutes(zip), exePath: null }, 'error', /Could not check for updates/u],
  ];
  for (const [name, options, state, message] of cases) {
    const ctx = await setup(t, { mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), ...options });
    await ctx.updater.loadSettings();
    const final = await settled(ctx.updater);
    assert.equal(final.state, state, `${name}: ${final.message}`);
    assert.match(final.message, message, name);
    assert.ok(!['checking', 'downloading', 'installing'].includes(final.state), name);
    assert.ok(ctx.full.every((s) => typeof s.message === 'string' && s.message.trim()), `${name}: blank message`);
  }
});

test('a beta build with no saved setting uses the beta channel and finds the beta update', async (t) => {
  const zip = crypto.randomBytes(1000);
  const ctx = await setup(t, { currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: betaRoutes(zip, { '/download/v1.1.1-beta.3/WLSAPlus-1.1.1-beta.3-mac-arm64.zip': zip }) });
  await ctx.updater.loadSettings();
  assert.equal(ctx.updater.getChannel(), 'beta');
  assert.equal((await settled(ctx.updater)).state, 'ready');
  assert.ok(ctx.hits.includes('/download/channel-beta/update-manifest.json'));
});

test('check results are written to updates/update.log', async (t) => {
  const zip = crypto.randomBytes(1000);
  const ctx = await setup(t, { currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: betaRoutes(zip) });
  await ctx.updater.loadSettings();
  await settled(ctx.updater);
  await ctx.updater.log('flush');
  const text = readLog(ctx);
  assert.match(text, /check \(manual\): version 1\.1\.0-beta\.3, channel beta, arch arm64/u);
  assert.match(text, /GET http:\/\/127\.0\.0\.1:\d+\/api\/latest -> 200/u);
  assert.match(text, /manifest channel-beta: version 1\.1\.1-beta\.3/u);
  assert.match(text, /chosen: 1\.1\.1-beta\.3/u);
  assert.match(text, /download\/verify FAILED: .*404/u);
  assert.match(text, /status error: Update failed/u);
});

test('a check error from an unexpected exception is logged with its stack', async (t) => {
  const zip = crypto.randomBytes(1000);
  const ctx = await setup(t, { currentVersion: '1.1.0-beta.3', mac: fakeMac(), routes: betaRoutes(zip), exePath: null });
  await ctx.updater.loadSettings();
  const final = await settled(ctx.updater);
  assert.equal(final.state, 'error');
  await ctx.updater.log('flush');
  assert.match(readLog(ctx), /check: unexpected error: TypeError/u);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const readyBetaRoutes = (zip) => betaRoutes(zip, {
  '/download/v1.1.1-beta.3/WLSAPlus-1.1.1-beta.3-mac-arm64.zip': zip,
});

test('turning off beta synchronously revokes a staged beta and deletes it before resolving', async (t) => {
  const zip = crypto.randomBytes(1000);
  const ctx = await setup(t, { currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: readyBetaRoutes(zip) });
  await ctx.updater.loadSettings();
  assert.equal((await settled(ctx.updater)).state, 'ready');
  const stagedDir = path.dirname(ctx.updater.staged.marker);
  const switching = ctx.updater.setChannel('stable');
  assert.equal(ctx.updater.staged, null);
  assert.equal(ctx.updater.installOnQuit(), false, 'revoked even before settings finish saving');
  await ctx.updater.install();
  await switching;
  assert.equal(ctx.updater.getStatus().state, 'idle');
  assert.equal(ctx.updater.getStatus().version, null);
  assert.equal(fs.existsSync(stagedDir), false);
  assert.equal(ctx.spawned.length, 0);
  assert.equal((await settled(ctx.updater)).state, 'up-to-date', 'stable can be checked immediately');
});

test('turning off beta preserves an already staged stable release', async (t) => {
  const zip = crypto.randomBytes(1000);
  const ctx = await setup(t, {
    currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1' }),
    routes: {
      '/api/latest': JSON.stringify({ tag: 'v1.1.1', assets: [{ name: 'update-manifest.json' }] }),
      '/download/v1.1.1/update-manifest.json': manifestFor('1.1.1', zip),
      '/download/v1.1.1/WLSAPlus-1.1.1-mac-arm64.zip': zip,
    },
  });
  await ctx.updater.loadSettings();
  assert.equal((await settled(ctx.updater)).state, 'ready');
  await ctx.updater.setChannel('stable');
  assert.equal(ctx.updater.getStatus().state, 'ready');
  assert.equal(ctx.updater.installOnQuit(), true);
  assert.equal(ctx.spawned.length, 1);
});

test('a beta manifest that finishes after a channel change cannot overwrite a fresh stable check', async (t) => {
  const zip = crypto.randomBytes(1000);
  const requested = deferred();
  const response = deferred();
  t.after(() => response.resolve());
  const ctx = await setup(t, {
    currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: readyBetaRoutes(zip),
    fetchImpl: async (url, options) => {
      if (url.includes('/channel-beta/')) {
        requested.resolve();
        // A completed response can race with cancellation; deliberately ignore the signal here.
        await response.promise;
        return new Response(manifestFor('1.1.1-beta.3', zip, { channel: 'beta' }));
      }
      return fetch(url, options);
    },
  });
  await ctx.updater.loadSettings();
  const oldCheck = ctx.updater.check();
  await requested.promise;
  await ctx.updater.setChannel('stable');
  assert.equal((await settled(ctx.updater)).state, 'up-to-date');
  response.resolve();
  await oldCheck;
  assert.equal(ctx.updater.getStatus().state, 'up-to-date');
  assert.equal(ctx.updater.staged, null);
  assert.equal(ctx.hits.some((url) => url.endsWith('.zip')), false);
});

test('turning off beta aborts an in-flight download without retrying or staging it', async (t) => {
  const zip = crypto.randomBytes(1000);
  const requested = deferred();
  let aborted = false;
  let zipRequests = 0;
  const ctx = await setup(t, {
    currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: readyBetaRoutes(zip),
    fetchImpl: async (url, options) => {
      if (url.endsWith('.zip')) {
        zipRequests += 1;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
          requested.resolve();
        });
      }
      return fetch(url, options);
    },
  });
  await ctx.updater.loadSettings();
  await ctx.updater.check();
  await requested.promise;
  await ctx.updater.setChannel('stable');
  await ctx.updater.idle();
  assert.equal(aborted, true);
  assert.equal(zipRequests, 1);
  assert.equal(ctx.updater.getStatus().state, 'idle');
  assert.equal(ctx.updater.staged, null);
  assert.equal(fs.existsSync(path.join(ctx.userData, 'updates', 'staging', '1.1.1-beta.3')), false);
  assert.equal(ctx.statuses.includes('ready'), false);
});

test('a channel change during app verification waits for staging cleanup before another check', async (t) => {
  const zip = crypto.randomBytes(1000);
  const verifying = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const mac = fakeMac({ plistVersion: '1.1.1-beta.3' });
  const run = mac.run;
  mac.run = async (command, args) => {
    if (command === 'codesign') { verifying.resolve(); await release.promise; }
    return run(command, args);
  };
  const ctx = await setup(t, { currentVersion: '1.1.0-beta.3', mac, routes: readyBetaRoutes(zip) });
  await ctx.updater.loadSettings();
  await ctx.updater.check();
  await verifying.promise;
  // Start a check just before the switch, so it initially awaits the previous cleanup promise.
  const nextCheck = ctx.updater.check();
  const switching = ctx.updater.setChannel('stable');
  await new Promise(setImmediate);
  assert.equal(ctx.updater.getStatus().state, 'idle');
  release.resolve();
  await switching;
  await nextCheck;
  assert.equal(ctx.updater.getStatus().state, 'up-to-date');
  assert.equal(ctx.updater.staged, null);
  assert.equal(ctx.statuses.includes('ready'), false);
  assert.equal(fs.existsSync(path.join(ctx.userData, 'updates', 'staging', '1.1.1-beta.3')), false);
});

test('restart rechecks the channel after asynchronous location and cleanup steps', async (t) => {
  for (const phase of ['location', 'cleanup']) {
    await t.test(phase, async (t) => {
      const zip = crypto.randomBytes(1000);
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      let block = false;
      const pause = async () => { if (block) { entered.resolve(); await release.promise; } };
      const ctx = await setup(t, {
        currentVersion: '1.1.0-beta.3', mac: fakeMac({ plistVersion: '1.1.1-beta.3' }), routes: readyBetaRoutes(zip),
        ...(phase === 'location' ? { accessImpl: pause } : { beforeInstall: pause }),
      });
      await ctx.updater.loadSettings();
      assert.equal((await settled(ctx.updater)).state, 'ready');
      block = true;
      const installing = ctx.updater.install();
      await entered.promise;
      await ctx.updater.setChannel('stable');
      if (phase === 'cleanup') {
        // Re-enabling beta and staging the same version must not resurrect the older install request.
        await ctx.updater.setChannel('beta');
        assert.equal((await settled(ctx.updater)).state, 'ready');
      }
      block = false;
      release.resolve();
      await installing;
      assert.equal(ctx.spawned.length, 0);
      assert.equal(ctx.counts().quits, 0);
      assert.equal(ctx.updater.getStatus().state, phase === 'cleanup' ? 'ready' : 'idle');
      if (phase === 'cleanup') {
        await ctx.updater.install();
        assert.equal(ctx.spawned.length, 1, 'a fresh install still works');
      }
    });
  }
});
