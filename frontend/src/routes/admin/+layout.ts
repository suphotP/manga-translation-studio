// Admin section is a single-page client app on top of the auth store. We
// load it eagerly (SSR off) so the existing API client + token wiring runs
// untouched. Auth gating happens inside +layout.svelte so a non-admin still
// sees the redirect screen instead of a flash of unauthorized content.
export const ssr = false;
export const prerender = false;
