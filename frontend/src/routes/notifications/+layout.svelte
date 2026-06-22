<!-- /notifications layout — workspace notifications inbox chrome.
     A standalone surface OUTSIDE the (workspace) route group (that group mounts
     the canvas/editor shell, which this focused inbox does not need). It is now
     wrapped in WorkspaceStandaloneShell so the persistent workspace sidebar (the
     premium chrome) stays present — the IA matches the dashboard/library instead
     of dropping to a chrome-less full-width page. The sidebar self-loads its own
     data; no editor is mounted, and the page keeps its own in-page auth handling
     (sign-in CTA) so the auth flow is left untouched. -->
<script lang="ts">
	import Toast from "$lib/components/Toast.svelte";
	import WorkspaceStandaloneShell from "$lib/components/WorkspaceStandaloneShell.svelte";
	let { children } = $props();
</script>

<WorkspaceStandaloneShell>
	<div class="notifications-shell">
		{@render children()}
	</div>
</WorkspaceStandaloneShell>
<Toast />

<style>
	.notifications-shell {
		min-height: 100%;
		background: var(--color-ws-bg, #0b0b0f);
		color: var(--color-ws-ink, #ececf2);
	}
</style>
