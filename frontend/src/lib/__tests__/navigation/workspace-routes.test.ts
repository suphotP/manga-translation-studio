import { describe, expect, it } from "vitest";
import {
	buildWorkspaceHref,
	hrefForWorkspaceView,
	parseWorkspacePath,
} from "$lib/navigation/workspace-routes.js";

describe("workspace route helpers", () => {
	it("builds stable dashboard, library, work, editor, and page URLs", () => {
		expect(buildWorkspaceHref({ view: "dashboard" })).toBe("/dashboard");
		expect(buildWorkspaceHref({ view: "inbox" })).toBe("/inbox");
		expect(buildWorkspaceHref({ view: "tasks" })).toBe("/tasks");
		expect(buildWorkspaceHref({ view: "library" })).toBe("/library");
		expect(buildWorkspaceHref({ view: "title", titleKey: "My Manga" })).toBe("/library/My%20Manga");
		expect(buildWorkspaceHref({
			view: "chapter",
			titleKey: "My Manga",
			projectId: "project-1",
		})).toBe("/library/My%20Manga/chapters/project-1");
		expect(buildWorkspaceHref({
			view: "language",
			titleKey: "My Manga",
			language: "th",
		})).toBe("/library/My%20Manga/languages/th");
		expect(buildWorkspaceHref({ view: "pages", projectId: "project-1" })).toBe("/projects/project-1/pages");
		expect(buildWorkspaceHref({ view: "work", projectId: "project-1" })).toBe("/projects/project-1/work");
		expect(buildWorkspaceHref({ view: "review", projectId: "project-1" })).toBe("/projects/project-1/review");
		expect(buildWorkspaceHref({ view: "import", projectId: "project-1" })).toBe("/projects/project-1/import");
		expect(buildWorkspaceHref({ view: "editor", projectId: "project-1" })).toBe("/projects/project-1/editor");
		expect(buildWorkspaceHref({ view: "editor", projectId: "project-1", pageIndex: 4 })).toBe("/projects/project-1/pages/5/editor");
	});

	it("parses route paths into workspace surface targets", () => {
		expect(parseWorkspacePath("/dashboard")).toEqual({
			surface: "dashboard",
			workspaceView: "dashboard",
		});
		expect(parseWorkspacePath("/tasks")).toEqual({
			surface: "tasks",
			workspaceView: "tasks",
		});
		expect(parseWorkspacePath("/inbox")).toEqual({
			surface: "inbox",
			workspaceView: "inbox",
		});
		expect(parseWorkspacePath("/library/My%20Manga/chapters/project-1")).toEqual({
			surface: "chapter",
			workspaceView: "library",
			titleKey: "My Manga",
			projectId: "project-1",
		});
		expect(parseWorkspacePath("/library/My%20Manga/languages/th")).toEqual({
			surface: "language",
			workspaceView: "library",
			titleKey: "My Manga",
			language: "th",
		});
		expect(parseWorkspacePath("/projects/project-1/pages/5/editor")).toEqual({
			surface: "editor",
			workspaceView: "editor",
			projectId: "project-1",
			pageIndex: 4,
		});
		// Bare `/projects/[projectId]` is redirected to its canonical chapter
		// location by the route load; the parser must NOT map it to the generic
		// home dashboard (the P1 wrong-project bug). It maps to the project-scoped
		// Library surface, which opens the requested project, not the dashboard
		// default. `surface` stays "project" so breadcrumbs/labels can tell it apart.
		expect(parseWorkspacePath("/projects/project-1")).toEqual({
			surface: "project",
			workspaceView: "library",
			projectId: "project-1",
		});
		// Regression guard: the bare project route must never resolve to the
		// dashboard view (which would show a DIFFERENT project's data).
		expect(parseWorkspacePath("/projects/project-1").workspaceView).not.toBe("dashboard");
		expect(parseWorkspacePath("/projects/project-1/pages")).toEqual({
			surface: "pages",
			workspaceView: "pages",
			projectId: "project-1",
		});
		expect(parseWorkspacePath("/projects/project-1/work")).toEqual({
			surface: "work",
			workspaceView: "work",
			projectId: "project-1",
		});
		expect(parseWorkspacePath("/projects/project-1/review")).toEqual({
			surface: "review",
			workspaceView: "review",
			projectId: "project-1",
		});
		expect(parseWorkspacePath("/projects/project-1/import")).toEqual({
			surface: "import",
			workspaceView: "import",
			projectId: "project-1",
		});
	});

	it("round-trips a hybrid <storyId>-<slug> library segment and keeps the full segment for lookup", () => {
		// The story key is now `<stableStoryId>-<slug>`; build encodes the segment
		// verbatim and parse keeps the FULL segment as titleKey so the resolver can
		// match by leading id token (new) or whole segment (legacy).
		expect(buildWorkspaceHref({ view: "title", titleKey: "ab12cd34ef-glass-harbor" }))
			.toBe("/library/ab12cd34ef-glass-harbor");
		expect(parseWorkspacePath("/library/ab12cd34ef-glass-harbor")).toEqual({
			surface: "title",
			workspaceView: "library",
			titleKey: "ab12cd34ef-glass-harbor",
		});
		expect(parseWorkspacePath("/library/ab12cd34ef-glass-harbor/chapters/project-1")).toEqual({
			surface: "chapter",
			workspaceView: "library",
			titleKey: "ab12cd34ef-glass-harbor",
			projectId: "project-1",
		});
		// Legacy slug-based bookmark still parses to its full segment unchanged.
		expect(parseWorkspacePath("/library/glass-harbor")).toEqual({
			surface: "title",
			workspaceView: "library",
			titleKey: "glass-harbor",
		});
	});

	it("routes the workspace reports surface to /reports (project-independent)", () => {
		expect(buildWorkspaceHref({ view: "inbox" })).toBe("/inbox");
		expect(parseWorkspacePath("/inbox")).toEqual({
			surface: "inbox",
			workspaceView: "inbox",
		});
		expect(hrefForWorkspaceView("inbox", "project-1", 4)).toBe("/inbox");
		expect(buildWorkspaceHref({ view: "tasks" })).toBe("/tasks");
		expect(parseWorkspacePath("/tasks")).toEqual({
			surface: "tasks",
			workspaceView: "tasks",
		});
		expect(hrefForWorkspaceView("tasks", "project-1", 4)).toBe("/tasks");
		expect(buildWorkspaceHref({ view: "reports" })).toBe("/reports");
		expect(parseWorkspacePath("/reports")).toEqual({
			surface: "reports",
			workspaceView: "reports",
		});
		expect(hrefForWorkspaceView("reports", "project-1", 4)).toBe("/reports");
	});

	it("keeps store view changes linkable without requiring project ids for dashboard", () => {
		expect(hrefForWorkspaceView("dashboard", "project-1", 4)).toBe("/dashboard");
		expect(hrefForWorkspaceView("inbox", "project-1", 4)).toBe("/inbox");
		expect(hrefForWorkspaceView("tasks", "project-1", 4)).toBe("/tasks");
		expect(hrefForWorkspaceView("library", "project-1", 4)).toBe("/library");
		expect(hrefForWorkspaceView("pages", "project-1", 4)).toBe("/projects/project-1/pages");
		expect(hrefForWorkspaceView("work", "project-1", 4)).toBe("/projects/project-1/work");
		expect(hrefForWorkspaceView("review", "project-1", 4)).toBe("/projects/project-1/review");
		expect(hrefForWorkspaceView("import", "project-1", 4)).toBe("/projects/project-1/import");
		expect(hrefForWorkspaceView("editor", "project-1", 4)).toBe("/projects/project-1/pages/5/editor");
		expect(hrefForWorkspaceView("editor")).toBe("/dashboard");
	});
});
