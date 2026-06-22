import type { AiReviewMarker, ImageLayer, Page, ProjectComment, ProjectState, TextLayer, WorkflowTask } from "$lib/types.js";
import { getAiMarkerLinkedReferenceIssue } from "./ai-marker-links.js";
import { compactImageId, getAiMarkerReferenceIssue } from "./ai-marker-reference.js";
import { activeTrack, trackTextLayers } from "./language-tracks.js";
import { estimateTextLayerFit } from "./text-layout-qc.js";
import { detectTextScriptMismatch } from "./text-script-qc.js";

export type QcSeverity = "error" | "warning" | "info";

/**
 * Stable, locale-neutral CODE for a QC issue's human-readable message. One code
 * per distinct rendered sentence; consumers localize via
 * `$_("qcIssue.<messageCode>", { values: messageValues })` (see
 * `qc-checks-i18n.ts` -> `resolveQcIssueMessage`). This replaces the former
 * pre-built Thai `message` so EN/JA/KO/ZH/AR users get a translated sentence.
 *
 * This is intentionally finer-grained than {@link QcIssue.code} (the
 * machine/routing discriminant): a single `code` can map to several
 * `messageCode`s when the original Thai had per-shape variants — e.g.
 * `duplicate_layer_id` -> `duplicate_layer_id_text` / `_image`, and the AI-marker
 * link codes split into single/multi forms. Each `messageCode` is 1:1 with the
 * sentence the user reads.
 */
export type QcMessageCode =
	| "project_empty"
	| "page_without_text"
	| "empty_text_layer"
	| "invalid_text_box"
	| "text_overflow_risk"
	| "duplicate_layer_id_text"
	| "duplicate_layer_id_image"
	| "image_layer_missing_asset"
	| "image_layer_asset_missing_from_inventory"
	| "invalid_image_layer_box"
	| "image_layer_outside_page"
	| "oversized_image_layer"
	| "unchanged_source_text"
	| "remaining_source_script"
	| "low_confidence_layer"
	| "ai_job_failed"
	| "ai_job_pending"
	| "ai_marker_failed"
	| "ai_marker_needs_review"
	| "ai_marker_page_missing"
	| "ai_marker_image_stale"
	| "ai_marker_comment_link_missing_one"
	| "ai_marker_comment_link_missing_many"
	| "ai_marker_task_link_missing_one"
	| "ai_marker_task_link_missing_many"
	| "workflow_task_page_missing"
	| "workflow_task_layer_missing"
	| "workflow_task_image_stale"
	| "review_decision_page_missing"
	| "workflow_incomplete"
	| "open_review_comments"
	| "comment_page_missing"
	| "comment_anchor_missing";

/**
 * Interpolation values for a {@link QcMessageCode} template. All values are
 * locale-neutral scalars (page numbers, counts, raw layer names / ids / image
 * ids, sample id lists). Sub-fragments that were themselves Thai (the page label
 * and the text-layer label) are NOT pre-built here — the resolver composes them
 * from `page` / `layerLabelCode` (+ `layerCategory`) so every locale renders its
 * own fragment.
 */
export interface QcMessageValues {
	/** 1-based page number for the page-label fragment (`page === undefined` -> "invalid page"). */
	page?: number;
	/** Stable code for the text-layer label fragment; `category` carries the raw source category. */
	layerLabelCode?: "category" | "generic";
	/** Raw source-category slug, present when `layerLabelCode === "category"`. */
	layerCategory?: string;
	/** Approx. wrapped line count (text overflow). */
	lineCount?: number;
	/** Upper-cased target language code (remaining source script). */
	lang?: string;
	/** Raw display name of an image layer. */
	layerName?: string;
	/** Duplicate-id occurrence count. */
	count?: number;
	/** Raw workflow-task title (free text). */
	taskTitle?: string;
	/** Raw layer id referenced by a workflow task. */
	taskLayerId?: string;
	/** Count of incomplete production tasks (workflow_incomplete). */
	taskCount?: number;
	/** Count of distinct pages with incomplete tasks (workflow_incomplete). */
	pageCount?: number;
	/** Compacted image id the AI marker is bound to (stale image). */
	markerImageId?: string;
	/** Compacted current page image id (stale image). */
	currentImageId?: string;
	/** Comma-joined sample of up to 3 missing linked comment ids. */
	commentIds?: string;
	/** The single missing linked comment id (one-variant). */
	commentId?: string;
	/** Comma-joined sample of up to 3 missing linked task ids. */
	taskIds?: string;
	/** The single missing linked task id (one-variant). */
	taskLinkId?: string;
}

export interface QcIssue {
	id: string;
	code:
		| "project_empty"
		| "page_without_text"
		| "empty_text_layer"
		| "invalid_text_box"
		| "text_overflow_risk"
		| "duplicate_layer_id"
		| "image_layer_missing_asset"
		| "image_layer_asset_missing_from_inventory"
		| "invalid_image_layer_box"
		| "image_layer_outside_page"
		| "oversized_image_layer"
		| "unchanged_source_text"
		| "remaining_source_script"
		| "low_confidence_layer"
		| "ai_job_failed"
		| "ai_job_pending"
		| "ai_marker_failed"
		| "ai_marker_needs_review"
		| "ai_marker_page_missing"
		| "ai_marker_image_stale"
		| "ai_marker_comment_link_missing"
		| "ai_marker_task_link_missing"
		| "workflow_task_page_missing"
		| "workflow_task_layer_missing"
		| "workflow_task_image_stale"
		| "review_decision_page_missing"
		| "workflow_incomplete"
		| "open_review_comments"
		| "comment_page_missing"
		| "comment_anchor_missing";
	severity: QcSeverity;
	/**
	 * Stable, locale-neutral message CODE the consumer localizes via
	 * `$_("qcIssue.<messageCode>", { values: messageValues })`. Replaces the
	 * former pre-built Thai `message` string. See {@link resolveQcIssueMessage}
	 * (qc-checks-i18n.ts) for the shared UI resolver.
	 */
	messageCode: QcMessageCode;
	/** Interpolation values for {@link messageCode}; omitted when the template is static. */
	messageValues?: QcMessageValues;
	pageIndex?: number;
	layerId?: string;
	layerKind?: "text" | "image";
	commentId?: string;
	markerId?: string;
	taskId?: string;
	reviewDecisionId?: string;
	duplicateLayerKind?: "text" | "image";
	duplicateLayerCount?: number;
}

export interface QcReport {
	issues: QcIssue[];
	errorCount: number;
	warningCount: number;
	infoCount: number;
	pageCount: number;
	checkedAt: string;
}

export interface QcAssetDimensions {
	assetId?: string;
	imageId: string;
	width: number;
	height: number;
}

export interface QcReportContext {
	assets?: QcAssetDimensions[];
	assetInventoryKnown?: boolean;
	localImageIds?: readonly string[];
}

const TRANSLATABLE_CATEGORIES = new Set(["dialogue", "narration", "sfx", "sign", "title", "other"]);

function countSeverity(issues: QcIssue[], severity: QcSeverity): number {
	return issues.filter((issue) => issue.severity === severity).length;
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function isLikelyTranslatable(layer: TextLayer): boolean {
	if (layer.protected) return false;
	if (!layer.sourceCategory) return true;
	return TRANSLATABLE_CATEGORIES.has(layer.sourceCategory);
}

function normalizeConfidence(confidence: number | undefined): number | null {
	if (!Number.isFinite(confidence)) return null;
	return confidence! <= 1 ? confidence! : confidence! / 100;
}

/**
 * The 1-based page number for the page-label fragment, or `undefined` when the
 * stored index is not a valid page position. A `page === undefined` value drives
 * the consumer's "invalid page" fragment (formerly the Thai "หน้าที่ไม่ถูกต้อง").
 */
function persistedPageNumber(pageIndex: number): number | undefined {
	return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex + 1 : undefined;
}

function hasProjectPage(project: ProjectState, pageIndex: number): boolean {
	return Number.isInteger(pageIndex) && pageIndex >= 0 && Boolean(project.pages[pageIndex]);
}

function safeIssueToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "missing";
}

function layerDisplayName(layer: Pick<ImageLayer, "imageName" | "originalName">): string {
	return layer.originalName || layer.imageName || "image layer";
}

function findAssetDimensions(
	page: Page,
	context: QcReportContext,
): { width: number; height: number } | null {
	const asset = context.assets?.find((item) => (
		item.imageId === page.imageId || item.assetId === page.imageId
	));
	if (!asset || asset.width <= 0 || asset.height <= 0) return null;
	return {
		width: asset.width,
		height: asset.height,
	};
}

function hasAssetRecordForImageId(imageId: string, context: QcReportContext): boolean {
	return context.assets?.some((item) => item.imageId === imageId || item.assetId === imageId) === true;
}

function hasLocalImageId(imageId: string, context: QcReportContext): boolean {
	return context.localImageIds?.includes(imageId) === true;
}

function checkTextLayer(pageIndex: number, layer: TextLayer, targetLang: string, duplicateSuffix = ""): QcIssue[] {
	const issues: QcIssue[] = [];
	// Locale-neutral descriptor for the text-layer label fragment (formerly the
	// inline Thai `เลเยอร์ {category}` / `เลเยอร์ข้อความ`); the resolver localizes it.
	const layerLabelCode = layer.sourceCategory ? "category" as const : "generic" as const;
	const layerLabelValues = layer.sourceCategory
		? { layerLabelCode, layerCategory: layer.sourceCategory }
		: { layerLabelCode };
	const text = normalizeText(layer.text);
	const sourceText = normalizeText(layer.sourceText);
	const unchangedSourceText = text && sourceText && text.toLowerCase() === sourceText.toLowerCase() && isLikelyTranslatable(layer);

	if (!text) {
		issues.push({
			id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-empty`,
			code: "empty_text_layer",
			severity: "error",
			messageCode: "empty_text_layer",
			messageValues: { page: pageIndex + 1, ...layerLabelValues },
			pageIndex,
			layerId: layer.id,
			layerKind: "text",
		});
	}

	if (layer.w <= 0 || layer.h <= 0) {
		issues.push({
			id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-invalid-box`,
			code: "invalid_text_box",
			severity: "error",
			messageCode: "invalid_text_box",
			messageValues: { page: pageIndex + 1 },
			pageIndex,
			layerId: layer.id,
			layerKind: "text",
		});
	}

	if (text && layer.w > 0 && layer.h > 0) {
		const fit = estimateTextLayerFit(layer);
		if (!fit.fits) {
			issues.push({
				id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-overflow`,
				code: "text_overflow_risk",
				severity: "warning",
				messageCode: "text_overflow_risk",
				messageValues: { page: pageIndex + 1, lineCount: fit.lineCount },
				pageIndex,
				layerId: layer.id,
				layerKind: "text",
			});
		}
	}

	if (unchangedSourceText) {
		issues.push({
			id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-unchanged`,
			code: "unchanged_source_text",
			severity: "warning",
			messageCode: "unchanged_source_text",
			messageValues: { page: pageIndex + 1 },
			pageIndex,
			layerId: layer.id,
			layerKind: "text",
		});
	}

	if (text && !unchangedSourceText && isLikelyTranslatable(layer)) {
		const scriptMismatch = detectTextScriptMismatch(text, targetLang);
		if (scriptMismatch.mismatch) {
			issues.push({
				id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-source-script`,
				code: "remaining_source_script",
				severity: "warning",
				messageCode: "remaining_source_script",
				messageValues: { page: pageIndex + 1, lang: targetLang.toUpperCase() },
				pageIndex,
				layerId: layer.id,
				layerKind: "text",
			});
		}
	}

	const confidence = normalizeConfidence(layer.confidence);
	if (confidence !== null && confidence < 0.55) {
		issues.push({
			id: `page-${pageIndex}-layer-${layer.id}${duplicateSuffix}-confidence`,
			code: "low_confidence_layer",
			severity: "warning",
			messageCode: "low_confidence_layer",
			messageValues: { page: pageIndex + 1 },
			pageIndex,
			layerId: layer.id,
			layerKind: "text",
		});
	}

	return issues;
}

function checkImageLayer(
	pageIndex: number,
	layer: ImageLayer,
	pageSize: { width: number; height: number } | null,
	context: QcReportContext,
	duplicateSuffix = "",
): QcIssue[] {
	const issues: QcIssue[] = [];
	const layerName = layerDisplayName(layer);
	if (layer.visible !== false && !layer.imageId?.trim()) {
		issues.push({
			id: `page-${pageIndex}-image-layer-${safeIssueToken(layer.id)}${duplicateSuffix}-missing-asset`,
			code: "image_layer_missing_asset",
			severity: "error",
			messageCode: "image_layer_missing_asset",
			messageValues: { page: pageIndex + 1, layerName },
			pageIndex,
			layerId: layer.id,
			layerKind: "image",
		});
	}
	if (
		layer.visible !== false
		&& layer.imageId?.trim()
		&& context.assetInventoryKnown === true
		&& !hasAssetRecordForImageId(layer.imageId, context)
		&& !hasLocalImageId(layer.imageId, context)
	) {
		issues.push({
			id: `page-${pageIndex}-image-layer-${safeIssueToken(layer.id)}${duplicateSuffix}-asset-missing-from-inventory`,
			code: "image_layer_asset_missing_from_inventory",
			severity: "error",
			messageCode: "image_layer_asset_missing_from_inventory",
			messageValues: { page: pageIndex + 1, layerName },
			pageIndex,
			layerId: layer.id,
			layerKind: "image",
		});
	}
	const opacity = layer.opacity ?? 1;
	const hasInvalidGeometry = (
		!Number.isFinite(layer.x)
		|| !Number.isFinite(layer.y)
		|| !Number.isFinite(layer.w)
		|| !Number.isFinite(layer.h)
		|| !Number.isFinite(layer.rotation)
		|| !Number.isFinite(opacity)
		|| layer.w <= 0
		|| layer.h <= 0
		|| opacity < 0
		|| opacity > 1
	);

	if (hasInvalidGeometry) {
		issues.push({
			id: `page-${pageIndex}-image-layer-${layer.id}${duplicateSuffix}-invalid-box`,
			code: "invalid_image_layer_box",
			severity: "error",
			messageCode: "invalid_image_layer_box",
			messageValues: { page: pageIndex + 1, layerName },
			pageIndex,
			layerId: layer.id,
			layerKind: "image",
		});
		return issues;
	}

	if (!pageSize) return issues;

	const outsidePage = (
		layer.x + layer.w <= 0
		|| layer.y + layer.h <= 0
		|| layer.x >= pageSize.width
		|| layer.y >= pageSize.height
	);
	if (outsidePage) {
			issues.push({
				id: `page-${pageIndex}-image-layer-${layer.id}${duplicateSuffix}-outside-page`,
				code: "image_layer_outside_page",
				severity: "warning",
				messageCode: "image_layer_outside_page",
				messageValues: { page: pageIndex + 1, layerName },
			pageIndex,
			layerId: layer.id,
			layerKind: "image",
		});
	}

	const oversized = layer.w > pageSize.width * 3 || layer.h > pageSize.height * 3;
	if (oversized) {
			issues.push({
				id: `page-${pageIndex}-image-layer-${layer.id}${duplicateSuffix}-oversized`,
				code: "oversized_image_layer",
				severity: "warning",
				messageCode: "oversized_image_layer",
				messageValues: { page: pageIndex + 1, layerName },
			pageIndex,
			layerId: layer.id,
			layerKind: "image",
		});
	}

	return issues;
}

function duplicateLayerSuffix(layerId: string, occurrences: Map<string, number>): string {
	const occurrence = occurrences.get(layerId) ?? 0;
	occurrences.set(layerId, occurrence + 1);
	return occurrence === 0 ? "" : `-duplicate-${occurrence}`;
}

function checkDuplicateLayerIds(
	pageIndex: number,
	layers: Array<Pick<TextLayer | ImageLayer, "id">>,
	kind: "text" | "image",
): QcIssue[] {
	const counts = new Map<string, number>();
	for (const layer of layers) {
		if (!layer.id) continue;
		counts.set(layer.id, (counts.get(layer.id) ?? 0) + 1);
	}

	const label = kind === "text" ? "text" : "image";
	return Array.from(counts.entries())
		.filter(([, count]) => count > 1)
			.map(([layerId, count]) => ({
				id: `page-${pageIndex}-${label}-layer-${safeIssueToken(layerId)}-duplicate-id`,
				code: "duplicate_layer_id" as const,
				severity: "warning" as const,
				messageCode: (kind === "text" ? "duplicate_layer_id_text" : "duplicate_layer_id_image") as QcMessageCode,
				messageValues: { page: pageIndex + 1, count },
			pageIndex,
			duplicateLayerKind: kind,
			duplicateLayerCount: count,
		}));
}

function checkPage(page: Page, pageIndex: number, targetLang: string, context: QcReportContext): QcIssue[] {
	const issues: QcIssue[] = [];
	// Per-language: QC the ACTIVE track's text layers. For a legacy single-language
	// project this resolves to the flat `page.textLayers` (the default-lang track),
	// so the report is byte-identical to before.
	const textLayers = trackTextLayers(page, targetLang);
	const imageLayers = Array.isArray(page.imageLayers) ? page.imageLayers : [];
	const pageSize = findAssetDimensions(page, context);

	if (textLayers.length === 0) {
		issues.push({
			id: `page-${pageIndex}-without-text`,
			code: "page_without_text",
			severity: "warning",
			messageCode: "page_without_text",
			messageValues: { page: pageIndex + 1 },
			pageIndex,
		});
	}

	issues.push(...checkDuplicateLayerIds(pageIndex, textLayers, "text"));
	const textLayerIdOccurrences = new Map<string, number>();
	for (const layer of textLayers) {
		issues.push(...checkTextLayer(pageIndex, layer, targetLang, duplicateLayerSuffix(layer.id, textLayerIdOccurrences)));
	}

	issues.push(...checkDuplicateLayerIds(pageIndex, imageLayers, "image"));
	const imageLayerIdOccurrences = new Map<string, number>();
	for (const layer of imageLayers) {
		issues.push(...checkImageLayer(pageIndex, layer, pageSize, context, duplicateLayerSuffix(layer.id, imageLayerIdOccurrences)));
	}

	for (const job of page.pendingAiJobs ?? []) {
		if (job.status === "error") {
			issues.push({
				id: `page-${pageIndex}-job-${job.jobId}-error`,
				code: "ai_job_failed",
				severity: "error",
				messageCode: "ai_job_failed",
				messageValues: { page: pageIndex + 1 },
				pageIndex,
			});
		} else if (job.status === "pending" || job.status === "processing") {
			issues.push({
				id: `page-${pageIndex}-job-${job.jobId}-pending`,
				code: "ai_job_pending",
				severity: "info",
				messageCode: "ai_job_pending",
				messageValues: { page: pageIndex + 1 },
				pageIndex,
			});
		}
	}

	return issues;
}

function taskImageMatchesPage(page: Page, task: WorkflowTask): boolean {
	if (!task.pageImageId) return true;
	return [page.imageId, page.edits?.imageId].filter(Boolean).includes(task.pageImageId);
}

function checkWorkflowTaskReference(project: ProjectState, task: WorkflowTask, targetLang: string): QcIssue[] {
	if (task.status === "done") return [];
	const page = project.pages[task.pageIndex];
	if (!page) {
		return [{
			id: `task-${safeIssueToken(task.id)}-missing-page`,
			code: "workflow_task_page_missing" as const,
			severity: "error" as const,
			messageCode: "workflow_task_page_missing" as const,
			messageValues: { taskTitle: task.title, page: task.pageIndex + 1 },
			taskId: task.id,
		}];
	}
	if (task.layerId && !pageHasLayerId(page, task.layerId, targetLang)) {
		return [{
			id: `page-${task.pageIndex}-task-${safeIssueToken(task.id)}-missing-layer`,
			code: "workflow_task_layer_missing" as const,
			severity: "error" as const,
			messageCode: "workflow_task_layer_missing" as const,
			messageValues: { page: task.pageIndex + 1, taskTitle: task.title, taskLayerId: task.layerId },
			pageIndex: task.pageIndex,
			taskId: task.id,
			layerId: task.layerId,
		}];
	}
	if (!taskImageMatchesPage(page, task)) {
		return [{
			id: `page-${task.pageIndex}-task-${safeIssueToken(task.id)}-stale-image`,
			code: "workflow_task_image_stale" as const,
			severity: "error" as const,
			messageCode: "workflow_task_image_stale" as const,
			messageValues: { page: task.pageIndex + 1, taskTitle: task.title },
			pageIndex: task.pageIndex,
			taskId: task.id,
		}];
	}
	return [];
}

function checkWorkflow(project: ProjectState, tasks: WorkflowTask[], targetLang: string): QcIssue[] {
	const incomplete = tasks.filter((task) => task.status !== "done");
	if (incomplete.length === 0) return [];

	const issues = incomplete.flatMap((task) => checkWorkflowTaskReference(project, task, targetLang));
	const pages = new Set(incomplete.map((task) => task.pageIndex + 1));
		issues.push({
			id: "workflow-incomplete",
			code: "workflow_incomplete",
			severity: "info",
			messageCode: "workflow_incomplete",
			messageValues: { taskCount: incomplete.length, pageCount: pages.size },
	});
	return issues;
}

function checkReviewDecisionReferences(project: ProjectState): QcIssue[] {
	return (project.reviewDecisions ?? [])
		.filter((decision) => !project.pages[decision.pageIndex])
		.map((decision) => ({
			id: `review-decision-${safeIssueToken(decision.id)}-missing-page`,
			code: "review_decision_page_missing" as const,
			severity: "warning" as const,
			messageCode: "review_decision_page_missing" as const,
			messageValues: { page: decision.pageIndex + 1 },
			reviewDecisionId: decision.id,
		}));
}

function checkOpenComments(project: ProjectState, comments: ProjectComment[]): QcIssue[] {
	const openComments = comments.filter((comment) => comment.status === "open" && hasProjectPage(project, comment.pageIndex));
	if (openComments.length === 0) return [];

	const byPage = new Map<number, number>();
	for (const comment of openComments) {
		byPage.set(comment.pageIndex, (byPage.get(comment.pageIndex) ?? 0) + 1);
	}

	return Array.from(byPage.entries()).map(([pageIndex, count]) => ({
		id: `page-${pageIndex}-open-comments`,
		code: "open_review_comments",
		severity: "warning",
		messageCode: "open_review_comments",
		messageValues: { page: pageIndex + 1, count },
		pageIndex,
	}));
}

function pageHasLayerId(page: Page | undefined, layerId: string, targetLang: string): boolean {
	if (!page) return false;
	// Text layers are per-language (active track); image layers are shared.
	const textLayers = trackTextLayers(page, targetLang);
	const imageLayers = Array.isArray(page.imageLayers) ? page.imageLayers : [];
	return textLayers.some((layer) => layer.id === layerId) || imageLayers.some((layer) => layer.id === layerId);
}

function checkCommentPages(project: ProjectState, comments: ProjectComment[]): QcIssue[] {
	return comments
		.filter((comment) => comment.status !== "resolved" && !hasProjectPage(project, comment.pageIndex))
		.map((comment) => ({
			id: `comment-${safeIssueToken(comment.id)}-missing-page`,
			code: "comment_page_missing" as const,
			severity: "warning" as const,
			messageCode: "comment_page_missing" as const,
			messageValues: { page: persistedPageNumber(comment.pageIndex) },
			commentId: comment.id,
		}));
}

function checkCommentAnchors(project: ProjectState, comments: ProjectComment[], targetLang: string): QcIssue[] {
	return comments
		.filter((comment) => comment.status === "open" && Boolean(comment.layerId))
		.filter((comment) => hasProjectPage(project, comment.pageIndex))
		.filter((comment) => !pageHasLayerId(project.pages[comment.pageIndex], comment.layerId!, targetLang))
		.map((comment) => ({
			id: `page-${comment.pageIndex}-comment-${safeIssueToken(comment.id)}-missing-anchor`,
			code: "comment_anchor_missing" as const,
			severity: "warning" as const,
			messageCode: "comment_anchor_missing" as const,
			messageValues: { page: comment.pageIndex + 1 },
			pageIndex: comment.pageIndex,
			commentId: comment.id,
			layerId: comment.layerId,
		}));
}

function checkAiReviewMarkers(project: ProjectState, markers: AiReviewMarker[], comments: ProjectComment[], tasks: WorkflowTask[]): QcIssue[] {
	return markers.flatMap((marker) => {
		const issues: QcIssue[] = [];
		const referenceIssue = marker.status === "applied" || marker.status === "rejected"
			? null
			: getAiMarkerReferenceIssue(project, marker);
		if (referenceIssue) {
			// Reconstruct the values the ai-marker-reference message needs so the
			// consumer renders the SAME sentence in every locale. The stale-image
			// variant compacts both the marker's bound image id and the page's
			// current image id (last expected id, "unknown" if none) — matching the
			// helper's `compactImageId(marker.imageId)` / `compactImageId(currentImage)`.
			const currentImageId = referenceIssue.expectedImageIds[referenceIssue.expectedImageIds.length - 1] ?? "unknown";
			issues.push({
				id: referenceIssue.problem === "missing-page"
					? `ai-marker-${safeIssueToken(marker.id)}-missing-page`
					: `page-${marker.pageIndex}-ai-marker-${safeIssueToken(marker.id)}-stale-image`,
				code: referenceIssue.problem === "missing-page"
					? "ai_marker_page_missing" as const
					: "ai_marker_image_stale" as const,
				severity: "error" as const,
				messageCode: referenceIssue.problem === "missing-page"
					? "ai_marker_page_missing" as const
					: "ai_marker_image_stale" as const,
				messageValues: referenceIssue.problem === "missing-page"
					? { page: marker.pageIndex + 1 }
					: {
						markerImageId: compactImageId(referenceIssue.markerImageId),
						page: marker.pageIndex + 1,
						currentImageId: compactImageId(currentImageId),
					},
				pageIndex: referenceIssue.problem === "missing-page" ? undefined : marker.pageIndex,
				markerId: marker.id,
			});
		}
		const linkedReferenceIssue = getAiMarkerLinkedReferenceIssue(marker, comments, tasks);
		if (linkedReferenceIssue) {
			if (linkedReferenceIssue.missingCommentIds.length) {
				const single = linkedReferenceIssue.missingCommentIds.length === 1;
				issues.push({
					id: `ai-marker-${safeIssueToken(marker.id)}-missing-linked-comments`,
					code: "ai_marker_comment_link_missing" as const,
					severity: "warning" as const,
					messageCode: single
						? "ai_marker_comment_link_missing_one" as const
						: "ai_marker_comment_link_missing_many" as const,
					messageValues: single
						? { commentId: linkedReferenceIssue.missingCommentIds[0] }
						: { count: linkedReferenceIssue.missingCommentIds.length },
					pageIndex: statePageIndex(project, marker.pageIndex),
					markerId: marker.id,
				});
			}
			if (linkedReferenceIssue.missingTaskIds.length) {
				const single = linkedReferenceIssue.missingTaskIds.length === 1;
				issues.push({
					id: `ai-marker-${safeIssueToken(marker.id)}-missing-linked-tasks`,
					code: "ai_marker_task_link_missing" as const,
					severity: "warning" as const,
					messageCode: single
						? "ai_marker_task_link_missing_one" as const
						: "ai_marker_task_link_missing_many" as const,
					messageValues: single
						? { taskLinkId: linkedReferenceIssue.missingTaskIds[0] }
						: { count: linkedReferenceIssue.missingTaskIds.length },
					pageIndex: statePageIndex(project, marker.pageIndex),
					markerId: marker.id,
				});
			}
		}
			if (marker.status === "failed") {
				issues.push({
					id: `page-${marker.pageIndex}-ai-marker-${marker.id}-failed`,
					code: "ai_marker_failed" as const,
					severity: "error" as const,
					messageCode: "ai_marker_failed" as const,
					messageValues: { page: marker.pageIndex + 1 },
				pageIndex: marker.pageIndex,
				markerId: marker.id,
			});
		}
		if (!referenceIssue && (marker.status === "needs_review" || marker.status === "retry_requested")) {
				issues.push({
					id: `page-${marker.pageIndex}-ai-marker-${marker.id}-review`,
					code: "ai_marker_needs_review" as const,
					severity: "warning" as const,
					messageCode: "ai_marker_needs_review" as const,
					messageValues: { page: marker.pageIndex + 1 },
				pageIndex: marker.pageIndex,
				markerId: marker.id,
			});
		}
		return issues;
	});
}

function statePageIndex(project: ProjectState, pageIndex: number): number | undefined {
	return project.pages[pageIndex] ? pageIndex : undefined;
}

export function buildProjectQcReport(
	project: ProjectState | null,
	tasks: WorkflowTask[] = [],
	comments: ProjectComment[] = [],
	aiReviewMarkers: AiReviewMarker[] = [],
	context: QcReportContext = {},
): QcReport {
	const checkedAt = new Date().toISOString();
	if (!project) {
		return {
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 0,
			checkedAt,
		};
	}

	const issues: QcIssue[] = [];
	if (!project.pages.length) {
		issues.push({
			id: "project-empty",
			code: "project_empty",
			severity: "warning",
			messageCode: "project_empty",
		});
	}

	// Per-language QC operates on the active Language Track. For legacy single-language
	// projects `activeTrack` resolves to `project.targetLang`, so this is unchanged.
	const targetLang = activeTrack(project);
	for (const [pageIndex, page] of project.pages.entries()) {
		issues.push(...checkPage(page, pageIndex, targetLang, context));
	}
	issues.push(...checkOpenComments(project, comments));
	issues.push(...checkCommentPages(project, comments));
	issues.push(...checkCommentAnchors(project, comments, targetLang));
	issues.push(...checkAiReviewMarkers(project, aiReviewMarkers, comments, tasks));
	issues.push(...checkWorkflow(project, tasks, targetLang));
	issues.push(...checkReviewDecisionReferences(project));

	return {
		issues,
		errorCount: countSeverity(issues, "error"),
		warningCount: countSeverity(issues, "warning"),
		infoCount: countSeverity(issues, "info"),
		pageCount: project.pages.length,
		checkedAt,
	};
}
