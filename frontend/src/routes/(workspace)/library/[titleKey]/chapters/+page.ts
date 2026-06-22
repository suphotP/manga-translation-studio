import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

/**
 * `/library/[titleKey]/chapters` has no index of its own — only the dynamic
 * `chapters/[projectId]` child renders. Direct-navigating the bare segment used
 * to 404, so forward it to the parent Story Detail page. Mirrors the root and
 * `/settings` / `/billing` redirect convention.
 */
export const load: PageLoad = async ({ params }) => {
	redirect(307, `/library/${encodeURIComponent(params.titleKey)}`);
};
