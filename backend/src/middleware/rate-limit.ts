import type { Context, MiddlewareHandler, Next } from "hono";
import { existsSync } from "fs";
import { PROJECTS_DIR, readTicketAiGuardrailsConfig, serverConfig } from "../config.js";
import { jobQueue } from "../services/queue.js";
import { withTimeout } from "../services/monitoring.js";
import type { AiTier } from "../types/index.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import { isValidProjectId, safePath } from "../utils/security.js";

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

interface RateLimitIncrementResult {
	count: number;
	resetAt: number;
}

export interface MemoryRateLimitStoreOptions {
	maxEntries?: number;
	windowJitterMs?: number;
}

export interface RateLimitStore {
	increment(key: string, windowMs: number, now: number, amount?: number): RateLimitIncrementResult | Promise<RateLimitIncrementResult>;
}

export interface RedisRateLimitClient {
	send(command: string, args: string[]): unknown | Promise<unknown>;
	close?(): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
	private readonly entries = new Map<string, RateLimitEntry>();
	private readonly maxEntries: number;
	private readonly windowJitterMs: number;
	private requestCount = 0;

	constructor(options: MemoryRateLimitStoreOptions | number = {}) {
		if (typeof options === "number") {
			this.maxEntries = options;
			this.windowJitterMs = 0;
			return;
		}
		this.maxEntries = options.maxEntries ?? DEFAULT_MEMORY_RATE_LIMIT_MAX_ENTRIES;
		this.windowJitterMs = options.windowJitterMs ?? 0;
	}

	increment(key: string, windowMs: number, now: number, amount = 1): RateLimitIncrementResult {
		this.requestCount++;
		if (this.requestCount % 1000 === 0 || this.entries.size > this.maxEntries) {
			this.sweep(now);
		}

		// Derive the fallback window from time + key, not from the first failing hit.
		// That keeps Redis-outage fallback counters from granting a fresh full window
		// on every blip, while optional deterministic jitter prevents all keys from
		// resetting together at the exact epoch boundary during an outage.
		const windowStart = getJitteredWindowStart(key, now, windowMs, this.windowJitterMs);
		const resetAt = windowStart + windowMs;
		const entryKey = `${key}:${windowStart}`;

		let entry = this.entries.get(entryKey);
		if (!entry) {
			entry = { count: 0, resetAt };
			this.entries.set(entryKey, entry);
		}

		entry.count += sanitizeRequestCost(amount);
		return { count: entry.count, resetAt: entry.resetAt };
	}

	clear(): void {
		this.entries.clear();
		this.requestCount = 0;
	}

	private sweep(now: number): void {
		for (const [key, entry] of this.entries.entries()) {
			if (now >= entry.resetAt) {
				this.entries.delete(key);
			}
		}
	}
}

export interface RedisRateLimitStoreOptions {
	client?: RedisRateLimitClient;
	url?: string;
	keyPrefix?: string;
	expiryBufferSeconds?: number;
}

export class RedisRateLimitStore implements RateLimitStore {
	private client?: RedisRateLimitClient;
	private clientInit?: Promise<RedisRateLimitClient>;
	private readonly url?: string;
	private readonly keyPrefix: string;
	private readonly expiryBufferSeconds: number;

	constructor(options: RedisRateLimitStoreOptions = {}) {
		this.client = options.client;
		this.url = options.url;
		this.keyPrefix = options.keyPrefix ?? process.env.RATE_LIMIT_REDIS_KEY_PREFIX ?? "manga-editor:rate-limit";
		this.expiryBufferSeconds = options.expiryBufferSeconds ?? 5;
	}

	async increment(key: string, windowMs: number, now: number, amount = 1): Promise<RateLimitIncrementResult> {
		const client = await this.getClient();
		const windowStart = getWindowStart(now, windowMs);
		const resetAt = windowStart + windowMs;
		const redisKey = [this.keyPrefix, key, windowStart].join(":");
		const ttlMs = Math.max(1, windowMs + this.expiryBufferSeconds * 1000);
		// Bound the EVAL so a SLOW Redis (flap/black-hole) REJECTS instead of hanging
		// (issue #4 RT-2): the limiter's fail-closed→503 fires on a rejection, so a
		// hang would otherwise silently stall every auth-sensitive request rather than
		// honestly 503-ing. Redis EVAL is normally <5ms; 250ms is generous headroom.
		const count = parseRedisInteger(await withTimeout(Promise.resolve(client.send("EVAL", [
			REDIS_INCREMENT_SCRIPT,
			"1",
			redisKey,
			String(sanitizeRequestCost(amount)),
			String(ttlMs),
		])), 250));
		return { count, resetAt };
	}

	close(): void {
		this.clientInit = undefined;
		this.client?.close?.();
	}

	private async getClient(): Promise<RedisRateLimitClient> {
		if (this.client) return this.client;
		// Cache the PENDING initialization, not just the resolved client: a
		// cold-start burst would otherwise pass the `!this.client` check
		// concurrently and each request would construct (and leak) its own
		// Redis connection (codex P2).
		if (!this.clientInit) {
			// Bound client construction/connect so a slow Redis can't hang the
			// limiter's hot path on cold start (issue #4 RT-4): a timeout REJECTS
			// here, which resets clientInit (so the next request retries) and
			// propagates to the caller's fail-closed→503 instead of stalling.
			this.clientInit = withTimeout(createRedisClient(this.url), 2000).then(
				(client) => {
					this.client = client;
					return client;
				},
				(error) => {
					// Let the next request retry instead of pinning a failed promise.
					this.clientInit = undefined;
					throw error;
				},
			);
		}
		return this.clientInit;
	}
}

export interface FallbackRateLimitStoreOptions {
	primary: RateLimitStore;
	fallback?: RateLimitStore;
	onError?: (error: unknown) => void;
}

export class FallbackRateLimitStore implements RateLimitStore {
	private readonly fallback: RateLimitStore;

	constructor(private readonly options: FallbackRateLimitStoreOptions) {
		this.fallback = options.fallback ?? new MemoryRateLimitStore({ windowJitterMs: DEFAULT_FALLBACK_WINDOW_JITTER_MS });
	}

	async increment(key: string, windowMs: number, now: number, amount = 1): Promise<RateLimitIncrementResult> {
		try {
			return await this.options.primary.increment(key, windowMs, now, amount);
		} catch (error) {
			this.options.onError?.(error);
			return this.fallback.increment(key, windowMs, now, amount);
		}
	}
}

export interface RateLimitOptions {
	/** Time window in milliseconds. */
	windowMs: number;
	/** Max requests per window. */
	maxRequests: number;
	/** Key extractor from context. Defaults to client IP. */
	keyFn?: (c: Context) => string;
	policyId?: string;
	store?: RateLimitStore;
	now?: () => number;
}

export type RateLimitScope = "ip" | "user" | "workspace" | "ticket";
export type RateLimitFailureMode = "allow" | "fallback" | "block";
export type RateLimitRequestCost = number | ((c: Context) => number | Promise<number>);

export interface RateLimitPolicy {
	id: string;
	windowMs: number;
	maxRequests: number;
	scopes?: RateLimitScope[];
	matches?: (c: Context) => boolean;
	keyFn?: (c: Context) => string;
	requestCost?: RateLimitRequestCost;
	failureMode?: RateLimitFailureMode;
}

export interface LayeredRateLimitOptions {
	policies?: RateLimitPolicy[];
	store?: RateLimitStore;
	fallbackStore?: RateLimitStore | null;
	now?: () => number;
	onLimitExceeded?: (decision: RateLimitDecision) => void;
	onStoreError?: (error: unknown, context: { policy: RateLimitPolicy; key: string }) => void;
}

export interface RateLimitDecision {
	policy: RateLimitPolicy;
	key: string;
	limit: number;
	remaining: number;
	resetAt: number;
	retryAfterSeconds: number;
	count: number;
	requestCost: number;
	storeUnavailable: boolean;
	rejectionReason: "limit_exceeded" | "store_unavailable" | null;
}

const DEFAULT_MEMORY_RATE_LIMIT_MAX_ENTRIES = 50_000;
const DEFAULT_FALLBACK_WINDOW_JITTER_MS = 5_000;
const sharedStore = new MemoryRateLimitStore();
const sharedFallbackStore = new MemoryRateLimitStore({ windowJitterMs: DEFAULT_FALLBACK_WINDOW_JITTER_MS });
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_HOUR_WINDOW_MS = 60 * 60_000;
const RATE_LIMIT_WORKSPACE_ID_CACHE_KEY = "rateLimitWorkspaceId";
const REDIS_INCREMENT_SCRIPT = `
local count = redis.call("INCRBY", KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
	redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return count
`;

export function createSharedRateLimitStore(): RateLimitStore {
	const selectedStore = (process.env.RATE_LIMIT_STORE ?? "").trim().toLowerCase();
	const redisUrl = process.env.REDIS_URL;
	const shouldUseRedis = selectedStore === "redis" || (selectedStore !== "memory" && Boolean(redisUrl));

	if (!shouldUseRedis) {
		return sharedStore;
	}

	return new RedisRateLimitStore({ url: redisUrl });
}

function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pathMatches(path: string, pattern: RegExp): boolean {
	return pattern.test(path);
}

function isMutationMethod(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function estimatePayloadCost(c: Context, unitBytes: number, maxCost: number): number {
	const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
	if (!Number.isFinite(contentLength) || contentLength <= 0) return 1;
	return Math.min(maxCost, Math.max(1, Math.ceil(contentLength / unitBytes)));
}

async function estimateAiSubmitCost(c: Context): Promise<number> {
	const retryJobId = c.req.path.match(/^\/api\/ai\/status\/([^/]+)\/retry$/)?.[1];
	if (retryJobId) {
		const tier = await jobQueue.getTier(decodeURIComponent(retryJobId));
		return estimateAiTierRateCost(tier);
	}

	const explicitTier = parseAiTier(c.req.header("x-ai-tier") ?? c.req.query("tier"));
	if (explicitTier) return estimateAiTierRateCost(explicitTier);

	return estimateAiTierRateCost(undefined);
}

function isAiSubmitPath(c: Context): boolean {
	if (c.req.method !== "POST") return false;
	if (c.req.path === "/api/ai/translate") return true;
	if (pathMatches(c.req.path, /^\/api\/ai\/status\/[^/]+\/retry$/)) return true;
	return pathMatches(c.req.path, /^\/api\/project\/[^/]+\/ai-markers\/[^/]+\/rerun$/);
}

function isTmEmbedPath(c: Context): boolean {
	if (c.req.method !== "POST") return false;
	return c.req.path === "/api/tm" || c.req.path === "/api/tm/search";
}

function isCropModerationPath(c: Context): boolean {
	return c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/crops\/[^/]+\/check$/);
}

// Both image-ingest endpoints buffer the uploaded files into memory and run Sharp:
//   POST /api/images/:projectId/upload            (raw ingest)
//   POST /api/images/:projectId/upload-transform  (merge/split, also Sharp-heavy)
// They must therefore share the SAME upload rate-limit + byte-unit policies — the
// /upload-transform path was previously unthrottled, so a flood of merge/split
// requests could buffer + decode unbounded source bytes outside the upload caps.
function isImageUploadPath(c: Context): boolean {
	return c.req.method === "POST"
		&& pathMatches(c.req.path, /^\/api\/images\/[^/]+\/(upload|upload-transform)$/);
}

// ── Export enqueue admission helper ─────────────────────────────────────────
// POST /api/export persists a Sharp export job that can render up to 500 imageIds
// (decode/resize/slice/encode each). It previously only fell through the generic
// api:global buckets, so a script could enqueue render jobs as fast as a cheap GET.
// Give it a dedicated, generous-but-bounded admission cap scoped per
// workspace+user+ip so one tenant cannot flood the render pipeline. GET status /
// presets / readiness reads are NOT throttled here (they don't enqueue work).
function isImportCleanedPath(c: Context): boolean {
	return c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/import\/cleaned\/[^/]+$/);
}

function isWorkspaceInviteCreatePath(c: Context): boolean {
	return c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/workspaces\/[^/]+\/invites$/);
}

function isWorkspaceMemberRemovePath(c: Context): boolean {
	return c.req.method === "DELETE" && pathMatches(c.req.path, /^\/api\/workspaces\/[^/]+\/members\/[^/]+$/);
}

function isExportOriginalsPath(c: Context): boolean {
	return c.req.method === "GET" && pathMatches(c.req.path, /^\/api\/export\/originals\/[^/]+$/);
}

function isExportEnqueuePath(c: Context): boolean {
	return c.req.method === "POST" && c.req.path === "/api/export";
}

// ── AI support ticket rate-limit helpers (rank6) ────────────────────────────
// Layer 1 of the support guardrails. All ticket policies fail CLOSED ('block'):
// if the limiter store is unavailable we must NOT let unbounded ticket/AI traffic
// through (that would leak LLM spend), unlike the generic API policies that
// fall back. Token cost is approximated cheaply (no model call) so the cost-
// weighted policy can throttle before any gpt-5.5 request is issued.

const TICKET_AI_REPLY_TOKEN_RESERVE = 600;

// The largest request body we will price a single ticket reply against. A ticket
// message is enforced server-side to be at most this many bytes; anything bigger
// is rejected on read, so a request claiming (or streaming) more than this can be
// charged as if it were exactly this big without ever undercharging a real reply.
// Used as the FAIL-CLOSED estimate when Content-Length is absent (chunked /
// streamed) so a flood of large no-Content-Length replies cannot slip the
// token-unit limiter by being priced at reserve-only.
const TICKET_AI_MAX_BODY_BYTES = 16 * 1024;

// NOTE: the support-ticket router is mounted at /api/support (index.ts), and the
// routes inside it are /tickets + /tickets/:id/messages, so the real, mounted
// paths are /api/support/tickets and /api/support/tickets/:id/messages. These
// matchers must use that prefix or the cost-weighted AI-reply limiter never fires.
function isTicketOpenPath(c: Context): boolean {
	return c.req.method === "POST" && c.req.path === "/api/support/tickets";
}

function isTicketReplyPath(c: Context): boolean {
	return c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/support\/tickets\/[^/]+\/messages$/);
}

// Cheap prompt-token estimate (no tokenizer / no model call): ~4 chars/token over
// the request body, plus a fixed reserve for the agent's own reply tokens. The
// cost-weighted policy charges ceil(estimatedPromptTokens/100) units so a long
// message costs proportionally more of the per-minute token budget.
//
// FAIL CLOSED on a missing/unparseable/chunked Content-Length: we charge the body
// as if it were the MAX allowed size (TICKET_AI_MAX_BODY_BYTES) rather than 0. A
// no-Content-Length (chunked/streamed) reply could otherwise carry an arbitrarily
// large prompt while paying reserve-only, letting a burst of big replies evade the
// per-minute token-unit budget — the exact token-cost hole this limiter exists to
// close. A normal request with a sane Content-Length is still priced exactly,
// capped at the same max so a forged huge header cannot over-charge a real user.
function estimateTicketPromptTokens(c: Context): number {
	const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
	const bodyChars = Number.isFinite(contentLength) && contentLength > 0
		? Math.min(contentLength, TICKET_AI_MAX_BODY_BYTES)
		: TICKET_AI_MAX_BODY_BYTES;
	return Math.ceil(bodyChars / 4) + TICKET_AI_REPLY_TOKEN_RESERVE;
}

export function estimateTicketAiTokenUnits(c: Context): number {
	return Math.max(1, Math.ceil(estimateTicketPromptTokens(c) / 100));
}

function isAuthSensitivePath(c: Context): boolean {
	if (!isMutationMethod(c.req.method)) return false;
	return c.req.path === "/api/auth/change-password"
		|| pathMatches(c.req.path, /^\/api\/auth\/users\/[^/]+/)
		|| c.req.path === "/api/auth/logout";
}

// Session-check endpoints that the SPA fires on (almost) every navigation:
// `GET /api/auth/me` (who-am-I) and `POST /api/auth/refresh` (silent token
// rotation). These are cheap, idempotent-ish, and NOT a credential-guessing
// surface (login/register are), so a fast-clicking human flipping between
// pages must not exhaust the tight generic per-minute bucket via them and get
// silently logged out (the P3 bug). They are EXEMPTED from `api:global` /
// `api:global-hour` and instead bucketed by their own generous
// `api:auth-session` policy (plus, for refresh, the existing dedicated
// `api:auth-refresh` cap which remains the real abuse guard). Login/register
// stay on their tight per-IP block limits — this exemption never touches them.
function isAuthSessionCheckPath(c: Context): boolean {
	if (c.req.method === "GET" && c.req.path === "/api/auth/me") return true;
	if (c.req.method === "POST" && c.req.path === "/api/auth/refresh") return true;
	return false;
}

export function createDefaultRateLimitPolicies(): RateLimitPolicy[] {
	// Canonical AI-support ticket limits — the SAME block the budget / per-ticket
	// cap / spam guardrails read. Resolved live (not from serverConfig captured at
	// module load) so an operator/test env change to the documented TICKET_AI_*
	// names is reflected by the limiter on the next policy build.
	const ticketAi = readTicketAiGuardrailsConfig();
	return [
		{
			id: "api:global",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_API_PER_MINUTE", 600),
			scopes: ["ip"],
			failureMode: "fallback",
			// Exempt the per-navigation session-check endpoints (see
			// isAuthSessionCheckPath): rapid navigation must not burn the generic
			// per-minute budget on who-am-I / silent-refresh and get the user
			// bounced to /login. They have their own generous api:auth-session cap.
			matches: (c) => !isAuthSessionCheckPath(c),
		},
		{
			id: "api:global-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_API_PER_HOUR", 12_000),
			scopes: ["ip"],
			failureMode: "fallback",
			matches: (c) => !isAuthSessionCheckPath(c),
		},
		{
			// Dedicated, generous bucket for the SPA's per-navigation session checks
			// (GET /api/auth/me + POST /api/auth/refresh). Sized so a fast-clicking
			// human navigating ~once/second for several minutes cannot exhaust it,
			// while still capping a runaway client/script. Fails OPEN (fallback) so a
			// limiter-store blip never logs real users out. Refresh additionally
			// passes through api:auth-refresh (block) which stays the true abuse cap;
			// login/register are unaffected and stay tightly limited.
			id: "api:auth-session",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_SESSION_PER_MINUTE", 600),
			scopes: ["ip"],
			failureMode: "fallback",
			matches: isAuthSessionCheckPath,
		},
		{
			id: "api:auth-session-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_SESSION_PER_HOUR", 12_000),
			scopes: ["ip"],
			failureMode: "fallback",
			matches: isAuthSessionCheckPath,
		},
		{
			id: "api:auth-login",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_LOGIN_PER_MINUTE", 10),
			scopes: ["ip"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && c.req.path === "/api/auth/login",
		},
		{
			id: "api:auth-register",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_REGISTER_PER_MINUTE", 5),
			scopes: ["ip"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && c.req.path === "/api/auth/register",
		},
		{
			id: "api:auth-refresh",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_REFRESH_PER_MINUTE", 60),
			scopes: ["ip"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && c.req.path === "/api/auth/refresh",
		},
		{
			id: "api:auth-sensitive",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AUTH_SENSITIVE_PER_MINUTE", 10),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: isAuthSensitivePath,
		},
		{
			id: "api:project-write",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_PROJECT_WRITE_PER_MINUTE", 240),
			scopes: ["ip", "workspace"],
			failureMode: "fallback",
			matches: (c) => c.req.path.startsWith("/api/project/") && isMutationMethod(c.req.method),
		},
		{
			id: "api:upload",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_UPLOAD_PER_MINUTE", 20),
			scopes: ["ip", "workspace"],
			failureMode: "block",
			matches: isImageUploadPath,
		},
		{
			id: "api:upload-byte-units",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_UPLOAD_MB_UNITS_PER_MINUTE", 200),
			scopes: ["ip", "workspace"],
			requestCost: (c) => estimatePayloadCost(c, 1024 * 1024, 100),
			failureMode: "block",
			matches: isImageUploadPath,
		},
		{
			id: "api:upload-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_UPLOAD_PER_HOUR", 300),
			scopes: ["ip", "workspace"],
			failureMode: "block",
			matches: isImageUploadPath,
		},
		{
			id: "api:image-read",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_IMAGE_READ_PER_MINUTE", 300),
			scopes: ["ip", "workspace"],
			failureMode: "fallback",
			matches: (c) => c.req.method === "GET" && pathMatches(c.req.path, /^\/api\/images\/[^/]+\/[^/]+/),
		},
		{
			id: "api:asset-token",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_ASSET_TOKEN_PER_MINUTE", 120),
			scopes: ["ip", "workspace", "user"],
			failureMode: "fallback",
			matches: (c) => c.req.method === "GET" && pathMatches(c.req.path, /^\/api\/images\/[^/]+\/[^/]+\/access-token$/),
		},
		{
			id: "api:ai-submit",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AI_SUBMIT_PER_MINUTE", 20),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isAiSubmitPath,
		},
		{
			id: "api:ai-submit-cost",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE", 80),
			scopes: ["ip", "workspace", "user"],
			requestCost: estimateAiSubmitCost,
			failureMode: "block",
			matches: isAiSubmitPath,
		},
		{
			id: "api:ai-submit-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_AI_SUBMIT_PER_HOUR", 120),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isAiSubmitPath,
		},
		// Export ENQUEUE admission cap (distinct from the export-USAGE accounting
		// policies below). POST /api/export persists a Sharp render job (up to 500
		// imageIds, each decoded/resized/sliced/encoded), so it must not ride the
		// generic api:global bucket alone. Per-minute + per-hour caps scoped by
		// workspace+user+ip bound how fast one tenant can queue render work; both fail
		// CLOSED so a limiter-store blip cannot let an unbounded enqueue flood through.
		{
			id: "api:export-enqueue",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_ENQUEUE_PER_MINUTE", 30),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isExportEnqueuePath,
		},
		// Bulk-originals download builds a whole-chapter ZIP in memory on the
		// request path (codex P2), so it gets its own small fail-CLOSED budget —
		// api:global alone (600/min, fail-open) cannot bound it.
		// Cleaned-chapter import buffers + moderates a whole multipart body on the
		// request path — small fail-CLOSED budget like export-originals (codex P1).
		// Member add/remove churn caps (pre-launch issue 12, owner: "จำกัดเพิ่มลบ
		// user ในแต่ละวัน"): invite-mint and member-removal are cheap rows but the
		// abuse vector is seat churning / invite spam. Fail CLOSED — these are
		// admin actions, not user-blocking hot paths.
		{
			id: "api:workspace-invites-day",
			windowMs: 24 * 60 * 60_000,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_WORKSPACE_INVITES_PER_DAY", 10),
			scopes: ["workspace", "user"],
			failureMode: "block",
			matches: isWorkspaceInviteCreatePath,
		},
		{
			id: "api:workspace-member-remove-day",
			windowMs: 24 * 60 * 60_000,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_WORKSPACE_MEMBER_REMOVALS_PER_DAY", 5),
			scopes: ["workspace", "user"],
			failureMode: "block",
			matches: isWorkspaceMemberRemovePath,
		},
		{
			id: "api:import-cleaned",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_IMPORT_CLEANED_PER_MINUTE", 4),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isImportCleanedPath,
		},
		{
			id: "api:import-cleaned-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_IMPORT_CLEANED_PER_HOUR", 30),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isImportCleanedPath,
		},
		{
			id: "api:export-originals",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_ORIGINALS_PER_MINUTE", 6),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isExportOriginalsPath,
		},
		{
			id: "api:export-originals-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_ORIGINALS_PER_HOUR", 40),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isExportOriginalsPath,
		},
		{
			id: "api:export-enqueue-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_ENQUEUE_PER_HOUR", 200),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isExportEnqueuePath,
		},
		{
			id: "api:export-usage",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_USAGE_PER_MINUTE", 60),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/usage\/[^/]+\/export$/),
		},
		{
			id: "api:export-usage-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_EXPORT_USAGE_PER_HOUR", 500),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && pathMatches(c.req.path, /^\/api\/usage\/[^/]+\/export$/),
		},
		{
			// Crop moderation hits the shared OpenAI moderation quota. Cap it like an
			// AI safety call (block-on-failure) so it can't exhaust the key and force
			// production upload/prompt moderation to fail closed.
			id: "api:crop-moderation",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_CROP_MODERATION_PER_MINUTE", 20),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isCropModerationPath,
		},
		{
			id: "api:crop-moderation-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_CROP_MODERATION_PER_HOUR", 120),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isCropModerationPath,
		},
		{
			id: "api:admin",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_ADMIN_PER_MINUTE", 60),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: (c) => c.req.path.startsWith("/api/ai/admin/"),
		},
		{
			// Platform back-office MUTATIONS (refund, credit grant, delete/role-change
			// user, impersonate, coupon mint, etc.). The only other coverage was the
			// IP-scoped fail-open GLOBAL caps (defeated by IP rotation, no per-user
			// bound), so a compromised admin/support session could run privileged
			// money/account mutations at scale. Cap per user AND per ip with
			// failureMode "block". The "api:admin" policy above matches only the AI
			// console (/api/ai/admin/), NOT this platform back-office (/api/admin/).
			id: "api:admin-mutation",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_ADMIN_MUTATION_PER_MINUTE", 40),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: (c) => c.req.path.startsWith("/api/admin/") && isMutationMethod(c.req.method),
		},
		// TM writes + searches both spend an OpenAI embedding call but are NOT
		// covered by the AI-submit policies above (different paths). Gate them with
		// their own per-minute + per-hour caps, scoped by workspace+user+ip, so a
		// member cannot run up embedding cost at the generic API rate.
		{
			id: "api:tm-embed",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_TM_EMBED_PER_MINUTE", 60),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isTmEmbedPath,
		},
		{
			id: "api:tm-embed-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_TM_EMBED_PER_HOUR", 600),
			scopes: ["ip", "workspace", "user"],
			failureMode: "block",
			matches: isTmEmbedPath,
		},
		{
			// Background text-QA is called on debounced edits / blur, so it can be
			// frequent, but the per-char daily budget is the real cost guard. This
			// per-minute cap just bounds burst abuse of the provider endpoint.
			id: "api:text-qa",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_TEXT_QA_PER_MINUTE", 60),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: (c) => c.req.method === "POST" && c.req.path === "/api/text-qa/check",
		},
		// ── AI support tickets (rank6, Layer 1) ─────────────────────────────
		// Opening a ticket and replying are cheap-but-spammable: cap them per ip+user
		// so a script cannot flood the human queue (which would also drive AI spend
		// once the agent runs). All fail CLOSED.
		{
			id: "api:ticket-open",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_TICKET_OPEN_PER_HOUR", 5),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: isTicketOpenPath,
		},
		{
			id: "api:ticket-reply",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: readPositiveIntEnv("RATE_LIMIT_TICKET_REPLY_PER_MINUTE", 10),
			scopes: ["ip", "user"],
			failureMode: "block",
			matches: isTicketReplyPath,
		},
		// The three AI-reply policies bound how fast (and how token-heavy) a single
		// user can drive the gpt-5.5 agent. Scoped by user (+ ticket for the
		// per-minute message cap) so one chatty ticket cannot starve the budget.
		//
		// SINGLE SOURCE OF TRUTH: these limits read the SAME canonical TICKET_AI_*
		// config block the budget / per-ticket-cap / spam layers read
		// (readTicketAiGuardrailsConfig → serverConfig.ticketAiGuardrails), NOT a
		// parallel RATE_LIMIT_TICKET_AI_* namespace. Tuning the documented
		// TICKET_AI_MSG_PER_MINUTE / TICKET_AI_MSG_PER_HOUR /
		// TICKET_AI_TOKEN_UNITS_PER_MINUTE envs therefore actually moves the limiter.
		// Read live (per policy build) so a test/operator env change is reflected.
		{
			id: "api:ticket-ai-msg-min",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: ticketAi.msgPerMinute,
			scopes: ["user", "ticket"],
			failureMode: "block",
			matches: isTicketReplyPath,
		},
		{
			id: "api:ticket-ai-msg-hour",
			windowMs: DEFAULT_HOUR_WINDOW_MS,
			maxRequests: ticketAi.msgPerHour,
			scopes: ["user"],
			failureMode: "block",
			matches: isTicketReplyPath,
		},
		{
			// Cost-weighted: charges ceil(estimatedPromptTokens/100) units per reply so
			// a few very long messages exhaust the per-minute token budget the same way
			// many short ones would. Estimate is heuristic + cheap (no model call).
			id: "api:ticket-ai-token-min",
			windowMs: DEFAULT_WINDOW_MS,
			maxRequests: ticketAi.tokenUnitsPerMinute,
			scopes: ["user"],
			requestCost: estimateTicketAiTokenUnits,
			failureMode: "block",
			matches: isTicketReplyPath,
		},
	];
}

export function layeredRateLimit(options: LayeredRateLimitOptions = {}): MiddlewareHandler {
	const policies = options.policies ?? createDefaultRateLimitPolicies();
	const store = options.store ?? sharedStore;
	const fallbackStore = options.fallbackStore === undefined
		? (store === sharedStore ? null : sharedFallbackStore)
		: options.fallbackStore;
	const clock = options.now ?? Date.now;

	return async (c: Context, next: Next) => {
		const now = clock();
		const matchingPolicies = policies.filter((policy) => policy.maxRequests > 0 && (policy.matches?.(c) ?? true));

		if (matchingPolicies.length === 0) {
			await next();
			return;
		}

		const decisions = await Promise.all(matchingPolicies.map((policy) => evaluatePolicy(c, policy, store, fallbackStore, now, options)));
		const rejected = decisions.find((decision) => decision.rejectionReason);
		const headerDecision = rejected ?? pickMostConstrainedDecision(decisions);
		applyRateLimitHeaders(c, headerDecision);

		if (rejected) {
			options.onLimitExceeded?.(rejected);
			if (rejected.rejectionReason === "store_unavailable") {
				return c.json({
					error: "Rate limit protection temporarily unavailable",
					code: "rate_limit_store_unavailable",
					policyId: rejected.policy.id,
					retryAfter: rejected.retryAfterSeconds,
				}, 503);
			}
			return c.json({
				error: "Too many requests",
				code: "rate_limit_exceeded",
				policyId: rejected.policy.id,
				retryAfter: rejected.retryAfterSeconds,
				requestCost: rejected.requestCost,
			}, 429);
		}

		await next();
	};
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
	return layeredRateLimit({
		policies: [{
			id: opts.policyId ?? "api:legacy",
			windowMs: opts.windowMs,
			maxRequests: opts.maxRequests,
			keyFn: opts.keyFn,
			failureMode: "fallback",
		}],
		store: opts.store,
		now: opts.now,
	});
}

async function evaluatePolicy(
	c: Context,
	policy: RateLimitPolicy,
	store: RateLimitStore,
	fallbackStore: RateLimitStore | null,
	now: number,
	options: LayeredRateLimitOptions,
): Promise<RateLimitDecision> {
	let key = `rate-limit:${policy.id}:key-unavailable`;
	let requestCost = 1;
	try {
		key = policy.keyFn?.(c) ?? await buildPolicyKey(c, policy);
		requestCost = await getPolicyRequestCost(c, policy);
		const result = await store.increment(key, policy.windowMs, now, requestCost);
		return buildDecision({ policy, key, result, requestCost, storeUnavailable: false, now });
	} catch (error) {
		options.onStoreError?.(error, { policy, key });
		const failureMode = policy.failureMode ?? "fallback";
		if (failureMode === "allow") {
			return buildDecision({
				policy,
				key,
				result: { count: 0, resetAt: now + policy.windowMs },
				requestCost,
				storeUnavailable: true,
				now,
			});
		}
		if (failureMode === "fallback" && fallbackStore) {
			const result = await fallbackStore.increment(key, policy.windowMs, now, requestCost);
			return buildDecision({ policy, key, result, requestCost, storeUnavailable: true, now });
		}
		return buildDecision({
			policy,
			key,
			result: { count: policy.maxRequests + requestCost, resetAt: now + Math.min(policy.windowMs, 60_000) },
			requestCost,
			storeUnavailable: true,
			rejectionReason: "store_unavailable",
			now,
		});
	}
}

function buildDecision(input: {
	policy: RateLimitPolicy;
	key: string;
	result: RateLimitIncrementResult;
	requestCost: number;
	storeUnavailable: boolean;
	rejectionReason?: "limit_exceeded" | "store_unavailable" | null;
	now: number;
}): RateLimitDecision {
	const remaining = Math.max(0, input.policy.maxRequests - input.result.count);
	const rejectionReason = input.rejectionReason ?? (input.result.count > input.policy.maxRequests ? "limit_exceeded" : null);
	return {
		policy: input.policy,
		key: input.key,
		limit: input.policy.maxRequests,
		remaining,
		resetAt: input.result.resetAt,
		retryAfterSeconds: Math.max(1, Math.ceil((input.result.resetAt - input.now) / 1000)),
		count: input.result.count,
		requestCost: input.requestCost,
		storeUnavailable: input.storeUnavailable,
		rejectionReason,
	};
}

async function createRedisClient(url: string | undefined): Promise<RedisRateLimitClient> {
	// Load Bun's Redis client only on the Redis path so Node/Vitest can exercise
	// memory fallback behavior without trying to resolve Bun-only modules.
	const bunModuleSpecifier = "bun";
	const { RedisClient } = await import(/* @vite-ignore */ bunModuleSpecifier) as {
		RedisClient: new (url?: string) => RedisRateLimitClient;
	};
	if (url?.trim()) return new RedisClient(url);
	return new RedisClient();
}

function getWindowStart(now: number, windowMs: number): number {
	return Math.floor(now / windowMs) * windowMs;
}

function getJitteredWindowStart(key: string, now: number, windowMs: number, maxJitterMs: number): number {
	const jitterMs = getWindowJitterMs(key, windowMs, maxJitterMs);
	return getWindowStart(now - jitterMs, windowMs) + jitterMs;
}

function getWindowJitterMs(key: string, windowMs: number, maxJitterMs: number): number {
	const safeJitterMs = Math.min(
		Math.max(0, Math.floor(maxJitterMs)),
		Math.max(0, Math.floor(windowMs) - 1),
	);
	if (safeJitterMs <= 0) return 0;
	return hashStringToUint32(key) % (safeJitterMs + 1);
}

function hashStringToUint32(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

function parseRedisInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid Redis rate-limit counter: ${String(value)}`);
	}
	return parsed;
}

function sanitizeRequestCost(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 1;
	return Math.min(10_000, Math.max(1, Math.ceil(value)));
}

async function getPolicyRequestCost(c: Context, policy: RateLimitPolicy): Promise<number> {
	const rawCost = typeof policy.requestCost === "function" ? await policy.requestCost(c) : policy.requestCost;
	return sanitizeRequestCost(rawCost ?? 1);
}

function parseAiTier(value: string | undefined): AiTier | undefined {
	const tier = (value ?? "").trim().toLowerCase();
	if (tier === "sfx-pro" || tier === "clean-pro" || tier === "budget-clean") return tier;
	return undefined;
}

function estimateAiTierRateCost(tier: AiTier | undefined): number {
	if (tier === "sfx-pro") return 20;
	if (tier === "clean-pro") return 8;
	if (tier === "budget-clean") return 3;
	return 5;
}

async function buildPolicyKey(c: Context, policy: RateLimitPolicy): Promise<string> {
	const workspaceId = await getWorkspaceId(c);
	const scopes = policy.scopes?.length ? policy.scopes : ["ip"];
	const parts = scopes.map((scope) => {
		if (scope === "ip") return `ip:${getClientIp(c)}`;
		if (scope === "user") return `user:${getContextUserId(c) ?? "anonymous"}`;
		if (scope === "ticket") return `ticket:${getTicketId(c) ?? "none"}`;
		return `workspace:${workspaceId ?? "none"}`;
	});
	return ["rate-limit", policy.id, ...parts].join(":");
}

// Resolve the ticket id from the path the same way workspaceId/projectId are
// resolved today: read it straight off /api/support/tickets/:id/... . No body
// parse is needed because the AI-reply policies only apply to that nested path.
// Must match the mounted prefix (/api/support, index.ts) used by isTicketReplyPath.
function getTicketId(c: Context): string | undefined {
	const match = c.req.path.match(/^\/api\/support\/tickets\/([^/]+)/);
	const raw = match?.[1];
	if (!raw) return undefined;
	const decoded = safeDecodePathParam(raw);
	const trimmed = decoded.trim();
	if (!trimmed || trimmed.length > 200 || /[/\\\0]/.test(trimmed)) return undefined;
	return trimmed;
}

function getClientIp(c: Context): string {
	return getTrustedClientIp(c) ?? "unknown";
}

function getContextUserId(c: Context): string | undefined {
	const user = c.get("user") as { userId?: unknown; sub?: unknown; email?: unknown } | undefined;
	if (typeof user?.userId === "string" && user.userId.trim()) return user.userId.trim();
	if (typeof user?.sub === "string" && user.sub.trim()) return user.sub.trim();
	if (typeof user?.email === "string" && user.email.trim()) return user.email.trim();
	return undefined;
}

async function getWorkspaceId(c: Context): Promise<string | undefined> {
	const cached = c.get(RATE_LIMIT_WORKSPACE_ID_CACHE_KEY) as Promise<string | undefined> | undefined;
	if (cached) return cached;

	const workspaceId = resolveWorkspaceId(c);
	c.set(RATE_LIMIT_WORKSPACE_ID_CACHE_KEY, workspaceId);
	return workspaceId;
}

async function resolveWorkspaceId(c: Context): Promise<string | undefined> {
	const path = c.req.path;
	const projectMatch = path.match(/^\/api\/project\/([^/]+)/);
	if (projectMatch?.[1]) return projectMatch[1];
	const imageMatch = path.match(/^\/api\/images\/([^/]+)/);
	if (imageMatch?.[1]) return imageMatch[1];
	const usageMatch = path.match(/^\/api\/usage\/([^/]+)/);
	if (usageMatch?.[1]) return usageMatch[1];
	// Cleaned-chapter import: the chapterId IS the project id — without this the
	// fail-closed import buckets all key as workspace:none and one user's imports
	// across different workspaces share a single 4/min budget (codex P2).
	const importMatch = path.match(/^\/api\/import\/cleaned\/([^/]+)/);
	if (importMatch?.[1]) return importMatch[1];
	// Workspace-management routes (invite mint / member removal day caps): key by
	// the path's workspace id so each workspace gets its own churn budget —
	// without this they all bucket as workspace:none (review #592 P2).
	const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\//);
	if (workspaceMatch?.[1]) return workspaceMatch[1];
	if (c.req.method === "POST" && path === "/api/ai/translate") {
		return getAiTranslateBodyProjectId(c);
	}
	if (c.req.method === "POST" && (path === "/api/tm" || path === "/api/tm/search")) {
		return getJsonBodyWorkspaceId(c);
	}
	if (isCropModerationPath(c)) {
		return getAiTranslateBodyProjectId(c);
	}
	const retryMatch = path.match(/^\/api\/ai\/status\/([^/]+)\/retry$/);
	if (retryMatch?.[1]) {
		return (await jobQueue.get(safeDecodePathParam(retryMatch[1])))?.projectId;
	}
	return undefined;
}

async function getAiTranslateBodyProjectId(c: Context): Promise<string | undefined> {
	const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("application/json")) return undefined;

	const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > serverConfig.maxJsonBodySizeBytes) return undefined;

	const bodyText = await readBoundedRequestText(c.req.raw, serverConfig.maxJsonBodySizeBytes);
	if (!bodyText) return undefined;

	try {
		const body = JSON.parse(bodyText) as { projectId?: unknown };
		return resolveExistingProjectScopeId(body.projectId);
	} catch {
		return undefined;
	}
}

async function getJsonBodyWorkspaceId(c: Context): Promise<string | undefined> {
	const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("application/json")) return undefined;

	const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > serverConfig.maxJsonBodySizeBytes) return undefined;

	const bodyText = await readBoundedRequestText(c.req.raw, serverConfig.maxJsonBodySizeBytes);
	if (!bodyText) return undefined;

	try {
		const body = JSON.parse(bodyText) as { workspaceId?: unknown };
		return normalizeRateLimitWorkspaceId(body.workspaceId);
	} catch {
		return undefined;
	}
}

async function readBoundedRequestText(request: Request, limitBytes: number): Promise<string | undefined> {
	const body = request.clone().body;
	if (!body) return undefined;

	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > limitBytes) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}

	if (chunks.length === 0) return undefined;
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function normalizeRateLimitWorkspaceId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 200 || /[/\\\0]/.test(trimmed)) return undefined;
	return trimmed;
}

function resolveExistingProjectScopeId(value: unknown): string | undefined {
	const projectId = normalizeRateLimitWorkspaceId(value);
	if (!projectId || !isValidProjectId(projectId)) return undefined;

	try {
		return existsSync(safePath(PROJECTS_DIR, projectId, "state.json")) ? projectId : undefined;
	} catch {
		return undefined;
	}
}

function safeDecodePathParam(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function pickMostConstrainedDecision(decisions: RateLimitDecision[]): RateLimitDecision {
	return decisions.reduce((best, current) => {
		const bestRatio = best.remaining / best.limit;
		const currentRatio = current.remaining / current.limit;
		return currentRatio < bestRatio ? current : best;
	});
}

function applyRateLimitHeaders(c: Context, decision: RateLimitDecision): void {
	c.header("X-RateLimit-Policy", decision.policy.id);
	c.header("X-RateLimit-Limit", String(decision.limit));
	c.header("X-RateLimit-Remaining", String(decision.remaining));
	c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
	if (decision.count > decision.limit) {
		c.header("Retry-After", String(decision.retryAfterSeconds));
	}
}
