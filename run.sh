#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_ACTIVATE="$BACKEND_DIR/.venv/bin/activate"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

pick_free_port() {
  local start_port="$1"
  python3 - "$start_port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
for candidate in range(port, port + 200):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if sock.connect_ex(("127.0.0.1", candidate)) != 0:
            print(candidate)
            raise SystemExit(0)

raise SystemExit(1)
PY
}

kill_stale_listener() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "Found stale listener(s) on :$port -> $pids; terminating..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Force-killing stubborn listener(s) on :$port ..."
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

if [[ ! -f "$VENV_ACTIVATE" ]]; then
  echo "Backend virtualenv not found at $VENV_ACTIVATE"
  echo "Create it first:"
  echo "  cd \"$ROOT_DIR\" && python3 -m venv backend/.venv && source backend/.venv/bin/activate && pip install -r backend/requirements.txt"
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "Frontend dependencies not installed."
  echo "Run:"
  echo "  cd \"$FRONTEND_DIR\" && npm install"
  exit 1
fi

cleanup() {
  echo ""
  echo "Stopping services..."
  [[ -n "${BACKEND_PID:-}" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

BACKEND_PORT="$(pick_free_port 8000)"
FRONTEND_PORT="$(pick_free_port 5173)"
API_BASE="http://127.0.0.1:${BACKEND_PORT}"

# If previous runs crashed and left listeners around, clear them before boot.
kill_stale_listener "$BACKEND_PORT"
kill_stale_listener "$FRONTEND_PORT"

echo "Starting backend on ${API_BASE} ..."
(
  cd "$ROOT_DIR"
  source "$VENV_ACTIVATE"
  exec uvicorn app.main:app --reload --port "$BACKEND_PORT" --app-dir backend
) &
BACKEND_PID=$!

sleep 1
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "Backend failed to start. Check logs above."
  exit 1
fi

echo "Starting frontend on http://127.0.0.1:${FRONTEND_PORT} ..."
(
  cd "$FRONTEND_DIR"
  exec env VITE_API_BASE="$API_BASE" npm run dev -- --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

echo "Dashboard stack running. Press Ctrl+C to stop."
echo "Frontend: http://127.0.0.1:${FRONTEND_PORT}"
echo "Backend:  ${API_BASE}"
wait
