// SECURITY regression test for the text-qa route's cross-tenant paid-quota
// borrow (codex audit, text-qa.ts).
//
// Before the fix, resolveQuotaPlanId only rejected a cross-USER personal project
// (state.userId !== caller). A WORKSPACE project has a workspaceId and NO userId,
// so that guard did nothing: any user who guessed a workspace project id resolved
// that workspace's (possibly paid) plan and consumed its larger Text-QA daily
// budget. The fix gates workspace plan resolution on real project membership via
// projectCatalogStore.canAccessProject.
//
// We assert via GET /api/text-qa/quota?projectId=… that:
//   - a MEMBER resolves the workspace's paid plan (studio, 40× budget),
//   - a NON-member falls back to the free default (no borrowed paid budget),
//   - an unauthenticated caller also gets the free default.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

const originalDataDir = process.env.DATA_DIR;
const originalWorkspacePlanId = process.env.WORKSPACE_PLAN_ID;
// Keep the global plan default at free so the non-member fallback is "free" and
// the test isolates the per-project membership gate (not the env override).
delete process.env.WORKSPACE_PLAN_ID;
const idorDataDir = mkdtempSync(join(tmpdir(), "manga-textqa-idor-test-"));
process.env.DATA_DIR = idorDataDir;

const WS_ID = `ws-idor-${crypto.randomUUID()}`;

const { PROJECTS_DIR } = await import("../config.js");
const { textQa } = await import("../routes/text-qa.js");
const projectCatalogModule = await import("../services/project-catalog.js");
// Assign the workspace a real paid (studio) plan through the live billing store
// so the resolved plan does NOT depend on the global WORKSPACE_PLAN_ID env — the
// only way a caller reaches it is by passing the per-project membership gate.
const { billingStore } = await import("../services/billing-store.js");
import type { ProjectState } from "../types/index.js";

const projectCatalogStore = projectCatalogModule.projectCatalogStore!;
const originalCanAccessProject = projectCatalogStore.canAccessProject.bind(projectCatalogStore);

const members = new Map<string, Set<string>>();

beforeAll(async () => {
	await billingStore.setWorkspacePlan({ workspaceId: WS_ID, planId: "studio" });
});

beforeEach(() => {
	members.clear();
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = (async (input: {
		projectId: string;
		userId: string;
	}) => members.get(input.projectId)?.has(input.userId) ?? false) as typeof originalCanAccessProject;
});

afterEach(() => {
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = originalCanAccessProject;
});

afterAll(() => {
	rmSync(idorDataDir, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
	if (originalWorkspacePlanId === undefined) delete process.env.WORKSPACE_PLAN_ID;
	else process.env.WORKSPACE_PLAN_ID = originalWorkspacePlanId;
});

function writeWorkspaceProject(projectId: string): void {
	const dir = join(PROJECTS_DIR, projectId);
	mkdirSync(dir, { recursive: true });
	const state: ProjectState = {
		projectId,
		userId: "",
		workspaceId: WS_ID,
		name: "WS Project",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "en",
	} as ProjectState;
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function appAs(user: { userId: string; email: string } | null) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (user) {
			(c as { set: (key: string, value: unknown) => void }).set("user", {
				userId: user.userId,
				email: user.email,
				role: "editor",
			});
		}
		await next();
	});
	app.route("/api/text-qa", textQa);
	return app;
}

interface QuotaBody {
	enabled: boolean;
	quota: { planId: string; limitChars: number };
}

async function getQuota(app: Hono, projectId: string): Promise<QuotaBody> {
	const res = await app.request(`/api/text-qa/quota?projectId=${projectId}`);
	expect(res.status).toBe(200);
	return (await res.json()) as QuotaBody;
}

describe("text-qa route — cross-tenant paid-quota borrow", () => {
	test("a MEMBER of the workspace resolves the workspace's paid (studio) Text-QA budget", async () => {
		const projectId = crypto.randomUUID();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["member-a"]));

		const quota = await getQuota(appAs({ userId: "member-a", email: "a@studio.com" }), projectId);
		expect(quota.quota.planId).toBe("studio");
	});

	test("a NON-member CANNOT borrow the workspace's paid budget — falls back to free", async () => {
		const projectId = crypto.randomUUID();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["member-a"]));

		const memberQuota = await getQuota(appAs({ userId: "member-a", email: "a@studio.com" }), projectId);
		const intruderQuota = await getQuota(appAs({ userId: "intruder", email: "evil@x.com" }), projectId);

		expect(intruderQuota.quota.planId).toBe("free");
		// And the free budget is strictly smaller than the paid one the member sees,
		// proving the intruder did not inherit the workspace's larger quota.
		expect(intruderQuota.quota.limitChars).toBeLessThan(memberQuota.quota.limitChars);
	});

	test("an unauthenticated caller cannot borrow the workspace's paid budget", async () => {
		const projectId = crypto.randomUUID();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["member-a"]));

		const anonQuota = await getQuota(appAs(null), projectId);
		expect(anonQuota.quota.planId).toBe("free");
	});
});
