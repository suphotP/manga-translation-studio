import { getSharedBunSql } from "./sql-pool.js";
import { createHash } from "crypto";
import { Cron } from "croner";

export interface CronSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	reserve?(): Promise<CronSqlClient & { release?(): void | Promise<void> }>;
	release?(): void | Promise<void>;
	close?(): Promise<void> | void;
}

export type ScheduledJobStatus = "success" | "error" | "skipped";

export interface ScheduledJobRow {
	name: string;
	schedule: string;
	lastRunAt: string | null;
	lastStatus: ScheduledJobStatus | null;
	lastError: string | null;
	nextRunAt: string | null;
	enabled: boolean;
}

export interface ScheduledJobDefinition {
	name: string;
	description: string;
	/** Five-field cron expression interpreted in UTC by croner. */
	schedule: string;
	nextRunAfter(now: Date): Date;
	run(client: CronSqlClient, context: CronJobContext): Promise<void>;
}

export interface CronJobContext {
	now: Date;
	config: CronSchedulerConfig;
}

export interface CronSchedulerConfig {
	auditRetentionDays: number;
	draftExportTtlHours: number;
	aiReservationAbandonAfterDays: number;
	/**
	 * GDPR right-to-erasure retention window (days). The gdpr-erasure-sweep job
	 * anonymizes a soft-deleted account only once its deletion is older than this.
	 * Configurable (GDPR_ERASURE_GRACE_DAYS / serverConfig.gdprErasureGraceDays);
	 * defaults to 30 — the exact legal window is the operator's call after legal
	 * review, so this builds the mechanism with a sane default.
	 */
	gdprErasureGraceDays: number;
	/**
	 * Active usage-ledger store. monthly-credit-reset scans `usage_events` in
	 * Postgres, so it must no-op when the API persists reservations to the file
	 * ledger instead — otherwise the Postgres scan sees nothing and file-backed
	 * reservations stay active forever. Keep in sync with the API's
	 * USAGE_LEDGER_STORE.
	 */
	usageLedgerStore: "file" | "postgres";
	/**
	 * Per-tick cap for the row-cleanup jobs (expired sessions/invites/password
	 * resets/storage packs/audit logs/draft exports). The cron runner is
	 * sequential, so an unbounded single-statement DELETE/UPDATE over a large
	 * backlog would hold one long transaction (lock pressure) and delay every
	 * later job. Each cleanup instead deletes/updates at most this many rows per
	 * tick and stays resumable across ticks. Override with CLEANUP_BATCH_SIZE.
	 */
	cleanupBatchSize: number;
	/**
	 * Stale unverified-account TTL (days). The unverified-account-cleanup job hard-
	 * deletes a local sign-up that never confirmed its email after this many days,
	 * reclaiming rows so abandoned / bot sign-ups don't bloat the DB. Only accounts
	 * with NO workspace relationship are eligible (a genuinely unused sign-up), so app
	 * data is never touched. Override with UNVERIFIED_ACCOUNT_MAX_AGE_DAYS.
	 */
	unverifiedAccountMaxAgeDays: number;
}

export interface CronSchedulerOptions {
	client?: CronSqlClient;
	jobs?: ScheduledJobDefinition[];
	now?: () => Date;
	config?: Partial<CronSchedulerConfig>;
}

export interface CronRunResult {
	name: string;
	status: ScheduledJobStatus;
	error?: string;
}

interface ScheduledJobDbRow {
	name: string;
	schedule?: string | null;
	last_run_at?: Date | string | null;
	last_status?: string | null;
	last_error?: string | null;
	next_run_at?: Date | string | null;
	enabled?: boolean | string | number;
}

const DEFAULT_CONFIG: CronSchedulerConfig = {
	auditRetentionDays: readPositiveEnv("AUDIT_RETENTION_DAYS", 90),
	draftExportTtlHours: readPositiveEnv("DRAFT_EXPORT_TTL_HOURS", 24),
	aiReservationAbandonAfterDays: readPositiveEnv("AI_RESERVATION_ABANDON_AFTER_DAYS", 7),
	gdprErasureGraceDays: readPositiveEnv("GDPR_ERASURE_GRACE_DAYS", 30),
	usageLedgerStore: process.env.USAGE_LEDGER_STORE === "postgres" ? "postgres" : "file",
	cleanupBatchSize: readPositiveEnv("CLEANUP_BATCH_SIZE", 1000),
	unverifiedAccountMaxAgeDays: readPositiveEnv("UNVERIFIED_ACCOUNT_MAX_AGE_DAYS", 3),
};

/**
 * Hard ceiling on rows processed by a single cleanup job per tick, regardless of
 * how many resumable batches it runs. Caps total work so one job (with a huge
 * backlog) cannot monopolize the sequential cron runner; the remainder is left
 * for the next scheduled tick. Derived as a small multiple of the batch size.
 */
const CLEANUP_MAX_BATCHES_PER_TICK = 20;

/**
 * Run a bounded, resumable cleanup mutation. Wraps an existing single-statement
 * DELETE/UPDATE (identified by `table` + `whereClause`) so it affects at most
 * `batchSize` rows per statement, looping up to `CLEANUP_MAX_BATCHES_PER_TICK`
 * times so a moderate backlog still drains in one tick while a pathological
 * backlog is capped (resumed next tick). Uses the universal `ctid` system column
 * so it works on any table without knowing its primary key, and preserves the
 * caller's exact WHERE predicate (same rows eventually cleaned, just batched).
 *
 * @returns total rows affected this tick.
 */
async function runBoundedCleanup(
	client: CronSqlClient,
	options: {
		operation: "DELETE FROM" | "UPDATE";
		table: string;
		/** For UPDATE: the `SET ...` clause (without the leading SET). */
		setClause?: string;
		/** WHERE predicate WITHOUT the leading WHERE; reused verbatim per batch. */
		whereClause: string;
		params?: unknown[];
		batchSize: number;
	},
): Promise<number> {
	const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
		? options.batchSize
		: 1000;
	// $N for the batch LIMIT comes after the caller's own positional params.
	const limitParam = `$${(options.params?.length ?? 0) + 1}`;
	const selectVictims = `SELECT ctid FROM ${options.table} WHERE ${options.whereClause} LIMIT ${limitParam}`;
	// RETURNING ctid gives an exact per-batch affected-row count (Bun.SQL does not
	// surface a rowCount for an un-RETURNING mutation), which both drives the loop
	// and tells us when we have drained the matches for this tick.
	const statement = options.operation === "UPDATE"
		? `UPDATE ${options.table} SET ${options.setClause} WHERE ctid IN (${selectVictims}) RETURNING ctid`
		: `DELETE FROM ${options.table} WHERE ctid IN (${selectVictims}) RETURNING ctid`;
	const params = [...(options.params ?? []), batchSize];

	let total = 0;
	for (let batch = 0; batch < CLEANUP_MAX_BATCHES_PER_TICK; batch += 1) {
		const rows = await client.unsafe<{ ctid?: unknown }>(statement, params);
		const affected = Array.isArray(rows) ? rows.length : 0;
		total += affected;
		// A short batch means no more matching rows remain — stop. A full batch may
		// have more; loop again (capped by CLEANUP_MAX_BATCHES_PER_TICK so a huge
		// backlog never monopolizes the tick — the rest is resumed next tick).
		if (affected < batchSize) break;
	}
	return total;
}

export function createCronSqlClient(databaseUrl = process.env.DATABASE_URL): CronSqlClient {
	if (!databaseUrl?.trim()) {
		throw new Error("DATABASE_URL is required to run the cron scheduler");
	}
	return getSharedBunSql(databaseUrl) as unknown as CronSqlClient;
}

export function hashKey(jobName: string): number {
	const digest = createHash("sha256").update(jobName).digest();
	return digest.readInt32BE(0);
}

/**
 * Whether the cron-worker process should boot the scheduler. Default true in
 * production (the cron-worker container is started intentionally), false in
 * other environments so a dev `bun start` does not double-run jobs against a
 * shared database.
 */
export function isSchedulerEnabled(
	raw = process.env.SCHEDULER_ENABLED,
	nodeEnv = process.env.NODE_ENV,
): boolean {
	if (raw === undefined || raw.trim() === "") {
		return nodeEnv === "production";
	}
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Build a `nextRunAfter` function from a five-field cron expression (UTC).
 *
 * Validates the expression eagerly so a typo blows up at module load (and at
 * test discovery), not at the first scheduler tick.
 */
export function cronNextRun(expression: string): (now: Date) => Date {
	const probe = new Cron(expression, { timezone: "UTC" });
	const firstNext = probe.nextRun();
	probe.stop();
	if (!firstNext) {
		throw new Error(`Cron expression "${expression}" has no future fire time`);
	}
	return (now: Date) => {
		const job = new Cron(expression, { timezone: "UTC" });
		const candidate = job.nextRun(now);
		job.stop();
		if (!candidate) {
			throw new Error(`Cron expression "${expression}" has no future fire time after ${now.toISOString()}`);
		}
		return candidate;
	};
}

export class CronScheduler {
	private readonly client: CronSqlClient;
	private readonly jobs: Map<string, ScheduledJobDefinition>;
	private readonly now: () => Date;
	private readonly config: CronSchedulerConfig;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(options: CronSchedulerOptions = {}) {
		this.client = options.client ?? createCronSqlClient();
		this.jobs = new Map((options.jobs ?? createDefaultScheduledJobs()).map((job) => [job.name, job]));
		this.now = options.now ?? (() => new Date());
		this.config = { ...DEFAULT_CONFIG, ...options.config };
	}

	async initialize(): Promise<void> {
		const now = this.now();
		for (const job of this.jobs.values()) {
			await this.client.unsafe(`
				INSERT INTO scheduled_jobs (name, schedule, next_run_at, enabled, updated_at)
				VALUES ($1, $2, $3, true, now())
				ON CONFLICT (name) DO UPDATE SET
					schedule = EXCLUDED.schedule,
					next_run_at = COALESCE(scheduled_jobs.next_run_at, EXCLUDED.next_run_at),
					updated_at = now()
			`, [job.name, job.schedule, job.nextRunAfter(now).toISOString()]);
		}
	}

	async listJobs(): Promise<ScheduledJobRow[]> {
		const rows = await this.client.unsafe<ScheduledJobDbRow>(`
			SELECT name, schedule, last_run_at, last_status, last_error, next_run_at, enabled
			FROM scheduled_jobs
			ORDER BY name ASC
		`);
		return rows.map(mapScheduledJobRow);
	}

	async runDueJobs(): Promise<CronRunResult[]> {
		if (this.running) return [];
		this.running = true;
		try {
			await this.initialize();
			const rows = await this.client.unsafe<{ name: string }>(`
				SELECT name
				FROM scheduled_jobs
				WHERE enabled = true
					AND (next_run_at IS NULL OR next_run_at <= $1)
				ORDER BY next_run_at NULLS FIRST, name ASC
			`, [this.now().toISOString()]);
			const results: CronRunResult[] = [];
			for (const row of rows) {
				const result = await this.runJob(row.name, { force: false });
				if (result) results.push(result);
			}
			return results;
		} finally {
			this.running = false;
		}
	}

	async forceRun(name: string): Promise<CronRunResult | null> {
		await this.initialize();
		return this.runJob(name, { force: true });
	}

	start(options: { pollIntervalMs?: number } = {}): void {
		const pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? 60_000);
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runDueJobs().catch((error) => {
				console.warn(`[CronScheduler] scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, pollIntervalMs);
		void this.runDueJobs().catch((error) => {
			console.warn(`[CronScheduler] initial tick failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async close(): Promise<void> {
		this.stop();
		// No client close: the default client is the process-wide SHARED pool
		// (closing it would kill every Postgres store and poison the pool cache),
		// and an injected client belongs to its injector. A standalone cron
		// worker's pool dies with its process.
	}

	private async runJob(name: string, options: { force: boolean }): Promise<CronRunResult | null> {
		const job = this.jobs.get(name);
		if (!job) return null;
		const reserved = await reserveClient(this.client);
		let locked = false;
		try {
			const enabled = options.force ? true : await isJobEnabled(reserved, name);
			if (!enabled) {
				return { name, status: "skipped", error: "job_disabled" };
			}

			locked = await acquireJobLock(reserved, name);
			if (!locked) {
				await recordSkipped(reserved, name);
				return { name, status: "skipped", error: "lock_not_acquired" };
			}

			const now = this.now();

			// Double-run guard (multi-replica): runDueJobs snapshots the due set
			// BEFORE taking the advisory lock, so replica B can still see a job as due
			// that replica A is concurrently running. After A commits, its
			// next_run_at moves into the future, but B already queued the row. Without
			// re-reading next_run_at under the lock B would run the same fire a second
			// time. So once we hold the lock, re-check due-ness from the freshly-read
			// row and bail (release happens in finally) when the job is no longer due.
			// `force` (manual admin run) bypasses this on purpose.
			if (!options.force) {
				const nextRunAt = await readJobNextRunAt(reserved, name);
				// next_run_at IS NULL means "due now / catch-up" (mirrors the runDueJobs
				// WHERE clause); only a future timestamp means another replica already
				// advanced it past `now`.
				if (nextRunAt !== null && nextRunAt.getTime() > now.getTime()) {
					return { name, status: "skipped", error: "not_due" };
				}
			}
			try {
				await job.run(reserved, { now, config: this.config });
				await recordRun(reserved, {
					name,
					status: "success",
					error: null,
					lastRunAt: now,
					nextRunAt: job.nextRunAfter(now),
				});
				return { name, status: "success" };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Leave next_run_at untouched so the job stays due and retries on the
				// next poll, rather than skipping the whole interval to the next
				// nominal cron fire. A transient DB error during e.g.
				// monthly-credit-reset at 00:05 on the 1st would otherwise not run
				// again until next month, leaving stale reservations active.
				await recordRun(reserved, {
					name,
					status: "error",
					error: message.slice(0, 4000),
					lastRunAt: now,
					nextRunAt: null,
				});
				return { name, status: "error", error: message };
			}
		} finally {
			try {
				if (locked) {
					await releaseJobLock(reserved, name);
				}
			} finally {
				await reserved.release?.();
			}
		}
	}
}

/**
 * Default cron expressions for the 7 W2.4 jobs (UTC).
 *
 * Keep these in sync with `backend/migrations/0032_scheduled_jobs.sql` so a
 * fresh database INSERT and the code-side default match. The migration's
 * `ON CONFLICT … DO UPDATE SET schedule = EXCLUDED.schedule` ensures the DB
 * follows the migration on re-run.
 */
export const DEFAULT_JOB_SCHEDULES = {
	"monthly-credit-reset": "5 0 1 * *",
	"gdpr-erasure-sweep": "0 2 * * *",
	"expired-session-gc": "0 3 * * *",
	"expired-invite-cleanup": "0 */6 * * *",
	"expired-password-reset-cleanup": "0 */6 * * *",
	"unverified-account-cleanup": "45 3 * * *",
	"expired-storage-pack-sweep": "0 4 * * *",
	"audit-retention-prune": "0 5 * * *",
	"draft-export-cleanup": "0 6 * * *",
	// Edit-asset row reaper runs BEFORE orphan-blob-gc in the same nightly window so a
	// reverted edit asset's row is removed (dropping its blob ref_count) before the blob
	// GC frees the now-unreferenced object/bytes.
	"orphan-edit-asset-gc": "15 4 * * *",
	"orphan-blob-gc": "30 4 * * *",
	// Frequent + cheap: work locks are minute-scale leases, so physically release
	// expired-but-unreleased rows often to keep the table small. Correctness does NOT
	// depend on this (reads/extends are time-aware and re-acquire self-heals the scope);
	// it is hygiene for scopes that expire and are never re-acquired.
	"expired-work-lock-sweep": "*/15 * * * *",
} as const;

export function createDefaultScheduledJobs(): ScheduledJobDefinition[] {
	return [
		{
			name: "monthly-credit-reset",
			description: "Release stale AI credit reservations so the event-based monthly allowance starts cleanly.",
			schedule: DEFAULT_JOB_SCHEDULES["monthly-credit-reset"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["monthly-credit-reset"]),
			run: monthlyCreditReset,
		},
		{
			name: "gdpr-erasure-sweep",
			description: "Anonymize PII for soft-deleted accounts whose configurable GDPR retention window has expired (right-to-erasure).",
			schedule: DEFAULT_JOB_SCHEDULES["gdpr-erasure-sweep"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["gdpr-erasure-sweep"]),
			run: gdprErasureSweep,
		},
		{
			name: "expired-session-gc",
			description: "Delete expired auth/refresh sessions after the grace window.",
			schedule: DEFAULT_JOB_SCHEDULES["expired-session-gc"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["expired-session-gc"]),
			run: expiredSessionGc,
		},
		{
			name: "expired-invite-cleanup",
			description: "Remove expired workspace invites.",
			schedule: DEFAULT_JOB_SCHEDULES["expired-invite-cleanup"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["expired-invite-cleanup"]),
			run: expiredInviteCleanup,
		},
		{
			name: "expired-password-reset-cleanup",
			description: "Remove used or expired password reset tokens when the table exists.",
			schedule: DEFAULT_JOB_SCHEDULES["expired-password-reset-cleanup"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["expired-password-reset-cleanup"]),
			run: expiredPasswordResetCleanup,
		},
		{
			name: "unverified-account-cleanup",
			description: "Hard-delete abandoned local sign-ups that never confirmed their email (no workspace), reclaiming rows so bot/abandoned sign-ups don't bloat the DB.",
			schedule: DEFAULT_JOB_SCHEDULES["unverified-account-cleanup"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["unverified-account-cleanup"]),
			run: unverifiedAccountCleanup,
		},
		{
			name: "expired-storage-pack-sweep",
			description: "Expire storage packs so workspace quota downgrades to the current plan plus active packs.",
			schedule: DEFAULT_JOB_SCHEDULES["expired-storage-pack-sweep"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["expired-storage-pack-sweep"]),
			run: expiredStoragePackSweep,
		},
		{
			name: "audit-retention-prune",
			description: "Prune old workspace audit events.",
			schedule: DEFAULT_JOB_SCHEDULES["audit-retention-prune"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["audit-retention-prune"]),
			run: auditRetentionPrune,
		},
		{
			name: "draft-export-cleanup",
			description: "Delete stale draft export jobs when the export_jobs table exists.",
			schedule: DEFAULT_JOB_SCHEDULES["draft-export-cleanup"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["draft-export-cleanup"]),
			run: draftExportCleanup,
		},
		{
			name: "orphan-edit-asset-gc",
			description: "Reclaim non-destructive edit-layer assets (mask/patch/cache) referenced by neither live state nor any version snapshot, so their CoW blobs drop to ref_count=0 for the orphan-blob GC to free.",
			schedule: DEFAULT_JOB_SCHEDULES["orphan-edit-asset-gc"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["orphan-edit-asset-gc"]),
			run: orphanEditAssetGc,
		},
		{
			name: "orphan-blob-gc",
			description: "Free content_blobs (and their object-storage objects) whose CoW ref_count has dropped to zero after project/asset deletes reclaimed their references.",
			schedule: DEFAULT_JOB_SCHEDULES["orphan-blob-gc"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["orphan-blob-gc"]),
			run: orphanBlobGc,
		},
		{
			name: "expired-work-lock-sweep",
			description: "Physically release work locks whose lease expired, replacing the old per-request full-table sweep (acquire/release/extend/read are now lazy/time-aware).",
			schedule: DEFAULT_JOB_SCHEDULES["expired-work-lock-sweep"],
			nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["expired-work-lock-sweep"]),
			run: expiredWorkLockSweep,
		},
	];
}

async function expiredWorkLockSweep(client: CronSqlClient, context: CronJobContext): Promise<void> {
	if (!(await tableExists(client, "work_locks"))) return;
	// Mirrors PostgresWorkLockStore.sweepExpiredLocks(): mark every lease whose
	// auto_release_at has passed as system-released, freeing its partial-unique slot.
	// BOUNDED per batch (and capped at CLEANUP_MAX_BATCHES_PER_TICK) so a large expired
	// backlog — e.g. after the cron worker was disabled for a while — can't hold
	// row/index locks long enough to stall acquires or the sequential cron runner; the
	// remainder is drained on the next tick. Correctness never depends on this sweep
	// (reads/extends are time-aware; re-acquire self-heals each scope).
	await runBoundedCleanup(client, {
		operation: "UPDATE",
		table: "work_locks",
		setClause: "released_at = auto_release_at, released_by = 'system', release_reason = 'auto_expired'",
		whereClause: "released_at IS NULL AND auto_release_at <= now()",
		batchSize: context.config.cleanupBatchSize,
	});
}

async function monthlyCreditReset(client: CronSqlClient, context: CronJobContext): Promise<void> {
	// When the API persists usage to the file ledger, reservations never reach
	// Postgres usage_events, so scanning it here would release nothing and could
	// not see active file-backed reservations. Skip rather than give a false
	// sense of cleanup; the job only does real work when the ledger is Postgres.
	if (context.config.usageLedgerStore !== "postgres") return;
	if (!(await tableExists(client, "usage_events"))) return;
	const periodKey = `${context.now.getUTCFullYear()}-${String(context.now.getUTCMonth() + 1).padStart(2, "0")}`;
	// Only release reservations that are *demonstrably abandoned*: the
	// `ai_credit_reserved` event is older than the abandon window AND no terminal
	// capture/release event exists. The live AI queue (Redis/file-backed, see
	// services/queue.ts) — not the `ai_jobs` table — is the source of truth for
	// active jobs, and it is not visible from here, so we never use job presence
	// as the release signal. Age alone keeps a job queued just before the month
	// boundary (the codex cross-month scenario) reserved until it is old enough
	// to be unambiguously stale, preventing settleAiCredit from seeing a
	// premature terminal `ai_credit_released` and skipping the real capture.
	await client.unsafe(`
		INSERT INTO usage_events (
			event_id,
			workspace_id,
			project_id,
			kind,
			subject_id,
			idempotency_key,
			amount_thb,
			amount_units,
			metadata,
			created_at,
			actor_user_id
		)
		SELECT
			'monthly-credit-reset:' || reserved.workspace_id || ':' || reserved.subject_id || ':' || $1,
			reserved.workspace_id,
			reserved.project_id,
			'ai_credit_released',
			reserved.subject_id,
			'monthly-credit-reset:' || reserved.workspace_id || ':' || reserved.subject_id || ':' || $1,
			COALESCE(reserved.amount_thb, 0),
			COALESCE(reserved.amount_units, 0),
			jsonb_build_object('reason', 'monthly_credit_reset', 'periodKey', $1),
			$2::timestamptz,
			reserved.actor_user_id
		FROM usage_events reserved
		WHERE reserved.kind = 'ai_credit_reserved'
			AND reserved.created_at < $2::timestamptz - ($3::int * interval '1 day')
			AND NOT EXISTS (
				SELECT 1
				FROM usage_events terminal
				WHERE terminal.workspace_id = reserved.workspace_id
					AND terminal.subject_id = reserved.subject_id
					AND terminal.project_id IS NOT DISTINCT FROM reserved.project_id
					AND terminal.kind IN ('ai_credit_captured', 'ai_credit_released')
			)
		ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
	`, [periodKey, context.now.toISOString(), context.config.aiReservationAbandonAfterDays]);
}

/**
 * GDPR right-to-erasure enforcement. Anonymizes soft-deleted accounts past the
 * configurable retention window. Unlike the other jobs this does NOT drive raw
 * SQL through the cron client — it goes through the gdprStore / authUserStore
 * abstractions (the SAME stores the API + admin routes use, file OR postgres),
 * which already own the soft-delete state and the owner-protected mutation paths.
 * `runGdprErasureSweep` is idempotent and bounded, so a multi-tick or retried run
 * never double-erases and never blocks the rest of the schedule.
 */
async function gdprErasureSweep(_client: CronSqlClient, context: CronJobContext): Promise<void> {
	const { runGdprErasureSweep } = await import("./gdpr.js");
	const result = await runGdprErasureSweep({
		now: context.now,
		graceDays: context.config.gdprErasureGraceDays,
	});
	if (result.purged > 0 || result.errors > 0) {
		console.log(
			`[CronScheduler] gdpr-erasure-sweep: candidates=${result.candidates} purged=${result.purged} ` +
			`alreadyAnonymized=${result.alreadyAnonymized} errors=${result.errors}`,
		);
	}
}

async function expiredSessionGc(client: CronSqlClient, context: CronJobContext): Promise<void> {
	const batchSize = context.config.cleanupBatchSize;
	if (await tableExists(client, "auth_sessions")) {
		await runBoundedCleanup(client, {
			operation: "DELETE FROM",
			table: "auth_sessions",
			whereClause: "expires_at < now() - interval '7 days'",
			batchSize,
		});
	}
	if (await tableExists(client, "refresh_tokens")) {
		await runBoundedCleanup(client, {
			operation: "DELETE FROM",
			table: "refresh_tokens",
			whereClause: "expires_at < now() - interval '7 days'",
			batchSize,
		});
	}
}

async function expiredInviteCleanup(client: CronSqlClient, context: CronJobContext): Promise<void> {
	if (!(await tableExists(client, "workspace_invites"))) return;
	await runBoundedCleanup(client, {
		operation: "DELETE FROM",
		table: "workspace_invites",
		whereClause: "expires_at < now()",
		batchSize: context.config.cleanupBatchSize,
	});
}

/**
 * Retention sweep for the auth-flow token tables. Drops rows that are spent
 * (`used_at IS NOT NULL`) OR expired (`expires_at < now()`) from BOTH
 * `password_resets` AND `email_verification_tokens` — they carry token_hash +
 * ip_address (+ user_agent on resets), so leaving consumed/expired rows around is
 * needless PII retention.
 *
 * PREVIOUSLY BROKEN: the query referenced a nonexistent `used` column (the schema
 * uses `used_at`), so the job threw on every tick and NOTHING was ever cleaned; it
 * also ignored email_verification_tokens entirely. Both are now handled with the
 * correct `used_at`/`expires_at` predicate.
 */
async function expiredPasswordResetCleanup(client: CronSqlClient, context: CronJobContext): Promise<void> {
	const batchSize = context.config.cleanupBatchSize;
	if (await tableExists(client, "password_resets")) {
		await runBoundedCleanup(client, {
			operation: "DELETE FROM",
			table: "password_resets",
			whereClause: "used_at IS NOT NULL OR expires_at < now()",
			batchSize,
		});
	}
	if (await tableExists(client, "email_verification_tokens")) {
		await runBoundedCleanup(client, {
			operation: "DELETE FROM",
			table: "email_verification_tokens",
			whereClause: "used_at IS NOT NULL OR expires_at < now()",
			batchSize,
		});
	}
}

async function unverifiedAccountCleanup(client: CronSqlClient, context: CronJobContext): Promise<void> {
	if (!(await tableExists(client, "auth_users"))) return;
	const batchSize = Number.isSafeInteger(context.config.cleanupBatchSize) && context.config.cleanupBatchSize > 0
		? context.config.cleanupBatchSize
		: 1000;
	// Hard-delete local sign-ups that never confirmed their email after the TTL.
	// Eligibility is deliberately narrow so this only reaps genuinely abandoned
	// sign-ups and never collides with real data or another flow:
	//   - deleted_at IS NULL: a user who soft-deleted their account (DELETE /api/account)
	//     keeps email_verified=false + an old created_at; without this guard the sweep
	//     would hard-delete it INSIDE its restore grace window (delete_grace_until),
	//     breaking the documented restore path. The gdpr-erasure-sweep owns those rows.
	//   - NOT EXISTS in workspace_members / user_storage_accounts / asset_versions /
	//     support_tickets: skip any account that owns app data. This keeps the bounded
	//     DELETE from violating the NON-cascading storage FKs in 0033_storage_cow, and
	//     from orphaning support tickets (an unverified user CAN open one; deleting
	//     would lose requester identity). Cascading FKs (email_verification_tokens,
	//     oauth_sessions, password_resets) drop with the row.
	// NOTE: we deliberately do NOT guard on the legacy auth_sessions POSTGRES table —
	// the app persists sessions to redis/file (authSessionStore), never that table, so
	// it is always empty and guarding on it is a no-op. Instead we REVOKE each deleted
	// account's redis/file sessions below so its refresh token can't linger until TTL.
	// GUARD vs SCRUB. There are ~40 tables with a plain-text user_id and NO cascading FK to
	// auth_users, so a naive delete could orphan any of them.
	//
	// The PRIMARY defense is now the backend verify wall (blockUnverifiedMutations): an
	// unverified session can no longer write these tables at all, so going forward an
	// abandoned unverified account only ever has auth_users (+ cascade tokens) and possibly a
	// consent_events row from the pre-login cookie banner. These predicates are therefore
	// belt-and-suspenders, justified by two residual cases: (a) the PRE-WALL BACKLOG — accounts
	// created before the wall shipped that already wrote rows; and (b) the wall's deliberate
	// legacy fail-open (a context user whose emailVerified flag is unpopulated). Because the
	// wall stops the writes at the source, this set is FROZEN — no need to keep chasing tables.
	//
	// The two kinds:
	//   • DELIBERATE-ACTIVITY tables (workspace_members, user_storage_accounts/asset_versions
	//     [also NON-cascading FKs that would BLOCK the delete], support_tickets, account_export_jobs,
	//     notification_preferences/notifications, workspace_contacts) → GUARD with NOT EXISTS. An
	//     ACTUALLY-abandoned account never has these rows (verified empirically: of the unverified
	//     accounts in dev, the only such table populated is workspace_members), and guarding can
	//     never orphan — it just declines to reap an account that did something.
	//   • INCIDENTAL tables auto-created for a browser visitor (consent_events from the cookie
	//     banner) → SCRUB in the CTE below, because guarding them would exclude every browser
	//     sign-up from cleanup. Registration itself writes ONLY auth_users (no trigger, no
	//     signup-credit/notification-pref row), so consent_events is the lone incidental table.
	//
	// PRIVILEGED-ROLE EXCLUSION (role IN ('editor','viewer')): an owner can pre-create an
	// owner/admin/support/accountant via the register flow, and that account stays
	// email_verified=false until it confirms — with NONE of the guarded app-data rows. A raw
	// delete would make it eligible and bypass deleteUserProtectingLastOwner, so the nightly
	// job could reap the last active owner and leave the platform with zero owners. We
	// therefore reap ONLY the non-privileged self-signup roles. This is an ALLOWLIST, not a
	// NOT IN (privileged) denylist, so a future role is NEVER auto-deleted until deliberately
	// added here — fail-safe for a hard delete. (Self-registration defaults to 'editor'.)
	//
	// ACTIVE-VERIFICATION GUARD: created_at alone is not "abandoned" — an account created >TTL
	// ago whose owner comes BACK and is mid-verification (just registered/resent an OTP) holds a
	// LIVE email_verification_tokens row (used_at IS NULL, not expired). Reaping it would
	// hard-delete the account and cascade that fresh code out from under them during the OTP
	// window. So we additionally require NO live verification token; an abandoned account's
	// codes expired (15-min TTL) days ago, so it stays eligible.
	const eligible = "email_verified = false AND auth_provider = 'local' AND role IN ('editor', 'viewer') AND deleted_at IS NULL AND created_at < now() - make_interval(days => $1::int) AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM user_storage_accounts usa WHERE usa.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.created_by_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM support_tickets st WHERE st.requester_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM account_export_jobs aej WHERE aej.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notifications nt WHERE nt.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM workspace_contacts wc WHERE wc.owner_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM email_verification_tokens evt WHERE evt.user_id = auth_users.user_id AND evt.used_at IS NULL AND evt.expires_at > now())";
	const accountDelete = `DELETE FROM auth_users WHERE ctid IN (SELECT ctid FROM auth_users WHERE ${eligible} LIMIT $2) RETURNING user_id`;
	const accountDeleteWithEmail = `DELETE FROM auth_users WHERE ctid IN (SELECT ctid FROM auth_users WHERE ${eligible} LIMIT $2) RETURNING user_id, email`;
	// Bounded + resumable like the other cleanups, but we RETURN user_id (not ctid) so we
	// can revoke each deleted account's redis/file sessions below.
	//
	// SCRUB the user-scoped tables with NO cascading FK that a PRE-verification account can
	// still hold, folded into the SAME atomic statement as the account delete (a data-modifying
	// CTE) so a crash can never leave the account row gone but its PII behind — which the next
	// tick could not recover, since it keys off the now-deleted account:
	//   - consent_events: keyed by user_id (cookie-banner PII; migration 0044 left it a bare
	//     text column so a pre-login visitor can record consent). Scrubbed via SELECT user_id.
	//   - auth_login_failures: keyed by the RAW login EMAIL (no user_id column — the pre-auth
	//     login route records brute-force attempts by email/IP). Scrubbed via SELECT email.
	//     Both sides are already normalized lowercase (createUser → normalizeEmail; the lockout
	//     tracker → toLowerCase), so we compare email DIRECTLY rather than lower(email) — that
	//     keeps the (email, failure_at) index (migration 0026) usable instead of forcing a full
	//     scan per batch. The account uniquely owns its email until this delete, so every
	//     current row for that email is the victim's. victims RETURNs email too when any scrub runs.
	// Session revocation stays best-effort outside the statement (it touches redis/file).
	const scrubCtes: string[] = [];
	if (await tableExists(client, "consent_events")) {
		scrubCtes.push("consent_scrub AS (DELETE FROM consent_events WHERE user_id IN (SELECT user_id FROM victims))");
	}
	if (await tableExists(client, "auth_login_failures")) {
		scrubCtes.push("login_failure_scrub AS (DELETE FROM auth_login_failures WHERE email IN (SELECT email FROM victims))");
	}
	const statement = scrubCtes.length > 0
		? `WITH victims AS (${accountDeleteWithEmail}), ${scrubCtes.join(", ")} SELECT user_id FROM victims`
		: accountDelete;
	let total = 0;
	let sessions: { revokeUserSessions(userId: string): Promise<void> } | null = null;
	for (let batch = 0; batch < CLEANUP_MAX_BATCHES_PER_TICK; batch += 1) {
		const rows = await client.unsafe<{ user_id: string }>(statement, [context.config.unverifiedAccountMaxAgeDays, batchSize]);
		const affected = Array.isArray(rows) ? rows.length : 0;
		if (affected === 0) break;
		if (!sessions) sessions = (await import("./auth-sessions.js")).authSessionStore;
		for (const row of rows) {
			await sessions.revokeUserSessions(row.user_id).catch(() => { /* best-effort: the row is already gone */ });
		}
		total += affected;
		if (affected < batchSize) break;
	}
	if (total > 0) {
		console.log(`[CronScheduler] unverified-account-cleanup: deleted ${total} stale unverified sign-up(s)`);
	}
}

async function expiredStoragePackSweep(client: CronSqlClient, context: CronJobContext): Promise<void> {
	const batchSize = context.config.cleanupBatchSize;
	if (await tableExists(client, "storage_packs")) {
		await runBoundedCleanup(client, {
			operation: "UPDATE",
			table: "storage_packs",
			setClause: "active = false, updated_at = now()",
			whereClause: "active = true AND expires_at IS NOT NULL AND expires_at < now()",
			batchSize,
		});
	}
	if (await tableExists(client, "storage_pack_grants")) {
		await runBoundedCleanup(client, {
			operation: "UPDATE",
			table: "storage_pack_grants",
			setClause: "status = 'expired', updated_at = now()",
			whereClause: "status = 'active' AND expires_at IS NOT NULL AND expires_at < now()",
			batchSize,
		});
	}
}

async function auditRetentionPrune(client: CronSqlClient, context: CronJobContext): Promise<void> {
	if (!(await tableExists(client, "audit_events"))) return;
	await runBoundedCleanup(client, {
		operation: "DELETE FROM",
		table: "audit_events",
		whereClause: "created_at < now() - ($1::int * interval '1 day')",
		params: [context.config.auditRetentionDays],
		batchSize: context.config.cleanupBatchSize,
	});
}

async function draftExportCleanup(client: CronSqlClient, context: CronJobContext): Promise<void> {
	if (!(await tableExists(client, "export_jobs"))) return;
	await runBoundedCleanup(client, {
		operation: "DELETE FROM",
		table: "export_jobs",
		whereClause: "status = 'draft' AND created_at < now() - ($1::int * interval '1 hour')",
		params: [context.config.draftExportTtlHours],
		batchSize: context.config.cleanupBatchSize,
	});
}

/**
 * Free CoW content blobs whose ref_count has dropped to zero. Project/asset
 * deletes decrement ref_counts + reclaim quota inline (storage-cow.ts), then the
 * now-unreferenced blob ROWS + their object-storage objects are reclaimed here.
 * Without this scheduled sweep, `gcOrphanBlobs()` was dead code — orphaned blobs
 * (and their objects) were never reclaimed.
 *
 * Drives the shared StorageCowService (same memoized pool the API uses) rather
 * than raw SQL through the cron client, because the eviction must also delete the
 * content/<sha> object from object storage under the same row lock as a
 * concurrent writeBlob — logic that lives in the service, not in a DELETE here.
 * Idempotent + bounded: it only ever evicts blobs that stay at ref_count=0
 * through a re-locked re-check, so a re-run or a concurrent re-reference is safe.
 * Skips quietly when the CoW table or a Postgres DATABASE_URL is absent.
 */
async function orphanBlobGc(client: CronSqlClient): Promise<void> {
	if (!process.env.DATABASE_URL?.trim()) return;
	if (!(await tableExists(client, "content_blobs"))) return;
	const { getSharedStorageCowService } = await import("./storage-cow.js");
	// BOUNDED per tick (ORPHAN_BLOB_GC_BATCH): reclaim at most one batch of
	// orphans so a large backlog never monopolizes the sequential cron runner or
	// spikes memory. Resumable — `hasMore` means the next scheduled tick picks up
	// the remaining orphans.
	const { reclaimed, hasMore } = await getSharedStorageCowService().gcOrphanBlobs();
	if (reclaimed > 0 || hasMore) {
		console.log(
			`[CronScheduler] orphan-blob-gc: freed ${reclaimed} unreferenced content blob(s)` +
			(hasMore ? " (batch cap hit — more remain for the next tick)" : ""),
		);
	}
}

/**
 * Phase D — reclaim non-destructive edit-layer assets (mask/patch/cache) that are
 * referenced by NEITHER live project state NOR any durable version snapshot. Removing
 * the asset_records row drops its CoW blob's ref_count so the orphan-blob-gc pass
 * (scheduled right after) frees the object/bytes. Skips quietly without a Postgres
 * DATABASE_URL / asset_records table (file mode has no cross-project row accumulation).
 */
async function orphanEditAssetGc(client: CronSqlClient): Promise<void> {
	if (!process.env.DATABASE_URL?.trim()) return;
	if (!(await tableExists(client, "asset_records"))) return;
	const { gcOrphanEditAssets } = await import("./edit-asset-gc.js");
	const { scanned, reclaimed } = await gcOrphanEditAssets();
	if (reclaimed > 0) {
		console.log(`[CronScheduler] orphan-edit-asset-gc: reclaimed ${reclaimed} orphan edit asset(s) (scanned ${scanned})`);
	}
}

async function tableExists(client: CronSqlClient, tableName: string): Promise<boolean> {
	const rows = await client.unsafe<{ table_name?: string | null }>("SELECT to_regclass($1) AS table_name", [tableName]);
	return Boolean(rows[0]?.table_name);
}

async function reserveClient(client: CronSqlClient): Promise<CronSqlClient> {
	return client.reserve ? client.reserve() : client;
}

async function acquireJobLock(client: CronSqlClient, name: string): Promise<boolean> {
	const rows = await client.unsafe<{ locked: boolean | string | number }>("SELECT pg_try_advisory_lock($1) AS locked", [hashKey(name)]);
	return rows.some((row) => row.locked === true || row.locked === "t" || row.locked === "true" || row.locked === 1);
}

async function releaseJobLock(client: CronSqlClient, name: string): Promise<void> {
	await client.unsafe("SELECT pg_advisory_unlock($1)", [hashKey(name)]);
}

/**
 * Re-read a single job's next_run_at fresh from the row (used for the under-lock
 * double-run re-check). Returns null when the column is NULL (due now / catch-up)
 * OR the row/timestamp is unreadable — treating "unknown" as "still due" keeps the
 * guard fail-open so a transient read glitch can never silently skip a real run.
 */
async function readJobNextRunAt(client: CronSqlClient, name: string): Promise<Date | null> {
	const rows = await client.unsafe<{ next_run_at?: Date | string | null }>(
		"SELECT next_run_at FROM scheduled_jobs WHERE name = $1",
		[name],
	);
	const raw = rows[0]?.next_run_at;
	if (raw === null || raw === undefined) return null;
	const date = raw instanceof Date ? raw : new Date(raw);
	return Number.isNaN(date.getTime()) ? null : date;
}

async function isJobEnabled(client: CronSqlClient, name: string): Promise<boolean> {
	const rows = await client.unsafe<{ enabled: boolean | string | number }>("SELECT enabled FROM scheduled_jobs WHERE name = $1", [name]);
	if (!rows[0]) return false;
	return rows[0].enabled === true || rows[0].enabled === "t" || rows[0].enabled === "true" || rows[0].enabled === 1;
}

async function recordRun(client: CronSqlClient, input: {
	name: string;
	status: "success" | "error";
	error: string | null;
	lastRunAt: Date;
	/** When null, leave next_run_at as-is so the job stays due and retries. */
	nextRunAt: Date | null;
}): Promise<void> {
	await client.unsafe(`
		UPDATE scheduled_jobs
		SET last_run_at = $2,
			last_status = $3,
			last_error = $4,
			next_run_at = COALESCE($5, next_run_at),
			updated_at = now()
		WHERE name = $1
	`, [
		input.name,
		input.lastRunAt.toISOString(),
		input.status,
		input.error,
		input.nextRunAt ? input.nextRunAt.toISOString() : null,
	]);
}

async function recordSkipped(client: CronSqlClient, name: string): Promise<void> {
	await client.unsafe(`
		UPDATE scheduled_jobs
		SET last_status = 'skipped',
			last_error = 'lock_not_acquired',
			updated_at = now()
		WHERE name = $1
	`, [name]);
}

function mapScheduledJobRow(row: ScheduledJobDbRow): ScheduledJobRow {
	return {
		name: row.name,
		schedule: row.schedule ?? "",
		lastRunAt: toIsoString(row.last_run_at) ?? null,
		lastStatus: parseStatus(row.last_status),
		lastError: row.last_error ?? null,
		nextRunAt: toIsoString(row.next_run_at) ?? null,
		enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true" || row.enabled === 1,
	};
}

function parseStatus(value: string | null | undefined): ScheduledJobStatus | null {
	return value === "success" || value === "error" || value === "skipped" ? value : null;
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text || undefined;
}

function readPositiveEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}
