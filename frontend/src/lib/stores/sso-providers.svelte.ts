import { fetchSsoProviders, type SsoProvider, type SsoProviderInfo } from "$lib/api/client.ts";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * Loads the backend's list of configured SSO providers once and exposes the
 * enabled subset so login/signup/link UIs render only usable provider buttons
 * (e.g. LINE stays hidden until its channel id/secret are configured).
 *
 * Graceful by design: if the fetch fails we expose an empty list, so the UI
 * simply shows no SSO buttons and falls back to email/password login rather
 * than rendering dead buttons.
 */
class SsoProvidersStore {
	status = $state<LoadStatus>("idle");
	providers = $state<SsoProviderInfo[]>([]);

	// Only the providers the backend confirmed are configured. This is what the
	// UI should iterate over to render buttons.
	enabled = $derived(this.providers.filter((p) => p.enabled));

	#inflight: Promise<void> | null = null;

	isEnabled(provider: SsoProvider): boolean {
		return this.providers.some((p) => p.id === provider && p.enabled);
	}

	/**
	 * Fetch once and cache. Concurrent callers share the in-flight request.
	 * Pass `force` to re-fetch (e.g. after a config change in dev).
	 */
	async load(force = false): Promise<void> {
		if (!force && (this.status === "ready" || this.status === "loading")) {
			if (this.#inflight) await this.#inflight;
			return;
		}
		this.status = "loading";
		this.#inflight = (async () => {
			try {
				const providers = await fetchSsoProviders();
				this.providers = providers;
				this.status = "ready";
			} catch {
				// Degrade gracefully: no buttons, email login still works.
				this.providers = [];
				this.status = "error";
			} finally {
				this.#inflight = null;
			}
		})();
		await this.#inflight;
	}
}

export const ssoProvidersStore = new SsoProvidersStore();
