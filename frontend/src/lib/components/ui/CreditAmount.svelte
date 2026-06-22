<!-- CreditAmount - the canonical user-facing "AI credit" display atom: a small coin/credit
	glyph + the credit number (compacted, with full value on hover via NumberValue) + an
	optional i18n'd "credits / เครดิต" label. Use this EVERYWHERE a normal user sees an AI op
	cost or their AI credit balance — never baht (฿ stays only in real-money billing/usage
	contexts). The credit count comes from the backend (`creditUnits` for op cost, or the
	thbToCredits() conversion for aggregate balances) — this atom only renders, never derives. -->
<script lang="ts">
	import { _ } from "svelte-i18n";
	import NumberValue from "./NumberValue.svelte";

	let {
		credits,
		showLabel = false,
		approx = false,
		compact = true,
		size = "sm",
		tone = "cyan",
		class: klass = "",
	}: {
		/** Credit count to show (already in credit units, not baht). */
		credits: number;
		/** Append the i18n'd "credits / เครดิต" word after the number. */
		showLabel?: boolean;
		/** Prefix with "~" / "ประมาณ" to mark an estimate (op cost preview). */
		approx?: boolean;
		/** Compact large numbers (1240 → 1.24K). Off for small exact op costs. */
		compact?: boolean;
		size?: "xs" | "sm" | "md";
		tone?: "cyan" | "amber" | "ink" | "faint";
		class?: string;
	} = $props();

	const sizeClass: Record<"xs" | "sm" | "md", string> = {
		xs: "text-[10.5px] gap-0.5",
		sm: "text-[12px] gap-1",
		md: "text-[13px] gap-1.5",
	};
	const iconPx: Record<"xs" | "sm" | "md", number> = { xs: 11, sm: 12, md: 14 };
	const toneClass: Record<"cyan" | "amber" | "ink" | "faint", string> = {
		cyan: "text-ws-cyan",
		amber: "text-ws-amber",
		ink: "text-ws-ink",
		faint: "text-ws-faint",
	};

	let px = $derived(iconPx[size]);
	let label = $derived(showLabel ? $_("credits.unit") : "");
</script>

<span class={`inline-flex items-baseline tabular-nums ${sizeClass[size]} ${toneClass[tone]} ${klass}`}>
	<!-- coin/credit glyph: a small ringed coin with a center spark -->
	<svg
		width={px}
		height={px}
		viewBox="0 0 24 24"
		fill="none"
		aria-hidden="true"
		class="-mb-px shrink-0 self-center"
	>
		<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="currentColor" fill-opacity="0.12" />
		<path d="M12 7.2l1.25 3.2 3.2 1.25-3.2 1.25L12 16.1l-1.25-3.2L7.55 11.65l3.2-1.25z" fill="currentColor" />
	</svg>
	{#if approx}<span class="not-italic">~</span>{/if}
	<NumberValue value={credits} {compact} digits={2} class={toneClass[tone]} />
	{#if label}<span class="font-normal text-ws-faint">&nbsp;{label}</span>{/if}
</span>
