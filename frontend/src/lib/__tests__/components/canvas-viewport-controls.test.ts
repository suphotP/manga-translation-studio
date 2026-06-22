import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import CanvasViewportControls from "$lib/components/CanvasViewportControls.svelte";

describe("CanvasViewportControls", () => {
	it("renders a compact zoom control and delegates actions", async () => {
		const onZoomOut = vi.fn();
		const onReset = vi.fn();
		const onZoomIn = vi.fn();

		render(CanvasViewportControls, {
			props: {
				zoom: 1.37,
				onZoomOut,
				onReset,
				onZoomIn,
			},
		});

		expect(screen.getByLabelText("คุมซูมบนภาพ")).toBeTruthy();
		expect(screen.getByRole("button", { name: "รีเซ็ต Zoom จาก 137%" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ซูมออก" }));
		await fireEvent.click(screen.getByRole("button", { name: "รีเซ็ต Zoom จาก 137%" }));
		await fireEvent.click(screen.getByRole("button", { name: "ซูมเข้า" }));

		expect(onZoomOut).toHaveBeenCalledTimes(1);
		expect(onReset).toHaveBeenCalledTimes(1);
		expect(onZoomIn).toHaveBeenCalledTimes(1);
	});

	it("renders passive receipts when the viewport cannot zoom", () => {
		render(CanvasViewportControls, {
			props: {
				zoom: 1,
				unavailable: true,
				onZoomOut: vi.fn(),
				onReset: vi.fn(),
				onZoomIn: vi.fn(),
			},
		});

		expect(screen.queryByRole("button", { name: "ซูมออก" })).toBeNull();
		expect(screen.queryByRole("button", { name: "รีเซ็ต Zoom จาก 100%" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ซูมเข้า" })).toBeNull();
		expect(screen.getByLabelText("ซูมออกยังไม่พร้อม").tagName).toBe("SPAN");
		expect(screen.getByLabelText("ซูม 100% ยังไม่พร้อม").tagName).toBe("SPAN");
		expect(screen.getByLabelText("ซูมเข้ายังไม่พร้อม").tagName).toBe("SPAN");
	});
});
