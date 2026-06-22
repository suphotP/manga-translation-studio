#!/usr/bin/env bash
# Stop + de-register the self-hosted runner container.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
echo "✓ Runner stopped. (It de-registers from GitHub on graceful shutdown.)"
