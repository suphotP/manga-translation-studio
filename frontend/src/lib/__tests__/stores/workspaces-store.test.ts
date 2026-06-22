import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import type {
	WorkspaceInviteRecord,
	WorkspaceMemberRecord,
	WorkspaceRecord,
	WorkspaceScope,
} from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	getAllWorkspaces: vi.fn(),
	createWorkspace: vi.fn(),
	patchWorkspace: vi.fn(),
	getAllWorkspaceMembers: vi.fn(),
	addWorkspaceMember: vi.fn(),
	removeWorkspaceMember: vi.fn(),
	updateWorkspaceMemberRole: vi.fn(),
	getAllWorkspaceInvites: vi.fn(),
	cancelInvite: vi.fn(),
	// authStore (imported transitively) touches these during __resetForTesting.
	setApiAccessToken: vi.fn(),
	clearApiAccessToken: vi.fn(),
	setAuthRefreshHandler: vi.fn(),
}));

const now = "2026-06-01T00:00:00.000Z";

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
	return {
		workspaceId: "ws-1",
		name: "Studio One",
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: now,
		updatedAt: now,
		memberRole: "owner",
		...overrides,
	};
}

function member(overrides: Partial<WorkspaceMemberRecord> = {}): WorkspaceMemberRecord {
	return {
		workspaceId: "ws-1",
		userId: "user-1",
		role: "admin",
		scope: {},
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function invite(overrides: Partial<WorkspaceInviteRecord> = {}): WorkspaceInviteRecord {
	return {
		inviteId: "invite-1",
		workspaceId: "ws-1",
		email: "lead@example.com",
		role: "admin",
		scope: {},
		status: "pending",
		invitedByUserId: "user-1",
		expiresAt: now,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

beforeEach(() => {
	// resetAllMocks (not clearAllMocks) so a mockResolvedValue set in one test does not
	// leak its implementation into the next — several tests rely on an UNmocked api method
	// rejecting/returning undefined (e.g. the 403 auto-load cases).
	vi.resetAllMocks();
	localStorage.clear();
	workspacesStore.__resetForTesting();
	authStore.__resetForTesting();
});

describe("workspacesStore role/scope round-trip", () => {
	it("sends a workspace-wide scope marker for Team Lead so it is not promoted to Admin", async () => {
		vi.mocked(api.addWorkspaceMember).mockResolvedValue({
			invite: invite({ scope: { aiCreditPolicy: "workspace" }, inviteToken: "tok-123" }),
		});

		const result = await workspacesStore.inviteMember("ws-1", "lead@example.com", "team_lead");

		const sent = vi.mocked(api.addWorkspaceMember).mock.calls[0][1];
		expect(sent.role).toBe("admin");
		expect((sent.scope as WorkspaceScope).aiCreditPolicy).toBe("workspace");
		// inferDisplayRole must read the marker back as team_lead, not admin.
		expect(result.displayRole).toBe("team_lead");
	});

	it("couples the story scope (projectIds) with the role's task lane for a scoped invite (#11)", async () => {
		vi.mocked(api.addWorkspaceMember).mockResolvedValue({
			invite: invite({ scope: { projectIds: ["p1", "p2"], taskTypes: ["translate"] }, inviteToken: "tok-scope" }),
		});
		await workspacesStore.inviteMember("ws-1", "helper@example.com", "translator", ["p1", "p2"]);
		const scope = vi.mocked(api.addWorkspaceMember).mock.calls[0][1].scope as WorkspaceScope;
		expect(scope.projectIds).toEqual(["p1", "p2"]);
		// the role's task lane rides ALONG with the resource scope — a "translator for just
		// this story", not a whole-workspace translator nor an unscoped editor.
		expect(scope.taskTypes).toContain("translate");
	});

	it("a whole-workspace invite (no projectIds) carries no projectIds scope", async () => {
		vi.mocked(api.addWorkspaceMember).mockResolvedValue({ invite: invite({ inviteToken: "tok-all" }) });
		await workspacesStore.inviteMember("ws-1", "helper@example.com", "translator");
		const scope = vi.mocked(api.addWorkspaceMember).mock.calls[0][1].scope as WorkspaceScope | undefined;
		expect(scope?.projectIds).toBeUndefined();
	});

	it("renders an admin with an empty scope as Admin (not Team Lead)", async () => {
		vi.mocked(api.updateWorkspaceMemberRole).mockResolvedValue({
			member: member({ role: "admin", scope: {} }),
		});

		const updated = await workspacesStore.updateMemberRole("ws-1", "user-1", "admin");

		const sent = vi.mocked(api.updateWorkspaceMemberRole).mock.calls[0][2];
		// Promotion to Admin must send an explicit empty scope so the backend overwrites
		// (rather than COALESCE-keeps) any prior Team Lead marker or task scope.
		expect(sent.scope).toEqual({});
		expect(updated.displayRole).toBe("admin");
	});

	it("captures the one-time invite token so admins can deliver it", async () => {
		vi.mocked(api.addWorkspaceMember).mockResolvedValue({
			invite: invite({ inviteToken: "one-time-secret" }),
		});

		await workspacesStore.inviteMember("ws-1", "lead@example.com", "translator");

		expect(workspacesStore.lastInvite).toEqual({
			inviteId: "invite-1",
			email: "lead@example.com",
			token: "one-time-secret",
			// No inviteEmailSendFailed flag in the response → treated as delivered.
			emailSent: true,
		});

		workspacesStore.dismissLastInvite();
		expect(workspacesStore.lastInvite).toBeNull();
	});

	it("clears the copied one-time link when its invite is canceled", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace()]);
		await workspacesStore.syncWithAuth("user-1");

		vi.mocked(api.addWorkspaceMember).mockResolvedValue({
			invite: invite({ inviteToken: "soon-revoked" }),
		});
		await workspacesStore.inviteMember("ws-1", "lead@example.com", "translator");
		expect(workspacesStore.lastInvite?.inviteId).toBe("invite-1");

		vi.mocked(api.cancelInvite).mockResolvedValue({
			invite: invite({ status: "revoked" }),
		});
		await workspacesStore.cancelInvite("invite-1");

		// The link points at an invite that can no longer be accepted, so it must not linger.
		expect(workspacesStore.lastInvite).toBeNull();
	});
});

describe("workspacesStore create + refresh", () => {
	it("marks a newly created workspace as owner so admin UI unlocks immediately", async () => {
		vi.mocked(api.createWorkspace).mockResolvedValue({
			// The create endpoint returns a bare record with NO membership fields.
			workspace: workspace({ workspaceId: "ws-new", memberRole: undefined, memberScope: undefined }),
		});
		vi.mocked(api.getAllWorkspaceMembers).mockResolvedValue([]);
		vi.mocked(api.getAllWorkspaceInvites).mockResolvedValue([]);

		const created = await workspacesStore.create("Studio New");

		expect(created.memberRole).toBe("owner");
		expect(workspacesStore.currentWorkspace?.memberRole).toBe("owner");
		expect(workspacesStore.isAdmin).toBe(true);
	});

	it("refresh() re-fetches /workspaces for the same loaded identity", async () => {
		// refresh() only gates on authStore.user?.id; set it directly like the sign-out test.
		authStore.user = { id: "user-1", email: "a@example.com", name: "A", role: "admin", isActive: true };
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace()]);
		await workspacesStore.syncWithAuth("user-1");
		expect(api.getAllWorkspaces).toHaveBeenCalledTimes(1);

		// A second workspace was joined out-of-band (e.g. accepting an invite).
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace(), workspace({ workspaceId: "ws-2" })]);
		await workspacesStore.refresh();

		expect(api.getAllWorkspaces).toHaveBeenCalledTimes(2);
		expect(workspacesStore.workspaces).toHaveLength(2);
	});
});

describe("workspacesStore default workspace selection", () => {
	it("keeps a valid localStorage workspace id even when an owned workspace exists", async () => {
		localStorage.setItem("manga-editor.currentWorkspaceId", "shared-editor");
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([
			workspace({
				workspaceId: "boss-active",
				name: "Boss Active",
				memberRole: "admin",
				createdAt: "2026-05-01T00:00:00.000Z",
				updatedAt: "2026-06-10T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-old",
				name: "Personal Old",
				memberRole: "owner",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-05-01T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "shared-editor",
				name: "Shared Editor",
				memberRole: "editor",
				createdAt: "2026-03-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
			}),
		]);

		await workspacesStore.load();

		expect(workspacesStore.currentWorkspaceId).toBe("shared-editor");
		expect(workspacesStore.currentWorkspace?.workspaceId).toBe("shared-editor");
		expect(localStorage.getItem("manga-editor.currentWorkspaceId")).toBe("shared-editor");
	});

	it("uses the oldest owned workspace when localStorage is missing", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([
			workspace({
				workspaceId: "boss-active",
				name: "Boss Active",
				memberRole: "admin",
				createdAt: "2026-05-01T00:00:00.000Z",
				updatedAt: "2026-06-10T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-new",
				name: "Personal New",
				memberRole: "owner",
				createdAt: "2026-04-01T00:00:00.000Z",
				updatedAt: "2026-05-01T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-old",
				name: "Personal Old",
				memberRole: "owner",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
		]);

		await workspacesStore.load();

		expect(workspacesStore.currentWorkspaceId).toBe("personal-old");
		expect(workspacesStore.currentWorkspace?.workspaceId).toBe("personal-old");
		expect(localStorage.getItem("manga-editor.currentWorkspaceId")).toBe("personal-old");
	});

	it("uses the oldest owned workspace when localStorage points to a missing workspace", async () => {
		localStorage.setItem("manga-editor.currentWorkspaceId", "deleted-workspace");
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([
			workspace({
				workspaceId: "recent-shared",
				name: "Recent Shared",
				memberRole: "editor",
				createdAt: "2026-05-01T00:00:00.000Z",
				updatedAt: "2026-06-10T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-new",
				name: "Personal New",
				memberRole: "owner",
				createdAt: "2026-04-01T00:00:00.000Z",
				updatedAt: "2026-05-01T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-old",
				name: "Personal Old",
				memberRole: "owner",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
		]);

		await workspacesStore.load();

		expect(workspacesStore.currentWorkspaceId).toBe("personal-old");
		expect(workspacesStore.currentWorkspace?.workspaceId).toBe("personal-old");
		expect(localStorage.getItem("manga-editor.currentWorkspaceId")).toBe("personal-old");
	});

	it("derives the oldest owned workspace when the in-memory selected id is stale", () => {
		workspacesStore.workspaces = [
			workspace({
				workspaceId: "recent-shared",
				name: "Recent Shared",
				memberRole: "editor",
				createdAt: "2026-05-01T00:00:00.000Z",
				updatedAt: "2026-06-10T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-new",
				name: "Personal New",
				memberRole: "owner",
				createdAt: "2026-04-01T00:00:00.000Z",
				updatedAt: "2026-05-01T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "personal-old",
				name: "Personal Old",
				memberRole: "owner",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
		];
		workspacesStore.currentWorkspaceId = "deleted-workspace";

		expect(workspacesStore.currentWorkspace?.workspaceId).toBe("personal-old");
	});

	it("falls back to the first workspace when no owned workspace exists", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([
			workspace({
				workspaceId: "recent-shared",
				name: "Recent Shared",
				memberRole: "editor",
				createdAt: "2026-05-01T00:00:00.000Z",
				updatedAt: "2026-06-10T00:00:00.000Z",
			}),
			workspace({
				workspaceId: "older-shared",
				name: "Older Shared",
				memberRole: "viewer",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
		]);

		await workspacesStore.load();

		expect(workspacesStore.currentWorkspaceId).toBe("recent-shared");
		expect(workspacesStore.currentWorkspace?.workspaceId).toBe("recent-shared");
		expect(localStorage.getItem("manga-editor.currentWorkspaceId")).toBe("recent-shared");
	});
});

describe("workspacesStore admin-only endpoint errors", () => {
	it("does not surface a workspace error when auto-load hits a 403 on /members", async () => {
		await expect(
			workspacesStore.listMembers("ws-1", { silent: true }),
		).rejects.toThrow();
		expect(workspacesStore.membersStatus).toBe("error");
		expect(workspacesStore.error).toBeNull();
	});

	it("surfaces the error on an explicit (non-silent) members refresh", async () => {
		vi.mocked(api.getAllWorkspaceMembers).mockRejectedValue(new Error("Forbidden"));

		await expect(workspacesStore.listMembers("ws-1")).rejects.toThrow();
		expect(workspacesStore.error).toBe("Forbidden");
	});

	it("keeps a viewer's auto-load clean even though member/invite calls fail", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace({ memberRole: "viewer" })]);
		vi.mocked(api.getAllWorkspaceMembers).mockRejectedValue(new Error("Forbidden"));
		vi.mocked(api.getAllWorkspaceInvites).mockRejectedValue(new Error("Forbidden"));

		await workspacesStore.load();

		expect(workspacesStore.status).toBe("ready");
		expect(workspacesStore.error).toBeNull();
	});
});

describe("workspacesStore syncWithAuth", () => {
	it("does not fetch /workspaces while anonymous", async () => {
		await workspacesStore.syncWithAuth(null);

		expect(api.getAllWorkspaces).not.toHaveBeenCalled();
		expect(workspacesStore.status).toBe("idle");
	});

	it("loads workspaces once the shell receives a signed-in identity", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace()]);

		await workspacesStore.syncWithAuth(null);
		await workspacesStore.syncWithAuth("user-1");

		expect(workspacesStore.status).toBe("ready");
		expect(workspacesStore.workspaces).toHaveLength(1);
		expect(api.getAllWorkspaces).toHaveBeenCalledTimes(1);
	});

	it("re-fetches when the signed-in identity changes within the session", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace()]);

		await workspacesStore.syncWithAuth("user-1");
		await workspacesStore.syncWithAuth("user-2");

		expect(api.getAllWorkspaces).toHaveBeenCalledTimes(2);
	});

	it("clears all authenticated state when the session goes anonymous", async () => {
		vi.mocked(api.getAllWorkspaces).mockResolvedValue([workspace()]);
		vi.mocked(api.getAllWorkspaceMembers).mockResolvedValue([member()]);
		vi.mocked(api.getAllWorkspaceInvites).mockResolvedValue([invite()]);
		await workspacesStore.syncWithAuth("user-1");
		workspacesStore.lastInvite = { inviteId: "invite-1", email: "lead@example.com", token: "secret" };
		expect(workspacesStore.workspaces).toHaveLength(1);

		// Sign-out: the previous user's workspaces/members/invites/link must not linger.
		await workspacesStore.syncWithAuth(null);

		expect(workspacesStore.workspaces).toHaveLength(0);
		expect(workspacesStore.currentWorkspaceId).toBeNull();
		expect(workspacesStore.members).toHaveLength(0);
		expect(workspacesStore.invites).toHaveLength(0);
		expect(workspacesStore.lastInvite).toBeNull();
		expect(workspacesStore.status).toBe("idle");
	});
});
