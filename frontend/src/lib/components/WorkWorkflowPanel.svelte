<script lang="ts">
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import type {
		ActivityEvent,
		PageReviewDecision,
		PageReviewDecisionStatus,
		ProjectComment,
		WorkflowTask,
		WorkflowTaskPriority,
		WorkflowTaskStatus,
	} from "$lib/types.js";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { _ } from "$lib/i18n";

	// Stable code for the review SCOPE, produced by WorkModePanel alongside the
	// (already-localized) `reviewScopeLabel` display string. The title used to be
	// chosen by value-matching the rendered Thai (`startsWith("หน้า")` /
	// `=== "ทั้งตอน"`), which silently fell through to the wrong branch in non-Thai
	// locales. The consumer now switches on this code instead.
	type ReviewScopeKind = "page" | "currentPage" | "chapter" | "custom";

	interface Props {
		soloMode?: boolean;
		projectOpen: boolean;
		workflowLoading: boolean;
		reviewLoading: boolean;
		workflowDoneCount: number;
		totalTaskCount: number;
		reviewNote: string;
		focusedReviewDecision: PageReviewDecision | null;
		selectedReviewDecisionId: string | null;
		reviewScopeLabel?: string;
		reviewScopeKind?: ReviewScopeKind;
		reviewStatusCopy?: string;
		reviewActionsDisabled?: boolean;
		tasks: WorkflowTask[];
		selectedTaskId: string | null;
		openComments?: ProjectComment[];
		selectedCommentId?: string | null;
		statusOptions: readonly { id: WorkflowTaskStatus }[];
		priorityOptions: readonly { id: WorkflowTaskPriority; label: string }[];
		activityLog: ActivityEvent[];
		timeLabel: (value: string) => string;
		getCommentAnchorLabel?: (comment: ProjectComment) => string | null;
		onUseCommentAsReviewNote?: (comment: ProjectComment) => void;
		onSync: () => void;
		onReviewNoteChange: (value: string) => void;
		onSubmitReviewDecision: (status: PageReviewDecisionStatus) => void | Promise<void>;
		onTaskStatusChange: (taskId: string, status: WorkflowTaskStatus) => void;
		onTaskPriorityChange: (taskId: string, priority: WorkflowTaskPriority) => void;
		onTaskAssigneeChange: (taskId: string, assignee: string) => void;
		onTaskDueAtChange: (taskId: string, dueAt: string | null) => void;
	}

	let {
		projectOpen,
		workflowLoading,
		reviewLoading,
		workflowDoneCount,
		totalTaskCount,
		reviewNote,
		focusedReviewDecision,
		selectedReviewDecisionId,
		// Display string for the review scope (already localized by WorkModePanel).
		// Defaults to the localized "current page" label; the title branch is chosen
		// by `reviewScopeKind`, never by matching this text.
		reviewScopeLabel = $_("workMode.currentPage"),
		reviewScopeKind = "currentPage",
		reviewStatusCopy,
		reviewActionsDisabled = false,
		tasks,
		selectedTaskId,
		openComments = [],
		selectedCommentId = null,
		statusOptions,
		priorityOptions,
		activityLog,
		timeLabel,
		getCommentAnchorLabel = () => null,
		onUseCommentAsReviewNote = () => {},
		onSync,
		onReviewNoteChange,
		onSubmitReviewDecision,
		onTaskStatusChange,
		onTaskPriorityChange,
		onTaskAssigneeChange,
		onTaskDueAtChange,
		soloMode,
	}: Props = $props();

	let isSoloMode = $derived(soloMode ?? (editorUiStore.workspaceMode === "solo"));

	let syncDisabled = $derived(!projectOpen || workflowLoading || reviewLoading);
	let canSync = $derived(!syncDisabled);
	let syncReceiptLabel = $derived(!projectOpen ? $_("workWorkflow.syncReceiptOpenFirst") : workflowLoading ? $_("workWorkflow.syncReceiptSyncing") : $_("workWorkflow.syncReceiptReviewing"));
	let hasReviewNote = $derived(Boolean(reviewNote.trim()));
	let reviewActionsBusy = $derived(reviewLoading || reviewActionsDisabled);
	let canApproveReview = $derived(!reviewActionsBusy);
	let canRequestChanges = $derived(!reviewActionsBusy && hasReviewNote);
	let reviewActionReceiptLabel = $derived(reviewLoading ? $_("workWorkflow.syncReceiptReviewing") : $_("workWorkflow.reviewReceiptSaving"));
	let requestChangesReceiptLabel = $derived(
		reviewActionsBusy ? reviewActionReceiptLabel : $_("workWorkflow.requestChangesReceiptNote")
	);
	let sortedReviewComments = $derived(
		openComments
			.filter((comment) => comment.status !== "resolved")
			.sort((a, b) => commentTimestamp(b) - commentTimestamp(a))
	);
	let reviewCommentPrompts = $derived(sortedReviewComments.slice(0, 3));
	let hiddenReviewCommentCount = $derived(Math.max(0, sortedReviewComments.length - reviewCommentPrompts.length));
	let focusedTaskIndex = $derived(getFocusedTaskIndex());
	let focusedTask = $derived(focusedTaskIndex >= 0 ? tasks[focusedTaskIndex] ?? null : null);
	let focusedTaskPosition = $derived(focusedTaskIndex >= 0 ? `${focusedTaskIndex + 1}/${tasks.length}` : `0/${tasks.length}`);
	let focusedTaskActions = $derived(focusedTask ? getTaskActions(focusedTask) : []);
	let openTaskCount = $derived(tasks.filter((task) => task.status !== "done").length);

	function updateReviewNote(event: Event): void {
		onReviewNoteChange((event.currentTarget as HTMLTextAreaElement).value);
	}

	function updateTaskStatus(taskId: string, event: Event): void {
		onTaskStatusChange(taskId, (event.currentTarget as HTMLSelectElement).value as WorkflowTaskStatus);
	}

	function updateTaskPriority(taskId: string, event: Event): void {
		onTaskPriorityChange(taskId, (event.currentTarget as HTMLSelectElement).value as WorkflowTaskPriority);
	}

	function updateTaskAssignee(taskId: string, event: Event): void {
		onTaskAssigneeChange(taskId, (event.currentTarget as HTMLInputElement).value);
	}

	function updateTaskDueAt(taskId: string, event: Event): void {
		const value = (event.currentTarget as HTMLInputElement).value;
		if (!value) {
			onTaskDueAtChange(taskId, null);
			return;
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return;
		onTaskDueAtChange(taskId, date.toISOString());
	}

	function priorityLabel(priority: WorkflowTaskPriority | undefined): string {
		const value = priority ?? "normal";
		const labels: Record<WorkflowTaskPriority, string> = {
			normal: $_("workWorkflow.priorityNormal"),
			high: $_("workWorkflow.priorityHigh"),
			urgent: $_("workWorkflow.priorityUrgent"),
		};
		return labels[value] ?? priorityOptions.find((option) => option.id === value)?.label ?? $_("workWorkflow.priorityNormal");
	}

	function statusLabel(status: WorkflowTaskStatus): string {
		const labels: Record<WorkflowTaskStatus, string> = {
			todo: $_("workWorkflow.statusTodo"),
			doing: $_("workWorkflow.statusDoing"),
			review: $_("workWorkflow.statusReview"),
			done: $_("workWorkflow.statusDone"),
		};
		return labels[status] ?? status;
	}

	function taskTypeLabel(type: WorkflowTask["type"]): string {
		// Keyed by string so friendly labels for adjacent task kinds (e.g. qc/ai)
		// can be supplied even though they are not in the WorkflowTaskType union.
		const labels: Record<string, string> = {
				translate: $_("workWorkflow.taskTypeTranslate"),
				clean: "Clean",
				typeset: "Typeset",
				review: $_("workWorkflow.taskTypeReview"),
				qc: "QC",
			ai: "AI",
		};
		return labels[type] ?? type;
	}

	function dueInputValue(dueAt: string | undefined): string {
		if (!dueAt) return "";
		const date = new Date(dueAt);
		if (Number.isNaN(date.getTime())) return "";
		const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
		return local.toISOString().slice(0, 16);
	}

	function dueLabel(dueAt: string | undefined): string {
		if (!dueAt) return "";
		const date = new Date(dueAt);
		if (Number.isNaN(date.getTime())) return "";
		return new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	function dueReadonlyLabel(dueAt: string | undefined): string {
		return dueLabel(dueAt) || $_("workWorkflow.dueNotSet");
	}

	function isOverdue(task: WorkflowTask): boolean {
		if (!task.dueAt || task.status === "done") return false;
		const dueTime = Date.parse(task.dueAt);
		return Number.isFinite(dueTime) && dueTime < Date.now();
	}

	function getFocusedTaskIndex(): number {
		const selectedIndex = tasks.findIndex((task) => task.id === selectedTaskId);
		if (selectedIndex >= 0) return selectedIndex;
		const firstOpenIndex = tasks.findIndex((task) => task.status !== "done");
		return firstOpenIndex >= 0 ? firstOpenIndex : tasks.length > 0 ? 0 : -1;
	}

	function getTaskActions(task: WorkflowTask): { label: string; ariaLabel: string; status: WorkflowTaskStatus; tone: "ready" | "done" | "quiet" }[] {
		if (task.status === "done") return [{ label: $_("workWorkflow.actionReopen"), ariaLabel: $_("workWorkflow.actionReopenAria"), status: "doing", tone: "quiet" }];
		if (task.status === "review") return [{ label: $_("workWorkflow.actionDone"), ariaLabel: $_("workWorkflow.actionDoneAria"), status: "done", tone: "done" }];
		if (task.status === "doing") {
			return [
				{ label: $_("workWorkflow.actionSendReview"), ariaLabel: $_("workWorkflow.actionSendReviewAria"), status: "review", tone: "ready" },
				{ label: $_("workWorkflow.actionDone"), ariaLabel: $_("workWorkflow.actionDoneAria"), status: "done", tone: "done" },
			];
		}
		return [
			{ label: $_("workWorkflow.actionStart"), ariaLabel: $_("workWorkflow.actionStartAria"), status: "doing", tone: "ready" },
			{ label: $_("workWorkflow.actionSendReview"), ariaLabel: $_("workWorkflow.actionSendReviewAria"), status: "review", tone: "quiet" },
		];
	}

	function reviewStatusLabel(decision: PageReviewDecision | null): string {
		if (!decision) return $_("workWorkflow.reviewStatusPending");
		return decision.status === "approved" ? $_("workWorkflow.reviewStatusApproved") : $_("workWorkflow.reviewStatusChanges");
	}

	function reviewDecisionTitleLabel(scopeLabel: string, scopeKind: ReviewScopeKind): string {
		const scope = scopeLabel.trim() || $_("workMode.currentPage");
		// Branch on the stable scope CODE (was a value-match on the rendered Thai,
		// which mis-routed in non-Thai locales). Page-scoped titles glue the
		// localized "Review" verb directly onto the page label; chapter / custom
		// scopes get their own keys.
		if (scopeKind === "chapter") return $_("workWorkflow.reviewTitleChapter");
		if (scopeKind === "page" || scopeKind === "currentPage") {
			return $_("workWorkflow.reviewTitlePagePrefix", { values: { scope } });
		}
		return $_("workWorkflow.reviewTitleScope", { values: { scope } });
	}

	function commentTimestamp(comment: ProjectComment): number {
		const raw = comment.updatedAt || comment.createdAt;
		const value = new Date(raw).getTime();
		return Number.isNaN(value) ? 0 : value;
	}

	function compactCommentBody(comment: ProjectComment): string {
		const body = comment.body.replace(/\s+/g, " ").trim();
		if (!body) return $_("workWorkflow.commentFromReview");
		return body.length > 96 ? `${body.slice(0, 93)}...` : body;
	}

	function fullCommentBody(comment: ProjectComment): string {
		return comment.body.replace(/\s+/g, " ").trim() || $_("workWorkflow.commentFromReview");
	}

	function normalizeAnchorLabel(value: string | null): string | null {
		// Translates English anchor labels produced out-of-batch into Thai display.
		if (!value) return null;
		return value
			.replace(/^Page note$/i, $_("workWorkflow.anchorWholePage"))
			.replace(/^Region:/i, $_("workWorkflow.anchorRegionPrefix"))
			.replace(/^Page:/i, $_("workWorkflow.anchorWholePagePrefix"));
	}

	function useAllOpenCommentsAsReviewNote(): void {
		const note = sortedReviewComments
			.map((comment, index) => {
				const anchorLabel = normalizeAnchorLabel(getCommentAnchorLabel(comment));
				const anchorLine = anchorLabel ? `\n   ${$_("workWorkflow.notePositionPrefix")} ${anchorLabel}` : "";
				return `${index + 1}. ${fullCommentBody(comment)}${anchorLine}`;
			})
			.join("\n\n");
		onReviewNoteChange(note);
	}
</script>

<div class="workflow-panel">
	<div class="workflow-summary">
		<span>{workflowDoneCount}/{totalTaskCount} {$_("workWorkflow.doneSuffix")}</span>
		{#if canSync}
			<button
				type="button"
				class="layer-action-btn workflow-sync-btn"
				onclick={onSync}
				aria-label={$_("workWorkflow.syncAria")}
			>
				{$_("workWorkflow.sync")}
			</button>
		{:else}
			<span class="workflow-action-receipt workflow-sync-btn" aria-label={$_("workWorkflow.syncStatusAria")}>{syncReceiptLabel}</span>
		{/if}
	</div>

	{#if projectOpen && focusedTask}
		<section class="workflow-focus-card" aria-label={$_("workWorkflow.focusCardAria")}>
			<div class="workflow-focus-copy">
				<span>{taskTypeLabel(focusedTask.type)} / {focusedTaskPosition}</span>
				<strong>{focusedTask.title}</strong>
				<small>
					{statusLabel(focusedTask.status)} / {priorityLabel(focusedTask.priority)}{isSoloMode ? "" : " / " + formatAssigneeHandle(focusedTask.assignee)}
					{#if focusedTask.dueAt}
						/ {$_("workWorkflow.due")} {dueLabel(focusedTask.dueAt)}
					{/if}
				</small>
			</div>
			<div class="workflow-focus-actions">
				{#if workflowLoading}
					<span class="workflow-action-receipt">{$_("workWorkflow.syncReceiptSyncing")}</span>
				{:else}
					{#each focusedTaskActions as action (action.label)}
						<button
							type="button"
							class={`workflow-focus-action ${action.tone}`}
							onclick={() => onTaskStatusChange(focusedTask.id, action.status)}
							aria-label={`${action.ariaLabel}: ${focusedTask.title}`}
						>
							{action.label}
						</button>
					{/each}
				{/if}
			</div>
		</section>
	{/if}

	{#if projectOpen}
		<div
			class="review-decision-card"
			class:selected={focusedReviewDecision?.id === selectedReviewDecisionId}
		>
			<div class="review-decision-header">
				<div class="review-decision-title">
					<span>{reviewDecisionTitleLabel(reviewScopeLabel, reviewScopeKind)}</span>
					<strong>{reviewStatusLabel(focusedReviewDecision)}</strong>
				</div>
				<span class={`review-status-pill ${focusedReviewDecision?.status ?? "pending"}`}>
						{reviewStatusCopy ?? (focusedReviewDecision ? $_("workWorkflow.pillLatest") : $_("workWorkflow.pillPending"))}
				</span>
			</div>
			{#if focusedReviewDecision}
				<div class="review-decision-latest">
					<span>{focusedReviewDecision.body || $_("workWorkflow.noReviewNote")}</span>
					<small>
						{reviewScopeLabel} - {focusedReviewDecision.actor} - {timeLabel(focusedReviewDecision.createdAt)}
					</small>
				</div>
			{:else}
				<p class="review-decision-empty">{$_("workWorkflow.reviewEmptyHint")}</p>
			{/if}
			{#if reviewCommentPrompts.length}
				<div class="review-comment-prompts" aria-label={$_("workWorkflow.commentPromptsAria")}>
					<div class="review-comment-prompts-head">
						<div>
							<span>{$_("workWorkflow.openNotesCount", { values: { n: sortedReviewComments.length } })}</span>
							<small>{$_("workWorkflow.openNotesHint")}</small>
						</div>
						<button
							type="button"
							class="review-comment-use-all"
							onclick={useAllOpenCommentsAsReviewNote}
							aria-label={$_("workWorkflow.useAllNotesAria", { values: { n: sortedReviewComments.length } })}
						>
							{$_("workWorkflow.useAll")}
						</button>
					</div>
					{#each reviewCommentPrompts as comment (comment.id)}
						{@const anchorLabel = normalizeAnchorLabel(getCommentAnchorLabel(comment))}
						<button
							type="button"
							class="review-comment-prompt"
							class:selected={selectedCommentId === comment.id}
							onclick={() => onUseCommentAsReviewNote(comment)}
							aria-label={$_("workWorkflow.useNoteFromAria", { values: { author: comment.author } })}
						>
							<strong>{compactCommentBody(comment)}</strong>
							<small>
								{comment.author}{anchorLabel ? ` - ${anchorLabel}` : ""}
							</small>
						</button>
					{/each}
					{#if hiddenReviewCommentCount}
						<small class="review-comment-more">{$_("workWorkflow.moreOpenNotes", { values: { n: hiddenReviewCommentCount } })}</small>
					{/if}
				</div>
			{/if}
			<textarea
				value={reviewNote}
				rows="2"
				placeholder={$_("workWorkflow.reviewNotePlaceholder")}
				readonly={reviewLoading}
				aria-label={$_("workWorkflow.reviewNoteAria")}
				oninput={updateReviewNote}
			></textarea>
			<div class="review-decision-actions">
				{#if canApproveReview}
					<button
						type="button"
						class="layer-action-btn review-approve-btn"
						onclick={() => onSubmitReviewDecision("approved")}
						aria-label={$_("workWorkflow.approve")}
					>
						<span>{$_("workWorkflow.approve")}</span>
						<small>{$_("workWorkflow.approveSub")}</small>
					</button>
				{:else}
					<span class="layer-action-btn review-approve-btn workflow-action-receipt">
						<span>{$_("workWorkflow.approve")}</span>
						<small>{reviewActionReceiptLabel}</small>
					</span>
				{/if}
				{#if canRequestChanges}
					<button
						type="button"
						class="layer-action-btn review-change-btn"
						onclick={() => onSubmitReviewDecision("changes_requested")}
						aria-label={$_("workWorkflow.requestChanges")}
					>
						<span>{$_("workWorkflow.requestChanges")}</span>
						<small>{$_("workWorkflow.requestChangesSub")}</small>
					</button>
				{:else}
					<span class="layer-action-btn review-change-btn workflow-action-receipt">
						<span>{$_("workWorkflow.requestChanges")}</span>
						<small>{requestChangesReceiptLabel}</small>
					</span>
				{/if}
			</div>
		</div>
	{/if}

	{#if !projectOpen}
		<div class="empty-state">
			<strong>{$_("workWorkflow.openWorkFirst")}</strong>
			<span>{$_("workWorkflow.openWorkToManage")}</span>
		</div>
	{:else if workflowLoading && !totalTaskCount}
		<div class="empty-state">{$_("workWorkflow.loadingTasks")}</div>
	{:else if !tasks.length}
		<div class="empty-state">
			<strong>{$_("workWorkflow.noTasksTitle")}</strong>
			<span>{$_("workWorkflow.noTasksHint")}</span>
		</div>
	{:else}
		<details class="workflow-task-drawer" open={tasks.length <= 1}>
			<summary>
				<span>{$_("workWorkflow.taskDetailsTitle")}</span>
				<em>{$_("workWorkflow.taskCountSummary", { values: { open: openTaskCount, total: tasks.length } })}</em>
			</summary>
			<div class="workflow-task-list">
				{#each tasks as task (task.id)}
					<div
						class={`workflow-task-row priority-${task.priority ?? "normal"}`}
						class:selected={selectedTaskId === task.id}
					>
						<div class="workflow-task-main">
							<div class="workflow-task-title-row">
								<span>{task.title}</span>
								{#if (task.priority ?? "normal") !== "normal"}
									<em class={`priority-badge ${task.priority ?? "normal"}`}>{priorityLabel(task.priority)}</em>
								{/if}
							</div>
							<small>
								{taskTypeLabel(task.type)}
								{#if task.dueAt}
									<em class:overdue={isOverdue(task)}>{$_("workWorkflow.due")} {dueLabel(task.dueAt)}</em>
								{/if}
							</small>
						</div>
						{#if workflowLoading}
							<span class="workflow-readonly-field" aria-label={$_("workWorkflow.taskStatusAria", { values: { title: task.title } })}>
								{statusLabel(task.status)}
							</span>
							<span class="workflow-readonly-field" aria-label={$_("workWorkflow.taskPriorityAria", { values: { title: task.title } })}>
								{priorityLabel(task.priority)}
							</span>
						{:else}
							<select
								class="workflow-status-select"
								value={task.status}
								onchange={(event) => updateTaskStatus(task.id, event)}
								aria-label={$_("workWorkflow.taskStatusAria", { values: { title: task.title } })}
							>
								{#each statusOptions as option (option.id)}
									<option value={option.id}>{statusLabel(option.id)}</option>
								{/each}
							</select>
							<select
								class="workflow-priority-select"
								value={task.priority ?? "normal"}
								onchange={(event) => updateTaskPriority(task.id, event)}
								aria-label={$_("workWorkflow.taskPriorityAria", { values: { title: task.title } })}
							>
								{#each priorityOptions as option (option.id)}
									<option value={option.id}>{priorityLabel(option.id)}</option>
								{/each}
							</select>
						{/if}
						<div class="workflow-task-secondary">
							{#if workflowLoading}
								{#if !isSoloMode}
									<span class="workflow-readonly-field" aria-label={$_("workWorkflow.taskAssigneeAria", { values: { title: task.title } })}>
										{formatAssigneeHandle(task.assignee)}
									</span>
								{/if}
								<span class="workflow-readonly-field" aria-label={$_("workWorkflow.taskDueAria", { values: { title: task.title } })}>
									{dueReadonlyLabel(task.dueAt)}
								</span>
							{:else}
								{#if !isSoloMode}
									<input
										class="workflow-assignee-input"
										value={task.assignee ?? ""}
										placeholder={$_("workWorkflow.assigneePlaceholder")}
										onchange={(event) => updateTaskAssignee(task.id, event)}
										aria-label={$_("workWorkflow.taskAssigneeAria", { values: { title: task.title } })}
									/>
								{/if}
								<input
									class="workflow-due-input"
									type="datetime-local"
									value={dueInputValue(task.dueAt)}
									onchange={(event) => updateTaskDueAt(task.id, event)}
									aria-label={$_("workWorkflow.taskDueAria", { values: { title: task.title } })}
								/>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</details>
	{/if}

	{#if activityLog.length}
		<details class="activity-list">
			<summary class="activity-title">{$_("workWorkflow.activityTitle")}</summary>
			{#each activityLog.slice(0, 5) as event (event.id)}
				<div class="activity-row">
					<span>{event.message}</span>
					<small>{timeLabel(event.createdAt)}</small>
				</div>
			{/each}
		</details>
	{/if}
</div>

<style>
	.workflow-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.workflow-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--editor-text-dim);
		font-size: 11px;
	}

	.layer-action-btn {
		min-height: 36px;
		min-width: 0;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text-dim);
		font-size: 11px;
		line-height: 1;
		cursor: pointer;
	}

	.workflow-sync-btn {
		min-width: 52px;
		padding: 0 12px;
	}

	.layer-action-btn:hover {
		color: var(--editor-text);
		border-color: var(--editor-accent);
	}

	.review-decision-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 8px;
		background:
			linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.025)),
			rgba(255, 255, 255, 0.025);
	}

	.review-decision-card.selected,
	.workflow-task-row.selected {
		border-color: rgba(124, 92, 255, 0.55);
		background: rgba(124, 92, 255, 0.14);
	}

	.review-decision-header,
	.review-decision-actions,
	.review-decision-latest {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.review-decision-header {
		justify-content: space-between;
	}

	.review-decision-title {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.review-decision-title span {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: none;
	}

	.review-decision-title strong {
		overflow: hidden;
		color: var(--editor-text);
		font-size: 13px;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.review-status-pill {
		flex: 0 0 auto;
		padding: 4px 7px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
		text-transform: none;
	}

	.review-status-pill.approved {
		border-color: rgba(137, 209, 133, 0.34);
		background: rgba(52, 211, 153, 0.1);
		color: #9ee39a;
	}

	.review-status-pill.changes_requested {
		border-color: rgba(251, 191, 36, 0.36);
		background: rgba(251, 191, 36, 0.1);
		color: #fcd34d;
	}

	.review-decision-card textarea {
		min-height: 48px;
		resize: vertical;
	}

	.review-decision-card textarea[readonly] {
		opacity: 0.58;
		cursor: default;
	}

	.review-decision-actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: stretch;
		gap: 8px;
	}

	.review-decision-actions .layer-action-btn {
		display: flex;
		height: auto;
		min-height: 56px;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 3px;
		padding: 7px 9px;
		text-align: left;
	}

	.review-decision-actions .layer-action-btn span {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.1;
	}

	.review-decision-actions .layer-action-btn small {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.1;
	}

	.review-approve-btn {
		border-color: rgba(52, 211, 153, 0.46);
		background: rgba(52, 211, 153, 0.14);
	}

	.review-change-btn {
		border-color: rgba(251, 191, 36, 0.46);
		background: rgba(251, 191, 36, 0.14);
	}

	.workflow-action-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		min-width: 0;
		padding: 0 9px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--editor-text-dim);
		cursor: default;
		font-size: 10px;
		font-weight: 800;
		line-height: 1.1;
		text-align: center;
	}

	.layer-action-btn.workflow-action-receipt {
		align-items: flex-start;
		flex-direction: column;
		height: auto;
		min-height: 56px;
		gap: 3px;
	}

	.layer-action-btn.workflow-action-receipt:hover {
		color: var(--editor-text-dim);
		border-color: rgba(255, 255, 255, 0.09);
	}

	.review-decision-latest {
		align-items: flex-start;
		flex-direction: column;
		gap: 4px;
		padding: 8px 9px;
		border-left: 2px solid rgba(251, 191, 36, 0.42);
		background: rgba(0, 0, 0, 0.12);
		color: var(--editor-text);
		font-size: 11px;
	}

	.review-decision-latest span {
		max-width: 100%;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.review-decision-latest small {
		color: var(--editor-text-dim);
		font-size: 10px;
		text-transform: none;
	}

	.review-comment-prompts {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid rgba(251, 191, 36, 0.2);
		border-radius: 7px;
		background: rgba(251, 191, 36, 0.055);
	}

	.review-comment-prompts-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.review-comment-prompts-head > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.review-comment-prompts-head span {
		color: #fcd34d;
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
	}

	.review-comment-prompts-head small,
	.review-comment-prompt small,
	.review-comment-more {
		color: var(--editor-text-dim);
		font-size: 10px;
		line-height: 1.2;
	}

	.review-comment-use-all {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 0 8px;
		border: 1px solid rgba(251, 191, 36, 0.3);
		border-radius: 999px;
		background: rgba(251, 191, 36, 0.08);
		color: #fcd34d;
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
	}

	.review-comment-prompt {
		display: flex;
		min-height: 36px;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.14);
		color: var(--editor-text);
		cursor: pointer;
		text-align: left;
	}

	.review-comment-use-all:hover,
	.review-comment-prompt:hover,
	.review-comment-prompt.selected {
		border-color: rgba(251, 191, 36, 0.46);
		background: rgba(251, 191, 36, 0.11);
	}

	.review-comment-prompt strong {
		overflow: hidden;
		color: var(--editor-text);
		display: -webkit-box;
		font-size: 11px;
		font-weight: 780;
		line-height: 1.25;
		text-overflow: ellipsis;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.review-comment-prompt small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.review-decision-empty {
		margin: 0;
		color: var(--editor-text-dim);
		font-size: 11px;
		line-height: 1.35;
	}

	.workflow-task-list,
	.activity-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.workflow-task-drawer {
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.02);
	}

	.workflow-task-drawer summary {
		display: flex;
		min-height: 36px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 0 9px;
		color: var(--editor-text-dim);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
	}

	.workflow-task-drawer summary em {
		color: #c4b5fd;
		font-style: normal;
		text-transform: none;
	}

	.workflow-task-drawer .workflow-task-list {
		padding: 6px 6px 7px;
	}

	.workflow-focus-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 10px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-left-color: rgba(124, 92, 255, 0.48);
		border-radius: 8px;
		background: rgba(124, 92, 255, 0.06);
		box-shadow: inset 2px 0 0 rgba(124, 92, 255, 0.28);
	}

	.workflow-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.workflow-focus-copy span {
		color: #c4b5fd;
		font-size: 9px;
		font-weight: 850;
		text-transform: none;
	}

	.workflow-focus-copy strong {
		overflow: hidden;
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 830;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workflow-focus-copy small {
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 720;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workflow-focus-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 5px;
	}

	.workflow-focus-action {
		min-height: 36px;
		padding: 0 8px;
		border: 1px solid rgba(124, 92, 255, 0.28);
		border-radius: 6px;
		background: rgba(124, 92, 255, 0.1);
		color: var(--editor-text);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
	}

	.workflow-focus-action.done {
		border-color: rgba(137, 209, 133, 0.36);
		background: rgba(52, 211, 153, 0.12);
	}

	.workflow-focus-action.quiet {
		border-color: rgba(255, 255, 255, 0.11);
		background: rgba(255, 255, 255, 0.045);
		color: var(--editor-text-dim);
	}

	.workflow-focus-action:hover {
		border-color: rgba(124, 92, 255, 0.55);
		background: rgba(124, 92, 255, 0.16);
	}

	.workflow-task-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 78px 74px;
		align-items: center;
		gap: 8px;
		padding: 9px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.035);
	}

	.workflow-task-row.priority-urgent {
		border-left-color: rgba(251, 113, 133, 0.78);
		box-shadow: inset 2px 0 0 rgba(251, 113, 133, 0.5);
	}

	.workflow-task-row.priority-high {
		border-left-color: rgba(251, 191, 36, 0.72);
		box-shadow: inset 2px 0 0 rgba(251, 191, 36, 0.42);
	}

	.workflow-task-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.workflow-task-title-row {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
	}

	.workflow-task-title-row span {
		overflow: hidden;
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 740;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workflow-task-main small,
	.activity-row small {
		color: var(--editor-text-dim);
		font-size: 10px;
		text-transform: none;
	}

	.workflow-task-main small em {
		margin-left: 6px;
		color: #fcd34d;
		font-style: normal;
		font-weight: 850;
	}

	.workflow-task-main small em.overdue {
		color: #fb7185;
	}

	.priority-badge {
		flex: 0 0 auto;
		padding: 2px 6px;
		border: 1px solid rgba(251, 191, 36, 0.38);
		border-radius: 999px;
		background: rgba(251, 191, 36, 0.1);
		color: #fcd34d;
		font-size: 9px;
		font-style: normal;
		font-weight: 850;
		line-height: 1;
		text-transform: none;
	}

	.priority-badge.urgent {
		border-color: rgba(251, 113, 133, 0.46);
		background: rgba(251, 113, 133, 0.13);
		color: #fb7185;
	}

	.workflow-status-select,
	.workflow-priority-select,
	.workflow-due-input,
	.workflow-readonly-field {
		width: 100%;
		min-height: 36px;
		border: 1px solid var(--editor-border);
		border-radius: 7px;
		background: var(--editor-bg);
		color: var(--editor-text);
		font-size: 11px;
	}

	.workflow-priority-select {
		color: var(--editor-text-dim);
	}

	.workflow-readonly-field {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		padding: 0 8px;
		color: var(--editor-text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workflow-assignee-input {
		width: 100%;
		min-height: 36px;
		min-width: 0;
		border: 1px solid var(--editor-border);
		border-radius: 7px;
		padding: 0 8px;
		background: var(--editor-bg);
		color: var(--editor-text);
		font-size: 11px;
	}

	.workflow-assignee-input::placeholder {
		color: var(--editor-text-dim);
	}

	.workflow-task-secondary {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: minmax(0, 1fr) 132px;
		gap: 6px;
	}

	.workflow-due-input {
		color: var(--editor-text-dim);
	}

	.activity-list {
		padding-top: 2px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.activity-title {
		min-height: 36px;
		color: var(--editor-text);
		cursor: pointer;
		font-size: 11px;
		font-weight: 700;
	}

	.activity-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		color: var(--editor-text-dim);
		font-size: 11px;
	}

	.activity-row span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: 2px;
		color: var(--editor-text-dim);
		font-size: 11px;
	}

	.empty-state strong {
		color: var(--editor-text);
		font-size: 12px;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.layer-action-btn,
		.review-comment-use-all,
		.review-comment-prompt,
		.workflow-focus-action,
		.workflow-task-drawer summary,
		.workflow-task-row,
		.workflow-status-select,
		.workflow-priority-select,
		.workflow-assignee-input,
		.workflow-due-input,
		.activity-title {
			min-height: 36px;
		}

		.workflow-focus-action {
			min-width: 36px;
		}
	}
</style>
