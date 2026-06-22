<!-- PageTile - page-grid tile (matches the WorkspacePagesView page grid). Shows a
	thumbnail (DefaultCover fallback), per-role status dots, optional AI marker, a
	ready/status chip, qc + comment counts, an asset-integrity warning, and v2 marker. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import DefaultCover from "./DefaultCover.svelte";
	import { type WorkRole, type RoleState } from "./RoleBadge.svelte";
	import SparkleIcon from "./SparkleIcon.svelte";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import type { AssetAccessPurpose } from "$lib/api/client.js";

	export interface PageRoleDot {
		role: WorkRole;
		state: RoleState;
	}
	export interface PageStatusChip {
		label: string;
		// any css color (token var or hex) used for text + tinted bg/border
		color: string;
	}

	let {
		pageNo,
		thumbUrl = "",
		// Backend asset identity → load via a signed assetToken (browser <img> has
		// no Bearer header). Omitted for synthetic/local previews (plain src).
		assetProjectId = "",
		assetImageId = "",
		assetPurpose = "thumbnail",
		seed = "",
		roles = [],
		aiMarker = null,
		statusChip = null,
		qcCount = 0,
		commentCount = 0,
		assetBroken = false,
		assetLabel = undefined,
		revised = false,
		active = false,
		onclick,
		href = "",
		class: klass = "",
	}: {
		pageNo: number;
		thumbUrl?: string;
		assetProjectId?: string;
		assetImageId?: string;
		assetPurpose?: AssetAccessPurpose;
		seed?: string;
		roles?: PageRoleDot[];
		aiMarker?: PageStatusChip | null;
		statusChip?: PageStatusChip | null;
		qcCount?: number;
		commentCount?: number;
		assetBroken?: boolean;
		assetLabel?: string;
		revised?: boolean;
		active?: boolean;
		onclick?: (event: MouseEvent) => void;
		href?: string;
		class?: string;
	} = $props();

	const roleStateColor: Record<RoleState, string> = {
		done: "var(--color-ws-green)",
		active: "var(--color-ws-accent)",
		blocked: "var(--color-ws-rose)",
		todo: "var(--color-ws-faint)",
	};
	// Localized role labels for the per-role status-dot tooltip. QC stays the ASCII
	// product term; derived so the labels re-render on a locale change.
	let roleLabel = $derived<Record<WorkRole, string>>({
		qc: "QC",
		translate: $_("pageTile.roleTranslate"),
		typeset: $_("pageTile.roleTypeset"),
		clean: $_("pageTile.roleClean"),
		review: $_("pageTile.roleReview"),
	});
	// Localized fallback for the asset-missing label when the caller omits it.
	let assetLabelText = $derived(assetLabel ?? $_("pageTile.assetMissing"));

	let failed = $state(false);
	let useImage = $derived(Boolean(thumbUrl) && !failed);
	let coverSeed = $derived(seed || `page:${pageNo}`);
	// Flip to DefaultCover only AFTER signedAssetSrc has exhausted its own token
	// re-mint/retry (onFailed) — NOT on the raw <img onerror>, which fires on the
	// FIRST error and unmounts the <img> mid-retry, aborting the re-sign (a stale
	// token then stays broken instead of recovering). The non-signed branch below
	// keeps its onerror (no token to retry there).
	let signedParams = $derived<SignedAssetSrcParams | null>(
		assetProjectId && assetImageId && thumbUrl
			? { projectId: assetProjectId, imageId: assetImageId, url: thumbUrl, purpose: assetPurpose, onFailed: () => (failed = true) }
			: null,
	);
	let base = $derived(
		`page-tile group relative block overflow-hidden rounded-ws-card border bg-white/[0.02] no-underline ${active ? "border-ws-accent/50" : "border-ws-line/12"} ${klass}`,
	);
</script>

{#snippet body()}
	<div class="relative aspect-[3/4]">
		{#if useImage}
			{#if signedParams}
				<img use:signedAssetSrc={signedParams} alt="" class="h-full w-full object-cover" />
			{:else}
				<img src={thumbUrl} alt="" class="h-full w-full object-cover" onerror={() => (failed = true)} />
			{/if}
		{:else}
			<DefaultCover seed={coverSeed} ratio="portrait" />
		{/if}
		{#if aiMarker}
			<span
				class="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-semibold backdrop-blur"
				style={`color:${aiMarker.color};background:${aiMarker.color}24;border:1px solid ${aiMarker.color}4d`}
			>
				<SparkleIcon size={9} fill={aiMarker.color} />{aiMarker.label}
			</span>
		{/if}
		{#if statusChip}
			<span class="absolute bottom-1.5 left-1.5">
				<span
					class="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-medium"
					style={`color:${statusChip.color};background:${statusChip.color}1f;border-color:${statusChip.color}3d`}
				>
					<span class="ws-dot" style="width:5px;height:5px;background:currentColor"></span>{statusChip.label}
				</span>
			</span>
		{/if}
	</div>
	<div class="p-2">
		<div class="mb-1.5 flex items-center justify-between">
			<span class="text-[11px] font-medium tabular-nums text-ws-ink">{$_("pageTile.page", { values: { n: pageNo } })}</span>
			{#if revised}<span class="rounded border border-ws-green/25 bg-ws-green/15 px-1 py-px text-[9px] font-semibold text-ws-green">v2</span>{/if}
		</div>
		{#if roles.length}
			<div class="mb-1.5 flex gap-[3px]">
				{#each roles as r (r.role)}
					<span class="ws-dot" title={`${roleLabel[r.role]}: ${r.state}`} style={`width:7px;height:7px;background:${roleStateColor[r.state]}`}></span>
				{/each}
			</div>
		{/if}
		<div class="flex items-center gap-2">
			{#if qcCount > 0}
				<span class="inline-flex items-center gap-0.5 text-[10px] text-ws-amber" title={$_("pageTile.qcPending")}>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" /><circle cx="12" cy="12" r="8.5" stroke="#FBBF24" stroke-width="1.4" /></svg><span class="tabular-nums">{qcCount}</span>
				</span>
			{/if}
			{#if commentCount > 0}
				<span class="inline-flex items-center gap-0.5 text-[10px] text-ws-faint" title={$_("pageTile.comments")}>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 6h14v9H9l-4 3z" stroke="#6B6B78" stroke-width="1.5" stroke-linejoin="round" /></svg><span class="tabular-nums">{commentCount}</span>
				</span>
			{/if}
			{#if assetBroken}
				<span class="inline-flex items-center gap-0.5 text-[10px] text-ws-rose" title={assetLabelText}>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="#FB7185" stroke-width="1.4" /><path d="M9 9l6 6M15 9l-6 6" stroke="#FB7185" stroke-width="1.6" stroke-linecap="round" /></svg>{assetLabelText}
				</span>
			{:else if qcCount + commentCount === 0}
				<span class="text-[10px] text-ws-faint">—</span>
			{/if}
		</div>
	</div>
{/snippet}

{#if href}
	<a {href} class={base} {onclick} aria-label={$_("pageTile.openPage", { values: { n: pageNo } })}>{@render body()}</a>
{:else if onclick}
	<button type="button" class={`${base} w-full text-left`} {onclick} aria-label={$_("pageTile.openPage", { values: { n: pageNo } })}>{@render body()}</button>
{:else}
	<article class={base} aria-label={$_("pageTile.page", { values: { n: pageNo } })}>{@render body()}</article>
{/if}
