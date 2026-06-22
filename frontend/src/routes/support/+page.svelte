<!-- /support — "My tickets" list + new-ticket composer.
     Lists the signed-in user's own support tickets (status, subject, last
     update) and lets them open a new one (subject + message + optional
     category). Honest empty/loading/error states; the create endpoint 429s when
     spammed, surfaced as a friendly toast via the ApiError message. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import {
		ApiError,
		createSupportTicket,
		listSupportTickets,
		SUPPORT_TICKET_CATEGORIES,
		type SupportTicket,
		type SupportTicketCategory,
	} from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import SupportTicketRow from "$lib/components/support/SupportTicketRow.svelte";
	import { categoryLabel } from "$lib/components/support/support-format.ts";

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const SUBJECT_MAX = 200;
	const BODY_MAX = 10_000;

	let tickets = $state<SupportTicket[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let hasMore = $state(false);
	let nextCursor = $state<string | undefined>(undefined);
	let loadingMore = $state(false);

	// New-ticket composer state.
	let composerOpen = $state(false);
	let subject = $state("");
	let body = $state("");
	let category = $state<SupportTicketCategory>("general");
	let submitting = $state(false);
	let formError = $state<string | null>(null);

	let canSubmit = $derived(
		subject.trim().length > 0 && body.trim().length > 0 && !submitting,
	);

	onMount(async () => {
		await authStore.init();
		await loadTickets();
	});

	async function loadTickets(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			const page = await listSupportTickets({ limit: 20 });
			tickets = page.items;
			hasMore = page.hasMore;
			nextCursor = page.nextCursor;
		} catch (error) {
			loadError = describe(error, t("support.list.loadError", "โหลดรายการเรื่องไม่สำเร็จ"));
		} finally {
			loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (loadingMore || !hasMore || !nextCursor) return;
		loadingMore = true;
		try {
			const page = await listSupportTickets({ limit: 20, before: nextCursor });
			tickets = [...tickets, ...page.items];
			hasMore = page.hasMore;
			nextCursor = page.nextCursor;
		} catch (error) {
			toastsStore.error({
				title: t("support.list.loadMoreErrorTitle", "โหลดเพิ่มไม่สำเร็จ"),
				body: describe(error, t("common.retry", "ลองใหม่อีกครั้ง")),
			});
		} finally {
			loadingMore = false;
		}
	}

	function openComposer(): void {
		composerOpen = true;
		formError = null;
	}

	function closeComposer(): void {
		if (submitting) return;
		composerOpen = false;
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!canSubmit) return;
		submitting = true;
		formError = null;
		try {
			const result = await createSupportTicket({
				subject: subject.trim(),
				body: body.trim(),
				category,
			});
			toastsStore.success({
				title: t("support.create.successTitle", "เปิดเรื่องเรียบร้อย"),
				body: t("support.create.successBody", "ทีมซัพพอร์ตได้รับเรื่องของคุณแล้ว"),
			});
			// Reset + navigate to the new thread.
			subject = "";
			body = "";
			category = "general";
			composerOpen = false;
			await goto(`/support/tickets/${result.ticket.id}`);
		} catch (error) {
			// The create endpoint 429s when spammed — ApiError.message already carries
			// a friendly "ส่งคำขอถี่เกินไป" message, so we surface it directly.
			const message = describe(error, t("support.create.errorRetry", "เปิดเรื่องไม่สำเร็จ ลองใหม่อีกครั้ง"));
			formError = message;
			if (error instanceof ApiError && error.status === 429) {
				toastsStore.warn({ title: t("support.rateLimit.title", "ส่งบ่อยเกินไป"), body: message });
			} else {
				toastsStore.error({ title: t("support.create.errorTitle", "เปิดเรื่องไม่สำเร็จ"), body: message });
			}
		} finally {
			submitting = false;
		}
	}

	function describe(error: unknown, fallback: string): string {
		if (error instanceof ApiError && error.message) return error.message;
		if (error instanceof Error && error.message) return error.message;
		return fallback;
	}
</script>

<svelte:head>
	<title>{t("support.list.title", "เรื่องที่ฉันแจ้ง")} · Support</title>
</svelte:head>

<main class="support-page">
	<header class="support-head">
		<div>
			<p class="eyebrow">Support · {t("support.list.title", "เรื่องที่ฉันแจ้ง")}</p>
			<h1>{t("support.list.heading", "ศูนย์ช่วยเหลือ")}</h1>
			<p class="lede">{t("support.list.lede", "เปิดเรื่องเพื่อสอบถามทีมงาน ติดตามสถานะ และดูคำตอบจากผู้ช่วย AI หรือทีมซัพพอร์ตได้ที่นี่")}</p>
		</div>
		<button type="button" class="ws-dialog-btn ws-dialog-btn-primary ws-grad-primary new-btn" onclick={openComposer}>
			{t("support.list.newButton", "+ เปิดเรื่องใหม่")}
		</button>
	</header>

	{#if composerOpen}
		<section class="composer ws-panel" aria-label={t("support.composer.title", "เปิดเรื่องใหม่")}>
			<header class="composer-head">
				<h2>{t("support.composer.title", "เปิดเรื่องใหม่")}</h2>
				<button type="button" class="composer-close ws-btn-ghost" onclick={closeComposer} disabled={submitting} aria-label={t("support.composer.closeAria", "ปิดฟอร์ม")}>
					✕
				</button>
			</header>
			<form class="composer-form" onsubmit={submit}>
				<label class="field">
					<span class="field-label">{t("support.composer.subjectLabel", "หัวข้อ")}</span>
					<input
						bind:value={subject}
						maxlength={SUBJECT_MAX}
						placeholder={t("support.composer.subjectPlaceholder", "สรุปปัญหาสั้น ๆ เช่น 'อัปโหลดหน้าไม่ขึ้น'")}
						required
						readonly={submitting}
					/>
				</label>
				<label class="field">
					<span class="field-label">{t("support.composer.categoryLabel", "หมวดหมู่")}</span>
					<select bind:value={category} disabled={submitting}>
						{#each SUPPORT_TICKET_CATEGORIES as cat (cat)}
							<option value={cat}>{categoryLabel(cat, t)}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					<span class="field-label">{t("support.composer.bodyLabel", "รายละเอียด")}</span>
					<textarea
						bind:value={body}
						maxlength={BODY_MAX}
						rows="5"
						placeholder={t("support.composer.bodyPlaceholder", "อธิบายปัญหา ขั้นตอนที่ทำ และสิ่งที่คาดหวัง")}
						required
						readonly={submitting}
					></textarea>
				</label>
				{#if formError}
					<p class="form-error" role="alert">{formError}</p>
				{/if}
				<div class="composer-actions">
					<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={closeComposer} disabled={submitting}>{t("common.cancel", "ยกเลิก")}</button>
					<button type="submit" class="ws-dialog-btn ws-dialog-btn-primary ws-grad-primary" disabled={!canSubmit}>
						{submitting ? t("support.composer.submitting", "กำลังส่ง…") : t("support.composer.submit", "ส่งเรื่อง")}
					</button>
				</div>
			</form>
		</section>
	{/if}

	<section class="ticket-list" aria-label={t("support.list.title", "เรื่องที่ฉันแจ้ง")}>
		{#if loading}
			<div class="skeleton-list" aria-hidden="true">
				{#each Array(3) as _, i (i)}
					<div class="skeleton-row"></div>
				{/each}
			</div>
		{:else if loadError}
			<div class="state-error" role="alert">
				<p>{loadError}</p>
				<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={loadTickets}>{t("common.retry", "ลองอีกครั้ง")}</button>
			</div>
		{:else if tickets.length === 0}
			<!-- Only show the empty-state card when the composer is closed: while it's
			     open it IS the active create entry point, so a second "open your first
			     ticket" CTA below would be a redundant duplicate. -->
			{#if !composerOpen}
				<div class="state-empty">
					<h3>{t("support.empty.heading", "ยังไม่มีเรื่องที่แจ้ง")}</h3>
					<p>{t("support.empty.body", "เมื่อคุณเปิดเรื่อง รายการและสถานะจะแสดงที่นี่")}</p>
					<button type="button" class="ws-dialog-btn ws-dialog-btn-primary ws-grad-primary" onclick={openComposer}>{t("support.empty.cta", "เปิดเรื่องแรก")}</button>
				</div>
			{/if}
		{:else}
			<div class="rows">
				{#each tickets as ticket (ticket.id)}
					<SupportTicketRow {ticket} />
				{/each}
			</div>
			{#if hasMore}
				<button type="button" class="ws-dialog-btn ws-btn-ghost load-more" onclick={loadMore} disabled={loadingMore}>
					{loadingMore ? t("support.list.loadingMore", "กำลังโหลด…") : t("support.list.loadMore", "โหลดเพิ่ม")}
				</button>
			{/if}
		{/if}
	</section>
</main>

<style>
	.support-page {
		max-width: 880px;
		margin: 0 auto;
		padding: 36px clamp(16px, 4vw, 56px) 96px;
		display: grid;
		gap: 24px;
	}
	.support-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.eyebrow {
		text-transform: uppercase;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 800;
		margin: 0 0 6px;
	}
	.support-head h1 {
		margin: 0 0 6px;
		font-size: 28px;
		font-weight: 800;
		color: var(--color-ws-ink);
	}
	.lede {
		margin: 0;
		max-width: 52ch;
		color: var(--color-ws-text);
		font-size: 13.5px;
		line-height: 1.5;
	}
	.new-btn {
		flex: 0 0 auto;
	}

	.composer {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 6%, var(--color-ws-surface));
		border-radius: var(--radius-ws-card);
		padding: 20px;
		display: grid;
		gap: 16px;
	}
	.composer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.composer-head h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 800;
		color: var(--color-ws-ink);
	}
	.composer-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		min-height: 36px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
	}
	.composer-close:hover:not(:disabled) {
		color: var(--color-ws-ink);
	}
	.composer-form {
		display: grid;
		gap: 14px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field-label {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}
	.field input,
	.field select,
	.field textarea {
		width: 100%;
		padding: 10px 12px;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13.5px;
	}
	.field textarea {
		resize: vertical;
		min-height: 96px;
		line-height: 1.5;
	}
	.field input:focus,
	.field select:focus,
	.field textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
	}
	.form-error {
		margin: 0;
		color: var(--color-ws-rose);
		font-size: 12.5px;
		line-height: 1.4;
	}
	.composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	.ticket-list {
		display: grid;
		gap: 14px;
	}
	.rows {
		display: grid;
		gap: 10px;
	}
	.load-more {
		justify-self: center;
	}

	.skeleton-list {
		display: grid;
		gap: 10px;
	}
	.skeleton-row {
		height: 60px;
		border-radius: var(--radius-ws-card);
		border: 1px solid var(--ws-hair);
		background: var(--color-ws-surface2);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.62; }
		50% { opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton-row { animation: none; }
	}

	.state-empty,
	.state-error {
		display: grid;
		justify-items: center;
		gap: 10px;
		text-align: center;
		padding: 40px 20px;
		border-radius: var(--radius-ws-card);
		border: 1px dashed var(--ws-hair-strong);
		background: var(--color-ws-surface);
	}
	.state-empty h3 {
		margin: 0;
		font-size: 16px;
	}
	.state-empty p,
	.state-error p {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 13px;
	}
	.state-error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, var(--color-ws-surface));
	}
	.state-error p {
		color: var(--color-ws-rose);
	}
</style>
