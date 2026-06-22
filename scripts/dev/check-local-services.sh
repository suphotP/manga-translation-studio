#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:5173}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3001}"
WORKER_URL="${WORKER_URL:-http://127.0.0.1:8001}"

check_json() {
	local label="$1"
	local url="$2"
	local body
	if ! body="$(curl -fsS "$url" 2>/dev/null)"; then
		echo "FAIL $label $url"
		return 1
	fi
	echo "OK   $label $url"
	printf '%s\n' "$body" | head -c 500
	printf '\n'
}

cd "$ROOT_DIR"
check_json "worker" "$WORKER_URL/health"
check_json "backend" "$BACKEND_URL/api/readyz"
check_json "frontend-proxy" "$FRONTEND_URL/api/readyz"
check_json "recent-projects" "$FRONTEND_URL/api/project"
capabilities="$(curl -fsS "$FRONTEND_URL/api/ai/capabilities" 2>/dev/null || true)"
if [[ -z "$capabilities" ]]; then
	echo "FAIL ai-capabilities $FRONTEND_URL/api/ai/capabilities"
	exit 1
fi
CAPABILITIES_JSON="$capabilities" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ["CAPABILITIES_JSON"])
sfx = next((tier for tier in data.get("tiers", []) if tier.get("id") == "sfx-pro"), None)
if not sfx:
    print("FAIL ai-capabilities missing sfx-pro")
    sys.exit(1)
if sfx.get("available") is True:
    print(f"OK   ai-capabilities sfx-pro ready via {sfx.get('provider')}")
else:
    print(f"WARN ai-capabilities sfx-pro unavailable reason={sfx.get('reason')} detail={sfx.get('detail')}")
PY
