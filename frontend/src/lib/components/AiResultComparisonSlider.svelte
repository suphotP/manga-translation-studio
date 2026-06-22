<script lang="ts">
	// Bounded before/after comparison for an AI marker result.
	//
	// W3.18 fix: the AI result used to only be viewable by "applying" it as a
	// full-size canvas layer (an unbounded dump). This renders the source crop
	// and the AI result side-by-side inside a fixed-height, object-fit:contain
	// box with a draggable reveal divider, so the reviewer can compare without
	// the result ever painting full-size.

	import { _ } from "$lib/i18n";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";

	interface Region {
		x: number;
		y: number;
		w: number;
		h: number;
	}

	interface Props {
		// Bare/CDN/blob URLs for the two sides. Used directly when no signed-asset
		// params are supplied (e.g. already-public CDN previews or local blobs).
		beforeUrl: string;
		afterUrl: string;
		// Signed-asset params for owned-project backend assets. A browser <img src>
		// cannot send an Authorization header, so an owned-project AI result (e.g.
		// /api/images/<projectId>/result_<uuid>.png) 401s unless it carries a
		// short-lived signed assetToken. When these are set, the matching <img>
		// loads via the signedAssetSrc action (mints the token BEFORE setting src,
		// retries once on token-expiry 401), so the result never flashes a 401 or a
		// broken image. Leave null to fall back to the raw beforeUrl/afterUrl.
		beforeParams?: SignedAssetSrcParams | null;
		afterParams?: SignedAssetSrcParams | null;
		beforeLabel?: string;
		afterLabel?: string;
		alt?: string;
		// Optional source-image region the AI result corresponds to. When set,
		// the "before" side is cropped to this region so the slider compares the
		// same area as the (already-cropped) AI result instead of the full page.
		beforeCrop?: Region | null;
	}

	let {
		beforeUrl,
		afterUrl,
		beforeParams = null,
		afterParams = null,
		beforeLabel = undefined,
		afterLabel = undefined,
		alt = undefined,
		beforeCrop = null,
	}: Props = $props();

	// Localized fallbacks for the optional caller-supplied labels.
	let beforeLabelText = $derived(beforeLabel ?? $_("aiResultComparison.beforeLabel"));
	let afterLabelText = $derived(afterLabel ?? $_("aiResultComparison.afterLabel"));
	let altText = $derived(alt ?? $_("aiResultComparison.alt"));

	// Track a DEFINITIVE load failure per side (after signedAssetSrc has exhausted
	// its own token re-mint/retry) so we can show an inline fallback note instead
	// of a broken-image glyph. Reset whenever the asset identity changes.
	let beforeFailed = $state(false);
	let afterFailed = $state(false);

	$effect(() => {
		// Re-arm on any source/identity change (touch the reactive deps).
		void beforeUrl;
		void afterUrl;
		void beforeParams?.imageId;
		void afterParams?.imageId;
		beforeFailed = false;
		afterFailed = false;
	});

	// When signed params are supplied, route the assetToken-minted result through
	// the action's onFailed callback (called only AFTER its single re-mint retry)
	// instead of the raw <img onerror>, so a transient token-expiry 401 still
	// recovers silently before we flip to the fallback note.
	let beforeSignedParams = $derived<SignedAssetSrcParams | null>(
		beforeParams ? { ...beforeParams, onFailed: () => { beforeFailed = true; } } : null,
	);
	let afterSignedParams = $derived<SignedAssetSrcParams | null>(
		afterParams ? { ...afterParams, onFailed: () => { afterFailed = true; } } : null,
	);

	// Natural dimensions of the loaded "before" image, used to translate the
	// pixel-space crop region into the CSS transform that frames it.
	let beforeNaturalWidth = $state(0);
	let beforeNaturalHeight = $state(0);

	function onBeforeLoad(event: Event): void {
		const img = event.currentTarget as HTMLImageElement;
		beforeNaturalWidth = img.naturalWidth || 0;
		beforeNaturalHeight = img.naturalHeight || 0;
	}

	// Measured frame size (px). Needed to letterbox the cropped "before" the
	// same way `object-fit: contain` letterboxes the AI result.
	let frameWidth = $state(0);
	let frameHeight = $state(0);

	function measureFrame(el: HTMLElement): void {
		const rect = el.getBoundingClientRect();
		frameWidth = rect.width;
		frameHeight = rect.height;
	}

	$effect(() => {
		const el = frame;
		if (!el) return;
		measureFrame(el);
		if (typeof ResizeObserver !== "function") return;
		let observer: ResizeObserver | null = null;
		try {
			observer = new ResizeObserver((entries) => {
				const rect = entries[0]?.contentRect;
				if (!rect) return;
				frameWidth = rect.width;
				frameHeight = rect.height;
			});
			observer.observe(el);
		} catch {
			observer = null;
		}
		return () => observer?.disconnect();
	});

	// CSS that frames only `beforeCrop` of the source image, contained inside the
	// bounded frame so the "before" crop letterboxes exactly like the AI result.
	// Falls back to a plain contained full image when crop / natural size / frame
	// size are unavailable.
	let beforeCropStyle = $derived.by(() => {
		const crop = beforeCrop;
		if (!crop || crop.w <= 0 || crop.h <= 0) return "";
		if (beforeNaturalWidth <= 0 || beforeNaturalHeight <= 0) return "";
		if (frameWidth <= 0 || frameHeight <= 0) return "";
		// Contain the crop region within the frame (matches the after side).
		const containScale = Math.min(frameWidth / crop.w, frameHeight / crop.h);
		const cropDisplayW = crop.w * containScale;
		const cropDisplayH = crop.h * containScale;
		// Scaling factor applied to the *full* natural image to reach that crop scale.
		const imgDisplayW = beforeNaturalWidth * containScale;
		const imgDisplayH = beforeNaturalHeight * containScale;
		// Centre the contained crop, then shift to the region's top-left.
		const offsetLeft = (frameWidth - cropDisplayW) / 2 - crop.x * containScale;
		const offsetTop = (frameHeight - cropDisplayH) / 2 - crop.y * containScale;
		return [
			"position:absolute",
			`width:${imgDisplayW}px`,
			`height:${imgDisplayH}px`,
			`left:${offsetLeft}px`,
			`top:${offsetTop}px`,
			"object-fit:fill",
			"max-width:none",
			"max-height:none",
		].join(";");
	});

	let beforeCropped = $derived(Boolean(beforeCropStyle));

	// Reveal position as a percentage (0 = all "before", 100 = all "after").
	let position = $state(50);
	let dragging = $state(false);
	let frame = $state<HTMLDivElement | null>(null);

	function clamp(value: number): number {
		return Math.max(0, Math.min(100, value));
	}

	function setFromClientX(clientX: number): void {
		if (!frame) return;
		const rect = frame.getBoundingClientRect();
		if (rect.width <= 0) return;
		position = clamp(((clientX - rect.left) / rect.width) * 100);
	}

	function onPointerDown(event: PointerEvent): void {
		dragging = true;
		(event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId);
		setFromClientX(event.clientX);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		setFromClientX(event.clientX);
	}

	function onPointerUp(event: PointerEvent): void {
		dragging = false;
		(event.currentTarget as HTMLElement)?.releasePointerCapture?.(event.pointerId);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === "ArrowLeft") {
			position = clamp(position - 5);
			event.preventDefault();
		} else if (event.key === "ArrowRight") {
			position = clamp(position + 5);
			event.preventDefault();
		} else if (event.key === "Home") {
			position = 0;
			event.preventDefault();
		} else if (event.key === "End") {
			position = 100;
			event.preventDefault();
		}
	}
</script>

<div class="ai-result-slider" data-testid="ai-result-comparison-slider">
	<div
		class="ai-result-frame"
		bind:this={frame}
		onpointermove={onPointerMove}
		role="presentation"
	>
		<!-- Before (source crop) is the base layer. When a crop region is known
		     the image is scaled/positioned so only that region shows. Owned-project
		     assets load via signedAssetSrc (assetToken) so they never 401. -->
		<div class="ai-result-before-wrap">
			{#if beforeSignedParams}
				<img
					class="ai-result-img ai-result-before"
					class:ai-result-before-cropped={beforeCropped}
					class:ai-result-failed={beforeFailed}
					use:signedAssetSrc={beforeSignedParams}
					alt={`${beforeLabelText} — ${altText}`}
					style={beforeCropStyle}
					draggable="false"
					onload={onBeforeLoad}
				/>
			{:else}
				<img
					class="ai-result-img ai-result-before"
					class:ai-result-before-cropped={beforeCropped}
					src={beforeUrl}
					alt={`${beforeLabelText} — ${altText}`}
					style={beforeCropStyle}
					draggable="false"
					onload={onBeforeLoad}
				/>
			{/if}
			{#if beforeFailed}
				<span class="ai-result-missing">{$_("aiResultComparison.beforeLoadFailed")}</span>
			{/if}
		</div>
		<!-- After (AI result) is clipped to the reveal position. -->
		<div class="ai-result-after-wrap" style={`clip-path: inset(0 0 0 ${position}%);`}>
			{#if afterSignedParams}
				<img
					class="ai-result-img ai-result-after"
					class:ai-result-failed={afterFailed}
					use:signedAssetSrc={afterSignedParams}
					alt={`${afterLabelText} — ${altText}`}
					draggable="false"
				/>
			{:else}
				<img class="ai-result-img ai-result-after" src={afterUrl} alt={`${afterLabelText} — ${altText}`} draggable="false" />
			{/if}
			{#if afterFailed}
				<span class="ai-result-missing">{$_("aiResultComparison.afterLoadFailed")}</span>
			{/if}
		</div>

		<span class="ai-result-tag ai-result-tag-before">{beforeLabelText}</span>
		<span class="ai-result-tag ai-result-tag-after">{afterLabelText}</span>

		<div class="ai-result-divider" style={`left: ${position}%;`} aria-hidden="true">
			<span class="ai-result-handle"></span>
		</div>
	</div>

	<input
		class="ai-result-range"
		type="range"
		min="0"
		max="100"
		step="1"
		bind:value={position}
		onpointerdown={onPointerDown}
		onpointerup={onPointerUp}
		onkeydown={onKeydown}
		aria-label={$_("aiResultComparison.sliderLabel")}
		aria-valuetext={$_("aiResultComparison.valueText", { values: { percent: Math.round(position) } })}
	/>
</div>

<style>
	.ai-result-slider {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
	}

	.ai-result-frame {
		position: relative;
		width: 100%;
		/* Bounded height — the result image can never paint full-size here. */
		height: 200px;
		max-height: 40vh;
		border-radius: 8px;
		overflow: hidden;
		background:
			repeating-conic-gradient(rgba(255, 255, 255, 0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		touch-action: none;
		user-select: none;
	}

	.ai-result-before-wrap {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}

	.ai-result-img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		pointer-events: none;
	}

	/* When cropped, the inline style fully controls size/position; clear the
	   inset: 0 / 100% defaults so they don't fight the computed transform. */
	.ai-result-img.ai-result-before-cropped {
		inset: auto;
	}

	/* On a definitive load failure, hide the broken-image glyph and let the
	   inline ".ai-result-missing" note show through the checkerboard frame. */
	.ai-result-img.ai-result-failed {
		visibility: hidden;
	}

	.ai-result-missing {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.66);
		color: #f3f3f3;
		font-size: 10.5px;
		font-weight: 760;
		line-height: 1.2;
		white-space: nowrap;
		pointer-events: none;
	}

	.ai-result-after-wrap {
		position: absolute;
		inset: 0;
	}

	.ai-result-tag {
		position: absolute;
		top: 6px;
		padding: 2px 6px;
		border-radius: 5px;
		font-size: 10px;
		font-weight: 820;
		line-height: 1.2;
		background: rgba(0, 0, 0, 0.6);
		color: #f3f3f3;
		pointer-events: none;
	}

	.ai-result-tag-before {
		left: 6px;
	}

	.ai-result-tag-after {
		right: 6px;
		background: rgba(110, 231, 211, 0.28);
		color: #cffff6;
	}

	.ai-result-divider {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: rgba(255, 255, 255, 0.85);
		transform: translateX(-1px);
		pointer-events: none;
	}

	.ai-result-handle {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 18px;
		height: 18px;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45);
	}

	.ai-result-range {
		width: 100%;
		cursor: ew-resize;
	}
</style>
