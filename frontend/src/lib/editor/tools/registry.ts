// Image-edit suite v1 (W3.13) — central ToolRegistry.
//
// Owns the 8 client-side cleaning tools, the shared MaskBuffer, and the active
// tool's lifecycle. W3.1's left dock consumes `list()` to render buttons and
// calls `activate(id)` / `handlePointer*` / `handleKeyboard`. Tools never touch
// the MangaEditor directly — only the narrow `EditorToolHost`.
//
// The registry is responsible for converting incoming SCENE-space pointer
// coordinates into IMAGE-space before handing them to tools, by rebuilding the
// ToolContext from the host's live image context on every gesture (the user can
// zoom/pan/swap pages between events).

import { MaskBuffer, maskBuffer as sharedMask } from "./mask-buffer.js";
import { buildToolContext } from "./types.js";
import { removeSelectionOverlay, renderSelectionOverlay } from "./selection-overlay.js";
import {
	createDefaultEditorKeymap,
	getDefaultEditorCommandBinding,
} from "../../editor-tools/keymap.js";
import type {
	EditorTool,
	EditorToolHost,
	ScenePoint,
	ToolContext,
	ToolPointerEvent,
} from "./types.js";

import { createMarqueeTool } from "./marquee-tool.js";
import { createLassoTool } from "./lasso-tool.js";
import { createPolygonLassoTool } from "./polygon-lasso-tool.js";
import { createMagicWandTool } from "./magic-wand-tool.js";
import { createColorRangeTool } from "./color-range-tool.js";
import { createRefineEdgeTool } from "./refine-edge-tool.js";
import { createHealingBrushTool } from "./healing-brush-tool.js";
import { createCloneStampTool } from "./clone-stamp-tool.js";
import { createBubbleCleanTool } from "./bubble-clean-tool.js";
import { createScreentoneFillTool } from "./screentone-fill-tool.js";
import { createMagicSelectTool } from "./magic-select-tool.js";
import { createProCleanTool } from "./pro-clean-tool.js";
import { createBucketFillTool } from "./bucket-fill-tool.js";
import { createAdjustmentsTool } from "./adjustments-tool.js";

export interface RegistryPointerInput {
	/** Scene-space coordinate (Fabric world units, after viewport transform). */
	scene: ScenePoint;
	pressed?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}

export type ActiveToolListener = (toolId: string | null) => void;

interface KeyboardShortcutModifiers {
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	code?: string;
	repeat?: boolean;
	target?: EventTarget | null;
}

const EDITOR_KEYMAP_CONTEXT = ["editor"] as const;
const IMAGE_TOOL_KEYMAP = createDefaultEditorKeymap();

export class ToolRegistry {
	private readonly tools = new Map<string, EditorTool>();
	private readonly order: string[] = [];
	private host: EditorToolHost | null = null;
	private activeId: string | null = null;
	private activeContext: ToolContext | null = null;
	private readonly listeners = new Set<ActiveToolListener>();
	// Identity of the page image the current mask belongs to. When the host swaps
	// pages (even to one with identical pixel dimensions) we must drop the stale
	// selection, otherwise add/subtract + `respectSelection` healing composite
	// against the previous page's mask.
	private maskSource: CanvasImageSource | null = null;
	private maskSourceInit = false;
	// Pointer-move coalescing: vigorous strokes fire many `mousemove` events per
	// frame, each of which can run per-pixel paint work (clone stamp) + an overlay
	// re-render. Processing all of them on the JS thread is what made the page
	// freeze. We keep only the LATEST move and process it once per animation frame
	// (`requestAnimationFrame`), so per-frame cost is bounded regardless of how
	// fast the user drags. down/up are never coalesced (they must run promptly and
	// flush any pending move first).
	private pendingMove: RegistryPointerInput | null = null;
	private moveRaf: number | null = null;
	// Serialization gate for async paint-tool commits (clone stamp / healing).
	// `onPointerUp` of those tools runs an off-thread encode + persistence +
	// canvas reload; that whole pipeline must settle before another stroke starts,
	// otherwise a slow first commit can land AFTER a faster second one and clobber
	// it (P1.3 data-loss). While a commit is in flight, a new gesture is NOT
	// dropped (that silently lost the user's next stroke — P1.A). Instead we DEFER
	// it: buffer the down + latest move + up, await the in-flight commit, then
	// replay the stroke against the freshly-reloaded page bitmap so it both lands
	// (no silent no-op) and still composites on the settled bitmap (no out-of-order
	// overwrite). The busy badge stays visible during the wait.
	private commitInFlight: Promise<void> | null = null;
	// A gesture that arrived while a commit was settling, captured for replay once
	// the commit clears. We hold the initial down, the LATEST buffered move (move
	// events coalesce — only the most recent matters to resume the stroke), and the
	// up (presence flips `released` true). `replayScheduled` guards against
	// scheduling more than one replay for the same deferred gesture.
	private deferredDown: RegistryPointerInput | null = null;
	private deferredMove: RegistryPointerInput | null = null;
	private deferredUp: RegistryPointerInput | null = null;
	private deferredReleased = false;
	private replayScheduled = false;
	// Monotonic epoch bumped whenever the deferred buffer is cancelled (explicit
	// page switch / tool switch). An in-flight `runDeferredReplay()` microtask
	// captures the epoch it started with and, after every `await`, re-checks it —
	// so a replay that was scheduled against the OLD page becomes a no-op the
	// instant navigation cancels it (the P1 wrong-page corruption fix). Without
	// this, the replay could resolve `waitForCommit()` and fire its buffered
	// down/move/up AFTER `currentPage` already advanced, painting the new page
	// with the old stroke.
	private replayEpoch = 0;

	constructor(public readonly mask: MaskBuffer = sharedMask) {}

	/** True while an async paint-tool commit (persistence + reload) is settling. */
	get isCommitInFlight(): boolean {
		return this.commitInFlight !== null;
	}

	/** Await the in-flight paint-tool commit, if any (test/host serialization). */
	async waitForCommit(): Promise<void> {
		while (this.commitInFlight) {
			const pending = this.commitInFlight;
			await pending;
			if (this.commitInFlight === pending) break;
		}
	}

	/** True while a deferred gesture is buffered or its replay loop is running. */
	get isReplayPending(): boolean {
		return this.replayScheduled || this.deferredDown !== null;
	}

	/**
	 * P1 fix — cancel any buffered/in-flight deferred-replay so a stroke captured
	 * while a commit was settling can NEVER replay onto a different page.
	 *
	 * Page navigation MUST call this (before it mutates `currentPage` / loads the
	 * new page). It both clears the deferred buffer AND bumps `replayEpoch`, so an
	 * already-scheduled `runDeferredReplay()` microtask — which may have already
	 * resolved `waitForCommit()` and be about to fire its buffered down/move/up —
	 * sees the epoch change after its next `await` and bails out as a no-op. The
	 * gesture (drawn on the OLD page) is discarded; discarding a half-buffered
	 * stroke on an explicit page switch is acceptable (the user moved away).
	 */
	cancelDeferredReplay(): void {
		this.replayEpoch++;
		this.deferredDown = null;
		this.deferredMove = null;
		this.deferredUp = null;
		this.deferredReleased = false;
	}

	/**
	 * P1 fix — abandon an IN-PROGRESS pointer gesture (a stroke whose pointerDown has
	 * fired but whose pointerUp has not) WITHOUT committing it, so page navigation /
	 * image reload can never deliver the pending move/up against — or commit the
	 * accumulated stroke onto — the NEW page. Page navigation MUST call this BEFORE
	 * it swaps `currentPage` / loads the new image.
	 *
	 * Unlike {@link cancelDeferredReplay} (which drops a stroke buffered while a
	 * commit settles), this targets the LIVE active tool: we drop any queued/throttled
	 * move and then deactivate + re-activate the active tool against its current
	 * context. A paint tool's `deactivate()` resets its per-stroke accumulators
	 * (clone `reset()`, healing `painting=false`/`healMask=null`) so the half-painted
	 * buffer is discarded rather than composited on release. The same tool stays
	 * active (re-activated) so the user can immediately stroke on the new page.
	 *
	 * Also clears the deferred buffer for completeness (mid-commit gestures are
	 * abandoned on an explicit nav too). Selection tools have no destructive buffer,
	 * so the reset is harmless for them.
	 */
	cancelActiveGesture(): void {
		// Drop any throttled/queued move so it can't fire against the next page.
		if (this.moveRaf !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(this.moveRaf);
		}
		this.moveRaf = null;
		this.pendingMove = null;
		this.cancelDeferredReplay();
		const id = this.activeId;
		if (!id) return;
		const tool = this.tools.get(id);
		if (!tool) return;
		// Reset the tool's in-progress stroke state by tearing it down + bringing it
		// back, against the CURRENT (old-page) context — never the new one. deactivate
		// discards the destructive accumulators without committing them.
		const ctx = this.activeContext ?? this.buildContext();
		if (ctx) tool.deactivate(ctx);
		const fresh = this.buildContext();
		this.activeContext = fresh;
		if (fresh) tool.activate(fresh);
	}

	/**
	 * Resolve once no deferred replay is pending AND no commit is in flight, so a
	 * caller (page navigation) can be certain stroke 1 finished persisting to the
	 * OLD page and no buffered stroke will replay onto the NEW one. Awaits the
	 * registry replay microtask too — `waitForCommit()` alone clears when the
	 * editor's busy promise clears, which can be BEFORE the replay runs.
	 */
	async waitForReplayIdle(): Promise<void> {
		// Bounded: each pass either makes progress (a commit/replay settles) or the
		// guards below short-circuit. The replay loop clears `replayScheduled` in its
		// own `finally`, and cancelDeferredReplay() (if called) empties the buffer.
		for (let guard = 0; guard < 1000; guard++) {
			await this.waitForCommit();
			if (!this.replayScheduled && !this.deferredDown) return;
			// Yield so an in-flight runDeferredReplay() loop can advance.
			await Promise.resolve();
		}
	}

	register(tool: EditorTool): this {
		if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
		this.tools.set(tool.id, tool);
		this.order.push(tool.id);
		return this;
	}

	get(id: string): EditorTool | undefined {
		return this.tools.get(id);
	}

	list(): EditorTool[] {
		return this.order.map((id) => this.tools.get(id)!);
	}

	get activeToolId(): string | null {
		return this.activeId;
	}

	get activeTool(): EditorTool | null {
		return this.activeId ? (this.tools.get(this.activeId) ?? null) : null;
	}

	setHost(host: EditorToolHost): void {
		this.host = host;
	}

	onActiveToolChange(listener: ActiveToolListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Build a fresh ToolContext from the host's live image context, syncing the
	 * MaskBuffer to the current image dimensions. Returns null when no page image
	 * is loaded (tools simply do nothing).
	 */
	private buildContext(): ToolContext | null {
		if (!this.host) return null;
		const imgCtx = this.host.getImageSpaceContext();
		if (!imgCtx) return null;
		const ctx = buildToolContext(this.host, this.mask, imgCtx);
		const dimsChanged =
			this.mask.width !== imgCtx.imageWidth || this.mask.height !== imgCtx.imageHeight;
		const pageChanged = this.maskSourceInit && imgCtx.sourceElement !== this.maskSource;
		if (dimsChanged) {
			// resize() reallocates (and zeroes) the buffer.
			this.mask.resize(imgCtx.imageWidth, imgCtx.imageHeight);
			removeSelectionOverlay(ctx);
		} else if (pageChanged && !this.mask.isEmpty()) {
			// Same dimensions, different page → keep the buffer but drop the stale
			// selection so it can't leak into the new page's tools.
			this.mask.clear();
			removeSelectionOverlay(ctx);
		}
		this.maskSource = imgCtx.sourceElement;
		this.maskSourceInit = true;
		return ctx;
	}

	/**
	 * Build the same guarded context used by pointer tools for controls that are
	 * driven from UI sliders instead of pointer gestures. This keeps page-change
	 * mask cleanup centralized in the registry.
	 */
	buildCurrentContext(): ToolContext | null {
		const ctx = this.buildContext();
		if (ctx) this.activeContext = ctx;
		return ctx;
	}

	/** Activate a tool by id. Deactivates the previous tool first. */
	activate(id: string): boolean {
		const tool = this.tools.get(id);
		if (!tool) return false;
		if (this.activeId === id) return true;
		this.deactivateActive();
		const ctx = this.buildContext();
		this.activeId = id;
		this.activeContext = ctx;
		if (ctx) tool.activate(ctx);
		this.emitActive();
		return true;
	}

	deactivateActive(): void {
		if (!this.activeId) return;
		// Drop any queued move so it can't fire against the next tool / page.
		if (this.moveRaf !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(this.moveRaf);
		}
		this.moveRaf = null;
		this.pendingMove = null;
		// Drop any deferred (mid-commit) gesture too — replaying it after a tool/page
		// switch would paint the wrong tool against the wrong bitmap. cancelDeferredReplay()
		// also bumps the replay epoch so an already-scheduled replay microtask that has
		// passed its `waitForCommit()` becomes a no-op (not just the deferredDown check).
		this.cancelDeferredReplay();
		const tool = this.tools.get(this.activeId);
		const ctx = this.activeContext ?? this.buildContext();
		if (tool && ctx) tool.deactivate(ctx);
		this.activeId = null;
		this.activeContext = null;
		this.emitActive();
	}

	private emitActive(): void {
		for (const l of this.listeners) l(this.activeId);
	}

	private toEvent(ctx: ToolContext, input: RegistryPointerInput, pressed: boolean): ToolPointerEvent {
		return {
			scene: input.scene,
			image: ctx.sceneToImage(input.scene),
			pressed,
			shiftKey: !!input.shiftKey,
			altKey: !!input.altKey,
			ctrlKey: !!input.ctrlKey,
			metaKey: !!input.metaKey,
		};
	}

	handlePointerDown(input: RegistryPointerInput): void {
		this.flushPendingMove();
		// Serialize against an in-flight async commit: a new stroke must not start
		// (and read the page source) until the prior commit's persistence + canvas
		// reload have settled, or the prior commit could land out of order and lose
		// this stroke. Rather than DROPPING this down (which silently lost the user's
		// stroke — P1.A), DEFER it: capture the gesture and replay it once the commit
		// settles, against the freshly-reloaded bitmap. The busy badge stays visible.
		if (this.commitInFlight) {
			this.deferGestureDown(input);
			return;
		}
		const tool = this.activeTool;
		if (!tool) return;
		const ctx = this.buildContext();
		if (!ctx) return;
		this.activeContext = ctx;
		tool.onPointerDown(ctx, this.toEvent(ctx, input, true));
	}

	handlePointerMove(input: RegistryPointerInput): void {
		if (!this.activeTool) return;
		// While a commit settles, buffer the LATEST move of a deferred gesture so it
		// replays after the commit (don't drop — that lost the stroke shape; P1.A).
		if (this.commitInFlight) {
			if (this.deferredDown && !this.deferredReleased) this.deferredMove = input;
			return;
		}
		// Leading-edge + trailing-edge throttle. If no frame is in flight, process
		// this move immediately (so a single move is reflected synchronously and the
		// stroke feels instant), then open a frame window. Any further moves that
		// arrive during that window are coalesced into `pendingMove` and only the
		// LAST one is processed when the frame fires. This bounds per-frame tool
		// work (per-pixel clone paint, overlay re-render) to at most two events per
		// frame no matter how fast the user drags — the fix for the freeze.
		if (this.moveRaf === null && typeof requestAnimationFrame === "function") {
			this.processMove(input);
			this.pendingMove = null;
			this.moveRaf = requestAnimationFrame(() => {
				this.moveRaf = null;
				this.flushPendingMove();
			});
			return;
		}
		if (typeof requestAnimationFrame !== "function") {
			// Headless / no rAF (tests, SSR): process synchronously.
			this.processMove(input);
			return;
		}
		// A frame is already in flight — keep only the latest move.
		this.pendingMove = input;
	}

	/** Process the most recent coalesced move immediately (if any). */
	private flushPendingMove(): void {
		if (this.moveRaf !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(this.moveRaf);
		}
		this.moveRaf = null;
		const input = this.pendingMove;
		this.pendingMove = null;
		if (!input) return;
		this.processMove(input);
	}

	private processMove(input: RegistryPointerInput): void {
		const tool = this.activeTool;
		if (!tool) return;
		const ctx = this.activeContext ?? this.buildContext();
		if (!ctx) return;
		tool.onPointerMove(ctx, this.toEvent(ctx, input, !!input.pressed));
	}

	handlePointerUp(input: RegistryPointerInput): void {
		this.flushPendingMove();
		// If a commit is settling, this up closes a DEFERRED gesture: record it so the
		// replay (after the commit) ends the stroke cleanly. Don't drop it (P1.A).
		if (this.commitInFlight) {
			if (this.deferredDown) {
				this.deferredUp = input;
				this.deferredReleased = true;
			}
			return;
		}
		const tool = this.activeTool;
		if (!tool) return;
		const ctx = this.activeContext ?? this.buildContext();
		if (!ctx) return;
		// Paint tools commit asynchronously (off-thread encode + persistence +
		// canvas reload). Track that work as the in-flight commit so the gate blocks
		// new strokes until it settles, then clear it. Awaiting only async I/O keeps
		// the main thread responsive (no-freeze preserved; busy badge stays up).
		const result = tool.onPointerUp(ctx, this.toEvent(ctx, input, false));
		if (result && typeof (result as Promise<void>).then === "function") {
			// Assign the gate BEFORE attaching the settle handler so a microtask that
			// resolves the finally can't clear a not-yet-assigned slot.
			let commit: Promise<void>;
			commit = (result as Promise<void>)
				.catch((error) => {
					console.error("[ToolRegistry] paint-tool commit failed:", error);
				})
				.finally(() => {
					if (this.commitInFlight === commit) this.commitInFlight = null;
				});
			this.commitInFlight = commit;
		}
	}

	/**
	 * Capture a pointer-down that arrived while a commit is settling, and schedule a
	 * one-shot replay for when the commit clears. A fresh down supersedes any prior
	 * buffered gesture (the user started a new stroke) — clear the old move/up so the
	 * replay reflects only the latest gesture. The replay reads the page source
	 * AFTER the commit's reload, so the stroke both lands (no silent drop, P1.A) and
	 * composites on the settled bitmap (no out-of-order overwrite, P1.3).
	 */
	private deferGestureDown(input: RegistryPointerInput): void {
		this.deferredDown = input;
		this.deferredMove = null;
		this.deferredUp = null;
		this.deferredReleased = false;
		this.scheduleDeferredReplay();
	}

	private scheduleDeferredReplay(): void {
		if (this.replayScheduled) return;
		this.replayScheduled = true;
		void this.runDeferredReplay();
	}

	/**
	 * Await the in-flight commit, then replay the buffered gesture against the
	 * freshly-reloaded bitmap. Loops so a gesture deferred again during the replay's
	 * own commit is honored too (rapid successive strokes all land, in order).
	 */
	private async runDeferredReplay(): Promise<void> {
		// The epoch this replay loop is valid for. cancelDeferredReplay() bumps the
		// epoch (on page/tool switch); if it changes across any await below, the
		// buffered gesture belongs to a page we have navigated away from, so we must
		// NOT replay it (P1 wrong-page corruption). Re-checked after every await.
		const epoch = this.replayEpoch;
		try {
			// Loop until there is nothing left to replay. Each pass waits for the
			// current commit to settle, then replays whatever gesture is buffered.
			// New gestures deferred mid-pass set deferredDown again and keep us looping.
			for (;;) {
				await this.waitForCommit();
				// A cancel (page/tool switch) may have landed while we awaited the
				// commit — abandon the stale gesture rather than paint the wrong page.
				if (this.replayEpoch !== epoch) return;
				const down = this.deferredDown;
				if (!down) return;
				// Snapshot + clear the buffer so a gesture deferred during this replay's
				// commit starts a fresh capture (and we don't replay it twice).
				const move = this.deferredMove;
				const up = this.deferredUp;
				const released = this.deferredReleased;
				this.deferredDown = null;
				this.deferredMove = null;
				this.deferredUp = null;
				this.deferredReleased = false;

				// Replay through the normal handlers so the commit gate, context rebuild
				// (fresh bitmap), and move coalescing all apply exactly as for a live
				// stroke. handlePointerDown only proceeds now that commitInFlight is
				// clear; if the gate re-armed (shouldn't here) it would re-defer safely.
				this.handlePointerDown(down);
				if (move) this.handlePointerMove(move);
				if (released) this.handlePointerUp(up ?? down);
				// If the replayed up started a new async commit, loop to await it before
				// replaying any further-deferred gesture (preserves ordering). If nothing
				// new was deferred and no commit is in flight, the next waitForCommit
				// resolves immediately and the deferredDown check exits the loop.
				if (!this.commitInFlight && !this.deferredDown) return;
			}
		} finally {
			this.replayScheduled = false;
		}
	}

	/**
	 * Photoshop-mirror keyboard activation. Returns true if a shortcut matched so
	 * the caller can `preventDefault`. Ignores typing into inputs (caller should
	 * still guard, but we double-check single-key + no meta/ctrl).
	 */
	handleKeyboard(key: string, mod: KeyboardShortcutModifiers = {}): boolean {
		const actionId = IMAGE_TOOL_KEYMAP.resolve(
			keyboardEventLike(key, mod),
			EDITOR_KEYMAP_CONTEXT,
		);
		const suiteToolId = actionId
			? getDefaultEditorCommandBinding(actionId)?.suiteToolId
			: undefined;
		if (!suiteToolId || !this.tools.has(suiteToolId)) return false;
		return this.activate(suiteToolId);
	}

	/**
	 * Live-set the active paint tool's brush radius (rec #5: `[`/`]` resize). No-op
	 * for tools without a `setRadius` (selection tools). Rebuilds the ToolContext so
	 * the cursor preview redraws against the current viewport (zoom/pan may differ).
	 */
	setActiveToolRadius(radius: number): void {
		const tool = this.activeTool as (EditorTool & { setRadius?: (ctx: ToolContext, r: number) => void }) | null;
		if (!tool?.setRadius) return;
		const ctx = this.activeContext ?? this.buildContext();
		if (!ctx) return;
		this.activeContext = ctx;
		tool.setRadius(ctx, radius);
	}

	/**
	 * P1 fix — re-anchor the translucent selection overlay to the CURRENT image
	 * bounds. `renderSelectionOverlay()` bakes `ctx.imageBounds` (left/top + scale)
	 * into the Fabric image at render time, so after the editor recenters / fits /
	 * resizes (which remaps imageBounds without touching the image-space mask) the
	 * visible overlay drifts off the actual selection. The editor calls this after
	 * any recenter/fit/resize so the overlay re-renders against the new bounds. The
	 * mask of record (image-space MaskBuffer) is unchanged — only its scene-space
	 * projection is refreshed. No-op when the selection is empty.
	 */
	refreshSelectionOverlay(): void {
		if (this.mask.isEmpty()) return;
		const ctx = this.buildContext();
		if (!ctx) return;
		this.activeContext = ctx;
		renderSelectionOverlay(ctx, this.mask);
	}

	/** Clear the active selection mask + overlay. */
	clearSelection(): void {
		this.mask.clear();
		// Emptying the MaskBuffer alone leaves the translucent Fabric overlay on
		// the canvas; remove it so the user no longer sees a selection that the
		// paint tools already treat as empty.
		const ctx = this.activeContext ?? this.buildContext();
		if (ctx) {
			removeSelectionOverlay(ctx);
			ctx.requestRender();
		}
	}
}

function keyboardEventLike(key: string, mod: KeyboardShortcutModifiers): KeyboardEvent {
	return {
		type: "keydown",
		key,
		code: mod.code ?? inferPhysicalLetterCode(key),
		ctrlKey: mod.ctrlKey ?? false,
		metaKey: mod.metaKey ?? false,
		altKey: mod.altKey ?? false,
		shiftKey: mod.shiftKey ?? false,
		repeat: mod.repeat ?? false,
		target: mod.target ?? null,
	} as KeyboardEvent;
}

function inferPhysicalLetterCode(key: string): string {
	return /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "";
}

/**
 * Build the canonical registry with all 9 tools registered in dock order.
 * Returns the registry plus typed references to the tools that expose extra
 * APIs (sliders, refine actions) so W3.1's dock can wire controls.
 */
export function createImageEditSuite(host?: EditorToolHost) {
	const registry = new ToolRegistry();

	const marquee = createMarqueeTool();
	const lasso = createLassoTool();
	const polygonLasso = createPolygonLassoTool();
	const magicWand = createMagicWandTool();
	const colorRange = createColorRangeTool();
	const refineEdge = createRefineEdgeTool();
	const healingBrush = createHealingBrushTool();
	const cloneStamp = createCloneStampTool();
	const bubbleClean = createBubbleCleanTool();
	const screentoneFill = createScreentoneFillTool();
	const magicClean = createMagicSelectTool();
	const proClean = createProCleanTool();
	const bucketFill = createBucketFillTool();
	const adjustments = createAdjustmentsTool();

	registry
		.register(marquee)
		.register(lasso)
		.register(polygonLasso)
		.register(magicWand)
		.register(colorRange)
		.register(refineEdge)
		.register(healingBrush)
		.register(cloneStamp)
		.register(bubbleClean)
		.register(screentoneFill)
		// Manga-clean wave: every id the dock exposes MUST resolve to a live
		// suite tool, or activating it silently leaves the previous tool
		// receiving strokes under the wrong label (codex P1).
		.register(magicClean)
		.register(proClean)
		.register(bucketFill)
		.register(adjustments);

	if (host) registry.setHost(host);

	return {
		registry,
		tools: { marquee, lasso, polygonLasso, magicWand, colorRange, refineEdge, healingBrush, cloneStamp, bubbleClean, screentoneFill, magicClean, proClean, bucketFill, adjustments },
	};
}

export type ImageEditSuite = ReturnType<typeof createImageEditSuite>;
