import { describe, expect, it } from "vitest";
import {
	disambiguateImageFileNames,
	formatUnsupportedImageFileSummary,
	isSupportedImageFile,
	orderProjectImageFiles,
	SUPPORTED_IMAGE_ACCEPT,
	unsupportedImageFileNames,
} from "$lib/project/file-order.js";

function file(name: string, type = ""): File {
	return new File(["x"], name, { type });
}

describe("disambiguateImageFileNames", () => {
	it("suffixes duplicate names before the extension, leaving uniques untouched", () => {
		const names = disambiguateImageFileNames([
			file("01.png"),
			file("02.png"),
			file("01.png"),
			file("01.png"),
		]);
		expect(names).toEqual(["01.png", "02.png", "01 (2).png", "01 (3).png"]);
	});

	it("handles dotless / leading-dot names without dropping the suffix", () => {
		const names = disambiguateImageFileNames([file("page"), file("page"), file(".env"), file(".env")]);
		expect(names).toEqual(["page", "page (2)", ".env", ".env (2)"]);
	});
});

describe("orderProjectImageFiles", () => {
	it("keeps only supported images and sorts chapter pages by natural filename", () => {
		const ordered = orderProjectImageFiles([
			file("notes.json", "application/json"),
			file("image-10.webp", "image/webp"),
			file("image-02.webp", "image/webp"),
			file("image-1.webp", "image/webp"),
		]);

		expect(ordered.map((entry) => entry.name)).toEqual([
			"image-1.webp",
			"image-02.webp",
			"image-10.webp",
		]);
	});

	it("accepts image extensions when the browser does not provide a MIME type", () => {
		expect(isSupportedImageFile(file("page-01.WEBP"))).toBe(true);
		expect(isSupportedImageFile(file("ocr.json"))).toBe(false);
	});

	it("rejects browser image MIME types that the backend upload route cannot store", () => {
		expect(isSupportedImageFile(file("cover.avif", "image/avif"))).toBe(false);
		expect(isSupportedImageFile(file("vector.svg", "image/svg+xml"))).toBe(false);
		expect(isSupportedImageFile(file("camera.heic", "image/heic"))).toBe(false);
		expect(isSupportedImageFile(file("page", "image/webp"))).toBe(true);
	});

	it("summarizes unsupported files and exposes a strict picker accept list", () => {
		const files = [
			file("page-01.png", "image/png"),
			file("cover.avif", "image/avif"),
			file("vector.svg", "image/svg+xml"),
			file("notes.json", "application/json"),
			file("page-02.webp", "image/webp"),
		];

		expect(SUPPORTED_IMAGE_ACCEPT).toContain(".webp");
		expect(unsupportedImageFileNames(files)).toEqual(["cover.avif", "vector.svg", "notes.json"]);
		expect(formatUnsupportedImageFileSummary(files, 2)).toBe("ไฟล์ไม่รองรับ 3 ไฟล์: cover.avif, vector.svg, +1 ไฟล์");
	});
});
