#!/usr/bin/env bash
#
# oc-desktop.sh -- one-command launcher/stopper for the opencode DESKTOP dev build.
#
# Runs the FROM-SOURCE dev build (packages/desktop `bun dev`) -- never a prebuilt binary --
# with the two env vars it needs so it launches even offline:
#   ELECTRON_DISABLE_SANDBOX=1                        (chrome-sandbox isn't setuid on this box)
#   MODELS_DEV_API_JSON=<local models.dev snapshot>   (skips the models.dev network fetch)
#
# It also manages the local Ollama systemd service.
#
# Usage:  ./oc-desktop.sh {start|quit|quit-keep-ollama|help}

# --- paths / config ---
REPO_DIR="$HOME/opencode"
DESKTOP_DIR="$REPO_DIR/packages/desktop"
MODELS_FIXTURE="$REPO_DIR/packages/opencode/test/tool/fixtures/models-api.json"
RUN_DIR="/tmp/oc-desktop"
PID_FILE="$RUN_DIR/desktop.pid"
LOG_FILE="$RUN_DIR/desktop.log"

# make sure bun is findable even from a non-login shell
export PATH="$HOME/.bun/bin:$PATH"

log() { echo "[oc-desktop] $*"; }

usage() {
  cat <<'USAGE'
oc-desktop.sh -- start/stop the opencode desktop dev build (from source) + Ollama.

Usage:
  ./oc-desktop.sh start              Ensure Ollama is up, then launch the opencode
                                     desktop dev build in the background.
  ./oc-desktop.sh quit               Gracefully stop the desktop app AND stop Ollama.
                                     (Stopping Ollama runs `sudo systemctl stop ollama`,
                                      so you will be prompted for your password.)
  ./oc-desktop.sh quit-keep-ollama   Gracefully stop the desktop app only; leave Ollama up.
  ./oc-desktop.sh help               Show this help.

Notes:
  * Uses your source clone (bun dev). No prebuilt binary is ever installed or used.
  * Launches even offline (local model catalog + sandbox flag are set for you).
  * App logs go to /tmp/oc-desktop/desktop.log  (tail -f to watch).
  * Ollama is a shared system service -- `quit` stops it, which also affects anything
    else using it (e.g. Open WebUI). Use `quit-keep-ollama` to leave it running.
USAGE
}

desktop_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

ensure_ollama() {
  if systemctl is-active --quiet ollama; then
    log "Ollama already running."
  else
    log "Ollama not active -- starting (sudo systemctl start ollama)..."
    sudo systemctl start ollama && log "Ollama started." || log "Could not start Ollama."
  fi
}

start() {
  mkdir -p "$RUN_DIR"
  if desktop_running; then
    log "Desktop already running (PID $(cat "$PID_FILE")). Run 'quit' first."
    return 0
  fi
  ensure_ollama
  log "Launching opencode desktop dev build (from source)..."
  # setsid -> own session/process group so 'quit' can take down the whole tree
  setsid env ELECTRON_DISABLE_SANDBOX=1 OPENCODE_DISABLE_CHANNEL_DB=1 MODELS_DEV_API_JSON="$MODELS_FIXTURE" \
    bash -c 'cd "$1" && exec bun dev' oc-desktop "$DESKTOP_DIR" \
    >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  log "Started (PID $pid). A window should open shortly."
  log "Logs: $LOG_FILE"
}

stop_desktop() {
  local pid pgid i=0
  [ -f "$PID_FILE" ] && pid="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    log "Stopping desktop app gracefully (PID $pid)..."
    if [ -n "$pgid" ]; then kill -TERM "-$pgid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
    while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      log "Still alive -- forcing kill."
      if [ -n "$pgid" ]; then kill -KILL "-$pgid" 2>/dev/null; else kill -KILL "$pid" 2>/dev/null; fi
    fi
  else
    log "No tracked desktop process running."
  fi
  rm -f "$PID_FILE"
  # best-effort sweep, scoped to the opencode desktop path only (won't touch other Electron apps)
  pkill -TERM -f "$DESKTOP_DIR" 2>/dev/null && log "Swept stray desktop processes." || true
  log "Desktop app stopped."
}

stop_ollama() {
  if systemctl is-active --quiet ollama; then
    log "Stopping Ollama (sudo systemctl stop ollama)..."
    sudo systemctl stop ollama && log "Ollama stopped." || log "Could not stop Ollama."
  else
    log "Ollama already stopped."
  fi
}

case "${1:-help}" in
  start) start ;;
  quit) stop_desktop; stop_ollama ;;
  quit-keep-ollama) stop_desktop ;;
  help | -h | --help) usage ;;
  *)
    echo "Unknown command: ${1:-(none)}"
    echo
    usage
    exit 1
    ;;
esac
