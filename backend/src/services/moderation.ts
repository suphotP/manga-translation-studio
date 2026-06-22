import { getSharedBunSql } from "./sql-pool.js";
import { createHash } from "crypto";
import { RedisClient } from "bun";
import { loadConfig, serverConfig } from "../config.js";
import { billingStore, type BillingStore } from "./billing-store.js";
import { withTimeout } from "./monitoring.js";
import type { AssetModerationResult } from "../types/index.js";

// Bound the moderation cache Redis round-trips so a hung store REJECTS into the
// existing try/catch (degrade to cache-miss / skip-write) instead of hanging the
// moderation request — a hang would NOT skip moderation, it would wedge it (#4 E).
const MODERATION_REDIS_TIMEOUT_MS = 500;

export type ModerationDecision = "allow" | "warn" | "block";
export type ModerationInputType = "text" | "image";

export interface ModerationResult {
	decision: ModerationDecision;
	categories: Record<string, boolean>;
	scores: Record<string, number>;
	cached: boolean;
	ruleset_version: string;
	reason?: string;
	provider: "openai_omni" | "local-development-rules";
	checkedAt: string;
	status?: "allow" | "warn" | "block" | "csam_block";
	bypassed?: boolean;
	error?: string;
}

export interface PromptModerationResult {
	status: "passed" | "blocked" | "needs_review";
	provider: string;
	checkedAt: string;
	reason?: string;
	categories?: Record<string, number>;
}

export interface ModerationAuditRecord {
	assetId?: string;
	sha256?: string;
	scores: Record<string, number>;
	blockedAt: string;
	ipAddress?: string;
	userAgent?: string;
	workspaceId?: string;
	reason?: string;
}

type ModerationAuditContext = Omit<ModerationAuditRecord, "scores" | "blockedAt" | "reason">;

export interface CsamBlockAuditStore {
	append(record: ModerationAuditRecord): Promise<void>;
	list?(): Promise<ModerationAuditRecord[]>;
	/**
	 * Denylist check: returns true when `sha256` matches a previously-recorded
	 * mandatory (CSAM/extreme) block. Used to HARD-BLOCK a known-bad image on
	 * re-upload BEFORE any provider/local-pass path runs, so a confirmed CSAM hash
	 * can never be re-admitted (even while the soft moderation toggle is off).
	 */
	hasBlockedSha256?(sha256: string): Promise<boolean>;
}

interface OpenAiModerationResult {
	flagged: boolean;
	categoryScores: Record<string, number>;
	categories: Record<string, boolean>;
	/**
	 * OpenAI omni-moderation reports which input modality (`text` / `image`)
	 * actually triggered each category. We keep it so a sexual *text* score in a
	 * combined text+image request is never escalated into an image CSAM block.
	 */
	appliedInputTypes: Record<string, ModerationInputType[]>;
}

interface ModerationCache {
	get(key: string): Promise<ModerationResult | undefined>;
	set(key: string, result: ModerationResult, ttlSeconds: number): Promise<void>;
	clear?(): void;
}

const HIGH_RISK_PROMPT_PATTERNS = [
	/\bnon[-\s]?consensual\b/i,
	/\bsexual\s+violence\b/i,
	/\bmake\s+.*\bexplicit\b/i,
	/\bremove\s+watermark\b/i,
];

const DEFAULT_RULESET_VERSION = "1.0";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const OPENAI_MODERATION_ENDPOINT = "https://api.openai.com/v1/moderations";
const OPENAI_MODERATION_PROVIDER = "openai_omni" as const;
const BYO_OPENAI_ADDON_IDS = new Set([
	"byo-openai-api",
	"byo-api",
	"studio-byo-openai",
	"studio-byo-api",
]);

export const DEFAULT_MODERATION_THRESHOLDS: Record<ModerationInputType, Record<string, number>> = {
	text: {
		"sexual/minors": 0.2,
		"self-harm/instructions": 0.4,
		"illicit/violent": 0.5,
		"hate/threatening": 0.5,
		"violence/graphic": 0.85,
		harassment: 0.8,
	},
	image: {
		sexual: 0.7,
		"violence/graphic": 0.85,
		violence: 0.9,
		"self-harm": 0.7,
	},
};

class MemoryModerationCache implements ModerationCache {
	private readonly entries = new Map<string, { expiresAt: number; result: ModerationResult }>();

	async get(key: string): Promise<ModerationResult | undefined> {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return { ...entry.result, cached: true };
	}

	async set(key: string, result: ModerationResult, ttlSeconds: number): Promise<void> {
		this.entries.set(key, {
			expiresAt: Date.now() + ttlSeconds * 1000,
			result: { ...result, cached: false },
		});
	}

	clear(): void {
		this.entries.clear();
	}
}

class RedisModerationCache implements ModerationCache {
	private readonly client: RedisClient;
	private readonly prefix: string;

	constructor(url = process.env.REDIS_URL, prefix = process.env.OPENAI_MODERATION_REDIS_KEY_PREFIX || "manga-editor:moderation") {
		this.client = url?.trim() ? new RedisClient(url) : new RedisClient();
		this.prefix = prefix;
	}

	async get(key: string): Promise<ModerationResult | undefined> {
		// A transient Redis outage must NOT make the cache a hard dependency for
		// moderated workflows: degrade to a cache miss so the provider moderation
		// path still runs (and can still fail-closed) instead of throwing a 500.
		try {
			const raw = await withTimeout(this.client.get(this.key(key)), MODERATION_REDIS_TIMEOUT_MS);
			if (!raw) return undefined;
			return { ...JSON.parse(raw), cached: true } as ModerationResult;
		} catch (error) {
			console.warn(`[Moderation] Redis cache get failed; treating as cache miss: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async set(key: string, result: ModerationResult, ttlSeconds: number): Promise<void> {
		// Skip the write (and swallow the error) on a transient Redis outage rather
		// than failing the moderation request that already produced a verdict.
		try {
			await withTimeout(this.client.send("SET", [this.key(key), JSON.stringify({ ...result, cached: false }), "EX", String(ttlSeconds)]), MODERATION_REDIS_TIMEOUT_MS);
		} catch (error) {
			console.warn(`[Moderation] Redis cache set failed; skipping cache write: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private key(key: string): string {
		return `${this.prefix}:${key}`;
	}
}

class MemoryCsamBlockAuditStore implements CsamBlockAuditStore {
	private readonly records: ModerationAuditRecord[] = [];

	async append(record: ModerationAuditRecord): Promise<void> {
		this.records.push(record);
	}

	async list(): Promise<ModerationAuditRecord[]> {
		return [...this.records];
	}

	async hasBlockedSha256(sha256: string): Promise<boolean> {
		const target = sha256.trim();
		if (!target) return false;
		return this.records.some((record) => record.sha256?.trim() === target);
	}
}

interface CsamAuditSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

export class PostgresCsamBlockAuditStore implements CsamBlockAuditStore {
	private readonly client: CsamAuditSqlClient;

	constructor(databaseUrlOrClient: string | CsamAuditSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("CSAM_BLOCK_AUDIT_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as CsamAuditSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async append(record: ModerationAuditRecord): Promise<void> {
		await this.client.unsafe(`
			INSERT INTO csam_blocks (
				asset_id,
				sha256,
				scores,
				blocked_at,
				ip_address,
				user_agent,
				workspace_id
			)
			VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7)
		`, [
			record.assetId ?? null,
			record.sha256 ?? null,
			JSON.stringify({
				...record.scores,
				reason: record.reason,
			}),
			record.blockedAt,
			record.ipAddress ?? null,
			record.userAgent ?? null,
			record.workspaceId ?? null,
		]);
	}

	async hasBlockedSha256(sha256: string): Promise<boolean> {
		const target = sha256.trim();
		if (!target) return false;
		// Uses the partial index csam_blocks_sha256_idx (migration 0048).
		const rows = await this.client.unsafe<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM csam_blocks WHERE sha256 = $1) AS exists`,
			[target],
		);
		return Boolean(rows[0]?.exists);
	}
}

let moderationCache: ModerationCache = process.env.REDIS_URL && process.env.NODE_ENV !== "test"
	? new RedisModerationCache()
	: new MemoryModerationCache();
let csamAuditStore: CsamBlockAuditStore = process.env.CSAM_BLOCK_AUDIT_STORE === "postgres" || (process.env.DATABASE_URL?.trim() && process.env.NODE_ENV !== "test")
	? new PostgresCsamBlockAuditStore()
	: new MemoryCsamBlockAuditStore();
let moderationBillingStore: BillingStore = billingStore;

export class ModerationError extends Error {
	readonly status = 403;
	readonly code = "moderation_blocked";

	constructor(readonly result: ModerationResult) {
		super(result.status === "csam_block" ? "Content blocked by mandatory safety policy" : "Content blocked by moderation policy");
		this.name = "ModerationError";
	}
}

export function setModerationCacheForTests(cache: ModerationCache): () => void {
	const previous = moderationCache;
	moderationCache = cache;
	return () => {
		moderationCache = previous;
	};
}

export function resetModerationCacheForTests(): void {
	moderationCache.clear?.();
}

export function setCsamAuditStoreForTests(store: CsamBlockAuditStore): () => void {
	const previous = csamAuditStore;
	csamAuditStore = store;
	return () => {
		csamAuditStore = previous;
	};
}

export function setModerationBillingStoreForTests(store: BillingStore): () => void {
	const previous = moderationBillingStore;
	moderationBillingStore = store;
	return () => {
		moderationBillingStore = previous;
	};
}

export function moderationRulesetVersion(): string {
	return process.env.OPENAI_MODERATION_RULESET_VERSION?.trim() || DEFAULT_RULESET_VERSION;
}

export function moderationModel(): string {
	return process.env.OPENAI_MODERATION_MODEL?.trim() || serverConfig.openai.moderationModel;
}

/** Default bound for a single OpenAI moderation provider call (ms). */
const DEFAULT_MODERATION_PROVIDER_TIMEOUT_MS = 15000;

/**
 * Per-call bound (ms) on the OpenAI moderation provider request. Without this a
 * hung/slow provider endpoint would block the WHOLE upload commit indefinitely —
 * moderation runs per image, synchronously, inside the upload loop. On timeout the
 * provider fetch is aborted and throws, which `moderateMultimodal`'s existing catch
 * turns into a fail-CLOSED result (bare `block` in production, then converted to
 * `needs_review` by the mandatory CSAM screen) — the policy is unchanged, only the
 * infinite hang becomes a bounded fail-closed verdict. Configurable via
 * `OPENAI_MODERATION_TIMEOUT_MS`; a non-positive/garbage value falls back to the
 * default. `0`/negative does NOT disable the bound (a disabled bound is the bug we
 * are fixing); the floor keeps a real timeout in place.
 */
export function moderationProviderTimeoutMs(): number {
	const raw = process.env.OPENAI_MODERATION_TIMEOUT_MS?.trim();
	if (raw) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return DEFAULT_MODERATION_PROVIDER_TIMEOUT_MS;
}

export function moderationFailOpen(): boolean {
	const raw = process.env.OPENAI_MODERATION_FAIL_OPEN;
	if (raw?.trim()) return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
	return process.env.NODE_ENV !== "production";
}

/**
 * Operator kill switch for asset (image) moderation. When disabled — e.g. during
 * a provider outage or a staged rollout — image uploads and AI outputs skip the
 * OpenAI call and receive a local pass instead of being fail-closed/blocked.
 * Hard prompt (text) moderation is governed separately by `promptModerationEnabled`.
 *
 * The documented `OPENAI_MODERATION_ENABLED` env switch is an explicit override:
 * deployments already using it for outage/staged-rollout must keep working without
 * having to mutate `data/config.json` through the config API. When the env var is
 * set we honor it; otherwise we fall back to the saved runtime config value.
 */
export function imageModerationEnabled(): boolean {
	const raw = process.env.OPENAI_MODERATION_ENABLED;
	if (raw?.trim()) return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
	try {
		return loadConfig().imageModerationEnabled;
	} catch {
		return true;
	}
}

/**
 * True in a real (production) deployment. The mandatory CSAM screen MUST run and
 * fail closed here regardless of the soft `imageModerationEnabled` toggle.
 */
function isProductionRuntime(): boolean {
	return process.env.NODE_ENV === "production";
}

/**
 * Explicit, non-production-only escape hatch that allows the mandatory CSAM
 * screen to local-pass when the provider is unconfigured (e.g. a dev/CI machine
 * with no OpenAI key and the soft toggle off). It is IGNORED in production: there
 * the mandatory screen always runs and fails closed. Defaults to allowed only
 * outside production.
 */
export function mandatoryCsamDevBypassAllowed(): boolean {
	if (isProductionRuntime()) return false;
	const raw = process.env.MANDATORY_CSAM_DEV_BYPASS;
	if (raw?.trim()) return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
	// Default for non-production: allow the local pass so dev/CI without an OpenAI
	// key is not fail-closed on every upload.
	return true;
}

export function readModerationThresholds(): Record<ModerationInputType, Record<string, number>> {
	const override = process.env.OPENAI_MODERATION_THRESHOLDS_JSON?.trim();
	if (!override) return DEFAULT_MODERATION_THRESHOLDS;
	try {
		const parsed = JSON.parse(override) as Partial<Record<ModerationInputType, Record<string, unknown>>>;
		return {
			text: { ...DEFAULT_MODERATION_THRESHOLDS.text, ...normalizeThresholdMap(parsed.text) },
			image: { ...DEFAULT_MODERATION_THRESHOLDS.image, ...normalizeThresholdMap(parsed.image) },
		};
	} catch {
		return DEFAULT_MODERATION_THRESHOLDS;
	}
}

export function moderatePromptLocal(prompt: string): PromptModerationResult {
	const checkedAt = new Date().toISOString();
	const trimmed = prompt.trim();

	if (trimmed.length === 0) {
		return {
			status: "blocked",
			provider: "local-development-rules",
			checkedAt,
			reason: "Prompt is empty",
		};
	}

	for (const pattern of HIGH_RISK_PROMPT_PATTERNS) {
		if (pattern.test(trimmed)) {
			return {
				status: "needs_review",
				provider: "local-development-rules",
				checkedAt,
				reason: "Prompt matched a high-risk local moderation pattern",
				categories: { localHighRiskPrompt: 1 },
			};
		}
	}

	return {
		status: "passed",
		provider: "local-development-rules",
		checkedAt,
		categories: { localHighRiskPrompt: 0 },
	};
}

export async function moderatePrompt(text: string, workspaceId = ""): Promise<ModerationResult> {
	return moderateMultimodal({ text }, workspaceId);
}

export async function moderateImage(
	url: string,
	workspaceId = "",
	options: Parameters<typeof moderateMultimodal>[2] = {},
): Promise<ModerationResult> {
	return moderateMultimodal({ imageUrl: url }, workspaceId, options);
}

export async function moderateImageBuffer(
	buffer: Buffer,
	mimeType: string,
	workspaceId = "",
	options: Parameters<typeof moderateMultimodal>[2] = {},
): Promise<AssetModerationResult> {
	// (1) MANDATORY known-CSAM-hash denylist (TRI-STATE, fail-closed). A sha that
	// previously produced a mandatory block is hard-blocked BEFORE any provider /
	// local-pass path, so a confirmed-bad image can never be re-admitted — even
	// while the soft toggle is off. A lookup FAILURE (DB down) is NOT treated as
	// "not denylisted": an exact known-bad re-upload must never depend on provider
	// rediscovery, so we hold for review (fail-closed) instead.
	const sha = options.sha256?.trim();
	if (sha) {
		const lookup = await lookupKnownBlockedSha256(sha);
		if (lookup === "blocked") {
			return buildKnownBlockedShaAssetResult(sha);
		}
		if (lookup === "lookup-error") {
			return buildDenylistLookupFailClosedResult();
		}
	}

	// (2) MANDATORY CSAM/extreme screen — ALWAYS runs, regardless of the soft toggle
	// and regardless of OPENAI_MODERATION_FAIL_OPEN. A provider error here can only
	// ever become `needs_review`/`blocked`, NEVER `passed`. This is the fail-closed
	// floor: even if soft policy is off, every release-path image is screened for
	// CSAM here first.
	const mandatory = await mandatoryCsamScreenBuffer(buffer, mimeType, workspaceId, options);
	// A mandatory block is terminal; never soften it.
	if (mandatory.status === "blocked") {
		return mandatory;
	}

	// (3) Soft (policy) moderation toggle. When OFF — provider outage / staged
	// rollout — we stop at the mandatory verdict (which already fails closed when
	// the provider is unavailable). When ON, run the full soft policy screen and
	// aggregate fail-closed: the WORSE of {mandatory, soft} wins, so fail-open may
	// only ever relax SOFT categories, never the mandatory CSAM floor.
	if (!imageModerationEnabled()) {
		return mandatory;
	}

	const dataUrl = await buildModerationImageDataUrl(buffer, mimeType);
	const soft = toAssetModerationResult(await moderateImage(dataUrl, workspaceId, options));
	return worseAssetModeration(mandatory, soft);
}

/**
 * Aggregate two asset-moderation verdicts fail-closed: `blocked` beats
 * `needs_review` beats `passed`. Used to combine the mandatory CSAM screen (which
 * ignores fail-open) with the soft policy screen so a fail-open soft `passed` can
 * NEVER override a mandatory `needs_review`/`blocked`.
 */
function worseAssetModeration(a: AssetModerationResult, b: AssetModerationResult): AssetModerationResult {
	const rank = (status: AssetModerationResult["status"]): number => {
		if (status === "blocked") return 3;
		if (status === "needs_review") return 2;
		if (status === "passed") return 1;
		return 0;
	};
	return rank(b.status) > rank(a.status) ? b : a;
}

/**
 * MANDATORY CSAM/extreme-content screen used when the soft moderation toggle is
 * OFF. Unlike the soft toggle, this MUST NOT silently local-pass in production:
 *
 *  - Provider configured: call OpenAI and return its verdict (a CSAM/extreme hit
 *    becomes a `blocked`/`csam_block` row exactly as in the normal path).
 *  - Provider UNconfigured/unreachable:
 *      • production → FAIL CLOSED (`needs_review`, withheld from AI/export) so an
 *        unscreened image is never released as `passed`.
 *      • non-production with the dev bypass allowed → local pass (so dev/CI without
 *        an OpenAI key is not fail-closed on every upload).
 *      • non-production with the dev bypass explicitly disabled → fail closed too.
 */
export async function mandatoryCsamScreenBuffer(
	buffer: Buffer,
	mimeType: string,
	workspaceId = "",
	options: Parameters<typeof moderateMultimodal>[2] = {},
): Promise<AssetModerationResult> {
	if (!process.env.OPENAI_API_KEY?.trim()) {
		if (mandatoryCsamDevBypassAllowed()) {
			return createLocalImageModerationPass();
		}
		// Production (or dev with the bypass disabled) with no provider: an image we
		// cannot screen for CSAM must never be released. Hold for review, fail closed.
		return buildMandatoryCsamFailClosedResult("mandatory CSAM provider unavailable (no OPENAI_API_KEY)");
	}

	try {
		const dataUrl = await buildModerationImageDataUrl(buffer, mimeType);
		// Force a provider call by bypassing the soft toggle: moderateMultimodal does
		// NOT consult imageModerationEnabled, so this always hits OpenAI (or fails).
		const result = await moderateMultimodal({ imageUrl: dataUrl }, workspaceId, options);
		// VERDICT-FIRST fail-closed. `result.error` is overloaded across TWO cases:
		//
		//   (a) CONFIRMED block + audit-write failed. The provider returned a real
		//       CSAM/extreme verdict (`status: "csam_block"`) and only the CSAM AUDIT
		//       WRITE threw. `evaluateOpenAiResult` PRESERVES the `csam_block` verdict
		//       and attaches `error = "csam_audit_write_failed: ..."`. Downgrading this
		//       to `needs_review` would RELEASE a confirmed CSAM image (needs_review →
		//       storageStatus "released", and admin approve can later flip it → passed,
		//       since the 409 guard only rejects an existing `blocked`). A confirmed
		//       block MUST stay BLOCKED (the strongest fail-closed state); the audit
		//       gap is logged/alerted but NEVER weakens the verdict.
		//
		//   (b) PROVIDER failure. The provider was unavailable / threw / returned a
		//       non-OK status / produced no verdict, so `moderateMultimodal` synthesized
		//       a fallback result with `.error` set — a fail-open `allow`, or a
		//       fail-closed `block` whose `status` is a bare `"block"` (NOT the genuine
		//       `csam_block`). This is NOT a confirmed CSAM verdict, so it must fail
		//       closed to `needs_review` (hold for human review), exactly as before.
		//
		// So the discriminator is `moderationResultIsConfirmedBlock`: an error-carrying
		// result is only treated as a real block when it is the genuine `csam_block`
		// verdict; a bare error-carrying `block` (provider-failure fallback) still maps
		// to needs_review. An error-FREE block (e.g. the minors-policy hard block) is a
		// confirmed block too.
		if (moderationResultIsConfirmedBlock(result)) {
			if (result.error) {
				console.error(
					`[Moderation] mandatory CSAM screen: CONFIRMED CSAM block PRESERVED despite audit-write failure (NOT downgraded): ${result.error}`,
				);
			}
			return toAssetModerationResult(result);
		}
		// A provider/transport failure inside moderateMultimodal returns a NON-confirmed
		// result with `.error` set. With fail-open it would be an `allow`, with
		// fail-closed a bare `block` — neither is a confirmed CSAM verdict, so hold for
		// review rather than releasing or hard-blocking on a mere provider outage.
		if (result.error) {
			return buildMandatoryCsamFailClosedResult(`mandatory CSAM provider error: ${result.error}`);
		}
		return toAssetModerationResult(result);
	} catch (error) {
		return buildMandatoryCsamFailClosedResult(`mandatory CSAM screen failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Tri-state result of the known-CSAM-sha denylist lookup:
 *   - `blocked`      → the sha matches a previously-recorded mandatory block.
 *   - `not-found`    → the store ran and reported the sha is NOT on the denylist.
 *   - `lookup-error` → the store threw (DB down / query error). The caller must
 *                      NOT treat this as "not denylisted": an exact known-bad
 *                      re-upload must never depend on provider rediscovery, so the
 *                      asset-upload + AI-output paths FAIL CLOSED on this state.
 */
export type KnownBlockedShaLookup = "blocked" | "not-found" | "lookup-error";

/**
 * Tri-state known-CSAM-sha denylist lookup. Unlike a boolean, a store/DB FAILURE
 * is surfaced as `lookup-error` (not silently collapsed to "not denylisted") so
 * the upload/AI-output paths can fail closed on it. A `not-found` only ever comes
 * from a store that actually ran and reported the sha is absent.
 */
export async function lookupKnownBlockedSha256(sha256: string): Promise<KnownBlockedShaLookup> {
	if (!csamAuditStore.hasBlockedSha256) return "not-found";
	const target = sha256.trim();
	if (!target) return "not-found";
	try {
		return (await csamAuditStore.hasBlockedSha256(target)) ? "blocked" : "not-found";
	} catch (error) {
		console.error(`[Moderation] known-CSAM-sha lookup FAILED; treating as lookup-error (caller fails closed): ${error instanceof Error ? error.message : String(error)}`);
		return "lookup-error";
	}
}

/**
 * Boolean convenience wrapper around {@link lookupKnownBlockedSha256}. ONLY a
 * confirmed `blocked` is true here. Callers on a release path (asset upload, AI
 * output) MUST instead use {@link lookupKnownBlockedSha256} so a `lookup-error`
 * fails closed rather than collapsing to `false`.
 */
export async function isKnownBlockedSha256(sha256: string): Promise<boolean> {
	return (await lookupKnownBlockedSha256(sha256)) === "blocked";
}

export function buildKnownBlockedShaAssetResult(_sha256 = ""): AssetModerationResult {
	return {
		status: "blocked",
		provider: "local-development-rules",
		checkedAt: new Date().toISOString(),
		reason: "Hash matches a known mandatory-block (CSAM/extreme) record",
		categories: { knownBlockedSha256: 1, "sexual/minors": 1 },
		rulesetVersion: moderationRulesetVersion(),
	} as AssetModerationResult;
}

/**
 * Fail-closed result for a known-CSAM-sha denylist LOOKUP failure (DB down / query
 * error). An exact known-bad re-upload must never depend on provider rediscovery,
 * so when we cannot consult the denylist we withhold the asset for review rather
 * than letting it proceed into the provider/local-pass path as if "not denylisted".
 */
export function buildDenylistLookupFailClosedResult(): AssetModerationResult {
	return {
		status: "needs_review",
		provider: "local-development-rules",
		checkedAt: new Date().toISOString(),
		reason: "Known-CSAM denylist lookup unavailable; held for review (fail-closed)",
		categories: { denylistLookupFailed: 1 },
		rulesetVersion: moderationRulesetVersion(),
		// PROVIDER/DENYLIST FAILURE — the mandatory check could not run. Quarantine
		// the asset (NOT servable, NOT exportable) rather than letting a fail-closed
		// `needs_review` be treated as a servable borderline asset. See `failClosed`.
		failClosed: true,
	} as AssetModerationResult;
}

function buildMandatoryCsamFailClosedResult(reason: string): AssetModerationResult {
	return {
		status: "needs_review",
		provider: "local-development-rules",
		checkedAt: new Date().toISOString(),
		reason,
		categories: { mandatoryCsamFailClosed: 1 },
		rulesetVersion: moderationRulesetVersion(),
		// PROVIDER FAILURE/TIMEOUT/UNAVAILABLE on the MANDATORY CSAM screen. This is
		// NOT a genuine borderline verdict: the safety check never produced a result.
		// Mark it fail-closed so the asset record is QUARANTINED (withheld from
		// serving AND export), distinct from a provider-SUCCEEDED borderline
		// `needs_review` (which stays in-editor servable but non-exportable). It stays
		// `needs_review` (not `blocked`) so a transient outage remains recoverable via
		// re-moderation / admin review.
		failClosed: true,
	} as AssetModerationResult;
}

// Max longest-edge for the moderation derivative. Webtoon pages / 50 MB uploads
// base64-encode well past OpenAI's multimodal request-size limit, which would
// fail-close every large but valid upload. A bounded JPEG derivative keeps the
// moderation signal while staying inside the request budget.
const MODERATION_IMAGE_MAX_EDGE = 2048;
const MODERATION_IMAGE_JPEG_QUALITY = 80;

/**
 * Build a bounded data URL for image moderation when no provider-readable public
 * URL is available. Large originals (long webtoon pages, near-limit uploads) are
 * downscaled to a moderation derivative so the base64 request stays inside the
 * provider's multimodal size limit instead of failing closed. On any
 * sharp/decoding error we fall back to the original buffer so moderation still
 * runs (and can fail-closed) rather than silently skipping the check.
 */
export async function buildModerationImageDataUrl(buffer: Buffer, mimeType: string): Promise<string> {
	try {
		const sharp = (await import("sharp")).default;
		const derivative = await sharp(buffer, { failOn: "none" })
			.rotate()
			.resize({
				width: MODERATION_IMAGE_MAX_EDGE,
				height: MODERATION_IMAGE_MAX_EDGE,
				fit: "inside",
				withoutEnlargement: true,
			})
			.jpeg({ quality: MODERATION_IMAGE_JPEG_QUALITY })
			.toBuffer();
		return `data:image/jpeg;base64,${derivative.toString("base64")}`;
	} catch (error) {
		console.warn(`[Moderation] Failed to build bounded moderation derivative; using original buffer: ${error instanceof Error ? error.message : String(error)}`);
		return `data:${mimeType};base64,${buffer.toString("base64")}`;
	}
}

/**
 * `ModerationResult`-shaped local allow. Used by callers (e.g. crop preview
 * checks) that want a non-blocking result when the image-moderation kill switch
 * is off and there is no text to moderate, instead of feeding an empty
 * multimodal input into `moderateMultimodal` (which fail-closes to a block).
 */
export function createLocalModerationPass(reason = "Image moderation disabled; local pass"): ModerationResult {
	return buildLocalResult("allow", reason, {}, {});
}

export function createLocalImageModerationPass(): AssetModerationResult {
	return {
		status: "passed",
		provider: "local-development-rules",
		checkedAt: new Date().toISOString(),
		reason: "Prototype local moderation pass; replace with OpenAI image moderation before public upload",
		categories: { localBlockedContent: 0 },
	};
}

export async function moderateMultimodal(
	input: { text?: string; imageUrl?: string },
	workspaceId = "",
	options: {
		assetId?: string;
		sha256?: string;
		ipAddress?: string;
		userAgent?: string;
	} = {},
): Promise<ModerationResult> {
	const trimmedText = input.text?.trim();
	const imageUrl = input.imageUrl?.trim();
	if (!trimmedText && !imageUrl) {
		return buildLocalResult("block", "Empty moderation input", { localEmptyInput: true }, { localEmptyInput: 1 });
	}

	// Run the repository's local text safety policy whenever there is text,
	// including multimodal (crop-check) requests that carry both text and an
	// image. Previously this was gated on `!imageUrl`, so high-risk patterns such
	// as "remove watermark" / "make ... explicit" silently under-enforced on
	// crop checks whenever the provider allowed the multimodal request.
	const localPromptResult = trimmedText ? moderatePromptLocal(trimmedText) : undefined;
	if (localPromptResult?.status === "blocked") {
		return buildLocalResult("block", localPromptResult.reason, {}, localPromptResult.categories ?? {});
	}

	// Resolve the workspace BYO bypass entitlement BEFORE consulting the cache.
	// The bypass changes soft (warn/allow) verdicts, so it is part of the cache
	// identity: a workspace that gains BYO must not keep receiving a cached
	// `warn`, and one that loses BYO must not keep receiving a cached bypassed
	// `allow` for the 30-day TTL.
	const byoBypass = workspaceId ? await workspaceByoBypassesSoftPolicy(workspaceId) : false;

	const key = moderationCacheKey(input, workspaceId, byoBypass);
	// Cache availability must not be a hard dependency for moderation: a transient
	// cache outage degrades to a miss so the provider path still runs.
	let cached: ModerationResult | undefined;
	try {
		cached = await moderationCache.get(key);
	} catch (error) {
		console.warn(`[Moderation] cache get failed; treating as miss: ${error instanceof Error ? error.message : String(error)}`);
		cached = undefined;
	}
	if (cached) {
		await auditCachedCsamBlock(cached, {
			assetId: options.assetId,
			sha256: options.sha256,
			ipAddress: options.ipAddress,
			userAgent: options.userAgent,
			workspaceId,
		});
		return cached;
	}

	let result: ModerationResult;
	if (!process.env.OPENAI_API_KEY?.trim()) {
		result = moderationFailOpen()
			? buildLocalResult("allow", "OpenAI moderation unavailable; fail-open is enabled", {}, {})
			: buildLocalResult("block", "OPENAI_API_KEY is required for moderation", {}, {});
		result = mergeLocalPromptWarning(result, localPromptResult);
		return result;
	}

	try {
		const payload = await callOpenAiModeration(buildOpenAiInput(trimmedText, imageUrl));
		const openAi = extractOpenAiResult(payload);
		result = await evaluateOpenAiResult(openAi, {
			hasText: Boolean(trimmedText),
			hasImage: Boolean(imageUrl),
			workspaceId,
			byoBypass,
			assetId: options.assetId,
			sha256: options.sha256,
			ipAddress: options.ipAddress,
			userAgent: options.userAgent,
		});
		result = mergeLocalPromptWarning(result, localPromptResult);
	} catch (error) {
		result = moderationFailOpen()
			? buildOpenAiResult("allow", "OpenAI moderation failed; fail-open is enabled", {}, {}, { error })
			: buildOpenAiResult("block", "OpenAI moderation failed", {}, {}, { error });
		result = mergeLocalPromptWarning(result, localPromptResult);
	}

	if (!result.error) {
		try {
			await moderationCache.set(key, result, CACHE_TTL_SECONDS);
		} catch (error) {
			console.warn(`[Moderation] cache set failed; skipping write: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

export function toPromptModerationResult(result: ModerationResult): PromptModerationResult {
	return {
		status: result.decision === "allow" ? "passed" : result.decision === "warn" ? "needs_review" : "blocked",
		provider: result.provider === "openai_omni" ? `openai:${moderationModel()}` : result.provider,
		checkedAt: result.checkedAt,
		reason: result.reason,
		categories: result.scores,
	};
}

/**
 * Normalize a raw `ModerationResult` (decision `allow|warn|block` + status
 * `allow|warn|block|csam_block`) into the asset-facing `AssetModerationResult`
 * (`passed|needs_review|blocked`). A hard block — `block` OR the legal-weight
 * `csam_block` raw status — MUST normalize to `"blocked"` so the asset record's
 * `storageStatus` quarantines it (never displayable/downloadable/exportable).
 * We key off BOTH the decision and the raw status so a future raw status that is
 * not `allow`/`warn` defaults to blocked (fail-closed), never silently released.
 */
/**
 * Is `result` a CONFIRMED hard block — i.e. a genuine moderation verdict that the
 * mandatory CSAM screen must keep as `blocked` even when `result.error` is set?
 *
 * The subtlety is that `result.error` is attached on TWO unrelated paths:
 *   - a CONFIRMED `csam_block` whose CSAM AUDIT WRITE failed (verdict preserved);
 *   - a provider-FAILURE fallback synthesized by `moderateMultimodal` (a fail-open
 *     `allow`, or a fail-closed bare `block` with `status === "block"`).
 *
 * A confirmed block is therefore:
 *   - the legal-weight `csam_block` raw status (always confirmed; this is the ONLY
 *     genuine block path that also attaches an `error`), OR
 *   - any other hard block (`block` decision / raw status) that carries NO `error`
 *     (e.g. the minors-policy block) — an error-FREE block is a real verdict.
 *
 * A bare `block` WITH an `error` is the provider-failure fallback and is NOT
 * confirmed: the caller fails it closed to `needs_review` (hold for human review)
 * rather than hard-blocking on a mere provider outage. The `csam_block` arm stays
 * in lockstep with the `"blocked"` output of `toAssetModerationResult`.
 */
export function moderationResultIsConfirmedBlock(result: ModerationResult): boolean {
	if (result.status === "csam_block") return true;
	const isHardBlock = result.status === "block" || result.decision === "block";
	return isHardBlock && !result.error;
}

export function toAssetModerationResult(result: ModerationResult): AssetModerationResult {
	const status: AssetModerationResult["status"] = result.status === "csam_block" || result.decision === "block"
		? "blocked"
		: result.decision === "warn"
			? "needs_review"
			: result.decision === "allow"
				? "passed"
				: "blocked";
	return {
		status,
		provider: result.provider === "openai_omni" ? OPENAI_MODERATION_PROVIDER : result.provider,
		checkedAt: result.checkedAt,
		reason: result.reason ?? result.status,
		categories: result.scores,
		rulesetVersion: result.ruleset_version,
	} as AssetModerationResult;
}

async function evaluateOpenAiResult(
	result: OpenAiModerationResult,
	context: {
		hasText: boolean;
		hasImage: boolean;
		workspaceId?: string;
		byoBypass?: boolean;
		assetId?: string;
		sha256?: string;
		ipAddress?: string;
		userAgent?: string;
	},
): Promise<ModerationResult> {
	const highest = highestScore(result.categoryScores);
	const csamScore = result.categoryScores["sexual/minors"] ?? 0;
	const extremeScore = result.categoryScores["violence/graphic"] ?? 0;
	// Only treat the `sexual` score as an *image* signal when OpenAI attributed
	// it to the image input. An adult/explicit *text* string paired with a benign
	// crop must never be escalated into an image CSAM legal-hold row.
	const sexualAppliedToImage = categoryAppliedToImage(result, "sexual", context);
	const imageSexualScore = sexualAppliedToImage ? result.categoryScores.sexual ?? 0 : 0;
	const conservativeImageSexualBlock = sexualAppliedToImage && imageSexualScore >= 0.7;
	const csamBlock = csamScore > 0.5 || extremeScore > 0.95 || conservativeImageSexualBlock;
	if (csamBlock) {
		const reason = conservativeImageSexualBlock && csamScore <= 0.5 && extremeScore <= 0.95
			? "image sexual score exceeded conservative CSAM safety threshold"
			: highest.category;
		const auditScores = conservativeImageSexualBlock
			? {
				...result.categoryScores,
				"csam_image_conservative_block": 1,
				"csam_image_minor_presence_unconfirmed": 1,
			}
			: result.categoryScores;
		const moderation = buildOpenAiResult("block", reason, result.categories, auditScores, {
			status: "csam_block",
		});
		// The CSAM/extreme block is mandatory and legal-weight: an audit-store/DB
		// failure must NEVER downgrade or discard it. If this append threw out of
		// `evaluateOpenAiResult`, the caller's catch in `moderateMultimodal` would
		// fall into the generic failure path (a plain block, or — with fail-open —
		// even an allow). So we isolate the audit write and always return the
		// `csam_block` verdict, surfacing the audit failure on the result instead.
		try {
			await csamAuditStore.append({
				assetId: context.assetId,
				sha256: context.sha256,
				scores: auditScores,
				blockedAt: moderation.checkedAt,
				ipAddress: context.ipAddress,
				userAgent: context.userAgent,
				workspaceId: context.workspaceId,
				reason,
			});
		} catch (auditError) {
			console.error(`[Moderation] CSAM block audit write FAILED (verdict preserved): ${auditError instanceof Error ? auditError.message : String(auditError)}`);
			moderation.error = `csam_audit_write_failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`;
		}
		return moderation;
	}

	// Apply the minors policy to ANY input modality (text or image). An uploaded
	// or AI-output image whose `sexual/minors` score sits between the configured
	// soft threshold (0.2) and the hard CSAM cutoff (0.5) must be hard-blocked by
	// the same minors policy used for text — never softened to warn/allow and
	// never BYO-bypassed.
	const sexualMinorThreshold = (context.hasText || context.hasImage)
		? readModerationThresholds().text["sexual/minors"] ?? 0.2
		: undefined;
	if (sexualMinorThreshold !== undefined && csamScore >= sexualMinorThreshold) {
		return buildOpenAiResult("block", "sexual/minors", result.categories, result.categoryScores, { status: "block" });
	}

	const thresholdHit = findThresholdHit(result.categoryScores, context);
	if (thresholdHit || result.flagged) {
		if (context.byoBypass) {
			return buildOpenAiResult("allow", thresholdHit?.category ?? highest.category, result.categories, result.categoryScores, {
				status: "allow",
				bypassed: true,
			});
		}
		return buildOpenAiResult("warn", thresholdHit?.category ?? highest.category, result.categories, result.categoryScores, { status: "warn" });
	}

	return buildOpenAiResult("allow", highest.category, result.categories, result.categoryScores);
}

async function auditCachedCsamBlock(result: ModerationResult, context: ModerationAuditContext): Promise<void> {
	if (result.status !== "csam_block") return;
	// Per-upload audit row for a repeat CSAM cache hit. An audit-store failure must
	// not throw out of `moderateMultimodal` and surface as a transport error to the
	// caller (which could be mishandled): the cached `csam_block` verdict is
	// authoritative and must still fail-closed. Log the audit gap instead.
	try {
		await csamAuditStore.append({
			...context,
			scores: result.scores,
			blockedAt: new Date().toISOString(),
			reason: result.reason,
		});
	} catch (auditError) {
		console.error(`[Moderation] CSAM cache-hit audit write FAILED (cached block preserved): ${auditError instanceof Error ? auditError.message : String(auditError)}`);
	}
}

function mergeLocalPromptWarning(
	result: ModerationResult,
	local: PromptModerationResult | undefined,
): ModerationResult {
	if (!local || local.status !== "needs_review" || result.decision !== "allow") return result;
	return {
		...result,
		decision: "warn",
		status: "warn",
		reason: local.reason ?? result.reason,
		scores: {
			...result.scores,
			...(local.categories ?? {}),
		},
		categories: {
			...result.categories,
			localHighRiskPrompt: true,
		},
	};
}

function findThresholdHit(
	scores: Record<string, number>,
	context: { hasText: boolean; hasImage: boolean },
): { category: string; score: number; threshold: number } | undefined {
	const thresholds = readModerationThresholds();
	const candidates: Array<{ category: string; score: number; threshold: number }> = [];
	if (context.hasText) {
		for (const [category, threshold] of Object.entries(thresholds.text)) {
			const score = scores[category] ?? 0;
			if (score >= threshold) candidates.push({ category, score, threshold });
		}
	}
	if (context.hasImage) {
		for (const [category, threshold] of Object.entries(thresholds.image)) {
			const score = scores[category] ?? 0;
			if (score >= threshold) candidates.push({ category, score, threshold });
		}
	}
	return candidates.sort((left, right) => right.score - left.score)[0];
}

async function workspaceByoBypassesSoftPolicy(workspaceId: string): Promise<boolean> {
	try {
		const resolved = await moderationBillingStore.resolveWorkspacePlan(workspaceId);
		if (resolved.planId !== "studio" || !resolved.assigned) return false;
		const grants = await moderationBillingStore.listActiveGrants(workspaceId);
		return grants.some((grant) => BYO_OPENAI_ADDON_IDS.has(grant.addonId));
	} catch {
		return false;
	}
}

function buildOpenAiInput(text: string | undefined, imageUrl: string | undefined): unknown[] {
	const input: unknown[] = [];
	if (text) input.push({ type: "text", text });
	if (imageUrl) input.push({ type: "image_url", image_url: { url: imageUrl } });
	return input;
}

async function callOpenAiModeration(input: unknown): Promise<unknown> {
	// Bound the provider call so a hung/stalled OpenAI endpoint can never block the
	// upload commit loop forever. On abort, fetch rejects with an AbortError that
	// propagates to moderateMultimodal's catch and becomes a fail-closed verdict
	// (NOT fail-open) — see moderationProviderTimeoutMs for the safety rationale.
	const controller = new AbortController();
	const timeoutMs = moderationProviderTimeoutMs();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetch(OPENAI_MODERATION_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: moderationModel(),
				input,
			}),
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`OpenAI moderation timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OpenAI moderation error ${response.status}: ${text}`);
	}

	return response.json();
}

function extractOpenAiResult(payload: unknown): OpenAiModerationResult {
	const result = (payload as any)?.results?.[0];
	if (!result) {
		throw new Error("OpenAI moderation response did not include results");
	}
	return {
		flagged: Boolean(result.flagged),
		categoryScores: normalizeScoreMap(result.category_scores || {}),
		categories: normalizeBooleanMap(result.categories || {}),
		appliedInputTypes: normalizeAppliedInputTypes(result.category_applied_input_types || {}),
	};
}

function normalizeAppliedInputTypes(value: Record<string, unknown>): Record<string, ModerationInputType[]> {
	const normalized: Record<string, ModerationInputType[]> = {};
	for (const [category, raw] of Object.entries(value)) {
		if (!Array.isArray(raw)) continue;
		const types = raw.filter((entry): entry is ModerationInputType => entry === "text" || entry === "image");
		if (types.length > 0) normalized[category] = types;
	}
	return normalized;
}

/**
 * True when OpenAI attributed `category` to the image input. When OpenAI does
 * not report applied input types (older responses / mocks), fall back to the
 * caller's modality so a request that only carried an image is still treated as
 * an image hit, but a *text-only* request never is.
 */
function categoryAppliedToImage(
	result: OpenAiModerationResult,
	category: string,
	context: { hasText: boolean; hasImage: boolean },
): boolean {
	if (!context.hasImage) return false;
	const applied = result.appliedInputTypes[category];
	if (applied && applied.length > 0) return applied.includes("image");
	// No attribution available: only assume the image when there is no competing
	// text input that could have produced the score.
	return !context.hasText;
}

function buildLocalResult(
	decision: ModerationDecision,
	reason: string | undefined,
	categories: Record<string, boolean>,
	scores: Record<string, number>,
): ModerationResult {
	return {
		decision,
		categories,
		scores,
		cached: false,
		ruleset_version: moderationRulesetVersion(),
		reason,
		provider: "local-development-rules",
		checkedAt: new Date().toISOString(),
		status: decision,
	};
}

function buildOpenAiResult(
	decision: ModerationDecision,
	reason: string | undefined,
	categories: Record<string, boolean>,
	scores: Record<string, number>,
	options: { status?: ModerationResult["status"]; bypassed?: boolean; error?: unknown } = {},
): ModerationResult {
	return {
		decision,
		categories,
		scores,
		cached: false,
		ruleset_version: moderationRulesetVersion(),
		reason,
		provider: OPENAI_MODERATION_PROVIDER,
		checkedAt: new Date().toISOString(),
		status: options.status ?? decision,
		bypassed: options.bypassed,
		error: options.error instanceof Error ? options.error.message : options.error ? String(options.error) : undefined,
	};
}

function moderationCacheKey(input: { text?: string; imageUrl?: string }, workspaceId: string, byoBypass: boolean): string {
	const thresholds = readModerationThresholds();
	const thresholdHash = createHash("sha256")
		.update(JSON.stringify(thresholds))
		.digest("hex");
	const normalized = JSON.stringify({
		ruleset: moderationRulesetVersion(),
		model: moderationModel(),
		workspace_id: workspaceId.trim() || "global",
		threshold_hash: thresholdHash,
		// The BYO soft-policy bypass entitlement changes warn/allow verdicts, so it
		// is part of the cache identity. Without it a workspace that gains/loses the
		// add-on keeps a stale bypassed `allow` / `warn` for the full 30-day TTL.
		byo_bypass: byoBypass,
		text: input.text?.trim() || "",
		image_url: input.imageUrl?.trim() || "",
	});
	return `mod:${createHash("sha256").update(normalized).digest("hex")}`;
}

function normalizeThresholdMap(value: Record<string, unknown> | undefined): Record<string, number> {
	if (!value) return {};
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, raw]) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) as Array<[string, number]>,
	);
}

function normalizeScoreMap(value: Record<string, unknown>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(value)
			.map(([key, raw]) => [key, typeof raw === "number" && Number.isFinite(raw) ? raw : 0]),
	);
}

function normalizeBooleanMap(value: Record<string, unknown>): Record<string, boolean> {
	return Object.fromEntries(Object.entries(value).map(([key, raw]) => [key, Boolean(raw)]));
}

function highestScore(scores: Record<string, number>): { category: string; score: number } {
	return Object.entries(scores)
		.map(([category, score]) => ({ category, score }))
		.sort((left, right) => right.score - left.score)[0] ?? { category: "none", score: 0 };
}
