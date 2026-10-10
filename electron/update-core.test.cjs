const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const test = require('node:test');
const core = require('./update-core.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function payload(overrides = {}) {
  return {
    product: 'wlsaplus-macos',
    version: '1.1.1',
    tag: 'v1.1.1',
    channel: 'stable',
    minimumSystemVersion: '13.0',
    files: {
      arm64: { name: 'WLSAPlus-1.1.1-mac-arm64.zip', size: 10, sha256: 'a'.repeat(64) },
      x64: { name: 'WLSAPlus-1.1.1-mac-x64.zip', size: 11, sha256: 'b'.repeat(64) },
    },
    ...overrides,
  };
}
const signed = (p, key = privateKey) => JSON.stringify(core.signPayload(p, key));

test('compareVersions follows semver precedence incl. prereleases', () => {
  const ordered = ['1.0.9', '1.1.0-alpha', '1.1.0-beta.1', '1.1.0-beta.2', '1.1.0-beta.10', '1.1.0-rc.1', '1.1.0', '1.1.1-beta.1', '1.1.1', '1.2.0', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(core.compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(core.compareVersions(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(core.compareVersions('v1.1.0', '1.1.0'), 0);
  assert.equal(core.compareVersions('1.1.0+build.5', '1.1.0'), 0);
  assert.equal(core.isPrerelease('1.1.0-beta.1'), true);
  assert.equal(core.isPrerelease('1.1.0'), false);
  assert.throws(() => core.compareVersions('1.1', '1.1.0'), /Invalid version/);
  assert.equal(core.compareOsVersions('13.6.1', '13.0'), 1);
  assert.equal(core.compareOsVersions('12.7', '13.0'), -1);
  assert.equal(core.compareOsVersions('13', '13.0.0'), 0);
});

test('verifyManifest accepts a correctly signed manifest', () => {
  const manifest = core.verifyManifest(signed(payload()), publicPem);
  assert.equal(manifest.version, '1.1.1');
  assert.equal(manifest.tag, 'v1.1.1');
  assert.equal(manifest.files.arm64.name, 'WLSAPlus-1.1.1-mac-arm64.zip');
});

test('verifyManifest rejects tampering, wrong keys and malformed fields', () => {
  const good = core.signPayload(payload(), privateKey);
  const tampered = { ...good, payload: good.payload.replace('"size":10', '"size":12') };
  assert.throws(() => core.verifyManifest(JSON.stringify(tampered), publicPem), /signature is invalid/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => core.verifyManifest(signed(payload(), other), publicPem), /signature is invalid/);
  assert.throws(() => core.verifyManifest(JSON.stringify({ ...good, signature: 'AAAA' }), publicPem), /malformed/);
  assert.throws(() => core.verifyManifest('{', publicPem), /not valid JSON/);
  assert.throws(() => core.verifyManifest(JSON.stringify({ format: 2 }), publicPem), /unknown format/);
  assert.throws(() => core.verifyManifest(signed(payload({ product: 'other' })), publicPem), /another product/);
  assert.throws(() => core.verifyManifest(signed(payload({ version: 'latest' })), publicPem), /invalid version/);
  assert.throws(() => core.verifyManifest(signed(payload({ tag: '../x' })), publicPem), /invalid tag/);
  assert.throws(() => core.verifyManifest(signed(payload({ files: { arm64: { name: '../evil.zip', size: 1, sha256: 'a'.repeat(64) } } })), publicPem), /arm64 is invalid/);
  assert.throws(() => core.verifyManifest(signed(payload({ files: { arm64: { name: 'a.zip', size: -1, sha256: 'a'.repeat(64) } } })), publicPem), /invalid/);
  assert.throws(() => core.verifyManifest(signed(payload({ files: { arm64: { name: 'a.zip', size: 1, sha256: 'XYZ' } } })), publicPem), /invalid/);
  assert.throws(() => core.verifyManifest(signed(payload({ files: {} })), publicPem), /no files/);
});

test('pickUpdateFile picks the own chip, then universal', () => {
  const manifest = core.verifyManifest(signed(payload()), publicPem);
  assert.equal(core.pickUpdateFile(manifest, 'arm64').arch, 'arm64');
  assert.equal(core.pickUpdateFile(manifest, 'x64').name, 'WLSAPlus-1.1.1-mac-x64.zip');
  const universalOnly = core.verifyManifest(signed(payload({ files: { universal: { name: 'u.zip', size: 5, sha256: 'c'.repeat(64) } } })), publicPem);
  assert.equal(core.pickUpdateFile(universalOnly, 'arm64').arch, 'universal');
  const armOnly = core.verifyManifest(signed(payload({ files: { arm64: { name: 'a.zip', size: 5, sha256: 'c'.repeat(64) } } })), publicPem);
  assert.equal(core.pickUpdateFile(armOnly, 'x64'), null);
});

test('chooseUpdate: stable ignores prereleases, beta takes the newest, no downgrades, skips rolled-back versions', () => {
  const m = (version, minimumSystemVersion = null) => ({ version, minimumSystemVersion, files: {} });
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0', channel: 'stable', manifests: [m('1.1.1-beta.1')] }), null);
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0', channel: 'stable', manifests: [m('1.1.1'), m('1.1.2-beta.1')] }).version, '1.1.1');
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0-beta.1', channel: 'beta', manifests: [null, m('1.1.1-beta.1')] }).version, '1.1.1-beta.1');
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0-beta.1', channel: 'beta', manifests: [m('1.1.1'), m('1.1.1-beta.1')] }).version, '1.1.1');
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.1', channel: 'beta', manifests: [m('1.1.1'), m('1.1.0')] }), null);
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0', channel: 'stable', manifests: [m('1.1.1')], failedVersions: ['1.1.1'] }), null);
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0', channel: 'stable', manifests: [m('1.2.0', '14.0')], systemVersion: '13.6' }), null);
  assert.equal(core.chooseUpdate({ currentVersion: '1.1.0', channel: 'stable', manifests: [m('1.2.0', '13.0')], systemVersion: '13.6' }).version, '1.2.0');
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('downloadVerified downloads, verifies sha256 and falls back to the next URL', async () => {
  const body = crypto.randomBytes(300_000);
  const { server, base } = await startServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(500); res.end(); return; }
    if (req.url === '/corrupt') { res.writeHead(200); res.end(Buffer.alloc(body.length)); return; }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-dl-'));
  try {
    const dest = path.join(dir, 'a.zip');
    const progress = [];
    const used = await core.downloadVerified({ urls: [`${base}/bad`, `${base}/corrupt`, `${base}/good`], dest, size: body.length, sha256: sha(body), onProgress: (r) => progress.push(r) });
    assert.equal(used, `${base}/good`);
    assert.deepEqual(fs.readFileSync(dest), body);
    assert.equal(progress.at(-1), body.length);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    // Already complete: no network needed.
    assert.equal(await core.downloadVerified({ urls: ['http://127.0.0.1:1/never'], dest, size: body.length, sha256: sha(body) }), null);
    // Every source corrupt: rejected, nothing left behind.
    const bad = path.join(dir, 'b.zip');
    await assert.rejects(core.downloadVerified({ urls: [`${base}/corrupt`], dest: bad, size: body.length, sha256: sha(body) }), /sha256/);
    assert.equal(fs.existsSync(bad), false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadVerified resumes a partial download with a Range request', async () => {
  const body = crypto.randomBytes(200_000);
  const ranges = [];
  const { server, base } = await startServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    ranges.push(req.headers.range || null);
    if (range) {
      const start = Number(range[1]);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200);
    res.end(body);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-dl-'));
  try {
    const dest = path.join(dir, 'a.zip');
    fs.writeFileSync(`${dest}.part`, body.subarray(0, 120_000));
    await core.downloadVerified({ urls: [`${base}/f`], dest, size: body.length, sha256: sha(body) });
    assert.deepEqual(ranges, ['bytes=120000-']);
    assert.deepEqual(fs.readFileSync(dest), body);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchText tries URLs in order and flags 404s', async () => {
  const { server, base } = await startServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end('hello');
  });
  try {
    assert.equal(await core.fetchText([`${base}/missing`, `${base}/ok`]), 'hello');
    await assert.rejects(core.fetchText([`${base}/missing`]), (error) => error.notFound === true);
  } finally {
    server.close();
  }
});

test('downloadVerified waits for a slow first byte but aborts a stalled transfer', async () => {
  const body = crypto.randomBytes(50_000);
  const { server, base } = await startServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end(body); }, 400); return; }
    res.writeHead(200, { 'Content-Length': body.length });
    res.write(body.subarray(0, 1000)); // then stall forever
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-dl-'));
  try {
    await core.downloadVerified({ urls: [`${base}/slow`], dest: path.join(dir, 'a.zip'), size: body.length, sha256: sha(body), firstByteTimeoutMs: 2000, idleTimeoutMs: 100 });
    await assert.rejects(core.downloadVerified({ urls: [`${base}/stall`], dest: path.join(dir, 'b.zip'), size: body.length, sha256: sha(body), firstByteTimeoutMs: 2000, idleTimeoutMs: 200 }));
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadVerified rejects writable open, write and finalization failures without uncaught errors', async (t) => {
  const body = crypto.randomBytes(100_000);
  for (const phase of ['open', 'write', 'final']) {
    await t.test(phase, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-dl-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const dest = path.join(dir, 'update.zip');
      const writes = [];
      t.mock.method(fs, 'createWriteStream', () => {
        const fail = (callback) => setImmediate(() => callback(Object.assign(new Error(`ENOSPC during ${phase}`), { code: 'ENOSPC' })));
        const out = new Writable({
          highWaterMark: 1, // The write failure happens while the pipeline is waiting for drain.
          construct(callback) { if (phase === 'open') fail(callback); else callback(); },
          write(chunk, encoding, callback) { if (phase === 'write') fail(callback); else callback(); },
          final(callback) { if (phase === 'final') fail(callback); else callback(); },
        });
        writes.push(out);
        return out;
      });
      await assert.rejects(core.downloadVerified({
        urls: ['https://updates.example/update.zip'], dest, size: body.length, sha256: sha(body),
        fetchImpl: async () => new Response(body),
      }), { code: 'ENOSPC' });
      assert.equal(writes.length, 2, 'both attempts reject normally');
      assert.ok(writes.every((out) => out.destroyed), 'failed output streams are closed');
      assert.equal(fs.existsSync(dest), false, 'failed output never becomes an installable archive');
    });
  }
});

test('downloadVerified cancellation closes a stalled transfer without retrying other sources', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const body = crypto.randomBytes(1000);
  const dest = path.join(dir, 'update.zip');
  let requests = 0;
  let cancelled = false;
  await assert.rejects(core.downloadVerified({
    urls: ['https://updates.example/update.zip', 'https://mirror.example/update.zip'],
    dest, size: body.length * 2, sha256: sha(body), signal: controller.signal,
    fetchImpl: async () => {
      requests += 1;
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(body); },
        cancel() { cancelled = true; },
      }));
    },
    onProgress: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(dest), false);
});
