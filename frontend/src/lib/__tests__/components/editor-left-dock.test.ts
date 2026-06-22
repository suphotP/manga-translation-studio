import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import "$lib/i18n";
import EditorLeftDock from "$lib/components/editor/EditorLeftDock.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { toolRegistry } from "$lib/editor/tool-registry.svelte.ts";
import { toolIconPath } from "$lib/editor-ui/tool-icons";

beforeEach(() => {
	// duty filter (2026-06-13): the dock now renders per-duty — tests assert the
	// FULL palette, so run them as an authenticated account-role editor.
	(authStore as any).user = { id: "test-user", email: "dock@test.local", role: "editor", name: "Dock Tester" };
	(authStore as any).status = "authenticated";
	editorStore.currentTool = "select";
	editorStore.selectedLayer = null;
	editorStore.selectedImageLayer = null;
	editorStore.editor = null;
	editorUiStore.__resetForTesting();
	toolRegistry.__resetToBuiltins();
});

describe("EditorLeftDock", () => {
	// Accessible name is the aria-label (the human title); the keyboard shortcut
	// lives only in the `title` tooltip, so it is not part of the accessible name.
	it("renders the registry tools with readable labels and shortcut hints", () => {
		render(EditorLeftDock);

		expect(screen.getByRole("button", { name: "เลือก / ขยับวัตถุบนหน้า" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เลือกพื้นที่ตามสัดส่วน (สำหรับ AI / จัดกรอบ)" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "วางกล่องข้อความใหม่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /แปรงคลีน/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /AI Clean \/ SFX/ })).toBeTruthy();
		// Shortcut hint badges are present in the tooltip / overlay.
		expect(screen.getByTitle("เลือก / ขยับวัตถุบนหน้า (V)")).toBeTruthy();
		expect(screen.getByTitle("เลือกพื้นที่ตามสัดส่วน (สำหรับ AI / จัดกรอบ) (C)")).toBeTruthy();
	});

	it("renders mapped dock tools as shared SVG path icons", () => {
		render(EditorLeftDock);

		const selectButton = screen.getByRole("button", { name: "เลือก / ขยับวัตถุบนหน้า" });
		const icon = selectButton.querySelector(".dock-tool-icon");
		const path = icon?.querySelector("svg path");

		expect(icon?.textContent?.trim()).toBe("");
		expect(path?.getAttribute("d")).toBe(toolIconPath("select"));
		expect(icon?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
	});

	it("falls back to the registry glyph when a registered tool has no SVG map", () => {
		const unregister = toolRegistry.register({
			id: "transform",
			label: "Transform",
			title: "Fallback Transform",
			icon: "✥",
			engineTool: "select",
			optionsContext: "select",
			group: "image",
			order: 99,
		});

		try {
			render(EditorLeftDock);

			const fallbackButton = screen.getByRole("button", { name: "Fallback Transform" });
			const icon = fallbackButton.querySelector(".dock-tool-icon");

			expect(icon?.querySelector("svg")).toBeNull();
			expect(icon?.textContent?.trim()).toBe("✥");
		} finally {
			unregister();
		}
	});

	it("activates the crop tool through the shared cover engine tool", async () => {
		render(EditorLeftDock);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกพื้นที่ตามสัดส่วน (สำหรับ AI / จัดกรอบ)" }));
		expect(editorUiStore.activeDockTool).toBe("crop");
		expect(editorStore.currentTool).toBe("cover");
	});

	it("routes the AI tool to the AI inspector and keeps it disambiguated from crop", async () => {
		render(EditorLeftDock);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกพื้นที่สำหรับ AI Clean / SFX" }));
		expect(editorUiStore.activeDockTool).toBe("cover");
		expect(editorStore.currentTool).toBe("cover");
		expect(editorUiStore.rightPanelMode).toBe("ai");
	});

	it("syncs the dock tool back to the engine when changed from outside the dock", async () => {
		render(EditorLeftDock);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกพื้นที่ตามสัดส่วน (สำหรับ AI / จัดกรอบ)" }));
		expect(editorUiStore.activeDockTool).toBe("crop");

		// Simulate a keyboard shortcut / programmatic engine change (e.g. press V).
		editorStore.currentTool = "select";
		await Promise.resolve();
		expect(editorUiStore.activeDockTool).toBe("select");
	});

	it("shows delete and rotate only when a layer is selected", async () => {
		const { rerender } = render(EditorLeftDock);
		expect(screen.queryByRole("button", { name: "ลบกล่องข้อความที่เลือก" })).toBeNull();

		editorStore.selectedLayer = { id: "text-1", text: "hi" } as any;
		await rerender({});
		expect(screen.getByRole("button", { name: "ลบกล่องข้อความที่เลือก" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "หมุนกล่องข้อความที่เลือก" })).toBeTruthy();
	});

	it("dock Delete works for an IMAGE layer too (matches keyboard-Delete)", async () => {
		const calls: string[] = [];
		// Stub the store delete methods so we can see which one the dock invokes.
		const origText = editorStore.deleteTextLayer;
		const origImage = editorStore.deleteImageLayer;
		editorStore.deleteTextLayer = (() => { calls.push("text"); }) as any;
		editorStore.deleteImageLayer = (() => { calls.push("image"); }) as any;
		try {
			const { rerender } = render(EditorLeftDock);
			// No selection → no delete button.
			expect(screen.queryByRole("button", { name: /^ลบ/ })).toBeNull();

			// Select an IMAGE layer only.
			editorStore.selectedLayer = null;
			editorStore.selectedImageLayer = { id: "image-1" } as any;
			await rerender({});

			const del = screen.getByRole("button", { name: "ลบเลเยอร์รูปที่เลือก" });
			expect(del).toBeTruthy();
			// Rotate (text-only) must NOT show for an image-only selection.
			expect(screen.queryByRole("button", { name: "หมุนกล่องข้อความที่เลือก" })).toBeNull();

			await fireEvent.click(del);
			expect(calls).toEqual(["image"]);
		} finally {
			editorStore.deleteTextLayer = origText;
			editorStore.deleteImageLayer = origImage;
			editorStore.selectedImageLayer = null;
		}
	});
});
