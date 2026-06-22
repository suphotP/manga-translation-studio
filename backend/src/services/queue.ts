// Redis/file-backed soft queue for AI jobs.
// Queue state, idempotency, job status, processor leases, and events can be
// persisted in Redis so API replicas and worker processes can scale separately.

import { RedisClient } from "bun";
import { randomUUID } from "crypto";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { DATA_DIR } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { reserveAiCredit, settleAiCreditReservation } from "./usage-ledger.js";
import { consume as consumeCredits, releaseConsumptionsByRef, releasePartialByRef } from "./credits.js";
import { sanitizeAiEventMetadata, sanitizeOptionalAiError } from "../utils/ai-error-sanitizer.js";
import { withTimeout } from "./monitoring.js";
import type { AiCostEstimate, AiJob, AiJobCheckpoint, AiJobCheckpointStep, AiJobEvent, AiJobMarkerView, AiTier, CreditReservation, JobStatus } from "../types/index.js";

// Bound every Redis round-trip so a slow/black-holed store REJECTS instead of
// hanging — a hang would defeat the reject-time fallbacks/compensation that all
// callers already have (#4 Batch E). 500ms is generous for a single command.
const REDIS_SEND_TIMEOUT_MS = 500;

export interface AddJobOptions {
	idempotencyKey?: string;
	idempotencyAliases?: string[];
	admissionLimits?: QueueAdmissionLimits;
	/**
	 * Fencing token (money P1 #2): the jobId that took the idempotency claim. When
	 * set, `add()` rejects with `QueueClaimStolenError` if any target key now carries
	 * a CLAIM owned by a DIFFERENT jobId (i.e. a stale-claim taker fenced this slow
	 * owner out), so a late owner cannot materialize a second active job/charge.
	 */
	expectClaimJobId?: string;
}

export interface RetryJobOptions {
	idempotencyKey?: string;
	admissionLimits?: QueueAdmissionLimits;
	costEstimate?: AiCostEstimate;
}

export interface UpdateJobOptions {
	processorId?: string;
	attempts?: number;
	requireActiveLease?: boolean;
}

export interface QueueProcessorOptions {
	pollIntervalMs?: number;
	keepPollTimerRef?: boolean;
}

export interface QueueStats {
	total: number;
	open: number;
	pending: number;
	processing: number;
	done: number;
	error: number;
	concurrent: number;
	draining: boolean;
	store: "memory" | "file" | "redis";
}

export interface QueueAdmissionLimits {
	maxOpenJobs: number;
	maxPendingJobs: number;
	maxProjectOpenJobs: number;
	maxProjectPendingJobs: number;
	maxProjectReservedThb: number;
	maxTierOpenJobs: Partial<Record<AiTier, number>>;
	retryAfterSeconds: number;
}

export interface QueueAdmissionSnapshot {
	openJobs: number;
	pendingJobs: number;
	processingJobs: number;
	projectOpenJobs: number;
	projectPendingJobs: number;
	tierOpenJobs: number;
	projectReservedThb: number;
}

export interface QueueAdmissionDecision {
	accepted: boolean;
	reason: "queue_draining" | "global_open_limit" | "global_pending_limit" | "project_open_limit" | "project_pending_limit" | "tier_open_limit" | "project_reserved_budget_limit" | null;
	retryAfterSeconds: number;
	limits: QueueAdmissionLimits;
	snapshot: QueueAdmissionSnapshot;
}

/**
 * Metadata for an idempotency claim taken BEFORE the owning submit materializes
 * its job (money P1 #2). `charged` flips to true just BEFORE the owner begins its
 * billing writes (credit debit + usage reservation) and before `add()`, so a
 * stale-claim taker knows it MUST reconcile (release) the dead owner's billing
 * before contending — even if the owner crashed PART-WAY through (or before any)
 * of those writes. The reconcile releases are idempotent no-ops when a write never
 * landed, so flagging early (over-marking) strictly closes the leak window without
 * risking a double-charge. The claim row is removed on `add()` (the key now points
 * at a real job) or on `releaseIdempotencyClaim`.
 */
export interface IdempotencyClaimMeta {
	jobId: string;
	charged: boolean;
	claimedAt: number;
}

/**
 * Compact projection of an EVICTED terminal job — exactly the fields the
 * read-time AI-review-marker self-heal needs (status, resultImageId, error,
 * cost/reservation; see resolveMarkerUpdateFromJob). ~200 bytes vs a full job
 * (prompt/params/events), so it can be retained FAR longer for far less:
 * without it, a user returning after the job-retention window would find
 * their marker stuck `processing` forever (codex retention P1).
 */
export interface TerminalJobProjection {
	jobId: string;
	status: AiJob["status"];
	resultImageId?: string;
	error?: string;
	costEstimate?: AiJob["costEstimate"];
	creditReservation?: AiJob["creditReservation"];
	/** When the full job row was evicted — drives the projection's own retention. */
	evictedAt: number;
}

export interface QueueSnapshot {
	jobs: AiJob[];
	events: [string, AiJobEvent[]][];
	idempotency: [string, string][];
	/**
	 * In-flight idempotency claims (key → metadata) that have NOT yet materialized
	 * into a real job. Optional for backward-compatibility with snapshots written
	 * before claim metadata existed.
	 */
	idempotencyClaims?: [string, IdempotencyClaimMeta][];
	/** Compact survivors of evicted terminal jobs. Optional for old snapshots. */
	terminalProjections?: [string, TerminalJobProjection][];
}

export interface QueueSnapshotStore {
	readonly kind: "memory" | "file" | "redis";
	load(): Promise<QueueSnapshot>;
	loadJob?(jobId: string): Promise<AiJob | undefined>;
	loadEvents?(jobId: string): Promise<AiJobEvent[]>;
	/** Point-read of a compact evicted-terminal projection (see TerminalJobProjection). */
	loadTerminalProjection?(jobId: string): Promise<TerminalJobProjection | undefined>;
	save(snapshot: QueueSnapshot): Promise<void>;
	withMutationLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export class QueueAdmissionError extends Error {
	constructor(readonly admission: QueueAdmissionDecision) {
		super(admission.reason === "queue_draining" ? "AI queue is draining" : "AI queue capacity exceeded");
		this.name = "QueueAdmissionError";
	}
}

export class QueueIdempotencyConflictError extends Error {
	constructor(message = "AI queue idempotency key is already used for a different job") {
		super(message);
		this.name = "QueueIdempotencyConflictError";
	}
}

/**
 * Raised by `add()` when a slow claim owner's idempotency claim was TAKEN OVER by
 * a stale-claim taker before this owner finished (money P1 #2). The fenced owner
 * must refund its own charge and de-dupe onto the taker's job rather than create a
 * second active job/charge. Carries the jobId that now owns the claim, if known.
 */
export class QueueClaimStolenError extends Error {
	constructor(readonly currentClaimJobId?: string) {
		super("AI queue idempotency claim was taken over by another submit");
		this.name = "QueueClaimStolenError";
	}
}

interface ProcessorFailureMetadata {
	message: string;
	retryable?: boolean;
	failureCode?: string;
	retryAfterSeconds?: number;
}

const EMPTY_SNAPSHOT: QueueSnapshot = { jobs: [], events: [], idempotency: [], idempotencyClaims: [], terminalProjections: [] };
const OPEN_JOB_STATUSES = new Set<JobStatus>(["pending", "policy_checking", "waiting_credit", "processing", "retrying"]);
const PENDING_JOB_STATUSES = new Set<JobStatus>(["pending", "policy_checking", "waiting_credit"]);
const PROCESSING_JOB_STATUSES = new Set<JobStatus>(["processing", "retrying"]);
const RETRIABLE_JOB_STATUSES = new Set<JobStatus>(["error", "cancelled", "blocked"]);
// Terminal/parked statuses whose credit reservation must end up `released`.
// A `needs_review` job is never claimed by `claimPendingJobs` and fires no later
// status transition, so if the one-shot release at submit/transition time failed
// (ledger outage) the reservation can sit `reserved` indefinitely. These are the
// states the reservation-release reconciler retries.
const RELEASE_RECONCILE_JOB_STATUSES = new Set<JobStatus>(["error", "cancelled", "blocked", "needs_review"]);
// Terminal statuses a job can be EVICTED from in-process state once its retention
// window expires (memory/snapshot-bloat P1). A job is "done" with its result, or
// terminally failed/cancelled/blocked and refunded — its row exists only to serve
// a late GET /status/:jobId, so it can be aged out. `needs_review` is deliberately
// EXCLUDED: it is parked (not claimed, fires no later transition), is review-
// release-able back to `pending`, and is a reservation-release-reconcile state — so
// its row must survive until an admin/QC resolution or the reconciler settles it.
const EVICTABLE_TERMINAL_JOB_STATUSES = new Set<JobStatus>(["done", "error", "cancelled", "blocked"]);
const DEFAULT_MAX_CONCURRENT_AI_JOBS = 2;
// Terminal-job retention defaults (memory/snapshot-bloat P1). Without a sweep the
// in-process `jobs`/`events` maps — and the WHOLE-snapshot rewrite in persist()
// (file: pretty-printed ai-jobs.json; redis: DEL+re-HSET of every key via one EVAL)
// — grow unbounded with lifetime usage, degrading every state transition linearly.
// Evict a terminal job once it is older than the time cap OR the terminal-job count
// exceeds the size cap (oldest first). 24h keeps a day of history servable for a
// late status poll / support look-up; 500 bounds a burst regardless of age.
const DEFAULT_AI_QUEUE_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AI_QUEUE_MAX_TERMINAL_JOBS = 500;
// Retriable terminal statuses (error/cancelled/blocked — the isRetriableJobStatus
// set) are valid SOURCES for POST /api/ai/status/:jobId/retry: the retry
// reconstructs a fresh job from the source's crop/prompt/credit fields, so evicting
// the source 404s the retry workflow (incl. a failed AI-review marker's retry
// button). They therefore get their OWN, much longer age window — 7 days by default
// — and are EXCLUDED from the terminal-job COUNT cap, so a burst of `done` jobs can
// never displace a still-retriable failure. `done` keeps the 24h window + the count
// cap above. (By design: retrying a failure older than this window 404s — the source
// row is gone.)
const DEFAULT_AI_QUEUE_RETRIABLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Periodic retention-sweep cadence (codex P2). Redis read paths point-read the hash
// and the load-time sweep never persists for redis (unlocked), so during a read-only
// window expired rows linger past retention until some unrelated mutation persists.
// A low-frequency timer (10 min) closes that gap by running the sweep + persist under
// the mutation lock. `<= 0` disables it.
const DEFAULT_AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// Projections are ~200 bytes each, so they get a MUCH longer leash than full
// jobs: 90 days / 20k rows ≈ 4 MB worst-case — cheap insurance that a marker
// can still self-heal months after its job's full row was trimmed.
const DEFAULT_AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_AI_QUEUE_MAX_TERMINAL_PROJECTIONS = 20_000;
// Per-job event-array cap (memory/snapshot-bloat P1). appendEvent() pushes one row
// per status change / checkpoint / credit settlement, so a job that retries or
// thrashes the ledger can accrue an unbounded array that is serialized on every
// persist and served verbatim by GET /status/:jobId. Cap each job's history at this
// many rows, KEEPING the first `KEEP_FIRST` (creation/admission context) plus the
// most-recent tail, with one synthetic `events:truncated` marker between them.
const DEFAULT_AI_QUEUE_MAX_JOB_EVENTS = 200;
const AI_QUEUE_EVENT_KEEP_FIRST = 20;
const DEFAULT_PROCESSING_LEASE_MS = 5 * 60 * 1000;

function normalizeCreditAmount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.ceil(value * 100) / 100;
}

function resolveAiCreditCaptureAmount(job: AiJob): number {
	const reservedThb = normalizeCreditAmount(job.creditReservation?.amountThb);
	const estimatedThb = normalizeCreditAmount(job.costEstimate?.estimatedThb);
	if (estimatedThb <= 0) return reservedThb;
	return reservedThb > 0 ? Math.min(estimatedThb, reservedThb) : estimatedThb;
}

// Monotonic ordering for resume checkpoints so a checkpoint never regresses
// (W4.9). Higher rank = further along the pipeline. `undefined` (no checkpoint
// yet) ranks lowest.
const CHECKPOINT_STEP_RANK: Record<AiJobCheckpointStep, number> = {
	moderated: 1,
	provider_succeeded: 2,
	output_stored: 3,
};

export function checkpointRank(step: AiJobCheckpointStep | undefined): number {
	return step ? CHECKPOINT_STEP_RANK[step] : 0;
}

export function isRetriableJobStatus(status: JobStatus): boolean {
	return RETRIABLE_JOB_STATUSES.has(status);
}

export function isRetriableJob(job: AiJob): boolean {
	return isRetriableJobStatus(job.status) && job.retryable !== false;
}

class MemoryQueueSnapshotStore implements QueueSnapshotStore {
	readonly kind = "memory" as const;

	async load(): Promise<QueueSnapshot> {
		return EMPTY_SNAPSHOT;
	}

	async save(): Promise<void> {
		// Intentional no-op for focused unit tests and local experiments.
	}
}

// Per-FILE async mutex registry for the file-backed queue store. The mutex MUST
// be keyed by the queue file path (not per store instance): multiple JobQueue
// instances in one process (e.g. the API route's `jobQueue` and a worker) each
// build their OWN FileQueueSnapshotStore over the SAME ai-jobs.json, so a
// per-instance lock would not serialize them and concurrent enqueues would still
// clobber each other. Keying by resolved path makes every store over that file
// share one lock chain.
const fileQueueMutationTails = new Map<string, Promise<unknown>>();

class FileQueueSnapshotStore implements QueueSnapshotStore {
	readonly kind = "file" as const;
	private readonly lockKey: string;

	constructor(private readonly persistPath: string) {
		this.lockKey = resolve(persistPath);
	}

	// Serializes the read-modify-write of the shared queue file. The JobQueue keeps
	// the queue in an in-process map and rewrites the WHOLE snapshot on every
	// mutation, so two concurrent operations that each load → mutate → save can race
	// and silently drop a job (last writer wins, having loaded a pre-mutation
	// snapshot). Postgres/Redis modes get row-level / lock-level safety from their
	// stores; file mode had NONE. This in-process, per-file async mutex (paired with
	// a reload under the lock in JobQueue.withMutation) makes each enqueue/dequeue
	// atomic so concurrent enqueues keep every job. Per-process by design: file mode
	// is single-process (multi-replica deployments use the Redis store).
	async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = fileQueueMutationTails.get(this.lockKey) ?? Promise.resolve();
		// Chain onto the previous holder so operations run strictly one-at-a-time.
		// `.catch` keeps a rejected operation from poisoning the chain for the next
		// waiter, while the returned promise still surfaces this operation's result.
		const run = previous.then(() => operation());
		fileQueueMutationTails.set(this.lockKey, run.catch(() => undefined));
		return run;
	}

	async load(): Promise<QueueSnapshot> {
		if (!existsSync(this.persistPath)) return EMPTY_SNAPSHOT;
		try {
			return normalizeQueueSnapshot(readJsonFile<QueueSnapshot>(this.persistPath));
		} catch (error) {
			console.warn(`[Queue] Ignoring malformed AI queue snapshot ${this.persistPath}: ${error instanceof Error ? error.message : String(error)}`);
			return EMPTY_SNAPSHOT;
		}
	}

	async loadJob(jobId: string): Promise<AiJob | undefined> {
		return (await this.load()).jobs.find((job) => job.jobId === jobId);
	}

	async loadEvents(jobId: string): Promise<AiJobEvent[]> {
		return (await this.load()).events.find(([id]) => id === jobId)?.[1] ?? [];
	}

	async loadTerminalProjection(jobId: string): Promise<TerminalJobProjection | undefined> {
		return (await this.load()).terminalProjections?.find(([id]) => id === jobId)?.[1];
	}

	async save(snapshot: QueueSnapshot): Promise<void> {
		// Atomic write so a crash mid-write cannot leave a truncated queue file (which
		// `load` would discard as malformed, silently dropping every queued job).
		writeFileAtomic(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

export class RedisQueueSnapshotStore implements QueueSnapshotStore {
	readonly kind = "redis" as const;
	private readonly client: RedisClient;
	private readonly legacySnapshotKey: string;
	private readonly jobsKey: string;
	private readonly eventsKey: string;
	private readonly idempotencyKey: string;
	private readonly idempotencyClaimsKey: string;
	private readonly terminalProjectionsKey: string;
	private readonly lockKey: string;
	private readonly legacyFileImportedKey: string;
	private activeLockToken?: string;

	constructor(
		url = process.env.REDIS_URL,
		keyPrefix = process.env.AI_QUEUE_REDIS_KEY_PREFIX || "manga-editor:ai-queue",
		private readonly legacyFilePath?: string,
	) {
		// Bun's RedisClient requires a parseable URL at construction (it throws
		// "Invalid URL format" on an empty/undefined arg in current Bun), so fall
		// back to a localhost default instead of relying on a built-in default.
		// The client connects lazily on first command; in production the redis
		// snapshot store is only selected when REDIS_URL is set, so this default
		// is just a safe placeholder (and lets tests inject a mock client).
		this.client = new RedisClient(url?.trim() || "redis://127.0.0.1:6379");
		this.legacySnapshotKey = `${keyPrefix}:snapshot`;
		this.jobsKey = `${keyPrefix}:jobs`;
		this.eventsKey = `${keyPrefix}:events`;
		this.idempotencyKey = `${keyPrefix}:idempotency`;
		this.idempotencyClaimsKey = `${keyPrefix}:idempotency-claims`;
		this.terminalProjectionsKey = `${keyPrefix}:terminal-projections`;
		this.lockKey = `${keyPrefix}:snapshot-lock`;
		this.legacyFileImportedKey = `${keyPrefix}:legacy-file-imported`;
	}

	async load(): Promise<QueueSnapshot> {
		const [jobs, events, idempotency, idempotencyClaims, terminalProjections] = await Promise.all([
			this.readHash(this.jobsKey),
			this.readHash(this.eventsKey),
			this.readHash(this.idempotencyKey),
			this.readHash(this.idempotencyClaimsKey),
			this.readHash(this.terminalProjectionsKey),
		]);
		if (jobs.size > 0 || events.size > 0 || idempotency.size > 0 || idempotencyClaims.size > 0 || terminalProjections.size > 0) {
			return normalizeQueueSnapshot({
				jobs: [...jobs.values()].map((value) => JSON.parse(value)),
				events: [...events.entries()].map(([jobId, value]) => [jobId, JSON.parse(value)]),
				idempotency: [...idempotency.entries()],
				idempotencyClaims: [...idempotencyClaims.entries()].map(([key, value]) => [key, JSON.parse(value)]),
				terminalProjections: [...terminalProjections.entries()].map(([jobId, value]) => [jobId, JSON.parse(value)]),
			});
		}

		const raw = await withTimeout(this.client.send("GET", [this.legacySnapshotKey]), REDIS_SEND_TIMEOUT_MS);
		if (!raw) {
			const imported = await this.importLegacyFileSnapshotIfNeeded();
			return imported ?? EMPTY_SNAPSHOT;
		}
		try {
			return normalizeQueueSnapshot(JSON.parse(String(raw)));
		} catch (error) {
			throw new Error(`Redis AI queue snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async loadJob(jobId: string): Promise<AiJob | undefined> {
		const raw = await withTimeout(this.client.send("HGET", [this.jobsKey, jobId]), REDIS_SEND_TIMEOUT_MS);
		if (!raw) return (await this.loadLegacySnapshotJob(jobId))?.job;
		try {
			const parsed = JSON.parse(String(raw));
			return isAiJob(parsed) ? parsed : undefined;
		} catch (error) {
			throw new Error(`Redis AI queue job ${jobId} is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async loadTerminalProjection(jobId: string): Promise<TerminalJobProjection | undefined> {
		const raw = await withTimeout(this.client.send("HGET", [this.terminalProjectionsKey, jobId]), REDIS_SEND_TIMEOUT_MS);
		if (typeof raw !== "string" || !raw) return undefined;
		try {
			const parsed = JSON.parse(raw) as Partial<TerminalJobProjection>;
			return isTerminalProjectionEntry([jobId, parsed]) ? (parsed as TerminalJobProjection) : undefined;
		} catch {
			// A malformed projection row is best-effort data — treat as absent rather
			// than failing the marker reconcile that asked for it.
			return undefined;
		}
	}

	async loadEvents(jobId: string): Promise<AiJobEvent[]> {
		const raw = await withTimeout(this.client.send("HGET", [this.eventsKey, jobId]), REDIS_SEND_TIMEOUT_MS);
		if (!raw) return (await this.loadLegacySnapshotJob(jobId))?.events ?? [];
		try {
			const parsed = JSON.parse(String(raw));
			return Array.isArray(parsed) ? parsed.filter(isAiJobEvent) : [];
		} catch (error) {
			throw new Error(`Redis AI queue events for ${jobId} are invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async save(snapshot: QueueSnapshot): Promise<void> {
		const lockToken = this.activeLockToken;
		const claims = snapshot.idempotencyClaims ?? [];
		const projections = snapshot.terminalProjections ?? [];
		const args: string[] = [
			lockToken ?? "",
			String(snapshot.jobs.length),
			...snapshot.jobs.flatMap((job) => [job.jobId, JSON.stringify(job)]),
			String(snapshot.events.length),
			...snapshot.events.flatMap(([jobId, events]) => [jobId, JSON.stringify(events)]),
			String(snapshot.idempotency.length),
			...snapshot.idempotency.flatMap(([key, jobId]) => [key, jobId]),
			String(claims.length),
			...claims.flatMap(([key, meta]) => [key, JSON.stringify(meta)]),
			String(projections.length),
			...projections.flatMap(([jobId, projection]) => [jobId, JSON.stringify(projection)]),
		];
		await withTimeout(this.client.send("EVAL", [
			`
				local offset = 1
				local lock_token = ARGV[offset]
				offset = offset + 1
				if lock_token ~= '' and redis.call('GET', KEYS[6]) ~= lock_token then
					return redis.error_reply('AI queue mutation lock was lost before snapshot save')
				end
				redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[7])
				local job_count = tonumber(ARGV[offset])
				offset = offset + 1
				for i = 1, job_count do
					redis.call('HSET', KEYS[1], ARGV[offset], ARGV[offset + 1])
					offset = offset + 2
				end
				local event_count = tonumber(ARGV[offset])
				offset = offset + 1
				for i = 1, event_count do
					redis.call('HSET', KEYS[2], ARGV[offset], ARGV[offset + 1])
					offset = offset + 2
				end
				local idem_count = tonumber(ARGV[offset])
				offset = offset + 1
				for i = 1, idem_count do
					redis.call('HSET', KEYS[3], ARGV[offset], ARGV[offset + 1])
					offset = offset + 2
				end
				local claim_count = tonumber(ARGV[offset])
				offset = offset + 1
				for i = 1, claim_count do
					redis.call('HSET', KEYS[4], ARGV[offset], ARGV[offset + 1])
					offset = offset + 2
				end
				local projection_count = tonumber(ARGV[offset])
				offset = offset + 1
				for i = 1, projection_count do
					redis.call('HSET', KEYS[7], ARGV[offset], ARGV[offset + 1])
					offset = offset + 2
				end
				return 1
			`,
			"7",
			this.jobsKey,
			this.eventsKey,
			this.idempotencyKey,
			this.idempotencyClaimsKey,
			this.legacySnapshotKey,
			this.lockKey,
			this.terminalProjectionsKey,
			...args,
		]), REDIS_SEND_TIMEOUT_MS);
	}

	async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
		const token = randomUUID();
		const deadline = Date.now() + readPositiveIntegerEnv("AI_QUEUE_REDIS_LOCK_WAIT_MS", 5000);
		const ttlMs = readPositiveIntegerEnv("AI_QUEUE_REDIS_LOCK_TTL_MS", 10000);

		while (Date.now() < deadline) {
			const acquired = await withTimeout(this.client.send("SET", [this.lockKey, token, "NX", "PX", String(ttlMs)]), REDIS_SEND_TIMEOUT_MS);
			if (String(acquired).toUpperCase() === "OK") {
				const refreshMs = Math.max(25, Math.floor(ttlMs / 3));
				const renewalTimer = setInterval(() => {
					void this.renewLock(token, ttlMs).catch((error) => {
						console.error(`[Queue] Failed to renew Redis AI queue mutation lock: ${error instanceof Error ? error.message : String(error)}`);
					});
				}, refreshMs);
				(renewalTimer as { unref?: () => void }).unref?.();
				this.activeLockToken = token;
				try {
					return await operation();
				} finally {
					clearInterval(renewalTimer);
					if (this.activeLockToken === token) this.activeLockToken = undefined;
					try {
						await this.releaseLock(token);
					} catch (error) {
						console.error(`[Queue] Failed to release Redis AI queue mutation lock: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		throw new Error("Timed out waiting for Redis AI queue mutation lock");
	}

	private async releaseLock(token: string): Promise<void> {
		await withTimeout(this.client.send("EVAL", [
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
			"1",
			this.lockKey,
			token,
		]), REDIS_SEND_TIMEOUT_MS);
	}

	private async renewLock(token: string, ttlMs: number): Promise<void> {
		await withTimeout(this.client.send("EVAL", [
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return redis.error_reply('AI queue mutation lock token changed') end",
			"1",
			this.lockKey,
			token,
			String(ttlMs),
		]), REDIS_SEND_TIMEOUT_MS);
	}

	private async readHash(key: string): Promise<Map<string, string>> {
		const raw = await withTimeout(this.client.send("HGETALL", [key]), REDIS_SEND_TIMEOUT_MS);
		if (!raw) return new Map();
		if (Array.isArray(raw)) {
			const entries: [string, string][] = [];
			for (let index = 0; index < raw.length; index += 2) {
				if (raw[index] !== undefined && raw[index + 1] !== undefined) {
					entries.push([String(raw[index]), String(raw[index + 1])]);
				}
			}
			return new Map(entries);
		}
		if (typeof raw === "object") {
			return new Map(Object.entries(raw as Record<string, unknown>).map(([field, value]) => [field, String(value)]));
		}
		return new Map();
	}

	private async loadLegacySnapshotJob(jobId: string): Promise<{ job?: AiJob; events: AiJobEvent[] } | undefined> {
		const raw = await withTimeout(this.client.send("GET", [this.legacySnapshotKey]), REDIS_SEND_TIMEOUT_MS);
		if (!raw) return undefined;
		try {
			const snapshot = normalizeQueueSnapshot(JSON.parse(String(raw)));
			return {
				job: snapshot.jobs.find((job) => job.jobId === jobId),
				events: snapshot.events.find(([id]) => id === jobId)?.[1] ?? [],
			};
		} catch (error) {
			throw new Error(`Redis AI queue legacy snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async importLegacyFileSnapshotIfNeeded(): Promise<QueueSnapshot | undefined> {
		if (!this.legacyFilePath || !existsSync(this.legacyFilePath)) return undefined;
		const marker = await withTimeout(this.client.send("GET", [this.legacyFileImportedKey]), REDIS_SEND_TIMEOUT_MS);
		if (marker) return undefined;
		let snapshot: QueueSnapshot;
		try {
			snapshot = normalizeQueueSnapshot(readJsonFile<QueueSnapshot>(this.legacyFilePath));
		} catch (error) {
			console.warn(`[Queue] Ignoring malformed legacy AI queue snapshot ${this.legacyFilePath}: ${error instanceof Error ? error.message : String(error)}`);
			await withTimeout(this.client.send("SET", [this.legacyFileImportedKey, "malformed"]), REDIS_SEND_TIMEOUT_MS);
			return undefined;
		}
		// Projections alone are durable queue state now: after file-mode retention
		// evicts every full job, the projections are all that lets old AI-review
		// markers self-heal — treating such a snapshot as "empty" on a file→redis
		// migration would silently drop them (codex P2).
		if (
			snapshot.jobs.length === 0
			&& snapshot.events.length === 0
			&& snapshot.idempotency.length === 0
			&& (snapshot.terminalProjections?.length ?? 0) === 0
		) {
			await withTimeout(this.client.send("SET", [this.legacyFileImportedKey, "empty"]), REDIS_SEND_TIMEOUT_MS);
			return undefined;
		}
		await this.save(snapshot);
		await withTimeout(this.client.send("SET", [this.legacyFileImportedKey, String(Date.now())]), REDIS_SEND_TIMEOUT_MS);
		return snapshot;
	}
}

export class JobQueue {
	private jobs = new Map<string, AiJob>();
	private terminalProjections = new Map<string, TerminalJobProjection>();
	private events = new Map<string, AiJobEvent[]>();
	private idempotency = new Map<string, string>();
	// In-flight idempotency claims (money P1 #2): key → { jobId, charged }. A claim
	// lives here from claimIdempotency() until the owner add()s its real job (the key
	// then points at a real job and the claim is dropped) or releases the claim.
	private idempotencyClaims = new Map<string, IdempotencyClaimMeta>();
	private processors: ((job: AiJob) => Promise<void>)[] = [];
	// Best-effort hooks invoked once when a job becomes terminally `cancelled`.
	// Used by the AI router to reap the parked provider checkpoint artifact
	// (`aijob_provider_<jobId>.png`) that the in-flight processor's finalize catch
	// deliberately preserves for a "reclaiming worker" — a worker that never comes
	// for a cancelled (terminal) job, so it would otherwise accrue storage forever.
	// Hooks run outside the mutation lock and must never throw (errors are logged);
	// cancellation always succeeds regardless of cleanup outcome.
	private cancelCleanupHooks: ((job: AiJob) => Promise<void> | void)[] = [];
	private processing = new Set<string>();
	private readyPromise?: Promise<void>;
	private processNextRunning = false;
	private processNextRequested = false;
	private draining = false;
	private recoveryTimer?: ReturnType<typeof setInterval>;
	private processorPollTimer?: ReturnType<typeof setInterval>;
	private processNextRetryTimer?: ReturnType<typeof setTimeout>;
	private retentionSweepTimer?: ReturnType<typeof setInterval>;
	private readonly processorId = randomUUID();

	constructor(
		private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT_AI_JOBS,
		persistPath?: string,
		private readonly store: QueueSnapshotStore = createQueueSnapshotStore(persistPath),
		private readonly settleUsageCredit = settleAiCreditReservation,
		// Refund the personal/shareable credits consumed at submission time when a
		// job reaches a terminal failure state. Keyed by jobId (the consume refId)
		// and idempotent, so it is safe to call once per terminal transition.
		private readonly releaseSharedCredits = releaseConsumptionsByRef,
		// Re-charge the personal/shareable credit buckets (the size-flat per-op
		// credit price, 1/9/36) when a refunded job is retried, keyed by the new
		// retry jobId.
		private readonly consumeSharedCredits = consumeCredits,
		// LEGACY back-compat ONLY: refund the unused THB reserve padding to the
		// shared buckets on capture for pre-deploy jobs that were debited in THB
		// (consumedThb). New jobs are debited the flat credit price and need no
		// capture-time refund. Remove once the pre-deploy in-flight queue drains.
		private readonly releaseSharedReserve = releasePartialByRef,
	) {}

	async ready(): Promise<void> {
		this.readyPromise ??= this.loadSnapshot({ recoverInterrupted: this.store.kind !== "redis" })
			.then((swept) => {
				// Boot-time retention shrink for persistent stores: a snapshot bloated by
				// a pre-retention deploy shrinks on first boot, but the persist must go
				// through the LOCKED sweep path (file mutex / redis lock) — never straight
				// from an unlocked load (codex P2). Fire-and-forget: boot readiness must
				// not block on the lock; the sweep re-checks state under it.
				if (swept && this.store.kind !== "memory") void this.runRetentionSweep();
			})
			.catch((error) => {
				// Don't cache a FAILED boot-load forever (issue #4 RT-1): reset so a later
				// ready()/poll re-attempts and the queue auto-recovers when Redis returns.
				// Without this, one transient blip poisons the queue for the whole process
				// lifetime — try/catch at the boot call site alone would never recover.
				this.readyPromise = undefined;
				throw error;
			});
		return this.readyPromise;
	}

	async add(job: AiJob, options: AddJobOptions = {}): Promise<AiJob> {
		let queuedJob: AiJob;
		await this.withMutation(async () => {
			if (this.draining) {
				throw new Error("Queue is draining and cannot accept new jobs");
			}

			const idempotencyKey = options.idempotencyKey || job.idempotencyKey;
			const idempotencyKeys = [...new Set([
				idempotencyKey,
				...(options.idempotencyAliases ?? []),
			].filter((key): key is string => Boolean(key)))];
			for (const key of idempotencyKeys) {
				const existingJobId = this.idempotency.get(key);
				const existingJob = existingJobId ? this.jobs.get(existingJobId) : undefined;
				if (existingJob) {
					queuedJob = existingJob;
					return;
				}
			}

			// FENCE (money P1 #2): if this add carries a claim fencing token, reject when
			// a key's live CLAIM was taken over by a DIFFERENT jobId while this owner was
			// slow. Without this a stale-claim taker (who already reconciled this owner's
			// billing) and this late owner would BOTH materialize a job/charge.
			if (options.expectClaimJobId) {
				for (const key of idempotencyKeys) {
					const claim = this.idempotencyClaims.get(key);
					const mappedJobId = this.idempotency.get(key);
					const claimOwner = claim?.jobId ?? mappedJobId;
					// A claim row OR a bare mapping pointing at a different (non-materialized)
					// jobId means our claim was stolen. If the key is unmapped/owned by us we
					// proceed (a missing claim row for our own jobId is fine — e.g. memory).
					if (
						(claim && claim.jobId !== options.expectClaimJobId)
						|| (mappedJobId && mappedJobId !== options.expectClaimJobId && mappedJobId !== job.jobId)
					) {
						throw new QueueClaimStolenError(claimOwner);
					}
				}
			}

			const admission = this.evaluateAdmission(job, options.admissionLimits ?? readQueueAdmissionLimits());
			if (!admission.accepted) throw new QueueAdmissionError(admission);

			for (const key of idempotencyKeys) {
				this.idempotency.set(key, job.jobId);
				// The key now points at a REAL job; drop any in-flight claim row for it.
				this.idempotencyClaims.delete(key);
			}
			if (idempotencyKey) job.idempotencyKey = idempotencyKey;
			job.attempts ??= 0;
			this.jobs.set(job.jobId, job);
			this.appendEvent(job.jobId, "queued", "Job queued");
			await this.persist();
			queuedJob = job;
		});
		void this.processNext();
		return queuedJob!;
	}

	/**
	 * Atomically CLAIM an idempotency key (or set of aliases) for `jobId` BEFORE the
	 * caller debits credits / reserves usage. This closes the credit double-spend
	 * race (codex money P1): two concurrent duplicate submits used to both pass the
	 * read-only `getByIdempotencyKey` check, both consume credits + reserve usage,
	 * and only de-dupe at `add()` — leaving the loser to refund against its own fresh
	 * jobId (not the deduped subject), leaking the usage reservation. By claiming
	 * here under the SAME queue mutation lock `add()` uses, only ONE concurrent
	 * submit becomes the owner and proceeds to charge; the others learn they lost
	 * BEFORE charging anything.
	 *
	 * The claim is recorded as an early entry in the persisted idempotency map
	 * (key → jobId) for a job that is not yet in `this.jobs`. Both `add()` and
	 * `getByIdempotencyKey` already null-check `this.jobs.get(existingJobId)`, so a
	 * dangling claim never masquerades as a real job. The winner's later `add()`
	 * overwrites the same key with the same jobId and materializes the real job.
	 *
	 * Returns:
	 *  - `{ status: "reused", job }`  — a REAL job already exists for one of the keys
	 *    (idempotent retry); the caller returns it having charged nothing.
	 *  - `{ status: "pending", jobId }` — a concurrent peer holds the claim but has
	 *    not added its job yet; the caller waits for that jobId to materialize and
	 *    returns it, having charged nothing.
	 *  - `{ status: "claimed" }` — the caller now owns every key and must proceed to
	 *    charge + `add()`, releasing the claim (via `releaseIdempotencyClaim`) on any
	 *    failure before a successful `add()`.
	 */
	async claimIdempotency(keys: Array<string | undefined>, jobId: string): Promise<
		| { status: "reused"; job: AiJob }
		| { status: "pending"; jobId: string }
		| { status: "claimed" }
	> {
		const idempotencyKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
		if (idempotencyKeys.length === 0) return { status: "claimed" };
		let result:
			| { status: "reused"; job: AiJob }
			| { status: "pending"; jobId: string }
			| { status: "claimed" } = { status: "claimed" };
		await this.withMutation(async () => {
			for (const key of idempotencyKeys) {
				const existingJobId = this.idempotency.get(key);
				if (!existingJobId) continue;
				const existingJob = this.jobs.get(existingJobId);
				if (existingJob) {
					result = { status: "reused", job: existingJob };
					return;
				}
				// Key is claimed (mapped to a jobId) but the real job is not in the queue
				// yet — a concurrent peer owns it. If WE already own this claim (idempotent
				// re-entry with the same jobId) keep claiming; otherwise yield to the peer.
				if (existingJobId !== jobId) {
					result = { status: "pending", jobId: existingJobId };
					return;
				}
			}
			const claimedAt = Date.now();
			for (const key of idempotencyKeys) {
				this.idempotency.set(key, jobId);
				// Record/refresh claim metadata so a later stale-claim taker can tell a
				// not-yet-charged claim (safe to release) from a charged one (must be
				// billing-reconciled before takeover). Preserve an existing `charged`
				// flag on idempotent re-entry with the same jobId.
				const existing = this.idempotencyClaims.get(key);
				this.idempotencyClaims.set(key, {
					jobId,
					charged: existing?.jobId === jobId ? existing.charged : false,
					claimedAt: existing?.jobId === jobId ? existing.claimedAt : claimedAt,
				});
			}
			await this.persist();
			result = { status: "claimed" };
		});
		return result;
	}

	/**
	 * Mark an owned idempotency claim as needs-reconcile / CHARGED (money P1 #2): the
	 * owner is ABOUT TO debit credits + reserve usage (the flag is set BEFORE the first
	 * irreversible billing write, so a crash mid-charge cannot leave a charged-but-
	 * unflagged claim). A stale-claim taker reads this flag and, when set, reconciles
	 * (releases) the dead owner's billing before contending. OVER-marking is safe: the
	 * reconcile releases are idempotent no-ops when nothing was actually written, and the
	 * flag only affects WHETHER a takeover reconciles, never whether a charge happens
	 * (the atomic single-winner claim still guarantees exactly-once charge). No-op for a
	 * key whose claim is no longer owned by `jobId` (already materialized, released, or
	 * stolen) — the late owner learns it lost at `add()`.
	 */
	async markIdempotencyClaimCharged(keys: Array<string | undefined>, jobId: string): Promise<void> {
		const idempotencyKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
		if (idempotencyKeys.length === 0) return;
		await this.withMutation(async () => {
			let mutated = false;
			for (const key of idempotencyKeys) {
				const meta = this.idempotencyClaims.get(key);
				if (meta && meta.jobId === jobId && !meta.charged) {
					this.idempotencyClaims.set(key, { ...meta, charged: true });
					mutated = true;
				}
			}
			if (mutated) await this.persist();
		});
	}

	/**
	 * Atomically TAKE OVER a stale idempotency claim whose owner never materialized
	 * its job within the wait bound (money P1 #2). Under the queue mutation lock this:
	 *   1. confirms a REAL job did not appear in the meantime (returns it as `reused`);
	 *   2. reads the dead owner's claim metadata (its jobId + whether it CHARGED);
	 *   3. reassigns the claim to `newJobId` — this is the FENCE: a late owner that was
	 *      merely slow now finds the key owned by a different jobId at `add()` and is
	 *      rejected instead of producing a second active job/charge;
	 *   4. returns the dead owner's jobId + charged flag so the taker reconciles
	 *      (releases) that owner's consumption + reservation BEFORE it charges.
	 * Returns `notFound` if the claim already vanished (released/materialized) — the
	 * caller simply re-contends from the top.
	 */
	async takeOverStaleIdempotencyClaim(keys: Array<string | undefined>, staleJobId: string, newJobId: string): Promise<
		| { status: "reused"; job: AiJob }
		| { status: "taken"; staleJobId: string; charged: boolean }
		| { status: "notFound" }
	> {
		const idempotencyKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
		if (idempotencyKeys.length === 0) return { status: "notFound" };
		let result:
			| { status: "reused"; job: AiJob }
			| { status: "taken"; staleJobId: string; charged: boolean }
			| { status: "notFound" } = { status: "notFound" };
		await this.withMutation(async () => {
			// A real job may have materialized for any key while we waited — yield to it.
			for (const key of idempotencyKeys) {
				const existingJobId = this.idempotency.get(key);
				const existingJob = existingJobId ? this.jobs.get(existingJobId) : undefined;
				if (existingJob) {
					result = { status: "reused", job: existingJob };
					return;
				}
			}
			// Find the stale claim still owned by `staleJobId`. Only act if at least one
			// key is still mapped to it (no real job) — otherwise it was already cleaned up.
			let charged = false;
			let found = false;
			for (const key of idempotencyKeys) {
				if (this.idempotency.get(key) === staleJobId && !this.jobs.has(staleJobId)) {
					found = true;
					if (this.idempotencyClaims.get(key)?.charged) charged = true;
				}
			}
			if (!found) {
				result = { status: "notFound" };
				return;
			}
			// Reassign every stale key to the taker (fence the dead/slow owner out).
			const claimedAt = Date.now();
			for (const key of idempotencyKeys) {
				if (this.idempotency.get(key) === staleJobId && !this.jobs.has(staleJobId)) {
					this.idempotency.set(key, newJobId);
					this.idempotencyClaims.set(key, { jobId: newJobId, charged: false, claimedAt });
				}
			}
			await this.persist();
			result = { status: "taken", staleJobId, charged };
		});
		return result;
	}

	/**
	 * Release an idempotency claim taken by `claimIdempotency` when the owning submit
	 * fails before its `add()` succeeds (provider unavailable, moderation block,
	 * admission rejection, credit/usage error, queue error). Only deletes a key that
	 * still points at `jobId` AND has no materialized job, so it can never remove a
	 * peer's claim or a real job's idempotency mapping.
	 */
	async releaseIdempotencyClaim(keys: Array<string | undefined>, jobId: string): Promise<void> {
		const idempotencyKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
		if (idempotencyKeys.length === 0) return;
		await this.withMutation(async () => {
			let mutated = false;
			for (const key of idempotencyKeys) {
				if (this.idempotency.get(key) === jobId && !this.jobs.has(jobId)) {
					this.idempotency.delete(key);
					this.idempotencyClaims.delete(key);
					mutated = true;
				}
			}
			if (mutated) await this.persist();
		});
	}

	async get(jobId: string): Promise<AiJob | undefined> {
		if (this.store.kind === "redis" && this.store.loadJob) {
			const job = await this.store.loadJob(jobId);
			if (job) this.jobs.set(job.jobId, job);
			return job;
		}
		await this.ensureCurrent();
		return this.jobs.get(jobId);
	}

	async getTier(jobId: string): Promise<AiTier | undefined> {
		if (this.store.kind === "redis" && this.store.loadJob) {
			return (await this.store.loadJob(jobId))?.tier;
		}
		await this.ready();
		if (this.store.kind === "redis") return undefined;
		return this.jobs.get(jobId)?.tier;
	}

	async getByIdempotencyKey(idempotencyKey: string | undefined): Promise<AiJob | undefined> {
		await this.ensureCurrent();
		if (!idempotencyKey) return undefined;
		const existingJobId = this.idempotency.get(idempotencyKey);
		return existingJobId ? this.jobs.get(existingJobId) : undefined;
	}

	async registerIdempotencyAlias(jobId: string, idempotencyKey: string | undefined): Promise<AiJob | undefined> {
		if (!idempotencyKey) return undefined;
		let resolvedJob: AiJob | undefined;
		await this.withMutation(async () => {
			const existingJobId = this.idempotency.get(idempotencyKey);
			if (existingJobId) {
				resolvedJob = this.jobs.get(existingJobId);
				return;
			}

			const job = this.jobs.get(jobId);
			if (!job) return;
			this.idempotency.set(idempotencyKey, jobId);
			await this.persist();
			resolvedJob = job;
		});
		return resolvedJob;
	}

	async update(jobId: string, update: Partial<AiJob>, options: UpdateJobOptions = {}): Promise<boolean> {
		return this.withMutation(async () => {
			const job = this.jobs.get(jobId);
			if (!job) return false;
			return this.applyJobUpdate(jobId, job, update, options);
		});
	}

	async updateFromProcessor(job: AiJob, update: Partial<AiJob>): Promise<boolean> {
		// Defense-at-write: this is the ONLY path that carries a RAW provider error
		// into `job.error` — a failed processor passes `failure.message`, which for
		// an OpenAI 401 echoes the API key ("sk-proj-…") and can embed the system
		// prompt. `job.error` is served verbatim over GET /api/ai/status/:jobId AND
		// read by the FE to populate the persisted marker, so sanitize to the
		// allowlist friendly/generic message before it is stored; the full detail
		// stays in server logs only. Other `applyJobUpdate` callers set known-safe
		// constant status strings (e.g. "Cancelled before processing"), so we scope
		// the sanitizer to the provider-failure path and leave those untouched.
		const safeUpdate = "error" in update
			? { ...update, error: sanitizeOptionalAiError(update.error) }
			: update;
		return this.update(job.jobId, safeUpdate, {
			processorId: job.processorId,
			attempts: job.attempts,
			requireActiveLease: true,
		});
	}

	/**
	 * Persist a per-step resume checkpoint for an in-flight job (W4.9). Only the
	 * processor that holds the active lease may advance the checkpoint, and a
	 * checkpoint never moves backwards, so a stale processor (whose lease was
	 * recovered by another worker) cannot clobber newer progress. Best-effort by
	 * design at the call site, but the write itself is lease-guarded and atomic
	 * under the mutation lock. Mutates the passed `job` in place so the caller's
	 * local copy reflects the persisted checkpoint for subsequent steps.
	 */
	async recordCheckpoint(job: AiJob, checkpoint: AiJobCheckpoint): Promise<boolean> {
		return this.withMutation(async () => {
			const current = this.jobs.get(job.jobId);
			if (!current) return false;
			if (!this.canApplyProcessorUpdate(current, {
				processorId: job.processorId,
				attempts: job.attempts,
				requireActiveLease: true,
			}, Date.now())) {
				return false;
			}
			// Never regress the checkpoint: a duplicate/older step write (e.g. a
			// retried persist after a transient error) must not lose progress.
			if (checkpointRank(checkpoint.step) < checkpointRank(current.checkpoint?.step)) {
				job.checkpoint = current.checkpoint;
				return false;
			}
			const next: AiJobCheckpoint = { ...checkpoint, updatedAt: Date.now() };
			current.checkpoint = next;
			current.updatedAt = next.updatedAt;
			job.checkpoint = next;
			this.appendEvent(job.jobId, "checkpoint:recorded", `Job checkpoint advanced to ${next.step}`, {
				step: next.step,
				providerResultImageId: next.providerResultImageId,
				provider: next.provider,
			});
			await this.persist();
			return true;
		});
	}

	async assertActiveProcessor(job: AiJob): Promise<boolean> {
		if (this.store.kind !== "redis") return true;
		let active = false;
		await this.withMutation(async () => {
			const current = this.jobs.get(job.jobId);
			active = Boolean(current && this.canApplyProcessorUpdate(current, {
				processorId: job.processorId,
				attempts: job.attempts,
				requireActiveLease: true,
			}, Date.now()));
		});
		return active;
	}

	/**
	 * Register a best-effort cleanup hook fired once when a job becomes terminally
	 * `cancelled` (from either the pending or the in-flight processing path). The
	 * hook receives the cancelled job snapshot (so it has `projectId`/`jobId`). It
	 * MUST be idempotent and MUST NOT throw — failures are swallowed/logged and
	 * never block the cancellation. Used by the AI router to delete the orphaned
	 * provider checkpoint artifact a cancelled job leaves behind.
	 */
	onCancelCleanup(fn: (job: AiJob) => Promise<void> | void): void {
		this.cancelCleanupHooks.push(fn);
	}

	/** Test hook: drop registered cancel-cleanup hooks between tests. */
	clearCancelCleanupHooksForTesting(): void {
		this.cancelCleanupHooks = [];
	}

	private async runCancelCleanupHooks(job: AiJob): Promise<void> {
		if (this.cancelCleanupHooks.length === 0) return;
		// Pass a shallow snapshot so a hook cannot mutate live queue state, and run
		// outside the mutation lock (the caller invokes this after the lock).
		const snapshot: AiJob = { ...job };
		for (const hook of this.cancelCleanupHooks) {
			try {
				await hook(snapshot);
			} catch (error) {
				console.warn(`[Queue] Cancel-cleanup hook failed for job ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	onProcess(fn: (job: AiJob) => Promise<void>, options: QueueProcessorOptions = {}): void {
		this.processors.push(fn);
		this.startRedisLeaseRecoveryTimer();
		this.startRedisProcessorPollTimer(options);
		this.startRetentionSweepTimer();
		void this.processNext();
	}

	stopProcessing(): void {
		this.processors = [];
		if (this.recoveryTimer) {
			clearInterval(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
		if (this.processorPollTimer) {
			clearInterval(this.processorPollTimer);
			this.processorPollTimer = undefined;
		}
		if (this.processNextRetryTimer) {
			clearTimeout(this.processNextRetryTimer);
			this.processNextRetryTimer = undefined;
		}
		if (this.retentionSweepTimer) {
			clearInterval(this.retentionSweepTimer);
			this.retentionSweepTimer = undefined;
		}
	}

	async cancel(jobId: string): Promise<boolean> {
		let cancelled = false;
		let shouldProcessNext = false;
		let cancelledJob: AiJob | undefined;
		await this.withMutation(async () => {
			const job = this.jobs.get(jobId);
			if (!job) return;

			if (PENDING_JOB_STATUSES.has(job.status)) {
				await this.applyJobUpdate(jobId, job, { status: "cancelled", error: "Cancelled before processing" });
				cancelled = true;
				cancelledJob = { ...job };
				return;
			}

			if (PROCESSING_JOB_STATUSES.has(job.status)) {
				const isActive = this.processing.has(jobId);
				await this.applyJobUpdate(jobId, job, { status: "cancelled", error: "Cancelled during processing" });
				shouldProcessNext = !isActive;
				cancelled = true;
				cancelledJob = { ...job };
			}
		});
		// Best-effort, outside the mutation lock: reap any artifact a cancelled job
		// left behind (e.g. a parked provider checkpoint a terminal job will never
		// have reclaimed). Never blocks the cancel result.
		if (cancelledJob) await this.runCancelCleanupHooks(cancelledJob);
		if (shouldProcessNext) void this.processNext();
		return cancelled;
	}

	async retry(jobId: string, options: RetryJobOptions = {}): Promise<AiJob | null> {
		let queued: AiJob | null = null;
		await this.withMutation(async () => {
			const source = this.jobs.get(jobId);
			if (!source || !isRetriableJob(source)) {
				queued = null;
				return;
			}

			const idempotencyKey = options.idempotencyKey || `retry:${source.jobId}`;
			const existingJobId = this.idempotency.get(idempotencyKey);
			const existingJob = existingJobId ? this.jobs.get(existingJobId) : undefined;
			if (existingJob) {
				const matchesSourceRetry = existingJob.projectId === source.projectId
					&& (existingJob.retryOfJobId === source.jobId || (!existingJob.retryOfJobId && idempotencyKey === `retry:${source.jobId}`));
				if (!matchesSourceRetry) {
					throw new QueueIdempotencyConflictError("Retry idempotency key is already used for a different AI job");
				}
				queued = existingJob;
				return;
			}

			const retryCostEstimate = options.costEstimate ?? source.costEstimate;
			// A BYO-queued source job was admitted with no workspace credit
			// reservation (its own provider key pays). Retrying it must continue on
			// the no-credit BYO path: keep the cost estimate for display, but never
			// derive a creditReservation from it — otherwise the retry would silently
			// reserve workspace credits for a job the customer is paying for directly.
			const retryReservation: CreditReservation | undefined = source.byoQueued
				? undefined
				: retryCostEstimate
					? {
						status: "reserved",
						amountThb: retryCostEstimate.reserveThb,
						currency: retryCostEstimate.currency,
						createdAt: Date.now(),
						reason: "job_retry",
					}
					: source.creditReservation
						? {
							status: "reserved",
							amountThb: source.creditReservation.amountThb,
							currency: source.creditReservation.currency,
							createdAt: Date.now(),
							reason: "job_retry",
						}
						: undefined;
			const retryJob: AiJob = {
				...source,
				jobId: randomUUID(),
				status: "pending",
				attempts: 0,
				error: undefined,
				resultImageId: undefined,
				idempotencyKey,
				retryOfJobId: source.jobId,
				processorId: undefined,
				leaseExpiresAt: undefined,
				heartbeatAt: undefined,
				// A retry is a fresh run from step zero: never inherit the source job's
				// checkpoint (which could otherwise make the retry skip the provider call
				// and reuse a stale/cleaned-up provider artifact).
				checkpoint: undefined,
				quality: retryCostEstimate?.quality ?? source.quality,
				costEstimate: retryCostEstimate,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				// A fresh consumption is recorded below keyed by the new retry jobId.
				creditConsumption: undefined,
				// retryReservation is undefined for BYO-queued source jobs, preserving the
				// credit-free BYO retry path; otherwise it carries the recomputed reserve.
				creditReservation: retryReservation,
			};

			const admission = this.evaluateAdmission(retryJob, options.admissionLimits ?? readQueueAdmissionLimits());
			if (!admission.accepted) throw new QueueAdmissionError(admission);

			let creditReserved = false;
			let sharedCreditConsumed = false;
			try {
				// LOCK ORDER (codex money P1 #2): retry acquires the credit + usage-ledger
				// locks WHILE holding the queue mutation lock (this withMutation) — i.e.
				// queue → credit/usage-ledger. This is the SAME canonical nesting order
				// used by the settlement path (applyJobUpdate → settleCreditReservation →
				// settleUsageLedger) and the reconcilers. The submit path never holds the
				// queue mutex while reserving usage (its reserveAiCredit completes and
				// releases before jobQueue.add takes the queue mutex), so no path ever
				// nests these two locks in the opposite (usage-ledger → queue) order. See
				// the invariant note on withMutation.
				// Re-charge the personal/shareable credit buckets for the retry. The
				// original submission's debit was refunded when the source job failed,
				// so a retry that completes must consume credits again — otherwise
				// retried AI work bypasses the new credit buckets. Keyed by the retry
				// jobId so the terminal-failure refund and capture refund work as usual.
				// Re-charge the SAME amount the source job was debited at submission,
				// IN THE SAME UNIT it was charged in, so the retry bills consistently
				// with how the source job was created:
				//   - NEW jobs: the size-flat credit-unit price (consumedCredits, 1/9/36).
				//   - LEGACY pre-deploy jobs: the THB reserve (consumedThb) — these jobs
				//     were originally debited in THB and have no consumedCredits, so they
				//     must reconsume on the THB basis. (Was reusing
				//     creditReservation.amountThb unconditionally, which over-charged new
				//     jobs ~2-5×; reading only consumedCredits would SKIP the debit for a
				//     legacy job and under-bill it.) Remove the consumedThb fallback once
				//     the pre-deploy in-flight queue drains.
				const reconsumeCredits = source.creditConsumption?.consumedCredits;
				const reconsumeThbLegacy = source.creditConsumption?.consumedThb;
				const reconsumeAmount = reconsumeCredits ?? reconsumeThbLegacy;
				const isLegacyThb = reconsumeCredits == null && reconsumeThbLegacy != null;
				if (source.creditConsumption && reconsumeAmount && reconsumeAmount > 0) {
					// A CreditServiceError (e.g. insufficient credits, 402) propagates to
					// the retry route, which maps it to an HTTP error for the caller.
					await this.consumeSharedCredits(
						source.creditConsumption.workspaceId,
						source.creditConsumption.userId,
						reconsumeAmount,
						"ai_job_retry",
						retryJob.jobId,
					);
					retryJob.creditConsumption = {
						workspaceId: source.creditConsumption.workspaceId,
						userId: source.creditConsumption.userId,
						// Preserve the unit the retry was charged in so the retry's own
						// capture/refund reconciles on the same basis as the debit above.
						...(isLegacyThb
							? { consumedThb: reconsumeAmount }
							: { consumedCredits: reconsumeAmount }),
					};
					sharedCreditConsumed = true;
				}

				if (retryJob.creditReservation) {
					await reserveAiCredit({
						projectId: retryJob.projectId,
						jobId: retryJob.jobId,
						amountThb: retryJob.creditReservation.amountThb,
						idempotencyKey: `ai-credit-retry:${idempotencyKey}`,
						metadata: {
							retryOfJobId: source.jobId,
							tier: retryJob.tier,
							imageId: retryJob.imageId,
							pricingVersion: retryJob.costEstimate?.pricingVersion,
							reserveThb: retryJob.costEstimate?.reserveThb,
						},
					});
					creditReserved = true;
				}

				this.idempotency.set(idempotencyKey, retryJob.jobId);
				this.jobs.set(retryJob.jobId, retryJob);
				this.appendEvent(source.jobId, "retry:created", "Retry job created", { retryJobId: retryJob.jobId });
				this.appendEvent(retryJob.jobId, "queued", "Job queued");
				this.appendEvent(retryJob.jobId, "retry:from", "Retry job queued from failed job", { sourceJobId: source.jobId });
				await this.persist();
				queued = retryJob;
			} catch (error) {
				if (sharedCreditConsumed) {
					await this.releaseSharedCreditsBestEffort(retryJob, "queue_retry_rejected");
				}
				if (creditReserved && retryJob.creditReservation) {
					await this.releaseRetryCreditBestEffort(retryJob, "queue_retry_rejected");
				}
				throw error;
			}
		});
		if (queued) void this.processNext();
		return queued;
	}

	async eventsFor(jobId: string): Promise<AiJobEvent[]> {
		if (this.store.kind === "redis" && this.store.loadEvents) {
			const events = await this.store.loadEvents(jobId);
			this.events.set(jobId, [...events]);
			return [...events];
		}
		await this.ensureCurrent();
		return [...(this.events.get(jobId) || [])];
	}

	async recordEvent(jobId: string, type: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
		await this.withMutation(async () => {
			this.appendEvent(jobId, type, message, metadata);
			await this.persist();
		});
	}

	pause(): void {
		this.draining = true;
	}

	isDraining(): boolean {
		return this.draining;
	}

	activeCount(): number {
		return this.processing.size;
	}

	async waitForIdle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.processing.size > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return this.processing.size === 0;
	}

	/**
	 * SIGTERM drain helper (W4.9). When the drain window expires before in-flight
	 * jobs finish (rolling deploy stop_grace exceeded), proactively mark every job
	 * this processor still holds as re-claimable: flip it back to `pending` and
	 * clear its lease so the replacement worker can pick it up IMMEDIATELY and
	 * resume from its last checkpoint, instead of waiting out the full lease TTL.
	 *
	 * Returns the ids of the jobs that were released. Redis-only: the file/memory
	 * stores recover interrupted `processing` jobs on the next startup load, so
	 * there is no separate lease to release. Each released job keeps its
	 * `checkpoint`, so the resuming worker skips already-completed steps (no
	 * double provider call, no double credit charge).
	 *
	 * IMPORTANT (no double provider call): we only FAST-reclaim jobs whose last
	 * checkpoint is at/after `provider_succeeded`. Those have a durably-parked
	 * provider artifact, so the replacement worker resumes idempotently without
	 * re-calling the provider. A job still at `moderated` (or with no checkpoint)
	 * may have a provider request DISPATCHED but not yet checkpointed; flipping it
	 * back to `pending` immediately would let the replacement worker issue a fresh
	 * (also-billable) provider call while the first is in flight. Those jobs are
	 * intentionally LEFT on their lease so the natural lease-TTL expiry recovers
	 * them later — giving any in-flight provider call time to land its
	 * `provider_succeeded` checkpoint before re-claim.
	 */
	async releaseActiveLeasesForShutdown(): Promise<string[]> {
		if (this.store.kind !== "redis") return [];
		const released: string[] = [];
		await this.withMutation(async () => {
			let mutated = false;
			for (const job of this.jobs.values()) {
				if (job.processorId !== this.processorId) continue;
				if (!PROCESSING_JOB_STATUSES.has(job.status)) continue;
				// Only safe to fast-reclaim once the provider result is parked; below
				// that rank a provider call may be mid-flight (see method docstring).
				if (checkpointRank(job.checkpoint?.step) < checkpointRank("provider_succeeded")) {
					this.appendEvent(job.jobId, "shutdown:lease_retained", "Left job on its lease at shutdown; provider call may be in flight", {
						reason: "shutdown_drain_timeout_inflight_provider",
						checkpoint: job.checkpoint?.step,
					});
					mutated = true;
					continue;
				}
				job.status = "pending";
				// Resume markers are advisory only; clear any prior failure text so a
				// job that resumes successfully is not reported as failed downstream.
				job.error = undefined;
				this.clearProcessingLease(job);
				job.updatedAt = Date.now();
				this.appendEvent(job.jobId, "status:pending", "Job re-queued for resume after worker shutdown", {
					reason: "shutdown_drain_timeout",
					checkpoint: job.checkpoint?.step,
				});
				released.push(job.jobId);
				mutated = true;
			}
			if (mutated) await this.persist();
		});
		return released;
	}

	async stats(): Promise<QueueStats> {
		await this.ensureCurrent();
		let open = 0;
		let pending = 0;
		let processing = 0;
		let done = 0;
		let error = 0;

		for (const job of this.jobs.values()) {
			switch (job.status) {
				case "pending":
				case "policy_checking":
				case "waiting_credit":
					open++;
					pending++;
					break;
				case "processing":
				case "retrying":
					open++;
					processing++;
					break;
				case "done":
					done++;
					break;
				case "error":
				case "cancelled":
				case "blocked":
				case "needs_review":
					error++;
					break;
			}
		}

		return {
			total: this.jobs.size,
			open,
			pending,
			processing,
			done,
			error,
			concurrent: this.processing.size,
			draining: this.draining,
			store: this.store.kind,
		};
	}

	async admissionSnapshot(job: AiJob): Promise<QueueAdmissionSnapshot> {
		await this.ensureCurrent();
		return this.buildAdmissionSnapshot(job);
	}

	async checkAdmission(job: AiJob, limits = readQueueAdmissionLimits()): Promise<QueueAdmissionDecision> {
		await this.ensureCurrent();
		return this.evaluateAdmission(job, limits);
	}

	private buildAdmissionSnapshot(job: AiJob): QueueAdmissionSnapshot {
		let openJobs = 0;
		let pendingJobs = 0;
		let processingJobs = 0;
		let projectOpenJobs = 0;
		let projectPendingJobs = 0;
		let tierOpenJobs = 0;
		let projectReservedThb = 0;

		for (const existing of this.jobs.values()) {
			if (!OPEN_JOB_STATUSES.has(existing.status)) continue;
			openJobs++;
			if (PENDING_JOB_STATUSES.has(existing.status)) pendingJobs++;
			if (existing.status === "processing" || existing.status === "retrying") processingJobs++;
			if (existing.projectId === job.projectId) {
				projectOpenJobs++;
				if (PENDING_JOB_STATUSES.has(existing.status)) projectPendingJobs++;
				if (existing.creditReservation?.status === "reserved") {
					projectReservedThb += existing.creditReservation.amountThb;
				}
			}
			if (existing.tier === job.tier) {
				tierOpenJobs++;
			}
		}

		return {
			openJobs,
			pendingJobs,
			processingJobs,
			projectOpenJobs,
			projectPendingJobs,
			tierOpenJobs,
			projectReservedThb,
		};
	}

	private evaluateAdmission(job: AiJob, limits: QueueAdmissionLimits): QueueAdmissionDecision {
		const snapshot = this.buildAdmissionSnapshot(job);
		const reservedThb = job.creditReservation?.status === "reserved" ? job.creditReservation.amountThb : 0;
		let reason: QueueAdmissionDecision["reason"] = null;

		if (this.draining) {
			reason = "queue_draining";
		} else if (exceedsLimit(snapshot.openJobs, limits.maxOpenJobs)) {
			reason = "global_open_limit";
		} else if (exceedsLimit(snapshot.pendingJobs, limits.maxPendingJobs)) {
			reason = "global_pending_limit";
		} else if (exceedsLimit(snapshot.projectOpenJobs, limits.maxProjectOpenJobs)) {
			reason = "project_open_limit";
		} else if (exceedsLimit(snapshot.projectPendingJobs, limits.maxProjectPendingJobs)) {
			reason = "project_pending_limit";
		} else if (exceedsLimit(snapshot.tierOpenJobs, limits.maxTierOpenJobs[job.tier] ?? Number.POSITIVE_INFINITY)) {
			reason = "tier_open_limit";
		} else if (Number.isFinite(limits.maxProjectReservedThb) && snapshot.projectReservedThb + reservedThb > limits.maxProjectReservedThb) {
			reason = "project_reserved_budget_limit";
		}

		return {
			accepted: reason === null,
			reason,
			retryAfterSeconds: limits.retryAfterSeconds,
			limits,
			snapshot,
		};
	}

	private appendEvent(jobId: string, type: string, message: string, metadata?: Record<string, unknown>): void {
		const events = this.events.get(jobId) || [];
		// Defense-at-write: several failure events record the raw provider error
		// (e.g. `recordEvent(..., { error: err.message })`) and the event list is
		// returned by GET /api/ai/status/:jobId. Allowlist-sanitize any error-shaped
		// metadata value before the event is stored/served so a key/prompt cannot
		// leak through job-event metadata.
		const safeMetadata = sanitizeAiEventMetadata(metadata);
		events.push({ jobId, type, message, metadata: safeMetadata, createdAt: Date.now() });
		this.events.set(jobId, this.capJobEvents(jobId, events));
	}

	/**
	 * Bound a single job's event array (memory/snapshot-bloat P1). A job that retries
	 * or thrashes the credit ledger can otherwise accrue an unbounded history that is
	 * serialized on every persist and served verbatim by GET /status/:jobId. When the
	 * array would exceed `AI_QUEUE_MAX_JOB_EVENTS`, keep the FIRST
	 * `AI_QUEUE_EVENT_KEEP_FIRST` rows (creation/admission/queued context that is most
	 * useful for support look-ups) plus the most-recent tail, and splice a single
	 * synthetic `events:truncated` marker between them so the served history is honest
	 * about the gap. The marker is itself an event, so it counts toward the cap; the
	 * tail length is sized to leave room for it, keeping the array AT MOST the cap.
	 * The returned array keeps the AiJobEvent shape valid for the status route.
	 */
	private capJobEvents(jobId: string, events: AiJobEvent[]): AiJobEvent[] {
		const maxJobEvents = readQueueMaxJobEvents();
		// `+Infinity` (operator disabled the cap) or a within-budget array: keep as-is.
		if (!Number.isFinite(maxJobEvents) || events.length <= maxJobEvents) return events;

		// Defensive: shrink the head allowance so the budget ALWAYS fits head + marker
		// + at least one recent row — otherwise a small cap (e.g. 5, or 21 with the
		// default KEEP_FIRST of 20) would zero out the tail and silently drop the
		// just-recorded status/checkpoint event on every append (codex P3). If even
		// head+marker+tail can't fit (cap ≤ 2), fall back to recent-only.
		const keepFirst = Math.min(AI_QUEUE_EVENT_KEEP_FIRST, Math.max(0, maxJobEvents - 2));
		if (keepFirst <= 0) return events.slice(events.length - maxJobEvents);

		const head = events.slice(0, keepFirst);
		const marker: AiJobEvent = {
			jobId,
			type: "events:truncated",
			message: "Older job events were truncated to bound the event log",
			createdAt: Date.now(),
			metadata: { keptFirst: keepFirst, totalBeforeTruncation: events.length },
		};
		// One slot for the head region is the marker; the rest is the recent tail. Take
		// the LAST `tailCount` rows so the newest events are always preserved.
		const tailCount = maxJobEvents - keepFirst - 1;
		const tail = events.slice(events.length - tailCount);
		return [...head, marker, ...tail];
	}

	private async applyJobUpdate(jobId: string, job: AiJob, update: Partial<AiJob>, options: UpdateJobOptions = {}): Promise<boolean> {
		const now = Date.now();
		const previousStatus = job.status;

		if (!this.canApplyProcessorUpdate(job, options, now)) {
			this.appendEvent(jobId, "status:ignored_stale_processor", "Ignored stale processor update after lease changed", {
				attemptedStatus: update.status,
				expectedProcessorId: options.processorId,
				actualProcessorId: job.processorId,
				expectedAttempts: options.attempts,
				actualAttempts: job.attempts,
			});
			await this.persist();
			return false;
		}

		if (previousStatus === "cancelled" && update.status && update.status !== "cancelled") {
			this.appendEvent(jobId, "status:ignored_after_cancel", `Ignored status change to ${update.status} after cancellation`, {
				attemptedStatus: update.status,
			});
			await this.persist();
			return false;
		}

		const creditSettlement = await this.settleCreditReservation(job, update.status);
		const preserveLeaseForCancelledProcessingJob = this.shouldPreserveLeaseForCancelledProcessingJob(job, previousStatus, update.status, now);
		Object.assign(job, update, { updatedAt: now });
		if (update.status && !PROCESSING_JOB_STATUSES.has(update.status) && !preserveLeaseForCancelledProcessingJob) {
			this.clearProcessingLease(job);
		}
		if (creditSettlement) {
			job.creditReservation = creditSettlement.reservation;
			this.appendEvent(job.jobId, creditSettlement.type, creditSettlement.message, creditSettlement.metadata);
		}

		if (update.status && update.status !== previousStatus) {
			this.appendEvent(jobId, `status:${update.status}`, `Job status changed to ${update.status}`);
			if (RETRIABLE_JOB_STATUSES.has(update.status)) {
				await this.releaseSharedCreditsBestEffort(job, `job_${update.status}`);
			} else if (update.status === "done" && creditSettlement) {
				// NEW jobs: no capture-time partial refund of the credit buckets. The
				// bucket debit is the SIZE-FLAT per-op credit price (1/9/36), not a
				// padded THB reserve, so there is no padding to return on a successful
				// capture; the quoted credit price IS the final charge.
				//
				// LEGACY pre-deploy jobs (consumedThb set, consumedCredits absent) were
				// debited the padded THB reserve at submission, so on capture they still
				// need the unused reserve returned, else a legacy job settling post-deploy
				// permanently overcharges the buckets at the old THB amount. This is a
				// no-op for new jobs (refundUnusedSharedReserveBestEffort early-returns
				// when consumedThb is absent). Remove once the in-flight queue drains.
				await this.refundUnusedSharedReserveBestEffort(job, creditSettlement.reservation);
			}
			// (The separate usage-ledger reservation always settles to its captured THB
			// amount in settleCreditReservation, independent of the bucket accounting.)
		}
		await this.persist();
		return true;
	}

	/**
	 * LEGACY back-compat ONLY. For pre-deploy jobs that debited the personal/
	 * shareable buckets in THB (the padded reserve), refund the difference between
	 * the THB debited at submission and the amount actually captured on success, so
	 * the reserve padding does not permanently overcharge the buckets. New jobs are
	 * debited the size-flat credit price (consumedCredits) with no padding and have
	 * `consumedThb` absent, so this early-returns for them. Best-effort. Remove once
	 * the pre-deploy in-flight queue has drained.
	 */
	private async refundUnusedSharedReserveBestEffort(job: AiJob, reservation: NonNullable<AiJob["creditReservation"]>): Promise<void> {
		const consumption = job.creditConsumption;
		// New jobs charge a flat credit price (consumedCredits) — there is no THB
		// reserve padding to return, so skip them entirely.
		if (!consumption || consumption.consumedThb == null) return;
		const consumedThb = consumption.consumedThb;
		const capturedThb = reservation.status === "captured" ? reservation.amountThb : consumedThb;
		const refundThb = Math.round((consumedThb - capturedThb) * 10_000) / 10_000;
		if (refundThb <= 0) return;
		try {
			const released = await this.releaseSharedReserve(job.jobId, refundThb, "ai_job_reserve_refund");
			const refunded = released.reduce((sum, item) => sum + item.amount, 0);
			// Reduce the recorded (THB) consumption so any later terminal refund
			// (idempotent releaseConsumptionsByRef) does not double-refund the
			// already-returned reserve.
			consumption.consumedThb = Math.round((consumedThb - refunded) * 10_000) / 10_000;
			if (refunded > 0) {
				this.appendEvent(job.jobId, "credit:reserve_refunded", "Refunded unused personal/shareable reserve (legacy THB job)", {
					refundThb: refunded,
					capturedThb,
				});
			}
		} catch (error) {
			console.warn(`[Queue] Failed to refund unused shared reserve for ${job.jobId}: ${error}`);
		}
	}

	private canApplyProcessorUpdate(job: AiJob, options: UpdateJobOptions, now: number): boolean {
		if (!options.requireActiveLease || this.store.kind !== "redis") return true;
		return Boolean(
			options.processorId
			&& job.processorId === options.processorId
			&& job.attempts === options.attempts
			&& PROCESSING_JOB_STATUSES.has(job.status)
			&& this.hasActiveProcessingLease(job, now),
		);
	}

	private async settleCreditReservation(job: AiJob, nextStatus?: AiJob["status"]): Promise<{
		reservation: NonNullable<AiJob["creditReservation"]>;
		type: string;
		message: string;
		metadata?: Record<string, unknown>;
	} | null> {
		if (!nextStatus || job.creditReservation?.status !== "reserved") return null;

		if (nextStatus === "done") {
			const reservedAmountThb = job.creditReservation.reservedAmountThb ?? job.creditReservation.amountThb;
			const capturedAmountThb = resolveAiCreditCaptureAmount(job);
			try {
				await this.settleUsageLedger(job, "captured", "job_done", capturedAmountThb);
			} catch (error) {
				return this.buildCreditSettlementFailure(job, "captured", "job_done", error);
			}
			return {
				reservation: {
					...job.creditReservation,
					status: "captured",
					amountThb: capturedAmountThb,
					reservedAmountThb,
					settledAt: Date.now(),
					reason: "job_done",
				},
				type: "credit:captured",
				message: "Prototype credit reserve captured",
				metadata: {
					amountThb: capturedAmountThb,
					reservedAmountThb,
					releasedAmountThb: Math.max(0, Math.ceil((reservedAmountThb - capturedAmountThb) * 100) / 100),
					currency: job.creditReservation.currency,
				},
			};
		}

		// `needs_review` parks a job for admin/QC release (e.g. soft prompt-moderation
		// warning). The queue never claims it (claimPendingJobs only takes "pending"),
		// so the reserved credit must be released now rather than leaking for the full
		// reservation lifetime. A future review-release path re-reserves before
		// re-queuing as "pending".
		if (nextStatus === "error" || nextStatus === "cancelled" || nextStatus === "blocked" || nextStatus === "needs_review") {
			try {
				await this.settleUsageLedger(job, "released", `job_${nextStatus}`);
			} catch (error) {
				return this.buildCreditSettlementFailure(job, "released", `job_${nextStatus}`, error);
			}
			return {
				reservation: {
					...job.creditReservation,
					status: "released",
					settledAt: Date.now(),
					reason: `job_${nextStatus}`,
				},
				type: "credit:released",
				message: "Prototype credit reserve released",
				metadata: {
					amountThb: job.creditReservation.amountThb,
					currency: job.creditReservation.currency,
					status: nextStatus,
				},
			};
		}

		return null;
	}

	private async settleUsageLedger(job: AiJob, status: "captured" | "released", reason: string, amountThb?: number): Promise<void> {
		await this.settleUsageCredit({
			projectId: job.projectId,
			jobId: job.jobId,
			status,
			amountThb: amountThb ?? job.creditReservation?.amountThb,
			reason,
		});
	}

	private buildCreditSettlementFailure(
		job: AiJob,
		status: "captured" | "released",
		reason: string,
		error: unknown,
	): {
		reservation: NonNullable<AiJob["creditReservation"]>;
		type: string;
		message: string;
		metadata: Record<string, unknown>;
	} {
		return {
			reservation: job.creditReservation!,
			type: "credit:settlement_failed",
			message: "Credit ledger settlement failed; reservation remains pending",
			metadata: {
				amountThb: job.creditReservation?.amountThb,
				currency: job.creditReservation?.currency,
				status,
				reason,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}

	// Refund the personal/shareable credits consumed at submission time when a job
	// reaches a terminal failure status. Idempotent via releaseConsumptionsByRef,
	// and best-effort so a credit-ledger hiccup never blocks the status update.
	private async releaseSharedCreditsBestEffort(job: AiJob, reason: string): Promise<void> {
		try {
			const released = await this.releaseSharedCredits(job.jobId, reason);
			if (released.length) {
				this.appendEvent(job.jobId, "credit:shared_released", "Refunded consumed personal/shareable credits", {
					reason,
					released,
				});
			}
		} catch (error) {
			console.warn(`[Queue] Failed to release shared credits for ${job.jobId}: ${error}`);
		}
	}

	private async releaseRetryCreditBestEffort(job: AiJob, reason: string): Promise<void> {
		try {
			await settleAiCreditReservation({
				projectId: job.projectId,
				jobId: job.jobId,
				status: "released",
				amountThb: job.creditReservation?.amountThb,
				reason,
			});
		} catch (error) {
			console.warn(`[Queue] Failed to release retry credit reservation for ${job.jobId}: ${error}`);
		}
	}

	/**
	 * Retry credit-reservation releases that were left pending because the usage
	 * ledger was temporarily unavailable when a job reached a terminal/parked state
	 * (notably `needs_review`, which is never claimed and fires no later
	 * transition). Without this, a single ledger outage could leak the reservation
	 * for the full reservation lifetime and consume the workspace AI quota until
	 * manual intervention. Runs on every processor tick; best-effort per job so one
	 * stuck ledger row does not block the rest.
	 *
	 * Also reconciles the symmetric CAPTURE leak: when a job succeeds but the credit
	 * CAPTURE at the `done` transition failed (settlement_failed), the job is still
	 * marked `done` while its reservation stays `reserved` — and `done` is not a
	 * release-reconcile state, so the reservation would otherwise never be captured
	 * nor refunded (a dangling reserved reservation = leaked quota / lost charge).
	 * The invariant: every settled job ends with its reservation either captured or
	 * released. A `done` job here is retried as a capture, never a release.
	 */
	async reconcilePendingReservationReleases(): Promise<void> {
		await this.ready();
		await this.reconcilePendingReservationCaptures();
		const candidates = [...this.jobs.values()].filter(
			(job) => RELEASE_RECONCILE_JOB_STATUSES.has(job.status)
				&& job.creditReservation?.status === "reserved",
		);
		if (candidates.length === 0) return;

		for (const candidate of candidates) {
			try {
				await this.settleUsageCredit({
					projectId: candidate.projectId,
					jobId: candidate.jobId,
					status: "released",
					amountThb: candidate.creditReservation?.amountThb,
					reason: `reconcile_${candidate.status}`,
				});
			} catch (error) {
				console.warn(`[Queue] Reservation-release reconcile still failing for ${candidate.jobId}; will retry next tick: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			// Ledger release succeeded — flip the job record's reservation to
			// `released` under the mutation lock so the retry is not repeated.
			await this.withMutation(async () => {
				const job = this.jobs.get(candidate.jobId);
				if (!job || job.creditReservation?.status !== "reserved" || !RELEASE_RECONCILE_JOB_STATUSES.has(job.status)) return;
				job.creditReservation = {
					...job.creditReservation,
					status: "released",
					settledAt: Date.now(),
					reason: `reconcile_${job.status}`,
				};
				job.updatedAt = Date.now();
				this.appendEvent(job.jobId, "credit:released", "Pending credit reservation released by reconciler", {
					amountThb: job.creditReservation.amountThb,
					currency: job.creditReservation.currency,
					status: job.status,
				});
				await this.persist();
			});
		}
	}

	/**
	 * Capture-reconcile pass: a `done` job whose reservation is still `reserved`
	 * means the capture at its `done` transition failed (credit ledger outage →
	 * `credit:settlement_failed`). Because `done` is terminal and fires no further
	 * status change, the normal capture path never re-runs, and `done` is not a
	 * release-reconcile state, so without this the reservation leaks forever. Retry
	 * the capture here; on success also refund any unused reserve padding to the
	 * personal/shareable buckets (mirroring the live capture path). Best-effort per
	 * job so one stuck ledger row does not block the rest.
	 */
	private async reconcilePendingReservationCaptures(): Promise<void> {
		const candidates = [...this.jobs.values()].filter(
			(job) => job.status === "done" && job.creditReservation?.status === "reserved",
		);
		if (candidates.length === 0) return;

		for (const candidate of candidates) {
			const reservedAmountThb = candidate.creditReservation?.reservedAmountThb ?? candidate.creditReservation?.amountThb;
			const capturedAmountThb = resolveAiCreditCaptureAmount(candidate);
			try {
				await this.settleUsageCredit({
					projectId: candidate.projectId,
					jobId: candidate.jobId,
					status: "captured",
					amountThb: capturedAmountThb,
					reason: "reconcile_done",
				});
			} catch (error) {
				console.warn(`[Queue] Reservation-capture reconcile still failing for ${candidate.jobId}; will retry next tick: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			// Ledger capture succeeded — flip the job record's reservation to
			// `captured` under the mutation lock so the retry is not repeated. New jobs
			// need no credit bucket refund (the bucket debit is the size-flat per-op
			// credit price, 1/9/36, not a padded THB reserve). LEGACY THB jobs still get
			// their unused reserve refunded below, mirroring the live capture path.
			let captured: AiJob | undefined;
			await this.withMutation(async () => {
				const job = this.jobs.get(candidate.jobId);
				if (!job || job.creditReservation?.status !== "reserved" || job.status !== "done") return;
				job.creditReservation = {
					...job.creditReservation,
					status: "captured",
					amountThb: capturedAmountThb,
					reservedAmountThb,
					settledAt: Date.now(),
					reason: "reconcile_done",
				};
				job.updatedAt = Date.now();
				this.appendEvent(job.jobId, "credit:captured", "Pending credit reservation captured by reconciler", {
					amountThb: capturedAmountThb,
					reservedAmountThb,
					releasedAmountThb: Math.max(0, Math.ceil(((reservedAmountThb ?? 0) - capturedAmountThb) * 100) / 100),
					currency: job.creditReservation.currency,
					status: job.status,
				});
				await this.persist();
				captured = job;
			});
			// LEGACY back-compat ONLY: no-op for new (consumedCredits) jobs. Remove
			// once the pre-deploy in-flight queue drains.
			if (captured) {
				await this.refundUnusedSharedReserveBestEffort(captured, captured.creditReservation!);
			}
		}
	}

	private async ensureCurrent(): Promise<void> {
		await this.ready();
		if (this.store.kind === "redis") {
			await this.loadSnapshot({ recoverInterrupted: false });
		}
	}

	// LOCK-ORDER INVARIANT (codex money P1 #2): the canonical acquisition order is
	// QUEUE MUTATION LOCK (this withMutation) → CREDIT/USAGE-LEDGER locks. Every path
	// that must hold both — retry (consume/reserve inside withMutation), settlement
	// (settleCreditReservation inside applyJobUpdate), and the reservation reconcilers
	// — nests them in that order. The submit path deliberately does NOT nest: it
	// finishes consumeCredits + reserveAiCredit (releasing the credit/usage locks)
	// BEFORE jobQueue.add / claimIdempotency takes the queue mutex, so it never holds
	// the usage-ledger lock while waiting on the queue mutex. Keep it that way: never
	// initiate a credit/usage-ledger operation that could block while NOT inside this
	// queue mutation, and within a withMutation only ever take credit/usage locks
	// AFTER the queue lock — never the reverse — so no deadlock cycle can form.
	private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
		await this.ready();
		if (this.store.withMutationLock) {
			return this.store.withMutationLock(async () => {
				await this.loadSnapshot({ recoverInterrupted: false });
				return operation();
			});
		}
		return operation();
	}

	/**
	 * Whether an otherwise-evictable terminal job still has billing/reconciliation
	 * work pending and so MUST be retained regardless of age or count caps.
	 *
	 * THE GUARD: a job is billing-pending iff its usage-ledger reservation is still
	 * `reserved` (never captured nor released). The reservation reconcilers key off
	 * exactly the in-process job row:
	 *   - `done`  + reservation `reserved`  → `reconcilePendingReservationCaptures`
	 *     retries the capture every processor tick (the `done`-transition capture
	 *     failed on a ledger outage → `credit:settlement_failed`).
	 *   - error/cancelled/blocked + `reserved` → `reconcilePendingReservationReleases`
	 *     retries the release.
	 * Evicting such a job would delete the only record the reconciler scans, so the
	 * reservation would leak the workspace's AI quota (or lose the charge) forever.
	 * Once the reservation reaches `captured`/`released` the invariant "every settled
	 * job ends captured-or-released" holds and the row is safe to age out. A job with
	 * NO reservation at all (e.g. BYO / platform-credit-only) is never billing-pending.
	 *
	 * (`needs_review` never reaches this method — it is excluded from
	 * EVICTABLE_TERMINAL_JOB_STATUSES because it is parked, not terminal.)
	 */
	private isTerminalJobRetainedForBilling(job: AiJob): boolean {
		return job.creditReservation?.status === "reserved";
	}

	/**
	 * Retention sweep (memory/snapshot-bloat P1). Evicts terminal jobs — and their
	 * event arrays + dangling idempotency mappings — from the in-process maps so the
	 * whole-snapshot rewrite in `persist()` stays bounded by the retention window
	 * rather than by lifetime usage. Runs (a) on load (so an already-bloated snapshot
	 * shrinks on the next boot) and (b) at the top of every `persist()` (so each
	 * transition-to-terminal trims as it writes). Pure in-memory map mutation; the
	 * caller persists.
	 *
	 * Retention is SPLIT by terminal class (codex P2 — retriable jobs are valid
	 * retry sources):
	 *   - `done` jobs: evicted when older than `AI_QUEUE_TERMINAL_RETENTION_MS` (24h)
	 *     OR when the live `done`-job count exceeds `AI_QUEUE_MAX_TERMINAL_JOBS`
	 *     (oldest-finished first).
	 *   - RETRIABLE jobs (error/cancelled/blocked — `isRetriableJobStatus`): evicted
	 *     only when older than the longer `AI_QUEUE_RETRIABLE_RETENTION_MS` (7d), and
	 *     EXCLUDED from the count cap — so a burst of `done` jobs can never displace a
	 *     still-retriable failure that POST .../retry reconstructs from.
	 * In both cases eviction is suppressed while `isTerminalJobRetainedForBilling`
	 * holds (reservation still `reserved` and a reconciler needs the row).
	 * `needs_review`, pending, and processing jobs are never candidates (not in
	 * EVICTABLE_TERMINAL_JOB_STATUSES).
	 *
	 * Returns true if it evicted anything (so a load-time sweep can persist the
	 * shrunken snapshot exactly when it actually changed).
	 */
	private sweepExpiredTerminalJobs(now: number): boolean {
		// Projections age out on their OWN retention regardless of whether any live
		// terminal job evicts this pass — otherwise a snapshot containing only old
		// projections would re-save them forever (codex P3). Runs again after the
		// eviction loop appends fresh projections (cap enforcement).
		const projectionsSwept = this.sweepExpiredTerminalProjections(now);
		const retentionMs = readQueueTerminalRetentionMs();
		const retriableRetentionMs = readQueueRetriableRetentionMs();
		const maxTerminalJobs = readQueueMaxTerminalJobs();

		// Snapshot the evictable (terminal, NOT billing-pending) jobs with their
		// finish timestamps once, oldest-first, so both the age pass and the count
		// pass share one ordering and we never evict a billing-pending row. Tag each
		// with `retriable` (a valid retry source) so the two classes get the right
		// age window and the count cap counts only `done` jobs.
		const evictable: { jobId: string; finishedAt: number; retriable: boolean }[] = [];
		for (const job of this.jobs.values()) {
			if (!EVICTABLE_TERMINAL_JOB_STATUSES.has(job.status)) continue;
			if (this.isTerminalJobRetainedForBilling(job)) continue;
			evictable.push({
				jobId: job.jobId,
				finishedAt: jobTerminalTimestamp(job),
				retriable: isRetriableJobStatus(job.status),
			});
		}
		if (evictable.length === 0) return projectionsSwept;
		evictable.sort((a, b) => a.finishedAt - b.finishedAt);

		const toEvict = new Set<string>();
		// Age pass: drop anything past its class's retention window — the longer
		// retriable window for retry sources, the standard window for `done`.
		// `+Infinity` retentionMs (operator set the knob to 0/disabled) makes
		// `now - finishedAt > Infinity` always false, so age-eviction is skipped.
		for (const entry of evictable) {
			const window = entry.retriable ? retriableRetentionMs : retentionMs;
			if (now - entry.finishedAt > window) toEvict.add(entry.jobId);
		}
		// Count pass: bounds ONLY the non-retriable (`done`) terminal jobs — retriable
		// retry sources are exempt so a burst of `done` jobs cannot displace them
		// (codex P2). If more `done` jobs remain than the cap allows, drop the
		// oldest-finished surplus first. Counts only NON-billing-pending rows so a
		// backlog of stuck `reserved` jobs cannot wrongly force out healthy young
		// history. `+Infinity` cap disables this pass.
		if (Number.isFinite(maxTerminalJobs)) {
			const remainingDone = evictable.filter((entry) => !entry.retriable && !toEvict.has(entry.jobId));
			if (remainingDone.length > maxTerminalJobs) {
				let surplus = remainingDone.length - maxTerminalJobs;
				for (const entry of remainingDone) {
					if (surplus <= 0) break;
					toEvict.add(entry.jobId);
					surplus -= 1;
				}
			}
		}
		if (toEvict.size === 0) return projectionsSwept;

		for (const jobId of toEvict) {
			// Leave a compact terminal projection behind BEFORE dropping the row: the
			// read-time marker self-heal (reconcileProcessingAiReviewMarkers via
			// getMarkerReconcileView) must still resolve a `processing` marker for a
			// user who returns long after the full job was trimmed (codex P1).
			const job = this.jobs.get(jobId);
			if (job) {
				this.terminalProjections.set(jobId, {
					jobId,
					status: job.status,
					resultImageId: job.resultImageId,
					error: job.error,
					costEstimate: job.costEstimate,
					creditReservation: job.creditReservation,
					evictedAt: now,
				});
			}
			this.jobs.delete(jobId);
			// Evict the job's event history with it (it can never be read again — the
			// status route 404s once the job row is gone, see routes/ai.ts).
			this.events.delete(jobId);
		}
		// Drop idempotency mappings that pointed at evicted jobs — ONE pass over the
		// map keyed on the evicted set, not a scan per evicted job (codex P2: the
		// first post-deploy sweep of a bloated snapshot would otherwise be
		// O(evicted × keys)). A later REPLAY of a dropped key finds no mapping and
		// is free to materialize a FRESH job — the desired behaviour for a day-old
		// completed request, and consistent with the existing null-checks in
		// add()/getByIdempotencyKey()/claimIdempotency() (`this.jobs.get(existing)`
		// already guards a stale mapping). We never reach
		// QueueIdempotencyConflictError for an evicted job: that error only fires
		// for retry/alias keys still pointing at a LIVE different job. Dangling
		// claim rows (idempotencyClaims) are left to their own claim lifecycle.
		for (const [key, mappedJobId] of this.idempotency) {
			if (toEvict.has(mappedJobId)) this.idempotency.delete(key);
		}
		this.sweepExpiredTerminalProjections(now);
		return true;
	}

	/**
	 * Bound the projection side-map by its own (much longer) retention + count cap.
	 * The count pass must drop OLDEST-EVICTED first, but Map iteration order is NOT a
	 * reliable proxy for that: a snapshot rebuilt from Redis HGETALL restores rows in
	 * arbitrary order, so the front of the map need not be the oldest projection
	 * (codex P3). Sort the surplus by `evictedAt` ascending and delete the oldest.
	 */
	private sweepExpiredTerminalProjections(now: number): boolean {
		let removed = false;
		const retentionMs = readQueueTerminalProjectionRetentionMs();
		if (Number.isFinite(retentionMs)) {
			for (const [jobId, projection] of this.terminalProjections) {
				if (now - projection.evictedAt > retentionMs) {
					this.terminalProjections.delete(jobId);
					removed = true;
				}
			}
		}
		const maxProjections = readQueueMaxTerminalProjections();
		if (Number.isFinite(maxProjections) && this.terminalProjections.size > maxProjections) {
			// Order by evictedAt ascending so we evict the oldest projections first
			// regardless of the map's (HGETALL-arbitrary) iteration order.
			const surplus = this.terminalProjections.size - maxProjections;
			const oldest = [...this.terminalProjections.entries()]
				.sort((a, b) => a[1].evictedAt - b[1].evictedAt)
				.slice(0, surplus);
			for (const [jobId] of oldest) {
				this.terminalProjections.delete(jobId);
				removed = true;
			}
		}
		return removed;
	}

	/**
	 * Resolve the marker-reconcile view of a job: the full live row when present,
	 * else the compact projection an eviction left behind. This is what the
	 * read-time AI-review-marker self-heal must use instead of get(), so retention
	 * can never strand a marker in `processing` (codex P1).
	 */
	async getMarkerReconcileView(jobId: string): Promise<AiJobMarkerView | undefined> {
		const job = await this.get(jobId);
		if (job) return job;
		// Redis get() takes the loadJob point-read fast path and does NOT refresh the
		// in-process snapshot — and the EVICTING process may be a different replica
		// (queue-worker vs API for redis; multiple instances sharing ai-jobs.json
		// for file mode), so the projection might exist only in the STORE. Point-
		// read it through any persistent store before consulting the local map
		// (codex P2 ×2 — the redis-only guard stranded file-mode markers). The
		// memory store has no cross-instance state and implements no point-read.
		if (this.store.kind !== "memory" && this.store.loadTerminalProjection) {
			try {
				const remote = await this.store.loadTerminalProjection(jobId);
				if (remote) {
					this.terminalProjections.set(jobId, remote);
					return remote;
				}
			} catch {
				// Transient store hiccup → fall back to the local map; the reconcile
				// caller treats undefined as "leave the marker processing for later".
			}
		}
		return this.terminalProjections.get(jobId);
	}

	// Returns whether the load-time retention sweep evicted anything, so a caller
	// holding the mutation lock (the periodic sweep) can persist the shrunken snapshot
	// exactly when it changed — without re-running the sweep on the already-swept map
	// (which would then report "no change" and skip the persist).
	private async loadSnapshot(options: { recoverInterrupted?: boolean } = { recoverInterrupted: true }): Promise<boolean> {
		const snapshot = await this.store.load();
		let recovered = false;
		this.jobs.clear();
		for (const job of snapshot.jobs || []) {
			if (options.recoverInterrupted !== false && (job.status === "processing" || job.status === "retrying")) {
				job.status = "pending";
				job.error = "Recovered from interrupted worker";
				job.processorId = undefined;
				job.leaseExpiresAt = undefined;
				job.heartbeatAt = undefined;
				recovered = true;
			}
			this.jobs.set(job.jobId, job);
		}
		this.events = new Map(snapshot.events || []);
		this.idempotency = new Map(snapshot.idempotency || []);
		this.idempotencyClaims = new Map(snapshot.idempotencyClaims || []);
		this.terminalProjections = new Map(snapshot.terminalProjections || []);
		// Apply retention at LOAD too (requirement 6): the in-memory sweep always
		// applies, but loadSnapshot NEVER persists the sweep itself — redis read
		// paths reach here via ensureCurrent() outside the mutation lock (codex P1),
		// and even the FILE boot path must not whole-snapshot-save without the file
		// mutex (a concurrent instance can enqueue between our read and this write
		// and be overwritten — codex P2). The boot-time shrink instead rides the
		// LOCKED runRetentionSweep() chained off ready(), and any later locked
		// mutation persist() re-runs the sweep anyway. The pre-existing recovery
		// persist keeps its original semantics.
		const swept = this.sweepExpiredTerminalJobs(Date.now());
		if (options.recoverInterrupted !== false && recovered) await this.persist();
		return swept;
	}

	private async persist(): Promise<void> {
		// Trim expired terminal jobs + their events/idempotency BEFORE serializing, so
		// the whole-snapshot rewrite (file: pretty-printed JSON; redis: DEL+re-HSET via
		// one EVAL) is bounded by the retention window rather than by lifetime usage.
		// This runs on every mutation path — crucially each transition-to-terminal —
		// so terminal jobs trim as they are written. In-memory only; no nested persist
		// (we are already inside the persisting write), so it cannot recurse.
		this.sweepExpiredTerminalJobs(Date.now());
		await this.store.save({
			jobs: [...this.jobs.values()],
			events: [...this.events.entries()],
			idempotency: [...this.idempotency.entries()],
			idempotencyClaims: [...this.idempotencyClaims.entries()],
			terminalProjections: [...this.terminalProjections.entries()],
		});
	}

	private async processNext(): Promise<void> {
		if (this.processNextRunning) {
			this.processNextRequested = true;
			return;
		}
		if (this.draining) return;
		this.processNextRunning = true;
		try {
			do {
				this.processNextRequested = false;
				await this.ready();
				// Retry any credit releases left pending by an earlier ledger outage
				// (e.g. parked needs_review jobs) on every tick, before the
				// early-returns below for full slots / no processors.
				try {
					await this.reconcilePendingReservationReleases();
				} catch (error) {
					console.warn(`[Queue] Reservation-release reconcile pass failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				const availableSlots = this.maxConcurrent - this.processing.size;
				if (availableSlots <= 0 || this.processors.length === 0) return;

				const pending = await this.claimPendingJobs(availableSlots);
				for (const job of pending) {
					this.processing.add(job.jobId);
					const currentJob = this.jobs.get(job.jobId) ?? job;
					if (currentJob.status !== "processing") {
						this.processing.delete(job.jobId);
						continue;
					}

					const processor = this.processors[0];
					if (!processor) {
						this.processing.delete(job.jobId);
						await this.update(job.jobId, { status: "pending" });
						return;
					}
					const heartbeat = this.startProcessingHeartbeat(job.jobId);
					processor(currentJob)
						.catch((err) => {
							const failure = normalizeProcessorFailure(err);
							return this.updateFromProcessor(currentJob, {
								status: "error",
								error: failure.message,
								retryable: failure.retryable,
								failureCode: failure.failureCode,
								retryAfterSeconds: failure.retryAfterSeconds,
							});
						})
							.finally(async () => {
								if (heartbeat) clearInterval(heartbeat);
								this.processing.delete(job.jobId);
								try {
									await this.releaseCancelledProcessingLease(job.jobId);
								} catch (error) {
									console.error(`[Queue] Failed to release cancelled AI job lease: ${error instanceof Error ? error.message : String(error)}`);
								}
								void this.processNext();
							});
				}
			} while (this.processNextRequested && !this.draining);
		} catch (error) {
			console.error(`[Queue] Failed to process next AI job: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleProcessNextRetry();
		} finally {
			this.processNextRunning = false;
			if (this.processNextRequested && !this.draining) void this.processNext();
		}
	}

	private scheduleProcessNextRetry(): void {
		if (this.draining || this.store.kind !== "redis" || this.processNextRetryTimer) return;
		const retryMs = readQueueProcessRetryMs();
		if (!Number.isFinite(retryMs)) return;
		this.processNextRetryTimer = setTimeout(() => {
			this.processNextRetryTimer = undefined;
			void this.processNext();
		}, retryMs);
		(this.processNextRetryTimer as { unref?: () => void }).unref?.();
	}

	private startProcessingHeartbeat(jobId: string): ReturnType<typeof setInterval> | null {
		if (this.store.kind !== "redis") return null;
		const leaseMs = readQueueProcessingLeaseMs();
		if (!Number.isFinite(leaseMs)) return null;
		const heartbeatMs = Math.max(1000, Math.floor(leaseMs / 3));
		return setInterval(() => {
			void this.refreshProcessingLease(jobId).catch((error) => {
				console.error(`[Queue] Failed to refresh AI processor lease for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, heartbeatMs);
	}

	private async refreshProcessingLease(jobId: string): Promise<void> {
		if (this.store.kind !== "redis") return;
		await this.withMutation(async () => {
			const job = this.jobs.get(jobId);
			if (!job || job.processorId !== this.processorId || (!PROCESSING_JOB_STATUSES.has(job.status) && job.status !== "cancelled")) return;
			const now = Date.now();
			job.leaseExpiresAt = now + readQueueProcessingLeaseMs();
			job.heartbeatAt = now;
			await this.persist();
		});
	}

	private startRedisLeaseRecoveryTimer(): void {
		if (this.store.kind !== "redis" || this.recoveryTimer) return;
		const intervalMs = readQueueRecoveryIntervalMs();
		if (!Number.isFinite(intervalMs)) return;
		this.recoveryTimer = setInterval(() => {
			void this.recoverExpiredProcessingLeasesAndProcess();
		}, intervalMs);
		(this.recoveryTimer as { unref?: () => void }).unref?.();
	}

	private startRedisProcessorPollTimer(options: QueueProcessorOptions): void {
		if (this.store.kind !== "redis" || this.processorPollTimer) return;
		const intervalMs = options.pollIntervalMs ?? readQueueProcessorPollIntervalMs();
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
		this.processorPollTimer = setInterval(() => {
			void this.processNext();
		}, intervalMs);
		if (!options.keepPollTimerRef) {
			(this.processorPollTimer as { unref?: () => void }).unref?.();
		}
	}

	private async recoverExpiredProcessingLeasesAndProcess(): Promise<void> {
		if (this.store.kind !== "redis" || this.draining) return;
		let recovered = false;
		try {
			await this.withMutation(async () => {
				recovered = this.recoverExpiredProcessingLeases(Date.now());
				if (recovered) await this.persist();
			});
		} catch (error) {
			console.error(`[Queue] Failed to recover expired AI processor leases: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (recovered) void this.processNext();
	}

	/**
	 * Low-frequency PERIODIC retention sweep (codex P2). The Redis store implements
	 * `loadJob`, so get()/the status route HGET the hash directly and the load-time
	 * sweep deliberately never persists for redis (an unlocked whole-snapshot save
	 * could clobber a concurrent locked mutation — codex P1). During a read-only
	 * window (no mutations) that means an expired terminal row stays visible/stored
	 * past retention until some unrelated mutation finally persists. This timer closes
	 * that gap: on each tick it loads the current snapshot, runs the sweep, and
	 * persists ONLY if the sweep actually shrank anything — all UNDER the store's
	 * mutation lock so it serializes against real mutations exactly like the lease
	 * recovery pass. Registered in `onProcess`, cleared in `stopProcessing`, and
	 * `.unref()`ed so it never keeps the process alive.
	 */
	private startRetentionSweepTimer(): void {
		if (this.retentionSweepTimer) return;
		// Memory stores have NO persistence to shrink — and worse, their load()
		// returns an EMPTY snapshot, so a periodic reload would wipe live queued/
		// in-flight jobs (codex P2). The in-memory sweep already runs inside every
		// persist(); nothing to do on a timer.
		if (this.store.kind === "memory") return;
		const intervalMs = readQueueRetentionSweepIntervalMs();
		// `<= 0` (operator disabled) maps to +Infinity via readPositiveIntegerEnv —
		// no usable interval, so skip scheduling entirely.
		if (!Number.isFinite(intervalMs)) return;
		this.retentionSweepTimer = setInterval(() => {
			void this.runRetentionSweep();
		}, intervalMs);
		(this.retentionSweepTimer as { unref?: () => void }).unref?.();
	}

	private async runRetentionSweep(): Promise<void> {
		if (this.draining) return;
		// See startRetentionSweepTimer: a memory store's load() is empty — reloading
		// would clear live jobs. Guarded here too for any direct caller.
		if (this.store.kind === "memory") return;
		try {
			await this.ready();
			// Mirror withMutation's lock discipline (QUEUE MUTATION LOCK first), but
			// capture the load-time sweep's result so we persist ONLY when it actually
			// shrank the snapshot — re-running the sweep here would see the already-swept
			// map and report "no change", skipping the persist that closes the gap.
			const sweepUnderLock = async () => {
				const swept = await this.loadSnapshot({ recoverInterrupted: false });
				if (swept) await this.persist();
			};
			if (this.store.withMutationLock) {
				await this.store.withMutationLock(sweepUnderLock);
			} else {
				await sweepUnderLock();
			}
		} catch (error) {
			console.error(`[Queue] Periodic retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async releaseCancelledProcessingLease(jobId: string): Promise<void> {
		if (this.store.kind !== "redis") return;
		let cancelledJob: AiJob | undefined;
		await this.withMutation(async () => {
			const job = this.jobs.get(jobId);
			if (!job || job.status !== "cancelled" || job.processorId !== this.processorId) return;
			this.clearProcessingLease(job);
			job.updatedAt = Date.now();
			this.appendEvent(jobId, "lease:released_after_cancel", "Cancelled job processor lease released after processor exit");
			await this.persist();
			cancelledJob = { ...job };
		});
		// Belt-and-suspenders reap: the in-flight processor for a job cancelled
		// mid-flight may have (re-)parked its provider checkpoint AFTER cancel()'s
		// own cleanup pass ran. Now that the processor has exited, re-run the
		// idempotent cleanup so the artifact a terminal job will never reclaim is
		// removed.
		if (cancelledJob) await this.runCancelCleanupHooks(cancelledJob);
	}

	private recoverExpiredProcessingLeases(now: number): boolean {
		if (this.store.kind !== "redis") return false;
		let recovered = false;
		for (const job of this.jobs.values()) {
			const leaseExpiresAt = typeof job.leaseExpiresAt === "number" ? job.leaseExpiresAt : 0;
			if (leaseExpiresAt > now) continue;
			if (job.status === "cancelled" && (job.processorId || job.leaseExpiresAt || job.heartbeatAt)) {
				this.clearProcessingLease(job);
				job.updatedAt = now;
				this.appendEvent(job.jobId, "lease:expired_after_cancel", "Cancelled job processor lease expired");
				// A crashed/hung processor may have parked a provider checkpoint AFTER the
				// cancel swept it; now that its lease has expired there is no reclaiming
				// worker, so reap any leftover artifact. Best-effort + idempotent + detached
				// (this sweep is synchronous; runCancelCleanupHooks swallows hook errors).
				// The lease fields are cleared above so this branch won't re-fire for the job.
				void this.runCancelCleanupHooks(job);
				recovered = true;
				continue;
			}
			if (!PROCESSING_JOB_STATUSES.has(job.status)) continue;
			job.status = "pending";
			job.error = "Recovered from expired processor lease";
			this.clearProcessingLease(job);
			job.updatedAt = now;
			this.appendEvent(job.jobId, "status:pending", "Job recovered from expired processor lease");
			recovered = true;
		}
		return recovered;
	}

	private countGloballyActiveProcessingJobs(now: number): number {
		if (this.store.kind !== "redis") return this.processing.size;
		return [...this.jobs.values()].filter((job) => {
			return this.hasActiveProcessingLease(job, now);
		}).length;
	}

	private shouldPreserveLeaseForCancelledProcessingJob(
		job: AiJob,
		previousStatus: JobStatus,
		nextStatus: JobStatus | undefined,
		now: number,
	): boolean {
		return this.store.kind === "redis"
			&& nextStatus === "cancelled"
			&& PROCESSING_JOB_STATUSES.has(previousStatus)
			&& this.hasActiveProcessingLease(job, now);
	}

	private hasActiveProcessingLease(job: AiJob, now: number): boolean {
		if (this.store.kind !== "redis") return false;
		if (!PROCESSING_JOB_STATUSES.has(job.status) && job.status !== "cancelled") return false;
		const leaseExpiresAt = typeof job.leaseExpiresAt === "number" ? job.leaseExpiresAt : 0;
		return leaseExpiresAt > now;
	}

	private clearProcessingLease(job: AiJob): void {
		job.processorId = undefined;
		job.leaseExpiresAt = undefined;
		job.heartbeatAt = undefined;
	}

	private async claimPendingJobs(limit: number): Promise<AiJob[]> {
		if (limit <= 0) return [];
		let claimed: AiJob[] = [];
		await this.withMutation(async () => {
			const now = Date.now();
			const recovered = this.recoverExpiredProcessingLeases(now);
			const globalSlots = Math.max(0, this.maxConcurrent - this.countGloballyActiveProcessingJobs(now));
			const effectiveLimit = Math.min(limit, globalSlots);
			if (effectiveLimit <= 0) {
				if (recovered) await this.persist();
				return;
			}

			const leaseExpiresAt = now + readQueueProcessingLeaseMs();
			claimed = [...this.jobs.values()]
				.filter((job) => job.status === "pending" && !this.processing.has(job.jobId))
				.slice(0, effectiveLimit);

			for (const job of claimed) {
				const previousStatus = job.status;
				Object.assign(job, {
					status: "processing" as JobStatus,
					attempts: (job.attempts || 0) + 1,
					processorId: this.store.kind === "redis" ? this.processorId : undefined,
					leaseExpiresAt: this.store.kind === "redis" ? leaseExpiresAt : undefined,
					heartbeatAt: this.store.kind === "redis" ? now : undefined,
					// Clear any advisory resume/recovery marker (e.g. "Re-queued for
					// resume after worker shutdown drain timeout" or "Recovered from
					// expired processor lease"). It must not linger and surface in the
					// `done` SSE/status payload of a job that resumes successfully.
					error: undefined,
					updatedAt: now,
				});
				if (job.status !== previousStatus) {
					this.appendEvent(job.jobId, `status:${job.status}`, `Job status changed to ${job.status}`);
				}
			}
			if (recovered || claimed.length > 0) await this.persist();
		});
		return claimed;
	}
}

export const jobQueue = new JobQueue(DEFAULT_MAX_CONCURRENT_AI_JOBS, join(DATA_DIR, "ai-jobs.json"));

export function createQueueSnapshotStore(persistPath?: string): QueueSnapshotStore {
	const mode = (process.env.AI_QUEUE_STORE || (process.env.REDIS_URL && !isTestRuntime() ? "redis" : persistPath ? "file" : "memory")).trim().toLowerCase();
	if (mode === "redis") return new RedisQueueSnapshotStore(undefined, undefined, persistPath);
	if (mode === "file") return persistPath ? new FileQueueSnapshotStore(persistPath) : new MemoryQueueSnapshotStore();
	return new MemoryQueueSnapshotStore();
}

export function readQueueAdmissionLimits(): QueueAdmissionLimits {
	return {
		maxOpenJobs: readPositiveIntegerEnv("AI_QUEUE_MAX_OPEN_JOBS", 200),
		maxPendingJobs: readPositiveIntegerEnv("AI_QUEUE_MAX_PENDING_JOBS", 150),
		maxProjectOpenJobs: readPositiveIntegerEnv("AI_QUEUE_MAX_PROJECT_OPEN_JOBS", 30),
		maxProjectPendingJobs: readPositiveIntegerEnv("AI_QUEUE_MAX_PROJECT_PENDING_JOBS", 20),
		maxProjectReservedThb: readPositiveFloatEnv("AI_QUEUE_MAX_PROJECT_RESERVED_THB", 1000),
		maxTierOpenJobs: {
			"budget-clean": readPositiveIntegerEnv("AI_QUEUE_MAX_BUDGET_CLEAN_OPEN_JOBS", 100),
			"clean-pro": readPositiveIntegerEnv("AI_QUEUE_MAX_CLEAN_PRO_OPEN_JOBS", 60),
			"sfx-pro": readPositiveIntegerEnv("AI_QUEUE_MAX_SFX_PRO_OPEN_JOBS", 30),
		},
		retryAfterSeconds: readPositiveIntegerEnv("AI_QUEUE_RETRY_AFTER_SECONDS", 30),
	};
}

function normalizeQueueSnapshot(value: unknown): QueueSnapshot {
	const raw = value as Partial<QueueSnapshot>;
	return {
		jobs: Array.isArray(raw?.jobs) ? raw.jobs.filter(isAiJob) : [],
		events: Array.isArray(raw?.events) ? raw.events.filter(isEventEntry) : [],
		idempotency: Array.isArray(raw?.idempotency) ? raw.idempotency.filter(isStringPair) : [],
		idempotencyClaims: Array.isArray(raw?.idempotencyClaims) ? raw.idempotencyClaims.filter(isClaimEntry) : [],
		terminalProjections: Array.isArray(raw?.terminalProjections) ? raw.terminalProjections.filter(isTerminalProjectionEntry) : [],
	};
}

function isTerminalProjectionEntry(value: unknown): value is [string, TerminalJobProjection] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") return false;
	const projection = value[1] as Partial<TerminalJobProjection>;
	return Boolean(
		projection
		&& typeof projection.jobId === "string"
		&& typeof projection.status === "string"
		&& typeof projection.evictedAt === "number",
	);
}

function isAiJob(value: unknown): value is AiJob {
	const job = value as Partial<AiJob>;
	return Boolean(
		job
		&& typeof job.jobId === "string"
		&& typeof job.projectId === "string"
		&& typeof job.imageId === "string"
		&& typeof job.lang === "string"
		&& typeof job.prompt === "string"
		&& typeof job.status === "string"
		&& typeof job.createdAt === "number"
		&& typeof job.updatedAt === "number",
	);
}

function isEventEntry(value: unknown): value is [string, AiJobEvent[]] {
	return Array.isArray(value)
		&& value.length === 2
		&& typeof value[0] === "string"
		&& Array.isArray(value[1])
		&& value[1].every(isAiJobEvent);
}

function isAiJobEvent(value: unknown): value is AiJobEvent {
	const event = value as Partial<AiJobEvent>;
	return Boolean(
		event
		&& typeof event.jobId === "string"
		&& typeof event.type === "string"
		&& typeof event.message === "string"
		&& typeof event.createdAt === "number",
	);
}

function isStringPair(value: unknown): value is [string, string] {
	return Array.isArray(value)
		&& value.length === 2
		&& typeof value[0] === "string"
		&& typeof value[1] === "string";
}

function isClaimEntry(value: unknown): value is [string, IdempotencyClaimMeta] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") return false;
	const meta = value[1] as Partial<IdempotencyClaimMeta>;
	return Boolean(
		meta
		&& typeof meta.jobId === "string"
		&& typeof meta.charged === "boolean"
		&& typeof meta.claimedAt === "number",
	);
}

function normalizeProcessorFailure(error: unknown): ProcessorFailureMetadata {
	const metadata = error && typeof error === "object" ? error as Record<string, unknown> : {};
	const retryable = typeof metadata.retryable === "boolean" ? metadata.retryable : undefined;
	const failureCode = typeof metadata.code === "string"
		? metadata.code
		: typeof metadata.failureCode === "string"
			? metadata.failureCode
			: undefined;
	const retryAfterSeconds = typeof metadata.retryAfterSeconds === "number" && Number.isFinite(metadata.retryAfterSeconds)
		? Math.max(0, Math.ceil(metadata.retryAfterSeconds))
		: undefined;
	return {
		message: error instanceof Error ? error.message : String(error),
		retryable,
		failureCode,
		retryAfterSeconds,
	};
}

function isTestRuntime(): boolean {
	const argv = process.argv.map((arg) => arg.toLowerCase());
	return process.env.NODE_ENV === "test"
		|| process.env.BUN_ENV === "test"
		|| argv.includes("test");
}

function exceedsLimit(currentCount: number, limit: number): boolean {
	return Number.isFinite(limit) && currentCount + 1 > limit;
}

function readQueueProcessingLeaseMs(): number {
	const value = readPositiveIntegerEnv("AI_QUEUE_PROCESSING_LEASE_MS", DEFAULT_PROCESSING_LEASE_MS);
	if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
	return Math.max(5000, value);
}

function readQueueRecoveryIntervalMs(): number {
	const fallback = Math.max(1000, Math.floor(readQueueProcessingLeaseMs() / 2));
	return readPositiveIntegerEnv("AI_QUEUE_RECOVERY_INTERVAL_MS", fallback);
}

function readQueueProcessRetryMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_PROCESS_RETRY_MS", 1000);
}

function readQueueProcessorPollIntervalMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_PROCESSOR_POLL_INTERVAL_MS", 1000);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return Number.POSITIVE_INFINITY;
	return parsed;
}

function readPositiveFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return Number.POSITIVE_INFINITY;
	return parsed;
}

// Terminal-job retention knobs (memory/snapshot-bloat P1). Read per-call (not
// cached) so a test or an operator can tune them at runtime, mirroring the
// admission-limit readers above. `readPositiveIntegerEnv` maps a `<= 0` override to
// +Infinity, which here means "disable this cap" (never age-expire / never count-
// evict) — a deliberate operator escape hatch consistent with the other limits.
function readQueueTerminalRetentionMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_TERMINAL_RETENTION_MS", DEFAULT_AI_QUEUE_TERMINAL_RETENTION_MS);
}

function readQueueRetriableRetentionMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_RETRIABLE_RETENTION_MS", DEFAULT_AI_QUEUE_RETRIABLE_RETENTION_MS);
}

// Periodic retention-sweep interval (codex P2). Default 10 minutes; `<= 0` maps to
// +Infinity (disabled) via readPositiveIntegerEnv, which startRetentionSweepTimer
// reads as "do not schedule".
function readQueueRetentionSweepIntervalMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS", DEFAULT_AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS);
}

function readQueueMaxTerminalJobs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_MAX_TERMINAL_JOBS", DEFAULT_AI_QUEUE_MAX_TERMINAL_JOBS);
}

function readQueueTerminalProjectionRetentionMs(): number {
	return readPositiveIntegerEnv("AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS", DEFAULT_AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS);
}

function readQueueMaxTerminalProjections(): number {
	return readPositiveIntegerEnv("AI_QUEUE_MAX_TERMINAL_PROJECTIONS", DEFAULT_AI_QUEUE_MAX_TERMINAL_PROJECTIONS);
}

function readQueueMaxJobEvents(): number {
	return readPositiveIntegerEnv("AI_QUEUE_MAX_JOB_EVENTS", DEFAULT_AI_QUEUE_MAX_JOB_EVENTS);
}

// Best-effort terminal timestamp for retention ageing. AiJob has no dedicated
// finishedAt/completedAt field; `updatedAt` is stamped to Date.now() on EVERY
// transition (so for a terminal job it is the moment it became terminal — exactly
// the "finished at" we want), with `createdAt` as the floor for any malformed row
// that somehow lost `updatedAt`. Mirrors the spec's
// `finishedAt ?? updatedAt ?? createdAt` intent against the fields that exist.
function jobTerminalTimestamp(job: AiJob): number {
	return job.updatedAt || job.createdAt;
}
