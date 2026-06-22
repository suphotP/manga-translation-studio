<!--
	WebtoonStrip — continuous vertical (webtoon/long-strip) page renderer for the editor.

	When the chapter's reading direction is "vertical", the editor shows ALL pages as one
	continuous, seamless vertical scroll (not one page at a time). To keep a 1000-page
	chapter from crashing the browser, only pages near the viewport are mounted/decoded
	(windowing via strip-virtualization.ts); far-offscreen pages collapse to a cheap
	skeleton slot whose height keeps the scrollbar geometry honest.

	The Fabric edit surface stays the single live `<canvas>` (owned by CanvasArea). This
	component does NOT render that canvas; it renders the read-only preview images and
	exposes the focused page's slot geometry (top/height/width) so CanvasArea can overlay
	the Fabric canvas exactly on the focused page. Clicking a preview focuses that page.

	Props:
	  pages          – display-ordered page descriptors { pageIndex, params|null }.
	  focusedDisplay – the *display-order* index currently hosting the Fabric canvas.
	  onFocusPage    – called with a display-order index when the user clicks a page.
	  onScrollFocus  – called with the display-order index under the viewport center as
	                   the user scrolls (debounced via RAF), so the host can re-focus.
	  onSlotGeometry – called with { top, height, width } of the focused page's slot
	                   whenever it changes, so the host can position the Fabric canvas.
-->
<script lang="ts">
	import { onMount, tick } from "svelte";
	import { _ } from "$lib/i18n";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import {
		computeStripWindow,
		estimatePageHeight,
		focusedPageForScroll,
		stripScrollOffsetForIndex,
		DEFAULT_STRIP_GAP,
		DEFAULT_STRIP_OVERSCAN,
	} from "$lib/project/strip-virtualization.ts";

	export interface StripPage {
		/** Logical page index (1-based label = pageIndex + 1). */
		pageIndex: number;
		/** Signed preview image params, or null when no servable preview yet. */
		params: SignedAssetSrcParams | null;
	}

	export interface SlotGeometry {
		/** Focused slot top within the scroll track (px, track-relative). */
		top: number;
		height: number;
		width: number;
		/** Current scrollTop of the strip, so the host can compute on-screen position. */
		scrollTop: number;
		/** Left inset (px) of the track within the scroll viewport (padding + centering). */
		left: number;
	}

	let {
		pages = [],
		focusedDisplay = 0,
		onFocusPage,
		onScrollFocus,
		onSlotGeometry,
		gap = DEFAULT_STRIP_GAP,
	}: {
		pages?: StripPage[];
		focusedDisplay?: number;
		onFocusPage?: (displayIndex: number) => void;
		onScrollFocus?: (displayIndex: number) => void;
		onSlotGeometry?: (geometry: SlotGeometry | null) => void;
		gap?: number;
	} = $props();

	let scrollEl: HTMLDivElement | undefined = $state();
	let trackEl: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let columnWidth = $state(0);
	let trackLeft = $state(0);

	// Measured per-page heights keyed by pageIndex (stable across reorders). Until a page
	// is measured we fall back to an estimate from the column width, so the scrollbar has
	// a sensible total height before anything decodes.
	let measured = $state<Record<number, number>>({});

	const estimateHeight = $derived(estimatePageHeight(columnWidth || 600));

	const pageHeights = $derived(
		pages.map((p) => measured[p.pageIndex] ?? estimateHeight),
	);

	const stripWindow = $derived(
		computeStripWindow({
			pageHeights,
			scrollTop,
			viewportHeight,
			overscan: DEFAULT_STRIP_OVERSCAN,
			gap,
		}),
	);

	// A page is "live" (mount its <img> + decode) when inside the render window OR it is
	// the focused page (the Fabric canvas overlays it, but we still keep the slot warm so
	// it never flashes empty under the canvas while loading/zoomed out).
	function isLive(displayIndex: number): boolean {
		if (displayIndex === focusedDisplay) return true;
		return displayIndex >= stripWindow.startIndex && displayIndex <= stripWindow.endIndex;
	}

	function recordHeight(pageIndex: number, height: number): void {
		if (!(height > 0)) return;
		const prev = measured[pageIndex];
		// Avoid churn from sub-pixel ResizeObserver noise.
		if (prev !== undefined && Math.abs(prev - height) < 1) return;
		measured = { ...measured, [pageIndex]: Math.round(height) };
	}

	let rafScheduled = false;
	function onScroll(): void {
		if (!scrollEl || rafScheduled) return;
		rafScheduled = true;
		requestAnimationFrame(() => {
			rafScheduled = false;
			if (!scrollEl) return;
			scrollTop = scrollEl.scrollTop;
			const next = focusedPageForScroll(stripWindow.offsets, pageHeights, scrollTop, viewportHeight);
			if (next !== focusedDisplay) onScrollFocus?.(next);
		});
	}

	// Publish the focused slot's geometry (absolute within the scroll track) so the host
	// can place the Fabric canvas over it. Offsets are relative to the track top; the host
	// canvas lives inside the same scrolling track, so it shares the scroll automatically.
	$effect(() => {
		const offsets = stripWindow.offsets;
		if (focusedDisplay < 0 || focusedDisplay >= offsets.length) {
			onSlotGeometry?.(null);
			return;
		}
		onSlotGeometry?.({
			top: offsets[focusedDisplay],
			height: pageHeights[focusedDisplay],
			width: columnWidth,
			scrollTop,
			left: trackLeft,
		});
	});

	function measureViewport(): void {
		if (!scrollEl) return;
		viewportHeight = scrollEl.clientHeight;
		if (trackEl) {
			columnWidth = trackEl.clientWidth;
			// Track left within the scroll viewport (padding + centered max-width margin).
			trackLeft = trackEl.offsetLeft;
		} else {
			columnWidth = scrollEl.clientWidth;
			trackLeft = 0;
		}
	}

	onMount(() => {
		if (!scrollEl) return;
		measureViewport();
		if (typeof ResizeObserver !== "function") return;
		let ro: ResizeObserver | null = null;
		try {
			ro = new ResizeObserver(() => measureViewport());
			ro.observe(scrollEl);
			if (trackEl) ro.observe(trackEl);
		} catch {
			ro = null;
		}
		return () => ro?.disconnect();
	});

	/** Scroll a display-order index to the top of the viewport (used by "jump to page N"). */
	export async function scrollToDisplayIndex(displayIndex: number): Promise<void> {
		if (!scrollEl) return;
		await tick();
		const target = stripScrollOffsetForIndex(displayIndex, {
			offsets: stripWindow.offsets,
			totalHeight: stripWindow.totalHeight,
			viewportHeight,
			margin: 12,
		});
		scrollEl.scrollTo({ top: target, behavior: "smooth" });
	}
</script>

<div
	class="webtoon-strip"
	bind:this={scrollEl}
	onscroll={onScroll}
	data-virtualized="true"
	data-page-count={pages.length}
	role="list"
	aria-label={$_("webtoonStrip.listLabel")}
>
	<div class="strip-track" bind:this={trackEl} style={`height:${stripWindow.totalHeight}px;`}>
		{#each pages as page, displayIndex (page.pageIndex)}
			{@const top = stripWindow.offsets[displayIndex] ?? 0}
			{@const height = pageHeights[displayIndex]}
			{@const live = isLive(displayIndex)}
			{@const focused = displayIndex === focusedDisplay}
			<div
				class="strip-page"
				class:focused
				class:placeholder={!live}
				style={`transform:translateY(${top}px);height:${height}px;`}
				role="listitem"
				data-display-index={displayIndex}
				data-page-index={page.pageIndex}
				data-live={live ? "true" : "false"}
			>
				{#if live && page.params}
					<!-- Preview image: shown for EVERY live page (including the focused one).
					     For the focused page it sits UNDER the live Fabric canvas so the slot
					     never flashes black while Fabric (re)loads, and it provides the exact
					     rendered height that sizes the slot + Fabric container. Non-focused
					     previews are clickable to focus that page. -->
					<button
						type="button"
						class="strip-page-btn"
						class:is-focused={focused}
						aria-label={focused ? $_("webtoonStrip.editingPage", { values: { n: page.pageIndex + 1 } }) : $_("webtoonStrip.openPage", { values: { n: page.pageIndex + 1 } })}
						aria-current={focused ? "true" : undefined}
						tabindex={focused ? -1 : 0}
						onclick={() => { if (!focused) onFocusPage?.(displayIndex); }}
					>
						<img
							class="strip-page-img"
							alt={$_("webtoonStrip.pageAlt", { values: { n: page.pageIndex + 1 } })}
							decoding="async"
							loading="lazy"
							use:signedAssetSrc={page.params}
							onload={(e) => recordHeight(page.pageIndex, (e.currentTarget as HTMLImageElement).naturalHeight && columnWidth
								? Math.round(columnWidth * (e.currentTarget as HTMLImageElement).naturalHeight / Math.max(1, (e.currentTarget as HTMLImageElement).naturalWidth))
								: (e.currentTarget as HTMLImageElement).clientHeight)}
						/>
						<span class={`strip-page-num ${focused ? "strip-page-num-active" : ""}`}>{page.pageIndex + 1}</span>
					</button>
				{:else if live && !page.params}
					<button
						type="button"
						class="strip-page-btn strip-page-missing"
						class:is-focused={focused}
						aria-label={focused ? $_("webtoonStrip.editingPage", { values: { n: page.pageIndex + 1 } }) : $_("webtoonStrip.openPage", { values: { n: page.pageIndex + 1 } })}
						aria-current={focused ? "true" : undefined}
						onclick={() => { if (!focused) onFocusPage?.(displayIndex); }}
					>
						<span class={`strip-page-num ${focused ? "strip-page-num-active" : ""}`}>{page.pageIndex + 1}</span>
						<span class="strip-page-missing-label">{$_("webtoonStrip.imageNotReady")}</span>
					</button>
				{:else}
					<!-- Off-window: cheap skeleton, no image decode. -->
					<div class="strip-skeleton" aria-hidden="true">
						<span class="strip-page-num strip-page-num-dim">{page.pageIndex + 1}</span>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.webtoon-strip {
		position: absolute;
		inset: 0;
		overflow-y: auto;
		overflow-x: hidden;
		/* GPU-friendly scroll; avoid layout thrash from offscreen pages. */
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		padding: 0 clamp(8px, 4vw, 64px);
		scroll-behavior: smooth;
	}

	.strip-track {
		position: relative;
		width: 100%;
		margin: 0 auto;
		max-width: 900px;
	}

	.strip-page {
		position: absolute;
		left: 0;
		right: 0;
		width: 100%;
		/* translateY positions the page; absolute slots never reflow siblings. */
		will-change: transform;
		contain: layout paint;
	}

	/*
	 * Off-window (placeholder/skeleton) slots: skip rendering their subtree entirely
	 * until they'd scroll near the viewport. `content-visibility:auto` makes a far
	 * offscreen slot cost ~0 layout/paint; `contain-intrinsic-size` keeps its reserved
	 * box height so the scroll track geometry stays honest while skipped. The slot's
	 * inline `height` is the authoritative size; the intrinsic-size is a fallback for
	 * the brief moment before the browser has laid it out.
	 */
	.strip-page.placeholder {
		content-visibility: auto;
		contain-intrinsic-size: auto 1000px;
	}

	.strip-page-btn {
		display: block;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		position: relative;
	}

	.strip-page-img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.02);
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
	}

	.strip-page-btn:hover .strip-page-img,
	.strip-page-btn:focus-visible .strip-page-img {
		outline: 2px solid var(--editor-accent, #7c5cff);
		outline-offset: -2px;
	}

	.strip-page.focused {
		/* The Fabric canvas overlays this slot; keep the spacer invisible underneath. */
		pointer-events: none;
	}

	.strip-page-focus-spacer,
	.strip-skeleton,
	.strip-page-missing {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: 2px;
	}

	.strip-skeleton {
		background:
			linear-gradient(100deg, rgba(255, 255, 255, 0.03) 30%, rgba(255, 255, 255, 0.07) 50%, rgba(255, 255, 255, 0.03) 70%);
		background-size: 200% 100%;
		animation: strip-shimmer 1.4s ease-in-out infinite;
		border: 1px dashed rgba(255, 255, 255, 0.06);
	}

	.strip-page-missing {
		flex-direction: column;
		gap: 6px;
		background: rgba(255, 255, 255, 0.03);
		border: 1px dashed rgba(255, 255, 255, 0.12);
		color: var(--editor-text-dim, #9aa4b2);
		font-size: 12px;
	}

	.strip-page-focus-spacer {
		background: transparent;
	}

	.strip-page-num {
		position: absolute;
		top: 8px;
		left: 8px;
		padding: 1px 7px;
		border-radius: 999px;
		background: rgba(8, 10, 14, 0.72);
		color: #e8eef6;
		font-size: 11px;
		font-weight: 800;
		line-height: 1.6;
		pointer-events: none;
	}

	.strip-page-num-active {
		background: var(--editor-accent, #7c5cff);
		color: #fff;
	}

	.strip-page-num-dim {
		opacity: 0.5;
	}

	@keyframes strip-shimmer {
		0% { background-position: 180% 0; }
		100% { background-position: -180% 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.webtoon-strip { scroll-behavior: auto; }
		.strip-skeleton { animation: none; }
	}
</style>
