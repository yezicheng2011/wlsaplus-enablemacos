# macOS self-update (from 1.1.0)

WLSAPlus is signed with a fixed self-signed certificate (no Apple Developer ID, not notarized), so Squirrel.Mac /
electron-updater cannot be used. The app updates itself instead:

1. **Check** (8 s after start, then every 6 h, or Settings → Updates → Check now):
   `https://wlsaplus.spacehubxyz.hk/api/latest` → `/download/<tag>/update-manifest.json`.
   With **Settings → Updates → Test builds (测试版更新)** on (default for prerelease builds, or `--update-channel=beta`)
   it also reads `/download/channel-beta/update-manifest.json`. Mirrors (gh-proxy) are only a fallback.
2. **Verify the manifest**: Ed25519 signature (public key in `electron/update-config.cjs`, private key only in the
   GitHub secret `WLSAPLUS_UPDATE_ED25519_KEY`). Never a lower/equal version; stable channel never takes prereleases;
   versions that had to be rolled back are skipped.
3. **Download** the zip for this chip (`-mac-arm64.zip` / `-mac-x64.zip`, ~half of the universal size) with resume
   (HTTP Range) and check size + sha256 from the signed manifest.
4. **Unpack + verify** (`ditto -x -k`): `codesign --verify --deep --strict`, designated requirement pinned to our
   certificate, bundle id, version, architecture. Banner: "Update ready — Restart".
5. **Install**: on Restart (or silently after Quit) the app disconnects the VPN, copies `electron/update-helper.sh`
   to `~/Library/Application Support/WLSAPlus/updates/` and starts it detached. The helper waits for the app to exit,
   renames `WLSAPlus.app` → `updates/backup/`, moves the new app in (one admin prompt if the folder is not writable),
   launches it and waits for it to write `launched.marker`. No marker within 90 s → kill, restore the old app,
   reopen it, remember the failed version. Log: `updates/update.log`.

## Releasing
- `git tag v1.1.1-beta.1 && git push origin v1.1.1-beta.1` → `release.yml` builds, signs and publishes a
  **prerelease** and points `channel-beta` at it. Normal users (stable channel, `/api/latest`) are not affected.
- `git tag v1.1.1` → a **draft** release; publish it by hand after testing. Note for the site: `/download/latest`
  picks assets by `ASSET_PREFER` on the server.
- `mac-update-e2e.yml` runs the full update / rollback / beta + install-on-quit cycle on a macOS runner.

## Keys
Box backup: `/home/box/secrets/wlsaplus-update/` (chmod 600). Secrets: `WLSAPLUS_UPDATE_ED25519_KEY`,
`WLSAPLUS_CODESIGN_P12_BASE64`, `WLSAPLUS_CODESIGN_P12_PASSWORD`. Losing the Ed25519 key means installed apps can no
longer update themselves (one manual reinstall); changing the certificate means one Keychain prompt per user.
