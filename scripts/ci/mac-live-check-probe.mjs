#!/usr/bin/env node
// Real-Mac probe of the in-app update check against the LIVE feed (no test override): launches an installed
// WLSAPlus.app with Chromium remote debugging, opens Settings, clicks "Check now" like a user and records every
// change of the Updates row (message text, button) plus the main-process log. Used to reproduce bug reports.
// Usage: node scripts/ci/mac-live-check-probe.mjs /Applications/WLSAPlus.app <seconds> <logdir>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [appPath = '/Applications/WLSAPlus.app', seconds = '300', logDir = 'e2e-logs'] = process.argv.slice(2);
fs.mkdirSync(logDir, { recursive: true });
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...parts) => { const line = `${ts()} ${parts.join(' ')}`; console.log(line); fs.appendFileSync(path.join(logDir, 'probe.log'), `${line}\n`); };
const port = 9333;
const mainLog = fs.openSync(path.join(logDir, 'app-main.log'), 'a');
const child = spawn(path.join(appPath, 'Contents/MacOS/WLSAPlus'), [`--remote-debugging-port=${port}`], { stdio: ['ignore', mainLog, mainLog] });
log('launched pid', child.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWs() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((p) => p.type === 'page' && /index\.html/u.test(p.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no renderer page');
}

const ws = new WebSocket(await pageWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') log('RENDERER console', msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  if (msg.method === 'Runtime.exceptionThrown') log('RENDERER exception', JSON.stringify(msg.params.exceptionDetails).slice(0, 600));
});
let closed = false;
ws.addEventListener('close', () => { closed = true; for (const resolve of pending.values()) resolve({}); pending.clear(); });
const send = (method, params = {}) => new Promise((resolve) => { if (closed) { resolve({}); return; } id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');

// Hook the preload bridge so every status the renderer receives (event or IPC return) is logged.
await evaluate(`(() => {
  const u = window.wlsaplus && window.wlsaplus.updater; if (!u) return 'no updater bridge';
  window.__probe = [];
  u.onStatus((s) => window.__probe.push({ t: Date.now(), via: 'event', s }));
  return 'hooked';
})()`).then((r) => log('hook', r));
// Without a saved schedule the shell redirects to /connect; offline mode lets Settings open like for a signed-in user.
await evaluate(`sessionStorage.setItem('wlsaplus:offline', 'true'); location.hash = '#/settings'; 1`);
for (let i = 0; i < 20 && !/settings/u.test(await evaluate('location.hash')); i += 1) { await sleep(500); await evaluate(`location.hash = '#/settings'; 1`); }
await sleep(1000);
log('route', await evaluate('location.hash'));
const rowExpr = `(() => { const s=[...document.querySelectorAll('.setting')].find(e=>/^\\s*WLSAPlus \\d/.test(e.querySelector('strong')?.textContent||'')); if(!s) return 'NO-UPDATES-ROW'; const span=s.querySelector(':scope > div > span'); const b=s.querySelector(':scope > button'); return JSON.stringify({ text: span ? span.textContent : null, button: b ? b.textContent.trim() : null, disabled: b ? b.disabled : null }); })()`;
log('row before click', await evaluate(rowExpr));
log('status() IPC', JSON.stringify(await evaluate('window.wlsaplus.updater.status()')));
// Click like the user (after the 8 s automatic check has had a chance to start, as on a real Mac).
await sleep(Number(process.env.PROBE_CLICK_DELAY_MS || 0));
log('click', await evaluate(`(() => { const s=[...document.querySelectorAll('.setting')].find(e=>/^\\s*WLSAPlus \\d/.test(e.querySelector('strong')?.textContent||'')); const b=s && s.querySelector(':scope > button'); if(!b) return 'no button'; b.click(); return 'clicked disabled=' + b.disabled; })()`));
let prev = ''; let seen = 0; let restarted = false;
const end = Date.now() + Number(seconds) * 1000;
while (Date.now() < end) {
  const row = await evaluate(rowExpr).catch(() => null);
  if (row === null || row === undefined) { log('renderer gone (app quit)'); break; }
  if (row !== prev) { prev = row; log('ROW', row); }
  // PROBE_INSTALL=1: click "Restart to update" like the user once the update is ready.
  if (process.env.PROBE_INSTALL === '1' && !restarted && /Restart to update/u.test(row)) {
    restarted = true;
    log('click restart', await evaluate(`(() => { const s=[...document.querySelectorAll('.setting')].find(e=>/^\\s*WLSAPlus \\d/.test(e.querySelector('strong')?.textContent||'')); const b=s && s.querySelector(':scope > button'); if(!b) return 'no button'; b.click(); return 'clicked'; })()`).catch((e) => 'eval failed: ' + e.message));
  }
  const events = await evaluate(`JSON.stringify((window.__probe||[]).slice(${seen}))`);
  for (const e of JSON.parse(events || '[]')) { seen += 1; log('STATUS', e.via, JSON.stringify(e.s)); }
  await sleep(500);
}
const updatesDir = path.join(os.homedir(), 'Library/Application Support/WLSAPlus/updates');
if (restarted) {
  // The helper swaps the app and relaunches it; wait for its result line.
  for (let i = 0; i < 240; i += 1) {
    const text = fs.existsSync(path.join(updatesDir, 'update.log')) ? fs.readFileSync(path.join(updatesDir, 'update.log'), 'utf8') : '';
    if (/ result \{/u.test(text)) break;
    await sleep(1000);
  }
  const { execFileSync } = await import('node:child_process');
  log('installed version now:', execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents/Info.plist')]).toString().trim());
  try { log('codesign:', execFileSync('codesign', ['-dv', '--verbose=2', appPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()); } catch (e) { log('codesign -dv:', String(e.stderr || e.message).split('\n').filter((l) => /Identifier|Authority|TeamIdentifier/u.test(l)).join(' | ')); }
}
log('updates dir:', fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir, { recursive: true }).join(', ') : '(missing)');
try { log('update.log:\n' + fs.readFileSync(path.join(updatesDir, 'update.log'), 'utf8')); } catch { log('no update.log'); }
try { ws.close(); } catch {}
child.kill('SIGTERM');
spawnSync('pkill', ['-f', 'WLSAPlus.app/Contents/MacOS/WLSAPlus']);
await sleep(3000);
try { child.kill('SIGKILL'); } catch {}
process.exit(0);
