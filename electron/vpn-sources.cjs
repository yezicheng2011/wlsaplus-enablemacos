'use strict';

// No built-in relay URL in the packaged client. Prefer a user-supplied Clash
// HTTPS subscription, or inject WLSAPLUS_DEFAULT_SUBSCRIPTION_URL at release time
// for the native macOS app. Never commit a live subscription URL here.
const VPN_SOURCES = Object.freeze({});

function getVpnSource(id) {
  if (id && VPN_SOURCES[id]) return VPN_SOURCES[id];
  return Object.freeze({
    id: id || 'custom',
    name: 'Custom subscription',
    description: 'Provide a Clash HTTPS subscription URL.',
    endpoint: '',
  });
}

function subscriptionUrl(sourceId, format = 'ss') {
  const source = getVpnSource(sourceId);
  if (!source.endpoint) {
    throw new Error('No Clash subscription URL is configured. Add an https:// subscription URL.');
  }
  const url = new URL(source.endpoint);
  url.searchParams.set('format', format);
  return url;
}

module.exports = { VPN_SOURCES, getVpnSource, subscriptionUrl };
