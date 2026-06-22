import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR } from "../config.js";
import {
	aggregateWorkspaceUsageDashboard,
	buildWorkspaceUsageDashboard,
	collectScopedWorkspaceMembers,
	resolvePlanForDashboard,
	resolvePostgresWorkspaceProjectIds,
	resolveWorkspaceProjectIds,
	workspaceUsageDashboardCacheKey,
	type WorkspaceProjectResolverCatalog,
	type WorkspaceRosterSource,
	type WorkspaceUsageDashboardAggregationInput,
} from "../services/usage-dashboard.js";
import { GIB, WORKSPACE_PLANS, type WorkspacePlan } from "../services/plans.js";
import { recordExportUsage, recordUploadUsage, type WorkspaceUsageSummary } from "../services/usage-ledger.js";
import type { ProjectEgressSummary } from "../services/egress-accounting.js";
import { MemoryResponseCache, type ResponseCache } from "../services/response-cache.js";
import {
	MemoryStorageQuotaReservationStore,
	setStorageQuotaReservationStoreForTests,
	type StorageQuotaSummary,
} from "../services/storage-quota.js";
import { roleHasPermission, type WorkspaceMemberRecord, type WorkspaceRecord, type WorkspaceScope } from "../services/workspace-access.js";

const createdProjectDirs: string[] = [];

function writeProjectState(workspaceId: string | undefined): string {
	const projectId = uuid();
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Dashboard Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
		...(workspaceId ? { workspaceId } : {}),
	}));
	createdProjectDirs.push(projectDir);
	return projectId;
}

afterEach(() => {
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

function usageSummary(overrides: {
	projectId: string;
	workspaceId: string;
	planId?: string;
	dailyUpload?: number;
	monthlyUpload?: number;
	dailyExport?: number;
	monthlyExport?: number;
	dailyAi?: number;
	monthlyAi?: number;
	eventCount?: number;
	eventCountCapped?: boolean;
	uploadLimit?: number;
	aiLimit?: number;
}): WorkspaceUsageSummary {
	const uploadLimit = overrides.uploadLimit ?? 0;
	const aiLimit = overrides.aiLimit ?? 0;
	const window = (upload: number, exportBytes: number, ai: number) => ({
		periodKey: "p",
		aiCapturedThb: ai,
		aiActiveReservedThb: 0,
		aiCommittedThb: ai,
		uploadBytes: upload,
		exportBytes,
		moderationImages: 0,
		limits: {
			aiCreditThb: aiLimit,
			uploadBytes: uploadLimit,
			exportBytes: 0,
		},
		remaining: {
			aiCreditThb: aiLimit > 0 ? Math.max(0, aiLimit - ai) : null,
			uploadBytes: uploadLimit > 0 ? Math.max(0, uploadLimit - upload) : null,
			exportBytes: null,
		},
		percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
	});
	return {
		workspaceId: overrides.workspaceId,
		projectId: overrides.projectId,
		planId: overrides.planId ?? "free",
		enforced: true,
		daily: window(overrides.dailyUpload ?? 0, overrides.dailyExport ?? 0, overrides.dailyAi ?? 0),
		monthly: window(overrides.monthlyUpload ?? 0, overrides.monthlyExport ?? 0, overrides.monthlyAi ?? 0),
		eventCount: overrides.eventCount ?? 0,
		eventCountCapped: overrides.eventCountCapped ?? false,
	};
}

function egressSummary(projectId: string, totalBytes: number, totalRequests: number, limitBytes: number, enforced = true): ProjectEgressSummary {
	return {
		projectId,
		windowMs: 60_000,
		windowStart: 0,
		windowEnd: 60_000,
		totalRequests,
		totalBytes,
		limitBytes,
		enforced,
		remainingBytes: limitBytes > 0 ? Math.max(0, limitBytes - totalBytes) : 0,
		byPurpose: [],
		byAsset: [],
	};
}

function storageSummary(overrides: Partial<StorageQuotaSummary> = {}): StorageQuotaSummary {
	const usedBytes = overrides.usedBytes ?? 4000;
	const limitBytes = overrides.limitBytes ?? 10_000;
	return {
		projectId: "proj-a",
		workspaceId: "ws-1",
		enforced: true,
		usedBytes,
		originalBytes: usedBytes,
		derivativeBytes: 0,
		exportArtifactBytes: 0,
		pendingBytes: 0,
		// The billing storage path is computed with reservedBytes: 0; the dashboard
		// merges active reservations on top, so default to 0 here.
		reservedBytes: 0,
		includedBytes: limitBytes,
		extraBytes: 0,
		limitBytes,
		projectedBytes: usedBytes,
		remainingBytes: Math.max(0, limitBytes - usedBytes),
		percentUsed: limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 10000) / 100 : 0,
		assetCount: 1,
		derivativeCount: 0,
		exportArtifactCount: 0,
		activeReservationCount: 0,
		...overrides,
	};
}

function member(userId: string, role: WorkspaceMemberRecord["role"], disabledAt?: string): WorkspaceMemberRecord {
	return {
		workspaceId: "ws-1",
		userId,
		role,
		scope: {},
		createdAt: "",
		updatedAt: "",
		...(disabledAt ? { disabledAt } : {}),
	};
}

function plan(): WorkspacePlan {
	return WORKSPACE_PLANS.pro;
}

function workspaceRecord(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
	return {
		workspaceId: "ws-1",
		name: "WS",
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

// A minimal valid aggregation input for focused assertions; override per test.
function baseAggregationInput(usageOverrides: Omit<Parameters<typeof usageSummary>[0], "projectId" | "workspaceId"> = {}): WorkspaceUsageDashboardAggregationInput {
	return {
		workspaceId: "ws-1",
		scope: "filesystem",
		plan: plan(),
		projectIds: ["proj-a", "proj-b"],
		usage: usageSummary({ ...usageOverrides, projectId: "proj-a", workspaceId: "ws-1" }),
		storage: null,
		egressSummaries: [],
		members: [],
	};
}

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = previous;
	}
}

describe("usage dashboard aggregation", () => {
	test("maps workspace usage and sums storage and egress across projects", () => {
		const input: WorkspaceUsageDashboardAggregationInput = {
			workspaceId: "ws-1",
			scope: "filesystem",
			plan: plan(),
			projectIds: ["proj-a", "proj-b"],
			// The ledger is workspace-keyed: this single summary already reflects
			// all projects in the workspace.
			usage: usageSummary({
				projectId: "proj-a",
				workspaceId: "ws-1",
				monthlyUpload: 300,
				monthlyExport: 100,
				monthlyAi: 3.75,
				dailyUpload: 15,
				eventCount: 7,
				uploadLimit: 1000,
				aiLimit: 50,
			}),
			storage: {
				projectId: "proj-a",
				workspaceId: "ws-1",
				enforced: true,
				usedBytes: 4096,
				originalBytes: 3000,
				derivativeBytes: 800,
				exportArtifactBytes: 296,
				pendingBytes: 0,
				reservedBytes: 0,
				includedBytes: 8192,
				extraBytes: 0,
				limitBytes: 8192,
				projectedBytes: 4096,
				remainingBytes: 4096,
				percentUsed: 50,
				assetCount: 2,
				derivativeCount: 1,
				exportArtifactCount: 1,
				activeReservationCount: 0,
			},
			egressSummaries: [
				egressSummary("proj-a", 500, 5, 10_000),
				egressSummary("proj-b", 1500, 9, 10_000),
			],
			members: [member("user-z", "editor"), member("user-a", "owner")],
		};

		const dashboard = aggregateWorkspaceUsageDashboard(input);

		// Usage totals
		expect(dashboard.totals.monthly.uploadBytes).toBe(300);
		expect(dashboard.totals.monthly.exportBytes).toBe(100);
		expect(dashboard.totals.monthly.aiCommittedThb).toBe(3.75);
		expect(dashboard.totals.daily.uploadBytes).toBe(15);
		expect(dashboard.totals.eventCount).toBe(7);
		// Under the cap, the dashboard reports the count as exact (not capped).
		expect(dashboard.totals.eventCountCapped).toBe(false);

		// Shared plan limit is taken as the max across projects, remaining computed.
		expect(dashboard.totals.monthly.limits.uploadBytes).toBe(1000);
		expect(dashboard.totals.monthly.remaining.uploadBytes).toBe(700);
		expect(dashboard.totals.monthly.remaining.aiCreditThb).toBe(46.25);

		// Storage is a single workspace-wide summary (no double count).
		expect(dashboard.storage.usedBytes).toBe(4096);
		expect(dashboard.storage.limitBytes).toBe(8192);
		expect(dashboard.storage.remainingBytes).toBe(4096);

		// Egress is enforced PER PROJECT: bytes/requests/limits/remaining are summed
		// across projects (not collapsed to a single max limit). proj-a: 500/10_000
		// → 9_500 remaining; proj-b: 1500/10_000 → 8_500 remaining.
		expect(dashboard.egress.totalBytes).toBe(2000);
		expect(dashboard.egress.totalRequests).toBe(14);
		expect(dashboard.egress.limitBytes).toBe(20_000);
		expect(dashboard.egress.remainingBytes).toBe(18_000);
		expect(dashboard.egress.perProjectEnforced).toBe(true);
		expect(dashboard.egress.projects.map((p) => p.projectId)).toEqual(["proj-a", "proj-b"]);
		expect(dashboard.egress.projects.find((p) => p.projectId === "proj-a")?.remainingBytes).toBe(9_500);
		expect(dashboard.egress.projects.find((p) => p.projectId === "proj-b")?.remainingBytes).toBe(8_500);

		// Attribution is unattributed; member roster is sorted; spend is in the bucket.
		expect(dashboard.memberAttribution).toBe("unattributed");
		expect(dashboard.members.count).toBe(2);
		expect(dashboard.members.breakdown.map((m) => m.userId)).toEqual(["user-a", "user-z"]);
		expect(dashboard.members.breakdown.every((m) => m.aiCommittedThb === 0)).toBe(true);
		expect(dashboard.members.unattributed.uploadBytes).toBe(300);
		expect(dashboard.members.unattributed.aiCommittedThb).toBe(3.75);

		expect(dashboard.plan.id).toBe("pro");
		expect(dashboard.projectCount).toBe(2);
	});

	test("propagates the capped event count flag to the dashboard totals", () => {
		// When the underlying summary's count hit WORKSPACE_EVENT_COUNT_CAP, the
		// dashboard must advertise eventCountCapped so clients render "100000+"
		// instead of an exact-looking "100000".
		const dashboard = aggregateWorkspaceUsageDashboard({
			workspaceId: "ws-1",
			scope: "filesystem",
			plan: plan(),
			projectIds: ["proj-a"],
			usage: usageSummary({
				projectId: "proj-a",
				workspaceId: "ws-1",
				eventCount: 100_000,
				eventCountCapped: true,
			}),
			storage: null,
			egressSummaries: [],
			members: [],
		});

		expect(dashboard.totals.eventCount).toBe(100_000);
		expect(dashboard.totals.eventCountCapped).toBe(true);
	});

	test("unlimited limits report null remaining and disabled members are flagged", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			workspaceId: "ws-1",
			scope: "filesystem",
			plan: plan(),
			projectIds: ["proj-a"],
			usage: usageSummary({ projectId: "proj-a", workspaceId: "ws-1", monthlyUpload: 50 }),
			storage: null,
			egressSummaries: [],
			members: [member("user-disabled", "viewer", "2026-01-01T00:00:00.000Z")],
		});

		expect(dashboard.totals.monthly.limits.uploadBytes).toBe(0);
		expect(dashboard.totals.monthly.remaining.uploadBytes).toBeNull();
		expect(dashboard.totals.monthly.remaining.aiCreditThb).toBeNull();
		expect(dashboard.storage.usedBytes).toBe(0);
		expect(dashboard.egress.totalBytes).toBe(0);
		expect(dashboard.members.breakdown[0]?.disabled).toBe(true);
	});

	// Regression: a brand-new workspace with zero projects has no storage summary
	// (null), but the sidebar/usage widgets must still show the PLAN allowance as
	// the limit ("0 B of 2 GB"), not "0 B of 0 B".
	test("falls back to the plan's included storage as the limit when there is no project anchor", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			workspaceId: "ws-1",
			scope: "filesystem",
			plan: plan(), // pro: includedStorageBytes > 0
			projectIds: [],
			usage: null,
			storage: null,
			egressSummaries: [],
			members: [],
		});

		expect(dashboard.storage.usedBytes).toBe(0);
		expect(dashboard.storage.limitBytes).toBe(WORKSPACE_PLANS.pro.includedStorageBytes);
		expect(dashboard.storage.includedBytes).toBe(WORKSPACE_PLANS.pro.includedStorageBytes);
		expect(dashboard.storage.remainingBytes).toBe(WORKSPACE_PLANS.pro.includedStorageBytes);
		expect(dashboard.storage.percentUsed).toBe(0);
	});
});

describe("usage dashboard workspace scoping", () => {
	test("resolves only projects belonging to the requested workspace (filesystem)", async () => {
		const workspaceId = `ws-${uuid()}`;
		const otherWorkspaceId = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceId);
		const projectB = writeProjectState(workspaceId);
		writeProjectState(otherWorkspaceId); // must be excluded
		writeProjectState(undefined); // solo project, no workspace, excluded

		const { scope, projectIds } = await resolveWorkspaceProjectIds(workspaceId, "user-1");

		expect(scope).toBe("filesystem");
		expect(projectIds.sort()).toEqual([projectA, projectB].sort());
	});

	test("returns no projects for a workspace with none", async () => {
		const { projectIds } = await resolveWorkspaceProjectIds(`ws-${uuid()}`, "user-1");
		expect(projectIds).toEqual([]);
	});

	test("builds an end-to-end dashboard scoped to the workspace's projects", async () => {
		const workspaceId = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceId);
		const projectB = writeProjectState(workspaceId);
		writeProjectState(`ws-${uuid()}`); // different workspace, must not leak in

		await recordUploadUsage({ workspaceId, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 120 });
		await recordUploadUsage({ workspaceId, projectId: projectB, subjectId: `upload:${uuid()}`, bytes: 80 });
		await recordExportUsage({ workspaceId, projectId: projectA, subjectId: `export:${uuid()}`, bytes: 40 });

		const dashboard = await buildWorkspaceUsageDashboard(workspaceId, "user-1");

		expect(dashboard.workspaceId).toBe(workspaceId);
		expect(dashboard.scope).toBe("filesystem");
		expect(dashboard.projectIds.sort()).toEqual([projectA, projectB].sort());
		expect(dashboard.totals.monthly.uploadBytes).toBe(200);
		expect(dashboard.totals.monthly.exportBytes).toBe(40);
		expect(dashboard.totals.eventCount).toBeGreaterThanOrEqual(3);
		// Storage summary is present and workspace-scoped.
		expect(dashboard.storage.limitBytes).toBeGreaterThan(0);
		expect(dashboard.memberAttribution).toBe("unattributed");
	});

	// Finding #3: FS-mode events recorded with ONLY a projectId are keyed under
	// that project id, not the workspace id. The dashboard must reconcile both.
	test("aggregates filesystem usage events keyed by project id (no workspaceId on record)", async () => {
		const workspaceId = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceId);
		const projectB = writeProjectState(workspaceId);

		// Mirrors production callers (images.ts / usage.ts) that omit workspaceId,
		// so the FS ledger keys these events under the project id.
		await recordUploadUsage({ projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 120 });
		await recordUploadUsage({ projectId: projectB, subjectId: `upload:${uuid()}`, bytes: 80 });
		await recordExportUsage({ projectId: projectA, subjectId: `export:${uuid()}`, bytes: 40 });
		// And one event keyed under the workspace id directly.
		await recordUploadUsage({ workspaceId, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 7 });

		const dashboard = await buildWorkspaceUsageDashboard(workspaceId, "user-1");

		// 120 + 80 (project-keyed) + 7 (workspace-keyed) = 207.
		expect(dashboard.totals.monthly.uploadBytes).toBe(207);
		expect(dashboard.totals.monthly.exportBytes).toBe(40);
		expect(dashboard.totals.eventCount).toBeGreaterThanOrEqual(4);
	});

	// Finding #4: active storage reservations must be reflected in the dashboard
	// (reservedBytes / projectedBytes / remaining) like the enforced checks do.
	test("includes active storage reservations in the storage summary", async () => {
		const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
		const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
		process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = "100000";
		process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";
		const reservationStore = new MemoryStorageQuotaReservationStore();
		const restoreReservationStore = setStorageQuotaReservationStoreForTests(reservationStore);
		try {
			const workspaceId = `ws-${uuid()}`;
			const projectA = writeProjectState(workspaceId);
			const now = Date.parse("2026-05-28T04:00:00.000Z");

			await reservationStore.reserve({ projectId: projectA, workspaceId, bytes: 2500, reason: "image_upload", now, ttlMs: 60_000 });
			await reservationStore.reserve({ projectId: projectA, workspaceId, bytes: 1500, reason: "export_artifact", now, ttlMs: 60_000 });

			const dashboard = await buildWorkspaceUsageDashboard(workspaceId, "user-1", now);

			expect(dashboard.storage.reservedBytes).toBe(4000);
			// projectedBytes = usedBytes (0, empty project) + reservedBytes (4000).
			expect(dashboard.storage.projectedBytes).toBe(4000);
			expect(dashboard.storage.remainingBytes).toBe(96000);
		} finally {
			restoreReservationStore();
			restoreEnv("WORKSPACE_STORAGE_INCLUDED_BYTES", previousIncluded);
			restoreEnv("WORKSPACE_STORAGE_EXTRA_BYTES", previousExtra);
		}
	});
});

// Finding #2: egress is enforced PER PROJECT, so limits/remaining are summed
// across projects rather than collapsed into a single max limit.
describe("usage dashboard per-project egress aggregation", () => {
	test("sums per-project egress limits and remaining instead of taking a max", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput(),
			// Two projects each at 60B under a 100B limit: 40B remaining EACH (80B
			// total). A single max(limit) - sum(bytes) would have reported 0.
			egressSummaries: [
				egressSummary("proj-a", 60, 1, 100),
				egressSummary("proj-b", 60, 1, 100),
			],
		});

		expect(dashboard.egress.totalBytes).toBe(120);
		expect(dashboard.egress.limitBytes).toBe(200);
		expect(dashboard.egress.remainingBytes).toBe(80);
		expect(dashboard.egress.perProjectEnforced).toBe(true);
		expect(dashboard.egress.projects).toHaveLength(2);
		expect(dashboard.egress.projects.every((project) => project.remainingBytes === 40)).toBe(true);
	});

	test("treats a zero (unlimited) per-project limit as contributing no remaining", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput(),
			egressSummaries: [
				egressSummary("proj-a", 500, 3, 1000, true),
				egressSummary("proj-b", 9999, 9, 0, false), // unlimited / not enforced
			],
		});

		expect(dashboard.egress.totalBytes).toBe(10_499);
		// Only the enforced project contributes a finite limit and remaining.
		expect(dashboard.egress.limitBytes).toBe(1000);
		expect(dashboard.egress.remainingBytes).toBe(500);
		expect(dashboard.egress.perProjectEnforced).toBe(true);
		const unlimited = dashboard.egress.projects.find((project) => project.projectId === "proj-b");
		expect(unlimited?.remainingBytes).toBe(0);
		expect(unlimited?.enforced).toBe(false);
	});
});

// Finding #4 (pure aggregator): reservation totals merge into the storage view.
describe("usage dashboard reservation inclusion", () => {
	test("merges reservation bytes into reserved/projected/remaining/percent", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput(),
			storage: storageSummary({ usedBytes: 4000, limitBytes: 10_000 }),
			reservations: { reservedBytes: 3000, activeReservationCount: 2 },
		});

		expect(dashboard.storage.reservedBytes).toBe(3000);
		expect(dashboard.storage.projectedBytes).toBe(7000);
		expect(dashboard.storage.remainingBytes).toBe(3000);
		expect(dashboard.storage.percentUsed).toBe(70);
	});

	test("reservations apply even when no billing storage summary is present", () => {
		const dashboard = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput(),
			storage: null,
			reservations: { reservedBytes: 1234, activeReservationCount: 1 },
		});

		expect(dashboard.storage.reservedBytes).toBe(1234);
		expect(dashboard.storage.projectedBytes).toBe(1234);
	});
});

// Finding #1: workspace project resolution must be INDEPENDENT of caller scope.
// It is keyed by workspace_id (UNSCOPED), so a member whose scope hides every
// project still gets the complete workspace project set.
describe("usage dashboard postgres project resolution", () => {
	test("resolves the full workspace project set from an UNSCOPED workspace lookup", async () => {
		const calls: string[] = [];
		const store: WorkspaceProjectResolverCatalog = {
			// Keyed purely by workspace_id, independent of any caller's scope.
			async listProjectIdsForWorkspace(workspaceId) {
				calls.push(workspaceId);
				// Returned unsorted/with blanks to assert normalization + sorting.
				return ["proj-c", " proj-a ", "proj-b", "", "  "];
			},
		};

		const projectIds = await resolvePostgresWorkspaceProjectIds(store, "ws-1");

		expect(calls).toEqual(["ws-1"]);
		expect(projectIds).toEqual(["proj-a", "proj-b", "proj-c"]);
	});

	test("does not depend on the caller: a scope-restricted member still gets every project", async () => {
		// The fake never receives a userId/scope — resolution is by workspace_id
		// only. Even a member who could see no project via their scoped catalog
		// view gets the full set here.
		const store: WorkspaceProjectResolverCatalog = {
			async listProjectIdsForWorkspace() {
				return ["proj-a", "proj-b"];
			},
		};

		expect(await resolvePostgresWorkspaceProjectIds(store, "ws-1")).toEqual(["proj-a", "proj-b"]);
	});

	test("returns no projects for a workspace that has none", async () => {
		const store: WorkspaceProjectResolverCatalog = {
			async listProjectIdsForWorkspace() {
				return [];
			},
		};

		expect(await resolvePostgresWorkspaceProjectIds(store, "ws-1")).toEqual([]);
	});
});

// Finding #5: the member roster must only be exposed to manage_members callers.
describe("usage dashboard roster gating", () => {
	test("only owner/admin roles may see the member roster (read_workspace is not enough)", () => {
		// Viewer/editor have read_workspace (and can reach the dashboard) but not
		// manage_members; owner/admin do.
		expect(roleHasPermission("viewer", "read_workspace")).toBe(true);
		expect(roleHasPermission("viewer", "manage_members")).toBe(false);
		expect(roleHasPermission("editor", "read_workspace")).toBe(true);
		expect(roleHasPermission("editor", "manage_members")).toBe(false);
		expect(roleHasPermission("admin", "manage_members")).toBe(true);
		expect(roleHasPermission("owner", "manage_members")).toBe(true);
	});

	test("omits the roster when members are not included (viewer/editor context)", () => {
		const withRoster = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput(),
			members: [member("user-a", "owner"), member("user-z", "viewer")],
		});
		expect(withRoster.members.count).toBe(2);
		expect(withRoster.members.breakdown).toHaveLength(2);

		// When the orchestrator withholds the roster (no manage_members), the
		// aggregator receives no members and exposes none — but workspace-level
		// unattributed spend is still reported.
		const withoutRoster = aggregateWorkspaceUsageDashboard({
			...baseAggregationInput({ monthlyUpload: 300, monthlyAi: 1.5 }),
			members: [],
		});
		expect(withoutRoster.members.count).toBe(0);
		expect(withoutRoster.members.breakdown).toEqual([]);
		expect(withoutRoster.members.unattributed.uploadBytes).toBe(300);
		expect(withoutRoster.members.unattributed.aiCommittedThb).toBe(1.5);
	});

	test("end-to-end dashboard omits the roster unless members are explicitly included", async () => {
		const workspaceId = `ws-${uuid()}`;
		writeProjectState(workspaceId);

		// Default (no manage_members): roster withheld.
		const viewerView = await buildWorkspaceUsageDashboard(workspaceId, "user-1");
		expect(viewerView.members.count).toBe(0);
		expect(viewerView.members.breakdown).toEqual([]);

		// includeMembers requested: roster path is taken (empty without a DB-backed
		// workspace store, which is the FS-test default — but the path is exercised).
		const managerView = await buildWorkspaceUsageDashboard(workspaceId, "user-1", Date.now(), { includeMembers: true });
		expect(managerView.members.breakdown).toEqual([]);
	});
});

// Round-2 finding #1: a scope-restricted member with NO visible project must
// still receive complete workspace totals, because resolution is by workspace_id
// (unscoped). End-to-end via the filesystem path, which has no per-member
// scoping but exercises the same orchestration: every project in the workspace
// is aggregated regardless of who asks.
describe("usage dashboard unscoped totals for scope-restricted members", () => {
	test("aggregates every workspace project even when the caller could see none", async () => {
		const workspaceId = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceId);
		const projectB = writeProjectState(workspaceId);

		await recordUploadUsage({ workspaceId, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 500 });
		await recordUploadUsage({ workspaceId, projectId: projectB, subjectId: `upload:${uuid()}`, bytes: 300 });

		// A scope-restricted member id is irrelevant: resolution ignores it and
		// keys off the workspace, so all projects/usage are still included.
		const dashboard = await buildWorkspaceUsageDashboard(workspaceId, "scope-limited-user");

		expect(dashboard.projectIds.sort()).toEqual([projectA, projectB].sort());
		expect(dashboard.projectCount).toBe(2);
		expect(dashboard.totals.monthly.uploadBytes).toBe(800);
	});

	test("resolveWorkspaceProjectIds no longer threads the caller into postgres resolution", async () => {
		// The signature still accepts a userId for call-site compatibility, but the
		// postgres resolver is now arity-2 (store, workspaceId) — no scoped anchor.
		expect(resolvePostgresWorkspaceProjectIds.length).toBe(2);
	});
});

// Round-2 finding #2: an authorized workspace with NO projects must resolve its
// plan from the workspace record's plan_id, not the process/default plan.
describe("usage dashboard empty-workspace plan resolution", () => {
	test("falls back to the workspace record plan when there is no project anchor", () => {
		// No usage and no storage (empty workspace), but the workspace record carries
		// the real billing plan.
		const plan = resolvePlanForDashboard(null, null, workspaceRecord({ planId: "studio" }));
		expect(plan.id).toBe("studio");
		expect(plan.name).toBe(WORKSPACE_PLANS.studio.name);
		expect(plan.includedStorageBytes).toBe(WORKSPACE_PLANS.studio.includedStorageBytes);
	});

	test("prefers the ledger plan id over the workspace record when both exist", () => {
		const plan = resolvePlanForDashboard(
			usageSummary({ projectId: "proj-a", workspaceId: "ws-1", planId: "pro" }),
			null,
			workspaceRecord({ planId: "free" }),
		);
		expect(plan.id).toBe("pro");
	});

	test("reflects an explicit workspace storage override when there is no storage summary", () => {
		const plan = resolvePlanForDashboard(null, null, workspaceRecord({ planId: "creator", storageIncludedBytes: 5 * GIB, storageExtraBytes: 25 * GIB }));
		expect(plan.id).toBe("creator");
		expect(plan.includedStorageBytes).toBe(30 * GIB);
	});

	test("defaults to the env/free plan when neither usage, storage, nor workspace record is present", () => {
		const plan = resolvePlanForDashboard(null, null, null);
		expect(plan.id).toBe("free");
	});

	test("end-to-end: empty workspace (no projects) still produces a dashboard", async () => {
		// FS mode with no workspace store returns the default plan, but the empty
		// workspace must not throw and must report zeroed totals with no projects.
		const dashboard = await buildWorkspaceUsageDashboard(`ws-${uuid()}`, "user-1");
		expect(dashboard.projectIds).toEqual([]);
		expect(dashboard.projectCount).toBe(0);
		expect(dashboard.totals.monthly.uploadBytes).toBe(0);
		expect(dashboard.plan.id).toBe("free");
	});
});

// Round-2 finding #3: the dashboard roster must preserve the actor's scope, so a
// scoped admin/owner only sees members covered by their scope — exactly as the
// dedicated members route does via `scopeCoveredBy: actor.scope`.
describe("usage dashboard roster scope preservation", () => {
	function fakeRoster(pages: Array<{ members: WorkspaceMemberRecord[]; nextCursor?: string }>): {
		source: WorkspaceRosterSource;
		calls: Array<{ cursor?: string; scopeCoveredBy?: WorkspaceScope }>;
	} {
		const calls: Array<{ cursor?: string; scopeCoveredBy?: WorkspaceScope }> = [];
		let index = 0;
		const source: WorkspaceRosterSource = {
			async listMemberPage(_workspaceId, options) {
				calls.push({ cursor: options?.cursor, scopeCoveredBy: options?.scopeCoveredBy });
				return pages[index++] ?? { members: [] };
			},
		};
		return { source, calls };
	}

	test("forwards the actor scope as scopeCoveredBy on every page request", async () => {
		const actorScope: WorkspaceScope = { projectIds: ["proj-a"] };
		const { source, calls } = fakeRoster([
			{ members: [member("user-a", "editor")], nextCursor: "cursor-1" },
			{ members: [member("user-b", "viewer")] },
		]);

		const members = await collectScopedWorkspaceMembers(source, "ws-1", actorScope);

		expect(members.map((m) => m.userId)).toEqual(["user-a", "user-b"]);
		// The scope is forwarded on EVERY page (this is the leak the fix closes:
		// the old listMembers() call passed no scope at all).
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.scopeCoveredBy === actorScope)).toBe(true);
		expect(calls[0]?.cursor).toBeUndefined();
		expect(calls[1]?.cursor).toBe("cursor-1");
	});

	test("an unscoped actor (empty scope) still pages with scopeCoveredBy forwarded", async () => {
		const { source, calls } = fakeRoster([{ members: [member("user-a", "owner")] }]);

		const members = await collectScopedWorkspaceMembers(source, "ws-1", {});

		expect(members).toHaveLength(1);
		// Empty scope is forwarded verbatim; the store treats {} as "covers all".
		expect(calls[0]?.scopeCoveredBy).toEqual({});
	});
});

// P2 DB bottleneck fix: the dashboard build (which fans out several reads, most
// importantly the all-time COUNT over the high-volume usage_events table) is wrapped
// in the fail-open response cache. A second load within the TTL must serve the cached
// body WITHOUT recomputing, and the per-tenant cache key must never let two
// workspaces share an entry. Default cache in tests is the NoopResponseCache (always
// fresh), so these tests INJECT a real cache via options.cache.
describe("usage dashboard response cache", () => {
	// A ResponseCache wrapper that counts how many times `compute` actually runs, so
	// a cache HIT (no recompute) is observable.
	function countingCache(): { cache: ResponseCache; computeCount: () => number } {
		const inner = new MemoryResponseCache();
		let computes = 0;
		const cache: ResponseCache = {
			getOrSet(key, ttlSeconds, compute) {
				return inner.getOrSet(key, ttlSeconds, () => {
					computes += 1;
					return compute();
				});
			},
		};
		return { cache, computeCount: () => computes };
	}

	test("a second load within the TTL returns the cached body without recomputing", async () => {
		const workspaceId = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceId);
		await recordUploadUsage({ workspaceId, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 120 });

		const { cache, computeCount } = countingCache();

		const first = await buildWorkspaceUsageDashboard(workspaceId, "user-1", Date.now(), { cache });
		expect(computeCount()).toBe(1);
		expect(first.totals.monthly.uploadBytes).toBe(120);

		// Record MORE usage after the first build. A cache HIT must return the SAME
		// (stale-within-TTL) body and must NOT recompute — proving the expensive
		// fan-out (incl. the usage_events COUNT) did not run again.
		await recordUploadUsage({ workspaceId, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 999 });

		const second = await buildWorkspaceUsageDashboard(workspaceId, "user-1", Date.now(), { cache });
		expect(computeCount()).toBe(1); // no recompute
		expect(second).toEqual(first); // identical cached body, not the newer 1119 total
		expect(second.totals.monthly.uploadBytes).toBe(120);
	});

	test("two different workspaces never share a cache entry (per-tenant key)", async () => {
		const workspaceA = `ws-${uuid()}`;
		const workspaceB = `ws-${uuid()}`;
		const projectA = writeProjectState(workspaceA);
		const projectB = writeProjectState(workspaceB);
		await recordUploadUsage({ workspaceId: workspaceA, projectId: projectA, subjectId: `upload:${uuid()}`, bytes: 100 });
		await recordUploadUsage({ workspaceId: workspaceB, projectId: projectB, subjectId: `upload:${uuid()}`, bytes: 700 });

		const { cache, computeCount } = countingCache();

		const dashA = await buildWorkspaceUsageDashboard(workspaceA, "user-1", Date.now(), { cache });
		const dashB = await buildWorkspaceUsageDashboard(workspaceB, "user-1", Date.now(), { cache });

		// Both computed (distinct keys) — workspace B did NOT receive workspace A's body.
		expect(computeCount()).toBe(2);
		expect(dashA.workspaceId).toBe(workspaceA);
		expect(dashB.workspaceId).toBe(workspaceB);
		expect(dashA.totals.monthly.uploadBytes).toBe(100);
		expect(dashB.totals.monthly.uploadBytes).toBe(700);
	});

	test("cache key includes workspaceId and the response-shaping options (no cross-tenant / cross-scope reuse)", () => {
		const wsA = "ws-a";
		const wsB = "ws-b";

		// Distinct workspaces → distinct keys (per-tenant isolation).
		expect(workspaceUsageDashboardCacheKey(wsA, {})).not.toBe(workspaceUsageDashboardCacheKey(wsB, {}));

		// includeMembers shapes the body (roster present/absent) → distinct keys.
		expect(workspaceUsageDashboardCacheKey(wsA, { includeMembers: false }))
			.not.toBe(workspaceUsageDashboardCacheKey(wsA, { includeMembers: true }));

		// actorScope shapes WHICH members appear → distinct keys for distinct scopes.
		const scopeOne: WorkspaceScope = { projectIds: ["p1"] };
		const scopeTwo: WorkspaceScope = { projectIds: ["p2"] };
		expect(workspaceUsageDashboardCacheKey(wsA, { includeMembers: true, actorScope: scopeOne }))
			.not.toBe(workspaceUsageDashboardCacheKey(wsA, { includeMembers: true, actorScope: scopeTwo }));

		// Equivalent scopes (same fields, different key order) → SAME key (deterministic).
		expect(workspaceUsageDashboardCacheKey(wsA, { includeMembers: true, actorScope: { projectIds: ["p1"], languages: ["th"] } }))
			.toBe(workspaceUsageDashboardCacheKey(wsA, { includeMembers: true, actorScope: { languages: ["th"], projectIds: ["p1"] } }));

		// actorScope is irrelevant to the key when the roster is NOT included (it does
		// not shape the body), so a viewer's key is stable regardless of any scope.
		expect(workspaceUsageDashboardCacheKey(wsA, { includeMembers: false, actorScope: scopeOne }))
			.toBe(workspaceUsageDashboardCacheKey(wsA, { includeMembers: false, actorScope: scopeTwo }));

		// Whitespace around the workspace id is normalized into the same key.
		expect(workspaceUsageDashboardCacheKey(`  ${wsA}  `, {})).toBe(workspaceUsageDashboardCacheKey(wsA, {}));
	});
});
