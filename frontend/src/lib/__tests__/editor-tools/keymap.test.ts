import { describe, expect, it } from "vitest";
import {
	Keymap,
	KeymapConflictError,
	detectKeymapPlatform,
	normalizeKeyBinding,
	type KeymapPlatform,
} from "$lib/editor-tools/keymap.ts";

const EDITOR_CONTEXT = ["editor"];

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

function withNavigatorPlatform<T>(platform: string, userAgent: string, callback: () => T): T {
	const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
	const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");

	Object.defineProperty(navigator, "platform", {
		configurable: true,
		value: platform,
	});
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value: userAgent,
	});

	try {
		return callback();
	} finally {
		if (originalPlatform) {
			Object.defineProperty(navigator, "platform", originalPlatform);
		} else {
			Reflect.deleteProperty(navigator, "platform");
		}
		if (originalUserAgent) {
			Object.defineProperty(navigator, "userAgent", originalUserAgent);
		} else {
			Reflect.deleteProperty(navigator, "userAgent");
		}
	}
}

describe("Keymap binding conflict detection", () => {
	it("detects normalized alias collisions before an action is registered", () => {
		const keymap = new Keymap(
			[{ id: "editor.undo", keys: ["ctrl+z"], when: "editor" }],
			{ platform: "windows" },
		);

		const conflicts = keymap.findConflicts({
			id: "editor.customUndo",
			keys: ["mod+z"],
			when: "editor",
		});

		expect(conflicts).toEqual([
			{
				key: "mod+z",
				context: "editor",
				actionIds: ["editor.undo", "editor.customUndo"],
			},
		]);
		expect(keymap.getAction("editor.customUndo")).toBeUndefined();
	});

	it("throws when reordered compound contexts collide on the same normalized chord", () => {
		const keymap = new Keymap(
			[{ id: "editor.review.accept", keys: ["shift+enter"], when: ["review", "editor"] }],
			{ platform: "mac" },
		);

		expect(() =>
			keymap.register({
				id: "editor.review.altAccept",
				keys: ["Shift+Enter"],
				when: ["editor", "review"],
			}),
		).toThrow(KeymapConflictError);
		expect(keymap.findConflicts()).toEqual([]);
	});
});

describe("Keymap modifier combinations", () => {
	it("normalizes modifiers into a stable order without losing option/alt", () => {
		expect(normalizeKeyBinding("Option + Command + Shift + K", "mac")).toBe(
			"shift+mod+alt+k",
		);
		expect(normalizeKeyBinding("Alt + Control + Shift + K", "windows")).toBe(
			"shift+mod+alt+k",
		);
	});

	it("matches complex mac and windows modifier events to the same portable binding", () => {
		const actions = [{ id: "editor.preview", keys: ["shift+mod+alt+k"], when: "editor" }];
		const macKeymap = new Keymap(actions, { platform: "mac" });
		const windowsKeymap = new Keymap(actions, { platform: "windows" });

		expect(
			macKeymap.resolve(
				keydown("K", { altKey: true, metaKey: true, shiftKey: true }),
				EDITOR_CONTEXT,
			),
		).toBe("editor.preview");
		expect(
			windowsKeymap.resolve(
				keydown("K", { altKey: true, ctrlKey: true, shiftKey: true }),
				EDITOR_CONTEXT,
			),
		).toBe("editor.preview");
		expect(
			windowsKeymap.resolve(
				keydown("K", { altKey: true, metaKey: true, shiftKey: true }),
				EDITOR_CONTEXT,
			),
		).toBeNull();
	});
});

describe("Keymap platform behavior", () => {
	it.each([
		["mac", { metaKey: true }, { ctrlKey: true }],
		["windows", { ctrlKey: true }, { metaKey: true }],
	] satisfies Array<[KeymapPlatform, KeyboardEventInit, KeyboardEventInit]>)(
		"treats mod as the expected system key on %s",
		(platform, acceptedInit, rejectedInit) => {
			const keymap = new Keymap([{ id: "editor.undo", keys: ["mod+z"], when: "editor" }], {
				platform,
			});

			expect(keymap.resolve(keydown("z", acceptedInit), EDITOR_CONTEXT)).toBe("editor.undo");
			expect(keymap.resolve(keydown("z", rejectedInit), EDITOR_CONTEXT)).toBeNull();
		},
	);

	it("keeps mac control and command bindings distinct", () => {
		const keymap = new Keymap(
			[
				{ id: "editor.commandSave", keys: ["command+s"], when: "editor" },
				{ id: "editor.controlSave", keys: ["control+s"], when: "editor" },
			],
			{ platform: "mac" },
		);

		expect(keymap.resolve(keydown("s", { metaKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.commandSave",
		);
		expect(keymap.resolve(keydown("s", { ctrlKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.controlSave",
		);
	});

	it("detects mac and windows platforms from navigator data", () => {
		expect(withNavigatorPlatform("MacIntel", "Mozilla/5.0", detectKeymapPlatform)).toBe("mac");
		expect(withNavigatorPlatform("Win32", "Mozilla/5.0", detectKeymapPlatform)).toBe("windows");
	});
});

describe("Keymap editable target guard", () => {
	it("does not fire editor shortcuts from input or textarea targets by default", () => {
		const keymap = new Keymap(
			[
				{ id: "editor.brush", keys: ["b"], when: "editor" },
				{ id: "editor.boldText", keys: ["mod+b"], when: "editor", allowInInput: true },
			],
			{ platform: "windows" },
		);
		const input = document.createElement("input");
		const textarea = document.createElement("textarea");

		expect(keymap.resolve(keydown("b", {}, input), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(keydown("b", {}, textarea), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(keydown("b", { ctrlKey: true }, input), EDITOR_CONTEXT)).toBe(
			"editor.boldText",
		);
		expect(keymap.resolve(keydown("b", { ctrlKey: true }, textarea), EDITOR_CONTEXT)).toBe(
			"editor.boldText",
		);
	});

	it("treats nested role=textbox and contenteditable targets as editable", () => {
		const keymap = new Keymap([{ id: "editor.brush", keys: ["b"], when: "editor" }], {
			platform: "windows",
		});
		const textbox = document.createElement("div");
		const textboxChild = document.createElement("span");
		const editable = document.createElement("div");
		const editableChild = document.createElement("span");

		textbox.setAttribute("role", "textbox");
		textbox.append(textboxChild);
		editable.setAttribute("contenteditable", "true");
		editable.append(editableChild);

		expect(keymap.resolve(keydown("b", {}, textboxChild), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(keydown("b", {}, editableChild), EDITOR_CONTEXT)).toBeNull();
	});
});

describe("Keymap unbind behavior", () => {
	it("removes a registered action through the returned unbind callback", () => {
		const keymap = new Keymap([{ id: "editor.brush", keys: ["b"], when: "editor" }], {
			platform: "windows",
		});
		const unbind = keymap.register({ id: "editor.eraser", keys: ["e"], when: "editor" });

		expect(keymap.resolve(keydown("e"), EDITOR_CONTEXT)).toBe("editor.eraser");
		expect(unbind()).toBe(true);
		expect(unbind()).toBe(false);
		expect(keymap.resolve(keydown("e"), EDITOR_CONTEXT)).toBeNull();
		expect(keymap.resolve(keydown("b"), EDITOR_CONTEXT)).toBe("editor.brush");
	});

	it("clears collisions after unregistering an action id", () => {
		const keymap = new Keymap([{ id: "editor.undo", keys: ["mod+z"], when: "editor" }], {
			platform: "windows",
		});

		expect(keymap.unregister("editor.undo")).toBe(true);
		expect(keymap.unregister("editor.undo")).toBe(false);
		expect(() =>
			keymap.register({ id: "editor.customUndo", keys: ["ctrl+z"], when: "editor" }),
		).not.toThrow();
		expect(keymap.resolve(keydown("z", { ctrlKey: true }), EDITOR_CONTEXT)).toBe(
			"editor.customUndo",
		);
	});
});
