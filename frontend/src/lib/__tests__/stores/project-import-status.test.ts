import { describe, expect, it } from "vitest";
import { formatTranslationImportStatus } from "$lib/stores/project.svelte.ts";

describe("formatTranslationImportStatus", () => {
	it("explains order-mapped OCR filenames and skip reasons", () => {
		expect(formatTranslationImportStatus({
			imported: 2,
			skipped: 2,
			skippedByReason: {
				invalid_entry: 0,
				page_not_found: 1,
				invalid_layer: 1,
			},
			orderMapped: 2,
			orderMappedPaths: ["scan-001.webp", "scan-002.webp"],
			pages: [
				{
					pageIndex: 0,
					imageId: "asset-a.webp",
					imageName: "asset-a.webp",
					originalName: "page-a.webp",
					imported: 1,
				},
				{
					pageIndex: 1,
					imageId: "asset-b.webp",
					imageName: "asset-b.webp",
					originalName: "page-b.webp",
					imported: 1,
				},
			],
		})).toBe(
			"Import 2 เลเยอร์ข้อความครบ 2 หน้า, ข้าม 2 รายการ (1 หน้าไม่ตรง, 1 เลเยอร์ข้อความไม่ถูกต้อง); จับคู่ชื่อไฟล์ไม่ตรง 2 รายการตามลำดับหน้า (scan-001.webp, scan-002.webp) (page-a.webp: 1, page-b.webp: 1)",
		);
	});

	it("turns all-skipped parseable JSON into recovery copy", () => {
		expect(formatTranslationImportStatus({
			imported: 0,
			skipped: 3,
			skippedByReason: {
				invalid_entry: 1,
				page_not_found: 1,
				invalid_layer: 1,
			},
			pages: [],
		})).toBe(
			"Importไม่พบเลเยอร์ข้อความที่ใช้ได้: ข้าม 3 รายการ (1 รายการไม่ถูกต้อง, 1 หน้าไม่ตรง, 1 เลเยอร์ข้อความไม่ถูกต้อง)",
		);
	});

	it("explains source-filtered JSON with no matching import rows", () => {
		expect(formatTranslationImportStatus({
			imported: 0,
			skipped: 0,
			sourceFiltered: 4,
			sourceMappings: [
				{
					targetPageIndex: 0,
					sourcePageIndex: 9,
					sourcePageNumber: 10,
					ignoredEntries: 4,
					imported: 0,
				},
			],
			pages: [],
		})).toBe("Importไม่พบเลเยอร์ข้อความที่ใช้ได้: ต้นทาง JSON ที่เลือกไม่ตรง 4 รายการ");
	});

	it("explains explicit JSON source-page remaps", () => {
		expect(formatTranslationImportStatus({
			imported: 3,
			skipped: 0,
			sourceFiltered: 9,
			sourceMapped: {
				targetPageIndex: 0,
				sourcePageIndex: 4,
				sourcePageNumber: 5,
				ignoredEntries: 9,
			},
			pages: [
				{
					pageIndex: 0,
					imageId: "asset-5.webp",
					imageName: "asset-5.webp",
					originalName: "uploaded-page-05.webp",
					imported: 3,
				},
			],
		})).toBe(
			"Import 3 เลเยอร์ข้อความ; จับคู่ หน้า JSON 5 ไปหน้า 1, ข้ามต้นทางอื่น 9 รายการ (uploaded-page-05.webp: 3)",
		);
	});

	it("explains multi-page manual JSON source mappings", () => {
		expect(formatTranslationImportStatus({
			imported: 4,
			skipped: 1,
			sourceFiltered: 8,
			sourceMappings: [
				{
					targetPageIndex: 0,
					sourcePageIndex: 4,
					sourcePageNumber: 5,
					ignoredEntries: 4,
					imported: 2,
				},
				{
					targetPageIndex: 1,
					sourcePageIndex: 7,
					sourcePageNumber: 8,
					ignoredEntries: 4,
					imported: 2,
				},
			],
			pages: [
				{
					pageIndex: 0,
					imageId: "asset-5.webp",
					imageName: "asset-5.webp",
					originalName: "uploaded-page-05.webp",
					imported: 2,
				},
				{
					pageIndex: 1,
					imageId: "asset-8.webp",
					imageName: "asset-8.webp",
					originalName: "uploaded-page-08.webp",
					imported: 2,
				},
			],
		})).toBe(
			"Import 4 เลเยอร์ข้อความครบ 2 หน้า, ข้าม 1 รายการ; จับคู่ต้นทาง JSON เอง 2 หน้า หน้า JSON 5 -> หน้า 1, หน้า JSON 8 -> หน้า 2 (uploaded-page-05.webp: 2, uploaded-page-08.webp: 2)",
		);
	});
});
