<!--
RevisionSendBackDialog — the reviewer/lead returns work to a WORKER as
"revision #X" with a MANDATORY reason, and sees the running list of revisions.

This is the SEND-BACK counterpart to AssignReviewPanel: a reviewer who finds
problems sends the chapter/page back for rework. The reason is required (the CTA
stays disabled until non-empty) and the backend ALWAYS notifies the assigned
worker (in-app + email) — the send-back can never be silent.

Worker candidates come from the project's workspace membership (the backend
re-validates membership on send-back). For a non-workspace / personal project the
owner is the only candidate. Violet ws-* tokens, reuses the shared Dialog atom.
-->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { getAllWorkspaceMembers, type WorkspaceMemberRecord } from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import type { RevisionRequest, WorkflowTaskPriority } from "$lib/types.js";

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
	const revisions = $derived(projectStore.revisionRequests);
	const busy = $derived(projectStore.revisionRequestsLoading);
	// Next number is server-authoritative; this is a live preview off the current list.
	const nextNumber = $derived(
		revisions.reduce((max, r) => (r.revisionNumber > max ? r.revisionNumber : max), 0) + 1,
	);

	let members = $state<WorkspaceMemberRecord[]>([]);
	let membersLoading = $state(false);
	let assignedToUserId = $state("");
	let scope = $state<ScopeChoice>("currentPage");
	let priority = $state<WorkflowTaskPriority>("normal");
	let dueAt = $state("");
	let reason = $state("");

	// Active chapter-team members (invite-by-email/UID collaborators who accepted)
	// who are NOT workspace-level members. The backend grants them scoped work access
	// and accepts them as revision recipients, so they MUST be selectable here too.
	const chapterTeamCandidates = $derived(
		(project?.chapterTeam ?? [])
			.filter((m) => m.status === "active" && Boolean(m.userId))
			.map((m) => ({ userId: m.userId!, label: m.displayName || m.email || m.userId!, role: m.role })),
	);
	// Union of workspace members + active chapter-team members, deduped by userId.
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

	// Load workspace members when the dialog opens (best-effort). Chapter-team
	// candidates come from the already-loaded project state.
	$effect(() => {
		if (!open) return;
		const workspaceId = project?.workspaceId?.trim();
		if (!workspaceId) {
			members = [];
			if (!assignedToUserId) assignedToUserId = chapterTeamCandidates[0]?.userId ?? selfUserId;
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
				if (!assignedToUserId && assigneeCandidates.length > 0) assignedToUserId = assigneeCandidates[0]!.userId;
			});
	});

	const canSend = $derived(Boolean(assignedToUserId) && reason.trim().length > 0 && !busy);

	async function sendBack(): Promise<void> {
		if (!canSend) return;
		const result = await projectStore.sendBackForRevision({
			assignedToUserId,
			reason: reason.trim(),
			pageIndexes: scope === "currentPage" ? [currentPageIndex] : undefined,
			priority: priority === "normal" ? undefined : priority,
			dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
		});
		if (result) {
			reason = "";
			dueAt = "";
		}
	}

	function memberLabel(userId: string): string {
		return assigneeCandidates.find((m) => m.userId === userId)?.label ?? userId;
	}

	function scopeLabel(r: RevisionRequest): string {
		if (r.pageIndexes && r.pageIndexes.length > 0) {
			return r.pageIndexes.length === 1
				? msg("revision.scopePage", "Page {n}", { n: r.pageIndexes[0]! + 1 })
				: msg("revision.scopePages", "{count} pages", { count: r.pageIndexes.length });
		}
		return msg("revision.scopeChapter", "Whole chapter");
	}

	function statusLabel(status: RevisionRequest["status"]): string {
		switch (status) {
			case "requested": return msg("revision.statusRequested", "Requested");
			case "in_progress": return msg("revision.statusInProgress", "In progress");
			case "resubmitted": return msg("revision.statusResubmitted", "Resubmitted");
			case "accepted": return msg("revision.statusAccepted", "Accepted");
			case "cancelled": return msg("revision.statusCancelled", "Cancelled");
		}
	}

	async function accept(r: RevisionRequest): Promise<void> {
		await projectStore.updateRevisionStatus(r.id, "accepted");
	}
</script>

<Dialog
	{open}
	{onClose}
	size="md"
	busy={busy}
	title={msg("revision.title", "Send back for Revision #{n}", { n: nextNumber })}
	description={msg("revision.description", "Return this work to a team member to fix. A reason is required — they will be notified immediately.")}
>
	<div class="rsb-body">
		<section class="rsb-form ws-panel-quiet" aria-label={msg("revision.formAria", "Send work back for revision")}>
			<label class="rsb-label" for="rsb-worker">{msg("revision.worker", "Send back to")}</label>
			{#if membersLoading}
				<p class="rsb-muted">{msg("revision.loadingMembers", "Loading team…")}</p>
			{:else if project?.workspaceId && assigneeCandidates.length === 0}
				<p class="rsb-muted">{msg("revision.noMembers", "No team members to send back to yet")}</p>
			{:else}
				<select id="rsb-worker" class="rsb-select" bind:value={assignedToUserId} disabled={busy} data-testid="revision-worker">
					{#if !project?.workspaceId && assigneeCandidates.length === 0}
						<option value={selfUserId}>{msg("revision.self", "Myself")}</option>
					{/if}
					{#each assigneeCandidates as m (m.userId)}
						<option value={m.userId}>{m.label}</option>
					{/each}
				</select>
			{/if}

			<label class="rsb-label" for="rsb-scope">{msg("revision.scope", "Scope")}</label>
			<div id="rsb-scope" class="rsb-segments ws-panel-quiet" role="group" aria-label={msg("revision.scope", "Scope")}>
				<button type="button" class="rsb-seg ws-seg" class:rsb-seg-on={scope === "currentPage"} class:ws-seg-on={scope === "currentPage"} onclick={() => (scope = "currentPage")}>{msg("revision.scopeCurrentPage", "Current page ({n})", { n: currentPageIndex + 1 })}</button>
				<button type="button" class="rsb-seg ws-seg" class:rsb-seg-on={scope === "chapter"} class:ws-seg-on={scope === "chapter"} onclick={() => (scope = "chapter")}>{msg("revision.scopeChapter", "Whole chapter")}</button>
			</div>

			<div class="rsb-grid">
				<div>
					<label class="rsb-label" for="rsb-priority">{msg("revision.priority", "Priority")}</label>
					<select id="rsb-priority" class="rsb-select" bind:value={priority} disabled={busy}>
						<option value="normal">{msg("revision.priorityNormal", "Normal")}</option>
						<option value="high">{msg("revision.priorityHigh", "High")}</option>
						<option value="urgent">{msg("revision.priorityUrgent", "Urgent")}</option>
					</select>
				</div>
				<div>
					<label class="rsb-label" for="rsb-due">{msg("revision.due", "Due date")}</label>
					<input id="rsb-due" class="rsb-select" type="date" bind:value={dueAt} disabled={busy} />
				</div>
			</div>

			<label class="rsb-label" for="rsb-reason">{msg("revision.reasonLabel", "Reason (required)")}</label>
			<textarea id="rsb-reason" class="rsb-textarea" rows="3" bind:value={reason} disabled={busy} data-testid="revision-reason" placeholder={msg("revision.reasonPlaceholder", "What needs to be fixed?")}></textarea>
			<p class="rsb-notify">{msg("revision.notifyNotice", "We will notify the assignee in-app and by email.")}</p>

			<button type="button" class="ws-dialog-btn ws-dialog-btn-primary rsb-send" disabled={!canSend} onclick={sendBack} data-testid="revision-send">
				{busy ? msg("revision.sending", "Sending…") : msg("revision.submit", "Send back & notify")}
			</button>
		</section>

		<section class="rsb-list ws-panel-quiet" aria-label={msg("revision.listAria", "Revision history")}>
			<h3 class="rsb-list-title">{msg("revision.listTitle", "Revisions")}</h3>
			{#if revisions.length === 0}
				<p class="rsb-muted">{msg("revision.none", "No revisions yet")}</p>
			{:else}
				<ul class="rsb-rows">
					{#each revisions as r (r.id)}
						<li class="rsb-row ws-panel-quiet ws-row-hover" data-testid="revision-row">
							<div class="rsb-row-main">
								<span class="rsb-row-head">
									<span class="rsb-row-num tabular-nums">#{r.revisionNumber}</span>
									<span class="rsb-row-who">{r.assignedToHandle || r.assignedToUserId}</span>
									<span class={`rsb-row-status rsb-status-${r.status}`}>{statusLabel(r.status)}</span>
								</span>
								<span class="rsb-row-reason">{r.reason}</span>
								<span class="rsb-row-scope">{scopeLabel(r)}</span>
							</div>
							{#if r.status !== "accepted" && r.status !== "cancelled"}
								<button type="button" class="rsb-accept-btn ws-btn-ghost" disabled={busy} onclick={() => accept(r)} data-testid="revision-accept">
									{msg("revision.accept", "Accept")}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</Dialog>

<style>
	.rsb-body {
		display: grid;
		gap: 18px;
	}

	.rsb-form {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: var(--radius-ws-card, 12px);
	}

	.rsb-label {
		font-size: 11px;
		font-weight: 750;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}

	.rsb-select,
	.rsb-textarea {
		width: 100%;
		min-height: 36px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
	}

	.rsb-textarea {
		resize: vertical;
		min-height: 64px;
	}

	.rsb-select:focus,
	.rsb-textarea:focus {
		outline: none;
		border-color: var(--color-ws-accent);
	}

	.rsb-segments {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.rsb-seg {
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

	.rsb-seg-on {
		/* see .arp-seg-on: scoped transparent base beats global .ws-seg-on */
		background: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		color: var(--color-ws-ink);
	}

	.rsb-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.rsb-notify {
		margin: 0;
		font-size: 12px;
		color: var(--color-ws-accent);
	}

	.rsb-send {
		margin-top: 6px;
		justify-self: start;
	}

	.rsb-list-title {
		margin: 0 0 8px;
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--color-ws-text);
	}

	.rsb-list {
		padding: 12px;
		border-radius: var(--radius-ws-card, 12px);
	}

	.rsb-muted {
		margin: 0;
		font-size: 13px;
		color: var(--color-ws-text);
		opacity: 0.8;
	}

	.rsb-rows {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rsb-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.rsb-row-main {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.rsb-row-head {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.rsb-row-num {
		font-size: 13px;
		font-weight: 800;
		color: var(--color-ws-accent);
	}

	.rsb-row-who {
		font-size: 13px;
		font-weight: 750;
		color: var(--color-ws-ink);
	}

	.rsb-row-status {
		font-size: 11px;
		font-weight: 700;
		padding: 1px 7px;
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: var(--color-ws-ink);
	}

	.rsb-status-accepted {
		background: color-mix(in srgb, var(--color-ws-green) 18%, transparent);
		color: color-mix(in srgb, var(--color-ws-green) 35%, var(--color-ws-ink));
	}

	.rsb-status-cancelled {
		background: color-mix(in srgb, var(--color-ws-faint) 18%, transparent);
		opacity: 0.85;
	}

	.rsb-row-reason {
		font-size: 12px;
		color: var(--color-ws-text);
	}

	.rsb-row-scope {
		font-size: 11px;
		color: var(--color-ws-text);
		opacity: 0.75;
	}

	.rsb-accept-btn {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 45%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}

	.rsb-accept-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
	}

	.rsb-accept-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
