import type { TranslationImportPayload, TranslationImportResult } from "$lib/api/client.ts";
import type { Page, ProjectState, TextLayer } from "$lib/types.js";
import { activeTrack, isDefaultTrack, trackTextLayers, writeTrackTextLayers } from "$lib/project/language-tracks.js";

type ImportSkipReason = "invalid_entry" | "page_not_found" | "invalid_layer";

interface ImportSourceFilter {
	pageIndex?: number;
	imageIdentifier?: string;
}

interface ResolvedImportMapping {
	targetPageIndex: number;
	targetPage: ProjectState["pages"][number];
	sourceFilter: ImportSourceFilter;
	imported: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPageIndex(value: unknown): number | undefined {
	const numeric = asNumber(value);
	if (numeric !== undefined) return numeric;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}
	return undefined;
}

function pathTail(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function importImagePathKey(value: string): string {
	return pathTail(value.trim()).toLowerCase();
}

function pageMatchesIdentifier(page: ProjectState["pages"][number], identifier: string): boolean {
	const normalized = pathTail(identifier.trim());
	const candidates = [page.imageId, page.imageName, page.originalName].filter(Boolean) as string[];
	return candidates.some((candidate) => {
		const candidateTail = pathTail(candidate);
		return candidate === identifier || candidate === normalized || candidateTail === normalized;
	});
}

function getImportImagePath(item: Record<string, unknown>, fallbackImagePath?: string): string | undefined {
	return asString(item.image_path) ?? asString(item.imagePath) ?? asString(item.path) ?? fallbackImagePath;
}

function hasExplicitImportPageLocator(item: Record<string, unknown>): boolean {
	return asPageIndex(item.pageIndex) !== undefined
		|| asPageIndex(item.pageNumber) !== undefined
		|| asPageIndex(item.page) !== undefined
		|| asString(item.assetId) !== undefined
		|| asString(item.imageId) !== undefined
		|| asString(item.imageName) !== undefined
		|| asString(item.fileName) !== undefined
		|| asString(item.filename) !== undefined;
}

function buildImportImagePathOrderFallback(
	project: ProjectState,
	entries: unknown[],
	fallbackImagePath?: string,
): Map<string, number> {
	const reservedPageIndexes = new Set<number>();
	const unmatchedPaths = new Map<string, string>();

	for (const entry of entries) {
		if (!isRecord(entry) || hasExplicitImportPageLocator(entry)) continue;
		const rawImagePath = getImportImagePath(entry, fallbackImagePath);
		if (!rawImagePath) continue;

		const directPageIndex = project.pages.findIndex((page) => pageMatchesIdentifier(page, rawImagePath));
		if (directPageIndex >= 0) {
			reservedPageIndexes.add(directPageIndex);
			continue;
		}

		const key = importImagePathKey(rawImagePath);
		if (key && !unmatchedPaths.has(key)) {
			unmatchedPaths.set(key, rawImagePath);
		}
	}

	const availablePageIndexes = project.pages
		.map((_, pageIndex) => pageIndex)
		.filter((pageIndex) => !reservedPageIndexes.has(pageIndex));
	const orderedUnmatchedKeys = Array.from(unmatchedPaths.entries())
		.sort((a, b) => pathTail(a[1]).localeCompare(pathTail(b[1]), undefined, { numeric: true, sensitivity: "base" }))
		.map(([key]) => key);
	if (orderedUnmatchedKeys.length !== availablePageIndexes.length) {
		return new Map();
	}

	const fallback = new Map<string, number>();
	for (let index = 0; index < orderedUnmatchedKeys.length && index < availablePageIndexes.length; index += 1) {
		fallback.set(orderedUnmatchedKeys[index], availablePageIndexes[index]);
	}
	return fallback;
}

function getImportSourceFilter(value: {
	sourcePageIndex?: number;
	sourcePageNumber?: number;
	sourcePage?: number;
	sourceImagePath?: string;
	sourceImageName?: string;
	sourceFileName?: string;
}): ImportSourceFilter | null {
	const sourcePageIndex = value.sourcePageIndex
		?? (value.sourcePageNumber !== undefined ? value.sourcePageNumber - 1 : undefined)
		?? (value.sourcePage !== undefined ? value.sourcePage - 1 : undefined);
	const imageIdentifier = value.sourceImagePath ?? value.sourceImageName ?? value.sourceFileName;
	if (sourcePageIndex === undefined && !imageIdentifier) return null;
	return { pageIndex: sourcePageIndex, imageIdentifier };
}

function importSourceFilterKey(filter: ImportSourceFilter): string {
	return `${filter.pageIndex ?? ""}::${filter.imageIdentifier ? importImagePathKey(filter.imageIdentifier) : ""}`;
}

function getEntrySourcePageIndex(item: Record<string, unknown>): number | undefined {
	const pageIndex = asPageIndex(item.pageIndex);
	if (pageIndex !== undefined) return pageIndex;
	const pageNumber = asPageIndex(item.pageNumber) ?? asPageIndex(item.page);
	return pageNumber === undefined ? undefined : pageNumber - 1;
}

function getEntryImageIdentifiers(item: Record<string, unknown>, fallbackImagePath?: string): string[] {
	return [
		asString(item.assetId),
		asString(item.imageId),
		asString(item.imageName),
		asString(item.fileName),
		asString(item.filename),
		getImportImagePath(item, fallbackImagePath),
	].filter((value): value is string => Boolean(value));
}

function importIdentifierMatches(left: string, right: string): boolean {
	const leftKey = importImagePathKey(left);
	const rightKey = importImagePathKey(right);
	return left.trim() === right.trim() || leftKey === rightKey;
}

function entryMatchesImportSourceFilter(
	item: Record<string, unknown>,
	filter: ImportSourceFilter,
	fallbackImagePath?: string,
): boolean {
	const comparisons: boolean[] = [];
	if (filter.pageIndex !== undefined) {
		const entryPageIndex = getEntrySourcePageIndex(item);
		if (entryPageIndex !== undefined) {
			comparisons.push(entryPageIndex === filter.pageIndex);
		}
	}
	if (filter.imageIdentifier) {
		const identifiers = getEntryImageIdentifiers(item, fallbackImagePath);
		if (identifiers.length) {
			comparisons.push(identifiers.some((identifier) => importIdentifierMatches(identifier, filter.imageIdentifier!)));
		}
	}
	return comparisons.some(Boolean);
}

function findImportPage(
	project: ProjectState,
	item: Record<string, unknown>,
	fallbackPageIndex?: number,
	fallbackImagePath?: string,
	imagePathOrderFallback?: Map<string, number>,
) {
	const pageIndex = asPageIndex(item.pageIndex);
	if (pageIndex !== undefined && Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < project.pages.length) {
		return project.pages[pageIndex];
	}

	const pageNumber = asPageIndex(item.pageNumber) ?? asPageIndex(item.page);
	if (pageNumber !== undefined && Number.isInteger(pageNumber)) {
		const zeroBasedIndex = pageNumber - 1;
		if (zeroBasedIndex >= 0 && zeroBasedIndex < project.pages.length) {
			return project.pages[zeroBasedIndex];
		}
		return null;
	}

	const imageIdentifier =
		asString(item.assetId) ??
		asString(item.imageId) ??
		asString(item.imageName) ??
		asString(item.fileName) ??
		asString(item.filename);
	if (imageIdentifier) {
		return project.pages.find((page) => pageMatchesIdentifier(page, imageIdentifier)) ?? null;
	}

	const rawImagePath = getImportImagePath(item, fallbackImagePath);
	if (rawImagePath) {
		const directPage = project.pages.find((page) => pageMatchesIdentifier(page, rawImagePath));
		if (directPage) return directPage;
		const fallbackIndex = imagePathOrderFallback?.get(importImagePathKey(rawImagePath));
		return fallbackIndex === undefined ? null : project.pages[fallbackIndex] ?? null;
	}

	const fallbackIndex = fallbackPageIndex;
	if (fallbackIndex !== undefined && Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < project.pages.length) {
		return project.pages[fallbackIndex];
	}
	return project.pages[project.currentPage] ?? null;
}

function readBox(item: Record<string, unknown>): { x: number; y: number; w: number; h: number } {
	const bbox = Array.isArray(item.bbox) ? item.bbox.map(asNumber) : undefined;
	if (bbox?.length === 4 && bbox.every((value) => value !== undefined)) {
		const [x, y, w, h] = bbox as number[];
		return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
	}

	const box = Array.isArray(item.box) ? item.box.map(asNumber) : undefined;
	if (box?.length === 4 && box.every((value) => value !== undefined)) {
		const [x1, y1, x2, y2] = box as number[];
		const left = Math.min(x1, x2);
		const top = Math.min(y1, y2);
		return { x: Math.max(0, Math.round(left)), y: Math.max(0, Math.round(top)), w: Math.max(1, Math.round(Math.abs(x2 - x1))), h: Math.max(1, Math.round(Math.abs(y2 - y1))) };
	}

	return { x: 0, y: 0, w: 220, h: 80 };
}

function estimateImportedFontSize(text: string, box: { w: number; h: number }): number {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return 16;

	let low = 10;
	let high = 36;
	let best = 16;

	while (low <= high) {
		const fontSize = Math.floor((low + high) / 2);
		const averageGlyphWidth = fontSize * 0.58;
		const usableWidth = Math.max(1, box.w * 0.88);
		const charsPerLine = Math.max(1, Math.floor(usableWidth / averageGlyphWidth));
		const estimatedLines = Math.max(1, Math.ceil(normalized.length / charsPerLine));
		const estimatedHeight = estimatedLines * fontSize * 1.18;
		const fitsHeight = estimatedHeight <= box.h * 0.78;
		const fitsWidth = fontSize <= box.w * 0.18;

		if (fitsHeight && fitsWidth) {
			best = fontSize;
			low = fontSize + 1;
		} else {
			high = fontSize - 1;
		}
	}

	return Math.max(10, Math.min(36, best));
}

function localLayerId(): string {
	return `local-import-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function normalizeImportedLayer(item: Record<string, unknown>, index: number): TextLayer | null {
	const explicitTranslation = "translated_text" in item || "translation" in item || "thai" in item || "targetText" in item;
	const translatedText =
		asString(item.translated_text) ??
		asString(item.translation) ??
		asString(item.thai) ??
		asString(item.targetText);
	const sourceText =
		asString(item.original_text) ??
		asString(item.sourceText) ??
		asString(item.source_text) ??
		asString(item.text);

	if (explicitTranslation && !translatedText?.trim()) return null;

	const text = (translatedText?.trim() || sourceText?.trim() || "").trim();
	if (!text) return null;

	const box = readBox(item);
	return {
		id: localLayerId(),
		text,
		sourceText,
		sourceCategory: asString(item.cat) ?? asString(item.category),
		sourceProvider: "json-import",
		confidence: asNumber(item.confidence),
		protected: item.protected === true,
		x: box.x,
		y: box.y,
		w: box.w,
		h: box.h,
		rotation: asNumber(item.rotation) ?? asNumber(item.angle) ?? 0,
		fontSize: estimateImportedFontSize(text, box),
		alignment: "center",
		index: asNumber(item.index) ?? index,
	};
}

function createSkipSummary(): Record<ImportSkipReason, number> {
	return { invalid_entry: 0, page_not_found: 0, invalid_layer: 0 };
}

function serializeImportSourceMapping(mapping: {
	targetPageIndex: number;
	sourceFilter: ImportSourceFilter;
	imported?: number;
	sourceFiltered?: number;
}) {
	return {
		targetPageIndex: mapping.targetPageIndex,
		sourcePageIndex: mapping.sourceFilter.pageIndex,
		sourcePageNumber: mapping.sourceFilter.pageIndex === undefined ? undefined : mapping.sourceFilter.pageIndex + 1,
		sourceImage: mapping.sourceFilter.imageIdentifier,
		imported: mapping.imported,
		ignoredEntries: mapping.sourceFiltered ?? 0,
	};
}

/**
 * Append an imported text layer to the correct Language Track of a page.
 *
 * - DEFAULT track (single-language / legacy projects): pushes onto the flat
 *   `page.textLayers` exactly as before, so those projects stay byte-identical.
 * - NON-default track: materializes into `page.languageOutputs[lang]` via the
 *   #291 write helper, so an imported TH translation lands on the TH track and
 *   never pollutes the shared flat layer / the default track.
 *
 * Mutates the page in place (this module already mutates `project` in place).
 */
function appendImportedLayerToTrack(page: Page, lang: string, isDefault: boolean, layer: TextLayer): void {
	if (isDefault) {
		if (!page.textLayers) page.textLayers = [];
		page.textLayers.push({ ...layer, index: layer.index ?? page.textLayers.length });
		return;
	}
	const current = trackTextLayers(page, lang);
	const next = [...current, { ...layer, index: layer.index ?? current.length }];
	page.languageOutputs = writeTrackTextLayers(page, lang, next);
}

export function applyLocalTranslationImport(
	project: ProjectState,
	payloadOrEntries: TranslationImportPayload | unknown[],
): TranslationImportResult {
	const payload = Array.isArray(payloadOrEntries) ? { entries: payloadOrEntries } : payloadOrEntries;
	const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.items) ? payload.items : null;
	if (!entries) {
		throw new Error("Validation failed");
	}

	// The track imported translations materialize into. Single-language / legacy
	// projects resolve to the default track and keep writing flat `page.textLayers`
	// (byte-identical). A multi-track project routes the import to the ACTIVE track's
	// `languageOutputs[lang]` bucket so an imported TH translation lands on TH.
	const importLang = activeTrack(project);
	const importLangIsDefault = isDefaultTrack(project, importLang);

	let imported = 0;
	let skipped = 0;
	let orderMapped = 0;
	let sourceFiltered = 0;
	const skippedByReason = createSkipSummary();
	const orderMappedPaths = new Set<string>();
	const importedByPage = new Map<number, NonNullable<TranslationImportResult["pages"]>[number]>();

	const hasExplicitMappings = payload.mappings !== undefined;
	const resolvedMappings: ResolvedImportMapping[] = [];
	if (hasExplicitMappings) {
		const targetPageIndexes = new Set<number>();
		const sourceKeys = new Set<string>();
		for (const mapping of payload.mappings ?? []) {
			if (targetPageIndexes.has(mapping.targetPageIndex)) {
				throw new Error("Duplicate target page mapping");
			}
			targetPageIndexes.add(mapping.targetPageIndex);
			const targetPage = project.pages[mapping.targetPageIndex];
			if (!targetPage) {
				throw new Error("Target page not found");
			}
			const sourceFilter = getImportSourceFilter(mapping);
			if (!sourceFilter) {
				throw new Error("Mapping source not found");
			}
			const sourceKey = importSourceFilterKey(sourceFilter);
			if (sourceKeys.has(sourceKey)) {
				throw new Error("Duplicate source mapping");
			}
			sourceKeys.add(sourceKey);
			resolvedMappings.push({ targetPageIndex: mapping.targetPageIndex, targetPage, sourceFilter, imported: 0 });
		}
	}

	const sourceFilter = hasExplicitMappings ? null : getImportSourceFilter(payload);
	const targetPageIndex = payload.targetPageIndex ?? (sourceFilter ? payload.pageIndex ?? project.currentPage : undefined);
	const targetPage = sourceFilter ? project.pages[targetPageIndex ?? project.currentPage] : null;
	if (sourceFilter && !targetPage) {
		throw new Error("Target page not found");
	}
	const imagePathOrderFallback = sourceFilter || hasExplicitMappings
		? new Map<string, number>()
		: buildImportImagePathOrderFallback(project, entries, payload.image_path);

	for (const [entryIndex, entry] of entries.entries()) {
		if (!isRecord(entry)) {
			skipped++;
			skippedByReason.invalid_entry++;
			continue;
		}
		const matchedMapping = hasExplicitMappings
			? resolvedMappings.find((mapping) => entryMatchesImportSourceFilter(entry, mapping.sourceFilter, payload.image_path))
			: undefined;
		if (hasExplicitMappings && !matchedMapping) {
			sourceFiltered++;
			continue;
		}
		if (sourceFilter && !entryMatchesImportSourceFilter(entry, sourceFilter, payload.image_path)) {
			sourceFiltered++;
			continue;
		}

		const page = matchedMapping
			? matchedMapping.targetPage
			: (sourceFilter && targetPage
				? targetPage
				: findImportPage(project, entry, payload.pageIndex, payload.image_path, imagePathOrderFallback));
		if (!page) {
			skipped++;
			skippedByReason.page_not_found++;
			continue;
		}

		const layer = normalizeImportedLayer(entry, entryIndex);
		if (!layer) {
			skipped++;
			skippedByReason.invalid_layer++;
			continue;
		}

		appendImportedLayerToTrack(page, importLang, importLangIsDefault, layer);
		imported++;
		if (matchedMapping) matchedMapping.imported++;

		const pageIndex = project.pages.indexOf(page);
		const existingPageSummary = importedByPage.get(pageIndex);
		if (existingPageSummary) {
			existingPageSummary.imported++;
		} else {
			importedByPage.set(pageIndex, {
				pageIndex,
				imageId: page.imageId,
				imageName: page.imageName,
				originalName: page.originalName,
				imported: 1,
			});
		}

		const rawImagePath = getImportImagePath(entry, payload.image_path);
		if (rawImagePath && !hasExplicitImportPageLocator(entry) && imagePathOrderFallback.has(importImagePathKey(rawImagePath))) {
			orderMapped++;
			orderMappedPaths.add(pathTail(rawImagePath));
		}
	}

	return {
		imported,
		skipped,
		skippedByReason,
		orderMapped,
		orderMappedPaths: Array.from(orderMappedPaths).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })),
		sourceFiltered,
		sourceMapped: sourceFilter
			? serializeImportSourceMapping({ targetPageIndex: targetPageIndex ?? project.currentPage, sourceFilter, sourceFiltered })
			: undefined,
		sourceMappings: hasExplicitMappings
			? resolvedMappings.map((mapping) => serializeImportSourceMapping(mapping))
			: undefined,
		pages: Array.from(importedByPage.values()).sort((a, b) => a.pageIndex - b.pageIndex),
	};
}
