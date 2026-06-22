// Locale-neutral source-option descriptor. This helper is framework- and
// locale-agnostic: it carries STRUCTURED identity (a `kind` discriminant plus the
// numeric page number / raw file name) instead of pre-built display strings. UI
// consumers (ImportRemapDialog) localize these via $_() / the `importRemap.*`
// i18n namespace. Do NOT add human-readable / translated text here.
//   - kind "pageIndex"  → JSON entry keyed by zero-based pageIndex; `pageNumber`
//                         is the one-based display number (pageIndex + 1).
//   - kind "pageNumber" → JSON entry keyed by one-based pageNumber.
//   - kind "imageName" / "imagePath" → JSON entry keyed by a file name/path;
//                         `displayName` is the path tail (a file name, not
//                         translatable text) used verbatim as the label.
export type JsonImportSourceKind = "pageIndex" | "pageNumber" | "imageName" | "imagePath";

export interface JsonImportSourceOption {
	id: string;
	kind: JsonImportSourceKind;
	/** One-based JSON page number, for the "pageIndex"/"pageNumber" kinds. */
	pageNumber?: number;
	/** Path tail (file name) used verbatim as the label, for the file-name kinds. */
	displayName?: string;
	entryCount: number;
	sourcePageIndex?: number;
	sourcePageNumber?: number;
	sourceImagePath?: string;
	sourceImageName?: string;
}

export interface JsonImportTargetPage {
	pageIndex: number;
	imageName: string;
	originalName?: string;
}

export interface JsonImportMappingRow {
	id: string;
	targetPageIndex: number;
	/** One-based target page number. UI builds the localized label from this. */
	targetPageNumber: number;
	/** Original/image name shown alongside the localized page label, if any. */
	targetPageName?: string;
	targetImageName: string;
	sourceOptionId: string | null;
	defaultSourceOptionId: string | null;
	reason: "order" | "unmapped";
}

export interface JsonImportMappingSelection {
	targetPageIndex: number;
	sourceOptionId: string | null;
}

export interface JsonImportRemapRequestInput {
	options: JsonImportSourceOption[];
	projectPageCount: number;
	targetPageIndex: number;
	/**
	 * Locale-neutral fallback image name for the active target page, used only
	 * when `targetPages` is empty. Not a translated/display string.
	 */
	targetImageName?: string;
	targetLang?: string;
	targetPages?: JsonImportTargetPage[];
}

const sourceCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPageNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}
	return undefined;
}

function pathTail(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

export function getJsonImportEntries(data: unknown): unknown[] {
	if (Array.isArray(data)) return data;
	if (!isRecord(data)) return [];
	const entries = Array.isArray(data.entries) ? data.entries : undefined;
	const items = Array.isArray(data.items) ? data.items : undefined;
	return entries ?? items ?? [];
}

function createSourceOption(item: Record<string, unknown>): Omit<JsonImportSourceOption, "entryCount"> | null {
	const pageIndex = asPageNumber(item.pageIndex);
	if (pageIndex !== undefined) {
		return {
			id: `page-index:${pageIndex}`,
			kind: "pageIndex",
			pageNumber: pageIndex + 1,
			sourcePageIndex: pageIndex,
			sourcePageNumber: pageIndex + 1,
		};
	}

	const pageNumber = asPageNumber(item.pageNumber) ?? asPageNumber(item.page);
	if (pageNumber !== undefined && pageNumber >= 1) {
		return {
			id: `page-number:${pageNumber}`,
			kind: "pageNumber",
			pageNumber,
			sourcePageIndex: pageNumber - 1,
			sourcePageNumber: pageNumber,
		};
	}

	const imageName =
		asString(item.imageName) ??
		asString(item.fileName) ??
		asString(item.filename) ??
		asString(item.imageId) ??
		asString(item.assetId);
	if (imageName) {
		return {
			id: `image-name:${pathTail(imageName).toLowerCase()}`,
			kind: "imageName",
			displayName: pathTail(imageName),
			sourceImageName: imageName,
		};
	}

	const imagePath = asString(item.image_path) ?? asString(item.imagePath) ?? asString(item.path);
	if (imagePath) {
		return {
			id: `image-path:${pathTail(imagePath).toLowerCase()}`,
			kind: "imagePath",
			displayName: pathTail(imagePath),
			sourceImagePath: imagePath,
		};
	}

	return null;
}

export function summarizeJsonImportSources(data: unknown): JsonImportSourceOption[] {
	const groups = new Map<string, JsonImportSourceOption>();
	for (const entry of getJsonImportEntries(data)) {
		if (!isRecord(entry)) continue;
		const option = createSourceOption(entry);
		if (!option) continue;
		const existing = groups.get(option.id);
		if (existing) {
			existing.entryCount += 1;
			continue;
		}
		groups.set(option.id, { ...option, entryCount: 1 });
	}
	// Locale-neutral, stable ordering by the option's STRUCTURED identity (not a
	// translated label): page kinds sort ahead of file kinds and within page
	// kinds by numeric page number; file kinds sort by their (locale-neutral)
	// file-name tail with numeric awareness ("…-5" before "…-10").
	return Array.from(groups.values()).sort(compareSourceOptions);
}

function sourceSortGroup(option: JsonImportSourceOption): number {
	return option.kind === "pageIndex" || option.kind === "pageNumber" ? 0 : 1;
}

function compareSourceOptions(a: JsonImportSourceOption, b: JsonImportSourceOption): number {
	const groupDelta = sourceSortGroup(a) - sourceSortGroup(b);
	if (groupDelta !== 0) return groupDelta;
	if (sourceSortGroup(a) === 0) {
		return (a.pageNumber ?? 0) - (b.pageNumber ?? 0);
	}
	return sourceCollator.compare(a.displayName ?? "", b.displayName ?? "");
}

function sourceOptionTargetsOutsideProject(option: JsonImportSourceOption, projectPageCount: number): boolean {
	const pageIndex = option.sourcePageIndex ?? (
		option.sourcePageNumber !== undefined ? option.sourcePageNumber - 1 : undefined
	);
	return pageIndex !== undefined && pageIndex >= projectPageCount;
}

export function shouldAskForJsonImportRemap(
	projectPageCount: number,
	sourceCount: number,
	sourceOptions: JsonImportSourceOption[] = [],
): boolean {
	if (projectPageCount <= 0 || sourceCount <= 0) return false;
	if (sourceCount > projectPageCount) return true;
	return sourceOptions.some((option) => sourceOptionTargetsOutsideProject(option, projectPageCount));
}

export function buildJsonImportMappingRows(
	targetPages: JsonImportTargetPage[],
	options: JsonImportSourceOption[],
): JsonImportMappingRow[] {
	return targetPages.map((page, index) => {
		const source = options[index] ?? null;
		// Locale-neutral: carry the one-based page number + the (untranslated)
		// page name; the UI builds the localized "หน้า {n} ({name})" label.
		const targetPageName = page.originalName || page.imageName || undefined;
		return {
			id: `target-page:${page.pageIndex}`,
			targetPageIndex: page.pageIndex,
			targetPageNumber: page.pageIndex + 1,
			targetPageName,
			targetImageName: page.originalName || page.imageName || `page-${page.pageIndex + 1}`,
			sourceOptionId: source?.id ?? null,
			defaultSourceOptionId: source?.id ?? null,
			reason: source ? "order" : "unmapped",
		};
	});
}

export function buildJsonImportMappingsPayload(
	data: unknown,
	rows: JsonImportMappingSelection[],
	options: JsonImportSourceOption[],
): Record<string, unknown> {
	const optionById = new Map(options.map((option) => [option.id, option]));
	const mappings = rows
		.map((row) => {
			if (!row.sourceOptionId) return null;
			const selection = optionById.get(row.sourceOptionId);
			if (!selection) return null;
			return {
				targetPageIndex: row.targetPageIndex,
				sourcePageIndex: selection.sourcePageIndex,
				sourcePageNumber: selection.sourcePageNumber,
				sourceImagePath: selection.sourceImagePath,
				sourceImageName: selection.sourceImageName,
			};
		})
		.filter((item): item is NonNullable<typeof item> => Boolean(item));
	const base = Array.isArray(data)
		? { entries: data }
		: isRecord(data)
			? { ...data }
			: { entries: [] };
	return {
		...base,
		mappings,
	};
}

export function buildJsonImportRemapPayload(
	data: unknown,
	selection: JsonImportSourceOption,
	targetPageIndex: number,
): Record<string, unknown> {
	const base = Array.isArray(data)
		? { entries: data }
		: isRecord(data)
			? { ...data }
			: { entries: [] };
	return {
		...base,
		targetPageIndex,
		sourcePageIndex: selection.sourcePageIndex,
		sourcePageNumber: selection.sourcePageNumber,
		sourceImagePath: selection.sourceImagePath,
		sourceImageName: selection.sourceImageName,
	};
}
