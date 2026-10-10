# Third-party notices

WLSAPlus (this repository) is licensed under the **GNU General Public License v3.0**. See [`LICENSE`](LICENSE).

The distributed macOS app may also include the following components. Their licenses apply to those components; keep the corresponding license files when you redistribute binaries.

## Bundled VPN / network cores

| Component | Role | License | License file |
| --- | --- | --- | --- |
| [mihomo](https://github.com/MetaCubeX/mihomo) (Clash Meta) | Binary inside `electron/bin/mac-vpn.tar.gz` (`clash_pkg/clash`), the only VPN core of the macOS app; shipped as `Contents/Resources/bin/` | GPL-3.0 | `electron/bin/LICENSE-mihomo.txt` |

## Major npm / runtime dependencies

These are installed via npm. The Material Symbols font is also checked in as a subset under `build/fonts/`; its font axes and the icons used by the app are preserved. The original Apache-2.0 license is retained in `build/fonts/LICENSE-material-symbols.txt` and included in the renderer's `licenses/` directory. Typical licenses (verify with your installed `node_modules` when redistributing):

| Package | Typical license |
| --- | --- |
| Angular (`@angular/*`) | MIT |
| Angular Material / CDK | MIT |
| Electron / Electron Forge | MIT (Electron also includes Chromium and Node under their own terms) |
| RxJS | Apache-2.0 |
| material-symbols (including the bundled subset) | Apache-2.0 |
| Roboto font package | OFL-1.1 |

For a machine-readable inventory after `npm install`, you can run a license checker such as `npx license-checker --summary` (optional; not required to build).

## vpn-subscription-worker (optional deploy)

`vpn-subscription-worker/` is a separately deployable worker. Treat it as part of this repository under the same GPL-3.0 terms unless a file in that directory says otherwise. Do not commit upstream VPN subscription secrets into the client; keep them in Worker secrets.

## Attribution note

Product names (PowerSchool, WeChat, etc.) belong to their respective owners. Reachability probes (for example `https://weixin.qq.com/`) are network checks only and are not affiliated with or endorsed by those services.
