import type { AiReviewMarker, ProjectState } from "$lib/types.js";

export type AiMarkerReferenceProblem = "missing-page" | "stale-image";

export interface AiMarkerReferenceIssue {
	problem: AiMarkerReferenceProblem;
	message: string;
	pageIndex?: number;
	markerImageId: string;
	expectedImageIds: string[];
}

export function compactImageId(imageId: string): string {
	return imageId.length <= 18 ? imageId : `${imageId.slice(0, 18)}...`;
}

function currentPageImageIds(project: ProjectState, pageIndex: number): string[] {
	const page = project.pages[pageIndex];
	if (!page) return [];
	return [page.imageId, page.edits?.imageId].filter((imageId): imageId is string => Boolean(imageId));
}

export function getAiMarkerReferenceIssue(
	project: ProjectState | null | undefined,
	marker: AiReviewMarker,
): AiMarkerReferenceIssue | null {
	if (!project?.pages[marker.pageIndex]) {
		return {
			problem: "missing-page",
			message: `ผล AI นี้ชี้ไปหน้า ${marker.pageIndex + 1} ที่ไม่มีแล้ว; สร้างผลใหม่บนหน้าที่ถูกต้องก่อนยืนยันหรือวางเลเยอร์`,
			pageIndex: marker.pageIndex,
			markerImageId: marker.imageId,
			expectedImageIds: [],
		};
	}

	const expectedImageIds = currentPageImageIds(project, marker.pageIndex);
	if (!expectedImageIds.includes(marker.imageId)) {
		const currentImage = expectedImageIds[expectedImageIds.length - 1] ?? "unknown";
		return {
			problem: "stale-image",
			message: `ผล AI นี้ผูกกับรูปเก่า ${compactImageId(marker.imageId)} แต่หน้า ${marker.pageIndex + 1} ตอนนี้ใช้ ${compactImageId(currentImage)}; รันพื้นที่นี้ใหม่ก่อนยืนยันหรือวางเลเยอร์`,
			pageIndex: marker.pageIndex,
			markerImageId: marker.imageId,
			expectedImageIds,
		};
	}

	return null;
}
