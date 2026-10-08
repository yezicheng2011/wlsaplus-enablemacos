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
    res.writeHead(200);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
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

function setup(t, { currentVersion = '1.1.0', routes, mac, argv = [], exePath = '/Applications/WLSAPlus.app/Contents/MacOS/WLSAPlus', writable = true, supported = true, arch = 'arm64', launchedByUpdater = false }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-upd-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const spawned = [];
  const statuses = [];
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
      beforeInstall: async () => { cleanups += 1; },
      quit: () => { quits += 1; },
      onStatus: (status) => statuses.push(status.state),
      accessImpl: async () => { if (!writable) throw new Error('EACCES'); },
      publicKeyPem,
      launchedByUpdater,
      pid: 4242,
    });
    return { updater, userData, spawned, statuses, hits, base, counts: () => ({ quits, cleanups }) };
  });
}

test('unsupported (dev / non-mac) builds never touch the network', async (t) => {
  const ctx = await setup(t, { routes: {}, mac: fakeMac(), supported: false });
  await ctx.updater.loadSettings();
  assert.equal((await ctx.updater.check()).state, 'unsupported');
  assert.deepEqual(ctx.hits, []);
});

test('stable release without update-manifest.json (e.g. 1.0.9) means up to date', async (t) => {
  const ctx = await setup(t, { routes: { '/api/latest': JSON.stringify({ tag: 'v1.0.9', assets: [{ name: 'wlsaplus1.0.9.zip' }] }) }, mac: fakeMac() });
  await ctx.updater.loadSettings();
  const status = await ctx.updater.check();
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
  const status = await ctx.updater.check();
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
  const status = await ctx.updater.check();
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
  assert.equal((await ctx.updater.check()).state, 'up-to-date');
  await ctx.updater.setChannel('beta');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.userData, 'updates', 'settings.json'), 'utf8')).channel, 'beta');
  const status = await ctx.updater.check();
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
  const status = await ctx.updater.check();
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
  const status = await ctx.updater.check();
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
  assert.match((await a.updater.check()).message, /codesign failed/);
  const b = await setup(t, { mac: fakeMac({ plistVersion: '1.1.1', archs: 'x86_64' }), routes });
  await b.updater.loadSettings();
  assert.match((await b.updater.check()).message, /built for x86_64/);
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
  const status = await ctx.updater.check();
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
  assert.equal((await ctx.updater.check()).state, 'ready');
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
  await ctx.updater.check();
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
  assert.equal((await ctx.updater.check()).state, 'up-to-date');
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
