import type { WorkspaceView } from "$lib/stores/editor-ui.svelte.ts";

export type WorkspaceSurface = "dashboard" | "inbox" | "tasks" | "library" | "title" | "language" | "chapter" | "project" | "pages" | "work" | "import" | "editor" | "review" | "settings" | "reports";

export interface WorkspaceRouteTarget {
	surface: WorkspaceSurface;
	workspaceView: WorkspaceView;
	projectId?: string;
	titleKey?: string;
	language?: string;
	pageIndex?: number;
}

export interface WorkspaceHrefInput {
	view: WorkspaceView | "library" | "title" | "language" | "chapter" | "settings" | "reports" | "review" | "tasks" | "inbox";
	projectId?: string;
	titleKey?: string;
	language?: string;
	pageIndex?: number;
}

function cleanSegment(value: string): string {
	return encodeURIComponent(value.trim());
}

function decodeSegment(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function buildWorkspaceHref(input: WorkspaceHrefInput): string {
	if (input.view === "dashboard") return "/dashboard";
	if (input.view === "inbox") return "/inbox";
	if (input.view === "tasks") return "/tasks";
	if (input.view === "reports") return "/reports";
	if (input.view === "settings") return "/settings/members";
	if (input.view === "library") return "/library";
	if (input.view === "title") {
		return input.titleKey ? `/library/${cleanSegment(input.titleKey)}` : "/library";
	}
	if (input.view === "language") {
		if (input.titleKey && input.language) {
			return `/library/${cleanSegment(input.titleKey)}/languages/${cleanSegment(input.language)}`;
		}
		return input.titleKey ? `/library/${cleanSegment(input.titleKey)}` : "/library";
	}
	if (input.view === "chapter") {
		if (input.titleKey && input.projectId) {
			return `/library/${cleanSegment(input.titleKey)}/chapters/${cleanSegment(input.projectId)}`;
		}
		return input.projectId ? `/projects/${cleanSegment(input.projectId)}/editor` : "/library";
	}
	if (input.view === "pages") {
		return input.projectId ? `/projects/${cleanSegment(input.projectId)}/pages` : "/library";
	}
	if (input.view === "work") {
		return input.projectId ? `/projects/${cleanSegment(input.projectId)}/work` : "/dashboard";
	}
	if (input.view === "review") {
		return input.projectId ? `/projects/${cleanSegment(input.projectId)}/review` : "/dashboard";
	}
	if (input.view === "import") {
		return input.projectId ? `/projects/${cleanSegment(input.projectId)}/import` : "/library";
	}
	if (!input.projectId) return "/dashboard";
	if (input.pageIndex !== undefined && input.pageIndex >= 0) {
		return `/projects/${cleanSegment(input.projectId)}/pages/${input.pageIndex + 1}/editor`;
	}
	return `/projects/${cleanSegment(input.projectId)}/editor`;
}

export function parseWorkspacePath(pathname: string): WorkspaceRouteTarget {
	const parts = pathname.split("/").filter(Boolean);
	if (!parts.length || parts[0] === "dashboard") {
		return { surface: "dashboard", workspaceView: "dashboard" };
	}
	if (parts[0] === "tasks") {
		return { surface: "tasks", workspaceView: "tasks" };
	}
	if (parts[0] === "inbox") {
		return { surface: "inbox", workspaceView: "inbox" };
	}
	if (parts[0] === "settings") {
		return { surface: "settings", workspaceView: "settings" };
	}
	if (parts[0] === "reports") {
		return { surface: "reports", workspaceView: "reports" };
	}
	if (parts[0] === "library") {
		if (parts[1] && parts[2] === "languages" && parts[3]) {
			return {
				surface: "language",
				workspaceView: "library",
				titleKey: decodeSegment(parts[1]),
				language: decodeSegment(parts[3]),
			};
		}
		if (parts[1] && parts[2] === "chapters" && parts[3]) {
			return {
				surface: "chapter",
				workspaceView: "library",
				titleKey: decodeSegment(parts[1]),
				projectId: decodeSegment(parts[3]),
			};
		}
		if (parts[1]) {
			return {
				surface: "title",
				workspaceView: "library",
				titleKey: decodeSegment(parts[1]),
			};
		}
		return { surface: "library", workspaceView: "library" };
	}
	if (parts[0] === "projects" && parts[1]) {
		const projectId = decodeSegment(parts[1]);
		if (!parts[2]) {
			// Bare `/projects/[projectId]` is forwarded by its `+page.ts` load to the
			// project's canonical chapter location under `/library/...`, so this target
			// is normally transient. It must NEVER map to `workspaceView: "dashboard"`
			// though: if the shell ever parses the bare URL before the redirect lands,
			// the generic home dashboard would render whatever project the home
			// aggregate defaults to — i.e. the WRONG project (the original P1 bug). Map
			// it to the project-scoped Library surface instead, which opens the
			// requested project rather than the unrelated dashboard.
			return {
				surface: "project",
				workspaceView: "library",
				projectId,
			};
		}
		if (parts[2] === "pages" && !parts[3]) {
			return {
				surface: "pages",
				workspaceView: "pages",
				projectId,
			};
		}
		if (parts[2] === "work") {
			return {
				surface: "work",
				workspaceView: "work",
				projectId,
			};
		}
		if (parts[2] === "review") {
			return {
				surface: "review",
				workspaceView: "review",
				projectId,
			};
		}
		if (parts[2] === "import") {
			return {
				surface: "import",
				workspaceView: "import",
				projectId,
			};
		}
		if (parts[2] === "pages" && parts[3] && parts[4] === "editor") {
			const pageNumber = Number.parseInt(parts[3], 10);
			return {
				surface: "editor",
				workspaceView: "editor",
				projectId,
				pageIndex: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : undefined,
			};
		}
		if (parts[2] === "editor") {
			return {
				surface: "editor",
				workspaceView: "editor",
				projectId,
			};
		}
	}
	return { surface: "dashboard", workspaceView: "dashboard" };
}

export function hrefForWorkspaceView(view: WorkspaceView, projectId?: string, pageIndex?: number): string {
	if (view === "dashboard") return buildWorkspaceHref({ view });
	if (view === "inbox") return buildWorkspaceHref({ view });
	if (view === "tasks") return buildWorkspaceHref({ view });
	if (view === "pages") return buildWorkspaceHref({ view, projectId });
	if (view === "work") return buildWorkspaceHref({ view, projectId });
	if (view === "review") return buildWorkspaceHref({ view, projectId });
	if (view === "import") return buildWorkspaceHref({ view, projectId });
	if (view === "settings") return buildWorkspaceHref({ view });
	if (view === "reports") return buildWorkspaceHref({ view });
	return buildWorkspaceHref({ view, projectId, pageIndex });
}
