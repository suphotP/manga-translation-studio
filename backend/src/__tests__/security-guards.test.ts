import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { createCsrfToken } from "../services/csrf.js";
import { serverConfig } from "../config.js";
import { RequestBodyLimitError, csrfGuard, isAllowedOrigin, originGuard, protectedApiAuthGuard, requestSizeGuard } from "../middleware/security-guards.js";
import { getMetrics } from "../middleware/metrics.js";

function snapshotGuardConfig() {
	return {
		apiAuthRequired: serverConfig.apiAuthRequired,
		apiMutationAuthRequired: serverConfig.apiMutationAuthRequired,
		apiOriginGuardEnabled: serverConfig.apiOriginGuardEnabled,
		apiCsrfRequired: serverConfig.apiCsrfRequired,
		allowedOrigins: serverConfig.allowedOrigins,
		maxJsonBodySizeBytes: serverConfig.maxJsonBodySizeBytes,
		maxUploadBatchSizeBytes: serverConfig.maxUploadBatchSizeBytes,
	};
}

function restoreGuardConfig(snapshot: ReturnType<typeof snapshotGuardConfig>) {
	Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

describe("security guards", () => {
	test("protected API auth guard requires users for mutation routes when enabled", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: false,
				apiMutationAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", protectedApiAuthGuard());
			app.post("/api/project/project-a/save", (c) => c.json({ ok: true }));
			app.post("/api/auth/login", (c) => c.json({ ok: true }));

			const blocked = await app.request("/api/project/project-a/save", { method: "POST" });
			const publicLogin = await app.request("/api/auth/login", { method: "POST" });

			expect(blocked.status).toBe(401);
			expect(await blocked.json()).toEqual(expect.objectContaining({ code: "auth_required" }));
			expect(publicLogin.status).toBe(200);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("protected API auth guard treats cookie logout as public even when API auth is required", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", protectedApiAuthGuard());
			app.post("/api/auth/logout-cookie", (c) => c.json({ ok: true }));
			app.post("/api/auth/logout", (c) => c.json({ ok: true }));

			const cookieLogout = await app.request("/api/auth/logout-cookie", { method: "POST" });
			const bearerLogout = await app.request("/api/auth/logout", { method: "POST" });

			expect(cookieLogout.status).toBe(200);
			expect(bearerLogout.status).toBe(401);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("protected API auth guard exempts the signed account routes opened from email", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			// Auth-required mode is the strictest posture: every /api/* path needs
			// a session. The signed export download + account restore links are
			// opened from email in a logged-out browser and carry their own HMAC
			// proof, so the guard must let them through to the route handler.
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", protectedApiAuthGuard());
			app.get("/api/account/export/job-1/download", (c) => c.json({ ok: true }));
			app.post("/api/account/restore", (c) => c.json({ ok: true }));
			app.delete("/api/account", (c) => c.json({ ok: true }));

			const download = await app.request("/api/account/export/job-1/download");
			const restore = await app.request("/api/account/restore?user=user-a&token=abc", { method: "POST" });
			const deleteBlocked = await app.request("/api/account", { method: "DELETE" });

			expect(download.status).toBe(200);
			expect(restore.status).toBe(200);
			expect(deleteBlocked.status).toBe(401);
			expect(await deleteBlocked.json()).toEqual(expect.objectContaining({ code: "auth_required" }));
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("protected API auth guard whitelists unauthenticated recovery endpoints", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: true,
				apiMutationAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", protectedApiAuthGuard());
			app.post("/api/auth/forgot-password", (c) => c.json({ ok: true }));
			app.post("/api/auth/reset-password", (c) => c.json({ ok: true }));
			app.post("/api/auth/verify-email", (c) => c.json({ ok: true }));

			for (const path of ["/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/verify-email"]) {
				const response = await app.request(path, { method: "POST" });
				expect(response.status).toBe(200);
			}
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("protected API auth guard leaves SSO start/callback/confirm public when auth is required", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			// Production posture: every non-public /api/* path needs a session.
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: true,
				apiMutationAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", protectedApiAuthGuard());
			app.get("/api/auth/sso/google/start", (c) => c.json({ ok: "start" }));
			app.get("/api/auth/sso/github/callback", (c) => c.json({ ok: "callback" }));
			app.post("/api/auth/sso/link/confirm", (c) => c.json({ ok: "confirm" }));
			app.get("/api/auth/me", (c) => c.json({ ok: "me" }));

			const start = await app.request("/api/auth/sso/google/start");
			const callback = await app.request("/api/auth/sso/github/callback");
			const confirm = await app.request("/api/auth/sso/link/confirm", { method: "POST" });
			const blockedMe = await app.request("/api/auth/me");

			expect(start.status).toBe(200);
			expect(callback.status).toBe(200);
			expect(confirm.status).toBe(200);
			// A non-whitelisted authenticated route is still protected.
			expect(blockedMe.status).toBe(401);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("csrf guard does not block unauthenticated recovery endpoints", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiCsrfRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", csrfGuard());
			app.post("/api/auth/reset-password", (c) => c.json({ ok: true }));

			const response = await app.request("/api/auth/reset-password", { method: "POST" });
			expect(response.status).toBe(200);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("protected API auth guard allows authenticated mutations", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiMutationAuthRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", async (c, next) => {
				c.set("user", { userId: "user-a" });
				await next();
			});
			app.use("/api/*", protectedApiAuthGuard());
			app.post("/api/images/project-a/upload", (c) => c.json({ ok: true }));

			const response = await app.request("/api/images/project-a/upload", { method: "POST" });

			expect(response.status).toBe(200);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("origin guard rejects cross-origin browser mutations but allows configured origins", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiOriginGuardEnabled: true,
				allowedOrigins: "http://localhost:5173,https://app.example.com",
			});
			const app = new Hono();
			app.use("/api/*", originGuard());
			app.post("/api/project/project-a/save", (c) => c.json({ ok: true }));

			const rejected = await app.request("/api/project/project-a/save", {
				method: "POST",
				headers: { origin: "https://evil.example" },
			});
			const accepted = await app.request("/api/project/project-a/save", {
				method: "POST",
				headers: { origin: "https://app.example.com" },
			});

			expect(rejected.status).toBe(403);
			expect(await rejected.json()).toEqual(expect.objectContaining({ code: "origin_not_allowed" }));
			expect(accepted.status).toBe(200);
			expect(isAllowedOrigin("https://app.example.com", serverConfig.allowedOrigins)).toBe(true);
			expect(await getMetrics()).toContain('api_security_guard_rejections_total{reason="origin_not_allowed",method="POST"}');
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("wildcard origins are rejected while running as production", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			expect(isAllowedOrigin("https://app.example.com", "*")).toBe(false);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
		}
	});

	test("csrf guard requires a user-bound token only when enabled", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiCsrfRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", async (c, next) => {
				c.set("user", { userId: "user-a" });
				await next();
			});
			app.use("/api/*", csrfGuard());
			app.post("/api/project/project-a/save", (c) => c.json({ ok: true }));

			const missing = await app.request("/api/project/project-a/save", { method: "POST" });
			const accepted = await app.request("/api/project/project-a/save", {
				method: "POST",
				headers: { "x-csrf-token": createCsrfToken("user-a") },
			});
			const wrongUser = await app.request("/api/project/project-a/save", {
				method: "POST",
				headers: { "x-csrf-token": createCsrfToken("user-b") },
			});

			expect(missing.status).toBe(403);
			expect(accepted.status).toBe(200);
			expect(wrongUser.status).toBe(403);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("csrf guard does not block public auth or bearer-token API mutations", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiCsrfRequired: true,
			});
			const app = new Hono();
			app.use("/api/*", csrfGuard());
			app.post("/api/auth/login", (c) => c.json({ ok: true }));
			app.post("/api/auth/logout-cookie", (c) => c.json({ ok: true }));
			app.post("/api/project/project-a/save", (c) => c.json({ ok: true }));

			const login = await app.request("/api/auth/login", { method: "POST" });
			const cookieLogout = await app.request("/api/auth/logout-cookie", { method: "POST" });
			const bearerMutation = await app.request("/api/project/project-a/save", {
				method: "POST",
				headers: { authorization: "Bearer access-token" },
			});
			const anonymousMutation = await app.request("/api/project/project-a/save", { method: "POST" });

			expect(login.status).toBe(200);
			expect(cookieLogout.status).toBe(200);
			expect(bearerMutation.status).toBe(200);
			expect(anonymousMutation.status).toBe(403);
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("request size guard rejects oversized JSON before route parsing", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				maxJsonBodySizeBytes: 8,
			});
			const app = new Hono();
			app.use("/api/*", requestSizeGuard());
			app.onError((error, c) => {
				if (error instanceof RequestBodyLimitError) {
					return c.json({
						error: "Request body too large",
						code: "request_body_too_large",
						limitBytes: error.limitBytes,
					}, 413);
				}
				throw error;
			});
			app.post("/api/project/new", async (c) => c.json({ body: await c.req.text() }));

			const response = await app.request("/api/project/new", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": "128",
				},
				body: JSON.stringify({ name: "large" }),
			});

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	test("request size guard counts bodies when Content-Length is missing", async () => {
		const snapshot = snapshotGuardConfig();
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				maxJsonBodySizeBytes: 8,
			});
			const app = new Hono();
			app.use("/api/*", requestSizeGuard());
			app.onError((error, c) => {
				if (error instanceof RequestBodyLimitError) {
					return c.json({
						error: "Request body too large",
						code: "request_body_too_large",
						limitBytes: error.limitBytes,
					}, 413);
				}
				throw error;
			});
			app.post("/api/project/new", async (c) => c.json({ body: await c.req.text() }));

			const response = await app.request("/api/project/new", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "large" }),
			});

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
		} finally {
			restoreGuardConfig(snapshot);
		}
	});

	// Both /upload and /upload-transform buffer the whole multipart body via
	// formData() before any per-file/per-batch check, so the guard must cap them
	// using the upload batch limit. Previously the path regex only matched
	// /upload, leaving /upload-transform open to a memory-DoS.
	function uploadGuardApp() {
		const app = new Hono();
		app.use("/api/*", requestSizeGuard());
		app.onError((error, c) => {
			if (error instanceof RequestBodyLimitError) {
				return c.json({
					error: "Request body too large",
					code: "request_body_too_large",
					limitBytes: error.limitBytes,
				}, 413);
			}
			throw error;
		});
		// Echo the (buffered) body length so we know the route actually ran for the
		// "legit upload" case.
		const echo = async (c: Context) => {
			const body = await c.req.arrayBuffer();
			return c.json({ bytes: body.byteLength });
		};
		app.post("/api/images/proj-1/upload", echo);
		app.post("/api/images/proj-1/upload-transform", echo);
		return app;
	}

	for (const route of ["upload", "upload-transform"] as const) {
		test(`request size guard rejects oversized multipart /${route} via Content-Length before buffering`, async () => {
			const snapshot = snapshotGuardConfig();
			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					maxUploadBatchSizeBytes: 16,
				});
				const app = uploadGuardApp();

				const response = await app.request(`/api/images/proj-1/${route}`, {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=----x",
						// Fabricated oversized declared size — must 413 before the body
						// is ever read into memory.
						"content-length": "1048576",
					},
					body: "data".repeat(64),
				});

				expect(response.status).toBe(413);
				expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
			} finally {
				restoreGuardConfig(snapshot);
			}
		});

		test(`request size guard caps oversized multipart /${route} when Content-Length is missing`, async () => {
			const snapshot = snapshotGuardConfig();
			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					maxUploadBatchSizeBytes: 16,
				});
				const app = uploadGuardApp();

				// Stream a body larger than the cap with no Content-Length: the guard
				// must count bytes during the read and abort instead of buffering it all.
				const big = new TextEncoder().encode("x".repeat(4096));
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(big);
						controller.close();
					},
				});
				const request = new Request(`http://localhost/api/images/proj-1/${route}`, {
					method: "POST",
					headers: { "content-type": "multipart/form-data; boundary=----x" },
					body: stream,
					duplex: "half",
				} as RequestInit & { duplex: "half" });
				const response = await app.request(request);

				expect(response.status).toBe(413);
				expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
			} finally {
				restoreGuardConfig(snapshot);
			}
		});

		test(`request size guard caps a lying small Content-Length whose streamed /${route} body exceeds the limit`, async () => {
			const snapshot = snapshotGuardConfig();
			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					maxUploadBatchSizeBytes: 16,
				});
				const app = uploadGuardApp();

				// The request declares a tiny, under-limit Content-Length but actually
				// streams a body far larger than the cap. The early Content-Length check
				// lets it pass (it claims to be small), so the streaming byte-counter is
				// the only thing standing between the handler's formData() buffer and an
				// OOM. It must abort the read with a 413 instead of buffering 4KB.
				const big = new TextEncoder().encode("x".repeat(4096));
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(big);
						controller.close();
					},
				});
				const request = new Request(`http://localhost/api/images/proj-1/${route}`, {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=----x",
						// Lie: claims 4 bytes, well under the 16-byte cap.
						"content-length": "4",
					},
					body: stream,
					duplex: "half",
				} as RequestInit & { duplex: "half" });
				const response = await app.request(request);

				expect(response.status).toBe(413);
				expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
			} finally {
				restoreGuardConfig(snapshot);
			}
		});

		test(`request size guard lets a normal-size multipart /${route} through`, async () => {
			const snapshot = snapshotGuardConfig();
			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					maxUploadBatchSizeBytes: 1024 * 1024,
				});
				const app = uploadGuardApp();

				const body = "hello-upload";
				const response = await app.request(`/api/images/proj-1/${route}`, {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=----x",
						"content-length": String(body.length),
					},
					body,
				});

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ bytes: body.length });
			} finally {
				restoreGuardConfig(snapshot);
			}
		});
	}
});
