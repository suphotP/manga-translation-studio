import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "$lib/i18n";
import EasyModePanel from "$lib/components/editor/EasyModePanel.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { toolRegistry } from "$lib/editor/tool-registry.svelte.ts";

beforeEach(() => {
	vi.restoreAllMocks();
	editorStore.currentTool = "select";
	editorStore.activeImageTool = null;
	editorStore.editor = null;
	editorUiStore.__resetForTesting();
	projectStore.__resetForTesting();
	toolRegistry.__resetToBuiltins();
	// EasyMode now duty-filters recipes — seed a full-duty member so all recipes render.
	projectStore.currentWorkspaceMember = { memberStudioRole: "owner" } as any;
});

function expectTabPressed(name: RegExp, pressed: boolean): void {
	expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe(String(pressed));
}

describe("EasyModePanel", () => {
	it("activates the clean tool set through the live tool registry", async () => {
		const setImageTool = vi.spyOn(editorStore, "setImageTool").mockImplementation((id: any) => {
			editorStore.currentTool = "select";
			editorStore.activeImageTool = id;
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /คลีน: ลบตัวอักษร/ }));

		expect(setImageTool).toHaveBeenCalledWith("bubble-clean");
		expect(editorUiStore.activeDockTool).toBe("bubble-clean");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(projectStore.statusMsg).toContain("Easy Mode: คลีน");
		expect(screen.getByTitle("คลิกในบอลลูน")).toBeTruthy();
	});

	it("routes translate to the translate tool and the Translate inspector", async () => {
		vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /แปล: เปิดงานคำแปล/ }));

		// #E3: the translate recipe now opens the dedicated translate tool (click-bubble →
		// type in the right panel), not raw text placement + the Work inspector.
		expect(editorUiStore.activeDockTool).toBe("translate");
		expect(editorUiStore.rightPanelMode).toBe("translate");
		expect(projectStore.statusMsg).toContain("Easy Mode: แปล");
	});

	it("routes typeset to text placement and the Layers inspector", async () => {
		const startTextPlacement = vi.spyOn(editorStore, "startTextPlacement").mockImplementation(() => {
			editorStore.currentTool = "text";
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /ไทป์: จัดกล่องข้อความ/ }));

		expect(startTextPlacement).toHaveBeenCalled();
		expect(editorUiStore.activeDockTool).toBe("text");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(projectStore.statusMsg).toContain("Easy Mode: ไทป์");
	});

	it("keeps the clicked Typeset tab active when its primary text tool is shared with Translate", async () => {
		vi.spyOn(editorStore, "startTextPlacement").mockImplementation(() => {
			editorStore.currentTool = "text";
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /ไทป์: จัดกล่องข้อความ/ }));

		expect(editorUiStore.activeDockTool).toBe("text");
		expectTabPressed(/ไทป์: จัดกล่องข้อความ/, true);
		expectTabPressed(/แปล: เปิดงานคำแปล/, false);
	});

	it("follows dock switches to a tool owned by another recipe", async () => {
		vi.spyOn(editorStore, "setImageTool").mockImplementation((id: any) => {
			editorStore.activeImageTool = id;
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /คลีน: ลบตัวอักษร/ }));
		expectTabPressed(/คลีน: ลบตัวอักษร/, true);

		editorUiStore.setActiveDockTool("crop");
		await tick();

		expect(editorUiStore.activeDockTool).toBe("crop");
		expectTabPressed(/ไทป์: จัดกล่องข้อความ/, true);
		expectTabPressed(/คลีน: ลบตัวอักษร/, false);
	});

	it("keeps the latest clicked recipe when the dock tool is outside every easy-mode recipe", async () => {
		vi.spyOn(editorStore, "startTextPlacement").mockImplementation(() => {
			editorStore.currentTool = "text";
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /ไทป์: จัดกล่องข้อความ/ }));
		expectTabPressed(/ไทป์: จัดกล่องข้อความ/, true);

		editorUiStore.setActiveDockTool("bucket-fill");
		await tick();

		expect(editorUiStore.activeDockTool).toBe("bucket-fill");
		expectTabPressed(/ไทป์: จัดกล่องข้อความ/, true);
		expectTabPressed(/แปล: เปิดงานคำแปล/, false);
		expectTabPressed(/คลีน: ลบตัวอักษร/, false);
	});

	it("activates a secondary tool inside the selected mode", async () => {
		vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});
		const setImageTool = vi.spyOn(editorStore, "setImageTool").mockImplementation((id: any) => {
			editorStore.activeImageTool = id;
		});

		render(EasyModePanel);

		await fireEvent.click(screen.getByRole("button", { name: /คลีน: ลบตัวอักษร/ }));
		await fireEvent.click(screen.getByTitle("คลิกในบอลลูน"));

		expect(setImageTool).toHaveBeenCalledWith("bubble-clean");
		expect(editorUiStore.activeDockTool).toBe("bubble-clean");
	});
});
