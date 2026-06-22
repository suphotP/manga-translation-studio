// Stroke-preview overlay — leak baseline + render behavior.
//
// The live-paint preview overlay must (a) register a Fabric image on the canvas so
// the stroke shows in real time, and (b) on clear() both REMOVE that overlay AND
// shrink its backing <canvas> to 0×0 so the pixel buffer is freed immediately
// (object/canvas count returns to baseline — the P1 OOM-leak guarantee, applied at
// the overlay level). Repeated create→clear cycles must not accumulate live objects.

import { describe, it, expect, vi } from "vitest";
import { createStrokePreview } from "$lib/editor/tools/stroke-preview.ts";
import { buildToolContext } from "$lib/editor/tools/types.ts";
import { MaskBuffer } from "$lib/editor/tools/mask-buffer.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

class FakeFabricImage {
	dirty = false;
	constructor(public element: unknown, public opts: Record<string, unknown> = {}) {}
	bringToFront() {}
}

function makeCtx() {
	const live: unknown[] = [];
	const canvas = {
		add: (o: unknown) => live.push(o),
		remove: (o: unknown) => {
			const i = live.indexOf(o);
			if (i >= 0) live.splice(i, 1);
		},
		requestRenderAll: vi.fn(),
	};
	const host = {} as EditorToolHost;
	const ctx = buildToolContext(host, new MaskBuffer(), {
		imageBounds: { left: 0, top: 0, width: 32, height: 32 },
		imageWidth: 32,
		imageHeight: 32,
		canvas,
		fabric: { Image: FakeFabricImage },
		sourceElement: null,
	});
	return { ctx, live };
}

describe("stroke preview overlay (leak baseline)", () => {
	it("adds an overlay on create, then removes it AND frees the backing canvas on clear", () => {
		const { ctx, live } = makeCtx();
		const baseline = live.length;

		const preview = createStrokePreview(ctx, { fillStyle: "rgba(255,0,0,0.5)", opacity: 0.5 });
		preview.stamp({ x: 8, y: 8 }, 4, null);
		expect(live.length).toBe(baseline + 1);
		const overlay = live[live.length - 1] as FakeFabricImage;
		const backing = overlay.element as HTMLCanvasElement;
		expect(backing.width).toBe(32);
		expect(backing.height).toBe(32);

		preview.clear();
		// Overlay removed from the canvas...
		expect(live.length).toBe(baseline);
		// ...and its pixel buffer freed (0×0), not left pinned for GC.
		expect(backing.width).toBe(0);
		expect(backing.height).toBe(0);
	});

	it("returns to baseline object count after N create→clear cycles (no accumulation)", () => {
		const { ctx, live } = makeCtx();
		const baseline = live.length;
		for (let i = 0; i < 25; i++) {
			const preview = createStrokePreview(ctx, { fillStyle: "rgba(0,0,0,0)", opacity: 1 });
			preview.stamp({ x: i % 32, y: i % 32 }, 3, null);
			preview.clear();
		}
		// Every overlay was disposed — no leaked live objects after repeated strokes.
		expect(live.length).toBe(baseline);
	});

	it("clear() is idempotent and post-clear stamps are no-ops (no resurrection)", () => {
		const { ctx, live } = makeCtx();
		const baseline = live.length;
		const preview = createStrokePreview(ctx, { fillStyle: "#fff" });
		preview.stamp({ x: 4, y: 4 }, 2, null);
		preview.clear();
		preview.clear(); // second clear must not throw / double-remove
		preview.stamp({ x: 6, y: 6 }, 2, null); // must not re-add an overlay
		expect(live.length).toBe(baseline);
	});
});
