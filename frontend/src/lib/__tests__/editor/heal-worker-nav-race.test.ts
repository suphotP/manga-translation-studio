// PR #264 worker-race regression — a heal stroke whose Telea solve now runs in a
// Web Worker must NEVER composite its result onto the WRONG page if the user
// navigates / the editor is torn down WHILE the worker is solving.
//
// The reopened bug (PR #264): the heal tool does `await inpaintRegion()` (worker)
// and only AFTER calls `applyToolPatchInstant()`. During the solve the stroke is
// in the registry's `commitInFlight` but NOT yet in the editor's
// `pendingBrushCommits`, so the OLD `hasPendingBrushCommit()` (size-only) said
// "nothing pending" and page nav / teardown advanced the page mid-solve. When the
// worker returned, the late ROI composited onto the NEW page (wrong-page / data
// loss), or was applied after teardown.
//
// The fix has two parts, both asserted here:
//   (1) GATE: while the worker solve is in flight the registry reports
//       `isCommitInFlight === true`, which the editor's `hasPendingBrushCommit()`
//       now reflects (via `onIsImageToolCommitInFlight`), so every wait-before-nav
//       path blocks on the solve.
//   (2) EPOCH GUARD: the heal tool snapshots `host.getImageEpoch()` BEFORE awaiting
//       the worker and passes it to `applyToolPatchInstant(patch, region, epoch)`.
//       If the page switched / image reloaded / editor was destroyed meanwhile, the
//       epoch advanced and the host DISCARDS the patch (returns false) — the ROI is
//       never written to the now-current page.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createHealingBrushTool } from "$lib/editor/tools/healing-brush-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

// Control the worker solve timing: inpaintRegion resolves only when we call
// solveGate.resolve(), so we can drive a page switch WHILE the solve is "in flight"
// deterministically. resolve() echoes the ROI back as the "healed" result.
let solveGate: { resolve: () => void } | null = null;
vi.mock("$lib/editor/tools/inpaint-worker-client.ts", () => ({
	inpaintRegion: (roi: ImageData) =>
		new Promise<ImageData>((res) => {
			solveGate = { resolve: () => res(roi) };
		}),
}));

function makeSourceCanvas(size = 48): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#777";
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = "#111";
		ctx.fillRect(20, 20, 6, 6);
	}
	return c;
}

/**
 * Host that models the editor's instant-apply + epoch behaviour: it carries a
 * mutable `epoch` (bumped by `bumpEpoch()` to simulate a page switch / reload /
 * destroy) and `applyToolPatchInstant` discards a patch whose `expectedEpoch` is
 * stale — exactly the real editor's guard.
 */
function makeEpochHost(source: HTMLCanvasElement): EditorToolHost & {
	patches: Array<{ region: PixelRegion; epoch: number }>;
	epoch: number;
	bumpEpoch: () => void;
} {
	const patches: Array<{ region: PixelRegion; epoch: number }> = [];
	const host = {
		patches,
		epoch: 0,
		bumpEpoch() {
			host.epoch += 1;
		},
		getImageEpoch: () => host.epoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: source,
		}),
		applyToolPatchInstant: (_patch: ImageData, region: PixelRegion, expectedEpoch?: number) => {
			// Mirror the editor: a stale epoch means the page changed during the solve.
			if (expectedEpoch !== undefined && expectedEpoch !== host.epoch) return false;
			patches.push({ region, epoch: host.epoch });
			return true;
		},
		setToolBusy: vi.fn(),
	};
	return host;
}

async function flushMicrotasks(times = 16): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("heal worker race: a solve in flight gates nav and an epoch change discards the ROI (PR #264)", () => {
	it("keeps isCommitInFlight true WHILE the worker solves (so hasPendingBrushCommit blocks nav)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend
		const host = makeEpochHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 4, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		// Release a heal stroke — the worker solve is now in flight (gate not resolved).
		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerUp({ scene: { x: 23, y: 23 } });
		await flushMicrotasks();

		// The registry tracks the heal as an in-flight commit: this is what
		// `onIsImageToolCommitInFlight` surfaces so the editor's hasPendingBrushCommit()
		// returns true and goToPage/destroy/export/save WAIT for the solve.
		expect(registry.isCommitInFlight).toBe(true);
		expect(host.patches.length).toBe(0); // nothing composited yet

		// Finish the solve; the ROI now composites onto the SAME (unchanged) page.
		solveGate!.resolve();
		await flushMicrotasks();
		await registry.waitForCommit();
		expect(host.patches.length).toBe(1);
		expect(host.patches[0].epoch).toBe(0); // applied to the page it was drawn on
		expect(registry.isCommitInFlight).toBe(false);
	});

	it("DISCARDS the worker result when the page switches mid-solve (no wrong-page composite)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeEpochHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 4, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		// Release a heal stroke on page A; the worker solve goes in flight.
		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerUp({ scene: { x: 23, y: 23 } });
		await flushMicrotasks();
		expect(registry.isCommitInFlight).toBe(true);

		// NAVIGATE while the solve is in flight: the page reloads → epoch advances.
		// (In the real editor this is resetBackgroundEditState() inside loadImage.)
		host.bumpEpoch();

		// The worker now returns. The heal tool captured the OLD epoch before awaiting;
		// applyToolPatchInstant sees the epoch changed and DISCARDS the ROI.
		solveGate!.resolve();
		await flushMicrotasks();
		await registry.waitForCommit();

		// Nothing was composited — the late ROI did NOT land on the new page.
		expect(host.patches.length).toBe(0);
		expect(registry.isCommitInFlight).toBe(false);
	});

	it("DISCARDS the worker result when the editor is destroyed mid-solve (teardown safety)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeEpochHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 4, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerUp({ scene: { x: 23, y: 23 } });
		await flushMicrotasks();
		expect(registry.isCommitInFlight).toBe(true);

		// Teardown (destroy() → resetBackgroundEditState()) bumps the epoch too.
		host.bumpEpoch();
		solveGate!.resolve();
		await flushMicrotasks();
		await registry.waitForCommit();

		expect(host.patches.length).toBe(0);
	});
});
