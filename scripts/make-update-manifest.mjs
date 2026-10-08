// Builds and Ed25519-signs update-manifest.json for the macOS self-updater (electron/mac-updater.cjs).
//
//   WLSAPLUS_UPDATE_ED25519_KEY="$(cat key.pem)" node scripts/make-update-manifest.mjs \
//     --version 1.1.0 --tag v1.1.0 --out release-assets/update-manifest.json \
//     --file arm64=release-assets/WLSAPlus-1.1.0-mac-arm64.zip --file x64=... [--file universal=...] \
//     [--channel beta] [--min-macos 13.0] [--notes "text"] [--public-key-file pub.pem]
//
// The private key comes only from the environment (CI secret) or --key-file; it is never printed. Before
// writing, the signature is verified with the public key embedded in electron/update-config.cjs (or
// --public-key-file), so a mismatched secret fails the build instead of shipping unverifiable updates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UPDATE_PRODUCT, UPDATE_PUBLIC_KEY_PEM } = require('../electron/update-config.cjs');
const { signPayload, verifyManifest, parseVersion, isPrerelease } = require('../electron/update-core.cjs');

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`Bad argument near ${key}`);
    i += 1;
    if (key === '--file') args.files.push(value);
    else args[key.slice(2)] = value;
  }
  return args;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const args = parseArgs(process.argv.slice(2));
const version = String(args.version || '').replace(/^v/, '');
if (!parseVersion(version)) throw new Error('--version must be a semantic version');
const tag = args.tag || `v${version}`;
const channel = args.channel || (isPrerelease(version) ? 'beta' : 'stable');
if (!['beta', 'stable'].includes(channel)) throw new Error('--channel must be beta or stable');
if (!args.out) throw new Error('--out is required');
if (!args.files.length) throw new Error('at least one --file arch=path is required');

const files = {};
for (const spec of args.files) {
  const [arch, file] = spec.split(/=(.*)/s);
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error(`unknown arch ${arch}`);
  const stat = fs.statSync(file);
  files[arch] = { name: path.basename(file), size: stat.size, sha256: sha256(file) };
}

const keyPem = args['key-file'] ? fs.readFileSync(args['key-file'], 'utf8') : process.env.WLSAPLUS_UPDATE_ED25519_KEY;
if (!keyPem || !keyPem.includes('PRIVATE KEY')) throw new Error('Ed25519 private key missing (WLSAPLUS_UPDATE_ED25519_KEY or --key-file)');
const privateKey = crypto.createPrivateKey(keyPem);

const payload = {
  product: UPDATE_PRODUCT,
  version,
  tag,
  channel,
  releasedAt: new Date().toISOString(),
  minimumSystemVersion: args['min-macos'] || '13.0',
  notes: args.notes || '',
  files,
};
const envelope = signPayload(payload, privateKey);
const text = `${JSON.stringify(envelope, null, 2)}\n`;
const publicKeyPem = args['public-key-file'] ? fs.readFileSync(args['public-key-file'], 'utf8') : UPDATE_PUBLIC_KEY_PEM;
verifyManifest(text, publicKeyPem); // throws if the key does not match the app's embedded public key
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, text);
console.log(`Wrote ${args.out}: ${UPDATE_PRODUCT} ${version} (${channel}, tag ${tag}) files: ${Object.entries(files).map(([a, f]) => `${a}=${f.name} ${f.size}B sha256 ${f.sha256}`).join('; ')}`);
