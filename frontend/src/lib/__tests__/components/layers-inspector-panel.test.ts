import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import "$lib/i18n";
import LayersInspectorPanel from "$lib/components/LayersInspectorPanel.svelte";
import type { ProjectImageAssetSummary } from "$lib/api/client.js";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, CreditPreset, ImageLayer, ProjectState, TextLayer, TextStylePreset } from "$lib/types.js";

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
		sourceCategory: "dialogue",
		sourceProvider: "import-json",
		confidence: 0.72,
		protected: true,
		...overrides,
	};
}

function textPreset(overrides: Partial<TextStylePreset> = {}): TextStylePreset {
	return {
		id: "preset-sfx",
		name: "SFX",
		style: { fontSize: 36, alignment: "center" },
		promptTags: ["impact", "sfx"],
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "ref.webp",
		imageName: "ref.webp",
		originalName: "sfx-reference.webp",
		x: 40,
		y: 56,
		w: 180,
		h: 120,
		rotation: 0,
		opacity: 0.8,
		visible: true,
		locked: false,
		index: 0,
		role: "reference",
		...overrides,
	};
}

function imageAsset(overrides: Partial<ProjectImageAssetSummary> = {}): ProjectImageAssetSummary {
	return {
		assetId: "ref.webp",
		imageId: "ref.webp",
		originalName: "sfx-reference.webp",
		mimeType: "image/webp",
		sizeBytes: 2048,
		sha256: "a".repeat(64),
		storageDriver: "local",
		storageKey: "projects/proj/images/ref.webp",
		width: 180,
		height: 120,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 1,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function aiMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "ai-marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "accepted",
		tier: "sfx-pro",
		resultImageId: "ai-result.webp",
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:01:00.000Z",
		...overrides,
	};
}

async function confirmLayerDelete(): Promise<void> {
	// Destructive confirm now renders through the shared ui/Dialog atom with
	// role="alertdialog" (a11y migration: Esc/focus-trap/inert background).
	expect(screen.getByRole("alertdialog", { name: /ลบ/ })).toBeTruthy();
	await fireEvent.click(screen.getByRole("button", { name: "ลบเลย" }));
}

function project(markers: AiReviewMarker[]): ProjectState {
	return {
		projectId: "project-1",
		name: "Inspector AI placement",
		createdAt: "2026-05-12T00:00:00.000Z",
		pages: [{
			imageId: "image-1.webp",
			imageName: "image-1.webp",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: markers,
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
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

function baseProps(overrides: Record<string, unknown> = {}) {
	const layer = textLayer();
	return {
		labels: {
			properties: "คุณสมบัติ",
			text: "ข้อความ",
			fontSize: "Font Size",
			alignment: "Alignment",
			alignmentLeft: "Left",
			alignmentCenter: "Center",
			alignmentRight: "Right",
			canvas: "Canvas",
			aspectRatio: "Aspect Ratio",
		},
		projectOpen: true,
		projectId: "project-1",
		hasImage: true,
		imageLayers: [
			imageLayer(),
			imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", originalName: "stamp.webp", index: 1, role: "overlay" }),
		],
		imageAssets: [
			imageAsset(),
			imageAsset({
				assetId: "stamp.webp",
				imageId: "stamp.webp",
				originalName: "stamp-overlay.webp",
				width: 96,
				height: 96,
				createdAt: "2026-05-12T00:01:00.000Z",
				updatedAt: "2026-05-12T00:01:00.000Z",
			}),
		],
		imageAssetsLoading: false,
		selectedImageAssetId: "",
		selectedImageLayer: null,
		textLayers: [
			layer,
			textLayer({
				id: "layer-2",
				text: "Second line",
				index: 1,
				sourceCategory: undefined,
				sourceProvider: undefined,
				confidence: undefined,
				protected: false,
			}),
		],
		selectedLayer: layer,
		textStylePresets: [textPreset()],
		creditPresets: [creditPreset()],
		selectedPresetId: "",
		presetName: "Shout preset",
		textEffectPrompt: "angry sfx",
		textEffectSuggestions: [textPreset()],
		selectedCreditPresetId: "credit-bottom-center",
		creditText: "แปล / ไทป์เซ็ต",
		creditOffset: 24,
		creditImageMaxWidth: 240,
		creditImageRepeatEveryPx: 0,
		creditApplyScope: "current",
		creditPresetName: "Credit preset",
		defaultFontFamily: "Arial",
		defaultFontSize: 24,
		defaultTextFill: "#111111",
		defaultTextStroke: "#ffffff",
		canvasDimensions: { width: 800, height: 600 },
		aspectRatios: { Free: null, "1:1": { width: 1, height: 1 } },
		selectedAspectRatio: "Free",
		focusLayerId: null,
		focusToken: 0,
		layerClipboardKind: null,
		onCreditPresetChange: vi.fn(),
		onCreditTextChange: vi.fn(),
		onCreditOffsetChange: vi.fn(),
		onCreditPresetNameChange: vi.fn(),
		onAddCredit: vi.fn(),
		onAddCreditImage: vi.fn(),
		onDeleteCreditLayers: vi.fn(),
		onCreditImageMaxWidthChange: vi.fn(),
		onCreditImageRepeatEveryPxChange: vi.fn(),
		onCreditApplyScopeChange: vi.fn(),
		onSaveCreditPreset: vi.fn(),
		onStartTextPlacement: vi.fn(),
		onAddImageLayer: vi.fn(),
		onStartSelectedImageBrush: vi.fn(),
		onImageAssetSelectionChange: vi.fn(),
		onAddSelectedImageAssetLayer: vi.fn(),
		onReplaceSelectedImageLayerFromAsset: vi.fn(),
		onSelectLayer: vi.fn(),
		onToggleLayerVisibility: vi.fn(),
		onToggleLayerLock: vi.fn(),
		onCopySelectedLayer: vi.fn(),
		onPasteLayerClipboard: vi.fn(),
		onDuplicateLayer: vi.fn(),
		onMoveLayer: vi.fn(),
		onMoveUnifiedLayer: vi.fn(),
		onReorderUnifiedLayer: vi.fn(),
		onDeleteLayer: vi.fn(),
		onSelectImageLayer: vi.fn(),
		onToggleImageLayerVisibility: vi.fn(),
		onToggleImageLayerLock: vi.fn(),
		onDuplicateImageLayer: vi.fn(),
		onMoveImageLayer: vi.fn(),
		onDeleteImageLayer: vi.fn(),
		onApplyImageLayerBulkAction: vi.fn(),
		onAlignSelectedImageLayer: vi.fn(),
		onApplySelectedImageLayerTransformPreset: vi.fn(),
		onSelectedImageLayerChange: vi.fn(),
		onSelectedTextLayerNameChange: vi.fn(),
		onSelectedTextChange: vi.fn(),
		onSelectedTextBoxChange: vi.fn(),
		onTextOpacityChange: vi.fn(),
		onSelectedPresetChange: vi.fn(),
		onPresetNameChange: vi.fn(),
		onTextEffectPromptChange: vi.fn(),
		onSuggestedPresetApply: vi.fn(),
		onSaveCurrentPreset: vi.fn(),
		onFontChange: vi.fn(),
		onFontSizeChange: vi.fn(),
		onFitSelectedText: vi.fn(),
		onFillChange: vi.fn(),
		onStrokeChange: vi.fn(),
		onStrokeWidthChange: vi.fn(),
		onAlignmentChange: vi.fn(),
		onAspectRatioChange: vi.fn(),
		...overrides,
	};
}

describe("LayersInspectorPanel", () => {
	beforeEach(() => {
		projectStore.__resetForTesting();
		editorUiStore.__resetForTesting();
		if (editorStore.editor && typeof editorStore.editor.destroy !== "function") {
			editorStore.editor = null;
		}
		editorStore.destroy();
	});

	it("prioritizes the active accepted AI placement blocker over generic selected text controls", async () => {
		const marker = aiMarker();
		const layer = textLayer();
		const placeAiResult = vi.spyOn(projectStore, "placeAiReviewMarkerResultAsImageLayer").mockResolvedValue(
			imageLayer({
				id: "ai-result-ai-marker-1",
				imageId: "ai-result.webp",
				imageName: "ai-result.webp",
				originalName: "ผล AI หน้า 1",
				role: "overlay",
			}),
		);
		editorStore.editor = { focusImageRegion: vi.fn(), destroy: vi.fn() } as any;
		projectStore.__setProjectForTesting(project([marker]));
		projectStore.selectAiReviewMarker(marker.id);

		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: layer,
				textLayers: [layer],
				imageLayers: [],
			}),
		});

		const placementCard = screen.getByRole("region", { name: "AI ผ่านแล้วรอวางเป็นเลเยอร์" });
			expect(within(placementCard).getByText("วางผลนี้เป็นเลเยอร์ก่อน Export")).toBeTruthy();
			expect(within(placementCard).getByText("สร้างเป็นเลเยอร์แก้ไข")).toBeTruthy();
			expect(within(placementCard).queryByText("สร้างเป็น ai-result layer")).toBeNull();
			expect(within(placementCard).getByRole("button", { name: "วางเลเยอร์ AI" })).toBeTruthy();
			expect(screen.queryByRole("button", { name: "คัดลอกกล่องข้อความที่เลือก" })).toBeNull();

			editorUiStore.setRightPanelMode("layers");
			await fireEvent.click(within(placementCard).getByRole("button", { name: "เปิดผลรีวิว" }));

			expect(projectStore.selectedAiReviewMarkerId).toBe(marker.id);
			expect(editorStore.editor.focusImageRegion).toHaveBeenCalledWith(marker.region);
			expect(editorUiStore.rightPanelMode).toBe("ai");

			await fireEvent.click(within(placementCard).getByRole("button", { name: "วางเลเยอร์ AI" }));

			expect(placeAiResult).toHaveBeenCalledWith(marker.id, editorStore.editor, {
				statusMessage: "วางผล AI เป็นเลเยอร์แล้ว",
		});
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-ai-marker-1");
	});

	it("reopens the AI placement card even if properties were collapsed before the marker was selected", async () => {
		const marker = aiMarker();
		const layer = textLayer();
		editorStore.editor = { focusImageRegion: vi.fn(), destroy: vi.fn() } as any;
		const { rerender } = render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: layer,
				textLayers: [layer],
				imageLayers: [],
			}),
		});
		await fireEvent.click(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" }));
		expect(screen.getByRole("button", { name: "คุณสมบัติ พับอยู่" })).toBeTruthy();

		const testProject = project([marker]);
		testProject.pages[0].imageLayers = [layer];
		projectStore.__setProjectForTesting(testProject);
		projectStore.selectAiReviewMarker(marker.id);
		await rerender({
			...baseProps({
				selectedLayer: layer,
				textLayers: [layer],
				imageLayers: [],
			}),
		});
		await tick();

		expect(screen.queryByRole("button", { name: "คุณสมบัติ พับอยู่" })).toBeNull();
		expect(screen.getByRole("region", { name: "AI ผ่านแล้วรอวางเป็นเลเยอร์" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "วางเลเยอร์ AI" })).toBeTruthy();
	});

	it("explains the locked base image before editable layers exist", async () => {
		const { container } = render(LayersInspectorPanel, {
			props: baseProps({
				imageLayers: [],
				textLayers: [],
				selectedLayer: null,
				selectedImageLayer: null,
				canvasDimensions: { width: 1042, height: 912 },
			}),
		});

		expect(screen.getByText("ภาพฐาน (ล็อก)")).toBeTruthy();
		expect(screen.getByText("1042 x 912 / ต้นฉบับไม่ถูกนับเป็นเลเยอร์แก้ไข")).toBeTruthy();
		expect(screen.getAllByText("ต้นฉบับ").length).toBeGreaterThanOrEqual(1);
		const stack = within(screen.getByRole("region", { name: "โครงสร้างเลเยอร์หน้านี้" }));
		expect(stack.getByText("ภาพฐาน")).toBeTruthy();
		expect(stack.getByText("1042 x 912 / ล็อกไว้เป็นต้นฉบับ")).toBeTruthy();
		expect(stack.getByText("ยังไม่มีเลเยอร์แก้ไข")).toBeTruthy();
		expect(screen.getByText("เพิ่มเลเยอร์แก้ไข")).toBeTruthy();
		expect(screen.getByText("ข้อความ, รูปเสริม, และเครดิตจะอยู่เหนือภาพฐานที่ล็อกไว้")).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดเครื่องมือเครดิตจากงานเลเยอร์ถัดไป" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" })).toBeNull();
		const nextActionCard = container.querySelector(".next-layer-action-card");
		const stackOverview = container.querySelector(".layer-stack-overview");
		expect(nextActionCard).toBeTruthy();
		expect(stackOverview).toBeTruthy();
		expect(Boolean(nextActionCard!.compareDocumentPosition(stackOverview!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
	});

	it("keeps the library-entry layer start view focused before editable layers exist", async () => {
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		render(LayersInspectorPanel, {
			props: baseProps({
				imageLayers: [],
				textLayers: [],
				selectedLayer: null,
				selectedImageLayer: null,
			}),
		});

		const nextAction = within(screen.getByLabelText("งานเลเยอร์ถัดไป"));
		expect(nextAction.getByText("เริ่มจากคลัง")).toBeTruthy();
		expect(nextAction.getByText("เลือกงานแรกให้หน้านี้")).toBeTruthy();
		expect(screen.queryByText("ภาพฐาน (ล็อก)")).toBeNull();
		expect(screen.queryByRole("region", { name: "โครงสร้างเลเยอร์หน้านี้" })).toBeNull();
		expect(screen.queryByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ข้อความ 0" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เครดิต พับอยู่" })).toBeNull();

		const toolsToggle = screen.getByRole("button", { name: /เครื่องมือทั้งหมด/ });
		expect(toolsToggle.getAttribute("aria-expanded")).toBe("false");
		await fireEvent.click(toolsToggle);

		expect(toolsToggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.queryByLabelText("ทางลัดแผงเลเยอร์")).toBeNull();
		expect(screen.getByRole("button", { name: "เครดิต พับอยู่" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" })).toBeTruthy();
	});

	it("keeps selected layers focused when editing from a Library entry", async () => {
		const layer = textLayer();
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		const { container } = render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: layer,
				textLayers: [layer],
				imageLayers: [],
			}),
		});

		expect(container.querySelector(".layers-inspector")?.classList.contains("selected-editable-focus")).toBe(true);
		expect(screen.getAllByText("กำลังแก้").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByRole("region", { name: "โครงสร้างเลเยอร์หน้านี้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เริ่มวางข้อความ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เครดิต พับอยู่" })).toBeNull();
		expect(screen.getByRole("button", { name: /เลเยอร์อื่น/ }).getAttribute("aria-expanded")).toBe("false");
		expect(screen.getByLabelText("คำสั่งแก้ข้อความหลัก")).toBeTruthy();
		expect(screen.getByRole("button", { name: "แก้ข้อความ" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "สไตล์" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เอฟเฟกต์" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));

		expect(screen.getByRole("button", { name: /เลเยอร์อื่น/ }).getAttribute("aria-expanded")).toBe("true");
		expect(screen.queryByLabelText("ทางลัดแผงเลเยอร์")).toBeNull();
		expect(screen.getByRole("button", { name: "เครดิต พับอยู่" })).toBeTruthy();
	});

	it("surfaces hidden selected text as the first recovery action", async () => {
		const layer = textLayer({ id: "hidden-text-focus", visible: false });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		const props = baseProps({
			selectedLayer: layer,
			textLayers: [layer],
			imageLayers: [],
		});
		const { container } = render(LayersInspectorPanel, { props });

		expect(screen.getByRole("button", { name: "แสดงข้อความ" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "สไตล์" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เอฟเฟกต์" })).toBeNull();
		expect(screen.getByText("แสดงข้อความก่อนปรับสไตล์")).toBeTruthy();
		expect(screen.getByText("แสดงข้อความก่อนใส่เอฟเฟกต์")).toBeTruthy();
		expect(container.querySelectorAll(".selected-layer-primary-actions button:disabled")).toHaveLength(0);

		await fireEvent.click(screen.getByRole("button", { name: "แสดงข้อความ" }));

		expect(props.onToggleLayerVisibility).toHaveBeenCalledWith("hidden-text-focus");
	});

	it("uses dedicated selected-credit copy and actions from a Library entry", async () => {
		const credit = textLayer({ id: "credit-text-1", text: "Scan / Typeset", sourceCategory: "credit" });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: credit,
				textLayers: [credit],
				imageLayers: [],
			}),
		});

		expect(screen.getAllByText("เลือกเครดิต").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("เครดิตข้อความ").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("เครดิตข้อความที่เลือก")).toBeTruthy();
		const focusActions = within(screen.getByRole("group", { name: "ลำดับเลเยอร์ที่เลือก" }));
		expect(focusActions.queryByRole("button", { name: "แก้เครดิต" })).toBeNull();
		expect(focusActions.getByText("กำลังแก้")).toBeTruthy();
		expect(screen.getByRole("button", { name: "สไตล์" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เครื่องมือเครดิต" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เครดิต เปิดอยู่" })).toBeNull();
		expect(screen.getByText("คำสั่งเครดิต")).toBeTruthy();
		expect(within(screen.getByLabelText("ลำดับเลเยอร์ที่เลือก")).getByRole("button", { name: "ลบเครดิตที่เลือก" })).toBeTruthy();
		expect(screen.getByLabelText("คำสั่งแก้ข้อความหลัก").textContent).toContain("ลบเครดิต");
		expect(screen.getAllByRole("button", { name: /ลบเครดิต/ }).length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("กล่องข้อความที่เลือก")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));

		expect(screen.getByRole("button", { name: "เครดิต พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		expect(screen.getByRole("button", { name: "เครดิต เปิดอยู่" })).toBeTruthy();
		const selectedCreditPanel = screen.getByLabelText("เครดิตที่เลือกกำลังแก้");
		expect(within(selectedCreditPanel).getByText("เครดิตข้อความที่เลือก")).toBeTruthy();
		expect(within(selectedCreditPanel).getByText("Scan / Typeset")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "สร้างเครดิตข้อความ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Import รูปเครดิต" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบเครดิตหน้านี้" })).toBeNull();
		await fireEvent.click(within(selectedCreditPanel).getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" }));
		expect(screen.getByRole("button", { name: "สร้างเครดิตข้อความ" })).toBeTruthy();
	});

	it("surfaces locked selected credit text as the first recovery action", async () => {
		const credit = textLayer({ id: "locked-credit-text", sourceCategory: "credit", locked: true });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้เครดิตท้ายหน้า",
		});

		const props = baseProps({
			selectedLayer: credit,
			textLayers: [credit],
			imageLayers: [],
		});
		render(LayersInspectorPanel, { props });

		expect(screen.getByRole("button", { name: "ปลดล็อก" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เครื่องมือเครดิต" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "ปลดล็อก" }));

		expect(props.onToggleLayerLock).toHaveBeenCalledWith("locked-credit-text");
	});

	it("deletes matching selected credit text across pages through one scoped delete owner", async () => {
		const credit = textLayer({ id: "credit-text-1", text: "Scan / Typeset", sourceCategory: "credit" });
		const state = project([]);
		state.pages = [
			{ ...state.pages[0], textLayers: [credit], imageLayers: [] },
			{
				...state.pages[0],
				imageId: "image-2.webp",
				imageName: "image-2.webp",
				textLayers: [textLayer({ id: "credit-text-2", text: "Scan / Typeset", sourceCategory: "credit" })],
				imageLayers: [],
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้เครดิตท้ายหน้า",
		});
		const props = baseProps({
			selectedLayer: credit,
			textLayers: [credit],
			imageLayers: [],
		});
		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" }));
		const deleteCard = screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต");
		const scopeSelect = within(deleteCard).getByLabelText("เลือกขอบเขตลบเครดิต") as HTMLSelectElement;
		expect(within(deleteCard).getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" })).toBeTruthy();
		expect(Array.from(scopeSelect.options).map((option) => option.textContent)).toContain("ข้อความเครดิตนี้ทุกหน้า");

		await fireEvent.change(scopeSelect, { target: { value: "matching-text-all" } });
		await fireEvent.click(within(deleteCard).getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }));
		await confirmLayerDelete();

		expect(props.onDeleteCreditLayers).toHaveBeenCalledWith(true, "text", { text: "Scan / Typeset" });
	});

	it("resets credit delete scope to selected when the selected credit layer changes", async () => {
		const firstCredit = textLayer({ id: "credit-text-1", text: "Scan / Typeset", sourceCategory: "credit" });
		const secondCredit = textLayer({ id: "credit-text-2", text: "QC / Lettering", sourceCategory: "credit", index: 1 });
		const state = project([]);
		state.pages = [
			{ ...state.pages[0], textLayers: [firstCredit, secondCredit], imageLayers: [] },
			{
				...state.pages[0],
				imageId: "image-2.webp",
				imageName: "image-2.webp",
				textLayers: [textLayer({ id: "credit-text-3", text: "Scan / Typeset", sourceCategory: "credit" })],
				imageLayers: [],
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้เครดิตท้ายหน้า",
		});
		const props = baseProps({
			selectedLayer: firstCredit,
			textLayers: [firstCredit, secondCredit],
			imageLayers: [],
		});
		const { rerender } = render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" }));
		const deleteCard = screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต");
		const scopeSelect = within(deleteCard).getByLabelText("เลือกขอบเขตลบเครดิต") as HTMLSelectElement;

		await fireEvent.change(scopeSelect, { target: { value: "chapter-all" } });
		expect(scopeSelect.value).toBe("chapter-all");

		await rerender({
			...props,
			selectedLayer: secondCredit,
			textLayers: [firstCredit, secondCredit],
			imageLayers: [],
		});
		await tick();

		expect(scopeSelect.value).toBe("selected");
		expect(within(deleteCard).getByText(/QC \/ Lettering/)).toBeTruthy();
	});

	it("shows read-only selected text properties while the layer is locked", async () => {
		const layer = textLayer({ id: "locked-text", locked: true, text: "Locked line", name: "Locked layer" });
		const props = baseProps({
			selectedLayer: layer,
			textLayers: [layer],
			imageLayers: [],
		});
		const { container } = render(LayersInspectorPanel, { props });

		const selectedActions = within(screen.getByRole("group", { name: "ลำดับเลเยอร์ที่เลือก" }));
		expect(selectedActions.getByRole("button", { name: "ปลดล็อกเลเยอร์ที่เลือก" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ปลดล็อก Locked layer" })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: /รายละเอียดเลเยอร์/ }));
		await fireEvent.click(screen.getByRole("button", { name: /สี \/ จัดวาง \/ ขอบ/ }));
		expect(screen.getByText("ปลดล็อกก่อนแก้ข้อความ")).toBeTruthy();
		expect(screen.getByText("ปลดล็อกก่อนเปลี่ยนชุดสไตล์")).toBeTruthy();
		expect(screen.getByText("ปลดล็อกก่อนปรับฟอนต์และขนาด")).toBeTruthy();
		expect(screen.getByText("ปลดล็อกก่อนปรับสีและขอบ")).toBeTruthy();
		expect(container.querySelector("#text-layer-name")).toBeNull();
		expect(container.querySelector("#text-layer-text")).toBeNull();
		expect(container.querySelector("#text-style-preset")).toBeNull();
		expect(container.querySelector("#text-layer-fill")).toBeNull();
		expect(container.querySelector("#text-layer-opacity")).toBeNull();
		expect(container.querySelector("#text-layer-stroke")).toBeNull();
		expect(container.querySelector("#text-layer-stroke-width")).toBeNull();
		expect(container.querySelector("#text-layer-alignment")).toBeNull();
		expect(container.querySelectorAll(".selected-layer-primary-actions button:disabled")).toHaveLength(0);

		expect(props.onSelectedTextChange).not.toHaveBeenCalled();
		expect(props.onFillChange).not.toHaveBeenCalled();
		expect(props.onAlignmentChange).not.toHaveBeenCalled();
	});

	it("keeps selected image layers focused when editing from a Library entry", async () => {
		const layer = imageLayer({ id: "image-focus-1", role: "overlay", name: "SFX overlay" });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
			imageAssets: [imageAsset()],
		});
		const { container } = render(LayersInspectorPanel, { props });
		const advancedDrawer = container.querySelector(".image-layer-advanced-drawer") as HTMLDetailsElement;

		expect(container.querySelector(".layers-inspector")?.classList.contains("selected-editable-focus")).toBe(true);
		expect(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้").length).toBeGreaterThanOrEqual(1);
		expect(within(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้")[0]).getByText("กำลังแก้ตอนนี้")).toBeTruthy();
		expect(within(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้")[0]).getByText("SFX overlay")).toBeTruthy();
		expect(screen.getByText("รูปเสริมที่เลือก")).toBeTruthy();
		expect(screen.getByLabelText("คำสั่งแก้รูปเสริมหลัก")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ตั้งค่ารูป" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ตำแหน่ง" })).toBeNull();
		expect(screen.getByRole("button", { name: "คลังรูป" })).toBeTruthy();
		expect(screen.queryByLabelText("ปรับรูปเสริมที่เลือกแบบเร็ว")).toBeNull();
		expect(screen.queryByLabelText("จัดวางรูปเสริมที่เลือกแบบเร็ว")).toBeNull();
		const layoutReadout = screen.getByLabelText("ผลจัดวางรูปเสริมที่เลือก");
		expect(within(layoutReadout).getByText("ตอนนี้")).toBeTruthy();
		expect(within(layoutReadout).getByText("40, 56 / 180 x 120 / หมุน 0°")).toBeTruthy();
		expect(within(layoutReadout).getByText("รูปทับซ้อน / ทึบ 80% / ผสมภาพ ปกติ")).toBeTruthy();
		expect(screen.getByText("คำสั่งรูปเสริม")).toBeTruthy();
		expect(screen.queryByLabelText("คำสั่งด่วนรูปเสริมที่เลือก")).toBeNull();
		expect(advancedDrawer.open).toBe(false);

		await fireEvent.click(screen.getByRole("button", { name: "ตั้งค่ารูป" }));
		await tick();

		expect(advancedDrawer.open).toBe(true);

		const opacityInput = container.querySelector("#image-layer-opacity") as HTMLInputElement;
		expect(opacityInput).toBeTruthy();
		await fireEvent.input(opacityInput, {
			target: { value: "55" },
		});

		const blendModeSelect = container.querySelector("#image-layer-blend-mode") as HTMLSelectElement;
		expect(blendModeSelect).toBeTruthy();
		await fireEvent.change(blendModeSelect, {
			target: { value: "multiply" },
		});

		await fireEvent.click(screen.getByRole("button", { name: "พอดีหน้ารูปเสริม" }));
		await fireEvent.click(screen.getByRole("button", { name: "คืนสัดส่วนจริงรูปเสริม" }));
		await fireEvent.click(screen.getByRole("button", { name: "คืนค่าแปลงรูปเสริม" }));

		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ opacity: 0.55 });
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ blendMode: "multiply" }, true);
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(1, "fit-page");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(2, "source-aspect");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(3, "reset-transform");
	});

	it("surfaces the selected image locked state as the first recovery action", async () => {
		const layer = imageLayer({ id: "locked-image-focus", locked: true });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		const { container } = render(LayersInspectorPanel, { props });

		expect(screen.getByRole("button", { name: "ปลดล็อก" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ตำแหน่ง" })).toBeNull();
		expect(screen.queryByLabelText("ปรับความทึบรูปเสริมที่เลือก")).toBeNull();
		expect(screen.queryByLabelText("เลือกโหมดผสมภาพรูปเสริมที่เลือก")).toBeNull();
		expect(screen.getByText("ปลดล็อกก่อนปรับตำแหน่งและขนาด")).toBeTruthy();
		expect(container.querySelector("#image-layer-name")).toBeNull();
		expect(container.querySelector("#image-layer-role")).toBeNull();
		expect(container.querySelector("#image-layer-blend-mode")).toBeNull();
		expect(container.querySelector("#image-layer-opacity")).toBeNull();
		expect(container.querySelector("#image-layer-x")).toBeNull();
		expect(container.querySelector("#image-layer-rotation")).toBeNull();
		expect(container.querySelectorAll(".image-layer-advanced-drawer [disabled]")).toHaveLength(0);
		expect(screen.queryByLabelText("จัดวางรูปเสริมที่เลือกแบบเร็ว")).toBeNull();
		expect(screen.queryByLabelText("ปรับรูปเสริมที่เลือกแบบเร็ว")).toBeNull();
		expect(document.querySelectorAll(".selected-layer-primary-actions button:disabled")).toHaveLength(0);

		await fireEvent.click(screen.getByRole("button", { name: "ปลดล็อก" }));

		expect(props.onToggleImageLayerLock).toHaveBeenCalledWith("locked-image-focus");
	});

	it("keeps a newly selected image layer advanced drawer closed in Library focus mode", async () => {
		const layer = imageLayer({ id: "late-image-focus", role: "overlay" });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้คอมเมนต์รีวิว",
		});

		const base = baseProps({
			selectedLayer: null,
			selectedImageLayer: null,
			imageLayers: [],
		});
		const { container, rerender } = render(LayersInspectorPanel, { props: base });

		await rerender({
			...base,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		await tick();

		const advancedDrawer = container.querySelector(".image-layer-advanced-drawer") as HTMLDetailsElement;
		expect(screen.getByLabelText("คำสั่งแก้รูปเสริมหลัก")).toBeTruthy();
		expect(advancedDrawer.open).toBe(false);
	});

	it("uses dedicated selected credit image actions from a Library entry", async () => {
		const credit = imageLayer({ id: "credit-image-focus", role: "credit", originalName: "credit.png" });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้เครดิตท้ายหน้า",
		});

		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: credit,
				imageLayers: [credit],
			}),
		});

		expect(screen.getByText("รูปเครดิตที่เลือก")).toBeTruthy();
		expect(screen.getByLabelText("คำสั่งแก้รูปเครดิตหลัก")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ปรับเครดิต" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เครื่องมือเครดิต" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เครดิต เปิดอยู่" })).toBeNull();
		expect(screen.queryByLabelText("จัดวางรูปเสริมที่เลือกแบบเร็ว")).toBeNull();
		expect(screen.getByText("คำสั่งเครดิต")).toBeTruthy();
		expect(within(screen.getByLabelText("ลำดับเลเยอร์ที่เลือก")).getByRole("button", { name: "ลบเครดิตที่เลือก" })).toBeTruthy();
		expect(screen.getByLabelText("คำสั่งแก้รูปเครดิตหลัก").textContent).toContain("ลบเครดิต");
		expect(screen.getAllByRole("button", { name: /ลบ.*เครดิต/ }).length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("รูปเสริมที่เลือก")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));

		expect(screen.getByRole("button", { name: "เครดิต พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		expect(screen.getByRole("button", { name: "เครดิต เปิดอยู่" })).toBeTruthy();
		const selectedCreditPanel = screen.getByLabelText("เครดิตที่เลือกกำลังแก้");
		expect(within(selectedCreditPanel).getByText("รูปเครดิตที่เลือก")).toBeTruthy();
		expect(within(selectedCreditPanel).getByText("credit.png")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "สร้างเครดิตข้อความ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Import รูปเครดิต" })).toBeNull();
	});

	it("deletes matching selected credit images across pages through the scoped delete owner", async () => {
		const credit = imageLayer({ id: "credit-image-focus", imageId: "credit-logo.webp", imageName: "credit-logo.webp", role: "credit", originalName: "credit.png" });
		const state = project([]);
		state.pages = [
			{ ...state.pages[0], textLayers: [], imageLayers: [credit] },
			{
				...state.pages[0],
				imageId: "image-2.webp",
				imageName: "image-2.webp",
				textLayers: [],
				imageLayers: [imageLayer({ id: "credit-image-second", imageId: "credit-logo.webp", imageName: "credit-logo.webp", role: "credit", originalName: "credit.png" })],
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้เครดิตท้ายหน้า",
		});
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: credit,
			textLayers: [],
			imageLayers: [credit],
		});
		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: /เลเยอร์อื่น/ }));
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" }));
		const deleteCard = screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต");
		const scopeSelect = within(deleteCard).getByLabelText("เลือกขอบเขตลบเครดิต") as HTMLSelectElement;
		expect(Array.from(scopeSelect.options).map((option) => option.textContent)).toContain("รูปเครดิตนี้ทุกหน้า");

		await fireEvent.change(scopeSelect, { target: { value: "matching-image-all" } });
		await fireEvent.click(within(deleteCard).getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }));
		await confirmLayerDelete();

		expect(props.onDeleteCreditLayers).toHaveBeenCalledWith(true, "image", { imageId: "credit-logo.webp" });
	});

	it("hides unavailable selected-layer move shortcuts because stack context already explains the edge", () => {
		const bottomLayer = textLayer({ id: "bottom-layer", text: "Bottom line", index: 0 });
		const topLayer = textLayer({ id: "top-layer", text: "Top line", index: 1 });

		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: topLayer,
				textLayers: [bottomLayer, topLayer],
				imageLayers: [],
				selectedImageLayer: null,
			}),
		});

		expect(screen.queryByRole("button", { name: "ย้ายเลเยอร์ที่เลือกขึ้น" })).toBeNull();
		expect(screen.getByRole("button", { name: "ย้ายเลเยอร์ที่เลือกลง" })).toBeTruthy();
		expect(screen.getByText("บนสุดแล้ว")).toBeTruthy();
	});

	it("lets the selected-layer card toggle visibility and lock while keeping the real layer list secondary", async () => {
		const layer = textLayer({ id: "quick-state-layer", text: "Quick state", index: 0 });
		const props = baseProps({
			selectedLayer: layer,
			textLayers: [layer],
			imageLayers: [],
			selectedImageLayer: null,
		});
		render(LayersInspectorPanel, { props });

		const selectedActions = within(screen.getByRole("group", { name: "ลำดับเลเยอร์ที่เลือก" }));
		expect(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" })).toBeTruthy();
		await fireEvent.click(selectedActions.getByRole("button", { name: "ซ่อนเลเยอร์ที่เลือก" }));
		await fireEvent.click(selectedActions.getByRole("button", { name: "ล็อกเลเยอร์ที่เลือก" }));

		expect(props.onToggleLayerVisibility).toHaveBeenCalledWith("quick-state-layer");
		expect(props.onToggleLayerLock).toHaveBeenCalledWith("quick-state-layer");
		expect(props.onToggleImageLayerVisibility).not.toHaveBeenCalled();
		expect(props.onToggleImageLayerLock).not.toHaveBeenCalled();
	});

	it("keeps text-list quick actions only on the selected row", async () => {
		const selectedText = textLayer({ id: "selected-type-row", text: "Selected row", index: 0 });
		const inactiveText = textLayer({
			id: "inactive-type-row",
			text: "Inactive row",
			index: 1,
			sourceCategory: undefined,
			sourceProvider: undefined,
			confidence: undefined,
			protected: false,
		});
		const { container } = render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: selectedText,
				textLayers: [selectedText, inactiveText],
				imageLayers: [],
				selectedImageLayer: null,
			}),
		});
		await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));

		const textRows = Array.from(container.querySelectorAll("#text-layers-section .layer-row")) as HTMLElement[];
		const selectedTextRow = textRows.find((row) => row.classList.contains("active"))!;
		const inactiveTextRow = textRows.find((row) => !row.classList.contains("active"))!;
		expect(selectedTextRow.querySelectorAll(".layer-actions button")).toHaveLength(4);
		expect(inactiveTextRow.querySelector(".layer-actions")).toBeNull();
		expect(within(inactiveTextRow).getByRole("button", { name: "เลือกและแก้ค่ากล่องข้อความ Inactive row" })).toBeTruthy();
	});

	it("routes selected image card visibility and lock controls to image-layer actions", async () => {
		const layer = imageLayer({
			id: "quick-image-state",
			name: "Quick image",
			visible: false,
			locked: true,
		});
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
			textLayers: [],
		});
		render(LayersInspectorPanel, { props });

		const selectedActions = within(screen.getByRole("group", { name: "ลำดับเลเยอร์ที่เลือก" }));
		await fireEvent.click(selectedActions.getByRole("button", { name: "แสดงเลเยอร์ที่เลือก" }));
		await fireEvent.click(selectedActions.getByRole("button", { name: "ปลดล็อกเลเยอร์ที่เลือก" }));

		expect(props.onToggleImageLayerVisibility).toHaveBeenCalledWith("quick-image-state");
		expect(props.onToggleImageLayerLock).toHaveBeenCalledWith("quick-image-state");
		expect(props.onToggleLayerVisibility).not.toHaveBeenCalled();
		expect(props.onToggleLayerLock).not.toHaveBeenCalled();
	});

	it("keeps image-list quick actions only on the selected row", async () => {
		const selectedImage = imageLayer({ id: "selected-image-row", originalName: "selected-image.webp", index: 0 });
		const inactiveImage = imageLayer({ id: "inactive-image-row", originalName: "inactive-image.webp", index: 1 });
		const { container } = render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: selectedImage,
				imageLayers: [selectedImage, inactiveImage],
				textLayers: [],
			}),
		});
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		const imageRows = Array.from(container.querySelectorAll("#image-layers-section .layer-row")) as HTMLElement[];
		const selectedImageRow = imageRows.find((row) => row.classList.contains("active"))!;
		const inactiveImageRow = imageRows.find((row) => !row.classList.contains("active"))!;
		expect(selectedImageRow.querySelectorAll(".layer-actions button")).toHaveLength(4);
		expect(inactiveImageRow.querySelector(".layer-actions")).toBeNull();
		expect(within(inactiveImageRow).getByRole("button", { name: "เลือกและแก้ค่ารูปเสริม inactive-image.webp" })).toBeTruthy();
	});

	it("starts Clean brush from a selected image layer without exposing it for credits", async () => {
		const image = imageLayer({ id: "clean-target", role: "overlay", originalName: "clean-target.webp" });
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: image,
			imageLayers: [image],
		});

		const { unmount } = render(LayersInspectorPanel, { props });

		const primaryActions = screen.getByLabelText("คำสั่งแก้รูปเสริมหลัก");
		expect(within(primaryActions).getByRole("button", { name: /แปรงคลีน/ })).toBeTruthy();
		await fireEvent.click(within(primaryActions).getByRole("button", { name: /แปรงคลีน/ }));
		expect(props.onStartSelectedImageBrush).toHaveBeenCalledTimes(1);
		unmount();

		const credit = imageLayer({ id: "credit-image-clean-block", role: "credit", originalName: "credit.png" });
		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: credit,
				imageLayers: [credit],
			}),
		});
		expect(screen.queryByRole("button", { name: /แปรงคลีน/ })).toBeNull();
	});

	it("shows selected image brush restore availability in the Layers context", async () => {
		const image = imageLayer({ id: "clean-target-active", role: "overlay", originalName: "clean-active.webp" });
		editorStore.currentTool = "brush";
		editorStore.selectedImageLayer = image;
		editorStore.refreshBrushTarget();
		const { unmount } = render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: image,
				imageLayers: [image],
			}),
		});

		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("กู้คืนจะเปิดหลังมีรอยแปรง");
		expect(screen.queryByLabelText("โหมดแปรงคลีน ของเลเยอร์ที่เลือก")).toBeNull();
		unmount();

		const restoreReady = imageLayer({
			id: "clean-target-restore",
			role: "overlay",
			originalName: "clean-restore.webp",
			restoreImageId: "clean-restore-source.webp",
		});
		editorStore.currentTool = "brush";
		editorStore.selectedImageLayer = restoreReady;
		editorStore.refreshBrushTarget();
		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: restoreReady,
				imageLayers: [restoreReady],
			}),
		});

		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("กู้คืนพร้อมใช้");
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).not.toContain("มีรอยแปรงบนเลเยอร์นี้");
		editorStore.lastImageLayerBrushCommit = {
			layerId: "clean-target-restore",
			title: "clean-restore.webp",
			mode: "erase",
			restoreImageId: "clean-restore-source.webp",
		};
		await tick();
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("คลีนแล้ว");
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("มีรอยแปรงบนเลเยอร์นี้");
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("คืนได้จากต้นฉบับเลเยอร์");
		editorStore.lastImageLayerBrushCommit = {
			layerId: "clean-target-restore",
			title: "clean-restore.webp",
			mode: "restore",
			restoreImageId: "clean-restore-source.webp",
		};
		await tick();
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("คืนรอยปัดแล้ว");
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).toContain("คืนรอยปัดบนเลเยอร์นี้แล้ว");
		expect(screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก").textContent).not.toContain("คลีนแล้ว");
	});

	it("keeps selected image Clean brush ownership in Layers without duplicating topbar controls", async () => {
		const image = imageLayer({
			id: "clean-target-owner",
			role: "overlay",
			originalName: "clean-owner.webp",
			restoreImageId: "clean-owner-source.webp",
		});
		editorStore.editor = {
			setBrushSize: vi.fn(),
			setBrushHardness: vi.fn(),
			setBrushOpacity: vi.fn(),
			setBrushMode: vi.fn(),
			setBrushEnabled: vi.fn(),
			destroy: vi.fn(),
		} as any;
		editorStore.currentTool = "brush";
		editorStore.selectedImageLayer = image;
		editorStore.refreshBrushTarget();

		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: image,
				imageLayers: [image],
			}),
		});

		const strip = screen.getByLabelText("แปรงคลีนกำลังแก้เลเยอร์ที่เลือก");
		expect(strip.textContent).toContain("clean-owner.webp");
		expect(strip.textContent).toContain("ตั้งขนาด, ความทึบ, โหมดลบ/กู้คืนที่แถบบน");
		expect(strip.textContent).toContain("30px / 100% / ลบภาพ");
		expect(screen.queryByLabelText("ปรับแปรงคลีน ของเลเยอร์ที่เลือก")).toBeNull();
		expect(screen.queryByLabelText("โหมดแปรงคลีน ของเลเยอร์ที่เลือก")).toBeNull();
		expect(screen.queryByText("ปรับละเอียด")).toBeNull();
		expect(screen.queryByRole("button", { name: "ตั้งแปรงใหญ่สำหรับเลเยอร์ที่เลือก" })).toBeNull();
	});

	it("keeps text credit creation hidden until real credit text exists", async () => {
		render(LayersInspectorPanel, { props: baseProps({ creditText: "" }) });

		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));

		expect(screen.queryByRole("button", { name: "สร้างเครดิตข้อความ" })).toBeNull();
		const textCreditStatus = screen.getByLabelText("สถานะสร้างเครดิตข้อความ");
		expect(textCreditStatus.tagName.toLowerCase()).toBe("span");
		expect(textCreditStatus.textContent).toContain("ยังไม่สร้างข้อความ");
		expect(textCreditStatus.textContent).toContain("ใช้รูปเครดิต");
	});

	it("replaces credit delete controls with a receipt when there is no credit layer to delete", async () => {
		const props = baseProps({
			textLayers: [textLayer()],
			imageLayers: [imageLayer()],
			selectedLayer: null,
			selectedImageLayer: null,
		});

		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));

		const deleteScope = screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต");
		expect(deleteScope.textContent).toContain("ยังไม่มีเครดิตให้ลบ");
		expect(screen.queryByRole("button", { name: "ลบเครดิตที่เลือก" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบเครดิตหน้านี้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบเครดิตทุกหน้า" })).toBeNull();
	});

	it("renders layer metadata and delegates layer, credit, and style actions", async () => {
		const props = baseProps();
		const { container, rerender } = render(LayersInspectorPanel, { props });

		expect(screen.getAllByText("เลือกกล่องข้อความ").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("Translated line").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByRole("button", { name: "ไปที่คุณสมบัติ เลเยอร์ที่เลือก" }).textContent).toContain("ตั้งค่า");
		expect(screen.getByRole("button", { name: "ไปที่เอฟเฟกต์ พร้อมแก้" }).textContent).toContain("เอฟเฟกต์");
		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		expect(screen.getAllByText("sfx-reference.webp").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText("บทพูด")).toBeTruthy();
		expect(screen.getByText("72%")).toBeTruthy();
		expect(screen.getByText("JSON")).toBeTruthy();
		expect(screen.getByText("กันแก้")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "โครงสร้างเลเยอร์หน้านี้" })).toBeNull();
		const unifiedStack = screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" }) as HTMLDetailsElement;
		expect(unifiedStack.open).toBe(true);
		expect(screen.getByText("ลำดับเลเยอร์จริง")).toBeTruthy();
		expect(screen.queryByText(/ตอนนี้ข้อความอยู่เหนือรูปเสริม/)).toBeNull();
		expect(screen.getAllByText("ภาพฐาน").length).toBeGreaterThanOrEqual(1);
		expect(container.querySelector("#unified-row-text-layer-1")).toBeTruthy();
		expect(screen.getByRole("group", { name: "ลำดับเลเยอร์ที่เลือก" })).toBeTruthy();
		const selectedStackContext = within(screen.getByRole("status", { name: "ตำแหน่งเลเยอร์ที่เลือกในเลเยอร์งาน" }));
		expect(selectedStackContext.getByText("กำลังแก้")).toBeTruthy();
		expect(selectedStackContext.getByText("ข้อความ · Translated line")).toBeTruthy();
		expect(selectedStackContext.getByText(/รูป ·/)).toBeTruthy();
		const activeStackRow = unifiedStack.querySelector(".unified-stack-row.active") as HTMLElement;
		expect(within(activeStackRow).queryByLabelText("คำสั่งเร็ว Translated line")).toBeNull();
		expect(within(activeStackRow).queryByRole("button", { name: "ย้าย Translated line ลง" })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "ย้ายเลเยอร์ที่เลือกขึ้น" }));
		expect(props.onMoveUnifiedLayer).toHaveBeenCalledWith("text", "layer-1", 1);
		expect(unifiedStack.open).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "เลือกเลเยอร์ sfx-reference.webp" }));
		expect(props.onSelectImageLayer).toHaveBeenCalledWith("image-layer-1");
		await fireEvent.click(screen.getByRole("button", { name: "เลือกเลเยอร์ Translated line" }));
		expect(props.onSelectLayer).toHaveBeenCalledWith("layer-1");
		await fireEvent.click(screen.getByRole("button", { name: "ย้าย sfx-reference.webp ขึ้น" }));
		expect(props.onMoveUnifiedLayer).toHaveBeenCalledWith("image", "image-layer-1", 1);

		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		expect(screen.getAllByText("สร้าง / วาง / ลบเครดิต").length).toBeGreaterThanOrEqual(1);
		const creditHelp = screen.getByText("ขั้นตอนเครดิต").closest("details") as HTMLDetailsElement;
		expect(creditHelp.open).toBe(false);
		expect(container.querySelector("#credit-text")).toBeTruthy();
		await fireEvent.click(screen.getByText("ขั้นตอนเครดิต"));
		expect(creditHelp.open).toBe(true);
		expect(screen.getByText("1. เขียนเครดิต")).toBeTruthy();
		expect(screen.getByText("2. ใส่เครดิตที่ไหน")).toBeTruthy();
		expect(screen.getByText("3. จัดการเครดิต")).toBeTruthy();
		expect(screen.getByRole("button", { name: /หัว\+ท้าย หน้าแรก \+ หน้าสุดท้าย/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /ทุกหน้า เหมาะกับเครดิตประจำตอน/ })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "วางข้อความ" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มรูปเสริมจากแผงเลเยอร์" }));
		await fireEvent.change(container.querySelector("#image-asset-library")!, {
			target: { value: "ref.webp" },
		});
		await rerender({ ...props, selectedImageAssetId: "ref.webp" });
		await fireEvent.click(screen.getByRole("button", { name: "นำรูปนี้กลับมาใช้" }));
		await fireEvent.click(screen.getByRole("button", { name: "เลือกและแก้ค่ารูปเสริม sfx-reference.webp" }));
		await rerender({ ...props, selectedLayer: null, selectedImageLayer: props.imageLayers[0], selectedImageAssetId: "ref.webp" });
		await fireEvent.click(screen.getAllByRole("button", { name: "ซ่อนรูปเสริม" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ล็อกรูปเสริม" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ทำซ้ำรูปเสริมที่เลือก" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ลบรูปเสริมที่เลือก" })[0]);
		expect(props.onDeleteImageLayer).not.toHaveBeenCalled();
		await confirmLayerDelete();
		await rerender({ ...props, selectedLayer: props.selectedLayer, selectedImageLayer: null, selectedImageAssetId: "ref.webp" });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "เลือกและแก้ค่ากล่องข้อความ Translated line" }));
		await fireEvent.click(screen.getAllByRole("button", { name: "ซ่อนกล่องข้อความ" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ล็อกกล่องข้อความ" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ทำซ้ำกล่องข้อความที่เลือก" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "ลบกล่องข้อความที่เลือก" })[0]);
		expect(props.onDeleteLayer).not.toHaveBeenCalled();
		await confirmLayerDelete();

		await fireEvent.change(container.querySelector("#credit-preset")!, {
			target: { value: "credit-bottom-center" },
		});
		await fireEvent.input(container.querySelector("#credit-text")!, {
			target: { value: "Team credits" },
		});
		await fireEvent.input(container.querySelector("#credit-offset")!, {
			target: { value: "32" },
		});
		await fireEvent.input(screen.getByLabelText("ปรับความกว้างรูปเครดิตแบบเร็ว"), {
			target: { value: "320" },
		});
		expect(props.onCreditImageMaxWidthChange).toHaveBeenCalledWith(320);
		await fireEvent.input(screen.getByLabelText("ปรับระยะวางซ้ำเครดิตแบบเร็ว"), {
			target: { value: "900" },
		});
		expect(props.onCreditImageRepeatEveryPxChange).toHaveBeenCalledWith(900);
		await rerender({ ...props, creditImageRepeatEveryPx: 900 });
		expect(screen.getAllByText(/เครดิตซ้ำทุก 900px/).length).toBeGreaterThanOrEqual(1);
		await fireEvent.change(screen.getByLabelText("เลือกขอบเขตเครดิต"), {
			target: { value: "all" },
		});
		await fireEvent.input(container.querySelector("#credit-preset-name")!, {
			target: { value: "Bottom credit" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "สร้างเครดิตข้อความ" }));
		const creditImageImportButton = screen.getByRole("button", { name: "Import รูปเครดิต" });
		expect(creditImageImportButton.className).toContain("panel-btn-secondary");
		await fireEvent.click(creditImageImportButton);
		await rerender({
			...props,
			selectedImageAssetId: "ref.webp",
			textLayers: [
				...props.textLayers,
				textLayer({ id: "credit-text-added", text: "Team credits", sourceCategory: "credit", index: 2 }),
			],
			imageLayers: [
				...props.imageLayers,
				imageLayer({ id: "credit-image-added", role: "credit", originalName: "credit.png", imageName: "credit.png", index: 2 }),
			],
		});
		expect(screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ลบเครดิตที่เลือก" })).toBeNull();
		const quickDeleteScope = screen.getByLabelText("เลือกขอบเขตลบเครดิต") as HTMLSelectElement;
		expect(Array.from(quickDeleteScope.options).map((option) => option.textContent)).toContain("เครดิตทั้งหมดในหน้านี้");
		expect(Array.from(quickDeleteScope.options).map((option) => option.textContent)).toContain("เครดิตทุกหน้าในตอนนี้");
		await fireEvent.change(quickDeleteScope, { target: { value: "chapter-all" } });
		await fireEvent.click(screen.getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }));
		expect(props.onDeleteCreditLayers).not.toHaveBeenCalled();
		await confirmLayerDelete();
		await fireEvent.click(screen.getByRole("button", { name: "บันทึกชุดค่าเครดิต" }));

		await fireEvent.input(container.querySelector("#text-layer-text")!, {
			target: { value: "Updated line" },
		});
		await fireEvent.change(container.querySelector("#text-style-preset")!, {
			target: { value: "preset-sfx" },
		});
		await fireEvent.input(container.querySelector("#text-effect-prompt")!, {
			target: { value: "angry sfx" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "ใช้ชุดสไตล์แนะนำ SFX" }));
		await fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นชุดสไตล์/ }));
		await fireEvent.input(container.querySelector("#text-style-preset-name")!, {
			target: { value: "Impact" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "บันทึกชุดสไตล์ข้อความ" }));
		await fireEvent.click(screen.getByRole("button", { name: "ไทป์เซ็ตให้พอดีกล่อง" }));
		await fireEvent.click(screen.getByRole("button", { name: /สี \/ จัดวาง \/ ขอบ/ }));
		await fireEvent.input(container.querySelector("#text-layer-opacity")!, {
			target: { value: "64" },
		});
		await fireEvent.input(container.querySelector("#text-layer-fill")!, {
			target: { value: "#222222" },
		});
		await fireEvent.input(container.querySelector("#text-layer-stroke")!, {
			target: { value: "#eeeeee" },
		});
		await fireEvent.input(container.querySelector("#text-layer-stroke-width")!, {
			target: { value: "4" },
		});
		await fireEvent.change(container.querySelector("#text-layer-alignment")!, {
			target: { value: "right" },
		});

		expect(props.onStartTextPlacement).toHaveBeenCalledTimes(1);
		expect(props.onAddImageLayer).toHaveBeenCalledTimes(1);
		expect(props.onImageAssetSelectionChange).toHaveBeenCalledWith("ref.webp");
		expect(props.onAddSelectedImageAssetLayer).toHaveBeenCalledTimes(1);
		expect(props.onSelectImageLayer).toHaveBeenCalledWith("image-layer-1");
		expect(props.onToggleImageLayerVisibility).toHaveBeenCalledWith("image-layer-1");
		expect(props.onToggleImageLayerLock).toHaveBeenCalledWith("image-layer-1");
		expect(props.onDuplicateImageLayer).toHaveBeenCalledWith("image-layer-1");
		expect(props.onMoveImageLayer).not.toHaveBeenCalled();
		expect(props.onDeleteImageLayer).toHaveBeenCalledWith("image-layer-1");
		expect(props.onSelectLayer).toHaveBeenCalledWith("layer-1");
		expect(props.onToggleLayerVisibility).toHaveBeenCalledWith("layer-1");
		expect(props.onToggleLayerLock).toHaveBeenCalledWith("layer-1");
		expect(props.onDuplicateLayer).toHaveBeenCalledWith("layer-1");
		expect(props.onMoveLayer).not.toHaveBeenCalled();
		expect(props.onDeleteLayer).toHaveBeenCalledWith("layer-1");
		expect(props.onCreditPresetChange).toHaveBeenCalledWith("credit-bottom-center");
		expect(props.onCreditTextChange).toHaveBeenCalledWith("Team credits");
		expect(props.onCreditOffsetChange).toHaveBeenCalledWith(32);
		expect(props.onCreditImageMaxWidthChange).toHaveBeenCalledWith(320);
		expect(props.onCreditImageRepeatEveryPxChange).toHaveBeenCalledWith(900);
		expect(props.onCreditApplyScopeChange).toHaveBeenCalledWith("all");
		expect(props.onCreditPresetNameChange).toHaveBeenCalledWith("Bottom credit");
		expect(props.onAddCredit).toHaveBeenCalledTimes(1);
		expect(props.onAddCreditImage).toHaveBeenCalledTimes(1);
		expect(props.onDeleteCreditLayers).toHaveBeenCalledWith(true, "all", undefined);
		expect(props.onSaveCreditPreset).toHaveBeenCalledTimes(1);
		expect(props.onSelectedTextChange).toHaveBeenCalledWith("Updated line");
		expect(props.onSelectedPresetChange).toHaveBeenCalledWith("preset-sfx");
		expect(props.onTextEffectPromptChange).toHaveBeenCalledWith("angry sfx");
		expect(props.onSuggestedPresetApply).toHaveBeenCalledWith("preset-sfx");
		expect(props.onPresetNameChange).toHaveBeenCalledWith("Impact");
		expect(props.onSaveCurrentPreset).toHaveBeenCalledTimes(1);
		expect(props.onFitSelectedText).toHaveBeenCalledTimes(1);
		expect(props.onTextOpacityChange).toHaveBeenCalledWith(0.64);
		expect(props.onFillChange).toHaveBeenCalledWith("#222222");
		expect(props.onStrokeChange).toHaveBeenCalledWith("#eeeeee");
		expect(props.onStrokeWidthChange).toHaveBeenCalledWith(4);
		expect(props.onAlignmentChange).toHaveBeenCalledWith("right");
	}, 15_000);

	it("keeps credit delete scope buttons stable while confirmation names page and impact", async () => {
		const currentCreditText = textLayer({ id: "credit-current-text", text: "Team credits", sourceCategory: "credit" });
		const currentCreditImage = imageLayer({ id: "credit-current-image", role: "credit", imageId: "credit.webp" });
		const currentProject = project([]);
		currentProject.currentPage = 0;
		currentProject.pages = [
			{
				...currentProject.pages[0],
				textLayers: [currentCreditText],
				imageLayers: [currentCreditImage],
			},
			{
				...currentProject.pages[0],
				imageId: "image-2.webp",
				imageName: "image-2.webp",
				textLayers: [textLayer({ id: "credit-other-text", text: "Other credits", sourceCategory: "credit" })],
				imageLayers: [],
			},
		];
		projectStore.__setProjectForTesting(currentProject);
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: null,
			textLayers: [currentCreditText],
			imageLayers: [currentCreditImage],
		});
		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		const deleteCard = screen.getByLabelText("ลบเครดิตแบบเลือกขอบเขต");
		const scopeSelect = within(deleteCard).getByLabelText("เลือกขอบเขตลบเครดิต") as HTMLSelectElement;
		const optionLabels = Array.from(scopeSelect.options).map((option) => option.textContent);
		expect(optionLabels).toContain("เครดิตทั้งหมดในหน้านี้");
		expect(optionLabels).toContain("เครดิตทุกหน้าในตอนนี้");
		expect(screen.queryByRole("button", { name: "ลบข้อความเครดิตหน้านี้" })).toBeNull();

		await fireEvent.change(scopeSelect, { target: { value: "current-all" } });
		await fireEvent.click(within(deleteCard).getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }));
		const currentDialog = screen.getByRole("alertdialog", { name: "ลบเครดิตหน้านี้?" });
		expect(currentDialog.textContent).toContain("จะลบเครดิต 2 เลเยอร์จากหน้าปัจจุบัน");
		expect(currentDialog.textContent).toContain("หน้า 1, ข้อความ 1 / รูป 1");
		expect(currentDialog.textContent).toContain("เครดิตหน้าอื่นยังอยู่ 1 เลเยอร์");
		await fireEvent.click(within(currentDialog).getByRole("button", { name: "ยกเลิก" }));

		await fireEvent.change(scopeSelect, { target: { value: "chapter-all" } });
		await fireEvent.click(within(deleteCard).getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }));
		const allDialog = screen.getByRole("alertdialog", { name: "ลบเครดิตทุกหน้า?" });
		expect(allDialog.textContent).toContain("จะลบเครดิต 3 เลเยอร์จากทุกหน้าในตอนนี้");
		expect(allDialog.textContent).toContain("ข้อความ 2 / รูป 1");
	});

	it("surfaces a direct fit action when the selected text is likely to overflow", async () => {
		const overflowingLayer = textLayer({
			id: "overflowing-text",
			text: "คำแปลยาวมากมากมากมากมากมากมากมากมากมากมากมากมากมากมาก",
			w: 60,
			h: 22,
			fontSize: 30,
		});
		const props = baseProps({
			selectedLayer: overflowingLayer,
			textLayers: [overflowingLayer],
			focusLayerId: overflowingLayer.id,
			focusToken: 1,
		});
		render(LayersInspectorPanel, { props });

		const alert = screen.getByRole("status", { name: "ข้อความล้นกล่องที่เลือก" });
		expect(within(alert).getByText("ข้อความอาจล้นกล่อง")).toBeTruthy();
		expect(within(alert).getByText(/ประมาณ/)).toBeTruthy();
		const boxStatus = screen.getByRole("status", { name: "สถานะกล่องข้อความที่เลือก" });
		expect(within(boxStatus).getByText(/กล่อง 60 x 22px/)).toBeTruthy();
		expect(within(boxStatus).getByText(/แนะนำ/)).toBeTruthy();
		expect(within(alert).getByRole("button", { name: "ขยายกล่องข้อความที่เลือกให้พอดี" })).toBeTruthy();
		expect(within(alert).getByText("ย่อให้พอดี")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ขยายกล่องข้อความตามข้อความปัจจุบัน" })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: /ขนาดกล่องละเอียด/ }));
		expect(screen.getByRole("button", { name: "ขยายกล่องข้อความตามข้อความปัจจุบัน" })).toBeTruthy();

		await fireEvent.click(within(alert).getByRole("button", { name: "ปรับข้อความที่เลือกให้พอดีกล่อง" }));

		expect(props.onFitSelectedText).toHaveBeenCalledTimes(1);
	});

	it("hides the selected text grow action when the current box already fits", () => {
		const props = baseProps();
		render(LayersInspectorPanel, { props });

		const boxStatus = screen.getByRole("status", { name: "สถานะกล่องข้อความที่เลือก" });
		expect(within(boxStatus).getByText("กล่อง 160 x 72px")).toBeTruthy();
		expect(within(boxStatus).queryByText(/แนะนำ/)).toBeNull();
		expect(screen.queryByRole("button", { name: "ขยายกล่องข้อความตามข้อความปัจจุบัน" })).toBeNull();
	});

	it("expands the selected text box when text is already at the minimum font size", async () => {
		const overflowingLayer = textLayer({
			id: "minimum-text-box",
			text: "คำแปลยาวมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมาก",
			w: 40,
			h: 12,
			fontSize: 6,
		});
		const props = baseProps({
			selectedLayer: overflowingLayer,
			textLayers: [overflowingLayer],
			focusLayerId: overflowingLayer.id,
			focusToken: 1,
		});
		render(LayersInspectorPanel, { props });

		const alert = screen.getByRole("status", { name: "ข้อความล้นกล่องที่เลือก" });
		expect(within(alert).getByText("กล่องเล็กเกินข้อความ")).toBeTruthy();
		expect(within(alert).getByText("ย่อสุดแล้ว ต้องขยายกล่องหรือย่อข้อความ")).toBeTruthy();

		await fireEvent.click(within(alert).getByRole("button", { name: "ขยายกล่องข้อความที่เลือกให้พอดี" }));

		expect(props.onFitSelectedText).not.toHaveBeenCalled();
		expect(props.onSelectedTextBoxChange).toHaveBeenCalledTimes(1);
		const [updates] = props.onSelectedTextBoxChange.mock.calls[0];
		expect(updates.w).toBeGreaterThanOrEqual(overflowingLayer.w);
		expect(updates.h).toBeGreaterThan(overflowingLayer.h);
	});

	it("keeps scoped image and text lists free of duplicate reorder controls", async () => {
		const props = baseProps();
		const { container } = render(LayersInspectorPanel, { props });

		if (screen.queryByRole("button", { name: "รูปเสริม พับอยู่" })) {
			await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		}
		if (screen.queryByRole("button", { name: "กล่องข้อความ พับอยู่" })) {
			await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));
		}

		const imageRows = container.querySelectorAll(".image-layer-row");
		const textRows = container.querySelectorAll("#text-layers-section .layer-row");
		expect(imageRows[0].getAttribute("draggable")).toBeNull();
		expect(textRows[0].getAttribute("draggable")).toBeNull();
		expect(screen.queryByRole("button", { name: "ย้ายรูปเสริมขึ้น" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ย้ายรูปเสริมลง" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ย้ายกล่องข้อความขึ้น" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ย้ายกล่องข้อความลง" })).toBeNull();
		expect(props.onMoveImageLayer).not.toHaveBeenCalled();
		expect(props.onMoveLayer).not.toHaveBeenCalled();
	});

	it("keeps type-list quick actions scoped to the selected row", async () => {
		const selectedText = textLayer({ id: "selected-text", text: "Selected text", index: 0 });
		const inactiveText = textLayer({ id: "inactive-text", text: "Inactive text", index: 1 });
		const selectedImage = imageLayer({ id: "selected-image", originalName: "selected-image.webp", index: 0 });
		const inactiveImage = imageLayer({ id: "inactive-image", originalName: "inactive-image.webp", index: 1 });
		const props = baseProps({
			textLayers: [selectedText, inactiveText],
			selectedLayer: selectedText,
			selectedImageLayer: null,
			imageLayers: [selectedImage, inactiveImage],
		});
		const { container, rerender } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));

		const textRows = container.querySelectorAll("#text-layers-section .layer-row");
		expect(within(textRows[0] as HTMLElement).getByRole("button", { name: "ทำซ้ำกล่องข้อความที่เลือก" })).toBeTruthy();
		expect(within(textRows[0] as HTMLElement).getByRole("button", { name: "ลบกล่องข้อความที่เลือก" })).toBeTruthy();
		expect(within(textRows[0] as HTMLElement).getAllByRole("button")).toHaveLength(5);
		expect(within(textRows[1] as HTMLElement).queryByRole("button", { name: "ทำซ้ำกล่องข้อความที่เลือก" })).toBeNull();
		expect(within(textRows[1] as HTMLElement).queryByRole("button", { name: "ลบกล่องข้อความที่เลือก" })).toBeNull();
		expect(within(textRows[1] as HTMLElement).queryByRole("button", { name: "ซ่อนกล่องข้อความ" })).toBeNull();
		expect(within(textRows[1] as HTMLElement).queryByRole("button", { name: "ล็อกกล่องข้อความ" })).toBeNull();
		expect(within(textRows[1] as HTMLElement).getAllByRole("button")).toHaveLength(1);

		await rerender({ ...props, selectedLayer: null, selectedImageLayer: selectedImage });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		const imageRows = container.querySelectorAll(".image-layer-row");
		expect(within(imageRows[0] as HTMLElement).getByRole("button", { name: "ทำซ้ำรูปเสริมที่เลือก" })).toBeTruthy();
		expect(within(imageRows[0] as HTMLElement).getByRole("button", { name: "ลบรูปเสริมที่เลือก" })).toBeTruthy();
		expect(within(imageRows[0] as HTMLElement).getAllByRole("button")).toHaveLength(5);
		expect(within(imageRows[1] as HTMLElement).queryByRole("button", { name: "ทำซ้ำรูปเสริมที่เลือก" })).toBeNull();
		expect(within(imageRows[1] as HTMLElement).queryByRole("button", { name: "ลบรูปเสริมที่เลือก" })).toBeNull();
		expect(within(imageRows[1] as HTMLElement).queryByRole("button", { name: "ซ่อนรูปเสริม" })).toBeNull();
		expect(within(imageRows[1] as HTMLElement).queryByRole("button", { name: "ล็อกรูปเสริม" })).toBeNull();
		expect(within(imageRows[1] as HTMLElement).getAllByRole("button")).toHaveLength(1);
	});

	it("supports drag and drop ordering across the real mixed layer stack", async () => {
		const props = baseProps({
			textLayers: [
				textLayer({ id: "mixed-text", text: "Mixed text", index: 0, zIndex: 1 }),
			],
			imageLayers: [
				imageLayer({ id: "mixed-image", originalName: "mixed-image.webp", index: 0, zIndex: 0 }),
			],
		});
		const { container } = render(LayersInspectorPanel, { props });
		const dataTransfer = () => ({
			setData: vi.fn(),
			effectAllowed: "",
			dropEffect: "",
		});

		const stackRows = container.querySelectorAll(".unified-stack-row:not(.base)");
		await fireEvent.dragStart(stackRows[1], { dataTransfer: dataTransfer() });
		await fireEvent.drop(stackRows[0], { dataTransfer: dataTransfer() });

		expect(props.onReorderUnifiedLayer).toHaveBeenCalledWith("image", "mixed-image", 1);
		expect(props.onMoveUnifiedLayer).not.toHaveBeenCalled();
		expect(props.onMoveImageLayer).not.toHaveBeenCalled();
		expect(props.onMoveLayer).not.toHaveBeenCalled();
	});

	it("multi-row drag dispatches one reorder command with the exact offset", async () => {
		// Stack top→bottom by descending zIndex: z3(top), z2, z1, z0(bottom).
		const props = baseProps({
			textLayers: [
				textLayer({ id: "t-top", text: "top", index: 0, zIndex: 3 }),
				textLayer({ id: "t-mid", text: "mid", index: 1, zIndex: 1 }),
			],
			imageLayers: [
				imageLayer({ id: "i-hi", originalName: "hi.webp", index: 0, zIndex: 2 }),
				imageLayer({ id: "i-lo", originalName: "lo.webp", index: 1, zIndex: 0 }),
			],
		});
		const { container } = render(LayersInspectorPanel, { props });
		const dt = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
		const rows = container.querySelectorAll(".unified-stack-row:not(.base)");
		// rows[0]=t-top(stackIdx3), rows[1]=i-hi(2), rows[2]=t-mid(1), rows[3]=i-lo(0).
		// Drag the BOTTOM row (i-lo, stackIndex 0) UP onto the TOP row (stackIndex 3).
		await fireEvent.dragStart(rows[3], { dataTransfer: dt() });
		await fireEvent.drop(rows[0], { dataTransfer: dt() });

		// delta = 3 - 0 = +3 (move up) → one drag command, not three undo entries.
		expect(props.onReorderUnifiedLayer).toHaveBeenCalledTimes(1);
		expect(props.onReorderUnifiedLayer).toHaveBeenCalledWith("image", "i-lo", 3);
		expect(props.onMoveUnifiedLayer).not.toHaveBeenCalled();
	});

	it("filters a crowded mixed stack to credit layers without changing the real stack controls", async () => {
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: null,
			textLayers: [
				textLayer({ id: "dialogue-1", text: "Dialogue one", index: 0, sourceCategory: "dialogue" }),
				textLayer({ id: "credit-text-1", name: "เครดิตข้อความ 1/3", text: "Team", index: 1, sourceCategory: "credit" }),
				textLayer({ id: "credit-text-2", name: "เครดิตข้อความ 2/3", text: "Team", index: 2, sourceCategory: "credit" }),
				textLayer({ id: "credit-text-3", name: "เครดิตข้อความ 3/3", text: "Team", index: 3, sourceCategory: "credit" }),
			],
			imageLayers: [
				imageLayer({ id: "overlay-1", originalName: "stamp.webp", index: 0, role: "overlay" }),
				imageLayer({ id: "credit-image-1", name: "รูปเครดิต 1/2", originalName: "logo.webp", index: 1, role: "credit" }),
				imageLayer({ id: "credit-image-2", name: "รูปเครดิต 2/2", originalName: "logo.webp", index: 2, role: "credit" }),
			],
		});
		render(LayersInspectorPanel, { props });

		const unifiedStack = screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" });
		expect(within(unifiedStack).getByRole("button", { name: "เครดิต 5" })).toBeTruthy();
		expect(within(unifiedStack).getByRole("button", { name: "ข้อความ 1" })).toBeTruthy();
		expect(within(unifiedStack).getByRole("button", { name: "รูป 1" })).toBeTruthy();

		await fireEvent.click(within(unifiedStack).getByRole("button", { name: "เครดิต 5" }));

		expect(within(unifiedStack).getByText("แสดง 5/7 เลเยอร์; ปุ่มขึ้นลงยังยึดลำดับจริงของหน้า")).toBeTruthy();
		expect(within(unifiedStack).getByText("เครดิตข้อความ 1/3")).toBeTruthy();
		expect(within(unifiedStack).getByText("รูปเครดิต 2/2")).toBeTruthy();
		expect(within(unifiedStack).queryByText("Dialogue one")).toBeNull();
		expect(within(unifiedStack).queryByText("stamp.webp")).toBeNull();

		await fireEvent.click(within(unifiedStack).getByRole("button", { name: "ข้อความ 1" }));
		expect(within(unifiedStack).getByText("Dialogue one")).toBeTruthy();
		expect(within(unifiedStack).queryByText("เครดิตข้อความ 1/3")).toBeNull();

		await fireEvent.click(within(unifiedStack).getByRole("button", { name: "รูป 1" }));
		expect(within(unifiedStack).getByText("stamp.webp")).toBeTruthy();
		expect(within(unifiedStack).queryByText("รูปเครดิต 1/2")).toBeNull();
	});

	it("keeps the selected layer visible when a mixed stack filter would otherwise hide it", async () => {
		const dialogue = textLayer({ id: "dialogue-1", text: "Dialogue one", index: 0, sourceCategory: "dialogue" });
		const creditText = textLayer({ id: "credit-text-1", name: "เครดิตข้อความ 1/3", text: "Team", index: 1, sourceCategory: "credit" });
		const regularImage = imageLayer({ id: "overlay-1", originalName: "stamp.webp", index: 0, role: "overlay" });
		const aiResult = imageLayer({
			id: "ai-result-marker-1",
			imageId: "ai-result.webp",
			imageName: "ai-result.webp",
			originalName: "ผล AI หน้า 1",
			name: "AI clean result",
			index: 1,
			role: "overlay",
		});
		const props = baseProps({
			selectedLayer: dialogue,
			selectedImageLayer: null,
			textLayers: [
				dialogue,
				creditText,
				textLayer({ id: "credit-text-2", name: "เครดิตข้อความ 2/3", text: "Team", index: 2, sourceCategory: "credit" }),
				textLayer({ id: "credit-text-3", name: "เครดิตข้อความ 3/3", text: "Team", index: 3, sourceCategory: "credit" }),
			],
			imageLayers: [
				regularImage,
				aiResult,
				imageLayer({ id: "credit-image-1", name: "รูปเครดิต 1/2", originalName: "logo.webp", index: 2, role: "credit" }),
				imageLayer({ id: "credit-image-2", name: "รูปเครดิต 2/2", originalName: "logo.webp", index: 3, role: "credit" }),
			],
		});
		const { rerender } = render(LayersInspectorPanel, { props });

		const unifiedStack = screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" });
		await fireEvent.click(within(unifiedStack).getByRole("button", { name: "เครดิต 5" }));

		expect(within(unifiedStack).getByText("แสดง 6/8 เลเยอร์ รวมเลเยอร์ที่เลือก; ปุ่มขึ้นลงยังยึดลำดับจริงของหน้า")).toBeTruthy();
		expect(within(unifiedStack).getByText("Dialogue one")).toBeTruthy();
		expect(within(unifiedStack).queryByText("stamp.webp")).toBeNull();
		const stackSummary = unifiedStack.querySelector(".unified-stack-summary") as HTMLElement;
		expect(within(stackSummary).getByText("Dialogue one · ลำดับ 4/8")).toBeTruthy();
		expect(within(stackSummary).getByText("รวมเลเยอร์ที่เลือกแม้ตัวกรองอื่น")).toBeTruthy();
		expect((unifiedStack as HTMLDetailsElement).open).toBe(true);
		expect(document.querySelector("#unified-row-text-dialogue-1")).toBeTruthy();
		expect(within(stackSummary).getByText("Dialogue one · ลำดับ 4/8")).toBeTruthy();
		expect(within(stackSummary).getByText("รวมเลเยอร์ที่เลือกแม้ตัวกรองอื่น")).toBeTruthy();
		await fireEvent.click(stackSummary);

		await rerender({ ...props, selectedLayer: null, selectedImageLayer: regularImage });
		await tick();
		expect(within(unifiedStack).getByText("stamp.webp")).toBeTruthy();
		expect(within(unifiedStack).getByText("แสดง 6/8 เลเยอร์ รวมเลเยอร์ที่เลือก; ปุ่มขึ้นลงยังยึดลำดับจริงของหน้า")).toBeTruthy();

		await rerender({ ...props, selectedLayer: creditText, selectedImageLayer: null });
		await tick();
		expect(within(unifiedStack).getByText("เครดิตข้อความ 1/3")).toBeTruthy();
		expect(within(unifiedStack).getByText("แสดง 5/8 เลเยอร์; ปุ่มขึ้นลงยังยึดลำดับจริงของหน้า")).toBeTruthy();

		await rerender({ ...props, selectedLayer: null, selectedImageLayer: aiResult });
		await tick();
		expect(within(unifiedStack).getByText("AI clean result")).toBeTruthy();
		expect(within(unifiedStack).getByText("แสดง 6/8 เลเยอร์ รวมเลเยอร์ที่เลือก; ปุ่มขึ้นลงยังยึดลำดับจริงของหน้า")).toBeTruthy();
	});

	it("keeps selected layer type sections collapsed until explicitly opened", async () => {
		const dialogue = textLayer({ id: "dialogue-1", text: "Dialogue one", index: 0 });
		const aiResult = imageLayer({
			id: "ai-result-marker-1",
			imageId: "ai-result.webp",
			imageName: "ai-result.webp",
			originalName: "ผล AI หน้า 1",
			name: "AI clean result",
			index: 1,
			role: "overlay",
		});
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: null,
			textLayers: [dialogue],
			imageLayers: [imageLayer({ id: "overlay-1", originalName: "stamp.webp", index: 0, role: "overlay" }), aiResult],
		});
		const { container, rerender } = render(LayersInspectorPanel, { props });

		expect(screen.getByRole("button", { name: "กล่องข้อความ เปิดอยู่" })).toBeTruthy();
		await rerender({ ...props, selectedLayer: dialogue });
		await tick();
		expect(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));
		expect(within(container.querySelector("#text-layers-section")!).getByText("Dialogue one")).toBeTruthy();

		await rerender({ ...props, selectedLayer: null, selectedImageLayer: null });
		await tick();
		expect(screen.getByRole("button", { name: "รูปเสริม เปิดอยู่" })).toBeTruthy();
		await rerender({ ...props, selectedImageLayer: aiResult });
		await tick();
		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		expect(within(container.querySelector("#image-layers-section")!).getByText("AI clean result")).toBeTruthy();
	});

	it("shows user layer names first and edits the selected text layer name", async () => {
		const layer = textLayer({ name: "Bubble hero" });
		const props = baseProps({
			textLayers: [layer],
			selectedLayer: layer,
		});
		const { container } = render(LayersInspectorPanel, { props });

		expect(screen.getAllByText("Bubble hero").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Translated line/).length).toBeGreaterThan(0);

		await fireEvent.click(screen.getByRole("button", { name: /รายละเอียดเลเยอร์/ }));
		await fireEvent.input(container.querySelector("#text-layer-name")!, {
			target: { value: "Narration top" },
		});

		expect(props.onSelectedTextLayerNameChange).toHaveBeenCalledWith("Narration top");
	});

	it("uses a multiline selected text editor for manga dialogue", async () => {
		const layer = textLayer({ text: "First line" });
		const props = baseProps({
			textLayers: [layer],
			selectedLayer: layer,
		});
		const { container } = render(LayersInspectorPanel, { props });
		const textarea = container.querySelector("#text-layer-text") as HTMLTextAreaElement;

		expect(textarea.tagName).toBe("TEXTAREA");
		expect(textarea.rows).toBeGreaterThanOrEqual(3);

		await fireEvent.input(textarea, {
			target: { value: "First line\nSecond line" },
		});

		expect(props.onSelectedTextChange).toHaveBeenCalledWith("First line\nSecond line");
	});

	it("keeps selected text formatting tools behind a collapsed drawer", async () => {
		const layer = textLayer({ text: "First line" });
		const props = baseProps({
			textLayers: [layer],
			selectedLayer: layer,
		});
		const { container } = render(LayersInspectorPanel, { props });
		const textarea = container.querySelector("#text-layer-text") as HTMLTextAreaElement;
		const drawer = container.querySelector(".selected-text-format-drawer") as HTMLDetailsElement;

		expect(textarea).toBeTruthy();
		expect(drawer).toBeTruthy();
		expect(drawer.open).toBe(false);
		expect(screen.getByText("รูปแบบตัวอักษร")).toBeTruthy();

		await fireEvent.click(screen.getByText("รูปแบบตัวอักษร"));

		expect(drawer.open).toBe(true);
		expect(screen.getByLabelText("ชุดสไตล์")).toBeTruthy();
	});

	it("shows editable names for selected image layers", async () => {
		const layer = imageLayer({ name: "AI clean result" });
		const props = baseProps({
			imageLayers: [layer],
			selectedImageLayer: layer,
			selectedLayer: null,
		});
		const { container } = render(LayersInspectorPanel, { props });

		expect(screen.getAllByText("AI clean result").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/sfx-reference.webp/).length).toBeGreaterThan(0);

		await fireEvent.input(container.querySelector("#image-layer-name")!, {
			target: { value: "Credit stamp" },
		});
		await fireEvent.change(container.querySelector("#image-layer-name")!, {
			target: { value: "Credit stamp" },
		});

		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ name: "Credit stamp" }, false);
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ name: "Credit stamp" }, true);
	});

	it("keeps selected AI result image layers from being reclassified", async () => {
		const marker = aiMarker({ id: "marker-1", status: "applied" });
		const layer = imageLayer({
			id: "ai-result-marker-1",
			imageId: "ai-result-marker-1.webp",
			imageName: "ai-result-marker-1.webp",
			originalName: "ผล AI หน้า 1",
			name: "ผล AI ที่วางแล้ว",
			role: "credit",
		});
		const testProject = project([marker]);
		testProject.pages[0].imageLayers = [layer];
		projectStore.__setProjectForTesting(testProject);
		const props = baseProps({
			imageLayers: [layer],
			selectedImageLayer: layer,
			selectedLayer: null,
		});
		const { container } = render(LayersInspectorPanel, { props });

		expect(container.querySelector("#image-layer-role")).toBeNull();
		expect(screen.getByLabelText("ประเภทเลเยอร์รูปที่เลือก")).toBeTruthy();
		expect(screen.getByText("ผล AI (คงประเภท)")).toBeTruthy();
		expect(screen.getByText(/ผล AI คงประเภทไว้/)).toBeTruthy();
		expect(screen.getByLabelText("ผลจัดวางผล AI ที่เลือก")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ดูผลรีวิว AI ของเลเยอร์ที่เลือก" })).toBeTruthy();
		expect(screen.queryByLabelText("คำสั่งหลักผล AI ที่เลือก")).toBeNull();
		expect(screen.getByRole("button", { name: "ปรับผล AI ให้พอดีหน้า" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "คืนสัดส่วนจริงของผล AI" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "เปิดแปรงคลีนเฉพาะผล AI ที่เลือก" })).toHaveLength(1);
		expect(container.querySelector(".image-layer-advanced-drawer")?.hasAttribute("open")).toBe(false);

		await fireEvent.click(screen.getByRole("button", { name: "ดูผลรีวิว AI ของเลเยอร์ที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ปรับผล AI ให้พอดีหน้า" }));
		await fireEvent.click(screen.getByRole("button", { name: "คืนสัดส่วนจริงของผล AI" }));
		await fireEvent.click(screen.getByText("จัดการเลเยอร์"));
		expect(screen.getByRole("button", { name: "คัดลอกผล AI ที่เลือก" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ทำซ้ำผล AI ที่เลือก" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ลบผล AI ที่เลือก" })).toBeTruthy();

		expect(props.onSelectedImageLayerChange).not.toHaveBeenCalledWith({ role: "reference" }, true);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-1");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(1, "fit-page");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(2, "source-aspect");
	});

	it("makes hidden selected AI result layers read as base-image comparison", async () => {
		const marker = aiMarker({ id: "marker-compare", status: "applied" });
		const layer = imageLayer({
			id: "ai-result-marker-compare",
			imageId: "ai-result-marker-compare.webp",
			imageName: "ai-result-marker-compare.webp",
			originalName: "ผล AI หน้า 1",
			name: "ผล AI ที่วางแล้ว",
			role: "overlay",
			visible: false,
		});
		const testProject = project([marker]);
		testProject.pages[0].imageLayers = [layer];
		projectStore.__setProjectForTesting(testProject);
		const props = baseProps({
			imageLayers: [layer],
			selectedImageLayer: layer,
			selectedLayer: null,
		});
		render(LayersInspectorPanel, { props });

		expect(screen.getAllByText("กำลังเทียบภาพฐาน").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("ผล AI ถูกซ่อนไว้ชั่วคราวเพื่อดูภาพฐานเดิม กดกลับ AI เมื่อพร้อมแก้ต่อ.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "กลับมาแสดงผล AI" }).textContent).toBe("กลับ AI");

		await fireEvent.click(screen.getByRole("button", { name: "กลับมาแสดงผล AI" }));
		expect(props.onToggleImageLayerVisibility).toHaveBeenCalledWith("ai-result-marker-compare");
	});

	it("shows image layer state badges for non-default transforms", async () => {
		const layer = imageLayer({
			opacity: 0.64,
			rotation: 17,
			flipX: true,
			flipY: true,
			blendMode: "multiply",
			sourceW: 600,
			sourceH: 200,
			w: 300,
			h: 300,
		});
		render(LayersInspectorPanel, {
			props: baseProps({
				selectedLayer: null,
				selectedImageLayer: layer,
				imageLayers: [layer],
			}),
		});

		expect(screen.getAllByText("Multiply").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		expect(screen.getByText("กลับซ้ายขวา")).toBeTruthy();
		expect(screen.getByText("กลับบนล่าง")).toBeTruthy();
		expect(screen.getAllByText("64%").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("หมุน 17°")).toBeTruthy();
		expect(screen.getByText("สัดส่วนเบี้ยว")).toBeTruthy();
	});

	it("keeps selected image properties first until asset replacement is explicit", async () => {
		const selectedLayer = imageLayer({ id: "image-layer-selected", originalName: "รูปทับซ้อนเดิม.webp" });
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: selectedLayer,
			imageLayers: [selectedLayer],
		});
		const { container } = render(LayersInspectorPanel, { props });
		const advancedDrawer = container.querySelector(".image-layer-advanced-drawer") as HTMLDetailsElement;

		expect(screen.queryByLabelText("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toBeNull();
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
		expect(screen.getByText("ตั้งค่ารูปเสริม")).toBeTruthy();
		expect(advancedDrawer.open).toBe(false);
		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ตั้งค่ารูป" }));
		expect(advancedDrawer.open).toBe(true);
		expect(screen.getByLabelText("ข้อมูลและโหมดรูปเสริม")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "คลังรูป" }));

		expect(screen.getByLabelText("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toBeTruthy();
		expect(screen.getByText("กำลังแทนที่รูปของ รูปทับซ้อนเดิม.webp")).toBeTruthy();
	});

	it("starts selected layers with properties first and secondary layer-type list collapsed", async () => {
		const props = baseProps();
		render(LayersInspectorPanel, { props });

		expect(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้").length).toBeGreaterThanOrEqual(1);
		expect(within(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้")[0]).getByText("กำลังแก้ตอนนี้")).toBeTruthy();
		expect(within(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้")[0]).getByText("Translated line")).toBeTruthy();
		expect(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
		expect(screen.queryByLabelText("งานเลเยอร์ถัดไป")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "แก้กล่องข้อความที่เลือก" }));

		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
	});

	it("compacts unrelated selected-layer stack context while the credit workflow is open", async () => {
		const props = baseProps();
		render(LayersInspectorPanel, { props });

		expect(screen.getByRole("status", { name: "ตำแหน่งเลเยอร์ที่เลือกในเลเยอร์งาน" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));

		const creditHelp = screen.getByText("ขั้นตอนเครดิต").closest("details") as HTMLDetailsElement;
		expect(creditHelp.open).toBe(false);
		expect(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByRole("status", { name: "ตำแหน่งเลเยอร์ที่เลือกในเลเยอร์งาน" })).toBeNull();
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
	});

	it("compacts selected credit stack context while editing credits", async () => {
		const credit = textLayer({
			id: "credit-selected",
			name: "เครดิตทีมท้ายหน้า",
			text: "ทีมแปล",
			sourceCategory: "credit",
			index: 1,
		});
		const props = baseProps({
			selectedLayer: credit,
			textLayers: [
				textLayer({ id: "dialogue-layer", text: "Dialogue", index: 0 }),
				credit,
			],
			imageLayers: [],
		});
		render(LayersInspectorPanel, { props });

		expect(screen.getAllByLabelText("เลเยอร์ที่กำลังแก้").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByRole("status", { name: "ตำแหน่งเลเยอร์ที่เลือกในเลเยอร์งาน" })).toBeNull();
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
		const unifiedStack = screen.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" }) as HTMLDetailsElement;
		const stackSummary = unifiedStack.querySelector(".unified-stack-summary") as HTMLElement;
		expect(unifiedStack.open).toBe(false);
		expect(within(stackSummary).getByText("เครดิตทีมท้ายหน้า · ลำดับ 1/2")).toBeTruthy();
		expect(within(stackSummary).getByText("เปิดเพื่อดูแถวที่เลือกในชั้นจริง")).toBeTruthy();
	});

	it("opens properties when a layer row is selected from either layer list", async () => {
		const props = baseProps();
		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" }));
		expect(screen.getByRole("button", { name: "คุณสมบัติ พับอยู่" })).toBeTruthy();

		if (screen.queryByRole("button", { name: "รูปเสริม พับอยู่" })) {
			await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		}
		await fireEvent.click(screen.getAllByRole("button", { name: /เลือกและแก้ค่ารูปเสริม/ })[0]);

		expect(props.onSelectImageLayer).toHaveBeenCalledWith("image-layer-1");
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" }));
		if (screen.queryByRole("button", { name: "กล่องข้อความ พับอยู่" })) {
			await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));
		}
		await fireEvent.click(screen.getAllByRole("button", { name: /เลือกและแก้ค่ากล่องข้อความ/ })[0]);

		expect(props.onSelectLayer).toHaveBeenCalledWith("layer-1");
		expect(screen.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeTruthy();
		expect(screen.getAllByText("เลือก").length).toBeGreaterThan(0);
	});

	it("renders duplicate layer ids from older imports without a keyed list crash", async () => {
		const props = baseProps({
			selectedLayer: null,
			textLayers: [
				textLayer({ id: "duplicate-layer", text: "First duplicate", index: 0 }),
				textLayer({ id: "duplicate-layer", text: "Second duplicate", index: 1 }),
			],
			imageLayers: [
				imageLayer({ id: "duplicate-image", imageName: "first.webp", originalName: "first.webp", index: 0 }),
				imageLayer({ id: "duplicate-image", imageName: "second.webp", originalName: "second.webp", index: 1 }),
			],
		});
		render(LayersInspectorPanel, { props });

		expect(screen.getAllByText("First duplicate").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("Second duplicate").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("first.webp").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("second.webp").length).toBeGreaterThanOrEqual(1);
	});

	it("separates selected layer copy, paste, and duplicate actions", async () => {
		const props = baseProps({ layerClipboardKind: "text" });
		render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "คัดลอกกล่องข้อความที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "วางเลเยอร์ที่คัดลอก" }));
		await fireEvent.click(screen.getAllByRole("button", { name: "ทำซ้ำกล่องข้อความที่เลือก" })[0]);

		expect(props.onCopySelectedLayer).toHaveBeenCalledTimes(1);
		expect(props.onPasteLayerClipboard).toHaveBeenCalledTimes(1);
		expect(props.onDuplicateLayer).toHaveBeenCalledWith("layer-1");
	});

	it("hides paste actions until a copied layer exists", () => {
		render(LayersInspectorPanel, { props: baseProps({ layerClipboardKind: null }) });

		expect(screen.getByRole("button", { name: "คัดลอกกล่องข้อความที่เลือก" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "วางเลเยอร์ที่คัดลอก" })).toBeNull();
	});

	it("renders empty/canvas state and keeps impossible actions passive", async () => {
		render(LayersInspectorPanel, {
			props: baseProps({
				projectOpen: false,
				hasImage: false,
				imageLayers: [],
				textLayers: [],
				selectedLayer: null,
				creditPresetName: "",
				canvasDimensions: { width: 1024, height: 1448 },
			}),
		});

		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		expect(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "กล่องข้อความ พับอยู่" }));

		expect(screen.getByText("ยังไม่มีกล่องข้อความในหน้านี้")).toBeTruthy();
		expect(screen.getByText("ภาพต้นฉบับโหลดแล้ว แต่ยังไม่มีรูปเสริม")).toBeTruthy();
		expect(screen.getByText("รูปเสริมคือภาพอ้างอิงหรือภาพทับซ้อน ไม่ใช่ภาพ manga หลัก")).toBeTruthy();
		expect(screen.getAllByText("1024 x 1448").length).toBeGreaterThanOrEqual(1);
		await fireEvent.click(screen.getByRole("button", { name: "เครดิต พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "เอฟเฟกต์ พับอยู่" }));
		expect(screen.getAllByText("เลือกกล่องข้อความก่อนแก้เอฟเฟกต์").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByRole("button", { name: "วางข้อความ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เริ่มวางข้อความ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เพิ่มรูปเสริมจากงานเลเยอร์ถัดไป" })).toBeNull();
		expect(screen.getByText("เปิดรูปหน้าก่อนวางข้อความ")).toBeTruthy();
		expect(screen.getByText("เปิดงานจากคลังก่อนเพิ่มเลเยอร์แก้ไข")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เพิ่มรูปเสริมจากแผงเลเยอร์" })).toBeNull();
		expect(screen.getByText("เปิดรูปหน้าก่อนเพิ่มรูปเสริม")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Import รูปเครดิต" })).toBeNull();
		expect(screen.getByLabelText("สถานะ Import รูปเครดิต").textContent).toContain("เปิดงานก่อน Import รูปเครดิต");
		expect(screen.getByText("เปิดงานก่อนใช้ทุกหน้า/หัวท้าย")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /ทุกหน้า เหมาะกับเครดิตประจำตอน/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "บันทึกชุดค่าเครดิต" })).toBeNull();
		expect(screen.getByLabelText("สถานะบันทึกชุดค่าเครดิต").textContent).toContain("เปิดงานก่อนบันทึกชุดค่าเครดิต");
	});

	it("filters reusable image assets before selection", async () => {
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: null,
			imageLayers: [
				imageLayer(),
				imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", originalName: "stamp.webp", index: 1, role: "overlay" }),
			],
		});
		const { container, rerender } = render(LayersInspectorPanel, { props });
		const collapsedImageSection = screen.queryByRole("button", { name: "รูปเสริม พับอยู่" });
		if (collapsedImageSection) await fireEvent.click(collapsedImageSection);
		const filterInput = container.querySelector("#image-asset-filter") as HTMLInputElement;
		const assetSelect = container.querySelector("#image-asset-library") as HTMLSelectElement;

		expect(Array.from(assetSelect.options).map((option) => option.textContent?.trim())).toEqual([
			"เลือกรูป",
			"sfx-reference.webp | 180 x 120 | 2 KB | ref.webp",
			"stamp-overlay.webp | 96 x 96 | 2 KB | stamp.we",
		]);
		expect(screen.getByRole("button", { name: "เลือกรูปใช้ซ้ำ sfx-reference.webp ref.webp" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เลือกรูปใช้ซ้ำ stamp-overlay.webp stamp.we" })).toBeTruthy();
		// The thumbnail <img> is loaded via the signedAssetSrc action, which resolves
		// an asset token (or falls back to the bare URL) and sets `src` asynchronously.
		await waitFor(() => expect(container.querySelector('img[src*="/images/project-1/ref.webp/thumbnail"]')).toBeTruthy());

		await fireEvent.click(screen.getByRole("button", { name: "แสดงรูปแบบกริด" }));
		expect(screen.getByRole("button", { name: "แสดงรูปแบบกริด" }).getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector(".asset-browser-grid")).toBeTruthy();

		await fireEvent.input(filterInput, { target: { value: "stamp" } });
		await tick();

		expect(screen.getByText("1/2")).toBeTruthy();
		expect(Array.from(assetSelect.options).map((option) => option.textContent?.trim())).toEqual([
			"เลือกรูป",
			"stamp-overlay.webp | 96 x 96 | 2 KB | stamp.we",
		]);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกรูปใช้ซ้ำ stamp-overlay.webp stamp.we" }));
		expect(props.onImageAssetSelectionChange).toHaveBeenCalledWith("stamp.webp");

		await rerender({ ...props, selectedImageAssetId: "stamp.webp" });
		const detailCard = screen.getByLabelText("รายละเอียดรูปที่เลือก");
		expect(detailCard).toBeTruthy();
		expect(within(detailCard).getByText("1 เลเยอร์")).toBeTruthy();
		expect(within(detailCard).getByText("WebP")).toBeTruthy();
		expect(within(detailCard).getByText("พร้อมใช้ / ผ่าน")).toBeTruthy();
		expect(within(detailCard).getByText("2026-05-12")).toBeTruthy();
		expect(within(detailCard).getByText("ชนิดไฟล์")).toBeTruthy();
		expect(within(detailCard).getByText("รูปที่จะใช้")).toBeTruthy();
		expect(within(detailCard).getByText("96 x 96 / 2 KB")).toBeTruthy();
		expect(detailCard.querySelector(".asset-detail-preview-image")).toBeTruthy();
		// Preview <img> src is set asynchronously by the signedAssetSrc action.
		await waitFor(() => expect(detailCard.querySelector('img[src*="stamp.webp"]')).toBeTruthy());
		expect(within(detailCard).queryByText(/เลเยอร์ที่เลือก:/)).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "นำรูปนี้กลับมาใช้" }));
		expect(props.onAddSelectedImageAssetLayer).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "แทนที่รูปในเลเยอร์ที่เลือก" })).toBeNull();

		await fireEvent.input(filterInput, { target: { value: "missing" } });
		await tick();

		expect(screen.getByText("0/2")).toBeTruthy();
		expect(container.querySelector("#image-asset-library")).toBeNull();
		expect(screen.getAllByText("ไม่พบรูป").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("เลือกรูปก่อน")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "นำรูปนี้กลับมาใช้" })).toBeNull();
	});

	it("turns selected image asset reuse into a focused replacement mode from Library", async () => {
		const selectedLayer = imageLayer({ id: "image-layer-selected", originalName: "รูปทับซ้อนเดิม.webp" });
		projectStore.__setProjectForTesting(project([]));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "flow208-prototype-journey",
			title: "Flow208 Prototype Journey",
			chapterLabel: "ตอน 104",
			language: "TH",
			reason: "แก้รูปเสริม",
		});
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: selectedLayer,
			imageLayers: [
				selectedLayer,
				imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", originalName: "stamp.webp", index: 1, role: "overlay" }),
			],
		});
		const { rerender } = render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByText("คลังรูป"));

		expect(screen.getByLabelText("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toBeTruthy();
		expect(screen.getByText("กำลังแทนที่รูปของ รูปทับซ้อนเดิม.webp")).toBeTruthy();
		expect(screen.getByText("เลือกรูปตัวเลือกด้านล่าง แล้วกดแทนที่เลเยอร์นี้; คำสั่งจัดเลเยอร์ถูกซ่อนไว้ชั่วคราว")).toBeTruthy();
		expect(screen.queryByLabelText("ตัวกรองรูปเสริม")).toBeNull();
		expect(screen.queryByLabelText(/คำสั่งรูปเสริมแบบกลุ่ม/)).toBeNull();
		expect(screen.queryByLabelText("รายการรูปเสริม")).toBeNull();
		expect(screen.queryByRole("button", { name: "นำรูปนี้กลับมาใช้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "แทนที่รูปในเลเยอร์ที่เลือก" })).toBeNull();
		expect(screen.getByLabelText("คลังรูปที่ใช้ซ้ำได้")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เลือกรูปใช้ซ้ำ stamp-overlay.webp stamp.we" }));
		expect(props.onImageAssetSelectionChange).toHaveBeenCalledWith("stamp.webp");

		await rerender({ ...props, selectedImageAssetId: "stamp.webp" });
		const detailCard = screen.getByLabelText("รายละเอียดรูปที่เลือก");
		expect(within(detailCard).getByText("เลเยอร์ที่เลือก: รูปทับซ้อนเดิม.webp")).toBeTruthy();
		expect(within(detailCard).getByRole("button", { name: "แทนที่เลเยอร์ที่เลือกด้วย stamp-overlay.webp" })).toBeTruthy();
		expect(within(detailCard).getByRole("button", { name: "เพิ่ม stamp-overlay.webp เป็นเลเยอร์ใหม่" })).toBeTruthy();
	});

	it("falls back when a reusable image asset thumbnail fails to load", async () => {
		const props = baseProps();
		const { container } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		// The signedAssetSrc action sets `src` asynchronously (token mint falls back
		// to the bare URL in this env); wait for it before simulating a load error.
		await waitFor(() => expect(container.querySelector('img[src*="/images/project-1/ref.webp/thumbnail"]')).toBeTruthy());
		const refThumbnail = container.querySelector('img[src*="/images/project-1/ref.webp/thumbnail"]') as HTMLImageElement;
		await fireEvent.error(refThumbnail);

		expect(container.querySelector('img[src*="/images/project-1/ref.webp/thumbnail"]')).toBeNull();
		expect(screen.getByText("RE")).toBeTruthy();
	});

	it("does not request backend thumbnails for debug image assets", async () => {
		const props = baseProps({
			imageAssets: [imageAsset({ storageDriver: "debug" })],
		});
		const { container } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		expect(container.querySelector('img[src*="/thumbnail"]')).toBeNull();
		expect(screen.getByText("RE")).toBeTruthy();
	});

	it("keeps long reusable asset libraries compact until expanded or searched", async () => {
		const assets = Array.from({ length: 8 }, (_, index) => {
			const page = String(index + 1).padStart(2, "0");
			return imageAsset({
				assetId: `asset-${page}.webp`,
				imageId: `image-${page}.webp`,
				originalName: `C:\\Users\\Suphot\\Downloads\\p104\\image-${page}.webp`,
				width: 800,
				height: index === 0 ? 800 : 12000 + index,
				sizeBytes: 512000 + index,
			});
		});
		const props = baseProps({ imageAssets: assets, imageLayers: [], selectedLayer: null });
		const { container } = render(LayersInspectorPanel, { props });

		expect(screen.getByRole("button", { name: "รูปเสริม พับอยู่" })).toBeTruthy();
		expect(container.querySelector("#image-asset-library")).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		const assetSelect = container.querySelector("#image-asset-library") as HTMLSelectElement;

		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(0);
		await fireEvent.click(container.querySelector(".asset-library-summary")!);
		await tick();

		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(6);
		expect(screen.getByRole("button", { name: "แสดงรูปใช้ซ้ำทั้งหมด 8 รายการ" })).toBeTruthy();
		expect(screen.getByText("ซ่อนอยู่ 2")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เลือกรูปใช้ซ้ำ image-08.webp asset-08" })).toBeNull();
		expect(assetSelect.options[1]?.textContent?.trim()).toBe("image-01.webp | 800 x 800 | 500 KB | asset-01");
		expect(assetSelect.options[1]?.textContent).not.toContain("C:\\Users");

		await fireEvent.click(screen.getByRole("button", { name: "แสดงรูปใช้ซ้ำทั้งหมด 8 รายการ" }));
		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(8);
		expect(screen.getByRole("button", { name: "ย่อคลังรูป" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ย่อคลังรูป" }));
		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(6);

		await fireEvent.input(container.querySelector("#image-asset-filter")!, {
			target: { value: "image-08" },
		});
		await tick();

		expect(screen.getByText("1/8")).toBeTruthy();
		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "เลือกรูปใช้ซ้ำ image-08.webp asset-08" })).toBeTruthy();

		await fireEvent.input(container.querySelector("#image-asset-filter")!, {
			target: { value: "" },
		});
		await tick();

		expect(screen.getByText("8/8")).toBeTruthy();
		expect(container.querySelectorAll(".asset-browser-row")).toHaveLength(6);
		expect(screen.getByRole("button", { name: "แสดงรูปใช้ซ้ำทั้งหมด 8 รายการ" })).toBeTruthy();
	});

	it("delegates image layer bulk actions and disables completed no-ops", async () => {
		const props = baseProps({
			imageLayers: [
				imageLayer({ visible: false, locked: true }),
				imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", originalName: "stamp.webp", index: 1, role: "overlay" }),
			],
		});
		const { rerender } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		await fireEvent.click(screen.getByRole("button", { name: "แสดง รูปเสริมทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: "ซ่อน รูปเสริมทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: "ล็อก รูปเสริมทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: "ปลดล็อก รูปเสริมทั้งหมด" }));

		expect(props.onApplyImageLayerBulkAction).toHaveBeenNthCalledWith(1, "show-all", undefined);
		expect(props.onApplyImageLayerBulkAction).toHaveBeenNthCalledWith(2, "hide-all", undefined);
		expect(props.onApplyImageLayerBulkAction).toHaveBeenNthCalledWith(3, "lock-all", undefined);
		expect(props.onApplyImageLayerBulkAction).toHaveBeenNthCalledWith(4, "unlock-all", undefined);

		await rerender({
			...props,
			imageLayers: [imageLayer({ visible: true, locked: false })],
		});

		expect(screen.queryByRole("button", { name: "แสดง รูปเสริมทั้งหมด" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ปลดล็อก รูปเสริมทั้งหมด" })).toBeNull();
		expect(screen.getByRole("button", { name: "ซ่อน รูปเสริมทั้งหมด" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ล็อก รูปเสริมทั้งหมด" })).toBeTruthy();
	});

	it("keeps the empty image-layer bulk note readable across the row", async () => {
		const props = baseProps({
			imageLayers: [
				imageLayer({ role: "overlay" }),
			],
		});
		const { container } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "กรองรูปเสริมแบบเครดิต" }));

		const note = screen.getByText("ไม่มีคำสั่งกลุ่มตอนนี้");
		expect(note).toBeTruthy();
		expect(note.classList.contains("image-layer-bulk-note")).toBe(true);
		expect(container.querySelector(".image-layer-bulk-row .image-layer-bulk-note")).toBe(note);
	});

	it("filters image layers by role and scopes bulk actions to the visible role", async () => {
		const props = baseProps({
			imageLayers: [
				imageLayer(),
				imageLayer({ id: "image-layer-2", imageId: "stamp.webp", imageName: "stamp.webp", originalName: "stamp.webp", index: 1, role: "overlay" }),
			],
		});
		const { container } = render(LayersInspectorPanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: "รูปเสริม พับอยู่" }));

		expect(container.querySelectorAll(".image-layer-row")).toHaveLength(2);
		await fireEvent.click(screen.getByRole("button", { name: "กรองรูปเสริมแบบทับซ้อน" }));

		expect(screen.getByRole("button", { name: "กรองรูปเสริมแบบทับซ้อน" }).getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelectorAll(".image-layer-row")).toHaveLength(1);
		expect(screen.getAllByText(/รูปทับซ้อน/).length).toBeGreaterThan(0);

		await fireEvent.click(screen.getByRole("button", { name: /ซ่อน.*รูปทับซ้อน/ }));

		expect(props.onApplyImageLayerBulkAction).toHaveBeenCalledWith("hide-all", ["image-layer-2"]);
	});

	it("edits selected image layer geometry and opacity", async () => {
		const layer = imageLayer();
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		const { container } = render(LayersInspectorPanel, { props });

		await fireEvent.input(container.querySelector("#image-layer-opacity")!, {
			target: { value: "45" },
		});
		await fireEvent.input(container.querySelector("#image-layer-x")!, {
			target: { value: "72" },
		});
		await fireEvent.input(container.querySelector("#image-layer-width")!, {
			target: { value: "256" },
		});
		await fireEvent.change(container.querySelector("#image-layer-role")!, {
			target: { value: "overlay" },
		});
		await fireEvent.change(container.querySelector("#image-layer-blend-mode")!, {
			target: { value: "screen" },
		});

		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ opacity: 0.45 });
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ x: 72 });
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ w: 256 });
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ role: "overlay" }, true);
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ blendMode: "screen" }, true);
	});

	it("marks selected image layer numeric changes as committed on change", async () => {
		const layer = imageLayer();
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		const { container } = render(LayersInspectorPanel, { props });

		await fireEvent.change(container.querySelector("#image-layer-x")!, {
			target: { value: "84" },
		});

		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ x: 84 }, true);
	});

	it("delegates selected image layer alignment controls and hides them when locked", async () => {
		const layer = imageLayer();
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		const { rerender } = render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดซ้าย" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมกึ่งกลางแนวนอน" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดขวา" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดบน" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมกึ่งกลางแนวตั้ง" }));
		await fireEvent.click(screen.getByRole("button", { name: "จัดรูปเสริมชิดล่าง" }));

		expect(props.onAlignSelectedImageLayer).toHaveBeenCalledTimes(6);
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(1, "left");
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(2, "center-x");
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(3, "right");
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(4, "top");
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(5, "center-y");
		expect(props.onAlignSelectedImageLayer).toHaveBeenNthCalledWith(6, "bottom");

		await rerender({
			...props,
			selectedImageLayer: imageLayer({ locked: true }),
			imageLayers: [imageLayer({ locked: true })],
		});

		expect(screen.queryByRole("button", { name: "จัดรูปเสริมชิดซ้าย" })).toBeNull();
		expect(screen.queryByRole("button", { name: "จัดรูปเสริมชิดล่าง" })).toBeNull();
		expect(screen.getByText("ปลดล็อกก่อนจัดแนวรูปเสริม")).toBeTruthy();
	});

	it("delegates selected image layer transform presets and hides them when locked", async () => {
		const layer = imageLayer();
		const props = baseProps({
			selectedLayer: null,
			selectedImageLayer: layer,
			imageLayers: [layer],
		});
		const { rerender } = render(LayersInspectorPanel, { props });

		await fireEvent.click(screen.getByRole("button", { name: "ตั้งค่ารูป" }));
		const transformGrid = screen.getByLabelText("ชุดคำสั่งแปลงรูปเสริมที่เลือก");

		await fireEvent.click(within(transformGrid).getByRole("button", { name: "พอดีหน้ารูปเสริม" }));
		await fireEvent.click(screen.getByRole("button", { name: "ขยายรูปเสริมเต็มความกว้างหน้า" }));
		await fireEvent.click(screen.getByRole("button", { name: "ขยายรูปเสริมเต็มความสูงหน้า" }));
		await fireEvent.click(within(transformGrid).getByRole("button", { name: "คืนสัดส่วนจริงรูปเสริม" }));
		await fireEvent.click(within(transformGrid).getByRole("button", { name: "รีเซ็ตการหมุนรูปเสริม" }));
		await fireEvent.click(within(transformGrid).getByRole("button", { name: "คืนค่าแปลงรูปเสริม" }));
		await fireEvent.click(within(transformGrid).getByRole("button", { name: "กลับด้านรูปเสริมแนวนอน" }));
		await fireEvent.click(within(transformGrid).getByRole("button", { name: "กลับด้านรูปเสริมแนวตั้ง" }));

		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenCalledTimes(6);
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(1, "fit-page");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(2, "fill-width");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(3, "fill-height");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(4, "source-aspect");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(5, "reset-rotation");
		expect(props.onApplySelectedImageLayerTransformPreset).toHaveBeenNthCalledWith(6, "reset-transform");
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ flipX: true }, true);
		expect(props.onSelectedImageLayerChange).toHaveBeenCalledWith({ flipY: true }, true);

		await rerender({
			...props,
			selectedImageLayer: imageLayer({ locked: true }),
			imageLayers: [imageLayer({ locked: true })],
		});

		const lockedTransformGrid = screen.getByLabelText("ชุดคำสั่งแปลงรูปเสริมที่เลือก");
		expect(within(lockedTransformGrid).queryByRole("button", { name: "พอดีหน้ารูปเสริม" })).toBeNull();
		expect(within(lockedTransformGrid).queryByRole("button", { name: "คืนสัดส่วนจริงรูปเสริม" })).toBeNull();
		expect(within(lockedTransformGrid).queryByRole("button", { name: "รีเซ็ตการหมุนรูปเสริม" })).toBeNull();
		expect(within(lockedTransformGrid).queryByRole("button", { name: "คืนค่าแปลงรูปเสริม" })).toBeNull();
		expect(within(lockedTransformGrid).queryByRole("button", { name: "กลับด้านรูปเสริมแนวนอน" })).toBeNull();
		expect(within(lockedTransformGrid).getByText("ปลดล็อกก่อนแปลงรูปเสริม")).toBeTruthy();
	});

	it("focuses selected text input when a parent focus request arrives", async () => {
		const layer = textLayer();
		const props = baseProps({ selectedLayer: layer, textLayers: [layer] });
		const { container, rerender } = render(LayersInspectorPanel, { props });

		await rerender({
			...props,
			focusLayerId: layer.id,
			focusToken: 1,
		});
		await tick();
		await tick();

		expect(document.activeElement).toBe(container.querySelector("#text-layer-text"));
	});
});
