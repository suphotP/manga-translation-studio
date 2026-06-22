// (auth) group runs CSR-only — same as the rest of the app — and never needs
// SSR data. We re-export the root-level flags so SvelteKit treats this layout
// as a client-side boundary.
export const ssr = false;
export const prerender = false;
