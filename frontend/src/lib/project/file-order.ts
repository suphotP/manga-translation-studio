const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const SUPPORTED_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

const fileNameCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function fileExtension(name: string): string {
	const tail = name.split(/[\\/]/).pop() ?? name;
	const dotIndex = tail.lastIndexOf(".");
	return dotIndex >= 0 ? tail.slice(dotIndex + 1).toLowerCase() : "";
}

export function isSupportedImageFile(file: File): boolean {
	const extension = fileExtension(file.name);
	if (IMAGE_EXTENSIONS.has(extension)) return true;
	return IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

export function orderProjectImageFiles(files: File[]): File[] {
	return files
		.map((file, index) => ({ file, index }))
		.filter(({ file }) => isSupportedImageFile(file))
		.sort((a, b) => fileNameCollator.compare(a.file.name, b.file.name) || a.index - b.index)
		.map(({ file }) => file);
}

/**
 * Filter to supported images while PRESERVING the caller's array order. Used by
 * bulk import, where the user has already arranged the preview strip (drag, Z→A,
 * etc.) — re-sorting alphabetically here would stitch/append pages in an order
 * the user never confirmed.
 */
export function filterProjectImageFiles(files: File[]): File[] {
	return files.filter((file) => isSupportedImageFile(file));
}

/**
 * Build display names where duplicate filenames are disambiguated with a
 * `(2)`, `(3)`… suffix (before the extension), so same-named pages pulled from
 * different folders stay visually distinct in the preview/reorder strip. The
 * returned array is positionally aligned with `files`; the underlying File
 * objects are never mutated (upload still ships the real names).
 */
export function disambiguateImageFileNames(files: readonly File[]): string[] {
	const seen = new Map<string, number>();
	return files.map((file) => {
		const name = file.name;
		const count = seen.get(name) ?? 0;
		seen.set(name, count + 1);
		if (count === 0) return name;
		const dotIndex = name.lastIndexOf(".");
		if (dotIndex <= 0) return `${name} (${count + 1})`;
		return `${name.slice(0, dotIndex)} (${count + 1})${name.slice(dotIndex)}`;
	});
}

export function unsupportedImageFileNames(files: readonly File[]): string[] {
	return files
		.filter((file) => !isSupportedImageFile(file))
		.map((file) => file.name);
}

export function formatUnsupportedImageFileSummary(files: readonly File[], limit = 3): string {
	const names = unsupportedImageFileNames(files);
	if (!names.length) return "";
	const shown = names.slice(0, Math.max(1, limit));
	const suffix = names.length > shown.length ? `, +${names.length - shown.length} ไฟล์` : "";
	return `ไฟล์ไม่รองรับ ${names.length} ไฟล์: ${shown.join(", ")}${suffix}`;
}
