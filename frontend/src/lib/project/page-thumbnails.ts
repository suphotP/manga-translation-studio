import type { Page } from "$lib/types.js";

const UPLOADED_IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$/i;
const AI_RESULT_IMAGE_ID_RE = /^result_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export function isLikelyServedProjectImageId(imageId: string | undefined): boolean {
	if (!imageId) return false;
	return UPLOADED_IMAGE_ID_RE.test(imageId) || AI_RESULT_IMAGE_ID_RE.test(imageId);
}

export function getPagePreviewImageId(
	page: Page | undefined,
	localImageUrls: Record<string, string> = {},
): string | null {
	const imageId = page?.edits?.imageId || page?.imageId;
	if (imageId && localImageUrls[imageId]) return imageId;
	return isLikelyServedProjectImageId(imageId) ? imageId : null;
}
