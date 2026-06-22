// Wave 3 W3.11: chapter export-gate readiness checklist.
//
// Computes — across ALL pages of a chapter (project), not just the first blocking
// page — every reason a chapter cannot yet be exported, grouped by blocker type
// with a per-page breakdown and an overall canExport flag. This is the
// server-authoritative replacement for the old sequential `firstHoldReason` UX,
// which surfaced only the first hold on the first held page.
//
// The aggregation is a PURE function over already-fetched inputs (project state +
// per-image moderation status + per-page/chapter work-state). The route fetches
// each dependency ONCE in bulk (one asset listing, one work-state batch) and feeds
// it in, so there is no N+1 fan-out per page.
//
// Reused signals (all server-authoritative):
//   - untranslated text regions  (PageState.textLayers / translationScriptSlots)
//   - unresolved AI markers       (ProjectState.aiReviewMarkers)
//   - open QC comments            (ProjectState.comments, status="open")
//   - workflow not approved/released (work-states service)
//   - failed/incomplete moderation (asset registry moderation status)

import type {
	AiReviewMarker,
	PageState,
	ProjectComment,
	ProjectState,
	TextLayerData,
} from "../types/index.js";
import type { AssetModerationStatus } from "../types/index.js";
import type { WorkStateValue } from "./work-states.js";
import { isExplicitLanguageTrack, languageOutputPresentForPage } from "./export-pipeline.js";

// Stable machine identifiers for each blocker type. Kept as a closed union so the
// frontend checklist and tests reference the same canonical set.
export type ExportBlockerType =
	| "untranslated_text"
	| "unresolved_ai_marker"
	| "open_qc_comment"
	| "qc_issue"
	| "workflow_not_approved"
	| "moderation_not_passed"
	| "missing_language_output"
	| "no_pages";

export const EXPORT_BLOCKER_TYPES: readonly ExportBlockerType[] = [
	"untranslated_text",
	"unresolved_ai_marker",
	"open_qc_comment",
	"qc_issue",
	"workflow_not_approved",
	"moderation_not_passed",
	"missing_language_output",
	"no_pages",
] as const;

// Human-readable, locale-neutral label per blocker type. The frontend localizes
// its own copy; this label is for API consumers / logs.
export const EXPORT_BLOCKER_LABELS: Record<ExportBlockerType, string> = {
	untranslated_text: "Untranslated text regions",
	unresolved_ai_marker: "Unresolved AI markers",
	open_qc_comment: "Open QC comments",
	qc_issue: "QC issues to resolve",
	workflow_not_approved: "Pages not approved/released",
	moderation_not_passed: "Failed or pending moderation",
	missing_language_output: "Missing language output",
	no_pages: "No pages to export",
};

export interface ExportBlockerPageRef {
	pageIndex: number;
	pageNumber: number;
	imageId?: string;
	/** Count of this blocker type on this page (e.g. 3 open comments). */
	count: number;
	/** Short, page-scoped detail for the jump-to-page UX. */
	detail?: string;
}

export interface ExportBlockerGroup {
	type: ExportBlockerType;
	label: string;
	/** Total instances of this blocker across all pages. */
	count: number;
	/** Pages affected by this blocker, in page order, for jump-to-page. */
	pages: ExportBlockerPageRef[];
}

export interface ExportReadiness {
	chapterId: string;
	projectId: string;
	workspaceId?: string;
	targetLang?: string;
	pageCount: number;
	/** Pages with zero blockers. */
	readyPageCount: number;
	/** Pages with at least one blocker. */
	blockedPageCount: number;
	canExport: boolean;
	/** One group per blocker TYPE that has at least one instance, in canonical order. */
	blockers: ExportBlockerGroup[];
	/** Per-page breakdown: every page with its own blocker types + counts. */
	pages: ExportReadinessPage[];
}

export interface ExportReadinessPage {
	pageIndex: number;
	pageNumber: number;
	imageId?: string;
	ready: boolean;
	blockers: ExportReadinessPageBlocker[];
}

export interface ExportReadinessPageBlocker {
	type: ExportBlockerType;
	label: string;
	count: number;
	detail?: string;
}

// Workflow states that satisfy the export gate. A chapter/page must be in one of
// these to be exportable.
const EXPORT_READY_WORK_STATES = new Set<WorkStateValue>(["approved", "released"]);

// AI marker statuses that still need human/placement attention before export.
// Mirrors the frontend page-work-summary model so the gate is consistent both
// sides.
const ACTIVE_AI_MARKER_STATUSES = new Set<AiReviewMarker["status"]>([
	"processing",
	"needs_review",
	"retry_requested",
	"failed",
]);

/**
 * Whether an accepted/applied marker's result image has actually been placed as
 * a page image layer (`ai-result-${marker.id}`). Mirrors the frontend
 * `hasAiResultLayer` check so the server gate also catches accepted/applied AI
 * output that never made it into the exported page.
 */
function hasPlacedAiResultLayer(page: PageState, marker: AiReviewMarker): boolean {
	const layers = Array.isArray(page.imageLayers) ? page.imageLayers : [];
	return layers.some((layer) => layer.id === `ai-result-${marker.id}`);
}

/**
 * Whether a marker still blocks export: active statuses always block, and an
 * accepted/applied marker with a `resultImageId` but no placed result layer
 * blocks too (the accepted AI output is not actually present in the page). This
 * matches the frontend `markerNeedsExportAttention`.
 */
function markerNeedsExportAttention(page: PageState, marker: AiReviewMarker): boolean {
	if (ACTIVE_AI_MARKER_STATUSES.has(marker.status)) return true;
	if (!marker.resultImageId) return false;
	if (marker.status === "accepted" || marker.status === "applied") {
		return !hasPlacedAiResultLayer(page, marker);
	}
	return false;
}

// Only "passed" clears the moderation gate. Everything else (pending /
// needs_review / blocked / undefined) holds the export.
function moderationPasses(status: AssetModerationStatus | undefined): boolean {
	return status === "passed";
}

/**
 * Collect the asset ids of every placed image layer that actually appears in the
 * exported/composited output for a page, so they go through the same moderation
 * gate as the source/edited background image.
 *
 * The batch export composites every layer where `visible !== false` (see the
 * frontend `page-export` collector, which filters `imageLayers` by
 * `layer.visible !== false`). A hidden/removed layer (`visible === false`) is NOT
 * in the output, so we intentionally do not block on it. Layers without a usable
 * `imageId` are skipped here — they carry no asset to moderate (the export
 * pipeline separately rejects a visible layer with no asset id as a missing-asset
 * error), so this gate stays scoped to "every visible asset that ends up in the
 * artifact must have passed moderation".
 *
 * Returns de-duplicated ids in first-seen order (a single asset reused across
 * layers is only checked once).
 */
function visibleLayerImageIds(page: PageState): string[] {
	const layers = Array.isArray(page.imageLayers) ? page.imageLayers : [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const layer of layers) {
		if (!layer || layer.visible === false) continue;
		const id = typeof layer.imageId === "string" ? layer.imageId.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/**
 * Asset ids of every visible NON-DESTRUCTIVE edit-layer asset that the export composites
 * into the page. The export pipeline realizes these layers into the output, so — like
 * every visible placed image-layer asset — each referenced asset must pass moderation
 * AND actually be realized/usable before the page can export. We collect:
 *   - Phase A `fill-mask`: `maskAssetId` (the cleaned-fill coverage mask).
 *   - Phase B `patch`: `patchAssetId` (the realized RGBA ROI).
 *   - Phase B `healing` / `clone`: `realizedPatchAssetId` (the realized ROI) +
 *     `maskAssetId` (the stroke mask), so a page with a visible heal/clone whose realized
 *     patch asset is still pending/needs_review is correctly HELD (codex #392 P1-2) —
 *     otherwise readiness reports READY and the durable processor later fails async.
 * Hidden layers (`visible === false`) and payloads without a usable id are skipped.
 * De-duplicated in first-seen order.
 */
function visibleEditMaskImageIds(page: PageState): string[] {
	const layers = (page as unknown as { imageEditLayers?: unknown }).imageEditLayers;
	if (!Array.isArray(layers)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	const push = (value: unknown) => {
		const id = typeof value === "string" ? value.trim() : "";
		if (!id || seen.has(id)) return;
		seen.add(id);
		ids.push(id);
	};
	for (const layer of layers) {
		if (!layer || typeof layer !== "object") continue;
		const record = layer as Record<string, unknown>;
		if (record.visible === false) continue;
		const payload = record.payload;
		if (!payload || typeof payload !== "object") continue;
		const p = payload as Record<string, unknown>;
		switch (p.type) {
			case "fill-mask":
				push(p.maskAssetId);
				break;
			case "patch":
				push(p.patchAssetId);
				push(p.maskAssetId);
				break;
			case "healing":
			case "clone":
				push(p.realizedPatchAssetId);
				push(p.maskAssetId);
				break;
			default:
				break;
		}
	}
	return ids;
}

export interface ExportReadinessInput {
	state: ProjectState;
	/**
	 * Per-image moderation status, keyed by imageId. Fetched ONCE in bulk by the
	 * route (single asset listing). An imageId absent from the map is treated as
	 * having no passing moderation result yet (held), so a page whose asset row
	 * isn't registered does not silently pass the gate.
	 */
	moderationByImageId?: Map<string, AssetModerationStatus | undefined>;
	/**
	 * Per-page workflow state, keyed by pageIndex. Fetched ONCE in bulk by the
	 * route. Absent => treated via {@link chapterWorkState} fallback below.
	 */
	workStateByPageIndex?: Map<number, WorkStateValue | undefined>;
	/**
	 * Chapter-level workflow state. When per-page state is absent for a page, the
	 * chapter state acts as the fallback: a chapter marked approved/released
	 * satisfies the workflow gate for every page that has no page-level state.
	 * When BOTH are absent the workflow gate is NOT applied (the prototype/no-DB
	 * deployment has no workflow store), so readiness still reflects the other
	 * server-authoritative blockers.
	 */
	chapterWorkState?: WorkStateValue | undefined;
	/**
	 * Whether a workflow store is available at all. When false (no DB), the
	 * workflow gate is skipped entirely rather than reported as "not approved",
	 * so a prototype project isn't permanently un-exportable.
	 */
	workflowGateEnabled?: boolean;
	/**
	 * Optional page-scope predicate. When provided, only page indexes for which
	 * this returns true are included in the readiness aggregate. Used to keep a
	 * page-scoped workspace member from seeing blocker details / imageIds for
	 * pages outside their assignment (matching the enqueue-path scope check). When
	 * omitted, every page is included.
	 */
	includePageIndex?: (pageIndex: number) => boolean;
	/** Optional target language track whose text/typeset/QC/AI blockers are evaluated. */
	targetLang?: string;
	/**
	 * The RAW caller-supplied track, before defaulting. Used only to decide whether
	 * the request is an EXPLICIT non-default track. When such a track is missing on a
	 * page (no `languageOutputs[track]`), the page would silently export the
	 * source/legacy (wrong) language, so it's reported as a `missing_language_output`
	 * blocker (canExport=false) rather than passing the gate on legacy text/QC. When
	 * omitted or equal to the project default, this never adds a blocker.
	 */
	requestedTargetLang?: string;
}

/**
 * Count untranslated text regions on a page. A region is "untranslated" when a
 * translation script slot has no translated text, or — when there are no slots —
 * the page carries source text layers but none have non-empty text yet. Pages
 * with zero text at all are not flagged here (an art-only page is exportable);
 * the no-text case is intentionally NOT a hard blocker because many webtoon SFX
 * pages legitimately have no dialogue.
 */
function countUntranslatedRegions(page: PageState): number {
	const slots = Array.isArray(page.translationScriptSlots) ? page.translationScriptSlots : [];
	if (slots.length > 0) {
		return slots.filter((slot) => !slot.translatedText || !slot.translatedText.trim()).length;
	}
	// No structured slots: fall back to source text layers that still have no
	// translated text. A layer with a `sourceText` but an empty `text` is an
	// untranslated region.
	const layers = Array.isArray(page.textLayers) ? page.textLayers : [];
	return layers.filter((layer) => {
		const hasSource = typeof layer.sourceText === "string" && layer.sourceText.trim().length > 0;
		const hasTranslation = typeof layer.text === "string" && layer.text.trim().length > 0;
		return hasSource && !hasTranslation;
	}).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function languageOutputForPage(page: PageState, targetLang: string | undefined): Partial<PageState> | undefined {
	if (!targetLang) return undefined;
	const outputs = (page as unknown as { languageOutputs?: unknown }).languageOutputs;
	if (!isRecord(outputs)) return undefined;
	const output = outputs[targetLang];
	return isRecord(output) ? output as Partial<PageState> : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The per-language render-BACKGROUND image id the export PIPELINE actually
 * composites for a page+track. This MUST mirror `languageRenderImageId` in
 * export-pipeline.ts EXACTLY (typesetImageId -> exportImageId -> renderedImageId ->
 * imageId -> edits.imageId) so the readiness moderation gate cannot drift from the
 * id the pipeline renders. Without this, a member could set
 * `languageOutputs[lang].typesetImageId` to an unmoderated/unregistered object
 * (e.g. a raw `aijob_provider_*` checkpoint) — readiness would never check it,
 * yet the pipeline would composite its raw bytes into the export (CSAM bypass).
 */
function languageRenderImageId(output: Partial<PageState> | undefined): string | undefined {
	if (!output) return undefined;
	const rec = output as unknown as Record<string, unknown>;
	const direct = readString(rec.typesetImageId)
		?? readString(rec.exportImageId)
		?? readString(rec.renderedImageId)
		?? readString(rec.imageId);
	if (direct) return direct;
	const edits = rec.edits;
	return isRecord(edits) ? readString(edits.imageId) : undefined;
}

function pageForTargetLang(page: PageState, targetLang: string | undefined): PageState {
	const output = languageOutputForPage(page, targetLang);
	if (!output) return page;
	return {
		...page,
		...output,
		imageId: page.imageId,
		imageName: page.imageName,
		pendingAiJobs: page.pendingAiJobs,
		coverRect: page.coverRect,
	};
}

function recordTargetLang(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const lang = value.targetLang ?? value.lang ?? value.language;
	return typeof lang === "string" && lang.trim().length > 0 ? lang.trim() : undefined;
}

function appliesToTargetLang(value: unknown, targetLang: string | undefined): boolean {
	const lang = recordTargetLang(value);
	return !targetLang || !lang || lang === targetLang;
}

/**
 * Count AI markers on a page that still block export: any marker in an active
 * status (processing/needs_review/retry_requested/failed), PLUS accepted/applied
 * markers whose result image was never placed as a layer. These must be resolved
 * (accepted+placed, rejected, or applied+placed) before the page is export-ready.
 */
function countUnresolvedAiMarkers(page: PageState, markers: AiReviewMarker[]): number {
	return markers.filter((marker) => markerNeedsExportAttention(page, marker)).length;
}

/** Count open (unresolved) QC comments on a page. */
function countOpenComments(comments: ProjectComment[]): number {
	return comments.filter((comment) => comment.status === "open").length;
}

/**
 * Count server-computable QC issues on a page. The full QC engine lives on the
 * client (it also needs asset/inventory context), but a few structural checks are
 * server-authoritative purely from the page text layers and mirror the
 * established export gate (page-work-summary treats QC errors/warnings as
 * blockers):
 *   - empty_text_layer       (error): a text layer with no text content.
 *   - invalid_text_box       (error): a text layer with a non-positive box.
 *   - unchanged_source_text  (warning): translated text identical to its source.
 * Returns separate error/warning counts so the gate can mirror the client, which
 * blocks on BOTH qcErrorCount and qcWarningCount.
 */
function countQcIssues(page: PageState): { errors: number; warnings: number } {
	const layers: TextLayerData[] = Array.isArray(page.textLayers) ? page.textLayers : [];
	let errors = 0;
	let warnings = 0;
	for (const layer of layers) {
		const text = typeof layer.text === "string" ? layer.text.trim() : "";
		const sourceText = typeof layer.sourceText === "string" ? layer.sourceText.trim() : "";
		if (!text) errors += 1; // empty_text_layer
		if (!(layer.w > 0) || !(layer.h > 0)) errors += 1; // invalid_text_box
		// unchanged_source_text: a non-empty translation identical to its source.
		if (text && sourceText && text.toLowerCase() === sourceText.toLowerCase()) warnings += 1;
	}
	return { errors, warnings };
}

/**
 * Compute the full export-gate readiness for a chapter across ALL pages. Pure: no
 * I/O. The route supplies the already-fetched moderation + work-state maps.
 */
export function computeExportReadiness(input: ExportReadinessInput): ExportReadiness {
	const { state } = input;
	const moderationByImageId = input.moderationByImageId ?? new Map();
	const workStateByPageIndex = input.workStateByPageIndex ?? new Map();
	const workflowGateEnabled = input.workflowGateEnabled ?? false;
	const chapterId = state.projectId;
	const targetLang = input.targetLang?.trim() || undefined;
	// An EXPLICIT non-default track (caller asked for a language other than the
	// project default) must have a per-page output. A page missing that output
	// would silently export the source/legacy (wrong) language, so it's a hard
	// blocker rather than a pass on legacy text/QC. The omitted/default case never
	// triggers this (keeps single-language readiness unchanged).
	const explicitTrack = isExplicitLanguageTrack(state, input.requestedTargetLang ?? input.targetLang)
		? (input.requestedTargetLang?.trim() || input.targetLang?.trim() || undefined)
		: undefined;

	const allPages = Array.isArray(state.pages) ? state.pages : [];
	const includePageIndex = input.includePageIndex;
	// Apply the page-scope filter (if any) up front so the entire aggregate —
	// counts, groups, per-page breakdown, and canExport — reflects only the pages
	// the caller is allowed to see. We keep original page indexes for jump-to-page.
	const pages = includePageIndex
		? allPages.map((page, index) => ({ page, index })).filter(({ index }) => includePageIndex(index))
		: allPages.map((page, index) => ({ page, index }));
	const allComments = Array.isArray(state.comments) ? state.comments : [];
	const allMarkers = Array.isArray(state.aiReviewMarkers) ? state.aiReviewMarkers : [];

	// Bucket comments + markers by page once (O(n)) rather than filtering per page
	// (which would be O(pages * items)).
	const commentsByPage = new Map<number, ProjectComment[]>();
	for (const comment of allComments) {
		if (!appliesToTargetLang(comment, targetLang)) continue;
		const list = commentsByPage.get(comment.pageIndex) ?? [];
		list.push(comment);
		commentsByPage.set(comment.pageIndex, list);
	}
	const markersByPage = new Map<number, AiReviewMarker[]>();
	for (const marker of allMarkers) {
		if (!appliesToTargetLang(marker, targetLang)) continue;
		const list = markersByPage.get(marker.pageIndex) ?? [];
		list.push(marker);
		markersByPage.set(marker.pageIndex, list);
	}

	const readinessPages: ExportReadinessPage[] = [];
	// Accumulate per-type groups across all pages.
	const groups = new Map<ExportBlockerType, ExportBlockerGroup>();
	const addToGroup = (type: ExportBlockerType, ref: ExportBlockerPageRef): void => {
		const group = groups.get(type) ?? { type, label: EXPORT_BLOCKER_LABELS[type], count: 0, pages: [] };
		group.count += ref.count;
		group.pages.push(ref);
		groups.set(type, group);
	};

	if (pages.length === 0) {
		// A chapter with no pages cannot be exported. Report it as its own blocker
		// type so the UI shows an empty-state rather than a misleading "ready".
		addToGroup("no_pages", { pageIndex: -1, pageNumber: 0, count: 1, detail: "Chapter has no pages" });
	}

	let readyPageCount = 0;
	pages.forEach(({ page, index: pageIndex }) => {
		const languagePage = pageForTargetLang(page, targetLang);
		const pageNumber = pageIndex + 1;
		const imageId = typeof page.imageId === "string" && page.imageId.length > 0 ? page.imageId : undefined;
		// The batch export plan uses the edited/generated image as the background
		// when present, so moderation must be checked on it too — not just the
		// original source image.
		const editedImageId = typeof languagePage.edits?.imageId === "string" && languagePage.edits.imageId.length > 0
			? languagePage.edits.imageId
			: undefined;
		const pageBlockers: ExportReadinessPageBlocker[] = [];

		// 0. Missing language output (explicit non-default track only). When the
		// requested track has no per-page output, rendering would fall back to the
		// source/legacy page and export the WRONG language. Report it as a hard
		// blocker and skip the legacy text/QC/AI checks for this page, since those
		// would evaluate the wrong-language source data and could falsely pass.
		if (explicitTrack && !languageOutputPresentForPage(page, explicitTrack)) {
			pageBlockers.push({
				type: "missing_language_output",
				label: EXPORT_BLOCKER_LABELS.missing_language_output,
				count: 1,
				detail: `No "${explicitTrack}" output for this page`,
			});
			const ready = false;
			for (const blocker of pageBlockers) {
				addToGroup(blocker.type, { pageIndex, pageNumber, imageId, count: blocker.count, detail: blocker.detail });
			}
			readinessPages.push({ pageIndex, pageNumber, imageId, ready, blockers: pageBlockers });
			return;
		}

		// 1. Untranslated text regions.
		const untranslated = countUntranslatedRegions(languagePage);
		if (untranslated > 0) {
			pageBlockers.push({
				type: "untranslated_text",
				label: EXPORT_BLOCKER_LABELS.untranslated_text,
				count: untranslated,
				detail: `${untranslated} untranslated region${untranslated === 1 ? "" : "s"}`,
			});
		}

		// 2. Unresolved AI markers (active + accepted/applied-but-not-placed).
		const pageMarkers = markersByPage.get(pageIndex) ?? [];
		const unresolvedAi = countUnresolvedAiMarkers(languagePage, pageMarkers);
		if (unresolvedAi > 0) {
			pageBlockers.push({
				type: "unresolved_ai_marker",
				label: EXPORT_BLOCKER_LABELS.unresolved_ai_marker,
				count: unresolvedAi,
				detail: `${unresolvedAi} AI marker${unresolvedAi === 1 ? "" : "s"} need review`,
			});
		}

		// 3. Open QC comments.
		const pageComments = commentsByPage.get(pageIndex) ?? [];
		const openComments = countOpenComments(pageComments);
		if (openComments > 0) {
			pageBlockers.push({
				type: "open_qc_comment",
				label: EXPORT_BLOCKER_LABELS.open_qc_comment,
				count: openComments,
				detail: `${openComments} open comment${openComments === 1 ? "" : "s"}`,
			});
		}

		// 4. Server-computable QC issues (empty/invalid text box = error,
		// unchanged source text = warning). The client gate blocks on both QC
		// errors and warnings, so we mirror that here.
		const qc = countQcIssues(languagePage);
		const qcTotal = qc.errors + qc.warnings;
		if (qcTotal > 0) {
			const parts: string[] = [];
			if (qc.errors > 0) parts.push(`${qc.errors} error${qc.errors === 1 ? "" : "s"}`);
			if (qc.warnings > 0) parts.push(`${qc.warnings} warning${qc.warnings === 1 ? "" : "s"}`);
			pageBlockers.push({
				type: "qc_issue",
				label: EXPORT_BLOCKER_LABELS.qc_issue,
				count: qcTotal,
				detail: parts.join(", "),
			});
		}

		// 5. Workflow not approved/released. Page-level state wins; otherwise the
		// chapter state acts as the fallback. Skipped entirely when no workflow
		// store is available.
		if (workflowGateEnabled) {
			const pageState = workStateByPageIndex.has(pageIndex)
				? workStateByPageIndex.get(pageIndex)
				: input.chapterWorkState;
			if (!pageState || !EXPORT_READY_WORK_STATES.has(pageState)) {
				pageBlockers.push({
					type: "workflow_not_approved",
					label: EXPORT_BLOCKER_LABELS.workflow_not_approved,
					count: 1,
					detail: pageState ? `Workflow state: ${pageState}` : "No workflow state recorded",
				});
			}
		}

		// 6. Moderation not passed. An imageId with no registered moderation row is
		// held (not silently passed). Check the source image, the edited image used
		// as the export background, AND every visible placed image-layer asset that
		// the export composites into the output — since any failing/pending/missing
		// moderation on any of them holds the page. (A composited but un-moderated
		// reference/AI-result/pasted layer would otherwise slip past this gate.)
		const layerImageIds = visibleLayerImageIds(languagePage);
		const layerImageIdSet = new Set(layerImageIds);
		// Non-destructive edit-layer mask assets are SHARED at the page level (Phase A
		// cleaning is not per-language), so read them off the base page. They composite
		// into the output, so they go through the same moderation gate.
		const editMaskImageIds = visibleEditMaskImageIds(page);
		const editMaskImageIdSet = new Set(editMaskImageIds);
		// The per-language render BACKGROUND the export PIPELINE actually composites
		// (languageRenderImageId: typesetImageId/exportImageId/renderedImageId/output.imageId
		// -> output.edits.imageId). The pipeline resolves this BEFORE the page's flat
		// edited/source background, so it MUST be moderated here or a member could point
		// `languageOutputs[lang].typesetImageId` at an unmoderated/unregistered object (a
		// raw `aijob_provider_*` checkpoint) and slip raw bytes into the export (CSAM
		// bypass). With the "no asset row = held" semantics below, an unregistered or
		// non-passed render background BLOCKS the export with `moderation_not_passed`.
		const langOutput = languageOutputForPage(page, targetLang);
		const renderBackgroundImageId = languageRenderImageId(langOutput);
		// De-dupe so an asset reused as both background and a layer (or repeated) is
		// only checked/reported once per page; the existing group merge then keeps a
		// single ref per page.
		const moderatedImageIds = [...new Set(
			[imageId, editedImageId, renderBackgroundImageId, ...layerImageIds, ...editMaskImageIds].filter((id): id is string => Boolean(id)),
		)];
		for (const checkedImageId of moderatedImageIds) {
			const moderationStatus = moderationByImageId.get(checkedImageId);
			if (!moderationPasses(moderationStatus)) {
				const isEdited = checkedImageId === editedImageId && checkedImageId !== imageId;
				const isRenderBg = checkedImageId === renderBackgroundImageId
					&& checkedImageId !== imageId && checkedImageId !== editedImageId;
				const isLayer = layerImageIdSet.has(checkedImageId) && checkedImageId !== imageId && checkedImageId !== editedImageId && !isRenderBg;
				const isEditMask = editMaskImageIdSet.has(checkedImageId) && !isLayer && checkedImageId !== imageId && checkedImageId !== editedImageId && !isRenderBg;
				const prefix = isEditMask ? "Edit mask " : isLayer ? "Layer image " : isRenderBg ? "Render background " : isEdited ? "Edited image " : "";
				pageBlockers.push({
					type: "moderation_not_passed",
					label: EXPORT_BLOCKER_LABELS.moderation_not_passed,
					count: 1,
					detail: `${prefix}${moderationStatus ? `Moderation status: ${moderationStatus}` : "No moderation result"}`,
				});
			}
		}

		const ready = pageBlockers.length === 0;
		if (ready) readyPageCount += 1;

		for (const blocker of pageBlockers) {
			addToGroup(blocker.type, {
				pageIndex,
				pageNumber,
				imageId,
				count: blocker.count,
				detail: blocker.detail,
			});
		}

		readinessPages.push({ pageIndex, pageNumber, imageId, ready, blockers: pageBlockers });
	});

	// Emit groups in canonical type order so the checklist is stable. Within each
	// group, merge refs that share a pageIndex (a single page can raise the same
	// blocker type more than once — e.g. source + edited image moderation) so the
	// UI shows each affected page once with a summed count rather than duplicates
	// like "หน้า 2, 2".
	const blockers: ExportBlockerGroup[] = EXPORT_BLOCKER_TYPES
		.map((type) => groups.get(type))
		.filter((group): group is ExportBlockerGroup => group !== undefined)
		.map((group) => {
			const byPage = new Map<number, ExportBlockerPageRef>();
			for (const ref of group.pages) {
				const existing = byPage.get(ref.pageIndex);
				if (existing) {
					existing.count += ref.count;
					// Keep the first detail but note multiple instances when distinct.
					if (ref.detail && existing.detail && ref.detail !== existing.detail) {
						existing.detail = `${existing.detail}; ${ref.detail}`;
					} else if (ref.detail && !existing.detail) {
						existing.detail = ref.detail;
					}
				} else {
					byPage.set(ref.pageIndex, { ...ref });
				}
			}
			const mergedPages = [...byPage.values()].sort((a, b) => a.pageIndex - b.pageIndex);
			return { ...group, pages: mergedPages };
		});

	const blockedPageCount = readinessPages.filter((page) => !page.ready).length;
	const canExport = pages.length > 0 && blockers.length === 0;

	return {
		chapterId,
		projectId: state.projectId,
		workspaceId: state.workspaceId?.trim() || undefined,
		targetLang,
		pageCount: pages.length,
		readyPageCount,
		blockedPageCount,
		canExport,
		blockers,
		pages: readinessPages,
	};
}
