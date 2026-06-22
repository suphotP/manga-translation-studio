// UI-side resolver for the QC-issue message codes.
//
// `qc-checks.ts` is framework-agnostic and emits a stable `messageCode` (+
// optional `messageValues`) instead of a pre-built Thai sentence. This thin
// resolver turns that code into a localized string via the svelte-i18n
// formatter, so every consumer (StatusBar, PageNavigator, WorkspacePagesView,
// ProjectModePanel, QcRegionOverlay, WorkQcPanel — plus the work-inbox /
// page-work-summary detail surfaces) shares one mapping. Pass the component's
// reactive `$_` formatter as `t`.
//
// The Thai (`th`) templates reconstruct the original full sentences BYTE-FOR-BYTE
// once the sub-fragments are composed: the page-label fragment (`หน้า {n}` /
// `หน้าที่ไม่ถูกต้อง`) and the text-layer-label fragment (`เลเยอร์ {category}` /
// `เลเยอร์ข้อความ`) are composed FIRST, then injected as `{page}` / `{layerLabel}`
// into the message template — exactly mirroring how `qc-checks.ts` used to
// interpolate `pageLabel()` and `layerLabel`.

import type { QcIssue, QcMessageValues } from "$lib/project/qc-checks.js";

// The svelte-i18n message formatter shape we use. Mirrors svelte-i18n's
// `MessageFormatter`: interpolation `values` are scalars.
type InterpolationValue = string | number | boolean | Date | null | undefined;
type Translate = (key: string, options?: { values?: Record<string, InterpolationValue> }) => string;

/**
 * The localized page-label fragment for a `page` value: `หน้า {n}` when the
 * 1-based number is present, the "invalid page" fragment otherwise (the former
 * `persistedPageLabel` fallback). Returns "" when no page is involved.
 */
function pageLabelFragment(page: number | undefined, t: Translate): string {
	if (page === undefined || page === null) return "";
	return t("qcIssue.pageLabel", { values: { n: page } });
}

/** The localized text-layer-label fragment (`เลเยอร์ {category}` / `เลเยอร์ข้อความ`). */
function layerLabelFragment(values: QcMessageValues | undefined, t: Translate): string {
	if (values?.layerLabelCode === "category") {
		return t("qcIssue.layerLabel.category", { values: { category: values.layerCategory ?? "" } });
	}
	return t("qcIssue.layerLabel.generic");
}

/**
 * The localized QC-issue message for an issue. Composes the page-label and
 * (text-layer) layer-label sub-fragments first, then renders the message
 * template via `$_("qcIssue.<messageCode>", { values })`.
 */
export function resolveQcIssueMessage(
	issue: Pick<QcIssue, "messageCode" | "messageValues">,
	t: Translate,
): string {
	const v = issue.messageValues;
	const values: Record<string, InterpolationValue> = {
		// Compose the page fragment: a present number renders `หน้า {n}`, an absent
		// one renders the "invalid page" fragment (comment_page_missing's fallback).
		page: issue.messageCode === "comment_page_missing"
			? (v?.page === undefined ? t("qcIssue.invalidPage") : pageLabelFragment(v?.page, t))
			: pageLabelFragment(v?.page, t),
		layerLabel: layerLabelFragment(v, t),
		lineCount: v?.lineCount,
		lang: v?.lang,
		layerName: v?.layerName,
		count: v?.count,
		taskTitle: v?.taskTitle,
		taskLayerId: v?.taskLayerId,
		taskCount: v?.taskCount,
		pageCount: v?.pageCount,
		markerImageId: v?.markerImageId,
		currentImageId: v?.currentImageId,
		commentIds: v?.commentIds,
		commentId: v?.commentId,
		taskIds: v?.taskIds,
		taskLinkId: v?.taskLinkId,
	};
	return t(`qcIssue.${issue.messageCode}`, { values });
}
