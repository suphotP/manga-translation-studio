import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BUILTIN_TOOLS,
	dockToolIdForEngineTool,
	toolRegistry,
	type ToolActivationContext,
	type ToolDefinition,
} from "$lib/editor/tool-registry.svelte.ts";
import { ADJUSTMENTS_TOOL_ID } from "$lib/editor/tools/adjustments-tool.ts";

function activationContext(): ToolActivationContext {
	return {
		setEngineTool: vi.fn(),
		setRightPanelMode: vi.fn(),
		startTextPlacement: vi.fn(),
		activateImageTool: vi.fn(),
	};
}

const IMAGE_EDIT_TOOL_IDS = [
	"marquee",
	"lasso",
	"polygon-lasso",
	"magic-wand",
	"magic-clean",
	"color-range",
	"bucket-fill",
	"refine-edge",
	"healing-brush",
	"pro-clean",
	"clone-stamp",
	"bubble-clean",
	ADJUSTMENTS_TOOL_ID,
	"screentone-fill",
] as const;

describe("toolRegistry", () => {
	beforeEach(() => {
		toolRegistry.__resetToBuiltins();
	});

	it("ships the built-in dock tools sorted by group then order", () => {
		const ids = toolRegistry.list().map((tool) => tool.id);
		// navigate (select) → edit (crop, text) → image (the W3.13 suite +
		// the manga-clean wave: magic-clean, bucket-fill, pro-clean,
		// adjustments controls, screentone-fill) → ai (cover).
		expect(ids).toEqual([
			"select",
			"crop",
			"translate",
			"text",
			"marquee",
			"lasso",
			"polygon-lasso",
			"magic-wand",
			"magic-clean",
			"color-range",
			"bucket-fill",
			"refine-edge",
			"healing-brush",
			"pro-clean",
			"clone-stamp",
			"bubble-clean",
			ADJUSTMENTS_TOOL_ID,
			"screentone-fill",
			"cover",
		]);
	});

	it("registers all W3.13 image-edit suite tools in the dock", () => {
		for (const id of IMAGE_EDIT_TOOL_IDS) {
			const def = toolRegistry.get(id);
			expect(def, `image tool ${id} must be registered`).toBeTruthy();
			expect(def?.group).toBe("image");
			expect(def?.engineTool).toBe("select");
			expect(def?.optionsContext).toBe("image-tools");
		}
	});

	it("routes image-tool activation through the engine-safe activateImageTool callback", () => {
		const marquee = BUILTIN_TOOLS.find((tool) => tool.id === "marquee")!;
		const ctx = activationContext();
		marquee.onActivate?.(ctx);
		expect(ctx.activateImageTool).toHaveBeenCalledWith("marquee");
		// Image tools never drive the engine tool directly.
		expect(ctx.setEngineTool).not.toHaveBeenCalled();
	});

	it("routes adjustments activation to the image-tool suite and opens the image-tools options context", () => {
		const adjustments = BUILTIN_TOOLS.find((tool) => tool.id === ADJUSTMENTS_TOOL_ID)!;
		const ctx = activationContext();

		expect(adjustments.label).toBe("ปรับแสงสี");
		expect(adjustments.optionsContext).toBe("image-tools");
		adjustments.onActivate?.(ctx);

		expect(ctx.activateImageTool).toHaveBeenCalledWith(ADJUSTMENTS_TOOL_ID);
		expect(ctx.setEngineTool).not.toHaveBeenCalled();
	});

	it("groups tools for dock rendering and drops empty groups", () => {
		const grouped = toolRegistry.grouped();
		expect(grouped.map((bucket) => bucket.group)).toEqual(["navigate", "edit", "image", "ai"]);
		expect(grouped.find((bucket) => bucket.group === "edit")?.tools.map((t) => t.id)).toEqual([
			"crop",
			"translate",
			"text",
		]);
		expect(grouped.find((bucket) => bucket.group === "image")?.tools.map((t) => t.id)).toEqual([
			...IMAGE_EDIT_TOOL_IDS,
		]);
	});

	it("relocates the crop ratio picker via the crop options context", () => {
		expect(toolRegistry.optionsContextFor("crop")).toBe("crop");
		expect(toolRegistry.optionsContextFor("select")).toBe("select");
		expect(toolRegistry.optionsContextFor(ADJUSTMENTS_TOOL_ID)).toBe("image-tools");
		expect(toolRegistry.optionsContextFor("cover")).toBe("ai");
		expect(toolRegistry.optionsContextFor(null)).toBe("none");
	});

	it("maps crop + AI both onto the shared cover engine tool", () => {
		expect(toolRegistry.get("crop")?.engineTool).toBe("cover");
		expect(toolRegistry.get("cover")?.engineTool).toBe("cover");
	});

	it("disambiguates the shared cover engine tool back to a dock id", () => {
		expect(dockToolIdForEngineTool("cover")).toBe("cover");
		expect(dockToolIdForEngineTool("cover", "crop")).toBe("crop");
		expect(dockToolIdForEngineTool("select")).toBe("select");
		expect(dockToolIdForEngineTool("brush")).toBe("brush");
		expect(dockToolIdForEngineTool("text")).toBe("text");
	});

	it("keeps an active image-edit tool highlighted over the shared select engine tool", () => {
		// Image tools run on the "select" engine tool; the live image-tool id wins.
		expect(dockToolIdForEngineTool("select", undefined, "magic-wand")).toBe("magic-wand");
		expect(dockToolIdForEngineTool("select", undefined, null)).toBe("select");
	});

	it("lets later waves register and unregister tools without touching the shell", () => {
		const before = toolRegistry.list().length;
		const def: ToolDefinition = {
			id: "transform",
			label: "ย้าย",
			title: "ย้าย / ปรับขนาด",
			icon: "✥",
			engineTool: "select",
			optionsContext: "select",
			group: "image",
			order: 5,
		};
		const unregister = toolRegistry.register(def);
		expect(toolRegistry.get("transform")).toBeTruthy();
		expect(toolRegistry.list().length).toBe(before + 1);

		unregister();
		expect(toolRegistry.get("transform")).toBeUndefined();
		expect(toolRegistry.list().length).toBe(before);
	});

	it("delegates activation through the engine-safe context (no direct engine import)", () => {
		const crop = BUILTIN_TOOLS.find((tool) => tool.id === "crop")!;
		const ctx = activationContext();
		crop.onActivate?.(ctx);
		expect(ctx.setEngineTool).toHaveBeenCalledWith("cover");
	});

	// Regression guard for the dock keyboard shortcut hints. Runtime dispatch is
	// resolved by the editor keymap; the dock badge must stay in lockstep with the
	// same binding, including shifted family variants.
	it("maps each dock keyboard shortcut to exactly one tool", () => {
		const expected: Record<string, string> = {
			V: "select",
			C: "crop",
			T: "text",
			"Shift+B": "pro-clean",
			M: "marquee",
			L: "lasso",
			"Shift+L": "polygon-lasso",
			W: "magic-wand",
			"Shift+W": "color-range",
			J: "healing-brush",
			S: "clone-stamp",
			G: "bucket-fill",
			"Shift+G": "screentone-fill",
			K: "bubble-clean",
			"Shift+K": "magic-clean",
			"Shift+R": "refine-edge",
			A: "cover",
		};
		for (const [key, id] of Object.entries(expected)) {
			const matches = toolRegistry
				.list()
				.filter((tool) => tool.shortcut?.toLowerCase() === key.toLowerCase());
			expect(matches.map((tool) => tool.id), `shortcut ${key}`).toEqual([id]);
		}
	});

	it("resolves dock shortcuts case-insensitively the way activateToolShortcut does", () => {
		const resolve = (key: string) =>
			toolRegistry.list().find((tool) => tool.shortcut?.toLowerCase() === key.toLowerCase())?.id;
		expect(resolve("m")).toBe("marquee");
		expect(resolve("M")).toBe("marquee");
		expect(resolve("shift+g")).toBe("screentone-fill");
		expect(resolve("a")).toBe("cover");
		// Page-next letter "d" is intentionally NOT a dock shortcut so it stays
		// available for page navigation.
		expect(resolve("d")).toBeUndefined();
	});
});
