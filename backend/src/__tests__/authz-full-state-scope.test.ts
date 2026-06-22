// SECURITY regression tests (codex authz audit, routes/project.ts):
//
//   1. [P1] Full-state SAVE (`POST /:id/save`) writes the client-supplied FULL
//      `ProjectState.pages` (EVERY language's `languageOutputs`). A LANGUAGE-SCOPED
//      collaborator must NOT be able to overwrite OTHER languages' data: a full save
//      requires update access for EVERY language track (= effectively unscoped),
//      while an unscoped owner/editor still saves normally.
//   2. [P1] Full version RESTORE replaces the WHOLE snapshot; a single-language
//      scoped user must not restore the whole project (same all-tracks requirement).
//   3. [P1] AI-marker create/update mass-assignment: server-owned fields
//      (`resultImageId`, `costEstimate`, `creditReservation`, `sourceMarkerId`,
//      `rerunIdempotencyKey`) are stripped from client input; an approval `status`
//      (`accepted`/`applied`) cannot be forged at creation.
//   4. [P2] Marker patch/comment/review-task authorize against the MARKER's actual
//      page/review scope (resolved first), so a page-scoped reviewer can act on an
//      in-scope marker instead of hitting a project-wide denial.
//
// Pattern mirrors usage-route-idor.test.ts: override DATA_DIR so routes read real
// on-disk state.json, mount the project route in a Hono app with an auth-injecting
// middleware, and stub projectCatalogStore.canAccessProject to model a workspace
// member's LANGUAGE scope (true only when the requested language is in scope).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

const originalDataDir = process.env.DATA_DIR;
const scopeDataDir = mkdtempSync(join(tmpdir(), "manga-authz-scope-test-"));
process.env.DATA_DIR = scopeDataDir;

const { PROJECTS_DIR } = await import("../config.js");
const { project } = await import("../routes/project.js");
const projectCatalogModule = await import("../services/project-catalog.js");
const { jobQueue } = await import("../services/queue.js");
import type { ProjectState } from "../types/index.js";

// Register a real AI job in the queue so the marker-create fail-closed jobId guard
// can resolve it. `projectId` controls whether the marker create is accepted
// (same project) or rejected (cross-project). Returns the registered jobId.
async function registerJob(jobId: string, projectId: string): Promise<string> {
	await jobQueue.add({
		jobId,
		projectId,
		imageId: "img-0",
		crop: { x: 0, y: 0, w: 10, h: 10 },
		lang: "en",
		prompt: "p",
		tier: "clean-pro",
		quality: "low",
		status: "done",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as Parameters<typeof jobQueue.add>[0]);
	return jobId;
}

const projectCatalogStore = projectCatalogModule.projectCatalogStore!;
const originalCanAccessProject = projectCatalogStore.canAccessProject.bind(projectCatalogStore);

// Membership model: projectId -> (userId -> allowed languages). An entry with
// `languages: null` is an UNSCOPED member (owner/editor) — allowed for every
// language. A `languages` array models a per-language scoped collaborator.
// A grant models a workspace member's fine-grained scope. `languages: null` means
// UNSCOPED (owner/editor — allowed for every language). A `languages` array is a
// per-language scope. `pageIndexes` (optional) additionally models a per-page scope
// (e.g. a member assigned a single page); when set, a check with an undefined
// `pageIndex` is "asking for everything" and denied — mirroring the real engine.
interface MemberGrant {
	userId: string;
	languages: string[] | null;
	pageIndexes?: number[];
}
const grants = new Map<string, MemberGrant[]>();

beforeEach(() => {
	grants.clear();
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = (async (input: {
		projectId: string;
		userId: string;
		language?: string;
		pageIndex?: number;
		requireProjectWide?: boolean;
	}) => {
		const grant = grants.get(input.projectId)?.find((g) => g.userId === input.userId);
		if (!grant) return false;
		const hasPageScope = Array.isArray(grant.pageIndexes) && grant.pageIndexes.length > 0;
		// A whole-project mutation (full save / full restore) demands TRULY
		// project-wide (unscoped) access: a member with ANY fine-grained scope
		// restriction (a non-null `languages` list OR a `pageIndexes` list) is rejected
		// even if their lists currently cover everything. Mirrors the real engine's
		// `requireProjectWide && isFineGrainedScope(scope)` short-circuit.
		if (input.requireProjectWide && (grant.languages !== null || hasPageScope)) return false;
		// Page scope (`isFineGrainedProjectWideAccess`): a `pageIndexes`-scoped member
		// whose check has no `pageIndex` is "asking for everything" → denied. With a
		// `pageIndex`, it must fall inside the scoped pages.
		if (hasPageScope) {
			if (input.pageIndex === undefined) return false;
			if (!grant.pageIndexes!.includes(input.pageIndex)) return false;
		}
		if (grant.languages === null) return true; // unscoped (re: languages) owner/editor
		// Scoped collaborator: a language-less check (`input.language` undefined) is
		// treated as "asking for everything" and denied — matching the real scope
		// engine (`hasScopeList(languages) && language === undefined`).
		if (input.language === undefined) return false;
		return grant.languages.includes(input.language);
	}) as typeof originalCanAccessProject;
});

afterEach(() => {
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = originalCanAccessProject;
});

afterAll(() => {
	rmSync(scopeDataDir, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
});

function makeProjectId(): string {
	return crypto.randomUUID();
}

function writeWorkspaceProject(projectId: string, overrides: Partial<ProjectState> = {}): void {
	const dir = join(PROJECTS_DIR, projectId);
	mkdirSync(dir, { recursive: true });
	const state: ProjectState = {
		projectId,
		userId: "",
		workspaceId: "ws-1",
		name: "WS Project",
		createdAt: new Date().toISOString(),
		pages: [{ imageId: "img-0", imageName: "page-0.png" }],
		currentPage: 0,
		targetLang: "en",
		targetLangs: ["en", "fr"],
		...overrides,
	} as ProjectState;
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function readState(projectId: string): ProjectState {
	return JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "state.json"), "utf8")) as ProjectState;
}

function appAs(user: { userId: string; email: string; role?: string } | null) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (user) {
			(c as { set: (key: string, value: unknown) => void }).set("user", {
				userId: user.userId,
				email: user.email,
				role: user.role ?? "editor",
			});
		}
		await next();
	});
	app.route("/api/project", project);
	return app;
}

function fullSaveBody(projectId: string, overrides: Partial<ProjectState> = {}) {
	return JSON.stringify({
		projectId,
		name: "WS Project",
		targetLang: "en",
		targetLangs: ["en", "fr"],
		pages: [{ imageId: "img-0", imageName: "page-0.png", textLayers: [] }],
		currentPage: 0,
		...overrides,
	});
}

function postSave(app: Hono, projectId: string, body: string) {
	return app.request(`/api/project/${projectId}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
}

describe("authz — full-state SAVE scope (P1)", () => {
	test("a LANGUAGE-SCOPED collaborator CANNOT full-save a multi-language project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		// Member is scoped to "en" only; the project has tracks ["en","fr"].
		grants.set(projectId, [{ userId: "translator-en", languages: ["en"] }]);

		const res = await postSave(appAs({ userId: "translator-en", email: "en@studio.com" }), projectId, fullSaveBody(projectId));
		// Denied: the full save touches "fr" too, which is out of the member's scope.
		expect(res.status).toBe(404);
		// State on disk is unchanged (no cross-language overwrite).
		expect(readState(projectId).name).toBe("WS Project");
	});

	test("an UNSCOPED owner/editor CAN full-save the multi-language project (no regression)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);

		const res = await postSave(
			appAs({ userId: "owner-a", email: "owner@studio.com" }),
			projectId,
			fullSaveBody(projectId, { name: "Renamed By Owner" }),
		);
		expect(res.status).toBe(200);
		expect(readState(projectId).name).toBe("Renamed By Owner");
	});

	test("a member scoped to ALL of the project's tracks STILL CANNOT full-save (requires unscoped project-wide access)", async () => {
		// P1: a full save writes SHARED, non-language project state too, so a
		// language-scoped member whose `scope.languages` happens to cover every
		// current track must NOT be able to full-save the whole project. Truly
		// project-wide (unscoped) access is required — a per-language check that
		// merely passes for each track is insufficient.
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "lead", languages: ["en", "fr"] }]);

		const res = await postSave(
			appAs({ userId: "lead", email: "lead@studio.com" }),
			projectId,
			fullSaveBody(projectId, { name: "Renamed By Lead" }),
		);
		expect(res.status).toBe(404);
		// State unchanged — the scoped member did not full-save shared project state.
		expect(readState(projectId).name).toBe("WS Project");
	});
});

describe("authz — full version RESTORE scope (P1)", () => {
	async function seedVersion(app: Hono, projectId: string): Promise<string> {
		// An unscoped owner saves once to materialize a version we can restore.
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		grants.set(projectId, [{ userId: "owner-a", languages: null }, ...(grants.get(projectId) ?? [])]);
		const saveRes = await postSave(ownerApp, projectId, fullSaveBody(projectId, { name: "v1" }));
		expect(saveRes.status).toBe(200);
		const listRes = await ownerApp.request(`/api/project/${projectId}/versions`);
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as { versions: Array<{ versionId: string }> };
		expect(list.versions.length).toBeGreaterThan(0);
		return list.versions[0].versionId;
	}

	test("a LANGUAGE-SCOPED collaborator CANNOT full-restore the whole project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "translator-en", languages: ["en"] }]);
		const versionId = await seedVersion(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId);

		const res = await appAs({ userId: "translator-en", email: "en@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect(res.status).toBe(404);
	});

	test("a member scoped to ALL of the project's tracks STILL CANNOT full-restore", async () => {
		// P1 mirror of the save case: a full restore replaces the WHOLE project
		// (shared state + every track), so it requires unscoped project-wide access.
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "lead", languages: ["en", "fr"] }]);
		const versionId = await seedVersion(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId);

		const res = await appAs({ userId: "lead", email: "lead@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect(res.status).toBe(404);
	});

	test("an UNSCOPED owner/editor CAN full-restore (no regression)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const versionId = await seedVersion(ownerApp, projectId);

		const res = await ownerApp.request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
	});

	// P1 REGRESSION (codex re-review): authz tightening reordered the restore handler
	// to run an empty/unscoped `update:project` check BEFORE parsing the restore body,
	// so a page-scoped member's SCOPED per-page restore was denied (an undefined
	// `pageIndex` against `scope.pageIndexes` reads as "asking for everything"). The
	// SCOPED path must authorize against the SAME page/language the restore targets, so
	// a member scoped to page 0 CAN selectively restore page 0 — while the FULL restore
	// still requires project-wide access.
	test("a PAGE-SCOPED member CAN selectively restore their in-scope page (P1 regression)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		// Member is scoped to page 0 + language "en"; the version we restore is "en".
		grants.set(projectId, [{ userId: "typer-p0", languages: ["en"], pageIndexes: [0] }]);
		const versionId = await seedVersion(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId);

		const res = await appAs({ userId: "typer-p0", email: "p0@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0 }) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.scope).toBe("page");
		expect(body.restoredPageIndex).toBe(0);
	});

	test("a PAGE-SCOPED member CANNOT full-restore the whole project (403/404)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "typer-p0", languages: ["en"], pageIndexes: [0] }]);
		const versionId = await seedVersion(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId);

		// Empty body = FULL restore → requireProjectWide → a page-scoped member is denied.
		const res = await appAs({ userId: "typer-p0", email: "p0@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect(res.status).toBe(404);
	});

	test("a PAGE-SCOPED member CANNOT restore a DIFFERENT (out-of-scope) page", async () => {
		const projectId = makeProjectId();
		// Two pages so page index 1 exists in current + snapshot but is out of scope.
		writeWorkspaceProject(projectId, {
			pages: [{ imageId: "img-0", imageName: "page-0.png" }, { imageId: "img-1", imageName: "page-1.png" }],
		});
		grants.set(projectId, [{ userId: "typer-p0", languages: ["en"], pageIndexes: [0] }]);
		// Seed a version that has both pages (owner full-saves a 2-page state).
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		grants.set(projectId, [{ userId: "owner-a", languages: null }, ...(grants.get(projectId) ?? [])]);
		const saveRes = await postSave(ownerApp, projectId, fullSaveBody(projectId, {
			name: "v1",
			pages: [
				{ imageId: "img-0", imageName: "page-0.png", textLayers: [] },
				{ imageId: "img-1", imageName: "page-1.png", textLayers: [] },
			],
		}));
		expect(saveRes.status).toBe(200);
		const listRes = await ownerApp.request(`/api/project/${projectId}/versions`);
		const list = (await listRes.json()) as { versions: Array<{ versionId: string }> };
		const versionId = list.versions[0].versionId;

		const res = await appAs({ userId: "typer-p0", email: "p0@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 1 }) },
		);
		// Page 1 is outside the member's page-0 scope → denied, never merged.
		expect(res.status).toBe(404);
	});

	// ── P1 (codex re-review): scoped per-page restore over-grant ──────────────────
	// A PAGE-scoped restore swaps the WHOLE `PageState` (applySelectiveRestore replaces
	// `pages[i]` wholesale, incl. `languageOutputs` for EVERY language on that page).
	// Authorizing only the caller's single language was an over-grant: a member scoped
	// to (page 0, "en") could overwrite "ja"/"fr"/… outputs (other translators' work)
	// on page 0. The page restore must now be authorized against the UNION of every
	// language present on the page (current + snapshot), so a single-language member is
	// rejected, while a member with access to ALL the page's languages may restore it.

	// Seed a version whose page 0 carries multi-language outputs ("en" default track +
	// "fr" languageOutputs), so a page-0 restore would overwrite the "fr" output too.
	async function seedMultiLangPageVersion(projectId: string): Promise<string> {
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		grants.set(projectId, [{ userId: "owner-a", languages: null }, ...(grants.get(projectId) ?? [])]);
		const saveRes = await postSave(ownerApp, projectId, fullSaveBody(projectId, {
			name: "multi-lang-v1",
			pages: [{
				imageId: "img-0",
				imageName: "page-0.png",
				textLayers: [],
				// "fr" is a non-default track on this page — its output is part of the
				// PageState that a page restore would overwrite.
				languageOutputs: { fr: { textLayers: [] } },
			}],
		}));
		expect(saveRes.status).toBe(200);
		const listRes = await ownerApp.request(`/api/project/${projectId}/versions`);
		const list = (await listRes.json()) as { versions: Array<{ versionId: string }> };
		return list.versions[0].versionId;
	}

	test("a member scoped to ONLY (page0, en) CANNOT per-page-restore page0 when page0 has other-language ('fr') outputs (over-grant fix)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			pages: [{
				imageId: "img-0",
				imageName: "page-0.png",
				textLayers: [],
				languageOutputs: { fr: { textLayers: [] } },
			}] as ProjectState["pages"],
		});
		const versionId = await seedMultiLangPageVersion(projectId);
		// Member is scoped to page 0 + language "en" ONLY. A page restore would also
		// overwrite the "fr" output, which is out of scope → must be denied.
		grants.set(projectId, [{ userId: "typer-p0-en", languages: ["en"], pageIndexes: [0] }]);

		const res = await appAs({ userId: "typer-p0-en", email: "p0en@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0 }) },
		);
		expect(res.status).toBe(404);
	});

	test("a member with access to ALL languages on page0 (en+fr) CAN per-page-restore page0", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			pages: [{
				imageId: "img-0",
				imageName: "page-0.png",
				textLayers: [],
				languageOutputs: { fr: { textLayers: [] } },
			}] as ProjectState["pages"],
		});
		const versionId = await seedMultiLangPageVersion(projectId);
		// Member is scoped to page 0 but to BOTH languages present on it → may restore.
		grants.set(projectId, [{ userId: "typer-p0-all", languages: ["en", "fr"], pageIndexes: [0] }]);

		const res = await appAs({ userId: "typer-p0-all", email: "p0all@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0 }) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.scope).toBe("page");
		expect(body.restoredPageIndex).toBe(0);
	});

	test("a project-wide owner CAN per-page-restore a multi-language page0", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			pages: [{
				imageId: "img-0",
				imageName: "page-0.png",
				textLayers: [],
				languageOutputs: { fr: { textLayers: [] } },
			}] as ProjectState["pages"],
		});
		const versionId = await seedMultiLangPageVersion(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);

		const res = await appAs({ userId: "owner-a", email: "owner@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0 }) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
	});

	test("a member scoped to ONLY (page0, en) CAN per-page-restore a SINGLE-LANGUAGE page0 (no regression)", async () => {
		// When page 0 has no other-language outputs, the only affected language is the
		// default "en" track, so the single-language member is still allowed.
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		grants.set(projectId, [{ userId: "typer-p0", languages: ["en"], pageIndexes: [0] }]);
		const versionId = await seedVersion(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId);

		const res = await appAs({ userId: "typer-p0", email: "p0@studio.com" }).request(
			`/api/project/${projectId}/versions/${versionId}/restore`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0 }) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).scope).toBe("page");
	});
});

describe("authz — shared story metadata requires project-wide scope (P1)", () => {
	function renameStory(app: Hono, projectId: string, storyTitle: string) {
		return app.request(`/api/project/${projectId}/story`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ storyTitle }),
		});
	}

	test("a LANGUAGE-SCOPED member CANNOT rename the shared story", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, { storyTitle: "Original Story", targetLang: "en", targetLangs: ["en", "fr"] });
		grants.set(projectId, [{ userId: "translator-en", languages: ["en"] }]);

		const res = await renameStory(appAs({ userId: "translator-en", email: "en@studio.com" }), projectId, "Hijacked Story");
		expect(res.status).toBe(404);
		expect(readState(projectId).storyTitle).toBe("Original Story");
	});

	test("a member scoped to ALL tracks STILL CANNOT rename the shared story (requires unscoped)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, { storyTitle: "Original Story", targetLang: "en", targetLangs: ["en", "fr"] });
		grants.set(projectId, [{ userId: "lead", languages: ["en", "fr"] }]);

		const res = await renameStory(appAs({ userId: "lead", email: "lead@studio.com" }), projectId, "Hijacked Story");
		expect(res.status).toBe(404);
		expect(readState(projectId).storyTitle).toBe("Original Story");
	});

	test("rename now also needs workspace catalog authority: a worker seat CANNOT, the workspace owner CAN (2026-06-13)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, { storyTitle: "Original Story" });
		grants.set(projectId, [
			{ userId: "owner-a", languages: null },
			{ userId: "worker-1", languages: null },
		]);

		// worker-1 is UNSCOPED in the catalog (passes the project-wide check) but
		// holds no workspace manage_projects authority — renaming the story is
		// catalog shaping and stays with the workspace leads.
		const denied = await renameStory(appAs({ userId: "worker-1", email: "worker@studio.com" }), projectId, "Hijacked Story");
		expect([403, 404]).toContain(denied.status);
		expect(readState(projectId).storyTitle).toBe("Original Story");

		// The workspace OWNER carries manage_projects and passes the new gate.
		const { workspaceAccessStore } = await import("../services/workspace-access.js");
		try {
			await workspaceAccessStore!.createWorkspace({ workspaceId: "ws-1", name: "Scope WS", ownerUserId: "owner-a" });
		} catch {
			// already created by an earlier run in this suite — idempotent setup
		}
		const res = await renameStory(appAs({ userId: "owner-a", email: "owner@studio.com" }), projectId, "Renamed By Owner");
		expect(res.status).toBe(200);
		expect(readState(projectId).storyTitle).toBe("Renamed By Owner");
	});
});

describe("authz — AI marker mass-assignment guard (P1)", () => {
	function writeSingleLangProject(projectId: string): void {
		writeWorkspaceProject(projectId, {
			targetLang: "en",
			targetLangs: ["en"],
			pages: [{ imageId: "img-0" }],
		});
	}

	test("forged server-owned fields are STRIPPED on marker create", async () => {
		const projectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const jobId = await registerJob(`job-forge-${projectId}`, projectId);

		const res = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jobId,
				pageIndex: 0,
				imageId: "img-0",
				region: { x: 0, y: 0, w: 10, h: 10 },
				tier: "clean-pro",
				// Forged server-owned fields — must NOT round-trip onto the marker.
				resultImageId: "stolen-result.png",
				costEstimate: { tier: "clean-pro", estimatedThb: 999 },
				creditReservation: { reservationId: "forged", amount: 999 },
				sourceMarkerId: "not-a-real-rerun-source",
				rerunIdempotencyKey: "forged-key",
			}),
		});
		expect(res.status).toBe(200);
		const marker = (await res.json()).marker;
		expect(marker.status).toBe("processing"); // server-defaulted
		expect(marker.resultImageId).toBeUndefined();
		expect(marker.costEstimate).toBeUndefined();
		expect(marker.creditReservation).toBeUndefined();
		expect(marker.sourceMarkerId).toBeUndefined();
		expect(marker.rerunIdempotencyKey).toBeUndefined();
	});

	test("marker create with a jobId from ANOTHER project is REJECTED (fail closed)", async () => {
		// P1: the jobId guard must fail CLOSED. A marker referencing a job that
		// belongs to a DIFFERENT project would let the reconciler copy that job's
		// resultImageId/cost/credit onto a marker the attacker can read.
		const projectId = makeProjectId();
		const otherProjectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });
		// Job exists, but is owned by a DIFFERENT project.
		const foreignJobId = await registerJob(`job-foreign-${otherProjectId}`, otherProjectId);

		const res = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: foreignJobId, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, tier: "clean-pro" }),
		});
		expect(res.status).toBe(400);
	});

	test("marker create with a NON-EXISTENT jobId is REJECTED (fail closed)", async () => {
		// P1: an unknown / not-yet-visible job is no longer tolerated — the guard
		// requires the referenced job to EXIST and belong to this project.
		const projectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });

		const res = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: `does-not-exist-${projectId}`, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, tier: "clean-pro" }),
		});
		expect(res.status).toBe(400);
	});

	test("marker create with a SAME-project jobId is ACCEPTED (legitimate link)", async () => {
		const projectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const jobId = await registerJob(`job-same-${projectId}`, projectId);

		const res = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, tier: "clean-pro" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).marker.jobId).toBe(jobId);
	});

	test("an approval status (accepted) CANNOT be forged at marker creation", async () => {
		const projectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });

		const res = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jobId: "job-x",
				pageIndex: 0,
				imageId: "img-0",
				region: { x: 0, y: 0, w: 10, h: 10 },
				status: "accepted",
				tier: "clean-pro",
			}),
		});
		// `accepted` is not in the create-status enum → validation 400.
		expect(res.status).toBe(400);
	});

	test("forged server-owned fields are STRIPPED on marker update", async () => {
		const projectId = makeProjectId();
		writeSingleLangProject(projectId);
		grants.set(projectId, [{ userId: "owner-a", languages: null }]);
		const app = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const jobId = await registerJob(`job-u-${projectId}`, projectId);

		const createRes = await app.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, status: "needs_review", tier: "clean-pro" }),
		});
		expect(createRes.status).toBe(200);
		const markerId = (await createRes.json()).marker.id;

		const patchRes = await app.request(`/api/project/${projectId}/ai-markers/${markerId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				status: "rejected", // legitimate user-driven review decision
				costEstimate: { tier: "clean-pro", estimatedThb: 999 },
				creditReservation: { reservationId: "forged" },
				resultImageId: "stolen.png",
				rerunIdempotencyKey: "forged",
			}),
		});
		expect(patchRes.status).toBe(200);
		const marker = (await patchRes.json()).marker;
		expect(marker.status).toBe("rejected"); // the user-driven field still applied
		expect(marker.costEstimate).toBeUndefined();
		expect(marker.creditReservation).toBeUndefined();
		expect(marker.resultImageId).toBeUndefined();
		expect(marker.rerunIdempotencyKey).toBeUndefined();
	});
});

describe("authz — marker action authorized against marker scope (P2)", () => {
	test("a PAGE/REVIEW-scoped reviewer can patch an in-scope marker", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, { targetLang: "en", targetLangs: ["en"], pages: [{ imageId: "img-0" }] });
		// Owner seeds a marker; the scoped reviewer then acts on it.
		grants.set(projectId, [
			{ userId: "owner-a", languages: null },
			// Reviewer is scoped to "en" — the marker's language. (The page/task scope
			// is modelled by canAccessProject returning true for this language; the
			// route now passes the marker's pageIndex + review taskType through.)
			{ userId: "reviewer-en", languages: ["en"] },
		]);
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const jobId = await registerJob(`job-r-${projectId}`, projectId);
		const createRes = await ownerApp.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, status: "needs_review", tier: "clean-pro" }),
		});
		expect(createRes.status).toBe(200);
		const markerId = (await createRes.json()).marker.id;

		// The scoped reviewer patches the marker — authorized against the marker's
		// resolved page/review scope, NOT an empty project-wide check.
		const patchRes = await appAs({ userId: "reviewer-en", email: "rev@studio.com" }).request(
			`/api/project/${projectId}/ai-markers/${markerId}`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) },
		);
		expect(patchRes.status).toBe(200);
		expect((await patchRes.json()).marker.status).toBe("rejected");
	});

	test("a reviewer can comment on an in-scope marker", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, { targetLang: "en", targetLangs: ["en"], pages: [{ imageId: "img-0" }] });
		grants.set(projectId, [
			{ userId: "owner-a", languages: null },
			{ userId: "reviewer-en", languages: ["en"] },
		]);
		const ownerApp = appAs({ userId: "owner-a", email: "owner@studio.com" });
		const jobId = await registerJob(`job-c-${projectId}`, projectId);
		const createRes = await ownerApp.request(`/api/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId, pageIndex: 0, imageId: "img-0", region: { x: 0, y: 0, w: 10, h: 10 }, status: "needs_review", tier: "clean-pro" }),
		});
		expect(createRes.status).toBe(200);
		const markerId = (await createRes.json()).marker.id;

		const commentRes = await appAs({ userId: "reviewer-en", email: "rev@studio.com" }).request(
			`/api/project/${projectId}/ai-markers/${markerId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Looks off near the edge" }) },
		);
		expect(commentRes.status).toBe(200);
	});
});
