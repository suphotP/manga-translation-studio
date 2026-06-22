import type { PageAssetIntegrity, PageAssetIntegrityStatus } from "$lib/project/page-assets.js";

// ── i18n helper layer ────────────────────────────────────────────────────────
// This module is framework-agnostic (no svelte-i18n). Instead of returning Thai
// strings it now returns STABLE CODES (or a structured passthrough). UI consumers
// map each code to `$_("pageWork.<group>.<code>")` and render the count tokens
// themselves. See merged PRs #483/#484/#485 for the pattern.
//
// `PageWorkLabel` is a small discriminated union: a KNOWN value resolves to a
// stable `{ code }` the consumer localizes; an UNKNOWN value (e.g. text produced
// by a still-Thai upstream util like page-work-summary.ts `statusLabel: "รอรีวิว"`,
// or an English nextAction the dictionary never mapped) is passed through as
// `{ text }` and rendered verbatim — preserving the previous passthrough behavior.

export type PageWorkLabel = { code: string } | { text: string };

// English status keys (the stable codes) → slug used as the i18n leaf key.
const STATUS_CODES: Record<string, string> = {
	Ready: "ready",
	Review: "review",
	Blocked: "blocked",
	"Needs work": "needsWork",
	"No text": "noText",
	"Missing image": "missingImage",
};

// English next-action keys → i18n leaf slug.
const NEXT_ACTION_CODES: Record<string, string> = {
	"Relink or restore page image": "relinkOrRestore",
	"Wait for asset scan or moderation review": "waitAssetScan",
	"Replace blocked page image": "replaceBlocked",
	"Retry asset inventory check": "retryInventory",
	"Fix blocking QC or AI item": "fixBlockingQcAi",
	"Place accepted AI result layer": "placeAcceptedAi",
	"Recover missing applied AI layer": "recoverAppliedAi",
	"Review AI result": "reviewAi",
	"Clear overdue task handoff": "clearOverdue",
	"Resolve open review notes": "resolveReviewNotes",
	"Clear warnings or task handoff": "clearWarnings",
	"Add or import editable text layers": "addText",
	"Ready for export review": "readyForExport",
};

// Asset label keys → i18n leaf slug.
const ASSET_LABEL_CODES: Record<string, string> = {
	Missing: "missing",
	Failed: "failed",
	Blocked: "blocked",
	Unknown: "unknown",
	Scanning: "scanning",
	Review: "review",
	Edited: "edited",
	Ready: "ready",
};

/**
 * Status pill copy. Returns `null` when there is no value (the consumer supplies
 * its own context-specific fallback, e.g. "ยังไม่ได้เลือกหน้า"), a `{ code }` for a
 * known status, or `{ text }` passthrough for an unmapped value.
 */
export function pageStatusCopy(value: string | null | undefined): PageWorkLabel | null {
	if (!value) return null;
	const code = STATUS_CODES[value];
	return code ? { code } : { text: value };
}

/**
 * Next-action copy. Returns `null` when empty (consumer supplies a fallback such
 * as "เปิดหน้าเพื่อรีวิวงาน"), else a known `{ code }` or `{ text }` passthrough.
 */
export function pageNextActionCopy(value: string | null | undefined): PageWorkLabel | null {
	if (!value) return null;
	const code = NEXT_ACTION_CODES[value];
	return code ? { code } : { text: value };
}

/**
 * Asset label copy. Returns `null` when the asset has no label (consumer renders
 * its own "สถานะรูป" default), else a known `{ code }` or `{ text }` passthrough.
 */
export function pageAssetLabelCopy(asset: Pick<PageAssetIntegrity, "label"> | null | undefined): PageWorkLabel | null {
	const label = asset?.label?.trim();
	if (!label) return null;
	const code = ASSET_LABEL_CODES[label];
	return code ? { code } : { text: label };
}

// Stable codes for the asset-recovery title / action copy (consumer localizes).
export function pageAssetRecoveryTitle(asset: Pick<PageAssetIntegrity, "status" | "issueKind">): string {
	if (asset.issueKind === "image-layer") return "imageLayer";
	if (asset.status === "failed") return "failed";
	if (asset.status === "blocked") return "blocked";
	if (asset.status === "unknown") return "unknown";
	if (asset.status === "scanning") return "scanning";
	return "missing";
}

export function pageAssetRecoveryAction(asset: Pick<PageAssetIntegrity, "status" | "issueKind">): string {
	if (asset.issueKind === "image-layer") return "imageLayer";
	if (asset.status === "blocked") return "blocked";
	if (asset.status === "unknown") return "unknown";
	if (asset.status === "scanning") return "scanning";
	return "missing";
}

/**
 * Asset signal copy. Returns a known `{ code }` for the recognized statuses, or
 * defers to {@link pageAssetLabelCopy} (which itself returns a code/text/null).
 */
export function pageAssetSignalCopy(status: PageAssetIntegrityStatus, label: string): PageWorkLabel | null {
	if (status === "missing") return { code: "missing" };
	if (status === "failed") return { code: "failed" };
	if (status === "blocked") return { code: "blocked" };
	if (status === "unknown") return { code: "unknown" };
	if (status === "scanning") return { code: "scanning" };
	return pageAssetLabelCopy({ label });
}

// Count-interpolation export copy: return a stable code; the consumer interpolates
// the `{n}` token via `$_("pageWork.export.<code>", { values: { n } })`.
export function exportMissingPagesCopy(): string {
	return "missingPages";
}

export function exportHistoryPagesMissingCopy(): string {
	return "historyPagesMissing";
}

export function exportRunNoMatchingPagesCopy(): string {
	return "runNoMatchingPages";
}

// Returns a code; the consumer interpolates the `{n}` token when `hasMissingPages`.
export function exportRetryCopy(hasMissingPages: boolean): string {
	return hasMissingPages ? "retryRemaining" : "retryAll";
}

export function exportFocusHistoryCopy(pageCount: number): string {
	return `เลือก ${pageCount} หน้าใน export history แล้ว`;
}

const EXPORT_CHECKLIST_TYPE_LABELS: Record<string, string> = {
	asset_not_ready: "รูปยังไม่พร้อม",
	untranslated_text: "ข้อความยังไม่แปล",
	unresolved_ai_marker: "ผล AI รอรีวิว",
	open_qc_comment: "โน้ต QC เปิดอยู่",
	qc_issue: "QC ต้องแก้/เช็ก",
	review_not_approved: "ยังไม่ผ่านรีวิว/QC",
	open_task: "งานที่ยังค้าง",
	required_credit_missing: "ต้องเปิดเครดิตก่อน",
	other: "รายการอื่นที่ต้องเคลียร์",
};

export function exportChecklistTypeCopy(type: string): string {
	return EXPORT_CHECKLIST_TYPE_LABELS[type] ?? type;
}

export function exportBlockerCopy(blocker: string): string {
	return blocker
		.replace(/^image layer asset missing from inventory:\s*(.+)$/i, "รูปเสริมไม่อยู่ในคลังรูป: $1")
		.replace(/^image layer asset missing:\s*(.+)$/i, "รูปเสริมไม่มีไฟล์ต้นทาง: $1")
		.replace(/(\d+) open comments?/, "$1 โน้ตเปิด")
		.replace(/(\d+) overdue tasks?/, "$1 งานเลยกำหนด")
		.replace(/(\d+) open tasks?/, "$1 งานเปิด")
		.replace(/(\d+) QC warnings?/, "$1 QC ต้องเช็ก")
		.replace(/(\d+) QC errors?/, "$1 QC ต้องแก้")
		.replace(/(\d+) accepted AI results? not placed/, "$1 ผล AI ผ่านแล้วแต่ยังไม่วาง")
		.replace(/(\d+) applied AI layers? missing/, "$1 เลเยอร์ AI ที่วางแล้วหาย")
		.replace(/(\d+) AI review items?/, "$1 ผล AI รอรีวิว")
		.replace("review changes requested", "รีวิวขอแก้")
		.replace("page review approval not recorded", "ยังไม่มีผลรีวิวผ่านหน้า")
		.replace("final QC handoff not closed", "ยังไม่ปิด QC ขั้นสุดท้าย")
		.replace("no editable text layers", "ยังไม่มีเลเยอร์ข้อความ")
		.replace("image asset still scanning", "รูปยังสแกนอยู่")
		.replace("image asset inventory unknown", "ยังตรวจคลังรูปไม่ได้")
		.replace("image asset not ready", "รูปยังไม่พร้อม");
}
