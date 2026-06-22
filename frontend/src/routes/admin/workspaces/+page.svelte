<script lang="ts">
	import { onMount } from "svelte";
	import { listWorkspaces, type AdminWorkspaceRow } from "$lib/api/admin.ts";

	const PAGE_SIZE = 50;

	let rows = $state<AdminWorkspaceRow[]>([]);
	let total = $state(0);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let search = $state("");
	let planFilter = $state("");
	let statusFilter = $state("");

	// First page (or a filter/search change): replace the whole list.
	async function reload() {
		loading = true;
		error = null;
		try {
			const result = await listWorkspaces({
				search: search.trim() || undefined,
				plan: planFilter || undefined,
				status: statusFilter || undefined,
				limit: PAGE_SIZE,
			});
			rows = result.workspaces;
			total = result.total;
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "โหลดรายการ workspace ไม่ได้";
		} finally {
			loading = false;
		}
	}

	// "Load more": fetch the next keyset page and APPEND so all >50 rows are
	// reachable instead of silently truncating at the first page.
	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		error = null;
		try {
			const result = await listWorkspaces({
				search: search.trim() || undefined,
				plan: planFilter || undefined,
				status: statusFilter || undefined,
				limit: PAGE_SIZE,
				cursor: nextCursor,
			});
			rows = [...rows, ...result.workspaces];
			total = result.total;
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "โหลด workspace เพิ่มไม่ได้";
		} finally {
			loadingMore = false;
		}
	}

	onMount(reload);
</script>

<header class="page-head">
	<div>
		<h1>Workspaces</h1>
		<p class="page-sub">บัญชี Workspace ทั้งหมดในระบบ (รวม mock plan สำหรับ prototype)</p>
	</div>
	<div class="page-meta">
		{#if total > rows.length}
			แสดง {rows.length} จาก {total} รายการ
		{:else}
			รวม {total} รายการ
		{/if}
	</div>
</header>

<section class="filters" aria-label="ตัวกรอง">
	<input class="input" type="search" placeholder="ค้นหาตามชื่อ / owner email"
		bind:value={search}
		onkeydown={(event) => {
			if (event.key === "Enter") void reload();
		}}
	/>
	<select class="input" aria-label="กรองตามแผน" bind:value={planFilter} onchange={() => void reload()}>
		<option value="">ทุกแผน</option>
		<option value="free">Free</option>
		<option value="creator">Creator</option>
		<option value="pro">Pro</option>
		<option value="studio">Studio</option>
	</select>
	<select class="input" aria-label="กรองตามสถานะ" bind:value={statusFilter} onchange={() => void reload()}>
		<option value="">ทุกสถานะ</option>
		<option value="active">Active</option>
		<option value="trialing">Trialing</option>
		<option value="past_due">Past due</option>
		<option value="cancelled">Cancelled</option>
		<option value="mock_active">Mock active</option>
	</select>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void reload()} disabled={loading}>รีเฟรช</button>
</section>

{#if error}
	<p class="error" role="alert">{error}</p>
{/if}

<div class="table-wrap ws-panel" role="region" aria-label="รายการ workspace">
	<table>
		<thead>
			<tr>
				<th>Workspace</th>
				<th>Plan</th>
				<th>Status</th>
				<th>Billing email</th>
				<th>อัปเดต</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#if loading}
				<tr><td colspan="6" class="empty">กำลังโหลด…</td></tr>
			{:else if rows.length === 0}
				<tr><td colspan="6" class="empty">ไม่มี workspace ที่ตรงเงื่อนไข</td></tr>
			{:else}
				{#each rows as row (row.workspaceId)}
					<tr>
						<td>
							<div class="cell-stack">
								<strong>{row.name}</strong>
								<code class="muted">{row.workspaceId}</code>
							</div>
						</td>
						<td><span class="pill">{row.planId}</span></td>
						<td><span class="pill pill-{row.status}">{row.status}</span></td>
						<td>{row.billingEmail ?? "—"}</td>
						<td class="muted">{new Date(row.updatedAt).toLocaleString()}</td>
						<td><a class="link" href={`/admin/workspaces/${encodeURIComponent(row.workspaceId)}`}>เปิด</a></td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if !loading && rows.length > 0}
	<footer class="table-foot">
		<span class="muted">แสดง {rows.length} จาก {total} รายการ</span>
		{#if nextCursor}
			<button type="button" class="btn ws-btn-ghost" onclick={() => void loadMore()} disabled={loadingMore}>
				{loadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}
			</button>
		{/if}
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
	.page-head h1 {
		font-size: 22px;
		margin: 0;
		color: var(--color-ws-ink);
	}
	.page-sub {
		margin: 4px 0 0;
		color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent);
		font-size: 13px;
	}
	.page-meta {
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		font-size: 12px;
	}
	.filters {
		display: flex;
		gap: 8px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}
	.input {
		min-height: 36px;
		flex: 1 1 220px;
		min-width: 180px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
	}
	.input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent);
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
	.error {
		color: var(--color-ws-rose);
		font-size: 13px;
		background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
		padding: 8px 12px;
		border-radius: var(--radius-ws-ctrl);
		margin-bottom: 12px;
	}
	.table-wrap {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		/* Scroll horizontally on small/tablet widths instead of clipping the
		   wide columns (name / UUID / dates / actions). */
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
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	th, td {
		padding: 12px 14px;
		text-align: left;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
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
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); font-size: 12px; }
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
	.link { display: inline-flex; align-items: center; min-height: 36px; color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--color-ws-ink)); text-decoration: none; font-size: 12.5px; }
	.link:hover { text-decoration: underline; }
	.empty {
		padding: 32px 14px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
	}
</style>
