// The checked-in font subset keeps normal builds offline and Python-free.
// Regenerate after adding icons with: pip install 'fonttools[woff]' && npm run symbols:generate
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'node_modules/material-symbols');
const destination = path.join(root, 'build/fonts');
const manifestPath = path.join(destination, 'material-symbols.json');
const supported = new Set([...readFileSync(path.join(upstream, 'index.d.ts'), 'utf8').matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]));
const used = new Set();
for (const file of readdirSync(path.join(root, 'src'), { recursive: true })) {
  if (!/\.(ts|html)$/.test(file) || file.endsWith('.spec.ts')) continue;
  const source = readFileSync(path.join(root, 'src', file), 'utf8');
  // Include inline templates and every literal (navigation items, task icons,
  // conditional icons, and helper return values), not only static span text.
  for (const match of source.matchAll(/['"]([a-z0-9_]+)['"]|>\s*([a-z0-9_]+)\s*</g)) {
    const name = match[1] || match[2];
    if (supported.has(name)) used.add(name);
  }
}
const icons = [...used].sort();
if (process.argv.includes('--generate')) {
  const result = spawnSync('python3', [
    path.join(root, 'scripts/subset-material-symbols.py'),
    path.join(upstream, 'material-symbols-rounded.woff2'),
    path.join(destination, 'material-symbols-rounded.woff2'),
  ], { input: JSON.stringify(icons), encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Font generation failed. Install fonttools[woff]. ${result.stderr || ''}`, { cause: result.error });
  }
  writeFileSync(manifestPath, `${JSON.stringify(icons, null, 2)}\n`);
  cpSync(path.join(upstream, 'LICENSE'), path.join(destination, 'LICENSE-material-symbols.txt'));
}
const bundled = new Set(JSON.parse(readFileSync(manifestPath, 'utf8')));
const missing = icons.filter((name) => !bundled.has(name));
if (missing.length) throw new Error(`Font subset is missing ${missing.join(', ')}. Run npm run symbols:generate.`);
console.log(`Material Symbols subset covers ${icons.length} source icons.`);
