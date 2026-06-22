import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ImportRemapDialog from "$lib/components/ImportRemapDialog.svelte";
import { importRemapStore } from "$lib/stores/import-remap.svelte.ts";
import "$lib/i18n";

describe("ImportRemapDialog", () => {
	afterEach(() => {
		importRemapStore.cancel();
	});

	it("defaults mapping by image order and applies manual remaps", async () => {
		const result = importRemapStore.open({
			projectPageCount: 2,
			targetPageIndex: 0,
			targetImageName: "page-001.webp",
			targetLang: "en",
			targetPages: [
				{ pageIndex: 0, imageName: "upload-005.webp", originalName: "page-005.webp" },
				{ pageIndex: 1, imageName: "upload-006.webp", originalName: "page-006.webp" },
			],
			options: [
				{
					id: "page-number:5",
					kind: "pageNumber",
					pageNumber: 5,
					entryCount: 2,
					sourcePageIndex: 4,
					sourcePageNumber: 5,
				},
				{
					id: "page-number:8",
					kind: "pageNumber",
					pageNumber: 8,
					entryCount: 1,
					sourcePageIndex: 7,
					sourcePageNumber: 8,
				},
			],
		});

		render(ImportRemapDialog);

		expect(await screen.findByText("เลือกต้นทาง JSON ให้ตรงกับหน้าในตอน")).toBeTruthy();
		expect(screen.getByLabelText("ปลายทาง Import JSON").textContent).toContain("EN / 2 หน้า / เลเยอร์ดราฟต์");
		expect(screen.getByText("ต้นทางใน JSON")).toBeTruthy();
		expect(screen.getByText("มี 2 ต้นทางที่อยู่นอกช่วงหน้าในตอนนี้ ตรวจชื่อไฟล์หรือเลือกเว้นไว้ก่อนถ้ายังไม่แน่ใจ")).toBeTruthy();
		expect(screen.getByText("เลขหน้า 5 ในไฟล์ JSON / อยู่นอกช่วง 2 หน้าในตอนนี้")).toBeTruthy();

		const firstSelect = screen.getByLabelText(/ต้นทาง JSON สำหรับ หน้า 1/i) as HTMLSelectElement;
		const secondSelect = screen.getByLabelText(/ต้นทาง JSON สำหรับ หน้า 2/i) as HTMLSelectElement;

		await waitFor(() => {
			expect(firstSelect.value).toBe("page-number:5");
			expect(secondSelect.value).toBe("page-number:8");
		});

		await fireEvent.change(firstSelect, { target: { value: "page-number:8" } });
		await fireEvent.change(secondSelect, { target: { value: "" } });
		expect(screen.getByText("เว้นไว้ก่อน")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ใช้การจับคู่นี้" }));

		await expect(result).resolves.toEqual([
			{ targetPageIndex: 0, sourceOptionId: "page-number:8" },
			{ targetPageIndex: 1, sourceOptionId: null },
		]);
	});

	it("shows a passive receipt when no JSON source is selected", async () => {
		importRemapStore.open({
			projectPageCount: 1,
			targetPageIndex: 0,
			targetImageName: "page-001.webp",
			targetPages: [
				{ pageIndex: 0, imageName: "upload-001.webp", originalName: "page-001.webp" },
			],
			options: [],
		});

		render(ImportRemapDialog);

		expect(await screen.findByText("เลือกต้นทาง JSON ให้ตรงกับหน้าในตอน")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ใช้การจับคู่นี้" })).toBeNull();
		expect(screen.getByLabelText("สถานะใช้การจับคู่ JSON").textContent).toContain("เลือกต้นทางก่อน");
		expect(screen.queryAllByRole("button").some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
	});
});
