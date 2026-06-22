import type { Page, ProjectState } from "$lib/types.js";

export interface PageImageRelinkMatch {
	pageIndex: number;
	file: File;
	expectedNames: string[];
	matchedBy: "name" | "order";
}

export interface PageImageRelinkPlan {
	matches: PageImageRelinkMatch[];
	unmatchedPageIndexes: number[];
	unusedFiles: File[];
}

export interface PageImageRelinkPlanOptions {
	matchUnmatchedByOrder?: boolean;
}

function normalizeAssetName(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const pathPart = trimmed.split(/[\\/]/).pop() ?? trimmed;
	const [withoutQuery] = pathPart.split(/[?#]/);
	const normalized = withoutQuery.trim().toLowerCase();
	return normalized || null;
}

export function collectPageImageRelinkRefs(page: Page): string[] {
	const names = new Set<string>();
	for (const candidate of [page.originalName, page.imageName, page.imageId, page.edits?.imageId]) {
		const trimmed = candidate?.trim();
		if (trimmed) names.add(trimmed);
	}
	return Array.from(names);
}

function pageExpectedNames(page: Page): string[] {
	const names = new Set<string>();
	for (const candidate of collectPageImageRelinkRefs(page)) {
		const normalized = normalizeAssetName(candidate);
		if (normalized) names.add(normalized);
	}
	return Array.from(names);
}

export function buildPageImageRelinkPlan(
	pages: Page[],
	files: File[],
	pageIndexes = pages.map((_, index) => index),
	options: PageImageRelinkPlanOptions = {},
): PageImageRelinkPlan {
	const fileByName = new Map<string, File>();
	for (const file of files) {
		const normalized = normalizeAssetName(file.name);
		if (normalized && !fileByName.has(normalized)) {
			fileByName.set(normalized, file);
		}
	}

	const usedFiles = new Set<File>();
	const matches: PageImageRelinkMatch[] = [];
	const unmatchedPageIndexes: number[] = [];

	for (const pageIndex of pageIndexes) {
		const page = pages[pageIndex];
		if (!page) continue;
		const expectedNames = pageExpectedNames(page);
		const file = expectedNames.map((name) => fileByName.get(name)).find((item): item is File => Boolean(item));
		if (!file) {
			unmatchedPageIndexes.push(pageIndex);
			continue;
		}
		usedFiles.add(file);
		matches.push({ pageIndex, file, expectedNames, matchedBy: "name" });
	}

	if (options.matchUnmatchedByOrder && unmatchedPageIndexes.length > 0) {
		const fallbackFiles = files.filter((file) => !usedFiles.has(file));
		const fallbackCount = Math.min(unmatchedPageIndexes.length, fallbackFiles.length);
		for (let index = 0; index < fallbackCount; index += 1) {
			const pageIndex = unmatchedPageIndexes[index];
			const page = pages[pageIndex];
			if (!page) continue;
			const file = fallbackFiles[index];
			usedFiles.add(file);
			matches.push({
				pageIndex,
				file,
				expectedNames: pageExpectedNames(page),
				matchedBy: "order",
			});
		}
		unmatchedPageIndexes.splice(0, fallbackCount);
	}

	return {
		matches,
		unmatchedPageIndexes,
		unusedFiles: files.filter((file) => !usedFiles.has(file)),
	};
}

export function remapPageImageReferences(
	project: ProjectState,
	pageIndex: number,
	previousImageRefs: string[],
	nextImageId: string,
): { taskCount: number; markerCount: number } {
	const previousRefs = new Set(previousImageRefs.map((value) => value.trim()).filter(Boolean));
	let taskCount = 0;
	let markerCount = 0;

	for (const task of project.tasks ?? []) {
		if (task.pageIndex !== pageIndex || !task.pageImageId || !previousRefs.has(task.pageImageId)) continue;
		task.pageImageId = nextImageId;
		taskCount += 1;
	}

	for (const marker of project.aiReviewMarkers ?? []) {
		if (marker.pageIndex !== pageIndex || !previousRefs.has(marker.imageId)) continue;
		marker.imageId = nextImageId;
		markerCount += 1;
	}

	return { taskCount, markerCount };
}
