import { getSharedBunSql } from "./sql-pool.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DATA_DIR, defaultDatabaseStoreMode } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { normalizeWorkspacePlanId } from "./plans.js";
import { pushArrayLiteral } from "./pg-array.js";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceStudioRole = "owner" | "admin" | "team_lead" | "translator" | "cleaner" | "typesetter" | "qc" | "guest";
export type WorkspacePermission =
	| "read_workspace"
	| "update_workspace"
	| "manage_members"
	| "invite_members"
	| "manage_projects"
	| "read_project"
	| "update_project"
	| "generate_ai"
	| "export_project";

export interface WorkspaceScope {
	projectIds?: string[];
	chapterIds?: string[];
	pageIndexes?: number[];
	languages?: string[];
	taskTypes?: string[];
	assetPurposes?: string[];
	aiCreditPolicy?: "workspace" | "job_scoped" | "none";
}

export interface WorkspaceScopeCheck {
	projectId?: string;
	chapterId?: string;
	pageIndex?: number;
	language?: string;
	taskType?: string;
	assetPurpose?: string;
	resourceKind?: "page" | "task" | "comment" | "review" | "message" | "asset" | "ai";
	/**
	 * Require TRULY project-wide (unscoped) access: the member must carry NO
	 * fine-grained `scope` restriction at all — not just one whose lists happen to
	 * cover the requested resource. Used to authorize whole-project mutations (full
	 * `ProjectState` save / full version restore) that touch shared, non-language
	 * project state in addition to every language track. A member with ANY
	 * `scope.languages` (or projectIds/chapterIds/pageIndexes/taskTypes/assetPurposes)
	 * restriction fails this check even if their languages currently cover every
	 * track. An unscoped owner/editor passes unchanged.
	 */
	requireProjectWide?: boolean;
}

export interface WorkspaceRecord {
	workspaceId: string;
	name: string;
	planId: string;
	storageIncludedBytes: number;
	storageExtraBytes: number;
	createdAt: string;
	updatedAt: string;
	/**
	 * When non-null, the workspace is FROZEN (a verified refund/chargeback, or an
	 * owner/admin back-office suspension): the instant the freeze took effect. While
	 * set, ALL mutating operations on the workspace + its projects are blocked for
	 * EVERYONE (owner + every member); read/view stays allowed. Cleared on a
	 * subsequent successful payment or an owner/admin unfreeze.
	 */
	suspendedAt?: string;
	/** Why the workspace is frozen: 'payment_refund' | 'chargeback' | 'admin'. */
	suspendedReason?: string;
}

// The workspace permissions that MUTATE state. While a workspace is FROZEN
// (suspended_at set by a verified refund/chargeback or an admin suspension), every
// one of these is blocked for EVERYONE (owner + every member) with a 403
// `workspace_suspended`; the read-only permissions (read_workspace / read_project /
// export_project — export is a read-side download for the roles that hold it) stay
// allowed so members can
// still see their work + the restore notice.
const MUTATING_PERMISSIONS: ReadonlySet<WorkspacePermission> = new Set<WorkspacePermission>([
	"update_workspace",
	"manage_members",
	"invite_members",
	"manage_projects",
	"update_project",
	"generate_ai",
]);

export function isMutatingPermission(permission: WorkspacePermission): boolean {
	return MUTATING_PERMISSIONS.has(permission);
}

export interface WorkspaceListOptions {
	limit?: number;
	cursor?: string;
	role?: WorkspaceRole;
}

export interface UserWorkspacePage {
	workspaces: Array<WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope }>;
	nextCursor?: string;
}

/**
 * Filter + keyset-pagination options for {@link WorkspaceAccessStore.listAllWorkspacePage}
 * — the platform-admin browser of EVERY workspace in the registry (not scoped to a
 * member). `search` matches name/workspaceId (case-insensitive substring); `cursor`
 * is an opaque keyset token over (updated_at DESC, workspace_id ASC).
 */
export interface AllWorkspacesListOptions {
	search?: string;
	limit?: number;
	cursor?: string;
}

export interface AllWorkspacesPage {
	workspaces: WorkspaceRecord[];
	nextCursor?: string;
	/**
	 * Total number of workspaces matching the same `search` filter, ignoring the
	 * cursor/limit window. Lets the admin header show an honest count rather than
	 * the page length.
	 */
	total: number;
}

/**
 * Stash captured when a member is "finished" (demoted to a free viewer seat),
 * so "Reopen" can restore their exact prior access. Absent ⇒ the member is in
 * normal standing.
 */
export interface WorkspaceMemberFinishedFrom {
	role: WorkspaceRole;
	memberStudioRole?: WorkspaceStudioRole;
	finishedAt: string;
}

export interface WorkspaceMemberRecord {
	workspaceId: string;
	userId: string;
	role: WorkspaceRole;
	memberStudioRole?: WorkspaceStudioRole;
	scope: WorkspaceScope;
	invitedByUserId?: string;
	createdAt: string;
	updatedAt: string;
	disabledAt?: string;
	/** Set while the member is "finished" (viewer seat with a restore pointer). */
	finishedFrom?: WorkspaceMemberFinishedFrom;
}

export interface WorkspaceMemberListOptions {
	limit?: number;
	cursor?: string;
	role?: WorkspaceRole;
	scopeCoveredBy?: WorkspaceScope;
}

export interface WorkspaceMemberPage {
	members: WorkspaceMemberRecord[];
	nextCursor?: string;
}

/**
 * Series-level duty: this member holds this role on EVERY chapter of the story
 * (including chapters created later), resolved at read time. The role
 * vocabulary is the chapter-team duty set minus `guest` — "no series duty" is
 * simply the row's absence. A chapter-level role (the ProjectState
 * `chapterTeam` slice) overrides the series duty on conflict.
 */
export type StoryAssignmentRole = "translator" | "cleaner" | "typesetter" | "qc";

export const STORY_ASSIGNMENT_ROLES: readonly StoryAssignmentRole[] = ["translator", "cleaner", "typesetter", "qc"];

export interface StoryRoleAssignmentRecord {
	workspaceId: string;
	storyId: string;
	userId: string;
	role: StoryAssignmentRole;
	assignedBy?: string;
	createdAt: string;
	updatedAt: string;
}

export interface StoryAssignmentListFilter {
	storyId?: string;
	userId?: string;
}

// Hard ceiling on a single list read so a workspace with pathological
// assignment counts can never produce an unbounded payload.
export const MAX_STORY_ASSIGNMENT_LIST = 2000;

export interface WorkspaceInviteRecord {
	inviteId: string;
	workspaceId: string;
	email: string;
	role: WorkspaceRole;
	scope: WorkspaceScope;
	status: "pending" | "accepted" | "revoked" | "expired";
	invitedByUserId: string;
	acceptedByUserId?: string;
	expiresAt: string;
	acceptedAt?: string;
	revokedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceInviteListOptions {
	limit?: number;
	cursor?: string;
	scopeCoveredBy?: WorkspaceScope;
}

export interface WorkspaceInvitePage {
	invites: WorkspaceInviteRecord[];
	nextCursor?: string;
}

export interface WorkspaceAuditEventRecord {
	auditEventId: string;
	workspaceId?: string;
	projectId?: string;
	actorUserId?: string;
	action: string;
	entityType: string;
	entityId: string;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface WorkspaceAuditEventListOptions {
	limit?: number;
	cursor?: string;
	action?: string;
	entityType?: string;
	actorUserId?: string;
	/** Inclusive lower bound on created_at (ISO-8601 timestamp). */
	createdAfter?: string;
	/** Inclusive upper bound on created_at (ISO-8601 timestamp). */
	createdBefore?: string;
}

export interface WorkspaceAuditEventPage {
	events: WorkspaceAuditEventRecord[];
	nextCursor?: string;
}

export interface CreatedWorkspaceInvite extends WorkspaceInviteRecord {
	inviteToken: string;
}

export interface WorkspaceAccessSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: WorkspaceAccessSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

/**
 * One active workspace member, paired with the two human-facing identifiers a
 * `@handle` could reference (name / email). Structurally compatible with the
 * mention resolver's `MentionCandidate` (services/comments.ts) so the route can
 * feed this straight into `resolveCommentMentions` with no remapping. Kept as a
 * local structural type (not an import of `MentionCandidate`) so this store stays
 * decoupled from the comments domain.
 */
export interface WorkspaceMentionCandidate {
	userId: string;
	name?: string | null;
	email?: string | null;
}

/**
 * Narrow read-only view of the auth-user store that {@link WorkspaceAccessStore.listMentionCandidates}
 * needs. Deliberately minimal — only `load` (+ an optional `kind` discriminator)
 * is required — so we don't pull the whole `AuthUserStore` type / module into
 * this file.
 *
 * `kind` reports WHERE the user rows physically live. The Postgres workspace
 * store may only take its `auth_users` JOIN fast path when `kind === "postgres"`
 * (the all-Postgres prod config). In the supported MIXED config (DATABASE_URL set
 * but AUTH_USER_STORE=file — the docker-compose default) the workspace store is
 * Postgres while users live ONLY in the file store, so the JOIN would find zero
 * `auth_users` rows and silently drop every mention candidate. When `kind` is not
 * `"postgres"` (file-backed, or simply unknown) the store falls back to the
 * roster + per-member `load`, which reads from wherever the auth rows actually
 * are. Optional so existing/test callers that only supply `load` still satisfy
 * the type (treated as "not postgres-backed" → the safe per-member fallback).
 */
export interface MentionCandidateAuthLoader {
	readonly kind?: "file" | "postgres";
	load(userId: string): Promise<{ name?: string | null; email?: string | null } | null>;
}

export interface PersonalWorkspaceOwnerProfile {
	name?: string | null;
	locale?: string | null;
}

export interface PersonalWorkspaceProfileLoader {
	load(userId: string): Promise<PersonalWorkspaceOwnerProfile | null>;
}

export interface WorkspaceAccessStore {
	createWorkspace(input: { workspaceId: string; name: string; ownerUserId: string; planId?: string }): Promise<WorkspaceRecord>;
	getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
	updateWorkspace(input: { workspaceId: string; name: string; actorUserId: string }): Promise<WorkspaceRecord>;
	/**
	 * FREEZE / UNFREEZE a workspace. `suspend:true` sets suspended_at (idempotent —
	 * keeps the original instant/reason when already frozen); `suspend:false` clears
	 * it. Used by the dodo webhook (refund/chargeback freeze + successful-payment
	 * unfreeze) and the owner/admin back-office unfreeze — there is ALWAYS a way out.
	 */
	setWorkspaceSuspension(input: { workspaceId: string; suspend: boolean; reason?: string; actorUserId?: string }): Promise<WorkspaceRecord>;
	/**
	 * Cheap freeze-flag read: true when the workspace is currently FROZEN (verified
	 * refund/chargeback or admin suspension). Backs the central catalog freeze gate
	 * and the chapter-team fallback so EVERY mutating authorization path consults the
	 * same suspension truth. A missing workspace reads as not-suspended (false).
	 */
	isWorkspaceSuspended(workspaceId: string): Promise<boolean>;
	listUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope }>>;
	listUserWorkspacePage(userId: string, options?: WorkspaceListOptions): Promise<UserWorkspacePage>;
	/** Lazily provision the user's personal "My Workspace" if they own none. A WRITE:
	 *  call ONLY from the signed-in user's own onboarding/list path, never from
	 *  admin/support reads that look up an arbitrary user. */
	ensurePersonalWorkspace(userId: string): Promise<void>;
	/**
	 * Platform-admin browser of EVERY workspace in the registry, keyset-paginated on
	 * (updated_at DESC, workspace_id ASC) and filtered by an optional name/id search.
	 * Backs the admin "Workspaces" list so it reflects real workspaces in BOTH
	 * file-mode and Postgres — independent of whether a billing assignment exists.
	 * The admin route enriches each returned row with billing plan/status as a
	 * secondary lookup (a missing assignment never hides a real workspace).
	 */
	listAllWorkspacePage(options?: AllWorkspacesListOptions): Promise<AllWorkspacesPage>;
	getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null>;
	/**
	 * TRUE when the user HAD a membership in this workspace that is now disabled
	 * (removed by an admin / soft-disabled). Chapter-team fallback grants must
	 * treat that as REVOKED: removal from the workspace revokes every access
	 * path, while a never-member external chapter collaborator (no row at all)
	 * keeps their per-chapter grant. (Re-inviting re-enables the same row, which
	 * clears disabled_at — so a disabled row always means "currently removed".)
	 */
	isMembershipRevoked(workspaceId: string, userId: string): Promise<boolean>;
	requirePermission(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<WorkspaceMemberRecord>;
	requireScopedPermission(workspaceId: string, userId: string, permission: WorkspacePermission, scopeCheck: WorkspaceScopeCheck): Promise<WorkspaceMemberRecord>;
	listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
	/**
	 * Active-member roster purpose-built for @mention resolution: each active
	 * member paired with the name/email a `@handle` could match. Collapses the
	 * former 2N-query N+1 (listMembers → authUserStore.load per member, each load
	 * = 2 SELECTs incl. an unused external-identity read) into ONE round-trip in
	 * the all-Postgres config (a JOIN to auth_users) — used ONLY when the active
	 * auth store is itself Postgres-backed (`authLoader.kind === "postgres"`).
	 * Otherwise (file-mode store, OR the mixed config where the workspace store is
	 * Postgres but users live in the FILE auth store) it loops the active roster
	 * and resolves name/email via `authLoader.load`, which reads from wherever the
	 * auth rows actually are — so mentions keep resolving in every supported config.
	 * Applies the SAME active-member filter as {@link listMembers} (disabled
	 * members excluded). In the loader path a member whose auth row is missing is
	 * still returned with undefined name/email (best-effort — a missing profile
	 * never breaks mention resolution, mirroring the prior `.catch(() => null)`
	 * per-member semantics); the JOIN fast path drops such a member (harmless — a
	 * `@handle` could never resolve against an absent name/email anyway).
	 */
	listMentionCandidates(workspaceId: string, authLoader: MentionCandidateAuthLoader): Promise<WorkspaceMentionCandidate[]>;
	listMemberPage(workspaceId: string, options?: WorkspaceMemberListOptions): Promise<WorkspaceMemberPage>;
	/**
	 * Count active workspace admins (role IN ('owner','admin')). Backs the
	 * last-admin self-mutation guard so a role-change/removal no longer has to
	 * materialize the entire member roster just to run that check.
	 */
	countAdmins(workspaceId: string): Promise<number>;
	updateMember(input: { workspaceId: string; userId: string; role: WorkspaceRole; memberStudioRole?: WorkspaceStudioRole; scope?: WorkspaceScope; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<WorkspaceMemberRecord>;
	/** "Finish job": demote to a free viewer seat, keep scope, stash the prior role for restore. Idempotent. */
	finishMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord>;
	/** "Reopen": restore the prior role stashed by {@link finishMember} (re-consumes a seat). Idempotent. */
	reopenMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord>;
	removeMember(input: { workspaceId: string; userId: string; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<void>;
	/**
	 * Series-level duty assignments (see {@link StoryRoleAssignmentRecord}).
	 * `filter.userId` backs inbox duty resolution ("every series duty this user
	 * holds here"); `filter.storyId` backs the story-settings roster. Capped at
	 * {@link MAX_STORY_ASSIGNMENT_LIST} rows, newest first.
	 */
	listStoryAssignments(workspaceId: string, filter?: StoryAssignmentListFilter): Promise<StoryRoleAssignmentRecord[]>;
	/** Idempotent upsert keyed (workspaceId, storyId, userId, role) — a member may hold several duties on one story (multi-duty). */
	upsertStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord>;
	/** Bulk variant for assigning one member's duty across multiple stories/chapters in one operator action. */
	upsertStoryAssignments(input: { workspaceId: string; storyIds: string[]; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord[]>;
	/** Remove a member's series duty. With `role` set, removes only THAT duty; without it, removes EVERY duty the member holds on the story. Returns false when nothing matched (idempotent). */
	removeStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role?: StoryAssignmentRole; actorUserId: string }): Promise<boolean>;
	createInvite(input: { workspaceId: string; email: string; role: WorkspaceRole; scope?: WorkspaceScope; invitedByUserId: string; ttlSeconds?: number; replaceWithinScope?: WorkspaceScope }): Promise<CreatedWorkspaceInvite>;
	getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInviteRecord | null>;
	listInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]>;
	listInvitePage(workspaceId: string, options?: WorkspaceInviteListOptions): Promise<WorkspaceInvitePage>;
	listAuditEventPage(workspaceId: string, options?: WorkspaceAuditEventListOptions): Promise<WorkspaceAuditEventPage>;
	recordAuditEvent(input: { workspaceId: string; actorUserId: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }): Promise<void>;
	revokeInvite(input: { workspaceId: string; inviteId: string; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<WorkspaceInviteRecord>;
	acceptInvite(input: { inviteId: string; inviteToken: string; userId: string; email: string; now?: Date }): Promise<WorkspaceMemberRecord>;
	/**
	 * GDPR right-to-erasure: remove the subject's PII from the workspace-access
	 * tables — DELETE their `workspace_members` rows (no orphaned membership points
	 * at the erased user) and anonymize the clear-text `email` on any invite
	 * addressed to their original email. Idempotent. `originalEmail` is the address
	 * the auth row carried before it was tombstoned (the GDPR purge captures it).
	 */
	erasePiiForUser(userId: string, originalEmail?: string): Promise<{ membershipsRemoved: number; invitesAnonymized: number }>;
}

export class WorkspaceAccessError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "workspace_access_error") {
		super(message);
	}
}

export class PostgresWorkspaceAccessStore implements WorkspaceAccessStore {
	private readonly client: WorkspaceAccessSqlClient;

	constructor(
		databaseUrlOrClient: string | WorkspaceAccessSqlClient = process.env.DATABASE_URL ?? "",
		private readonly personalWorkspaceProfileLoader?: PersonalWorkspaceProfileLoader,
	) {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("Workspace access store requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as WorkspaceAccessSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async createWorkspace(input: { workspaceId: string; name: string; ownerUserId: string; planId?: string }): Promise<WorkspaceRecord> {
		const planId = normalizeWorkspacePlanId(input.planId) ?? "free";
		return this.transaction(async (client) => {
			const rows = await client.unsafe<WorkspaceRow>(`
				INSERT INTO workspaces (workspace_id, name, plan_id, created_at, updated_at)
				VALUES ($1, $2, $3, now(), now())
				ON CONFLICT (workspace_id) DO UPDATE SET
					name = EXCLUDED.name,
					updated_at = now()
				RETURNING workspace_id, name, plan_id, storage_included_bytes, storage_extra_bytes, created_at, updated_at
			`, [input.workspaceId, input.name, planId]);
			await client.unsafe(`
				INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, scope, created_at, updated_at, disabled_at)
				VALUES ($1, $2, 'owner', 'owner', '{}'::jsonb, now(), now(), NULL)
				ON CONFLICT (workspace_id, user_id) DO UPDATE SET
					role = 'owner',
					member_studio_role = 'owner',
					scope = '{}'::jsonb,
					disabled_at = NULL,
					updated_at = now()
			`, [input.workspaceId, input.ownerUserId]);
			return mapWorkspaceRow(requireRow(rows, "workspace"));
		});
	}

	async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
		const rows = await this.client.unsafe<WorkspaceRow>(`
			SELECT workspace_id, name, plan_id, storage_included_bytes, storage_extra_bytes, created_at, updated_at, suspended_at, suspended_reason
			FROM workspaces
			WHERE workspace_id = $1
			LIMIT 1
		`, [workspaceId]);
		return rows[0] ? mapWorkspaceRow(rows[0]) : null;
	}

	async setWorkspaceSuspension(input: { workspaceId: string; suspend: boolean; reason?: string; actorUserId?: string }): Promise<WorkspaceRecord> {
		const rows = input.suspend
			// Idempotent freeze: COALESCE keeps the ORIGINAL instant/reason if already frozen.
			? await this.client.unsafe<WorkspaceRow>(`
				UPDATE workspaces
				SET suspended_at = COALESCE(suspended_at, now()),
					suspended_reason = COALESCE(suspended_reason, $2),
					updated_at = now()
				WHERE workspace_id = $1
				RETURNING workspace_id, name, plan_id, storage_included_bytes, storage_extra_bytes, created_at, updated_at, suspended_at, suspended_reason
			`, [input.workspaceId, input.reason ?? "admin"])
			: await this.client.unsafe<WorkspaceRow>(`
				UPDATE workspaces
				SET suspended_at = NULL, suspended_reason = NULL, updated_at = now()
				WHERE workspace_id = $1
				RETURNING workspace_id, name, plan_id, storage_included_bytes, storage_extra_bytes, created_at, updated_at, suspended_at, suspended_reason
			`, [input.workspaceId]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		const workspace = mapWorkspaceRow(rows[0]);
		if (input.actorUserId) {
			await recordWorkspaceAudit(this.client, {
				workspaceId: input.workspaceId,
				actorUserId: input.actorUserId,
				action: input.suspend ? "workspace_suspended" : "workspace_unsuspended",
				entityType: "workspace",
				entityId: input.workspaceId,
				metadata: { reason: input.reason ?? (input.suspend ? "admin" : "cleared") },
			});
		}
		return workspace;
	}

	// Read ONLY the freeze flag for a workspace (cheap; backs the mutating-permission
	// gate in requirePermission, the central catalog gate, and the chapter-team
	// fallback — without materializing the full workspace row).
	async isWorkspaceSuspended(workspaceId: string): Promise<boolean> {
		const rows = await this.client.unsafe<{ suspended_at: Date | string | null }>(`
			SELECT suspended_at FROM workspaces WHERE workspace_id = $1 LIMIT 1
		`, [workspaceId]);
		return Boolean(rows[0]?.suspended_at);
	}

	async updateWorkspace(input: { workspaceId: string; name: string; actorUserId: string }): Promise<WorkspaceRecord> {
		const rows = await this.client.unsafe<WorkspaceRow>(`
			UPDATE workspaces
			SET name = $2,
				updated_at = now()
			WHERE workspace_id = $1
			RETURNING workspace_id, name, plan_id, storage_included_bytes, storage_extra_bytes, created_at, updated_at
		`, [input.workspaceId, input.name]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		const workspace = mapWorkspaceRow(rows[0]);
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_updated",
			entityType: "workspace",
			entityId: input.workspaceId,
			metadata: { name: workspace.name },
		});
		return workspace;
	}

	/**
	 * Lazily create the user's personal "My Workspace" if they own none, so a fresh
	 * sign-up lands on a real, usable workspace rather than the empty list the
	 * dashboard treats as "no workspace" (which renders a blank shell and blocks the
	 * create/upload flow). Serialized per-user with a transaction-scoped advisory
	 * lock so concurrent first-touch requests (e.g. the dashboard workspace-list
	 * load racing the realtime mint) cannot create duplicate personal workspaces.
	 *
	 * THIS IS A WRITE. It is intentionally NOT called from the list reads, which are
	 * also used by admin/support routes to look up an ARBITRARY user — provisioning
	 * there would silently create/recreate production workspaces for any account
	 * being viewed. Call it only from the signed-in user's own onboarding/list path.
	 */
	async ensurePersonalWorkspace(userId: string): Promise<void> {
		const normalized = userId.trim();
		if (!normalized) return;
		await this.transaction(async (client) => {
			await client.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`personal-workspace:${normalized}`]);
			const existing = await client.unsafe<{ one: number }>(`
				SELECT 1 AS one
				FROM workspace_members
				WHERE user_id = $1 AND role = 'owner' AND disabled_at IS NULL
					-- A synthetic catalog membership (personal:/project: bookkeeping)
					-- must NOT satisfy "owns a workspace": the list paths filter those
					-- ids out, so counting one here would leave the user with an EMPTY
					-- workspace list and no provisioning (codex P1 on the list filter).
					AND workspace_id NOT LIKE 'personal:%'
					AND workspace_id NOT LIKE 'project:%'
				LIMIT 1
			`, [normalized]);
			if (existing.length > 0) return;
			const ownerProfile = await this.loadPersonalWorkspaceOwnerProfile(client, normalized);
			const workspaceName = buildPersonalWorkspaceName(ownerProfile);
			const workspaceId = randomUUID();
			await client.unsafe(`
				INSERT INTO workspaces (workspace_id, name, plan_id, created_at, updated_at)
				VALUES ($1, $2, 'free', now(), now())
				ON CONFLICT (workspace_id) DO NOTHING
			`, [workspaceId, workspaceName]);
			await client.unsafe(`
				INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, scope, created_at, updated_at, disabled_at)
				VALUES ($1, $2, 'owner', 'owner', '{}'::jsonb, now(), now(), NULL)
				ON CONFLICT (workspace_id, user_id) DO NOTHING
			`, [workspaceId, normalized]);
		});
	}

	private async loadPersonalWorkspaceOwnerProfile(
		client: WorkspaceAccessSqlClient,
		userId: string,
	): Promise<PersonalWorkspaceOwnerProfile | null> {
		if (this.personalWorkspaceProfileLoader) {
			return this.personalWorkspaceProfileLoader.load(userId).catch(() => null);
		}
		return loadPersonalWorkspaceOwnerProfileFromAuthUsers(client, userId);
	}

	async listUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope }>> {
		const rows = await this.client.unsafe<UserWorkspaceRow>(`
			SELECT
				workspaces.workspace_id,
				workspaces.name,
				workspaces.plan_id,
				workspaces.storage_included_bytes,
				workspaces.storage_extra_bytes,
				workspaces.created_at,
				workspaces.updated_at,
				workspace_members.role AS member_role,
				workspace_members.member_studio_role AS member_studio_role,
				workspace_members.scope AS member_scope
			FROM workspace_members
			INNER JOIN workspaces ON workspaces.workspace_id = workspace_members.workspace_id
			WHERE workspace_members.user_id = $1
				AND workspace_members.disabled_at IS NULL
				-- SYNTHETIC catalog bookkeeping rows (personal:<uid> / project:<pid>,
				-- minted so an unscoped project's FK resolves) are NOT user
				-- workspaces. Leaking them here let the frontend adopt
				-- "personal:..." as the CURRENT workspace (it can sort first),
				-- which 400s every usage/perf poll and corrupts workspace context.
				AND workspaces.workspace_id NOT LIKE 'personal:%'
				AND workspaces.workspace_id NOT LIKE 'project:%'
			ORDER BY workspaces.updated_at DESC
		`, [userId]);
		return rows.map((row) => ({
			...mapWorkspaceRow(row),
			memberRole: normalizeRole(row.member_role),
			memberStudioRole: normalizeStudioRole(row.member_studio_role, normalizeRole(row.member_role)),
			memberScope: normalizeScope(row.member_scope),
		}));
	}

	async listUserWorkspacePage(userId: string, options: WorkspaceListOptions = {}): Promise<UserWorkspacePage> {
		const limit = normalizeWorkspacePageLimit(options.limit);
		const cursor = decodeWorkspaceCursor(options.cursor, "workspaceId");
		// Synthetic catalog rows excluded for the same reason as listUserWorkspaces.
		const conditions = [
			"workspace_members.user_id = $1",
			"workspace_members.disabled_at IS NULL",
			"workspaces.workspace_id NOT LIKE 'personal:%'",
			"workspaces.workspace_id NOT LIKE 'project:%'",
		];
		const params: unknown[] = [userId];
		if (options.role) {
			params.push(options.role);
			conditions.push(`workspace_members.role = $${params.length}`);
		}
		if (cursor) {
			params.push(cursor.updatedAt, cursor.id);
			conditions.push(`(workspaces.updated_at < $${params.length - 1}::timestamptz OR (workspaces.updated_at = $${params.length - 1}::timestamptz AND workspaces.workspace_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<UserWorkspaceRow>(`
			SELECT
				workspaces.workspace_id,
				workspaces.name,
				workspaces.plan_id,
				workspaces.storage_included_bytes,
				workspaces.storage_extra_bytes,
				workspaces.created_at,
				workspaces.updated_at,
				to_char(workspaces.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at,
				workspace_members.role AS member_role,
				workspace_members.member_studio_role AS member_studio_role,
				workspace_members.scope AS member_scope
			FROM workspace_members
			INNER JOIN workspaces ON workspaces.workspace_id = workspace_members.workspace_id
			WHERE ${conditions.join(" AND ")}
			ORDER BY workspaces.updated_at DESC, workspaces.workspace_id DESC
			LIMIT $${params.length}
		`, params);
		const pageRows = rows.slice(0, limit);
		const workspaces = pageRows.map((row) => ({
			...mapWorkspaceRow(row),
			memberRole: normalizeRole(row.member_role),
			memberStudioRole: normalizeStudioRole(row.member_studio_role, normalizeRole(row.member_role)),
			memberScope: normalizeScope(row.member_scope),
		}));
		const lastRow = pageRows[pageRows.length - 1];
		const last = workspaces[workspaces.length - 1];
		return {
			workspaces,
			nextCursor: rows.length > limit && last && lastRow ? encodeWorkspaceCursor("workspaceId", getCursorTimestamp(lastRow, "updated"), last.workspaceId) : undefined,
		};
	}

	async listAllWorkspacePage(options: AllWorkspacesListOptions = {}): Promise<AllWorkspacesPage> {
		const limit = normalizeWorkspacePageLimit(options.limit);
		const search = options.search?.trim().toLowerCase();
		const cursor = decodeWorkspaceCursor(options.cursor, "workspaceId");

		// Filter conditions shared between the COUNT(*) and the page query so they
		// stay in lockstep. Only `search` filters the registry; plan/status are a
		// billing attribute the admin route applies after enrichment.
		const filterConditions: string[] = [];
		const filterParams: unknown[] = [];
		if (search) {
			filterParams.push(`%${escapeWorkspaceLikePattern(search)}%`);
			filterConditions.push(`lower(name || ' ' || workspace_id) LIKE $${filterParams.length} ESCAPE '\\'`);
		}
		const filterWhere = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";

		// ONE bounded COUNT(*) over the filtered set — never per row.
		const countRows = await this.client.unsafe<{ total: string | number }>(`
			SELECT COUNT(*)::bigint AS total FROM workspaces ${filterWhere}
		`, filterParams);
		const total = Number(countRows[0]?.total ?? 0);

		const conditions = [...filterConditions];
		const params = [...filterParams];
		if (cursor) {
			params.push(cursor.updatedAt, cursor.id);
			conditions.push(`(updated_at < $${params.length - 1}::timestamptz OR (updated_at = $${params.length - 1}::timestamptz AND workspace_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = await this.client.unsafe<WorkspaceRow>(`
			SELECT
				workspace_id,
				name,
				plan_id,
				storage_included_bytes,
				storage_extra_bytes,
				created_at,
				updated_at,
				to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
			FROM workspaces
			${whereClause}
			ORDER BY updated_at DESC, workspace_id DESC
			LIMIT $${params.length}
		`, params);
		const pageRows = rows.slice(0, limit);
		const workspaces = pageRows.map(mapWorkspaceRow);
		const lastRow = pageRows[pageRows.length - 1];
		const last = workspaces[workspaces.length - 1];
		return {
			workspaces,
			nextCursor: rows.length > limit && last && lastRow ? encodeWorkspaceCursor("workspaceId", getCursorTimestamp(lastRow, "updated"), last.workspaceId) : undefined,
			total,
		};
	}

	async getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			SELECT workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
			FROM workspace_members
			WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL
			LIMIT 1
		`, [workspaceId, userId]);
		return rows[0] ? mapMemberRow(rows[0]) : null;
	}

	async isMembershipRevoked(workspaceId: string, userId: string): Promise<boolean> {
		const rows = await this.client.unsafe<{ disabled: boolean }>(`
			SELECT (disabled_at IS NOT NULL) AS disabled
			FROM workspace_members
			WHERE workspace_id = $1 AND user_id = $2
			LIMIT 1
		`, [workspaceId, userId]);
		return rows[0]?.disabled === true;
	}

	async requirePermission(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<WorkspaceMemberRecord> {
		const member = await this.getMember(workspaceId, userId);
		if (!member) {
			throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		}
		if (!roleHasPermission(member.role, permission)) {
			throw new WorkspaceAccessError(`Forbidden: missing workspace permission '${permission}'`, 403, "workspace_permission_denied");
		}
		// FREEZE gate: while the workspace is suspended (verified refund/chargeback, or
		// an admin suspension), EVERY mutating permission is blocked for EVERYONE (owner +
		// every member). Read permissions pass so members can still view their work + the
		// restore notice. Checked AFTER the role grant so a non-member still gets 404, and
		// only for mutating permissions so reads never pay the extra lookup.
		if (isMutatingPermission(permission) && await this.isWorkspaceSuspended(workspaceId)) {
			throw new WorkspaceAccessError("Workspace is suspended (payment refund/chargeback). Pay to restore access.", 403, "workspace_suspended");
		}
		return member;
	}

	async requireScopedPermission(workspaceId: string, userId: string, permission: WorkspacePermission, scopeCheck: WorkspaceScopeCheck): Promise<WorkspaceMemberRecord> {
		const member = await this.requirePermission(workspaceId, userId, permission);
		if (!workspaceScopeAllows(member.scope, scopeCheck)) {
			throw new WorkspaceAccessError("Forbidden: workspace scope does not allow this resource", 403, "workspace_scope_denied");
		}
		if (permission === "generate_ai" && member.scope.aiCreditPolicy === "none") {
			throw new WorkspaceAccessError("Forbidden: AI credits are disabled for this member", 403, "workspace_ai_scope_denied");
		}
		return member;
	}

	async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			SELECT workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
			FROM workspace_members
			WHERE workspace_id = $1 AND disabled_at IS NULL
			ORDER BY role ASC, updated_at DESC
		`, [workspaceId]);
		return rows.map(mapMemberRow);
	}

	async listMentionCandidates(workspaceId: string, authLoader: MentionCandidateAuthLoader): Promise<WorkspaceMentionCandidate[]> {
		// FAST PATH — all-Postgres config only. When the ACTIVE auth store is itself
		// Postgres-backed, the user rows live in THIS database's `auth_users`, so a
		// single JOIN supplies name/email with the roster (collapsing the old 2N
		// per-member N+1). INNER JOIN (not LEFT) is correct here — a membership row
		// can only exist for a real auth_users row (FK), and dropping a member whose
		// auth row was hard-deleted is harmless for mention matching (it could never
		// resolve a handle anyway).
		if (authLoader.kind === "postgres") {
			const rows = await this.client.unsafe<{ user_id: string; name: string | null; email: string | null }>(`
				SELECT m.user_id, u.name, u.email
				FROM workspace_members m
				JOIN auth_users u ON u.user_id = m.user_id
				WHERE m.workspace_id = $1 AND m.disabled_at IS NULL
				ORDER BY m.role ASC, m.updated_at DESC
			`, [workspaceId]);
			return rows.map((row) => ({ userId: row.user_id, name: row.name, email: row.email }));
		}
		// MIXED config (DATABASE_URL set + AUTH_USER_STORE=file — the docker-compose
		// default) or any non-Postgres loader: the user rows do NOT live in this DB's
		// `auth_users`, so the JOIN above would match nothing and mentions would
		// silently stop resolving. Resolve name/email through the configured loader
		// instead — the SAME roster + per-member best-effort load the FILE store uses.
		// A member whose auth row is missing/failed is KEPT with undefined name/email
		// (NOT dropped), preserving the pre-JOIN behaviour for this config.
		const members = await this.listMembers(workspaceId);
		return Promise.all(members.map(async (member) => {
			const user = await authLoader.load(member.userId).catch(() => null);
			return { userId: member.userId, name: user?.name, email: user?.email } satisfies WorkspaceMentionCandidate;
		}));
	}

	async listMemberPage(workspaceId: string, options: WorkspaceMemberListOptions = {}): Promise<WorkspaceMemberPage> {
		const limit = normalizeWorkspacePageLimit(options.limit);
		const cursor = decodeWorkspaceCursor(options.cursor, "userId");
		const conditions = ["workspace_id = $1", "disabled_at IS NULL"];
		const params: unknown[] = [workspaceId];
		if (options.role) {
			params.push(options.role);
			conditions.push(`role = $${params.length}`);
		}
		appendScopeCoverConditions(conditions, params, options.scopeCoveredBy, "scope");
		if (cursor) {
			params.push(cursor.updatedAt, cursor.id);
			conditions.push(`(updated_at < $${params.length - 1}::timestamptz OR (updated_at = $${params.length - 1}::timestamptz AND user_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			SELECT workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata,
				to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
			FROM workspace_members
			WHERE ${conditions.join(" AND ")}
			ORDER BY updated_at DESC, user_id DESC
			LIMIT $${params.length}
		`, params);
		const pageRows = rows.slice(0, limit);
		const members = pageRows.map(mapMemberRow);
		const lastRow = pageRows[pageRows.length - 1];
		const last = members[members.length - 1];
		return {
			members,
			nextCursor: rows.length > limit && last && lastRow ? encodeWorkspaceCursor("userId", getCursorTimestamp(lastRow, "updated"), last.userId) : undefined,
		};
	}

	async countAdmins(workspaceId: string): Promise<number> {
		// Targeted aggregate — no full roster materialization. Backed by
		// workspace_members_workspace_role_updated_idx (migration 0009) so the
		// (workspace_id, role) predicate is index-served.
		const rows = await this.client.unsafe<{ admin_count: number | string }>(`
			SELECT COUNT(*)::bigint AS admin_count
			FROM workspace_members
			WHERE workspace_id = $1
				AND role IN ('owner', 'admin')
				AND disabled_at IS NULL
		`, [workspaceId]);
		return Number(rows[0]?.admin_count ?? 0);
	}

	async updateMember(input: { workspaceId: string; userId: string; role: WorkspaceRole; memberStudioRole?: WorkspaceStudioRole; scope?: WorkspaceScope; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<WorkspaceMemberRecord> {
		if (input.role === "owner") {
			throw new WorkspaceAccessError("Owner role cannot be assigned through member update", 400, "owner_update_rejected");
		}
		const nextScope = input.scope === undefined ? null : normalizeScope(input.scope);
		// When the caller omits memberStudioRole we must preserve the member's
		// existing operational role rather than resetting it to the access-role
		// default. Otherwise an unrelated scope/access-role PATCH would silently
		// downgrade a `translator` to the access-role default (e.g. `typesetter`).
		// A null value here keeps the stored role via COALESCE below; a fresh
		// member with no stored studio role falls back to the access-role default.
		const nextStudioRole = input.memberStudioRole ?? null;
		const expectedScope = input.expectedScope === undefined ? null : normalizeScope(input.expectedScope);
		const fallbackStudioRole = defaultStudioRoleForAccessRole(input.role);
		// SEAT gate (review #592 r2 P1): PATCHing a viewer to a paid role is a
		// promotion that consumes a seat — without this, invite-time enforcement
		// is trivially bypassed (invite free viewers, then PATCH them to editor).
		// Same lock-ordering rule as everywhere: workspace-seats lock FIRST.
		if (input.role !== "viewer") {
			await this.transaction(async (client) => {
				await client.unsafe("SELECT pg_advisory_xact_lock(hashtext('workspace-seats:' || $1))", [input.workspaceId]);
				const current = await client.unsafe<{ role: string }>(`
					SELECT role FROM workspace_members
					WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL
					LIMIT 1
				`, [input.workspaceId, input.userId]);
				if (current[0]?.role === "viewer") {
					const seats = await this.resolveSeatUsage(client, input.workspaceId);
					if (seats.used >= seats.allowed) {
						throw new WorkspaceAccessError(
							`Workspace has no seats left (${seats.used}/${seats.allowed} in use). Upgrade the plan or add seats.`,
							402,
							"workspace_seats_exhausted",
						);
					}
				}
			});
		}
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			UPDATE workspace_members
			SET role = $3,
				member_studio_role = COALESCE($4, member_studio_role, $7),
				scope = COALESCE($5::jsonb, scope),
				updated_at = now()
			WHERE workspace_id = $1
				AND user_id = $2
				AND role <> 'owner'
				AND disabled_at IS NULL
				AND ($6::jsonb IS NULL OR scope = $6::jsonb)
			RETURNING workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
		`, [
			input.workspaceId,
			input.userId,
			input.role,
			nextStudioRole,
			nextScope,
			expectedScope,
			fallbackStudioRole,
		]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace member not found or cannot update owner", 404, "workspace_member_not_found");
		const member = mapMemberRow(rows[0]);
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_member_updated",
			entityType: "workspace_member",
			entityId: input.userId,
			metadata: { role: member.role, memberStudioRole: member.memberStudioRole, scope: member.scope },
		});
		return member;
	}

	async finishMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord> {
		const member = await this.getMember(input.workspaceId, input.userId);
		if (!member) throw new WorkspaceAccessError("Workspace member not found", 404, "workspace_member_not_found");
		if (member.role === "owner") throw new WorkspaceAccessError("The owner cannot be finished", 400, "owner_finish_rejected");
		// Idempotent: a member already finished stays finished (keep the FIRST stash).
		if (member.finishedFrom) return member;
		const stash: WorkspaceMemberFinishedFrom = {
			role: member.role,
			memberStudioRole: member.memberStudioRole,
			finishedAt: new Date().toISOString(),
		};
		// Demote to a free viewer seat (role <> 'viewer' frees a seat automatically),
		// keep their scope so they still SEE the work, force studio role to guest.
		// Build the stash with jsonb_build_object from SCALAR params — passing a
		// JSON string through `$N::jsonb` double-encodes it into a jsonb STRING
		// (the #528 jsonb double-encoding class), which then never parses back.
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			UPDATE workspace_members
			SET role = 'viewer',
				member_studio_role = 'guest',
				metadata = jsonb_set(
					COALESCE(metadata, '{}'::jsonb),
					'{finishedFrom}',
					jsonb_strip_nulls(jsonb_build_object('role', $3::text, 'memberStudioRole', $4::text, 'finishedAt', $5::text)),
					true
				),
				updated_at = now()
			WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner' AND disabled_at IS NULL
			RETURNING workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
		`, [input.workspaceId, input.userId, stash.role, stash.memberStudioRole ?? null, stash.finishedAt]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace member not found or cannot finish owner", 404, "workspace_member_not_found");
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_member_finished",
			entityType: "workspace_member",
			entityId: input.userId,
			metadata: { finishedFrom: stash },
		});
		return mapMemberRow(rows[0]);
	}

	async reopenMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord> {
		const member = await this.getMember(input.workspaceId, input.userId);
		if (!member) throw new WorkspaceAccessError("Workspace member not found", 404, "workspace_member_not_found");
		const stash = member.finishedFrom;
		// Idempotent: a member not finished is already "open".
		if (!stash) return member;
		// Reopen restores a PAID role ⇒ re-consume a seat. Lock seats FIRST, same
		// ordering as every seat-gated path, and 402 if the freed seat was taken.
		if (stash.role !== "viewer") {
			await this.transaction(async (client) => {
				await client.unsafe("SELECT pg_advisory_xact_lock(hashtext('workspace-seats:' || $1))", [input.workspaceId]);
				const seats = await this.resolveSeatUsage(client, input.workspaceId);
				if (seats.used >= seats.allowed) {
					throw new WorkspaceAccessError(
						`Workspace has no seats left (${seats.used}/${seats.allowed} in use). Upgrade the plan or add seats.`,
						402,
						"workspace_seats_exhausted",
					);
				}
			});
		}
		const fallbackStudioRole = defaultStudioRoleForAccessRole(stash.role);
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			UPDATE workspace_members
			SET role = $3,
				member_studio_role = COALESCE($4, $5),
				metadata = (COALESCE(metadata, '{}'::jsonb) - 'finishedFrom'),
				updated_at = now()
			WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner' AND disabled_at IS NULL
			RETURNING workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
		`, [input.workspaceId, input.userId, stash.role, stash.memberStudioRole ?? null, fallbackStudioRole]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace member not found or cannot reopen owner", 404, "workspace_member_not_found");
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_member_reopened",
			entityType: "workspace_member",
			entityId: input.userId,
			metadata: { role: stash.role, memberStudioRole: stash.memberStudioRole },
		});
		return mapMemberRow(rows[0]);
	}

	async removeMember(input: { workspaceId: string; userId: string; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<void> {
		const expectedScope = input.expectedScope === undefined ? null : normalizeScope(input.expectedScope);
		const rows = await this.client.unsafe<WorkspaceMemberRow>(`
			UPDATE workspace_members
			SET disabled_at = now(), updated_at = now()
			WHERE workspace_id = $1
				AND user_id = $2
				AND role <> 'owner'
				AND disabled_at IS NULL
				AND ($3::jsonb IS NULL OR scope = $3::jsonb)
			RETURNING workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
		`, [input.workspaceId, input.userId, expectedScope]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace member not found or cannot remove owner", 404, "workspace_member_not_found");
		// A removed member's series duties go with them: otherwise the rows keep
		// showing on story rosters, keep counting toward the per-story cap, and
		// would silently re-arm if the same user is ever invited back.
		await this.client.unsafe(`
			DELETE FROM story_role_assignments WHERE workspace_id = $1 AND user_id = $2
		`, [input.workspaceId, input.userId]);
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_member_removed",
			entityType: "workspace_member",
			entityId: input.userId,
			metadata: {},
		});
	}

	async listStoryAssignments(workspaceId: string, filter: StoryAssignmentListFilter = {}): Promise<StoryRoleAssignmentRecord[]> {
		const rows = await this.client.unsafe<StoryRoleAssignmentRow>(`
			SELECT workspace_id, story_id, user_id, role, assigned_by, created_at, updated_at
			FROM story_role_assignments
			WHERE workspace_id = $1
				AND ($2::text IS NULL OR story_id = $2)
				AND ($3::text IS NULL OR user_id = $3)
			ORDER BY updated_at DESC, story_id ASC, user_id ASC
			LIMIT ${MAX_STORY_ASSIGNMENT_LIST}
		`, [workspaceId, filter.storyId?.trim() || null, filter.userId?.trim() || null]);
		return rows.map(mapStoryAssignmentRow);
	}

	async upsertStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord> {
		const rows = await this.client.unsafe<StoryRoleAssignmentRow>(`
			INSERT INTO story_role_assignments (workspace_id, story_id, user_id, role, assigned_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, now(), now())
			ON CONFLICT (workspace_id, story_id, user_id, role) DO UPDATE SET
				assigned_by = EXCLUDED.assigned_by,
				updated_at = now()
			RETURNING workspace_id, story_id, user_id, role, assigned_by, created_at, updated_at
		`, [input.workspaceId, input.storyId.trim(), input.userId.trim(), input.role, input.actorUserId]);
		const record = mapStoryAssignmentRow(requireRow(rows, "story assignment"));
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "story_assignment_upserted",
			entityType: "story_assignment",
			entityId: `${record.storyId}:${record.userId}`,
			metadata: { storyId: record.storyId, userId: record.userId, role: record.role },
		});
		return record;
	}

	async upsertStoryAssignments(input: { workspaceId: string; storyIds: string[]; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord[]> {
		const storyIds = normalizeStoryAssignmentStoryIds(input.storyIds);
		if (storyIds.length === 0) return [];
		return this.transaction(async (client) => {
			const params: unknown[] = [input.workspaceId, input.userId.trim(), input.role, input.actorUserId];
			const storyIdArray = pushArrayLiteral(params, storyIds, "text");
			const rows = await client.unsafe<StoryRoleAssignmentRow>(`
				WITH input_story(story_id, ord) AS (
					SELECT story_id, ord::int
					FROM unnest(${storyIdArray}) WITH ORDINALITY AS t(story_id, ord)
				),
				upserted AS (
					INSERT INTO story_role_assignments (workspace_id, story_id, user_id, role, assigned_by, created_at, updated_at)
					SELECT $1, story_id, $2, $3, $4, now(), now()
					FROM input_story
					ON CONFLICT (workspace_id, story_id, user_id, role) DO UPDATE SET
						assigned_by = EXCLUDED.assigned_by,
						updated_at = now()
					RETURNING workspace_id, story_id, user_id, role, assigned_by, created_at, updated_at
				)
				SELECT upserted.workspace_id, upserted.story_id, upserted.user_id, upserted.role, upserted.assigned_by, upserted.created_at, upserted.updated_at
				FROM upserted
				JOIN input_story ON input_story.story_id = upserted.story_id
				ORDER BY input_story.ord ASC
			`, params);
			const records = rows.map(mapStoryAssignmentRow);
			for (const record of records) {
				await recordWorkspaceAudit(client, {
					workspaceId: input.workspaceId,
					actorUserId: input.actorUserId,
					action: "story_assignment_upserted",
					entityType: "story_assignment",
					entityId: `${record.storyId}:${record.userId}`,
					metadata: { storyId: record.storyId, userId: record.userId, role: record.role, bulk: true },
				});
			}
			return records;
		});
	}

	async removeStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role?: StoryAssignmentRole; actorUserId: string }): Promise<boolean> {
		// `role` null ⇒ remove EVERY duty the member holds on the story (the
		// remove-member / clear-all path); a role ⇒ remove just that one duty.
		const rows = await this.client.unsafe<{ user_id: string }>(`
			DELETE FROM story_role_assignments
			WHERE workspace_id = $1 AND story_id = $2 AND user_id = $3
				AND ($4::text IS NULL OR role = $4)
			RETURNING user_id
		`, [input.workspaceId, input.storyId.trim(), input.userId.trim(), input.role ?? null]);
		if (!rows[0]) return false;
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "story_assignment_removed",
			entityType: "story_assignment",
			entityId: `${input.storyId.trim()}:${input.userId.trim()}`,
			metadata: { storyId: input.storyId.trim(), userId: input.userId.trim(), role: input.role ?? null },
		});
		return true;
	}

	async createInvite(input: { workspaceId: string; email: string; role: WorkspaceRole; scope?: WorkspaceScope; invitedByUserId: string; ttlSeconds?: number; replaceWithinScope?: WorkspaceScope }): Promise<CreatedWorkspaceInvite> {
		if (input.role === "owner") {
			throw new WorkspaceAccessError("Owner invites are not allowed", 400, "owner_invite_rejected");
		}
		const inviteToken = createInviteToken();
		const tokenHash = hashInviteToken(inviteToken);
		const expiresAt = new Date(Date.now() + normalizeInviteTtl(input.ttlSeconds) * 1000).toISOString();
		const replaceWithinScope = input.replaceWithinScope === undefined ? null : normalizeScope(input.replaceWithinScope);
		return this.transaction(async (client) => {
			// LOCK ORDER (review #592 r2 P2): workspace-seats FIRST, then the
			// per-email invite lock, then row locks — the same order acceptInvite
			// uses, so concurrent mint/accept/replace can never deadlock.
			if (input.role !== "viewer") {
				await client.unsafe("SELECT pg_advisory_xact_lock(hashtext('workspace-seats:' || $1))", [input.workspaceId]);
			}
			await client.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`workspace_invite:${input.workspaceId}:${input.email.trim().toLowerCase()}`]);
			// SEAT fail-fast (pre-launch issue 12): refuse to MINT a non-viewer
			// invite when active non-viewer members + other pending non-viewer
			// invites already fill every seat. acceptInvite re-checks
			// authoritatively under the workspace-seats advisory lock; this check
			// just fails early so the admin isn't handed a link that can never be
			// accepted. Viewer invites are exempt (viewers are free by design).
			if (input.role !== "viewer") {
				const seats = await this.resolveSeatUsage(client, input.workspaceId);
				const pendingSeatRows = await client.unsafe<{ n: number }>(`
					SELECT count(*)::int AS n FROM workspace_invites
					WHERE workspace_id = $1 AND status = 'pending' AND role <> 'viewer'
						AND lower(email) <> lower($2)
						AND expires_at > now()
				`, [input.workspaceId, input.email]);
				if (seats.used + (pendingSeatRows[0]?.n ?? 0) >= seats.allowed) {
					throw new WorkspaceAccessError(
						`Workspace has no seats left (${seats.used} members + pending invites vs ${seats.allowed} seats). Upgrade the plan or add seats.`,
						402,
						"workspace_seats_exhausted",
					);
				}
			}
			const pendingRows = await client.unsafe<WorkspaceInviteRow>(`
				SELECT invite_id, workspace_id, email, role, scope, status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
				FROM workspace_invites
				WHERE workspace_id = $1
					AND lower(email) = lower($2)
					AND status = 'pending'
				FOR UPDATE
			`, [input.workspaceId, input.email]);
			const pendingInvites = pendingRows.map(mapInviteRow);
			const blockedInvite = replaceWithinScope
				? pendingInvites.find((invite) => !workspaceScopeCovers(replaceWithinScope, invite.scope))
				: null;
			if (blockedInvite) {
				throw new WorkspaceAccessError("Forbidden: cannot replace a broader pending workspace invite", 403, "workspace_invite_scope_replace_denied");
			}
			const revocableInviteIds = pendingInvites.map((invite) => invite.inviteId);
			if (revocableInviteIds.length > 0) {
				const placeholders = revocableInviteIds.map((_, index) => `$${index + 2}`).join(", ");
				await client.unsafe(`
					UPDATE workspace_invites
					SET status = 'revoked',
						revoked_at = now(),
						updated_at = now()
					WHERE workspace_id = $1
						AND invite_id IN (${placeholders})
				`, [input.workspaceId, ...revocableInviteIds]);
			}
			const rows = await client.unsafe<WorkspaceInviteRow>(`
				INSERT INTO workspace_invites (
					invite_id,
					workspace_id,
					email,
					role,
					scope,
					token_hash,
					status,
					invited_by_user_id,
					expires_at,
					created_at,
					updated_at
				)
				VALUES ($1, $2, lower($3), $4, $5::jsonb, $6, 'pending', $7, $8, now(), now())
				RETURNING invite_id, workspace_id, email, role, scope, status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
			`, [
				randomUUID(),
				input.workspaceId,
				input.email,
				input.role,
				normalizeScope(input.scope),
				tokenHash,
				input.invitedByUserId,
				expiresAt,
			]);
			const invite = mapInviteRow(requireRow(rows, "workspace invite"));
			await recordWorkspaceAudit(client, {
				workspaceId: input.workspaceId,
				actorUserId: input.invitedByUserId,
				action: "workspace_invite_created",
				entityType: "workspace_invite",
				entityId: invite.inviteId,
				metadata: { email: invite.email, role: invite.role, scope: invite.scope },
			});
			return { ...invite, inviteToken };
		});
	}

	async getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInviteRecord | null> {
		const rows = await this.client.unsafe<WorkspaceInviteRow>(`
			SELECT invite_id, workspace_id, email, role, scope,
				CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
				invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
			FROM workspace_invites
			WHERE workspace_id = $1 AND invite_id = $2
			LIMIT 1
		`, [workspaceId, inviteId]);
		return rows[0] ? mapInviteRow(rows[0]) : null;
	}

	async listInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]> {
		const rows = await this.client.unsafe<WorkspaceInviteRow>(`
			SELECT invite_id, workspace_id, email, role, scope,
				CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
				invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
			FROM workspace_invites
			WHERE workspace_id = $1
			ORDER BY created_at DESC
			LIMIT 200
		`, [workspaceId]);
		return rows.map(mapInviteRow);
	}

	async listInvitePage(workspaceId: string, options: WorkspaceInviteListOptions = {}): Promise<WorkspaceInvitePage> {
		const limit = normalizeWorkspacePageLimit(options.limit);
		const cursor = decodeWorkspaceCursor(options.cursor, "inviteId");
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [workspaceId];
		appendScopeCoverConditions(conditions, params, options.scopeCoveredBy, "scope");
		if (cursor) {
			params.push(cursor.updatedAt, cursor.id);
			conditions.push(`(created_at < $${params.length - 1}::timestamptz OR (created_at = $${params.length - 1}::timestamptz AND invite_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<WorkspaceInviteRow>(`
			SELECT invite_id, workspace_id, email, role, scope,
				CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
				invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
			FROM workspace_invites
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, invite_id DESC
			LIMIT $${params.length}
		`, params);
		const pageRows = rows.slice(0, limit);
		const invites = pageRows.map(mapInviteRow);
		const lastRow = pageRows[pageRows.length - 1];
		const last = invites[invites.length - 1];
		return {
			invites,
			nextCursor: rows.length > limit && last && lastRow ? encodeWorkspaceCursor("inviteId", getCursorTimestamp(lastRow, "created"), last.inviteId) : undefined,
		};
	}

	async listAuditEventPage(workspaceId: string, options: WorkspaceAuditEventListOptions = {}): Promise<WorkspaceAuditEventPage> {
		const limit = normalizeWorkspacePageLimit(options.limit);
		const cursor = decodeWorkspaceCursor(options.cursor, "auditEventId");
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [workspaceId];
		if (options.action) {
			params.push(options.action);
			conditions.push(`action = $${params.length}`);
		}
		if (options.entityType) {
			params.push(options.entityType);
			conditions.push(`entity_type = $${params.length}`);
		}
		if (options.actorUserId) {
			params.push(options.actorUserId);
			conditions.push(`actor_user_id = $${params.length}`);
		}
		if (options.createdAfter) {
			params.push(options.createdAfter);
			conditions.push(`created_at >= $${params.length}::timestamptz`);
		}
		if (options.createdBefore) {
			params.push(options.createdBefore);
			conditions.push(`created_at <= $${params.length}::timestamptz`);
		}
		if (cursor) {
			params.push(cursor.updatedAt, cursor.id);
			conditions.push(`(created_at < $${params.length - 1}::timestamptz OR (created_at = $${params.length - 1}::timestamptz AND audit_event_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<WorkspaceAuditEventRow>(`
			SELECT audit_event_id, workspace_id, project_id, actor_user_id, action, entity_type, entity_id, metadata, created_at,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
			FROM audit_events
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, audit_event_id DESC
			LIMIT $${params.length}
		`, params);
		const pageRows = rows.slice(0, limit);
		const events = pageRows.map(mapAuditEventRow);
		const lastRow = pageRows[pageRows.length - 1];
		const last = events[events.length - 1];
		return {
			events,
			nextCursor: rows.length > limit && last && lastRow ? encodeWorkspaceCursor("auditEventId", getCursorTimestamp(lastRow, "created"), last.auditEventId) : undefined,
		};
	}

	async recordAuditEvent(input: { workspaceId: string; actorUserId: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }): Promise<void> {
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: input.action,
			entityType: input.entityType,
			entityId: input.entityId,
			metadata: input.metadata ?? {},
		});
	}

	async revokeInvite(input: { workspaceId: string; inviteId: string; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<WorkspaceInviteRecord> {
		const expectedScope = input.expectedScope === undefined ? null : normalizeScope(input.expectedScope);
		const rows = await this.client.unsafe<WorkspaceInviteRow>(`
			UPDATE workspace_invites
			SET status = 'revoked',
				revoked_at = now(),
				updated_at = now()
			WHERE workspace_id = $1
				AND invite_id = $2
				AND status = 'pending'
				AND ($3::jsonb IS NULL OR scope = $3::jsonb)
			RETURNING invite_id, workspace_id, email, role, scope, status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
		`, [input.workspaceId, input.inviteId, expectedScope]);
		if (!rows[0]) throw new WorkspaceAccessError("Workspace invite not found or cannot be revoked", 404, "workspace_invite_not_found");
		const invite = mapInviteRow(rows[0]);
		await recordWorkspaceAudit(this.client, {
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "workspace_invite_revoked",
			entityType: "workspace_invite",
			entityId: input.inviteId,
			metadata: { email: invite.email, role: invite.role, scope: invite.scope },
		});
		return invite;
	}

	/**
	 * Seat accounting inside an open transaction. Counts ACTIVE non-viewer
	 * members (viewers are deliberately free — review/read-only seats must not
	 * inflate the bill) against the plan's max_seats_included plus active,
	 * unexpired seat add-on grants. Reads billing_plans via the DB mirror so the
	 * check stays inside one transaction with the membership insert.
	 */
	private async resolveSeatUsage(client: WorkspaceAccessSqlClient, workspaceId: string): Promise<{ used: number; allowed: number }> {
		// Lazy import: billing-store transitively imports this module, so a
		// top-level import would create an init cycle. The helper itself stays the
		// single source of truth for the dunning-grace SQL.
		const { dunningGraceActiveSql } = await import("./billing-store.js");
		const usedRows = await client.unsafe<{ used: number }>(`
			SELECT count(*)::int AS used
			FROM workspace_members
			WHERE workspace_id = $1 AND disabled_at IS NULL AND role <> 'viewer'
		`, [workspaceId]);
		const allowanceRows = await client.unsafe<{ allowed: number }>(`
			SELECT (
				COALESCE((
					SELECT bp.max_seats_included
					FROM workspace_billing_accounts wba
					JOIN billing_plans bp ON bp.plan_id = wba.plan_id
					WHERE wba.workspace_id = $1
						-- Mirror every other plan resolver (project-catalog/usage-ledger):
						-- only an in-effect paid row grants paid capacity; past_due/
						-- cancelled or a lapsed dunning grace falls back to free.
						AND wba.status IN ('mock_active', 'trialing', 'active')
						AND ${dunningGraceActiveSql("wba")}
				), (SELECT max_seats_included FROM billing_plans WHERE plan_id = 'free'), 2)
				+ COALESCE((
					SELECT SUM(GREATEST(g.seats, 0) * GREATEST(g.quantity, 0))::int
					FROM workspace_addon_grants g
					WHERE g.workspace_id = $1
						AND g.status = 'active'
						AND g.seats > 0
						AND (g.expires_at IS NULL OR g.expires_at > now())
				), 0)
			)::int AS allowed
		`, [workspaceId]);
		return { used: usedRows[0]?.used ?? 0, allowed: allowanceRows[0]?.allowed ?? 2 };
	}

	async acceptInvite(input: { inviteId: string; inviteToken: string; userId: string; email: string; now?: Date }): Promise<WorkspaceMemberRecord> {
		const result = await this.transaction<{ status: "accepted"; member: WorkspaceMemberRecord } | { status: "expired" }>(async (client) => {
			// LOCK ORDER (review #592 r2 P2): the invite's role isn't known until
			// the row is read, but the seats lock must come BEFORE any invite row
			// lock to match createInvite's order — so resolve the workspace id
			// without locking, take the seats lock, THEN take the row lock.
			const peek = await client.unsafe<{ workspace_id: string }>(`
				SELECT workspace_id FROM workspace_invites WHERE invite_id = $1 LIMIT 1
			`, [input.inviteId]);
			if (peek[0]?.workspace_id) {
				await client.unsafe("SELECT pg_advisory_xact_lock(hashtext('workspace-seats:' || $1))", [peek[0].workspace_id]);
			}
			const rows = await client.unsafe<(WorkspaceInviteRow & { token_hash: string })>(`
				SELECT invite_id, workspace_id, email, role, scope, token_hash, status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, revoked_at, created_at, updated_at
				FROM workspace_invites
				WHERE invite_id = $1
				LIMIT 1
				FOR UPDATE
			`, [input.inviteId]);
			const row = rows[0];
			if (!row) throw new WorkspaceAccessError("Workspace invite not found", 404, "workspace_invite_not_found");
			const invite = mapInviteRow(row);
			if (invite.status !== "pending") throw new WorkspaceAccessError("Workspace invite is not pending", 409, "workspace_invite_not_pending");
			if (new Date(invite.expiresAt).getTime() <= (input.now ?? new Date()).getTime()) {
				await client.unsafe("UPDATE workspace_invites SET status = 'expired', updated_at = now() WHERE invite_id = $1", [input.inviteId]);
				return { status: "expired" };
			}
			if (invite.email !== input.email.trim().toLowerCase()) {
				throw new WorkspaceAccessError("Workspace invite email does not match this account", 403, "workspace_invite_email_mismatch");
			}
			if (!verifyInviteToken(input.inviteToken, row.token_hash)) {
				throw new WorkspaceAccessError("Workspace invite token is invalid", 403, "workspace_invite_token_invalid");
			}

			// SEAT ENFORCEMENT (pre-launch issue 12): acceptance is the authoritative
			// gate — the FOR UPDATE above serializes per-invite, and this advisory
			// lock serializes per-WORKSPACE so two different invites accepted
			// concurrently cannot both slip under the cap. Viewer invites bypass the
			// check (viewers are free seats by design). A member re-accept (their
			// disabled row still exists) does not add a seat, so the count below —
			// which already excludes them only if disabled — stays correct: the
			// upsert re-enables rather than inserts.
			if (invite.role !== "viewer") {
				// (workspace-seats lock already held — taken before the row lock above.)
				// Only an existing ACTIVE NON-viewer already holds a seat. A viewer
				// accepting a non-viewer invite is a PROMOTION that consumes one, so
				// it must pass the cap check like a brand-new member.
				const existing = await client.unsafe<{ n: number }>(`
					SELECT count(*)::int AS n FROM workspace_members
					WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL AND role <> 'viewer'
				`, [invite.workspaceId, input.userId]);
				if ((existing[0]?.n ?? 0) === 0) {
					const seats = await this.resolveSeatUsage(client, invite.workspaceId);
					if (seats.used >= seats.allowed) {
						throw new WorkspaceAccessError(
							`Workspace has no seats left (${seats.used}/${seats.allowed} in use). Upgrade the plan or add seats.`,
							402,
							"workspace_seats_exhausted",
						);
					}
				}
			}

			await client.unsafe(`
				UPDATE workspace_invites
				SET status = 'accepted',
					accepted_by_user_id = $2,
					accepted_at = now(),
					updated_at = now()
				WHERE invite_id = $1
			`, [input.inviteId, input.userId]);

			const memberRows = await client.unsafe<WorkspaceMemberRow>(`
				INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at)
				VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now(), NULL)
				ON CONFLICT (workspace_id, user_id) DO UPDATE SET
					role = CASE WHEN workspace_members.role = 'owner' THEN workspace_members.role ELSE EXCLUDED.role END,
					member_studio_role = CASE WHEN workspace_members.role = 'owner' THEN workspace_members.member_studio_role ELSE EXCLUDED.member_studio_role END,
					scope = CASE WHEN workspace_members.role = 'owner' THEN workspace_members.scope ELSE EXCLUDED.scope END,
					invited_by_user_id = CASE WHEN workspace_members.role = 'owner' THEN workspace_members.invited_by_user_id ELSE EXCLUDED.invited_by_user_id END,
					disabled_at = CASE WHEN workspace_members.role = 'owner' THEN workspace_members.disabled_at ELSE NULL END,
					updated_at = now()
				RETURNING workspace_id, user_id, role, member_studio_role, scope, invited_by_user_id, created_at, updated_at, disabled_at, metadata
			`, [
				invite.workspaceId,
				input.userId,
				invite.role,
				defaultStudioRoleForAccessRole(invite.role),
				invite.scope,
				invite.invitedByUserId,
			]);
			const member = mapMemberRow(requireRow(memberRows, "workspace member"));
			await recordWorkspaceAudit(client, {
				workspaceId: invite.workspaceId,
				actorUserId: input.userId,
				action: "workspace_invite_accepted",
				entityType: "workspace_invite",
				entityId: invite.inviteId,
				metadata: { role: member.role, memberStudioRole: member.memberStudioRole, scope: member.scope, inviteRole: invite.role, inviteScope: invite.scope },
			});
			return { status: "accepted", member };
		});
		if (result.status === "expired") {
			throw new WorkspaceAccessError("Workspace invite expired", 410, "workspace_invite_expired");
		}
		return result.member;
	}

	async erasePiiForUser(userId: string, originalEmail?: string): Promise<{ membershipsRemoved: number; invitesAnonymized: number }> {
		const normalized = userId.trim();
		if (!normalized) return { membershipsRemoved: 0, invitesAnonymized: 0 };
		// Standalone path (production purges this atomically inside the GDPR
		// transaction). DELETE the subject's memberships and anonymize the invitee
		// email on invites addressed to their original (lowercased) address.
		const memberRows = await this.client.unsafe<{ count: number | string }>(`
			WITH deleted AS (
				DELETE FROM workspace_members WHERE user_id = $1 RETURNING 1
			)
			SELECT COUNT(*)::int AS count FROM deleted
		`, [normalized]);
		const membershipsRemoved = Number(memberRows[0]?.count ?? 0) || 0;
		// Series duties point at the erased user — drop them with the membership.
		await this.client.unsafe(`DELETE FROM story_role_assignments WHERE user_id = $1`, [normalized]);
		let invitesAnonymized = 0;
		const email = originalEmail?.trim().toLowerCase();
		if (email) {
			const inviteRows = await this.client.unsafe<{ count: number | string }>(`
				WITH updated AS (
					UPDATE workspace_invites SET email = $2 WHERE email = $1 RETURNING 1
				)
				SELECT COUNT(*)::int AS count FROM updated
			`, [email, `purged+${normalized}@redacted.invalid`]);
			invitesAnonymized = Number(inviteRows[0]?.count ?? 0) || 0;
		}
		return { membershipsRemoved, invitesAnonymized };
	}

	private async transaction<T>(fn: (client: WorkspaceAccessSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) return this.client.begin(fn);
		await this.client.unsafe("BEGIN");
		try {
			const result = await fn(this.client);
			await this.client.unsafe("COMMIT");
			return result;
		} catch (error) {
			await this.client.unsafe("ROLLBACK");
			throw error;
		}
	}
}

// ── File-mode workspace store ───────────────────────────────────────────────
//
// Mirrors the file|postgres pattern used by notifications / billing-store /
// project-catalog so a local prototype run WITHOUT DATABASE_URL stays usable
// instead of every workspace route hard-failing with 503. Without this the
// dashboard/library never load (GET /api/workspaces → 503), which cascades and
// blocks the create-chapter / add-image flow entirely.
//
// Behaviour: each user is auto-provisioned a single personal "owner" workspace
// the first time they list/read workspaces, so the UI always has a sensible
// default workspace context. Member/invite/audit operations are supported as an
// in-memory + JSON snapshot, scoped per workspace. The personal default cannot
// invite members or be widened — those flows are Postgres-only in production —
// but everything the single-user prototype needs (a default workspace so
// project create + image upload work) is provided.

interface FileWorkspaceSnapshot {
	workspaces?: WorkspaceRecord[];
	members?: WorkspaceMemberRecord[];
	invites?: Array<WorkspaceInviteRecord & { tokenHash: string }>;
	audit?: WorkspaceAuditEventRecord[];
	storyAssignments?: StoryRoleAssignmentRecord[];
}

export class FileWorkspaceAccessStore implements WorkspaceAccessStore {
	private readonly workspaces = new Map<string, WorkspaceRecord>();
	private readonly members: WorkspaceMemberRecord[] = [];
	private readonly invites: Array<WorkspaceInviteRecord & { tokenHash: string }> = [];
	private readonly audit: WorkspaceAuditEventRecord[] = [];
	private readonly storyAssignments: StoryRoleAssignmentRecord[] = [];

	constructor(
		private readonly persistPath?: string,
		private readonly personalWorkspaceProfileLoader?: PersonalWorkspaceProfileLoader,
	) {
		this.load();
	}

	/** Public interface entry point: provision the signed-in user's personal
	 *  workspace on demand (called from the self-serve GET /workspaces route). */
	async ensurePersonalWorkspace(userId: string): Promise<void> {
		const normalized = userId.trim();
		if (!normalized) return;
		const ownerProfile = this.personalWorkspaceProfileLoader
			? await this.personalWorkspaceProfileLoader.load(normalized).catch(() => null)
			: null;
		this.ensurePersonalWorkspaceRecord(normalized, ownerProfile);
	}

	/**
	 * Ensure the user has at least one workspace. In single-tenant file-mode every
	 * authenticated user owns exactly one personal workspace; we lazily create it
	 * the first time the user touches the workspace API so a fresh sign-up lands on
	 * a real, usable workspace (rather than an empty list the dashboard treats as
	 * "no workspace" and refuses to let them create/upload into).
	 */
	private ensurePersonalWorkspaceRecord(
		userId: string,
		ownerProfile?: PersonalWorkspaceOwnerProfile | null,
	): WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope } {
		const normalized = userId.trim();
		// Synthetic catalog memberships don't count as "owns a workspace" — the
		// list paths hide those ids, so honoring one here would strand the user
		// with an empty list and no real personal workspace (codex P1).
		const existing = this.members.find((member) =>
			member.userId === normalized
			&& member.role === "owner"
			&& !member.disabledAt
			&& !/^(?:personal|project):/.test(member.workspaceId));
		if (existing) {
			const workspace = this.workspaces.get(existing.workspaceId);
			if (workspace) {
				return { ...workspace, memberRole: existing.role, memberStudioRole: existing.memberStudioRole ?? "owner", memberScope: existing.scope };
			}
		}
		const now = new Date().toISOString();
		const workspaceId = randomUUID();
		const workspace: WorkspaceRecord = {
			workspaceId,
			name: buildPersonalWorkspaceName(ownerProfile),
			planId: "free",
			storageIncludedBytes: 0,
			storageExtraBytes: 0,
			createdAt: now,
			updatedAt: now,
		};
		const member: WorkspaceMemberRecord = {
			workspaceId,
			userId: normalized,
			role: "owner",
			memberStudioRole: "owner",
			scope: {},
			createdAt: now,
			updatedAt: now,
		};
		this.workspaces.set(workspaceId, workspace);
		this.members.push(member);
		this.persist();
		return { ...workspace, memberRole: "owner", memberStudioRole: "owner", memberScope: {} };
	}

	async createWorkspace(input: { workspaceId: string; name: string; ownerUserId: string; planId?: string }): Promise<WorkspaceRecord> {
		const now = new Date().toISOString();
		const existing = this.workspaces.get(input.workspaceId);
		const workspace: WorkspaceRecord = {
			workspaceId: input.workspaceId,
			name: input.name,
			planId: normalizeWorkspacePlanId(input.planId) ?? "free",
			storageIncludedBytes: existing?.storageIncludedBytes ?? 0,
			storageExtraBytes: existing?.storageExtraBytes ?? 0,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.workspaces.set(workspace.workspaceId, workspace);
		const owner = this.members.find((member) => member.workspaceId === workspace.workspaceId && member.userId === input.ownerUserId.trim());
		if (owner) {
			owner.role = "owner";
			owner.memberStudioRole = "owner";
			owner.scope = {};
			owner.disabledAt = undefined;
			owner.updatedAt = now;
		} else {
			this.members.push({
				workspaceId: workspace.workspaceId,
				userId: input.ownerUserId.trim(),
				role: "owner",
				memberStudioRole: "owner",
				scope: {},
				createdAt: now,
				updatedAt: now,
			});
		}
		this.persist();
		return { ...workspace };
	}

	async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
		const workspace = this.workspaces.get(workspaceId);
		return workspace ? { ...workspace } : null;
	}

	async updateWorkspace(input: { workspaceId: string; name: string; actorUserId: string }): Promise<WorkspaceRecord> {
		const workspace = this.workspaces.get(input.workspaceId);
		if (!workspace) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		workspace.name = input.name;
		workspace.updatedAt = new Date().toISOString();
		this.persist();
		return { ...workspace };
	}

	async listUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope }>> {
		await this.ensurePersonalWorkspace(userId);
		return this.userWorkspaceRows(userId);
	}

	async listUserWorkspacePage(userId: string, options: WorkspaceListOptions = {}): Promise<UserWorkspacePage> {
		await this.ensurePersonalWorkspace(userId);
		let rows = this.userWorkspaceRows(userId);
		if (options.role) rows = rows.filter((row) => row.memberRole === options.role);
		// Mirror the Postgres keyset contract: order updated_at DESC, workspace_id
		// DESC and bound the page by limit/cursor so file-mode clients can page and
		// `?limit=N` is actually honoured.
		const { page, nextCursor } = paginateFileWorkspaceRecords(
			rows,
			options.limit,
			options.cursor,
			"workspaceId",
			(row) => row.updatedAt,
			(row) => row.workspaceId,
		);
		return { workspaces: page, nextCursor };
	}

	async listAllWorkspacePage(options: AllWorkspacesListOptions = {}): Promise<AllWorkspacesPage> {
		const search = options.search?.trim().toLowerCase() || undefined;
		const filtered = [...this.workspaces.values()]
			.filter((workspace) => {
				if (!search) return true;
				return `${workspace.name} ${workspace.workspaceId}`.toLowerCase().includes(search);
			})
			// Mirror the Postgres ORDER BY (updated_at DESC, workspace_id DESC) and the
			// keyset cursor comparator's id tiebreaker so paging is stable.
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.workspaceId.localeCompare(a.workspaceId))
			.map((workspace) => ({ ...workspace }));
		// `filtered` is the FULL filtered set (no cursor/limit), so its length is the
		// honest total for the admin header — computed before the cursor window.
		const total = filtered.length;
		const { page, nextCursor } = paginateFileWorkspaceRecords(
			filtered,
			options.limit,
			options.cursor,
			"workspaceId",
			(row) => row.updatedAt,
			(row) => row.workspaceId,
		);
		return { workspaces: page, nextCursor, total };
	}

	private userWorkspaceRows(userId: string): Array<WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope }> {
		const normalized = userId.trim();
		return this.members
			// Synthetic catalog bookkeeping ids are never user workspaces (parity
			// with the Postgres list filter — see listUserWorkspaces).
			.filter((member) => !/^(?:personal|project):/.test(member.workspaceId))
			.filter((member) => member.userId === normalized && !member.disabledAt)
			.map((member) => {
				const workspace = this.workspaces.get(member.workspaceId);
				return workspace ? { ...workspace, memberRole: member.role, memberStudioRole: member.memberStudioRole ?? "owner", memberScope: member.scope } : null;
			})
			.filter((row): row is WorkspaceRecord & { memberRole: WorkspaceRole; memberStudioRole: WorkspaceStudioRole; memberScope: WorkspaceScope } => row !== null)
			// Match the Postgres ORDER BY (updated_at DESC, workspace_id DESC) AND the
			// keyset cursor comparator: the id tiebreaker is required so a page boundary
			// between equal-timestamp rows is stable and the cursor walk can't stall.
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.workspaceId.localeCompare(a.workspaceId));
	}

	async getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
		const member = this.members.find((entry) => entry.workspaceId === workspaceId && entry.userId === userId.trim() && !entry.disabledAt);
		return member ? { ...member } : null;
	}

	async isMembershipRevoked(workspaceId: string, userId: string): Promise<boolean> {
		const row = this.members.find((entry) => entry.workspaceId === workspaceId && entry.userId === userId.trim());
		return Boolean(row?.disabledAt);
	}

	async requirePermission(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<WorkspaceMemberRecord> {
		const member = await this.getMember(workspaceId, userId);
		if (!member) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		if (!roleHasPermission(member.role, permission)) {
			throw new WorkspaceAccessError(`Forbidden: missing workspace permission '${permission}'`, 403, "workspace_permission_denied");
		}
		// FREEZE gate (mirror of the Postgres store): a suspended workspace blocks EVERY
		// mutating permission for EVERYONE; reads pass.
		if (isMutatingPermission(permission) && this.workspaces.get(workspaceId)?.suspendedAt) {
			throw new WorkspaceAccessError("Workspace is suspended (payment refund/chargeback). Pay to restore access.", 403, "workspace_suspended");
		}
		return member;
	}

	async isWorkspaceSuspended(workspaceId: string): Promise<boolean> {
		return Boolean(this.workspaces.get(workspaceId)?.suspendedAt);
	}

	async setWorkspaceSuspension(input: { workspaceId: string; suspend: boolean; reason?: string; actorUserId?: string }): Promise<WorkspaceRecord> {
		const workspace = this.workspaces.get(input.workspaceId);
		if (!workspace) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		if (input.suspend) {
			// Idempotent: keep the original instant/reason when already frozen.
			if (!workspace.suspendedAt) {
				workspace.suspendedAt = new Date().toISOString();
				workspace.suspendedReason = input.reason ?? "admin";
			}
		} else {
			workspace.suspendedAt = undefined;
			workspace.suspendedReason = undefined;
		}
		workspace.updatedAt = new Date().toISOString();
		this.persist();
		return { ...workspace };
	}

	async requireScopedPermission(workspaceId: string, userId: string, permission: WorkspacePermission, scopeCheck: WorkspaceScopeCheck): Promise<WorkspaceMemberRecord> {
		const member = await this.requirePermission(workspaceId, userId, permission);
		if (!workspaceScopeAllows(member.scope, scopeCheck)) {
			throw new WorkspaceAccessError("Forbidden: workspace scope does not allow this resource", 403, "workspace_scope_denied");
		}
		// Mirror PostgresWorkspaceAccessStore: a member whose scope disables AI credits
		// cannot generate AI even if the role would otherwise permit it.
		if (permission === "generate_ai" && member.scope.aiCreditPolicy === "none") {
			throw new WorkspaceAccessError("Forbidden: AI credits are disabled for this member", 403, "workspace_ai_scope_denied");
		}
		return member;
	}

	async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
		return this.members.filter((member) => member.workspaceId === workspaceId && !member.disabledAt).map((member) => ({ ...member }));
	}

	async listMentionCandidates(workspaceId: string, authLoader: MentionCandidateAuthLoader): Promise<WorkspaceMentionCandidate[]> {
		// FILE mode has no JOIN: take the same active-member roster as listMembers
		// and resolve name/email via the injected loader. These are local file
		// reads (no DB round-trips), so the simple per-member loop is fine. A
		// missing/failed auth row yields a candidate with undefined name/email —
		// best-effort, exactly like the prior `.catch(() => null)` semantics.
		const members = await this.listMembers(workspaceId);
		return Promise.all(members.map(async (member) => {
			const user = await authLoader.load(member.userId).catch(() => null);
			return { userId: member.userId, name: user?.name, email: user?.email } satisfies WorkspaceMentionCandidate;
		}));
	}

	async listMemberPage(workspaceId: string, options: WorkspaceMemberListOptions = {}): Promise<WorkspaceMemberPage> {
		let members = await this.listMembers(workspaceId);
		if (options.role) members = members.filter((member) => member.role === options.role);
		// Honour the actor's scope filter exactly like the Postgres store: a scoped
		// manager must only see members covered by their own scope, never the whole
		// roster. Without this a project/language-scoped admin could enumerate
		// broader membership in file-mode.
		if (options.scopeCoveredBy) members = filterWorkspaceScopeCoveredRecords(options.scopeCoveredBy, members);
		// Order updated_at DESC, user_id DESC and bound by limit/cursor.
		members = members.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.userId.localeCompare(a.userId));
		const { page, nextCursor } = paginateFileWorkspaceRecords(
			members,
			options.limit,
			options.cursor,
			"userId",
			(member) => member.updatedAt,
			(member) => member.userId,
		);
		return { members: page, nextCursor };
	}

	async countAdmins(workspaceId: string): Promise<number> {
		return this.members.filter((member) =>
			member.workspaceId === workspaceId
			&& !member.disabledAt
			&& (member.role === "owner" || member.role === "admin"),
		).length;
	}

	async updateMember(input: { workspaceId: string; userId: string; role: WorkspaceRole; memberStudioRole?: WorkspaceStudioRole; scope?: WorkspaceScope; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<WorkspaceMemberRecord> {
		if (input.role === "owner") throw new WorkspaceAccessError("Owner role cannot be assigned through member update", 400, "owner_update_rejected");
		const member = this.members.find((entry) => entry.workspaceId === input.workspaceId && entry.userId === input.userId.trim() && entry.role !== "owner" && !entry.disabledAt);
		if (!member) throw new WorkspaceAccessError("Workspace member not found or cannot update owner", 404, "workspace_member_not_found");
		member.role = input.role;
		if (input.memberStudioRole) member.memberStudioRole = input.memberStudioRole;
		if (input.scope !== undefined) member.scope = normalizeScope(input.scope);
		member.updatedAt = new Date().toISOString();
		this.persist();
		return { ...member };
	}

	async finishMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord> {
		const member = this.members.find((entry) => entry.workspaceId === input.workspaceId && entry.userId === input.userId.trim() && !entry.disabledAt);
		if (!member) throw new WorkspaceAccessError("Workspace member not found", 404, "workspace_member_not_found");
		if (member.role === "owner") throw new WorkspaceAccessError("The owner cannot be finished", 400, "owner_finish_rejected");
		if (member.finishedFrom) return { ...member };
		member.finishedFrom = { role: member.role, memberStudioRole: member.memberStudioRole, finishedAt: new Date().toISOString() };
		member.role = "viewer";
		member.memberStudioRole = "guest";
		member.updatedAt = new Date().toISOString();
		this.persist();
		return { ...member };
	}

	async reopenMember(input: { workspaceId: string; userId: string; actorUserId: string }): Promise<WorkspaceMemberRecord> {
		const member = this.members.find((entry) => entry.workspaceId === input.workspaceId && entry.userId === input.userId.trim() && !entry.disabledAt);
		if (!member) throw new WorkspaceAccessError("Workspace member not found", 404, "workspace_member_not_found");
		const stash = member.finishedFrom;
		if (!stash) return { ...member };
		member.role = stash.role;
		member.memberStudioRole = stash.memberStudioRole ?? defaultStudioRoleForAccessRole(stash.role);
		member.finishedFrom = undefined;
		member.updatedAt = new Date().toISOString();
		this.persist();
		return { ...member };
	}

	async removeMember(input: { workspaceId: string; userId: string; actorUserId: string; expectedScope?: WorkspaceScope }): Promise<void> {
		const member = this.members.find((entry) => entry.workspaceId === input.workspaceId && entry.userId === input.userId.trim() && entry.role !== "owner" && !entry.disabledAt);
		if (!member) throw new WorkspaceAccessError("Workspace member not found or cannot remove owner", 404, "workspace_member_not_found");
		member.disabledAt = new Date().toISOString();
		member.updatedAt = member.disabledAt;
		// A removed member's series duties go with them (mirrors the Postgres
		// store): no stale roster rows, no cap pollution, no re-invite re-arm.
		for (let index = this.storyAssignments.length - 1; index >= 0; index -= 1) {
			const entry = this.storyAssignments[index]!;
			if (entry.workspaceId === input.workspaceId && entry.userId === member.userId) {
				this.storyAssignments.splice(index, 1);
			}
		}
		this.persist();
	}

	async listStoryAssignments(workspaceId: string, filter: StoryAssignmentListFilter = {}): Promise<StoryRoleAssignmentRecord[]> {
		const storyId = filter.storyId?.trim() || undefined;
		const userId = filter.userId?.trim() || undefined;
		return this.storyAssignments
			.filter((entry) => entry.workspaceId === workspaceId
				&& (!storyId || entry.storyId === storyId)
				&& (!userId || entry.userId === userId))
			// Mirror the Postgres ORDER BY (updated_at DESC, story_id, user_id) + LIMIT.
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.storyId.localeCompare(b.storyId) || a.userId.localeCompare(b.userId))
			.slice(0, MAX_STORY_ASSIGNMENT_LIST)
			.map((entry) => ({ ...entry }));
	}

	async upsertStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord> {
		const storyId = input.storyId.trim();
		const userId = input.userId.trim();
		const now = new Date().toISOString();
		// Multi-duty: key on (story, user, ROLE) so a member can hold several duties.
		let record = this.storyAssignments.find((entry) => entry.workspaceId === input.workspaceId && entry.storyId === storyId && entry.userId === userId && entry.role === input.role);
		if (record) {
			record.assignedBy = input.actorUserId;
			record.updatedAt = now;
		} else {
			record = { workspaceId: input.workspaceId, storyId, userId, role: input.role, assignedBy: input.actorUserId, createdAt: now, updatedAt: now };
			this.storyAssignments.push(record);
		}
		this.appendAudit({
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "story_assignment_upserted",
			entityType: "story_assignment",
			entityId: `${storyId}:${userId}`,
			metadata: { storyId, userId, role: input.role },
		});
		this.persist();
		return { ...record };
	}

	async upsertStoryAssignments(input: { workspaceId: string; storyIds: string[]; userId: string; role: StoryAssignmentRole; actorUserId: string }): Promise<StoryRoleAssignmentRecord[]> {
		const storyIds = normalizeStoryAssignmentStoryIds(input.storyIds);
		if (storyIds.length === 0) return [];
		const userId = input.userId.trim();
		const now = new Date().toISOString();
		const records: StoryRoleAssignmentRecord[] = [];
		for (const storyId of storyIds) {
			let record = this.storyAssignments.find((entry) => entry.workspaceId === input.workspaceId && entry.storyId === storyId && entry.userId === userId && entry.role === input.role);
			if (record) {
				record.assignedBy = input.actorUserId;
				record.updatedAt = now;
			} else {
				record = { workspaceId: input.workspaceId, storyId, userId, role: input.role, assignedBy: input.actorUserId, createdAt: now, updatedAt: now };
				this.storyAssignments.push(record);
			}
			this.appendAudit({
				workspaceId: input.workspaceId,
				actorUserId: input.actorUserId,
				action: "story_assignment_upserted",
				entityType: "story_assignment",
				entityId: `${storyId}:${userId}`,
				metadata: { storyId, userId, role: input.role, bulk: true },
			});
			records.push({ ...record });
		}
		this.persist();
		return records;
	}

	async removeStoryAssignment(input: { workspaceId: string; storyId: string; userId: string; role?: StoryAssignmentRole; actorUserId: string }): Promise<boolean> {
		const storyId = input.storyId.trim();
		const userId = input.userId.trim();
		// `role` null ⇒ remove every duty on the story; a role ⇒ just that one.
		const matches = (entry: StoryRoleAssignmentRecord) =>
			entry.workspaceId === input.workspaceId && entry.storyId === storyId && entry.userId === userId
			&& (input.role === undefined || entry.role === input.role);
		const before = this.storyAssignments.length;
		for (let i = this.storyAssignments.length - 1; i >= 0; i--) {
			if (matches(this.storyAssignments[i])) this.storyAssignments.splice(i, 1);
		}
		if (this.storyAssignments.length === before) return false;
		this.appendAudit({
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: "story_assignment_removed",
			entityType: "story_assignment",
			entityId: `${storyId}:${userId}`,
			metadata: { storyId, userId, role: input.role ?? null },
		});
		this.persist();
		return true;
	}

	async createInvite(): Promise<CreatedWorkspaceInvite> {
		// Inviting collaborators is a multi-tenant feature gated on the Postgres
		// store; the file-mode prototype is single-user by design.
		throw new WorkspaceAccessError("Workspace invites require the Postgres workspace store", 501, "workspace_invites_unavailable");
	}

	async getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInviteRecord | null> {
		const invite = this.invites.find((entry) => entry.workspaceId === workspaceId && entry.inviteId === inviteId);
		if (!invite) return null;
		const { tokenHash: _tokenHash, ...record } = invite;
		return { ...record };
	}

	async listInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]> {
		return this.invites.filter((entry) => entry.workspaceId === workspaceId).map(({ tokenHash: _tokenHash, ...record }) => ({ ...record }));
	}

	async listInvitePage(workspaceId: string): Promise<WorkspaceInvitePage> {
		return { invites: await this.listInvites(workspaceId), nextCursor: undefined };
	}

	async listAuditEventPage(workspaceId: string, options: WorkspaceAuditEventListOptions = {}): Promise<WorkspaceAuditEventPage> {
		let events = this.audit.filter((event) => event.workspaceId === workspaceId);
		if (options.action) events = events.filter((event) => event.action === options.action);
		if (options.entityType) events = events.filter((event) => event.entityType === options.entityType);
		if (options.actorUserId) events = events.filter((event) => event.actorUserId === options.actorUserId);
		// Apply the same created_at bounds the route validates and the Postgres store
		// enforces (inclusive, instant-aware), so a file-mode `?createdAfter=...` query
		// can't leak older events.
		if (options.createdAfter) {
			const after = Date.parse(options.createdAfter);
			if (!Number.isNaN(after)) events = events.filter((event) => Date.parse(event.createdAt) >= after);
		}
		if (options.createdBefore) {
			const before = Date.parse(options.createdBefore);
			if (!Number.isNaN(before)) events = events.filter((event) => Date.parse(event.createdAt) <= before);
		}
		// Order created_at DESC, audit_event_id DESC and bound by limit/cursor.
		events = events.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.auditEventId.localeCompare(a.auditEventId)).map((event) => ({ ...event }));
		const { page, nextCursor } = paginateFileWorkspaceRecords(
			events,
			options.limit,
			options.cursor,
			"auditEventId",
			(event) => event.createdAt,
			(event) => event.auditEventId,
		);
		return { events: page, nextCursor };
	}

	async recordAuditEvent(input: { workspaceId: string; actorUserId: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }): Promise<void> {
		this.appendAudit(input);
		this.persist();
	}

	/** Shared in-memory audit append. Callers that batch with another mutation
	 *  persist once themselves; recordAuditEvent persists for standalone use. */
	private appendAudit(input: { workspaceId: string; actorUserId: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }): void {
		this.audit.unshift({
			auditEventId: randomUUID(),
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: input.action,
			entityType: input.entityType,
			entityId: input.entityId,
			metadata: input.metadata ?? {},
			createdAt: new Date().toISOString(),
		});
	}

	async revokeInvite(): Promise<WorkspaceInviteRecord> {
		throw new WorkspaceAccessError("Workspace invite not found or cannot be revoked", 404, "workspace_invite_not_found");
	}

	async acceptInvite(): Promise<WorkspaceMemberRecord> {
		throw new WorkspaceAccessError("Workspace invites require the Postgres workspace store", 501, "workspace_invites_unavailable");
	}

	async erasePiiForUser(userId: string, originalEmail?: string): Promise<{ membershipsRemoved: number; invitesAnonymized: number }> {
		const normalized = userId.trim();
		if (!normalized) return { membershipsRemoved: 0, invitesAnonymized: 0 };
		const before = this.members.length;
		const keptMembers = this.members.filter((member) => member.userId !== normalized);
		const membershipsRemoved = before - keptMembers.length;
		if (membershipsRemoved > 0) {
			this.members.length = 0;
			this.members.push(...keptMembers);
		}
		// Series duties point at the erased user — drop them with the membership.
		const assignmentsBefore = this.storyAssignments.length;
		const keptAssignments = this.storyAssignments.filter((entry) => entry.userId !== normalized);
		const assignmentsRemoved = assignmentsBefore - keptAssignments.length;
		if (assignmentsRemoved > 0) {
			this.storyAssignments.length = 0;
			this.storyAssignments.push(...keptAssignments);
		}
		let invitesAnonymized = 0;
		const email = originalEmail?.trim();
		if (email) {
			const tombstone = `purged+${normalized}@redacted.invalid`;
			for (const invite of this.invites) {
				if (invite.email === email) {
					invite.email = tombstone;
					invitesAnonymized += 1;
				}
			}
		}
		if (membershipsRemoved > 0 || invitesAnonymized > 0 || assignmentsRemoved > 0) this.persist();
		return { membershipsRemoved, invitesAnonymized };
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<FileWorkspaceSnapshot>(this.persistPath);
			for (const workspace of snapshot.workspaces ?? []) {
				if (workspace?.workspaceId) this.workspaces.set(workspace.workspaceId, workspace);
			}
			for (const member of snapshot.members ?? []) {
				if (member?.workspaceId && member.userId) this.members.push({ ...member, scope: normalizeScope(member.scope) });
			}
			for (const invite of snapshot.invites ?? []) {
				if (invite?.inviteId) this.invites.push(invite);
			}
			for (const event of snapshot.audit ?? []) {
				if (event?.auditEventId) this.audit.push(event);
			}
			for (const assignment of snapshot.storyAssignments ?? []) {
				if (assignment?.workspaceId && assignment.storyId && assignment.userId && STORY_ASSIGNMENT_ROLES.includes(assignment.role)) {
					this.storyAssignments.push(assignment);
				}
			}
		} catch (error) {
			console.warn(`[FileWorkspaceAccessStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true });
			writeFileSync(this.persistPath, JSON.stringify({
				workspaces: Array.from(this.workspaces.values()),
				members: this.members,
				invites: this.invites,
				audit: this.audit,
				storyAssignments: this.storyAssignments,
			} satisfies FileWorkspaceSnapshot, null, 2));
		} catch (error) {
			console.warn(`[FileWorkspaceAccessStore] Failed to persist ${this.persistPath}: ${error}`);
		}
	}
}

export function createWorkspaceAccessStore(): WorkspaceAccessStore {
	const override = process.env.WORKSPACE_ACCESS_STORE?.trim().toLowerCase();
	const profileLoader = createPersonalWorkspaceProfileLoader();
	if (override === "file") return new FileWorkspaceAccessStore(join(DATA_DIR, "workspaces.json"), profileLoader);
	if (override === "postgres") return new PostgresWorkspaceAccessStore(undefined, profileLoader);
	// Default: Postgres when DATABASE_URL is set in a non-test runtime, otherwise
	// the JSON-file store so a local prototype run stays usable without Postgres
	// (no more 503 on every workspace route → the dashboard/library and the
	// create-chapter/add-image flow keep working).
	if (defaultDatabaseStoreMode() === "postgres") return new PostgresWorkspaceAccessStore(undefined, profileLoader);
	return new FileWorkspaceAccessStore(join(DATA_DIR, "workspaces.json"), profileLoader);
}

export const workspaceAccessStore = createWorkspaceAccessStore();

export function roleHasPermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

export function workspaceScopeAllows(scope: WorkspaceScope, check: WorkspaceScopeCheck): boolean {
	return scopeListAllows(scope.projectIds, check.projectId)
		&& scopeListAllows(scope.chapterIds, check.chapterId)
		&& scopeListAllows(scope.pageIndexes, check.pageIndex)
		&& scopeListAllows(scope.languages, check.language)
		&& scopeListAllows(scope.taskTypes, check.taskType)
		&& scopeListAllows(scope.assetPurposes, check.assetPurpose);
}

/**
 * True when `scope` carries ANY fine-grained restriction — `projectIds`,
 * `chapterIds`, `pageIndexes`, `languages`, `taskTypes`, or `assetPurposes`.
 *
 * A whole-project mutation (full `ProjectState` save / full version restore)
 * touches shared, non-language project state in addition to every language
 * track, so it must require TRULY project-wide access: a member with any such
 * restriction is NOT project-wide, even if their lists currently happen to cover
 * every track/resource. An unscoped owner/editor (no restriction) is project-wide
 * and passes. `aiCreditPolicy` is intentionally excluded — it gates AI spend, not
 * which project resources a member may write.
 */
export function isFineGrainedScope(scope: WorkspaceScope): boolean {
	return hasScopeList(scope.projectIds)
		|| hasScopeList(scope.chapterIds)
		|| hasScopeList(scope.pageIndexes)
		|| hasScopeList(scope.languages)
		|| hasScopeList(scope.taskTypes)
		|| hasScopeList(scope.assetPurposes);
}

// When a member is restricted to specific task types, a project-wide
// `update:project` access check is denied because `isFineGrainedProjectWideAccess`
// treats an undefined `taskType` as "asking for everything". Lock acquisition and
// workflow transitions act on the member's own assigned task, so we infer one of
// the member's allowed task types for the check. Any value from their own scope
// list satisfies `scopeListAllows`, so this never widens access beyond what the
// member already has — it only stops scoped contributors being rejected before
// they can touch their assigned work. Returns undefined when the member has no
// task-type restriction (the check is already project-wide-safe in that case).
export function inferScopedTaskType(scope: WorkspaceScope | undefined): string | undefined {
	const taskTypes = scope?.taskTypes;
	if (!Array.isArray(taskTypes) || taskTypes.length === 0) return undefined;
	for (const taskType of taskTypes) {
		if (typeof taskType === "string" && taskType.trim()) return taskType;
	}
	return undefined;
}

export function workspaceScopeAllowsNewProject(scope: WorkspaceScope, input: { language?: string } = {}): boolean {
	const normalized = normalizeScope(scope);
	return !hasScopeList(normalized.projectIds)
		&& !hasScopeList(normalized.chapterIds)
		&& !hasScopeList(normalized.pageIndexes)
		&& !hasScopeList(normalized.taskTypes)
		&& !hasScopeList(normalized.assetPurposes)
		&& scopeListAllows(normalized.languages, input.language);
}

export function workspaceScopeCovers(actorScope: WorkspaceScope, requestedScope: WorkspaceScope | undefined): boolean {
	const requested = normalizeScope(requestedScope);
	return scopeListCovers(actorScope.projectIds, requested.projectIds)
		&& scopeListCovers(actorScope.chapterIds, requested.chapterIds)
		&& scopeListCovers(actorScope.pageIndexes, requested.pageIndexes)
		&& scopeListCovers(actorScope.languages, requested.languages)
		&& scopeListCovers(actorScope.taskTypes, requested.taskTypes)
		&& scopeListCovers(actorScope.assetPurposes, requested.assetPurposes)
		&& aiCreditPolicyCovers(actorScope.aiCreditPolicy, requested.aiCreditPolicy);
}

export function filterWorkspaceScopeCoveredRecords<T extends { scope: WorkspaceScope }>(actorScope: WorkspaceScope, records: T[]): T[] {
	return records.filter((record) => workspaceScopeCovers(actorScope, record.scope));
}

export function createInviteToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function verifyInviteToken(token: string, expectedHash: string): boolean {
	const actual = Buffer.from(hashInviteToken(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

export function isValidWorkspacePageCursor(cursor: string | undefined, expectedKind?: WorkspaceCursorKind): boolean {
	if (!cursor?.trim()) return true;
	const decoded = decodeWorkspaceCursor(cursor, expectedKind);
	return decoded !== null;
}

const ROLE_PERMISSIONS: Record<WorkspaceRole, WorkspacePermission[]> = {
	owner: ["read_workspace", "update_workspace", "manage_members", "invite_members", "manage_projects", "read_project", "update_project", "generate_ai", "export_project"],
	admin: ["read_workspace", "update_workspace", "manage_members", "invite_members", "manage_projects", "read_project", "update_project", "generate_ai", "export_project"],
	// Editors WORK on chapters; they do not shape the catalog. manage_projects
	// (create/delete chapters + stories, language tracks, chapter-team manage,
	// workspace export presets) is deliberately owner/admin-only — a translator/
	// cleaner seat must not be able to add or remove เรื่อง/ตอน (product decision
	// 2026-06-13: structural changes belong to the workspace leads).
	editor: ["read_workspace", "read_project", "update_project", "generate_ai", "export_project"],
	// Viewers are FREE read-along seats (they do not consume a paid seat — see the
	// seat counter's `role <> 'viewer'` filter). They must NOT hold export_project:
	// a free no-seat role that can pull finished artifacts out would let one paid
	// member hand unlimited free export accounts to everyone else (product decision:
	// viewer = view-only, no export).
	viewer: ["read_workspace", "read_project"],
};

interface WorkspaceRow {
	workspace_id: string;
	name: string;
	plan_id: string;
	storage_included_bytes: number | string;
	storage_extra_bytes: number | string;
	created_at: Date | string;
	updated_at: Date | string;
	suspended_at?: Date | string | null;
	suspended_reason?: string | null;
	cursor_updated_at?: string;
}

interface UserWorkspaceRow extends WorkspaceRow {
	member_role: string;
	member_studio_role?: string | null;
	member_scope: unknown;
}

interface WorkspaceMemberRow {
	workspace_id: string;
	user_id: string;
	role: string;
	member_studio_role?: string | null;
	scope?: unknown;
	invited_by_user_id?: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	disabled_at?: Date | string | null;
	metadata?: unknown;
	cursor_updated_at?: string;
}

/** Parse the `finishedFrom` stash out of a member's metadata jsonb (defensive). */
function parseFinishedFrom(metadata: unknown): WorkspaceMemberFinishedFrom | undefined {
	let raw: unknown = metadata;
	if (typeof metadata === "string") {
		try { raw = JSON.parse(metadata); } catch { return undefined; }
	}
	if (!raw || typeof raw !== "object") return undefined;
	let finished: unknown = (raw as { finishedFrom?: unknown }).finishedFrom;
	// Tolerate a legacy double-encoded stash (a jsonb STRING rather than object).
	if (typeof finished === "string") {
		try { finished = JSON.parse(finished); } catch { return undefined; }
	}
	if (!finished || typeof finished !== "object") return undefined;
	const role = (finished as { role?: unknown }).role;
	if (typeof role !== "string") return undefined;
	const studio = (finished as { memberStudioRole?: unknown }).memberStudioRole;
	const finishedAt = (finished as { finishedAt?: unknown }).finishedAt;
	return {
		role: normalizeRole(role),
		memberStudioRole: typeof studio === "string" ? normalizeStudioRole(studio, normalizeRole(role)) : undefined,
		finishedAt: typeof finishedAt === "string" ? finishedAt : new Date(0).toISOString(),
	};
}

interface WorkspaceInviteRow {
	invite_id: string;
	workspace_id: string;
	email: string;
	role: string;
	scope?: unknown;
	status: WorkspaceInviteRecord["status"];
	invited_by_user_id: string;
	accepted_by_user_id?: string | null;
	expires_at: Date | string;
	accepted_at?: Date | string | null;
	revoked_at?: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
	cursor_created_at?: string;
}

interface WorkspaceAuditEventRow {
	audit_event_id: string;
	workspace_id?: string | null;
	project_id?: string | null;
	actor_user_id?: string | null;
	action: string;
	entity_type: string;
	entity_id: string;
	metadata?: unknown;
	created_at: Date | string;
	cursor_created_at?: string;
}

export type WorkspaceCursorKind = "workspaceId" | "userId" | "inviteId" | "auditEventId";

interface WorkspacePageCursor {
	kind: WorkspaceCursorKind;
	updatedAt: string;
	id: string;
}

function mapWorkspaceRow(row: WorkspaceRow): WorkspaceRecord {
	return {
		workspaceId: row.workspace_id,
		name: row.name,
		planId: row.plan_id,
		storageIncludedBytes: Number(row.storage_included_bytes),
		storageExtraBytes: Number(row.storage_extra_bytes),
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
		...(row.suspended_at ? { suspendedAt: toIsoString(row.suspended_at) } : {}),
		...(row.suspended_reason ? { suspendedReason: row.suspended_reason } : {}),
	};
}

function mapMemberRow(row: WorkspaceMemberRow): WorkspaceMemberRecord {
	const role = normalizeRole(row.role);
	return {
		workspaceId: row.workspace_id,
		userId: row.user_id,
		role,
		memberStudioRole: normalizeStudioRole(row.member_studio_role, role),
		scope: normalizeScope(row.scope),
		invitedByUserId: row.invited_by_user_id ?? undefined,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
		disabledAt: row.disabled_at ? toIsoString(row.disabled_at) : undefined,
		finishedFrom: parseFinishedFrom(row.metadata),
	};
}

interface StoryRoleAssignmentRow {
	workspace_id: string;
	story_id: string;
	user_id: string;
	role: string;
	assigned_by: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

function mapStoryAssignmentRow(row: StoryRoleAssignmentRow): StoryRoleAssignmentRecord {
	return {
		workspaceId: row.workspace_id,
		storyId: row.story_id,
		userId: row.user_id,
		// The CHECK constraint guarantees membership; fall back defensively anyway.
		role: STORY_ASSIGNMENT_ROLES.includes(row.role as StoryAssignmentRole) ? (row.role as StoryAssignmentRole) : "translator",
		assignedBy: row.assigned_by ?? undefined,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function normalizeStoryAssignmentStoryIds(storyIds: readonly string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawStoryId of storyIds) {
		const storyId = rawStoryId.trim();
		if (!storyId || seen.has(storyId)) continue;
		seen.add(storyId);
		normalized.push(storyId);
	}
	return normalized;
}

function mapInviteRow(row: WorkspaceInviteRow): WorkspaceInviteRecord {
	return {
		inviteId: row.invite_id,
		workspaceId: row.workspace_id,
		email: row.email,
		role: normalizeRole(row.role),
		scope: normalizeScope(row.scope),
		status: row.status,
		invitedByUserId: row.invited_by_user_id,
		acceptedByUserId: row.accepted_by_user_id ?? undefined,
		expiresAt: toIsoString(row.expires_at),
		acceptedAt: row.accepted_at ? toIsoString(row.accepted_at) : undefined,
		revokedAt: row.revoked_at ? toIsoString(row.revoked_at) : undefined,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function mapAuditEventRow(row: WorkspaceAuditEventRow): WorkspaceAuditEventRecord {
	return {
		auditEventId: row.audit_event_id,
		workspaceId: row.workspace_id ?? undefined,
		projectId: row.project_id ?? undefined,
		actorUserId: row.actor_user_id ?? undefined,
		action: row.action,
		entityType: row.entity_type,
		entityId: row.entity_id,
		metadata: normalizeRecord(row.metadata),
		createdAt: toIsoString(row.created_at),
	};
}

function normalizeRole(role: string): WorkspaceRole {
	if (role === "owner" || role === "admin" || role === "editor" || role === "viewer") return role;
	return "viewer";
}

function normalizeStudioRole(role: string | null | undefined, accessRole: WorkspaceRole = "viewer"): WorkspaceStudioRole {
	if (
		role === "owner"
		|| role === "admin"
		|| role === "team_lead"
		|| role === "translator"
		|| role === "cleaner"
		|| role === "typesetter"
		|| role === "qc"
		|| role === "guest"
	) return role;
	return defaultStudioRoleForAccessRole(accessRole);
}

function defaultStudioRoleForAccessRole(role: WorkspaceRole): WorkspaceStudioRole {
	if (role === "owner") return "owner";
	if (role === "admin") return "admin";
	if (role === "editor") return "typesetter";
	return "guest";
}

export function normalizeScope(value: unknown): WorkspaceScope {
	const raw = normalizeRecord(value);
	return {
		projectIds: readStringArray(raw.projectIds),
		chapterIds: readStringArray(raw.chapterIds),
		pageIndexes: readNumberArray(raw.pageIndexes),
		languages: readStringArray(raw.languages),
		taskTypes: readStringArray(raw.taskTypes),
		assetPurposes: readStringArray(raw.assetPurposes),
		aiCreditPolicy: raw.aiCreditPolicy === "job_scoped" || raw.aiCreditPolicy === "none" ? raw.aiCreditPolicy : raw.aiCreditPolicy === "workspace" ? "workspace" : undefined,
	};
}

function normalizeRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			return normalizeRecord(JSON.parse(value));
		} catch {
			return {};
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return items.length > 0 ? Array.from(new Set(items.map((item) => item.trim()))) : undefined;
}

function readNumberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((item) => typeof item === "number" ? item : typeof item === "string" ? Number(item) : Number.NaN)
		.filter((item) => Number.isInteger(item) && item >= 0);
	return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function scopeListAllows<T extends string | number>(allowed: T[] | undefined, requested: T | undefined): boolean {
	if (!allowed || allowed.length === 0 || requested === undefined) return true;
	return allowed.includes(requested);
}

function scopeListCovers<T extends string | number>(allowed: T[] | undefined, requested: T[] | undefined): boolean {
	if (!allowed || allowed.length === 0) return true;
	if (!requested || requested.length === 0) return false;
	return requested.every((item) => allowed.includes(item));
}

function hasScopeList(value: unknown[] | undefined): boolean {
	return Array.isArray(value) && value.length > 0;
}

function aiCreditPolicyCovers(actorPolicy: WorkspaceScope["aiCreditPolicy"], requestedPolicy: WorkspaceScope["aiCreditPolicy"]): boolean {
	// An absent policy is unrestricted (owner/admin) and covers everything. A "workspace"
	// policy is the broadest explicit credit grant — it likewise covers any requested
	// policy, INCLUDING an absent one. This ordering matters: the Team Lead marker scope
	// `{ aiCreditPolicy: "workspace" }` must cover an unrestricted (`{}`/undefined) owner or
	// admin so a Team Lead retains full member/invite/workspace-management reach. Checking
	// "workspace" before the `!requestedPolicy` short-circuit is what makes that hold.
	if (!actorPolicy) return true;
	if (actorPolicy === "workspace") return true;
	if (!requestedPolicy) return false;
	if (actorPolicy === "job_scoped") return requestedPolicy === "job_scoped" || requestedPolicy === "none";
	return requestedPolicy === "none";
}

function appendScopeCoverConditions(
	conditions: string[],
	params: unknown[],
	actorScope: WorkspaceScope | undefined,
	column: "scope",
): void {
	const scope = normalizeScope(actorScope);
	appendScopeArrayCoverCondition(conditions, params, column, "projectIds", scope.projectIds);
	appendScopeArrayCoverCondition(conditions, params, column, "chapterIds", scope.chapterIds);
	appendScopeArrayCoverCondition(conditions, params, column, "pageIndexes", scope.pageIndexes);
	appendScopeArrayCoverCondition(conditions, params, column, "languages", scope.languages);
	appendScopeArrayCoverCondition(conditions, params, column, "taskTypes", scope.taskTypes);
	appendScopeArrayCoverCondition(conditions, params, column, "assetPurposes", scope.assetPurposes);
	appendAiCreditPolicyCoverCondition(conditions, params, column, scope.aiCreditPolicy);
}

function appendScopeArrayCoverCondition<T extends string | number>(
	conditions: string[],
	params: unknown[],
	column: "scope",
	key: keyof Pick<WorkspaceScope, "projectIds" | "chapterIds" | "pageIndexes" | "languages" | "taskTypes" | "assetPurposes">,
	values: T[] | undefined,
): void {
	if (!values || values.length === 0) return;
	params.push(JSON.stringify(values));
	// ::text::jsonb — the bound value is a JSON.stringify'd array; a bare ::jsonb
	// bind under Bun.SQL compares a jsonb STRING scalar, so the <@ containment
	// silently never matches (the scope-cover filter returns nothing).
	conditions.push(`(${column} ? '${key}' AND (${column}->'${key}') <@ $${params.length}::text::jsonb)`);
}

function appendAiCreditPolicyCoverCondition(
	conditions: string[],
	params: unknown[],
	column: "scope",
	actorPolicy: WorkspaceScope["aiCreditPolicy"],
): void {
	// Mirror aiCreditPolicyCovers(): an absent actor policy is unrestricted, and a
	// "workspace" actor policy is the broadest explicit grant — both cover rows that have
	// NO aiCreditPolicy key at all (unrestricted owners/admins). Only narrower actor
	// policies (job_scoped/none) need the target row to carry a covered aiCreditPolicy,
	// so they alone require the key to be present.
	if (!actorPolicy || actorPolicy === "workspace") return;
	const allowedPolicies = actorPolicy === "job_scoped"
		? ["job_scoped", "none"]
		: ["none"];
	const placeholders = allowedPolicies.map((policy) => {
		params.push(policy);
		return `$${params.length}`;
	}).join(", ");
	conditions.push(`(${column} ? 'aiCreditPolicy' AND ${column}->>'aiCreditPolicy' IN (${placeholders}))`);
}

function normalizeInviteTtl(ttlSeconds: number | undefined): number {
	if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) return 7 * 24 * 60 * 60;
	return Math.max(300, Math.min(30 * 24 * 60 * 60, Math.trunc(ttlSeconds)));
}

function requireRow<T>(rows: T[], label: string): T {
	const row = rows[0];
	if (!row) throw new WorkspaceAccessError(`${label} not found`, 404, `${label.replaceAll(" ", "_")}_not_found`);
	return row;
}

const DEFAULT_PERSONAL_WORKSPACE_NAME = "My Workspace";
type PersonalWorkspaceLocale = "th" | "en" | "id" | "ms";
const PERSONAL_WORKSPACE_LOCALES: ReadonlySet<PersonalWorkspaceLocale> = new Set(["th", "en", "id", "ms"]);

function normalizePersonalWorkspaceLocale(value: string | null | undefined): PersonalWorkspaceLocale {
	const primary = value?.trim().toLowerCase().split("-")[0];
	return PERSONAL_WORKSPACE_LOCALES.has(primary as PersonalWorkspaceLocale) ? primary as PersonalWorkspaceLocale : "en";
}

function buildPersonalWorkspaceName(profile: PersonalWorkspaceOwnerProfile | null | undefined): string {
	const ownerName = profile?.name?.trim();
	// Keep the historical fallback when the auth profile is missing or incomplete so
	// first-run workspace provisioning never fails just because profile lookup did.
	if (!ownerName) return DEFAULT_PERSONAL_WORKSPACE_NAME;
	switch (normalizePersonalWorkspaceLocale(profile?.locale)) {
		case "th":
			return `บ้านของ ${ownerName}`;
		case "id":
		case "ms":
			return `Workspace ${ownerName}`;
		case "en":
		default:
			return `${ownerName}'s Workspace`;
	}
}

async function loadPersonalWorkspaceOwnerProfileFromAuthUsers(
	client: WorkspaceAccessSqlClient,
	userId: string,
): Promise<PersonalWorkspaceOwnerProfile | null> {
	try {
		const rows = await client.unsafe<PersonalWorkspaceOwnerProfile>(`
			SELECT name, locale
			FROM auth_users
			WHERE user_id = $1
			LIMIT 1
		`, [userId]);
		return rows[0] ?? null;
	} catch {
		try {
			const rows = await client.unsafe<PersonalWorkspaceOwnerProfile>(`
				SELECT name, NULL::text AS locale
				FROM auth_users
				WHERE user_id = $1
				LIMIT 1
			`, [userId]);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}
}

function createPersonalWorkspaceProfileLoader(): PersonalWorkspaceProfileLoader {
	return {
		async load(userId: string): Promise<PersonalWorkspaceOwnerProfile | null> {
			try {
				const { authUserStore } = await import("./auth-users.js");
				const user = await authUserStore.load(userId);
				return user ? { name: user.name, ...(user.locale ? { locale: user.locale } : {}) } : null;
			} catch {
				return null;
			}
		},
	};
}

async function recordWorkspaceAudit(client: WorkspaceAccessSqlClient, input: {
	workspaceId: string;
	actorUserId: string;
	action: string;
	entityType: string;
	entityId: string;
	metadata: Record<string, unknown>;
}): Promise<void> {
	await client.unsafe(`
		INSERT INTO audit_events (audit_event_id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
	`, [
		randomUUID(),
		input.workspaceId,
		input.actorUserId,
		input.action,
		input.entityType,
		input.entityId,
		input.metadata,
	]);
}

function toIsoString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : String(value);
}

// Escape LIKE wildcards so a user-supplied search term matches literally (a `%`
// or `_` in the search box is data, not a pattern). Paired with `ESCAPE '\\'`.
function escapeWorkspaceLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function getCursorTimestamp(row: { updated_at?: Date | string; created_at?: Date | string; cursor_updated_at?: string; cursor_created_at?: string }, field: "updated" | "created"): string {
	const cursorValue = field === "updated" ? row.cursor_updated_at : row.cursor_created_at;
	if (cursorValue?.trim()) return cursorValue;
	const value = field === "updated" ? row.updated_at : row.created_at;
	if (value === undefined) return new Date(0).toISOString();
	return toIsoString(value);
}

function normalizeWorkspacePageLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit) || !limit || limit <= 0) return 100;
	return Math.min(Math.trunc(limit), 500);
}

function encodeWorkspaceCursor(kind: WorkspaceCursorKind, updatedAt: string, id: string): string {
	return Buffer.from(JSON.stringify({ kind, updatedAt, id }), "utf8").toString("base64url");
}

function decodeWorkspaceCursor(cursor: string | undefined, expectedKind?: WorkspaceCursorKind): WorkspacePageCursor | null {
	if (!cursor?.trim()) return null;
	if (cursor.length > 700) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<WorkspacePageCursor>;
		if (decoded.kind !== "workspaceId" && decoded.kind !== "userId" && decoded.kind !== "inviteId" && decoded.kind !== "auditEventId") return null;
		if (expectedKind && decoded.kind !== expectedKind) return null;
		if (typeof decoded.updatedAt !== "string" || Number.isNaN(new Date(decoded.updatedAt).getTime())) return null;
		if (typeof decoded.id !== "string" || !decoded.id.trim()) return null;
		return {
			kind: decoded.kind,
			updatedAt: decoded.updatedAt,
			id: decoded.id,
		};
	} catch {
		return null;
	}
}

// Keyset-paginate an already-sorted (DESC by sortValue, then id) record list for
// the file-mode store so it honours the SAME limit/cursor contract the Postgres
// store enforces. `sortValueOf` returns the timestamp the ORDER BY uses
// (updated_at / created_at) and `idOf` the tiebreaker id. A cursor names the last
// row of the previous page; we keep only rows strictly "older" than it under the
// (timestamp DESC, id DESC) ordering, take `limit`, and emit a nextCursor when
// more rows remain — mirroring the LIMIT+1 lookahead in the SQL paths.
function paginateFileWorkspaceRecords<T>(
	sorted: T[],
	limit: number | undefined,
	cursor: string | undefined,
	kind: WorkspaceCursorKind,
	sortValueOf: (record: T) => string,
	idOf: (record: T) => string,
): { page: T[]; nextCursor?: string } {
	const pageLimit = normalizeWorkspacePageLimit(limit);
	const decoded = decodeWorkspaceCursor(cursor, kind);
	let rows = sorted;
	if (decoded) {
		rows = sorted.filter((record) => {
			const sortValue = sortValueOf(record);
			if (sortValue < decoded.updatedAt) return true;
			if (sortValue > decoded.updatedAt) return false;
			return idOf(record) < decoded.id;
		});
	}
	const page = rows.slice(0, pageLimit);
	const last = page[page.length - 1];
	const nextCursor = rows.length > pageLimit && last
		? encodeWorkspaceCursor(kind, sortValueOf(last), idOf(last))
		: undefined;
	return { page, nextCursor };
}
