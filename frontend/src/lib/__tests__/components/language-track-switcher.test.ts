// LanguageTrackSwitcher (per-language PR-5): renders the project's Language Tracks
// and switches the active track via projectStore.setTargetLang. Single-language /
// legacy projects must render a minimal static badge (no chooser) so the editor
// path bar looks unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import LanguageTrackSwitcher from "$lib/components/LanguageTrackSwitcher.svelte";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
	saveProject: vi.fn(),
	loadProject: vi.fn(),
	getProjectVersions: vi.fn(),
	createNamedProjectVersion: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

const BACKEND_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: BACKEND_PROJECT_ID,
		name: "Lang Track Project",
		createdAt: "2026-06-03T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	projectStore.__resetForTesting();
});

afterEach(() => {
	projectStore.__resetForTesting();
});

describe("LanguageTrackSwitcher", () => {
	it("renders a minimal static badge (no chooser) for a single-language project", () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));

		render(LanguageTrackSwitcher);

		// Single track → static badge text, no switchable chips.
		expect(screen.getByText("TH")).toBeTruthy();
		expect(screen.queryByRole("group", { name: "ภาษาเป้าหมายที่กำลังแก้" })).toBeNull();
		expect(screen.queryByRole("button", { name: /สลับไปภาษา/i })).toBeNull();
	});

	it("renders one switch chip per track and highlights the active track", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "en" }),
		);

		render(LanguageTrackSwitcher);

		const thChip = screen.getByRole("button", { name: "สลับไปภาษา TH" });
		const enChip = screen.getByRole("button", { name: "สลับไปภาษา EN" });
		expect(thChip).toBeTruthy();
		expect(enChip).toBeTruthy();
		// EN is the active track.
		expect(enChip.getAttribute("aria-pressed")).toBe("true");
		expect(thChip.getAttribute("aria-pressed")).toBe("false");
	});

	it("switching a track calls projectStore.setTargetLang and updates the active selection", async () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);
		const spy = vi.spyOn(projectStore, "setTargetLang");

		render(LanguageTrackSwitcher);

		await fireEvent.click(screen.getByRole("button", { name: "สลับไปภาษา EN" }));

		expect(spy).toHaveBeenCalledWith("en");
		expect(projectStore.activeTargetLang).toBe("en");
		spy.mockRestore();
	});

	it("clicking the already-active track is a no-op (does not call setTargetLang)", async () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "en" }),
		);
		const spy = vi.spyOn(projectStore, "setTargetLang");

		render(LanguageTrackSwitcher);

		await fireEvent.click(screen.getByRole("button", { name: "สลับไปภาษา EN" }));
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("shows the manage affordance only when canManage is set and onManage is provided", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		const onManage = vi.fn();

		const { rerender } = render(LanguageTrackSwitcher, { props: { canManage: false } });
		expect(screen.queryByRole("button", { name: /ภาษาเป้าหมาย/i })).toBeNull();

		await rerender({ canManage: true, onManage });
		const manageBtn = screen.getByRole("button", { name: "เพิ่มภาษาเป้าหมาย" });
		await fireEvent.click(manageBtn);
		expect(onManage).toHaveBeenCalledTimes(1);
	});
});
