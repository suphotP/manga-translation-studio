<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import CookieConsent from "$lib/components/CookieConsent.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";
	import SearchModal from "$lib/components/SearchModal.svelte";
	import ShortcutsHelp from "$lib/components/ShortcutsHelp.svelte";
	import AuthModal from "$lib/components/auth/AuthModal.svelte";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	let { children } = $props();

	// Register the AI-jobs sign-out wipe ONCE, at the app root that mounts on every
	// route and lives for the whole session. This decouples the wipe from the
	// WorkspaceShell lifecycle: signing out from a non-shell route (e.g. /settings)
	// still clears this session's AI queue/prompts/thumbnails before the next user
	// signs in. registerSignOutCleanup is idempotent and dynamically imports authStore,
	// so it never pulls auth's module side effects into the ai-jobs store's static
	// import graph (keeps the store-level unit tests' api mock clean).
	onMount(() => {
		void aiJobsStore.registerSignOutCleanup();
	});

	// Localise via svelte-i18n with an explicit fallback ($_ echoes the key back
	// on a miss / before init, so guard against that). Mirrors the settings pages.
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<a href="#main-content" class="skip-to-content">{t("a11y.skipToContent", "Skip to main content")}</a>

<!--
	Global skip-link target. Wrapping every route's content guarantees the
	skip link always lands on real content, including non-workspace routes
	(/tools, /pricing, error pages) that have no WorkspaceShell. tabindex="-1"
	makes the wrapper programmatically focusable so the in-page jump moves
	keyboard focus, not just the scroll position.
-->
<div id="main-content" tabindex="-1">
	{@render children()}
</div>

<CookieConsent />
<CommandPalette />
<!-- Global "/" content search (real projects/chapters + workspaces) and the
	"?" keyboard-shortcuts reference. Mounted once at the root, like the palette,
	so any surface can open them via their shared stores. -->
<SearchModal />
<ShortcutsHelp />
<!-- Global in-context auth overlay. Mounted once at the root so any "Sign in" /
	"Get started" trigger (`authUiStore.openAuthModal(...)`) can surface it without
	a route navigation; the existing (auth) routes remain the canonical deep-link. -->
<AuthModal />

<style>
	/* Layout-transparent wrapper: keeps the skip-link target on every route
	   without altering any page's box model (WorkspaceShell's full-viewport
	   grid, public pages, error shells all lay out as if unwrapped). */
	#main-content {
		display: contents;
	}

	/* Skip link: visually hidden until focused, then pinned top-left. */
	.skip-to-content {
		position: fixed;
		top: 8px;
		left: 8px;
		z-index: 3000;
		padding: 10px 16px;
		border: 1px solid rgba(124, 92, 255, 0.6);
		border-radius: 8px;
		background: var(--color-ws-surface, #15151d);
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		transform: translateY(-150%);
		transition: transform 0.16s ease;
	}

	.skip-to-content:focus {
		transform: translateY(0);
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.skip-to-content {
			transition: none;
		}
	}
</style>
