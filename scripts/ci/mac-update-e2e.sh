#!/bin/bash
# End-to-end test of the macOS self-updater on a GitHub macOS runner, with real apps, the real helper, real
# codesign and a loopback feed:
#   R1  1.1.0 -> 1.1.1         stable channel (/api/latest), "Restart" path, swap + launch marker
#   R2  1.1.1 -> 1.1.2 broken  the new app exits at start -> helper rolls back to 1.1.1 and reopens it
#   R3  1.1.1 -> 1.1.3-beta.1  beta channel (channel-beta manifest), installed silently on quit (verify-only)
# Needs: out/WLSAPlus-darwin-arm64/WLSAPlus.app (version 1.1.0, signed), imported identity, WLSAPLUS_UPDATE_ED25519_KEY.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BASE_APP="$ROOT/out/WLSAPlus-darwin-arm64/WLSAPlus.app"
WORK="${RUNNER_TEMP:-/tmp}/wlsaplus-e2e"
FEED="$WORK/feed"
LOGS="$ROOT/e2e-logs"
USERDATA="$HOME/Library/Application Support/WLSAPlus"
UPD="$USERDATA/updates"
TARGET=/Applications/WLSAPlus.app
PORT=18765
ASAR="$ROOT/node_modules/.bin/asar"
rm -rf "$WORK" "$LOGS"; mkdir -p "$FEED" "$LOGS"

step() { echo; echo "=== $* ==="; }
fail() { echo "::error::E2E: $*"; exit 1; }
plist_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist"; }
result_field() { node -e "try{const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(r[process.argv[2]]??'')}catch{console.log('')}" "$UPD/last-result.json" "$1"; }
app_running() { pgrep -f "$TARGET/Contents/MacOS/WLSAPlus" >/dev/null 2>&1; }
stop_apps() {
  pkill -f "$TARGET/Contents/MacOS/" 2>/dev/null || true
  for _ in $(seq 1 10); do app_running || return 0; sleep 1; done
  pkill -9 -f "$TARGET/Contents/MacOS/" 2>/dev/null || true; sleep 1
}
wait_until() { # seconds description command...
  local limit="$1" what="$2"; shift 2
  for _ in $(seq 1 "$limit"); do if "$@"; then return 0; fi; sleep 1; done
  fail "timed out after ${limit}s waiting for: $what"
}
dump_logs() {
  echo "---- update.log"; cat "$UPD/update.log" 2>/dev/null || true
  echo "---- last-result.json"; cat "$UPD/last-result.json" 2>/dev/null || true
  echo "---- feed"; tail -n 40 "$LOGS/feed.log" 2>/dev/null || true
  for f in "$LOGS"/app-*.log; do [ -f "$f" ] && { echo "---- $f"; tail -n 40 "$f"; }; done
  cp "$UPD/update.log" "$LOGS/" 2>/dev/null || true
}
trap 'rc=$?; [ $rc -ne 0 ] && dump_logs; stop_apps; kill ${FEED_PID:-0} 2>/dev/null || true; exit $rc' EXIT

make_variant() { # version [broken] -> $WORK/<version>/WLSAPlus-<version>-mac-arm64.zip
  local v="$1" broken="${2:-}" out="$WORK/$1"
  rm -rf "$out"; mkdir -p "$out"
  ditto "$BASE_APP" "$out/WLSAPlus.app"
  local res="$out/WLSAPlus.app/Contents/Resources" tmp="$out/asar-src"
  "$ASAR" extract "$res/app.asar" "$tmp"
  node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2))" "$tmp/package.json" "$v"
  if [ -n "$broken" ]; then
    { echo 'process.exit(7); // E2E: a release that cannot start'; cat "$tmp/electron/main.cjs"; } > "$tmp/main.tmp" && mv "$tmp/main.tmp" "$tmp/electron/main.cjs"
  fi
  rm -f "$res/app.asar"; "$ASAR" pack "$tmp" "$res/app.asar"; rm -rf "$tmp"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" -c "Set :CFBundleVersion $v" "$out/WLSAPlus.app/Contents/Info.plist"
  bash scripts/ci/sign-mac-app.sh "$out/WLSAPlus.app" "$v"
  (cd "$out" && ditto -c -k --keepParent WLSAPlus.app "WLSAPlus-$v-mac-arm64.zip")
}

publish() { # version stable|beta
  local v="$1" channel="$2" dir="$FEED/download/v$1" zip="WLSAPlus-$1-mac-arm64.zip"
  mkdir -p "$dir"
  cp "$WORK/$v/$zip" "$dir/"
  node scripts/make-update-manifest.mjs --version "$v" --tag "v$v" --channel "$channel" --out "$dir/update-manifest.json" --file "arm64=$dir/$zip"
  if [ "$channel" = stable ]; then
    mkdir -p "$FEED/api"
    printf '{"tag":"v%s","assets":[{"name":"update-manifest.json"},{"name":"%s"}]}\n' "$v" "$zip" > "$FEED/api/latest"
  else
    mkdir -p "$FEED/download/channel-beta"
    cp "$dir/update-manifest.json" "$FEED/download/channel-beta/update-manifest.json"
  fi
}

N=0
launch_with_feed() { # autoinstall(0|1) extra-args...
  local auto="$1"; shift
  N=$((N + 1))
  WLSAPLUS_UPDATE_BASE_URL="http://127.0.0.1:$PORT" WLSAPLUS_UPDATE_TEST_AUTOINSTALL="$auto" WLSAPLUS_UPDATE_HELPER_TIMEOUT=45 \
    "$TARGET/Contents/MacOS/WLSAPlus" "$@" >"$LOGS/app-$N.log" 2>&1 &
  APP_PID=$!
  echo "launched $(plist_version) pid $APP_PID $*"
}

step "prepare variants"
[ -d "$BASE_APP" ] || fail "missing $BASE_APP"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BASE_APP/Contents/Info.plist")" = 1.1.0 ] || fail "base app is not 1.1.0"
make_variant 1.1.1
make_variant 1.1.2 broken
make_variant 1.1.3-beta.1

step "install 1.1.0 into /Applications"
stop_apps
rm -rf "$TARGET" "$USERDATA"
[ -w /Applications ] || sudo chown "$(id -u)" /Applications
ditto "$BASE_APP" "$TARGET"
node scripts/ci/serve-feed.mjs "$FEED" "$PORT" >"$LOGS/feed.log" 2>&1 &
FEED_PID=$!
sleep 1

step "R1: 1.1.0 -> 1.1.1 (stable channel, restart)"
publish 1.1.1 stable
launch_with_feed 1
wait_until 240 "R1 result" test "$(result_field state)" = updated
[ "$(plist_version)" = 1.1.1 ] || fail "R1: installed version is $(plist_version)"
[ "$(result_field to)" = 1.1.1 ] && [ "$(result_field from)" = 1.1.0 ] || fail "R1: wrong result $(cat "$UPD/last-result.json")"
codesign --verify --deep --strict "$TARGET" || fail "R1: installed app fails codesign --verify"
codesign --verify -R="$(node -p "require('./electron/update-config.cjs').CODESIGN_REQUIREMENT")" "$TARGET" || fail "R1: designated requirement changed"
[ ! -e "$UPD/backup/WLSAPlus.app" ] || fail "R1: backup not removed"
app_running || fail "R1: 1.1.1 is not running after the update"
grep -q "updates/staging/1.1.1/launched.marker" "$UPD/update.log" || grep -q "marker after" "$UPD/update.log" || fail "R1: no launch marker in update.log"
echo "R1 OK: $(grep 'marker after' "$UPD/update.log" | tail -n 1)"
stop_apps

step "R2: 1.1.1 -> 1.1.2 (broken) must roll back"
publish 1.1.2 stable
launch_with_feed 1
wait_until 300 "R2 rollback" test "$(result_field state)" = rolled_back
[ "$(plist_version)" = 1.1.1 ] || fail "R2: version after rollback is $(plist_version)"
[ "$(result_field to)" = 1.1.2 ] || fail "R2: wrong result $(cat "$UPD/last-result.json")"
codesign --verify --deep --strict "$TARGET" || fail "R2: restored app fails codesign --verify"
wait_until 30 "1.1.1 reopened after rollback" app_running
# The reopened 1.1.1 records 1.1.2 as failed so it is not offered again.
wait_until 30 "failed version recorded" grep -q '"1.1.2"' "$UPD/settings.json"
echo "R2 OK: $(grep -i 'rolling back' "$UPD/update.log" | tail -n 1)"
stop_apps

step "R3: 1.1.1 -> 1.1.3-beta.1 (beta channel, installed on quit)"
publish 1.1.3-beta.1 beta
rm -f "$UPD/update-helper.sh"
launch_with_feed 0 --update-channel=beta
wait_until 240 "R3 update staged" test -d "$UPD/staging/1.1.3-beta.1/app/WLSAPlus.app" -a -f "$UPD/update-helper.sh"
sleep 3
[ "$(plist_version)" = 1.1.1 ] || fail "R3: installed before quitting"
grep -q "/download/v1.1.2/WLSAPlus-1.1.2" "$LOGS/feed.log" && [ "$(grep -c "/download/v1.1.2/WLSAPlus-1.1.2" "$LOGS/feed.log")" -gt 1 ] && fail "R3: the rolled-back 1.1.2 was downloaded again"
kill -TERM "$APP_PID"
wait_until 180 "R3 result" test "$(result_field state)" = updated
[ "$(plist_version)" = 1.1.3-beta.1 ] || fail "R3: installed version is $(plist_version)"
codesign --verify --deep --strict "$TARGET" || fail "R3: installed app fails codesign --verify"
grep -q "mode quit" "$UPD/update.log" || fail "R3: helper did not run in quit mode"
sleep 5
app_running && fail "R3: verify-only launch did not exit"
echo "R3 OK"

step "E2E PASSED"
dump_logs >/dev/null
