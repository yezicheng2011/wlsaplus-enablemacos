export interface VpnSource {
  id: string;
  name: string;
  description: string;
  endpoint: string;
}

// No built-in relay URL in source. Users (or release injection on the native app)
// supply a Clash HTTPS subscription. Never commit a live subscription URL here.
export const VPN_SOURCES: readonly VpnSource[] = [];

export function vpnSource(id: string): VpnSource {
  const found = VPN_SOURCES.find((source) => source.id === id);
  if (found) return found;
  return {
    id: id || 'custom',
    name: 'Custom subscription',
    description: 'Provide a Clash HTTPS subscription URL.',
    endpoint: '',
  };
}
