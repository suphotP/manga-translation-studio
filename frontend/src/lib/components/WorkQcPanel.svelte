<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import { resolveQcIssueMessage } from "$lib/project/qc-checks-i18n.js";

	interface Props {
		projectOpen: boolean;
		errorCount: number;
		warningCount: number;
		infoCount: number;
		issues: QcIssue[];
		selectedIssueId: string | null;
		severityLabel: (severity: QcIssue["severity"]) => string;
		onIssueSelect: (issueId: string) => void | Promise<void>;
	}

	type QcIssueFilter = "all" | QcIssue["severity"];

	let {
		projectOpen,
		errorCount,
		warningCount,
		infoCount,
		issues,
		selectedIssueId,
		severityLabel,
		onIssueSelect,
	}: Props = $props();

	const maxVisibleIssues = 6;
	let issueFilterOptions = $derived<{ id: QcIssueFilter; label: string }[]>([
		{ id: "all", label: $_("workQc.filterAll") },
		{ id: "error", label: $_("workQc.filterBlock") },
		{ id: "warning", label: $_("workQc.filterNeedsCheck") },
		{ id: "info", label: $_("workQc.filterInfo") },
	]);

	let issueFilter = $state<QcIssueFilter>("all");
	let filteredIssues = $derived(
		issueFilter === "all" ? issues : issues.filter((issue) => issue.severity === issueFilter)
	);
	let issueFilters = $derived(
		issueFilterOptions.map((filter) => ({
			...filter,
			count: filter.id === "all" ? issues.length : issues.filter((issue) => issue.severity === filter.id).length,
		}))
	);
	let selectedIssueIndex = $derived(filteredIssues.findIndex((issue) => issue.id === selectedIssueId));
	let activeIssueIndex = $derived(selectedIssueIndex >= 0 ? selectedIssueIndex : -1);
	let visibleIssues = $derived(getVisibleIssues());
	let displayedIssueIndex = $derived(activeIssueIndex >= 0 ? activeIssueIndex : filteredIssues.length > 0 ? 0 : -1);
	let focusedIssue = $derived(displayedIssueIndex >= 0 ? filteredIssues[displayedIssueIndex] ?? null : null);
	let issuePositionLabel = $derived(
		displayedIssueIndex >= 0 ? `${displayedIssueIndex + 1}/${filteredIssues.length}` : `0/${filteredIssues.length}`
	);
	let focusedIssueTarget = $derived(focusedIssue ? getIssueTargetLabel(focusedIssue) : "");

	function getVisibleIssues(): QcIssue[] {
		if (filteredIssues.length <= maxVisibleIssues) return filteredIssues;
		if (activeIssueIndex < 0) return filteredIssues.slice(0, maxVisibleIssues);
		const maxStart = Math.max(0, filteredIssues.length - maxVisibleIssues);
		const start = Math.min(Math.max(0, activeIssueIndex - 2), maxStart);
		return filteredIssues.slice(start, start + maxVisibleIssues);
	}

	function selectIssueByStep(direction: -1 | 1): void {
		if (filteredIssues.length === 0) return;
		const baseIndex = activeIssueIndex >= 0
			? activeIssueIndex
			: direction > 0
				? -1
				: filteredIssues.length;
		const nextIndex = (baseIndex + direction + filteredIssues.length) % filteredIssues.length;
		onIssueSelect(filteredIssues[nextIndex].id);
	}

	function getIssueTargetLabel(issue: QcIssue): string {
		if (issue.code === "duplicate_layer_id") return (issue.pageIndex !== undefined ? $_("workQc.targetPage", { values: { page: issue.pageIndex + 1 } }) : $_("workQc.targetPageEmpty")).trim();
		if (issue.code === "comment_page_missing" || issue.code === "comment_anchor_missing") return $_("workQc.targetNote");
		if (
			issue.code === "ai_marker_page_missing"
			|| issue.code === "ai_marker_image_stale"
			|| issue.code === "ai_marker_comment_link_missing"
			|| issue.code === "ai_marker_task_link_missing"
		) return $_("workQc.targetAiResult");
		if (issue.code === "workflow_task_page_missing" || issue.code === "workflow_task_layer_missing" || issue.code === "workflow_task_image_stale") return $_("workQc.targetProduction");
		if (issue.code === "review_decision_page_missing") return $_("workQc.targetReview");
		if (issue.layerId) return issue.layerKind === "image" ? $_("workQc.targetImageLayer") : $_("workQc.targetTextLayer");
		if (issue.pageIndex !== undefined) return $_("workQc.targetPage", { values: { page: issue.pageIndex + 1 } });
		return "Project";
	}

	function getIssueFixCopy(issue: QcIssue): string {
		if (issue.code === "duplicate_layer_id") {
			return $_("workQc.fixDuplicateLayerId");
		}
		if (issue.code === "comment_page_missing") {
			return $_("workQc.fixCommentPageMissing");
		}
		if (issue.code === "comment_anchor_missing") {
			return $_("workQc.fixCommentAnchorMissing");
		}
		if (issue.code === "ai_marker_page_missing") {
			return $_("workQc.fixAiMarkerPageMissing");
		}
		if (issue.code === "ai_marker_image_stale") {
			return $_("workQc.fixAiMarkerImageStale");
		}
		if (issue.code === "ai_marker_comment_link_missing") {
			return $_("workQc.fixAiMarkerCommentLinkMissing");
		}
		if (issue.code === "ai_marker_task_link_missing") {
			return $_("workQc.fixAiMarkerTaskLinkMissing");
		}
		if (issue.code === "workflow_task_page_missing") {
			return $_("workQc.fixWorkflowTaskPageMissing");
		}
		if (issue.code === "workflow_task_layer_missing") {
			return $_("workQc.fixWorkflowTaskLayerMissing");
		}
		if (issue.code === "workflow_task_image_stale") {
			return $_("workQc.fixWorkflowTaskImageStale");
		}
		if (issue.code === "review_decision_page_missing") {
			return $_("workQc.fixReviewDecisionPageMissing");
		}
		if (issue.code === "page_without_text") {
			return $_("workQc.fixPageWithoutText");
		}
		if (issue.layerKind === "text") {
			if (issue.code === "invalid_text_box" || issue.code === "text_overflow_risk") {
				return $_("workQc.fixTextBox");
			}
			return $_("workQc.fixTextCopy");
		}
		if (issue.layerKind === "image") {
			return $_("workQc.fixImageLayer");
		}
		return $_("workQc.fixDefault");
	}

	function getIssueActionLabel(issue: QcIssue): string {
		if (issue.code === "duplicate_layer_id") return $_("workQc.actionFixId");
		if (issue.code === "comment_page_missing" || issue.code === "comment_anchor_missing") return $_("workQc.actionOpenNote");
		if (
			issue.code === "ai_marker_page_missing"
			|| issue.code === "ai_marker_image_stale"
			|| issue.code === "ai_marker_comment_link_missing"
			|| issue.code === "ai_marker_task_link_missing"
		) return $_("workQc.actionOpenAiReview");
		if (issue.code === "workflow_task_page_missing" || issue.code === "workflow_task_layer_missing" || issue.code === "workflow_task_image_stale") return $_("workQc.actionOpenProduction");
		if (issue.code === "review_decision_page_missing") return $_("workQc.actionOpenReview");
		if (issue.code === "page_without_text") return $_("workQc.actionPlaceText");
		if (issue.layerKind === "text") {
			return issue.code === "invalid_text_box" || issue.code === "text_overflow_risk" ? $_("workQc.actionAdjustText") : $_("workQc.actionEditText");
		}
		if (issue.layerKind === "image") return $_("workQc.actionViewLayer");
		return $_("workQc.actionOpenFix");
	}

	function getIssueListKey(issue: QcIssue, index: number): string {
		return `${issue.id}-${index}`;
	}
</script>

	<div class="qc-panel">
		<div class="qc-summary">
			<span class="qc-pill error">{$_("workQc.countBlock", { values: { count: errorCount } })}</span>
			<span class="qc-pill warning">{$_("workQc.countNeedsCheck", { values: { count: warningCount } })}</span>
			<span class="qc-pill info">{$_("workQc.countInfo", { values: { count: infoCount } })}</span>
		</div>

	{#if !projectOpen}
		<div class="empty-state">
			<strong>{$_("workQc.openWorkFirst")}</strong>
			<span>{$_("workQc.openWorkToRun")}</span>
		</div>
		{:else if issues.length === 0}
			<div class="empty-state">
				<strong>{$_("workQc.pagePassed")}</strong>
				<span>{$_("workQc.noIssuesOnPage")}</span>
			</div>
		{:else}
			{#if focusedIssue}
				<section class={`qc-focus-card ${focusedIssue.severity}`} aria-label={$_("workQc.focusCardAria")}>
					<div class="qc-focus-copy">
						<span>{severityLabel(focusedIssue.severity)}</span>
						<strong>{resolveQcIssueMessage(focusedIssue, $_)}</strong>
					<small>{focusedIssueTarget} / {issuePositionLabel}</small>
					<p>{getIssueFixCopy(focusedIssue)}</p>
					</div>
					<button
						type="button"
						onclick={() => onIssueSelect(focusedIssue.id)}
						aria-label={$_("workQc.issueActionAria", { values: { action: getIssueActionLabel(focusedIssue), message: resolveQcIssueMessage(focusedIssue, $_) } })}
					>
						{getIssueActionLabel(focusedIssue)}
					</button>
				</section>
			{/if}
			<div class="qc-filter-row" role="group" aria-label={$_("workQc.filterGroupAria")}>
				{#each issueFilters as filter (filter.id)}
					<button
						type="button"
						class="qc-filter-btn"
						class:active={issueFilter === filter.id}
						onclick={() => issueFilter = filter.id}
						aria-pressed={issueFilter === filter.id}
						aria-label={$_("workQc.filterShowAria", { values: { label: filter.label } })}
					>
						<span>{filter.label}</span>
						<small>{filter.count}</small>
					</button>
				{/each}
			</div>
			<div class="qc-nav" aria-label={$_("workQc.navAria")}>
				<button
					type="button"
					class="qc-nav-btn"
					onclick={() => selectIssueByStep(-1)}
					aria-label={$_("workQc.navPrev")}
					title={$_("workQc.navPrev")}
				>&lt;</button>
				<span class="qc-nav-position">{issuePositionLabel}</span>
				<button
					type="button"
					class="qc-nav-btn"
					onclick={() => selectIssueByStep(1)}
					aria-label={$_("workQc.navNext")}
					title={$_("workQc.navNext")}
				>&gt;</button>
			</div>
			{#if filteredIssues.length === 0}
				<div class="empty-state">{$_("workQc.noIssuesInFilter")}</div>
			{:else}
				<div class="qc-list">
					{#each visibleIssues as issue, index (getIssueListKey(issue, index))}
						<button
							type="button"
							class={`qc-row ${issue.severity}`}
							class:selected={selectedIssueId === issue.id}
							onclick={() => onIssueSelect(issue.id)}
							aria-label={$_("workQc.openIssueAria", { values: { message: resolveQcIssueMessage(issue, $_) } })}
						>
							<span>{severityLabel(issue.severity)}</span>
							<small>{resolveQcIssueMessage(issue, $_)}</small>
						</button>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.qc-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: var(--color-ws-ink);
	}

	.qc-summary {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
	}

	.qc-pill {
		overflow: hidden;
		padding: 4px 5px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 780;
		text-align: center;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.qc-pill.error,
	.qc-row.error span {
		color: var(--color-ws-rose);
	}

	.qc-pill.warning,
	.qc-row.warning span {
		color: var(--color-ws-amber);
	}

	.qc-pill.info,
	.qc-row.info span {
		color: var(--color-ws-blue);
	}

	.qc-focus-card {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 58px;
		align-items: center;
		gap: 8px;
		padding: 9px 9px 9px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.qc-focus-card::before {
		position: absolute;
		inset: 10px auto 10px 0;
		width: 3px;
		border-radius: 999px;
		background: var(--color-ws-accent);
		content: "";
	}

	.qc-focus-card.error::before {
		background: var(--color-ws-rose);
	}

	.qc-focus-card.warning::before {
		background: var(--color-ws-amber);
	}

	.qc-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.qc-focus-copy span {
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 850;
		text-transform: uppercase;
	}

	.qc-focus-card.error .qc-focus-copy span {
		color: var(--color-ws-rose);
	}

	.qc-focus-card.warning .qc-focus-copy span {
		color: var(--color-ws-amber);
	}

	.qc-focus-copy strong,
	.qc-focus-copy small,
	.qc-focus-copy p {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.qc-focus-copy strong {
		display: -webkit-box;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 820;
		line-height: 1.25;
		white-space: normal;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.qc-focus-copy small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		white-space: nowrap;
	}

	.qc-focus-copy p {
		display: -webkit-box;
		margin: 0;
		color: var(--color-ws-faint);
		font-size: 10px;
		font-weight: 720;
		line-height: 1.25;
		white-space: normal;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.qc-focus-card button {
		min-height: 40px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-violet)));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 800;
	}

	.qc-focus-card button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
		filter: brightness(1.07);
	}

	.qc-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.qc-filter-row {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
	}

	.qc-filter-btn {
		display: inline-flex;
		min-width: 0;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 0 4px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 9px;
		font-weight: 800;
		line-height: 1;
	}

	.qc-filter-btn:hover,
	.qc-filter-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}

	.qc-filter-btn span,
	.qc-filter-btn small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.qc-filter-btn small {
		color: inherit;
		opacity: 0.72;
	}

	.qc-nav {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) 40px;
		align-items: center;
		gap: 6px;
	}

	.qc-nav-btn {
		width: 40px;
		height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 11px;
		font-weight: 900;
		line-height: 1;
	}

	.qc-nav-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface2));
	}

	.qc-nav-position {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 800;
		text-align: center;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.qc-row {
		position: relative;
		display: grid;
		grid-template-columns: 64px minmax(0, 1fr);
		gap: 8px;
		min-height: 40px;
		padding: 9px 9px 9px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.qc-row::before {
		position: absolute;
		inset: 10px auto 10px 0;
		width: 3px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
		content: "";
	}

	.qc-row.error::before {
		background: var(--color-ws-rose);
	}

	.qc-row.warning::before {
		background: var(--color-ws-amber);
	}

	.qc-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface2));
	}

	.qc-row.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, var(--color-ws-surface));
	}

	.qc-row span {
		align-self: start;
		padding: 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		text-transform: uppercase;
	}

	.qc-row small {
		color: var(--color-ws-text);
		display: -webkit-box;
		overflow: hidden;
		font-size: 11px;
		line-height: 1.35;
		text-overflow: ellipsis;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.empty-state strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.qc-focus-card button,
		.qc-filter-btn,
		.qc-nav-btn,
		.qc-row {
			min-height: 40px;
		}

		.qc-nav {
			grid-template-columns: 40px minmax(0, 1fr) 40px;
		}
	}
</style>
