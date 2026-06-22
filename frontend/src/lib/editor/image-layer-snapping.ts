import type { ImageLayer } from "$lib/types.js";

export type ImageLayerSnapGuideOrientation = "vertical" | "horizontal";
export type ImageLayerSnapGuideKind = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";

export interface ImageLayerSnapGuide {
	orientation: ImageLayerSnapGuideOrientation;
	kind: ImageLayerSnapGuideKind;
	position: number;
}

export interface ImageLayerSnapInput {
	layer: Pick<ImageLayer, "x" | "y" | "w" | "h">;
	imageWidth: number;
	imageHeight: number;
	thresholdX: number;
	thresholdY: number;
}

export interface ImageLayerSnapResult {
	x: number;
	y: number;
	guides: ImageLayerSnapGuide[];
}

interface SnapAnchor {
	kind: ImageLayerSnapGuideKind;
	position: number;
}

interface SnapCandidate {
	kind: ImageLayerSnapGuideKind;
	target: number;
	delta: number;
	distance: number;
}

function pickClosestSnapCandidate(
	anchors: SnapAnchor[],
	targets: SnapAnchor[],
	threshold: number,
): SnapCandidate | null {
	let best: SnapCandidate | null = null;
	for (const anchor of anchors) {
		for (const target of targets) {
			const delta = target.position - anchor.position;
			const distance = Math.abs(delta);
			if (distance > threshold) continue;
			if (!best || distance < best.distance) {
				best = {
					kind: target.kind,
					target: target.position,
					delta,
					distance,
				};
			}
		}
	}
	return best;
}

export function snapImageLayerToImageGuides(input: ImageLayerSnapInput): ImageLayerSnapResult {
	const { layer, imageWidth, imageHeight } = input;
	const thresholdX = Math.max(0, input.thresholdX);
	const thresholdY = Math.max(0, input.thresholdY);
	const centerX = imageWidth / 2;
	const centerY = imageHeight / 2;
	const guides: ImageLayerSnapGuide[] = [];

	const verticalTargets: SnapAnchor[] = [
		{ kind: "left", position: 0 },
		{ kind: "center-x", position: centerX },
		{ kind: "right", position: imageWidth },
	];
	const verticalAnchors: SnapAnchor[] = [
		{ kind: "left", position: layer.x },
		{ kind: "center-x", position: layer.x + layer.w / 2 },
		{ kind: "right", position: layer.x + layer.w },
	];
	const horizontalTargets: SnapAnchor[] = [
		{ kind: "top", position: 0 },
		{ kind: "center-y", position: centerY },
		{ kind: "bottom", position: imageHeight },
	];
	const horizontalAnchors: SnapAnchor[] = [
		{ kind: "top", position: layer.y },
		{ kind: "center-y", position: layer.y + layer.h / 2 },
		{ kind: "bottom", position: layer.y + layer.h },
	];

	const verticalSnap = pickClosestSnapCandidate(verticalAnchors, verticalTargets, thresholdX);
	const horizontalSnap = pickClosestSnapCandidate(horizontalAnchors, horizontalTargets, thresholdY);

	let x = layer.x;
	let y = layer.y;
	if (verticalSnap) {
		x = Math.round(layer.x + verticalSnap.delta);
		guides.push({ orientation: "vertical", kind: verticalSnap.kind, position: verticalSnap.target });
	}
	if (horizontalSnap) {
		y = Math.round(layer.y + horizontalSnap.delta);
		guides.push({ orientation: "horizontal", kind: horizontalSnap.kind, position: horizontalSnap.target });
	}

	return { x, y, guides };
}
