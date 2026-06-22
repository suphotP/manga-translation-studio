import { describe, expect, it } from "vitest";
import { buildShortcutGroups, commandPaletteKeys } from "$lib/shortcuts/shortcuts-catalog.ts";

describe("buildShortcutGroups", () => {
	const groups = buildShortcutGroups();

	it("groups shortcuts by area with stable ids", () => {
		expect(groups.map((g) => g.id)).toEqual([
			"general",
			"tools",
			"canvas",
			"saving",
		]);
	});

	it("documents the real global accelerators", () => {
		const general = groups.find((g) => g.id === "general")!;
		const ids = general.entries.map((e) => e.id);
		expect(ids).toContain("command-palette");
		expect(ids).toContain("search");
		expect(ids).toContain("shortcuts");
		const search = general.entries.find((e) => e.id === "search")!;
		expect(search.keys).toEqual(["/"]);
		const help = general.entries.find((e) => e.id === "shortcuts")!;
		expect(help.keys).toEqual(["?"]);
	});

	it("sources editor-tool letters from the live registry", () => {
		const tools = groups.find((g) => g.id === "tools")!;
		const keys = tools.entries.flatMap((e) => e.keys);
		// The dock-dispatched editor shortcuts come from the canonical keymap.
		for (const letter of ["V", "C", "T", "M", "L", "W", "J", "S", "G", "K", "A"]) {
			expect(keys).toContain(letter);
		}
		for (const shifted of ["Shift+B", "Shift+G", "Shift+K", "Shift+L", "Shift+R", "Shift+W"]) {
			expect(keys).toContain(shifted);
		}
		expect(tools.entries.some((e) => e.id === "tool-polygon-lasso")).toBe(true);
	});

	it("uses tool-help copy while keeping tool ids and shortcuts from BUILTIN_TOOLS", () => {
		const tools = groups.find((g) => g.id === "tools")!;
		const bubbleClean = tools.entries.find((e) => e.id === "tool-bubble-clean")!;
		expect(bubbleClean.keys).toEqual(["K"]);
		expect(bubbleClean.label).toBe("เคลียร์บอลลูน");
		expect(bubbleClean.detail).toContain("คลิกในบอลลูน");
	});

	it("translates labels through the injected translator", () => {
		const t = (key: string, fallback: string) => (key === "shortcutsHelp.search" ? "ค้นหา" : fallback);
		const translated = buildShortcutGroups(t);
		const search = translated
			.find((g) => g.id === "general")!
			.entries.find((e) => e.id === "search")!;
		expect(search.label).toBe("ค้นหา");
	});
});

describe("commandPaletteKeys", () => {
	it("returns a two-glyph chord", () => {
		const keys = commandPaletteKeys();
		expect(keys).toHaveLength(2);
		expect(keys[1]).toBe("K");
	});
});
