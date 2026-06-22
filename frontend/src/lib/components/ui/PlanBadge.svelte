<!-- PlanBadge - renders the workspace tier as a coloured pill.
     Used in the sidebar widgets, header, and member list to make the active
     plan instantly recognisable. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { PublicPlanKey } from "$lib/stores/billing.svelte.ts";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		plan,
		size = "sm",
		title,
		class: klass = "",
	}: {
		plan: PublicPlanKey | null | undefined;
		size?: "xs" | "sm" | "md";
		title?: string;
		class?: string;
	} = $props();

	const LABEL: Record<PublicPlanKey, string> = {
		free: "Free",
		creator: "Creator",
		pro: "Pro",
		studio: "Studio",
		studio_plus: "Studio+",
	};

	const TONE: Record<PublicPlanKey, string> = {
		free: "border-white/15 bg-white/[0.07] text-ws-text",
		creator: "border-ws-cyan/35 bg-ws-cyan/15 text-ws-cyan",
		pro: "border-ws-violet/40 bg-ws-violet/15 text-ws-violet",
		studio: "border-ws-amber/40 bg-ws-amber/15 text-ws-amber",
		studio_plus: "border-ws-rose/40 bg-ws-rose/15 text-ws-rose",
	};

	const SIZE: Record<"xs" | "sm" | "md", string> = {
		xs: "h-4 px-1.5 text-[9px] tracking-wider",
		sm: "h-5 px-2 text-[10px] tracking-wider",
		md: "h-6 px-2.5 text-[11px] tracking-wider",
	};

	let resolved = $derived<PublicPlanKey>(plan ?? "free");
	let planAriaLabel = $derived(t("planBadge.aria", "{plan} plan").replace("{plan}", LABEL[resolved]));
</script>

<span
	class={`inline-flex items-center gap-1 rounded-full border font-bold uppercase ${SIZE[size]} ${TONE[resolved]} ${klass}`}
	title={title}
	aria-label={planAriaLabel}
>
	{LABEL[resolved]}
</span>

<style>
	:global(.plan-badge-gradient) {
		background-image: linear-gradient(90deg, #FBBF24, #F472B6);
	}
</style>
