<!-- WorkspaceStandaloneShell — workspace chrome (persistent sidebar) for the
     standalone, non-editor surfaces (/storage, /settings/*).

     These housekeeping routes deliberately live OUTSIDE the (workspace) route
     group because that group mounts the heavyweight Fabric editor shell, which
     they don't need. But dropping the shell entirely also dropped the premium
     left sidebar — navigating Dashboard → Storage/Settings lost all chrome and
     felt like a different app. This wrapper restores the SAME WorkspaceSidebar
     (which self-loads workspaces/usage/billing/auth and already highlights the
     Storage / Settings entries) without re-mounting the canvas editor.

     It mirrors WorkspaceShell's flex frame + mobile drawer backdrop, and adds a
     lightweight top utility bar with a hamburger so the off-canvas sidebar is
     reachable below the 1024px breakpoint (the editor Toolbar that normally owns
     the hamburger isn't present here). -->
<script lang="ts">
	import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { _ } from "$lib/i18n";

	let { children } = $props();

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<div class="workspace-standalone-shell ws-sans">
	<WorkspaceSidebar />

	{#if editorUiStore.workspaceNavOpen}
		<button
			type="button"
			class="workspace-nav-backdrop"
			aria-label={msg("sidebar.closeNav", "ปิดเมนูนำทาง")}
			onclick={() => editorUiStore.closeWorkspaceNav()}
		></button>
	{/if}

	<div class="workspace-standalone-main">
		<!-- Mobile-only utility bar: the editor Toolbar (which owns the hamburger on
		     the in-shell surfaces) isn't mounted here, so this supplies the drawer
		     toggle below the breakpoint. Hidden on wide where the rail is in-flow. -->
		<div class="workspace-standalone-topbar ws-panel-quiet">
			<button
				type="button"
				class="workspace-standalone-hamburger ws-btn-ghost rounded-ws-ctrl"
				aria-label={msg("sidebar.openNav", "เปิดเมนูนำทาง")}
				aria-expanded={editorUiStore.workspaceNavOpen}
				onclick={() => editorUiStore.toggleWorkspaceNav()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
				</svg>
			</button>
		</div>

		<div class="workspace-standalone-content">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.workspace-standalone-shell {
		display: flex;
		width: 100vw;
		height: 100vh;
		overflow: hidden;
		background:
			radial-gradient(circle at 5% 5%, color-mix(in srgb, var(--color-ws-green) 12%, transparent), transparent 45%),
			radial-gradient(circle at 95% 5%, color-mix(in srgb, var(--color-ws-accent) 12%, transparent), transparent 45%),
			var(--color-ws-bg);
	}

	.workspace-standalone-main {
		flex: 1;
		min-width: 0;
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	/* The content region owns its own scroll so the sidebar (and the locked
	   100vh frame) stay put — matching the editor shell's internal-scroll model
	   while the page itself can be arbitrarily tall. */
	.workspace-standalone-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.workspace-standalone-topbar {
		display: none;
	}

	.workspace-nav-backdrop {
		display: none;
		border: 0;
		padding: 0;
	}

	@media (max-width: 1024px) {
		.workspace-standalone-topbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-width: 0 0 1px;
			background: color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
		}

		.workspace-standalone-hamburger {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			height: 40px;
			color: var(--color-ws-ink);
			cursor: pointer;
		}

		.workspace-standalone-hamburger svg {
			width: 20px;
			height: 20px;
		}

		.workspace-nav-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 1150;
			background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
			cursor: pointer;
		}
	}
</style>
