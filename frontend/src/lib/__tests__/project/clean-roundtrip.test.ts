// External-clean roundtrip: the exported manifest is the page contract, filename
// prefixes are fallback compatibility, and anything unmatchable is reported —
// never silently dropped.

import { describe, expect, it } from "vitest";
import {
	cleanExportFilename,
	parseCleanedPageNumber,
	planCleanedImport,
} from "$lib/project/clean-roundtrip.js";

function file(name: string): File {
	return new File(["x"], name, { type: "image/png" });
}

describe("cleanExportFilename", () => {
	it("prefixes the padded page number and keeps the original name", () => {
		expect(cleanExportFilename(7, "scan_07.png", "fallback.png")).toBe("page-007__scan_07.png");
	});

	it("falls back to the image id and sanitizes path-hostile characters", () => {
		expect(cleanExportFilename(12, undefined, "abc.png")).toBe("page-012__abc.png");
		expect(cleanExportFilename(1, 'we/ird:na*me?.png', "x")).toBe("page-001__we_ird_na_me_.png");
	});
});

describe("parseCleanedPageNumber", () => {
	it("reads the page key back from exported names", () => {
		expect(parseCleanedPageNumber("page-007__scan_07.png")).toBe(7);
		expect(parseCleanedPageNumber("page-012__abc-cleaned-final.psd.png")).toBe(12);
	});

	it("tolerates a renamed tail and plain page-NNN names", () => {
		expect(parseCleanedPageNumber("page-003.png")).toBe(3);
		expect(parseCleanedPageNumber("PAGE-004__x.png")).toBe(4);
		// Only the prefix is the contract — common rename shapes still resolve.
		expect(parseCleanedPageNumber("page-001-cleaned.png")).toBe(1);
		expect(parseCleanedPageNumber("page-001 cleaned.png")).toBe(1);
	});

	it("reads server originals-export names as fallback keys", () => {
		expect(parseCleanedPageNumber("001-cover.png")).toBe(1);
		expect(parseCleanedPageNumber("pages/012-spread.png")).toBe(12);
		expect(parseCleanedPageNumber("cover-001.png")).toBeNull();
	});

	it("rejects names without the key", () => {
		expect(parseCleanedPageNumber("cleaned-final.png")).toBeNull();
		expect(parseCleanedPageNumber("page-.png")).toBeNull();
		expect(parseCleanedPageNumber("mypage-001.png")).toBeNull();
		expect(parseCleanedPageNumber("page-000.png")).toBeNull();
	});
});

describe("planCleanedImport", () => {
	it("matches by page key in ascending page order and buckets the rest", () => {
		const plan = planCleanedImport(
			[file("page-003__c.png"), file("page-001__a.png"), file("random.png"), file("page-009__z.png")],
			5,
		);
		expect(plan.matches.map((m) => m.pageNumber)).toEqual([1, 3]);
		expect(plan.matches.map((m) => m.pageIndex)).toEqual([0, 2]);
		expect(plan.unmatched.map((f) => f.name)).toEqual(["random.png"]);
		expect(plan.outOfRange.map((o) => o.pageNumber)).toEqual([9]);
	});

	it("uses manifest filenames as the source of truth before filename prefixes", () => {
		const plan = planCleanedImport(
			[file("001-cover.png"), file("999-opening.png")],
			5,
			{
				pages: [
					{ pageIndex: 2, filename: "pages/001-cover.png" },
					{ pageIndex: 0, filename: "pages/999-opening.png" },
				],
			},
		);
		expect(plan.matches.map((m) => [m.pageIndex, m.pageNumber, m.file.name])).toEqual([
			[0, 1, "999-opening.png"],
			[2, 3, "001-cover.png"],
		]);
		expect(plan.unmatched).toEqual([]);
		expect(plan.outOfRange).toEqual([]);
	});

	it("falls back to server export filename prefixes when no manifest entry matches", () => {
		const plan = planCleanedImport(
			[file("001-cover-cleaned.png"), file("pages/003-tail.png")],
			3,
			{ pages: [{ pageIndex: 1, filename: "pages/002-spread.png" }] },
		);
		expect(plan.matches.map((m) => [m.pageIndex, m.pageNumber, m.file.name])).toEqual([
			[0, 1, "001-cover-cleaned.png"],
			[2, 3, "pages/003-tail.png"],
		]);
	});
});
