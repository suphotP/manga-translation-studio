<!-- /(workspace)/inbox - workspace-level attention inbox inside WorkspaceShell.

	Like /tasks, WorkspaceShell owns the visible UI. Direct hard-loads still need
	to select the inbox view immediately so the route and rendered surface agree. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

	onMount(() => {
		editorUiStore.openInbox();
	});
</script>

<svelte:head>
	<title>{$_("inboxPage.docTitle")}</title>
</svelte:head>
