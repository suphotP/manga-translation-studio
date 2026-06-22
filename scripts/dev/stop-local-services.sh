#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/.codex-dev-logs/runtime"

stop_pid_file() {
	local label="$1"
	local file="$2"
	if [[ ! -f "$file" ]]; then
		echo "$label pid file not found"
		return
	fi
	local pid
	pid="$(cat "$file")"
	if [[ -z "$pid" ]]; then
		rm -f "$file"
		echo "$label pid file empty"
		return
	fi
	if kill -0 "$pid" >/dev/null 2>&1; then
		kill "$pid"
		echo "stopped $label pid $pid"
	else
		echo "$label pid $pid is not running"
	fi
	rm -f "$file"
}

stop_pid_file "backend" "$LOG_DIR/backend.pid"
stop_pid_file "worker" "$LOG_DIR/worker.pid"
