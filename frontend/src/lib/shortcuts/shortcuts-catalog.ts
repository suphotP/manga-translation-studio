// Keyboard-shortcuts catalog.
//
// A single, pure source of truth for the ShortcutsHelp modal, gathered from the
// REAL handlers in the app rather than invented:
//   • General accelerators — Cmd/Ctrl+K (CommandPalette.onGlobalKeydown),
//     "/" (SearchModal), "?" (ShortcutsHelp), Esc to close any overlay.
//   • Editor tools — the dock-dispatched commands from editor-tools/keymap.ts.
//     Labels + shortcut hints are pulled from the same command bindings that
//     runtime keyboard dispatch uses, so Shift-family variants cannot drift.
//   • Canvas — Space-drag / middle / Alt-drag pan and Alt-wheel zoom from
//     canvas/editor.ts.
//   • Saving — debounced autosave (project.svelte.ts AUTOSAVE_DEBOUNCE_MS),
//     since there is no manual save chord; documenting the real behaviour.
//
// Kept Svelte-free so it is testable and so the modal stays a dumb view. Labels
// resolve through an injected `t(key, fallback)` translator (the same shape the
// command palette uses); fallbacks are English so the module works without i18n.

import { getToolHelp } from "$lib/editor/tool-help.ts";
import { BUILTIN_TOOLS } from "$lib/editor/tool-registry.svelte.ts";
import {
	DEFAULT_EDITOR_COMMAND_BINDINGS,
	editorShortcutHint,
} from "$lib/editor-tools/keymap.ts";

/** Translator shape (matches the `msg(key, fallback)` helper used in views). */
export type ShortcutTranslator = (key: string, fallback: string) => string;

export interface ShortcutEntry {
	/** Stable id for keyed rendering + tests. */
	id: string;
	/** Human description of what the shortcut does. */
	label: string;
	/** Optional second line for contextual help. */
	detail?: string;
	/** One or more key glyphs. Multiple = alternatives (e.g. ["J", "K"]). */
	keys: string[];
	/** Separator between keys: "or" (alternatives) or "then"/"+" (combos). */
	joiner?: "or" | "plus";
}

export interface ShortcutGroup {
	id: string;
	title: string;
	entries: ShortcutEntry[];
}

const identityTranslator: ShortcutTranslator = (_key, fallback) => fallback;

/**
 * Resolve the platform's command-palette chord glyph. SSR / tests get the
 * Control form; mac shows ⌘.
 */
export function commandPaletteKeys(): string[] {
	const isMac =
		typeof navigator !== "undefined" &&
		/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
	return isMac ? ["⌘", "K"] : ["Ctrl", "K"];
}

/**
 * Build the editor-tools group from the canonical editor keymap. Only commands
 * that actually dispatch to a dock tool are listed.
 */
function editorToolEntries(t: ShortcutTranslator): ShortcutEntry[] {
	// Canonical keymap drives the list; localized label/detail come from the
	// shortcutsHelp.* keys with tool-help Thai fallbacks (kept from #558).
	return DEFAULT_EDITOR_COMMAND_BINDINGS.filter(
		(command) => command.dockToolId && command.visibleInShortcutSheet !== false,
	).map((command) => ({
		id: `tool-${command.dockToolId}`,
		label: t(`shortcutsHelp.tool.${command.dockToolId}`, getToolHelp(command.dockToolId!)?.shortcutLabel ?? command.label),
		detail: t(
			`shortcutsHelp.toolDetail.${command.dockToolId}`,
			getToolHelp(command.dockToolId!)?.shortcutDescription ?? command.label,
		),
		keys: [editorShortcutHint(command)],
	}));
}

/**
 * Assemble the full, grouped catalog. Pure: takes only a translator, reads the
 * static tool registry, and resolves the platform palette chord.
 */
export function buildShortcutGroups(t: ShortcutTranslator = identityTranslator): ShortcutGroup[] {
	// Platform modifier glyph: "⌘" on mac, "Ctrl" elsewhere (same resolution the
	// command-palette chord uses).
	const mod = commandPaletteKeys()[0];
	const groups: ShortcutGroup[] = [
		{
			id: "general",
			title: t("shortcutsHelp.group.general", "General"),
			entries: [
				{
					id: "command-palette",
					label: t("shortcutsHelp.commandPalette", "Open the command palette"),
					keys: commandPaletteKeys(),
					joiner: "plus",
				},
				{
					id: "search",
					label: t("shortcutsHelp.search", "Open global search"),
					keys: ["/"],
				},
				{
					id: "shortcuts",
					label: t("shortcutsHelp.shortcuts", "Show this shortcuts list"),
					keys: ["?"],
				},
				{
					id: "close",
					label: t("shortcutsHelp.close", "Close an open dialog / overlay"),
					keys: ["Esc"],
				},
			],
		},
		{
			id: "tools",
			title: t("shortcutsHelp.group.tools", "Editor tools"),
			entries: editorToolEntries(t),
		},
		{
			id: "canvas",
			title: t("shortcutsHelp.group.canvas", "Canvas"),
			entries: [
				{
					id: "canvas-pan",
					label: t("shortcutsHelp.canvasPan", "Pan the canvas (hold, then drag)"),
					keys: ["Space"],
				},
				{
					id: "canvas-pan-alt",
					label: t("shortcutsHelp.canvasPanAlt", "Pan with Alt / middle-mouse drag"),
					keys: ["Alt"],
				},
				{
					id: "canvas-zoom",
					label: t("shortcutsHelp.canvasZoom", "Zoom at the pointer (Alt / Ctrl + scroll)"),
					keys: ["Alt", "Scroll"],
					joiner: "plus",
				},
				{
					id: "canvas-zoom-in",
					label: t("shortcutsHelp.canvasZoomIn", "Zoom in"),
					keys: [mod, "+"],
					joiner: "plus",
				},
				{
					id: "canvas-zoom-out",
					label: t("shortcutsHelp.canvasZoomOut", "Zoom out"),
					keys: [mod, "−"],
					joiner: "plus",
				},
				{
					id: "canvas-zoom-reset",
					label: t("shortcutsHelp.canvasZoomReset", "Reset zoom (fit to screen)"),
					keys: [mod, "0"],
					joiner: "plus",
				},
				{
					id: "layer-nudge",
					label: t("shortcutsHelp.layerNudge", "Nudge the selected text layer (Shift = 10px)"),
					keys: ["←", "→", "↑", "↓"],
				},
			],
		},
		{
			id: "saving",
			title: t("shortcutsHelp.group.saving", "Saving"),
			entries: [
				{
					id: "save-now",
					label: t("shortcutsHelp.saveNow", "Save now (flush pending changes)"),
					keys: [mod, "S"],
					joiner: "plus",
				},
				{
					id: "autosave",
					label: t(
						"shortcutsHelp.autosave",
						"Changes autosave a few seconds after you stop editing",
					),
					keys: ["Auto"],
				},
			],
		},
	];
	return groups.filter((group) => group.entries.length > 0);
}
