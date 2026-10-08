// Pure, platform-independent pieces of the macOS self-updater (unit-tested in update-core.test.cjs):
// version comparison, signed-manifest verification, asset choice and a resumable, sha256-checked download.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { UPDATE_PRODUCT } = require('./update-config.cjs');

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\.zip$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ARCHES = ['arm64', 'x64', 'universal'];
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

function parseVersion(value) {
  const match = SEMVER_RE.exec(String(value || '').trim().replace(/^v/u, ''));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function isPrerelease(value) {
  const parsed = parseVersion(value);
  return Boolean(parsed && parsed.prerelease.length);
}

/** Semver precedence: -1 / 0 / 1. Throws on invalid input. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  if (!x.prerelease.length || !y.prerelease.length) {
    if (x.prerelease.length === y.prerelease.length) return 0;
    return x.prerelease.length ? -1 : 1; // 1.1.0-beta.1 < 1.1.0
  }
  const length = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/u.test(p);
    const qn = /^\d+$/u.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p > q ? 1 : -1;
    }
  }
  return 0;
}

/** "13.6.1" style macOS versions. */
function compareOsVersions(a, b) {
  const x = String(a || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = String(b || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

function signPayload(payload, privateKey) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { format: 1, payload: text, signature: crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') };
}

/**
 * Verifies the Ed25519 signature over the exact payload bytes and validates every field.
 * Returns the parsed payload; throws on anything unexpected.
 */
function verifyManifest(manifestText, publicKeyPem) {
  if (typeof manifestText !== 'string' || manifestText.length > MAX_MANIFEST_BYTES) throw new Error('Update manifest is too large.');
  let envelope;
  try { envelope = JSON.parse(manifestText); } catch { throw new Error('Update manifest is not valid JSON.'); }
  if (!envelope || envelope.format !== 1 || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('Update manifest has an unknown format.');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64) throw new Error('Update manifest signature is malformed.');
  const key = crypto.createPublicKey(publicKeyPem);
  if (!crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), key, signature)) {
    throw new Error('Update manifest signature is invalid.');
  }
  let payload;
  try { payload = JSON.parse(envelope.payload); } catch { throw new Error('Update manifest payload is not valid JSON.'); }
  if (!payload || payload.product !== UPDATE_PRODUCT) throw new Error('Update manifest is for another product.');
  if (!parseVersion(payload.version)) throw new Error('Update manifest has an invalid version.');
  if (typeof payload.tag !== 'string' || !TAG_RE.test(payload.tag)) throw new Error('Update manifest has an invalid tag.');
  if (payload.minimumSystemVersion !== undefined && !/^\d+(\.\d+){0,2}$/u.test(String(payload.minimumSystemVersion))) {
    throw new Error('Update manifest has an invalid minimum macOS version.');
  }
  if (!payload.files || typeof payload.files !== 'object') throw new Error('Update manifest lists no files.');
  const files = {};
  for (const arch of ARCHES) {
    const file = payload.files[arch];
    if (file === undefined) continue;
    if (!file || typeof file.name !== 'string' || !ASSET_RE.test(file.name)
      || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_ASSET_BYTES
      || typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) {
      throw new Error(`Update manifest entry for ${arch} is invalid.`);
    }
    files[arch] = { name: file.name, size: file.size, sha256: file.sha256 };
  }
  if (!Object.keys(files).length) throw new Error('Update manifest lists no files.');
  return {
    product: payload.product,
    version: String(payload.version).replace(/^v/u, ''),
    tag: payload.tag,
    channel: payload.channel === 'beta' ? 'beta' : 'stable',
    releasedAt: typeof payload.releasedAt === 'string' ? payload.releasedAt : null,
    minimumSystemVersion: payload.minimumSystemVersion ? String(payload.minimumSystemVersion) : null,
    notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 2000) : '',
    files,
  };
}

/** The zip this Mac should download: its own chip first, the universal build as a fallback. */
function pickUpdateFile(manifest, arch) {
  const own = arch === 'arm64' ? 'arm64' : 'x64';
  if (manifest.files[own]) return { arch: own, ...manifest.files[own] };
  if (manifest.files.universal) return { arch: 'universal', ...manifest.files.universal };
  return null;
}

/**
 * Picks the newest acceptable manifest. Stable-channel apps never accept prerelease versions; versions the
 * helper already had to roll back are skipped (a newer build is offered again).
 */
function chooseUpdate({ currentVersion, channel, manifests, failedVersions = [], systemVersion = null }) {
  let best = null;
  for (const manifest of manifests) {
    if (!manifest) continue;
    if (channel !== 'beta' && isPrerelease(manifest.version)) continue;
    if (failedVersions.includes(manifest.version)) continue;
    if (compareVersions(manifest.version, currentVersion) <= 0) continue;
    if (systemVersion && manifest.minimumSystemVersion && compareOsVersions(systemVersion, manifest.minimumSystemVersion) < 0) continue;
    if (!best || compareVersions(manifest.version, best.version) > 0) best = manifest;
  }
  return best;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

async function fileSize(file) {
  try { return (await fsp.stat(file)).size; } catch { return -1; }
}

/** Fetches a small text resource from the first URL that answers. */
async function fetchText(urls, { fetchImpl = fetch, timeoutMs = 90_000, maxBytes = MAX_MANIFEST_BYTES } = {}) {
  let lastError = null;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
      if (response.status === 404) { lastError = Object.assign(new Error(`Not found: ${url}`), { notFound: true }); continue; }
      if (!response.ok) { lastError = new Error(`HTTP ${response.status} for ${url}`); continue; }
      const text = await response.text();
      if (text.length > maxBytes) { lastError = new Error(`Response too large: ${url}`); continue; }
      return text;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('No update source answered.');
}

/**
 * Downloads one file into `dest`, resuming `dest + '.part'` with a Range request when possible, trying each
 * URL in turn, and only renames it into place after size and sha256 match. Returns the URL that worked.
 */
// Timeouts are generous: on a cold cache the official site first pulls the whole file from GitHub into its
// Drive-backed cache before the first byte arrives (measured 15-40 s), so the first byte may take minutes.
async function downloadVerified({ urls, dest, size, sha256, fetchImpl = fetch, onProgress = () => {}, firstByteTimeoutMs = 300_000, idleTimeoutMs = 120_000 }) {
  if ((await fileSize(dest)) === size && (await sha256File(dest)) === sha256) {
    onProgress(size, size);
    return null;
  }
  await fsp.rm(dest, { force: true });
  const part = `${dest}.part`;
  let lastError = null;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let have = await fileSize(part);
        if (have > size) { await fsp.rm(part, { force: true }); have = -1; }
        if (have === size) {
          if ((await sha256File(part)) === sha256) {
            await fsp.rename(part, dest);
            onProgress(size, size);
            return url;
          }
          await fsp.rm(part, { force: true });
          have = -1;
        }
        const controller = new AbortController();
        let idle = setTimeout(() => controller.abort(), firstByteTimeoutMs);
        const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
        try {
          const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
          let append = false;
          if (response.status === 206 && have > 0) append = true;
          else if (response.status !== 200) throw new Error(`HTTP ${response.status} for ${url}`);
          if (!response.body) throw new Error(`Empty response from ${url}`);
          let received = append ? have : 0;
          const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
          try {
            for await (const chunk of Readable.fromWeb(response.body)) {
              clearTimeout(idle);
              idle = setTimeout(() => controller.abort(), idleTimeoutMs);
              received += chunk.length;
              if (received > size) throw new Error('Download is larger than expected.');
              if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
              onProgress(received, size);
            }
          } finally {
            await new Promise((resolve) => out.end(resolve));
          }
        } finally {
          clearTimeout(idle);
        }
        const got = await fileSize(part);
        if (got !== size) throw new Error(`Download incomplete (${got} of ${size} bytes).`);
        const digest = await sha256File(part);
        if (digest !== sha256) {
          await fsp.rm(part, { force: true });
          throw new Error('Downloaded file failed the sha256 check.');
        }
        await fsp.rename(part, dest);
        return url;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error('Download failed.');
}

module.exports = {
  parseVersion,
  isPrerelease,
  compareVersions,
  compareOsVersions,
  signPayload,
  verifyManifest,
  pickUpdateFile,
  chooseUpdate,
  sha256File,
  fetchText,
  downloadVerified,
};
