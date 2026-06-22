<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import WorkspaceShell from "$lib/components/WorkspaceShell.svelte";
	import { authStore } from "$lib/stores/auth.svelte.ts";

	let { children } = $props();

	// Viewport lock — scoped to the workspace/editor cluster ONLY.
	//
	// The Fabric editor + workspace shell are a fixed full-viewport frame that
	// must not document-scroll (it would drift the canvas out from under the
	// chrome); they own their own internal overflow:auto scroll regions. We mark
	// the document with `app-viewport-locked` while any (workspace) route is
	// mounted and clear it on leave, so every OTHER route group (marketing, legal,
	// auth, settings, onboarding, admin) keeps normal document scroll. This
	// replaces the old unconditional global `html, body { overflow: hidden }` that
	// leaked the editor lock site-wide and clipped tall standalone pages.
	onMount(() => {
		document.body.classList.add("app-viewport-locked");
	});
	onDestroy(() => {
		if (typeof document !== "undefined") {
			document.body.classList.remove("app-viewport-locked");
		}
	});

	// The `+layout.ts` guard only runs on navigation. Signing out while already
	// on a guarded route (e.g. the account-menu logout, which clears the session
	// without navigating) would otherwise leave the protected shell rendered
	// until the next reload. We render only after `+layout.ts` confirmed an
	// authenticated session, so once we've observed auth here, any later drop
	// means the session was cleared in-place: bounce to /login, keeping intent.
	let sawAuthenticated = false;
	$effect(() => {
		if (typeof window === "undefined") return;
		if (authStore.isAuthenticated) {
			sawAuthenticated = true;
			return;
		}
		if (sawAuthenticated) {
			const intent = `${page.url.pathname}${page.url.search}`;
			void goto(`/login?redirect=${encodeURIComponent(intent)}`, { replaceState: true });
		}
	});

	// When a child workspace route throws, SvelteKit renders `+error.svelte`
	// into this layout's `children` slot. Normally that slot is hidden because
	// the visible UI is driven by WorkspaceShell, but on error the boundary IS
	// the page — so we must surface it (and drop the shell, which can't load).
	let hasError = $derived(Boolean(page.error));
</script>

{#if !hasError}
	<WorkspaceShell routeAware />
{/if}

<div class="workspace-route-content" class:visible={hasError} aria-hidden={hasError ? undefined : "true"}>
	{@render children()}
</div>

<style>
	.workspace-route-content {
		display: none;
	}

	.workspace-route-content.visible {
		display: contents;
	}
</style>
