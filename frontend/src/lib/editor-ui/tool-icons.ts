// Keep icons as path-only data so every editor toolbar can apply one Lucide-like
// SVG stroke style without duplicating markup or per-icon presentation choices.
//
// Keys MUST be real dock ToolId values from tool-registry.svelte.ts (codex P2:
// an earlier draft used invented ids, which type-checked via Record<string,…>
// but rendered empty paths for every actual tool).
import type { ToolId } from "$lib/editor/tool-registry.svelte.js";

export const TOOL_ICONS: Partial<Record<ToolId, string>> = {
	translate: "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9h8M8 12h5",
	select: "M12 3v18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
	crop: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2",
	text: "M5 5h14M12 5v14M9 19h6M7 5l-1 4M17 5l1 4",
	brush: "M4 20c3.2 0 5.5-1.2 6.7-3.8L18.5 8.4a2.4 2.4 0 0 0-3.4-3.4l-7.8 7.8C4.7 14 4 16.8 4 20zM13.5 7.5l3 3",
	marquee: "M5 5h5M14 5h5M19 5v5M19 14v5M19 19h-5M10 19H5M5 19v-5M5 10V5",
	lasso: "M7.5 15.5c-2.4-1.1-3.5-3-2.8-5 .9-2.6 4.3-4.1 8.1-3.4 4.6.8 7.4 3.9 6.2 6.8-1 2.5-4.9 3.6-8.9 2.4M8.5 15.9c1.2 2.3 3 3.6 5.5 4.1M14 20c2.2.4 4 .1 5.5-.9",
	"polygon-lasso": "M5 9l5-5 6 2 3 6-4 7H8l-3-4zM5 9l3 6M10 4l-2 11M16 6l-8 9",
	"magic-wand": "M6 18L18 6M15 3l.8 2.2L18 6l-2.2.8L15 9l-.8-2.2L12 6l2.2-.8zM20 11l.5 1.5L22 13l-1.5.5L20 15l-.5-1.5L18 13l1.5-.5zM4 3l.5 1.5L6 5l-1.5.5L4 7l-.5-1.5L2 5l1.5-.5z",
	"magic-clean": "M12 3l1.5 4L17 8.5l-3.5 1.5L12 14l-1.5-4L7 8.5 10.5 7zM5 16l2 2M7 16l-2 2M18 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z",
	"color-range": "M12 3c3 4 6 7.2 6 10.2A6 6 0 0 1 6 13.2C6 10.2 9 7 12 3zM8 14h8",
	"bucket-fill": "M4 13l7-7 7 7-7 7-7-7zM7 10l7 7M19 16c1.3 1.5 2 2.7 2 3.6A2.1 2.1 0 0 1 16.8 19.6c0-.9.7-2.1 2.2-3.6zM5 13h13",
	"refine-edge": "M5 5h14v14H5zM5 9h14M5 13h14M9 5v14M13 5v14",
	"healing-brush": "M7 14l7-7a3 3 0 0 1 4 4l-7 7a3 3 0 0 1-4-4zM9.5 11.5l3 3M13.5 7.5l3 3M6 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z",
	"pro-clean": "M4 20c2.8-.2 5-1.8 5.8-4.4L17 8.4a2.1 2.1 0 0 0-3-3L6.8 12.6C4.2 13.4 4 16.2 4 20zM14 5l2-2M17 8l3-1M10 14l-3 3",
	"clone-stamp": "M9 13h6M10 13l-1 6h6l-1-6M12 13V8M10 8a2 2 0 1 1 4 0v5M6 21h12M7 18h10",
	"bubble-clean": "M12 4c4.4 0 8 2.9 8 6.5 0 3.6-3.6 6.5-8 6.5-.8 0-1.6-.1-2.3-.3L6 19l.8-3.2C5.1 14.6 4 12.6 4 10.5 4 6.9 7.6 4 12 4zM9 10h6",
	adjustments: "M4 7h4M12 7h8M10 5v4M4 12h10M18 12h2M16 10v4M4 17h7M15 17h5M13 15v4",
	"screentone-fill": "M4 4h16v16H4zM8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01",
	cover: "M4 5h16v14H4zM4 15l4-4 3 3 5-5 4 4M9 9h.01",
};

/** Generic fallback glyph (dotted square) so an unmapped id never renders an empty path. */
export const DEFAULT_TOOL_ICON = "M5 5h2M11 5h2M17 5h2M5 11h2M17 11h2M5 17h2M11 17h2M17 17h2";

export function toolIconPath(id: string): string {
	return TOOL_ICONS[id as ToolId] ?? DEFAULT_TOOL_ICON;
}
