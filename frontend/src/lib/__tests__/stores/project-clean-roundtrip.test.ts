// importCleanedPages — the IDENTICAL-dimension guard: a cleaned file only
// replaces its page when its decoded pixel size equals the stored asset
// record's original size (text layers / bboxes / edit ROIs live in absolute
// source pixels). Mismatches, unknown originals, and unmatched files are
// skipped with reasons — never silently applied.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "$lib/stores/project.svelte.ts";
import * as roundtrip from "$lib/project/clean-roundtrip.js";
import type { ProjectState } from "$lib/types.js";

vi.mock("$lib/project/clean-roundtrip.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/project/clean-roundtrip.js")>();
	return {
		...actual,
		// jsdom has no createImageBitmap — dimensions come from a per-test map.
		readImageFileDimensions: vi.fn(),
	};
});

function file(name: string): File {
	return new File(["x"], name, { type: "image/png" });
}

function projectWithPages(): ProjectState {
	return {
		projectId: "33333333-3333-4333-8333-333333333333",
		name: "Clean Roundtrip",
		createdAt: "2026-06-01T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [
			{ imageId: "img-1.png", imageName: "img-1.png", originalName: "src-1.png", textLayers: [], pendingAiJobs: [], coverRect: null },
			{ imageId: "img-2.png", imageName: "img-2.png", originalName: "src-2.png", textLayers: [], pendingAiJobs: [], coverRect: null },
		],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	} as ProjectState;
}

beforeEach(() => {
	vi.clearAllMocks();
	projectStore.project = projectWithPages();
	projectStore.imageAssets = [
		{ imageId: "img-1.png", width: 800, height: 1200 } as any,
		{ imageId: "img-2.png", width: 800, height: 1200 } as any,
	];
});

afterEach(() => {
	projectStore.project = null;
	projectStore.imageAssets = [];
});

describe("importCleanedPages dimension guard", () => {
	it("replaces only files whose dimensions exactly match the stored original", async () => {
		vi.mocked(roundtrip.readImageFileDimensions).mockImplementation(async (input: File) =>
			input.name.startsWith("page-001") ? { width: 800, height: 1200 } : { width: 800, height: 1100 });
		const replace = vi.spyOn(projectStore, "replacePageImage").mockImplementation(async (pageIndex: number, picked: File) => {
			projectStore.project!.pages[pageIndex]!.originalName = picked.name;
			return true;
		});

		await projectStore.importCleanedPages([file("page-001__src-1.png"), file("page-002__src-2.png")]);

		// Page 1 matched dims → replaced; page 2 was 100px short → guarded out.
		expect(replace).toHaveBeenCalledTimes(1);
		expect(replace.mock.calls[0]![0]).toBe(0);
		expect(projectStore.statusMsg).toContain("1/2");
		expect(projectStore.statusMsg).toContain("ขนาดไม่ตรงต้นฉบับ");
	});

	it("refuses to replace when the original size is unknown (safe by default)", async () => {
		projectStore.imageAssets = [];
		vi.mocked(roundtrip.readImageFileDimensions).mockResolvedValue({ width: 800, height: 1200 });
		const replace = vi.spyOn(projectStore, "replacePageImage").mockResolvedValue(false);

		await projectStore.importCleanedPages([file("page-001__src-1.png")]);

		expect(replace).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toContain("ไม่ทราบขนาดต้นฉบับ");
	});

	it("counts a save-failure rollback as skipped, not replaced (honest flag)", async () => {
		vi.mocked(roundtrip.readImageFileDimensions).mockResolvedValue({ width: 800, height: 1200 });
		// replacePageImage mutated then rolled back internally → returns false.
		vi.spyOn(projectStore, "replacePageImage").mockResolvedValue(false);

		await projectStore.importCleanedPages([file("page-001__src-1.png")]);

		expect(projectStore.statusMsg).toContain("0/1");
		expect(projectStore.statusMsg).toContain("แทนที่ไม่สำเร็จ");
	});

	it("reports files without the page key instead of guessing", async () => {
		await projectStore.importCleanedPages([file("final-cleaned.png")]);
		expect(projectStore.statusMsg).toContain("จับคู่ไฟล์กับหน้าไม่ได้");
	});
});
