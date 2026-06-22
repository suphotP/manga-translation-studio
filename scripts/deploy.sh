#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STACK_NAME="${STACK_NAME:-manga-prod}"
RELEASE_TAG="${RELEASE_TAG:-$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
BUILD_ROOT="${BUILD_ROOT:-deploy/builds}"
KEEP_BUILDS="${KEEP_BUILDS:-5}"
API_READY_URL="${API_READY_URL:-https://${API_HOST:-api.example.com}/readyz}"
WEB_READY_URL="${WEB_READY_URL:-https://${APP_HOST:-app.example.com}/healthz}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-180}"
LAST_SUCCESS_FILE="${LAST_SUCCESS_FILE:-deploy/.last-successful-release}"

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "missing required command: $1" >&2
		exit 1
	fi
}

compose() {
	RELEASE_TAG="$RELEASE_TAG" docker compose -f "$COMPOSE_FILE" "$@"
}

wait_url() {
	local url="$1"
	local label="$2"
	local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
	echo "waiting for ${label}: ${url}"
	while (( SECONDS < deadline )); do
		if curl -fsS --max-time 5 "$url" >/dev/null; then
			echo "${label} ready"
			return 0
		fi
		sleep 5
	done
	echo "${label} did not become ready within ${READY_TIMEOUT_SECONDS}s" >&2
	return 1
}

extract_frontend_build() {
	local image="manga-editor-web:${RELEASE_TAG}"
	local release_dir="${BUILD_ROOT}/${RELEASE_TAG}"
	local container_id

	mkdir -p "$release_dir"
	container_id="$(docker create "$image")"
	trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' RETURN

	if docker cp "${container_id}:/app/build/." "$release_dir" >/dev/null 2>&1; then
		echo "extracted frontend build to ${release_dir}"
	elif docker cp "${container_id}:/app/.svelte-kit/output/client/." "$release_dir" >/dev/null 2>&1; then
		echo "extracted SvelteKit client output to ${release_dir}"
	else
		echo "could not find frontend build assets in ${image}" >&2
		return 1
	fi

	ln -sfn "$RELEASE_TAG" "${BUILD_ROOT}/current"
}

prune_old_builds() {
	local build_count
	local remove_count
	mkdir -p "$BUILD_ROOT"
	build_count="$(find "$BUILD_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')"
	remove_count=$((build_count - KEEP_BUILDS))
	if (( remove_count <= 0 )); then
		return
	fi

	find "$BUILD_ROOT" -mindepth 1 -maxdepth 1 -type d -print \
		| sort \
		| sed -n "1,${remove_count}p" \
		| while IFS= read -r old_build; do
			rm -rf "$old_build"
		done
}

deploy_stack() {
	local swarm_state
	swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)"
	if [[ "$swarm_state" != "active" ]]; then
		if [[ "${COMPOSE_FALLBACK:-0}" == "1" ]]; then
			echo "Swarm is not active; using docker compose fallback without real rolling update_config semantics"
			compose up -d --remove-orphans --scale api=2 --scale web=2
			return
		fi
		echo "Docker Swarm is required for production rolling updates. Run 'docker swarm init' or set COMPOSE_FALLBACK=1 for a non-prod fallback." >&2
		exit 1
	fi

	RELEASE_TAG="$RELEASE_TAG" docker stack deploy -c "$COMPOSE_FILE" "$STACK_NAME" --detach=false
}

rollback() {
	local previous=""
	if [[ -f "$LAST_SUCCESS_FILE" ]]; then
		previous="$(<"$LAST_SUCCESS_FILE")"
	fi

	if [[ -z "$previous" ]]; then
		echo "readiness failed and no previous successful release is recorded" >&2
		return 1
	fi

	echo "rolling back to ${previous}"
	RELEASE_TAG="$previous"
	ln -sfn "$previous" "${BUILD_ROOT}/current"
	deploy_stack
}

main() {
	require_cmd docker
	require_cmd curl
	mkdir -p "$BUILD_ROOT" "$(dirname "$LAST_SUCCESS_FILE")"

	echo "release: ${RELEASE_TAG}"
	echo "validating compose config"
	# `compose config` interpolates the full prod environment (POSTGRES_PASSWORD,
	# JWT_SECRET, ASSET_SIGNING_SECRET, R2 creds, ...). Validate without leaving
	# rendered secrets on disk by quietly discarding the output.
	compose config --quiet

	echo "building app images"
	compose build api web migrate

	extract_frontend_build
	prune_old_builds

	echo "deploying stack"
	if ! deploy_stack; then
		rollback
		exit 1
	fi

	if ! wait_url "$API_READY_URL" "api" || ! wait_url "$WEB_READY_URL" "web"; then
		rollback
		exit 1
	fi

	printf '%s' "$RELEASE_TAG" >"$LAST_SUCCESS_FILE"
	echo "deploy complete: ${RELEASE_TAG}"
}

main "$@"
