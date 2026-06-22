// Per-region AI generation history.
//
// Each AI run on a cropped region produces an AiReviewMarker. A rerun / "retry
// with prompt" produces a NEW marker that links back to the one it was run from
// via `sourceMarkerId`. That chain — plus any markers that simply target the
// exact same page+region — is the region's GENERATION HISTORY: the user can
// review, accept/revert, and CYCLE between older and newer generations of the
// same area instead of losing the previous result.
//
// This module derives that grouping (pure, no store access) so both the canvas
// overlay (anchored controls) and the review panel can present a version picker
// for the region a marker belongs to.

import type { AiReviewMarker } from "$lib/types.js";

export interface AiRegionVersion {
	marker: AiReviewMarker;
	/** 1-based generation number within the lineage (oldest = 1). */
	version: number;
}

export interface AiRegionHistory {
	/** Stable id of the lineage (the root marker's id). */
	lineageId: string;
	pageIndex: number;
	region: { x: number; y: number; w: number; h: number };
	/** All generations for this region, oldest → newest. */
	versions: AiRegionVersion[];
}

function markerTime(marker: AiReviewMarker): number {
	return Date.parse(marker.createdAt || marker.updatedAt || "") || 0;
}

function sameRegion(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean {
	// Reruns reuse the exact source region, so an exact match is the right test;
	// round to guard against float noise from any client round-trip.
	return Math.round(a.x) === Math.round(b.x)
		&& Math.round(a.y) === Math.round(b.y)
		&& Math.round(a.w) === Math.round(b.w)
		&& Math.round(a.h) === Math.round(b.h);
}

/**
 * Resolve the lineage ROOT id for a marker: follow `sourceMarkerId` up the chain
 * to the earliest ancestor present in `byId`. Falls back to the marker's own id
 * when it has no (resolvable) source.
 */
function resolveLineageRoot(marker: AiReviewMarker, byId: Map<string, AiReviewMarker>): string {
	let current = marker;
	const seen = new Set<string>([current.id]);
	while (current.sourceMarkerId) {
		const parent = byId.get(current.sourceMarkerId);
		// Stop on a missing or cyclic parent — treat the current node as the root.
		if (!parent || seen.has(parent.id)) break;
		seen.add(parent.id);
		current = parent;
	}
	return current.id;
}

/**
 * Build per-region histories for a set of markers (typically one page's
 * markers). Markers are grouped first by `sourceMarkerId` lineage, then any
 * lineages that share the exact same page+region are merged so a region with a
 * broken/absent source link still shows a single combined history.
 */
export function buildAiRegionHistories(markers: AiReviewMarker[]): AiRegionHistory[] {
	if (markers.length === 0) return [];
	const byId = new Map(markers.map((marker) => [marker.id, marker]));

	// 1) Group by resolved lineage root.
	const byRoot = new Map<string, AiReviewMarker[]>();
	for (const marker of markers) {
		const root = resolveLineageRoot(marker, byId);
		const group = byRoot.get(root) ?? [];
		group.push(marker);
		byRoot.set(root, group);
	}

	// 2) Merge lineages that target the identical page+region (covers reruns that
	//    lost their source link, or two manual runs over the same crop).
	const merged: AiReviewMarker[][] = [];
	for (const group of byRoot.values()) {
		const sample = group[0];
		const existing = merged.find((bucket) => {
			const head = bucket[0];
			return head.pageIndex === sample.pageIndex && sameRegion(head.region, sample.region);
		});
		if (existing) existing.push(...group);
		else merged.push([...group]);
	}

	return merged.map((group) => {
		const versions = [...group]
			.sort((a, b) => {
				const delta = markerTime(a) - markerTime(b);
				if (delta !== 0) return delta;
				return a.id.localeCompare(b.id);
			})
			.map((marker, index) => ({ marker, version: index + 1 }));
		const root = versions[0]?.marker ?? group[0];
		return {
			lineageId: root.id,
			pageIndex: root.pageIndex,
			region: root.region,
			versions,
		};
	});
}

/**
 * Find the history a specific marker belongs to (or null if absent). Useful for
 * an anchored control that needs the sibling generations of the marker it's
 * showing.
 */
export function findAiRegionHistoryForMarker(
	histories: AiRegionHistory[],
	markerId: string | null | undefined,
): AiRegionHistory | null {
	if (!markerId) return null;
	return histories.find((history) => history.versions.some((entry) => entry.marker.id === markerId)) ?? null;
}

/** The version entry for a marker within its history (or null). */
export function findAiRegionVersion(
	history: AiRegionHistory | null,
	markerId: string | null | undefined,
): AiRegionVersion | null {
	if (!history || !markerId) return null;
	return history.versions.find((entry) => entry.marker.id === markerId) ?? null;
}
