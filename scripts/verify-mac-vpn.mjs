// The bundled universal mihomo core is copied to Resources/bin by Electron Forge.
// Verify it locally before packaging; no VPN core download is required.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const macVpnPackage = path.join(root, 'electron', 'bin', 'mac-vpn.tar.gz');
const relativePackage = path.relative(root, macVpnPackage);

if (!fs.existsSync(macVpnPackage)) {
  throw new Error(`Missing ${relativePackage} (mihomo, the macOS VPN core). Restore it from git.`);
}

const listing = spawnSync('tar', ['-tzf', macVpnPackage], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (listing.error || listing.status !== 0) {
  throw new Error(`Could not verify ${relativePackage}: ${listing.error?.message || listing.stderr.trim() || 'tar failed'}`);
}
if (!/^(?:\.\/)?clash_pkg\/clash$/m.test(listing.stdout)) {
  throw new Error(`${relativePackage} does not contain clash_pkg/clash.`);
}

console.log(`macOS VPN core: mihomo in ${relativePackage}`);
