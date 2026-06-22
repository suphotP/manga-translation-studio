import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { readTurnstileRuntimeConfig, assertTurnstileConfigured, serverConfig } from "../config.js";
import { MemoryTurnstileTokenCache, turnstileVerify, type TurnstileFetch, type TurnstileTokenCache } from "../middleware/turnstile-verify.js";

function jsonRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): RequestInit {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	};
}

function buildProtectedApp(input: {
	enabled?: boolean;
	secretKey?: string;
	fetchFn?: TurnstileFetch;
	cache?: TurnstileTokenCache;
	expectedAction?: string;
	allowedHostnames?: string[];
	verifyTimeoutMs?: number;
}) {
	let nextCalled = false;
	const app = new Hono();
	app.post("/protected", turnstileVerify({
		enabled: input.enabled ?? true,
		secretKey: input.secretKey ?? "secret-test-key",
		verifyUrl: "https://turnstile.test/siteverify",
		fetchFn: input.fetchFn ?? (async () => Response.json({ success: true })),
		cache: input.cache ?? new MemoryTurnstileTokenCache(),
		expectedAction: input.expectedAction,
		allowedHostnames: input.allowedHostnames,
		verifyTimeoutMs: input.verifyTimeoutMs,
	}), async (c) => {
		nextCalled = true;
		const body = await c.req.json();
		return c.json({ ok: true, body });
	});
	return { app, nextCalled: () => nextCalled };
}

function buildTokenOnlyProtectedApp(input: {
	fetchFn?: TurnstileFetch;
	cache?: TurnstileTokenCache;
}) {
	let nextCalled = false;
	const app = new Hono();
	app.post("/protected", turnstileVerify({
		enabled: true,
		secretKey: "secret-test-key",
		verifyUrl: "https://turnstile.test/siteverify",
		fetchFn: input.fetchFn ?? (async () => Response.json({ success: true })),
		cache: input.cache ?? new MemoryTurnstileTokenCache(),
	}), async (c) => {
		nextCalled = true;
		return c.json({ ok: true });
	});
	return { app, nextCalled: () => nextCalled };
}

describe("Turnstile middleware", () => {
	test("missing cf-turnstile-response in JSON body returns 403", async () => {
		const { app, nextCalled } = buildProtectedApp({});

		const response = await app.request("/protected", jsonRequest({ email: "user@example.com" }));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["missing-input-response"],
		});
		expect(nextCalled()).toBe(false);
	});

	test("invalid Turnstile token returns 403 with Cloudflare error codes", async () => {
		const fetchCalls: URLSearchParams[] = [];
		const fetchFn: TurnstileFetch = async (_url, init) => {
			fetchCalls.push(init!.body as URLSearchParams);
			return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
		};
		const { app, nextCalled } = buildProtectedApp({ fetchFn });

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "invalid-token",
		}, {
			"cf-connecting-ip": "203.0.113.10",
		}));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["invalid-input-response"],
		});
		expect(nextCalled()).toBe(false);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]!.get("secret")).toBe("secret-test-key");
		expect(fetchCalls[0]!.get("response")).toBe("invalid-token");
		expect(fetchCalls[0]!.get("remoteip")).toBe("203.0.113.10");
	});

	test("valid Turnstile token calls next and leaves JSON body readable", async () => {
		const fetchFn: TurnstileFetch = async () => Response.json({ success: true });
		const { app, nextCalled } = buildProtectedApp({ fetchFn });

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "valid-token",
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			body: {
				email: "user@example.com",
				"cf-turnstile-response": "valid-token",
			},
		});
		expect(nextCalled()).toBe(true);
	});

	test("valid Turnstile token can come from a header without consuming the JSON body", async () => {
		const fetchCalls: URLSearchParams[] = [];
		const fetchFn: TurnstileFetch = async (_url, init) => {
			fetchCalls.push(init!.body as URLSearchParams);
			return Response.json({ success: true });
		};
		const { app } = buildProtectedApp({ fetchFn });

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
		}, {
			"cf-turnstile-response": "header-token",
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			body: { email: "user@example.com" },
		});
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]!.get("response")).toBe("header-token");
	});

	test("valid Turnstile token can come from a form body", async () => {
		const fetchCalls: URLSearchParams[] = [];
		const fetchFn: TurnstileFetch = async (_url, init) => {
			fetchCalls.push(init!.body as URLSearchParams);
			return Response.json({ success: true });
		};
		const { app, nextCalled } = buildTokenOnlyProtectedApp({ fetchFn });
		const form = new URLSearchParams();
		form.set("cf-turnstile-response", "form-token");

		const response = await app.request("/protected", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(nextCalled()).toBe(true);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]!.get("response")).toBe("form-token");
	});

	test("replayed Turnstile token is rejected without calling siteverify again", async () => {
		let verifyCalls = 0;
		const fetchFn: TurnstileFetch = async () => {
			verifyCalls++;
			return Response.json({ success: true });
		};
		const { app } = buildProtectedApp({ fetchFn, cache: new MemoryTurnstileTokenCache() });
		const request = () => app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "same-token",
		}));

		expect((await request()).status).toBe(200);
		const replay = await request();
		expect(replay.status).toBe(403);
		expect(await replay.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["timeout-or-duplicate"],
		});
		expect(verifyCalls).toBe(1);
	});

	test("valid Turnstile response must match the expected action and hostname", async () => {
		const { app } = buildProtectedApp({
			expectedAction: "auth_login",
			allowedHostnames: ["app.example.com"],
			fetchFn: async () => Response.json({
				success: true,
				action: "auth_login",
				hostname: "app.example.com",
			}),
		});

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "valid-action-host-token",
		}));

		expect(response.status).toBe(200);
	});

	test("Turnstile action mismatch is rejected after successful siteverify", async () => {
		const { app, nextCalled } = buildProtectedApp({
			expectedAction: "auth_login",
			allowedHostnames: ["app.example.com"],
			fetchFn: async () => Response.json({
				success: true,
				action: "auth_register",
				hostname: "app.example.com",
			}),
		});

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "wrong-action-token",
		}));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["invalid-action"],
		});
		expect(nextCalled()).toBe(false);
	});

	test("Turnstile hostname mismatch is rejected after successful siteverify", async () => {
		const { app, nextCalled } = buildProtectedApp({
			expectedAction: "auth_login",
			allowedHostnames: ["app.example.com"],
			fetchFn: async () => Response.json({
				success: true,
				action: "auth_login",
				hostname: "evil.example.net",
			}),
		});

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "wrong-host-token",
		}));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["invalid-hostname"],
		});
		expect(nextCalled()).toBe(false);
	});

	test("Turnstile siteverify request is bounded by a timeout", async () => {
		const fetchFn: TurnstileFetch = async (_url, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(init.signal?.reason ?? new Error("siteverify aborted"));
				}, { once: true });
			});
		};
		const { app, nextCalled } = buildProtectedApp({ fetchFn, verifyTimeoutMs: 1 });

		const response = await app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "stalling-token",
		}));

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["siteverify_unavailable"],
		});
		expect(nextCalled()).toBe(false);
	});

	test("transient siteverify outage does not consume the token, so a retry re-verifies", async () => {
		let verifyCalls = 0;
		const fetchFn: TurnstileFetch = async () => {
			verifyCalls++;
			// First call: simulate a transient Cloudflare outage (network throw).
			// Second call: Siteverify recovers and confirms the still-valid token.
			if (verifyCalls === 1) throw new Error("network down");
			return Response.json({ success: true });
		};
		const { app } = buildProtectedApp({ fetchFn, cache: new MemoryTurnstileTokenCache() });
		const request = () => app.request("/protected", jsonRequest({
			email: "user@example.com",
			"cf-turnstile-response": "retryable-token",
		}));

		const first = await request();
		expect(first.status).toBe(403);
		expect(await first.json()).toEqual({
			error: "bot_protection_failed",
			codes: ["siteverify_unavailable"],
		});

		// The same token must NOT be locally rejected as a duplicate; the retry
		// re-reaches Siteverify and succeeds.
		const retry = await request();
		expect(retry.status).toBe(200);
		expect(verifyCalls).toBe(2);
	});

	test("Turnstile remoteip ignores spoofed forwarding headers when proxy trust is off", async () => {
		const previousTrust = serverConfig.trustProxyHeaders;
		(serverConfig as { trustProxyHeaders: boolean }).trustProxyHeaders = false;
		try {
			const fetchCalls: URLSearchParams[] = [];
			const fetchFn: TurnstileFetch = async (_url, init) => {
				fetchCalls.push(init!.body as URLSearchParams);
				return Response.json({ success: true });
			};
			const { app } = buildProtectedApp({ fetchFn });

			const response = await app.request("/protected", jsonRequest({
				email: "user@example.com",
				"cf-turnstile-response": "trusted-ip-token",
			}, {
				"cf-connecting-ip": "203.0.113.10",
				"x-forwarded-for": "203.0.113.11",
			}));

			expect(response.status).toBe(200);
			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0]!.get("remoteip")).toBeNull();
		} finally {
			(serverConfig as { trustProxyHeaders: boolean }).trustProxyHeaders = previousTrust;
		}
	});

	test("TURNSTILE_ENABLED=false bypasses verification in development ergonomics mode", async () => {
		let verifyCalls = 0;
		const fetchFn: TurnstileFetch = async () => {
			verifyCalls++;
			return Response.json({ success: false });
		};
		const { app, nextCalled } = buildProtectedApp({ enabled: false, fetchFn });

		const response = await app.request("/protected", jsonRequest({ email: "dev@example.com" }));

		expect(response.status).toBe(200);
		expect(nextCalled()).toBe(true);
		expect(verifyCalls).toBe(0);
	});

	test("the API bootstrap fails closed when Turnstile is enabled in prod and secret is unset", () => {
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "true",
			TURNSTILE_SECRET_KEY: "",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
		} as NodeJS.ProcessEnv);
		expect(() => assertTurnstileConfigured(config, "production")).toThrow("TURNSTILE_SECRET_KEY");
	});

	test("a NON-auth process importing config in prod without Turnstile secrets does NOT crash", () => {
		// The fail-fast is scoped to the auth-serving API bootstrap (index.ts), not config
		// import — so queue/cron workers and one-off scripts (assets:backfill) that pull
		// serverConfig but never serve auth must import config cleanly even with no TURNSTILE_*.
		const backendRoot = join(import.meta.dir, "..", "..");
		const result = Bun.spawnSync({
			cmd: ["bun", "-e", "import './src/config.ts'"],
			cwd: backendRoot,
			env: {
				...process.env,
				DATA_DIR: join(tmpdir(), `turnstile-prod-${randomUUID()}`),
				JWT_SECRET: "x".repeat(32),
				ALLOWED_ORIGINS: "https://app.example.com",
				NODE_ENV: "production",
				PROCESS_ROLE: "queue-worker",
				// No TURNSTILE_SECRET_KEY / TURNSTILE_ALLOWED_HOSTNAMES on purpose.
				TURNSTILE_SECRET_KEY: "",
				TURNSTILE_ALLOWED_HOSTNAMES: "",
			},
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(result.exitCode).toBe(0);
	});

	test("production enables Turnstile by default (secure-by-default) when fully configured", () => {
		expect(readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_SECRET_KEY: "configured-secret",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
		} as NodeJS.ProcessEnv).enabled).toBe(true);
	});

	test("the API bootstrap fails fast when default-on prod has no secret (no silent unprotected boot)", () => {
		// TURNSTILE_ENABLED unset → defaults ON in production; readTurnstileRuntimeConfig does
		// NOT throw (worker-safe), but the API bootstrap assertion must.
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
		} as NodeJS.ProcessEnv);
		expect(config.enabled).toBe(true);
		expect(() => assertTurnstileConfigured(config, "production")).toThrow("TURNSTILE_SECRET_KEY");
	});

	test("production operators can still EXPLICITLY opt out of Turnstile", () => {
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "false",
		} as NodeJS.ProcessEnv);
		expect(config.enabled).toBe(false);
		// Disabled → the bootstrap assertion is a no-op even with no secret.
		expect(() => assertTurnstileConfigured(config, "production")).not.toThrow();
	});

	test("a TYPO'd override does NOT silently disable Turnstile in production (fail-closed)", () => {
		// "flase" is unrecognized → strict parser keeps the safe default (ON in prod), so the
		// bootstrap assertion still fires instead of booting unprotected.
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "flase",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
		} as NodeJS.ProcessEnv);
		expect(config.enabled).toBe(true);
		expect(() => assertTurnstileConfigured(config, "production")).toThrow("TURNSTILE_SECRET_KEY");
	});

	test("dev/test default OFF so local flows need no CAPTCHA", () => {
		expect(readTurnstileRuntimeConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv).enabled).toBe(false);
		expect(readTurnstileRuntimeConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv).enabled).toBe(false);
	});

	test("the API bootstrap requires allowed hostnames when Turnstile is enabled", () => {
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "true",
			TURNSTILE_SECRET_KEY: "configured-secret",
			TURNSTILE_ALLOWED_HOSTNAMES: "",
		} as NodeJS.ProcessEnv);
		expect(() => assertTurnstileConfigured(config, "production")).toThrow("TURNSTILE_ALLOWED_HOSTNAMES");
	});

	test("a missing public site key WARNS but does NOT block boot (VITE-only deploys are valid)", () => {
		// Backend doesn't use TURNSTILE_SITE_KEY for Siteverify, and a split deploy may inject the
		// key into the web build via VITE_TURNSTILE_SITE_KEY where the API can't see it. So a
		// missing TURNSTILE_SITE_KEY must NOT hard-fail boot (only secret + hostnames are required).
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "true",
			TURNSTILE_SECRET_KEY: "configured-secret",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
		} as NodeJS.ProcessEnv);
		expect(() => assertTurnstileConfigured(config, "production")).not.toThrow();
	});

	test("a fully-configured prod (secret + hostnames + site key) passes the bootstrap assertion", () => {
		const config = readTurnstileRuntimeConfig({
			NODE_ENV: "production",
			TURNSTILE_ENABLED: "true",
			TURNSTILE_SECRET_KEY: "configured-secret",
			TURNSTILE_ALLOWED_HOSTNAMES: "app.example.com",
			TURNSTILE_SITE_KEY: "0x4AAA-site-key",
		} as NodeJS.ProcessEnv);
		expect(() => assertTurnstileConfigured(config, "production")).not.toThrow();
	});
});
