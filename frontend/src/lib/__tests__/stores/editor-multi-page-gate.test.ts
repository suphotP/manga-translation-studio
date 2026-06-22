// W3.15 — multi-page (cross-page) mode role + lock gate on the real EditorStore.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { locksStore } from "$lib/stores/locks.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { toastsStore } from "$lib/stores/toasts.svelte.ts";
import { pageLockId } from "$lib/collab/page-lock-id.ts";
import type { AuthUser } from "$lib/api/client.ts";

function user(role: string, overrides: Partial<AuthUser> = {}): AuthUser {
	return {
		id: "user-1",
		email: "u@example.com",
		name: "Editor",
		role: role as AuthUser["role"],
		emailVerified: true,
		...overrides,
	} as AuthUser;
}

function signInAs(role: string, overrides: Partial<AuthUser> = {}): void {
	authStore.__setSessionForTesting({
		user: user(role, overrides),
		tokens: { accessToken: "a", refreshToken: "r" },
	});
}

let setMultiPageMode: ReturnType<typeof vi.fn>;

beforeEach(() => {
	setMultiPageMode = vi.fn();
	editorStore.editor = {
		setMultiPageMode,
		getPageSegmentCount: () => 3,
	};
	editorStore.multiPageMode = false;
	authStore.__resetForTesting();
	locksStore.__resetForTesting();
	toastsStore.dismissAll();
	// A long-page project on page index 1.
	projectStore.project = {
		projectId: "proj-1",
		currentPage: 1,
		pages: [],
	} as any;
});

afterEach(() => {
	editorStore.editor = null;
	authStore.__resetForTesting();
	locksStore.__resetForTesting();
	toastsStore.dismissAll();
	projectStore.project = null as any;
});

describe("EditorStore.setMultiPageMode role gate", () => {
	it("denies a translator (no clean/typeset) and warns", () => {
		signInAs("translator");
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(false);
		expect(setMultiPageMode).not.toHaveBeenCalled();
		expect(toastsStore.items.some((t) => t.id === "multi-page-role-gate")).toBe(true);
	});

	it("denies an anonymous session", () => {
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(false);
		expect(setMultiPageMode).not.toHaveBeenCalled();
	});

	it("allows a cleaner and drives the editor clip toggle", () => {
		signInAs("cleaner");
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(true);
		expect(setMultiPageMode).toHaveBeenCalledWith(true);
	});

	it("allows a typesetter", () => {
		signInAs("typesetter");
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(true);
		expect(setMultiPageMode).toHaveBeenCalledWith(true);
	});
});

describe("EditorStore.setMultiPageMode lock gate", () => {
	it("blocks enabling when another member holds the current page lock", () => {
		signInAs("cleaner");
		locksStore.locks = new Map([
			["lock-1", {
				lockId: "lock-1",
				scope: "page",
				// Canonical page lock id — MUST match what the lease store acquires and
				// the gate looks up (codex P1-1: acquire id == lookup id).
				scopeId: pageLockId("proj-1", 1),
				owner: "someone-else",
				acquiredAt: Date.now(),
			}],
		]);
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(false);
		expect(setMultiPageMode).not.toHaveBeenCalled();
		expect(toastsStore.items.some((t) => t.id === "multi-page-lock-gate")).toBe(true);
	});

	it("allows enabling when the lock is held by the current user", () => {
		signInAs("cleaner", { id: "owner-me" });
		locksStore.locks = new Map([
			["lock-1", {
				lockId: "lock-1",
				scope: "page",
				// Canonical page lock id — MUST match what the lease store acquires and
				// the gate looks up (codex P1-1: acquire id == lookup id).
				scopeId: pageLockId("proj-1", 1),
				owner: "owner-me",
				acquiredAt: Date.now(),
			}],
		]);
		editorStore.setMultiPageMode(true);
		expect(editorStore.multiPageMode).toBe(true);
		expect(setMultiPageMode).toHaveBeenCalledWith(true);
	});
});

describe("EditorStore.toggleMultiPageMode", () => {
	it("turning OFF is always allowed (no role/lock check) and re-clips the page", () => {
		signInAs("cleaner");
		editorStore.setMultiPageMode(true);
		setMultiPageMode.mockClear();
		editorStore.setMultiPageMode(false);
		expect(editorStore.multiPageMode).toBe(false);
		expect(setMultiPageMode).toHaveBeenCalledWith(false);
	});
});
