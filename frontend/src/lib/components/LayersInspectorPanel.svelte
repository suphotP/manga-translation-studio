<script lang="ts">
	import { tick } from "svelte";
	// Import `_` from $lib/i18n (NOT "svelte-i18n"): the wrapper does addMessages +
	// init on import, registering the locale dictionaries for this component AND for
	// isolated/transitive test renders. Without it, isolated component tests render blank.
	import { _ } from "$lib/i18n";
	import { thumbnailUrl, type ProjectImageAssetSummary, type StorageQuotaSummary } from "$lib/api/client.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import {
		isAiResultImageLayer,
		type AiReviewMarker,
		type CreditApplyScope,
		type CreditPreset,
		type ImageEditLayer,
		type ImageLayer,
		type ImageLayerAlignment,
		type ImageLayerBlendMode,
		type ImageLayerBulkAction,
		type ImageLayerTransformPreset,
		type TextLayer,
		type TextStylePreset,
	} from "$lib/types.js";
	import {
		layerCategoryCode,
		formatLayerConfidence,
		formatLayerProvider,
	} from "$lib/panels/right-panel-model.js";
	import { isAiResultPlacementOrRecoveryNeeded } from "$lib/project/ai-review-marker-intent.js";
	import { estimateTextLayerFit } from "$lib/project/text-layout-qc.js";
	import { trackTextLayers } from "$lib/project/language-tracks.js";
	import EffectsPanel from "./EffectsPanel.svelte";
	import FontPicker from "./FontPicker.svelte";
	import FontSizePicker from "./FontSizePicker.svelte";
	import LayerDeleteDialog from "./inspector/LayerDeleteDialog.svelte";
	import EffectsHost from "./inspector/EffectsHost.svelte";
	import BulkLayerActions from "./inspector/BulkLayerActions.svelte";
	import LayerStack from "./inspector/LayerStack.svelte";
	import AssetBrowser from "./inspector/AssetBrowser.svelte";
	import TextQaField from "./TextQaField.svelte";

	type ImageAssetViewMode = "list" | "grid";
	type AssetSizeBand = "all" | "lt500k" | "500kto2m" | "gt2m";
	type AssetSourceFilter = "all" | "uploaded" | "ai";
	type ImageLayerEditableUpdate = Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "role" | "blendMode">>;
	type ImageLayerRoleFilter = "all" | NonNullable<ImageLayer["role"]>;
	type NormalizedImageLayerRole = NonNullable<ImageLayer["role"]>;
	type NormalizedImageLayerBlendMode = NonNullable<ImageLayer["blendMode"]>;
	type LayerClipboardKind = "text" | "image" | null;
	type UnifiedLayerStackFilter = "all" | "credit" | "text" | "image";
	type CreditDeleteKind = "all" | "text" | "image";
	type CreditDeleteMatch = {
		text?: string;
		imageId?: string;
	};
	type CreditDeleteScopeKey =
		| "selected"
		| "matching-text-all"
		| "matching-image-all"
		| "current-all"
		| "current-text"
		| "current-image"
		| "chapter-all"
		| "chapter-text"
		| "chapter-image";
	type CreditDeleteOption = {
		value: CreditDeleteScopeKey;
		label: string;
		detail: string;
		title: string;
		confirmDetail: string;
		selectedOnly?: boolean;
		allPages: boolean;
		creditKind: CreditDeleteKind;
		match?: CreditDeleteMatch;
	};
	type UnifiedLayerStackItem = {
		stackKey: string;
		id: string;
		kind: "text" | "image";
		title: string;
		meta: string;
		badge: string;
		isCredit: boolean;
		visible: boolean;
		locked: boolean;
		active: boolean;
		index: number;
		groupSize: number;
		stackIndex: number;
		stackSize: number;
	};
	type PendingDeleteAction =
		| { kind: "text"; id: string; title: string; detail: string }
		| { kind: "image"; id: string; title: string; detail: string }
		| {
			kind: "credits";
			title: string;
			detail: string;
			allPages: boolean;
			creditKind: CreditDeleteKind;
			match?: CreditDeleteMatch;
		};

	const ASSET_BROWSER_COMPACT_LIMIT = 6;

	interface Labels {
		properties: string;
		text: string;
		fontSize: string;
		alignment: string;
		alignmentLeft: string;
		alignmentCenter: string;
		alignmentRight: string;
		canvas: string;
		aspectRatio: string;
	}

	interface CanvasDimensions {
		width: number;
		height: number;
	}

	interface Props {
		labels: Labels;
		projectOpen: boolean;
		projectId: string | null;
		hasImage: boolean;
		textLayers: TextLayer[];
		imageLayers: ImageLayer[];
		imageAssets: ProjectImageAssetSummary[];
		imageAssetsLoading: boolean;
		imageAssetStorageQuota: StorageQuotaSummary | null;
		deletingImageAssetId: string | null;
		canDeleteImageAssets: boolean;
		onDeleteImageAsset: (
			asset: ProjectImageAssetSummary,
			force: boolean,
		) => Promise<{ ok: true; freedBytes: number } | { referencedByPages: number[] } | { error: string }>;
		selectedLayer: TextLayer | null;
		selectedImageLayer: ImageLayer | null;
		textStylePresets: TextStylePreset[];
		creditPresets: CreditPreset[];
		selectedPresetId: string;
		presetName: string;
		textEffectPrompt: string;
		textEffectSuggestions: TextStylePreset[];
		selectedCreditPresetId: string;
		selectedImageAssetId: string;
		creditText: string;
		creditOffset: number;
		creditPresetName: string;
		creditImageMaxWidth: number;
		creditImageRepeatEveryPx: number;
		creditApplyScope: CreditApplyScope;
		defaultFontFamily: string;
		defaultFontSize: number;
		defaultTextFill: string;
		defaultTextStroke: string;
		canvasDimensions: CanvasDimensions;
		aspectRatios: Record<string, unknown>;
		selectedAspectRatio: string;
		focusLayerId: string | null;
		focusToken: number;
		imageFocusLayerId: string | null;
		imageFocusToken: number;
		layerClipboardKind: LayerClipboardKind;
		onCreditPresetChange: (value: string) => void;
		onCreditTextChange: (value: string) => void;
		onCreditOffsetChange: (value: number) => void;
		onCreditPresetNameChange: (value: string) => void;
		onAddCredit: () => void;
		onAddCreditImage: () => void;
		onDeleteCreditLayers: (allPages: boolean, kind?: CreditDeleteKind, match?: CreditDeleteMatch) => void;
		onSaveCreditPreset: () => void | Promise<void>;
		onCreditImageMaxWidthChange: (value: number) => void;
		onCreditImageRepeatEveryPxChange: (value: number) => void;
		onCreditApplyScopeChange: (value: CreditApplyScope) => void;
		onStartTextPlacement: () => void;
		onAddImageLayer: () => void;
		onStartSelectedImageBrush: () => void;
		onImageAssetSelectionChange: (assetId: string) => void;
		onAddSelectedImageAssetLayer: () => void | Promise<void>;
		onReplaceSelectedImageLayerFromAsset: () => void | Promise<void>;
		onSelectLayer: (layerId: string) => void;
		onToggleLayerVisibility: (layerId: string) => void;
		onToggleLayerLock: (layerId: string) => void;
		onCopySelectedLayer: () => void;
		onPasteLayerClipboard: () => void | Promise<void>;
		onDuplicateLayer: (layerId: string) => void;
		onMoveLayer: (layerId: string, direction: -1 | 1) => void;
		onMoveUnifiedLayer: (kind: "text" | "image", layerId: string, direction: -1 | 1) => void;
		onReorderUnifiedLayer: (kind: "text" | "image", layerId: string, offset: number) => void;
		onDeleteLayer: (layerId: string) => void;
		onSelectImageLayer: (layerId: string) => void;
		onToggleImageLayerVisibility: (layerId: string) => void;
		onToggleImageLayerLock: (layerId: string) => void;
		onDuplicateImageLayer: (layerId: string) => void | Promise<void>;
		onMoveImageLayer: (layerId: string, direction: -1 | 1) => void;
		onDeleteImageLayer: (layerId: string) => void;
		onApplyImageLayerBulkAction: (action: ImageLayerBulkAction, layerIds?: string[]) => void;
		onAlignSelectedImageLayer: (alignment: ImageLayerAlignment) => void;
		onApplySelectedImageLayerTransformPreset: (preset: ImageLayerTransformPreset) => void;
		onSelectedImageLayerChange: (updates: ImageLayerEditableUpdate, commit?: boolean) => void;
		onSelectedTextLayerNameChange: (value: string) => void;
		onSelectedTextChange: (value: string) => void;
		onSelectedTextBoxChange: (updates: Partial<Pick<TextLayer, "w" | "h">>) => void;
		onTextOpacityChange: (value: number) => void;
		onSelectedPresetChange: (value: string) => void;
		onPresetNameChange: (value: string) => void;
		onTextEffectPromptChange: (value: string) => void;
		onSuggestedPresetApply: (presetId: string) => void;
		onSaveCurrentPreset: () => void | Promise<void>;
		onFontChange: (value: string) => void;
		onFontSizeChange: (value: number) => void;
		onFitSelectedText: () => void;
		onFillChange: (value: string) => void;
		onStrokeChange: (value: string) => void;
		onStrokeWidthChange: (value: number) => void;
		onCharSpacingChange: (value: number) => void;
		onAlignmentChange: (value: TextLayer["alignment"]) => void;
		onAspectRatioChange: (value: string) => void;
	}

	let {
		labels,
		projectOpen,
		projectId,
		hasImage,
		textLayers,
		imageLayers,
		imageAssets,
		imageAssetsLoading,
		imageAssetStorageQuota,
		deletingImageAssetId,
		canDeleteImageAssets,
		onDeleteImageAsset,
		selectedLayer,
		selectedImageLayer,
		textStylePresets,
		creditPresets,
		selectedPresetId,
		presetName,
		textEffectPrompt,
		textEffectSuggestions,
		selectedCreditPresetId,
		selectedImageAssetId,
		creditText,
		creditOffset,
		creditPresetName,
		creditImageMaxWidth,
		creditImageRepeatEveryPx,
		creditApplyScope,
		defaultFontFamily,
		defaultFontSize,
		defaultTextFill,
		defaultTextStroke,
		canvasDimensions,
		aspectRatios,
		selectedAspectRatio,
		focusLayerId,
		focusToken,
		imageFocusLayerId,
		imageFocusToken,
		layerClipboardKind,
		onCreditPresetChange,
		onCreditTextChange,
		onCreditOffsetChange,
		onCreditPresetNameChange,
		onAddCredit,
		onAddCreditImage,
		onDeleteCreditLayers,
		onSaveCreditPreset,
		onCreditImageMaxWidthChange,
		onCreditImageRepeatEveryPxChange,
		onCreditApplyScopeChange,
		onStartTextPlacement,
		onAddImageLayer,
		onStartSelectedImageBrush,
		onImageAssetSelectionChange,
		onAddSelectedImageAssetLayer,
		onReplaceSelectedImageLayerFromAsset,
		onSelectLayer,
		onToggleLayerVisibility,
		onToggleLayerLock,
		onCopySelectedLayer,
		onPasteLayerClipboard,
		onDuplicateLayer,
		onMoveLayer,
		onMoveUnifiedLayer,
		onReorderUnifiedLayer,
		onDeleteLayer,
		onSelectImageLayer,
		onToggleImageLayerVisibility,
		onToggleImageLayerLock,
		onDuplicateImageLayer,
		onMoveImageLayer,
		onDeleteImageLayer,
		onApplyImageLayerBulkAction,
		onAlignSelectedImageLayer,
		onApplySelectedImageLayerTransformPreset,
		onSelectedImageLayerChange,
		onSelectedTextLayerNameChange,
		onSelectedTextChange,
		onSelectedTextBoxChange,
		onTextOpacityChange,
		onSelectedPresetChange,
		onPresetNameChange,
		onTextEffectPromptChange,
		onSuggestedPresetApply,
		onSaveCurrentPreset,
		onFontChange,
		onFontSizeChange,
		onFitSelectedText,
		onFillChange,
		onStrokeChange,
		onStrokeWidthChange,
		onCharSpacingChange,
		onAlignmentChange,
		onAspectRatioChange,
	}: Props = $props();

	let creditsOpen = $state(false);
	let selectedCreditAdminOpen = $state(false);
	let imageLayersOpenOverride = $state<boolean | null>(null);
	let layersOpenOverride = $state<boolean | null>(null);
	let propsOpenOverride = $state<boolean | null>(null);
	let assetLibraryOpenOverride = $state<boolean | null>(null);
	let selectedImageAdvancedOpenOverride = $state<boolean | null>(null);
	let lastCreditToolsFocusToken = $state(0);
	let hasSelectedLayer = $derived(Boolean(selectedLayer || selectedImageLayer));
	let selectedImageLayerIsAiResult = $derived(isAiResultImageLayer(selectedImageLayer));
	// Declared early because several derived values below reference these.
	// `$derived` forms a reactive graph (order-independent at runtime), but the
	// type checker flags use-before-declaration, so they are hoisted here.
	let activeAiPlacementMarker = $derived(
		projectStore.currentPageAiReviewMarkers.find((marker) => (
			marker.id === projectStore.selectedAiReviewMarkerId
			&& isAiResultPlacementOrRecoveryNeeded(projectStore.project, marker)
		)) ?? null
	);
	let selectedCreditLayer = $derived(selectedLayer?.sourceCategory === "credit" ? selectedLayer : null);
	let selectedCreditImageLayer = $derived(selectedImageLayer?.role === "credit" ? selectedImageLayer : null);
	let selectedEditableLayerActive = $derived(Boolean((selectedLayer || selectedImageLayer) && !activeAiPlacementMarker));
	let selectedImageLayerCanUseCleanBrush = $derived(Boolean(
		selectedImageLayer
		&& (selectedImageLayerIsAiResult || selectedImageLayer.role !== "credit")
		&& selectedImageLayer.visible !== false
		&& selectedImageLayer.locked !== true,
	));
	let canCreateCreditText = $derived(Boolean(creditText.trim()));
	let canSaveCreditPreset = $derived(Boolean(projectOpen && creditPresetName.trim() && creditText.trim()));
	let creditPresetSaveHint = $derived(
		!projectOpen
			? $_("layersInspector.hintOpenProjectCreditPreset")
			: !creditText.trim()
				? $_("layersInspector.hintWriteCredit")
				: $_("layersInspector.hintNameCreditPreset")
	);
	let canSaveTextStylePreset = $derived(Boolean(projectOpen && presetName.trim()));
	let textStylePresetSaveHint = $derived(
		!projectOpen
			? $_("layersInspector.hintOpenProjectStylePreset")
			: $_("layersInspector.hintNameStylePreset")
	);
	let selectedImageCleanBrushActive = $derived(Boolean(
		selectedImageLayer
		&& editorStore.currentTool === "brush"
		&& editorStore.brushTarget.kind === "image-layer"
		&& editorStore.brushTarget.canBrush
		&& editorStore.selectedImageLayer?.id === selectedImageLayer.id,
	));
	let selectedImageBrushReceipt = $derived(
		editorStore.imageLayerBrushReceiptMatches(selectedImageLayer?.id)
			? editorStore.lastImageLayerBrushCommit
			: null
	);
	// editor.svelte.ts emits a stable titleCode for fixed labels; null means
	// `title` is a dynamic layer/display name shown verbatim.
	let brushTargetTitle = $derived(
		editorStore.brushTarget.titleCode
			? $_(`brushTarget.title.${editorStore.brushTarget.titleCode}`)
			: editorStore.brushTarget.title,
	);
	let selectedImageBrushRestoreStatus = $derived(
		selectedImageBrushReceipt && editorStore.brushTarget.canRestore
			? selectedImageBrushReceipt.mode === "restore"
				? $_("layersInspector.brushRestoreStrokeRestored")
				: $_("layersInspector.brushRestoreCleaned")
			: editorStore.brushTarget.canRestore
				? $_("layersInspector.brushRestoreReady")
			: $_("layersInspector.brushRestoreAfterStroke")
	);
	let selectedImageBrushScopeCopy = $derived(
		selectedImageBrushReceipt && editorStore.brushTarget.canRestore
			? selectedImageBrushReceipt.mode === "restore"
				? $_("layersInspector.brushScopeRestored")
				: $_("layersInspector.brushScopeHasStrokes")
			: $_("layersInspector.brushScopeLayerOnly")
	);
	let selectedImageLayerLibraryFocusActive = $derived(Boolean(
		selectedImageLayer
		&& editorUiStore.workspaceEditorEntry
		&& editorUiStore.workspaceEditorEntry.projectId === projectStore.project?.projectId
		&& !selectedImageLayerIsAiResult
	));
	let imageLayersOpen = $derived(imageLayersOpenOverride ?? (!hasSelectedLayer && imageLayers.length > 0));

	// ── Phase C — non-destructive "Edits" stack (bubble-clean / brush / heal / clone) ──
	// Read live from the editor store (mirrored from the editor host on commit/undo/
	// toggle/delete/revert + on page load). Rows render in stack paint order.
	let editLayers = $derived(
		[...editorStore.imageEditLayers].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
	);
	let editLayersOpenOverride = $state<boolean | null>(null);
	let editLayersOpen = $derived(editLayersOpenOverride ?? editLayers.length > 0);
	let renamingEditLayerId = $state<string | null>(null);
	let renamingEditLayerDraft = $state("");
	let pendingRevertEditLayerId = $state<string | null>(null);

	// $derived so the labels re-resolve when the user switches locale live (a static
	// const would freeze the translations captured at component init).
	const EDIT_KIND_LABELS: Record<string, string> = $derived({
		"bubble-clean": $_("layersInspector.editKindBubbleClean"),
		"fill-mask": $_("layersInspector.editKindFillMask"),
		patch: $_("layersInspector.editKindPatch"),
		healing: $_("layersInspector.editKindHealing"),
		clone: $_("layersInspector.editKindClone"),
		"flatten-cache": $_("layersInspector.editKindFlattenCache"),
	});

	function editLayerKindLabel(layer: ImageEditLayer): string {
		const toolId = layer.tool?.id;
		if (toolId === "bubble-clean") return $_("layersInspector.editKindBubbleClean");
		if (toolId === "brush") return $_("layersInspector.editKindPatch");
		if (toolId === "healing-brush") return $_("layersInspector.editKindHealing");
		if (toolId === "clone-stamp") return $_("layersInspector.editKindClone");
		return EDIT_KIND_LABELS[layer.payload?.type ?? layer.kind] ?? layer.kind;
	}

	function editLayerDisplayName(layer: ImageEditLayer, index: number): string {
		if (layer.name && layer.name.trim()) return layer.name.trim();
		return `${editLayerKindLabel(layer)} #${index + 1}`;
	}

	function editLayerListMeta(layer: ImageEditLayer): string {
		const b = layer.bbox;
		const dims = b ? `${Math.round(b.w)}×${Math.round(b.h)} @ ${Math.round(b.x)},${Math.round(b.y)}` : "";
		return dims;
	}

	function toggleEditLayerVisibility(layer: ImageEditLayer): void {
		editorStore.toggleImageEditLayerVisibility(layer.id);
	}

	function startRenameEditLayer(layer: ImageEditLayer, index: number): void {
		renamingEditLayerId = layer.id;
		renamingEditLayerDraft = layer.name?.trim() || editLayerDisplayName(layer, index);
	}

	function commitRenameEditLayer(): void {
		if (renamingEditLayerId) editorStore.renameImageEditLayer(renamingEditLayerId, renamingEditLayerDraft);
		renamingEditLayerId = null;
		renamingEditLayerDraft = "";
	}

	function cancelRenameEditLayer(): void {
		renamingEditLayerId = null;
		renamingEditLayerDraft = "";
	}

	function deleteEditLayer(layer: ImageEditLayer): void {
		editorStore.deleteImageEditLayer(layer.id);
	}

	function requestRevertEditLayer(layer: ImageEditLayer): void {
		pendingRevertEditLayerId = layer.id;
	}

	function confirmRevertEditLayer(): void {
		if (pendingRevertEditLayerId) editorStore.revertToBeforeImageEditLayer(pendingRevertEditLayerId);
		pendingRevertEditLayerId = null;
	}

	function cancelRevertEditLayer(): void {
		pendingRevertEditLayerId = null;
	}

	function editLayersStackedAfter(layer: ImageEditLayer): number {
		const targetIndex = layer.index ?? 0;
		return editLayers.filter((l) => (l.index ?? 0) > targetIndex).length;
	}
	let layersOpen = $derived(layersOpenOverride ?? (!hasSelectedLayer && textLayers.length > 0));
	let propsOpen = $derived(activeAiPlacementMarker ? true : (propsOpenOverride ?? true));
	let effectsOpen = $state(false);
	let selectedTextDetailsOpen = $state(false);
	let selectedTextPresetSaveOpen = $state(false);
	let selectedTextBoxToolsOpen = $state(false);
	let selectedTextStyleToolsOpen = $state(false);
	let unifiedStackOpen = $state<boolean | null>(null);
	let layerShortcutsExpanded = $state(false);
	let lastSelectedFocusScrollKey = $state("");
	let imageAssetQuery = $state("");
	let imageAssetSizeBand = $state<AssetSizeBand>("all");
	let imageAssetSourceFilter = $state<AssetSourceFilter>("all");
	let imageAssetView = $state<ImageAssetViewMode>("list");
	let imageAssetBrowserExpanded = $state(false);
	let imageAssetThumbnailFailures = $state<Record<string, boolean>>({});
	let imageAssetPreviewFailures = $state<Record<string, boolean>>({});
	let imageLayerRoleFilter = $state<ImageLayerRoleFilter>("all");
	let unifiedLayerStackFilter = $state<UnifiedLayerStackFilter>("all");
	let creditDeleteScope = $state<CreditDeleteScopeKey>("selected");
	let draggedLayer = $state<{ kind: "text" | "image"; id: string; index: number } | null>(null);
	let pendingDeleteAction = $state<PendingDeleteAction | null>(null);
	function assetMatchesSizeBand(asset: ProjectImageAssetSummary, band: AssetSizeBand): boolean {
		const bytes = asset.sizeBytes;
		if (band === "lt500k") return bytes < 500 * 1024;
		if (band === "500kto2m") return bytes >= 500 * 1024 && bytes <= 2 * 1024 * 1024;
		if (band === "gt2m") return bytes > 2 * 1024 * 1024;
		return true;
	}
	function assetMatchesSource(asset: ProjectImageAssetSummary, source: AssetSourceFilter): boolean {
		if (source === "all") return true;
		const isAi = asset.uploadedBy?.source === "ai_job";
		return source === "ai" ? isAi : !isAi;
	}
	let filteredImageAssets = $derived.by(() => {
		const query = imageAssetQuery.trim().toLowerCase();
		return imageAssets.filter((asset) => {
			if (!assetMatchesSizeBand(asset, imageAssetSizeBand)) return false;
			if (!assetMatchesSource(asset, imageAssetSourceFilter)) return false;
			if (!query) return true;
			return (
				asset.originalName.toLowerCase().includes(query)
				|| asset.imageId.toLowerCase().includes(query)
				|| asset.mimeType.toLowerCase().includes(query)
				|| `${asset.width}x${asset.height}`.includes(query.replace(/\s+/g, ""))
			);
		});
	});
	let imageAssetFiltersActive = $derived(
		Boolean(imageAssetQuery.trim()) || imageAssetSizeBand !== "all" || imageAssetSourceFilter !== "all"
	);
	let visibleImageAssets = $derived.by(() => (
		imageAssetBrowserExpanded || imageAssetFiltersActive
			? filteredImageAssets
			: filteredImageAssets.slice(0, ASSET_BROWSER_COMPACT_LIMIT)
	));
	let hiddenImageAssetCount = $derived(Math.max(0, filteredImageAssets.length - visibleImageAssets.length));
	let assetLibraryOpen = $derived(
		assetLibraryOpenOverride ?? (
			!isAiResultImageLayer(selectedImageLayer)
			&& !selectedImageLayerLibraryFocusActive
			&& !selectedImageLayer
			&& (
				imageLayers.length > 0
				|| imageAssets.length <= ASSET_BROWSER_COMPACT_LIMIT
				|| Boolean(selectedImageAssetId)
				|| Boolean(imageAssetQuery.trim())
			)
		)
	);
	let selectedImageReplacementMode = $derived(Boolean(
		assetLibraryOpen
		&& selectedImageLayer
		&& !selectedImageLayerIsAiResult
		&& selectedImageLayer.role !== "credit"
	));
	let selectedImageAssetVisible = $derived(
		Boolean(selectedImageAssetId && filteredImageAssets.some((asset) => asset.assetId === selectedImageAssetId))
	);
	let selectedImageAsset = $derived(
		imageAssets.find((asset) => asset.assetId === selectedImageAssetId) ?? null
	);
	let canFilterImageAssets = $derived(projectOpen && hasImage && !imageAssetsLoading && imageAssets.length > 0);
	let canSelectImageAsset = $derived(projectOpen && hasImage && !imageAssetsLoading && filteredImageAssets.length > 0);
	let canUseSelectedImageAsset = $derived(projectOpen && hasImage && selectedImageAssetVisible);
	let canReplaceSelectedLayerFromAsset = $derived(
		canUseSelectedImageAsset && Boolean(selectedImageLayer) && selectedImageLayer?.locked !== true
	);
	let selectedAiResultMarker = $derived(
		selectedImageLayerIsAiResult && selectedImageLayer
			? projectStore.currentPageAiReviewMarkers.find((marker) => `ai-result-${marker.id}` === selectedImageLayer.id) ?? null
			: null
	);
	let imageLayerRoleCounts = $derived.by(() => ({
		all: imageLayers.length,
		reference: imageLayers.filter((layer) => getImageLayerRole(layer) === "reference").length,
		overlay: imageLayers.filter((layer) => getImageLayerRole(layer) === "overlay").length,
		credit: imageLayers.filter((layer) => getImageLayerRole(layer) === "credit").length,
	}));
	let filteredImageLayers = $derived.by(() => {
		if (imageLayerRoleFilter === "all") return imageLayers;
		return imageLayers.filter((layer) => (
			getImageLayerRole(layer) === imageLayerRoleFilter
			|| selectedImageLayer?.id === layer.id
		));
	});
	let propertiesScopeLabel = $derived(
		activeAiPlacementMarker
			? $_("layersInspector.scopeAiWaiting")
			: selectedCreditLayer
			? $_("layersInspector.scopeSelectCredit")
			: selectedLayer
			? $_("layersInspector.scopeSelectTextBox")
			: selectedCreditImageLayer
				? $_("layersInspector.scopeSelectCreditImage")
			: selectedImageLayer
				? (selectedImageLayerIsAiResult ? $_("layersInspector.scopeSelectAiResult") : $_("layersInspector.scopeSelectImageLayer"))
				: (hasImage ? $_("layersInspector.scopeBaseImage") : $_("layersInspector.scopeCanvas"))
	);
	let propertiesDetailLabel = $derived(
		activeAiPlacementMarker
			? $_("layersInspector.detailPlaceAiLayer")
			: selectedCreditLayer
			? $_("layersInspector.detailCreditText")
			: selectedLayer
			? $_("layersInspector.detailText")
			: selectedCreditImageLayer
				? $_("layersInspector.detailCreditImage")
			: selectedImageLayer
				? (selectedImageLayerIsAiResult ? $_("layersInspector.detailAiLayer") : $_("layersInspector.detailImagePos"))
				: (hasImage ? $_("layersInspector.detailSourceImage") : $_("layersInspector.detailCanvasSize"))
	);
	let focusCardTitle = $derived(
		selectedCreditLayer
			? $_("layersInspector.focusCreditText")
			: selectedLayer
			? textLayerDisplayName(selectedLayer)
			: selectedCreditImageLayer
				? $_("layersInspector.focusCreditImage")
			: selectedImageLayer
				? imageLayerDisplayName(selectedImageLayer)
				: hasImage
					? $_("layersInspector.focusBaseImageLocked")
					: $_("layersInspector.focusNoPageImage")
	);
	let focusCardMeta = $derived(
		selectedCreditLayer
			? $_("layersInspector.focusMetaCredit", { values: { text: selectedLayer?.text || $_("layersInspector.creditEmpty"), x: Math.round(selectedLayer?.x ?? 0), y: Math.round(selectedLayer?.y ?? 0), size: selectedLayer?.fontSize ?? defaultFontSize } })
			: selectedLayer
			? `${selectedLayer.name?.trim() ? `${selectedLayer.text || $_("layersInspector.textEmpty")} / ` : ""}${Math.round(selectedLayer.x)}, ${Math.round(selectedLayer.y)} / ${selectedLayer.fontSize}px / ${selectedLayer.alignment ?? "center"}`
			: selectedCreditImageLayer
				? $_("layersInspector.focusMetaCreditImage", { values: { x: Math.round(selectedImageLayer?.x ?? 0), y: Math.round(selectedImageLayer?.y ?? 0), w: Math.round(selectedImageLayer?.w ?? 0), h: Math.round(selectedImageLayer?.h ?? 0) } })
			: selectedImageLayer
				? selectedImageLayerIsAiResult
					? $_("layersInspector.focusMetaAiLayer", { values: { pct: Math.round((selectedImageLayer.opacity ?? 1) * 100) } })
					: `${selectedImageLayer.name?.trim() ? `${selectedImageLayer.originalName || selectedImageLayer.imageName} / ` : ""}${Math.round(selectedImageLayer.x)}, ${Math.round(selectedImageLayer.y)} / ${Math.round(selectedImageLayer.w)} x ${Math.round(selectedImageLayer.h)} / ${Math.round((selectedImageLayer.opacity ?? 1) * 100)}%`
				: (hasImage ? $_("layersInspector.focusMetaCanvasUntracked", { values: { w: canvasDimensions.width, h: canvasDimensions.height } }) : `${canvasDimensions.width} x ${canvasDimensions.height}`)
	);
	let layerClipboardLabel = $derived(
		layerClipboardKind === "image" ? $_("layersInspector.clipboardImageCopied") : layerClipboardKind === "text" ? $_("layersInspector.clipboardTextCopied") : $_("layersInspector.clipboardEmpty")
	);
	let editableLayerCount = $derived(textLayers.length + imageLayers.length);
	let creditTextLayerCount = $derived(textLayers.filter((layer) => layer.sourceCategory === "credit").length);
	let creditImageLayerCount = $derived(imageLayers.filter((layer) => layer.role === "credit").length);
	let creditLayerCount = $derived(creditTextLayerCount + creditImageLayerCount);
	let chapterCreditTextLayerCount = $derived.by(() => {
		const pages = projectStore.project?.pages ?? [];
		if (!pages.length) return creditTextLayerCount;
		return pages.reduce((total, page) => (
			total + trackTextLayers(page, projectStore.activeTargetLang).filter((layer) => layer.sourceCategory === "credit").length
		), 0);
	});
	let chapterCreditImageLayerCount = $derived.by(() => {
		const pages = projectStore.project?.pages ?? [];
		if (!pages.length) return creditImageLayerCount;
		return pages.reduce((total, page) => (
			total + (page.imageLayers ?? []).filter((layer) => layer.role === "credit").length
		), 0);
	});
	let chapterCreditLayerCount = $derived.by(() => {
		const pages = projectStore.project?.pages ?? [];
		if (!pages.length) return creditLayerCount;
		return chapterCreditTextLayerCount + chapterCreditImageLayerCount;
	});
	let selectedCreditAlreadyEditing = $derived(Boolean(selectedCreditLayer || selectedCreditImageLayer));
	let creditSectionOpen = $derived(creditsOpen);
	let hasSelectedCreditLayer = $derived(Boolean(selectedCreditLayer || selectedCreditImageLayer));
	let hasCurrentPageCredits = $derived(creditLayerCount > 0);
	let hasChapterCredits = $derived(chapterCreditLayerCount > 0);
	let selectedCreditDeleteTargetKey = $derived(
		selectedCreditLayer ? `text:${selectedCreditLayer.id}` : selectedCreditImageLayer ? `image:${selectedCreditImageLayer.id}` : ""
	);
	let creditDeleteScopeTargetKey = $state("");
	let selectedCreditDirectKind = $derived(selectedCreditLayer ? $_("layersInspector.selectedCreditDirectText") : selectedCreditImageLayer ? $_("layersInspector.selectedCreditDirectImage") : "");
	let selectedCreditDirectTitle = $derived(
		selectedCreditLayer
			? selectedCreditLayer.text || selectedCreditLayer.name || $_("layersInspector.focusCreditText")
			: selectedCreditImageLayer
				? selectedCreditImageLayer.originalName || selectedCreditImageLayer.name || $_("layersInspector.focusCreditImage")
				: "",
	);
	let selectedCreditDirectMeta = $derived(
		selectedCreditLayer
			? `${Math.round(selectedCreditLayer.x)}, ${Math.round(selectedCreditLayer.y)} / ${selectedCreditLayer.fontSize}px`
			: selectedCreditImageLayer
				? `${Math.round(selectedCreditImageLayer.x)}, ${Math.round(selectedCreditImageLayer.y)} / ${Math.round(selectedCreditImageLayer.w)} x ${Math.round(selectedCreditImageLayer.h)}`
				: "",
	);
	let selectedCreditAdminControlsVisible = $derived(!hasSelectedCreditLayer || selectedCreditAdminOpen);
	let selectionFocusEditLabel = $derived(
		selectedImageLayerIsAiResult
			? $_("layersInspector.focusEditAi")
			: selectedCreditLayer || selectedCreditImageLayer
				? $_("layersInspector.focusEditCredit")
				: selectedImageLayer
					? $_("layersInspector.focusEditImage")
					: selectedLayer
						? $_("layersInspector.focusEditText")
						: $_("layersInspector.focusEditGeneric")
	);
	let selectionFocusEditAria = $derived(
		selectedImageLayerIsAiResult
			? $_("layersInspector.focusEditAiAria")
			: selectedCreditLayer || selectedCreditImageLayer
				? $_("layersInspector.focusEditCreditAria")
				: selectedImageLayer
					? $_("layersInspector.focusEditImageAria")
					: selectedLayer
						? $_("layersInspector.focusEditTextAria")
						: $_("layersInspector.focusEditLayerAria")
	);
	let selectedTextLayerLocked = $derived(selectedLayer?.locked === true);
	let selectedTextFitEstimate = $derived(selectedLayer ? estimateTextLayerFit(selectedLayer) : null);
	let selectedTextNeedsFit = $derived(Boolean(
		selectedLayer
		&& selectedLayer.visible !== false
		&& selectedTextFitEstimate
		&& !selectedTextFitEstimate.fits,
	));
	let selectedTextFitAtMinimum = $derived(Boolean(
		selectedTextNeedsFit
		&& selectedLayer
		&& selectedLayer.fontSize <= 6,
	));
	let selectedTextSuggestedBox = $derived.by(() => {
		if (!selectedLayer || !selectedTextFitEstimate) return null;
		const canvasWidth = canvasDimensions.width || Number.POSITIVE_INFINITY;
		const canvasHeight = canvasDimensions.height || Number.POSITIVE_INFINITY;
		const nextWidth = Math.ceil(Math.max(
			selectedLayer.w,
			Math.min(canvasWidth, selectedTextFitEstimate.estimatedWidth + 12),
		));
		const nextHeight = Math.ceil(Math.max(
			selectedLayer.h,
			Math.min(canvasHeight, selectedTextFitEstimate.estimatedHeight + 12),
		));
		return {
			w: Math.max(1, nextWidth),
			h: Math.max(1, nextHeight),
		};
	});
	let selectedTextCanGrowBox = $derived(Boolean(
		selectedLayer
		&& selectedTextNeedsFit
		&& selectedTextSuggestedBox
		&& (
			selectedTextSuggestedBox.w > Math.round(selectedLayer.w)
			|| selectedTextSuggestedBox.h > Math.round(selectedLayer.h)
		),
	));
	let selectedTextBoxSummary = $derived.by(() => {
		if (!selectedLayer) return "";
		const current = $_("layersInspector.textBoxCurrent", { values: { w: Math.round(selectedLayer.w), h: Math.round(selectedLayer.h) } });
		if (selectedTextNeedsFit && selectedTextSuggestedBox && selectedTextCanGrowBox) {
			return $_("layersInspector.textBoxSuggested", { values: { current: current, w: selectedTextSuggestedBox.w, h: selectedTextSuggestedBox.h } });
		}
		return current;
	});
	let selectedTextFitDetail = $derived.by(() => {
		if (!selectedTextFitEstimate) return "";
		const heightOver = Math.max(0, Math.round(selectedTextFitEstimate.estimatedHeight - selectedTextFitEstimate.availableHeight));
		const widthOver = Math.max(0, Math.round(selectedTextFitEstimate.estimatedWidth - selectedTextFitEstimate.availableWidth));
		if (selectedTextFitAtMinimum) {
			return $_("layersInspector.textFitAtMinimum");
		}
		const parts = [$_("layersInspector.textFitLineCount", { values: { n: selectedTextFitEstimate.lineCount } })];
		if (heightOver > 0) parts.push($_("layersInspector.textFitHeightOver", { values: { n: heightOver } }));
		if (widthOver > 0) parts.push($_("layersInspector.textFitWidthOver", { values: { n: widthOver } }));
		return parts.join(" / ");
	});
	let selectedCreditPreset = $derived(
		creditPresets.find((preset) => preset.id === selectedCreditPresetId) ?? creditPresets[0] ?? null
	);
	let creditPlacementSummary = $derived(
		selectedCreditPreset ? creditPlacementLabel(selectedCreditPreset.placement) : $_("layersInspector.creditNoPlacement")
	);
	let creditScopeSummary = $derived(projectOpen ? creditApplyScopeLabel(creditApplyScope) : $_("layersInspector.creditScopeCurrentPage"));
	let creditRepeatSummary = $derived(
		creditApplyScope === "chapter-edges"
			? $_("layersInspector.creditRepeatEdgesNone")
			: creditImageRepeatEveryPx > 0 ? $_("layersInspector.creditRepeatEvery", { values: { n: creditImageRepeatEveryPx } }) : $_("layersInspector.creditRepeatNone")
	);
	let creditDeleteSummary = $derived.by(() => {
		if (selectedCreditLayer || selectedCreditImageLayer) return $_("layersInspector.creditDeleteSelectedHint");
		if (creditLayerCount > 0) return $_("layersInspector.creditDeletePageHas", { values: { n: creditLayerCount } });
		if (chapterCreditLayerCount > 0) return $_("layersInspector.creditDeleteChapterHas", { values: { n: chapterCreditLayerCount } });
		return $_("layersInspector.creditDeleteNone");
	});
	let creditDeleteOptions = $derived.by(() => buildCreditDeleteOptions());
	let effectiveCreditDeleteScope = $derived.by(() => {
		if (selectedCreditDeleteTargetKey && creditDeleteScopeTargetKey !== selectedCreditDeleteTargetKey) return "selected";
		return creditDeleteScope;
	});
	let activeCreditDeleteOption = $derived(
		creditDeleteOptions.find((option) => option.value === effectiveCreditDeleteScope) ?? creditDeleteOptions[0] ?? null
	);
	let nextLayerActionTitle = $derived(
		editableLayerCount > 0 ? $_("layersInspector.nextLayerEditOrAdd") : $_("layersInspector.nextLayerAddEdit")
	);
	let nextLayerActionDetail = $derived(
		hasImage
			? $_("layersInspector.nextLayerDetailAbove")
			: $_("layersInspector.nextLayerDetailOpenPage")
	);
	let editableStackSummary = $derived(
		editableLayerCount > 0
			? $_("layersInspector.editableStackSummary", { values: { images: imageLayers.length, texts: textLayers.length } })
			: $_("layersInspector.editableStackEmpty")
	);
	let unifiedLayerStackItems = $derived.by((): UnifiedLayerStackItem[] => {
		const entries = [
			...textLayers.map((layer) => ({
				kind: "text" as const,
				layer,
				zIndex: Number.isFinite(layer.zIndex) ? Number(layer.zIndex) : imageLayers.length + layer.index,
			})),
			...imageLayers.map((layer) => ({
				kind: "image" as const,
				layer,
				zIndex: Number.isFinite(layer.zIndex) ? Number(layer.zIndex) : layer.index,
			})),
		].sort((a, b) => b.zIndex - a.zIndex || (a.kind === "text" ? -1 : 1));
		const stackSize = entries.length;
		return entries.map((entry, position) => {
			const stackIndex = stackSize - position - 1;
			if (entry.kind === "text") {
				const layer = entry.layer;
				return {
				stackKey: `text:${layer.id}:${layer.index}:${position}`,
				id: layer.id,
				kind: "text" as const,
				title: textLayerDisplayName(layer),
				meta: $_("layersInspector.stackTextMeta", { values: { kind: layer.sourceCategory === "credit" ? $_("layersInspector.stackMetaCreditText") : $_("layersInspector.stackMetaTextBox"), x: Math.round(layer.x), y: Math.round(layer.y), size: layer.fontSize } }),
				badge: layer.sourceCategory === "credit" ? $_("layersInspector.badgeCredit") : $_("layersInspector.badgeText"),
				isCredit: layer.sourceCategory === "credit",
				visible: layer.visible !== false,
				locked: layer.locked === true,
				active: selectedLayer?.id === layer.id,
				index: layer.index,
				groupSize: textLayers.length,
					stackIndex,
					stackSize,
				};
			}
			const layer = entry.layer;
			return {
				stackKey: `image:${layer.id}:${layer.index}:${position}`,
				id: layer.id,
				kind: "image" as const,
				title: imageLayerDisplayName(layer),
				meta: $_("layersInspector.stackImageMeta", { values: { kind: isAiResultImageLayer(layer) ? $_("layersInspector.stackMetaAiResult") : layer.role === "credit" ? $_("layersInspector.stackMetaCreditImage") : $_("layersInspector.stackMetaImage"), x: Math.round(layer.x), y: Math.round(layer.y), w: Math.round(layer.w), h: Math.round(layer.h) } }),
				badge: isAiResultImageLayer(layer) ? $_("layersInspector.badgeAi") : layer.role === "credit" ? $_("layersInspector.badgeCredit") : $_("layersInspector.badgeImage"),
				isCredit: layer.role === "credit",
				visible: layer.visible !== false,
				locked: layer.locked === true,
				active: selectedImageLayer?.id === layer.id,
				index: layer.index,
				groupSize: imageLayers.length,
				stackIndex,
				stackSize,
			};
		});
	});
	let filteredUnifiedLayerStackItems = $derived.by((): UnifiedLayerStackItem[] => {
		if (unifiedLayerStackFilter === "all") return unifiedLayerStackItems;
		return unifiedLayerStackItems.filter((item) => (
			unifiedLayerStackItemMatchesFilter(item, unifiedLayerStackFilter)
			|| item.active
		));
	});
	let unifiedLayerStackFilterCounts = $derived.by(() => ({
		all: unifiedLayerStackItems.length,
		credit: unifiedLayerStackItems.filter((item) => item.isCredit).length,
		text: unifiedLayerStackItems.filter((item) => item.kind === "text" && !item.isCredit).length,
		image: unifiedLayerStackItems.filter((item) => item.kind === "image" && !item.isCredit).length,
	}));
	let showUnifiedLayerStackFilter = $derived(unifiedLayerStackItems.length > 6 || creditLayerCount > 2);
	let unifiedLayerStackListSummary = $derived(
		unifiedLayerStackFilter === "all"
			? $_("layersInspector.stackListEditLayers", { values: { n: unifiedLayerStackItems.length } })
			: $_("layersInspector.stackListShown", { values: { shown: filteredUnifiedLayerStackItems.length, total: unifiedLayerStackItems.length } })
	);
	let selectedUnifiedStackPosition = $derived.by(() => {
		if (unifiedLayerStackItems.length === 0) return "";
		const position = unifiedLayerStackItems.findIndex((item) => (
			(selectedLayer && item.kind === "text" && item.id === selectedLayer.id)
			|| (selectedImageLayer && item.kind === "image" && item.id === selectedImageLayer.id)
		));
		if (position < 0) return "";
		return $_("layersInspector.stackPosition", { values: { pos: position + 1, total: unifiedLayerStackItems.length } });
	});
	let selectedUnifiedStackTopPosition = $derived.by(() => {
		return unifiedLayerStackItems.findIndex((item) => (
			(selectedLayer && item.kind === "text" && item.id === selectedLayer.id)
			|| (selectedImageLayer && item.kind === "image" && item.id === selectedImageLayer.id)
		));
	});
	let selectedUnifiedStackItem = $derived.by(() => {
		return unifiedLayerStackItems.find((item) => (
			(selectedLayer && item.kind === "text" && item.id === selectedLayer.id)
			|| (selectedImageLayer && item.kind === "image" && item.id === selectedImageLayer.id)
		)) ?? null;
	});
	let selectedUnifiedStackItemIncludedByFilter = $derived(Boolean(
		selectedUnifiedStackItem
		&& unifiedLayerStackFilter !== "all"
		&& !unifiedLayerStackItemMatchesFilter(selectedUnifiedStackItem, unifiedLayerStackFilter)
	));
	let selectedUnifiedStackSummary = $derived(
		selectedUnifiedStackItem && selectedUnifiedStackPosition
			? `${selectedUnifiedStackItem.title} · ${selectedUnifiedStackPosition}`
			: selectedUnifiedStackPosition
	);
	let unifiedStackSummaryHint = $derived(
		selectedUnifiedStackItem
			? selectedUnifiedStackItemIncludedByFilter
				? $_("layersInspector.stackHintIncludeSelected")
				: $_("layersInspector.stackHintShowSelected")
			: selectedEditableLayerActive
				? $_("layersInspector.stackHintReorder")
				: $_("layersInspector.stackHintTop")
	);
	let selectedCanMoveUp = $derived(
		Boolean(selectedUnifiedStackItem && selectedUnifiedStackItem.stackIndex < selectedUnifiedStackItem.stackSize - 1)
	);
	let selectedCanMoveDown = $derived(
		Boolean(selectedUnifiedStackItem && selectedUnifiedStackItem.stackIndex > 0)
	);
	let selectedStackAboveItem = $derived(selectedUnifiedStackTopPosition > 0 ? unifiedLayerStackItems[selectedUnifiedStackTopPosition - 1] : null);
	let selectedStackBelowItem = $derived(
		selectedUnifiedStackTopPosition >= 0 && selectedUnifiedStackTopPosition < unifiedLayerStackItems.length - 1
			? unifiedLayerStackItems[selectedUnifiedStackTopPosition + 1]
			: null
	);
	let selectedStackAboveLabel = $derived(selectedStackAboveItem ? stackItemShortLabel(selectedStackAboveItem) : $_("layersInspector.stackTopReached"));
	let selectedStackCurrentLabel = $derived(selectedUnifiedStackItem ? stackItemShortLabel(selectedUnifiedStackItem) : "");
	let selectedStackBelowLabel = $derived(selectedStackBelowItem ? stackItemShortLabel(selectedStackBelowItem) : $_("layersInspector.stackBaseLocked"));
	let selectedStackAboveMeta = $derived(selectedStackAboveItem ? selectedStackAboveItem.meta : $_("layersInspector.stackNoLayerAbove"));
	let selectedStackCurrentMeta = $derived(selectedUnifiedStackItem ? selectedUnifiedStackItem.meta : "");
	let selectedStackBelowMeta = $derived(selectedStackBelowItem ? selectedStackBelowItem.meta : $_("layersInspector.stackAboveBase"));
	let workspaceEntryLayerStartActive = $derived(Boolean(
		editorUiStore.workspaceEditorEntry
		&& editorUiStore.workspaceEditorEntry.projectId === projectStore.project?.projectId
		&& !selectedLayer
		&& !selectedImageLayer
		&& editableLayerCount === 0
		&& !activeAiPlacementMarker
	));
	let workspaceEntryLayerReason = $derived(editorUiStore.workspaceEditorEntry?.reason ?? $_("layersInspector.workspaceEntryReasonDefault"));
	let selectedObjectOwnerActive = $derived(selectedEditableLayerActive);
	let selectedEditableLayerFocusActive = $derived(Boolean(
		selectedEditableLayerActive
		&& editorUiStore.workspaceEditorEntry
		&& editorUiStore.workspaceEditorEntry.projectId === projectStore.project?.projectId
		&& !selectedImageLayerIsAiResult
		&& !activeAiPlacementMarker
	));
	let selectedImagePrimaryEditActive = $derived(Boolean(
		selectedImageLayer
		&& !selectedImageLayerIsAiResult
		&& !activeAiPlacementMarker
	));
	let selectedCreditFocusActive = $derived(selectedEditableLayerFocusActive && Boolean(selectedCreditLayer || selectedCreditImageLayer));
	let compactSelectedContextForCredit = $derived(Boolean(
		selectedEditableLayerActive
		&& (creditsOpen || selectedCreditLayer || selectedCreditImageLayer)
	));
	let selectedEditableFocusKey = $derived(
		selectedEditableLayerFocusActive
			? `${projectStore.project?.projectId ?? "no-project"}:${selectedLayer?.id ?? selectedImageLayer?.id ?? "no-layer"}`
			: ""
	);
	let focusedLayerToolsCollapsed = $derived(workspaceEntryLayerStartActive || selectedEditableLayerFocusActive);
	let layerToolsToggleLabel = $derived(selectedEditableLayerFocusActive ? $_("layersInspector.layerToolsOtherLayers") : $_("layersInspector.layerToolsAll"));

	let showNextLayerActionCard = $derived(Boolean(
		!selectedImageLayerIsAiResult
		&& !activeAiPlacementMarker
		&& !selectedEditableLayerFocusActive
		&& !selectedEditableLayerActive
		&& !selectedImageLayer
	));
	let showUnifiedLayerStack = $derived(Boolean(
		!activeAiPlacementMarker
		&& (hasImage || unifiedLayerStackItems.length > 0)
		&& (editableLayerCount > 0 || selectedEditableLayerActive || layerShortcutsExpanded)
	));
	const controlIds = {
		text: "text-layer-text",
		textPreset: "text-style-preset",
		textEffectPrompt: "text-effect-prompt",
		presetName: "text-style-preset-name",
		creditPreset: "credit-preset",
		creditText: "credit-text",
		creditOffset: "credit-offset",
		creditPresetName: "credit-preset-name",
		creditDeleteScope: "credit-delete-scope",
		fill: "text-layer-fill",
		stroke: "text-layer-stroke",
		strokeWidth: "text-layer-stroke-width",
		charSpacing: "text-layer-char-spacing",
		fitText: "text-layer-fit-box",
		alignment: "text-layer-alignment",
		aspectRatio: "canvas-aspect-ratio",
		imageOpacity: "image-layer-opacity",
		imageX: "image-layer-x",
		imageY: "image-layer-y",
		imageWidth: "image-layer-width",
		imageHeight: "image-layer-height",
		imageRotation: "image-layer-rotation",
		imageRole: "image-layer-role",
		imageBlendMode: "image-layer-blend-mode",
		imageLayerName: "image-layer-name",
		selectedImageQuickOpacity: "selected-image-quick-opacity",
		selectedImageQuickBlendMode: "selected-image-quick-blend-mode",
		aiLayerFocus: "ai-layer-focus-card",
		aiLayerOpacity: "ai-layer-opacity",
		textLayerName: "text-layer-name",
		textOpacity: "text-layer-opacity",
		textBoxWidth: "text-layer-box-width",
		textBoxHeight: "text-layer-box-height",
		imageAssetFilter: "image-asset-filter",
	};

	function normalizeColor(value: string | undefined, fallback: string): string {
		return /^#[0-9a-fA-F]{6}$/.test(value ?? "") ? value! : fallback;
	}

	function sectionToggleLabel(label: string, open: boolean): string {
		return $_("layersInspector.sectionToggle", { values: { label: label, state: open ? $_("layersInspector.sectionOpen") : $_("layersInspector.sectionCollapsed") } });
	}

	function updateCreditPreset(event: Event): void {
		onCreditPresetChange((event.currentTarget as HTMLSelectElement).value);
	}

	function updateCreditText(event: Event): void {
		onCreditTextChange((event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
	}

	function updateCreditOffset(event: Event): void {
		onCreditOffsetChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateCreditPresetName(event: Event): void {
		onCreditPresetNameChange((event.currentTarget as HTMLInputElement).value);
	}

	function getLayerListKey(kind: "text" | "image", layerId: string, index: number): string {
		return `${kind}-${layerId}-${index}`;
	}

	function allowLayerDrop(event: DragEvent): void {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	}

	function startUnifiedLayerDrag(item: UnifiedLayerStackItem, event: DragEvent): void {
		draggedLayer = { kind: item.kind, id: item.id, index: item.stackIndex };
		event.dataTransfer?.setData("text/plain", `${item.kind}:${item.id}`);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}

	function dropUnifiedLayer(target: UnifiedLayerStackItem, event: DragEvent): void {
		event.preventDefault();
		const source = draggedLayer;
		draggedLayer = null;
		if (!source || source.id === target.id) return;

		// Re-read the LIVE source index off the current stack rather than trusting
		// the index captured at drag-start (it can be stale if the stack changed
		// mid-drag), then move the source one slot at a time toward the target.
		const liveSource = unifiedLayerStackItems.find(
			(item) => item.id === source.id && item.kind === source.kind,
		);
		const sourceStackIndex = liveSource?.stackIndex ?? source.index;
		const delta = target.stackIndex - sourceStackIndex;
		if (delta === 0) return;

		// Direction matches the move-up / move-down buttons: +N raises a layer toward
		// a HIGHER panel stackIndex (up the panel), -N lowers it. Dispatch the whole
		// drag as one reorder command so one pointer gesture becomes one undo step.
		onReorderUnifiedLayer(source.kind, source.id, delta);
	}

	function selectUnifiedLayerStackItem(item: UnifiedLayerStackItem): void {
		if (item.kind === "text") {
			selectTextLayerForProperties(item.id);
			return;
		}
		selectImageLayerForProperties(item.id);
	}

	function toggleUnifiedLayerVisibility(item: UnifiedLayerStackItem): void {
		if (item.kind === "text") {
			onToggleLayerVisibility(item.id);
			return;
		}
		onToggleImageLayerVisibility(item.id);
	}

	function toggleUnifiedLayerLock(item: UnifiedLayerStackItem): void {
		if (item.kind === "text") {
			onToggleLayerLock(item.id);
			return;
		}
		onToggleImageLayerLock(item.id);
	}

	function moveUnifiedLayer(item: UnifiedLayerStackItem, direction: -1 | 1): void {
		onMoveUnifiedLayer(item.kind, item.id, direction);
	}

	function moveSelectedUnifiedLayer(direction: -1 | 1): void {
		if (!selectedUnifiedStackItem) return;
		moveUnifiedLayer(selectedUnifiedStackItem, direction);
	}

	function requestDeleteTextLayer(layer: TextLayer): void {
		pendingDeleteAction = {
			kind: "text",
			id: layer.id,
			title: layer.sourceCategory === "credit" ? $_("layersInspector.deleteCreditTextQ") : $_("layersInspector.deleteTextBoxQ"),
			detail: $_("layersInspector.deleteTextDetail", { values: { name: textLayerDisplayName(layer) } }),
		};
	}

	function requestDeleteImageLayer(layer: ImageLayer): void {
		pendingDeleteAction = {
			kind: "image",
			id: layer.id,
			title: layer.role === "credit" ? $_("layersInspector.deleteCreditImageQ") : isAiResultImageLayer(layer) ? $_("layersInspector.deleteAiResultQ") : $_("layersInspector.deleteImageLayerQ"),
			detail: $_("layersInspector.deleteImageDetail", { values: { name: imageLayerDisplayName(layer) } }),
		};
	}

	function requestDeleteSelectedCreditLayer(): void {
		if (selectedCreditLayer) {
			requestDeleteTextLayer(selectedCreditLayer);
			return;
		}
		if (selectedCreditImageLayer) {
			requestDeleteImageLayer(selectedCreditImageLayer);
		}
	}

	function creditDeleteConfirmDetail(allPages: boolean, kind: CreditDeleteKind): string {
		const currentTextCount = kind === "image" ? 0 : creditTextLayerCount;
		const currentImageCount = kind === "text" ? 0 : creditImageLayerCount;
		const currentTotalCount = currentTextCount + currentImageCount;
		const chapterTextCount = kind === "image" ? 0 : chapterCreditTextLayerCount;
		const chapterImageCount = kind === "text" ? 0 : chapterCreditImageLayerCount;
		const chapterTotalCount = chapterTextCount + chapterImageCount;
		const targetLabel = kind === "text" ? $_("layersInspector.creditTargetText") : kind === "image" ? $_("layersInspector.creditTargetImage") : $_("layersInspector.creditTargetGeneric");
		const breakdown = $_("layersInspector.creditBreakdown", { values: { text: currentTextCount, image: currentImageCount } });
		if (!allPages) {
			const currentPageNumber = (projectStore.project?.currentPage ?? 0) + 1;
			const otherPageCreditCount = (projectStore.project?.pages ?? []).reduce((total, page, pageIndex) => {
				if (pageIndex === (projectStore.project?.currentPage ?? 0)) return total;
				const textCredits = kind === "image" ? 0 : trackTextLayers(page, projectStore.activeTargetLang).filter((layer) => layer.sourceCategory === "credit").length;
				const imageCredits = kind === "text" ? 0 : (page.imageLayers ?? []).filter((layer) => layer.role === "credit").length;
				return total + textCredits + imageCredits;
			}, 0);
			const otherPageDetail = otherPageCreditCount > 0
				? $_("layersInspector.creditOtherPagesRemain", { values: { target: targetLabel, n: otherPageCreditCount } })
				: $_("layersInspector.creditOtherPagesNone", { values: { target: targetLabel } });
			return $_("layersInspector.creditDeleteCurrentConfirm", { values: { target: targetLabel, n: currentTotalCount, page: currentPageNumber, breakdown: breakdown, other: otherPageDetail } });
		}
		return $_("layersInspector.creditDeleteChapterConfirm", { values: { target: targetLabel, n: chapterTotalCount, text: chapterTextCount, image: chapterImageCount } });
	}

	function updateCreditDeleteScope(event: Event): void {
		creditDeleteScope = (event.currentTarget as HTMLSelectElement).value as CreditDeleteScopeKey;
		creditDeleteScopeTargetKey = selectedCreditDeleteTargetKey;
	}

	function requestDeleteCreditScope(): void {
		const option = activeCreditDeleteOption;
		if (!option) return;
		if (option.selectedOnly) {
			requestDeleteSelectedCreditLayer();
			return;
		}
		pendingDeleteAction = {
			kind: "credits",
			title: option.title,
			detail: option.confirmDetail,
			allPages: option.allPages,
			creditKind: option.creditKind,
			match: option.match,
		};
	}

	function confirmPendingDelete(): void {
		const action = pendingDeleteAction;
		pendingDeleteAction = null;
		if (!action) return;
		if (action.kind === "text") {
			onDeleteLayer(action.id);
			return;
		}
		if (action.kind === "image") {
			onDeleteImageLayer(action.id);
			return;
		}
		onDeleteCreditLayers(action.allPages, action.creditKind, action.match);
	}

	function updateSelectedTextLayerName(event: Event): void {
		if (selectedTextLayerLocked) return;
		onSelectedTextLayerNameChange((event.currentTarget as HTMLInputElement).value);
	}

	function updateSelectedTextBoxNumber(event: Event, key: "w" | "h"): void {
		if (selectedTextLayerLocked) return;
		const value = Number((event.currentTarget as HTMLInputElement).value);
		if (!Number.isFinite(value)) return;
		onSelectedTextBoxChange({ [key]: Math.max(1, Math.round(value)) });
	}

	function expandSelectedTextBoxToFit(): void {
		if (selectedTextLayerLocked || !selectedTextSuggestedBox) return;
		onSelectedTextBoxChange(selectedTextSuggestedBox);
	}

	function updateSelectedPreset(event: Event): void {
		if (selectedTextLayerLocked) return;
		onSelectedPresetChange((event.currentTarget as HTMLSelectElement).value);
	}

	function updatePresetName(event: Event): void {
		onPresetNameChange((event.currentTarget as HTMLInputElement).value);
	}

	function updateTextEffectPrompt(event: Event): void {
		onTextEffectPromptChange((event.currentTarget as HTMLInputElement).value);
	}

	function updateSelectedFill(event: Event): void {
		if (selectedTextLayerLocked) return;
		onFillChange((event.currentTarget as HTMLInputElement).value);
	}

	// The browser-native eyedropper (Chromium/Edge) lets a typesetter sample the text
	// colour straight from the artwork. Hidden where the API is absent (Firefox/Safari);
	// the colour swatch still works there.
	const eyedropperSupported = typeof window !== "undefined" && "EyeDropper" in window;
	let eyedropperBusy = $state(false);
	async function pickFillWithEyedropper(): Promise<void> {
		if (selectedTextLayerLocked || eyedropperBusy || !eyedropperSupported) return;
		const Ctor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
		if (!Ctor) return;
		eyedropperBusy = true;
		try {
			const result = await new Ctor().open();
			if (result?.sRGBHex) onFillChange(result.sRGBHex);
		} catch {
			// The user dismissed the picker (Esc) — nothing to do.
		} finally {
			eyedropperBusy = false;
		}
	}

	function updateSelectedStroke(event: Event): void {
		if (selectedTextLayerLocked) return;
		onStrokeChange((event.currentTarget as HTMLInputElement).value);
	}

	function updateSelectedStrokeWidth(event: Event): void {
		if (selectedTextLayerLocked) return;
		onStrokeWidthChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateSelectedCharSpacing(event: Event): void {
		if (selectedTextLayerLocked) return;
		const value = Number((event.currentTarget as HTMLInputElement).value);
		onCharSpacingChange(Number.isFinite(value) ? value : 0);
	}

	function updateSelectedTextOpacity(event: Event): void {
		if (selectedTextLayerLocked) return;
		const value = Number((event.currentTarget as HTMLInputElement).value);
		onTextOpacityChange(Number.isFinite(value) ? value / 100 : 1);
	}

	function updateSelectedAlignment(event: Event): void {
		if (selectedTextLayerLocked) return;
		onAlignmentChange((event.currentTarget as HTMLSelectElement).value as TextLayer["alignment"]);
	}

	function updateAspectRatio(event: Event): void {
		onAspectRatioChange((event.currentTarget as HTMLSelectElement).value);
	}

	function updateImageAssetSelection(event: Event): void {
		onImageAssetSelectionChange((event.currentTarget as HTMLSelectElement).value);
	}

	function selectImageAsset(assetId: string): void {
		onImageAssetSelectionChange(assetId);
	}

	function setImageAssetView(mode: ImageAssetViewMode): void {
		imageAssetView = mode;
	}

	function toggleImageAssetBrowserExpanded(): void {
		imageAssetBrowserExpanded = !imageAssetBrowserExpanded;
	}

	function setImageLayerRoleFilter(filter: ImageLayerRoleFilter): void {
		imageLayerRoleFilter = filter;
	}

	function updateImageAssetQuery(event: Event): void {
		imageAssetQuery = (event.currentTarget as HTMLInputElement).value;
		assetLibraryOpenOverride = true;
		imageAssetBrowserExpanded = Boolean(imageAssetQuery.trim());
	}

	function setImageAssetSizeBand(band: AssetSizeBand): void {
		imageAssetSizeBand = band;
		assetLibraryOpenOverride = true;
	}

	function setImageAssetSourceFilter(source: AssetSourceFilter): void {
		imageAssetSourceFilter = source;
		assetLibraryOpenOverride = true;
	}

	function toggleAssetLibraryOpen(event: MouseEvent): void {
		event.preventDefault();
		assetLibraryOpenOverride = !assetLibraryOpen;
	}

	function formatAssetBytes(sizeBytes: number): string {
		if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 B";
		if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
		if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
		return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatAssetCompactBytes(sizeBytes: number): string {
		if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0B";
		if (sizeBytes < 1024) return `${Math.round(sizeBytes)}B`;
		if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)}K`;
		return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
	}

	function formatImageAssetUsageLabel(asset: ProjectImageAssetSummary): string {
		return $_("layersInspector.assetUsageLabel", { values: { n: getImageAssetUsageCount(asset) } });
	}

	function formatImageAssetReadyStatus(asset: ProjectImageAssetSummary): string {
		const storage = asset.storageStatus === "released" ? $_("layersInspector.assetStatusReady") : asset.storageStatus === "scanning" ? $_("layersInspector.assetStatusScanning") : asset.storageStatus;
		const moderation = asset.moderationStatus === "passed" ? $_("layersInspector.assetModerationPassed") : asset.moderationStatus === "pending" ? $_("layersInspector.assetModerationPending") : asset.moderationStatus;
		return `${storage} / ${moderation}`;
	}

	function formatImageAssetFileType(asset: ProjectImageAssetSummary): string {
		const mime = asset.mimeType.toLowerCase();
		if (mime.includes("webp")) return "WebP";
		if (mime.includes("png")) return "PNG";
		if (mime.includes("jpeg") || mime.includes("jpg")) return "JPEG";
		if (mime.includes("avif")) return "AVIF";
		return asset.mimeType;
	}

	function formatAssetDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return $_("layersInspector.assetUnknownDate");
		return date.toISOString().slice(0, 10);
	}

	function formatAssetShortId(asset: ProjectImageAssetSummary): string {
		const id = (asset.assetId || asset.imageId).trim();
		if (/^(flow\d+|debug|tmp|missing-|stale-)/i.test(id)) return formatImageAssetFileType(asset);
		return id.slice(0, 8);
	}

	function imageAssetThumbnailKey(asset: ProjectImageAssetSummary): string {
		return `${projectId ?? "none"}:${asset.assetId}:${asset.imageId}`;
	}

	function shouldShowImageAssetThumbnail(asset: ProjectImageAssetSummary): boolean {
		return Boolean(
			projectId
			&& asset.storageDriver !== "debug"
			&& !imageAssetThumbnailFailures[imageAssetThumbnailKey(asset)]
		);
	}

	function markImageAssetThumbnailFailed(asset: ProjectImageAssetSummary): void {
		imageAssetThumbnailFailures = { ...imageAssetThumbnailFailures, [imageAssetThumbnailKey(asset)]: true };
	}

	function clearImageAssetThumbnailFailure(asset: ProjectImageAssetSummary): void {
		const key = imageAssetThumbnailKey(asset);
		if (!imageAssetThumbnailFailures[key]) return;
		const nextFailures = { ...imageAssetThumbnailFailures };
		delete nextFailures[key];
		imageAssetThumbnailFailures = nextFailures;
	}

	function shouldShowImageAssetPreview(asset: ProjectImageAssetSummary): boolean {
		return Boolean(
			projectId
			&& asset.storageDriver !== "debug"
			&& !imageAssetPreviewFailures[imageAssetThumbnailKey(asset)]
		);
	}

	function imageAssetPreviewUrl(asset: ProjectImageAssetSummary): string {
		return projectStore.getImageUrl(asset.imageId);
	}

	function markImageAssetPreviewFailed(asset: ProjectImageAssetSummary): void {
		imageAssetPreviewFailures = { ...imageAssetPreviewFailures, [imageAssetThumbnailKey(asset)]: true };
	}

	function clearImageAssetPreviewFailure(asset: ProjectImageAssetSummary): void {
		const key = imageAssetThumbnailKey(asset);
		if (!imageAssetPreviewFailures[key]) return;
		const nextFailures = { ...imageAssetPreviewFailures };
		delete nextFailures[key];
		imageAssetPreviewFailures = nextFailures;
	}

	function formatAssetDisplayName(asset: ProjectImageAssetSummary): string {
		const rawName = (asset.originalName || asset.imageId || asset.assetId).trim();
		const pathName = rawName.split(/[\\/]/).pop() || rawName;
		const imageName = pathName.match(/(?:^|_)((?:image|page|p)[-_]?\d{1,4}\.[a-z0-9]+)$/i)?.[1];
		return imageName || pathName;
	}

	function formatAssetOptionLabel(asset: ProjectImageAssetSummary): string {
		return `${formatAssetDisplayName(asset)} | ${asset.width} x ${asset.height} | ${formatAssetBytes(asset.sizeBytes)} | ${formatAssetShortId(asset)}`;
	}

	function getImageLayerRole(layer: Pick<ImageLayer, "id" | "imageName" | "originalName" | "role">): NormalizedImageLayerRole {
		if (isAiResultImageLayer(layer)) return "overlay";
		return layer.role ?? "reference";
	}

	// $derived so the localized "Normal" label re-resolves on a live locale switch.
	const imageLayerBlendModeOptions: Array<{ value: ImageLayerBlendMode; label: string }> = $derived([
		{ value: "normal", label: $_("layersInspector.blendNormal") },
		{ value: "multiply", label: "Multiply" },
		{ value: "screen", label: "Screen" },
		{ value: "overlay", label: "Overlay" },
		{ value: "soft-light", label: "Soft light" },
	]);

	function getImageLayerBlendMode(layer: Pick<ImageLayer, "blendMode">): NormalizedImageLayerBlendMode {
		return imageLayerBlendModeOptions.some((option) => option.value === layer.blendMode)
			? (layer.blendMode as NormalizedImageLayerBlendMode)
			: "normal";
	}

	function formatImageLayerRole(layer: Pick<ImageLayer, "id" | "imageName" | "originalName" | "role">): string {
		if (isAiResultImageLayer(layer)) return $_("layersInspector.stackMetaAiResult");
		const role = getImageLayerRole(layer);
		if (role === "credit") return $_("layersInspector.focusCreditImage");
		return role === "overlay" ? $_("layersInspector.roleOverlay") : $_("layersInspector.roleReference");
	}

	function imageLayerDisplayName(layer: ImageLayer): string {
		return layer.name?.trim() || layer.originalName || layer.imageName;
	}

	function imageLayerListMeta(layer: ImageLayer): string {
		if (isAiResultImageLayer(layer)) {
			return $_("layersInspector.imageMetaAiResult", { values: { pct: Math.round((layer.opacity ?? 1) * 100) } });
		}
		if (getImageLayerRole(layer) === "credit") return $_("layersInspector.badgeCredit");
		return $_("layersInspector.imageMetaRoleOpacity", { values: { role: formatImageLayerRole(layer), pct: Math.round((layer.opacity ?? 1) * 100) } });
	}

	function imageLayerTransformSummary(layer: ImageLayer): string {
		const flipState = [
			layer.flipX === true ? $_("layersInspector.flipHorizontal") : "",
			layer.flipY === true ? $_("layersInspector.flipVertical") : "",
		].filter(Boolean).join(" / ");
		return [
			`${Math.round(layer.x)}, ${Math.round(layer.y)}`,
			`${Math.round(layer.w)} x ${Math.round(layer.h)}`,
			$_("layersInspector.rotateDeg", { values: { n: Math.round(layer.rotation) } }),
			flipState,
		].filter(Boolean).join(" / ");
	}

	function imageLayerTransformDetail(layer: ImageLayer): string {
		const blend = imageLayerBlendModeOptions.find((option) => option.value === getImageLayerBlendMode(layer))?.label ?? $_("layersInspector.blendNormal");
		return $_("layersInspector.imageTransformDetail", { values: { role: formatImageLayerRole(layer), pct: Math.round((layer.opacity ?? 1) * 100), blend: blend } });
	}

	function hasAiResultLayer(marker: AiReviewMarker): boolean {
		return imageLayers.some((layer) => layer.id === `ai-result-${marker.id}`);
	}

	async function placeActiveAiResultLayer(): Promise<void> {
		if (!activeAiPlacementMarker) return;
		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer(activeAiPlacementMarker.id, editorStore.editor, {
			statusMessage: $_("layersInspector.aiResultPlacedStatus"),
		});
		if (layer) {
			editorUiStore.focusImageInspector(layer.id);
		}
	}

	function openActiveAiReview(): void {
		if (!activeAiPlacementMarker) return;
		projectStore.selectAiReviewMarker(activeAiPlacementMarker.id);
		editorStore.editor?.focusImageRegion?.(activeAiPlacementMarker.region);
		editorUiStore.setRightPanelMode("ai");
	}

	function openSelectedAiReview(): void {
		if (!selectedAiResultMarker) return;
		projectStore.selectAiReviewMarker(selectedAiResultMarker.id);
		editorStore.editor?.focusImageRegion?.(selectedAiResultMarker.region);
		editorUiStore.setRightPanelMode("ai");
	}

	function imageLayerStateBadges(layer: ImageLayer): string[] {
		const badges: string[] = [];
		const blendMode = getImageLayerBlendMode(layer);
		const blendLabel = imageLayerBlendModeOptions.find((option) => option.value === blendMode)?.label ?? blendMode;
		if (blendMode !== "normal") badges.push(blendLabel);
		if (layer.flipX === true) badges.push($_("layersInspector.flipHorizontal"));
		if (layer.flipY === true) badges.push($_("layersInspector.flipVertical"));
		const opacityPct = Math.round((layer.opacity ?? 1) * 100);
		if (opacityPct !== 100) badges.push(`${opacityPct}%`);
		const rotation = Math.round(layer.rotation || 0);
		if (rotation !== 0) badges.push($_("layersInspector.rotateDeg", { values: { n: rotation } }));
		if (layer.sourceW && layer.sourceH && layer.w > 0 && layer.h > 0) {
			const sourceAspect = Math.round((layer.sourceW / layer.sourceH) * 1000) / 1000;
			const layerAspect = Math.round((layer.w / layer.h) * 1000) / 1000;
			if (Math.abs(sourceAspect - layerAspect) > 0.01) badges.push($_("layersInspector.aspectSkewed"));
		}
		return badges;
	}

	function textLayerDisplayName(layer: TextLayer): string {
		return layer.name?.trim() || layer.text || $_("layersInspector.textEmpty");
	}

	// Localize the source-category code (`layerCategoryCode` returns a stable code,
	// not Thai). Unknown codes fall back to the raw value so custom categories still
	// render.
	function layerCategoryLabel(category: TextLayer["sourceCategory"]): string {
		const code = layerCategoryCode(category);
		if (!code) return "";
		const key = `layerCategory.${code}`;
		const label = $_(key);
		return label === key ? code : label;
	}

	function textLayerListMeta(layer: TextLayer): string {
		const parts = [`${Math.round(layer.x)}, ${Math.round(layer.y)}`, `${layer.fontSize}px`];
		if (layer.sourceCategory) parts.push(layerCategoryLabel(layer.sourceCategory));
		if (layer.confidence !== undefined) parts.push(formatLayerConfidence(layer.confidence));
		if (layer.sourceProvider) parts.push(formatLayerProvider(layer.sourceProvider));
		if (layer.visible === false) parts.push($_("layersInspector.textMetaHidden"));
		if (layer.locked === true) parts.push($_("layersInspector.textMetaLocked"));
		return parts.join(" / ");
	}

	function getImageAssetUsageCount(asset: ProjectImageAssetSummary): number {
		return imageLayers.filter((layer) => (
			layer.imageId === asset.imageId || layer.imageId === asset.assetId
		)).length;
	}

	function imageLayerRoleFilterLabel(filter: ImageLayerRoleFilter): string {
		if (filter === "all") return $_("layersInspector.roleFilterAll");
		if (filter === "credit") return $_("layersInspector.focusCreditImage");
		return filter === "overlay" ? $_("layersInspector.roleOverlay") : $_("layersInspector.roleReference");
	}

	function creditPlacementLabel(placement: CreditPreset["placement"]): string {
		if (placement === "top") return $_("layersInspector.placementTop");
		if (placement === "bottom") return $_("layersInspector.placementBottom");
		if (placement === "left") return $_("layersInspector.placementLeft");
		return $_("layersInspector.placementRight");
	}

	function creditApplyScopeLabel(scope: CreditApplyScope): string {
		if (scope === "all") return $_("layersInspector.applyScopeAll");
		if (scope === "chapter-edges") return $_("layersInspector.applyScopeChapterEdges");
		return $_("layersInspector.creditScopeCurrentPage");
	}

	function shortCreditTarget(value: string | undefined, fallback: string): string {
		const trimmed = value?.trim();
		if (!trimmed) return fallback;
		return trimmed.length > 28 ? `${trimmed.slice(0, 28)}...` : trimmed;
	}

	function countChapterMatchingTextCredits(text: string): number {
		const pages = projectStore.project?.pages ?? [];
		if (!pages.length) return textLayers.filter((layer) => layer.sourceCategory === "credit" && layer.text === text).length;
		return pages.reduce((total, page) => (
			total + trackTextLayers(page, projectStore.activeTargetLang).filter((layer) => layer.sourceCategory === "credit" && layer.text === text).length
		), 0);
	}

	function countChapterMatchingImageCredits(imageId: string): number {
		const pages = projectStore.project?.pages ?? [];
		if (!pages.length) return imageLayers.filter((layer) => layer.role === "credit" && layer.imageId === imageId).length;
		return pages.reduce((total, page) => (
			total + (page.imageLayers ?? []).filter((layer) => layer.role === "credit" && layer.imageId === imageId).length
		), 0);
	}

	function buildCreditDeleteOptions(): CreditDeleteOption[] {
		const options: CreditDeleteOption[] = [];
		if (selectedCreditLayer || selectedCreditImageLayer) {
			const selectedName = selectedCreditLayer
				? shortCreditTarget(selectedCreditLayer.text || selectedCreditLayer.name, $_("layersInspector.focusCreditText"))
				: shortCreditTarget(selectedCreditImageLayer?.originalName || selectedCreditImageLayer?.name || selectedCreditImageLayer?.imageName, $_("layersInspector.focusCreditImage"));
			options.push({
				value: "selected",
				label: $_("layersInspector.creditDeleteSelectedLabel"),
				detail: $_("layersInspector.creditDeleteSelectedDetail", { values: { name: selectedName } }),
				title: selectedCreditLayer ? $_("layersInspector.creditDeleteSelectedTextTitle") : $_("layersInspector.creditDeleteSelectedImageTitle"),
				confirmDetail: $_("layersInspector.creditDeleteSelectedConfirm", { values: { name: selectedName } }),
				selectedOnly: true,
				allPages: false,
				creditKind: selectedCreditLayer ? "text" : "image",
			});
		}

		if (projectOpen && selectedCreditLayer?.text) {
			const matchCount = countChapterMatchingTextCredits(selectedCreditLayer.text);
			if (matchCount > 0) {
				options.push({
					value: "matching-text-all",
					label: $_("layersInspector.creditDeleteMatchTextLabel"),
					detail: $_("layersInspector.creditDeleteMatchDetail", { values: { target: shortCreditTarget(selectedCreditLayer.text, $_("layersInspector.creditTextThisFallback")), n: matchCount } }),
					title: $_("layersInspector.creditDeleteMatchTextTitle"),
					confirmDetail: $_("layersInspector.creditDeleteMatchTextConfirm", { values: { n: matchCount } }),
					allPages: true,
					creditKind: "text",
					match: { text: selectedCreditLayer.text },
				});
			}
		}

		if (projectOpen && selectedCreditImageLayer?.imageId) {
			const matchCount = countChapterMatchingImageCredits(selectedCreditImageLayer.imageId);
			if (matchCount > 0) {
				options.push({
					value: "matching-image-all",
					label: $_("layersInspector.creditDeleteMatchImageLabel"),
					detail: $_("layersInspector.creditDeleteMatchDetail", { values: { target: shortCreditTarget(selectedCreditImageLayer.originalName || selectedCreditImageLayer.imageName, $_("layersInspector.creditImageThisFallback")), n: matchCount } }),
					title: $_("layersInspector.creditDeleteMatchImageTitle"),
					confirmDetail: $_("layersInspector.creditDeleteMatchImageConfirm", { values: { n: matchCount } }),
					allPages: true,
					creditKind: "image",
					match: { imageId: selectedCreditImageLayer.imageId },
				});
			}
		}

		if (creditLayerCount > 0) {
			options.push({
				value: "current-all",
				label: $_("layersInspector.creditDeleteCurrentAllLabel"),
				detail: $_("layersInspector.creditDeleteCurrentAllDetail", { values: { n: creditLayerCount, text: creditTextLayerCount, image: creditImageLayerCount } }),
				title: $_("layersInspector.creditDeleteCurrentAllTitle"),
				confirmDetail: creditDeleteConfirmDetail(false, "all"),
				allPages: false,
				creditKind: "all",
			});
		}
		if (creditTextLayerCount > 0) {
			options.push({
				value: "current-text",
				label: $_("layersInspector.creditDeleteCurrentTextLabel"),
				detail: $_("layersInspector.creditDeleteCurrentTextDetail", { values: { n: creditTextLayerCount } }),
				title: $_("layersInspector.creditDeleteCurrentTextTitle"),
				confirmDetail: creditDeleteConfirmDetail(false, "text"),
				allPages: false,
				creditKind: "text",
			});
		}
		if (creditImageLayerCount > 0) {
			options.push({
				value: "current-image",
				label: $_("layersInspector.creditDeleteCurrentImageLabel"),
				detail: $_("layersInspector.creditDeleteCurrentImageDetail", { values: { n: creditImageLayerCount } }),
				title: $_("layersInspector.creditDeleteCurrentImageTitle"),
				confirmDetail: creditDeleteConfirmDetail(false, "image"),
				allPages: false,
				creditKind: "image",
			});
		}
		if (projectOpen && chapterCreditLayerCount > 0) {
			options.push({
				value: "chapter-all",
				label: $_("layersInspector.creditDeleteChapterAllLabel"),
				detail: $_("layersInspector.creditDeleteChapterAllDetail", { values: { n: chapterCreditLayerCount, text: chapterCreditTextLayerCount, image: chapterCreditImageLayerCount } }),
				title: $_("layersInspector.creditDeleteChapterAllTitle"),
				confirmDetail: creditDeleteConfirmDetail(true, "all"),
				allPages: true,
				creditKind: "all",
			});
		}
		if (projectOpen && chapterCreditTextLayerCount > 0) {
			options.push({
				value: "chapter-text",
				label: $_("layersInspector.creditDeleteChapterTextLabel"),
				detail: $_("layersInspector.creditDeleteChapterTextDetail", { values: { n: chapterCreditTextLayerCount } }),
				title: $_("layersInspector.creditDeleteChapterTextTitle"),
				confirmDetail: creditDeleteConfirmDetail(true, "text"),
				allPages: true,
				creditKind: "text",
			});
		}
		if (projectOpen && chapterCreditImageLayerCount > 0) {
			options.push({
				value: "chapter-image",
				label: $_("layersInspector.creditDeleteChapterImageLabel"),
				detail: $_("layersInspector.creditDeleteChapterImageDetail", { values: { n: chapterCreditImageLayerCount } }),
				title: $_("layersInspector.creditDeleteChapterImageTitle"),
				confirmDetail: creditDeleteConfirmDetail(true, "image"),
				allPages: true,
				creditKind: "image",
			});
		}
		return options;
	}

	function updateCreditImageMaxWidth(event: Event): void {
		onCreditImageMaxWidthChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateCreditImageRepeatEveryPx(event: Event): void {
		onCreditImageRepeatEveryPxChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateCreditApplyScope(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as CreditApplyScope;
		onCreditApplyScopeChange(projectOpen ? value : "current");
	}

	function setCreditApplyScope(value: CreditApplyScope): void {
		const nextScope = projectOpen ? value : "current";
		if (creditApplyScope === nextScope) return;
		onCreditApplyScopeChange(nextScope);
	}

	function formatAspectRatioDisplayName(name: string): string {
		const displayNames: Record<string, string> = {
			"Fit Width": $_("layersInspector.aspectFitWidth"),
			"1:1 Square": $_("layersInspector.aspectSquare"),
			"2:3 Tall": $_("layersInspector.aspect23Tall"),
			"3:2 Wide": $_("layersInspector.aspect32Wide"),
			"16:9 Wide": $_("layersInspector.aspect169Wide"),
			"9:16 Tall": $_("layersInspector.aspect916Tall"),
		};
		return displayNames[name] ?? name;
	}

	function updateSelectedImageRole(event: Event): void {
		const role = (event.currentTarget as HTMLSelectElement).value as NormalizedImageLayerRole;
		if (!selectedImageLayer || selectedImageLayerIsAiResult || getImageLayerRole(selectedImageLayer) === role) return;
		onSelectedImageLayerChange({ role }, true);
	}

	function updateSelectedImageBlendMode(event: Event): void {
		const blendMode = (event.currentTarget as HTMLSelectElement).value as NormalizedImageLayerBlendMode;
		if (!selectedImageLayer || getImageLayerBlendMode(selectedImageLayer) === blendMode) return;
		onSelectedImageLayerChange({ blendMode }, true);
	}

	function imageLayerBulkScopeLabel(): string {
		if (imageLayerRoleFilter === "all") return $_("layersInspector.bulkScopeAll");
		return $_("layersInspector.bulkScopeFiltered", { values: { role: imageLayerRoleFilterLabel(imageLayerRoleFilter) } });
	}

	function stackItemShortLabel(item: UnifiedLayerStackItem): string {
		return `${item.badge} · ${item.title}`;
	}

	function unifiedLayerStackItemMatchesFilter(item: UnifiedLayerStackItem, filter: UnifiedLayerStackFilter): boolean {
		if (filter === "all") return true;
		if (filter === "credit") return item.isCredit;
		if (filter === "text") return item.kind === "text" && !item.isCredit;
		return item.kind === "image" && !item.isCredit;
	}

	function canApplyVisibleImageLayerBulkAction(action: ImageLayerBulkAction): boolean {
		if (!projectOpen || !hasImage || filteredImageLayers.length === 0) return false;
		if (action === "show-all") return filteredImageLayers.some((layer) => layer.visible === false);
		if (action === "hide-all") return filteredImageLayers.some((layer) => layer.visible !== false);
		if (action === "lock-all") return filteredImageLayers.some((layer) => layer.locked !== true);
		return filteredImageLayers.some((layer) => layer.locked === true);
	}

	function updateSelectedImageName(event: Event, commit = false): void {
		onSelectedImageLayerChange({ name: (event.currentTarget as HTMLInputElement).value.trim() || undefined }, commit);
	}

	function applyVisibleImageLayerBulkAction(action: ImageLayerBulkAction): void {
		if (!filteredImageLayers.length) return;
		const layerIds = imageLayerRoleFilter === "all"
			? undefined
			: filteredImageLayers.map((layer) => layer.id);
		onApplyImageLayerBulkAction(action, layerIds);
	}

	function jumpToPanelSection(sectionId: string): void {
		if (
			focusedLayerToolsCollapsed
			&& ["credit-section", "image-layers-section", "text-layers-section", "effects-section"].includes(sectionId)
		) {
			layerShortcutsExpanded = true;
		}
		if (sectionId === "credit-section") creditsOpen = true;
		if (sectionId === "image-layers-section") imageLayersOpenOverride = true;
		if (sectionId === "text-layers-section") layersOpenOverride = true;
		if (sectionId === "properties-section") propsOpenOverride = true;
		if (sectionId === "effects-section") effectsOpen = true;
		void tick().then(() => {
			document.getElementById(sectionId)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
		});
	}

	function focusLayerControl(controlId: string): void {
		void tick().then(() => {
			const control = document.getElementById(controlId) as (HTMLElement & { select?: () => void }) | null;
			control?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
			control?.focus();
			control?.select?.();
		});
	}

	function focusSelectedImageControl(controlId: string): void {
		selectedImageAdvancedOpenOverride = true;
		propsOpenOverride = true;
		focusLayerControl(controlId);
	}

	function openSelectedImageLibrary(): void {
		assetLibraryOpenOverride = true;
		jumpToPanelSection("image-layers-section");
	}

	function scrollSelectedFocusIntoView(): void {
		const card = document.querySelector(".selection-focus-card.has-selection") as HTMLElement | null;
		let parent = card?.parentElement;
		while (parent) {
			if (parent.scrollHeight > parent.clientHeight) {
				parent.scrollTo?.({ top: 0, behavior: "smooth" });
				break;
			}
			parent = parent.parentElement;
		}
		card?.scrollIntoView?.({ block: "start", behavior: "smooth" });
	}

	function toggleLayerShortcuts(): void {
		layerShortcutsExpanded = !layerShortcutsExpanded;
		if (focusedLayerToolsCollapsed && !layerShortcutsExpanded) {
			void tick().then(scrollSelectedFocusIntoView);
		}
	}

	function toggleSelectedCreditAdmin(): void {
		selectedCreditAdminOpen = !selectedCreditAdminOpen;
	}

	function openSelectionProperties(): void {
		propsOpenOverride = true;
	}

	function unifiedStackRowId(item: UnifiedLayerStackItem): string {
		return `unified-row-${item.kind}-${item.id}`;
	}

	let realUnifiedStackOpen = $derived(
		unifiedStackOpen ?? (selectedEditableLayerActive && !compactSelectedContextForCredit)
	);

	function selectImageLayerForProperties(layerId: string): void {
		propsOpenOverride = true;
		onSelectImageLayer(layerId);
	}

	function selectTextLayerForProperties(layerId: string): void {
		propsOpenOverride = true;
		onSelectLayer(layerId);
	}

	function updateSelectedImageNumber(
		event: Event,
		key: "x" | "y" | "w" | "h" | "rotation" | "opacity",
		commit = false,
	): void {
		const rawValue = Number((event.currentTarget as HTMLInputElement).value);
		if (!Number.isFinite(rawValue)) return;
		const emitImageLayerChange = (updates: Partial<Pick<ImageLayer, "x" | "y" | "w" | "h" | "rotation" | "opacity">>): void => {
			if (commit) {
				onSelectedImageLayerChange(updates, true);
				return;
			}
			onSelectedImageLayerChange(updates);
		};
		if (key === "opacity") {
			emitImageLayerChange({ opacity: Math.max(0, Math.min(1, rawValue / 100)) });
			return;
		}
		if (key === "w" || key === "h") {
			const updates: Partial<Pick<ImageLayer, "x" | "y" | "w" | "h" | "rotation" | "opacity">> = {};
			updates[key] = Math.max(1, Math.round(rawValue));
			emitImageLayerChange(updates);
			return;
		}
		const updates: Partial<Pick<ImageLayer, "x" | "y" | "w" | "h" | "rotation" | "opacity">> = {};
		updates[key] = Math.round(rawValue);
		emitImageLayerChange(updates);
	}

	$effect(() => {
		if (focusToken <= 0 || !focusLayerId) return;
		const layerId = focusLayerId;
		// Opening and focusing must happen after this component mounts from a mode switch.
		void tick().then(() => {
			layersOpenOverride = true;
			propsOpenOverride = true;
			void tick().then(() => {
				if (selectedLayer?.id === layerId) {
					const input = document.getElementById(controlIds.text) as HTMLInputElement | null;
					input?.focus();
					input?.select();
				}
			});
		});
	});

	$effect(() => {
		if (imageFocusToken <= 0 || !imageFocusLayerId) return;
		const layerId = imageFocusLayerId;
		if (!imageLayers.some((layer) => layer.id === layerId)) return;
		if (selectedImageLayer?.id !== layerId) {
			editorStore.selectImageLayer(layerId);
		}
		void tick().then(() => {
			imageLayersOpenOverride = selectedImageLayerIsAiResult ? false : true;
			propsOpenOverride = true;
			if (selectedImageLayer?.id === layerId) {
				imageLayerRoleFilter = "all";
			}
			void tick().then(() => {
				if (selectedImageLayer?.id === layerId) {
					if (selectedImageLayerIsAiResult) {
						const card = document.getElementById(controlIds.aiLayerFocus) as HTMLElement | null;
						card?.scrollIntoView({ block: "start" });
						card?.focus({ preventScroll: true });
						return;
					}
					const input = document.getElementById(controlIds.imageOpacity) as HTMLInputElement | null;
					input?.focus();
					input?.select();
				}
			});
		});
	});

	$effect(() => {
		if (!selectedEditableFocusKey || selectedEditableFocusKey === lastSelectedFocusScrollKey) return;
		lastSelectedFocusScrollKey = selectedEditableFocusKey;
		selectedImageAdvancedOpenOverride = selectedImageLayer && !selectedImageLayerIsAiResult ? false : null;
		selectedTextDetailsOpen = false;
		selectedTextPresetSaveOpen = false;
		selectedTextBoxToolsOpen = false;
		selectedTextStyleToolsOpen = false;
		selectedCreditAdminOpen = false;
		void tick().then(() => {
			scrollSelectedFocusIntoView();
		});
	});

	$effect(() => {
		if (editorUiStore.creditToolsFocusToken <= 0 || editorUiStore.creditToolsFocusToken === lastCreditToolsFocusToken) return;
		lastCreditToolsFocusToken = editorUiStore.creditToolsFocusToken;
		creditsOpen = true;
		selectedCreditAdminOpen = true;
		layerShortcutsExpanded = true;
		void tick().then(() => {
			jumpToPanelSection("credit-section");
			const creditTextControl = document.getElementById(controlIds.creditText) as HTMLTextAreaElement | null;
			creditTextControl?.focus({ preventScroll: true });
		});
	});

	$effect(() => {
		if (!selectedUnifiedStackItem || !realUnifiedStackOpen) return;
		const rowId = unifiedStackRowId(selectedUnifiedStackItem);
		void tick().then(() => {
			const row = document.getElementById(rowId);
			row?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		});
	});
</script>

<div
	class="layers-inspector"
	class:ai-result-focus={selectedImageLayerIsAiResult}
	class:ai-placement-focus={Boolean(activeAiPlacementMarker)}
	class:selected-editable-focus={selectedObjectOwnerActive}
	class:credit-workflow-focus={compactSelectedContextForCredit}
>
{#if !activeAiPlacementMarker && (!workspaceEntryLayerStartActive || selectedLayer || selectedImageLayer)}
<div
	class="selection-focus-card"
	class:has-selection={Boolean(selectedLayer || selectedImageLayer)}
	aria-label={selectedLayer || selectedImageLayer ? $_("layersInspector.selectionEditingLayer") : undefined}
>
	<div class="selection-focus-copy">
		<small>{selectedLayer || selectedImageLayer ? $_("layersInspector.selectionEditingNow") : propertiesScopeLabel}</small>
		<strong>{#if selectedLayer || selectedImageLayer}<span>{$_("layersInspector.selectionEditingPrefix")} </span>{/if}{focusCardTitle}</strong>
		<span>
			{#if selectedLayer || selectedImageLayer}
				<b>{propertiesScopeLabel}</b>
				<span aria-hidden="true"> / </span>
			{/if}
			{focusCardMeta}
		</span>
	</div>
	{#if selectedLayer || selectedImageLayer}
	{#if selectedUnifiedStackItem}
		<div
			class="selection-focus-actions"
			class:credit-delete-available={Boolean(selectedCreditLayer || selectedCreditImageLayer)}
			role="group"
			aria-label={$_("layersInspector.selectedStackOrderAria")}
		>
			<span class="selection-stack-pill">{selectedUnifiedStackPosition}</span>
			{#if selectedEditableLayerFocusActive || selectedCreditAlreadyEditing}
				<span class="selection-edit-pill">{$_("layersInspector.editingBadge")}</span>
			{:else}
				<button
					type="button"
					class="selection-edit-button"
					onclick={openSelectionProperties}
					aria-label={selectionFocusEditAria}
					title={selectionFocusEditAria}
				>{selectionFocusEditLabel}</button>
			{/if}
			<button
				type="button"
				onclick={() => toggleUnifiedLayerVisibility(selectedUnifiedStackItem)}
				aria-label={selectedUnifiedStackItem.visible ? $_("layersInspector.hideSelectedLayer") : $_("layersInspector.showSelectedLayer")}
				title={selectedUnifiedStackItem.visible ? $_("layersInspector.hideSelectedLayer") : $_("layersInspector.showSelectedLayer")}
			>{selectedUnifiedStackItem.visible ? $_("layersInspector.actionHide") : $_("layersInspector.actionShow")}</button>
			<button
				type="button"
				onclick={() => toggleUnifiedLayerLock(selectedUnifiedStackItem)}
				aria-label={selectedUnifiedStackItem.locked ? $_("layersInspector.unlockSelectedLayer") : $_("layersInspector.lockSelectedLayer")}
				title={selectedUnifiedStackItem.locked ? $_("layersInspector.unlockSelectedLayer") : $_("layersInspector.lockSelectedLayer")}
			>{selectedUnifiedStackItem.locked ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
			{#if selectedCanMoveUp}
				<button
					type="button"
					onclick={() => moveSelectedUnifiedLayer(1)}
					aria-label={$_("layersInspector.moveSelectedUp")}
					title={$_("layersInspector.moveSelectedUp")}
				>{$_("layersInspector.actionUp")}</button>
			{/if}
			{#if selectedCanMoveDown}
				<button
					type="button"
					onclick={() => moveSelectedUnifiedLayer(-1)}
					aria-label={$_("layersInspector.moveSelectedDown")}
					title={$_("layersInspector.moveSelectedDown")}
				>{$_("layersInspector.actionDown")}</button>
			{/if}
			{#if selectedCreditLayer || selectedCreditImageLayer}
				<button
					type="button"
					class="selection-credit-delete-button"
					onclick={requestDeleteSelectedCreditLayer}
					aria-label={$_("layersInspector.deleteSelectedCredit")}
					title={$_("layersInspector.deleteSelectedCredit")}
				>{$_("layersInspector.actionDelete")}</button>
			{/if}
		</div>
	{:else}
		<button
			type="button"
			class="panel-btn selection-focus-action"
			onclick={openSelectionProperties}
			aria-label={selectionFocusEditAria}
		>
			{selectionFocusEditLabel}
		</button>
	{/if}
		{#if selectedUnifiedStackItem && !compactSelectedContextForCredit}
			<div class="selected-stack-context" role="status" aria-label={$_("layersInspector.selectedStackContextAria")}>
				<span class="selected-stack-context-item muted" class:edge-empty={!selectedStackAboveItem}>
					<small>{$_("layersInspector.stackAbove")}</small>
					<strong>{selectedStackAboveLabel}</strong>
					<span>{selectedStackAboveMeta}</span>
				</span>
				<span class="selected-stack-context-item current">
					<small>{$_("layersInspector.editingBadge")}</small>
					<strong>{selectedStackCurrentLabel}</strong>
					<span>{selectedStackCurrentMeta}</span>
				</span>
				<span class="selected-stack-context-item muted" class:edge-empty={!selectedStackBelowItem}>
					<small>{$_("layersInspector.stackBelow")}</small>
					<strong>{selectedStackBelowLabel}</strong>
					<span>{selectedStackBelowMeta}</span>
				</span>
			</div>
		{/if}
	{:else if selectedUnifiedStackItem}
		<span class="selection-focus-badge">{$_("layersInspector.badgeOriginal")}</span>
	{:else if selectedEditableLayerFocusActive}
		<span class="selection-focus-badge">{$_("layersInspector.editingBadge")}</span>
	{:else if hasImage}
		<span class="selection-focus-badge">{$_("layersInspector.badgeOriginal")}</span>
	{/if}
</div>
{#if selectedTextNeedsFit}
	<div class="selected-text-fit-alert" role="status" aria-label={$_("layersInspector.textOverflowAlertAria")}>
		<div>
			<strong>{selectedTextFitAtMinimum ? $_("layersInspector.textBoxTooSmall") : $_("layersInspector.textMayOverflow")}</strong>
			<small>{selectedTextFitDetail}</small>
			</div>
			{#if selectedTextFitAtMinimum}
				{#if selectedTextLayerLocked}
					<span class="selected-text-fit-state passive">{$_("layersInspector.unlockBeforeGrowBox")}</span>
				{:else}
					<button
						type="button"
						class="selected-text-fit-state"
						onclick={expandSelectedTextBoxToFit}
						aria-label={$_("layersInspector.growSelectedTextBoxAria")}
					>
						{$_("layersInspector.growBox")}
					</button>
				{/if}
			{:else}
				<div class="selected-text-fit-actions">
					{#if selectedTextLayerLocked}
						<span class="selected-text-fit-state passive">{$_("layersInspector.unlockBeforeFitText")}</span>
					{:else}
						<button
							type="button"
							class="panel-btn panel-btn-primary"
							onclick={onFitSelectedText}
							aria-label={$_("layersInspector.fitSelectedTextAria")}
						>
							{$_("layersInspector.shrinkToFit")}
						</button>
						{#if selectedTextCanGrowBox}
							<button
								type="button"
								class="selected-text-fit-state"
								onclick={expandSelectedTextBoxToFit}
								aria-label={$_("layersInspector.growSelectedTextBoxAria")}
							>
								{$_("layersInspector.growBox")}
							</button>
						{/if}
					{/if}
				</div>
			{/if}
	</div>
{/if}
{#if selectedImageCleanBrushActive}
	<div class="selected-image-brush-strip" aria-label={$_("layersInspector.brushEditingSelectedAria")}>
		<span>{$_("layersInspector.cleanBrushOn")}</span>
		<strong>{brushTargetTitle}</strong>
		<small>{selectedImageBrushScopeCopy}</small>
		<em>{selectedImageBrushRestoreStatus}</em>
		<div class="selected-image-brush-owner" aria-label={$_("layersInspector.brushOwnerAria")}>
			<span>{$_("layersInspector.brushOwnerHint")}</span>
			<strong>{editorStore.brushSize}px / {editorStore.brushOpacity}% / {editorStore.brushMode === "restore" ? $_("layersInspector.brushModeRestore") : $_("layersInspector.brushModeErase")}</strong>
		</div>
	</div>
{/if}
{/if}

{#if showNextLayerActionCard}
	<div class="next-layer-action-card" class:library-entry-start={workspaceEntryLayerStartActive} aria-label={$_("layersInspector.nextLayerActionAria")}>
		<div class="next-layer-copy">
			<small>{workspaceEntryLayerStartActive ? $_("layersInspector.nextLayerStartLibrary") : hasImage ? $_("layersInspector.nextLayerSourceReady") : $_("layersInspector.nextLayerNoPageImage")}</small>
			<strong>{workspaceEntryLayerStartActive ? $_("layersInspector.nextLayerPickFirst") : nextLayerActionTitle}</strong>
			<span>{workspaceEntryLayerStartActive ? $_("layersInspector.nextLayerLibraryDetail", { values: { reason: workspaceEntryLayerReason } }) : nextLayerActionDetail}</span>
		</div>
		<div class="next-layer-actions">
			{#if projectOpen && hasImage}
				<button
					type="button"
					class="panel-btn panel-btn-primary"
					onclick={onStartTextPlacement}
					aria-label={$_("layersInspector.startTextAria")}
				>
					{$_("layersInspector.placeText")}
				</button>
				<button
					type="button"
					class="panel-btn"
					onclick={onAddImageLayer}
					aria-label={$_("layersInspector.addImageFromNextAria")}
				>
					{$_("layersInspector.addExtraImage")}
				</button>
				<button
					type="button"
					class="panel-btn"
					onclick={() => jumpToPanelSection("credit-section")}
					aria-label={$_("layersInspector.openCreditFromNextAria")}
				>
					{$_("layersInspector.badgeCredit")}
				</button>
			{:else}
				<span class="next-layer-action-state">
					{projectOpen ? $_("layersInspector.openPageBeforeTools") : $_("layersInspector.openProjectBeforeAddLayer")}
				</span>
			{/if}
		</div>
	</div>
{/if}

{#if !selectedImageLayerIsAiResult && !activeAiPlacementMarker && !workspaceEntryLayerStartActive && !selectedEditableLayerFocusActive && !selectedEditableLayerActive}
	<div class="layer-stack-overview ws-panel" role="region" aria-label={$_("layersInspector.pageLayerStructureAria")}>
		<div class="layer-stack-row base">
			<span class="layer-stack-icon" aria-hidden="true">▣</span>
			<div class="layer-stack-copy">
				<strong>{$_("layersInspector.scopeBaseImage")}</strong>
				<small>{hasImage ? $_("layersInspector.baseImageStackMeta", { values: { w: canvasDimensions.width, h: canvasDimensions.height } }) : $_("layersInspector.focusNoPageImage")}</small>
			</div>
			<span class="layer-stack-pill">{hasImage ? $_("layersInspector.textMetaLocked") : $_("layersInspector.pillEmpty")}</span>
		</div>
		<div class="layer-stack-row editable" class:empty={editableLayerCount === 0}>
			<span class="layer-stack-icon" aria-hidden="true">+</span>
			<div class="layer-stack-copy">
				<strong>{editableLayerCount > 0 ? $_("layersInspector.stackListEditLayers", { values: { n: editableLayerCount } }) : $_("layersInspector.noEditLayers")}</strong>
				<small>{editableStackSummary}</small>
			</div>
			<span class="layer-stack-pill">{editableLayerCount}</span>
		</div>
	</div>
{/if}

{#if showUnifiedLayerStack}
	<div
		class="unified-layer-stack-label-scope"
		style={`--unified-stack-toggle-closed: "${$_("layersInspector.toggleOpen")}"; --unified-stack-toggle-open: "${$_("layersInspector.toggleCollapse")}";`}
	>
	<LayerStack
		filteredItems={filteredUnifiedLayerStackItems}
		totalItemCount={unifiedLayerStackItems.length}
		filterCounts={unifiedLayerStackFilterCounts}
		filter={unifiedLayerStackFilter}
		open={realUnifiedStackOpen}
		showFilter={showUnifiedLayerStackFilter}
		selectedItemIncludedByFilter={selectedUnifiedStackItemIncludedByFilter}
		{selectedEditableLayerActive}
		summaryTitle={selectedUnifiedStackSummary || unifiedLayerStackListSummary}
		summaryHint={unifiedStackSummaryHint}
		{hasImage}
		{canvasDimensions}
		rowId={unifiedStackRowId}
		onFilterChange={(next) => unifiedLayerStackFilter = next}
		onToggleOpen={(nextOpen) => unifiedStackOpen = nextOpen}
		onSelectItem={selectUnifiedLayerStackItem}
		onToggleItemVisibility={toggleUnifiedLayerVisibility}
		onToggleItemLock={toggleUnifiedLayerLock}
		onMoveItem={moveUnifiedLayer}
		onDragStart={startUnifiedLayerDrag}
		onDragOver={allowLayerDrop}
		onDrop={dropUnifiedLayer}
	/>
	</div>
{/if}

{#if !selectedImageLayerIsAiResult && !activeAiPlacementMarker}
	{#if focusedLayerToolsCollapsed}
		<div class="layer-tools-drawer">
			<button
				type="button"
				class="layer-tools-toggle"
				aria-expanded={layerShortcutsExpanded}
				aria-controls="credit-section image-layers-section text-layers-section properties-section effects-section"
				onclick={toggleLayerShortcuts}
			>
				<span>{layerToolsToggleLabel}</span>
				<strong>{layerShortcutsExpanded ? $_("layersInspector.toggleCollapse") : $_("layersInspector.toggleExpand")}</strong>
			</button>
		</div>
	{/if}
	{#if !focusedLayerToolsCollapsed}
		<div id="layer-shortcut-tools" class="layer-jumpbar" aria-label={$_("layersInspector.layerShortcutsAria")}>
			<button type="button" aria-label={$_("layersInspector.jumpToTextBox", { values: { n: textLayers.length } })} title={$_("layersInspector.stackMetaTextBox")} onclick={() => jumpToPanelSection("text-layers-section")}>
				<span>{$_("layersInspector.badgeText")}</span>
				<strong>{textLayers.length}</strong>
			</button>
			<button type="button" aria-label={$_("layersInspector.jumpToExtraImage", { values: { n: imageLayers.length } })} title={$_("layersInspector.stackMetaImage")} onclick={() => jumpToPanelSection("image-layers-section")}>
				<span>{$_("layersInspector.stackMetaImage")}</span>
				<strong>{imageLayers.length}</strong>
			</button>
			<button type="button" aria-label={$_("layersInspector.jumpToCredit", { values: { n: creditLayerCount } })} title={$_("layersInspector.badgeCredit")} onclick={() => jumpToPanelSection("credit-section")}>
				<span>{$_("layersInspector.badgeCredit")}</span>
				<strong>{creditLayerCount}</strong>
			</button>
			<button type="button" aria-label={$_("layersInspector.jumpToProperties", { values: { what: selectedLayer || selectedImageLayer ? $_("layersInspector.propsSelectedLayer") : $_("layersInspector.propsPage") } })} title={$_("layersInspector.titleProperties")} onclick={() => jumpToPanelSection("properties-section")}>
				<span>{$_("layersInspector.labelSettings")}</span>
				<strong>{selectedLayer || selectedImageLayer ? $_("layersInspector.strongSelected") : $_("layersInspector.propsPage")}</strong>
			</button>
			<button type="button" aria-label={$_("layersInspector.jumpToEffects", { values: { what: selectedLayer ? $_("layersInspector.effectsReady") : $_("layersInspector.effectsNoText") } })} title={$_("layersInspector.titleEffects")} onclick={() => jumpToPanelSection("effects-section")}>
				<span>{$_("layersInspector.titleEffects")}</span>
				<strong>{selectedLayer ? $_("layersInspector.badgeText") : "-"}</strong>
			</button>
		</div>
	{/if}
{/if}

{#if !activeAiPlacementMarker && (!focusedLayerToolsCollapsed || layerShortcutsExpanded)}
<div class="panel-section" id="credit-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel($_("layersInspector.badgeCredit"), creditSectionOpen)}
		aria-expanded={creditSectionOpen}
		onclick={() => creditsOpen = !creditSectionOpen}
	>
		<span class="layers-section-copy">
			<span>{$_("layersInspector.badgeCredit")}</span>
			<small>{$_("layersInspector.creditSectionSub")}</small>
		</span>
		<span class="layers-section-meter">{$_("layersInspector.creditMeterOnPage", { values: { n: creditLayerCount } })}</span>
		<span class="layers-section-chevron" class:open={creditSectionOpen} aria-hidden="true"></span>
	</button>
	{#if creditSectionOpen}
		<div class="panel-section-body flex flex-col gap-2">
			{#if hasSelectedCreditLayer}
				<div class="selected-credit-edit-strip" aria-label={$_("layersInspector.selectedCreditEditAria")}>
					<div>
						<span>{selectedCreditDirectKind}</span>
						<strong>{selectedCreditDirectTitle}</strong>
						<small>{selectedCreditDirectMeta}</small>
					</div>
					<button
						type="button"
						class="credit-admin-toggle"
						aria-expanded={selectedCreditAdminOpen}
						onclick={toggleSelectedCreditAdmin}
					>
						{selectedCreditAdminOpen ? $_("layersInspector.hideOtherCreditWork") : $_("layersInspector.addManageOtherCredit")}
					</button>
				</div>
			{/if}
			{#if selectedCreditAdminControlsVisible}
			<div class="credit-scope-switch" aria-label={$_("layersInspector.creditScopeQuickAria")}>
				<button
					type="button"
					class:active={creditApplyScope === "current"}
					aria-pressed={creditApplyScope === "current"}
					onclick={() => setCreditApplyScope("current")}
				>
					<span>{$_("layersInspector.thisPage")}</span>
					<small>{$_("layersInspector.dragTuneInstantly")}</small>
				</button>
				{#if projectOpen}
					<button
						type="button"
						class:active={creditApplyScope === "all"}
						aria-pressed={creditApplyScope === "all"}
						onclick={() => setCreditApplyScope("all")}
					>
						<span>{$_("layersInspector.applyScopeAll")}</span>
						<small>{$_("layersInspector.goodForChapterCredit")}</small>
					</button>
					<button
						type="button"
						class:active={creditApplyScope === "chapter-edges"}
						aria-pressed={creditApplyScope === "chapter-edges"}
						onclick={() => setCreditApplyScope("chapter-edges")}
					>
						<span>{$_("layersInspector.headTail")}</span>
						<small>{$_("layersInspector.firstLastPage")}</small>
					</button>
				{:else}
					<span class="credit-action-hint">{$_("layersInspector.openProjectForAllPages")}</span>
				{/if}
			</div>
			<div>
				<label class="panel-label" for={controlIds.creditPreset}>{$_("layersInspector.creditPlacementLabel2")}</label>
				<select
					id={controlIds.creditPreset}
					class="panel-select"
					value={selectedCreditPresetId}
					onchange={updateCreditPreset}
				>
					{#each creditPresets as preset (preset.id)}
						<option value={preset.id}>{preset.name}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="panel-label" for={controlIds.creditText}>{$_("layersInspector.badgeText")}</label>
				<textarea
					id={controlIds.creditText}
					class="panel-input credit-textarea"
					rows="4"
					value={creditText}
					oninput={updateCreditText}
				></textarea>
			</div>
			<div class="credit-action-row">
				{#if canCreateCreditText}
					<button
						class="panel-btn panel-btn-primary"
						onclick={onAddCredit}
						aria-label={$_("layersInspector.createCreditTextAria")}
					>
						{$_("layersInspector.createCreditTextAria")}
					</button>
				{:else}
					<span class="credit-action-hint" aria-label={$_("layersInspector.createCreditTextStatusAria")}>{$_("layersInspector.noCreditTextYet")}</span>
				{/if}
				{#if projectOpen && hasImage}
					<button
						class="panel-btn panel-btn-secondary credit-image-import-btn"
						onclick={onAddCreditImage}
						aria-label={$_("layersInspector.importCreditImageAria")}
					>
						{$_("layersInspector.importCreditImageAria")}
					</button>
				{:else}
					<span class="credit-action-hint" aria-label={$_("layersInspector.importCreditImageStatusAria")}>
						{projectOpen ? $_("layersInspector.openPageBeforeImportCredit") : $_("layersInspector.openProjectBeforeImportCredit")}
					</span>
				{/if}
			</div>
			<details class="credit-help-drawer">
				<summary>{$_("layersInspector.creditSteps")}</summary>
				<div class="credit-workflow-strip">
					<div>
						<span>{$_("layersInspector.creditStep1")}</span>
						<strong>{$_("layersInspector.creditStep1Detail")}</strong>
					</div>
					<div>
						<span>{$_("layersInspector.creditStep2")}</span>
						<strong>{creditScopeSummary} / {creditRepeatSummary}</strong>
					</div>
					<div>
						<span>{$_("layersInspector.creditStep3")}</span>
						<strong>{creditDeleteSummary}</strong>
					</div>
				</div>
			</details>
			<div class="credit-scope-card" aria-label={$_("layersInspector.creditPlacementSummaryAria")}>
				<div>
					<span>{$_("layersInspector.labelPlacement")}</span>
					<strong>{creditPlacementSummary}</strong>
				</div>
				<div>
					<span>{$_("layersInspector.labelScope")}</span>
					<strong>{creditScopeSummary}</strong>
				</div>
				<div>
					<span>{$_("layersInspector.labelRepeatEveryPx")}</span>
					<strong>{$_("layersInspector.creditMaxWidthRepeat", { values: { n: creditImageMaxWidth, repeat: creditRepeatSummary } })}</strong>
				</div>
			</div>
			<div class="credit-workflow-note">
				<span>{$_("layersInspector.dragCreditAfterCreate")}</span>
				<small>{$_("layersInspector.creditLayerNote")}</small>
			</div>
			<div class="credit-delete-quick-card" aria-label={$_("layersInspector.creditDeleteScopeAria")}>
				<div class="credit-delete-quick-copy">
					<span>{$_("layersInspector.labelDelete")}</span>
					<strong>{creditDeleteSummary}</strong>
				</div>
				{#if activeCreditDeleteOption}
					<div class="credit-delete-scope-control">
						<label class="panel-label" for={controlIds.creditDeleteScope}>{$_("layersInspector.labelDeleteScope")}</label>
						<select
							id={controlIds.creditDeleteScope}
							class="panel-select"
							value={activeCreditDeleteOption.value}
							onchange={updateCreditDeleteScope}
							aria-label={$_("layersInspector.chooseDeleteScopeAria")}
						>
							{#each creditDeleteOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
						<button
							class="panel-btn danger-soft"
							onclick={requestDeleteCreditScope}
							aria-label={$_("layersInspector.deleteCreditByScopeAria")}
						>
							{$_("layersInspector.labelDelete")}
						</button>
					</div>
					<span class="credit-delete-scope-detail">{activeCreditDeleteOption.detail}</span>
				{:else}
					<span class="credit-action-hint">{projectOpen ? $_("layersInspector.noCreditToDelete") : $_("layersInspector.openProjectBeforeDeleteAll")}</span>
				{/if}
			</div>
			<details class="credit-advanced-details">
				<summary>
					<span>{$_("layersInspector.creditAdvancedSettings")}</span>
					<strong>{$_("layersInspector.advCreditWidthRepeat", { values: { n: creditImageMaxWidth, repeat: creditRepeatSummary } })}</strong>
				</summary>
				<div class="credit-image-grid" aria-label={$_("layersInspector.creditImageSettingsAria")}>
					<label>
						<span class="panel-label">{$_("layersInspector.labelPutCreditAt")}</span>
						<select
							class="panel-select"
							value={creditApplyScope}
							onchange={updateCreditApplyScope}
							aria-label={$_("layersInspector.chooseCreditScopeAria")}
						>
							<option value="current">{$_("layersInspector.creditScopeCurrentPage")}</option>
							{#if projectOpen}
								<option value="all">{$_("layersInspector.applyScopeAll")}</option>
								<option value="chapter-edges">{$_("layersInspector.applyScopeChapterEdges")}</option>
							{/if}
						</select>
					</label>
					<label>
						<span class="panel-label">{$_("layersInspector.labelCreditMaxWidth")}</span>
						<input
							class="panel-input"
							type="number"
							min="16"
							max="4096"
							step="1"
							value={creditImageMaxWidth}
							oninput={updateCreditImageMaxWidth}
							onchange={updateCreditImageMaxWidth}
							aria-label={$_("layersInspector.tuneCreditWidthAria")}
						/>
					</label>
					<label>
						<span class="panel-label">{$_("layersInspector.labelRepeatCreditPx")}</span>
						<input
							class="panel-input"
							type="number"
							min="0"
							max="4096"
							step="1"
							value={creditImageRepeatEveryPx}
							oninput={updateCreditImageRepeatEveryPx}
							onchange={updateCreditImageRepeatEveryPx}
							aria-label={$_("layersInspector.tuneRepeatAria")}
						/>
					</label>
					<label>
						<span class="panel-label">{$_("layersInspector.labelEdgeOffset")}</span>
						<input
							id={controlIds.creditOffset}
							class="panel-input"
							type="number"
							min="0"
							max="2048"
							step="1"
							value={creditOffset}
							oninput={updateCreditOffset}
							onchange={updateCreditOffset}
						/>
					</label>
				</div>
				<p class="credit-helper">
					{$_("layersInspector.repeatPxNote")}
				</p>
				<div class="preset-save-row">
					<input
						id={controlIds.creditPresetName}
						class="panel-input preset-name-input"
						type="text"
						placeholder={$_("layersInspector.creditPresetNamePlaceholder")}
						value={creditPresetName}
						oninput={updateCreditPresetName}
					/>
					{#if canSaveCreditPreset}
						<button
							class="panel-btn preset-save-btn"
							onclick={onSaveCreditPreset}
							aria-label={$_("layersInspector.saveCreditPresetAria")}
						>
							{$_("layersInspector.actionSave")}
						</button>
					{:else}
						<span class="preset-save-note" aria-label={$_("layersInspector.saveCreditPresetStatusAria")}>{creditPresetSaveHint}</span>
					{/if}
				</div>
			</details>
			<details class="credit-advanced-details danger">
				<summary>
					<span>{$_("layersInspector.creditDeleteWarnTitle")}</span>
					<strong>{creditDeleteSummary}</strong>
				</summary>
				<p class="credit-helper danger-helper">
					{$_("layersInspector.creditDeleteWarnBody")}
				</p>
			</details>
			{/if}
			</div>
		{/if}
</div>

<div class="panel-section" id="image-layers-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel($_("layersInspector.stackMetaImage"), imageLayersOpen)}
		aria-expanded={imageLayersOpen}
		onclick={() => imageLayersOpenOverride = !imageLayersOpen}
	>
		<span class="layers-section-copy">
			<span>{$_("layersInspector.stackMetaImage")}</span>
			<small>{imageLayers.length} {$_("layersInspector.imageLayersSub")}</small>
		</span>
		<span class:attention={Boolean(selectedImageLayer)} class="layers-section-meter">
			{selectedImageLayer ? $_("layersInspector.imageLayersSelected") : imageLayerRoleFilterLabel(imageLayerRoleFilter)}
		</span>
		<span class="layers-section-chevron" class:open={imageLayersOpen} aria-hidden="true"></span>
			</button>
	{#if imageLayersOpen}
		<div class="panel-section-body">
			<div class="layer-panel-toolbar image-layer-toolbar">
				{#if projectOpen && hasImage}
					<button
						class="panel-btn panel-btn-primary layer-place-btn"
						onclick={onAddImageLayer}
						aria-label={$_("layersInspector.addImageFromPanelAria")}
					>
						{$_("layersInspector.addExtraImage")}
					</button>
				{:else}
					<span class="layer-toolbar-hint action-unavailable">
						{hasImage ? $_("layersInspector.openChapterToAddSavedImage") : $_("layersInspector.openPageBeforeAddImage")}
					</span>
				{/if}
				{#if projectOpen && hasImage}
					<span class="layer-toolbar-hint">{$_("layersInspector.imageToolbarHint")}</span>
				{/if}
			</div>
			{#snippet imageLayerRoleAndBulkRow()}
				{#if imageLayers.length > 0 && !selectedImageLayerIsAiResult && !selectedImageReplacementMode}
					<div class="image-layer-role-filter" aria-label={$_("layersInspector.imageRoleFilterAria")}>
						<button
							type="button"
							class:active={imageLayerRoleFilter === "all"}
							aria-pressed={imageLayerRoleFilter === "all"}
							aria-label={$_("layersInspector.filterAllImagesAria")}
							onclick={() => setImageLayerRoleFilter("all")}
						>{$_("layersInspector.roleFilterAll")} {imageLayerRoleCounts.all}</button>
						{#if imageLayerRoleCounts.reference > 0 || imageLayerRoleFilter === "reference"}
							<button
								type="button"
								class:active={imageLayerRoleFilter === "reference"}
								aria-pressed={imageLayerRoleFilter === "reference"}
								aria-label={$_("layersInspector.filterRefImagesAria")}
								onclick={() => setImageLayerRoleFilter("reference")}
							>{$_("layersInspector.filterReference")} {imageLayerRoleCounts.reference}</button>
						{/if}
						{#if imageLayerRoleCounts.overlay > 0 || imageLayerRoleFilter === "overlay"}
							<button
								type="button"
								class:active={imageLayerRoleFilter === "overlay"}
								aria-pressed={imageLayerRoleFilter === "overlay"}
								aria-label={$_("layersInspector.filterOverlayImagesAria")}
								onclick={() => setImageLayerRoleFilter("overlay")}
							>{$_("layersInspector.filterOverlay")} {imageLayerRoleCounts.overlay}</button>
						{/if}
						<button
							type="button"
							class:active={imageLayerRoleFilter === "credit"}
							aria-pressed={imageLayerRoleFilter === "credit"}
							aria-label={$_("layersInspector.filterCreditImagesAria")}
							onclick={() => setImageLayerRoleFilter("credit")}
						>{$_("layersInspector.credit")} {imageLayerRoleCounts.credit}</button>
					</div>
					<BulkLayerActions
						scopeLabel={imageLayerBulkScopeLabel()}
						canShowAll={canApplyVisibleImageLayerBulkAction("show-all")}
						canHideAll={canApplyVisibleImageLayerBulkAction("hide-all")}
						canLockAll={canApplyVisibleImageLayerBulkAction("lock-all")}
						canUnlockAll={canApplyVisibleImageLayerBulkAction("unlock-all")}
						onApply={applyVisibleImageLayerBulkAction}
					/>
				{/if}
			{/snippet}
			<AssetBrowser
				drawerOpen={assetLibraryOpen}
				betweenDrawerAndList={imageLayerRoleAndBulkRow}
				{projectId}
				{imageAssets}
				{filteredImageAssets}
				{visibleImageAssets}
				{selectedImageAsset}
				{selectedImageAssetId}
				{selectedImageAssetVisible}
				{imageAssetsLoading}
				{imageAssetView}
				{imageAssetQuery}
				{imageAssetSizeBand}
				{imageAssetSourceFilter}
				{imageAssetStorageQuota}
				{deletingImageAssetId}
				{canDeleteImageAssets}
				{imageAssetBrowserExpanded}
				{hiddenImageAssetCount}
				compactLimit={ASSET_BROWSER_COMPACT_LIMIT}
				assetFilterInputId={controlIds.imageAssetFilter}
				{hasImage}
				{canFilterImageAssets}
				{canSelectImageAsset}
				{canUseSelectedImageAsset}
				{canReplaceSelectedLayerFromAsset}
				{selectedImageLayer}
				{selectedImageLayerIsAiResult}
				{selectedImageReplacementMode}
				{imageLayerDisplayName}
				{formatAssetDisplayName}
				{formatAssetShortId}
				{formatAssetOptionLabel}
				{formatAssetCompactBytes}
				{formatAssetBytes}
				{formatAssetDate}
				{formatImageAssetUsageLabel}
				{formatImageAssetReadyStatus}
				{formatImageAssetFileType}
				{getImageAssetUsageCount}
				{shouldShowImageAssetThumbnail}
				{shouldShowImageAssetPreview}
				{imageAssetPreviewUrl}
				{clearImageAssetThumbnailFailure}
				{markImageAssetThumbnailFailed}
				{clearImageAssetPreviewFailure}
				{markImageAssetPreviewFailed}
				onToggleDrawer={toggleAssetLibraryOpen}
				onImageAssetQueryChange={updateImageAssetQuery}
				onSetImageAssetSizeBand={setImageAssetSizeBand}
				onSetImageAssetSourceFilter={setImageAssetSourceFilter}
				onDeleteImageAsset={onDeleteImageAsset}
				onSetImageAssetView={setImageAssetView}
				onImageAssetSelectionChange={updateImageAssetSelection}
				onSelectImageAsset={selectImageAsset}
				{onAddSelectedImageAssetLayer}
				{onReplaceSelectedImageLayerFromAsset}
				onToggleImageAssetBrowserExpanded={toggleImageAssetBrowserExpanded}
			/>
			{#if imageLayers.length && filteredImageLayers.length && !selectedImageReplacementMode}
				<div class="layer-list" role="list" aria-label={$_("layersInspector.imageListAria")}>
					{#each filteredImageLayers as layer, index (getLayerListKey("image", layer.id, index))}
						<div
							class="layer-row image-layer-row"
							role="listitem"
							class:active={selectedImageLayer?.id === layer.id}
							class:hidden-layer={layer.visible === false}
							class:locked-layer={layer.locked === true}
						>
							<button
								class="layer-select"
								onclick={() => selectImageLayerForProperties(layer.id)}
								title={imageLayerDisplayName(layer)}
								aria-label={$_("layersInspector.selectEditImage", { values: { name: imageLayerDisplayName(layer) } })}
								>
									<span class="layer-type image-type" class:ai-type={isAiResultImageLayer(layer)}>
										{isAiResultImageLayer(layer) ? $_("layersInspector.layerTypeAi") : $_("layersInspector.layerTypeImageShort")}
									</span>
									<span class="layer-main">
										<span class="layer-name">{imageLayerDisplayName(layer)}</span>
										<span class="layer-meta">
											{imageLayerListMeta(layer)}
											{#if layer.visible === false} / {$_("layersInspector.textMetaHidden")}{/if}
											{#if layer.locked === true} / {$_("layersInspector.textMetaLocked")}{/if}
										</span>
									{#if imageLayerStateBadges(layer).length}
										<span class="layer-badges" aria-label={$_("layersInspector.imageBadgesAria")}>
											{#each imageLayerStateBadges(layer) as badge (badge)}
												<span class="layer-badge image-state">{badge}</span>
											{/each}
										</span>
									{/if}
									{#if selectedImageLayer?.id === layer.id}
										<span class="layer-edit-state">{$_("layersInspector.rowSelect")}</span>
									{/if}
								</span>
							</button>
								{#if selectedImageLayer?.id === layer.id}
									<div
										class="layer-actions selected-row-actions"
										aria-label={$_("layersInspector.imageCommandsFor", { values: { name: imageLayerDisplayName(layer) } })}
									>
										<button
											class="layer-action-btn"
											onclick={() => onToggleImageLayerVisibility(layer.id)}
											title={layer.visible === false ? $_("layersInspector.showExtraImage") : $_("layersInspector.hideExtraImage")}
											aria-label={layer.visible === false ? $_("layersInspector.showExtraImage") : $_("layersInspector.hideExtraImage")}
										>{layer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
										<button
											class="layer-action-btn"
											onclick={() => onToggleImageLayerLock(layer.id)}
											title={layer.locked === true ? $_("layersInspector.unlockExtraImage") : $_("layersInspector.lockExtraImage")}
											aria-label={layer.locked === true ? $_("layersInspector.unlockExtraImage") : $_("layersInspector.lockExtraImage")}
										>{layer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
										<button
											class="layer-action-btn"
											onclick={() => onDuplicateImageLayer(layer.id)}
											title={$_("layersInspector.duplicateSelectedExtraImage")}
											aria-label={$_("layersInspector.duplicateSelectedExtraImage")}
										>{$_("layersInspector.actionDuplicate")}</button>
										<button
											class="layer-action-btn danger"
											onclick={() => requestDeleteImageLayer(layer)}
											title={$_("layersInspector.deleteSelectedExtraImage")}
											aria-label={$_("layersInspector.deleteSelectedExtraImage")}
										>{$_("layersInspector.actionDelete")}</button>
									</div>
								{/if}
						</div>
					{/each}
				</div>
			{:else if !selectedImageReplacementMode}
				<div class="empty-state action-empty">
					{#if imageLayers.length}
						<span>{$_("layersInspector.noImageInFilter")}</span>
						<span>{$_("layersInspector.changeFilterToSeeAll")}</span>
					{:else}
						<span>{$_("layersInspector.sourceLoadedNoExtra")}</span>
						<span>{$_("layersInspector.extraImageExplain")}</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Phase C — non-destructive "Edits" stack: the page's imageEditLayers[] (bubble-clean
	/ brush / heal / clone). Each row: visibility toggle, rename, delete, and "revert to
	before this edit" (drops it + everything stacked after). Re-composites live. -->
{#if hasImage && (editLayers.length > 0 || editLayersOpenOverride)}
<div class="panel-section" id="image-edits-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel($_("layersInspector.imageEditsTitle"), editLayersOpen)}
		aria-expanded={editLayersOpen}
		onclick={() => editLayersOpenOverride = !editLayersOpen}
	>
		<span class="layers-section-copy">
			<span>{$_("layersInspector.imageEditsTitle")}</span>
			<small>{editLayers.length} {$_("layersInspector.imageEditsSubTrailing")}</small>
		</span>
		<span class="layers-section-meter">{editLayers.length}</span>
		<span class="layers-section-chevron" class:open={editLayersOpen} aria-hidden="true"></span>
	</button>
	{#if editLayersOpen}
		<div class="panel-section-body">
			{#if editLayers.length}
				<div class="layer-list" role="list" aria-label={$_("layersInspector.imageEditsListAria")}>
					{#each editLayers as layer, index (layer.id)}
						<div
							class="layer-row image-edit-row"
							role="listitem"
							class:hidden-layer={layer.visible === false}
						>
							<div class="layer-select edit-layer-select">
								<span class="layer-type image-edit-type">{editLayerKindLabel(layer)}</span>
								<span class="layer-main">
									{#if renamingEditLayerId === layer.id}
										<!-- svelte-ignore a11y_autofocus -->
										<input
											class="edit-layer-rename-input"
											type="text"
											autofocus
											bind:value={renamingEditLayerDraft}
											onkeydown={(e) => {
												if (e.key === "Enter") commitRenameEditLayer();
												else if (e.key === "Escape") cancelRenameEditLayer();
											}}
											onblur={commitRenameEditLayer}
											aria-label={$_("layersInspector.renameImageEditAria")}
										/>
									{:else}
										<span class="layer-name">{editLayerDisplayName(layer, index)}</span>
										<span class="layer-meta">
											{editLayerListMeta(layer)}
											{#if layer.visible === false} / {$_("layersInspector.textMetaHidden")}{/if}
										</span>
									{/if}
								</span>
							</div>
							<div class="layer-actions selected-row-actions" aria-label={$_("layersInspector.editImageCommandsFor", { values: { name: editLayerDisplayName(layer, index) } })}>
								<button
									class="layer-action-btn"
									onclick={() => toggleEditLayerVisibility(layer)}
									title={layer.visible === false ? $_("layersInspector.showThisEdit") : $_("layersInspector.hideThisEdit")}
									aria-label={layer.visible === false ? $_("layersInspector.showThisEdit") : $_("layersInspector.hideThisEdit")}
								>{layer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
								<button
									class="layer-action-btn"
									onclick={() => startRenameEditLayer(layer, index)}
									title={$_("layersInspector.renameThisEdit")}
									aria-label={$_("layersInspector.renameThisEdit")}
								>{$_("layersInspector.actionRename")}</button>
								<button
									class="layer-action-btn"
									onclick={() => requestRevertEditLayer(layer)}
									title={$_("layersInspector.revertBeforeEditTooltip")}
									aria-label={$_("layersInspector.revertBeforeEditAria")}
								>{$_("layersInspector.actionRevert")}</button>
								<button
									class="layer-action-btn danger"
									onclick={() => deleteEditLayer(layer)}
									title={$_("layersInspector.deleteThisEdit")}
									aria-label={$_("layersInspector.deleteThisEdit")}
								>{$_("layersInspector.actionDelete")}</button>
							</div>
							{#if pendingRevertEditLayerId === layer.id}
								<div class="edit-layer-revert-confirm" role="alertdialog" aria-label={$_("layersInspector.revertConfirmAria")}>
									<span class="edit-layer-revert-copy">
										{$_("layersInspector.revertConfirmQ")}
										{#if editLayersStackedAfter(layer) > 0}
											{$_("layersInspector.revertWillDeleteN", { values: { n: editLayersStackedAfter(layer) } })}
										{:else}
											{$_("layersInspector.revertWillDeleteThis")}
										{/if}
										{$_("layersInspector.revertUndoHint")}
									</span>
									<div class="edit-layer-revert-actions">
										<button class="panel-btn panel-btn-danger" onclick={confirmRevertEditLayer}>{$_("layersInspector.actionRevertBack")}</button>
										<button class="panel-btn" onclick={cancelRevertEditLayer}>{$_("layersInspector.actionCancel")}</button>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="empty-state action-empty">
					<span>{$_("layersInspector.noImageEdits")}</span>
					<span>{$_("layersInspector.imageEditsToolsHint")}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>
{/if}

<div class="panel-section" id="text-layers-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel($_("layersInspector.stackMetaTextBox"), layersOpen)}
		aria-expanded={layersOpen}
		onclick={() => layersOpenOverride = !layersOpen}
	>
			<span class="layers-section-copy">
				<span>{$_("layersInspector.stackMetaTextBox")}</span>
			<small>{textLayers.length} {$_("layersInspector.textBoxesSubTrailing")}</small>
		</span>
		<span class:attention={Boolean(selectedLayer)} class="layers-section-meter">
			{selectedLayer ? $_("layersInspector.imageLayersSelected") : $_("layersInspector.textBoxesOrder")}
		</span>
		<span class="layers-section-chevron" class:open={layersOpen} aria-hidden="true"></span>
	</button>
	{#if layersOpen}
		<div class="panel-section-body">
			<div class="layer-panel-toolbar">
				{#if hasImage}
					<button
						class="panel-btn panel-btn-primary layer-place-btn"
						onclick={onStartTextPlacement}
						aria-label={$_("layersInspector.placeText")}
					>
						{$_("layersInspector.placeText")}
					</button>
					<span class="layer-toolbar-hint">{$_("layersInspector.placeTextHint")}</span>
				{:else}
					<span class="next-layer-action-state">{$_("layersInspector.openPageBeforePlaceText")}</span>
				{/if}
			</div>
			{#if textLayers.length}
				<div class="layer-list" role="list" aria-label={$_("layersInspector.textBoxListAria")}>
					{#each textLayers as layer, index (getLayerListKey("text", layer.id, index))}
						<div
							class="layer-row"
							role="listitem"
							class:active={selectedLayer?.id === layer.id}
							class:hidden-layer={layer.visible === false}
							class:locked-layer={layer.locked === true}
						>
							<button
								class="layer-select"
								onclick={() => selectTextLayerForProperties(layer.id)}
								title={textLayerDisplayName(layer)}
								aria-label={$_("layersInspector.selectEditTextBox", { values: { name: textLayerDisplayName(layer) } })}
							>
								<span class="layer-type">T</span>
								<span class="layer-main">
									<span class="layer-name">{textLayerDisplayName(layer)}</span>
									<span class="layer-meta">
										{textLayerListMeta(layer)}
									</span>
									{#if layer.sourceCategory || layer.confidence !== undefined || layer.sourceProvider || layer.protected === true}
										<span class="layer-badges" aria-label={$_("layersInspector.layerInfoAria")}>
											{#if layer.sourceCategory}
												<span class="layer-badge category">{layerCategoryLabel(layer.sourceCategory)}</span>
											{/if}
											{#if layer.confidence !== undefined}
												<span class="layer-badge confidence">{formatLayerConfidence(layer.confidence)}</span>
											{/if}
											{#if layer.sourceProvider}
												<span class="layer-badge provider">{formatLayerProvider(layer.sourceProvider)}</span>
											{/if}
											{#if layer.protected === true}
												<span class="layer-badge protected">{$_("layersInspector.badgeProtected")}</span>
											{/if}
										</span>
									{/if}
									{#if selectedLayer?.id === layer.id}
										<span class="layer-edit-state">{$_("layersInspector.rowSelect")}</span>
									{/if}
								</span>
							</button>
								{#if selectedLayer?.id === layer.id}
									<div
										class="layer-actions selected-row-actions"
										aria-label={$_("layersInspector.textCommandsFor", { values: { name: textLayerDisplayName(layer) } })}
									>
										<button
											class="layer-action-btn"
											onclick={() => onToggleLayerVisibility(layer.id)}
											title={layer.visible === false ? $_("layersInspector.showTextBox") : $_("layersInspector.hideTextBox")}
											aria-label={layer.visible === false ? $_("layersInspector.showTextBox") : $_("layersInspector.hideTextBox")}
										>{layer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
										<button
											class="layer-action-btn"
											onclick={() => onToggleLayerLock(layer.id)}
											title={layer.locked === true ? $_("layersInspector.unlockTextBox") : $_("layersInspector.lockTextBox")}
											aria-label={layer.locked === true ? $_("layersInspector.unlockTextBox") : $_("layersInspector.lockTextBox")}
										>{layer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
										<button
											class="layer-action-btn"
											onclick={() => onDuplicateLayer(layer.id)}
											title={$_("layersInspector.duplicateSelectedTextBox")}
											aria-label={$_("layersInspector.duplicateSelectedTextBox")}
										>{$_("layersInspector.actionDuplicate")}</button>
										<button
											class="layer-action-btn danger"
											onclick={() => requestDeleteTextLayer(layer)}
											title={$_("layersInspector.deleteSelectedTextBox")}
											aria-label={$_("layersInspector.deleteSelectedTextBox")}
										>{$_("layersInspector.actionDelete")}</button>
									</div>
								{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="empty-state action-empty">
					<span>{$_("layersInspector.noTextBoxOnPage")}</span>
					<span>{$_("layersInspector.placeFirstLineHint")}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>
{/if}

<div class="panel-section" id="properties-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel(labels.properties, propsOpen)}
		aria-expanded={propsOpen}
		onclick={() => propsOpenOverride = !propsOpen}
	>
		<span class="layers-section-copy">
			<span>{labels.properties}</span>
			<small>{propertiesDetailLabel}</small>
		</span>
		<span class:attention={Boolean(selectedLayer || selectedImageLayer)} class="layers-section-meter">
			{propertiesScopeLabel}
		</span>
		<span class="layers-section-chevron" class:open={propsOpen} aria-hidden="true"></span>
	</button>
	{#if propsOpen}
			<div class="panel-section-body flex flex-col gap-2">
				{#if activeAiPlacementMarker}
						<div class="ai-placement-focus-card" role="region" aria-label={$_("layersInspector.aiPlacementRegionAria")}>
							<div class="ai-layer-focus-copy">
								<small>{activeAiPlacementMarker.status === "applied" ? $_("layersInspector.aiLayerMissing") : $_("layersInspector.aiPassedReview")}</small>
								<strong>{activeAiPlacementMarker.status === "applied" ? $_("layersInspector.recoverAiBeforeExport") : $_("layersInspector.placeAiBeforeExport")}</strong>
								<span>{$_("layersInspector.aiNotInEditLayer")}</span>
							</div>
						<div class="ai-layer-trust-row" aria-label={$_("layersInspector.aiPlacementSafetyAria")}>
							<span>{$_("layersInspector.baseImageSafe")}</span>
							<span>{$_("layersInspector.createdAsEditLayer")}</span>
						</div>
						<div class="ai-placement-actions" aria-label={$_("layersInspector.aiPlacementActionsAria")}>
								<button type="button" class="layer-action-btn primary" onclick={() => void placeActiveAiResultLayer()}>
									{activeAiPlacementMarker.status === "applied" ? $_("layersInspector.recoverAiLayer") : $_("layersInspector.placeAiLayer")}
								</button>
							<button type="button" class="layer-action-btn" onclick={openActiveAiReview}>
									{$_("layersInspector.openReview")}
							</button>
						</div>
					</div>
				{:else if selectedImageLayer}
					<div class="selected-layer-summary image-summary">
					<div class="selected-layer-title">
							<span>{selectedImageLayerIsAiResult ? $_("layersInspector.aiResultPlaced") : selectedCreditImageLayer ? $_("layersInspector.selectedCreditDirectImage") : $_("layersInspector.selectedExtraImage")}</span>
							{#if selectedImageLayerIsAiResult}
								<small>{Math.round((selectedImageLayer.opacity ?? 1) * 100)}% {$_("layersInspector.aiMetaTrailing")}</small>
							{:else}
								<small>
									{Math.round(selectedImageLayer.x)}, {Math.round(selectedImageLayer.y)}
									/ {Math.round(selectedImageLayer.w)} x {Math.round(selectedImageLayer.h)}
								</small>
								{#if selectedImageCleanBrushActive}
									<small class="selected-image-brush-inline">{$_("layersInspector.brushOnPrefix")} {selectedImageBrushRestoreStatus}</small>
								{/if}
							{/if}
						</div>
						{#if selectedImagePrimaryEditActive}
							<div
								class="selected-layer-primary-actions"
								aria-label={selectedCreditImageLayer ? $_("layersInspector.editCreditImageMainAria") : $_("layersInspector.editExtraImageMainAria")}
							>
								{#if selectedImageLayer.visible === false}
									<button
										type="button"
										class="panel-btn panel-btn-primary"
										onclick={() => onToggleImageLayerVisibility(selectedImageLayer!.id)}
									>
										{$_("layersInspector.showImage")}
									</button>
								{:else if selectedImageLayer.locked === true}
									<button
										type="button"
										class="panel-btn panel-btn-primary"
										onclick={() => onToggleImageLayerLock(selectedImageLayer!.id)}
									>
										{$_("layersInspector.actionUnlockLabel")}
									</button>
								{:else}
									<button type="button" class="panel-btn panel-btn-primary" onclick={() => focusSelectedImageControl(controlIds.imageOpacity)}>
										{selectedCreditImageLayer ? $_("layersInspector.adjustCredit") : $_("layersInspector.setImage")}
									</button>
								{/if}
								{#if selectedCreditImageLayer}
									<button
										type="button"
										class="panel-btn danger-soft"
										onclick={requestDeleteSelectedCreditLayer}
									>
										{$_("layersInspector.labelDelete")}
									</button>
								{:else}
									{#if selectedImageLayerCanUseCleanBrush}
										<button
											type="button"
											class="panel-btn"
											onclick={onStartSelectedImageBrush}
											title={$_("layersInspector.openBrushForThisLayerTooltip")}
											aria-label={$_("layersInspector.openBrushSelectedExtraAria")}
										>
											{$_("layersInspector.cleanBrush")}
										</button>
									{/if}
									<button type="button" class="panel-btn" onclick={openSelectedImageLibrary}>
										{$_("layersInspector.imageLibrary")}
									</button>
								{/if}
							</div>
							{#if !selectedCreditImageLayer}
								<div class="selected-image-transform-readout" role="status" aria-label={$_("layersInspector.selectedExtraImagePlacementAria")}>
									<span>{$_("layersInspector.now")}</span>
									<strong>{imageLayerTransformSummary(selectedImageLayer)}</strong>
									<small>{imageLayerTransformDetail(selectedImageLayer)}</small>
								</div>
							{/if}
							<details class="selected-layer-utility-details">
								<summary
									data-closed-label={$_("layersInspector.toggleOpen")}
									data-open-label={$_("layersInspector.toggleCollapse")}
								>{selectedCreditImageLayer ? $_("layersInspector.creditCommands") : $_("layersInspector.extraImageCommands")}</summary>
								<div class="selected-layer-actions secondary" aria-label={selectedCreditImageLayer ? $_("layersInspector.secondaryCreditImageActionsAria") : $_("layersInspector.secondaryExtraImageActionsAria")}>
									<button
										class="layer-action-btn"
										onclick={onCopySelectedLayer}
										title={selectedCreditImageLayer ? $_("layersInspector.copySelectedCreditImage") : $_("layersInspector.copySelectedExtraImage")}
									aria-label={selectedCreditImageLayer ? $_("layersInspector.copySelectedCreditImage") : $_("layersInspector.copySelectedExtraImage")}
								>{$_("layersInspector.actionCopy")}</button>
									{#if layerClipboardKind}
										<button
											class="layer-action-btn"
											onclick={onPasteLayerClipboard}
											title={layerClipboardLabel}
											aria-label={$_("layersInspector.pasteCopiedLayer")}
										>{$_("layersInspector.actionPaste")}</button>
									{/if}
									<button
										class="layer-action-btn"
										onclick={() => onDuplicateImageLayer(selectedImageLayer!.id)}
										title={selectedCreditImageLayer ? $_("layersInspector.duplicateSelectedCreditImage") : $_("layersInspector.duplicateSelectedExtraImage")}
										aria-label={selectedCreditImageLayer ? $_("layersInspector.duplicateSelectedCreditImage") : $_("layersInspector.duplicateSelectedExtraImage")}
									>{$_("layersInspector.actionDuplicate")}</button>
									<button
										class="layer-action-btn"
										onclick={() => onToggleImageLayerVisibility(selectedImageLayer!.id)}
										title={selectedImageLayer.visible === false ? $_("layersInspector.showSelectedExtraImage") : $_("layersInspector.hideSelectedExtraImage")}
										aria-label={selectedImageLayer.visible === false ? $_("layersInspector.showSelectedExtraImage") : $_("layersInspector.hideSelectedExtraImage")}
									>{selectedImageLayer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
									<button
										class="layer-action-btn"
										onclick={() => onToggleImageLayerLock(selectedImageLayer!.id)}
										title={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedExtraImage") : $_("layersInspector.lockSelectedExtraImage")}
										aria-label={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedExtraImage") : $_("layersInspector.lockSelectedExtraImage")}
									>{selectedImageLayer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
									<button
										class="layer-action-btn danger"
										onclick={() => requestDeleteImageLayer(selectedImageLayer!)}
										title={selectedCreditImageLayer ? $_("layersInspector.deleteSelectedCreditImage") : $_("layersInspector.deleteSelectedExtraImage")}
										aria-label={selectedCreditImageLayer ? $_("layersInspector.deleteSelectedCreditImage") : $_("layersInspector.deleteSelectedExtraImage")}
									>{selectedCreditImageLayer ? $_("layersInspector.labelDelete") : $_("layersInspector.actionDelete")}</button>
								</div>
							</details>
						{:else if !selectedImageLayerIsAiResult}
							<div
								class="selected-layer-actions"
								aria-label={$_("layersInspector.quickActionsSelectedExtraAria")}
							>
								{#if selectedImageLayerCanUseCleanBrush}
									<button
										class="layer-action-btn primary"
										onclick={onStartSelectedImageBrush}
										title={$_("layersInspector.openBrushSelectedExtraAria")}
										aria-label={$_("layersInspector.openBrushSelectedExtraAria")}
									>{$_("layersInspector.cleanBrush")}</button>
								{/if}
								<button
									class="layer-action-btn"
									onclick={onCopySelectedLayer}
									title={$_("layersInspector.copySelectedExtraImage")}
									aria-label={$_("layersInspector.copySelectedExtraImage")}
								>{$_("layersInspector.actionCopy")}</button>
								{#if layerClipboardKind}
									<button
										class="layer-action-btn"
										onclick={onPasteLayerClipboard}
										title={layerClipboardLabel}
										aria-label={$_("layersInspector.pasteCopiedLayer")}
									>{$_("layersInspector.actionPaste")}</button>
								{/if}
								<button
									class="layer-action-btn"
									onclick={() => onDuplicateImageLayer(selectedImageLayer!.id)}
									title={$_("layersInspector.duplicateSelectedExtraImage")}
									aria-label={$_("layersInspector.duplicateSelectedExtraImage")}
								>{$_("layersInspector.actionDuplicate")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onToggleImageLayerVisibility(selectedImageLayer!.id)}
									title={selectedImageLayer.visible === false ? $_("layersInspector.showSelectedExtraImage") : $_("layersInspector.hideSelectedExtraImage")}
									aria-label={selectedImageLayer.visible === false ? $_("layersInspector.showSelectedExtraImage") : $_("layersInspector.hideSelectedExtraImage")}
								>{selectedImageLayer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onToggleImageLayerLock(selectedImageLayer!.id)}
									title={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedExtraImage") : $_("layersInspector.lockSelectedExtraImage")}
									aria-label={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedExtraImage") : $_("layersInspector.lockSelectedExtraImage")}
								>{selectedImageLayer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
								<button
									class="layer-action-btn danger"
									onclick={() => requestDeleteImageLayer(selectedImageLayer!)}
									title={$_("layersInspector.deleteSelectedExtraImage")}
									aria-label={$_("layersInspector.deleteSelectedExtraImage")}
								>{$_("layersInspector.actionDelete")}</button>
							</div>
						{/if}
					</div>
					{#if selectedImageLayerIsAiResult}
						<div
							id={controlIds.aiLayerFocus}
							class="ai-layer-focus-card"
							tabindex="-1"
							aria-label={$_("layersInspector.aiLayerQuickActionsAria")}
						>
							<div class="ai-layer-focus-copy">
								<small>{$_("layersInspector.aiResultIsEditLayer")}</small>
								<strong>{selectedImageLayer.visible === false ? $_("layersInspector.comparingBase") : $_("layersInspector.tuneBeforeExport")}</strong>
								<span>
									{selectedImageLayer.visible === false
										? $_("layersInspector.aiHiddenForCompare")
										: $_("layersInspector.aiBaseSafeEditSeparate")}
								</span>
							</div>
							<div class="ai-layer-trust-row" aria-label={$_("layersInspector.aiResultSafetyAria")}>
								<span>{$_("layersInspector.baseImageSafe")}</span>
								<span>{selectedImageLayer.visible === false ? $_("layersInspector.comparingBase") : $_("layersInspector.hideToCompare")}</span>
							</div>
								{#if selectedImageLayer.locked === true}
									<div class="ai-layer-opacity-control" role="status" aria-label={$_("layersInspector.aiOpacityLockedAria")}>
										<span>{$_("layersInspector.labelOpacity2")} {Math.round((selectedImageLayer.opacity ?? 1) * 100)}%</span>
										<span class="selected-image-action-state wide">{$_("layersInspector.unlockBeforeAiOpacity")}</span>
									</div>
								{:else}
									<label class="ai-layer-opacity-control" for={controlIds.aiLayerOpacity}>
										<span>{$_("layersInspector.labelOpacity2")} {Math.round((selectedImageLayer.opacity ?? 1) * 100)}%</span>
										<input
											id={controlIds.aiLayerOpacity}
											type="range"
											min="0"
											max="100"
											step="1"
											value={Math.round((selectedImageLayer.opacity ?? 1) * 100)}
											oninput={(event) => updateSelectedImageNumber(event, "opacity")}
											onchange={(event) => updateSelectedImageNumber(event, "opacity", true)}
											aria-label={$_("layersInspector.adjustAiOpacityAria")}
										/>
									</label>
								{/if}
									<div class="ai-layer-quick-actions">
										{#if selectedAiResultMarker}
											<button
											type="button"
											class="layer-action-btn primary"
											onclick={openSelectedAiReview}
											title={$_("layersInspector.openAiReviewPanelTooltip")}
											aria-label={$_("layersInspector.viewAiReviewSelectedAria")}
										>{$_("layersInspector.viewReview")}</button>
									{/if}
										{#if selectedImageLayer.locked === true}
											<span class="selected-image-action-state wide">{$_("layersInspector.unlockBeforePlaceAi")}</span>
										{:else}
											{#if selectedImageLayerCanUseCleanBrush}
												<button
													type="button"
													class="layer-action-btn"
													onclick={onStartSelectedImageBrush}
													title={$_("layersInspector.openBrushSelectedAiTooltip")}
													aria-label={$_("layersInspector.openBrushSelectedAiAria")}
												>{$_("layersInspector.cleanBrush")}</button>
											{/if}
											<button
												type="button"
												class="layer-action-btn"
												onclick={() => onApplySelectedImageLayerTransformPreset("fit-page")}
												title={$_("layersInspector.fitAiToPageTooltip")}
												aria-label={$_("layersInspector.fitAiToPageAria")}
											>{$_("layersInspector.fitToPage")}</button>
											<button
												type="button"
												class="layer-action-btn"
												onclick={() => onApplySelectedImageLayerTransformPreset("source-aspect")}
												title={$_("layersInspector.restoreAiAspectTooltip")}
												aria-label={$_("layersInspector.restoreAiAspectTooltip")}
											>{$_("layersInspector.aspect")}</button>
											<button
												type="button"
												class="layer-action-btn"
												onclick={() => onApplySelectedImageLayerTransformPreset("reset-transform")}
												title={$_("layersInspector.resetAiTransformTooltip")}
												aria-label={$_("layersInspector.resetAiTransformTooltip")}
											>{$_("layersInspector.reset")}</button>
										{/if}
								<button
									type="button"
									class="layer-action-btn"
									onclick={() => onToggleImageLayerVisibility(selectedImageLayer!.id)}
									title={selectedImageLayer.visible === false ? $_("layersInspector.showAiAgainTooltip") : $_("layersInspector.hideAiToCompareTooltip")}
									aria-label={selectedImageLayer.visible === false ? $_("layersInspector.showAiAgainTooltip") : $_("layersInspector.hideAiToCompareTooltip")}
								>{selectedImageLayer.visible === false ? $_("layersInspector.showAi") : $_("layersInspector.compareBase")}</button>
								<button
									type="button"
									class="layer-action-btn"
									onclick={() => onToggleImageLayerLock(selectedImageLayer!.id)}
									title={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedAi") : $_("layersInspector.lockSelectedAi")}
									aria-label={selectedImageLayer.locked === true ? $_("layersInspector.unlockSelectedAi") : $_("layersInspector.lockSelectedAi")}
								>{selectedImageLayer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
							</div>
							<details class="ai-layer-lifecycle-details">
								<summary>
									<span>{$_("layersInspector.manageLayer")}</span>
									<small>{$_("layersInspector.copyDuplicateDelete")}</small>
								</summary>
								<div class="selected-layer-actions secondary ai-layer-lifecycle-actions" aria-label={$_("layersInspector.manageSelectedAiAria")}>
									<button
										class="layer-action-btn"
										onclick={onCopySelectedLayer}
										title={$_("layersInspector.copySelectedAi")}
										aria-label={$_("layersInspector.copySelectedAi")}
									>{$_("layersInspector.actionCopy")}</button>
									{#if layerClipboardKind}
										<button
											class="layer-action-btn"
											onclick={onPasteLayerClipboard}
											title={layerClipboardLabel}
											aria-label={$_("layersInspector.pasteCopiedLayer")}
										>{$_("layersInspector.actionPaste")}</button>
									{/if}
									<button
										class="layer-action-btn"
										onclick={() => onDuplicateImageLayer(selectedImageLayer!.id)}
										title={$_("layersInspector.duplicateSelectedAi")}
										aria-label={$_("layersInspector.duplicateSelectedAi")}
									>{$_("layersInspector.actionDuplicate")}</button>
									<button
										class="layer-action-btn danger"
										onclick={() => requestDeleteImageLayer(selectedImageLayer!)}
										title={$_("layersInspector.deleteSelectedAi")}
										aria-label={$_("layersInspector.deleteSelectedAi")}
									>{$_("layersInspector.actionDelete")}</button>
								</div>
							</details>
							<div class="selected-image-transform-readout ai-layer-transform-readout" role="status" aria-label={$_("layersInspector.selectedAiPlacementAria")}>
								<span>{$_("layersInspector.now")}</span>
								<strong>{imageLayerTransformSummary(selectedImageLayer)}</strong>
								<small>{imageLayerTransformDetail(selectedImageLayer)}</small>
							</div>
						</div>
					{/if}
					<details
						class="image-layer-advanced-drawer"
						open={selectedImageAdvancedOpenOverride ?? false}
						ontoggle={(event) => selectedImageAdvancedOpenOverride = (event.currentTarget as HTMLDetailsElement).open}
					>
						<summary
							data-closed-label={$_("layersInspector.toggleOpen")}
							data-open-label={$_("layersInspector.toggleClose")}
						>
							<span>{selectedImageLayerIsAiResult ? $_("layersInspector.advancedAiSettings") : selectedCreditImageLayer ? $_("layersInspector.creditImageSettingsAria") : $_("layersInspector.extraImageSettings")}</span>
							<small>{selectedImagePrimaryEditActive ? $_("layersInspector.openForFineTune") : $_("layersInspector.nameTypePosSize")}</small>
						</summary>
					<div class="layer-property-group" aria-label={$_("layersInspector.imageInfoModeAria")}>
						<div class="layer-property-group-header">
							<span>{$_("layersInspector.infoAndMode")}</span>
						<small>{$_("layersInspector.nameTypeBlend")}</small>
					</div>
					<div class="image-layer-name">
						<span class="panel-label">{$_("layersInspector.labelSource")}</span>
						<span class="image-source-name">{selectedImageLayer.originalName || selectedImageLayer.imageName}</span>
					</div>
						{#if selectedImageLayer.locked === true}
							<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedLayerNameAria")}>
								<span>{$_("layersInspector.labelLayerName")}</span>
								<strong>{selectedImageLayer.name?.trim() || selectedImageLayer.originalName || selectedImageLayer.imageName}</strong>
							</div>
						{:else}
							<div>
								<label class="panel-label" for={controlIds.imageLayerName}>{$_("layersInspector.labelLayerName")}</label>
								<input
									id={controlIds.imageLayerName}
									class="panel-input"
									type="text"
									placeholder={selectedImageLayer.originalName || selectedImageLayer.imageName}
									value={selectedImageLayer.name ?? ""}
									oninput={(event) => updateSelectedImageName(event)}
									onchange={(event) => updateSelectedImageName(event, true)}
								/>
							</div>
						{/if}
						{#if selectedImageLayer.locked === true || selectedImageLayerIsAiResult}
							<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.selectedImageTypeAria")}>
								<span>{$_("layersInspector.labelType")}</span>
								<strong>{selectedImageLayerIsAiResult ? $_("layersInspector.aiKeepsType") : formatImageLayerRole(selectedImageLayer)}</strong>
							</div>
							{#if selectedImageLayerIsAiResult}
								<small class="image-layer-role-note">{$_("layersInspector.aiTypeNote")}</small>
							{/if}
						{:else}
							<div>
								<label class="panel-label" for={controlIds.imageRole}>{$_("layersInspector.labelType")}</label>
								<select
									id={controlIds.imageRole}
									class="panel-select"
									value={getImageLayerRole(selectedImageLayer)}
									onchange={updateSelectedImageRole}
								>
									<option value="reference">{$_("layersInspector.roleReference")}</option>
									<option value="overlay">{$_("layersInspector.roleOverlay")}</option>
									<option value="credit">{$_("layersInspector.focusCreditImage")}</option>
								</select>
							</div>
						{/if}
						{#if selectedImageLayer.locked === true}
							<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedBlendModeAria")}>
								<span>{$_("layersInspector.labelBlendMode")}</span>
								<strong>{imageLayerBlendModeOptions.find((option) => option.value === getImageLayerBlendMode(selectedImageLayer))?.label ?? $_("layersInspector.blendNormal")}</strong>
							</div>
						{:else}
							<div>
								<label class="panel-label" for={controlIds.imageBlendMode}>{$_("layersInspector.labelBlendMode")}</label>
								<select
									id={controlIds.imageBlendMode}
									class="panel-select"
									value={getImageLayerBlendMode(selectedImageLayer)}
									onchange={updateSelectedImageBlendMode}
								>
									{#each imageLayerBlendModeOptions as option (option.value)}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
							</div>
						{/if}
				</div>
				<div class="layer-property-group" aria-label={$_("layersInspector.quickPlaceAria")}>
					<div class="layer-property-group-header">
						<span>{$_("layersInspector.quickPlace")}</span>
						<small>{$_("layersInspector.edgeCenterFit")}</small>
					</div>
					<div class="image-align-block">
						<span class="panel-label">{$_("layersInspector.labelAlign")}</span>
						<div class="image-align-grid" aria-label={$_("layersInspector.alignSelectedImageAria")}>
							{#if selectedImageLayer.locked === true}
								<span class="selected-image-action-state wide">{$_("layersInspector.unlockBeforeAlign")}</span>
							{:else}
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("left")}
									title={$_("layersInspector.alignLeftTooltip")}
									aria-label={$_("layersInspector.alignLeftTooltip")}
								>{$_("layersInspector.alignLeft")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("center-x")}
									title={$_("layersInspector.alignCenterHTooltip")}
									aria-label={$_("layersInspector.alignCenterHTooltip")}
								>{$_("layersInspector.alignCenterH")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("right")}
									title={$_("layersInspector.alignRightTooltip")}
									aria-label={$_("layersInspector.alignRightTooltip")}
								>{$_("layersInspector.alignRight")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("top")}
									title={$_("layersInspector.alignTopTooltip")}
									aria-label={$_("layersInspector.alignTopTooltip")}
								>{$_("layersInspector.alignTop")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("center-y")}
									title={$_("layersInspector.alignCenterVTooltip")}
									aria-label={$_("layersInspector.alignCenterVTooltip")}
								>{$_("layersInspector.alignCenterV")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onAlignSelectedImageLayer("bottom")}
									title={$_("layersInspector.alignBottomTooltip")}
									aria-label={$_("layersInspector.alignBottomTooltip")}
								>{$_("layersInspector.alignBottom")}</button>
							{/if}
						</div>
					</div>
					<div class="image-transform-block">
						<span class="panel-label">{$_("layersInspector.labelTransform")}</span>
						<div class="image-transform-grid" aria-label={$_("layersInspector.transformGridAria")}>
							{#if selectedImageLayer.locked === true}
								<span class="selected-image-action-state wide">{$_("layersInspector.unlockBeforeTransform")}</span>
							{:else}
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("fit-page")}
									title={$_("layersInspector.fitExtraImageTooltip")}
									aria-label={$_("layersInspector.fitExtraImageTooltip")}
								>{$_("layersInspector.fit")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("fill-width")}
									title={$_("layersInspector.fillWidthTooltip")}
									aria-label={$_("layersInspector.fillWidthTooltip")}
								>{$_("layersInspector.fillWidth")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("fill-height")}
									title={$_("layersInspector.fillHeightTooltip")}
									aria-label={$_("layersInspector.fillHeightTooltip")}
								>{$_("layersInspector.fillHeight")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("source-aspect")}
									title={$_("layersInspector.trueAspectTooltip")}
									aria-label={$_("layersInspector.trueAspectAria")}
								>{$_("layersInspector.trueAspect")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("reset-rotation")}
									title={$_("layersInspector.resetRotationTooltip")}
									aria-label={$_("layersInspector.resetRotationTooltip")}
								>{$_("layersInspector.rotateZero")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onApplySelectedImageLayerTransformPreset("reset-transform")}
									title={$_("layersInspector.resetTransformTooltip")}
									aria-label={$_("layersInspector.resetTransformAria")}
								>{$_("layersInspector.reset")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onSelectedImageLayerChange({ flipX: selectedImageLayer.flipX !== true }, true)}
									title={selectedImageLayer.flipX === true ? $_("layersInspector.undoFlipHTooltip") : $_("layersInspector.flipHTooltip")}
									aria-label={selectedImageLayer.flipX === true ? $_("layersInspector.undoFlipHAria") : $_("layersInspector.flipHTooltip")}
								>{selectedImageLayer.flipX === true ? $_("layersInspector.flipHDone") : $_("layersInspector.flipHorizontal")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onSelectedImageLayerChange({ flipY: selectedImageLayer.flipY !== true }, true)}
									title={selectedImageLayer.flipY === true ? $_("layersInspector.undoFlipVTooltip") : $_("layersInspector.flipVTooltip")}
									aria-label={selectedImageLayer.flipY === true ? $_("layersInspector.undoFlipVAria") : $_("layersInspector.flipVTooltip")}
								>{selectedImageLayer.flipY === true ? $_("layersInspector.flipVDone") : $_("layersInspector.flipVertical")}</button>
							{/if}
						</div>
					</div>
				</div>
					<div class="layer-property-group advanced" aria-label={$_("layersInspector.posSizeOpacityAria")}>
						<div class="layer-property-group-header">
							<span>{$_("layersInspector.posAndSize")}</span>
							<small>{$_("layersInspector.posSizeFields")}</small>
						</div>
						{#if selectedImageLayer.locked === true}
							<span class="selected-image-action-state wide">{$_("layersInspector.unlockBeforePosSize")}</span>
							<div class="selected-image-transform-readout" role="status" aria-label={$_("layersInspector.lockedPosSizeAria")}>
								<span>{$_("layersInspector.now")}</span>
								<strong>{imageLayerTransformSummary(selectedImageLayer)}</strong>
								<small>{imageLayerTransformDetail(selectedImageLayer)}</small>
							</div>
						{:else}
							<div>
								<label class="panel-label" for={controlIds.imageOpacity}>
									{$_("layersInspector.labelOpacityColon")} {Math.round((selectedImageLayer.opacity ?? 1) * 100)}%
								</label>
								<input
									id={controlIds.imageOpacity}
									class="panel-input"
									type="range"
									min="0"
									max="100"
									step="1"
									value={Math.round((selectedImageLayer.opacity ?? 1) * 100)}
									oninput={(event) => updateSelectedImageNumber(event, "opacity")}
									onchange={(event) => updateSelectedImageNumber(event, "opacity", true)}
								/>
							</div>
							<div class="image-geometry-grid">
								<label class="panel-label" for={controlIds.imageX}>
									<span>{$_("layersInspector.alignLeft")}</span>
									<input
										id={controlIds.imageX}
										class="panel-input"
										type="number"
										value={Math.round(selectedImageLayer.x)}
										oninput={(event) => updateSelectedImageNumber(event, "x")}
										onchange={(event) => updateSelectedImageNumber(event, "x", true)}
									/>
								</label>
								<label class="panel-label" for={controlIds.imageY}>
									<span>{$_("layersInspector.alignTop")}</span>
									<input
										id={controlIds.imageY}
										class="panel-input"
										type="number"
										value={Math.round(selectedImageLayer.y)}
										oninput={(event) => updateSelectedImageNumber(event, "y")}
										onchange={(event) => updateSelectedImageNumber(event, "y", true)}
									/>
								</label>
								<label class="panel-label" for={controlIds.imageWidth}>
									<span>{$_("layersInspector.fillWidth")}</span>
									<input
										id={controlIds.imageWidth}
										class="panel-input"
										type="number"
										min="1"
										value={Math.round(selectedImageLayer.w)}
										oninput={(event) => updateSelectedImageNumber(event, "w")}
										onchange={(event) => updateSelectedImageNumber(event, "w", true)}
									/>
								</label>
								<label class="panel-label" for={controlIds.imageHeight}>
									<span>{$_("layersInspector.fillHeight")}</span>
									<input
										id={controlIds.imageHeight}
										class="panel-input"
										type="number"
										min="1"
										value={Math.round(selectedImageLayer.h)}
										oninput={(event) => updateSelectedImageNumber(event, "h")}
										onchange={(event) => updateSelectedImageNumber(event, "h", true)}
									/>
								</label>
							</div>
							<div>
								<label class="panel-label" for={controlIds.imageRotation}>{$_("layersInspector.labelRotationDeg")}</label>
								<input
									id={controlIds.imageRotation}
									class="panel-input"
									type="number"
									step="1"
									value={Math.round(selectedImageLayer.rotation)}
									oninput={(event) => updateSelectedImageNumber(event, "rotation")}
									onchange={(event) => updateSelectedImageNumber(event, "rotation", true)}
								/>
							</div>
						{/if}
						</div>
					</details>
				{:else if selectedLayer}
				<div class="selected-layer-summary selected-text-layer-summary">
					<div class="selected-layer-title">
						<span>{selectedCreditLayer ? $_("layersInspector.selectedCreditDirectText") : $_("layersInspector.selectedTextBox")}</span>
						<small>
							{Math.round(selectedLayer.x)}, {Math.round(selectedLayer.y)}
							/ {selectedLayer.fontSize}px
						</small>
							</div>
							{#if selectedEditableLayerFocusActive}
								<div class="selected-layer-primary-actions" aria-label={$_("layersInspector.mainTextEditAria")}>
							{#if selectedLayer.visible === false}
								<button
									type="button"
									class="panel-btn panel-btn-primary"
									onclick={() => onToggleLayerVisibility(selectedLayer!.id)}
								>
									{selectedCreditLayer ? $_("layersInspector.showCredit") : $_("layersInspector.showText")}
								</button>
							{:else if selectedLayer.locked === true}
								<button
									type="button"
									class="panel-btn panel-btn-primary"
									onclick={() => onToggleLayerLock(selectedLayer!.id)}
								>
									{$_("layersInspector.actionUnlockLabel")}
								</button>
							{:else}
								<button type="button" class="panel-btn panel-btn-primary" onclick={() => focusLayerControl(controlIds.text)}>
									{selectedCreditLayer ? $_("layersInspector.focusEditCredit") : $_("layersInspector.focusEditText")}
								</button>
								{/if}
								{#if selectedCreditLayer}
									{#if selectedLayer.visible === false}
										<span class="selected-layer-action-state">{$_("layersInspector.showCreditBeforeStyle")}</span>
									{:else if selectedLayer.locked === true}
										<span class="selected-layer-action-state">{$_("layersInspector.unlockBeforeStyle")}</span>
									{:else}
										<button
											type="button"
											class="panel-btn"
											onclick={() => focusLayerControl(controlIds.textPreset)}
										>
											{$_("layersInspector.styleBtn")}
										</button>
									{/if}
									<button
										type="button"
										class="panel-btn danger-soft"
										onclick={requestDeleteSelectedCreditLayer}
									>
										{$_("layersInspector.labelDelete")}
									</button>
								{:else}
									{#if selectedLayer.visible === false}
										<span class="selected-layer-action-state">{$_("layersInspector.showTextBeforeStyle")}</span>
										<span class="selected-layer-action-state">{$_("layersInspector.showTextBeforeEffects")}</span>
									{:else if selectedLayer.locked === true}
										<span class="selected-layer-action-state">{$_("layersInspector.unlockBeforeStyle")}</span>
										<span class="selected-layer-action-state">{$_("layersInspector.unlockBeforeEffects")}</span>
									{:else}
										<button
											type="button"
											class="panel-btn"
											onclick={() => focusLayerControl(controlIds.textPreset)}
										>
											{$_("layersInspector.styleBtn")}
										</button>
										<button
											type="button"
											class="panel-btn"
											onclick={() => jumpToPanelSection("effects-section")}
										>
											{$_("layersInspector.titleEffects")}
										</button>
									{/if}
								{/if}
							</div>
						<details class="selected-layer-utility-details">
							<summary
								data-closed-label={$_("layersInspector.toggleOpen")}
								data-open-label={$_("layersInspector.toggleCollapse")}
							>{selectedCreditLayer ? $_("layersInspector.creditCommands") : $_("layersInspector.layerCommands")}</summary>
							<div class="selected-layer-actions secondary" aria-label={$_("layersInspector.secondaryLayerActionsAria")}>
								<button
									class="layer-action-btn"
									onclick={onCopySelectedLayer}
									title={$_("layersInspector.copySelectedTextBox")}
									aria-label={$_("layersInspector.copySelectedTextBox")}
								>{$_("layersInspector.actionCopy")}</button>
								{#if layerClipboardKind}
									<button
										class="layer-action-btn"
										onclick={onPasteLayerClipboard}
										title={layerClipboardLabel}
										aria-label={$_("layersInspector.pasteCopiedLayer")}
									>{$_("layersInspector.actionPaste")}</button>
								{/if}
								<button
									class="layer-action-btn"
									onclick={() => onDuplicateLayer(selectedLayer!.id)}
									title={$_("layersInspector.duplicateSelectedTextBox")}
									aria-label={$_("layersInspector.duplicateSelectedTextBox")}
								>{$_("layersInspector.actionDuplicate")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onToggleLayerVisibility(selectedLayer!.id)}
									title={selectedLayer.visible === false ? $_("layersInspector.showSelectedTextBox") : $_("layersInspector.hideSelectedTextBox")}
									aria-label={selectedLayer.visible === false ? $_("layersInspector.showSelectedTextBox") : $_("layersInspector.hideSelectedTextBox")}
								>{selectedLayer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
								<button
									class="layer-action-btn"
									onclick={() => onToggleLayerLock(selectedLayer!.id)}
									title={selectedLayer.locked === true ? $_("layersInspector.unlockSelectedTextBox") : $_("layersInspector.lockSelectedTextBox")}
									aria-label={selectedLayer.locked === true ? $_("layersInspector.unlockSelectedTextBox") : $_("layersInspector.lockSelectedTextBox")}
								>{selectedLayer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
								<button
									class="layer-action-btn danger"
									onclick={() => requestDeleteTextLayer(selectedLayer!)}
									title={selectedCreditLayer ? $_("layersInspector.deleteSelectedCredit") : $_("layersInspector.deleteSelectedTextBox")}
									aria-label={selectedCreditLayer ? $_("layersInspector.deleteSelectedCredit") : $_("layersInspector.deleteSelectedTextBox")}
								>{selectedCreditLayer ? $_("layersInspector.labelDelete") : $_("layersInspector.actionDelete")}</button>
							</div>
						</details>
					{:else}
						<div class="selected-layer-actions" aria-label={$_("layersInspector.quickActionsSelectedLayerAria")}>
							<button
								class="layer-action-btn"
								onclick={onCopySelectedLayer}
								title={$_("layersInspector.copySelectedTextBox")}
								aria-label={$_("layersInspector.copySelectedTextBox")}
							>{$_("layersInspector.actionCopy")}</button>
							{#if layerClipboardKind}
								<button
									class="layer-action-btn"
									onclick={onPasteLayerClipboard}
									title={layerClipboardLabel}
									aria-label={$_("layersInspector.pasteCopiedLayer")}
								>{$_("layersInspector.actionPaste")}</button>
							{/if}
							<button
								class="layer-action-btn"
								onclick={() => onDuplicateLayer(selectedLayer!.id)}
								title={$_("layersInspector.duplicateSelectedTextBox")}
								aria-label={$_("layersInspector.duplicateSelectedTextBox")}
							>{$_("layersInspector.actionDuplicate")}</button>
							<button
								class="layer-action-btn"
								onclick={() => onToggleLayerVisibility(selectedLayer!.id)}
								title={selectedLayer.visible === false ? $_("layersInspector.showSelectedTextBox") : $_("layersInspector.hideSelectedTextBox")}
								aria-label={selectedLayer.visible === false ? $_("layersInspector.showSelectedTextBox") : $_("layersInspector.hideSelectedTextBox")}
							>{selectedLayer.visible === false ? $_("layersInspector.actionShow") : $_("layersInspector.actionHide")}</button>
							<button
								class="layer-action-btn"
								onclick={() => onToggleLayerLock(selectedLayer!.id)}
								title={selectedLayer.locked === true ? $_("layersInspector.unlockSelectedTextBox") : $_("layersInspector.lockSelectedTextBox")}
								aria-label={selectedLayer.locked === true ? $_("layersInspector.unlockSelectedTextBox") : $_("layersInspector.lockSelectedTextBox")}
							>{selectedLayer.locked === true ? $_("layersInspector.actionUnlock") : $_("layersInspector.actionLock")}</button>
							<button
								class="layer-action-btn danger"
								onclick={() => requestDeleteTextLayer(selectedLayer!)}
								title={$_("layersInspector.deleteSelectedTextBox")}
								aria-label={$_("layersInspector.deleteSelectedTextBox")}
							>{$_("layersInspector.actionDelete")}</button>
						</div>
					{/if}
				</div>
				<div class="layer-property-group selected-text-property-group" aria-label={$_("layersInspector.textInSelectedBoxAria")}>
					<div class="layer-property-group-header">
						<span>{$_("layersInspector.badgeText")}</span>
						<small>{$_("layersInspector.editTranslationInBox")}</small>
						</div>
						<div>
							<label class="panel-label" for={controlIds.text}>{labels.text}</label>
							{#if selectedTextLayerLocked}
								<div class="selected-text-readonly" role="status" aria-label={$_("layersInspector.lockedTextLayerAria")}>
									<span>{selectedLayer.text || $_("layersInspector.effectsNoText")}</span>
									<small>{$_("layersInspector.unlockBeforeEditText")}</small>
								</div>
							{:else}
								<TextQaField
									id={controlIds.text}
									value={selectedLayer?.text ?? ""}
									lang={projectStore.activeTargetLang}
									projectId={projectStore.project?.projectId ?? projectId}
									rows={3}
									onInput={onSelectedTextChange}
									onApplySuggestion={onSelectedTextChange}
								/>
							{/if}
						</div>
					<button
						type="button"
						class="text-detail-toggle"
						aria-expanded={selectedTextDetailsOpen}
						aria-controls="selected-text-layer-details"
						onclick={() => selectedTextDetailsOpen = !selectedTextDetailsOpen}
					>
						<span>{$_("layersInspector.layerDetails")}</span>
						<small>{selectedLayer.name || $_("layersInspector.notNamed")}</small>
					</button>
						{#if selectedTextDetailsOpen}
							<div id="selected-text-layer-details" class="text-detail-panel">
								{#if selectedTextLayerLocked}
									<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedTextLayerNameAria")}>
										<span>{$_("layersInspector.labelLayerName")}</span>
										<strong>{selectedLayer.name?.trim() || selectedLayer.text || $_("layersInspector.stackMetaTextBox")}</strong>
									</div>
								{:else}
									<label class="panel-label" for={controlIds.textLayerName}>{$_("layersInspector.labelLayerName")}</label>
									<input
										id={controlIds.textLayerName}
										class="panel-input"
										type="text"
										placeholder={selectedLayer.text || $_("layersInspector.stackMetaTextBox")}
										value={selectedLayer.name ?? ""}
										oninput={updateSelectedTextLayerName}
									/>
								{/if}
							</div>
						{/if}
					</div>
				<details class="selected-text-format-drawer">
					<summary
						data-closed-label={$_("layersInspector.toggleOpen")}
						data-open-label={$_("layersInspector.toggleClose")}
					>
						<span>{$_("layersInspector.fontFormat")}</span>
						<small>{$_("layersInspector.fontSizePresetColor")}</small>
					</summary>
					<div class="selected-text-format-body">
				<div class="layer-property-group selected-text-property-group selected-text-preset-group" aria-label={$_("layersInspector.stylePresetAria")}>
					<div class="layer-property-group-header">
						<span>{$_("layersInspector.stylePreset")}</span>
						<small>{$_("layersInspector.presetAndSfx")}</small>
						</div>
						<div class="preset-block">
							{#if selectedTextLayerLocked}
								<span class="selected-layer-action-state wide">{$_("layersInspector.unlockBeforeChangePreset")}</span>
								<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedStylePresetAria")}>
									<span>{$_("layersInspector.currentStylePreset")}</span>
									<strong>{selectedPresetId ? (textStylePresets.find((preset) => preset.id === selectedPresetId)?.name ?? selectedPresetId) : $_("layersInspector.custom")}</strong>
								</div>
							{:else}
								<label class="panel-label" for={controlIds.textPreset}>{$_("layersInspector.stylePreset")}</label>
								<select
									id={controlIds.textPreset}
									class="panel-select"
									value={selectedPresetId}
									onchange={updateSelectedPreset}
								>
									<option value="">{$_("layersInspector.custom")}</option>
									{#each textStylePresets as preset (preset.id)}
										<option value={preset.id}>{preset.name}</option>
									{/each}
								</select>
								<div class="text-effect-suggester">
								<label class="panel-label" for={controlIds.textEffectPrompt}>{$_("layersInspector.stylePromptLabel")}</label>
									<input
										id={controlIds.textEffectPrompt}
										class="panel-input"
										type="text"
										placeholder={$_("layersInspector.stylePromptPlaceholder")}
										value={textEffectPrompt}
										oninput={updateTextEffectPrompt}
									/>
									{#if textEffectPrompt.trim()}
										<div class="preset-suggestion-grid" aria-label={$_("layersInspector.presetSuggestionsAria")}>
											{#if textEffectSuggestions.length}
												{#each textEffectSuggestions as preset (preset.id)}
													<button
														type="button"
														class="preset-suggestion-btn"
														class:active={selectedPresetId === preset.id}
														onclick={() => onSuggestedPresetApply(preset.id)}
														aria-label={$_("layersInspector.useSuggestedPreset", { values: { name: preset.name } })}
													>
														<span>{preset.name}</span>
														{#if preset.promptTags?.length}
															<small>{preset.promptTags.slice(0, 2).join(" / ")}</small>
														{/if}
													</button>
												{/each}
											{:else}
												<span class="preset-suggestion-empty">{$_("layersInspector.noNearbyPreset")}</span>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						<button
							type="button"
							class="text-detail-toggle"
							aria-expanded={selectedTextPresetSaveOpen}
							aria-controls="selected-text-preset-save"
							onclick={() => selectedTextPresetSaveOpen = !selectedTextPresetSaveOpen}
						>
							<span>{$_("layersInspector.saveAsStylePreset")}</span>
							<small>{canSaveTextStylePreset ? $_("layersInspector.readyToSave") : textStylePresetSaveHint}</small>
						</button>
						{#if selectedTextPresetSaveOpen}
							<div id="selected-text-preset-save" class="preset-save-row selected-text-preset-save-row">
								<input
									id={controlIds.presetName}
									class="panel-input preset-name-input"
									type="text"
									placeholder={$_("layersInspector.stylePresetNamePlaceholder")}
									value={presetName}
									oninput={updatePresetName}
								/>
								{#if canSaveTextStylePreset}
									<button
										class="panel-btn preset-save-btn"
										onclick={onSaveCurrentPreset}
										aria-label={$_("layersInspector.saveStylePresetAria")}
									>
										{$_("layersInspector.actionSave")}
									</button>
								{:else}
									<span class="preset-save-note" aria-label={$_("layersInspector.saveStylePresetStatusAria")}>{textStylePresetSaveHint}</span>
								{/if}
							</div>
						{/if}
						</div>
					</div>
					<div class="layer-property-group selected-text-property-group selected-text-font-group" aria-label={$_("layersInspector.fontSizeAria")}>
					<div class="layer-property-group-header">
						<span>{$_("layersInspector.font")}</span>
						<small>{$_("layersInspector.fontSizeFitBox")}</small>
						</div>
						{#if selectedTextLayerLocked}
							<span class="selected-layer-action-state wide">{$_("layersInspector.unlockBeforeFontSize")}</span>
							<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedFontSizeAria")}>
								<span>{$_("layersInspector.fontSlashSize")}</span>
								<strong>{selectedLayer.fontFamily || defaultFontFamily} / {selectedLayer.fontSize || defaultFontSize}px</strong>
							</div>
						{:else}
							<div>
								<span class="panel-label">{$_("layersInspector.labelFont")}</span>
								<FontPicker
									selectedFont={selectedLayer.fontFamily || defaultFontFamily}
									onFontChange={onFontChange}
								/>
							</div>
							<div>
								<span class="panel-label">{labels.fontSize}</span>
								<div class="font-size-row">
									<FontSizePicker
										selectedSize={selectedLayer.fontSize || defaultFontSize}
										onSizeChange={onFontSizeChange}
									/>
									<button
										id={controlIds.fitText}
										class="panel-btn fit-text-btn"
										onclick={onFitSelectedText}
										title={$_("layersInspector.fitTextTooltip")}
										aria-label={$_("layersInspector.fitTextAria")}
									>
										{$_("layersInspector.fitBox")}
									</button>
								</div>
							</div>
						{/if}
					<div class="text-box-size-controls" aria-label={$_("layersInspector.textBoxSizeAria")}>
						<div class="text-box-fit-summary" role="status" aria-label={$_("layersInspector.textBoxFitStatusAria")}>
							<strong>{selectedTextBoxSummary}</strong>
							{#if selectedTextNeedsFit}
								<small>{selectedTextFitDetail}</small>
							{/if}
						</div>
						<button
							type="button"
							class="text-detail-toggle"
							aria-expanded={selectedTextBoxToolsOpen}
							aria-controls="selected-text-box-tools"
							onclick={() => selectedTextBoxToolsOpen = !selectedTextBoxToolsOpen}
						>
							<span>{$_("layersInspector.textBoxDetailedSize")}</span>
							<small>{Math.round(selectedLayer.w)} x {Math.round(selectedLayer.h)}px</small>
							</button>
							{#if selectedTextBoxToolsOpen}
								<div id="selected-text-box-tools" class="text-box-number-grid">
									{#if selectedTextLayerLocked}
										<span class="selected-layer-action-state wide">{$_("layersInspector.unlockBeforeBoxSize")}</span>
										<div class="selected-image-readonly-field" role="status" aria-label={$_("layersInspector.lockedBoxSizeAria")}>
											<span>{$_("layersInspector.boxSize")}</span>
											<strong>{Math.round(selectedLayer.w)} x {Math.round(selectedLayer.h)}px</strong>
										</div>
									{:else}
										<label class="panel-label" for={controlIds.textBoxWidth}>
											<span>{$_("layersInspector.fillWidth")}</span>
											<input
												id={controlIds.textBoxWidth}
												class="panel-input"
												type="number"
												min="1"
												value={Math.round(selectedLayer.w)}
												oninput={(event) => updateSelectedTextBoxNumber(event, "w")}
											/>
										</label>
										<label class="panel-label" for={controlIds.textBoxHeight}>
											<span>{$_("layersInspector.fillHeight")}</span>
											<input
												id={controlIds.textBoxHeight}
												class="panel-input"
												type="number"
												min="1"
												value={Math.round(selectedLayer.h)}
												oninput={(event) => updateSelectedTextBoxNumber(event, "h")}
											/>
										</label>
										{#if selectedTextCanGrowBox}
											<button
												type="button"
												class="panel-btn text-box-grow-btn"
												onclick={expandSelectedTextBoxToFit}
												aria-label={$_("layersInspector.growBoxToTextAria")}
											>
												{$_("layersInspector.growToFit")}
											</button>
										{/if}
									{/if}
								</div>
							{/if}
					</div>
				</div>
				<div class="layer-property-group advanced selected-text-property-group selected-text-color-group" aria-label={$_("layersInspector.colorAlignAria")}>
					<div class="layer-property-group-header">
						<span>{$_("layersInspector.colorAlign")}</span>
						<small>{$_("layersInspector.openWhenColorStroke")}</small>
					</div>
					<button
						type="button"
						class="text-detail-toggle"
						aria-expanded={selectedTextStyleToolsOpen}
						aria-controls="selected-text-style-tools"
						onclick={() => selectedTextStyleToolsOpen = !selectedTextStyleToolsOpen}
					>
						<span>{$_("layersInspector.colorAlignStroke")}</span>
						<small>{selectedLayer.alignment} {$_("layersInspector.strokeMetaPrefix")} {Math.round((selectedLayer.strokeWidth ?? 2) * 10) / 10}px</small>
						</button>
						{#if selectedTextStyleToolsOpen}
							<div id="selected-text-style-tools" class="text-style-detail-panel">
								{#if selectedTextLayerLocked}
									<span class="selected-layer-action-state wide">{$_("layersInspector.unlockBeforeColorStroke")}</span>
									<div class="selected-text-style-readout" role="status" aria-label={$_("layersInspector.lockedColorStrokeAria")}>
										<div class="selected-image-readonly-field">
											<span>{$_("layersInspector.opacity")}</span>
											<strong>{Math.round((selectedLayer.opacity ?? 1) * 100)}%</strong>
										</div>
										<div class="selected-image-readonly-field">
											<span>{$_("layersInspector.fontColor")}</span>
											<strong>{normalizeColor(selectedLayer.fill, defaultTextFill)}</strong>
										</div>
										<div class="selected-image-readonly-field">
											<span>{$_("layersInspector.alignment")}</span>
											<strong>{selectedLayer.alignment}</strong>
										</div>
										<div class="selected-image-readonly-field">
											<span>{$_("layersInspector.strokeColorWidth")}</span>
											<strong>{normalizeColor(selectedLayer.stroke, defaultTextStroke)} / {Math.round((selectedLayer.strokeWidth ?? 2) * 10) / 10}px</strong>
										</div>
									</div>
								{:else}
									<div class="style-grid">
										<div>
											<label class="panel-label" for={controlIds.textOpacity}>
												{$_("layersInspector.labelTextOpacityColon")} {Math.round((selectedLayer.opacity ?? 1) * 100)}%
											</label>
											<input
												id={controlIds.textOpacity}
												class="panel-input"
												type="range"
												min="0"
												max="100"
												step="1"
												value={Math.round((selectedLayer.opacity ?? 1) * 100)}
												oninput={updateSelectedTextOpacity}
												onchange={updateSelectedTextOpacity}
											/>
										</div>
										<label class="panel-label style-field" for={controlIds.fill}>
											<span>{$_("layersInspector.fontColor")}</span>
											<span class="fill-color-controls">
												<input
													id={controlIds.fill}
													class="panel-color-input"
													type="color"
													value={normalizeColor(selectedLayer.fill, defaultTextFill)}
													oninput={updateSelectedFill}
													onchange={updateSelectedFill}
												/>
												{#if eyedropperSupported}
													<button
														type="button"
														class="ws-btn-ghost fill-eyedropper"
														disabled={selectedTextLayerLocked || eyedropperBusy}
														title={$_("layersInspector.eyedropperTitle")}
														aria-label={$_("layersInspector.eyedropperTitle")}
														onclick={pickFillWithEyedropper}
													>💧</button>
												{/if}
											</span>
										</label>
									</div>
									<div>
										<label class="panel-label" for={controlIds.alignment}>{labels.alignment}</label>
										<select
											id={controlIds.alignment}
											class="panel-select"
											value={selectedLayer.alignment}
											onchange={updateSelectedAlignment}
										>
											<option value="left">{labels.alignmentLeft}</option>
											<option value="center">{labels.alignmentCenter}</option>
											<option value="right">{labels.alignmentRight}</option>
										</select>
									</div>
									<div class="base-stroke-grid">
										<label class="panel-label style-field" for={controlIds.stroke}>
											<span>{$_("layersInspector.strokeColor")}</span>
											<input
												id={controlIds.stroke}
												class="panel-color-input"
												type="color"
												value={normalizeColor(selectedLayer.stroke, defaultTextStroke)}
												oninput={updateSelectedStroke}
												onchange={updateSelectedStroke}
											/>
										</label>
										<div>
											<label class="panel-label" for={controlIds.strokeWidth}>
												{$_("layersInspector.labelStrokeWidthColon")} {Math.round((selectedLayer.strokeWidth ?? 2) * 10) / 10}px
											</label>
											<input
												id={controlIds.strokeWidth}
												class="panel-input"
												type="range"
												min="0"
												max="12"
												step="0.5"
												value={selectedLayer.strokeWidth ?? 2}
												oninput={updateSelectedStrokeWidth}
												onchange={updateSelectedStrokeWidth}
											/>
										</div>
										<div>
											<label class="panel-label" for={controlIds.charSpacing}>
												{$_("layersInspector.labelCharSpacingColon")} {Math.round(selectedLayer.charSpacing ?? 0)}
											</label>
											<input
												id={controlIds.charSpacing}
												class="panel-input"
												type="range"
												min="-50"
												max="300"
												step="5"
												value={selectedLayer.charSpacing ?? 0}
												oninput={updateSelectedCharSpacing}
												onchange={updateSelectedCharSpacing}
											/>
										</div>
									</div>
								{/if}
							</div>
						{/if}
				</div>
					</div>
				</details>
			{:else}
				<div>
					<span class="panel-label">{labels.canvas}</span>
					<span style="color: var(--editor-text-dim); font-size: 11px;">
						{canvasDimensions.width} x {canvasDimensions.height}
					</span>
				</div>
				<div>
					<label class="panel-label" for={controlIds.aspectRatio}>{labels.aspectRatio}</label>
					<select
						id={controlIds.aspectRatio}
						class="panel-select"
						value={selectedAspectRatio}
						onchange={updateAspectRatio}
					>
							{#each Object.keys(aspectRatios) as name (name)}
								<option value={name}>{formatAspectRatioDisplayName(name)}</option>
							{/each}
					</select>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if !activeAiPlacementMarker && (!focusedLayerToolsCollapsed || layerShortcutsExpanded)}
	<EffectsHost
		{effectsOpen}
		hasSelectedTextLayer={Boolean(selectedLayer)}
		{sectionToggleLabel}
		onToggleOpen={() => effectsOpen = !effectsOpen}
	/>
{/if}
<LayerDeleteDialog
	{pendingDeleteAction}
	onConfirm={confirmPendingDelete}
	onCancel={() => pendingDeleteAction = null}
/>
</div>

<style>
	/* ── W3.3 inspector reskin → ws-* design tokens ──
	   Remap the legacy --editor-* palette to the unified workspace palette
	   (app.css @theme --color-ws-*). Scoped to .layers-inspector so the whole
	   subtree — including the extracted atoms (LayerStack / AssetBrowser /
	   EffectsHost / BulkLayerActions) that reuse the parent's global classes —
	   adopts the ws surfaces, hairlines, and violet→fuchsia accent without
	   touching the markup. Purely visual; no behavior/a11y change. */
	.layers-inspector {
		display: flex;
		min-height: 0;
		flex-direction: column;
		--editor-bg: var(--color-ws-bg, #0b0b0f);
		--editor-surface: var(--color-ws-surface, #15151d);
		--editor-surface-raised: var(--color-ws-surface2, #1c1c26);
		--editor-border: var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		--editor-border-soft: var(--ws-hair, rgba(255, 255, 255, 0.07));
		--editor-text: var(--color-ws-ink, #ececf2);
		--editor-text-dim: var(--color-ws-text, #9a9aa8);
		--editor-text-muted: var(--color-ws-faint, #6b6b78);
		--editor-muted: var(--color-ws-faint, #6b6b78);
		--editor-accent: var(--color-ws-accent, #7c5cff);
		--editor-accent-hover: var(--color-ws-violet, #8b5cf6);
		--editor-success: var(--color-ws-green, #34d399);
		--editor-warning: var(--color-ws-amber, #fbbf24);
		--editor-danger: var(--color-ws-rose, #fb7185);
		font-family: var(--font-ws-sans);
	}

	.layers-inspector.ai-result-focus #properties-section {
		order: 1;
	}

	.layers-inspector.ai-result-focus .selection-focus-card {
		order: 0;
	}

	.layers-inspector.ai-result-focus #credit-section,
	.layers-inspector.ai-result-focus #image-layers-section,
	.layers-inspector.ai-result-focus #text-layers-section,
	.layers-inspector.ai-result-focus :global(#effects-section) {
		order: 2;
	}

	.layers-inspector.ai-result-focus #properties-section > .panel-section-header {
		display: none;
	}

	.layers-inspector.ai-placement-focus #properties-section {
		order: 1;
	}

	.layers-inspector.ai-placement-focus #properties-section > .panel-section-header {
		display: none;
	}

	.layers-inspector.selected-editable-focus .selection-focus-card {
		order: 0;
		position: sticky;
		top: 0;
		z-index: 8;
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.3);
		backdrop-filter: blur(14px);
	}

	.layers-inspector.selected-editable-focus #properties-section {
		order: 1;
	}

	.layers-inspector.selected-editable-focus :global(.unified-layer-stack) {
		order: 2;
	}

	.layers-inspector.selected-editable-focus .layer-tools-drawer,
	.layers-inspector.selected-editable-focus .layer-jumpbar {
		order: 3;
	}

	.layers-inspector.selected-editable-focus .layer-jumpbar {
		position: static;
		top: auto;
		z-index: 1;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		padding-top: 0;
		background: transparent;
	}

	.layers-inspector.selected-editable-focus #credit-section,
	.layers-inspector.selected-editable-focus #image-layers-section,
	.layers-inspector.selected-editable-focus #text-layers-section,
	.layers-inspector.selected-editable-focus :global(#effects-section) {
		order: 4;
	}

	.layers-inspector.selected-editable-focus #properties-section > .panel-section-header {
		display: none;
	}

	.layers-inspector.selected-editable-focus .selection-focus-copy span {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		white-space: normal;
	}

	.layers-inspector.credit-workflow-focus .selection-focus-card {
		position: static;
		box-shadow: none;
	}

	.layers-inspector.credit-workflow-focus .selection-focus-copy span {
		-webkit-line-clamp: 1;
	}

	.layers-inspector.credit-workflow-focus #properties-section {
		order: 1;
	}

	.layers-inspector.credit-workflow-focus #properties-section > .panel-section-header {
		display: none;
	}

	.layers-inspector.credit-workflow-focus :global(.unified-layer-stack) {
		order: 2;
	}

	.layers-inspector.credit-workflow-focus .layer-tools-drawer,
	.layers-inspector.credit-workflow-focus .layer-jumpbar {
		order: 3;
	}

	.layers-inspector.credit-workflow-focus .layer-jumpbar {
		display: none;
	}

	.layers-inspector.credit-workflow-focus #credit-section,
	.layers-inspector.credit-workflow-focus #image-layers-section,
	.layers-inspector.credit-workflow-focus #text-layers-section,
	.layers-inspector.credit-workflow-focus :global(#effects-section) {
		order: 4;
	}

	.layers-inspector.ai-result-focus #properties-section .selected-layer-summary {
		display: none;
	}

	.selection-focus-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
		padding: 9px 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.03);
	}

	.selection-focus-card.has-selection {
		position: sticky;
		top: 0;
		z-index: 8;
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 32%, transparent);
		background: linear-gradient(135deg, rgba(139, 92, 246, 0.14), rgba(217, 70, 239, 0.08));
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.3);
		backdrop-filter: blur(14px);
	}

	.selection-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.selection-focus-copy small {
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 850;
	}

	.selection-focus-copy strong,
	.selection-focus-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selection-focus-copy strong {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 850;
	}

	.selection-focus-copy span {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 700;
	}

	.selection-focus-copy b {
		color: #9ff3d9;
		font-weight: 900;
	}

	.selection-focus-action {
		min-height: 40px;
		padding: 0 10px;
	}

	.selection-focus-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 5px;
		min-width: 0;
	}

	.selection-stack-pill,
	.selection-edit-pill,
	.selection-focus-actions button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.2);
		color: var(--editor-text);
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	.selection-stack-pill {
		padding: 0 8px;
		color: #dbeafe;
	}

	.selection-edit-pill {
		padding: 0 8px;
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 26%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.selection-focus-actions button {
		padding: 0;
		cursor: pointer;
		min-width: 40px;
	}

	.selection-focus-actions .selection-edit-button {
		padding: 0 8px;
	}

	.selected-stack-context {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		min-width: 0;
	}

	.selected-stack-context-item {
		display: grid;
		min-width: 0;
		gap: 2px;
		min-height: 56px;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
		border-radius: 7px;
		background: rgba(0, 0, 0, 0.18);
	}

	.selected-stack-context-item.current {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 36%, transparent);
		background: rgba(139, 92, 246, 0.12);
	}

	.selected-stack-context-item.muted {
		color: var(--editor-text-muted);
	}

	.selected-stack-context-item.edge-empty {
		min-height: 42px;
		opacity: 0.78;
	}

	.selected-stack-context-item.edge-empty > span {
		display: none;
	}

	.selected-stack-context-item small,
	.selected-stack-context-item strong,
	.selected-stack-context-item span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-stack-context-item small {
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 850;
	}

	.selected-stack-context-item strong {
		color: var(--editor-text);
		font-size: 10px;
		font-weight: 850;
	}

	.selected-stack-context-item span {
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 700;
	}

	@media (max-width: 1040px) {
		.layers-inspector.selected-editable-focus .selection-focus-card,
		.selection-focus-card.has-selection {
			position: static;
			grid-template-columns: minmax(0, 1fr);
			align-items: stretch;
			box-shadow: none;
		}

		.selection-focus-actions {
			justify-content: flex-start;
		}

		.selected-stack-context {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 4px;
		}

		.selected-stack-context-item {
			min-height: 44px;
			padding: 5px 6px;
		}

		.selected-stack-context-item.edge-empty {
			min-height: 40px;
		}

		.selected-stack-context-item small {
			font-size: 8px;
		}

		.selected-stack-context-item strong,
		.selected-stack-context-item span {
			font-size: 8.5px;
		}
	}

	.selection-focus-badge {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 26%, transparent);
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.18);
		color: var(--color-ws-ink, #ececf2);
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	.layer-stack-overview {
		display: grid;
		gap: 5px;
		margin-bottom: 8px;
		padding: 7px;
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 78%, transparent);
	}

	.layer-stack-row {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 42px;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 58%, transparent);
	}

	.layer-stack-row.base {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, var(--color-ws-surface, #15151d));
	}

	.layer-stack-row.editable.empty {
		border-style: dashed;
		color: var(--color-ws-text, #9a9aa8);
	}

	.layer-stack-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-bg, #0b0b0f) 64%, transparent);
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		font-weight: 900;
	}

	.layer-stack-copy {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.layer-stack-copy strong,
	.layer-stack-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-stack-copy strong {
		color: var(--color-ws-ink, #ececf2);
		font-size: 11px;
		font-weight: 880;
	}

	.layer-stack-copy small {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 700;
	}

	.layer-stack-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 34px;
		min-height: 24px;
		padding: 0 7px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 72%, transparent);
		color: var(--color-ws-ink, #ececf2);
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	/*
	 * `.unified-layer-stack` styles below are wrapped with `:global()`
	 * because the markup now lives in inspector/LayerStack.svelte (W0.7).
	 */
	:global(.unified-layer-stack) {
		display: grid;
		gap: 7px;
		margin-bottom: 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 24%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-green, #34d399) 9%, transparent), color-mix(in srgb, var(--color-ws-violet, #8b5cf6) 8%, transparent)),
			color-mix(in srgb, var(--color-ws-surface, #15151d) 84%, transparent);
	}

	:global(.unified-layer-stack.selected-layer-stack) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-green, #34d399) 6%, transparent), color-mix(in srgb, var(--color-ws-violet, #8b5cf6) 6%, transparent)),
			color-mix(in srgb, var(--color-ws-surface, #15151d) 78%, transparent);
	}

	:global(.unified-stack-summary) {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		min-height: 40px;
		padding: 0;
		border-radius: var(--radius-ws-ctrl, 10px);
		cursor: pointer;
		list-style: none;
	}

	:global(.unified-stack-summary::-webkit-details-marker) {
		display: none;
	}

	/* Decorative expand/collapse glyphs stay language-neutral; screen readers use
	   the localized summary aria-labels instead of pseudo-element text. */
	:global(.unified-stack-summary::after) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 62%, transparent);
		color: var(--color-ws-ink, #ececf2);
		content: var(--unified-stack-toggle-closed, "▾");
		font-size: 10px;
		font-weight: 860;
	}

	:global(.unified-layer-stack[open] > .unified-stack-summary::after) {
		content: var(--unified-stack-toggle-open, "▴");
	}

	:global(.unified-stack-summary div) {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	:global(.unified-stack-summary span) {
		color: var(--color-ws-cyan, #22d3ee);
		font-size: 10px;
		font-weight: 900;
	}

	:global(.unified-stack-summary strong) {
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		font-weight: 900;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.unified-stack-summary small) {
		max-width: 126px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 9px;
		font-weight: 760;
		line-height: 1.25;
		text-align: right;
	}

	:global(.unified-layer-stack.selected-layer-stack:not([open]) > .unified-stack-summary small) {
		max-width: 142px;
	}

	:global(.unified-stack-list) {
		display: grid;
		gap: 5px;
	}

	:global(.unified-stack-filter) {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
		margin: 6px 0 5px;
	}

	:global(.unified-stack-filter button) {
		min-width: 40px;
		min-height: 40px;
		padding: 0 5px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 56%, transparent);
		color: var(--color-ws-faint, #8a8a98);
		font-size: 9px;
		font-weight: 860;
		cursor: pointer;
	}

	:global(.unified-stack-filter button:hover),
	:global(.unified-stack-filter button.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 48%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-ink, #ececf2);
	}

	:global(.unified-stack-filter-note),
	:global(.unified-stack-empty) {
		margin: 0 0 5px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 9px;
		font-weight: 720;
		line-height: 1.25;
	}

	:global(.unified-stack-empty) {
		display: flex;
		align-items: center;
		min-height: 40px;
		padding: 0 8px;
		border: 1px dashed var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	:global(.unified-layer-stack:not([open]) > .unified-stack-list) {
		display: none;
	}

	:global(.unified-layer-stack:not([open]) > .unified-stack-filter),
	:global(.unified-layer-stack:not([open]) > .unified-stack-filter-note) {
		display: none;
	}

	:global(.unified-stack-row) {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: stretch;
		gap: 5px;
		min-height: 46px;
		padding: 5px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 56%, transparent);
	}

	:global(.unified-stack-row.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 52%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, var(--color-ws-surface2, #1c1c26));
	}

	:global(.unified-stack-row.hidden-layer) {
		opacity: 0.64;
	}

	:global(.unified-stack-row.base) {
		border-style: dashed;
		background: color-mix(in srgb, var(--color-ws-bg, #0b0b0f) 48%, transparent);
	}

	:global(.unified-stack-select) {
		display: grid;
		grid-template-columns: 42px minmax(0, 1fr);
		align-items: center;
		gap: 7px;
		width: 100%;
		min-width: 100%;
		min-height: 40px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	:global(.unified-stack-select.static) {
		cursor: default;
	}

	:global(.unified-stack-badge) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 42px;
		height: 30px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-violet, #8b5cf6) 16%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-cyan, #22d3ee);
		font-size: 10px;
		font-weight: 900;
	}

	:global(.unified-stack-badge.ai-badge) {
		border-color: color-mix(in srgb, var(--color-ws-rose, #fb7185) 32%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-rose, #fb7185) 14%, var(--color-ws-surface2, #1c1c26));
	}

	:global(.unified-stack-badge.credit-badge) {
		border-color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 38%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 13%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-amber, #fbbf24);
	}

	:global(.unified-stack-badge.base-badge) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 11%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-ink, #ececf2);
	}

	:global(.unified-stack-copy) {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	:global(.unified-stack-copy strong),
	:global(.unified-stack-copy small) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.unified-stack-copy strong) {
		color: var(--color-ws-ink, #ececf2);
		font-size: 11px;
		font-weight: 860;
	}

	:global(.unified-stack-copy small) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 9px;
		font-weight: 720;
	}

	:global(.unified-stack-actions) {
		display: grid;
		grid-template-columns: repeat(4, minmax(40px, 1fr));
		gap: 3px;
	}

	:global(.unified-stack-action),
	:global(.unified-stack-lock) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 5px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 62%, transparent);
		color: var(--color-ws-faint, #8a8a98);
		font-size: 9px;
		font-weight: 820;
		cursor: pointer;
	}

	:global(button.unified-stack-action:hover) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 46%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		color: var(--color-ws-ink, #ececf2);
	}

	:global(.unified-stack-action-receipt) {
		opacity: 0.32;
		cursor: default;
	}

	:global(.unified-stack-lock) {
		width: 100%;
		cursor: default;
	}

	.next-layer-action-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 9px;
		margin-bottom: 8px;
		padding: 10px;
		border: 1px solid rgba(96, 165, 250, 0.24);
		border-radius: 8px;
		background:
			linear-gradient(135deg, rgba(34, 197, 94, 0.11), rgba(59, 130, 246, 0.08)),
			rgba(255, 255, 255, 0.035);
	}

	.next-layer-action-card.library-entry-start {
		gap: 10px;
		margin-bottom: 6px;
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, transparent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 13%, transparent), rgba(139, 92, 246, 0.09)),
			rgba(255, 255, 255, 0.04);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
	}

	.next-layer-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.next-layer-copy small {
		color: #9bdcff;
		font-size: 9px;
		font-weight: 850;
	}

	.next-layer-copy strong {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 880;
		line-height: 1.25;
	}

	.next-layer-copy span {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.35;
	}

	.next-layer-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 7px;
	}

	.next-layer-actions .panel-btn {
		min-height: 40px;
		padding: 0 8px;
	}

	.next-layer-action-state {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		grid-column: 1 / -1;
		padding: 0 10px;
		border: 1px solid rgba(237, 177, 92, 0.22);
		border-radius: 8px;
		background: rgba(31, 23, 12, 0.42);
		color: #f2d39a;
		font-size: 10px;
		font-weight: 780;
		line-height: 1.25;
		text-align: center;
		overflow-wrap: anywhere;
	}

	.layer-tools-drawer {
		margin: 0 0 6px;
	}

	.layer-tools-toggle {
		display: flex;
		width: 100%;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 0 10px;
		border: 1px solid rgba(166, 183, 220, 0.13);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.035);
		color: var(--editor-text-muted);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
	}

	.layer-tools-toggle:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 34%, transparent);
		background: rgba(217, 70, 239, 0.1);
		color: var(--editor-text);
	}

	.layer-tools-toggle span,
	.layer-tools-toggle strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-tools-toggle span {
		font-size: 11px;
		font-weight: 820;
	}

	.layer-tools-toggle strong {
		color: var(--editor-text);
		font-size: 10px;
		font-weight: 880;
	}

	.layer-jumpbar {
		position: sticky;
		top: -12px;
		z-index: 5;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(82px, 1fr));
		gap: 6px;
		margin: 0 0 8px;
		padding: 7px 0 8px;
		background: linear-gradient(180deg, #1c1e22 0%, rgba(28, 30, 34, 0.94) 76%, rgba(28, 30, 34, 0));
	}

	.layer-jumpbar button {
		display: flex;
		min-width: 0;
		min-height: 40px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		padding: 5px 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--editor-text-dim);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
	}

	.layer-jumpbar button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 48%, transparent);
		background: rgba(217, 70, 239, 0.14);
		color: var(--editor-text);
	}

	.layer-jumpbar span,
	.layer-jumpbar strong {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-jumpbar span {
		font-size: 10px;
		font-weight: 820;
	}

	.layer-jumpbar strong {
		color: var(--editor-text);
		font-size: 10px;
		font-weight: 850;
	}

	@media (max-width: 980px) {
		.layer-jumpbar {
			position: static;
			padding-top: 0;
			background: transparent;
		}
	}

	:global(.layers-section-header) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 18px;
		align-items: center;
		gap: 8px;
		text-transform: none;
		width: 100%;
		text-align: left;
	}

	.credit-textarea {
		min-height: 92px;
		padding-top: 8px;
		line-height: 1.4;
		resize: vertical;
		white-space: pre-wrap;
	}

	.selected-credit-edit-strip {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 7%, transparent);
	}

	.selected-credit-edit-strip div {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.selected-credit-edit-strip span,
	.selected-credit-edit-strip strong,
	.selected-credit-edit-strip small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-credit-edit-strip span {
		color: #9bdcff;
		font-size: 10px;
		font-weight: 900;
	}

	.selected-credit-edit-strip strong {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 900;
	}

	.selected-credit-edit-strip small {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 760;
	}

	.credit-admin-toggle {
		min-width: 108px;
		min-height: 40px;
		padding: 0 10px;
		border: 1px solid rgba(143, 184, 255, 0.16);
		border-radius: 6px;
		background: rgba(143, 184, 255, 0.075);
		color: #d7e7ff;
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
	}

	.credit-scope-card {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
		border-radius: 6px;
		background: linear-gradient(135deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 7%, transparent), rgba(76, 111, 255, 0.04));
	}

	.credit-scope-card div {
		min-width: 0;
	}

	.credit-scope-card span,
	.credit-scope-card strong {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-scope-card span {
		color: #9bdcff;
		font-size: 9px;
		font-weight: 850;
	}

	.credit-scope-card strong {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 820;
		line-height: 1.35;
	}

	.credit-help-drawer {
		border: 1px solid rgba(143, 184, 255, 0.12);
		border-radius: 6px;
		background: rgba(9, 13, 24, 0.34);
	}

	.credit-help-drawer > summary {
		min-height: 40px;
		padding: 9px 10px;
		color: var(--editor-muted);
		font-size: 12px;
		font-weight: 850;
		cursor: pointer;
	}

	.credit-help-drawer[open] > summary {
		border-bottom: 1px solid rgba(143, 184, 255, 0.1);
	}

	.credit-workflow-strip {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		padding: 8px;
	}

	.credit-workflow-strip div {
		display: grid;
		min-width: 0;
		gap: 3px;
		padding: 8px;
		border: 1px solid rgba(143, 184, 255, 0.12);
		border-radius: 6px;
		background: rgba(143, 184, 255, 0.045);
	}

	.credit-workflow-strip span {
		color: #9bdcff;
		font-size: 10px;
		font-weight: 900;
	}

	.credit-workflow-strip strong {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 820;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.credit-scope-switch {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.credit-scope-switch button {
		display: grid;
		min-width: 0;
		min-height: 46px;
		align-content: center;
		gap: 3px;
		padding: 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.045);
		color: var(--editor-text);
		cursor: pointer;
		text-align: left;
	}

	.credit-scope-switch button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, transparent);
	}

	.credit-scope-switch span,
	.credit-scope-switch small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-scope-switch span {
		color: #f4fbff;
		font-size: 11px;
		font-weight: 900;
	}

	.credit-scope-switch small {
		color: var(--editor-text-muted);
		font-size: 9px;
		font-weight: 720;
	}

	@media (max-width: 980px) {
		.credit-workflow-strip {
			grid-template-columns: minmax(0, 1fr);
		}

		.credit-scope-switch span,
		.credit-scope-switch small {
			white-space: normal;
		}
	}

	.credit-action-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 6px;
	}

	.credit-action-row .panel-btn-primary {
		grid-column: 1 / -1;
	}

	.credit-action-hint {
		display: flex;
		min-height: 32px;
		grid-column: 1 / -1;
		align-items: center;
		justify-content: flex-start;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 6%, transparent);
		color: rgba(194, 245, 235, 0.82);
		font-size: 11px;
		font-weight: 800;
		line-height: 1.25;
		padding: 6px 8px;
		text-align: left;
	}

	.credit-workflow-note {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 5.5%, transparent);
	}

	.credit-workflow-note span,
	.credit-workflow-note small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.credit-workflow-note span {
		color: #c8ffe8;
		font-size: 11px;
		font-weight: 820;
		line-height: 1.35;
	}

	.credit-workflow-note small {
		color: var(--editor-text-muted);
		font-size: 10px;
		line-height: 1.35;
	}

	.credit-delete-quick-card {
		display: grid;
		gap: 7px;
		padding: 8px;
		border: 1px solid rgba(255, 107, 153, 0.18);
		border-radius: 7px;
		background: linear-gradient(135deg, rgba(255, 107, 153, 0.075), rgba(0, 0, 0, 0.08));
	}

	.credit-delete-quick-copy {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.credit-delete-quick-copy span,
	.credit-delete-quick-copy strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-delete-quick-copy span {
		color: #ffd1de;
		font-size: 11px;
		font-weight: 900;
	}

	.credit-delete-quick-copy strong {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 760;
	}

	.credit-advanced-details {
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.026);
		overflow: clip;
	}

	.credit-advanced-details summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px;
		cursor: pointer;
		list-style: none;
	}

	.credit-advanced-details summary::-webkit-details-marker {
		display: none;
	}

	.credit-advanced-details summary span,
	.credit-advanced-details summary strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-advanced-details summary span {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
	}

	.credit-advanced-details summary strong {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 760;
		max-width: 132px;
	}

	.credit-advanced-details[open] summary {
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}

	.credit-advanced-details.danger summary span {
		color: #ffd1de;
	}

	.credit-image-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		align-items: end;
		gap: 8px;
		padding: 8px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: transparent;
		border-width: 0;
	}

	.credit-delete-scope-control {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: end;
		gap: 6px;
	}

	.credit-delete-scope-control .panel-label {
		grid-column: 1 / -1;
	}

	.credit-delete-scope-control .panel-select,
	.credit-delete-scope-control .panel-btn {
		min-height: 40px;
	}

	.credit-delete-scope-detail {
		display: block;
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-image-grid .panel-input {
		min-height: 40px;
	}

	.credit-helper {
		margin: -2px 0 0;
		color: var(--editor-text-muted);
		font-size: 11px;
		line-height: 1.45;
	}

	.credit-helper.danger-helper {
		margin: 0;
		padding: 8px;
		color: #ffc2d5;
	}

	.danger-soft {
		border-color: rgba(255, 107, 153, 0.28);
		color: #ffc2d5;
	}

	.danger-soft:hover {
		border-color: rgba(255, 107, 153, 0.56);
		background: rgba(255, 107, 153, 0.1);
		color: #ffd8e6;
	}

	:global(.layers-section-copy) {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	:global(.layers-section-copy > span) {
		overflow: hidden;
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	:global(.layers-section-copy small) {
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	:global(.layers-section-meter) {
		min-width: 0;
		max-width: 112px;
		overflow: hidden;
		padding: 4px 7px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 780;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	:global(.layers-section-meter.attention) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 38%, transparent);
		background: rgba(217, 70, 239, 0.15);
		color: #9bdcff;
	}

	:global(.layers-section-chevron) {
		justify-self: end;
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--editor-text-dim);
		border-bottom: 1.5px solid var(--editor-text-dim);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	:global(.layers-section-header:hover .layers-section-chevron),
	:global(.layers-section-chevron.open) {
		border-color: var(--editor-text);
	}

	:global(.layers-section-chevron.open) {
		transform: rotate(45deg);
	}

	.layer-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.layer-panel-toolbar {
		display: grid;
		grid-template-columns: minmax(0, 112px) minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.layer-place-btn {
		min-height: 40px;
		padding: 0 10px;
		font-size: 11px;
	}

	.image-layer-toolbar {
		grid-template-columns: minmax(0, 104px) minmax(0, 1fr);
	}

	.layer-toolbar-hint {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-toolbar-hint.action-unavailable {
		grid-column: 1 / -1;
		border: 1px solid rgba(125, 211, 252, 0.2);
		border-radius: 8px;
		background: rgba(125, 211, 252, 0.08);
		padding: 10px;
		color: #bfdbfe;
		font-weight: 800;
		text-overflow: clip;
		white-space: normal;
	}

	/*
	 * `.asset-*` styles below are wrapped with `:global()` because the
	 * markup now lives in inspector/AssetBrowser.svelte (W0.7).
	 */
	:global(.asset-library-drawer) {
		margin: 0 0 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 7%, var(--color-ws-surface, #15151d));
	}

	:global(.asset-library-summary) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 0 9px;
		color: var(--color-ws-ink, #ececf2);
		cursor: pointer;
		list-style: none;
	}

	:global(.asset-library-summary::-webkit-details-marker) {
		display: none;
	}

	:global(.asset-library-summary span),
	:global(.asset-library-summary small) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-library-summary span) {
		font-size: 11px;
		font-weight: 850;
	}

	:global(.asset-library-summary small) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 720;
	}

	:global(.asset-library-body) {
		padding: 0 8px 8px;
	}

	:global(.asset-replacement-mode-card) {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
		margin: 0 0 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green, #34d399) 28%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-green, #34d399) 10%, var(--color-ws-surface, #15151d));
	}

	:global(.asset-replacement-mode-card span),
	:global(.asset-replacement-mode-card small) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	:global(.asset-replacement-mode-card span) {
		color: color-mix(in srgb, var(--color-ws-green, #34d399) 72%, var(--color-ws-ink, #ececf2));
		font-size: 11px;
		font-weight: 850;
		white-space: nowrap;
	}

	:global(.asset-replacement-mode-card small) {
		color: color-mix(in srgb, var(--color-ws-green, #34d399) 34%, var(--color-ws-text, #9a9aa8));
		font-size: 10px;
		line-height: 1.35;
	}

	:global(.asset-library-filter-row) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 44px;
		align-items: center;
		gap: 6px;
		margin: 0 0 6px;
	}

	:global(.asset-filter-input) {
		min-width: 0;
		min-height: 36px;
		font-size: 11px;
	}

	:global(.asset-filter-count) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		text-align: right;
		white-space: nowrap;
	}

	:global(.asset-view-toggle) {
		display: grid;
		grid-template-columns: repeat(2, minmax(44px, 1fr));
		gap: 3px;
		align-items: center;
	}

	:global(.asset-view-toggle button) {
		min-height: 40px;
		padding: 0 6px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 56%, transparent);
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 700;
		cursor: pointer;
	}

	:global(.asset-view-toggle button:hover) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 48%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		color: var(--color-ws-ink, #ececf2);
	}

	:global(.asset-view-toggle button.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 66%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-ink, #ececf2);
	}

	:global(.asset-reuse-row) {
		display: grid;
		grid-template-columns: 44px minmax(0, 1fr) 70px 70px;
		align-items: end;
		gap: 6px;
		margin: 0 0 8px;
	}

	:global(.asset-reuse-select-label) {
		padding-bottom: 6px;
	}

	:global(.asset-reuse-select) {
		min-width: 0;
		min-height: 40px;
		font-size: 11px;
	}

	:global(.asset-reuse-btn) {
		min-height: 40px;
		padding: 0 10px;
		font-size: 11px;
	}

	:global(.asset-reuse-note),
	:global(.image-layer-bulk-note) {
		display: flex;
		align-items: center;
		justify-content: center;
		grid-column: 1 / -1;
		min-height: 40px;
		padding: 0 8px;
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
		text-align: center;
		white-space: normal;
	}

	:global(.asset-reuse-note) {
		grid-column: span 2;
		border: 1px dashed var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 44%, transparent);
		color: var(--color-ws-text, #9a9aa8);
	}

	:global(.image-layer-bulk-note) {
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 4px;
		color: var(--editor-text-dim);
	}

	:global(.image-layer-bulk-row) {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
		margin: 0 0 8px;
	}

	.image-layer-role-filter {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
		margin: 0 0 6px;
	}

	.image-layer-role-filter button {
		min-height: 40px;
		min-width: 0;
		padding: 0 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.03);
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 750;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.image-layer-role-filter button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 44%, transparent);
		color: var(--editor-text);
	}

	.image-layer-role-filter button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 68%, transparent);
		background: rgba(217, 70, 239, 0.2);
		color: var(--editor-text);
	}


	/* .layer-delete-* styles moved to ./inspector/LayerDeleteDialog.svelte (W0.3). */

	:global(.asset-browser-list) {
		display: flex;
		max-height: 148px;
		flex-direction: column;
		gap: 4px;
		margin: 0 0 8px;
		overflow-y: auto;
	}

	:global(.asset-browser-more-row) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-height: 36px;
		margin: -2px 0 8px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 11%, var(--color-ws-surface2, #1c1c26));
		color: var(--color-ws-cyan, #22d3ee);
		font-size: 11px;
		font-weight: 760;
		text-align: left;
		cursor: pointer;
	}

	:global(.asset-browser-more-row:hover) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 56%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 17%, var(--color-ws-surface2, #1c1c26));
	}

	:global(.asset-browser-more-row span) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 650;
	}

	:global(.asset-browser-grid) {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		max-height: 220px;
		align-items: start;
	}

	:global(.asset-browser-row) {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr) 64px;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 44px;
		padding: 6px 7px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 50%, transparent);
		color: var(--color-ws-ink, #ececf2);
		text-align: left;
		cursor: pointer;
	}

	:global(.asset-browser-grid .asset-browser-row) {
		grid-template-columns: minmax(0, 1fr);
		align-items: stretch;
		gap: 6px;
		min-height: 114px;
		padding: 6px;
	}

	:global(.asset-browser-grid .asset-browser-main) {
		gap: 3px;
	}

	:global(.asset-browser-grid .asset-browser-thumb) {
		width: 100%;
		height: 62px;
	}

	:global(.asset-browser-grid .asset-browser-id) {
		width: fit-content;
		max-width: 100%;
	}

	:global(.asset-browser-row:hover) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, var(--color-ws-surface2, #1c1c26));
	}

	:global(.asset-browser-row.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 70%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, var(--color-ws-surface2, #1c1c26));
	}

	:global(.asset-browser-main) {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	:global(.asset-browser-thumb) {
		display: flex;
		width: 34px;
		height: 34px;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-bg, #0b0b0f) 70%, transparent);
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 800;
	}

	:global(.asset-browser-thumb img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	:global(.asset-browser-name),
	:global(.asset-browser-meta),
	:global(.asset-browser-id) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-browser-name) {
		font-size: 11px;
		font-weight: 700;
	}

	:global(.asset-browser-meta) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	:global(.asset-browser-id) {
		width: 100%;
		box-sizing: border-box;
		padding: 3px 5px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-text, #9a9aa8);
		font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
		font-size: 10px;
		text-align: center;
	}

	:global(.asset-detail-card) {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin: 0 0 8px;
		padding: 8px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 56%, transparent);
	}

	:global(.asset-detail-card.muted) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 11px;
	}

	:global(.asset-detail-title) {
		display: flex;
		min-width: 0;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	:global(.asset-detail-title span) {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-detail-title small) {
		flex: 0 0 auto;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	:global(.asset-detail-preview) {
		display: grid;
		grid-template-columns: 76px minmax(0, 1fr);
		align-items: center;
		gap: 10px;
		padding: 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 20%, var(--ws-hair, rgba(255, 255, 255, 0.07)));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 7%, var(--color-ws-surface, #15151d));
	}

	:global(.asset-detail-preview-image) {
		display: flex;
		width: 76px;
		height: 56px;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-bg, #0b0b0f) 74%, transparent);
		color: var(--color-ws-text, #9a9aa8);
		font-size: 12px;
		font-weight: 850;
	}

	:global(.asset-detail-preview-image img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	:global(.asset-detail-preview-copy) {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	:global(.asset-detail-preview-copy span),
	:global(.asset-detail-preview-copy small) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-detail-preview-copy span) {
		color: var(--color-ws-ink, #ececf2);
		font-size: 11px;
		font-weight: 800;
	}

	:global(.asset-detail-preview-copy small) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	:global(.asset-detail-grid) {
		display: grid;
		grid-template-columns: 54px minmax(0, 1fr);
		gap: 4px 8px;
		font-size: 11px;
	}

	:global(.asset-detail-grid span) {
		color: var(--color-ws-text, #9a9aa8);
	}

	:global(.asset-detail-grid strong) {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-detail-actions) {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	:global(.asset-detail-action-copy) {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	:global(.asset-detail-action-copy span),
	:global(.asset-detail-action-copy small) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.asset-detail-action-copy span) {
		color: var(--color-ws-ink, #ececf2);
		font-size: 11px;
		font-weight: 760;
	}

	:global(.asset-detail-action-copy small) {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	:global(.asset-detail-action-buttons) {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
		gap: 6px;
	}

	:global(.asset-detail-action-buttons .panel-btn) {
		min-height: 40px;
		padding-inline: 8px;
		font-size: 11px;
	}

	:global(.asset-action-receipt) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 0 9px;
		border: 1px dashed var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 48%, transparent);
		color: var(--color-ws-text, #9a9aa8);
		font-size: 11px;
		font-weight: 800;
		text-align: center;
	}

	:global(.asset-detail-action-receipt) {
		width: 100%;
	}

	:global(.asset-browser-empty) {
		width: 100%;
	}

	.action-empty {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px;
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.025);
	}

	.action-empty span:first-child {
		color: var(--editor-text);
		font-weight: 650;
	}

	@media (max-width: 980px) {
		.selection-focus-action,
		.layer-place-btn,
		:global(.asset-library-summary),
		.panel-input,
		.panel-select,
		:global(.asset-filter-input),
		:global(.asset-reuse-select),
		:global(.asset-reuse-btn),
		:global(.asset-browser-more-row),
		.image-layer-role-filter button,
		:global(.layer-action-btn),
		.fit-text-btn {
			min-height: 40px;
		}

		:global(.asset-view-toggle) {
			grid-template-columns: repeat(2, minmax(44px, 1fr));
		}

		:global(.asset-view-toggle button) {
			min-height: 40px;
		}

		:global(.asset-reuse-row) {
			grid-template-columns: minmax(0, 1fr);
			align-items: stretch;
		}

		:global(.asset-reuse-select-label) {
			padding-bottom: 0;
		}

		:global(.asset-reuse-btn) {
			width: 100%;
		}

		.layer-panel-toolbar {
			grid-template-columns: minmax(0, 118px) minmax(0, 1fr);
		}
	}

	.layer-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 116px;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 50px;
		padding: 6px 7px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.018);
		color: var(--editor-text);
		text-align: left;
	}

	.layer-row:focus-within {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 44%, transparent);
	}

	.layer-row:hover {
		background: rgba(255, 255, 255, 0.04);
		border-color: var(--editor-border);
	}

	.layer-row.active {
		background: linear-gradient(90deg, rgba(0, 120, 212, 0.2), rgba(0, 120, 212, 0.08));
		border-color: var(--editor-accent);
	}

	.layer-row.hidden-layer {
		opacity: 0.58;
	}

	.layer-row.locked-layer .layer-type {
		border: 1px solid rgba(255, 255, 255, 0.22);
	}

	.image-layer-row.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 72%, transparent);
		background: linear-gradient(90deg, rgba(217, 70, 239, 0.22), rgba(217, 70, 239, 0.08));
	}

	.layer-select {
		display: grid;
		grid-template-columns: 32px 1fr;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 40px;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.layer-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(40px, 1fr));
		gap: 3px;
		width: 100%;
	}

	:global(.layer-action-btn) {
		min-height: 40px;
		min-width: 40px;
		padding: 0 6px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 760;
		line-height: 1;
		cursor: pointer;
	}

	:global(.layer-action-btn:hover) {
		color: var(--editor-text);
		border-color: var(--editor-accent);
	}

	:global(.layer-action-btn.danger:hover) {
		color: #ffb4a8;
		border-color: #b94a48;
	}

	.selected-layer-summary {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px 9px;
		border: 1px solid rgba(0, 120, 212, 0.25);
		border-radius: 6px;
		background: linear-gradient(135deg, rgba(0, 120, 212, 0.14), rgba(255, 255, 255, 0.035));
	}

	.selected-layer-summary.image-summary {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 28%, transparent);
		background: linear-gradient(135deg, rgba(217, 70, 239, 0.16), rgba(255, 255, 255, 0.035));
	}

	.selected-text-layer-summary {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 34%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 70%, transparent)),
			var(--color-ws-surface, #15151d);
		box-shadow: inset 0 1px 0 var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	.selected-layer-title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 700;
	}

	.selected-layer-title small {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-text-layer-summary .selected-layer-title {
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-layer-summary .selected-layer-title small {
		color: var(--color-ws-text, #9a9aa8);
	}

	.selected-layer-title .selected-image-brush-inline {
		flex-basis: 100%;
		color: #ffe6a8;
		font-weight: 820;
	}

	.selected-layer-actions {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 4px;
	}

	.selected-layer-actions.secondary {
		margin-top: 6px;
	}

	.selected-layer-primary-actions {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
		gap: 6px;
	}

	.selected-layer-primary-actions .panel-btn {
		min-height: 40px;
		padding: 0 8px;
	}

	.selected-text-layer-summary .panel-btn {
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.selected-text-layer-summary .panel-btn-primary,
	.selected-text-fit-alert .panel-btn-primary {
		background: linear-gradient(100deg, var(--color-ws-violet, #8b5cf6) 0%, var(--color-ws-accent, #7c5cff) 100%);
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-layer-summary .panel-btn:not(.panel-btn-primary):not(.danger-soft),
	.selected-text-property-group .panel-btn:not(.panel-btn-primary):not(.danger-soft) {
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 46%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-layer-summary .panel-btn:not(.panel-btn-primary):not(.danger-soft):hover,
	.selected-text-property-group .panel-btn:not(.panel-btn-primary):not(.danger-soft):hover {
		border-color: var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 68%, transparent);
	}

	.selected-text-layer-summary :global(.layer-action-btn) {
		min-height: 40px;
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 54%, transparent);
		color: var(--color-ws-text, #9a9aa8);
	}

	.selected-text-layer-summary :global(.layer-action-btn:hover) {
		border-color: var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 72%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-layer-summary :global(.layer-action-btn.danger:hover) {
		border-color: color-mix(in srgb, var(--color-ws-rose, #fb7185) 58%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #fb7185) 12%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose, #fb7185) 78%, var(--color-ws-ink, #ececf2));
	}

	.selected-image-action-state,
	.selected-layer-action-state {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid rgba(237, 177, 92, 0.22);
		border-radius: 6px;
		background: rgba(31, 23, 12, 0.42);
		color: #f2d39a;
		font-size: 10px;
		font-weight: 780;
		line-height: 1.25;
		text-align: center;
	}

	.selected-image-action-state.wide,
	.selected-layer-action-state.wide {
		grid-column: 1 / -1;
	}

	.selected-text-layer-summary .selected-layer-action-state,
	.selected-text-property-group .selected-layer-action-state {
		border-color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 28%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 11%, var(--color-ws-surface, #15151d));
		color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 76%, var(--color-ws-ink, #ececf2));
	}

	.selected-text-readonly {
		display: grid;
		gap: 6px;
		min-height: 72px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #fbbf24) 24%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 10%, var(--color-ws-surface, #15151d));
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-readonly span {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.selected-text-readonly small {
		color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 72%, var(--color-ws-ink, #ececf2));
		font-size: 10px;
		font-weight: 780;
	}

	.selected-text-style-readout {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
		gap: 8px;
	}

	.selected-image-readonly-field {
		display: grid;
		gap: 4px;
		min-height: 40px;
		padding: 8px;
		border: 1px solid rgba(144, 184, 255, 0.16);
		border-radius: 6px;
		background: rgba(10, 16, 32, 0.32);
		color: #c4ccdb;
	}

	.selected-image-readonly-field span {
		font-size: 10px;
		font-weight: 780;
		text-transform: uppercase;
	}

	.selected-image-readonly-field strong {
		overflow: hidden;
		color: #f4f7ff;
		font-size: 12px;
		font-weight: 820;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-text-property-group .selected-image-readonly-field {
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 66%, transparent);
		color: var(--color-ws-text, #9a9aa8);
	}

	.selected-text-property-group .selected-image-readonly-field span {
		color: var(--color-ws-text, #9a9aa8);
	}

	.selected-text-property-group .selected-image-readonly-field strong {
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-fit-alert {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(104px, auto);
		align-items: center;
		gap: 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #fbbf24) 34%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--color-ws-amber, #fbbf24) 14%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 66%, transparent)),
			var(--color-ws-surface, #15151d);
	}

	.selected-text-fit-alert div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.selected-text-fit-alert .selected-text-fit-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(82px, 1fr));
		gap: 6px;
	}

	.selected-text-fit-alert strong {
		color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 72%, var(--color-ws-ink, #ececf2));
		font-size: 11px;
		font-weight: 850;
	}

	.selected-text-fit-alert small {
		overflow: hidden;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 9px;
		font-weight: 720;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-text-fit-alert .panel-btn {
		min-height: 40px;
		padding: 0 10px;
	}

	.selected-text-fit-state {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #fbbf24) 26%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 9%, var(--color-ws-surface, #15151d));
		color: color-mix(in srgb, var(--color-ws-amber, #fbbf24) 72%, var(--color-ws-ink, #ececf2));
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	button.selected-text-fit-state {
		cursor: pointer;
	}

	@media (max-width: 980px) {
		.selected-text-fit-alert {
			grid-template-columns: minmax(0, 1fr);
		}

		.selected-text-fit-alert .selected-text-fit-actions {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.selected-text-fit-alert .panel-btn {
			width: 100%;
		}
	}

	.text-box-size-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(112px, auto);
		gap: 8px;
		align-items: end;
	}

	.text-detail-toggle {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		width: 100%;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 50%, transparent);
		color: var(--color-ws-ink, #ececf2);
		cursor: pointer;
		text-align: left;
	}

	.text-detail-toggle:hover,
	.text-detail-toggle[aria-expanded="true"] {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, var(--color-ws-surface, #15151d));
	}

	.text-detail-toggle span,
	.text-detail-toggle small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.text-detail-toggle span {
		font-size: 11px;
		font-weight: 820;
	}

	.text-detail-toggle small {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 680;
	}

	.text-detail-panel,
	.text-style-detail-panel {
		display: grid;
		gap: 8px;
		padding: 7px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 58%, transparent);
	}

	.text-box-fit-summary {
		display: flex;
		grid-column: 1 / -1;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 7px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, var(--color-ws-surface, #15151d));
	}

	.text-box-fit-summary strong,
	.text-box-fit-summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.text-box-fit-summary strong {
		color: var(--color-ws-ink, #ececf2);
		font-size: 11px;
		font-weight: 820;
	}

	.text-box-fit-summary small {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 650;
	}

	.text-box-size-controls .panel-label {
		margin: 0;
	}

	.text-box-size-controls .text-detail-toggle,
	.text-box-number-grid {
		grid-column: 1 / -1;
	}

	.text-box-number-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(112px, auto);
		gap: 8px;
		align-items: end;
	}

	.text-box-grow-btn {
		min-height: 40px;
	}

	@media (max-width: 980px) {
		.text-box-size-controls {
			grid-template-columns: minmax(0, 1fr);
		}

		.text-box-number-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.text-box-grow-btn {
			width: 100%;
		}
	}

	.selected-image-brush-strip {
		display: grid;
		grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
		align-items: center;
		gap: 3px 8px;
		min-height: 48px;
		padding: 7px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 28%, transparent);
		border-radius: 6px;
		background: linear-gradient(135deg, rgba(20, 184, 166, 0.16), rgba(0, 0, 0, 0.2));
	}

	.selected-image-brush-strip span,
	.selected-image-brush-strip small {
		color: rgba(190, 242, 232, 0.82);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.2;
	}

	.selected-image-brush-strip strong {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-image-brush-strip small {
		grid-column: 1 / -1;
	}

	.selected-image-brush-strip em {
		grid-column: 1 / -1;
		color: #ffe6a8;
		font-size: 10px;
		font-style: normal;
		font-weight: 800;
		line-height: 1.2;
	}

	.selected-image-brush-owner {
		grid-column: 1 / -1;
		display: grid;
		gap: 3px;
		padding: 7px 8px;
		border: 1px solid rgba(148, 163, 184, 0.24);
		border-radius: 6px;
		background: rgba(15, 23, 42, 0.72);
	}

	.selected-image-brush-owner span {
		color: rgba(190, 242, 232, 0.82);
		font-size: 11px;
		font-weight: 800;
		line-height: 1.25;
	}

	.selected-image-brush-owner strong {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 860;
	}

	.selected-image-transform-readout {
		display: grid;
		min-width: 0;
		gap: 3px;
		padding: 7px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 7.5%, transparent);
	}

	.selected-image-transform-readout span {
		color: var(--editor-accent);
		font-size: 10px;
		font-weight: 850;
	}

	.selected-image-transform-readout strong {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-image-transform-readout small {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
	}

	.selected-layer-utility-details {
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		padding-top: 6px;
	}

	.selected-layer-utility-details summary {
		display: flex;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		cursor: pointer;
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 850;
		list-style: none;
	}

	.selected-layer-utility-details summary::-webkit-details-marker {
		display: none;
	}

	.selected-layer-utility-details summary::after {
		content: attr(data-closed-label);
		color: var(--editor-text);
		font-size: 13px;
		font-weight: 880;
	}

	.selected-layer-utility-details[open] summary::after {
		content: attr(data-open-label);
	}

	.selected-text-layer-summary .selected-layer-utility-details {
		border-top-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	.selected-text-layer-summary .selected-layer-utility-details summary {
		color: var(--color-ws-text, #9a9aa8);
	}

	.selected-text-layer-summary .selected-layer-utility-details summary::after {
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-format-drawer {
		display: grid;
		gap: 8px;
	}

	.selected-text-format-drawer summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px 9px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 54%, transparent);
		color: var(--color-ws-ink, #ececf2);
		cursor: pointer;
		list-style: none;
	}

	.selected-text-format-drawer summary::-webkit-details-marker {
		display: none;
	}

	.selected-text-format-drawer summary::after {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 13px;
		font-weight: 900;
		content: attr(data-closed-label);
	}

	.selected-text-format-drawer[open] summary::after {
		content: attr(data-open-label);
	}

	.selected-text-format-drawer summary span,
	.selected-text-format-drawer summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-text-format-drawer summary span {
		font-size: 12px;
		font-weight: 850;
	}

	.selected-text-format-drawer summary small {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 680;
	}

	.selected-text-format-body {
		display: grid;
		gap: 8px;
	}

	.layer-property-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.022);
	}

	.selected-text-property-group {
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 58%, transparent);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ws-ink, #ececf2) 3%, transparent);
	}

	.layer-property-group.advanced {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		background: linear-gradient(135deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 4.5%, transparent), rgba(255, 255, 255, 0.018));
	}

	.selected-text-property-group.advanced {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, transparent);
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, transparent),
				color-mix(in srgb, var(--color-ws-surface, #15151d) 62%, transparent)),
			var(--color-ws-surface, #15151d);
	}

	.layer-property-group-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 780;
	}

	.selected-text-property-group .layer-property-group-header {
		color: var(--color-ws-ink, #ececf2);
	}

	.layer-property-group-header small {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 640;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-text-property-group .layer-property-group-header small {
		color: var(--color-ws-text, #9a9aa8);
	}

	.fill-color-controls {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.fill-eyedropper {
		padding: 2px 6px;
		font-size: 13px;
		line-height: 1;
		cursor: pointer;
	}

	.fill-eyedropper:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.selected-text-property-group .panel-input,
	.selected-text-property-group .panel-select,
	.selected-text-property-group .panel-color-input,
	.selected-text-property-group :global(.selected-text-textarea) {
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 62%, var(--color-ws-bg, #0b0b0f));
		color: var(--color-ws-ink, #ececf2);
	}

	.selected-text-property-group .panel-input:focus-visible,
	.selected-text-property-group .panel-select:focus-visible,
	.selected-text-property-group .panel-color-input:focus-visible,
	.selected-text-property-group :global(.selected-text-textarea:focus-visible) {
		border-color: var(--color-ws-accent, #7c5cff);
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 1px;
	}

	.layer-type {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text);
		font-weight: 700;
		font-size: 12px;
	}

	.image-type {
		width: 30px;
		color: #9bdcff;
		font-size: 9px;
	}

	.image-type.ai-type {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, transparent);
		color: #bdf9ef;
	}

	/* Phase C — non-destructive "Edits" stack rows (violet design token). */
	.image-edit-type {
		width: auto;
		min-width: 30px;
		padding: 0 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		color: #d8ccff;
		font-size: 9px;
		letter-spacing: 0.02em;
	}

	.edit-layer-select {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex: 1 1 auto;
		text-align: left;
	}

	.edit-layer-rename-input {
		width: 100%;
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 55%, transparent);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text);
		font-size: 12px;
	}

	.edit-layer-revert-confirm {
		flex-basis: 100%;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 6px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 40%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, transparent);
	}

	.edit-layer-revert-copy {
		color: var(--editor-text-dim);
		font-size: 11px;
		line-height: 1.4;
	}

	.edit-layer-revert-actions {
		display: flex;
		gap: 8px;
	}

	.layer-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.layer-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		line-height: 1.2;
	}

	.layer-meta,
	.empty-state {
		color: var(--editor-text-dim);
		font-size: 11px;
	}

	.layer-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		min-height: 18px;
		overflow: hidden;
	}

	.layer-badge {
		display: inline-flex;
		align-items: center;
		max-width: 88px;
		height: 18px;
		padding: 0 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--editor-text-dim);
		font-size: 10px;
		line-height: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-badge.category {
		border-color: rgba(74, 144, 226, 0.32);
		color: #a9d0ff;
	}

	.layer-badge.confidence {
		border-color: rgba(61, 179, 113, 0.3);
		color: #8bd9ad;
	}

	.layer-badge.provider {
		border-color: rgba(221, 166, 66, 0.3);
		color: #e5c07b;
	}

	.layer-badge.protected {
		border-color: rgba(255, 180, 168, 0.32);
		color: #ffb4a8;
	}

	.layer-badge.image-state {
		border-color: rgba(110, 231, 183, 0.28);
		color: #bff7de;
	}

	.layer-edit-state {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		min-height: 22px;
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 38%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 11%, transparent);
		color: #bdf9ef;
		font-size: 10px;
		font-weight: 760;
		line-height: 1.1;
	}

	.style-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
	}

	.base-stroke-grid {
		display: grid;
		gap: 8px;
		padding: 0 8px 8px;
	}

	.image-layer-name {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.ai-layer-focus-card {
		display: grid;
		gap: 8px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 28%, transparent);
		border-radius: 7px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent), color-mix(in srgb, var(--color-ws-accent, #7c5cff) 5%, transparent)),
			rgba(255, 255, 255, 0.025);
	}

	.ai-placement-focus-card {
		display: grid;
		gap: 8px;
		padding: 10px;
		border: 1px solid rgba(255, 211, 106, 0.34);
		border-radius: 7px;
		background:
			linear-gradient(135deg, rgba(255, 211, 106, 0.14), color-mix(in srgb, var(--color-ws-accent, #7c5cff) 6%, transparent)),
			rgba(255, 255, 255, 0.025);
	}

	.ai-layer-focus-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.ai-layer-focus-copy small,
	.ai-layer-focus-copy strong,
	.ai-layer-focus-copy span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ai-layer-focus-copy small {
		color: #9bdcff;
		font-size: 10px;
		font-weight: 850;
		line-height: 1.2;
	}

	.ai-layer-focus-copy strong {
		color: var(--editor-text);
		font-size: 13px;
		font-weight: 850;
		line-height: 1.25;
	}

	.ai-layer-focus-copy span {
		color: var(--editor-text-dim);
		font-size: 11px;
		font-weight: 680;
		line-height: 1.35;
	}

	.ai-layer-trust-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 5px;
	}

	.ai-layer-trust-row span {
		min-width: 0;
		min-height: 28px;
		padding: 6px 7px;
		border: 1px solid rgba(110, 231, 183, 0.22);
		border-radius: 5px;
		background: rgba(110, 231, 183, 0.075);
		color: #c9f9df;
		font-size: 10px;
		font-weight: 820;
		line-height: 1.25;
		text-align: center;
	}

	.ai-layer-opacity-control {
		display: grid;
		grid-template-columns: minmax(74px, 0.42fr) minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 7px 8px;
		border: 1px solid rgba(255, 255, 255, 0.075);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.16);
	}

	.ai-layer-opacity-control span {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 780;
		line-height: 1.2;
		white-space: nowrap;
	}

	.ai-layer-opacity-control input {
		width: 100%;
		min-height: 40px;
		min-width: 0;
	}

	.ai-layer-quick-actions {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 5px;
	}

	.ai-layer-lifecycle-details {
		border: 1px solid rgba(255, 255, 255, 0.075);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.13);
	}

	.ai-layer-lifecycle-details summary {
		display: flex;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 7px 8px;
		cursor: pointer;
	}

	.ai-layer-lifecycle-details summary span,
	.ai-layer-lifecycle-details summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-layer-lifecycle-details summary span {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 830;
	}

	.ai-layer-lifecycle-details summary small {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 760;
	}

	.ai-layer-lifecycle-actions {
		padding: 0 8px 8px;
	}

	.ai-placement-actions {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
		gap: 5px;
	}

	:global(.layer-action-btn.primary) {
		border-color: rgba(255, 211, 106, 0.48);
		background: linear-gradient(135deg, rgba(255, 211, 106, 0.92), rgba(143, 184, 255, 0.86));
		color: #101015;
	}

	.image-layer-advanced-drawer {
		display: grid;
		gap: 8px;
	}

	.image-layer-advanced-drawer summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px 9px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.035);
		color: var(--editor-text);
		cursor: pointer;
		list-style: none;
	}

	.image-layer-advanced-drawer summary::-webkit-details-marker {
		display: none;
	}

	.image-layer-advanced-drawer summary::after {
		color: var(--editor-text-dim);
		font-size: 13px;
		font-weight: 900;
		content: attr(data-closed-label);
	}

	.image-layer-advanced-drawer[open] summary::after {
		content: attr(data-open-label);
	}

	.image-layer-advanced-drawer summary span,
	.image-layer-advanced-drawer summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.image-layer-advanced-drawer summary span {
		font-size: 12px;
		font-weight: 850;
	}

	.image-layer-advanced-drawer summary small {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 680;
	}

	.image-align-block {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.image-transform-block {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.image-align-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
	}

	.image-transform-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
	}

	.image-source-name {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text);
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.image-layer-role-note {
		display: block;
		color: rgba(190, 242, 232, 0.78);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.45;
	}

	.image-geometry-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 7px;
	}

	.image-geometry-grid .panel-label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-bottom: 0;
	}

	.preset-block {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.preset-save-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(112px, 0.65fr);
		align-items: stretch;
		gap: 6px;
	}

	.text-effect-suggester {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 7px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 52%, transparent);
	}

	.preset-suggestion-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 5px;
	}

	.preset-suggestion-btn {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
		min-width: 0;
		min-height: 40px;
		padding: 6px 7px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151d) 58%, transparent);
		color: var(--color-ws-ink, #ececf2);
		text-align: left;
		cursor: pointer;
	}

	.preset-suggestion-btn:hover,
	.preset-suggestion-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 44%, transparent);
		background:
			linear-gradient(100deg,
				color-mix(in srgb, var(--color-ws-violet, #8b5cf6) 16%, transparent),
				color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent)),
			var(--color-ws-surface, #15151d);
	}

	.preset-suggestion-btn span,
	.preset-suggestion-btn small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preset-suggestion-btn span {
		font-size: 11px;
		font-weight: 750;
	}

	.preset-suggestion-btn small,
	.preset-suggestion-empty {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	.preset-suggestion-empty {
		padding: 2px 0;
	}

	.preset-name-input {
		min-width: 0;
	}

	.preset-save-btn {
		min-width: 56px;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 0;
		font-size: 11px;
	}

	.selected-text-preset-save-row .preset-save-btn {
		background: linear-gradient(100deg, var(--color-ws-violet, #8b5cf6) 0%, var(--color-ws-accent, #7c5cff) 100%);
		color: var(--color-ws-ink, #ececf2);
	}

	.preset-save-note {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 40px;
		padding: 5px 7px;
		border: 1px dashed rgba(255, 255, 255, 0.16);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.035);
		color: var(--editor-text-dim);
		font-size: 10px;
		line-height: 1.25;
		text-align: center;
		overflow-wrap: anywhere;
	}

	.selected-text-preset-save-row .preset-save-note {
		border-color: var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1c1c26) 56%, transparent);
		color: var(--color-ws-text, #9a9aa8);
	}

	.credit-action-row {
		display: grid;
		grid-template-columns: 1fr;
	}

	.credit-action-row .panel-btn {
		min-height: 40px;
	}

	.credit-image-grid {
		grid-template-columns: minmax(0, 1fr);
	}

	.credit-scope-card {
		grid-template-columns: minmax(0, 1fr);
	}

	.font-size-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 78px;
		align-items: center;
		gap: 6px;
	}

	.fit-text-btn {
		min-height: 40px;
		padding: 0 6px;
		font-size: 11px;
		white-space: nowrap;
	}

	.style-field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		margin-bottom: 0;
	}

	.panel-color-input {
		width: 40px;
		height: 40px;
		padding: 0;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		cursor: pointer;
	}
</style>
