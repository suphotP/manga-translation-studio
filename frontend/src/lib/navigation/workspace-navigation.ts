import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { buildWorkspaceHref, type WorkspaceHrefInput } from "$lib/navigation/workspace-routes.js";

const WORKSPACE_NAVIGATION_OPTIONS = {
	noScroll: true,
	keepFocus: true,
} as const;

export async function navigateWorkspaceHref(href: string): Promise<void> {
	if (!browser) return;
	if (href === window.location.pathname) return;
	await goto(href, WORKSPACE_NAVIGATION_OPTIONS);
}

export function navigateWorkspace(input: WorkspaceHrefInput): Promise<void> {
	return navigateWorkspaceHref(buildWorkspaceHref(input));
}

export function queueWorkspaceNavigation(input: WorkspaceHrefInput): void {
	void navigateWorkspace(input);
}

export function queueWorkspaceHrefNavigation(href: string): void {
	void navigateWorkspaceHref(href);
}
