/**
 * ToolRegistry — declarative contract for the Photopea-style editor left dock.
 *
 * Wave 3 W3.1 (editor shell IA) ships this contract so later waves (notably
 * W3.13, the 8 image tools) can register tools into the left dock and top
 * context bar WITHOUT touching shell layout or the Fabric canvas engine.
 *
 * Design rules:
 * - This module is pure data + a tiny registry. It never imports the canvas
 *   engine and never mutates Fabric state. Activation is delegated to the
 *   caller via `onActivate(ctx)` so the engine contract (`editorStore.setTool`,
 *   coordinate conversion through `imageBounds`) stays the single source of
 *   truth.
 * - `engineTool` maps a dock tool to the existing canvas `Tool` union
 *   ("select" | "cover" | "brush" | "text"). Multiple dock tools may share one
 *   engine tool (e.g. a logical "crop" tool drives the existing "cover"
 *   selection-rectangle tool). New engine tools are added to `Tool` separately
 *   when the engine actually grows new behavior.
 * - `optionsContext` tells the top context bar which contextual option group to
 *   render for the active tool. The crop ratio picker lives under the "crop"
 *   context (relocated out of the old select context).
 */

import type { Tool } from "$lib/types.js";
import { getEditorShortcutForDockTool } from "$lib/editor-tools/keymap.ts";
import { BUCKET_FILL_DOCK_TOOL } from "./tools/bucket-fill-tool.js";
import { ADJUSTMENTS_TOOL_ID } from "./tools/adjustments-tool.js";

/** Logical tool id shown in the dock. A superset of the engine `Tool` union. */
export type ToolId =
	| "select"
	| "translate"
	| "crop"
	| "text"
	| "brush"
	| "cover"
	// W3.13 image-edit suite tool ids. These map 1:1 onto the implemented
	// `frontend/src/lib/editor/tools/*` factories (the suite registry ids) so the
	// dock can activate them through the engine-safe `activateImageTool` callback.
	| "marquee"
	| "lasso"
	| "polygon-lasso"
	| "magic-wand"
	| "magic-clean"
	| "color-range"
	| "bucket-fill"
	| "refine-edge"
	| "healing-brush"
	| "pro-clean"
	| "clone-stamp"
	| "bubble-clean"
	| typeof ADJUSTMENTS_TOOL_ID
	| "screentone-fill"
	// Reserved ids for future image tools. Registering these is opt-in; the dock
	// only renders tools that are actually registered, so unused ids are inert.
	| "hand"
	| "zoom"
	| "transform"
	| "eyedropper"
	| "fill"
	| "shape"
	| "heal"
	| "measure";

/**
 * Image-edit suite tool ids (W3.13). The `ToolActivationContext.activateImageTool`
 * callback expects exactly one of these — they mirror the suite registry ids.
 */
export type ImageEditToolId =
	| "marquee"
	| "lasso"
	| "polygon-lasso"
	| "magic-wand"
	| "magic-clean"
	| "color-range"
	| "bucket-fill"
	| "refine-edge"
	| "healing-brush"
	| "pro-clean"
	| "clone-stamp"
	| "bubble-clean"
	| typeof ADJUSTMENTS_TOOL_ID
	| "screentone-fill";

/** Top-context-bar option group rendered for the active tool. */
export type ToolOptionsContext =
	| "select"
	| "crop"
	| "text"
	| "brush"
	| "ai"
	// W3.13: the active image-edit tool drives the "image-tools" context group.
	| "image-tools"
	| "none";

/** Grouping in the vertical dock; groups render with a separator between them. */
export type ToolGroup = "navigate" | "edit" | "image" | "ai";

export interface ToolActivationContext {
	/** Drives the Fabric engine tool. Wraps `editorStore.setTool`. */
	setEngineTool: (tool: Tool) => void;
	/** Opens/sets the right-panel inspector mode (layers | ai | work | project). */
	setRightPanelMode: (mode: "work" | "layers" | "ai" | "project" | "translate") => void;
	/** Begins interactive text placement (engine text flow). */
	startTextPlacement: () => void;
	/**
	 * Activates one of the 8 W3.13 image-edit suite tools (marquee, lasso, magic
	 * wand, healing, clone, ...). Wraps `editorStore.setImageTool`, which puts the
	 * engine in "select" mode and routes Fabric pointer events into the suite
	 * registry so the chosen tool receives image-space gestures.
	 */
	activateImageTool: (id: ImageEditToolId) => void;
}

export interface ToolDefinition {
	id: ToolId;
	/** Short label shown under the icon / in the tooltip. */
	label: string;
	/** Longer tooltip / aria description. */
	title: string;
	/** Single-glyph icon (emoji or symbol). Snippet-based icons can override in UI. */
	icon: string;
	/** Keyboard shortcut hint, e.g. "V" or "Shift+G". Display-only here. */
	shortcut?: string;
	/** Engine tool this dock tool drives. */
	engineTool: Tool;
	/** Which contextual options the top bar renders when this tool is active. */
	optionsContext: ToolOptionsContext;
	/** Dock grouping. */
	group: ToolGroup;
	/** Lower sorts first within a group. */
	order: number;
	/**
	 * Activation handler. Receives a context with engine-safe callbacks so the
	 * registry never reaches into the engine directly. Defaults to
	 * `ctx.setEngineTool(def.engineTool)` when omitted.
	 */
	onActivate?: (ctx: ToolActivationContext) => void;
	/**
	 * Duty capability required to SEE this tool (2026-06-13): the dock filters
	 * the palette per member duty (chapter-team override → studio role →
	 * account role). Absent ⇒ visible to everyone who can open the editor.
	 * Display-only — the backend still authorizes every mutation.
	 */
	capability?: keyof import("$lib/stores/auth.svelte.ts").RoleCapabilityFlags;
}

const DOCK_GROUP_ORDER: ToolGroup[] = ["navigate", "edit", "image", "ai"];

class ToolRegistry {
	private tools = new Map<ToolId, ToolDefinition>();
	private version = $state(0);

	/** Register (or replace) a tool. Returns an unregister function. */
	register(def: ToolDefinition): () => void {
		this.tools.set(def.id, def);
		this.version += 1;
		return () => this.unregister(def.id);
	}

	/** Register many tools at once. Returns a single unregister-all function. */
	registerMany(defs: ToolDefinition[]): () => void {
		const ids = defs.map((def) => def.id);
		for (const def of defs) this.tools.set(def.id, def);
		this.version += 1;
		return () => {
			for (const id of ids) this.tools.delete(id);
			this.version += 1;
		};
	}

	unregister(id: ToolId): void {
		if (this.tools.delete(id)) this.version += 1;
	}

	get(id: ToolId): ToolDefinition | undefined {
		// touch version so reads stay reactive across (un)registration
		void this.version;
		return this.tools.get(id);
	}

	/** All registered tools, sorted by group then order. */
	list(): ToolDefinition[] {
		void this.version;
		return [...this.tools.values()].sort((a, b) => {
			const groupDelta = DOCK_GROUP_ORDER.indexOf(a.group) - DOCK_GROUP_ORDER.indexOf(b.group);
			if (groupDelta !== 0) return groupDelta;
			return a.order - b.order;
		});
	}

	/** Tools grouped for dock rendering, preserving group order and dropping empties. */
	grouped(): Array<{ group: ToolGroup; tools: ToolDefinition[] }> {
		const list = this.list();
		return DOCK_GROUP_ORDER.map((group) => ({
			group,
			tools: list.filter((tool) => tool.group === group),
		})).filter((bucket) => bucket.tools.length > 0);
	}

	/** Resolve the top-context-bar options group for an active engine tool + dock id. */
	optionsContextFor(toolId: ToolId | null): ToolOptionsContext {
		if (!toolId) return "none";
		void this.version;
		return this.tools.get(toolId)?.optionsContext ?? "none";
	}

	/** Test/reset helper. */
	__resetToBuiltins(): void {
		this.tools.clear();
		this.version += 1;
		for (const def of BUILTIN_TOOLS) this.tools.set(def.id, def);
	}
}

/**
 * Built-in tools shipped with the W3.1 shell. The crop tool intentionally drives
 * the existing "cover" engine tool (the aspect-ratio-constrained selection
 * rectangle) so the canvas engine is untouched; the crop ratio picker moves to
 * the top context bar under the "crop" options context.
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
	{
		id: "select",
		label: "เลือก",
		title: "เลือก / ขยับวัตถุบนหน้า",
		icon: "↖",
		shortcut: getEditorShortcutForDockTool("select"),
		engineTool: "select",
		optionsContext: "select",
		group: "navigate",
		order: 0,
		onActivate: (ctx) => ctx.setEngineTool("select"),
	},
	{
		// NOTE: this tool drives the SAME "cover" engine rectangle as the AI tool
		// below — i.e. it selects a region (with an aspect-ratio framer), it does
		// NOT destructively crop the page image (the editor is single-page and the
		// cover rect is the AI Clean/SFX region, clamped to MAX_AI_CROP_WIDTH).
		// It is labelled as a "region / aspect frame" so users are not misled into
		// expecting a destructive crop that does not exist.
		id: "crop",
		label: "เลือกพื้นที่",
		title: "เลือกพื้นที่ตามสัดส่วน (สำหรับ AI / จัดกรอบ)",
		icon: "⛶",
		shortcut: getEditorShortcutForDockTool("crop"),
		// Reuses the existing aspect-ratio-constrained selection rectangle.
		engineTool: "cover",
		optionsContext: "crop",
		group: "edit",
		order: 0,
		onActivate: (ctx) => ctx.setEngineTool("cover"),
	},
	{
		id: "translate",
		label: "แปล",
		title: "โหมดแปล — จิ้มกรอบคำพูดบนภาพ แล้วพิมพ์คำแปลในแผงข้างขวา",
		icon: "💬",
		engineTool: "select",
		optionsContext: "select",
		group: "edit",
		order: 0.5,
		capability: "canTranslate",
		onActivate: (ctx) => {
			ctx.setEngineTool("select");
			ctx.setRightPanelMode("translate");
		},
	},
	{
		id: "text",
		label: "ข้อความ",
		title: "วางกล่องข้อความใหม่",
		icon: "T",
		shortcut: getEditorShortcutForDockTool("text"),
		engineTool: "text",
		optionsContext: "text",
		group: "edit",
		capability: "canTypeset",
		order: 1,
		onActivate: (ctx) => ctx.startTextPlacement(),
	},
	// W3.13 image-edit suite — the 8 client-side selection/cleanup tools. Each
	// drives the suite registry (engine stays in "select" so Fabric pointer events
	// can be forwarded to the tool) via the engine-safe `activateImageTool`
	// callback. Icons/labels/shortcuts mirror the suite tool factories.
	{
		id: "marquee",
		label: "มาร์คี",
		title: "เลือกพื้นที่สี่เหลี่ยม (Marquee)",
		icon: "▭",
		shortcut: getEditorShortcutForDockTool("marquee"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 1,
		onActivate: (ctx) => ctx.activateImageTool("marquee"),
	},
	{
		id: "lasso",
		label: "ลาสโซ",
		title: "เลือกอิสระแบบลากมือ (Lasso)",
		icon: "◌",
		shortcut: getEditorShortcutForDockTool("lasso"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 2,
		onActivate: (ctx) => ctx.activateImageTool("lasso"),
	},
	{
		id: "polygon-lasso",
		label: "ลาสโซเหลี่ยม",
		title: "เลือกอิสระแบบคลิกเป็นจุด (Polygon Lasso)",
		icon: "⬡",
		shortcut: getEditorShortcutForDockTool("polygon-lasso"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 3,
		onActivate: (ctx) => ctx.activateImageTool("polygon-lasso"),
	},
	{
		id: "magic-wand",
		label: "ไม้กายสิทธิ์",
		title: "เลือกพื้นที่สีใกล้เคียงด้วยคลิกเดียว (Magic Wand)",
		icon: "✦",
		shortcut: getEditorShortcutForDockTool("magic-wand"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 4,
		onActivate: (ctx) => ctx.activateImageTool("magic-wand"),
	},
	{
		id: "magic-clean",
		label: "คลีนบับเบิล",
		title: "เลือกอัจฉริยะและคลีนบับเบิลในคลิกเดียว (Magic Clean)",
		icon: "✦",
		shortcut: getEditorShortcutForDockTool("magic-clean"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 4.5,
		onActivate: (ctx) => ctx.activateImageTool("magic-clean"),
	},
	{
		id: "color-range",
		label: "ช่วงสี",
		title: "เลือกตามช่วงสี / สีที่คล้ายกันทั้งภาพ (Color Range)",
		icon: "◐",
		shortcut: getEditorShortcutForDockTool("color-range"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 5,
		onActivate: (ctx) => ctx.activateImageTool("color-range"),
	},
	BUCKET_FILL_DOCK_TOOL,
	{
		id: "refine-edge",
		label: "ปรับขอบ",
		title: "ขยาย / หด / เบลอขอบของพื้นที่ที่เลือก (Refine Edge)",
		icon: "◎",
		shortcut: getEditorShortcutForDockTool("refine-edge"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 6,
		onActivate: (ctx) => ctx.activateImageTool("refine-edge"),
	},
	{
		id: "healing-brush",
		label: "ซ่อมจุด",
		title: "แปรงซ่อมจุด / ลบรอยตำหนิ (Spot Healing)",
		icon: "✚",
		shortcut: getEditorShortcutForDockTool("healing-brush"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 7,
		onActivate: (ctx) => ctx.activateImageTool("healing-brush"),
	},
	{
		id: "pro-clean",
		label: "คลีนโปร",
		title: "แปรง PRO Clean: คลีนพื้น flat / gradient / texture อัตโนมัติ",
		icon: "✦",
		shortcut: getEditorShortcutForDockTool("pro-clean"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 8,
		onActivate: (ctx) => ctx.activateImageTool("pro-clean"),
	},
	{
		id: "clone-stamp",
		label: "โคลนพื้นที่",
		title: "ปั๊มคัดลอกพื้นที่ (Clone Stamp) — Alt เพื่อตั้งจุดต้นทาง",
		icon: "❖",
		shortcut: getEditorShortcutForDockTool("clone-stamp"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 9,
		onActivate: (ctx) => ctx.activateImageTool("clone-stamp"),
	},
	{
		// W3.13 flagship cleaner — click inside a speech bubble to erase the JP text
		// and fill the interior to clean paper, bounded by the bubble outline. One
		// undoable step per click (runs through the same instant-apply background edit
		// as heal/clone).
		id: "bubble-clean",
		label: "คลีนบอลลูน",
		title: "คลิกในบอลลูนเพื่อลบข้อความและเติมพื้นขาว ไม่ล้นขอบเส้น (Bubble Auto-Clean)",
		icon: "◌",
		shortcut: getEditorShortcutForDockTool("bubble-clean"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 10,
		onActivate: (ctx) => ctx.activateImageTool("bubble-clean"),
	},
	{
		id: ADJUSTMENTS_TOOL_ID,
		label: "ปรับแสงสี",
		title: "ปรับ Brightness / Contrast / Levels / Saturation พร้อมพรีวิวก่อนบันทึก",
		icon: "◑",
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 10.5,
		onActivate: (ctx) => ctx.activateImageTool(ADJUSTMENTS_TOOL_ID),
	},
	{
		id: "screentone-fill",
		label: "สกรีนโทน",
		title: "คลิกเพื่อเติมสกรีนโทนในพื้นที่ หรือเติมจาก mask ที่เลือกไว้",
		icon: "░",
		shortcut: getEditorShortcutForDockTool("screentone-fill"),
		engineTool: "select",
		optionsContext: "image-tools",
		group: "image",
		capability: "canClean",
		order: 11,
		onActivate: (ctx) => ctx.activateImageTool("screentone-fill"),
	},
	{
		id: "cover",
		label: "AI",
		title: "เลือกพื้นที่สำหรับ AI Clean / SFX",
		icon: "✦",
		shortcut: getEditorShortcutForDockTool("cover"),
		engineTool: "cover",
		optionsContext: "ai",
		group: "ai",
		capability: "canGenerateAI",
		order: 0,
		onActivate: (ctx) => {
			ctx.setEngineTool("cover");
			ctx.setRightPanelMode("ai");
		},
	},
];

export const toolRegistry = new ToolRegistry();
toolRegistry.__resetToBuiltins();

/** The 8 image-edit suite ids that share the "select" engine tool. */
const IMAGE_EDIT_TOOL_IDS = new Set<ToolId>([
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
	ADJUSTMENTS_TOOL_ID,
	"screentone-fill",
]);

export function isImageEditToolId(id: ToolId | null | undefined): id is ImageEditToolId {
	return id != null && IMAGE_EDIT_TOOL_IDS.has(id);
}

/**
 * Map an engine `Tool` back to the most likely dock `ToolId` for highlighting.
 *
 * The 8 W3.13 image-edit tools all share the "select" engine tool (they route
 * Fabric pointers into the suite registry while Fabric selection is disabled),
 * so when one is active the live image-tool id wins over the plain "select" id.
 */
export function dockToolIdForEngineTool(
	engineTool: Tool,
	optionsContext?: ToolOptionsContext,
	activeImageToolId?: ImageEditToolId | null,
): ToolId {
	if (engineTool === "cover") {
		// "cover" is shared by crop + AI; prefer the active options context hint.
		return optionsContext === "crop" ? "crop" : "cover";
	}
	if (engineTool === "select") {
		// An active image-edit tool also runs on the "select" engine tool; keep it
		// highlighted instead of snapping back to the plain select tool.
		return activeImageToolId ?? "select";
	}
	if (engineTool === "brush") return "brush";
	return "text";
}
