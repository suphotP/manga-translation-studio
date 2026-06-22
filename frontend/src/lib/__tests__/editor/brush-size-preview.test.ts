// Rec #5 — heal/clone brush-size live preview (`[`/`]` resize).
//
// `setRadius` updates the tool's option AND redraws the size cursor at the last
// hovered point, and the registry forwards `setActiveToolRadius` to the active
// paint tool only. These are the wiring guarantees the `[`/`]` shortcuts rely on.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createHealingBrushTool } from "$lib/editor/tools/healing-brush-tool.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { createMarqueeTool } from "$lib/editor/tools/marquee-tool.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

/** A Fabric-ish canvas double that records add/remove of overlay objects. */
function makeFakeCanvas() {
	const objects: any[] = [];
	return {
		objects,
		add: (o: any) => objects.push(o),
		remove: (o: any) => {
			const i = objects.indexOf(o);
			if (i >= 0) objects.splice(i, 1);
		},
		getObjects: () => objects,
		requestRenderAll: vi.fn(),
	};
}

/** Minimal Fabric module exposing Circle + Image constructors. */
function makeFabric() {
	return {
		Circle: class {
			radius: number;
			constructor(opts: any) {
				Object.assign(this, opts);
				this.radius = opts.radius;
			}
		},
		Image: class {
			constructor(_src: any, opts: any) {
				Object.assign(this, opts);
			}
		},
	};
}

function makeHost(canvas: any, fabric: any, size = 64): EditorToolHost {
	const source = document.createElement("canvas");
	source.width = size;
	source.height = size;
	return {
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: size, height: size },
			imageWidth: size,
			imageHeight: size,
			canvas,
			fabric,
			sourceElement: source,
		}),
		applyToolPatchInstant: () => true,
		setToolBusy: vi.fn(),
	};
}

describe("healing brush setRadius (rec #5 live preview)", () => {
	it("updates the option and redraws the cursor at the last hover point", () => {
		const canvas = makeFakeCanvas();
		const fabric = makeFabric();
		const registry = new ToolRegistry();
		const heal = createHealingBrushTool({ radius: 16 });
		registry.register(heal);
		registry.setHost(makeHost(canvas, fabric));
		registry.activate("healing-brush");

		// Hover to establish the cursor + last point.
		registry.handlePointerMove({ scene: { x: 20, y: 20 }, pressed: false });
		const before = canvas.objects.length;
		expect(before).toBeGreaterThan(0);

		// Resize via the registry forwarder.
		registry.setActiveToolRadius(40);
		expect(heal.options.radius).toBe(40);
		// The cursor circle reflects the new radius (last overlay is the ring).
		const ring = canvas.objects[canvas.objects.length - 1] as any;
		expect(ring.radius).toBe(40); // square image bounds → scene radius == image radius
	});
});

describe("clone stamp setRadius (rec #5 live preview)", () => {
	it("updates the option and keeps a cursor on the canvas", () => {
		const canvas = makeFakeCanvas();
		const fabric = makeFabric();
		const registry = new ToolRegistry();
		const clone = createCloneStampTool({ radius: 18 });
		registry.register(clone);
		registry.setHost(makeHost(canvas, fabric));
		registry.activate("clone-stamp");

		registry.handlePointerMove({ scene: { x: 30, y: 30 }, pressed: false });
		registry.setActiveToolRadius(8);
		expect(clone.options.radius).toBe(8);
		expect(canvas.objects.length).toBeGreaterThan(0);
	});
});

describe("setActiveToolRadius is a no-op for selection tools", () => {
	it("does not throw and changes nothing for marquee (no setRadius)", () => {
		const canvas = makeFakeCanvas();
		const fabric = makeFabric();
		const registry = new ToolRegistry();
		registry.register(createMarqueeTool());
		registry.setHost(makeHost(canvas, fabric));
		registry.activate("marquee");
		expect(() => registry.setActiveToolRadius(50)).not.toThrow();
	});
});
