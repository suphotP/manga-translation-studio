import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { serverConfig } from "../config.js";
import { optionalAuth, getAuthUser } from "../middleware/auth.middleware.js";
import { getAssetRecordAuthoritative } from "../services/assets.js";
import { buildModerationImageDataUrl, createLocalModerationPass, imageModerationEnabled, moderateMultimodal } from "../services/moderation.js";
import { objectStorage } from "../services/storage.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { clampCrop, isValidImageId, isValidProjectId } from "../utils/security.js";
import { resolveProjectState } from "../utils/project-state-file.js";
import type { JWTPayload } from "../types/auth.js";
import type { ProjectState } from "../types/index.js";

const crops = new Hono();
crops.use("*", optionalAuth);

const cropGeometrySchema = z.object({
	x: z.number().finite().min(0),
	y: z.number().finite().min(0),
	w: z.number().finite().min(1),
	h: z.number().finite().min(1),
});

const cropCheckSchema = z.object({
	projectId: z.string().min(1),
	imageId: z.string().min(1).optional(),
	text: z.string().max(5000).optional(),
	// Optional crop geometry (image pixels). When supplied, moderation runs on the
	// selected region's pixels rather than the whole page, so unrelated flagged
	// content elsewhere on a long page does not warn/block a benign crop, and a small
	// unsafe crop is not diluted by a full-page moderation derivative.
	crop: cropGeometrySchema.optional(),
	// NOTE: no client-supplied `imageUrl`. The moderation target is always the
	// project-owned asset resolved server-side, so a caller with read access to one
	// project cannot proxy arbitrary external URLs through the OpenAI moderation
	// endpoint (SSRF / unaccounted moderation proxy / quota exhaustion).
});

crops.post("/:id/check", async (c) => {
	const cropId = c.req.param("id");
	const raw = await c.req.json().catch(() => ({}));
	const parsed = cropCheckSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const projectId = parsed.data.projectId;
	const imageId = parsed.data.imageId ?? cropId;
	if (!isValidProjectId(projectId)) return c.json({ error: "Invalid project ID format" }, 400);
	if (!isValidImageId(imageId)) return c.json({ error: "Invalid image ID format" }, 400);

	const accessError = await checkProjectAccess(c, projectId, imageId);
	if (accessError) return accessError;

	// Servability guard (parity with the image-serve path in images.ts): a blocked
	// or quarantined asset's bytes must NEVER be read — not even to feed the
	// moderation/crop-preview endpoint. Project-read access alone is NOT sufficient;
	// without this a caller could pull the bytes of a hard-blocked (CSAM/extreme)
	// asset back out through the crop-check route.
	const servableError = await assertAssetServable(c, projectId, imageId);
	if (servableError) return servableError;

	const workspaceId = (await readWorkspaceId(projectId)) ?? projectId;

	// Honor the operator image-moderation kill switch. With it off, skip the image
	// portion (still moderating any text) so a disabled gate does not fail-close
	// every crop preview.
	const includeImage = imageModerationEnabled();
	const hasText = Boolean(parsed.data.text?.trim());

	// Image-only crop while the image gate is OFF: `moderateMultimodal` would get
	// an empty input and fail-close to "Empty moderation input" (block). The kill
	// switch must instead yield a local pass so disabling the gate does not block
	// every image-only crop preview.
	if (!includeImage && !hasText) {
		const result = createLocalModerationPass("Image moderation disabled; crop preview local pass");
		return c.json({ cropId, projectId, imageId, moderation: result });
	}

	const imageUrl = includeImage ? await resolveModerationImageUrl(projectId, imageId, parsed.data.crop) : undefined;
	if (includeImage && !imageUrl) {
		return c.json({ error: "Crop image not found", code: "crop_image_not_found" }, 404);
	}

	const result = await moderateMultimodal({
		text: parsed.data.text,
		imageUrl,
	}, workspaceId);

	return c.json({ cropId, projectId, imageId, moderation: result });
});

// Exported for unit testing the CoW/content-addressed read fallback (a crop on a
// deduped `content/<sha>` asset must read the content blob, not the per-project key).
export async function resolveModerationImageUrl(
	projectId: string,
	imageId: string,
	crop?: { x: number; y: number; w: number; h: number },
): Promise<string | undefined> {
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	const publicBase = serverConfig.r2.publicBaseUrl.replace(/\/+$/, "");
	// The R2 public-URL fast path can only reference the whole asset. When a crop
	// region is requested we must read the source bytes and extract the region
	// server-side instead, so moderation sees only the selected pixels.
	if (!crop && asset && publicBase) {
		return `${publicBase}/${asset.storageKey.split("/").map(encodeURIComponent).join("/")}`;
	}

	// CoW/content-addressed read parity with the image-serving path: when the asset
	// record points at a `content/<sha>` blob (copy-on-write dedup), getProjectImage
	// (which reads the per-project key) returns nothing, so crop moderation would
	// 404 for every CoW asset. Mirror the image route: read the content blob by sha
	// when the asset is CoW-backed, else fall back to the per-project image object.
	const isCowContent = Boolean(asset?.storageKey?.startsWith("content/") && asset.sha256);
	const buffer = isCowContent
		? await objectStorage.getContentBlob({ sha256: asset!.sha256 })
		: await objectStorage.getProjectImage({ projectId, imageId });
	if (!buffer) return undefined;
	const mimeType = asset?.mimeType ?? "image/png";

	if (crop) {
		try {
			const sharp = (await import("sharp")).default;
			const metadata = await sharp(buffer, { failOn: "none" }).metadata();
			const safeCrop = clampCrop(crop, metadata.width ?? 1, metadata.height ?? 1);
			const cropped = await sharp(buffer, { failOn: "none" })
				.extract({ left: safeCrop.x, top: safeCrop.y, width: safeCrop.w, height: safeCrop.h })
				.png()
				.toBuffer();
			// Bound the inline data URL so a large crop does not exceed the provider's
			// multimodal request size and fail-close the check.
			return buildModerationImageDataUrl(cropped, "image/png");
		} catch (error) {
			// On extraction failure fall back to moderating the full page rather than
			// silently skipping the image signal (fail-closed for the image portion).
			console.warn(`[crops] crop extraction failed; moderating full page: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Bound the inline data URL so a long webtoon page / near-limit upload does not
	// exceed the provider's multimodal request size and fail-close every crop check.
	return buildModerationImageDataUrl(buffer, mimeType);
}

// Shared servability rule (parity with the image-serve route in images.ts):
// servable ONLY when the asset is released AND its moderation status is passed or
// needs_review. A hard block (or any not-yet-released status) is withheld. Reads
// the durable store so a missing JSON mirror after a restart cannot leak a blocked
// asset. A truly absent record is treated as servable=true (the downstream read
// then 404s), matching the image route. Exported for unit testing the guard.
export async function isCropAssetServable(projectId: string, imageId: string): Promise<boolean> {
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) return true;
	const servableModeration = asset.moderation.status === "passed" || asset.moderation.status === "needs_review";
	return asset.storageStatus === "released" && servableModeration;
}

// Withhold a blocked / quarantined asset's bytes from the crop-check path. Without
// this a caller with project-read access could pull the bytes of a hard-blocked
// (CSAM/extreme) asset back out through the crop-check route.
async function assertAssetServable(c: Context, projectId: string, imageId: string): Promise<Response | null> {
	if (await isCropAssetServable(projectId, imageId)) return null;
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	return c.json({
		error: "Asset is not available",
		code: "asset_not_released",
		storageStatus: asset?.storageStatus,
		moderationStatus: asset?.moderation.status,
	}, 403);
}

async function checkProjectAccess(c: any, projectId: string, imageId: string): Promise<Response | null> {
	// Catalog-authoritative, tombstone-aware read: under Postgres the catalog row
	// wins; a permanently-deleted project must not re-enable crop moderation even if
	// a stale state.json survived a partial delete.
	const state = await resolveProjectState(projectId);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) {
		if (state.userId || state.workspaceId?.trim()) return c.json({ error: "Unauthorized" }, 401);
		if (serverConfig.apiAuthRequired || !serverConfig.allowLegacyAnonymousProjects) return c.json({ error: "Unauthorized" }, 401);
		return null;
	}
	if (state.workspaceId?.trim()) {
		if (projectCatalogStore && await projectCatalogStore.canAccessProject({
			projectId,
			userId: user.userId,
			permission: "read:project",
			pageIndex: resolveProjectImagePageIndex(state, imageId),
			resourceKind: "asset",
			assetPurpose: "editor_preview",
		})) {
			return null;
		}
		return c.json({ error: "Project not found" }, 404);
	}
	if (state.userId && state.userId !== user.userId) return c.json({ error: "Project not found" }, 404);
	return null;
}

function resolveProjectImagePageIndex(state: Pick<ProjectState, "pages">, imageId: string): number | undefined {
	for (const [pageIndex, page] of (state.pages ?? []).entries()) {
		if (page.imageId === imageId || page.edits?.imageId === imageId) return pageIndex;
		if (page.imageLayers?.some((layer) => layer.imageId === imageId || layer.restoreImageId === imageId)) return pageIndex;
	}
	return undefined;
}

async function readWorkspaceId(projectId: string): Promise<string | undefined> {
	const state = await resolveProjectState(projectId);
	return state?.workspaceId?.trim() || undefined;
}

export { crops };
