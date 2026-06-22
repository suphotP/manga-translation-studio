#!/usr/bin/env bash
# Start (or restart) the self-hosted GitHub Actions runner for this repo.
# Mints a short-lived registration token via the gh CLI (no token is stored in
# git) and brings up the runner container. The runner stays registered across
# restarts; re-running this is safe (it refreshes the token + recreates the
# container). Requires: gh (authenticated), docker.
set -euo pipefail
cd "$(dirname "$0")"

REPO="suphotP/manga-editor-web"

command -v gh >/dev/null     || { echo "gh CLI not found"; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }

echo "→ Minting a runner registration token via gh (repo: ${REPO})…"
RUNNER_TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
export RUNNER_TOKEN
[ -n "${RUNNER_TOKEN}" ] || { echo "Failed to mint registration token (check gh auth + repo admin perms)"; exit 1; }

echo "→ Starting the self-hosted runner container…"
docker compose up -d --pull always
sleep 4
docker compose ps
echo
echo "✓ Runner starting. Verify at: https://github.com/${REPO}/settings/actions/runners"
echo "  Logs:  docker logs -f manga-ci-runner"
echo "  Stop:  docker compose down        (or ./stop-runner.sh)"
