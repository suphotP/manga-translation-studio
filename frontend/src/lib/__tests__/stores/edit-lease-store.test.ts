// Concurrent-edit Phase 1 — edit-lease lifecycle.
//
// Proves: a lease is ACQUIRED on edit-start and RELEASED on edit-end; a 2nd
// session/tab on a leased page is STEERED (held-by-self-tab / held-by-other),
// not silently clobbered; and the lock service being unavailable degrades to
// "edit anyway" (so the editor is never blocked and CAS stays the net).

import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal ApiError shape with the fields the lease store reads via instanceof.
// Defined inside the mock factory (hoisted) and re-exported so the test can `new`
// it for rejections.
vi.mock("$lib/api/client.ts", () => {
	class MockApiError extends Error {
		status: number;
		code?: string;
		retryAfter?: number;
		body?: unknown;
		constructor(status: number, code: string | undefined, body: unknown, retryAfter?: number) {
			super(`api error ${status}`);
			this.status = status;
			this.code = code;
			this.body = body;
			this.retryAfter = retryAfter;
		}
	}
	return {
		ApiError: MockApiError,
		acquireWorkLock: vi.fn(),
		extendWorkLock: vi.fn(),
		releaseWorkLock: vi.fn(async () => {}),
	};
});

// Avoid BroadcastChannel/sessionStorage side-effects in jsdom — the session store
// is exercised separately; here we only need its identity + no-op coordination.
vi.mock("$lib/stores/edit-session.svelte.ts", () => ({
	editSessionStore: {
		clientId: "tab-test-1",
		wire: vi.fn(),
		onReleaseRequest: vi.fn(),
		announceEditing: vi.fn(),
		announceStopped: vi.fn(),
		requestReleaseFromPeer: vi.fn(),
		peerEditing: vi.fn(() => undefined),
	},
}));

import { editLeaseStore, pageLockUnitId } from "$lib/stores/edit-lease.svelte.ts";
import { pageLockId } from "$lib/collab/page-lock-id.ts";
import * as apiClient from "$lib/api/client.ts";

const MockApiError = apiClient.ApiError as unknown as new (status: number, code: string | undefined, body: unknown, retryAfter?: number) => Error;
const acquireWorkLock = apiClient.acquireWorkLock as unknown as ReturnType<typeof vi.fn>;
const extendWorkLock = apiClient.extendWorkLock as unknown as ReturnType<typeof vi.fn>;
const releaseWorkLock = apiClient.releaseWorkLock as unknown as ReturnType<typeof vi.fn>;

const target = { projectId: "proj-1", pageIndex: 2, workspaceId: "ws-1" };
const unitId = pageLockUnitId(target.projectId, target.pageIndex);

beforeEach(() => {
	editLeaseStore.__resetForTesting();
	acquireWorkLock.mockReset();
	extendWorkLock.mockReset();
	releaseWorkLock.mockClear();
});

describe("editLeaseStore", () => {
	it("derives the canonical page unit id (project:page:n, NOT the image id)", () => {
		expect(pageLockUnitId("proj-1", 2)).toBe("proj-1:page:2");
	});

	it("the lease ACQUIRE id and the consumer LOOKUP id are the SAME canonical id (no mismatch)", () => {
		// The store derives the acquire scopeId from pageLockUnitId; the presence UI
		// (LockOwnerIndicator) + multi-page gate (editor store) look up via pageLockId.
		// Codex P1-1: these MUST be identical or the new lease is invisible to the old
		// UI and never blocks a second editor. One source of truth → assert equality.
		expect(pageLockUnitId("proj-1", 2)).toBe(pageLockId("proj-1", 2));
		expect(pageLockUnitId).toBe(pageLockId);
	});

	it("acquires with the SAME id a consumer would look up (acquire == lookup)", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		const acquiredScopeId = acquireWorkLock.mock.calls[0]![0].scopeId;
		// A LockOwnerIndicator / editor multi-page gate for the same page derives this:
		const lookupScopeId = pageLockId(target.projectId, target.pageIndex);
		expect(acquiredScopeId).toBe(lookupScopeId);
	});

	it("acquires a lease on edit-start with the page scope + canonical unit + tab client id", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString(), clientId: "tab-test-1" });
		await editLeaseStore.beginPageEdit(target);
		expect(acquireWorkLock).toHaveBeenCalledTimes(1);
		expect(acquireWorkLock).toHaveBeenCalledWith(expect.objectContaining({
			scope: "page",
			scopeId: unitId,
			projectId: "proj-1",
			workspaceId: "ws-1",
			clientId: "tab-test-1",
			takeover: false,
		}));
		expect(editLeaseStore.status).toBe("held");
		expect(editLeaseStore.isHeld).toBe(true);
	});

	it("releases the lease on edit-end", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		await editLeaseStore.endPageEdit();
		expect(releaseWorkLock).toHaveBeenCalledWith("lock-1");
		expect(editLeaseStore.status).toBe("idle");
	});

	it("steers a 2nd tab of the SAME user (held-by-self-tab) instead of clobbering", async () => {
		acquireWorkLock.mockRejectedValue(new MockApiError(409, "lock_same_user_conflict", {
			held_by_user_id: "user-1",
			held_by_client_id: "tab-other",
			lock_id: "lock-existing",
			expires_at: new Date(Date.now() + 120000).toISOString(),
		}));
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.status).toBe("held-by-self-tab");
		expect(editLeaseStore.heldBySelfOtherTab).toBe(true);
		expect(editLeaseStore.conflict?.heldByClientId).toBe("tab-other");
		// It must NOT have a held lease (no clobber).
		expect(editLeaseStore.isHeld).toBe(false);
	});

	it("steers when ANOTHER user holds the page (held-by-other), surfacing the owner", async () => {
		acquireWorkLock.mockRejectedValue(new MockApiError(409, "lock_conflict", {
			held_by_user_id: "ann",
			expires_at: new Date(Date.now() + 120000).toISOString(),
		}));
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.status).toBe("held-by-other");
		expect(editLeaseStore.heldByOther).toBe(true);
		expect(editLeaseStore.conflict?.heldByUserId).toBe("ann");
	});

	it("take-over re-acquires with takeover:true and becomes the holder", async () => {
		acquireWorkLock.mockRejectedValueOnce(new MockApiError(409, "lock_same_user_conflict", {
			held_by_user_id: "user-1", held_by_client_id: "tab-other", lock_id: "lock-existing", expires_at: new Date().toISOString(),
		}));
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.status).toBe("held-by-self-tab");

		acquireWorkLock.mockResolvedValueOnce({ lockId: "lock-new", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.takeOver();
		expect(acquireWorkLock).toHaveBeenLastCalledWith(expect.objectContaining({ takeover: true }));
		expect(editLeaseStore.status).toBe("held");
	});

	it("never blocks the editor when the lock service is unavailable (degrades to edit-anyway)", async () => {
		acquireWorkLock.mockRejectedValue(new MockApiError(503, "work_lock_store_unavailable", {}));
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.status).toBe("unavailable");
		// No conflict surfaced — the user just edits, CAS guards the save.
		expect(editLeaseStore.conflict).toBeNull();
	});

	it("backs off repeated acquire attempts while the lock service is unavailable", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
		try {
			acquireWorkLock.mockRejectedValue(new MockApiError(503, "work_lock_service_unavailable", {}, 30));

			await editLeaseStore.beginPageEdit(target);
			expect(editLeaseStore.status).toBe("unavailable");
			expect(editLeaseStore.unavailable?.retryAt).toBe(Date.now() + 30_000);
			expect(acquireWorkLock).toHaveBeenCalledTimes(1);

			await editLeaseStore.beginPageEdit(target);
			expect(acquireWorkLock).toHaveBeenCalledTimes(1);

			acquireWorkLock.mockResolvedValueOnce({ lockId: "lock-after-backoff", expiresAt: new Date(Date.now() + 180000).toISOString() });
			await vi.advanceTimersByTimeAsync(30_000);

			expect(acquireWorkLock).toHaveBeenCalledTimes(2);
			expect(editLeaseStore.status).toBe("held");
			expect(editLeaseStore.unavailable).toBeNull();
		} finally {
			editLeaseStore.__resetForTesting();
			vi.useRealTimers();
		}
	});

	it("releases the previous page's lease when switching pages", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-p2", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		acquireWorkLock.mockResolvedValue({ lockId: "lock-p5", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit({ projectId: "proj-1", pageIndex: 5, workspaceId: "ws-1" });
		expect(releaseWorkLock).toHaveBeenCalledWith("lock-p2");
		expect(editLeaseStore.status).toBe("held");
	});

	it("exposes the held lock id while held (so /save can send x-edit-lock-id), null otherwise", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.heldLockId).toBe("lock-1");
		await editLeaseStore.endPageEdit();
		expect(editLeaseStore.heldLockId).toBeNull();
	});

	// P0-2: the page-scope marker the /save path sends as x-edit-page-scoped. It must be
	// true throughout the page-edit session (so the backend can REQUIRE the lease header
	// and a displaced/buggy client can't dodge the lease check by omitting it) and stay
	// true EVEN AFTER a takeover (when heldLockId becomes null) — only endPageEdit clears
	// it. Otherwise the exact takeover-clobber attack would slip past the require gate.
	it("pageEditScopeActive is true across the whole page-edit session (incl. after takeover)", async () => {
		expect(editLeaseStore.pageEditScopeActive).toBe(false); // idle, no page open
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.pageEditScopeActive).toBe(true);

		// Simulate a takeover (heartbeat 404): heldLockId goes null but the page is still
		// open, so the scope marker must remain true.
		extendWorkLock.mockRejectedValueOnce(new MockApiError(404, "lock_not_found", {}));
		await editLeaseStore.__heartbeatForTesting();
		expect(editLeaseStore.heldLockId).toBeNull();
		expect(editLeaseStore.pageEditScopeActive).toBe(true);

		await editLeaseStore.endPageEdit();
		expect(editLeaseStore.pageEditScopeActive).toBe(false);
	});

	// C2/C3: the heartbeat-404-after-takeover regression. A heartbeat that 404s (the
	// lease row is gone because someone took it over) MUST NOT silently re-acquire —
	// doing so resurrects a surrendered lease and lets the displaced tab keep editing
	// and clobbering. Instead the store flips read-only ("taken-over") + fires the
	// takeover handler so the project store snapshots a recovery draft.
	it("heartbeat 404 after takeover flips to 'taken-over' and does NOT re-acquire", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		expect(editLeaseStore.status).toBe("held");
		const onTakenOver = vi.fn();
		editLeaseStore.onTakenOver(onTakenOver);

		const acquireCallsBefore = acquireWorkLock.mock.calls.length;
		extendWorkLock.mockRejectedValueOnce(new MockApiError(404, "lock_not_found", {}));
		await editLeaseStore.__heartbeatForTesting();

		expect(editLeaseStore.status).toBe("taken-over");
		expect(editLeaseStore.takenOver).toBe(true);
		expect(onTakenOver).toHaveBeenCalledTimes(1);
		// CRITICAL: no re-acquire was attempted (the resurrection bug).
		expect(acquireWorkLock.mock.calls.length).toBe(acquireCallsBefore);
		// The lease handle is dropped (no longer claims to hold the page).
		expect(editLeaseStore.heldLockId).toBeNull();
	});

	it("heartbeat 409 (re-held by another) also flips to 'taken-over' without re-acquiring", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		const onTakenOver = vi.fn();
		editLeaseStore.onTakenOver(onTakenOver);
		const acquireCallsBefore = acquireWorkLock.mock.calls.length;
		extendWorkLock.mockRejectedValueOnce(new MockApiError(409, "lock_conflict", {}));
		await editLeaseStore.__heartbeatForTesting();
		expect(editLeaseStore.status).toBe("taken-over");
		expect(acquireWorkLock.mock.calls.length).toBe(acquireCallsBefore);
		expect(onTakenOver).toHaveBeenCalledTimes(1);
	});

	it("a SINGLE transient heartbeat error (network blip / 5xx) does NOT nuke the session", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		const onTakenOver = vi.fn();
		editLeaseStore.onTakenOver(onTakenOver);
		// One 5xx flake → still held, no takeover.
		extendWorkLock.mockRejectedValueOnce(new MockApiError(503, "upstream", {}));
		await editLeaseStore.__heartbeatForTesting();
		expect(editLeaseStore.status).toBe("held");
		expect(onTakenOver).not.toHaveBeenCalled();
		// A subsequent successful heartbeat clears the transient counter + keeps the lease.
		extendWorkLock.mockResolvedValueOnce({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.__heartbeatForTesting();
		expect(editLeaseStore.status).toBe("held");
	});

	it("repeated transient heartbeat failures eventually step back to 'unavailable' (never taken-over)", async () => {
		acquireWorkLock.mockResolvedValue({ lockId: "lock-1", expiresAt: new Date(Date.now() + 180000).toISOString() });
		await editLeaseStore.beginPageEdit(target);
		const onTakenOver = vi.fn();
		editLeaseStore.onTakenOver(onTakenOver);
		extendWorkLock.mockRejectedValue(new MockApiError(500, "upstream", {}));
		await editLeaseStore.__heartbeatForTesting();
		await editLeaseStore.__heartbeatForTesting();
		await editLeaseStore.__heartbeatForTesting();
		expect(editLeaseStore.status).toBe("unavailable");
		// A transient outage is NOT a takeover — no recovery snapshot forced.
		expect(onTakenOver).not.toHaveBeenCalled();
	});
});
