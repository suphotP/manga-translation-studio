<!-- WorkspacePageHeader — the ONE page-header atom shared by every workspace
	surface (dashboard / library / chapter-pages / work-board / import / reports /
	settings). Renders an optional uppercase eyebrow, a title (with optional inline
	meta), a subtitle line, and a right-aligned `actions` slot. Pairs with the
	`.ws-surface` / `.ws-surface-inner` frame and the `.ws-page-header*` styles in
	app.css so the title sizing, spacing and alignment are identical across surfaces.
	Use this instead of bespoke per-surface header markup. -->
<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		eyebrow = "",
		subtitle = "",
		meta = "",
		actions,
		titleId,
		level = 1,
	}: {
		/** Main heading text. */
		title: string;
		/** Optional uppercase kicker above the title. */
		eyebrow?: string;
		/** Optional secondary line under the title. */
		subtitle?: string;
		/** Optional dim inline note appended after the title (e.g. an English gloss). */
		meta?: string;
		/** Right-aligned action controls (buttons, receipts, badges). */
		actions?: Snippet;
		/** Optional id for the heading (aria-labelledby targets). */
		titleId?: string;
		/** Heading level — 1 for top-level surfaces, 2 for nested sections. */
		level?: 1 | 2;
	} = $props();
</script>

<div class="ws-page-header">
	<div class="ws-page-header-text">
		{#if eyebrow}
			<span class="ws-page-header-eyebrow">{eyebrow}</span>
		{/if}
		{#if level === 2}
			<h2 class="ws-page-header-title" id={titleId}>
				{title}{#if meta}<span class="ws-page-header-meta">{meta}</span>{/if}
			</h2>
		{:else}
			<h1 class="ws-page-header-title" id={titleId}>
				{title}{#if meta}<span class="ws-page-header-meta">{meta}</span>{/if}
			</h1>
		{/if}
		{#if subtitle}
			<p class="ws-page-header-sub">{subtitle}</p>
		{/if}
	</div>
	{#if actions}
		<div class="ws-page-header-actions">
			{@render actions()}
		</div>
	{/if}
</div>
