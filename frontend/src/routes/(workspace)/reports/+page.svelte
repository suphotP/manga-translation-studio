<!-- /(workspace)/reports — workspace Reports surface inside WorkspaceShell.

	Like the other workspace routes, the visible UI is driven by WorkspaceShell
	(which renders WorkspaceReportsView when workspaceView === "reports"). The
	routeAware shell sets the view from the path on navigation; this onMount keeps
	a direct hard-load on /reports honest by opening the reports view immediately. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

	onMount(() => {
		editorUiStore.openReports();
	});
</script>

<svelte:head>
	<title>{$_("reportsPage.docTitle")}</title>
</svelte:head>
