<script lang="ts">
	import NumberValue from "./NumberValue.svelte";

	let {
		items = [],
		class: klass = "",
	}: {
		items: { label: string; value: number; tone: string }[];
		class?: string;
	} = $props();

	function getToneClasses(tone: string): { text: string; dot: string } {
		const basicTones = ["violet", "cyan", "amber", "rose", "green", "faint"];
		if (basicTones.includes(tone)) {
			return {
				text: `text-ws-${tone}`,
				dot: `bg-ws-${tone}`,
			};
		}
		if (tone.startsWith("bg-")) {
			const base = tone.substring(3);
			return {
				text: base.startsWith("ws-") ? `text-${base}` : `text-${base}`,
				dot: tone,
			};
		}
		if (tone.startsWith("text-")) {
			const base = tone.substring(5);
			return {
				text: tone,
				dot: base.startsWith("ws-") ? `bg-${base}` : `bg-${base}`,
			};
		}
		if (tone === "white") {
			return {
				text: "text-white",
				dot: "bg-white",
			};
		}
		return {
			text: `text-ws-${tone}`,
			dot: `bg-ws-${tone}`,
		};
	}
</script>

<div class={`flex flex-wrap items-center gap-2.5 ${klass}`}>
	{#each items as item (item.label)}
		{@const classes = getToneClasses(item.tone)}
		<span class={`inline-flex items-center gap-1 text-[11px] font-medium ${classes.text}`} title={item.label}>
			<span class={`ws-dot ${classes.dot}`}></span>
			<NumberValue value={item.value} />
		</span>
	{/each}
</div>
