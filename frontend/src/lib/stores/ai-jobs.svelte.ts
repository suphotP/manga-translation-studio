// AI Jobs store — AI cover generation, batch queue management, concurrent job tracking
// Svelte 5 class-based store with queue UI support

import * as api from "$lib/api/client.ts";
import { config } from "$lib/config.js";
import {
	formatAiCancelBackendFailed,
	formatAiCancelledStatus,
	formatAiCoverSelectionRequired,
	formatAiJobProviderFailure,
	formatAiJobStartFailure,
	formatAiProviderStartFailure,
	formatAiMarkerCreatePending,
	formatAiMarkerRerunNoProject,
	formatAiMarkerRerunPageMissing,
	formatAiMarkerRerunQueued,
	formatAiMarkerRerunRegionTooSmall,
	formatAiMarkerRerunStaleImage,
	formatAiMarkerRerunWrongPage,
	formatAiMissingResultFailure,
	formatAiNeedsReviewStatus,
	formatAiStatusFailed,
	formatAiStatusRetry,
	formatAiStatusRetryDetail,
} from "$lib/project/ai-job-copy.js";
import type { AiCostEstimate, AiReviewMarker, AiTier, CreditReservation } from "$lib/types.js";
import { DEFAULT_AI_QUALITY, type AiImageQuality } from "$lib/project/ai-quality.js";
import { projectStore } from "./project.svelte.ts";

type JobStatus = "pending" | "processing" | "done" | "error" | "cancelled" | "needs_review";
type ProgressStage = "uploading" | "processing" | "downloading" | "complete" | "failed" | "cancelled";
type MarkerTerminalUpdate = Parameters<typeof projectStore.updateAiReviewMarker>[1];

// A live poll interval bound to the projectId it started under. The poll-context
// guard (see isPollContextCurrent) re-checks this on every tick and on resolution
// so a poll that resolves AFTER a switch to a DIFFERENT project never writes into
// whatever project is open now. (Keyed on projectId, not the open generation, so a
// reopen of the SAME project keeps its in-flight polls valid.)
//
// `generation` additionally pins the poll to the teardown generation (sign-out
// counter) it was armed under. The projectId match alone cannot cancel an ALREADY-
// AWAITING getAiStatus callback: on sign-out + reopen of the SAME project id, the
// stale callback's post-await writes would still pass the projectId check. Each tick
// AND every post-await continuation also requires teardownGeneration === generation,
// so a callback in flight when cleanup() bumped the generation discards with no write.
// resumePolling re-arms with the CURRENT generation (fresh handles); cancelPollsForProject
// does NOT bump the generation (a per-project switch must not neutralize other sessions).
//
// `suspendGeneration` is the route-away analogue (suspendPolling counter). A plain
// route-away (WorkspaceShell.onDestroy → suspendPolling) clears the live intervals and
// keeps the queue, but it does NOT bump the projectId OR the teardown generation — so a
// poll callback ALREADY awaiting getAiStatus when the route-away fires would pass both of
// those guards on resolution and then touch the now-DISPOSED Fabric editor in its terminal
// branch. suspendPolling bumps suspendGeneration; the handle captures it at arm time;
// isPollContextCurrent additionally requires handle.suspendGeneration === this.suspend-
// Generation, so any callback armed before a suspend is dead after it. resumePolling does
// NOT bump it (fresh re-armed handles capture the current value and pass), and cleanup()
// may leave it (teardownGeneration already neutralizes a sign-out's in-flight callbacks).
interface PollHandle {
	interval: ReturnType<typeof setInterval>;
	projectId: string;
	// The teardown generation captured when this poll was armed (= this.teardownGeneration
	// at poll start). isPollContextCurrent re-checks it so a sign-out (cleanup bumps the
	// generation) neutralizes an already-awaiting callback even on a same-id reopen.
	generation: number;
	// The suspend generation captured when this poll was armed (= this.suspendGeneration at
	// poll start). isPollContextCurrent re-checks it so a route-away (suspendPolling bumps
	// it) neutralizes an already-awaiting getAiStatus callback before it can touch the
	// disposed editor — neither projectId nor teardownGeneration changes on a route-away.
	suspendGeneration: number;
	// The editor this poll was armed with, so cancelPollsForProject can hide the row's
	// CANVAS indicator on the SAME editor it was drawn on when the project is switched
	// away. A switch reuses the editor instance (only destroy() tears it down), and the
	// indicator's RAF is cleared only by hideProcessingIndicator(), so the handle keeps
	// this reference for that best-effort cleanup. Rows suspended before the switch have
	// no handle and fall back to the store's lastKnownEditor.
	editor?: any;
}

// A deferred terminal marker update, kept until the marker id is known. Bound to
// the project that queued it so a deferred update for project A's job can never
// be flushed into project B after a switch.
interface DeferredMarkerUpdate {
	input: MarkerTerminalUpdate;
	projectId: string;
}

const SFX_PRO_CONCURRENT_JOB_LIMIT = 2;

export interface BatchJob {
	id: string;
	projectId: string;
	imageId: string;
	crop: { x: number; y: number; w: number; h: number };
	lang: string;
	prompt: string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	thumbnail: string;
	status: JobStatus;
	stage: ProgressStage;
	progress: number;
	error?: string;
	resultImageId?: string;
	tier: AiTier;
	quality?: AiImageQuality;
	remoteJobId?: string;
	indicatorId?: string;
	markerId?: string;
	sourceMarkerId?: string;
	// When set, the source marker is retried with this reviewer-edited prompt
	// through the /retry endpoint instead of replaying the original prompt.
	promptOverride?: string;
	pageIndex?: number;
	idempotencyKey?: string;
	linkedCommentIds?: string[];
	linkedTaskIds?: string[];
	costEstimate?: AiCostEstimate;
	creditReservation?: CreditReservation;
	createdAt: number;
	// Slot-accounting flag. TRUE iff this row currently holds one of the
	// `maxConcurrent` batch concurrency slots — i.e. startBatchJob incremented
	// processingCount for it and no terminal/discard/cancel has released it yet.
	// Single-generate rows (generateCover) NEVER take a slot, so they stay false.
	// Every decrement path (pollBatchJob terminals, discardSwitchedAwayJob,
	// cancelJob, cancelPollsForProject's reconciliation) consults this flag and
	// flips it to false on release, so the invariant
	//   processingCount === (# of queue rows with holdsBatchSlot === true)
	// holds regardless of suspend/resume, switch, or which poll variant re-armed
	// the row. resumePolling re-arms single-gen rows through the SAME pollBatchJob
	// helper, but the flag (false for them) keeps that helper's terminal decrement
	// from driving the count negative.
	holdsBatchSlot?: boolean;
}

class AiJobsStore {
	aiTier = $state<AiTier>("sfx-pro");
	// Chosen AI image quality (ต่ำ/กลาง/สูง). Drives the per-op CREDIT cost and is
	// sent to the backend, which charges QUALITY_CREDIT_UNITS[quality]. Plan
	// gating (allowedAiQualities) is enforced in the panel + by the backend.
	aiQuality = $state<AiImageQuality>(DEFAULT_AI_QUALITY);
	sfxToggle = $state(true);
	isGenerating = $state(false);
	// Human-readable AI activity string surfaced in the status bar. Empty when
	// idle (falsy), so the status bar falls back to the editor status text.
	aiStatus = $state("");
	queue = $state<BatchJob[]>([]);
	maxConcurrent = SFX_PRO_CONCURRENT_JOB_LIMIT;

	private pendingJobs = new Map<string, PollHandle>();
	private pendingMarkerUpdates = new Map<string, DeferredMarkerUpdate>();
	// Last editor handed to a poll/indicator entry point, kept so cancelPollsForProject
	// can best-effort hide the CANVAS indicators of the rows it drops on a project
	// switch. PollHandle does NOT capture the editor, and a switch REUSES the same editor
	// instance (only destroy() tears it down), so without this the dropped rows' indicator
	// RAF animations and canvas rects would survive on the now-open project's canvas — only
	// hideProcessingIndicator()/destroy() ever clear them. Updated by rememberEditor() at
	// every entry that receives a live editor; cleared on cleanup() (sign-out disposes the
	// editor via its own destroy(), so the stale reference must not linger).
	private lastKnownEditor: any = null;
	private processingCount = $state(0);
	private maxPollFailures = 3;
	// Per-region in-flight guard for single-generate. A single-gen submit is held
	// here from the moment it starts until the backend `submitAiJob` call settles
	// (resolve OR reject). A second single-gen for the SAME region (same project +
	// image + rounded crop) while one is still pending is dropped, so a rapid
	// double-click cannot fire two backend submits → no double job / double charge.
	// This replaces the old FE-derived Idempotency-Key (which could not know the
	// backend's server-resolved BYO/platform routing and so could reuse the wrong
	// job): single-gen now sends NO explicit key and lets the backend derive its
	// authoritative default key (lang/tier/quality/prompt/BYO all captured server-side).
	private inFlightSingleGen = new Set<string>();

	// True between a WorkspaceShell unmount (route-away to /settings, /login, etc.)
	// and the next shell mount. While suspended, the SHELL is gone (editor disposed),
	// so we must NOT run poll intervals — a tick's captured `editor` closure would
	// throw inside the disposed Fabric canvas (the zombie-polling hazard). suspendPolling
	// clears every live interval and sets this; a submit/retry continuation that resolves
	// while suspended still writes its SERVER marker (via ownerProjectId) and leaves its
	// row in `processing`, but the poll-starters below see this flag and start NO interval.
	// resumePolling (next shell mount) clears it and re-arms a poll for every still-
	// processing/pending row of the CURRENTLY OPEN project. Unlike cleanup() this does NOT
	// bump teardownGeneration, clear the queue, or block continuations — a route-away is a
	// transient UI teardown, not the end of the session, so an accepted+charged in-flight
	// job must keep its server marker and be re-pollable on return.
	private pollingSuspended = false;

	// Monotonic route-away counter. suspendPolling() (WorkspaceShell.onDestroy, a plain
	// route-away that DISPOSES the editor while keeping the queue) bumps it. Every PollHandle
	// captures it at arm time and isPollContextCurrent re-checks it, so a poll callback
	// ALREADY awaiting getAiStatus when the route-away fires is neutralized on resolution —
	// it would otherwise pass the projectId AND teardownGeneration guards (a route-away bumps
	// NEITHER) and then touch the disposed Fabric editor in its terminal branch. resumePolling
	// does NOT bump this (re-armed handles capture the current value and pass); cleanup() may
	// leave it as-is (teardownGeneration already neutralizes a sign-out's in-flight callbacks).
	private suspendGeneration = 0;

	// Monotonic full-teardown counter. cleanup() (sign-out / shell unmount) bumps it;
	// every submit/retry entry point captures it BEFORE its first await and every
	// post-await guard checks it is UNCHANGED in addition to the projectId match. This
	// closes the gap that the projectId guard alone cannot: a submit still awaiting
	// api.submitAiJob when cleanup() runs has no PollHandle to cancel yet, so if the
	// user signs out and back into the SAME project id, isProjectContextCurrent would
	// pass and the continuation would resurrect a poll/marker on the disposed session.
	// A generation mismatch makes that continuation a no-op. cancelPollsForProject does
	// NOT bump this — a per-project switch must not neutralize OTHER projects' submits.
	private teardownGeneration = 0;

	// Guards the one-time, app-lifetime sign-out hook registration (see
	// registerSignOutCleanup). It is registered against authStore — NOT the shell —
	// so signing out from ANY route (e.g. /settings, where WorkspaceShell is
	// unmounted) still wipes this session's queue/prompts/thumbnails before the next
	// user signs in. Tracked here so a double call is a no-op.
	private signOutCleanupRegistered = false;

	constructor() {
		// aiJobsStore is an app-lifetime singleton, so this hook is never removed.
		// On a real project switch, tear down the OUTGOING project's zombie poll
		// intervals (they'd otherwise keep hitting the protected status endpoint and,
		// via the stale `editor` closure, animate/clear indicators on the wrong
		// canvas). projectStore only fires this when the projectId actually CHANGES,
		// so reopening the SAME project mid-session never kills its fresh polls.
		//
		// The SIGN-OUT teardown is registered SEPARATELY, lazily, via
		// registerSignOutCleanup() — NOT here in the constructor and NOT via a static
		// `import { authStore }`. auth.svelte.ts runs `api.setAuthRefreshHandler(...)`
		// at module load; a static import would pull that side effect into this store's
		// import graph, and the store-level tests mock `$lib/api/client.ts` WITHOUT
		// setAuthRefreshHandler, so merely loading ai-jobs.svelte.ts would throw. A lazy
		// dynamic import inside registerSignOutCleanup keeps auth out of the static graph,
		// so the tests stay clean while the hook is still permanent in the real app
		// (the root +layout calls registerSignOutCleanup() on mount — see app bootstrap).
		projectStore.registerOnProjectSwitch((previousProjectId) => {
			this.cancelPollsForProject(previousProjectId);
		});

		// Create-flow rollback re-arm. The brand-new-project create flow ASSIGNS the new
		// project (fireHooks deferred) so its steps build against the new id, but the
		// previous project's poll ticks keep running during that window — each one fails
		// isProjectContextCurrent and SELF-CLEARS its interval. If a later create step
		// throws, projectStore rolls back to the previous project; its still-running rows
		// are then intact but UNPOLLED. This hook re-arms them via the same resumePolling
		// machinery the shell-remount path uses (re-arms every still-processing/pending row
		// of the now-restored open project; safe + idempotent when there is nothing to do).
		projectStore.registerOnResumePolling((editor) => {
			this.resumePolling(editor);
		});

		// Create-flow rollback row restore. The brand-new-project create flow ASSIGNS the
		// new id before its steps run; while assigned, a previous-project submit continuation
		// that resolves sees "switched away" (isSubmitContextCurrent false on the new id) and
		// DISCARDS its queue row — even though the job was accepted+charged (its server marker
		// was written via ownerProjectId). If the create then FAILS and rolls back, resumePolling
		// can only re-arm rows that still EXIST, so that discarded row would be orphaned/invisible.
		// projectStore snapshots the previous project's rows BEFORE the flip (snapshotRowsForProject)
		// and, on the rollback path, hands them back (restoreMissingRows) BEFORE runResumePolling so
		// the re-inserted row is re-armed alongside the survivors. snapshot returns opaque rows to
		// keep the project store decoupled from BatchJob.
		projectStore.registerOnSnapshotRows((previousProjectId) => {
			return this.snapshotRowsForProject(previousProjectId);
		});
		projectStore.registerOnRestoreRows((rows) => {
			this.restoreMissingRows(rows as BatchJob[]);
		});
	}

	// Deep-ish copy of the given project's current queue rows, returned to the project
	// store as an opaque snapshot before a create flow flips the open project. Each row is
	// shallow-cloned with its nested `crop` copied too, so a later mutation of the live
	// queue (or a discard that drops the row) cannot alter the snapshot. Used by the
	// create-flow rollback to restore any row discarded during the (deferred-hook) create
	// window. Returns only rows belonging to `projectId`.
	snapshotRowsForProject(projectId: string): BatchJob[] {
		// A new create window starts: stale discard stashes from any previous window
		// must not leak into this one's restoration.
		this.lastDiscardedRows.clear();
		return this.queue
			.filter(job => job.projectId === projectId)
			.map(job => ({ ...job, crop: { ...job.crop } }));
	}

	// Re-insert any snapshotted row whose id is no longer present in the live queue (it
	// was discarded during the create window — e.g. a submit continuation that saw
	// "switched away" and dropped it). Rows re-enter in their snapshotted state. This does
	// NOT re-arm poll intervals — the create-flow rollback calls runResumePolling right
	// after, which re-arms the restored row alongside the surviving ones. Rows still
	// present are left untouched (idempotent), so a partial discard restores only the gap.
	//
	// Slot accounting: the snapshot was taken BEFORE the discard, so a restored BATCH row
	// still carries holdsBatchSlot === true, but its discard already ran releaseBatchSlot
	// (processingCount--). Re-bump processingCount for each restored slot-holding row so the
	// invariant processingCount === (# rows with holdsBatchSlot === true) is restored with
	// the row. Single-gen rows never held a slot (holdsBatchSlot falsy → no adjustment).
	restoreMissingRows(rows: BatchJob[]): void {
		const presentIds = new Set(this.queue.map(job => job.id));
		// Prefer the DISCARD-TIME copy over the pre-flip snapshot: a submit that
		// resolved during the create window stamped remoteJobId onto the live row
		// just before discarding it — restoring the snapshot version would re-insert
		// an unpollable row (resumePolling skips rows with no remoteJobId) whose
		// restored slot then wedges processingCount (codex P2 round 14).
		const missing = rows
			.filter(row => !presentIds.has(row.id))
			.map(row => this.lastDiscardedRows.get(row.id) ?? row);
		if (missing.length === 0) return;
		const slotsToRestore = missing.filter(row => row.holdsBatchSlot === true).length;
		this.queue = [...this.queue, ...missing.map(row => ({ ...row, crop: { ...row.crop } }))];
		this.processingCount += slotsToRestore;
		for (const row of missing) this.lastDiscardedRows.delete(row.id);
	}

	// App-lifetime sign-out wipe registration, decoupled from the WorkspaceShell
	// lifecycle so it survives route-aways. The PREVIOUS design registered the
	// pre-sign-out hook in WorkspaceShell.onMount and UNREGISTERED it in onDestroy;
	// routing to /settings (shell unmounts) removed the hook, so signing out THERE
	// never ran aiJobsStore.cleanup() and the next signed-in user inherited the
	// previous user's queue rows/prompts/thumbnails — a privacy leak through a
	// different door.
	//
	// Called once from the root +layout's onMount (which ALWAYS runs, on every route,
	// for the whole app session). The dynamic import keeps authStore — and its
	// `api.setAuthRefreshHandler` module side effect — out of this store's STATIC
	// import graph, so the store-level vitest mocks (which don't stub
	// setAuthRefreshHandler) never load it. Idempotent: a second call is a no-op.
	async registerSignOutCleanup(): Promise<void> {
		if (this.signOutCleanupRegistered) return;
		this.signOutCleanupRegistered = true;
		const { authStore } = await import("./auth.svelte.ts");
		// Never unregistered: the wipe must outlive every shell mount/unmount so a
		// sign-out from any route always clears this session's AI queue.
		authStore.registerPreSignOut(() => {
			this.cleanup();
		});
	}

	// True when this poll's captured projectId still matches the active open project
	// AND — for a live PollHandle — no full teardown (sign-out) has bumped the
	// teardown generation since the poll was armed. Re-checked on every tick and on
	// resolution so a poll that outlives its project (switch to a DIFFERENT project /
	// close) OR its session (sign-out, even with a same-id reopen) is discarded WITHOUT
	// any client-side write into whatever project is open now. The projectId match
	// alone cannot neutralize an ALREADY-AWAITING getAiStatus callback on sign-out +
	// same-id reopen — the generation pin closes that gap. The backend still owns
	// persisting the job's result server-side regardless; this only gates the CLIENT
	// mirror (queue/status/marker/indicator). A DeferredMarkerUpdate carries no
	// generation (cleanup() clears pendingMarkerUpdates outright), so it is gated on
	// projectId only.
	private isPollContextCurrent(handle: PollHandle | DeferredMarkerUpdate | undefined): boolean {
		if (!handle) return false;
		if ("generation" in handle && this.teardownGeneration !== handle.generation) return false;
		// Route-away guard: a poll callback already AWAITING getAiStatus when suspendPolling()
		// fired must NOT touch the disposed editor on resolution. A route-away bumps neither
		// the projectId nor the teardown generation, so without this the terminal branch would
		// run. A handle armed before the suspend has a stale suspendGeneration → discarded;
		// resumePolling re-arms fresh handles with the current value, which pass.
		if ("suspendGeneration" in handle && this.suspendGeneration !== handle.suspendGeneration) return false;
		return projectStore.isProjectContextCurrent(handle.projectId);
	}

	// True when BOTH the owning project is still open AND no full teardown (cleanup)
	// has happened since the entry point captured `generation`. Submit/retry
	// continuations gate their CLIENT mirror (poll start / marker create / queue write)
	// on this so a continuation that resolves after a sign-out is a no-op even if the
	// user signed back into the SAME project id (projectId match alone would pass).
	private isSubmitContextCurrent(ownerProjectId: string, generation: number): boolean {
		return this.teardownGeneration === generation
			&& projectStore.isProjectContextCurrent(ownerProjectId);
	}

	// True when the queue still holds a row with this local id. The id-only
	// isSubmitContextCurrent is NOT enough for a ROW-DEPENDENT continuation: in the
	// A → B → A sequence (switch away from A to B — cancelPollsForProject DROPS A's rows —
	// then reopen A while a save/submit/marker await is in flight) isSubmitContextCurrent
	// returns true again (same project id, same generation), yet the continuation's local
	// row/temp-row/marker mirror was already removed when B was opened. Without this check
	// the continuation would submit/poll a job whose local row is gone — charged work with
	// no visible row, and a deferred marker update wedged with no row to attach to. Every
	// row-dependent continuation pairs this with isSubmitContextCurrent (see
	// isSubmitRowCurrent) so the row is required to STILL EXIST, not merely the project.
	private rowStillPresent(localId: string): boolean {
		return this.queue.some(j => j.id === localId);
	}

	// Combined gate for a ROW-DEPENDENT submit continuation: the owning project is still
	// open AND no teardown happened AND the continuation's queue row STILL EXISTS. Used at
	// call sites that operate on a specific queue row (temp single-gen row / batch row) so
	// the A → B → A id-reuse case (project current again but the row was dropped when B was
	// opened) is treated as "context lost" for LOCAL work. Callers decide the post-bail
	// behaviour by phase: a PRE-submit gate does not submit (no charge); a POST-submit
	// continuation still writes the server marker (charged job must stay recoverable —
	// reopening the owner reloads markers) but skips all local row/status/poll work.
	private isSubmitRowCurrent(localId: string, ownerProjectId: string, generation: number): boolean {
		return this.isSubmitContextCurrent(ownerProjectId, generation)
			&& this.rowStillPresent(localId);
	}

	// Clear every live poll interval that belongs to the given project (used by the
	// project-switch hook with the OUTGOING projectId, so the project being left has
	// its zombie timers stopped immediately). The generation guard already blocks
	// any stale CLIENT write; this stops the polling itself. Deferred marker updates
	// for the cleared project are dropped too — their UI context is gone and the
	// backend already owns the persisted result. processingCount is reconciled from
	// the ROWS we remove (every removed row that still holds a batch slot frees one),
	// NOT from live poll handles — a route-away (suspendPolling) clears the handles
	// while the rows stay processing, so a handle-based decrement would miss those
	// rows and wedge the count high forever, starving the new project's slots.
	//
	// We also DROP the cleared project's queue rows. The queue is a single global
	// list rendered verbatim (BatchPanel reads activeJobs/completedJobs/queueStats
	// with NO current-project filter), so once we stop a switched-away project's
	// pollers, any of its "processing"/"pending" rows would otherwise sit in
	// activeJobs FOREVER — no poller left to advance them to a terminal status, and
	// clearCompleted only removes done/error/cancelled, so the user can never clear
	// them either. Their terminal rows (done/error/cancelled/needs_review) likewise
	// have no place in the now-open project's queue. These rows are a pure CLIENT
	// mirror; the backend owns each job's persisted result and reopening the project
	// reloads its AI review markers from the server (openProject → loadAiReviewMarkers),
	// so dropping the transient rows here loses nothing recoverable. Sign-out's
	// cleanup() still wipes the whole queue separately; this is the per-switch scope.
	// Record the live editor every time a poll/indicator entry point receives one, so
	// cancelPollsForProject (which gets no editor from the project-switch hook) can hide
	// the dropped rows' canvas indicators. A handle may carry its own editor, but a row
	// suspended before the switch has no handle, so this captured fallback covers it.
	private rememberEditor(editor: any): void {
		if (editor) this.lastKnownEditor = editor;
	}

	// Best-effort hide of a dropped row's canvas indicator. Prefers the poll handle's
	// editor (if a handle survived) and falls back to lastKnownEditor (suspended rows
	// have no handle). The editor may already be disposed (its Fabric canvas torn down),
	// so any throw is swallowed — this is pure cleanup of an orphaned animation.
	private hideIndicatorBestEffort(editor: any, indicatorId: string | undefined): void {
		if (!indicatorId) return;
		try {
			editor?.hideProcessingIndicator?.(indicatorId);
		} catch {
			// Editor disposed mid-switch — nothing to clean up, ignore.
		}
	}

	// Best-effort canvas-indicator stage update. The editor may already be DISPOSED (its
	// Fabric canvas torn down by a route-away that ran AFTER the awaited submit started),
	// so a throw here must never abort the submit continuation — most importantly it must
	// never skip createMarkerForRunningJob, which would leave an accepted+charged job with
	// NO server marker (invisible on reopen). Any throw is swallowed; the marker write and
	// poll re-arm proceed regardless.
	private updateIndicatorBestEffort(editor: any, indicatorId: string, stage: ProgressStage): void {
		try {
			editor?.updateProcessingIndicator?.(indicatorId, stage);
		} catch {
			// Editor disposed mid-route-away — the indicator is gone with its canvas, ignore.
		}
	}

	cancelPollsForProject(projectId: string | null): void {
		if (projectId === null) return;
		// Stop the live timers for this project (if any survived — suspendPolling may
		// have already cleared them while the rows stayed processing). Capture each
		// handle's editor (if any) keyed by local id so we can hide that row's indicator
		// on the SAME editor it was drawn on before we forget the handle.
		const handleEditorByLocalId = new Map<string, any>();
		for (const [localId, handle] of [...this.pendingJobs]) {
			if (handle.projectId === projectId) {
				clearInterval(handle.interval);
				handleEditorByLocalId.set(localId, handle.editor);
				this.pendingJobs.delete(localId);
			}
		}
		for (const [remoteJobId, deferred] of [...this.pendingMarkerUpdates]) {
			if (deferred.projectId === projectId) {
				this.pendingMarkerUpdates.delete(remoteJobId);
			}
		}
		// Before dropping the switched-away project's rows, hide each one's canvas
		// indicator. The switch REUSES the editor (only destroy() tears it down), and the
		// indicator's RAF + canvas rects are cleared ONLY by hideProcessingIndicator(), so
		// without this the orphaned indicator animations would survive on the now-open
		// project's canvas. Prefer the row's own poll-handle editor, fall back to the last
		// editor we saw (suspended rows have no handle); both wrapped so a disposed editor
		// can't throw out of the switch.
		for (const job of this.queue) {
			if (job.projectId !== projectId) continue;
			const editor = handleEditorByLocalId.get(job.id) ?? this.lastKnownEditor;
			this.hideIndicatorBestEffort(editor, job.indicatorId ?? job.id);
		}
		// Reconcile the slot count off the ROWS being dropped, not off live handles:
		// each removed row that still holds a batch slot frees exactly one. This works
		// identically whether or not polling was suspended (handles cleared), closing the
		// wedge where a suspend→switch dropped slot-holding rows with no handle left.
		const freedSlots = this.queue.filter(
			job => job.projectId === projectId && job.holdsBatchSlot === true,
		).length;
		this.processingCount = Math.max(0, this.processingCount - freedSlots);
		this.queue = this.queue.filter(job => job.projectId !== projectId);
	}

	get activeJobs(): BatchJob[] {
		return this.queue.filter(j => j.status === "processing" || j.status === "pending");
	}

	get completedJobs(): BatchJob[] {
		return this.queue.filter(j => j.status === "done" || j.status === "error" || j.status === "cancelled" || j.status === "needs_review");
	}

	get queueStats() {
		return {
			total: this.queue.length,
			pending: this.queue.filter(j => j.status === "pending").length,
			processing: this.queue.filter(j => j.status === "processing").length,
			done: this.queue.filter(j => j.status === "done").length,
			error: this.queue.filter(j => j.status === "error").length,
			cancelled: this.queue.filter(j => j.status === "cancelled").length,
			needsReview: this.queue.filter(j => j.status === "needs_review").length,
		};
	}

	toggleSfx(): void {
		this.sfxToggle = !this.sfxToggle;
	}

	setAiTier(tier: AiTier): void {
		this.aiTier = tier;
	}

	setAiQuality(quality: AiImageQuality): void {
		this.aiQuality = quality;
	}

	setGenerating(value: boolean): void {
		this.isGenerating = value;
	}

	private shouldTranslateSfx(): boolean {
		return this.aiTier === "sfx-pro" && this.sfxToggle;
	}

	// Region identity for the single-generate in-flight guard. ONLY the physical
	// target region (project + image + rounded crop) — NOT lang/tier/prompt/SFX —
	// because the guard's job is purely "is a submit for this region already
	// pending?" double-click protection. Correctness of REUSE (a changed lang/SFX/
	// BYO must make a NEW job) is the backend default key's responsibility, not the
	// guard's. Crop is rounded so sub-pixel noise from a re-drag does not split the
	// region. The guard deliberately does NOT key on prompt/lang so that two rapid
	// clicks on the SAME button (identical request) are collapsed to one submit.
	private singleGenRegionKey(
		projectId: string,
		imageId: string,
		crop: { x: number; y: number; w: number; h: number },
	): string {
		const region = `${Math.round(crop.x)}x${Math.round(crop.y)}x${Math.round(crop.w)}x${Math.round(crop.h)}`;
		return `${projectId}:${imageId}:${region}`;
	}

	async generateCover(
		editor: any,
		customPrompt?: string,
	): Promise<void> {
		const project = projectStore.project;
		if (!editor || !project) return;
		this.rememberEditor(editor);

		// Capture the OWNING project once, before any await. saveState() and the
		// backend submitAiJob round-trip are awaited below; if the user switches to a
		// different project while either is in flight, the continuation (marker create
		// + poll start) must bind to THIS project, not whatever is open when the await
		// resolves. Without this, projectStore.createAiReviewMarker would issue an API
		// write into the wrong project and the poll would start under it.
		const ownerProjectId = project.projectId;
		// Capture the teardown generation alongside the project, before any await. The
		// post-submit guard checks BOTH so a continuation that resolves after a sign-out
		// (cleanup bumped the generation) is dead even on a same-id re-login.
		const submitGeneration = this.teardownGeneration;
		const pageIndex = project.currentPage;
		const page = project.pages[project.currentPage];
		const crop = editor.getCoverCrop();

		if (!crop || crop.w < config.minCropSize || crop.h < config.minCropSize) {
			projectStore.setStatusMsg(formatAiCoverSelectionRequired());
			return;
		}

		// Client-side in-flight guard (double-click protection). If a single-gen for
		// this exact region is already pending, silently drop this one so a rapid
		// double-click cannot fire two backend submits → no double job / double charge.
		// We removed the old FE-derived Idempotency-Key (it could not know the backend's
		// server-resolved BYO/platform routing and so could reuse the WRONG job); the
		// backend now derives its authoritative default key from lang/tier/quality/
		// prompt/BYO, and this guard covers the rapid-double-click window before that
		// first submit even reaches the queue. Set synchronously (before any await) so a
		// second synchronous click sees it.
		const regionKey = this.singleGenRegionKey(project.projectId, page.imageId, crop);
		if (this.inFlightSingleGen.has(regionKey)) return;
		this.inFlightSingleGen.add(regionKey);

		// Create temp job ID and add to queue immediately
		const tempJobId = `temp-${Date.now()}`;
		const tempJob: BatchJob = {
			id: tempJobId,
			projectId: project.projectId,
			imageId: page.imageId,
			crop,
			lang: projectStore.activeTargetLang,
			prompt: "",
			customPrompt,
			thumbnail: this.generateThumbnail(editor, crop),
			status: "pending",
			stage: "uploading",
			progress: 0,
			tier: this.aiTier,
			quality: this.aiQuality,
			indicatorId: tempJobId,
			pageIndex,
			createdAt: Date.now(),
		};
		this.queue = [...this.queue, tempJob];

		// Show processing indicator
		if (editor?.showProcessingIndicator) {
			editor.showProcessingIndicator(tempJobId, crop, "uploading");
		}
		editor.clearCoverSelection?.();

		try {
			// SFX text-layer / translate-SFX plumbing is meaningful ONLY for the SFX
			// tier — the backend builds a plain clean prompt (buildCleanPrompt) for the
			// clean tiers and ignores textLayers/translateSfx. So only gather and send
			// that plumbing for sfx-pro; clean tiers route through the clean path with
			// no SFX baggage.
			const isSfxTier = this.aiTier === "sfx-pro";
			const overlappingTexts = isSfxTier ? editor.getTextLayersInSelection() : [];
			const translateSfx = isSfxTier ? this.shouldTranslateSfx() : false;
			projectStore.syncTextLayers(editor);
			await projectStore.saveState();

			// Pre-submit ROW gate (mirrors the batch path's pre-submit re-check in
			// processNextBatchJobs, which already requires the row to still be queued): a
			// project switch OR sign-out DURING the saveState() await above already removed
			// this temp row's UI context (cancelPollsForProject drops the LEFT project's rows;
			// cleanup() wipes the queue). It ALSO covers the A → B → A id-reuse case — switch
			// to B (cancelPollsForProject dropped this temp row), then reopen A mid-await:
			// isSubmitContextCurrent passes again on the same id, but the temp row is GONE, so
			// submitting now would CHARGE a job with no visible row. isSubmitRowCurrent requires
			// the row to STILL EXIST, so a PRE-submit gate here does NOT submit (no charge) when
			// the row is gone. On mismatch, drop the temp row (a no-op when a teardown already
			// cleared it), hide its indicator best-effort, and return WITHOUT submitting. A
			// single-gen row holds no concurrency slot, so there is nothing to decrement. The
			// finally clause still releases the inFlightSingleGen guard.
			if (!this.isSubmitRowCurrent(tempJobId, ownerProjectId, submitGeneration)) {
				this.queue = this.queue.filter(j => j.id !== tempJobId);
				this.hideIndicatorBestEffort(editor, tempJobId);
				return;
			}

			// NO explicit Idempotency-Key: let the BACKEND derive its authoritative
			// default key (project/image/crop/lang/tier/quality/prompt + server-resolved
			// BYO/platform namespace). The FE cannot know the backend's BYO routing, so a
			// FE-derived key could reuse the wrong job or skip the platform reservation
			// path. The double-click case is covered by the in-flight guard above; the
			// backend default key still de-dupes any genuinely identical resubmit.
			const { jobId, tier, costEstimate, creditReservation } = await api.submitAiJob({
				projectId: project.projectId,
				imageId: page.imageId,
				crop,
				lang: projectStore.activeTargetLang,
				customPrompt,
				textLayers: overlappingTexts.length > 0 ? overlappingTexts : undefined,
				translateSfx,
				tier: this.aiTier,
				quality: this.aiQuality,
			});
			// Project switched OR the session was torn down (sign-out) OR the A → B → A
			// id-reuse case (project current again but the temp row was DROPPED when B was
			// opened) while the submit round-trip was in flight: this job's LOCAL mirror is
			// gone / belongs to the LEFT project. Discard the CLIENT mirror — drop the temp
			// row (a no-op when already removed), start NO poll.
			//
			// On a plain SWITCH-AWAY or the A → B → A row-gone case (generation unchanged)
			// STILL create the marker server-side against ownerProjectId: the job was
			// ACCEPTED + CHARGED and the read-time reconciler only heals EXISTING processing
			// markers, so without this write the finished job is INVISIBLE when the owner
			// reopens. createAiReviewMarker targets ownerProjectId and (post-await guard)
			// writes NO local state into the now-open project; reopening the owner reloads the
			// marker (loadAiReviewMarkers). On a TEARDOWN (generation bumped) skip even the
			// marker write — the owning session is gone.
			//
			// The !rowStillPresent term is the A → B → A guard: isProjectContextCurrent alone
			// passes again on reopen, so without it the continuation would resurrect a temp
			// row that no longer exists (queue.map no-op) and arm a PHANTOM poll on a charged
			// job with no visible row. Requiring the row keeps the post-submit work marker-only.
			const teardownSinceSubmit = this.teardownGeneration !== submitGeneration;
			if (teardownSinceSubmit || !projectStore.isProjectContextCurrent(ownerProjectId) || !this.rowStillPresent(tempJobId)) {
				this.queue = this.queue.filter(j => j.id !== tempJobId);
				// Create the OWNER's server marker FIRST (when not torn down) so a disposed
				// editor's throwing hide below can never skip it — the accepted+charged job
				// must stay recoverable on reopen. The hide is then pure best-effort cleanup.
				if (!teardownSinceSubmit) {
					void this.createMarkerForRunningJob(jobId, jobId, ownerProjectId, submitGeneration, {
						jobId,
						pageIndex,
						imageId: page.imageId,
						region: crop,
						status: "processing",
						tier: tier ?? this.aiTier,
						customPrompt,
						textLayers: overlappingTexts.length > 0 ? overlappingTexts : undefined,
						translateSfx,
						costEstimate,
						creditReservation,
					});
				}
				this.hideIndicatorBestEffort(editor, tempJobId);
				return;
			}
			// Start polling immediately after the backend accepts the job. Marker creation
			// can touch project versions and must not keep the visible job stuck uploading.
			this.queue = this.queue.map(j => j.id === tempJobId ? {
				...j,
				id: jobId,
				// Local label only — the backend never returns the internal system prompt.
				prompt: customPrompt ?? j.prompt,
				status: "processing",
				stage: "processing",
				progress: 30,
				tier: tier ?? this.aiTier,
				remoteJobId: jobId,
				costEstimate,
				creditReservation,
			} : j);
			// The server marker MUST land for this accepted+charged job — it is the only
			// record the owner reloads on reopen (the read-time reconciler heals EXISTING
			// processing markers, not missing ones). Create it FIRST, before any editor
			// indicator mutation, so a route-away that disposed the editor mid-submit (a
			// throwing updateProcessingIndicator) can never abort marker creation and leave
			// the charged job without its server marker. The editor indicator is then a pure
			// best-effort cosmetic update (swallowed if the canvas is gone), and pollAiJob
			// itself no-ops its interval while suspended (resumePolling re-arms on remount).
			void this.createMarkerForRunningJob(jobId, jobId, ownerProjectId, submitGeneration, {
				jobId,
				pageIndex,
				imageId: page.imageId,
				region: crop,
				status: "processing",
				tier: tier ?? this.aiTier,
				customPrompt,
				textLayers: overlappingTexts.length > 0 ? overlappingTexts : undefined,
				translateSfx,
				costEstimate,
				creditReservation,
			});
			// Suspended (route-away disposed the editor): skip ALL editor work, leave the row
			// processing-without-interval (resumePolling re-arms it on the next mount). The
			// marker above already landed, so the charged job stays recoverable.
			if (this.pollingSuspended) return;
			this.updateIndicatorBestEffort(editor, tempJobId, "processing");
			this.pollAiJob(jobId, editor, crop, tempJobId, undefined, pageIndex);
		} catch (e: any) {
			// Remove temp job on error
			this.queue = this.queue.filter(j => j.id !== tempJobId);

			// Hide processing indicator (best-effort: a concurrent route-away may have
			// disposed the editor, and a throw here must not mask the original submit error).
			this.hideIndicatorBestEffort(editor, tempJobId);

			// Status write only when the submit context is still current — a rejection
			// landing after a switch/sign-out must not write into whatever project is
			// open now (codex P2 round 12; mirrors the startBatchJob catch guard).
			if (this.isSubmitContextCurrent(ownerProjectId, submitGeneration)) {
				projectStore.setStatusMsg(formatAiJobStartFailure(e));
			}
		} finally {
			// Release the in-flight guard once this submit settles (success OR failure),
			// so a deliberate re-generate of the same region is allowed afterward.
			this.inFlightSingleGen.delete(regionKey);
		}
	}

	async addBatchJobs(
		editor: any,
		crops: Array<{ x: number; y: number; w: number; h: number }>,
		customPrompt?: string,
	): Promise<void> {
		const project = projectStore.project;
		if (!editor || !project || crops.length === 0) return;
		this.rememberEditor(editor);

		const page = project.pages[project.currentPage];
		const pageIndex = project.currentPage;

		for (const crop of crops) {
			if (crop.w < config.minCropSize || crop.h < config.minCropSize) continue;

			const jobId = crypto.randomUUID();
			const job: BatchJob = {
				id: jobId,
				projectId: project.projectId,
				imageId: page.imageId,
				crop,
				lang: projectStore.activeTargetLang,
				prompt: `Translate to ${projectStore.activeTargetLang}`,
				customPrompt,
				translateSfx: this.shouldTranslateSfx(),
				thumbnail: this.generateThumbnail(editor, crop),
				status: "pending",
				stage: "uploading",
				progress: 0,
				tier: this.aiTier,
				quality: this.aiQuality,
				indicatorId: jobId,
				pageIndex,
				createdAt: Date.now(),
			};

			this.queue = [...this.queue, job];
		}

		this.processNextBatchJobs(editor);
	}

	async rerunAiReviewMarker(marker: AiReviewMarker, editor: any): Promise<boolean> {
		const project = projectStore.project;
		if (!project) {
			projectStore.setStatusMsg(formatAiMarkerRerunNoProject());
			return false;
		}
		this.rememberEditor(editor);
		if (!editor?.updateBackgroundImage) {
			projectStore.setStatusMsg("เปิดหน้าแก้ก่อนรันผล AI อีกครั้ง");
			return false;
		}
		const page = project.pages[marker.pageIndex];
		if (!page) {
			projectStore.setStatusMsg(formatAiMarkerRerunPageMissing(marker.pageIndex + 1));
			return false;
		}
		const pageImageIds = new Set([page.imageId, page.edits?.imageId].filter((imageId): imageId is string => Boolean(imageId)));
		if (!pageImageIds.has(marker.imageId)) {
			projectStore.setStatusMsg(formatAiMarkerRerunStaleImage());
			return false;
		}
		if (marker.pageIndex !== project.currentPage) {
			projectStore.setStatusMsg(formatAiMarkerRerunWrongPage(marker.pageIndex + 1));
			return false;
		}
		if (marker.region.w < config.minCropSize || marker.region.h < config.minCropSize) {
			projectStore.setStatusMsg(formatAiMarkerRerunRegionTooSmall());
			return false;
		}
		const localJobId = `rerun-${marker.id}-${Date.now()}`;
		const job: BatchJob = {
			id: localJobId,
			projectId: project.projectId,
			imageId: marker.imageId || page.imageId,
			crop: marker.region,
			lang: projectStore.activeTargetLang,
			// Local queue label only — the backend rebuilds the real prompt server-side
			// and never returns the internal system prompt. Use the user's own
			// instruction (customPrompt) or a generic label; never the system prompt.
			prompt: marker.customPrompt ?? `Rerun ${marker.tier} marker`,
			customPrompt: marker.customPrompt,
			textLayers: marker.textLayers,
			translateSfx: marker.translateSfx,
			thumbnail: this.generateThumbnail(editor, marker.region),
			status: "pending",
			stage: "uploading",
			progress: 0,
			tier: marker.tier,
			indicatorId: localJobId,
			pageIndex: marker.pageIndex,
			sourceMarkerId: marker.id,
			// Stable per (project, marker, source job) so a double-click or
			// post-timeout resubmit dedupes instead of queuing a second job /
			// credit reservation. Mirrors the backend's prompt-derived default.
			idempotencyKey: `ai-marker-rerun:${project.projectId}:${marker.id}:${marker.jobId}:${marker.updatedAt}`,
			linkedCommentIds: marker.linkedCommentIds,
			linkedTaskIds: marker.linkedTaskIds,
			createdAt: Date.now(),
		};

		this.queue = [...this.queue, job];
		projectStore.setStatusMsg(formatAiMarkerRerunQueued(marker.pageIndex + 1));
		await this.processNextBatchJobs(editor);
		return true;
	}

	// Retry-with-prompt: re-queue the marker's region through the /retry endpoint
	// using a reviewer-edited prompt. Validation mirrors rerunAiReviewMarker.
	async retryAiReviewMarkerWithPrompt(marker: AiReviewMarker, promptOverride: string, editor: any): Promise<boolean> {
		const project = projectStore.project;
		if (!project) {
			projectStore.setStatusMsg(formatAiMarkerRerunNoProject());
			return false;
		}
		this.rememberEditor(editor);
		if (!editor?.updateBackgroundImage) {
			projectStore.setStatusMsg("เปิดหน้าแก้ก่อนรันผล AI อีกครั้ง");
			return false;
		}
		const trimmedPrompt = promptOverride.trim();
		if (!trimmedPrompt) {
			projectStore.setStatusMsg("ใส่ prompt ใหม่ก่อนรันซ้ำ");
			return false;
		}
		const page = project.pages[marker.pageIndex];
		if (!page) {
			projectStore.setStatusMsg(formatAiMarkerRerunPageMissing(marker.pageIndex + 1));
			return false;
		}
		const pageImageIds = new Set([page.imageId, page.edits?.imageId].filter((imageId): imageId is string => Boolean(imageId)));
		if (!pageImageIds.has(marker.imageId)) {
			projectStore.setStatusMsg(formatAiMarkerRerunStaleImage());
			return false;
		}
		if (marker.pageIndex !== project.currentPage) {
			projectStore.setStatusMsg(formatAiMarkerRerunWrongPage(marker.pageIndex + 1));
			return false;
		}
		if (marker.region.w < config.minCropSize || marker.region.h < config.minCropSize) {
			projectStore.setStatusMsg(formatAiMarkerRerunRegionTooSmall());
			return false;
		}
		const localJobId = `retry-${marker.id}-${Date.now()}`;
		const job: BatchJob = {
			id: localJobId,
			projectId: project.projectId,
			imageId: marker.imageId || page.imageId,
			crop: marker.region,
			lang: projectStore.activeTargetLang,
			// Local queue label only (see rerun above) — never the system prompt.
			prompt: marker.customPrompt ?? `Retry ${marker.tier} marker`,
			customPrompt: trimmedPrompt,
			promptOverride: trimmedPrompt,
			textLayers: marker.textLayers,
			translateSfx: marker.translateSfx,
			thumbnail: this.generateThumbnail(editor, marker.region),
			status: "pending",
			stage: "uploading",
			progress: 0,
			tier: marker.tier,
			indicatorId: localJobId,
			pageIndex: marker.pageIndex,
			sourceMarkerId: marker.id,
			// Stable per (project, marker, source job, edited prompt) so retrying
			// the same prompt — including double-clicks or a post-timeout resubmit —
			// dedupes, while a changed prompt yields a new job. Mirrors the
			// backend's prompt-derived default key.
			idempotencyKey: `ai-marker-retry:${project.projectId}:${marker.id}:${marker.jobId}:${trimmedPrompt}`,
			linkedCommentIds: marker.linkedCommentIds,
			linkedTaskIds: marker.linkedTaskIds,
			createdAt: Date.now(),
		};

		this.queue = [...this.queue, job];
		projectStore.setStatusMsg(formatAiMarkerRerunQueued(marker.pageIndex + 1));
		await this.processNextBatchJobs(editor);
		return true;
	}

	private async processNextBatchJobs(editor: any): Promise<void> {
		const availableSlots = this.maxConcurrent - this.processingCount;
		if (availableSlots <= 0) return;

		const pendingJobs = this.queue.filter(
			j => j.status === "pending" && !this.pendingJobs.has(j.id)
		).slice(0, availableSlots);

		// Generation captured at loop entry. startBatchJob awaits a backend round-trip per
		// job; a project switch (or sign-out) DURING one of those awaits drops the LEFT
		// project's rows from this.queue (cancelPollsForProject) — but `pendingJobs` is a
		// snapshot taken before the loop, so without a re-check the loop would still submit
		// the NEXT already-removed row and CHARGE credits for work no row will ever show.
		const loopGeneration = this.teardownGeneration;
		for (const job of pendingJobs) {
			// Re-check immediately BEFORE each submit: the row must still be in the queue
			// (by id) AND its context still current (owning project still open + no teardown
			// since loop entry). A mid-loop switch/sign-out fails one of these → skip it.
			const stillQueued = this.queue.some(j => j.id === job.id);
			if (!stillQueued || !this.isSubmitContextCurrent(job.projectId, loopGeneration)) continue;
			await this.startBatchJob(job, editor);
		}
	}

	private async startBatchJob(job: BatchJob, editor: any): Promise<void> {
		// The OWNING project, captured before any await. job.projectId was bound when
		// the row was enqueued (synchronously). The retry/rerun and submit backend
		// round-trips are awaited below; if the user switches away while one is in
		// flight, the continuation (marker create + poll start) must bind to THIS
		// project, not the now-open one. See discardSwitchedAwayJob.
		const ownerProjectId = job.projectId;
		// Teardown generation captured before any await (see isSubmitContextCurrent):
		// a sign-out mid-round-trip makes discardSwitchedAwayJob bail even on a same-id
		// re-login, so the continuation never resurrects a poll on the disposed session.
		const submitGeneration = this.teardownGeneration;
		// This row now holds one of the maxConcurrent batch slots. Mark it BEFORE the
		// increment so every release path (terminal poll / discard / cancel / per-project
		// reconciliation) can decrement off the flag, not off live poll handles — which a
		// route-away (suspendPolling) clears while the row stays processing.
		this.updateJob(job.id, { status: "processing", stage: "uploading", progress: 10, holdsBatchSlot: true });
		this.processingCount++;

		// Show processing indicator on canvas
		if (editor?.showProcessingIndicator) {
			editor.showProcessingIndicator(job.id, job.crop, "uploading");
		}

		try {
			if (job.sourceMarkerId) {
				const result = job.promptOverride
					? await api.retryAiReviewMarker(
						job.projectId,
						job.sourceMarkerId,
						{ lang: job.lang, promptOverride: job.promptOverride },
						job.idempotencyKey,
						job.tier,
					)
					: await api.rerunAiReviewMarker(
						job.projectId,
						job.sourceMarkerId,
						{ lang: job.lang },
						job.idempotencyKey,
						job.tier,
					);

				// Project switched OR session torn down while the retry/rerun round-trip
				// was in flight: this job belongs to the LEFT project (or a disposed
				// session). Discard the client mirror, start no poll. The retry/rerun
				// endpoint already created/persisted the marker server-side, so no extra
				// marker write is needed here on a switch-away.
				if (this.discardSwitchedAwayJob(job.id, ownerProjectId, submitGeneration, editor)) return;

				this.updateJob(job.id, {
					// Backend no longer returns the internal prompt (leak-safe); keep the
					// existing local label rather than overwriting it with undefined.
					prompt: result.prompt ?? job.prompt,
				stage: "processing",
				progress: 30,
				tier: result.tier ?? job.tier,
				remoteJobId: result.jobId,
				markerId: result.marker.id,
				costEstimate: result.costEstimate,
				creditReservation: result.creditReservation,
				});

				// The retry/rerun endpoint already persisted the marker server-side (result.
				// marker.id), so there is no client marker write to protect here. Still gate
				// the editor work on the suspended flag and make the indicator best-effort so a
				// route-away that disposed the editor mid-rerun cannot throw out of this path
				// (which the catch would mis-record as a start failure on an accepted job).
				if (this.pollingSuspended) return;
				this.updateIndicatorBestEffort(editor, job.id, "processing");
				this.pollBatchJob(job.id, result.jobId, editor, result.marker.id, job.pageIndex);
				return;
			}

			const { jobId, tier, costEstimate, creditReservation } = await api.submitAiJob({
				projectId: job.projectId,
				imageId: job.imageId,
				crop: job.crop,
				lang: job.lang,
				customPrompt: job.customPrompt,
				textLayers: job.textLayers,
				translateSfx: job.translateSfx ?? (job.tier === "sfx-pro" && this.sfxToggle),
				tier: job.tier,
				quality: job.quality ?? this.aiQuality,
				idempotencyKey: job.idempotencyKey,
			});

			// The accepted+charged job's marker. createAiReviewMarker targets
			// ownerProjectId, so this server write lands for the OWNER even after a
			// switch, while its post-await guard keeps the local mirror out of the
			// now-open project.
			const markerInput: Parameters<typeof projectStore.createAiReviewMarker>[0] = {
				jobId,
				pageIndex: job.pageIndex ?? projectStore.project?.currentPage ?? 0,
				imageId: job.imageId,
				region: job.crop,
				status: "processing",
				tier: tier ?? job.tier,
				customPrompt: job.customPrompt,
				textLayers: job.textLayers,
				translateSfx: job.translateSfx,
				costEstimate,
				creditReservation,
				linkedCommentIds: job.linkedCommentIds,
				linkedTaskIds: job.linkedTaskIds,
			};

			// Project switched OR session torn down while the submit round-trip was in
			// flight: this job belongs to the LEFT project (or a disposed session).
			// Discard the CLIENT mirror and start no poll. On a plain SWITCH-AWAY
			// (generation unchanged) STILL create the marker server-side against
			// ownerProjectId so the accepted+charged job stays visible when the owner
			// reopens (the read-time reconciler only heals EXISTING processing markers);
			// createAiReviewMarker writes no local state into the now-open project, and
			// pageIndex falls back to the captured job.pageIndex (NOT B's current page).
			// On a TEARDOWN (generation bumped) skip the marker write — the owning
			// session is gone.
			const teardownSinceSubmit = this.teardownGeneration !== submitGeneration;
			if (this.discardSwitchedAwayJob(job.id, ownerProjectId, submitGeneration, editor, jobId)) {
				if (!teardownSinceSubmit) {
					void this.createMarkerForRunningJob(job.id, jobId, ownerProjectId, submitGeneration, {
						...markerInput,
						pageIndex: job.pageIndex ?? 0,
					});
				}
				return;
			}

			this.updateJob(job.id, {
				stage: "processing",
				progress: 30,
				remoteJobId: jobId,
				costEstimate,
				creditReservation,
			});

			// Create the server marker FIRST — before any editor indicator mutation. This
			// accepted+charged job's marker is the only record the owner reloads on reopen,
			// and a route-away that disposed the editor mid-submit would make a raw
			// updateProcessingIndicator throw; ordering the marker write ahead (and making the
			// indicator best-effort) guarantees a disposed canvas can never leave the charged
			// job without its marker. pollBatchJob no-ops its interval while suspended.
			void this.createMarkerForRunningJob(job.id, jobId, ownerProjectId, submitGeneration, markerInput);

			// Suspended (route-away disposed the editor): skip ALL editor work; the row stays
			// processing-without-interval and resumePolling re-arms it on the next mount.
			if (this.pollingSuspended) return;

			// Update indicator to processing stage and poll before marker creation finishes.
			this.updateIndicatorBestEffort(editor, job.id, "processing");
			this.pollBatchJob(job.id, jobId, editor, undefined, job.pageIndex);
		} catch (e: any) {
			console.error("[startBatchJob] Error:", e);
			// Context re-check at CATCH entry: a submit/retry REJECTION landing after
			// a switch/sign-out must not overwrite the now-open project's status nor
			// pump its batch queue with the old job context (codex P2 round 12).
			// discardSwitchedAwayJob removes the stale row + indicator when present.
			if (this.discardSwitchedAwayJob(job.id, ownerProjectId, submitGeneration, editor)) return;
			// This catch only wraps provider/backend submit calls and the result is
			// PERSISTED to job.error (BatchPanel renders it verbatim), so use the
			// ALLOWLIST-only provider formatter: a friendly category OR the generic
			// fallback, NEVER the raw provider text (key/prompt/role-dump/etc.).
			const friendlyError = formatAiProviderStartFailure(e);
			projectStore.setStatusMsg(friendlyError);
			this.updateJob(job.id, {
				status: "error",
				stage: "failed",
				error: friendlyError,
			});

			// Update indicator to failed stage (best-effort: a route-away may have disposed
			// the editor, and a throw here must not mask the original submit error).
			this.updateIndicatorBestEffort(editor, job.id, "failed");

			this.releaseBatchSlot(job.id);
			this.processNextBatchJobs(editor);
		}
	}

	private pollBatchJob(localId: string, remoteJobId: string, editor: any, markerId?: string, pageIndex?: number): void {
		// Suspended (shell unmounted / route-away): the editor is disposed, so do NOT arm
		// an interval — a tick would touch the dead Fabric canvas. The row stays in its
		// current (processing) state; resumePolling re-arms a poll for it on the next mount.
		if (this.pollingSuspended) return;
		// Bind this poll to the project AND teardown generation it started under. The
		// guard (below) re-checks both every tick / on resolution so a job that resolves
		// after a switch to a DIFFERENT project — or after a sign-out (even a same-id
		// reopen) — never writes into whatever is open now. The editor is kept on the
		// handle so a project switch can hide this row's canvas indicator on the exact
		// editor it was drawn on (see cancelPollsForProject).
		const handle: PollHandle = {
			interval: undefined as unknown as ReturnType<typeof setInterval>,
			projectId: projectStore.project?.projectId ?? "",
			generation: this.teardownGeneration,
			suspendGeneration: this.suspendGeneration,
			editor,
		};
		let pollFailures = 0;
		const interval = setInterval(async () => {
			// Generation guard: if the active project no longer matches the one this
			// poll started under, stop the timer and discard WITHOUT touching
			// projectStore/editor (no marker/status/indicator writes into project B).
			// The backend still owns persisting the result for project A server-side.
			if (!this.isPollContextCurrent(handle)) {
				clearInterval(interval);
				this.pendingJobs.delete(localId);
				this.pendingMarkerUpdates.delete(remoteJobId);
				return;
			}
			try {
				const result = await api.getAiStatus(remoteJobId);
				// Re-check AFTER the await: the project could have switched while the
				// status request was in flight. Discard the late result silently.
				if (!this.isPollContextCurrent(handle)) {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					this.pendingMarkerUpdates.delete(remoteJobId);
					return;
				}
				pollFailures = 0;
				const progress = result.status === "processing" ? 60 : 30;

				if (result.status === "done" && result.resultImageId) {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					this.updateJob(localId, {
						status: "done",
						stage: "complete",
						progress: 100,
						resultImageId: result.resultImageId,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					this.releaseBatchSlot(localId);

					// Leave a brief completion flash, then let the AI review marker carry the persistent state.
					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(localId, "complete");
					}

					await this.updateMarkerOrDefer(remoteJobId, localId, markerId, {
						status: "needs_review",
						resultImageId: result.resultImageId,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					// Auto-focus the freshly completed marker so the before/after
					// slider is visible with ZERO clicks — the result used to sit
					// behind an unselected card and read as "ผลไม่โชว์" (user bug).
					// Re-check the poll context AFTER the awaited marker update: a
					// project switch/sign-out mid-await must not leak selection into
					// whatever project is open now (codex P2).
					const readyMarkerId = markerId ?? this.queue.find(j => j.id === localId)?.markerId;
					if (readyMarkerId && this.isPollContextCurrent(handle)) projectStore.selectAiReviewMarker(readyMarkerId);
					this.markCompletedResultReady(pageIndex);
					if (editor?.hideProcessingIndicator) {
						setTimeout(() => {
							editor.hideProcessingIndicator(localId);
						}, 1200);
					}
					this.processNextBatchJobs(editor);
				} else if (result.status === "done" && !result.resultImageId) {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					const message = formatAiMissingResultFailure();
					this.updateJob(localId, {
						status: "error",
						stage: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					this.releaseBatchSlot(localId);

					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(localId, "failed");
					}

					await this.updateMarkerOrDefer(remoteJobId, localId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
					this.processNextBatchJobs(editor);
				} else if (result.status === "needs_review") {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					const message = formatAiNeedsReviewStatus(result.error);
					this.updateJob(localId, {
						status: "needs_review",
						stage: "complete",
						progress: 100,
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					this.releaseBatchSlot(localId);

					if (editor?.hideProcessingIndicator) {
						editor.hideProcessingIndicator(localId);
					}

					await this.updateMarkerOrDefer(remoteJobId, localId, markerId, {
						status: "needs_review",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
					this.processNextBatchJobs(editor);
				} else if (result.status === "error") {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					const message = formatAiJobProviderFailure(result.error);
					this.updateJob(localId, {
						status: "error",
						stage: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					this.releaseBatchSlot(localId);

					// Hide processing indicator on error
					if (editor?.hideProcessingIndicator) {
						editor.hideProcessingIndicator(localId);
					}

					await this.updateMarkerOrDefer(remoteJobId, localId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
					this.processNextBatchJobs(editor);
				} else if (result.status === "cancelled") {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					const message = formatAiCancelledStatus(result.error);
					this.updateJob(localId, {
						status: "cancelled",
						stage: "cancelled",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					this.releaseBatchSlot(localId);

					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(localId, "failed");
					}
					if (editor?.hideProcessingIndicator) {
						editor.hideProcessingIndicator(localId);
					}

					await this.updateMarkerOrDefer(remoteJobId, localId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
					this.processNextBatchJobs(editor);
				} else if (result.status === "processing") {
					this.updateJob(localId, {
						stage: "processing",
						progress: 60,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
				}
			} catch (error) {
				// Context re-check at CATCH entry, mirroring the success path: a
				// getAiStatus REJECTION that lands after a suspend/switch/sign-out must
				// not write retry/error state into whatever project or session is now
				// current (codex P2 round 12). Stop the timer and discard silently.
				if (!this.isPollContextCurrent(handle)) {
					clearInterval(interval);
					this.pendingJobs.delete(localId);
					this.pendingMarkerUpdates.delete(remoteJobId);
					return;
				}
				pollFailures += 1;
				const message = formatAiStatusRetryDetail(error, pollFailures, this.maxPollFailures);
				if (pollFailures < this.maxPollFailures) {
					this.updateJob(localId, {
						stage: "processing",
						progress: 60,
						error: message,
					});
					projectStore.setStatusMsg(formatAiStatusRetry(pollFailures, this.maxPollFailures));
					return;
				}
				clearInterval(interval);
				this.pendingJobs.delete(localId);
				const failedMessage = formatAiStatusFailed(error);
				this.updateJob(localId, {
					status: "error",
					stage: "failed",
					error: failedMessage,
				});
				this.releaseBatchSlot(localId);

				// Hide processing indicator on polling error
				if (editor?.hideProcessingIndicator) {
					editor.hideProcessingIndicator(localId);
				}

				projectStore.setStatusMsg(failedMessage);
				this.processNextBatchJobs(editor);
			}
		}, config.aiPollIntervalMs);

		handle.interval = interval;
		this.pendingJobs.set(localId, handle);
	}

	private pollAiJob(jobId: string, editor: any, crop: { x: number; y: number; w: number; h: number }, tempJobId?: string, markerId?: string, pageIndex?: number): void {
		// Use tempJobId for indicator updates (passed from generateCover)
		// This ensures we update the same indicator that was shown initially
		const indicatorId = tempJobId || jobId;

		// First update job to "processing" stage
		this.queue = this.queue.map(j => {
			if (j.id === jobId || j.id.startsWith("temp-")) {
				return { ...j, id: jobId, status: 'processing' as JobStatus, stage: 'processing' as ProgressStage, progress: Math.max(j.progress, 30) };
			}
			return j;
		});

		// Suspended (shell unmounted / route-away): the editor is disposed, so do NOT arm
		// an interval AND do NOT touch the indicator — the row (rewritten to the real jobId
		// above) stays in `processing` and resumePolling re-arms its poll on the next mount.
		// The suspended check precedes EVERY editor mutation so a disposed canvas can never
		// throw out of this re-arm helper.
		if (this.pollingSuspended) return;

		// Update indicator to processing stage (best-effort: the editor may have just been
		// disposed by a concurrent route-away, in which case the cosmetic update is skipped).
		this.updateIndicatorBestEffort(editor, indicatorId, "processing");

		// Bind this poll to the project AND teardown generation it started under (see the
		// matching guard in pollBatchJob for the full rationale). The editor is kept on the
		// handle so a project switch can hide this row's canvas indicator (see cancelPollsForProject).
		const handle: PollHandle = {
			interval: undefined as unknown as ReturnType<typeof setInterval>,
			projectId: projectStore.project?.projectId ?? "",
			generation: this.teardownGeneration,
			suspendGeneration: this.suspendGeneration,
			editor,
		};
		let pollFailures = 0;
		const interval = setInterval(async () => {
			// Generation guard (pre-request): the active project switched away → stop
			// the timer and discard without touching projectStore/editor.
			if (!this.isPollContextCurrent(handle)) {
				clearInterval(interval);
				this.pendingJobs.delete(jobId);
				this.pendingMarkerUpdates.delete(jobId);
				return;
			}
			try {
				const result = await api.getAiStatus(jobId);
				// Generation guard (post-request): the project could have switched while
				// the status request was in flight. Discard the late result silently.
				if (!this.isPollContextCurrent(handle)) {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					this.pendingMarkerUpdates.delete(jobId);
					return;
				}
				pollFailures = 0;

				// Update job progress based on status
				this.queue = this.queue.map(j => {
					if (j.id === jobId) {
						if (result.status === 'processing') {
							return { ...j, stage: 'processing' as ProgressStage, progress: 50, costEstimate: result.costEstimate, creditReservation: result.creditReservation };
						} else if (result.status === 'downloading') {
							// Update indicator to downloading stage
							if (editor?.updateProcessingIndicator) {
								editor.updateProcessingIndicator(indicatorId, "downloading");
							}
							return { ...j, stage: 'downloading' as ProgressStage, progress: 80, costEstimate: result.costEstimate, creditReservation: result.creditReservation };
						}
					}
					return j;
				});

				if (result.status === "done" && result.resultImageId) {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					const resolvedMarkerId = markerId ?? this.queue.find(j => j.id === jobId)?.markerId;
					this.queue = this.queue.filter(j => j.id !== jobId);

					// Leave a brief completion flash, then let the AI review marker carry the persistent state.
					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(indicatorId, "complete");
					}

					await this.updateMarkerOrDefer(jobId, jobId, resolvedMarkerId, {
						status: "needs_review",
						resultImageId: result.resultImageId,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					// Auto-focus the ready marker (same as the single-job path) —
					// stale-poll guarded after the await (codex P2).
					if (resolvedMarkerId && this.isPollContextCurrent(handle)) projectStore.selectAiReviewMarker(resolvedMarkerId);
					this.markCompletedResultReady(pageIndex);
					if (editor?.hideProcessingIndicator) {
						setTimeout(() => {
							editor.hideProcessingIndicator(indicatorId);
						}, 1200);
					}
				} else if (result.status === "done" && !result.resultImageId) {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					const message = formatAiMissingResultFailure();
					this.queue = this.queue.map(j => j.id === jobId ? {
						...j,
						status: "error" as JobStatus,
						stage: "failed" as ProgressStage,
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					} : j);

					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(indicatorId, "failed");
					}

					await this.updateMarkerOrDefer(jobId, jobId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
				} else if (result.status === "needs_review") {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					const message = formatAiNeedsReviewStatus(result.error);
					this.queue = this.queue.map(j => j.id === jobId ? {
						...j,
						status: "needs_review" as JobStatus,
						stage: "complete" as ProgressStage,
						progress: 100,
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					} : j);

					if (editor?.hideProcessingIndicator) {
						editor.hideProcessingIndicator(indicatorId);
					}

					await this.updateMarkerOrDefer(jobId, jobId, markerId, {
						status: "needs_review",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
				} else if (result.status === "error") {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					const message = formatAiJobProviderFailure(result.error);
					this.queue = this.queue.map(j => j.id === jobId ? { ...j, status: 'error' as JobStatus, stage: 'failed' as ProgressStage, error: message, costEstimate: result.costEstimate, creditReservation: result.creditReservation } : j);

					// Update indicator to failed stage
					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(indicatorId, "failed");
					}

					await this.updateMarkerOrDefer(jobId, jobId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
				} else if (result.status === "cancelled") {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					const message = formatAiCancelledStatus(result.error);
					this.queue = this.queue.map(j => j.id === jobId ? {
						...j,
						status: "cancelled" as JobStatus,
						stage: "cancelled" as ProgressStage,
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					} : j);

					if (editor?.updateProcessingIndicator) {
						editor.updateProcessingIndicator(indicatorId, "failed");
					}
					if (editor?.hideProcessingIndicator) {
						editor.hideProcessingIndicator(indicatorId);
					}

					await this.updateMarkerOrDefer(jobId, jobId, markerId, {
						status: "failed",
						error: message,
						costEstimate: result.costEstimate,
						creditReservation: result.creditReservation,
					});
					projectStore.setStatusMsg(message);
				}
			} catch (error) {
				// Same catch-entry context re-check as pollBatchJob (codex P2 round 12).
				if (!this.isPollContextCurrent(handle)) {
					clearInterval(interval);
					this.pendingJobs.delete(jobId);
					this.pendingMarkerUpdates.delete(jobId);
					return;
				}
				pollFailures += 1;
				const message = formatAiStatusRetryDetail(error, pollFailures, this.maxPollFailures);
				if (pollFailures < this.maxPollFailures) {
					this.queue = this.queue.map(j => j.id === jobId
						? {
							...j,
							stage: "processing" as ProgressStage,
							progress: Math.max(j.progress, 50),
							error: message,
						}
						: j);
					projectStore.setStatusMsg(formatAiStatusRetry(pollFailures, this.maxPollFailures));
					return;
				}
				clearInterval(interval);
				this.pendingJobs.delete(jobId);
				const failedMessage = formatAiStatusFailed(error);
				this.queue = this.queue.map(j => j.id === jobId ? { ...j, status: 'error' as JobStatus, stage: 'failed' as ProgressStage, error: failedMessage } : j);

				// Update indicator to failed stage
				if (editor?.updateProcessingIndicator) {
					editor.updateProcessingIndicator(indicatorId, "failed");
				}

				projectStore.setStatusMsg(failedMessage);
			}
		}, config.aiPollIntervalMs);

		handle.interval = interval;
		this.pendingJobs.set(jobId, handle);
	}

	private markCompletedResultReady(pageIndex?: number): void {
		projectStore.setStatusMsg(
			pageIndex === undefined
					? "ผล AI พร้อมรีวิวแล้ว"
					: `ผล AI พร้อมรีวิว หน้า ${pageIndex + 1} แล้ว`,
		);
	}

	// Called after a backend submit/retry/rerun resolves, BEFORE any client mirror
	// (poll start, marker create, queue status write). Bails (returns true) when the
	// job's LOCAL row context is no longer current — ANY of:
	//   (a) the active project no longer matches the one the job was submitted under
	//       (ownerProjectId, captured before the first await), or a full teardown
	//       (sign-out) bumped the generation since `submitGeneration` was captured; OR
	//   (b) the project IS current again but the queue row was DROPPED — the A → B → A
	//       case: a switch to B ran cancelPollsForProject (removing A's rows), then A was
	//       reopened while this submit await was still in flight. isSubmitContextCurrent
	//       passes again (same id + generation), so the id-only guard would let the
	//       continuation poll/updateJob a row that no longer exists (phantom poll, charged
	//       work with no visible row). rowStillPresent closes that gap.
	// On a bail it drops the queue row (a no-op in case (b) where it is already gone),
	// frees any held slot, and hides the indicator. The caller still writes the server
	// marker for the accepted+charged job (the bail only skips LOCAL row/poll work); the
	// owner reloads that marker on reopen, so the charged job stays recoverable.
	// Returns true when the caller must bail out. generateCover handles its own discard
	// inline (it owns the inFlightSingleGen guard release + temp-row id), so this is the
	// batch/retry/rerun path's helper.
	// Rows removed by discardSwitchedAwayJob, captured AT DISCARD TIME (so they carry
	// any remoteJobId the continuation had just received — the pre-flip snapshot the
	// create-flow rollback restores from predates that and would re-insert an
	// unpollable, slot-wedging stale copy; codex P2 round 14). Bounded by clearing on
	// cleanup() and on every new snapshot; rollback restoration consumes entries.
	private lastDiscardedRows = new Map<string, BatchJob>();

	private discardSwitchedAwayJob(localJobId: string, ownerProjectId: string, submitGeneration: number, editor: any, remoteJobId?: string): boolean {
		// Row-dependent gate: require BOTH the project/generation current AND the row still
		// present. The combined check makes the A → B → A id-reuse case (project current,
		// row gone) bail just like a plain switch-away.
		if (this.isSubmitRowCurrent(localJobId, ownerProjectId, submitGeneration)) return false;
		// Free the slot off the row's flag BEFORE removing it (releaseBatchSlot looks
		// the row up by id), so the decrement is slot-accurate and can't double-fire. A
		// no-op when the row is already gone (case (b)) — releaseBatchSlot/filter both skip.
		// Stash the row AS IT IS NOW (post-submit it carries remoteJobId) so a
		// create-flow rollback can restore the POLLABLE version instead of the
		// stale pre-flip snapshot copy (codex P2 round 14).
		const discarded = this.queue.find(j => j.id === localJobId);
		if (discarded) {
			this.lastDiscardedRows.set(localJobId, {
				...discarded,
				// The caller may have JUST received the backend id without having
				// stamped it onto the row yet — carry it so the restored copy is
				// pollable (resumePolling skips rows with no remoteJobId).
				remoteJobId: remoteJobId ?? discarded.remoteJobId,
				crop: { ...discarded.crop },
			});
		}
		this.releaseBatchSlot(localJobId);
		this.queue = this.queue.filter(j => j.id !== localJobId);
		// Best-effort: the editor may have been disposed by a concurrent route-away, and a
		// throw here must not propagate out of the discard helper — the caller relies on this
		// returning true so it can STILL create the owner's server marker for the charged job.
		this.hideIndicatorBestEffort(editor, localJobId);
		return true;
	}

	private async createMarkerForRunningJob(localJobId: string, remoteJobId: string, ownerProjectId: string, submitGeneration: number, input: Parameters<typeof projectStore.createAiReviewMarker>[0]): Promise<void> {
		// The project this marker belongs to was captured before the FIRST await of the
		// submit/retry entry point and threaded in as ownerProjectId — NOT read here,
		// where the active project may already be a DIFFERENT one after a switch. The
		// teardown generation captured at the same point is threaded in too, so a
		// sign-out mid-create makes the local-mirror writes below no-ops even on a
		// same-id re-login.
		//
		// The backend job for ownerProjectId was ACCEPTED + CHARGED; the read-time
		// reconciler only heals EXISTING processing markers, so the finished job would
		// be INVISIBLE when the owner reopens unless its marker exists server-side. So
		// we ALWAYS issue the server write — but TARGET ownerProjectId explicitly
		// (forProjectId) so createAiReviewMarker persists for the owner and, via its
		// post-await guard, applies the marker/activity/selection into local state ONLY
		// when the owner is still the open project. A switch therefore writes the marker
		// server-side (reloaded on reopen → loadAiReviewMarkers) without bleeding it
		// into the now-open project B.
		// The id-only apply gate inside createAiReviewMarker is insufficient on a
		// SIGN-OUT mid-await: cleanup() wipes THIS store but the project store may still
		// hold ownerProjectId, so the id check alone would let a dead session's marker
		// apply locally. Thread our captured-generation check in via isContextCurrent so
		// the local apply is skipped once cleanup() bumped the generation — our own guard
		// below only runs after the call returns, too late to stop that apply. The server
		// write still happens regardless (the job was accepted+charged).
		const marker = await projectStore.createAiReviewMarker(input, {
			forProjectId: ownerProjectId,
			isContextCurrent: () => this.teardownGeneration === submitGeneration,
		});
		if (!marker) {
			if (this.isSubmitContextCurrent(ownerProjectId, submitGeneration)) {
				projectStore.setStatusMsg(formatAiMarkerCreatePending());
			}
			return;
		}
		// Project switched (or session torn down) while the marker was being created →
		// the server write already persisted for ownerProjectId (and createAiReviewMarker
		// skipped the local apply), so just drop the deferred client mirror; nothing
		// recoverable is lost.
		if (!this.isSubmitContextCurrent(ownerProjectId, submitGeneration)) {
			this.pendingMarkerUpdates.delete(remoteJobId);
			return;
		}

		this.updateJob(localJobId, { markerId: marker.id });
		const pendingUpdate = this.pendingMarkerUpdates.get(remoteJobId);
		if (pendingUpdate) {
			this.pendingMarkerUpdates.delete(remoteJobId);
			// Only flush a deferred terminal update if the project it was queued under
			// is still the active open project. Otherwise this would write project A's
			// terminal marker state into project B after a switch. The backend already
			// owns the persisted marker for A server-side, so dropping the client flush
			// is safe.
			if (this.isPollContextCurrent(pendingUpdate)) {
				await projectStore.updateAiReviewMarker(marker.id, pendingUpdate.input, { select: false });
			}
		}
	}

	private async updateMarkerOrDefer(remoteJobId: string, localJobId: string, markerId: string | undefined, input: MarkerTerminalUpdate): Promise<void> {
		const resolvedMarkerId = markerId ?? this.queue.find(j => j.id === localJobId)?.markerId;
		if (!resolvedMarkerId) {
			// Defer until the marker id is known, capturing the project so this update
			// can never be flushed into a different project after a switch.
			this.pendingMarkerUpdates.set(remoteJobId, {
				input,
				projectId: projectStore.project?.projectId ?? "",
			});
			return;
		}

		await projectStore.updateAiReviewMarker(resolvedMarkerId, input, { select: false });
	}

	async cancelJob(jobId: string, editor?: any): Promise<void> {
		this.rememberEditor(editor);
		const job = this.queue.find(j => j.id === jobId);
		const handle = this.pendingJobs.get(jobId);
		if (handle) {
			clearInterval(handle.interval);
			this.pendingJobs.delete(jobId);
		}

		if (!job) return;

		const remoteJobId = job.remoteJobId ?? (job.id.startsWith("temp-") ? undefined : job.id);
		const indicatorId = job.indicatorId ?? job.id;
		this.updateJob(jobId, { status: "cancelled", stage: "cancelled", error: formatAiCancelledStatus("ยกเลิกแล้ว") });
		// Free a slot only if this row actually held one (batch rows do; single-gen
		// rows never take a slot). releaseBatchSlot reads the flag, so cancelling a
		// single-gen processing row no longer wrongly decrements the count.
		this.releaseBatchSlot(jobId);

		if (editor?.updateProcessingIndicator) {
			editor.updateProcessingIndicator(indicatorId, "failed");
		}
		if (editor?.hideProcessingIndicator) {
			editor.hideProcessingIndicator(indicatorId);
		}

		if (!remoteJobId) {
			projectStore.setStatusMsg(formatAiCancelledStatus("ยังไม่ส่งถึง backend"));
			this.processNextBatchJobs(editor);
			return;
		}

		try {
			const result = await api.cancelAiJob(remoteJobId);
			this.updateJob(jobId, {
				error: formatAiCancelledStatus(result.error || "ยกเลิกแล้ว"),
				costEstimate: result.costEstimate,
				creditReservation: result.creditReservation,
			});
			projectStore.setStatusMsg(formatAiCancelledStatus(result.error || "ยกเลิกแล้ว"));
		} catch (error) {
			const message = formatAiCancelBackendFailed(error);
			this.updateJob(jobId, { status: "error", stage: "failed", error: message });
			projectStore.setStatusMsg(message);
		} finally {
			this.processNextBatchJobs(editor);
		}
	}

	// Terminal statuses that "clear finished" should remove. needs_review is
	// deliberately EXCLUDED: those rows still carry a result the user must
	// accept/reject, so clearing them would silently drop pending work.
	private static readonly CLEARABLE_TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "error", "cancelled"]);

	get clearableJobs(): BatchJob[] {
		return this.queue.filter(j => AiJobsStore.CLEARABLE_TERMINAL_STATUSES.has(j.status));
	}

	clearCompleted(): void {
		// Clear EVERY terminal row the label promises (done/error/cancelled), not just
		// done/error — cancelled rows previously lingered despite "ล้างรายการเสร็จ".
		// needs_review stays (still actionable).
		this.queue = this.queue.filter(j => !AiJobsStore.CLEARABLE_TERMINAL_STATUSES.has(j.status));
	}

	reorderQueue(fromIndex: number, toIndex: number): void {
		const active = this.activeJobs;
		const [item] = active.splice(fromIndex, 1);
		active.splice(toIndex, 0, item);

		const completed = this.completedJobs;
		this.queue = [...active, ...completed];
	}

	private updateJob(id: string, updates: Partial<BatchJob>): void {
		this.queue = this.queue.map(j =>
			j.id === id ? { ...j, ...updates } : j
		);
	}

	// Release the concurrency slot held by a batch row, if any. Idempotent and
	// slot-accurate: it decrements processingCount ONLY when the row still carries
	// holdsBatchSlot, then flips the flag off so a second release (e.g. a terminal
	// poll branch racing a cancel) cannot double-decrement. Single-generate rows
	// (holdsBatchSlot falsy) are no-ops, so re-arming one through pollBatchJob and
	// letting its terminal branch call this never drives the count negative. Keeps
	// the invariant processingCount === (# rows with holdsBatchSlot === true).
	private releaseBatchSlot(localId: string): void {
		const job = this.queue.find(j => j.id === localId);
		if (!job?.holdsBatchSlot) return;
		this.updateJob(localId, { holdsBatchSlot: false });
		this.processingCount = Math.max(0, this.processingCount - 1);
	}

	// Test-only invariant check: processingCount must equal the number of queue
	// rows that currently hold a batch slot. Every slot increment/decrement keeps
	// this true, so a violation means an accounting path missed the flag.
	__assertSlotInvariant(): void {
		const held = this.queue.filter(j => j.holdsBatchSlot === true).length;
		if (this.processingCount !== held) {
			throw new Error(
				`slot invariant violated: processingCount=${this.processingCount} but ${held} row(s) hold a slot`,
			);
		}
	}

	private generateThumbnail(editor: any, crop: { x: number; y: number; w: number; h: number }): string {
		try {
			// Get the actual HTML canvas element from Fabric.js
			const fabricCanvas = editor.canvas;
			const canvasEl = fabricCanvas.getElement();
			const thumbCanvas = document.createElement("canvas");
			const scale = 60 / Math.max(crop.w, crop.h);
			thumbCanvas.width = crop.w * scale;
			thumbCanvas.height = crop.h * scale;
			const thumbCtx = thumbCanvas.getContext("2d");
			if (!thumbCtx) return "";

			// Transform crop from image space to canvas space
			// crop is in original image coordinates, need to map to canvas coordinates
			const b = editor.imageBounds;
			const scaleX = b.width / editor.imageWidth;
			const scaleY = b.height / editor.imageHeight;

			const canvasCrop = {
				x: b.left + crop.x * scaleX,
				y: b.top + crop.y * scaleY,
				w: crop.w * scaleX,
				h: crop.h * scaleY,
			};

			thumbCtx.drawImage(
				canvasEl,
				canvasCrop.x, canvasCrop.y, canvasCrop.w, canvasCrop.h,
				0, 0, thumbCanvas.width, thumbCanvas.height
			);

			return thumbCanvas.toDataURL("image/jpeg", 0.7);
		} catch {
			return "";
		}
	}

	// Route-away tier (WorkspaceShell.onDestroy). The shell unmounts on a mere route
	// change WITHIN the session (e.g. to /settings) as well as on sign-out, so this MUST
	// be the narrow teardown: stop the poll intervals (the editor is disposed — a tick
	// would throw inside the dead Fabric canvas) but DO NOT bump teardownGeneration, clear
	// the queue, or drop pendingMarkerUpdates. A submit/retry continuation still in flight
	// for the still-owned project must keep writing its SERVER marker (via ownerProjectId,
	// already API-direct + conditional local apply, safe with no editor); the pollingSuspended
	// flag merely keeps it from arming a doomed interval. Processing rows stay in the queue
	// and processingCount is untouched, so resumePolling re-arms them on the next mount.
	// SIGN-OUT goes through cleanup() (registerPreSignOut), which is the full wipe.
	suspendPolling(): void {
		this.pollingSuspended = true;
		// Bump the route-away generation so any poll callback ALREADY awaiting getAiStatus
		// (its interval is cleared below, but an in-flight callback cannot be cancelled) is
		// neutralized on resolution: its handle's captured suspendGeneration no longer matches,
		// so isPollContextCurrent returns false and the terminal branch never touches the
		// now-disposed editor. A route-away bumps neither projectId nor teardownGeneration, so
		// this is the ONLY guard that catches that callback. resumePolling does not bump it,
		// so the fresh handles it arms capture the current value and pass.
		this.suspendGeneration++;
		for (const [, handle] of this.pendingJobs) {
			clearInterval(handle.interval);
		}
		this.pendingJobs.clear();
	}

	// Resume tier (next WorkspaceShell mount). Clears the suspended flag and re-arms a
	// poll for every still-running row of the CURRENTLY OPEN project, reusing the generic
	// batch poll helper (which is concurrency-count-neutral and conditionally touches the
	// freshly-mounted editor). Rows for OTHER projects stay dormant: cancelPollsForProject
	// already drops a switched-away project's rows, and isPollContextCurrent would discard
	// any cross-project tick anyway. Deferred marker updates that were queued before suspend
	// are preserved across the gap and flush as their re-armed polls resolve.
	resumePolling(editor: any): void {
		this.pollingSuspended = false;
		this.rememberEditor(editor);
		const openProjectId = projectStore.project?.projectId;
		if (!openProjectId) return;
		for (const job of this.queue) {
			if (job.projectId !== openProjectId) continue;
			if (job.status !== "processing" && job.status !== "pending") continue;
			// Already re-armed (e.g. a continuation that resolved post-resume) — skip.
			if (this.pendingJobs.has(job.id)) continue;
			const remoteJobId = job.remoteJobId;
			// No backend job id yet (submit still in flight) → nothing to poll; its own
			// continuation will start the poll once it resolves (no longer suspended).
			if (!remoteJobId) continue;
			this.pollBatchJob(job.id, remoteJobId, editor, job.markerId, job.pageIndex);
		}
	}

	// Full session teardown: sign-out. Unlike cancelPollsForProject (per-switch, narrowly
	// scoped to ONE outgoing project) and suspendPolling (route-away, keeps the queue),
	// cleanup() wipes ALL session-scoped state so the NEXT signed-in user never sees the
	// previous session's rows. The queue is the privacy-sensitive one — BatchPanel renders
	// it verbatim (prompts, thumbnails, project ids, costs) with no current-project or
	// current-user filter — so leaving it populated would show another account's jobs
	// (and as permanent phantom "active" rows, since every poller is now gone).
	cleanup(): void {
		// Bump the teardown generation FIRST so any submit/retry still awaiting its
		// backend round-trip (no PollHandle to cancel yet) sees a mismatch in its
		// post-await guard and bails — even if the user signs back into the SAME
		// project id (which the projectId guard alone would let through).
		this.teardownGeneration++;
		for (const [, handle] of this.pendingJobs) {
			clearInterval(handle.interval);
		}
		this.pendingJobs.clear();
		this.pendingMarkerUpdates.clear();
		// Drop EVERY job row + all per-job/session-scoped tracking. The backend owns
		// each job's persisted result; signing back in (and reopening a project)
		// reloads markers from the server, so nothing recoverable is lost here.
		this.queue = [];
		this.inFlightSingleGen.clear();
		this.lastDiscardedRows.clear();
		// Drop the cached editor. Sign-out tears the editor down via its OWN destroy()
		// (which already hides every indicator), so indicator cleanup here is optional —
		// but the disposed reference must not linger into the next session. (cancelPolls-
		// ForProject is the per-switch indicator cleanup; cleanup() is the full wipe.)
		this.lastKnownEditor = null;
		// Sign-out is a full reset that supersedes any prior route-away suspension; clear
		// the flag so the next signed-in session's first poll-start is not silently dropped.
		this.pollingSuspended = false;
		// Every live poll is gone (sign-out / shell unmount), so no terminal branch
		// will run to decrement this — reset it directly to avoid a stale count
		// wedging the concurrency cap when the user signs back in.
		this.processingCount = 0;
		// Reset the surfaced UI activity flags so the status bar / generate state don't
		// carry the previous session's "generating" indication into the next mount.
		this.isGenerating = false;
		this.aiStatus = "";
	}

	__resetForTesting(): void {
		this.cleanup();
		this.aiTier = "sfx-pro";
		this.aiQuality = DEFAULT_AI_QUALITY;
		this.sfxToggle = true;
		this.isGenerating = false;
		this.queue = [];
		this.maxConcurrent = SFX_PRO_CONCURRENT_JOB_LIMIT;
		this.processingCount = 0;
		this.inFlightSingleGen.clear();
	}
}

export const aiJobsStore = new AiJobsStore();
