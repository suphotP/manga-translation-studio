// External-clean roundtrip: a cleaner EXPORTS the original page images (a few
// pages or all), cleans them outside the app (e.g. Photoshop), and IMPORTS the
// cleaned files back. The server ZIP manifest is the authoritative file↔page
// contract; filename prefixes are only fallback compatibility. The re-import
// REQUIRES identical pixel dimensions because every text layer, image-layer bbox
// and edit-layer ROI is stored in ABSOLUTE source pixels (a different-sized
// image would mis-position all of them).

/** `page-001__<original name>.png` — the page number is the import-back key. */
export function cleanExportFilename(pageNumber: number, originalName: string | undefined, fallbackId: string): string {
	const base = (originalName?.trim() || fallbackId).replace(/[\\/:*?"<>|]/g, "_");
	return `page-${String(pageNumber).padStart(3, "0")}__${base}`;
}

function pathKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
}

function baseNameForPath(path: string): string {
	const normalized = pathKey(path);
	return normalized.split("/").at(-1) ?? normalized;
}

function filePath(file: File): string {
	const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
	return relativePath || file.name;
}

/**
 * Recover the 1-based page number from an exported (then cleaned) filename.
 * Fallback accepts both legacy client names (`page-NNN__x`) and server-originals
 * names (`pages/NNN-x`). Manifest matches should be preferred whenever present.
 */
export function parseCleanedPageNumber(filename: string): number | null {
	const base = baseNameForPath(filename);
	const match = /^page-(\d{1,5})(?=\D|$)/i.exec(base) ?? /^(\d{1,5})(?=\D|$)/.exec(base);
	if (!match) return null;
	const value = Number.parseInt(match[1]!, 10);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/** Decode a candidate file's pixel dimensions (browser-only). */
export async function readImageFileDimensions(file: File): Promise<{ width: number; height: number }> {
	const bitmap = await createImageBitmap(file);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close?.();
	}
}

export interface CleanedImportPlanItem {
	file: File;
	pageIndex: number;
	pageNumber: number;
}

export interface CleanedImportPlan {
	matches: CleanedImportPlanItem[];
	/** Files whose name carries no parseable page number. */
	unmatched: File[];
	/** Files whose page number points outside the current page set. */
	outOfRange: Array<{ file: File; pageNumber: number }>;
}

export interface CleanedImportManifestPage {
	pageIndex: number;
	filename: string;
}

export interface CleanedImportManifest {
	pages: readonly CleanedImportManifestPage[];
}

function manifestPageIndexForFile(file: File, manifest: CleanedImportManifest | undefined): number | null {
	if (!manifest) return null;
	const fullKey = pathKey(filePath(file));
	const baseKey = baseNameForPath(filePath(file));
	for (const page of manifest.pages) {
		if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0 || typeof page.filename !== "string") continue;
		const manifestPath = page.filename;
		if (pathKey(manifestPath) === fullKey || baseNameForPath(manifestPath) === baseKey) {
			return page.pageIndex;
		}
	}
	return null;
}

/** Map cleaned files back to pages by manifest filename first, then filename prefix fallback. */
export function planCleanedImport(files: readonly File[], pageCount: number, manifest?: CleanedImportManifest): CleanedImportPlan {
	const plan: CleanedImportPlan = { matches: [], unmatched: [], outOfRange: [] };
	for (const file of files) {
		if (baseNameForPath(filePath(file)) === "manifest.json") continue;
		const manifestPageIndex = manifestPageIndexForFile(file, manifest);
		const pageNumber = manifestPageIndex === null ? parseCleanedPageNumber(filePath(file)) : manifestPageIndex + 1;
		if (pageNumber === null || pageNumber <= 0) {
			plan.unmatched.push(file);
			continue;
		}
		if (pageNumber > pageCount) {
			plan.outOfRange.push({ file, pageNumber });
			continue;
		}
		plan.matches.push({ file, pageIndex: pageNumber - 1, pageNumber });
	}
	// Deterministic order: ascending page, so progress reads naturally.
	plan.matches.sort((a, b) => a.pageIndex - b.pageIndex);
	return plan;
}
