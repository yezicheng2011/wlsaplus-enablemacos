import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const png2icons = require('png2icons');
const root = process.cwd();
const source = path.join(root, 'public', 'icons', 'app-icon.svg');
const buildDir = path.join(root, 'build');
await fs.mkdir(buildDir, { recursive: true });

const master = await sharp(source).resize(1024, 1024).png().toBuffer();
await fs.writeFile(path.join(buildDir, 'icon.png'), master);
await fs.writeFile(path.join(buildDir, 'icon.icns'), png2icons.createICNS(master, png2icons.BICUBIC2, 0));

console.log('Generated macOS application icons (PNG + ICNS).');
