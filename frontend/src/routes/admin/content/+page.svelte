<!--
Admin CONTENT management.

Cross-tenant project browser + moderation queue over /api/admin/content. Mirrors
/admin/users and /admin/workspaces: page-head + filters + keyset-paginated table
(load-more) + per-row "open" into a slide-in detail drawer. The drawer shows
project METADATA only (never asset bytes) and exposes the audited moderation
mutations (flag/unflag, hide/unhide) — each prompts for a reason and refetches
the row after success.

UI gating is defense-in-depth: the moderate buttons are only rendered when the
signed-in admin holds admin:content.moderate (read via GET /api/admin/me, the
same source the layout uses for nav). The backend remains authoritative.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { adminContentApi, getAdminMe, AdminApiError } from "$lib/api/admin.ts";
	import type {
		AdminContentProject,
		AdminContentProjectDetail,
		AdminModerationQueueItem,
	} from "$lib/api/admin/content.ts";

	const PAGE_SIZE = 50;
	const CONTENT_MODERATE = "admin:content.moderate";

	type StatusFilter = "active" | "admin_hidden" | "all";

	// ── Project table state ───────────────────────────────────────
	let rows = $state<AdminContentProject[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let search = $state("");
	let statusFilter = $state<StatusFilter>("active");
	let flaggedOnly = $state(false);

	// ── Permissions (gate the moderate actions) ───────────────────
	let canModerate = $state(false);

	// ── Detail drawer state ───────────────────────────────────────
	let drawerOpen = $state(false);
	let detail = $state<AdminContentProjectDetail | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let actionBusy = $state(false);

	// ── Moderation queue state ────────────────────────────────────
	let queue = $state<AdminModerationQueueItem[]>([]);
	let queueCursor = $state<string | null>(null);
	let queueLoading = $state(true);
	let queueLoadingMore = $state(false);
	let queueError = $state<string | null>(null);

	// ── Toast ─────────────────────────────────────────────────────
	let message = $state<{ kind: "ok" | "error"; text: string } | null>(null);

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	function setMessage(kind: "ok" | "error", text: string): void {
		message = { kind, text };
		setTimeout(() => {
			if (message?.text === text) message = null;
		}, 5000);
	}

	function listOptions(cursor?: string) {
		return {
			search: search.trim() || undefined,
			status: statusFilter,
			flagged: flaggedOnly || undefined,
			limit: PAGE_SIZE,
			cursor,
		};
	}

	// First page (or a filter/search change): replace the whole list.
	async function reload() {
		loading = true;
		error = null;
		try {
			const result = await adminContentApi.listProjects(listOptions());
			rows = result.projects;
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loading = false;
		}
	}

	// "Load more": fetch the next keyset page and APPEND so every project past the
	// first page is reachable instead of silently truncating.
	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		error = null;
		try {
			const result = await adminContentApi.listProjects(listOptions(nextCursor));
			rows = [...rows, ...result.projects];
			nextCursor = result.nextCursor;
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loadingMore = false;
		}
	}

	async function reloadQueue() {
		queueLoading = true;
		queueError = null;
		try {
			const result = await adminContentApi.listModerationQueue({ limit: PAGE_SIZE });
			queue = result.items;
			queueCursor = result.nextCursor;
		} catch (cause) {
			queueError = describeError(cause);
		} finally {
			queueLoading = false;
		}
	}

	async function loadMoreQueue() {
		if (!queueCursor || queueLoadingMore) return;
		queueLoadingMore = true;
		queueError = null;
		try {
			const result = await adminContentApi.listModerationQueue({ limit: PAGE_SIZE, cursor: queueCursor });
			queue = [...queue, ...result.items];
			queueCursor = result.nextCursor;
		} catch (cause) {
			queueError = describeError(cause);
		} finally {
			queueLoadingMore = false;
		}
	}

	async function loadPermissions() {
		try {
			const me = await getAdminMe();
			canModerate = me.permissions.includes(CONTENT_MODERATE);
		} catch {
			// Read-only fallback: if we can't confirm the permission, hide the
			// moderate actions. The backend stays authoritative regardless.
			canModerate = false;
		}
	}

	onMount(() => {
		void loadPermissions();
		void reload();
		void reloadQueue();
	});

	// ── Detail drawer ─────────────────────────────────────────────
	async function openDetail(projectId: string) {
		drawerOpen = true;
		detail = null;
		detailError = null;
		detailLoading = true;
		try {
			const result = await adminContentApi.getProject(projectId);
			detail = result.project;
		} catch (cause) {
			detailError = describeError(cause);
		} finally {
			detailLoading = false;
		}
	}

	function closeDrawer() {
		drawerOpen = false;
		detail = null;
		detailError = null;
	}

	// Reflect a mutation result everywhere the row appears (table + drawer).
	function applyUpdatedProject(updated: AdminContentProject) {
		rows = rows.map((row) => (row.projectId === updated.projectId ? { ...row, ...updated } : row));
		if (detail && detail.projectId === updated.projectId) {
			detail = { ...detail, ...updated };
		}
	}

	function promptReason(label: string): string | null | undefined {
		const value = window.prompt(label, "");
		// `null` => user cancelled; empty string => proceed with no reason.
		return value === null ? null : value.trim();
	}

	async function runModeration(
		action: () => Promise<{ ok: boolean; project: AdminContentProject }>,
		okText: string,
	) {
		if (actionBusy) return;
		actionBusy = true;
		try {
			const result = await action();
			applyUpdatedProject(result.project);
			setMessage("ok", okText);
			// Patch the row in place for an instant drawer update, then refetch the
			// list so a row that no longer matches the active filter (e.g. just
			// hidden while filtered to `active`) drops out instead of lingering.
			const id = detail?.projectId;
			void reload();
			if (id) {
				void openDetail(id);
			}
			// Keep the queue honest after a moderation change.
			void reloadQueue();
		} catch (cause) {
			setMessage("error", describeError(cause));
		} finally {
			actionBusy = false;
		}
	}

	function handleFlag(project: AdminContentProjectDetail) {
		const reason = promptReason("เหตุผลในการ flag โปรเจกต์นี้ (จะถูกบันทึกใน audit)");
		if (reason === null) return;
		void runModeration(
			() => adminContentApi.flagProject(project.projectId, reason || undefined),
			"ตั้งค่า flag เรียบร้อย",
		);
	}

	function handleUnflag(project: AdminContentProjectDetail) {
		const reason = promptReason("เหตุผลในการเอา flag ออก (จะถูกบันทึกใน audit)");
		if (reason === null) return;
		void runModeration(
			() => adminContentApi.unflagProject(project.projectId, reason || undefined),
			"เอา flag ออกเรียบร้อย",
		);
	}

	function handleHide(project: AdminContentProjectDetail) {
		const reason = promptReason("เหตุผลในการซ่อนโปรเจกต์ (soft-hide, บันทึก audit)");
		if (reason === null) return;
		void runModeration(
			() => adminContentApi.hideProject(project.projectId, reason || undefined),
			"ซ่อนโปรเจกต์เรียบร้อย",
		);
	}

	function handleUnhide(project: AdminContentProjectDetail) {
		const reason = promptReason("เหตุผลในการเลิกซ่อนโปรเจกต์ (บันทึก audit)");
		if (reason === null) return;
		void runModeration(
			() => adminContentApi.unhideProject(project.projectId, reason || undefined),
			"เลิกซ่อนโปรเจกต์เรียบร้อย",
		);
	}

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

	function statusLabel(status: AdminContentProject["status"]): string {
		if (status === "admin_hidden") return "hidden";
		if (status === "user_deleted") return "deleted";
		return "active";
	}
</script>

<header class="page-head">
	<div>
		<h1>Content</h1>
		<p class="page-sub">โปรเจกต์ทุก workspace (cross-tenant) + คิว moderation — ไม่แสดงไฟล์ภาพ มีแต่ metadata</p>
	</div>
	<div class="page-meta">
		{#if loading}
			กำลังโหลด…
		{:else if nextCursor}
			แสดง {rows.length} โปรเจกต์ (มีเพิ่ม)
		{:else}
			รวม {rows.length} โปรเจกต์
		{/if}
	</div>
</header>

<section class="filters" aria-label="ตัวกรอง">
	<input
		class="input"
		type="search"
		placeholder="ค้นหาด้วยชื่อโปรเจกต์ / workspace"
		bind:value={search}
		onkeydown={(event) => {
			if (event.key === "Enter") void reload();
		}}
	/>
	<select class="input" aria-label="กรองตามสถานะ" bind:value={statusFilter} onchange={() => void reload()}>
		<option value="active">เฉพาะ active</option>
		<option value="admin_hidden">เฉพาะที่ถูกซ่อน</option>
		<option value="all">ทุกสถานะ</option>
	</select>
	<label class="check">
		<input type="checkbox" bind:checked={flaggedOnly} onchange={() => void reload()} />
		เฉพาะที่ถูก flag
	</label>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void reload()} disabled={loading}>รีเฟรช</button>
</section>

{#if error}
	<p class="alert error" role="alert">{error}</p>
{/if}
{#if message}
	<p class="alert {message.kind}" role="status">{message.text}</p>
{/if}

<div class="table-wrap ws-panel" role="region" aria-label="รายการโปรเจกต์">
	<table>
		<thead>
			<tr>
				<th>โปรเจกต์</th>
				<th>Workspace</th>
				<th>Status</th>
				<th>Pages / Assets</th>
				<th>Flags</th>
				<th>Created</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#if loading}
				{#each Array(5) as _, i (i)}
					<tr class="skeleton-row" aria-hidden="true">
						<td><span class="skeleton" style="width: 70%"></span><span class="skeleton sm" style="width: 45%"></span></td>
						<td><span class="skeleton" style="width: 60%"></span></td>
						<td><span class="skeleton pill-skel"></span></td>
						<td><span class="skeleton" style="width: 50%"></span></td>
						<td><span class="skeleton" style="width: 40%"></span></td>
						<td><span class="skeleton" style="width: 55%"></span></td>
						<td><span class="skeleton" style="width: 30px"></span></td>
					</tr>
				{/each}
			{:else if rows.length === 0}
				<tr><td colspan="7" class="empty">ไม่พบโปรเจกต์ที่ตรงเงื่อนไข</td></tr>
			{:else}
				{#each rows as project (project.projectId)}
					<tr>
						<td>
							<div class="cell-stack">
								<strong>{project.title || "(ไม่มีชื่อ)"}</strong>
								<code class="muted">{project.projectId}</code>
							</div>
						</td>
						<td>
							<div class="cell-stack">
								<span>{project.workspaceName || "—"}</span>
								<code class="muted">{project.workspaceId ?? "—"}</code>
							</div>
						</td>
						<td><span class="pill pill-{statusLabel(project.status)}">{statusLabel(project.status)}</span></td>
						<td class="muted">{project.pageCount} / {project.assetCount}</td>
						<td>
							{#if project.adminFlagged}
								<span class="pill pill-flag">flagged</span>
							{/if}
							{#if project.flaggedAssetCount > 0}
								<span class="pill pill-warn">{project.flaggedAssetCount} asset</span>
							{/if}
							{#if project.csamBlockCount > 0}
								<span class="pill pill-danger">{project.csamBlockCount} CSAM</span>
							{/if}
							{#if !project.adminFlagged && project.flaggedAssetCount === 0 && project.csamBlockCount === 0}
								<span class="muted">—</span>
							{/if}
						</td>
						<td class="muted">{fmtDate(project.createdAt)}</td>
						<td><button type="button" class="link" onclick={() => void openDetail(project.projectId)}>เปิด</button></td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if !loading && rows.length > 0}
	<footer class="table-foot">
		<span class="muted">แสดง {rows.length} โปรเจกต์</span>
		{#if nextCursor}
			<button type="button" class="btn ws-btn-ghost" onclick={() => void loadMore()} disabled={loadingMore}>
				{loadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}
			</button>
		{/if}
	</footer>
{/if}

<!-- ── Moderation queue ──────────────────────────────────────── -->
<section class="queue" aria-label="คิว moderation">
	<header class="section-head">
		<div>
			<h2>Moderation queue</h2>
			<p class="page-sub">Asset ที่ถูก flag + เหตุการณ์ CSAM block ทั่วทั้งระบบ</p>
		</div>
		<button type="button" class="btn ws-btn-ghost" onclick={() => void reloadQueue()} disabled={queueLoading}>รีเฟรช</button>
	</header>

	{#if queueError}
		<p class="alert error" role="alert">{queueError}</p>
	{/if}

	<div class="table-wrap ws-panel" role="region" aria-label="รายการ moderation">
		<table>
			<thead>
				<tr>
					<th>Source</th>
					<th>Project / Workspace</th>
					<th>Status</th>
					<th>Provider</th>
					<th>Reason</th>
					<th>เมื่อ</th>
				</tr>
			</thead>
			<tbody>
				{#if queueLoading}
					{#each Array(3) as _, i (i)}
						<tr class="skeleton-row" aria-hidden="true">
							<td><span class="skeleton pill-skel"></span></td>
							<td><span class="skeleton" style="width: 60%"></span></td>
							<td><span class="skeleton pill-skel"></span></td>
							<td><span class="skeleton" style="width: 50%"></span></td>
							<td><span class="skeleton" style="width: 70%"></span></td>
							<td><span class="skeleton" style="width: 55%"></span></td>
						</tr>
					{/each}
				{:else if queue.length === 0}
					<tr><td colspan="6" class="empty">คิวว่าง — ไม่มี asset ที่ถูก flag หรือเหตุการณ์ CSAM</td></tr>
				{:else}
					{#each queue as item, i (item.assetId ?? `${item.source}-${item.occurredAt}-${i}`)}
						<tr>
							<td><span class="pill pill-{item.source === 'csam_block' ? 'danger' : 'warn'}">{item.source}</span></td>
							<td>
								<div class="cell-stack">
									<code class="muted">{item.projectId ?? "—"}</code>
									<code class="muted">{item.workspaceId ?? "—"}</code>
								</div>
							</td>
							<td>{item.moderationStatus ?? "—"}</td>
							<td class="muted">{item.moderationProvider ?? "—"}</td>
							<td class="muted">{item.moderationReason ?? "—"}</td>
							<td class="muted">{fmtDateTime(item.occurredAt)}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	{#if !queueLoading && queue.length > 0}
		<footer class="table-foot">
			<span class="muted">แสดง {queue.length} รายการ</span>
			{#if queueCursor}
				<button type="button" class="btn ws-btn-ghost" onclick={() => void loadMoreQueue()} disabled={queueLoadingMore}>
					{queueLoadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}
				</button>
			{/if}
		</footer>
	{/if}
</section>

<!-- ── Detail drawer ─────────────────────────────────────────── -->
{#if drawerOpen}
	<div
		class="drawer-scrim"
		role="presentation"
		onclick={closeDrawer}
	></div>
	<aside class="drawer" aria-label="รายละเอียดโปรเจกต์">
		<header class="drawer-head">
			<h2>รายละเอียดโปรเจกต์</h2>
			<button type="button" class="link" onclick={closeDrawer}>ปิด</button>
		</header>

		<div class="drawer-body">
			{#if detailLoading}
				<div class="drawer-loading">
					<span class="skeleton" style="width: 60%; height: 18px"></span>
					<span class="skeleton" style="width: 40%"></span>
					<span class="skeleton" style="width: 80%"></span>
					<span class="skeleton" style="width: 70%"></span>
				</div>
			{:else if detailError}
				<p class="alert error" role="alert">{detailError}</p>
			{:else if detail}
				<h3 class="drawer-title">{detail.title || "(ไม่มีชื่อ)"}</h3>
				<div class="drawer-badges">
					<span class="pill pill-{statusLabel(detail.status)}">{statusLabel(detail.status)}</span>
					{#if detail.adminFlagged}<span class="pill pill-flag">flagged</span>{/if}
					{#if detail.adminHidden}<span class="pill pill-danger">hidden</span>{/if}
				</div>

				<dl class="meta">
					<dt>Project ID</dt><dd><code>{detail.projectId}</code></dd>
					<dt>Workspace</dt><dd>{detail.workspaceName || "—"} <code class="muted">{detail.workspaceId ?? "—"}</code></dd>
					<dt>Owner user</dt><dd><code class="muted">{detail.ownerUserId ?? "—"}</code></dd>
					<dt>ภาษา</dt><dd>{detail.sourceLang ?? "—"} → {detail.targetLang ?? "—"}</dd>
					<dt>Pages / Assets</dt><dd>{detail.pageCount} / {detail.assetCount}</dd>
					<dt>Flagged assets</dt><dd>{detail.flaggedAssetCount}</dd>
					<dt>CSAM blocks</dt><dd>{detail.csamBlockCount}</dd>
					<dt>Created</dt><dd>{fmtDateTime(detail.createdAt)}</dd>
					<dt>Updated</dt><dd>{fmtDateTime(detail.updatedAt)}</dd>
				</dl>

				{#if detail.adminFlagged}
					<div class="audit-note">
						<strong>Flagged</strong>
						<span class="muted">{fmtDateTime(detail.adminFlaggedAt)} · by {detail.adminFlaggedBy ?? "—"}</span>
						{#if detail.adminFlagReason}<p class="reason">{detail.adminFlagReason}</p>{/if}
					</div>
				{/if}
				{#if detail.adminHidden}
					<div class="audit-note">
						<strong>Hidden</strong>
						<span class="muted">{fmtDateTime(detail.adminHiddenAt)} · by {detail.adminHiddenBy ?? "—"}</span>
						{#if detail.adminHideReason}<p class="reason">{detail.adminHideReason}</p>{/if}
					</div>
				{/if}

				<div class="drawer-actions">
					{#if detail.adminFlagged}
						<button type="button" class="btn ws-btn-ghost" disabled={!canModerate || actionBusy} onclick={() => detail && handleUnflag(detail)}>เอา flag ออก</button>
					{:else}
						<button type="button" class="btn warn ws-btn-ghost" disabled={!canModerate || actionBusy} onclick={() => detail && handleFlag(detail)}>Flag</button>
					{/if}
					{#if detail.adminHidden}
						<button type="button" class="btn ws-btn-ghost" disabled={!canModerate || actionBusy} onclick={() => detail && handleUnhide(detail)}>เลิกซ่อน</button>
					{:else}
						<button type="button" class="btn danger ws-btn-ghost" disabled={!canModerate || actionBusy} onclick={() => detail && handleHide(detail)}>ซ่อน</button>
					{/if}
				</div>
				{#if !canModerate}
					<p class="muted readonly-note">การ moderate ต้องมีสิทธิ์ <code>admin:content.moderate</code></p>
				{/if}

				<h4 class="drawer-subhead">Pages ({detail.pages.length})</h4>
				{#if detail.pages.length === 0}
					<p class="muted">ไม่มีข้อมูลหน้า</p>
				{:else}
					<ul class="page-list">
						{#each detail.pages as pg (pg.pageId)}
							<li>
								<span class="page-idx">#{pg.pageIndex}</span>
								<span class="muted">{pg.status}</span>
								<span class="muted">{pg.textLayerCount} text · {pg.imageLayerCount} image</span>
							</li>
						{/each}
					</ul>
				{/if}

				<h4 class="drawer-subhead">Flagged assets ({detail.flaggedAssets.length})</h4>
				{#if detail.flaggedAssets.length === 0}
					<p class="muted">ไม่มี asset ที่ถูก flag</p>
				{:else}
					<ul class="page-list">
						{#each detail.flaggedAssets as item, i (item.assetId ?? `${item.source}-${i}`)}
							<li>
								<span class="pill pill-{item.source === 'csam_block' ? 'danger' : 'warn'}">{item.source}</span>
								<span class="muted">{item.moderationStatus ?? "—"}</span>
								<span class="muted">{item.moderationReason ?? ""}</span>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	</aside>
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
	select.input { flex: 0 1 180px; }
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: color-mix(in srgb, var(--color-ws-ink) 75%, transparent);
		white-space: nowrap;
	}
	.check input { accent-color: var(--color-ws-violet); }
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
	.btn.warn { border-color: color-mix(in srgb, var(--color-ws-amber) 35%, transparent); color: var(--color-ws-amber); }
	.btn.danger { border-color: color-mix(in srgb, var(--color-ws-rose) 35%, transparent); color: var(--color-ws-rose); }
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
	.alert.ok {
		color: var(--color-ws-green);
		background: color-mix(in srgb, var(--color-ws-green) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 18%, transparent);
	}
	.table-wrap {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		/* Scroll horizontally on small/tablet widths instead of clipping the
		   wide columns. */
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
		margin-right: 4px;
	}
	.pill-active { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-hidden { background: color-mix(in srgb, var(--color-ws-text) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-text) 30%, transparent); color: var(--color-ws-text); }
	.pill-deleted { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.pill-flag { background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 35%, transparent); color: var(--color-ws-rose); }
	.pill-warn { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-danger { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
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
	.empty {
		padding: 32px 14px;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
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

	/* Moderation queue section */
	.queue { margin-top: 32px; }
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
		margin-bottom: 12px;
		flex-wrap: wrap;
	}
	.section-head h2 { font-size: 16px; margin: 0; color: var(--color-ws-ink); }

	/* Detail drawer */
	.drawer-scrim {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
		z-index: 40;
	}
	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(440px, 92vw);
		background: var(--color-ws-surface);
		border-left: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		z-index: 41;
		display: flex;
		flex-direction: column;
		box-shadow: -16px 0 40px color-mix(in srgb, var(--color-ws-bg) 40%, transparent);
	}
	.drawer-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 20px;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
	}
	.drawer-head h2 { font-size: 15px; margin: 0; color: var(--color-ws-ink); }
	.drawer-body { padding: 18px 20px; overflow-y: auto; }
	.drawer-loading { display: flex; flex-direction: column; gap: 8px; }
	.drawer-title { font-size: 17px; margin: 0 0 8px; color: var(--color-ws-ink); }
	.drawer-badges { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
	.meta {
		display: grid;
		grid-template-columns: 110px 1fr;
		gap: 6px 12px;
		margin: 0 0 16px;
		font-size: 13px;
	}
	.meta dt { color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); }
	.meta dd { margin: 0; color: color-mix(in srgb, var(--color-ws-ink) 85%, transparent); word-break: break-word; }
	.meta code { font-size: 11px; }
	.audit-note {
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 12px;
		margin-bottom: 10px;
		font-size: 12px;
	}
	.audit-note strong { color: var(--color-ws-ink); margin-right: 8px; }
	.audit-note .reason { margin: 6px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent); }
	.drawer-actions { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
	.readonly-note { margin: 16px 0; font-style: italic; }
	.drawer-subhead {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent);
		margin: 18px 0 8px;
	}
	.page-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
	.page-list li { display: flex; align-items: center; gap: 10px; font-size: 12px; }
	.page-idx { color: var(--color-ws-ink); font-weight: 600; min-width: 36px; }
	code { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); padding: 1px 5px; border-radius: 4px; }
</style>
