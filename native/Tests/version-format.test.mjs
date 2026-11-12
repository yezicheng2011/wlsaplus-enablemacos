// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const nativeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(nativeRoot, '..');

function versionCheck(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/\[\[ "\$version" =~ ([^ ]+) \]\]/);
  assert.ok(match, `${file} must check $version with a shell regex`);
  return { text, regex: match[1] };
}

function accepts(regex, version) {
  const script = `version=${JSON.stringify(version)}; if [[ "$version" =~ ${regex} ]]; then echo yes; else echo no; fi`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim() === 'yes';
}

test('packaging accepts 99.99.99.0 and still accepts 3-part versions', () => {
  const build = versionCheck(path.join(nativeRoot, 'scripts/build.sh'));
  const release = versionCheck(path.join(repoRoot, '.github/workflows/release.yml'));
  assert.match(build.text, /version="\$\{WLSAPLUS_VERSION:-99\.99\.99\.0\}"/);
  assert.match(build.text, /<key>CFBundleShortVersionString<\/key><string>\$version<\/string>/);
  assert.match(build.text, /<key>CFBundleVersion<\/key><string>\$\{version%%-\*\}<\/string>/);
  const releaseScript = fs.readFileSync(path.join(nativeRoot, 'scripts/release.sh'), 'utf8');
  assert.match(releaseScript, /--make-manifest --version "\$WLSAPLUS_VERSION" --tag "v\$WLSAPLUS_VERSION"/);

  for (const version of ['2.1.1', '2.2.0', '2.0.0-beta.1', '99.99.99.0', '99.99.99.1']) {
    assert.equal(accepts(build.regex, version), true, `build.sh accepts ${version}`);
    assert.equal(accepts(release.regex, version), true, `release workflow accepts ${version}`);
  }
  for (const version of ['', '1.2', '99.99.99.0.1', '99.99.99.', 'v99.99.99.0']) {
    assert.equal(accepts(build.regex, version), false, `build.sh rejects ${version}`);
    assert.equal(accepts(release.regex, version), false, `release workflow rejects ${version}`);
  }
  assert.equal(accepts(release.regex, '01.2.3'), false, 'release workflow rejects a leading zero');
  assert.equal(accepts(release.regex, '99.99.99.01'), false, 'release workflow rejects a leading zero in the fourth segment');

  const expanded = execFileSync('bash', ['-c', [
    'version=99.99.99.0',
    'printf "%s %s\\n" "$version" "${version%%-*}"',
    'version=2.1.1-beta.2',
    'printf "%s %s\\n" "$version" "${version%%-*}"',
  ].join('\n')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(expanded, ['99.99.99.0 99.99.99.0', '2.1.1-beta.2 2.1.1']);
});
