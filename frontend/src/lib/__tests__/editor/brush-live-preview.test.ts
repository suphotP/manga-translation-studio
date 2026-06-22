// P1 UX — live painting feedback during a stroke.
//
// Spot-healing and clone-stamp accumulate their work OFF-SCREEN and only
// composite it onto the page on pointer-up, so the drag used to show nothing but
// the brush ring (the tool read as dead). These tests assert that BOTH tools add a
// live stroke-preview overlay to the canvas DURING the move (before pointer-up),
// and remove it once the stroke commits — i.e. the user gets real-time feedback.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { createHealingBrushTool } from "$lib/editor/tools/healing-brush-tool.ts";
import { readSourceImageData } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";
import type { PixelRegion } from "$lib/editor/tools/raster.ts";

vi.mock("$lib/editor/tools/opencv-loader.ts", () => ({
	loadOpenCv: () => Promise.resolve({} as never),
}));
vi.mock("$lib/editor/tools/inpaint.ts", () => ({
	inpaintTelea: (_cv: unknown, src: ImageData) => src,
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

/** A minimal Fabric.Image stand-in so createStrokePreview() builds an overlay. */
class FakeFabricImage {
	left: number;
	top: number;
	opacity: number;
	dirty = false;
	// Backing-canvas size snapshotted at construction (clear() shrinks the real
	// canvas to 0×0, so we capture the original to identify the overlay reliably).
	readonly elementWidth: number;
	readonly elementHeight: number;
	constructor(public element: unknown, opts: Record<string, unknown> = {}) {
		this.left = (opts.left as number) ?? 0;
		this.top = (opts.top as number) ?? 0;
		this.opacity = (opts.opacity as number) ?? 1;
		this.elementWidth = element instanceof HTMLCanvasElement ? element.width : 0;
		this.elementHeight = element instanceof HTMLCanvasElement ? element.height : 0;
	}
	bringToFront() {}
}

/** A minimal Fabric.Circle stand-in (single options arg) for the brush cursor. */
class FakeFabricCircle {
	left: number;
	top: number;
	constructor(opts: Record<string, unknown> = {}) {
		this.left = (opts.left as number) ?? 0;
		this.top = (opts.top as number) ?? 0;
	}
	bringToFront() {}
}

/** Host whose canvas records add/remove so we can observe the preview overlay. */
function makePreviewHost(source: HTMLCanvasElement): {
	host: EditorToolHost;
	added: unknown[];
	removed: unknown[];
	liveObjects: () => unknown[];
	sourceSize: number;
} {
	const added: unknown[] = [];
	const removed: unknown[] = [];
	const canvas = {
		add: (obj: unknown) => added.push(obj),
		remove: (obj: unknown) => removed.push(obj),
		getObjects: () => [],
		requestRenderAll: vi.fn(),
		requestRenderAllBound: vi.fn(),
	};
	const host: EditorToolHost = {
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas,
			fabric: { Image: FakeFabricImage, Circle: FakeFabricCircle },
			sourceElement: source,
		}),
		applyToolPatchInstant: (_patch: ImageData, _region: PixelRegion) => true,
		setToolBusy: vi.fn(),
	};
	// An object is "live" on the canvas if it was added and not (yet) removed.
	const liveObjects = () => added.filter((o) => !removed.includes(o));
	return { host, added, removed, liveObjects, sourceSize: source.width };
}

/**
 * The STROKE PREVIEW overlay is a Fabric image backed by a FULL-PAGE-sized canvas
 * positioned at the page origin — distinct from the clone-stamp SOURCE GHOST, whose
 * backing canvas is a small region around the cursor. Match on the full-page size so
 * the test observes the preview specifically (not the decorative ghost).
 */
function livePreviewOverlays(objs: unknown[], pageSize: number): FakeFabricImage[] {
	return objs.filter(
		(o): o is FakeFabricImage =>
			o instanceof FakeFabricImage
			&& o.elementWidth === pageSize
			&& o.elementHeight === pageSize,
	);
}

describe("live stroke preview (real-time painting feedback)", () => {
	it("Clone Stamp shows a preview overlay DURING the drag, then clears it on commit", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend
		const { host, liveObjects, sourceSize } = makePreviewHost(source);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool());
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Alt+click sets the source anchor (no paint yet).
		registry.handlePointerDown({ scene: { x: 6, y: 6 }, altKey: true });

		// Start painting + move — the preview overlay must exist BEFORE pointer-up.
		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerMove({ scene: { x: 26, y: 26 }, pressed: true });
		// The full-page stroke-preview overlay is live mid-stroke (real-time feedback).
		expect(livePreviewOverlays(liveObjects(), sourceSize).length).toBeGreaterThan(0);

		// Commit — the preview overlay is removed once the real pixels land.
		registry.handlePointerUp({ scene: { x: 26, y: 26 } });
		await registry.waitForCommit();
		expect(livePreviewOverlays(liveObjects(), sourceSize).length).toBe(0);
	});

	it("Spot Healing shows a preview overlay DURING the drag, then clears it on commit", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, liveObjects, sourceSize } = makePreviewHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 4, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerMove({ scene: { x: 25, y: 25 }, pressed: true });
		// The full-page tint overlay is live mid-stroke (real-time feedback).
		expect(livePreviewOverlays(liveObjects(), sourceSize).length).toBeGreaterThan(0);

		registry.handlePointerUp({ scene: { x: 25, y: 25 } });
		await registry.waitForCommit();
		for (let i = 0; i < 12; i++) await Promise.resolve();
		await registry.waitForCommit();

		expect(livePreviewOverlays(liveObjects(), sourceSize).length).toBe(0);
	});
});
