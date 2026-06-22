import type { Page } from "$lib/types.js";

export type PageAssetIntegrityStatus = "ready" | "missing" | "failed" | "scanning" | "blocked" | "unknown";

export interface PageAssetRecordLike {
	assetId?: string;
	imageId?: string;
	originalName?: string;
	storageStatus?: string;
	moderationStatus?: string;
}

export interface PageAssetLoadIssue {
	pageIndex: number;
	imageId: string;
	imageName: string;
	originalName?: string;
	message: string;
	kind?: "page" | "image-layer";
	layerId?: string;
	layerName?: string;
}

export interface PageAssetIntegrity {
	pageIndex: number;
	status: PageAssetIntegrityStatus;
	label: string;
	detail: string;
	imageId?: string;
	imageName?: string;
	originalName?: string;
	issueKind?: "page" | "image-layer";
	layerId?: string;
	layerName?: string;
	storageStatus?: string;
	moderationStatus?: string;
}

export function getPageAssetIntegrity(
	page: Page | undefined,
	pageIndex: number,
	loadIssue: PageAssetLoadIssue | null = null,
	assetRecord: PageAssetRecordLike | null = null,
	assetInventoryKnown = false,
	assetInventoryError: string | null = null,
): PageAssetIntegrity {
	if (!page) {
		return {
			pageIndex,
			status: "missing",
			label: "Missing",
			detail: "ไม่มีข้อมูลหน้านี้ใน Project",
		};
	}

	const imageName = page.originalName || page.imageName || page.imageId;
	if (loadIssue?.pageIndex === pageIndex) {
		const issueKind = loadIssue.kind ?? "page";
		const layerName = loadIssue.layerName || loadIssue.originalName || loadIssue.imageName || loadIssue.imageId;
		return {
			pageIndex,
			status: "failed",
			label: "Failed",
			detail: issueKind === "image-layer"
				? `รูปเสริม ${layerName} โหลดไม่ได้: ${loadIssue.message || "โหลดรูปเสริมไม่สำเร็จ"}`
				: loadIssue.message || "โหลดรูปหน้านี้ไม่สำเร็จ",
			imageId: loadIssue.imageId || page.imageId,
			imageName: loadIssue.imageName || page.imageName,
			originalName: loadIssue.originalName || page.originalName,
			issueKind,
			layerId: loadIssue.layerId,
			layerName: loadIssue.layerName,
		};
	}

	if (!page.imageId) {
		return {
			pageIndex,
			status: "missing",
			label: "Missing",
			detail: "หน้านี้ยังไม่มี image asset ID",
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
		};
	}

	if (assetInventoryError) {
		return {
			pageIndex,
			status: "unknown",
			label: "Unknown",
			detail: `ตรวจคลังรูปไม่ได้: ${assetInventoryError}`,
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
		};
	}

	if (assetRecord) {
		const storageStatus = assetRecord.storageStatus || "";
		const moderationStatus = assetRecord.moderationStatus || "";
		const recordName = assetRecord.originalName || imageName || `Page ${pageIndex + 1}`;
		if (storageStatus === "blocked" || moderationStatus === "blocked") {
			return {
				pageIndex,
				status: "blocked",
				label: "Blocked",
				detail: `${recordName} ติดบล็อกจาก storage หรือการตรวจรูป`,
				imageId: page.imageId,
				imageName: page.imageName,
				originalName: page.originalName,
				storageStatus,
				moderationStatus,
			};
		}
		if (
			storageStatus === "quarantined"
			|| moderationStatus === "pending"
			|| moderationStatus === "needs_review"
		) {
				return {
					pageIndex,
					status: "scanning",
					label: moderationStatus === "needs_review" ? "ต้องตรวจ" : "Scanning",
					detail: moderationStatus === "needs_review"
					? `${recordName} ต้องผ่านการตรวจรูปก่อน Export หรือใช้ AI`
					: `${recordName} รอปล่อยไฟล์ก่อนใช้งาน`,
				imageId: page.imageId,
				imageName: page.imageName,
				originalName: page.originalName,
				storageStatus,
				moderationStatus,
			};
		}
	}

	if (assetInventoryKnown && !assetRecord) {
		return {
			pageIndex,
			status: "missing",
			label: "Missing",
			detail: `${imageName || `หน้า ${pageIndex + 1}`} ไม่อยู่ในคลังรูปของงาน; กู้รูปหน้านี้หรือจับคู่โฟลเดอร์รูป`,
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
		};
	}

	if (page.edits?.imageId) {
		return {
			pageIndex,
			status: "ready",
			label: "Edited",
			detail: `${imageName || `Page ${pageIndex + 1}`} has an edited image result.`,
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
		};
	}

	return {
		pageIndex,
		status: "ready",
		label: "Ready",
		detail: `${imageName || `Page ${pageIndex + 1}`} is available for editing.`,
		imageId: page.imageId,
		imageName: page.imageName,
		originalName: page.originalName,
	};
}

export function findPageAssetRecord(
	page: Page | undefined,
	assets: PageAssetRecordLike[],
): PageAssetRecordLike | null {
	const sourceImageId = page?.imageId;
	const editImageId = page?.edits?.imageId;
	const sourceAsset = findAssetRecordByImageId(sourceImageId, assets);
	if (sourceAsset) return sourceAsset;
	return findAssetRecordByImageId(editImageId, assets);
}

function findAssetRecordByImageId(
	imageId: string | undefined,
	assets: PageAssetRecordLike[],
): PageAssetRecordLike | null {
	if (!imageId) return null;
	return assets.find((asset) => asset.imageId === imageId || asset.assetId === imageId) ?? null;
}
