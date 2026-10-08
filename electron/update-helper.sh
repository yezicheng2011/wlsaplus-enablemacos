#!/bin/bash
# WLSAPlus macOS update helper. main.cjs copies this file out of app.asar into <userData>/updates/ and starts it
# detached right before the app quits. It
#   1. waits for the old app (--pid) to exit,
#   2. swaps the bundles with two renames:  TARGET -> BACKUP,  STAGED -> TARGET
#      (through one administrator prompt when TARGET's folder is not writable: --admin 1),
#   3. launches the new app with --wlsaplus-update-marker=<MARKER> and waits for it to write the marker
#      (the new app does that once its window has loaded, or right after start-up in --mode quit),
#   4. on success deletes the backup; on failure kills the new app, puts the old bundle back and (in restart mode)
#      reopens it,
#   5. writes the outcome to --result as JSON; the app shows it on its next start.
# Internal mode used through osascript:  update-helper.sh --swap|--restore TARGET STAGED_OR_FAILED BACKUP
set -u
# System tools only (WLSAPLUS_UPDATE_HELPER_PATH lets the unit tests substitute stubs for open/osascript).
PATH="${WLSAPLUS_UPDATE_HELPER_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

swap_bundles() { # TARGET STAGED BACKUP
  local target="$1" staged="$2" backup="$3"
  [ -d "$staged" ] || { echo "staged app missing: $staged"; return 2; }
  [ -d "$target" ] || { echo "installed app missing: $target"; return 3; }
  rm -rf "$backup" || return 4
  mkdir -p "$(dirname "$backup")" || return 4
  mv "$target" "$backup" || { echo "could not move the installed app aside"; return 5; }
  if ! mv "$staged" "$target"; then
    echo "could not move the new app into place; restoring"
    mv "$backup" "$target"
    return 6
  fi
  xattr -cr "$target" 2>/dev/null || true
  return 0
}

restore_bundles() { # TARGET FAILED_DEST BACKUP
  local target="$1" failed="$2" backup="$3"
  [ -d "$backup" ] || { echo "backup missing: $backup"; return 7; }
  rm -rf "$failed"
  mkdir -p "$(dirname "$failed")"
  if [ -e "$target" ]; then mv "$target" "$failed" || rm -rf "$target" || return 8; fi
  mv "$backup" "$target" || return 9
  return 0
}

case "${1:-}" in
  --swap) shift; swap_bundles "$@"; exit $? ;;
  --restore) shift; restore_bundles "$@"; exit $? ;;
esac

PID="" TARGET="" STAGED="" BACKUP="" MARKER="" RESULT="" VERSION="" FROM="" MODE="restart" ADMIN=0 TIMEOUT=90 WAIT=120 LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) PID="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --staged) STAGED="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --marker) MARKER="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --wait) WAIT="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    *) echo "unknown argument: $1"; shift ;;
  esac
done
[ -n "$LOG" ] && exec >>"$LOG" 2>&1
SELF="$0"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }
write_result() { # state message
  local json
  json="$(printf '{"state":"%s","from":"%s","to":"%s","message":"%s","at":"%s"}' \
    "$1" "$(json_escape "$FROM")" "$(json_escape "$VERSION")" "$(json_escape "$2")" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
  log "result $json"
  [ -n "$RESULT" ] || return 0
  mkdir -p "$(dirname "$RESULT")" 2>/dev/null
  printf '%s\n' "$json" >"$RESULT.tmp" && mv "$RESULT.tmp" "$RESULT"
}
run_privileged() { # --swap|--restore A B C
  if [ "$ADMIN" = "1" ]; then
    osascript -e 'on run argv' \
      -e 'set cmd to "/bin/bash " & quoted form of (item 1 of argv) & " " & (item 2 of argv) & " " & quoted form of (item 3 of argv) & " " & quoted form of (item 4 of argv) & " " & quoted form of (item 5 of argv)' \
      -e 'do shell script cmd with administrator privileges' \
      -e 'end run' "$SELF" "$1" "$2" "$3" "$4"
  else
    /bin/bash "$SELF" "$@"
  fi
}
launch_app() { # extra open(1) flags...
  if [ "$MODE" = "quit" ]; then
    open -g -j "$TARGET" --args "--wlsaplus-update-marker=$MARKER" --wlsaplus-update-verify-only "$@"
  else
    open "$TARGET" --args "--wlsaplus-update-marker=$MARKER" "$@"
  fi
}
kill_target() {
  pkill -f "$TARGET/Contents/MacOS/" 2>/dev/null || true
  for _ in 1 2 3 4 5; do pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1 || return 0; sleep 1; done
  pkill -9 -f "$TARGET/Contents/MacOS/" 2>/dev/null || true
}

log "update $FROM -> $VERSION (mode $MODE, admin $ADMIN) target=$TARGET"
for v in TARGET STAGED BACKUP MARKER RESULT VERSION; do
  [ -n "${!v}" ] || { log "missing --$(echo "$v" | tr 'A-Z' 'a-z')"; write_result failed "Updater was started without $v."; exit 2; }
done

# 1. wait for the old app to quit
if [ -n "$PID" ]; then
  waited=0
  while kill -0 "$PID" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if [ "$waited" -ge "$WAIT" ]; then
      log "old app (pid $PID) did not quit; aborting"
      write_result failed "WLSAPlus did not quit, so the update was not installed."
      exit 3
    fi
  done
fi
sleep 1

# 2. swap
rm -f "$MARKER"
if ! run_privileged --swap "$TARGET" "$STAGED" "$BACKUP"; then
  log "swap failed"
  write_result failed "The new version could not be moved into place (permission denied or cancelled)."
  [ "$MODE" = "restart" ] && [ -d "$TARGET" ] && open "$TARGET" --args --wlsaplus-update-failed
  exit 4
fi
log "swapped; launching new app"

# 3. launch the new app and wait for its marker
launch_app
waited=0
while [ ! -s "$MARKER" ] && [ "$waited" -lt "$TIMEOUT" ]; do sleep 1; waited=$((waited + 1)); done

if [ -s "$MARKER" ]; then
  log "new app started (marker after ${waited}s): $(head -c 100 "$MARKER")"
  rm -rf "$BACKUP" 2>/dev/null || log "could not delete the backup at $BACKUP (the app removes it later)"
  write_result updated "Updated to $VERSION."
  exit 0
fi

# 4. roll back
log "new app did not start within ${TIMEOUT}s; rolling back"
kill_target
FAILED_DEST="$(dirname "$BACKUP")/failed-$VERSION.app"
if run_privileged --restore "$TARGET" "$FAILED_DEST" "$BACKUP"; then
  rm -rf "$FAILED_DEST" 2>/dev/null || true
  write_result rolled_back "WLSAPlus $VERSION did not start, so the previous version was restored."
  [ "$MODE" = "restart" ] && open "$TARGET" --args --wlsaplus-update-failed
  exit 5
fi
log "ROLLBACK FAILED; backup kept at $BACKUP"
write_result failed "The update failed and the previous version could not be restored automatically. A copy is kept at $BACKUP"
exit 6
