<!--
Admin coupons.

Two families share this page (matching backend/src/routes/admin/coupons.ts):
  1. Dodo discount coupons — a percentage off a Dodo invoice. Dodo only supports
     percentage discounts here, so the create form is percent-only; the table
     surfaces the read-only `type` Dodo returns rather than inventing an amount /
     currency input the API can't accept.
  2. Internal credit-coupons — promo codes that grant spendable credits. The
     generator can auto-mint a code; we show it back with copy-to-clipboard so the
     operator can hand it out immediately.

Reads need admin:coupons.read (the nav section only renders for those roles).
Writes (create / deactivate) need admin:coupons.write — we read GET /api/admin/me
and disable the write affordances when the role lacks it, but the backend stays
authoritative and 403s regardless. Styling mirrors the rest of /admin (users,
workspaces): self-contained dark-shell tokens, no new shared files.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { adminCouponsApi, getAdminMe, AdminApiError } from "$lib/api/admin.ts";
	// Types live in the coupons barrel and are not re-exported through the shared
	// api/admin.ts index (which only re-exports the `adminCouponsApi` value), so we
	// import them directly here rather than editing the shared index file.
	import type { DodoDiscount, CreditCoupon, CreditCouponClass } from "$lib/api/admin/coupons.ts";
	import { dialogFocus } from "$lib/components/Dialog.svelte";

	type Tab = "dodo" | "credit";

	let activeTab = $state<Tab>("dodo");
	let canWrite = $state(false);

	// ── Dodo discounts ────────────────────────────────────────────
	let dodoRows = $state<DodoDiscount[]>([]);
	let dodoLoading = $state(true);
	let dodoError = $state<string | null>(null);
	let dodoBusyId = $state<string | null>(null);

	// ── Credit coupons ────────────────────────────────────────────
	let creditRows = $state<CreditCoupon[]>([]);
	let creditLoading = $state(true);
	let creditError = $state<string | null>(null);
	let creditBusyId = $state<string | null>(null);

	// ── Toast ─────────────────────────────────────────────────────
	let toast = $state<{ kind: "ok" | "error"; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	function notify(kind: "ok" | "error", text: string): void {
		toast = { kind, text };
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast = null;
		}, 5000);
	}

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	// ── Loaders ───────────────────────────────────────────────────
	async function loadDodo() {
		dodoLoading = true;
		dodoError = null;
		try {
			const result = await adminCouponsApi.listDodoDiscounts({ pageSize: 100 });
			dodoRows = result.discounts;
		} catch (cause) {
			dodoError = describeError(cause);
		} finally {
			dodoLoading = false;
		}
	}

	async function loadCredit() {
		creditLoading = true;
		creditError = null;
		try {
			const result = await adminCouponsApi.listCreditCoupons(100);
			creditRows = result.coupons;
		} catch (cause) {
			creditError = describeError(cause);
		} finally {
			creditLoading = false;
		}
	}

	onMount(async () => {
		// The shell already gated admin:access; we only need the write permission
		// to decide which affordances to render. A failure here just hides writes.
		try {
			const me = await getAdminMe();
			canWrite = me.permissions.includes("admin:coupons.write");
		} catch {
			canWrite = false;
		}
		void loadDodo();
		void loadCredit();
	});

	// ── Formatting helpers ────────────────────────────────────────
	function fmtDate(value: string | null | undefined): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
	}

	function fmtCredits(amount: number): string {
		return new Intl.NumberFormat().format(amount);
	}

	function dodoExpired(d: DodoDiscount): boolean {
		return Boolean(d.expiresAt) && new Date(d.expiresAt as string).getTime() < Date.now();
	}

	function creditExpired(c: CreditCoupon): boolean {
		return Boolean(c.expiresAt) && new Date(c.expiresAt as string).getTime() < Date.now();
	}

	// ── Create discount modal ─────────────────────────────────────
	let showDodoModal = $state(false);
	let dodoForm = $state({ percentOff: "", code: "", name: "", expiresAt: "", usageLimit: "" });
	let dodoFieldErrors = $state<Record<string, string>>({});
	let dodoSubmitting = $state(false);

	function openDodoModal() {
		dodoForm = { percentOff: "", code: "", name: "", expiresAt: "", usageLimit: "" };
		dodoFieldErrors = {};
		showDodoModal = true;
	}

	function validateDodo(): boolean {
		const errors: Record<string, string> = {};
		// `bind:value` on <input type="number"> hands back a number (or empty string),
		// so coerce with String(...) before .trim() — calling .trim() on a number throws
		// and would abort the whole submit before any field error could render.
		const percentOff = String(dodoForm.percentOff ?? "").trim();
		const usageLimit = String(dodoForm.usageLimit ?? "").trim();
		const pct = Number(percentOff);
		if (!percentOff || Number.isNaN(pct)) {
			errors.percentOff = "ต้องระบุเปอร์เซ็นต์ส่วนลด";
		} else if (pct <= 0 || pct > 100) {
			errors.percentOff = "ต้องอยู่ระหว่าง 0 (ไม่รวม) ถึง 100";
		}
		if (dodoForm.code.trim()) {
			const len = dodoForm.code.trim().length;
			if (len < 3 || len > 16) errors.code = "โค้ดต้องยาว 3–16 ตัวอักษร";
		}
		if (usageLimit) {
			const lim = Number(usageLimit);
			if (!Number.isInteger(lim) || lim < 1) errors.usageLimit = "ต้องเป็นจำนวนเต็ม ≥ 1";
		}
		dodoFieldErrors = errors;
		return Object.keys(errors).length === 0;
	}

	async function submitDodo(event: SubmitEvent) {
		event.preventDefault();
		if (!canWrite || dodoSubmitting) return;
		if (!validateDodo()) return;
		dodoSubmitting = true;
		try {
			const usageLimit = String(dodoForm.usageLimit ?? "").trim();
			const payload = {
				percentOff: Number(dodoForm.percentOff),
				...(dodoForm.code.trim() ? { code: dodoForm.code.trim() } : {}),
				...(dodoForm.name.trim() ? { name: dodoForm.name.trim() } : {}),
				...(dodoForm.expiresAt ? { expiresAt: new Date(dodoForm.expiresAt).toISOString() } : {}),
				...(usageLimit ? { usageLimit: Number(usageLimit) } : {}),
			};
			const { discount } = await adminCouponsApi.createDodoDiscount(payload);
			notify("ok", `สร้างส่วนลด ${discount.code} (${discount.percentOff}%) แล้ว`);
			showDodoModal = false;
			void loadDodo();
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			dodoSubmitting = false;
		}
	}

	async function deactivateDodo(d: DodoDiscount) {
		if (!canWrite || dodoBusyId) return;
		const confirmed = window.confirm(`ปิดใช้งานส่วนลด ${d.code}? โค้ดนี้จะถูกลบออกจาก Dodo`);
		if (!confirmed) return;
		dodoBusyId = d.discountId;
		try {
			await adminCouponsApi.deleteDodoDiscount(d.discountId);
			notify("ok", `ปิดใช้งานส่วนลด ${d.code} แล้ว`);
			dodoRows = dodoRows.filter((row) => row.discountId !== d.discountId);
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			dodoBusyId = null;
		}
	}

	// ── Generate credit coupon modal ──────────────────────────────
	let showCreditModal = $state(false);
	let creditForm = $state({
		creditAmount: "",
		code: "",
		creditClass: "shareable" as CreditCouponClass,
		maxRedemptions: "",
		perUserLimit: "1",
		expiresAt: "",
		note: "",
	});
	let creditFieldErrors = $state<Record<string, string>>({});
	let creditCodeError = $derived.by(() => {
		const code = creditForm.code.trim();
		if (!code) return "";
		if (!/^[A-Z0-9-]{4,32}$/.test(code.toUpperCase())) {
			return "โค้ดต้องยาว 4–32 ตัว ใช้ได้เฉพาะ A-Z, 0-9 และ '-'";
		}
		return "";
	});
	let creditSubmitting = $state(false);
	let lastGeneratedCode = $state<string | null>(null);
	let copied = $state(false);

	function openCreditModal() {
		creditForm = {
			creditAmount: "",
			code: "",
			creditClass: "shareable",
			maxRedemptions: "",
			perUserLimit: "1",
			expiresAt: "",
			note: "",
		};
		creditFieldErrors = {};
		lastGeneratedCode = null;
		copied = false;
		showCreditModal = true;
	}

	function validateCredit(): boolean {
		const errors: Record<string, string> = {};
		// `bind:value` on <input type="number"> yields a number (or empty string), so
		// coerce with String(...) before .trim() — .trim() on a number throws and would
		// abort submit before any field error (incl. the code check below) could show.
		const creditAmount = String(creditForm.creditAmount ?? "").trim();
		const maxRedemptions = String(creditForm.maxRedemptions ?? "").trim();
		const perUserLimit = String(creditForm.perUserLimit ?? "").trim();
		const amount = Number(creditAmount);
		if (!creditAmount || Number.isNaN(amount)) {
			errors.creditAmount = "ต้องระบุจำนวนเครดิต";
		} else if (!Number.isInteger(amount) || amount <= 0) {
			errors.creditAmount = "ต้องเป็นจำนวนเต็มบวก";
		} else if (amount > 10_000_000) {
			errors.creditAmount = "จำนวนเครดิตสูงเกินไป";
		}
		if (creditForm.code.trim()) {
			// Mirror the backend rule (credit-coupons.ts CODE_RE): the server upper-cases
			// the trimmed code before testing /^[A-Z0-9-]{4,32}$/, so validate the
			// upper-cased form here too — lowercase input is fine, but spaces / other
			// punctuation are rejected client-side instead of round-tripping to a 400.
			if (!/^[A-Z0-9-]{4,32}$/.test(creditForm.code.trim().toUpperCase())) {
				errors.code = "โค้ดต้องยาว 4–32 ตัว ใช้ได้เฉพาะ A-Z, 0-9 และ '-'";
			}
		}
		if (maxRedemptions) {
			const max = Number(maxRedemptions);
			if (!Number.isInteger(max) || max < 1) errors.maxRedemptions = "ต้องเป็นจำนวนเต็ม ≥ 1";
		}
		const perUser = Number(perUserLimit);
		if (!perUserLimit || !Number.isInteger(perUser) || perUser < 1) {
			errors.perUserLimit = "ต้องเป็นจำนวนเต็ม ≥ 1";
		}
		creditFieldErrors = errors;
		return Object.keys(errors).length === 0;
	}

	async function submitCredit(event: SubmitEvent) {
		event.preventDefault();
		if (!canWrite || creditSubmitting) return;
		if (!validateCredit()) return;
		creditSubmitting = true;
		try {
			const maxRedemptions = String(creditForm.maxRedemptions ?? "").trim();
			const payload = {
				creditAmount: Number(creditForm.creditAmount),
				creditClass: creditForm.creditClass,
				perUserLimit: Number(creditForm.perUserLimit),
				...(creditForm.code.trim() ? { code: creditForm.code.trim() } : {}),
				...(maxRedemptions ? { maxRedemptions: Number(maxRedemptions) } : {}),
				...(creditForm.expiresAt ? { expiresAt: new Date(creditForm.expiresAt).toISOString() } : {}),
				...(creditForm.note.trim() ? { note: creditForm.note.trim() } : {}),
			};
			const { coupon } = await adminCouponsApi.createCreditCoupon(payload);
			lastGeneratedCode = coupon.code;
			copied = false;
			notify("ok", `สร้างคูปองเครดิต ${coupon.code} แล้ว`);
			void loadCredit();
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			creditSubmitting = false;
		}
	}

	async function copyCode() {
		if (!lastGeneratedCode) return;
		try {
			await navigator.clipboard.writeText(lastGeneratedCode);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			notify("error", "คัดลอกไม่สำเร็จ — กรุณาคัดลอกด้วยตนเอง");
		}
	}

	async function deactivateCredit(c: CreditCoupon) {
		if (!canWrite || creditBusyId) return;
		const confirmed = window.confirm(`ปิดใช้งานคูปอง ${c.code}? ผู้ใช้จะแลกไม่ได้อีก`);
		if (!confirmed) return;
		creditBusyId = c.id;
		try {
			const { coupon } = await adminCouponsApi.disableCreditCoupon(c.id);
			creditRows = creditRows.map((row) => (row.id === c.id ? coupon : row));
			notify("ok", `ปิดใช้งานคูปอง ${c.code} แล้ว`);
		} catch (cause) {
			notify("error", describeError(cause));
		} finally {
			creditBusyId = null;
		}
	}
</script>

<header class="page-head">
	<div>
		<h1>Coupons</h1>
		<p class="page-sub">ส่วนลด Dodo และคูปองเครดิตภายใน — สร้าง / ปิดใช้งานพร้อมบันทึก admin audit</p>
	</div>
	{#if !canWrite}
		<span class="readonly-badge" title="role นี้อ่านได้อย่างเดียว (ขาด admin:coupons.write)">อ่านอย่างเดียว</span>
	{/if}
</header>

{#if toast}
	<p class="alert {toast.kind}" role="status">{toast.text}</p>
{/if}

<div class="tabs" role="tablist" aria-label="ประเภทคูปอง">
	<button
		type="button"
		role="tab"
		aria-selected={activeTab === "dodo"}
		class="tab"
		data-active={activeTab === "dodo"}
		onclick={() => (activeTab = "dodo")}
	>
		Dodo discounts
		<span class="tab-count">{dodoRows.length}</span>
	</button>
	<button
		type="button"
		role="tab"
		aria-selected={activeTab === "credit"}
		class="tab"
		data-active={activeTab === "credit"}
		onclick={() => (activeTab = "credit")}
	>
		Credit coupons
		<span class="tab-count">{creditRows.length}</span>
	</button>
</div>

{#if activeTab === "dodo"}
	<section aria-label="Dodo discount coupons">
		<div class="section-bar">
			<p class="section-note">ส่วนลดเป็นเปอร์เซ็นต์บนใบแจ้งหนี้ Dodo (Dodo รองรับเฉพาะแบบเปอร์เซ็นต์)</p>
			<div class="section-actions">
				<button type="button" class="btn ws-btn-ghost" onclick={() => void loadDodo()} disabled={dodoLoading}>รีเฟรช</button>
				<button
					type="button"
					class="btn primary ws-grad-primary"
					onclick={openDodoModal}
					disabled={!canWrite}
					title={canWrite ? "" : "ต้องมีสิทธิ์ admin:coupons.write"}
				>+ Create discount</button>
			</div>
		</div>

		{#if dodoError}
			<p class="alert error" role="alert">{dodoError}</p>
		{/if}

		<div class="table-wrap ws-panel" role="region" aria-label="ตารางส่วนลด Dodo">
			<table>
				<thead>
					<tr>
						<th>Code</th>
						<th>Type</th>
						<th>Percent off</th>
						<th>Expiry</th>
						<th>Max redemptions</th>
						<th>Used</th>
						<th>Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#if dodoLoading}
						<tr><td colspan="8" class="empty">กำลังโหลด…</td></tr>
					{:else if dodoError}
						<!-- Load failed: the error alert above is the only state we show.
						     Don't render the "no discounts" empty row — an empty list here
						     means "failed to load", not "there are zero discounts". -->
						<tr><td colspan="8" class="empty">โหลดส่วนลดไม่สำเร็จ</td></tr>
					{:else if dodoRows.length === 0}
						<tr><td colspan="8" class="empty">ยังไม่มีส่วนลด Dodo — กด “Create discount” เพื่อสร้างใหม่</td></tr>
					{:else}
						{#each dodoRows as d (d.discountId)}
							<tr>
								<td><div class="cell-stack"><strong>{d.code}</strong>{#if d.name}<span class="muted">{d.name}</span>{/if}</div></td>
								<td><span class="pill">{d.type}</span></td>
								<td>{d.percentOff}%</td>
								<td class="muted">{fmtDate(d.expiresAt)}</td>
								<td class="muted">{d.usageLimit ?? "ไม่จำกัด"}</td>
								<td class="muted">{d.timesUsed}</td>
								<td>
									{#if dodoExpired(d)}
										<span class="pill pill-expired">expired</span>
									{:else}
										<span class="pill pill-active">active</span>
									{/if}
								</td>
								<td class="actions">
									<button
										type="button"
										class="link danger"
										onclick={() => void deactivateDodo(d)}
										disabled={!canWrite || dodoBusyId === d.discountId}
										title={canWrite ? "" : "ต้องมีสิทธิ์ admin:coupons.write"}
									>deactivate</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
{:else}
	<section aria-label="Internal credit coupons">
		<div class="section-bar">
			<p class="section-note">คูปองโปรโมชันที่ให้เครดิตใช้งานภายใน (personal / shareable)</p>
			<div class="section-actions">
				<button type="button" class="btn ws-btn-ghost" onclick={() => void loadCredit()} disabled={creditLoading}>รีเฟรช</button>
				<button
					type="button"
					class="btn primary ws-grad-primary"
					onclick={openCreditModal}
					disabled={!canWrite}
					title={canWrite ? "" : "ต้องมีสิทธิ์ admin:coupons.write"}
				>+ Generate credit coupon</button>
			</div>
		</div>

		{#if creditError}
			<p class="alert error" role="alert">{creditError}</p>
		{/if}

		<div class="table-wrap ws-panel" role="region" aria-label="ตารางคูปองเครดิต">
			<table>
				<thead>
					<tr>
						<th>Code</th>
						<th>Credit</th>
						<th>Class</th>
						<th>Max redemptions</th>
						<th>Per-user</th>
						<th>Redeemed</th>
						<th>Expiry</th>
						<th>Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#if creditLoading}
						<tr><td colspan="9" class="empty">กำลังโหลด…</td></tr>
					{:else if creditRows.length === 0}
						<tr><td colspan="9" class="empty">ยังไม่มีคูปองเครดิต — กด “Generate credit coupon” เพื่อสร้างใหม่</td></tr>
					{:else}
						{#each creditRows as c (c.id)}
							<tr>
								<td><div class="cell-stack"><strong>{c.code}</strong>{#if c.note}<span class="muted">{c.note}</span>{/if}</div></td>
								<td>{fmtCredits(c.creditAmount)}</td>
								<td><span class="pill pill-class-{c.creditClass}">{c.creditClass}</span></td>
								<td class="muted">{c.maxRedemptions ?? "ไม่จำกัด"}</td>
								<td class="muted">{c.perUserLimit}</td>
								<td class="muted">{c.redemptionCount ?? 0}</td>
								<td class="muted">{fmtDate(c.expiresAt)}</td>
								<td>
									{#if c.status === "disabled"}
										<span class="pill pill-disabled">disabled</span>
									{:else if creditExpired(c)}
										<span class="pill pill-expired">expired</span>
									{:else}
										<span class="pill pill-active">active</span>
									{/if}
								</td>
								<td class="actions">
									<button
										type="button"
										class="link danger"
										onclick={() => void deactivateCredit(c)}
										disabled={!canWrite || c.status === "disabled" || creditBusyId === c.id}
										title={canWrite ? "" : "ต้องมีสิทธิ์ admin:coupons.write"}
									>deactivate</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<!-- ── Create discount modal ──────────────────────────────────── -->
{#if showDodoModal}
	<div class="cw-modal-backdrop" role="presentation">
		<button
			type="button"
			class="cw-modal-backdrop-close"
			aria-label="ปิดหน้าต่าง"
			tabindex="-1"
			onclick={() => (showDodoModal = false)}
		></button>
		<div
			class="cw-modal ws-panel"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="dodo-modal-title"
			use:dialogFocus={{ onEscape: () => (showDodoModal = false), busy: dodoSubmitting }}
		>
			<header class="cw-modal-head">
				<h2 id="dodo-modal-title">Create Dodo discount</h2>
				<button type="button" class="cw-modal-close" aria-label="ปิด" onclick={() => (showDodoModal = false)}>×</button>
			</header>
			<form class="form" onsubmit={submitDodo}>
				<label>
					Percent off <span class="req">*</span>
					<input
						class="input"
						class:invalid={dodoFieldErrors.percentOff}
						type="number"
						step="0.01"
						min="0.01"
						max="100"
						placeholder="เช่น 20"
						bind:value={dodoForm.percentOff}
					/>
					{#if dodoFieldErrors.percentOff}<span class="field-error">{dodoFieldErrors.percentOff}</span>{/if}
				</label>
				<label>
					Code (ไม่ระบุ = สุ่มให้)
					<input
						class="input"
						class:invalid={dodoFieldErrors.code}
						type="text"
						maxlength="16"
						placeholder="เช่น LAUNCH20"
						bind:value={dodoForm.code}
					/>
					{#if dodoFieldErrors.code}<span class="field-error">{dodoFieldErrors.code}</span>{/if}
				</label>
				<label>
					Name (ภายใน)
					<input class="input" type="text" maxlength="120" placeholder="ป้ายกำกับสำหรับทีม" bind:value={dodoForm.name} />
				</label>
				<div class="form-row">
					<label>
						Expiry
						<input class="input" type="date" bind:value={dodoForm.expiresAt} />
					</label>
					<label>
						Max redemptions
						<input
							class="input"
							class:invalid={dodoFieldErrors.usageLimit}
							type="number"
							min="1"
							step="1"
							placeholder="ไม่จำกัด"
							bind:value={dodoForm.usageLimit}
						/>
						{#if dodoFieldErrors.usageLimit}<span class="field-error">{dodoFieldErrors.usageLimit}</span>{/if}
					</label>
				</div>
				<footer class="cw-modal-foot">
					<button type="button" class="btn ghost ws-btn-ghost" onclick={() => (showDodoModal = false)}>ยกเลิก</button>
					<button type="submit" class="btn primary ws-grad-primary" disabled={dodoSubmitting}>
						{dodoSubmitting ? "กำลังสร้าง…" : "Create discount"}
					</button>
				</footer>
			</form>
		</div>
	</div>
{/if}

<!-- ── Generate credit coupon modal ───────────────────────────── -->
{#if showCreditModal}
	<div class="cw-modal-backdrop" role="presentation">
		<button
			type="button"
			class="cw-modal-backdrop-close"
			aria-label="ปิดหน้าต่าง"
			tabindex="-1"
			onclick={() => (showCreditModal = false)}
		></button>
		<div
			class="cw-modal ws-panel"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="credit-modal-title"
			use:dialogFocus={{ onEscape: () => (showCreditModal = false), busy: creditSubmitting }}
		>
			<header class="cw-modal-head">
				<h2 id="credit-modal-title">Generate credit coupon</h2>
				<button type="button" class="cw-modal-close" aria-label="ปิด" onclick={() => (showCreditModal = false)}>×</button>
			</header>

			{#if lastGeneratedCode}
				<div class="generated">
					<span class="generated-label">สร้างคูปองแล้ว — โค้ด:</span>
					<div class="generated-row">
						<code class="generated-code">{lastGeneratedCode}</code>
						<button type="button" class="btn ws-btn-ghost" onclick={() => void copyCode()}>{copied ? "คัดลอกแล้ว ✓" : "Copy"}</button>
					</div>
					<button type="button" class="btn ghost ws-btn-ghost" onclick={() => (showCreditModal = false)}>ปิด</button>
				</div>
			{:else}
				<form class="form" onsubmit={submitCredit}>
					<label>
						Credit amount <span class="req">*</span>
						<input
							class="input"
							class:invalid={creditFieldErrors.creditAmount}
							type="number"
							min="1"
							step="1"
							placeholder="เช่น 500"
							bind:value={creditForm.creditAmount}
						/>
						{#if creditFieldErrors.creditAmount}<span class="field-error">{creditFieldErrors.creditAmount}</span>{/if}
					</label>
					<label>
						Code (ไม่ระบุ = สุ่มให้)
						<input
							class="input"
							class:invalid={creditFieldErrors.code || creditCodeError}
							type="text"
							maxlength="32"
							placeholder="เช่น WELCOME500"
							bind:value={creditForm.code}
						/>
						{#if creditFieldErrors.code || creditCodeError}<span class="field-error">{creditFieldErrors.code || creditCodeError}</span>{/if}
					</label>
					<label>
						Class
						<select class="input" bind:value={creditForm.creditClass}>
							<option value="shareable">shareable (ใช้ได้ทั้ง workspace)</option>
							<option value="personal">personal (เครดิตส่วนตัว)</option>
						</select>
					</label>
					<div class="form-row">
						<label>
							Max redemptions
							<input
								class="input"
								class:invalid={creditFieldErrors.maxRedemptions}
								type="number"
								min="1"
								step="1"
								placeholder="ไม่จำกัด"
								bind:value={creditForm.maxRedemptions}
							/>
							{#if creditFieldErrors.maxRedemptions}<span class="field-error">{creditFieldErrors.maxRedemptions}</span>{/if}
						</label>
						<label>
							Per-user limit <span class="req">*</span>
							<input
								class="input"
								class:invalid={creditFieldErrors.perUserLimit}
								type="number"
								min="1"
								step="1"
								bind:value={creditForm.perUserLimit}
							/>
							{#if creditFieldErrors.perUserLimit}<span class="field-error">{creditFieldErrors.perUserLimit}</span>{/if}
						</label>
					</div>
					<label>
						Expiry
						<input class="input" type="date" bind:value={creditForm.expiresAt} />
					</label>
					<label>
						Note (ภายใน)
						<input class="input" type="text" maxlength="1000" placeholder="เช่น แคมเปญต้อนรับ" bind:value={creditForm.note} />
					</label>
					<footer class="cw-modal-foot">
						<button type="button" class="btn ghost ws-btn-ghost" onclick={() => (showCreditModal = false)}>ยกเลิก</button>
						<button type="submit" class="btn primary ws-grad-primary" disabled={creditSubmitting || Boolean(creditCodeError)}>
							{creditSubmitting ? "กำลังสร้าง…" : "Generate coupon"}
						</button>
					</footer>
				</form>
			{/if}
		</div>
	</div>
{/if}

<style>
	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 16px;
		gap: 12px;
		flex-wrap: wrap;
	}
	.page-head h1 { font-size: 22px; margin: 0; color: var(--color-ws-ink); }
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; }
	.readonly-badge {
		font-size: 11.5px;
		color: var(--color-ws-amber);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
		border-radius: 999px;
		padding: 3px 10px;
	}
	.tabs {
		display: flex;
		gap: 4px;
		margin-bottom: 16px;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
	}
	.tab {
		min-height: 36px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent);
		font-size: 13px;
		padding: 10px 14px;
		cursor: pointer;
		transition: color 0.14s ease, border-color 0.14s ease;
	}
	.tab:hover { color: var(--color-ws-ink); }
	.tab[data-active="true"] {
		color: var(--color-ws-ink);
		border-bottom-color: var(--color-ws-rose);
	}
	.tab-count {
		font-size: 11px;
		background: color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
		padding: 1px 7px;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
	}
	.section-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
		flex-wrap: wrap;
	}
	.section-note { margin: 0; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12.5px; }
	.section-actions { display: flex; gap: 8px; }
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
	.btn[disabled] { opacity: 0.55; cursor: not-allowed; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-rose) 100%);
		border-color: transparent;
	}
	.btn.primary:hover { filter: brightness(1.08); }
	.btn.primary[disabled] { filter: none; }
	.btn.ghost { background: transparent; }
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
	.table-wrap {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		overflow-x: auto;
	}
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	th, td {
		padding: 12px 14px;
		text-align: left;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		white-space: nowrap;
	}
	th {
		font-weight: 600;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
	}
	tr:last-child td { border-bottom: none; }
	.cell-stack { display: flex; flex-direction: column; gap: 2px; }
	.cell-stack strong { color: var(--color-ws-ink); }
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.pill {
		display: inline-block;
		padding: 2px 8px;
		font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
	}
	.pill-active { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-disabled { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.pill-expired { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-class-shareable { background: color-mix(in srgb, var(--color-ws-violet) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-violet) 30%, transparent); color: var(--color-ws-violet); }
	.pill-class-personal { background: color-mix(in srgb, var(--color-ws-blue) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-blue) 30%, transparent); color: var(--color-ws-blue); }
	.actions { display: flex; gap: 10px; }
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		background: transparent;
		border: none;
		color: var(--color-ws-violet);
		font-size: 12.5px;
		cursor: pointer;
		padding: 0;
	}
	.link:hover { text-decoration: underline; }
	.link.danger { color: var(--color-ws-rose); }
	.link[disabled] { opacity: 0.4; cursor: not-allowed; text-decoration: none; }
	.empty {
		padding: 32px 14px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		white-space: normal;
	}
	/* ── Modal ── */
	.cw-modal-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 66%, transparent);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 56px 16px;
		z-index: 100;
		overflow-y: auto;
	}
	/* Full-cover dismiss target behind the panel — replaces the former
	   role="button" backdrop so the scrim click-to-close stays, without
	   misusing the backdrop container as an interactive control. */
	.cw-modal-backdrop-close {
		position: absolute;
		inset: 0;
		z-index: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: default;
	}
	.cw-modal {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 480px;
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 18px 20px 20px;
		box-shadow: 0 24px 60px color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
	}
	.cw-modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 14px;
	}
	.cw-modal-head h2 { margin: 0; font-size: 16px; color: var(--color-ws-ink); }
	.cw-modal-close {
		min-height: 36px;
		min-width: 36px;
		background: transparent;
		border: none;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
	}
	.cw-modal-close:hover { color: var(--color-ws-ink); }
	.form { display: flex; flex-direction: column; gap: 12px; }
	.form label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent);
	}
	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.req { color: var(--color-ws-rose); }
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
	.input.invalid { border-color: color-mix(in srgb, var(--color-ws-rose) 60%, transparent); }
	select.input { appearance: none; }
	.field-error { color: var(--color-ws-rose); font-size: 11.5px; }
	.cw-modal-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 6px;
	}
	.generated {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.generated-label { font-size: 12.5px; color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent); }
	.generated-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.generated-code {
		flex: 1;
		background: var(--color-ws-surface2);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 35%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 10px 12px;
		font-size: 15px;
		letter-spacing: 0.04em;
		color: var(--color-ws-violet);
		word-break: break-all;
	}
</style>
