import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "$lib/api/client.js";
import {
	formatRecentProjectName,
	formatRecentProjectDisambiguator,
	formatRecentProjectStats,
	formatRecentProjectUpdatedAt,
	getRecentProjectPickerItems,
	getShortProjectId,
	preserveRecentProjectOrder,
} from "$lib/project/recent-projects.js";

function project(index: number, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: `project-${String(index).padStart(3, "0")}-abcdef`,
		name: `Updated Name`,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: `2026-05-12T00:${String(index).padStart(2, "0")}:00.000Z`,
		targetLang: "th",
		pageCount: 2,
		textLayerCount: index,
		...overrides,
	};
}

describe("recent project helpers", () => {
	it("keeps duplicate project names distinguishable with stats and short ids", () => {
		const summary = project(1, { projectId: "project-alpha-123456", textLayerCount: 1 });

		expect(getShortProjectId(summary.projectId)).toBe("proj3456");
		expect(formatRecentProjectStats(summary)).toBe("2 หน้า / 1 เลเยอร์ข้อความ / TH");
	});

	it("adds a short code only when recent rows would otherwise look identical", () => {
		const projects = [
			project(1, { projectId: "project-alpha-123456", name: "Same Chapter", textLayerCount: 2 }),
			project(2, { projectId: "project-beta-654321", name: "Same Chapter", textLayerCount: 2 }),
			project(3, { projectId: "project-gamma-555555", name: "Same Chapter", textLayerCount: 3 }),
		];

		expect(formatRecentProjectDisambiguator(projects[0], projects)).toBe("รหัส proj3456");
		expect(formatRecentProjectDisambiguator(projects[1], projects)).toBe("รหัส proj4321");
		expect(formatRecentProjectDisambiguator(projects[2], projects)).toBeNull();
		expect(getRecentProjectPickerItems(projects, "proj4321").projects.map((item) => item.projectId)).toEqual([
			"project-beta-654321",
		]);
	});

	it("marks zero-page chapters as setup work instead of editable page work", () => {
		const summary = project(1, { pageCount: 0, textLayerCount: 3 });

		expect(formatRecentProjectStats(summary)).toBe("ยังไม่มีหน้า / 3 เลเยอร์ข้อความ / TH");
	});

	it("replaces internal audit chapter names with an honest neutral label (no invented titles)", () => {
		const masked = [
			formatRecentProjectName(project(1, { name: "Flow169 UX Audit Chapter" })),
			formatRecentProjectName(project(2, { name: "P104 Sales Demo Chapter 104" })),
			formatRecentProjectName(project(3, { name: "Chapter" })),
		];

		for (const name of masked) {
			// Never leak the raw internal/audit name…
			expect(name).not.toMatch(/Flow\d+|UX Audit|Sales Demo|^Chapter$/i);
			// …and never fabricate an invented story title (the old masking behaviour).
			expect(name).not.toMatch(/Glass Harbor|Moonlit Courier|Rain Archive|Velvet Signal|Neon Orchard/i);
			// Honest neutral label instead.
			expect(name).toBe("โปรเจกต์ภายใน");
		}

		// Real user-given names are passed through untouched.
		expect(formatRecentProjectName(project(1, { name: "Moonlit Courier ตอน 104" }))).toBe("Moonlit Courier ตอน 104");
		// Two internal projects collapse to the same neutral label + stats, so the
		// short id disambiguator still keeps them distinguishable in the rail.
		const internalA = project(1, { projectId: "project-alpha-123456", name: "Chapter", textLayerCount: 2 });
		const internalB = project(2, { projectId: "project-beta-654321", name: "Chapter", textLayerCount: 2 });
		expect(formatRecentProjectName(internalA)).toBe(formatRecentProjectName(internalB));
		expect(formatRecentProjectDisambiguator(internalA, [internalA, internalB])).toBe("รหัส proj3456");
	});

	it("formats relative update timestamps for compact picker rows", () => {
		const now = Date.parse("2026-05-12T01:00:00.000Z");

		expect(formatRecentProjectUpdatedAt("2026-05-12T00:59:30.000Z", now)).toBe("อัปเดตเมื่อกี้");
		expect(formatRecentProjectUpdatedAt("2026-05-12T00:48:00.000Z", now)).toBe("อัปเดต 12 นาทีที่แล้ว");
		expect(formatRecentProjectUpdatedAt("2026-05-11T23:00:00.000Z", now)).toBe("อัปเดต 2 ชม.ที่แล้ว");
		expect(formatRecentProjectUpdatedAt("not-a-date", now)).toBe("ยังไม่รู้เวลาอัปเดต");
	});

	it("caps visible rows while preserving the selected project in the default list", () => {
		const projects = Array.from({ length: 40 }, (_, index) => project(index + 1));
		const result = getRecentProjectPickerItems(projects, "", projects[35].projectId, 10);

		expect(result.projects).toHaveLength(10);
		expect(result.projects[0].projectId).toBe(projects[35].projectId);
		expect(result.hiddenCount).toBe(30);
	});

	it("filters by visible name and language before applying the visible cap", () => {
		const projects = [
			project(1, { name: "Chapter Alpha", targetLang: "th" }),
			project(2, { name: "Chapter Beta", targetLang: "en" }),
			project(3, { name: "Credits", projectId: "special-project-xyz", targetLang: "ja" }),
		];

		expect(getRecentProjectPickerItems(projects, "beta").projects.map((item) => item.name)).toEqual(["Chapter Beta"]);
		expect(getRecentProjectPickerItems(projects, "ja").projects.map((item) => item.name)).toEqual(["Credits"]);
		expect(getRecentProjectPickerItems(projects, "special").projects).toEqual([]);
	});

	it("can refresh recent metadata without jumping existing rows", () => {
		const current = [
			project(1, { projectId: "a", name: "Current A", updatedAt: "2026-05-12T00:01:00.000Z" }),
			project(2, { projectId: "b", name: "Current B", updatedAt: "2026-05-12T00:02:00.000Z" }),
			project(3, { projectId: "c", name: "Current C", updatedAt: "2026-05-12T00:03:00.000Z" }),
		];
		const refreshed = [
			project(2, { projectId: "b", name: "Refreshed B", updatedAt: "2026-05-12T01:02:00.000Z" }),
			project(4, { projectId: "d", name: "New D", updatedAt: "2026-05-12T01:04:00.000Z" }),
			project(1, { projectId: "a", name: "Refreshed A", updatedAt: "2026-05-12T01:01:00.000Z" }),
		];

		const preserved = preserveRecentProjectOrder(current, refreshed);

		expect(preserved.map((item) => item.projectId)).toEqual(["a", "b", "d"]);
		expect(preserved.map((item) => item.name)).toEqual(["Refreshed A", "Refreshed B", "New D"]);
	});
});
