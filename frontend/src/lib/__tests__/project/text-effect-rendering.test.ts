import { describe, expect, it } from "vitest";
import {
	colorWithEffectOpacity,
	resolveTextLayerEffectStyle,
} from "$lib/project/text-effect-rendering.js";
import type { TextLayer } from "$lib/types.js";

function layer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "text-effect-layer",
		text: "FX",
		x: 10,
		y: 20,
		w: 200,
		h: 80,
		rotation: 0,
		fontSize: 32,
		fontFamily: "Tahoma",
		fill: "#111111",
		stroke: "#ffffff",
		strokeWidth: 2,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

describe("text effect rendering", () => {
	it("converts effect opacity percentages to rgba alpha", () => {
		expect(colorWithEffectOpacity("#93c5fd", 42)).toBe("rgba(147, 197, 253, 0.42)");
		expect(colorWithEffectOpacity("#000", 75)).toBe("rgba(0, 0, 0, 0.75)");
		expect(colorWithEffectOpacity("#000000", 100)).toBe("rgba(0, 0, 0, 1)");
	});

	it("resolves stroke and shadow from one renderer truth", () => {
		const resolved = resolveTextLayerEffectStyle(
			layer({
				effects: {
					stroke: { enabled: true, color: "#c1121f", width: 8 },
					outerGlow: { enabled: true, color: "#93c5fd", blur: 18, opacity: 42 },
				},
			}),
			"#ffffff",
			2,
		);

		expect(resolved).toEqual({
			stroke: "#c1121f",
			strokeWidth: 8,
			shadow: {
				color: "rgba(147, 197, 253, 0.42)",
				offsetX: 0,
				offsetY: 0,
				blur: 18,
			},
			shadows: [
				{
					color: "rgba(147, 197, 253, 0.42)",
					offsetX: 0,
					offsetY: 0,
					blur: 18,
				},
			],
			passes: [],
		});
	});

	it("keeps glow and drop shadow in export order when both are enabled", () => {
		const resolved = resolveTextLayerEffectStyle(
			layer({
				effects: {
					outerGlow: { enabled: true, color: "#93c5fd", blur: 18, opacity: 42 },
					passes: [
						{ enabled: true, fill: "#1e3a8a", stroke: "#020617", strokeWidth: 7, offsetX: 9, offsetY: 10, opacity: 80 },
					],
					accentShadows: [
						{ enabled: true, color: "#22d3ee", offsetX: -8, offsetY: 0, blur: 12, opacity: 64 },
					],
					dropShadow: { enabled: true, color: "#111111", offsetX: 4, offsetY: 5, blur: 10, opacity: 55 },
				},
			}),
			"#ffffff",
			2,
		);

		expect(resolved.shadow).toEqual({
			color: "rgba(17, 17, 17, 0.55)",
			offsetX: 4,
			offsetY: 5,
			blur: 10,
		});
		expect(resolved.passes).toEqual([
			{
				fill: "#1e3a8a",
				stroke: "#020617",
				strokeWidth: 7,
				offsetX: 9,
				offsetY: 10,
				opacity: 0.8,
				shadow: null,
			},
		]);
		expect(resolved.shadows).toEqual([
			{
				color: "rgba(147, 197, 253, 0.42)",
				offsetX: 0,
				offsetY: 0,
				blur: 18,
			},
			{
				color: "rgba(34, 211, 238, 0.64)",
				offsetX: -8,
				offsetY: 0,
				blur: 12,
			},
			{
				color: "rgba(17, 17, 17, 0.55)",
				offsetX: 4,
				offsetY: 5,
				blur: 10,
			},
		]);
	});
});
