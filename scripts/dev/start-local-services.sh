#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/.codex-dev-logs/runtime"
mkdir -p "$LOG_DIR"

port_open() {
	local port="$1"
	python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.25)
    sys.exit(0 if sock.connect_ex(("127.0.0.1", port)) == 0 else 1)
PY
}

ensure_worker_deps() {
	python3 - <<'PY'
import importlib
import importlib.util
import sys

missing = [name for name in ("fastapi", "uvicorn", "pydantic", "curl_cffi") if importlib.util.find_spec(name) is None]
if missing:
    print("Missing worker Python deps: " + ", ".join(missing), file=sys.stderr)
    print("Install with: python3 -m pip install -r backend/worker/requirements.txt", file=sys.stderr)
    sys.exit(1)
PY
}

start_worker() {
	if port_open 8001; then
		echo "worker already listening on 127.0.0.1:8001"
		return
	fi
	ensure_worker_deps
	(
		cd "$ROOT_DIR/backend"
		python3 -m uvicorn worker.server:app --host 127.0.0.1 --port 8001
	) >"$LOG_DIR/worker.log" 2>&1 &
	echo "$!" >"$LOG_DIR/worker.pid"
	echo "started worker pid $(cat "$LOG_DIR/worker.pid")"
}

start_backend() {
	if port_open 3001; then
		echo "backend already listening on 127.0.0.1:3001"
		return
	fi
	(
		cd "$ROOT_DIR/backend"
		RATE_LIMIT_STORE=memory \
		READINESS_DATABASE_DISABLED=true \
		READINESS_REQUIRE_MIGRATIONS=false \
		WORKER_URL=http://127.0.0.1:8001 \
		JWT_SECRET=local-dev-secret-change-me-32-chars \
		ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173" \
		bun run src/index.ts
	) >"$LOG_DIR/backend.log" 2>&1 &
	echo "$!" >"$LOG_DIR/backend.pid"
	echo "started backend pid $(cat "$LOG_DIR/backend.pid")"
}

wait_for_url() {
	local label="$1"
	local url="$2"
	local attempts="${3:-30}"
	for _ in $(seq 1 "$attempts"); do
		if curl -fsS "$url" >/dev/null 2>&1; then
			echo "$label ready"
			return 0
		fi
		sleep 1
	done
	echo "$label did not become ready: $url" >&2
	return 1
}

cd "$ROOT_DIR"
start_worker
wait_for_url "worker" "http://127.0.0.1:8001/health" 20
start_backend
wait_for_url "backend" "http://127.0.0.1:3001/api/readyz" 20

echo "local services ready"
echo "frontend should proxy cleanly at http://127.0.0.1:5173/api/readyz when frontend dev server is running"
