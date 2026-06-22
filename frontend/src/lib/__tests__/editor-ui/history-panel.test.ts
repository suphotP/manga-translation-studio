import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import HistoryPanel, { type HistoryEntry } from "$lib/editor-ui/HistoryPanel.svelte";

const NOW = "2026-06-11T10:00:00.000Z";

function entries(): HistoryEntry[] {
	return [
		{ id: "start", label: "เปิดหน้า", at: "2026-06-11T09:59:40.000Z" },
		{ id: "text", label: "เพิ่มข้อความ", at: "2026-06-11T09:50:00.000Z" },
		{ id: "clean", label: "ลบพื้นหลังบอลลูน", at: "2026-06-11T07:00:00.000Z" },
	];
}

function isDisabled(name: string): boolean {
	return (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
}

describe("HistoryPanel", () => {
	it("renders Thai labels, relative times, and highlights the current entry", () => {
		render(HistoryPanel, {
			props: {
				entries: entries(),
				currentIndex: 1,
				now: NOW,
				onJump: vi.fn(),
			},
		});

		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();
		expect(screen.getByText("3 รายการ")).toBeTruthy();
		expect(screen.getAllByText("เพิ่มข้อความ").length).toBeGreaterThan(0);
		expect(screen.getByText("เมื่อสักครู่")).toBeTruthy();
		expect(screen.getByText("10 นาทีที่แล้ว")).toBeTruthy();
		expect(screen.getByText("3 ชั่วโมงที่แล้ว")).toBeTruthy();

		const currentRow = screen.getByRole("button", { name: "ไปยังประวัติ 2: เพิ่มข้อความ" });
		expect(currentRow.getAttribute("aria-current")).toBe("step");
		expect((currentRow as HTMLButtonElement).disabled).toBe(true);
		expect(within(currentRow).getByText("ปัจจุบัน")).toBeTruthy();
	});

	it("jumps backward, forward, and directly to a history row", async () => {
		const onJump = vi.fn();
		render(HistoryPanel, {
			props: {
				entries: entries(),
				currentIndex: 1,
				now: NOW,
				onJump,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
		await fireEvent.click(screen.getByRole("button", { name: "เดินหน้า" }));
		await fireEvent.click(screen.getByRole("button", { name: "ไปยังประวัติ 1: เปิดหน้า" }));

		expect(onJump).toHaveBeenNthCalledWith(1, 0);
		expect(onJump).toHaveBeenNthCalledWith(2, 2);
		expect(onJump).toHaveBeenNthCalledWith(3, 0);
		expect(onJump).toHaveBeenCalledTimes(3);
	});

	it("disables unavailable navigation at both ends", async () => {
		const { rerender } = render(HistoryPanel, {
			props: {
				entries: entries(),
				currentIndex: 0,
				now: NOW,
				onJump: vi.fn(),
			},
		});

		// Back is available at index 0 on purpose: it jumps to the pre-edit
		// baseline (-1) — codex P2.
		expect(isDisabled("ย้อนกลับ")).toBe(false);
		expect(isDisabled("เดินหน้า")).toBe(false);

		await rerender({
			entries: entries(),
			currentIndex: 2,
			now: NOW,
			onJump: vi.fn(),
		});

		expect(isDisabled("ย้อนกลับ")).toBe(false);
		expect(isDisabled("เดินหน้า")).toBe(true);
	});

	it("allows redo from the baseline state after every entry has been undone", async () => {
		const onJump = vi.fn();
		render(HistoryPanel, {
			props: {
				entries: entries(),
				currentIndex: -1,
				now: NOW,
				onJump,
			},
		});

		expect(isDisabled("ย้อนกลับ")).toBe(true);
		expect(isDisabled("เดินหน้า")).toBe(false);

		await fireEvent.click(screen.getByRole("button", { name: "เดินหน้า" }));

		expect(onJump).toHaveBeenCalledWith(0);
	});

	it("renders an empty state and blocks navigation when there are no entries", async () => {
		const onJump = vi.fn();
		render(HistoryPanel, {
			props: {
				entries: [],
				currentIndex: -1,
				now: NOW,
				onJump,
			},
		});

		expect(screen.getByText("ยังไม่มีประวัติการแก้ไข")).toBeTruthy();
		expect(screen.getByText("0 รายการ")).toBeTruthy();
		expect(isDisabled("ย้อนกลับ")).toBe(true);
		expect(isDisabled("เดินหน้า")).toBe(true);

		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
		await fireEvent.click(screen.getByRole("button", { name: "เดินหน้า" }));

		expect(onJump).not.toHaveBeenCalled();
	});

	it("fails closed for an out-of-range current index and unclear timestamps", async () => {
		const onJump = vi.fn();
		render(HistoryPanel, {
			props: {
				entries: [{ id: "bad-time", label: "Importข้อมูล", at: "not-a-date" }],
				currentIndex: 5,
				now: NOW,
				onJump,
			},
		});

		expect(screen.getByText("ยังไม่มีจุดปัจจุบัน")).toBeTruthy();
		expect(screen.getByText("เวลาไม่ชัดเจน")).toBeTruthy();
		expect(isDisabled("ย้อนกลับ")).toBe(true);
		expect(isDisabled("เดินหน้า")).toBe(true);

		await fireEvent.click(screen.getByRole("button", { name: "ไปยังประวัติ 1: Importข้อมูล" }));

		expect(onJump).toHaveBeenCalledWith(0);
	});
});
