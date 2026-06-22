process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import { FileWorkspaceAccessStore, workspaceAccessStore, type WorkspaceRole, type WorkspaceScope } from "../services/workspace-access.js";
import {
	indexStoryRolesByStoryId,
	resolveViewerDutyTaskTypes,
	taskTypeForDutyRole,
} from "../services/story-duties.js";
import { buildWorkspaceHomeAggregate } from "../services/workspace-home.js";
import type { ChapterTeamMember, ProjectState, WorkflowTask } from "../types/index.js";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const NOW_ISO = "2026-06-11T12:00:00.000Z";
let app: Hono;
const createdUserIds: string[] = [];

beforeAll(async () => {
	app = (await import("../index.js")).app as unknown as Hono;
});

afterAll(async () => {
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
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
	const res = await app.request("/api/workspaces", {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).workspace.workspaceId as string;
}

function seedWorkspaceMember(input: {
	workspaceId: string;
	userId: string;
	role: WorkspaceRole;
	scope?: WorkspaceScope;
	memberStudioRole?: string;
}): void {
	const store = workspaceAccessStore as unknown as { members?: Array<Record<string, unknown>> };
	if (!Array.isArray(store.members)) throw new Error("Expected file-mode workspace access store for route integration test");
	if (store.members.some((member) => member.workspaceId === input.workspaceId && member.userId === input.userId && !member.disabledAt)) return;
	store.members.push({
		workspaceId: input.workspaceId,
		userId: input.userId,
		role: input.role,
		memberStudioRole: input.memberStudioRole ?? "translator",
		scope: input.scope ?? {},
		createdAt: NOW_ISO,
		updatedAt: NOW_ISO,
	});
}

function hasOwnField(value: unknown, key: string): boolean {
	return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function projectState(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "proj-1",
		workspaceId: "ws-1",
		userId: "",
		name: "Story A — Chapter 1",
		createdAt: "2026-06-01T00:00:00.000Z",
		storyId: "story-a",
		storyTitle: "Story A",
		chapterLabel: "Chapter 1",
		pages: [{ imageId: "img-1", imageName: "image-01.webp", textLayers: [], pendingAiJobs: [], coverRect: null }],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	} as ProjectState;
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "translate",
		status: "todo",
		priority: "normal",
		pageIndex: 0,
		title: "Translate page 1",
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

function chapterMember(overrides: Partial<ChapterTeamMember> = {}): ChapterTeamMember {
	return {
		id: "ctm-1",
		userId: "user-1",
		role: "cleaner",
		status: "active",
		createdAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	} as ChapterTeamMember;
}

describe("story assignment store (file mode)", () => {
	test("multi-duty: a member can hold several roles on one story; remove by role then clear-all is idempotent", async () => {
		const store = new FileWorkspaceAccessStore();
		const created = await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", actorUserId: "owner-1" });
		expect(created.role).toBe("translator");
		expect(created.assignedBy).toBe("owner-1");

		// Adding a DIFFERENT role on the same (story, user) ADDS a duty (multi-duty),
		// it does not replace the first one.
		const second = await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "qc", actorUserId: "owner-1" });
		expect(second.role).toBe("qc");
		const both = await store.listStoryAssignments("ws-1", { storyId: "story-a" });
		expect(both.map((entry) => entry.role).sort()).toEqual(["qc", "translator"]);

		// Re-upserting the SAME (story, user, role) is idempotent (refreshes, no dup).
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", actorUserId: "owner-2" });
		expect(await store.listStoryAssignments("ws-1", { storyId: "story-a" })).toHaveLength(2);

		// Filters: by user across stories, by story, and workspace isolation.
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-b", userId: "user-1", role: "cleaner", actorUserId: "owner-1" });
		await store.upsertStoryAssignment({ workspaceId: "ws-2", storyId: "story-a", userId: "user-1", role: "typesetter", actorUserId: "owner-2" });
		expect(await store.listStoryAssignments("ws-1", { userId: "user-1" })).toHaveLength(3);
		expect(await store.listStoryAssignments("ws-2")).toHaveLength(1);

		// Remove ONE duty by role — the other survives.
		expect(await store.removeStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "qc", actorUserId: "owner-1" })).toBe(true);
		expect((await store.listStoryAssignments("ws-1", { storyId: "story-a" })).map((entry) => entry.role)).toEqual(["translator"]);

		// Remove ALL (no role) clears the remaining duty.
		expect(await store.removeStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", actorUserId: "owner-1" })).toBe(true);
		expect(await store.removeStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", actorUserId: "owner-1" })).toBe(false);
		expect(await store.listStoryAssignments("ws-1", { storyId: "story-a" })).toHaveLength(0);
	});

	test("bulk upsert dedupes stories and updates one member's duty across the selected story scope", async () => {
		const store = new FileWorkspaceAccessStore();
		const created = await store.upsertStoryAssignments({
			workspaceId: "ws-1",
			storyIds: ["story-b", "story-a", "story-b", "  "],
			userId: "user-1",
			role: "cleaner",
			actorUserId: "owner-1",
		});
		expect(created.map((entry) => entry.storyId)).toEqual(["story-b", "story-a"]);
		expect(created.map((entry) => entry.role)).toEqual(["cleaner", "cleaner"]);

		// Bulk-adding a different role ADDS that duty across the stories (multi-duty).
		const updated = await store.upsertStoryAssignments({
			workspaceId: "ws-1",
			storyIds: ["story-a", "story-b"],
			userId: "user-1",
			role: "qc",
			actorUserId: "owner-2",
		});
		expect(updated.map((entry) => `${entry.storyId}:${entry.role}:${entry.assignedBy}`)).toEqual([
			"story-a:qc:owner-2",
			"story-b:qc:owner-2",
		]);
		// user-1 now holds cleaner+qc on BOTH stories = 4 rows.
		expect(await store.listStoryAssignments("ws-1", { userId: "user-1" })).toHaveLength(4);

		const page = await store.listAuditEventPage("ws-1", { action: "story_assignment_upserted" });
		const bulkEvents = page.events.filter((event) => event.metadata.bulk === true);
		expect(bulkEvents).toHaveLength(4);
	});

	test("removing a workspace member drops their series duties (no stale roster, no re-invite re-arm)", async () => {
		const store = new FileWorkspaceAccessStore();
		await store.createWorkspace({ workspaceId: "ws-1", name: "WS", ownerUserId: "owner-1" });
		// Member onboarding is invite-based (Postgres-only); seed the non-owner
		// member row directly so file-mode removeMember has something to disable.
		(store as unknown as { members: Array<Record<string, unknown>> }).members.push({
			workspaceId: "ws-1",
			userId: "user-1",
			role: "editor",
			memberStudioRole: "translator",
			scope: {},
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", actorUserId: "owner-1" });
		await store.removeMember({ workspaceId: "ws-1", userId: "user-1", actorUserId: "owner-1" });
		expect(await store.listStoryAssignments("ws-1", { userId: "user-1" })).toHaveLength(0);
	});

	test("erasePiiForUser drops the user's series duties", async () => {
		const store = new FileWorkspaceAccessStore();
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", actorUserId: "owner-1" });
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-2", role: "cleaner", actorUserId: "owner-1" });
		await store.erasePiiForUser("user-1");
		const remaining = await store.listStoryAssignments("ws-1", { storyId: "story-a" });
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.userId).toBe("user-2");
	});

	test("audit trail records assignment mutations", async () => {
		const store = new FileWorkspaceAccessStore();
		await store.upsertStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", actorUserId: "owner-1" });
		await store.removeStoryAssignment({ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", actorUserId: "owner-1" });
		const page = await store.listAuditEventPage("ws-1", {});
		const actions = page.events.map((event) => event.action);
		expect(actions).toContain("story_assignment_upserted");
		expect(actions).toContain("story_assignment_removed");
	});
});

describe("story assignment routes — email privacy", () => {
	test("workspace managers receive assignee email, ordinary members receive displayName without the email field", async () => {
		const owner = await makeVerifiedUser("story-assign-owner");
		const assignee = await makeVerifiedUser("story-assign-assignee");
		const workspaceId = await createWorkspace(owner.token, "Story assignment privacy WS");
		seedWorkspaceMember({ workspaceId, userId: assignee.id, role: "editor" });

		const assign = await app.request(`/api/workspaces/${workspaceId}/story-assignments`, {
			method: "PUT",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ storyId: "privacy-story", userId: assignee.id, role: "translator", storyTitle: "Privacy Story" }),
		});
		expect(assign.status).toBe(200);

		const managerRes = await app.request(`/api/workspaces/${workspaceId}/story-assignments?storyId=privacy-story`, {
			headers: authHeaders(owner.token),
		});
		expect(managerRes.status).toBe(200);
		const managerBody = await managerRes.json();
		const managerAssignment = managerBody.assignments.find((entry: any) => entry.userId === assignee.id);
		expect(managerAssignment).toMatchObject({
			workspaceId,
			storyId: "privacy-story",
			userId: assignee.id,
			role: "translator",
			displayName: "story-assign-assignee",
		});
		expect(managerAssignment.email).toBe(assignee.email);
		expect(managerBody.candidates?.some((candidate: any) => candidate.userId === assignee.id && candidate.email === assignee.email)).toBe(true);

		const memberRes = await app.request(`/api/workspaces/${workspaceId}/story-assignments?storyId=privacy-story`, {
			headers: authHeaders(assignee.token),
		});
		expect(memberRes.status).toBe(200);
		const memberBody = await memberRes.json();
		const memberAssignment = memberBody.assignments.find((entry: any) => entry.userId === assignee.id);
		expect(memberAssignment).toMatchObject({
			workspaceId,
			storyId: "privacy-story",
			userId: assignee.id,
			role: "translator",
			displayName: "story-assign-assignee",
		});
		expect(hasOwnField(memberAssignment, "email")).toBe(false);
		expect(hasOwnField(memberBody, "candidates")).toBe(false);
	});
});

describe("story-duties resolution", () => {
	test("duty role → workflow task type mapping (guest/unknown → none)", () => {
		expect(taskTypeForDutyRole("translator")).toBe("translate");
		expect(taskTypeForDutyRole("cleaner")).toBe("clean");
		expect(taskTypeForDutyRole("typesetter")).toBe("typeset");
		expect(taskTypeForDutyRole("qc")).toBe("review");
		expect(taskTypeForDutyRole("guest")).toBeNull();
		expect(taskTypeForDutyRole(undefined)).toBeNull();
	});

	test("series duty applies to a chapter of the story (incl. one created later)", () => {
		const roles = indexStoryRolesByStoryId([
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", createdAt: "", updatedAt: "" },
		]);
		// Any chapter carrying the storyId resolves the duty — there is no
		// per-chapter write, so a future chapter inherits automatically.
		const futureChapter = projectState({ projectId: "proj-99", chapterLabel: "Chapter 99" });
		expect(resolveViewerDutyTaskTypes(futureChapter, roles, "user-1")).toEqual(new Set(["translate"]));
		// A different story's chapter grants nothing.
		expect(resolveViewerDutyTaskTypes(projectState({ storyId: "story-z" }), roles, "user-1")).toEqual(new Set());
	});

	test("multi-duty: a member holding several series roles gets ALL their task types", () => {
		// The index is built from ONE viewer's assignments (the route filters by
		// userId), so several rows for that viewer on a story collapse into the
		// set of roles they hold there.
		const roles = indexStoryRolesByStoryId([
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", createdAt: "", updatedAt: "" },
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "typesetter", createdAt: "", updatedAt: "" },
			{ workspaceId: "ws-1", storyId: "story-b", userId: "user-1", role: "cleaner", createdAt: "", updatedAt: "" },
		]);
		expect(roles.get("story-a")).toEqual(new Set(["translator", "typesetter"]));
		expect(resolveViewerDutyTaskTypes(projectState({}), roles, "user-1")).toEqual(new Set(["translate", "typeset"]));
		// A chapter of the OTHER story (story-b) surfaces only that story's duty.
		expect(resolveViewerDutyTaskTypes(projectState({ storyId: "story-b" }), roles, "user-1")).toEqual(new Set(["clean"]));
	});

	test("chapter-team role OVERRIDES the series duty on conflict", () => {
		const roles = indexStoryRolesByStoryId([
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", createdAt: "", updatedAt: "" },
		]);
		const state = projectState({ chapterTeam: [chapterMember({ userId: "user-1", role: "qc" })] });
		expect(resolveViewerDutyTaskTypes(state, roles, "user-1")).toEqual(new Set(["review"]));
	});

	test("chapter-team guest override yields NO duty despite a series role", () => {
		const roles = indexStoryRolesByStoryId([
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "translator", createdAt: "", updatedAt: "" },
		]);
		const state = projectState({ chapterTeam: [chapterMember({ userId: "user-1", role: "guest" })] });
		expect(resolveViewerDutyTaskTypes(state, roles, "user-1")).toEqual(new Set());
	});

	test("a PENDING chapter-team invite does not override the series duty", () => {
		const roles = indexStoryRolesByStoryId([
			{ workspaceId: "ws-1", storyId: "story-a", userId: "user-1", role: "cleaner", createdAt: "", updatedAt: "" },
		]);
		const state = projectState({ chapterTeam: [chapterMember({ userId: "user-1", role: "qc", status: "pending" })] });
		expect(resolveViewerDutyTaskTypes(state, roles, "user-1")).toEqual(new Set(["clean"]));
	});
});

describe("workspace-home duty-based My-Work", () => {
	const dutyByProject = new Map([["proj-1", new Set(["translate" as const])]]);

	test("an UNASSIGNED open task of the duty type surfaces in myTasks", () => {
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects: [{ state: projectState({ tasks: [task()] }) }],
			viewerHandles: ["user-1"],
			viewerDutyTypesByProject: dutyByProject,
			now: NOW,
		});
		expect(aggregate.myTasks.map((t) => t.id)).toEqual(["task-1"]);
	});

	test("an explicit assignee on someone ELSE beats duty inference", () => {
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects: [{ state: projectState({ tasks: [task({ assignee: "someone-else@example.com" })] }) }],
			viewerHandles: ["user-1"],
			viewerDutyTypesByProject: dutyByProject,
			now: NOW,
		});
		expect(aggregate.myTasks).toHaveLength(0);
	});

	test("a non-duty task type stays out of myTasks; done duty tasks too", () => {
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects: [{
				state: projectState({
					tasks: [
						task({ id: "clean-1", type: "clean" }),
						task({ id: "done-1", status: "done" }),
					],
				}),
			}],
			viewerHandles: ["user-1"],
			viewerDutyTypesByProject: dutyByProject,
			now: NOW,
		});
		expect(aggregate.myTasks).toHaveLength(0);
	});

	test("explicit self-assignment still works without any duty", () => {
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects: [{ state: projectState({ tasks: [task({ assignee: "user-1" })] }) }],
			viewerHandles: ["user-1"],
			now: NOW,
		});
		expect(aggregate.myTasks.map((t) => t.id)).toEqual(["task-1"]);
	});
});
