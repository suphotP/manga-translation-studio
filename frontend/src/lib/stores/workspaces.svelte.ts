import * as api from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type {
	WorkspaceApiRole,
	WorkspaceInviteRecord,
	WorkspaceMemberRecord,
	WorkspaceRecord,
	WorkspaceScope,
} from "$lib/api/client.ts";

export type WorkspaceRole =
	| "owner"
	| "admin"
	| "team_lead"
	| "translator"
	| "cleaner"
	| "typesetter"
	| "qc"
	| "guest";

export interface WorkspaceMember extends WorkspaceMemberRecord {
	displayRole: WorkspaceRole;
}

export interface WorkspaceInvite extends WorkspaceInviteRecord {
	displayRole: Exclude<WorkspaceRole, "owner">;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

const CURRENT_WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";

const ROLE_TASK_TYPE: Partial<Record<WorkspaceRole, string>> = {
	translator: "translate",
	cleaner: "clean",
	typesetter: "typeset",
	qc: "review",
};

export const WORKSPACE_ROLE_OPTIONS: Array<{ value: Exclude<WorkspaceRole, "owner">; label: string; detail: string }> = [
	{ value: "admin", label: "Admin", detail: "จัดการ workspace, คน, invite และงานทั้งหมด" },
	{ value: "team_lead", label: "Team Lead", detail: "นำทีมและจัดคิวงานใน workspace" },
	{ value: "translator", label: "Translator", detail: "รับงานแปลและตรวจข้อความ" },
	{ value: "cleaner", label: "Cleaner", detail: "รับงานคลีนและเตรียมหน้า" },
	{ value: "typesetter", label: "Typesetter", detail: "รับงานไทป์เซ็ตและเอฟเฟกต์" },
	{ value: "qc", label: "QC", detail: "ตรวจคุณภาพและ review handoff" },
	{ value: "guest", label: "Guest", detail: "ดูงานและ Export ตามสิทธิ์" },
];

export const WORKSPACE_ROLE_LABEL: Record<WorkspaceRole, string> = {
	owner: "Owner",
	admin: "Admin",
	team_lead: "Team Lead",
	translator: "Translator",
	cleaner: "Cleaner",
	typesetter: "Typesetter",
	qc: "QC",
	guest: "Guest",
};

function storage(): Storage | null {
	return typeof window === "undefined" ? null : window.localStorage;
}

function readStoredWorkspaceId(): string | null {
	return storage()?.getItem(CURRENT_WORKSPACE_STORAGE_KEY) || null;
}

function writeStoredWorkspaceId(workspaceId: string | null): void {
	const store = storage();
	if (!store) return;
	if (workspaceId) store.setItem(CURRENT_WORKSPACE_STORAGE_KEY, workspaceId);
	else store.removeItem(CURRENT_WORKSPACE_STORAGE_KEY);
}

function workspaceCreatedAtValue(workspace: WorkspaceRecord): number {
	const value = Date.parse(workspace.createdAt);
	return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function selectFallbackWorkspace(workspaces: WorkspaceRecord[]): WorkspaceRecord | null {
	const oldestOwned = workspaces.reduce<WorkspaceRecord | null>((selected, workspace) => {
		if (workspace.memberRole !== "owner") return selected;
		if (!selected) return workspace;
		return workspaceCreatedAtValue(workspace) < workspaceCreatedAtValue(selected) ? workspace : selected;
	}, null);
	// A stale stored id must not drop a user into the most recently active shared
	// workspace; the oldest owned workspace is the closest thing to their personal home.
	return oldestOwned ?? workspaces[0] ?? null;
}

// Team Lead is a frontend-only distinction layered on top of the backend `admin`
// role: the backend has no `team_lead` role and grants every admin full member/invite
// privileges. To keep a Team Lead from being silently rendered (and re-saved) as a
// full Admin, we tag them with a scope marker that (a) round-trips through the backend
// `normalizeScope` allow-list and (b) does NOT restrict resource access. `aiCreditPolicy`
// is the only scope key that is preserved while leaving `workspaceScopeAllows` (which
// only inspects the list fields) fully permissive, so workspace-wide admin reach is kept.
const TEAM_LEAD_SCOPE: WorkspaceScope = { aiCreditPolicy: "workspace" };

function isTeamLeadScope(scope: WorkspaceScope | undefined): boolean {
	return scope?.aiCreditPolicy === "workspace";
}

function normalizeScope(role: WorkspaceRole): WorkspaceScope | undefined {
	// Admin/owner are unrestricted, so they must carry NO scope. We send an explicit
	// empty `{}` (not `undefined`) on purpose: the PATCH endpoint COALESCEs an omitted
	// scope back to the row's current scope, so promoting a Team Lead or a scoped
	// editor to Admin with `undefined` would silently keep their old marker/task scope
	// attached. An explicit `{}` overwrites it and actually clears the restriction.
	if (role === "owner" || role === "admin") return {};
	if (role === "team_lead") return { ...TEAM_LEAD_SCOPE };
	if (role === "guest") return { aiCreditPolicy: "none" };
	const taskType = ROLE_TASK_TYPE[role];
	return taskType ? { taskTypes: [taskType], aiCreditPolicy: "job_scoped" } : undefined;
}

function apiRoleFor(role: WorkspaceRole): Exclude<WorkspaceApiRole, "owner"> {
	if (role === "admin" || role === "team_lead") return "admin";
	if (role === "guest") return "viewer";
	return "editor";
}

function inferDisplayRole(role: WorkspaceApiRole, scope: WorkspaceScope | undefined): WorkspaceRole {
	if (role === "owner") return "owner";
	if (role === "viewer") return "guest";
	if (role === "admin") return isTeamLeadScope(scope) ? "team_lead" : "admin";
	const taskTypes = new Set(scope?.taskTypes ?? []);
	if (taskTypes.has("translate")) return "translator";
	if (taskTypes.has("clean")) return "cleaner";
	if (taskTypes.has("typeset")) return "typesetter";
	if (taskTypes.has("review") || taskTypes.has("qc")) return "qc";
	return "translator";
}

/**
 * Display label for an api role + scope pair. Reuses the same scope-to-display-role
 * inference as members/invites so a cleaner/typesetter/QC editor membership is labeled
 * by its scope (Cleaner/Typesetter/QC) and a Team Lead admin is labeled Team Lead —
 * rather than every editor flattening to "Translator".
 */
export function workspaceRoleLabelFor(role: WorkspaceApiRole | undefined, scope: WorkspaceScope | undefined): string {
	if (!role) return WORKSPACE_ROLE_LABEL.guest;
	return WORKSPACE_ROLE_LABEL[inferDisplayRole(role, scope)];
}

function normalizeMember(member: WorkspaceMemberRecord): WorkspaceMember {
	return {
		...member,
		displayRole: inferDisplayRole(member.role, member.scope),
	};
}

function normalizeInvite(invite: WorkspaceInviteRecord): WorkspaceInvite {
	const displayRole = inferDisplayRole(invite.role, invite.scope) as Exclude<WorkspaceRole, "owner">;
	return {
		...invite,
		displayRole,
	};
}

class WorkspacesStore {
	workspaces = $state<WorkspaceRecord[]>([]);
	// Monotonic counter bumped on every successful workspace-list fetch. Consumers
	// (e.g. the realtime stream) watch it as a DISCRETE "membership/list reloaded"
	// signal to recover from a terminal state without polling.
	loadEpoch = $state(0);
	currentWorkspaceId = $state<string | null>(readStoredWorkspaceId());
	members = $state<WorkspaceMember[]>([]);
	invites = $state<WorkspaceInvite[]>([]);
	status = $state<LoadStatus>("idle");
	membersStatus = $state<LoadStatus>("idle");
	invitesStatus = $state<LoadStatus>("idle");
	error = $state<string | null>(null);
	// Raw one-time invite token from the most recent createInvite. The backend stores
	// only a hash and returns the plaintext token exactly once, so we hold it here for
	// the admin to copy/deliver until they send the next invite or dismiss it.
	lastInvite = $state<{ inviteId: string; email: string; token: string; emailSent: boolean } | null>(null);

	private loadPromise: Promise<void> | null = null;
	private lastLoadedUserId: string | null = null;

	currentWorkspace = $derived.by(() => {
		const selected = this.currentWorkspaceId
			? this.workspaces.find((workspace) => workspace.workspaceId === this.currentWorkspaceId)
			: null;
		return selected ?? selectFallbackWorkspace(this.workspaces);
	});

	isAdmin = $derived.by(() => {
		const role = this.currentWorkspace?.memberRole;
		return role === "owner" || role === "admin";
	});

	isMember = $derived.by(() => Boolean(this.currentWorkspace?.workspaceId));

	currentMember = $derived.by(() => {
		const userId = authStore.user?.id;
		if (!userId) return null;
		return this.members.find((member) => member.userId === userId) ?? null;
	});

	async load(): Promise<void> {
		if (this.loadPromise) return this.loadPromise;
		// Snapshot the identity the request is authorized as AT ISSUE TIME. Recording the
		// id only after the response resolves would mislabel a response that was fetched
		// with the previous account's token if the user switched mid-flight.
		const issuedForUserId = authStore.user?.id ?? null;
		this.loadPromise = this.loadInternal(issuedForUserId).finally(() => {
			this.loadPromise = null;
		});
		return this.loadPromise;
	}

	/**
	 * Force a fresh /workspaces fetch for the current identity, bypassing the
	 * `syncWithAuth` identity dedup. Needed after an action that changes membership for
	 * the SAME already-loaded account — e.g. accepting an invite from an existing session:
	 * `syncWithAuth` would short-circuit (id unchanged) and never pick up the newly joined
	 * workspace. Waits out any in-flight load first so this can't race a settling fetch.
	 */
	async refresh(): Promise<void> {
		if (!authStore.user?.id) return;
		if (this.loadPromise) await this.loadPromise.catch(() => undefined);
		await this.load();
	}

	/**
	 * Reload workspaces when the signed-in identity changes (e.g. an anonymous shell
	 * that signs in after mount). `load()` is one-shot via `loadPromise`, so a plain
	 * re-call would no-op once the first (anonymous, failed) load settled. This forces
	 * a fresh fetch whenever the user id differs from what we last loaded for.
	 */
	async syncWithAuth(userId: string | null): Promise<void> {
		if (!userId) {
			// Signed out: drop ALL authenticated state so the previous user's workspace
			// names, member list and any one-time invite link can't linger in the anonymous
			// shell. This runs BEFORE the identity dedup guard — sign-out must always clear
			// even when lastLoadedUserId was never recorded. Wait out any in-flight load so a
			// late resolution can't repopulate the store after we've cleared it.
			if (this.loadPromise) await this.loadPromise.catch(() => undefined);
			this.resetAuthenticatedState();
			return;
		}
		if (userId === this.lastLoadedUserId && this.status !== "idle") return;
		if (this.loadPromise) {
			await this.loadPromise.catch(() => undefined);
			if (userId === this.lastLoadedUserId && this.status !== "idle") return;
		}
		await this.load();
	}

	/** Reset everything a signed-in session populated, leaving the store idle/anonymous. */
	private resetAuthenticatedState(): void {
		this.workspaces = [];
		this.currentWorkspaceId = null;
		this.members = [];
		this.invites = [];
		this.lastInvite = null;
		this.status = "idle";
		this.membersStatus = "idle";
		this.invitesStatus = "idle";
		this.error = null;
		this.lastLoadedUserId = null;
		writeStoredWorkspaceId(null);
	}

	async create(name: string, plan = "free"): Promise<WorkspaceRecord> {
		this.error = null;
		const { workspace } = await api.createWorkspace({ name, plan });
		// The create endpoint returns a bare WorkspaceRecord with no membership fields, but
		// the caller is always the owner of the workspace they just created. Merge in the
		// known owner role/scope so `currentWorkspace.memberRole` (and therefore `isAdmin`,
		// the member/invite management UI) is correct immediately, instead of staying false
		// until a later full /workspaces reload backfills the membership.
		const owned: WorkspaceRecord = { ...workspace, memberRole: "owner", memberScope: {} };
		this.workspaces = [owned, ...this.workspaces.filter((item) => item.workspaceId !== owned.workspaceId)];
		await this.switchTo(owned.workspaceId);
		return owned;
	}

	async switchTo(workspaceId: string): Promise<void> {
		this.currentWorkspaceId = workspaceId;
		writeStoredWorkspaceId(workspaceId);
		this.members = [];
		this.invites = [];
		this.lastInvite = null;
		await Promise.all([
			this.listMembers(workspaceId, { silent: true }).catch(() => undefined),
			this.listInvites(workspaceId, { silent: true }).catch(() => undefined),
		]);
	}

	async patchSettings(patch: { name?: string }): Promise<WorkspaceRecord> {
		const workspaceId = this.requireWorkspaceId();
		const { workspace } = await api.patchWorkspace(workspaceId, patch);
		this.workspaces = this.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? { ...item, ...workspace } : item);
		return workspace;
	}

	async listMembers(workspaceId = this.requireWorkspaceId(), options: { silent?: boolean } = {}): Promise<WorkspaceMember[]> {
		this.membersStatus = "loading";
		try {
			this.members = (await api.getAllWorkspaceMembers(workspaceId)).map(normalizeMember);
			this.membersStatus = "ready";
			return this.members;
		} catch (error) {
			this.membersStatus = "error";
			// During an automatic workspace load, editors/viewers expectedly hit a 403 on
			// the admin-only /members endpoint. Surfacing that as a workspace error makes
			// the read-only settings UI look broken even though membership is fine, so the
			// auto-load path swallows it silently and only the explicit (admin) refresh reports.
			if (!options.silent) {
				this.error = error instanceof Error ? error.message : "โหลดสมาชิกไม่สำเร็จ";
			}
			throw error;
		}
	}

	async inviteMember(
		workspaceId: string,
		email: string,
		role: Exclude<WorkspaceRole, "owner">,
		projectIds?: string[],
	): Promise<WorkspaceInvite> {
		// Couple the RESOURCE scope (the story's chapter projects) WITH the role's task
		// scope so an invited helper is limited to BOTH the selected story AND their lane
		// (e.g. a "translator for just this story"). Whole-workspace = the role scope only.
		const baseScope = normalizeScope(role);
		const scope = projectIds && projectIds.length > 0
			? { ...(baseScope ?? {}), projectIds }
			: baseScope;
		const { invite, inviteEmailSendFailed } = await api.addWorkspaceMember(workspaceId, {
			email,
			role: apiRoleFor(role),
			scope,
		});
		const normalized = normalizeInvite(invite);
		this.invites = [normalized, ...this.invites.filter((item) => item.inviteId !== invite.inviteId)];
		// The plaintext token is returned exactly once — hold it for copy/delivery.
		// `emailSent` tells the panel whether the server already delivered the link
		// (the manual-copy flow is the FALLBACK, not the default — review #589 P2).
		this.lastInvite = invite.inviteToken
			? {
				inviteId: invite.inviteId,
				email: invite.email,
				token: invite.inviteToken,
				emailSent: inviteEmailSendFailed !== true,
			}
			: null;
		return normalized;
	}

	dismissLastInvite(): void {
		this.lastInvite = null;
	}

	async removeMember(workspaceId: string, userId: string): Promise<void> {
		await api.removeWorkspaceMember(workspaceId, userId);
		this.members = this.members.filter((member) => member.userId !== userId);
	}

	async updateMemberRole(workspaceId: string, userId: string, role: Exclude<WorkspaceRole, "owner">): Promise<WorkspaceMember> {
		const { member } = await api.updateWorkspaceMemberRole(workspaceId, userId, {
			role: apiRoleFor(role),
			scope: normalizeScope(role),
		});
		const normalized = normalizeMember(member);
		this.members = this.members.map((item) => item.userId === userId ? normalized : item);
		return normalized;
	}

	/** "Finish job": demote to a free viewer seat, keeping scope + a restore pointer. */
	async finishMember(workspaceId: string, userId: string): Promise<WorkspaceMember> {
		const { member } = await api.finishWorkspaceMember(workspaceId, userId);
		const normalized = normalizeMember(member);
		this.members = this.members.map((item) => item.userId === userId ? normalized : item);
		return normalized;
	}

	/** "Reopen": restore the role stashed by finish (may 402 if no seat is free). */
	async reopenMember(workspaceId: string, userId: string): Promise<WorkspaceMember> {
		const { member } = await api.reopenWorkspaceMember(workspaceId, userId);
		const normalized = normalizeMember(member);
		this.members = this.members.map((item) => item.userId === userId ? normalized : item);
		return normalized;
	}

	async listInvites(workspaceId = this.requireWorkspaceId(), options: { silent?: boolean } = {}): Promise<WorkspaceInvite[]> {
		this.invitesStatus = "loading";
		try {
			this.invites = (await api.getAllWorkspaceInvites(workspaceId))
				.filter((invite) => invite.status === "pending")
				.map(normalizeInvite);
			this.invitesStatus = "ready";
			return this.invites;
		} catch (error) {
			this.invitesStatus = "error";
			// /invites is gated by invite_members; non-admin members get an expected 403 on
			// auto-load. Same rationale as listMembers — only the explicit refresh reports.
			if (!options.silent) {
				this.error = error instanceof Error ? error.message : "โหลด invite ไม่สำเร็จ";
			}
			throw error;
		}
	}

	async cancelInvite(inviteId: string): Promise<void> {
		const workspaceId = this.requireWorkspaceId();
		const { invite } = await api.cancelInvite(workspaceId, inviteId);
		if (invite.status === "pending") {
			const normalized = normalizeInvite(invite);
			this.invites = this.invites.map((item) => item.inviteId === inviteId ? normalized : item);
		} else {
			this.invites = this.invites.filter((item) => item.inviteId !== inviteId);
			// Drop the one-time link if it belongs to the invite we just revoked — keeping it
			// copyable would hand out a token for an invite that can no longer be accepted.
			if (this.lastInvite?.inviteId === inviteId) this.lastInvite = null;
		}
	}

	__resetForTesting(): void {
		this.workspaces = [];
		this.currentWorkspaceId = null;
		this.members = [];
		this.invites = [];
		this.status = "idle";
		this.membersStatus = "idle";
		this.invitesStatus = "idle";
		this.error = null;
		this.lastInvite = null;
		this.loadPromise = null;
		this.lastLoadedUserId = null;
		writeStoredWorkspaceId(null);
	}

	private async loadInternal(issuedForUserId: string | null): Promise<void> {
		this.status = "loading";
		this.error = null;
		try {
			// Belt-and-braces against the synthetic-id leak (the backend filters
			// these now too): `personal:<uid>` / `project:<pid>` are catalog
			// bookkeeping rows, never selectable workspaces — adopting one as the
			// CURRENT workspace 400s every usage/perf call and corrupts context.
			this.workspaces = (await api.getAllWorkspaces())
				.filter((workspace) => !/^(?:personal|project):/.test(workspace.workspaceId));
			this.loadEpoch += 1;
			// Record the identity the request was AUTHORIZED AS (snapshotted at issue time),
			// not whoever is signed in now. If the account changed mid-flight, this still
			// reflects the old user, so syncWithAuth() sees the new id as not-yet-loaded and
			// forces a fresh fetch instead of leaving the old account's list under the new one.
			this.lastLoadedUserId = issuedForUserId;
			const stored = readStoredWorkspaceId();
			const nextWorkspace = this.workspaces.find((workspace) => workspace.workspaceId === stored)
				?? selectFallbackWorkspace(this.workspaces);
			const nextId = nextWorkspace?.workspaceId ?? null;
			this.currentWorkspaceId = nextId;
			writeStoredWorkspaceId(nextId);
			this.status = "ready";
			if (nextId) {
				// Member/invite endpoints are admin-gated; auto-load swallows the expected
				// 403 for editors/viewers without flagging a workspace error (silent: true).
				await Promise.all([
					this.listMembers(nextId, { silent: true }).catch(() => undefined),
					this.listInvites(nextId, { silent: true }).catch(() => undefined),
				]);
			}
		} catch (error) {
			this.status = "error";
			this.lastLoadedUserId = null;
			this.error = error instanceof Error ? error.message : "โหลด workspace ไม่สำเร็จ";
			throw error;
		}
	}

	private requireWorkspaceId(): string {
		const workspaceId = this.currentWorkspace?.workspaceId;
		if (!workspaceId) throw new Error("ยังไม่มีเวิร์กสเปซ ที่เลือก");
		return workspaceId;
	}
}

export const workspacesStore = new WorkspacesStore();
