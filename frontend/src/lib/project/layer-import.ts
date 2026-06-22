import type { Page, ProjectState, TextLayer } from "$lib/types.js";

export interface LayerImportDocument {
	version?: number;
	pageIndex?: number;
	pageNumber?: number;
	imageName?: string;
	fileName?: string;
	filename?: string;
	textLayers?: unknown[];
}

export interface LayerImportResult {
	imported: number;
	skipped: number;
	pageIndex: number | null;
	layers: TextLayer[];
}

type IdFactory = () => string;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asHexColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

function pathTail(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function defaultIdFactory(): string {
	return globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function matchesPageIdentifier(page: Page, identifier: string): boolean {
	const normalized = pathTail(identifier.trim());
	const candidates = [page.imageId, page.imageName, page.originalName].filter(Boolean) as string[];
	return candidates.some((candidate) => {
		const candidateTail = pathTail(candidate);
		return candidate === identifier || candidate === normalized || candidateTail === normalized;
	});
}

function normalizeAlignment(value: unknown): TextLayer["alignment"] {
	return value === "left" || value === "right" || value === "center" ? value : "center";
}

function normalizeSourceCategory(value: unknown): TextLayer["sourceCategory"] | undefined {
	const category = asString(value);
	if (
		category === "dialogue" ||
		category === "narration" ||
		category === "sfx" ||
		category === "sign" ||
		category === "title" ||
		category === "credit" ||
		category === "logo" ||
		category === "page_number" ||
		category === "other"
	) {
		return category;
	}
	return undefined;
}

function normalizeLayer(value: unknown, index: number, idFactory: IdFactory): TextLayer | null {
	if (!isRecord(value)) return null;

	const text = asString(value.text)?.trim();
	if (!text) return null;

	const x = asNumber(value.x);
	const y = asNumber(value.y);
	const w = asNumber(value.w);
	const h = asNumber(value.h);
	const strokeWidth = asNumber(value.strokeWidth);
	const charSpacing = asNumber(value.charSpacing);
	const skewX = asNumber(value.skewX);
	const skewY = asNumber(value.skewY);
	if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) {
		return null;
	}

	return {
		id: asString(value.id) || idFactory(),
		text,
		sourceText: asString(value.sourceText),
		sourceCategory: normalizeSourceCategory(value.sourceCategory),
		sourceProvider: asString(value.sourceProvider) || "layer-json-import",
		confidence: asNumber(value.confidence),
		protected: value.protected === true,
		x: Math.round(x),
		y: Math.round(y),
		w: Math.max(1, Math.round(w)),
		h: Math.max(1, Math.round(h)),
		rotation: asNumber(value.rotation) ?? 0,
		fontSize: Math.max(1, Math.round(asNumber(value.fontSize) ?? 24)),
		charSpacing: charSpacing === undefined ? undefined : Math.max(-500, Math.min(1000, Math.round(charSpacing))),
		skewX: skewX === undefined ? undefined : Math.max(-45, Math.min(45, Math.round(skewX))),
		skewY: skewY === undefined ? undefined : Math.max(-45, Math.min(45, Math.round(skewY))),
		fontFamily: asString(value.fontFamily),
		fill: asHexColor(value.fill),
		stroke: asHexColor(value.stroke),
		strokeWidth: strokeWidth === undefined ? undefined : Math.max(0, strokeWidth),
		alignment: normalizeAlignment(value.alignment),
		visible: value.visible === false ? false : undefined,
		locked: value.locked === true,
		index: asNumber(value.index) ?? index,
		effects: isRecord(value.effects) ? value.effects as TextLayer["effects"] : undefined,
	};
}

export function isLayerImportDocument(value: unknown): value is LayerImportDocument {
	return isRecord(value) && Array.isArray(value.textLayers);
}

export function resolveLayerImportPageIndex(project: ProjectState, document: LayerImportDocument): number | null {
	const imageIdentifier = document.imageName || document.fileName || document.filename;
	if (imageIdentifier) {
		const matchedIndex = project.pages.findIndex((page) => matchesPageIdentifier(page, imageIdentifier));
		if (matchedIndex >= 0) return matchedIndex;
		return null;
	}

	if (Number.isInteger(document.pageIndex) && document.pageIndex! >= 0 && document.pageIndex! < project.pages.length) {
		return document.pageIndex!;
	}

	if (Number.isInteger(document.pageNumber)) {
		const zeroBasedIndex = document.pageNumber! - 1;
		if (zeroBasedIndex >= 0 && zeroBasedIndex < project.pages.length) {
			return zeroBasedIndex;
		}
		return null;
	}

	return project.currentPage;
}

export function buildLayerImportResult(
	project: ProjectState,
	document: LayerImportDocument,
	idFactory: IdFactory = defaultIdFactory,
): LayerImportResult {
	const pageIndex = resolveLayerImportPageIndex(project, document);
	if (pageIndex === null) {
		return {
			imported: 0,
			skipped: document.textLayers?.length ?? 0,
			pageIndex: null,
			layers: [],
		};
	}

	const layers = (document.textLayers ?? [])
		.map((layer, index) => normalizeLayer(layer, index, idFactory));
	const importedLayers = layers.filter((layer): layer is TextLayer => layer !== null);

	return {
		imported: importedLayers.length,
		skipped: layers.length - importedLayers.length,
		pageIndex,
		layers: importedLayers,
	};
}
