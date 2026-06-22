import { describe, expect, test } from "bun:test";
import type { Context, Next } from "hono";
import { createAdminCronRouter } from "../routes/admin-cron.js";
import { createMemoryGdprStore } from "../services/gdpr.js";
import {
	CronScheduler,
	createDefaultScheduledJobs,
	cronNextRun,
	DEFAULT_JOB_SCHEDULES,
	hashKey,
	isSchedulerEnabled,
	type CronRunResult,
	type CronSqlClient,
	type ScheduledJobDefinition,
	type ScheduledJobRow,
} from "../services/cron-scheduler.js";

const FIXED_NOW = new Date("2026-06-02T00:00:00.000Z");

describe("CronScheduler", () => {
	test("acquires a pg advisory lock before running a job and records success + next_run_at", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true });
		let ran = false;
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("monthly-credit-reset", async () => {
				ran = true;
			})],
		});

		const result = await scheduler.forceRun("monthly-credit-reset");

		expect(result).toEqual({ name: "monthly-credit-reset", status: "success" });
		expect(ran).toBe(true);
		expect(client.lockAttempts).toEqual([hashKey("monthly-credit-reset")]);
		expect(client.unlockAttempts).toEqual([hashKey("monthly-credit-reset")]);
		const row = client.rows.get("monthly-credit-reset");
		expect(row).toMatchObject({
			last_status: "success",
			last_error: null,
			last_run_at: FIXED_NOW.toISOString(),
		});
		// next_run_at must advance past now after a successful run
		expect(row?.next_run_at).toBe(new Date(FIXED_NOW.getTime() + 60_000).toISOString());
	});

	test("skips a job when the pg advisory lock is already held (second replica posture)", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: false });
		let ran = false;
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("expired-session-gc", async () => {
				ran = true;
			})],
		});

		const result = await scheduler.forceRun("expired-session-gc");

		expect(result).toEqual({ name: "expired-session-gc", status: "skipped", error: "lock_not_acquired" });
		expect(ran).toBe(false);
		expect(client.lockAttempts).toEqual([hashKey("expired-session-gc")]);
		expect(client.unlockAttempts).toEqual([]);
		expect(client.rows.get("expired-session-gc")).toMatchObject({
			last_status: "skipped",
			last_error: "lock_not_acquired",
		});
	});

	test("re-checks due-ness under the lock and skips a job another replica already advanced", async () => {
		// Multi-replica double-run guard: replica B snapshots a job as due, but replica
		// A runs it and advances next_run_at into the future before B acquires the
		// advisory lock. After B locks, it must re-read next_run_at and BAIL (no-op)
		// rather than running the same fire twice.
		let ran = false;
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			onLockAcquired: (rows) => {
				const row = rows.get("expired-session-gc");
				if (row) row.next_run_at = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
			},
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("expired-session-gc", async () => { ran = true; })],
		});

		await scheduler.initialize();
		// Seed the job as due so runDueJobs picks it up before the lock re-check.
		const row = client.rows.get("expired-session-gc")!;
		row.next_run_at = "2026-06-01T00:00:00.000Z";

		const results = await scheduler.runDueJobs();

		expect(ran).toBe(false);
		expect(results).toEqual([{ name: "expired-session-gc", status: "skipped", error: "not_due" }]);
		// The lock was taken AND released (the finally block) even on the no-op path.
		expect(client.lockAttempts).toEqual([hashKey("expired-session-gc")]);
		expect(client.unlockAttempts).toEqual([hashKey("expired-session-gc")]);
	});

	test("still runs a job that is genuinely due when re-checked under the lock", async () => {
		// Companion: when next_run_at is NOT advanced by a competing replica, the
		// under-lock re-check is a no-op and the job runs normally.
		let ran = false;
		const client = new FakeCronSqlClient({ lockAcquired: true });
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("expired-session-gc", async () => { ran = true; })],
		});

		await scheduler.initialize();
		const row = client.rows.get("expired-session-gc")!;
		row.next_run_at = "2026-06-01T00:00:00.000Z";

		const results = await scheduler.runDueJobs();

		expect(ran).toBe(true);
		expect(results).toEqual([{ name: "expired-session-gc", status: "success" }]);
	});

	test("records a job error and still runs the other due jobs", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true });
		const ran: string[] = [];
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [
				job("expired-invite-cleanup", async () => {
					ran.push("first");
					throw new Error("cleanup failed");
				}),
				job("audit-retention-prune", async () => {
					ran.push("second");
				}),
			],
		});

		await scheduler.initialize();
		for (const row of client.rows.values()) {
			row.next_run_at = "2026-06-01T00:00:00.000Z";
		}
		const results = await scheduler.runDueJobs();

		expect(results).toEqual([
			{ name: "audit-retention-prune", status: "success" },
			{ name: "expired-invite-cleanup", status: "error", error: "cleanup failed" },
		]);
		expect(ran.sort()).toEqual(["first", "second"]);
		expect(client.rows.get("expired-invite-cleanup")).toMatchObject({
			last_status: "error",
			last_error: "cleanup failed",
		});
		expect(client.rows.get("audit-retention-prune")).toMatchObject({
			last_status: "success",
			last_error: null,
		});
	});

	test("skips a disabled job without running it or acquiring the lock", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true });
		let ran = false;
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("draft-export-cleanup", async () => {
				ran = true;
			})],
		});

		await scheduler.initialize();
		const row = client.rows.get("draft-export-cleanup");
		expect(row).toBeDefined();
		row!.enabled = false;
		row!.next_run_at = "2026-06-01T00:00:00.000Z";

		const results = await scheduler.runDueJobs();

		// runDueJobs filters disabled rows at the SQL layer, so nothing executes.
		expect(results).toEqual([]);
		expect(ran).toBe(false);
		expect(client.lockAttempts).toEqual([]);
	});

	test("schedules monthly-credit-reset to fire on the 1st of next month at 00:05 UTC", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true });
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [{
				name: "monthly-credit-reset",
				description: "monthly",
				schedule: DEFAULT_JOB_SCHEDULES["monthly-credit-reset"],
				nextRunAfter: cronNextRun(DEFAULT_JOB_SCHEDULES["monthly-credit-reset"]),
				async run() {},
			}],
		});

		await scheduler.initialize();

		const row = client.rows.get("monthly-credit-reset");
		expect(row?.next_run_at).toBe("2026-07-01T00:05:00.000Z");
	});

	test("monthly-credit-reset releases reservations only by the abandon-window age, not phantom ai_jobs state", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["usage_events"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => new Date("2026-07-01T00:05:00.000Z"),
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "monthly-credit-reset"),
			config: { aiReservationAbandonAfterDays: 7, usageLedgerStore: "postgres" },
		});

		const result = await scheduler.forceRun("monthly-credit-reset");

		expect(result).toEqual({ name: "monthly-credit-reset", status: "success" });
		expect(client.monthlyCreditResetQueries).toHaveLength(1);
		const { query, params } = client.monthlyCreditResetQueries[0]!;
		expect(params).toEqual(["2026-07", "2026-07-01T00:05:00.000Z", 7]);
		// The release predicate is purely age-based: reservation older than the
		// abandon window AND no terminal event. The empty ai_jobs table must NOT
		// be consulted (nothing in the backend writes it; the live queue is the
		// real source of truth and is not visible here).
		expect(query).toContain("reserved.created_at < $2::timestamptz - ($3::int * interval '1 day')");
		expect(query).toContain("terminal.kind IN ('ai_credit_captured', 'ai_credit_released')");
		expect(query).not.toContain("ai_jobs");
	});

	test("monthly-credit-reset is a no-op when the ledger store is file-backed (reservations live outside Postgres)", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["usage_events"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => new Date("2026-07-01T00:05:00.000Z"),
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "monthly-credit-reset"),
			config: { aiReservationAbandonAfterDays: 7, usageLedgerStore: "file" },
		});

		const result = await scheduler.forceRun("monthly-credit-reset");

		expect(result).toEqual({ name: "monthly-credit-reset", status: "success" });
		// No INSERT INTO usage_events should be issued: the API persists to the
		// file ledger, so scanning Postgres would release nothing real and could
		// not see active file-backed reservations.
		expect(client.monthlyCreditResetQueries).toHaveLength(0);
	});

	test("monthly-credit-reset preserves cross-month and captured reservations, releases only abandoned ones", async () => {
		const now = new Date("2026-07-01T00:05:00.000Z");
		const client = new EvaluatingCronSqlClient({
			now,
			abandonAfterDays: 7,
			reservations: [
				// (1) Reserved just before the month boundary; still within the
				//     abandon window, so it MUST be preserved — the codex scenario.
				{ workspaceId: "ws", subjectId: "job-fresh", projectId: "p1", createdAt: "2026-06-30T23:59:00.000Z" },
				// (2) Reserved long before the boundary, older than the abandon
				//     window, no terminal event. MUST be released as abandoned.
				{ workspaceId: "ws", subjectId: "job-abandoned", projectId: "p1", createdAt: "2026-06-01T00:00:00.000Z" },
				// (3) Old reservation that already has a terminal capture. MUST be
				//     preserved (releasing it would undercount provider spend).
				{ workspaceId: "ws", subjectId: "job-captured", projectId: "p1", createdAt: "2026-06-01T00:00:00.000Z" },
			],
			terminalEvents: [
				{ workspaceId: "ws", subjectId: "job-captured", projectId: "p1", kind: "ai_credit_captured" },
			],
		});

		const scheduler = new CronScheduler({
			client,
			now: () => now,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "monthly-credit-reset"),
			config: { aiReservationAbandonAfterDays: 7, usageLedgerStore: "postgres" },
		});

		const result = await scheduler.forceRun("monthly-credit-reset");

		expect(result).toEqual({ name: "monthly-credit-reset", status: "success" });
		expect(client.releasedSubjectIds.sort()).toEqual(["job-abandoned"]);
		expect(client.releasedSubjectIds).not.toContain("job-fresh");
		expect(client.releasedSubjectIds).not.toContain("job-captured");
	});

	test("registers the gdpr-erasure-sweep job, daily at 02:00 UTC", () => {
		const jobs = createDefaultScheduledJobs();
		const sweep = jobs.find((candidate) => candidate.name === "gdpr-erasure-sweep");
		expect(sweep).toBeDefined();
		expect(sweep?.schedule).toBe("0 2 * * *");
		expect(DEFAULT_JOB_SCHEDULES["gdpr-erasure-sweep"]).toBe("0 2 * * *");
		// nextRunAfter resolves to the next 02:00 UTC after FIXED_NOW (2026-06-02T00:00Z).
		expect(sweep?.nextRunAfter(FIXED_NOW).toISOString()).toBe("2026-06-02T02:00:00.000Z");
	});

	test("registers the expired-work-lock-sweep job, every 15 minutes", () => {
		const jobs = createDefaultScheduledJobs();
		const sweep = jobs.find((candidate) => candidate.name === "expired-work-lock-sweep");
		expect(sweep).toBeDefined();
		expect(sweep?.schedule).toBe("*/15 * * * *");
		expect(DEFAULT_JOB_SCHEDULES["expired-work-lock-sweep"]).toBe("*/15 * * * *");
		// Next 15-minute boundary after FIXED_NOW (2026-06-02T00:00Z) is 00:15 UTC.
		expect(sweep?.nextRunAfter(FIXED_NOW).toISOString()).toBe("2026-06-02T00:15:00.000Z");
	});

	// P1 (retention cron regression): the previous SQL referenced a nonexistent
	// `used` column (schema is `used_at`) so the job threw on every tick and NOTHING
	// was cleaned, and it ignored email_verification_tokens entirely. The fix must
	// run without error and DELETE spent/expired rows from BOTH token tables.
	test("expired-password-reset-cleanup runs without error and cleans BOTH token tables by used_at/expires_at", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["password_resets", "email_verification_tokens"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "expired-password-reset-cleanup"),
		});

		const result = await scheduler.forceRun("expired-password-reset-cleanup");

		// Runs green (the old `used = true` SQL would have hit the unhandled-SQL throw
		// in the fake, or a real "column used does not exist" error in Postgres).
		expect(result).toEqual({ name: "expired-password-reset-cleanup", status: "success" });
		// BOTH tables are swept, each with the correct used_at/expires_at predicate,
		// and each is BOUNDED per tick (ctid IN (… LIMIT $N) — codex availability fix).
		expect(client.deleteQueries).toHaveLength(2);
		expect(client.deleteQueries).toContain(
			"DELETE FROM password_resets WHERE ctid IN (SELECT ctid FROM password_resets WHERE used_at IS NOT NULL OR expires_at < now() LIMIT $1) RETURNING ctid",
		);
		expect(client.deleteQueries).toContain(
			"DELETE FROM email_verification_tokens WHERE ctid IN (SELECT ctid FROM email_verification_tokens WHERE used_at IS NOT NULL OR expires_at < now() LIMIT $1) RETURNING ctid",
		);
		// Every cleanup statement is batched (no unbounded single-statement DELETE).
		expect(client.deleteQueries.every((q) => q.includes("WHERE ctid IN") && /LIMIT \$\d+/.test(q))).toBe(true);
		// The broken `used` column reference is gone.
		expect(client.deleteQueries.some((q) => /\bused\b(?!_at)/.test(q))).toBe(false);
	});

	test("unverified-account-cleanup deletes stale unverified local sign-ups guarded by workspace membership", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true, existingTables: ["auth_users"] });
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "unverified-account-cleanup"),
		});

		const result = await scheduler.forceRun("unverified-account-cleanup");

		expect(result).toEqual({ name: "unverified-account-cleanup", status: "success" });
		// One bounded DELETE that only targets local, unverified, aged-out accounts with
		// NO workspace relationship — the guard that keeps app data (and the non-cascading
		// storage FK) untouched.
		expect(client.deleteQueries).toHaveLength(1);
		expect(client.deleteQueries[0]).toBe(
			"DELETE FROM auth_users WHERE ctid IN (SELECT ctid FROM auth_users WHERE email_verified = false AND auth_provider = 'local' AND role IN ('editor', 'viewer') AND deleted_at IS NULL AND created_at < now() - make_interval(days => $1::int) AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM user_storage_accounts usa WHERE usa.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.created_by_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM support_tickets st WHERE st.requester_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM account_export_jobs aej WHERE aej.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notifications nt WHERE nt.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM workspace_contacts wc WHERE wc.owner_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM email_verification_tokens evt WHERE evt.user_id = auth_users.user_id AND evt.used_at IS NULL AND evt.expires_at > now()) LIMIT $2) RETURNING user_id",
		);
		// Excludes soft-deleted accounts (their restore grace window) + any account with app data.
		expect(client.deleteQueries[0]).toContain("deleted_at IS NULL");
		// No guard on the (unused, empty) auth_sessions postgres table — sessions live in
		// redis/file and are revoked explicitly instead.
		expect(client.deleteQueries[0]).not.toContain("auth_sessions");
		// Reaps ONLY non-privileged self-signup roles (allowlist) so an unverified owner/admin
		// is never auto-deleted — protects the last-owner invariant the bulk delete bypasses.
		expect(client.deleteQueries[0]).toContain("role IN ('editor', 'viewer')");
		expect(client.deleteQueries[0]).not.toMatch(/'owner'|'admin'|'support'|'accountant'/);
		// Never reap an account that is actively verifying: a live (unused, unexpired) email
		// OTP token means the owner came back and is mid-verification — staleness is not just age.
		expect(client.deleteQueries[0]).toContain("NOT EXISTS (SELECT 1 FROM email_verification_tokens evt WHERE evt.user_id = auth_users.user_id AND evt.used_at IS NULL AND evt.expires_at > now())");
	});

	// GDPR: consent_events.user_id is a bare text column (migration 0044) with NO foreign
	// key to auth_users, so hard-deleting the account does NOT cascade its cookie-consent
	// rows away — the ip_address/user_agent/device_id PII would orphan. The sweep must scrub
	// it ATOMICALLY with the account delete (one data-modifying CTE) so a crash can never
	// leave the account gone but its consent trail behind.
	test("unverified-account-cleanup scrubs consent_events atomically via a CTE with the account delete", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["auth_users", "consent_events"],
			unverifiedUserIds: ["user-a", "user-b"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "unverified-account-cleanup"),
		});

		const result = await scheduler.forceRun("unverified-account-cleanup");

		expect(result).toEqual({ name: "unverified-account-cleanup", status: "success" });
		// A SINGLE statement does both deletes (atomic) — not two separate DELETEs that could
		// crash between and orphan the consent rows.
		expect(client.deleteQueries).toHaveLength(1);
		const sweep = client.deleteQueries[0];
		// One data-modifying CTE: the account delete is the `victims` CTE (RETURNING user_id),
		// and consent_scrub deletes consent for exactly those ids (FROM victims).
		expect(sweep).toBe(
			"WITH victims AS (DELETE FROM auth_users WHERE ctid IN (SELECT ctid FROM auth_users WHERE email_verified = false AND auth_provider = 'local' AND role IN ('editor', 'viewer') AND deleted_at IS NULL AND created_at < now() - make_interval(days => $1::int) AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM user_storage_accounts usa WHERE usa.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.created_by_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM support_tickets st WHERE st.requester_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM account_export_jobs aej WHERE aej.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM notifications nt WHERE nt.user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM workspace_contacts wc WHERE wc.owner_user_id = auth_users.user_id) AND NOT EXISTS (SELECT 1 FROM email_verification_tokens evt WHERE evt.user_id = auth_users.user_id AND evt.used_at IS NULL AND evt.expires_at > now()) LIMIT $2) RETURNING user_id, email), consent_scrub AS (DELETE FROM consent_events WHERE user_id IN (SELECT user_id FROM victims)) SELECT user_id FROM victims",
		);
	});

	test("unverified-account-cleanup scrubs auth_login_failures by email in the same atomic CTE", async () => {
		// auth_login_failures is keyed by the RAW login email (no FK), so the account delete
		// must scrub it case-insensitively via the victims' email — folded into the one CTE so
		// the brute-force PII can't orphan when the account identity is gone.
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["auth_users", "consent_events", "auth_login_failures"],
			unverifiedUserIds: ["user-a"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "unverified-account-cleanup"),
		});

		const result = await scheduler.forceRun("unverified-account-cleanup");

		expect(result).toEqual({ name: "unverified-account-cleanup", status: "success" });
		const sweep = client.deleteQueries.find((q) => q.startsWith("WITH victims AS")) ?? "";
		// victims returns email; both scrubs run in the single statement.
		expect(sweep).toContain("RETURNING user_id, email)");
		expect(sweep).toContain("consent_scrub AS (DELETE FROM consent_events WHERE user_id IN (SELECT user_id FROM victims))");
		expect(sweep).toContain("login_failure_scrub AS (DELETE FROM auth_login_failures WHERE email IN (SELECT email FROM victims))");
	});

	test("unverified-account-cleanup skips the consent scrub when consent_events is absent", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["auth_users"], // consent_events not provisioned
			unverifiedUserIds: ["user-a"],
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "unverified-account-cleanup"),
		});

		const result = await scheduler.forceRun("unverified-account-cleanup");

		expect(result).toEqual({ name: "unverified-account-cleanup", status: "success" });
		// No consent_events table → no scrub statement (the to_regclass guard short-circuits).
		expect(client.deleteQueries.some((q) => q.includes("consent_events"))).toBe(false);
	});

	test("unverified-account-cleanup no-ops when the auth_users table is absent", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true, existingTables: [] });
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "unverified-account-cleanup"),
		});

		const result = await scheduler.forceRun("unverified-account-cleanup");

		expect(result).toEqual({ name: "unverified-account-cleanup", status: "success" });
		expect(client.deleteQueries).toHaveLength(0);
	});

	test("expired-password-reset-cleanup skips a token table that does not exist", async () => {
		const client = new FakeCronSqlClient({
			lockAcquired: true,
			existingTables: ["password_resets"], // email_verification_tokens absent
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "expired-password-reset-cleanup"),
		});

		const result = await scheduler.forceRun("expired-password-reset-cleanup");

		expect(result).toEqual({ name: "expired-password-reset-cleanup", status: "success" });
		expect(client.deleteQueries).toEqual([
			"DELETE FROM password_resets WHERE ctid IN (SELECT ctid FROM password_resets WHERE used_at IS NOT NULL OR expires_at < now() LIMIT $1) RETURNING ctid",
		]);
	});

	// codex availability fix: cleanup jobs must NOT run an unbounded single-statement
	// DELETE/UPDATE. Each tick is capped (CLEANUP_MAX_BATCHES_PER_TICK * batchSize)
	// and resumable — the remainder drains on the next tick.
	test("a cleanup job caps rows per tick (bounded batches) and resumes the backlog next tick", async () => {
		const client = new BatchedBacklogCronSqlClient({
			existingTables: ["auth_sessions"],
			backlog: 250, // more than one batch worth at batchSize=20
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "expired-session-gc"),
			config: { cleanupBatchSize: 20 } as never,
		});

		// Tick 1: drains at most CLEANUP_MAX_BATCHES_PER_TICK (20) batches of 20 = 400
		// cap, but is bounded per STATEMENT to 20 rows. With a 250-row backlog it runs
		// ceil(250/20)=13 bounded statements, never one unbounded DELETE.
		const tick1 = await scheduler.forceRun("expired-session-gc");
		expect(tick1).toEqual({ name: "expired-session-gc", status: "success" });
		// Every issued mutation is bounded: ctid IN (… LIMIT $N), never a bare DELETE.
		expect(client.deleteStatements.length).toBeGreaterThan(1);
		expect(client.deleteStatements.every((q) => q.includes("WHERE ctid IN") && /LIMIT \$\d+/.test(q))).toBe(true);
		// The per-statement LIMIT is exactly the configured batch size.
		expect(client.lastLimitParam).toBe(20);
		// The backlog was fully drained within the per-tick cap (250 < 20*20).
		expect(client.remaining).toBe(0);
	});

	test("a cleanup job stops at the per-tick batch ceiling on a huge backlog (resumes next tick)", async () => {
		const batchSize = 20;
		// A backlog larger than CLEANUP_MAX_BATCHES_PER_TICK (20) * batchSize (20) = 400.
		const client = new BatchedBacklogCronSqlClient({
			existingTables: ["auth_sessions"],
			backlog: 1000,
		});
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "expired-session-gc"),
			config: { cleanupBatchSize: batchSize } as never,
		});

		await scheduler.forceRun("expired-session-gc");

		// Capped: it ran at most the per-tick ceiling of bounded statements and left
		// the rest for the next tick (resumable) — it did NOT churn 1000 rows in one go.
		expect(client.deleteStatements.length).toBeLessThanOrEqual(20);
		expect(client.remaining).toBeGreaterThan(0);
		expect(client.remaining).toBe(1000 - client.deleteStatements.length * batchSize);
	});

	test("registers the orphan-blob-gc job so gcOrphanBlobs is scheduled (storage leak fix)", () => {
		const jobs = createDefaultScheduledJobs();
		const gc = jobs.find((candidate) => candidate.name === "orphan-blob-gc");
		expect(gc).toBeDefined();
		expect(gc?.schedule).toBe("30 4 * * *");
		expect(DEFAULT_JOB_SCHEDULES["orphan-blob-gc"]).toBe("30 4 * * *");
		// Next 04:30 UTC after FIXED_NOW (2026-06-02T00:00Z).
		expect(gc?.nextRunAfter(FIXED_NOW).toISOString()).toBe("2026-06-02T04:30:00.000Z");
	});

	test("orphan-blob-gc no-ops (does not throw) when content_blobs table is absent — idempotent guard", async () => {
		const previousDbUrl = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgres://stub";
		try {
			const client = new FakeCronSqlClient({ lockAcquired: true });
			const scheduler = new CronScheduler({
				client,
				now: () => FIXED_NOW,
				jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "orphan-blob-gc"),
			});
			await scheduler.initialize();
			// Make the job due (its real next run is 04:30 UTC, after FIXED_NOW 00:00).
			const row = client.rows.get("orphan-blob-gc");
			expect(row).toBeDefined();
			row!.next_run_at = "2026-06-01T00:00:00.000Z";

			const results = await scheduler.runDueJobs();
			const gcResult = results.find((r) => r.name === "orphan-blob-gc");
			// to_regclass returns null for the missing table in the fake, so the job
			// skips cleanly with success rather than reaching the CoW service.
			expect(gcResult?.status).toBe("success");
			expect(gcResult?.error).toBeUndefined();
		} finally {
			if (previousDbUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousDbUrl;
		}
	});

	test("gdpr-erasure-sweep job runs end-to-end through the real run function (no-op when nothing is past grace)", async () => {
		// The sweep job drives the gdpr/auth stores (not the cron SQL client). With no
		// pending soft-deletes in the test store it is a clean no-op, which is exactly
		// what we want to assert: the real run wiring executes and reports success
		// without touching the FakeCronSqlClient with any unexpected SQL.
		const client = new FakeCronSqlClient({ lockAcquired: true });
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: createDefaultScheduledJobs().filter((candidate) => candidate.name === "gdpr-erasure-sweep"),
			config: { gdprErasureGraceDays: 45 } as never,
		});
		const result = await scheduler.forceRun("gdpr-erasure-sweep");
		expect(result).toEqual({ name: "gdpr-erasure-sweep", status: "success" });
	});

	test("a failed job stays due (next_run_at untouched) so the next poll retries it", async () => {
		const client = new FakeCronSqlClient({ lockAcquired: true });
		let attempts = 0;
		const scheduler = new CronScheduler({
			client,
			now: () => FIXED_NOW,
			jobs: [job("monthly-credit-reset", async () => {
				attempts += 1;
				throw new Error("transient db error");
			})],
		});

		await scheduler.initialize();
		const row = client.rows.get("monthly-credit-reset")!;
		const nextRunBefore = row.next_run_at;
		row.next_run_at = "2026-06-01T00:00:00.000Z";

		const errored = await scheduler.runDueJobs();
		expect(errored).toEqual([{ name: "monthly-credit-reset", status: "error", error: "transient db error" }]);
		// next_run_at must NOT have advanced to the next cron fire; the job is still due.
		expect(row.next_run_at).toBe("2026-06-01T00:00:00.000Z");
		expect(row.last_status).toBe("error");
		void nextRunBefore;

		// The very next poll re-runs the same job rather than skipping the interval.
		const again = await scheduler.runDueJobs();
		expect(again).toEqual([{ name: "monthly-credit-reset", status: "error", error: "transient db error" }]);
		expect(attempts).toBe(2);
	});
});

describe("isSchedulerEnabled", () => {
	test("defaults to true in production", () => {
		expect(isSchedulerEnabled(undefined, "production")).toBe(true);
	});

	test("defaults to false outside production", () => {
		expect(isSchedulerEnabled(undefined, "development")).toBe(false);
		expect(isSchedulerEnabled(undefined, "test")).toBe(false);
		expect(isSchedulerEnabled(undefined, undefined)).toBe(false);
	});

	test("honors explicit SCHEDULER_ENABLED=true even in development", () => {
		expect(isSchedulerEnabled("true", "development")).toBe(true);
		expect(isSchedulerEnabled("1", "development")).toBe(true);
	});

	test("honors explicit SCHEDULER_ENABLED=false even in production", () => {
		expect(isSchedulerEnabled("false", "production")).toBe(false);
		expect(isSchedulerEnabled("0", "production")).toBe(false);
	});
});

describe("admin cron routes", () => {
	test("force-trigger runs a job through the admin route", async () => {
		const scheduler = new FakeAdminCronScheduler();
		const app = createAdminCronRouter({
			scheduler,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => {
				await next();
			},
		});

		const response = await app.request("/jobs/monthly-credit-reset/trigger", { method: "POST" });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			result: { name: "monthly-credit-reset", status: "success" },
		});
		expect(scheduler.triggered).toEqual(["monthly-credit-reset"]);
	});

	test("force-trigger writes an audit row on the REAL force-run path", async () => {
		// Regression: the UI calls THIS route (admin-cron.ts), so the audit must be
		// written here — not on the legacy admin.ts /cron route the UI never hits.
		const scheduler = new FakeAdminCronScheduler();
		const gdpr = createMemoryGdprStore();
		const app = createAdminCronRouter({
			scheduler,
			gdpr,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => { await next(); },
		});

		const response = await app.request("/jobs/monthly-credit-reset/trigger", { method: "POST" });
		expect(response.status).toBe(200);
		const { entries } = await gdpr.listAdminAudit({ action: "admin.cron.force_run" });
		expect(entries.length).toBe(1);
		expect(entries[0]).toMatchObject({
			adminUserId: "admin-1",
			targetKind: "cron_job",
			targetId: "monthly-credit-reset",
		});
		expect(entries[0].detail).toMatchObject({ status: "success" });
	});

	test("a NOT-FOUND force-run does NOT write an audit row", async () => {
		const scheduler = new FakeAdminCronScheduler();
		const gdpr = createMemoryGdprStore();
		const app = createAdminCronRouter({
			scheduler,
			gdpr,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => { await next(); },
		});
		const response = await app.request("/jobs/does-not-exist/trigger", { method: "POST" });
		expect(response.status).toBe(404);
		expect((await gdpr.listAdminAudit({ action: "admin.cron.force_run" })).entries.length).toBe(0);
	});

	test("force-trigger rejects unknown job names with 404", async () => {
		const scheduler = new FakeAdminCronScheduler();
		const app = createAdminCronRouter({
			scheduler,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => {
				await next();
			},
		});

		const response = await app.request("/jobs/does-not-exist/trigger", { method: "POST" });
		expect(response.status).toBe(404);
	});

	test("force-trigger rejects malformed job names with 400", async () => {
		const scheduler = new FakeAdminCronScheduler();
		const app = createAdminCronRouter({
			scheduler,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => {
				await next();
			},
		});

		const response = await app.request("/jobs/UPPERCASE-NAME/trigger", { method: "POST" });
		expect(response.status).toBe(400);
	});

	test("lists scheduler state through the admin route", async () => {
		const scheduler = new FakeAdminCronScheduler();
		const app = createAdminCronRouter({
			scheduler,
			authMiddleware: stubAuth,
			platformAdminGuard: async (_c, next) => {
				await next();
			},
		});

		const response = await app.request("/jobs");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			jobs: [{
				name: "monthly-credit-reset",
				schedule: "5 0 1 * *",
				lastRunAt: null,
				lastStatus: null,
				lastError: null,
				nextRunAt: "2026-07-01T00:05:00.000Z",
				enabled: true,
			}],
		});
	});

	// When no scheduler is injected, the router lazily builds the default
	// CronScheduler — which needs DATABASE_URL. With none configured (file-mode
	// dev / a misconfigured deploy) construction throws; the router must surface
	// that as a clean 503 ("scheduler_unavailable") rather than a raw 500.
	test("returns 503 (not 500) when the scheduler cannot be built (no DATABASE_URL)", async () => {
		const previous = process.env.DATABASE_URL;
		delete process.env.DATABASE_URL;
		try {
			const app = createAdminCronRouter({
				authMiddleware: stubAuth,
				platformAdminGuard: async (_c, next) => {
					await next();
				},
			});

			const listResponse = await app.request("/jobs");
			expect(listResponse.status).toBe(503);
			expect(await listResponse.json()).toMatchObject({ code: "scheduler_unavailable" });

			const triggerResponse = await app.request("/jobs/monthly-credit-reset/trigger", { method: "POST" });
			expect(triggerResponse.status).toBe(503);
			expect(await triggerResponse.json()).toMatchObject({ code: "scheduler_unavailable" });
		} finally {
			if (previous === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previous;
		}
	});
});

function job(name: string, run: ScheduledJobDefinition["run"]): ScheduledJobDefinition {
	return {
		name,
		description: name,
		schedule: "*/1 * * * *",
		nextRunAfter: (now) => new Date(now.getTime() + 60_000),
		run,
	};
}

async function stubAuth(c: Context, next: Next): Promise<void> {
	c.set("user", { userId: "admin-1", email: "admin@example.com", role: "admin" });
	await next();
}

class FakeAdminCronScheduler {
	triggered: string[] = [];

	async listJobs(): Promise<ScheduledJobRow[]> {
		return [{
			name: "monthly-credit-reset",
			schedule: "5 0 1 * *",
			lastRunAt: null,
			lastStatus: null,
			lastError: null,
			nextRunAt: "2026-07-01T00:05:00.000Z",
			enabled: true,
		}];
	}

	async forceRun(name: string): Promise<CronRunResult | null> {
		if (name !== "monthly-credit-reset") return null;
		this.triggered.push(name);
		return { name, status: "success" };
	}
}

interface FakeScheduledJobDbRow {
	name: string;
	schedule: string;
	last_run_at: string | null;
	last_status: string | null;
	last_error: string | null;
	next_run_at: string | null;
	enabled: boolean;
}

class FakeCronSqlClient implements CronSqlClient {
	rows = new Map<string, FakeScheduledJobDbRow>();
	lockAttempts: number[] = [];
	unlockAttempts: number[] = [];
	monthlyCreditResetQueries: Array<{ query: string; params: unknown[] }> = [];
	deleteQueries: string[] = [];
	cleanupQueries: string[] = [];
	private readonly existingTables: Set<string>;
	// Simulated user_ids returned by the auth_users sweep's `RETURNING user_id`, drained
	// on the first DELETE so the lockstep consent-scrub + session-revoke path executes.
	private pendingUnverifiedIds: string[];

	constructor(private readonly options: { lockAcquired: boolean; existingTables?: string[]; unverifiedUserIds?: string[]; onLockAcquired?: (rows: Map<string, FakeScheduledJobDbRow>) => void }) {
		this.existingTables = new Set(options.existingTables ?? []);
		this.pendingUnverifiedIds = [...(options.unverifiedUserIds ?? [])];
	}

	async reserve(): Promise<CronSqlClient & { release?: () => void }> {
		return this;
	}

	release(): void {}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO scheduled_jobs")) {
			// New shape: (name, schedule, next_run_at, ...)
			const name = String(params[0]);
			const schedule = String(params[1] ?? "");
			const nextRunAt = String(params[2] ?? "");
			if (!this.rows.has(name)) {
				this.rows.set(name, {
					name,
					schedule,
					last_run_at: null,
					last_status: null,
					last_error: null,
					next_run_at: nextRunAt,
					enabled: true,
				});
			} else {
				// ON CONFLICT … DO UPDATE keeps schedule current.
				const row = this.rows.get(name)!;
				row.schedule = schedule;
			}
			return [];
		}

		if (normalized.startsWith("SELECT to_regclass")) {
			const tableName = String(params[0]);
			return [{ table_name: this.existingTables.has(tableName) ? tableName : null }] as T[];
		}

		if (normalized.startsWith("INSERT INTO usage_events")) {
			this.monthlyCreditResetQueries.push({ query, params: [...params] });
			return [];
		}

		if (normalized.startsWith("SELECT name FROM scheduled_jobs")) {
			return [...this.rows.values()]
				.filter((row) => row.enabled && (!row.next_run_at || row.next_run_at <= String(params[0])))
				.sort((left, right) => left.name.localeCompare(right.name)) as T[];
		}

		if (normalized.startsWith("SELECT name, schedule, last_run_at")) {
			return [...this.rows.values()].sort((left, right) => left.name.localeCompare(right.name)) as T[];
		}

		if (normalized.startsWith("SELECT enabled FROM scheduled_jobs")) {
			const row = this.rows.get(String(params[0]));
			return (row ? [{ enabled: row.enabled }] : []) as T[];
		}

		// Under-lock double-run re-check: re-read this job's next_run_at fresh.
		if (normalized.startsWith("SELECT next_run_at FROM scheduled_jobs")) {
			const row = this.rows.get(String(params[0]));
			return (row ? [{ next_run_at: row.next_run_at }] : []) as T[];
		}

		if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
			this.lockAttempts.push(Number(params[0]));
			// Simulate a competing replica that advanced next_run_at AFTER this replica
			// snapshotted the job as due but BEFORE this replica re-reads it under lock.
			this.options.onLockAcquired?.(this.rows);
			return [{ locked: this.options.lockAcquired }] as T[];
		}

		if (normalized.startsWith("SELECT pg_advisory_unlock")) {
			this.unlockAttempts.push(Number(params[0]));
			return [{ unlocked: true }] as T[];
		}

		if (normalized.startsWith("UPDATE scheduled_jobs SET last_run_at")) {
			const row = this.rows.get(String(params[0]));
			if (row) {
				row.last_run_at = String(params[1]);
				row.last_status = String(params[2]);
				row.last_error = params[3] === null ? null : String(params[3]);
				// next_run_at = COALESCE($5, next_run_at): null leaves the job due.
				if (params[4] !== null && params[4] !== undefined) {
					row.next_run_at = String(params[4]);
				}
			}
			return [];
		}

		if (normalized.startsWith("UPDATE scheduled_jobs SET last_status = 'skipped'")) {
			const row = this.rows.get(String(params[0]));
			if (row) {
				row.last_status = "skipped";
				row.last_error = "lock_not_acquired";
			}
			return [];
		}

		if (
			normalized.startsWith("DELETE FROM")
			// The unverified-account sweep folds the consent scrub into a data-modifying CTE
			// (`WITH victims AS (DELETE FROM auth_users …), consent_scrub AS (DELETE …) SELECT …`)
			// so the whole statement starts with WITH rather than DELETE.
			|| normalized.startsWith("WITH victims AS")
			|| (normalized.startsWith("UPDATE ") && normalized.includes("WHERE ctid IN"))
		) {
			// Bounded cleanup pattern: DELETE/UPDATE … WHERE ctid IN (SELECT ctid …
			// LIMIT $N) RETURNING ctid. Record the statement so tests can assert it is
			// (a) batched (ctid + LIMIT) and (b) targets the right table/predicate.
			// Return [] (zero affected rows) so runBoundedCleanup's loop terminates
			// after a single batch — exactly the resumable "drained this tick" path.
			this.cleanupQueries.push(normalized);
			this.deleteQueries.push(normalized);
			// The unverified-account sweep returns `user_id` (not ctid) so the job can revoke
			// sessions in lockstep. Both the plain delete and the consent-scrub CTE delete from
			// auth_users; drain the simulated ids ONCE.
			if (normalized.includes("DELETE FROM auth_users") && this.pendingUnverifiedIds.length > 0) {
				const drained = this.pendingUnverifiedIds;
				this.pendingUnverifiedIds = [];
				return drained.map((user_id) => ({ user_id })) as T[];
			}
			return [];
		}

		throw new Error(`Unhandled fake SQL: ${normalized}`);
	}
}

interface EvaluatingReservation {
	workspaceId: string;
	subjectId: string;
	projectId: string | null;
	createdAt: string;
}

interface EvaluatingTerminalEvent {
	workspaceId: string;
	subjectId: string;
	projectId: string | null;
	kind: "ai_credit_captured" | "ai_credit_released";
}

/**
 * A cron SQL fake that actually evaluates the monthly-credit-reset
 * INSERT … SELECT predicate (instead of only recording the query text), so the
 * release decision is exercised for the codex scenario: a reservation created
 * just before the month boundary that is still within the abandon window must
 * NOT be released. Release is purely age-based on the real usage_events data —
 * there is no ai_jobs lookup, because nothing in the backend writes that table.
 */
class EvaluatingCronSqlClient implements CronSqlClient {
	releasedSubjectIds: string[] = [];
	private readonly rows = new Map<string, FakeScheduledJobDbRow>();
	private readonly now: Date;
	private readonly abandonAfterDays: number;
	private readonly reservations: EvaluatingReservation[];
	private readonly terminalEvents: EvaluatingTerminalEvent[];

	constructor(options: {
		now: Date;
		abandonAfterDays: number;
		reservations: EvaluatingReservation[];
		terminalEvents: EvaluatingTerminalEvent[];
	}) {
		this.now = options.now;
		this.abandonAfterDays = options.abandonAfterDays;
		this.reservations = options.reservations;
		this.terminalEvents = options.terminalEvents;
	}

	async reserve(): Promise<CronSqlClient & { release?: () => void }> {
		return this;
	}

	release(): void {}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO scheduled_jobs")) {
			const name = String(params[0]);
			if (!this.rows.has(name)) {
				this.rows.set(name, {
					name,
					schedule: String(params[1] ?? ""),
					last_run_at: null,
					last_status: null,
					last_error: null,
					next_run_at: String(params[2] ?? ""),
					enabled: true,
				});
			}
			return [];
		}

		if (normalized.startsWith("SELECT to_regclass")) {
			// usage_events exists for this fixture.
			return [{ table_name: String(params[0]) }] as T[];
		}

		if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
			return [{ locked: true }] as T[];
		}

		if (normalized.startsWith("SELECT pg_advisory_unlock")) {
			return [{ unlocked: true }] as T[];
		}

		if (normalized.startsWith("SELECT enabled FROM scheduled_jobs")) {
			return [{ enabled: true }] as T[];
		}

		if (normalized.startsWith("INSERT INTO usage_events")) {
			// Evaluate the same predicate the SQL WHERE encodes: reservation older
			// than the abandon window AND no terminal event.
			const nowMs = this.now.getTime();
			const abandonCutoffMs = nowMs - this.abandonAfterDays * 24 * 60 * 60 * 1000;
			for (const reservation of this.reservations) {
				if (Date.parse(reservation.createdAt) >= abandonCutoffMs) continue;

				const hasTerminal = this.terminalEvents.some((event) => (
					event.workspaceId === reservation.workspaceId
					&& event.subjectId === reservation.subjectId
					&& event.projectId === reservation.projectId
				));

				if (!hasTerminal) {
					this.releasedSubjectIds.push(reservation.subjectId);
				}
			}
			return [];
		}

		if (normalized.startsWith("UPDATE scheduled_jobs SET last_run_at")) {
			return [];
		}

		throw new Error(`Unhandled evaluating fake SQL: ${normalized}`);
	}
}

/**
 * A cron SQL fake with a simulated cleanup BACKLOG. It actually honors the
 * bounded-cleanup `… WHERE ctid IN (SELECT ctid … LIMIT $N) RETURNING ctid`
 * pattern: each statement deletes min(remaining, $N) rows and RETURNS that many
 * ctids, so runBoundedCleanup's loop + per-tick ceiling can be exercised end to
 * end. Asserts the per-statement bound (it never deletes more than $N at once).
 */
class BatchedBacklogCronSqlClient implements CronSqlClient {
	deleteStatements: string[] = [];
	lastLimitParam = 0;
	remaining: number;
	private readonly rows = new Map<string, FakeScheduledJobDbRow>();
	private readonly existingTables: Set<string>;

	constructor(options: { existingTables: string[]; backlog: number }) {
		this.existingTables = new Set(options.existingTables);
		this.remaining = options.backlog;
	}

	async reserve(): Promise<CronSqlClient & { release?: () => void }> {
		return this;
	}

	release(): void {}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO scheduled_jobs")) {
			const name = String(params[0]);
			if (!this.rows.has(name)) {
				this.rows.set(name, {
					name,
					schedule: String(params[1] ?? ""),
					last_run_at: null,
					last_status: null,
					last_error: null,
					next_run_at: String(params[2] ?? ""),
					enabled: true,
				});
			}
			return [];
		}
		if (normalized.startsWith("SELECT to_regclass")) {
			const tableName = String(params[0]);
			return [{ table_name: this.existingTables.has(tableName) ? tableName : null }] as T[];
		}
		if (normalized.startsWith("SELECT pg_try_advisory_lock")) return [{ locked: true }] as T[];
		if (normalized.startsWith("SELECT pg_advisory_unlock")) return [{ unlocked: true }] as T[];
		if (normalized.startsWith("SELECT enabled FROM scheduled_jobs")) return [{ enabled: true }] as T[];
		if (normalized.startsWith("UPDATE scheduled_jobs SET last_run_at")) return [];

		// The bounded cleanup statement. Delete min(remaining, limit) and RETURN the
		// ctids so the loop can count + decide whether more remain.
		if (normalized.startsWith("DELETE FROM") && normalized.includes("WHERE ctid IN")) {
			this.deleteStatements.push(normalized);
			const limit = Number(params[params.length - 1]);
			this.lastLimitParam = limit;
			const take = Math.min(this.remaining, limit);
			this.remaining -= take;
			return Array.from({ length: take }, () => ({ ctid: "(0,0)" })) as T[];
		}

		throw new Error(`Unhandled backlog fake SQL: ${normalized}`);
	}
}
