// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDirectory = path.join(native, 'Icon');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('bitmap icon is a well-formed icns covering every Dock and Finder size', async () => {
  const data = await fs.readFile(path.join(iconDirectory, 'AppIcon.icns'));
  assert.equal(data.subarray(0, 4).toString('latin1'), 'icns');
  assert.equal(data.readUInt32BE(4), data.length, 'icns header length must match the file');
  const expected = { icp4: 16, icp5: 32, ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };
  const found = {};
  let offset = 8;
  while (offset < data.length) {
    const type = data.subarray(offset, offset + 4).toString('latin1');
    const length = data.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= data.length, `entry ${type} overruns the file`);
    const image = data.subarray(offset + 8, offset + length);
    assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), `entry ${type} must be a PNG`);
    assert.equal(image.subarray(12, 16).toString('latin1'), 'IHDR');
    assert.equal(image[24], 8, `entry ${type} must be 8-bit`);
    assert.equal(image[25], 6, `entry ${type} must be RGBA so the corners stay transparent`);
    assert.equal(image.readUInt32BE(16), image.readUInt32BE(20), `entry ${type} must be square`);
    found[type] = image.readUInt32BE(16);
    offset += length;
  }
  assert.equal(offset, data.length);
  assert.deepEqual(found, expected);
});

test('layered icon references existing layers and specializes the dark appearance', async () => {
  const bundle = path.join(iconDirectory, 'AppIcon.icon');
  const description = JSON.parse(await fs.readFile(path.join(bundle, 'icon.json'), 'utf8'));
  const appearances = description['fill-specializations'].map(item => item.appearance ?? 'default');
  assert.deepEqual(appearances.sort(), ['dark', 'default']);
  const layers = description.groups.flatMap(group => group.layers);
  assert.ok(layers.length > 0);
  const referenced = new Set();
  for (const layer of layers) {
    assert.match(layer['image-name'], /^[a-z-]+\.svg$/u);
    const source = await fs.readFile(path.join(bundle, 'Assets', layer['image-name']), 'utf8');
    assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024">/u);
    assert.doesNotMatch(source, /<(?:text|image|script|filter|foreignObject)\b/u, 'layers must stay plain vector shapes');
    referenced.add(layer['image-name']);
  }
  assert.deepEqual((await fs.readdir(path.join(bundle, 'Assets'))).sort(), [...referenced].sort(), 'no unused or missing layer files');
});

test('build installs the icon and declares it in Info.plist', async () => {
  const build = await fs.readFile(path.join(native, 'scripts', 'build.sh'), 'utf8');
  assert.match(build, /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/u);
  assert.match(build, /<key>CFBundleIconName<\/key><string>AppIcon<\/string>/u);
  assert.match(build, /cp Icon\/AppIcon\.icns "\$app\/Contents\/Resources\/AppIcon\.icns"/u);
  assert.match(build, /Icon\/AppIcon\.icon --compile/u);
  const signing = build.indexOf('/usr/bin/codesign --force');
  assert.ok(signing > build.indexOf('Assets.car') && signing > build.indexOf('AppIcon.icns'), 'icon files must be in place before signing');
});
