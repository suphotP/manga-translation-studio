// W3.13 — ToolRegistry unit tests (lifecycle, shortcuts, scene→image routing).

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, createImageEditSuite } from "$lib/editor/tools/registry.ts";
import type { EditorTool, EditorToolHost, ToolContext, ToolPointerEvent } from "$lib/editor/tools/types.ts";

/** Minimal host: 100x100 image occupying scene rect (10,20)-(60,70) => 5x image scale. */
function makeHost(): EditorToolHost {
	return {
		getImageSpaceContext: () => ({
			imageBounds: { left: 10, top: 20, width: 50, height: 50 },
			imageWidth: 100,
			imageHeight: 100,
			canvas: { requestRenderAll: vi.fn(), add: vi.fn(), remove: vi.fn(), getObjects: () => [] },
			fabric: {},
			sourceElement: null,
		}),
	};
}

function spyTool(id: string, shortcut?: string): EditorTool & { events: ToolPointerEvent[] } {
	const events: ToolPointerEvent[] = [];
	return {
		id,
		label: id,
		icon: "x",
		shortcut,
		kind: "selection",
		events,
		activate: vi.fn(),
		deactivate: vi.fn(),
		onPointerDown: (_ctx: ToolContext, e: ToolPointerEvent) => { events.push(e); },
		onPointerMove: (_ctx: ToolContext, e: ToolPointerEvent) => { events.push(e); },
		onPointerUp: (_ctx: ToolContext, e: ToolPointerEvent) => { events.push(e); },
	};
}

describe("ToolRegistry", () => {
	it("registers tools in order and lists them", () => {
		const r = new ToolRegistry();
		r.register(spyTool("a")).register(spyTool("b"));
		expect(r.list().map((t) => t.id)).toEqual(["a", "b"]);
		expect(r.get("b")?.id).toBe("b");
	});

	it("rejects duplicate ids", () => {
		const r = new ToolRegistry();
		r.register(spyTool("a"));
		expect(() => r.register(spyTool("a"))).toThrow();
	});

	it("activates/deactivates tools and notifies listeners", () => {
		const r = new ToolRegistry();
		const a = spyTool("a");
		const b = spyTool("b");
		r.register(a).register(b);
		r.setHost(makeHost());
		const seen: (string | null)[] = [];
		r.onActiveToolChange((id) => seen.push(id));

		r.activate("a");
		expect(r.activeToolId).toBe("a");
		expect(a.activate).toHaveBeenCalled();

		r.activate("b");
		expect(a.deactivate).toHaveBeenCalled();
		expect(b.activate).toHaveBeenCalled();
		// Switching emits the intermediate null (deactivate) then the new tool.
		expect(seen).toEqual(["a", null, "b"]);
	});

	it("resizes the shared mask to the host image dimensions on activate", () => {
		const r = new ToolRegistry();
		r.register(spyTool("a"));
		r.setHost(makeHost());
		r.activate("a");
		expect(r.mask.width).toBe(100);
		expect(r.mask.height).toBe(100);
	});

	it("converts scene-space pointers to image-space before dispatch", () => {
		const r = new ToolRegistry();
		const a = spyTool("a");
		r.register(a);
		r.setHost(makeHost());
		r.activate("a");
		// Scene point at the image's top-left bound (10,20) => image (0,0).
		r.handlePointerDown({ scene: { x: 10, y: 20 } });
		// Scene point at bounds center (35,45) => image (50,50) given 5x scale.
		r.handlePointerUp({ scene: { x: 35, y: 45 } });
		expect(a.events[0].image).toEqual({ x: 0, y: 0 });
		expect(a.events[1].image).toEqual({ x: 50, y: 50 });
	});

	it("matches keyboard shortcuts and ignores modified keys", () => {
		const r = new ToolRegistry();
		r.register(spyTool("marquee", "m")).register(spyTool("magic-wand", "w"));
		r.setHost(makeHost());
		expect(r.handleKeyboard("M")).toBe(true);
		expect(r.activeToolId).toBe("marquee");
		expect(r.handleKeyboard("w")).toBe(true);
		expect(r.activeToolId).toBe("magic-wand");
		expect(r.handleKeyboard("m", { ctrlKey: true })).toBe(false);
		expect(r.handleKeyboard("z")).toBe(false);
	});

	it("resolves fill-family shortcuts through the keymap, not registration order", () => {
		const r = new ToolRegistry();
		r.register(spyTool("screentone-fill", "Shift+G")).register(spyTool("bucket-fill", "G"));
		r.setHost(makeHost());

		expect(r.handleKeyboard("g")).toBe(true);
		expect(r.activeToolId).toBe("bucket-fill");
		expect(r.handleKeyboard("G", { shiftKey: true })).toBe(true);
		expect(r.activeToolId).toBe("screentone-fill");
	});

	it("no-ops pointer dispatch when no tool is active or no image", () => {
		const r = new ToolRegistry();
		const a = spyTool("a");
		r.register(a);
		// No host => no context.
		expect(() => r.handlePointerDown({ scene: { x: 0, y: 0 } })).not.toThrow();
		expect(a.events.length).toBe(0);
	});
});

describe("createImageEditSuite", () => {
	it("registers all image-edit tools with the expected ids + shortcuts", () => {
		const { registry, tools } = createImageEditSuite(makeHost());
		const ids = registry.list().map((t) => t.id);
		expect(ids).toEqual([
			"marquee",
			"lasso",
			"polygon-lasso",
			"magic-wand",
			"color-range",
			"refine-edge",
			"healing-brush",
			"clone-stamp",
			"bubble-clean",
			"screentone-fill",
			"magic-clean",
			"pro-clean",
			"bucket-fill",
			"adjustments",
		]);
		expect(tools.marquee.shortcut).toBe("m");
		expect(tools.lasso.shortcut).toBe("l");
		expect(tools.magicWand.shortcut).toBe("w");
		expect(tools.healingBrush.shortcut).toBe("j");
		expect(tools.cloneStamp.shortcut).toBe("s");
		expect(tools.bubbleClean.shortcut).toBe("K");
		expect(tools.screentoneFill.shortcut).toBe("Shift+G");
		expect(tools.proClean.shortcut).toBe("Shift+B");
		expect(tools.polygonLasso.shortcut).toBe("Shift+L");
		expect(tools.colorRange.shortcut).toBe("Shift+W");
		expect(tools.refineEdge.shortcut).toBe("Shift+R");
		expect(tools.magicClean.shortcut).toBe("Shift+K");
		expect(tools.bucketFill.shortcut).toBe("G");
	});
});
