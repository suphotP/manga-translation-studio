// Security utilities — path traversal prevention, input sanitization

import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";

/**
 * Prevent path traversal attacks.
 * Ensures the resolved path stays within the allowed base directory.
 * @throws Error if path escapes the base directory
 */
export function safePath(base: string, ...segments: string[]): string {
	const normalizedBase = resolve(base);
	const normalizedSegments = segments.map((segment) => segment.replace(/\\/g, "/"));
	const resolved = resolve(normalizedBase, ...normalizedSegments);
	const pathFromBase = relative(normalizedBase, resolved);

	if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) {
		throw new Error(`Path traversal detected: ${segments.join("/")} escapes ${base}`);
	}
	return resolved;
}

/**
 * Validate UUID format to prevent injection via path segments.
 * Accepts both standard UUID v4 and our custom IDs (e.g., "result_xxx.png").
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/i;
const RESULT_ID_RE = /^result_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;
const LEGACY_IMAGE_NAME_RE = /^(?!\.)(?!.*\.\.)[a-z0-9][a-z0-9._ -]{0,240}\.(png|jpg|jpeg|webp)$/i;

export function isValidProjectId(id: string): boolean {
	return UUID_RE.test(id);
}

/**
 * Name of the directory (under PROJECTS_DIR) that holds permanent-deletion
 * tombstones: PROJECTS_DIR/.tombstones/<projectId>. A tombstone is the durable
 * "this project id was deleted" record so a partially-failed delete (e.g. a stale
 * state.json that survived an rmSync failure or a stale replica) can NOT resurrect
 * the project. The leading dot + the fact ids are UUIDs means isValidProjectId
 * rejects it, so it is never mistaken for a project dir by any disk/catalog scan.
 */
export const PROJECT_TOMBSTONES_DIR_NAME = ".tombstones";

/** True when a permanent-deletion tombstone exists for `projectId` under `projectsDir`. */
export function isProjectTombstonedIn(projectsDir: string, projectId: string): boolean {
	if (!isValidProjectId(projectId)) return false;
	try {
		return existsSync(safePath(projectsDir, PROJECT_TOMBSTONES_DIR_NAME, projectId));
	} catch {
		return false;
	}
}

export function isValidImageId(id: string): boolean {
	return IMAGE_ID_RE.test(id) || RESULT_ID_RE.test(id) || LEGACY_IMAGE_NAME_RE.test(id);
}

/**
 * Sanitize filename — remove any path separators or special chars.
 */
export function sanitizeFilename(name: string): string {
	return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 255);
}

/**
 * Clamp crop coordinates to valid image dimensions.
 *
 * The origin (x/y) is clamped FIRST into `[0, max-1]`, then width/height are
 * derived against the *clamped* origin. This guarantees the result always
 * satisfies `x + w <= maxW` and `y + h <= maxH` with `w, h >= 1` (whenever
 * `maxW`/`maxH >= 1`), so a downstream `sharp.extract()` can never throw
 * "bad extract area" for an out-of-bounds origin (e.g. `x >= maxW`).
 *
 * Degenerate dimensions (`maxW`/`maxH <= 0`) collapse the corresponding axis to
 * a zero-origin, zero-size region rather than producing a negative extent.
 */
export function clampCrop(
	crop: { x: number; y: number; w: number; h: number },
	maxW: number,
	maxH: number,
): { x: number; y: number; w: number; h: number } {
	const boundW = Math.floor(maxW);
	const boundH = Math.floor(maxH);
	// Clamp the origin into [0, bound - 1]. When bound <= 0 the axis is empty, so
	// pin the origin to 0 and the size to 0 (no valid pixels to extract).
	const x = boundW > 0 ? Math.min(Math.max(0, Math.floor(crop.x)), boundW - 1) : 0;
	const y = boundH > 0 ? Math.min(Math.max(0, Math.floor(crop.y)), boundH - 1) : 0;
	const maxAvailW = Math.max(0, boundW - x);
	const maxAvailH = Math.max(0, boundH - y);
	return {
		x,
		y,
		// At least 1px when the axis has room, but never beyond the clamped origin's
		// remaining extent (so x + w <= maxW always holds).
		w: maxAvailW > 0 ? Math.max(1, Math.min(Math.max(0, Math.floor(crop.w)), maxAvailW)) : 0,
		h: maxAvailH > 0 ? Math.max(1, Math.min(Math.max(0, Math.floor(crop.h)), maxAvailH)) : 0,
	};
}
