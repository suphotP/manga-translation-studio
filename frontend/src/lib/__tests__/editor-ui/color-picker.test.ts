import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ColorPickerPopover from "$lib/editor-ui/ColorPickerPopover.svelte";

function box(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		right: width,
		bottom: height,
		width,
		height,
		toJSON: () => ({}),
	};
}

describe("ColorPickerPopover", () => {
	it("does not render while closed", () => {
		render(ColorPickerPopover, {
			props: {
				color: "#ff0000",
				recent: ["#00ff00"],
				open: false,
				onPick: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(screen.queryByRole("dialog", { name: "ตัวเลือกสี" })).toBeNull();
	});

	it("renders the active color, normalized recent swatches, and close action", async () => {
		const onClose = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "abc",
				recent: ["#abc", "00ff00", "not-a-color", "#00FF00"],
				open: true,
				onPick: vi.fn(),
				onClose,
			},
		});

		expect(screen.getByRole("dialog", { name: "ตัวเลือกสี" })).toBeTruthy();
		expect(screen.getByText("#AABBCC")).toBeTruthy();
		expect(screen.getByRole("option", { name: "เลือกสี #AABBCC" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "เลือกสี #00FF00" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "เลือกสี not-a-color" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "ปิดตัวเลือกสี" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("accepts tool-specific heading and dialog labels", () => {
		render(ColorPickerPopover, {
			props: {
				color: "#ffffff",
				recent: [],
				open: true,
				label: "สีเติม",
				title: "เลือกสีเติม",
				ariaLabel: "ตัวเลือกสีเติม",
				onPick: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(screen.getByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeTruthy();
		expect(screen.getByText("สีเติม")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "เลือกสีเติม" })).toBeTruthy();
	});

	it("commits valid hex input and reverts invalid input", async () => {
		const onPick = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "#112233",
				recent: [],
				open: true,
				onPick,
				onClose: vi.fn(),
			},
		});

		const input = screen.getByRole("textbox", { name: "ค่า Hex" }) as HTMLInputElement;
		expect(input.value).toBe("#112233");

		await fireEvent.input(input, { target: { value: "abc" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onPick).toHaveBeenLastCalledWith("#AABBCC");

		await fireEvent.input(input, { target: { value: "nope" } });
		await fireEvent.blur(input);
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("#112233");
	});

	it("picks a recent swatch", async () => {
		const onPick = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "#112233",
				recent: ["#445566"],
				open: true,
				onPick,
				onClose: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("option", { name: "เลือกสี #445566" }));
		expect(onPick).toHaveBeenCalledWith("#445566");
	});

	it("maps the saturation/value square to the current hue", async () => {
		const onPick = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "#FF0000",
				recent: [],
				open: true,
				onPick,
				onClose: vi.fn(),
			},
		});

		const square = screen.getByRole("slider", { name: "พื้นที่เลือกความสดและความสว่าง" });
		vi.spyOn(square, "getBoundingClientRect").mockReturnValue(box(100, 100));

		await fireEvent.pointerDown(square, { clientX: 50, clientY: 25, pointerId: 1 });

		expect(onPick).toHaveBeenCalledWith("#BF6060");
	});

	it("maps the hue slider while preserving saturation and value", async () => {
		const onPick = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "#FF0000",
				recent: [],
				open: true,
				onPick,
				onClose: vi.fn(),
			},
		});

		const hueSlider = screen.getByRole("slider", { name: "แถบเลือกเฉดสี" });
		vi.spyOn(hueSlider, "getBoundingClientRect").mockReturnValue(box(360, 22));

		await fireEvent.pointerDown(hueSlider, { clientX: 120, clientY: 11, pointerId: 1 });

		expect(onPick).toHaveBeenCalledWith("#00FF00");
	});

	it("swaps the active foreground with the local background swatch", async () => {
		const onPick = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "#123456",
				recent: [],
				open: true,
				onPick,
				onClose: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "สลับสีหน้าและสีหลัง สีหลัง #FFFFFF" }));

		expect(onPick).toHaveBeenCalledWith("#FFFFFF");
		expect(screen.getByRole("button", { name: "สลับสีหน้าและสีหลัง สีหลัง #123456" })).toBeTruthy();
	});

	it("falls back safely for an invalid incoming color and closes on Escape", async () => {
		const onClose = vi.fn();

		render(ColorPickerPopover, {
			props: {
				color: "not-a-color",
				recent: [],
				open: true,
				onPick: vi.fn(),
				onClose,
			},
		});

		const dialog = screen.getByRole("dialog", { name: "ตัวเลือกสี" });
		expect(screen.getByText("#000000")).toBeTruthy();

		await fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
