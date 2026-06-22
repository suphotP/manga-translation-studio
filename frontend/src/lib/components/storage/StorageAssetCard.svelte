<!-- StorageAssetCard — one image in the storage library grid: a downscaled,
     UNCROPPED (fit=inside, #251) signed thumbnail, its size (the headline — this
     surface is about reclaiming space), project label, kind badge, and a delete
     action. Single-responsibility card reused across the grid. ws-* tokens only. -->
<script lang="ts">
	import * as api from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { signedAssetSrc } from "$lib/actions/signedAssetSrc.ts";
	import { formatBytes } from "$lib/stores/usage.svelte.ts";
	import type { WorkspaceStorageAsset } from "$lib/api/client.ts";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		asset,
		showProject = true,
		deleting = false,
		onDelete,
	}: {
		asset: WorkspaceStorageAsset;
		/** Hide the project chip when the grid is already scoped to one project. */
		showProject?: boolean;
		deleting?: boolean;
		onDelete: (asset: WorkspaceStorageAsset) => void;
	} = $props();

	let imageFailed = $state(false);
	let totalBytes = $derived(asset.sizeBytes + asset.derivativeBytes);
	let thumbUrl = $derived(api.thumbnailUrl(asset.projectId, asset.imageId, 320, 1280, "inside"));
</script>

<figure class="asset-card">
	<div class="asset-thumb">
		{#if imageFailed}
			<div class="asset-thumb-fallback" aria-hidden="true">IMG</div>
		{:else}
			<img
				alt={asset.originalName}
				use:signedAssetSrc={{ projectId: asset.projectId, imageId: asset.imageId, url: thumbUrl, purpose: "thumbnail", onFailed: () => (imageFailed = true) }}
			/>
		{/if}
		<span class="asset-kind" class:ai={asset.kind === "ai-generated"}>
			{asset.kind === "ai-generated"
				? t("storage.kindAiGenerated", "สร้างด้วย AI")
				: t("storage.kindUploaded", "อัปโหลด")}
		</span>
	</div>
	<figcaption class="asset-meta">
		<strong class="asset-size">{formatBytes(totalBytes)}</strong>
		<span class="asset-name" title={asset.originalName}>{asset.originalName}</span>
		<span class="asset-dims">{asset.width}×{asset.height}</span>
		{#if showProject}
			<span class="asset-project" title={asset.projectName}>{asset.projectName}</span>
		{/if}
		<button
			type="button"
			class="asset-delete"
			disabled={deleting}
			onclick={() => onDelete(asset)}
		>
			{deleting ? t("storage.deleteBusy", "กำลังลบ…") : t("storage.delete", "ลบ")}
		</button>
	</figcaption>
</figure>

<style>
	.asset-card {
		display: flex;
		flex-direction: column;
		margin: 0;
		border-radius: var(--radius-ws-card, 12px);
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.08));
		background: rgba(255, 255, 255, 0.02);
		overflow: hidden;
		transition: border-color 0.14s ease, background 0.14s ease;
	}
	.asset-card:hover {
		border-color: var(--ws-hair-strong, rgba(255, 255, 255, 0.16));
		background: rgba(255, 255, 255, 0.04);
	}
	.asset-thumb {
		position: relative;
		aspect-ratio: 3 / 4;
		background: #0d0d14;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.asset-thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.asset-thumb-fallback {
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.1em;
		color: var(--color-ws-faint, #6b6b78);
	}
	.asset-kind {
		position: absolute;
		top: 6px;
		left: 6px;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
		background: rgba(0, 0, 0, 0.55);
		color: #d6d6e0;
		backdrop-filter: blur(4px);
	}
	.asset-kind.ai {
		background: rgba(124, 92, 255, 0.45);
		color: #fff;
	}
	.asset-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px 12px;
		min-width: 0;
	}
	.asset-size {
		font-size: 15px;
		font-weight: 800;
		color: var(--color-ws-ink, #ececf2);
	}
	.asset-name {
		font-size: 12px;
		color: var(--color-ws-text, #9a9aa8);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.asset-dims {
		font-size: 11px;
		color: var(--color-ws-faint, #6b6b78);
	}
	.asset-project {
		margin-top: 2px;
		font-size: 11px;
		color: var(--color-ws-violet, #8b5cf6);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.asset-delete {
		margin-top: 8px;
		align-self: flex-start;
		padding: 5px 12px;
		border-radius: var(--radius-ws-ctrl, 10px);
		border: 1px solid rgba(251, 113, 133, 0.4);
		background: rgba(251, 113, 133, 0.1);
		color: #ffd0d8;
		font-size: 12px;
		font-weight: 700;
		font-family: inherit;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.asset-delete:hover:not(:disabled) {
		background: rgba(251, 113, 133, 0.2);
		border-color: rgba(251, 113, 133, 0.65);
	}
	.asset-delete:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
