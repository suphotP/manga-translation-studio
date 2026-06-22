import type { WorkspaceRegionBox } from "$lib/editor/overlay-geometry.js";

export type CanvasOverlayLabelSide = "above" | "below" | "inside";
export type CanvasOverlayLabelAlign = "left" | "right";

export interface CanvasOverlayLabelTarget {
	id: string;
	box: WorkspaceRegionBox;
	label: string;
	laneIndex?: number;
	preferredAlign?: CanvasOverlayLabelAlign;
	selected?: boolean;
	preferredSide?: CanvasOverlayLabelSide;
}

export interface CanvasOverlayLabelPlacement {
	id: string;
	side: CanvasOverlayLabelSide;
	align: CanvasOverlayLabelAlign;
	relativeLeft: number;
	relativeTop: number;
	width: number;
	height: number;
	stackIndex: number;
}

export interface CanvasOverlayLabelPlacementOptions {
	defaultWidth?: number;
	minWidth?: number;
	maxWidth?: number;
	height?: number;
	gap?: number;
	maxStackIndex?: number;
	viewportWidth?: number;
	viewportHeight?: number;
}

interface LabelCandidate {
	side: CanvasOverlayLabelSide;
	align: CanvasOverlayLabelAlign;
	stackIndex: number;
	left: number;
	top: number;
	width: number;
	height: number;
	score: number;
}

interface LabelRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

const DEFAULT_LABEL_WIDTH = 132;
const MIN_LABEL_WIDTH = 78;
const MAX_LABEL_WIDTH = 168;
const DEFAULT_LABEL_HEIGHT = 24;
const DEFAULT_GAP = 6;
const DEFAULT_MAX_STACK_INDEX = 4;

export function buildCanvasOverlayLabelPlacements(
	targets: CanvasOverlayLabelTarget[],
	options: CanvasOverlayLabelPlacementOptions = {},
): Record<string, CanvasOverlayLabelPlacement> {
	const placedRects: LabelRect[] = [];
	const placements: Record<string, CanvasOverlayLabelPlacement> = {};
	const orderedTargets = [...targets].sort((a, b) => {
		if (Boolean(a.selected) !== Boolean(b.selected)) return a.selected ? -1 : 1;
		return a.box.top - b.box.top || a.box.left - b.box.left || a.id.localeCompare(b.id);
	});

	for (const target of orderedTargets) {
		const placement = pickPlacement(target, placedRects, options);
		placements[target.id] = placement;
		placedRects.push({
			left: target.box.left + placement.relativeLeft,
			top: target.box.top + placement.relativeTop,
			width: placement.width,
			height: placement.height,
		});
	}

	return placements;
}

export function formatCanvasOverlayLabelStyle(placement: CanvasOverlayLabelPlacement): string {
	return [
		`--overlay-label-left:${roundPx(placement.relativeLeft)}px`,
		`--overlay-label-top:${roundPx(placement.relativeTop)}px`,
		`--overlay-label-width:${roundPx(placement.width)}px`,
		`--overlay-label-height:${roundPx(placement.height)}px`,
	].join(";");
}

function pickPlacement(
	target: CanvasOverlayLabelTarget,
	placedRects: LabelRect[],
	options: CanvasOverlayLabelPlacementOptions,
): CanvasOverlayLabelPlacement {
	const labelWidth = estimateLabelWidth(target.label, options);
	const labelHeight = options.height ?? DEFAULT_LABEL_HEIGHT;
	const candidates = buildCandidates(target, labelWidth, labelHeight, placedRects, options);
	const best = candidates.sort((a, b) => a.score - b.score)[0];

	return {
		id: target.id,
		side: best.side,
		align: best.align,
		relativeLeft: best.left - target.box.left,
		relativeTop: best.top - target.box.top,
		width: best.width,
		height: best.height,
		stackIndex: best.stackIndex,
	};
}

function buildCandidates(
	target: CanvasOverlayLabelTarget,
	labelWidth: number,
	labelHeight: number,
	placedRects: LabelRect[],
	options: CanvasOverlayLabelPlacementOptions,
): LabelCandidate[] {
	const sides = preferredSides(target);
	const aligns = preferredAligns(target);
	const maxStackIndex = options.maxStackIndex ?? DEFAULT_MAX_STACK_INDEX;
	const baseStackIndex = target.selected ? 0 : Math.max(0, target.laneIndex ?? 0);
	const candidates: LabelCandidate[] = [];

	for (const side of sides) {
		for (const align of aligns) {
			for (let stackIndex = baseStackIndex; stackIndex <= maxStackIndex; stackIndex += 1) {
				const candidate = buildCandidate(
					target.box,
					side,
					align,
					stackIndex,
					labelWidth,
					labelHeight,
					options,
				);
				candidate.score = scoreCandidate(candidate, placedRects, options)
					+ sides.indexOf(side) * 7
					+ aligns.indexOf(align) * 2
					+ stackIndex;
				candidates.push(candidate);
			}
		}
	}

	return candidates;
}

function buildCandidate(
	box: WorkspaceRegionBox,
	side: CanvasOverlayLabelSide,
	align: CanvasOverlayLabelAlign,
	stackIndex: number,
	width: number,
	height: number,
	options: CanvasOverlayLabelPlacementOptions,
): LabelCandidate {
	const gap = options.gap ?? DEFAULT_GAP;
	const stackOffset = stackIndex * (height + 2);
	const left = align === "left" ? box.left : box.left + box.width - width;
	let top = box.top + 4 + stackOffset;

	if (side === "above") {
		top = box.top - gap - height - stackOffset;
	} else if (side === "below") {
		top = box.top + box.height + gap + stackOffset;
	}

	return {
		side,
		align,
		stackIndex,
		left,
		top,
		width,
		height,
		score: 0,
	};
}

function preferredSides(target: CanvasOverlayLabelTarget): CanvasOverlayLabelSide[] {
	const preferred = target.selected ? "above" : target.preferredSide ?? "above";
	const sideSet = new Set<CanvasOverlayLabelSide>([
		preferred,
		preferred === "above" ? "below" : "above",
		"inside",
	]);
	return Array.from(sideSet);
}

function preferredAligns(target: CanvasOverlayLabelTarget): CanvasOverlayLabelAlign[] {
	const preferred = target.preferredAlign ?? "left";
	const aligns = new Set<CanvasOverlayLabelAlign>([preferred, preferred === "left" ? "right" : "left"]);
	return Array.from(aligns);
}

function scoreCandidate(
	candidate: LabelCandidate,
	placedRects: LabelRect[],
	options: CanvasOverlayLabelPlacementOptions,
): number {
	let score = overflowPenalty(candidate, options);
	for (const rect of placedRects) {
		const overlap = overlapArea(candidate, rect);
		if (overlap > 0) score += 1000 + overlap;
	}
	return score;
}

function overflowPenalty(
	rect: LabelRect,
	options: CanvasOverlayLabelPlacementOptions,
): number {
	let penalty = 0;
	if (options.viewportWidth !== undefined) {
		penalty += Math.max(0, -rect.left) * 8;
		penalty += Math.max(0, rect.left + rect.width - options.viewportWidth) * 8;
	}
	if (options.viewportHeight !== undefined) {
		penalty += Math.max(0, -rect.top) * 8;
		penalty += Math.max(0, rect.top + rect.height - options.viewportHeight) * 8;
	}
	return penalty;
}

function overlapArea(a: LabelRect, b: LabelRect): number {
	const xOverlap = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
	const yOverlap = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
	return xOverlap * yOverlap;
}

function estimateLabelWidth(label: string, options: CanvasOverlayLabelPlacementOptions): number {
	const minWidth = options.minWidth ?? MIN_LABEL_WIDTH;
	const maxWidth = options.maxWidth ?? MAX_LABEL_WIDTH;
	const defaultWidth = options.defaultWidth ?? DEFAULT_LABEL_WIDTH;
	const measuredWidth = Math.max(minWidth, label.trim().length * 7 + 24);
	return Math.min(maxWidth, Math.max(defaultWidth, measuredWidth));
}

function roundPx(value: number): number {
	return Math.round(value * 100) / 100;
}
