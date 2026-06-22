<script lang="ts">
	import { config } from "$lib/config.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { suggestTextStylePresetsForPrompt } from "$lib/project/text-style-presets.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import { formatBytes } from "$lib/stores/usage.svelte.ts";
	import { _ } from "$lib/i18n/index.ts";
	import type { ProjectImageAssetSummary } from "$lib/api/client.ts";
	import type {
		CreditApplyScope,
		CreditPreset,
		ImageLayer,
		ImageLayerAlignment,
		ImageLayerBulkAction,
		ImageLayerTransformPreset,
		ImageEditLayer,
		TextLayer,
	} from "$lib/types.js";
	import LayersPanelV2, { type LayerPanelLayer, type LayerSelectOptions } from "$lib/editor-ui/LayersPanelV2.svelte";
	import LayersInspectorPanel from "./LayersInspectorPanel.svelte";

	type CreditDeleteKind = "all" | "text" | "image";
	type CreditDeleteMatch = {
		text?: string;
		imageId?: string;
	};
	type LayersPanelV2RefKind = "text" | "image" | "edit" | "base";
	type LayersPanelV2Ref = {
		kind: LayersPanelV2RefKind;
		id: string;
	};

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

	interface Props {
		labels: Labels;
	}

	let { labels }: Props = $props();

	const USE_LAYERS_PANEL_V2 = true;
	const BASE_LAYER_PANEL_V2_ID = "base:page";
	const aspectRatios = config.canvas.defaultAspectRatios;
	const defaultTextFill = "#111111";
	const defaultTextStroke = "#ffffff";

	let presetName = $state("");
	let selectedPresetId = $state("");
	let selectedCreditPresetId = $state("credit-bottom-center");
	let creditText = $state("");
	let creditOffset = $state(24);
	let creditPresetName = $state("");
	let creditImageMaxWidth = $state(240);
	let creditImageRepeatEveryPx = $state(0);
	let creditApplyScope = $state<CreditApplyScope>("current");
	let selectedImageAssetId = $state("");
	let textEffectPrompt = $state("");
	let textEffectSuggestions = $derived(
		suggestTextStylePresetsForPrompt(textEffectPrompt, projectStore.textStylePresets, 3)
	);
	let currentProjectPage = $derived(
		projectStore.project ? projectStore.project.pages[projectStore.project.currentPage] ?? null : null
	);
	let layerPanelV2TextLayers = $derived(
		editorStore.textLayers.length > 0 || !currentProjectPage
			? editorStore.textLayers
			: currentProjectPage.textLayers
	);
	let layerPanelV2ImageLayers = $derived(
		editorStore.imageLayers.length > 0 || !currentProjectPage
			? editorStore.imageLayers
			: currentProjectPage.imageLayers ?? []
	);
	let layerPanelV2EditLayers = $derived(
		editorStore.imageEditLayers.length > 0 || !currentProjectPage
			? editorStore.imageEditLayers
			: currentProjectPage.imageEditLayers ?? []
	);
	let layersPanelV2Rows = $derived.by((): LayerPanelLayer[] => {
		const editableRows = [
			...layerPanelV2TextLayers.map((layer) => ({
				kind: "text" as const,
				layer,
				zIndex: Number.isFinite(layer.zIndex) ? Number(layer.zIndex) : layerPanelV2ImageLayers.length + layer.index,
			})),
			...layerPanelV2ImageLayers.map((layer) => ({
				kind: "image" as const,
				layer,
				zIndex: Number.isFinite(layer.zIndex) ? Number(layer.zIndex) : layer.index,
			})),
		].sort((a, b) => b.zIndex - a.zIndex || (a.kind === "text" ? -1 : 1));

		const editRows = [...layerPanelV2EditLayers]
			.sort((a, b) => (b.index ?? 0) - (a.index ?? 0))
			.map((layer, index): LayerPanelLayer => ({
				id: layerPanelV2Id("edit", layer.id),
				name: imageEditLayerPanelV2Name(layer, index),
				kind: "edit",
				kindLabel: imageEditLayerPanelV2KindLabel(layer),
				visible: layer.visible !== false,
				locked: false,
				opacity: 1,
			}));

		const baseRow: LayerPanelLayer[] = currentProjectPage
			? [{
				id: BASE_LAYER_PANEL_V2_ID,
				name: currentProjectPage.originalName || currentProjectPage.imageName || $_("layersInspector.baseImage"),
				kind: "base",
				visible: true,
				locked: true,
				opacity: 1,
				thumbnailUrl: projectStore.project ? projectStore.getImageUrl(currentProjectPage.imageId) : undefined,
			}]
			: [];

		const rows: LayerPanelLayer[] = [
			...editableRows.map((entry): LayerPanelLayer => {
				if (entry.kind === "text") {
					const layer = entry.layer;
					return {
						id: layerPanelV2Id("text", layer.id),
						name: textLayerPanelV2Name(layer),
						kind: "text",
						visible: layer.visible !== false,
						locked: layer.locked === true,
						opacity: clampLayerPanelV2Opacity(layer.opacity ?? 1),
					};
				}
				const layer = entry.layer;
				return {
					id: layerPanelV2Id("image", layer.id),
					name: imageLayerPanelV2Name(layer),
					kind: "image",
					visible: layer.visible !== false,
					locked: layer.locked === true,
					opacity: clampLayerPanelV2Opacity(layer.opacity),
					thumbnailUrl: projectStore.project ? projectStore.getImageUrl(layer.imageId) : undefined,
				};
			}),
			...editRows,
			...baseRow,
		];
		// Defensive de-dupe: LayersPanelV2 keys its {#each} by row id (`${kind}:${id}`).
		// A duplicate layer id — a real condition QC flags as duplicate_layer_id_* (and
		// that past data-corruption bugs produced) — would otherwise throw Svelte's
		// each_key_duplicate and crash the panel, which is always mounted in the shell, so
		// it takes the surrounding view down with it. Keep the first occurrence.
		const seenRowIds = new Set<string>();
		return rows.filter((row) => {
			if (seenRowIds.has(row.id)) return false;
			seenRowIds.add(row.id);
			return true;
		});
	});
	let selectedLayerPanelV2Ids = $derived.by((): string[] => {
		const ids: string[] = [];
		if (editorStore.selectedLayer) ids.push(layerPanelV2Id("text", editorStore.selectedLayer.id));
		if (editorStore.selectedImageLayer) ids.push(layerPanelV2Id("image", editorStore.selectedImageLayer.id));
		return ids;
	});

	function layerPanelV2Id(kind: LayersPanelV2RefKind, id: string): string {
		return `${kind}:${id}`;
	}

	function parseLayerPanelV2Id(panelId: string): LayersPanelV2Ref | null {
		if (panelId === BASE_LAYER_PANEL_V2_ID) return { kind: "base", id: "page" };
		const separator = panelId.indexOf(":");
		if (separator <= 0) return null;
		const kind = panelId.slice(0, separator);
		if (kind !== "text" && kind !== "image" && kind !== "edit") return null;
		return { kind, id: panelId.slice(separator + 1) };
	}

	function clampLayerPanelV2Opacity(value: number): number {
		if (!Number.isFinite(value)) return 1;
		return Math.min(1, Math.max(0, value));
	}

	function textLayerPanelV2Name(layer: TextLayer): string {
		return layer.name?.trim() || layer.text?.trim() || $_("layersInspector.stackMetaTextBox");
	}

	function imageLayerPanelV2Name(layer: ImageLayer): string {
		return layer.name?.trim() || layer.originalName || layer.imageName || $_("layersMode.extraImage");
	}

	function imageEditLayerPanelV2Name(layer: ImageEditLayer, index: number): string {
		if (layer.name?.trim()) return layer.name.trim();
		return `${imageEditLayerPanelV2KindLabel(layer)} #${index + 1}`;
	}

	function imageEditLayerPanelV2KindLabel(layer: ImageEditLayer): string {
		const type = layer.payload?.type ?? layer.kind;
		const toolId = layer.tool?.id;
		if (
			type === "patch"
			|| type === "healing"
			|| type === "clone"
			|| toolId === "brush"
			|| toolId === "healing-brush"
			|| toolId === "clone-stamp"
			|| toolId === "background-edit"
		) {
			return $_("historyLabels.brushBackground");
		}
		return $_("historyLabels.imageEditLayer");
	}

	function selectLayerFromPanelV2(panelId: string, _options: LayerSelectOptions): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref) return;
		if (ref.kind === "text") {
			selectLayer(ref.id);
			return;
		}
		if (ref.kind === "image") {
			selectImageLayer(ref.id);
		}
	}

	function toggleLayerPanelV2Visibility(panelId: string): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind === "base") return;
		if (ref.kind === "text") {
			toggleLayerVisibility(ref.id);
			return;
		}
		if (ref.kind === "image") {
			toggleImageLayerVisibility(ref.id);
			return;
		}
		if (editorStore.toggleImageEditLayerVisibility(ref.id)) {
			editorStore.refreshImageEditLayers();
		}
	}

	function toggleLayerPanelV2Lock(panelId: string): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind === "base" || ref.kind === "edit") return;
		if (ref.kind === "text") {
			toggleLayerLock(ref.id);
			return;
		}
		toggleImageLayerLock(ref.id);
	}

	function renameLayerFromPanelV2(panelId: string, name: string): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind === "base") return;
		if (ref.kind === "text") {
			selectLayer(ref.id);
			updateSelectedTextLayerName(name);
			return;
		}
		if (ref.kind === "image") {
			selectImageLayer(ref.id);
			updateSelectedImageLayer({ name: name.trim() || undefined }, true);
			return;
		}
		if (editorStore.renameImageEditLayer(ref.id, name)) {
			editorStore.refreshImageEditLayers();
		}
	}

	function updateLayerPanelV2Opacity(panelId: string, opacity: number): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind === "base" || ref.kind === "edit") return;
		if (ref.kind === "text") {
			selectLayer(ref.id);
			updateSelectedTextOpacity(opacity);
			return;
		}
		selectImageLayer(ref.id);
		updateSelectedImageLayer({ opacity }, true);
	}

	function deleteLayerFromPanelV2(panelId: string): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind === "base") return;
		if (ref.kind === "text") {
			deleteLayer(ref.id);
			return;
		}
		if (ref.kind === "image") {
			deleteImageLayer(ref.id);
			return;
		}
		if (editorStore.deleteImageEditLayer(ref.id)) {
			editorStore.refreshImageEditLayers();
		}
	}

	function revertLayerFromPanelV2(panelId: string): void {
		const ref = parseLayerPanelV2Id(panelId);
		if (!ref || ref.kind !== "edit") return;
		if (editorStore.revertToBeforeImageEditLayer(ref.id)) {
			editorStore.refreshImageEditLayers();
		}
	}

	function reorderLayerFromPanelV2(fromIndex: number, toIndex: number): void {
		const source = layersPanelV2Rows[fromIndex];
		if (!source) return;
		const sourceRef = parseLayerPanelV2Id(source.id);
		if (!sourceRef || (sourceRef.kind !== "text" && sourceRef.kind !== "image")) return;

		const editableRows = layersPanelV2Rows.filter((row) => {
			const ref = parseLayerPanelV2Id(row.id);
			return ref?.kind === "text" || ref?.kind === "image";
		});
		const sourceEditableIndex = editableRows.findIndex((row) => row.id === source.id);
		if (sourceEditableIndex < 0) return;

		const targetEditableIndex = Math.max(
			0,
			Math.min(
				editableRows.length - 1,
				layersPanelV2Rows.slice(0, toIndex + 1).filter((row) => {
					const ref = parseLayerPanelV2Id(row.id);
					return ref?.kind === "text" || ref?.kind === "image";
				}).length - 1,
			),
		);
		const delta = targetEditableIndex - sourceEditableIndex;
		if (delta === 0) return;

		const direction: -1 | 1 = delta < 0 ? 1 : -1;
		for (let step = 0; step < Math.abs(delta); step += 1) {
			moveUnifiedLayer(sourceRef.kind, sourceRef.id, direction);
		}
	}

	function selectLayer(layerId: string): void {
		editorStore.selectTextLayer(layerId);
		editorStore.setTool("select");
		selectedPresetId = "";
	}

	function startTextPlacementFromPanel(): void {
		editorStore.startTextPlacement();
	}

	function addImageLayerFromPanel(): void {
		if (!projectStore.project || !editorStore.editor) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const layer = await projectStore.addReferenceImageLayer(file, editorStore.editor);
			if (!layer) return;
			editorStore.selectedImageLayer = layer;
			editorStore.selectedLayer = null;
			editorStore.refreshImageLayers();
			editorStore.setTool("select");
		};
		input.click();
	}

	function selectReusableImageAsset(assetId: string): void {
		selectedImageAssetId = assetId;
	}

	async function addSelectedImageAssetLayer(): Promise<void> {
		if (!selectedImageAssetId || !projectStore.project || !editorStore.editor) return;
		const layer = await projectStore.addReferenceImageLayerFromAsset(selectedImageAssetId, editorStore.editor);
		if (!layer) return;
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.refreshImageLayers();
		editorStore.setTool("select");
	}

	async function replaceSelectedImageLayerFromAsset(): Promise<void> {
		if (!selectedImageAssetId || !projectStore.project || !editorStore.editor || !editorStore.selectedImageLayer) return;
		const layer = await projectStore.replaceImageLayerSourceFromAsset(
			selectedImageAssetId,
			editorStore.selectedImageLayer.id,
			editorStore.editor,
		);
		if (!layer) return;
		editorStore.selectedImageLayer = layer;
		editorStore.selectedLayer = null;
		editorStore.refreshImageLayers();
		editorStore.setTool("select");
	}

	// Asset library — delete an image asset (frees space). Reference-safe: the
	// store surfaces a 409 (still-on-a-page) as `referencedByPages`; the inline
	// confirm in AssetBrowser then offers a forced delete, so a non-forced call
	// that hits 409 just informs the user rather than erroring.
	let canDeleteImageAssets = $derived(
		Boolean(projectStore.project) && authStore.permissionSet.has("update:project")
	);

	async function deleteImageAssetFromLibrary(
		asset: ProjectImageAssetSummary,
		force: boolean,
	): Promise<{ ok: true; freedBytes: number } | { referencedByPages: number[] } | { error: string }> {
		const result = await projectStore.deleteImageAsset(asset.imageId, { force });
		if ("ok" in result) {
			toastsStore.success({
				title: $_("assetLibrary.toastDeletedTitle"),
				body: $_("assetLibrary.toastDeletedBody", { values: { size: formatBytes(result.freedBytes) } }),
			});
		} else if ("referencedByPages" in result) {
			const pages = result.referencedByPages.join(", ");
			toastsStore.warn({
				title: $_("assetLibrary.toastInUseTitle"),
				body: pages
					? $_("assetLibrary.toastInUseBody", { values: { pages } })
					: $_("assetLibrary.toastInUseBodyGeneric"),
			});
		} else {
			toastsStore.error({
				title: $_("assetLibrary.toastDeleteFailedTitle"),
				body: result.error,
			});
		}
		return result;
	}

	function toggleLayerVisibility(layerId: string): void {
		editorStore.toggleTextLayerVisibility(layerId);
	}

	function toggleLayerLock(layerId: string): void {
		editorStore.toggleTextLayerLock(layerId);
	}

	function duplicateLayer(layerId: string): void {
		editorStore.duplicateTextLayer(layerId);
		selectedPresetId = "";
	}

	function moveLayer(layerId: string, direction: -1 | 1): void {
		editorStore.moveTextLayer(layerId, direction);
	}

	function deleteLayer(layerId: string): void {
		const layer = editorStore.textLayers.find((item) => item.id === layerId);
		editorStore.deleteTextLayerById(layerId);
		if (layer?.sourceCategory === "credit") {
			// The Thai status text is built by the producer (project store), which owns
			// the out-of-batch (#492) status-message localization cluster.
			projectStore.setDeletedTextCreditStatus(layer.text);
		}
		selectedPresetId = "";
	}

	function selectImageLayer(layerId: string): void {
		editorStore.selectImageLayer(layerId);
		editorStore.setTool("select");
		selectedPresetId = "";
	}

	function toggleImageLayerVisibility(layerId: string): void {
		editorStore.toggleImageLayerVisibility(layerId);
	}

	function toggleImageLayerLock(layerId: string): void {
		editorStore.toggleImageLayerLock(layerId);
	}

	async function duplicateImageLayer(layerId: string): Promise<void> {
		await editorStore.duplicateImageLayer(layerId);
		selectedPresetId = "";
	}

	function copySelectedLayer(): void {
		editorStore.copySelectedLayer();
	}

	function pasteLayerClipboard(): void {
		void editorStore.pasteLayerClipboard();
		selectedPresetId = "";
	}

	function moveImageLayer(layerId: string, direction: -1 | 1): void {
		editorStore.moveImageLayer(layerId, direction);
	}

	function moveUnifiedLayer(kind: "text" | "image", layerId: string, direction: -1 | 1): void {
		editorStore.moveUnifiedLayer(kind, layerId, direction);
	}

	function reorderUnifiedLayer(kind: "text" | "image", layerId: string, offset: number): void {
		editorStore.reorderUnifiedLayer(kind, layerId, offset);
	}

	function deleteImageLayer(layerId: string): void {
		const layer = editorStore.imageLayers.find((item) => item.id === layerId);
		editorStore.deleteImageLayerById(layerId);
		if (layer?.role === "credit") {
			// The Thai status text is built by the producer (project store), which owns
			// the out-of-batch (#492) status-message localization cluster.
			projectStore.setDeletedImageCreditStatus(layer.originalName || layer.imageName || layer.name);
		}
		selectedPresetId = "";
	}

	function applyImageLayerBulkAction(action: ImageLayerBulkAction, layerIds?: string[]): void {
		const editor = editorStore.editor;
		const layers = editorStore.imageLayers;
		if (!editor || !layers.length) return;
		const layerIdSet = layerIds ? new Set(layerIds) : null;
		const scopedLayers = layerIdSet ? layers.filter((layer) => layerIdSet.has(layer.id)) : layers;
		if (!scopedLayers.length) return;

		const updatesById: Record<string, Partial<Pick<ImageLayer, "visible" | "locked">>> = {};
		for (const layer of scopedLayers) {
			if (action === "show-all" && layer.visible === false) {
				updatesById[layer.id] = { visible: true };
			}
			if (action === "hide-all" && layer.visible !== false) {
				updatesById[layer.id] = { visible: false };
			}
			if (action === "lock-all" && layer.locked !== true) {
				updatesById[layer.id] = { locked: true };
			}
			if (action === "unlock-all" && layer.locked === true) {
				updatesById[layer.id] = { locked: false };
			}
		}

		if (!Object.keys(updatesById).length) return;

		if (typeof editor.updateImageLayersWithHistory === "function") {
			editor.updateImageLayersWithHistory(updatesById, editorStore.selectedImageLayer?.id ?? null);
		} else {
			for (const [id, updates] of Object.entries(updatesById)) {
				if (typeof editor.updateImageLayerWithHistory === "function") {
					editor.updateImageLayerWithHistory(id, updates);
				} else {
					editor.updateImageLayer?.(id, updates);
				}
			}
		}
		editorStore.refreshImageLayers();
		if (editorStore.selectedImageLayer) {
			editorStore.selectedImageLayer = editorStore.imageLayers.find((layer) => layer.id === editorStore.selectedImageLayer?.id)
				?? editorStore.selectedImageLayer;
		}
	}

	function updateSelectedImageLayer(
		updates: Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "role" | "blendMode">>,
		commit = false,
	): void {
		editorStore.updateImageLayer(updates, commit);
	}

	function alignSelectedImageLayer(alignment: ImageLayerAlignment): void {
		const layer = editorStore.selectedImageLayer;
		const editor = editorStore.editor;
		if (!layer || layer.locked === true || !editor?.imageWidth || !editor?.imageHeight) return;

		const maxX = Math.max(0, Math.round(editor.imageWidth - layer.w));
		const maxY = Math.max(0, Math.round(editor.imageHeight - layer.h));
		const centerX = Math.round(maxX / 2);
		const centerY = Math.round(maxY / 2);
		let targetX: number | undefined;
		let targetY: number | undefined;
		const updates: Partial<Pick<ImageLayer, "x" | "y">> = {};

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

	function applySelectedImageLayerTransformPreset(preset: ImageLayerTransformPreset): void {
		const layer = editorStore.selectedImageLayer;
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
		const updates: Partial<Pick<ImageLayer, "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "blendMode">> = {};
		const setLayerFrame = (width: number, height: number): void => {
			const centerX = layer.x + layerWidth / 2;
			const centerY = layer.y + layerHeight / 2;
			const maxX = Math.max(0, pageWidth - width);
			const maxY = Math.max(0, pageHeight - height);
			updates.x = Math.round(Math.min(Math.max(0, centerX - width / 2), maxX));
			updates.y = Math.round(Math.min(Math.max(0, centerY - height / 2), maxY));
			updates.w = width;
			updates.h = height;
		};
		const centerLayerFrameOnPage = (width: number, height: number): void => {
			updates.x = Math.round((pageWidth - width) / 2);
			updates.y = Math.round((pageHeight - height) / 2);
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
		}

		if (preset === "fill-width") {
			const width = pageWidth;
			const height = Math.max(1, Math.round(width / sourceAspect));
			updates.x = 0;
			updates.y = Math.round((pageHeight - height) / 2);
			updates.w = width;
			updates.h = height;
		}

		if (preset === "fill-height") {
			const height = pageHeight;
			const width = Math.max(1, Math.round(height * sourceAspect));
			updates.x = Math.round((pageWidth - width) / 2);
			updates.y = 0;
			updates.w = width;
			updates.h = height;
		}

		if (preset === "source-aspect") {
			const width = layerWidth;
			const height = Math.max(1, Math.round(width / sourceAspect));
			setLayerFrame(width, height);
		}

		if (preset === "reset-rotation") {
			updates.rotation = 0;
		}

		if (preset === "reset-transform") {
			const sourceWidth = Math.max(1, Math.round(layer.sourceW ?? layerWidth));
			const sourceHeight = Math.max(1, Math.round(layer.sourceH ?? layerHeight));
			const scale = Math.min(1, pageWidth / sourceWidth, pageHeight / sourceHeight);
			centerLayerFrameOnPage(
				Math.max(1, Math.round(sourceWidth * scale)),
				Math.max(1, Math.round(sourceHeight * scale)),
			);
			updates.rotation = 0;
			updates.opacity = 1;
			updates.flipX = false;
			updates.flipY = false;
			updates.blendMode = "normal";
		}

		const hasChange = Object.entries(updates).some(([key, value]) => {
			const currentValue = layer[key as keyof ImageLayer];
			return typeof value === "number"
				? Math.round((currentValue as number) ?? 0) !== value
				: currentValue !== value;
		});
		if (!hasChange) return;

		editorStore.updateImageLayer(updates, true);
	}

	function getSelectedCreditPreset(): CreditPreset | undefined {
		return projectStore.creditPresets.find((preset) => preset.id === selectedCreditPresetId)
			?? projectStore.creditPresets[0];
	}

	function applySelectedCreditPreset(presetId: string): void {
		selectedCreditPresetId = presetId;
		const preset = projectStore.creditPresets.find((item) => item.id === presetId)
			?? projectStore.creditPresets[0];
		if (!preset) return;
		creditText = preset.text;
		creditOffset = preset.offset;
	}

	function updateCreditOffset(value: number): void {
		creditOffset = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	}

	function addCreditLayer(): void {
		if (!creditText.trim()) return;
		const layer = projectStore.addCreditLayer(
			editorStore.editor,
			selectedCreditPresetId,
			creditText,
			creditOffset,
			creditApplyScope,
			creditImageRepeatEveryPx,
		);
		if (layer) editorStore.selectTextLayer(layer.id);
		editorStore.refreshTextLayers();
		selectedPresetId = "";
	}

	async function saveCreditPreset(): Promise<void> {
		const preset = getSelectedCreditPreset();
		if (!preset) return;
		const saved = await projectStore.saveCreditPreset({
			name: creditPresetName,
			text: creditText,
			placement: preset.placement,
			offset: creditOffset,
			style: preset.style,
		});
		if (!saved) return;
		creditPresetName = "";
		selectedCreditPresetId = saved.id;
	}

	function updateCreditText(value: string): void {
		creditText = value;
	}

	function updateCreditPresetName(value: string): void {
		creditPresetName = value;
	}

	function updateCreditImageMaxWidth(value: number): void {
		creditImageMaxWidth = Number.isFinite(value) ? Math.max(16, Math.round(value)) : 240;
	}

	function updateCreditImageRepeatEveryPx(value: number): void {
		creditImageRepeatEveryPx = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	}

	function updateCreditApplyScope(value: CreditApplyScope): void {
		creditApplyScope = value;
	}

	function addCreditImageLayerFromPanel(): void {
		if (!projectStore.project || !editorStore.editor) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const layers = await projectStore.addCreditImageLayer(file, editorStore.editor, {
				presetId: selectedCreditPresetId,
				maxWidth: creditImageMaxWidth,
				repeatEveryPx: creditImageRepeatEveryPx,
				scope: creditApplyScope,
			});
			const lastLayer = layers.at(-1);
			if (lastLayer) {
				editorStore.selectedImageLayer = lastLayer;
				editorStore.selectedLayer = null;
			}
			editorStore.refreshImageLayers();
			editorStore.refreshTextLayers();
			editorStore.setTool("select");
		};
		input.click();
	}

	function startSelectedImageBrushFromPanel(): void {
		editorStore.startSelectedImageCleanBrush();
	}

	function deleteCreditLayers(allPages: boolean, kind: CreditDeleteKind = "all", match?: CreditDeleteMatch): void {
		projectStore.deleteCreditLayers(editorStore.editor, allPages, kind, match);
		editorStore.selectedLayer = null;
		editorStore.selectedImageLayer = null;
		editorStore.refreshTextLayers();
		editorStore.refreshImageLayers();
	}

	function updateSelectedText(value: string): void {
		editorStore.updateTextContent(value);
	}

	function updateSelectedTextBox(updates: Partial<Pick<TextLayer, "w" | "h">>): void {
		editorStore.updateTextLayerBox(updates);
	}

	function updateSelectedTextLayerName(value: string): void {
		editorStore.updateTextLayerName(value);
	}

	function updateSelectedTextOpacity(value: number): void {
		selectedPresetId = "";
		editorStore.updateTextOpacity(value);
	}

	function applySelectedPreset(presetId: string): void {
		selectedPresetId = presetId;
		if (!presetId) return;
		const preset = projectStore.textStylePresets.find((item) => item.id === presetId);
		if (!preset) return;
		editorStore.applyTextStylePreset(preset.style);
	}

	function updatePresetName(value: string): void {
		presetName = value;
	}

	function updateTextEffectPrompt(value: string): void {
		textEffectPrompt = value;
	}

	function applySuggestedTextPreset(presetId: string): void {
		applySelectedPreset(presetId);
	}

	function updateSelectedAlignment(value: TextLayer["alignment"]): void {
		selectedPresetId = "";
		editorStore.updateTextAlignment(value);
	}

	function updateSelectedFill(value: string): void {
		selectedPresetId = "";
		editorStore.updateTextFill(value);
	}

	function updateSelectedStroke(value: string): void {
		selectedPresetId = "";
		editorStore.updateTextStroke(value);
	}

	function updateSelectedStrokeWidth(value: number): void {
		selectedPresetId = "";
		editorStore.updateTextStrokeWidth(Number.isFinite(value) ? value : 0);
	}

	function updateSelectedCharSpacing(value: number): void {
		selectedPresetId = "";
		editorStore.updateTextCharSpacing(Number.isFinite(value) ? value : 0);
	}

	function updateSelectedFontFamily(value: string): void {
		selectedPresetId = "";
		editorStore.updateTextFontFamily(value);
	}

	function updateSelectedFontSize(value: number): void {
		selectedPresetId = "";
		editorStore.updateTextFontSize(value);
	}

	function fitSelectedTextToBox(): void {
		selectedPresetId = "";
		editorStore.fitSelectedTextLayerToBox();
	}

	async function saveCurrentPreset(): Promise<void> {
		if (!editorStore.selectedLayer) return;
		const preset = await projectStore.saveTextStylePreset(presetName, editorStore.selectedLayer);
		if (!preset) return;
		presetName = "";
		selectedPresetId = preset.id;
	}

	function handleAspectRatioChange(value: string): void {
		editorStore.selectedAspectRatio = value;
		const ratio = aspectRatios[value];
		if (ratio) {
			editorStore.setAspectRatio(ratio);
		} else {
			editorStore.setAspectRatio(null);
		}
	}
</script>

{#if USE_LAYERS_PANEL_V2}
	<div class="layers-panel-v2-host" data-testid="layers-panel-v2-live">
		<LayersPanelV2
			layers={layersPanelV2Rows}
			selectedIds={selectedLayerPanelV2Ids}
			onSelect={selectLayerFromPanelV2}
			onToggleVisible={toggleLayerPanelV2Visibility}
			onToggleLock={toggleLayerPanelV2Lock}
			onReorder={reorderLayerFromPanelV2}
			onOpacity={updateLayerPanelV2Opacity}
			onRename={renameLayerFromPanelV2}
			onDelete={deleteLayerFromPanelV2}
			onRevert={revertLayerFromPanelV2}
		/>
	</div>
{/if}

<!-- V2 owns the LIST; the legacy inspector below still owns selected-layer
     controls (transform presets, align, blend, brush target) until those move
     into V2 — rendering both is intentional for now (in-house review P3). -->
<LayersInspectorPanel
	{labels}
	projectOpen={Boolean(projectStore.project)}
	projectId={projectStore.project?.projectId ?? null}
	hasImage={editorStore.hasImage}
	textLayers={editorStore.textLayers}
	imageLayers={editorStore.imageLayers}
	selectedLayer={editorStore.selectedLayer}
	selectedImageLayer={editorStore.selectedImageLayer}
	textStylePresets={projectStore.textStylePresets}
	creditPresets={projectStore.creditPresets}
	selectedPresetId={selectedPresetId}
	presetName={presetName}
	textEffectPrompt={textEffectPrompt}
	textEffectSuggestions={textEffectSuggestions}
	selectedCreditPresetId={selectedCreditPresetId}
	creditText={creditText}
	creditOffset={creditOffset}
	creditPresetName={creditPresetName}
	creditImageMaxWidth={creditImageMaxWidth}
	creditImageRepeatEveryPx={creditImageRepeatEveryPx}
	creditApplyScope={creditApplyScope}
	defaultFontFamily={config.defaultFontFamily}
	defaultFontSize={config.defaultFontSize}
	defaultTextFill={defaultTextFill}
	defaultTextStroke={defaultTextStroke}
	canvasDimensions={editorStore.getCanvasDimensions()}
	aspectRatios={aspectRatios}
	selectedAspectRatio={editorStore.selectedAspectRatio}
	focusLayerId={editorUiStore.textInspectorFocusLayerId}
	focusToken={editorUiStore.textInspectorFocusToken}
	imageFocusLayerId={editorUiStore.imageInspectorFocusLayerId}
	imageFocusToken={editorUiStore.imageInspectorFocusToken}
	layerClipboardKind={editorStore.layerClipboardKind}
	onCreditPresetChange={applySelectedCreditPreset}
	onCreditTextChange={updateCreditText}
	onCreditOffsetChange={updateCreditOffset}
	onCreditPresetNameChange={updateCreditPresetName}
	onAddCredit={addCreditLayer}
	onAddCreditImage={addCreditImageLayerFromPanel}
	onDeleteCreditLayers={deleteCreditLayers}
	onSaveCreditPreset={saveCreditPreset}
	onCreditImageMaxWidthChange={updateCreditImageMaxWidth}
	onCreditImageRepeatEveryPxChange={updateCreditImageRepeatEveryPx}
	onCreditApplyScopeChange={updateCreditApplyScope}
	onStartTextPlacement={startTextPlacementFromPanel}
	onAddImageLayer={addImageLayerFromPanel}
	onStartSelectedImageBrush={startSelectedImageBrushFromPanel}
	imageAssets={projectStore.imageAssets}
	imageAssetsLoading={projectStore.imageAssetsLoading}
	imageAssetStorageQuota={projectStore.imageAssetsStorageQuota}
	deletingImageAssetId={projectStore.deletingImageAssetId}
	{canDeleteImageAssets}
	onDeleteImageAsset={deleteImageAssetFromLibrary}
	selectedImageAssetId={selectedImageAssetId}
	onImageAssetSelectionChange={selectReusableImageAsset}
	onAddSelectedImageAssetLayer={addSelectedImageAssetLayer}
	onReplaceSelectedImageLayerFromAsset={replaceSelectedImageLayerFromAsset}
	onSelectLayer={selectLayer}
	onToggleLayerVisibility={toggleLayerVisibility}
	onToggleLayerLock={toggleLayerLock}
	onCopySelectedLayer={copySelectedLayer}
	onPasteLayerClipboard={pasteLayerClipboard}
	onDuplicateLayer={duplicateLayer}
	onMoveLayer={moveLayer}
	onMoveUnifiedLayer={moveUnifiedLayer}
	onReorderUnifiedLayer={reorderUnifiedLayer}
	onDeleteLayer={deleteLayer}
	onSelectImageLayer={selectImageLayer}
	onToggleImageLayerVisibility={toggleImageLayerVisibility}
	onToggleImageLayerLock={toggleImageLayerLock}
	onDuplicateImageLayer={duplicateImageLayer}
	onMoveImageLayer={moveImageLayer}
	onDeleteImageLayer={deleteImageLayer}
	onApplyImageLayerBulkAction={applyImageLayerBulkAction}
	onAlignSelectedImageLayer={alignSelectedImageLayer}
	onApplySelectedImageLayerTransformPreset={applySelectedImageLayerTransformPreset}
	onSelectedImageLayerChange={updateSelectedImageLayer}
	onSelectedTextLayerNameChange={updateSelectedTextLayerName}
	onSelectedTextChange={updateSelectedText}
	onSelectedTextBoxChange={updateSelectedTextBox}
	onTextOpacityChange={updateSelectedTextOpacity}
	onSelectedPresetChange={applySelectedPreset}
	onPresetNameChange={updatePresetName}
	onTextEffectPromptChange={updateTextEffectPrompt}
	onSuggestedPresetApply={applySuggestedTextPreset}
	onSaveCurrentPreset={saveCurrentPreset}
	onFontChange={updateSelectedFontFamily}
	onFontSizeChange={updateSelectedFontSize}
	onFitSelectedText={fitSelectedTextToBox}
	onFillChange={updateSelectedFill}
	onStrokeChange={updateSelectedStroke}
	onStrokeWidthChange={updateSelectedStrokeWidth}
	onCharSpacingChange={updateSelectedCharSpacing}
	onAlignmentChange={updateSelectedAlignment}
	onAspectRatioChange={handleAspectRatioChange}
/>

<style>
	.layers-panel-v2-host {
		margin-bottom: 9px;
	}
</style>
