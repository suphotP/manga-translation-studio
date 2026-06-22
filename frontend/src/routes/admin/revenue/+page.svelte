<!--
Admin REVENUE & FINANCE dashboard (accountant-facing).

Reads /api/admin/revenue/* via adminRevenueApi. The whole surface is money-accurate
and PER CURRENCY — figures are NEVER summed across currencies (you cannot add JPY
minor units to USD cents), so every aggregate renders one block/series per currency.
Amounts arrive as integer-cents STRINGS and are formatted exactly via ./money.ts
(string/BigInt math, ISO-4217 minor units) — the displayed figure never passes
through a float. Charts (Sparkline/BarChart) use a best-effort major-unit number for
geometry only; the headline figure beside them is always the exact string.

UI gating is defense-in-depth (the backend stays authoritative): the page reads the
caller's permissions from GET /api/admin/me and shows the CSV export only when the
account holds REVENUE_EXPORT; the whole page is reachable only with REVENUE_READ
(the nav link + route are already gated server-side).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import StatTrend from "$lib/components/ui/StatTrend.svelte";
	import StatTile from "$lib/components/ui/StatTile.svelte";
	import Sparkline from "$lib/components/ui/Sparkline.svelte";
	import { type BarChartRow, barWidthPct } from "$lib/components/ui/BarChart.svelte";
	import { adminRevenueApi, getAdminMe, AdminApiError } from "$lib/api/admin.ts";
	import type {
		RevenueSummary,
		RevenueTransaction,
		RevenueTransactionsQuery,
		RevenueTimeseries,
		RevenueRefundsDisputes,
		RevenueInterval,
		RevenueTxKind,
	} from "$lib/api/admin/revenue.ts";
	import { formatMoney, centsToMajorNumber } from "./money.ts";

	const PAGE_SIZE = 50;
	const REVENUE_EXPORT = "admin:revenue.export";

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	function fmtDateTime(value: string | null): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
	}

	function fmtPeriod(value: string, interval: RevenueInterval): string {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return value;
		if (interval === "day") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
		return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
	}

	// ── Permissions (gate the CSV export) ─────────────────────────
	let canExport = $state(false);

	// ── Summary (MRR/ARR + by-plan, per currency) ─────────────────
	let summary = $state<RevenueSummary | null>(null);
	let summaryLoading = $state(true);
	let summaryError = $state<string | null>(null);

	async function loadSummary() {
		summaryLoading = true;
		summaryError = null;
		try {
			summary = await adminRevenueApi.getSummary();
		} catch (cause) {
			summaryError = describeError(cause);
		} finally {
			summaryLoading = false;
		}
	}

	// Per-plan rows for the BarChart, grouped per currency so a bar scale never mixes
	// currencies. Bars use the major-unit number for width; the label carries the exact
	// money string so the readable figure is precise.
	let planChartsByCurrency = $derived.by(() => {
		const out: { currency: string; rows: BarChartRow[] }[] = [];
		if (!summary) return out;
		const byCurrency = new Map<string, BarChartRow[]>();
		for (const plan of summary.plans) {
			const key = plan.currency || "—";
			const rows = byCurrency.get(key) ?? [];
			rows.push({
				id: plan.planId,
				label: plan.planName,
				value: centsToMajorNumber(plan.mrrCents, plan.currency),
				valueLabel: formatMoney(plan.mrrCents, plan.currency),
				tone: "violet",
			});
			byCurrency.set(key, rows);
		}
		for (const [currency, rows] of byCurrency) out.push({ currency, rows });
		return out.sort((a, b) => a.currency.localeCompare(b.currency));
	});

	// ── Timeseries (per currency, per period) ──────────────────────
	let interval = $state<RevenueInterval>("month");
	let timeseries = $state<RevenueTimeseries | null>(null);
	let tsLoading = $state(true);
	let tsError = $state<string | null>(null);

	async function loadTimeseries() {
		tsLoading = true;
		tsError = null;
		try {
			timeseries = await adminRevenueApi.getTimeseries({ interval });
		} catch (cause) {
			tsError = describeError(cause);
		} finally {
			tsLoading = false;
		}
	}

	function setInterval(next: RevenueInterval) {
		if (interval === next) return;
		interval = next;
		void loadTimeseries();
	}

	// ── Refunds & disputes (per currency, net impact) ──────────────
	let refunds = $state<RevenueRefundsDisputes | null>(null);
	let refundsLoading = $state(true);
	let refundsError = $state<string | null>(null);

	async function loadRefunds() {
		refundsLoading = true;
		refundsError = null;
		try {
			refunds = await adminRevenueApi.getRefundsDisputes();
		} catch (cause) {
			refundsError = describeError(cause);
		} finally {
			refundsLoading = false;
		}
	}

	// ── Transactions (keyset paged + filters) ──────────────────────
	let txRows = $state<RevenueTransaction[]>([]);
	let txTotal = $state(0);
	let txCursor = $state<string | null>(null);
	let txLoading = $state(true);
	let txLoadingMore = $state(false);
	let txError = $state<string | null>(null);

	// Filters
	let filterFrom = $state("");
	let filterTo = $state("");
	let filterCurrency = $state("");
	let filterKind = $state<"" | RevenueTxKind>("");

	function txQuery(cursor?: string): RevenueTransactionsQuery {
		return {
			from: filterFrom || undefined,
			to: filterTo || undefined,
			currency: filterCurrency.trim() || undefined,
			kind: filterKind || undefined,
			limit: PAGE_SIZE,
			cursor,
		};
	}

	async function reloadTransactions() {
		txLoading = true;
		txError = null;
		try {
			const result = await adminRevenueApi.listTransactions(txQuery());
			txRows = result.transactions;
			txTotal = result.total;
			txCursor = result.nextCursor;
		} catch (cause) {
			txError = describeError(cause);
		} finally {
			txLoading = false;
		}
	}

	async function loadMoreTransactions() {
		if (!txCursor || txLoadingMore) return;
		txLoadingMore = true;
		txError = null;
		try {
			const result = await adminRevenueApi.listTransactions(txQuery(txCursor));
			txRows = [...txRows, ...result.transactions];
			txTotal = result.total;
			txCursor = result.nextCursor;
		} catch (cause) {
			txError = describeError(cause);
		} finally {
			txLoadingMore = false;
		}
	}

	// ── CSV export (authenticated Blob download) ───────────────────
	let exportFrom = $state("");
	let exportTo = $state("");
	let exportCurrency = $state("");
	let exporting = $state(false);
	let exportMsg = $state<{ kind: "ok" | "error"; text: string } | null>(null);

	async function downloadCsv() {
		if (exporting) return;
		exporting = true;
		exportMsg = null;
		try {
			const blob = await adminRevenueApi.fetchExportCsv({
				from: exportFrom || undefined,
				to: exportTo || undefined,
				currency: exportCurrency.trim() || undefined,
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `revenue-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			// Revoke after the click so the download is not cancelled mid-flight.
			setTimeout(() => URL.revokeObjectURL(url), 4000);
			exportMsg = { kind: "ok", text: "ดาวน์โหลด CSV เรียบร้อย" };
		} catch (cause) {
			exportMsg = { kind: "error", text: describeError(cause) };
		} finally {
			exporting = false;
		}
	}

	async function loadPermissions() {
		try {
			const me = await getAdminMe();
			canExport = me.permissions.includes(REVENUE_EXPORT);
		} catch {
			// If we can't confirm the permission, hide the export. Backend stays authoritative.
			canExport = false;
		}
	}

	onMount(() => {
		void loadPermissions();
		void loadSummary();
		void loadTimeseries();
		void loadRefunds();
		void reloadTransactions();
	});
</script>

<svelte:head><title>Revenue · Admin · Comic Workspace</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Revenue &amp; finance</h1>
		<p class="page-sub">MRR/ARR, รายรับตามช่วงเวลา, ธุรกรรม, refund/dispute — แยกตามสกุลเงิน (ไม่รวมข้ามสกุล)</p>
	</div>
	<div class="page-meta">บัญชีอ่านอย่างเดียวสำหรับฝ่ายบัญชี · ตัวเลขเงินทุกตัวคือยอดจริง</div>
</header>

<!-- ── KPI: MRR / ARR / active subs, one card group per currency ── -->
<section aria-label="ตัวชี้วัดรายรับ (MRR/ARR)">
	{#if summaryError}
		<p class="alert error" role="alert">{summaryError}</p>
	{:else if summaryLoading}
		<div class="kpi-grid">
			{#each Array(3) as _, i (i)}
				<div class="kpi-card ws-panel skel-card" aria-hidden="true">
					<span class="skeleton" style="width: 40%"></span>
					<span class="skeleton" style="width: 70%; height: 22px"></span>
				</div>
			{/each}
		</div>
	{:else if summary && summary.currencies.length > 0}
		{#each summary.currencies as block (block.currency)}
			<div class="currency-band">
				<span class="currency-tag">{block.currency}</span>
				<span class="muted">รายได้ประจำ (MRR/ARR) จาก subscription ที่ active · สกุล {block.currency}</span>
			</div>
			<div class="kpi-grid">
				<div class="kpi-card ws-panel">
					<p class="kpi-label">MRR · {block.currency}</p>
					<p class="kpi-value">{formatMoney(block.mrrCents, block.currency)}</p>
					<p class="kpi-foot">รายได้ประจำต่อเดือน</p>
				</div>
				<div class="kpi-card ws-panel">
					<p class="kpi-label">ARR · {block.currency}</p>
					<p class="kpi-value">{formatMoney(block.arrCents, block.currency)}</p>
					<p class="kpi-foot">= MRR × 12</p>
				</div>
				<StatTile
					label={`Active subscriptions · ${block.currency}`}
					value={block.activeSubscriptions}
					unit="subs"
					tone="cyan"
				/>
			</div>

			<!-- Per-plan MRR for this currency (bars never mix currencies). Uses a
			     revenue-page-local bar layout instead of the shared BarChart atom so
			     the exact money label (e.g. "$1,999.00 USD") gets its own full-width
			     line and never clips inside BarChart's fixed ~52px value slot. The bar
			     geometry still reuses the atom's exported barWidthPct for consistency. -->
			{#each planChartsByCurrency.filter((c) => c.currency === block.currency) as planGroup (planGroup.currency)}
				{@const planMax = Math.max(1, ...planGroup.rows.map((r) => (Number.isFinite(r.value) ? r.value : 0)))}
				<div class="panel ws-panel by-plan">
					<h3 class="panel-head">MRR ตามแพลน · {planGroup.currency}</h3>
					{#if planGroup.rows.length === 0}
						<p class="muted small">ยังไม่มีแพลนที่ active</p>
					{:else}
						<ul class="plan-bars">
							{#each planGroup.rows as row (row.id)}
								<li class="plan-bar">
									<div class="plan-bar-head">
										<span class="plan-bar-label" title={row.label}>{row.label}</span>
										<span class="plan-bar-value">{row.valueLabel}</span>
									</div>
									<span class="plan-bar-track">
										<span class="plan-bar-fill" style={`width:${barWidthPct(row.value, planMax)}%`}></span>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		{/each}
		<p class="subs-total muted">รวม active subscriptions ทุกสกุล/ทุกแพลน: {summary.activeSubscriptionsTotal}</p>
	{:else}
		<p class="empty-panel">ยังไม่มี subscription ที่ active — ยังไม่มี MRR/ARR ให้แสดง</p>
	{/if}
</section>

<!-- ── Revenue timeseries (per currency, selectable period) ─────── -->
<section class="block" aria-label="รายรับตามช่วงเวลา">
	<header class="section-head">
		<div>
			<h2>รายรับตามช่วงเวลา</h2>
			<p class="page-sub">ยอดสุทธิต่อช่วง แยกตามสกุลเงิน (จาก payment_transactions จริง)</p>
		</div>
		<div class="seg" role="group" aria-label="ช่วงเวลา">
			<button type="button" class="seg-btn" data-active={interval === "day"} onclick={() => setInterval("day")}>รายวัน</button>
			<button type="button" class="seg-btn" data-active={interval === "month"} onclick={() => setInterval("month")}>รายเดือน</button>
		</div>
	</header>

	{#if tsError}
		<p class="alert error" role="alert">{tsError}</p>
	{:else if tsLoading}
		<div class="panel ws-panel"><span class="skeleton" style="width: 100%; height: 60px"></span></div>
	{:else if timeseries && timeseries.series.length > 0}
		<div class="ts-grid">
			{#each timeseries.series as s (s.currency ?? "—")}
				{@const currency = s.currency ?? "—"}
				{@const values = s.points.map((p) => centsToMajorNumber(p.amountCents, s.currency))}
				{@const last = s.points[s.points.length - 1]}
				<div class="panel ws-panel ts-card">
					<header class="ts-card-head">
						<span class="currency-tag">{currency}</span>
						{#if last}
							<span class="ts-latest">
								ล่าสุด {fmtPeriod(last.period, timeseries.interval)}:
								<strong>{formatMoney(last.amountCents, s.currency)}</strong>
							</span>
						{/if}
					</header>
					{#if values.length >= 2}
						<Sparkline {values} tone="violet" width={560} height={64} class="w-full" ariaLabel={`รายรับ ${currency}`} />
					{:else}
						<p class="muted small">ข้อมูลยังไม่พอจะวาดแนวโน้ม (ต้องมีอย่างน้อย 2 ช่วง)</p>
					{/if}
					<ul class="ts-points">
						{#each s.points as p (p.period)}
							<li>
								<span class="muted">{fmtPeriod(p.period, timeseries.interval)}</span>
								<span class="ts-amt">{formatMoney(p.amountCents, s.currency)}</span>
								<span class="muted small">{p.count} รายการ</span>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{:else}
		<p class="empty-panel">ยังไม่มีธุรกรรมในช่วงเวลานี้ — ไม่มีข้อมูลรายรับให้แสดง</p>
	{/if}
</section>

<!-- ── Refunds & disputes (per currency, net impact) ───────────── -->
<section class="block" aria-label="Refund และ dispute">
	<header class="section-head">
		<div>
			<h2>Refunds &amp; disputes</h2>
			<p class="page-sub">ยอดคืนเงิน + ข้อโต้แย้ง และผลกระทบสุทธิ — แยกตามสกุลเงิน</p>
		</div>
	</header>

	{#if refundsError}
		<p class="alert error" role="alert">{refundsError}</p>
	{:else if refundsLoading}
		<div class="panel ws-panel"><span class="skeleton" style="width: 100%; height: 48px"></span></div>
	{:else if refunds && refunds.currencies.length > 0}
		<div class="table-wrap ws-panel" role="region" aria-label="สรุป refund/dispute">
			<table>
				<thead>
					<tr>
						<th>สกุลเงิน</th>
						<th>Refunds</th>
						<th># refunds</th>
						<th>Disputes</th>
						<th># disputes</th>
						<th>ผลกระทบสุทธิ</th>
					</tr>
				</thead>
				<tbody>
					{#each refunds.currencies as block (block.currency ?? "—")}
						<tr>
							<td><span class="currency-tag">{block.currency ?? "—"}</span></td>
							<td class="money neg">{formatMoney(block.refundCents, block.currency)}</td>
							<td class="muted">{block.refundCount}</td>
							<td class="money neg">{formatMoney(block.disputeCents, block.currency)}</td>
							<td class="muted">{block.disputeCount}</td>
							<td class="money {block.netImpactCents.startsWith('-') ? 'neg' : ''}">
								{formatMoney(block.netImpactCents, block.currency)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">ผลกระทบสุทธิติดลบ = เงินไหลออก · ตัวเลขแยกตามสกุล ไม่รวมข้ามสกุล</p>
	{:else}
		<p class="empty-panel">ไม่มี refund หรือ dispute — ไม่มีผลกระทบให้แสดง</p>
	{/if}
</section>

<!-- ── CSV export (accountant) ─────────────────────────────────── -->
{#if canExport}
	<section class="block export" aria-label="ส่งออก CSV">
		<header class="section-head">
			<div>
				<h2>ส่งออกข้อมูลบัญชี (CSV)</h2>
				<p class="page-sub">ดาวน์โหลดธุรกรรมตามช่วงวันที่ พร้อม subtotal แยกตามสกุลเงิน — สำหรับฝ่ายบัญชี</p>
			</div>
		</header>
		<div class="export-row">
			<label class="field">
				<span>ตั้งแต่วันที่</span>
				<input class="input" type="date" bind:value={exportFrom} />
			</label>
			<label class="field">
				<span>ถึงวันที่</span>
				<input class="input" type="date" bind:value={exportTo} />
			</label>
			<label class="field">
				<span>สกุลเงิน (ไม่บังคับ)</span>
				<input class="input" type="text" placeholder="เช่น USD" bind:value={exportCurrency} maxlength="8" />
			</label>
			<button type="button" class="btn primary ws-grad-primary" onclick={() => void downloadCsv()} disabled={exporting}>
				{exporting ? "กำลังเตรียมไฟล์…" : "⬇ ดาวน์โหลด CSV"}
			</button>
		</div>
		{#if exportMsg}
			<p class="alert {exportMsg.kind}" role="status">{exportMsg.text}</p>
		{/if}
	</section>
{/if}

<!-- ── Transactions table (keyset load-more + filters) ──────────── -->
<section class="block" aria-label="ธุรกรรม">
	<header class="section-head">
		<div>
			<h2>ธุรกรรม</h2>
			<p class="page-sub">payment / refund / dispute — จำนวนเงินแม่นยำตามสกุลเงิน</p>
		</div>
		<div class="page-meta">
			{#if txLoading}
				กำลังโหลด…
			{:else if txCursor}
				แสดง {txRows.length} จาก {txTotal} รายการ (มีเพิ่ม)
			{:else}
				รวม {txTotal} รายการ
			{/if}
		</div>
	</header>

	<div class="filters">
		<label class="field">
			<span>ตั้งแต่</span>
			<input class="input" type="date" bind:value={filterFrom} />
		</label>
		<label class="field">
			<span>ถึง</span>
			<input class="input" type="date" bind:value={filterTo} />
		</label>
		<label class="field">
			<span>สกุลเงิน</span>
			<input class="input" type="text" placeholder="ทุกสกุล" bind:value={filterCurrency} maxlength="8" />
		</label>
		<label class="field">
			<span>ประเภท</span>
			<select class="input" bind:value={filterKind}>
				<option value="">ทุกประเภท</option>
				<option value="payment">payment</option>
				<option value="refund">refund</option>
				<option value="dispute">dispute</option>
			</select>
		</label>
		<button type="button" class="btn ws-btn-ghost" onclick={() => void reloadTransactions()} disabled={txLoading}>กรอง</button>
	</div>

	{#if txError}
		<p class="alert error" role="alert">{txError}</p>
	{/if}

	<div class="table-wrap ws-panel" role="region" aria-label="รายการธุรกรรม">
		<table>
			<thead>
				<tr>
					<th>วันที่</th>
					<th>ประเภท</th>
					<th class="num">จำนวนเงิน</th>
					<th>แพลน</th>
					<th>Workspace</th>
					<th>สถานะ</th>
				</tr>
			</thead>
			<tbody>
				{#if txLoading}
					{#each Array(6) as _, i (i)}
						<tr class="skeleton-row" aria-hidden="true">
							<td><span class="skeleton" style="width: 70%"></span></td>
							<td><span class="skeleton pill-skel"></span></td>
							<td><span class="skeleton" style="width: 60%"></span></td>
							<td><span class="skeleton" style="width: 50%"></span></td>
							<td><span class="skeleton" style="width: 65%"></span></td>
							<td><span class="skeleton" style="width: 45%"></span></td>
						</tr>
					{/each}
				{:else if txRows.length === 0}
					<tr><td colspan="6" class="empty">ไม่พบธุรกรรมที่ตรงเงื่อนไข</td></tr>
				{:else}
					{#each txRows as tx (tx.id)}
						<tr>
							<td class="muted">{fmtDateTime(tx.date)}</td>
							<td><span class="pill pill-{tx.kind}">{tx.kind}</span></td>
							<td class="num money {tx.amountCents.startsWith('-') ? 'neg' : ''}">{formatMoney(tx.amountCents, tx.currency)}</td>
							<td class="muted">{tx.plan ?? "—"}</td>
							<td><code class="muted">{tx.workspaceId ?? "—"}</code></td>
							<td class="muted">{tx.status ?? "—"}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	{#if !txLoading && txRows.length > 0}
		<footer class="table-foot">
			<span class="muted">แสดง {txRows.length} จาก {txTotal} รายการ</span>
			{#if txCursor}
				<button type="button" class="btn ws-btn-ghost" onclick={() => void loadMoreTransactions()} disabled={txLoadingMore}>
					{txLoadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}
				</button>
			{/if}
		</footer>
	{/if}
</section>

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

	.block { margin-top: 30px; }
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
		margin-bottom: 12px;
		flex-wrap: wrap;
	}
	.section-head h2 { font-size: 16px; margin: 0; color: var(--color-ws-ink); }

	/* ── Currency band (separates per-currency KPI groups) ── */
	.currency-band {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 18px 0 10px;
	}
	.currency-band:first-child { margin-top: 4px; }
	.currency-tag {
		display: inline-block;
		padding: 2px 9px;
		font-size: 11.5px;
		font-weight: 700;
		letter-spacing: 0.04em;
		border-radius: 6px;
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-accent) 22%, transparent), color-mix(in srgb, var(--color-ws-rose) 12%, transparent));
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 35%, transparent);
		color: var(--color-ws-violet);
	}

	/* ── KPI cards ── */
	.kpi-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: 12px;
	}
	.kpi-card {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 14px;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}
	.kpi-label { margin: 0; font-size: 11px; font-weight: 500; color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent); }
	.kpi-value { margin: 6px 0 0; font-size: 22px; font-weight: 600; color: var(--color-ws-ink); font-variant-numeric: tabular-nums; line-height: 1.1; }
	.kpi-foot { margin: 5px 0 0; font-size: 10.5px; color: color-mix(in srgb, var(--color-ws-ink) 40%, transparent); }
	.skel-card { display: flex; flex-direction: column; gap: 8px; }
	.subs-total { margin-top: 12px; }

	.panel {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 14px 16px;
	}
	.panel-head { font-size: 12px; margin: 0 0 10px; color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent); text-transform: uppercase; letter-spacing: 0.04em; }
	.by-plan { margin-top: 12px; }

	/* Revenue-page-local per-plan bars: the money label sits on its own line above
	   the bar so long strings ("$1,999.00 USD") never clip in a fixed value slot. */
	.plan-bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
	.plan-bar-head {
		display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 5px;
	}
	.plan-bar-label { font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 75%, transparent); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.plan-bar-value {
		font-size: 12.5px; font-weight: 600; color: var(--color-ws-ink); font-variant-numeric: tabular-nums;
		white-space: nowrap; flex-shrink: 0;
	}
	.plan-bar-track {
		display: block; height: 8px; width: 100%; border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-ink) 7%, transparent); overflow: hidden;
	}
	.plan-bar-fill {
		display: block; height: 100%; border-radius: 999px;
		background: linear-gradient(90deg, var(--color-ws-violet), var(--color-ws-rose)); transition: width 0.3s ease;
	}

	/* ── Timeseries ── */
	.ts-grid { display: flex; flex-direction: column; gap: 12px; }
	.ts-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 10px; flex-wrap: wrap; }
	.ts-latest { font-size: 12px; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); }
	.ts-latest strong { color: var(--color-ws-ink); font-variant-numeric: tabular-nums; }
	.ts-points {
		list-style: none;
		margin: 12px 0 0;
		padding: 10px 0 0;
		border-top: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 6px 18px;
	}
	.ts-points li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
	.ts-amt { color: var(--color-ws-ink); font-variant-numeric: tabular-nums; font-weight: 500; }

	/* ── Segmented control (period) ── */
	.seg {
		display: inline-flex;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 2px;
		gap: 2px;
	}
	.seg-btn {
		background: transparent;
		border: none;
		color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent);
		font-size: 12.5px;
		padding: 6px 14px;
		border-radius: 7px;
		cursor: pointer;
	}
	.seg-btn[data-active="true"] {
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-accent) 25%, transparent), color-mix(in srgb, var(--color-ws-rose) 10%, transparent));
		color: var(--color-ws-ink);
	}

	/* ── Filters / fields ── */
	.filters { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: flex-end; }
	.export-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
	.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	.input {
		min-height: 36px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
		color-scheme: dark;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }

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
	}
	.btn:hover { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.55; cursor: progress; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-rose));
		border-color: transparent;
		font-weight: 600;
	}
	.btn.primary:hover { filter: brightness(1.08); }

	/* ── Alerts ── */
	.alert { font-size: 13px; padding: 8px 12px; border-radius: var(--radius-ws-ctrl); margin: 12px 0; }
	.alert.error { color: var(--color-ws-rose); background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent); }
	.alert.ok { color: var(--color-ws-green); background: color-mix(in srgb, var(--color-ws-green) 8%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-green) 18%, transparent); }

	/* ── Tables ── */
	.table-wrap {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		/* Scroll horizontally on small/tablet widths instead of clipping the
		   wide revenue columns. */
		overflow-x: auto;
	}
	.table-foot {
		display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; flex-wrap: wrap;
	}
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	th, td {
		padding: 12px 14px;
		text-align: left;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		vertical-align: middle;
	}
	th {
		font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
	}
	th.num, td.num { text-align: right; }
	tr:last-child td { border-bottom: none; }
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.small { font-size: 11px; }
	.money { color: var(--color-ws-ink); font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
	.money.neg { color: var(--color-ws-rose); }
	.empty { padding: 32px 14px; text-align: center; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	.empty-panel {
		background: var(--color-ws-surface);
		border: 1px dashed color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 28px 16px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		font-size: 13px;
	}

	/* ── Pills (transaction kind) ── */
	.pill {
		display: inline-block; padding: 2px 8px; font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent); border-radius: 999px;
	}
	.pill-payment { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-refund { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-dispute { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }

	code { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); padding: 1px 5px; border-radius: 4px; font-size: 11px; }

	/* ── Skeletons (match other admin pages) ── */
	.skeleton {
		display: block; height: 12px; border-radius: 6px; margin: 3px 0;
		background: linear-gradient(90deg, color-mix(in srgb, var(--color-ws-ink) 5%, transparent), color-mix(in srgb, var(--color-ws-ink) 10%, transparent), color-mix(in srgb, var(--color-ws-ink) 5%, transparent));
		background-size: 200% 100%; animation: shimmer 1.2s ease-in-out infinite;
	}
	.skeleton.pill-skel { width: 56px; height: 16px; border-radius: 999px; }
	.skeleton-row td { vertical-align: middle; }
	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
