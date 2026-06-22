// P1 wrong-page DATA-CORRUPTION regression (Codex round 3).
//
// The no-freeze branch DEFERS a stroke that arrives while an async paint commit
// is settling and REPLAYS it once the commit clears. But PAGE NAVIGATION did not
// cancel that buffer: the deferred replay microtask could resolve `waitForCommit()`
// and fire its buffered down/move/up AFTER navigation had already advanced to a
// new page — building from the OLD bitmap but persisting against the NEW page
// (wrong-page corruption / blank page).
//
// The fix: page navigation, before it advances the page, must (1) DRAIN the
// in-flight commit AND its replay microtask, then (2) CANCEL the registry's
// deferred buffer so a buffered stroke can NEVER replay onto the new page. The
// registry bumps a `replayEpoch` on cancel, and an in-flight `runDeferredReplay()`
// re-checks it after every await so an already-scheduled replay becomes a no-op.
//
// These tests assert: cancel during a settling commit discards the deferred
// stroke (no replay → no wrong-page paint), and waitForReplayIdle drains a replay
// that has NOT been cancelled (so a same-page stroke still lands).

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

// The registry replay/nav-cancel mechanism is generic over ANY async `onPointerUp`.
// Drive it with a synthetic paint tool that performs an injected async commit
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

async function flushMicrotasks(times = 8): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("nav-during-commit: a deferred stroke must NEVER replay onto a new page (P1)", () => {
	it("cancelDeferredReplay() during a settling commit discards the buffered stroke (no wrong-page replay)", async () => {
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		const host = makeHost(() => {
			const g = deferred<void>();
			gates.push(g);
			return g.promise;
		});
		const registry = new ToolRegistry();
		const tool = makeAsyncPaintTool("async-paint", "blob:pageA");
		registry.register(tool);
		registry.setHost(host);
		registry.activate("async-paint");

		// Stroke 1 on page A — its async commit goes in flight (persistence + reload).
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerUp({ scene: { x: 20, y: 20 } });
		expect(tool.downCount).toBe(1);
		expect(registry.isCommitInFlight).toBe(true);

		// Stroke 2 — arrives WHILE stroke 1 is settling, so it is buffered for replay.
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerMove({ scene: { x: 35, y: 35 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 40, y: 40 } });
		expect(registry.isReplayPending).toBe(true);
		expect(tool.downCount).toBe(1); // not replayed yet

		// NAVIGATE while stroke 1 is still settling: navigation cancels the deferred
		// buffer (this is what performLoadPage does before it advances currentPage).
		registry.cancelDeferredReplay();

		// Now let stroke 1's commit settle. The already-scheduled replay microtask
		// resolves waitForCommit() but, seeing the epoch bumped, becomes a NO-OP.
		gates[0].resolve();
		await flushMicrotasks();

		// The buffered stroke 2 was DISCARDED — it never replayed (downCount still 1)
		// and never committed (only stroke 1's commit ran). It can therefore never
		// land on the new page: no wrong-page corruption.
		expect(tool.downCount).toBe(1);
		expect(host.commits).toEqual(["blob:pageA"]);
		expect(registry.isCommitInFlight).toBe(false);
		expect(registry.isReplayPending).toBe(false);
	});

	it("waitForReplayIdle() drains an UNCANCELLED replay so a same-page stroke still lands (no silent loss)", async () => {
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		const host = makeHost(() => {
			const g = deferred<void>();
			gates.push(g);
			return g.promise;
		});
		const registry = new ToolRegistry();
		const tool = makeAsyncPaintTool("async-paint", "blob:same-page");
		registry.register(tool);
		registry.setHost(host);
		registry.activate("async-paint");

		// Stroke 1 + a deferred stroke 2 (same page, no navigation).
		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		registry.handlePointerUp({ scene: { x: 2, y: 2 } });
		registry.handlePointerDown({ scene: { x: 3, y: 3 } });
		registry.handlePointerUp({ scene: { x: 4, y: 4 } });
		expect(host.commits).toEqual(["blob:same-page"]);

		// Settle stroke 1; stroke 2 replays (it was NOT cancelled).
		gates[0].resolve();
		await flushMicrotasks();
		expect(tool.downCount).toBe(2);
		expect(registry.isCommitInFlight).toBe(true); // stroke 2's commit now in flight

		// waitForReplayIdle resolves only after stroke 2's commit also settles AND no
		// replay remains — so navigation that drains via this is certain nothing is
		// left to replay onto the next page.
		gates[1].resolve();
		await registry.waitForReplayIdle();
		expect(registry.isCommitInFlight).toBe(false);
		expect(registry.isReplayPending).toBe(false);
		expect(host.commits).toEqual(["blob:same-page", "blob:same-page"]); // both landed, in order
	});

	it("a replay scheduled but cancelled before the commit settles never fires its down (epoch guard)", async () => {
		const gate = deferred<void>();
		const host = makeHost(() => gate.promise);
		const registry = new ToolRegistry();
		const tool = makeAsyncPaintTool("async-paint", "blob:x");
		registry.register(tool);
		registry.setHost(host);
		registry.activate("async-paint");

		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		registry.handlePointerUp({ scene: { x: 2, y: 2 } });
		// Defer a stroke, then immediately cancel (navigation) — BEFORE settling. The
		// buffered down is cleared right away (the replay loop may still be winding
		// down its await, which is fine — the epoch guard makes it a no-op).
		registry.handlePointerDown({ scene: { x: 5, y: 5 } });
		registry.cancelDeferredReplay();

		gate.resolve();
		await flushMicrotasks();
		// Only stroke 1 ever ran a down; the cancelled deferred down never replayed,
		// and once the loop unwinds nothing is left pending.
		expect(tool.downCount).toBe(1);
		expect(host.commits).toEqual(["blob:x"]);
		expect(registry.isReplayPending).toBe(false);
	});
});
