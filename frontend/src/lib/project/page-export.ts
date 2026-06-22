import * as api from "$lib/api/client.ts";
import { config } from "$lib/config.js";
import { resolveTextLayerEffectStyle, type ResolvedTextLayerPass, type ResolvedTextLayerShadow } from "$lib/project/text-effect-rendering.js";
import { resolveImageLayerSourceCrop } from "$lib/project/image-layer-source-crop.js";
import { createZipBlob, type ZipFileInput } from "$lib/project/zip-writer.js";
import { activeTrack, hasLanguageOutput, isDefaultTrack, trackImageLayers, trackTextLayers } from "$lib/project/language-tracks.js";
import type { ImageLayer, ImageLayerBlendMode, Page, ProjectState, TextLayer } from "$lib/types.js";

/**
 * The text layers to EXPORT for a page in a given Language Track.
 *
 * When `lang` is omitted (single-call / legacy callers) the page's flat
 * `page.textLayers` is returned verbatim so single-language exports stay
 * byte-identical. When `lang` is provided the page's per-language bucket is
 * resolved via `trackTextLayers` — exactly the resolver the editor renders with
 * (a materialized non-default track exports its OWN text; an un-materialized
 * track falls back to the seeded source layout, matching the on-canvas render).
 */
function resolveExportTextLayers(page: Page, lang?: string): TextLayer[] {
	if (lang === undefined) return page.textLayers ?? [];
	return trackTextLayers(page, lang);
}

/**
 * The image layers to EXPORT for a page in a given Language Track.
 *
 * Parity with the backend export pipeline's `resolveExportImageLayers`
 * (`backend/src/services/export-pipeline.ts`): when the active export track carries
 * an explicit `languageOutputs[lang].imageLayers` override, that per-language image
 * stack is composited; otherwise it falls back to the flat `page.imageLayers`. This
 * is the image-layer twin of `resolveExportTextLayers` above — single-call / legacy
 * callers (`lang === undefined`) get the flat array verbatim so single-language /
 * legacy projects export byte-identically, and a multi-track page without an image
 * override still falls back to the shared/source image stack (matching the server).
 */
function resolveExportImageLayers(page: Page, lang?: string): ImageLayer[] {
	if (lang === undefined) return page.imageLayers ?? [];
	return trackImageLayers(page, lang);
}

/**
 * Resolve the Language Track an export should render. Single-language / legacy
 * projects (one track) resolve to `undefined` so the flat `page.textLayers` path
 * is taken verbatim (byte-identical back-compat). Multi-track projects resolve to
 * the active track so each track exports its own per-language text.
 */
export function resolveExportLang(
	project: Pick<ProjectState, "targetLang" | "targetLangs" | "activeTargetLang">,
): string | undefined {
	const langs = project.targetLangs;
	if (!Array.isArray(langs) || langs.length <= 1) return undefined;
	return activeTrack(project);
}

/**
 * Raised by `exportPagesToZip` when an EXPLICIT, non-default Language Track is
 * requested but some of the selected pages carry no per-language output for it.
 *
 * This is the CLIENT-side parity of the backend's `MissingLanguageOutputError`
 * (`backend/src/services/export-pipeline.ts`). The backend blocks `enqueueExportJob`
 * in exactly this situation; the client ZIP path used to silently fall through
 * `trackTextLayers(...)` to the flat/source layout and export the WRONG language
 * with no warning. Both sides now agree: the default/source track is always
 * exportable, but an explicit non-default track requires a real output per page.
 */
export class MissingLanguageOutputError extends Error {
	readonly targetLang: string;
	/** 1-based page numbers (UI-facing) that lack an output for `targetLang`. */
	readonly pageNumbers: number[];

	constructor(targetLang: string, pageNumbers: number[]) {
		const count = pageNumbers.length;
		super(
			`No "${targetLang}" language output for ${count} requested page${count === 1 ? "" : "s"}: ${pageNumbers.join(", ")}`,
		);
		this.name = "MissingLanguageOutputError";
		this.targetLang = targetLang;
		this.pageNumbers = pageNumbers;
	}
}

/**
 * The plan items whose page has no real output for an EXPLICIT non-default track.
 *
 * Mirrors the backend's `findMissingLanguageOutputImageIds` contract: returns `[]`
 * for the omitted/default/single-language case (never blocks it); for an explicit
 * non-default track it flags every page lacking a `languageOutputs[lang]` record.
 */
function findMissingLanguageOutputPages(
	project: ProjectState,
	plan: PageExportPlanItem[],
	lang: string | undefined,
): PageExportPlanItem[] {
	if (!lang || isDefaultTrack(project, lang)) return [];
	return plan.filter((item) => !hasLanguageOutput(project.pages[item.pageIndex], lang));
}

const DEFAULT_TEXT_FILL = "#111111";
const DEFAULT_TEXT_STROKE = "#ffffff";
const EXPORT_LINE_HEIGHT = 1.12;
const MAX_FILENAME_SEGMENT_LENGTH = 96;
const WORKSPACE_DEBUG_PROJECT_ID = "flow208-project";
const DEBUG_EXPORT_PAGE_LABELS = ["Moonlit Courier P01", "Moonlit Courier P02"];

export class PageExportError extends Error {
	readonly pageIndex: number;
	readonly pageNumber: number;
	readonly cause?: unknown;

	constructor(pageIndex: number, pageNumber: number, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause ?? "unknown render failure");
		super(`Export หน้า ${pageNumber} ล้มเหลว: ${reason}`);
		this.name = "PageExportError";
		this.pageIndex = pageIndex;
		this.pageNumber = pageNumber;
		this.cause = cause;
	}
}

/**
 * P1-c (docs/specs/non-destructive-edit-layers.md) — a VISIBLE non-destructive edit
 * layer (bubble-clean) whose mask asset is missing/unreadable could not be composited.
 * For a `publish` export this must FAIL the page (never silently ship the un-cleaned
 * source as if the clean happened); for a `draft` export it is recorded + flagged but
 * allowed through. Thrown by `composeEditLayersOntoExportCanvas`.
 */
export class EditLayerCompositeError extends Error {
	readonly maskAssetId: string;
	constructor(maskAssetId: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause ?? "unknown");
		super(`Edit-layer mask ${maskAssetId} could not be composited: ${reason}`);
		this.name = "EditLayerCompositeError";
		this.maskAssetId = maskAssetId;
	}
}

const IMAGE_LAYER_BLEND_MODES: readonly ImageLayerBlendMode[] = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"soft-light",
];

function normalizeImageLayerBlendMode(value: ImageLayer["blendMode"]): ImageLayerBlendMode {
	return IMAGE_LAYER_BLEND_MODES.includes(value as ImageLayerBlendMode)
		? (value as ImageLayerBlendMode)
		: "normal";
}

function imageLayerBlendModeToCompositeOperation(value: ImageLayer["blendMode"]): string {
	const blendMode = normalizeImageLayerBlendMode(value);
	return blendMode === "normal" ? "source-over" : blendMode;
}

type FabricModule = typeof import("fabric");

let fabricModulePromise: Promise<FabricModule> | null = null;

export interface PageExportPlanItem {
	pageIndex: number;
	pageNumber: number;
	imageId: string;
	sourceName: string;
	baseName: string;
	filename: string;
	layerCount: number;
}

export interface PageExportProgress {
	completed: number;
	total: number;
	pageIndex: number;
	pageNumber: number;
	filename: string;
	/**
	 * Coarse phase of the export. "rendering" = still rasterizing pages;
	 * "packaging" = all pages are rendered and the (synchronous, ~1s on a full-res
	 * chapter) ZIP assembly is running. Callers should NOT treat completed/total
	 * reaching parity during "rendering" as "done" — the UI must stay in a
	 * "packaging…" state until the blob is actually ready, otherwise it shows 100%
	 * and then visibly freezes during createZipBlob.
	 */
	phase: "rendering" | "packaging";
}

export interface PageExportManifestPage extends PageExportPlanItem {
	width: number;
	height: number;
	/**
	 * How the page was rendered: "full" = background + all layers composited;
	 * "source-only" = layer compositing failed, so only the raw/edited source image
	 * was included (an honest fallback rather than dropping the page entirely).
	 */
	renderMode: PageExportRenderMode;
	/** When renderMode is "source-only", why compositing was skipped. */
	renderNote?: string;
	layers: PageExportManifestLayer[];
	/**
	 * Present when the page was SPLIT into vertical slices for web delivery: the
	 * ZIP carries these slice files (top→bottom order) INSTEAD of `filename`.
	 */
	slices?: Array<{ filename: string; height: number }>;
}

export type PageExportRenderMode = "full" | "source-only";

export interface PageExportSkippedPage {
	pageIndex: number;
	pageNumber: number;
	imageId: string;
	sourceName: string;
	filename: string;
	/** Human-readable reason the page could not be rendered. */
	reason: string;
}

export interface PageExportManifest {
	projectId: string;
	projectName: string;
	exportedAt: string;
	/** Pages successfully included in the ZIP (full composite or source-only fallback). */
	pageCount: number;
	/** Pages that were requested in the export plan, including the skipped ones. */
	requestedPageCount: number;
	pages: PageExportManifestPage[];
	/** Pages that could not be rendered at all and were left out of the ZIP. */
	skippedPages: PageExportSkippedPage[];
}

export type PageExportLayerStackEntry =
	| { kind: "image"; id: string; layer: ImageLayer; zIndex: number }
	| { kind: "text"; id: string; layer: TextLayer; zIndex: number };

export interface PageExportManifestLayer {
	kind: "image" | "text";
	id: string;
	name: string;
	role?: string;
	sourceCategory?: string;
	sourceProvider?: string;
	zIndex: number;
	visible: boolean;
	opacity?: number;
	effectsSummary?: {
		stroke?: boolean;
		outerGlow?: boolean;
		dropShadow?: boolean;
		passCount?: number;
		accentShadowCount?: number;
	};
}

export interface ExportPagesToZipOptions {
	onProgress?: (progress: PageExportProgress) => void;
	exportedAt?: Date;
	imageUrlResolver?: (imageId: string, pageNumber?: number) => string | null | undefined;
	/**
	 * P1-c — export fidelity. `"publish"` (the DEFAULT) fails a page when a VISIBLE
	 * edit-layer (bubble-clean) mask is missing/unreadable, so a deliverable export can
	 * never silently ship the un-cleaned source. `"draft"` lets the page through (raw
	 * source-only fallback) but flags it in the manifest renderNote. Maps from the
	 * caller's ExportProfileId: "public-export" -> publish, "draft-internal" -> draft.
	 */
	exportProfile?: "publish" | "draft";
	/**
	 * Optional vertical split for web delivery (webtoon): each rendered page is
	 * cut into slices selected EITHER by target height-per-piece OR by piece
	 * count — both clamped to the enforced minimums (see
	 * {@link EXPORT_SPLIT_MIN_HEIGHT} / {@link EXPORT_SPLIT_MAX_PIECES}). A page
	 * whose effective slice height covers it stays a single file; a slicing
	 * failure falls back to the UNSPLIT page with a manifest renderNote rather
	 * than dropping the page.
	 */
	split?: ExportSplitOptions;
}

export interface ExportSplitOptions {
	mode: "height" | "count";
	/** mode="height": target pixel height per slice. */
	heightPerPiece?: number;
	/** mode="count": target slice count per page. */
	pieceCount?: number;
}

/** Enforced minimum slice height — a smaller request is clamped UP (fewer pieces). */
export const EXPORT_SPLIT_MIN_HEIGHT = 200;
/** Hard per-page slice-count ceiling (abuse/perf bound; count requests clamp DOWN). */
export const EXPORT_SPLIT_MAX_PIECES = 200;

/**
 * Pure slice planning: the EFFECTIVE slice height for a page, or null when the
 * request doesn't actually split it (no/invalid value, or one slice covers the
 * page). Both modes enforce the minimum slice height; count mode additionally
 * clamps the requested count into [2, EXPORT_SPLIT_MAX_PIECES].
 */
export function planExportSliceHeight(pageHeight: number, split: ExportSplitOptions | undefined): number | null {
	if (!split || !Number.isFinite(pageHeight) || pageHeight <= 0) return null;
	let sliceHeight: number;
	if (split.mode === "height") {
		const target = Math.trunc(split.heightPerPiece ?? 0);
		if (!Number.isFinite(target) || target <= 0) return null;
		sliceHeight = Math.max(EXPORT_SPLIT_MIN_HEIGHT, target);
	} else {
		const requested = Math.trunc(split.pieceCount ?? 0);
		if (!Number.isFinite(requested) || requested <= 1) return null;
		const count = Math.min(requested, EXPORT_SPLIT_MAX_PIECES);
		sliceHeight = Math.max(EXPORT_SPLIT_MIN_HEIGHT, Math.ceil(pageHeight / count));
	}
	// Absolute piece-count ceiling regardless of mode.
	sliceHeight = Math.max(sliceHeight, Math.ceil(pageHeight / EXPORT_SPLIT_MAX_PIECES));
	return sliceHeight >= pageHeight ? null : sliceHeight;
}

/**
 * Concrete slice heights for a page (top→bottom). A runt tail shorter than
 * {@link EXPORT_SPLIT_MIN_HEIGHT} is FOLDED into the previous slice (same
 * behavior as the backend's splitTallImage) so every emitted slice honors the
 * advertised minimum — e.g. 1001px at 201px chunks yields [201,201,201,398],
 * never a 197px sliver.
 */
export function planExportSliceBoundaries(pageHeight: number, sliceHeight: number): number[] {
	const heights: number[] = [];
	for (let top = 0; top < pageHeight; top += sliceHeight) {
		heights.push(Math.min(sliceHeight, pageHeight - top));
	}
	if (heights.length > 1 && heights[heights.length - 1]! < EXPORT_SPLIT_MIN_HEIGHT) {
		const tail = heights.pop()!;
		heights[heights.length - 1]! += tail;
	}
	return heights;
}

/** `page-001.png` + slice index → `page-001.003.png` (top→bottom order). */
function sliceFilename(filename: string, sliceIndex: number): string {
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	return `${stem}.${String(sliceIndex + 1).padStart(3, "0")}${ext}`;
}

/**
 * Cut a rendered page blob into vertical slices. Browser-only (canvas); the
 * caller treats a throw as "fall back to the unsplit page".
 */
async function sliceRenderedPageBlob(
	blob: Blob,
	width: number,
	height: number,
	sliceHeight: number,
	filename: string,
): Promise<Array<{ filename: string; blob: Blob; height: number }>> {
	const bitmap = await createImageBitmap(blob);
	try {
		const slices: Array<{ filename: string; blob: Blob; height: number }> = [];
		let top = 0;
		const heights = planExportSliceBoundaries(height, sliceHeight);
		for (let sliceIndex = 0; sliceIndex < heights.length; sliceIndex += 1) {
			const chunkHeight = heights[sliceIndex]!;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = chunkHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas 2D context unavailable for export split");
			ctx.drawImage(bitmap, 0, top, width, chunkHeight, 0, 0, width, chunkHeight);
			const sliceBlob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("Slice encode failed"))), "image/png");
			});
			slices.push({ filename: sliceFilename(filename, sliceIndex), blob: sliceBlob, height: chunkHeight });
			top += chunkHeight;
		}
		return slices;
	} finally {
		bitmap.close?.();
	}
}

export interface ExportPagesToZipResult {
	zipBlob: Blob;
	filename: string;
	manifest: PageExportManifest;
	exportedPages: PageExportManifestPage[];
	/** Pages that failed to render and were left out of the ZIP (honest partial export). */
	skippedPages: PageExportSkippedPage[];
	/** Pages included only as their raw source image because layer compositing failed. */
	sourceOnlyPages: PageExportManifestPage[];
}

async function loadFabric(): Promise<FabricModule> {
	if (!fabricModulePromise) {
		fabricModulePromise = import("fabric");
	}
	return fabricModulePromise;
}

export function sanitizeExportSegment(value: string): string {
	const safe = value
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^[-. ]+|[-. ]+$/g, "")
		.slice(0, MAX_FILENAME_SEGMENT_LENGTH)
		.trim();
	return safe || "page";
}

function stripExtension(name: string): string {
	return name.replace(/\.[^.]+$/, "");
}

function getPageSourceName(page: Page, pageIndex: number): string {
	return page.originalName || page.imageName || `page_${pageIndex + 1}`;
}

export function getPageExportBaseName(page: Page, pageIndex: number): string {
	return sanitizeExportSegment(stripExtension(getPageSourceName(page, pageIndex)));
}

export function buildBatchExportFilename(project: ProjectState, pageCount: number, exportedAt = new Date()): string {
	const projectName = sanitizeExportSegment(project.name || "chapter");
	const timestamp = exportedAt.toISOString().slice(0, 19).replace(/[T:]/g, "-");
	return `${projectName}_${pageCount}p_${timestamp}.zip`;
}

export function buildPageExportPlan(project: ProjectState, pageIndexes: number[], lang?: string): PageExportPlanItem[] {
	const validIndexes: number[] = [];
	const seenIndexes = new Set<number>();

	for (const pageIndex of pageIndexes) {
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= project.pages.length) continue;
		if (seenIndexes.has(pageIndex)) continue;
		seenIndexes.add(pageIndex);
		validIndexes.push(pageIndex);
	}

	const usedBaseNames = new Map<string, number>();
	return validIndexes.map((pageIndex) => {
		const page = project.pages[pageIndex];
		const baseName = getPageExportBaseName(page, pageIndex);
		const duplicateIndex = usedBaseNames.get(baseName) ?? 0;
		usedBaseNames.set(baseName, duplicateIndex + 1);

		const pagePrefix = String(pageIndex + 1).padStart(3, "0");
		const duplicateSuffix = duplicateIndex > 0 ? `-${duplicateIndex + 1}` : "";
		return {
			pageIndex,
			pageNumber: pageIndex + 1,
			imageId: page.edits?.imageId || page.imageId,
			sourceName: getPageSourceName(page, pageIndex),
			baseName,
			filename: `${pagePrefix}_${baseName}${duplicateSuffix}_merged.png`,
			layerCount: [
				...resolveExportImageLayers(page, lang).filter((layer) => layer.visible !== false),
				...resolveExportTextLayers(page, lang).filter((layer) => layer.visible !== false),
			].length,
		};
	});
}

function clampPositive(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.max(1, value);
}

function getLayerBaseStrokeWidth(layer: TextLayer): number {
	const strokeEffect = layer.effects?.stroke;
	if (strokeEffect?.enabled) return Math.max(0, strokeEffect.width);
	if (typeof layer.strokeWidth === "number") return Math.max(0, layer.strokeWidth);
	const fontSize = layer.fontSize || config.defaultFontSize;
	return Math.max(1, Math.min(4, Math.round(fontSize * 0.08)));
}

function layerStackIndex(value: unknown, fallback: number): number {
	const zIndex = Number(value);
	return Number.isFinite(zIndex) ? zIndex : fallback;
}

export function buildPageExportLayerStack(page: Page, lang?: string): PageExportLayerStackEntry[] {
	const imageLayers = resolveExportImageLayers(page, lang);
	const imageEntries = imageLayers.map((layer, index) => ({
		kind: "image" as const,
		id: layer.id,
		layer,
		zIndex: layerStackIndex(layer.zIndex, index),
	}));
	const textEntries = resolveExportTextLayers(page, lang).map((layer, index) => ({
		kind: "text" as const,
		id: layer.id,
		layer,
		zIndex: layerStackIndex(layer.zIndex, imageLayers.length + index),
	}));
	return [...imageEntries, ...textEntries]
		.filter((entry) => entry.layer.visible !== false)
		.sort((a, b) => a.zIndex - b.zIndex || (a.kind === "image" ? -1 : 1));
}

function summarizeTextLayerEffects(layer: TextLayer): PageExportManifestLayer["effectsSummary"] | undefined {
	const effects = layer.effects;
	const stroke = Boolean(effects?.stroke?.enabled || (layer.strokeWidth ?? 0) > 0);
	const outerGlow = Boolean(effects?.outerGlow?.enabled);
	const dropShadow = Boolean(effects?.dropShadow?.enabled);
	const passCount = effects?.passes?.filter((pass) => pass.enabled !== false).length ?? 0;
	const accentShadowCount = effects?.accentShadows?.filter((shadow) => shadow.enabled !== false).length ?? 0;
	if (!stroke && !outerGlow && !dropShadow && passCount === 0 && accentShadowCount === 0) return undefined;
	return {
		stroke,
		outerGlow,
		dropShadow,
		passCount,
		accentShadowCount,
	};
}

export function buildPageExportManifestLayers(page: Page, lang?: string): PageExportManifestLayer[] {
	return buildPageExportLayerStack(page, lang).map((entry) => {
		if (entry.kind === "image") {
			return {
				kind: "image",
				id: entry.id,
				name: entry.layer.name || entry.layer.originalName || entry.layer.imageName || entry.id,
				role: entry.layer.role ?? "overlay",
				sourceCategory: entry.layer.aiMarkerId || entry.id.startsWith("ai-result-") ? "ai-result" : entry.layer.role ?? "overlay",
				zIndex: entry.zIndex,
				visible: entry.layer.visible !== false,
				opacity: entry.layer.opacity,
			};
		}

		return {
			kind: "text",
			id: entry.id,
			name: entry.layer.name || entry.layer.text.slice(0, 48) || entry.id,
			role: entry.layer.sourceCategory ?? "text",
			sourceCategory: entry.layer.sourceCategory ?? "other",
			sourceProvider: entry.layer.sourceProvider,
			zIndex: entry.zIndex,
			visible: entry.layer.visible !== false,
			opacity: entry.layer.opacity ?? 1,
			effectsSummary: summarizeTextLayerEffects(entry.layer),
		};
	});
}

function canUseDebugExportImage(projectId: string, imageId: string): boolean {
	return projectId === WORKSPACE_DEBUG_PROJECT_ID
		&& /^flow208-page-\d+/.test(imageId)
		&& (import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.VITE_E2E === "1");
}

function createDebugExportImageDataUrl(label: string, fill = "#f8f5ef"): string {
	if (typeof document === "undefined") return "";
	const canvas = document.createElement("canvas");
	canvas.width = 900;
	canvas.height = 1350;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	const panel = (x: number, y: number, w: number, h: number, bg: string) => {
		ctx.fillStyle = bg;
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = "#10131a";
		ctx.lineWidth = 7;
		ctx.strokeRect(x, y, w, h);
	};
	ctx.fillStyle = "#1f222b";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = fill;
	ctx.fillRect(54, 54, 792, 1242);
	ctx.strokeStyle = "#111827";
	ctx.lineWidth = 10;
	ctx.strokeRect(54, 54, 792, 1242);

	panel(96, 96, 708, 342, "#d8dde8");
	const gradient = ctx.createLinearGradient(96, 96, 804, 438);
	gradient.addColorStop(0, "rgba(255,255,255,0.55)");
	gradient.addColorStop(0.6, "rgba(98,112,142,0.24)");
	gradient.addColorStop(1, "rgba(20,24,34,0.35)");
	ctx.fillStyle = gradient;
	ctx.fillRect(96, 96, 708, 342);
	ctx.strokeStyle = "rgba(17,24,39,0.45)";
	ctx.lineWidth = 3;
	for (let x = 110; x < 790; x += 34) {
		ctx.beginPath();
		ctx.moveTo(x, 98);
		ctx.lineTo(x - 90, 438);
		ctx.stroke();
	}
	panel(96, 474, 330, 560, "#eef1f5");
	ctx.fillStyle = "#c6cedb";
	ctx.beginPath();
	ctx.arc(262, 680, 110, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = "#909bac";
	ctx.fillRect(190, 780, 150, 190);
	ctx.strokeStyle = "#111827";
	ctx.lineWidth = 6;
	ctx.strokeRect(190, 780, 150, 190);
	ctx.fillStyle = "rgba(255,255,255,0.94)";
	ctx.strokeStyle = "#111827";
	ctx.lineWidth = 5;
	ctx.beginPath();
	ctx.roundRect(138, 520, 230, 118, 34);
	ctx.fill();
	ctx.stroke();
	ctx.beginPath();
	ctx.roundRect(470, 148, 264, 110, 34);
	ctx.fill();
	ctx.stroke();
	panel(474, 474, 330, 560, "#dfe5ed");
	ctx.save();
	ctx.translate(640, 720);
	ctx.rotate(-0.22);
	ctx.fillStyle = "rgba(255,255,255,0.9)";
	ctx.fillRect(-142, -60, 284, 132);
	ctx.strokeStyle = "#172033";
	ctx.lineWidth = 5;
	ctx.strokeRect(-142, -60, 284, 132);
	ctx.fillStyle = "#111827";
	ctx.font = "30px Arial";
	ctx.fillText("NEW MAIL", -108, -16);
	ctx.font = "24px Arial";
	ctx.fillText("Meet me at gate 7.", -108, 26);
	ctx.restore();
	panel(96, 1078, 708, 160, "#f7f8fb");
	ctx.fillStyle = "#111827";
	ctx.font = "36px Arial";
	ctx.fillText(label, 126, 1162);
	ctx.font = "24px Arial";
	ctx.fillStyle = "#4b5563";
	ctx.fillText("หน้าต้นฉบับของตอน", 126, 1204);
	return canvas.toDataURL("image/png");
}

function resolveExportImageUrl(
	projectId: string,
	imageId: string,
	pageNumber?: number,
	imageUrlResolver?: ExportPagesToZipOptions["imageUrlResolver"],
): string {
	const resolved = imageUrlResolver?.(imageId, pageNumber);
	if (resolved) return resolved;
	if (canUseDebugExportImage(projectId, imageId)) {
		const match = imageId.match(/(\d+)/);
		const parsedNumber = Number.parseInt(match?.[1] ?? "1", 10);
		const number = pageNumber ?? (Number.isFinite(parsedNumber) ? parsedNumber : 1);
		return createDebugExportImageDataUrl(DEBUG_EXPORT_PAGE_LABELS[number - 1] ?? `Moonlit Courier P${number}`, number === 1 ? "#f8f5ef" : "#f1f7f4");
	}
	return api.imageUrl(projectId, imageId);
}

function createExportTextObject(
	fabric: FabricModule,
	layer: TextLayer,
	shadow?: ResolvedTextLayerShadow | null,
	pass?: ResolvedTextLayerPass | null,
): unknown {
	const TextClass = fabric.Textbox ?? fabric.IText;
	const fontSize = clampPositive(layer.fontSize, config.defaultFontSize);
	const boxWidth = clampPositive(layer.w, fontSize * 4);
	const boxHeight = clampPositive(layer.h, fontSize * EXPORT_LINE_HEIGHT);
	const resolved = resolveTextLayerEffectStyle(layer, DEFAULT_TEXT_STROKE, getLayerBaseStrokeWidth(layer));
	const textObject = new TextClass(layer.text || "", {
		left: layer.x + boxWidth / 2,
		top: layer.y + boxHeight / 2,
		...(pass ? {
			left: layer.x + boxWidth / 2 + pass.offsetX,
			top: layer.y + boxHeight / 2 + pass.offsetY,
		} : {}),
		width: boxWidth,
		height: boxHeight,
		angle: layer.rotation || 0,
		opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)) * (pass?.opacity ?? 1),
		fontSize,
		charSpacing: layer.charSpacing ?? 0,
		skewX: layer.skewX ?? 0,
		skewY: layer.skewY ?? 0,
		fontFamily: layer.fontFamily || config.defaultFontFamily,
		fill: pass?.fill ?? layer.fill ?? DEFAULT_TEXT_FILL,
		stroke: pass?.stroke ?? resolved.stroke,
		strokeWidth: pass?.strokeWidth ?? resolved.strokeWidth,
		paintFirst: "stroke",
		textAlign: layer.alignment || "center",
		lineHeight: EXPORT_LINE_HEIGHT,
		splitByGrapheme: true,
		originX: "center",
		originY: "center",
		editable: false,
		selectable: false,
		evented: false,
	});

	if (fabric.Shadow && shadow) {
		textObject.set({
			shadow: new fabric.Shadow({
				color: shadow.color,
				offsetX: shadow.offsetX,
				offsetY: shadow.offsetY,
				blur: shadow.blur,
			}),
		});
	}

	return textObject;
}

function createExportTextObjects(fabric: FabricModule, layer: TextLayer): unknown[] {
	const resolved = resolveTextLayerEffectStyle(layer, DEFAULT_TEXT_STROKE, getLayerBaseStrokeWidth(layer));
	const stackPasses = resolved.passes.map((pass) => createExportTextObject(fabric, layer, pass.shadow, pass));
	const shadowPasses = resolved.shadows.length > 1
		? resolved.shadows.map((shadow) => createExportTextObject(fabric, layer, shadow))
		: [];
	const primaryShadow = resolved.shadows.length <= 1 ? resolved.shadow : null;
	return [...stackPasses, ...shadowPasses, createExportTextObject(fabric, layer, primaryShadow)];
}

async function createExportImageObject(
	fabric: FabricModule,
	projectId: string,
	layer: ImageLayer,
	imageUrlResolver?: ExportPagesToZipOptions["imageUrlResolver"],
): Promise<unknown> {
	// EXPORT-purpose fetch (codex P1-A): a visible image layer asset is fetched
	// through the server's export serve-gate (moderation must be `passed`), so a
	// non-`passed` overlay can never enter the client-built ZIP. The server is the
	// authority; the client batch gate stays as defense-in-depth.
	const image = await api.loadExportFabricImage(
		fabric,
		projectId,
		layer.imageId,
		resolveExportImageUrl(projectId, layer.imageId, undefined, imageUrlResolver),
		{ crossOrigin: "anonymous" },
	) as any;
	const naturalWidth = Math.max(1, image.width ?? 1);
	const naturalHeight = Math.max(1, image.height ?? 1);
	// Same source-crop math as the live render + single-page export
	// (canvas/editor.ts) via the shared dependency-clean helper, so an AI result
	// stored as a FULL-PAGE composite paints back ONLY over its crop region in the
	// batch/zip export too — never the whole page squeezed into the box.
	const cropPlacement = resolveImageLayerSourceCrop({
		sourceCrop: layer.sourceCrop,
		naturalWidth,
		naturalHeight,
		targetWidth: layer.w,
		targetHeight: layer.h,
	});
	image.set({
		left: layer.x + layer.w / 2,
		top: layer.y + layer.h / 2,
		angle: layer.rotation || 0,
		opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
		flipX: layer.flipX === true,
		flipY: layer.flipY === true,
		globalCompositeOperation: imageLayerBlendModeToCompositeOperation(layer.blendMode),
		originX: "center",
		originY: "center",
		selectable: false,
		evented: false,
	});
	if (cropPlacement.crop) {
		// Fabric.js v6 source-crop: cropX/cropY pick the sub-rect origin and
		// width/height the sub-rect size in the source element's pixels.
		image.set({
			cropX: cropPlacement.crop.x,
			cropY: cropPlacement.crop.y,
			width: cropPlacement.crop.w,
			height: cropPlacement.crop.h,
		});
	}
	image.scaleX = cropPlacement.scaleX;
	image.scaleY = cropPlacement.scaleY;
	return image;
}

function dataUrlToBlob(dataUrl: string): Blob {
	const [metadata, base64] = dataUrl.split(",");
	const mime = metadata.match(/^data:([^;]+)/)?.[1] || "image/png";
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes], { type: mime });
}

function getOriginalImageSize(image: any): { width: number; height: number } {
	const originalSize = typeof image.getOriginalSize === "function" ? image.getOriginalSize() : null;
	return {
		width: Math.max(1, Math.round(originalSize?.width ?? image.width ?? image.getScaledWidth?.() ?? 1)),
		height: Math.max(1, Math.round(originalSize?.height ?? image.height ?? image.getScaledHeight?.() ?? 1)),
	};
}

function imageLayerDisplayName(layer: ImageLayer): string {
	return layer.name || layer.originalName || layer.imageName || layer.id || "รูปเสริม";
}

function assertVisibleImageLayerAssets(project: ProjectState, item: PageExportPlanItem, lang?: string): void {
	const page = project.pages[item.pageIndex];
	const missingLayer = resolveExportImageLayers(page, lang).find((layer) => (
		layer.visible !== false && !layer.imageId?.trim()
	));
	if (!missingLayer) return;
	throw new Error(`หน้า ${item.pageNumber} รูปเสริม ${imageLayerDisplayName(missingLayer)} ไม่มี image asset ID`);
}

function waitForUiYield(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => resolve());
			return;
		}
		setTimeout(resolve, 0);
	});
}

interface RenderedPage {
	blob: Blob;
	width: number;
	height: number;
	renderMode: PageExportRenderMode;
	renderNote?: string;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error ?? "unknown render failure");
}

/**
 * Flatten the (already-loaded) background plus any compositing layers onto a
 * StaticCanvas and return the PNG. If `includeLayers` is false (the source-only
 * fallback), only the background image is rendered.
 */
function rasterizeBackground(
	fabric: FabricModule,
	background: any,
	width: number,
	height: number,
): { canvas: any; dispose: () => void } {
	const exportCanvasEl = document.createElement("canvas");
	const exportCanvas = new fabric.StaticCanvas(exportCanvasEl, {
		width,
		height,
		enableRetinaScaling: false,
	});
	background.set({
		left: 0,
		top: 0,
		originX: "left",
		originY: "top",
		selectable: false,
		evented: false,
	});
	background.scaleToWidth(width);
	if (background.getScaledHeight && Math.abs(background.getScaledHeight() - height) > 0.5) {
		background.scaleToHeight(height);
	}
	exportCanvas.add(background);
	return { canvas: exportCanvas, dispose: () => exportCanvas.dispose() };
}

/**
 * Phase A non-destructive edits — composite the page's `fill-mask` edit layers
 * (bubble-clean) onto the export canvas, ANCHORED in native image-pixel space,
 * BEFORE any image/text layers. Each layer paints its solid `fill` clipped by the
 * tiny alpha-mask asset at its bbox. This mirrors the live editor + the backend
 * Sharp compositor (same bbox + alpha) so the cleaned area appears identically in
 * the exported image. No edit layers => no-op.
 *
 * P1-c (docs/specs/non-destructive-edit-layers.md) — a VISIBLE edit layer whose mask
 * asset can NOT be loaded is a compositing FAILURE: it throws {@link EditLayerCompositeError}
 * so the caller fails the page (publish) or flags + falls back (draft). It must NOT be
 * silently skipped, which would ship the un-cleaned source as if the clean had applied.
 */
async function composeEditLayersOntoExportCanvas(
	fabric: FabricModule,
	exportCanvas: any,
	projectId: string,
	page: Page,
	width: number,
	height: number,
	imageUrlResolver?: ExportPagesToZipOptions["imageUrlResolver"],
): Promise<void> {
	if (typeof document === "undefined") return;
	const composableKinds = new Set(["fill-mask", "patch", "healing", "clone"]);
	const layers = (page.imageEditLayers ?? [])
		.filter((layer) => layer.visible !== false && composableKinds.has(layer.payload?.type))
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	if (layers.length === 0) return;

	const overlay = document.createElement("canvas");
	overlay.width = width;
	overlay.height = height;
	const octx = overlay.getContext("2d");
	if (!octx) return;
	let painted = false;
	for (const layer of layers) {
		const bbox = layer.bbox;
		const w = Math.max(0, Math.round(bbox.w));
		const h = Math.max(0, Math.round(bbox.h));
		if (w <= 0 || h <= 0) continue;
		const payload = layer.payload;
		if (payload.type === "fill-mask") {
			try {
				const maskUrl = resolveExportImageUrl(projectId, payload.maskAssetId, undefined, imageUrlResolver);
				// EXPORT-purpose fetch (codex P1-A): the edit-layer mask asset goes
				// through the server export serve-gate (must be `passed`) so a
				// non-`passed` mask can't enter a client export render.
				const maskImg = await api.loadExportFabricImage(fabric, projectId, payload.maskAssetId, maskUrl, { crossOrigin: "anonymous" }) as any;
				const maskEl = typeof maskImg.getElement === "function" ? maskImg.getElement() : maskImg._element;
				if (!maskEl) continue;
				const roi = document.createElement("canvas");
				roi.width = w;
				roi.height = h;
				const rctx = roi.getContext("2d");
				if (!rctx) continue;
				rctx.drawImage(maskEl as CanvasImageSource, 0, 0, w, h);
				const maskData = rctx.getImageData(0, 0, w, h);
				const out = rctx.createImageData(w, h);
				const md = maskData.data;
				const od = out.data;
				const { r, g, b } = payload.fill;
				for (let i = 0; i < w * h; i++) {
					const o = i * 4;
					od[o] = r;
					od[o + 1] = g;
					od[o + 2] = b;
					od[o + 3] = md[o + 3]; // png-alpha coverage
				}
				rctx.putImageData(out, 0, 0);
				octx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
				octx.drawImage(roi, Math.round(bbox.x), Math.round(bbox.y));
				octx.globalAlpha = 1;
				painted = true;
			} catch (error) {
				// P1-c — a visible edit-layer mask that won't load is NOT a benign skip: it
				// means the cleaned dialogue would be MISSING from the export while the rest
				// of the clean (and the source text) ships. Fail it up to the caller, which
				// fails the page for publish or flags it for draft.
				throw new EditLayerCompositeError(payload.maskAssetId, error);
			}
		} else {
			// Phase B — patch / healing / clone: composite the REALIZED RGBA ROI asset at
			// bbox verbatim (its alpha already carries the brush coverage), matching the
			// live editor + backend Sharp compositor.
			const patchAssetId =
				payload.type === "patch" ? payload.patchAssetId : payload.realizedPatchAssetId;
			try {
				const patchUrl = resolveExportImageUrl(projectId, patchAssetId, undefined, imageUrlResolver);
				// EXPORT-purpose fetch (codex P1-A): the realized patch asset goes
				// through the server export serve-gate (must be `passed`).
				const patchImg = await api.loadExportFabricImage(fabric, projectId, patchAssetId, patchUrl, { crossOrigin: "anonymous" }) as any;
				const patchEl = typeof patchImg.getElement === "function" ? patchImg.getElement() : patchImg._element;
				if (!patchEl) continue;
				octx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
				octx.drawImage(patchEl as CanvasImageSource, Math.round(bbox.x), Math.round(bbox.y), w, h);
				octx.globalAlpha = 1;
				painted = true;
			} catch (error) {
				// P1-c — a visible realized-patch asset that won't load means the edit would
				// be MISSING from the export. Fail it up to the caller (publish fails the
				// page; draft flags + source-only falls back).
				throw new EditLayerCompositeError(patchAssetId, error);
			}
		}
	}
	if (!painted) return;
	const overlayImage = new fabric.FabricImage(overlay, {
		left: 0,
		top: 0,
		originX: "left",
		originY: "top",
		selectable: false,
		evented: false,
	});
	exportCanvas.add(overlayImage);
}

function canvasToPngBlob(canvas: any): Blob {
	canvas.renderAll();
	const dataUrl = canvas.toDataURL({
		format: "png",
		quality: 1,
		multiplier: 1,
		enableRetinaScaling: false,
	});
	return dataUrlToBlob(dataUrl);
}

// #fonts: Fabric renders/measures an UNLOADED font family in the browser fallback, so a
// typeset chapter exported in the wrong font (and mis-fit boxes). Load every text layer's
// family via the Font Loading API + await document.fonts.ready BEFORE building/rasterizing
// the text objects. Best-effort: a font that never loads still renders (fallback), as before.
async function ensureExportFontsLoaded(layerStack: ReadonlyArray<{ kind: string; layer: { fontFamily?: string } | unknown }>): Promise<void> {
	if (typeof document === "undefined" || !document.fonts) return;
	const families = new Set<string>();
	for (const entry of layerStack) {
		if (entry.kind === "text") { const fam = (entry.layer as { fontFamily?: string }).fontFamily; if (fam) families.add(fam); }
	}
	await Promise.all(
		[...families].map((family) => document.fonts.load(`16px "${family}"`).catch(() => undefined)),
	);
	await document.fonts.ready.catch(() => undefined);
}

async function renderPageToPngBlob(
	project: ProjectState,
	item: PageExportPlanItem,
	options: Pick<ExportPagesToZipOptions, "imageUrlResolver" | "exportProfile"> = {},
	lang?: string,
): Promise<RenderedPage> {
	if (typeof document === "undefined") {
		throw new Error("Batch export requires a browser canvas environment");
	}

	const fabric = await loadFabric();
	const page = project.pages[item.pageIndex];
	const imageUrl = resolveExportImageUrl(project.projectId, item.imageId, item.pageNumber, options.imageUrlResolver);
	// The background load is the page's hard dependency: if even the source image
	// can't be loaded, the page cannot be rendered at all and is reported as
	// skipped by the caller. A failure AFTER this point (layer compositing) is
	// recoverable — we fall back to a source-only render so the page is still
	// present in the ZIP rather than silently dropped.
	// EXPORT-purpose fetch (codex P1-A): the page background (edited or source) is
	// fetched through the server export serve-gate (moderation must be `passed`), so
	// a `needs_review` / quarantined / blocked background can NEVER be rendered into
	// a client-built ZIP. This is the authoritative content-safety gate; the client
	// batch gate is kept as defense-in-depth.
	const background = await api.loadExportFabricImage(fabric, project.projectId, item.imageId, imageUrl, { crossOrigin: "anonymous" }) as any;
	const { width, height } = getOriginalImageSize(background);

	try {
		const { canvas, dispose } = rasterizeBackground(fabric, background, width, height);
		try {
			// Phase A — composite non-destructive edit layers (bubble-clean fill-masks)
			// over the background BEFORE image/text layers, matching the live editor +
			// backend Sharp compositor.
			await composeEditLayersOntoExportCanvas(fabric, canvas, project.projectId, page, width, height, options.imageUrlResolver);
			const layerStack = buildPageExportLayerStack(page, lang);
			// #fonts: preload the text fonts BEFORE creating/measuring text objects.
			await ensureExportFontsLoaded(layerStack);
			for (const entry of layerStack) {
				if (entry.kind === "image") {
					canvas.add(await createExportImageObject(fabric, project.projectId, entry.layer, options.imageUrlResolver) as any);
				} else {
					for (const textObject of createExportTextObjects(fabric, entry.layer)) {
						canvas.add(textObject as any);
					}
				}
			}
			return { blob: canvasToPngBlob(canvas), width, height, renderMode: "full" };
		} finally {
			dispose();
		}
	} catch (layerError) {
		// P1-c — a non-destructive edit-layer (bubble-clean) compositing failure is NOT
		// recoverable for a PUBLISH export: falling back to source-only would ship the
		// page with the dialogue NOT cleaned while still claiming success. Re-throw so the
		// page is reported as a hard failure (kept OUT of the ZIP). A DRAFT export tolerates
		// it and falls through to the source-only render below, flagged in the manifest.
		const profile = options.exportProfile ?? "publish";
		if (layerError instanceof EditLayerCompositeError && profile === "publish") {
			throw layerError;
		}
		// Layer compositing failed (e.g. an overlay/AI-result asset 404s) but the
		// page background loaded fine. Emit the raw source image so the page still
		// appears in the export, flagged as a source-only fallback in the manifest.
		const { canvas, dispose } = rasterizeBackground(fabric, background, width, height);
		try {
			return {
				blob: canvasToPngBlob(canvas),
				width,
				height,
				renderMode: "source-only",
				renderNote: layerError instanceof EditLayerCompositeError
					? `Edit-layer (clean) compositing failed (${describeError(layerError)}); exported the raw UN-CLEANED source image instead.`
					: `Layer compositing failed (${describeError(layerError)}); exported the raw source image instead.`,
			};
		} finally {
			dispose();
		}
	}
}

export async function exportPagesToZip(
	project: ProjectState,
	pageIndexes: number[],
	options: ExportPagesToZipOptions = {},
): Promise<ExportPagesToZipResult> {
	const exportedAt = options.exportedAt ?? new Date();
	// Resolve the active Language Track once. Single-language / legacy projects
	// resolve to `undefined` and take the flat `page.textLayers` path (byte-identical).
	// Multi-track projects export the active track's own per-language text.
	const lang = resolveExportLang(project);
	const plan = buildPageExportPlan(project, pageIndexes, lang);
	if (!plan.length) throw new Error("No valid pages selected for export");

	// Readiness gate (parity with the backend's MissingLanguageOutputError):
	// when the active track is an EXPLICIT non-default language, every selected
	// page must carry a real `languageOutputs[lang]` output. Otherwise the render
	// would silently fall through `trackTextLayers` to the flat/source (default)
	// layout and export the WRONG language. Block the whole export with a clear,
	// page-naming error instead of shipping mislabelled text. The default/source
	// track and single-language projects (`lang === undefined`) are never gated.
	const missingLanguagePages = findMissingLanguageOutputPages(project, plan, lang);
	if (missingLanguagePages.length > 0) {
		throw new MissingLanguageOutputError(
			lang as string,
			missingLanguagePages.map((item) => item.pageNumber),
		);
	}

	const manifest: PageExportManifest = {
		projectId: project.projectId,
		projectName: project.name,
		exportedAt: exportedAt.toISOString(),
		pageCount: 0,
		requestedPageCount: plan.length,
		pages: [],
		skippedPages: [],
	};
	const files: ZipFileInput[] = [];

	for (let index = 0; index < plan.length; index += 1) {
		const item = plan[index];
		let rendered: RenderedPage;
		try {
			// A visible image layer with no asset ID can't be composited. Treat that
			// as a layer-compositing failure so the page still exports as a
			// source-only fallback instead of either aborting the whole export or
			// rendering with a missing layer.
			let renderNote: string | undefined;
			try {
				assertVisibleImageLayerAssets(project, item, lang);
			} catch (assetError) {
				renderNote = describeError(assetError);
			}
			rendered = await renderPageToPngBlob(project, item, {
				imageUrlResolver: options.imageUrlResolver,
				exportProfile: options.exportProfile,
			}, lang);
			if (renderNote && rendered.renderMode === "full") {
				// The layer in question wasn't actually fatal during compositing (e.g.
				// it was hidden by z-order), but we still annotate the manifest so the
				// missing-asset condition isn't silently swallowed.
				rendered = { ...rendered, renderMode: "source-only", renderNote };
			}
		} catch (error) {
			// The page could not be rendered at all (even its source image failed to
			// load). Skip it, record why, and CONTINUE with the rest so one bad page
			// no longer kills the whole chapter export.
			manifest.skippedPages.push({
				pageIndex: item.pageIndex,
				pageNumber: item.pageNumber,
				imageId: item.imageId,
				sourceName: item.sourceName,
				filename: item.filename,
				reason: describeError(error),
			});
			options.onProgress?.({
				completed: index + 1,
				total: plan.length,
				pageIndex: item.pageIndex,
				pageNumber: item.pageNumber,
				filename: item.filename,
				phase: "rendering",
			});
			await waitForUiYield();
			continue;
		}
		const manifestPage: PageExportManifestPage = {
			...item,
			width: rendered.width,
			height: rendered.height,
			renderMode: rendered.renderMode,
			...(rendered.renderNote ? { renderNote: rendered.renderNote } : {}),
			layers: buildPageExportManifestLayers(project.pages[item.pageIndex], lang),
		};
		// Optional web-delivery split: slice files REPLACE the single page file.
		// A slicing failure (old browser, canvas limits) falls back to the unsplit
		// page with an honest manifest note — never a dropped page.
		const sliceHeight = planExportSliceHeight(rendered.height, options.split);
		let pageFiles: ZipFileInput[] = [{ path: `pages/${item.filename}`, data: rendered.blob, modifiedAt: exportedAt }];
		if (sliceHeight !== null) {
			try {
				const slices = await sliceRenderedPageBlob(rendered.blob, rendered.width, rendered.height, sliceHeight, item.filename);
				manifestPage.slices = slices.map((slice) => ({ filename: slice.filename, height: slice.height }));
				pageFiles = slices.map((slice) => ({ path: `pages/${slice.filename}`, data: slice.blob, modifiedAt: exportedAt }));
			} catch (sliceError) {
				manifestPage.renderNote = [manifestPage.renderNote, `split skipped: ${describeError(sliceError)}`]
					.filter(Boolean)
					.join("; ");
			}
		}
		manifest.pages.push(manifestPage);
		files.push(...pageFiles);
		options.onProgress?.({
			completed: index + 1,
			total: plan.length,
			pageIndex: item.pageIndex,
			pageNumber: item.pageNumber,
			filename: item.filename,
			phase: "rendering",
		});
		await waitForUiYield();
	}

	manifest.pageCount = manifest.pages.length;

	// If literally nothing rendered, this is a genuine total failure — surface it
	// as an error rather than handing back an empty ZIP that looks like a success.
	if (manifest.pages.length === 0) {
		const firstSkip = manifest.skippedPages[0];
		throw new PageExportError(
			firstSkip?.pageIndex ?? plan[0].pageIndex,
			firstSkip?.pageNumber ?? plan[0].pageNumber,
			new Error(firstSkip?.reason ?? "ทุกหน้าใน export ล้มเหลว"),
		);
	}

	const sourceOnlyPages = manifest.pages.filter((page) => page.renderMode === "source-only");

	// Surface skipped + source-only pages as a human-readable notice file alongside
	// the machine-readable manifest, so the user gets an HONEST partial export
	// rather than a silent drop.
	const noticeLines = buildExportNoticeLines(manifest, sourceOnlyPages);
	if (noticeLines.length) {
		files.push({
			path: "EXPORT_NOTICE.txt",
			data: noticeLines.join("\n") + "\n",
			modifiedAt: exportedAt,
		});
	}

	files.unshift({
		path: "manifest.json",
		data: JSON.stringify(manifest, null, 2),
		modifiedAt: exportedAt,
	});

	// All pages are rendered, but createZipBlob is a synchronous ~1s job on a
	// full-res chapter. Announce a distinct "packaging" phase (and yield a frame so
	// the UI repaints) BEFORE running it, so the progress UI shows "packaging…"
	// instead of sitting at 100% and looking frozen during the blob assembly.
	const lastItem = plan[plan.length - 1];
	options.onProgress?.({
		completed: plan.length,
		total: plan.length,
		pageIndex: lastItem.pageIndex,
		pageNumber: lastItem.pageNumber,
		filename: buildBatchExportFilename(project, manifest.pages.length, exportedAt),
		phase: "packaging",
	});
	await waitForUiYield();

	const zipBlob = await createZipBlob(files);
	return {
		zipBlob,
		filename: buildBatchExportFilename(project, manifest.pages.length, exportedAt),
		manifest,
		exportedPages: manifest.pages,
		skippedPages: manifest.skippedPages,
		sourceOnlyPages,
	};
}

/** Build the human-readable EXPORT_NOTICE.txt lines (empty array = no notice needed). */
function buildExportNoticeLines(
	manifest: PageExportManifest,
	sourceOnlyPages: PageExportManifestPage[],
): string[] {
	if (manifest.skippedPages.length === 0 && sourceOnlyPages.length === 0) return [];
	const lines: string[] = [
		`Export summary for "${manifest.projectName}"`,
		`Requested pages: ${manifest.requestedPageCount}`,
		`Exported pages: ${manifest.pageCount}`,
	];
	if (manifest.skippedPages.length) {
		lines.push("", `SKIPPED (${manifest.skippedPages.length}) — could not be rendered and are NOT in this ZIP:`);
		for (const page of manifest.skippedPages) {
			lines.push(`  - Page ${page.pageNumber} (${page.sourceName}): ${page.reason}`);
		}
	}
	if (sourceOnlyPages.length) {
		lines.push("", `SOURCE-ONLY (${sourceOnlyPages.length}) — exported as the raw source image (layer compositing failed):`);
		for (const page of sourceOnlyPages) {
			lines.push(`  - Page ${page.pageNumber} (${page.filename}): ${page.renderNote ?? "layer compositing failed"}`);
		}
	}
	return lines;
}
