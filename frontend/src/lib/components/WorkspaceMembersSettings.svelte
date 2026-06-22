<!-- WorkspaceMembersSettings — the in-shell host for the member-management surface.
     Mounted inside WorkspaceShell alongside every other workspace view, so it must
     stay gated on editorUiStore.workspaceView === "settings" (the shell shows exactly
     one view at a time). The actual UI lives in WorkspaceMembersPanel, which is shared
     with the standalone /settings/members page so both routes render one coherent
     members surface. -->
<script lang="ts">
	import WorkspaceMembersPanel from "$lib/components/WorkspaceMembersPanel.svelte";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
</script>

{#if editorUiStore.workspaceView === "settings"}
	<!-- Scroll-clamp: WorkspaceShell's canvas-area is `overflow: hidden` + viewport-clamped,
	     so the panel must scroll internally here (the bug fixed for the old inline version
	     in #232). The standalone /settings/members route is normal-flow and scrolls via the
	     page, so it needs no clamp. -->
	<div class="ws-surface members-shell-scroll">
		<div class="members-shell-frame">
			<WorkspaceMembersPanel />
		</div>
	</div>
{/if}

<style>
	/* Surface frame (position / scroll / background / typeface) comes from the shared
	   `.ws-surface` utility in app.css so the in-shell members surface matches every
	   other workspace surface. The shared WorkspaceMembersPanel keeps its own padding
	   (it is also used by the standalone /settings/members page), so here we only cap
	   it to the canonical content column to line up with Dashboard / Library width. */
	.members-shell-frame {
		width: 100%;
		max-width: var(--ws-surface-max, 1200px);
		margin-inline: auto;
	}
</style>
