// Test oracle only. No original updater implementation is copied into the app.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

assert.equal(process.platform, 'darwin', 'Real macOS tools are required');
assert.equal(process.env.WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE, '1', 'Explicit opt-in is required');
const [temporaryArg, legacyArg, targetArg, manifestArg, archiveArg, version] = process.argv.slice(2);
assert.ok(temporaryArg && legacyArg && targetArg && manifestArg && archiveArg && version);
const temporary = await fs.realpath(temporaryArg);
const legacy = await fs.realpath(legacyArg);
const target = await fs.realpath(targetArg);
const manifestPath = await fs.realpath(manifestArg);
const archivePath = await fs.realpath(archiveArg);
const within = (parent, child) => child.startsWith(parent + path.sep);
assert.ok(path.basename(temporary).startsWith('wlsaplus-signed-compat.'));
assert.ok(within(temporary, target) && within(temporary, manifestPath) && within(temporary, archivePath));
const exec = promisify(execFile);
const tools = { ditto: '/usr/bin/ditto', xattr: '/usr/bin/xattr', codesign: '/usr/bin/codesign', lipo: '/usr/bin/lipo', '/usr/libexec/PlistBuddy': '/usr/libexec/PlistBuddy' };
const commands = [];
const run = async (tool, args) => {
  assert.ok(Object.hasOwn(tools, tool), `Unexpected legacy system tool: ${tool}`);
  commands.push([tool, ...args]);
  return (await exec(tools[tool], args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout;
};
const oracleNames = ['mac-updater.cjs', 'update-core.cjs', 'update-config.cjs', 'update-helper.sh'];
const digest = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const originalDigests = new Map(await Promise.all(oracleNames.map(async name => [name, await digest(path.join(legacy, name))])));
const require = createRequire(import.meta.url);
const { createMacUpdater } = require(path.join(legacy, 'mac-updater.cjs'));
const config = require(path.join(legacy, 'update-config.cjs'));
assert.equal(config.UPDATE_PRODUCT, 'wlsaplus-macos');
assert.equal(config.BUNDLE_ID, 'cn.org.wlsash.wlsaplus');
assert.equal(config.CODESIGN_CERT_SHA1, '764D4389AAFA0C50311E39C17DDFA1981ABEF86C');
assert.equal(config.UPDATE_PUBLIC_KEY_PEM.replace(/\s|-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, ''), 'MCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM=');
const manifestBytes = await fs.readFile(manifestPath);
const envelope = JSON.parse(manifestBytes);
assert.equal(envelope.format, 1);
assert.ok(crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), crypto.createPublicKey(config.UPDATE_PUBLIC_KEY_PEM), Buffer.from(envelope.signature, 'base64')));
const manifest = JSON.parse(envelope.payload);
assert.equal(manifest.version, version);
assert.equal(manifest.channel, 'stable');
assert.equal(manifest.product, config.UPDATE_PRODUCT);
assert.equal(manifest.tag, `v${version}`);
const file = manifest.files.universal;
assert.equal(file.name, path.basename(archivePath));
assert.equal(file.size, (await fs.stat(archivePath)).size);
assert.equal(file.sha256, await digest(archivePath));
const touchedNormalDirectories = [];
const updaters = [];
let helperChild;
let server;
const normalSupport = path.join(os.homedir(), 'Library', 'Application Support', 'WLSAPlus');
const markerDirectory = path.join(normalSupport, 'updates', 'staging', version);
const helperLog = path.join(temporary, 'legacy-helper.log');
async function absent(filePath) {
  try { await fs.lstat(filePath); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function deadPID() {
  const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('PID fixture failed'))); });
  return child.pid;
}
async function killOnlyThrowawayNative(bundle = target) {
  // CI-only cleanup. The unique absolute throwaway executable path narrows pgrep.
  assert.ok(within(temporary, bundle));
  const executable = path.join(bundle, 'Contents', 'MacOS', 'WLSAPlus');
  let stdout;
  try { ({ stdout } = await exec('/usr/bin/pgrep', ['-f', executable])); } catch (error) { if (error.code === 1) return; throw error; }
  for (const value of stdout.trim().split(/\s+/)) {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
}
try {
  const hits = [];
  server = http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    hits.push(requestPath);
    if (requestPath === '/api/latest') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tag: manifest.tag, assets: [{ name: 'update-manifest.json' }] }));
    } else if (requestPath === `/download/${manifest.tag}/update-manifest.json`) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': manifestBytes.length }); response.end(manifestBytes);
    } else if (requestPath === `/download/${manifest.tag}/${file.name}`) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': file.size });
      import('node:fs').then(({ createReadStream }) => createReadStream(archivePath).on('error', () => response.destroy()).pipe(response));
    } else { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let hostStage;
  for (const arch of ['arm64', 'x64']) {
    const userData = path.join(temporary, `legacy-${arch}`);
    const spawned = [];
    const updater = createMacUpdater({
      currentVersion: '1.1.2', userData, exePath: path.join(target, 'Contents', 'MacOS', 'WLSAPlus'), arch,
      systemVersion: (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(), supported: true,
      env: { WLSAPLUS_UPDATE_BASE_URL: base }, argv: [], run,
      fetchImpl: (url, options) => { assert.equal(new URL(url).origin, base); return fetch(url, options); },
      spawnDetached: (tool, args) => spawned.push({ tool, args }),
      helperSource: path.join(legacy, 'update-helper.sh'), pid: await deadPID(),
      // Crucially, publicKeyPem is omitted: the original updater's pinned key is used.
    });
    updaters.push(updater);
    await updater.loadSettings();
    assert.equal(updater.getChannel(), 'stable', '1.1.2 stable defaults must accept the stable native fixture');
    await updater.check();
    const result = await updater.idle();
    assert.equal(result.state, 'ready', `Original ${arch} updater did not stage native bundle: ${result.message}`);
    assert.equal(result.version, version);
    assert.equal(updater.staged.file.arch, 'universal');
    assert.ok(within(temporary, updater.staged.stagedApp));
    assert.ok(updater.installOnQuit(), 'Original quit-install path must accept the staged native bundle');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].tool, '/bin/bash');
    assert.equal(await digest(spawned[0].args[0]), originalDigests.get('update-helper.sh'));
    if (arch === process.arch) hostStage = { staged: updater.staged, launch: spawned[0] };
    console.log(`PASS original 1.1.2 ${arch} stable updater: pinned manifest, download hash, real ditto/codesign/lipo and ready state`);
  }
  assert.ok(commands.filter(([tool]) => tool === 'codesign').length >= 4);
  assert.equal(commands.filter(([tool]) => tool === 'ditto').length, 2);
  assert.equal(commands.filter(([tool]) => tool === 'lipo').length, 2);
  assert.ok(hits.includes('/api/latest'));
  assert.ok(hits.includes(`/download/${manifest.tag}/${file.name}`));
  if (process.env.WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE === '1') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    const runnerTemporary = await fs.realpath(process.env.RUNNER_TEMP);
    assert.ok(within(runnerTemporary, temporary), 'Helper launch target must be in the hosted runner temporary directory');
    assert.ok(hostStage, 'A host architecture stage is required');
    assert.ok(await absent(path.join(normalSupport, 'Local Storage', 'leveldb', 'CURRENT')), 'A real legacy profile must never be touched');
    assert.ok(await absent(path.join(normalSupport, 'vpn-runtime', 'session.json')), 'An existing VPN session must never be touched');
    assert.ok(await absent(markerDirectory), 'Never overwrite an existing startup marker/staging directory');
    const normalState = path.join(normalSupport, 'native-state.json');
    if (!(await absent(normalState))) {
      const state = JSON.parse(await fs.readFile(normalState, 'utf8'));
      assert.ok(!state.school?.username, 'An existing signed-in native profile must never be touched');
      assert.equal((state.todos ?? []).length, 0, 'An existing to-do profile must never be touched');
      for (const key of ['courses', 'schedule', 'assignments', 'attendance']) assert.equal((state.snapshot?.[key] ?? []).length, 0, 'Existing school cache must never be touched');
    }
    // The copied unchanged legacy shell helper is invoked with its real quit
    // flags. Only the marker is relocated to the native app's exact normal
    // support path; target, stage, backup, result and log stay throwaway.
    const marker = path.join(markerDirectory, 'launched.marker');
    const resultFile = path.join(temporary, 'legacy-helper-result.json');
    const args = [...hostStage.launch.args];
    const replace = (flag, value) => { const index = args.indexOf(flag); assert.ok(index >= 0); args[index + 1] = value; };
    replace('--marker', marker); replace('--backup', path.join(temporary, 'backup', 'WLSAPlus.app'));
    replace('--result', resultFile); replace('--log', helperLog); replace('--timeout', '90');
    // The original helper supports --wait, but updater.helperArgs omits it.
    args.push('--wait', '10');
    assert.equal(args[args.indexOf('--mode') + 1], 'quit');
    assert.equal(args[args.indexOf('--admin') + 1], '0', 'CI helper smoke must never request administrator permission');
    for (const directory of [normalSupport, path.join(normalSupport, 'updates'), path.join(normalSupport, 'updates', 'staging')]) {
      if (await absent(directory)) { await fs.mkdir(directory); touchedNormalDirectories.push(directory); }
    }
    await fs.mkdir(markerDirectory); touchedNormalDirectories.push(markerDirectory);
    await new Promise((resolve, reject) => {
      helperChild = execFile('/bin/bash', args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error('Original shell-helper startup smoke failed; inspect the private temporary helper log during CI debugging')) : resolve());
    });
    const outcome = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    assert.equal(outcome.state, 'updated', 'Original helper must observe native startup success');
    assert.equal(outcome.to, version);
    assert.ok((await fs.readFile(marker, 'utf8')).trim().length > 0, 'Actual native app must acknowledge the unchanged startup argument');
    assert.ok(await absent(hostStage.staged.stagedApp), 'Original helper must move the verified native stage into the throwaway target');
    const installedVersion = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(target, 'Contents', 'Info.plist')])).stdout.trim();
    assert.equal(installedVersion, version);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
    await exec('/usr/bin/codesign', ['--verify', `-R=${config.CODESIGN_REQUIREMENT}`, target]);
    console.log('PASS unchanged original shell helper: writable throwaway swap, native verify-only startup, normal marker, helper updated outcome');

    // Exercise the replacement installer too, through its production CLI. Its
    // target and backup remain inside our throwaway directory; only its stage
    // and marker use the exact path validated by the application at startup.
    const nativeTarget = path.join(temporary, 'native-installed', 'Renamed WLSAPlus.app');
    const nativeExecutable = path.join(temporary, 'native-installer-helper');
    assert.ok(within(temporary, await fs.realpath(nativeTarget)));
    // install() launches a detached copy outside the target .app. Match that
    // placement so LaunchServices cannot mistake the installer for the app.
    await fs.copyFile(path.join(nativeTarget, 'Contents', 'MacOS', 'WLSAPlus'), nativeExecutable);
    await fs.chmod(nativeExecutable, 0o700);
    assert.equal((await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(nativeTarget, 'Contents', 'Info.plist')])).stdout.trim(), '1.1.2');
    const nativeStage = path.join(markerDirectory, 'native-unpacked', 'WLSAPlus.app');
    await fs.mkdir(path.dirname(nativeStage));
    await exec('/usr/bin/ditto', [path.join(temporary, 'package', 'WLSAPlus.app'), nativeStage]);
    await fs.rm(marker);
    const nativeResult = path.join(normalSupport, 'updates', 'install-result.json');
    assert.ok(await absent(nativeResult), 'Never overwrite an existing installer result');
    const failedVersions = path.join(normalSupport, 'updates', 'failed-versions.json');
    const previousFailures = (await absent(failedVersions)) ? null : await fs.readFile(failedVersions);
    await exec(nativeExecutable, ['--native-installer', String(await deadPID()), nativeTarget, nativeStage, marker, version, 'quit'], { timeout: 110_000 });
    assert.equal((await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(nativeTarget, 'Contents', 'Info.plist')])).stdout.trim(), version);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', nativeTarget]);
    await exec('/usr/bin/codesign', ['--verify', `-R=${config.CODESIGN_REQUIREMENT}`, nativeTarget]);
    assert.ok((await fs.readFile(marker, 'utf8')).trim().length > 0, 'Production native installer must observe native startup acknowledgment');
    assert.deepEqual((await fs.readdir(path.dirname(nativeTarget))).sort(), ['Renamed WLSAPlus.app'], 'Successful native installer must remove its backup and preparation copy');
    assert.ok(await absent(nativeResult), 'Successful native installer must not report an error');
    if (previousFailures === null) assert.ok(await absent(failedVersions));
    else assert.deepEqual(await fs.readFile(failedVersions), previousFailures, 'Successful install must preserve the blacklist');
    console.log('PASS production native installer: signed 1.1.2 to 2.0.0, renamed throwaway app, swap, native startup acknowledgment and backup cleanup');
  } else {
    console.log('SKIP original shell-helper launch: WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE=1 is not enabled (staging/trust smoke passed)');
  }
} catch (error) {
  // Only test paths/statuses are present: signing secrets were removed before
  // this process began. Bounded diagnostics survive the shell's temp cleanup.
  try {
    const log = await fs.readFile(helperLog, 'utf8');
    process.stderr.write('Original helper diagnostics (tail):\n' + log.slice(-32768) + '\n');
  } catch (readError) { if (readError.code !== 'ENOENT') process.stderr.write('Helper diagnostic log was unavailable.\n'); }
  throw error;
} finally {
  if (helperChild && helperChild.exitCode === null) { helperChild.kill('SIGKILL'); }
  for (const updater of updaters) updater.stop();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (process.env.WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE === '1') {
    await killOnlyThrowawayNative();
    await killOnlyThrowawayNative(path.join(temporary, 'native-installed', 'Renamed WLSAPlus.app'));
    // Remove only the unique marker directory created above; never remove or
    // rewrite native state, cookies, other stages, or existing parent directories.
    if (touchedNormalDirectories.includes(markerDirectory)) await fs.rm(markerDirectory, { recursive: true });
    for (const directory of touchedNormalDirectories.reverse()) {
      if (directory !== markerDirectory) { try { await fs.rmdir(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } }
    }
  }
  for (const [name, before] of originalDigests) assert.equal(await digest(path.join(legacy, name)), before, `Original updater oracle was modified: ${name}`);
}
console.log('PASS original updater oracle files are unchanged. This is not a full original Electron runtime end-to-end test.');
