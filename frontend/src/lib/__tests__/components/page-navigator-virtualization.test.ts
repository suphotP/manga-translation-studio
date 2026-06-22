import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import PageNavigator from "$lib/components/PageNavigator.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

function page(index: number): Page {
	return {
		imageId: `image-${index}.webp`,
		imageName: `page-${index}.webp`,
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
	};
}

function bigProject(pageCount: number, overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Big chapter",
		createdAt: now,
		pages: Array.from({ length: pageCount }, (_, i) => page(i + 1)),
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function openPageButtons(): HTMLElement[] {
	// Each rendered page row exposes an "เปิดหน้า N" open button (or busy receipt).
	return screen.queryAllByRole("button", { name: /^เปิดหน้า / });
}

function renderedPageNumbers(): number[] {
	return openPageButtons()
		.map((el) => {
			const match = el.getAttribute("aria-label")?.match(/เปิดหน้า\s+(\d+)/);
			return match ? Number(match[1]) : NaN;
		})
		.filter((n) => Number.isFinite(n));
}

beforeEach(() => {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("PageNavigator virtualization (W3.5)", () => {
	it("renders only a windowed subset of rows for a 120-page chapter", async () => {
		projectStore.__setProjectForTesting(bigProject(120));
		render(PageNavigator);

		await waitFor(() => {
			expect(openPageButtons().length).toBeGreaterThan(0);
		});

		const rendered = openPageButtons().length;
		// Window is a small fraction of the chapter, not all 120 rows.
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(40);
		expect(rendered).toBeLessThan(120);
	});

	it("marks the list virtualized and keeps the scrollbar geometry via spacers", async () => {
		projectStore.__setProjectForTesting(bigProject(150));
		const { container } = render(PageNavigator);

		await waitFor(() => {
			expect(container.querySelector('.page-mini-list[data-virtualized="true"]')).toBeTruthy();
		});

		// At scrollTop 0 there is no top spacer, but a bottom spacer stands in for the
		// off-window rows below.
		const spacers = container.querySelectorAll(".page-mini-spacer");
		expect(spacers.length).toBeGreaterThan(0);
		const totalSpacerHeight = Array.from(spacers).reduce(
			(sum, el) => sum + Number.parseFloat((el as HTMLElement).style.height || "0"),
			0,
		);
		expect(totalSpacerHeight).toBeGreaterThan(0);
	});

	it("renders every row without virtualization for a short chapter", async () => {
		projectStore.__setProjectForTesting(bigProject(8));
		const { container } = render(PageNavigator);

		await waitFor(() => {
			expect(openPageButtons().length).toBe(8);
		});
		expect(container.querySelector('.page-mini-list[data-virtualized="false"]')).toBeTruthy();
		expect(container.querySelectorAll(".page-mini-spacer").length).toBe(0);
	});

	it("preserves RTL reading order within the rendered window", async () => {
		// Start on a mid-chapter page so the auto-scroll-to-active window sits away from
		// both edges, exercising the reversed display order in the middle of the strip.
		projectStore.__setProjectForTesting(bigProject(120, { currentPage: 60, readingDirection: "rtl" }));
		render(PageNavigator);

		await waitFor(() => {
			expect(openPageButtons().length).toBeGreaterThan(1);
		});

		const numbers = renderedPageNumbers();
		// RTL reverses the display order, so the rendered window must be strictly
		// descending (page N+1 appears above page N).
		const descending = [...numbers].sort((a, b) => b - a);
		expect(numbers).toEqual(descending);
		// The active page (61) is inside the rendered window after auto-scroll.
		expect(numbers).toContain(61);
	});

	it("preserves LTR ascending order within the rendered window", async () => {
		projectStore.__setProjectForTesting(bigProject(120, { currentPage: 60, readingDirection: "ltr" }));
		render(PageNavigator);

		await waitFor(() => {
			expect(openPageButtons().length).toBeGreaterThan(1);
		});

		const numbers = renderedPageNumbers();
		const ascending = [...numbers].sort((a, b) => a - b);
		expect(numbers).toEqual(ascending);
		expect(numbers).toContain(61);
	});

	it("renders the full continuous stack (no windowing) for vertical webtoon mode", async () => {
		projectStore.__setProjectForTesting(bigProject(120, { readingDirection: "vertical" } as Partial<ProjectState>));
		const { container } = render(PageNavigator);

		await waitFor(() => {
			expect(openPageButtons().length).toBeGreaterThan(0);
		});
		// Vertical mode is a continuous scroll stack, so virtualization stays off and all
		// rows render in ascending order.
		expect(container.querySelector('.page-mini-list[data-virtualized="false"]')).toBeTruthy();
		expect(openPageButtons().length).toBe(120);
		const numbers = renderedPageNumbers();
		expect(numbers[0]).toBe(1);
		expect(numbers[numbers.length - 1]).toBe(120);
	});
});
