import { RedisClient } from "bun";
import { DEFAULT_EGRESS_ABUSE_MODE, readEgressAbuseModeValue, type EgressAbuseMode } from "../config.js";
import type { AssetAccessPurpose } from "./asset-access.js";

export interface AssetEgressRecordInput {
	projectId: string;
	imageId: string;
	purpose: AssetAccessPurpose;
	bytes: number;
	statusCode: number;
	cacheHit?: boolean;
	tokenRequired?: boolean;
	tokenAccepted?: boolean;
	now?: number;
	// When the caller has already reserved these bytes against the abuse window
	// via reserveProjectEgressForRead (the serving routes do this so the throttle
	// is atomic with respect to concurrent reads), skip the abuse increment here
	// to avoid double-counting the same served bytes.
	skipAbuseReservation?: boolean;
}

export interface AssetEgressBucket {
	projectId: string;
	imageId: string;
	purpose: AssetAccessPurpose;
	windowStart: number;
	windowEnd: number;
	requests: number;
	bytes: number;
	cacheHits: number;
	tokenRequiredRequests: number;
	tokenAcceptedRequests: number;
	lastStatusCode: number;
	updatedAt: number;
}

export interface ProjectEgressSummary {
	projectId: string;
	windowMs: number;
	windowStart: number;
	windowEnd: number;
	totalRequests: number;
	totalBytes: number;
	limitBytes: number;
	enforced: boolean;
	remainingBytes: number;
	byPurpose: Array<{
		purpose: AssetAccessPurpose;
		requests: number;
		bytes: number;
	}>;
	byAsset: Array<{
		imageId: string;
		requests: number;
		bytes: number;
	}>;
}

export interface AbuseWindowUsage {
	observedBytes: number;
	windowStart: number;
	windowEnd: number;
}

export interface AssetEgressStore {
	record(input: AssetEgressRecordInput): AssetEgressBucket | Promise<AssetEgressBucket>;
	recordWithAllowance?(input: AssetEgressRecordInput): AssetEgressBucket | Promise<AssetEgressBucket>;
	summarize(projectId: string, now?: number): ProjectEgressSummary | Promise<ProjectEgressSummary>;
	// Batched per-project summary: returns one ProjectEgressSummary per input
	// project in the SAME ORDER as `projectIds`, computed from a SINGLE pass over
	// the store's window state rather than one query/scan per project. This is the
	// dashboard fan-out fix (rank14): replaces Promise.all(map(summarize)) so a
	// workspace with N projects does not issue N independent summarize round-trips.
	// Optional so legacy/test doubles can omit it; the module-level
	// `summarizeProjectsEgress` helper falls back to per-project `summarize`.
	summarizeMany?(projectIds: string[], now?: number): ProjectEgressSummary[] | Promise<ProjectEgressSummary[]>;
	// Abuse-burst accounting tracked over the configured abuse window
	// (ASSET_EGRESS_ABUSE_WINDOW_MS), independent of the normal egress
	// accounting window. Optional so legacy/test doubles can omit them; callers
	// fall back to the store's `summarize` (used purely as an availability probe)
	// when a store does not implement native abuse accounting.
	summarizeAbuse?(projectId: string, windowMs: number, now?: number): AbuseWindowUsage | Promise<AbuseWindowUsage>;
	reserveAbuse?(input: AbuseReservationInput): AbuseWindowUsage | Promise<AbuseWindowUsage>;
	// Roll back bytes previously reserved via reserveAbuse for a read that was
	// ultimately NOT served (e.g. the normal egress cap rejected it). Without this
	// the abuse window would keep counting bytes that never left the origin, so
	// repeated over-cap attempts could trip/extend the throttle on undelivered
	// traffic. Bytes are clamped at zero so a release can never go negative.
	releaseAbuse?(input: AbuseReservationInput): AbuseWindowUsage | Promise<AbuseWindowUsage>;
	reset?(): void | Promise<void>;
}

export interface AbuseReservationInput {
	projectId: string;
	windowMs: number;
	bytes: number;
	now?: number;
}

export interface RedisAssetEgressClient {
	send(command: string, args: string[]): unknown | Promise<unknown>;
	close?(): void;
}

export class EgressLimitExceededError extends Error {
	readonly summary: ProjectEgressSummary;
	readonly attemptedBytes: number;

	constructor(summary: ProjectEgressSummary, attemptedBytes: number) {
		super("Asset egress limit exceeded");
		this.name = "EgressLimitExceededError";
		this.summary = summary;
		this.attemptedBytes = attemptedBytes;
	}
}

export class EgressAccountingUnavailableError extends Error {
	readonly operation: "record" | "summarize";
	override readonly cause: unknown;

	constructor(operation: "record" | "summarize", cause: unknown) {
		super("Asset egress accounting unavailable");
		this.name = "EgressAccountingUnavailableError";
		this.operation = operation;
		this.cause = cause;
	}
}

export interface EgressAbuseConfig {
	enabled: boolean;
	thresholdBytes: number;
	windowMs: number;
	mode: EgressAbuseMode;
}

export interface EgressAbuseDecision {
	throttled: boolean;
	enforced: boolean;
	mode: EgressAbuseMode;
	thresholdBytes: number;
	observedBytes: number;
	windowMs: number;
	windowStart: number;
	windowEnd: number;
	retryAfterSeconds: number;
}

export class EgressAbuseThrottleError extends Error {
	readonly decision: EgressAbuseDecision;
	readonly scope: "asset_read" | "token_issuance";

	constructor(decision: EgressAbuseDecision, scope: "asset_read" | "token_issuance") {
		super("Asset egress abuse throttle active");
		this.name = "EgressAbuseThrottleError";
		this.decision = decision;
		this.scope = scope;
	}
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_REDIS_PREFIX = "manga-editor:asset-egress";
const REDIS_EGRESS_CHECK_AND_RECORD_SCRIPT = `
local bytes = tonumber(ARGV[6]) or 0
local totalBytes = tonumber(redis.call("HGET", KEYS[3], "totalBytes") or "0") or 0
local projectedBytes = totalBytes + bytes
local enforced = ARGV[13] == "1"
local limitBytes = tonumber(ARGV[14]) or 0
if enforced and limitBytes > 0 and projectedBytes > limitBytes then
	return {"LIMIT", tostring(totalBytes), tostring(projectedBytes)}
end
redis.call("HSET", KEYS[1],
	"projectId", ARGV[1],
	"imageId", ARGV[2],
	"purpose", ARGV[3],
	"windowStart", ARGV[4],
	"windowEnd", ARGV[5],
	"lastStatusCode", ARGV[7],
	"updatedAt", ARGV[11]
)
redis.call("HINCRBY", KEYS[1], "requests", 1)
redis.call("HINCRBY", KEYS[1], "bytes", ARGV[6])
redis.call("HINCRBY", KEYS[1], "cacheHits", ARGV[8])
redis.call("HINCRBY", KEYS[1], "tokenRequiredRequests", ARGV[9])
redis.call("HINCRBY", KEYS[1], "tokenAcceptedRequests", ARGV[10])
redis.call("HSET", KEYS[3],
	"projectId", ARGV[1],
	"windowStart", ARGV[4],
	"windowEnd", ARGV[5],
	"updatedAt", ARGV[11]
)
redis.call("HINCRBY", KEYS[3], "totalRequests", 1)
redis.call("HINCRBY", KEYS[3], "totalBytes", bytes)
redis.call("HINCRBY", KEYS[3], "cacheHits", ARGV[8])
redis.call("HINCRBY", KEYS[3], "tokenRequiredRequests", ARGV[9])
redis.call("HINCRBY", KEYS[3], "tokenAcceptedRequests", ARGV[10])
redis.call("SADD", KEYS[2], KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[12])
redis.call("PEXPIRE", KEYS[2], ARGV[12])
redis.call("PEXPIRE", KEYS[3], ARGV[12])
local result = redis.call("HGETALL", KEYS[1])
table.insert(result, 1, "OK")
return result
`;
// Atomically add bytes to the abuse-window total and return the total BEFORE
// this reservation (so a caller throttles iff the window was already over
// threshold, bounding a concurrent burst's overshoot to a single read).
// KEYS[1] = abuse total key, ARGV[1] = bytes, ARGV[2] = windowStart,
// ARGV[3] = windowEnd, ARGV[4] = ttlMs.
const REDIS_ABUSE_RESERVE_SCRIPT = `
local bytes = tonumber(ARGV[1]) or 0
local before = tonumber(redis.call("HGET", KEYS[1], "totalBytes") or "0") or 0
redis.call("HINCRBY", KEYS[1], "totalBytes", bytes)
redis.call("HSET", KEYS[1], "windowStart", ARGV[2], "windowEnd", ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[4])
return tostring(before)
`;
// Roll back a prior reservation: subtract bytes from the abuse-window total,
// clamping at zero so concurrent rollbacks/expiry can never drive it negative.
// Returns the total AFTER the release. KEYS[1] = abuse total key,
// ARGV[1] = bytes, ARGV[2] = windowStart, ARGV[3] = windowEnd, ARGV[4] = ttlMs.
const REDIS_ABUSE_RELEASE_SCRIPT = `
local bytes = tonumber(ARGV[1]) or 0
local current = tonumber(redis.call("HGET", KEYS[1], "totalBytes") or "0") or 0
local remaining = current - bytes
if remaining < 0 then remaining = 0 end
redis.call("HSET", KEYS[1], "totalBytes", tostring(remaining), "windowStart", ARGV[2], "windowEnd", ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[4])
return tostring(remaining)
`;

export class MemoryAssetEgressStore implements AssetEgressStore {
	private readonly buckets = new Map<string, AssetEgressBucket>();
	// Abuse-burst byte totals bucketed by the abuse window, kept separate from
	// the normal accounting buckets so the burst horizon honors
	// ASSET_EGRESS_ABUSE_WINDOW_MS even when it differs from the accounting window.
	private readonly abuseBuckets = new Map<string, { windowStart: number; windowEnd: number; bytes: number }>();
	private recordCount = 0;

	constructor(private readonly maxBuckets = 50_000) {}

	record(input: AssetEgressRecordInput): AssetEgressBucket {
		const now = input.now ?? Date.now();
		const config = readEgressConfig();
		const bytes = sanitizeBytes(input.bytes);
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		this.recordCount++;
		if (this.recordCount % 1000 === 0 || this.buckets.size > this.maxBuckets) {
			this.sweepExpiredBuckets(now, config.windowMs);
		}
		// Mirror served bytes into the abuse-window aggregate so the throttle
		// observes the same traffic the accounting layer just recorded — unless
		// the serving route already reserved these bytes (avoids double-counting).
		if (!input.skipAbuseReservation) {
			this.addAbuseBytes(input.projectId, readEgressAbuseWindowMs(), bytes, now);
		}

		const key = [input.projectId, input.imageId, input.purpose, windowStart].join(":");
		let bucket = this.buckets.get(key);
		if (!bucket) {
			bucket = {
				projectId: input.projectId,
				imageId: input.imageId,
				purpose: input.purpose,
				windowStart,
				windowEnd,
				requests: 0,
				bytes: 0,
				cacheHits: 0,
				tokenRequiredRequests: 0,
				tokenAcceptedRequests: 0,
				lastStatusCode: input.statusCode,
				updatedAt: now,
			};
			this.buckets.set(key, bucket);
		}

		bucket.requests++;
		bucket.bytes += bytes;
		bucket.cacheHits += input.cacheHit ? 1 : 0;
		bucket.tokenRequiredRequests += input.tokenRequired ? 1 : 0;
		bucket.tokenAcceptedRequests += input.tokenAccepted ? 1 : 0;
		bucket.lastStatusCode = input.statusCode;
		bucket.updatedAt = now;
		return { ...bucket };
	}

	recordWithAllowance(input: AssetEgressRecordInput): AssetEgressBucket {
		const now = input.now ?? Date.now();
		const config = readEgressConfig();
		const bytes = sanitizeBytes(input.bytes);
		const summary = this.summarize(input.projectId, now);
		const projectedBytes = summary.totalBytes + bytes;
		if (config.enforced && config.limitBytes > 0 && projectedBytes > config.limitBytes) {
			throw new EgressLimitExceededError(createLimitExceededSummary(
				input.projectId,
				config,
				summary.windowStart,
				summary.windowEnd,
				summary.totalBytes,
				projectedBytes,
			), bytes);
		}
		return this.record({ ...input, now });
	}

	summarize(projectId: string, now = Date.now()): ProjectEgressSummary {
		const config = readEgressConfig();
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		this.sweepExpiredBuckets(now, config.windowMs);
		return summarizeBuckets(
			projectId,
			config,
			windowStart,
			windowEnd,
			Array.from(this.buckets.values()).filter((bucket) => bucket.projectId === projectId && bucket.windowStart === windowStart),
		);
	}

	// Batched: a single pass over the active buckets groups served bytes by
	// project, replacing N independent `summarize` scans (rank14). Projects with
	// no buckets in the active window return an empty summary, preserving the exact
	// per-project numbers `summarize` would have produced.
	summarizeMany(projectIds: string[], now = Date.now()): ProjectEgressSummary[] {
		const config = readEgressConfig();
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		this.sweepExpiredBuckets(now, config.windowMs);
		const wanted = new Set(projectIds);
		const byProject = new Map<string, AssetEgressBucket[]>();
		for (const bucket of this.buckets.values()) {
			if (bucket.windowStart !== windowStart) continue;
			if (!wanted.has(bucket.projectId)) continue;
			const list = byProject.get(bucket.projectId);
			if (list) list.push(bucket);
			else byProject.set(bucket.projectId, [bucket]);
		}
		return projectIds.map((projectId) =>
			summarizeBuckets(projectId, config, windowStart, windowEnd, byProject.get(projectId) ?? []),
		);
	}

	summarizeAbuse(projectId: string, windowMs: number, now = Date.now()): AbuseWindowUsage {
		const windowStart = getWindowStart(now, windowMs);
		const windowEnd = windowStart + windowMs;
		this.sweepExpiredAbuseBuckets(now, windowMs);
		const bucket = this.abuseBuckets.get(buildAbuseBucketKey(projectId, windowStart));
		return {
			observedBytes: bucket && bucket.windowStart === windowStart ? bucket.bytes : 0,
			windowStart,
			windowEnd,
		};
	}

	// Atomically reserve projected bytes against the abuse window so concurrent
	// reads observe each other's in-flight bytes before any of them serve. The
	// returned `observedBytes` is the window total BEFORE this reservation, so a
	// caller throttles iff the window was already over threshold — bounding a
	// concurrent burst's overshoot to a single read rather than the whole batch.
	reserveAbuse(input: AbuseReservationInput): AbuseWindowUsage {
		const now = input.now ?? Date.now();
		const bytes = sanitizeBytes(input.bytes);
		const windowStart = getWindowStart(now, input.windowMs);
		const before = this.summarizeAbuse(input.projectId, input.windowMs, now);
		const after = this.addAbuseBytes(input.projectId, input.windowMs, bytes, now);
		return { observedBytes: before.observedBytes, windowStart, windowEnd: after.windowEnd };
	}

	// Roll back a prior reservation for an undelivered read. Subtracts bytes from
	// the active abuse bucket (clamped at zero) so a read that reserved bytes and
	// was then rejected by the normal egress cap does not keep inflating the burst
	// window. The returned `observedBytes` is the window total AFTER the release.
	releaseAbuse(input: AbuseReservationInput): AbuseWindowUsage {
		const now = input.now ?? Date.now();
		const bytes = sanitizeBytes(input.bytes);
		return this.subtractAbuseBytes(input.projectId, input.windowMs, bytes, now);
	}

	reset(): void {
		this.buckets.clear();
		this.abuseBuckets.clear();
		this.recordCount = 0;
	}

	private addAbuseBytes(projectId: string, windowMs: number, bytes: number, now: number): AbuseWindowUsage {
		const windowStart = getWindowStart(now, windowMs);
		const windowEnd = windowStart + windowMs;
		this.sweepExpiredAbuseBuckets(now, windowMs);
		const key = buildAbuseBucketKey(projectId, windowStart);
		let bucket = this.abuseBuckets.get(key);
		if (!bucket || bucket.windowStart !== windowStart) {
			bucket = { windowStart, windowEnd, bytes: 0 };
			this.abuseBuckets.set(key, bucket);
		}
		bucket.bytes += bytes;
		return { observedBytes: bucket.bytes, windowStart, windowEnd };
	}

	private subtractAbuseBytes(projectId: string, windowMs: number, bytes: number, now: number): AbuseWindowUsage {
		const windowStart = getWindowStart(now, windowMs);
		const windowEnd = windowStart + windowMs;
		this.sweepExpiredAbuseBuckets(now, windowMs);
		const key = buildAbuseBucketKey(projectId, windowStart);
		const bucket = this.abuseBuckets.get(key);
		if (!bucket || bucket.windowStart !== windowStart) {
			return { observedBytes: 0, windowStart, windowEnd };
		}
		bucket.bytes = Math.max(0, bucket.bytes - bytes);
		return { observedBytes: bucket.bytes, windowStart, windowEnd };
	}

	private sweepExpiredBuckets(now: number, windowMs: number): void {
		const oldestWindowStart = getWindowStart(now, windowMs) - windowMs;
		for (const [key, bucket] of this.buckets.entries()) {
			if (bucket.windowStart < oldestWindowStart) {
				this.buckets.delete(key);
			}
		}
	}

	private sweepExpiredAbuseBuckets(now: number, windowMs: number): void {
		const oldestWindowStart = getWindowStart(now, windowMs) - windowMs;
		for (const [key, bucket] of this.abuseBuckets.entries()) {
			if (bucket.windowStart < oldestWindowStart) {
				this.abuseBuckets.delete(key);
			}
		}
	}
}

export interface RedisAssetEgressStoreOptions {
	client?: RedisAssetEgressClient;
	url?: string;
	keyPrefix?: string;
	expiryBufferSeconds?: number;
}

export class RedisAssetEgressStore implements AssetEgressStore {
	private readonly client: RedisAssetEgressClient;
	private readonly keyPrefix: string;
	private readonly expiryBufferSeconds: number;

	constructor(options: RedisAssetEgressStoreOptions = {}) {
		this.client = options.client ?? createRedisClient(options.url);
		this.keyPrefix = options.keyPrefix ?? process.env.ASSET_EGRESS_REDIS_KEY_PREFIX ?? DEFAULT_REDIS_PREFIX;
		this.expiryBufferSeconds = options.expiryBufferSeconds ?? 5;
	}

	async record(input: AssetEgressRecordInput): Promise<AssetEgressBucket> {
		return this.writeRecord(input, false);
	}

	async recordWithAllowance(input: AssetEgressRecordInput): Promise<AssetEgressBucket> {
		return this.writeRecord(input, true);
	}

	private async writeRecord(input: AssetEgressRecordInput, checkAllowance: boolean): Promise<AssetEgressBucket> {
		const now = input.now ?? Date.now();
		const config = readEgressConfig();
		const bytes = sanitizeBytes(input.bytes);
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		const ttlMs = Math.max(1, config.windowMs + this.expiryBufferSeconds * 1000);
		const bucketKey = buildRedisBucketKey(this.keyPrefix, input.projectId, input.imageId, input.purpose, windowStart);
		const indexKey = buildRedisIndexKey(this.keyPrefix, input.projectId, windowStart);
		const totalKey = buildRedisTotalKey(this.keyPrefix, input.projectId, windowStart);
		const result = await this.client.send("EVAL", [
			REDIS_EGRESS_CHECK_AND_RECORD_SCRIPT,
			"3",
			bucketKey,
			indexKey,
			totalKey,
			input.projectId,
			input.imageId,
			input.purpose,
			String(windowStart),
			String(windowEnd),
			String(bytes),
			String(input.statusCode),
			input.cacheHit ? "1" : "0",
			input.tokenRequired ? "1" : "0",
			input.tokenAccepted ? "1" : "0",
			String(now),
			String(ttlMs),
			checkAllowance && config.enforced && config.limitBytes > 0 ? "1" : "0",
			String(config.limitBytes),
		]);
		const bucket = parseRedisRecordResult(result, {
			projectId: input.projectId,
			config,
			windowStart,
			windowEnd,
			attemptedBytes: bytes,
		});
		// Mirror served bytes into the abuse-window aggregate unless the serving
		// route already reserved them (avoids double-counting). A failure here is
		// surfaced so the abuse gate fails closed rather than undercounting a burst.
		if (!input.skipAbuseReservation) {
			await this.reserveAbuse({ projectId: input.projectId, windowMs: readEgressAbuseWindowMs(), bytes, now });
		}
		return bucket;
	}

	async summarizeAbuse(projectId: string, windowMs: number, now = Date.now()): Promise<AbuseWindowUsage> {
		const windowStart = getWindowStart(now, windowMs);
		const windowEnd = windowStart + windowMs;
		const totalKey = buildRedisAbuseKey(this.keyPrefix, projectId, windowStart);
		const raw = await this.client.send("HGET", [totalKey, "totalBytes"]);
		return { observedBytes: parseRedisNumber(parseRedisScalar(raw)), windowStart, windowEnd };
	}

	async reserveAbuse(input: AbuseReservationInput): Promise<AbuseWindowUsage> {
		const now = input.now ?? Date.now();
		const bytes = sanitizeBytes(input.bytes);
		const windowStart = getWindowStart(now, input.windowMs);
		const windowEnd = windowStart + input.windowMs;
		const ttlMs = Math.max(1, input.windowMs + this.expiryBufferSeconds * 1000);
		const totalKey = buildRedisAbuseKey(this.keyPrefix, input.projectId, windowStart);
		const raw = await this.client.send("EVAL", [
			REDIS_ABUSE_RESERVE_SCRIPT,
			"1",
			totalKey,
			String(bytes),
			String(windowStart),
			String(windowEnd),
			String(ttlMs),
		]);
		return { observedBytes: parseRedisNumber(parseRedisScalar(raw)), windowStart, windowEnd };
	}

	async releaseAbuse(input: AbuseReservationInput): Promise<AbuseWindowUsage> {
		const now = input.now ?? Date.now();
		const bytes = sanitizeBytes(input.bytes);
		const windowStart = getWindowStart(now, input.windowMs);
		const windowEnd = windowStart + input.windowMs;
		const ttlMs = Math.max(1, input.windowMs + this.expiryBufferSeconds * 1000);
		const totalKey = buildRedisAbuseKey(this.keyPrefix, input.projectId, windowStart);
		const raw = await this.client.send("EVAL", [
			REDIS_ABUSE_RELEASE_SCRIPT,
			"1",
			totalKey,
			String(bytes),
			String(windowStart),
			String(windowEnd),
			String(ttlMs),
		]);
		return { observedBytes: parseRedisNumber(parseRedisScalar(raw)), windowStart, windowEnd };
	}

	async summarize(projectId: string, now = Date.now()): Promise<ProjectEgressSummary> {
		const config = readEgressConfig();
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		const buckets = await this.loadProjectBuckets(projectId, windowStart);
		return summarizeBuckets(projectId, config, windowStart, windowEnd, buckets);
	}

	// Batched per-project summary (rank14). Both levels of the per-project N+1 are
	// collapsed: the SMEMBERS index reads run concurrently across projects, then a
	// SINGLE HGETALL pass fetches every referenced bucket once (deduped across
	// projects), instead of one SMEMBERS + serial HGETALL loop per project.
	async summarizeMany(projectIds: string[], now = Date.now()): Promise<ProjectEgressSummary[]> {
		const config = readEgressConfig();
		const windowStart = getWindowStart(now, config.windowMs);
		const windowEnd = windowStart + config.windowMs;
		if (projectIds.length === 0) return [];

		// 1) Resolve each project's bucket-key set (concurrent, not serial).
		const indexResults = await Promise.all(
			projectIds.map((projectId) =>
				this.client.send("SMEMBERS", [buildRedisIndexKey(this.keyPrefix, projectId, windowStart)]),
			),
		);

		// 2) Collect the union of referenced bucket keys and HGETALL each ONCE.
		const uniqueKeys = new Set<string>();
		const keysByProject = projectIds.map((_, i) => parseRedisStringArray(indexResults[i]));
		for (const keys of keysByProject) {
			for (const key of keys) uniqueKeys.add(key);
		}
		const keyList = [...uniqueKeys];
		const bucketRaws = await Promise.all(keyList.map((key) => this.client.send("HGETALL", [key])));
		const bucketByKey = new Map<string, AssetEgressBucket>();
		for (let i = 0; i < keyList.length; i++) {
			bucketByKey.set(keyList[i]!, parseRedisBucket(bucketRaws[i]));
		}

		// 3) Reassemble each project's active buckets in input order.
		return projectIds.map((projectId, i) => {
			const buckets: AssetEgressBucket[] = [];
			for (const key of keysByProject[i]!) {
				const bucket = bucketByKey.get(key);
				if (bucket && bucket.projectId === projectId && bucket.windowStart === windowStart) {
					buckets.push(bucket);
				}
			}
			return summarizeBuckets(projectId, config, windowStart, windowEnd, buckets);
		});
	}

	private async loadProjectBuckets(projectId: string, windowStart: number): Promise<AssetEgressBucket[]> {
		const indexKey = buildRedisIndexKey(this.keyPrefix, projectId, windowStart);
		const keys = parseRedisStringArray(await this.client.send("SMEMBERS", [indexKey]));
		const raws = await Promise.all(keys.map((key) => this.client.send("HGETALL", [key])));
		const buckets: AssetEgressBucket[] = [];
		for (const raw of raws) {
			const bucket = parseRedisBucket(raw);
			if (bucket.projectId === projectId && bucket.windowStart === windowStart) {
				buckets.push(bucket);
			}
		}
		return buckets;
	}

	close(): void {
		this.client.close?.();
	}
}

const sharedMemoryStore = new MemoryAssetEgressStore();
let sharedStore: AssetEgressStore | null = null;

export function readEgressConfig() {
	return {
		windowMs: readPositiveIntegerEnv("ASSET_EGRESS_WINDOW_MS", DEFAULT_WINDOW_MS),
		limitBytes: readPositiveIntegerEnv("ASSET_EGRESS_PROJECT_WINDOW_BYTES", 0),
		enforced: readBooleanEnv("ASSET_EGRESS_LIMIT_ENFORCED", false),
	};
}

// Abuse-burst auto-throttle config. The burst is measured against the egress
// accounting aggregate already recorded per rolling window (no new counters /
// migration): once a project's served bytes in the active window cross
// `thresholdBytes`, further reads and token issuance are throttled until the
// window resets. `ASSET_EGRESS_ABUSE_WINDOW_MS` documents the intended burst
// horizon and defaults to the egress accounting window when unset.
// The abuse-burst window length, independent of the posture (mode) config so
// that byte bucketing in the record/reserve path never depends on parsing
// ASSET_EGRESS_ABUSE_MODE (a misspelled mode must not break egress recording).
// Resolution precedence (Codex round-2 #2): an explicit ASSET_EGRESS_ABUSE_WINDOW_MS
// wins; otherwise it tracks the accounting window — ASSET_EGRESS_WINDOW_MS if set,
// else DEFAULT_WINDOW_MS (the same default readEgressConfig() uses). It must NOT
// fall back to a separate 5-minute default when both window vars are omitted, or
// the abuse horizon would silently diverge from the documented accounting window.
export function readEgressAbuseWindowMs(): number {
	return readPositiveIntegerEnv(
		"ASSET_EGRESS_ABUSE_WINDOW_MS",
		readPositiveIntegerEnv("ASSET_EGRESS_WINDOW_MS", DEFAULT_WINDOW_MS),
	);
}

export function readEgressAbuseConfig(): EgressAbuseConfig {
	const thresholdBytes = readPositiveIntegerEnv("ASSET_EGRESS_ABUSE_WINDOW_BYTES", 0);
	const windowMs = readEgressAbuseWindowMs();
	const mode = readEgressAbuseModeValue(process.env.ASSET_EGRESS_ABUSE_MODE, DEFAULT_EGRESS_ABUSE_MODE);
	return {
		enabled: thresholdBytes > 0,
		thresholdBytes,
		windowMs,
		mode,
	};
}

// Resolve the abuse config for the runtime throttle gate without ever throwing.
// A malformed ASSET_EGRESS_ABUSE_MODE (or any config error) while a threshold is
// configured must NOT silently disable the production abuse shutoff: in that
// case we fail closed by treating the project as enforce-throttled. When no
// threshold is set the feature is off, so a config error is harmless and we
// return a disabled config. Returns the resolved config plus an optional
// `forceThrottle` flag the evaluator honors as a fail-closed signal.
export function resolveEgressAbuseGateConfig(): { config: EgressAbuseConfig; forceThrottle: boolean; configError?: unknown } {
	const thresholdBytes = readPositiveIntegerEnv("ASSET_EGRESS_ABUSE_WINDOW_BYTES", 0);
	const windowMs = readEgressAbuseWindowMs();
	try {
		const mode = readEgressAbuseModeValue(process.env.ASSET_EGRESS_ABUSE_MODE, DEFAULT_EGRESS_ABUSE_MODE);
		return {
			config: { enabled: thresholdBytes > 0, thresholdBytes, windowMs, mode },
			forceThrottle: false,
		};
	} catch (configError) {
		// The threshold is set but the mode (or other posture config) is invalid.
		// Treat as enforce + throttled so a misconfigured shutoff fails closed
		// rather than serving unbounded bytes. With no threshold, stay disabled.
		const enabled = thresholdBytes > 0;
		return {
			config: { enabled, thresholdBytes, windowMs, mode: "enforce" },
			forceThrottle: enabled,
			configError,
		};
	}
}

export function createAssetEgressStore(): AssetEgressStore {
	const selectedStore = readAssetEgressStoreMode();
	const redisUrl = process.env.REDIS_URL;
	const shouldUseRedis = selectedStore === "redis" || (selectedStore === "auto" && !isTestRuntime() && Boolean(redisUrl));
	if (!shouldUseRedis) return sharedMemoryStore;
	return new RedisAssetEgressStore({ url: redisUrl });
}

export async function recordAssetEgress(input: AssetEgressRecordInput): Promise<AssetEgressBucket> {
	return getAssetEgressStore().record(input);
}

export async function recordAssetEgressWithAllowance(input: AssetEgressRecordInput): Promise<AssetEgressBucket> {
	const store = getAssetEgressStore();
	if (store.recordWithAllowance) {
		return store.recordWithAllowance(input);
	}
	const config = readEgressConfig();
	if (config.enforced && config.limitBytes > 0) {
		throw new EgressAccountingUnavailableError("record", new Error("Asset egress store does not support atomic allowance recording"));
	}
	await assertProjectEgressAllowance(input.projectId, input.bytes, input.now ?? Date.now());
	return store.record(input);
}

export async function assertProjectEgressAllowance(projectId: string, pendingBytes: number, now = Date.now()): Promise<ProjectEgressSummary> {
	const config = readEgressConfig();
	let summary: ProjectEgressSummary;
	try {
		summary = await summarizeProjectEgress(projectId, now);
	} catch (error) {
		if (config.enforced && config.limitBytes > 0) {
			throw new EgressAccountingUnavailableError("summarize", error);
		}
		summary = emptyProjectEgressSummary(projectId, config, now);
	}
	const projectedBytes = summary.totalBytes + sanitizeBytes(pendingBytes);
	if (config.enforced && config.limitBytes > 0 && projectedBytes > config.limitBytes) {
		throw new EgressLimitExceededError({
			...summary,
			remainingBytes: Math.max(0, config.limitBytes - projectedBytes),
		}, pendingBytes);
	}
	return summary;
}

export async function summarizeProjectEgress(projectId: string, now = Date.now()): Promise<ProjectEgressSummary> {
	return getAssetEgressStore().summarize(projectId, now);
}

// Batched egress summary for many projects in one pass (rank14). Returns one
// summary per input project, in the SAME ORDER as `projectIds`. Uses the store's
// native `summarizeMany` when available (single grouped scan / pipelined reads);
// otherwise falls back to concurrent per-project `summarize` so test doubles and
// legacy stores still work — identical numbers either way.
export async function summarizeProjectsEgress(projectIds: string[], now = Date.now()): Promise<ProjectEgressSummary[]> {
	if (projectIds.length === 0) return [];
	const store = getAssetEgressStore();
	if (store.summarizeMany) {
		return store.summarizeMany(projectIds, now);
	}
	return Promise.all(projectIds.map((projectId) => store.summarize(projectId, now)));
}

// Aggregate a project's served bytes over the abuse window (distinct from the
// normal accounting window). Stores that implement `summarizeAbuse` report the
// abuse-window total directly; for stores that don't (e.g. minimal test
// doubles), fall back to `summarize` purely as an availability probe and reuse
// its total — acceptable only because such doubles run with matching windows.
async function summarizeProjectAbuseUsage(projectId: string, windowMs: number, now: number): Promise<AbuseWindowUsage> {
	const store = getAssetEgressStore();
	if (store.summarizeAbuse) {
		return store.summarizeAbuse(projectId, windowMs, now);
	}
	const summary = await store.summarize(projectId, now);
	return { observedBytes: summary.totalBytes, windowStart: summary.windowStart, windowEnd: summary.windowEnd };
}

function buildAbuseDecisionForUsage(
	abuse: EgressAbuseConfig,
	enforced: boolean,
	now: number,
	usage: AbuseWindowUsage,
	throttled: boolean,
): EgressAbuseDecision {
	const decision = buildAbuseDecision(abuse, enforced, now, usage.observedBytes, throttled);
	decision.windowStart = usage.windowStart;
	decision.windowEnd = usage.windowEnd;
	decision.retryAfterSeconds = Math.max(0, Math.ceil((usage.windowEnd - now) / 1000));
	return decision;
}

// Evaluate whether a project has crossed the abuse-burst threshold within the
// configured abuse window (ASSET_EGRESS_ABUSE_WINDOW_MS, independent of the
// normal accounting window). Observe mode never marks the project as throttled
// (fail-open, log/flag only); enforce mode marks it throttled and, if the
// aggregate is unavailable OR the throttle config is invalid, fails closed by
// treating the project as throttled so neither a degraded counter nor a
// misconfigured posture can become an egress-abuse bypass.
export async function evaluateProjectEgressAbuse(projectId: string, now = Date.now()): Promise<EgressAbuseDecision> {
	const { config: abuse, forceThrottle, configError } = resolveEgressAbuseGateConfig();
	const enforced = abuse.mode === "enforce";
	if (!abuse.enabled) {
		return buildAbuseDecision(abuse, enforced, now, 0, false);
	}
	// Fail closed on invalid throttle config while a threshold is set: a
	// misspelled ASSET_EGRESS_ABUSE_MODE must not silently disable the shutoff.
	if (forceThrottle) {
		console.error("[egress] abuse throttle config invalid; failing closed", { projectId, error: configError });
		return buildAbuseDecisionForUsage(abuse, enforced, now, emptyAbuseUsage(now, abuse.windowMs), true);
	}
	let usage: AbuseWindowUsage;
	try {
		usage = await summarizeProjectAbuseUsage(projectId, abuse.windowMs, now);
	} catch (error) {
		const fallback = emptyAbuseUsage(now, abuse.windowMs);
		if (enforced) {
			console.error("[egress] abuse evaluation unavailable; failing closed", { projectId, error });
			return buildAbuseDecisionForUsage(abuse, enforced, now, fallback, true);
		}
		console.warn("[egress] abuse evaluation unavailable; failing open in observe mode", { projectId, error });
		return buildAbuseDecisionForUsage(abuse, enforced, now, fallback, false);
	}
	const overThreshold = usage.observedBytes >= abuse.thresholdBytes;
	const decision = buildAbuseDecisionForUsage(abuse, enforced, now, usage, enforced && overThreshold);
	if (overThreshold) {
		const log = enforced ? console.warn : console.info;
		log("[egress] project crossed abuse-burst threshold", {
			projectId,
			mode: abuse.mode,
			observedBytes: usage.observedBytes,
			thresholdBytes: abuse.thresholdBytes,
			throttled: decision.throttled,
		});
	}
	return decision;
}

// Atomic abuse-burst gate for asset reads: reserves the bytes the read is about
// to serve against the abuse window BEFORE returning them, and decides on the
// window total observed *prior* to this reservation. This closes the
// concurrent-burst hole where parallel reads all pass a pre-read check against
// the same stale aggregate and then each serve bytes before any counter update:
// because the reservation is atomic, only reads whose prior total is still under
// the threshold serve, bounding overshoot to a single read instead of the whole
// batch. Throws EgressAbuseThrottleError when enforce mode trips the threshold;
// observe mode and under-threshold projects resolve with the decision.
export async function reserveProjectEgressForRead(
	projectId: string,
	projectedBytes: number,
	scope: "asset_read" | "token_issuance",
	now = Date.now(),
): Promise<EgressAbuseDecision> {
	const { config: abuse, forceThrottle, configError } = resolveEgressAbuseGateConfig();
	const enforced = abuse.mode === "enforce";
	if (!abuse.enabled) {
		return buildAbuseDecision(abuse, enforced, now, 0, false);
	}
	if (forceThrottle) {
		console.error("[egress] abuse throttle config invalid; failing closed", { projectId, scope, error: configError });
		const decision = buildAbuseDecisionForUsage(abuse, enforced, now, emptyAbuseUsage(now, abuse.windowMs), true);
		throw new EgressAbuseThrottleError(decision, scope);
	}
	const store = getAssetEgressStore();
	let usage: AbuseWindowUsage;
	try {
		if (store.reserveAbuse) {
			usage = await store.reserveAbuse({ projectId, windowMs: abuse.windowMs, bytes: projectedBytes, now });
		} else {
			// Store lacks atomic reservation: probe availability via summarize and
			// decide on the observed total (no reservation possible). Keeps the
			// unavailability signal and fail-closed posture intact for such stores.
			usage = await summarizeProjectAbuseUsage(projectId, abuse.windowMs, now);
		}
	} catch (error) {
		const fallback = emptyAbuseUsage(now, abuse.windowMs);
		if (enforced) {
			console.error("[egress] abuse reservation unavailable; failing closed", { projectId, scope, error });
			throw new EgressAbuseThrottleError(buildAbuseDecisionForUsage(abuse, enforced, now, fallback, true), scope);
		}
		console.warn("[egress] abuse reservation unavailable; failing open in observe mode", { projectId, scope, error });
		return buildAbuseDecisionForUsage(abuse, enforced, now, fallback, false);
	}
	const overThreshold = usage.observedBytes >= abuse.thresholdBytes;
	const decision = buildAbuseDecisionForUsage(abuse, enforced, now, usage, enforced && overThreshold);
	if (overThreshold) {
		const log = enforced ? console.warn : console.info;
		log("[egress] project crossed abuse-burst threshold (reservation)", {
			projectId,
			scope,
			mode: abuse.mode,
			observedBytes: usage.observedBytes,
			thresholdBytes: abuse.thresholdBytes,
			throttled: decision.throttled,
		});
	}
	if (decision.throttled) {
		throw new EgressAbuseThrottleError(decision, scope);
	}
	return decision;
}

// Roll back bytes reserved by reserveProjectEgressForRead for a read that ended
// up NOT being served — e.g. the normal egress cap rejected it after the abuse
// reservation was already made. Without this, those undelivered bytes would
// linger in the abuse window and let repeated over-cap attempts trip/extend the
// throttle + token revocation on traffic that never left the origin (Codex
// round-2 #3). Best-effort and never throws: a failed rollback is logged but must
// not turn an already-handled rejection into a 5xx. No-ops when the feature is
// disabled or the store cannot release (the reservation path no-ops there too).
export async function releaseProjectEgressReservation(
	projectId: string,
	projectedBytes: number,
	now = Date.now(),
): Promise<void> {
	const { config: abuse } = resolveEgressAbuseGateConfig();
	if (!abuse.enabled) return;
	const store = getAssetEgressStore();
	if (!store.releaseAbuse) return;
	try {
		await store.releaseAbuse({ projectId, windowMs: abuse.windowMs, bytes: projectedBytes, now });
	} catch (error) {
		console.warn("[egress] abuse reservation rollback failed", { projectId, error });
	}
}

// Throttle gate for asset reads / token issuance. Throws EgressAbuseThrottleError
// only when enforce mode has marked the project as throttled; observe mode and
// under-threshold projects resolve with the (non-throttled) decision.
export async function assertProjectEgressNotThrottled(
	projectId: string,
	scope: "asset_read" | "token_issuance",
	now = Date.now(),
): Promise<EgressAbuseDecision> {
	const decision = await evaluateProjectEgressAbuse(projectId, now);
	if (decision.throttled) {
		throw new EgressAbuseThrottleError(decision, scope);
	}
	return decision;
}

export function setAssetEgressStoreForTesting(store: AssetEgressStore): void {
	sharedStore = store;
}

export function resetEgressAccountingForTesting(): void {
	sharedMemoryStore.reset();
	sharedStore = createAssetEgressStore();
}

function getAssetEgressStore(): AssetEgressStore {
	if (!sharedStore) sharedStore = createAssetEgressStore();
	return sharedStore;
}

function summarizeBuckets(
	projectId: string,
	config: ReturnType<typeof readEgressConfig>,
	windowStart: number,
	windowEnd: number,
	activeBuckets: AssetEgressBucket[],
): ProjectEgressSummary {
	const byPurpose = new Map<AssetAccessPurpose, { purpose: AssetAccessPurpose; requests: number; bytes: number }>();
	const byAsset = new Map<string, { imageId: string; requests: number; bytes: number }>();
	let totalRequests = 0;
	let totalBytes = 0;

	for (const bucket of activeBuckets) {
		totalRequests += bucket.requests;
		totalBytes += bucket.bytes;
		const purpose = byPurpose.get(bucket.purpose) ?? { purpose: bucket.purpose, requests: 0, bytes: 0 };
		purpose.requests += bucket.requests;
		purpose.bytes += bucket.bytes;
		byPurpose.set(bucket.purpose, purpose);

		const asset = byAsset.get(bucket.imageId) ?? { imageId: bucket.imageId, requests: 0, bytes: 0 };
		asset.requests += bucket.requests;
		asset.bytes += bucket.bytes;
		byAsset.set(bucket.imageId, asset);
	}

	return {
		projectId,
		windowMs: config.windowMs,
		windowStart,
		windowEnd,
		totalRequests,
		totalBytes,
		limitBytes: config.limitBytes,
		enforced: config.enforced,
		remainingBytes: config.limitBytes > 0 ? Math.max(0, config.limitBytes - totalBytes) : 0,
		byPurpose: Array.from(byPurpose.values()).sort((a, b) => b.bytes - a.bytes),
		byAsset: Array.from(byAsset.values()).sort((a, b) => b.bytes - a.bytes),
	};
}

function emptyProjectEgressSummary(
	projectId: string,
	config: ReturnType<typeof readEgressConfig>,
	now: number,
): ProjectEgressSummary {
	const windowStart = getWindowStart(now, config.windowMs);
	const windowEnd = windowStart + config.windowMs;
	return {
		projectId,
		windowMs: config.windowMs,
		windowStart,
		windowEnd,
		totalRequests: 0,
		totalBytes: 0,
		limitBytes: config.limitBytes,
		enforced: config.enforced,
		remainingBytes: config.limitBytes,
		byPurpose: [],
		byAsset: [],
	};
}

function createLimitExceededSummary(
	projectId: string,
	config: ReturnType<typeof readEgressConfig>,
	windowStart: number,
	windowEnd: number,
	totalBytes: number,
	projectedBytes: number,
): ProjectEgressSummary {
	return {
		projectId,
		windowMs: config.windowMs,
		windowStart,
		windowEnd,
		totalRequests: 0,
		totalBytes,
		limitBytes: config.limitBytes,
		enforced: config.enforced,
		remainingBytes: Math.max(0, config.limitBytes - projectedBytes),
		byPurpose: [],
		byAsset: [],
	};
}

function buildAbuseDecision(
	abuse: EgressAbuseConfig,
	enforced: boolean,
	now: number,
	observedBytes: number,
	throttled: boolean,
): EgressAbuseDecision {
	const windowStart = getWindowStart(now, abuse.windowMs);
	const windowEnd = windowStart + abuse.windowMs;
	return {
		throttled,
		enforced,
		mode: abuse.mode,
		thresholdBytes: abuse.thresholdBytes,
		observedBytes,
		windowMs: abuse.windowMs,
		windowStart,
		windowEnd,
		retryAfterSeconds: Math.max(0, Math.ceil((windowEnd - now) / 1000)),
	};
}

function emptyAbuseUsage(now: number, windowMs: number): AbuseWindowUsage {
	const windowStart = getWindowStart(now, windowMs);
	return { observedBytes: 0, windowStart, windowEnd: windowStart + windowMs };
}

function buildAbuseBucketKey(projectId: string, windowStart: number): string {
	return `${projectId}:${windowStart}`;
}

function getWindowStart(now: number, windowMs: number): number {
	return Math.floor(now / windowMs) * windowMs;
}

function sanitizeBytes(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`${name} must be true or false`);
}

function readAssetEgressStoreMode(): "auto" | "memory" | "redis" {
	const raw = (process.env.ASSET_EGRESS_STORE ?? "").trim().toLowerCase();
	if (!raw) return "auto";
	if (raw === "auto" || raw === "memory" || raw === "redis") return raw;
	throw new Error("ASSET_EGRESS_STORE must be auto, memory, or redis");
}

function isTestRuntime(): boolean {
	const argv = process.argv.map((arg) => arg.toLowerCase());
	return process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" || argv.includes("test");
}

function createRedisClient(url = process.env.REDIS_URL): RedisAssetEgressClient {
	if (!url?.trim()) {
		throw new Error("ASSET_EGRESS_STORE=redis requires REDIS_URL");
	}
	return new RedisClient(url) as unknown as RedisAssetEgressClient;
}

function buildRedisBucketKey(prefix: string, projectId: string, imageId: string, purpose: AssetAccessPurpose, windowStart: number): string {
	return [prefix, "bucket", projectId, windowStart, purpose, imageId].join(":");
}

function buildRedisIndexKey(prefix: string, projectId: string, windowStart: number): string {
	return [prefix, "project", projectId, windowStart].join(":");
}

function buildRedisTotalKey(prefix: string, projectId: string, windowStart: number): string {
	return [prefix, "project-total", projectId, windowStart].join(":");
}

function buildRedisAbuseKey(prefix: string, projectId: string, windowStart: number): string {
	return [prefix, "abuse-total", projectId, windowStart].join(":");
}

function parseRedisRecordResult(
	value: unknown,
	context: {
		projectId: string;
		config: ReturnType<typeof readEgressConfig>;
		windowStart: number;
		windowEnd: number;
		attemptedBytes: number;
	},
): AssetEgressBucket {
	const entries = parseRedisStringArray(value);
	const status = entries[0];
	if (status === "LIMIT") {
		const totalBytes = parseRedisNumber(entries[1]);
		const projectedBytes = parseRedisNumber(entries[2]);
		throw new EgressLimitExceededError(createLimitExceededSummary(
			context.projectId,
			context.config,
			context.windowStart,
			context.windowEnd,
			totalBytes,
			projectedBytes,
		), context.attemptedBytes);
	}
	if (status === "OK") {
		return parseRedisBucket(entries.slice(1));
	}
	return parseRedisBucket(value);
}

function parseRedisBucket(value: unknown): AssetEgressBucket {
	const hash = parseRedisHash(value);
	return {
		projectId: hash.projectId ?? "",
		imageId: hash.imageId ?? "",
		purpose: parseAssetPurpose(hash.purpose),
		windowStart: parseRedisNumber(hash.windowStart),
		windowEnd: parseRedisNumber(hash.windowEnd),
		requests: parseRedisNumber(hash.requests),
		bytes: parseRedisNumber(hash.bytes),
		cacheHits: parseRedisNumber(hash.cacheHits),
		tokenRequiredRequests: parseRedisNumber(hash.tokenRequiredRequests),
		tokenAcceptedRequests: parseRedisNumber(hash.tokenAcceptedRequests),
		lastStatusCode: parseRedisNumber(hash.lastStatusCode),
		updatedAt: parseRedisNumber(hash.updatedAt),
	};
}

function parseRedisHash(value: unknown): Record<string, string> {
	if (Array.isArray(value)) {
		const hash: Record<string, string> = {};
		for (let index = 0; index < value.length; index += 2) {
			hash[String(value[index])] = String(value[index + 1] ?? "");
		}
		return hash;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
	}
	return {};
}

function parseRedisStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (value instanceof Set) return Array.from(value).map(String);
	return [];
}

function parseRedisScalar(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
	return String(value);
}

function parseRedisNumber(value: string | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseAssetPurpose(value: string | undefined): AssetAccessPurpose {
	return value === "original"
		|| value === "thumbnail"
		|| value === "editor_preview"
		|| value === "export"
		|| value === "ai_output"
		? value
		: "editor_preview";
}
