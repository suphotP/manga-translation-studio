<!-- /(workspace)/tasks - workspace-level "My tasks" surface inside WorkspaceShell.

	Like the other workspace routes, visible UI is driven by WorkspaceShell. The
	route-aware shell syncs client navigation from the path; this onMount keeps a
	direct hard-load on /tasks honest by selecting the tasks view immediately. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

	onMount(() => {
		editorUiStore.openTasks();
	});
</script>

<svelte:head>
	<title>{$_("tasksPage.docTitle")}</title>
</svelte:head>
