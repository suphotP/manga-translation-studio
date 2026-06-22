<!-- SupportTicketRow — one ticket in the "my tickets" list. Links to the thread.
     Shows subject, status badge, category, and last-update time. Subject is
     rendered as TEXT (auto-escaped) since it is user-supplied. -->
<script lang="ts">
	import type { SupportTicket } from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import SupportStatusBadge from "./SupportStatusBadge.svelte";
	import { categoryLabel, formatAbsolute, formatRelative } from "./support-format.ts";

	let { ticket }: { ticket: SupportTicket } = $props();

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<a class="ticket-row" href={`/support/tickets/${ticket.id}`} aria-label={`${t("support.row.openAria", "เปิดเรื่อง")}: ${ticket.subject}`}>
	<div class="ticket-main">
		<span class="ticket-subject">{ticket.subject}</span>
		<span class="ticket-meta">
			<span class="ticket-cat">{categoryLabel(ticket.category, t)}</span>
			<span aria-hidden="true">·</span>
			<time datetime={ticket.updatedAt} title={formatAbsolute(ticket.updatedAt)}>
				{t("support.row.updatedPrefix", "อัปเดต")} {formatRelative(ticket.updatedAt, Date.now(), t)}
			</time>
		</span>
	</div>
	<SupportStatusBadge status={ticket.status} />
</a>

<style>
	.ticket-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		text-decoration: none;
		color: inherit;
		transition: border-color 0.14s ease, background 0.14s ease;
	}
	.ticket-row:hover {
		border-color: rgba(124, 92, 255, 0.4);
		background: rgba(124, 92, 255, 0.07);
	}
	.ticket-main {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.ticket-subject {
		font-size: 14px;
		font-weight: 700;
		color: var(--color-ws-ink, #ececf2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ticket-meta {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		font-size: 11.5px;
		color: var(--color-ws-faint, #6b6b78);
	}
	.ticket-cat {
		color: var(--color-ws-text, #9a9aa8);
	}
</style>
