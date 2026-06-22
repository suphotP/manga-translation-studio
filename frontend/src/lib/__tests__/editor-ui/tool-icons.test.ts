import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_ICON, TOOL_ICONS, toolIconPath } from "$lib/editor-ui/tool-icons";
import { BUILTIN_TOOLS } from "$lib/editor/tool-registry.svelte.ts";

const REQUIRED_TOOL_ICON_IDS = [
	"select",
	"crop",
	"text",
			"translate",
	"brush",
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
	"adjustments",
	"screentone-fill",
	"cover",
] as const;

const PATH_TOKEN_PATTERN = /[AaCcHhLlMmQqSsTtVvZz]|-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;
const PATH_D_ATTRIBUTE_PATTERN = /^<path d="([^"]+)" \/>$/;
const COMMAND_ARG_COUNT: Record<string, number> = {
	A: 7,
	C: 6,
	H: 1,
	L: 2,
	M: 2,
	Q: 4,
	S: 4,
	T: 2,
	V: 1,
	Z: 0,
};

function isPathCommand(token: string | undefined): boolean {
	return /^[AaCcHhLlMmQqSsTtVvZz]$/.test(token ?? "");
}

function parsePathTokens(path: string): string[] {
	const tokens = path.match(PATH_TOKEN_PATTERN) ?? [];
	const unsupported = path.replace(PATH_TOKEN_PATTERN, "").replace(/[\s,]/g, "");
	expect(unsupported, `${path} contains unsupported path characters`).toBe("");
	return tokens;
}

function assertPathDataIsParseable(id: string, path: string): void {
	const tokens = parsePathTokens(path);
	expect(tokens.length, `${id} should not be empty`).toBeGreaterThan(1);
	expect(isPathCommand(tokens[0]), `${id} should start with an SVG path command`).toBe(true);

	let index = 0;
	let command = "";
	while (index < tokens.length) {
		const token = tokens[index];
		if (isPathCommand(token)) {
			command = token;
			index += 1;
		}

		expect(command, `${id} has path numbers before a command`).not.toBe("");

		const argCount = COMMAND_ARG_COUNT[command.toUpperCase()];
		expect(argCount, `${id} uses an unsupported path command ${command}`).not.toBeUndefined();

		if (argCount === 0) {
			expect(
				index === tokens.length || isPathCommand(tokens[index]),
				`${id} has numeric args after close-path command`,
			).toBe(true);
			continue;
		}

		let groups = 0;
		while (index < tokens.length && !isPathCommand(tokens[index])) {
			const args = tokens.slice(index, index + argCount);
			expect(args.length, `${id} has an incomplete ${command} segment`).toBe(argCount);
			expect(args.every((arg) => !isPathCommand(arg)), `${id} has an incomplete ${command} segment`).toBe(true);

			for (const arg of args) {
				const value = Number(arg);
				expect(Number.isFinite(value), `${id} has a non-finite path value`).toBe(true);
				expect(Math.abs(value), `${id} should fit a 24x24 viewBox stroke icon`).toBeLessThanOrEqual(24);
			}

			index += argCount;
			groups += 1;
		}

		expect(groups, `${id} command ${command} should have at least one segment`).toBeGreaterThan(0);
	}
}

describe("editor tool icons", () => {
	it("ships exactly the editor tool ids requested by the tool dock contract", () => {
		expect(Object.keys(TOOL_ICONS).sort()).toEqual([...REQUIRED_TOOL_ICON_IDS].sort());
	});

	it("keeps every icon as non-empty path data", () => {
		for (const id of REQUIRED_TOOL_ICON_IDS) {
			expect(TOOL_ICONS[id], `${id} should have path data`).toEqual(expect.any(String));
			expect(TOOL_ICONS[id].trim(), `${id} should not be blank`).toBe(TOOL_ICONS[id]);
			expect(TOOL_ICONS[id].length, `${id} should draw more than a dot`).toBeGreaterThan(8);
		}
	});

	it("can be embedded and extracted as a path d attribute", () => {
		for (const id of REQUIRED_TOOL_ICON_IDS) {
			const pathMarkup = `<path d="${TOOL_ICONS[id]}" />`;
			const match = PATH_D_ATTRIBUTE_PATTERN.exec(pathMarkup);
			expect(match?.[1], `${id} should round-trip through d="" markup`).toBe(TOOL_ICONS[id]);
		}
	});

	it("uses path-only data so a shared 24px Lucide-like stroke style owns presentation", () => {
		for (const id of REQUIRED_TOOL_ICON_IDS) {
			const path = TOOL_ICONS[id];
			expect(path, `${id} should not include SVG tags`).not.toMatch(/[<>]/);
			expect(path, `${id} should not carry fill or stroke styling`).not.toMatch(/\b(?:fill|stroke|style|class)=/i);
			expect(path, `${id} should stay XML attribute safe`).not.toMatch(/["'&]/);
		}
	});

	it("parses every icon as valid SVG path command groups inside a 24x24 viewBox budget", () => {
		for (const id of REQUIRED_TOOL_ICON_IDS) {
			assertPathDataIsParseable(id, TOOL_ICONS[id]);
		}
	});

	it("rejects the edge cases that would break ToolPalette path rendering", () => {
		expect(() => assertPathDataIsParseable("blank", "")).toThrow();
		expect(() => assertPathDataIsParseable("markup", '<path d="M4 4h16" />')).toThrow();
		expect(() => assertPathDataIsParseable("incomplete", "M4 4L8")).toThrow();
		expect(() => assertPathDataIsParseable("oversize", "M4 4L40 4")).toThrow();
	});

	it("covers every REGISTERED dock tool id and falls back safely (codex P2)", () => {
		for (const def of BUILTIN_TOOLS) {
			expect(TOOL_ICONS[def.id], `registered dock tool ${def.id} must have an icon`).toEqual(expect.any(String));
		}
		expect(toolIconPath("definitely-not-a-tool")).toBe(DEFAULT_TOOL_ICON);
	});
});
