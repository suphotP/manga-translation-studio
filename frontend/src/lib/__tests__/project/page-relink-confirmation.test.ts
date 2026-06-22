import { describe, expect, it, vi } from "vitest";
import {
	buildPageImageRelinkOrderFallbackPreview,
	confirmPageImageRelinkOrderFallback,
	pageImageRelinkOrderFallbackCancelMessage,
} from "$lib/project/page-relink-confirmation.js";
import type { PageImageRelinkPlan } from "$lib/project/page-relink.js";

function imageFile(name: string): File {
	return new File(["image"], name, { type: "image/webp" });
}

describe("confirmPageImageRelinkOrderFallback", () => {
	it("skips confirmation when all matches are filename based", () => {
		const confirm = vi.fn(() => false);
		const plan: PageImageRelinkPlan = {
			matches: [{
				pageIndex: 0,
				file: imageFile("page-1.webp"),
				expectedNames: ["page-1.webp"],
				matchedBy: "name",
			}],
			unmatchedPageIndexes: [],
			unusedFiles: [],
		};

		expect(confirmPageImageRelinkOrderFallback({
			plan,
			orderMatchedCount: 0,
			requiresOrderConfirmation: false,
		}, confirm)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("shows a page/file พรีวิว before order fallback relink", () => {
		const confirm = vi.fn(() => true);
		const plan: PageImageRelinkPlan = {
			matches: [{
				pageIndex: 1,
				file: imageFile("scan-002.webp"),
				expectedNames: ["ocr-b.png"],
				matchedBy: "order",
			}],
			unmatchedPageIndexes: [],
			unusedFiles: [],
		};

		expect(confirmPageImageRelinkOrderFallback({
			plan,
			orderMatchedCount: 1,
			requiresOrderConfirmation: true,
		}, confirm)).toBe(true);
		expect(confirm.mock.calls[0][0]).toContain("หน้า 2 -> scan-002.webp");
		expect(pageImageRelinkOrderFallbackCancelMessage).toContain("ยกเลิกกู้รูป");
	});

	it("builds an in-app order fallback preview with match counts and hidden rows", () => {
		const plan: PageImageRelinkPlan = {
			matches: [
				{
					pageIndex: 0,
					file: imageFile("exact.webp"),
					expectedNames: ["exact.webp"],
					matchedBy: "name",
				},
				{
					pageIndex: 1,
					file: imageFile("scan-002.webp"),
					expectedNames: ["ocr-b.png"],
					matchedBy: "order",
				},
				{
					pageIndex: 2,
					file: imageFile("scan-003.webp"),
					expectedNames: [],
					matchedBy: "order",
				},
			],
			unmatchedPageIndexes: [3],
			unusedFiles: [imageFile("extra.webp")],
		};

		const preview = buildPageImageRelinkOrderFallbackPreview({
			plan,
			nameMatchedCount: 1,
			orderMatchedCount: 2,
			requiresOrderConfirmation: true,
			unsupportedSummary: "ไฟล์ไม่รองรับ 1 ไฟล์: cover.avif",
		}, 1);

		expect(preview.rows).toEqual([{
			pageIndex: 1,
			pageLabel: "หน้า 2",
			fileName: "scan-002.webp",
			expectedName: "ocr-b.png",
		}]);
		expect(preview.hiddenRowCount).toBe(1);
		expect(preview.nameMatchedCount).toBe(1);
		expect(preview.unmatchedPageCount).toBe(1);
		expect(preview.unusedFileCount).toBe(1);
		expect(preview.unsupportedSummary).toBe("ไฟล์ไม่รองรับ 1 ไฟล์: cover.avif");
	});
});
