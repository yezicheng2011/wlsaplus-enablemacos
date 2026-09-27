# WLSAPlus (macOS)

WLSAPlus is a local-first PowerSchool schedule and task application built from an Angular Material 3 codebase, packaged for **macOS** with Electron.

## Development

```bash
npm install
npm start
```

Open `http://localhost:4200`. Direct PowerSchool sync is available in the Electron package; browsers cannot bypass the school's CORS policy.

The native app syncs on launch, when you press `Sync now`, and every 15 minutes while it is open. Each sync requests the current PowerSchool schedule pages, so the week and dates roll over automatically. If a sync is unavailable, the previous local snapshot remains usable.

```bash
npm test
npm run build:web
npm run electron:dev
npm run electron:make
```

`electron:make` produces macOS DMG and ZIP packages via Electron Forge (requires a macOS host).

## Releases

Open **Actions > Build and release > Run workflow**, enter a semantic version such as `1.2.0`, and run it. The workflow applies that version, creates tag `v1.2.0`, and publishes the macOS DMG/ZIP to a GitHub Release. Pushing a `v*` tag directly is also supported.

Normal branch pushes do not run the release workflow.

Optional macOS signing secrets:

- macOS signing: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_IDENTITY`
- macOS notarization: `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`

Without macOS signing secrets, macOS produces an unsigned package.

## PowerSchool network recorder

The recorder opens PowerSchool in a temporary Chromium profile and records network metadata plus text-based response bodies. Passwords, cookies, authorization headers, and common token fields are redacted. Captures can still contain private course and student data and must not be published.

### Setup

```bash
npm install
npx playwright install chromium
```

### Record

```bash
npm run record:powerschool -- --url "https://your-school-powerschool.example.com/" --duration 90
```

If `--url` is omitted, the recorder asks for it. The allowed duration is 15 to 600 seconds.

While recording:

1. Sign in manually in the opened browser window.
2. Open the current schedule.
3. Open one course, then return to the schedule.
4. Change the displayed week or term if available.
5. Wait for the browser to close automatically.

The result is stored under `captures/powerschool-<timestamp>/`. This directory is ignored by Git.
