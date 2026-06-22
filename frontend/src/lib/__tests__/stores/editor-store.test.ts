// Editor store tests

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	isEditorTextEntryTarget,
	matchesShortcutKey,
	resolvePageNavigationShortcut,
	resolveClipboardLayerSelection,
	resolveBrushTargetState,
	shouldHandleEditorShortcut,
	shouldHandleLayerClipboardEvent,
} from "$lib/stores/editor.svelte.ts";

vi.mock("$lib/canvas/editor.ts", () => ({
	MangaEditor: {
		create: vi.fn().mockResolvedValue({
			setTool: vi.fn(),
			setAspectRatio: vi.fn(),
			createDefaultCover: vi.fn(),
			addTextLayer: vi.fn(),
			removeTextLayer: vi.fn(),
			getAllTextLayers: vi.fn(() => []),
			destroy: vi.fn(),
			onTextLayerSelect: null as any,
			canvasWidth: 800,
			canvasHeight: 600,
			canvas: {
				setWidth: vi.fn(),
				setHeight: vi.fn(),
				renderAll: vi.fn(),
				getActiveObject: vi.fn(),
			},
		}),
		MAX_CANVAS_WIDTH: 1024,
	},
}));

vi.mock("$lib/config.js", () => ({
	config: {
		defaultText: "ข้อความ",
		defaultFontSize: 24,
	},
}));

// Mock the store itself since $state runes don't work in tests
function createMockEditorStore() {
	let currentTool = "select";
	let selectedLayer = null;
	let editor = null;
	let zoomLevel = 1;
	let canUndo = false;
	let canRedo = false;

	return {
		get currentTool() { return currentTool; },
		set currentTool(value) { currentTool = value; },
		get selectedLayer() { return selectedLayer; },
		set selectedLayer(value) { selectedLayer = value; },
		get editor() { return editor; },
		set editor(value) { editor = value; },
		get zoomLevel() { return zoomLevel; },
		set zoomLevel(value) { zoomLevel = value; },
		get canUndo() { return canUndo; },
		set canUndo(value) { canUndo = value; },
		get canRedo() { return canRedo; },
		set canRedo(value) { canRedo = value; },
		setTool(tool: string) {
			this.currentTool = tool;
			editor?.setTool(tool);
		},
		setAspectRatio(ratio: [number, number] | null) {
			editor?.setAspectRatio(ratio);
		},
		getCanvasDimensions() {
			if (!editor) return { width: 0, height: 0 };
			return {
				width: editor.canvasWidth || 0,
				height: editor.canvasHeight || 0,
			};
		},
		getZoomLevel() { return zoomLevel; },
		createDefaultCover() { editor?.createDefaultCover(); },
		addTextLayer() {
			if (!editor) return;
			const id = crypto.randomUUID();
			const layer = {
				id,
				text: "ข้อความ",
				x: 100,
				y: 100,
				w: 200,
				h: 60,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: editor.getAllTextLayers().length,
			};
			editor.addTextLayer(layer);
		},
		deleteTextLayer() {
			if (!selectedLayer || !editor) return;
			editor.removeTextLayer(selectedLayer.id);
			selectedLayer = null;
		},
		rotateText() {
			if (!selectedLayer || !editor) return;
			const active = editor.canvas.getActiveObject();
			if (active) {
				active.rotate((active.angle || 0) + 90);
				editor.canvas.renderAll();
			}
		},
		async init(canvasEl: HTMLCanvasElement) {
			const { MangaEditor } = await import("$lib/canvas/editor.ts");
			editor = await MangaEditor.create(canvasEl);
			return editor;
		},
		destroy() {
			if (editor) {
				editor.destroy();
				editor = null;
			}
		},
	};
}

describe("EditorStore", () => {
	let editorStore: any;
	let mockEditor: any;

	beforeEach(() => {
		// Ensure document is available (jsdom should provide this)
		if (typeof document === 'undefined') {
			(global as any).document = {
				createElement: vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })),
			};
		}

		editorStore = createMockEditorStore();
		editorStore = createMockEditorStore();

		mockEditor = {
			setTool: vi.fn(),
			setAspectRatio: vi.fn(),
			setCanvasSize: vi.fn(),
			calculateCanvasDimensions: vi.fn(),
			createDefaultCover: vi.fn(),
			addTextLayer: vi.fn(),
			removeTextLayer: vi.fn(),
			getAllTextLayers: vi.fn(() => []),
			destroy: vi.fn(),
			onTextLayerSelect: null as any,
			canvasWidth: 800,
			canvasHeight: 600,
			canvas: {
				setWidth: vi.fn(),
				setHeight: vi.fn(),
				renderAll: vi.fn(),
				getActiveObject: vi.fn(),
			},
		};

		editorStore.editor = null;
		editorStore.currentTool = "select";
		editorStore.selectedLayer = null;
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("should have default tool 'select'", () => {
			expect(editorStore.currentTool).toBe("select");
		});

		it("should have no selected layer", () => {
			expect(editorStore.selectedLayer).toBeNull();
		});

		it("should have no editor", () => {
			expect(editorStore.editor).toBeNull();
		});
	});

	describe("setTool", () => {
		it("updates current tool", () => {
			editorStore.editor = mockEditor;
			editorStore.setTool("cover");
			expect(editorStore.currentTool).toBe("cover");
			expect(mockEditor.setTool).toHaveBeenCalledWith("cover");
		});

		it("does nothing without editor", () => {
			editorStore.setTool("cover");
			expect(mockEditor.setTool).not.toHaveBeenCalled();
		});
	});

	describe("init", () => {
		it("creates and stores editor instance", async () => {
			const canvasEl = document.createElement("canvas");

			const result = await editorStore.init(canvasEl);

			expect(result).toBeDefined();
			expect(editorStore.editor).toBeDefined();
		});
	});

	describe("getCanvasDimensions", () => {
		it("returns dimensions with editor", () => {
			editorStore.editor = mockEditor;
			expect(editorStore.getCanvasDimensions()).toEqual({ width: 800, height: 600 });
		});

		it("returns zeros without editor", () => {
			expect(editorStore.getCanvasDimensions()).toEqual({ width: 0, height: 0 });
		});
	});

	describe("setAspectRatio", () => {
		it("delegates to editor", () => {
			editorStore.editor = mockEditor;
			editorStore.setAspectRatio([4, 3]);
			expect(mockEditor.setAspectRatio).toHaveBeenCalledWith([4, 3]);
		});

		it("does nothing without editor", () => {
			editorStore.setAspectRatio([4, 3]);
			expect(mockEditor.setAspectRatio).not.toHaveBeenCalled();
		});
	});

	describe("createDefaultCover", () => {
		it("delegates to editor", () => {
			editorStore.editor = mockEditor;
			editorStore.createDefaultCover();
			expect(mockEditor.createDefaultCover).toHaveBeenCalled();
		});

		it("does nothing without editor", () => {
			editorStore.createDefaultCover();
			expect(mockEditor.createDefaultCover).not.toHaveBeenCalled();
		});
	});

	describe("addTextLayer", () => {
		it("adds text layer with config defaults", () => {
			editorStore.editor = mockEditor;
			mockEditor.getAllTextLayers.mockReturnValue([]);

			editorStore.addTextLayer();

			expect(mockEditor.addTextLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "ข้อความ",
					fontSize: 24,
					x: 100,
					y: 100,
				})
			);
		});

		it("sets index based on existing layers", () => {
			editorStore.editor = mockEditor;
			mockEditor.getAllTextLayers.mockReturnValue([{ id: "1" }, { id: "2" }]);

			editorStore.addTextLayer();

			expect(mockEditor.addTextLayer).toHaveBeenCalledWith(
				expect.objectContaining({ index: 2 })
			);
		});

		it("does nothing without editor", () => {
			editorStore.addTextLayer();
			expect(mockEditor.addTextLayer).not.toHaveBeenCalled();
		});
	});

	describe("deleteTextLayer", () => {
		it("deletes selected layer", () => {
			editorStore.selectedLayer = { id: "abc" } as any;
			editorStore.editor = mockEditor;

			editorStore.deleteTextLayer();

			expect(mockEditor.removeTextLayer).toHaveBeenCalledWith("abc");
			expect(editorStore.selectedLayer).toBeNull();
		});

		it("does nothing without selection", () => {
			editorStore.selectedLayer = null;
			editorStore.editor = mockEditor;
			editorStore.deleteTextLayer();
			expect(mockEditor.removeTextLayer).not.toHaveBeenCalled();
		});

		it("does nothing without editor", () => {
			editorStore.selectedLayer = { id: "abc" } as any;
			editorStore.deleteTextLayer();
			expect(mockEditor.removeTextLayer).not.toHaveBeenCalled();
		});
	});

	describe("rotateText", () => {
		it("rotates active object by 90 degrees", () => {
			editorStore.selectedLayer = { id: "abc" } as any;
			editorStore.editor = mockEditor;
			const active = { angle: 45, rotate: vi.fn(function(this: any, deg: number) { this.angle = deg; }) };
			mockEditor.canvas.getActiveObject.mockReturnValue(active);

			editorStore.rotateText();

			expect(active.angle).toBe(135);
			expect(mockEditor.canvas.renderAll).toHaveBeenCalled();
		});

		it("does nothing without selection", () => {
			editorStore.selectedLayer = null;
			editorStore.editor = mockEditor;
			editorStore.rotateText();
			expect(mockEditor.canvas.renderAll).not.toHaveBeenCalled();
		});

		it("does nothing without active object", () => {
			editorStore.selectedLayer = { id: "abc" } as any;
			editorStore.editor = mockEditor;
			mockEditor.canvas.getActiveObject.mockReturnValue(null);
			editorStore.rotateText();
			expect(mockEditor.canvas.renderAll).not.toHaveBeenCalled();
		});
	});

	describe("destroy", () => {
		it("destroys editor and clears reference", () => {
			editorStore.editor = mockEditor;
			editorStore.destroy();
			expect(mockEditor.destroy).toHaveBeenCalled();
			expect(editorStore.editor).toBeNull();
		});

		it("does nothing without editor", () => {
			editorStore.destroy();
			expect(editorStore.editor).toBeNull();
		});

		// W4.8 leak fix: WorkspaceShell.onMount calls init() (building the Fabric
		// canvas + global listeners) and now WorkspaceShell.onDestroy calls
		// destroy(). Guard the contract so the canvas teardown actually runs after a
		// real init and is safe to call twice (idempotent) when the shell unmounts.
		it("disposes the editor created by init and is idempotent", () => {
			editorStore.editor = mockEditor;
			editorStore.destroy();
			expect(mockEditor.destroy).toHaveBeenCalledTimes(1);
			expect(editorStore.editor).toBeNull();

			// A second destroy (e.g. double-unmount) must not re-call editor.destroy.
			editorStore.destroy();
			expect(mockEditor.destroy).toHaveBeenCalledTimes(1);
			expect(editorStore.editor).toBeNull();
		});
	});

	describe("keyboard shortcut matching", () => {
		it("matches Latin key values and physical key codes from non-Latin keyboard layouts", () => {
			expect(matchesShortcutKey({ key: "c", code: "KeyC" } as KeyboardEvent, "c")).toBe(true);
			expect(matchesShortcutKey({ key: "แ", code: "KeyC" } as KeyboardEvent, "c")).toBe(true);
			expect(matchesShortcutKey({ key: "อ", code: "KeyV" } as KeyboardEvent, "v")).toBe(true);
			expect(matchesShortcutKey({ key: "x", code: "KeyX" } as KeyboardEvent, "c")).toBe(false);
		});
		it("resolves page navigation keys without stealing modified layer shortcuts", () => {
			expect(resolvePageNavigationShortcut({ key: "d", code: "KeyD" } as KeyboardEvent)).toBe("next");
			expect(resolvePageNavigationShortcut({ key: "ก", code: "KeyD" } as KeyboardEvent)).toBe("next");
			expect(resolvePageNavigationShortcut({ key: "a", code: "KeyA" } as KeyboardEvent)).toBe("prev");
			expect(resolvePageNavigationShortcut({ key: "PageDown", code: "PageDown" } as KeyboardEvent)).toBe("next");
			expect(resolvePageNavigationShortcut({ key: "ArrowLeft", code: "ArrowLeft" } as KeyboardEvent)).toBe("prev");
			expect(resolvePageNavigationShortcut({ key: "]", code: "BracketRight" } as KeyboardEvent)).toBe("next");
			expect(resolvePageNavigationShortcut({ key: "]", code: "BracketRight" } as KeyboardEvent, {
				ignoreBrushBracketKeys: true,
			})).toBeNull();
			expect(resolvePageNavigationShortcut({ key: "[", code: "BracketLeft" } as KeyboardEvent, {
				ignoreBrushBracketKeys: true,
			})).toBeNull();
			expect(resolvePageNavigationShortcut({ key: "ArrowLeft", code: "ArrowLeft" } as KeyboardEvent, {
				ignoreBrushBracketKeys: true,
			})).toBe("prev");
			expect(resolvePageNavigationShortcut({ key: "d", code: "KeyD", ctrlKey: true } as KeyboardEvent)).toBeNull();
			expect(resolvePageNavigationShortcut({ key: "d", code: "KeyD", metaKey: true } as KeyboardEvent)).toBeNull();
			expect(resolvePageNavigationShortcut({ key: "d", code: "KeyD", altKey: true } as KeyboardEvent)).toBeNull();
		});
		it("flips physical arrow keys for RTL reading while keeping logical keys stable", () => {
			expect(resolvePageNavigationShortcut({ key: "ArrowLeft", code: "ArrowLeft" } as KeyboardEvent, {
				readingDirection: "rtl",
			})).toBe("next");
			expect(resolvePageNavigationShortcut({ key: "ArrowRight", code: "ArrowRight" } as KeyboardEvent, {
				readingDirection: "rtl",
			})).toBe("prev");
			// Logical keys (PageUp/PageDown, A/D, brackets) never flip with direction.
			expect(resolvePageNavigationShortcut({ key: "PageUp", code: "PageUp" } as KeyboardEvent, {
				readingDirection: "rtl",
			})).toBe("prev");
			expect(resolvePageNavigationShortcut({ key: "a", code: "KeyA" } as KeyboardEvent, {
				readingDirection: "rtl",
			})).toBe("prev");
			expect(resolvePageNavigationShortcut({ key: "ArrowLeft", code: "ArrowLeft" } as KeyboardEvent, {
				readingDirection: "vertical",
			})).toBe("prev");
		});
	});

	describe("editor shortcut view gating (P1: no hijack on non-editor views)", () => {
		it("fires ONLY when the editor surface is the active workspace view", () => {
			// The global keydown listener lives for the whole WorkspaceShell, which also
			// hosts dashboard/library/etc. Editor shortcuts must be inert everywhere but
			// the editor view, or they hijack keys (V/T/B, Delete, Ctrl+Z) on those pages.
			expect(shouldHandleEditorShortcut("editor")).toBe(true);
			for (const view of [
				"dashboard",
				"library",
				"pages",
				"work",
				"import",
				"review",
				"settings",
				"reports",
			] as const) {
				expect(shouldHandleEditorShortcut(view)).toBe(false);
			}
		});
	});

	describe("shortcut text entry target detection", () => {
		it("keeps layer shortcuts active for Fabric canvas text input but not inspector form fields", () => {
			const realInput = document.createElement("input");
			const panelTextarea = document.createElement("textarea");
			const fabricContainer = document.createElement("div");
			fabricContainer.className = "canvas-container";
			const fabricTextarea = document.createElement("textarea");
			fabricContainer.appendChild(fabricTextarea);

			expect(isEditorTextEntryTarget(realInput)).toBe(true);
			expect(isEditorTextEntryTarget(panelTextarea)).toBe(true);
			expect(isEditorTextEntryTarget(fabricTextarea)).toBe(false);
			expect(isEditorTextEntryTarget(null)).toBe(false);
		});

		it("handles layer clipboard copy events outside normal form fields", () => {
			const input = document.createElement("input");
			const fabricContainer = document.createElement("div");
			fabricContainer.className = "canvas-container";
			const fabricTextarea = document.createElement("textarea");
			fabricContainer.appendChild(fabricTextarea);

			expect(shouldHandleLayerClipboardEvent(input)).toBe(false);
			expect(shouldHandleLayerClipboardEvent(fabricTextarea)).toBe(true);
			expect(shouldHandleLayerClipboardEvent(null)).toBe(true);
		});
	});

	describe("clipboard layer selection", () => {
		it("uses explicit text selection before falling back to canvas active object", () => {
			const selectedText = { id: "selected-text" } as any;
			const editor = {
				getActiveTextLayer: vi.fn(() => ({ id: "active-text" })),
				getActiveImageLayer: vi.fn(),
			};

			expect(resolveClipboardLayerSelection(selectedText, null, editor)).toEqual({
				kind: "text",
				layer: selectedText,
			});
			expect(editor.getActiveTextLayer).not.toHaveBeenCalled();
		});

		it("falls back to the active Fabric text layer when store selection is stale", () => {
			const activeText = { id: "active-text" } as any;
			const editor = {
				getActiveTextLayer: vi.fn(() => activeText),
				getActiveImageLayer: vi.fn(),
			};

			expect(resolveClipboardLayerSelection(null, null, editor)).toEqual({
				kind: "text",
				layer: activeText,
			});
			expect(editor.getActiveImageLayer).not.toHaveBeenCalled();
		});

		it("falls back to the active Fabric image layer when no text layer is selected", () => {
			const activeImage = { id: "active-image" } as any;
			const editor = {
				getActiveTextLayer: vi.fn(() => null),
				getActiveImageLayer: vi.fn(() => activeImage),
			};

			expect(resolveClipboardLayerSelection(null, null, editor)).toEqual({
				kind: "image",
				layer: activeImage,
			});
		});
	});
});

describe("resolveBrushTargetState", () => {
	it("blocks brush when no editable image layer or AI mask exists", () => {
		const target = resolveBrushTargetState(null, null, { hasAiMaskBrushTarget: () => false });

		expect(target.kind).toBe("unavailable");
		expect(target.canBrush).toBe(false);
		expect(target.scope).toContain("ภาพฐาน");
		expect(target.titleCode).toBe("pickTarget");
		expect(target.eraseLabelCode).toBe("layerErase");
		expect(target.restoreLabelCode).toBe("layerRestore");
	});

	it("uses a selected visible unlocked image layer as the brush target", () => {
		const target = resolveBrushTargetState(null, {
			id: "image-layer-1",
			name: "Clean overlay",
			imageId: "clean.png",
			imageName: "clean.png",
			restoreImageId: "credit-original.png",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		}, { hasAiMaskBrushTarget: () => false });

		expect(target.kind).toBe("image-layer");
		expect(target.canBrush).toBe(true);
		expect(target.canRestore).toBe(true);
		expect(target.label).toBe("เลเยอร์รูปแก้ไข");
		expect(target.title).toBe("Clean overlay");
		expect(target.titleCode).toBeNull();
		expect(target.eraseLabelCode).toBe("layerErase");
		expect(target.restoreLabelCode).toBe("layerRestore");
	});

	it("names selected AI result layers as the Brush target without flattening the page", () => {
		const target = resolveBrushTargetState(null, {
			id: "ai-result-marker-1",
			name: "ผล AI หน้า 1",
			imageId: "ai-result-marker-1.webp",
			imageName: "ai-result-marker-1.webp",
			restoreImageId: "ai-result-marker-1-original.webp",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		}, { hasAiMaskBrushTarget: () => false });

		expect(target.kind).toBe("image-layer");
		expect(target.canBrush).toBe(true);
		expect(target.canClearMask).toBe(false);
		expect(target.label).toBe("ผล AI ที่วางแล้ว");
		expect(target.detail).toContain("เฉพาะผล AI ที่วางเป็นเลเยอร์นี้");
		expect(target.detail).toContain("ภาพฐาน");
		expect(target.eraseLabelCode).toBe("aiResultErase");
		expect(target.restoreLabelCode).toBe("aiResultRestore");
		expect(target.restoreHint).toContain("ผล AI เดิมของเลเยอร์นี้");
	});

	it("blocks credit image layers from Clean brush targets", () => {
		const target = resolveBrushTargetState(null, {
			id: "credit-layer-1",
			name: "Credit overlay",
			imageId: "credit.png",
			imageName: "credit.png",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "credit",
		}, { hasAiMaskBrushTarget: () => false });

		expect(target.kind).toBe("unavailable");
		expect(target.canBrush).toBe(false);
		expect(target.label).toBe("เครดิตรูป");
		expect(target.detail).toContain("ไม่ใช้แปรงคลีน");
	});

	it("blocks selected locked or hidden image layers", () => {
		const locked = resolveBrushTargetState(null, {
			id: "locked-layer",
			imageId: "locked.png",
			imageName: "locked.png",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			locked: true,
		}, { hasAiMaskBrushTarget: () => true });

		expect(locked.kind).toBe("unavailable");
		expect(locked.canBrush).toBe(false);
		expect(locked.label).toBe("เลเยอร์ล็อก");
	});
});
