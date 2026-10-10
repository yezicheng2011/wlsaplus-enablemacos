# WLSAPlus subscription relay

This Worker hides the upstream subscription URL from WLSAPlus clients. It is a
subscription proxy only; it does not tunnel VPN traffic. The macOS WLSAPlus app
runs its bundled mihomo (Clash Meta) core locally.

## Deploy

From this directory, authenticate with Wrangler and set the upstream as a
secret. Rotate the subscription URL first because it was previously shared in
chat:

```bash
npx wrangler login
npx wrangler secret put UPSTREAM_SUBSCRIPTION_URL
npx wrangler deploy
```

The bundled desktop client does not send `X-Subscription-Key`.
Leave `SUBSCRIPTION_ACCESS_KEY` unset for the shared endpoint used by that
client. Setting it makes its subscription requests return HTTP 401; it does
not add authentication support to the client.

For a separate private deployment whose callers can securely supply the
`X-Subscription-Key` header, you can require a key:

```bash
npx wrangler secret put SUBSCRIPTION_ACCESS_KEY
```

Do not embed this key in the app source, packaged application, or subscription
URL. If a shared endpoint was accidentally protected, remove that secret with
`npx wrangler secret delete SUBSCRIPTION_ACCESS_KEY` only if the endpoint is
intended to be public. Keep the upstream subscription URL in its Worker secret.

For deployment troubleshooting, HTTP 401 means the required key is missing or
incorrect; HTTP 503 means `UPSTREAM_SUBSCRIPTION_URL` is not configured. HTTP 500
means the configured upstream URL is invalid (it must use HTTPS), and HTTP 502
means the upstream returned an unsuccessful HTTP status.

The included `wrangler.toml` attaches the Worker to
`vpnrelay.02studio.xyz`. The DNS zone must be in the same Cloudflare account.
If you choose another hostname, update both that route and the app source
definitions before building WLSAPlus.
