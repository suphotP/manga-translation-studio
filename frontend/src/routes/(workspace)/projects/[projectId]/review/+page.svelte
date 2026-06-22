<script lang="ts">
	import { _ } from "$lib/i18n";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const title = $derived(msg("review.pageTitle", "Read / review chapter - Manga Editor"));
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>
