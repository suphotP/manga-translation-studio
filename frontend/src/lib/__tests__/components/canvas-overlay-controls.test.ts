import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import CanvasOverlayControls from "$lib/components/CanvasOverlayControls.svelte";
import type { CanvasOverlayVisibility, CanvasWorkOverlayKind } from "$lib/editor/overlay-priority.js";

const visible: CanvasOverlayVisibility = {
	qc: true,
	comment: true,
	"ai-review": true,
};

const counts: Record<CanvasWorkOverlayKind, number> = {
	qc: 2,
	comment: 1,
	"ai-review": 3,
};

describe("CanvasOverlayControls", () => {
	it("renders overlay counts and delegates toggles", async () => {
		const onToggle = vi.fn();

		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: true,
				onToggle,
			},
		});

		expect(screen.getByLabelText("ตัวกรองงานบนภาพ")).toBeTruthy();
		expect(screen.getByText("6")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ซ่อน QC บนภาพ" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "ซ่อน คอมเมนต์ บนภาพ" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ซ่อน AI บนภาพ" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ซ่อน คอมเมนต์ บนภาพ" }));

		expect(onToggle).toHaveBeenCalledWith("comment");
	});

	it("does not render when there are no overlay work items", () => {
		render(CanvasOverlayControls, {
			props: {
				counts: { qc: 0, comment: 0, "ai-review": 0 },
				visibility: visible,
				interactive: false,
				onToggle: vi.fn(),
			},
		});

		expect(screen.queryByLabelText("ตัวกรองงานบนภาพ")).toBeNull();
	});

	it("hides empty overlay lanes instead of showing dead controls", () => {
		render(CanvasOverlayControls, {
			props: {
				counts: { qc: 0, comment: 1, "ai-review": 0 },
				visibility: {
					qc: false,
					comment: true,
					"ai-review": true,
				},
				interactive: false,
				onToggle: vi.fn(),
			},
		});

		expect(screen.queryByRole("button", { name: "แสดง QC บนภาพ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ซ่อน AI บนภาพ" })).toBeNull();
		expect(screen.getByRole("button", { name: "ซ่อน คอมเมนต์ บนภาพ" })).toBeTruthy();
		expect(screen.getByLabelText("ตัวกรองงานบนภาพ").classList.contains("inactive")).toBe(true);
	});

	it("starts compact when the editor already has a Library entry handoff", async () => {
		const onToggle = vi.fn();

		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: true,
				compact: true,
				onToggle,
			},
		});

		expect(screen.getByRole("button", { name: /เปิดตัวกรองงานบนภาพ/ }).textContent).toContain("เช็ก");
		expect(screen.queryByRole("button", { name: "ซ่อน คอมเมนต์ บนภาพ" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /เปิดตัวกรองงานบนภาพ/ }));

		expect(screen.getByRole("button", { name: "ซ่อน คอมเมนต์ บนภาพ" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ย่อตัวกรองงานบนภาพ" }));
		expect(screen.getByRole("button", { name: /เปิดตัวกรองงานบนภาพ/ })).toBeTruthy();
	});

	it("keeps selected-layer inspector ownership quiet while preserving filter expansion", async () => {
		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: true,
				compact: true,
				quiet: true,
				onToggle: vi.fn(),
			},
		});

		const controls = screen.getByLabelText("ตัวกรองงานบนภาพ");
		expect(controls.classList.contains("quiet")).toBe(true);
		const summary = screen.getByRole("button", { name: /เปิดตัวกรองงานบนภาพ: 6 รายการ/ });
		expect(summary.textContent).toContain("งาน");
		expect(summary.textContent).not.toContain("โน้ต");
		expect(summary.textContent).not.toContain("AI");

		await fireEvent.click(summary);

		expect(screen.getByRole("button", { name: "ซ่อน AI บนภาพ" })).toBeTruthy();
	});

	it("keeps suppressed brush/tool state as a compact status chip", () => {
		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: false,
				suppressed: true,
				compact: true,
				onToggle: vi.fn(),
			},
		});

		const controls = screen.getByLabelText("ตัวกรองงานบนภาพ");
		expect(controls.classList.contains("suppressed")).toBe(true);
		expect(screen.getByLabelText("งานบนภาพซ่อนไว้ระหว่างใช้เครื่องมือ")).toBeTruthy();
		expect(screen.getByText("ซ่อนไว้")).toBeTruthy();
		expect(screen.queryByText("ซ่อนระหว่างแก้พื้นที่รูป")).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดตัวกรองงานบนภาพ" })).toBeNull();
	});

	it("keeps suppressed selected-owner state quiet without repeating hidden overlay kinds", () => {
		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: false,
				suppressed: true,
				compact: true,
				quiet: true,
				onToggle: vi.fn(),
			},
		});

		const controls = screen.getByLabelText("ตัวกรองงานบนภาพ");
		expect(controls.classList.contains("suppressed")).toBe(true);
		expect(controls.classList.contains("quiet")).toBe(true);
		expect(screen.getByLabelText("งานบนภาพซ่อนไว้ระหว่างใช้เครื่องมือ").textContent).toContain("ซ่อน");
		expect(screen.queryByText("โน้ต / AI")).toBeNull();
		expect(screen.queryByRole("button", { name: /เปิดตัวกรองงานบนภาพ/ })).toBeNull();
	});

	it("renders collapsible color legend", async () => {
		const onToggle = vi.fn();

		render(CanvasOverlayControls, {
			props: {
				counts,
				visibility: visible,
				interactive: true,
				onToggle,
			},
		});

		// Starts collapsed
		expect(screen.queryByLabelText("คำอธิบายสัญลักษณ์และสี")).toBeNull();

		// Toggle open
		const toggleBtn = screen.getByRole("button", { name: "แสดงคำอธิบายสัญลักษณ์สี" });
		expect(toggleBtn).toBeTruthy();
		await fireEvent.click(toggleBtn);

		// Now it should be visible
		expect(screen.getByLabelText("คำอธิบายสัญลักษณ์และสี")).toBeTruthy();
		expect(screen.getByText("QC: แจ้งเตือน (Warning)")).toBeTruthy();
		expect(screen.getByText("เลเยอร์ทั่วไป (Default)")).toBeTruthy();

		// Toggle closed
		await fireEvent.click(toggleBtn);
		expect(screen.queryByLabelText("คำอธิบายสัญลักษณ์และสี")).toBeNull();
	});
});
