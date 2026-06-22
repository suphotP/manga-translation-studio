<!-- WorkspaceMembersPanel — the actual member-management surface (invite, role
     change, remove, pending invites, one-time invite link). Self-contained: it
     reads everything from workspacesStore and is NOT gated on editorUiStore, so
     it renders identically inside the WorkspaceShell (via WorkspaceMembersSettings)
     and inside the standalone /settings/members page (the settings-shell chrome).
     Loading the workspace list is owned by the host (WorkspaceSidebar in the shell,
     the +page in the settings shell) — this component only renders what's loaded. -->
<script lang="ts">
	import Avatar from "$lib/components/ui/Avatar.svelte";
	import Chip from "$lib/components/ui/Chip.svelte";
	import StatusPill from "$lib/components/ui/StatusPill.svelte";
	import { _ } from "$lib/i18n";
	import { ApiError } from "$lib/api/client.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import {
		WORKSPACE_ROLE_LABEL,
		type WorkspaceMember,
		WORKSPACE_ROLE_OPTIONS,
		type WorkspaceRole,
		workspacesStore,
	} from "$lib/stores/workspaces.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the key
	// itself on a miss / before init, so guard against that and never leak a raw
	// dotted key to the user). Mirrors the helper used in the settings shell.
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let inviteEmail = $state("");
	let inviteRole = $state<Exclude<WorkspaceRole, "owner">>("translator");
	// #11 scope: an owner can limit an invite to ONE story (its chapter projects) instead
	// of the whole workspace. Stories are grouped from the workspace's project listing.
	let inviteScope = $state<string>("all");
	let inviteStories = $derived.by(() => {
		const byStory = new Map<string, { storyId: string; label: string; projectIds: string[] }>();
		for (const p of projectStore.recentProjects) {
			if (!p.storyId) continue;
			const entry = byStory.get(p.storyId) ?? { storyId: p.storyId, label: p.storyTitle ?? p.name ?? p.storyId, projectIds: [] };
			entry.projectIds.push(p.projectId);
			byStory.set(p.storyId, entry);
		}
		return [...byStory.values()];
	});
	let triedLoadStories = false;
	$effect(() => {
		if (canManage && currentWorkspace && !triedLoadStories && projectStore.recentProjects.length === 0) {
			triedLoadStories = true;
			void projectStore.loadRecentProjects({ workspaceId: currentWorkspace.workspaceId, background: true }).catch(() => undefined);
		}
	});
	let createWorkspaceName = $state("");
	let busyKey = $state<string | null>(null);
	let localError = $state<string | null>(null);
	// Two-step confirm for the destructive member-removal action: the first click
	// arms an inline "Remove / Cancel" confirm naming the member (matching the asset
	// library's inline-confirm pattern) so a single mis-click can never silently
	// remove a teammate. Holds the userId currently awaiting confirmation.
	let pendingRemoveUserId = $state<string | null>(null);

	let currentWorkspace = $derived(workspacesStore.currentWorkspace);
	let canManage = $derived(workspacesStore.isAdmin);
	let currentUserId = $derived(authStore.user?.id ?? null);
	let pendingInvites = $derived(workspacesStore.invites.filter((invite) => invite.status === "pending"));
	let memberCountLabel = $derived(
		t("workspaceMembers.memberCount", "สมาชิก {count} คน").replace("{count}", String(workspacesStore.members.length)),
	);
	let inviteCountLabel = $derived(
		t("workspaceMembers.pendingCount", "รอตอบรับ {count}").replace("{count}", String(pendingInvites.length)),
	);
	let lastInvite = $derived(workspacesStore.lastInvite);
	let inviteLink = $derived(
		lastInvite && typeof window !== "undefined"
			? `${window.location.origin}/invite/${encodeURIComponent(lastInvite.inviteId)}?token=${encodeURIComponent(lastInvite.token)}`
			: "",
	);
	let inviteCopied = $state(false);

	async function copyInviteLink(): Promise<void> {
		if (!inviteLink) return;
		try {
			await navigator.clipboard.writeText(inviteLink);
			inviteCopied = true;
			setTimeout(() => { inviteCopied = false; }, 2000);
		} catch {
			localError = t("workspaceMembers.copyFailed", "คัดลอกลิงก์ไม่สำเร็จ คัดลอกข้อความด้วยตนเอง");
		}
	}

	function dismissInvite(): void {
		workspacesStore.dismissLastInvite();
		inviteCopied = false;
	}

	function memberName(member: WorkspaceMember): string {
		if (member.userId === currentUserId && authStore.user?.name) return authStore.user.name;
		return member.displayName?.trim() || member.userId;
	}

	function memberEmail(member: WorkspaceMember): string {
		if (member.userId === currentUserId && authStore.user?.email) return authStore.user.email;
		// Server only includes email for a full-scope manager; absent ⇒ hidden.
		return member.email?.trim() || t("workspaceMembers.emailNotExposed", "ไม่มีสิทธิ์เห็นอีเมลของสมาชิกนี้");
	}

	function formatDate(value: string | undefined): string {
		if (!value) return "-";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "-";
		return new Intl.DateTimeFormat("th-TH", {
			year: "numeric",
			month: "short",
			day: "numeric",
		}).format(date);
	}

	function roleTone(role: WorkspaceRole): "urgent" | "review" | "active" | "late" | "done" | "todo" | "neutral" {
		// Role badges use the single workspace accent (violet "review" tone) for every
		// real role so the members table matches the dashboard's one-accent system;
		// guests stay neutral. These are brand/role labels, not workflow status, so
		// they intentionally avoid the cyan/green status tones.
		if (role === "guest") return "neutral";
		return "review";
	}

	// True once the backend has told us this deployment can't issue invites
	// (file-mode workspace store → 501 workspace_invites_unavailable). We latch it
	// so the form switches to a friendly localized notice instead of re-surfacing
	// the raw backend string ("…require the Postgres workspace store") on retry.
	let invitesUnavailable = $state(false);

	// Map an invite-submit failure to a friendly localized message. The 501
	// "workspace invites require the Postgres workspace store" is an infra detail
	// the user must never see — translate it to a plain Thai notice. Other errors
	// fall back to a generic localized "couldn't send the invite".
	function inviteErrorMessage(error: unknown): string {
		const unavailable =
			(error instanceof ApiError && (error.status === 501 || error.code === "workspace_invites_unavailable"));
		if (unavailable) {
			invitesUnavailable = true;
			return t(
				"workspaceMembers.inviteUnavailable",
				"ระบบเชิญสมาชิกยังไม่พร้อมในโหมดนี้ — ระหว่างนี้เพิ่มสมาชิกได้จากฝั่งเซิร์ฟเวอร์โดยตรง",
			);
		}
		return t("workspaceMembers.inviteFailed", "ส่งคำเชิญไม่สำเร็จ");
	}

	async function sendInvite(): Promise<void> {
		if (busyKey) return; // in-flight guard — never fire a second invite on a double-click
		if (!currentWorkspace || !inviteEmail.trim()) return;
		busyKey = "invite";
		localError = null;
		try {
			const scopedProjectIds = inviteScope === "all" ? undefined : inviteStories.find((story) => story.storyId === inviteScope)?.projectIds;
			await workspacesStore.inviteMember(currentWorkspace.workspaceId, inviteEmail.trim(), inviteRole, scopedProjectIds);
			inviteEmail = "";
			inviteRole = "translator";
			inviteScope = "all";
		} catch (error) {
			localError = inviteErrorMessage(error);
		} finally {
			busyKey = null;
		}
	}

	async function createWorkspace(): Promise<void> {
		if (busyKey) return; // in-flight guard
		if (!createWorkspaceName.trim()) return;
		busyKey = "create-workspace";
		localError = null;
		try {
			await workspacesStore.create(createWorkspaceName.trim(), "free");
			createWorkspaceName = "";
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.createFailed", "สร้างเวิร์กสเปซไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	async function updateRole(userId: string, role: Exclude<WorkspaceRole, "owner">): Promise<void> {
		if (busyKey) return; // in-flight guard — block a second role write
		if (!currentWorkspace) return;
		busyKey = `role:${userId}`;
		localError = null;
		try {
			await workspacesStore.updateMemberRole(currentWorkspace.workspaceId, userId, role);
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.roleUpdateFailed", "อัปเดตบทบาทไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	// "Finish job": demote the member to a free viewer seat (frees a paid seat),
	// keeping their scope so they still see their work; the prior role is stashed
	// for one-click Reopen.
	async function finishMember(userId: string): Promise<void> {
		if (busyKey || !currentWorkspace) return;
		busyKey = `finish:${userId}`;
		localError = null;
		try {
			await workspacesStore.finishMember(currentWorkspace.workspaceId, userId);
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.finishJobFailed", "จบงานไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	async function reopenMember(userId: string): Promise<void> {
		if (busyKey || !currentWorkspace) return;
		busyKey = `reopen:${userId}`;
		localError = null;
		try {
			await workspacesStore.reopenMember(currentWorkspace.workspaceId, userId);
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.reopenFailed", "เปิดงานคืนไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	// Step 1: arm the inline confirm for this member (does NOT remove). A second,
	// explicit click on the confirm button runs the actual removal.
	function requestRemoveMember(userId: string): void {
		if (busyKey) return;
		pendingRemoveUserId = userId;
		localError = null;
	}

	function cancelRemoveMember(): void {
		pendingRemoveUserId = null;
	}

	// Step 2: the confirmed, destructive removal. Guarded so a double-click on the
	// confirm button can't fire two removals.
	async function confirmRemoveMember(userId: string): Promise<void> {
		if (busyKey) return;
		if (!currentWorkspace) return;
		busyKey = `remove:${userId}`;
		localError = null;
		try {
			await workspacesStore.removeMember(currentWorkspace.workspaceId, userId);
			pendingRemoveUserId = null;
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.removeFailed", "ลบสมาชิกไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	async function cancelInvite(inviteId: string): Promise<void> {
		if (busyKey) return; // in-flight guard
		busyKey = `invite:${inviteId}`;
		localError = null;
		try {
			await workspacesStore.cancelInvite(inviteId);
		} catch (error) {
			localError = error instanceof Error ? error.message : t("workspaceMembers.cancelInviteFailed", "ยกเลิกคำเชิญไม่สำเร็จ");
		} finally {
			busyKey = null;
		}
	}

	// Explicit (non-silent) refresh: only admins reach this, so any 403 here is a real
	// failure worth surfacing via workspacesStore.error — unlike the silent auto-load.
	async function refreshMembers(): Promise<void> {
		if (busyKey) return; // in-flight guard
		if (!currentWorkspace) return;
		busyKey = "refresh";
		localError = null;
		try {
			await Promise.all([
				workspacesStore.listMembers(currentWorkspace.workspaceId),
				workspacesStore.listInvites(currentWorkspace.workspaceId),
			]);
		} catch {
			// workspacesStore.error already carries the message for the banner.
		} finally {
			busyKey = null;
		}
	}
</script>

{#if workspacesStore.status === "loading" && !currentWorkspace}
<section class="workspace-members-settings" aria-label="Workspace members settings">
	<div class="settings-empty">
		<strong>{t("workspaceMembers.loadingTitle", "กำลังโหลดเวิร์กสเปซ")}</strong>
		<span>{t("workspaceMembers.loadingBody", "กำลังดึงเวิร์กสเปซ สมาชิก และคำเชิญจากแบ็กเอนด์")}</span>
	</div>
</section>
{:else if workspacesStore.status === "error" && !currentWorkspace}
<section class="workspace-members-settings" aria-label="Workspace members settings">
	<div class="settings-empty">
		<strong>{t("workspaceMembers.loadErrorTitle", "ยังโหลดเวิร์กสเปซไม่ได้")}</strong>
		<span>{workspacesStore.error ?? t("workspaceMembers.loadErrorBody", "ตรวจสอบการเข้าสู่ระบบและแบ็กเอนด์ แล้วลองใหม่อีกครั้ง")}</span>
		<div class="create-inline">
			<input bind:value={createWorkspaceName} placeholder={t("workspaceMembers.createPlaceholder", "ชื่อเวิร์กสเปซ")} aria-label={t("workspaceMembers.createPlaceholder", "ชื่อเวิร์กสเปซ")} />
			<button type="button" onclick={createWorkspace} disabled={busyKey !== null}>{busyKey === "create-workspace" ? t("workspaceMembers.creating", "กำลังสร้าง…") : t("workspaceMembers.createButton", "สร้างเวิร์กสเปซ")}</button>
		</div>
	</div>
</section>
{:else if !currentWorkspace}
<!-- Authenticated, load settled, but the user belongs to no workspace yet
     (a fresh account before joining/creating one). Honest empty state with a
     create affordance instead of a blank panel. -->
<section class="workspace-members-settings" aria-label="Workspace members settings">
	<div class="settings-empty">
		<strong>{t("workspaceMembers.noWorkspaceTitle", "ยังไม่มีเวิร์กสเปซ")}</strong>
		<span>{t("workspaceMembers.noWorkspaceBody", "สร้างเวิร์กสเปซแรกเพื่อเริ่มเชิญทีมและจัดการสมาชิก")}</span>
		<div class="create-inline">
			<input bind:value={createWorkspaceName} placeholder={t("workspaceMembers.createPlaceholder", "ชื่อเวิร์กสเปซ")} aria-label={t("workspaceMembers.createPlaceholder", "ชื่อเวิร์กสเปซ")} />
			<button type="button" onclick={createWorkspace} disabled={busyKey !== null}>{busyKey === "create-workspace" ? t("workspaceMembers.creating", "กำลังสร้าง…") : t("workspaceMembers.createButton", "สร้างเวิร์กสเปซ")}</button>
		</div>
	</div>
</section>
{:else}
<section class="workspace-members-settings" aria-label="Workspace settings">
	<header class="settings-hero">
		<div>
			<p class="settings-eyebrow">{t("workspaceMembers.heroEyebrow", "การตั้งค่าเวิร์กสเปซ")}</p>
			<h1>{currentWorkspace.name}</h1>
			<div class="settings-meta">
				<Chip label={currentWorkspace.planId || "free"} icon={t("workspaceMembers.planIcon", "แพ็กเกจ")} />
				<Chip label={memberCountLabel} />
				<Chip label={inviteCountLabel} />
			</div>
		</div>
		<div class="settings-actions">
			<a href="/dashboard">{t("workspaceMembers.dashboard", "แดชบอร์ด")}</a>
			<a href="/settings/billing">{t("workspaceMembers.billing", "การเงินและบิล")}</a>
		</div>
	</header>

	{#if localError || workspacesStore.error}
		<div class="settings-error" role="status">{localError ?? workspacesStore.error}</div>
	{/if}

	{#if !canManage}
		<!-- Honest permission state: the /members + /invites endpoints are admin/owner
		     only. An editor/translator/etc. sees their own membership read-only rather
		     than a dead/blank page or a confusing 403 banner. -->
		<div class="permission-note" role="status">
			<strong>{t("workspaceMembers.viewOnlyTitle", "โหมดดูอย่างเดียว")}</strong>
			<span>
				{t(
					"workspaceMembers.viewOnlyBody",
					"บัญชีนี้เป็นสมาชิกของเวิร์กสเปซ แต่ยังไม่มีสิทธิ์จัดการสมาชิก — เฉพาะ Owner / Admin เท่านั้นที่เชิญคน เปลี่ยน role หรือเอาคนออกได้ ติดต่อเจ้าของเวิร์กสเปซ หากต้องการสิทธิ์เพิ่ม",
				)}
			</span>
		</div>
	{/if}

	<div class="settings-grid">
		<section class="settings-panel invite-panel" aria-label="Invite member">
			<div class="panel-head">
				<div>
					<span>{t("workspaceMembers.inviteEyebrow", "เชิญ")}</span>
					<strong>{t("workspaceMembers.inviteTitle", "เพิ่มคนเข้าทีม")}</strong>
				</div>
				<StatusPill label={canManage ? t("workspaceMembers.roleAdmin", "ผู้ดูแล") : t("workspaceMembers.roleReadOnly", "ดูอย่างเดียว")} tone={canManage ? "review" : "neutral"} />
			</div>
			{#if canManage && invitesUnavailable}
				<!-- File-mode deployment can't issue invites (backend 501). Show a
				     friendly localized notice INSTEAD of the form so the raw
				     "…Postgres workspace store" string can never reach the user. -->
				<p class="readonly-note">{t("workspaceMembers.inviteUnavailable", "ระบบเชิญสมาชิกยังไม่พร้อมในโหมดนี้ — ระหว่างนี้เพิ่มสมาชิกได้จากฝั่งเซิร์ฟเวอร์โดยตรง")}</p>
			{:else if canManage}
				<div class="invite-form">
					<label>
						<span>{t("workspaceMembers.emailLabel", "อีเมล")}</span>
						<input type="email" bind:value={inviteEmail} placeholder={t("workspaceMembers.emailPlaceholder", "teammate@example.com")} autocomplete="email" />
					</label>
					<label>
						<span>{t("workspaceMembers.roleLabel", "บทบาท")}</span>
						<select bind:value={inviteRole}>
							{#each WORKSPACE_ROLE_OPTIONS as role}
								<option value={role.value}>{role.label}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>{t("workspaceMembers.scopeLabel", "ขอบเขต")}</span>
						<select bind:value={inviteScope}>
							<option value="all">{t("workspaceMembers.scopeAll", "ทั้งเวิร์กสเปซ")}</option>
							{#each inviteStories as story (story.storyId)}
								<option value={story.storyId}>{story.label}</option>
							{/each}
						</select>
					</label>
					{#if inviteEmail.trim()}
						<button type="button" class="primary-action" onclick={sendInvite} disabled={busyKey !== null}>
							{busyKey === "invite" ? t("workspaceMembers.sending", "กำลังส่ง…") : t("workspaceMembers.sendInvite", "ส่งคำเชิญ")}
						</button>
					{:else}
						<span class="action-receipt">{t("workspaceMembers.enterEmail", "กรอกอีเมล")}</span>
					{/if}
				</div>
				{#if lastInvite}
					<div class="invite-token" role="status" aria-label={t("workspaceMembers.inviteLinkAria", "ลิงก์เชิญแบบใช้ครั้งเดียว")}>
						<div class="invite-token-head">
							<div>
								<strong>{t("workspaceMembers.inviteLinkTitle", "ลิงก์เชิญ (ใช้ได้ครั้งเดียว)")}</strong>
								<span>
								{#if lastInvite.emailSent}
									{t("workspaceMembers.inviteLinkBodySent", "ส่งอีเมลเชิญถึง {email} แล้ว — ลิงก์นี้เป็นสำรองเผื่ออีเมลไม่ถึง และโทเค็นจะไม่แสดงอีก").replace("{email}", lastInvite.email)}
								{:else}
									{t("workspaceMembers.inviteLinkBody", "ส่งอีเมลไม่สำเร็จ — คัดลอกลิงก์นี้ส่งให้ {email} เอง โทเค็นจะไม่แสดงอีก").replace("{email}", lastInvite.email)}
								{/if}
							</span>
							</div>
							<button type="button" class="invite-token-dismiss" onclick={dismissInvite} aria-label={t("workspaceMembers.inviteLinkDismiss", "เสร็จสิ้น")}>{t("workspaceMembers.inviteLinkDismiss", "เสร็จสิ้น")}</button>
						</div>
						<div class="invite-token-row">
							<input class="invite-token-field" readonly value={inviteLink} aria-label={t("workspaceMembers.inviteLinkFieldAria", "ลิงก์เชิญ")} />
							<button type="button" class="primary-action" onclick={copyInviteLink}>
								{inviteCopied ? t("workspaceMembers.copied", "คัดลอกแล้ว") : t("workspaceMembers.copyLink", "คัดลอกลิงก์")}
							</button>
						</div>
					</div>
				{/if}
				<div class="role-help">
					{#each WORKSPACE_ROLE_OPTIONS as role}
						<div>
							<strong>{role.label}</strong>
							<span>{t(`workspaceMembers.roleDesc.${role.value}`, role.detail)}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="readonly-note">{t("workspaceMembers.noManageNote", "บัญชีนี้ยังไม่มีสิทธิ์จัดการสมาชิกหรือส่งคำเชิญ")}</p>
			{/if}
		</section>

		<section class="settings-panel pending-panel" aria-label="Pending invites">
			<div class="panel-head">
				<div>
					<span>{t("workspaceMembers.pendingEyebrow", "รอตอบรับ")}</span>
					<strong>{t("workspaceMembers.pendingTitle", "คำเชิญที่รอตอบรับ")}</strong>
				</div>
				<StatusPill label={inviteCountLabel} tone={pendingInvites.length ? "review" : "neutral"} />
			</div>
			{#if pendingInvites.length}
				<div class="invite-list">
					{#each pendingInvites as invite (invite.inviteId)}
						<div class="invite-row">
							<div>
								<strong>{invite.email}</strong>
								<span>{WORKSPACE_ROLE_LABEL[invite.displayRole]} · {t("workspaceMembers.expires", "หมดอายุ {date}").replace("{date}", formatDate(invite.expiresAt))}</span>
							</div>
							{#if canManage}
								<button type="button" onclick={() => cancelInvite(invite.inviteId)} disabled={busyKey !== null}>
									{busyKey === `invite:${invite.inviteId}` ? t("workspaceMembers.canceling", "กำลังยกเลิก…") : t("workspaceMembers.cancel", "ยกเลิก")}
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{:else if canManage}
				<p class="readonly-note">{t("workspaceMembers.noPending", "ไม่มีคำเชิญที่รอตอบรับ")}</p>
			{:else}
				<p class="readonly-note">{t("workspaceMembers.pendingAdminOnly", "เฉพาะ Admin ที่เห็นรายการคำเชิญที่รอตอบรับ")}</p>
			{/if}
		</section>
	</div>

	<section class="settings-panel members-panel" aria-label="Workspace member table">
		<div class="panel-head">
			<div>
				<span>{t("workspaceMembers.membersEyebrow", "สมาชิก")}</span>
				<strong>{t("workspaceMembers.membersTitle", "รายชื่อและการกำหนดบทบาท")}</strong>
			</div>
			<div class="panel-head-actions">
				{#if canManage}
					<button type="button" onclick={refreshMembers} disabled={busyKey !== null}>
						{busyKey === "refresh" ? t("workspaceMembers.refreshing", "กำลังรีเฟรช…") : t("workspaceMembers.refresh", "รีเฟรช")}
					</button>
				{/if}
				<StatusPill label={workspacesStore.membersStatus === "loading" ? t("workspaceMembers.syncing", "กำลังซิงก์") : memberCountLabel} tone="review" />
			</div>
		</div>
		{#if !canManage && workspacesStore.members.length === 0}
			<!-- Editors can't list members (admin-gated endpoint). Be honest rather
			     than render an empty table that looks broken. -->
			<p class="readonly-note">{t("workspaceMembers.membersAdminOnly", "รายชื่อสมาชิกทั้งหมดดูได้เฉพาะ Owner / Admin")}</p>
		{:else}
		<div class="member-table" role="table" aria-label="Workspace members">
			<div class="member-row member-head" role="row">
				<span role="columnheader">{t("workspaceMembers.colName", "ชื่อ")}</span>
				<span role="columnheader">{t("workspaceMembers.colEmail", "อีเมล")}</span>
				<span role="columnheader">{t("workspaceMembers.colRole", "บทบาท")}</span>
				<span role="columnheader">{t("workspaceMembers.colJoined", "เข้าร่วมเมื่อ")}</span>
				<span role="columnheader">{t("workspaceMembers.colActions", "การจัดการ")}</span>
			</div>
			{#each workspacesStore.members as member (member.userId)}
				<div class="member-row" role="row">
					<div class="member-person" role="cell">
						<Avatar name={memberName(member)} size="md" tone={member.displayRole === "owner" ? "amber" : "violet"} />
						<span>{memberName(member)}</span>
					</div>
					<span class="member-email" role="cell">{memberEmail(member)}</span>
					<span role="cell">
						<StatusPill label={WORKSPACE_ROLE_LABEL[member.displayRole]} tone={roleTone(member.displayRole)} />
					</span>
					<span role="cell">{formatDate(member.createdAt)}</span>
					<div class="member-actions" role="cell">
						{#if canManage && member.displayRole !== "owner" && member.finishedFrom}
							<!-- Finished member: a free viewer seat with a one-click restore. -->
							<span class="finished-badge">{t("workspaceMembers.finishedBadge", "จบงานแล้ว · ดูได้อย่างเดียว")}</span>
							{#if member.userId !== currentUserId}
								<button type="button" class="primary-action" onclick={() => reopenMember(member.userId)} disabled={busyKey !== null}>
									{busyKey === `reopen:${member.userId}` ? t("workspaceMembers.reopening", "กำลังเปิดงานคืน…") : t("workspaceMembers.reopen", "เปิดงานอีกครั้ง")}
								</button>
							{:else}
								<span class="action-receipt">{t("workspaceMembers.currentUser", "ผู้ใช้ปัจจุบัน")}</span>
							{/if}
						{:else if canManage && member.displayRole !== "owner"}
							<select
								aria-label={t("workspaceMembers.changeRoleAria", "เปลี่ยนบทบาทของ {name}").replace("{name}", memberName(member))}
								value={member.displayRole}
								disabled={busyKey !== null}
								onchange={(event) => updateRole(member.userId, (event.currentTarget as HTMLSelectElement).value as Exclude<WorkspaceRole, "owner">)}
							>
								{#each WORKSPACE_ROLE_OPTIONS as role}
									<option value={role.value}>{role.label}</option>
								{/each}
							</select>
							{#if member.userId !== currentUserId && member.role !== "viewer"}
								<!-- Two distinct "finish" choices (issue #1): Finish → free viewer
								     seat that STILL sees the work; Remove (below) → out of the
								     workspace, sees nothing. Titles spell the difference out. -->
								<button type="button" class="finish-action" title={t("workspaceMembers.finishJobHint", "จบงานแต่ยังให้เห็นงานเดิมได้ (เป็นผู้ชม ไม่กินที่นั่ง) — เปิดงานคืนได้")} onclick={() => finishMember(member.userId)} disabled={busyKey !== null}>
									{busyKey === `finish:${member.userId}` ? t("workspaceMembers.finishing", "กำลังจบงาน…") : t("workspaceMembers.finishJob", "จบงาน (ยังดูได้)")}
								</button>
							{/if}
							{#if member.userId !== currentUserId}
								{#if pendingRemoveUserId === member.userId}
									<!-- Inline confirm — the destructive removal requires this second,
									     explicit click, naming the member, so a single mis-click is harmless. -->
									<span class="remove-confirm" role="group" aria-label={t("workspaceMembers.removeConfirmAria", "ยืนยันการเอา {name} ออก").replace("{name}", memberName(member))}>
										<span class="remove-confirm-label">{t("workspaceMembers.removeConfirm", "เอา {name} ออกใช่ไหม?").replace("{name}", memberName(member))}</span>
										<button type="button" class="danger-action" onclick={() => confirmRemoveMember(member.userId)} disabled={busyKey !== null}>
											{busyKey === `remove:${member.userId}` ? t("workspaceMembers.removing", "กำลังเอาออก…") : t("workspaceMembers.removeConfirmYes", "เอาออก")}
										</button>
										<button type="button" onclick={cancelRemoveMember} disabled={busyKey !== null}>
											{t("workspaceMembers.removeConfirmNo", "ยกเลิก")}
										</button>
									</span>
								{:else}
									<button type="button" class="danger-action" title={t("workspaceMembers.removeHint", "จบงานและเอาออกจากบ้าน — จะไม่เห็นงานในบ้านนี้อีก (เชิญกลับเข้ามาใหม่ได้)")} onclick={() => requestRemoveMember(member.userId)} disabled={busyKey !== null}>
										{t("workspaceMembers.remove", "จบงาน + เอาออก")}
									</button>
								{/if}
							{:else}
								<span class="action-receipt">{t("workspaceMembers.currentUser", "ผู้ใช้ปัจจุบัน")}</span>
							{/if}
						{:else}
							<span class="action-receipt">{member.displayRole === "owner" ? t("workspaceMembers.ownerLocked", "เจ้าของ (ล็อก)") : t("workspaceMembers.noAdminRights", "ไม่มีสิทธิ์ผู้ดูแล")}</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		{/if}
	</section>
</section>
{/if}

<style>
	.workspace-members-settings {
		min-height: 100%;
		width: 100%;
		padding: clamp(18px, 3vw, 34px);
		color: var(--color-ws-text, #b8c1d6);
		overflow: auto;
	}

	.settings-hero,
	.settings-panel,
	.settings-empty {
		border: 1px solid var(--ws-hair);
		background: var(--color-ws-surface, #15151D);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
	}

	.settings-hero {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		border-radius: 12px;
		padding: clamp(18px, 2.8vw, 28px);
	}

	.settings-eyebrow,
	.panel-head span {
		margin: 0 0 5px;
		color: var(--color-ws-accent, #a78bfa);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		color: var(--color-ws-ink, #fbf7ff);
		font-size: clamp(20px, 2.4vw, 26px);
		font-weight: 700;
		line-height: 1.12;
		letter-spacing: -0.01em;
	}

	.settings-meta,
	.settings-actions,
	.panel-head,
	.member-actions,
	.invite-form {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.settings-meta {
		margin-top: 14px;
		flex-wrap: wrap;
	}

	.settings-actions a,
	button,
	.action-receipt {
		min-height: 40px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 900;
		text-decoration: none;
	}

	.settings-actions a,
	button {
		border: 1px solid var(--ws-hair);
		background: rgba(255, 255, 255, 0.045);
		color: var(--color-ws-ink, #fbf7ff);
		cursor: pointer;
	}

	.primary-action {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
		color: var(--color-ws-accent, #7c5cff);
	}

	.settings-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.8fr);
		gap: 14px;
		margin-top: 14px;
	}

	.settings-panel,
	.settings-empty,
	.settings-error,
	.permission-note {
		border-radius: 12px;
		padding: 16px;
	}

	.members-panel {
		margin-top: 14px;
	}

	.panel-head {
		justify-content: space-between;
		margin-bottom: 14px;
	}

	.panel-head strong {
		display: block;
		color: var(--color-ws-ink, #fbf7ff);
		font-size: 15px;
	}

	label {
		display: grid;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}

	label span {
		color: var(--color-ws-faint, #6b7280);
		font-size: 11px;
		font-weight: 800;
		text-transform: uppercase;
	}

	input,
	select {
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.045);
		color: var(--color-ws-ink, #fbf7ff);
		padding: 0 11px;
		font-size: 13px;
		outline: none;
	}

	option {
		color: #111827;
	}

	.role-help,
	.invite-list {
		display: grid;
		gap: 8px;
		margin-top: 14px;
	}

	.role-help {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.role-help div,
	.invite-row {
		border: 1px solid var(--ws-hair);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.03);
		padding: 10px;
	}

	.role-help strong,
	.invite-row strong {
		display: block;
		color: var(--color-ws-ink, #fbf7ff);
		font-size: 12px;
	}

	.role-help span,
	.invite-row span,
	.readonly-note,
	.settings-empty span {
		color: var(--color-ws-text, #b8c1d6);
		font-size: 12px;
		line-height: 1.45;
	}

	.invite-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.panel-head-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.invite-token {
		margin-top: 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 28%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, transparent);
		padding: 12px;
		display: grid;
		gap: 10px;
	}

	.invite-token-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.invite-token-head strong {
		display: block;
		color: var(--color-ws-accent, #7c5cff);
		font-size: 12px;
	}

	.invite-token-head span {
		display: block;
		margin-top: 3px;
		color: var(--color-ws-text, #b8c1d6);
		font-size: 11px;
		line-height: 1.45;
	}

	.invite-token-dismiss {
		flex: 0 0 auto;
	}

	.invite-token-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
	}

	.invite-token-field {
		width: 100%;
		font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
		font-size: 11px;
	}

	.member-table {
		display: grid;
		gap: 1px;
		overflow: hidden;
		border: 1px solid var(--ws-hair);
		border-radius: 12px;
	}

	.member-row {
		display: grid;
		grid-template-columns: minmax(180px, 1.2fr) minmax(220px, 1.2fr) minmax(120px, 0.7fr) minmax(120px, 0.6fr) minmax(250px, 1.2fr);
		gap: 12px;
		align-items: center;
		min-height: 58px;
		padding: 10px 12px;
		background: rgba(255, 255, 255, 0.025);
		font-size: 13px;
	}

	.member-head {
		min-height: 42px;
		background: rgba(255, 255, 255, 0.055);
		color: var(--color-ws-faint, #6b7280);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.member-person {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		color: var(--color-ws-ink, #fbf7ff);
		font-weight: 800;
	}

	.member-person span,
	.member-email {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.member-actions select {
		width: 132px;
	}

	.danger-action {
		border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 10%, transparent);
		color: var(--color-ws-rose, #FB7185);
	}

	.finish-action {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 12%, transparent);
		color: var(--color-ws-amber, #FBBF24);
	}

	.finished-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 700;
		color: var(--color-ws-amber, #FBBF24);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 25%, transparent);
	}

	button:disabled {
		opacity: 0.55;
		cursor: progress;
	}

	.remove-confirm {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.remove-confirm-label {
		color: var(--color-ws-rose, #FB7185);
		font-size: 11px;
		font-weight: 800;
	}

	.action-receipt {
		border: 1px solid var(--ws-hair);
		background: rgba(255, 255, 255, 0.035);
		color: var(--color-ws-faint, #6b7280);
	}

	.settings-error {
		margin-top: 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose, #FB7185) 20%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 10%, transparent);
		color: var(--color-ws-rose, #FB7185);
		font-size: 13px;
		font-weight: 800;
	}

	.permission-note {
		margin-top: 14px;
		display: grid;
		gap: 4px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, transparent);
	}

	.permission-note strong {
		color: var(--color-ws-ink, #fbf7ff);
		font-size: 13px;
	}

	.permission-note span {
		color: var(--color-ws-text, #b8c1d6);
		font-size: 12px;
		line-height: 1.5;
	}

	.create-inline {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}

	/* Stack below 980px (the shared workspace breakpoint) so iPad-landscape
	   (1024px) keeps the two-column forms/grid instead of collapsing early. */
	@media (max-width: 980px) {
		.settings-hero,
		.invite-form,
		.invite-row {
			align-items: stretch;
			flex-direction: column;
		}

		.settings-grid,
		.role-help {
			grid-template-columns: 1fr;
		}

		.member-table {
			overflow-x: auto;
		}

		.member-row {
			min-width: 980px;
		}
	}

	/* iPad portrait (768px) + phones: the 5-column grid forced a 980px-wide row
	   inside an overflow-x:auto wrapper, so the whole table scrolled sideways.
	   Below 820px each member becomes a stacked card (name / email / role+date /
	   actions) — no horizontal scroll. The DOM keeps its table/row/cell roles, so
	   the select + remove/confirm buttons stay keyboard-operable and the in-flight
	   disabled/confirm behavior is untouched (this is layout-only). */
	@media (max-width: 820px) {
		.member-table {
			overflow-x: visible;
			border: 0;
			background: transparent;
			gap: 12px;
		}

		.member-head {
			display: none;
		}

		.member-row {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
			min-width: 0;
			min-height: 0;
			border: 1px solid var(--ws-hair);
			border-radius: 12px;
			padding: 14px;
		}

		.member-person {
			font-size: 15px;
		}

		.member-email {
			font-size: 12px;
			color: var(--color-ws-text, #b8c1d6);
		}

		.member-actions {
			flex-wrap: wrap;
			padding-top: 4px;
			border-top: 1px solid var(--ws-hair);
		}

		.member-actions select {
			width: 100%;
			max-width: 240px;
		}

		.remove-confirm {
			width: 100%;
		}
	}
</style>
