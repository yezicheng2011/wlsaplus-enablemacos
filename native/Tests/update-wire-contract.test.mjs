// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PINNED_TRUST,
  compareSemver,
  downloadAndVerifyArtifact,
  pickArchArtifact,
  selectEligibleRelease,
  verifySignedManifestEnvelope,
  verifyUnpackedMacBundle,
} from './update-wire-contract.mjs';

function makeSignedFixture(keyPair, payloadObject) {
  const payload = JSON.stringify(payloadObject);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), keyPair.privateKey).toString('base64');
  return JSON.stringify({ format: 1, payload, signature });
}

test('pinned trust verifier accepts historical 1.1.2 release manifest and rejects tampering', async () => {
  const fixtureUrl = new URL('./Fixtures/legacy-update-manifest.json', import.meta.url);
  const raw = await fs.readFile(fixtureUrl);
  const verified = verifySignedManifestEnvelope(raw);
  assert.equal(verified.version, '1.1.2');
  assert.equal(verified.channel, 'stable');
  assert.ok(verified.files.arm64 && verified.files.x64);

  const parsed = JSON.parse(raw.toString('utf8'));
  parsed.payload += ' ';
  assert.throws(() => verifySignedManifestEnvelope(JSON.stringify(parsed)), /signature verification failed/i);
});

test('release eligibility enforces version upgrade, beta opt-in, rollback blocklist, OS floor, and universal fallback', () => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sampleHash = 'a'.repeat(64);

  const stable200 = verifySignedManifestEnvelope(makeSignedFixture(keyPair, {
    product: PINNED_TRUST.product,
    version: '2.0.0',
    tag: 'v2.0.0',
    channel: 'stable',
    minimumSystemVersion: '13.0',
    files: {
      universal: { name: 'WLSAPlus-2.0.0-macOS-universal.zip', size: 1024, sha256: sampleHash },
    },
  }), { publicKeyPem });

  const beta210 = verifySignedManifestEnvelope(makeSignedFixture(keyPair, {
    product: PINNED_TRUST.product,
    version: '2.1.0-beta.1',
    tag: 'v2.1.0-beta.1',
    channel: 'beta',
    minimumSystemVersion: '13.0',
    files: {
      arm64: { name: 'WLSAPlus-2.1.0-beta.1-mac-arm64.zip', size: 512, sha256: sampleHash },
    },
  }), { publicKeyPem });

  assert.equal(compareSemver('2.1.0-beta.1', '2.0.0'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0-beta.9'), 1);

  const chosenStable = selectEligibleRelease([stable200, beta210], {
    currentVersion: '1.1.2',
    allowBeta: false,
    macosVersion: '14.4',
  });
  assert.equal(chosenStable?.version, '2.0.0');
  assert.equal(pickArchArtifact(chosenStable, 'arm64')?.arch, 'universal');
  assert.equal(pickArchArtifact(chosenStable, 'x64')?.arch, 'universal');

  const chosenBeta = selectEligibleRelease([stable200, beta210], {
    currentVersion: '1.1.2',
    allowBeta: true,
    macosVersion: '14.4',
  });
  assert.equal(chosenBeta?.version, '2.1.0-beta.1');
  assert.equal(pickArchArtifact(chosenBeta, 'arm64')?.arch, 'arm64');
  assert.equal(pickArchArtifact(chosenBeta, 'x64'), null);

  assert.equal(selectEligibleRelease([stable200], {
    currentVersion: '1.1.2',
    blockedVersions: ['2.0.0'],
    macosVersion: '14.4',
  }), null);

  assert.equal(selectEligibleRelease([stable200], {
    currentVersion: '1.1.2',
    macosVersion: '12.7.4',
  }), null);
});

test('artifact downloader supports HTTP 206 Range resumption and rejects corrupted bytes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlsaplus-wire-dl-'));
  const payload = crypto.randomBytes(4096);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  let sawRangeHeader = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/archive.zip') {
      const range = req.headers.range;
      if (range?.startsWith('bytes=')) {
        sawRangeHeader = range;
        const start = Number(range.slice('bytes='.length).split('-')[0]);
        const rest = payload.subarray(start);
        res.writeHead(206, {
          'Content-Type': 'application/zip',
          'Content-Length': rest.byteLength,
          'Content-Range': `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength}`,
        });
        res.end(rest);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payload.byteLength });
      res.end(payload);
      return;
    }
    res.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const dest = path.join(tempDir, 'WLSAPlus-2.0.0-macOS-universal.zip');
    await fs.writeFile(`${dest}.part`, payload.subarray(0, 1500));

    const outcome = await downloadAndVerifyArtifact(
      [`${base}/missing.zip`, `${base}/archive.zip`],
      { arch: 'universal', name: 'WLSAPlus-2.0.0-macOS-universal.zip', size: payload.byteLength, sha256 },
      dest,
    );
    assert.equal(sawRangeHeader, 'bytes=1500-');
    assert.equal(outcome.resumedFrom, 1500);
    assert.deepEqual(await fs.readFile(dest), payload);

    await assert.rejects(
      downloadAndVerifyArtifact(
        [`${base}/archive.zip`],
        { arch: 'universal', name: 'WLSAPlus-2.0.0-macOS-universal.zip', size: payload.byteLength, sha256: '0'.repeat(64) },
        path.join(tempDir, 'bad.zip'),
      ),
      /SHA-256 mismatch/i,
    );
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('bundle verifier enforces codesign requirement, Info.plist identity, and processor slice', async () => {
  const calls = [];
  const runTool = async (tool, args) => {
    calls.push([tool, ...args]);
    if (tool === '/usr/libexec/PlistBuddy') {
      const query = args[1];
      if (query.includes('CFBundleIdentifier')) return `${PINNED_TRUST.bundleId}\n`;
      if (query.includes('CFBundleShortVersionString')) return '2.0.0\n';
      if (query.includes('CFBundleExecutable')) return 'WLSAPlus\n';
    }
    if (tool === 'lipo') return 'x86_64 arm64\n';
    return '';
  };

  const verified = await verifyUnpackedMacBundle('/tmp/WLSAPlus.app', {
    expectedVersion: '2.0.0',
    requiredArch: 'x64',
    runTool,
  });
  assert.deepEqual(verified.slices, ['x86_64', 'arm64']);
  assert.equal(calls.filter(([tool]) => tool === 'codesign').length, 2);
});
