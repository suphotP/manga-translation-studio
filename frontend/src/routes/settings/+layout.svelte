<!-- /settings/* layout — Wave 2 W2.2.
     Wraps the billing + usage routes with a workspace-styled chrome (tab strip).
     Lives outside the (workspace) route group because that group re-mounts the
     canvas/editor shell which we don't need here — but it is now mounted inside
     WorkspaceStandaloneShell so the persistent workspace sidebar (premium chrome)
     stays present and highlights the Settings entry, matching the dashboard IA
     instead of dropping to a chrome-less full-width page. The in-settings tab
     strip below remains the section sub-nav. -->
<script lang="ts">
	import { page } from "$app/state";
	import Toast from "$lib/components/Toast.svelte";
	import WorkspaceStandaloneShell from "$lib/components/WorkspaceStandaloneShell.svelte";
	import { _ } from "$lib/i18n";
	let { children } = $props();
	let active = $derived(page.url.pathname);

	// Localise via svelte-i18n with an explicit fallback ($_ returns the key
	// itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<WorkspaceStandaloneShell>
<div class="settings-shell">
	<header class="settings-shell-head">
		<a class="settings-back" href="/dashboard">&lt; {t("settingsNav.back", "กลับ workspace")}</a>
		<nav class="settings-tabs ws-panel-quiet" aria-label={t("settingsNav.sectionsAria", "Settings sections")}>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/profile")}
				href="/settings/profile">{t("settingsNav.profile", "Profile")}</a
			>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/billing")}
				href="/settings/billing">{t("settingsNav.billing", "Billing")}</a
			>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/usage")}
				href="/settings/usage">{t("settingsNav.usage", "Usage")}</a
			>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/notifications")}
				href="/settings/notifications">{t("settingsNav.notifications", "Notifications")}</a
			>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/privacy")}
				href="/settings/privacy">{t("settingsNav.privacy", "Privacy & Data")}</a
			>
			<a
				class="settings-tab"
				class:active={active.startsWith("/settings/members")}
				href="/settings/members">{t("settingsNav.members", "Members")}</a
			>
			<!-- Customer support entry point. /support is its own top-level route
			     (auth-only, customer-scoped) — this is the single discreet link in. -->
			<a class="settings-tab" href="/support">{t("settingsNav.support", "Support")}</a>
		</nav>
	</header>
	{@render children()}
</div>
<!-- Mounted here (not just WorkspaceShell) so settings pages outside the
     workspace group still surface optimistic-save toasts. -->
<Toast />
</WorkspaceStandaloneShell>

<style>
	.settings-shell {
		min-height: 100%;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
	}
	.settings-shell-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 20px clamp(16px, 4vw, 56px) 0;
		max-width: 1080px;
		margin: 0 auto;
		font-family: var(--font-ws-sans);
	}
	.settings-back {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		color: var(--color-ws-text);
		text-decoration: none;
		font-size: 13px;
		font-weight: 700;
	}
	.settings-back:hover {
		color: var(--color-ws-ink);
	}
	.settings-tabs {
		display: inline-flex;
		gap: 4px;
		padding: 4px;
		border-radius: var(--radius-ws-card);
		/* Phones: the 6-tab pill is wider than the viewport, so let it scroll
		   horizontally with momentum rather than clipping the trailing tabs. */
		max-width: 100%;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
	}
	.settings-tabs::-webkit-scrollbar {
		display: none;
	}
	.settings-tab {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 16px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 12.5px;
		font-weight: 700;
		text-decoration: none;
		/* Keep each tab intact while the row scrolls. */
		white-space: nowrap;
		flex: 0 0 auto;
		transition: background 0.14s ease, color 0.14s ease;
	}
	.settings-tab:hover {
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
	}
	.settings-tab.active {
		background: color-mix(in srgb, var(--color-ws-accent) 24%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}
	.settings-tab:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}
	.settings-back:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
		border-radius: var(--radius-ws-ctrl);
	}

	/* Below ~480px, stack the back-link above the tab row so the back-link
	   never steals horizontal space from the scrollable tab pill. */
	@media (max-width: 480px) {
		.settings-shell-head {
			flex-wrap: wrap;
			justify-content: flex-start;
		}
		.settings-back {
			flex: 0 0 100%;
		}
		.settings-tabs {
			flex: 1 1 100%;
		}
	}
</style>
