<!--
  Root route — redirects to /dashboard (see +page.ts). This fallback only shows
  for the brief moment before the client redirect resolves.
-->
<script lang="ts">
	import { _ } from "$lib/i18n";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<svelte:head>
	<title>{msg("landing.title", "Comic Workspace")}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="root-redirect" role="status" aria-live="polite">
	<span>{msg("landing.opening", "กำลังเปิดพื้นที่ทำงานของคุณ…")}</span>
	<noscript><a href="/dashboard">{msg("landing.goToWorkspace", "ไปที่พื้นที่ทำงานของคุณ")}</a></noscript>
</div>

<style>
	.root-redirect {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		background: #05070c;
		color: #9a9aa8;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 14px;
	}

	.root-redirect a {
		color: #8fb8ff;
		text-decoration: underline;
	}
</style>
