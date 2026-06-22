// SSO providers store — loads the configured-provider list once and exposes
// the enabled subset so the UI hides unconfigured providers (e.g. LINE).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { ssoProvidersStore } from "$lib/stores/sso-providers.svelte.ts";

vi.mock("$lib/api/client.ts", () => ({
	fetchSsoProviders: vi.fn(),
	ssoStartUrl: vi.fn((provider: string) => `/api/auth/sso/${provider}/start`),
}));

function resetStore(): void {
	// Reach the runed state fields directly; they are public on the singleton.
	ssoProvidersStore.providers = [];
	ssoProvidersStore.status = "idle";
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
});

afterEach(() => {
	resetStore();
});

describe("ssoProvidersStore", () => {
	it("loads providers and exposes only the enabled subset", async () => {
		vi.mocked(api.fetchSsoProviders).mockResolvedValue([
			{ id: "google", name: "Google", enabled: true },
			{ id: "github", name: "GitHub", enabled: true },
			{ id: "line", name: "LINE", enabled: false },
		]);

		await ssoProvidersStore.load();

		expect(ssoProvidersStore.status).toBe("ready");
		expect(ssoProvidersStore.enabled.map((p) => p.id)).toEqual(["google", "github"]);
		expect(ssoProvidersStore.isEnabled("google")).toBe(true);
		expect(ssoProvidersStore.isEnabled("line")).toBe(false);
	});

	it("fetches once and caches across concurrent callers", async () => {
		vi.mocked(api.fetchSsoProviders).mockResolvedValue([
			{ id: "google", name: "Google", enabled: true },
		]);

		await Promise.all([ssoProvidersStore.load(), ssoProvidersStore.load()]);
		await ssoProvidersStore.load();

		expect(api.fetchSsoProviders).toHaveBeenCalledTimes(1);
	});

	it("degrades gracefully when the fetch fails (no providers, status=error)", async () => {
		vi.mocked(api.fetchSsoProviders).mockRejectedValue(new Error("network"));

		await ssoProvidersStore.load();

		expect(ssoProvidersStore.status).toBe("error");
		expect(ssoProvidersStore.enabled).toEqual([]);
		expect(ssoProvidersStore.isEnabled("google")).toBe(false);
	});
});
