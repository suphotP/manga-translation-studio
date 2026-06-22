<!--
AssignReviewPanel — the lead/owner picks a team member + scope and assigns a
review, and sees who is currently assigned. Cancelling an assignment opens the
CancelReviewDialog, which requires a reason and ALWAYS notifies the reviewer.

Reviewer candidates come from the project's workspace membership (the backend
re-validates membership on assign). For a non-workspace / personal project the
owner is the only candidate. Violet ws-* tokens, reuses the shared Dialog atom.
-->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import CancelReviewDialog from "./CancelReviewDialog.svelte";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { getAllWorkspaceMembers, type WorkspaceMemberRecord } from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import type { ReviewAssignment, WorkflowTaskPriority } from "$lib/types.js";

	function msg(key: string, fallback: string, vars?: Record<string, string | number>): string {
		const value = vars ? $_(key, { values: vars }) : $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		open,
		currentPageIndex = 0,
		onClose,
	}: {
		open: boolean;
		currentPageIndex?: number;
		onClose: () => void;
	} = $props();

	type ScopeChoice = "chapter" | "currentPage";

	const project = $derived(projectStore.project);
	const selfUserId = $derived(authStore.user?.id ?? "");
	const assignments = $derived(projectStore.reviewAssignments);
	const activeAssignments = $derived(assignments.filter((a) => a.status !== "cancelled"));
	const busy = $derived(projectStore.reviewAssignmentsLoading);

	let members = $state<WorkspaceMemberRecord[]>([]);
	let membersLoading = $state(false);
	let assigneeUserId = $state("");
	let scope = $state<ScopeChoice>("chapter");
	let priority = $state<WorkflowTaskPriority>("normal");
	let dueAt = $state("");
	let instructions = $state("");

	// Active chapter-team members (invite-by-email/UID collaborators who accepted)
	// who are NOT workspace-level members. The backend grants them scoped work access
	// and now accepts them as review/revision assignees, so they MUST be selectable
	// here too — otherwise an email-invited reviewer could never be handed work.
	const chapterTeamCandidates = $derived(
		(project?.chapterTeam ?? [])
			.filter((m) => m.status === "active" && Boolean(m.userId))
			.map((m) => ({ userId: m.userId!, label: m.displayName || m.email || m.userId!, role: m.role })),
	);
	// Union of workspace members + active chapter-team members, deduped by userId
	// (a workspace member who is also on the chapter roster appears once).
	const assigneeCandidates = $derived.by(() => {
		const seen = new Set<string>();
		const out: Array<{ userId: string; label: string }> = [];
		for (const m of members) {
			if (seen.has(m.userId)) continue;
			seen.add(m.userId);
			out.push({ userId: m.userId, label: `${m.userId} · ${m.memberStudioRole}` });
		}
		for (const m of chapterTeamCandidates) {
			if (seen.has(m.userId)) continue;
			seen.add(m.userId);
			out.push({ userId: m.userId, label: `${m.label} · ${m.role}` });
		}
		return out;
	});

	// Load workspace members when the panel opens (best-effort). Chapter-team
	// candidates come from the already-loaded project state, so a personal Team
	// chapter (no workspace) still surfaces its invited members.
	$effect(() => {
		if (!open) return;
		const workspaceId = project?.workspaceId?.trim();
		if (!workspaceId) {
			members = [];
			if (!assigneeUserId) assigneeUserId = chapterTeamCandidates[0]?.userId ?? selfUserId;
			return;
		}
		membersLoading = true;
		getAllWorkspaceMembers(workspaceId)
			.then((rows) => {
				members = rows.filter((m) => !m.disabledAt);
			})
			.catch(() => { members = []; })
			.finally(() => {
				membersLoading = false;
				if (!assigneeUserId && assigneeCandidates.length > 0) assigneeUserId = assigneeCandidates[0]!.userId;
			});
	});

	const canAssign = $derived(Boolean(assigneeUserId) && !busy);

	async function assign(): Promise<void> {
		if (!canAssign) return;
		const created = await projectStore.assignReview({
			assigneeUserId,
			pageIndexes: scope === "currentPage" ? [currentPageIndex] : undefined,
			priority: priority === "normal" ? undefined : priority,
			dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
			instructions: instructions.trim() || undefined,
		});
		if (created) {
			instructions = "";
			dueAt = "";
		}
	}

	function memberLabel(userId: string): string {
		return assigneeCandidates.find((m) => m.userId === userId)?.label ?? userId;
	}

	function scopeLabel(a: ReviewAssignment): string {
		if (a.pageIndexes && a.pageIndexes.length > 0) {
			return a.pageIndexes.length === 1
				? msg("review.assignScopePage", "Page {n}", { n: a.pageIndexes[0]! + 1 })
				: msg("review.assignScopePages", "{count} pages", { count: a.pageIndexes.length });
		}
		return msg("review.assignScopeChapter", "Whole chapter");
	}

	// Cancel flow.
	let cancelTarget = $state<ReviewAssignment | null>(null);
	let cancelOpen = $state(false);

	function openCancel(a: ReviewAssignment): void {
		cancelTarget = a;
		cancelOpen = true;
	}

	async function confirmCancel(reason: string): Promise<void> {
		if (!cancelTarget) return;
		const result = await projectStore.cancelReviewAssignment(cancelTarget.id, reason);
		if (result) {
			cancelOpen = false;
			cancelTarget = null;
		}
	}
</script>

<Dialog
	{open}
	{onClose}
	size="md"
	busy={busy}
	title={msg("review.assignTitle", "Assign review")}
	description={msg("review.assignDescription", "Hand this review to a team member. Pick the reviewer and scope.")}
>
	<div class="arp-body">
		<section class="arp-form ws-panel-quiet" aria-label={msg("review.assignFormAria", "Assign a reviewer")}>
			<label class="arp-label" for="arp-reviewer">{msg("review.assignReviewer", "Reviewer")}</label>
			{#if membersLoading}
				<p class="arp-muted">{msg("review.assignLoadingMembers", "Loading team…")}</p>
			{:else if project?.workspaceId && assigneeCandidates.length === 0}
				<p class="arp-muted">{msg("review.assignNoMembers", "No team members to assign yet")}</p>
			{:else}
				<select id="arp-reviewer" class="arp-select" bind:value={assigneeUserId} disabled={busy}>
					{#if !project?.workspaceId && assigneeCandidates.length === 0}
						<option value={selfUserId}>{msg("review.assignSelf", "Myself")}</option>
					{/if}
					{#each assigneeCandidates as m (m.userId)}
						<option value={m.userId}>{m.label}</option>
					{/each}
				</select>
			{/if}

			<label class="arp-label" for="arp-scope">{msg("review.assignScope", "Scope")}</label>
			<div id="arp-scope" class="arp-segments ws-panel-quiet" role="group" aria-label={msg("review.assignScope", "Scope")}>
				<button type="button" class="arp-seg ws-seg" class:arp-seg-on={scope === "chapter"} class:ws-seg-on={scope === "chapter"} onclick={() => (scope = "chapter")}>{msg("review.assignScopeChapter", "Whole chapter")}</button>
				<button type="button" class="arp-seg ws-seg" class:arp-seg-on={scope === "currentPage"} class:ws-seg-on={scope === "currentPage"} onclick={() => (scope = "currentPage")}>{msg("review.assignScopeCurrentPage", "Current page ({n})", { n: currentPageIndex + 1 })}</button>
			</div>

			<div class="arp-grid">
				<div>
					<label class="arp-label" for="arp-priority">{msg("review.assignPriority", "Priority")}</label>
					<select id="arp-priority" class="arp-select" bind:value={priority} disabled={busy}>
						<option value="normal">{msg("review.assignPriorityNormal", "Normal")}</option>
						<option value="high">{msg("review.assignPriorityHigh", "High")}</option>
						<option value="urgent">{msg("review.assignPriorityUrgent", "Urgent")}</option>
					</select>
				</div>
				<div>
					<label class="arp-label" for="arp-due">{msg("review.assignDue", "Due date")}</label>
					<input id="arp-due" class="arp-select" type="date" bind:value={dueAt} disabled={busy} />
				</div>
			</div>

			<label class="arp-label" for="arp-instructions">{msg("review.assignInstructions", "Instructions (optional)")}</label>
			<textarea id="arp-instructions" class="arp-textarea" rows="2" bind:value={instructions} disabled={busy} placeholder={msg("review.assignInstructionsPlaceholder", "What should the reviewer focus on?")}></textarea>

			<button type="button" class="ws-dialog-btn ws-dialog-btn-primary arp-assign" disabled={!canAssign} onclick={assign}>
				{busy ? msg("review.decisionSaving", "Saving…") : msg("review.assignSubmit", "Assign review")}
			</button>
		</section>

		<section class="arp-list ws-panel-quiet" aria-label={msg("review.assignCurrentAria", "Current assignments")}>
			<h3 class="arp-list-title">{msg("review.assignCurrent", "Assigned reviewers")}</h3>
			{#if activeAssignments.length === 0}
				<p class="arp-muted">{msg("review.assignNone", "No reviewers assigned yet")}</p>
			{:else}
				<ul class="arp-rows">
					{#each activeAssignments as a (a.id)}
						<li class="arp-row ws-panel-quiet ws-row-hover" data-testid="review-assignment-row">
							<div class="arp-row-main">
								<span class="arp-row-who">{a.assigneeHandle || a.assigneeUserId}</span>
								<span class="arp-row-scope">{scopeLabel(a)} · {a.status}</span>
							</div>
							<button type="button" class="arp-cancel-btn ws-btn-ghost" disabled={busy} onclick={() => openCancel(a)}>
								{msg("review.assignCancelAction", "Cancel")}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</Dialog>

<CancelReviewDialog
	open={cancelOpen}
	assignment={cancelTarget}
	busy={busy}
	onClose={() => { cancelOpen = false; cancelTarget = null; }}
	onConfirm={confirmCancel}
/>

<style>
	.arp-body {
		display: grid;
		gap: 18px;
	}

	.arp-form {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: var(--radius-ws-card, 12px);
	}

	.arp-label {
		font-size: 11px;
		font-weight: 750;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}

	.arp-select,
	.arp-textarea {
		width: 100%;
		min-height: 36px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
	}

	.arp-textarea {
		resize: vertical;
		min-height: 48px;
	}

	.arp-select:focus,
	.arp-textarea:focus {
		outline: none;
		border-color: var(--color-ws-accent);
	}

	.arp-segments {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.arp-seg {
		flex: 1 1 auto;
		min-height: 36px;
		padding: 0 12px;
		border: none;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: transparent;
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
	}

	.arp-seg-on {
		/* scoped base sets background: transparent at higher specificity than the
		   global .ws-seg-on, so the selected fill must live here too */
		background: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		color: var(--color-ws-ink);
	}

	.arp-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.arp-assign {
		margin-top: 6px;
		justify-self: start;
	}

	.arp-list-title {
		margin: 0 0 8px;
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--color-ws-text);
	}

	.arp-list {
		padding: 12px;
		border-radius: var(--radius-ws-card, 12px);
	}

	.arp-muted {
		margin: 0;
		font-size: 13px;
		color: var(--color-ws-text);
		opacity: 0.8;
	}

	.arp-rows {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.arp-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.arp-row-main {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.arp-row-who {
		font-size: 13px;
		font-weight: 750;
		color: var(--color-ws-ink);
	}

	.arp-row-scope {
		font-size: 12px;
		color: var(--color-ws-text);
	}

	.arp-cancel-btn {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 45%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 35%, var(--color-ws-ink));
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}

	.arp-cancel-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-rose) 24%, transparent);
		color: var(--color-ws-ink);
	}

	.arp-cancel-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
