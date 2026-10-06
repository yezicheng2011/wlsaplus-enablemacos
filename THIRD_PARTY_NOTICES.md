# Third-party notices

WLSAPlus (this repository) is licensed under the **GNU General Public License v3.0**. See [`LICENSE`](LICENSE).

The distributed macOS app may also include the following components. Their licenses apply to those components; keep the corresponding license files when you redistribute binaries.

## Bundled VPN / network cores

| Component | Role | License | License file |
| --- | --- | --- | --- |
| [mihomo](https://github.com/MetaCubeX/mihomo) (Clash Meta) | Binary inside `electron/bin/mac-vpn.tar.gz` (`clash_pkg/clash`), the only VPN core of the macOS app; shipped as `Contents/Resources/bin/` | GPL-3.0 | `electron/bin/LICENSE-mihomo.txt` (also `build/vpn-core/LICENSE-mihomo.txt`) |

sing-box and v2ray-plugin are **not** shipped in the app. `scripts/download-vpn-core.mjs` only downloads them when `WLSAPLUS_FETCH_SING_BOX=1` is set (used by the optional `electron/vpn-config.test.cjs`); their licenses are kept in `build/vpn-core/LICENSE-sing-box.txt` (GPL-3.0) and `build/vpn-core/LICENSE-v2ray-plugin.txt` (MIT).

## Major npm / runtime dependencies

These are installed via npm and are **not** copied into this repository as source. Typical licenses (verify with your installed `node_modules` when redistributing):

| Package | Typical license |
| --- | --- |
| Angular (`@angular/*`) | MIT |
| Angular Material / CDK | MIT |
| Electron / Electron Forge | MIT (Electron also includes Chromium and Node under their own terms) |
| electron-updater | MIT |
| RxJS | Apache-2.0 |
| tesseract.js and `@tesseract.js-data/*` | Apache-2.0 (engine / traineddata may carry additional notices) |
| material-symbols / Roboto font packages | OFL / Apache as declared by those packages |

For a machine-readable inventory after `npm install`, you can run a license checker such as `npx license-checker --summary` (optional; not required to build).

## Cloudflare Workers (optional deploy)

Directories such as `powerschool-worker/` and `vpn-subscription-worker/` are separate deployable workers. Treat them as part of this repository under the same GPL-3.0 terms unless a file in that directory says otherwise. Do not commit upstream VPN subscription secrets into the client; keep them in Worker secrets.

## Attribution note

Product names (PowerSchool, WeChat, etc.) belong to their respective owners. Reachability probes (for example `https://weixin.qq.com/`) are network checks only and are not affiliated with or endorsed by those services.
