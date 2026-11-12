// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.build', 'out', 'release-assets']);
const FORBIDDEN_PATHS = [
  'electron',
  'src',
  'vpn-subscription-worker',
  'package-lock.json',
  'forge.config.cjs',
  'angular.json',
];
const FORBIDDEN_FILENAMES = new Set([
  'mac-vpn.tar.gz',
  'LICENSE-mihomo.txt',
  'LICENSE-sing-box.txt',
]);

async function walkTree(dir, collector = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    collector.push({ fullPath, relativePath: path.relative(repoRoot, fullPath), isDirectory: entry.isDirectory(), name: entry.name });
    if (entry.isDirectory()) {
      await walkTree(fullPath, collector);
    }
  }
  return collector;
}

test('root LICENSE, NOTICE, THIRD_PARTY_NOTICES, and package.json are unified under Apache-2.0', async () => {
  const [licenseText, noticeText, thirdPartyText, pkgRaw] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'LICENSE'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'NOTICE'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ]);

  assert.match(licenseText, /Apache License\s+Version 2\.0/u);
  assert.doesNotMatch(licenseText, /GNU GENERAL PUBLIC LICENSE/u);
  assert.match(noticeText, /Apache License, Version 2\.0/u);
  assert.match(thirdPartyText, /Apache License 2\.0/u);

  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'root package.json must not bundle third-party runtime npm packages');
  assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0, 'root package.json must not depend on legacy Electron/Angular toolchains');
});

test('repository contains no legacy GPL trees, package manifests, or bundled third-party VPN binaries', async () => {
  for (const forbidden of FORBIDDEN_PATHS) {
    await assert.rejects(
      fs.lstat(path.join(repoRoot, forbidden)),
      { code: 'ENOENT' },
      `Legacy GPL-era path must not remain in repository: ${forbidden}`,
    );
  }

  const allEntries = await walkTree(repoRoot);
  for (const item of allEntries) {
    assert.equal(
      FORBIDDEN_FILENAMES.has(item.name),
      false,
      `Forbidden legacy binary or license artifact found: ${item.relativePath}`,
    );
    if (item.name === 'package.json') {
      const manifest = JSON.parse(await fs.readFile(item.fullPath, 'utf8'));
      assert.equal(manifest.license, 'Apache-2.0', `${item.relativePath} must declare Apache-2.0`);
    }
  }
});

test('README local asset and documentation references resolve inside the Apache-2.0 tree', async () => {
  const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
  const refs = new Set();

  for (const match of readme.matchAll(/src="([^"]+)"/gu)) {
    refs.add(match[1]);
  }
  for (const match of readme.matchAll(/\]\(([^)]+)\)/gu)) {
    refs.add(match[1]);
  }

  for (const ref of refs) {
    if (/^(?:https?:|mailto:|#)/u.test(ref)) continue;
    const cleanRef = ref.split('#')[0];
    if (!cleanRef) continue;
    const resolved = path.join(repoRoot, cleanRef);
    const stat = await fs.stat(resolved);
    assert.ok(stat.isFile() || stat.isDirectory(), `Missing local README target: ${cleanRef}`);
  }
});
