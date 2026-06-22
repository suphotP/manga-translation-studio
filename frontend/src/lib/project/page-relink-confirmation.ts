import type { PageImageRelinkMatch, PageImageRelinkPlan } from "$lib/project/page-relink.js";

export interface MatchingPageImageRelinkPreviewLike {
	plan: PageImageRelinkPlan;
	nameMatchedCount?: number;
	orderMatchedCount: number;
	requiresOrderConfirmation: boolean;
	supportedFileCount?: number;
	unsupportedSummary?: string;
}

export interface PageImageRelinkOrderFallbackRow {
	pageIndex: number;
	pageLabel: string;
	fileName: string;
	expectedName: string;
}

export interface PageImageRelinkOrderFallbackPreview {
	rows: PageImageRelinkOrderFallbackRow[];
	hiddenRowCount: number;
	nameMatchedCount: number;
	orderMatchedCount: number;
	unmatchedPageCount: number;
	unusedFileCount: number;
	unsupportedSummary: string;
}

function firstExpectedName(match: PageImageRelinkMatch): string {
	return match.expectedNames[0] ?? "ไม่มีชื่อไฟล์เดิม";
}

export function buildPageImageRelinkOrderFallbackPreview(
	preview: MatchingPageImageRelinkPreviewLike,
	maxRows = 8,
): PageImageRelinkOrderFallbackPreview {
	const orderMatches = preview.plan.matches.filter((match) => match.matchedBy === "order");
	const rows = orderMatches.slice(0, maxRows).map((match) => ({
		pageIndex: match.pageIndex,
		pageLabel: `หน้า ${match.pageIndex + 1}`,
		fileName: match.file.name,
		expectedName: firstExpectedName(match),
	}));

	return {
		rows,
		hiddenRowCount: Math.max(0, orderMatches.length - rows.length),
		nameMatchedCount: preview.nameMatchedCount ?? preview.plan.matches.filter((match) => match.matchedBy === "name").length,
		orderMatchedCount: preview.orderMatchedCount,
		unmatchedPageCount: preview.plan.unmatchedPageIndexes.length,
		unusedFileCount: preview.plan.unusedFiles.length,
		unsupportedSummary: preview.unsupportedSummary ?? "",
	};
}

export function confirmPageImageRelinkOrderFallback(
	preview: MatchingPageImageRelinkPreviewLike,
	confirmFn: (message: string) => boolean,
): boolean {
	if (!preview.requiresOrderConfirmation) return true;
	const orderPreview = buildPageImageRelinkOrderFallbackPreview(preview, 4).rows
		.map((row) => `${row.pageLabel} -> ${row.fileName}`)
		.join("\n");
	return confirmFn(
		`จับคู่รูปตามลำดับ ${preview.orderMatchedCount} หน้า\n${orderPreview}\n\nถ้าลำดับไฟล์ไม่ตรง หน้าอาจถูกแทนรูปผิด ต้องการกู้รูปต่อไหม?`,
	);
}

export const pageImageRelinkOrderFallbackCancelMessage = "ยกเลิกกู้รูป: ตรวจลำดับไฟล์จากโฟลเดอร์ก่อนแทนรูป";
