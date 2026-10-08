// Runs the real update-helper.sh with stub open/osascript/xattr and fake app bundles (works on Linux and macOS).
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HELPER = path.join(__dirname, 'update-helper.sh');

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function fakeApp(dir, version, { healthy = true } = {}) {
  const app = path.join(dir, 'WLSAPlus.app');
  write(path.join(app, 'Contents', 'VERSION'), version);
  write(path.join(app, 'Contents', 'MacOS', 'WLSAPlus'), `#!/bin/bash
for a in "$@"; do case "$a" in --wlsaplus-update-marker=*) M="\${a#*=}";; esac; done
echo "${version} $*" >> "$WLSA_TEST_LOG/launches"
${healthy ? 'sleep 0.3; [ -n "${M:-}" ] && echo "' + version + '" > "$M"; sleep 30' : 'exit 3'}
`, 0o755);
  return app;
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-helper-'));
  t.after(() => {
    spawnSync('pkill', ['-f', path.join(root, 'Applications')]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const stubs = path.join(root, 'stubs');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  write(path.join(stubs, 'xattr'), '#!/bin/bash\nexit 0\n', 0o755);
  // open [-g] [-j] APP --args ... -> runs APP/Contents/MacOS/WLSAPlus ARGS in the background
  write(path.join(stubs, 'open'), `#!/bin/bash
echo "open $*" >> "$WLSA_TEST_LOG/open"
flags=""; while [ "$1" = "-g" ] || [ "$1" = "-j" ]; do flags="$flags $1"; shift; done
app="$1"; shift; [ "$1" = "--args" ] && shift
nohup "$app/Contents/MacOS/WLSAPlus" "$@" >/dev/null 2>&1 &
exit 0
`, 0o755);
  // osascript -e ... "$SELF" --swap A B C -> runs the privileged step directly, logs that a prompt happened
  write(path.join(stubs, 'osascript'), `#!/bin/bash
while [ "$1" = "-e" ]; do shift 2; done
echo "admin $2" >> "$WLSA_TEST_LOG/admin"
exec /bin/bash "$1" "$2" "$3" "$4" "$5"
`, 0o755);
  const apps = path.join(root, 'Applications');
  const updates = path.join(root, 'userData', 'updates');
  fs.mkdirSync(apps, { recursive: true });
  return { root, stubs, logs, apps, updates };
}

function runHelper(box, args) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [HELPER, ...args], {
      env: { ...process.env, WLSAPLUS_UPDATE_HELPER_PATH: `${box.stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, WLSA_TEST_LOG: box.logs },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

function standardArgs(box, { version = '1.1.1', mode = 'restart', admin = '0', timeout = '10', pid = null, wait = '5' } = {}) {
  const staging = path.join(box.updates, 'staging', version);
  return {
    staging,
    args: [
      ...(pid ? ['--pid', String(pid)] : []),
      '--target', path.join(box.apps, 'WLSAPlus.app'),
      '--staged', path.join(staging, 'app', 'WLSAPlus.app'),
      '--backup', path.join(box.updates, 'backup', 'WLSAPlus.app'),
      '--marker', path.join(staging, 'launched.marker'),
      '--result', path.join(box.updates, 'last-result.json'),
      '--version', version,
      '--from', '1.1.0',
      '--mode', mode,
      '--admin', admin,
      '--timeout', timeout,
      '--wait', wait,
    ],
  };
}

const readVersion = (box) => fs.readFileSync(path.join(box.apps, 'WLSAPlus.app', 'Contents', 'VERSION'), 'utf8');
const readResult = (box) => JSON.parse(fs.readFileSync(path.join(box.updates, 'last-result.json'), 'utf8'));
const readLog = (box, name) => { try { return fs.readFileSync(path.join(box.logs, name), 'utf8'); } catch { return ''; } };

test('restart mode: waits for the old app, swaps, launches the new app, removes the backup', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box);
  fakeApp(path.join(staging, 'app'), '1.1.1');
  const old = spawn('sleep', ['1.5']);
  const started = Date.now();
  const { code, out } = await runHelper(box, [...args, '--pid', String(old.pid)]);
  assert.equal(code, 0, out);
  assert.ok(Date.now() - started >= 1400, 'waited for the old process');
  assert.equal(readVersion(box), '1.1.1');
  assert.equal(readResult(box).state, 'updated');
  assert.equal(readResult(box).to, '1.1.1');
  assert.equal(readResult(box).from, '1.1.0');
  assert.equal(fs.existsSync(path.join(box.updates, 'backup', 'WLSAPlus.app')), false);
  assert.equal(fs.existsSync(path.join(staging, 'app', 'WLSAPlus.app')), false);
  const open = readLog(box, 'open');
  assert.match(open, /--wlsaplus-update-marker=.*launched\.marker/);
  assert.doesNotMatch(open, /verify-only/);
  assert.equal(readLog(box, 'admin'), '', 'no admin prompt when writable');
});

test('quit mode launches the new app hidden with --wlsaplus-update-verify-only', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box, { mode: 'quit' });
  fakeApp(path.join(staging, 'app'), '1.1.1');
  const { code, out } = await runHelper(box, args);
  assert.equal(code, 0, out);
  assert.equal(readVersion(box), '1.1.1');
  assert.match(readLog(box, 'open'), /^open -g -j .*--wlsaplus-update-verify-only/m);
});

test('a new version that does not start is rolled back and the old one reopened', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box, { timeout: '3' });
  fakeApp(path.join(staging, 'app'), '1.1.1', { healthy: false });
  const { code, out } = await runHelper(box, args);
  assert.equal(code, 5, out);
  assert.equal(readVersion(box), '1.1.0');
  assert.equal(readResult(box).state, 'rolled_back');
  assert.equal(readResult(box).to, '1.1.1');
  assert.match(readLog(box, 'open'), /--wlsaplus-update-failed/);
  assert.equal(fs.existsSync(path.join(box.updates, 'backup', 'failed-1.1.1.app')), false);
  assert.equal(fs.existsSync(path.join(box.updates, 'backup', 'WLSAPlus.app')), false);
});

test('admin mode routes the swap through osascript', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box, { admin: '1' });
  fakeApp(path.join(staging, 'app'), '1.1.1');
  const { code, out } = await runHelper(box, args);
  assert.equal(code, 0, out);
  assert.equal(readVersion(box), '1.1.1');
  assert.match(readLog(box, 'admin'), /admin --swap/);
});

test('admin rollback restores through osascript too', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box, { admin: '1', timeout: '2' });
  fakeApp(path.join(staging, 'app'), '1.1.1', { healthy: false });
  const { code, out } = await runHelper(box, args);
  assert.equal(code, 5, out);
  assert.equal(readVersion(box), '1.1.0');
  assert.match(readLog(box, 'admin'), /admin --swap\nadmin --restore/);
});

test('if the old app never quits nothing is changed', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { staging, args } = standardArgs(box, { wait: '1' });
  fakeApp(path.join(staging, 'app'), '1.1.1');
  const old = spawn('sleep', ['20']);
  t.after(() => old.kill());
  const { code, out } = await runHelper(box, [...args, '--pid', String(old.pid)]);
  assert.equal(code, 3, out);
  assert.equal(readVersion(box), '1.1.0');
  assert.equal(readResult(box).state, 'failed');
  assert.equal(readLog(box, 'open'), '');
});

test('a missing staged app leaves the installed app untouched', async (t) => {
  const box = sandbox(t);
  fakeApp(box.apps, '1.1.0');
  const { args } = standardArgs(box);
  const { code, out } = await runHelper(box, args);
  assert.equal(code, 4, out);
  assert.equal(readVersion(box), '1.1.0');
  assert.equal(readResult(box).state, 'failed');
});

test('missing arguments fail fast', async (t) => {
  const box = sandbox(t);
  const { code } = await runHelper(box, ['--target', path.join(box.apps, 'WLSAPlus.app')]);
  assert.equal(code, 2);
});
