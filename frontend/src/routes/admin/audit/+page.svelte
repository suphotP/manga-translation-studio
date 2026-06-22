<!--
Admin AUDIT log viewer.

Read-only browser over the durable admin audit log (PostgresGdprStore), served by
GET /api/admin/audit. Mirrors the /admin/content design system: page-head +
page-meta, a filter row, a skeleton-loading table, honest empty states, pill
badges, and an offset pager. Each row carries the acting admin's platform role
(`actorRole`) so the back-office can read "who, in what capacity, did what"
across restarts.

This surface is READ-ONLY: it never mutates and never renders detail JSON via
{@html} — the detail object is pretty-printed into a <pre> (text only), so a
malicious audit payload cannot inject markup.

Filter NOTE: GET /api/admin/audit filters server-side by action / adminUserId /
actorRole / targetKind / targetId / fromDate / toDate / limit / offset (see
auditQuerySchema in backend/src/routes/admin.ts). Date bounds are validated as
strict UTC ISO datetimes server-side; the <input type="date"> values here are
the admin's LOCAL calendar day, converted to UTC instants before sending so a
selected day matches that day in the admin's timezone (see activeFilters).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { AdminApiError } from "$lib/api/admin.ts";
	// Use the audit barrel directly: it (unlike the legacy index type) carries the
	// new `actorRole` field, and the index does not re-export adminAuditApi.
	import { adminAuditApi, type AdminAuditEntry } from "$lib/api/admin/audit.ts";
	// Local-day → UTC-instant conversion lives in a pure module so the timezone
	// math is unit-testable without mounting this component.
	import { localDateStartUtc, localDateEndUtc } from "./audit-date-range.ts";

	const PAGE_SIZE = 50;

	let entries = $state<AdminAuditEntry[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let exporting = $state(false);

	// Server-supported filters only.
	let actionFilter = $state("");
	let adminUserIdFilter = $state("");
	let actorRoleFilter = $state("");
	let targetKindFilter = $state("");
	let targetIdFilter = $state("");
	let fromDateFilter = $state("");
	let toDateFilter = $state("");
	let offset = $state(0);

	// Expanded detail rows (by entry id). A Set keeps toggling O(1) without a
	// per-row reactive flag.
	let expanded = $state<Set<string>>(new Set());

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "ค้น audit ไม่สำเร็จ";
	}

	function activeFilters() {
		return {
			action: actionFilter.trim() || undefined,
			adminUserId: adminUserIdFilter.trim() || undefined,
			actorRole: actorRoleFilter.trim() || undefined,
			targetKind: targetKindFilter.trim() || undefined,
			targetId: targetIdFilter.trim() || undefined,
			fromDate: fromDateFilter ? localDateStartUtc(fromDateFilter) : undefined,
			toDate: toDateFilter ? localDateEndUtc(toDateFilter) : undefined,
		};
	}

	async function load() {
		loading = true;
		error = null;
		try {
			const result = await adminAuditApi.list({ ...activeFilters(), limit: PAGE_SIZE, offset });
			entries = result.entries;
			total = result.total;
			// Drop expansion state that no longer maps to a visible row.
			const visible = new Set(result.entries.map((e) => e.id));
			expanded = new Set([...expanded].filter((id) => visible.has(id)));
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loading = false;
		}
	}

	// A filter change resets to the first page; pagination keeps the filters.
	function search() {
		offset = 0;
		void load();
	}

	function clearFilters() {
		actionFilter = "";
		adminUserIdFilter = "";
		actorRoleFilter = "";
		targetKindFilter = "";
		targetIdFilter = "";
		fromDateFilter = "";
		toDateFilter = "";
		offset = 0;
		void load();
	}

	function next() {
		if (offset + PAGE_SIZE >= total) return;
		offset += PAGE_SIZE;
		void load();
	}

	function prev() {
		if (offset === 0) return;
		offset = Math.max(0, offset - PAGE_SIZE);
		void load();
	}

	// Export the audit log to CSV honoring the active filters (server-side, up to
	// the backend's default cap). The route is Bearer-only so we fetch the bytes
	// through the api client (which sets the header) and trigger a Blob download
	// rather than navigating to a <a href> that would download a 401 body.
	async function exportCsv() {
		if (exporting) return;
		exporting = true;
		error = null;
		try {
			const { csv, filename } = await adminAuditApi.downloadCsv(activeFilters());
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (cause) {
			error = describeError(cause);
		} finally {
			exporting = false;
		}
	}

	function toggleDetail(id: string) {
		const nextSet = new Set(expanded);
		if (nextSet.has(id)) nextSet.delete(id);
		else nextSet.add(id);
		expanded = nextSet;
	}

	const hasFilters = $derived(
		Boolean(
			actionFilter.trim() ||
				adminUserIdFilter.trim() ||
				actorRoleFilter.trim() ||
				targetKindFilter.trim() ||
				targetIdFilter.trim() ||
				fromDateFilter ||
				toDateFilter,
		),
	);

	function fmtDateTime(value: string): string {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
	}

	function hasDetail(detail: Record<string, unknown>): boolean {
		return Boolean(detail) && Object.keys(detail).length > 0;
	}

	// One-line summary for the collapsed row — text only, never markup.
	function detailSummary(detail: Record<string, unknown>): string {
		if (!hasDetail(detail)) return "—";
		try {
			const compact = JSON.stringify(detail);
			return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
		} catch {
			return String(detail);
		}
	}

	// Pretty-printed JSON for the expanded panel. Rendered into a <pre> as plain
	// text — no {@html}, so a hostile payload cannot inject markup.
	function detailJson(detail: Record<string, unknown>): string {
		try {
			return JSON.stringify(detail, null, 2);
		} catch {
			return String(detail);
		}
	}

	// Map a platform role to a semantic badge tone so owner/support read at a glance.
	function roleTone(role: string | null): string {
		switch (role) {
			case "owner":
				return "role-owner";
			case "admin":
				return "role-admin";
			case "support":
				return "role-support";
			case "accountant":
				return "role-accountant";
			default:
				return "role-other";
		}
	}

	onMount(() => void load());
</script>

<header class="page-head">
	<div>
		<h1>Audit log</h1>
		<p class="page-sub">
			ทุก action ที่อ่อนไหวของทีมหลังบ้าน (impersonate / grant / refund / force-delete / cron) —
			เก็บถาวรพร้อม role ของผู้ทำ
		</p>
	</div>
	<div class="page-actions">
		<div class="page-meta">
			{#if loading}
				กำลังโหลด…
			{:else}
				{#if total > 0}
					{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total} รายการ
				{:else}
					0 รายการ
				{/if}
			{/if}
		</div>
		<button
			type="button"
			class="btn ws-btn-ghost"
			onclick={() => void exportCsv()}
			disabled={exporting || loading || total === 0}
			title="ส่งออกตามตัวกรองปัจจุบัน"
		>{exporting ? "กำลังส่งออก…" : "Export CSV"}</button>
	</div>
</header>

<section class="filters" aria-label="ตัวกรอง audit">
	<input
		class="input"
		type="search"
		placeholder="action เช่น admin.impersonation.start"
		bind:value={actionFilter}
		onkeydown={(event) => { if (event.key === "Enter") search(); }}
	/>
	<input
		class="input"
		type="search"
		placeholder="admin user id"
		bind:value={adminUserIdFilter}
		onkeydown={(event) => { if (event.key === "Enter") search(); }}
	/>
	<select class="input" bind:value={actorRoleFilter} onchange={search} aria-label="กรองตาม role">
		<option value="">ทุก role</option>
		<option value="owner">owner</option>
		<option value="admin">admin</option>
		<option value="support">support</option>
		<option value="accountant">accountant</option>
	</select>
	<input
		class="input"
		type="search"
		placeholder="target kind เช่น workspace"
		bind:value={targetKindFilter}
		onkeydown={(event) => { if (event.key === "Enter") search(); }}
	/>
	<input
		class="input"
		type="search"
		placeholder="target id"
		bind:value={targetIdFilter}
		onkeydown={(event) => { if (event.key === "Enter") search(); }}
	/>
	<input
		class="input"
		type="date"
		aria-label="ตั้งแต่"
		placeholder="ตั้งแต่"
		bind:value={fromDateFilter}
		onchange={search}
	/>
	<input
		class="input"
		type="date"
		aria-label="ถึง"
		placeholder="ถึง"
		bind:value={toDateFilter}
		onchange={search}
	/>
	<button type="button" class="btn primary ws-grad-primary" onclick={search} disabled={loading}>ค้นหา</button>
	{#if hasFilters}
		<button type="button" class="btn ws-btn-ghost" onclick={clearFilters} disabled={loading}>ล้าง</button>
	{/if}
</section>

<p class="filter-note">
	กรองได้ที่ฝั่งเซิร์ฟเวอร์ทั้งหมด (action / admin user / role ของผู้ทำ / target / ช่วงวันที่)
</p>

{#if error}
	<p class="alert error" role="alert">{error}</p>
{/if}

<div class="table-wrap ws-panel" role="region" aria-label="บันทึก audit">
	<table>
		<thead>
			<tr>
				<th>เมื่อ</th>
				<th>ผู้ทำ (role)</th>
				<th>Action</th>
				<th>Target</th>
				<th>Detail</th>
			</tr>
		</thead>
		<tbody>
			{#if loading}
				{#each Array(6) as _, i (i)}
					<tr class="skeleton-row" aria-hidden="true">
						<td><span class="skeleton" style="width: 80%"></span></td>
						<td><span class="skeleton" style="width: 70%"></span><span class="skeleton sm" style="width: 45%"></span></td>
						<td><span class="skeleton pill-skel"></span></td>
						<td><span class="skeleton" style="width: 60%"></span></td>
						<td><span class="skeleton" style="width: 85%"></span></td>
					</tr>
				{/each}
			{:else if entries.length === 0}
				<tr>
					<td colspan="5" class="empty">
						{#if hasFilters}
							ไม่พบ event ตามตัวกรอง — ลองล้างตัวกรองแล้วค้นใหม่
						{:else}
							ยังไม่มีบันทึก audit — เมื่อทีมหลังบ้านทำ action ที่อ่อนไหว รายการจะปรากฏที่นี่
						{/if}
					</td>
				</tr>
			{:else}
				{#each entries as entry (entry.id)}
					<tr>
						<td class="muted nowrap">{fmtDateTime(entry.createdAt)}</td>
						<td>
							<div class="cell-stack">
								<code>{entry.adminUserId}</code>
								{#if entry.actorRole}
									<span class="pill {roleTone(entry.actorRole)}">{entry.actorRole}</span>
								{:else}
									<span class="pill role-other">system / legacy</span>
								{/if}
							</div>
						</td>
						<td><span class="pill pill-action">{entry.action}</span></td>
						<td>
							{#if entry.targetKind || entry.targetId}
								<div class="cell-stack">
									<small class="muted">{entry.targetKind ?? "—"}</small>
									<code>{entry.targetId ?? "—"}</code>
								</div>
							{:else}
								<span class="muted">—</span>
							{/if}
						</td>
						<td>
							{#if hasDetail(entry.detail)}
								<button
									type="button"
									class="detail-toggle"
									aria-expanded={expanded.has(entry.id)}
									onclick={() => toggleDetail(entry.id)}
								>
									<span class="chevron" class:open={expanded.has(entry.id)} aria-hidden="true">›</span>
									{#if expanded.has(entry.id)}
										ซ่อน
									{:else}
										<span class="detail-preview">{detailSummary(entry.detail)}</span>
									{/if}
								</button>
								{#if expanded.has(entry.id)}
									<pre class="detail-json">{detailJson(entry.detail)}</pre>
								{/if}
							{:else}
								<span class="muted">—</span>
							{/if}
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if !loading && total > 0}
	<footer class="table-foot">
		<span class="muted">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total}</span>
		<div class="pager-buttons">
			<button type="button" class="btn ws-btn-ghost" onclick={prev} disabled={offset === 0 || loading}>ก่อนหน้า</button>
			<button type="button" class="btn ws-btn-ghost" onclick={next} disabled={offset + PAGE_SIZE >= total || loading}>ถัดไป</button>
		</div>
	</footer>
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
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; max-width: 60ch; }
	.page-meta { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; white-space: nowrap; }
	.page-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
	.filters { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
	.input {
		min-height: 36px;
		flex: 1 1 200px;
		min-width: 160px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	.filter-note {
		margin: 0 0 14px;
		font-size: 11.5px;
		color: color-mix(in srgb, var(--color-ws-ink) 42%, transparent);
		line-height: 1.5;
	}
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
	.alert {
		font-size: 13px;
		padding: 8px 12px;
		border-radius: var(--radius-ws-ctrl);
		margin-bottom: 12px;
	}
	.alert.error {
		color: var(--color-ws-rose);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}
	.table-wrap {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		/* Scroll horizontally on small/tablet widths instead of clipping the
		   wide columns (email / UUID / dates / detail). */
		overflow-x: auto;
	}
	.table-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 12px;
		flex-wrap: wrap;
	}
	.pager-buttons { display: flex; gap: 8px; }
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	th, td {
		padding: 12px 14px;
		text-align: left;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		vertical-align: top;
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
	.cell-stack { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.nowrap { white-space: nowrap; }
	.pill {
		display: inline-block;
		padding: 2px 8px;
		font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
	}
	.pill-action { background: color-mix(in srgb, var(--color-ws-violet) 10%, transparent); border-color: color-mix(in srgb, var(--color-ws-violet) 25%, transparent); color: var(--color-ws-violet); }
	.role-owner { background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 35%, transparent); color: var(--color-ws-rose); }
	.role-admin { background: color-mix(in srgb, var(--color-ws-blue) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-blue) 32%, transparent); color: var(--color-ws-blue); }
	.role-support { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.role-accountant { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.role-other { background: color-mix(in srgb, var(--color-ws-text) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-text) 30%, transparent); color: var(--color-ws-text); }
	code {
		font-size: 11.5px;
		color: color-mix(in srgb, var(--color-ws-ink) 82%, transparent);
		word-break: break-all;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.detail-toggle {
		min-height: 36px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: none;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
		font-size: 12px;
		cursor: pointer;
		padding: 0;
		text-align: left;
		max-width: 360px;
	}
	.detail-toggle:hover { color: var(--color-ws-ink); }
	.detail-preview {
		color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron {
		display: inline-block;
		transition: transform 0.14s ease;
		color: color-mix(in srgb, var(--color-ws-ink) 45%, transparent);
		font-size: 14px;
		line-height: 1;
	}
	.chevron.open { transform: rotate(90deg); }
	.detail-json {
		margin: 8px 0 0;
		font-size: 11.5px;
		color: color-mix(in srgb, var(--color-ws-ink) 78%, transparent);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace;
		white-space: pre-wrap;
		word-break: break-word;
		max-width: 480px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 10px 12px;
		max-height: 320px;
		overflow: auto;
	}
	.empty {
		padding: 32px 14px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
	}
	.skeleton {
		display: block;
		height: 12px;
		border-radius: 6px;
		margin: 3px 0;
		background: linear-gradient(90deg, color-mix(in srgb, var(--color-ws-ink) 5%, transparent), color-mix(in srgb, var(--color-ws-ink) 10%, transparent), color-mix(in srgb, var(--color-ws-ink) 5%, transparent));
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}
	.skeleton.sm { height: 10px; }
	.skeleton.pill-skel { width: 120px; height: 16px; border-radius: 999px; }
	.skeleton-row td { vertical-align: middle; }
	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
