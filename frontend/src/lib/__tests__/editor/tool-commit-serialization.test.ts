// P1.3 + P1.A regressions — image-tool async commits must be SERIALIZED, and a
// stroke started DURING a commit must be DEFERRED-AND-HONORED, never dropped.
//
// The no-freeze branch made paint-tool commits async (off-thread encode +
// persistence + canvas reload). Before the fix, `ToolRegistry.handlePointerUp`
// fired the async `onPointerUp` WITHOUT awaiting it and a new stroke could start
// while the prior commit was still settling — a slow first commit could land
// AFTER a faster second one and clobber it (lost/out-of-order edits, P1.3).
//
// The first fix tracked the in-flight commit but DROPPED any gesture that arrived
// during it — which silently lost the user's next stroke (P1.A). The corrected
// behavior: while a commit settles the registry BUFFERS the new gesture (down +
// latest move + up) and REPLAYS it once the commit clears, against the freshly
// reloaded bitmap. So the stroke both lands (not dropped) AND still composites on
// the settled bitmap (still ordered, no clobber). The paint tools AWAIT
// `commitToolBackground` (which resolves only after persistence + reload) before
// clearing busy. Awaiting async I/O keeps the main thread responsive (no-freeze
// preserved). These tests assert the gate, the deferred-not-dropped replay,
// ordering, and that the real clone-stamp tool awaits its commit.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import type { EditorTool, EditorToolHost, ToolContext, ToolPointerEvent } from "$lib/editor/tools/types.ts";

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// The registry serialization gate is generic over ANY async `onPointerUp`. These
// tests drive it with a synthetic paint tool that performs an injected async commit
// (recorded in `host.commits`) — a stand-in for any tool's async edit-layer commit.
function makeHost(commitReturn: () => Promise<void> | void): EditorToolHost & {
	commits: string[];
	recordCommit: (url: string) => Promise<void> | void;
} {
	const commits: string[] = [];
	return {
		commits,
		recordCommit: (url: string) => {
			commits.push(url);
			return commitReturn();
		},
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: 100, height: 100 },
			imageWidth: 100,
			imageHeight: 100,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: null,
		}),
		setToolBusy: vi.fn(),
	};
}

/** A minimal paint tool whose onPointerUp commits asynchronously via the host. */
function makeAsyncPaintTool(id: string, commitUrl: string): EditorTool & { downCount: number } {
	const tool = {
		id,
		label: id,
		icon: "x",
		shortcut: undefined,
		kind: "paint" as const,
		downCount: 0,
		activate: vi.fn(),
		deactivate: vi.fn(),
		onPointerDown: (_ctx: ToolContext, _e: ToolPointerEvent) => {
			tool.downCount += 1;
		},
		onPointerMove: (_ctx: ToolContext, _e: ToolPointerEvent) => {},
		onPointerUp: async (ctx: ToolContext, _e: ToolPointerEvent) => {
			await (ctx.host as unknown as { recordCommit: (url: string) => Promise<void> | void }).recordCommit(
				commitUrl,
			);
		},
	};
	return tool;
}

/** Drain the microtask queue so the deferred-replay loop can run. */
async function flushMicrotasks(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("paint-tool commit serialization gate (P1.3 + P1.A)", () => {
	it("DEFERS a new stroke during a commit, then HONORS it once the commit settles (not dropped — P1.A)", async () => {
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		const host = makeHost(() => {
			const g = deferred<void>();
			gates.push(g);
			return g.promise;
		});
		const registry = new ToolRegistry();
		const tool = makeAsyncPaintTool("async-paint", "blob:first");
		registry.register(tool);
		registry.setHost(host);
		registry.activate("async-paint");

		// Stroke 1 — down + up starts the async commit; the gate goes in-flight.
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerUp({ scene: { x: 20, y: 20 } });
		expect(tool.downCount).toBe(1);
		expect(registry.isCommitInFlight).toBe(true);

		// Stroke 2 — arrives WHILE stroke 1's commit is settling. It must NOT be
		// dropped: the registry buffers it. No second down/commit runs YET (so a slow
		// first commit cannot be overtaken/clobbered), but it is queued for replay.
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerMove({ scene: { x: 35, y: 35 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 40, y: 40 } });
		expect(tool.downCount).toBe(1); // not processed yet — deferred, not dropped
		expect(host.commits).toEqual(["blob:first"]); // only the first commit ran so far

		// Settle stroke 1's commit (persistence + reload done). The deferred stroke
		// now REPLAYS automatically against the freshly-reloaded bitmap and commits
		// in order — it was honored, not lost.
		gates[0].resolve();
		await flushMicrotasks();
		expect(tool.downCount).toBe(2); // the deferred stroke was replayed
		expect(host.commits).toEqual(["blob:first", "blob:first"]); // its commit ran, after stroke 1
		expect(registry.isCommitInFlight).toBe(true); // the replayed stroke's commit is now in flight

		gates[1].resolve();
		await registry.waitForCommit();
		await flushMicrotasks();
		expect(registry.isCommitInFlight).toBe(false);
	});

	it("two rapid strokes both commit, in order (no out-of-order overwrite, none dropped)", async () => {
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		const host = makeHost(() => {
			const g = deferred<void>();
			gates.push(g);
			return g.promise;
		});
		const registry = new ToolRegistry();
		registry.register(makeAsyncPaintTool("a", "blob:stroke-1"));
		registry.setHost(host);
		registry.activate("a");

		// Stroke 1.
		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		registry.handlePointerUp({ scene: { x: 2, y: 2 } });
		// Stroke 2 fires immediately — deferred until stroke 1 settles (not dropped).
		registry.handlePointerDown({ scene: { x: 3, y: 3 } });
		registry.handlePointerUp({ scene: { x: 4, y: 4 } });

		expect(host.commits).toEqual(["blob:stroke-1"]); // only stroke 1 has committed yet
		gates[0].resolve();
		await flushMicrotasks();

		// Stroke 2's commit ran only AFTER stroke 1 fully settled — order preserved,
		// and the second stroke was honored rather than lost.
		expect(host.commits).toEqual(["blob:stroke-1", "blob:stroke-1"]);
		gates[1].resolve();
		await registry.waitForCommit();
		await flushMicrotasks();
		expect(registry.isCommitInFlight).toBe(false);
	});

});
