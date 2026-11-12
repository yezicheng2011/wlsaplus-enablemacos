// SPDX-License-Identifier: Apache-2.0
// Independent Apache-2.0 macOS signed update wire-contract & native installer smoke test.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PINNED_TRUST,
  downloadAndVerifyArtifact,
  pickArchArtifact,
  selectEligibleRelease,
  sha256File,
  verifySignedManifestEnvelope,
  verifyUnpackedMacBundle,
} from './update-wire-contract.mjs';

assert.equal(process.platform, 'darwin', 'Real macOS tools are required');
assert.equal(process.env.WLSAPLUS_RUN_SIGNED_COMPAT_SMOKE, '1', 'Explicit opt-in is required');

const [temporaryArg, targetArg, manifestArg, archiveArg, version] = process.argv.slice(2);
assert.ok(temporaryArg && targetArg && manifestArg && archiveArg && version);

const temporary = await fs.realpath(temporaryArg);
const target = await fs.realpath(targetArg);
const manifestPath = await fs.realpath(manifestArg);
const archivePath = await fs.realpath(archiveArg);
const within = (parent, child) => child.startsWith(parent + path.sep);
assert.ok(path.basename(temporary).startsWith('wlsaplus-signed-compat.'));
assert.ok(within(temporary, target) && within(temporary, manifestPath) && within(temporary, archivePath));

const exec = promisify(execFile);
const allowedTools = {
  ditto: '/usr/bin/ditto',
  xattr: '/usr/bin/xattr',
  codesign: '/usr/bin/codesign',
  lipo: '/usr/bin/lipo',
  '/usr/libexec/PlistBuddy': '/usr/libexec/PlistBuddy',
};
const invokedTools = [];
const runTool = async (tool, args) => {
  assert.ok(Object.hasOwn(allowedTools, tool), `Unexpected system tool: ${tool}`);
  invokedTools.push([tool, ...args]);
  return (await exec(allowedTools[tool], args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout;
};

const manifestBytes = await fs.readFile(manifestPath);
const archiveStat = await fs.stat(archivePath);
const archiveDigest = await sha256File(archivePath);
const verifiedManifest = verifySignedManifestEnvelope(manifestBytes);
assert.equal(verifiedManifest.version, version);
assert.equal(verifiedManifest.channel, 'stable');
assert.equal(verifiedManifest.tag, `v${version}`);
assert.equal(verifiedManifest.files.universal.name, path.basename(archivePath));
assert.equal(verifiedManifest.files.universal.size, archiveStat.size);
assert.equal(verifiedManifest.files.universal.sha256, archiveDigest);

const touchedNormalDirectories = [];
let server;
const normalSupport = path.join(os.homedir(), 'Library', 'Application Support', 'WLSAPlus');
const markerDirectory = path.join(normalSupport, 'updates', 'staging', version);

async function absent(filePath) {
  try {
    await fs.lstat(filePath);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function deadPID() {
  const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error('PID fixture failed'))));
  });
  return child.pid;
}

async function killOnlyThrowawayNative(bundle = target) {
  assert.ok(within(temporary, bundle));
  const executable = path.join(bundle, 'Contents', 'MacOS', 'WLSAPlus');
  let stdout;
  try {
    ({ stdout } = await exec('/usr/bin/pgrep', ['-f', executable]));
  } catch (error) {
    if (error.code === 1) return;
    throw error;
  }
  for (const value of stdout.trim().split(/\s+/u)) {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

try {
  const hits = [];
  server = http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    hits.push(requestPath);
    if (requestPath === '/api/latest') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tag: verifiedManifest.tag, assets: [{ name: 'update-manifest.json' }] }));
      return;
    }
    if (requestPath === `/download/${verifiedManifest.tag}/update-manifest.json`) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': manifestBytes.length });
      response.end(manifestBytes);
      return;
    }
    if (requestPath === `/download/${verifiedManifest.tag}/${verifiedManifest.files.universal.name}`) {
      const range = request.headers.range;
      if (range?.startsWith('bytes=')) {
        const start = Number(range.slice('bytes='.length).split('-')[0]);
        if (Number.isInteger(start) && start >= 0 && start < archiveStat.size) {
          response.writeHead(206, {
            'content-type': 'application/zip',
            'content-length': archiveStat.size - start,
            'content-range': `bytes ${start}-${archiveStat.size - 1}/${archiveStat.size}`,
          });
          createReadStream(archivePath, { start }).on('error', () => response.destroy()).pipe(response);
          return;
        }
      }
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archiveStat.size });
      createReadStream(archivePath).on('error', () => response.destroy()).pipe(response);
      return;
    }
    response.writeHead(404).end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const macosVersion = (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
  let hostStagedBundle = null;

  for (const arch of ['arm64', 'x64']) {
    const latestRes = await fetch(`${base}/api/latest`);
    assert.equal(latestRes.status, 200);
    const latestJson = await latestRes.json();
    const tag = latestJson.tag_name ?? latestJson.tag;
    assert.equal(tag, `v${version}`);

    const manifestRes = await fetch(`${base}/download/${encodeURIComponent(tag)}/update-manifest.json`);
    assert.equal(manifestRes.status, 200);
    const remoteManifest = verifySignedManifestEnvelope(Buffer.from(await manifestRes.arrayBuffer()));
    const selected = selectEligibleRelease([remoteManifest], {
      currentVersion: '1.1.2',
      allowBeta: false,
      macosVersion,
    });
    assert.ok(selected, `Wire contract did not select ${version} for ${arch}`);
    const artifact = pickArchArtifact(selected, arch);
    assert.ok(artifact && artifact.arch === 'universal');

    const archStageDir = path.join(temporary, `wire-stage-${arch}`);
    const downloadedZip = path.join(archStageDir, artifact.name);
    if (arch === 'x64') {
      const seedBytes = (await fs.readFile(archivePath)).subarray(0, Math.min(4096, Math.floor(archiveStat.size / 2)));
      await fs.mkdir(archStageDir, { recursive: true });
      await fs.writeFile(`${downloadedZip}.part`, seedBytes);
    }
    const downloadOutcome = await downloadAndVerifyArtifact(
      [`${base}/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact.name)}`],
      artifact,
      downloadedZip,
    );
    if (arch === 'x64') {
      assert.ok(downloadOutcome.resumedFrom > 0, 'x64 smoke profile must verify HTTP 206 Range resume');
    }

    const unpackedDir = path.join(archStageDir, 'unpacked');
    await fs.mkdir(unpackedDir, { recursive: true });
    await runTool('ditto', ['-x', '-k', downloadedZip, unpackedDir]);
    const unpackedBundle = path.join(unpackedDir, 'WLSAPlus.app');
    assert.ok(within(temporary, unpackedBundle));
    await verifyUnpackedMacBundle(unpackedBundle, {
      expectedVersion: version,
      requiredArch: arch,
      runTool,
    });
    if (arch === process.arch) {
      hostStagedBundle = unpackedBundle;
    }
    console.log(`PASS 1.1.2 -> ${version} ${arch} wire contract: Ed25519 manifest, HTTP transfer, ditto unpack, codesign & lipo`);
  }

  assert.ok(invokedTools.filter(([tool]) => tool === 'codesign').length >= 4);
  assert.equal(invokedTools.filter(([tool]) => tool === 'ditto').length, 2);
  assert.equal(invokedTools.filter(([tool]) => tool === 'lipo').length, 2);
  assert.ok(hits.includes('/api/latest'));
  assert.ok(hits.includes(`/download/${verifiedManifest.tag}/${verifiedManifest.files.universal.name}`));

  if (process.env.WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE === '1') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    const runnerTemporary = await fs.realpath(process.env.RUNNER_TEMP);
    assert.ok(within(runnerTemporary, temporary), 'Launch target must be inside the hosted runner temporary directory');
    assert.ok(hostStagedBundle, 'A host architecture staged bundle is required');
    assert.ok(await absent(path.join(normalSupport, 'Local Storage', 'leveldb', 'CURRENT')), 'A real legacy profile must never be touched');
    assert.ok(await absent(path.join(normalSupport, 'vpn-runtime', 'session.json')), 'An existing VPN session must never be touched');
    assert.ok(await absent(markerDirectory), 'Never overwrite an existing startup marker/staging directory');

    const normalState = path.join(normalSupport, 'native-state.json');
    if (!(await absent(normalState))) {
      const state = JSON.parse(await fs.readFile(normalState, 'utf8'));
      assert.ok(!state.school?.username, 'An existing signed-in native profile must never be touched');
      assert.equal((state.todos ?? []).length, 0, 'An existing to-do profile must never be touched');
      for (const key of ['courses', 'schedule', 'assignments', 'attendance']) {
        assert.equal((state.snapshot?.[key] ?? []).length, 0, 'Existing school cache must never be touched');
      }
    }

    for (const directory of [normalSupport, path.join(normalSupport, 'updates'), path.join(normalSupport, 'updates', 'staging')]) {
      if (await absent(directory)) {
        await fs.mkdir(directory);
        touchedNormalDirectories.push(directory);
      }
    }
    await fs.mkdir(markerDirectory);
    touchedNormalDirectories.push(markerDirectory);
    const marker = path.join(markerDirectory, 'launched.marker');

    const backupBundle = path.join(temporary, 'backup', 'WLSAPlus.app');
    await fs.mkdir(path.dirname(backupBundle), { recursive: true });
    await fs.rename(target, backupBundle);
    await exec('/usr/bin/ditto', [hostStagedBundle, target]);
    await exec('/usr/bin/open', ['-g', '-j', target, '--args', `--wlsaplus-update-marker=${marker}`, '--wlsaplus-update-verify-only'], { timeout: 60_000 });
    const deadline = Date.now() + 90_000;
    while (await absent(marker)) {
      if (Date.now() >= deadline) throw new Error('Staged native bundle did not write startup acknowledgment marker within 90s');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok((await fs.readFile(marker, 'utf8')).trim().length > 0);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
    await exec('/usr/bin/codesign', ['--verify', `-R=${PINNED_TRUST.designatedRequirement}`, target]);
    console.log('PASS verify-only startup handshake: replaced throwaway 1.1.2 bundle acknowledged launched.marker');

    const nativeTarget = path.join(temporary, 'native-installed', 'Renamed WLSAPlus.app');
    const nativeExecutable = path.join(temporary, 'native-installer-helper');
    assert.ok(within(temporary, await fs.realpath(nativeTarget)));
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
    await exec('/usr/bin/codesign', ['--verify', `-R=${PINNED_TRUST.designatedRequirement}`, nativeTarget]);
    assert.ok((await fs.readFile(marker, 'utf8')).trim().length > 0, 'Production native installer must observe native startup acknowledgment');
    assert.deepEqual((await fs.readdir(path.dirname(nativeTarget))).sort(), ['Renamed WLSAPlus.app'], 'Successful native installer must remove its backup and preparation copy');
    assert.ok(await absent(nativeResult), 'Successful native installer must not report an error');
    if (previousFailures === null) assert.ok(await absent(failedVersions));
    else assert.deepEqual(await fs.readFile(failedVersions), previousFailures, 'Successful install must preserve the blacklist');
    console.log('PASS production native installer: signed 1.1.2 to 2.0.0, renamed throwaway app, swap, startup acknowledgment and backup cleanup');
  } else {
    console.log('SKIP launch smoke: WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE=1 is not enabled (wire-contract staging smoke passed)');
  }
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (process.env.WLSAPLUS_NATIVE_UPDATE_LAUNCH_SMOKE === '1') {
    await killOnlyThrowawayNative();
    await killOnlyThrowawayNative(path.join(temporary, 'native-installed', 'Renamed WLSAPlus.app'));
    if (touchedNormalDirectories.includes(markerDirectory)) {
      await fs.rm(markerDirectory, { recursive: true });
    }
    for (const directory of touchedNormalDirectories.reverse()) {
      if (directory !== markerDirectory) {
        try {
          await fs.rmdir(directory);
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
        }
      }
    }
  }
}
