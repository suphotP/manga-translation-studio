// Autosave debounce + named-version store behavior (Wave 3 W3.20)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { createProjectStateFingerprint } from "$lib/project/project-state-fingerprint.ts";
import {
	AUTOSAVE_DEBOUNCE_MS,
	projectStore,
} from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState, TextLayer } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {
		readonly status: number;
		readonly statusText: string;
		readonly body?: unknown;
		constructor(message: string, details: { status: number; statusText: string; body?: unknown }) {
			super(message);
			this.name = "ApiError";
			this.status = details.status;
			this.statusText = details.statusText;
			this.body = details.body;
		}
	},
	saveProject: vi.fn(),
	loadProject: vi.fn(),
	getProjectVersions: vi.fn(),
	createNamedProjectVersion: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

// A manually-resolvable promise. Used to keep a mocked saveProject() POST "in
// flight" so the single-flight gate tests can interleave a second save before the
// first resolves. `resolve` is typed (never narrowed to `never` at the call site,
// unlike a `let resolver: (() => void) | null` assigned inside a closure).
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// Backend-pattern UUID so canUseBackendProjectEndpoints() is true (autosave only
// runs for backend-backed projects).
const BACKEND_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "แปลเสร็จแล้ว",
		x: 10,
		y: 20,
		w: 160,
		h: 48,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: BACKEND_PROJECT_ID,
		name: "Autosave Project",
		createdAt: "2026-05-14T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page({ textLayers: [textLayer()] })],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.mocked(api.saveProject).mockResolvedValue(undefined);
	// assertNoStaleRemoteOverwrite() loads the remote project to compare
	// fingerprints; returning the current store state keeps fingerprints equal so
	// the save proceeds without a (spurious) conflict.
	vi.mocked(api.loadProject).mockImplementation(async () =>
		JSON.parse(JSON.stringify(projectStore.project)) as ProjectState,
	);
	vi.mocked(api.getProjectVersions).mockResolvedValue({ versions: [] });
	vi.mocked(api.createNamedProjectVersion).mockResolvedValue({
		version: {
			versionId: "v-named",
			projectId: BACKEND_PROJECT_ID,
			name: "Autosave Project",
			source: "manual",
			label: "Before QC",
			author: "me@example.com",
			createdAt: "2026-05-14T00:05:00.000Z",
			pageCount: 1,
			textLayerCount: 1,
		},
	});
	projectStore.__resetForTesting();
});

afterEach(() => {
	projectStore.__resetForTesting();
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

describe("ProjectStore autosave debounce", () => {
	it("coalesces rapid edits into a single save after the debounce window", async () => {
		projectStore.__setProjectForTesting(project());
		expect(projectStore.saveSyncStatus).toBe("saved");

		// Three rapid edits within the debounce window must collapse into one save.
		projectStore.markCurrentPageUnsaved();
		vi.advanceTimersByTime(2000);
		projectStore.markCurrentPageUnsaved();
		vi.advanceTimersByTime(2000);
		projectStore.markCurrentPageUnsaved();
		expect(projectStore.saveSyncStatus).toBe("unsaved");
		expect(api.saveProject).not.toHaveBeenCalled();

		// Only after edits settle for the full window does the save fire.
		vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
		await vi.runOnlyPendingTimersAsync();

		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("re-arms the autosave debounce after a FAILED save so dirty work is retried (no wedge)", async () => {
		// P1 data-loss regression guard. A transient save failure used to leave the
		// store in "error" with dirtyVersion>0 but NO pending timer — and the failure
		// finally-block only re-armed on "unsaved", so autosave wedged: if the user
		// stopped editing, the work was never retried/persisted. The first save must
		// fail, the second (rescheduled) save must fire on its own and land the edit.
		vi.mocked(api.saveProject)
			.mockRejectedValueOnce(new Error("network blip"))
			.mockResolvedValue(undefined);

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();

		// First debounce → save attempt fails → status "error", still dirty.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("error");

		// WITHOUT any new edit, the failure must have re-armed the debounce. Advancing
		// the timer alone fires the retry, which now succeeds and persists the work.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("does NOT re-arm autosave after a save CONFLICT (no idle 409 retry storm)", async () => {
		// Multi-tab data-safety: unlike a transient network blip, a stale-baseline
		// conflict will ALWAYS 409 until the user reloads (the baseline cannot
		// self-heal). The finally-block re-arm must therefore EXCLUDE a conflict, or
		// an idle conflicted tab fires a fresh autosave every AUTOSAVE_DEBOUNCE_MS,
		// GETs the project, recomputes the same stale fingerprint, and 409s again,
		// indefinitely — hammering the backend with no recovery benefit.
		projectStore.__setProjectForTesting(project());
		// Make the next save attempt see a DIVERGED remote (different fingerprint than
		// both the store baseline and the local edit) → assertNoStaleRemoteOverwrite()
		// throws ProjectSaveConflictError.
		vi.mocked(api.loadProject).mockResolvedValue(
			project({ name: "Remote edited by another tab" }),
		);
		projectStore.markCurrentPageUnsaved();

		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(api.saveProject).not.toHaveBeenCalled(); // conflict caught BEFORE the write
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");

		// Idle for several windows — NO further save/load attempt may fire on its own.
		const loadCallsAfterConflict = vi.mocked(api.loadProject).mock.calls.length;
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 4);
		expect(vi.mocked(api.loadProject).mock.calls.length).toBe(loadCallsAfterConflict);
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.saveErrorKind).toBe("conflict");
	});

	it("does not endlessly re-save after a clean success (dirtyVersion>0 but status saved)", async () => {
		// completeSave() does not reset dirtyVersion, so the finally re-arm must gate on
		// STATUS, not just hasLocalProjectChanges() — otherwise a clean "saved" would
		// loop. One edit → exactly one save, then quiet.
		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();

		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");

		// No further save fires on its own.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
		expect(api.saveProject).toHaveBeenCalledTimes(1);
	});

	it("does not schedule autosave for non-backend (local) projects", async () => {
		projectStore.__setProjectForTesting(project({ projectId: "flow208-project" }));
		projectStore.markCurrentPageUnsaved();
		vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
		await vi.runOnlyPendingTimersAsync();
		expect(api.saveProject).not.toHaveBeenCalled();
	});

	it("cancelAutosave() clears the pending timer (no leaked save on unmount)", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
		await vi.runOnlyPendingTimersAsync();
		expect(api.saveProject).not.toHaveBeenCalled();
		// Still flagged dirty — a future edit re-arms the debounce.
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("saveNamedVersion flushes pending edits then records a labelled snapshot", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();

		const created = await projectStore.saveNamedVersion("Before QC");

		// Pending edits flushed (saveProject) before the named version is recorded.
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(api.createNamedProjectVersion).toHaveBeenCalledWith(BACKEND_PROJECT_ID, "Before QC");
		expect(created?.source).toBe("manual");
		expect(created?.label).toBe("Before QC");
	});

	it("saveNamedVersion rejects an empty label without calling the API", async () => {
		projectStore.__setProjectForTesting(project());
		const created = await projectStore.saveNamedVersion("   ");
		expect(created).toBeNull();
		expect(api.createNamedProjectVersion).not.toHaveBeenCalled();
	});

	it("waitForAutosaveInFlight resolves immediately when no autosave is running", async () => {
		// With no in-flight autosave, callers (saveNamedVersion / openProject) must not
		// block — the guard is a cheap no-op so the common path stays synchronous.
		projectStore.__setProjectForTesting(project());
		await expect(projectStore.__waitForAutosaveInFlightForTesting()).resolves.toBeUndefined();
	});

	it("goToPage cancels + drains the autosave BEFORE its own save (E2: no concurrent save 409 race)", async () => {
		// E2 regression: with a debounced autosave armed, goToPage used to call
		// saveState() without first cancelling/draining the autosave. A debounced or
		// in-flight autosave POSTing concurrently with goToPage's own save raced the same
		// projectId; the second used a stale baseline fingerprint → spurious 409 that
		// failed a single-user page switch. The fix mirrors the named-version path:
		// cancelAutosave() + waitForAutosaveInFlight() must run BEFORE goToPage's
		// saveState(). We assert that ordering directly (white-box) so removing the guard
		// fails this test, then assert the observable outcome (one save, switch succeeds).
		projectStore.__setProjectForTesting(
			project({ pages: [page({ textLayers: [textLayer()] }), page({ imageId: "image-2.webp" })] }),
		);
		projectStore.markCurrentPageUnsaved();
		expect(projectStore.saveSyncStatus).toBe("unsaved");

		// Record call ORDER: cancelAutosave + waitForAutosaveInFlight must both precede
		// the saveProject write that goToPage triggers.
		const order: string[] = [];
		const cancelSpy = vi
			.spyOn(projectStore, "cancelAutosave")
			.mockImplementation(function (this: typeof projectStore) {
				order.push("cancelAutosave");
			});
		const waitSpy = vi
			.spyOn(
				projectStore as unknown as { waitForAutosaveInFlight: () => Promise<void> },
				"waitForAutosaveInFlight",
			)
			.mockImplementation(async () => {
				order.push("waitForAutosaveInFlight");
			});
		vi.mocked(api.saveProject).mockImplementation(async () => {
			order.push("saveProject");
		});

		const ok = await projectStore.goToPage(1, null);
		expect(ok).toBe(true);
		expect(projectStore.project?.currentPage).toBe(1);

		// The guard ran, in order, before the save POST.
		expect(cancelSpy).toHaveBeenCalled();
		expect(waitSpy).toHaveBeenCalled();
		expect(order.indexOf("cancelAutosave")).toBeLessThan(order.indexOf("saveProject"));
		expect(order.indexOf("waitForAutosaveInFlight")).toBeLessThan(order.indexOf("saveProject"));
		// Exactly one save fired for the switch (no concurrent second POST).
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		cancelSpy.mockRestore();
		waitSpy.mockRestore();
	});

	it("two concurrent saveState() calls issue ONE POST; the second re-evaluates and skips", async () => {
		// P3 single-flight gate: a direct save + a second direct save (or a fired
		// autosave) used to read the SAME projectBaseFingerprint and POST /save
		// concurrently — the CAS loser 409s and drags a single user into the conflict
		// flow. The gate must serialize them: the second AWAITS the first, then
		// re-evaluates. With nothing left dirty after the first persists, the second
		// must NOT POST again.
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			firstStarted.resolve();
			await firstInFlight.promise;
		});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave(); // isolate from the debounce; we drive saveState directly.

		// Fire both saves before the first POST resolves.
		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		const secondSave = projectStore.saveState();

		// The gate must not have started a second concurrent POST while the first is
		// in flight.
		await Promise.resolve();
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		firstInFlight.resolve();
		await Promise.all([firstSave, secondSave]);

		// The first save fully persisted the (only) dirty state and refreshed the
		// baseline; the second re-evaluated as clean → exactly one POST total.
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("dirty-after-first → the awaiting second save fires exactly ONE follow-up with the refreshed fingerprint", async () => {
		// An edit lands WHILE the first save's POST is in flight. The first save
		// persists the pre-edit state and refreshes projectBaseFingerprint; the awaiting
		// second save must then issue exactly ONE follow-up POST carrying the REFRESHED
		// fingerprint (never the pre-first stale baseline, which would self-conflict).
		const baselines: Array<string | null | undefined> = [];
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async (_id, _project, opts) => {
				baselines.push(opts?.baseFingerprint);
				firstStarted.resolve();
				await firstInFlight.promise;
			})
			.mockImplementationOnce(async (_id, _project, opts) => {
				baselines.push(opts?.baseFingerprint);
			});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		const firstBaseline = baselines[0];

		// A new edit arrives mid-save: mutate CONTENT (name is in the fingerprint) so the
		// baseline genuinely moves, then bump dirtyVersion. completeSave() will leave
		// status "unsaved" so the awaiting second save re-evaluates as dirty.
		if (projectStore.project) projectStore.project.name = "Edited mid-save";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		const secondSave = projectStore.saveState();

		firstInFlight.resolve();
		await Promise.all([firstSave, secondSave]);

		// Exactly two POSTs (the first + ONE follow-up), and the follow-up used a baseline
		// REFRESHED by the first save — not the stale pre-first fingerprint.
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(baselines).toHaveLength(2);
		expect(baselines[1]).not.toBe(firstBaseline);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("a save conflict still propagates to the saveState() caller through the gate", async () => {
		// The gate must NOT swallow the conflict for the caller whose save actually
		// POSTs. assertNoStaleRemoteOverwrite() sees a diverged remote → throws
		// ProjectSaveConflictError BEFORE the write; saveState() must reject and the
		// store must enter the conflict recovery state.
		projectStore.__setProjectForTesting(project());
		vi.mocked(api.loadProject).mockResolvedValue(
			project({ name: "Remote edited by another tab" }),
		);
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		await expect(projectStore.saveState()).rejects.toThrow();
		expect(api.saveProject).not.toHaveBeenCalled(); // conflict caught before the POST
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		// The gate slot is released so a later save can run.
		expect(projectStore.__hasSaveInFlightForTesting()).toBe(false);
	});

	it("a direct saveState() concurrent with an in-flight autosave does NOT double-POST", async () => {
		// The unified gate covers the autosave↔direct race too: a fired autosave POST is
		// in flight when a direct saveState() arrives. The direct save must await the
		// autosave's POST and re-evaluate (clean) rather than fire a second concurrent
		// POST with the same baseline.
		const autosaveStarted = deferred();
		const autosaveInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			autosaveStarted.resolve();
			await autosaveInFlight.promise;
		});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();

		// Fire the debounce so the (gated) autosave POST is in flight.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await autosaveStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		// A direct save arrives while the autosave POST is still in flight.
		const directSave = projectStore.saveState();
		await Promise.resolve();
		// No second concurrent POST while the autosave is in flight.
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		autosaveInFlight.resolve();
		await directSave;
		await projectStore.__waitForAutosaveInFlightForTesting();

		// One POST total: the autosave persisted the dirty state; the direct save
		// re-evaluated clean and skipped.
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("the awaiting second save RETRIES (does not rethrow) when the first save fails transiently", async () => {
		// Error semantics: a second saveState() that awaited a FAILED first save must NOT
		// blindly rethrow the first's error. The store is left dirty/"error", so the
		// second issues its OWN fresh save with the refreshed baseline and surfaces its
		// own result — here a success that lands the work.
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async () => {
				firstStarted.resolve();
				await firstInFlight.promise;
				throw new Error("network blip");
			})
			.mockResolvedValue(undefined);

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		const secondSave = projectStore.saveState();

		firstInFlight.resolve();

		// The first caller still sees its own failure.
		await expect(firstSave).rejects.toThrow("network blip");
		// The second caller retried on a fresh baseline and succeeded (no rethrow of the
		// first's error).
		await expect(secondSave).resolves.toBeUndefined();
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("three callers queued behind a follow-up save all resolve only AFTER the follow-up POST completes", async () => {
		// FINDING 1 (round 2): a LATER waiter must not detach from the follow-up save. With
		// several callers queued behind one in-flight POST, the FIRST waiter chains a
		// follow-up save whose beginSave() flips status to "saving". A later waiter that only
		// awaited the ORIGINAL promise would then see needsFollowUpSave() === false ("saving")
		// and RETURN while the follow-up POST is still running — letting the dirty mid-flight
		// edit go unpersisted before a version snapshot / project switch proceeds. The drain
		// LOOP must keep every waiter parked until NO save is in flight.
		const firstStarted = deferred();
		const firstInFlight = deferred();
		const followUpStarted = deferred();
		const followUpInFlight = deferred();
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async () => {
				// POST 1 (the original in-flight save).
				firstStarted.resolve();
				await firstInFlight.promise;
			})
			.mockImplementationOnce(async () => {
				// POST 2 (the follow-up chained by the first waiter) — stays in flight so we
				// can prove the OTHER waiters do not early-return while it runs.
				followUpStarted.resolve();
				await followUpInFlight.promise;
			});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave(); // drive saveState directly; isolate from the debounce.

		// POST 1 begins.
		const save1 = projectStore.saveState();
		await firstStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		// An edit lands WHILE POST 1 is in flight, so completeSave() will leave status
		// "unsaved" → the first waiter that drains will chain a follow-up POST.
		if (projectStore.project) projectStore.project.name = "Edited during first POST";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		// THREE more callers queue behind POST 1.
		const save2 = projectStore.saveState();
		const save3 = projectStore.saveState();
		const save4 = projectStore.saveState();

		// Track which queued callers have settled.
		let save2Done = false;
		let save3Done = false;
		let save4Done = false;
		void save2.then(() => { save2Done = true; });
		void save3.then(() => { save3Done = true; });
		void save4.then(() => { save4Done = true; });

		// Release POST 1. The first waiter wakes, re-evaluates dirty, and chains POST 2.
		firstInFlight.resolve();
		await firstStarted.promise; // (already resolved; just yield)
		await followUpStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(2);

		// CRITICAL: while POST 2 is still in flight, NONE of the queued callers may have
		// resolved — a later waiter must NOT detach because status briefly read "saving".
		await Promise.resolve();
		await Promise.resolve();
		expect(save2Done).toBe(false);
		expect(save3Done).toBe(false);
		expect(save4Done).toBe(false);

		// Complete the follow-up POST → now (and only now) every queued caller resolves.
		followUpInFlight.resolve();
		await Promise.all([save1, save2, save3, save4]);
		expect(save2Done).toBe(true);
		expect(save3Done).toBe(true);
		expect(save4Done).toBe(true);

		// Exactly two POSTs total (the original + ONE follow-up); the mid-flight edit landed.
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("collapses multiple queued saveState() callers into one trailing POST with the latest snapshot", async () => {
		// P3 trailing-save contract: many save triggers can arrive while the first POST is
		// in flight, but they must queue behind a SINGLE follow-up save. That follow-up
		// must clone the live project at follow-up time, not the first queued caller's
		// older snapshot.
		const postedNames: string[] = [];
		let serverState: ProjectState | null = null;
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.loadProject).mockImplementation(async () =>
			JSON.parse(JSON.stringify(serverState ?? projectStore.project)) as ProjectState,
		);
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async (_id, posted) => {
				postedNames.push(posted.name);
				serverState = JSON.parse(JSON.stringify(posted)) as ProjectState;
				firstStarted.resolve();
				await firstInFlight.promise;
			})
			.mockImplementationOnce(async (_id, posted) => {
				postedNames.push(posted.name);
				serverState = JSON.parse(JSON.stringify(posted)) as ProjectState;
			});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const save1 = projectStore.saveState();
		await firstStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		if (projectStore.project) projectStore.project.name = "Queued edit 1";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		const save2 = projectStore.saveState();

		if (projectStore.project) projectStore.project.name = "Queued edit 2";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		const save3 = projectStore.saveState();

		await Promise.resolve();
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		firstInFlight.resolve();
		await Promise.all([save1, save2, save3]);

		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(postedNames).toEqual(["Autosave Project", "Queued edit 2"]);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("propagates an in-flight CAS conflict to queued callers without a trailing retry", async () => {
		// CAS conflicts cannot be fixed by a trailing save: the user must reload/reconcile
		// because the backend rejected the baseline. A queued saveState() should therefore
		// receive the same conflict and must not POST again with the stale base.
		const base = project({ projectId: "123e4567-e89b-12d3-a456-426614174777" });
		const conflict = new api.ApiError("Project changed remotely", {
			status: 409,
			statusText: "Conflict",
			body: { code: "project_save_conflict", error: "Project changed remotely" },
		});
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.loadProject).mockResolvedValue(JSON.parse(JSON.stringify(base)) as ProjectState);
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async () => {
				firstStarted.resolve();
				await firstInFlight.promise;
				throw conflict;
			})
			.mockResolvedValue(undefined);

		projectStore.__setProjectForTesting(base);
		if (projectStore.project) projectStore.project.name = "Local edit before conflict";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		const secondSave = projectStore.saveState();
		const firstResult = expect(firstSave).rejects.toThrow("Project changed remotely");
		const secondResult = expect(secondSave).rejects.toThrow("Project changed remotely");

		firstInFlight.resolve();
		await firstResult;
		await secondResult;

		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
	});

	it("edit-during-first-POST → the follow-up saves with the COMMITTED base (the first POST's payload hash), no false conflict", async () => {
		// FINDING 2 (round 2): completeSave() must refresh projectBaseFingerprint from the
		// EXACT state the first POST committed — not from the now-edited live project. If it
		// used the live (mid-flight-edited) project, the follow-up's baseline would be a hash
		// the server never stored, and assertNoStaleRemoteOverwrite() would raise a FALSE
		// ProjectSaveConflictError (remote≠baseline AND remote≠local), dropping the edit.
		const baselines: Array<string | null | undefined> = [];
		let firstPostPayloadHash: string | null = null;
		let committedServerState: ProjectState | null = null;
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject)
			.mockImplementationOnce(async (_id, posted, opts) => {
				baselines.push(opts?.baseFingerprint);
				// Snapshot the EXACT payload the first POST sent (the pre-edit state the
				// server actually stores) and its hash. The server now returns THIS from
				// loadProject — the older committed state, NOT the edited live project.
				committedServerState = JSON.parse(JSON.stringify(posted)) as ProjectState;
				firstPostPayloadHash = createProjectStateFingerprint(posted);
				firstStarted.resolve();
				await firstInFlight.promise;
			})
			.mockImplementationOnce(async (_id, _posted, opts) => {
				baselines.push(opts?.baseFingerprint);
			});
		// Model the server: after the first POST commits, loadProject returns the state the
		// first POST stored (the pre-edit payload) — so the follow-up's stale-overwrite check
		// compares the committed baseline against the committed remote (they MUST match if
		// completeSave refreshed the baseline from the committed snapshot, not the live edit).
		vi.mocked(api.loadProject).mockImplementation(async () =>
			(committedServerState
				? JSON.parse(JSON.stringify(committedServerState))
				: JSON.parse(JSON.stringify(projectStore.project))) as ProjectState,
		);

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		expect(firstPostPayloadHash).not.toBeNull();

		// A new edit arrives mid-POST: mutate content (name participates in the fingerprint)
		// so the live state diverges from what the first POST committed, then bump dirtiness.
		if (projectStore.project) projectStore.project.name = "Edited mid-save";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		const editedStateHash = createProjectStateFingerprint(
			JSON.parse(JSON.stringify(projectStore.project)) as ProjectState,
		);
		const secondSave = projectStore.saveState();

		firstInFlight.resolve();
		await Promise.all([firstSave, secondSave]);

		// The follow-up succeeded (no false conflict): two POSTs, status clean.
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).not.toBe("conflict");

		// The follow-up POST carried the baseline the server ACTUALLY committed — the FIRST
		// POST's payload hash — NOT the mid-flight-edited state's hash.
		expect(baselines).toHaveLength(2);
		expect(baselines[1]).toBe(firstPostPayloadHash);
		expect(baselines[1]).not.toBe(editedStateHash);
	});

	// Shared loader-stub helper: openProject runs ~11 secondary load steps (versions,
	// workflow, comments, …). Stub them all to no-op so openProject completes in the test
	// harness without each backing API being mocked individually. Returns the spies so the
	// caller can restore (or override a specific one to model a mid-load failure).
	function stubOpenProjectLoaders() {
		const loaders = [
			"loadVersions", "loadWorkflow", "loadComments", "loadAiReviewMarkers",
			"loadReviewDecisions", "loadReviewAssignments", "loadRevisions",
			"loadWorkspaceHub", "loadCurrentWorkspaceMember", "loadRecentProjects",
			"loadImageAssets",
		] as const;
		const spies = new Map<string, ReturnType<typeof vi.spyOn>>();
		for (const name of loaders) {
			spies.set(
				name,
				vi.spyOn(
					projectStore as unknown as Record<string, () => Promise<void>>,
					name,
				).mockResolvedValue(undefined),
			);
		}
		return {
			restore: () => spies.forEach((spy) => spy.mockRestore()),
		};
	}

	it("a stale in-flight save's committed snapshot is NOT adopted over a fresh same-id reload baseline", async () => {
		// P1 (round 3) — happy path. If the SAME project is reloaded WHILE a save POST is
		// in flight, the reload must end with the baseline tracking the RELOADED state, and
		// a subsequent save must carry the reloaded fingerprint — so it cannot silently
		// overwrite the freshly-committed server state. openProject drains the in-flight
		// save (so its completeSave runs with the generation already bumped → the guard
		// skips adopting the stale committed snapshot), THEN re-seeds from the reload.
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			firstStarted.resolve();
			await firstInFlight.promise;
		});

		projectStore.__setProjectForTesting(project({ sourceLang: "ja" }));
		const staleLocalFingerprint = createProjectStateFingerprint(
			JSON.parse(JSON.stringify(projectStore.project)) as ProjectState,
		);
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave(); // drive saveState directly; isolate from the debounce.

		// POST 1 begins and stays in flight (captures its committed snapshot + the open
		// generation/project reference it was issued against).
		const firstSave = projectStore.saveState();
		await firstStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		// The server now holds a DIFFERENT, freshly-edited state (e.g. another tab saved):
		// loadProject returns that, so the reload seeds a baseline distinct from the local
		// pre-reload state. sourceLang set so applySourceLangDefault() is a no-op.
		const reloadedRemote = project({ name: "Reloaded fresh from server", sourceLang: "ja" });
		const reloadedFingerprint = createProjectStateFingerprint(reloadedRemote);
		vi.mocked(api.loadProject).mockResolvedValue(
			JSON.parse(JSON.stringify(reloadedRemote)) as ProjectState,
		);
		const loaders = stubOpenProjectLoaders();

		// Reload the SAME project while POST 1 is still in flight. The drain layer makes
		// openProject await the in-flight save first, THEN re-seed from the reloaded state.
		const reopen = projectStore.openProject(BACKEND_PROJECT_ID);
		await Promise.resolve();

		firstInFlight.resolve();
		await firstSave;
		const reopened = await reopen;

		expect(reopened).toBe(true);
		// Baseline tracks the RELOADED remote state — NOT the stale pre-reload local state.
		expect(projectStore.__getBaseFingerprintForTesting()).toBe(reloadedFingerprint);
		expect(projectStore.__getBaseFingerprintForTesting()).not.toBe(staleLocalFingerprint);
		expect(projectStore.project?.name).toBe("Reloaded fresh from server");

		// The next save carries the RELOADED fingerprint as its CAS baseline → it can't
		// silently overwrite the freshly-committed server state.
		let nextSaveBaseline: string | null | undefined;
		vi.mocked(api.saveProject).mockImplementationOnce(async (_id, _posted, opts) => {
			nextSaveBaseline = opts?.baseFingerprint;
		});
		if (projectStore.project) projectStore.project.name = "Local edit after reload";
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();
		await projectStore.saveState();
		expect(nextSaveBaseline).toBe(reloadedFingerprint);
		expect(nextSaveBaseline).not.toBe(staleLocalFingerprint);

		loaders.restore();
	});

	it("generation guard: a save issued against the OLD project that completes AFTER the reload re-seeded does NOT clobber the fresh baseline", async () => {
		// P1 (round 3) — the GUARD in isolation, exercising the case the drain alone does
		// NOT cover: a save that begins DURING openProject's load (e.g. an autosave timer
		// fires while loadProject is awaited). That save is NOT in flight at openProject
		// entry, so the drain doesn't catch it; it captures the OLD project reference, then
		// the reload reassigns this.project to the RELOADED object and re-seeds the
		// baseline. When the stale save finally completes — AFTER the re-seed — its
		// completeSave sees postProject !== this.project (reference moved) and MUST skip
		// adopting its OLD committed snapshot. Without the guard it would clobber the fresh
		// reloaded baseline with the OLD state, and the next edit would overwrite the
		// just-reloaded server state with no conflict.
		const reloadedRemote = project({ name: "Reloaded fresh from server", sourceLang: "ja" });
		const reloadedFingerprint = createProjectStateFingerprint(reloadedRemote);

		const staleSaveStarted = deferred();
		const staleSaveInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			staleSaveStarted.resolve();
			await staleSaveInFlight.promise; // POST hangs until we release it post-reseed.
		});

		projectStore.__setProjectForTesting(project({ name: "OLD local state", sourceLang: "ja" }));
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		// openProject's remote load: when invoked, this.project is STILL the OLD object.
		// Simulate a concurrent autosave firing right then — it issues a save against the
		// OLD project reference. Then resolve the reload with the fresh server state.
		let staleSave: Promise<void> | null = null;
		vi.mocked(api.loadProject).mockImplementationOnce(async () => {
			staleSave = projectStore.saveState(); // begins against the OLD this.project.
			await staleSaveStarted.promise; // ensure its POST captured the OLD reference.
			return JSON.parse(JSON.stringify(reloadedRemote)) as ProjectState;
		});
		const loaders = stubOpenProjectLoaders();

		// Reopen the SAME project (no save in flight at entry → no drain; the save begins
		// mid-load instead). openProject reassigns this.project = RELOADED and re-seeds.
		const reopened = await projectStore.openProject(BACKEND_PROJECT_ID);

		expect(reopened).toBe(true);
		// The reload re-seeded the baseline to the RELOADED state.
		expect(projectStore.__getBaseFingerprintForTesting()).toBe(reloadedFingerprint);

		// NOW release the stale save's POST. Its completeSave() runs AFTER the re-seed,
		// with postProject pointing at the OLD object ≠ this.project (RELOADED) → the guard
		// must skip adopting the OLD committed snapshot.
		staleSaveInFlight.resolve();
		await staleSave;

		// Baseline UNCHANGED — still the reloaded fingerprint, NOT clobbered by the OLD
		// state's committed snapshot. (Without the guard it would revert to the OLD state.)
		expect(projectStore.__getBaseFingerprintForTesting()).toBe(reloadedFingerprint);

		loaders.restore();
	});

	it("normal-completion adoption still works (no reload): the committed snapshot seeds the baseline", async () => {
		// The generation/reference guard must NOT block the normal path: with no reload,
		// the in-flight POST's generation/reference still match at completion, so its
		// committed snapshot is adopted as the baseline exactly as before.
		const firstStarted = deferred();
		const firstInFlight = deferred();
		let committedHash: string | null = null;
		vi.mocked(api.saveProject).mockImplementationOnce(async (_id, posted) => {
			committedHash = createProjectStateFingerprint(posted);
			firstStarted.resolve();
			await firstInFlight.promise;
		});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const save = projectStore.saveState();
		await firstStarted.promise;
		firstInFlight.resolve();
		await save;

		// No reload happened → the committed snapshot was adopted: baseline == committed hash.
		expect(committedHash).not.toBeNull();
		expect(projectStore.__getBaseFingerprintForTesting()).toBe(committedHash);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("same-id reopen WAITS for an in-flight save before loading remote state (drain ordering)", async () => {
		// The drain seam: openProject on a SAME-ID reload must await the in-flight save
		// gate BEFORE it calls loadProject — so a reload can never interleave with a save
		// POST. Assert ordering: saveProject (POST) settles before loadProject is invoked.
		const order: string[] = [];
		const firstStarted = deferred();
		const firstInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			firstStarted.resolve();
			await firstInFlight.promise;
			order.push("saveProject:settled");
		});
		vi.mocked(api.loadProject).mockImplementation(async () => {
			order.push("loadProject");
			return JSON.parse(JSON.stringify(projectStore.project)) as ProjectState;
		});
		const loaders = [
			"loadVersions", "loadWorkflow", "loadComments", "loadAiReviewMarkers",
			"loadReviewDecisions", "loadReviewAssignments", "loadRevisions",
			"loadWorkspaceHub", "loadCurrentWorkspaceMember", "loadRecentProjects",
			"loadImageAssets",
		] as const;
		const loaderSpies = loaders.map((name) =>
			vi.spyOn(
				projectStore as unknown as Record<string, () => Promise<void>>,
				name,
			).mockResolvedValue(undefined),
		);

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		projectStore.cancelAutosave();

		const save = projectStore.saveState();
		await firstStarted.promise;
		// The save's own assertNoStaleRemoteOverwrite() already called loadProject before
		// the POST; clear the log so we track ONLY openProject's reload from here.
		order.length = 0;

		// Reopen the SAME project while the save is in flight — it must NOT load yet.
		const reopen = projectStore.openProject(BACKEND_PROJECT_ID);
		await Promise.resolve();
		await Promise.resolve();
		expect(order).not.toContain("loadProject"); // blocked behind the in-flight save.

		firstInFlight.resolve();
		await Promise.all([save, reopen]);

		// loadProject ran only AFTER the save POST settled.
		expect(order.indexOf("saveProject:settled")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("loadProject")).toBeGreaterThan(order.indexOf("saveProject:settled"));

		loaderSpies.forEach((spy) => spy.mockRestore());
	});

	it("saveNamedVersion awaits a pending autosave before snapshotting (no concurrent save race)", async () => {
		// Gate saveProject so the autosave promise stays in flight. saveNamedVersion
		// must await it (via waitForAutosaveInFlight) rather than firing a second,
		// concurrent saveState — the 409-conflict race Codex flagged.
		const autosaveStarted = deferred();
		const autosaveInFlight = deferred();
		vi.mocked(api.saveProject).mockImplementationOnce(async () => {
			autosaveStarted.resolve();
			await autosaveInFlight.promise;
		});

		projectStore.__setProjectForTesting(project());
		projectStore.markCurrentPageUnsaved();
		// Fire the debounce so the (gated) autosave is in flight.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await autosaveStarted.promise;
		expect(api.saveProject).toHaveBeenCalledTimes(1);

		const versionPromise = projectStore.saveNamedVersion("Before QC");
		// Snapshot must wait for the in-flight autosave to settle first.
		await Promise.resolve();
		expect(api.createNamedProjectVersion).not.toHaveBeenCalled();

		autosaveInFlight.resolve();
		const created = await versionPromise;

		// Snapshot only ran after the gated autosave settled (no concurrent save while
		// it was in flight), and recorded the requested label.
		expect(api.createNamedProjectVersion).toHaveBeenCalledTimes(1);
		expect(api.createNamedProjectVersion).toHaveBeenCalledWith(BACKEND_PROJECT_ID, "Before QC");
		expect(created?.label).toBe("Before QC");
	});
});

describe("committed-baseline adoption when a same-id reload FAILS", () => {
	it("adopts the committed snapshot when the reload bumped the generation but never replaced the project", async () => {
		// codex P2 round 4: a same-id reopen bumps projectOpenGeneration BEFORE its
		// reload succeeds. If the reload then FAILS, this.project is unchanged — the
		// in-flight save's committed snapshot is still the correct baseline. A
		// generation-based staleness test wrongly skipped adoption here, leaving
		// base=pre-save while remote=just-saved → false conflict on the next edit.
		const projectId = "123e4567-e89b-12d3-a456-426614174890";
		const base = project({ projectId });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "edit that will be committed";

		const gate = deferred<void>();
		vi.mocked(api.saveProject).mockImplementation(async () => {
			await gate.promise;
		});
		const savePromise = projectStore.saveState();
		// Simulate the failed same-id reopen mid-save: generation bumped, reload threw,
		// this.project untouched.
		(projectStore as unknown as { projectOpenGeneration: number }).projectOpenGeneration += 1;
		gate.resolve();
		await savePromise;

		// The committed snapshot WAS adopted: the baseline matches the posted state.
		const fingerprint = (projectStore as unknown as { __getBaseFingerprintForTesting: () => string | null }).__getBaseFingerprintForTesting();
		expect(fingerprint).not.toBeNull();
		// And a follow-up save does not self-conflict.
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		projectStore.project!.name = "next edit";
		await projectStore.saveState();
		expect(projectStore.saveErrorKind).toBeNull();
	});
});
