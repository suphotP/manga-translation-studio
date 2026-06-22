<!--
Admin SUPPORT console (support-agent facing).

Customer-360 lookup (by email or id) + REAL support actions over /api/admin/support
via adminSupportApi:
  * lookup           — READ-ONLY customer-360 (profile, plan, credit balance, recent
                       payments, open tickets). Needs admin:support.read (the nav
                       section + route are already gated server-side).
  * grantCredits     — goodwill credit grant. SUPPORT_ADJUST. A STABLE per-form
                       idempotencyKey (IdempotencyKeyHolder) satisfies the backend's
                       REQUIRED dedupe-key contract. The key is REUSED on every retry of
                       the open form (so a failed-but-committed grant retried under the
                       same form dedupes server-side and never double-mints) and rotated
                       to a fresh key ONLY on confirmed success or on a fresh form open.
  * changePlan       — move the workspace plan. SUPPORT_ADJUST.
  * refund           — money OUT. REFUND_WRITE (owner/admin only). The refund action is
                       HIDDEN/disabled for the support role (support lacks REFUND_WRITE),
                       and the form REQUIRES a dodoChargeId because the backend rejects a
                       refund without it / over the original / in the wrong currency.

Permissions are read once from GET /api/admin/me (same source as the layout nav), so
write affordances the caller cannot use are disabled with an honest inline note. The
backend stays authoritative on every route; this gating is defense-in-depth.

Money is rendered EXACTLY per-currency via the revenue page's money.ts (integer-cents
strings, ISO-4217 minor units, no float). Styling mirrors the rest of /admin
(revenue/coupons/users): self-contained dark-shell tokens, no new shared files. The
action modals reuse the shared ws Dialog atom.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import { adminSupportApi, getAdminMe, AdminApiError } from "$lib/api/admin.ts";
	import type {
		AdminCustomer360,
		AdminSupportPayment,
	} from "$lib/api/admin/support.ts";
	import { formatMoney } from "../revenue/money.ts";
	import { IdempotencyKeyHolder } from "../workspaces/[id]/idempotency-key.ts";

	const SUPPORT_ADJUST = "admin:support.adjust";
	const REFUND_WRITE = "admin:refund.write";

	// Workspace plans the backend accepts (mirrors backend/src/services/plans.ts
	// WorkspacePlanId). The backend validates with isWorkspacePlanId and 400s on
	// anything else, so we only offer these.
	const PLAN_OPTIONS = ["free", "creator", "pro", "studio"] as const;

	// ── Permissions (gate the write actions) ──────────────────────
	let canAdjust = $state(false);
	let canRefund = $state(false);

	// ── Lookup state ──────────────────────────────────────────────
	let query = $state("");
	let customer = $state<AdminCustomer360 | null>(null);
	let lookupLoading = $state(false);
	let lookupError = $state<string | null>(null);
	// True once a lookup has resolved with no match (vs. the never-searched state).
	let notFound = $state(false);
	let hasSearched = $state(false);

	// ── Toast ─────────────────────────────────────────────────────
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
			// The backend's validation/guard responses carry a human-readable `error`
			// message (e.g. "Refund exceeds the original charge", "no original charge",
			// wrong currency, "already fully refunded"), surfaced as `.message`. Show it
			// verbatim — it is the friendliest, most accurate thing we can say.
			if (cause.status === 403) {
				return "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (โดน backend ปฏิเสธ)";
			}
			if (cause.status === 404) return "ไม่พบลูกค้าที่ตรงกับคำค้น";
			return cause.message || `Admin API ${cause.status}`;
		}
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	function fmtDateTime(value: string | null | undefined): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
	}

	// Backend amounts arrive as integer MINOR UNITS (cents) but typed as `number`
	// in the support barrel; money.ts wants a cents STRING. Stringify (integer) so the
	// exact per-currency formatter runs on a clean integer-cents value.
	function fmtPayment(p: AdminSupportPayment): string {
		return formatMoney(String(Math.trunc(p.amountCents)), p.currency);
	}

	function paymentKindClass(kind: AdminSupportPayment["kind"]): string {
		return `pill pill-${kind}`;
	}

	// ── Lookup ─────────────────────────────────────────────────────
	async function runLookup() {
		const q = query.trim();
		if (!q || lookupLoading) return;
		lookupLoading = true;
		lookupError = null;
		notFound = false;
		hasSearched = true;
		try {
			customer = await adminSupportApi.lookup(q);
		} catch (cause) {
			customer = null;
			if (cause instanceof AdminApiError && cause.status === 404) {
				notFound = true;
			} else {
				lookupError = describeError(cause);
			}
		} finally {
			lookupLoading = false;
		}
	}

	function onSearchSubmit(event: SubmitEvent) {
		event.preventDefault();
		void runLookup();
	}

	// The workspace id the write actions target. Every mutation route is
	// /workspaces/:workspaceId/*, so without a resolved workspace there is nothing
	// to act on (lookups that only matched a user with no workspace).
	let actionableWorkspaceId = $derived(customer?.workspace?.id ?? null);

	// ── Grant credit modal ─────────────────────────────────────────
	let grantOpen = $state(false);
	let grantAmount = $state<number | null>(null);
	let grantReason = $state("");
	let grantClass = $state<"shareable" | "personal">("shareable");
	let grantBusy = $state(false);
	let grantError = $state<string | null>(null);
	// STABLE money-safe dedupe key for the OPEN grant form. Reused on every retry
	// after a failure (so a possibly-committed grant dedupes server-side and never
	// double-mints), rotated to a fresh key ONLY on confirmed success or on a fresh
	// form open. Grant + refund hold INDEPENDENT keys.
	const grantIdem = new IdempotencyKeyHolder();

	function openGrant() {
		grantAmount = null;
		grantReason = "";
		grantClass = "shareable";
		grantError = null;
		// Fresh form open = a genuinely-new attempt → fresh dedupe key.
		grantIdem.rotate();
		grantOpen = true;
	}

	const grantValid = $derived(
		Boolean(actionableWorkspaceId)
		&& typeof grantAmount === "number"
		&& Number.isInteger(grantAmount)
		&& grantAmount >= 1
		&& grantAmount <= 1_000_000
		&& grantReason.trim().length >= 1
		// Personal credits are owned by a user — require a resolved user to own them.
		&& (grantClass !== "personal" || Boolean(customer?.user?.id)),
	);

	async function submitGrant() {
		if (!actionableWorkspaceId || !grantValid || grantBusy) return;
		grantBusy = true;
		grantError = null;
		try {
			const result = await adminSupportApi.grantCredits(actionableWorkspaceId, {
				amount: grantAmount as number,
				reason: grantReason.trim(),
				creditClass: grantClass,
				userId: grantClass === "personal" ? customer?.user?.id : undefined,
				// STABLE dedupe key for THIS attempt: reused on every retry so a
				// failed-but-committed grant retried under the same form never
				// double-mints (the ledger returns the existing grant). Rotated only
				// after the confirmed success below (or a fresh form open).
				idempotencyKey: grantIdem.current,
			});
			// CONFIRMED success → rotate to a fresh key so the next grant is a
			// genuinely-new, independently-deduped attempt.
			grantIdem.rotate();
			// Reflect the new balance immediately by re-running the lookup (authoritative).
			notify("ok", `เพิ่มเครดิตสำเร็จ +${result.grant.amount} (${result.grant.creditClass})`);
			grantOpen = false;
			await runLookup();
		} catch (cause) {
			// Failure (incl. network/timeout/5xx): keep grantIdem.current UNCHANGED so the
			// operator's retry of this same form carries the same key → backend dedupe
			// recognises a possibly-committed request and won't double-mint.
			grantError = describeError(cause);
		} finally {
			grantBusy = false;
		}
	}

	// ── Change plan modal ───────────────────────────────────────────
	let planOpen = $state(false);
	let planTarget = $state<(typeof PLAN_OPTIONS)[number]>("free");
	let planReason = $state("");
	let planBusy = $state(false);
	let planError = $state<string | null>(null);

	function openPlan() {
		// Seed with the current plan when it is one of the known workspace plans.
		const current = customer?.plan?.planId;
		planTarget = (PLAN_OPTIONS as readonly string[]).includes(current ?? "")
			? (current as (typeof PLAN_OPTIONS)[number])
			: "free";
		planReason = "";
		planError = null;
		planOpen = true;
	}

	const planValid = $derived(
		Boolean(actionableWorkspaceId) && planReason.trim().length >= 1,
	);

	async function submitPlan() {
		if (!actionableWorkspaceId || !planValid || planBusy) return;
		planBusy = true;
		planError = null;
		try {
			const result = await adminSupportApi.changePlan(actionableWorkspaceId, {
				planId: planTarget,
				reason: planReason.trim(),
			});
			notify("ok", `เปลี่ยนแพลนเป็น ${result.billing.planId} (${result.billing.status}) สำเร็จ`);
			planOpen = false;
			await runLookup();
		} catch (cause) {
			planError = describeError(cause);
		} finally {
			planBusy = false;
		}
	}

	// ── Refund modal (REFUND_WRITE only) ────────────────────────────
	let refundOpen = $state(false);
	let refundAmount = $state<number | null>(null);
	let refundCurrency = $state("");
	let refundChargeId = $state("");
	let refundReason = $state("");
	let refundBusy = $state(false);
	let refundError = $state<string | null>(null);
	// STABLE money-out dedupe ref for the OPEN refund form. Reused on every retry
	// after a failure (so a possibly-committed refund dedupes server-side and never
	// double-refunds), rotated to a fresh key ONLY on confirmed success or on a fresh
	// form open. Independent from the grant key.
	const refundIdem = new IdempotencyKeyHolder();

	function openRefund() {
		refundAmount = null;
		// Seed the currency from the most recent real payment so the operator starts
		// in the right ISO-4217 currency (the backend rejects a currency mismatch).
		const recent = customer?.recentPayments?.find((p) => p.kind === "payment" && p.currency);
		refundCurrency = recent?.currency ?? "";
		refundChargeId = "";
		refundReason = "";
		refundError = null;
		// Fresh form open = a genuinely-new attempt → fresh dedupe key.
		refundIdem.rotate();
		refundOpen = true;
	}

	const refundValid = $derived(
		Boolean(actionableWorkspaceId)
		&& typeof refundAmount === "number"
		&& Number.isInteger(refundAmount)
		&& refundAmount >= 1
		&& refundCurrency.trim().length >= 3
		// REQUIRED by the backend (money-out safety): the original charge id.
		&& refundChargeId.trim().length >= 1
		&& refundReason.trim().length >= 1,
	);

	async function submitRefund() {
		if (!actionableWorkspaceId || !refundValid || refundBusy) return;
		refundBusy = true;
		refundError = null;
		try {
			const result = await adminSupportApi.refund(actionableWorkspaceId, {
				// amountMinor is integer MINOR UNITS (cents) — the input is in cents.
				amountMinor: refundAmount as number,
				currency: refundCurrency.trim().toUpperCase(),
				reason: refundReason.trim(),
				dodoChargeId: refundChargeId.trim(),
				// STABLE dedupe ref for THIS attempt: reused on every retry so a
				// failed-but-committed refund retried under the same form never
				// double-refunds (the backend returns the existing refund). Rotated
				// only after the confirmed success below (or a fresh form open).
				idempotencyKey: refundIdem.current,
			});
			// CONFIRMED success → rotate to a fresh key for the next, independent attempt.
			refundIdem.rotate();
			notify("ok", `คืนเงินสำเร็จ ${fmtPayment(result.refund)}`);
			refundOpen = false;
			await runLookup();
		} catch (cause) {
			// Failure (incl. network/timeout/5xx): keep refundIdem.current UNCHANGED so the
			// operator's retry carries the same key → backend dedupe recognises a
			// possibly-committed refund and won't double-refund.
			refundError = describeError(cause);
		} finally {
			refundBusy = false;
		}
	}

	onMount(async () => {
		// The shell already gated admin:access; we only need the write permissions to
		// decide which action affordances to render. A failure keeps every write off.
		try {
			const me = await getAdminMe();
			canAdjust = me.permissions.includes(SUPPORT_ADJUST);
			canRefund = me.permissions.includes(REFUND_WRITE);
		} catch {
			canAdjust = false;
			canRefund = false;
		}
	});
</script>

<svelte:head><title>Support · Admin · Comic Workspace</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Support console</h1>
		<p class="page-sub">ค้นหาลูกค้า (อีเมลหรือ id) → ดูข้อมูล 360° แล้วทำรายการช่วยเหลือ: เพิ่มเครดิต, เปลี่ยนแพลน, คืนเงิน</p>
	</div>
	<div class="page-meta">ทุกรายการถูก audit · จำนวนเงินแม่นยำตามสกุลเงิน (ไม่รวมข้ามสกุล)</div>
</header>

<!-- ── Search ─────────────────────────────────────────────────── -->
<section class="block" aria-label="ค้นหาลูกค้า">
	<form class="search-row" onsubmit={onSearchSubmit}>
		<label class="field grow">
			<span>อีเมล หรือ user/workspace id</span>
			<input
				class="input"
				type="text"
				placeholder="เช่น customer@example.com หรือ ws_… / usr_…"
				bind:value={query}
				maxlength="320"
				autocomplete="off"
				spellcheck="false"
			/>
		</label>
		<button type="submit" class="btn primary ws-grad-primary" disabled={lookupLoading || query.trim().length === 0}>
			{lookupLoading ? "กำลังค้นหา…" : "🔍 ค้นหา"}
		</button>
	</form>

	{#if lookupError}
		<p class="alert error" role="alert">{lookupError}</p>
	{/if}
</section>

<!-- ── Customer 360 ───────────────────────────────────────────── -->
<section class="block" aria-label="ข้อมูลลูกค้า 360°">
	{#if lookupLoading}
		<div class="card ws-panel skel-card" aria-hidden="true">
			<span class="skeleton" style="width: 40%; height: 18px"></span>
			<span class="skeleton" style="width: 70%"></span>
			<span class="skeleton" style="width: 55%"></span>
		</div>
	{:else if notFound}
		<p class="empty-panel">ไม่พบลูกค้าที่ตรงกับ “{query.trim()}” — ลองใส่อีเมลเต็ม หรือ workspace/user id</p>
	{:else if !customer}
		{#if hasSearched}
			<p class="empty-panel">ไม่มีข้อมูลให้แสดง — ลองค้นหาใหม่อีกครั้ง</p>
		{:else}
			<p class="empty-panel">ยังไม่ได้ค้นหา — พิมพ์อีเมลหรือ id ของลูกค้าด้านบนเพื่อดูข้อมูล 360°</p>
		{/if}
	{:else}
		<!-- Header card: identity + the action toolbar. -->
		<div class="card ws-panel customer-card">
			<div class="customer-top">
				<div class="customer-id">
					<h2>{customer.user?.name || customer.user?.email || customer.workspace?.name || "ลูกค้า"}</h2>
					<div class="customer-meta">
						{#if customer.user}
							<span class="muted">{customer.user.email}</span>
							<span class="dot" aria-hidden="true">·</span>
							<span class="pill pill-role">{customer.user.role}</span>
							{#if !customer.user.isActive}
								<span class="pill pill-dispute">ปิดใช้งาน</span>
							{/if}
						{/if}
					</div>
					<div class="customer-ids">
						{#if customer.user}<code title="user id">usr {customer.user.id}</code>{/if}
						{#if customer.workspace}<code title="workspace id">ws {customer.workspace.id}</code>{/if}
					</div>
				</div>

				<!-- Action toolbar. Write affordances disabled (with reason) when the role
				     lacks the permission; refund is HIDDEN entirely for non-REFUND_WRITE. -->
				<div class="actions" role="group" aria-label="การช่วยเหลือลูกค้า">
					<button
						type="button"
						class="btn ws-btn-ghost"
						onclick={openGrant}
						disabled={!canAdjust || !actionableWorkspaceId}
						title={!canAdjust ? "ต้องมีสิทธิ์ admin:support.adjust" : !actionableWorkspaceId ? "ลูกค้านี้ไม่มี workspace ให้ทำรายการ" : ""}
					>
						+ เพิ่มเครดิต
					</button>
					<button
						type="button"
						class="btn ws-btn-ghost"
						onclick={openPlan}
						disabled={!canAdjust || !actionableWorkspaceId}
						title={!canAdjust ? "ต้องมีสิทธิ์ admin:support.adjust" : !actionableWorkspaceId ? "ลูกค้านี้ไม่มี workspace ให้ทำรายการ" : ""}
					>
						⇄ เปลี่ยนแพลน
					</button>
					{#if canRefund}
						<button
							type="button"
							class="btn danger ws-btn-ghost"
							onclick={openRefund}
							disabled={!actionableWorkspaceId}
							title={!actionableWorkspaceId ? "ลูกค้านี้ไม่มี workspace ให้ทำรายการ" : ""}
						>
							↩ คืนเงิน
						</button>
					{/if}
				</div>
			</div>

			{#if !canAdjust}
				<p class="perm-note">บัญชีของคุณไม่มีสิทธิ์ <code>admin:support.adjust</code> — เพิ่มเครดิต/เปลี่ยนแพลนถูกปิดไว้</p>
			{:else if !actionableWorkspaceId}
				<p class="perm-note">ลูกค้านี้ยังไม่มี workspace — ไม่มีปลายทางสำหรับทำรายการ</p>
			{/if}
			{#if !canRefund}
				<p class="perm-note">บัญชีของคุณไม่มีสิทธิ์ <code>admin:refund.write</code> — ปุ่มคืนเงินถูกซ่อน (เฉพาะ owner/admin)</p>
			{/if}
		</div>

		<!-- Stat row: plan + credit balance. -->
		<div class="stat-grid">
			<div class="card ws-panel stat">
				<p class="stat-label">แพลนปัจจุบัน</p>
				{#if customer.plan}
					<p class="stat-value">{customer.plan.planId}</p>
					<p class="stat-foot">
						สถานะ {customer.plan.status ?? "—"} ·
						{customer.plan.assigned ? "กำหนดไว้แล้ว" : "ค่าเริ่มต้น (ยังไม่กำหนด)"}
					</p>
				{:else}
					<p class="stat-value muted">—</p>
					<p class="stat-foot">ยังไม่มีข้อมูลแพลน</p>
				{/if}
			</div>
			<div class="card ws-panel stat">
				<p class="stat-label">เครดิตคงเหลือ</p>
				<p class="stat-value">{new Intl.NumberFormat().format(customer.creditBalance.total)}</p>
				<p class="stat-foot">
					ใช้ร่วมกัน {new Intl.NumberFormat().format(customer.creditBalance.shareable)} ·
					ส่วนตัว {new Intl.NumberFormat().format(customer.creditBalance.personal)}
				</p>
			</div>
		</div>

		<!-- Recent payments. -->
		<div class="card ws-panel list-card">
			<header class="list-head"><h3>การชำระเงินล่าสุด</h3></header>
			{#if customer.recentPayments.length === 0}
				<p class="empty-inline">ยังไม่มีรายการชำระเงิน</p>
			{:else}
				<div class="table-wrap ws-panel">
					<table>
						<thead>
							<tr>
								<th>วันที่</th>
								<th>ประเภท</th>
								<th class="num">จำนวนเงิน</th>
								<th>แพลน</th>
								<th>สถานะ</th>
							</tr>
						</thead>
						<tbody>
							{#each customer.recentPayments as p (p.id)}
								<tr>
									<td class="muted">{fmtDateTime(p.occurredAt)}</td>
									<td><span class={paymentKindClass(p.kind)}>{p.kind}</span></td>
									<td class="num money {String(p.amountCents).startsWith('-') ? 'neg' : ''}">{fmtPayment(p)}</td>
									<td class="muted">{p.planId ?? "—"}</td>
									<td class="muted">{p.status ?? "—"}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Open tickets. -->
		<div class="card ws-panel list-card">
			<header class="list-head"><h3>ทิกเก็ตที่เปิดอยู่</h3></header>
			{#if customer.openTickets.length === 0}
				<p class="empty-inline">ไม่มีทิกเก็ตที่เปิดอยู่</p>
			{:else}
				<ul class="ticket-list">
					{#each customer.openTickets as t (t.id)}
						<li>
							<span class="ticket-subject" title={t.subject}>{t.subject}</span>
							<span class="pill">{t.status}</span>
							<span class="muted small">{t.category}</span>
							<span class="muted small">อัปเดต {fmtDateTime(t.updatedAt)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<!-- ── Toast ──────────────────────────────────────────────────── -->
{#if toast}
	<div class="toast {toast.kind}" role="status">{toast.text}</div>
{/if}

<!-- ── Grant credit modal ─────────────────────────────────────── -->
<Dialog
	open={grantOpen}
	onClose={() => (grantOpen = false)}
	busy={grantBusy}
	size="sm"
	eyebrow="SUPPORT · เครดิต"
	title="เพิ่มเครดิต (goodwill)"
	description="เพิ่มเครดิตให้ workspace ของลูกค้า — มีการ audit และกันการกดซ้ำ"
>
	<div class="form">
		<label class="field">
			<span>จำนวนเครดิต (1–1,000,000)</span>
			<input
				class="input"
				type="number"
				min="1"
				max="1000000"
				step="1"
				inputmode="numeric"
				bind:value={grantAmount}
				placeholder="เช่น 500"
			/>
		</label>
		<label class="field">
			<span>ประเภทเครดิต</span>
			<select class="input" bind:value={grantClass}>
				<option value="shareable">ใช้ร่วมกัน (workspace)</option>
				<option value="personal" disabled={!customer?.user?.id}>ส่วนตัว (ต้องมี user)</option>
			</select>
		</label>
		<label class="field">
			<span>เหตุผล</span>
			<textarea class="input" rows="2" maxlength="2000" bind:value={grantReason} placeholder="เช่น ชดเชยจากปัญหา job ค้าง"></textarea>
		</label>
		{#if grantClass === "personal" && !customer?.user?.id}
			<p class="alert error" role="alert">เครดิตส่วนตัวต้องมีผู้ใช้เป็นเจ้าของ — ค้นหาลูกค้าด้วยอีเมล/ user id ก่อน</p>
		{/if}
		{#if grantError}
			<p class="alert error" role="alert">{grantError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<button type="button" class="btn ws-btn-ghost" onclick={() => (grantOpen = false)} disabled={grantBusy}>ยกเลิก</button>
		<button type="button" class="btn primary ws-grad-primary" onclick={() => void submitGrant()} disabled={!grantValid || grantBusy}>
			{grantBusy ? "กำลังเพิ่ม…" : "เพิ่มเครดิต"}
		</button>
	{/snippet}
</Dialog>

<!-- ── Change plan modal ──────────────────────────────────────── -->
<Dialog
	open={planOpen}
	onClose={() => (planOpen = false)}
	busy={planBusy}
	size="sm"
	eyebrow="SUPPORT · แพลน"
	title="เปลี่ยนแพลน"
	description="ย้ายแพลนของ workspace — มีการ audit"
>
	<div class="form">
		<label class="field">
			<span>แพลนปลายทาง</span>
			<select class="input" bind:value={planTarget}>
				{#each PLAN_OPTIONS as plan (plan)}
					<option value={plan}>{plan}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span>เหตุผล</span>
			<textarea class="input" rows="2" maxlength="2000" bind:value={planReason} placeholder="เช่น อัปเกรดให้ตามดีลที่ตกลงกับ sales"></textarea>
		</label>
		{#if planError}
			<p class="alert error" role="alert">{planError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<button type="button" class="btn ws-btn-ghost" onclick={() => (planOpen = false)} disabled={planBusy}>ยกเลิก</button>
		<button type="button" class="btn primary ws-grad-primary" onclick={() => void submitPlan()} disabled={!planValid || planBusy}>
			{planBusy ? "กำลังเปลี่ยน…" : "เปลี่ยนแพลน"}
		</button>
	{/snippet}
</Dialog>

<!-- ── Refund modal (REFUND_WRITE) ─────────────────────────────── -->
<Dialog
	open={refundOpen}
	onClose={() => (refundOpen = false)}
	busy={refundBusy}
	role="alertdialog"
	size="sm"
	eyebrow="SUPPORT · คืนเงิน"
	title="คืนเงิน (money out)"
	description="บันทึกรายการคืนเงินจริง — ต้องระบุ charge id เดิม จำนวนเงินไม่เกินยอดที่จ่ายและสกุลเดียวกัน"
>
	<div class="form">
		<div class="field-row">
			<label class="field grow">
				<span>จำนวนเงิน (หน่วยย่อย/cents)</span>
				<input
					class="input"
					type="number"
					min="1"
					step="1"
					inputmode="numeric"
					bind:value={refundAmount}
					placeholder="เช่น 1999 = $19.99"
				/>
			</label>
			<label class="field">
				<span>สกุลเงิน (ISO-4217)</span>
				<input class="input" type="text" maxlength="8" bind:value={refundCurrency} placeholder="USD" spellcheck="false" />
			</label>
		</div>
		<label class="field">
			<span>Dodo charge id (จำเป็น)</span>
			<input class="input" type="text" maxlength="200" bind:value={refundChargeId} placeholder="ch_… ของ charge เดิม" spellcheck="false" />
		</label>
		<label class="field">
			<span>เหตุผล</span>
			<textarea class="input" rows="2" maxlength="2000" bind:value={refundReason} placeholder="เช่น ลูกค้าขอคืนเงินภายใน 14 วัน"></textarea>
		</label>
		<p class="hint">จำนวนเงินเป็นหน่วยย่อย เช่น 1999 = $19.99 (USD), 1000 = ¥1,000 (JPY ไม่มีทศนิยม)</p>
		{#if refundError}
			<p class="alert error" role="alert">{refundError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<button type="button" class="btn ws-btn-ghost" onclick={() => (refundOpen = false)} disabled={refundBusy}>ยกเลิก</button>
		<button type="button" class="btn danger ws-btn-ghost" onclick={() => void submitRefund()} disabled={!refundValid || refundBusy}>
			{refundBusy ? "กำลังคืนเงิน…" : "คืนเงิน"}
		</button>
	{/snippet}
</Dialog>

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
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; }
	.page-meta { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }

	.block { margin-top: 22px; }

	/* ── Search ── */
	.search-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
	.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	.field.grow { flex: 1 1 320px; min-width: 0; }
	.field-row { display: flex; gap: 10px; flex-wrap: wrap; }
	.field-row .grow { flex: 1 1 160px; }
	.input {
		min-height: 36px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
		color-scheme: dark;
		width: 100%;
		box-sizing: border-box;
		font-family: inherit;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	textarea.input { resize: vertical; }

	/* ── Cards ── */
	.card {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 16px;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}
	.skel-card { display: flex; flex-direction: column; gap: 10px; }

	.customer-card { margin-bottom: 14px; }
	.customer-top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		flex-wrap: wrap;
	}
	.customer-id { min-width: 0; }
	.customer-id h2 { margin: 0; font-size: 18px; color: var(--color-ws-ink); }
	.customer-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
	.dot { color: color-mix(in srgb, var(--color-ws-ink) 30%, transparent); }
	.customer-ids { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

	.actions { display: flex; gap: 8px; flex-wrap: wrap; }

	.perm-note {
		margin: 12px 0 0;
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent);
		border-top: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		padding-top: 10px;
	}

	/* ── Stat cards ── */
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: 12px;
		margin-bottom: 14px;
	}
	.stat { padding: 14px; }
	.stat-label { margin: 0; font-size: 11px; font-weight: 500; color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent); }
	.stat-value { margin: 6px 0 0; font-size: 22px; font-weight: 600; color: var(--color-ws-ink); font-variant-numeric: tabular-nums; line-height: 1.1; }
	.stat-value.muted { color: color-mix(in srgb, var(--color-ws-ink) 40%, transparent); }
	.stat-foot { margin: 5px 0 0; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 40%, transparent); }

	/* ── List cards (payments, tickets) ── */
	.list-card { margin-bottom: 14px; padding: 0; overflow: hidden; }
	.list-head { padding: 14px 16px 10px; }
	.list-head h3 { margin: 0; font-size: 14px; color: var(--color-ws-ink); }
	.empty-inline { padding: 0 16px 16px; margin: 0; color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); font-size: 13px; }

	.table-wrap { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	th, td {
		padding: 11px 16px;
		text-align: left;
		border-top: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		vertical-align: middle;
	}
	th {
		font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
	}
	th.num, td.num { text-align: right; }
	.money { color: var(--color-ws-ink); font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
	.money.neg { color: var(--color-ws-rose); }

	.ticket-list { list-style: none; margin: 0; padding: 0 16px 12px; }
	.ticket-list li {
		display: flex; align-items: center; gap: 10px;
		padding: 9px 0; border-top: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent); flex-wrap: wrap;
	}
	.ticket-subject { color: var(--color-ws-ink); font-size: 13px; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	/* ── Buttons ── */
	.btn {
		min-height: 36px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 14px;
		font-size: 13px;
		cursor: pointer;
		font-family: inherit;
	}
	.btn:hover:not([disabled]) { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.45; cursor: not-allowed; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-rose));
		border-color: transparent;
		font-weight: 600;
	}
	.btn.primary:hover:not([disabled]) { filter: brightness(1.08); }
	.btn.danger {
		background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		border-color: color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		color: var(--color-ws-rose);
		font-weight: 600;
	}
	.btn.danger:hover:not([disabled]) { background: color-mix(in srgb, var(--color-ws-rose) 22%, transparent); }

	/* ── Alerts / hints ── */
	.alert { font-size: 12.5px; padding: 8px 12px; border-radius: var(--radius-ws-ctrl); margin: 10px 0 0; }
	.alert.error { color: var(--color-ws-rose); background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent); }
	.hint { margin: 4px 0 0; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 40%, transparent); }

	/* ── Pills ── */
	.pill {
		display: inline-block; padding: 2px 8px; font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent); border-radius: 999px;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
	}
	.pill-payment { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-refund { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-dispute { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.pill-role { background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-accent) 22%, transparent), color-mix(in srgb, var(--color-ws-rose) 12%, transparent)); border-color: color-mix(in srgb, var(--color-ws-violet) 35%, transparent); color: var(--color-ws-violet); }

	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.small { font-size: 11px; }
	code { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent); }

	.empty-panel {
		background: var(--color-ws-surface);
		border: 1px dashed color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 28px 16px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		font-size: 13px;
	}

	/* ── Toast (fixed, like a snackbar) ── */
	.toast {
		position: fixed;
		right: 24px;
		bottom: 24px;
		z-index: 1700;
		max-width: 380px;
		padding: 12px 16px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 13px;
		box-shadow: 0 18px 50px -20px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}
	.toast.ok { color: var(--color-ws-green); background: color-mix(in srgb, var(--color-ws-green) 96%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-green) 40%, transparent); }
	.toast.error { color: var(--color-ws-rose); background: color-mix(in srgb, var(--color-ws-rose) 96%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-rose) 40%, transparent); }

	/* ── Modal form layout ── */
	.form { display: flex; flex-direction: column; gap: 12px; }
	.form .field { font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent); }

	/* ── Skeleton ── */
	.skeleton {
		display: block; height: 12px; border-radius: 6px; margin: 3px 0;
		background: linear-gradient(90deg, color-mix(in srgb, var(--color-ws-ink) 5%, transparent), color-mix(in srgb, var(--color-ws-ink) 10%, transparent), color-mix(in srgb, var(--color-ws-ink) 5%, transparent));
		background-size: 200% 100%; animation: shimmer 1.2s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
