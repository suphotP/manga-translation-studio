<!--
Admin USER detail.

One-pane overview of a single platform user over /api/admin/users-mgmt/:id:
identity + auth, platform role, account status, workspace memberships, and the
recent admin-audit trail TARGETING this account. The two audited mutations live
here:
  * change platform role (dropdown) — gated on admin:roles.write (owner-only;
    only an owner can mint/move roles, matching the backend's ROLES_WRITE gate).
  * enable / disable the account — gated on admin:users.write.

Buttons are DISABLED (not hidden) when the caller lacks the permission, with an
inline note explaining why, so the surface is honest about what an operator can
and cannot do. Destructive actions (disable, role change) confirm first.

The backend remains authoritative and additionally enforces last-owner /
owner-target / self-protection guards that the UI cannot see ahead of time. When
it returns a 403 for one of those (e.g. demoting the last platform owner), we
surface its human-readable message as a friendly error toast — never a crash.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { adminUsersApi, getAdminMe, AdminApiError } from "$lib/api/admin.ts";
	import type {
		AdminUserDetail,
		AdminUserListRow,
		AdminPlatformRole,
	} from "$lib/api/admin/users.ts";

	const USERS_WRITE = "admin:users.write";
	const ROLES_WRITE = "admin:roles.write";

	const ROLE_OPTIONS: AdminPlatformRole[] = [
		"owner",
		"admin",
		"support",
		"accountant",
		"editor",
		"viewer",
	];

	let userId = $derived(page.params.id ?? "");

	let detail = $state<AdminUserDetail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Permissions, read once from GET /api/admin/me (same source as the layout nav).
	let canWriteUsers = $state(false);
	let canWriteRoles = $state(false);

	// Role-change form (seeded from the loaded role; bound to the dropdown).
	// Starts `null` so the dropdown never flashes a wrong fallback role (e.g.
	// "viewer") before /api/admin/users-mgmt/:id resolves — until then the
	// select shows a neutral placeholder and stays disabled.
	let selectedRole = $state<AdminPlatformRole | null>(null);
	let roleBusy = $state(false);
	let statusBusy = $state(false);

	let message = $state<{ kind: "ok" | "error"; text: string } | null>(null);

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) {
			// The backend's guard responses (403) carry a human-readable `error`
			// message (e.g. "Cannot demote the last platform owner"), which
			// AdminApiError surfaces as `.message`. Show it verbatim — it is the
			// friendliest, most accurate thing we can say.
			if (cause.status === 403) return cause.message;
			if (cause.status === 404) return "ไม่พบบัญชีผู้ใช้นี้ (อาจถูกลบไปแล้ว)";
			return `${cause.status}: ${cause.message}`;
		}
		if (cause instanceof Error) return cause.message;
		return "เกิดข้อผิดพลาด";
	}

	function setMessage(kind: "ok" | "error", text: string): void {
		message = { kind, text };
		setTimeout(() => {
			if (message?.text === text) message = null;
		}, 6000);
	}

	async function loadPermissions() {
		try {
			const me = await getAdminMe();
			canWriteUsers = me.permissions.includes(USERS_WRITE);
			canWriteRoles = me.permissions.includes(ROLES_WRITE);
		} catch {
			// Read-only fallback: if we can't confirm the permissions, keep every
			// mutation disabled. The backend stays authoritative regardless.
			canWriteUsers = false;
			canWriteRoles = false;
		}
	}

	async function load() {
		loading = true;
		error = null;
		try {
			detail = await adminUsersApi.getUser(userId);
			selectedRole = detail.user.role;
		} catch (cause) {
			error = describeError(cause);
			detail = null;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadPermissions();
		void load();
	});

	// Reflect a mutation result onto the loaded detail without a full refetch.
	function applyUpdatedUser(updated: AdminUserListRow): void {
		if (!detail) return;
		detail = { ...detail, user: { ...detail.user, ...updated } };
		selectedRole = updated.role;
	}

	const roleChanged = $derived(
		Boolean(detail) && selectedRole !== null && selectedRole !== detail!.user.role,
	);

	async function submitRoleChange() {
		if (!detail || roleBusy) return;
		if (selectedRole === null || !roleChanged) return;
		const oldRole = detail.user.role;
		const confirmed = window.confirm(
			`เปลี่ยน role ของ ${detail.user.email}\nจาก "${oldRole}" → "${selectedRole}"?\nการเปลี่ยนนี้ถูกบันทึกใน admin audit`,
		);
		if (!confirmed) {
			selectedRole = oldRole; // revert the dropdown
			return;
		}
		const reason = window.prompt("เหตุผลในการเปลี่ยน role (จะถูกบันทึกใน audit, เว้นว่างได้)", "") ?? undefined;
		roleBusy = true;
		try {
			const result = await adminUsersApi.changeRole(detail.user.id, selectedRole, reason?.trim() || undefined);
			applyUpdatedUser(result.user);
			setMessage("ok", result.changed ? `เปลี่ยน role เป็น "${result.user.role}" เรียบร้อย` : "Role เดิมไม่เปลี่ยนแปลง");
		} catch (cause) {
			selectedRole = oldRole; // backend rejected → revert the dropdown to truth
			setMessage("error", describeError(cause));
		} finally {
			roleBusy = false;
		}
	}

	async function toggleStatus() {
		if (!detail || statusBusy) return;
		const currentlyActive = detail.user.isActive;
		const verb = currentlyActive ? "ปิดใช้งาน" : "เปิดใช้งาน";
		const confirmed = window.confirm(
			`${verb}บัญชี ${detail.user.email}?` +
				(currentlyActive ? "\nผู้ใช้จะเข้าระบบไม่ได้จนกว่าจะเปิดใช้งานใหม่" : ""),
		);
		if (!confirmed) return;
		const reason = window.prompt(`เหตุผลในการ${verb} (จะถูกบันทึกใน audit, เว้นว่างได้)`, "") ?? undefined;
		statusBusy = true;
		try {
			const result = currentlyActive
				? await adminUsersApi.disableUser(detail.user.id, reason?.trim() || undefined)
				: await adminUsersApi.enableUser(detail.user.id, reason?.trim() || undefined);
			applyUpdatedUser(result.user);
			setMessage("ok", result.user.isActive ? "เปิดใช้งานบัญชีเรียบร้อย" : "ปิดใช้งานบัญชีเรียบร้อย");
		} catch (cause) {
			setMessage("error", describeError(cause));
		} finally {
			statusBusy = false;
		}
	}

	function fmtDateTime(value: string | null): string {
		if (!value) return "—";
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
	}

	function auditLabel(action: string): string {
		switch (action) {
			case "admin.user.role_change": return "เปลี่ยน role";
			case "admin.user.disable": return "ปิดใช้งานบัญชี";
			case "admin.user.enable": return "เปิดใช้งานบัญชี";
			default: return action;
		}
	}
</script>

<header class="page-head">
	<div>
		<a class="back" href="/admin/users">&larr; Users</a>
		<h1>User · <code>{userId}</code></h1>
		<p class="page-sub">โปรไฟล์ + role + สถานะบัญชี และการดำเนินการที่บันทึก audit</p>
	</div>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void load()} disabled={loading}>รีเฟรช</button>
</header>

{#if message}
	<p class="alert {message.kind}" role="status">{message.text}</p>
{/if}

{#if loading && !detail}
	<p class="muted loading">กำลังโหลด…</p>
{:else if error}
	<section class="card ws-panel error-card">
		<strong>โหลดข้อมูลผู้ใช้ไม่สำเร็จ</strong>
		<p class="muted">{error}</p>
		<button type="button" class="btn ws-btn-ghost" onclick={() => void load()}>ลองใหม่</button>
	</section>
{:else if detail}
	<section class="grid">
		<!-- Identity -->
		<article class="card ws-panel">
			<header><h2>โปรไฟล์</h2></header>
			<div class="ident">
				<strong class="ident-email">{detail.user.email}</strong>
				<span class="muted">{detail.user.name || "(ไม่มีชื่อ)"}</span>
				<div class="badges">
					<span class="pill pill-role-{detail.user.role}">{detail.user.role}</span>
					{#if detail.user.isActive}
						<span class="pill pill-active">active</span>
					{:else}
						<span class="pill pill-disabled">disabled</span>
					{/if}
					{#if detail.user.emailVerified}
						<span class="pill pill-verified">email verified</span>
					{:else}
						<span class="pill pill-unverified">email unverified</span>
					{/if}
				</div>
			</div>
			<dl>
				<div><dt>User ID</dt><dd><code>{detail.user.id}</code></dd></div>
				<div><dt>Auth provider</dt><dd>{detail.user.authProvider || "—"}</dd></div>
				<div><dt>Last login</dt><dd>{fmtDateTime(detail.user.lastLogin)}</dd></div>
				<div><dt>สร้างเมื่อ</dt><dd>{fmtDateTime(detail.user.createdAt)}</dd></div>
				<div><dt>แก้ไขล่าสุด</dt><dd>{fmtDateTime(detail.user.updatedAt)}</dd></div>
			</dl>
			{#if detail.user.externalIdentities.length > 0}
				<h3 class="subhead">External identities</h3>
				<ul class="ext-list">
					{#each detail.user.externalIdentities as ident (ident.provider + ident.subject)}
						<li>
							<span class="pill">{ident.provider}</span>
							<code class="muted">{ident.subject}</code>
						</li>
					{/each}
				</ul>
			{/if}
		</article>

		<!-- Role + status actions -->
		<article class="card ws-panel">
			<header><h2>Role & สถานะ</h2></header>

			<div class="action-block">
				<label class="field-label" for="role-select">Platform role</label>
				<div class="role-row">
					<select
						id="role-select"
						class="input"
						bind:value={selectedRole}
						disabled={!canWriteRoles || roleBusy || selectedRole === null}
					>
						{#if selectedRole === null}
							<option value={null} disabled>กำลังโหลด…</option>
						{/if}
						{#each ROLE_OPTIONS as role (role)}
							<option value={role}>{role}</option>
						{/each}
					</select>
					<button
						type="button"
						class="btn primary ws-grad-primary"
						onclick={() => void submitRoleChange()}
						disabled={!canWriteRoles || roleBusy || !roleChanged}
					>
						{roleBusy ? "กำลังบันทึก…" : "เปลี่ยน role"}
					</button>
				</div>
				{#if !canWriteRoles}
					<p class="note muted">การเปลี่ยน role ทำได้เฉพาะ Owner (สิทธิ์ <code>admin:roles.write</code>)</p>
				{/if}
			</div>

			<div class="action-block">
				<span class="field-label">สถานะบัญชี</span>
				<div class="status-row">
					<span class="pill {detail.user.isActive ? 'pill-active' : 'pill-disabled'}">
						{detail.user.isActive ? "active" : "disabled"}
					</span>
					<button
						type="button"
						class="btn ws-btn-ghost {detail.user.isActive ? 'danger' : ''}"
						onclick={() => void toggleStatus()}
						disabled={!canWriteUsers || statusBusy}
					>
						{#if statusBusy}
							กำลังดำเนินการ…
						{:else if detail.user.isActive}
							ปิดใช้งานบัญชี
						{:else}
							เปิดใช้งานบัญชี
						{/if}
					</button>
				</div>
				{#if !canWriteUsers}
					<p class="note muted">เปิด-ปิดบัญชีต้องมีสิทธิ์ <code>admin:users.write</code></p>
				{:else if detail.user.role === "owner"}
					<p class="note muted">การปิดใช้งาน Owner ทำได้เฉพาะ Owner ด้วยกัน และระบบจะปกป้อง Owner คนสุดท้ายไว้เสมอ</p>
				{/if}
			</div>
		</article>
	</section>

	<section class="grid">
		<!-- Workspace memberships -->
		<article class="card ws-panel">
			<header><h2>Workspaces ({detail.workspaceCount})</h2></header>
			{#if detail.workspaces.length === 0}
				<p class="muted">ผู้ใช้นี้ยังไม่ได้เป็นสมาชิก workspace ใด</p>
			{:else}
				<ul class="ws-list">
					{#each detail.workspaces as ws (ws.id)}
						<li>
							<div class="ws-head">
								<strong>{ws.name || "(ไม่มีชื่อ)"}</strong>
								<code class="muted">{ws.id}</code>
							</div>
							<div class="ws-meta">
								<span class="pill">{ws.memberRole}</span>
								{#if ws.memberStudioRole}<span class="pill">{ws.memberStudioRole}</span>{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</article>

		<!-- Recent admin activity targeting this user -->
		<article class="card ws-panel">
			<header><h2>ประวัติการดำเนินการ (audit)</h2></header>
			{#if detail.recentActivity.length === 0}
				<p class="muted">ยังไม่มีการดำเนินการของแอดมินต่อบัญชีนี้</p>
			{:else}
				<ul class="audit-list">
					{#each detail.recentActivity as entry (entry.id)}
						<li>
							<div class="audit-head">
								<strong>{auditLabel(entry.action)}</strong>
								<small class="muted">{fmtDateTime(entry.createdAt)}</small>
							</div>
							<div class="audit-meta muted">
								<span>by <code>{entry.adminUserId}</code></span>
								{#if entry.detail && (entry.detail.reason ?? null)}
									<span>· {String(entry.detail.reason)}</span>
								{/if}
								{#if entry.detail && entry.detail.oldRole && entry.detail.newRole}
									<span>· {String(entry.detail.oldRole)} → {String(entry.detail.newRole)}</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
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
	.page-head h1 { font-size: 22px; margin: 4px 0 0; color: var(--color-ws-ink); }
	.page-head h1 code { font-size: 14px; color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent); }
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; }
	.back { font-size: 12.5px; color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); text-decoration: none; }
	.back:hover { color: var(--color-ws-ink); }
	.loading { padding: 32px 0; }
	.btn {
		min-height: 36px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 14px;
		font-size: 13px;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn:hover { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.5; cursor: not-allowed; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-rose) 100%);
		border-color: transparent;
	}
	.btn.primary:hover { filter: brightness(1.08); }
	.btn.primary[disabled] { filter: none; }
	.btn.danger { border-color: color-mix(in srgb, var(--color-ws-rose) 35%, transparent); color: var(--color-ws-rose); }
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
		min-width: 0;
	}
	.card > header h2 { margin: 0 0 12px; font-size: 14px; color: var(--color-ws-ink); }
	.error-card { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
	.error-card strong { color: var(--color-ws-ink); font-size: 15px; }
	.ident { margin-bottom: 14px; }
	.ident-email { display: block; color: var(--color-ws-ink); font-size: 15px; word-break: break-all; }
	.ident .muted { display: block; margin-top: 2px; }
	.badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 10px; }
	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 110px 1fr;
		gap: 8px 12px;
		font-size: 12.5px;
	}
	dl > div { display: contents; }
	dt { color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent); }
	dd { margin: 0; color: var(--color-ws-ink); word-break: break-word; }
	dd code { font-size: 11.5px; color: color-mix(in srgb, var(--color-ws-ink) 78%, transparent); word-break: break-all; }
	.subhead {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent);
		margin: 16px 0 8px;
	}
	.ext-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
	.ext-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
	.action-block { margin-bottom: 18px; }
	.action-block:last-child { margin-bottom: 0; }
	.field-label {
		display: block;
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 65%, transparent);
		margin-bottom: 6px;
	}
	.role-row, .status-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.input {
		min-height: 36px;
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 10px;
		font-size: 13px;
		flex: 1 1 140px;
		min-width: 120px;
	}
	.input:focus { outline: none; border-color: color-mix(in srgb, var(--color-ws-violet) 50%, transparent); }
	.input[disabled] { opacity: 0.6; cursor: not-allowed; }
	.note { margin: 8px 0 0; font-size: 12px; line-height: 1.5; }
	.note code { font-size: 11px; }
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
	.pill-verified { background: color-mix(in srgb, var(--color-ws-green) 10%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 25%, transparent); color: var(--color-ws-green); }
	.pill-unverified { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.ws-list, .audit-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
	.ws-list li, .audit-list li {
		background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 10px 12px;
	}
	.ws-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
	.ws-head strong { font-size: 13px; color: var(--color-ws-ink); }
	.ws-head code { font-size: 11px; }
	.ws-meta { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
	.audit-head { display: flex; justify-content: space-between; gap: 8px; }
	.audit-head strong { font-size: 12.5px; color: var(--color-ws-ink); }
	.audit-meta { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
	.audit-meta code { font-size: 11px; }
	code { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); padding: 1px 5px; border-radius: 4px; }
</style>
