<!-- Chip - small metadata pill (language, label, breadcrumb-ish tag). -->
<script lang="ts">
	let {
		label,
		icon = "",
		class: klass = "",
	}: {
		label: string;
		icon?: string;
		class?: string;
	} = $props();
</script>

<span class={`inline-flex items-center gap-1 rounded-full border border-ws-line/15 bg-white/5 px-2.5 py-1 text-[11px] font-extrabold text-ws-text ${klass}`}>
	{#if icon}<span aria-hidden="true">{icon}</span>{/if}
	{label}
</span>
