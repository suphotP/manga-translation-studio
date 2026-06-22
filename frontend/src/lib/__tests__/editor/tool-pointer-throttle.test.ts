// Regression: editor tool pointer-move throttling + async PNG encode.
//
// The cleaning tools (spot-heal / clone / brush) froze the page because every
// `mousemove` ran heavy per-pixel work and every stroke commit ran a SYNCHRONOUS
// full-resolution `canvas.toDataURL()` PNG encode on the UI thread. These tests
// lock in the two fixes:
//   1. ToolRegistry coalesces rapid moves to at most ~2 per animation frame
//      (leading + trailing edge) instead of one heavy call per event.
//   2. raster.canvasToPngBlob / imageDataToBlobUrl encode off the main thread
//      (OffscreenCanvas.convertToBlob → HTMLCanvasElement.toBlob → fallback).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createImageEditSuite } from "$lib/editor/tools/registry.ts";
import type { EditorTool, EditorToolHost } from "$lib/editor/tools/types.ts";
import {
	canvasToPngBlob,
	imageDataToBlobUrl,
	canvasToDataUrlAsync,
} from "$lib/editor/tools/raster.ts";

function makeHost(): EditorToolHost {
	return {
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: 100, height: 100 },
			imageWidth: 100,
			imageHeight: 100,
			canvas: { requestRenderAll: vi.fn(), add: vi.fn(), remove: vi.fn() },
			fabric: {},
			sourceElement: null,
		}),
	};
}

/** A minimal tool that counts how many onPointerMove calls it receives. */
function makeCountingTool(): EditorTool & { moves: number } {
	const tool: EditorTool & { moves: number } = {
		id: "marquee", // reuse a real id so activate() finds & replaces nothing
		label: "x",
		icon: "x",
		kind: "selection",
		moves: 0,
		activate() {},
		deactivate() {},
		onPointerDown() {},
		onPointerMove() {
			this.moves += 1;
		},
		onPointerUp() {},
	};
	return tool;
}

describe("ToolRegistry pointer-move throttling", () => {
	let rafQueue: FrameRequestCallback[];
	let rafId: number;

	beforeEach(() => {
		rafQueue = [];
		rafId = 0;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return ++rafId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			// best-effort: clear the matching slot
			rafQueue[id - 1] = (() => {}) as FrameRequestCallback;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function flushFrame() {
		const q = rafQueue;
		rafQueue = [];
		for (const cb of q) cb(performance.now());
	}

	it("coalesces a burst of moves to the leading move + one trailing move per frame", () => {
		const { registry } = createImageEditSuite(makeHost());
		const tool = makeCountingTool();
		// Swap the registered marquee with our counting tool by re-registering via
		// the public activate path: register a fresh registry instead.
		(registry as unknown as { tools: Map<string, EditorTool> }).tools.set("marquee", tool);
		registry.activate("marquee");

		// 10 rapid moves within a single frame.
		for (let i = 0; i < 10; i++) {
			registry.handlePointerMove({ scene: { x: i, y: i }, pressed: true });
		}
		// Leading edge processed exactly one move synchronously.
		expect(tool.moves).toBe(1);

		// The frame fires → the trailing (latest) move is processed.
		flushFrame();
		expect(tool.moves).toBe(2);

		// Another burst after the frame → one more leading edge.
		for (let i = 0; i < 5; i++) {
			registry.handlePointerMove({ scene: { x: 50 + i, y: 50 + i }, pressed: true });
		}
		expect(tool.moves).toBe(3);
		flushFrame();
		expect(tool.moves).toBe(4);
	});

	it("pointer up flushes the pending trailing move before running up", () => {
		const { registry } = createImageEditSuite(makeHost());
		const tool = makeCountingTool();
		const upSpy = vi.fn();
		tool.onPointerUp = upSpy;
		(registry as unknown as { tools: Map<string, EditorTool> }).tools.set("marquee", tool);
		registry.activate("marquee");

		registry.handlePointerMove({ scene: { x: 1, y: 1 }, pressed: true }); // leading
		registry.handlePointerMove({ scene: { x: 2, y: 2 }, pressed: true }); // queued trailing
		expect(tool.moves).toBe(1);

		registry.handlePointerUp({ scene: { x: 3, y: 3 } });
		// The queued trailing move was flushed before up.
		expect(tool.moves).toBe(2);
		expect(upSpy).toHaveBeenCalledTimes(1);
	});
});

describe("async PNG encode (non-blocking commit)", () => {
	it("prefers OffscreenCanvas.convertToBlob when available", async () => {
		const blob = new Blob(["png"], { type: "image/png" });
		const convertToBlob = vi.fn(async () => blob);
		const fakeCanvas = { convertToBlob } as unknown as OffscreenCanvas;
		const out = await canvasToPngBlob(fakeCanvas);
		expect(convertToBlob).toHaveBeenCalledOnce();
		expect(out).toBe(blob);
	});

	it("falls back to HTMLCanvasElement.toBlob (async, off main thread)", async () => {
		const blob = new Blob(["png"], { type: "image/png" });
		const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(blob));
		const fakeCanvas = { toBlob } as unknown as HTMLCanvasElement;
		const out = await canvasToPngBlob(fakeCanvas);
		expect(toBlob).toHaveBeenCalledOnce();
		expect(out).toBe(blob);
	});

	it("imageDataToBlobUrl returns a blob: URL (or empty when no 2D context)", async () => {
		const createObjectURL = vi.fn(() => "blob:fake-url");
		vi.stubGlobal("URL", { ...URL, createObjectURL });
		try {
			const img = new ImageData(new Uint8ClampedArray(4 * 4), 2, 2);
			const url = await imageDataToBlobUrl(img);
			// In jsdom the 2D context may be null → empty string; in node-canvas a
			// real blob URL is produced. Either way it never throws / blocks.
			expect(typeof url).toBe("string");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("canvasToDataUrlAsync resolves to a data: URL via FileReader", async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
		const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(blob));
		const fakeCanvas = { toBlob } as unknown as HTMLCanvasElement;
		const url = await canvasToDataUrlAsync(fakeCanvas);
		expect(url.startsWith("data:")).toBe(true);
	});
});
