import { describe, expect, it } from "vitest";
import {
	buildCreditLayerFromPreset,
	DEFAULT_CREDIT_PRESETS,
	getCreditPresets,
	normalizeCreditPreset,
} from "$lib/project/credit-presets.js";

describe("credit presets", () => {
	it("ships stable placement presets", () => {
		expect(DEFAULT_CREDIT_PRESETS.map((preset) => preset.id)).toEqual([
			"credit-top-center",
			"credit-bottom-center",
			"credit-left-bottom",
			"credit-right-bottom",
		]);
		expect(DEFAULT_CREDIT_PRESETS.every((preset) => preset.builtIn)).toBe(true);
	});

	it("normalizes custom presets and clamps unsafe values", () => {
		const preset = normalizeCreditPreset({
			id: " custom-credit ",
			name: "  My Credit  ",
			text: "  Team Name  ",
			placement: "bottom",
			offset: 99999,
			style: {
				fontSize: 500,
				fill: "white",
				stroke: "#111111",
				strokeWidth: -10,
				opacity: -1,
				alignment: "sideways",
			},
		});

		expect(preset).toEqual(expect.objectContaining({
			id: "custom-credit",
			name: "My Credit",
			text: "Team Name",
			placement: "bottom",
			offset: 2048,
			style: expect.objectContaining({
				fontSize: 300,
				stroke: "#111111",
				strokeWidth: 0,
				opacity: 0,
			}),
		}));
		expect(preset?.style.fill).toBe("#ffffff");
	});

	it("merges built-ins with custom project presets", () => {
		const presets = getCreditPresets([
			{ id: "custom-credit", name: "Custom", text: "Team", placement: "top", offset: 12, style: {} },
			{ id: "", name: "Bad", text: "Bad", placement: "top", offset: 12, style: {} },
		]);

		expect(presets.some((preset) => preset.id === "credit-bottom-center")).toBe(true);
		expect(presets.at(-1)).toEqual(expect.objectContaining({
			id: "custom-credit",
			name: "Custom",
			text: "Team",
		}));
	});

	it("builds bottom credit layers in original image coordinates", () => {
		const preset = DEFAULT_CREDIT_PRESETS.find((item) => item.id === "credit-bottom-center")!;
		const layer = buildCreditLayerFromPreset(preset, {
			imageWidth: 1600,
			imageHeight: 2400,
			index: 3,
			text: "Translator: A",
			offset: 30,
			idFactory: () => "credit-layer",
		});

		expect(layer).toEqual(expect.objectContaining({
			id: "credit-layer",
			text: "Translator: A",
			sourceCategory: "credit",
			sourceProvider: "credit-preset",
			protected: true,
			locked: true,
			visible: true,
			x: 30,
			w: 1540,
			index: 3,
		}));
		expect(layer.y + layer.h).toBe(2370);
	});
});
