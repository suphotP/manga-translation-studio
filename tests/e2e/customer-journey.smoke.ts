/**
 * Wave 5 — End-to-end customer-journey smoke test.
 *
 * Walks the full SaaS customer journey against the REAL backend Hono app,
 * booted in-process in file-mode (temp DATA_DIR, no Postgres/Redis required):
 *
 *   signup -> verify-email -> create-workspace -> invite-member ->
 *   upload-chapter -> translate (AI) -> typeset -> QC -> export -> subscribe/pay
 *
 * Run mode: opt-in. This file lives OUTSIDE every CI test glob
 * (`backend/src/__tests__`, frontend vitest, frontend Playwright `e2e/`) so it
 * never runs in the existing CI jobs. Invoke explicitly:
 *
 *   RUN_E2E_SMOKE=1 bun run tests/e2e/customer-journey.smoke.ts
 *   (or `bun run test:e2e` from the repo root)
 *
 * ── STUBBED vs REAL (see tests/e2e/README.md for the full matrix) ────────────
 *
 *  REAL (exercises the genuine backend route + service contract in file-mode):
 *    - signup            POST /api/auth/register
 *    - verify-email      POST /api/auth/verify-email  (token captured via an
 *                        injected test mailer — only the *delivery provider* is
 *                        stubbed; the verify token + endpoint are real)
 *    - login             POST /api/auth/login
 *    - create-project    POST /api/project/new        (personal project; the
 *                        customer-facing "create chapter" surface in file-mode)
 *    - upload-chapter    POST /api/images/:projectId/upload (real PNG, multipart)
 *    - typeset           POST /api/project/:id/save   (persist translated text
 *                        layers — the real artifact a typesetter produces)
 *    - QC                POST /api/project/:id/review-decisions (approve page)
 *    - export            POST /api/export             (enqueue, real 202 job)
 *
 *  STUBBED (external provider / SaaS dependency mocked; contract asserted):
 *    - translate (AI)    POST /api/ai/translate. The OpenAI HTTPS boundary
 *                        (api.openai.com, including /v1/moderations) is
 *                        intercepted via globalThis.fetch. No real OpenAI
 *                        key/cost. The smoke passes ONLY when the endpoint queues
 *                        a job OR returns a *documented* provider/credit/asset/
 *                        queue gate (specific status + code/reason); a 400/401/403
 *                        or any other error fails. REAL CRED NEEDED: OPENAI_API_KEY.
 *
 *  POSTGRES-GATED (asserted as the documented degraded contract in file-mode;
 *  requires DATABASE_URL for the full multi-tenant path):
 *    - create-workspace  POST /api/workspaces        -> 503 workspace_store_unavailable
 *    - invite-member     POST /api/workspaces/:id/invites -> 503 (store-gated).
 *                        When create-workspace returned 201, the caller is seeded
 *                        as owner, so the invite MUST return 201 (a 403/404/503
 *                        there fails the smoke — no false pass).
 *    - subscribe / pay   POST /api/billing/:workspaceId/checkout-session, sent
 *                        through the MOUNTED in-process app (covers route
 *                        ordering + provider fall-through). Default provider is
 *                        "mock": file-mode -> 503 (no workspace store); with
 *                        DATABASE_URL + an owned workspace -> 200 labeled
 *                        prototype checkout_url + provider:"mock". REAL Dodo:
 *                        BILLING_PROVIDER=dodo + DODO_API_KEY + Postgres.
 *    These steps are REAL when DATABASE_URL is set; the smoke records which path
 *    it took so a Postgres-backed run lights them up without code changes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Opt-in gate ──────────────────────────────────────────────────────────────
if (process.env.RUN_E2E_SMOKE !== "1") {
	console.log("[w5-e2e] skipped (set RUN_E2E_SMOKE=1 to run the customer-journey smoke).");
	process.exit(0);
}

// 1x1 transparent PNG — a real, decodable image for the upload step.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

const LOCAL_ORIGIN = "http://localhost:3001";
const BASE = `${LOCAL_ORIGIN}/api`;

interface StepResult {
	name: string;
	classification: "real" | "stubbed" | "postgres-gated";
	ok: boolean;
	detail: string;
}

const results: StepResult[] = [];
const captured = { verifyToken: undefined as string | undefined };

function record(name: string, classification: StepResult["classification"], ok: boolean, detail: string): void {
	results.push({ name, classification, ok, detail });
	const tag = ok ? "PASS" : "FAIL";
	const badge = classification.toUpperCase();
	console.log(`[w5-e2e] ${tag.padEnd(4)} ${badge.padEnd(13)} ${name} — ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
	// ── Environment: file-mode, permissive local posture, generous limits ──────
	const dataDir = mkdtempSync(join(tmpdir(), "w5-e2e-"));
	// FORCE the test runtime (do NOT honor an inherited NODE_ENV=development).
	// serverConfig keys off NODE_ENV==="test" to relax the upload-dimension floor
	// to 1×1; if we merely defaulted-when-unset, a shell already exporting
	// NODE_ENV=development would import the real 64×64 minimum and the 1×1 TINY_PNG
	// upload would deterministically fail with `image_dimensions_too_small`.
	// Pinning it here keeps `bun run test:e2e` deterministic regardless of caller env.
	process.env.NODE_ENV = "test";
	process.env.DATA_DIR = dataDir;
	process.env.APP_URL = "http://localhost:5173";
	process.env.MAILER_PROVIDER = "null"; // delivery stubbed; we inject a capturing sender below
	process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS = "true";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = "100000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = "100000";
	process.env.USAGE_DAILY_AI_CREDIT_THB = "100000";
	process.env.USAGE_MONTHLY_AI_CREDIT_THB = "100000";
	// AI provider STUB: enable OpenAI-image route with a fake key; the HTTPS call
	// is intercepted below so no real OpenAI request/charge happens.
	process.env.OPENAI_API_KEY = "sk-e2e-stub";
	process.env.OPENAI_IMAGES_ENABLED = "true";
	// Keep the in-process AI queue processor off; the smoke asserts the submit
	// contract, not provider execution (the provider itself is stubbed).
	process.env.AI_QUEUE_PROCESSOR_ENABLED = "false";

	// ── PIN file-mode provider/store env (override inherited dev/CI values) ────
	// The smoke is documented as file-mode with no Redis/external credentials.
	// A developer or CI shell may already export STORAGE_DRIVER=r2,
	// BILLING_PROVIDER=dodo (without a key), a stale REDIS_URL, etc. Importing the
	// real app under those would fail config validation or hang on external
	// services. Force local/mock/memory drivers before importing backend modules.
	// (DATABASE_URL is intentionally left intact: a real Postgres lights up the
	// workspace/invite path as documented; absence keeps the file-mode contract.)
	process.env.STORAGE_DRIVER = "local";
	// BILLING_PROVIDER must be 'dodo' or 'none' (config rejects anything else).
	// "none" maps to the in-app *mock* billing provider (serverConfig.billing.provider
	// === "mock"), which is exactly the file-mode checkout path this smoke exercises.
	process.env.BILLING_PROVIDER = "none";
	process.env.AUTH_SESSION_STORE = "file";
	process.env.UPLOAD_AUDIT_STORE = "file";
	process.env.PROJECT_CATALOG_STORE = process.env.DATABASE_URL ? (process.env.PROJECT_CATALOG_STORE ?? "postgres") : "file";
	delete process.env.REDIS_URL;
	delete process.env.AI_QUEUE_REDIS_URL;
	delete process.env.RATE_LIMIT_REDIS_URL;
	// Moderation: deterministic local pass. The OpenAI HTTPS boundary is stubbed
	// below (including /v1/moderations), but disabling image moderation here means
	// the smoke never depends on the moderation parser's fail-open/closed posture.
	process.env.OPENAI_MODERATION_ENABLED = "false";

	const root = join(import.meta.dir, "..", "..");
	const backendSrc = join(root, "backend", "src");

	// Import config first and force the legacy-anonymous + permissive posture in
	// case config.ts was already module-cached, mirroring routes.test.ts.
	const { serverConfig } = await import(join(backendSrc, "config.ts"));
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		allowLegacyAnonymousProjects: true,
	});

	// ── Inject a capturing test mailer (stubs the DELIVERY provider only) ──────
	// sendRegistrationVerification() calls this with { user, verifyUrl }, where
	// verifyUrl carries the real single-use email-verify token.
	const authModule = await import(join(backendSrc, "routes", "auth.ts"));
	authModule.setAuthEmailSenderForTesting(async (template: string, data: any) => {
		if (template === "registration-verify" && typeof data?.verifyUrl === "string") {
			const token = new URL(data.verifyUrl).searchParams.get("token") ?? undefined;
			captured.verifyToken = token;
		}
		return { success: true, provider: "null", status: "sent", messageId: `e2e_${Date.now()}`, retryable: false };
	});

	const { app } = await import(join(backendSrc, "index.ts"));

	// ── Route fetch through the in-process app; intercept the OpenAI boundary ──
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		// AI provider STUB: short-circuit any OpenAI HTTPS call so the AI path
		// never reaches the real provider.
		if (url.startsWith("https://api.openai.com/")) {
			// MODERATION endpoint needs a moderation-SHAPED allow response: the
			// parser (`extractOpenAiResult`) requires a `results` array and throws
			// "did not include results" otherwise. If we returned the image payload
			// here, a fail-CLOSED moderation posture (OPENAI_MODERATION_FAIL_OPEN=false)
			// would block the upload/AI path even though no provider should be
			// required. Return a clean, non-flagged result so moderation always allows.
			if (url.includes("/v1/moderations")) {
				return Promise.resolve(new Response(JSON.stringify({
					id: `modr_e2e_${Date.now()}`,
					model: "omni-moderation-latest",
					results: [{
						flagged: false,
						categories: {},
						category_scores: {},
						category_applied_input_types: {},
					}],
				}), { status: 200, headers: { "Content-Type": "application/json" } }));
			}
			// All other OpenAI calls (image edit/generate): canned image response.
			const b64 = TINY_PNG.toString("base64");
			return Promise.resolve(new Response(JSON.stringify({
				created: Date.now(),
				data: [{ b64_json: b64 }],
				output: [{ content: [{ type: "output_image", image: { b64_json: b64 } }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			}), { status: 200, headers: { "Content-Type": "application/json" } }));
		}
		if (url.startsWith(LOCAL_ORIGIN)) {
			return Promise.resolve(app.request(url.slice(LOCAL_ORIGIN.length), init)) as Promise<Response>;
		}
		return realFetch(input as any, init);
	}) as typeof fetch;

	const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	const email = `e2e-${uniq}@example.com`;
	const password = "E2eSmokePass!234";

	let accessToken = "";
	let projectId = "";
	let imageId = "";

	try {
		// ── 1. SIGNUP (REAL) ───────────────────────────────────────────────────
		{
			const res = await fetch(`${BASE}/auth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password, name: "E2E Smoke User" }),
			});
			const body = await res.json();
			assert(res.status === 201, `register expected 201, got ${res.status}: ${JSON.stringify(body)}`);
			assert(body?.tokens?.accessToken, "register did not return an access token");
			accessToken = body.tokens.accessToken;
			record("signup", "real", true, `201; user ${body.user?.id?.slice(0, 8)}…, emailVerified=${body.user?.emailVerified === true}`);
		}
		const authHeaders = () => ({ Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" });

		// ── 2. VERIFY EMAIL (REAL; delivery provider stubbed) ──────────────────
		{
			assert(captured.verifyToken, "no email-verify token captured from the (stubbed) mailer");
			const res = await fetch(`${BASE}/auth/verify-email`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: captured.verifyToken }),
			});
			const body = await res.json();
			assert(res.status === 200 && body?.verified === true, `verify-email expected 200 verified, got ${res.status}: ${JSON.stringify(body)}`);
			record("verify-email", "real", true, `200; verified=${body.verified} (token from injected mailer)`);
		}

		// ── 2b. LOGIN (REAL) — re-auth post-verification ───────────────────────
		{
			const res = await fetch(`${BASE}/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password }),
			});
			const body = await res.json();
			assert(res.status === 200 && body?.tokens?.accessToken, `login expected 200, got ${res.status}: ${JSON.stringify(body)}`);
			accessToken = body.tokens.accessToken;
			record("login", "real", true, `200; re-authenticated ${email}`);
		}

		// ── 3. CREATE WORKSPACE (POSTGRES-GATED) ───────────────────────────────
		let workspaceId = `e2e-ws-${uniq}`; // fallback id for the file-mode billing step
		// Tracks whether the real Postgres-backed workspace was created, so the
		// invite step can REQUIRE success (the caller is seeded as owner) instead
		// of laundering an owner/permission/route regression as a "gated" pass.
		let workspaceCreated = false;
		{
			const res = await fetch(`${BASE}/workspaces`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ name: "E2E Smoke Workspace" }),
			});
			const body = await res.json().catch(() => ({}));
			if (res.status === 201 && body?.workspace?.workspaceId) {
				workspaceId = body.workspace.workspaceId;
				workspaceCreated = true;
				record("create-workspace", "real", true, `201 (Postgres-backed); workspace ${workspaceId.slice(0, 8)}…`);
			} else if (res.status === 503 && body?.code === "workspace_store_unavailable") {
				record("create-workspace", "postgres-gated", true, "503 workspace_store_unavailable — documented file-mode contract; REAL with DATABASE_URL");
			} else {
				throw new Error(`create-workspace unexpected ${res.status}: ${JSON.stringify(body)}`);
			}
		}

		// ── 4. INVITE MEMBER (POSTGRES-GATED) ──────────────────────────────────
		{
			const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ email: `teammate-${uniq}@example.com`, role: "editor" }),
			});
			const body = await res.json().catch(() => ({}));
			if (workspaceCreated) {
				// Postgres-backed: createWorkspace seeded the caller as owner, so the
				// real invite path MUST succeed. A 403/404/503 here is a genuine
				// regression in owner-membership seeding, permissions, or the invite
				// route — fail loudly instead of recording a false pass.
				assert(
					res.status === 201 && body?.invite,
					`invite-member expected 201 (caller is owner of the just-created workspace), got ${res.status}: ${JSON.stringify(body)}`,
				);
				record("invite-member", "real", true, "201 (Postgres-backed); owner-seeded invite created");
			} else if (res.status === 503 && body?.code === "workspace_store_unavailable") {
				record("invite-member", "postgres-gated", true, "503 workspace_store_unavailable — documented file-mode contract; REAL with DATABASE_URL");
			} else {
				throw new Error(`invite-member unexpected ${res.status}: ${JSON.stringify(body)}`);
			}
		}

		// ── 5. CREATE PROJECT / CHAPTER (REAL) ─────────────────────────────────
		{
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({
					name: "E2E Chapter 1",
					sourceLang: "ja",
					lang: "en",
					chapterNumber: "1",
					chapterTitle: "Smoke Chapter",
					readingDirection: "rtl",
				}),
			});
			const body = await res.json();
			assert(res.status === 200 && body?.projectId, `project/new expected 200, got ${res.status}: ${JSON.stringify(body)}`);
			projectId = body.projectId;
			record("create-chapter", "real", true, `200; project ${projectId.slice(0, 8)}…`);
		}

		// ── 6. UPLOAD CHAPTER PAGE (REAL; multipart, real PNG) ─────────────────
		{
			const form = new FormData();
			form.append("images", new Blob([TINY_PNG], { type: "image/png" }), "page-001.png");
			const res = await fetch(`${BASE}/images/${projectId}/upload`, {
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}` },
				body: form,
			});
			const body = await res.json();
			assert(res.status === 200 || res.status === 201, `upload expected 200/201, got ${res.status}: ${JSON.stringify(body)}`);
			const assets = body?.assets ?? body?.pages ?? body?.images ?? body?.uploaded ?? [];
			const first = Array.isArray(assets) ? assets[0] : undefined;
			imageId = first?.imageId ?? first?.assetId ?? first?.id ?? body?.imageIds?.[0] ?? body?.imageId ?? "";
			assert(imageId, `upload returned no image id: ${JSON.stringify(body)}`);
			record("upload-chapter", "real", true, `${res.status}; page image ${imageId.slice(0, 8)}…`);
		}

		// ── 7. TRANSLATE — AI (STUBBED PROVIDER) ───────────────────────────────
		let translatedText = "[E2E] translated line";
		{
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "en",
					tier: "clean-pro",
					quality: "low",
					textLayers: ["こんにちは"],
				}),
			});
			const body = await res.json().catch(() => ({}));
			// Only two outcomes are an accepted customer journey:
			//   (a) the job is queued (2xx + a job handle), or
			//   (b) the request reached a DOCUMENTED provider/asset/credit/queue gate.
			// A 400 validation error, a 401/403 auth/access failure, or any other
			// non-provider route error means the journey did NOT accept an AI job and
			// did NOT hit a documented gate — that is a regression, so fail loudly
			// instead of laundering it as a pass on the mere presence of an `error`/
			// `code`/`reason` field.
			const DOCUMENTED_AI_GATE_STATUSES = new Set([402, 409, 422, 429, 503]);
			const DOCUMENTED_AI_GATE_IDS = new Set([
				// provider availability / kill-switch (ai-job-submission.providerUnavailable)
				"adapter_pending", "provider_disabled", "openai_images_not_configured",
				"openrouter_not_configured", "sfx_provider_unavailable",
				// asset / cost-reservation gates
				"ai_image_dimensions_unavailable",
				// queue admission / capacity (ai.ts AiJobSubmissionError)
				"ai_queue_draining", "ai_queue_capacity_exceeded",
			]);
			const gateId = (body?.code ?? body?.reason) as string | undefined;
			if (res.ok && (body?.jobId || body?.job || body?.status)) {
				translatedText = body?.result?.text ?? body?.translation ?? translatedText;
				record("translate-ai", "stubbed", true, `${res.status}; job accepted (OpenAI HTTPS boundary stubbed)`);
			} else if (DOCUMENTED_AI_GATE_STATUSES.has(res.status) && typeof gateId === "string" && DOCUMENTED_AI_GATE_IDS.has(gateId)) {
				// Deterministic, documented gate (provider/asset/credit/queue). The
				// endpoint contract is exercised; full execution needs a real provider.
				record("translate-ai", "stubbed", true, `${res.status}; documented gate "${gateId}" — contract asserted, REAL needs a configured AI provider`);
			} else {
				// Includes 400 validation, 401/403 auth/access, 404, 5xx crashes, or any
				// unrecognized gate id: a genuine regression, not an accepted journey.
				throw new Error(`translate did not queue a job nor hit a documented gate — ${res.status}: ${JSON.stringify(body)}`);
			}
		}

		// ── 8. TYPESET (REAL) — register the uploaded image as a page and place
		//        the translated text as a typeset text layer, via the real save
		//        flow (the client adds uploaded assets to project state + saves;
		//        the asset registry tracks the upload, state.pages tracks layout).
		{
			const getRes = await fetch(`${BASE}/project/${projectId}`, { headers: authHeaders() });
			const state = await getRes.json();
			assert(getRes.status === 200 && state?.projectId === projectId, `load project failed: ${getRes.status}`);
			const page = {
				imageId,
				imageName: "page-001.png",
				originalName: "page-001.png",
				textLayers: [
					{
						id: `tl-${uniq}`,
						text: translatedText,
						sourceText: "こんにちは",
						x: 10,
						y: 10,
						w: 80,
						h: 24,
						rotation: 0,
						fontSize: 14,
						alignment: "center" as const,
						visible: true,
					},
				],
				pendingAiJobs: [],
				coverRect: null,
			};
			state.pages = [page];
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ ...state, projectId }),
			});
			const saveBody = await saveRes.json();
			assert(saveRes.status === 200 && saveBody?.ok, `typeset save expected 200 ok, got ${saveRes.status}: ${JSON.stringify(saveBody)}`);
			const versionId = saveBody?.version?.id ?? saveBody?.version?.versionId ?? saveBody?.version;
			record("typeset", "real", true, `200; page registered + translated text layer placed${typeof versionId === "string" ? ` (version ${versionId.slice(0, 8)}…)` : ""}`);
		}

		// ── 9. QC (REAL) — approve the page via a review decision ──────────────
		{
			const res = await fetch(`${BASE}/project/${projectId}/review-decisions`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ pageIndex: 0, status: "approved", note: "E2E smoke QC pass" }),
			});
			const body = await res.json();
			assert(res.status === 200 && body?.decision?.status === "approved", `QC expected 200 approved, got ${res.status}: ${JSON.stringify(body)}`);
			record("qc", "real", true, "200; page 0 approved");
		}

		// ── 10. EXPORT (REAL) — enqueue the finished chapter ───────────────────
		{
			// Use the first advertised export preset so the smoke tracks the build's
			// preset enum (master/web_reader/…) instead of hard-coding one.
			const presetsRes = await fetch(`${BASE}/export/presets`, { headers: authHeaders() });
			const presets = await presetsRes.json();
			const presetId = presets?.presets?.[0]?.id ?? presets?.presets?.[0]?.preset ?? "master";
			const res = await fetch(`${BASE}/export`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ projectId, preset: presetId }),
			});
			const body = await res.json();
			assert(res.status === 202 && body?.job?.id, `export expected 202 with a job, got ${res.status}: ${JSON.stringify(body)}`);
			record("export", "real", true, `202; export job ${String(body.job.id).slice(0, 8)}… (preset ${presetId}, ${body.job.status ?? "queued"})`);
		}

		// ── 11. SUBSCRIBE / PAY — through the MOUNTED in-process endpoint ──────
		// Exercise the genuine customer endpoint `/api/billing/:workspaceId/checkout-session`
		// via `app` so this smoke actually covers route ordering (mock `billing`
		// router is mounted before `billingDodo`) and provider fall-through. The
		// default provider in this wave is "mock", so the mounted mock handler owns
		// this path and returns a labeled prototype checkout_url on the app origin.
		//
		//  • file-mode (no DATABASE_URL): `workspaceAccessStore` is null, so the
		//    mounted route returns 503 workspace_store_unavailable — the documented
		//    degraded contract (same as create-workspace/invite). REAL with Postgres.
		//  • Postgres-backed (DATABASE_URL set + workspace owned by the caller):
		//    mock provider returns 200 with a checkout_url + provider:"mock".
		{
			const res = await fetch(`${BASE}/billing/${encodeURIComponent(workspaceId)}/checkout-session`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ plan_key: "pro", billing_cycle: "monthly", addons: [] }),
			});
			const body = await res.json().catch(() => ({}));
			if (res.status === 200 && typeof body?.checkout_url === "string" && body?.session_id) {
				// Mounted mock provider path. Assert the labeled prototype URL is on
				// the app origin (NOT a real Dodo URL) and the provider is "mock".
				assert(body.provider === "mock", `expected mock provider, got ${JSON.stringify(body.provider)}`);
				record("subscribe-pay", "real", true, `200 (mounted mock provider); checkout_url=${body.checkout_url}, provider=mock (REAL Dodo needs BILLING_PROVIDER=dodo + DODO_API_KEY + Postgres)`);
			} else if (res.status === 503 && body?.code === "workspace_store_unavailable") {
				record("subscribe-pay", "postgres-gated", true, "503 workspace_store_unavailable — mounted endpoint, documented file-mode contract; REAL with DATABASE_URL");
			} else {
				throw new Error(`checkout-session unexpected ${res.status}: ${JSON.stringify(body)}`);
			}
		}

		// ── Summary ────────────────────────────────────────────────────────────
		const real = results.filter((r) => r.classification === "real" && r.ok).length;
		const stubbed = results.filter((r) => r.classification === "stubbed" && r.ok).length;
		const gated = results.filter((r) => r.classification === "postgres-gated" && r.ok).length;
		const failed = results.filter((r) => !r.ok);
		console.log("\n[w5-e2e] ───────────────────────────────────────────────");
		console.log(`[w5-e2e] PASS SUMMARY: ${results.length} steps — ${real} real, ${stubbed} stubbed, ${gated} postgres-gated.`);
		console.log(`[w5-e2e] Journey: signup -> verify-email -> create-workspace -> invite -> upload -> translate(AI) -> typeset -> QC -> export -> subscribe/pay`);
		if (failed.length > 0) {
			console.error(`[w5-e2e] ${failed.length} step(s) FAILED:`);
			for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
			process.exit(1);
		}
		console.log("[w5-e2e] ✅ Customer-journey smoke PASSED.");
	} finally {
		globalThis.fetch = realFetch;
		try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
	}
}

main().then(() => {
	// The in-process backend leaves open handles (job-queue / export-pipeline
	// poll timers) that keep the event loop alive, so exit explicitly once the
	// journey has passed rather than hanging.
	process.exit(0);
}).catch((error) => {
	console.error(`[w5-e2e] ❌ Customer-journey smoke FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
