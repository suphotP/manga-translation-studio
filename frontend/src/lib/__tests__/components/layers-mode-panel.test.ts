import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import LayersModePanel from "$lib/components/LayersModePanel.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { CreditPreset, ImageEditLayer, ImageLayer, Page, ProjectState, TextLayer, TextStylePreset } from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

const labels = {
	properties: "คุณสมบัติ",
	text: "Text",
	fontSize: "Font Size",
	alignment: "Alignment",
	alignmentLeft: "Left",
	alignmentCenter: "Center",
	alignmentRight: "Right",
	canvas: "Canvas",
	aspectRatio: "Aspect Ratio",
};

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "Translated line",
		x: 24,
		y: 48,
		w: 160,
		h: 72,
		rotation: 0,
		fontSize: 24,
		fontFamily: "Arial",
		fill: "#111111",
		stroke: "#ffffff",
		strokeWidth: 2,
		alignment: "center",
		index: 0,
		visible: true,
		locked: false,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "ref.webp",
		imageName: "ref.webp",
		originalName: "reference.webp",
		x: 40,
		y: 50,
		w: 200,
		h: 100,
		rotation: 0,
		opacity: 1,
		visible: true,
		locked: false,
		index: 0,
		role: "reference",
		...overrides,
	};
}

function imageEditLayer(overrides: Partial<ImageEditLayer> = {}): ImageEditLayer {
	return {
		id: "edit-layer-1",
		name: "Clean pass",
		kind: "fill-mask",
		target: "page-background",
		visible: true,
		locked: false,
		opacity: 0.8,
		sourceImageId: "image-1.webp",
		bbox: { x: 10, y: 12, w: 80, h: 40 },
		payload: {
			type: "fill-mask",
			maskAssetId: "mask-1.webp",
			maskEncoding: "png-alpha",
			fill: { r: 255, g: 255, b: 255, a: 1 },
		},
		index: 0,
		tool: { id: "bubble-clean" },
		createdAt: now,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function textStylePreset(overrides: Partial<TextStylePreset> = {}): TextStylePreset {
	return {
		id: "preset-sfx",
		name: "SFX",
		style: { fontSize: 36, alignment: "center" },
		promptTags: ["impact", "sfx"],
		...overrides,
	};
}

function creditPreset(overrides: Partial<CreditPreset> = {}): CreditPreset {
	return {
		id: "credit-bottom-center",
		name: "ล่างกลาง",
		text: "แปล / ไทป์เซ็ต",
		placement: "bottom",
		offset: 24,
		style: { fontSize: 18, fill: "#ffffff" },
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Layers mode test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		textStylePresets: [textStylePreset()],
		creditPresets: [creditPreset()],
		...overrides,
	};
}

function resetStores(): void {
	vi.restoreAllMocks();
	editorUiStore.__resetForTesting();
	projectStore.__resetForTesting();
	editorStore.currentTool = "select";
	editorStore.selectedLayer = null;
	editorStore.selectedImageLayer = null;
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.imageEditLayers = [];
	editorStore.editor = {
		canvasWidth: 800,
		canvasHeight: 600,
		getAllTextLayers: vi.fn(() => editorStore.textLayers),
		getAllImageLayers: vi.fn(() => editorStore.imageLayers),
	};
	editorStore.hasImage = false;
	editorStore.selectedAspectRatio = "1:1 Square";
}

beforeEach(() => {
	resetStores();
});

describe("LayersModePanel", () => {
	it("does not crash when two layers share an id (a duplicate_layer_id condition)", () => {
		// LayersPanelV2 keys its {#each} by `${kind}:${id}`. Two layers with the same id —
		// a real condition QC flags as duplicate_layer_id_* and that data-corruption bugs
		// have produced — used to throw Svelte's each_key_duplicate and crash the panel
		// (and, since it is always mounted in the shell, the surrounding view).
		const a = textLayer({ id: "dup-1", text: "A" });
		const b = textLayer({ id: "dup-1", text: "B", index: 1 });
		projectStore.__setProjectForTesting(project({ pages: [page({ textLayers: [a, b] })] }));
		editorStore.textLayers = [a, b];
		expect(() => render(LayersModePanel, { props: { labels } })).not.toThrow();
	});

	it("owns layer, credit, style, and canvas orchestration", async () => {
		const layer = textLayer();
		const savedPreset = textStylePreset({ id: "preset-saved", name: "Impact" });
		const savedCredit = creditPreset({ id: "credit-saved", name: "Saved credit" });
		const creditLayer = textLayer({ id: "credit-layer", text: "แปล / ไทป์เซ็ต", index: 1 });
		projectStore.__setProjectForTesting(project({ pages: [page({ textLayers: [layer] })] }));
		editorStore.textLayers = [layer];
		editorStore.selectedLayer = layer;
		editorStore.hasImage = true;

		const startTextPlacement = vi.spyOn(editorStore, "startTextPlacement").mockImplementation(() => {});
		const selectTextLayer = vi.spyOn(editorStore, "selectTextLayer").mockImplementation(() => {});
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation(() => {});
		const updateTextContent = vi.spyOn(editorStore, "updateTextContent").mockImplementation(() => {});
		const applyTextStylePreset = vi.spyOn(editorStore, "applyTextStylePreset").mockImplementation(() => {});
		const fitSelectedTextLayerToBox = vi.spyOn(editorStore, "fitSelectedTextLayerToBox").mockImplementation(() => {});
		const setAspectRatio = vi.spyOn(editorStore, "setAspectRatio").mockImplementation(() => {});
		const addCreditLayer = vi.spyOn(projectStore, "addCreditLayer").mockReturnValue(creditLayer);
		const saveCreditPreset = vi.spyOn(projectStore, "saveCreditPreset").mockResolvedValue(savedCredit);
		const saveTextStylePreset = vi.spyOn(projectStore, "saveTextStylePreset").mockResolvedValue(savedPreset);

		const { container } = render(LayersModePanel, { props: { labels } });

		const collapsedTextSection = screen.queryByRole("button", { name: "กล่องข้อความ พับอยู่" });
		if (collapsedTextSection) {
			await fireEvent.click(collapsedTextSection);
		}
		await fireEvent.click(screen.getByRole("button", { name: "วางข้อความ" }));
		await fireEvent.click(screen.getByRole("button", { name: "เลือกและแก้ค่ากล่องข้อความ Translated line" }));
		await fireEvent.input(container.querySelector("#text-layer-text")!, {
			target: { value: "Updated line" },
		});
		await fireEvent.change(container.querySelector("#text-style-preset")!, {
			target: { value: "preset-sfx" },
		});
		await fireEvent.input(container.querySelector("#text-effect-prompt")!, {
			target: { value: "angry impact sfx" },
		});
		await fireEvent.click(screen.getAllByRole("button", { name: /ใช้ชุดสไตล์แนะนำ SFX/ })[0]);
		await fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นชุดสไตล์/ }));
		await fireEvent.input(container.querySelector("#text-style-preset-name")!, {
			target: { value: "Impact" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "ไทป์เซ็ตให้พอดีกล่อง" }));
		const collapsedCreditSection = screen.queryByRole("button", { name: "เครดิต พับอยู่" });
		if (collapsedCreditSection) {
			await fireEvent.click(collapsedCreditSection);
		}
		expect(screen.queryByRole("button", { name: "สร้างเครดิตข้อความ" })).toBeNull();
		expect(screen.getByLabelText("สถานะสร้างเครดิตข้อความ").textContent).toContain("ยังไม่สร้างข้อความ");
		await fireEvent.input(container.querySelector("#credit-text")!, {
			target: { value: "Team credits" },
		});
		await fireEvent.input(container.querySelector("#credit-preset-name")!, {
			target: { value: "Saved credit" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "สร้างเครดิตข้อความ" }));
		await fireEvent.click(screen.getByRole("button", { name: "บันทึกชุดค่าเครดิต" }));
		await fireEvent.click(screen.getByRole("button", { name: "บันทึกชุดสไตล์ข้อความ" }));

		expect(startTextPlacement).toHaveBeenCalledTimes(1);
		expect(selectTextLayer).toHaveBeenCalledWith(layer.id);
		expect(setTool).toHaveBeenCalledWith("select");
		expect(updateTextContent).toHaveBeenCalledWith("Updated line");
		expect(applyTextStylePreset).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 36 }));
		expect(applyTextStylePreset).toHaveBeenCalledTimes(2);
		expect(fitSelectedTextLayerToBox).toHaveBeenCalledTimes(1);
		expect(addCreditLayer).toHaveBeenCalledWith(editorStore.editor, "credit-bottom-center", "Team credits", 24, "current", 0);
		expect(saveCreditPreset).toHaveBeenCalledWith(expect.objectContaining({ name: "Saved credit" }));
		expect(saveTextStylePreset).toHaveBeenCalledWith("Impact", layer);
	}, 15_000);

	it("mounts LayersPanelV2 with real page layers and delegates stack actions to the editor", async () => {
		const text = textLayer({ id: "text-live", text: "Live text", index: 0 });
		const image = imageLayer({ id: "image-live", imageId: "ref.webp", imageName: "ref.webp", originalName: "Reference layer", index: 0 });
		const edit = imageEditLayer({
			id: "edit-live",
			name: "Cleanup edit",
			kind: "patch",
			payload: {
				type: "patch",
				patchAssetId: "patch-live.webp",
				patchEncoding: "png-rgba",
			},
			tool: { id: "brush" },
			index: 0,
		});
		const healingEdit = imageEditLayer({
			id: "edit-healing",
			name: "Healing edit",
			kind: "healing",
			payload: {
				type: "healing",
				maskAssetId: "heal-mask.webp",
				realizedPatchAssetId: "heal-realized.webp",
				patchEncoding: "png-rgba",
				algorithm: "telea",
				algorithmVersion: "test",
			},
			tool: { id: "healing-brush" },
			index: 1,
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({
				imageId: "page.webp",
				imageName: "Base page",
				textLayers: [text],
				imageLayers: [image],
				imageEditLayers: [edit, healingEdit],
			})],
		}));
		editorStore.textLayers = [text];
		editorStore.imageLayers = [image];
		editorStore.imageEditLayers = [edit, healingEdit];
		editorStore.selectedLayer = text;
		editorStore.selectedImageLayer = null;
		editorStore.hasImage = true;

		const selectTextLayer = vi.fn((id: string) => editorStore.textLayers.find((layer) => layer.id === id) ?? null);
		const selectImageLayer = vi.fn((id: string) => editorStore.imageLayers.find((layer) => layer.id === id) ?? null);
		const updateTextLayer = vi.fn((id: string, updates: Partial<TextLayer>) => {
			const current = editorStore.textLayers.find((layer) => layer.id === id);
			if (!current) return null;
			const next = { ...current, ...updates };
			editorStore.textLayers = editorStore.textLayers.map((layer) => layer.id === id ? next : layer);
			return next;
		});
		const updateImageLayer = vi.fn((id: string, updates: Partial<ImageLayer>) => {
			const current = editorStore.imageLayers.find((layer) => layer.id === id);
			if (!current) return null;
			const next = { ...current, ...updates };
			editorStore.imageLayers = editorStore.imageLayers.map((layer) => layer.id === id ? next : layer);
			return next;
		});
		const removeTextLayerWithHistory = vi.fn((id: string) => {
			editorStore.textLayers = editorStore.textLayers.filter((layer) => layer.id !== id);
		});
		const removeImageLayerWithHistory = vi.fn((id: string) => {
			editorStore.imageLayers = editorStore.imageLayers.filter((layer) => layer.id !== id);
		});
		const moveLayerInStackWithHistory = vi.fn((kind: "text" | "image", id: string) => {
			if (kind === "text") return editorStore.textLayers.find((layer) => layer.id === id) ?? null;
			return editorStore.imageLayers.find((layer) => layer.id === id) ?? null;
		});
		const toggleImageEditLayerVisibility = vi.fn((id: string) => {
			editorStore.imageEditLayers = editorStore.imageEditLayers.map((layer) => (
				layer.id === id ? { ...layer, visible: layer.visible === false } : layer
			));
			return true;
		});
		const renameImageEditLayer = vi.fn((id: string, name: string) => {
			editorStore.imageEditLayers = editorStore.imageEditLayers.map((layer) => (
				layer.id === id ? { ...layer, name } : layer
			));
			return true;
		});
		const deleteImageEditLayer = vi.fn((id: string) => {
			editorStore.imageEditLayers = editorStore.imageEditLayers.filter((layer) => layer.id !== id);
			return true;
		});
		const revertToBeforeImageEditLayer = vi.fn((id: string) => {
			const targetIndex = editorStore.imageEditLayers.findIndex((layer) => layer.id === id);
			if (targetIndex < 0) return false;
			editorStore.imageEditLayers = editorStore.imageEditLayers.slice(0, targetIndex);
			return true;
		});
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			setTool: vi.fn(),
			canUndo: vi.fn(() => false),
			canRedo: vi.fn(() => false),
			selectTextLayer,
			selectImageLayer,
			updateTextLayer,
			updateTextLayerWithHistory: updateTextLayer,
			updateImageLayer,
			updateImageLayerWithHistory: updateImageLayer,
			removeTextLayerWithHistory,
			removeImageLayerWithHistory,
			moveLayerInStack: vi.fn(),
			moveLayerInStackWithHistory,
			toggleImageEditLayerVisibility,
			renameImageEditLayer,
			deleteImageEditLayer,
			revertToBeforeImageEditLayer,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
			getImageEditLayers: vi.fn(() => editorStore.imageEditLayers),
		};

		const { container } = render(LayersModePanel, { props: { labels } });
		const panel = screen.getByTestId("layers-panel-v2-live");
		expect(within(panel).getByText("5 ชั้น")).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "เลือกเลเยอร์ Live text" })).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "เลือกเลเยอร์ Reference layer" })).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "เลือกเลเยอร์ Cleanup edit" })).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "เลือกเลเยอร์ Healing edit" })).toBeTruthy();
		expect(within(panel).getAllByText(/แก้ภาพด้วยแปรง/).length).toBeGreaterThanOrEqual(2);
		expect(within(panel).getByText("Base page")).toBeTruthy();

		await fireEvent.click(within(panel).getByRole("button", { name: "เลือกเลเยอร์ Reference layer" }));
		expect(selectImageLayer).toHaveBeenCalledWith("image-live");
		expect(editorStore.selectedImageLayer?.id).toBe("image-live");
		expect(editorStore.selectedLayer).toBeNull();

		const textRow = screen.getByTestId("layer-row-text:text-live");
		await fireEvent.click(within(textRow).getByRole("button", { name: "ซ่อน Live text" }));
		expect(updateTextLayer).toHaveBeenCalledWith("text-live", { visible: false });

		await fireEvent.dblClick(within(textRow).getByRole("button", { name: "เลือกเลเยอร์ Live text" }));
		await fireEvent.input(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ Live text" }), {
			target: { value: "Renamed text" },
		});
		await fireEvent.keyDown(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ Live text" }), {
			key: "Enter",
		});
		expect(updateTextLayer).toHaveBeenCalledWith("text-live", { name: "Renamed text" });

		const imageRow = screen.getByTestId("layer-row-image:image-live");
		await fireEvent.click(within(imageRow).getByRole("button", { name: "เลือกเลเยอร์ Reference layer" }));
		await fireEvent.input(within(imageRow).getByRole("slider", { name: "ความทึบของ Reference layer" }), {
			target: { value: "55" },
		});
		expect(updateImageLayer).toHaveBeenCalledWith("image-live", { opacity: 0.55 });

		await fireEvent.pointerDown(within(textRow).getByRole("button", { name: "ลากเรียง Renamed text" }), { pointerId: 21 });
		await fireEvent.pointerEnter(imageRow, { pointerId: 21 });
		await fireEvent.pointerUp(imageRow, { pointerId: 21 });
		expect(moveLayerInStackWithHistory).toHaveBeenCalledWith("text", "text-live", -1);

		const editRow = screen.getByTestId("layer-row-edit:edit-live");
		expect(within(editRow).getByRole("button", { name: "ลากเรียง Cleanup edit" })).toHaveProperty("disabled", true);
		expect(within(editRow).getByRole("button", { name: "ล็อก Cleanup edit" })).toHaveProperty("disabled", true);
		expect(within(editRow).queryByRole("slider", { name: "ความทึบของ Cleanup edit" })).toBeNull();
		await fireEvent.click(within(editRow).getByRole("button", { name: "ซ่อน Cleanup edit" }));
		expect(toggleImageEditLayerVisibility).toHaveBeenCalledWith("edit-live", undefined);
		await fireEvent.dblClick(within(editRow).getByRole("button", { name: "เลือกเลเยอร์ Cleanup edit" }));
		await fireEvent.input(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ Cleanup edit" }), {
			target: { value: "Paint cleanup" },
		});
		await fireEvent.keyDown(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ Cleanup edit" }), {
			key: "Enter",
		});
		expect(renameImageEditLayer).toHaveBeenCalledWith("edit-live", "Paint cleanup");

		await fireEvent.click(within(screen.getByTestId("layer-row-image:image-live")).getByRole("button", { name: "ลบ Reference layer" }));
		expect(removeImageLayerWithHistory).toHaveBeenCalledWith("image-live");
		await fireEvent.click(within(screen.getByTestId("layer-row-text:text-live")).getByRole("button", { name: "ลบ Renamed text" }));
		expect(removeTextLayerWithHistory).toHaveBeenCalledWith("text-live");
		await fireEvent.click(within(screen.getByTestId("layer-row-edit:edit-live")).getByRole("button", { name: "ลบ Paint cleanup" }));
		expect(deleteImageEditLayer).toHaveBeenCalledWith("edit-live");
		await tick();
		await fireEvent.click(within(screen.getByTestId("layer-row-edit:edit-healing")).getByRole("button", { name: "ย้อนกลับไปก่อนการแก้นี้" }));
		expect(revertToBeforeImageEditLayer).toHaveBeenCalledWith("edit-healing");

		expect(container.querySelector(".layers-panel-v2")).toBeTruthy();
	}, 15_000);

	it("delegates canvas aspect changes when no text layer is selected", async () => {
		projectStore.__setProjectForTesting(project());
		editorStore.textLayers = [];
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		const setAspectRatio = vi.spyOn(editorStore, "setAspectRatio").mockImplementation(() => {});

		const { container } = render(LayersModePanel, { props: { labels } });
		await fireEvent.change(container.querySelector("#canvas-aspect-ratio")!, {
			target: { value: "1:1 Square" },
		});

		expect(setAspectRatio).toHaveBeenCalledWith([1, 1]);
	});

	it("keeps pending text-inspector focus requests even when fired before mount", async () => {
		const layer = textLayer();
		projectStore.__setProjectForTesting(project({ pages: [page({ textLayers: [layer] })] }));
		editorStore.textLayers = [layer];
		editorStore.selectedLayer = layer;
		editorStore.hasImage = true;

		editorUiStore.focusTextInspector(layer.id);
		const { container } = render(LayersModePanel, { props: { labels } });
		await tick();
		await tick();

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.textInspectorFocusLayerId).toBe(layer.id);
		expect(editorUiStore.textInspectorFocusToken).toBe(1);
		expect(document.activeElement).toBe(container.querySelector("#text-layer-text"));
	});

	it("keeps pending image-inspector focus requests even when fired before mount", async () => {
		const layer = imageLayer({ opacity: 0.72 });
		projectStore.__setProjectForTesting(project({ pages: [page({ imageLayers: [layer] })] }));
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;

		editorUiStore.focusImageInspector(layer.id);
		const { container } = render(LayersModePanel, { props: { labels } });
		await tick();
		await tick();

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe(layer.id);
		expect(editorUiStore.imageInspectorFocusToken).toBe(1);
		expect(document.activeElement).toBe(container.querySelector("#image-layer-opacity"));
	});

	it("commits selected image layer role changes through the editor store", async () => {
		const layer = imageLayer();
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		const { container } = render(LayersModePanel, { props: { labels } });
		await fireEvent.change(container.querySelector("#image-layer-role")!, {
			target: { value: "overlay" },
		});

		expect(updateImageLayer).toHaveBeenCalledWith({ role: "overlay" }, true);
	});

	it("normalizes AI result role changes through the editor store", () => {
		const layer = imageLayer({
			id: "ai-result-marker-1",
			imageName: "ai-result-marker-1.webp",
			originalName: "ผล AI หน้า 1",
			role: "credit",
		});
		const updatedLayer = { ...layer, role: "overlay" as const };
		const updateImageLayer = vi.fn(() => updatedLayer);
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.editor = {
			...editorStore.editor,
			updateImageLayer,
			getAllImageLayers: vi.fn(() => [updatedLayer]),
		};

		editorStore.updateImageLayer({ role: "reference" }, true);

		expect(updateImageLayer).toHaveBeenCalledWith("ai-result-marker-1", { role: "overlay" });
		expect(editorStore.selectedImageLayer?.role).toBe("overlay");
	});

	it("keeps selected image Clean brush in the Layers context", async () => {
		const layer = imageLayer({
			id: "clean-layer-context",
			name: "Clean context overlay",
			role: "overlay",
		});
		projectStore.__setProjectForTesting(project({ pages: [page({ imageLayers: [layer] })] }));
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		editorStore.editor = {
			...editorStore.editor,
			setTool: vi.fn(),
			hasAiMaskBrushTarget: vi.fn(() => false),
		};
		editorStore.refreshBrushTarget();
		editorUiStore.setRightPanelMode("layers");

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getByRole("button", { name: /แปรงคลีน/ }));

		expect(editorStore.currentTool).toBe("brush");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe(layer.id);
		const brushStrip = screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก");
		expect(brushStrip.textContent).toContain("Clean context overlay");
		expect(brushStrip.textContent).toContain("ภาพฐานไม่ถูกแตะ");
	});

	it("commits selected image layer blend mode changes through the editor store", async () => {
		const layer = imageLayer({ blendMode: "normal" });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		const { container } = render(LayersModePanel, { props: { labels } });
		await fireEvent.change(container.querySelector("#image-layer-blend-mode")!, {
			target: { value: "multiply" },
		});

		expect(updateImageLayer).toHaveBeenCalledWith({ blendMode: "multiply" }, true);
	});

	it("aligns the selected image layer against the image bounds with history commits", async () => {
		const layer = imageLayer({ w: 200, h: 100 });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมกึ่งกลางแนวนอน" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดล่าง" }));

		expect(updateImageLayer).toHaveBeenNthCalledWith(1, { x: 400 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(2, { y: 700 }, true);
	});

	it("applies selected image layer transform presets against the image bounds with history commits", async () => {
		const layer = imageLayer({ x: 40, y: 50, w: 200, h: 100, sourceW: 400, sourceH: 400, rotation: 12, opacity: 0.64, flipX: true, flipY: true, blendMode: "multiply" });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getAllByRole("button", { name: "พอดีหน้ารูปเสริม" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ขยายรูปเสริมเต็มความกว้างหน้า" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ขยายรูปเสริมเต็มความสูงหน้า" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "คืนสัดส่วนจริงรูปเสริม" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "รีเซ็ตการหมุนรูปเสริม" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "คืนค่าแปลงรูปเสริม" })[0]);

		expect(updateImageLayer).toHaveBeenNthCalledWith(1, { x: 100, y: 0, w: 800, h: 800 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(2, { x: 0, y: -100, w: 1000, h: 1000 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(3, { x: 100, y: 0, w: 800, h: 800 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(4, { x: 40, y: 0, w: 200, h: 200 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(5, { rotation: 0 }, true);
		expect(updateImageLayer).toHaveBeenNthCalledWith(6, {
			x: 300,
			y: 200,
			w: 400,
			h: 400,
			rotation: 0,
			opacity: 1,
			flipX: false,
			flipY: false,
			blendMode: "normal",
		}, true);
	});

	it("applies image layer bulk actions through a single history-aware editor call", async () => {
		const hiddenLocked = imageLayer({ id: "image-layer-1", visible: false, locked: true });
		const visibleUnlocked = imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", index: 1, role: "overlay" });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [hiddenLocked, visibleUnlocked];
		editorStore.selectedImageLayer = null;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
			updateImageLayersWithHistory: vi.fn(),
		};

		render(LayersModePanel, { props: { labels } });
		expect(screen.getByRole("button", { name: "รูปเสริม เปิดอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "แสดง รูปเสริมทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: "ล็อก รูปเสริมทั้งหมด" }));

		expect(editorStore.editor.updateImageLayersWithHistory).toHaveBeenNthCalledWith(
			1,
			{ "image-layer-1": { visible: true } },
			null,
		);
		expect(editorStore.editor.updateImageLayersWithHistory).toHaveBeenNthCalledWith(
			2,
			{ "image-layer-2": { locked: true } },
			null,
		);
	});

	it("reports selected credit deletion with the affected credit name", async () => {
		const credit = textLayer({ id: "credit-text-1", text: "Translator / Typesetter", sourceCategory: "credit" });
		const creditImage = imageLayer({ id: "credit-image-1", role: "credit", originalName: "credit-logo.webp" });
		projectStore.__setProjectForTesting(project({ pages: [page({ textLayers: [credit], imageLayers: [creditImage] })] }));
		editorStore.textLayers = [credit];
		editorStore.imageLayers = [creditImage];
		editorStore.selectedLayer = credit;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				editorStore.textLayers = editorStore.textLayers.filter((layer) => layer.id !== layerId);
			}),
			removeImageLayerWithHistory: vi.fn((layerId: string) => {
				editorStore.imageLayers = editorStore.imageLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};

		const { rerender } = render(LayersModePanel, { props: { labels } });
		const collapsedCreditSection = screen.queryByRole("button", { name: "เครดิต พับอยู่" });
		if (collapsedCreditSection) {
			await fireEvent.click(collapsedCreditSection);
		}
		await fireEvent.click(screen.getByRole("button", { name: "ลบเครดิตที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ลบเลย" }));
		expect(projectStore.statusMsg).toBe("ลบเครดิตข้อความที่เลือกแล้ว: Translator / Typesetter");

		editorStore.selectedLayer = null;
		editorStore.selectedImageLayer = creditImage;
		await rerender({ labels });
		await fireEvent.click(screen.getByRole("button", { name: "ลบเครดิตที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ลบเลย" }));
		expect(projectStore.statusMsg).toBe("ลบรูปเครดิตที่เลือกแล้ว: credit-logo.webp");
	});

	it("scopes image layer bulk actions to the selected role filter", async () => {
		const reference = imageLayer({ id: "image-layer-1", visible: true, locked: false });
		const overlay = imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", index: 1, role: "overlay", visible: true, locked: false });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [reference, overlay];
		editorStore.selectedImageLayer = null;
		editorStore.selectedLayer = null;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
			updateImageLayersWithHistory: vi.fn(),
		};

		render(LayersModePanel, { props: { labels } });
		expect(screen.getByRole("button", { name: "รูปเสริม เปิดอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "กรองรูปเสริมแบบทับซ้อน" }));
		await fireEvent.click(screen.getByRole("button", { name: /ซ่อน.*รูปทับซ้อน/ }));

		expect(editorStore.editor.updateImageLayersWithHistory).toHaveBeenCalledWith(
			{ "image-layer-2": { visible: false } },
			null,
		);
	});

	it("does not record no-op selected image layer alignment commands", async () => {
		const layer = imageLayer({ x: 400, y: 700, w: 200, h: 100 });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมกึ่งกลางแนวนอน" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดล่าง" }));

		expect(updateImageLayer).not.toHaveBeenCalled();
	});

	it("does not record no-op selected image layer transform preset commands", async () => {
		const layer = imageLayer({ x: 0, y: 150, w: 1000, h: 500, rotation: 0 });
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getByRole("button", { name: "พอดีหน้ารูปเสริม" }));
		await fireEvent.click(screen.getByRole("button", { name: "ขยายรูปเสริมเต็มความกว้างหน้า" }));
		await fireEvent.click(screen.getByRole("button", { name: "รีเซ็ตการหมุนรูปเสริม" }));

		expect(updateImageLayer).not.toHaveBeenCalled();
	});

	it("resets selected image layer position, size, and visual transforms", async () => {
		const layer = imageLayer({
			x: 30,
			y: 40,
			w: 300,
			h: 300,
			rotation: 17,
			opacity: 0.42,
			flipX: true,
			flipY: true,
			blendMode: "multiply",
			sourceW: 2000,
			sourceH: 1000,
		});
		projectStore.__setProjectForTesting(project());
		editorStore.imageLayers = [layer];
		editorStore.selectedImageLayer = layer;
		editorStore.hasImage = true;
		editorStore.editor = {
			canvasWidth: 800,
			canvasHeight: 600,
			imageWidth: 1000,
			imageHeight: 800,
			getAllTextLayers: vi.fn(() => editorStore.textLayers),
			getAllImageLayers: vi.fn(() => editorStore.imageLayers),
		};
		const updateImageLayer = vi.spyOn(editorStore, "updateImageLayer").mockImplementation(() => {});

		render(LayersModePanel, { props: { labels } });
		await fireEvent.click(screen.getByRole("button", { name: "คืนค่าแปลงรูปเสริม" }));

		expect(updateImageLayer).toHaveBeenCalledWith({
			x: 0,
			y: 150,
			w: 1000,
			h: 500,
			rotation: 0,
			opacity: 1,
			flipX: false,
			flipY: false,
			blendMode: "normal",
		}, true);
	});
});
