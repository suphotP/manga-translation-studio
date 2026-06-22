<!-- CoverCard - cover art tile. Uses the uploaded image when `imageUrl` is given,
	otherwise falls back to the deterministic DefaultCover (seeded by `seed`). Optional
	title/meta overlay with a legibility scrim. Ratio mirrors DefaultCover. -->
<script lang="ts">
	import DefaultCover, { type CoverRatio } from "./DefaultCover.svelte";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import type { AssetAccessPurpose } from "$lib/api/client.js";

	let {
		seed,
		imageUrl = "",
		// When the cover is a backend asset, pass its identity so we can attach a
		// signed assetToken (a browser <img> can't send a Bearer header → 401).
		// Falls back to a plain `src` when omitted (e.g. synthetic/demo covers).
		assetProjectId = "",
		assetImageId = "",
		assetPurpose = "thumbnail",
		title = "",
		meta = "",
		ratio = "portrait",
		class: klass = "",
	}: {
		seed: string;
		imageUrl?: string;
		assetProjectId?: string;
		assetImageId?: string;
		assetPurpose?: AssetAccessPurpose;
		title?: string;
		meta?: string;
		ratio?: CoverRatio;
		class?: string;
	} = $props();

	const ratioClass: Record<CoverRatio, string> = {
		portrait: "aspect-[3/4]",
		wide: "aspect-[16/9]",
		square: "aspect-square",
	};

	let failed = $state(false);
	let useImage = $derived(Boolean(imageUrl) && !failed);
	let hasOverlay = $derived(Boolean(title || meta));
	// Use the signed-token loader only for real backend assets; otherwise the
	// imageUrl is rendered directly on `src`.
	// Only fall back to DefaultCover once the signedAssetSrc action has exhausted its
	// own token re-mint/retry (onFailed) — NOT on the first raw `error`, which would
	// unmount the <img> before the re-mint completes and leave thumbnails blank/401.
	let signedParams = $derived<SignedAssetSrcParams | null>(
		assetProjectId && assetImageId && imageUrl
			? {
				projectId: assetProjectId,
				imageId: assetImageId,
				url: imageUrl,
				purpose: assetPurpose,
				onFailed: () => (failed = true),
			}
			: null,
	);
</script>

<div class={`relative isolate w-full overflow-hidden rounded-ws-card ${ratioClass[ratio]} ${klass}`}>
	{#if useImage}
		{#if signedParams}
			<img
				use:signedAssetSrc={signedParams}
				alt={title ? `${title} cover` : ""}
				loading="lazy"
				decoding="async"
				class="absolute inset-0 h-full w-full object-cover"
			/>
		{:else}
			<img
				src={imageUrl}
				alt={title ? `${title} cover` : ""}
				loading="lazy"
				decoding="async"
				class="absolute inset-0 h-full w-full object-cover"
				onerror={() => (failed = true)}
			/>
		{/if}
		<!-- micro-gloss + bottom scrim to match the mockups -->
		<span class="pointer-events-none absolute inset-0" style="background:linear-gradient(160deg, rgba(255,255,255,0.12), transparent 42%)"></span>
		{#if hasOverlay}
			<span class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2" style="background:linear-gradient(0deg, rgba(5,5,12,0.78), transparent)"></span>
		{/if}
	{:else}
		<DefaultCover {seed} {ratio} title={hasOverlay ? "" : title} class="absolute inset-0" />
	{/if}

	{#if hasOverlay}
		<div class="absolute inset-x-0 bottom-0 z-10 p-3">
			{#if title}
				<p class="ws-sans line-clamp-2 text-[13px] font-semibold leading-tight text-white/95 drop-shadow">{title}</p>
			{/if}
			{#if meta}
				<p class="ws-sans mt-0.5 truncate text-[11px] font-medium tabular-nums text-white/70">{meta}</p>
			{/if}
		</div>
	{/if}
</div>
