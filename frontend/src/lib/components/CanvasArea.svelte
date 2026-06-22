<!-- CanvasArea — canvas container with drag-drop, auto-sizes to fill workspace -->
<script lang="ts">
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import {
		getCanvasOverlayZIndex,
		isCanvasOverlayInteractive,
		type CanvasWorkOverlayKind,
	} from "$lib/editor/overlay-priority.js";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { resolveCanvasImageDropAction } from "$lib/project/canvas-drop.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { orderPageIndexesForReading } from "$lib/project/reading-direction.js";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import * as api from "$lib/api/client.js";
	import WebtoonStrip, { type StripPage, type SlotGeometry } from "./WebtoonStrip.svelte";
	import type { PageAssetLoadIssue } from "$lib/project/page-assets.js";
	import { pageImageRelinkOrderFallbackCancelMessage } from "$lib/project/page-relink-confirmation.js";
	import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
	import type { AiReviewMarkerStatus, ProjectComment } from "$lib/types.js";
	import { onDestroy, onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import AiReviewMarkerRail from "./AiReviewMarkerRail.svelte";
	import AiReviewRegionOverlay from "./AiReviewRegionOverlay.svelte";
	import CanvasOverlayControls from "./CanvasOverlayControls.svelte";
	import CanvasViewportControls from "./CanvasViewportControls.svelte";
	import CommentRegionOverlay from "./CommentRegionOverlay.svelte";
	import TranslateSlotOverlay from "./TranslateSlotOverlay.svelte";
	import QcRegionOverlay from "./QcRegionOverlay.svelte";
	import BrushCleanHUD from "./BrushCleanHUD.svelte";
	import PageLeaseBanner from "./PageLeaseBanner.svelte";
	import SelectionHud from "./SelectionHud.svelte";
	import ToolContextMenu from "./ToolContextMenu.svelte";

	const activeAiRegionStatuses = new Set<AiReviewMarkerStatus>([
		"failed",
		"needs_review",
		"retry_requested",
	]);

	const emptyOverlayCounts: Record<CanvasWorkOverlayKind, number> = {
		qc: 0,
		comment: 0,
		"ai-review": 0,
	};

	// Safeguard for i18n not being ready. `$_` is the svelte-i18n message
	// formatter (a function); the dynamic group lookup is intentionally
	// best-effort and falls back to the inline defaults when absent.
	let t = $derived(($_ as unknown as Record<string, Record<string, string>>).canvasArea || {
		title: "Manga Editor",
		dropImages: "Drop manga images here or click to open",
		supportedFormats: "PNG, JPG, WebP"
	});

	let { canvasRef = $bindable<HTMLCanvasElement>() } = $props();
	let isDragOver = $state(false);

	let contextMenuState = $state<{ x: number; y: number } | null>(null);

	function handleContextMenu(e: MouseEvent) {
		if (!editorStore.hasImage) return;

		const target = e.target as HTMLElement;
		if (target.closest("input, textarea, button, select, a, [role='button'], .asset-error-card")) {
			return;
		}

		e.preventDefault();
		contextMenuState = { x: e.clientX, y: e.clientY };
	}

	function closeContextMenu() {
		contextMenuState = null;
		canvasRef?.focus();
	}

	$effect(() => {
		void editorUiStore.activeDockTool;
		void editorStore.currentTool;
		void editorStore.activeImageTool;
		contextMenuState = null;
	});
	let isLoading = $state(false);
	let containerEl: HTMLDivElement | undefined = $state();
	let stripRef = $state<WebtoonStrip>();
	let slotGeometry = $state<SlotGeometry | null>(null);

	// ── Single-page editing (continuous webtoon strip DISABLED) ────────────────
	// The continuous/virtualized webtoon strip was removed by product decision (it
	// was laggy on large real scans). The editor now renders ONE page at a time for
	// EVERY reading direction. Keeping the strip wiring inert behind this flag (kept
	// `false`) avoids churning the surrounding Fabric-overlay code; it can be deleted
	// in a later cleanup. Flip back to a real condition only if continuous mode returns.
	let stripModeActive = $derived(false);

	// Display-order page list (vertical keeps natural ascending order). Each entry carries
	// signed preview params so the strip's <img> can authenticate without a Bearer header.
	let stripPages = $derived<StripPage[]>(buildStripPages());

	// Map the logical currentPage → its position in the display-ordered strip so the strip
	// knows which slot the Fabric canvas overlays. (Vertical is ascending, so they match,
	// but we resolve it through the same ordering helper to stay direction-agnostic.)
	let focusedDisplayIndex = $derived(
		stripModeActive
			? Math.max(0, stripPages.findIndex((p) => p.pageIndex === (projectStore.project?.currentPage ?? 0)))
			: 0,
	);

	// The strip track is capped at this CSS width (see WebtoonStrip `.strip-track`
	// max-width). We size the preview derivative to this column width × DPR so it
	// stays crisp at retina without ever decoding the multi-MB full image.
	const STRIP_COLUMN_MAX_CSS = 900;

	function buildStripPages(): StripPage[] {
		const project = projectStore.project;
		if (!project) return [];
		const order = orderPageIndexesForReading(project.pages.length, projectStore.readingDirection);
		return order.map((pageIndex) => {
			const page = project.pages[pageIndex];
			const imageId = getPagePreviewImageId(page, projectStore.localImageUrls);
			const integrity = projectStore.getPageAssetIntegrity(pageIndex);
			// Only attach a servable preview when the asset is ready; otherwise the strip
			// shows a "not ready" affordance instead of repeatedly 404-ing.
			const servable = imageId && (!integrity || integrity.status === "ready");
			if (!servable) return { pageIndex, params: null };
			const id = imageId as string;
			// Just-uploaded pages have a local blob URL (not yet on the backend) — render
			// that directly; there's no server derivative to downscale to.
			const localUrl = projectStore.localImageUrls[id];
			return {
				pageIndex,
				params: {
					projectId: project.projectId,
					imageId: id,
					// PERF: use the lightweight `fit=inside` (uncropped, aspect-preserving)
					// DOWNSCALED preview sized to the column width × DPR — NOT the multi-MB
					// full editor_preview image. Real manga scans are ~3000×4000 / several MB;
					// the strip keeps ~3-6 previews decoded while scrolling, so mounting the
					// full image there caused huge decode + memory → jank. `inside` preserves
					// the true tall aspect (no crop/letterbox) so the preview still matches the
					// focused full-res Fabric page seamlessly. The FOCUSED page itself still
					// loads the full-res image into Fabric (editing stays crisp).
					url: localUrl
						?? api.stripPreviewThumbnailUrl(project.projectId, id, STRIP_COLUMN_MAX_CSS),
					// Local blobs need no token; persisted previews use the `thumbnail` scope
					// (the `fit=inside` derivative is served by the thumbnail route).
					purpose: "thumbnail" as const,
				},
			};
		});
	}

	async function focusStripPage(displayIndex: number): Promise<void> {
		const page = stripPages[displayIndex];
		if (!page) return;
		if (page.pageIndex === projectStore.project?.currentPage) return;
		await projectStore.goToPage(page.pageIndex, editorStore.editor);
	}

	// Scroll-driven focus: switch the live page as the user scrolls so editing always
	// targets the page under the viewport center. Debounced so fast scrolling through a
	// long chapter never fires a goToPage (save + image reload) per intermediate page —
	// only the page the user settles on becomes live. Guarded against overlapping loads.
	let scrollFocusPending = false;
	let scrollFocusTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingFocusPageIndex: number | null = null;
	function handleStripScrollFocus(displayIndex: number): void {
		const page = stripPages[displayIndex];
		if (!page) return;
		pendingFocusPageIndex = page.pageIndex;
		if (scrollFocusTimer) clearTimeout(scrollFocusTimer);
		scrollFocusTimer = setTimeout(() => void commitScrollFocus(), 180);
	}

	onDestroy(() => {
		if (scrollFocusTimer) clearTimeout(scrollFocusTimer);
	});

	async function commitScrollFocus(): Promise<void> {
		if (scrollFocusPending) {
			// A load is in flight; retry after it settles so we land on the latest page.
			scrollFocusTimer = setTimeout(() => void commitScrollFocus(), 120);
			return;
		}
		const target = pendingFocusPageIndex;
		if (target === null || target === projectStore.project?.currentPage) return;
		scrollFocusPending = true;
		try {
			await projectStore.goToPage(target, editorStore.editor);
		} finally {
			scrollFocusPending = false;
		}
	}

	// Position the Fabric canvas host over the focused page's slot inside the scrolling
	// strip. translateY = slotTop - scrollTop keeps it pinned to the page as it scrolls;
	// a single transform write per frame is GPU-cheap and avoids layout thrash.
	let canvasHostStyle = $derived(buildCanvasHostStyle());
	function buildCanvasHostStyle(): string {
		if (!stripModeActive || !slotGeometry) return "";
		const y = slotGeometry.top - slotGeometry.scrollTop;
		return [
			"position:absolute",
			`left:${slotGeometry.left}px`,
			"top:0",
			`width:${slotGeometry.width}px`,
			`height:${slotGeometry.height}px`,
			`transform:translateY(${y}px)`,
			"will-change:transform",
		].join(";");
	}
	let currentAssetError = $derived(projectStore.currentPageAssetError);
	let currentAssetErrors = $derived(projectStore.currentPageAssetErrors);
	let overlayCounts = $derived(buildOverlayCounts());
	let showEditorOverlays = $derived(editorUiStore.workspaceView === "editor");
	let showEditorEmptyDropZone = $derived(showEditorOverlays && !projectStore.project && !editorStore.hasImage);
	let showPageSetChangedBanner = $derived(Boolean(
		showEditorOverlays
		&& projectStore.pageSetChangedNotice
		&& projectStore.pageSetChangedNotice.projectId === projectStore.project?.projectId
	));
	let pageSetReloadBusy = $state(false);
	let pageSetReloadError = $state<string | null>(null);
	let selectedAiResultLayerFocused = $derived(Boolean(editorStore.selectedImageLayer?.id?.startsWith("ai-result-")));
	let libraryEntryActive = $derived(
		editorUiStore.workspaceEditorEntry?.projectId === projectStore.project?.projectId
	);
	let selectedLayerInspectorFocused = $derived(Boolean(
		editorUiStore.inspectorOpen && (editorStore.selectedLayer || editorStore.selectedImageLayer)
	));
	let layersSelectedObjectOwnerActive = $derived(Boolean(
		selectedLayerInspectorFocused && editorUiStore.rightPanelMode === "layers"
	));
	let aiReviewInspectorFocused = $derived(Boolean(
		editorUiStore.inspectorOpen
		&& editorUiStore.rightPanelMode === "ai"
		&& overlayCounts["ai-review"] > 0
	));
	let overlayControlsQuiet = $derived(selectedLayerInspectorFocused || aiReviewInspectorFocused);
	let overlayControlsCompact = $derived(libraryEntryActive || editorUiStore.inspectorOpen);
	// QC / comment / AI-review region overlays stay VISIBLE regardless of the
	// active tool so a translator/cleaner can see issue + note coordinates while
	// brushing, typing, or running AI. They only become non-interactive
	// (pointer-events: none, via each overlay's own `.inactive` class keyed on
	// `isCanvasOverlayInteractive(currentTool)`) when a non-select tool owns the
	// pointer, so overlay clicks never steal the tool's gesture.
	let workOverlaysVisible = $derived(showEditorOverlays && !selectedAiResultLayerFocused);
	let workOverlaysSuppressed = $derived(showEditorOverlays && !selectedAiResultLayerFocused && !isCanvasOverlayInteractive(editorStore.currentTool));
	let brushTargetMissMessage = $derived(editorStore.brushTargetMissMessage);
	let brushTargetHudTone = $derived(brushTargetMissMessage ? "miss" : (editorStore.brushTarget.canBrush ? "ready" : "blocked"));
	// editor.svelte.ts emits a stable titleCode for fixed labels; null means
	// `title` is a dynamic display name shown verbatim.
	let brushTargetTitle = $derived(
		editorStore.brushTarget.titleCode
			? $_(`brushTarget.title.${editorStore.brushTarget.titleCode}`)
			: editorStore.brushTarget.title,
	);
	// The full BrushCleanHUD panel sits bottom-left (left:24, width:280). When it
	// is shown, lift the smaller brush-target pill ABOVE it so the two HUDs stack
	// cleanly instead of overlapping.
	let brushCleanHudShown = $derived(editorUiStore.showBrushHud && editorStore.brushTarget.canBrush);
	let selectedImageBrushReceipt = $derived(
		editorStore.imageLayerBrushReceiptMatches(editorStore.selectedImageLayer?.id)
			? editorStore.lastImageLayerBrushCommit
			: null
	);
	let brushTargetHudDetail = $derived(
		brushTargetMissMessage
			? brushTargetMissMessage
			: editorStore.brushTarget.kind === "image-layer"
					&& editorStore.brushTarget.canRestore
					&& selectedImageBrushReceipt
				? selectedImageBrushReceipt.mode === "restore"
					? $_("canvas.brushReceiptRestored")
					: $_("canvas.brushReceiptHasStrokes")
				: editorStore.brushTarget.kind === "image-layer"
					? $_("canvas.brushReceiptLayerOnly")
					: editorStore.brushTarget.scope
	);

	// ── Canvas accessibility ───────────────────────────────────────────────
	// The Fabric edit surface is a bare <canvas> with no accessible name. Expose a
	// stable name + a live page/layer/tool status so screen-reader users know what
	// the canvas represents and what is selected, and offer a focusable keyboard
	// path into the layer inspector (full keyboard-equivalent editing is tracked
	// separately — see PR QUESTIONS).
	let toolNames = $derived<Record<string, string>>({
		select: $_("canvas.toolSelect"),
		text: $_("canvas.toolText"),
		brush: $_("canvas.toolBrush"),
		cover: $_("canvas.toolCover"),
		crop: $_("canvas.toolCrop"),
		heal: $_("canvas.toolHeal"),
		clone: $_("canvas.toolClone"),
	});
	let canvasToolLabel = $derived(toolNames[editorStore.currentTool] ?? editorStore.currentTool);
	let canvasSelectionLabel = $derived.by(() => {
		if (editorStore.selectedLayer) {
			return $_("canvas.selectionText", { values: { name: editorStore.selectedLayer.name || editorStore.selectedLayer.text || $_("canvas.defaultTextName") } });
		}
		if (editorStore.selectedImageLayer) {
			return $_("canvas.selectionImage", { values: { name: editorStore.selectedImageLayer.name || $_("canvas.defaultLayerName") } });
		}
		return $_("canvas.selectionNone");
	});
	let canvasPageLabel = $derived(projectStore.project ? $_("canvas.pageLabel", { values: { page: projectStore.pageLabel } }) : $_("canvas.pageNone"));
	let canvasStatusMessage = $derived(
		editorStore.hasImage
			? $_("canvas.statusMessage", { values: { page: canvasPageLabel, tool: canvasToolLabel, selection: canvasSelectionLabel } })
			: $_("canvas.statusEmpty"),
	);

	function openLayerInspectorFromCanvas(): void {
		editorUiStore.setRightPanelMode("layers");
	}

	async function reloadAfterPageSetChanged(): Promise<void> {
		if (!projectStore.project || pageSetReloadBusy) return;
		const projectId = projectStore.project.projectId;
		pageSetReloadBusy = true;
		pageSetReloadError = null;
		try {
			const opened = await projectStore.reloadProjectAfterConflict(editorStore.editor, {
				createRecoveryCopy: true,
			});
			if (opened) projectStore.clearPageSetChangedNotice(projectId);
			else pageSetReloadError = $_("canvas.pageSetChangedReloadFailed");
		} catch (error) {
			console.error("[CanvasArea] reload after page-set change failed:", error);
			pageSetReloadError = $_("canvas.pageSetChangedReloadFailed");
		} finally {
			pageSetReloadBusy = false;
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		isDragOver = true;
	}

	function handleDragLeave() {
		isDragOver = false;
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragOver = false;
		if (!e.dataTransfer?.files?.length) return;
		const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
		if (imageFiles.length > 0) {
			isLoading = true;
			try {
				if (currentAssetError?.kind === "image-layer" && currentAssetError.layerId) {
					await projectStore.replaceCurrentPageImageLayerAsset(currentAssetError.layerId, imageFiles[0], editorStore.editor);
					return;
				}
				const action = resolveCanvasImageDropAction({
					hasProject: Boolean(projectStore.project),
					hasCurrentAssetError: Boolean(currentAssetError),
					fileCount: imageFiles.length,
				});
				if (action === "relink-current-page") {
					await projectStore.replaceCurrentPageImage(imageFiles[0], editorStore.editor);
				} else if (action === "relink-matching-pages") {
					await replaceMatchingPageImagesWithConfirmation(imageFiles);
				} else if (action === "create-project") {
					await projectStore.loadFiles(imageFiles, editorStore.editor);
				}
			} finally {
				isLoading = false;
			}
		}
	}

	async function replaceMatchingPageImagesWithConfirmation(files: File[]): Promise<void> {
		const preview = projectStore.getMatchingPageImageRelinkPreview(files);
		const confirmed = await pageRelinkConfirmationStore.confirmOrderFallback(preview);
		if (!confirmed) {
			projectStore.setStatusMsg(pageImageRelinkOrderFallbackCancelMessage);
			return;
		}
		await projectStore.replaceMatchingPageImages(files, editorStore.editor, {
			allowOrderFallback: preview.requiresOrderConfirmation,
		});
	}

	function assetIssueName(issue: PageAssetLoadIssue): string {
		return issue.layerName || issue.originalName || issue.imageName || issue.imageId;
	}

	function handleRelinkImage() {
		if (!currentAssetError) return;
		handleRelinkAssetIssue(currentAssetError);
	}

	function handleRelinkAssetIssue(issue: PageAssetLoadIssue) {
		if (!projectStore.project || !editorStore.editor) return;
		const layerId = issue.kind === "image-layer" ? issue.layerId : null;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			isLoading = true;
			try {
				if (layerId) {
					await projectStore.replaceCurrentPageImageLayerAsset(layerId, file, editorStore.editor);
				} else {
					await projectStore.replaceCurrentPageImage(file, editorStore.editor);
				}
			} finally {
				isLoading = false;
			}
		};
		input.click();
	}

	function handleRelinkMatchingImages() {
		if (!projectStore.project) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.multiple = true;
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
			isLoading = true;
			try {
				await replaceMatchingPageImagesWithConfirmation(files);
			} finally {
				isLoading = false;
			}
		};
		input.click();
	}

	function commentRegionKey(comment: ProjectComment): string | null {
		if (comment.layerId) return `${comment.pageIndex}:layer:${comment.layerId}`;
		if (!comment.region) return null;
		return `${comment.pageIndex}:region:${comment.region.x}:${comment.region.y}:${comment.region.w}:${comment.region.h}`;
	}

	function buildOverlayCounts(): Record<CanvasWorkOverlayKind, number> {
		const project = projectStore.project;
		if (!project) return emptyOverlayCounts;
		const pageIndex = project.currentPage;
		const qcKeys = new Set<string>();
		const commentKeys = new Set<string>();

		for (const issue of projectStore.qcReport.issues) {
			if (!issue.layerId || issue.pageIndex !== pageIndex || issue.severity === "info") continue;
			qcKeys.add(`${issue.pageIndex}:${issue.layerId}`);
		}

		for (const comment of projectStore.comments) {
			if (comment.pageIndex !== pageIndex) continue;
			if (comment.status !== "open" && comment.id !== projectStore.selectedProjectCommentId) continue;
			const key = commentRegionKey(comment);
			if (key) commentKeys.add(key);
		}

		return {
			qc: qcKeys.size,
			comment: commentKeys.size,
			"ai-review": projectStore.currentPageAiReviewMarkers.filter((marker) =>
				activeAiRegionStatuses.has(marker.status) || marker.id === projectStore.selectedAiReviewMarkerId
			).length,
		};
	}

	// Tell the editor when its container size changes. In PAGED mode the workspace IS the
	// Fabric container, so a ResizeObserver on the workspace forwards its size (as before).
	// In STRIP mode the Fabric container is the focused page's slot, sized explicitly by the
	// slot $effect below — so the workspace observer is skipped there to avoid clobbering it.
	let canvasHostEl: HTMLDivElement | undefined = $state();
	onMount(() => {
		// Observe the workspace, not the (strip-resized) host: in strip mode the Fabric
		// container is driven explicitly by the focused-slot $effect below, so a workspace
		// resize there is irrelevant and must NOT clobber the slot size. In paged mode the
		// workspace IS the canvas container, so we forward its size to Fabric as before.
		if (!containerEl || typeof ResizeObserver !== "function") return;
		let ro: ResizeObserver | null = null;
		try {
			ro = new ResizeObserver((entries) => {
				if (stripModeActive) return; // slot $effect owns Fabric sizing in strip mode
				for (const entry of entries) {
					const { width, height } = entry.contentRect;
					if (width > 0 && height > 0 && editorStore.editor) {
						editorStore.editor.setContainerSize(Math.round(width), Math.round(height));
					}
				}
			});
			ro.observe(containerEl);
		} catch {
			ro = null;
		}
		return () => ro?.disconnect();
	});

	function handleSlotGeometry(geometry: SlotGeometry | null): void {
		slotGeometry = geometry;
	}

	// In strip mode the Fabric container must match the focused page's slot (column width ×
	// the page's natural aspect) so the page fills its slot edge-to-edge with no letterbox,
	// seamless with its neighbours. The host ResizeObserver can miss this because Fabric's
	// own CSS-update guard (ignoreResizeObserver) may swallow the resize that follows the
	// slot becoming non-fullscreen — so push the settled slot size explicitly. A short RAF
	// defers past the guard's one-tick window.
	let wasStripMode = false;
	function applySlotSizeToEditor(editor: any, w: number, h: number): void {
		if (!editor || w <= 0 || h <= 0) return;
		// Re-assert against the editor's LIVE container size (not a one-shot dedupe): other
		// resize sources (editor init measuring the full workspace, the paged-mode workspace
		// observer) can revert the container, so we correct it whenever it drifts off the
		// focused slot. A microtask + rAF re-check defers past Fabric's own ignoreResize
		// guard and any same-frame init resize that would otherwise win the race.
		const needsApply = () => Math.round(editor.containerWidth) !== w || Math.round(editor.containerHeight) !== h;
		if (needsApply()) editor.setContainerSize(w, h);
		requestAnimationFrame(() => {
			if (editorStore.editor === editor && needsApply()) editor.setContainerSize(w, h);
		});
	}
	// Focused-slot DIMENSIONS only (not scrollTop). The Fabric container size depends
	// on the slot's width/height, which change when the focused page changes — NOT on
	// every scroll frame. Deriving these separately means the sizing $effect below does
	// not re-run (and schedule a rAF) on each scrollTop tick during a fast scroll.
	let focusedSlotWidth = $derived(slotGeometry ? Math.round(slotGeometry.width) : 0);
	let focusedSlotHeight = $derived(slotGeometry ? Math.round(slotGeometry.height) : 0);
	$effect(() => {
		const editor = editorStore.editor;
		const strip = stripModeActive;
		const w = focusedSlotWidth;
		const h = focusedSlotHeight;
		if (!editor) {
			wasStripMode = strip;
			return;
		}
		if (strip) {
			// Strip mode owns Fabric sizing: size the container to the focused page's slot
			// (column width × the page's true aspect) so the page fills it with no letterbox.
			if (w <= 0 || h <= 0) return;
			applySlotSizeToEditor(editor, w, h);
		} else if (wasStripMode && containerEl) {
			// Transition strip → paged: restore the workspace size once; steady-state paged
			// resizes are then handled by the workspace ResizeObserver.
			applySlotSizeToEditor(editor, Math.round(containerEl.clientWidth), Math.round(containerEl.clientHeight));
		}
		wasStripMode = strip;
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="canvas-workspace"
	class:strip-mode={stripModeActive}
	bind:this={containerEl}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	oncontextmenu={handleContextMenu}
>
	{#if stripModeActive}
		<WebtoonStrip
			bind:this={stripRef}
			pages={stripPages}
			focusedDisplay={focusedDisplayIndex}
			onFocusPage={focusStripPage}
			onScrollFocus={handleStripScrollFocus}
			onSlotGeometry={handleSlotGeometry}
		/>
	{/if}

	<!-- Fabric edit surface. In strip mode it overlays the focused page's slot (positioned
	     by canvasHostStyle, scrolling with the strip); in paged mode it fills the workspace. -->
	<div
		class="canvas-host"
		class:strip-overlay={stripModeActive}
		bind:this={canvasHostEl}
		style={canvasHostStyle}
		role="group"
		aria-label={$_("canvas.editSurfaceLabel")}
		aria-describedby="canvas-a11y-desc"
	>
		<p id="canvas-a11y-desc" class="sr-only">
			{$_("canvas.editSurfaceDescription")}
		</p>
		<!-- Live status: announces the current page, active tool, and selected layer
		     as they change, so screen-reader users track canvas state without sight. -->
		<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{canvasStatusMessage}</p>
		<canvas bind:this={canvasRef} aria-label={$_("canvas.editSurfaceLabel")}>
			{$_("canvas.canvasFallback", { values: { status: canvasStatusMessage } })}
		</canvas>
		<button
			type="button"
			class="canvas-a11y-inspector-link sr-only-focusable"
			onclick={openLayerInspectorFromCanvas}
		>
			{$_("canvas.openLayerInspector")}
		</button>
	</div>

	<!-- Concurrent-edit Phase 1: presence steering. Shows "X is editing this page"
	     with View / Take over when the open page is leased by another user or this
	     user's other tab. Non-blocking — CAS on save remains the final net. -->
	<PageLeaseBanner />
	{#if showPageSetChangedBanner}
		<div class="page-set-changed-banner" role="status" aria-live="polite">
			<span class="page-set-changed-banner__text">
				{pageSetReloadError ?? $_("canvas.pageSetChangedMessage")}
			</span>
			<button
				type="button"
				class="page-set-changed-banner__btn"
				disabled={pageSetReloadBusy}
				onclick={() => void reloadAfterPageSetChanged()}
			>
				{pageSetReloadBusy ? $_("canvas.pageSetChangedReloading") : $_("canvas.pageSetChangedReload")}
			</button>
		</div>
	{/if}

	{#if showEditorOverlays}
		<AiReviewMarkerRail />
		{#if !selectedAiResultLayerFocused}
			<QcRegionOverlay visible={workOverlaysVisible && editorUiStore.isCanvasOverlayVisible("qc")} />
			<AiReviewRegionOverlay
				visible={workOverlaysVisible && editorUiStore.isCanvasOverlayVisible("ai-review")}
				actionDockVisible={!layersSelectedObjectOwnerActive}
			/>
			<CommentRegionOverlay visible={workOverlaysVisible && editorUiStore.isCanvasOverlayVisible("comment")} />
			<TranslateSlotOverlay />
			<CanvasOverlayControls
				counts={overlayCounts}
				visibility={editorUiStore.canvasOverlayVisibility}
				interactive={isCanvasOverlayInteractive(editorStore.currentTool)}
				suppressed={workOverlaysSuppressed}
				compact={overlayControlsCompact}
				quiet={overlayControlsQuiet}
				onToggle={(kind) => editorUiStore.toggleCanvasOverlay(kind)}
			/>
		{/if}
		{#if editorStore.hasImage}
			<CanvasViewportControls
				zoom={editorStore.zoomLevel}
				zIndex={getCanvasOverlayZIndex("viewport-controls")}
				onZoomOut={() => editorStore.zoomViewportBy(0.82)}
				onReset={() => editorStore.resetViewportZoom()}
				onZoomIn={() => editorStore.zoomViewportBy(1.22)}
			/>
		{/if}
	{/if}

	{#if isLoading}
		<div class="loading-overlay" style={`z-index:${getCanvasOverlayZIndex("loading")};`}>
			<div class="spinner-large"></div>
			<p style="color: var(--editor-text-dim); font-size: 12px;">{$_("canvas.loadingPage")}</p>
		</div>
	{/if}
	{#if showEditorOverlays && editorStore.toolBusy}
		<!-- Non-blocking working badge: tool ops (heal/clone/brush commit) keep the
		     UI responsive (scroll/cancel still work) but take >150ms, so we show a
		     small busy chip instead of a modal overlay. pointer-events stay off. -->
		<div class="tool-busy-badge" style={`z-index:${getCanvasOverlayZIndex("tool-hint")};`} role="status" aria-live="polite">
			<span class="tool-busy-spinner"></span>
			<span>{editorStore.toolBusyLabel ?? $_("canvas.processing")}</span>
		</div>
	{/if}
	{#if showEditorOverlays && editorStore.currentTool === "text"}
		<div class="tool-hint" style={`z-index:${getCanvasOverlayZIndex("tool-hint")};`} role="status">
			<span>{$_("canvas.textToolHint")}</span>
			<kbd>Esc</kbd>
		</div>
	{/if}
	{#if showEditorOverlays && editorStore.currentTool === "cover"}
		<div class="tool-hint" style={`z-index:${getCanvasOverlayZIndex("tool-hint")};`} role="status">
			<!-- The "cover" engine rectangle backs BOTH the AI region tool and the
			     aspect-frame "เลือกพื้นที่" (crop) tool. Show the hint that matches
			     the active dock tool so the crop tool no longer claims "drag for AI". -->
			<span>{editorUiStore.activeDockTool === "crop" ? $_("canvas.cropToolHint") : $_("canvas.aiRegionHint")}</span>
			<kbd>Esc</kbd>
		</div>
	{/if}
	{#if showEditorOverlays && editorStore.currentTool === "brush"}
		<div
			class={`brush-target-hud ${brushTargetHudTone} ${brushCleanHudShown ? "stacked-above-panel" : ""}`}
			style={`z-index:${getCanvasOverlayZIndex("tool-hint")};`}
			role="status"
			aria-label={brushTargetMissMessage ? $_("canvas.brushOutsideWarning") : $_("canvas.brushTargetLabel")}
		>
			<span>{brushTargetMissMessage ? $_("canvas.brushOutsideLayer") : (editorStore.brushTarget.canBrush ? $_("canvas.brushReady") : $_("canvas.brushLocked"))}</span>
			<strong>{brushTargetTitle || editorStore.brushTarget.label}</strong>
			<small>{brushTargetHudDetail}</small>
		</div>
		{#if brushCleanHudShown}
			<BrushCleanHUD />
		{/if}
	{/if}
	{#if showEditorOverlays && editorStore.currentTool !== "brush"}
		<SelectionHud />
	{/if}
	{#if showEditorOverlays && currentAssetError}
		<div class="asset-error-overlay" style={`z-index:${getCanvasOverlayZIndex("asset-error")};`} role="alert">
			<div class="asset-error-card">
				<p class="asset-error-label">{currentAssetError.kind === "image-layer" ? $_("canvas.assetErrorLayerLabel") : $_("canvas.assetErrorPageLabel")}</p>
				<h2>{currentAssetError.originalName || currentAssetError.imageName || currentAssetError.imageId}</h2>
				<p>
					{#if currentAssetError.kind === "image-layer"}
						{$_("canvas.assetErrorLayerBody", { values: { name: currentAssetError.layerName || currentAssetError.layerId || $_("canvas.assetErrorLayerThis") } })}
					{:else}
						{$_("canvas.assetErrorPageBody")}
					{/if}
				</p>
				<p class="asset-error-help">
					{#if currentAssetError.kind === "image-layer"}
						{$_("canvas.assetErrorLayerHelp")}
					{:else}
						{$_("canvas.assetErrorPageHelp")}
					{/if}
				</p>
				<div class="asset-error-actions">
					<button type="button" onclick={handleRelinkImage}>
						{currentAssetError.kind === "image-layer" ? $_("canvas.relinkLayerImage") : $_("canvas.relinkPageImage")}
					</button>
					{#if currentAssetError.kind !== "image-layer"}
						<button type="button" class="secondary" onclick={handleRelinkMatchingImages}>
							{$_("canvas.relinkMatchingImages")}
						</button>
					{/if}
				</div>
				{#if currentAssetErrors.length > 1}
					<div class="asset-error-issue-list" aria-label={$_("canvas.assetErrorIssueListLabel")}>
						<p>{$_("canvas.assetErrorIssueCount", { values: { n: currentAssetErrors.length } })}</p>
						{#each currentAssetErrors as issue (`${issue.kind ?? "page"}:${issue.layerId ?? issue.imageId}`)}
							<div class="asset-error-issue-row">
								<span>{assetIssueName(issue)}</span>
								<button type="button" onclick={() => handleRelinkAssetIssue(issue)}>
									{issue.kind === "image-layer" ? $_("canvas.relinkIssueLayer") : $_("canvas.relinkIssuePage")}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
	{#if showEditorEmptyDropZone}
		<div class="drop-zone" class:drag-over={isDragOver}>
			<div class="drop-zone-inner">
				<p style="font-size: 18px; margin-bottom: 8px; color: var(--editor-text-dim);">{t.title}</p>
				<p style="font-size: 12px; color: var(--editor-border);">{t.dropImages}</p>
				<p style="font-size: 11px; margin-top: 4px; color: var(--editor-border);">{t.supportedFormats}</p>
			</div>
		</div>
	{/if}

	{#if contextMenuState}
		<ToolContextMenu
			x={contextMenuState.x}
			y={contextMenuState.y}
			onClose={closeContextMenu}
		/>
	{/if}
</div>

<style>
	/* Visually-hidden a11y copy (canvas name/description + live status). Stays in the
	   accessibility tree for screen readers but takes no visual space. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* Off-screen until focused: keyboard users can tab to the inspector shortcut and
	   see it surface, while it stays out of the visual layout otherwise. */
	.sr-only-focusable:not(:focus):not(:focus-within) {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.canvas-a11y-inspector-link:focus {
		position: absolute;
		top: 8px;
		left: 8px;
		z-index: 60;
		padding: 6px 12px;
		border: 1px solid var(--editor-accent, #7c5cff);
		border-radius: 8px;
		background: var(--editor-panel, #1a1a22);
		color: var(--editor-text, #ececf2);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}

	.page-set-changed-banner {
		position: absolute;
		top: 64px;
		left: 50%;
		z-index: 31;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		width: max-content;
		max-width: min(720px, calc(100% - 24px));
		min-height: 36px;
		padding: 7px 10px 7px 12px;
		transform: translateX(-50%);
		border: 1px solid rgba(56, 189, 248, 0.35);
		border-radius: 8px;
		background: rgba(8, 18, 28, 0.92);
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
		color: #e9f7ff;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}

	.page-set-changed-banner__text {
		min-width: 0;
		font-size: 12px;
		font-weight: 600;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.page-set-changed-banner__btn {
		flex: 0 0 auto;
		min-height: 24px;
		padding: 4px 10px;
		border: 1px solid rgba(125, 211, 252, 0.46);
		border-radius: 7px;
		background: rgba(14, 165, 233, 0.2);
		color: #f8fdff;
		font-size: 12px;
		font-weight: 700;
		white-space: nowrap;
		cursor: pointer;
	}

	.page-set-changed-banner__btn:hover:not(:disabled) {
		background: rgba(14, 165, 233, 0.3);
	}

	.page-set-changed-banner__btn:disabled {
		opacity: 0.68;
		cursor: progress;
	}

	/* Canvas host: fills + centers the Fabric canvas in paged mode. In strip mode it is
	   absolutely positioned over the focused page's slot (via inline canvasHostStyle) and
	   scrolls with the strip; its inline transform follows the strip's scrollTop. */
	.canvas-host {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}

	.canvas-host.strip-overlay {
		/* Sit above the strip previews so the focused page is the live edit surface.
		   z-index keeps it over preview <img>s but below tool HUDs (which are higher). */
		z-index: 3;
		pointer-events: auto;
	}

	/* Strip mode turns the workspace into the positioning context for the scroll overlay;
	   the flex centering only applies to paged mode. */
	.canvas-workspace.strip-mode {
		display: block;
		overflow: hidden;
	}

	.loading-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: rgba(30, 30, 30, 0.8);
	}

	.spinner-large {
		width: 40px;
		height: 40px;
		border: 4px solid rgba(255, 255, 255, 0.1);
		border-top-color: var(--editor-accent);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	.tool-busy-badge {
		position: absolute;
		top: 12px;
		right: 12px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 11px;
		border: 1px solid rgba(100, 255, 206, 0.35);
		border-radius: 999px;
		background: rgba(10, 18, 20, 0.86);
		color: #d6fff2;
		font-size: 12px;
		font-weight: 700;
		pointer-events: none;
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
		backdrop-filter: blur(6px);
	}

	.tool-busy-spinner {
		width: 13px;
		height: 13px;
		border: 2px solid rgba(214, 255, 242, 0.25);
		border-top-color: #64ffce;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	.tool-hint {
		position: absolute;
		top: 12px;
		left: 50%;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		max-width: calc(100% - 32px);
		padding: 7px 10px;
		border: 1px solid rgba(0, 120, 212, 0.55);
		border-radius: 6px;
		background: rgba(25, 27, 30, 0.92);
		color: #ffffff;
		font-size: 12px;
		font-weight: 650;
		pointer-events: none;
		transform: translateX(-50%);
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
	}

	.tool-hint kbd {
		min-width: 28px;
		padding: 2px 6px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--editor-text);
		font-family: inherit;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
	}

	.brush-target-hud {
		position: absolute;
		bottom: 24px;
		left: 64px;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		max-width: min(420px, calc(100% - 96px));
		min-height: 34px;
		padding: 5px 8px;
		border: 1px solid rgba(100, 255, 206, 0.22);
		border-radius: 999px;
		background: rgba(10, 18, 20, 0.72);
		box-shadow: 0 8px 18px rgba(0, 0, 0, 0.2);
		backdrop-filter: blur(6px);
		pointer-events: none;
	}

	/* When the full BrushCleanHUD panel is shown bottom-left (left:24; 280px
	   expanded / 320px collapsed wide), shift this pill clear to the right of it
	   so the two HUDs never overlap. Height-independent (no overlap regardless of
	   the panel's variable height). */
	.brush-target-hud.stacked-above-panel {
		left: 360px;
		max-width: min(420px, calc(100% - 384px));
	}

	.brush-target-hud.blocked {
		border-color: rgba(255, 183, 77, 0.3);
		background: rgba(28, 18, 8, 0.68);
	}

	.brush-target-hud.miss {
		border-color: rgba(248, 113, 113, 0.55);
		background: rgba(42, 12, 16, 0.78);
		box-shadow: 0 10px 24px rgba(100, 16, 24, 0.32);
	}

	.brush-target-hud span {
		color: #89ffe0;
		font-size: 10px;
		font-weight: 850;
		line-height: 1.1;
	}

	.brush-target-hud.blocked span {
		color: #ffd38b;
	}

	.brush-target-hud.miss span {
		color: #fecaca;
	}

	.brush-target-hud strong {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.brush-target-hud small {
		overflow: hidden;
		color: rgba(232, 255, 248, 0.82);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.asset-error-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background:
			linear-gradient(rgba(24, 26, 28, 0.82), rgba(24, 26, 28, 0.82)),
			repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.05) 0 10px, rgba(255, 255, 255, 0.02) 10px 20px);
		pointer-events: auto;
	}

	.asset-error-card {
		width: min(420px, 100%);
		padding: 18px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 8px;
		background: rgba(31, 34, 37, 0.96);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.36);
		color: var(--editor-text);
	}

	.asset-error-label {
		margin: 0 0 8px;
		color: #ffb86b;
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.asset-error-card h2 {
		margin: 0 0 8px;
		font-size: 16px;
		line-height: 1.25;
		word-break: break-word;
	}

	.asset-error-card p {
		margin: 0;
		color: var(--editor-text-dim);
		font-size: 12px;
		line-height: 1.45;
	}

	.asset-error-card p + p {
		margin-top: 8px;
	}

	.asset-error-help {
		color: #c9d8ee;
	}

	.asset-error-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 14px;
	}

	.asset-error-actions button {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid rgba(0, 120, 212, 0.7);
		border-radius: 6px;
		background: var(--editor-accent);
		color: #ffffff;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}

	.asset-error-actions button:hover {
		background: #1683d8;
	}

	.asset-error-actions button.secondary {
		border-color: rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.08);
		color: var(--editor-text);
	}

	.asset-error-actions button.secondary:hover {
		border-color: rgba(0, 120, 212, 0.7);
		background: rgba(0, 120, 212, 0.18);
	}

	.asset-error-issue-list {
		display: grid;
		gap: 8px;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid rgba(255, 255, 255, 0.12);
	}

	.asset-error-issue-list p {
		color: #e5edf8;
		font-weight: 700;
	}

	.asset-error-issue-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
	}

	.asset-error-issue-row span {
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.asset-error-issue-row button {
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid rgba(114, 223, 190, 0.45);
		border-radius: 6px;
		background: rgba(114, 223, 190, 0.12);
		color: #d6fff2;
		font-size: 12px;
		font-weight: 750;
		cursor: pointer;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

</style>
