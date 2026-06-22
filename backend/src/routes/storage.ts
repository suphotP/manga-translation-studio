// Workspace storage-management surface ("Asset Library").
//
// A separate, workspace-scoped read/delete surface for STORAGE HOUSEKEEPING —
// distinct from the per-project upload/browse routes in `images.ts` and from the
// copy-on-write version store in `assets.ts`. It answers the owner question
// "which images eat space, in which project, and let me drill in and delete the
// ones I don't need":
//
//   - GET    /api/storage/workspaces/:workspaceId/assets
//       List EVERY asset across the workspace's projects with per-asset bytes +
//       owning project + kind (uploaded vs ai-generated), plus per-project totals
//       and the workspace grand total. Sorted biggest-first by default so the
//       space hogs surface immediately. Optional `?projectId=` drill-in filter and
//       `?kind=uploaded|ai-generated` filter.
//
//   - DELETE  /api/storage/projects/:projectId/assets/:imageId
//       Delete one asset from durable storage + the asset registry, freeing the
//       space. REFERENCE-SAFE: if the asset is still referenced by a live page
//       (page image, image layer, edit, or AI review marker) the delete is refused
//       with 409 + the referencing pages UNLESS `?force=true` is passed, so the
//       caller can show a clear "still used on page N" warning before confirming.
//
// Authorization reuses the workspace access store (membership + role) and the
// project catalog (workspace -> projects, project -> workspace), exactly like the
// workspace-home route, so nothing here bypasses workspace scoping.

import { Hono } from "hono";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore,
} from "../services/workspace-access.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { objectStorage } from "../services/storage.js";
import {
	getAssetRecordAuthoritative,
	listAssetRecordsAuthoritative,
	removeAssetRecordAuthoritativeDetailed,
	restoreAssetRecordAuthoritative,
	getAssetWriteContextAuthoritative,
} from "../services/assets.js";
import { uploadAuditStore } from "../services/upload-audit.js";
import { getSharedStorageCowService, type CapturedCowVersion } from "../services/storage-cow.js";
import { summarizeProjectStorageQuotaForProjectView } from "../services/storage-quota.js";
import { clearProjectCoverImageIfMatches, collectVersionSnapshotEditAssetIds } from "./project.js";
import { isValidProjectId, isValidImageId } from "../utils/security.js";
import type { AssetRecord, PageState, ProjectState } from "../types/index.js";

const storage = new Hono();
storage.use("*", authMiddleware);

// Cap the workspace fan-out so a pathological workspace can't make this scan
// every project on disk. The dashboard lists the same bounded set.
const WORKSPACE_PROJECT_SCAN_CAP = 500;

type AssetKind = "uploaded" | "ai-generated";

function requireUser(c: any): JWTPayload {
	return getAuthUser(c) as JWTPayload;
}

function workspaceErrorResponse(c: any, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

/** AI-output assets are the only non-uploaded kind today (source === "ai_job"). */
function assetKind(asset: Pick<AssetRecord, "uploadedBy">): AssetKind {
	return asset.uploadedBy?.source === "ai_job" ? "ai-generated" : "uploaded";
}

/** Positive finite bytes only, rounded — matches the storage-quota accounting. */
function safeBytes(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function derivativeBytes(asset: AssetRecord): number {
	let total = 0;
	for (const derivative of asset.derivatives) total += safeBytes(derivative.sizeBytes);
	return total;
}

/**
 * Whether a single per-language output bucket references this image id via one of
 * its IMAGE LAYERS. A per-language track can carry its OWN `imageLayers[]` array
 * (the export pipeline's `resolveExportImageLayers` uses `languageOutputs[track]
 * .imageLayers` as an OVERRIDE over the flat `page.imageLayers` when present), and
 * each layer can name a live asset via `layer.imageId` OR its `layer.restoreImageId`
 * source — the exact same shapes the flat `page.imageLayers` reference check uses.
 * An asset referenced ONLY inside a track's `imageLayers` is still LIVE for that
 * language's export, so it must count as referenced or a delete would corrupt the
 * track. Defensive: the bucket and its `imageLayers` are read off an untyped record
 * (the backend `PageLanguageOutput` type does not declare these richer per-track
 * fields), mirroring export-pipeline's `readImageLayers`.
 */
function outputImageLayersReferenceImage(output: Record<string, unknown>, imageId: string): boolean {
	const layers = output.imageLayers;
	if (!Array.isArray(layers)) return false;
	for (const layer of layers) {
		if (!layer || typeof layer !== "object") continue;
		const l = layer as Record<string, unknown>;
		if (l.imageId === imageId || l.restoreImageId === imageId) return true;
	}
	return false;
}

/**
 * Whether ANY per-language output bucket on a page renders FROM this image id.
 * A `languageOutputs[lang]` bucket can point at a live translated/typeset render
 * via `typesetImageId`, `exportImageId`, `renderedImageId`, `imageId`, or
 * `edits.imageId` — the exact same shapes the export pipeline resolves in
 * `languageRenderImageId` (export-pipeline.ts) — OR carry its own per-track
 * `imageLayers[]` (the export pipeline's per-language image-layer override). Deleting
 * an image still named by any of these would orphan that language's render/track, so
 * it counts as referenced. Null/undefined-safe: `languageOutputs` may be absent or empty.
 */
function languageOutputsReferenceImage(page: PageState, imageId: string): boolean {
	const outputs = (page as { languageOutputs?: Record<string, unknown> }).languageOutputs;
	if (!outputs || typeof outputs !== "object") return false;
	for (const output of Object.values(outputs)) {
		if (!output || typeof output !== "object") continue;
		const o = output as Record<string, unknown>;
		if (
			o.typesetImageId === imageId ||
			o.exportImageId === imageId ||
			o.renderedImageId === imageId ||
			o.imageId === imageId
		) {
			return true;
		}
		const edits = o.edits;
		if (edits && typeof edits === "object" && (edits as Record<string, unknown>).imageId === imageId) {
			return true;
		}
		// Per-language image-layer override (`languageOutputs[lang].imageLayers[]`).
		if (outputImageLayersReferenceImage(o, imageId)) {
			return true;
		}
	}
	return false;
}

/**
 * P1-b DATA-SAFETY — whether any non-destructive edit layer on a page references
 * this image id as one of its assets. A `fill-mask` edit layer composites a tiny
 * `image-edit-mask` ROI asset (`payload.maskAssetId`) over the original page at
 * reload/export; future phases may also carry a realized/baked patch asset
 * (`realizedPatchAssetId` / `patchAssetId`). Deleting any of these while the layer
 * is still present would orphan the clean (the export composites nothing → the
 * clean silently disappears), so each counts as a live reference. Null-safe.
 */
function editLayersReferenceImage(page: PageState, imageId: string): boolean {
	const layers = (page as { imageEditLayers?: unknown }).imageEditLayers;
	if (!Array.isArray(layers)) return false;
	for (const layer of layers) {
		if (!layer || typeof layer !== "object") continue;
		const l = layer as { sourceImageId?: unknown; payload?: unknown };
		if (l.sourceImageId === imageId) return true;
		const payload = l.payload;
		if (payload && typeof payload === "object") {
			const p = payload as Record<string, unknown>;
			if (p.maskAssetId === imageId || p.realizedPatchAssetId === imageId || p.patchAssetId === imageId) {
				return true;
			}
		}
	}
	return false;
}

/**
 * The pages (1-based numbers) that still reference this image — directly as the
 * page image / edited image, via an image layer (or its restore source), via a
 * per-language render output (`page.languageOutputs[*]`), via a non-destructive
 * edit-layer asset (`imageEditLayers[].payload.maskAssetId`), or via an AI review
 * marker result. An empty array means the asset is unreferenced and safe to
 * delete. Mirrors `resolveProjectImagePageIndex` in images.ts (plus the export
 * pipeline's per-language render resolution) but returns EVERY referencing page
 * so the UI can warn precisely.
 */
export function referencingPageNumbers(state: Pick<ProjectState, "pages" | "aiReviewMarkers">, imageId: string): number[] {
	const pages = new Set<number>();
	for (const [pageIndex, page] of (state.pages ?? []).entries()) {
		if (page.imageId === imageId || page.edits?.imageId === imageId) {
			pages.add(pageIndex + 1);
			continue;
		}
		if (page.imageLayers?.some((layer) => layer.imageId === imageId || layer.restoreImageId === imageId)) {
			pages.add(pageIndex + 1);
			continue;
		}
		// Per-language render references (translated/typeset/exported outputs).
		if (languageOutputsReferenceImage(page, imageId)) {
			pages.add(pageIndex + 1);
			continue;
		}
		// Non-destructive edit-layer mask / patch asset references (P1-b).
		if (editLayersReferenceImage(page, imageId)) {
			pages.add(pageIndex + 1);
		}
	}
	for (const marker of state.aiReviewMarkers ?? []) {
		if (marker.resultImageId === imageId) pages.add(marker.pageIndex + 1);
	}
	return [...pages].sort((a, b) => a - b);
}

function serializeStorageAsset(asset: AssetRecord, projectId: string, projectName: string) {
	return {
		assetId: asset.assetId,
		imageId: asset.imageId,
		projectId,
		projectName,
		originalName: asset.originalName,
		mimeType: asset.mimeType,
		sizeBytes: safeBytes(asset.sizeBytes),
		derivativeBytes: derivativeBytes(asset),
		width: asset.width,
		height: asset.height,
		kind: assetKind(asset),
		storageStatus: asset.storageStatus,
		moderationStatus: asset.moderation.status,
		createdAt: asset.createdAt,
		updatedAt: asset.updatedAt,
	};
}

// ── List workspace assets ────────────────────────────────────────────────────
storage.get("/workspaces/:workspaceId/assets", async (c) => {
	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}
	const catalog = projectCatalogStore;
	if (!catalog) {
		return c.json({ error: "Project catalog store is not configured", code: "workspace_project_store_unavailable" }, 503);
	}
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");

	const projectFilter = c.req.query("projectId")?.trim() || undefined;
	if (projectFilter && !isValidProjectId(projectFilter)) {
		return c.json({ error: "Invalid projectId", code: "invalid_project_id" }, 400);
	}
	const kindFilter = c.req.query("kind")?.trim();
	if (kindFilter && kindFilter !== "uploaded" && kindFilter !== "ai-generated") {
		return c.json({ error: "Invalid kind", code: "invalid_kind" }, 400);
	}
	const sort = c.req.query("sort")?.trim() || "size";
	if (sort !== "size" && sort !== "recent" && sort !== "name") {
		return c.json({ error: "Invalid sort", code: "invalid_sort" }, 400);
	}

	try {
		// Membership gate first — every workspace role has read_workspace, so a
		// non-member never triggers a single project/asset read.
		await workspaceAccessStore.requirePermission(workspaceId, user.userId, "read_workspace");

		// Workspace -> project ids (bounded). When a drill-in filter is supplied we
		// still verify that project belongs to this workspace before reading it.
		// SECURITY (F2): list ONLY the projects this member's fine-grained scope allows.
		// requirePermission(read_workspace) above is role-only and NEVER consults member
		// scope, and listProjectIdsForWorkspace is explicitly UNSCOPED — so a member scoped
		// to a single project/story could otherwise enumerate the WHOLE workspace's asset
		// inventory here. Reuse the same per-member scope filter (projectIds/chapterIds/
		// languages, enforced in the catalog SQL) the Library listing uses, capped at the
		// same project-scan budget. A scoped drill-in (projectFilter) below is therefore
		// also denied when the project is outside the member's scope.
		const scopedPage = await catalog.listProjectSummaryPage({
			userId: user.userId,
			workspaceId,
			limit: WORKSPACE_PROJECT_SCAN_CAP,
		});
		let projectIds = scopedPage.projects.map((summary) => summary.projectId);
		if (projectFilter) {
			if (!projectIds.includes(projectFilter)) {
				return c.json({ error: "Project not found in workspace", code: "project_not_in_workspace" }, 404);
			}
			projectIds = [projectFilter];
		}

		// Read each project's name (for labels) + authoritative asset list. A project
		// that fails to load is skipped rather than failing the whole library.
		//
		// Names come from ONE batched title lookup instead of deserializing every project's
		// full (multi-MB) current_state JSON — across a workspace with up to 500 projects the
		// old per-project getProjectState was O(projects × multi-MB) just to read a label.
		const projectTitles = await catalog.getProjectTitlesByIds(projectIds);
		const perProject = await Promise.all(projectIds.map(async (projectId) => {
			try {
				const records = await listAssetRecordsAuthoritative(projectId);
				return { projectId, name: projectTitles.get(projectId) ?? projectId, records };
			} catch (error) {
				console.warn(`[storage] failed to read assets for project ${projectId}: ${error}`);
				return null;
			}
		}));

		const assets: ReturnType<typeof serializeStorageAsset>[] = [];
		const projectTotals = new Map<string, { projectId: string; projectName: string; assetCount: number; originalBytes: number; derivativeBytes: number }>();
		let workspaceOriginalBytes = 0;
		let workspaceDerivativeBytes = 0;
		let workspaceAssetCount = 0;

		for (const entry of perProject) {
			if (!entry) continue;
			let projectOriginal = 0;
			let projectDerivative = 0;
			let projectCount = 0;
			for (const record of entry.records) {
				const kind = assetKind(record);
				if (kindFilter && kind !== kindFilter) continue;
				const serialized = serializeStorageAsset(record, entry.projectId, entry.name);
				assets.push(serialized);
				projectOriginal += serialized.sizeBytes;
				projectDerivative += serialized.derivativeBytes;
				projectCount += 1;
			}
			// Per-project totals reflect the (optionally kind-filtered) set so the totals
			// always agree with the visible rows.
			if (projectCount > 0 || !projectFilter) {
				projectTotals.set(entry.projectId, {
					projectId: entry.projectId,
					projectName: entry.name,
					assetCount: projectCount,
					originalBytes: projectOriginal,
					derivativeBytes: projectDerivative,
				});
			}
			workspaceOriginalBytes += projectOriginal;
			workspaceDerivativeBytes += projectDerivative;
			workspaceAssetCount += projectCount;
		}

		// Default sort = biggest space first ("รูปอะไรกินพื้นที่เยอะ"). Ties broken by
		// newest then id so the order is stable.
		assets.sort((a, b) => {
			if (sort === "recent") return b.createdAt.localeCompare(a.createdAt) || b.assetId.localeCompare(a.assetId);
			if (sort === "name") return a.originalName.localeCompare(b.originalName) || b.sizeBytes - a.sizeBytes;
			return (b.sizeBytes + b.derivativeBytes) - (a.sizeBytes + a.derivativeBytes)
				|| b.createdAt.localeCompare(a.createdAt)
				|| b.assetId.localeCompare(a.assetId);
		});

		const projects = [...projectTotals.values()]
			.sort((a, b) => (b.originalBytes + b.derivativeBytes) - (a.originalBytes + a.derivativeBytes) || a.projectName.localeCompare(b.projectName));

		return c.json({
			workspaceId,
			sort,
			kind: kindFilter ?? null,
			projectId: projectFilter ?? null,
			assets,
			projects,
			totals: {
				assetCount: workspaceAssetCount,
				originalBytes: workspaceOriginalBytes,
				derivativeBytes: workspaceDerivativeBytes,
				totalBytes: workspaceOriginalBytes + workspaceDerivativeBytes,
				projectCount: projects.length,
			},
		});
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

// ── Delete one asset (reference-safe) ─────────────────────────────────────────
storage.delete("/projects/:projectId/assets/:imageId", async (c) => {
	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}
	const catalog = projectCatalogStore;
	if (!catalog) {
		return c.json({ error: "Project catalog store is not configured", code: "workspace_project_store_unavailable" }, 503);
	}
	const user = requireUser(c);
	const projectId = c.req.param("projectId");
	const imageId = c.req.param("imageId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid projectId", code: "invalid_project_id" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid imageId", code: "invalid_image_id" }, 400);
	}
	const force = c.req.query("force") === "true";

	const state = await catalog.getProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	}

	// Authorize: deleting an asset mutates the project, so require update_project on
	// the owning workspace (also covers personal/workspaceless projects below).
	// MEMBERSHIP baseline only here — the per-resource (project/page/asset) scope is
	// enforced below, AFTER we resolve the asset's referenced pages, because a
	// fine-grained member (e.g. page-scoped) must not be able to delete an asset
	// that lives on / is referenced by pages outside their assignment.
	const workspaceId = state.workspaceId?.trim();
	try {
		if (workspaceId) {
			await workspaceAccessStore.requirePermission(workspaceId, user.userId, "update_project");
		} else if (state.userId && state.userId !== user.userId) {
			// A personal project owned by someone else: only an authorized catalog
			// access path may touch it.
			const allowed = await catalog.canAccessProject({ projectId, userId: user.userId, permission: "update:project" });
			if (!allowed) return c.json({ error: "Project not found", code: "project_not_found" }, 404);
		}
		// else: caller's own personal project — allowed.
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}

	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) {
		return c.json({ error: "Asset not found", code: "asset_not_found" }, 404);
	}

	// Reference-safety: refuse to delete an asset still used by a live page — OR
	// still set as the project's EXPLICIT cover image (#2) — unless the caller
	// explicitly forces it (after seeing the warning). The cover lives at the
	// project level (`state.coverImageId`), not on a page, so it is a separate live
	// reference the page scan does not cover; deleting it would leave the Library
	// cover pointing at a dead asset.
	const referencedBy = referencingPageNumbers(state, imageId);
	const isProjectCover = state.coverImageId === imageId;
	// P1-2 DATA-SAFETY — an edit-layer asset (mask/patch/clone-source) reverted or deleted
	// out of LIVE state can still be referenced by a durable VERSION SNAPSHOT; restoring
	// that snapshot would point `imageEditLayers` at a now-deleted asset. Protect such
	// assets by HARD-BLOCKING deletion below (409 regardless of force). Only consulted when the asset
	// is not already a live reference (no extra version-store reads on the common path).
	const referencedByVersionSnapshot =
		referencedBy.length === 0 && !isProjectCover
			? (await collectVersionSnapshotEditAssetIds(projectId)).has(imageId)
			: false;
	// HARD-BLOCK a snapshot-referenced edit asset REGARDLESS of `force` — a snapshot is a
	// restore point and its assets must not be force-deletable. The only way to release it
	// is to drop the snapshot that pins it (the CoW deleteVersion flow).
	if (referencedByVersionSnapshot) {
		return c.json({
			error: "Asset is referenced by a saved version snapshot and cannot be deleted (delete the version snapshot first)",
			code: "asset_referenced_by_version_snapshot",
			referencedByPages: referencedBy,
			referencedByVersionSnapshot: true,
			isProjectCover,
			// No `requiresForce`: force=true does NOT override a snapshot reference.
		}, 409);
	}
	// Live-page / cover references: warn-then-force (recoverable — the user can re-upload or
	// re-set a cover; the snapshot reference above is a non-overridable restore point).
	if ((referencedBy.length > 0 || isProjectCover) && !force) {
		return c.json({
			error: isProjectCover && referencedBy.length === 0
				? "Asset is still set as the project cover"
				: "Asset is still referenced by live pages",
			code: "asset_referenced",
			referencedByPages: referencedBy,
			referencedByVersionSnapshot: false,
			isProjectCover,
			requiresForce: true,
		}, 409);
	}

	// Per-resource scope enforcement (workspace projects only — personal projects
	// were fully authorized above by owner/catalog match). A fine-grained member
	// who has workspace `update_project` but is restricted to specific
	// pages/languages/task-types must only be able to delete assets WITHIN their
	// scope. `canAccessProject` re-resolves the caller's membership + scope and
	// evaluates it as `resourceKind: "asset"`; an unscoped owner/editor passes every
	// check unchanged (their scope lists are empty → "covers everything").
	//   - Referenced asset (force delete): the asset touches live pages, so EVERY
	//     referencing page must be inside the caller's scope — otherwise forcing the
	//     delete would mutate pages they were never assigned. `referencedBy` is
	//     1-based page numbers; `pageIndex` is 0-based.
	//   - Unreferenced asset: no page anchor, so require asset-scope on the project
	//     itself (page-agnostic). A member scoped to specific PAGES (but not the
	//     whole project) cannot reach a page-less asset check and is correctly denied.
	if (workspaceId) {
		const scopeChecks: Array<{ resourceKind: "asset"; pageIndex?: number }> =
			referencedBy.length > 0
				? referencedBy.map((pageNumber) => ({ resourceKind: "asset", pageIndex: pageNumber - 1 }))
				: [{ resourceKind: "asset" }];
		for (const scopeCheck of scopeChecks) {
			const inScope = await catalog.canAccessProject({
				projectId,
				userId: user.userId,
				permission: "update:project",
				...scopeCheck,
			});
			if (!inScope) {
				return c.json({ error: "Forbidden: asset is outside your assigned scope", code: "asset_scope_denied" }, 403);
			}
		}
	}

	// Cover-safety (#2): if this asset is the project's EXPLICIT cover, clear the
	// cover metadata BEFORE removing the asset so the Library never renders a cover
	// pointing at a now-deleted image. `clearProjectCoverImageIfMatches` is a no-op
	// when the cover does not (still) match, so it is safe to call unconditionally on
	// any force-delete; it persists through the same dual-store path that honors
	// file-state precedence. The asset removal below proceeds regardless — a cleared
	// cover degrades to the first-page fallback, never to a dangling reference.
	if (isProjectCover) {
		try {
			await clearProjectCoverImageIfMatches(projectId, imageId);
		} catch (error) {
			// A cover-clear failure must NOT abort the delete (the user explicitly
			// forced it), but we must not silently strand a dead cover either: surface
			// it so the operator can re-set the cover. The asset is still intact here.
			console.error(`[storage] failed to clear project cover before force-delete (${projectId}/${imageId}): ${error}`);
			return c.json({ error: "Failed to clear project cover before delete", code: "cover_clear_failed" }, 500);
		}
	}

	// Capture the durable persistence context BEFORE deleting so a failed object
	// delete can re-insert the row with its original workspace_id/metadata intact.
	const writeContext = await getAssetWriteContextAuthoritative(projectId, imageId);
	const freedBytes = safeBytes(asset.sizeBytes) + derivativeBytes(asset);

	const isContentBlob = Boolean(asset.storageKey?.startsWith("content/") && asset.sha256);

	// For content-blob assets we must reclaim the CoW ref-count/quota for this
	// asset's versions, but the ordering matters in BOTH directions:
	//   - Release BEFORE the asset_records delete and the delete fails → the row
	//     survives with its blob ref_count/quota already released, and the
	//     orphan-blob GC can evict a blob that live reads still resolve (404s).
	//   - Release AFTER removeAssetRecordAuthoritative cascades asset_versions away
	//     → the join in deleteAssetCowStorage finds nothing, ref_count stays
	//     inflated and quota is never given back (a leak).
	// So we split it: CAPTURE the version accounting now (a pure read), let the
	// authoritative record delete be the single-winner gate, then RELEASE only if
	// THIS request won the delete. A release failure then degrades to a
	// GC-recoverable ref_count leak (best-effort, below); a record-delete failure
	// releases nothing, leaving registry + accounting consistent.
	const cowReclaimEnabled = isContentBlob && Boolean(projectCatalogStore) && Boolean(process.env.DATABASE_URL?.trim());
	let capturedCowVersions: CapturedCowVersion[] = [];
	if (cowReclaimEnabled) {
		try {
			capturedCowVersions = await getSharedStorageCowService().captureAssetCowVersions(projectId, imageId);
		} catch (error) {
			// Capture failed → we won't be able to release precisely; the orphan-blob
			// GC still reclaims the bytes once ref_count would have reached zero.
			console.error(`[storage] CoW capture failed for content-blob asset ${projectId}/${imageId} (bytes left for orphan-blob GC): ${error}`);
		}
	}

	// Registry first: an object must never be deleted while a durable row still
	// points at it (the data-integrity invariant the upload-cleanup path enforces).
	// We need the DURABLE single-winner result (not the OR with the best-effort JSON
	// mirror): in Postgres mode two concurrent deletes can both remove a stale local
	// mirror entry, but only one wins the durable row delete — and only that winner
	// may release the CoW accounting, or the loser double-releases the blob's
	// ref_count/quota.
	const { removed: recordRemoved, durableRemoved } = await removeAssetRecordAuthoritativeDetailed(projectId, imageId);
	if (!recordRemoved) {
		return c.json({ error: "Asset not found", code: "asset_not_found" }, 404);
	}

	// This request won the DURABLE record delete → release the captured CoW
	// accounting exactly once. Best-effort + CoW-safe (a blob another account still
	// references keeps a positive ref_count): a failure here leaves bytes for a
	// later orphan-blob GC sweep and must not fail the delete.
	if (cowReclaimEnabled && durableRemoved && capturedCowVersions.length > 0) {
		try {
			await getSharedStorageCowService().releaseCapturedAssetCowStorage(capturedCowVersions);
		} catch (error) {
			console.error(`[storage] CoW reclaim failed for content-blob asset ${projectId}/${imageId} (bytes left for orphan-blob GC): ${error}`);
		}
	}

	// Delete the underlying object. CoW content blobs are content-addressed and may
	// be shared/deduped, so we only delete the legacy per-project image object here;
	// a content-blob asset's bytes are reclaimed by the CoW store (ref-count
	// decrement below + the orphan-blob GC cron). The per-project image delete is
	// the path that actually frees space for normal uploads (the QA + common case).
	let objectDeleted = false;
	if (!isContentBlob) {
		try {
			objectDeleted = await objectStorage.deleteProjectImage({ projectId, imageId });
			await uploadAuditStore.deleteProjectImageEvent(projectId, imageId).catch(() => undefined);
		} catch (error) {
			// Object delete failed AFTER the row was removed — restore the row so the
			// object is never left orphaned (with its original workspace/metadata).
			try {
				await restoreAssetRecordAuthoritative(projectId, asset, writeContext ?? {});
			} catch (restoreError) {
				console.error(`[storage] failed to restore asset record after object delete failure (${projectId}/${imageId}): ${restoreError}`);
			}
			console.error(`[storage] failed to delete asset object ${projectId}/${imageId}: ${error}`);
			return c.json({ error: "Failed to delete asset object", code: "asset_object_delete_failed" }, 502);
		}
	} else {
		// Content-blob asset: best-effort audit cleanup. The CoW ref-count/quota was
		// already reclaimed ABOVE (before the asset_records delete, so the join to
		// asset_versions still resolves); the orphan-blob GC frees the bytes once
		// nothing references the SHA.
		await uploadAuditStore.deleteProjectImageEvent(projectId, imageId).catch(() => undefined);
	}

	// Free the asset's derivative objects (thumbnail / editor_preview / moderation
	// tiles). These live at projects/<id>/derivatives/<derivativeId> and are NOT
	// touched by deleteProjectImage — without this they leak in object storage
	// (and their bytes stay counted toward the project's derivative usage) forever.
	// Best-effort: the asset record is already removed, so a per-derivative failure
	// must not fail the delete.
	for (const derivative of asset.derivatives ?? []) {
		try {
			await objectStorage.deleteProjectDerivative({ projectId, derivativeId: derivative.id });
		} catch (error) {
			console.warn(`[storage] failed to delete derivative ${projectId}/${derivative.id}: ${error}`);
		}
	}

	// Echo the refreshed project storage quota so a caller (e.g. the in-editor
	// asset library) can update its space-used total from this single round-trip
	// rather than issuing a follow-up usage fetch. Best-effort: a quota summary
	// failure must not turn a successful delete into an error.
	let storageQuota: Awaited<ReturnType<typeof summarizeProjectStorageQuotaForProjectView>> | undefined;
	try {
		storageQuota = await summarizeProjectStorageQuotaForProjectView(projectId);
	} catch (error) {
		console.warn(`[storage] post-delete quota summary failed (${projectId}): ${error}`);
	}

	return c.json({
		ok: true,
		projectId,
		imageId,
		freedBytes,
		objectDeleted,
		wasReferenced: referencedBy.length > 0 || isProjectCover,
		referencedByPages: referencedBy,
		// Cover was cleared back to the first-page fallback before this delete.
		wasProjectCover: isProjectCover,
		storageQuota,
	});
});

export { storage };
