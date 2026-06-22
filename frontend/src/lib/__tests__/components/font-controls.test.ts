import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import FontPicker from "$lib/components/FontPicker.svelte";
import FontSizePicker from "$lib/components/FontSizePicker.svelte";

describe("Font controls", () => {
	it("changes fonts through real options when available", async () => {
		const onFontChange = vi.fn();

		render(FontPicker, {
			props: {
				selectedFont: "Arial, sans-serif",
				onFontChange,
			},
		});

		// Trigger is an accessible combobox; options are role="option" inside the
		// role="listbox" popup (a11y migration W3.x).
		await fireEvent.click(screen.getByRole("combobox", { name: /Arial/ }));
		await fireEvent.click(screen.getByRole("option", { name: "Prompt" }));

		expect(onFontChange).toHaveBeenCalledWith("'Prompt', sans-serif");
	});

	it("is keyboard operable: arrow keys move, Enter selects, Escape closes", async () => {
		const onFontChange = vi.fn();

		render(FontPicker, {
			props: {
				selectedFont: "Arial, sans-serif",
				onFontChange,
			},
		});

		const trigger = screen.getByRole("combobox", { name: /Arial/ });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");

		// ArrowDown opens the listbox.
		await fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("listbox")).toBeTruthy();

		// Escape closes without selecting.
		await fireEvent.keyDown(trigger, { key: "Escape" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(onFontChange).not.toHaveBeenCalled();

		// Reopen, move to the first option, and select with Enter.
		await fireEvent.keyDown(trigger, { key: "ArrowDown" });
		await fireEvent.keyDown(trigger, { key: "Home" });
		await fireEvent.keyDown(trigger, { key: "Enter" });
		// First option is the first font in render order (Sarabun).
		expect(onFontChange).toHaveBeenCalledWith("'Sarabun', sans-serif");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("renders disabled font selection as a passive receipt", () => {
		render(FontPicker, {
			props: {
				selectedFont: "Arial, sans-serif",
				onFontChange: vi.fn(),
				disabled: true,
			},
		});

		expect(screen.queryByRole("button", { name: /Arial/ })).toBeNull();
		expect(screen.getByRole("status", { name: "ฟอนต์อ่านอย่างเดียว" }).textContent).toContain("อ่านอย่างเดียว");
	});

	it("changes font size through presets when available", async () => {
		const onSizeChange = vi.fn();

		render(FontSizePicker, {
			props: {
				selectedSize: 18,
				onSizeChange,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "24" }));

		expect(onSizeChange).toHaveBeenCalledWith(24);
	});

	it("renders disabled font size as a passive receipt", () => {
		render(FontSizePicker, {
			props: {
				selectedSize: 32,
				onSizeChange: vi.fn(),
				disabled: true,
			},
		});

		expect(screen.queryByRole("button", { name: "32" })).toBeNull();
		expect(screen.queryByRole("spinbutton")).toBeNull();
		expect(screen.getByRole("status", { name: "ขนาดตัวอักษรอ่านอย่างเดียว" }).textContent).toContain("32px");
	});

	it("uses passive receipts instead of no-op custom size edges", async () => {
		render(FontSizePicker, {
			props: {
				selectedSize: 8,
				onSizeChange: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "กำหนดเอง" }));

		expect(screen.queryByRole("button", { name: "ลดขนาดตัวอักษร" })).toBeNull();
		expect(screen.getByLabelText("ขนาดต่ำสุด").textContent).toBe("ต่ำสุด");
		expect(screen.getByRole("button", { name: "เพิ่มขนาดตัวอักษร" })).toBeTruthy();
	});

	it("renders compact font size controls without the panel preview", async () => {
		const onSizeChange = vi.fn();

		render(FontSizePicker, {
			props: {
				selectedSize: 24,
				onSizeChange,
				compact: true,
			},
		});

		expect(screen.queryByText("กำหนดเอง")).toBeNull();
		expect(screen.queryByText("Aa")).toBeNull();
		expect(screen.getByLabelText("ขนาดตัวอักษร")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มขนาดตัวอักษร" }));

		expect(onSizeChange).toHaveBeenCalledWith(26);
	});
});
