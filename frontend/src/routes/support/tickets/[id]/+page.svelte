<!-- /support/tickets/[id] — a single ticket thread.
     Shows the conversation oldest→newest, distinguishing the requester, the AI
     assistant (authorKind="ai"), and human support agents. Lets the owner reply
     (refetches the thread after send — no optimistic insert that could desync)
     and close the ticket. Message + subject bodies render as TEXT, never
     {@html}. The reply endpoint 429s when spammed; the friendly ApiError message
     is surfaced inline + as a toast. -->
<script lang="ts">
	import { onMount, tick } from "svelte";
	import { page } from "$app/state";
	import {
		ApiError,
		closeSupportTicket,
		getSupportTicketThread,
		replyToSupportTicket,
		type SupportTicket,
		type SupportTicketMessage,
	} from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import SupportMessageBubble from "$lib/components/support/SupportMessageBubble.svelte";
	import SupportStatusBadge from "$lib/components/support/SupportStatusBadge.svelte";
	import { categoryLabel } from "$lib/components/support/support-format.ts";

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const BODY_MAX = 10_000;

	let ticketId = $derived(page.params.id ?? "");

	let ticket = $state<SupportTicket | null>(null);
	let messages = $state<SupportTicketMessage[]>([]);
	let loading = $state(true);
	let loadError = $state<{ message: string; notFound: boolean } | null>(null);

	let reply = $state("");
	let sending = $state(false);
	let replyError = $state<string | null>(null);
	let closing = $state(false);

	let threadEl = $state<HTMLElement | null>(null);

	// "closed" and "resolved" both require a reply to reopen — the backend
	// reopens either status to "open" when the customer posts. The close button
	// is hidden in both states; the reply box stays available with a hint.
	let isClosed = $derived(ticket?.status === "closed" || ticket?.status === "resolved");
	let canSend = $derived(reply.trim().length > 0 && !sending);

	onMount(async () => {
		await authStore.init();
		await loadThread(true);
	});

	// `showSkeleton` controls whether the initial skeleton is shown. The FIRST
	// load wants it (there is nothing to show yet); a refresh AFTER a reply must
	// NOT toggle it — otherwise `{#if loading}` tears down the whole thread and
	// re-flashes the skeleton on every send. A refresh just swaps in the new
	// ticket/messages in place, keeping the conversation stable.
	async function loadThread(scroll = false, showSkeleton = true): Promise<void> {
		if (showSkeleton) loading = true;
		loadError = null;
		try {
			const result = await getSupportTicketThread(ticketId);
			ticket = result.ticket;
			messages = result.messages;
			if (scroll) {
				await tick();
				threadEl?.scrollTo({ top: threadEl.scrollHeight });
			}
		} catch (error) {
			const notFound = error instanceof ApiError && error.status === 404;
			loadError = {
				message: notFound
					? t("support.thread.notFoundDetail", "ไม่พบเรื่องนี้ หรือคุณไม่มีสิทธิ์เข้าถึง")
					: describe(error, t("support.thread.loadError", "โหลดเรื่องไม่สำเร็จ")),
				notFound,
			};
		} finally {
			if (showSkeleton) loading = false;
		}
	}

	async function send(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!canSend) return;
		sending = true;
		replyError = null;
		try {
			await replyToSupportTicket(ticketId, reply.trim());
			reply = "";
			// Refetch the full thread rather than optimistically inserting: the
			// backend may flip the ticket status (closed/resolved → open) and the
			// AI agent can append its own reply, so a re-read keeps us authoritative.
			// Refresh WITHOUT the skeleton so the existing thread stays on screen
			// (no jarring re-flash) while the new messages swap in.
			await loadThread(true, false);
		} catch (error) {
			const message = describe(error, t("support.thread.sendError", "ส่งข้อความไม่สำเร็จ"));
			replyError = message;
			if (error instanceof ApiError && error.status === 429) {
				toastsStore.warn({ title: t("support.rateLimit.title", "ส่งบ่อยเกินไป"), body: message });
			} else {
				toastsStore.error({ title: t("support.thread.sendError", "ส่งข้อความไม่สำเร็จ"), body: message });
			}
		} finally {
			sending = false;
		}
	}

	async function close(): Promise<void> {
		if (closing || !ticket || isClosed) return;
		closing = true;
		try {
			const result = await closeSupportTicket(ticketId);
			ticket = result.ticket;
			toastsStore.success({
				title: t("support.close.successTitle", "ปิดเรื่องแล้ว"),
				body: t("support.close.successBody", "ถ้ายังต้องการความช่วยเหลือ ตอบกลับเพื่อเปิดเรื่องอีกครั้งได้"),
			});
		} catch (error) {
			toastsStore.error({
				title: t("support.close.errorTitle", "ปิดเรื่องไม่สำเร็จ"),
				body: describe(error, t("common.retry", "ลองใหม่อีกครั้ง")),
			});
		} finally {
			closing = false;
		}
	}

	function describe(error: unknown, fallback: string): string {
		if (error instanceof ApiError && error.message) return error.message;
		if (error instanceof Error && error.message) return error.message;
		return fallback;
	}
</script>

<svelte:head>
	<title>{ticket ? `${ticket.subject} · Support` : `${t("support.thread.fallbackTitle", "เรื่อง")} · Support`}</title>
</svelte:head>

<main class="thread-page">
	<a class="back-link ws-btn-ghost" href="/support">&lt; {t("support.thread.backToList", "เรื่องทั้งหมด")}</a>

	{#if loading}
		<div class="skeleton" aria-hidden="true">
			<div class="skeleton-head"></div>
			<div class="skeleton-msg"></div>
			<div class="skeleton-msg short"></div>
		</div>
	{:else if loadError}
		<div class="state-error" role="alert">
			<h2>{loadError.notFound ? t("support.thread.notFoundHeading", "ไม่พบเรื่องนี้") : t("common.errorHeading", "เกิดข้อผิดพลาด")}</h2>
			<p>{loadError.message}</p>
			{#if loadError.notFound}
				<a class="ws-dialog-btn ws-btn-ghost" href="/support">{t("support.thread.backToListCta", "กลับไปรายการเรื่อง")}</a>
			{:else}
				<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={() => loadThread(false)}>{t("common.retry", "ลองอีกครั้ง")}</button>
			{/if}
		</div>
	{:else if ticket}
		<header class="thread-head">
			<div class="thread-title">
				<h1>{ticket.subject}</h1>
				<div class="thread-meta">
					<SupportStatusBadge status={ticket.status} size="md" />
					<span class="meta-cat">{categoryLabel(ticket.category, t)}</span>
				</div>
			</div>
			{#if !isClosed}
				<button type="button" class="ws-dialog-btn ws-btn-ghost close-btn" onclick={close} disabled={closing}>
					{closing ? t("support.close.closing", "กำลังปิด…") : t("support.close.button", "ปิดเรื่อง")}
				</button>
			{/if}
		</header>

		<section class="thread ws-panel" bind:this={threadEl} aria-label={t("support.thread.messagesAria", "ข้อความในเรื่องนี้")}>
			{#if messages.length === 0}
				<p class="thread-empty">{t("support.thread.empty", "ยังไม่มีข้อความในเรื่องนี้")}</p>
			{:else}
				{#each messages as message (message.id)}
					<SupportMessageBubble {message} />
				{/each}
			{/if}
		</section>

		{#if isClosed}
			<div class="closed-note" role="status">
				{t("support.thread.closedNote", "เรื่องนี้ปิดแล้ว — ตอบกลับด้านล่างเพื่อเปิดอีกครั้ง")}
			</div>
		{/if}

		<form class="reply-form" onsubmit={send}>
			<label class="sr-only" for="support-reply">{t("support.thread.replyLabel", "ตอบกลับ")}</label>
			<textarea
				id="support-reply"
				bind:value={reply}
				maxlength={BODY_MAX}
				rows="3"
				placeholder={isClosed ? t("support.thread.replyReopenPlaceholder", "ตอบกลับเพื่อเปิดเรื่องนี้อีกครั้ง") : t("support.thread.replyPlaceholder", "พิมพ์ข้อความตอบกลับ")}
				readonly={sending}
			></textarea>
			{#if replyError}
				<p class="form-error" role="alert">{replyError}</p>
			{/if}
			<div class="reply-actions">
				<button type="submit" class="ws-dialog-btn ws-dialog-btn-primary ws-grad-primary" disabled={!canSend}>
					{sending ? t("support.composer.submitting", "กำลังส่ง…") : t("support.thread.sendButton", "ส่งข้อความ")}
				</button>
			</div>
		</form>
	{/if}
</main>

<style>
	.thread-page {
		max-width: 880px;
		margin: 0 auto;
		padding: 24px clamp(16px, 4vw, 56px) 96px;
		display: grid;
		gap: 18px;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		text-decoration: none;
		font-size: 12.5px;
		justify-self: start;
	}
	.back-link:hover {
		color: var(--color-ws-ink);
	}

	.thread-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.thread-title {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.thread-title h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 800;
		line-height: 1.3;
		color: var(--color-ws-ink);
		overflow-wrap: anywhere;
	}
	.thread-meta {
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}
	.meta-cat {
		font-size: 12px;
		color: var(--color-ws-text);
	}
	.close-btn {
		flex: 0 0 auto;
	}

	.thread {
		display: grid;
		gap: 14px;
		max-height: min(58vh, 560px);
		overflow-y: auto;
		padding: 18px;
		border-radius: var(--radius-ws-card);
	}
	.thread-empty {
		margin: 0;
		text-align: center;
		color: var(--color-ws-faint);
		font-size: 13px;
		padding: 24px 0;
	}

	.closed-note {
		padding: 10px 14px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 12.5px;
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface);
		color: var(--color-ws-text);
	}

	.reply-form {
		display: grid;
		gap: 10px;
	}
	.reply-form textarea {
		width: 100%;
		padding: 12px 14px;
		min-height: 72px;
		border-radius: var(--radius-ws-card);
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13.5px;
		line-height: 1.5;
		resize: vertical;
	}
	.reply-form textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
	}
	.form-error {
		margin: 0;
		color: var(--color-ws-rose);
		font-size: 12.5px;
		line-height: 1.4;
	}
	.reply-actions {
		display: flex;
		justify-content: flex-end;
	}

	.state-error {
		display: grid;
		justify-items: center;
		gap: 10px;
		text-align: center;
		padding: 48px 20px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, var(--color-ws-surface));
	}
	.state-error h2 {
		margin: 0;
		font-size: 18px;
	}
	.state-error p {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 13px;
	}

	.skeleton {
		display: grid;
		gap: 14px;
	}
	.skeleton-head {
		height: 32px;
		width: 60%;
		border-radius: var(--radius-ws-ctrl);
	}
	.skeleton-msg {
		height: 56px;
		border-radius: var(--radius-ws-card);
	}
	.skeleton-msg.short {
		width: 70%;
		margin-left: auto;
	}
	.skeleton-head,
	.skeleton-msg {
		background: var(--color-ws-surface2);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.62; }
		50% { opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton-head,
		.skeleton-msg { animation: none; }
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
