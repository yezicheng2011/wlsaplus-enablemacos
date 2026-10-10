// macOS self-updater: check -> download (resumable, sha256) -> unpack + verify -> swap via update-helper.sh.
// No Squirrel/Developer ID needed. All side effects (fetch, child processes, quitting) are injected so the
// state machine is unit-tested in mac-updater.test.cjs; the macOS-only commands run in the CI end-to-end test.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  MANIFEST_NAME,
  BETA_CHANNEL_TAG,
  BUNDLE_ID,
  UPDATE_PUBLIC_KEY_PEM,
  UPDATE_REPO,
  CODESIGN_REQUIREMENT,
  CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  resolveUpdateBase,
  stableLatestUrl,
  assetUrls,
} = require('./update-config.cjs');
const {
  isPrerelease,
  verifyManifest,
  pickUpdateFile,
  chooseUpdate,
  fetchText,
  downloadVerified,
} = require('./update-core.cjs');

const MARKER_NAME = 'launched.marker';
const BUSY = new Set(['checking', 'available', 'downloading', 'ready', 'installing']);
const LOG_MAX_BYTES = 512 * 1024;

/** Every state has something to show, even if a code path forgets its message. */
const FALLBACK_MESSAGES = {
  idle: 'Ready to check for updates.',
  checking: 'Checking for updates...',
  available: 'An update is available.',
  downloading: 'Downloading the update...',
  ready: 'The update is ready. Restart to update.',
  installing: 'Installing the update...',
  'up-to-date': 'WLSAPlus is up to date.',
  error: 'The update check failed. Try again later.',
  unsupported: 'Automatic updates need the installed macOS app.',
};

function describeError(error) {
  if (!error) return 'unknown error';
  const parts = [error.name && error.name !== 'Error' ? error.name : '', error.message || String(error)];
  const cause = error.cause;
  if (cause) parts.push(`(cause: ${cause.code || ''} ${cause.message || String(cause)})`.replace(/\s+/gu, ' '));
  return parts.filter(Boolean).join(': ').slice(0, 500);
}

function updatesDirFor(userData) { return path.join(userData, 'updates'); }

/** Bundle path of the running app (…/WLSAPlus.app) from process.execPath. */
function bundlePathFromExe(exePath) {
  const bundle = path.resolve(path.dirname(exePath), '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/** Only marker paths inside <userData>/updates/staging/<version>/launched.marker are honoured. */
function validMarkerPath(userData, candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  const staging = path.join(updatesDirFor(userData), 'staging') + path.sep;
  return resolved.startsWith(staging) && path.basename(resolved) === MARKER_NAME ? resolved : null;
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((argument) => argument.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function createMacUpdater(options) {
  const {
    currentVersion,
    userData,
    exePath,
    arch,
    systemVersion = null,
    supported,
    env = process.env,
    argv = process.argv,
    fetchImpl = fetch,
    run,                    // async (cmd, args) => stdout
    spawnDetached,          // (cmd, args) => void
    helperSource,           // path of update-helper.sh (inside app.asar)
    beforeInstall = async () => {},
    quit = () => {},
    onStatus = () => {},
    pid = process.pid,
    accessImpl = (p) => fsp.access(p, fs.constants.W_OK),
    statfsImpl = (p) => fsp.statfs(p),
    publicKeyPem = UPDATE_PUBLIC_KEY_PEM,
    // True when update-helper.sh launched this process (--wlsaplus-update-marker): the helper still needs the
    // staging folder (marker) and the backup (rollback), so they must not be cleaned up now.
    launchedByUpdater = false,
  } = options;

  const updatesDir = updatesDirFor(userData);
  const settingsFile = path.join(updatesDir, 'settings.json');
  const resultFile = path.join(updatesDir, 'last-result.json');
  const helperFile = path.join(updatesDir, 'update-helper.sh');
  const backupApp = path.join(updatesDir, 'backup', 'WLSAPlus.app');
  const feed = resolveUpdateBase(env);
  const channelOverride = ['beta', 'stable'].includes(argValue(argv, 'update-channel')) ? argValue(argv, 'update-channel') : null;
  let settings = { channel: null, failedVersions: [] };
  let staged = null; // { version, stagedApp, marker, file }
  let checkTimer = null;
  let intervalTimer = null;
  let job = null;   // promise of the running background download (check() never waits for it)
  let operation = null; // identity + cancellation for a check and its background download
  let channelCleanup = Promise.resolve(); // finish removing cancelled staging before another download
  let seq = 0;      // increases with every status, so the UI can ignore stale replies
  const logFile = path.join(updatesDir, 'update.log');
  let logReady = null;
  let status = {
    state: supported ? 'idle' : 'unsupported',
    message: supported ? 'Ready to check for updates.' : 'Automatic updates need the installed macOS app.',
    currentVersion,
    version: null,
    percent: null,
    channel: 'stable',
    seq: 0,
  };

  /** Appends one line to updates/update.log (shared with update-helper.sh); never throws. */
  function log(line) {
    const text = `${new Date().toISOString()} [app ${currentVersion}] ${line}\n`;
    logReady = (logReady || Promise.resolve()).then(async () => {
      try {
        await fsp.mkdir(updatesDir, { recursive: true });
        const info = await fsp.stat(logFile).catch(() => null);
        if (info && info.size > LOG_MAX_BYTES) await fsp.rename(logFile, `${logFile}.1`).catch(() => {});
        await fsp.appendFile(logFile, text);
      } catch {}
    });
    return logReady;
  }

  function channel() {
    return channelOverride || settings.channel || (isPrerelease(currentVersion) ? 'beta' : 'stable');
  }

  function accepts(update) {
    return channel() === 'beta' || !isPrerelease(update.version);
  }

  function isCurrent(active) {
    return operation === active && !active.controller.signal.aborted;
  }

  function setStatus(patch) {
    const next = { ...status, ...patch, channel: channel() };
    if (typeof next.message !== 'string' || !next.message.trim()) next.message = FALLBACK_MESSAGES[next.state] || FALLBACK_MESSAGES.error;
    seq += 1;
    next.seq = seq;
    const changed = next.state !== status.state || next.message !== status.message;
    status = next;
    // Progress ticks are not logged one by one (only every 10 %).
    if (changed && !(status.state === 'downloading' && status.percent !== null && status.percent % 10 !== 0 && status.percent !== 100)) {
      void log(`status ${status.state}: ${status.message}`);
    }
    try { onStatus(status); } catch {}
    return status;
  }

  async function loadSettings() {
    try {
      const raw = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
      settings = {
        channel: ['beta', 'stable'].includes(raw.channel) ? raw.channel : null,
        failedVersions: Array.isArray(raw.failedVersions) ? raw.failedVersions.filter((v) => typeof v === 'string').slice(-20) : [],
      };
    } catch {}
    status = { ...status, channel: channel() };
  }

  async function saveSettings() {
    await fsp.mkdir(updatesDir, { recursive: true });
    await fsp.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  /** Reads what the helper reported after the previous update, then tidies old staging/backup folders. */
  async function consumeLastResult() {
    let result = null;
    try { result = JSON.parse(await fsp.readFile(resultFile, 'utf8')); } catch {}
    await fsp.rm(resultFile, { force: true }).catch(() => {});
    if (result && result.state === 'rolled_back' && typeof result.to === 'string') {
      if (!settings.failedVersions.includes(result.to)) settings.failedVersions.push(result.to);
      await saveSettings().catch(() => {});
      setStatus({ state: 'error', message: `WLSAPlus ${result.to} did not start, so the previous version was restored.`, version: null, percent: null });
    } else if (result && result.state === 'failed') {
      setStatus({ state: 'error', message: String(result.message || 'The last update could not be installed.').slice(0, 300), version: null, percent: null });
    } else if (result && result.state === 'updated' && result.to === currentVersion) {
      setStatus({ state: 'up-to-date', message: `Updated to WLSAPlus ${currentVersion}.`, version: null, percent: null });
    }
    if (!launchedByUpdater) {
      await fsp.rm(path.join(updatesDir, 'staging'), { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.dirname(backupApp), { recursive: true, force: true }).catch(() => {});
    }
    return result;
  }

  async function installLocation() {
    const target = bundlePathFromExe(exePath);
    if (!target) return { problem: 'WLSAPlus is not running from an app bundle.' };
    if (target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) {
      return { problem: 'Move WLSAPlus to the Applications folder to enable automatic updates.' };
    }
    let admin = false;
    try {
      await accessImpl(path.dirname(target));
      await accessImpl(target);
    } catch {
      admin = true;
    }
    return { target, admin };
  }

  async function fetchManifest(tag, signal) {
    const urls = assetUrls(feed, tag, MANIFEST_NAME);
    const started = Date.now();
    try {
      const text = await fetchText(urls, { fetchImpl, signal, onAttempt: (url, outcome) => void log(`  GET ${url} -> ${outcome}`) });
      const manifest = verifyManifest(text, publicKeyPem);
      void log(`manifest ${tag}: version ${manifest.version}, files ${Object.keys(manifest.files || {}).join('/')} (${Date.now() - started} ms, signature ok)`);
      return manifest;
    } catch (error) {
      void log(`manifest ${tag}: FAILED after ${Date.now() - started} ms: ${describeError(error)}`);
      throw error;
    }
  }

  async function fetchStableManifest(signal) {
    let latest = null;
    try {
      const started = Date.now();
      latest = JSON.parse(await fetchText([stableLatestUrl(feed)], { fetchImpl, signal, onAttempt: (url, outcome) => void log(`  GET ${url} -> ${outcome}`) }));
      void log(`stable latest: ${latest?.tag} (${Date.now() - started} ms)`);
    } catch (error) {
      signal?.throwIfAborted();
      void log(`stable latest: FAILED: ${describeError(error)}; trying mirrors`);
      // Site unavailable: the mirrors can still resolve GitHub's "latest" (non-prerelease) release.
      for (const mirror of feed.mirrors) {
        try {
          const text = await fetchText([`${mirror}https://github.com/${UPDATE_REPO}/releases/latest/download/${MANIFEST_NAME}`], { fetchImpl, signal });
          return verifyManifest(text, publicKeyPem);
        } catch {}
      }
      throw error;
    }
    const assets = Array.isArray(latest?.assets) ? latest.assets : [];
    if (typeof latest?.tag !== 'string' || !assets.some((asset) => asset && asset.name === MANIFEST_NAME)) {
      void log(`stable latest ${latest?.tag} has no ${MANIFEST_NAME} (not self-updating yet)`);
      return null; // e.g. 1.0.9: no self-update yet
    }
    return fetchManifest(latest.tag, signal);
  }

  /**
   * Looks for an update and, if there is one, starts downloading it in the background. Resolves as soon as the
   * check itself is done (never waits for the download, which can take minutes); progress and the final result
   * arrive through onStatus. Every outcome, including unexpected exceptions, ends in a state with a message.
   */
  async function check({ reason = 'manual' } = {}) {
    if (!supported) return status;
    // A channel switch may queue more cleanup while this check is already waiting.
    let pendingCleanup;
    do {
      pendingCleanup = channelCleanup;
      await pendingCleanup;
    } while (pendingCleanup !== channelCleanup);
    if (BUSY.has(status.state)) {
      void log(`check (${reason}) ignored: already ${status.state}`);
      return status;
    }
    const active = { controller: new AbortController(), wanted: channel(), manifest: null };
    operation = active;
    setStatus({ state: 'checking', message: 'Checking for updates...', version: null, percent: null });
    void log(`check (${reason}): version ${currentVersion}, channel ${channel()}, arch ${arch}, macOS ${systemVersion || '?'}, feed ${feed.base}`);
    try {
      return await checkInner(active);
    } catch (error) {
      if (!isCurrent(active)) return status;
      void log(`check: unexpected error: ${describeError(error)}\n${error?.stack || ''}`);
      return setStatus({ state: 'error', message: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), percent: null });
    } finally {
      if (isCurrent(active) && !job) operation = null;
    }
  }

  async function checkInner(active) {
    const wanted = active.wanted;
    const signal = active.controller.signal;
    const manifests = [];
    const errors = [];
    try {
      manifests.push(await fetchStableManifest(signal));
    } catch (error) { errors.push(error); }
    if (!isCurrent(active)) return status;
    if (wanted === 'beta') {
      try { manifests.push(await fetchManifest(BETA_CHANNEL_TAG, signal)); } catch (error) {
        if (error?.notFound) void log('beta channel: no test build is published right now');
        else errors.push(error);
      }
    }
    if (!isCurrent(active)) return status;
    if (!manifests.some(Boolean) && errors.length) {
      const signatureProblem = errors.find((error) => /signature|not valid JSON|unexpected product/iu.test(String(error?.message)));
      return setStatus({
        state: 'error',
        message: signatureProblem ? `Update rejected: ${signatureProblem.message}` : 'Could not check for updates. Check your internet connection.',
        percent: null,
      });
    }
    const chosen = chooseUpdate({ currentVersion, channel: wanted, manifests, failedVersions: settings.failedVersions, systemVersion });
    void log(`candidates: ${manifests.filter(Boolean).map((m) => m.version).join(', ') || 'none'}; skipped failed: ${settings.failedVersions.join(', ') || 'none'}; chosen: ${chosen ? chosen.version : 'none'}`);
    if (!chosen) {
      const partial = errors.length ? ' (some update sources did not answer)' : '';
      return setStatus({ state: 'up-to-date', message: `WLSAPlus ${currentVersion} is up to date${wanted === 'beta' ? ' (test builds on)' : ''}.${partial}`, version: null, percent: null });
    }
    const file = pickUpdateFile(chosen, arch);
    if (!file) return setStatus({ state: 'error', message: `WLSAPlus ${chosen.version} has no build for this Mac.`, version: chosen.version, percent: null });
    active.manifest = chosen;
    const location = await installLocation();
    if (!isCurrent(active)) return status;
    void log(`install location: ${location.problem || `${location.target} (admin needed: ${location.admin})`}`);
    if (location.problem) return setStatus({ state: 'error', message: location.problem, version: chosen.version, percent: null });
    setStatus({ state: 'available', message: `WLSAPlus ${chosen.version} is available.`, version: chosen.version, percent: null });
    // Background: the IPC reply (and the button) must not wait minutes for the download.
    const downloadJob = download(chosen, file, location, active).finally(() => {
      if (job === downloadJob) job = null;
      if (operation === active) operation = null;
    });
    job = downloadJob;
    return status;
  }

  /** Resolves with the final status of the running background download (tests, auto-install poll). */
  async function idle() {
    if (job) await job;
    return status;
  }

  async function verifyStagedApp(appDir, manifest, file) {
    const entries = (await fsp.readdir(appDir)).filter((name) => name !== '__MACOSX' && name !== '.DS_Store');
    if (entries.length !== 1 || entries[0] !== 'WLSAPlus.app') throw new Error('The update archive does not contain WLSAPlus.app.');
    const stagedApp = path.join(appDir, 'WLSAPlus.app');
    await run('xattr', ['-cr', stagedApp]).catch(() => {});
    await run('codesign', ['--verify', '--deep', '--strict', stagedApp]);
    await run('codesign', ['--verify', `-R=${CODESIGN_REQUIREMENT}`, stagedApp]);
    const plist = path.join(stagedApp, 'Contents', 'Info.plist');
    const bundleId = String(await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim();
    if (bundleId !== BUNDLE_ID) throw new Error(`Unexpected bundle id ${bundleId}.`);
    const version = String(await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).trim();
    if (version !== manifest.version) throw new Error(`The update contains version ${version}, expected ${manifest.version}.`);
    const archs = String(await run('lipo', ['-archs', path.join(stagedApp, 'Contents', 'MacOS', 'WLSAPlus')])).trim().split(/\s+/u);
    const need = file.arch === 'universal' ? ['arm64', 'x86_64'] : [file.arch === 'arm64' ? 'arm64' : 'x86_64'];
    if (!need.every((a) => archs.includes(a))) throw new Error(`The update is built for ${archs.join(' ')}.`);
    return stagedApp;
  }

  async function download(manifest, file, location, active) {
    const stagingDir = path.join(updatesDir, 'staging', manifest.version);
    const signal = active.controller.signal;
    try {
      // Drop staging folders of other versions.
      await fsp.mkdir(path.join(updatesDir, 'staging'), { recursive: true });
      for (const name of await fsp.readdir(path.join(updatesDir, 'staging'))) {
        if (name !== manifest.version) await fsp.rm(path.join(updatesDir, 'staging', name), { recursive: true, force: true });
      }
      await fsp.mkdir(stagingDir, { recursive: true });
      try {
        const fsInfo = await statfsImpl(stagingDir);
        const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
        if (Number.isFinite(free) && free < file.size * 3) throw new Error(`Not enough disk space for the update (${Math.ceil((file.size * 3) / 1e6)} MB needed).`);
      } catch (error) {
        if (/disk space/u.test(String(error?.message))) throw error;
      }
      signal.throwIfAborted();
      setStatus({ state: 'downloading', message: `Downloading WLSAPlus ${manifest.version}...`, version: manifest.version, percent: 0 });
      let lastPercent = -1;
      const zipPath = path.join(stagingDir, file.name);
      void log(`download ${file.name} (${file.size} bytes, sha256 ${file.sha256.slice(0, 12)}...)`);
      const startedAt = Date.now();
      const usedUrl = await downloadVerified({
        urls: assetUrls(feed, manifest.tag, file.name),
        dest: zipPath,
        size: file.size,
        sha256: file.sha256,
        fetchImpl,
        signal,
        onAttempt: (url, outcome) => void log(`  GET ${url} -> ${outcome}`),
        onProgress: (received, total) => {
          if (!isCurrent(active)) return;
          const percent = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            setStatus({ state: 'downloading', message: `Downloading WLSAPlus ${manifest.version}: ${percent}%`, percent });
          }
        },
      });
      signal.throwIfAborted();
      void log(`download done from ${usedUrl || 'existing file'} in ${Math.round((Date.now() - startedAt) / 1000)} s, sha256 ok`);
      setStatus({ state: 'downloading', message: `Verifying WLSAPlus ${manifest.version}...`, percent: 100 });
      const appDir = path.join(stagingDir, 'app');
      await fsp.rm(appDir, { recursive: true, force: true });
      await fsp.mkdir(appDir, { recursive: true });
      await run('ditto', ['-x', '-k', zipPath, appDir]);
      signal.throwIfAborted();
      let stagedApp;
      try {
        stagedApp = await verifyStagedApp(appDir, manifest, file);
      } catch (error) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      // readFile (not copyFile): the helper lives inside app.asar.
      await fsp.writeFile(helperFile, await fsp.readFile(helperSource), { mode: 0o755 });
      await fsp.chmod(helperFile, 0o755);
      signal.throwIfAborted();
      staged = { version: manifest.version, stagedApp, marker: path.join(stagingDir, MARKER_NAME), file, location };
      return setStatus({ state: 'ready', message: `WLSAPlus ${manifest.version} is ready. Restart to update (or it installs when you quit).`, version: manifest.version, percent: 100 });
    } catch (error) {
      if (!isCurrent(active)) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        return status;
      }
      staged = null;
      void log(`download/verify FAILED: ${describeError(error)}`);
      const detail = error instanceof Error ? error.message : String(error);
      return setStatus({ state: 'error', message: `Update failed: ${detail}`.slice(0, 300), percent: null });
    }
  }

  function helperArgs(location, mode, candidate) {
    const timeout = feed.test && /^\d+$/u.test(String(env.WLSAPLUS_UPDATE_HELPER_TIMEOUT || '')) ? String(env.WLSAPLUS_UPDATE_HELPER_TIMEOUT) : '90';
    return [
      helperFile,
      '--pid', String(pid),
      '--target', location.target,
      '--staged', candidate.stagedApp,
      '--backup', backupApp,
      '--marker', candidate.marker,
      '--result', resultFile,
      '--version', candidate.version,
      '--from', currentVersion,
      '--mode', mode,
      '--admin', location.admin ? '1' : '0',
      '--timeout', timeout,
      '--log', path.join(updatesDir, 'update.log'),
    ];
  }

  /** "Restart now": clean up (VPN off), start the helper, quit. */
  async function install() {
    if (status.state !== 'ready' || !staged || !accepts(staged)) return status;
    const candidate = staged;
    const location = await installLocation();
    if (status.state !== 'ready' || staged !== candidate || !accepts(candidate)) return status;
    if (location.problem) return setStatus({ state: 'error', message: location.problem, percent: null });
    setStatus({ state: 'installing', message: 'Closing WLSAPlus and installing the update...', percent: 100 });
    void log(`install (restart): ${candidate.version} -> ${location.target} (admin: ${location.admin})`);
    try {
      await beforeInstall();
      if (status.state !== 'installing' || staged !== candidate || !accepts(candidate)) return status;
      spawnDetached('/bin/bash', helperArgs(location, 'restart', candidate));
    } catch (error) {
      if (staged !== candidate || !accepts(candidate)) return status;
      return setStatus({ state: 'error', message: `Update failed: ${error instanceof Error ? error.message : String(error)}`, percent: null });
    }
    quit();
    return status;
  }

  /**
   * Called synchronously from will-quit: a ready update is installed silently after the app has exited.
   * Skipped when the swap would need an administrator password (no surprise prompt after quitting).
   */
  let quitInstallStarted = false;
  function installOnQuit() {
    if (quitInstallStarted || status.state !== 'ready' || !staged || !accepts(staged) || !staged.location?.target || staged.location.admin) return false;
    quitInstallStarted = true;
    void log(`install on quit: ${staged.version}`);
    try {
      spawnDetached('/bin/bash', helperArgs(staged.location, 'quit', staged));
      return true;
    } catch {
      return false;
    }
  }

  async function setChannel(next) {
    if (!['beta', 'stable'].includes(next)) return status;
    const previous = channel();
    settings.channel = next;
    if (channel() !== previous) {
      const cancel = operation && (!operation.manifest || !accepts(operation.manifest));
      const discarded = staged && !accepts(staged) ? staged : null;
      if (cancel) {
        operation.controller.abort();
        operation = null;
      }
      // Revoke installation eligibility before the first await (including installOnQuit).
      if (discarded) staged = null;
      if (cancel || discarded) {
        const cancelledJob = cancel ? job : null;
        channelCleanup = Promise.all([channelCleanup, cancelledJob]).then(async () => {
          if (discarded) await fsp.rm(path.dirname(discarded.marker), { recursive: true, force: true }).catch(() => {});
        });
        setStatus({ state: supported ? 'idle' : 'unsupported', message: 'Update channel changed. Check for updates again.', version: null, percent: null });
      }
    }
    await saveSettings().catch(() => {});
    await channelCleanup;
    void log(`channel set to ${next}`);
    setStatus({});
    return status;
  }

  async function start() {
    await loadSettings();
    if (!supported) return status;
    await consumeLastResult();
    void log(`started: version ${currentVersion}, channel ${channel()}, arch ${arch}, exe ${exePath}`);
    checkTimer = setTimeout(() => void check({ reason: 'startup' }), CHECK_DELAY_MS);
    checkTimer.unref?.();
    intervalTimer = setInterval(() => void check({ reason: 'interval' }), CHECK_INTERVAL_MS);
    intervalTimer.unref?.();
    return status;
  }

  function stop() {
    clearTimeout(checkTimer);
    clearInterval(intervalTimer);
  }

  return {
    start,
    stop,
    check,
    idle,
    log,
    install,
    installOnQuit,
    installLocation,
    setChannel,
    getStatus: () => status,
    getChannel: channel,
    loadSettings,
    consumeLastResult,
    get staged() { return staged; },
    feed,
  };
}

module.exports = { createMacUpdater, bundlePathFromExe, validMarkerPath, argValue, updatesDirFor, MARKER_NAME, FALLBACK_MESSAGES };
