import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import PageRelinkConfirmationDialog from "$lib/components/PageRelinkConfirmationDialog.svelte";
import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
import type { PageImageRelinkPlan } from "$lib/project/page-relink.js";

function imageFile(name: string): File {
	return new File(["image"], name, { type: "image/webp" });
}

function fallbackPlan(): PageImageRelinkPlan {
	return {
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
		],
		unmatchedPageIndexes: [2],
		unusedFiles: [imageFile("extra.webp")],
	};
}

describe("PageRelinkConfirmationDialog", () => {
	afterEach(() => {
		pageRelinkConfirmationStore.cancel();
	});

	it("resolves immediately when order fallback is not required", async () => {
		await expect(pageRelinkConfirmationStore.confirmOrderFallback({
			plan: {
				matches: [],
				unmatchedPageIndexes: [],
				unusedFiles: [],
			},
			orderMatchedCount: 0,
			requiresOrderConfirmation: false,
		})).resolves.toBe(true);
		expect(pageRelinkConfirmationStore.request).toBeNull();
	});

	it("shows order fallback พรีวิว and resolves cancel", async () => {
		const result = pageRelinkConfirmationStore.confirmOrderFallback({
			plan: fallbackPlan(),
			nameMatchedCount: 1,
			orderMatchedCount: 1,
			requiresOrderConfirmation: true,
			unsupportedSummary: "ไฟล์ไม่รองรับ 1 ไฟล์: cover.avif",
		});

		render(PageRelinkConfirmationDialog);

		expect(await screen.findByText("ตรวจลำดับรูปก่อนแทนที่ทั้งตอน")).toBeTruthy();
		expect(screen.getByText("scan-002.webp")).toBeTruthy();
		expect(screen.getByText("ocr-b.png")).toBeTruthy();
		expect(screen.getByText("ไฟล์ไม่รองรับ 1 ไฟล์: cover.avif")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /ยกเลิก กลับไปเช็กลำดับ/i }));
		await expect(result).resolves.toBe(false);
	});

	it("resolves confirm from the in-app decision", async () => {
		const result = pageRelinkConfirmationStore.confirmOrderFallback({
			plan: fallbackPlan(),
			nameMatchedCount: 1,
			orderMatchedCount: 1,
			requiresOrderConfirmation: true,
		});

		render(PageRelinkConfirmationDialog);

		await fireEvent.click(await screen.findByRole("button", { name: /ยืนยันกู้รูป/i }));
		await expect(result).resolves.toBe(true);
	});
});
