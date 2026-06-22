import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuid } from "uuid";
import {
	PostgresUsageLedger,
	UsageLedger,
	UsageQuotaExceededError,
	UsageIdempotencyKindMismatchError,
	WORKSPACE_EVENT_COUNT_CAP,
	type UsageEventKind,
	type UsageLedgerSqlClient,
	type UsagePlanConfig,
} from "../services/usage-ledger.js";

function config(overrides: Partial<UsagePlanConfig> = {}): UsagePlanConfig {
	return {
		planId: "test",
		enforced: true,
		dailyAiCreditThb: 10,
		monthlyAiCreditThb: 100,
		dailyUploadBytes: 1000,
		monthlyUploadBytes: 5000,
		dailyExportBytes: 1000,
		monthlyExportBytes: 5000,
		maxEvents: 1000,
		...overrides,
	};
}

function withLedger(fn: (ledger: UsageLedger, projectId: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "manga-usage-ledger-"));
	try {
		const ledger = new UsageLedger(join(dir, "usage-ledger.json"));
		fn(ledger, uuid());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

class FakeUsageLedgerSqlClient implements UsageLedgerSqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	readonly rows: Array<Record<string, any>> = [];
	readonly locks: string[] = [];
	readonly workspaces = new Set<string>();
	readonly projects = new Map<string, string>();
	readonly deletedProjects = new Set<string>();
	readonly projectMetadata = new Map<string, Record<string, unknown>>();
	readonly workspacePlanConfigs = new Map<string, {
		planId: string;
		monthlyAiCredits?: number;
		planActive?: boolean;
		addonAiCredits?: number;
		addonQuantity?: number;
		addonBillingInterval?: "monthly" | "one_time";
		addonCreatedAt?: string;
		addonExpiresAt?: string;
		addonProductActive?: boolean;
	}>();

	async begin<T>(fn: (transaction: UsageLedgerSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const normalized = query.replace(/\s+/g, " ").trim();
		if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
			this.locks.push(String(params[0]));
			return [] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM projects")) {
			const [projectId] = params;
			const projectKey = String(projectId);
			const workspaceId = this.deletedProjects.has(projectKey) ? undefined : this.projects.get(projectKey);
			return (workspaceId ? [{ workspace_id: workspaceId }] : []) as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM usage_events")) {
			const [jobId, projectId] = params;
			const row = [...this.rows]
				.reverse()
				.find((candidate) => (
					candidate.subject_id === jobId
					&& candidate.project_id === projectId
					&& candidate.kind === "ai_credit_reserved"
			));
			return (row ? [{ workspace_id: row.workspace_id }] : []) as T[];
		}
		if (normalized.startsWith("SELECT billing_plans.plan_id")) {
			const [workspaceId, summaryTimeParam, monthlyStartParam, nextMonthlyStartParam] = params;
			const config = this.workspacePlanConfigs.get(String(workspaceId));
			if (!config) return [] as T[];
			const summaryTime = Date.parse(String(summaryTimeParam));
			const monthlyStart = Date.parse(String(monthlyStartParam));
			const nextMonthlyStart = Date.parse(String(nextMonthlyStartParam));
			const grantCreatedAt = Date.parse(config.addonCreatedAt ?? String(monthlyStartParam));
			const grantExpiresAt = config.addonExpiresAt ? Date.parse(config.addonExpiresAt) : undefined;
			const grantStartedAtSummary = grantCreatedAt <= summaryTime;
			const grantActiveAtSummary = grantExpiresAt === undefined || grantExpiresAt > summaryTime;
			const interval = config.addonBillingInterval ?? "monthly";
			const grantAppliesToSummaryMonth = interval === "monthly" || (grantCreatedAt >= monthlyStart && grantCreatedAt < nextMonthlyStart);
			const addonAiCredits = grantStartedAtSummary && grantActiveAtSummary && grantAppliesToSummaryMonth
				? (config.addonAiCredits ?? 0) * (config.addonQuantity ?? 1)
				: 0;
			const planActive = config.planActive ?? true;
			return [{
				plan_id: planActive ? config.planId : null,
				monthly_ai_credits: planActive ? config.monthlyAiCredits : null,
				addon_ai_credits: addonAiCredits,
			}] as T[];
		}
		if (normalized.startsWith("SELECT COUNT(*) AS event_count")) {
			// The count is bounded by an inner `LIMIT $2` subquery (see
			// countWorkspaceEvents): mirror the cap so the fake reports the same
			// "100000+" ceiling semantics as Postgres would. When no cap param is
			// present (older callers) fall back to the unbounded count.
			const [workspaceId, cap] = params;
			const matching = this.rows.filter((row) => row.workspace_id === workspaceId).length;
			const limited = typeof cap === "number" && Number.isFinite(cap) ? Math.min(matching, cap) : matching;
			return [{ event_count: limited }] as T[];
		}
		if (normalized.startsWith("INSERT INTO workspaces")) {
			this.workspaces.add(String(params[0]));
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO projects")) {
			if (!this.projects.has(String(params[0]))) {
				this.projects.set(String(params[0]), String(params[1]));
				if (normalized.includes("deleted_at")) this.deletedProjects.add(String(params[0]));
				if (params[3]) {
					this.projectMetadata.set(String(params[0]), typeof params[3] === "string" ? JSON.parse(params[3]) : params[3] as Record<string, unknown>);
				}
			}
			return [] as T[];
		}
			if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1 AND idempotency_key = $2")) {
				const [workspaceId, idempotencyKey] = params;
				return this.rows
					.filter((row) => row.workspace_id === workspaceId && row.idempotency_key === idempotencyKey)
					.slice(0, 1) as T[];
			}
			if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1 AND subject_id = $2") && normalized.includes("kind IN ('ai_credit_captured', 'ai_credit_released')")) {
				const [workspaceId, subjectId] = params;
				return this.rows
					.filter((row) => row.workspace_id === workspaceId && row.subject_id === subjectId)
					.filter((row) => row.kind === "ai_credit_captured" || row.kind === "ai_credit_released")
					.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || String(b.event_id).localeCompare(String(a.event_id)))
					.slice(0, 1) as T[];
			}
			if (normalized.startsWith("SELECT event_id") && normalized.includes("ORDER BY created_at DESC, event_id DESC")) {
				const workspaceId = String(params[0]);
				let rows = this.rows.filter((row) => row.workspace_id === workspaceId);
			let paramIndex = 1;
			if (normalized.includes("kind = $")) {
				rows = rows.filter((row) => row.kind === params[paramIndex]);
				paramIndex += 1;
			}
			if (normalized.includes("project_id = $")) {
				rows = rows.filter((row) => row.project_id === params[paramIndex]);
				paramIndex += 1;
			}
			if (normalized.includes("subject_id = $")) {
				rows = rows.filter((row) => row.subject_id === params[paramIndex]);
				paramIndex += 1;
			}
			if (normalized.includes("created_at < $")) {
				const cursorCreatedAt = new Date(String(params[paramIndex])).getTime();
				const cursorEventId = String(params[paramIndex + 1]);
				rows = rows.filter((row) => {
					const createdAt = new Date(row.created_at).getTime();
					return createdAt < cursorCreatedAt || (createdAt === cursorCreatedAt && row.event_id < cursorEventId);
				});
				paramIndex += 2;
			}
			const limit = Number(params[paramIndex]);
			return rows
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || String(b.event_id).localeCompare(String(a.event_id)))
				.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}
		if (normalized.startsWith("SELECT event_id") && normalized.includes("WHERE workspace_id = $1")) {
			const [workspaceId, sinceMs, limit] = params;
			const minCreatedAt = typeof sinceMs === "number" ? sinceMs : 0;
			const rows = this.rows
				.filter((row) => row.workspace_id === workspaceId)
				.filter((row) => {
					if (new Date(row.created_at).getTime() >= minCreatedAt) return true;
					if (row.kind !== "ai_credit_reserved") return false;
					return !this.rows.some((terminal) => (
						terminal.workspace_id === row.workspace_id
						&& terminal.subject_id === row.subject_id
						&& (terminal.kind === "ai_credit_captured" || terminal.kind === "ai_credit_released")
					));
				})
				.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
			return (limit ? rows.slice(0, Number(limit)) : rows) as T[];
		}
		if (normalized.startsWith("INSERT INTO usage_events")) {
			const [
				eventId,
				workspaceId,
				projectId,
				kind,
				subjectId,
				idempotencyKey,
				amountBytes,
				amountThb,
				amountUnits,
				metadata,
				createdAt,
			] = params;
			const existing = idempotencyKey
				? this.rows.find((row) => row.workspace_id === workspaceId && row.idempotency_key === idempotencyKey)
				: undefined;
			if (existing) return [existing] as T[];
			const row = {
				event_id: eventId,
				workspace_id: workspaceId,
				project_id: projectId,
				kind: kind as UsageEventKind,
				subject_id: subjectId,
				idempotency_key: idempotencyKey,
				amount_bytes: amountBytes,
				amount_thb: amountThb,
				amount_units: amountUnits,
				metadata: typeof metadata === "string" ? JSON.parse(metadata) : metadata,
				created_at: new Date(Number(createdAt)),
			};
			this.rows.push(row);
			return [row] as T[];
		}
		// Reconcile a ticket-AI-tokens row to a corrected amount (P1). Targets the
		// event by PK and updates amount_thb / amount_units in place.
		if (normalized.startsWith("UPDATE usage_events SET amount_thb = $2, amount_units = $3")) {
			const [eventId, amountThb, amountUnits] = params;
			const row = this.rows.find((candidate) => candidate.event_id === eventId);
			if (!row) return [] as T[];
			row.amount_thb = amountThb;
			row.amount_units = amountUnits;
			return [row] as T[];
		}
		// Global (cross-tenant) support-agent THB spend since startMs (rank7). This
		// is intentionally NOT workspace-scoped — it sums every ticket_ai_tokens row.
		if (normalized.startsWith("SELECT COALESCE(SUM(amount_thb), 0) AS total_thb") && normalized.includes("kind = 'ticket_ai_tokens'")) {
			const startMs = Number(params[0]);
			const total = this.rows
				.filter((row) => row.kind === "ticket_ai_tokens" && new Date(row.created_at).getTime() >= startMs)
				.reduce((sum, row) => sum + Number(row.amount_thb ?? 0), 0);
			return [{ total_thb: total }] as T[];
		}
		if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return [] as T[];
		throw new Error(`Unexpected SQL in fake usage ledger client: ${normalized}`);
	}
}

describe("UsageLedger", () => {
	test("reserves AI credit idempotently and settles active exposure", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			const reserve = ledger.reserveAiCredit({
				projectId,
				jobId: "job-1",
				amountThb: 4.25,
				idempotencyKey: "same-ai-reserve",
				now,
			}, config());
			const duplicate = ledger.reserveAiCredit({
				projectId,
				jobId: "job-duplicate",
				amountThb: 4.25,
				idempotencyKey: "same-ai-reserve",
				now,
			}, config());

			expect(duplicate.event.eventId).toBe(reserve.event.eventId);
			expect(ledger.summarize(projectId, projectId, now, config()).daily.aiActiveReservedThb).toBe(4.25);

			ledger.settleAiCredit({
				projectId,
				jobId: "job-1",
				status: "captured",
				now: now + 1000,
			}, config());
			const summary = ledger.summarize(projectId, projectId, now + 1000, config());

			expect(summary.daily.aiActiveReservedThb).toBe(0);
			expect(summary.daily.aiCapturedThb).toBe(4.25);
			expect(summary.daily.aiCommittedThb).toBe(4.25);
		});
	});

	test("captures only actual estimated AI credit and frees unused reserve", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			ledger.reserveAiCredit({
				projectId,
				jobId: "job-capture-estimate",
				amountThb: 10,
				now,
			}, config());

			ledger.settleAiCredit({
				projectId,
				jobId: "job-capture-estimate",
				status: "captured",
				amountThb: 6.25,
				now: now + 1000,
			}, config());
			const summary = ledger.summarize(projectId, projectId, now + 1000, config());

			expect(summary.daily.aiActiveReservedThb).toBe(0);
			expect(summary.daily.aiCapturedThb).toBe(6.25);
			expect(summary.daily.aiCommittedThb).toBe(6.25);
		});
	});

	test("blocks AI reservations that exceed the daily plan allowance", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			ledger.reserveAiCredit({
				projectId,
				jobId: "job-1",
				amountThb: 8,
				now,
			}, config({ dailyAiCreditThb: 10 }));

			expect(() => ledger.reserveAiCredit({
				projectId,
				jobId: "job-2",
				amountThb: 3,
				now,
			}, config({ dailyAiCreditThb: 10 }))).toThrow(UsageQuotaExceededError);
		});
	});

	test("records upload bytes with daily and monthly plan windows", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			ledger.recordUpload({
				projectId,
				subjectId: "upload-1",
				bytes: 400,
				now,
			}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 2000 }));
			ledger.recordUpload({
				projectId,
				subjectId: "upload-2",
				bytes: 300,
				now,
			}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 2000 }));

			const summary = ledger.summarize(projectId, projectId, now, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 2000 }));
			expect(summary.daily.uploadBytes).toBe(700);
			expect(summary.daily.remaining.uploadBytes).toBe(300);

			expect(() => ledger.recordUpload({
				projectId,
				subjectId: "upload-3",
				bytes: 400,
				now,
			}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 2000 }))).toThrow(UsageQuotaExceededError);
		});
	});

	test("does not keep in-memory upload usage when file persistence fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "manga-usage-ledger-persist-fail-"));
		try {
			const blockedParent = join(dir, "not-a-dir");
			writeFileSync(blockedParent, "file");
			const persistPath = join(blockedParent, "usage-ledger.json");
			const ledger = new UsageLedger(persistPath);
			const projectId = uuid();
			const now = Date.parse("2026-05-13T10:00:00.000Z");

			expect(() => ledger.recordUpload({
				projectId,
				subjectId: "upload-1",
				bytes: 400,
				now,
			}, config())).toThrow();

			expect(ledger.listEvents()).toEqual([]);
			expect(ledger.summarize(projectId, projectId, now, config()).daily.uploadBytes).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("records export bytes separately from upload quotas", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			ledger.recordUpload({
				projectId,
				subjectId: "upload-1",
				bytes: 900,
				now,
			}, config({ dailyUploadBytes: 1000, dailyExportBytes: 600 }));
			ledger.recordExport({
				projectId,
				subjectId: "export-1",
				bytes: 500,
				pageIndexes: [0, 1],
					pageCount: 2,
					filename: "chapter.zip",
					exportKind: "batch-zip",
					targetProfile: "public-export",
					now,
				}, config({ dailyUploadBytes: 1000, dailyExportBytes: 600 }));

			const summary = ledger.summarize(projectId, projectId, now, config({ dailyUploadBytes: 1000, dailyExportBytes: 600 }));
			expect(summary.daily.uploadBytes).toBe(900);
			expect(summary.daily.exportBytes).toBe(500);
				expect(summary.daily.remaining.uploadBytes).toBe(100);
				expect(summary.daily.remaining.exportBytes).toBe(100);
				expect(ledger.listEvents().find((event) => event.subjectId === "export-1")?.metadata?.targetProfile).toBe("public-export");

				expect(() => ledger.recordExport({
				projectId,
				subjectId: "export-2",
				bytes: 150,
				now,
			}, config({ dailyUploadBytes: 1000, dailyExportBytes: 600 }))).toThrow(UsageQuotaExceededError);
		});
	});

	test("rejects an idempotency key reused for a different usage kind (kind-scoped dedup)", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			const cfg = config({ dailyExportBytes: 100000, monthlyExportBytes: 100000, dailyAiCreditThb: 1000, monthlyAiCreditThb: 1000 });
			// First record an AI reservation under a shared idempotency key.
			ledger.reserveAiCredit({
				projectId,
				jobId: "shared-key-job",
				amountThb: 1,
				idempotencyKey: "shared-key",
				now,
			}, cfg);
			// A later export that reuses the SAME key must NOT silently return the AI
			// reservation event (which would record 0 export bytes) — it must reject.
			expect(() => ledger.recordExport({
				projectId,
				subjectId: "export-collide",
				bytes: 5000,
				idempotencyKey: "shared-key",
				now,
			}, cfg)).toThrow(UsageIdempotencyKindMismatchError);
			// The export bytes were never silently swallowed: the meter is still 0.
			expect(ledger.summarize(projectId, projectId, now, cfg).daily.exportBytes).toBe(0);
			// Same-kind reuse still dedupes correctly.
			const first = ledger.recordExport({ projectId, subjectId: "export-ok", bytes: 500, idempotencyKey: "export-key", now }, cfg);
			const second = ledger.recordExport({ projectId, subjectId: "export-ok-2", bytes: 999, idempotencyKey: "export-key", now }, cfg);
			expect(second.event.eventId).toBe(first.event.eventId);
			expect(ledger.summarize(projectId, projectId, now, cfg).daily.exportBytes).toBe(500);
		});
	});

	test("recordExport with enforce:false records the overage instead of throwing on quota", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			const cfg = config({ dailyExportBytes: 100, monthlyExportBytes: 100 });
			// A normal record over the (100-byte) export quota throws.
			expect(() => ledger.recordExport({ projectId, subjectId: "over-1", bytes: 5000, now }, cfg)).toThrow(UsageQuotaExceededError);
			expect(ledger.summarize(projectId, projectId, now, cfg).daily.exportBytes).toBe(0);
			// With enforce:false (the post-commit pipeline path) the SAME over-quota
			// bytes are recorded as an overage rather than dropped.
			const result = ledger.recordExport({ projectId, subjectId: "over-2", bytes: 5000, enforce: false, now }, cfg);
			expect(result.event.bytes).toBe(5000);
			expect(ledger.summarize(projectId, projectId, now, cfg).daily.exportBytes).toBe(5000);
			// enforce:false does NOT weaken dedup: a re-record on the same key is idempotent.
			const again = ledger.recordExport({ projectId, subjectId: "over-2b", bytes: 5000, idempotencyKey: `export-bytes:over-2`, enforce: false, now }, cfg);
			expect(again.event.eventId).toBe(result.event.eventId);
			expect(ledger.summarize(projectId, projectId, now, cfg).daily.exportBytes).toBe(5000);
		});
	});

	test("lists usage events with bounded cursors and filters", () => {
		withLedger((ledger, projectId) => {
			const now = Date.parse("2026-05-13T10:00:00.000Z");
			ledger.recordUpload({
				projectId,
				subjectId: "upload-1",
				bytes: 100,
				now,
			}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
			ledger.recordExport({
				projectId,
				subjectId: "export-1",
				bytes: 200,
				now: now + 1000,
			}, config({ dailyExportBytes: 1000, monthlyExportBytes: 5000 }));
			ledger.reserveAiCredit({
				projectId,
				jobId: "job-1",
				amountThb: 1.25,
				now: now + 2000,
			}, config({ dailyAiCreditThb: 10, monthlyAiCreditThb: 100 }));

			const first = ledger.listEventPage(projectId, { limit: 2 });
			expect(first.events.map((event) => event.subjectId)).toEqual(["job-1", "export-1"]);
			expect(first.nextCursor).toBeDefined();

			const second = ledger.listEventPage(projectId, { limit: 2, cursor: first.nextCursor });
			expect(second.events.map((event) => event.subjectId)).toEqual(["upload-1"]);
			expect(second.nextCursor).toBeUndefined();

			const uploads = ledger.listEventPage(projectId, { kind: "upload_bytes_recorded" });
			expect(uploads.events.map((event) => event.subjectId)).toEqual(["upload-1"]);
		});
	});

	test("loads snapshots written with a UTF-8 BOM", () => {
		const dir = mkdtempSync(join(tmpdir(), "manga-usage-ledger-bom-"));
		const persistPath = join(dir, "usage-ledger.json");
		try {
			writeFileSync(persistPath, `\uFEFF${JSON.stringify({
				events: [{
					eventId: "event-1",
					workspaceId: "workspace-1",
					projectId: "project-1",
					kind: "upload_bytes_recorded",
					subjectId: "upload-1",
					bytes: 256,
					createdAt: Date.parse("2026-05-13T10:00:00.000Z"),
				}],
			})}`);

			const ledger = new UsageLedger(persistPath);
			expect(ledger.listEvents()).toHaveLength(1);
			expect(ledger.summarize("workspace-1", "project-1", Date.parse("2026-05-13T10:05:00.000Z"), config()).daily.uploadBytes).toBe(256);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("PostgresUsageLedger", () => {
	test("locks per workspace and scopes idempotency keys to that workspace", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		const reserve = await ledger.reserveAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-1",
			amountThb: 4.25,
			idempotencyKey: "same-ai-reserve",
			now,
		}, config());
		const duplicate = await ledger.reserveAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-duplicate",
			amountThb: 4.25,
			idempotencyKey: "same-ai-reserve",
			now,
		}, config());
		const otherWorkspace = await ledger.reserveAiCredit({
			workspaceId: "workspace-2",
			projectId: "project-2",
			jobId: "job-2",
			amountThb: 4.25,
			idempotencyKey: "same-ai-reserve",
			now,
		}, config());

		expect(client.locks).toContain("usage-ledger:workspace-1");
		expect(client.locks).toContain("usage-ledger:workspace-2");
		expect(duplicate.event.eventId).toBe(reserve.event.eventId);
		expect(otherWorkspace.event.eventId).not.toBe(reserve.event.eventId);

		await ledger.settleAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-1",
			status: "captured",
			now: now + 1000,
		}, config());

		const summary = await ledger.summarize("workspace-1", "project-1", now + 1000, config());
		expect(summary.daily.aiActiveReservedThb).toBe(0);
		expect(summary.daily.aiCapturedThb).toBe(4.25);
	});

	test("captures Postgres AI reservations at the settled amount instead of full reserve", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.reserveAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-capture-estimate",
			amountThb: 10,
			now,
		}, config());
		await ledger.settleAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-capture-estimate",
			status: "captured",
			amountThb: 6.25,
			now: now + 1000,
		}, config());

		const summary = await ledger.summarize("workspace-1", "project-1", now + 1000, config());
		expect(summary.daily.aiActiveReservedThb).toBe(0);
		expect(summary.daily.aiCapturedThb).toBe(6.25);
		expect(summary.daily.aiCommittedThb).toBe(6.25);
	});

	test("enforces upload quotas from persisted database events", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.recordUpload({
			workspaceId: "workspace-1",
			projectId: "project-1",
			subjectId: "upload-1",
			bytes: 700,
			now,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));

		await expect(ledger.recordUpload({
			workspaceId: "workspace-1",
			projectId: "project-1",
			subjectId: "upload-2",
			bytes: 400,
			now,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }))).rejects.toThrow(UsageQuotaExceededError);
	});

	test("uses workspace billing plans and credit grants when no override is passed", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-pro", {
			planId: "pro",
			monthlyAiCredits: 4000,
			addonAiCredits: 500,
			addonQuantity: 2,
		});
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		const reserved = await ledger.reserveAiCredit({
			workspaceId: "workspace-pro",
			projectId: "project-pro",
			jobId: "job-pro",
			amountThb: 175,
			now,
		});

		expect(reserved.summary.planId).toBe("pro");
		// 4000 plan + 500×2 add-on = 5000 credits × 0.09฿ (sale rate) = 450฿.
		expect(reserved.summary.monthly.limits.aiCreditThb).toBe(450);
		expect(reserved.summary.monthly.aiCommittedThb).toBe(175);
	});

	test("falls back to the free workspace plan when no billing plan exists", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");
		const originalWorkspacePlanId = process.env.WORKSPACE_PLAN_ID;

		try {
			process.env.WORKSPACE_PLAN_ID = "pro";
			await expect(ledger.reserveAiCredit({
				workspaceId: "workspace-free",
				projectId: "project-free",
				jobId: "job-free",
				amountThb: 10,
				now,
			})).rejects.toThrow(UsageQuotaExceededError);
		} finally {
			if (originalWorkspacePlanId === undefined) {
				delete process.env.WORKSPACE_PLAN_ID;
			} else {
				process.env.WORKSPACE_PLAN_ID = originalWorkspacePlanId;
			}
		}
	});

	test("uses plan-derived monthly AI credit limits under the Docker zero default", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-pro", {
			planId: "pro",
			monthlyAiCredits: 4000,
		});
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");
		const originalMonthlyAiCreditLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;

		try {
			process.env.USAGE_MONTHLY_AI_CREDIT_THB = "0";
			const summary = await ledger.summarize("workspace-pro", "project-pro", now);
			// 4000 credits × 0.09฿ (sale rate) = 360฿.
			expect(summary.monthly.limits.aiCreditThb).toBe(360);
			await expect(ledger.reserveAiCredit({
				workspaceId: "workspace-pro",
				projectId: "project-pro",
				jobId: "job-pro-over-limit",
				amountThb: 361,
				now,
			})).rejects.toThrow(UsageQuotaExceededError);
		} finally {
			if (originalMonthlyAiCreditLimit === undefined) {
				delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_MONTHLY_AI_CREDIT_THB = originalMonthlyAiCreditLimit;
			}
		}
	});

	test("falls back to free when the billing account plan is inactive", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-retired", {
			planId: "pro",
			monthlyAiCredits: 4000,
			planActive: false,
		});
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		const summary = await ledger.summarize("workspace-retired", "project-retired", now);
		expect(summary.planId).toBe("free");
		// Free plan = 100 credits × 0.09฿ (sale rate) = 9฿.
		expect(summary.monthly.limits.aiCreditThb).toBe(9);
		await expect(ledger.reserveAiCredit({
			workspaceId: "workspace-retired",
			projectId: "project-retired",
			jobId: "job-retired-over-free",
			amountThb: 10,
			now,
		})).rejects.toThrow(UsageQuotaExceededError);
	});

	test("applies one-time AI credit grants only to the grant month", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-creator", {
			planId: "creator",
			monthlyAiCredits: 1000,
			addonAiCredits: 500,
			addonQuantity: 1,
			addonBillingInterval: "one_time",
			addonCreatedAt: "2026-05-13T10:00:00.000Z",
		});
		const ledger = new PostgresUsageLedger(client);
		const may = Date.parse("2026-05-20T10:00:00.000Z");
		const june = Date.parse("2026-06-01T10:00:00.000Z");

		expect((await ledger.summarize("workspace-creator", "project-creator", may)).monthly.limits.aiCreditThb).toBe(135);
		expect((await ledger.summarize("workspace-creator", "project-creator", june)).monthly.limits.aiCreditThb).toBe(90);
	});

	test("evaluates add-on expiry at the requested summary time", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-expiring", {
			planId: "creator",
			monthlyAiCredits: 1000,
			addonAiCredits: 500,
			addonQuantity: 1,
			addonBillingInterval: "monthly",
			addonExpiresAt: "2026-05-31T00:00:00.000Z",
		});
		const ledger = new PostgresUsageLedger(client);
		const beforeExpiry = Date.parse("2026-05-20T10:00:00.000Z");
		const afterExpiry = Date.parse("2026-06-01T10:00:00.000Z");

		expect((await ledger.summarize("workspace-expiring", "project-expiring", beforeExpiry)).monthly.limits.aiCreditThb).toBe(135);
		expect((await ledger.summarize("workspace-expiring", "project-expiring", afterExpiry)).monthly.limits.aiCreditThb).toBe(90);
	});

	test("does not count add-on grants before they are created", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-future-grant", {
			planId: "creator",
			monthlyAiCredits: 1000,
			addonAiCredits: 500,
			addonQuantity: 1,
			addonBillingInterval: "monthly",
			addonCreatedAt: "2026-05-20T10:00:00.000Z",
		});
		const ledger = new PostgresUsageLedger(client);
		const beforeGrant = Date.parse("2026-05-13T10:00:00.000Z");
		const afterGrant = Date.parse("2026-05-21T10:00:00.000Z");

		expect((await ledger.summarize("workspace-future-grant", "project-future-grant", beforeGrant)).monthly.limits.aiCreditThb).toBe(90);
		expect((await ledger.summarize("workspace-future-grant", "project-future-grant", afterGrant)).monthly.limits.aiCreditThb).toBe(135);
	});

	test("keeps active AI credit grants valid after products are retired", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.workspacePlanConfigs.set("workspace-retired-addon", {
			planId: "creator",
			monthlyAiCredits: 1000,
			addonAiCredits: 500,
			addonQuantity: 1,
			addonBillingInterval: "monthly",
			addonCreatedAt: "2026-05-01T00:00:00.000Z",
			addonProductActive: false,
		});
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-21T10:00:00.000Z");

		expect((await ledger.summarize("workspace-retired-addon", "project-retired-addon", now)).monthly.limits.aiCreditThb).toBe(135);
		const planLookup = client.queries.find((entry) => entry.query.includes("billing_addon_products"));
		expect(planLookup?.query).not.toContain("billing_addon_products.active = true");
	});

	test("resolves catalog workspace ids when callers only pass project ids", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.projects.set("project-1", "project:project-1");
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.recordUpload({
			projectId: "project-1",
			subjectId: "upload-1",
			bytes: 400,
			now,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));

		expect(client.rows[0].workspace_id).toBe("project:project-1");
		expect(client.locks).toContain("usage-ledger:project:project-1");
		const summary = await ledger.summarizeProject("project-1", now, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
		expect(summary.workspaceId).toBe("project:project-1");
		expect(summary.daily.uploadBytes).toBe(400);
	});

	test("creates fallback catalog rows before writing legacy project usage events", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.recordUpload({
			projectId: "legacy-project",
			subjectId: "upload-legacy",
			bytes: 400,
			now,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));

		expect(client.workspaces.has("project:legacy-project")).toBe(true);
		expect(client.projects.get("legacy-project")).toBe("project:legacy-project");
		expect(client.deletedProjects.has("legacy-project")).toBe(true);
		expect(client.projectMetadata.get("legacy-project")).toEqual({ usageLedgerPlaceholder: true });
		expect(client.rows[0].workspace_id).toBe("project:legacy-project");
		expect(client.rows[0].project_id).toBe("legacy-project");
	});

	test("settles AI credit in the reservation workspace after a catalog workspace backfill", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const projectId = "legacy-project";
		const fallbackWorkspaceId = "project:legacy-project";
		const backfilledWorkspaceId = "personal:user-1";
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.reserveAiCredit({
			projectId,
			jobId: "job-1",
			amountThb: 4.25,
			now,
		}, config());

		client.projects.set(projectId, backfilledWorkspaceId);
		client.deletedProjects.delete(projectId);

		await ledger.settleAiCredit({
			projectId,
			jobId: "job-1",
			status: "captured",
			now: now + 1000,
		}, config());

		const fallbackSummary = await ledger.summarize(fallbackWorkspaceId, projectId, now + 1000, config());
		const backfilledSummary = await ledger.summarize(backfilledWorkspaceId, projectId, now + 1000, config());
		expect(fallbackSummary.daily.aiActiveReservedThb).toBe(0);
		expect(fallbackSummary.daily.aiCapturedThb).toBe(4.25);
		expect(backfilledSummary.daily.aiCapturedThb).toBe(0);
	});

	test("does not double-settle AI credit when the terminal event is outside the summary month", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const april = Date.parse("2026-04-13T10:00:00.000Z");
		const june = Date.parse("2026-06-13T10:00:00.000Z");

		await ledger.reserveAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-old",
			amountThb: 4.25,
			now: april,
		}, config());
		const captured = await ledger.settleAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-old",
			status: "captured",
			now: april + 1000,
		}, config());
		const duplicate = await ledger.settleAiCredit({
			workspaceId: "workspace-1",
			projectId: "project-1",
			jobId: "job-old",
			status: "released",
			amountThb: 4.25,
			now: june,
		}, config());

		expect(duplicate?.eventId).toBe(captured?.eventId);
		expect(client.rows.filter((row) => row.kind === "ai_credit_captured" || row.kind === "ai_credit_released")).toHaveLength(1);
	});

	test("counts all workspace ledger events in Postgres summaries", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const may = Date.parse("2026-05-13T10:00:00.000Z");
		const april = Date.parse("2026-04-13T10:00:00.000Z");

		await ledger.recordUpload({
			workspaceId: "workspace-1",
			projectId: "project-1",
			subjectId: "upload-old",
			bytes: 300,
			now: april,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
		await ledger.recordUpload({
			workspaceId: "workspace-1",
			projectId: "project-1",
			subjectId: "upload-current",
			bytes: 400,
			now: may,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));

		const summary = await ledger.summarize("workspace-1", "project-1", may, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
		expect(summary.monthly.uploadBytes).toBe(400);
		expect(summary.eventCount).toBe(2);
	});

	test("caps the all-time eventCount with a LIMITed COUNT (100000+ semantics)", async () => {
		// The unbounded COUNT(*) over the append-only usage_events table is O(all-time
		// rows); countWorkspaceEvents bounds it with an inner `LIMIT $2 = cap` subquery
		// so the scan reads at most cap+1 rows. We assert (a) the cap is passed to the
		// query and (b) a row total at/above the cap is reported AS the cap ("at least").
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		// Seed the fake just over the cap so the bounded count would clamp. We inject
		// rows directly (recording 100001 events would be needlessly slow) — the fake's
		// COUNT branch counts `client.rows` for the workspace, clamped to the cap param.
		for (let i = 0; i < WORKSPACE_EVENT_COUNT_CAP + 5; i += 1) {
			client.rows.push({ workspace_id: "workspace-cap", project_id: "project-1", kind: "upload_bytes_recorded", subject_id: `u-${i}`, created_at: new Date(now) });
		}

		const summary = await ledger.summarize("workspace-cap", "project-1", now, config());
		// Reported value is the cap, not the true (cap+5) total: "100000+" semantics.
		expect(summary.eventCount).toBe(WORKSPACE_EVENT_COUNT_CAP);
		// The contract advertises the cappedness so clients render "100000+", not "100000".
		expect(summary.eventCountCapped).toBe(true);

		// The bounded count query carried the cap as its LIMIT param (so the real DB
		// scan stops at cap+1 rows instead of reading the whole workspace history).
		const countQuery = client.queries.find((q) => q.query.replace(/\s+/g, " ").includes("SELECT COUNT(*) AS event_count"));
		expect(countQuery).toBeDefined();
		expect(countQuery?.query.replace(/\s+/g, " ")).toContain("LIMIT $2");
		expect(countQuery?.params).toEqual(["workspace-cap", WORKSPACE_EVENT_COUNT_CAP]);
	});

	test("reports the exact eventCount when the workspace is under the cap", async () => {
		// Below the cap, the bounded count is exact (no clamping) — the cap only kicks
		// in for very large workspaces, so normal accounts see their true count.
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");
		for (let i = 0; i < 3; i += 1) {
			client.rows.push({ workspace_id: "workspace-small", project_id: "project-1", kind: "upload_bytes_recorded", subject_id: `u-${i}`, created_at: new Date(now) });
		}
		const summary = await ledger.summarize("workspace-small", "project-1", now, config());
		expect(summary.eventCount).toBe(3);
		expect(summary.eventCount).toBeLessThan(WORKSPACE_EVENT_COUNT_CAP);
		// Under the cap the value is exact, so the contract reports it as NOT capped.
		expect(summary.eventCountCapped).toBe(false);
	});

	test("rank13: summarize() issues the all-time COUNT concurrently with the bounded event load", async () => {
		// A client that records when each read STARTS and lets us block the bounded
		// summary-event load. If the COUNT runs sequentially after the events, it
		// would not start until the (blocked) events query resolves. Proving the
		// COUNT starts while the events load is still pending demonstrates the
		// parallelization (and the eventCount value still matches all-time count).
		const dispatched: string[] = [];
		let armed = false; // only gate during the summarize() under test
		let releaseEvents: () => void = () => {};
		const eventsGate = new Promise<void>((resolve) => { releaseEvents = resolve; });

		class ConcurrencyProbeClient extends FakeUsageLedgerSqlClient {
			override async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
				const normalized = query.replace(/\s+/g, " ").trim();
				if (armed && normalized.startsWith("SELECT event_id, workspace_id")) {
					dispatched.push("events");
					await eventsGate; // hold the bounded event load open
				} else if (armed && normalized.startsWith("SELECT COUNT(*) AS event_count")) {
					dispatched.push("count");
				}
				return super.unsafe<T>(query, params);
			}
		}

		const client = new ConcurrencyProbeClient();
		const ledger = new PostgresUsageLedger(client);
		const may = Date.parse("2026-05-13T10:00:00.000Z");
		await ledger.recordUpload({
			workspaceId: "workspace-1", projectId: "project-1", subjectId: "u1", bytes: 100, now: may,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
		armed = true; // start gating only now, for the summarize() below

		const pending = ledger.summarize("workspace-1", "project-1", may, config());
		// Let microtasks flush so both reads on the pooled path get dispatched.
		await Promise.resolve();
		await Promise.resolve();
		// The COUNT was issued WITHOUT waiting for the still-blocked event load.
		expect(dispatched).toContain("events");
		expect(dispatched).toContain("count");

		releaseEvents();
		const summary = await pending;
		expect(summary.eventCount).toBe(1); // all-time count preserved
	});

	test("lists project usage events from Postgres with cursor pagination", async () => {
		const client = new FakeUsageLedgerSqlClient();
		client.projects.set("project-1", "workspace-1");
		const ledger = new PostgresUsageLedger(client);
		const now = Date.parse("2026-05-13T10:00:00.000Z");

		await ledger.recordUpload({
			projectId: "project-1",
			subjectId: "upload-1",
			bytes: 100,
			now,
		}, config({ dailyUploadBytes: 1000, monthlyUploadBytes: 5000 }));
		await ledger.recordExport({
			projectId: "project-1",
			subjectId: "export-1",
			bytes: 200,
			now: now + 1000,
		}, config({ dailyExportBytes: 1000, monthlyExportBytes: 5000 }));

		const first = await ledger.listProjectEventPage("project-1", { limit: 1 });
		expect(first.events.map((event) => event.subjectId)).toEqual(["export-1"]);
		expect(first.nextCursor).toBeDefined();

		const second = await ledger.listProjectEventPage("project-1", { limit: 1, cursor: first.nextCursor });
		expect(second.events.map((event) => event.subjectId)).toEqual(["upload-1"]);
		expect(second.nextCursor).toBeUndefined();

		const uploads = await ledger.listProjectEventPage("project-1", { kind: "upload_bytes_recorded" });
		expect(uploads.events.map((event) => event.subjectId)).toEqual(["upload-1"]);
	});
});

// ── Support-agent token spend + global budget meter (rank7) ─────────────────

describe("ticket_ai_tokens usage (support budget meter)", () => {
	const MONTH_START = Date.parse("2026-05-01T00:00:00.000Z");
	const MID_MONTH = Date.parse("2026-05-15T10:00:00.000Z");

	test("File ledger records token spend idempotently on ticketId+messageId", () => {
		withLedger((ledger) => {
			const first = ledger.recordTicketAiTokens({
				ticketId: "tk-1", messageId: "m-1", tokens: 500, thbPerToken: 0.002, now: MID_MONTH,
			});
			expect(first.kind).toBe("ticket_ai_tokens");
			expect(first.units).toBe(500);
			expect(first.amountThb).toBe(1); // 500 * 0.002
			// A retry / double-send with the same (ticket, message) must NOT double-charge.
			const retry = ledger.recordTicketAiTokens({
				ticketId: "tk-1", messageId: "m-1", tokens: 500, thbPerToken: 0.002, now: MID_MONTH,
			});
			expect(retry.eventId).toBe(first.eventId);
		});
	});

	test("File ledger global monthly sum is GLOBAL (cross-tenant), not per-project", () => {
		withLedger((ledger) => {
			// Spend attributed to two DIFFERENT workspaces/projects.
			ledger.recordTicketAiTokens({ ticketId: "tk-a", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: MID_MONTH });
			ledger.recordTicketAiTokens({ ticketId: "tk-b", messageId: "m-1", tokens: 2000, thbPerToken: 0.001, workspaceId: "ws-b", projectId: "p-b", now: MID_MONTH });
			// Spend BEFORE the month window must be excluded.
			ledger.recordTicketAiTokens({ ticketId: "tk-old", messageId: "m-1", tokens: 9999, thbPerToken: 0.001, now: MONTH_START - 1000 });

			// 1.0 + 2.0 = 3.0 THB across both tenants — the per-project summarize would
			// only ever see one workspace, so this proves the meter is global.
			expect(ledger.sumTicketAiTokensThb(MONTH_START)).toBe(3);
		});
	});

	// BUG 3 (P1): when the caller OMITS thbPerToken, the recorded amount must use the
	// CONFIGURED rate (serverConfig.ticketAiGuardrails.thbPerToken), not a hardcoded
	// 0.001. Hardcoding undercounts the global monthly budget meter whenever an
	// operator raised the rate, letting more real spend slip through.
	test("File ledger: omitted thbPerToken uses the CONFIGURED rate (not hardcoded 0.001); explicit still wins", async () => {
		const { serverConfig } = await import("../config.js");
		const originalRate = serverConfig.ticketAiGuardrails.thbPerToken;
		serverConfig.ticketAiGuardrails.thbPerToken = 0.01; // operator-configured rate
		try {
			withLedger((ledger) => {
				// Caller omits thbPerToken → defaults to the configured 0.01/token.
				const configured = ledger.recordTicketAiTokens({
					ticketId: "tk-cfg", messageId: "m-1", tokens: 1000, now: MID_MONTH,
				});
				expect(configured.amountThb).toBe(10); // 1000 * 0.01, NOT 1.0 (the old 0.001)
				expect(configured.units).toBe(1000);
				// The GLOBAL budget meter therefore counts the real (configured) cost.
				expect(ledger.sumTicketAiTokensThb(MONTH_START)).toBe(10);

				// An EXPLICIT caller rate still wins over the configured default.
				const explicit = ledger.recordTicketAiTokens({
					ticketId: "tk-exp", messageId: "m-1", tokens: 1000, thbPerToken: 0.002, now: MID_MONTH,
				});
				expect(explicit.amountThb).toBe(2); // 1000 * 0.002 (caller value, not 0.01)
				// Meter now reflects both: 10 (configured) + 2 (explicit) = 12.
				expect(ledger.sumTicketAiTokensThb(MONTH_START)).toBe(12);
			});
		} finally {
			serverConfig.ticketAiGuardrails.thbPerToken = originalRate;
		}
	});

	test("Postgres ledger: omitted thbPerToken uses the CONFIGURED rate; explicit still wins", async () => {
		const { serverConfig } = await import("../config.js");
		const originalRate = serverConfig.ticketAiGuardrails.thbPerToken;
		serverConfig.ticketAiGuardrails.thbPerToken = 0.01;
		try {
			const client = new FakeUsageLedgerSqlClient();
			const ledger = new PostgresUsageLedger(client);
			const configured = await ledger.recordTicketAiTokens({ ticketId: "tk-pg-cfg", messageId: "m-1", tokens: 1000, now: MID_MONTH });
			expect(Number(configured.amountThb)).toBe(10); // configured 0.01/token
			const explicit = await ledger.recordTicketAiTokens({ ticketId: "tk-pg-exp", messageId: "m-1", tokens: 1000, thbPerToken: 0.002, now: MID_MONTH });
			expect(Number(explicit.amountThb)).toBe(2); // caller value wins
			expect(await ledger.sumTicketAiTokensThb(MONTH_START)).toBe(12); // 10 + 2
		} finally {
			serverConfig.ticketAiGuardrails.thbPerToken = originalRate;
		}
	});

	test("Postgres ledger records token spend idempotently and sums globally", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		await ledger.recordTicketAiTokens({ ticketId: "tk-1", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: MID_MONTH });
		await ledger.recordTicketAiTokens({ ticketId: "tk-2", messageId: "m-1", tokens: 1500, thbPerToken: 0.001, workspaceId: "ws-b", projectId: "p-b", now: MID_MONTH });
		// Idempotent retry.
		await ledger.recordTicketAiTokens({ ticketId: "tk-1", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: MID_MONTH });

		const ticketRows = client.rows.filter((row) => row.kind === "ticket_ai_tokens");
		expect(ticketRows).toHaveLength(2); // retry did not create a 3rd row.
		expect(await ledger.sumTicketAiTokensThb(MONTH_START)).toBe(2.5); // 1.0 + 1.5
	});

	// ── P1: idempotency is GLOBAL on (ticketId, messageId), independent of the
	// caller-supplied workspaceId; same key + different amount reconciles. ──

	test("File ledger: same (ticket,message) under a DIFFERENT workspace does NOT double-record", () => {
		withLedger((ledger) => {
			const first = ledger.recordTicketAiTokens({
				ticketId: "tk-glob", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: MID_MONTH,
			});
			// A retry that lies about the workspace must still hit the SAME idempotency
			// row (storage scope is the fixed `support` workspace, not the caller's).
			const retry = ledger.recordTicketAiTokens({
				ticketId: "tk-glob", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-evil", projectId: "p-evil", now: MID_MONTH,
			});
			expect(retry.eventId).toBe(first.eventId);
			// Exactly one event, exactly one charge.
			expect(ledger.listEvents().filter((e) => e.kind === "ticket_ai_tokens")).toHaveLength(1);
			expect(ledger.sumTicketAiTokensThb(MONTH_START)).toBe(1); // not 2
		});
	});

	test("File ledger: re-recording the same key with a DIFFERENT amount RECONCILES (no under/over-count)", () => {
		withLedger((ledger) => {
			// First write undercounts (partial token count).
			const first = ledger.recordTicketAiTokens({
				ticketId: "tk-rec", messageId: "m-1", tokens: 500, thbPerToken: 0.001, now: MID_MONTH,
			});
			expect(first.amountThb).toBe(0.5);
			// Corrected token count for the SAME reply → reconcile to the true amount.
			const corrected = ledger.recordTicketAiTokens({
				ticketId: "tk-rec", messageId: "m-1", tokens: 2000, thbPerToken: 0.001, now: MID_MONTH,
			});
			expect(corrected.eventId).toBe(first.eventId); // same row, not a new charge
			expect(corrected.amountThb).toBe(2); // reconciled up
			expect(corrected.units).toBe(2000);
			// The global meter reflects the corrected amount, not the stale 0.5.
			expect(ledger.sumTicketAiTokensThb(MONTH_START)).toBe(2);
			expect(ledger.listEvents().filter((e) => e.kind === "ticket_ai_tokens")).toHaveLength(1);
		});
	});

	test("Postgres ledger: same (ticket,message) under a DIFFERENT workspace does NOT double-record", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		await ledger.recordTicketAiTokens({ ticketId: "tk-pg-glob", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: MID_MONTH });
		await ledger.recordTicketAiTokens({ ticketId: "tk-pg-glob", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-evil", projectId: "p-evil", now: MID_MONTH });
		const rows = client.rows.filter((row) => row.kind === "ticket_ai_tokens");
		expect(rows).toHaveLength(1); // a different workspace did not create a second row
		expect(await ledger.sumTicketAiTokensThb(MONTH_START)).toBe(1);
	});

	test("Postgres ledger: re-recording the same key with a DIFFERENT amount RECONCILES", async () => {
		const client = new FakeUsageLedgerSqlClient();
		const ledger = new PostgresUsageLedger(client);
		const first = await ledger.recordTicketAiTokens({ ticketId: "tk-pg-rec", messageId: "m-1", tokens: 500, thbPerToken: 0.001, now: MID_MONTH });
		expect(Number(first.amountThb)).toBe(0.5);
		const corrected = await ledger.recordTicketAiTokens({ ticketId: "tk-pg-rec", messageId: "m-1", tokens: 2000, thbPerToken: 0.001, now: MID_MONTH });
		expect(corrected.eventId).toBe(first.eventId);
		expect(Number(corrected.amountThb)).toBe(2);
		expect(Number(corrected.units)).toBe(2000);
		const rows = client.rows.filter((row) => row.kind === "ticket_ai_tokens");
		expect(rows).toHaveLength(1); // still one row
		expect(await ledger.sumTicketAiTokensThb(MONTH_START)).toBe(2); // reconciled meter
	});
});
