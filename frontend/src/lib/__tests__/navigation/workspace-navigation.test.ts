import { goto } from "$app/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	navigateWorkspace,
	navigateWorkspaceHref,
} from "$lib/navigation/workspace-navigation.js";

const mockedGoto = vi.mocked(goto);

beforeEach(() => {
	mockedGoto.mockClear();
	window.history.replaceState({}, "", "/dashboard");
});

describe("workspace navigation", () => {
	it("uses SvelteKit navigation for real workspace routes", async () => {
		await navigateWorkspaceHref("/library");

		expect(mockedGoto).toHaveBeenCalledWith("/library", {
			noScroll: true,
			keepFocus: true,
		});
	});

	it("builds workspace hrefs before navigating", async () => {
		await navigateWorkspace({
			view: "editor",
			projectId: "project-1",
			pageIndex: 4,
		});

		expect(mockedGoto).toHaveBeenCalledWith("/projects/project-1/pages/5/editor", {
			noScroll: true,
			keepFocus: true,
		});
	});

	it("skips navigation when the target already matches the URL", async () => {
		await navigateWorkspaceHref("/dashboard");

		expect(mockedGoto).not.toHaveBeenCalled();
	});
});
