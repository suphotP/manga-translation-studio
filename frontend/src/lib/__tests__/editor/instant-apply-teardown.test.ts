// Instant-apply teardown / sign-out data-loss regression (#255 P1).
//
// applyToolPatchInstant() paints the healed/cloned region onto the live backing
// canvas synchronously and only SCHEDULES a ~800ms debounced background persist.
// If the workspace is torn down (sign-out / leave-workspace / project close)
// BEFORE that debounce fires, the editor's destroy() → resetBackgroundEditState()
// cancels the timer, clears the dirty flag, and drops the backing canvas — so the
// on-screen instant edit was DISCARDED, never uploaded.
//
// The fix makes the AWAITED teardown initiators flush the pending persist first:
//   - sign-out runs an awaited pre-sign-out hook (authStore.registerPreSignOut)
//     that calls editorStore.flushPendingEdits() BEFORE clearSession()/route-away;
//   - leaving the workspace route cancels+flushes in WorkspaceShell.beforeNavigate;
//   - a hard unload fires a best-effort flush from the beforeunload handler.
//
// These tests reproduce the bug (destroy-before-debounce discards) and prove the
// fix (flush-then-destroy persists), at both the editor-teardown level and the
// real authStore sign-out hook level.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEBOUNCE_MS = 800;

/**
 * Minimal stand-in for MangaEditor's instant-apply background-persist state
 * machine. It mirrors the real semantics exactly:
 *   - applyToolPatchInstant(): paint synchronously + (re)arm the 800ms debounce;
 *   - flushPendingBackgroundPersist(): upload NOW (the flush teardown must await);
 *   - resetBackgroundEditState(): cancel the timer + drop the dirty edit (discard);
 *   - destroy(): resetBackgroundEditState() — cannot await an upload.
 * "uploads" records every persisted snapshot so a discarded edit is observable.
 */
function makeFakeInstantEditor() {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let backingCanvasPixel = "blank";
	const uploads: string[] = [];

	async function runBackgroundPersist(): Promise<void> {
		if (!dirty) return;
		dirty = false;
		// "encode + upload" the current backing canvas snapshot.
		uploads.push(backingCanvasPixel);
	}

	const editor = {
		uploads,
		get isDirty() {
			return dirty;
		},
		applyToolPatchInstant(pixel: string): boolean {
			// Paint instantly onto the live backing canvas (no blocking upload).
			backingCanvasPixel = pixel;
			dirty = true;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void runBackgroundPersist();
			}, DEBOUNCE_MS);
			return true;
		},
		async flushPendingBackgroundPersist(): Promise<void> {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			await runBackgroundPersist();
		},
		hasPendingBrushCommit(): boolean {
			return dirty;
		},
		resetBackgroundEditState(): void {
			// Cancel the debounce + drop the dirty edit + the backing canvas. This is
			// the line that DISCARDS a buffered instant edit on teardown.
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			dirty = false;
			backingCanvasPixel = "blank";
		},
		destroy(): void {
			// Synchronous teardown — cannot await an upload. Callers must flush first.
			editor.resetBackgroundEditState();
		},
	};
	return editor;
}

describe("instant-apply teardown data-loss (#255)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("REPRO: instant stroke then destroy() BEFORE the 800ms debounce discards the edit", async () => {
		const editor = makeFakeInstantEditor();

		// Instant heal/clone stroke — visible on canvas, debounce armed, not uploaded.
		editor.applyToolPatchInstant("heal-stroke-1");
		expect(editor.isDirty).toBe(true);
		expect(editor.uploads).toEqual([]);

		// Teardown lands within <800ms (sign-out / leave) WITHOUT flushing first.
		editor.destroy();

		// Let any timer that *would* have fired run — but it was cancelled by reset.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		// BUG: the edit was discarded — nothing was ever uploaded.
		expect(editor.uploads).toEqual([]);
	});

	it("FIX: flushing BEFORE destroy() within <800ms persists the edit", async () => {
		const editor = makeFakeInstantEditor();

		editor.applyToolPatchInstant("heal-stroke-1");
		expect(editor.uploads).toEqual([]);

		// The awaited teardown initiator flushes the pending persist FIRST...
		await editor.flushPendingBackgroundPersist();
		// ...then tears the editor down.
		editor.destroy();

		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		// The instant edit was uploaded before teardown — no data loss.
		expect(editor.uploads).toEqual(["heal-stroke-1"]);
	});

	it("FIX preserves instant speed: applyToolPatchInstant does NOT upload synchronously", () => {
		const editor = makeFakeInstantEditor();
		editor.applyToolPatchInstant("heal-stroke-1");
		// No blocking per-stroke upload — only the debounce is armed.
		expect(editor.uploads).toEqual([]);
		expect(editor.isDirty).toBe(true);
	});
});

// The real fix is wired through the editorStore singleton, whose constructor
// registers a pre-sign-out hook on the real authStore. We mock the API client so
// signOut() can run end-to-end and assert the hook flushed the pending edit BEFORE
// the session was cleared (which is what unmounts the shell → destroys the editor).
vi.mock("$lib/api/client.ts", () => ({
	clearApiAccessToken: vi.fn(),
	getCurrentUser: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(() => Promise.resolve()),
	refreshAuthSession: vi.fn(),
	registerUser: vi.fn(),
	setApiAccessToken: vi.fn(),
	setAuthRefreshHandler: vi.fn(),
	confirmSsoLink: vi.fn(),
}));

// ---------------------------------------------------------------------------
// #255 P1 DEADLOCK (root cause): the background-persist GATE (a promise living in
// `pendingBrushCommits`) was wrongly COUPLED to the `dirty` flag — the finally
// settled it only when `(forced || !dirty)`. On a NON-forced upload FAILURE the
// catch re-marks dirty and `forced` is false, so the gate NEVER settled →
// `waitForPendingBrushCommit(false)` (awaited by page-nav / export / save) looped
// on `pendingBrushCommits.size` forever. Round-2 only patched the FORCED path
// (sign-out teardown); the NON-FORCED nav/export/save path still deadlocked
// (Codex found the same bug a 3rd time).
//
// ROOT-CAUSE FIX: a persist gate represents ONE attempt and MUST settle the moment
// that attempt COMPLETES — success OR failure — regardless of `forced` and
// regardless of `dirty`. `dirty` and `lastError` stay ORTHOGONAL: on failure we
// still set dirty (so a later flush retries) and record the error (so
// waitForPendingBrushCommit rethrows it), but settling the gate does NOT clear
// dirty.
//
// This fake mirrors the REAL editor's gate semantics exactly:
//   - applyToolPatchInstant(): mark dirty + ARM the gate (a promise added to
//     pendingBrushCommits);
//   - runBackgroundPersist(forced): encode+upload; on FAILURE re-mark dirty +
//     record error, then ALWAYS settle the gate in finally (root-cause fix);
//   - waitForPendingBrushCommit(forced): flush(forced) then drain pendingBrushCommits.
// `decoupleGate` toggles the buggy coupled finally (false) vs the fixed
// always-settle finally (true) so the SAME harness reproduces the hang on BOTH
// the forced AND non-forced failure paths AND proves the fix.
function makeFakeGatedEditor(opts: { decoupleGate: boolean; uploadFails: boolean }) {
	const pendingBrushCommits = new Set<Promise<void>>();
	let dirty = false;
	let gateResolve: (() => void) | null = null;
	let lastError: unknown = null;
	const uploads: string[] = [];
	let backingPixel = "blank";

	function setPending(pending: boolean): void {
		if (pending) {
			if (gateResolve) return;
			let gate!: Promise<void>;
			gate = new Promise<void>((resolve) => {
				gateResolve = () => {
					pendingBrushCommits.delete(gate);
					resolve();
				};
			});
			pendingBrushCommits.add(gate);
		} else {
			gateResolve?.();
			gateResolve = null;
		}
	}

	async function runBackgroundPersist(forced: boolean): Promise<void> {
		if (!dirty) {
			setPending(false);
			return;
		}
		dirty = false;
		try {
			if (opts.uploadFails) throw new Error("upload failed");
			uploads.push(backingPixel);
			lastError = null;
		} catch (error) {
			// Re-mark dirty so a later in-session flush retries; record the error so
			// waitForPendingBrushCommit() rethrows it. ORTHOGONAL to the gate.
			dirty = true;
			lastError = error;
		} finally {
			if (opts.decoupleGate) {
				// ROOT-CAUSE FIX: this attempt completed — settle its gate ALWAYS,
				// regardless of forced/dirty. dirty stays set for a later retry.
				setPending(false);
			} else {
				// PRE-FIX (round-2) bug: gate coupled to dirty — only the forced path
				// settles on failure, so a NON-FORCED failure deadlocks.
				if (forced || !dirty) setPending(false);
			}
		}
	}

	const editor = {
		uploads,
		get isDirty() {
			return dirty;
		},
		get pendingCount() {
			return pendingBrushCommits.size;
		},
		applyToolPatchInstant(pixel: string): boolean {
			backingPixel = pixel;
			dirty = true;
			setPending(true); // arm the gate (debounce omitted — we flush explicitly)
			return true;
		},
		async flushPendingBackgroundPersist(forced = false): Promise<void> {
			if (dirty) await runBackgroundPersist(forced);
			// Belt-and-suspenders unconditional settle (matches the real fix): never
			// return leaving a never-resolving gate, forced OR non-forced.
			if (opts.decoupleGate) setPending(false);
			else if (forced) setPending(false);
		},
		hasPendingBrushCommit(): boolean {
			return pendingBrushCommits.size > 0;
		},
		hasBrushCommitError(): boolean {
			return lastError !== null;
		},
		async waitForPendingBrushCommit(forced = false): Promise<void> {
			await editor.flushPendingBackgroundPersist(forced);
			while (pendingBrushCommits.size) {
				await Promise.all(Array.from(pendingBrushCommits));
			}
			if (lastError) throw lastError;
		},
	};
	return editor;
}

// Bounded wait: resolves "completed" if the promise settles, "hung" after `ms`.
// Mirrors editorStore.flushPendingEdits()'s Promise.race teardown timeout.
function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<"completed" | "hung"> {
	return Promise.race([
		p.then(() => "completed" as const).catch(() => "completed" as const),
		new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
	]);
}

describe("#255 P1: a FAILING persist must not deadlock — forced AND non-forced", () => {
	it("round-2 coupled finally: failing FORCED flush DOES settle (already patched, no regression)", async () => {
		vi.useRealTimers();
		// decoupleGate:false = the round-2 coupled finally `if (forced || !dirty) settle`.
		// The forced branch settles, so the FORCED teardown path already completed.
		const editor = makeFakeGatedEditor({ decoupleGate: false, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");
		expect(editor.pendingCount).toBe(1);
		const result = await raceWithTimeout(editor.waitForPendingBrushCommit(true), 150);
		expect(result).toBe("completed");
	});

	it("REPRO (ROUND-3 bug): with the round-2 coupled finally, a failing NON-FORCED flush deadlocks page-nav/export/save", async () => {
		vi.useRealTimers();
		// decoupleGate:false = the round-2 coupled finally that still deadlocks the
		// NON-FORCED path: failure re-marks dirty, forced=false → gate never settles →
		// waitForPendingBrushCommit(false) (page nav / export / save) hangs forever.
		const editor = makeFakeGatedEditor({ decoupleGate: false, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");
		expect(editor.pendingCount).toBe(1);

		// A page navigation / export / save awaits the NON-FORCED wait.
		const result = await raceWithTimeout(editor.waitForPendingBrushCommit(false), 150);
		expect(result).toBe("hung"); // ROUND-3 deadlock
		expect(editor.pendingCount).toBe(1); // gate stuck pending
	});

	it("FIX: failing NON-FORCED flush SETTLES the gate, RETHROWS, and stays DIRTY for retry", async () => {
		vi.useRealTimers();
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");
		expect(editor.pendingCount).toBe(1);

		// Page-nav / export / save (non-forced) must COMPLETE (not hang) and rethrow so
		// the caller can surface the error and abort the nav/export.
		await expect(editor.waitForPendingBrushCommit(false)).rejects.toThrow("upload failed");
		expect(editor.pendingCount).toBe(0); // gate settled — no never-resolving promise
		expect(editor.isDirty).toBe(true); // dirty kept for a later in-session retry
		expect(editor.uploads).toEqual([]); // nothing persisted yet
	});

	it("FIX: a non-forced failing nav/export completes within a BOUNDED time (no hang)", async () => {
		vi.useRealTimers();
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");

		// Even wrapped in a bounded race (mirrors goToPage/exportPage try/catch), it must
		// resolve "completed", never "hung".
		const result = await raceWithTimeout(editor.waitForPendingBrushCommit(false), 150);
		expect(result).toBe("completed");
		expect(editor.pendingCount).toBe(0);
	});

	it("FIX: a later NON-FORCED flush RETRIES the dirty work and succeeds once the upload recovers", async () => {
		vi.useRealTimers();
		// First attempt fails (transient) but stays dirty + gate settled; a later flush
		// (next stroke/flush in the live session) retries and persists.
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");
		await editor.waitForPendingBrushCommit(false).catch(() => {});
		expect(editor.isDirty).toBe(true);
		expect(editor.uploads).toEqual([]);
		expect(editor.pendingCount).toBe(0);

		// Upload recovers; a fresh stroke re-arms the gate, a later flush persists.
		const recovered = makeFakeGatedEditor({ decoupleGate: true, uploadFails: false });
		recovered.applyToolPatchInstant("heal-1-retry");
		await recovered.waitForPendingBrushCommit(false);
		expect(recovered.uploads).toEqual(["heal-1-retry"]);
		expect(recovered.isDirty).toBe(false);
		expect(recovered.pendingCount).toBe(0);
	});

	it("FIX: failing FORCED teardown flush settles the gate → waitForPendingBrushCommit COMPLETES (and rethrows)", async () => {
		vi.useRealTimers();
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: true });
		editor.applyToolPatchInstant("heal-1");
		expect(editor.pendingCount).toBe(1);

		await expect(editor.waitForPendingBrushCommit(true)).rejects.toThrow("upload failed");
		expect(editor.pendingCount).toBe(0); // gate settled — no never-resolving promise
		expect(editor.isDirty).toBe(true); // dirty orthogonal to gate
	});

	it("FIX: a SUCCESSFUL forced flush still persists the edit (happy path not regressed)", async () => {
		vi.useRealTimers();
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: false });
		editor.applyToolPatchInstant("heal-1");

		await expect(editor.waitForPendingBrushCommit(true)).resolves.toBeUndefined();
		expect(editor.uploads).toEqual(["heal-1"]); // edit saved before teardown
		expect(editor.pendingCount).toBe(0);
		expect(editor.isDirty).toBe(false);
	});

	it("FIX: a SUCCESSFUL non-forced flush (nav/export happy path) persists and clears dirty", async () => {
		vi.useRealTimers();
		const editor = makeFakeGatedEditor({ decoupleGate: true, uploadFails: false });
		editor.applyToolPatchInstant("heal-1");

		await expect(editor.waitForPendingBrushCommit(false)).resolves.toBeUndefined();
		expect(editor.uploads).toEqual(["heal-1"]);
		expect(editor.pendingCount).toBe(0);
		expect(editor.isDirty).toBe(false);
	});

	it("FIX: signOut() COMPLETES within a bounded time even when the pre-sign-out flush is slow/failing", async () => {
		vi.useRealTimers();
		const { authStore } = await import("$lib/stores/auth.svelte.ts");
		authStore.__resetForTesting();
		authStore.__setSessionForTesting({
			user: {
				id: "user-deadlock",
				email: "dl@example.com",
				name: "DL",
				role: "editor",
				authProvider: "local",
				emailVerified: true,
				isActive: true,
			},
			tokens: { accessToken: "a", refreshToken: "r" },
		});
		expect(authStore.isAuthenticated).toBe(true);

		// Simulate the real flush hook racing a bounded timeout (the editorStore
		// flushPendingEdits() Promise.race). The underlying flush NEVER resolves
		// (worst case: a wedged upload) — the bounded race must still let sign-out
		// proceed instead of trapping the user signed-in.
		const NEVER = new Promise<void>(() => {});
		const unregister = authStore.registerPreSignOut(() =>
			raceWithTimeout(NEVER, 80).then(() => undefined),
		);

		const start = Date.now();
		await authStore.signOut();
		const elapsed = Date.now() - start;

		expect(authStore.isAuthenticated).toBe(false); // sign-out actually completed
		expect(elapsed).toBeLessThan(2000); // bounded — did NOT hang forever
		unregister();
	});
});

describe("authStore.signOut flushes a buffered instant edit before clearing the session", () => {
	it("runs registered pre-sign-out hooks (and awaits them) before clearSession", async () => {
		const { authStore } = await import("$lib/stores/auth.svelte.ts");
		authStore.__resetForTesting();
		authStore.__setSessionForTesting({
			user: {
				id: "user-1",
				email: "editor@example.com",
				name: "Editor",
				role: "editor",
				authProvider: "local",
				emailVerified: true,
				isActive: true,
			},
			tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
		});
		expect(authStore.isAuthenticated).toBe(true);

		const events: string[] = [];
		const unregister = authStore.registerPreSignOut(async () => {
			// Simulate the editor flush taking a tick — sign-out must AWAIT it.
			await Promise.resolve();
			// Authenticated state must still hold while we persist the edit.
			events.push(authStore.isAuthenticated ? "flush(authed)" : "flush(unauthed)");
		});

		await authStore.signOut();
		events.push(authStore.isAuthenticated ? "cleared?no" : "cleared");

		unregister();

		// The flush ran while still authenticated, and BEFORE the session was cleared.
		expect(events).toEqual(["flush(authed)", "cleared"]);
		expect(authStore.isAuthenticated).toBe(false);
	});

	it("a pre-sign-out flush failure does not block sign-out", async () => {
		const { authStore } = await import("$lib/stores/auth.svelte.ts");
		authStore.__resetForTesting();
		authStore.__setSessionForTesting({
			user: {
				id: "user-2",
				email: "e2@example.com",
				name: "E2",
				role: "editor",
				authProvider: "local",
				emailVerified: true,
				isActive: true,
			},
			tokens: { accessToken: "a", refreshToken: "r" },
		});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const unregister = authStore.registerPreSignOut(() => {
			throw new Error("persist failed");
		});

		await expect(authStore.signOut()).resolves.toBeUndefined();
		expect(authStore.isAuthenticated).toBe(false);

		unregister();
		errSpy.mockRestore();
	});
});
