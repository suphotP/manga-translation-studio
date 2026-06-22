import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

/**
 * `/account` has no index of its own — only `/account/restore` (the email-link
 * soft-delete restore page) renders under it. A bare `/account` visit (a natural
 * guess for "my account", and where the account-menu copy lives) otherwise 404s.
 * Forward it to the real account/profile surface so direct links don't dead-end.
 * Mirrors the `/settings/+page.ts` redirect pattern.
 */
export const load: PageLoad = async () => {
	redirect(307, "/settings/profile");
};
