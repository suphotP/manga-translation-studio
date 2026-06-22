import { get } from "svelte/store";
import { _ } from "svelte-i18n";
import type { ExportMeteringInput, ExportRun, ExportRunKind, ExportRunStatus } from "$lib/types.js";
import { normalizeExportProfileId } from "$lib/project/export-profiles.js";
import { MissingLanguageOutputError } from "$lib/project/page-export.js";

export const MAX_EXPORT_RUNS = 20;

export interface ExportRunInput {
	kind: ExportRunKind;
	status: ExportRunStatus;
	filename: string;
	pageIndexes: number[];
	bytes?: number;
	targetProfile?: ExportRun["targetProfile"];
	artifact?: ExportRun["artifact"];
	artifactError?: string;
	message: string;
	error?: string;
	failedPageIndex?: number;
	failedPageNumber?: number;
	meteringPending?: boolean;
	meteringRecordedAt?: string;
	meteringInput?: ExportMeteringInput;
	now?: string;
}

export interface ExportRunPageScope {
	pageIndexes: number[];
	missingPageIndexes: number[];
}

export const DEFAULT_EXPORT_HISTORY_VISIBLE_RUNS = 4;

function exportRunId(): string {
	return `export-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function normalizePageIndexes(pageIndexes: readonly number[]): number[] {
	return Array.from(new Set(pageIndexes))
		.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0)
		.sort((a, b) => a - b);
}

export function createExportRun(input: ExportRunInput): ExportRun {
	const now = input.now ?? new Date().toISOString();
	const pageIndexes = normalizePageIndexes(input.pageIndexes);
	const run: ExportRun = {
		id: exportRunId(),
		kind: input.kind,
		status: input.status,
		targetProfile: normalizeExportProfileId(input.targetProfile),
		filename: input.filename.trim() || "export",
		pageIndexes,
		pageCount: pageIndexes.length,
		bytes: Number.isFinite(input.bytes) ? Math.max(0, Math.round(input.bytes!)) : undefined,
		artifact: input.artifact,
		artifactError: input.artifactError?.trim() || undefined,
		message: input.message.trim() || (input.status === "done" ? "Export completed." : "Export failed."),
		error: input.error?.trim() || undefined,
		createdAt: now,
		completedAt: now,
	};
	if (Number.isInteger(input.failedPageIndex) && input.failedPageIndex! >= 0) {
		run.failedPageIndex = input.failedPageIndex;
		run.failedPageNumber = Number.isInteger(input.failedPageNumber) && input.failedPageNumber! > 0
			? input.failedPageNumber
			: input.failedPageIndex! + 1;
	}
	const meteringInput = sanitizeMeteringInput(input.meteringInput);
	if (meteringInput) run.meteringInput = meteringInput;
	if (input.meteringPending) run.meteringPending = true;
	if (input.meteringRecordedAt) run.meteringRecordedAt = input.meteringRecordedAt;
	return run;
}

/**
 * Validate/normalize a persisted metering payload. A run is only "meterable"
 * with a positive byte count and a non-empty idempotency key; anything else is
 * dropped so a malformed marker can never replay a forged/empty record.
 */
export function sanitizeMeteringInput(input: ExportMeteringInput | undefined): ExportMeteringInput | undefined {
	if (!input) return undefined;
	const bytes = Number.isFinite(input.bytes) ? Math.max(0, Math.round(input.bytes)) : 0;
	const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
	if (bytes <= 0 || !idempotencyKey) return undefined;
	const normalized: ExportMeteringInput = { bytes, idempotencyKey };
	if (Array.isArray(input.pageIndexes)) {
		normalized.pageIndexes = normalizePageIndexes(input.pageIndexes);
	}
	if (Number.isInteger(input.pageCount) && input.pageCount! >= 0) normalized.pageCount = input.pageCount;
	if (typeof input.filename === "string" && input.filename.trim()) normalized.filename = input.filename.trim();
	if (input.exportKind === "single-page" || input.exportKind === "batch-zip") normalized.exportKind = input.exportKind;
	if (input.targetProfile) normalized.targetProfile = input.targetProfile;
	if (typeof input.exportRunId === "string" && input.exportRunId.trim()) normalized.exportRunId = input.exportRunId.trim();
	if (input.metadata && typeof input.metadata === "object") normalized.metadata = input.metadata;
	return normalized;
}

/**
 * True when this run owns export usage that still needs to be recorded: it
 * completed successfully, carries a metering payload, and has neither been
 * recorded yet nor been left in a non-pending state.
 */
export function isExportRunMeteringPending(run: ExportRun): boolean {
	return Boolean(run.meteringPending) && !run.meteringRecordedAt && Boolean(run.meteringInput);
}

export function normalizeExportRuns(runs: readonly ExportRun[] | undefined): ExportRun[] {
	return (runs ?? [])
		.filter((run): run is ExportRun => Boolean(run?.id && run.filename && run.kind && run.status))
		.map((run) => {
			const pageIndexes = normalizePageIndexes(run.pageIndexes ?? []);
			const normalized: ExportRun = {
				...run,
				pageIndexes,
				pageCount: Number.isInteger(run.pageCount) && run.pageCount >= 0 ? run.pageCount : pageIndexes.length,
				bytes: Number.isFinite(run.bytes) ? Math.max(0, Math.round(run.bytes!)) : undefined,
				targetProfile: normalizeExportProfileId(run.targetProfile),
				artifactError: run.artifactError?.trim() || undefined,
				message: run.message || (run.status === "done" ? "Export completed." : "Export failed."),
				completedAt: run.completedAt || run.createdAt,
			};
			if (Number.isInteger(run.failedPageIndex) && run.failedPageIndex! >= 0) {
				normalized.failedPageIndex = run.failedPageIndex;
				normalized.failedPageNumber = Number.isInteger(run.failedPageNumber) && run.failedPageNumber! > 0
					? run.failedPageNumber
					: run.failedPageIndex! + 1;
			} else {
				delete normalized.failedPageIndex;
				delete normalized.failedPageNumber;
			}
			// Metering markers are an IN-SESSION, best-effort annotation: `exportRuns`
			// is a server-owned collection (stripped on save), so a client-ZIP marker
			// does NOT survive a reload — reload-durable metering is owned by the server
			// export pipeline (#316). This normalizer stays defensive: it sanitizes a
			// marker if one is ever present (e.g. a freshly-created run this session, or a
			// future server-persisted run), keeping a pending marker only while it carries
			// a replayable payload; once recorded we keep `meteringRecordedAt` (and drop
			// the pending flag) so reconcile skips it.
			const meteringInput = sanitizeMeteringInput(run.meteringInput);
			if (meteringInput) {
				normalized.meteringInput = meteringInput;
			} else {
				delete normalized.meteringInput;
			}
			if (run.meteringRecordedAt) {
				normalized.meteringRecordedAt = run.meteringRecordedAt;
				delete normalized.meteringPending;
			} else if (run.meteringPending && meteringInput) {
				normalized.meteringPending = true;
				delete normalized.meteringRecordedAt;
			} else {
				delete normalized.meteringPending;
				delete normalized.meteringRecordedAt;
			}
			return normalized;
		})
		.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
		.slice(0, MAX_EXPORT_RUNS);
}

export function getExportRunPageScope(run: ExportRun, pageCount: number): ExportRunPageScope {
	const safePageCount = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
	const pageIndexes = normalizePageIndexes(run.pageIndexes ?? []);
	return {
		pageIndexes: pageIndexes.filter((pageIndex) => pageIndex < safePageCount),
		missingPageIndexes: pageIndexes.filter((pageIndex) => pageIndex >= safePageCount),
	};
}

export function getVisibleExportHistoryRuns(
	runs: readonly ExportRun[],
	limit = DEFAULT_EXPORT_HISTORY_VISIBLE_RUNS,
): ExportRun[] {
	const visible = new Map<string, ExportRun>();
	for (const run of runs.slice(0, Math.max(0, limit))) {
		visible.set(run.id, run);
	}
	for (const run of runs) {
		if (run.artifact) {
			visible.set(run.id, run);
		}
	}
	return Array.from(visible.values());
}

export function formatExportRunPages(run: ExportRun): string {
	if (!run.pageIndexes.length) return `${run.pageCount || 0} หน้า`;
	if (run.pageIndexes.length === 1) return `หน้า ${run.pageIndexes[0] + 1}`;
	const first = run.pageIndexes[0] + 1;
	const last = run.pageIndexes[run.pageIndexes.length - 1] + 1;
	return run.pageIndexes.length === last - first + 1
		? `หน้า ${first}-${last}`
		: `${run.pageIndexes.length} หน้า`;
}

export function formatExportRunSize(bytes: number | undefined): string {
	if (!Number.isFinite(bytes)) return "";
	if (bytes! < 1024) return `${bytes} B`;
	if (bytes! < 1024 * 1024) return `${Math.round(bytes! / 1024)} KB`;
	return `${(bytes! / (1024 * 1024)).toFixed(1)} MB`;
}

function prefixFailedPage(detail: string, failedPageNumber?: number): string {
	if (!Number.isInteger(failedPageNumber) || failedPageNumber! < 1) return detail;
	const pagePattern = new RegExp(`หน้า\\s*${failedPageNumber}\\b`, "u");
	return pagePattern.test(detail) ? detail : `หน้า ${failedPageNumber}: ${detail}`;
}

/**
 * A clear, localized message for a `MissingLanguageOutputError` — names the target
 * language and which pages lack an output. Reads svelte-i18n imperatively (like
 * `creditUnitLabel`); `get(_)` THROWS before the locale is initialised (e.g. in unit
 * tests), so this falls back to a Thai string and never throws in a render path.
 */
export function formatMissingLanguageOutputMessage(error: MissingLanguageOutputError): string {
	const pages = error.pageNumbers.join(", ");
	const count = error.pageNumbers.length;
	try {
		const translate = get(_);
		const message = translate("chapterExport.missingLanguageOutput", {
			values: { lang: error.targetLang, count, pages },
		});
		// svelte-i18n returns the key itself when a message is missing.
		if (message && message !== "chapterExport.missingLanguageOutput") return message;
	} catch {
		// locale not initialised — fall through to the default below.
	}
	return `Export ภาษา ${error.targetLang} ไม่ได้: มี ${count} หน้าที่เลือกยังไม่มีงานภาษา ${error.targetLang} (หน้า ${pages})`;
}

export function formatExportFailureDetail(
	error: unknown,
	fallback = "ไม่สามารถ Export ได้",
	failedPageNumber?: number,
): string {
	// An explicit non-default language track with missing per-page output is a
	// readiness failure, not a render failure: surface the localized, page-naming
	// message (parity with the backend's MissingLanguageOutputError) verbatim.
	if (error instanceof MissingLanguageOutputError) {
		return formatMissingLanguageOutputMessage(error);
	}
	const message = error instanceof Error
		? error.message.trim()
		: typeof error === "string"
			? error.trim()
			: "";
	if (!message) return fallback;
	if (/fabric:\s*Error loading/i.test(message) || /Error loading\s+https?:\/\/\S+\/api\/images\//i.test(message)) {
		return prefixFailedPage("โหลดรูปสำหรับ Export ไม่สำเร็จ; กู้รูปหรือรีเฟรชหน้าแล้วลองใหม่", failedPageNumber);
	}
	if (/^Workspace plan quota reached/i.test(message)) return prefixFailedPage("Quota แผน workspace เต็ม", failedPageNumber);
	if (/^Workspace storage is full/i.test(message)) return prefixFailedPage("Storage ของเวิร์กสเปซเต็ม", failedPageNumber);
	if (/^Page was deleted\.?$/i.test(message)) return prefixFailedPage("หน้านี้ถูกลบแล้ว", failedPageNumber);
	return prefixFailedPage(message, failedPageNumber);
}

export function formatExportRunMessage(run: ExportRun): string {
	if (run.error) return `Export ไม่สำเร็จ: ${formatExportFailureDetail(run.error, undefined, run.failedPageNumber)}`;
	if (run.status === "done") {
		if (run.kind === "batch-zip") {
			const count = run.pageCount || run.pageIndexes.length || 0;
			return count ? `สร้าง ZIP สำเร็จ ${count} หน้า` : "สร้าง ZIP สำเร็จ";
		}
		return "Export หน้าเดียวสำเร็จ";
	}
	const message = run.message.trim();
	if (/^Export failed\.?$/i.test(message)) return "Export ไม่สำเร็จ";
	const failed = message.match(/^Export failed:\s*(.+)$/i);
	if (failed) return `Export ไม่สำเร็จ: ${formatExportFailureDetail(failed[1], undefined, run.failedPageNumber)}`;
	const exportedBatch = message.match(/^Exported\s+(\d+)\s+pages?\s+to\s+(.+)$/i);
	if (exportedBatch) return `Export สำเร็จ ${exportedBatch[1]} หน้า: ${exportedBatch[2]}`;
	const exportedSingle = message.match(/^Exported\s+(.+)$/i);
	if (exportedSingle) return `Export สำเร็จ: ${exportedSingle[1]}`;
	if (/^No valid pages selected for export\.$/i.test(message)) return "ไม่มีหน้าที่ใช้ Export ได้";
	const preparing = message.match(/^Preparing\s+(\d+)\s+pages?\.\.\.$/i);
	if (preparing) return `เตรียม Export ${preparing[1]} หน้า...`;
	const exporting = message.match(/^Exporting\s+(\d+)\/(\d+):\s*page\s+(\d+)$/i);
	if (exporting) return `กำลัง Export ${exporting[1]}/${exporting[2]}: หน้า ${exporting[3]}`;
	if (/^Export completed\.?$/i.test(message)) return "Export สำเร็จ";
	return message;
}
