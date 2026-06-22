<script lang="ts">
	import { _ } from "$lib/i18n";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import type { WorkspaceAssignedWorkGroup } from "$lib/project/workspace-dashboard.js";

	interface Props {
		projectOpen: boolean;
		groups: readonly WorkspaceAssignedWorkGroup[];
		soloAssigneeLabel?: string;
		onFocusGroup: (group: WorkspaceAssignedWorkGroup) => void | Promise<void>;
		onOpenGroup: (group: WorkspaceAssignedWorkGroup) => void | Promise<void>;
	}

	let {
		projectOpen,
		groups,
		soloAssigneeLabel = $_("assignedWork.soloMode"),
		onFocusGroup,
		onOpenGroup,
	}: Props = $props();

	let assignedQuery = $state("");
	let visibleGroups = $derived(filterAssignedGroups(groups, assignedQuery));
	let visibleOpenCount = $derived(visibleGroups.reduce((sum, group) => sum + group.openCount, 0));
	let primaryGroup = $derived(visibleGroups[0] ?? null);
	let secondaryGroups = $derived(visibleGroups.slice(1));

	function groupTone(group: WorkspaceAssignedWorkGroup): string {
		if (group.overdueCount > 0 || group.urgentCount > 0) return "hot";
		if (group.highCount > 0 || group.reviewCount > 0) return "warn";
		return "info";
	}

	function groupDue(group: WorkspaceAssignedWorkGroup): string {
		if (group.overdueCount > 0) return $_("assignedWork.overdueCount", { values: { n: group.overdueCount } });
		if (group.nextDueAt) return $_("assignedWork.dueAt", { values: { day: formatWorkflowDueDay(group.nextDueAt) } });
		return $_("assignedWork.openCount", { values: { n: group.openCount } });
	}

	function taskTypeLabel(task: WorkspaceAssignedWorkGroup["tasks"][number]): string {
		if (task.type === "translate") return $_("assignedWork.typeTranslate");
		if (task.type === "clean") return $_("assignedWork.typeClean");
		if (task.type === "typeset") return $_("assignedWork.typeTypeset");
		if (task.type === "review") return $_("assignedWork.typeReview");
		// `task.typeLabel` is now the stable task-type CODE; localize via taskType.*.
		return $_(`taskType.${task.type}`);
	}

	function taskStatusLabel(value: string): string {
			const labels: Record<string, string> = {
				todo: $_("assignedWork.statusTodo"),
				doing: $_("assignedWork.statusDoing"),
				review: $_("assignedWork.statusReview"),
				done: $_("assignedWork.statusDone"),
			};
		return labels[value] ?? value;
	}

	function taskPriorityLabel(value: string): string {
		const labels: Record<string, string> = {
			urgent: $_("assignedWork.priorityUrgent"),
			high: $_("assignedWork.priorityHigh"),
			low: $_("assignedWork.priorityLow"),
			normal: $_("assignedWork.priorityNormal"),
		};
		return labels[value] ?? value;
	}

	function assignedWorkAssigneeLabel(value: string | null | undefined, fallback = $_("assignedWork.assigneeUnset")): string {
		const normalized = value?.trim().replace(/^@/, "");
		const lower = normalized?.toLowerCase();
		if (!lower) return fallback;
		if (lower === "local-user") return $_("assignedWork.assigneeYou");
		if (lower === "solo") return soloAssigneeLabel;
		if (lower === "qa" || lower === "qc") return lower.toUpperCase();
		return formatAssigneeHandle(normalized);
	}

	function groupDisplayLabel(group: WorkspaceAssignedWorkGroup): string {
		return assignedWorkAssigneeLabel(group.assignee);
	}

	function groupOpenActionLabel(group: WorkspaceAssignedWorkGroup): string {
		if (group.firstOpenPageIndex === null) return $_("assignedWork.openWork");
		return $_("assignedWork.openPage", { values: { n: group.firstOpenPageIndex + 1 } });
	}

		function taskTitleLabel(task: WorkspaceAssignedWorkGroup["tasks"][number]): string {
			if (/^Page\s+\d+\s*-\s*Review imported dialogue$/i.test(task.title) || /^Review imported dialogue$/i.test(task.title)) {
				return $_("assignedWork.titleReviewImported", { values: { n: task.pageIndex + 1 } });
			}
		if (/^Translate page \d+$/i.test(task.title)) return $_("assignedWork.titleTranslatePage", { values: { n: task.pageIndex + 1 } });
		if (/^Clean page \d+$/i.test(task.title)) return $_("assignedWork.titleCleanPage", { values: { n: task.pageIndex + 1 } });
		if (/^Typeset page \d+$/i.test(task.title)) return $_("assignedWork.titleTypesetPage", { values: { n: task.pageIndex + 1 } });
		if (/^Review page \d+$/i.test(task.title)) return $_("assignedWork.titleReviewPage", { values: { n: task.pageIndex + 1 } });
			return task.title
				.replace(/^Page\s+(\d+)\s*-\s*/i, `${$_("assignedWork.pageLabel", { values: { n: "$1" } })}: `)
				.replace(/\bReview imported dialogue\b/gi, $_("assignedWork.titleReviewImportedPlain"))
				.replace(/\bReview page\b/gi, $_("assignedWork.typeReview"))
				.replace(/\bcomments?\b/gi, $_("assignedWork.notesWord"));
		}

	function taskMeta(task: WorkspaceAssignedWorkGroup["tasks"][number]): string {
		const parts = [taskTypeLabel(task), $_("assignedWork.pageLabel", { values: { n: task.pageIndex + 1 } }), taskStatusLabel(task.status)];
		if (task.overdue) parts.push($_("assignedWork.overdueTag"));
		else if (task.priority !== "normal") parts.push(taskPriorityLabel(task.priority));
		if (task.dueAt && !task.overdue) parts.push(formatWorkflowDueDay(task.dueAt));
		return parts.join(" / ");
	}

	function updateAssignedQuery(event: Event): void {
		assignedQuery = (event.currentTarget as HTMLInputElement).value;
	}

	function matchesQuery(value: string | null | undefined, query: string): boolean {
		return Boolean(value?.toLowerCase().includes(query));
	}

	function taskMatchesQuery(task: WorkspaceAssignedWorkGroup["tasks"][number], query: string): boolean {
		return [
			task.title,
			taskTitleLabel(task),
			task.type,
			// `task.typeLabel` is now the stable task-type CODE (from
			// workspace-dashboard.ts). Localize it via the `taskType.*` namespace so
			// the bare task-type word stays a search token in the active locale.
			$_(`taskType.${task.type}`),
			taskTypeLabel(task),
			task.status,
			taskStatusLabel(task.status),
			task.priority,
			taskPriorityLabel(task.priority),
			assignedWorkAssigneeLabel(task.assignee),
			task.overdue ? "overdue" : "",
			`p${task.pageIndex + 1}`,
			`page ${task.pageIndex + 1}`,
			taskMeta(task),
		].some((value) => matchesQuery(value, query));
	}

	function groupMatchesQuery(group: WorkspaceAssignedWorkGroup, query: string): boolean {
		return [
			group.label,
			groupDisplayLabel(group),
			groupTone(group),
			groupDue(group),
			group.reviewCount ? "review" : "",
			group.urgentCount ? "urgent" : "",
			group.highCount ? "high" : "",
			group.overdueCount ? "overdue" : "",
		].some((value) => matchesQuery(value, query));
	}

	function filteredAssignedGroup(
		group: WorkspaceAssignedWorkGroup,
		tasks: WorkspaceAssignedWorkGroup["tasks"],
	): WorkspaceAssignedWorkGroup {
		const orderedTasks = [...tasks];
		const firstOpenTask = orderedTasks[0] ?? null;
		const nextDueAt = orderedTasks
			.map((task) => task.dueAt)
			.filter((dueAt): dueAt is string => Boolean(dueAt))
			.sort((a, b) => a.localeCompare(b))[0] ?? null;

		return {
			...group,
			openCount: orderedTasks.length,
			urgentCount: orderedTasks.filter((task) => task.priority === "urgent").length,
			highCount: orderedTasks.filter((task) => task.priority === "high").length,
			overdueCount: orderedTasks.filter((task) => task.overdue).length,
			reviewCount: orderedTasks.filter((task) => task.status === "review" || task.type === "review").length,
			nextDueAt,
			firstOpenTaskId: firstOpenTask?.id ?? null,
			firstOpenPageIndex: firstOpenTask?.pageIndex ?? null,
			tasks: orderedTasks,
		};
	}

	function groupForTask(
		group: WorkspaceAssignedWorkGroup,
		task: WorkspaceAssignedWorkGroup["tasks"][number],
	): WorkspaceAssignedWorkGroup {
		return {
			...group,
			firstOpenTaskId: task.id,
			firstOpenPageIndex: task.pageIndex,
			tasks: [task],
		};
	}

	function filterAssignedGroups(
		sourceGroups: readonly WorkspaceAssignedWorkGroup[],
		rawQuery: string,
	): readonly WorkspaceAssignedWorkGroup[] {
		const query = rawQuery.trim().toLowerCase();
		if (!query) return sourceGroups;
		return sourceGroups.flatMap((group) => {
			if (groupMatchesQuery(group, query)) return [group];
			const matchingTasks = group.tasks.filter((task) => taskMatchesQuery(task, query));
			return matchingTasks.length ? [filteredAssignedGroup(group, matchingTasks)] : [];
		});
	}
</script>

<section class="assigned-work" aria-label={$_("assignedWork.regionLabel")}>
	<div class="section-head">
		<div>
			<span class="eyebrow">{$_("assignedWork.eyebrow")}</span>
			<h2>{$_("assignedWork.heading")}</h2>
		</div>
		<div class="assigned-tools">
			<input
				type="search"
				value={assignedQuery}
				placeholder={$_("assignedWork.searchPlaceholder")}
				aria-label={$_("assignedWork.searchAria")}
				oninput={updateAssignedQuery}
			/>
			{#if projectOpen && visibleGroups.length > 0}
				<button type="button" onclick={() => visibleGroups[0] && onFocusGroup(visibleGroups[0])}>
					{$_("assignedWork.doFirstQueue")}
				</button>
			{:else}
				<span class="action-receipt">{projectOpen ? $_("assignedWork.noQueue") : $_("assignedWork.notOpen")}</span>
			{/if}
		</div>
	</div>

	{#if !projectOpen}
		<div class="empty-panel">{$_("assignedWork.emptyNotOpen")}</div>
	{:else if groups.length === 0}
		<div class="empty-panel">{$_("assignedWork.emptyNoWork")}</div>
	{:else if visibleGroups.length === 0}
		<div class="empty-panel">{$_("assignedWork.emptyNoMatch")}</div>
	{:else}
		<div class="assigned-summary" aria-label={$_("assignedWork.summaryAria")}>
			<span>{$_("assignedWork.queueCount", { values: { n: visibleGroups.length } })}</span>
			<strong>{$_("assignedWork.openCount", { values: { n: visibleOpenCount } })}</strong>
		</div>
		{#if primaryGroup}
			<div class="assigned-grid primary">
				<article class={`assigned-card ${groupTone(primaryGroup)}`}>
					<header>
						<div>
							<span>{groupDisplayLabel(primaryGroup)}</span>
							<strong>{$_("assignedWork.openCount", { values: { n: primaryGroup.openCount } })}</strong>
						</div>
						<em>{groupDue(primaryGroup)}</em>
					</header>
					<div class="signal-strip" aria-label={$_("assignedWork.signalAria", { values: { label: groupDisplayLabel(primaryGroup) } })}>
						<span>{$_("assignedWork.urgentCount", { values: { n: primaryGroup.urgentCount } })}</span>
						<span>{$_("assignedWork.highCount", { values: { n: primaryGroup.highCount } })}</span>
							<span>{$_("assignedWork.reviewCount", { values: { n: primaryGroup.reviewCount } })}</span>
					</div>
					<div class="task-list">
						{#each primaryGroup.tasks as task (task.id)}
							<button type="button" class="task-row" onclick={() => onOpenGroup(groupForTask(primaryGroup, task))}>
								<span>{taskMeta(task)}</span>
								<strong>{taskTitleLabel(task)}</strong>
							</button>
						{/each}
					</div>
					<div class="card-actions">
						<button type="button" onclick={() => onFocusGroup(primaryGroup)}>{$_("assignedWork.doThisQueue")}</button>
						<button type="button" onclick={() => onOpenGroup(primaryGroup)}>{groupOpenActionLabel(primaryGroup)}</button>
					</div>
				</article>
			</div>
			{#if secondaryGroups.length}
				<details class="assigned-more">
					<summary>
						<span>{$_("assignedWork.otherAssignees")}</span>
						<strong>{$_("assignedWork.queueCount", { values: { n: secondaryGroups.length } })}</strong>
					</summary>
					<div class="assigned-grid">
						{#each secondaryGroups as group (group.id)}
							<article class={`assigned-card ${groupTone(group)}`}>
								<header>
									<div>
										<span>{groupDisplayLabel(group)}</span>
										<strong>{$_("assignedWork.openCount", { values: { n: group.openCount } })}</strong>
									</div>
									<em>{groupDue(group)}</em>
								</header>
								<div class="signal-strip" aria-label={$_("assignedWork.signalAria", { values: { label: groupDisplayLabel(group) } })}>
									<span>{$_("assignedWork.urgentCount", { values: { n: group.urgentCount } })}</span>
									<span>{$_("assignedWork.highCount", { values: { n: group.highCount } })}</span>
										<span>{$_("assignedWork.reviewCount", { values: { n: group.reviewCount } })}</span>
								</div>
								<div class="task-list">
									{#each group.tasks as task (task.id)}
										<button type="button" class="task-row" onclick={() => onOpenGroup(groupForTask(group, task))}>
											<span>{taskMeta(task)}</span>
											<strong>{taskTitleLabel(task)}</strong>
										</button>
									{/each}
								</div>
								<div class="card-actions">
									<button type="button" onclick={() => onFocusGroup(group)}>{$_("assignedWork.doThisQueue")}</button>
									<button type="button" onclick={() => onOpenGroup(group)}>{groupOpenActionLabel(group)}</button>
								</div>
							</article>
						{/each}
					</div>
				</details>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.assigned-work {
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

	.assigned-tools {
		display: flex;
		min-width: 270px;
		align-items: center;
		justify-content: flex-end;
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

	.assigned-tools input {
		width: min(250px, 27vw);
		min-width: 174px;
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.045);
		color: #e5edf8;
		font-size: 12px;
		font-weight: 760;
		outline: none;
	}

	.assigned-tools input::placeholder {
		color: rgba(190, 204, 220, 0.58);
	}

	.assigned-tools input:focus {
		border-color: rgba(143, 184, 255, 0.58);
		box-shadow: 0 0 0 2px rgba(80, 130, 210, 0.16);
	}

	.assigned-tools button,
	.card-actions button {
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

	.assigned-summary {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
	}

	.assigned-summary span,
	.assigned-summary strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.assigned-summary span {
		color: #8fb8ff;
		font-size: 10px;
		font-weight: 850;
	}

	.assigned-summary strong {
		color: #eef3f8;
		font-size: 12px;
		font-weight: 850;
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

	.assigned-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.assigned-grid.primary {
		grid-template-columns: 1fr;
	}

	.assigned-more {
		display: grid;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
	}

	.assigned-more summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 36px;
		padding: 0 10px;
		cursor: pointer;
		list-style: none;
	}

	.assigned-more summary::-webkit-details-marker {
		display: none;
	}

	.assigned-more:not([open]) > :not(summary) {
		display: none;
	}

	.assigned-more[open] {
		gap: 10px;
		padding-bottom: 10px;
	}

	.assigned-more[open] .assigned-grid {
		width: calc(100% - 20px);
		margin-inline: 10px;
	}

	.assigned-more summary span,
	.assigned-more summary strong {
		font-size: 11px;
		font-weight: 850;
	}

	.assigned-more summary span {
		color: #9fbfff;
	}

	.assigned-more summary strong {
		color: #dfe9f8;
	}

	.assigned-card {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 10px;
		padding: 10px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.03);
	}

	.assigned-card.hot {
		border-color: rgba(255, 139, 124, 0.3);
	}

	.assigned-card.warn {
		border-color: rgba(255, 211, 122, 0.24);
	}

	.assigned-card header {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 10px;
	}

	.assigned-card header > div,
	.task-row {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.assigned-card header span,
	.task-row span,
	.signal-strip span {
		overflow: hidden;
		color: #8fb8ff;
		font-size: 10px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.assigned-card header span,
	.task-row span {
		line-height: 1.2;
		overflow-wrap: anywhere;
		white-space: normal;
	}

	.assigned-card header strong,
	.task-row strong {
		overflow: hidden;
		color: #eef3f8;
		font-size: 12px;
		font-weight: 850;
		text-overflow: ellipsis;
		overflow-wrap: anywhere;
		white-space: normal;
	}

	.assigned-card header em {
		flex: 0 0 auto;
		padding: 3px 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		color: #9aa8b8;
		font-size: 10px;
		font-style: normal;
		font-weight: 850;
		white-space: nowrap;
	}

	.assigned-card.hot header em {
		border-color: rgba(255, 139, 124, 0.38);
		color: #ffb4a8;
	}

	.assigned-card.warn header em {
		border-color: rgba(255, 211, 122, 0.3);
		color: #ffd37a;
	}

	.signal-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.signal-strip span {
		padding: 3px 6px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 999px;
		color: #9aa8b8;
	}

	.task-list {
		display: grid;
		gap: 6px;
	}

	.task-row {
		min-height: 50px;
		padding: 8px;
		border: 1px solid rgba(255, 255, 255, 0.075);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.12);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.task-row:hover {
		border-color: rgba(82, 168, 255, 0.48);
		background: rgba(0, 120, 212, 0.13);
	}

	.card-actions {
		display: flex;
		gap: 7px;
		margin-top: auto;
	}

	.card-actions button {
		flex: 1;
	}

	/* Container-query responsive so the queue adapts to its panel width, not the viewport. */
	@container (max-width: 860px) {
		.assigned-grid {
			grid-template-columns: 1fr;
		}
	}

	@container (max-width: 560px) {
		.section-head,
		.assigned-tools {
			align-items: stretch;
			flex-direction: column;
		}

		.assigned-tools,
		.assigned-tools input {
			width: 100%;
			min-width: 0;
		}

		.assigned-summary {
			align-items: start;
			flex-direction: column;
			gap: 4px;
		}

		.assigned-grid {
			grid-template-columns: 1fr;
		}
	}

	/* Creator-studio owner queue skin (violet / magenta, dark hairline). */
	.assigned-work,
	.assigned-summary,
	.assigned-more,
	.assigned-card,
	.task-row,
	.empty-panel {
		border-color: var(--ws-hair);
		border-radius: 12px;
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 14px 40px -28px rgba(0, 0, 0, 0.9);
	}

	.eyebrow,
	.assigned-summary span,
	.assigned-more summary span,
	.assigned-card header span,
	.task-row span,
	.signal-strip span {
		color: #c4b5fd;
		letter-spacing: 0;
	}

	h2,
	.assigned-summary strong,
	.assigned-more summary strong,
	.assigned-card header strong,
	.task-row strong {
		color: var(--color-ws-ink);
	}

	.empty-panel,
	.assigned-card header em {
		color: var(--color-ws-text);
	}

	.assigned-tools input,
	.assigned-tools button,
	.card-actions button {
		min-height: 42px;
		border-color: var(--ws-hair);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-ink);
	}

	.assigned-tools input {
		background: var(--color-ws-surface);
	}

	.assigned-tools input:focus {
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
	}

	.card-actions button:first-child {
		border-color: transparent;
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, #d946ef 100%);
		box-shadow: 0 8px 24px -10px rgba(217, 70, 239, 0.55);
		color: #fff;
	}

	.task-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		background: var(--color-ws-surface2);
	}

	.assigned-card.hot {
		border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent);
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-ws-rose) 10%, transparent), color-mix(in srgb, var(--color-ws-violet) 4%, transparent)),
			var(--color-ws-surface);
	}

	.assigned-card.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
	}

	.signal-strip span {
		border-color: var(--ws-hair-strong);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-text);
	}
</style>
