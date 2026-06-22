// AddLanguageTrackDialog (per-language PR-5): manage a project's Language Tracks
// through the gated track API. Verifies add calls POST, remove calls DELETE,
// success re-opens the project (store re-fetch), and honest inline error mapping
// for the scope-denied (403) and duplicate (409) failures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";

vi.mock("$lib/api/client.ts", () => {
	// Defined inside the (hoisted) factory: an ApiError stand-in carrying the typed
	// status/code the dialog narrows on. The dialog's `instanceof ApiError` check
	// uses this same class, so rejections must be constructed via `api.ApiError`.
	class ApiError extends Error {
		status: number;
		code?: string;
		constructor(message: string, status: number, code?: string) {
			super(message);
			this.name = "ApiError";
			this.status = status;
			this.code = code;
		}
	}
	return {
		ApiError,
		addProjectLanguage: vi.fn(),
		removeProjectLanguage: vi.fn(),
		saveProject: vi.fn(),
		loadProject: vi.fn(),
		getProjectVersions: vi.fn(),
		createNamedProjectVersion: vi.fn(),
		imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
	};
});

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

import * as api from "$lib/api/client.ts";
import AddLanguageTrackDialog from "$lib/components/AddLanguageTrackDialog.svelte";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

// The mocked ApiError class (constructed via the module so `instanceof` matches).
const ApiError = api.ApiError as unknown as new (message: string, status: number, code?: string) => Error;

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

let openProjectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	projectStore.__resetForTesting();
	// Stub the re-fetch so success paths do not hit the real load pipeline.
	openProjectSpy = vi.spyOn(projectStore, "openProject").mockResolvedValue(true);
});

afterEach(() => {
	openProjectSpy.mockRestore();
	projectStore.__resetForTesting();
});

describe("AddLanguageTrackDialog", () => {
	it("lists tracks, marks the primary, and offers remove only for non-primary tracks", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		expect(screen.getByText("ภาษาหลัก")).toBeTruthy();
		// Primary (TH) has no remove button; secondary (EN) does.
		expect(screen.getByRole("button", { name: "ลบภาษา EN" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ลบภาษา TH" })).toBeNull();
	});

	it("adding a language posts to the track API (lowercased) and re-opens the project", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		vi.mocked(api.addProjectLanguage).mockResolvedValue({
			projectId: BACKEND_PROJECT_ID,
			targetLang: "th",
			targetLangs: ["th", "en"],
		});

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		await fireEvent.input(screen.getByLabelText("รหัสภาษาใหม่"), { target: { value: " EN " } });
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มภาษา" }));

		await waitFor(() => {
			expect(api.addProjectLanguage).toHaveBeenCalledWith(BACKEND_PROJECT_ID, "en");
		});
		// Success re-fetches via the store's public openProject (no store fields added).
		expect(openProjectSpy).toHaveBeenCalledWith(BACKEND_PROJECT_ID);
	});

	it("blocks adding a locally-duplicate track and shows an honest hint", async () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		await fireEvent.input(screen.getByLabelText("รหัสภาษาใหม่"), { target: { value: "EN" } });

		expect(screen.getByText("ภาษานี้มีอยู่แล้วในงาน")).toBeTruthy();
		// Add button disabled — no API call attempted.
		expect((screen.getByRole("button", { name: "เพิ่มภาษา" }) as HTMLButtonElement).disabled).toBe(true);
		expect(api.addProjectLanguage).not.toHaveBeenCalled();
	});

	it("maps a 409 duplicate from the server to an inline message", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		vi.mocked(api.addProjectLanguage).mockRejectedValue(
			new ApiError("dup", 409, "language_track_exists"),
		);

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		await fireEvent.input(screen.getByLabelText("รหัสภาษาใหม่"), { target: { value: "ja" } });
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มภาษา" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("ภาษานี้มีแล้วในงาน เลือกภาษาอื่น");
		expect(openProjectSpy).not.toHaveBeenCalled();
	});

	it("maps a 403 scope-denied from the server to an inline message", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		vi.mocked(api.addProjectLanguage).mockRejectedValue(
			new ApiError("forbidden", 403, "workspace_language_track_scope_denied"),
		);

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		await fireEvent.input(screen.getByLabelText("รหัสภาษาใหม่"), { target: { value: "ja" } });
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มภาษา" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("สิทธิ์เวิร์กสเปซของคุณจัดการภาษานี้ไม่ได้");
	});

	it("removing a non-primary track calls DELETE and re-opens the project", async () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);
		vi.mocked(api.removeProjectLanguage).mockResolvedValue({
			projectId: BACKEND_PROJECT_ID,
			targetLang: "th",
			targetLangs: ["th"],
		});

		render(AddLanguageTrackDialog, { props: { open: true, onClose: vi.fn() } });

		await fireEvent.click(screen.getByRole("button", { name: "ลบภาษา EN" }));

		await waitFor(() => {
			expect(api.removeProjectLanguage).toHaveBeenCalledWith(BACKEND_PROJECT_ID, "en");
		});
		expect(openProjectSpy).toHaveBeenCalledWith(BACKEND_PROJECT_ID);
	});
});
