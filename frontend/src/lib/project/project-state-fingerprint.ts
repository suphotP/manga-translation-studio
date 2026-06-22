import type { ProjectState } from "$lib/types.js";

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

// Per-tab/runtime-only fields that never participate in the save-conflict guard.
const EPHEMERAL_PROJECT_KEYS = new Set(["currentPage", "userId"]);

// Server-owned sub-collections that are mutated through dedicated endpoints
// (workflow/comments/ai-markers/review-decisions/workspace-feed/exports), NOT the
// general `POST /project/:id/save` path. The frontend hydrates these into
// `this.project` via separate `loadWorkflow()`/`loadComments()`/… calls after
// `openProject`, so the in-memory `ProjectState` carries copies that the conflict
// guard's `api.loadProject()` refetch (and the on-disk save state the backend
// fingerprints) do not reproduce byte-for-byte. Including them here produced a
// FALSE `ProjectSaveConflictError` on the very first save of a freshly-created
// chapter (the baseline-vs-refetch shapes differed even with one tab and no
// concurrent edit), which silently dropped the edit until a manual reload.
//
// Excluding them keeps the genuine stale-overwrite protection intact: real
// page/layer/text/metadata changes still live in the fingerprint, so a true
// remote edit between baseline and save still triggers the conflict. The
// dedicated endpoints already own concurrency for these collections, and the
// backend save handler falls back to its persisted copy when the body omits
// them — so they never needed the save-path conflict guard.
//
// MUST stay byte-identical to the backend `EPHEMERAL_PROJECT_FINGERPRINT_KEYS` +
// this exclusion set in `backend/src/routes/project.ts`, because the backend
// recomputes the same fingerprint to validate the `X-Project-Base-Fingerprint`
// header on save.
const REMOTE_OWNED_PROJECT_KEYS = new Set([
	"tasks",
	"activityLog",
	"comments",
	"aiReviewMarkers",
	"reviewDecisions",
	"reviewAssignments",
	"revisionRequests",
	"workspaceMessages",
	"versionReviewRequests",
	"exportRuns",
]);

function normalizeProjectState(value: unknown, parentKey = ""): JsonLike {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => normalizeProjectState(item));
	if (typeof value !== "object") return null;

	const normalized: Record<string, JsonLike> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		if (parentKey === "" && (EPHEMERAL_PROJECT_KEYS.has(key) || REMOTE_OWNED_PROJECT_KEYS.has(key))) continue;
		normalized[key] = normalizeProjectState((value as Record<string, unknown>)[key], key);
	}
	return normalized;
}

function hashString(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createProjectStateFingerprint(project: ProjectState): string {
	return hashString(JSON.stringify(normalizeProjectState(project)));
}
