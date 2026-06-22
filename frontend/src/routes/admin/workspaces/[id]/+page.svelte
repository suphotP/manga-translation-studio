<!--
Admin workspace detail.

One-pane overview of a single workspace: identity, billing snapshot, active
grants, live credit balance, and the high-impact actions an operator runs:
  * Grant credits — REAL goodwill mint via the support credit ledger
    (adminSupportApi.grantCredits → /admin/support/workspaces/:id/credits).
  * Refund — REAL money-out via the support refund path (records a negative
    payment_transactions row + fires the provider refund when Dodo is live).
  * Impersonate a member (writes impersonation_events + admin_audit).

The credit-grant + refund actions intentionally hit the SAME real endpoints the
support console uses. Each carries a STABLE per-attempt idempotency key (held in
state, reused across failed retries, rotated only after a confirmed success or an
explicit form reset) plus a busy guard — so a failed-but-committed request that
the operator re-submits dedupes on the backend and never double-mints / double-
refunds. The operator's success state always reflects a REAL ledger change. The page
re-reads the live credit balance after each grant so the before/after delta is
visible. Workspace identity/billing/grants still come from /admin/workspaces/:id.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import {
		getWorkspace,
		impersonate,
		stopImpersonation,
		adminSupportApi,
		AdminApiError,
	} from "$lib/api/admin.ts";
	import type { AdminSupportCreditBalance } from "$lib/api/admin/support.ts";
	import { IdempotencyKeyHolder } from "./idempotency-key.ts";

	type Detail = {
		workspace: {
			id?: string;
			name?: string;
			ownerUserId?: string;
			createdAt?: string;
			memberCount?: number;
		} | null;
		billing: {
			workspaceId?: string;
			planId?: string;
			status?: string;
			billingEmail?: string | null;
			dodoCustomerId?: string | null;
			dodoSubscriptionId?: string | null;
			updatedAt?: string;
		} | null;
		grants: Array<{
			id: string;
			kind?: string;
			aiCredits?: number;
			storageBytes?: number;
			reason?: string;
			expiresAt?: string | null;
			createdAt?: string;
		}>;
	};

	let workspaceId = $derived(page.params.id ?? "");
	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let actionMessage = $state<{ kind: "ok" | "error"; text: string } | null>(null);

	// Live credit balance (the REAL ledger) — re-read after every grant so the
	// operator sees the before/after delta of a goodwill mint.
	let creditBalance = $state<AdminSupportCreditBalance | null>(null);

	// Grant credits form. The real ledger grants a single integer credit amount
	// (shareable, workspace-owned) — not separate AI/storage buckets.
	let grantAmount = $state<number>(0);
	let grantReason = $state("");
	let grantBusy = $state(false);

	// Refund form. The real money-out path requires the original charge id.
	let refundAmountMinor = $state<number>(0);
	let refundCurrency = $state("USD");
	let refundReason = $state("");
	let refundChargeId = $state("");
	let refundBusy = $state(false);

	// ── Money-safe idempotency keys ─────────────────────────────────────────────
	// The backend dedupes a credit grant / refund by idempotencyKey ONLY. So the
	// key must be STABLE across retries of one logical attempt: if the server
	// committed the mint/refund but the client saw a network/timeout/5xx error,
	// the operator re-submits the SAME form and we MUST send the SAME key so the
	// ledger recognises the retry and returns the existing row (no double-mint /
	// double-refund). We rotate to a fresh key ONLY after a confirmed success (so
	// the next, genuinely-new attempt is independent) or on an explicit reset of
	// that form. One persisted key per form; grant and refund are independent.
	const grantIdem = new IdempotencyKeyHolder();
	const refundIdem = new IdempotencyKeyHolder();

	function resetGrantForm() {
		grantAmount = 0;
		grantReason = "";
		// Genuinely-new attempt -> fresh dedupe key.
		grantIdem.rotate();
	}

	function resetRefundForm() {
		refundAmountMinor = 0;
		refundReason = "";
		refundChargeId = "";
		refundIdem.rotate();
	}

	// Impersonate form
	let impersonateUserId = $state("");
	let impersonateReason = $state("");
	let impersonateBusy = $state(false);
	let activeImpersonation = $state<{ id: string } | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			detail = (await getWorkspace(workspaceId)) as Detail;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "โหลด workspace ไม่สำเร็จ";
		} finally {
			loading = false;
		}
		// Pull the live credit balance from the support customer-360 lookup (the
		// authoritative ledger). Best-effort: a failure here must not blank the page.
		void refreshBalance();
	}

	async function refreshBalance() {
		try {
			const snapshot = await adminSupportApi.lookup(workspaceId);
			creditBalance = snapshot.creditBalance;
		} catch {
			// Leave the previous balance (or null) on a lookup failure — the page still
			// renders identity/billing/grants.
		}
	}

	onMount(load);

	function setMessage(kind: "ok" | "error", text: string) {
		actionMessage = { kind, text };
		setTimeout(() => {
			if (actionMessage?.text === text) actionMessage = null;
		}, 6000);
	}

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	async function submitGrant(event: SubmitEvent) {
		event.preventDefault();
		// Busy guard: a double-click never fires two grants (and the per-submit
		// idempotency key below means even a duplicate request can't double-mint).
		if (grantBusy) return;
		if (!grantReason.trim()) {
			setMessage("error", "กรุณากรอกเหตุผลการให้เครดิต");
			return;
		}
		if (!Number.isInteger(grantAmount) || grantAmount < 1) {
			setMessage("error", "ต้องระบุจำนวนเครดิต (จำนวนเต็ม ≥ 1)");
			return;
		}
		grantBusy = true;
		try {
			const result = await adminSupportApi.grantCredits(workspaceId, {
				amount: grantAmount,
				reason: grantReason.trim(),
				// Shareable (workspace-owned) goodwill credits.
				creditClass: "shareable",
				// STABLE dedupe key for THIS attempt: reused on every retry so a
				// failed-but-committed grant retried under the same form never
				// double-mints (the ledger returns the existing grant). Rotated only
				// after the confirmed success below (or an explicit form reset).
				idempotencyKey: grantIdem.current,
			});
			setMessage("ok", `เพิ่มเครดิตจริง +${result.grant.amount} เข้า ledger เรียบร้อย`);
			// CONFIRMED success → clear fields AND rotate to a fresh key so the next
			// grant is a genuinely-new, independently-deduped attempt.
			resetGrantForm();
			// Reload identity/grants + the live balance so the mint is visible.
			void load();
		} catch (cause) {
			// Failure (incl. network/timeout/5xx): keep grantIdem.current UNCHANGED so the
			// operator's retry of this same form carries the same key → backend dedupe
			// recognises a possibly-committed request and won't double-mint.
			setMessage("error", describeError(cause));
		} finally {
			grantBusy = false;
		}
	}

	async function submitRefund(event: SubmitEvent) {
		event.preventDefault();
		if (refundBusy) return;
		if (!refundReason.trim() || refundAmountMinor <= 0) {
			setMessage("error", "ต้องระบุจำนวน + เหตุผล");
			return;
		}
		if (!refundChargeId.trim()) {
			setMessage("error", "ต้องระบุ charge id เดิม (เพื่อความปลอดภัยของการคืนเงิน)");
			return;
		}
		refundBusy = true;
		try {
			const result = await adminSupportApi.refund(workspaceId, {
				amountMinor: Math.round(refundAmountMinor),
				currency: refundCurrency.trim().toUpperCase() || "USD",
				reason: refundReason.trim(),
				dodoChargeId: refundChargeId.trim(),
				// STABLE dedupe ref for THIS attempt: reused on every retry so a
				// failed-but-committed refund retried under the same form never
				// double-refunds (the backend returns the existing refund). Rotated
				// only after the confirmed success below (or an explicit form reset).
				idempotencyKey: refundIdem.current,
			});
			setMessage(
				"ok",
				`คืนเงินจริงสำเร็จ ${(result.refund.amountCents / 100).toFixed(2)} ${result.refund.currency ?? refundCurrency}`,
			);
			// CONFIRMED success → clear fields AND rotate to a fresh key.
			resetRefundForm();
			void load();
		} catch (cause) {
			// Failure (incl. network/timeout/5xx): keep refundIdem.current UNCHANGED so the
			// operator's retry carries the same key → backend dedupe recognises a
			// possibly-committed refund and won't double-refund.
			setMessage("error", describeError(cause));
		} finally {
			refundBusy = false;
		}
	}

	async function submitImpersonate(event: SubmitEvent) {
		event.preventDefault();
		if (!impersonateUserId.trim() || !impersonateReason.trim()) {
			setMessage("error", "ต้องระบุ user id + เหตุผล");
			return;
		}
		impersonateBusy = true;
		try {
			const result = (await impersonate(workspaceId, {
				userId: impersonateUserId.trim(),
				reason: impersonateReason.trim(),
			})) as { event?: { id: string } };
			if (result?.event?.id) {
				activeImpersonation = { id: result.event.id };
				setMessage("ok", `เริ่ม impersonation แล้ว (${result.event.id.slice(0, 8)}…)`);
			} else {
				setMessage("ok", "เริ่ม impersonation แล้ว");
			}
			impersonateReason = "";
			impersonateUserId = "";
		} catch (cause) {
			setMessage("error", describeError(cause));
		} finally {
			impersonateBusy = false;
		}
	}

	async function endImpersonation() {
		if (!activeImpersonation) return;
		impersonateBusy = true;
		try {
			await stopImpersonation(activeImpersonation.id);
			setMessage("ok", "ปิด session impersonation เรียบร้อย");
			activeImpersonation = null;
		} catch (cause) {
			setMessage("error", describeError(cause));
		} finally {
			impersonateBusy = false;
		}
	}
</script>

<header class="page-head">
	<div>
		<a class="back" href="/admin/workspaces">&larr; Workspaces</a>
		<h1>Workspace · <code>{workspaceId}</code></h1>
		<p class="page-sub">ดูข้อมูล plan / grants และดำเนินการ refund / grant / impersonate</p>
	</div>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void load()} disabled={loading}>รีเฟรช</button>
</header>

{#if error}
	<p class="alert error" role="alert">{error}</p>
{/if}

{#if actionMessage}
	<p class="alert {actionMessage.kind}" role="status">{actionMessage.text}</p>
{/if}

{#if loading && !detail}
	<p class="muted">กำลังโหลด…</p>
{:else if detail}
	<section class="grid">
		<article class="card ws-panel">
			<header><h2>ข้อมูล Workspace</h2></header>
			<dl>
				<div><dt>ชื่อ</dt><dd>{detail.workspace?.name ?? workspaceId}</dd></div>
				<div><dt>เจ้าของ</dt><dd>{detail.workspace?.ownerUserId ?? "—"}</dd></div>
				<div><dt>สมาชิก</dt><dd>{detail.workspace?.memberCount ?? "—"}</dd></div>
				<div><dt>สร้างเมื่อ</dt><dd>{detail.workspace?.createdAt ? new Date(detail.workspace.createdAt).toLocaleString() : "—"}</dd></div>
			</dl>
		</article>

		<article class="card ws-panel">
			<header><h2>Billing</h2></header>
			<dl>
				<div><dt>แผน</dt><dd><span class="pill">{detail.billing?.planId ?? "—"}</span></dd></div>
				<div><dt>สถานะ</dt><dd><span class="pill pill-{detail.billing?.status ?? 'unknown'}">{detail.billing?.status ?? "—"}</span></dd></div>
				<div><dt>Billing email</dt><dd>{detail.billing?.billingEmail ?? "—"}</dd></div>
				<div><dt>Dodo customer</dt><dd><code>{detail.billing?.dodoCustomerId ?? "—"}</code></dd></div>
				<div><dt>Dodo subscription</dt><dd><code>{detail.billing?.dodoSubscriptionId ?? "—"}</code></dd></div>
			</dl>
		</article>

		<article class="card ws-panel">
			<header><h2>Credit balance (ledger จริง)</h2></header>
			{#if creditBalance}
				<dl>
					<div><dt>รวมทั้งหมด</dt><dd><strong>{creditBalance.total}</strong> เครดิต</dd></div>
					<div><dt>Shareable</dt><dd>{creditBalance.shareable}</dd></div>
					<div><dt>Personal</dt><dd>{creditBalance.personal}</dd></div>
				</dl>
			{:else}
				<p class="muted">กำลังโหลดยอดเครดิต…</p>
			{/if}
		</article>

		<article class="card ws-panel">
			<header><h2>Active grants</h2></header>
			{#if !detail.grants || detail.grants.length === 0}
				<p class="muted">ยังไม่มี grant ค้างอยู่</p>
			{:else}
				<ul class="grants">
					{#each detail.grants as grant (grant.id)}
						<li>
							<div class="grant-head">
								<strong>{grant.kind ?? "credit"}</strong>
								<small>{grant.createdAt ? new Date(grant.createdAt).toLocaleDateString() : ""}</small>
							</div>
							<div class="grant-meta">
								{#if grant.aiCredits}<span>AI: {grant.aiCredits}</span>{/if}
								{#if grant.storageBytes}<span>Storage: {Math.round((grant.storageBytes ?? 0) / 1024 / 1024)}MB</span>{/if}
								{#if grant.expiresAt}<span>หมดอายุ {new Date(grant.expiresAt).toLocaleDateString()}</span>{/if}
							</div>
							{#if grant.reason}<p class="grant-reason">{grant.reason}</p>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</article>
	</section>

	<section class="grid">
		<article class="card ws-panel">
			<header><h2>ให้เครดิต (mint จริง)</h2></header>
			<form onsubmit={submitGrant} class="form">
				<label>จำนวนเครดิต<input class="input" type="number" min="1" step="1" bind:value={grantAmount} /></label>
				<label>เหตุผล<textarea class="input" required bind:value={grantReason} rows="2" placeholder="เช่น goodwill comp สำหรับ downtime"></textarea></label>
				<div class="form-actions">
					<button type="submit" class="btn primary ws-grad-primary" disabled={grantBusy}>{grantBusy ? "กำลังเพิ่ม…" : "เพิ่มเครดิตเข้า ledger"}</button>
					<button type="button" class="btn ghost ws-btn-ghost" onclick={resetGrantForm} disabled={grantBusy}>ล้าง / เริ่มใหม่</button>
				</div>
			</form>
		</article>

		<article class="card ws-panel">
			<header><h2>Refund (เงินออกจริง)</h2></header>
			<form onsubmit={submitRefund} class="form">
				<label>จำนวน (หน่วยเล็ก เช่น cents/satang)<input class="input" type="number" min="1" bind:value={refundAmountMinor} /></label>
				<label>สกุลเงิน<input class="input" type="text" maxlength="8" bind:value={refundCurrency} /></label>
				<label>Charge id เดิม (จำเป็น)<input class="input" type="text" required bind:value={refundChargeId} placeholder="ch_…" /></label>
				<label>เหตุผล<textarea class="input" required bind:value={refundReason} rows="2"></textarea></label>
				<div class="form-actions">
					<button type="submit" class="btn primary ws-grad-primary" disabled={refundBusy}>{refundBusy ? "กำลังคืนเงิน…" : "คืนเงินจริง"}</button>
					<button type="button" class="btn ghost ws-btn-ghost" onclick={resetRefundForm} disabled={refundBusy}>ล้าง / เริ่มใหม่</button>
				</div>
			</form>
		</article>

		<article class="card ws-panel">
			<header><h2>Impersonate member</h2></header>
			<form onsubmit={submitImpersonate} class="form">
				<label>User id<input class="input" type="text" bind:value={impersonateUserId} required placeholder="usr_…" /></label>
				<label>เหตุผล<textarea class="input" required bind:value={impersonateReason} rows="2" placeholder="เช่น 'ช่วย debug crop offset ของ chapter 12'"></textarea></label>
				<button type="submit" class="btn primary ws-grad-primary" disabled={impersonateBusy}>เริ่ม impersonation</button>
			</form>
			{#if activeImpersonation}
				<div class="impersonation-active">
					<span class="pulse"></span>
					<span>Active session <code>{activeImpersonation.id}</code></span>
					<button type="button" class="btn ghost ws-btn-ghost" onclick={endImpersonation} disabled={impersonateBusy}>ปิด session</button>
				</div>
			{/if}
		</article>
	</section>
{/if}

<style>
	.page-head {
		display: flex;
		gap: 12px;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}
	.page-head h1 {
		font-size: 22px;
		margin: 4px 0 0;
		color: var(--color-ws-ink);
	}
	.page-head h1 code {
		font-size: 14px;
		color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent);
	}
	.page-sub {
		margin: 4px 0 0;
		color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent);
		font-size: 13px;
	}
	.back {
		font-size: 12.5px;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		text-decoration: none;
	}
	.back:hover { color: var(--color-ws-ink); }
	.btn {
		min-height: 36px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 14px;
		font-size: 13px;
		cursor: pointer;
	}
	.btn:hover { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.55; cursor: progress; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-rose) 100%);
		border-color: transparent;
	}
	.btn.primary:hover { filter: brightness(1.08); }
	.btn.ghost {
		background: transparent;
	}
	.alert {
		font-size: 13px;
		padding: 10px 12px;
		border-radius: var(--radius-ws-ctrl);
		margin-bottom: 12px;
	}
	.alert.error {
		color: var(--color-ws-rose);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}
	.alert.ok {
		color: var(--color-ws-green);
		background: color-mix(in srgb, var(--color-ws-green) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 18%, transparent);
	}
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 13px; }
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 14px;
		margin-bottom: 18px;
	}
	.card {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 16px 16px 18px;
	}
	.card > header h2 {
		margin: 0 0 12px;
		font-size: 14px;
		color: var(--color-ws-ink);
	}
	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1.5fr;
		gap: 8px 10px;
		font-size: 12.5px;
	}
	dl > div { display: contents; }
	dt {
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
	}
	dd { margin: 0; color: var(--color-ws-ink); }
	dd code { font-size: 11.5px; color: color-mix(in srgb, var(--color-ws-ink) 78%, transparent); word-break: break-all; }
	.pill {
		display: inline-block;
		padding: 2px 8px;
		font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
	}
	.pill-active, .pill-mock_active { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-past_due { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-cancelled { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.grants {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.grants li {
		background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 10px 12px;
	}
	.grant-head { display: flex; justify-content: space-between; }
	.grant-head strong { font-size: 12.5px; color: var(--color-ws-ink); }
	.grant-head small { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 11.5px; }
	.grant-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 4px;
		font-size: 11.5px;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
	}
	.grant-reason { margin: 6px 0 0; font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); }
	.form {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.form label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent);
	}
	.form-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.input {
		min-height: 36px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
		width: 100%;
		box-sizing: border-box;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	textarea.input { resize: vertical; min-height: 60px; }
	.impersonation-active {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
		font-size: 12.5px;
		background: color-mix(in srgb, var(--color-ws-violet) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 25%, transparent);
		padding: 8px 10px;
		border-radius: var(--radius-ws-ctrl);
	}
	.impersonation-active code {
		color: color-mix(in srgb, var(--color-ws-ink) 80%, transparent);
		font-size: 11px;
		word-break: break-all;
		flex: 1;
	}
	.pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-ws-violet);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.6; transform: scale(1.4); }
	}
</style>
