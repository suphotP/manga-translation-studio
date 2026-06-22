<!--
  LegalDocument — shared prose shell for Terms / Privacy pages.
  Renders a title, "last updated" line, an optional plain-language summary, and
  applies consistent readable typography to the slotted document body.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		updated,
		summary,
		children,
	}: {
		title: string;
		updated: string;
		summary?: string;
		children: Snippet;
	} = $props();
</script>

<article class="legal-doc">
	<header>
		<h1>{title}</h1>
		<p class="legal-doc-updated">Last updated: {updated}</p>
		{#if summary}
			<p class="legal-doc-summary">{summary}</p>
		{/if}
	</header>

	<div class="legal-doc-body">
		{@render children()}
	</div>
</article>

<style>
	.legal-doc {
		line-height: 1.65;
	}

	.legal-doc h1 {
		font-size: clamp(26px, 4vw, 34px);
		font-weight: 800;
		letter-spacing: -0.01em;
		margin: 0 0 8px;
	}

	.legal-doc-updated {
		margin: 0;
		font-size: 13px;
		color: #6b6b78;
	}

	.legal-doc-summary {
		margin: 16px 0 0;
		padding: 14px 16px;
		border: 1px solid rgba(124, 92, 255, 0.28);
		border-radius: 12px;
		background: rgba(124, 92, 255, 0.08);
		font-size: 13.5px;
		color: #cdc7f0;
	}

	.legal-doc-body {
		margin-top: 28px;
		font-size: 14.5px;
		color: #c4c4cf;
	}

	.legal-doc-body :global(h2) {
		font-size: 19px;
		font-weight: 700;
		color: #ececf2;
		margin: 34px 0 10px;
	}

	.legal-doc-body :global(h3) {
		font-size: 15.5px;
		font-weight: 700;
		color: #ececf2;
		margin: 22px 0 8px;
	}

	.legal-doc-body :global(p) {
		margin: 0 0 14px;
	}

	.legal-doc-body :global(ul) {
		margin: 0 0 14px;
		padding-left: 22px;
		list-style: disc;
	}

	.legal-doc-body :global(li) {
		margin: 0 0 6px;
	}

	.legal-doc-body :global(a) {
		color: #8fb8ff;
		text-decoration: underline;
	}

	.legal-doc-body :global(strong) {
		color: #ececf2;
	}

	.legal-doc-body :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0 0 18px;
		font-size: 13.5px;
	}

	.legal-doc-body :global(th),
	.legal-doc-body :global(td) {
		border: 1px solid rgba(255, 255, 255, 0.1);
		padding: 9px 11px;
		text-align: left;
		vertical-align: top;
	}

	.legal-doc-body :global(th) {
		background: rgba(255, 255, 255, 0.04);
		color: #ececf2;
		font-weight: 600;
	}
</style>
