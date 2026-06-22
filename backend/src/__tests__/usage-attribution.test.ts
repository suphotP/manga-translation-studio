import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuid } from "uuid";
import {
	PostgresUsageLedger,
	UsageLedger,
	runWithLedgerActor,
	type UsageEventKind,
	type UsageLedgerSqlClient,
	type UsagePlanConfig,
} from "../services/usage-ledger.js";
import { resolveLedgerActorUserId } from "../routes/ai.js";
import type { JWTPayload } from "../types/auth.js";

function config(overrides: Partial<UsagePlanConfig> = {}): UsagePlanConfig {
	return {
		planId: "test",
		enforced: true,
		dailyAiCreditThb: 100,
		monthlyAiCreditThb: 1000,
		dailyUploadBytes: 1000,
		monthlyUploadBytes: 5000,
		dailyExportBytes: 1000,
		monthlyExportBytes: 5000,
		maxEvents: 1000,
		...overrides,
	};
}

function withLedger(fn: (ledger: UsageLedger, projectId: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "manga-usage-attr-"));
	try {
		fn(new UsageLedger(join(dir, "usage-ledger.json")), uuid());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Minimal in-memory SQL double covering only the queries the ledger AI-credit path issues. */
class FakeAttributionSqlClient implements UsageLedgerSqlClient {
	readonly rows: Array<Record<string, any>> = [];

	async begin<T>(fn: (transaction: UsageLedgerSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();
		if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return [] as T[];
		if (normalized.startsWith("SELECT workspace_id FROM projects")) return [] as T[];
		if (normalized.startsWith("INSERT INTO workspaces")) return [] as T[];
		if (normalized.startsWith("INSERT INTO projects")) return [] as T[];
		if (normalized.startsWith("SELECT billing_plans.plan_id")) return [] as T[];
		if (normalized.startsWith("SELECT COUNT(*) AS event_count")) {
			const [workspaceId] = params;
			return [{ event_count: this.rows.filter((row) => row.workspace_id === workspaceId).length }] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM usage_events")) {
			const [jobId, projectId] = params;
			const row = [...this.rows].reverse().find((candidate) => (
				candidate.subject_id === jobId && candidate.project_id === projectId && candidate.kind === "ai_credit_reserved"
			));
			return (row ? [{ workspace_id: row.workspace_id }] : []) as T[];
		}
		if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1 AND idempotency_key = $2")) {
			const [workspaceId, idempotencyKey] = params;
			return this.rows.filter((row) => row.workspace_id === workspaceId && row.idempotency_key === idempotencyKey).slice(0, 1) as T[];
		}
		// Terminal-event lookup is distinguished by the `subject_id = $2` predicate.
		if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1 AND subject_id = $2")) {
			const [workspaceId, subjectId] = params;
			return this.rows
				.filter((row) => row.workspace_id === workspaceId && row.subject_id === subjectId)
				.filter((row) => row.kind === "ai_credit_captured" || row.kind === "ai_credit_released")
				.slice(0, 1) as T[];
		}
		// Paginated event read applies the actor filter so the test exercises real filtering.
		if (normalized.startsWith("SELECT event_id") && normalized.includes("ORDER BY created_at DESC, event_id DESC")) {
			let rows = this.rows.filter((row) => row.workspace_id === params[0]);
			let paramIndex = 1;
			if (normalized.includes("kind = $")) paramIndex += 1;
			if (normalized.includes("project_id = $")) paramIndex += 1;
			if (normalized.includes("subject_id = $")) paramIndex += 1;
			if (normalized.includes("actor_user_id = $")) {
				rows = rows.filter((row) => row.actor_user_id === params[paramIndex]);
				paramIndex += 1;
			}
			const limit = Number(params[paramIndex]);
			return rows.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}
		// Summary-window load (used by settle to resolve the reservation state).
		if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1")) {
			const [workspaceId] = params;
			return this.rows.filter((row) => row.workspace_id === workspaceId) as T[];
		}
		if (normalized.startsWith("INSERT INTO usage_events")) {
			const [eventId, workspaceId, projectId, kind, subjectId, idempotencyKey, amountBytes, amountThb, amountUnits, metadata, createdAt, actorUserId] = params;
			const existing = idempotencyKey ? this.rows.find((row) => row.workspace_id === workspaceId && row.idempotency_key === idempotencyKey) : undefined;
			if (existing) return [existing] as T[];
			const row = {
				event_id: eventId,
				workspace_id: workspaceId,
				project_id: projectId,
				kind: kind as UsageEventKind,
				subject_id: subjectId,
				actor_user_id: actorUserId ?? null,
				idempotency_key: idempotencyKey,
				amount_bytes: amountBytes,
				amount_thb: amountThb,
				amount_units: amountUnits,
				metadata: typeof metadata === "string" ? JSON.parse(metadata as string) : metadata,
				created_at: new Date(Number(createdAt)),
			};
			this.rows.push(row);
			return [row] as T[];
		}
		if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return [] as T[];
		throw new Error(`Unexpected SQL in fake attribution client: ${normalized}`);
	}
}

/** Fake Hono context exposing only what the route helper reads. */
function fakeContext(options: { user?: JWTPayload; headers?: Record<string, string> } = {}) {
	const headers = options.headers ?? {};
	return {
		get: (key: string) => (key === "user" ? options.user : undefined),
		req: { header: (name: string) => headers[name.toLowerCase()] },
	};
}

const editorUser: JWTPayload = { userId: "user-editor", email: "editor@example.com", role: "editor" };

describe("usage ledger actor attribution (in-memory)", () => {
	test("records the session actor on AI credit reservation", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			const { event } = runWithLedgerActor("user-alpha", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-attr-1",
				amountThb: 4.25,
				now,
			}, config()));

			expect(event.kind).toBe("ai_credit_reserved");
			expect(event.actorUserId).toBe("user-alpha");
		});
	});

	test("capture inherits the reserving actor even without an active session context", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			runWithLedgerActor("user-beta", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-attr-2",
				amountThb: 8,
				now,
			}, config()));

			// Settlement happens later in the queue worker — outside any request actor context.
			const captured = ledger.settleAiCredit({
				projectId,
				jobId: "job-attr-2",
				status: "captured",
				now: now + 1000,
			}, config());

			expect(captured?.kind).toBe("ai_credit_captured");
			expect(captured?.actorUserId).toBe("user-beta");
		});
	});

	test("release inherits the reserving actor", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			runWithLedgerActor("user-gamma", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-attr-3",
				amountThb: 5,
				now,
			}, config()));

			const released = ledger.settleAiCredit({
				projectId,
				jobId: "job-attr-3",
				status: "released",
				now: now + 500,
			}, config());

			expect(released?.kind).toBe("ai_credit_released");
			expect(released?.actorUserId).toBe("user-gamma");
		});
	});

	test("filters listed events by actor", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			runWithLedgerActor("user-one", () => ledger.reserveAiCredit({ projectId, jobId: "job-one", amountThb: 1, idempotencyKey: "k1", now }, config()));
			runWithLedgerActor("user-two", () => ledger.reserveAiCredit({ projectId, jobId: "job-two", amountThb: 1, idempotencyKey: "k2", now }, config()));

			const page = ledger.listEventPage(projectId, { actorUserId: "user-two" });
			expect(page.events).toHaveLength(1);
			expect(page.events[0]?.subjectId).toBe("job-two");
		});
	});

	test("leaves usage unattributed when there is no authenticated actor", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			const { event } = ledger.reserveAiCredit({ projectId, jobId: "job-anon", amountThb: 2, now }, config());
			expect(event.actorUserId).toBeUndefined();
		});
	});

	test("an explicit input actor never overrides a stricter design — context still applies when omitted", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			// Explicit actor wins when provided (used by trusted internal callers).
			const explicit = runWithLedgerActor("ctx-user", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-explicit",
				amountThb: 1,
				actorUserId: "explicit-user",
				now,
			}, config()));
			expect(explicit.event.actorUserId).toBe("explicit-user");
		});
	});
});

describe("usage ledger actor attribution (postgres)", () => {
	test("persists actor_user_id on reserve and inherits it on capture", async () => {
		const client = new FakeAttributionSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const projectId = uuid();
		const now = Date.parse("2026-05-29T12:00:00.000Z");

		const { event } = await runWithLedgerActor("user-pg", () => ledger.reserveAiCredit({
			workspaceId: "workspace-pg",
			projectId,
			jobId: "job-pg-1",
			amountThb: 6,
			now,
		}, config()));
		expect(event.actorUserId).toBe("user-pg");

		const captured = await ledger.settleAiCredit({
			workspaceId: "workspace-pg",
			projectId,
			jobId: "job-pg-1",
			status: "captured",
			now: now + 1000,
		}, config());
		expect(captured?.actorUserId).toBe("user-pg");

		const reservedRow = client.rows.find((row) => row.kind === "ai_credit_reserved");
		expect(reservedRow?.actor_user_id).toBe("user-pg");
	});

	test("filters the event page query by actor_user_id", async () => {
		const client = new FakeAttributionSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const projectId = uuid();
		const now = Date.parse("2026-05-29T12:00:00.000Z");

		await runWithLedgerActor("user-x", () => ledger.reserveAiCredit({ workspaceId: "ws", projectId, jobId: "jx", amountThb: 1, idempotencyKey: "kx", now }, config()));
		await runWithLedgerActor("user-y", () => ledger.reserveAiCredit({ workspaceId: "ws", projectId, jobId: "jy", amountThb: 1, idempotencyKey: "ky", now }, config()));
		const page = await ledger.listEventPage("ws", { actorUserId: "user-x" });
		expect(page.events).toHaveLength(1);
		expect(page.events[0]?.actorUserId).toBe("user-x");
	});
});

describe("AI route actor resolution (spoof-proof)", () => {
	test("derives the actor from the authenticated session", () => {
		expect(resolveLedgerActorUserId(fakeContext({ user: editorUser }))).toBe("user-editor");
	});

	test("ignores client-supplied actor/user headers (cannot be spoofed)", () => {
		const ctx = fakeContext({
			user: editorUser,
			headers: {
				"x-actor-user-id": "attacker",
				"x-user-id": "attacker",
				"x-workspace-id": "attacker-ws",
			},
		});
		// The header values must be completely ignored; only the session identity counts.
		expect(resolveLedgerActorUserId(ctx)).toBe("user-editor");
	});

	test("returns undefined for anonymous requests even when a spoofed header is present", () => {
		const ctx = fakeContext({ headers: { "x-actor-user-id": "attacker" } });
		expect(resolveLedgerActorUserId(ctx)).toBeUndefined();
	});

	test("ledger write driven by a spoofed-header request attributes to the session, not the header", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			const ctx = fakeContext({ user: editorUser, headers: { "x-actor-user-id": "attacker" } });
			const { event } = runWithLedgerActor(resolveLedgerActorUserId(ctx), () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-spoof",
				amountThb: 3,
				now,
			}, config()));
			expect(event.actorUserId).toBe("user-editor");
			expect(event.actorUserId).not.toBe("attacker");
		});
	});
});

describe("cross-actor settlement race (reservation actor wins over ambient context)", () => {
	test("A's reserved job settles as A even when B wakes the queue (in-memory)", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			// User A reserves inside A's request/ALS context.
			runWithLedgerActor("user-a", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-a",
				amountThb: 5,
				now,
			}, config()));

			// User B submits their own job; the unawaited processNext() B spawns
			// inherits B's ALS context and claims A's OLDER pending job, settling it.
			const captured = runWithLedgerActor("user-b", () => ledger.settleAiCredit({
				projectId,
				jobId: "job-a",
				status: "captured",
				now: now + 1000,
			}, config()));

			// The capture for A's job must be attributed to A, never to B.
			expect(captured?.kind).toBe("ai_credit_captured");
			expect(captured?.actorUserId).toBe("user-a");
			expect(captured?.actorUserId).not.toBe("user-b");
		});
	});

	test("A's reserved job releases as A even when B wakes the queue (in-memory)", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			runWithLedgerActor("user-a", () => ledger.reserveAiCredit({
				projectId,
				jobId: "job-a-rel",
				amountThb: 5,
				now,
			}, config()));

			const released = runWithLedgerActor("user-b", () => ledger.settleAiCredit({
				projectId,
				jobId: "job-a-rel",
				status: "released",
				now: now + 1000,
			}, config()));

			expect(released?.kind).toBe("ai_credit_released");
			expect(released?.actorUserId).toBe("user-a");
		});
	});

	test("ambient context still attributes settlement when the reservation has no recorded actor (in-memory)", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			// Reservation made anonymously (no actor recorded).
			ledger.reserveAiCredit({ projectId, jobId: "job-anon-settle", amountThb: 5, now }, config());

			// A later authenticated worker settles it; with no reservation actor to
			// honor, the ambient session context is used as a best-effort fallback.
			const captured = runWithLedgerActor("user-worker", () => ledger.settleAiCredit({
				projectId,
				jobId: "job-anon-settle",
				status: "captured",
				now: now + 1000,
			}, config()));

			expect(captured?.actorUserId).toBe("user-worker");
		});
	});

	test("explicit settle actor still overrides both reservation and ambient context (in-memory)", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			runWithLedgerActor("user-a", () => ledger.reserveAiCredit({ projectId, jobId: "job-explicit-settle", amountThb: 5, now }, config()));

			const captured = runWithLedgerActor("user-b", () => ledger.settleAiCredit({
				projectId,
				jobId: "job-explicit-settle",
				status: "captured",
				actorUserId: "user-explicit",
				now: now + 1000,
			}, config()));

			expect(captured?.actorUserId).toBe("user-explicit");
		});
	});

	test("A's reserved job settles as A even when B wakes the queue (postgres)", async () => {
		const client = new FakeAttributionSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const projectId = uuid();
		const now = Date.parse("2026-05-29T12:00:00.000Z");

		await runWithLedgerActor("user-a", () => ledger.reserveAiCredit({
			workspaceId: "ws-race",
			projectId,
			jobId: "job-pg-race",
			amountThb: 7,
			now,
		}, config()));

		const captured = await runWithLedgerActor("user-b", () => ledger.settleAiCredit({
			workspaceId: "ws-race",
			projectId,
			jobId: "job-pg-race",
			status: "captured",
			now: now + 1000,
		}, config()));

		expect(captured?.kind).toBe("ai_credit_captured");
		expect(captured?.actorUserId).toBe("user-a");
		expect(captured?.actorUserId).not.toBe("user-b");
	});
});

describe("GET /api/usage/:projectId/events forwards the actorUserId filter", () => {
	// Permissive plan so seeding reservations is not rejected by the env-derived quota.
	const seedConfig = config({ dailyAiCreditThb: 1_000_000, monthlyAiCreditThb: 1_000_000 });
	let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let usageLedgerSingleton: UsageLedger;
	let projectsDir: string;
	let projectId: string;

	beforeAll(async () => {
		// The usage events route reads from the singleton ledger + the project
		// state file; both resolve against the per-process test DATA_DIR. No
		// worker/provider/auth-hardening setup is required for this path.
		const [{ usage }, ledgerModule, config] = await Promise.all([
			import("../routes/usage.js"),
			import("../services/usage-ledger.js"),
			import("../config.js"),
		]);
		const { Hono } = await import("hono");
		app = new Hono().route("/", usage);
		usageLedgerSingleton = ledgerModule.usageLedger as unknown as UsageLedger;
		projectsDir = config.PROJECTS_DIR;
		projectId = uuid();

		// Anonymous project (no userId) so optionalAuth permits the read.
		mkdirSync(join(projectsDir, projectId), { recursive: true });
		writeFileSync(
			join(projectsDir, projectId, "state.json"),
			JSON.stringify({ projectId, name: "Usage Filter Project", targetLang: "th", pages: [] }),
		);

		const now = Date.parse("2026-05-29T10:00:00.000Z");
		runWithLedgerActor("user-a", () => usageLedgerSingleton.reserveAiCredit({ projectId, jobId: "events-job-a", amountThb: 1, idempotencyKey: `evt-a-${projectId}`, now }, seedConfig));
		runWithLedgerActor("user-b", () => usageLedgerSingleton.reserveAiCredit({ projectId, jobId: "events-job-b", amountThb: 1, idempotencyKey: `evt-b-${projectId}`, now }, seedConfig));
	});

	afterAll(() => {
		if (projectsDir && projectId) rmSync(join(projectsDir, projectId), { recursive: true, force: true });
	});

	test("returns all actors when no filter is supplied", async () => {
		const res = await app.request(`/${projectId}/events`);
		expect(res.status).toBe(200);
		const body = await res.json();
		const actors = new Set(body.events.map((event: any) => event.actorUserId));
		expect(actors.has("user-a")).toBe(true);
		expect(actors.has("user-b")).toBe(true);
	});

	test("restricts the page to the requested actor (no longer silently ignored)", async () => {
		const res = await app.request(`/${projectId}/events?actorUserId=user-b`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events.length).toBeGreaterThan(0);
		expect(body.events.every((event: any) => event.actorUserId === "user-b")).toBe(true);
		expect(body.events.some((event: any) => event.subjectId === "events-job-b")).toBe(true);
		expect(body.events.some((event: any) => event.actorUserId === "user-a")).toBe(false);
	});

	test("rejects an over-long actorUserId", async () => {
		const res = await app.request(`/${projectId}/events?actorUserId=${"x".repeat(201)}`);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("invalid_actor_user_id");
	});
});

describe("marker rerun binds the session actor around AI submission", () => {
	test("a rerun reservation made within the resolved-actor context attributes to the session user", () => {
		// The rerun handler wraps submitAiJob in
		// `runWithLedgerActor(resolveLedgerActorUserId(c), ...)`; submitAiJob's
		// internal reserveAiCredit omits an explicit actor and therefore inherits
		// this context. This asserts that contract end-to-end at the ledger level.
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-29T10:00:00.000Z");
			const ctx = fakeContext({ user: editorUser });
			const { event } = runWithLedgerActor(resolveLedgerActorUserId(ctx), () => ledger.reserveAiCredit({
				projectId,
				jobId: "marker-rerun-job",
				amountThb: 2,
				now,
			}, config()));
			expect(event.kind).toBe("ai_credit_reserved");
			expect(event.actorUserId).toBe("user-editor");
		});
	});

	test("the rerun route source wraps submitAiJob with runWithLedgerActor and passes the actor (guards against unwrapping)", () => {
		// Lock in finding #2's fix: the marker-rerun handler must bind the actor
		// the same way /api/ai/translate does. A regression that drops the wrapper
		// would leave the reservation's actorUserId empty. Per W2.11 finding #6 the
		// handler must ALSO pass actorUserId into submitAiJob so the new
		// personal/shareable credit debit runs on authenticated reruns.
		const source = readFileSync(join(import.meta.dir, "..", "routes", "project.ts"), "utf8");
		const rerunHandlerStart = source.indexOf('ai-markers/:markerId/rerun');
		expect(rerunHandlerStart).toBeGreaterThan(-1);
		const rerunHandler = source.slice(rerunHandlerStart, rerunHandlerStart + 4000);
		expect(rerunHandler).toContain("runWithLedgerActor(rerunActorUserId, () => submitAiJob(");
		expect(rerunHandler).toContain("const rerunActorUserId = resolveLedgerActorUserId(c);");
		expect(rerunHandler).toContain("{ idempotencyKey, actorUserId: rerunActorUserId }");
	});
});
