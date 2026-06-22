<!-- ToolOptionsBar - top contextual options bar for editor tools -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { isAiResultImageLayer } from "$lib/types.js";
	import { config } from "$lib/config.js";
	import FontPicker from "./FontPicker.svelte";
	import FontSizePicker from "./FontSizePicker.svelte";
	import AdjustmentsPanel from "./editor-ui/AdjustmentsPanel.svelte";
	import CropRatioPicker from "./editor/CropRatioPicker.svelte";
	import { toolRegistry } from "$lib/editor/tool-registry.svelte.js";
	import { ADJUSTMENTS_TOOL_ID } from "$lib/editor/tools/adjustments-tool.js";
	import { MANGA_TEXT_STYLE_PRESETS, textLayerStyleFromMangaPreset, type MangaTextStylePreset } from "$lib/editor-tools/text-styles.js";
	import ColorPickerPopover from "$lib/editor-ui/ColorPickerPopover.svelte";
	import HistoryPanel from "$lib/editor-ui/HistoryPanel.svelte";

	// brushTarget.title is a dynamic display name when titleCode is null, else a
	// localized fixed label. editor.svelte.ts now emits stable titleCode codes.
	let brushTargetTitle = $derived(
		editorStore.brushTarget.titleCode
			? $_(`brushTarget.title.${editorStore.brushTarget.titleCode}`)
			: editorStore.brushTarget.title,
	);

	// The active dock tool resolves which contextual option group the top bar
	// renders (Photopea-style). Selection-driven contexts below still take
	// priority when a real object is selected.
	let activeOptionsContext = $derived(toolRegistry.optionsContextFor(editorUiStore.activeDockTool));
	let currentTool = $derived(editorStore.currentTool);
	let selectedLayer = $derived(editorStore.selectedLayer);
	let selectedImageLayer = $derived(editorStore.selectedImageLayer);
	let hasImage = $derived(editorStore.hasImage);
	let showAdvancedText = $state(false);
	let showAdvancedBrush = $state(false);
	let historyPanelOpen = $state(false);
	let historyPanelPosition = $state({ top: 0, left: 0 });
	let colorPickerTarget = $state<"brush" | "image-fill" | null>(null);
	let colorPickerPosition = $state({ top: 0, left: 0 });
	let historyTriggerEl = $state<HTMLButtonElement | null>(null);
	let historyPopoverEl = $state<HTMLDivElement | null>(null);
	let colorTriggerEl = $state<HTMLButtonElement | null>(null);
	let colorPopoverEl = $state<HTMLDivElement | null>(null);
	const HISTORY_POPOVER_WIDTH = 340;
	const COLOR_POPOVER_WIDTH = 300;
	// Context derivations
	let isSoloMode = $derived(editorUiStore.workspaceMode === "solo");
	// W3.13: the active image-edit suite tool (marquee / lasso / magic wand / heal
	// / clone / ...). It runs on the "select" engine tool but must own the toolbar
	// so its contextual options replace the plain select/selection contexts.
	let activeImageTool = $derived(editorStore.activeImageTool);
	let isImageToolContext = $derived(activeImageTool !== null);
	// Heal + clone are the brush-radius tools (rec #5): show a size slider + `[`/`]`.
	let isImagePaintTool = $derived(editorStore.isImagePaintTool);
	// Magic-wand + color-range select by color similarity: show a tolerance slider.
	let isImageSelectTool = $derived(editorStore.isImageSelectTool);
	// Bubble Auto-Clean: show edge-threshold + fill-mode + grow controls.
	let isBubbleCleanTool = $derived(editorStore.isBubbleCleanTool);
	let imageToolUsesFillColor = $derived(activeImageTool === "bucket-fill" || activeImageTool === "magic-clean");
	const IMAGE_TOOL_LABEL_KEYS: Record<string, string> = {
		"marquee": "toolOptions.imageToolMarquee",
		"lasso": "toolOptions.imageToolLasso",
		"polygon-lasso": "toolOptions.imageToolPolygonLasso",
		"magic-wand": "toolOptions.imageToolMagicWand",
		"color-range": "toolOptions.imageToolColorRange",
		"refine-edge": "toolOptions.imageToolRefineEdge",
		"healing-brush": "toolOptions.imageToolHealingBrush",
		"clone-stamp": "toolOptions.imageToolCloneStamp",
		"bubble-clean": "toolOptions.imageToolBubbleClean",
	};
	const IMAGE_TOOL_LABEL_KEY_ADJUSTMENTS = "toolOptions.adjustmentsHint";
	let activeImageToolLabel = $derived(
		activeImageTool
			? (IMAGE_TOOL_LABEL_KEYS[activeImageTool]
				? $_(IMAGE_TOOL_LABEL_KEYS[activeImageTool])
				: (activeImageTool === ADJUSTMENTS_TOOL_ID ? $_(IMAGE_TOOL_LABEL_KEY_ADJUSTMENTS) : activeImageTool))
			: "",
	);
	let isAdjustmentsTool = $derived(activeImageTool === ADJUSTMENTS_TOOL_ID);
	let canApplyAdjustments = $derived(hasImage && editorStore.canUseAdjustmentsTool);
	let adjustmentsBlockedByLayers = $derived(editorStore.adjustmentsBlockedByEditLayers);
	// A tool "owns" the toolbar when it is an active editing tool whose contextual
	// options should win over selection-derived contexts. Crop is included so its
	// ratio picker can claim the bar (relocated out of the old select context).
	let toolOwnsToolbar = $derived(
		currentTool === "brush"
		|| currentTool === "cover"
		|| currentTool === "text"
		|| activeOptionsContext === "crop"
		|| isImageToolContext
	);
	let workPanelOwnsSelectionContext = $derived(
		!isSoloMode
		&& editorUiStore.rightPanelMode === "work"
		&& !toolOwnsToolbar
		&& Boolean(selectedLayer || selectedImageLayer)
	);
	let isCreditContext = $derived(
		!workPanelOwnsSelectionContext && !toolOwnsToolbar && (
			(selectedLayer && selectedLayer.sourceCategory === "credit") ||
			(selectedImageLayer && selectedImageLayer.role === "credit")
		)
	);
	let isTextCreditContext = $derived(selectedLayer?.sourceCategory === "credit");
	let isImageCreditContext = $derived(Boolean(selectedImageLayer && selectedImageLayer.role === "credit"));
	let layersPanelOwnsSelectedObjectContext = $derived(
		!workPanelOwnsSelectionContext
		&& !toolOwnsToolbar
		&& editorUiStore.rightPanelMode === "layers"
		&& (
			Boolean(selectedLayer && selectedLayer.sourceCategory !== "credit")
			|| Boolean(selectedImageLayer && selectedImageLayer.role !== "credit" && !isAiResultImageLayer(selectedImageLayer))
		)
	);

	let isAiReviewContext = $derived(
		(!workPanelOwnsSelectionContext && !toolOwnsToolbar && selectedImageLayer && isAiResultImageLayer(selectedImageLayer)) ||
		(currentTool === "cover" && activeOptionsContext !== "crop")
	);

	let isTextContext = $derived(
		!layersPanelOwnsSelectedObjectContext
		&& !workPanelOwnsSelectionContext
		&& !toolOwnsToolbar
		&& selectedLayer
		&& selectedLayer.sourceCategory !== "credit"
	);

	let isImageContext = $derived(
		!layersPanelOwnsSelectedObjectContext
		&& !workPanelOwnsSelectionContext
		&& !toolOwnsToolbar
		&& selectedImageLayer
		&& selectedImageLayer.role !== "credit"
		&& !isAiResultImageLayer(selectedImageLayer)
	);

	let isBrushContext = $derived(
		currentTool === "brush"
	);
	let brushCanPaint = $derived(editorStore.brushTarget.canBrush === true);

	// Crop tool: drives the existing "cover" (aspect-ratio-constrained selection)
	// engine tool. The ratio picker lives here now, relocated out of select.
	let isCropContext = $derived(
		activeOptionsContext === "crop" && currentTool === "cover"
	);

	let isSelectContext = $derived(
		currentTool === "select" && !selectedLayer && !selectedImageLayer
	);

	let isTextToolContext = $derived(
		currentTool === "text"
	);

	// Aspect ratio helpers — the crop ratio picker now lives in the crop context.
	const aspectRatios = config.canvas.defaultAspectRatios;

	function selectAspectRatio(label: string) {
		editorStore.selectedAspectRatio = label;
		const ratio = aspectRatios[label];
		editorStore.setAspectRatio(ratio ?? null);
	}

	// Brush helpers
	function handleBrushSizeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushSize(Number(target.value));
	}

	function handleBrushOpacityChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushOpacity(Number(target.value));
	}

	function clampPopoverLeft(left: number, width = 320): number {
		if (typeof window === "undefined") return left;
		return Math.max(12, Math.min(left, window.innerWidth - width - 12));
	}

	function isConnectedElement(element: HTMLElement | null): element is HTMLElement {
		return Boolean(element && typeof document !== "undefined" && document.documentElement.contains(element));
	}

	function containsEventTarget(element: HTMLElement | null, target: EventTarget | null): boolean {
		return Boolean(element && target instanceof Node && element.contains(target));
	}

	function positionHistoryPanel(trigger = historyTriggerEl): boolean {
		if (typeof window === "undefined" || !isConnectedElement(trigger)) return false;
		const rect = trigger.getBoundingClientRect();
		historyPanelPosition = {
			top: Math.round(rect.bottom + 8),
			left: Math.round(clampPopoverLeft(rect.left, HISTORY_POPOVER_WIDTH)),
		};
		return true;
	}

	function positionColorPicker(trigger = colorTriggerEl): boolean {
		if (typeof window === "undefined" || !isConnectedElement(trigger)) return false;
		const rect = trigger.getBoundingClientRect();
		colorPickerPosition = {
			top: Math.round(rect.bottom + 8),
			left: Math.round(clampPopoverLeft(rect.left, COLOR_POPOVER_WIDTH)),
		};
		return true;
	}

	function closeFloatingPopovers(): void {
		historyPanelOpen = false;
		colorPickerTarget = null;
	}

	function closeColorPicker(): void {
		colorPickerTarget = null;
	}

	function refreshFloatingPopoverPositions(): void {
		if (historyPanelOpen && !positionHistoryPanel()) {
			historyPanelOpen = false;
		}
		if (colorPickerTarget && !positionColorPicker()) {
			colorPickerTarget = null;
		}
	}

	function toggleHistoryPanel(event: MouseEvent): void {
		historyTriggerEl = event.currentTarget as HTMLButtonElement;
		const shouldOpen = !historyPanelOpen;
		colorPickerTarget = null;
		if (!shouldOpen) {
			historyPanelOpen = false;
			return;
		}
		if (positionHistoryPanel(historyTriggerEl)) {
			historyPanelOpen = true;
		}
	}

	function jumpHistory(index: number): void {
		void editorStore.jumpHistoryTo(index);
	}

	function toggleColorPicker(target: "brush" | "image-fill", event: MouseEvent): void {
		colorTriggerEl = event.currentTarget as HTMLButtonElement;
		const nextTarget = colorPickerTarget === target ? null : target;
		historyPanelOpen = false;
		if (!nextTarget) {
			colorPickerTarget = null;
			return;
		}
		if (positionColorPicker(colorTriggerEl)) {
			colorPickerTarget = nextTarget;
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (!historyPanelOpen && !colorPickerTarget) return;
		const target = event.target;
		const clickedInsideFloatingUi =
			containsEventTarget(historyTriggerEl, target)
			|| containsEventTarget(historyPopoverEl, target)
			|| containsEventTarget(colorTriggerEl, target)
			|| containsEventTarget(colorPopoverEl, target);
		if (!clickedInsideFloatingUi) closeFloatingPopovers();
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || (!historyPanelOpen && !colorPickerTarget)) return;
		closeFloatingPopovers();
	}

	$effect(() => {
		if ((!historyPanelOpen && !colorPickerTarget) || typeof window === "undefined") return;
		const onReflow = () => refreshFloatingPopoverPositions();
		window.addEventListener("resize", onReflow);
		// Capture-phase scroll catches nested editor/toolbar scrollers, not only window scroll.
		window.addEventListener("scroll", onReflow, true);
		return () => {
			window.removeEventListener("resize", onReflow);
			window.removeEventListener("scroll", onReflow, true);
		};
	});

	function pickToolColor(target: "brush" | "image-fill", value: string): void {
		if (target === "brush") {
			editorStore.setBrushColor(value);
			return;
		}
		editorStore.setImageToolFillColor(value);
	}

	// Heal/clone (W3.13) brush size — separate from the legacy AI-layer clean brush.
	function handleImageToolBrushSizeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolBrushSize(Number(target.value));
	}

	function handleImageToolToleranceChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolTolerance(Number(target.value));
	}

	// Bubble Auto-Clean controls.
	function handleBubbleCleanThresholdChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBubbleCleanThreshold(Number(target.value));
	}

	function handleBubbleCleanGrowChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBubbleCleanGrow(Number(target.value));
	}

	// Text properties helpers
	function applyPreset(presetId: string) {
		const preset = projectStore.textStylePresets.find(p => p.id === presetId);
		if (preset) {
			editorStore.applyTextStylePreset(preset.style);
		}
	}

	function applyMangaTextPreset(presetId: MangaTextStylePreset["id"]) {
		editorStore.applyTextStylePreset(textLayerStyleFromMangaPreset(presetId));
	}

	function handleFontChange(font: string) {
		editorStore.updateTextFontFamily(font);
	}

	function handleFontSizeChange(size: number) {
		editorStore.updateTextFontSize(size);
	}

	function handleTextContentChange(e: Event) {
		const target = e.target as HTMLTextAreaElement | HTMLInputElement;
		editorStore.updateTextContent(target.value);
	}

	function handleTextFillChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.updateTextFill(target.value);
	}

	function handleTextStrokeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.updateTextStroke(target.value);
	}

	function handleTextStrokeWidthChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.updateTextStrokeWidth(Number(target.value));
	}

	function selectedLayerReceiptTitle(): string {
		if (selectedLayer) return selectedLayer.text?.trim().slice(0, 48) || $_("toolOptions.textBox");
		if (selectedImageLayer) return selectedImageLayer.originalName || selectedImageLayer.imageName || selectedImageLayer.id;
		return $_("toolOptions.receiptNoLayer");
	}

	function selectedLayerReceiptType(): string {
		if (selectedLayer?.sourceCategory === "credit") return $_("toolOptions.textCredit");
		if (selectedLayer) return $_("toolOptions.textBox");
		if (selectedImageLayer?.role === "credit") return $_("toolOptions.imageCredit");
		if (selectedImageLayer && isAiResultImageLayer(selectedImageLayer)) return $_("toolOptions.placedAiResult");
		if (selectedImageLayer) return $_("toolOptions.overlayImage");
		return $_("toolOptions.layer");
	}

	function openSelectedObjectInspector() {
		editorUiStore.setRightPanelMode("layers");
		if (selectedLayer) {
			editorUiStore.focusTextInspector(selectedLayer.id);
			return;
		}
		if (selectedImageLayer) {
			editorUiStore.focusImageInspector(selectedImageLayer.id);
		}
	}

	function toggleTextAlignment(align: "left" | "center" | "right") {
		editorStore.updateTextAlignment(align);
	}

	// Image properties helpers
	function handleImageOpacityChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.updateImageLayer({ opacity: Number(target.value) / 100 }, true);
	}

	function alignImage(alignment: "left" | "center-x" | "right" | "top" | "center-y" | "bottom") {
		const layer = selectedImageLayer;
		const editor = editorStore.editor;
		if (!layer || layer.locked === true || !editor?.imageWidth || !editor?.imageHeight) return;

		const maxX = Math.max(0, Math.round(editor.imageWidth - layer.w));
		const maxY = Math.max(0, Math.round(editor.imageHeight - layer.h));
		const centerX = Math.round(maxX / 2);
		const centerY = Math.round(maxY / 2);
		let targetX: number | undefined;
		let targetY: number | undefined;
		const updates: any = {};

		if (alignment === "left") targetX = 0;
		if (alignment === "center-x") targetX = centerX;
		if (alignment === "right") targetX = maxX;
		if (alignment === "top") targetY = 0;
		if (alignment === "center-y") targetY = centerY;
		if (alignment === "bottom") targetY = maxY;

		if (targetX !== undefined && layer.x !== targetX) updates.x = targetX;
		if (targetY !== undefined && layer.y !== targetY) updates.y = targetY;

		if (updates.x === undefined && updates.y === undefined) return;
		editorStore.updateImageLayer(updates, true);
	}

	function applyTransformPreset(preset: "fit-page" | "fill-width" | "fill-height" | "source-aspect" | "reset-rotation" | "reset-transform") {
		const layer = selectedImageLayer;
		const editor = editorStore.editor;
		if (!layer || layer.locked === true || !editor?.imageWidth || !editor?.imageHeight) return;

		const pageWidth = Math.max(1, Math.round(editor.imageWidth));
		const pageHeight = Math.max(1, Math.round(editor.imageHeight));
		const layerWidth = Math.max(1, layer.w);
		const layerHeight = Math.max(1, layer.h);
		const layerAspect = layerWidth / layerHeight;
		const sourceAspect = layer.sourceW && layer.sourceH
			? Math.max(1, layer.sourceW) / Math.max(1, layer.sourceH)
			: layerAspect;
		const updates: any = {};
		const setLayerFrame = (width: number, height: number) => {
			const centerX = layer.x + layerWidth / 2;
			const centerY = layer.y + layerHeight / 2;
			const maxX = Math.max(0, pageWidth - width);
			const maxY = Math.max(0, pageHeight - height);
			updates.x = Math.round(Math.min(Math.max(0, centerX - width / 2), maxX));
			updates.y = Math.round(Math.min(Math.max(0, centerY - height / 2), maxY));
			updates.w = width;
			updates.h = height;
		};

		if (preset === "fit-page") {
			const pageAspect = pageWidth / pageHeight;
			const width = pageAspect > sourceAspect
				? Math.max(1, Math.round(pageHeight * sourceAspect))
				: pageWidth;
			const height = pageAspect > sourceAspect
				? pageHeight
				: Math.max(1, Math.round(pageWidth / sourceAspect));
			updates.x = Math.round((pageWidth - width) / 2);
			updates.y = Math.round((pageHeight - height) / 2);
			updates.w = width;
			updates.h = height;
		} else if (preset === "fill-width") {
			const width = pageWidth;
			const height = Math.max(1, Math.round(width / sourceAspect));
			updates.x = 0;
			updates.y = Math.round((pageHeight - height) / 2);
			updates.w = width;
			updates.h = height;
		} else if (preset === "fill-height") {
			const height = pageHeight;
			const width = Math.max(1, Math.round(height * sourceAspect));
			updates.x = Math.round((pageWidth - width) / 2);
			updates.y = 0;
			updates.w = width;
			updates.h = height;
		} else if (preset === "source-aspect") {
			const width = layerWidth;
			const height = Math.max(1, Math.round(width / sourceAspect));
			setLayerFrame(width, height);
		} else if (preset === "reset-rotation") {
			updates.rotation = 0;
		} else if (preset === "reset-transform") {
			updates.rotation = 0;
			updates.opacity = 1;
			updates.flipX = false;
			updates.flipY = false;
			updates.blendMode = "normal";
		}

		editorStore.updateImageLayer(updates, true);
	}

	// Credit properties helpers
	function openCreditTools() {
		editorUiStore.setRightPanelMode("layers");
		if (isTextCreditContext && selectedLayer) {
			editorUiStore.focusTextInspector(selectedLayer.id);
			return;
		}
		if (isImageCreditContext && selectedImageLayer) {
			editorUiStore.focusImageInspector(selectedImageLayer.id);
			return;
		}
		editorUiStore.focusCreditTools();
	}

	function applySelectedTextCreditAgain() {
		if (!isTextCreditContext) {
			openCreditTools();
			return;
		}
		const preset = projectStore.creditPresets[0];
		const sourceText = selectedLayer?.text;
		if (!preset || !sourceText?.trim()) {
			openCreditTools();
			return;
		}
		const layer = projectStore.addCreditLayer(
			editorStore.editor,
			preset.id,
			sourceText,
			preset.offset,
			"current",
			0,
		);
		if (layer) editorStore.selectTextLayer(layer.id);
		editorStore.refreshTextLayers();
		editorStore.refreshImageLayers();
	}

</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="tool-options-bar" role="toolbar" aria-label={$_("toolOptions.barAria")}>
	<div class="global-history-control">
		<button
			type="button"
			class="option-btn history-trigger"
			aria-label={$_("toolOptions.historyOpen")}
			aria-expanded={historyPanelOpen}
			bind:this={historyTriggerEl}
			onclick={toggleHistoryPanel}
		>
			{$_("toolOptions.historyLabel")} {editorStore.historyEntries.length}
		</button>
		{#if historyPanelOpen}
			<div
				class="history-panel-popover"
				bind:this={historyPopoverEl}
				style={`top:${historyPanelPosition.top}px;left:${historyPanelPosition.left}px;`}
			>
				<HistoryPanel
					entries={editorStore.historyEntries}
					currentIndex={editorStore.historyCurrentIndex}
					onJump={jumpHistory}
				/>
			</div>
		{/if}
	</div>

	<div class="divider global-history-divider"></div>

	<!-- Context 0: Crop / aspect-ratio (relocated here from the old select context) -->
	{#if isCropContext}
		<div class="options-group crop-options">
			<span class="context-badge crop-badge">⛶ {$_("toolOptions.cropBadge")}</span>

			<div class="divider"></div>

			<CropRatioPicker
				ratios={aspectRatios}
				active={editorStore.selectedAspectRatio}
				onSelect={selectAspectRatio}
			/>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={() => editorStore.setTool("select")}
					class="action-btn"
					title={$_("toolOptions.backToSelectTitle")}
				>
					{$_("toolOptions.backToSelect")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Context 0b: Image-edit suite tool (W3.13) -->
	{#if isImageToolContext}
		{#if isAdjustmentsTool}
			{#if adjustmentsBlockedByLayers}
				<div class="options-group image-tool-options">
					<span class="context-badge image-tool-badge">◑ {$_("adjustments.title")}</span>
					<div class="divider"></div>
					<small class="image-tool-summary">{$_("adjustments.blockedByEditLayers")}</small>
				</div>
			{:else}
			<AdjustmentsPanel
				options={editorStore.adjustmentsOptions}
				canApply={canApplyAdjustments}
				busy={editorStore.toolBusy}
				setOptions={(next, shouldPreview) => editorStore.setAdjustmentsOptions(next, shouldPreview)}
				preview={(next) => editorStore.previewAdjustments(next)}
				commit={() => editorStore.commitAdjustments()}
				cancel={() => editorStore.cancelAdjustments()}
			/>
			{/if}
		{:else}
			<div class="options-group image-tool-options">
			<span class="context-badge image-tool-badge">✂ {$_("toolOptions.imageToolBadge")}</span>

			<div class="divider"></div>

			<div class="image-tool-summary" aria-label={$_("toolOptions.imageToolSummaryAria")}>
				<strong>{activeImageToolLabel}</strong>
				<small>{$_("toolOptions.imageToolHint")}</small>
			</div>

			{#if imageToolUsesFillColor}
				<div class="divider"></div>

				<div class="option-control color-controls">
					<button
						type="button"
						class="tool-color-trigger"
						aria-label={`${$_("toolOptions.fillPick")} ${editorStore.imageToolFillColor}`}
						aria-expanded={colorPickerTarget === "image-fill"}
						bind:this={colorTriggerEl}
						onclick={(event) => toggleColorPicker("image-fill", event)}
					>
						<span class="tool-color-swatch" style:background-color={editorStore.imageToolFillColor}></span>
						<span>{$_("toolOptions.fillLabel")}</span>
						<strong>{editorStore.imageToolFillColor}</strong>
					</button>
					{#if colorPickerTarget === "image-fill"}
						<div
							class="tool-color-popover"
							bind:this={colorPopoverEl}
							style={`top:${colorPickerPosition.top}px;left:${colorPickerPosition.left}px;`}
						>
							<ColorPickerPopover
								color={editorStore.imageToolFillColor}
								recent={editorStore.recentToolColors}
								open={true}
								label={$_("toolOptions.fillLabel")}
								title={$_("toolOptions.fillPick")}
								ariaLabel={$_("toolOptions.fillPickerAria")}
								onPick={(value) => pickToolColor("image-fill", value)}
								onClose={closeColorPicker}
							/>
						</div>
					{/if}
				</div>
			{/if}

			{#if isImagePaintTool}
				<div class="divider"></div>

				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.brushSizeLabel")}</span>
					<input
						type="range"
						min="1"
						max="100"
						step="1"
						value={editorStore.imageToolBrushSize}
						oninput={handleImageToolBrushSizeChange}
						aria-label={$_("toolOptions.imageToolBrushSizeAria")}
					/>
					<span class="value-readout">{editorStore.imageToolBrushSize} px</span>
				</div>

				<div class="divider"></div>

				<span class="brush-shortcut-hint" aria-hidden="true">
					<kbd>[</kbd> <kbd>]</kbd> {$_("toolOptions.adjustSize")}
				</span>
			{/if}

			{#if isImageSelectTool}
				<div class="divider"></div>

				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.colorToleranceLabel")}</span>
					<input
						type="range"
						min="0"
						max="100"
						step="1"
						value={editorStore.imageToolTolerance}
						oninput={handleImageToolToleranceChange}
						aria-label={$_("toolOptions.colorToleranceAria")}
					/>
					<span class="value-readout">{editorStore.imageToolTolerance}</span>
				</div>
			{/if}

			{#if isBubbleCleanTool}
				<div class="divider"></div>

				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.edgeThresholdLabel")}</span>
					<input
						type="range"
						min="40"
						max="220"
						step="1"
						value={editorStore.bubbleCleanThreshold}
						oninput={handleBubbleCleanThresholdChange}
						aria-label={$_("toolOptions.edgeThresholdAria")}
					/>
					<span class="value-readout">{editorStore.bubbleCleanThreshold}</span>
				</div>

				<div class="divider"></div>

				<div class="option-control toggle-control">
					<span class="label">{$_("toolOptions.fillLabel")}</span>
					<button
						type="button"
						class="mode-toggle-btn"
						class:active={editorStore.bubbleCleanFillMode === "white"}
						onclick={() => editorStore.setBubbleCleanFillMode("white")}
						aria-pressed={editorStore.bubbleCleanFillMode === "white"}
						title={$_("toolOptions.fillWhiteTitle")}
					>
						{$_("toolOptions.fillWhite")}
					</button>
					<button
						type="button"
						class="mode-toggle-btn"
						class:active={editorStore.bubbleCleanFillMode === "paper"}
						onclick={() => editorStore.setBubbleCleanFillMode("paper")}
						aria-pressed={editorStore.bubbleCleanFillMode === "paper"}
						title={$_("toolOptions.fillPaperTitle")}
					>
						{$_("toolOptions.fillPaper")}
					</button>
				</div>

				<div class="divider"></div>

				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.growEdgeLabel")}</span>
					<input
						type="range"
						min="-4"
						max="4"
						step="1"
						value={editorStore.bubbleCleanGrow}
						oninput={handleBubbleCleanGrowChange}
						aria-label={$_("toolOptions.growEdgeAria")}
					/>
					<span class="value-readout">{editorStore.bubbleCleanGrow} px</span>
				</div>
			{/if}

			{#if activeImageTool === "refine-edge"}
				<div class="divider"></div>
				<div class="action-buttons">
					<button
						type="button"
						class="action-btn"
						onclick={() => editorStore.refineSelectionEdge("grow", 2)}
						title={$_("toolOptions.growEdge2pxTitle")}
					>
						{$_("toolOptions.growEdgeBtn")}
					</button>
					<button
						type="button"
						class="action-btn"
						onclick={() => editorStore.refineSelectionEdge("contract", 2)}
						title={$_("toolOptions.contractEdge2pxTitle")}
					>
						{$_("toolOptions.contractEdgeBtn")}
					</button>
					<button
						type="button"
						class="action-btn"
						onclick={() => editorStore.refineSelectionEdge("feather", 2)}
						title={$_("toolOptions.featherEdge2pxTitle")}
					>
						{$_("toolOptions.featherEdgeBtn")}
					</button>
				</div>
			{/if}

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					class="action-btn"
					onclick={() => editorStore.clearImageSelection()}
					title={$_("toolOptions.clearSelectionTitle")}
				>
					{$_("toolOptions.clearSelection")}
				</button>
				<button
					type="button"
					onclick={() => editorStore.setTool("select")}
					class="action-btn"
					title={$_("toolOptions.backToSelectTitle")}
				>
					{$_("toolOptions.backToSelect")}
				</button>
			</div>
		</div>
		{/if}
	{/if}

	<!-- Context 1: Select / Viewport -->
	{#if isSelectContext}
		<div class="options-group select-options">
			<span class="context-badge select-badge">↖ {$_("toolOptions.selectBadge")}</span>

			<div class="divider"></div>

			<div class="option-buttons">
				<button
					type="button"
					onclick={() => editorStore.undo()}
					disabled={!editorStore.canUndo}
					class="option-btn"
					title={$_("toolOptions.undoTitle")}
					aria-label={$_("toolOptions.undoAria")}
				>
					{$_("toolOptions.undo")}
				</button>
				<button
					type="button"
					onclick={() => editorStore.redo()}
					disabled={!editorStore.canRedo}
					class="option-btn"
					title={$_("toolOptions.redoTitle")}
					aria-label={$_("toolOptions.redoAria")}
				>
					{$_("toolOptions.redo")}
				</button>
			</div>

			<div class="divider"></div>

			<div class="quick-add-group">
				<button
					type="button"
					onclick={() => editorStore.addTextLayer()}
					class="add-btn text-add"
					title={$_("toolOptions.addTextTitle")}
				>
					+ {$_("toolOptions.addText")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Context 2: Brush / Cleanup -->
	{#if isBrushContext}
		<div class="options-group brush-options" class:brush-blocked={!brushCanPaint}>
			<span class="context-badge brush-badge">◐ {$_("toolOptions.brushBadge")}</span>

			<div class="divider"></div>

			{#if !brushCanPaint}
				<div class="brush-target-blocker" role="status" aria-label={$_("toolOptions.brushTargetAria")}>
					<strong>{$_("toolOptions.brushBlockedTitle")}</strong>
					<span>{editorStore.brushTarget.detail || $_("toolOptions.brushBlockedDetail")}</span>
				</div>
			{:else}
				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.sizeLabel")}</span>
					<input
						type="range"
						min="5"
						max="100"
						step="1"
						value={editorStore.brushSize}
						oninput={handleBrushSizeChange}
						aria-label={$_("toolOptions.brushSizeAria")}
					/>
					<span class="value-readout">{editorStore.brushSize} px</span>
				</div>

				<div class="divider"></div>

				<div class="option-control slider-control">
					<span class="label">{$_("toolOptions.opacityLabel")}</span>
					<input
						type="range"
						min="0"
						max="100"
						step="1"
						value={editorStore.brushOpacity}
						oninput={handleBrushOpacityChange}
						aria-label={$_("toolOptions.brushOpacityAria")}
					/>
					<span class="value-readout">{editorStore.brushOpacity}%</span>
				</div>

				<div class="divider"></div>

				<!-- NOTE: no brush COLOR picker on purpose — the brush engine is
				     erase/restore only (BrushMode), a color control here would be
				     inert and misleading (in-house review P2). The fill color picker
				     for bucket-fill/magic-clean lives in the image-tools context. -->
				<div class="option-control toggle-control">
					<button
						type="button"
						class="mode-toggle-btn hud-toggle-btn"
						class:active={editorUiStore.showBrushHud}
						onclick={() => editorUiStore.toggleBrushHud()}
						aria-pressed={editorUiStore.showBrushHud}
						title={$_("toolOptions.brushHudTitle")}
					>
						{$_("toolOptions.showFloatingPanel")}
					</button>
				</div>

				<div class="divider brush-advanced-toggle"></div>

				<div class="option-control toggle-control brush-advanced-toggle">
					<button
						type="button"
						class="mode-toggle-btn advanced-brush-toggle"
						class:active={showAdvancedBrush}
						onclick={() => showAdvancedBrush = !showAdvancedBrush}
						aria-pressed={showAdvancedBrush}
						title={$_("toolOptions.brushAdvancedTitle")}
					>
						{$_("toolOptions.modeTarget", { values: { arrow: showAdvancedBrush ? '▲' : '▼' } })}
					</button>
				</div>

				<div class="divider advanced-brush-control" class:show-mobile={showAdvancedBrush}></div>

				<div class="option-control toggle-control advanced-brush-control" class:show-mobile={showAdvancedBrush}>
					<button
						type="button"
						class="mode-toggle-btn"
						class:active={editorStore.brushMode === "erase"}
						onclick={() => editorStore.setBrushMode("erase")}
						aria-pressed={editorStore.brushMode === "erase"}
						title={editorStore.brushTarget.detail}
					>
						{$_(`brushTarget.erase.${editorStore.brushTarget.eraseLabelCode}`)}
					</button>

					{#if editorStore.brushTarget.canRestore}
						<button
							type="button"
							class="mode-toggle-btn"
							class:active={editorStore.brushMode === "restore"}
							onclick={() => editorStore.setBrushMode("restore")}
							aria-pressed={editorStore.brushMode === "restore"}
							title={editorStore.brushTarget.restoreHint}
						>
							{$_(`brushTarget.restore.${editorStore.brushTarget.restoreLabelCode}`)}
						</button>
					{:else}
						<span class="disabled-receipt">{$_("toolOptions.restoreEmpty")}</span>
					{/if}
				</div>

				<div class="divider advanced-brush-control" class:show-mobile={showAdvancedBrush}></div>
			{/if}

			<div
				class="target-summary advanced-brush-control"
				class:show-mobile={showAdvancedBrush || !brushCanPaint}
				aria-label={editorStore.brushTarget.canBrush
					? `${editorStore.brushTarget.label}: ${brushTargetTitle}`
					: brushTargetTitle || $_("toolOptions.noTarget")}
			>
				<span class="target-dot" class:ready={editorStore.brushTarget.canBrush}></span>
				<span class="target-name" title={editorStore.brushTarget.detail}>
					{#if editorStore.brushTarget.canBrush}
						<!-- Compare on the stable `labelCode` editor.svelte.ts emits (was a
							value-equality check on the rendered Thai `label`). -->
						{editorStore.brushTarget.labelCode === "aiResult" ? $_("toolOptions.editingAiResult") : $_("toolOptions.editing")} {brushTargetTitle}
					{:else}
						{brushTargetTitle || $_("toolOptions.noTarget")}
					{/if}
				</span>
			</div>
		</div>
	{/if}

	<!-- Work owner guard: Team work panel owns the first decision until the user switches back to layer editing. -->
	{#if workPanelOwnsSelectionContext}
		<div class="options-group work-owner-options">
			<span class="context-badge work-badge">{$_("toolOptions.pageWork")}</span>

			<div class="divider"></div>

			<div class="work-owner-summary" aria-label={$_("toolOptions.workOwnerAria")}>
				<strong>{$_("toolOptions.workPanelLeading")}</strong>
				<small>{selectedLayerReceiptType()}: {selectedLayerReceiptTitle()}</small>
			</div>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={() => editorUiStore.setRightPanelMode("layers")}
					class="action-btn"
					title={$_("toolOptions.switchToEditLayer")}
					aria-label={$_("toolOptions.switchToEditLayer")}
				>
					{$_("toolOptions.editThisLayer")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Layers owner guard: selected object editing lives in the right inspector. -->
	{#if layersPanelOwnsSelectedObjectContext}
		<div class="options-group layer-owner-options">
			<span class="context-badge layer-badge">{$_("toolOptions.selectLayer")}</span>

			<div class="divider"></div>

			<div class="layer-owner-summary" aria-label={$_("toolOptions.layerOwnerAria")}>
				<strong>{selectedLayerReceiptType()}: {selectedLayerReceiptTitle()}</strong>
				{#if !editorUiStore.inspectorOpen}
					<small>{$_("toolOptions.editDetailsInRightPanel")}</small>
				{/if}
			</div>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={openSelectedObjectInspector}
					class="action-btn"
					title={$_("toolOptions.focusLayerInRightPanel")}
					aria-label={$_("toolOptions.focusLayerInRightPanel")}
				>
					{$_("toolOptions.openInRightPanel")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Context 3: Text Editing -->
	{#if isTextToolContext}
		<div class="options-group text-tool-options">
			<span class="context-badge text-badge">T {$_("toolOptions.placeText")}</span>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={() => editorStore.addTextLayer()}
					class="action-btn primary"
					title={$_("toolOptions.addTextBoxTitle")}
				>
					{$_("toolOptions.addTextBox")}
				</button>
				<button
					type="button"
					onclick={() => editorStore.setTool("select")}
					class="action-btn"
					title={$_("toolOptions.backToSelectShort")}
				>
					{$_("toolOptions.backToSelect")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Context 3: Text Editing -->
	{#if isTextContext && selectedLayer}
		<div class="options-group text-options">
			<span class="context-badge text-badge">T {$_("toolOptions.textBox")}</span>

			<div class="divider"></div>

			<div class="option-control font-control">
				<FontPicker
					selectedFont={selectedLayer.fontFamily || config.defaultFontFamily}
					onFontChange={handleFontChange}
				/>
			</div>

			<div class="option-control font-size-control">
				<FontSizePicker
					selectedSize={selectedLayer.fontSize || config.defaultFontSize}
					onSizeChange={handleFontSizeChange}
					compact={true}
				/>
			</div>

			<div class="divider"></div>

			<div class="option-control thai-typeset-presets" aria-label="Thai manga typeset presets">
				<span class="chip-label">Preset</span>
				{#each MANGA_TEXT_STYLE_PRESETS as preset (preset.id)}
					<button
						type="button"
						class={`typeset-preset-btn ${preset.toolbarClass}`}
						onclick={() => applyMangaTextPreset(preset.id)}
						title={preset.description}
						aria-label={`Apply Thai manga preset ${preset.name}`}
					>
						<span class="typeset-preset-code">{preset.shortLabel}</span>
						<span class="typeset-preset-name">{preset.name}</span>
					</button>
				{/each}
			</div>

			<div class="divider"></div>

			<div class="option-control text-alignment-control">
				<button
					type="button"
					class="align-btn"
					class:active={selectedLayer.alignment === "left"}
					onclick={() => toggleTextAlignment("left")}
					title={$_("toolOptions.alignLeft")}
					aria-label={$_("toolOptions.alignLeft")}
				>
					▤
				</button>
				<button
					type="button"
					class="align-btn"
					class:active={selectedLayer.alignment === "center"}
					onclick={() => toggleTextAlignment("center")}
					title={$_("toolOptions.alignCenter")}
					aria-label={$_("toolOptions.alignCenter")}
				>
					▥
				</button>
				<button
					type="button"
					class="align-btn"
					class:active={selectedLayer.alignment === "right"}
					onclick={() => toggleTextAlignment("right")}
					title={$_("toolOptions.alignRight")}
					aria-label={$_("toolOptions.alignRight")}
				>
					▧
				</button>
			</div>

			<div class="divider"></div>

			<div class="option-control color-controls">
				<div class="color-picker-wrap" title={$_("toolOptions.textColor")}>
					<span class="color-label">{$_("toolOptions.primaryColorLabel")}</span>
					<input
						type="color"
						value={selectedLayer.fill || "#111111"}
						oninput={handleTextFillChange}
						aria-label={$_("toolOptions.primaryTextColorAria")}
					/>
				</div>
			</div>

			<div class="divider"></div>

			<div class="option-control">
				<button
					type="button"
					class="advanced-toggle-btn"
					class:active={showAdvancedText}
					onclick={() => showAdvancedText = !showAdvancedText}
					aria-pressed={showAdvancedText}
					title={$_("toolOptions.advancedStyleTitle")}
				>
					{$_("toolOptions.moreStyles", { values: { arrow: showAdvancedText ? '▲' : '▼' } })}
				</button>
			</div>

			{#if showAdvancedText}
				<div class="divider advanced-divider advanced-control"></div>
				<div class="option-control color-controls advanced-control">
					<div class="color-picker-wrap" title={$_("toolOptions.strokeColor")}>
						<span class="color-label">{$_("toolOptions.strokeLabel")}</span>
						<input
							type="color"
							value={selectedLayer.stroke || "#ffffff"}
							oninput={handleTextStrokeChange}
							aria-label={$_("toolOptions.strokeColorAria")}
						/>
					</div>
				</div>

				<div class="option-control slider-control advanced-control">
					<span class="label">{$_("toolOptions.strokeWidthLabel")}</span>
					<input
						type="range"
						min="0"
						max="15"
						step="1"
						value={selectedLayer.strokeWidth || 0}
						oninput={handleTextStrokeWidthChange}
						aria-label={$_("toolOptions.strokeWidthAria")}
						style="height: 40px !important; min-height: 40px !important;"
					/>
					<span class="value-readout">{selectedLayer.strokeWidth || 0} px</span>
				</div>

				<div class="divider advanced-divider advanced-control"></div>

				<div class="option-control preset-quick-chips advanced-control">
					<span class="chip-label">{$_("toolOptions.quickStyleLabel")}</span>
					<button
						type="button"
						class="preset-chip stroke-readable"
						onclick={() => applyPreset("builtin-dialogue")}
						title={$_("toolOptions.presetDialogueTitle")}
					>
						{$_("toolOptions.presetDialogue")}
					</button>
					<button
						type="button"
						class="preset-chip sfx-red"
						onclick={() => applyPreset("builtin-sfx-impact-red")}
						title={$_("toolOptions.presetImpactRedTitle")}
					>
						{$_("toolOptions.presetImpactRed")}
					</button>
					<button
						type="button"
						class="preset-chip dungeon-blue"
						onclick={() => applyPreset("builtin-sfx-dungeon-blue")}
						title={$_("toolOptions.presetDungeonBlueTitle")}
					>
						{$_("toolOptions.presetDungeonBlue")}
					</button>
					<button
						type="button"
						class="preset-chip curse-violet"
						onclick={() => applyPreset("builtin-sfx-curse-violet")}
						title={$_("toolOptions.presetCurseVioletTitle")}
					>
						{$_("toolOptions.presetCurseViolet")}
					</button>
					<button
						type="button"
						class="preset-chip scream-crimson"
						onclick={() => applyPreset("builtin-sfx-scream-red")}
						title={$_("toolOptions.presetScreamTitle")}
					>
						{$_("toolOptions.presetScream")}
					</button>
					<button
						type="button"
						class="preset-chip romance-sparkle"
						onclick={() => applyPreset("builtin-romance-gold")}
						title={$_("toolOptions.presetRomanceTitle")}
					>
						{$_("toolOptions.presetRomance")}
					</button>
				</div>

				<div class="divider advanced-divider advanced-control"></div>

				<button
					type="button"
					onclick={() => editorStore.fitSelectedTextLayerToBox()}
					class="fit-text-btn advanced-control"
					title={$_("toolOptions.fitTextTitle")}
				>
					{$_("toolOptions.fitTextBox")}
				</button>
			{/if}
		</div>
	{/if}

	<!-- Context 5: Credits -->
	{#if isCreditContext}
		<div class="options-group credit-options">
			<span class="context-badge credit-badge">{$_("toolOptions.credit")}</span>

			<div class="divider"></div>

			<div class="credit-status-summary" aria-label={$_("toolOptions.creditSelectedAria")}>
				<strong>{isTextCreditContext ? $_("toolOptions.textCredit") : $_("toolOptions.imageCredit")}</strong>
				<small>{$_("toolOptions.selectedOnThisPage")}</small>
			</div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={openCreditTools}
					class="action-btn primary"
					title={isImageCreditContext ? $_("toolOptions.openImageCreditToolTitle") : $_("toolOptions.openTextCreditToolTitle")}
					aria-label={isImageCreditContext ? $_("toolOptions.openImageCreditToolTitle") : $_("toolOptions.openTextCreditToolTitle")}
				>
					{isImageCreditContext ? $_("toolOptions.setImageCredit") : $_("toolOptions.editTextCredit")}
				</button>

				{#if isTextCreditContext}
					<button
						type="button"
						onclick={applySelectedTextCreditAgain}
						class="action-btn"
						title={$_("toolOptions.reuseCreditTitle")}
						aria-label={$_("toolOptions.reuseCreditTitle")}
					>
						{$_("toolOptions.reuseText")}
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Context 4: Image Layer Options -->
	{#if isImageContext && selectedImageLayer}
		<div class="options-group image-options">
			<span class="context-badge image-badge">🖼️ {$_("toolOptions.overlayImageLayer")}</span>

			<div class="divider"></div>

			<div class="option-control slider-control image-opacity">
				<span class="label">{$_("toolOptions.transparencyLabel")}</span>
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					value={Math.round((selectedImageLayer.opacity ?? 1) * 100)}
					oninput={handleImageOpacityChange}
					aria-label={$_("toolOptions.overlayTransparencyAria")}
					style="height: 40px !important; min-height: 40px !important;"
				/>
				<span class="value-readout">{Math.round((selectedImageLayer.opacity ?? 1) * 100)}%</span>
			</div>

			<div class="divider"></div>

			<div class="option-control presets-dropdown">
				<span class="label">{$_("toolOptions.quickSizeLabel")}</span>
				<button type="button" class="preset-btn" onclick={() => applyTransformPreset("fit-page")}>{$_("toolOptions.fitPage")}</button>
				<button type="button" class="preset-btn" onclick={() => applyTransformPreset("fill-width")}>{$_("toolOptions.fillWidth")}</button>
				<button type="button" class="preset-btn" onclick={() => applyTransformPreset("reset-transform")}>{$_("toolOptions.resetReal")}</button>
			</div>

			<div class="divider"></div>

			<div class="option-control alignment-group">
				<span class="label">{$_("toolOptions.alignLabel")}</span>
				<button type="button" class="align-tool-btn" onclick={() => alignImage("left")} title={$_("toolOptions.alignLeftEdgeTitle")}>{$_("toolOptions.alignLeftShort")}</button>
				<button type="button" class="align-tool-btn" onclick={() => alignImage("center-x")} title={$_("toolOptions.alignCenterXTitle")}>{$_("toolOptions.alignCenterX")}</button>
				<button type="button" class="align-tool-btn" onclick={() => alignImage("right")} title={$_("toolOptions.alignRightEdgeTitle")}>{$_("toolOptions.alignRightShort")}</button>
				<button type="button" class="align-tool-btn" onclick={() => alignImage("center-y")} title={$_("toolOptions.alignCenterYTitle")}>{$_("toolOptions.alignCenterY")}</button>
			</div>
		</div>
	{/if}

	<!-- Context 6: AI Review -->
	{#if isAiReviewContext}
		<div class="options-group ai-review-options">
			<span class="context-badge ai-badge">✦ {$_("toolOptions.aiResultPending")}</span>

			<div class="divider"></div>

			<div class="ai-status-summary">
				<strong>{selectedImageLayer?.originalName || $_("toolOptions.drawBoxRunAi")}</strong>
				<small>{selectedImageLayer ? $_("toolOptions.layerOpacityValue", { values: { pct: Math.round((selectedImageLayer.opacity ?? 0.95) * 100) } }) : $_("toolOptions.dragToAnalyze")}</small>
			</div>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={() => editorUiStore.setRightPanelMode("ai")}
					class="action-btn primary"
					title={$_("toolOptions.openAiReviewTitle")}
				>
					{$_("toolOptions.openAiReview")}
				</button>
			</div>
		</div>
	{/if}

	<!-- Context 7: Page status -->
	{#if !layersPanelOwnsSelectedObjectContext && !workPanelOwnsSelectionContext && !isSelectContext && !isCropContext && !isBrushContext && !isTextToolContext && !isTextContext && !isImageContext && !isCreditContext && !isAiReviewContext && !isImageToolContext}
		<div class="options-group default-options">
			<span class="context-badge default-badge">{isSoloMode ? $_("toolOptions.thisPage") : $_("toolOptions.pageWork")}</span>

			<div class="divider"></div>

			<div class="qc-status-cluster">
				<span class="qc-stat-badge bg-red" title={$_("toolOptions.qcErrorTitle")}>
					{$_("toolOptions.qcErrorCount", { values: { count: projectStore.qcReport.errorCount } })}
				</span>
				<span class="qc-stat-badge bg-amber" title={$_("toolOptions.qcWarningTitle")}>
					{$_("toolOptions.qcWarningCount", { values: { count: projectStore.qcReport.warningCount } })}
				</span>
				<span class="qc-stat-badge bg-blue" title={$_("toolOptions.qcOpenNotesTitle")}>
					{$_("toolOptions.qcOpenNotesCount", { values: { count: projectStore.comments.filter(c => c.status !== "resolved").length } })}
				</span>
			</div>

			<div class="divider"></div>

			<div class="action-buttons">
				<button
					type="button"
					onclick={() => editorUiStore.setRightPanelMode(isSoloMode ? "layers" : "work")}
					class="action-btn"
					title={isSoloMode ? $_("toolOptions.openLayersSettingsTitle") : $_("toolOptions.openWorkBoardTitle")}
				>
					{isSoloMode ? $_("toolOptions.viewLayers") : $_("toolOptions.openWorkBoard")}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.tool-options-bar {
		display: flex;
		align-items: center;
		height: var(--editor-options-toolbar-h, 50px);
		min-height: var(--editor-options-toolbar-h, 50px);
		width: 100%;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(10, 14, 23, 0.94);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		padding: 0 16px;
		overflow-x: auto;
		scrollbar-width: none;
		z-index: 10;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
	}

	.tool-options-bar::-webkit-scrollbar {
		display: none;
	}

	.options-group {
		display: flex;
		align-items: center;
		gap: 12px;
		width: max-content;
		height: 100%;
	}

	.global-history-control {
		position: relative;
		flex: 0 0 auto;
	}

	.history-trigger {
		gap: 6px;
	}

	.history-panel-popover,
	.tool-color-popover {
		position: fixed;
		z-index: 1400;
	}

	.history-panel-popover {
		width: min(340px, calc(100vw - 24px));
	}

	.global-history-divider {
		margin: 0 2px;
	}

	.credit-options {
		gap: 8px;
	}

	.work-owner-options {
		gap: 10px;
	}

	.layer-owner-options {
		gap: 10px;
	}

	.context-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 10px;
		border-radius: 6px;
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.5px;
		white-space: nowrap;
	}

	.select-badge {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.crop-badge {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.crop-options {
		gap: 10px;
		min-width: 0;
	}

	.brush-badge {
		background: rgba(59, 130, 246, 0.12);
		border: 1px solid rgba(59, 130, 246, 0.25);
		color: #60a5fa;
	}

	.text-badge {
		background: rgba(168, 85, 247, 0.12);
		border: 1px solid rgba(168, 85, 247, 0.25);
		color: #c084fc;
	}

	.image-badge {
		background: rgba(236, 72, 153, 0.12);
		border: 1px solid rgba(236, 72, 153, 0.25);
		color: #f472b6;
	}

	.credit-badge {
		background: rgba(245, 158, 11, 0.12);
		border: 1px solid rgba(245, 158, 11, 0.25);
		color: #fbbf24;
	}

	.work-badge {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 28%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.layer-badge {
		background: rgba(129, 140, 248, 0.12);
		border: 1px solid rgba(165, 180, 252, 0.28);
		color: #c4b5fd;
	}

	.work-owner-summary {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		max-width: min(42vw, 460px);
		padding: 0 10px;
		border: 1px solid rgba(45, 212, 191, 0.2);
		border-radius: 6px;
		background: rgba(20, 184, 166, 0.08);
		color: rgba(251, 247, 255, 0.9);
		white-space: nowrap;
		flex-shrink: 1;
		min-width: 0;
	}

	.layer-owner-summary {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		max-width: min(46vw, 520px);
		padding: 0 10px;
		border: 1px solid rgba(165, 180, 252, 0.2);
		border-radius: 6px;
		background: rgba(99, 102, 241, 0.08);
		color: rgba(251, 247, 255, 0.9);
		white-space: nowrap;
		flex-shrink: 1;
		min-width: 0;
	}

	.layer-owner-summary strong,
	.layer-owner-summary small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-owner-summary strong {
		font-size: 11px;
		font-weight: 850;
		color: #ddd6fe;
		min-width: 0;
	}

	.layer-owner-summary small {
		font-size: 10px;
		font-weight: 750;
		color: rgba(251, 247, 255, 0.64);
		flex: 0 0 auto;
	}

	.work-owner-summary strong,
	.work-owner-summary small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-owner-summary strong {
		font-size: 11px;
		font-weight: 850;
		color: #99f6e4;
		flex: 0 0 auto;
	}

	.work-owner-summary small {
		font-size: 10px;
		font-weight: 750;
		color: rgba(251, 247, 255, 0.64);
		min-width: 0;
	}

	.credit-status-summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 40px;
		padding: 0 10px;
		border: 1px solid rgba(245, 158, 11, 0.18);
		border-radius: 6px;
		background: rgba(245, 158, 11, 0.07);
		color: rgba(251, 247, 255, 0.88);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.credit-status-summary strong {
		font-size: 11px;
		font-weight: 850;
		color: #fde68a;
	}

	.credit-status-summary small {
		font-size: 10px;
		font-weight: 750;
		color: rgba(251, 247, 255, 0.62);
	}

	.credit-status-summary small::before {
		content: "· ";
		color: rgba(251, 247, 255, 0.38);
	}

	.ai-badge {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.default-badge {
		background: rgba(148, 163, 184, 0.12);
		border: 1px solid rgba(148, 163, 184, 0.25);
		color: #cbd5e1;
	}

	/* W3.13 image-edit suite tool context */
	.image-tool-badge {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.image-tool-options {
		gap: 10px;
		min-width: 0;
	}

	.image-tool-summary {
		display: inline-flex;
		flex-direction: column;
		justify-content: center;
		height: 40px;
		max-width: min(48vw, 540px);
		min-width: 0;
	}

	.image-tool-summary strong {
		font-size: 11px;
		font-weight: 850;
		color: #99f6e4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.image-tool-summary small {
		font-size: 10px;
		font-weight: 700;
		color: rgba(251, 247, 255, 0.55);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.brush-shortcut-hint {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 10px;
		font-weight: 700;
		color: rgba(251, 247, 255, 0.45);
		white-space: nowrap;
	}

	.brush-shortcut-hint kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.08);
		color: rgba(251, 247, 255, 0.7);
		font-size: 9px;
		font-family: monospace;
	}

	.divider {
		width: 1px;
		height: 24px;
		background: rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
	}

	.option-control {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: rgba(251, 247, 255, 0.7);
		font-weight: 600;
	}

	.option-buttons,
	.quick-add-group,
	.action-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.option-btn,
	.add-btn,
	.action-btn,
	.preset-btn,
	.align-tool-btn,
	.fit-text-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 40px;
		padding: 0 12px;
		min-width: 40px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(251, 247, 255, 0.85);
		font-size: 11px;
		font-weight: 750;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.option-btn:hover:not(:disabled),
	.add-btn:hover,
	.action-btn:hover:not(:disabled),
	.preset-btn:hover,
	.align-tool-btn:hover,
	.fit-text-btn:hover {
		background: rgba(255, 255, 255, 0.09);
		border-color: rgba(255, 255, 255, 0.2);
		color: #fbf7ff;
	}

	.option-btn:disabled,
	.action-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.text-add {
		background: linear-gradient(180deg, rgba(168, 85, 247, 0.2), rgba(168, 85, 247, 0.1));
		border-color: rgba(168, 85, 247, 0.35);
		color: #d8b4fe;
	}

	.text-add:hover {
		background: linear-gradient(180deg, rgba(168, 85, 247, 0.3), rgba(168, 85, 247, 0.15));
		border-color: rgba(168, 85, 247, 0.6);
		color: #f3e8ff;
	}

	/* Sliders styling */
	.slider-control {
		gap: 8px;
	}

	.slider-control input[type="range"] {
		width: 110px;
		height: 40px;
		min-height: 40px;
		background: transparent;
		cursor: pointer;
		-webkit-appearance: none;
	}

	.slider-control input[type="range"]::-webkit-slider-runnable-track {
		width: 100%;
		height: 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.1);
	}

	.slider-control input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #ffffff;
		margin-top: -3px;
		transition: transform 0.1s ease;
	}

	.value-readout {
		display: inline-block;
		min-width: 40px;
		text-align: right;
		color: #3b82f6;
		font-weight: 800;
	}

	.brush-options .value-readout {
		color: #60a5fa;
	}

	/* Toggle controls */
	.toggle-control {
		gap: 4px;
	}

	.mode-toggle-btn {
		height: 40px;
		padding: 0 12px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.02);
		color: rgba(251, 247, 255, 0.6);
		font-size: 11px;
		font-weight: 750;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.mode-toggle-btn.active {
		border-color: rgba(59, 130, 246, 0.5);
		background: rgba(59, 130, 246, 0.15);
		color: #60a5fa;
		box-shadow: 0 2px 6px rgba(59, 130, 246, 0.1);
	}

	.hud-toggle-btn.active {
		border-color: rgba(34, 197, 94, 0.5);
		background: rgba(34, 197, 94, 0.15);
		color: #4ade80;
		box-shadow: 0 2px 6px rgba(34, 197, 94, 0.2);
	}

	.disabled-receipt {
		font-size: 10px;
		color: rgba(251, 247, 255, 0.3);
		padding: 0 8px;
		font-style: italic;
	}

	/* Target state indicators */
	.target-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 140px;
	}

	.brush-target-blocker {
		display: grid;
		gap: 3px;
		min-height: 40px;
		max-width: 360px;
		padding: 6px 12px;
		border: 1px solid rgba(251, 191, 36, 0.22);
		border-radius: 6px;
		background: rgba(251, 191, 36, 0.08);
		color: rgba(255, 251, 235, 0.88);
	}

	.brush-target-blocker strong {
		font-size: 11px;
		line-height: 1.15;
	}

	.brush-target-blocker span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		line-height: 1.15;
		color: rgba(255, 251, 235, 0.62);
	}

	.brush-options.brush-blocked .target-summary {
		max-width: 180px;
	}

	.target-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.2);
	}

	.target-dot.ready {
		background: #10b981;
		box-shadow: 0 0 6px rgba(16, 185, 129, 0.5);
	}

	.target-name {
		font-size: 10px;
		color: rgba(251, 247, 255, 0.5);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 700;
	}

	/* Text specific styles */
	.align-btn {
		width: 40px;
		height: 40px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.02);
		color: rgba(251, 247, 255, 0.6);
		font-size: 14px;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.align-btn:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.align-btn.active {
		border-color: rgba(168, 85, 247, 0.5);
		background: rgba(168, 85, 247, 0.15);
		color: #c084fc;
	}

	.color-controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.tool-color-trigger {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 40px;
		min-width: 112px;
		padding: 0 10px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(251, 247, 255, 0.85);
		font: inherit;
		font-size: 11px;
		font-weight: 750;
		cursor: pointer;
		white-space: nowrap;
	}

	.tool-color-trigger:hover,
	.tool-color-trigger:focus-visible {
		border-color: rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.09);
		color: #fbf7ff;
		outline: none;
	}

	.tool-color-swatch {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		border: 1px solid rgba(255, 255, 255, 0.42);
		border-radius: 5px;
		box-shadow: inset 0 0 0 1px rgba(2, 6, 23, 0.3);
	}

	.tool-color-trigger strong {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
		font-size: 10px;
		letter-spacing: 0;
		color: rgba(251, 247, 255, 0.62);
	}

	.color-picker-wrap {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.color-label {
		font-size: 10px;
		color: rgba(251, 247, 255, 0.55);
	}

	.color-picker-wrap input[type="color"] {
		width: 42px;
		height: 42px;
		min-width: 42px;
		min-height: 42px;
		flex-shrink: 0;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		background: transparent;
		cursor: pointer;
		padding: 0;
		box-sizing: border-box;
	}

	.thai-typeset-presets {
		gap: 5px;
	}

	.typeset-preset-btn {
		display: inline-grid;
		align-content: center;
		justify-items: center;
		gap: 1px;
		min-width: 68px;
		height: 40px;
		padding: 0 8px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.045);
		color: rgba(251, 247, 255, 0.88);
		cursor: pointer;
		transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
	}

	.typeset-preset-btn:hover,
	.typeset-preset-btn:focus-visible {
		transform: translateY(-1px);
		border-color: rgba(255, 255, 255, 0.28);
		background: rgba(255, 255, 255, 0.09);
		outline: none;
	}

	.typeset-preset-code,
	.typeset-preset-name {
		display: block;
		white-space: nowrap;
		letter-spacing: 0;
	}

	.typeset-preset-code {
		font-size: 11px;
		font-weight: 900;
		line-height: 1.05;
	}

	.typeset-preset-name {
		font-size: 9px;
		font-weight: 700;
		line-height: 1.1;
		color: rgba(251, 247, 255, 0.68);
	}

	.typeset-preset-btn.speech {
		border-color: rgba(226, 232, 240, 0.22);
		background: rgba(226, 232, 240, 0.08);
		color: #f8fafc;
	}

	.typeset-preset-btn.shout {
		border-color: rgba(251, 146, 60, 0.38);
		background: rgba(127, 29, 29, 0.24);
		color: #fed7aa;
	}

	.typeset-preset-btn.thought {
		border-color: rgba(147, 197, 253, 0.3);
		background: rgba(30, 41, 59, 0.42);
		color: #dbeafe;
	}

	.typeset-preset-btn.narration {
		border-color: rgba(250, 204, 21, 0.32);
		background: rgba(63, 48, 20, 0.34);
		color: #fef3c7;
	}

	.typeset-preset-btn.sfx {
		border-color: rgba(248, 113, 113, 0.5);
		background: rgba(69, 10, 10, 0.42);
		color: #fecaca;
	}

	/* Preset quick chips */
	.preset-quick-chips {
		gap: 5px;
	}

	.chip-label {
		font-size: 10px;
		font-weight: 700;
		color: rgba(251, 247, 255, 0.5);
		margin-right: 2px;
	}

	.preset-chip {
		font-size: 10px;
		height: 40px;
		padding: 0 10px;
		border-radius: 4px;
		font-weight: 800;
		border: 1px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
		min-width: 50px;
	}

	.preset-chip:hover {
		transform: scale(1.04);
	}

	.stroke-readable {
		background: rgba(255, 255, 255, 0.06);
		border-color: rgba(255, 255, 255, 0.15);
		color: #f8fafc;
	}

	.sfx-red {
		background: rgba(254, 226, 226, 0.95);
		border-color: #f87171;
		color: #991b1b;
	}

	.dungeon-blue {
		background: #0f172a;
		border-color: #22d3ee;
		color: #e0f7ff;
		box-shadow: 0 0 4px rgba(34, 211, 238, 0.3);
	}

	.curse-violet {
		background: #2e1065;
		border-color: #a855f7;
		color: #f5d0fe;
	}

	.scream-crimson {
		background: rgba(255, 241, 242, 0.95);
		border-color: #ef4444;
		color: #450a0a;
	}

	.romance-sparkle {
		background: #fff7ed;
		border-color: #facc15;
		color: #7c2d12;
		box-shadow: 0 0 4px rgba(250, 204, 21, 0.2);
	}

	.fit-text-btn {
		background: rgba(168, 85, 247, 0.15);
		border-color: rgba(168, 85, 247, 0.3);
		color: #d8b4fe;
		height: 40px;
		padding: 0 12px;
	}

	.fit-text-btn:hover {
		background: rgba(168, 85, 247, 0.25);
		border-color: rgba(168, 85, 247, 0.5);
	}

	.action-btn.primary {
		background: linear-gradient(180deg, #fbbf24, #d97706);
		border-color: rgba(245, 158, 11, 0.4);
		color: #0f172a;
	}

	.action-btn.primary:hover {
		background: linear-gradient(180deg, #fcd34d, #b45309);
		border-color: rgba(245, 158, 11, 0.6);
		color: #0f172a;
	}

	/* AI specific styles */
	.ai-status-summary {
		display: flex;
		flex-direction: column;
		min-width: 100px;
	}

	.ai-status-summary strong {
		font-size: 11px;
		color: var(--color-ws-accent, #7c5cff);
		font-weight: 800;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-status-summary small {
		font-size: 9px;
		color: rgba(251, 247, 255, 0.5);
	}

	/* QC styles */
	.qc-status-cluster {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.qc-stat-badge {
		font-size: 10px;
		font-weight: 800;
		padding: 4px 8px;
		border-radius: 4px;
		white-space: nowrap;
	}

	.bg-red {
		background: rgba(239, 68, 68, 0.15);
		border: 1px solid rgba(239, 68, 68, 0.25);
		color: #f87171;
	}

	.bg-amber {
		background: rgba(245, 158, 11, 0.15);
		border: 1px solid rgba(245, 158, 11, 0.25);
		color: #fbbf24;
	}

	.bg-blue {
		background: rgba(59, 130, 246, 0.15);
		border: 1px solid rgba(59, 130, 246, 0.25);
		color: #60a5fa;
	}

	/* Advanced responsive styling */
	.advanced-toggle-btn {
		height: 40px;
		padding: 0 12px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(251, 247, 255, 0.85);
		font-size: 11px;
		font-weight: 750;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		transition: all 0.2s ease;
	}

	.advanced-toggle-btn:hover {
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(255, 255, 255, 0.2);
		color: #ffffff;
	}

	.advanced-toggle-btn.active {
		border-color: rgba(168, 85, 247, 0.5);
		background: rgba(168, 85, 247, 0.15);
		color: #c084fc;
	}

	.advanced-control {
		animation: fadeInSlideRight 0.2s ease forwards;
	}

	.advanced-divider {
		border-left: 1px dashed rgba(168, 85, 247, 0.25);
	}

	@keyframes fadeInSlideRight {
		from {
			opacity: 0;
			transform: translateX(-6px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	/* Responsive Brush options collapsing */
	.brush-advanced-toggle {
		display: none;
	}

	.advanced-brush-toggle {
		height: 40px;
		padding: 0 12px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(251, 247, 255, 0.85);
		font-size: 11px;
		font-weight: 750;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		transition: all 0.2s ease;
	}

	.advanced-brush-toggle:hover {
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(255, 255, 255, 0.2);
		color: #ffffff;
	}

	.advanced-brush-toggle.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 15%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	@media (max-width: 1100px) {
		.image-options .alignment-group {
			display: none;
		}

		.brush-advanced-toggle {
			display: inline-flex !important;
		}

		.advanced-brush-control {
			display: none !important;
		}

		.advanced-brush-control.show-mobile {
			display: inline-flex !important;
		}

	}

	@media (max-width: 480px) {
		.tool-options-bar {
			height: auto;
			min-height: var(--editor-options-toolbar-h, 50px);
			align-items: stretch;
			padding: 6px 8px;
		}

		.options-group.layer-owner-options {
			display: grid;
			width: min(100%, calc(100vw - 16px));
			min-width: 0;
			height: auto;
			grid-template-columns: auto minmax(108px, max-content);
			grid-template-areas:
				"badge action"
				"summary summary";
			align-items: center;
			gap: 6px 8px;
		}

		.layer-owner-options .context-badge {
			grid-area: badge;
			max-width: 46vw;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.layer-owner-options .divider {
			display: none;
		}

		.layer-owner-options .layer-owner-summary {
			grid-area: summary;
			width: 100%;
			max-width: none;
			height: auto;
			min-height: 40px;
			align-items: flex-start;
			justify-content: center;
			white-space: normal;
		}

		.layer-owner-options .layer-owner-summary strong,
		.layer-owner-options .layer-owner-summary small {
			white-space: normal;
			overflow-wrap: anywhere;
		}

		.layer-owner-options .action-buttons {
			grid-area: action;
			justify-content: flex-end;
			min-width: 0;
		}

		.layer-owner-options .action-btn {
			min-height: 40px;
			height: auto;
			max-width: 132px;
			padding: 6px 10px;
			line-height: 1.15;
			white-space: normal;
		}
	}
</style>
