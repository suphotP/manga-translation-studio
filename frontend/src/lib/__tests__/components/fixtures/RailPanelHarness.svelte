<script lang="ts">
	import RailPanel from "$lib/components/ui/RailPanel.svelte";

	let {
		title,
		subtitle = "",
		class: klass = "",
		childText = "Panel content",
	}: {
		title: string;
		subtitle?: string;
		class?: string;
		childText?: string;
	} = $props();
</script>

<RailPanel {title} {subtitle} class={klass}>
	<p>{childText}</p>
</RailPanel>
