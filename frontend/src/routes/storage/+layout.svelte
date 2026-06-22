<!-- /storage/* layout — workspace STORAGE LIBRARY (asset/storage management).
     A standalone surface OUTSIDE the (workspace) route group (that group mounts
     the canvas/editor shell, which this housekeeping view does not need). It is
     now wrapped in WorkspaceStandaloneShell so the persistent workspace sidebar
     (the premium chrome) stays present and highlights the Storage entry — the
     IA matches the dashboard/library instead of dropping to a chrome-less full
     -width page. The sidebar self-loads its own data; no editor is mounted. -->
<script lang="ts">
	import Toast from "$lib/components/Toast.svelte";
	import WorkspaceStandaloneShell from "$lib/components/WorkspaceStandaloneShell.svelte";
	let { children } = $props();
</script>

<WorkspaceStandaloneShell>
	<div class="storage-shell">
		{@render children()}
	</div>
</WorkspaceStandaloneShell>
<Toast />

<style>
	.storage-shell {
		min-height: 100%;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
	}
</style>
