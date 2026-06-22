import { describe, expect, it } from "vitest";
import {
	createExportRun,
	formatExportFailureDetail,
	formatExportRunMessage,
	formatExportRunPages,
	getExportRunPageScope,
	normalizeExportRuns,
} from "$lib/project/export-runs.js";
import type { ExportRun } from "$lib/types.js";

function exportRun(overrides: Partial<ExportRun> = {}): ExportRun {
	return {
		id: "export-1",
		kind: "batch-zip",
		status: "error",
		filename: "chapter.zip",
		pageIndexes: [0, 4],
		pageCount: 2,
		message: "Export failed",
		createdAt: "2026-05-15T10:00:00.000Z",
		completedAt: "2026-05-15T10:00:00.000Z",
		...overrides,
	};
}

describe("export run page scope", () => {
	it("creates a batch run with persisted artifact metadata", () => {
		const run = createExportRun({
			kind: "batch-zip",
			status: "done",
				filename: "chapter.zip",
				pageIndexes: [0, 1],
				bytes: 512,
				targetProfile: "public-export",
				message: "Exported chapter.zip",
			artifact: {
				exportId: "export-1.zip",
				storageDriver: "local",
				storageKey: "projects/project-1/exports/export-1.zip",
				filename: "chapter.zip",
				mimeType: "application/zip",
				sizeBytes: 512,
				createdAt: "2026-05-17T00:00:00.000Z",
			},
			now: "2026-05-17T00:00:00.000Z",
		});

			expect(run.artifact).toMatchObject({
				exportId: "export-1.zip",
				filename: "chapter.zip",
				sizeBytes: 512,
			});
			expect(run.targetProfile).toBe("public-export");
		});

	it("normalizes old and new export runs without dropping artifact metadata", () => {
		const normalized = normalizeExportRuns([
			exportRun({
				status: "done",
				artifact: {
					exportId: "export-1.zip",
					storageDriver: "local",
					storageKey: "projects/project-1/exports/export-1.zip",
					filename: "chapter.zip",
					mimeType: "application/zip",
					sizeBytes: 1024,
					createdAt: "2026-05-17T00:00:00.000Z",
				},
			}),
		]);

		expect(normalized[0].artifact?.storageKey).toBe("projects/project-1/exports/export-1.zip");
	});

		it("keeps artifact persistence errors on normalized export runs", () => {
			const normalized = normalizeExportRuns([
				exportRun({
					status: "done",
					error: undefined,
					targetProfile: "draft-internal",
					artifactError: "Stored ZIP was not saved: Workspace storage is full.",
				}),
			]);

			expect(normalized[0].artifactError).toBe("Stored ZIP was not saved: Workspace storage is full.");
			expect(normalized[0].targetProfile).toBe("draft-internal");
		});

		it("drops invalid legacy export target profiles", () => {
			const normalized = normalizeExportRuns([
				exportRun({
					targetProfile: "public-but-bad" as any,
				}),
			]);

			expect(normalized[0].targetProfile).toBeUndefined();
		});

	it("formats legacy export copy for visible history rows", () => {
		const legacyDone = exportRun({
			status: "done",
			error: undefined,
			pageIndexes: [0, 1, 2],
			pageCount: 3,
			message: "Exported 3 pages to chapter.zip",
		});
		const legacyError = exportRun({
			message: "Export failed: Workspace plan quota reached",
			error: undefined,
		});

		expect(formatExportRunPages(legacyDone)).toBe("หน้า 1-3");
		expect(formatExportRunMessage(legacyDone)).toBe("สร้าง ZIP สำเร็จ 3 หน้า");
		expect(formatExportRunMessage(legacyError)).toBe("Export ไม่สำเร็จ: Quota แผน workspace เต็ม");
	});

	it("hides raw image URLs in export failure copy", () => {
		const failure = "fabric: Error loading http://127.0.0.1:5187/api/images/project-1/page-01.png";

		expect(formatExportFailureDetail(failure)).toBe("โหลดรูปสำหรับ Export ไม่สำเร็จ; กู้รูปหรือรีเฟรชหน้าแล้วลองใหม่");
		expect(formatExportFailureDetail(failure, undefined, 4)).toBe("หน้า 4: โหลดรูปสำหรับ Export ไม่สำเร็จ; กู้รูปหรือรีเฟรชหน้าแล้วลองใหม่");
		expect(formatExportRunMessage(exportRun({ error: failure }))).toBe(
			"Export ไม่สำเร็จ: โหลดรูปสำหรับ Export ไม่สำเร็จ; กู้รูปหรือรีเฟรชหน้าแล้วลองใหม่",
		);
		expect(formatExportRunMessage(exportRun({ error: failure, failedPageIndex: 3, failedPageNumber: 4 }))).toBe(
			"Export ไม่สำเร็จ: หน้า 4: โหลดรูปสำหรับ Export ไม่สำเร็จ; กู้รูปหรือรีเฟรชหน้าแล้วลองใหม่",
		);
		expect(formatExportFailureDetail(failure)).not.toContain("Refresh");
	});

	it("keeps structured failed page identity on export history runs", () => {
		const run = createExportRun({
			kind: "batch-zip",
			status: "error",
			filename: "chapter.zip",
			pageIndexes: [0, 1, 2],
			message: "Export ไม่สำเร็จ",
			error: "renderer failed",
			failedPageIndex: 1,
		});

		expect(run.failedPageIndex).toBe(1);
		expect(run.failedPageNumber).toBe(2);

		const normalized = normalizeExportRuns([{
			...run,
			failedPageIndex: -1,
			failedPageNumber: 0,
		}]);
		expect(normalized[0].failedPageIndex).toBeUndefined();
		expect(normalized[0].failedPageNumber).toBeUndefined();
	});

	it("splits live pages from pages that no longer exist", () => {
		expect(getExportRunPageScope(exportRun({ pageIndexes: [4, 0, 4, 1] }), 2)).toEqual({
			pageIndexes: [0, 1],
			missingPageIndexes: [4],
		});
	});

	it("treats all stored pages as missing when a chapter has no pages", () => {
		expect(getExportRunPageScope(exportRun({ pageIndexes: [0, 1] }), 0)).toEqual({
			pageIndexes: [],
			missingPageIndexes: [0, 1],
		});
	});
});
