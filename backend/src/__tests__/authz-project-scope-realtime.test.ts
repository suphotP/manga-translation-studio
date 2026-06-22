// SECURITY + realtime regression tests (codex authz audit, routes/project.ts).
//
//   P1.1  A scoped workspace member with `manage_projects` but a fine-grained scope
//         must NOT be able to DELETE the whole project (irreversible). Project delete
//         now requires TRULY project-wide (unscoped) authority.
//   P1.3  A language-scoped manager must NOT be able to add/remove LANGUAGE TRACKS
//         (reshapes the shared `targetLangs`). Track management now requires unscoped
//         project/workspace management.
//   P1.4  A comment resolve/update now emits a realtime activity_feed event after the
//         CAS commit so other reviewers see it live.
//   P1.5  A review decision now emits activity_feed + a workflow_transition event so
//         Work/Focus lanes update live.
//   P1.6  @mentions resolve to workspace-member userIds (tenant-scoped) and notify()
//         the mentioned members (author skipped, deduped).
//
// Harness: override DATA_DIR so routes read real on-disk state.json, mount the
// project route in a Hono app with an auth-injecting middleware, monkey-patch the
// workspaceAccessStore instance (the same singleton project.ts imports) to model a
// member's role + fine-grained scope, capture realtime events through an in-memory
// bus, and stub the notify pipeline + auth-user lookups.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

const originalDataDir = process.env.DATA_DIR;
const scopeDataDir = mkdtempSync(join(tmpdir(), "manga-authz-rt-test-"));
process.env.DATA_DIR = scopeDataDir;

const { PROJECTS_DIR } = await import("../config.js");
const { project, createProjectStateFingerprint } = await import("../routes/project.js");
const workspaceAccessModule = await import("../services/workspace-access.js");
const authUsersModule = await import("../services/auth-users.js");
const notificationsModule = await import("../services/notifications.js");
const realtimeBusModule = await import("../services/realtime-bus.js");
const realtimeEmittersModule = await import("../services/realtime-emitters.js");
import type { ProjectState } from "../types/index.js";
import type { WorkspaceScope } from "../services/workspace-access.js";
import type { RealtimeEvent } from "../services/realtime-bus.js";

const workspaceAccessStore = workspaceAccessModule.workspaceAccessStore;
const authUserStore = authUsersModule.authUserStore;

// ── workspaceAccessStore stub (delete + language-track paths) ────────────────
// Membership: workspaceId -> userId -> { role, scope }. requirePermission mirrors
// the real store: it only checks the ROLE grant (so a scoped member still passes
// the permission check) — the route's own isFineGrainedScope guard is what must
// reject the scoped member. listMembers backs the mention resolver.
interface FakeMember { userId: string; role: string; scope: WorkspaceScope; }
const memberships = new Map<string, FakeMember[]>();

const originalRequirePermission = workspaceAccessStore.requirePermission.bind(workspaceAccessStore);
const originalListMembers = workspaceAccessStore.listMembers.bind(workspaceAccessStore);
const originalGetMember = workspaceAccessStore.getMember.bind(workspaceAccessStore);
const originalUserLoad = authUserStore.load.bind(authUserStore);
const notificationStore = notificationsModule.notificationStore;

const ROLE_PERMS: Record<string, string[]> = {
	owner: ["manage_projects", "update_project", "read_project"],
	admin: ["manage_projects", "update_project", "read_project"],
	editor: ["update_project", "read_project"],
	viewer: ["read_project"],
};

beforeEach(() => {
	memberships.clear();

	(workspaceAccessStore as { requirePermission: unknown }).requirePermission = (async (
		workspaceId: string,
		userId: string,
		permission: string,
	) => {
		const member = memberships.get(workspaceId)?.find((m) => m.userId === userId);
		if (!member) throw new workspaceAccessModule.WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		if (!ROLE_PERMS[member.role]?.includes(permission)) {
			throw new workspaceAccessModule.WorkspaceAccessError(`Forbidden: missing workspace permission '${permission}'`, 403, "workspace_permission_denied");
		}
		return { workspaceId, userId, role: member.role, scope: member.scope, createdAt: "", updatedAt: "" };
	}) as typeof originalRequirePermission;

	(workspaceAccessStore as { listMembers: unknown }).listMembers = (async (workspaceId: string) => {
		return (memberships.get(workspaceId) ?? []).map((m) => ({
			workspaceId, userId: m.userId, role: m.role, scope: m.scope, createdAt: "", updatedAt: "",
		}));
	}) as typeof originalListMembers;

	// Backs projectCatalogStore.canAccessProject (file-mode) → checkProjectOwnership.
	(workspaceAccessStore as { getMember: unknown }).getMember = (async (workspaceId: string, userId: string) => {
		const member = memberships.get(workspaceId)?.find((m) => m.userId === userId);
		return member ? { workspaceId, userId, role: member.role, scope: member.scope, createdAt: "", updatedAt: "" } : null;
	}) as typeof originalGetMember;

	// Map member userIds → name/email so the mention resolver has handles.
	(authUserStore as { load: unknown }).load = (async (userId: string) => {
		const names: Record<string, { name: string; email: string }> = {
			"u-owner": { name: "Owner Boss", email: "owner@studio.com" },
			"u-alice": { name: "Alice Reviewer", email: "alice@studio.com" },
			"u-bob": { name: "Bob Cleaner", email: "bobby@studio.com" },
		};
		const found = names[userId];
		return found ? { userId, name: found.name, email: found.email, isActive: true } : null;
	}) as typeof originalUserLoad;

	// Fresh in-memory realtime bus per test so event captures don't bleed across tests.
	realtimeBusModule.setRealtimeBusForTesting(realtimeBusModule.createInMemoryRealtimeBus());
	realtimeEmittersModule.clearWorkspaceLookupCacheForTesting();
});

afterEach(() => {
	(workspaceAccessStore as { requirePermission: unknown }).requirePermission = originalRequirePermission;
	(workspaceAccessStore as { listMembers: unknown }).listMembers = originalListMembers;
	(workspaceAccessStore as { getMember: unknown }).getMember = originalGetMember;
	(authUserStore as { load: unknown }).load = originalUserLoad;
	realtimeBusModule.setRealtimeBusForTesting(null);
});

afterAll(() => {
	rmSync(scopeDataDir, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
});

const WS = "ws-rt";

function makeProjectId(): string {
	return crypto.randomUUID();
}

function writeWorkspaceProject(projectId: string, overrides: Partial<ProjectState> = {}): void {
	const dir = join(PROJECTS_DIR, projectId);
	mkdirSync(dir, { recursive: true });
	const state: ProjectState = {
		projectId,
		userId: "",
		workspaceId: WS,
		name: "WS Project",
		storyTitle: "WS Story",
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

// Seed a version snapshot on disk so the version-review routes (which require an
// existing version) accept a request without driving the full /save pipeline.
function seedVersion(projectId: string): string {
	const versionId = `v-${crypto.randomUUID().replace(/-/g, "")}`;
	const dir = join(PROJECTS_DIR, projectId, "versions");
	mkdirSync(dir, { recursive: true });
	const state = readState(projectId);
	const now = new Date().toISOString();
	writeFileSync(join(dir, `${versionId}.json`), JSON.stringify({
		metadata: { versionId, projectId, name: state.name ?? "P", source: "save", createdAt: now, pageCount: state.pages.length, textLayerCount: 0 },
		state,
	}));
	return versionId;
}

function appAs(user: { userId: string; email: string; role?: string }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as { set: (key: string, value: unknown) => void }).set("user", {
			userId: user.userId,
			email: user.email,
			role: user.role ?? "editor",
		});
		await next();
	});
	app.route("/api/project", project);
	return app;
}

function captureWorkspaceEvents(): { events: RealtimeEvent[]; close: () => void } {
	const events: RealtimeEvent[] = [];
	const controller = new AbortController();
	const sub = realtimeBusModule.getRealtimeBus().subscribe(WS, { signal: controller.signal });
	(async () => { for await (const event of sub) events.push(event); })().catch(() => {});
	return { events, close: () => controller.abort() };
}

async function flush(): Promise<void> {
	// let the best-effort emit/notify microtasks settle
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("authz — irreversible project DELETE requires project-wide scope (P1.1)", () => {
	function del(app: Hono, projectId: string, confirmStoryTitle: string) {
		return app.request(`/api/project/${projectId}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirmStoryTitle }),
		});
	}

	test("a LANGUAGE-SCOPED admin CANNOT delete the project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-scoped", role: "admin", scope: { languages: ["en"] } }]);

		const res = await del(appAs({ userId: "u-scoped", email: "scoped@studio.com", role: "admin" }), projectId, "WS Story");
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("workspace_project_delete_scope_denied");
		// Project still on disk.
		expect(readState(projectId).name).toBe("WS Project");
	});

	test("an UNSCOPED owner CAN delete the project (no regression)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);

		const res = await del(appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }), projectId, "WS Story");
		expect(res.status).toBe(200);
	});
});

describe("authz — LANGUAGE TRACK management requires project-wide scope (P1.3)", () => {
	function addTrack(app: Hono, projectId: string, language: string) {
		return app.request(`/api/project/${projectId}/languages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language }),
		});
	}
	function removeTrack(app: Hono, projectId: string, language: string) {
		return app.request(`/api/project/${projectId}/languages/${language}`, { method: "DELETE" });
	}

	test("a LANGUAGE-SCOPED admin CANNOT add a language track", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-scoped", role: "admin", scope: { languages: ["en"] } }]);

		const res = await addTrack(appAs({ userId: "u-scoped", email: "scoped@studio.com", role: "admin" }), projectId, "de");
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("workspace_language_track_scope_denied");
		expect(readState(projectId).targetLangs).toEqual(["en", "fr"]);
	});

	test("a LANGUAGE-SCOPED admin CANNOT remove a language track", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-scoped", role: "admin", scope: { languages: ["fr"] } }]);

		const res = await removeTrack(appAs({ userId: "u-scoped", email: "scoped@studio.com", role: "admin" }), projectId, "fr");
		expect(res.status).toBe(403);
		expect(readState(projectId).targetLangs).toEqual(["en", "fr"]);
	});

	test("an UNSCOPED owner CAN add + remove a language track (no regression)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const app = appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" });

		const addRes = await addTrack(app, projectId, "de");
		expect(addRes.status).toBe(200);
		expect(readState(projectId).targetLangs).toContain("de");

		const delRes = await removeTrack(app, projectId, "de");
		expect(delRes.status).toBe(200);
		expect(readState(projectId).targetLangs).not.toContain("de");
	});
});

describe("realtime — full-state save emits page_set_changed only for page-set drift", () => {
	test("a save that changes page image order emits page_set_changed", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			pages: [
				{ imageId: "img-a", imageName: "a.png", textLayers: [], pendingAiJobs: [], coverRect: null },
				{ imageId: "img-b", imageName: "b.png", textLayers: [], pendingAiJobs: [], coverRect: null },
			],
		});
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const app = appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" });
		const before = readState(projectId);
		const cap = captureWorkspaceEvents();
		try {
			const after: ProjectState = {
				...before,
				pages: [before.pages[1]!, before.pages[0]!],
			};
			const res = await app.request(`/api/project/${projectId}/save`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-Fingerprint": createProjectStateFingerprint(before),
				},
				body: JSON.stringify(after),
			});
			expect(res.status).toBe(200);
			await flush();
			const event = cap.events.find((candidate) => candidate.kind === "page_set_changed");
			expect(event?.data).toEqual({
				projectId,
				changedBy: "u-owner",
				pageCount: 2,
			});
		} finally {
			cap.close();
		}
	});

	test("a save that only changes page text does not emit page_set_changed", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const app = appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" });
		const before = readState(projectId);
		const cap = captureWorkspaceEvents();
		try {
			const after: ProjectState = {
				...before,
				pages: [{
					...before.pages[0]!,
					textLayers: [{
						id: "text-1",
						text: "Updated",
						x: 10,
						y: 10,
						w: 100,
						h: 40,
						rotation: 0,
						fontSize: 24,
						fontFamily: "Arial",
						alignment: "center",
						index: 0,
					}],
				}],
			};
			const res = await app.request(`/api/project/${projectId}/save`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-Fingerprint": createProjectStateFingerprint(before),
				},
				body: JSON.stringify(after),
			});
			expect(res.status).toBe(200);
			await flush();
			expect(cap.events.some((candidate) => candidate.kind === "page_set_changed")).toBe(false);
		} finally {
			cap.close();
		}
	});
});

describe("realtime — comment resolve/update emits an event (P1.4)", () => {
	test("resolving a comment emits an activity_feed event", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			comments: [{ id: "c-1", pageIndex: 0, body: "issue", author: "owner@studio.com", mentions: [], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
		} as Partial<ProjectState>);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		// checkProjectOwnership (no permission arg) → canAccessProject; the owner has a
		// workspaceId project so it routes through the catalog store. For the file-mode
		// owner path we instead rely on the personal-owner branch — but this project has
		// a workspaceId, so authorize through the workspace member: grant via real store.
		const cap = captureWorkspaceEvents();

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments/c-1`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		cap.close();
		const activity = cap.events.find((e) => e.kind === "activity_feed" && e.data.subjectKind === "comment");
		expect(activity).toBeDefined();
		expect(activity!.data.verb).toBe("resolved");
		expect(activity!.data.subject).toBe("c-1");
	});
});

describe("realtime — review decision emits activity + workflow events (P1.5)", () => {
	test("a review decision emits activity_feed + workflow_transition", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			targetLang: "en",
			targetLangs: ["en"],
			tasks: [{ id: "page-0-review", pageIndex: 0, type: "review", title: "Review", status: "todo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
		} as Partial<ProjectState>);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const cap = captureWorkspaceEvents();

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/review-decisions`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, status: "approved" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		cap.close();
		const activity = cap.events.find((e) => e.kind === "activity_feed" && e.data.subjectKind === "review_decision");
		expect(activity).toBeDefined();
		expect(activity!.data.verb).toBe("approved");
		const transition = cap.events.find((e) => e.kind === "workflow_transition");
		expect(transition).toBeDefined();
		expect(transition!.data.subjectId).toBe("page-0-review");
		expect(transition!.data.to).toBe("done");
	});
});

describe("mentions — resolve to members + notify, tenant-scoped (P1.6)", () => {
	async function inAppCount(userId: string): Promise<number> {
		const page = await notificationStore.listForUser(userId, { limit: 50 });
		return page.items.filter((n) => n.type === "comment_new").length;
	}

	test("a comment @mention resolves to a workspace member and notifies them (in-app)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [
			{ userId: "u-owner", role: "owner", scope: {} },
			{ userId: "u-alice", role: "editor", scope: {} },
		]);
		const before = await inAppCount("u-alice");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, body: "please look @alice" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await inAppCount("u-alice")).toBe(before + 1);
	});

	test("the author is NOT self-notified for their own @mention", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const before = await inAppCount("u-owner");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, body: "note to self @owner" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await inAppCount("u-owner")).toBe(before);
	});

	test("a @mention that matches NO workspace member is inert (tenant-scoped, no cross-tenant ping)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		// u-bob exists in the auth store but is NOT a member of THIS workspace.
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const before = await inAppCount("u-bob");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, body: "ping @bob from another tenant" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await inAppCount("u-bob")).toBe(before);
	});
});

// Count any mention notification (create = comment_new, edit/review = comment_reply).
async function mentionNotifyCount(userId: string): Promise<number> {
	const page = await notificationStore.listForUser(userId, { limit: 100 });
	return page.items.filter((n) => n.type === "comment_new" || n.type === "comment_reply").length;
}

describe("P1 — comment EDIT re-resolves mentions + notifies the newly-added one once", () => {
	test("editing a comment to ADD a @mention notifies the new mentionee exactly once", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			comments: [{ id: "c-edit", pageIndex: 0, body: "first pass done", author: "owner@studio.com", mentions: [], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
		} as Partial<ProjectState>);
		memberships.set(WS, [
			{ userId: "u-owner", role: "owner", scope: {} },
			{ userId: "u-alice", role: "editor", scope: {} },
		]);
		const before = await mentionNotifyCount("u-alice");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments/c-edit`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "first pass done @alice please check" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		// The newly-added mention is persisted AND the mentionee was pinged once.
		expect((await res.json()).comment.mentions).toContain("alice");
		expect(await mentionNotifyCount("u-alice")).toBe(before + 1);
	});

	test("re-editing the same comment without changing the mention does NOT re-notify (idempotent)", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			comments: [{ id: "c-idem", pageIndex: 0, body: "look @alice", author: "owner@studio.com", mentions: ["alice"], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
		} as Partial<ProjectState>);
		memberships.set(WS, [
			{ userId: "u-owner", role: "owner", scope: {} },
			{ userId: "u-alice", role: "editor", scope: {} },
		]);
		const before = await mentionNotifyCount("u-alice");

		// Edit the body but KEEP the same @alice mention → Alice must not be re-pinged.
		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/comments/c-idem`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "look @alice (updated note)" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await mentionNotifyCount("u-alice")).toBe(before);
	});
});

describe("P1 — version review REQUEST + DECISION @mentions notify", () => {
	test("a version-review REQUEST @mention notifies the mentioned member", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [
			{ userId: "u-owner", role: "owner", scope: {} },
			{ userId: "u-alice", role: "editor", scope: {} },
		]);
		// A version must exist for the reviews route to accept the request. Seed one
		// directly on disk (the FileProjectCatalogStore.getProjectVersion reads it from
		// versions/<id>.json) rather than driving the full /save pipeline.
		const versionId = seedVersion(projectId);
		const before = await mentionNotifyCount("u-alice");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/versions/${versionId}/reviews`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "please review @alice" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await mentionNotifyCount("u-alice")).toBe(before + 1);
	});

	test("a review DECISION note @mention notifies the mentioned member", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			targetLang: "en",
			targetLangs: ["en"],
			tasks: [{ id: "page-0-review", pageIndex: 0, type: "review", title: "Review", status: "todo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
		} as Partial<ProjectState>);
		memberships.set(WS, [
			{ userId: "u-owner", role: "owner", scope: {} },
			{ userId: "u-bob", role: "editor", scope: {} },
		]);
		const before = await mentionNotifyCount("u-bob");

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/review-decisions`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, status: "changes_requested", body: "@bob re-clean panel 2" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		expect(await mentionNotifyCount("u-bob")).toBe(before + 1);
	});
});

describe("P1 — single + bulk task updates emit realtime events to workspace subscribers", () => {
	function seedTaskProject(projectId: string): void {
		writeWorkspaceProject(projectId, {
			pages: [
				{ imageId: "img-0", imageName: "page-0.png" },
				{ imageId: "img-1", imageName: "page-1.png" },
			],
			targetLang: "en",
			targetLangs: ["en"],
			tasks: [
				{ id: "page-0-clean", pageIndex: 0, type: "clean", title: "Clean p0", status: "todo", priority: "normal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
				{ id: "page-1-clean", pageIndex: 1, type: "clean", title: "Clean p1", status: "todo", priority: "normal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
			],
		} as Partial<ProjectState>);
	}

	test("a SINGLE task status update emits activity_feed + workflow_transition", async () => {
		const projectId = makeProjectId();
		seedTaskProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const cap = captureWorkspaceEvents();

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/tasks/page-0-clean`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "doing" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		cap.close();
		const activity = cap.events.find((e) => e.kind === "activity_feed" && e.data.subjectKind === "task");
		expect(activity).toBeDefined();
		expect(activity!.data.subject).toBe("page-0-clean");
		const transition = cap.events.find((e) => e.kind === "workflow_transition" && e.data.subjectId === "page-0-clean");
		expect(transition).toBeDefined();
		expect(transition!.data.to).toBe("doing");
	});

	test("a BULK task update emits ONE batched activity_feed + a workflow_transition per status-moved task", async () => {
		const projectId = makeProjectId();
		seedTaskProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const cap = captureWorkspaceEvents();

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/tasks/bulk`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskIds: ["page-0-clean", "page-1-clean"], status: "done" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		cap.close();
		// Exactly ONE batched activity event (not one per task) → no event storm.
		const activities = cap.events.filter((e) => e.kind === "activity_feed" && e.data.subjectKind === "task");
		expect(activities.length).toBe(1);
		expect(activities[0]!.data.verb).toBe("bulk_updated");
		expect((activities[0]!.data.metadata as { count?: number }).count).toBe(2);
		// One workflow_transition per status-moved task.
		const transitions = cap.events.filter((e) => e.kind === "workflow_transition");
		expect(transitions.length).toBe(2);
		expect(new Set(transitions.map((t) => t.data.subjectId))).toEqual(new Set(["page-0-clean", "page-1-clean"]));
		expect(transitions.every((t) => t.data.to === "done")).toBe(true);
	});

	test("task-update events are scoped to the project's workspace (a non-member workspace channel sees nothing)", async () => {
		const projectId = makeProjectId();
		seedTaskProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		// Subscribe to a DIFFERENT workspace channel — it must receive no task events.
		const otherEvents: RealtimeEvent[] = [];
		const otherController = new AbortController();
		const otherSub = realtimeBusModule.getRealtimeBus().subscribe("ws-other", { signal: otherController.signal });
		(async () => { for await (const ev of otherSub) otherEvents.push(ev); })().catch(() => {});

		const res = await appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }).request(
			`/api/project/${projectId}/tasks/page-0-clean`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
		);
		expect(res.status).toBe(200);
		await flush();
		otherController.abort();
		expect(otherEvents.length).toBe(0);
	});
});

describe("P1 — scoped collaborator comment access (allow in-scope, deny out-of-scope)", () => {
	// A page-0/1 multi-page project so page scope is meaningful.
	function seedTwoPageProject(projectId: string): void {
		writeWorkspaceProject(projectId, {
			pages: [
				{ imageId: "img-0", imageName: "page-0.png" },
				{ imageId: "img-1", imageName: "page-1.png" },
			],
		} as Partial<ProjectState>);
	}

	test("a TASK-TYPE-scoped collaborator CAN comment on an in-scope page (not over-restricted)", async () => {
		const projectId = makeProjectId();
		seedTwoPageProject(projectId);
		// Cleaner scoped to the CLEAN task type only — a comment is NOT task-typed, so
		// they must still be able to comment on a page they can access.
		memberships.set(WS, [{ userId: "u-clean", role: "editor", scope: { taskTypes: ["clean"] } }]);

		const res = await appAs({ userId: "u-clean", email: "cleaner@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, body: "panel 2 needs a redraw" }) },
		);
		expect(res.status).toBe(200);
	});

	test("a TASK-TYPE-scoped collaborator CAN read comments on an in-scope page", async () => {
		const projectId = makeProjectId();
		seedTwoPageProject(projectId);
		memberships.set(WS, [{ userId: "u-clean", role: "editor", scope: { taskTypes: ["clean"] } }]);

		const res = await appAs({ userId: "u-clean", email: "cleaner@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments?pageIndex=0`,
			{ method: "GET" },
		);
		expect(res.status).toBe(200);
	});

	test("a PAGE-scoped collaborator CANNOT comment on an OUT-of-scope page (not over-granted)", async () => {
		const projectId = makeProjectId();
		seedTwoPageProject(projectId);
		// Scoped to page 0 only → commenting on page 1 must be denied.
		memberships.set(WS, [{ userId: "u-p0", role: "editor", scope: { pageIndexes: [0] } }]);

		const allowed = await appAs({ userId: "u-p0", email: "p0@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 0, body: "in scope" }) },
		);
		expect(allowed.status).toBe(200);

		const denied = await appAs({ userId: "u-p0", email: "p0@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: 1, body: "out of scope" }) },
		);
		expect(denied.status).toBe(404);
	});

	test("a PAGE-scoped collaborator CAN edit a comment on their in-scope page but NOT one on an out-of-scope page", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId, {
			pages: [
				{ imageId: "img-0", imageName: "page-0.png" },
				{ imageId: "img-1", imageName: "page-1.png" },
			],
			comments: [
				{ id: "c-p0", pageIndex: 0, body: "on page 0", author: "owner@studio.com", mentions: [], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
				{ id: "c-p1", pageIndex: 1, body: "on page 1", author: "owner@studio.com", mentions: [], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
			],
		} as Partial<ProjectState>);
		memberships.set(WS, [{ userId: "u-p0", role: "editor", scope: { pageIndexes: [0] } }]);

		const ok = await appAs({ userId: "u-p0", email: "p0@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments/c-p0`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) },
		);
		expect(ok.status).toBe(200);

		const denied = await appAs({ userId: "u-p0", email: "p0@studio.com", role: "editor" }).request(
			`/api/project/${projectId}/comments/c-p1`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) },
		);
		expect(denied.status).toBe(404);
	});
});

// ── F3-1: a story TITLE rename must PUSH project_meta_changed so peers re-fetch ──
describe("realtime — story rename pushes project_meta_changed (F3-1 cache-coherence)", () => {
	function renameStory(app: Hono, projectId: string, storyTitle: string) {
		return app.request(`/api/project/${projectId}/story`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ storyTitle }),
		});
	}

	test("renaming a story emits project_meta_changed with the new title on the workspace channel", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const cap = captureWorkspaceEvents();
		try {
			const res = await renameStory(appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }), projectId, "Renamed Saga");
			expect(res.status).toBe(200);
			await flush();
			const meta = cap.events.find((e) => e.kind === "project_meta_changed");
			expect(meta).toBeDefined();
			expect((meta!.data as { projectId?: string }).projectId).toBe(projectId);
			expect((meta!.data as { storyTitle?: string }).storyTitle).toBe("Renamed Saga");
		} finally {
			cap.close();
		}
	});

	test("a no-op rename (unchanged title) emits NO project_meta_changed", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId); // seeds storyTitle "WS Story"
		memberships.set(WS, [{ userId: "u-owner", role: "owner", scope: {} }]);
		const cap = captureWorkspaceEvents();
		try {
			const res = await renameStory(appAs({ userId: "u-owner", email: "owner@studio.com", role: "owner" }), projectId, "WS Story");
			expect(res.status).toBe(200);
			await flush();
			expect(cap.events.some((e) => e.kind === "project_meta_changed")).toBe(false);
		} finally {
			cap.close();
		}
	});
});
