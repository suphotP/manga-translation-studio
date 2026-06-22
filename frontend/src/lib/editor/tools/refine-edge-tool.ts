// Tool 6 — Grow / Contract / Feather / Refine Edge.
//
// Unlike the selection/paint tools, this is a "refine" tool: it transforms the
// existing MaskBuffer in place rather than reacting to pointer drags. The dock
// invokes `grow()/contract()/feather()/refineEdge()` from slider controls. The
// pointer handlers are no-ops so it still satisfies the EditorTool contract.

import { applyMorphology, ensureMorphologyBackend, type MorphologyOp } from "./morphology.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import type { EditorTool, ToolContext } from "./types.js";

export interface RefineEdgeApi {
	grow(radius: number): Promise<void>;
	contract(radius: number): Promise<void>;
	feather(radius: number): Promise<void>;
	/** Photoshop-style Refine Edge: contract then feather to soften a tight mask. */
	refineEdge(contractRadius: number, featherRadius: number): Promise<void>;
}

export function createRefineEdgeTool(): EditorTool & RefineEdgeApi {
	let context: ToolContext | null = null;

	async function run(op: MorphologyOp, radius: number) {
		if (!context || context.mask.isEmpty() || radius <= 0) return;
		// Snapshot the active context + its image identity BEFORE awaiting the OpenCV
		// backend load. The morphology backend can take a beat (cold WASM init); during
		// that await the user may switch pages / reload the image / deactivate the tool,
		// which swaps `context` (and resizes the shared mask). If we then mutate
		// `context` blindly we either grow/feather the WRONG page's mask or write into a
		// mask whose dimensions no longer match the snapshot. Re-verify after the await
		// and abort if anything moved. (Mirrors the heal-worker epoch guard in spirit.)
		const ctx = context;
		const expectedWidth = ctx.imageWidth;
		const expectedHeight = ctx.imageHeight;
		const expectedSource = ctx.sourceElement;
		const cv = await ensureMorphologyBackend();
		if (
			context !== ctx ||
			ctx.mask.width !== expectedWidth ||
			ctx.mask.height !== expectedHeight ||
			ctx.sourceElement !== expectedSource
		) {
			return;
		}
		const { mask, imageWidth, imageHeight } = ctx;
		const next = applyMorphology(mask.cloneData(), imageWidth, imageHeight, op, radius, cv ?? undefined);
		mask.setData(next);
		renderSelectionOverlay(ctx, mask);
	}

	const tool: EditorTool & RefineEdgeApi = {
		id: "refine-edge",
		label: "Grow / Contract / Feather",
		icon: "◎",
		shortcut: getEditorShortcutForSuiteTool("refine-edge"),
		kind: "refine",

		activate(ctx) {
			context = ctx;
		},
		deactivate() {
			context = null;
		},
		onPointerDown() {},
		onPointerMove() {},
		onPointerUp() {},

		grow: (radius) => run("grow", radius),
		contract: (radius) => run("contract", radius),
		feather: (radius) => run("feather", radius),
		async refineEdge(contractRadius, featherRadius) {
			await run("contract", contractRadius);
			await run("feather", featherRadius);
		},
	};

	return tool;
}
