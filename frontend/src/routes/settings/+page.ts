import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

/**
 * `/settings` has no index of its own — only `/settings/billing` and
 * `/settings/usage` render. Forward the bare route to the first tab (Billing)
 * so direct links don't 404. Mirrors the root `/+page.ts` redirect.
 */
export const load: PageLoad = async () => {
	redirect(307, "/settings/billing");
};
