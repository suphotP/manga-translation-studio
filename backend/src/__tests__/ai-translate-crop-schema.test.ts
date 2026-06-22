// Codex P2 — the AI /translate crop schema bound.
//
// DECISION: the crop schema carries NO hard pixel upper bound. A hard cap (the old
// `.max(100000)`) would 400 a legitimate crop on an asset that an operator's RAISED
// upload ceiling allows — MAX_UPLOAD_IMAGE_HEIGHT can reach 150000+ for webtoon pages
// and the split-source ceiling reaches 200000px (see getUploadImagePixelCeiling /
// getSplitSourcePixelCeiling) — BEFORE the server can clamp the crop against the
// asset's real dimensions. The real, asset-aware bound is enforced server-side by
// clampCrop (which fully bounds x/y/w/h to the decoded image). The schema's only job
// is to reject MALFORMED input, which it still does:
//   • z.number() in Zod v4 is finite-by-default → rejects NaN / Infinity / -Infinity.
//   • .int() requires whole-pixel coordinates (clampCrop floors anyway) and is a
//     second guard against any non-finite value.
//   • .min(0)/.min(1) reject negatives / zero-area.
//
// This is a PURE schema test (no HTTP, no queue, no shared state), so it can assert
// the bound decision directly and deterministically.

import { describe, test, expect } from "bun:test";
import { translateCropSchema } from "../routes/ai.js";
import { getUploadImagePixelCeiling, getSplitSourcePixelCeiling } from "../services/assets.js";

describe("AI /translate crop schema (codex P2: no hard pixel cap; reject malformed)", () => {
	test("ACCEPTS a crop at (and beyond) the configured upload height ceiling", () => {
		// The per-page and split-source ceilings are operator-tunable and tall; the
		// schema must accept a crop at either ceiling (the server clamps afterward).
		const pageCeiling = getUploadImagePixelCeiling();
		const splitCeiling = getSplitSourcePixelCeiling();

		// A crop whose height equals the per-page ceiling (e.g. 100000px default, up to
		// 150000+ when operators raise MAX_UPLOAD_IMAGE_HEIGHT) — the old .max(100000)
		// cap would have REJECTED this; it must now pass.
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 800, h: pageCeiling.maxHeight }).success).toBe(true);

		// A crop at the (taller) split-source ceiling — well past the old hard cap.
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 800, h: splitCeiling.maxHeight }).success).toBe(true);

		// The concrete regression value called out in the review (150000px webtoon page).
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 800, h: 150000 }).success).toBe(true);
	});

	test("ACCEPTS a normal in-bounds integer crop", () => {
		expect(translateCropSchema.safeParse({ x: 10, y: 20, w: 128, h: 128 }).success).toBe(true);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 1, h: 1 }).success).toBe(true);
	});

	test("REJECTS Infinity / -Infinity / NaN (non-finite is never clampable)", () => {
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 100, h: Number.NEGATIVE_INFINITY }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: Number.NaN, y: 0, w: 100, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: Number.NaN, w: 100, h: 100 }).success).toBe(false);
	});

	test("REJECTS negatives, zero-area, and non-integer (fractional) coordinates", () => {
		expect(translateCropSchema.safeParse({ x: -1, y: 0, w: 100, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: -5, w: 100, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 0, h: 100 }).success).toBe(false); // w < 1
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 100, h: 0 }).success).toBe(false); // h < 1
		expect(translateCropSchema.safeParse({ x: 0.5, y: 0, w: 100, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 100.25, h: 100 }).success).toBe(false);
	});

	test("REJECTS missing / non-numeric coordinates (e.g. null from JSON-serialized Infinity)", () => {
		// JSON.stringify serializes Infinity/NaN to `null` over the wire; the schema's
		// number type rejects that too, so a non-finite value can never reach the clamp.
		expect(translateCropSchema.safeParse({ x: null, y: 0, w: 100, h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: "100", h: 100 }).success).toBe(false);
		expect(translateCropSchema.safeParse({ x: 0, y: 0, w: 100 }).success).toBe(false); // missing h
	});
});
