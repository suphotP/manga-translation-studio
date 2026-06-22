import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

/**
 * The canonical billing surface lives under `/settings/billing` (Wave 2 W2.2).
 * `/billing` (only the `mock-checkout` / `mock-portal` children exist) used to
 * 404 for anyone hitting the bare route from an old link or external email, so
 * forward it to the real settings tab. Mirrors the root `/+page.ts` redirect.
 */
export const load: PageLoad = async () => {
	redirect(307, "/settings/billing");
};
