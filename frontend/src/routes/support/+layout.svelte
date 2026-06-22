<!-- /support/* layout — customer support chrome.
     Page-driven (like /settings/*), outside the (workspace) group so it does not
     remount the canvas/editor shell — but mounted inside WorkspaceStandaloneShell
     so the persistent workspace sidebar (premium chrome) stays present, matching
     the dashboard IA instead of dropping to a chrome-less full-width page. The
     support-back link + brand below remain the in-section header.
     Mounts the global Toast stack here because Toast is otherwise only mounted
     inside WorkspaceShell, and the support pages surface errors (e.g. rate-limit
     429s) via toasts. -->
<script lang="ts">
	import Toast from "$lib/components/Toast.svelte";
	import WorkspaceStandaloneShell from "$lib/components/WorkspaceStandaloneShell.svelte";
	import { _ } from "$lib/i18n";
	let { children } = $props();

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<WorkspaceStandaloneShell>
<div class="support-shell ws-sans">
	<header class="support-shell-head">
		<a class="support-back ws-btn-ghost" href="/dashboard">&lt; {t("support.shell.back", "กลับ workspace")}</a>
		<span class="support-brand">{t("support.list.heading", "ศูนย์ช่วยเหลือ")} · Support</span>
	</header>
	{@render children()}
</div>

<Toast />
</WorkspaceStandaloneShell>

<style>
	.support-shell {
		/* 100% (not 100vh): inside WorkspaceStandaloneShell the content region
		   owns the scroll, so fill the wrapper rather than the whole viewport. */
		min-height: 100%;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
	}
	.support-shell-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		max-width: 880px;
		margin: 0 auto;
		padding: 20px clamp(16px, 4vw, 56px) 0;
	}
	.support-back {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		text-decoration: none;
		font-size: 13px;
	}
	.support-back:hover {
		color: var(--color-ws-ink);
	}
	.support-brand {
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}
</style>
