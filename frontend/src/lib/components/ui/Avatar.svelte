<!-- Avatar - single shared profile/avatar primitive used across all workspace pages. -->
<script lang="ts">
	export type AvatarSize = "xs" | "sm" | "md" | "lg";
	export type AvatarTone = "cyan" | "violet" | "green" | "amber" | "rose" | "blue" | "neutral";

	let {
		name = "",
		initial = "",
		src = "",
		size = "sm",
		tone = "cyan",
		ring = true,
		title = "",
		class: klass = "",
	}: {
		name?: string;
		initial?: string;
		src?: string;
		size?: AvatarSize;
		tone?: AvatarTone;
		ring?: boolean;
		title?: string;
		class?: string;
	} = $props();

	const sizeClass: Record<AvatarSize, string> = {
		xs: "w-5 h-5 text-[9px]",
		sm: "w-6 h-6 text-[10px]",
		md: "w-8 h-8 text-xs",
		lg: "w-10 h-10 text-sm",
	};
	const toneClass: Record<AvatarTone, string> = {
		cyan: "bg-ws-cyan text-ws-bg",
		violet: "bg-ws-violet text-ws-bg",
		green: "bg-ws-green text-ws-bg",
		amber: "bg-ws-amber text-ws-bg",
		rose: "bg-ws-rose text-ws-bg",
		blue: "bg-ws-blue text-ws-bg",
		neutral: "bg-ws-surface2 text-ws-ink",
	};

	let label = $derived((initial || name.trim().charAt(0) || "?").toUpperCase());
	let hasLabel = $derived(Boolean(title || name));
</script>

<span
	class={`inline-grid place-items-center shrink-0 rounded-full font-black leading-none ${sizeClass[size]} ${ring ? "ring-1 ring-black/40" : ""} ${src ? "overflow-hidden" : toneClass[tone] ?? toneClass.cyan} ${klass}`}
	title={hasLabel ? title || name : undefined}
	aria-hidden={hasLabel ? undefined : "true"}
>
	{#if src}
		<img {src} alt={name} class="w-full h-full object-cover" />
	{:else}
		{label}
	{/if}
</span>
