<!--
	Never rendered in practice: `+page.ts` `load` redirects `/focus` → `/dashboard`
	(focus work needs a project context). This is only a safety net so a bare
	`/focus` hit shows a titled, valid page instead of a full-screen 404 if the
	redirect is ever skipped.
-->
<script lang="ts">
	import { _ } from "$lib/i18n";
</script>

<svelte:head>
	<title>{$_("focusPage.docTitle")}</title>
</svelte:head>
