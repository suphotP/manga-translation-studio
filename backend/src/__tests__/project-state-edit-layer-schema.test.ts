// P2 — non-destructive edit-layer bbox validation in the save schema.
//
// An edit-layer bbox is the NATIVE page-pixel rectangle the mask maps onto, so its
// x/y MUST be >= 0. The frontend compositor draws the mask AT bbox.x/y and clips
// anything off the left/top edge, while the backend export (export-edit-layers.ts
// `roundNonNegative`) CLAMPS left/top to 0 — i.e. it SHIFTS the pixels instead of
// clipping. A negative x/y would therefore export DIFFERENTLY on the two paths.
// The schema now REJECTS a negative edit-layer bbox x/y so the divergence is
// impossible (client + server stay byte-aligned).

import { describe, expect, test } from "bun:test";
import { projectStateSaveSchema } from "../schemas/project-state.js";

function bodyWithEditLayerBbox(bbox: { x: number; y: number; w: number; h: number }) {
	return {
		projectId: "proj-1",
		pages: [
			{
				imageId: "page-1",
				imageName: "page-1.png",
				textLayers: [],
				imageEditLayers: [
					{
						id: "edit-1",
						kind: "bubble-clean",
						target: "page-background",
						visible: true,
						opacity: 1,
						sourceImageId: "page-1",
						bbox,
						payload: {
							type: "fill-mask",
							maskAssetId: "mask-1",
							maskEncoding: "png-alpha",
							fill: { r: 255, g: 255, b: 255, a: 255 },
						},
						index: 0,
						tool: { id: "bubble-clean" },
						createdAt: "2026-05-12T00:00:00.000Z",
					},
				],
			},
		],
	};
}

describe("projectStateSaveSchema — edit-layer bbox (P2)", () => {
	test("accepts a non-negative edit-layer bbox", () => {
		const parsed = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: 5, y: 10, w: 20, h: 20 }));
		expect(parsed.success).toBe(true);
	});

	test("accepts a zero-origin edit-layer bbox", () => {
		const parsed = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: 0, y: 0, w: 12, h: 12 }));
		expect(parsed.success).toBe(true);
	});

	test("REJECTS a negative bbox.x (would clip on client but shift on server)", () => {
		const parsed = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: -3, y: 10, w: 20, h: 20 }));
		expect(parsed.success).toBe(false);
	});

	test("REJECTS a negative bbox.y", () => {
		const parsed = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: 5, y: -1, w: 20, h: 20 }));
		expect(parsed.success).toBe(false);
	});

	test("REJECTS a negative bbox.w/h", () => {
		const parsedW = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: 5, y: 5, w: -20, h: 20 }));
		const parsedH = projectStateSaveSchema.safeParse(bodyWithEditLayerBbox({ x: 5, y: 5, w: 20, h: -20 }));
		expect(parsedW.success).toBe(false);
		expect(parsedH.success).toBe(false);
	});
});

// Phase B — the payload union now accepts patch / healing / clone, not only fill-mask.
function bodyWithPayload(kind: string, payload: unknown, tool: { id: string }) {
	return {
		projectId: "proj-1",
		pages: [
			{
				imageId: "page-1",
				imageName: "page-1.png",
				textLayers: [],
				imageEditLayers: [
					{
						id: "edit-1",
						kind,
						target: "page-background",
						visible: true,
						opacity: 1,
						sourceImageId: "page-1",
						bbox: { x: 4, y: 4, w: 10, h: 10 },
						payload,
						index: 0,
						tool,
						createdAt: "2026-06-06T00:00:00.000Z",
					},
				],
			},
		],
	};
}

describe("projectStateSaveSchema — Phase B edit-layer payloads", () => {
	test("accepts a patch payload", () => {
		const parsed = projectStateSaveSchema.safeParse(
			bodyWithPayload("patch", { type: "patch", patchAssetId: "patch-1", patchEncoding: "png-rgba" }, { id: "brush" }),
		);
		expect(parsed.success).toBe(true);
	});

	test("accepts a healing payload", () => {
		const parsed = projectStateSaveSchema.safeParse(
			bodyWithPayload(
				"healing",
				{
					type: "healing",
					maskAssetId: "m1",
					realizedPatchAssetId: "heal-1",
					patchEncoding: "png-rgba",
					algorithm: "telea",
					algorithmVersion: "telea-1",
				},
				{ id: "healing-brush" },
			),
		);
		expect(parsed.success).toBe(true);
	});

	test("accepts a clone payload", () => {
		const parsed = projectStateSaveSchema.safeParse(
			bodyWithPayload(
				"clone",
				{
					type: "clone",
					maskAssetId: "m2",
					realizedPatchAssetId: "clone-1",
					patchEncoding: "png-rgba",
					sourceImageId: "page-1",
					sourceBbox: { x: 0, y: 0, w: 10, h: 10 },
					offset: { dx: -20, dy: 8 },
				},
				{ id: "clone-stamp" },
			),
		);
		expect(parsed.success).toBe(true);
	});

	test("REJECTS an unknown payload type", () => {
		const parsed = projectStateSaveSchema.safeParse(
			bodyWithPayload("patch", { type: "bogus", patchAssetId: "x", patchEncoding: "png-rgba" }, { id: "brush" }),
		);
		expect(parsed.success).toBe(false);
	});

	test("REJECTS a healing payload missing the realized patch asset", () => {
		const parsed = projectStateSaveSchema.safeParse(
			bodyWithPayload(
				"healing",
				{ type: "healing", maskAssetId: "m1", patchEncoding: "png-rgba", algorithm: "telea", algorithmVersion: "telea-1" },
				{ id: "healing-brush" },
			),
		);
		expect(parsed.success).toBe(false);
	});
});
