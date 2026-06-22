import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import WorkspaceMembersPanel from "$lib/components/WorkspaceMembersPanel.svelte";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { workspacesStore, type WorkspaceMember } from "$lib/stores/workspaces.svelte.ts";

const now = "2026-06-01T00:00:00.000Z";

function member(overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
	return {
		workspaceId: "ws-1",
		userId: "user-2",
		role: "editor",
		scope: {},
		createdAt: now,
		updatedAt: now,
		displayRole: "translator",
		...overrides,
	} as WorkspaceMember;
}

beforeEach(() => {
	vi.restoreAllMocks();
	workspacesStore.__resetForTesting();
	authStore.__resetForTesting?.();
	// Signed-in owner (admin) on a resolved workspace, viewing one other member.
	authStore.user = { id: "user-1", name: "Owner", email: "owner@example.com" } as any;
	workspacesStore.workspaces = [
		{ workspaceId: "ws-1", name: "Studio", planId: "free", memberRole: "owner", memberScope: {} } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-1";
	workspacesStore.status = "ready";
	workspacesStore.members = [
		member({ userId: "user-1", role: "owner", displayRole: "owner" }),
		member({ userId: "user-2", displayRole: "translator" }),
	];
});

describe("WorkspaceMembersPanel — destructive removal is confirmed", () => {
	// P1: removing a teammate must NOT happen on a single click — it arms an inline
	// confirm naming the member; only the explicit confirm runs the removal.
	it("requires a confirm step before removing a member (first click does not remove)", async () => {
		const removeSpy = vi.spyOn(workspacesStore, "removeMember").mockResolvedValue(undefined);

		render(WorkspaceMembersPanel);

		// First click on the row's Remove arms the confirm — it must NOT remove.
		const removeBtn = screen.getByRole("button", { name: "จบงาน + เอาออก" });
		await fireEvent.click(removeBtn);
		expect(removeSpy).not.toHaveBeenCalled();

		// The inline confirm appears, naming the member.
		const confirm = await screen.findByRole("group", { name: /ยืนยันการเอา/ });
		expect(confirm.textContent).toContain("user-2");

		// Confirming actually removes.
		await fireEvent.click(within(confirm).getByRole("button", { name: "เอาออก" }));
		await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("ws-1", "user-2"));
	});

	it("can cancel the removal confirm without removing", async () => {
		const removeSpy = vi.spyOn(workspacesStore, "removeMember").mockResolvedValue(undefined);

		render(WorkspaceMembersPanel);

		await fireEvent.click(screen.getByRole("button", { name: "จบงาน + เอาออก" }));
		const confirm = await screen.findByRole("group", { name: /ยืนยันการเอา/ });
		await fireEvent.click(within(confirm).getByRole("button", { name: "ยกเลิก" }));

		expect(removeSpy).not.toHaveBeenCalled();
		// Confirm dismissed; the plain Remove button is back.
		await waitFor(() => expect(screen.queryByRole("group", { name: /ยืนยันการเอา/ })).toBeNull());
		expect(screen.getByRole("button", { name: "จบงาน + เอาออก" })).toBeTruthy();
	});
});

describe("WorkspaceMembersPanel — in-flight buttons cannot double-submit", () => {
	// P2: the invite action button is disabled while a request is in flight so a
	// double-click cannot fire two invites.
	it("disables the invite button while an invite is in flight (single submit)", async () => {
		const gate: { resolve: () => void } = { resolve: () => {} };
		const inviteSpy = vi
			.spyOn(workspacesStore, "inviteMember")
			.mockImplementation(() => new Promise((resolve) => { gate.resolve = () => resolve({} as any); }));

		render(WorkspaceMembersPanel);

		const email = screen.getByPlaceholderText("teammate@example.com") as HTMLInputElement;
		await fireEvent.input(email, { target: { value: "new@example.com" } });

		const sendBtn = await screen.findByRole("button", { name: "ส่งคำเชิญ" });
		await fireEvent.click(sendBtn);

		// In flight: button shows the busy label and is disabled; a second click no-ops.
		const busyBtn = await screen.findByRole("button", { name: "กำลังส่ง…" });
		expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(busyBtn);

		gate.resolve();
		await waitFor(() => expect(inviteSpy).toHaveBeenCalledTimes(1));
	});

	it("guards removeMember against a double-confirm-click (single removal)", async () => {
		const gate: { resolve: () => void } = { resolve: () => {} };
		const removeSpy = vi
			.spyOn(workspacesStore, "removeMember")
			.mockImplementation(() => new Promise<void>((resolve) => { gate.resolve = () => resolve(); }));

		render(WorkspaceMembersPanel);

		await fireEvent.click(screen.getByRole("button", { name: "จบงาน + เอาออก" }));
		const confirm = await screen.findByRole("group", { name: /ยืนยันการเอา/ });
		const confirmBtn = within(confirm).getByRole("button", { name: "เอาออก" });
		await fireEvent.click(confirmBtn);
		// Second click while in flight must not fire a second removal.
		await fireEvent.click(within(confirm).getByRole("button", { name: "กำลังเอาออก…" }));

		gate.resolve();
		await waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
	});
});
