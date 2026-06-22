<!-- SupportAgentConsole — MINIMAL staff ticket-management surface (a16 #6).

     Wires the staff /api/support/agent/* client (RBAC: SUPPORT_READ to view,
     SUPPORT_ADJUST to act). Lists the inbox, opens the FULL thread (internal
     notes INCLUDED — this is the staff view), and exposes the core staff actions:
     reply (customer-visible), internal note (staff-only), assign, escalate,
     resolve, close.

     SCOPE NOTE: this is a deliberately minimal management console to close the
     "backend API exists, no frontend client/UI" gap. A polished inbox (filters,
     queues, presence, SLA, bulk actions, full localization) is net-new product —
     see QUESTIONS in the PR. All message bodies render as TEXT (auto-escaped);
     internal notes are visually marked so staff never confuse them with a
     customer-visible reply. -->
<script lang="ts">
	import {
		listStaffSupportTickets,
		getStaffSupportTicketThread,
		replyStaffSupportTicket,
		addStaffSupportInternalNote,
		assignStaffSupportTicket,
		escalateStaffSupportTicket,
		resolveStaffSupportTicket,
		closeStaffSupportTicket,
		type SupportTicket,
		type StaffSupportTicketMessage,
	} from "$lib/api/client.ts";
	import SupportStatusBadge from "./SupportStatusBadge.svelte";
	import { formatRelative } from "./support-format.ts";

	let tickets = $state<SupportTicket[]>([]);
	let loadingList = $state(false);
	let listError = $state<string | null>(null);

	let selectedId = $state<string | null>(null);
	let selectedTicket = $state<SupportTicket | null>(null);
	let messages = $state<StaffSupportTicketMessage[]>([]);
	let loadingThread = $state(false);
	let threadError = $state<string | null>(null);

	let replyText = $state("");
	let noteText = $state("");
	let assigneeText = $state("");
	let departmentText = $state("");
	let busy = $state(false);
	let actionError = $state<string | null>(null);

	function describe(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	async function loadList(): Promise<void> {
		loadingList = true;
		listError = null;
		try {
			const page = await listStaffSupportTickets({ limit: 50 });
			tickets = page.items;
		} catch (err) {
			listError = describe(err);
		} finally {
			loadingList = false;
		}
	}

	async function openTicket(id: string): Promise<void> {
		selectedId = id;
		loadingThread = true;
		threadError = null;
		actionError = null;
		try {
			const thread = await getStaffSupportTicketThread(id);
			selectedTicket = thread.ticket;
			messages = thread.messages;
		} catch (err) {
			threadError = describe(err);
		} finally {
			loadingThread = false;
		}
	}

	async function refreshAfterAction(): Promise<void> {
		if (selectedId) await openTicket(selectedId);
		await loadList();
	}

	async function run(action: () => Promise<unknown>): Promise<void> {
		busy = true;
		actionError = null;
		try {
			await action();
			await refreshAfterAction();
		} catch (err) {
			actionError = describe(err);
		} finally {
			busy = false;
		}
	}

	async function sendReply(): Promise<void> {
		const body = replyText.trim();
		if (!selectedId || !body) return;
		await run(() => replyStaffSupportTicket(selectedId!, body));
		replyText = "";
	}

	async function sendNote(): Promise<void> {
		const body = noteText.trim();
		if (!selectedId || !body) return;
		await run(() => addStaffSupportInternalNote(selectedId!, body));
		noteText = "";
	}

	async function assign(): Promise<void> {
		if (!selectedId) return;
		await run(() => assignStaffSupportTicket(selectedId!, { assigneeUserId: assigneeText.trim() }));
		assigneeText = "";
	}

	async function escalate(): Promise<void> {
		const department = departmentText.trim();
		if (!selectedId || !department) return;
		await run(() => escalateStaffSupportTicket(selectedId!, { department }));
		departmentText = "";
	}

	async function resolve(): Promise<void> {
		if (!selectedId) return;
		await run(() => resolveStaffSupportTicket(selectedId!));
	}

	async function close(): Promise<void> {
		if (!selectedId) return;
		await run(() => closeStaffSupportTicket(selectedId!));
	}

	$effect(() => {
		void loadList();
	});
</script>

<section class="console">
	<aside class="inbox">
		<header class="inbox-head">
			<h2>Support inbox</h2>
			<button type="button" onclick={() => void loadList()} disabled={loadingList}>Refresh</button>
		</header>
		{#if listError}
			<p class="err">{listError}</p>
		{:else if loadingList && tickets.length === 0}
			<p class="muted">Loading…</p>
		{:else if tickets.length === 0}
			<p class="muted">No tickets.</p>
		{:else}
			<ul class="ticket-list">
				{#each tickets as ticket (ticket.id)}
					<li>
						<button
							type="button"
							class="ticket-btn"
							class:active={ticket.id === selectedId}
							onclick={() => void openTicket(ticket.id)}
						>
							<span class="subject">{ticket.subject}</span>
							<span class="row-meta">
								<SupportStatusBadge status={ticket.status} />
								<time datetime={ticket.updatedAt}>{formatRelative(ticket.updatedAt)}</time>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</aside>

	<div class="thread-pane">
		{#if !selectedId}
			<p class="muted center">Select a ticket to manage it.</p>
		{:else if threadError}
			<p class="err">{threadError}</p>
		{:else if loadingThread && messages.length === 0}
			<p class="muted">Loading thread…</p>
		{:else if selectedTicket}
			<header class="thread-head">
				<div>
					<h3>{selectedTicket.subject}</h3>
					<span class="muted small">{selectedTicket.category} · {selectedTicket.id}</span>
				</div>
				<SupportStatusBadge status={selectedTicket.status} />
			</header>

			<div class="messages">
				{#each messages as message (message.id)}
					<article class="msg" data-kind={message.authorKind} class:internal={message.authorKind === "internal"}>
						<header>
							<strong>{message.authorKind}</strong>
							{#if message.authorKind === "internal"}<span class="tag">staff-only</span>{/if}
							<time datetime={message.createdAt}>{formatRelative(message.createdAt)}</time>
						</header>
						<!-- TEXT only (auto-escaped); pre-wrap keeps line breaks. -->
						<p class="body">{message.body}</p>
					</article>
				{/each}
			</div>

			{#if actionError}<p class="err">{actionError}</p>{/if}

			<div class="actions">
				<label class="field">
					<span>Reply to customer</span>
					<textarea bind:value={replyText} rows="2" placeholder="Customer-visible reply"></textarea>
					<button type="button" onclick={() => void sendReply()} disabled={busy || !replyText.trim()}>Send reply</button>
				</label>

				<label class="field">
					<span>Internal note (staff only)</span>
					<textarea bind:value={noteText} rows="2" placeholder="Never shown to the customer"></textarea>
					<button type="button" onclick={() => void sendNote()} disabled={busy || !noteText.trim()}>Add note</button>
				</label>

				<div class="row">
					<input bind:value={assigneeText} placeholder="Assignee user id" />
					<button type="button" onclick={() => void assign()} disabled={busy}>Assign</button>
				</div>

				<div class="row">
					<input bind:value={departmentText} placeholder="Escalate to department" />
					<button type="button" onclick={() => void escalate()} disabled={busy || !departmentText.trim()}>Escalate</button>
				</div>

				<div class="row">
					<button type="button" onclick={() => void resolve()} disabled={busy}>Resolve</button>
					<button type="button" onclick={() => void close()} disabled={busy}>Close</button>
				</div>
			</div>
		{/if}
	</div>
</section>

<style>
	.console {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		gap: 16px;
		align-items: start;
	}
	.inbox-head,
	.thread-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.ticket-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.ticket-btn {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		cursor: pointer;
		color: inherit;
	}
	.ticket-btn.active {
		border-color: rgba(124, 92, 255, 0.5);
		background: rgba(124, 92, 255, 0.12);
	}
	.subject {
		font-weight: 600;
	}
	.row-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--color-ws-faint, #6b6b78);
	}
	.messages {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 12px 0;
	}
	.msg {
		padding: 8px 12px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
	}
	.msg.internal {
		border-style: dashed;
		border-color: rgba(245, 158, 11, 0.5);
		background: rgba(245, 158, 11, 0.08);
	}
	.msg header {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11px;
		margin-bottom: 4px;
	}
	.msg time {
		margin-left: auto;
		color: var(--color-ws-faint, #6b6b78);
	}
	.tag {
		font-size: 9px;
		font-weight: 800;
		text-transform: uppercase;
		padding: 1px 6px;
		border-radius: 9999px;
		border: 1px solid rgba(245, 158, 11, 0.6);
		color: #fcd34d;
	}
	.body {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
	}
	.row {
		display: flex;
		gap: 8px;
	}
	textarea,
	input {
		width: 100%;
		box-sizing: border-box;
	}
	.muted {
		color: var(--color-ws-faint, #6b6b78);
	}
	.small {
		font-size: 11px;
	}
	.center {
		text-align: center;
		padding: 24px 0;
	}
	.err {
		color: #fca5a5;
	}
</style>
