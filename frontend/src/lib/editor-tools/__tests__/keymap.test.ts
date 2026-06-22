import { describe, expect, it } from "vitest";
import {
	Keymap,
	KeymapConflictError,
	canonicalEditorActionId,
	createDefaultEditorKeymap,
	deserializeKeymap,
	getDefaultEditorCommandBinding,
	normalizeKeyBinding,
	type KeymapAction,
	type KeymapPlatform,
} from "$lib/editor-tools/keymap.ts";

function keydown(
	key: string,
	init: KeyboardEventInit = {},
	target?: EventTarget,
): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, ...init });
	if (target) {
		Object.defineProperty(event, "target", { value: target });
	}
	return event;
}

function macEvent(key: string, init: KeyboardEventInit = {}, target?: EventTarget): KeyboardEvent {
	return keydown(key, init, target);
}

function windowsEvent(key: string, init: KeyboardEventInit = {}, target?: EventTarget): KeyboardEvent {
	return keydown(key, init, target);
}

const EDITOR_CONTEXT = ["editor"];

describe("Keymap default editor bindings", () => {
	it("resolves the manga editor tool defaults in editor context", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		const expected: Record<string, string> = {
			v: "editor.tool.select",
			m: "editor.tool.marquee",
			l: "editor.tool.lasso",
			w: "editor.tool.magic-wand",
			s: "editor.tool.clone-stamp",
			j: "editor.tool.healing-brush",
			g: "editor.tool.bucket-fill",
			k: "editor.tool.bubble-clean",
			t: "editor.tool.text",
			c: "editor.tool.region-frame",
			a: "editor.tool.ai-region",
			"[": "editor.brush.size.decrease",
			"]": "editor.brush.size.increase",
			x: "editor.colors.swap",
		};

		for (const [key, actionId] of Object.entries(expected)) {
			expect(keymap.resolve(windowsEvent(key), EDITOR_CONTEXT), key).toBe(actionId);
		}
	});

	it("does not resolve editor defaults without the editor context", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		expect(keymap.resolve(windowsEvent("b"))).toBeNull();
		expect(keymap.resolve(windowsEvent("z", { ctrlKey: true }))).toBeNull();
	});

	it("keeps shifted letters distinct from plain tool letters", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		expect(keymap.resolve(windowsEvent("K", { shiftKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.tool.magic-clean",
		);
		expect(keymap.resolve(windowsEvent("k"), EDITOR_CONTEXT)).toBe("editor.tool.bubble-clean");
	});

	it("resolves the new manga-specific shifted family shortcuts", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		const expected: Array<[KeyboardEvent, string]> = [
			[windowsEvent("G", { shiftKey: true }), "editor.tool.screentone-fill"],
			[windowsEvent("L", { shiftKey: true }), "editor.tool.polygon-lasso"],
			[windowsEvent("W", { shiftKey: true }), "editor.tool.color-range"],
			[windowsEvent("K", { shiftKey: true }), "editor.tool.magic-clean"],
			[windowsEvent("R", { shiftKey: true }), "editor.tool.refine-edge"],
		];

		for (const [event, actionId] of expected) {
			expect(keymap.resolve(event, EDITOR_CONTEXT), actionId).toBe(actionId);
		}
	});

	it("keeps bare fill and screentone fill separated", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		expect(keymap.findConflicts()).toEqual([]);
		expect(keymap.resolve(windowsEvent("g"), EDITOR_CONTEXT)).toBe("editor.tool.bucket-fill");
		expect(keymap.resolve(windowsEvent("G", { shiftKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.tool.screentone-fill",
		);
	});

	it("uses physical Latin key codes for editor accelerators on non-Latin layouts", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		expect(keymap.resolve(windowsEvent("เ", { code: "KeyG" }), EDITOR_CONTEXT)).toBe(
			"editor.tool.bucket-fill",
		);
		expect(
			keymap.resolve(windowsEvent("เ", { code: "KeyG", shiftKey: true }), EDITOR_CONTEXT),
		).toBe("editor.tool.screentone-fill");
	});

	it("uses Cmd as mod on mac and Ctrl as mod elsewhere", () => {
		const macKeymap = createDefaultEditorKeymap({ platform: "mac" });
		const windowsKeymap = createDefaultEditorKeymap({ platform: "windows" });

		expect(macKeymap.resolve(macEvent("z", { metaKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.undo",
		);
		expect(macKeymap.resolve(macEvent("z", { ctrlKey: true }), EDITOR_CONTEXT)).toBeNull();
		expect(windowsKeymap.resolve(windowsEvent("z", { ctrlKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.undo",
		);
		expect(windowsKeymap.resolve(windowsEvent("z", { metaKey: true }), EDITOR_CONTEXT)).toBeNull();
	});

	it("resolves redo with shift+mod+z regardless of modifier order in the binding", () => {
		const keymap = new Keymap(
			[
				{
					id: "redo",
					keys: ["mod+shift+z"],
					when: "editor",
				},
			],
			{ platform: "mac" },
		);
		expect(keymap.getAction("redo")?.keys).toEqual(["shift+mod+z"]);
		expect(keymap.resolve(macEvent("Z", { metaKey: true, shiftKey: true }), EDITOR_CONTEXT)).toBe(
			"redo",
		);
	});
});

describe("Keymap resolution guards", () => {
	it("ignores keydown repeat unless the action opts in", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });

		expect(keymap.resolve(windowsEvent("g", { repeat: true }), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(windowsEvent("]", { repeat: true }), EDITOR_CONTEXT)).toBe(
			"editor.brush.size.increase",
		);
	});

	it("ignores input and textarea targets unless allowInInput is set", () => {
		const input = document.createElement("input");
		const textarea = document.createElement("textarea");
		const keymap = new Keymap(
			[
				{ id: "brush", keys: ["b"], when: "editor" },
				{ id: "save", keys: ["mod+s"], when: "editor", allowInInput: true },
			],
			{ platform: "windows" },
		);

		expect(keymap.resolve(windowsEvent("b", {}, input), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(windowsEvent("b", {}, textarea), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(windowsEvent("s", { ctrlKey: true }, input), EDITOR_CONTEXT)).toBe(
			"save",
		);
	});

	it("walks up from nested contenteditable children before resolving", () => {
		const editable = document.createElement("div");
		const child = document.createElement("span");
		editable.setAttribute("contenteditable", "true");
		editable.append(child);
		const keymap = new Keymap([{ id: "brush", keys: ["b"], when: "editor" }], {
			platform: "windows",
		});

		expect(keymap.resolve(windowsEvent("b", {}, child), EDITOR_CONTEXT)).toBeNull();
	});

	it("returns null for non-keydown events and bare modifier keys", () => {
		const keymap = new Keymap([{ id: "brush", keys: ["b"] }], { platform: "windows" });
		const keyup = new KeyboardEvent("keyup", { key: "b" });
		expect(keymap.resolve(keyup)).toBeNull();
		expect(keymap.resolve(windowsEvent("Shift", { shiftKey: true }))).toBeNull();
	});
});

describe("Keymap conflicts and contexts", () => {
	it("throws a conflict for duplicate key chords in the same context", () => {
		const keymap = new Keymap([{ id: "brush", keys: ["b"], when: "editor" }], {
			platform: "windows",
		});

		expect(() => keymap.register({ id: "burn", keys: ["shift+b"], when: "editor" })).not.toThrow();
		expect(() => keymap.register({ id: "bold", keys: ["b"], when: "editor" })).toThrow(
			KeymapConflictError,
		);
	});

	it("detects conflicts before registering a remap", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		const conflicts = keymap.findConflicts({
			id: "custom.brush",
			keys: ["ctrl+z"],
			when: "editor",
		});

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			key: "mod+z",
			context: "editor",
			actionIds: ["editor.undo", "custom.brush"],
		});
	});

	it("allows the same key in a different context and prefers scoped matches over globals", () => {
		const keymap = new Keymap(
			[
				{ id: "global.search", keys: ["/"] },
				{ id: "editor.search", keys: ["/"], when: "editor" },
				{ id: "review.search", keys: ["/"], when: "review" },
			],
			{ platform: "windows" },
		);

		expect(keymap.resolve(windowsEvent("/"))).toBe("global.search");
		expect(keymap.resolve(windowsEvent("/"), EDITOR_CONTEXT)).toBe("editor.search");
		expect(keymap.resolve(windowsEvent("/"), ["review"])).toBe("review.search");
	});

	it("requires every context in a compound when clause", () => {
		const keymap = new Keymap(
			[
				{ id: "editor.open", keys: ["o"], when: "editor" },
				{ id: "crop.open", keys: ["o"], when: ["crop", "editor"] },
			],
			{ platform: "windows" },
		);

		expect(keymap.resolve(windowsEvent("o"), EDITOR_CONTEXT)).toBe("editor.open");
		expect(keymap.resolve(windowsEvent("o"), ["editor", "crop"])).toBe("crop.open");
	});

	it("rejects duplicate action ids and duplicate bindings inside one action", () => {
		const keymap = new Keymap([{ id: "brush", keys: ["b"] }], { platform: "windows" });

		expect(() => keymap.register({ id: "brush", keys: ["x"] })).toThrow(/already registered/);
		expect(() => new Keymap([{ id: "dupe", keys: ["mod+z", "ctrl+z"] }], {
			platform: "windows",
		})).toThrow(/Duplicate key binding/);
	});
});

describe("Keymap serialization", () => {
	it("round-trips normalized actions for future user remapping", () => {
		const original = new Keymap(
			[
				{
					id: "paint",
					keys: ["B", "shift+P"],
					when: ["paint", "editor"],
					allowRepeat: true,
					label: "Paint",
					group: "tools",
					order: 5,
				},
			],
			{ platform: "mac" },
		);

		const serialized = original.serialize();
		expect(serialized).toEqual({
			version: 1,
			actions: [
				{
					id: "paint",
					keys: ["b", "shift+p"],
					when: ["editor", "paint"],
					allowRepeat: true,
					label: "Paint",
					group: "tools",
					order: 5,
				},
			],
		});

		const restored = deserializeKeymap(serialized, { platform: "mac" });
		expect(restored.resolve(macEvent("p", { shiftKey: true }), ["editor", "paint"])).toBe(
			"paint",
		);
		expect(restored.serialize()).toEqual(serialized);
	});

	it("rejects unsupported serialized versions", () => {
		expect(() =>
			deserializeKeymap(
				{
					version: 2,
					actions: [],
				} as unknown as Parameters<typeof deserializeKeymap>[0],
			),
		).toThrow(/Unsupported keymap version/);
	});
});

describe("Editor command compatibility metadata", () => {
	it("maps legacy action ids to the canonical editor command ids", () => {
		expect(canonicalEditorActionId("editor.tool.move")).toBe("editor.tool.select");
		expect(canonicalEditorActionId("editor.tool.healing")).toBe("editor.tool.healing-brush");
		expect(canonicalEditorActionId("editor.tool.fill")).toBe("editor.tool.bucket-fill");
		expect(canonicalEditorActionId("editor.tool.crop")).toBe("editor.tool.region-frame");
	});

	it("exposes dock and suite dispatch targets for real tool commands only", () => {
		expect(getDefaultEditorCommandBinding("editor.tool.bucket-fill")).toMatchObject({
			dockToolId: "bucket-fill",
			suiteToolId: "bucket-fill",
		});
		expect(getDefaultEditorCommandBinding("editor.brush.size.increase")?.dockToolId).toBeUndefined();
	});
});

describe("Keymap cheatSheet", () => {
	it("returns render-ready grouped defaults with stable groups", () => {
		const keymap = createDefaultEditorKeymap({ platform: "windows" });
		const sheet = keymap.cheatSheet();

		expect(sheet.map((group) => group.id)).toEqual([
			"color",
			"history",
			"manga",
			"paint",
			"selection",
		]);
		expect(sheet.find((group) => group.id === "selection")?.entries.map((entry) => entry.id)).toEqual([
			"editor.tool.select",
			"editor.tool.marquee",
			"editor.tool.lasso",
			"editor.tool.polygon-lasso",
			"editor.tool.magic-wand",
			"editor.tool.color-range",
			"editor.tool.region-frame",
			"editor.tool.refine-edge",
		]);
		expect(sheet.find((group) => group.id === "history")?.entries).toMatchObject([
			{ id: "editor.undo", keys: ["mod+z"], label: "Undo", when: "editor" },
			{ id: "editor.redo", keys: ["shift+mod+z"], label: "Redo", when: "editor" },
		]);
	});
});

describe("normalizeKeyBinding", () => {
	it("normalizes platform-specific aliases", () => {
		const cases: Array<[string, KeymapPlatform, string]> = [
			["Command+Z", "mac", "mod+z"],
			["Meta+Z", "mac", "mod+z"],
			["Control+Z", "mac", "ctrl+z"],
			["Control+Z", "windows", "mod+z"],
			["Option+B", "mac", "alt+b"],
			["Esc", "windows", "escape"],
			["ArrowLeft", "windows", "left"],
		];

		for (const [binding, platform, expected] of cases) {
			expect(normalizeKeyBinding(binding, platform)).toBe(expected);
		}
	});

	it("rejects invalid bindings", () => {
		const invalidActions: KeymapAction[] = [
			{ id: "empty", keys: [] },
			{ id: "blank", keys: [""] },
			{ id: "two-keys", keys: ["b+c"] },
			{ id: "modifier-only", keys: ["shift"] },
		];

		for (const action of invalidActions) {
			expect(() => new Keymap([action], { platform: "windows" }), action.id).toThrow();
		}
	});
});
