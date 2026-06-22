// P0 — invited active CHAPTER-TEAM members must be able to READ/LOAD a workspace
// project's images (so the editor shows page images), even though they are NOT a
// workspace-level catalog member. routes/images.ts::checkProjectOwnership must be
// in parity with routes/project.ts::checkProjectOwnership for the chapter-team
// grant + the workspace-suspension freeze:
//   - an ACTIVE chapter-team member passes a read:project image check → null
//   - a PENDING (email-only) invitee gets nothing → 404
//   - a stranger (no membership) gets nothing → 404
//   - a FROZEN (suspended) workspace still blocks MUTATING image ops
//     (update:project) for everyone, while reads still pass.
//
// In the file-mode test runtime `projectCatalogStore` is null, so the catalog
// `canAccessProject` path can never grant access — that deliberately forces the
// chapter-team fallback to be the thing under test.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import sharp from "sharp";

const originalDataDir = process.env.DATA_DIR;
const imagesDataDir = mkdtempSync(join(tmpdir(), "manga-images-ownership-test-"));
process.env.DATA_DIR = imagesDataDir;

const { PROJECTS_DIR, serverConfig } = await import("../config.js");
const { checkImageProjectOwnership, images } = await import("../routes/images.js");
const { workspaceAccessStore } = await import("../services/workspace-access.js");
const realtimeBusModule = await import("../services/realtime-bus.js");
import type { ChapterTeamMember, ProjectState } from "../types/index.js";
import type { JWTPayload } from "../types/auth.js";
import type { RealtimeEvent } from "../services/realtime-bus.js";

function snapshotConfig() {
	return {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
}

function restoreConfig(snapshot: ReturnType<typeof snapshotConfig>) {
	Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

interface MockContext {
	req: { method: string; path: string };
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	json(body: unknown, status?: number): Response;
}

function makeContext(opts: { user?: { userId: string; role: "admin" | "editor" | "viewer" } } = {}): MockContext {
	const store: Record<string, unknown> = {};
	if (opts.user) store.user = opts.user;
	return {
		req: { method: "GET", path: "/api/images/test" },
		get(key: string) {
			return store[key];
		},
		set(key: string, value: unknown) {
			store[key] = value;
		},
		json(body: unknown, status = 200) {
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

function appAs(user: JWTPayload): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set(key: "user", value: JWTPayload): void }).set("user", user);
		await next();
	});
	app.route("/api/images", images);
	return app;
}

async function png(width = 96, height = 96): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();
}

function activeMember(userId: string): ChapterTeamMember {
	return {
		id: `mem-${userId}`,
		userId,
		role: "translator",
		status: "active",
		createdAt: new Date().toISOString(),
	};
}

function pendingEmailInvite(email: string): ChapterTeamMember {
	return {
		id: `inv-${email}`,
		email,
		role: "translator",
		status: "pending",
		createdAt: new Date().toISOString(),
	};
}

function writeProjectState(state: ProjectState): void {
	const dir = join(PROJECTS_DIR, state.projectId);
	mkdirSync(join(dir, "images"), { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
	const base: ProjectState = {
		projectId: randomUUID(),
		userId: "owner-user",
		name: "Workspace Chapter",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "en",
		workspaceId: "ws-team",
	};
	return { ...base, ...overrides } as ProjectState;
}

afterAll(() => {
	process.env.DATA_DIR = originalDataDir;
	try {
		rmSync(imagesDataDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

beforeEach(() => {
	// Prod-posture config so the legacy-anonymous hatch is irrelevant to these
	// authenticated-member checks.
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		apiAuthRequired: true,
		allowLegacyAnonymousProjects: false,
	});
});

afterEach(() => {
	realtimeBusModule.setRealtimeBusForTesting(null);
});

function captureWorkspaceEvents(workspaceId: string): { events: RealtimeEvent[]; close: () => void } {
	const events: RealtimeEvent[] = [];
	const controller = new AbortController();
	const sub = realtimeBusModule.getRealtimeBus().subscribe(workspaceId, { signal: controller.signal });
	(async () => { for await (const event of sub) events.push(event); })().catch(() => {});
	return { events, close: () => controller.abort() };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("images.ts checkProjectOwnership — chapter-team read parity (P0)", () => {
	test("ACTIVE chapter-team member of a workspace project passes a read image check (sees page images)", async () => {
		const snapshot = snapshotConfig();
		try {
			const member = "member-active";
			const state = makeProject({ chapterTeam: [activeMember(member)] });
			writeProjectState(state);
			const ctx = makeContext({ user: { userId: member, role: "editor" } });
			const result = await checkImageProjectOwnership(ctx as never, state.projectId, "read:project");
			expect(result).toBeNull();
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("PENDING (email-only) invitee is NOT granted image read access → 404", async () => {
		const snapshot = snapshotConfig();
		try {
			const state = makeProject({ chapterTeam: [pendingEmailInvite("invitee@example.com")] });
			writeProjectState(state);
			// The not-yet-active invitee, even once they have an account, is not active.
			const ctx = makeContext({ user: { userId: "invitee-account", role: "editor" } });
			const result = await checkImageProjectOwnership(ctx as never, state.projectId, "read:project");
			expect(result).not.toBeNull();
			expect(result!.status).toBe(404);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("a stranger with no membership is denied image read access → 404", async () => {
		const snapshot = snapshotConfig();
		try {
			const state = makeProject({ chapterTeam: [activeMember("member-active")] });
			writeProjectState(state);
			const ctx = makeContext({ user: { userId: "stranger", role: "editor" } });
			const result = await checkImageProjectOwnership(ctx as never, state.projectId, "read:project");
			expect(result).not.toBeNull();
			expect(result!.status).toBe(404);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("FROZEN workspace still blocks MUTATING image ops (update:project) for an active member → 403 workspace_suspended", async () => {
		const snapshot = snapshotConfig();
		const workspaceId = "ws-frozen-images";
		try {
			const member = "member-frozen";
			const state = makeProject({ workspaceId, chapterTeam: [activeMember(member)] });
			writeProjectState(state);
			await workspaceAccessStore.createWorkspace({ workspaceId, name: "Frozen WS", ownerUserId: "owner-user" });
			await workspaceAccessStore.setWorkspaceSuspension({ workspaceId, suspend: true, reason: "chargeback" });

			const ctx = makeContext({ user: { userId: member, role: "editor" } });
			const mutate = await checkImageProjectOwnership(ctx as never, state.projectId, "update:project");
			expect(mutate).not.toBeNull();
			expect(mutate!.status).toBe(403);
			expect(await mutate!.json()).toEqual(expect.objectContaining({ code: "workspace_suspended" }));

			// Reads must STILL pass on a frozen workspace (members can view, not mutate).
			const readCtx = makeContext({ user: { userId: member, role: "editor" } });
			const read = await checkImageProjectOwnership(readCtx as never, state.projectId, "read:project");
			expect(read).toBeNull();
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("POST /upload emits page_set_changed for a committed page upload", async () => {
		const snapshot = snapshotConfig();
		const workspaceId = `ws-upload-${randomUUID()}`;
		const member = "member-uploader";
		realtimeBusModule.setRealtimeBusForTesting(realtimeBusModule.createInMemoryRealtimeBus());
		const cap = captureWorkspaceEvents(workspaceId);
		try {
			const state = makeProject({
				workspaceId,
				chapterTeam: [activeMember(member)],
				pages: [{ imageId: "existing-page.png", imageName: "existing-page.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
			});
			writeProjectState(state);
			await workspaceAccessStore.createWorkspace({ workspaceId, name: "Upload WS", ownerUserId: "owner-user" });

			const form = new FormData();
			form.append("images", new File([await png()], "new-page.png", { type: "image/png" }));
			const res = await appAs({
				userId: member,
				email: "uploader@example.com",
				role: "editor",
				emailVerified: true,
			}).request(`/api/images/${state.projectId}/upload`, {
				method: "POST",
				body: form,
			});
			expect(res.status).toBe(200);
			await flush();

			// Upload deliberately does NOT emit page_set_changed (review #594 P2):
			// the page set only commits when the client persists ProjectState via
			// /save, and THAT path emits. Emitting here would announce a change
			// collaborators cannot yet see.
			const event = cap.events.find((candidate) => candidate.kind === "page_set_changed");
			expect(event).toBeUndefined();
		} finally {
			cap.close();
			restoreConfig(snapshot);
		}
	});

	test("ACTIVE chapter-team member of a PERSONAL (non-workspace) chapter passes a read image check", async () => {
		const snapshot = snapshotConfig();
		try {
			const member = "member-personal";
			const state = makeProject({ workspaceId: undefined, userId: "owner-user", chapterTeam: [activeMember(member)] });
			writeProjectState(state);
			const ctx = makeContext({ user: { userId: member, role: "editor" } });
			const result = await checkImageProjectOwnership(ctx as never, state.projectId, "read:project");
			expect(result).toBeNull();
		} finally {
			restoreConfig(snapshot);
		}
	});
});
