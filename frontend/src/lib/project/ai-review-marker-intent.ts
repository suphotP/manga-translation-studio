import type { AiReviewMarker, AiReviewMarkerStatus, ProjectState } from "$lib/types.js";
import { getAiMarkerReferenceIssue } from "$lib/project/ai-marker-reference.js";

export function hasAiResultLayer(project: ProjectState | null | undefined, marker: AiReviewMarker): boolean {
	const page = project?.pages[marker.pageIndex];
	return page?.imageLayers?.some((layer) => layer.id === `ai-result-${marker.id}`) === true;
}

export function aiResultLayerId(marker: AiReviewMarker): string {
	return `ai-result-${marker.id}`;
}

export function findAiResultMarkerForLayer(markers: AiReviewMarker[], layerId: string | null | undefined): AiReviewMarker | null {
	if (!layerId?.startsWith("ai-result-")) return null;
	return markers.find((marker) => aiResultLayerId(marker) === layerId) ?? null;
}

export function isAiResultPlacementNeeded(project: ProjectState | null | undefined, marker: AiReviewMarker): boolean {
	return marker.status === "accepted" && Boolean(marker.resultImageId) && !hasAiResultLayer(project, marker);
}

export function isAiResultLayerAvailable(project: ProjectState | null | undefined, marker: AiReviewMarker): boolean {
	return Boolean(marker.resultImageId)
		&& (marker.status === "accepted" || marker.status === "applied")
		&& hasAiResultLayer(project, marker);
}

export function canPlaceAiResultAsEditableLayer(project: ProjectState | null | undefined, marker: AiReviewMarker): boolean {
	if (!marker.resultImageId) return false;
	if (hasAiResultLayer(project, marker)) return false;
	if (getAiMarkerReferenceIssue(project, marker)) return false;
	return marker.status === "accepted" || marker.status === "applied";
}

export function isAiResultPlacementOrRecoveryNeeded(project: ProjectState | null | undefined, marker: AiReviewMarker): boolean {
	return canPlaceAiResultAsEditableLayer(project, marker);
}

export function findAiResultPlacementMarker(
	project: ProjectState | null | undefined,
	markers: AiReviewMarker[],
	pageIndex: number,
): AiReviewMarker | null {
	return markers.find((marker) => (
		marker.pageIndex === pageIndex
		&& isAiResultPlacementOrRecoveryNeeded(project, marker)
	)) ?? null;
}

export function aiReviewTierLabel(marker: AiReviewMarker): string {
	const labels: Record<AiReviewMarker["tier"], string> = {
		"budget-clean": "Clean Lite",
		"clean-pro": "Clean Pro",
		"sfx-pro": "SFX Pro",
	};
	return labels[marker.tier];
}

function markerCreatedTime(marker: AiReviewMarker): number {
	return Date.parse(marker.createdAt || marker.updatedAt || "") || 0;
}

export function aiReviewMarkerReferenceLabel(markers: AiReviewMarker[], marker: AiReviewMarker): string {
	const pageMarkers = markers
		.filter((item) => item.pageIndex === marker.pageIndex)
		.sort((a, b) => {
			const timeDelta = markerCreatedTime(a) - markerCreatedTime(b);
			if (timeDelta !== 0) return timeDelta;
			return a.id.localeCompare(b.id);
		});
	const index = pageMarkers.findIndex((item) => item.id === marker.id);
	return `AI ${Math.max(0, index) + 1}`;
}

export function aiReviewMarkerPageReferenceLabel(markers: AiReviewMarker[], marker: AiReviewMarker): string {
	return `P${marker.pageIndex + 1} · ${aiReviewMarkerReferenceLabel(markers, marker)}`;
}

// Stable status code = the marker status enum itself. Consumers localize via
// `$_("aiReviewMarker.status.<code>")` and compare on the code, never on the
// (formerly Thai) label text. The status map drove processing→กำลังรัน,
// needs_review→รอรีวิว, accepted→ผ่านรีวิว, rejected→ไม่ใช้,
// retry_requested→ขอรันใหม่, applied→วางแล้ว, failed→รันพลาด.
export type AiReviewStatusCode = AiReviewMarkerStatus;

export function aiReviewStatusLabel(
	markerOrStatus: AiReviewMarker | AiReviewMarkerStatus,
): AiReviewStatusCode {
	return typeof markerOrStatus === "string" ? markerOrStatus : markerOrStatus.status;
}

// Result-placement state of an AI marker. Same branch precedence as before;
// only the RETURN changed from Thai to a code (ยังไม่วาง→not_placed,
// วางแล้ว→placed, เลเยอร์หาย→layer_lost, ผลพร้อม→result_ready, กำลังทำ→running,
// ต้องแก้→needs_fix, รอรัน→awaiting_rerun, รอผล→awaiting_result).
export type AiReviewResultStateCode =
	| "not_placed"
	| "placed"
	| "layer_lost"
	| "result_ready"
	| "running"
	| "needs_fix"
	| "awaiting_rerun"
	| "awaiting_result";

export function aiReviewResultStateLabel(project: ProjectState | null | undefined, marker: AiReviewMarker): AiReviewResultStateCode {
	if (isAiResultPlacementNeeded(project, marker)) return "not_placed";
	if (isAiResultLayerAvailable(project, marker)) return "placed";
	if (marker.status === "applied" && marker.resultImageId) return hasAiResultLayer(project, marker) ? "placed" : "layer_lost";
	if (marker.resultImageId) return "result_ready";
	if (marker.status === "processing") return "running";
	if (marker.status === "failed") return "needs_fix";
	if (marker.status === "retry_requested") return "awaiting_rerun";
	return "awaiting_result";
}

// Rail action code (รอวาง→awaiting_placement, เปิดเลเยอร์ AI→open_layer,
// กู้เลเยอร์ AI→recover_layer, ดูบนภาพ→view_on_canvas, ดูคิว→view_queue,
// แก้→fix, รอรัน→awaiting_rerun, ตรวจ→review). Branch precedence unchanged.
export type AiReviewRailActionCode =
	| "awaiting_placement"
	| "open_layer"
	| "recover_layer"
	| "view_on_canvas"
	| "view_queue"
	| "fix"
	| "awaiting_rerun"
	| "review";

export function aiReviewRailActionLabel(project: ProjectState | null | undefined, marker: AiReviewMarker): AiReviewRailActionCode {
	if (isAiResultPlacementNeeded(project, marker)) return "awaiting_placement";
	if (isAiResultLayerAvailable(project, marker)) return "open_layer";
	if (marker.status === "applied" && marker.resultImageId) return hasAiResultLayer(project, marker) ? "open_layer" : "recover_layer";
	if (marker.resultImageId) return "view_on_canvas";
	if (marker.status === "processing") return "view_queue";
	if (marker.status === "failed") return "fix";
	if (marker.status === "retry_requested") return "awaiting_rerun";
	return "review";
}

// Row intent code (รอวาง→awaiting_placement, เปิดเลเยอร์ AI→open_layer,
// กู้เลเยอร์ AI→recover_layer, รันพลาด→failed, กำลังทำ→running, รอรัน→awaiting_rerun,
// รีวิวผล→review_result, รอรีวิว→needs_review). Branch precedence unchanged.
export type AiReviewRowIntentCode =
	| "awaiting_placement"
	| "open_layer"
	| "recover_layer"
	| "failed"
	| "running"
	| "awaiting_rerun"
	| "review_result"
	| "needs_review";

export function aiReviewRowIntentLabel(project: ProjectState | null | undefined, marker: AiReviewMarker): AiReviewRowIntentCode {
	if (isAiResultPlacementNeeded(project, marker)) return "awaiting_placement";
	if (isAiResultLayerAvailable(project, marker)) return "open_layer";
	if (marker.status === "applied" && marker.resultImageId) return hasAiResultLayer(project, marker) ? "open_layer" : "recover_layer";
	if (marker.status === "failed") return "failed";
	if (marker.status === "processing") return "running";
	if (marker.status === "retry_requested") return "awaiting_rerun";
	if (marker.resultImageId) return "review_result";
	return "needs_review";
}

// Row status code (รอวาง→awaiting_placement, วางแล้ว→placed, ผ่านแล้ว→passed,
// รอรีวิว→needs_review, รอรัน→awaiting_rerun, กำลังทำ→running, วางแล้ว→placed,
// พลาด→failed, ไม่ใช้→rejected). Branch precedence unchanged.
export type AiReviewRowStatusCode =
	| "awaiting_placement"
	| "placed"
	| "passed"
	| "needs_review"
	| "awaiting_rerun"
	| "running"
	| "failed"
	| "rejected";

export function aiReviewRowStatusLabel(project: ProjectState | null | undefined, marker: AiReviewMarker): AiReviewRowStatusCode {
	if (isAiResultPlacementNeeded(project, marker)) return "awaiting_placement";
	if (isAiResultLayerAvailable(project, marker)) return "placed";
	if (marker.status === "accepted") return "passed";
	if (marker.status === "needs_review") return "needs_review";
	if (marker.status === "retry_requested") return "awaiting_rerun";
	if (marker.status === "processing") return "running";
	if (marker.status === "applied") return "placed";
	if (marker.status === "failed") return "failed";
	return "rejected";
}

// On-canvas region label code. The selected state forwards to the status code
// (มีสถานะ status). Codes: รอวางเลเยอร์→placement_selected, รอวาง→placement,
// รันพลาด→failed, รันใหม่→retry, รีวิว→review, รอดู→pending_review, AI→ai. The
// `selected` status passthrough returns an AiReviewStatusCode instead.
export type AiReviewRegionDisplayCode =
	| "placement_selected"
	| "placement"
	| "failed"
	| "retry"
	| "review"
	| "pending_review"
	| "ai";

export function aiReviewRegionDisplayLabel(
	project: ProjectState | null | undefined,
	marker: AiReviewMarker,
	selected: boolean,
): { kind: "region"; code: AiReviewRegionDisplayCode } | { kind: "status"; code: AiReviewStatusCode } {
	if (isAiResultPlacementNeeded(project, marker)) {
		return { kind: "region", code: selected ? "placement_selected" : "placement" };
	}
	if (selected) return { kind: "status", code: aiReviewStatusLabel(marker) };
	if (marker.status === "failed") return { kind: "region", code: "failed" };
	if (marker.status === "retry_requested") return { kind: "region", code: "retry" };
	if (marker.status === "needs_review") return { kind: "region", code: marker.resultImageId ? "review" : "pending_review" };
	return { kind: "region", code: "ai" };
}
