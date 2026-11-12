// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import '../Resources/i18n.js';

const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATTRIBUTION = 'by Daniel.YE  AL29-4 https://danielye2011.uk';

function read(relative) {
  return fs.readFileSync(path.join(native, relative), 'utf8');
}

function visible(html) {
  return html.replace(/<[^>]+>/g, '');
}

test('splash, footer, and dialog show the exact attribution and the AppIcon', () => {
  const html = read('Resources/index.html');
  const css = read('Resources/style.css');
  const app = read('Resources/app.js');
  const lines = [...html.matchAll(/<p class="attribution"[^>]*>[\s\S]*?<\/p>/g)].map(match => visible(match[0]));
  assert.deepEqual(lines, [ATTRIBUTION, ATTRIBUTION, ATTRIBUTION]);
  assert.equal(html.includes('M5 7h7'), false);
  assert.match(html, /<img class="splash-icon" src="AppIcon\.png"/);
  assert.match(html, /<img class="brand-mark" src="AppIcon\.png"/);
  assert.match(html, /<p class="splash-wordmark">WLSA<span class="brand-plus">Plus<\/span><\/p>/);
  const footerAt = html.indexOf('class="app-footer"');
  const viewAt = html.indexOf('id="view"');
  const mainClose = html.indexOf('</main>');
  assert.ok(viewAt < mainClose && mainClose < footerAt, 'footer stays in the window chrome, after the page view');
  assert.match(html, /<footer class="dialog-attribution"/);
  assert.match(css, /backdrop-filter:\s*blur\(28px\)/);
  assert.match(css, /font-size:\s*medium/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(app, /function dismissSplash\(/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /a\.attribution-link/);
  assert.match(read('Sources/App/Program.swift'), /NSVisualEffectView/);
  assert.ok(visible(read('Sources/Platform/UserServices.swift')).includes(ATTRIBUTION));

  const png = fs.readFileSync(path.join(native, 'Resources/AppIcon.png'));
  const icns = fs.readFileSync(path.join(native, 'Icon/AppIcon.icns'));
  let offset = 8;
  let icon = null;
  while (offset < icns.length) {
    const type = icns.subarray(offset, offset + 4).toString('latin1');
    const length = icns.readUInt32BE(offset + 4);
    if (type === 'ic10') icon = icns.subarray(offset + 8, offset + length);
    offset += length;
  }
  assert.ok(icon);
  assert.ok(png.equals(icon), 'in-app logo is the 1024px AppIcon bitmap');
});

test('release pkg is signed with the pinned identity and updates stay on zip', () => {
  const build = read('scripts/build.sh');
  const release = read('scripts/release.sh');
  assert.match(build, /\/usr\/bin\/pkgbuild --component "\$app" --install-location \/Applications/);
  assert.match(build, /\/usr\/bin\/productbuild --sign "\$pkg_identity"/);
  assert.match(build, /out\/WLSAPlus-\$\{version\}-macOS-universal\.pkg/);
  assert.match(build, /WLSAPLUS_SIGN_IDENTITY is unset/);
  assert.equal(build.includes('productbuild --sign "-"'), false);
  assert.equal(build.includes("productbuild --sign '-'"), false);
  assert.match(release, /WLSAPLUS_SIGN_IDENTITY='764D4389AAFA0C50311E39C17DDFA1981ABEF86C'/);
  assert.match(release, /cannot be ad-hoc signed/);
  assert.match(release, /WLSAPlus-\$WLSAPLUS_VERSION-macOS-universal\.pkg/);
  assert.match(release, /--file "arm64=release-assets\/WLSAPlus-\$WLSAPLUS_VERSION-mac-arm64\.zip"/);
  assert.match(release, /--file "universal=release-assets\/WLSAPlus-\$WLSAPLUS_VERSION-macOS-universal\.zip"/);
  assert.equal(release.includes('update-manifest') && release.includes('.pkg" \\'), false);
});
