<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { CreditPolicy, PageQcHandoff, PageQcHandoffStatus } from "$lib/types.js";

	type ReviewCommandTone = "hot" | "warn" | "ready" | "idle";

	interface QcPrimaryCommandView {
		id: string;
		label: string;
		count: number;
		detail: string;
		tone: ReviewCommandTone;
		item: unknown | null;
	}

	interface Props {
		currentPageLabel: string;
		currentPageQcHandoff: PageQcHandoff | null;
		currentPageNeedsCleanRecheck: boolean;
		currentPageNeedsReviewApprovalBeforeFinalQc: boolean;
		finalQcCanCloseCurrentPage: boolean;
		finalQcStatusLabel: string;
		finalQcStatusDetail: string;
		finalQcReviewApprovalDetail: string;
		qcPrimaryCommand: QcPrimaryCommandView | null;
		qcPrimaryTitle: string;
		qcPrimaryDetail: string;
		qcPrimaryActionLabel: string;
		qcPrimaryCommandCanvasActionLabel: string;
		openCurrentPageActionLabel: string;
		creditPolicy: CreditPolicy;
		creditSummaryLabel: string;
		creditPolicyDetail: string;
		cleanHandoffStatusLabel: string;
		translatedScriptCount: number;
		translatorScriptSlotCount: number;
		qcTypesetTruthWarn: boolean;
		qcTypesetTruthLabel: string;
		currentPageOpenCommentCount: number;
		currentPageAiQcCount: number;
		reviewDecisionStatusLabel: string;
		exportPolicyControlLabel: (policy: CreditPolicy) => string;
		onMarkCurrentPageCleanRecheck: (status: "verified" | "needs_adjustment") => void;
		onOpenCurrentPageReviewInFocus: () => void;
		onOpenCanvas: () => void;
		onFocusQcPrimaryCommand: () => void;
		onOpenQcPrimaryCommandInEditor: () => void;
		onUpdateCurrentPageQcHandoff: (status: PageQcHandoffStatus) => void;
		onOpenCreditWorkflow: () => void;
		onOpenPages: () => void;
		onUpdateCreditPolicy: (policy: CreditPolicy) => void;
	}

	let {
		currentPageLabel,
		currentPageQcHandoff,
		currentPageNeedsCleanRecheck,
		currentPageNeedsReviewApprovalBeforeFinalQc,
		finalQcCanCloseCurrentPage,
		finalQcStatusLabel,
		finalQcStatusDetail,
		finalQcReviewApprovalDetail,
		qcPrimaryCommand,
		qcPrimaryTitle,
		qcPrimaryDetail,
		qcPrimaryActionLabel,
		qcPrimaryCommandCanvasActionLabel,
		openCurrentPageActionLabel,
		creditPolicy,
		creditSummaryLabel,
		creditPolicyDetail,
		cleanHandoffStatusLabel,
		translatedScriptCount,
		translatorScriptSlotCount,
		qcTypesetTruthWarn,
		qcTypesetTruthLabel,
		currentPageOpenCommentCount,
		currentPageAiQcCount,
		reviewDecisionStatusLabel,
		exportPolicyControlLabel,
		onMarkCurrentPageCleanRecheck,
		onOpenCurrentPageReviewInFocus,
		onOpenCanvas,
		onFocusQcPrimaryCommand,
		onOpenQcPrimaryCommandInEditor,
		onUpdateCurrentPageQcHandoff,
		onOpenCreditWorkflow,
		onOpenPages,
		onUpdateCreditPolicy,
	}: Props = $props();
</script>

<section class="qc-credit-bench ws-panel" aria-label={$_("qcCreditBench.regionLabel")}>
	<div class="qc-credit-head">
		<span>{$_("qcCreditBench.eyebrow")}</span>
		<strong>
			{currentPageLabel} · {qcPrimaryCommand?.item
				? $_("qcCreditBench.headHasDecision")
				: finalQcCanCloseCurrentPage
					? finalQcStatusLabel
					: $_("qcCreditBench.headNotReady")}
		</strong>
		<small>{$_("qcCreditBench.subhead")}</small>
	</div>
	<article class={`qc-decision-card ws-panel-quiet ${qcPrimaryCommand?.tone ?? ((currentPageNeedsCleanRecheck || (finalQcCanCloseCurrentPage && currentPageQcHandoff?.status !== "ready")) ? "warn" : "idle")}`} aria-label={$_("qcCreditBench.decisionAria")}>
		<div>
			<span>{$_("qcCreditBench.decisionTitle")}</span>
			{#if currentPageNeedsCleanRecheck && !qcPrimaryCommand?.item}
				<strong>{$_("qcCreditBench.cleanRecheckTitle")}</strong>
				<small>{$_("qcCreditBench.cleanRecheckDetail")}</small>
			{:else if currentPageNeedsReviewApprovalBeforeFinalQc && !qcPrimaryCommand?.item}
				<strong>{$_("qcCreditBench.reviewWaitTitle")}</strong>
				<small>{finalQcReviewApprovalDetail}</small>
			{:else}
				<strong>{finalQcCanCloseCurrentPage ? finalQcStatusLabel : qcPrimaryTitle}</strong>
				<small>{finalQcCanCloseCurrentPage ? finalQcStatusDetail : qcPrimaryDetail}</small>
			{/if}
		</div>
		<div class="qc-decision-actions">
			{#if currentPageNeedsCleanRecheck && !qcPrimaryCommand?.item}
				<button type="button" class="primary ws-grad-primary" onclick={() => onMarkCurrentPageCleanRecheck("verified")}>
					{$_("qcCreditBench.confirmCleanDone")}
				</button>
				<button type="button" class="ws-btn-ghost" onclick={() => onMarkCurrentPageCleanRecheck("needs_adjustment")}>
					{$_("qcCreditBench.needsAdjustment")}
				</button>
			{:else if currentPageNeedsReviewApprovalBeforeFinalQc && !qcPrimaryCommand?.item}
				<button type="button" class="primary ws-grad-primary" onclick={onOpenCurrentPageReviewInFocus}>
					{$_("qcCreditBench.reviewThis")}
				</button>
				<button type="button" class="ws-btn-ghost" onclick={onOpenCanvas}>
					{openCurrentPageActionLabel}
				</button>
			{:else if qcPrimaryCommand?.item}
				<button type="button" class="primary ws-grad-primary" onclick={onFocusQcPrimaryCommand}>
					{qcPrimaryActionLabel}
				</button>
				<button type="button" class="ws-btn-ghost" onclick={onOpenQcPrimaryCommandInEditor}>
					{qcPrimaryCommandCanvasActionLabel}
				</button>
			{:else if finalQcCanCloseCurrentPage}
				{#if currentPageQcHandoff?.status === "ready"}
					<button type="button" class="ws-btn-ghost" onclick={() => onUpdateCurrentPageQcHandoff("needs_fix")}>
						{$_("qcCreditBench.reopenReview")}
					</button>
				{:else}
					<button type="button" class="primary ws-grad-primary" onclick={() => onUpdateCurrentPageQcHandoff("ready")}>
						{$_("qcCreditBench.closeQcPage")}
					</button>
					<button type="button" class="ws-btn-ghost" onclick={onOpenCreditWorkflow}>
						{$_("qcCreditBench.checkCredit")}
					</button>
				{/if}
			{:else}
				<button type="button" class="ws-btn-ghost" onclick={onOpenPages}>
					{$_("qcCreditBench.viewAllChapterPages")}
				</button>
			{/if}
		</div>
	</article>
	<article class="qc-credit-summary ws-panel-quiet" aria-label={$_("qcCreditBench.creditReadinessAria")}>
		<div>
			<span>{$_("qcCreditBench.credit")}</span>
			<strong>{creditSummaryLabel}</strong>
			<small>{creditPolicyDetail}</small>
		</div>
			<div class="credit-policy-controls" aria-label={$_("qcCreditBench.creditPolicyAria")}>
				<button
					type="button"
					class="ws-btn-ghost"
					class:active={creditPolicy === "optional"}
					aria-pressed={creditPolicy === "optional"}
					onclick={() => onUpdateCreditPolicy("optional")}
				>
					{exportPolicyControlLabel("optional")}
				</button>
				<button
					type="button"
					class="ws-btn-ghost"
					class:active={creditPolicy === "required"}
					aria-pressed={creditPolicy === "required"}
					onclick={() => onUpdateCreditPolicy("required")}
				>
					{exportPolicyControlLabel("required")}
				</button>
			</div>
		<button type="button" class="primary ws-grad-primary" onclick={onOpenCreditWorkflow}>
			{$_("qcCreditBench.openCreditTool")}
		</button>
	</article>
	<div class="qc-truth-grid" aria-label={$_("qcCreditBench.truthGridAria")}>
		<div>
			<span>{$_("qcCreditBench.clean")}</span>
			<strong>{cleanHandoffStatusLabel}</strong>
		</div>
		<div>
			<span>{$_("qcCreditBench.script")}</span>
			<strong>{$_("qcCreditBench.scriptSlots", { values: { translated: translatedScriptCount, total: translatorScriptSlotCount } })}</strong>
		</div>
		<div class:warn={qcTypesetTruthWarn}>
			<span>{$_("qcCreditBench.typeset")}</span>
			<strong>{qcTypesetTruthLabel}</strong>
		</div>
		<div class:warn={currentPageOpenCommentCount > 0}>
			<span>{$_("qcCreditBench.notes")}</span>
			<strong>{$_("qcCreditBench.notesOpen", { values: { n: currentPageOpenCommentCount } })}</strong>
		</div>
		<div class:warn={currentPageAiQcCount > 0}>
			<span>{$_("qcCreditBench.aiQc")}</span>
			<strong>{$_("qcCreditBench.aiQcCount", { values: { n: currentPageAiQcCount } })}</strong>
		</div>
		<div>
			<span>{$_("qcCreditBench.reviewResult")}</span>
			<strong>{reviewDecisionStatusLabel}</strong>
		</div>
		<div class:warn={currentPageQcHandoff?.status !== "ready"}>
			<span>{$_("qcCreditBench.closeQc")}</span>
			<strong>{finalQcStatusLabel}</strong>
		</div>
	</div>
</section>

<style>
	.qc-credit-bench {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.qc-credit-head span,
	.qc-decision-card span,
	.qc-credit-summary span,
	.qc-truth-grid span {
		color: var(--color-ws-violet);
	}

	.qc-credit-head strong,
	.qc-decision-card strong,
	.qc-credit-summary strong,
	.qc-truth-grid strong {
		color: var(--color-ws-ink);
	}

	.qc-credit-head small,
	.qc-decision-card small,
	.qc-credit-summary small {
		color: var(--color-ws-text);
	}

	.qc-decision-card,
	.qc-credit-summary,
	.qc-truth-grid > div {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.qc-decision-card.hot {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface) 88%);
	}

	.qc-decision-card.warn,
	.qc-truth-grid > div.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface) 90%);
	}

	.qc-decision-card.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.qc-decision-actions button,
	.qc-credit-summary > button,
	.credit-policy-controls button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.qc-decision-actions button.primary,
	.qc-credit-summary > button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}

	.credit-policy-controls button.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 14%, transparent);
		color: var(--color-ws-green);
	}
</style>
