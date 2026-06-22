import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Capture original SSO env so this suite's deterministic overrides do not leak
// into sibling test files that read these vars live (e.g. sso-oauth.test.ts and
// auth.ts isProviderConfigured fall back to process.env).
const ORIGINAL_ENV: Record<string, string | undefined> = {
	GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
	GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
	GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID,
	GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET,
	LINE_LOGIN_CHANNEL_ID: process.env.LINE_LOGIN_CHANNEL_ID,
	LINE_LOGIN_CHANNEL_SECRET: process.env.LINE_LOGIN_CHANNEL_SECRET,
};

// Configure only Google + GitHub; leave LINE unset so it must be reported as
// disabled (the core regression: a dead LINE button must never show).
process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
process.env.GITHUB_OAUTH_CLIENT_ID = "github-client";
process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-secret";
delete process.env.LINE_LOGIN_CHANNEL_ID;
delete process.env.LINE_LOGIN_CHANNEL_SECRET;

function restoreEnv() {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

afterAll(restoreEnv);

describe("GET /sso/providers", () => {
	let auth: typeof import("../routes/auth.js").auth;

	beforeAll(async () => {
		({ auth } = await import("../routes/auth.js"));
	});

	test("is public (no auth) and lists enabled providers, hiding unconfigured LINE", async () => {
		const response = await auth.request("/sso/providers");
		expect(response.status).toBe(200);
		// Config-derived + identical for every caller → cacheable shareably.
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=120");

		const body = (await response.json()) as {
			providers: Array<{ id: string; name: string; enabled: boolean }>;
		};
		expect(Array.isArray(body.providers)).toBe(true);

		const byId = new Map(body.providers.map((p) => [p.id, p]));

		// Google + GitHub are fully configured -> enabled.
		expect(byId.get("google")).toEqual({ id: "google", name: "Google", enabled: true });
		expect(byId.get("github")).toEqual({ id: "github", name: "GitHub", enabled: true });

		// LINE has no channel id/secret -> reported but disabled so the UI hides it.
		expect(byId.get("line")?.enabled).toBe(false);

		// Enabled-only view (what the UI renders) excludes LINE entirely.
		const enabledIds = body.providers.filter((p) => p.enabled).map((p) => p.id).sort();
		expect(enabledIds).toEqual(["github", "google"]);
	});

	test("a provider with id but missing secret is not enabled", async () => {
		const previousId = process.env.LINE_LOGIN_CHANNEL_ID;
		const previousSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
		process.env.LINE_LOGIN_CHANNEL_ID = "line-channel";
		delete process.env.LINE_LOGIN_CHANNEL_SECRET;
		try {
			const response = await auth.request("/sso/providers");
			const body = (await response.json()) as {
				providers: Array<{ id: string; enabled: boolean }>;
			};
			const line = body.providers.find((p) => p.id === "line");
			expect(line?.enabled).toBe(false);
		} finally {
			if (previousId === undefined) delete process.env.LINE_LOGIN_CHANNEL_ID;
			else process.env.LINE_LOGIN_CHANNEL_ID = previousId;
			if (previousSecret === undefined) delete process.env.LINE_LOGIN_CHANNEL_SECRET;
			else process.env.LINE_LOGIN_CHANNEL_SECRET = previousSecret;
		}
	});
});
