// Workspace-level usage dashboard aggregation (READ-ONLY).
//
// Aggregates per-project usage/ledger, storage-quota, and egress data into a
// single workspace-wide view: AI credit spend, upload/export bytes, storage
// used vs quota, backend-served egress, plan limits, and a per-member
// breakdown.
//
// The existing usage ledger does NOT attribute events to individual actors, so
// spend cannot be split per member. We therefore expose the workspace roster
// (when a workspace access store is configured) but report all spend under a
// single `unattributed` bucket and flag `memberAttribution: "unattributed"`.
//
// This module only READS from usage-ledger, storage-quota, egress-accounting,
// plans, project-catalog, and workspace-access. It never mutates state.

import { readdirSync } from "fs";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { projectCatalogStore } from "./project-catalog.js";
import { resolveWorkspacePlan, type WorkspacePlan } from "./plans.js";
import {
	storageQuotaReservationStore,
	summarizeProjectStorageQuotaForBilling,
	type StorageQuotaReservation,
	type StorageQuotaSummary,
} from "./storage-quota.js";
import { summarizeProjectsEgress, type ProjectEgressSummary } from "./egress-accounting.js";
import {
	PostgresUsageLedger,
	usageLedger,
	WORKSPACE_EVENT_COUNT_CAP,
	type UsageWindowSummary,
	type WorkspaceUsageSummary,
} from "./usage-ledger.js";
import { workspaceAccessStore, type WorkspaceMemberRecord, type WorkspaceRecord, type WorkspaceRole, type WorkspaceScope } from "./workspace-access.js";
import { getResponseCache, type ResponseCache } from "./response-cache.js";
import type { ProjectState } from "../types/index.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";

// Short TTL for the workspace usage dashboard. Building it fans out several reads
// (usage summary incl. the bounded all-time event COUNT, storage quota, batched
// egress, reservations, roster) on every load, yet the data tolerates a few seconds
// of staleness — the windows it reports are day/month-grained. Override with
// USAGE_DASHBOARD_CACHE_TTL_SECONDS=0 to disable; capped so a typo can't pin stale
// data. Mirrors REVENUE_CACHE_TTL_SECONDS in routes/admin/revenue.ts.
const USAGE_DASHBOARD_CACHE_TTL_SECONDS = (() => {
	const raw = Number(process.env.USAGE_DASHBOARD_CACHE_TTL_SECONDS);
	if (!Number.isFinite(raw) || raw < 0) return 30;
	return Math.min(raw, 300);
})();

export interface WorkspaceUsageDashboardWindow {
	periodKey: string;
	aiCapturedThb: number;
	aiActiveReservedThb: number;
	aiCommittedThb: number;
	uploadBytes: number;
	exportBytes: number;
	moderationImages: number;
	limits: {
		aiCreditThb: number;
		uploadBytes: number;
		exportBytes: number;
	};
	remaining: {
		aiCreditThb: number | null;
		uploadBytes: number | null;
		exportBytes: number | null;
	};
}

export interface WorkspaceUsageDashboardStorage {
	usedBytes: number;
	originalBytes: number;
	derivativeBytes: number;
	exportArtifactBytes: number;
	reservedBytes: number;
	projectedBytes: number;
	limitBytes: number;
	includedBytes: number;
	extraBytes: number;
	remainingBytes: number;
	percentUsed: number;
	enforced: boolean;
}

export interface WorkspaceUsageDashboardEgress {
	windowMs: number;
	totalRequests: number;
	totalBytes: number;
	// Egress is enforced PER PROJECT, so these aggregate fields sum the
	// per-project limits and per-project remaining allowances. They are NOT a
	// single shared workspace allowance: a project at its limit does not reduce
	// what another project may still serve.
	limitBytes: number;
	remainingBytes: number;
	enforced: boolean;
	// True when any project's egress limit is enforced. Consumers must read the
	// per-project breakdown to know an individual project's real headroom.
	perProjectEnforced: boolean;
	projects: WorkspaceUsageDashboardEgressProject[];
}

export interface WorkspaceUsageDashboardEgressProject {
	projectId: string;
	totalRequests: number;
	totalBytes: number;
	limitBytes: number;
	remainingBytes: number;
	enforced: boolean;
}

export interface WorkspaceUsageDashboardMember {
	userId: string;
	role: WorkspaceRole;
	disabled: boolean;
	// Attribution is not available from the ledger today; spend is reported at
	// the workspace level under `unattributed`, so member figures are zeroed.
	aiCommittedThb: number;
	uploadBytes: number;
	exportBytes: number;
}

export interface WorkspaceUsageDashboardPlan {
	id: string;
	name: string;
	monthlyAiCredits: number;
	includedStorageBytes: number;
	maxSeatsIncluded: number;
}

export type WorkspaceUsageDashboardScope = "postgres" | "filesystem";

export interface WorkspaceUsageDashboard {
	workspaceId: string;
	scope: WorkspaceUsageDashboardScope;
	enforced: boolean;
	plan: WorkspaceUsageDashboardPlan;
	projectIds: string[];
	projectCount: number;
	totals: {
		daily: WorkspaceUsageDashboardWindow;
		monthly: WorkspaceUsageDashboardWindow;
		eventCount: number;
		// True iff `eventCount` hit the displayed cap (see WORKSPACE_EVENT_COUNT_CAP):
		// the value is a floor, so clients render "100000+" rather than an exact count.
		eventCountCapped: boolean;
	};
	storage: WorkspaceUsageDashboardStorage;
	egress: WorkspaceUsageDashboardEgress;
	memberAttribution: "unattributed";
	members: {
		count: number;
		breakdown: WorkspaceUsageDashboardMember[];
		// Spend that could not be attributed to an individual member (currently
		// all spend, because the ledger does not persist actor identity).
		unattributed: {
			aiCommittedThb: number;
			uploadBytes: number;
			exportBytes: number;
		};
	};
}

// Active storage reservations for the workspace, summed for inclusion in the
// storage view so concurrent uploads/exports are reflected in reserved/projected
// bytes (mirroring the enforced quota checks).
export interface WorkspaceUsageDashboardReservations {
	reservedBytes: number;
	activeReservationCount: number;
}

/**
 * Inputs for the pure aggregation step. The orchestration function below
 * gathers these read-only from the live singletons; tests can inject fakes.
 */
export interface WorkspaceUsageDashboardAggregationInput {
	workspaceId: string;
	scope: WorkspaceUsageDashboardScope;
	plan: WorkspacePlan;
	projectIds: string[];
	// In Postgres mode the ledger is workspace-keyed, so a single summary already
	// covers every project. In filesystem mode, events recorded with only a
	// projectId are keyed under that projectId, so the orchestrator reconciles
	// the workspace key and each project key into this combined summary before
	// aggregation (see `summarizeWorkspaceUsageTotals`).
	usage: WorkspaceUsageSummary | null;
	storage: StorageQuotaSummary | null;
	egressSummaries: ProjectEgressSummary[];
	members: WorkspaceMemberRecord[];
	// Active storage reservations for the workspace. The billing storage summary
	// path does not load reservations, so they are passed in here and merged into
	// reserved/projected/remaining bytes.
	reservations?: WorkspaceUsageDashboardReservations;
}

function emptyWindow(periodKey: string): WorkspaceUsageDashboardWindow {
	return {
		periodKey,
		aiCapturedThb: 0,
		aiActiveReservedThb: 0,
		aiCommittedThb: 0,
		uploadBytes: 0,
		exportBytes: 0,
		moderationImages: 0,
		limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
		remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
	};
}

// Map a workspace-level ledger window onto the dashboard window shape. The
// ledger already computes correct totals, limits, and remaining for the whole
// workspace, so we pass them through verbatim.
function windowView(periodKey: string, source: UsageWindowSummary | undefined): WorkspaceUsageDashboardWindow {
	if (!source) return emptyWindow(periodKey);
	return {
		periodKey: source.periodKey,
		aiCapturedThb: source.aiCapturedThb,
		aiActiveReservedThb: source.aiActiveReservedThb,
		aiCommittedThb: source.aiCommittedThb,
		uploadBytes: source.uploadBytes,
		exportBytes: source.exportBytes,
		moderationImages: source.moderationImages,
		limits: { ...source.limits },
		remaining: { ...source.remaining },
	};
}

// Merge active storage reservations into the billing storage summary. The
// billing summary path does not load reservations, so on its own it reports
// `reservedBytes: 0` and overstates remaining during concurrent uploads/exports.
// We add the reservation bytes on top of the summary (the summary is computed
// with `reservedBytes: 0`, so there is no double-counting) and recompute
// projected/remaining/percentUsed exactly as storage-quota does.
function storageView(
	summary: StorageQuotaSummary | null,
	reservations?: WorkspaceUsageDashboardReservations,
	// Plan-resolved storage allowance, used as the limit fallback when there is no
	// project anchor yet (a brand-new workspace with zero projects produces a null
	// summary). Without it the sidebar/usage widgets render "0 B of 0 B" for a real
	// account that legitimately has an allowance — they just haven't uploaded yet.
	planIncludedBytes = 0,
): WorkspaceUsageDashboardStorage {
	const reservedBytes = Math.max(0, Math.round(reservations?.reservedBytes ?? 0));
	if (!summary) {
		const fallbackLimit = Math.max(0, Math.round(planIncludedBytes));
		const projectedBytes = reservedBytes;
		const percentUsed = fallbackLimit > 0
			? Math.min(999, Math.round((projectedBytes / fallbackLimit) * 10000) / 100)
			: 0;
		return {
			usedBytes: 0,
			originalBytes: 0,
			derivativeBytes: 0,
			exportArtifactBytes: 0,
			reservedBytes,
			projectedBytes,
			limitBytes: fallbackLimit,
			includedBytes: fallbackLimit,
			extraBytes: 0,
			remainingBytes: Math.max(0, fallbackLimit - projectedBytes),
			percentUsed,
			enforced: false,
		};
	}
	// Combine the summary's own reserved bytes (normally 0 from the billing path)
	// with the reservations loaded by the orchestrator.
	const totalReservedBytes = summary.reservedBytes + reservedBytes;
	const projectedBytes = summary.usedBytes + summary.pendingBytes + totalReservedBytes;
	const remainingBytes = Math.max(0, summary.limitBytes - projectedBytes);
	const percentUsed = summary.limitBytes > 0
		? Math.min(999, Math.round((projectedBytes / summary.limitBytes) * 10000) / 100)
		: 0;
	return {
		usedBytes: summary.usedBytes,
		originalBytes: summary.originalBytes,
		derivativeBytes: summary.derivativeBytes,
		exportArtifactBytes: summary.exportArtifactBytes,
		reservedBytes: totalReservedBytes,
		projectedBytes,
		limitBytes: summary.limitBytes,
		includedBytes: summary.includedBytes,
		extraBytes: summary.extraBytes,
		remainingBytes,
		percentUsed,
		enforced: summary.enforced,
	};
}

function egressView(summaries: ProjectEgressSummary[]): WorkspaceUsageDashboardEgress {
	if (summaries.length === 0) {
		return {
			windowMs: 0,
			totalRequests: 0,
			totalBytes: 0,
			limitBytes: 0,
			remainingBytes: 0,
			enforced: false,
			perProjectEnforced: false,
			projects: [],
		};
	}
	const windowMs = summaries[0]?.windowMs ?? 0;
	let totalRequests = 0;
	let totalBytes = 0;
	// Egress is enforced PER PROJECT: sum the per-project limits and per-project
	// remaining allowances rather than collapsing to a single max. Two projects
	// each using 60B under a 100B limit have 40B remaining each (80B total), not
	// 0 — taking max(limit) - sum(bytes) would have reported 0.
	let limitBytes = 0;
	let remainingBytes = 0;
	let perProjectEnforced = false;
	const projects: WorkspaceUsageDashboardEgressProject[] = [];
	for (const summary of summaries) {
		totalRequests += summary.totalRequests;
		totalBytes += summary.totalBytes;
		limitBytes += summary.limitBytes;
		const projectRemaining = summary.limitBytes <= 0 ? 0 : Math.max(0, summary.limitBytes - summary.totalBytes);
		remainingBytes += projectRemaining;
		perProjectEnforced = perProjectEnforced || summary.enforced;
		projects.push({
			projectId: summary.projectId,
			totalRequests: summary.totalRequests,
			totalBytes: summary.totalBytes,
			limitBytes: summary.limitBytes,
			remainingBytes: projectRemaining,
			enforced: summary.enforced,
		});
	}
	projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
	return {
		windowMs,
		totalRequests,
		totalBytes,
		limitBytes,
		remainingBytes,
		enforced: perProjectEnforced,
		perProjectEnforced,
		projects,
	};
}

/**
 * Pure aggregation: combine per-project summaries into a single workspace view.
 * No I/O — safe to unit test directly.
 */
export function aggregateWorkspaceUsageDashboard(input: WorkspaceUsageDashboardAggregationInput): WorkspaceUsageDashboard {
	const daily = windowView("daily", input.usage?.daily);
	const monthly = windowView("monthly", input.usage?.monthly);
	const eventCount = input.usage?.eventCount ?? 0;
	const eventCountCapped = input.usage?.eventCountCapped ?? false;
	const usageEnforced = input.usage?.enforced ?? false;

	const storage = storageView(input.storage, input.reservations, input.plan.includedStorageBytes);
	const egress = egressView(input.egressSummaries);

	const breakdown: WorkspaceUsageDashboardMember[] = input.members
		.map((member) => ({
			userId: member.userId,
			role: member.role,
			disabled: Boolean(member.disabledAt),
			aiCommittedThb: 0,
			uploadBytes: 0,
			exportBytes: 0,
		}))
		.sort((a, b) => a.userId.localeCompare(b.userId));

	return {
		workspaceId: input.workspaceId,
		scope: input.scope,
		enforced: usageEnforced || storage.enforced || egress.enforced,
		plan: {
			id: input.plan.id,
			name: input.plan.name,
			monthlyAiCredits: input.plan.monthlyAiCredits,
			includedStorageBytes: input.plan.includedStorageBytes,
			maxSeatsIncluded: input.plan.maxSeatsIncluded,
		},
		projectIds: input.projectIds,
		projectCount: input.projectIds.length,
		totals: { daily, monthly, eventCount, eventCountCapped },
		storage,
		egress,
		memberAttribution: "unattributed",
		members: {
			count: breakdown.length,
			breakdown,
			unattributed: {
				aiCommittedThb: monthly.aiCommittedThb,
				uploadBytes: monthly.uploadBytes,
				exportBytes: monthly.exportBytes,
			},
		},
	};
}

function normalizeWorkspaceId(workspaceId: string): string {
	return workspaceId.trim();
}

/**
 * Resolve the set of project IDs belonging to a workspace, INDEPENDENT of the
 * caller's per-project scope. This endpoint is workspace-wide once membership
 * (`read_workspace`) has been verified, so a member with a restricted project
 * scope must still see complete workspace totals — otherwise the dashboard
 * omits projects, undercounts usage, and can report null totals.
 *
 * - Postgres mode: list every non-deleted project keyed by `workspace_id`
 *   (UNSCOPED). The previous round resolved a scoped ANCHOR project the caller
 *   could see and expanded from it, but a member whose scope hides every project
 *   (chapter/page/task/asset/language-limited, or a non-matching project scope)
 *   had no anchor and so received an empty set. Keying directly off the
 *   workspace removes that dependency on scoped visibility.
 * - Filesystem mode: scan PROJECTS_DIR for `state.json` files referencing the
 *   workspace. Access is already gated by the caller's workspace membership
 *   check; filesystem mode has no per-member project scoping.
 */
export async function resolveWorkspaceProjectIds(
	workspaceId: string,
	// Retained for call-site compatibility; resolution is intentionally UNSCOPED
	// (by workspace_id) and no longer depends on the caller's identity/scope.
	_userId?: string,
): Promise<{ scope: WorkspaceUsageDashboardScope; projectIds: string[] }> {
	const normalized = normalizeWorkspaceId(workspaceId);
	// Only the durable Postgres catalog is the "postgres" resolution path. In
	// file-mode the catalog store is now a FileProjectCatalogStore (so the
	// project-create route stops 503-ing without DATABASE_URL), but its data
	// still comes from the on-disk project state files -- report that honestly as
	// the filesystem scope and resolve via the filesystem scan.
	if (projectCatalogStore && serverConfig.projectCatalogStore === "postgres") {
		return { scope: "postgres", projectIds: await resolvePostgresWorkspaceProjectIds(projectCatalogStore, normalized) };
	}
	return { scope: "filesystem", projectIds: resolveFilesystemWorkspaceProjectIds(normalized) };
}

// Minimal catalog surface needed to resolve a workspace's project set without
// the caller's per-project scope. Mirrors the relevant `ProjectCatalogStore`
// methods so the resolution logic can be unit-tested with a fake.
export interface WorkspaceProjectResolverCatalog {
	// UNSCOPED lookup by workspace_id: returns every non-deleted project in the
	// workspace regardless of the caller's per-member scope. This is the primary
	// source so a scope-restricted member still gets complete workspace totals.
	listProjectIdsForWorkspace(workspaceId: string): Promise<string[]>;
}

/**
 * Resolve the workspace's project set from a fully UNSCOPED lookup keyed by
 * workspace_id. The dashboard is authorized at the workspace level (the route
 * verifies `read_workspace` membership), so the project set must NOT be derived
 * from the caller's scoped project visibility. A member whose scope hides every
 * project (chapter/page/task/asset/language-limited, or a non-matching project
 * scope) previously yielded an empty set, nulling out usage/storage/egress for a
 * non-empty workspace; resolving by workspace_id fixes that undercount.
 */
export async function resolvePostgresWorkspaceProjectIds(
	store: WorkspaceProjectResolverCatalog,
	workspaceId: string,
): Promise<string[]> {
	const normalized = workspaceId.trim();
	const projectIds = new Set<string>();
	for (const projectId of await store.listProjectIdsForWorkspace(normalized)) {
		const normalizedProjectId = projectId.trim();
		if (normalizedProjectId) projectIds.add(normalizedProjectId);
	}
	return [...projectIds].sort();
}

function resolveFilesystemWorkspaceProjectIds(workspaceId: string): string[] {
	const projectIds = new Set<string>();
	try {
		for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidateProjectId = entry.name.trim();
			if (!candidateProjectId) continue;
			const state = readWorkspaceState(candidateProjectId);
			if (state?.workspaceId?.trim() === workspaceId) {
				projectIds.add(candidateProjectId);
			}
		}
	} catch {
		return [];
	}
	return [...projectIds].sort();
}

function readWorkspaceState(projectId: string): Pick<ProjectState, "workspaceId"> | null {
	// Tombstone-aware: a permanently-deleted project (even one whose state.json
	// survived a partial rmSync) must not be counted into the workspace's usage
	// dashboard project set — mirroring the Postgres "non-deleted only" path.
	return readProjectStateFileGuarded<ProjectState>(projectId);
}

// Minimal paged-roster surface needed to load the workspace members with the
// actor's scope preserved. Mirrors `WorkspaceAccessStore.listMemberPage` so the
// scope-forwarding/pagination logic can be unit-tested with a fake.
export interface WorkspaceRosterSource {
	listMemberPage(
		workspaceId: string,
		options?: { cursor?: string; scopeCoveredBy?: WorkspaceScope },
	): Promise<{ members: WorkspaceMemberRecord[]; nextCursor?: string }>;
}

/**
 * Page through the workspace roster, PRESERVING the actor's member scope as
 * `scopeCoveredBy`. A scoped admin/owner must only see members their scope
 * covers, matching the dedicated `/workspaces/:workspaceId/members` route. The
 * unscoped `listMembers()` would leak every member to a scope-restricted
 * manager, so `scopeCoveredBy: actorScope` is forwarded on every page request.
 */
export async function collectScopedWorkspaceMembers(
	source: WorkspaceRosterSource,
	workspaceId: string,
	actorScope?: WorkspaceScope,
): Promise<WorkspaceMemberRecord[]> {
	const members: WorkspaceMemberRecord[] = [];
	let cursor: string | undefined;
	// Page through the scope-filtered roster; cap iterations defensively.
	for (let page = 0; page < 1000; page += 1) {
		const result = await source.listMemberPage(workspaceId, { cursor, scopeCoveredBy: actorScope });
		members.push(...result.members);
		if (!result.nextCursor) break;
		cursor = result.nextCursor;
	}
	return members;
}

async function listWorkspaceMembers(workspaceId: string, actorScope?: WorkspaceScope): Promise<WorkspaceMemberRecord[]> {
	if (!workspaceAccessStore) return [];
	try {
		return await collectScopedWorkspaceMembers(workspaceAccessStore, workspaceId, actorScope);
	} catch {
		// Member roster is best-effort decoration; never fail the dashboard for it.
		return [];
	}
}

// Load the workspace record (plan id + storage overrides) best-effort. Used as
// the plan fallback for an authorized workspace that has no projects yet, so the
// reported plan reflects the workspace's actual billing plan rather than the
// process/default plan. Never fail the dashboard for it.
async function loadWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord | null> {
	if (!workspaceAccessStore) return null;
	try {
		return await workspaceAccessStore.getWorkspace(workspaceId);
	} catch {
		return null;
	}
}

// Resolve the workspace-wide usage summary.
//
// - Postgres: `summarizeProject(anyProjectId)` resolves the project's workspace
//   and returns workspace-wide totals in a single query.
// - Filesystem: the FS ledger keys events strictly by the value passed as
//   `workspaceId`. Production `recordUploadUsage`/`recordExportUsage` are often
//   called with only a `projectId`, so those events are keyed under the project
//   id (not the workspace id). Summarizing the workspace id alone would miss
//   them, so we summarize the workspace id AND each resolved project id, then
//   combine the distinct-keyed summaries.
async function summarizeWorkspaceUsageTotals(
	workspaceId: string,
	projectIds: string[],
	now: number,
): Promise<WorkspaceUsageSummary | null> {
	if (usageLedger instanceof PostgresUsageLedger) {
		const anchorProjectId = projectIds[0];
		if (!anchorProjectId) return null;
		return usageLedger.summarizeProject(anchorProjectId, now);
	}
	// Capture the narrowed filesystem ledger so the synchronous `summarize`
	// return type is preserved inside the closure below.
	const fileLedger = usageLedger;
	// Distinct keys: the workspace id plus every project id that differs from it.
	// Events carry exactly one `workspaceId`, so distinct keys never double-count.
	const keys = [...new Set([workspaceId, ...projectIds.map((projectId) => projectId.trim()).filter(Boolean)])];
	const summaries = keys.map((key) => fileLedger.summarize(key, key, now));
	return combineUsageSummaries(workspaceId, summaries);
}

// Combine usage summaries that were keyed under different ids (the workspace id
// and per-project ids in filesystem mode). Limits/plan come from the workspace
// summary (limits are identical across keys for one plan); totals are summed and
// remaining/percentUsed are recomputed against the shared limits.
function combineUsageSummaries(workspaceId: string, summaries: WorkspaceUsageSummary[]): WorkspaceUsageSummary | null {
	if (summaries.length === 0) return null;
	const base = summaries[0]!;
	if (summaries.length === 1) {
		return { ...base, workspaceId, projectId: workspaceId };
	}
	// Sum the per-key counts, then re-apply the displayed cap: the total is capped if
	// any contributing summary was already capped OR the sum itself reaches the cap.
	// eventCount stays clamped to the cap so the "100000+" ceiling holds workspace-wide.
	const summedEventCount = summaries.reduce((total, summary) => total + summary.eventCount, 0);
	const eventCountCapped = summaries.some((summary) => summary.eventCountCapped)
		|| summedEventCount >= WORKSPACE_EVENT_COUNT_CAP;
	return {
		workspaceId,
		projectId: workspaceId,
		planId: base.planId,
		enforced: summaries.some((summary) => summary.enforced),
		daily: combineUsageWindow(base.daily, summaries.map((summary) => summary.daily)),
		monthly: combineUsageWindow(base.monthly, summaries.map((summary) => summary.monthly)),
		eventCount: eventCountCapped ? WORKSPACE_EVENT_COUNT_CAP : summedEventCount,
		eventCountCapped,
	};
}

function combineUsageWindow(base: UsageWindowSummary, windows: UsageWindowSummary[]): UsageWindowSummary {
	const limits = { ...base.limits };
	const sum = (pick: (window: UsageWindowSummary) => number): number =>
		round4(windows.reduce((total, window) => total + pick(window), 0));
	const aiCapturedThb = sum((window) => window.aiCapturedThb);
	const aiActiveReservedThb = sum((window) => window.aiActiveReservedThb);
	const aiCommittedThb = sum((window) => window.aiCommittedThb);
	const uploadBytes = sum((window) => window.uploadBytes);
	const exportBytes = sum((window) => window.exportBytes);
	const moderationImages = sum((window) => window.moderationImages);
	return {
		periodKey: base.periodKey,
		aiCapturedThb,
		aiActiveReservedThb,
		aiCommittedThb,
		uploadBytes,
		exportBytes,
		moderationImages,
		limits,
		remaining: {
			aiCreditThb: remainingAgainstLimit(limits.aiCreditThb, aiCommittedThb),
			uploadBytes: remainingAgainstLimit(limits.uploadBytes, uploadBytes),
			exportBytes: remainingAgainstLimit(limits.exportBytes, exportBytes),
		},
		percentUsed: {
			aiCredit: percentAgainstLimit(aiCommittedThb, limits.aiCreditThb),
			uploadBytes: percentAgainstLimit(uploadBytes, limits.uploadBytes),
			exportBytes: percentAgainstLimit(exportBytes, limits.exportBytes),
		},
	};
}

function remainingAgainstLimit(limit: number, used: number): number | null {
	return limit > 0 ? Math.max(0, round4(limit - used)) : null;
}

function percentAgainstLimit(used: number, limit: number): number | null {
	return limit > 0 ? Math.min(999, Math.round((used / limit) * 10000) / 100) : null;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

export interface BuildWorkspaceUsageDashboardOptions {
	// When false (the default), the member roster is omitted. The roster must
	// only be exposed to callers with `manage_members` — the same gate the
	// dedicated `/workspaces/:workspaceId/members` route enforces — because plain
	// `read_workspace` viewers/editors can reach this endpoint.
	includeMembers?: boolean;
	// The requesting member's scope. When the roster is included it is filtered to
	// the members this scope covers (`scopeCoveredBy`), so a scoped admin/owner
	// only sees members within their scope — matching the dedicated members route.
	actorScope?: WorkspaceScope;
	// Injectable for tests; defaults to the shared process cache (Redis or no-op).
	// Production callers omit it. See the response-cache fail-open contract.
	cache?: ResponseCache;
}

// Deterministic JSON: stringify with sorted object keys so two equivalent scopes
// (same fields, different insertion order) produce the SAME cache key and a fresh
// build for a genuinely different scope produces a different one. Used only for the
// leak-safe-by-key dashboard cache key.
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Cache key for the workspace usage dashboard. LEAK-SAFE BY KEY (the house rule):
 * the endpoint is membership-gated, so the body is per-tenant data — the key MUST
 * carry the workspaceId AND every input that shapes the response. Two distinct
 * workspaces can therefore NEVER share an entry, and a roster-bearing manager view
 * never reuses a viewer's roster-less body:
 *   - workspaceId — per-tenant isolation;
 *   - includeMembers — whether the roster (manage_members-gated) is present;
 *   - actorScope — which members the roster is filtered to (a scoped admin/owner
 *     must not see another scope's members), normalized via stableStringify.
 * `now` is intentionally NOT in the key: the dashboard tolerates a few seconds of
 * staleness within the short TTL (its windows are day/month-grained), matching the
 * revenue cache. `userId` is deliberately omitted — the response is identical for
 * every member who shares the same (workspaceId, includeMembers, actorScope), so
 * keying on it would only fragment the cache without changing the body.
 */
export function workspaceUsageDashboardCacheKey(
	workspaceId: string,
	options: BuildWorkspaceUsageDashboardOptions,
): string {
	return "usage:dashboard:v1:" + stableStringify([
		normalizeWorkspaceId(workspaceId),
		Boolean(options.includeMembers),
		options.includeMembers ? (options.actorScope ?? null) : null,
	]);
}

/**
 * Orchestration: gather read-only data from the live services and aggregate it.
 *
 * Wrapped in the fail-open response cache (short TTL) so repeated dashboard loads
 * do not re-run the fan-out reads — most importantly the all-time event COUNT over
 * the high-volume usage_events table — on EVERY render. The cache fails open: any
 * backend error degrades to a fresh compute, never a broken endpoint. The key is
 * per-tenant + per-shaping-param (see workspaceUsageDashboardCacheKey).
 */
export async function buildWorkspaceUsageDashboard(
	workspaceId: string,
	userId: string,
	now = Date.now(),
	options: BuildWorkspaceUsageDashboardOptions = {},
): Promise<WorkspaceUsageDashboard> {
	const cache = options.cache ?? getResponseCache();
	const key = workspaceUsageDashboardCacheKey(workspaceId, options);
	return cache.getOrSet(key, USAGE_DASHBOARD_CACHE_TTL_SECONDS, () =>
		computeWorkspaceUsageDashboard(workspaceId, userId, now, options),
	);
}

/**
 * Uncached build: gather read-only data from the live services and aggregate it.
 * `buildWorkspaceUsageDashboard` wraps this in the response cache.
 */
async function computeWorkspaceUsageDashboard(
	workspaceId: string,
	userId: string,
	now: number,
	options: BuildWorkspaceUsageDashboardOptions,
): Promise<WorkspaceUsageDashboard> {
	const normalized = normalizeWorkspaceId(workspaceId);
	const { scope, projectIds } = await resolveWorkspaceProjectIds(normalized, userId);

	const [usage, egressSummaries, members, reservations, workspace] = await Promise.all([
		summarizeWorkspaceUsageTotals(normalized, projectIds, now),
		// rank14: ONE batched egress summary (grouped scan / pipelined reads)
		// instead of fanning out one summarize round-trip per project.
		summarizeProjectsEgress(projectIds, now),
		options.includeMembers ? listWorkspaceMembers(normalized, options.actorScope) : Promise.resolve<WorkspaceMemberRecord[]>([]),
		listWorkspaceStorageReservations(normalized, now),
		loadWorkspaceRecord(normalized),
	]);

	// Storage quota already aggregates across the whole workspace when given any
	// member project (it resolves the full project set + shared plan), so a
	// single call is sufficient and avoids double-counting. It is computed with
	// `reservedBytes: 0`; active reservations are merged in by the aggregator via
	// `reservations` so reserved/projected/remaining match the enforced checks.
	let storage: StorageQuotaSummary | null = null;
	if (projectIds.length > 0) {
		storage = await summarizeProjectStorageQuotaForBilling(projectIds[0]!, 0, {
			workspaceId: normalized,
			workspaceProjectIds: projectIds,
		});
	}

	const plan = resolvePlanForDashboard(usage, storage, workspace);

	return aggregateWorkspaceUsageDashboard({
		workspaceId: normalized,
		scope,
		plan,
		projectIds,
		usage,
		storage,
		egressSummaries,
		members,
		reservations: {
			reservedBytes: sumReservationBytes(reservations),
			activeReservationCount: reservations.length,
		},
	});
}

// Load active storage reservations for the workspace. The dashboard's billing
// storage path does not include them, but the enforced quota checks do — so the
// dashboard would otherwise report `reservedBytes: 0` and overstate remaining
// during concurrent uploads/exports. Best-effort: never fail the dashboard.
async function listWorkspaceStorageReservations(workspaceId: string, now: number): Promise<StorageQuotaReservation[]> {
	try {
		return await storageQuotaReservationStore.listActive(workspaceId, now);
	} catch {
		return [];
	}
}

function sumReservationBytes(reservations: StorageQuotaReservation[]): number {
	return reservations.reduce((total, reservation) => {
		const bytes = reservation.bytes;
		return total + (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0);
	}, 0);
}

// Resolve the plan to report for the dashboard. Priority:
//   1. the plan id surfaced by the usage ledger (resolved per-workspace in
//      Postgres mode) — only present once the workspace has at least one project;
//   2. the workspace record's own `planId` — used for an AUTHORIZED workspace
//      that has no projects yet (new workspaces exist before any project), so the
//      reported plan reflects the workspace's actual billing plan rather than the
//      process/default plan;
//   3. the env/default plan as a last resort.
// When a storage summary is present its included bytes (plan + add-ons/overrides)
// take precedence; otherwise an explicit workspace storage override is reflected.
export function resolvePlanForDashboard(
	usage: WorkspaceUsageSummary | null,
	storage: StorageQuotaSummary | null,
	workspace: WorkspaceRecord | null,
): WorkspacePlan {
	const plan = resolveWorkspacePlan(usage?.planId ?? workspace?.planId);
	if (storage && (storage.includedBytes > 0 || storage.extraBytes > 0)) {
		// Reflect storage add-ons / overrides in the reported included bytes.
		return { ...plan, includedStorageBytes: storage.includedBytes };
	}
	// No project anchor (and thus no storage summary): honor an explicit workspace
	// storage override recorded on the workspace record itself.
	if (!storage && workspace) {
		const overrideBytes = Math.max(0, Math.round(workspace.storageIncludedBytes)) + Math.max(0, Math.round(workspace.storageExtraBytes));
		if (overrideBytes > 0) {
			return { ...plan, includedStorageBytes: overrideBytes };
		}
	}
	return plan;
}
