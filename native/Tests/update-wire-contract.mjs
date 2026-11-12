// SPDX-License-Identifier: Apache-2.0
// Independently written specification verifier for the WLSAPlus macOS signed update wire contract.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const PINNED_TRUST = Object.freeze({
  product: 'wlsaplus-macos',
  bundleId: 'cn.org.wlsash.wlsaplus',
  executableName: 'WLSAPlus',
  certSha1: '764D4389AAFA0C50311E39C17DDFA1981ABEF86C',
  designatedRequirement: 'identifier "cn.org.wlsash.wlsaplus" and certificate leaf = H"764D4389AAFA0C50311E39C17DDFA1981ABEF86C"',
  publicKeySpkiBase64: 'MCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM=',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM=\n-----END PUBLIC KEY-----\n',
});

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const ZIP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\.zip$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SYSTEM_VER_PATTERN = /^[0-9]+(?:\.[0-9]+){0,2}$/u;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u;
const SUPPORTED_ARCH_KEYS = ['arm64', 'x64', 'universal'];
const MAX_MANIFEST_BYTES = 65_536;
const MAX_ARCHIVE_BYTES = 2_147_483_648;

export function parseSemver(input) {
  const normalized = String(input ?? '').trim().replace(/^v/u, '');
  const match = SEMVER_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`Invalid semantic version: ${input}`);
  }
  const prerelease = match[4] ? match[4].split('.') : [];
  for (const identifier of prerelease) {
    if (/^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`Numeric prerelease identifier has leading zero: ${input}`);
    }
  }
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function compareSemver(leftInput, rightInput) {
  const left = typeof leftInput === 'object' ? leftInput : parseSemver(leftInput);
  const right = typeof rightInput === 'object' ? rightInput : parseSemver(rightInput);
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) {
      return left[field] > right[field] ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const limit = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNum = /^[0-9]+$/u.test(a);
    const bNum = /^[0-9]+$/u.test(b);
    if (aNum && bNum) return Number(a) > Number(b) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function satisfiesMinimumSystem(currentOs, minimumOs = '13.0') {
  const currentText = String(currentOs ?? '').trim();
  const minText = String(minimumOs ?? '13.0').trim();
  if (!SYSTEM_VER_PATTERN.test(currentText) || !SYSTEM_VER_PATTERN.test(minText)) {
    throw new Error('Invalid macOS version string');
  }
  const currentParts = currentText.split('.').map(Number);
  const minParts = minText.split('.').map(Number);
  const count = Math.max(currentParts.length, minParts.length);
  for (let index = 0; index < count; index += 1) {
    const cur = currentParts[index] ?? 0;
    const req = minParts[index] ?? 0;
    if (cur < req) return false;
    if (cur > req) return true;
  }
  return true;
}

export function verifySignedManifestEnvelope(rawInput, options = {}) {
  const bytes = Buffer.isBuffer(rawInput) ? rawInput : Buffer.from(String(rawInput), 'utf8');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Manifest envelope size is out of bounds');
  }
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (!envelope || typeof envelope !== 'object' || envelope.format !== 1) {
    throw new Error('Unsupported update manifest envelope format');
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('Manifest envelope must carry string payload and signature');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.byteLength !== 64) {
    throw new Error('Ed25519 signature must decode to 64 bytes');
  }
  const keyPem = options.publicKeyPem ?? PINNED_TRUST.publicKeyPem;
  const expectedProduct = options.product ?? PINNED_TRUST.product;
  const publicKey = crypto.createPublicKey(keyPem);
  const verified = crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), publicKey, signature);
  if (!verified) {
    throw new Error('Ed25519 manifest signature verification failed');
  }

  const body = JSON.parse(envelope.payload);
  if (!body || typeof body !== 'object' || body.product !== expectedProduct) {
    throw new Error('Manifest product identifier mismatch');
  }
  const parsedVersion = parseSemver(body.version);
  const tag = String(body.tag ?? '');
  if (!TAG_PATTERN.test(tag)) {
    throw new Error('Invalid release tag in signed manifest');
  }
  const minimumSystemVersion = body.minimumSystemVersion === undefined ? '13.0' : String(body.minimumSystemVersion);
  if (!SYSTEM_VER_PATTERN.test(minimumSystemVersion)) {
    throw new Error('Invalid minimumSystemVersion in signed manifest');
  }
  if (!body.files || typeof body.files !== 'object') {
    throw new Error('Signed manifest is missing files map');
  }

  const files = {};
  for (const archKey of SUPPORTED_ARCH_KEYS) {
    const entry = body.files[archKey];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid file descriptor for ${archKey}`);
    }
    const name = String(entry.name ?? '');
    const size = entry.size;
    const sha256 = String(entry.sha256 ?? '');
    if (!ZIP_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid archive filename for ${archKey}`);
    }
    if (!Number.isInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Invalid archive byte size for ${archKey}`);
    }
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`Invalid archive SHA-256 digest for ${archKey}`);
    }
    files[archKey] = { arch: archKey, name, size, sha256 };
  }
  if (Object.keys(files).length === 0) {
    throw new Error('Signed manifest contains no supported architecture archives');
  }

  return {
    version: parsedVersion.version,
    semver: parsedVersion,
    tag,
    channel: body.channel === 'beta' ? 'beta' : 'stable',
    minimumSystemVersion,
    notes: String(body.notes ?? '').slice(0, 2000),
    files,
  };
}

export function selectEligibleRelease(manifests, options) {
  const {
    currentVersion,
    allowBeta = false,
    blockedVersions = [],
    macosVersion = '14.0',
  } = options;
  const baseline = parseSemver(currentVersion);
  const blocked = new Set(blockedVersions.map(v => parseSemver(v).version));
  const eligible = manifests.filter(item => {
    if (compareSemver(item.semver, baseline) <= 0) return false;
    if (blocked.has(item.version)) return false;
    if (!satisfiesMinimumSystem(macosVersion, item.minimumSystemVersion)) return false;
    if (!allowBeta && (item.channel !== 'stable' || item.semver.prerelease.length > 0)) return false;
    return true;
  });
  eligible.sort((a, b) => compareSemver(b.semver, a.semver));
  return eligible[0] ?? null;
}

export function pickArchArtifact(manifest, hostArch) {
  const normalized = hostArch === 'x86_64' ? 'x64' : hostArch;
  if (normalized !== 'arm64' && normalized !== 'x64') {
    throw new Error(`Unsupported Mac processor architecture: ${hostArch}`);
  }
  return manifest.files[normalized] ?? manifest.files.universal ?? null;
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function downloadAndVerifyArtifact(candidateUrls, artifact, destinationPath, options = {}) {
  const fetchFn = options.fetchImpl ?? fetch;
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const partialPath = `${destinationPath}.part`;
  let lastError = new Error('No download URL succeeded');

  for (const url of candidateUrls) {
    try {
      let existingBytes = 0;
      try {
        const stat = await fs.stat(partialPath);
        if (stat.size > 0 && stat.size < artifact.size) {
          existingBytes = stat.size;
        } else if (stat.size >= artifact.size) {
          await fs.rm(partialPath, { force: true });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const headers = { 'Cache-Control': 'no-cache' };
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
      }
      const response = await fetchFn(url, { headers });
      if (existingBytes > 0 && response.status === 206) {
        if (!response.body) throw new Error('Empty 206 response body');
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: 'a' }));
      } else if (response.status === 200) {
        if (!response.body) throw new Error('Empty 200 response body');
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: 'w' }));
      } else {
        throw new Error(`Unexpected HTTP status ${response.status}`);
      }

      const finalStat = await fs.stat(partialPath);
      if (finalStat.size !== artifact.size) {
        await fs.rm(partialPath, { force: true });
        throw new Error(`Archive size mismatch: expected ${artifact.size}, got ${finalStat.size}`);
      }
      const actualHash = await sha256File(partialPath);
      if (actualHash !== artifact.sha256) {
        await fs.rm(partialPath, { force: true });
        throw new Error('Archive SHA-256 mismatch');
      }
      await fs.rename(partialPath, destinationPath);
      return { url, size: finalStat.size, sha256: actualHash, resumedFrom: existingBytes };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function verifyUnpackedMacBundle(bundlePath, options) {
  const {
    expectedVersion,
    requiredArch,
    runTool,
    bundleId = PINNED_TRUST.bundleId,
    executableName = PINNED_TRUST.executableName,
    designatedRequirement = PINNED_TRUST.designatedRequirement,
  } = options;
  const sliceName = requiredArch === 'x64' ? 'x86_64' : requiredArch;
  await runTool('codesign', ['--verify', '--deep', '--strict', bundlePath]);
  await runTool('codesign', ['--verify', `-R=${designatedRequirement}`, bundlePath]);

  const infoPlist = path.join(bundlePath, 'Contents', 'Info.plist');
  const actualBundleId = (await runTool('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlist])).trim();
  const actualVersion = (await runTool('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoPlist])).trim();
  const actualExec = (await runTool('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', infoPlist])).trim();
  if (actualBundleId !== bundleId || actualVersion !== expectedVersion || actualExec !== executableName) {
    throw new Error(`Bundle Info.plist identity mismatch: ${actualBundleId} ${actualVersion} ${actualExec}`);
  }

  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', executableName);
  const archOutput = await runTool('lipo', ['-archs', executablePath]);
  const slices = archOutput.trim().split(/\s+/u).filter(Boolean);
  if (!slices.includes(sliceName)) {
    throw new Error(`Bundle executable does not include required ${sliceName} slice (found: ${slices.join(', ')})`);
  }
  return { bundleId: actualBundleId, version: actualVersion, slices };
}
