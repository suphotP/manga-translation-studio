import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

beforeEach(() => {
	editorUiStore.__resetForTesting();
});

describe("editorUiStore", () => {
	it("persists text inspector focus requests for components that mount after the mode switch", () => {
		const handler = vi.fn();
		const unsubscribe = editorUiStore.onTextInspectorFocus(handler);

		editorUiStore.focusTextInspector("layer-1");

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.textInspectorFocusLayerId).toBe("layer-1");
		expect(editorUiStore.textInspectorFocusToken).toBe(1);
		expect(handler).toHaveBeenCalledWith("layer-1");

		unsubscribe();
		editorUiStore.focusTextInspector("layer-2");

		expect(editorUiStore.textInspectorFocusLayerId).toBe("layer-2");
		expect(editorUiStore.textInspectorFocusToken).toBe(2);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("persists image inspector focus requests for components that mount after the mode switch", () => {
		const handler = vi.fn();
		const unsubscribe = editorUiStore.onImageInspectorFocus(handler);

		editorUiStore.focusImageInspector("image-layer-1");

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("image-layer-1");
		expect(editorUiStore.imageInspectorFocusToken).toBe(1);
		expect(handler).toHaveBeenCalledWith("image-layer-1");

		unsubscribe();
		editorUiStore.focusImageInspector("image-layer-2");

		expect(editorUiStore.imageInspectorFocusLayerId).toBe("image-layer-2");
		expect(editorUiStore.imageInspectorFocusToken).toBe(2);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("tracks workspace dashboard/library/work/editor mode separately from right panel mode", () => {
		expect(editorUiStore.workspaceView).toBe("dashboard");
		expect(editorUiStore.workspaceMode).toBe("solo");

		editorUiStore.openLibrary("p104");

		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("p104");

		editorUiStore.openWorkBoard();

		expect(editorUiStore.workspaceView).toBe("work");

		editorUiStore.openPages({ exportHistory: true });

		expect(editorUiStore.workspaceView).toBe("pages");
		expect(editorUiStore.workspacePagesExportHistoryToken).toBe(1);

		editorUiStore.setWorkspaceView("editor");
		editorUiStore.setWorkspaceMode("team");

		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceMode).toBe("team");
		expect(localStorage.getItem("manga-editor.workspaceMode")).toBe("team");
		expect(editorUiStore.rightPanelMode).toBe("layers");

		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "p104",
			title: "P104",
			chapterLabel: "ตอน 104",
			language: "th",
			reason: "แก้ภาพหน้าแรก",
		});

		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceEditorEntry?.chapterLabel).toBe("ตอน 104");
		expect(sessionStorage.getItem("manga-editor.workspaceEditorEntry")).toContain("ตอน 104");

		editorUiStore.openEditor();

		expect(editorUiStore.workspaceEditorEntry?.chapterLabel).toBe("ตอน 104");

		editorUiStore.__resetForTesting();

		expect(editorUiStore.workspaceTitleKey).toBeNull();
		expect(editorUiStore.workspaceEditorEntry).toBeNull();
		expect(sessionStorage.getItem("manga-editor.workspaceEditorEntry")).toBeNull();
		expect(editorUiStore.workspacePagesExportHistoryToken).toBe(0);
	});

	it("lets the editor inspector collapse and reopens it for direct inspector targets", () => {
		expect(editorUiStore.inspectorOpen).toBe(true);

		editorUiStore.toggleInspector();
		expect(editorUiStore.inspectorOpen).toBe(false);

		editorUiStore.setRightPanelMode("project");
		expect(editorUiStore.rightPanelMode).toBe("project");
		expect(editorUiStore.inspectorOpen).toBe(true);

		editorUiStore.setInspectorOpen(false);
		editorUiStore.focusTextInspector("layer-1");

		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.inspectorOpen).toBe(true);

		editorUiStore.setInspectorOpen(false);
		editorUiStore.setRightPanelMode("work");
		editorUiStore.focusImageInspector("image-layer-1");

		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.inspectorOpen).toBe(true);
	});

	it("tracks canvas overlay visibility independently by work type", () => {
		expect(editorUiStore.canvasOverlayVisibility).toEqual({
			qc: true,
			comment: true,
			"ai-review": true,
		});

		editorUiStore.toggleCanvasOverlay("qc");
		editorUiStore.setCanvasOverlayVisible("comment", false);

		expect(editorUiStore.isCanvasOverlayVisible("qc")).toBe(false);
		expect(editorUiStore.isCanvasOverlayVisible("comment")).toBe(false);
		expect(editorUiStore.isCanvasOverlayVisible("ai-review")).toBe(true);

		editorUiStore.__resetForTesting();

		expect(editorUiStore.isCanvasOverlayVisible("qc")).toBe(true);
		expect(editorUiStore.isCanvasOverlayVisible("comment")).toBe(true);
		expect(editorUiStore.isCanvasOverlayVisible("ai-review")).toBe(true);
	});
});
