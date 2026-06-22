import type { Tool } from "$lib/types.js";

export type CanvasOverlayKind =
	| "ai-review"
	| "comment"
	| "qc"
	| "overlay-controls"
	| "viewport-controls"
	| "tool-hint"
	| "asset-error"
	| "loading";

export type CanvasWorkOverlayKind = "qc" | "comment" | "ai-review";
export type CanvasOverlayVisibility = Record<CanvasWorkOverlayKind, boolean>;

export interface CanvasWorkOverlaySwatch {
	color: string;
	token?: string;
	// Stable code; consumers localize via $_("canvasOverlay.swatch.<labelCode>").
	labelCode: string;
}

export interface CanvasWorkOverlayMeta {
	id: CanvasWorkOverlayKind;
	// `label`/`shortLabel` are STABLE: the overlay kind is itself a code, and the
	// localizable display text lives in the i18n catalog. `qc`/`ai-review` use the
	// ASCII product terms "QC"/"AI" verbatim; `comment` carries no display text
	// here — consumers localize via $_("canvasOverlay.kind.<id>") /
	// $_("canvasOverlay.shortLabel.<id>") / $_("canvasOverlay.description.<id>").
	swatches?: CanvasWorkOverlaySwatch[];
}

interface OverlayPriorityOptions {
	selected?: boolean;
	activeLayer?: boolean;
}

export const CANVAS_WORK_OVERLAY_KINDS: CanvasWorkOverlayKind[] = ["qc", "comment", "ai-review"];

export const DEFAULT_CANVAS_OVERLAY_VISIBILITY: CanvasOverlayVisibility = {
	qc: true,
	comment: true,
	"ai-review": true,
};

export const CANVAS_WORK_OVERLAY_META: Record<CanvasWorkOverlayKind, CanvasWorkOverlayMeta> = {
	qc: {
		id: "qc",
		swatches: [
			{ color: "#ffd37a", token: "ws-amber", labelCode: "qcWarning" }, // แจ้งเตือน (Warning)
			{ color: "#ffb4a8", token: "ws-rose", labelCode: "qcError" }, // ผิดพลาด (Error)
		],
	},
	comment: {
		id: "comment",
		swatches: [
			{ color: "#5eead4", token: "ws-cyan", labelCode: "commentMessage" }, // ข้อความคอมเมนต์
		],
	},
	"ai-review": {
		id: "ai-review",
		swatches: [
			{ color: "#ffd37a", token: "ws-amber", labelCode: "aiDefault" }, // รอรีวิว (Default)
			{ color: "#6ee7d3", token: "ws-green", labelCode: "aiResolved" }, // ยอมรับ/ใช้งาน (Resolved)
			{ color: "#ffb4a8", token: "ws-rose", labelCode: "aiRejected" }, // ปฏิเสธ (Rejected)
		],
	},
};

export interface CanvasChromeOverlaySwatch {
	color: string;
	token?: string;
	// Stable code; consumers localize via $_("canvasOverlay.chromeSwatch.<labelCode>").
	labelCode: string;
	type: "border" | "line" | "dot";
}

export const CANVAS_CHROME_OVERLAY_SWATCHES: CanvasChromeOverlaySwatch[] = [
	{ color: "#3b82f6", token: "ws-blue", labelCode: "focused", type: "border" }, // วัตถุที่เลือก (Focused)
	{ color: "#60a5fa", token: "ws-blue", labelCode: "default", type: "border" }, // เลเยอร์ทั่วไป (Default)
	{ color: "#fbbf24", token: "ws-amber", labelCode: "creditCover", type: "border" }, // เลเยอร์เครดิต/ปก (Credit/Cover)
	{ color: "#6ee7d3", token: "ws-cyan", labelCode: "aiResult", type: "border" }, // เลเยอร์ผล AI (AI Result)
	{ color: "#ef4444", token: "ws-rose", labelCode: "pageBoundary", type: "line" }, // ขอบตัดแบ่งหน้า (Page Boundary)
];

const OVERLAY_BASE_Z_INDEX: Record<CanvasOverlayKind, number> = {
	"ai-review": 10,
	comment: 20,
	qc: 30,
	"overlay-controls": 180,
	"viewport-controls": 190,
	"tool-hint": 200,
	"asset-error": 300,
	loading: 400,
};

const ACTIVE_LAYER_BONUS = 50;
const SELECTED_BONUS = 100;

export function getCanvasOverlayZIndex(
	kind: CanvasOverlayKind,
	options: OverlayPriorityOptions = {},
): number {
	let zIndex = OVERLAY_BASE_Z_INDEX[kind];
	if (options.activeLayer) zIndex += ACTIVE_LAYER_BONUS;
	if (options.selected) zIndex += SELECTED_BONUS;
	return zIndex;
}

export function isCanvasOverlayInteractive(currentTool: Tool): boolean {
	return currentTool === "select";
}
