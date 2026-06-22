<!--
ReviewPageCanvas — read-only render of ONE chapter page for the QC review reader.

This is NOT the editor canvas (the editor owns Fabric / CanvasArea). It renders an
EXPORT-like preview: the lightweight downscaled `fit=inside` thumbnail derivative
(never the multi-MB full image), an optional translated-text overlay the layer
toggle controls, the existing on-page review annotations as an SVG overlay, and —
when an annotation tool is active — a lightweight drawing surface that emits a
normalized `ReviewAnnotation` on pointer-up. All coordinates are normalized to the
rendered preview box so a mark drawn here persists correctly at full resolution.
-->
<script lang="ts">
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { stripPreviewThumbnailUrl } from "$lib/api/client.js";
	import {
		annotationBoxPx,
		buildAnnotation,
		freehandPolylinePoints,
		pointerToNormalized,
		type ReviewAnnotationItem,
		type Vec2,
	} from "$lib/project/review-annotations.js";
	import { overlayOpacityForView, type ReviewLayerView, type ReviewReaderPage } from "$lib/project/review-reader.js";
	import { _ } from "$lib/i18n";
	import type { ReviewAnnotation, ReviewAnnotationShape } from "$lib/types.js";

	function msg(key: string, fallback: string, vars?: Record<string, string | number>): string {
		const value = vars ? $_(key, { values: vars }) : $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		page,
		projectId,
		columnWidth,
		layerView = "translated",
		annotations = [],
		tool = null,
		selectedCommentId = null,
		onMeasured,
		onDrawAnnotation,
		onSelectAnnotation,
	}: {
		page: ReviewReaderPage;
		projectId: string;
		columnWidth: number;
		layerView?: ReviewLayerView;
		annotations?: ReviewAnnotationItem[];
		/** Active annotation tool, or null for pure reading (no draw surface). */
		tool?: ReviewAnnotationShape | null;
		selectedCommentId?: string | null;
		/** Reports the rendered page box height once the preview decodes. */
		onMeasured?: (pageIndex: number, height: number) => void;
		/** Fired when the reviewer finishes a mark; parent persists it as a comment. */
		onDrawAnnotation?: (pageIndex: number, annotation: ReviewAnnotation) => void;
		onSelectAnnotation?: (commentId: string) => void;
	} = $props();

	let boxEl = $state<HTMLDivElement | null>(null);
	let imgEl = $state<HTMLImageElement | null>(null);
	let boxWidth = $state(0);
	let boxHeight = $state(0);
	let imageLoaded = $state(false);
	let failed = $state(false);

	// Drawing state (pointer-driven). Kept local so the heavy reader never re-renders
	// the whole strip while a single page is being scribbled on.
	let drawing = $state(false);
	let drawStart = $state<Vec2 | null>(null);
	let drawCurrent = $state<Vec2 | null>(null);
	let freehandPoints = $state<Vec2[]>([]);

	const previewUrl = $derived(
		page.imageId ? stripPreviewThumbnailUrl(projectId, page.imageId, columnWidth || 900) : "",
	);
	const signedParams = $derived<SignedAssetSrcParams | null>(
		page.imageId && previewUrl
			? { projectId, imageId: page.imageId, url: previewUrl, purpose: "thumbnail", onFailed: () => (failed = true) }
			: null,
	);
	const overlayOpacity = $derived(overlayOpacityForView(layerView));
	const showOverlay = $derived(overlayOpacity > 0 && page.textLayers.length > 0);

	// Source extent used to position the text overlay. Prefer the page's resolved
	// source size; fall back to the rendered box aspect (correct for baked previews).
	const sourceW = $derived(page.sourceSize?.width ?? (boxWidth > 0 ? boxWidth : 1));
	const sourceH = $derived(page.sourceSize?.height ?? (boxHeight > 0 ? boxHeight : 1));
	// Aspect ratio used to give the <img> an honest height BEFORE its bytes decode, so
	// the page box reports a real height from the first paint (fixes the long-scroll
	// window collapsing to ~1 page). Known source size wins; otherwise a portrait
	// manga default keeps the slot tall rather than zero-height.
	const imgAspect = $derived(
		page.sourceSize && page.sourceSize.width > 0 && page.sourceSize.height > 0
			? `${page.sourceSize.width} / ${page.sourceSize.height}`
			: "1 / 1.45",
	);

	function pct(value: number, extent: number): number {
		return extent > 0 ? (value / extent) * 100 : 0;
	}

	function measure(): void {
		if (!boxEl) return;
		const rect = boxEl.getBoundingClientRect();
		boxWidth = rect.width;
		boxHeight = rect.height;
		if (boxHeight > 0) onMeasured?.(page.pageIndex, boxHeight);
	}

	function onImageLoad(): void {
		imageLoaded = true;
		measure();
	}

	// Report the REAL rendered height back to the reader whenever the column width
	// changes or the image finishes decoding. Without this, the reader keeps the
	// aspect-based ESTIMATE for every page below the first paint, so the virtualization
	// window (which derives its geometry from those heights) can collapse to ~1 page on
	// a heavy chapter. `page.pageIndex` and `columnWidth` are read so the effect re-runs
	// on resize / page reuse; `imageLoaded` so a freshly decoded page reports its true
	// height. The measure is deferred a frame so layout has settled.
	$effect(() => {
		void page.pageIndex;
		void columnWidth;
		void imageLoaded;
		if (!boxEl) return;
		const id = requestAnimationFrame(measure);
		return () => cancelAnimationFrame(id);
	});

	function localPoint(event: PointerEvent): Vec2 {
		if (!boxEl) return { x: 0, y: 0 };
		const rect = boxEl.getBoundingClientRect();
		return pointerToNormalized(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
	}

	function onPointerDown(event: PointerEvent): void {
		if (!tool) return;
		event.preventDefault();
		const point = localPoint(event);
		drawing = true;
		drawStart = point;
		drawCurrent = point;
		freehandPoints = tool === "freehand" ? [point] : [];
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!drawing || !tool) return;
		const point = localPoint(event);
		drawCurrent = point;
		if (tool === "freehand") freehandPoints = [...freehandPoints, point];
	}

	function onPointerUp(event: PointerEvent): void {
		if (!drawing || !tool || !drawStart || !drawCurrent) {
			resetDraw();
			return;
		}
		const annotation = buildAnnotation(tool, drawStart, drawCurrent, { points: freehandPoints });
		resetDraw();
		(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		if (annotation) onDrawAnnotation?.(page.pageIndex, annotation);
	}

	function resetDraw(): void {
		drawing = false;
		drawStart = null;
		drawCurrent = null;
		freehandPoints = [];
	}

	// Live preview of the in-progress mark.
	const draftBox = $derived.by(() => {
		if (!drawing || !tool || !drawStart || !drawCurrent || tool === "freehand" || tool === "pin") return null;
		const x = Math.min(drawStart.x, drawCurrent.x) * 100;
		const y = Math.min(drawStart.y, drawCurrent.y) * 100;
		const w = Math.abs(drawCurrent.x - drawStart.x) * 100;
		const h = Math.abs(drawCurrent.y - drawStart.y) * 100;
		return { x, y, w, h };
	});
	const draftFreehand = $derived.by(() => {
		if (!drawing || tool !== "freehand" || freehandPoints.length < 2) return "";
		return freehandPoints.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(" ");
	});
</script>

<div class="review-page" class:textless={page.textless} data-page-index={page.pageIndex}>
	<div
		bind:this={boxEl}
		class="review-page-box ws-panel-quiet"
		class:drawable={Boolean(tool)}
		role="presentation"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={resetDraw}
	>
		{#if page.imageId && signedParams && !failed}
			<img
				bind:this={imgEl}
				class="review-page-img"
				alt={msg("review.pageAlt", `Page ${page.pageIndex + 1}`, { n: page.pageIndex + 1 })}
				loading="lazy"
				decoding="async"
				style={imageLoaded ? "" : `aspect-ratio:${imgAspect}`}
				use:signedAssetSrc={signedParams}
				onload={onImageLoad}
			/>
		{:else}
			<div class="review-page-missing">
				<span>{msg("review.pageAlt", `Page ${page.pageIndex + 1}`, { n: page.pageIndex + 1 })}</span>
				<small>{failed ? msg("review.imgFailed", "Could not load image") : msg("review.imgMissing", "No page image")}</small>
			</div>
		{/if}

		{#if showOverlay}
			<div class="review-overlay" style={`opacity:${overlayOpacity}`} aria-hidden="true">
				{#each page.textLayers as layer (layer.id)}
					<div
						class="review-text"
						style={`left:${pct(layer.x, sourceW)}%;top:${pct(layer.y, sourceH)}%;width:${pct(layer.w, sourceW)}%;height:${pct(layer.h, sourceH)}%;`}
					>
						<span>{layer.text}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Persisted annotations (SVG keeps freehand crisp; uses a 0..100 viewBox so
			marks scale with the box without recomputing on resize). -->
		<svg class="review-annot-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
			{#each annotations as item (item.comment.id)}
				{@const a = item.annotation}
				{@const selected = item.comment.id === selectedCommentId}
				{@const resolved = item.comment.status === "resolved"}
				{@const color = a.color || "var(--color-ws-amber)"}
				{#if a.shape === "circle"}
					<ellipse
						cx={(a.x + a.w / 2) * 100}
						cy={(a.y + a.h / 2) * 100}
						rx={Math.max(0.6, (a.w / 2) * 100)}
						ry={Math.max(0.6, (a.h / 2) * 100)}
						fill="none"
						stroke={color}
						stroke-width={selected ? 1.1 : 0.7}
						opacity={resolved ? 0.4 : 1}
						vector-effect="non-scaling-stroke"
					/>
				{:else if a.shape === "rect"}
					<rect
						x={a.x * 100}
						y={a.y * 100}
						width={Math.max(0.6, a.w * 100)}
						height={Math.max(0.6, a.h * 100)}
						fill="none"
						stroke={color}
						stroke-width={selected ? 1.1 : 0.7}
						opacity={resolved ? 0.4 : 1}
						vector-effect="non-scaling-stroke"
					/>
				{:else if a.shape === "freehand"}
					<polyline
						points={freehandPolylinePoints(a, 100, 100)}
						fill="none"
						stroke={color}
						stroke-width={selected ? 1.1 : 0.7}
						stroke-linecap="round"
						stroke-linejoin="round"
						opacity={resolved ? 0.4 : 1}
						vector-effect="non-scaling-stroke"
					/>
				{:else}
					<circle cx={a.x * 100} cy={a.y * 100} r="1.4" fill={color} opacity={resolved ? 0.4 : 1} />
				{/if}
			{/each}

			<!-- in-progress draft -->
			{#if draftBox && tool === "rect"}
				<!-- style:stroke, NOT the stroke attribute: SVG presentation attributes do not resolve var() -->
				<rect x={draftBox.x} y={draftBox.y} width={draftBox.w} height={draftBox.h} fill="none" style:stroke="var(--color-ws-accent)" stroke-width="0.7" stroke-dasharray="1.5 1" vector-effect="non-scaling-stroke" />
			{:else if draftBox && tool === "circle"}
				<ellipse cx={draftBox.x + draftBox.w / 2} cy={draftBox.y + draftBox.h / 2} rx={Math.max(0.3, draftBox.w / 2)} ry={Math.max(0.3, draftBox.h / 2)} fill="none" style:stroke="var(--color-ws-accent)" stroke-width="0.7" stroke-dasharray="1.5 1" vector-effect="non-scaling-stroke" />
			{:else if draftFreehand}
				<polyline points={draftFreehand} fill="none" style:stroke="var(--color-ws-accent)" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
			{/if}
		</svg>

		<!-- Clickable pins / numbered markers (HTML so they stay crisp + tappable). -->
		{#if !tool}
			{#each annotations as item, idx (item.comment.id)}
				{@const box = annotationBoxPx(item.annotation, 100, 100)}
				<button
					type="button"
					class="review-pin ws-btn-ghost"
					class:selected={item.comment.id === selectedCommentId}
					class:resolved={item.comment.status === "resolved"}
					style={`left:${box.centerX}%;top:${item.annotation.shape === "pin" ? box.top : box.top}%;`}
					title={item.comment.body}
					onclick={() => onSelectAnnotation?.(item.comment.id)}
				>{idx + 1}</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.review-page {
		display: flex;
		justify-content: center;
		width: 100%;
	}
	.review-page-box {
		position: relative;
		width: 100%;
		max-width: 100%;
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		overflow: hidden;
		line-height: 0;
	}
	.review-page-box.drawable {
		cursor: crosshair;
		touch-action: none;
	}
	.review-page-img {
		display: block;
		width: 100%;
		height: auto;
		user-select: none;
		-webkit-user-drag: none;
	}
	.review-page-missing {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		aspect-ratio: 3 / 4;
		color: var(--color-ws-text);
		line-height: 1.3;
	}
	.review-page-missing span {
		font-size: 13px;
		font-weight: 800;
	}
	.review-page-missing small {
		font-size: 11px;
		opacity: 0.7;
	}
	.review-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.review-text {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 2px;
		text-align: center;
		color: var(--color-ws-bg);
		background: color-mix(in srgb, var(--color-ws-ink) 92%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-bg) 10%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		overflow: hidden;
		line-height: 1.05;
	}
	.review-text span {
		font-size: clamp(7px, 1.1vw, 13px);
		font-weight: 600;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.review-annot-layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.review-pin {
		position: absolute;
		transform: translate(-50%, -50%);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 36px;
		height: 36px;
		padding: 0 5px;
		border: 1px solid color-mix(in srgb, var(--color-ws-bg) 28%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-amber);
		color: var(--color-ws-bg);
		font-size: 11px;
		font-weight: 900;
		line-height: 1;
		cursor: pointer;
	}
	.review-pin.selected {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 1px;
	}
	.review-pin.resolved {
		background: color-mix(in srgb, var(--color-ws-faint) 78%, var(--color-ws-bg));
		color: var(--color-ws-ink);
		opacity: 0.7;
	}
</style>
