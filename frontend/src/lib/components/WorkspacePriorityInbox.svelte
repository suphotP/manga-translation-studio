<script lang="ts">
	import { _ } from "$lib/i18n";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import { workInboxDetail, workInboxQcLabel } from "$lib/project/work-inbox-copy.js";
	import type { WorkspaceInboxSummary } from "$lib/project/workspace-dashboard.js";

	interface Props {
		projectOpen: boolean;
		items: readonly WorkInboxItem[];
		summary: WorkspaceInboxSummary;
		showAssignee?: boolean;
		soloAssigneeLabel?: string;
		onFocusItem: (item: WorkInboxItem) => void | Promise<void>;
		onOpenItemInEditor: (item: WorkInboxItem) => void | Promise<void>;
	}

	let {
		projectOpen,
		items,
		summary,
		showAssignee = true,
		soloAssigneeLabel: soloAssigneeLabelProp,
		onFocusItem,
		onOpenItemInEditor,
	}: Props = $props();

	// Reactive fallback: localize the solo-assignee label when the parent omits it,
	// so a live locale switch updates the default too (no frozen-const $_()).
	let soloAssigneeLabel = $derived(soloAssigneeLabelProp ?? $_("priorityInbox.soloMode"));

	let primaryItem = $derived(items[0] ?? null);
	let secondaryItems = $derived(items.slice(1));

	function inboxTone(item: WorkInboxItem): string {
		if (item.severity === "error" || item.overdue || item.priority === "urgent") return "hot";
		if (item.severity === "warning" || item.priority === "high") return "warn";
		return "info";
	}

	function inboxKindLabel(item: WorkInboxItem): string {
		if (item.kind === "ai_marker") return $_("priorityInbox.kind.ai");
		if (item.kind === "review_task") return $_("priorityInbox.kind.review");
		if (item.kind === "workflow_task") return $_("priorityInbox.kind.task");
		if (item.kind === "comment") return $_("priorityInbox.kind.note");
		return $_("priorityInbox.kind.qc");
	}

	function priorityLabel(value: string): string {
		if (value === "urgent" || value === "high" || value === "low" || value === "normal") {
			return $_(`priorityInbox.priority.${value}`);
		}
		return value;
	}

	function itemPageLabel(item: WorkInboxItem): string {
		return item.pageIndex === undefined
			? $_("priorityInbox.wholeChapter")
			: $_("priorityInbox.pageN", { values: { n: item.pageIndex + 1 } });
	}

	// CODE-BASED title routing (no Thai string-matching). Inbox items now carry a
	// stable `titleCode` + `workflowTitle.code`; we branch on those discriminants
	// and localize via $_(). Custom workflow titles fall back to the raw free text.
	function inboxTitleLabel(item: WorkInboxItem): string {
		const page = itemPageLabel(item);
		if (item.kind === "comment") return $_("priorityInbox.title.note", { values: { page } });
		if (item.kind === "ai_marker" && item.titleCode === "ai_rerun") return $_("priorityInbox.title.aiRerun", { values: { page } });
		if (item.kind === "ai_marker") return $_("priorityInbox.title.ai", { values: { page } });
		const workflowCode = item.kind === "review_task" ? "review" : item.workflowTitle?.code;
		if (workflowCode === "translate") return $_("priorityInbox.title.translate", { values: { page } });
		if (workflowCode === "clean") return $_("priorityInbox.title.clean", { values: { page } });
		if (workflowCode === "typeset") return $_("priorityInbox.title.typeset", { values: { page } });
		if (workflowCode === "review") return $_("priorityInbox.title.review", { values: { page } });
		if (workflowCode === "review_imported") return $_("priorityInbox.title.reviewImported", { values: { page } });
		// QC issues + custom workflow titles: a localized QC label (by code, with a
		// generic fallback for unmapped codes) or the raw custom title, suffixed with
		// the page label when page-scoped.
		const inlineTitle = item.kind === "qc"
			? workInboxQcLabel(item.qcCode, $_)
			: item.workflowTitle?.customTitle ?? "";
		return item.pageIndex === undefined ? inlineTitle : `${inlineTitle} ${page}`;
	}

	function inboxDetailLabel(item: WorkInboxItem, includeAssignee: boolean): string {
		return workInboxDetail(item.detail, $_, { includeAssignee });
	}

	function inboxMetaLabel(item: WorkInboxItem, includeAssignee: boolean): string {
		const parts = [inboxKindLabel(item)];
		if (item.pageIndex !== undefined) parts.push($_("priorityInbox.pageN", { values: { n: item.pageIndex + 1 } }));
		if (item.overdue) parts.push($_("priorityInbox.overdue"));
		else if (item.priority && item.priority !== "normal") parts.push(priorityLabel(item.priority));
		if (includeAssignee && item.assignee) parts.push(inboxAssigneeLabel(item.assignee));
		return parts.join(" / ");
	}

	function inboxOpenAction(item: WorkInboxItem): string {
		const whole = item.pageIndex === undefined;
		const n = whole ? 0 : item.pageIndex! + 1;
		if (item.kind === "comment") return whole ? $_("priorityInbox.open.noteWhole") : $_("priorityInbox.open.notePage", { values: { n } });
		if (item.kind === "review_task") return whole ? $_("priorityInbox.open.reviewWhole") : $_("priorityInbox.open.reviewPage", { values: { n } });
		if (item.kind === "ai_marker") return whole ? $_("priorityInbox.open.aiWhole") : $_("priorityInbox.open.aiPage", { values: { n } });
		if (item.kind === "qc") return whole ? $_("priorityInbox.open.qcWhole") : $_("priorityInbox.open.qcPage", { values: { n } });
		if (item.overdue || item.priority === "urgent") return whole ? $_("priorityInbox.open.fixWhole") : $_("priorityInbox.open.fixPage", { values: { n } });
		return whole ? $_("priorityInbox.open.openWhole") : $_("priorityInbox.open.openPage", { values: { n } });
	}

	function inboxAssigneeLabel(value: string): string {
		const normalized = value.trim().replace(/^@/, "");
		const lower = normalized.toLowerCase();
		if (lower === "local-user") return $_("priorityInbox.you");
		if (lower === "solo") return soloAssigneeLabel;
		if (lower === "qa" || lower === "qc") return lower.toUpperCase();
		return formatAssigneeHandle(normalized);
	}
</script>

<section class="workspace-attention" aria-label={$_("priorityInbox.queueAria")}>
	<div class="section-head">
		<div>
			<span class="eyebrow">{$_("priorityInbox.eyebrow")}</span>
			<h2>{$_("priorityInbox.heading")}</h2>
		</div>
		{#if projectOpen && items.length > 0}
			<button type="button" onclick={() => items[0] && onFocusItem(items[0])}>
				{$_("priorityInbox.workNow")}
			</button>
		{:else}
			<span class="action-receipt">{projectOpen ? $_("priorityInbox.noUrgent") : $_("priorityInbox.notOpenYet")}</span>
		{/if}
	</div>
	{#if !projectOpen}
		<div class="empty-panel">{$_("priorityInbox.openWorkspaceHint")}</div>
	{:else if items.length === 0}
		<div class="empty-panel">{$_("priorityInbox.noUrgentNow")}</div>
	{:else}
		<div class="attention-summary" aria-label={$_("priorityInbox.summaryAria")}>
			<span>{$_("priorityInbox.summaryBlock", { values: { n: summary.blockerCount } })}</span>
			<span>{$_("priorityInbox.summaryUrgent", { values: { n: summary.urgentCount } })}</span>
			<span>{$_("priorityInbox.summaryOverdue", { values: { n: summary.overdueCount } })}</span>
			<span>{$_("priorityInbox.summaryNote", { values: { n: summary.commentCount } })}</span>
			<span>{$_("priorityInbox.summaryQc", { values: { n: summary.qcCount } })}</span>
			<span>{$_("priorityInbox.summaryAi", { values: { n: summary.aiCount } })}</span>
		</div>
		{#if primaryItem}
			<div class="attention-list primary">
				<div class={`attention-row ${inboxTone(primaryItem)}`}>
					<button type="button" class="attention-main" onclick={() => onFocusItem(primaryItem)}>
						<span>{inboxMetaLabel(primaryItem, showAssignee)}</span>
						<strong>{inboxTitleLabel(primaryItem)}</strong>
						<small>{inboxDetailLabel(primaryItem, showAssignee)}</small>
					</button>
					<button type="button" class="attention-open" onclick={() => onOpenItemInEditor(primaryItem)}>
						{inboxOpenAction(primaryItem)}
					</button>
				</div>
			</div>
			{#if secondaryItems.length}
				<details class="attention-more">
					<summary>
						<span>{$_("priorityInbox.moreUrgent")}</span>
						<strong>{$_("priorityInbox.moreCount", { values: { n: secondaryItems.length } })}</strong>
					</summary>
					<div class="attention-list">
						{#each secondaryItems as item (item.id)}
							<div class={`attention-row ${inboxTone(item)}`}>
								<button type="button" class="attention-main" onclick={() => onFocusItem(item)}>
									<span>{inboxMetaLabel(item, showAssignee)}</span>
									<strong>{inboxTitleLabel(item)}</strong>
									<small>{inboxDetailLabel(item, showAssignee)}</small>
								</button>
								<button type="button" class="attention-open" onclick={() => onOpenItemInEditor(item)}>
									{inboxOpenAction(item)}
								</button>
							</div>
						{/each}
					</div>
				</details>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.workspace-attention {
		container-type: inline-size;
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 12px;
		padding: 15px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 10px;
		background: rgba(34, 37, 42, 0.86);
		box-shadow: 0 16px 34px rgba(0, 0, 0, 0.18);
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.eyebrow {
		color: #8fb8ff;
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
	}

	h2 {
		margin: 0;
		color: #e5edf8;
		font-size: 16px;
		font-weight: 850;
		line-height: 1.15;
		letter-spacing: 0;
	}

	button {
		font-family: inherit;
	}

	.section-head button {
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.055);
		color: #d7dee8;
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
	}

	.action-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid rgba(99, 174, 137, 0.24);
		border-radius: 8px;
		background: rgba(42, 91, 63, 0.12);
		color: #bff1d3;
		font-size: 12px;
		font-weight: 800;
		white-space: nowrap;
	}

	.empty-panel {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 74px;
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		color: #8e9bab;
		font-size: 12px;
		text-align: center;
	}

	.attention-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.attention-summary span {
		padding: 4px 7px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.035);
		color: #9aa8b8;
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	.attention-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.attention-list.primary {
		grid-template-columns: 1fr;
	}

	.attention-more {
		display: grid;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
	}

	.attention-more summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 40px;
		padding: 0 10px;
		cursor: pointer;
		list-style: none;
	}

	.attention-more summary::-webkit-details-marker {
		display: none;
	}

	.attention-more:not([open]) > :not(summary) {
		display: none;
	}

	.attention-more[open] {
		gap: 8px;
		padding-bottom: 10px;
	}

	.attention-more[open] .attention-list {
		width: calc(100% - 20px);
		margin-inline: 10px;
	}

	.attention-more summary span,
	.attention-more summary strong {
		font-size: 11px;
		font-weight: 850;
	}

	.attention-more summary span {
		color: #9fbfff;
	}

	.attention-more summary strong {
		color: #dfe9f8;
	}

	.attention-row {
		display: grid;
		min-width: 0;
		grid-template-columns: minmax(0, 1fr) auto;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.032);
	}

	.attention-row.hot {
		border-color: rgba(255, 139, 124, 0.32);
	}

	.attention-row.warn {
		border-color: rgba(255, 211, 122, 0.26);
	}

	.attention-row:hover {
		border-color: rgba(141, 187, 255, 0.42);
		background: rgba(61, 117, 188, 0.14);
	}

	.attention-main,
	.attention-open {
		min-width: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		font-family: inherit;
	}

	.attention-main {
		display: flex;
		min-height: 84px;
		flex-direction: column;
		gap: 4px;
		padding: 10px;
		text-align: left;
	}

	.attention-main span {
		overflow: hidden;
		color: #8fb8ff;
		font-size: 10px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attention-row.hot .attention-main span {
		color: #ffb4a8;
	}

	.attention-row.warn .attention-main span {
		color: #ffd37a;
	}

	.attention-main strong {
		display: -webkit-box;
		overflow: hidden;
		color: #eef3f8;
		font-size: 12px;
		font-weight: 850;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.attention-main small {
		display: -webkit-box;
		overflow: hidden;
		color: #8e9bab;
		font-size: 11px;
		line-height: 1.28;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.attention-open {
		align-self: stretch;
		padding: 0 10px;
		border-left: 1px solid rgba(255, 255, 255, 0.075);
		color: #b6d8ff;
		font-size: 10px;
		font-weight: 850;
	}

	/* Container-query responsive: secondary list goes single-column on narrow panels,
	   and each row stacks its open-action below the body on phone widths. */
	@container (max-width: 720px) {
		.attention-list {
			grid-template-columns: 1fr;
		}
	}

	@container (max-width: 440px) {
		.attention-list,
		.attention-row {
			grid-template-columns: 1fr;
		}

		.attention-open {
			min-height: 40px;
			border-top: 1px solid rgba(255, 255, 255, 0.075);
			border-left: 0;
		}
	}

	/* Creator-studio task card skin (violet / magenta, dark hairline). */
	.workspace-attention,
	.attention-more,
	.attention-row,
	.empty-panel {
		border-color: var(--ws-hair);
		border-radius: 12px;
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 14px 40px -28px rgba(0, 0, 0, 0.9);
	}

	.eyebrow,
	.attention-summary span,
	.attention-more summary span,
	.attention-main span {
		color: #c4b5fd;
		letter-spacing: 0;
	}

	h2,
	.attention-more summary strong,
	.attention-main strong {
		color: var(--color-ws-ink);
	}

	.attention-main small,
	.empty-panel {
		color: var(--color-ws-text);
	}

	.section-head button,
	.attention-open {
		min-height: 42px;
		border-radius: 10px;
		border-color: transparent;
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, #d946ef 100%);
		box-shadow: 0 8px 24px -10px rgba(217, 70, 239, 0.55);
		color: #fff;
	}

	.attention-summary span {
		border-color: var(--ws-hair-strong);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-text);
	}

	.attention-row.hot {
		border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent);
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-ws-rose) 10%, transparent), color-mix(in srgb, var(--color-ws-violet) 4%, transparent)),
			var(--color-ws-surface);
	}

	.attention-row.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
	}

	.attention-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		background: var(--color-ws-surface2);
	}

	.attention-row.hot .attention-main span {
		color: var(--color-ws-rose);
	}

	.attention-row.warn .attention-main span {
		color: var(--color-ws-amber);
	}
</style>
