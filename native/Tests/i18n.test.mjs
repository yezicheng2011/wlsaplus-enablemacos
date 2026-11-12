// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../Resources/i18n.js';
const I = globalThis.WLSAI18n;

test('fixed interface text and interpolated sentences translate to Chinese', () => {
  assert.equal(I.translate('Settings'), '设置');
  assert.equal(I.translate('  Sync PowerSchool\n'), '  同步 PowerSchool\n');
  assert.equal(I.translate('Synced Nov 12 · 9:05 AM'), '已同步 Nov 12 · 9:05 AM');
  assert.equal(I.translate('Good morning, Alex'), '早上好，Alex');
  assert.equal(I.translate('Due in 3 days'), '3 天后截止');
  assert.equal(I.translate('Detected: French'), '检测到：法语');
  assert.equal(I.translate('2 classes'), '2 节课');
  assert.equal(I.translate('Installing WLSAPlus 99.99.99.1…'), '正在安装 WLSAPlus 99.99.99.1…');
  assert.equal(I.translate('Installing the verified update…'), '正在安装已验证的更新…');
  assert.equal(I.translate('Fair use limit reached — speed temporarily reduced, will restore automatically'), '已达到合理使用上限，速度暂时降低，之后会自动恢复。');
  assert.match(I.translate('Unlimited, with fair use'), /不限流量/);
  assert.equal(I.translate('Last synchronized 2026年11月12日 at 9:09. Class reminders are off.'), '上次同步：2026年11月12日 9:09。上课提醒已关闭。');
});

test('school data and unknown text are left untouched', () => {
  for (const value of ['AP Physics C', 'Ms. Zhang Wei', 'B204', 'Read chapter 3', '', '   ', '设置']) assert.equal(I.translate(value), null);
  assert.equal(I.translate('constructor'), null);
  assert.equal(I.translate('toString'), null);
});

test('every interface label the app renders has a translation', () => {
  const source = fs.readFileSync(new URL('../Resources/app.js', import.meta.url), 'utf8');
  const labels = new Set();
  for (const match of source.matchAll(/(?:heading|btn|empty|toast|badge)\(\s*'((?:[^'\\]|\\.)+)'(?:\s*,\s*'((?:[^'\\]|\\.)+)')?(?:\s*,\s*'((?:[^'\\]|\\.)+)')?/g)) {
    for (const value of match.slice(1)) if (value && /[A-Za-z]{3}/.test(value) && /^[A-Z]/.test(value) && !/^[a-z-]+$/.test(value)) labels.add(value.replace(/\\'/g, "'"));
  }
  assert.ok(labels.size > 60, `expected many labels, found ${labels.size}`);
  const missing = [...labels].filter(label => I.translate(label) == null);
  assert.deepEqual(missing, []);
});

test('language selection is remembered outside a browser', () => {
  I.setLanguage('zh');
  assert.equal(I.language, 'zh');
  I.setLanguage('anything else');
  assert.equal(I.language, 'en');
});
