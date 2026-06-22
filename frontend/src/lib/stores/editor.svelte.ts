// Editor store — canvas tool state, text layer operations

import { config } from "$lib/config.js";
import { pageLockId } from "$lib/collab/page-lock-id.ts";
import { canUseMultiPageMode } from "$lib/editor/long-page-guardrails.js";
import { resolveArrowPageStep, type ReadingDirection } from "$lib/project/reading-direction.js";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { editorUiStore, type WorkspaceView } from "$lib/stores/editor-ui.svelte.ts";
import { locksStore } from "$lib/stores/locks.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { toastsStore } from "$lib/stores/toasts.svelte.ts";
import { safeRandomId } from "$lib/utils/id.js";
import { isAiResultImageLayer, type ImageLayer, type ImageEditLayer, type Tool, type TextLayer, type TextLayerEffects, type TextStylePresetStyle } from "$lib/types.js";
import { dutyAllowsTool } from "$lib/editor/duty-profile.ts";
import {
	createDefaultEditorKeymap,
	getDefaultEditorCommandBinding,
} from "$lib/editor-tools/keymap.ts";
import {
	toolRegistry,
	type ImageEditToolId,
	type ToolId,
	type ToolActivationContext,
} from "$lib/editor/tool-registry.svelte.ts";
import {
	ADJUSTMENTS_TOOL_ID,
	type AdjustmentsToolOptions,
	type PartialAdjustmentsToolOptions,
} from "$lib/editor/tools/adjustments-tool.ts";
import type { EditorHistoryEntry } from "$lib/canvas/editor.ts";
import type { ImageEditSuite } from "$lib/editor/tools/registry.ts";

type LayerClipboardItem =
	| { kind: "text"; id: string }
	| { kind: "image"; id: string };

type ClipboardLayerSelection =
	| { kind: "text"; layer: TextLayer }
	| { kind: "image"; layer: ImageLayer };

export type BrushMode = "erase" | "restore";

export interface ImageLayerBrushCommitReceipt {
	layerId: string;
	title: string;
	mode: BrushMode;
	restoreImageId?: string;
}

type RgbaTuple = [number, number, number, number];

function normalizeToolHexColor(value: string, fallback = "#FFFFFF"): string {
	const trimmed = value.trim();
	const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (/^#[0-9a-fA-F]{3}$/.test(withHash)) {
		const [, r, g, b] = withHash;
		return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
	}
	if (/^#[0-9a-fA-F]{6}$/.test(withHash)) return withHash.toUpperCase();
	return fallback;
}

function hexToRgbaTuple(hex: string): RgbaTuple {
	const normalized = normalizeToolHexColor(hex);
	return [
		parseInt(normalized.slice(1, 3), 16),
		parseInt(normalized.slice(3, 5), 16),
		parseInt(normalized.slice(5, 7), 16),
		255,
	];
}
const EDITOR_SHORTCUT_CONTEXT = ["editor"] as const;
const EDITOR_SHORTCUT_KEYMAP = createDefaultEditorKeymap();

// Stable code unions for the brush-target labels that UI consumers render. The
// producer emits a CODE; each consumer localizes via $_("brushTarget.<...>.<code>")
// and compares on the code, never on the (formerly Thai) label text. The
// Thai→code mapping is documented on imageLayerEraseLabelCode/RestoreLabelCode
// and the ai-mask/unavailable branches below.
export type BrushEraseLabelCode =
	| "layerErase" // ลบจากเลเยอร์
	| "aiResultErase" // ลบจากผล AI
	| "creditErase" // ลบเครดิตเลเยอร์
	| "referenceErase" // ลบจากรูปอ้างอิง
	| "aiMaskHide"; // ซ่อนผล AI

export type BrushRestoreLabelCode =
	| "layerRestore" // คืนรอยปัด
	| "aiResultRestore" // คืนรอยปัดผล AI
	| "creditRestore" // กู้คืนเครดิต
	| "referenceRestore" // กู้คืนรูปอ้างอิง
	| "aiMaskRestore"; // กู้คืนผล AI

// Code for the fixed-Thai title cases only. When `null`, `title` already holds a
// dynamic display name (layer/text content) that needs no localization.
export type BrushTitleCode =
	| "pickTarget" // เลือกเลเยอร์รูปหรือผล AI
	| "flattenedLegacy" // โหมดเก่าที่แบนบนหน้า
	| "textLayerFallback"; // เลเยอร์ข้อความ

// Stable code for the brush-target `label` text. Consumers (ToolOptionsBar) used
// to value-match the rendered Thai `label` (`=== "ผล AI ที่วางแล้ว"`) to decide
// which "editing:" prefix to show; they now compare on this code instead, so the
// label text can be localized/changed without breaking the match. The label text
// stays Thai for the out-of-batch (#492) status-message path.
export type BrushLabelCode =
	| "aiResult" // ผล AI ที่วางแล้ว
	| "imageCredit" // เครดิตรูป
	| "reference" // รูปอ้างอิง
	| "imageLayer" // เลเยอร์รูปแก้ไข
	| "aiMaskLegacy" // ผล AI เก่า
	| "layerHidden" // เลเยอร์ถูกซ่อน
	| "layerLocked" // เลเยอร์ล็อก
	| "textSelected" // เลือกข้อความอยู่
	| "pickTarget"; // ยังไม่เลือกเลเยอร์

export interface BrushTargetState {
	kind: "image-layer" | "ai-mask" | "unavailable";
	label: string;
	labelCode: BrushLabelCode;
	title: string;
	titleCode: BrushTitleCode | null;
	detail: string;
	scope: string;
	impact: string;
	eraseLabelCode: BrushEraseLabelCode;
	restoreLabelCode: BrushRestoreLabelCode;
	restoreHint: string;
	canBrush: boolean;
	canRestore: boolean;
	canClearMask: boolean;
	tone: "ready" | "blocked";
}

const unavailableBrushTarget: BrushTargetState = {
	kind: "unavailable",
	label: "ยังไม่เลือกเลเยอร์",
	labelCode: "pickTarget",
	title: "",
	titleCode: "pickTarget",
	detail: "เลือกเลเยอร์รูปหรือผล AI เพื่อใช้แปรง ภาพฐานจะไม่ถูกแก้",
	scope: "ภาพฐานล็อกไว้",
	impact: "ยังไม่แตะงานบนหน้า",
	eraseLabelCode: "layerErase",
	restoreLabelCode: "layerRestore",
	restoreHint: "เลือกเลเยอร์รูปที่มีต้นฉบับก่อนใช้โหมดกู้คืน",
	canBrush: false,
	canRestore: false,
	canClearMask: false,
	tone: "blocked",
};

const NEUTRAL_ADJUSTMENTS_OPTIONS: AdjustmentsToolOptions = {
	brightness: 0,
	contrast: 0,
	levels: {
		inBlack: 0,
		inWhite: 255,
		gamma: 1,
		outBlack: 0,
		outWhite: 255,
	},
	hsl: {
		hue: 0,
		saturation: 0,
		lightness: 0,
	},
};

function cloneAdjustmentsOptions(options: AdjustmentsToolOptions): AdjustmentsToolOptions {
	return {
		brightness: options.brightness,
		contrast: options.contrast,
		levels: { ...options.levels },
		hsl: { ...options.hsl },
	};
}

function imageLayerDisplayName(layer: ImageLayer): string {
	return layer.name || layer.originalName || layer.imageName;
}

function imageLayerTargetLabel(layer: ImageLayer): string {
	if (isAiResultImageLayer(layer)) return "ผล AI ที่วางแล้ว";
	if (layer.role === "credit") return "เครดิตรูป";
	if (layer.role === "reference") return "รูปอ้างอิง";
	return "เลเยอร์รูปแก้ไข";
}

function imageLayerTargetLabelCode(layer: ImageLayer): BrushLabelCode {
	if (isAiResultImageLayer(layer)) return "aiResult";
	if (layer.role === "credit") return "imageCredit";
	if (layer.role === "reference") return "reference";
	return "imageLayer";
}

function canUseCleanBrushOnImageLayer(layer: ImageLayer): boolean {
	return layer.role !== "credit";
}

function imageLayerTargetDetail(layer: ImageLayer): string {
	if (isAiResultImageLayer(layer)) {
		return "แปรงจะลบเฉพาะผล AI ที่วางเป็นเลเยอร์นี้ ภาพฐานและผล AI อื่นไม่ถูกแตะ.";
	}
	if (layer.role === "credit") {
		return "ลบเฉพาะเครดิตเลเยอร์นี้ ไม่ใช่เครดิตที่ฝังอยู่ในภาพฐาน.";
	}
	if (layer.role === "reference") {
		return "แปรงจะลบเฉพาะรูปอ้างอิงนี้ ภาพฐานและเลเยอร์อื่นไม่ถูกแตะ.";
	}
	return "เส้นแปรงจะลบเฉพาะเนื้อภาพของเลเยอร์นี้และเผยภาพต้นฉบับข้างใต้.";
}

function imageLayerEraseLabelCode(layer: ImageLayer): BrushEraseLabelCode {
	if (isAiResultImageLayer(layer)) return "aiResultErase"; // ลบจากผล AI
	if (layer.role === "credit") return "creditErase"; // ลบเครดิตเลเยอร์
	if (layer.role === "reference") return "referenceErase"; // ลบจากรูปอ้างอิง
	return "layerErase"; // ลบจากเลเยอร์
}

function imageLayerRestoreLabelCode(layer: ImageLayer): BrushRestoreLabelCode {
	if (isAiResultImageLayer(layer)) return "aiResultRestore"; // คืนรอยปัดผล AI
	if (layer.role === "credit") return "creditRestore"; // กู้คืนเครดิต
	if (layer.role === "reference") return "referenceRestore"; // กู้คืนรูปอ้างอิง
	return "layerRestore"; // คืนรอยปัด
}

// Thai status-message text for the brush label codes. Status messages are an
// out-of-batch (#492) localization cluster, so they stay Thai here; the UI
// labels are localized in the consumers via $_("brushTarget.*").
const BRUSH_ERASE_LABEL_STATUS_TH: Record<BrushEraseLabelCode, string> = {
	layerErase: "ลบจากเลเยอร์",
	aiResultErase: "ลบจากผล AI",
	creditErase: "ลบเครดิตเลเยอร์",
	referenceErase: "ลบจากรูปอ้างอิง",
	aiMaskHide: "ซ่อนผล AI",
};

const BRUSH_RESTORE_LABEL_STATUS_TH: Record<BrushRestoreLabelCode, string> = {
	layerRestore: "คืนรอยปัด",
	aiResultRestore: "คืนรอยปัดผล AI",
	creditRestore: "กู้คืนเครดิต",
	referenceRestore: "กู้คืนรูปอ้างอิง",
	aiMaskRestore: "กู้คืนผล AI",
};

// titleCode -> Thai for the STORE-side status message only (the Svelte HUD localizes
// titleCode via $_). A fixed-title target (titleCode != null) keeps `title` empty, so
// the status line resolves it here to avoid a dangling `label: ` (the legacy AI-mask case).
const BRUSH_TITLE_STATUS_TH: Record<BrushTitleCode, string> = {
	pickTarget: "เลือกเลเยอร์รูปหรือผล AI",
	flattenedLegacy: "โหมดเก่าที่แบนบนหน้า",
	textLayerFallback: "เลเยอร์ข้อความ",
};

export function resolveBrushTargetState(
	selectedLayer: TextLayer | null,
	selectedImageLayer: ImageLayer | null,
	editor: any,
): BrushTargetState {
	if (selectedImageLayer) {
		if (selectedImageLayer.visible === false) {
			return {
				...unavailableBrushTarget,
				label: "เลเยอร์ถูกซ่อน",
				labelCode: "layerHidden",
				title: imageLayerDisplayName(selectedImageLayer),
				titleCode: null,
				detail: "เปิดเลเยอร์นี้ก่อนถ้าต้องการลบหรือกู้คืน",
				scope: "ภาพฐานล็อกไว้ / เลเยอร์ซ่อน",
				impact: "ไม่มี pixel ถูกแก้",
			};
		}
		if (selectedImageLayer.locked === true) {
			return {
				...unavailableBrushTarget,
				label: "เลเยอร์ล็อก",
				labelCode: "layerLocked",
				title: imageLayerDisplayName(selectedImageLayer),
				titleCode: null,
				detail: "ปลดล็อกเลเยอร์นี้ก่อนถ้าตั้งใจแก้รูปเสริม",
				scope: "ภาพฐานล็อกไว้ / เลเยอร์ล็อก",
				impact: "ไม่มี pixel ถูกแก้",
			};
		}
		if (!canUseCleanBrushOnImageLayer(selectedImageLayer)) {
			return {
				...unavailableBrushTarget,
				label: "เครดิตรูป",
				labelCode: "imageCredit",
				title: imageLayerDisplayName(selectedImageLayer),
				titleCode: null,
				detail: "เครดิตรูปให้แก้ตำแหน่ง/ขนาด/ลบด้วยเครื่องมือเครดิต ไม่ใช้แปรงคลีน",
				scope: "ภาพฐานล็อกไว้ / เครดิตไม่ใช้แปรง",
				impact: "ไม่มี pixel ถูกแก้",
			};
		}
		const canRestore = Boolean(selectedImageLayer.restoreImageId);
		return {
			kind: "image-layer",
			label: imageLayerTargetLabel(selectedImageLayer),
			labelCode: imageLayerTargetLabelCode(selectedImageLayer),
			title: imageLayerDisplayName(selectedImageLayer),
			titleCode: null,
			detail: imageLayerTargetDetail(selectedImageLayer),
			scope: "แก้เฉพาะเลเยอร์นี้",
			impact: "มีผลตอนบันทึกและ Export",
			eraseLabelCode: imageLayerEraseLabelCode(selectedImageLayer),
			restoreLabelCode: imageLayerRestoreLabelCode(selectedImageLayer),
			restoreHint: canRestore
				? isAiResultImageLayer(selectedImageLayer)
					? "กู้คืนจากผล AI เดิมของเลเยอร์นี้ก่อนถูกแปรง"
					: "กู้คืนจากต้นฉบับของเลเยอร์ก่อนถูกแปรง"
				: isAiResultImageLayer(selectedImageLayer)
					? "โหมดกู้คืนจะเปิดหลังจากผล AI เลเยอร์นี้มีรอยแปรงหรือต้นฉบับ"
					: "โหมดกู้คืนจะเปิดหลังจากเลเยอร์นี้มีรอยแปรงหรือต้นฉบับ",
			canBrush: true,
			canRestore,
			canClearMask: false,
			tone: "ready",
		};
	}

	if (selectedLayer) {
		const textLayerName = selectedLayer.name || selectedLayer.text || "";
		return {
			...unavailableBrushTarget,
			label: "เลือกข้อความอยู่",
			labelCode: "textSelected",
			// Dynamic layer name when present; otherwise localize the "เลเยอร์ข้อความ" fallback.
			title: textLayerName,
			titleCode: textLayerName ? null : "textLayerFallback",
			detail: "ข้อความต้องแก้ด้วยคุณสมบัติหรือคำสั่งลบ ไม่ใช่แปรง",
			scope: "ภาพฐานล็อกไว้ / ข้อความไม่ใช้แปรง",
			impact: "เลเยอร์ข้อความไม่ถูกเปลี่ยน",
		};
	}

	if (typeof editor?.hasAiMaskBrushTarget === "function" && editor.hasAiMaskBrushTarget()) {
		return {
			kind: "ai-mask",
			label: "ผล AI เก่า",
			labelCode: "aiMaskLegacy",
			title: "",
			titleCode: "flattenedLegacy",
			detail: "เส้นแปรงซ่อนเฉพาะผล AI ที่วางทับภาพฐานเดิม; การคืนผลเต็มจะเขียนภาพหน้าแก้ไขใหม่ ไม่ใช่การย้อนกลับไปต้นฉบับ.",
			scope: "แก้ผล AI ที่แบนบนหน้า",
			impact: "มีผลตอนบันทึกและ Export เป็นภาพหน้าแก้ไข",
			eraseLabelCode: "aiMaskHide",
			restoreLabelCode: "aiMaskRestore",
			restoreHint: "โหมดเก่าเดิมยังไม่รองรับกู้คืนด้วยแปรง ใช้คืนผล AI เต็มเมื่อต้องการเขียนผล AI ทั้งภาพลงหน้า",
			canBrush: true,
			canRestore: false,
			canClearMask: true,
			tone: "ready",
		};
	}

	return unavailableBrushTarget;
}

const SHORTCUT_KEY_CODES = {
	a: "KeyA",
	c: "KeyC",
	d: "KeyD",
	t: "KeyT",
	v: "KeyV",
	y: "KeyY",
	z: "KeyZ",
} as const;

type ShortcutKey = keyof typeof SHORTCUT_KEY_CODES;

export function matchesShortcutKey(event: KeyboardEvent, key: ShortcutKey): boolean {
	return event.key.toLowerCase() === key || event.code === SHORTCUT_KEY_CODES[key];
}

function plainKeyEventLike(key: string): KeyboardEvent {
	return {
		type: "keydown",
		key,
		code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		repeat: false,
		target: null,
	} as KeyboardEvent;
}

export function resolvePageNavigationShortcut(
	event: KeyboardEvent,
	options: { ignoreBrushBracketKeys?: boolean; readingDirection?: ReadingDirection } = {},
): "prev" | "next" | null {
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	const key = event.key.toLowerCase();
	const bracketLeft = key === "[" || event.code === "BracketLeft";
	const bracketRight = key === "]" || event.code === "BracketRight";
	if (options.ignoreBrushBracketKeys && (bracketLeft || bracketRight)) return null;
	const direction = options.readingDirection ?? "ltr";
	// Physical arrow keys follow reading direction (RTL flips them); every other
	// shortcut stays logical so PageUp/[/A always means "previous reading page".
	if (key === "arrowleft") return resolveArrowPageStep("left", direction);
	if (key === "arrowright") return resolveArrowPageStep("right", direction);
	if (
		key === "pageup"
		|| bracketLeft
		|| matchesShortcutKey(event, "a")
	) {
		return "prev";
	}
	if (
		key === "pagedown"
		|| bracketRight
		|| matchesShortcutKey(event, "d")
	) {
		return "next";
	}
	return null;
}

export function isEditorTextEntryTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.closest(".canvas-container")) return false;
	return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

export function shouldHandleLayerClipboardEvent(target: EventTarget | null): boolean {
	return !isEditorTextEntryTarget(target);
}

/**
 * P1 — the editor's keyboard shortcuts live on a DOCUMENT-level keydown listener
 * owned by WorkspaceShell, but that shell also hosts the dashboard / library /
 * settings / reports views. Gate the handler so editor shortcuts (V/T/B tool keys,
 * Delete, Ctrl+Z/Y, page nav, …) only fire when the EDITOR surface is the active
 * workspace view — otherwise they hijack keystrokes on non-editor screens.
 */
export function shouldHandleEditorShortcut(workspaceView: WorkspaceView): boolean {
	return workspaceView === "editor";
}

export function resolveClipboardLayerSelection(
	selectedLayer: TextLayer | null,
	selectedImageLayer: ImageLayer | null,
	editor: any,
): ClipboardLayerSelection | null {
	if (selectedLayer) return { kind: "text", layer: selectedLayer };
	if (selectedImageLayer) return { kind: "image", layer: selectedImageLayer };

	const activeTextLayer = typeof editor?.getActiveTextLayer === "function"
		? editor.getActiveTextLayer()
		: null;
	if (activeTextLayer) return { kind: "text", layer: activeTextLayer };

	const activeImageLayer = typeof editor?.getActiveImageLayer === "function"
		? editor.getActiveImageLayer()
		: null;
	if (activeImageLayer) return { kind: "image", layer: activeImageLayer };

	return null;
}

class EditorStore {
	currentTool = $state<Tool>("select");
	selectedLayer = $state<TextLayer | null>(null);
	selectedImageLayer = $state<ImageLayer | null>(null);
	textLayers = $state<TextLayer[]>([]);
	imageLayers = $state<ImageLayer[]>([]);
	// Phase C — the current page's non-destructive edit stack (bubble-clean / brush /
	// healing / clone). Mirrored from the editor host so the Layers inspector "Edits"
	// section can render rows + drive visibility/rename/delete/revert.
	imageEditLayers = $state<ImageEditLayer[]>([]);
	editor: any = $state(null);
	hasImage = $state(false);
	selectedAspectRatio = $state<string>("1:1 Square");
	zoomLevel = $state(1);
	viewportVersion = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);
	historyEntries = $state<EditorHistoryEntry[]>([]);
	historyCurrentIndex = $state(-1);
	layerClipboard = $state<LayerClipboardItem | null>(null);
	brushTarget = $state<BrushTargetState>(unavailableBrushTarget);
	brushCommitError = $state<string | null>(null);
	brushTargetMissMessage = $state<string | null>(null);
	// True while a tool runs a long (>150ms) operation (OpenCV heal, full-image
	// composite + PNG encode). Drives a non-blocking "working" indicator so the
	// user knows the op is in progress while the UI stays responsive.
	toolBusy = $state(false);
	toolBusyLabel = $state<string | null>(null);
	imageToolStatusMessage = $state<string | null>(null);
	imageToolStatusTone = $state<"ready" | "blocked" | "info">("info");
	brushSize = $state(30);
	brushHardness = $state(50);
	brushOpacity = $state(100);
	brushColor = $state("#FFFFFF");
	brushMode = $state<BrushMode>("erase");
	imageToolFillColor = $state("#FFFFFF");
	recentToolColors = $state<string[]>(["#FFFFFF", "#111111"]);
	lastImageLayerBrushCommit = $state<ImageLayerBrushCommitReceipt | null>(null);
	// W3.15 — cross-page (multi-page) editing toggle. UI reflects this; the
	// Fabric clip is driven via editor.setMultiPageMode(). Role + lock gated.
	multiPageMode = $state(false);
	// W3.13 — the active image-edit suite tool id (marquee / lasso / magic wand /
	// healing / clone / ...), or null when none. Drives the dock highlight + the
	// "image-tools" top-context bar. The Fabric engine tool stays "select".
	activeImageTool = $state<ImageEditToolId | null>(null);
	// W3.13 / rec #5 — brush radius (image px) for the heal + clone paint tools.
	// Separate from the legacy `brushSize` (the AI-layer clean brush). `[`/`]`
	// adjust it while a paint tool is active; the slider in the image-tools context
	// bar binds to it.
	imageToolBrushSize = $state(16);
	// Unified 0..100 selection tolerance for the magic-wand + color-range tools.
	// Mapped onto each tool's native scale (magic-wand `threshold` 0..64,
	// color-range `hue` 0..60) when pushed into the suite. Exposed as a slider in
	// the image-tools context bar so these click-to-select tools are tunable.
	imageToolTolerance = $state(38);
	imageToolHardness = $state(80);
	imageToolOpacity = $state(100);
	imageToolInpaintRadius = $state(3);
	imageToolRespectSelection = $state(true);
	// W3.13 flagship — Bubble Auto-Clean options exposed in the image-tools context
	// bar: the line-art/edge luminance threshold (0..255) the bounded flood-fill
	// stops at, the fill mode (pure white vs sampled paper colour), and a small
	// grow/contract (px) to hug the outline without a halo. Defaults mirror the tool
	// factory so one click usually works.
	bubbleCleanThreshold = $state(140);
	bubbleCleanFillMode = $state<"white" | "paper">("white");
	bubbleCleanGrow = $state(1);
	// UI-owned mirror of the adjustments tool's mutable options object. The tool
	// owns rendering/commit; the store owns reactive values for the controls panel.
	adjustmentsOptions = $state<AdjustmentsToolOptions>(cloneAdjustmentsOptions(NEUTRAL_ADJUSTMENTS_OPTIONS));
	// True after a teardown flush (sign-out / leave-workspace / project-close) hit its
	// timeout and we proceeded anyway — drives a non-blocking "last edit may not have
	// saved" warning instead of trapping the user signed-in (#255 P1).
	lastFlushTimedOut = $state(false);

	private keydownHandler?: (e: KeyboardEvent) => void;
	private copyHandler?: (e: ClipboardEvent) => void;
	private imageLayerEditStartStates = new Map<string, ImageLayer>();
	// W3.13 — the image-edit suite (8 client-side tools + shared MaskBuffer).
	// Lazily created in init() once the MangaEditor host exists.
	private imageEditSuite: ImageEditSuite | null = null;

	constructor() {
		// Flush a buffered instant edit before an explicit sign-out clears the
		// session + routes away (which unmounts WorkspaceShell → editor.destroy()
		// → resetBackgroundEditState(), discarding the debounced persist). #255.
		// editorStore is an app-lifetime singleton, so this hook is never removed.
		authStore.registerPreSignOut(() => this.flushPendingEdits());
	}

	/**
	 * Drain any debounced/in-flight instant-apply edit RIGHT NOW and await it.
	 * Teardown initiators (sign-out, leave-workspace/close-project, hard unload)
	 * MUST await this BEFORE destroy()/route-change so an instant edit made just
	 * before the debounce fires (<800ms) is uploaded AND its page.edits association
	 * is durably saved, not discarded. Delegates to the project store so the FULL
	 * chain flushes: editor image persist → page.edits → project autosave. Safe
	 * no-op when no editor is mounted or nothing is buffered.
	 */
	// Hard upper bound on a teardown flush. Even with the editor's gate-settles-on-
	// failure fix, a genuinely slow (not failing) upload or a stuck network could make
	// the flush take arbitrarily long. Sign-out / navigation must ALWAYS complete, so
	// the flush races this timeout — better to proceed (and warn) than trap the user
	// signed-in (#255 P1).
	private static readonly TEARDOWN_FLUSH_TIMEOUT_MS = 4000;

	async flushPendingEdits(): Promise<void> {
		const editor = this.editor;
		if (!editor) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const flush = projectStore.flushPendingPersistAndSave(editor);
			// Promise.race: whichever settles first wins. The timeout resolves (not
			// rejects) so teardown proceeds cleanly; a pending flush keeps running in the
			// background (it may still land), but the caller is no longer blocked.
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), EditorStore.TEARDOWN_FLUSH_TIMEOUT_MS);
			});
			const result = await Promise.race([flush.then(() => "flushed" as const), timeout]);
			if (result === "timeout") {
				console.warn(
					"[editor] flushPendingEdits timed out — proceeding with teardown; last edit may not have saved",
				);
				this.lastFlushTimedOut = true;
			} else {
				this.lastFlushTimedOut = false;
			}
		} catch (error) {
			console.error("[editor] flushPendingEdits failed:", error);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * True when a buffered/in-flight instant edit OR an unsaved project change still
	 * needs persisting — i.e. a teardown now would risk losing work. Drives the
	 * leave-workspace beforeNavigate flush + the hard-unload fallback.
	 */
	hasPendingEdits(): boolean {
		const editor = this.editor;
		const editorPending = Boolean(
			editor && typeof editor.hasPendingBrushCommit === "function" && editor.hasPendingBrushCommit(),
		);
		const projectPending = projectStore.saveSyncStatus === "unsaved" || projectStore.saveSyncStatus === "saving";
		return editorPending || projectPending;
	}

	get layerClipboardKind(): LayerClipboardItem["kind"] | null {
		return this.layerClipboard?.kind ?? null;
	}

	setTool(tool: Tool): void {
		// Picking any standard engine tool leaves the image-edit suite, restoring
		// normal Fabric selection/pointer behaviour first.
		if (this.activeImageTool) {
			this.clearImageTool();
		}
		this.currentTool = tool;
		this.brushTargetMissMessage = null;
		this.editor?.setTool(tool);
		this.refreshBrushTarget();
		if (tool === "brush" && !this.brushTarget.canBrush) {
			projectStore.setStatusMsg(this.brushTarget.detail);
		}
	}

	/**
	 * W3.13: activate one of the 8 image-edit suite tools. Puts the canvas under
	 * suite pointer ownership (Fabric selection off; gestures forwarded to the
	 * suite registry which converts scene → image-space) while the engine tool
	 * stays "select". Idempotent for the already-active tool.
	 */
	setImageTool(id: ImageEditToolId): void {
		const suite = this.imageEditSuite;
		if (!suite) return;
		this.brushTargetMissMessage = null;
		// Make sure the engine tool truth is "select" without recursively clearing
		// the suite (setTool would call clearImageTool).
		if (this.currentTool !== "select") {
			this.currentTool = "select";
			this.editor?.setTool("select");
		}
		this.editor?.setImageToolActive(true);
		suite.registry.activate(id);
		this.activeImageTool = id;
		this.imageToolStatusMessage = id === "clone-stamp"
			? "Alt/Option-click to set a clone source before painting."
			: null;
		this.imageToolStatusTone = "info";
		// Sync the active paint tool's radius from the shared image-tool brush size so
		// the cursor ring + `[`/`]` resize stay consistent across heal/clone.
		this.syncImageToolBrushSize();
		// Sync the unified tolerance into magic-wand / color-range so a click selects
		// with the slider value already in effect.
		this.syncImageToolTolerance();
		this.syncCloneStampOptions();
		this.syncHealingBrushOptions();
		// Sync bubble-clean settings so a click cleans with the current threshold /
		// fill-mode / grow already applied.
		this.syncBubbleCleanOptions();
		if (id === ADJUSTMENTS_TOOL_ID) {
			this.syncAdjustmentsOptions();
		}
		this.syncImageToolFillColor();
		this.refreshBrushTarget();
	}

	/** True while a paint image-tool (heal / clone) — the ones with a brush radius. */
	get isImagePaintTool(): boolean {
		return this.activeImageTool === "healing-brush" || this.activeImageTool === "clone-stamp";
	}

	/** Push the current image-tool brush size into the heal + clone tool options. */
	private syncImageToolBrushSize(): void {
		const tools = this.imageEditSuite?.tools;
		if (!tools) return;
		tools.healingBrush.options.radius = this.imageToolBrushSize;
		tools.cloneStamp.options.radius = this.imageToolBrushSize;
	}

	/**
	 * Set the heal/clone brush radius (image px). Updates the store + the active
	 * tool's live cursor preview (rec #5). The suite's ToolContext is rebuilt each
	 * gesture, so we hand the active tool the latest context to redraw the ring.
	 */
	setImageToolBrushSize(value: number): void {
		const next = this.normalizeBrushValue(value, this.imageToolBrushSize, 1, 200);
		this.imageToolBrushSize = next;
		const tools = this.imageEditSuite?.tools;
		if (tools) {
			tools.healingBrush.options.radius = next;
			tools.cloneStamp.options.radius = next;
		}
		// Live-preview the new size on the active paint tool's cursor.
		this.imageEditSuite?.registry.setActiveToolRadius?.(next);
	}

	/** Step the heal/clone brush size (rec #5: `[` / `]`). */
	adjustImageToolBrushSize(delta: number): void {
		this.setImageToolBrushSize(this.imageToolBrushSize + delta);
		projectStore.setStatusMsg(`ขนาดแปรง ${this.imageToolBrushSize}px`);
	}

	private syncCloneStampOptions(): void {
		const tools = this.imageEditSuite?.tools;
		if (!tools) return;
		tools.cloneStamp.options.hardness = this.imageToolHardness / 100;
		tools.cloneStamp.options.opacity = this.imageToolOpacity / 100;
	}

	private syncHealingBrushOptions(): void {
		const tools = this.imageEditSuite?.tools;
		if (!tools) return;
		tools.healingBrush.options.inpaintRadius = this.imageToolInpaintRadius;
		tools.healingBrush.options.respectSelection = this.imageToolRespectSelection;
	}

	setImageToolHardness(value: number): void {
		const next = Math.min(100, Math.max(0, Math.round(value)));
		this.imageToolHardness = next;
		const tools = this.imageEditSuite?.tools;
		if (tools) {
			tools.cloneStamp.options.hardness = next / 100;
		}
	}

	setImageToolOpacity(value: number): void {
		const next = Math.min(100, Math.max(0, Math.round(value)));
		this.imageToolOpacity = next;
		const tools = this.imageEditSuite?.tools;
		if (tools) {
			tools.cloneStamp.options.opacity = next / 100;
		}
	}

	setImageToolInpaintRadius(value: number): void {
		const next = Math.min(10, Math.max(1, Math.round(value)));
		this.imageToolInpaintRadius = next;
		const tools = this.imageEditSuite?.tools;
		if (tools) {
			tools.healingBrush.options.inpaintRadius = next;
		}
	}

	setImageToolRespectSelection(value: boolean): void {
		this.imageToolRespectSelection = value;
		const tools = this.imageEditSuite?.tools;
		if (tools) {
			tools.healingBrush.options.respectSelection = value;
		}
	}

	/** Click-to-select tools (magic-wand / color-range) that take a tolerance. */
	get isImageSelectTool(): boolean {
		return this.activeImageTool === "magic-wand" || this.activeImageTool === "color-range";
	}

	/** Push the current 0..100 tolerance into the magic-wand + color-range tools. */
	private syncImageToolTolerance(): void {
		const tools = this.imageEditSuite?.tools;
		if (!tools) return;
		const t = Math.min(100, Math.max(0, Math.round(this.imageToolTolerance)));
		// Map the unified 0..100 slider onto each tool's native scale.
		tools.magicWand.options.threshold = Math.round((t / 100) * 64);
		tools.colorRange.options.hue = Math.round((t / 100) * 60);
	}

	/** Set the unified magic-wand / color-range selection tolerance (0..100). */
	setImageToolTolerance(value: number): void {
		const next = Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : this.imageToolTolerance)));
		this.imageToolTolerance = next;
		this.syncImageToolTolerance();
	}

	private rememberToolColor(color: string): void {
		const normalized = normalizeToolHexColor(color);
		this.recentToolColors = [
			normalized,
			...this.recentToolColors.filter((entry) => normalizeToolHexColor(entry) !== normalized),
		].slice(0, 10);
	}

	private syncImageToolFillColor(): void {
		const tools = this.imageEditSuite?.tools;
		if (!tools) return;
		const normalized = normalizeToolHexColor(this.imageToolFillColor);
		tools.bucketFill.setFillColor(hexToRgbaTuple(normalized));
		tools.magicClean.options.fillColor = normalized;
	}

	setImageToolFillColor(value: string): void {
		const normalized = normalizeToolHexColor(value, this.imageToolFillColor);
		this.imageToolFillColor = normalized;
		this.rememberToolColor(normalized);
		this.syncImageToolFillColor();
	}

	/** True while the Bubble Auto-Clean tool is active (drives its options group). */
	get isBubbleCleanTool(): boolean {
		return this.activeImageTool === "bubble-clean";
	}

	/** Push the store's bubble-clean settings into the suite tool's options. */
	private syncBubbleCleanOptions(): void {
		const bubble = this.imageEditSuite?.tools.bubbleClean;
		if (!bubble) return;
		bubble.options.edgeThreshold = Math.min(255, Math.max(0, Math.round(this.bubbleCleanThreshold)));
		bubble.options.fillMode = this.bubbleCleanFillMode;
		bubble.options.grow = Math.min(8, Math.max(-8, Math.round(this.bubbleCleanGrow)));
	}

	/** Set the bubble-clean edge/line luminance threshold (0..255). */
	setBubbleCleanThreshold(value: number): void {
		this.bubbleCleanThreshold = Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : this.bubbleCleanThreshold)));
		this.syncBubbleCleanOptions();
	}

	/** Set the bubble-clean fill mode (pure white vs sampled paper colour). */
	setBubbleCleanFillMode(mode: "white" | "paper"): void {
		this.bubbleCleanFillMode = mode === "paper" ? "paper" : "white";
		this.syncBubbleCleanOptions();
	}

	/** Set the bubble-clean grow/contract amount in px (-8..8). */
	setBubbleCleanGrow(value: number): void {
		this.bubbleCleanGrow = Math.min(8, Math.max(-8, Math.round(Number.isFinite(value) ? value : this.bubbleCleanGrow)));
		this.syncBubbleCleanOptions();
	}

	private syncAdjustmentsOptions(): void {
		const options = this.imageEditSuite?.tools.adjustments.options;
		this.adjustmentsOptions = options
			? cloneAdjustmentsOptions(options)
			: cloneAdjustmentsOptions(NEUTRAL_ADJUSTMENTS_OPTIONS);
	}

	private buildAdjustmentsContext() {
		return this.imageEditSuite?.registry.buildCurrentContext() ?? null;
	}

	get canUseAdjustmentsTool(): boolean {
		return Boolean(
			this.imageEditSuite?.tools.adjustments
			&& this.editor?.getImageSpaceContext?.()
			&& !this.adjustmentsBlockedByEditLayers,
		);
	}

	/**
	 * Adjustments now samples the COMPOSITED region (readCompositedImageRegion,
	 * w06) so it is safe over edit stacks; this gate only remains for a host
	 * that cannot provide composite reads — there it still blocks pages with
	 * visible edit layers (the original codex P2: a base-only patch would cover
	 * earlier cleanups).
	 */
	get adjustmentsBlockedByEditLayers(): boolean {
		if (typeof (this.editor as { readCompositedImageRegion?: unknown } | null)?.readCompositedImageRegion === "function") {
			return false;
		}
		return this.imageEditLayers.some((layer) => layer.visible !== false);
	}

	setAdjustmentsOptions(next: PartialAdjustmentsToolOptions, shouldPreview = true): boolean {
		const tool = this.imageEditSuite?.tools.adjustments;
		const ctx = this.buildAdjustmentsContext();
		if (!tool || !ctx) return false;
		const applied = tool.setOptions(ctx, next, shouldPreview);
		this.syncAdjustmentsOptions();
		return applied;
	}

	previewAdjustments(next?: PartialAdjustmentsToolOptions): boolean {
		const tool = this.imageEditSuite?.tools.adjustments;
		const ctx = this.buildAdjustmentsContext();
		if (!tool || !ctx) return false;
		const applied = tool.preview(ctx, next);
		this.syncAdjustmentsOptions();
		return applied;
	}

	async commitAdjustments(): Promise<boolean> {
		const tool = this.imageEditSuite?.tools.adjustments;
		const ctx = this.buildAdjustmentsContext();
		if (!tool || !ctx) return false;
		const committed = await tool.commit(ctx);
		this.syncAdjustmentsOptions();
		projectStore.setStatusMsg(committed ? "บันทึกปรับแสงสีแล้ว" : "ยังไม่มีค่าปรับแสงสีให้บันทึก");
		return committed;
	}

	cancelAdjustments(): boolean {
		const tool = this.imageEditSuite?.tools.adjustments;
		const ctx = this.buildAdjustmentsContext();
		if (!tool || !ctx) return false;
		const canceled = tool.cancel(ctx);
		this.syncAdjustmentsOptions();
		if (canceled) projectStore.setStatusMsg("ยกเลิกพรีวิวปรับแสงสีแล้ว");
		return canceled;
	}

	resetAdjustments(): boolean {
		return this.setAdjustmentsOptions(cloneAdjustmentsOptions(NEUTRAL_ADJUSTMENTS_OPTIONS), true);
	}

	/** W3.13: leave the image-edit suite and restore the standard select tool. */
	clearImageTool(): void {
		if (!this.activeImageTool && !this.editor?.imageToolActive) return;
		const registry = this.imageEditSuite?.registry;
		registry?.deactivateActive();
		// Leaving the suite for a non-image engine tool (Select/Crop/Text/Brush/AI)
		// must also drop the committed selection: a tool's deactivate() only clears
		// its own transient preview, leaving the MaskBuffer live + the translucent
		// overlay painted on the canvas. clearSelection() empties the mask AND
		// removes the overlay so the next operation isn't silently clipped by an
		// invisible selection. (Switching BETWEEN image tools goes through
		// setImageTool(), which never calls this, so selection still carries across
		// marquee → refine-edge → heal as the suite intends.)
		registry?.clearSelection();
		this.activeImageTool = null;
		this.imageToolStatusMessage = null;
		this.imageToolStatusTone = "info";
		this.editor?.setImageToolActive(false);
		this.refreshBrushTarget();
	}

	/** W3.13: clear the active image-edit selection mask + its canvas overlay. */
	clearImageSelection(): void {
		this.imageEditSuite?.registry.clearSelection();
	}

	/**
	 * Engine-safe context used to activate a dock tool from outside the dock UI
	 * (e.g. keyboard shortcuts). Mirrors EditorLeftDock's activationContext so a
	 * shortcut and a click run the exact same activation path.
	 */
	private dockActivationContext(): ToolActivationContext {
		return {
			setEngineTool: (tool) => this.setTool(tool),
			setRightPanelMode: (mode) => editorUiStore.setRightPanelMode(mode),
			startTextPlacement: () => this.startTextPlacement(),
			activateImageTool: (id) => this.setImageTool(id),
		};
	}

	/**
	 * Activate the dock tool behind a canonical editor keymap action. Returns true
	 * when a tool was activated so the keydown handler can preventDefault.
	 */
	private activateToolShortcutAction(actionId: string | null): boolean {
		if (!actionId) return false;
		const dockToolId = getDefaultEditorCommandBinding(actionId)?.dockToolId;
		if (!dockToolId) return false;
		const def = toolRegistry.get(dockToolId as ToolId);
		if (!def) return false;
		// Duty filter (2026-06-13): keyboard shortcuts must not bypass the dock —
		// a translator pressing B/T/P would otherwise fully activate a foreign-
		// duty tool (and its options/right-panel side effects).
		if (!dutyAllowsTool(def)) return false;
		editorUiStore.setActiveDockTool(def.id);
		const ctx = this.dockActivationContext();
		if (def.onActivate) {
			def.onActivate(ctx);
		} else {
			ctx.setEngineTool(def.engineTool);
		}
		projectStore.setStatusMsg(def.title);
		return true;
	}

	/**
	 * Legacy test/helper adapter for plain-key activation. Runtime keydown uses
	 * the canonical keymap directly so Shift+family shortcuts stay distinct.
	 */
	activateToolShortcut(key: string): boolean {
		return this.activateToolShortcutEvent(plainKeyEventLike(key));
	}

	/** Resolve and activate a dock tool from a real keyboard event. */
	activateToolShortcutEvent(event: KeyboardEvent): boolean {
		const actionId = EDITOR_SHORTCUT_KEYMAP.resolve(event, EDITOR_SHORTCUT_CONTEXT);
		return this.activateToolShortcutAction(actionId);
	}

	/**
	 * W3.13: Refine-Edge morphology on the current selection mask (grow / contract
	 * / feather, in image pixels). No-op when no selection or no active suite.
	 */
	refineSelectionEdge(op: "grow" | "contract" | "feather", radius: number): void {
		const refine = this.imageEditSuite?.tools.refineEdge;
		if (!refine) return;
		void refine[op](radius);
	}

	startSelectedImageCleanBrush(): void {
		this.refreshBrushTarget();
		if (!this.selectedImageLayer || !this.brushTarget.canBrush || this.brushTarget.kind !== "image-layer") {
			projectStore.setStatusMsg(this.brushTarget.detail);
			return;
		}
		this.setTool("brush");
		editorUiStore.focusImageInspector(this.selectedImageLayer.id);
		projectStore.setStatusMsg(`แปรงคลีน: แก้เฉพาะเลเยอร์นี้ - ${this.brushTarget.title}`);
	}

	// --- W3.15 long-page guardrails ---

	/**
	 * Cross-page editing is a Cleaner/Typesetter privilege. Owner/admin/team_lead
	 * /editor profiles also hold canClean+canTypeset so they qualify too.
	 */
	get canToggleMultiPageMode(): boolean {
		return canUseMultiPageMode(authStore.capabilities);
	}

	/** True when the current page holds a soft-lock owned by another member. */
	private get currentPageLockedByOther(): boolean {
		const project = projectStore.project;
		if (!project) return false;
		const lock = locksStore.getByScope("page", pageLockId(project.projectId, project.currentPage));
		if (!lock?.owner) return false;
		const me = authStore.user;
		const myIdentity = me?.id ?? me?.email ?? null;
		// A lock owned by someone other than me blocks cross-page editing.
		return myIdentity ? lock.owner !== myIdentity && lock.owner !== me?.email && lock.owner !== me?.name : true;
	}

	/**
	 * Toggle (or set) cross-page editing. Gated to Cleaner/Typesetter roles and
	 * blocked while another member holds the page lock. Falls back to a status
	 * toast explaining why when the gate denies the request.
	 */
	setMultiPageMode(enabled: boolean): void {
		if (enabled === this.multiPageMode) return;
		if (enabled) {
			if (!this.canToggleMultiPageMode) {
				toastsStore.warn({
					id: "multi-page-role-gate",
					title: "เฉพาะ Cleaner/Typesetter",
					body: "โหมดแก้ข้ามหน้าเปิดได้เฉพาะบทบาท Cleaner หรือ Typesetter",
				});
				return;
			}
			if (this.currentPageLockedByOther) {
				toastsStore.warn({
					id: "multi-page-lock-gate",
					title: "หน้านี้ถูกล็อก",
					body: "สมาชิกคนอื่นกำลังถือสิทธิ์แก้หน้านี้อยู่ ปลดล็อกก่อนจึงจะแก้ข้ามหน้าได้",
				});
				return;
			}
		}
		this.multiPageMode = enabled;
		this.editor?.setMultiPageMode(enabled);
		toastsStore.info({
			id: "multi-page-mode-state",
			title: enabled ? "เปิดโหมดแก้ข้ามหน้า" : "ปิดโหมดแก้ข้ามหน้า",
			body: enabled
				? "เครื่องมือแก้ข้ามเส้นแบ่งหน้าได้ — ระวังขอบหน้าที่ติดกัน"
				: "เครื่องมือถูกจำกัดอยู่ในหน้าปัจจุบันตามปกติ",
		});
	}

	toggleMultiPageMode(): void {
		this.setMultiPageMode(!this.multiPageMode);
	}

	/**
	 * Force cross-page mode OFF when the current context no longer permits it —
	 * the user lost Cleaner/Typesetter capability (sign-out / role downgrade) or
	 * navigated to a page soft-locked by another member. Idempotent; safe to call
	 * on every page load and on auth/capability changes.
	 */
	revalidateMultiPageMode(): void {
		if (!this.multiPageMode) return;
		if (!this.canToggleMultiPageMode || this.currentPageLockedByOther) {
			// Drive the engine clip back on directly (bypassing the no-op guard in
			// setMultiPageMode's "enabled === current" short-circuit is unnecessary
			// here because we are turning OFF, which always passes).
			this.multiPageMode = false;
			this.editor?.setMultiPageMode(false);
			toastsStore.info({
				id: "multi-page-mode-revoked",
				title: "ปิดโหมดแก้ข้ามหน้า",
				body: "โหมดแก้ข้ามหน้าถูกปิดอัตโนมัติ (สิทธิ์เปลี่ยนหรือหน้าถูกล็อก)",
			});
		}
	}

	setBrushSize(value: number): void {
		const nextValue = this.normalizeBrushValue(value, this.brushSize, 5, 100);
		this.brushSize = nextValue;
		this.editor?.setBrushSize?.(nextValue);
	}

	setBrushHardness(value: number): void {
		const nextValue = this.normalizeBrushValue(value, this.brushHardness, 0, 100);
		this.brushHardness = nextValue;
		this.editor?.setBrushHardness?.(nextValue);
	}

	setBrushOpacity(value: number): void {
		const nextValue = this.normalizeBrushValue(value, this.brushOpacity, 0, 100);
		this.brushOpacity = nextValue;
		this.editor?.setBrushOpacity?.(nextValue);
	}

	setBrushColor(value: string): void {
		const normalized = normalizeToolHexColor(value, this.brushColor);
		this.brushColor = normalized;
		this.rememberToolColor(normalized);
		this.editor?.setBrushColor?.(normalized);
	}

	setBrushPreset(size: number, hardness: number, opacity = this.brushOpacity): void {
		this.setBrushSize(size);
		this.setBrushHardness(hardness);
		this.setBrushOpacity(opacity);
	}

	setBrushMode(mode: BrushMode): void {
		if (mode === "restore" && !this.brushTarget.canRestore) return;
		if (mode === "erase" && !this.brushTarget.canBrush) return;
		this.brushMode = mode;
		this.editor?.setBrushMode?.(mode);
	}

	adjustBrushSize(delta: number): void {
		this.setBrushSize(this.brushSize + delta);
		projectStore.setStatusMsg(`ขนาดแปรง ${this.brushSize}px`);
	}

	toggleBrushModeFromShortcut(): void {
		if (this.brushMode === "erase" && this.brushTarget.canRestore) {
			this.setBrushMode("restore");
			projectStore.setStatusMsg(BRUSH_RESTORE_LABEL_STATUS_TH[this.brushTarget.restoreLabelCode] || "โหมดกู้คืนภาพ");
			return;
		}
		this.setBrushMode("erase");
		projectStore.setStatusMsg(BRUSH_ERASE_LABEL_STATUS_TH[this.brushTarget.eraseLabelCode] || "โหมดลบภาพ");
	}

	private normalizeBrushValue(value: number, fallback: number, min: number, max: number): number {
		const nextValue = Number.isFinite(value) ? Math.round(value) : fallback;
		return Math.max(min, Math.min(max, nextValue));
	}

	startTextPlacement(): void {
		if (!this.hasImage || !this.editor?.imageItem) {
			projectStore.setStatusMsg("เปิดรูปหน้าก่อนวางข้อความ");
			return;
		}
		this.setTool("text");
		projectStore.setStatusMsg("คลิกบนรูปเพื่อวางข้อความ กด Esc เพื่อยกเลิก");
	}

	cancelActiveTool(): void {
		// An image-edit suite tool runs on the "select" engine tool; Esc first drops
		// its in-progress selection mask, then (if none) leaves the suite.
		if (this.activeImageTool) {
			const registry = this.imageEditSuite?.registry;
			if (registry && !registry.mask.isEmpty()) {
				registry.clearSelection();
				projectStore.setStatusMsg("คลีนพื้นที่ที่เลือกแล้ว");
				return;
			}
			this.setTool("select");
			projectStore.setStatusMsg("ออกจากเครื่องมือแก้ภาพแล้ว");
			return;
		}
		if (this.currentTool === "select") {
			this.clearSelection();
			return;
		}
		this.setTool("select");
		projectStore.setStatusMsg("ยกเลิกเครื่องมือแล้ว");
	}

	clearSelection(): void {
		if (typeof this.editor?.clearSelection === "function") {
			this.editor.clearSelection();
		} else {
			this.editor?.canvas?.discardActiveObject?.();
			this.editor?.canvas?.requestRenderAll?.();
		}
		this.imageLayerEditStartStates.clear();
		this.selectedLayer = null;
		this.selectedImageLayer = null;
		this.refreshBrushTarget();
	}

	setAspectRatio(ratio: [number, number] | null): void {
		this.editor?.setAspectRatio(ratio);
	}

	getCanvasDimensions(): { width: number; height: number } {
		if (!this.editor) return { width: 0, height: 0 };
		return {
			width: this.editor.canvasWidth || 0,
			height: this.editor.canvasHeight || 0,
		};
	}

	getZoomLevel(): number {
		return this.zoomLevel;
	}

	zoomViewportBy(factor: number): void {
		if (typeof this.editor?.zoomAtViewportCenter !== "function") return;
		const currentZoom = this.editor.getZoom?.() ?? this.zoomLevel;
		this.zoomLevel = this.editor.zoomAtViewportCenter(currentZoom * factor);
	}

	resetViewportZoom(): void {
		// "Reset view" should fit the page to the screen (re-center + fit), not snap
		// to a hard 100% that can leave a large page overflowing the workspace.
		if (typeof this.editor?.fitViewportToScreen === "function") {
			this.zoomLevel = this.editor.fitViewportToScreen();
			return;
		}
		if (typeof this.editor?.zoomAtViewportCenter !== "function") return;
		this.zoomLevel = this.editor.zoomAtViewportCenter(1);
	}

	createDefaultCover(): void {
		this.editor?.createDefaultCover();
	}

	addTextLayer(): void {
		if (!this.editor) return;

		const id = safeRandomId();
		const layer: TextLayer = {
			id,
			text: config.defaultText,
			x: 100,
			y: 100,
			w: 200,
			h: 60,
			rotation: 0,
			fontSize: config.defaultFontSize,
			alignment: "center",
			index: this.editor.getAllTextLayers().length,
		};
		if (typeof this.editor.addTextLayerWithHistory === "function") {
			this.editor.addTextLayerWithHistory(layer);
		} else {
			this.editor.addTextLayer(layer);
		}
		this.refreshTextLayers();
	}

	deleteTextLayer(): void {
		if (!this.selectedLayer || !this.editor) return;
		this.deleteTextLayerById(this.selectedLayer.id);
	}

	deleteTextLayerById(layerId: string): void {
		if (!this.editor) return;
		if (typeof this.editor.removeTextLayerWithHistory === "function") {
			this.editor.removeTextLayerWithHistory(layerId);
		} else {
			this.editor.removeTextLayer(layerId);
		}
		if (this.selectedLayer?.id === layerId) {
			this.selectedLayer = null;
		}
		this.refreshTextLayers();
	}

	deleteImageLayer(): void {
		if (!this.selectedImageLayer || !this.editor) return;
		this.deleteImageLayerById(this.selectedImageLayer.id);
	}

	deleteImageLayerById(layerId: string): void {
		if (!this.editor) return;
		this.imageLayerEditStartStates.delete(layerId);
		if (typeof this.editor.removeImageLayerWithHistory === "function") {
			this.editor.removeImageLayerWithHistory(layerId);
		} else {
			this.editor.removeImageLayer?.(layerId);
		}
		if (this.selectedImageLayer?.id === layerId) {
			this.selectedImageLayer = null;
		}
		this.refreshImageLayers();
	}

	rotateText(): void {
		if (!this.selectedLayer || !this.editor) return;
		if (this.selectedLayer.locked === true) return;
		// Route through the history-aware text API so the rotate PERSISTS (layer-data
		// sync + unsaved-mark + autosave) and is undoable — the old direct
		// `active.rotate()` + `renderAll()` left it un-synced and lost on shell-leave.
		const nextRotation = ((this.selectedLayer.rotation || 0) + 90) % 360;
		if (typeof this.editor.updateTextLayerWithHistory === "function") {
			this.selectedLayer = this.editor.updateTextLayerWithHistory(this.selectedLayer.id, { rotation: nextRotation });
		} else {
			this.selectedLayer = this.editor.updateTextLayer?.(this.selectedLayer.id, { rotation: nextRotation }) ?? this.selectedLayer;
		}
		this.refreshTextLayers();
		this.updateHistoryState();
	}

	applyEffects(effects: TextLayerEffects | null): void {
		const updatedLayer = typeof this.editor?.applyEffectsWithHistory === "function"
			? this.editor.applyEffectsWithHistory(effects)
			: this.editor?.applyEffects(effects);
		if (updatedLayer) {
			this.selectedLayer = updatedLayer;
			this.refreshTextLayers();
			this.updateHistoryState();
		}
	}

	async undo(): Promise<void> {
		if (this.editor) {
			// Commit any in-flight keyboard-nudge burst first, so Ctrl+Z undoes the
			// nudge itself rather than skipping past it to the prior action.
			this.editor.flushNudgeHistory?.();
			await this.editor.undo();
			this.updateHistoryState();
		}
	}

	async redo(): Promise<void> {
		if (this.editor) {
			this.editor.flushNudgeHistory?.();
			await this.editor.redo();
			this.updateHistoryState();
		}
	}

	private historyJumpInFlight = false;

	async jumpHistoryTo(targetIndex: number): Promise<void> {
		if (!this.editor) return;
		// -1 = the pre-edit baseline (empty undo stack) — the history panel's
		// baseline row jumps here (codex P2).
		const target = Math.max(-1, Math.round(targetIndex));
		if (target >= this.historyEntries.length) return;
		// Rapid clicks on two entries interleave undo/redo loops and can settle
		// on the wrong index — serialize jumps (codex P3).
		if (this.historyJumpInFlight) return;
		this.historyJumpInFlight = true;
		try {
			let guard = 0;
			while (this.historyCurrentIndex > target && this.canUndo && guard < 100) {
				guard += 1;
				await this.undo();
			}
			while (this.historyCurrentIndex < target && this.canRedo && guard < 100) {
				guard += 1;
				await this.redo();
			}
		} finally {
			this.historyJumpInFlight = false;
		}
		this.updateHistoryState();
	}

	private updateHistoryState(): void {
		if (this.editor) {
			this.canUndo = this.editor.canUndo();
			this.canRedo = this.editor.canRedo();
			const snapshot = this.editor.getHistorySnapshot?.();
			this.historyEntries = snapshot?.entries ?? [];
			this.historyCurrentIndex = snapshot?.currentIndex ?? -1;
			return;
		}
		this.canUndo = false;
		this.canRedo = false;
		this.historyEntries = [];
		this.historyCurrentIndex = -1;
	}

	refreshBrushTarget(): void {
		const nextTarget = resolveBrushTargetState(this.selectedLayer, this.selectedImageLayer, this.editor);
		this.brushTarget = nextTarget;
		if (this.brushMode === "restore" && !nextTarget.canRestore) {
			this.brushMode = "erase";
			this.editor?.setBrushMode?.("erase");
		}
		if (!nextTarget.canBrush || this.currentTool !== "brush") {
			this.brushTargetMissMessage = null;
		}
		this.editor?.setBrushEnabled?.(nextTarget.canBrush);
		if (this.currentTool === "brush") {
			const statusTitle = nextTarget.title || (nextTarget.titleCode ? BRUSH_TITLE_STATUS_TH[nextTarget.titleCode] : "");
			projectStore.setStatusMsg(nextTarget.canBrush
				? `${nextTarget.label}: ${statusTitle}`
				: nextTarget.detail);
		}
	}

	imageLayerBrushReceiptMatches(layerId: string | null | undefined): boolean {
		return Boolean(layerId && this.lastImageLayerBrushCommit?.layerId === layerId);
	}

	private canEditSelectedTextLayer(): boolean {
		return Boolean(this.selectedLayer && this.selectedLayer.locked !== true);
	}

	private updateSelectedTextLayerWithHistory(
		updates: Partial<Pick<TextLayer, "name" | "text" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "alignment" | "fontSize" | "charSpacing" | "skewX" | "skewY" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "effects">>,
	): void {
		if (!this.canEditSelectedTextLayer() || typeof this.editor?.updateTextLayer !== "function") return;
		const selectedLayer = this.selectedLayer;
		if (!selectedLayer) return;
		this.selectedLayer = typeof this.editor.updateTextLayerWithHistory === "function"
			? this.editor.updateTextLayerWithHistory(selectedLayer.id, updates)
			: this.editor.updateTextLayer(selectedLayer.id, updates);
		this.refreshTextLayers();
		this.updateHistoryState();
	}

	updateTextFontSize(fontSize: number): void {
		if (!this.canEditSelectedTextLayer()) return;
		const selectedLayer = this.selectedLayer;
		if (!selectedLayer) return;
		if (typeof this.editor?.updateTextLayer === "function") {
			this.updateSelectedTextLayerWithHistory({ fontSize });
		} else {
			this.editor?.updateTextFontSize(fontSize);
			this.refreshTextLayers();
		}
	}

	updateTextFontFamily(fontFamily: string): void {
		if (!this.canEditSelectedTextLayer()) return;
		const selectedLayer = this.selectedLayer;
		if (!selectedLayer) return;
		if (typeof this.editor?.updateTextLayer === "function") {
			this.updateSelectedTextLayerWithHistory({ fontFamily });
		} else {
			this.editor?.updateTextFontFamily(fontFamily);
			this.refreshTextLayers();
		}
	}

	updateTextContent(text: string): void {
		this.updateSelectedTextLayerWithHistory({ text });
	}

	updateTextCharSpacing(charSpacing: number): void {
		// charSpacing is fully plumbed (model + Fabric apply + PNG export); this exposes
		// it to the typeset UI. updateTextLayer clamps to Fabric's -500..1000 range.
		this.updateSelectedTextLayerWithHistory({ charSpacing });
	}

	updateTextLayerBox(updates: Partial<Pick<TextLayer, "w" | "h">>): void {
		this.updateSelectedTextLayerWithHistory({
			...(updates.w !== undefined ? { w: Math.max(1, Math.round(updates.w)) } : {}),
			...(updates.h !== undefined ? { h: Math.max(1, Math.round(updates.h)) } : {}),
		});
	}

	updateTextLayerName(name: string): void {
		this.updateSelectedTextLayerWithHistory({ name: name.trim() || undefined });
	}

	updateTextOpacity(opacity: number): void {
		const clamped = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
		this.updateSelectedTextLayerWithHistory({ opacity: clamped });
	}

	updateTextAlignment(alignment: TextLayer["alignment"]): void {
		this.updateSelectedTextLayerWithHistory({ alignment });
	}

	updateTextFill(fill: string): void {
		this.updateSelectedTextLayerWithHistory({ fill });
	}

	updateTextStroke(stroke: string): void {
		this.updateSelectedTextLayerWithHistory({ stroke });
	}

	updateTextStrokeWidth(strokeWidth: number): void {
		this.updateSelectedTextLayerWithHistory({ strokeWidth });
	}

	fitSelectedTextLayerToBox(): void {
		if (!this.selectedLayer || this.selectedLayer.locked === true) return;
		if (typeof this.editor?.fitTextLayerToBox !== "function") return;
		// Prefer the history-aware fit so it is undoable like image-layer actions.
		this.selectedLayer = typeof this.editor.fitTextLayerToBoxWithHistory === "function"
			? this.editor.fitTextLayerToBoxWithHistory(this.selectedLayer.id)
			: this.editor.fitTextLayerToBox(this.selectedLayer.id);
		this.refreshTextLayers();
		this.updateHistoryState();
	}

	applyTextStylePreset(style: TextStylePresetStyle): void {
		const updates = { ...style };
		if (!Object.prototype.hasOwnProperty.call(style, "effects")) {
			delete updates.effects;
		}
		this.updateSelectedTextLayerWithHistory(updates);
	}

	toggleTextLayerVisibility(id: string): void {
		const layer = this.textLayers.find((item) => item.id === id);
		if (!layer || typeof this.editor?.updateTextLayer !== "function") return;
		// History-aware (like toggleImageLayerVisibility) so visibility is undoable.
		const updateTextLayer = typeof this.editor.updateTextLayerWithHistory === "function"
			? this.editor.updateTextLayerWithHistory.bind(this.editor)
			: this.editor.updateTextLayer.bind(this.editor);
		const updatedLayer = updateTextLayer(id, { visible: layer.visible === false });
		if (this.selectedLayer?.id === id) {
			this.selectedLayer = updatedLayer;
		}
		this.refreshTextLayers();
		this.updateHistoryState();
	}

	toggleTextLayerLock(id: string): void {
		const layer = this.textLayers.find((item) => item.id === id);
		if (!layer || typeof this.editor?.updateTextLayer !== "function") return;
		// History-aware (like toggleImageLayerLock) so lock state is undoable.
		const updateTextLayer = typeof this.editor.updateTextLayerWithHistory === "function"
			? this.editor.updateTextLayerWithHistory.bind(this.editor)
			: this.editor.updateTextLayer.bind(this.editor);
		const updatedLayer = updateTextLayer(id, { locked: layer.locked !== true });
		if (this.selectedLayer?.id === id) {
			this.selectedLayer = updatedLayer;
		}
		this.refreshTextLayers();
		this.updateHistoryState();
	}

	toggleImageLayerVisibility(id: string): void {
		const layer = this.imageLayers.find((item) => item.id === id);
		if (!layer || typeof this.editor?.updateImageLayer !== "function") return;
		this.imageLayerEditStartStates.delete(id);
		const updateImageLayer = typeof this.editor.updateImageLayerWithHistory === "function"
			? this.editor.updateImageLayerWithHistory.bind(this.editor)
			: this.editor.updateImageLayer.bind(this.editor);
		const updatedLayer = updateImageLayer(id, { visible: layer.visible === false });
		if (this.selectedImageLayer?.id === id) {
			this.selectedImageLayer = updatedLayer;
		}
		this.refreshImageLayers();
	}

	toggleImageLayerLock(id: string): void {
		const layer = this.imageLayers.find((item) => item.id === id);
		if (!layer || typeof this.editor?.updateImageLayer !== "function") return;
		this.imageLayerEditStartStates.delete(id);
		const updateImageLayer = typeof this.editor.updateImageLayerWithHistory === "function"
			? this.editor.updateImageLayerWithHistory.bind(this.editor)
			: this.editor.updateImageLayer.bind(this.editor);
		const updatedLayer = updateImageLayer(id, { locked: layer.locked !== true });
		if (this.selectedImageLayer?.id === id) {
			this.selectedImageLayer = updatedLayer;
		}
		this.refreshImageLayers();
	}

	duplicateTextLayer(id: string): TextLayer | null {
		if (typeof this.editor?.duplicateTextLayer !== "function") return null;
		const newId = safeRandomId();
		const duplicateTextLayer = typeof this.editor.duplicateTextLayerWithHistory === "function"
			? this.editor.duplicateTextLayerWithHistory.bind(this.editor)
			: this.editor.duplicateTextLayer.bind(this.editor);
		this.selectedLayer = duplicateTextLayer(id, newId);
		this.selectedImageLayer = null;
		this.refreshTextLayers();
		return this.selectedLayer;
	}

	async duplicateImageLayer(id: string): Promise<ImageLayer | null> {
		if (typeof this.editor?.duplicateImageLayer !== "function") return null;
		this.imageLayerEditStartStates.delete(id);
		const newId = safeRandomId();
		const duplicateImageLayer = typeof this.editor.duplicateImageLayerWithHistory === "function"
			? this.editor.duplicateImageLayerWithHistory.bind(this.editor)
			: this.editor.duplicateImageLayer.bind(this.editor);
		this.selectedImageLayer = await duplicateImageLayer(id, newId);
		this.selectedLayer = null;
		this.refreshImageLayers();
		return this.selectedImageLayer;
	}

	copySelectedLayer(): boolean {
		const selection = resolveClipboardLayerSelection(this.selectedLayer, this.selectedImageLayer, this.editor);
		if (selection?.kind === "text") {
			this.selectedLayer = selection.layer;
			this.selectedImageLayer = null;
			this.refreshTextLayers();
			this.layerClipboard = { kind: "text", id: selection.layer.id };
			projectStore.setStatusMsg("คัดลอกเลเยอร์ข้อความแล้ว");
			return true;
		}
		if (selection?.kind === "image") {
			this.selectedImageLayer = selection.layer;
			this.selectedLayer = null;
			this.refreshImageLayers();
			this.layerClipboard = { kind: "image", id: selection.layer.id };
			projectStore.setStatusMsg("คัดลอกรูปเสริมแล้ว");
			return true;
		}
		projectStore.setStatusMsg("เลือกเลเยอร์ก่อนคัดลอก");
		return false;
	}

	async pasteLayerClipboard(): Promise<boolean> {
		const item = this.layerClipboard;
		if (!item) {
			projectStore.setStatusMsg("คัดลอก Layer ก่อนวาง");
			return false;
		}

		if (item.kind === "text") {
			this.refreshTextLayers();
			if (!this.textLayers.some((layer) => layer.id === item.id)) {
				this.layerClipboard = null;
				projectStore.setStatusMsg("เลเยอร์ข้อความที่คัดลอกไว้ไม่มีแล้ว");
				return false;
			}
			const pasted = this.duplicateTextLayer(item.id);
			if (!pasted) return false;
			this.layerClipboard = { kind: "text", id: pasted.id };
			projectStore.setStatusMsg("วางเลเยอร์ข้อความแล้ว");
			return true;
		}

		this.refreshImageLayers();
		if (!this.imageLayers.some((layer) => layer.id === item.id)) {
			this.layerClipboard = null;
			projectStore.setStatusMsg("รูปเสริมที่คัดลอกไว้ไม่มีแล้ว");
			return false;
		}
		const pasted = await this.duplicateImageLayer(item.id);
		if (!pasted) return false;
		this.layerClipboard = { kind: "image", id: pasted.id };
		projectStore.setStatusMsg("วางรูปเสริมแล้ว");
		return true;
	}

	async duplicateSelectedLayer(): Promise<boolean> {
		const selection = resolveClipboardLayerSelection(this.selectedLayer, this.selectedImageLayer, this.editor);
		if (selection?.kind === "text") {
			const duplicated = this.duplicateTextLayer(selection.layer.id);
			if (!duplicated) return false;
			projectStore.setStatusMsg("ทำสำเนาเลเยอร์ข้อความแล้ว");
			return true;
		}
		if (selection?.kind === "image") {
			const duplicated = await this.duplicateImageLayer(selection.layer.id);
			if (!duplicated) return false;
			projectStore.setStatusMsg("ทำสำเนารูปเสริมแล้ว");
			return true;
		}
		projectStore.setStatusMsg("เลือกเลเยอร์ก่อนทำสำเนา");
		return false;
	}

	moveTextLayer(id: string, direction: -1 | 1): void {
		if (typeof this.editor?.moveTextLayer !== "function") return;
		this.selectedLayer = this.editor.moveTextLayer(id, direction);
		this.refreshTextLayers();
	}

	moveImageLayer(id: string, direction: -1 | 1): void {
		if (typeof this.editor?.moveImageLayer !== "function") return;
		this.imageLayerEditStartStates.delete(id);
		const moveImageLayer = typeof this.editor.moveImageLayerWithHistory === "function"
			? this.editor.moveImageLayerWithHistory.bind(this.editor)
			: this.editor.moveImageLayer.bind(this.editor);
		this.selectedImageLayer = moveImageLayer(id, direction);
		this.selectedLayer = null;
		this.refreshImageLayers();
	}

	moveUnifiedLayer(kind: "text" | "image", id: string, direction: -1 | 1): void {
		if (typeof this.editor?.moveLayerInStack !== "function") {
			if (kind === "text") this.moveTextLayer(id, direction);
			else this.moveImageLayer(id, direction);
			return;
		}
		const moveLayerInStack = typeof this.editor.moveLayerInStackWithHistory === "function"
			? this.editor.moveLayerInStackWithHistory.bind(this.editor)
			: this.editor.moveLayerInStack.bind(this.editor);
		const layer = moveLayerInStack(kind, id, direction);
		if (kind === "text") {
			this.selectedLayer = layer as TextLayer | null;
			this.selectedImageLayer = null;
		} else {
			this.selectedImageLayer = layer as ImageLayer | null;
			this.selectedLayer = null;
			this.imageLayerEditStartStates.delete(id);
		}
		this.refreshTextLayers();
		this.refreshImageLayers();
	}

	reorderUnifiedLayer(kind: "text" | "image", id: string, offset: number): void {
		if (!Number.isFinite(offset)) return;
		const steps = Math.abs(Math.trunc(offset));
		if (steps === 0) return;
		if (typeof this.editor?.moveLayerInStackByOffsetWithHistory !== "function") {
			const direction: -1 | 1 = offset > 0 ? 1 : -1;
			for (let step = 0; step < steps; step += 1) {
				this.moveUnifiedLayer(kind, id, direction);
			}
			return;
		}

		const layer = this.editor.moveLayerInStackByOffsetWithHistory(kind, id, offset);
		if (!layer) {
			this.refreshTextLayers();
			this.refreshImageLayers();
			return;
		}
		if (kind === "text") {
			this.selectedLayer = layer as TextLayer | null;
			this.selectedImageLayer = null;
		} else {
			this.selectedImageLayer = layer as ImageLayer | null;
			this.selectedLayer = null;
			this.imageLayerEditStartStates.delete(id);
		}
		this.refreshTextLayers();
		this.refreshImageLayers();
	}

	selectTextLayer(id: string): void {
		if (typeof this.editor?.selectTextLayer !== "function") return;
		this.imageLayerEditStartStates.clear();
		this.selectedLayer = this.editor.selectTextLayer(id);
		this.selectedImageLayer = null;
		this.refreshTextLayers();
	}

	selectImageLayer(id: string): void {
		if (typeof this.editor?.selectImageLayer !== "function") return;
		this.imageLayerEditStartStates.clear();
		this.selectedImageLayer = this.editor.selectImageLayer(id);
		this.selectedLayer = null;
		this.refreshImageLayers();
	}

	editTextLayer(id: string): void {
		if (typeof this.editor?.editTextLayer === "function") {
			this.selectedLayer = this.editor.editTextLayer(id);
		} else {
			this.selectTextLayer(id);
		}
		this.refreshTextLayers();
	}

	refreshTextLayers(): void {
		this.textLayers = this.editor?.getAllTextLayers?.() ?? [];
	}

	refreshImageLayers(): void {
		this.imageLayers = this.editor?.getAllImageLayers?.() ?? [];
		this.refreshBrushTarget();
	}

	/**
	 * Phase C — mirror the editor host's current non-destructive edit stack into the
	 * reactive store. Called after a page load (the project store seeds the editor via
	 * setImageEditLayers, which does NOT fire onImageEditLayersChange) so the Layers
	 * inspector "Edits" section shows the saved stack immediately.
	 */
	refreshImageEditLayers(): void {
		this.imageEditLayers = this.editor?.getImageEditLayers?.() ?? [];
	}

	/**
	 * Phase C — toggle one edit layer's visibility (undoable; recomposites + persists).
	 * Returns true if the toggle was applied.
	 */
	toggleImageEditLayerVisibility(layerId: string, visible?: boolean): boolean {
		return this.editor?.toggleImageEditLayerVisibility?.(layerId, visible) ?? false;
	}

	/** Phase C — rename one edit layer (persisted; not undoable, mirrors layer renames). */
	renameImageEditLayer(layerId: string, name: string): boolean {
		return this.editor?.renameImageEditLayer?.(layerId, name) ?? false;
	}

	/** Phase C — delete one edit layer as an undoable step (recomposites + persists). */
	deleteImageEditLayer(layerId: string): boolean {
		return this.editor?.deleteImageEditLayer?.(layerId) ?? false;
	}

	/**
	 * Phase C — "revert to before this edit": remove the target edit AND everything
	 * stacked after it, as one undoable step (recomposites + persists).
	 */
	revertToBeforeImageEditLayer(layerId: string): boolean {
		return this.editor?.revertToBeforeImageEditLayer?.(layerId) ?? false;
	}

	updateImageLayer(
		updates: Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "role" | "blendMode">>,
		commit = false,
	): void {
		if (!this.selectedImageLayer || typeof this.editor?.updateImageLayer !== "function") return;
		const layerId = this.selectedImageLayer.id;
		const safeUpdates = isAiResultImageLayer(this.selectedImageLayer)
			? { ...updates, role: "overlay" as const }
			: updates;

		if (!commit) {
			if (!this.imageLayerEditStartStates.has(layerId)) {
				this.imageLayerEditStartStates.set(layerId, { ...this.selectedImageLayer });
			}
			this.selectedImageLayer = this.editor.updateImageLayer(layerId, safeUpdates);
			this.refreshImageLayers();
			return;
		}

		const beforeLayer = this.imageLayerEditStartStates.get(layerId);
		if (beforeLayer) {
			this.selectedImageLayer = this.editor.updateImageLayer(layerId, safeUpdates);
			this.refreshImageLayers();
			const afterLayer = this.imageLayers.find((item) => item.id === layerId) ?? this.selectedImageLayer;
			if (afterLayer && typeof this.editor.recordImageLayerUpdateHistory === "function") {
				this.editor.recordImageLayerUpdateHistory(beforeLayer, afterLayer);
			}
			this.imageLayerEditStartStates.delete(layerId);
			return;
		}

		if (typeof this.editor.updateImageLayerWithHistory === "function") {
			this.selectedImageLayer = this.editor.updateImageLayerWithHistory(layerId, safeUpdates);
		} else {
			this.selectedImageLayer = this.editor.updateImageLayer(layerId, safeUpdates);
		}
		this.refreshImageLayers();
	}

	async addImageLayer(layer: ImageLayer, imageUrl: string): Promise<ImageLayer | null> {
		if (!this.editor) return null;
		const addImageLayer = typeof this.editor.addImageLayerWithHistory === "function"
			? this.editor.addImageLayerWithHistory.bind(this.editor)
			: this.editor.addImageLayer?.bind(this.editor);
		if (!addImageLayer) return null;

		const addedLayer = await addImageLayer(layer, imageUrl);
		this.selectedImageLayer = this.editor.selectImageLayer?.(addedLayer.id) ?? addedLayer;
		this.selectedLayer = null;
		this.refreshImageLayers();
		return this.selectedImageLayer;
	}

	async init(canvasEl: HTMLCanvasElement): Promise<any> {
		// Clean up existing editor and event listeners before re-initializing
		this.destroy();

		const { MangaEditor } = await import("$lib/canvas/editor.ts");
		this.editor = await MangaEditor.create(canvasEl);
		// Let the project store reach the live editor for a Language-Track switch
		// (flush current-track edits + reload the new track's text). project.svelte.ts
		// can't import this store (circular), so we push a getter in instead.
		projectStore.registerActiveEditorResolver(() => this.editor);

		// W3.13: build the image-edit suite (8 tools) and bind it to this editor as
		// its EditorToolHost. The canvas forwards pointer gestures here only while
		// an image-edit tool is active (editor.imageToolActive).
		const { createImageEditSuite } = await import("$lib/editor/tools/registry.ts");
		this.imageEditSuite = createImageEditSuite(this.editor);
		this.syncCloneStampOptions();
		this.syncHealingBrushOptions();
		this.syncImageToolFillColor();
		this.editor.setBrushColor?.(this.brushColor);
		// P1 — let page navigation (which only has the editor handle) drain + cancel
		// the registry's deferred-replay so a stroke buffered during a commit can't
		// replay onto the next page. waitForPendingBrushCommit() (awaited by goToPage)
		// calls drain; cancelImageToolDeferredReplay() calls cancel before currentPage
		// advances.
		this.editor.onDrainImageToolReplay = () => (
			this.imageEditSuite?.registry.waitForReplayIdle() ?? Promise.resolve()
		);
		this.editor.onCancelImageToolReplay = () => {
			this.imageEditSuite?.registry.cancelDeferredReplay();
		};
		// PR #264 worker-race fix — a heal stroke's off-thread Telea solve lives in
		// the registry's `commitInFlight` BEFORE it arms the editor's persist gate.
		// Expose it so hasPendingBrushCommit() reflects the in-flight worker op and
		// every wait-before-nav/teardown/export/save path blocks on the solve (then
		// the drain above awaits it via waitForReplayIdle → waitForCommit).
		this.editor.onIsImageToolCommitInFlight = () => (
			this.imageEditSuite?.registry.isCommitInFlight ?? false
		);
		// P1 — page/image navigation only holds the editor handle, but a suite tool
		// (clone/heal) can have an ACTIVE gesture (activeContext) from an OLD
		// pointer-down still open. handlePointerUp() falls back to `activeContext ??
		// buildContext()`, so a stale pointer-up after a page switch could commit
		// clone/heal pixels onto the NEW page. Wire the editor's nav-time cancel hook
		// to the registry so any active suite gesture is abandoned (no commit) before
		// currentPage/image advances.
		this.editor.onCancelImageToolActiveGesture = () => {
			this.imageEditSuite?.registry.cancelActiveGesture();
		};
		// Keep the suite path's selection overlay re-anchored after canvas
		// resize/recenter (imageBounds changed): the editor calls this on layout
		// changes; route it to the registry so the suite overlay doesn't drift.
		this.editor.onRefreshSelectionOverlay = () => {
			this.imageEditSuite?.registry.refreshSelectionOverlay();
		};
		this.editor.onImageToolPointer = (
			phase: "down" | "move" | "up",
			scene: { x: number; y: number },
			mod: { pressed: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
		) => {
			const registry = this.imageEditSuite?.registry;
			if (!registry) return;
			const input = {
				scene,
				pressed: mod.pressed,
				shiftKey: mod.shiftKey,
				altKey: mod.altKey,
				ctrlKey: mod.ctrlKey,
				metaKey: mod.metaKey,
			};
			if (phase === "down") registry.handlePointerDown(input);
			else if (phase === "move") registry.handlePointerMove(input);
			else registry.handlePointerUp(input);
		};

		this.editor.projectImageUrlResolver = (imageId: string) => (
			projectStore.project ? projectStore.getImageUrl(imageId) : imageId
		);
		this.editor.onTextLayerSelect = (layer: TextLayer | null) => {
			this.selectedLayer = layer;
			if (layer) this.selectedImageLayer = null;
			this.refreshBrushTarget();
		};
		this.editor.onImageLayerSelect = (layer: ImageLayer | null) => {
			this.selectedImageLayer = layer;
			if (layer) this.selectedLayer = null;
			this.refreshBrushTarget();
			const brushLayerPickIntent = editorUiStore.brushLayerPickIntent;
			if (layer && brushLayerPickIntent) {
				editorUiStore.focusImageInspector(layer.id);
				if (canUseCleanBrushOnImageLayer(layer) && layer.visible !== false && layer.locked !== true) {
					this.setTool("brush");
				}
			}
		};
		this.editor.onTextLayersChange = (layers: TextLayer[]) => {
			this.textLayers = layers;
			projectStore.captureEditorTextLayers(layers);
		};
		this.editor.onImageLayersChange = (layers: ImageLayer[]) => {
			this.imageLayers = layers;
			projectStore.captureEditorImageLayers(layers);
		};
		// Phase A non-destructive edits — bubble-clean records a small edit layer
		// (mask asset + fill + bbox) instead of baking a full page PNG.
		this.editor.onCommitImageEditLayer = (input: Parameters<typeof projectStore.commitImageEditLayer>[0]) => projectStore.commitImageEditLayer(input);
		// Phase B non-destructive edits — brush/healing/clone record a realized-patch edit
		// layer (small RGBA ROI asset + mask + metadata) instead of baking a full page PNG.
		this.editor.onCommitImageEditLayerPatch = (input: Parameters<typeof projectStore.commitImageEditLayerPatch>[0]) => projectStore.commitImageEditLayerPatch(input);
		// Phase B/C — an edit-layer add/remove/toggle/rename mutated the page stack:
		// persist it AND mirror it into the reactive store so the Layers inspector
		// "Edits" section re-renders live.
		this.editor.onImageEditLayersChange = (layers: ImageEditLayer[]) => {
			this.imageEditLayers = layers.map((layer) => ({ ...layer }));
			projectStore.captureEditorImageEditLayers(layers);
		};
		// Phase C — page load seeds the editor stack; mirror it WITHOUT persisting (no
		// unsaved flag) so the inspector "Edits" section shows the saved stack on open.
		this.editor.onImageEditLayersLoad = (layers: ImageEditLayer[]) => {
			this.imageEditLayers = layers.map((layer) => ({ ...layer }));
		};
		this.editor.onZoomChange = (zoom: number) => {
			this.zoomLevel = zoom;
		};
		this.editor.onViewportChange = () => {
			this.viewportVersion += 1;
		};
		this.editor.onHistoryChange = () => {
			this.updateHistoryState();
		};
		// P1 undo-404 GC guard: let the project store's superseded-edit-blob GC see which
		// durable image urls the LIVE undo/redo history can still restore, so it never
		// deletes a blob a pending undo would reload (404 + lost pre-stroke pixels).
		projectStore.registerLiveHistoryImageRefsProvider(() => this.editor?.getLiveHistoryImageRefs() ?? []);
		this.editor.onToolChange = (tool: Tool) => {
			this.currentTool = tool;
			this.refreshBrushTarget();
		};
		this.editor.onTextLayerCreate = (layer: TextLayer) => {
			this.selectedLayer = layer;
			this.selectedImageLayer = null;
			this.refreshTextLayers();
			this.refreshBrushTarget();
			editorUiStore.focusTextInspector(layer.id);
			projectStore.setStatusMsg("วางเลเยอร์ข้อความแล้ว");
		};
		this.editor.onImageLayerCreate = (layer: ImageLayer) => {
			this.selectedImageLayer = layer;
			this.selectedLayer = null;
			this.refreshImageLayers();
			this.refreshBrushTarget();
			projectStore.setStatusMsg("วางรูปเสริมแล้ว");
		};
		this.editor.onBrushTargetChange = () => {
			this.refreshBrushTarget();
		};
		this.editor.onBrushCommitErrorChange = (message: string | null) => {
			this.brushCommitError = message;
		};
		this.editor.onBrushTargetMiss = (message: string | null) => {
			this.brushTargetMissMessage = message;
			if (message) projectStore.setStatusMsg(message);
		};
		this.editor.onToolBusyChange = (busy: boolean, label?: string) => {
			this.toolBusy = busy;
			this.toolBusyLabel = busy ? (label ?? "กำลังประมวลผล") : null;
		};
		this.editor.onToolStatusChange = (message: string | null, tone = "info") => {
			this.imageToolStatusMessage = message;
			this.imageToolStatusTone = tone;
			if (message && tone === "blocked") projectStore.setStatusMsg(message);
		};
		this.editor.onToolClipped = (_pageNumber: number, message: string) => {
			// W3.15 — a stroke was held at the page boundary. Toast (deduped) +
			// status line so the user knows why the tool stopped at the edge.
			toastsStore.warn({ id: "tool-clipped-page-boundary", title: "เครื่องมือถูกจำกัดที่ขอบหน้า", body: message });
			projectStore.setStatusMsg(message);
		};
		this.editor.onPageBoundariesChanged = () => {
			// W3.15 — a (possibly different) page was loaded; re-validate the
			// role/lock-gated cross-page toggle against the new page so a stale
			// "ON" from the previous page cannot keep the clip disabled here.
			this.revalidateMultiPageMode();
		};
		this.editor.onImageLayerBrushCommit = (receipt: ImageLayerBrushCommitReceipt) => {
			this.lastImageLayerBrushCommit = receipt;
		};
		this.editor.onImageChange = (hasImage: boolean) => {
			this.hasImage = hasImage;
			if (!hasImage) {
				this.selectedLayer = null;
				this.selectedImageLayer = null;
				this.textLayers = [];
				this.imageLayers = [];
			}
			this.refreshBrushTarget();
		};
		this.editor.setTool(this.currentTool);
		// Cross-page mode resets to OFF for a fresh editor; re-assert the engine
		// flag so a stale (signed-out / role-changed) toggle never leaks open.
		this.multiPageMode = false;
		this.editor.setMultiPageMode(false);
		this.refreshBrushTarget();
		// DEV/E2E-only editor debug accessor. Loaded via a statically-foldable gated
		// dynamic import so production builds tree-shake the module (and its mask/
		// overlay deps) out of the bundle entirely — no prod behavior, no prod weight.
		if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
			const editor = this.editor;
			void import("$lib/debug/editor-debug.ts").then((m) => m.installEditorDebug(editor)).catch(() => {});
		}
		// Measure workspace container — skip Fabric's wrapper div
		const workspace = canvasEl.closest('.canvas-workspace') as HTMLElement | null;
		if (workspace) {
			const rect = workspace.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				this.editor.setContainerSize(Math.round(rect.width), Math.round(rect.height));
			}
		}

		// Setup keyboard shortcuts for undo/redo
		this.keydownHandler = (e: KeyboardEvent) => {
			// P1 — these are EDITOR shortcuts on a document-level listener, but the
			// WorkspaceShell that owns this editor also hosts the dashboard / library /
			// settings / reports views. The listener lives for the whole shell, so
			// single-letter tool keys (V/T/B/…), Delete/Backspace and Ctrl+Z/Y were
			// firing editor actions while the user was on the dashboard or library,
			// hijacking the keys. Gate on the active workspace view so editor shortcuts
			// only act when the editor surface is the one on screen.
			if (!shouldHandleEditorShortcut(editorUiStore.workspaceView)) return;
			const isTyping = isEditorTextEntryTarget(e.target);
			const pageNavigation = isTyping ? null : resolvePageNavigationShortcut(e, {
				// `[`/`]` resize the brush (not navigate pages) while the legacy clean
				// brush OR a heal/clone image paint tool is active.
				ignoreBrushBracketKeys: this.currentTool === "brush" || this.isImagePaintTool,
				readingDirection: projectStore.readingDirection,
			});

			// While a Fabric text object is in in-place edit mode, the typing target
			// is the canvas wrapper (which `isEditorTextEntryTarget` intentionally
			// excludes), so undo/redo would otherwise hijack the APP history mid-type.
			// Let the browser's NATIVE textarea undo/redo handle Ctrl+Z/Y here instead.
			const isEditingFabricText = typeof this.editor?.isEditingText === "function" && this.editor.isEditingText();

			// Ctrl+Z for undo, Ctrl+Y for redo
			if (isEditingFabricText && (e.ctrlKey || e.metaKey) && (matchesShortcutKey(e, "z") || matchesShortcutKey(e, "y"))) {
				// Native text-edit undo/redo — do not preventDefault, do not touch app history.
				return;
			} else if ((e.ctrlKey || e.metaKey) && matchesShortcutKey(e, "z") && !e.shiftKey) {
				e.preventDefault();
				this.undo();
			} else if ((e.ctrlKey || e.metaKey) && (matchesShortcutKey(e, "y") || (matchesShortcutKey(e, "z") && e.shiftKey))) {
				e.preventDefault();
				this.redo();
			} else if (!isTyping && (e.ctrlKey || e.metaKey) && matchesShortcutKey(e, "c")) {
				e.preventDefault();
				this.copySelectedLayer();
			} else if (!isTyping && (e.ctrlKey || e.metaKey) && matchesShortcutKey(e, "v")) {
				e.preventDefault();
				void this.pasteLayerClipboard();
			} else if (!isTyping && (e.ctrlKey || e.metaKey) && matchesShortcutKey(e, "d")) {
				e.preventDefault();
				void this.duplicateSelectedLayer();
			} else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S" || e.code === "KeyS")) {
				// #E6b: Ctrl/Cmd+S flushes the pending autosave NOW instead of opening the
				// browser's "save page" dialog (which made users think the app never saved).
				e.preventDefault();
				void this.flushPendingEdits().then(() => projectStore.setStatusMsg("บันทึกงานแล้ว"));
			} else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+" || e.code === "Equal")) {
				// #R5: Ctrl/Cmd +/-/0 zoom the CANVAS (matching the on-screen viewport
				// buttons' 1.22/0.82 steps + fit-reset), and intercept the browser's native
				// page-zoom so it doesn't fight the editor. The whole handler is already
				// gated on the editor view being on screen.
				e.preventDefault();
				this.zoomViewportBy(1.22);
			} else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_" || e.code === "Minus")) {
				e.preventDefault();
				this.zoomViewportBy(0.82);
			} else if ((e.ctrlKey || e.metaKey) && (e.key === "0" || e.code === "Digit0")) {
				e.preventDefault();
				this.resetViewportZoom();
			} else if (!isTyping && e.key === "Escape") {
				e.preventDefault();
				this.cancelActiveTool();
			} else if (!isTyping && this.isImagePaintTool && (e.key === "[" || e.code === "BracketLeft")) {
				e.preventDefault();
				this.adjustImageToolBrushSize(-4);
			} else if (!isTyping && this.isImagePaintTool && (e.key === "]" || e.code === "BracketRight")) {
				e.preventDefault();
				this.adjustImageToolBrushSize(4);
			} else if (!isTyping && this.currentTool === "brush" && (e.key === "[" || e.code === "BracketLeft")) {
				e.preventDefault();
				this.adjustBrushSize(-4);
			} else if (!isTyping && this.currentTool === "brush" && (e.key === "]" || e.code === "BracketRight")) {
				e.preventDefault();
				this.adjustBrushSize(4);
			} else if (!isTyping && this.currentTool === "brush" && e.code === "KeyE") {
				e.preventDefault();
				this.toggleBrushModeFromShortcut();
			} else if (!isTyping && !isEditingFabricText && this.activateToolShortcutEvent(e)) {
				// Left-dock tool shortcuts are routed through the canonical keymap so
				// family variants such as Shift+G (screentone) do not collapse to the
				// bare G bucket-fill binding. Brush's own [ ] E adjust-shortcuts are
				// handled above so they win while painting. In-place Fabric text edit
				// must keep typing uppercase letters (Shift+R = ตัวอักษร ไม่ใช่
				// Refine Edge — codex P2).
				e.preventDefault();
			} else if (
				!isTyping
				&& !isEditingFabricText
				&& this.selectedLayer
				&& this.editor
				&& (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")
			) {
				// #E2: arrow keys nudge the selected text layer for pixel-perfect typesetting
				// (Shift = 10px) instead of flipping the page. A burst collapses to one undo.
				// Falls through to page navigation when no text layer is selected or it's locked.
				const step = e.shiftKey ? 10 : 1;
				const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
				const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
				if (this.editor.nudgeSelectedTextLayer(dx, dy)) {
					e.preventDefault();
				} else if (pageNavigation) {
					e.preventDefault();
					void this.navigatePageByShortcut(pageNavigation);
				}
			} else if (pageNavigation) {
				e.preventDefault();
				void this.navigatePageByShortcut(pageNavigation);
			} else if (!isTyping && (e.key === "Delete" || e.key === "Backspace")) {
				if (this.selectedLayer) {
					e.preventDefault();
					this.deleteTextLayer();
					projectStore.setStatusMsg("ลบเลเยอร์ข้อความแล้ว");
				} else if (this.selectedImageLayer) {
					e.preventDefault();
					this.deleteImageLayer();
					projectStore.setStatusMsg("ลบรูปเสริมแล้ว");
				}
			}
		};
		document.addEventListener('keydown', this.keydownHandler);

		this.copyHandler = (e: ClipboardEvent) => {
			if (!shouldHandleLayerClipboardEvent(e.target)) return;
			if (this.copySelectedLayer()) {
				e.preventDefault();
			}
		};
		document.addEventListener("copy", this.copyHandler);

		return this.editor;
	}

	private async navigatePageByShortcut(direction: "prev" | "next"): Promise<void> {
		if (!this.editor || !projectStore.project || projectStore.pageNavigationBusy) return;
		const moved = direction === "prev"
			? await projectStore.prevPage(this.editor)
			: await projectStore.nextPage(this.editor);
		if (moved) {
			this.refreshTextLayers();
		}
	}

	destroy(): void {
		if (this.keydownHandler) {
			document.removeEventListener('keydown', this.keydownHandler);
			this.keydownHandler = undefined;
		}
		if (this.copyHandler) {
			document.removeEventListener("copy", this.copyHandler);
			this.copyHandler = undefined;
		}
		if (this.imageEditSuite) {
			const registry = this.imageEditSuite.registry;
			registry.deactivateActive();
			// The MaskBuffer is a process-wide singleton (mask-buffer.ts), so a
			// re-init of a same-dimension editor would inherit this session's stale
			// selection invisibly (buildContext() only resets the mask on a
			// dimension/page change). Clear the mask + on-canvas overlay now, while
			// the host editor is still alive, so the next editor starts empty.
			registry.clearSelection();
			this.imageEditSuite = null;
		}
		// Terminate the off-thread inpaint worker (rec #2) so it doesn't leak across
		// editor sessions. A fresh editor lazily re-spawns it on the next heal stroke.
		void import("$lib/editor/tools/inpaint-worker-client.ts")
			.then((m) => m.teardownInpaintWorker())
			.catch(() => {});
		this.activeImageTool = null;
		// Unregister the live-history GC provider before the editor is gone so the project
		// store doesn't call into a destroyed editor; the editor's history is also being
		// torn down, freeing those blobs for GC on the next save (P1 undo-404 guard).
		projectStore.registerLiveHistoryImageRefsProvider(null);
		if (this.editor) {
			this.editor.destroy();
			this.editor = null;
		}
		projectStore.registerActiveEditorResolver(null);
		if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
			void import("$lib/debug/editor-debug.ts").then((m) => m.uninstallEditorDebug()).catch(() => {});
		}
		// Reset state
		this.selectedLayer = null;
		this.selectedImageLayer = null;
		this.textLayers = [];
		this.imageLayers = [];
		this.hasImage = false;
		this.zoomLevel = 1;
		this.viewportVersion = 0;
		this.canUndo = false;
		this.canRedo = false;
		this.historyEntries = [];
		this.historyCurrentIndex = -1;
		this.currentTool = "select";
		this.brushTarget = unavailableBrushTarget;
		this.brushCommitError = null;
		this.brushTargetMissMessage = null;
		this.toolBusy = false;
		this.toolBusyLabel = null;
		this.imageToolStatusMessage = null;
		this.imageToolStatusTone = "info";
		this.brushSize = 30;
		this.brushHardness = 50;
		this.brushOpacity = 100;
		this.brushColor = "#FFFFFF";
		this.brushMode = "erase";
		this.imageToolFillColor = "#FFFFFF";
		this.lastImageLayerBrushCommit = null;
		this.imageLayerEditStartStates.clear();
	}
}

export const editorStore = new EditorStore();
