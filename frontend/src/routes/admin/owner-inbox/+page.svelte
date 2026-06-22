<!--
OWNER OPS inbox — "the owner talks to the bot, approves cases" (OWNER-ONLY).

This is the make-or-break surface of the autonomous-support model: the support AI
auto-resolves what it safely can, and routes every money/account case it CANNOT
auto-resolve (refund / over-cap grant / ambiguous / velocity / circuit) to the
OWNER for a one-tap decision. This page is that queue.

Each case is a CARD showing, at a glance:
  * the customer (user id + ticket),
  * WHY it was escalated (a friendly reason from the gate's machine code),
  * the bot's recommendation (advisory),
  * the SERVER-VERIFIED evidence the decision is based on (verified discrepancy,
    whether a real payment exists) — this is what the owner can trust, computed in
    code from the customer's OWN payments, never the customer's words,
  * the proposed action + amount,
  * ONE-TAP Approve / Deny, and Modify (override the amount before approving).

Talks to /api/admin/support/owner/* via adminOwnerDecisionsApi. Owner-only is
enforced server-side (admin:roles.write); this page is also only reachable via the
owner-gated nav section. After every decision we REFETCH the queue so the list is
always the server's truth (optimistic-safe). Errors are friendly + inline.

MOBILE-FIRST: the owner approves from their phone. The layout is a single column of
full-width cards; action buttons are large, tap-friendly, and wrap; everything reads
top-to-bottom with no horizontal scroll.

Money is rendered EXACTLY per-currency via the revenue page's money.ts (integer
cents, ISO-4217 minor units, no float). Styling mirrors the rest of /admin
(support/revenue): self-contained dark-shell tokens, reusing the shared ws Dialog.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import {
		adminOwnerDecisionsApi,
		getAdminMe,
		AdminApiError,
		type OwnerDecision,
	} from "$lib/api/admin.ts";
	import { formatMoney } from "../revenue/money.ts";
	import { centsToMajorInput, majorInputToCents } from "./money-input.ts";

	// Owner-only permission (same code as the backend ROLES_WRITE gate). Read once
	// from /admin/me so a non-owner who somehow lands here sees an honest panel
	// instead of failing fetches. The backend stays authoritative regardless.
	const ROLES_WRITE = "admin:roles.write";

	// ── State ──────────────────────────────────────────────────────
	let isOwner = $state(false);
	let permsLoaded = $state(false);

	let cases = $state<OwnerDecision[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	// Per-case in-flight guard so a double-tap can't fire two decisions.
	let busyId = $state<string | null>(null);

	// Modify modal state.
	let modifyTarget = $state<OwnerDecision | null>(null);
	let modifyAmountMajor = $state(""); // major units the owner types (e.g. "19.99")
	let modifyReason = $state("");
	let modifyError = $state<string | null>(null);
	let modifyBusy = $state(false);

	// ── Toast ──────────────────────────────────────────────────────
	let toast = $state<{ kind: "ok" | "error"; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	function notify(kind: "ok" | "error", text: string): void {
		toast = { kind, text };
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast = null;
		}, 6000);
	}

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) {
			if (cause.status === 403) return "บัญชีนี้ไม่มีสิทธิ์ (owner เท่านั้น)";
			if (cause.status === 404) return "ไม่พบเคสนี้ (อาจถูกจัดการไปแล้ว)";
			return cause.message || `Admin API ${cause.status}`;
		}
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	// ── Load ───────────────────────────────────────────────────────
	async function loadPerms() {
		try {
			const me = await getAdminMe();
			isOwner = me.permissions.includes(ROLES_WRITE);
		} catch {
			isOwner = false;
		} finally {
			permsLoaded = true;
		}
	}

	async function refresh() {
		loading = true;
		loadError = null;
		try {
			const result = await adminOwnerDecisionsApi.listPending(100);
			cases = result.decisions ?? [];
		} catch (cause) {
			cases = [];
			loadError = describeError(cause);
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await loadPerms();
		if (isOwner) await refresh();
		else loading = false;
	});

	// ── Action-type honesty helpers ───────────────────────────────
	// grant_credit executes immediately on approve; refund/plan_change only record
	// the owner's decision — execution happens via the dedicated Support console routes.
	function actionExecutesOnApprove(action: string): boolean {
		return action === "grant_credit";
	}

	// Toast copy after a straight approve (no modify), broken out by action type.
	function approveToastText(action: string, executedRef: string | null | undefined): string {
		if (actionExecutesOnApprove(action)) {
			return executedRef
				? "อนุมัติแล้ว · เครดิตโอนเรียบร้อย"
				: "อนุมัติแล้ว · เครดิตจะถูกโอนในไม่ช้า";
		}
		// refund / plan_change: approval RECORDS the decision; real execution happens
		// via the REFUND_WRITE / SUPPORT_ADJUST routes in the Support console.
		return "บันทึกการอนุมัติแล้ว · กรุณาดำเนินการต่อใน Support console";
	}

	// Toast copy after a modify-then-approve, broken out by action type.
	function modifyToastText(action: string, executedRef: string | null | undefined): string {
		if (actionExecutesOnApprove(action)) {
			return executedRef
				? "อนุมัติด้วยยอดใหม่แล้ว · เครดิตโอนเรียบร้อย"
				: "อนุมัติด้วยยอดใหม่แล้ว · เครดิตจะถูกโอนในไม่ช้า";
		}
		return "บันทึกการอนุมัติ (ยอดใหม่) แล้ว · กรุณาดำเนินการต่อใน Support console";
	}

	// Dialog description for the modify modal — accurate per action type.
	function modifyDialogDescription(action: string | undefined): string {
		if (!action) return "";
		if (actionExecutesOnApprove(action)) {
			return "เปลี่ยนยอดที่จะอนุมัติให้ลูกค้า แล้วระบบจะโอนเครดิตตามยอดใหม่ทันที";
		}
		// refund / plan_change
		return "เปลี่ยนยอดแล้วบันทึกการอนุมัติ — การคืนเงิน/เปลี่ยนแพ็กเกจจริงต้องดำเนินการต่อใน Support console";
	}

	// Confirm-button label inside the modify dialog.
	function modifyConfirmLabel(action: string | undefined, busy: boolean): string {
		if (busy) return "กำลังบันทึก…";
		if (!action) return "อนุมัติด้วยยอดใหม่";
		return actionExecutesOnApprove(action) ? "อนุมัติ · โอนเครดิตทันที" : "บันทึกการอนุมัติ";
	}

	// ── Decisions ──────────────────────────────────────────────────
	async function approve(c: OwnerDecision) {
		if (busyId) return;
		busyId = c.id;
		try {
			const res = await adminOwnerDecisionsApi.approve(c.id);
			if (res.alreadySettled) {
				notify("ok", "เคสนี้ถูกจัดการไปแล้ว — รีเฟรชรายการให้แล้ว");
			} else {
				notify("ok", approveToastText(c.action, res.executedRef));
			}
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			busyId = null;
			// REFETCH so the list reflects the server's truth (the approved case leaves).
			await refresh();
		}
	}

	async function deny(c: OwnerDecision) {
		if (busyId) return;
		busyId = c.id;
		try {
			const res = await adminOwnerDecisionsApi.deny(c.id);
			notify("ok", res.alreadySettled ? "เคสนี้ถูกจัดการไปแล้ว" : "ปฏิเสธแล้ว (ไม่มีการตัดเงิน)");
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			busyId = null;
			await refresh();
		}
	}

	function openModify(c: OwnerDecision) {
		modifyTarget = c;
		modifyError = null;
		modifyReason = "";
		// Pre-fill with the proposed amount in MAJOR units for the currency so the
		// owner edits a familiar figure (e.g. "19.99"), not raw cents.
		modifyAmountMajor = centsToMajorInput(c.amountCents, c.currency);
	}

	const modifyValid = $derived.by(() => {
		const cents = majorInputToCents(modifyAmountMajor, modifyTarget?.currency ?? null);
		return cents !== null && cents >= 1;
	});

	async function submitModify() {
		const target = modifyTarget;
		if (!target || !modifyValid || modifyBusy) return;
		const cents = majorInputToCents(modifyAmountMajor, target.currency);
		if (cents === null || cents < 1) {
			modifyError = "จำนวนเงินไม่ถูกต้อง";
			return;
		}
		modifyBusy = true;
		modifyError = null;
		try {
			const res = await adminOwnerDecisionsApi.modify(target.id, {
				amountCents: cents,
				reason: modifyReason.trim() || undefined,
			});
			const settledAction = target.action;
			modifyTarget = null;
			notify(
				"ok",
				res.alreadySettled
					? "เคสนี้ถูกจัดการไปแล้ว"
					: modifyToastText(settledAction, res.executedRef),
			);
			await refresh();
		} catch (cause) {
			modifyError = describeError(cause);
		} finally {
			modifyBusy = false;
		}
	}

	// ── Money helpers (per-currency, integer cents; reuse money.ts) ─
	// Exact per-currency DISPLAY string from integer cents.
	function fmtCents(cents: number, currency: string | null | undefined): string {
		return formatMoney(String(Math.trunc(cents)), currency ?? "");
	}
	// centsToMajorInput / majorInputToCents live in ./money-input.ts (unit-tested).

	function fmtDateTime(value: string | null | undefined): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
	}

	// ── Presentation maps ──────────────────────────────────────────
	const ACTION_LABEL: Record<string, string> = {
		grant_credit: "ให้เครดิตชดเชย",
		refund: "คืนเงิน",
		plan_change: "เปลี่ยนแพ็กเกจ",
		resend_verification: "ส่งอีเมลยืนยันใหม่",
		password_reset_link: "ลิงก์รีเซ็ตรหัสผ่าน",
		other: "อื่น ๆ",
	};

	function actionLabel(action: string): string {
		return ACTION_LABEL[action] ?? action.replace(/_/g, " ");
	}

	// WHY this case was escalated — a friendly line from the gate's stable machine
	// reason code. Covers the cap / refund / ambiguous / velocity / circuit cases.
	function escalationReason(reason: string | null): string {
		switch (reason) {
			case "owner_refund":
				return "เป็นการคืนเงิน (เงินออก) — ต้องให้เจ้าของอนุมัติเสมอ";
			case "owner_plan_change":
				return "เป็นการเปลี่ยนแพ็กเกจ — ต้องให้เจ้าของอนุมัติเสมอ";
			case "owner_grant_over_cap":
				return "ยอดเครดิตเกินวงเงินที่บอทอนุมัติเองได้";
			case "owner_grant_not_exact_discrepancy":
				return "ยอดที่ขอไม่ตรงกับส่วนต่างที่ตรวจสอบได้ — ต้องให้เจ้าของตัดสิน";
			case "owner_velocity_day":
				return "ลูกค้าถึงเพดานการให้เครดิตอัตโนมัติต่อวันแล้ว";
			case "owner_velocity_month":
				return "ลูกค้าถึงเพดานการให้เครดิตอัตโนมัติต่อเดือนแล้ว";
			case "owner_circuit_tripped":
				return "ระบบให้เครดิตอัตโนมัติแตะเพดานรวม — กันความเสี่ยงไว้ให้เจ้าของตรวจ";
			case "owner_ambiguous":
				return "บอทไม่มั่นใจพอจะตัดสินเอง — ส่งให้เจ้าของพิจารณา";
			default:
				return "ต้องให้เจ้าของพิจารณา";
		}
	}

	// A short tag (for the badge chip) summarizing the escalation category.
	function escalationTag(reason: string | null): string {
		if (!reason) return "review";
		if (reason === "owner_refund") return "refund";
		if (reason === "owner_plan_change") return "plan";
		if (reason.startsWith("owner_grant")) return "cap";
		if (reason.startsWith("owner_velocity")) return "velocity";
		if (reason === "owner_circuit_tripped") return "circuit";
		if (reason === "owner_ambiguous") return "ambiguous";
		return "review";
	}

	function evidenceDiscrepancy(c: OwnerDecision): number {
		const v = c.evidence?.verifiedDiscrepancyCents;
		return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
	}
</script>

<svelte:head>
	<title>Owner Inbox · Comic Workspace</title>
</svelte:head>

<header class="page-head">
	<div>
		<h1>Owner Inbox</h1>
		<p class="page-sub">เคสที่บอทส่งให้คุณตัดสิน — แตะอนุมัติ / ปฏิเสธ / แก้ยอด ได้ในแตะเดียว</p>
	</div>
	<div class="head-actions">
		{#if isOwner && !loading}
			<span class="count-pill" aria-label="จำนวนเคสที่รอ">{cases.length} รอตัดสิน</span>
		{/if}
		<button type="button" class="btn ws-btn-ghost" onclick={() => void refresh()} disabled={loading || !isOwner}>
			{loading ? "กำลังโหลด…" : "รีเฟรช"}
		</button>
	</div>
</header>

{#if !permsLoaded}
	<div class="card ws-panel skel" aria-busy="true">กำลังตรวจสิทธิ์…</div>
{:else if !isOwner}
	<!-- Owner-only: an honest panel if a non-owner reaches here (backend also 403s). -->
	<section class="card ws-panel denied">
		<strong>หน้านี้สำหรับเจ้าของ (owner) เท่านั้น</strong>
		<p>คิวอนุมัติเคสจากบอทสงวนไว้ให้เจ้าของระบบ ติดต่อ owner หากต้องการสิทธิ์</p>
	</section>
{:else if loading}
	<div class="case-list" aria-busy="true">
		{#each [0, 1] as i (i)}
			<div class="card ws-panel case skel-case">
				<div class="skel-line w40"></div>
				<div class="skel-line w70"></div>
				<div class="skel-line w55"></div>
			</div>
		{/each}
	</div>
{:else if loadError}
	<section class="card ws-panel error-card" role="alert">
		<strong>โหลดคิวไม่สำเร็จ</strong>
		<p>{loadError}</p>
		<button type="button" class="btn ws-btn-ghost" onclick={() => void refresh()}>ลองใหม่</button>
	</section>
{:else if cases.length === 0}
	<!-- Honest empty state: the autonomous bot is handling everything. -->
	<section class="card ws-panel empty-state">
		<div class="empty-emoji" aria-hidden="true">✅</div>
		<strong>ไม่มีเคสที่ต้องการคุณ</strong>
		<p>บอทกำลังจัดการทุกอย่างเองได้ — ไม่มีเคสเงิน/บัญชีที่ต้องให้คุณตัดสินตอนนี้</p>
	</section>
{:else}
	<ul class="case-list" aria-label="เคสที่รอการตัดสิน">
		{#each cases as c (c.id)}
			{@const busy = busyId === c.id}
			<li class="card ws-panel case" data-action={c.action}>
				<!-- Top: action title + escalation tag + when -->
				<div class="case-top">
					<div class="case-title">
						<span class="action-name">{actionLabel(c.action)}</span>
						<span class="tag tag-{escalationTag(c.reason)}">{escalationTag(c.reason)}</span>
					</div>
					{#if c.amountCents > 0}
						<span class="case-amount" title="ยอดที่บอทเสนอ">{fmtCents(c.amountCents, c.currency)}</span>
					{/if}
				</div>

				<!-- Why escalated -->
				<p class="why">
					<span class="why-label">ทำไมส่งให้คุณ:</span>
					{escalationReason(c.reason)}
				</p>

				<!-- Customer -->
				<dl class="meta-grid">
					<div class="meta">
						<dt>ลูกค้า</dt>
						<dd class="mono">{c.userId}</dd>
					</div>
					{#if c.ticketId}
						<div class="meta">
							<dt>Ticket</dt>
							<dd class="mono">{c.ticketId}</dd>
						</div>
					{/if}
					<div class="meta">
						<dt>เข้าคิวเมื่อ</dt>
						<dd>{fmtDateTime(c.createdAt)}</dd>
					</div>
				</dl>

				<!-- The bot's recommendation (advisory) -->
				{#if c.recommendation}
					<div class="bot-rec">
						<span class="bot-label" aria-hidden="true">🤖 บอทแนะนำ</span>
						<p>{c.recommendation}</p>
					</div>
				{/if}

				<!-- Server-VERIFIED evidence: what the decision is based on -->
				<div class="evidence">
					<span class="evidence-label">ข้อมูลที่ตรวจสอบแล้ว (verified)</span>
					<ul class="evidence-list">
						<li>
							<span class="ev-k">ส่วนต่างที่ตรวจสอบได้</span>
							<span class="ev-v">{fmtCents(evidenceDiscrepancy(c), c.evidence?.currency ?? c.currency)}</span>
						</li>
						<li>
							<span class="ev-k">มีการชำระเงินสำเร็จ</span>
							<span class="ev-v" data-yes={c.evidence?.hasSucceededPayment ? "true" : "false"}>
								{c.evidence?.hasSucceededPayment ? "มี" : "ไม่พบ"}
							</span>
						</li>
						{#if c.evidence?.refs && c.evidence.refs.length}
							<li>
								<span class="ev-k">อ้างอิง</span>
								<span class="ev-v mono small">{c.evidence.refs.join(", ")}</span>
							</li>
						{/if}
					</ul>
				</div>

				<!-- One-tap decision actions -->
				<!-- Approve label is action-aware: grant_credit executes now; refund/plan_change
				     only records the decision — the owner must complete execution in Support console. -->
				<div class="case-actions">
					<button
						type="button"
						class="btn approve ws-grad-primary"
						onclick={() => void approve(c)}
						disabled={busy || Boolean(busyId)}
						title={actionExecutesOnApprove(c.action)
							? "อนุมัติ: โอนเครดิตทันที"
							: "บันทึกการอนุมัติ: ดำเนินการต่อใน Support console"}
					>
						{busy
							? "กำลังบันทึก…"
							: actionExecutesOnApprove(c.action)
								? "อนุมัติ · โอนเครดิต"
								: "อนุมัติ · บันทึกเท่านั้น"}
					</button>
					<button
						type="button"
						class="btn modify ws-btn-ghost"
						onclick={() => openModify(c)}
						disabled={busy || Boolean(busyId)}
					>
						แก้ยอด
					</button>
					<button
						type="button"
						class="btn deny ws-btn-ghost"
						onclick={() => void deny(c)}
						disabled={busy || Boolean(busyId)}
					>
						ปฏิเสธ
					</button>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<!-- ── Modify modal ───────────────────────────────────────────── -->
<Dialog
	open={Boolean(modifyTarget)}
	onClose={() => (modifyTarget = null)}
	busy={modifyBusy}
	role="dialog"
	size="sm"
	eyebrow="OWNER · แก้ยอดก่อนอนุมัติ"
	title={modifyTarget && actionExecutesOnApprove(modifyTarget.action)
		? "ปรับจำนวนแล้วอนุมัติ · โอนเครดิตทันที"
		: "ปรับจำนวนแล้วบันทึกการอนุมัติ"}
	description={modifyDialogDescription(modifyTarget?.action)}
>
	{#if modifyTarget}
		<div class="form">
			<div class="modify-context">
				<span>{actionLabel(modifyTarget.action)} · ลูกค้า <span class="mono">{modifyTarget.userId}</span></span>
				<span class="modify-orig">บอทเสนอ: {fmtCents(modifyTarget.amountCents, modifyTarget.currency)}</span>
			</div>
			<label class="field">
				<span>จำนวนเงินใหม่ ({(modifyTarget.currency ?? "").toUpperCase() || "หน่วยหลัก"})</span>
				<input
					class="input"
					type="text"
					inputmode="decimal"
					bind:value={modifyAmountMajor}
					placeholder={centsToMajorInput(modifyTarget.amountCents, modifyTarget.currency)}
					spellcheck="false"
				/>
			</label>
			<label class="field">
				<span>เหตุผล (ไม่บังคับ)</span>
				<textarea class="input" rows="2" maxlength="2000" bind:value={modifyReason} placeholder="เช่น ปรับเป็นยอดที่เหมาะสมกว่า"></textarea>
			</label>
			<p class="hint">ใส่เป็นหน่วยหลัก เช่น 19.99 = $19.99 (USD), 1000 = ¥1,000 (JPY ไม่มีทศนิยม)</p>
			{#if modifyTarget && !actionExecutesOnApprove(modifyTarget.action)}
				<!-- Honest notice for refund / plan_change: approval records only, no money moves here -->
				<div class="notice-no-exec" role="note">
					<strong>ไม่มีการตัดเงิน / โอนเงินในขั้นตอนนี้</strong>
					<p>การอนุมัติเพียงบันทึกการตัดสินใจของ owner — กรุณาดำเนินการคืนเงิน/เปลี่ยนแพ็กเกจต่อใน <strong>Support console</strong></p>
				</div>
			{/if}
			{#if modifyError}
				<p class="alert error" role="alert">{modifyError}</p>
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn ws-btn-ghost" onclick={() => (modifyTarget = null)} disabled={modifyBusy}>ยกเลิก</button>
		<button type="button" class="btn approve ws-grad-primary" onclick={() => void submitModify()} disabled={!modifyValid || modifyBusy}>
			{modifyConfirmLabel(modifyTarget?.action, modifyBusy)}
		</button>
	{/snippet}
</Dialog>

<!-- ── Toast ──────────────────────────────────────────────────── -->
{#if toast}
	<div class="toast toast-{toast.kind}" role="status" aria-live="polite">{toast.text}</div>
{/if}

<style>
	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 18px;
		gap: 12px;
		flex-wrap: wrap;
	}
	.page-head h1 { font-size: 22px; margin: 0; color: var(--color-ws-ink); }
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; max-width: 60ch; }
	.head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
	.count-pill {
		font-size: 12px; font-weight: 600; color: var(--color-ws-violet);
		background: color-mix(in srgb, var(--color-ws-violet) 16%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 32%, transparent);
		border-radius: 999px; padding: 5px 11px; white-space: nowrap;
	}

	/* ── Cards ── */
	.card {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 16px;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}
	.skel { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 14px; }

	.denied strong, .error-card strong, .empty-state strong { color: var(--color-ws-ink); font-size: 16px; display: block; }
	.denied p, .error-card p, .empty-state p { color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; margin: 8px 0 0; }
	.error-card { border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); }
	.error-card .btn { margin-top: 12px; }

	/* ── Empty state ── */
	.empty-state { text-align: center; padding: 40px 20px; }
	.empty-emoji { font-size: 38px; margin-bottom: 8px; }
	.empty-state p { max-width: 44ch; margin-left: auto; margin-right: auto; }

	/* ── Case list ── */
	.case-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
	.case { display: flex; flex-direction: column; gap: 12px; }

	.case-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
	.case-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
	.action-name { font-size: 16px; font-weight: 600; color: var(--color-ws-ink); }
	.case-amount {
		font-size: 18px; font-weight: 700; color: var(--color-ws-ink);
		font-variant-numeric: tabular-nums; white-space: nowrap;
	}

	.tag {
		font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
		padding: 3px 8px; border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-ink) 7%, transparent); color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
	}
	.tag-refund { background: color-mix(in srgb, var(--color-ws-rose) 16%, transparent); color: var(--color-ws-rose); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); }
	.tag-cap { background: color-mix(in srgb, var(--color-ws-amber) 14%, transparent); color: var(--color-ws-amber); border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent); }
	.tag-velocity, .tag-circuit { background: color-mix(in srgb, var(--color-ws-amber) 14%, transparent); color: var(--color-ws-amber); border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent); }
	.tag-plan { background: color-mix(in srgb, var(--color-ws-cyan) 14%, transparent); color: var(--color-ws-cyan); border-color: color-mix(in srgb, var(--color-ws-cyan) 28%, transparent); }
	.tag-ambiguous, .tag-review { background: color-mix(in srgb, var(--color-ws-violet) 16%, transparent); color: var(--color-ws-violet); border-color: color-mix(in srgb, var(--color-ws-violet) 30%, transparent); }

	.why { margin: 0; font-size: 13.5px; color: color-mix(in srgb, var(--color-ws-ink) 78%, transparent); line-height: 1.45; }
	.why-label { color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); font-weight: 600; }

	/* ── Meta ── */
	.meta-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr));
		gap: 10px 16px; margin: 0;
	}
	.meta dt { font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent); margin-bottom: 2px; }
	.meta dd { margin: 0; font-size: 13px; color: var(--color-ws-ink); word-break: break-all; }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
	.small { font-size: 11.5px; }

	/* ── Bot recommendation ── */
	.bot-rec {
		background: color-mix(in srgb, var(--color-ws-violet) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 20%, transparent);
		border-radius: var(--radius-ws-ctrl); padding: 10px 12px;
	}
	.bot-label { font-size: 11px; font-weight: 700; color: var(--color-ws-violet); letter-spacing: 0.02em; }
	.bot-rec p { margin: 4px 0 0; font-size: 13px; color: color-mix(in srgb, var(--color-ws-ink) 82%, transparent); line-height: 1.45; }

	/* ── Evidence ── */
	.evidence {
		background: color-mix(in srgb, var(--color-ws-ink) 2.5%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		border-radius: var(--radius-ws-ctrl); padding: 10px 12px;
	}
	.evidence-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: color-mix(in srgb, var(--color-ws-green) 85%, transparent); }
	.evidence-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.evidence-list li { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
	.ev-k { font-size: 12.5px; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	.ev-v { font-size: 13px; color: var(--color-ws-ink); font-variant-numeric: tabular-nums; text-align: right; }
	.ev-v[data-yes="true"] { color: var(--color-ws-green); }
	.ev-v[data-yes="false"] { color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent); }

	/* ── Buttons ── */
	.btn {
		min-height: 36px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 10px 16px;
		font-size: 14px;
		cursor: pointer;
		font-family: inherit;
		min-height: 44px; /* comfortable tap target on mobile */
	}
	.btn:hover:not([disabled]) { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.45; cursor: not-allowed; }

	.case-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
	.case-actions .btn { flex: 1 1 auto; font-weight: 600; }
	.btn.approve {
		background: linear-gradient(100deg, var(--color-ws-green), var(--color-ws-green));
		border-color: transparent; color: var(--color-ws-ink); font-weight: 700;
	}
	.btn.approve:hover:not([disabled]) { filter: brightness(1.08); }
	.btn.modify { background: color-mix(in srgb, var(--color-ws-violet) 16%, transparent); border-color: color-mix(in srgb, var(--color-ws-violet) 34%, transparent); color: var(--color-ws-violet); }
	.btn.modify:hover:not([disabled]) { background: color-mix(in srgb, var(--color-ws-violet) 24%, transparent); }
	.btn.deny { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.btn.deny:hover:not([disabled]) { background: color-mix(in srgb, var(--color-ws-rose) 20%, transparent); }

	/* ── Skeleton ── */
	.skel-case { gap: 10px; }
	.skel-line { height: 12px; border-radius: 6px; background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent); }
	.skel-line.w40 { width: 40%; }
	.skel-line.w55 { width: 55%; }
	.skel-line.w70 { width: 70%; }

	/* ── Modify form ── */
	.form { display: flex; flex-direction: column; gap: 12px; }
	.modify-context {
		display: flex; flex-direction: column; gap: 4px;
		font-size: 13px; color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
		padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
	}
	.modify-orig { font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); }
	.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	.input {
		min-height: 36px;
		background: var(--color-ws-surface2); color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl); padding: 10px;
		font-size: 14px; color-scheme: dark; width: 100%;
		box-sizing: border-box; font-family: inherit;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	textarea.input { resize: vertical; }
	.hint { font-size: 11.5px; color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent); margin: 0; }
	.alert.error { font-size: 12.5px; color: var(--color-ws-rose); margin: 0; }
	.notice-no-exec {
		background: color-mix(in srgb, var(--color-ws-amber) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: var(--radius-ws-ctrl); padding: 10px 12px;
	}
	.notice-no-exec strong { font-size: 12px; color: var(--color-ws-amber); display: block; margin-bottom: 4px; }
	.notice-no-exec p { margin: 0; font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent); line-height: 1.4; }

	/* ── Toast ── */
	.toast {
		position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
		max-width: calc(100vw - 32px);
		padding: 11px 18px; border-radius: var(--radius-ws-ctrl); font-size: 13.5px; font-weight: 500;
		box-shadow: 0 18px 50px -20px color-mix(in srgb, var(--color-ws-bg) 80%, transparent); z-index: 60;
	}
	/* Light status fills take the DARK bg token as text — ink-on-green was ~1.6:1. */
	.toast-ok { background: var(--color-ws-green); color: var(--color-ws-bg); }
	.toast-error { background: var(--color-ws-rose); color: var(--color-ws-bg); }

	/* ── Mobile (the owner approves from their phone) ── */
	@media (max-width: 560px) {
		.page-head { align-items: flex-start; }
		.case-top { align-items: baseline; }
		.case-actions { flex-direction: column; }
		.case-actions .btn { width: 100%; }
	}
</style>
