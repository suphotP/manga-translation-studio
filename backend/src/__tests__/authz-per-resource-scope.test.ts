// Per-resource scope authorization regression tests (codex P1 audit follow-up to
// #329): four routes that checked a WORKSPACE permission but then skipped the
// fine-grained resource/scope check. Each fix is proven here against the REAL
// file-mode workspace + project-catalog stores by narrowing the owning member's
// `scope` in place (the same technique project-check-ownership.test.ts uses —
// file mode cannot invite a scoped collaborator, but the routes read the same
// member scope object through requirePermission / canAccessProject):
//
//   1. storage  — DELETE asset must enforce project/page/asset scope, not just
//      workspace `update_project`.
//   2. tm       — POST /api/tm must scope writes by source+target language +
//      project (mirroring TM SEARCH), not just `update_project`.
//   3. export   — saving a WORKSPACE-WIDE export preset requires UNSCOPED
//      authority; a fine-grained-scoped manager is rejected.
//   4. perf     — POST /api/perf/event must validate project access for the actor
//      and bind the recorded role to the subject's real task-type scope.
//   5. review   — POST /api/project/:id/review-assignments and /revisions hand out
//      WHOLE-PROJECT review/revision work; a fine-grained-scoped manager (manage_members
//      confined to one language/page) must be rejected, mirroring chapter-team manage.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import sharp from "sharp";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import { workspaceAccessStore } from "../services/workspace-access.js";
import type { WorkspaceScope } from "../services/workspace-access.js";
import {
	InMemoryTmStore,
	TranslationMemoryService,
	setTranslationMemoryServiceForTests,
} from "../services/translation-memory.js";
import {
	setExportPresetStoreForTests,
	type ExportPresetRecord,
	type ExportPresetStore,
} from "../routes/export.js";

let app: Hono;
const createdUserIds: string[] = [];
const previousModeration = process.env.OPENAI_MODERATION_ENABLED;

beforeAll(async () => {
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";
	process.env.OPENAI_MODERATION_ENABLED = "false";
	app = (await import("../index.js")).app as unknown as Hono;
});

afterAll(async () => {
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
	if (previousModeration === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
	else process.env.OPENAI_MODERATION_ENABLED = previousModeration;
});

async function makeVerifiedUser(prefix: string): Promise<{ id: string; email: string; token: string }> {
	const created = await createUser({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "StrongP@ss123", name: prefix });
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, email: user!.email, token: tokens.accessToken };
}

function authHeaders(token: string, json = false): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

async function createWorkspace(token: string, name: string): Promise<string> {
	const res = await app.request("/api/workspaces", { method: "POST", headers: authHeaders(token, true), body: JSON.stringify({ name }) });
	expect(res.status).toBe(201);
	return ((await res.json()) as { workspace: { workspaceId: string } }).workspace.workspaceId;
}

async function createWorkspaceProject(token: string, workspaceId: string, name: string): Promise<string> {
	const res = await app.request("/api/project/new", { method: "POST", headers: authHeaders(token, true), body: JSON.stringify({ name, lang: "th", workspaceId }) });
	expect(res.status).toBe(200);
	return ((await res.json()) as { projectId: string }).projectId;
}

async function uploadImage(token: string, projectId: string, name: string, width: number, height: number): Promise<string> {
	const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
	const fd = new FormData();
	fd.append("images", new Blob([buffer], { type: "image/png" }), name);
	const res = await app.request(`/api/images/${projectId}/upload`, { method: "POST", headers: authHeaders(token), body: fd });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { imageIds: string[] };
	expect(body.imageIds.length).toBe(1);
	return body.imageIds[0]!;
}

type MutableMember = { workspaceId: string; userId: string; scope: WorkspaceScope; memberStudioRole?: string };

function findMember(workspaceId: string, userId: string): MutableMember {
	const members = (workspaceAccessStore as unknown as { members?: MutableMember[] }).members;
	const member = members?.find((m) => m.workspaceId === workspaceId && m.userId === userId);
	if (!member) throw new Error("Expected workspace member to narrow");
	return member;
}

// Narrow (or restore) a member's scope in the in-memory file store. Returns the
// previous scope so a test can restore the unscoped owner for a positive case.
function setMemberScope(workspaceId: string, userId: string, scope: WorkspaceScope): WorkspaceScope {
	const member = findMember(workspaceId, userId);
	const previous = member.scope;
	member.scope = scope;
	return previous;
}

// Narrow the member's STUDIO role (production contributor, not a privileged
// owner/admin/team_lead) so task-type role provenance is actually enforced.
function setMemberStudioRole(workspaceId: string, userId: string, studioRole: string): void {
	findMember(workspaceId, userId).memberStudioRole = studioRole;
}

// ── 1. Storage: asset delete must enforce per-page/asset scope ──────────────────

describe("storage DELETE asset — per-resource scope", () => {
	test("a page-scoped member is 403 deleting an asset referenced by an out-of-scope page; unscoped owner succeeds", async () => {
		const owner = await makeVerifiedUser("scope-storage-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Storage WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Scope Storage Story");
		const onPage1 = await uploadImage(owner.token, projectId, "p1.png", 200, 200);
		const onPage2 = await uploadImage(owner.token, projectId, "p2.png", 210, 210);

		// Two live pages, each referencing one image.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = (await stateRes.json()) as Record<string, unknown>;
		state.pages = [
			{ imageId: onPage1, imageName: "p1.png", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null },
			{ imageId: onPage2, imageName: "p2.png", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null },
		];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Narrow the (only) member to page index 0 only.
		const previous = setMemberScope(workspaceId, owner.id, { pageIndexes: [0] });

		// Deleting the asset on page index 1 (the out-of-scope page) is rejected.
		const deniedRes = await app.request(`/api/storage/projects/${projectId}/assets/${onPage2}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("asset_scope_denied");

		// The asset on the in-scope page (index 0) can still be force-deleted.
		const allowedRes = await app.request(`/api/storage/projects/${projectId}/assets/${onPage1}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(allowedRes.status).toBe(200);

		// Restore unscoped authority → the previously-denied asset now deletes.
		setMemberScope(workspaceId, owner.id, previous);
		const ownerRes = await app.request(`/api/storage/projects/${projectId}/assets/${onPage2}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(ownerRes.status).toBe(200);
	});
});

// ── 2. Translation memory: writes must be language/project scoped ───────────────

describe("POST /api/tm — language + project scope on writes", () => {
	let restoreTm: () => void = () => {};
	afterEach(() => {
		restoreTm();
		restoreTm = () => {};
	});

	test("a language-scoped member cannot seed TM for an out-of-scope language pair; an in-scope write succeeds", async () => {
		restoreTm = setTranslationMemoryServiceForTests(
			new TranslationMemoryService({ store: new InMemoryTmStore(), embedder: async () => [1, 0, 0, 0] }),
		);
		const owner = await makeVerifiedUser("scope-tm-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope TM WS");

		// Scope the member to en->ja only.
		setMemberScope(workspaceId, owner.id, { languages: ["en", "ja"] });

		// Out-of-scope target language "ko" is rejected by the language scope check.
		const deniedRes = await app.request("/api/tm", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, sourceText: "hello", sourceLang: "en", targetText: "안녕", targetLang: "ko" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("workspace_scope_denied");

		// In-scope en->ja write succeeds.
		const allowedRes = await app.request("/api/tm", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, sourceText: "hello", sourceLang: "en", targetText: "こんにちは", targetLang: "ja" }),
		});
		expect(allowedRes.status).toBe(201);
	});

	test("a project-scoped member cannot attribute a TM write to an out-of-scope project", async () => {
		restoreTm = setTranslationMemoryServiceForTests(
			new TranslationMemoryService({ store: new InMemoryTmStore(), embedder: async () => [1, 0, 0, 0] }),
		);
		const owner = await makeVerifiedUser("scope-tm-proj-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope TM Proj WS");

		setMemberScope(workspaceId, owner.id, { projectIds: ["project-allowed"] });

		const deniedRes = await app.request("/api/tm", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, sourceText: "hi", sourceLang: "en", targetText: "やあ", targetLang: "ja", projectId: "project-elsewhere" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("workspace_scope_denied");

		const allowedRes = await app.request("/api/tm", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, sourceText: "hi", sourceLang: "en", targetText: "やあ", targetLang: "ja", projectId: "project-allowed" }),
		});
		expect(allowedRes.status).toBe(201);
	});
});

// ── 3. Export presets: workspace-wide config requires UNSCOPED authority ─────────

class InMemoryExportPresetStore implements ExportPresetStore {
	private readonly rows: ExportPresetRecord[] = [];
	async save(record: ExportPresetRecord): Promise<ExportPresetRecord> {
		this.rows.push(record);
		return record;
	}
	async listByWorkspace(workspaceId: string): Promise<ExportPresetRecord[]> {
		return this.rows.filter((r) => r.workspaceId === workspaceId);
	}
}

describe("POST /api/export/presets — workspace-wide preset requires unscoped authority", () => {
	let restorePreset: () => void = () => {};
	afterEach(() => {
		restorePreset();
		restorePreset = () => {};
	});

	test("a fine-grained-scoped manager is rejected; an unscoped owner can save", async () => {
		restorePreset = setExportPresetStoreForTests(new InMemoryExportPresetStore());
		const owner = await makeVerifiedUser("scope-preset-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Preset WS");

		// Even a scope whose lists cover everything today is still fine-grained.
		const previous = setMemberScope(workspaceId, owner.id, { projectIds: ["only-this-project"] });

		const deniedRes = await app.request("/api/export/presets", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, name: "Scoped Preset", config: { format: "png" } }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("workspace_preset_scope_denied");

		// Unscoped owner can save the workspace-wide preset.
		setMemberScope(workspaceId, owner.id, previous);
		const allowedRes = await app.request("/api/export/presets", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, name: "Workspace Preset", config: { format: "png" } }),
		});
		expect(allowedRes.status).toBe(201);
	});
});

// ── 4. Performance: project access + role provenance ────────────────────────────

describe("POST /api/perf/event — project scope + role provenance", () => {
	test("a task-scoped member cannot forge a role outside their task types; their own role is accepted", async () => {
		const owner = await makeVerifiedUser("scope-perf-role-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Perf Role WS");

		// A non-privileged production contributor (cleaner) scoped to the CLEAN task
		// type only. (An owner/admin/team_lead is privileged and may report any role.)
		setMemberStudioRole(workspaceId, owner.id, "cleaner");
		setMemberScope(workspaceId, owner.id, { taskTypes: ["clean"] });

		// Forging a high-value "translator" event is rejected (translate not in scope).
		const deniedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, role: "translator", eventType: "page_submitted" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("perf_role_scope_denied");

		// Reporting their actual (cleaner) role is accepted.
		const allowedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, role: "cleaner", eventType: "page_submitted" }),
		});
		expect(allowedRes.status).toBe(200);
	});

	test("a project-scoped member cannot attribute a perf event to an out-of-scope project; an in-scope project is accepted", async () => {
		const owner = await makeVerifiedUser("scope-perf-proj-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Perf Proj WS");
		const inScopeProject = await createWorkspaceProject(owner.token, workspaceId, "In Scope Story");
		const outScopeProject = await createWorkspaceProject(owner.token, workspaceId, "Out Of Scope Story");

		// Restrict to the in-scope project only (no task-type restriction → any role ok).
		setMemberScope(workspaceId, owner.id, { projectIds: [inScopeProject] });

		const deniedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, projectId: outScopeProject, role: "translator", eventType: "page_submitted" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("perf_project_scope_denied");

		const allowedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, projectId: inScopeProject, role: "translator", eventType: "page_submitted" }),
		});
		expect(allowedRes.status).toBe(200);
	});

	test("an unscoped owner can report any role with no project (regression: legit flow preserved)", async () => {
		const owner = await makeVerifiedUser("scope-perf-unscoped-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Perf Unscoped WS");
		const res = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId, role: "translator", eventType: "page_submitted" }),
		});
		expect(res.status).toBe(200);
	});

	test("a project owned by a DIFFERENT workspace cannot be bound to data.workspaceId (cross-workspace binding bypass)", async () => {
		// Same actor owns BOTH workspaces, so the per-member project scope check would
		// pass for the project — the ONLY thing that stops the cross-workspace pollution is
		// the workspace-binding gate that resolves the project's REAL owning workspace.
		const owner = await makeVerifiedUser("scope-perf-xws-owner");
		const workspaceA = await createWorkspace(owner.token, "Perf X-WS A");
		const workspaceB = await createWorkspace(owner.token, "Perf X-WS B");
		const projectInB = await createWorkspaceProject(owner.token, workspaceB, "Project In B");

		// Attribute a metrics event to workspace A while pointing at a project that really
		// lives in workspace B — must be rejected as a workspace mismatch.
		const deniedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId: workspaceA, projectId: projectInB, role: "translator", eventType: "page_submitted" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(((await deniedRes.json()) as { code?: string }).code).toBe("perf_project_workspace_mismatch");

		// Binding the SAME project under its real workspace (B) still succeeds.
		const allowedRes = await app.request("/api/perf/event", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ workspaceId: workspaceB, projectId: projectInB, role: "translator", eventType: "page_submitted" }),
		});
		expect(allowedRes.status).toBe(200);
	});
});

// ── 5. Review/revision assignment: whole-project work requires UNSCOPED authority ─

describe("POST /api/project/:id/review-assignments + /revisions — fine-grained scope rejected", () => {
	test("a fine-grained-scoped manage_members member is 403 on assign + revision create; an unscoped owner can assign", async () => {
		const owner = await makeVerifiedUser("scope-review-owner");
		const workspaceId = await createWorkspace(owner.token, "Scope Review WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Scope Review Story");

		// Narrow the owning member to a single page — still holds manage_members, but the
		// scope is now fine-grained, so they must not be able to create whole-project work.
		const previous = setMemberScope(workspaceId, owner.id, { pageIndexes: [0] });

		const assignDenied = await app.request(`/api/project/${projectId}/review-assignments`, {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ assigneeUserId: owner.id }),
		});
		expect(assignDenied.status).toBe(403);
		expect(((await assignDenied.json()) as { code?: string }).code).toBe("workspace_review_assignment_scope_denied");

		const revisionDenied = await app.request(`/api/project/${projectId}/revisions`, {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ assignedToUserId: owner.id, reason: "please redo" }),
		});
		expect(revisionDenied.status).toBe(403);
		expect(((await revisionDenied.json()) as { code?: string }).code).toBe("workspace_review_assignment_scope_denied");

		// Restore unscoped authority → assigning whole-project review work succeeds.
		setMemberScope(workspaceId, owner.id, previous);
		const assignAllowed = await app.request(`/api/project/${projectId}/review-assignments`, {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ assigneeUserId: owner.id }),
		});
		expect(assignAllowed.status).toBe(200);
	});
});

// ── 5. Storage asset LISTING must enforce per-member scope (F2 audit) ────────────
// The DELETE path (test 1) already scopes; the LISTING did not — it gated only on
// read_workspace (role-only, never consults scope) and listed EVERY workspace
// project, so a member scoped to one project could enumerate the whole workspace's
// asset inventory. The fix reuses the per-member scope filter the Library uses.
describe("GET /api/storage/workspaces/:id/assets — per-member project scope (F2)", () => {
	test("a project-scoped member sees ONLY their scoped project; out-of-scope drill-in is 404", async () => {
		const owner = await makeVerifiedUser("scope-assets-owner");
		const workspaceId = await createWorkspace(owner.token, "Assets Scope WS");
		const projectA = await createWorkspaceProject(owner.token, workspaceId, "Chapter A");
		const projectB = await createWorkspaceProject(owner.token, workspaceId, "Chapter B");
		await uploadImage(owner.token, projectA, "a.png", 100, 100);
		await uploadImage(owner.token, projectB, "b.png", 120, 120);

		// Unscoped owner sees BOTH projects.
		const fullRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect(fullRes.status).toBe(200);
		const full = (await fullRes.json()) as { projects: Array<{ projectId: string }> };
		const fullIds = new Set(full.projects.map((p) => p.projectId));
		expect(fullIds.has(projectA) && fullIds.has(projectB)).toBe(true);

		// Narrow to project A only → project B must vanish from the listing.
		const previous = setMemberScope(workspaceId, owner.id, { projectIds: [projectA] });
		const scopedRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect(scopedRes.status).toBe(200);
		const scoped = (await scopedRes.json()) as { projects: Array<{ projectId: string }> };
		const scopedIds = new Set(scoped.projects.map((p) => p.projectId));
		expect(scopedIds.has(projectA)).toBe(true);
		expect(scopedIds.has(projectB)).toBe(false); // the leak: B must NOT be enumerable

		// A drill-in to the out-of-scope project is denied (was previously allowed).
		const drillRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets?projectId=${projectB}`, { headers: authHeaders(owner.token) });
		expect(drillRes.status).toBe(404);

		setMemberScope(workspaceId, owner.id, previous);
	});
});
