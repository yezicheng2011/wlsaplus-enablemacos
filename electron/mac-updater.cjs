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
const BUSY = new Set(['checking', 'downloading', 'ready', 'installing']);

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
  let status = {
    state: supported ? 'idle' : 'unsupported',
    message: supported ? 'Ready to check for updates.' : 'Automatic updates need the installed macOS app.',
    currentVersion,
    version: null,
    percent: null,
    channel: 'stable',
  };

  function channel() {
    return channelOverride || settings.channel || (isPrerelease(currentVersion) ? 'beta' : 'stable');
  }

  function setStatus(patch) {
    status = { ...status, ...patch, channel: channel() };
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

  async function fetchManifest(tag) {
    const text = await fetchText(assetUrls(feed, tag, MANIFEST_NAME), { fetchImpl });
    return verifyManifest(text, publicKeyPem);
  }

  async function fetchStableManifest() {
    let latest = null;
    try {
      latest = JSON.parse(await fetchText([stableLatestUrl(feed)], { fetchImpl }));
    } catch (error) {
      // Site unavailable: the mirrors can still resolve GitHub's "latest" (non-prerelease) release.
      for (const mirror of feed.mirrors) {
        try {
          const text = await fetchText([`${mirror}https://github.com/${UPDATE_REPO}/releases/latest/download/${MANIFEST_NAME}`], { fetchImpl });
          return verifyManifest(text, publicKeyPem);
        } catch {}
      }
      throw error;
    }
    const assets = Array.isArray(latest?.assets) ? latest.assets : [];
    if (typeof latest?.tag !== 'string' || !assets.some((asset) => asset && asset.name === MANIFEST_NAME)) return null; // e.g. 1.0.9: no self-update yet
    return fetchManifest(latest.tag);
  }

  async function check() {
    if (!supported) return status;
    if (BUSY.has(status.state)) return status;
    setStatus({ state: 'checking', message: 'Checking for updates...', version: null, percent: null });
    const wanted = channel();
    const manifests = [];
    const errors = [];
    try {
      manifests.push(await fetchStableManifest());
    } catch (error) { errors.push(error); }
    if (wanted === 'beta') {
      try { manifests.push(await fetchManifest(BETA_CHANNEL_TAG)); } catch (error) { if (!error?.notFound) errors.push(error); }
    }
    if (!manifests.some(Boolean) && errors.length) {
      const signatureProblem = errors.find((error) => /signature|manifest/iu.test(String(error?.message)));
      return setStatus({
        state: 'error',
        message: signatureProblem ? `Update rejected: ${signatureProblem.message}` : 'Could not check for updates. Check your internet connection.',
        percent: null,
      });
    }
    const chosen = chooseUpdate({ currentVersion, channel: wanted, manifests, failedVersions: settings.failedVersions, systemVersion });
    if (!chosen) return setStatus({ state: 'up-to-date', message: 'WLSAPlus is up to date.', version: null, percent: null });
    const file = pickUpdateFile(chosen, arch);
    if (!file) return setStatus({ state: 'error', message: `WLSAPlus ${chosen.version} has no build for this Mac.`, version: chosen.version, percent: null });
    const location = await installLocation();
    if (location.problem) return setStatus({ state: 'error', message: location.problem, version: chosen.version, percent: null });
    setStatus({ state: 'available', message: `WLSAPlus ${chosen.version} is available.`, version: chosen.version, percent: null });
    return download(chosen, file, location);
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

  async function download(manifest, file, location) {
    const stagingDir = path.join(updatesDir, 'staging', manifest.version);
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
      setStatus({ state: 'downloading', message: `Downloading WLSAPlus ${manifest.version}...`, version: manifest.version, percent: 0 });
      let lastPercent = -1;
      const zipPath = path.join(stagingDir, file.name);
      await downloadVerified({
        urls: assetUrls(feed, manifest.tag, file.name),
        dest: zipPath,
        size: file.size,
        sha256: file.sha256,
        fetchImpl,
        onProgress: (received, total) => {
          const percent = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            setStatus({ state: 'downloading', message: `Downloading WLSAPlus ${manifest.version}: ${percent}%`, percent });
          }
        },
      });
      setStatus({ state: 'downloading', message: `Verifying WLSAPlus ${manifest.version}...`, percent: 100 });
      const appDir = path.join(stagingDir, 'app');
      await fsp.rm(appDir, { recursive: true, force: true });
      await fsp.mkdir(appDir, { recursive: true });
      await run('ditto', ['-x', '-k', zipPath, appDir]);
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
      staged = { version: manifest.version, stagedApp, marker: path.join(stagingDir, MARKER_NAME), file, location };
      return setStatus({ state: 'ready', message: `WLSAPlus ${manifest.version} is ready. Restart to update (or it installs when you quit).`, version: manifest.version, percent: 100 });
    } catch (error) {
      staged = null;
      const detail = error instanceof Error ? error.message : String(error);
      return setStatus({ state: 'error', message: `Update failed: ${detail}`.slice(0, 300), percent: null });
    }
  }

  function helperArgs(location, mode) {
    const timeout = feed.test && /^\d+$/u.test(String(env.WLSAPLUS_UPDATE_HELPER_TIMEOUT || '')) ? String(env.WLSAPLUS_UPDATE_HELPER_TIMEOUT) : '90';
    return [
      helperFile,
      '--pid', String(pid),
      '--target', location.target,
      '--staged', staged.stagedApp,
      '--backup', backupApp,
      '--marker', staged.marker,
      '--result', resultFile,
      '--version', staged.version,
      '--from', currentVersion,
      '--mode', mode,
      '--admin', location.admin ? '1' : '0',
      '--timeout', timeout,
      '--log', path.join(updatesDir, 'update.log'),
    ];
  }

  /** "Restart now": clean up (VPN off), start the helper, quit. */
  async function install() {
    if (status.state !== 'ready' || !staged) return status;
    const location = await installLocation();
    if (location.problem) return setStatus({ state: 'error', message: location.problem, percent: null });
    setStatus({ state: 'installing', message: 'Closing WLSAPlus and installing the update...', percent: 100 });
    try {
      await beforeInstall();
      spawnDetached('/bin/bash', helperArgs(location, 'restart'));
    } catch (error) {
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
    if (quitInstallStarted || status.state !== 'ready' || !staged || !staged.location?.target || staged.location.admin) return false;
    quitInstallStarted = true;
    try {
      spawnDetached('/bin/bash', helperArgs(staged.location, 'quit'));
      return true;
    } catch {
      return false;
    }
  }

  async function setChannel(next) {
    if (!['beta', 'stable'].includes(next)) return status;
    settings.channel = next;
    await saveSettings().catch(() => {});
    setStatus({});
    return status;
  }

  async function start() {
    await loadSettings();
    if (!supported) return status;
    await consumeLastResult();
    checkTimer = setTimeout(() => void check(), CHECK_DELAY_MS);
    checkTimer.unref?.();
    intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
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

module.exports = { createMacUpdater, bundlePathFromExe, validMarkerPath, argValue, updatesDirFor, MARKER_NAME };
