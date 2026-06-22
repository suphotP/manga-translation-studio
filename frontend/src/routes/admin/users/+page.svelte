<!--
Admin USERS management — list.

Platform-user browser over /api/admin/users-mgmt. Mirrors /admin/content and
/admin/workspaces: page-head + filters (search + role + status) + keyset-
paginated table (load-more). Each row links to the per-user detail page where
the audited platform-role / enable-disable actions live.

The list is READ-only (gated by admin:users.read at the parent router); the
mutations live on the detail page and are gated there on admin:users.write /
admin:roles.write read from GET /api/admin/me. The backend stays authoritative.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { adminUsersApi, AdminApiError } from "$lib/api/admin.ts";
	import type {
		AdminUserListRow,
		AdminPlatformRole,
		ListUsersParams,
	} from "$lib/api/admin/users.ts";

	const PAGE_SIZE = 50;

	const ROLE_OPTIONS: AdminPlatformRole[] = [
		"owner",
		"admin",
		"support",
		"accountant",
		"editor",
		"viewer",
	];

	type StatusFilter = "" | "active" | "disabled";

	let rows = $state<AdminUserListRow[]>([]);
	let total = $state(0);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);

	let search = $state("");
	let roleFilter = $state<"" | AdminPlatformRole>("");
	let statusFilter = $state<StatusFilter>("");

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	function listParams(cursor?: string): ListUsersParams {
		return {
			search: search.trim() || undefined,
			role: roleFilter || undefined,
			status: statusFilter || undefined,
			limit: PAGE_SIZE,
			cursor,
		};
	}

	// First page (or a filter/search change): replace the whole list.
	async function reload() {
		loading = true;
		error = null;
		try {
			const result = await adminUsersApi.listUsers(listParams());
			rows = result.users;
			total = result.total;
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loading = false;
		}
	}

	// "Load more": fetch the next keyset page and APPEND so every user past the
	// first page is reachable instead of silently truncating.
	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		error = null;
		try {
			const result = await adminUsersApi.listUsers(listParams(nextCursor));
			rows = [...rows, ...result.users];
			total = result.total;
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loadingMore = false;
		}
	}

	onMount(reload);

	function fmtDate(value: string | null): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
	}

	function fmtDateTime(value: string | null): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
	}
</script>

<header class="page-head">
	<div>
		<h1>Users</h1>
		<p class="page-sub">บัญชีผู้ใช้แพลตฟอร์มทั้งหมด — เปิดดูรายละเอียดเพื่อเปลี่ยน role / เปิด-ปิดบัญชี</p>
	</div>
	<div class="page-meta">
		{#if loading}
			กำลังโหลด…
		{:else if total > rows.length}
			แสดง {rows.length} จาก {total} บัญชี (ตามคำค้น)
		{:else}
			รวม {total} บัญชี
		{/if}
	</div>
</header>

<section class="filters" aria-label="ตัวกรอง">
	<input
		class="input"
		type="search"
		placeholder="ค้นหาด้วยอีเมลหรือชื่อ"
		bind:value={search}
		onkeydown={(event) => {
			if (event.key === "Enter") void reload();
		}}
	/>
	<select class="input" bind:value={roleFilter} onchange={() => void reload()} aria-label="กรองตาม role">
		<option value="">ทุก role</option>
		{#each ROLE_OPTIONS as role (role)}
			<option value={role}>{role}</option>
		{/each}
	</select>
	<select class="input" bind:value={statusFilter} onchange={() => void reload()} aria-label="กรองตามสถานะ">
		<option value="">ทุกสถานะ</option>
		<option value="active">active</option>
		<option value="disabled">disabled</option>
	</select>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void reload()} disabled={loading}>รีเฟรช</button>
</section>

{#if error}
	<p class="alert error" role="alert">{error}</p>
{/if}

<div class="table-wrap ws-panel" role="region" aria-label="รายการผู้ใช้">
	<table>
		<thead>
			<tr>
				<th>อีเมล / ชื่อ</th>
				<th>Role</th>
				<th>Status</th>
				<th>Provider</th>
				<th>Last login</th>
				<th>Created</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#if loading}
				{#each Array(5) as _, i (i)}
					<tr class="skeleton-row" aria-hidden="true">
						<td><span class="skeleton" style="width: 70%"></span><span class="skeleton sm" style="width: 45%"></span></td>
						<td><span class="skeleton pill-skel"></span></td>
						<td><span class="skeleton pill-skel"></span></td>
						<td><span class="skeleton" style="width: 50%"></span></td>
						<td><span class="skeleton" style="width: 60%"></span></td>
						<td><span class="skeleton" style="width: 55%"></span></td>
						<td><span class="skeleton" style="width: 32px"></span></td>
					</tr>
				{/each}
			{:else if rows.length === 0}
				<tr><td colspan="7" class="empty">
					ไม่พบบัญชีที่ตรงเงื่อนไข{#if search.trim() || roleFilter || statusFilter}<br /><span class="muted">ลองล้างตัวกรองหรือเปลี่ยนคำค้น</span>{/if}
				</td></tr>
			{:else}
				{#each rows as user (user.id)}
					<tr>
						<td>
							<div class="cell-stack">
								<strong>{user.email}</strong>
								<span class="muted">{user.name || "—"}</span>
							</div>
						</td>
						<td><span class="pill pill-role-{user.role}">{user.role}</span></td>
						<td>
							{#if user.isActive}
								<span class="pill pill-active">active</span>
							{:else}
								<span class="pill pill-disabled">disabled</span>
							{/if}
						</td>
						<td class="muted">{user.authProvider || "—"}</td>
						<td class="muted">{fmtDateTime(user.lastLogin)}</td>
						<td class="muted">{fmtDate(user.createdAt)}</td>
						<td><a class="link" href="/admin/users/{encodeURIComponent(user.id)}">เปิด</a></td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if !loading && rows.length > 0}
	<footer class="table-foot">
		<span class="muted">แสดง {rows.length} จาก {total} บัญชี</span>
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
	.page-head h1 { font-size: 22px; margin: 0; color: var(--color-ws-ink); }
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; }
	.page-meta { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.filters { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
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
	select.input { flex: 0 1 160px; }
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
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
		   wide columns (email / UUID / dates / actions). */
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
	.pill-role-owner { background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 35%, transparent); color: var(--color-ws-rose); }
	.pill-role-admin { background: color-mix(in srgb, var(--color-ws-violet) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-violet) 30%, transparent); color: var(--color-ws-violet); }
	.pill-role-support { background: color-mix(in srgb, var(--color-ws-cyan) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-cyan) 30%, transparent); color: var(--color-ws-cyan); }
	.pill-role-accountant { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-role-editor { background: color-mix(in srgb, var(--color-ws-blue) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-blue) 30%, transparent); color: var(--color-ws-blue); }
	.pill-role-viewer { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent); }
	.pill-active { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-disabled { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
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
		text-decoration: none;
	}
	.link:hover { text-decoration: underline; }
	.empty {
		padding: 32px 14px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		line-height: 1.7;
	}

	/* Loading skeletons */
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
	.skeleton.pill-skel { width: 56px; height: 16px; border-radius: 999px; }
	.skeleton-row td { vertical-align: middle; }
	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
