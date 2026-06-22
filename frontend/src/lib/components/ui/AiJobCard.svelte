<!-- AiJobCard - one AI job (matches the dashboard / pages-view AI queue cards). Shows a
	tier pill, status, the job title + cost in CREDITS (via CreditAmount, not baht), an
	optional before/after thumbnail strip, and an actions slot for รับ/ปฏิเสธ etc. -->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { _ } from "$lib/i18n";
	import CreditAmount from "./CreditAmount.svelte";

	export type AiTier = "budget-clean" | "clean-pro" | "sfx-pro";
	export type AiJobStatus = "queued" | "processing" | "needs_review" | "failed" | "done";

	let {
		tier,
		status,
		title,
		creditUnits,
		subtitle = "",
		estimated = false,
		progress,
		beforeAfter = false,
		actions,
		class: klass = "",
	}: {
		tier: AiTier;
		status: AiJobStatus;
		title: string;
		/** User-facing AI credit cost of this op (from the backend cost estimate). */
		creditUnits: number;
		subtitle?: string;
		estimated?: boolean;
		progress?: number;
		beforeAfter?: boolean;
		actions?: Snippet;
		class?: string;
	} = $props();

	// Tier pill colors mirror the dashboard markup (clean-pro=cyan, sfx-pro=violet, budget=faint).
	const tierClass: Record<AiTier, string> = {
		"budget-clean": "text-ws-faint bg-white/5 border-ws-line/15",
		"clean-pro": "text-ws-cyan bg-ws-cyan/10 border-ws-cyan/20",
		"sfx-pro": "text-ws-violet bg-ws-violet/10 border-ws-violet/20",
	};
	// Per-status visual meta (color + dot). The label is resolved from i18n at
	// render time so it re-localizes; derived so it tracks the active locale.
	const statusMeta: Record<AiJobStatus, { labelKey: string; cls: string; dot: string }> = {
		queued: { labelKey: "aiJobCard.statusQueued", cls: "text-ws-faint", dot: "bg-ws-faint" },
		processing: { labelKey: "aiJobCard.statusProcessing", cls: "text-ws-violet", dot: "bg-ws-violet" },
		needs_review: { labelKey: "aiJobCard.statusNeedsReview", cls: "text-ws-amber", dot: "bg-ws-amber" },
		failed: { labelKey: "aiJobCard.statusFailed", cls: "text-ws-rose", dot: "bg-ws-rose" },
		done: { labelKey: "aiJobCard.statusDone", cls: "text-ws-green", dot: "bg-ws-green" },
	};

	let st = $derived(statusMeta[status]);
	let stLabel = $derived($_(st.labelKey));
	let pct = $derived(progress == null ? null : Math.max(0, Math.min(100, Math.round(progress))));
</script>

<div class={`ws-panel-quiet rounded-ws-card p-3 ${klass}`}>
	<div class="flex items-center gap-2.5">
		{#if beforeAfter}
			<div class="flex shrink-0 overflow-hidden rounded-[8px] border border-ws-line/10" style="width:54px;height:38px">
				<svg viewBox="0 0 54 38" class="h-full w-full" aria-hidden="true">
					<rect width="27" height="38" fill="#241433" /><text x="13.5" y="22" font-size="6" fill="#9A9AA8" text-anchor="middle">前</text>
					<rect x="27" width="27" height="38" fill="#13233a" /><path d="M27 0v38" stroke="rgba(255,255,255,0.12)" stroke-width="1" /><text x="40.5" y="22" font-size="6" fill="#34D399" text-anchor="middle">✓</text>
				</svg>
			</div>
		{/if}
		<div class="min-w-0 flex-1">
			<div class="mb-0.5 flex items-center gap-1.5">
				<span class={`rounded-full border px-1.5 py-px text-[10.5px] font-medium ${tierClass[tier]}`}>{tier}</span>
				<span class={`flex items-center gap-1 text-[11px] font-medium ${st.cls}`}><span class={`ws-dot ${st.dot}`}></span>{stLabel}</span>
			</div>
			<p class="truncate text-[12.5px] text-ws-ink">{title}</p>
			<p class="flex items-center gap-1 truncate text-[11px] tabular-nums text-ws-faint">
				{#if subtitle}<span class="truncate">{subtitle} ·</span>{/if}
				<CreditAmount credits={creditUnits} showLabel approx={estimated} compact={false} size="xs" tone="faint" />
			</p>
			{#if pct != null}
				<div class="ws-track mt-1.5 h-1"><div class="ws-fill" style={`width:${pct}%;background:var(--color-ws-violet)`}></div></div>
			{/if}
		</div>
		{#if actions}
			<div class="flex shrink-0 flex-col gap-1.5">{@render actions()}</div>
		{/if}
	</div>
</div>
