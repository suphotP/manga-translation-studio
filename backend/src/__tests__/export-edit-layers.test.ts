// Phase A — backend Sharp compositor for NON-DESTRUCTIVE bubble-clean edit layers.
//
// An `ImageEditLayer` (fill-mask) stores a tiny alpha-mask ROI + a solid fill + a
// bbox. The export pipeline composites it over the ORIGINAL page background BEFORE
// image/text layers, so the cleaned area appears in the exported image. These tests
// assert the cleaned pixels are painted at the bbox (matching the client + live
// editor), the original page is untouched outside the mask, and a missing mask asset
// is skipped (not fatal) rather than aborting the page.

import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
	compositeEditLayers,
	ExportEditLayerMissingError,
	type ExportEditLayerPlan,
} from "../services/export-edit-layers.js";
import { buildLanguageRenderPlans, resolveExportEditLayers } from "../services/export-pipeline.js";
import type { PageState, ProjectState } from "../types/index.js";

const W = 40;
const H = 40;

/** A solid mid-grey page so the cleaned (white) area is unambiguous. */
async function makePage(): Promise<Buffer> {
	return sharp({
		create: { width: W, height: H, channels: 4, background: { r: 80, g: 80, b: 80, alpha: 1 } },
	}).png().toBuffer();
}

/** A fully-opaque alpha mask of size w×h (alpha = 255 everywhere = full coverage). */
async function makeFullMask(w: number, h: number): Promise<Buffer> {
	return sharp({
		create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
	}).png().toBuffer();
}

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
	const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const o = (y * info.width + x) * info.channels;
	return { r: data[o]!, g: data[o + 1]!, b: data[o + 2]! };
}

describe("compositeEditLayers (Phase A bubble-clean)", () => {
	test("paints the white fill over the mask bbox and leaves the rest of the page untouched", async () => {
		const page = await makePage();
		const maskW = 10;
		const maskH = 10;
		const mask = await makeFullMask(maskW, maskH);
		const bx = 12;
		const by = 14;
		const layer: ExportEditLayerPlan = {
			id: "edit-1",
			maskAssetId: "mask-1",
			fill: { r: 255, g: 255, b: 255, a: 255 },
			bbox: { x: bx, y: by, w: maskW, h: maskH },
			opacity: 1,
			index: 0,
		};

		const result = await compositeEditLayers(page, [layer], async () => mask);
		expect(result.composited).toBe(1);
		expect(result.skipped).toHaveLength(0);

		// INSIDE the bbox → cleaned to white.
		const inside = await pixelAt(result.buffer, bx + 5, by + 5);
		expect(inside.r).toBeGreaterThan(240);
		expect(inside.g).toBeGreaterThan(240);
		expect(inside.b).toBeGreaterThan(240);

		// OUTSIDE the bbox → still the original mid-grey (original page untouched).
		const outside = await pixelAt(result.buffer, 2, 2);
		expect(outside.r).toBeLessThan(120);
		expect(outside.g).toBeLessThan(120);
		expect(outside.b).toBeLessThan(120);
	});

	test("no edit layers → returns the background unchanged", async () => {
		const page = await makePage();
		const result = await compositeEditLayers(page, [], async () => undefined);
		expect(result.composited).toBe(0);
		expect(result.buffer).toBe(page);
	});

	test("P1-c — a missing mask asset FAILS the (durable/publish) export by default", async () => {
		// Default failOnSkipped=true: the export pipeline must NOT silently ship the
		// un-cleaned source for a visible edit layer whose mask is gone — it fails closed.
		const page = await makePage();
		const layer: ExportEditLayerPlan = {
			id: "edit-missing",
			maskAssetId: "gone",
			fill: { r: 255, g: 255, b: 255, a: 255 },
			bbox: { x: 0, y: 0, w: 10, h: 10 },
			index: 0,
		};
		await expect(
			compositeEditLayers(page, [layer], async () => undefined),
		).rejects.toThrow(ExportEditLayerMissingError);
	});

	test("P1-c — a missing mask asset is skipped + reported (not fatal) only in draft/best-effort mode", async () => {
		const page = await makePage();
		const layer: ExportEditLayerPlan = {
			id: "edit-missing",
			maskAssetId: "gone",
			fill: { r: 255, g: 255, b: 255, a: 255 },
			bbox: { x: 0, y: 0, w: 10, h: 10 },
			index: 0,
		};
		const result = await compositeEditLayers(page, [layer], async () => undefined, { failOnSkipped: false });
		expect(result.composited).toBe(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.maskAssetId).toBe("gone");
	});

	test("P1-c — an undecodable mask asset also FAILS the durable export by default", async () => {
		const page = await makePage();
		const layer: ExportEditLayerPlan = {
			id: "edit-bad",
			maskAssetId: "garbage",
			fill: { r: 255, g: 255, b: 255, a: 255 },
			bbox: { x: 0, y: 0, w: 10, h: 10 },
			index: 0,
		};
		// Bytes that are not a decodable image → prepareEditLayerComposite throws inside.
		await expect(
			compositeEditLayers(page, [layer], async () => Buffer.from("not-an-image"), { failOnSkipped: true }),
		).rejects.toThrow(ExportEditLayerMissingError);
	});

	test("resolveExportEditLayers keeps only visible fill-mask layers with a usable bbox", () => {
		const page = {
			imageId: "p1",
			imageName: "p1",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			imageEditLayers: [
				{ id: "a", payload: { type: "fill-mask", maskAssetId: "m-a", maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } }, bbox: { x: 1, y: 2, w: 3, h: 4 }, index: 0, visible: true },
				{ id: "hidden", payload: { type: "fill-mask", maskAssetId: "m-h", maskEncoding: "png-alpha", fill: { r: 0, g: 0, b: 0, a: 255 } }, bbox: { x: 0, y: 0, w: 5, h: 5 }, index: 1, visible: false },
				{ id: "no-mask", payload: { type: "fill-mask", maskEncoding: "png-alpha", fill: { r: 0, g: 0, b: 0, a: 255 } }, bbox: { x: 0, y: 0, w: 5, h: 5 }, index: 2, visible: true },
				{ id: "zero-bbox", payload: { type: "fill-mask", maskAssetId: "m-z", maskEncoding: "png-alpha", fill: { r: 0, g: 0, b: 0, a: 255 } }, bbox: { x: 0, y: 0, w: 0, h: 5 }, index: 3, visible: true },
			],
		} as unknown as PageState;
		const resolved = resolveExportEditLayers(page);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]!.id).toBe("a");
		expect(resolved[0]!.maskAssetId).toBe("m-a");
		expect(resolved[0]!.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
	});

	test("P1-d — NEW non-destructive page: base = ORIGINAL page.imageId, edit layers on top", () => {
		// A page WITHOUT a baked page.edits.imageId is a new non-destructive page. Its
		// export base is the ORIGINAL source (page.imageId); the edit-layer stack
		// composites over it. Spec: docs/specs/non-destructive-edit-layers.md.
		const page = {
			imageId: "src-1",
			imageName: "src-1",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			imageEditLayers: [
				{ id: "edit-x", payload: { type: "fill-mask", maskAssetId: "mask-x", maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } }, bbox: { x: 5, y: 5, w: 8, h: 8 }, index: 0, visible: true },
			],
		} as unknown as PageState;
		const state = { projectId: "proj", pages: [page] } as unknown as ProjectState;
		const plans = buildLanguageRenderPlans(state, ["src-1"], undefined);
		expect(plans).toBeDefined();
		expect(plans![0]!.renderImageId).toBe("src-1"); // ORIGINAL background, not baked
		expect(plans![0]!.editLayers).toHaveLength(1);
		expect(plans![0]!.editLayers![0]!.maskAssetId).toBe("mask-x");
	});

	test("P1-d — LEGACY page with baked edits.imageId: base = BAKED edits.imageId, edit layers on top", () => {
		// A legacy page whose pixels were baked into page.edits.imageId can NOT be
		// re-rendered as "original + stack" (the baked pixels are unrecoverable), so the
		// export base MUST be the baked edits.imageId. Any imageEditLayers still composite
		// ON TOP of that baked base — identical to the live editor + client export.
		const page = {
			imageId: "src-2",
			imageName: "src-2",
			edits: { imageId: "baked-2" },
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			imageEditLayers: [
				{ id: "edit-y", payload: { type: "fill-mask", maskAssetId: "mask-y", maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } }, bbox: { x: 1, y: 1, w: 4, h: 4 }, index: 0, visible: true },
			],
		} as unknown as PageState;
		const state = { projectId: "proj", pages: [page] } as unknown as ProjectState;
		const plans = buildLanguageRenderPlans(state, ["src-2"], undefined);
		expect(plans).toBeDefined();
		expect(plans![0]!.renderImageId).toBe("baked-2"); // BAKED legacy base, NOT the source
		expect(plans![0]!.editLayers).toHaveLength(1);
		expect(plans![0]!.editLayers![0]!.maskAssetId).toBe("mask-y");
	});

	test("a blocked mask asset (assertReady throws) fails the page", async () => {
		const page = await makePage();
		const mask = await makeFullMask(8, 8);
		const layer: ExportEditLayerPlan = {
			id: "edit-blocked",
			maskAssetId: "blocked",
			fill: { r: 255, g: 255, b: 255, a: 255 },
			bbox: { x: 0, y: 0, w: 8, h: 8 },
			index: 0,
		};
		await expect(
			compositeEditLayers(page, [layer], async () => mask, {
				assertReady: async () => {
					throw new Error("moderation blocked");
				},
			}),
		).rejects.toThrow("moderation blocked");
	});
});

/** A solid-colour RGBA patch (fully opaque) of size w×h — the realized ROI for Phase B. */
async function makeColorPatch(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
	return sharp({
		create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } },
	}).png().toBuffer();
}

describe("compositeEditLayers (Phase B patch/healing/clone realized ROI)", () => {
	test("composites a realized RGBA patch verbatim at bbox (its OWN colour, not a fill)", async () => {
		const page = await makePage();
		const pw = 8;
		const ph = 8;
		// A red patch — distinct from both the grey page and the white fill, so we know it
		// painted its OWN pixels (not the placeholder fill).
		const patch = await makeColorPatch(pw, ph, 200, 30, 40);
		const bx = 5;
		const by = 6;
		const layer: ExportEditLayerPlan = {
			id: "edit-patch",
			kind: "patch",
			maskAssetId: "patch-asset-1", // realized patch id lives in maskAssetId for the plan
			fill: { r: 0, g: 0, b: 0, a: 0 },
			bbox: { x: bx, y: by, w: pw, h: ph },
			opacity: 1,
			index: 0,
		};
		const result = await compositeEditLayers(page, [layer], async () => patch);
		expect(result.composited).toBe(1);
		// Inside the bbox = the patch colour.
		const inside = await pixelAt(result.buffer, bx + 2, by + 2);
		expect(inside).toEqual({ r: 200, g: 30, b: 40 });
		// Outside the bbox = the untouched grey page.
		const outside = await pixelAt(result.buffer, bx + pw + 4, by + ph + 4);
		expect(outside).toEqual({ r: 80, g: 80, b: 80 });
	});

	test("healing realized patch composites the same as a patch (deterministic export source)", async () => {
		const page = await makePage();
		const patch = await makeColorPatch(6, 6, 10, 220, 30);
		const layer: ExportEditLayerPlan = {
			id: "edit-heal",
			kind: "healing",
			maskAssetId: "healed-roi-1",
			fill: { r: 0, g: 0, b: 0, a: 0 },
			bbox: { x: 4, y: 4, w: 6, h: 6 },
			index: 0,
		};
		const result = await compositeEditLayers(page, [layer], async () => patch);
		expect(result.composited).toBe(1);
		expect(await pixelAt(result.buffer, 6, 6)).toEqual({ r: 10, g: 220, b: 30 });
	});

	test("clone realized patch composites at bbox", async () => {
		const page = await makePage();
		const patch = await makeColorPatch(6, 6, 30, 40, 230);
		const layer: ExportEditLayerPlan = {
			id: "edit-clone",
			kind: "clone",
			maskAssetId: "cloned-roi-1",
			fill: { r: 0, g: 0, b: 0, a: 0 },
			bbox: { x: 10, y: 10, w: 6, h: 6 },
			index: 0,
		};
		const result = await compositeEditLayers(page, [layer], async () => patch);
		expect(result.composited).toBe(1);
		expect(await pixelAt(result.buffer, 12, 12)).toEqual({ r: 30, g: 40, b: 230 });
	});

	test("a missing realized-patch asset fails closed for the durable pipeline (failOnSkipped default)", async () => {
		const page = await makePage();
		const layer: ExportEditLayerPlan = {
			id: "edit-missing-patch",
			kind: "patch",
			maskAssetId: "gone",
			fill: { r: 0, g: 0, b: 0, a: 0 },
			bbox: { x: 0, y: 0, w: 6, h: 6 },
			index: 0,
		};
		await expect(compositeEditLayers(page, [layer], async () => undefined)).rejects.toThrow(
			ExportEditLayerMissingError,
		);
	});
});

describe("resolveExportEditLayers (Phase B parsing)", () => {
	function pageWith(layers: unknown[]): PageState {
		return {
			imageId: "src-1",
			imageName: "p.png",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			imageEditLayers: layers,
		} as unknown as PageState;
	}

	test("parses a patch layer → plan with kind=patch and the patch asset as the read id", () => {
		const plans = resolveExportEditLayers(pageWith([
			{
				id: "e1",
				kind: "patch",
				visible: true,
				opacity: 1,
				index: 0,
				bbox: { x: 1, y: 2, w: 8, h: 8 },
				payload: { type: "patch", patchAssetId: "patch-1", patchEncoding: "png-rgba" },
			},
		]));
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({ kind: "patch", maskAssetId: "patch-1" });
	});

	test("parses healing/clone → plan reads the realizedPatchAssetId", () => {
		const plans = resolveExportEditLayers(pageWith([
			{
				id: "h1",
				kind: "healing",
				visible: true,
				opacity: 1,
				index: 0,
				bbox: { x: 0, y: 0, w: 4, h: 4 },
				payload: {
					type: "healing",
					maskAssetId: "m1",
					realizedPatchAssetId: "heal-1",
					patchEncoding: "png-rgba",
					algorithm: "telea",
					algorithmVersion: "telea-1",
				},
			},
			{
				id: "c1",
				kind: "clone",
				visible: true,
				opacity: 1,
				index: 1,
				bbox: { x: 0, y: 0, w: 4, h: 4 },
				payload: {
					type: "clone",
					maskAssetId: "m2",
					realizedPatchAssetId: "clone-1",
					patchEncoding: "png-rgba",
					sourceImageId: "src-1",
					sourceBbox: { x: 0, y: 0, w: 4, h: 4 },
					offset: { dx: 5, dy: 5 },
				},
			},
		]));
		expect(plans.map((p) => p.maskAssetId)).toEqual(["heal-1", "clone-1"]);
		expect(plans.map((p) => p.kind)).toEqual(["healing", "clone"]);
	});

	test("a fill-mask + a patch coexist in one stack (mixed Phase A + B)", () => {
		const plans = resolveExportEditLayers(pageWith([
			{
				id: "f1",
				kind: "bubble-clean",
				visible: true,
				opacity: 1,
				index: 0,
				bbox: { x: 0, y: 0, w: 4, h: 4 },
				payload: { type: "fill-mask", maskAssetId: "mask-1", maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
			},
			{
				id: "p1",
				kind: "patch",
				visible: true,
				opacity: 1,
				index: 1,
				bbox: { x: 4, y: 4, w: 4, h: 4 },
				payload: { type: "patch", patchAssetId: "patch-1", patchEncoding: "png-rgba" },
			},
		]));
		expect(plans).toHaveLength(2);
		expect(plans[0]?.kind).toBe("fill-mask");
		expect(plans[1]?.kind).toBe("patch");
	});
});
