import { describe, expect, it } from "vitest";
import { estimateTextLayerFit } from "$lib/project/text-layout-qc.js";
import type { TextLayer } from "$lib/types.js";

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "A short line",
		x: 0,
		y: 0,
		w: 220,
		h: 64,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

describe("estimateTextLayerFit", () => {
	it("keeps ordinary dialogue inside its box", () => {
		const fit = estimateTextLayerFit(textLayer());

		expect(fit.fits).toBe(true);
		expect(fit.lineCount).toBe(1);
	});

	it("flags text that needs too many wrapped lines for the box", () => {
		const fit = estimateTextLayerFit(textLayer({
			text: "This translated dialogue is intentionally long enough to wrap into too many lines for a small speech bubble.",
			w: 120,
			h: 44,
			fontSize: 24,
		}));

		expect(fit.fits).toBe(false);
		expect(fit.lineCount).toBeGreaterThan(2);
		expect(fit.estimatedHeight).toBeGreaterThan(fit.availableHeight);
	});

	it("handles CJK-style text without spaces as wrapped graphemes", () => {
		const fit = estimateTextLayerFit(textLayer({
			text: "これはとても長いセリフですこれはとても長いセリフです",
			w: 96,
			h: 52,
			fontSize: 22,
		}));

		expect(fit.fits).toBe(false);
		expect(fit.lineCount).toBeGreaterThan(2);
	});
});
