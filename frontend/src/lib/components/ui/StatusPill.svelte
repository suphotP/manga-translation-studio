<!-- StatusPill - workflow status indicator with a shared tone scale. -->
<script lang="ts">
	export type StatusTone = "urgent" | "review" | "active" | "late" | "done" | "todo" | "neutral";

	let {
		label,
		tone = "neutral",
		class: klass = "",
	}: {
		label: string;
		tone?: StatusTone;
		class?: string;
	} = $props();

	const toneClass: Record<StatusTone, string> = {
		urgent: "bg-ws-rose/15 text-ws-rose",
		review: "bg-ws-violet/15 text-ws-violet",
		active: "bg-ws-accent/15 text-ws-accent",
		late: "bg-ws-rose/15 text-ws-rose",
		done: "bg-ws-green/15 text-ws-green",
		todo: "bg-white/10 text-ws-text/70",
		neutral: "bg-white/10 text-ws-text/70",
	};
</script>

<span class={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${toneClass[tone]} ${klass}`}>
	{label}
</span>
