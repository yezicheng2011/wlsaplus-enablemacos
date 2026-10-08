const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyManifest } = require('./update-core.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'make-update-manifest.mjs');

function keyFiles(dir, name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = path.join(dir, `${name}.pem`);
  const pub = path.join(dir, `${name}.pub.pem`);
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub };
}

test('make-update-manifest signs size + sha256 of each zip and self-verifies', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsa-mf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = keyFiles(dir, 'a');
  const arm = path.join(dir, 'WLSAPlus-1.1.0-beta.1-mac-arm64.zip');
  const x64 = path.join(dir, 'WLSAPlus-1.1.0-beta.1-mac-x64.zip');
  fs.writeFileSync(arm, crypto.randomBytes(1234));
  fs.writeFileSync(x64, crypto.randomBytes(2345));
  const out = path.join(dir, 'update-manifest.json');
  const env = { ...process.env, WLSAPLUS_UPDATE_ED25519_KEY: fs.readFileSync(a.priv, 'utf8') };
  const ok = spawnSync(process.execPath, [SCRIPT, '--version', '1.1.0-beta.1', '--out', out, '--file', `arm64=${arm}`, '--file', `x64=${x64}`, '--public-key-file', a.pub], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout + ok.stderr, /PRIVATE KEY/);
  const manifest = verifyManifest(fs.readFileSync(out, 'utf8'), fs.readFileSync(a.pub, 'utf8'));
  assert.equal(manifest.version, '1.1.0-beta.1');
  assert.equal(manifest.tag, 'v1.1.0-beta.1');
  assert.equal(manifest.channel, 'beta');
  assert.equal(manifest.files.arm64.size, 1234);
  assert.equal(manifest.files.x64.sha256, crypto.createHash('sha256').update(fs.readFileSync(x64)).digest('hex'));

  // A key that does not match the public key the app embeds must fail the build.
  const b = keyFiles(dir, 'b');
  const mismatch = spawnSync(process.execPath, [SCRIPT, '--version', '1.1.0', '--out', path.join(dir, 'bad.json'), '--file', `arm64=${arm}`, '--public-key-file', a.pub], { env: { ...process.env, WLSAPLUS_UPDATE_ED25519_KEY: fs.readFileSync(b.priv, 'utf8') }, encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'bad.json')), false);

  const nokey = spawnSync(process.execPath, [SCRIPT, '--version', '1.1.0', '--out', path.join(dir, 'x.json'), '--file', `arm64=${arm}`], { env: { ...process.env, WLSAPLUS_UPDATE_ED25519_KEY: '' }, encoding: 'utf8' });
  assert.notEqual(nokey.status, 0);
  assert.match(nokey.stderr, /private key missing/);
});
