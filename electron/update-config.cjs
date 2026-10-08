// macOS self-update feed (replaces electron-updater / Squirrel.Mac, which needs an Apple Developer ID).
//
// Every download comes from the official site (wlsaplus.spacehubxyz.hk, which mirrors the GitHub release
// server-side) and, only as a fallback, from the gh-proxy mirrors. The app never talks to github.com itself.
// Integrity does not depend on the transport: update-manifest.json is Ed25519-signed (public key below,
// private key only in the CI secret WLSAPLUS_UPDATE_ED25519_KEY), it pins the sha256 + size of every zip,
// and the unpacked app must carry our self-signed code-signing certificate.

const UPDATE_SITE = 'https://wlsaplus.spacehubxyz.hk';
const UPDATE_REPO = 'yezicheng2011/wlsaplus-enablemacos';
const UPDATE_MIRRORS = ['https://gh-proxy.com/', 'https://edgeone.gh-proxy.org/'];
const MANIFEST_NAME = 'update-manifest.json';
// Rolling prerelease that only carries the newest beta update-manifest.json (the beta / test channel).
// Prereleases never become /api/latest, so normal (stable channel) users never see test builds.
const BETA_CHANNEL_TAG = 'channel-beta';
const UPDATE_PRODUCT = 'wlsaplus-macos';
const BUNDLE_ID = 'cn.org.wlsash.wlsaplus';
const UPDATE_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');
// SHA-1 of the self-signed "WLSAPlus Self-Signed Code Signing" certificate used by CI. A fixed signer keeps
// the app's designated requirement stable across updates, so the Keychain ("WLSAPlus Safe Storage") does
// not ask for the login password after every update.
const CODESIGN_CERT_SHA1 = '764D4389AAFA0C50311E39C17DDFA1981ABEF86C';
const CODESIGN_REQUIREMENT = `identifier "${BUNDLE_ID}" and certificate leaf = H"${CODESIGN_CERT_SHA1}"`;

const CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Feed base URL. WLSAPLUS_UPDATE_BASE_URL is only honoured for loopback http(s) URLs (CI end-to-end test with
 * a local server); the manifest signature is still required, so this cannot be used to install anything
 * that was not signed with our key.
 */
function resolveUpdateBase(env = process.env) {
  const override = String(env.WLSAPLUS_UPDATE_BASE_URL || '').trim();
  if (override) {
    try {
      const url = new URL(override);
      if (/^https?:$/u.test(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        return { base: override.replace(/\/+$/u, ''), mirrors: [], test: true };
      }
    } catch {}
  }
  return { base: UPDATE_SITE, mirrors: UPDATE_MIRRORS.slice(), test: false };
}

function stableLatestUrl(feed) {
  return `${feed.base}/api/latest`;
}

/** Candidate URLs for one release asset: the official site first, then the mirrors. */
function assetUrls(feed, tag, name) {
  const t = encodeURIComponent(tag);
  const n = encodeURIComponent(name);
  const urls = [`${feed.base}/download/${t}/${n}${feed.test ? '' : '?via=direct'}`];
  for (const mirror of feed.mirrors) urls.push(`${mirror}https://github.com/${UPDATE_REPO}/releases/download/${t}/${n}`);
  return urls;
}

module.exports = {
  UPDATE_SITE,
  UPDATE_REPO,
  UPDATE_MIRRORS,
  MANIFEST_NAME,
  BETA_CHANNEL_TAG,
  UPDATE_PRODUCT,
  BUNDLE_ID,
  UPDATE_PUBLIC_KEY_PEM,
  CODESIGN_CERT_SHA1,
  CODESIGN_REQUIREMENT,
  CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  resolveUpdateBase,
  stableLatestUrl,
  assetUrls,
};
