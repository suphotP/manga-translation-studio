// Codex P1 follow-ups for PR #263 (story DELETE tombstone):
//
//  P1.1 — the deletion tombstone is now WRITE-FIRST, so it is part of the DELETE
//         success invariant: if the tombstone write fails, NOTHING is deleted and
//         the request fails (the project stays fully intact + readable). After a
//         200 the tombstone is GUARANTEED and the project can never be read again.
//
//  P1.2 — every shared file-mode project-state read now funnels through one
//         tombstone-aware helper (`readProjectStateFileGuarded`), so a tombstoned
//         id with a stale state.json can no longer re-enable export / images /
//         text-qa / ai / crops / usage operations.
//
// Run in isolation to avoid the known cross-file config-cache pollution:
//   bun test src/__tests__/tombstone-read-guard.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const originalDataDir = process.env.DATA_DIR;
const guardDataDir = mkdtempSync(join(tmpdir(), "manga-tombstone-guard-"));
process.env.DATA_DIR = guardDataDir;
// Exercise the legacy anonymous prototype paths so DELETE / reads resolve without
// a full auth/workspace setup (the tombstone refusal happens BEFORE auth anyway).
process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS = "true";

const { PROJECTS_DIR, serverConfig } = await import("../config.js");
Object.assign(serverConfig as unknown as Record<string, unknown>, {
	apiAuthRequired: false,
	allowLegacyAnonymousProjects: true,
});
const { readProjectStateFileGuarded } = await import("../utils/project-state-file.js");
const { PROJECT_TOMBSTONES_DIR_NAME, isProjectTombstonedIn, safePath } = await import("../utils/security.js");
const { project, loadProjectState } = await import("../routes/project.js");
const { exportRoutes } = await import("../routes/export.js");
const { images } = await import("../routes/images.js");
import type { ProjectState } from "../types/index.js";

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
	try {
		rmSync(guardDataDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

function makeState(projectId: string, overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId,
		userId: "",
		name: "Tombstone Test",
		storyTitle: "Tombstone Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "en",
		...overrides,
	} as ProjectState;
}

function projectDir(projectId: string): string {
	return join(PROJECTS_DIR, projectId);
}

function writeStateFile(projectId: string, overrides: Partial<ProjectState> = {}): ProjectState {
	const dir = projectDir(projectId);
	mkdirSync(dir, { recursive: true });
	const state = makeState(projectId, overrides);
	writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
	return state;
}

// Mirror writeProjectTombstone WITHOUT going through a delete, so a test can
// simulate "this id is already tombstoned" cheaply.
function writeTombstone(projectId: string): void {
	const dir = safePath(PROJECTS_DIR, PROJECT_TOMBSTONES_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(safePath(dir, projectId), `${new Date().toISOString()}\n`);
}

function clearTombstone(projectId: string): void {
	rmSync(safePath(PROJECTS_DIR, PROJECT_TOMBSTONES_DIR_NAME, projectId), { force: true });
}

function freshId(): string {
	return randomUUID();
}

beforeEach(() => {
	// Clear any project dirs / tombstones between tests for a clean slate.
	for (const entry of existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR) : []) {
		rmSync(join(PROJECTS_DIR, entry), { recursive: true, force: true });
	}
});

describe("readProjectStateFileGuarded — the single tombstone-aware chokepoint", () => {
	test("serves a live project's state", () => {
		const id = freshId();
		const written = writeStateFile(id, { name: "Live" });
		const read = readProjectStateFileGuarded<ProjectState>(id);
		expect(read).not.toBeNull();
		expect(read!.name).toBe("Live");
		expect(read!.projectId).toBe(written.projectId);
	});

	test("REFUSES a tombstoned id even when a stale state.json survives", () => {
		const id = freshId();
		writeStateFile(id, { name: "Stale survivor" });
		writeTombstone(id);
		// A stale state.json is on disk AND readable, but the tombstone wins.
		expect(existsSync(join(projectDir(id), "state.json"))).toBe(true);
		expect(isProjectTombstonedIn(PROJECTS_DIR, id)).toBe(true);
		expect(readProjectStateFileGuarded(id)).toBeNull();
	});

	test("a re-created/written id reads fine again once the tombstone is cleared (writeProjectState clears it)", () => {
		const id = freshId();
		writeStateFile(id);
		writeTombstone(id);
		expect(readProjectStateFileGuarded(id)).toBeNull();
		// writeProjectState clears the tombstone for a (re)written id; simulate that.
		clearTombstone(id);
		writeStateFile(id, { name: "Recreated" });
		const read = readProjectStateFileGuarded<ProjectState>(id);
		expect(read).not.toBeNull();
		expect(read!.name).toBe("Recreated");
	});

	test("returns null for an invalid (non-UUID) id without touching disk", () => {
		expect(readProjectStateFileGuarded("not-a-uuid")).toBeNull();
	});

	test("returns null for a missing project", () => {
		expect(readProjectStateFileGuarded(freshId())).toBeNull();
	});
});

describe("P1.1 — DELETE writes the tombstone first (success invariant)", () => {
	async function del(id: string, confirmStoryTitle: string): Promise<Response> {
		return project.request(`/${id}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmStoryTitle }),
		});
	}

	test("a successful DELETE guarantees the tombstone AND the project can never be read again", async () => {
		const id = freshId();
		writeStateFile(id, { storyTitle: "Delete Me", name: "Delete Me" });
		const res = await del(id, "Delete Me");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, deleted: true, projectId: id });
		// Tombstone guaranteed.
		expect(isProjectTombstonedIn(PROJECTS_DIR, id)).toBe(true);
		// Disk dir gone, and every guarded read refuses the id.
		expect(existsSync(projectDir(id))).toBe(false);
		expect(readProjectStateFileGuarded(id)).toBeNull();
		expect(await loadProjectState(id)).toBeNull();
	});

	test("tombstone-write failure → 500 and NOTHING deleted / NOT resurrectable", async () => {
		const id = freshId();
		writeStateFile(id, { storyTitle: "Keep Me", name: "Keep Me" });
		// Force writeProjectTombstone to throw: replace the .tombstones DIR with a
		// FILE so its mkdirSync(recursive) throws ENOTDIR. The delete must abort
		// BEFORE rmSync/catalog, leaving the project fully intact + readable.
		const tombstonesPath = safePath(PROJECTS_DIR, PROJECT_TOMBSTONES_DIR_NAME);
		rmSync(tombstonesPath, { recursive: true, force: true });
		writeFileSync(tombstonesPath, "not-a-dir");
		try {
			const res = await del(id, "Keep Me");
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ code: "project_delete_tombstone_failed" });
			// Nothing deleted: state.json still on disk and the project still reads.
			expect(existsSync(join(projectDir(id), "state.json"))).toBe(true);
		} finally {
			// Restore the .tombstones path to a directory for later tests.
			rmSync(tombstonesPath, { force: true });
			mkdirSync(tombstonesPath, { recursive: true });
		}
		// Not tombstoned, and still readable through the guarded helper + catalog reader.
		expect(isProjectTombstonedIn(PROJECTS_DIR, id)).toBe(false);
		expect(readProjectStateFileGuarded(id)).not.toBeNull();
		expect(await loadProjectState(id)).not.toBeNull();
	});

	test("DELETE without a matching confirmation title is refused (existing confirm guard still passes)", async () => {
		const id = freshId();
		writeStateFile(id, { storyTitle: "Real Title", name: "Real Title" });
		const res = await del(id, "Wrong Title");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "delete_confirmation_mismatch" });
		// Untouched + readable.
		expect(isProjectTombstonedIn(PROJECTS_DIR, id)).toBe(false);
		expect(readProjectStateFileGuarded(id)).not.toBeNull();
	});
});

describe("P1.2 — read paths refuse a tombstoned id (not served from a stale state.json)", () => {
	test("export refuses a tombstoned project (404), but serves a live one", async () => {
		const liveId = freshId();
		const deadId = freshId();
		writeStateFile(liveId);
		writeStateFile(deadId);
		writeTombstone(deadId);

		const deadRes = await exportRoutes.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: deadId, preset: "master" }),
		});
		expect(deadRes.status).toBe(404);
		expect(await deadRes.json()).toMatchObject({ code: "project_not_found" });

		// The live project gets PAST the tombstone/auth gate (it fails later for an
		// unrelated reason — e.g. no pages — but NOT with project_not_found).
		const liveRes = await exportRoutes.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: liveId, preset: "master" }),
		});
		const liveBody = await liveRes.json().catch(() => ({}));
		expect((liveBody as { code?: string }).code).not.toBe("project_not_found");
	});

	test("images refuse a tombstoned project (404 'Project not found') at the ownership gate, but pass a live one", async () => {
		const liveId = freshId();
		const deadId = freshId();
		writeStateFile(liveId);
		writeStateFile(deadId);
		writeTombstone(deadId);

		// GET /:projectId/assets funnels straight through checkProjectOwnership. A
		// tombstoned project must be refused with "Project not found".
		const deadRes = await images.request(`/${deadId}/assets`, { method: "GET" });
		expect(deadRes.status).toBe(404);
		expect(await deadRes.json().catch(() => ({}))).toMatchObject({ error: "Project not found" });

		// The live project clears the ownership gate (200 with an assets payload).
		const liveRes = await images.request(`/${liveId}/assets`, { method: "GET" });
		expect(liveRes.status).toBe(200);
	});
});
