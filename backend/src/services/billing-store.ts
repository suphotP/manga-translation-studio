// Internal DB-backed workspace billing store.
//
// The billing CATALOG (plan + add-on definitions) lives in `plans.ts`. This
// store owns plan ASSIGNMENT and active add-on grants per workspace, persisting
// them so quota math (project-catalog storage plan, AI queue caps) can read a
// real workspace→plan mapping instead of the hardcoded WORKSPACE_PLAN_ID env.
//
// This is INTERNAL persistence only — no payment provider, no checkout. It
// mirrors the existing `file | postgres` store-selection pattern used by
// upload-audit / project-catalog: an in-memory + JSON file store for local and
// test runtimes, and a Postgres store (writing the migration 0006 billing
// tables) when DATABASE_URL + the toggle are set.

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { readJsonFile } from "../utils/json-file.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";
import type { ProjectState } from "../types/index.js";
import {
	WORKSPACE_PLANS,
	normalizeWorkspacePlanId,
	resolveWorkspacePlan,
	type WorkspacePlan,
	type WorkspacePlanId,
} from "./plans.js";

/** Lifecycle of a workspace billing account. Mirrors the 0006 CHECK. */
export type WorkspaceBillingStatus = "mock_active" | "trialing" | "active" | "past_due" | "cancelled";

/** Statuses that count as an in-effect plan assignment for quota reads. */
export const ACTIVE_BILLING_STATUSES: readonly WorkspaceBillingStatus[] = ["mock_active", "trialing", "active"];

/** The default plan a workspace falls back to when nothing is assigned. */
export const DEFAULT_WORKSPACE_PLAN_ID: WorkspacePlanId = "free";

// ── Dunning access-time gate (P1: money-critical) ────────────────────────────
// The Dodo webhook dunning path keeps a failed-renewal account `active` only until
// a `dunning_grace_until` deadline, then RELIES on a later (post-deadline) webhook
// to flip it to past_due. If Dodo sends no such event, the status stays `active`
// forever and paid access never ends. So plan resolution ALSO checks the deadline
// at access time: an `active` account whose `dunning_grace_until` is in the PAST is
// treated as NOT in-effect (downgraded to the default/free plan), independent of any
// sweeper. Fails closed only on a real, parseable, past deadline — a missing/garbage/
// future value never downgrades a healthy paid account.
export function isDunningGraceExpired(
	metadata: Record<string, unknown> | undefined,
	now: Date = new Date(),
): boolean {
	if (!metadata) return false;
	const raw = metadata.dunning_grace_until;
	if (typeof raw !== "string" || !raw.trim()) return false;
	const deadline = Date.parse(raw);
	if (Number.isNaN(deadline)) return false;
	return deadline <= now.getTime();
}

/**
 * SQL fragment — the access-time DUNNING-GRACE gate for a `workspace_billing_accounts`
 * row, in Postgres. The SINGLE source of truth so every plan/quota/storage read path
 * (project-catalog getProjectWorkspacePlan / getProjectWorkspaceStoragePlan, usage-ledger
 * resolveWorkspaceUsagePlanConfig) shares ONE grace check and cannot drift — the exact SQL
 * mirror of {@link isDunningGraceExpired}.
 *
 * Evaluates TRUE (the row is still in-effect) UNLESS the metadata carries a parseable,
 * already-PAST `dunning_grace_until` deadline. Fails OPEN exactly like the JS predicate:
 * a missing/empty/garbage value never downgrades a healthy paid account (the `~` regex
 * gate ensures only an ISO-shaped value is cast, so a malformed value can never raise a
 * cast error nor be read as expired). Pass the table alias the query uses for the
 * `workspace_billing_accounts` row.
 *
 * MONEY-CRITICAL (P1): without this, an `active` account whose grace deadline lapsed (and
 * for which no later past_due webhook ever arrived) keeps paid plan/storage/AI access
 * forever. AND this into the active-status join condition so a grace-expired account
 * resolves to FREE on every read path.
 */
export function dunningGraceActiveSql(alias = "workspace_billing_accounts"): string {
	return `NOT (
		COALESCE(${alias}.metadata->>'dunning_grace_until', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
		AND (${alias}.metadata->>'dunning_grace_until')::timestamptz <= now()
	)`;
}

export interface WorkspaceBillingAssignment {
	workspaceId: string;
	planId: WorkspacePlanId;
	status: WorkspaceBillingStatus;
	billingEmail?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * Provider metadata blob (Postgres `metadata` jsonb). Carries dunning state
	 * (`dunning_grace_until`) written by the Dodo webhook path. Read at access time
	 * by {@link resolveWorkspacePlan} so an `active` account whose dunning grace has
	 * already lapsed is treated as past_due (paid access does NOT continue forever
	 * when no post-deadline webhook arrives). Undefined in file mode.
	 */
	metadata?: Record<string, unknown>;
}

/** A resolved plan assignment that always has a plan, falling back to default. */
export interface ResolvedWorkspacePlan {
	workspaceId: string;
	planId: WorkspacePlanId;
	status: WorkspaceBillingStatus | null;
	assigned: boolean;
}

export interface WorkspaceAddonGrant {
	grantId: string;
	workspaceId: string;
	addonId: string;
	quantity: number;
	aiCredits: number;
	storageBytes: number;
	seats: number;
	teamJobs: number;
	status: "active" | "expired" | "revoked";
	source: string;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SetWorkspacePlanInput {
	workspaceId: string;
	planId: WorkspacePlanId;
	status?: WorkspaceBillingStatus;
	billingEmail?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: string;
}

/**
 * One row of the admin workspace browser. Combines the billing assignment with
 * the joined workspace record (name + createdAt), with the same fallbacks the
 * admin route historically applied: `name`/`createdAt` fall back to the
 * assignment when the workspace row is missing.
 */
export interface AdminWorkspaceAccountRow {
	workspaceId: string;
	name: string;
	planId: WorkspacePlanId;
	/**
	 * Billing status, or "unassigned" when the workspace exists in the registry but
	 * has no billing assignment (file-mode/self-host, where billing may be empty or
	 * a separate source of truth). A missing assignment must NOT hide a real
	 * workspace — the admin list shows it with the default plan + "unassigned".
	 */
	status: WorkspaceBillingStatus | "unassigned";
	billingEmail: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Filter + keyset-pagination options for {@link BillingStore.listWorkspaceAccounts}.
 * Filters are pushed into SQL so the admin browser never materializes the whole
 * `workspace_billing_accounts` table. `search` matches name/workspaceId/billingEmail
 * (case-insensitive substring); `cursor` is an opaque keyset token from a prior page.
 */
export interface ListWorkspaceAccountsOptions {
	search?: string;
	plan?: string;
	status?: string;
	limit?: number;
	cursor?: string;
}

export interface AdminWorkspaceAccountPage {
	workspaces: AdminWorkspaceAccountRow[];
	nextCursor?: string;
	/**
	 * Total number of rows matching the same filters (search/plan/status),
	 * ignoring the cursor/limit window. Lets the admin header show an honest
	 * count instead of the page length. Computed as ONE bounded COUNT(*) over the
	 * filtered set (Postgres) or the filtered-array length (file mode) — never a
	 * per-row query.
	 */
	total: number;
}

/** Default page size for the admin workspace browser. */
export const ADMIN_WORKSPACES_DEFAULT_LIMIT = 50;
/** Hard ceiling so a caller cannot request an unbounded page. */
export const ADMIN_WORKSPACES_MAX_LIMIT = 200;

export interface BillingStore {
	/** Persist (insert or update) a workspace's assigned plan. */
	setWorkspacePlan(input: SetWorkspacePlanInput): Promise<WorkspaceBillingAssignment>;
	/** Raw assignment for a workspace, or null when none has been persisted. */
	getWorkspaceAssignment(workspaceId: string): Promise<WorkspaceBillingAssignment | null>;
	/** Effective plan for a workspace, falling back to the default plan. */
	resolveWorkspacePlan(workspaceId: string): Promise<ResolvedWorkspacePlan>;
	/** All persisted assignments (newest first). Internal admin/list use. */
	listAssignments(): Promise<WorkspaceBillingAssignment[]>;
	/**
	 * Paginated admin workspace browser. Joins billing assignment → workspace in
	 * ONE query (no per-row getWorkspace N+1), pushes plan/status/search filters
	 * into SQL, and keyset-paginates on (updated_at DESC, workspace_id ASC).
	 */
	listWorkspaceAccounts(options?: ListWorkspaceAccountsOptions): Promise<AdminWorkspaceAccountPage>;
	/** Active, unexpired add-on grants for a workspace (newest first). */
	listActiveGrants(workspaceId: string): Promise<WorkspaceAddonGrant[]>;
}

interface BillingSnapshot {
	assignments: WorkspaceBillingAssignment[];
	grants: WorkspaceAddonGrant[];
}

interface BillingSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

function normalizeStatus(status: string | undefined, fallback: WorkspaceBillingStatus = "mock_active"): WorkspaceBillingStatus {
	const normalized = status?.trim().toLowerCase();
	return normalized && (ACTIVE_BILLING_STATUSES as readonly string[]).concat("past_due", "cancelled").includes(normalized)
		? (normalized as WorkspaceBillingStatus)
		: fallback;
}

function requirePlanId(planId: string): WorkspacePlanId {
	const normalized = normalizeWorkspacePlanId(planId);
	if (!normalized) {
		throw new BillingStoreError(`Unknown workspace plan '${planId}'`, "billing_unknown_plan");
	}
	return normalized;
}

export class BillingStoreError extends Error {
	constructor(message: string, readonly code = "billing_store_error") {
		super(message);
		this.name = "BillingStoreError";
	}
}

/**
 * In-memory billing store with optional JSON persistence. Used for local
 * prototype + test runtimes where there is no Postgres. Writes are atomic:
 * a failed persist rolls back the in-memory mutation.
 */
export class FileBillingStore implements BillingStore {
	private readonly assignments = new Map<string, WorkspaceBillingAssignment>();
	private readonly grants: WorkspaceAddonGrant[] = [];

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async setWorkspacePlan(input: SetWorkspacePlanInput): Promise<WorkspaceBillingAssignment> {
		const workspaceId = input.workspaceId.trim();
		if (!workspaceId) {
			throw new BillingStoreError("workspaceId is required", "billing_invalid_workspace");
		}
		const planId = requirePlanId(input.planId);
		const previous = this.assignments.get(workspaceId);
		const now = new Date().toISOString();
		const assignment: WorkspaceBillingAssignment = {
			workspaceId,
			planId,
			status: normalizeStatus(input.status, previous?.status ?? "mock_active"),
			billingEmail: input.billingEmail?.trim() || previous?.billingEmail,
			currentPeriodStart: input.currentPeriodStart ?? previous?.currentPeriodStart,
			currentPeriodEnd: input.currentPeriodEnd ?? previous?.currentPeriodEnd,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		};
		this.assignments.set(workspaceId, assignment);
		try {
			this.persist();
		} catch (error) {
			if (previous) {
				this.assignments.set(workspaceId, previous);
			} else {
				this.assignments.delete(workspaceId);
			}
			throw error;
		}
		return assignment;
	}

	async getWorkspaceAssignment(workspaceId: string): Promise<WorkspaceBillingAssignment | null> {
		const normalized = workspaceId.trim();
		if (!normalized) return null;
		const assignment = this.assignments.get(normalized);
		return assignment ? { ...assignment } : null;
	}

	async resolveWorkspacePlan(workspaceId: string): Promise<ResolvedWorkspacePlan> {
		const normalized = workspaceId.trim();
		const assignment = normalized ? this.assignments.get(normalized) : undefined;
		if (assignment
			&& ACTIVE_BILLING_STATUSES.includes(assignment.status)
			&& !isDunningGraceExpired(assignment.metadata)) {
			return {
				workspaceId: normalized,
				planId: assignment.planId,
				status: assignment.status,
				assigned: true,
			};
		}
		// An active account whose dunning grace lapsed is reported as past_due even
		// though the stored row still says active (access-time downgrade).
		const effectiveStatus = assignment
			? (isDunningGraceExpired(assignment.metadata) ? "past_due" : assignment.status)
			: null;
		return {
			workspaceId: normalized,
			planId: DEFAULT_WORKSPACE_PLAN_ID,
			status: effectiveStatus,
			assigned: false,
		};
	}

	async listAssignments(): Promise<WorkspaceBillingAssignment[]> {
		return [...this.assignments.values()]
			.map((assignment) => ({ ...assignment }))
			.sort(compareByUpdatedAtDesc);
	}

	async listWorkspaceAccounts(options: ListWorkspaceAccountsOptions = {}): Promise<AdminWorkspaceAccountPage> {
		const limit = normalizeAdminWorkspacesLimit(options.limit);
		const filters = {
			search: options.search?.trim().toLowerCase() || undefined,
			plan: options.plan?.trim() || undefined,
			status: options.status?.trim() || undefined,
		};
		const cursor = decodeAdminWorkspacesCursor(options.cursor);
		// File mode has no workspaces table to join, so name/createdAt fall back to
		// the assignment exactly like the historical admin route did when the access
		// store had no record. The admin route enriches the bounded page with real
		// names from the file access store (≤ limit lookups, never the whole table).
		const filtered = [...this.assignments.values()]
			.map((assignment): AdminWorkspaceAccountRow => ({
				workspaceId: assignment.workspaceId,
				name: assignment.workspaceId,
				planId: assignment.planId,
				status: assignment.status,
				billingEmail: assignment.billingEmail ?? null,
				createdAt: assignment.createdAt,
				updatedAt: assignment.updatedAt,
			}))
			.filter((row) => adminRowMatchesFilters(row, filters))
			.sort(compareAdminRowByUpdatedAtDesc);
		// `filtered` is the FULL filtered set (no cursor/limit applied), so its length
		// is the honest total for the header. Compute it before the cursor window so
		// paging does not shrink the reported count.
		const total = filtered.length;
		const rows = filtered.filter((row) => {
			if (!cursor) return true;
			// Strictly after the cursor under (updated_at DESC, workspace_id ASC).
			if (row.updatedAt < cursor.updatedAt) return true;
			if (row.updatedAt > cursor.updatedAt) return false;
			return row.workspaceId > cursor.workspaceId;
		});
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		return {
			workspaces: page,
			nextCursor: rows.length > limit && last ? encodeAdminWorkspacesCursor({ updatedAt: last.updatedAt, workspaceId: last.workspaceId }) : undefined,
			total,
		};
	}

	async listActiveGrants(workspaceId: string): Promise<WorkspaceAddonGrant[]> {
		const normalized = workspaceId.trim();
		if (!normalized) return [];
		const now = Date.now();
		return this.grants
			.filter((grant) => grant.workspaceId === normalized)
			.filter((grant) => grant.status === "active")
			.filter((grant) => !grant.expiresAt || new Date(grant.expiresAt).getTime() > now)
			.map((grant) => ({ ...grant }))
			.sort(compareByCreatedAtDesc);
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<Partial<BillingSnapshot>>(this.persistPath);
			if (Array.isArray(snapshot.assignments)) {
				for (const assignment of snapshot.assignments) {
					if (isAssignment(assignment)) {
						this.assignments.set(assignment.workspaceId, assignment);
					}
				}
			}
			if (Array.isArray(snapshot.grants)) {
				this.grants.push(...snapshot.grants.filter(isGrant));
			}
		} catch (error) {
			console.warn(`[BillingStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		const snapshot: BillingSnapshot = {
			assignments: [...this.assignments.values()],
			grants: this.grants,
		};
		writeFileAtomic(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

/**
 * Postgres-backed billing store. Reads and writes the migration 0006 billing
 * tables (`workspace_billing_accounts`, `workspace_addon_grants`). Plan
 * assignment is an UPSERT keyed on workspace_id; reads filter to in-effect
 * statuses so they line up with project-catalog's storage-plan join.
 */
export class PostgresBillingStore implements BillingStore {
	private readonly client: BillingSqlClient;

	constructor(databaseUrlOrClient: string | BillingSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new BillingStoreError("BILLING_STORE=postgres requires DATABASE_URL", "billing_store_unconfigured");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as BillingSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async setWorkspacePlan(input: SetWorkspacePlanInput): Promise<WorkspaceBillingAssignment> {
		const workspaceId = input.workspaceId.trim();
		if (!workspaceId) {
			throw new BillingStoreError("workspaceId is required", "billing_invalid_workspace");
		}
		const planId = requirePlanId(input.planId);
		// Only normalize a status the caller explicitly provided. Passing `null`
		// for an omitted status lets the UPSERT preserve the existing lifecycle
		// (active/trialing/past_due/cancelled) on a plan-only change, matching the
		// FileBillingStore. A missing existing row falls back to 'mock_active'.
		const status = input.status === undefined ? null : normalizeStatus(input.status);
		const rows = await this.client.unsafe<WorkspaceBillingRow>(`
			INSERT INTO workspace_billing_accounts (
				workspace_id,
				plan_id,
				status,
				billing_email,
				current_period_start,
				current_period_end,
				updated_at
			)
			VALUES ($1, $2, COALESCE($3, 'mock_active'), $4, $5, $6, now())
			ON CONFLICT (workspace_id) DO UPDATE SET
				plan_id = EXCLUDED.plan_id,
				status = COALESCE($3, workspace_billing_accounts.status, EXCLUDED.status),
				billing_email = COALESCE(EXCLUDED.billing_email, workspace_billing_accounts.billing_email),
				current_period_start = COALESCE(EXCLUDED.current_period_start, workspace_billing_accounts.current_period_start),
				current_period_end = COALESCE(EXCLUDED.current_period_end, workspace_billing_accounts.current_period_end),
				updated_at = now()
			RETURNING workspace_id, plan_id, status, billing_email, current_period_start, current_period_end, created_at, updated_at
		`, [
			workspaceId,
			planId,
			status,
			input.billingEmail?.trim() || null,
			input.currentPeriodStart ?? null,
			input.currentPeriodEnd ?? null,
		]);
		const row = rows[0];
		if (!row) {
			throw new BillingStoreError("Failed to persist workspace plan assignment", "billing_assignment_failed");
		}
		return mapBillingRow(row);
	}

	async getWorkspaceAssignment(workspaceId: string): Promise<WorkspaceBillingAssignment | null> {
		const normalized = workspaceId.trim();
		if (!normalized) return null;
		const rows = await this.client.unsafe<WorkspaceBillingRow>(`
			SELECT workspace_id, plan_id, status, billing_email, current_period_start, current_period_end, metadata, created_at, updated_at
			FROM workspace_billing_accounts
			WHERE workspace_id = $1
			LIMIT 1
		`, [normalized]);
		return rows[0] ? mapBillingRow(rows[0]) : null;
	}

	async resolveWorkspacePlan(workspaceId: string): Promise<ResolvedWorkspacePlan> {
		const assignment = await this.getWorkspaceAssignment(workspaceId);
		if (assignment
			&& ACTIVE_BILLING_STATUSES.includes(assignment.status)
			&& !isDunningGraceExpired(assignment.metadata)) {
			return {
				workspaceId: assignment.workspaceId,
				planId: assignment.planId,
				status: assignment.status,
				assigned: true,
			};
		}
		// An active account whose dunning grace lapsed is reported as past_due even
		// though the stored row still says active (access-time downgrade, no sweeper
		// required). See isDunningGraceExpired.
		const effectiveStatus = assignment
			? (isDunningGraceExpired(assignment.metadata) ? "past_due" : assignment.status)
			: null;
		return {
			workspaceId: workspaceId.trim(),
			planId: DEFAULT_WORKSPACE_PLAN_ID,
			status: effectiveStatus,
			assigned: false,
		};
	}

	async listAssignments(): Promise<WorkspaceBillingAssignment[]> {
		const rows = await this.client.unsafe<WorkspaceBillingRow>(`
			SELECT workspace_id, plan_id, status, billing_email, current_period_start, current_period_end, created_at, updated_at
			FROM workspace_billing_accounts
			ORDER BY updated_at DESC, workspace_id ASC
		`);
		return rows.map(mapBillingRow);
	}

	async listWorkspaceAccounts(options: ListWorkspaceAccountsOptions = {}): Promise<AdminWorkspaceAccountPage> {
		const limit = normalizeAdminWorkspacesLimit(options.limit);
		const search = options.search?.trim().toLowerCase();
		const plan = options.plan?.trim();
		const status = options.status?.trim();
		const cursor = decodeAdminWorkspacesCursor(options.cursor);

		// Filter conditions (plan/status/search) are shared between the page query
		// and the COUNT(*) so they stay in lockstep. The cursor + limit only apply to
		// the page query; the count is over the FULL filtered set so the admin header
		// shows an honest total rather than the page length.
		const filterConditions: string[] = [];
		const filterParams: unknown[] = [];
		if (plan) {
			filterParams.push(plan);
			filterConditions.push(`b.plan_id = $${filterParams.length}`);
		}
		if (status) {
			filterParams.push(status);
			filterConditions.push(`b.status = $${filterParams.length}`);
		}
		if (search) {
			filterParams.push(`%${escapeLikePattern(search)}%`);
			// COALESCE so a missing workspace row still matches on id/email; lower()
			// for case-insensitive substring, mirroring the JS `.toLowerCase().includes`.
			filterConditions.push(`lower(COALESCE(w.name, b.workspace_id) || ' ' || b.workspace_id || ' ' || COALESCE(b.billing_email, '')) LIKE $${filterParams.length} ESCAPE '\\'`);
		}
		const filterWhere = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";

		// ONE bounded COUNT(*) over the same filter (no cursor/limit). Only joins
		// workspaces when the search term needs the workspace name; plan/status-only
		// filters can count off the billing table alone, but the LEFT JOIN keeps the
		// row set identical and is cheap (PK lookup). This is one extra query per
		// page request — never per row.
		const countRows = await this.client.unsafe<{ total: string | number }>(`
			SELECT COUNT(*)::bigint AS total
			FROM workspace_billing_accounts b
			LEFT JOIN workspaces w ON w.workspace_id = b.workspace_id
			${filterWhere}
		`, filterParams);
		const total = Number(countRows[0]?.total ?? 0);

		// Page query: reuse the filter conditions, then append the keyset cursor +
		// LIMIT. join workspace_billing_accounts → workspaces (LEFT JOIN so a billing
		// row with no workspace record still appears, falling back to the workspace_id
		// for name and the billing created_at — matching the legacy route's
		// `workspace?.name ?? assignment.workspaceId` semantics). keyset on
		// (b.updated_at DESC, b.workspace_id ASC) is index-friendly and bounded by LIMIT.
		const conditions = [...filterConditions];
		const params = [...filterParams];
		if (cursor) {
			params.push(cursor.updatedAt);
			const updatedParam = params.length;
			params.push(cursor.workspaceId);
			const idParam = params.length;
			conditions.push(`(b.updated_at < $${updatedParam}::timestamptz OR (b.updated_at = $${updatedParam}::timestamptz AND b.workspace_id > $${idParam}))`);
		}
		params.push(limit + 1);
		const limitParam = params.length;
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = await this.client.unsafe<AdminWorkspaceAccountRowResult>(`
			SELECT
				b.workspace_id,
				COALESCE(w.name, b.workspace_id) AS name,
				b.plan_id,
				b.status,
				b.billing_email,
				COALESCE(w.created_at, b.created_at) AS created_at,
				b.updated_at,
				to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
			FROM workspace_billing_accounts b
			LEFT JOIN workspaces w ON w.workspace_id = b.workspace_id
			${whereClause}
			ORDER BY b.updated_at DESC, b.workspace_id ASC
			LIMIT $${limitParam}
		`, params);
		const pageRows = rows.slice(0, limit);
		const workspaces = pageRows.map(mapAdminWorkspaceRow);
		const lastRow = pageRows[pageRows.length - 1];
		return {
			workspaces,
			nextCursor: rows.length > limit && lastRow
				? encodeAdminWorkspacesCursor({ updatedAt: lastRow.cursor_updated_at, workspaceId: lastRow.workspace_id })
				: undefined,
			total,
		};
	}

	async listActiveGrants(workspaceId: string): Promise<WorkspaceAddonGrant[]> {
		const normalized = workspaceId.trim();
		if (!normalized) return [];
		const rows = await this.client.unsafe<WorkspaceAddonGrantRow>(`
			SELECT grant_id, workspace_id, addon_id, quantity, ai_credits, storage_bytes, seats, team_jobs, status, source, expires_at, created_at, updated_at
			FROM workspace_addon_grants
			WHERE workspace_id = $1
				AND status = 'active'
				AND (expires_at IS NULL OR expires_at > now())
			ORDER BY created_at DESC, grant_id ASC
		`, [normalized]);
		return rows.map(mapGrantRow);
	}
}

interface WorkspaceBillingRow {
	workspace_id: string;
	plan_id: string;
	status: string;
	billing_email?: string | null;
	current_period_start?: Date | string | null;
	current_period_end?: Date | string | null;
	metadata?: Record<string, unknown> | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface AdminWorkspaceAccountRowResult {
	workspace_id: string;
	name: string;
	plan_id: string;
	status: string;
	billing_email?: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	cursor_updated_at: string;
}

interface WorkspaceAddonGrantRow {
	grant_id: string;
	workspace_id: string;
	addon_id: string;
	quantity: number | string;
	ai_credits: number | string;
	storage_bytes: number | string;
	seats: number | string;
	team_jobs: number | string;
	status: string;
	source: string;
	expires_at?: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

function mapBillingRow(row: WorkspaceBillingRow): WorkspaceBillingAssignment {
	return {
		workspaceId: row.workspace_id,
		planId: normalizeWorkspacePlanId(row.plan_id) ?? DEFAULT_WORKSPACE_PLAN_ID,
		status: normalizeStatus(row.status),
		billingEmail: row.billing_email ?? undefined,
		currentPeriodStart: toIsoString(row.current_period_start),
		currentPeriodEnd: toIsoString(row.current_period_end),
		metadata: parseMetadata(row.metadata),
		createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
		updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
	};
}

// jsonb columns arrive as an object from the pg driver, but a string from some
// drivers / the test fakes. Tolerate both; never throw on a malformed blob.
function parseMetadata(raw: Record<string, unknown> | string | null | undefined): Record<string, unknown> | undefined {
	if (!raw) return undefined;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}
	return typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
}

function mapAdminWorkspaceRow(row: AdminWorkspaceAccountRowResult): AdminWorkspaceAccountRow {
	return {
		workspaceId: row.workspace_id,
		// name is already COALESCE(w.name, b.workspace_id) in SQL, so it is never null.
		name: row.name ?? row.workspace_id,
		planId: normalizeWorkspacePlanId(row.plan_id) ?? DEFAULT_WORKSPACE_PLAN_ID,
		status: normalizeStatus(row.status),
		billingEmail: row.billing_email ?? null,
		createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
		updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
	};
}

/** Escape LIKE wildcards so a user-supplied search term is matched literally. */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function mapGrantRow(row: WorkspaceAddonGrantRow): WorkspaceAddonGrant {
	const status = row.status === "expired" || row.status === "revoked" ? row.status : "active";
	return {
		grantId: row.grant_id,
		workspaceId: row.workspace_id,
		addonId: row.addon_id,
		quantity: Number(row.quantity) || 0,
		aiCredits: Number(row.ai_credits) || 0,
		storageBytes: Number(row.storage_bytes) || 0,
		seats: Number(row.seats) || 0,
		teamJobs: Number(row.team_jobs) || 0,
		status,
		source: row.source,
		expiresAt: toIsoString(row.expires_at),
		createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
		updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
	};
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text || undefined;
}

function compareByUpdatedAtDesc(a: WorkspaceBillingAssignment, b: WorkspaceBillingAssignment): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.workspaceId.localeCompare(b.workspaceId);
}

/** Same (updated_at DESC, workspace_id ASC) ordering applied to admin rows. */
function compareAdminRowByUpdatedAtDesc(a: AdminWorkspaceAccountRow, b: AdminWorkspaceAccountRow): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.workspaceId.localeCompare(b.workspaceId);
}

/** Clamp a caller-supplied page size into [1, MAX], defaulting when omitted. */
function normalizeAdminWorkspacesLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return ADMIN_WORKSPACES_DEFAULT_LIMIT;
	const floored = Math.floor(limit);
	if (floored < 1) return 1;
	return Math.min(floored, ADMIN_WORKSPACES_MAX_LIMIT);
}

interface AdminWorkspacesCursor {
	updatedAt: string;
	workspaceId: string;
}

/**
 * Opaque keyset cursor for the admin workspace browser. Encodes the last row's
 * (updated_at, workspace_id) so the next page resumes strictly after it under
 * the (updated_at DESC, workspace_id ASC) ordering. Base64url of a compact JSON
 * tuple — never exposes raw column values to the client.
 */
function encodeAdminWorkspacesCursor(cursor: AdminWorkspacesCursor): string {
	return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.workspaceId]), "utf8").toString("base64url");
}

function decodeAdminWorkspacesCursor(cursor: string | undefined): AdminWorkspacesCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 2) return null;
		const [updatedAt, workspaceId] = parsed;
		if (typeof updatedAt !== "string" || typeof workspaceId !== "string") return null;
		if (!updatedAt || !workspaceId) return null;
		return { updatedAt, workspaceId };
	} catch {
		return null;
	}
}

/** True when the admin row passes the (already-normalized) JS-side filters. */
function adminRowMatchesFilters(
	row: AdminWorkspaceAccountRow,
	filters: { search?: string; plan?: string; status?: string },
): boolean {
	if (filters.search && !`${row.name} ${row.workspaceId} ${row.billingEmail ?? ""}`.toLowerCase().includes(filters.search)) return false;
	if (filters.plan && row.planId !== filters.plan) return false;
	if (filters.status && row.status !== filters.status) return false;
	return true;
}

function compareByCreatedAtDesc(a: WorkspaceAddonGrant, b: WorkspaceAddonGrant): number {
	return b.createdAt.localeCompare(a.createdAt) || a.grantId.localeCompare(b.grantId);
}

function isAssignment(value: unknown): value is WorkspaceBillingAssignment {
	const assignment = value as Partial<WorkspaceBillingAssignment>;
	return Boolean(
		assignment
		&& typeof assignment.workspaceId === "string"
		&& typeof assignment.planId === "string"
		&& Boolean(WORKSPACE_PLANS[assignment.planId as WorkspacePlanId])
		&& typeof assignment.createdAt === "string"
		&& typeof assignment.updatedAt === "string",
	);
}

function isGrant(value: unknown): value is WorkspaceAddonGrant {
	const grant = value as Partial<WorkspaceAddonGrant>;
	return Boolean(
		grant
		&& typeof grant.grantId === "string"
		&& typeof grant.workspaceId === "string"
		&& typeof grant.addonId === "string"
		&& typeof grant.createdAt === "string",
	);
}

export function createBillingStore(): BillingStore {
	if (serverConfig.billingStore === "postgres") {
		return new PostgresBillingStore();
	}
	return new FileBillingStore(join(DATA_DIR, "billing-accounts.json"));
}

export const billingStore = createBillingStore();

/**
 * Resolve the full plan DEFINITION (from the plans.ts catalog) for a
 * workspace's persisted assignment, falling back to the default plan when the
 * workspace has no in-effect assignment. This is the bridge between persistent
 * plan ASSIGNMENT (this store) and the plan CATALOG (plans.ts).
 */
export async function resolveWorkspacePlanDefinition(
	workspaceId: string,
	store: BillingStore = billingStore,
): Promise<WorkspacePlan> {
	const resolved = await store.resolveWorkspacePlan(workspaceId);
	return resolveWorkspacePlan(resolved.planId);
}

/**
 * Read a project's workspace id from its file-mode `state.json`. Used only when
 * the Postgres project-catalog is not configured (BILLING_STORE/file prototype),
 * where there is no DB join from project → workspace → billing account.
 */
function readFileProjectWorkspaceId(projectId: string): string | undefined {
	const normalized = projectId.trim();
	if (!normalized) return undefined;
	// Tombstone-aware: a permanently-deleted project must not have its stale
	// state.json resurrected to re-derive a workspace plan / AI admission budget.
	const state = readProjectStateFileGuarded<Pick<ProjectState, "workspaceId">>(normalized);
	return state?.workspaceId?.trim() || undefined;
}

/**
 * Resolve the in-effect workspace plan id for a PROJECT, in-effect-status aware,
 * routed through the billing store so an assigned plan actually drives quota
 * and AI admission.
 *
 * Resolution order:
 *  1. The persisted billing-store assignment for the project's workspace. In
 *     file mode the workspace id is read from `state.json`; in Postgres the
 *     billing store joins `workspace_billing_accounts` directly.
 *  2. The `WORKSPACE_PLAN_ID` env fallback (legacy single-plan deployments).
 *  3. `undefined` — callers then fall back to the catalog default (free).
 *
 * NOTE: the Postgres production storage-quota / usage-ledger paths already read
 * the assigned plan via their own `workspace_billing_accounts` joins
 * (`project-catalog.getProjectWorkspaceStoragePlan`,
 * `PostgresUsageLedger.resolveWorkspaceUsagePlanConfig`), so this resolver is the
 * file-mode + AI-admission-env bridge. `workspaceId` is optional: pass it when a
 * caller already knows the workspace (file mode) to avoid re-reading state.json.
 */
export async function resolveWorkspacePlanIdForProject(
	projectId: string,
	options: { workspaceId?: string; store?: BillingStore } = {},
): Promise<WorkspacePlanId | undefined> {
	const store = options.store ?? billingStore;
	const workspaceId = options.workspaceId?.trim() || readFileProjectWorkspaceId(projectId);
	if (workspaceId) {
		const resolved = await store.resolveWorkspacePlan(workspaceId);
		if (resolved.assigned) return resolved.planId;
	}
	return normalizeWorkspacePlanId(process.env.WORKSPACE_PLAN_ID);
}
