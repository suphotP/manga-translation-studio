// Regression coverage for the "predictable client errors surfacing with the
// wrong status/shape" problem class.
//
// FIX A — the global `app.onError` no longer derives status by SUBSTRING-matching
// the error message (the old heuristic mapped "not found"→404, "invalid"/
// "traversal"→400, else 500, leaking internal messages/IDs and producing the
// wrong status). It now maps TYPED errors (status + code) and collapses every
// other error to a generic 500 with NO leaked message.
//
// FIX B — hot mutation endpoints used a bare `c.req.json()` that threw a
// SyntaxError on malformed/empty bodies → fell through to onError. They now use
// `readJsonBody`, returning a clean `400 { error:"Invalid JSON body",
// code:"invalid_json" }`.

process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ProjectState } from "../types/index.js";

let globalErrorHandler: (err: Error, c: Context) => Response;
// Routers mounted directly (no global auth/CSRF middleware), so a malformed-body
// request reaches each handler's `readJsonBody` guard — the unit under test —
// without standing up real users. This also isolates the test from the shared
// USERS_DIR/config that other test files mutate (and delete) in the full suite.
let ai: Hono;
let project: Hono;
let PROJECTS_DIR: string;
let writeProjectState: (projectId: string, state: ProjectState) => Promise<void>;
let hashProjectState: (state: ProjectState) => string;
const createdProjectDirs: string[] = [];

beforeAll(async () => {
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";
	globalErrorHandler = (await import("../index.js")).globalErrorHandler;
	ai = (await import("../routes/ai.js")).ai as unknown as Hono;
	const projectMod = await import("../routes/project.js");
	project = projectMod.project as unknown as Hono;
	writeProjectState = projectMod.writeProjectState as typeof writeProjectState;
	hashProjectState = projectMod.hashProjectState as typeof hashProjectState;
	PROJECTS_DIR = (await import("../config.js")).PROJECTS_DIR;
});

afterAll(() => {
	for (const dir of createdProjectDirs) rmSync(dir, { recursive: true, force: true });
});

// Persist a minimal file-mode project (via the app's own writer, so the on-disk
// shape + hash match what readProjectState/checkProjectBaselineConflict expect)
// so a handler whose `readJsonBody` guard runs AFTER readProjectState (POST
// /comments) can reach the guard. Returns the id + a valid baseline hash so the
// test passes deterministically whether or not the require-baseline gate is on.
async function seedProject(): Promise<{ projectId: string; baseHash: string }> {
	const projectId = uuid();
	const state = {
		projectId,
		name: "Malformed body fixture",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	} as unknown as ProjectState;
	await writeProjectState(projectId, state);
	createdProjectDirs.push(join(PROJECTS_DIR, projectId));
	return { projectId, baseHash: hashProjectState(state) };
}

// Mount the REAL exported handler on a tiny app whose routes throw the error
// under test. This exercises the actual mapping logic end-to-end (status + body)
// without the full middleware stack.
function appThatThrows(makeError: () => unknown): Hono {
	const tiny = new Hono();
	tiny.get("/boom", () => {
		throw makeError();
	});
	tiny.onError(globalErrorHandler);
	return tiny;
}

describe("globalErrorHandler — typed-error mapping (FIX A)", () => {
	test("typed HTTP-ish error keeps its explicit status + code (no substring guessing)", async () => {
		const { WorkspaceAccessError } = await import("../services/workspace-access.js");
		const tiny = appThatThrows(() => new WorkspaceAccessError("Forbidden: scope cannot do that", 403, "workspace_scope_denied"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Forbidden: scope cannot do that", code: "workspace_scope_denied" });
	});

	test("ByoApiError (code-before-status ctor order) still maps correctly", async () => {
		const { ByoApiError } = await import("../services/byo-api.js");
		const tiny = appThatThrows(() => new ByoApiError("BYO key rejected", "byo_key_invalid", 422));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: "BYO key rejected", code: "byo_key_invalid" });
	});

	test("DodoBillingError maps to its status + code", async () => {
		const { DodoBillingError } = await import("../services/dodo.service.js");
		const tiny = appThatThrows(() => new DodoBillingError("Checkout session failed", "dodo_checkout_failed", 502));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Checkout session failed", code: "dodo_checkout_failed" });
	});

	test("generic HttpError maps to its status + code", async () => {
		const { HttpError } = await import("../utils/http-error.js");
		const tiny = appThatThrows(() => new HttpError("Teapot", 418, "i_am_a_teapot"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(418);
		expect(await res.json()).toEqual({ error: "Teapot", code: "i_am_a_teapot" });
	});

	test("AiJobSubmissionError renders its prebuilt body + status + Retry-After", async () => {
		const { AiJobSubmissionError } = await import("../services/ai-job-submission.js");
		const tiny = appThatThrows(() => new AiJobSubmissionError(503, { error: "Queue draining", code: "ai_queue_draining" }, 30));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("30");
		expect(await res.json()).toEqual({ error: "Queue draining", code: "ai_queue_draining" });
	});

	test("Hono HTTPException renders via its own response/status", async () => {
		const tiny = appThatThrows(() => new HTTPException(429, { message: "Slow down" }));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(429);
	});

	test("RequestBodyLimitError still maps to a typed 413 (special-case preserved)", async () => {
		const { RequestBodyLimitError } = await import("../middleware/security-guards.js");
		const tiny = appThatThrows(() => new RequestBodyLimitError(1024));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Request body too large", code: "request_body_too_large", limitBytes: 1024 });
	});

	// The crux of the fix: a PLAIN Error whose message contains the old magic
	// words must NOT leak (no status guess, no message). This is the Redis-leak /
	// ID-leak regression guard.
	test('plain Error with "invalid" in message → 500 generic, NO message leak (was 400 + leak)', async () => {
		const tiny = appThatThrows(() => new Error("Redis AI queue snapshot is invalid: unexpected token at position 7"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json).toEqual({ error: "Internal server error", code: "internal_error" });
		expect(JSON.stringify(json)).not.toContain("Redis");
		expect(JSON.stringify(json)).not.toContain("snapshot");
	});

	test('plain Error with "not found" in message → 500 generic, NO leaked ID (was 404 + leak)', async () => {
		const tiny = appThatThrows(() => new Error("Asset version asset-abc-123 not found"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json).toEqual({ error: "Internal server error", code: "internal_error" });
		expect(JSON.stringify(json)).not.toContain("asset-abc-123");
	});

	test('plain Error with "traversal" in message → 500 generic, NO leak (was 400)', async () => {
		const tiny = appThatThrows(() => new Error("path traversal blocked for /etc/passwd"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Internal server error", code: "internal_error" });
	});

	test("isHttpishError ignores a plain Error with a bogus/non-numeric status", async () => {
		const { isHttpishError } = await import("../utils/http-error.js");
		const fake = Object.assign(new Error("nope"), { status: "418", code: "x" });
		expect(isHttpishError(fake)).toBe(false);
		const noCode = Object.assign(new Error("nope"), { status: 400 });
		expect(isHttpishError(noCode)).toBe(false);
		const ok = Object.assign(new Error("yep"), { status: 400, code: "bad" });
		expect(isHttpishError(ok)).toBe(true);
	});
});

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("malformed JSON body → 400 invalid_json (FIX B)", () => {
	test("POST /translate with malformed JSON → 400 invalid_json (readJsonBody is the first guard)", async () => {
		const res = await ai.request("/translate", { method: "POST", headers: JSON_HEADERS, body: "{not-json" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});

	test("POST / (createProject) with an EMPTY body → 400 invalid_json", async () => {
		const res = await project.request("/", { method: "POST", headers: JSON_HEADERS, body: "" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});

	test("POST /:id/comments with malformed JSON → 400 invalid_json (after readProjectState)", async () => {
		const { projectId, baseHash } = await seedProject();
		// Pass a valid concurrency baseline so the optional require-baseline gate
		// (428) does not fire before readJsonBody — we want to exercise the JSON guard.
		const res = await project.request(`/${projectId}/comments`, {
			method: "POST",
			headers: { ...JSON_HEADERS, "x-project-base-state-hash": baseHash },
			body: "{not-json",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});
});

// ── Round 2, FINDING 1 ─────────────────────────────────────────────────────
// `readJsonBody` must NOT swallow a RequestBodyLimitError. When a client STREAMS
// JSON past MAX_JSON_BODY_SIZE_KB without an oversized Content-Length, the size
// guard's withBodyLimit wrapper calls `controller.error(new RequestBodyLimitError)`
// — which surfaces as a thrown RequestBodyLimitError *inside* `c.req.json()`. The
// bare catch used to map that to 400 invalid_json, masking the size signal. It
// now rethrows so requestSizeGuard's catch (and the global handler) can emit 413.
describe("oversized STREAMED JSON via readJsonBody → 413 (FINDING 1)", () => {
	// A streamed body with NO Content-Length: bypasses the guard's up-front
	// `content-length > limit` rejection so the body is wrapped and the cap is
	// enforced mid-read — exactly the path where readJsonBody's `c.req.json()`
	// throws RequestBodyLimitError.
	function streamingJsonRequest(path: string, json: string): Request {
		const bytes = new TextEncoder().encode(json);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Emit in small chunks so the byte-counting TransformStream trips the
				// limit partway through, mirroring a real chunked upload.
				for (let i = 0; i < bytes.length; i += 4) {
					controller.enqueue(bytes.slice(i, i + 4));
				}
				controller.close();
			},
		});
		return new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
	}

	test("request that streams JSON past the JSON cap → 413 request_body_too_large (was masked as 400)", async () => {
		const { requestSizeGuard, RequestBodyLimitError } = await import("../middleware/security-guards.js");
		const { serverConfig } = await import("../config.js");
		const { readJsonBody } = await import("../utils/request-body.js");

		const originalLimit = serverConfig.maxJsonBodySizeBytes;
		// Tiny cap so a small JSON object overflows it while streaming.
		(serverConfig as unknown as Record<string, unknown>).maxJsonBodySizeBytes = 8;
		try {
			const app = new Hono();
			app.use("/api/*", requestSizeGuard());
			// The handler reads via readJsonBody — the unit under test. If it swallowed
			// RequestBodyLimitError this route would answer 400 invalid_json; with the
			// rethrow the error propagates to requestSizeGuard's catch → 413.
			app.post("/api/echo", async (c) => {
				const parsed = await readJsonBody(c);
				if (!parsed.ok) return parsed.response;
				return c.json({ ok: true, data: parsed.data });
			});
			app.onError((error, c) => {
				// Mirror the production guard fallback so an escaped limit error still 413s.
				if (error instanceof RequestBodyLimitError) {
					return c.json({ error: "Request body too large", code: "request_body_too_large", limitBytes: error.limitBytes }, 413);
				}
				throw error;
			});

			const res = await app.request(streamingJsonRequest("/api/echo", JSON.stringify({ name: "way too large to fit in eight bytes" })));
			expect(res.status).toBe(413);
			expect(await res.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
		} finally {
			(serverConfig as unknown as Record<string, unknown>).maxJsonBodySizeBytes = originalLimit;
		}
	});

	test("readJsonBody RETHROWS RequestBodyLimitError but still maps a SyntaxError to 400 (unit)", async () => {
		const { readJsonBody } = await import("../utils/request-body.js");
		const { RequestBodyLimitError } = await import("../middleware/security-guards.js");

		// A context whose c.req.json() throws the limit error → readJsonBody must rethrow it.
		const limitCtx = {
			req: { json: async () => { throw new RequestBodyLimitError(1024); } },
			json: () => { throw new Error("c.json should not be called when rethrowing"); },
		} as unknown as Context;
		await expect(readJsonBody(limitCtx)).rejects.toBeInstanceOf(RequestBodyLimitError);

		// A genuine JSON SyntaxError still collapses to the clean 400 invalid_json.
		const tiny = new Hono();
		tiny.post("/x", async (c) => {
			const parsed = await readJsonBody(c);
			return parsed.ok ? c.json(parsed.data) : parsed.response;
		});
		const res = await tiny.request("/x", { method: "POST", headers: JSON_HEADERS, body: "{not-json" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});
});

// ── Round 2, FINDING 2 ─────────────────────────────────────────────────────
// A client-addressable "version not found" thrown by StorageCowService.promoteToMaster
// escapes the POST /api/assets/:id/promote route (its catch handles only
// StorageCow/Quota errors and rethrows the rest). Under the old substring
// heuristic it surfaced as 404; the typed-mapping handler would have collapsed a
// PLAIN Error to 500, so the throw site now raises a typed HttpError(404).
describe("promoteToMaster missing version → typed 404 (FINDING 2)", () => {
	test("throws HttpError with status 404 + code asset_version_not_found", async () => {
		const { StorageCowService } = await import("../services/storage-cow.js");
		const { HttpError } = await import("../utils/http-error.js");

		// Minimal SQL stub: getVersionForUpdate finds no row → promote must throw the
		// typed not-found. runTransaction uses client.begin when present, so the stub
		// runs the txn body against itself; the version lookup returns no rows.
		const sqlStub = {
			unsafe: async () => [] as unknown[], // version lookup → no row
			begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlStub),
		};

		const service = new StorageCowService({ client: sqlStub as never });
		let caught: unknown;
		try {
			await service.promoteToMaster({ versionId: "missing-version-id", workspaceId: "ws-1", approverUserId: "user-1" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HttpError);
		expect((caught as InstanceType<typeof HttpError>).status).toBe(404);
		expect((caught as InstanceType<typeof HttpError>).code).toBe("asset_version_not_found");
	});

	test("globalErrorHandler renders that HttpError as 404 + code (route-escape rendering)", async () => {
		const { HttpError } = await import("../utils/http-error.js");
		const tiny = appThatThrows(() => new HttpError("Asset version missing-version-id not found", 404, "asset_version_not_found"));
		const res = await tiny.request("/boom");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Asset version missing-version-id not found", code: "asset_version_not_found" });
	});
});
