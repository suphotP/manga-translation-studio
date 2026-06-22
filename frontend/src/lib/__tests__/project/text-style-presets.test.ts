import { describe, expect, it } from "vitest";
import {
	buildTextStyleFromLayer,
	DEFAULT_TEXT_STYLE_PRESETS,
	getTextStylePresets,
	normalizeTextStylePreset,
	suggestTextStylePresetsForPrompt,
} from "$lib/project/text-style-presets.js";
import type { TextLayer } from "$lib/types.js";

function makeLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "hello",
		x: 10,
		y: 20,
		w: 100,
		h: 40,
		rotation: 0,
		fontSize: 24,
		fontFamily: "Tahoma, sans-serif",
		fill: "#111111",
		stroke: "#ffffff",
		strokeWidth: 2,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

describe("text style presets", () => {
	it("ships stable built-in presets", () => {
		expect(DEFAULT_TEXT_STYLE_PRESETS.length).toBeGreaterThanOrEqual(8);
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-dialogue");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-sfx-impact-red");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-sfx-dungeon-blue");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-sfx-scream-red");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-sfx-haunt-stretch");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-romance-gold");
		expect(DEFAULT_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toContain("builtin-whisper-glow");
		expect(DEFAULT_TEXT_STYLE_PRESETS.every((preset) => preset.builtIn)).toBe(true);
		expect(DEFAULT_TEXT_STYLE_PRESETS.find((preset) => preset.id === "builtin-sfx-dungeon-blue")?.name)
			.toBe("เวทดันเจี้ยน");
		expect(DEFAULT_TEXT_STYLE_PRESETS.find((preset) => preset.id === "builtin-sfx-scream-red")?.name)
			.toBe("เสียงกรีดร้อง");
		expect(DEFAULT_TEXT_STYLE_PRESETS.find((preset) => preset.id === "builtin-sfx-haunt-stretch")?.style.charSpacing)
			.toBe(180);
		expect(DEFAULT_TEXT_STYLE_PRESETS.find((preset) => preset.id === "builtin-sfx-haunt-stretch")?.style.skewX)
			.toBe(18);
		expect(DEFAULT_TEXT_STYLE_PRESETS.find((preset) => preset.id === "builtin-romance-gold")?.name)
			.toBe("โรแมนซ์ประกาย");
	});

	it("normalizes custom presets and drops unsafe style values", () => {
		const preset = normalizeTextStylePreset({
			id: "custom-1",
			name: "  My Preset  ",
			style: {
				fontFamily: "Tahoma",
				fontSize: 999,
				charSpacing: 9999,
				skewX: 999,
				skewY: -999,
				fill: "red",
				stroke: "#c1121f",
				strokeWidth: -10,
				opacity: 2,
				alignment: "sideways",
			},
		});

		expect(preset).toEqual({
			id: "custom-1",
			name: "My Preset",
			builtIn: false,
			style: {
				fontFamily: "Tahoma",
				fontSize: 300,
				charSpacing: 1000,
				skewX: 45,
				skewY: -45,
				stroke: "#c1121f",
				strokeWidth: 0,
				opacity: 1,
			},
		});
	});

	it("normalizes effect templates without accepting unsafe effect values", () => {
		const preset = normalizeTextStylePreset({
			id: "custom-effect",
			name: "Custom Effect",
			promptTags: ["  SFX  ", "sfx", "", 42],
			style: {
				fontSize: 28,
				fill: "#ffffff",
				effects: {
					outerGlow: {
						enabled: true,
						color: "#93c5fd",
						blur: 999,
						opacity: -10,
					},
					dropShadow: {
						enabled: true,
						color: "black",
						offsetX: 999,
						offsetY: -999,
						blur: 8,
						opacity: 120,
					},
					accentShadows: [
						{ enabled: true, color: "#22d3ee", offsetX: -999, offsetY: 999, blur: 999, opacity: 120 },
						{ enabled: false, color: "cyan", offsetX: 4, offsetY: 5, blur: 6, opacity: 7 },
						"bad",
					],
					passes: [
						{ enabled: true, fill: "#ffffff", stroke: "#020617", strokeWidth: 999, offsetX: -999, offsetY: 999, opacity: 120 },
						{ enabled: false, fill: "white", stroke: "black", offsetX: 4, offsetY: 5, opacity: 7 },
						null,
					],
				},
			},
		});

		expect(preset).toEqual({
			id: "custom-effect",
			name: "Custom Effect",
			builtIn: false,
			promptTags: ["sfx"],
			style: {
				fontSize: 28,
				fill: "#ffffff",
				effects: {
					outerGlow: {
						enabled: true,
						color: "#93c5fd",
						blur: 200,
						opacity: 0,
					},
					dropShadow: {
						enabled: true,
						color: "#111111",
						offsetX: 512,
						offsetY: -512,
						blur: 8,
						opacity: 100,
					},
					accentShadows: [
						{ enabled: true, color: "#22d3ee", offsetX: -512, offsetY: 512, blur: 200, opacity: 100 },
						{ enabled: false, color: "#111111", offsetX: 4, offsetY: 5, blur: 6, opacity: 7 },
					],
					passes: [
						{ enabled: true, fill: "#ffffff", stroke: "#020617", strokeWidth: 64, offsetX: -512, offsetY: 512, opacity: 100 },
						{ enabled: false, offsetX: 4, offsetY: 5, opacity: 7 },
					],
				},
			},
		});
	});

	it("merges built-ins with valid custom project presets", () => {
		const presets = getTextStylePresets([
			{ id: "custom-1", name: "Custom", style: { fill: "#c1121f" } },
			{ id: "", name: "Bad", style: { fill: "#111111" } },
		]);

		expect(presets.some((preset) => preset.id === "builtin-dialogue")).toBe(true);
		expect(presets.at(-1)).toEqual(expect.objectContaining({
			id: "custom-1",
			name: "Custom",
			style: { fill: "#c1121f" },
		}));
	});

	it("builds a saveable style from a selected text layer", () => {
		expect(buildTextStyleFromLayer(makeLayer({ fill: "#c1121f", strokeWidth: 4, opacity: 0.42, charSpacing: 120, skewX: -12, skewY: 4 }))).toEqual({
			fontFamily: "Tahoma, sans-serif",
			fontSize: 24,
			charSpacing: 120,
			skewX: -12,
			skewY: 4,
			fill: "#c1121f",
			stroke: "#ffffff",
			strokeWidth: 4,
			opacity: 0.42,
			alignment: "center",
			effects: undefined,
		});
	});

	it("suggests built-in editable templates from prompt tags", () => {
		const suggestions = suggestTextStylePresetsForPrompt("angry loud red impact sfx", DEFAULT_TEXT_STYLE_PRESETS, 2);

		expect(suggestions.map((preset) => preset.id)).toEqual([
			"builtin-sfx-impact-red",
			"builtin-sfx-scream-red",
		]);
	});

	it("suggests manhwa and romance SFX templates from Thai prompts", () => {
		expect(suggestTextStylePresetsForPrompt("เสียงกรีดร้อง ตกใจ", DEFAULT_TEXT_STYLE_PRESETS, 1)[0]?.id)
			.toBe("builtin-sfx-scream-red");
		expect(suggestTextStylePresetsForPrompt("เวท ดันเจี้ยน น้ำเงิน", DEFAULT_TEXT_STYLE_PRESETS, 1)[0]?.id)
			.toBe("builtin-sfx-dungeon-blue");
		expect(suggestTextStylePresetsForPrompt("เสียงหลอน เลื้อย ยาว", DEFAULT_TEXT_STYLE_PRESETS, 1)[0]?.id)
			.toBe("builtin-sfx-haunt-stretch");
		expect(suggestTextStylePresetsForPrompt("น่ารัก ยุคกลาง ผู้หญิง", DEFAULT_TEXT_STYLE_PRESETS, 1)[0]?.id)
			.toBe("builtin-romance-gold");
	});
});
