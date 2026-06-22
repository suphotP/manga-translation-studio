// W3.13 — registry integration smoke: activate a tool through the full registry
// (host → scene→image conversion → MaskBuffer write) and confirm a selection is
// produced. Runs headless via jsdom + node-canvas; no dev server required.

import { describe, it, expect, vi } from "vitest";
import { createImageEditSuite } from "$lib/editor/tools/registry.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

/**
 * Stub Fabric canvas that records added objects so preview shapes don't crash.
 */
function makeFabricStub() {
	const objects: any[] = [];
	const canvas = {
		add: (o: any) => objects.push(o),
		remove: (o: any) => {
			const i = objects.indexOf(o);
			if (i >= 0) objects.splice(i, 1);
		},
		getObjects: () => objects,
		bringObjectToFront: vi.fn(),
		requestRenderAll: vi.fn(),
	};
	const fabric = {
		Rect: class {
			props: any;
			constructor(props: any) {
				this.props = props;
			}
			set(p: any) {
				Object.assign(this.props, p);
			}
		},
		// FabricImage stub for the selection overlay.
		FabricImage: class {
			props: any;
			constructor(_el: any, props: any) {
				this.props = props;
			}
			set(p: any) {
				Object.assign(this.props, p);
			}
		},
	};
	return { canvas, fabric, objects };
}

function makeHost(fabricStub: ReturnType<typeof makeFabricStub>): EditorToolHost {
	return {
		// 100x100 image occupying scene rect (0,0)-(100,100): 1:1 scale.
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: 100, height: 100 },
			imageWidth: 100,
			imageHeight: 100,
			canvas: fabricStub.canvas,
			fabric: fabricStub.fabric,
			sourceElement: null,
		}),
	};
}

describe("ToolRegistry integration smoke", () => {
	it("activates the Marquee tool and drags out a selection into the MaskBuffer", () => {
		const fabricStub = makeFabricStub();
		const host = makeHost(fabricStub);
		const { registry } = createImageEditSuite(host);

		// Photoshop M shortcut activates the marquee.
		expect(registry.handleKeyboard("m")).toBe(true);
		expect(registry.activeToolId).toBe("marquee");
		expect(registry.mask.isEmpty()).toBe(true);

		// Drag a rectangle from scene (20,20) to (60,50) => image-space 40x30.
		registry.handlePointerDown({ scene: { x: 20, y: 20 } });
		registry.handlePointerMove({ scene: { x: 60, y: 50 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 60, y: 50 } });

		expect(registry.mask.isEmpty()).toBe(false);
		expect(registry.mask.countSelected()).toBe(40 * 30);
		const bounds = registry.mask.getBounds();
		expect(bounds.minX).toBe(20);
		expect(bounds.minY).toBe(20);
		expect(bounds.maxX).toBe(59);
		expect(bounds.maxY).toBe(49);

		// A preview rect was added then cleared, and a selection overlay image was drawn.
		const hasOverlay = fabricStub.objects.some((o) => o instanceof fabricStub.fabric.FabricImage);
		expect(hasOverlay).toBe(true);
	});

	it("switching tools deactivates the previous one and clears its preview", () => {
		const fabricStub = makeFabricStub();
		const host = makeHost(fabricStub);
		const { registry } = createImageEditSuite(host);

		registry.activate("marquee");
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerMove({ scene: { x: 30, y: 30 }, pressed: true });
		// Mid-drag preview rect should exist.
		expect(fabricStub.objects.some((o) => o instanceof fabricStub.fabric.Rect)).toBe(true);

		// Switch to magic wand; deactivate must remove the dangling preview rect.
		registry.activate("magic-wand");
		expect(registry.activeToolId).toBe("magic-wand");
		expect(fabricStub.objects.some((o) => o instanceof fabricStub.fabric.Rect)).toBe(false);
	});

	it("clearSelection empties the active mask", () => {
		const fabricStub = makeFabricStub();
		const { registry } = createImageEditSuite(makeHost(fabricStub));
		registry.activate("marquee");
		registry.handlePointerDown({ scene: { x: 0, y: 0 } });
		registry.handlePointerUp({ scene: { x: 50, y: 50 } });
		expect(registry.mask.isEmpty()).toBe(false);
		registry.clearSelection();
		expect(registry.mask.isEmpty()).toBe(true);
	});

	// P1a regression — deactivating a selection tool only clears its transient
	// preview, NOT the committed mask/overlay. editorStore.clearImageTool() must
	// additionally call clearSelection() so leaving the suite for a non-image
	// engine tool wipes both the mask AND the translucent on-canvas overlay.
	it("deactivateActive leaves the committed mask + overlay live; clearSelection wipes both", () => {
		const fabricStub = makeFabricStub();
		const { registry } = createImageEditSuite(makeHost(fabricStub));

		registry.activate("marquee");
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerUp({ scene: { x: 60, y: 60 } });
		expect(registry.mask.isEmpty()).toBe(false);
		const overlayPresent = () =>
			fabricStub.objects.some((o) => o instanceof fabricStub.fabric.FabricImage);
		expect(overlayPresent()).toBe(true);

		// deactivateActive() (what clearImageTool used to do alone) does NOT drop
		// the committed selection: mask stays live and the overlay stays painted.
		registry.deactivateActive();
		expect(registry.mask.isEmpty()).toBe(false);
		expect(overlayPresent()).toBe(true);

		// The fix: clearSelection() empties the mask AND removes the overlay object.
		registry.clearSelection();
		expect(registry.mask.isEmpty()).toBe(true);
		expect(overlayPresent()).toBe(false);
	});

	// P1b regression — the shared MaskBuffer is a process-wide singleton, so a
	// committed selection must be wiped on editor destroy (which calls
	// clearSelection) or a same-dimension re-init silently inherits it. Two
	// independently-built suites share the default singleton mask: clearing one
	// must leave the other empty too.
	it("clearing the shared singleton mask is observable across suites (destroy leak guard)", () => {
		const fabricA = makeFabricStub();
		const suiteA = createImageEditSuite(makeHost(fabricA));
		suiteA.registry.activate("marquee");
		suiteA.registry.handlePointerDown({ scene: { x: 0, y: 0 } });
		suiteA.registry.handlePointerUp({ scene: { x: 80, y: 80 } });
		expect(suiteA.registry.mask.isEmpty()).toBe(false);

		// destroy() deactivates then clearSelection()s before dropping the suite.
		suiteA.registry.deactivateActive();
		suiteA.registry.clearSelection();

		// A fresh suite (same default singleton mask) starts with an empty
		// selection — no stale mask leaks into the next editor session.
		const fabricB = makeFabricStub();
		const suiteB = createImageEditSuite(makeHost(fabricB));
		expect(suiteB.registry.mask).toBe(suiteA.registry.mask);
		expect(suiteB.registry.mask.isEmpty()).toBe(true);
	});
});
