import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceApiRole } from "$lib/api/client.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { canUseLeadView, effectiveTeamMode } from "$lib/stores/workspace-team-mode.ts";

function setMembership(role: WorkspaceApiRole | null): void {
	if (role === null) {
		workspacesStore.workspaces = [];
		workspacesStore.currentWorkspaceId = null;
		return;
	}
	workspacesStore.workspaces = [
		{
			workspaceId: "ws",
			name: "T",
			planId: "free",
			storageIncludedBytes: 0,
			storageExtraBytes: 0,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			memberRole: role,
			memberScope: {},
		},
	];
	workspacesStore.currentWorkspaceId = "ws";
}

beforeEach(() => {
	setMembership(null);
	editorUiStore.setWorkspaceTeamMode("lead"); // worst case: stored mode is the lead default
});
afterEach(() => {
	setMembership(null);
});

describe("workspace-team-mode clamp (lead view is owner/admin only)", () => {
	it("owner/admin keep the lead view when they choose it", () => {
		for (const role of ["owner", "admin"] as const) {
			setMembership(role);
			expect(canUseLeadView(), role).toBe(true);
			expect(effectiveTeamMode(), role).toBe("lead");
		}
	});

	it("a WORKER (editor access) is clamped to 'assigned' even with a stored 'lead' mode", () => {
		// The headline leak: a translator/typesetter must NOT land on the lead/manager board.
		setMembership("editor");
		expect(canUseLeadView()).toBe(false);
		expect(effectiveTeamMode()).toBe("assigned");
	});

	it("a viewer is clamped to 'assigned'", () => {
		setMembership("viewer");
		expect(canUseLeadView()).toBe(false);
		expect(effectiveTeamMode()).toBe("assigned");
	});

	it("no workspace context (anonymous/personal) is clamped to 'assigned'", () => {
		setMembership(null);
		expect(canUseLeadView()).toBe(false);
		expect(effectiveTeamMode()).toBe("assigned");
	});

	it("an admin who chose 'assigned' stays on their own work (clamp never forces lead)", () => {
		setMembership("owner");
		editorUiStore.setWorkspaceTeamMode("assigned");
		expect(effectiveTeamMode()).toBe("assigned");
	});
});
