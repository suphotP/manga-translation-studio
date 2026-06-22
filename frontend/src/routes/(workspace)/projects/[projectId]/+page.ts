import { isRedirect, redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { loadProject } from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { buildStoryTitleKey } from "$lib/project/story-id.js";

export const ssr = false;
export const prerender = false;

/**
 * Bare `/projects/[projectId]` has no real view of its own — the canonical
 * project/chapter surface lives under `/library/<titleKey>/chapters/<projectId>`
 * (rendered by the Library view). The single-shell path parser used to map this
 * bare segment to `workspaceView: "dashboard"`, so a direct link / bookmark /
 * refresh on `/projects/<id>` rendered the GENERIC home dashboard (with whatever
 * project the home aggregate defaulted to), not the requested project — a P1
 * wrong-project bug.
 *
 * Forward the bare route to the project's real chapter location. We resolve the
 * project's stable `storyId` (and cosmetic title) so we can build the exact
 * `[titleKey]` segment the chapter route expects. This mirrors the bare-route
 * redirect convention (`/settings`, `/billing`, `/library/[titleKey]/chapters`,
 * `/library/[titleKey]/languages`): `ssr=false`, `prerender=false`,
 * `redirect(307, …)` from `load`.
 *
 * The deeper project routes (`/projects/[id]/pages`, `/work`, `/review`,
 * `/import`, `/editor`, `/pages/[n]/editor`) already map to their own correct
 * `workspaceView` in the parser and are unaffected — only the BARE segment is
 * forwarded here.
 */
export const load: PageLoad = async ({ params, fetch }) => {
	if (typeof window === "undefined") return {};

	const projectId = params.projectId;

	// The `(workspace)/+layout.ts` auth guard also runs `authStore.init`, but
	// SvelteKit runs layout and page loads in PARALLEL unless we await the parent.
	// `loadProject` reads the api client's access token, which `authStore.init`
	// installs synchronously from the stored session — so init it here too (the
	// call is idempotent/memoized) to guarantee the token is set before the fetch,
	// otherwise a hard navigation races the layout and the project GET 401s,
	// dropping us onto the `/library` fallback instead of the real chapter.
	await authStore.init(fetch);

	try {
		const project = await loadProject(projectId);
		const storyId = project.storyId?.trim();
		if (storyId) {
			const titleKey = buildStoryTitleKey(storyId, project.storyTitle);
			redirect(307, `/library/${encodeURIComponent(titleKey)}/chapters/${encodeURIComponent(projectId)}`);
		}
		// Legacy project with no stable story id: the chapter URL needs a titleKey we
		// cannot build, so open the project's editor (which DOES scope the requested
		// project) rather than the wrong-project dashboard.
		redirect(307, `/projects/${encodeURIComponent(projectId)}/editor`);
	} catch (error) {
		// Re-throw the SvelteKit redirect — it is thrown as control flow, not a real
		// error, so it must escape this catch.
		if (isRedirect(error)) throw error;
		// The project could not be resolved (not found / network / unauthorized for
		// this id). Land on the library (a real, project-agnostic surface) instead of
		// the home dashboard showing a DIFFERENT project's data.
		redirect(307, "/library");
	}
};
