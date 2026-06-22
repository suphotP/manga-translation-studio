// Application configuration — environment-aware, scalable

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AiImageQuality, AiOfficialProvider, AppConfig, StorageDriver } from "./types/index.js";
import { readJsonFile } from "./utils/json-file.js";
import {
	DEFAULT_OPENAI_IMAGE_MODEL,
	OPENAI_IMAGE_MODELS,
	isSupportedOpenAiImageModel,
} from "./services/ai-providers/openai-models.js";
import { OFFICIAL_PROVIDER_IDS, getOfficialProvider } from "./services/ai-providers/index.js";
import { CENTS_PER_CREDIT } from "./services/plans.js";

// Resolve data directory — env var for production, local for prototype
function isTestRuntime(): boolean {
	const argv = process.argv.map((arg) => arg.toLowerCase());
	return process.env.NODE_ENV === "test"
		|| process.env.BUN_ENV === "test"
		|| argv.includes("test");
}

const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");
const TEST_DATA_DIR = join(tmpdir(), "manga-editor-web-backend-tests", String(process.pid));
const DATA_DIR = process.env.DATA_DIR || (isTestRuntime() ? TEST_DATA_DIR : DEFAULT_DATA_DIR);
const PROJECTS_DIR = join(DATA_DIR, "projects");
const USERS_DIR = join(DATA_DIR, "users");
const GLOSSARY_DIR = join(DATA_DIR, "glossary");

// Ensure directories exist
mkdirSync(PROJECTS_DIR, { recursive: true });
mkdirSync(USERS_DIR, { recursive: true });
mkdirSync(GLOSSARY_DIR, { recursive: true });

export { DATA_DIR, PROJECTS_DIR, USERS_DIR, GLOSSARY_DIR };

const CONFIG_PATH = join(DATA_DIR, "config.json");

export function readBooleanConfigValue(raw: string | undefined, fallback: boolean): boolean {
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readBooleanConfigEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	return readBooleanConfigValue(raw, fallback);
}

// Strict boolean reader for SECURITY / anti-abuse flags whose SAFE state is ON
// (e.g. TICKET_AI_REQUIRE_VERIFIED_EMAIL). Unlike readBooleanConfigValue — which
// treats anything not in its truthy allow-list (including a TYPO like "treu") as
// false — this fails CLOSED: only an EXPLICIT, recognized false-y token
// ("0"/"false"/"no"/"off") disables the gate. An empty/unset value uses the
// fallback (which for these flags is the safe ON), and an UNPARSEABLE value
// (typo / garbage) also resolves to the safe ON rather than silently disabling
// the protection. The old behavior let `="treu"` flip the gate OFF — a fail-open
// hole for a security control.
const FALSEY_BOOLEAN_TOKENS = ["0", "false", "no", "off"];
const TRUTHY_BOOLEAN_TOKENS = ["1", "true", "yes", "on"];
export function readSecurityBooleanConfigValue(raw: string | undefined, safeDefault: boolean): boolean {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return safeDefault; // unset/empty → safe default
	if (TRUTHY_BOOLEAN_TOKENS.includes(normalized)) return true;
	if (FALSEY_BOOLEAN_TOKENS.includes(normalized)) return false;
	// Unrecognized token (typo / garbage). For a flag whose safe state is ON this
	// must NOT disable the protection: fail closed to the safe default.
	return safeDefault;
}

export function readPositiveIntegerConfigValue(raw: string | undefined, fallback: number): number {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	if (!/^[1-9]\d*$/.test(trimmed)) return fallback;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Like readPositiveIntegerConfigValue but 0 is a LEGITIMATE value, not a typo.
// Used for caps where "0" means a real hard-stop (e.g. TICKET_AI_MAX_MESSAGES=0 ⇒
// "no AI on any ticket" → immediate handoff on the first message). An empty/unset
// value still falls back to the default; only an explicit 0 or larger is honored.
// Negatives and non-numeric junk are rejected → fall back to the safe default.
export function readNonNegativeIntegerConfigValue(raw: string | undefined, fallback: number): number {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	if (!/^\d+$/.test(trimmed)) return fallback;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Egress abuse-burst auto-throttle. Distinct from the per-write
// ASSET_EGRESS_PROJECT_WINDOW_BYTES cap: once a project's served bytes in the
// rolling window cross this threshold, further asset reads and signed-token
// issuance are throttled/revoked until the window resets. Mirrors the signed
// asset URL observe/enforce posture — observe only flags (fail-open), enforce
// blocks (fail-closed).
export type EgressAbuseMode = "observe" | "enforce";
export type MailerProvider = "resend" | "null";

export const DEFAULT_EGRESS_ABUSE_MODE: EgressAbuseMode = "observe";

export function readEgressAbuseModeValue(raw: string | undefined, fallback: EgressAbuseMode = DEFAULT_EGRESS_ABUSE_MODE): EgressAbuseMode {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (normalized === "observe" || normalized === "enforce") return normalized;
	throw new Error('ASSET_EGRESS_ABUSE_MODE must be "observe" or "enforce"');
}

function readPositiveIntegerConfigEnv(name: string, fallback: number): number {
	return readPositiveIntegerConfigValue(process.env[name], fallback);
}

// Fail-fast validation for the configured OpenAI image model.
//
// Root cause this guards against: the OpenAI image adapter enforces a FORMAT LOCK
// against OPENAI_IMAGE_MODELS, so a model string that is not in that allow-list
// (e.g. a typo, or a stale fake id) makes EVERY AI image job throw a
// non-retryable "not an OpenAI image model" error at dispatch time. Validating at
// config load turns that into one clear startup error instead of silent
// per-job failures. An empty/unset value keeps the supported default
// (`gpt-image-1`); only an explicit, unsupported value is rejected.
export function resolveOpenAiImageModel(
	raw: string | undefined,
	supported: readonly string[] = OPENAI_IMAGE_MODELS,
	fallback: string = DEFAULT_OPENAI_IMAGE_MODEL,
): string {
	const value = raw?.trim();
	if (!value) return fallback;
	if (!supported.includes(value)) {
		throw new Error(
			`OPENAI_IMAGE_MODEL='${value}' is not a supported OpenAI image model. Supported: ${supported.join(", ")}`,
		);
	}
	return value;
}

function readOpenAiImageModelEnv(): string {
	return resolveOpenAiImageModel(process.env.OPENAI_IMAGE_MODEL);
}

export function defaultApiHardeningEnabled(nodeEnv = process.env.NODE_ENV): boolean {
	return nodeEnv === "production";
}

export function defaultProjectCatalogFileFallbackEnabled(nodeEnv = process.env.NODE_ENV): boolean {
	return !defaultApiHardeningEnabled(nodeEnv);
}

export function defaultDatabaseStoreMode(
	databaseUrl = process.env.DATABASE_URL,
	testRuntime = isTestRuntime(),
): "file" | "postgres" {
	return databaseUrl?.trim() && !testRuntime ? "postgres" : "file";
}

// The asset registry intentionally does NOT auto-switch to Postgres when
// DATABASE_URL is present. Migration 0021 creates `asset_records` but does NOT
// backfill the existing per-project `backend/data/*/assets.json` files, and the
// images/quota read paths are now Postgres-authoritative in postgres mode — so
// auto-selecting Postgres for an environment with pre-existing file-registry
// uploads would show EMPTY asset listings (missing metadata + storage-quota
// accounting) for every project until new uploads land. To avoid that silent
// data loss the registry stays FILE-backed by default; Postgres is selected
// ONLY when ASSET_REGISTRY_STORE=postgres is set explicitly. Enabling postgres
// mode therefore requires either a fresh dataset or backfilling existing
// assets.json into asset_records first (otherwise it applies to new data only).
export function defaultAssetRegistryStoreMode(
	assetRegistryStore = process.env.ASSET_REGISTRY_STORE,
): "file" | "postgres" {
	return assetRegistryStore?.trim().toLowerCase() === "postgres" ? "postgres" : "file";
}

export function defaultProxyHeaderTrustEnabled(testRuntime = isTestRuntime()): boolean {
	return testRuntime;
}

export function defaultOAuthRedirectBase(nodeEnv = process.env.NODE_ENV): string {
	return nodeEnv === "production"
		? "https://api.example.com/api/auth/sso"
		: "http://localhost:3001/api/auth/sso";
}

export function defaultTurnstileEnabled(nodeEnv = process.env.NODE_ENV): boolean {
	// Secure-by-default: Turnstile is ON in production unless an operator EXPLICITLY sets
	// TURNSTILE_ENABLED=false (e.g. they front the app with another bot defense). Combined
	// with the prod fail-fast in readTurnstileRuntimeConfig, a production deploy without a
	// configured secret + allowed hostnames now refuses to boot instead of silently running
	// the public register/login endpoints with NO bot gate — which left only the per-IP rate
	// limit, i.e. a bot could create accounts up to the cap, every day, forever. Dev/test
	// default OFF so local flows don't need a CAPTCHA.
	return nodeEnv === "production";
}

export interface TurnstileRuntimeConfig {
	enabled: boolean;
	siteKey: string;
	secretKey: string;
	verifyUrl: string;
	tokenCacheKeyPrefix: string;
	allowedHostnames: string[];
	verifyTimeoutMs: number;
}

function readCommaSeparatedConfigValue(raw: string | undefined): string[] {
	return raw?.split(",")
		.map((value) => value.trim())
		.filter(Boolean) ?? [];
}

export function readTurnstileRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TurnstileRuntimeConfig {
	// STRICT (fail-closed) parse: now that the prod default is ON, only an explicit,
	// recognized false-y token may disable the bot gate. A typo ("flase"/"treu") must NOT
	// silently turn it off (and skip the secret/hostname fail-fast) — it resolves to the
	// safe default instead. See readSecurityBooleanConfigValue.
	const enabled = readSecurityBooleanConfigValue(env.TURNSTILE_ENABLED, defaultTurnstileEnabled(env.NODE_ENV));
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
	const allowedHostnames = readCommaSeparatedConfigValue(env.TURNSTILE_ALLOWED_HOSTNAMES);
	// NOTE: the prod secret/hostname fail-fast is NOT here — readTurnstileRuntimeConfig runs
	// at config import for EVERY process (queue/cron workers, one-off scripts like
	// assets:backfill) that pulls serverConfig, and those don't serve auth and aren't given
	// the TURNSTILE_* env. Crashing them would block deploy/maintenance jobs. The fail-fast
	// lives in assertTurnstileConfigured(), called only by the auth-serving API bootstrap
	// (index.ts). See that function.
	return {
		enabled,
		siteKey: env.TURNSTILE_SITE_KEY?.trim() ?? "",
		secretKey,
		verifyUrl: env.TURNSTILE_VERIFY_URL?.trim() || "https://challenges.cloudflare.com/turnstile/v0/siteverify",
		tokenCacheKeyPrefix: env.TURNSTILE_TOKEN_CACHE_KEY_PREFIX?.trim() || "manga-editor:turnstile",
		allowedHostnames,
		verifyTimeoutMs: readPositiveIntegerConfigValue(env.TURNSTILE_VERIFY_TIMEOUT_MS, 3000),
	};
}

/**
 * Fail-fast for the AUTH-serving (API) process ONLY. When Turnstile is enabled in
 * production (the secure-by-default state), it MUST have a secret + allowed hostnames or
 * the public register/login endpoints would run without a working bot gate. Called from
 * the API bootstrap (index.ts) — NOT from readTurnstileRuntimeConfig — so non-HTTP
 * processes (queue/cron workers, one-off scripts like assets:backfill) that import
 * serverConfig but never serve auth don't crash on a TURNSTILE_* env they don't need.
 */
export function assertTurnstileConfigured(config: TurnstileRuntimeConfig, nodeEnv = process.env.NODE_ENV): void {
	if (!config.enabled || nodeEnv !== "production") return;
	if (!config.secretKey) {
		throw new Error("TURNSTILE_SECRET_KEY environment variable must be set when Turnstile is enabled in production");
	}
	if (config.allowedHostnames.length === 0) {
		throw new Error("TURNSTILE_ALLOWED_HOSTNAMES must list the production hostnames when Turnstile is enabled");
	}
	// The PUBLIC site key drives the frontend widget. If the bundle has no key (neither
	// TURNSTILE_SITE_KEY here, which feeds the web build, NOR a build-time VITE_TURNSTILE_SITE_KEY)
	// it renders no widget and sends no token while the backend enforces one → every auth request
	// 403s. WARN rather than throw: the backend doesn't use the public key for Siteverify (only
	// the secret), and a split deploy may set VITE_TURNSTILE_SITE_KEY on the web build where the
	// API can't see it — so a missing TURNSTILE_SITE_KEY is a likely-misconfig signal, not proof
	// the widget is absent. Hard-failing here would break a legitimate VITE-only deployment.
	if (!config.siteKey) {
		console.warn(
			"⚠️  Turnstile is enabled but TURNSTILE_SITE_KEY is unset. Unless the web bundle was built " +
			"with VITE_TURNSTILE_SITE_KEY, the widget won't render and every auth request will fail " +
			"(missing-input-response). Set TURNSTILE_SITE_KEY (it also feeds the web build) to be safe.",
		);
	}
}

// --- Signed R2 enforcement (roadmap: enforce signed CDN/R2 access in
// production with private buckets, short TTLs). Additive config only. ---

export interface R2EnvConfig {
	accountId: string;
	bucket: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	publicBaseUrl: string;
}

// True only when every credential R2 needs to read/write/presign objects is
// present. Used as the fail-safe guard for production signed-asset enforcement:
// if R2 is selected but not fully configured we must NOT hard-break asset
// serving, so enforcement stays off until the operator finishes wiring R2.
export function isR2FullyConfigured(r2: Pick<R2EnvConfig, "accountId" | "bucket" | "endpoint" | "accessKeyId" | "secretAccessKey">): boolean {
	return Boolean(
		r2.bucket
		&& r2.accessKeyId
		&& r2.secretAccessKey
		&& (r2.endpoint || r2.accountId),
	);
}

// Read the R2 settings straight from the environment. Mirrors serverConfig.r2
// but is callable from the helpers below before serverConfig is constructed.
export function readR2EnvConfig(): R2EnvConfig {
	return {
		accountId: process.env.R2_ACCOUNT_ID || "",
		bucket: process.env.R2_BUCKET || "",
		endpoint: process.env.R2_ENDPOINT || "",
		accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
		secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
		publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || "",
	};
}

function readStorageDriverEnv(): StorageDriver {
	return (process.env.STORAGE_DRIVER || "local") as StorageDriver;
}

// ── Hosted metrics remote_write (Wave 4 W4.4) ───────────────────
// Prometheus ships its local TSDB to a hosted backend (Grafana Cloud or Better
// Stack) via the `remote_write` protocol. The runtime backend process does NOT
// push metrics itself — Prometheus does — but the backend surfaces the resolved
// config here so config.ts stays the single source of truth for ops env vars,
// and so a config reader can be unit-tested + reused by an /admin readiness view.
//
// Auth is bearer-token by default (Better Stack, Grafana Cloud both accept it);
// Grafana Cloud also accepts Basic Auth where the username is the numeric
// instance ID and the password is the API token. Secrets are NEVER hardcoded —
// they come from the environment, and only a redacted shape is ever logged.
export interface MetricsRemoteWriteConfig {
	/** Whether a hosted remote_write target is configured (URL present). */
	enabled: boolean;
	/** The hosted backend's remote_write endpoint, e.g. Grafana Cloud /api/prom/push. */
	url: string;
	/** Bearer token (Better Stack source token, or Grafana Cloud API token). */
	token: string;
	/** Optional Basic Auth username (Grafana Cloud numeric instance ID). */
	username: string;
}

/**
 * Read the hosted metrics remote_write configuration from the environment.
 * Env-driven only; throws if a token/username is set without a URL so a
 * half-wired deploy fails loudly instead of silently shipping nothing.
 */
export function readMetricsRemoteWriteConfig(
	env: Record<string, string | undefined> = process.env,
): MetricsRemoteWriteConfig {
	const url = env.METRICS_REMOTE_WRITE_URL?.trim() ?? "";
	const token = env.METRICS_REMOTE_WRITE_TOKEN?.trim() ?? "";
	const username = env.METRICS_REMOTE_WRITE_USERNAME?.trim() ?? "";

	if (!url && (token || username)) {
		throw new Error(
			"METRICS_REMOTE_WRITE_TOKEN/USERNAME set without METRICS_REMOTE_WRITE_URL — refusing to start with a half-configured remote_write target",
		);
	}

	let normalizedUrl = url;
	if (url) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("METRICS_REMOTE_WRITE_URL must be an absolute https URL");
		}
		// Hosted ingest is always TLS; reject plaintext so a token can never be
		// sent in the clear. Localhost http is allowed for an on-box test proxy.
		if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
			throw new Error("METRICS_REMOTE_WRITE_URL must use https (refusing to ship a bearer token over plaintext)");
		}
		// Credentials belong in METRICS_REMOTE_WRITE_USERNAME/TOKEN, never inline in
		// the URL — userinfo would survive into the "redacted" summary and leak the
		// token anywhere that summary is logged. Reject it loudly at boot.
		if (parsed.username || parsed.password) {
			throw new Error(
				"METRICS_REMOTE_WRITE_URL must not embed credentials — use METRICS_REMOTE_WRITE_USERNAME/TOKEN instead",
			);
		}
		// Re-serialize from the parsed URL so the stored/echoed value is always the
		// canonical, credential-free form even if validation rules change.
		normalizedUrl = parsed.toString();
	}

	return {
		enabled: Boolean(normalizedUrl),
		url: normalizedUrl,
		token,
		username,
	};
}

/** Redacted summary safe to log — never exposes the token value. */
export function describeMetricsRemoteWriteConfig(config: MetricsRemoteWriteConfig): {
	enabled: boolean;
	url: string;
	auth: "bearer" | "basic" | "none";
} {
	let auth: "bearer" | "basic" | "none" = "none";
	if (config.token) auth = config.username ? "basic" : "bearer";
	else if (config.username) auth = "basic";
	return { enabled: config.enabled, url: config.url, auth };
}

// Resolve the CORS allow-list. A wildcard ("*") is only ever safe in
// development; in production an unset ALLOWED_ORIGINS must NOT fall back to "*"
// (that would emit `Access-Control-Allow-Origin: *` for every origin). Production
// therefore requires an explicit allow-list (enforced by
// validateProductionRequiredSecrets); if it is somehow still unset at runtime we
// fail closed to an empty allow-list ("" → no cross-origin access) rather than
// open to the world.
export function resolveAllowedOrigins(
	raw = process.env.ALLOWED_ORIGINS,
	nodeEnv = process.env.NODE_ENV,
): string {
	const trimmed = raw?.trim();
	if (trimmed) return trimmed;
	// Unset/blank: wildcard only in non-production; fail closed in production.
	return nodeEnv === "production" ? "" : "*";
}

export function defaultMailerProvider(nodeEnv = process.env.NODE_ENV): MailerProvider {
	return nodeEnv === "production" ? "resend" : "null";
}

export function readMailerProviderEnv(raw = process.env.MAILER_PROVIDER, nodeEnv = process.env.NODE_ENV): MailerProvider {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return defaultMailerProvider(nodeEnv);
	if (normalized === "resend" || normalized === "null") return normalized;
	throw new Error('MAILER_PROVIDER must be "resend" or "null"');
}

export interface MailerEnvConfig {
	provider: MailerProvider;
	resendApiKey: string;
	resendDomain: string;
	from: string;
	replyTo: string;
	appUrl: string;
}

export function readMailerEnvConfig(): MailerEnvConfig {
	const resendDomain = process.env.RESEND_DOMAIN || "send.example.com";
	return {
		provider: readMailerProviderEnv(),
		resendApiKey: process.env.RESEND_API_KEY || "",
		resendDomain,
		from: process.env.MAILER_FROM || `Comic Workspace <hello@${resendDomain}>`,
		replyTo: process.env.MAILER_REPLY_TO || "support@example.com",
		appUrl: (process.env.APP_URL || "https://app.example.com").replace(/\/+$/, ""),
	};
}

// Whether R2 is even CAPABLE of presigning: R2 is the storage driver AND every
// credential is present. This is a precondition for direct delivery, not an
// enabler — presigned delivery stays OFF until explicitly opted in (below).
export function r2PresignCapable(
	storageDriver = readStorageDriverEnv(),
	r2 = readR2EnvConfig(),
): boolean {
	return storageDriver === "r2" && isR2FullyConfigured(r2);
}

// Whether the image routes hand clients a short-TTL presigned R2 URL
// (private-bucket direct delivery) instead of streaming bytes through the
// backend. This is OPT-IN and defaults OFF even when R2 is fully configured.
//
// PREREQUISITE (do not auto-enable): direct R2 delivery 302-redirects the
// browser to a private R2 origin. The editor loads canvas images with
// crossOrigin="anonymous", so without a CORS rule on the bucket for the app
// origin the browser rejects the redirected image and the canvas can't render.
// The image route therefore also keeps editor_preview (canvas) requests
// through-backend regardless of this flag (see tryPresignedR2Redirect). Turning
// this on requires R2 bucket CORS for the app origin.
//
// TRADEOFF (egress accounting): a presigned URL can be re-fetched directly from
// R2 until its TTL expires without ever hitting the backend, so recorded egress
// / abuse counters become an APPROXIMATION (they count one served object per
// redirect, not each re-fetch) while presigned delivery is enabled. The presign
// TTL is kept short by default (readR2PresignConfig) to bound this drift.
export function defaultR2PresignedDeliveryEnabled(
	storageDriver = readStorageDriverEnv(),
	r2 = readR2EnvConfig(),
): boolean {
	// Default OFF: presigned direct delivery must be explicitly opted in.
	void storageDriver;
	void r2;
	return false;
}

export function r2PresignedDeliveryEnabled(): boolean {
	const override = readBooleanConfigValueOptional(process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED);
	// Opt-in only: enabled when the explicit flag is truthy AND R2 can presign.
	// Any other state (unset, false, or R2 not fully configured) → OFF.
	return override === true && r2PresignCapable();
}

const DEFAULT_R2_PRESIGN_TTL_SECONDS = 300;
const DEFAULT_R2_PRESIGN_MAX_TTL_SECONDS = 3600;

export interface R2PresignConfig {
	defaultTtlSeconds: number;
	maxTtlSeconds: number;
}

export function readR2PresignConfig(): R2PresignConfig {
	const maxTtlSeconds = readPositiveIntegerConfigEnv("ASSET_R2_PRESIGN_MAX_TTL_SECONDS", DEFAULT_R2_PRESIGN_MAX_TTL_SECONDS);
	const defaultTtlSeconds = Math.min(
		readPositiveIntegerConfigEnv("ASSET_R2_PRESIGN_TTL_SECONDS", DEFAULT_R2_PRESIGN_TTL_SECONDS),
		maxTtlSeconds,
	);
	return { defaultTtlSeconds, maxTtlSeconds };
}

// Strict optional boolean: returns undefined when unset/blank, throws on a
// malformed value so a typo fails closed rather than silently flipping behavior.
function readBooleanConfigValueOptional(raw: string | undefined): boolean | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	throw new Error("ASSET_R2_PRESIGNED_DELIVERY_ENABLED must be true or false");
}

// ── AI support-agent cost / anti-abuse guardrails ───────────────────────────
// The owner's #1 concern is that support-ticket spam must never burn LLM tokens.
// This is the single, cohesive config block that EVERY guardrail layer reads, so
// no feature code ever hardcodes a limit. Layers (cheapest → hardest):
//   0  engagement gate     — TICKET_AI_REQUIRE_VERIFIED_EMAIL
//   1  HTTP rate limits     — see middleware/rate-limit.ts (RATE_LIMIT_TICKET_*)
//   2  per-ticket caps      — TICKET_AI_MAX_MESSAGES / TICKET_AI_MAX_TOKENS
//   3  global $ budget + kill-switch — TICKET_AI_MONTHLY_BUDGET_THB / AI_SUPPORT_KILL_SWITCH
//   4  spam pre-checks       — dup / gibberish / disposable-email
// All limits are env-tunable with safe defaults; all guardrails fail CLOSED.

// Default ON unless AI_SUPPORT_KILL_SWITCH is set truthy. The kill-switch is
// INVERTED on purpose (the env var name reads as "kill it" → ON means disabled),
// mirroring how an operator reaches for a kill-switch. An unrecognized value
// fails closed to "killed" so a typo can never silently leave the agent running.
export function readAiSupportEnabled(
	raw = process.env.AI_SUPPORT_KILL_SWITCH,
	fallback = true,
): boolean {
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "") return fallback;
	// Kill-switch present and non-empty: any truthy value disables the agent; a
	// typo (anything that is not an explicit off value) ALSO disables it — we never
	// keep the agent on by accident when the operator clearly tried to flip it.
	if (["1", "true", "yes", "on"].includes(normalized)) return false;
	if (["0", "false", "no", "off"].includes(normalized)) return true;
	return false;
}

// Fail-fast validation for the support agent's provider+model, mirroring
// resolveOpenAiImageModel. A model string that is not in the provider's text
// model allow-list would make EVERY support reply throw at dispatch; validating
// at config load turns that into one clear startup error. Empty/unset keeps the
// provider's default text model.
export function resolveSupportAgentProvider(
	raw = process.env.SUPPORT_AGENT_PROVIDER,
	fallback: AiOfficialProvider = "openai",
): AiOfficialProvider {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return fallback;
	if ((OFFICIAL_PROVIDER_IDS as readonly string[]).includes(normalized)) {
		return normalized as AiOfficialProvider;
	}
	throw new Error(
		`SUPPORT_AGENT_PROVIDER='${raw}' is not a supported provider. Supported: ${OFFICIAL_PROVIDER_IDS.join(", ")}`,
	);
}

export function resolveSupportAgentModel(
	provider: AiOfficialProvider = resolveSupportAgentProvider(),
	raw = process.env.SUPPORT_AGENT_MODEL,
	fallback = "gpt-5.5",
): string {
	const supported = getOfficialProvider(provider).modelsForTask("text");
	const value = raw?.trim();
	if (!value) {
		// No explicit model: prefer the requested default if the provider supports
		// it, else the provider's own default text model.
		return supported.includes(fallback) ? fallback : supported[0]!;
	}
	if (!supported.includes(value)) {
		throw new Error(
			`SUPPORT_AGENT_MODEL='${value}' is not a supported ${provider} text model. Supported: ${supported.join(", ")}`,
		);
	}
	return value;
}

// THB cost per token for the support agent's gpt-5.5 spend. Used to translate
// real OpenAI token usage into the global monthly $ budget meter (Layer 3).
const DEFAULT_TICKET_AI_THB_PER_TOKEN = 0.001;

export function readTicketAiThbPerTokenEnv(
	raw = process.env.TICKET_AI_THB_PER_TOKEN,
	fallback = DEFAULT_TICKET_AI_THB_PER_TOKEN,
): number {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readTicketAiMonthlyBudgetThbEnv(
	raw = process.env.TICKET_AI_MONTHLY_BUDGET_THB,
	fallback = 5000,
): number {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	// 0 is a legitimate value (hard-stop: no AI spend allowed at all → always
	// handoff), so accept any finite non-negative number here.
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readDisposableEmailDomainsEnv(raw = process.env.TICKET_AI_DISPOSABLE_EMAIL_DOMAINS): string[] {
	// Comma-separated, lowercased, deduped. These domains are treated as
	// throwaway accounts → tickets route to the human queue, never the agent.
	const fromEnv = readCommaSeparatedConfigValue(raw).map((d) => d.toLowerCase());
	const merged = new Set<string>([...DEFAULT_DISPOSABLE_EMAIL_DOMAINS, ...fromEnv]);
	return [...merged];
}

// A small, conservative seed blocklist; operators extend it via env. Kept short
// on purpose — false positives only cost a human handoff, never a hard reject.
const DEFAULT_DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
	"mailinator.com",
	"guerrillamail.com",
	"10minutemail.com",
	"tempmail.com",
	"trashmail.com",
	"yopmail.com",
	"sharklasers.com",
	"getnada.com",
	"dispostable.com",
	"throwawaymail.com",
];

export interface TicketAiGuardrailsConfig {
	/** Per-user+ticket AI reply messages allowed per minute (Layer 1). */
	msgPerMinute: number;
	/** Per-user AI reply messages allowed per hour (Layer 1). */
	msgPerHour: number;
	/** Cost-weighted token UNITS (ceil(promptTokens/100)) allowed per minute (Layer 1). */
	tokenUnitsPerMinute: number;
	/** Per-ticket lifetime AI message cap (Layer 2). */
	maxMessages: number;
	/** Per-ticket lifetime AI token cap (Layer 2). */
	maxTokens: number;
	/** Global monthly $ budget in THB across ALL tickets (Layer 3). */
	monthlyBudgetThb: number;
	/** THB charged per agent token, used to convert usage into the budget meter. */
	thbPerToken: number;
	/** Layer 0: agent only runs for verified-email accounts when true. */
	requireVerifiedEmail: boolean;
	/** Layer 4: disposable-email domains → human queue (lowercased). */
	disposableEmailDomains: string[];
	/** Layer 4: sha256 duplicate-message coalesce window (seconds). */
	dedupWindowSeconds: number;
	/** Layer 4: shortest message that may reach the agent (else handoff). */
	minMessageLength: number;
}

export function readTicketAiGuardrailsConfig(env: NodeJS.ProcessEnv = process.env): TicketAiGuardrailsConfig {
	return {
		msgPerMinute: readPositiveIntegerConfigValue(env.TICKET_AI_MSG_PER_MINUTE, 4),
		msgPerHour: readPositiveIntegerConfigValue(env.TICKET_AI_MSG_PER_HOUR, 30),
		tokenUnitsPerMinute: readPositiveIntegerConfigValue(env.TICKET_AI_TOKEN_UNITS_PER_MINUTE, 120),
		// 0 is a legitimate cap here: TICKET_AI_MAX_MESSAGES=0 / TICKET_AI_MAX_TOKENS=0
		// means "no AI on any ticket" → evaluateTicketCaps hands off on the first
		// message. Use the non-negative reader so an operator's 0 is honored end-to-end
		// instead of silently falling back to the default (12 / 40000).
		maxMessages: readNonNegativeIntegerConfigValue(env.TICKET_AI_MAX_MESSAGES, 12),
		maxTokens: readNonNegativeIntegerConfigValue(env.TICKET_AI_MAX_TOKENS, 40000),
		monthlyBudgetThb: readTicketAiMonthlyBudgetThbEnv(env.TICKET_AI_MONTHLY_BUDGET_THB),
		thbPerToken: readTicketAiThbPerTokenEnv(env.TICKET_AI_THB_PER_TOKEN),
		// SECURITY / anti-abuse gate whose SAFE state is ON. Use the strict reader so a
		// typo ("treu") or garbage value can NOT fail OPEN — only an explicit false-y
		// token ("false"/"0"/"no"/"off") disables it; anything else stays ON.
		requireVerifiedEmail: readSecurityBooleanConfigValue(env.TICKET_AI_REQUIRE_VERIFIED_EMAIL, true),
		disposableEmailDomains: readDisposableEmailDomainsEnv(env.TICKET_AI_DISPOSABLE_EMAIL_DOMAINS),
		dedupWindowSeconds: readPositiveIntegerConfigValue(env.TICKET_AI_DEDUP_WINDOW_SECONDS, 60),
		minMessageLength: readPositiveIntegerConfigValue(env.TICKET_AI_MIN_MESSAGE_LENGTH, 2),
	};
}

// ── AI-support OWNER-OPS deterministic money-decision policy ────────────────────
//
// Caps the AUTO tier of the support owner-ops model: the deterministic gate
// (services/support/decision-policy.ts) reads these to decide whether a
// gateway-verified credit grant may auto-execute or must go to the OWNER. All
// thresholds are MINOR UNITS (cents) for money and plain counts for velocity, so
// an operator tunes the AUTO envelope without a code change. Every value uses the
// NON-negative reader: 0 is a legitimate "disable this arm" setting (e.g.
// SUPPORT_AUTO_GRANT_MAX=0 forces EVERY grant to the owner).
export interface SupportDecisionPolicyConfig {
	/** Largest single auto-grant the gate will approve, in MINOR UNITS (cents). */
	autoGrantMaxCents: number;
	/** Per-user auto-grant count cap per trailing day (>= cap → owner review). */
	autoGrantPerUserDay: number;
	/** Per-user auto-grant count cap per trailing month (>= cap → owner review). */
	autoGrantPerUserMonth: number;
	/** Circuit-breaker window length in seconds (AUTO volume is summed over it). */
	circuitWindowSeconds: number;
	/** Trip the breaker when AUTO grants in the window reach this COUNT (0=off). */
	circuitWindowMaxCount: number;
	/** Trip the breaker when AUTO cents in the window reach this total (0=off). */
	circuitWindowMaxCents: number;
}

export function readSupportDecisionPolicyConfig(env: NodeJS.ProcessEnv = process.env): SupportDecisionPolicyConfig {
	return {
		// Default == 1000 credits of goodwill at the sale rate (CENTS_PER_CREDIT, the
		// single margin knob in plans.ts): 1000 × 9 = 9000 cents. The credit count
		// moved 100 → 1000 with the ×10 rebase so the MONEY value of the cap stays
		// where the owner set it (≈฿85-90); a generous but bounded auto-grant —
		// anything larger is owner-reviewed.
		autoGrantMaxCents: readNonNegativeIntegerConfigValue(env.SUPPORT_AUTO_GRANT_MAX, 1000 * CENTS_PER_CREDIT),
		autoGrantPerUserDay: readNonNegativeIntegerConfigValue(env.SUPPORT_AUTO_GRANT_PER_USER_DAY, 2),
		autoGrantPerUserMonth: readNonNegativeIntegerConfigValue(env.SUPPORT_AUTO_GRANT_PER_USER_MONTH, 5),
		circuitWindowSeconds: readPositiveIntegerConfigValue(env.SUPPORT_AUTO_GRANT_CIRCUIT_WINDOW_SECONDS, 3600),
		circuitWindowMaxCount: readNonNegativeIntegerConfigValue(env.SUPPORT_AUTO_GRANT_CIRCUIT_MAX_COUNT, 20),
		circuitWindowMaxCents: readNonNegativeIntegerConfigValue(env.SUPPORT_AUTO_GRANT_CIRCUIT_MAX_CENTS, 200_000),
	};
}

const DEFAULT_CONFIG: AppConfig = {
	openrouterEnabled: false,
	openrouterApiKey: "",
	openaiImagesEnabled: readBooleanConfigEnv("OPENAI_IMAGES_ENABLED", Boolean(process.env.OPENAI_API_KEY)),
	openaiImageModel: readOpenAiImageModelEnv(),
	openaiImageDefaultQuality: readImageQualityEnv("OPENAI_IMAGE_DEFAULT_QUALITY", "low"),
	chatgptEnabled: true,
	primaryBackend: "chatgpt",
	providerKillSwitches: {},
	sfxProviderMode: "openai-gpt-image-2",
	promptModerationEnabled: true,
	imageModerationEnabled: true,
	aiPythonEnabled: readAiPythonEnabledEnv(process.env.AI_PYTHON_ENABLED, defaultAiPythonEnabled()),
	aiDefaultProvider: readAiDefaultProviderEnv(),
	// AI support guardrails (rank1). Master switch defaults ON; provider+model are
	// fail-fast validated against the provider's text model allow-list at load.
	aiSupportEnabled: readAiSupportEnabled(),
	supportAgentProvider: resolveSupportAgentProvider(),
	supportAgentModel: resolveSupportAgentModel(),
};

/** Load config from file, falling back to defaults */
export function loadConfig(): AppConfig {
	// Only a corrupt/unparseable config file falls back to defaults. The try/catch
	// is scoped to the JSON read so it never masks fail-fast runtime validation
	// (e.g. an unsupported OPENAI_IMAGE_MODEL), which must surface as a clear error
	// rather than be silently swallowed back to a default model.
	let merged = { ...DEFAULT_CONFIG };
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = readJsonFile<Partial<AppConfig>>(CONFIG_PATH);
			// Merge with defaults to handle missing keys from older configs
			merged = { ...DEFAULT_CONFIG, ...raw };
		} catch {
			merged = { ...DEFAULT_CONFIG };
		}
	}
	return applyRuntimeConfig(merged);
}

/** Save config to file */
export function saveConfig(config: AppConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function applyRuntimeConfig(config: AppConfig): AppConfig {
	const runtime = { ...config };
	if (process.env.OPENAI_IMAGES_ENABLED !== undefined) {
		runtime.openaiImagesEnabled = readBooleanConfigEnv("OPENAI_IMAGES_ENABLED", runtime.openaiImagesEnabled);
	} else if (process.env.OPENAI_API_KEY) {
		runtime.openaiImagesEnabled = true;
	}
	// Env wins; otherwise the persisted/default value is re-validated so a stale
	// config.json (e.g. an old fake model id) cannot silently break every AI image
	// job — it fails fast at load instead.
	runtime.openaiImageModel = resolveOpenAiImageModel(
		process.env.OPENAI_IMAGE_MODEL ?? runtime.openaiImageModel,
	);
	runtime.openaiImageDefaultQuality = readImageQualityEnv("OPENAI_IMAGE_DEFAULT_QUALITY", runtime.openaiImageDefaultQuality);
	// W4.7: env always wins for the provider router flags so a persisted config.json
	// from an older build cannot re-enable the dormant Python worker or pin the
	// wrong official provider. Default: Python OFF, OpenAI as the official default.
	runtime.aiPythonEnabled = readAiPythonEnabledEnv(process.env.AI_PYTHON_ENABLED, runtime.aiPythonEnabled ?? defaultAiPythonEnabled());
	runtime.aiDefaultProvider = readAiDefaultProviderEnv(process.env.AI_DEFAULT_PROVIDER, runtime.aiDefaultProvider ?? "openai");
	// Env wins for the support kill-switch so a stale config.json can never silently
	// re-enable the agent against the operator's env; otherwise keep the persisted
	// value (runtime-toggleable via /api/ai/admin/config).
	runtime.aiSupportEnabled = process.env.AI_SUPPORT_KILL_SWITCH !== undefined
		? readAiSupportEnabled(process.env.AI_SUPPORT_KILL_SWITCH, runtime.aiSupportEnabled ?? true)
		: (runtime.aiSupportEnabled ?? true);
	// Provider+model are always re-validated (env wins, else the persisted value),
	// so a stale/typo'd persisted model fails fast at load rather than per-reply.
	runtime.supportAgentProvider = resolveSupportAgentProvider(
		process.env.SUPPORT_AGENT_PROVIDER ?? runtime.supportAgentProvider,
	);
	runtime.supportAgentModel = resolveSupportAgentModel(
		runtime.supportAgentProvider,
		process.env.SUPPORT_AGENT_MODEL ?? runtime.supportAgentModel,
	);
	return runtime;
}

/** Server configuration from environment */
export function isQueueWorkerRole(processRole = process.env.PROCESS_ROLE): boolean {
	const role = processRole?.trim().toLowerCase();
	return role === "queue-worker" || role === "ai-queue-worker" || role === "cron-worker";
}

export function shouldRequireJwtSecret(nodeEnv = process.env.NODE_ENV, processRole = process.env.PROCESS_ROLE): boolean {
	void processRole;
	return nodeEnv === "production";
}

export type BillingProvider = "dodo" | "none";
export type DodoEnvironment = "test_mode" | "live_mode";

// Validate JWT_SECRET in production API processes.
function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (shouldRequireJwtSecret(process.env.NODE_ENV, process.env.PROCESS_ROLE) && !secret) {
		throw new Error("JWT_SECRET environment variable must be set in production");
	}
	if (!secret) {
		const scope = isQueueWorkerRole() ? "queue worker runtime only" : "development only";
		console.warn(`⚠️  JWT_SECRET not set - using random secret for ${scope}`);
		return Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}
	if (secret.length < 32) {
		throw new Error("JWT_SECRET must be at least 32 characters long");
	}
	return secret;
}

export function validateProductionRequiredSecrets(env: Record<string, string | undefined> = process.env): void {
	if (env.NODE_ENV !== "production") return;

	const missing: string[] = [];
	if (!env.JWT_SECRET?.trim()) missing.push("JWT_SECRET");

	// ALLOWED_ORIGINS must be an explicit allow-list in production. Without it the
	// CORS layer would otherwise have to either emit a wildcard ACAO header (unsafe)
	// or fail closed and break every cross-origin browser request from the app.
	// A bare "*" is also rejected: a wildcard allow-list in production is never
	// intended and would re-open the cross-origin surface.
	const allowedOrigins = env.ALLOWED_ORIGINS?.trim();
	if (!allowedOrigins) {
		missing.push("ALLOWED_ORIGINS");
	} else if (allowedOrigins === "*") {
		missing.push("ALLOWED_ORIGINS (must be an explicit origin list, not '*')");
	}

	if ((env.BILLING_PROVIDER || "").trim().toLowerCase() === "dodo" && !env.DODO_API_KEY?.trim()) {
		missing.push("DODO_API_KEY");
	}

	if ((env.MAILER_PROVIDER || "").trim().toLowerCase() === "resend" && !env.RESEND_API_KEY?.trim()) {
		missing.push("RESEND_API_KEY");
	}

	if ((env.STORAGE_DRIVER || "local").trim().toLowerCase() === "r2") {
		if (!env.R2_BUCKET?.trim()) missing.push("R2_BUCKET");
		if (!env.R2_ACCESS_KEY_ID?.trim()) missing.push("R2_ACCESS_KEY_ID");
		if (!env.R2_SECRET_ACCESS_KEY?.trim()) missing.push("R2_SECRET_ACCESS_KEY");
		if (!env.R2_ENDPOINT?.trim() && !env.R2_ACCOUNT_ID?.trim()) {
			missing.push("R2_ENDPOINT or R2_ACCOUNT_ID");
		}
	}

	if (missing.length > 0) {
		throw new Error(`[PROD-REQUIRED] Missing required production environment variables: ${missing.join(", ")}`);
	}
}

validateProductionRequiredSecrets();

function readBillingProvider(): BillingProvider {
	const value = process.env.BILLING_PROVIDER?.trim().toLowerCase();
	if (!value) return "none";
	if (value === "dodo" || value === "none") return value;
	throw new Error("BILLING_PROVIDER must be 'dodo' or 'none'");
}

function readDodoEnvironment(): DodoEnvironment {
	const value = process.env.DODO_ENV?.trim().toLowerCase();
	if (!value) return "test_mode";
	if (value === "test_mode" || value === "live_mode") return value;
	throw new Error("DODO_ENV must be 'test_mode' or 'live_mode'");
}

function readDodoReturnBaseUrl(): string {
	// Per-environment app host the buyer is sent back to after checkout/portal.
	// Falls back to APP_BASE_URL (shared app origin) and finally the production
	// host so existing deployments keep working without new env vars. Stripping a
	// trailing slash keeps URL composition predictable.
	const raw = process.env.DODO_RETURN_BASE_URL?.trim()
		|| process.env.APP_BASE_URL?.trim()
		|| "https://app.example.com";
	return raw.replace(/\/+$/, "");
}

function readDodoProductIds(): Record<string, string> {
	const raw = process.env.DODO_PRODUCT_IDS?.trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected object");
		}
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string" && value.trim()) {
				result[key] = value.trim();
			}
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DODO_PRODUCT_IDS must be a JSON object of product ids: ${message}`);
	}
}

function validateDodoConfig(provider: BillingProvider, apiKey: string, webhookSecret: string): void {
	if (provider !== "dodo") return;
	if (!apiKey.trim()) {
		throw new Error("DODO_API_KEY is required when BILLING_PROVIDER=dodo");
	}
	if (!webhookSecret.trim()) {
		throw new Error("DODO_WEBHOOK_SECRET is required when BILLING_PROVIDER=dodo");
	}
}

const billingProvider = readBillingProvider();
const dodoApiKey = process.env.DODO_API_KEY || "";
const dodoWebhookSecret = process.env.DODO_WEBHOOK_SECRET || "";
validateDodoConfig(billingProvider, dodoApiKey, dodoWebhookSecret);

export const serverConfig = {
	port: parseInt(process.env.PORT || "3001", 10),
	host: process.env.HOST || "0.0.0.0",
	maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || "50", 10), // MB
	maxImagesPerUpload: parseInt(process.env.MAX_IMAGES_PER_UPLOAD || "1000", 10),
	maxUploadBatchSizeBytes: parseInt(process.env.MAX_UPLOAD_BATCH_SIZE_MB || "500", 10) * 1024 * 1024,
	maxImagesPerChapter: parseInt(process.env.MAX_IMAGES_PER_CHAPTER || "1000", 10),
	maxChapterOriginalBytes: parseInt(process.env.MAX_CHAPTER_ORIGINAL_MB || "500", 10) * 1024 * 1024,
	minUploadImageWidth: readPositiveIntegerConfigEnv("MIN_UPLOAD_IMAGE_WIDTH", isTestRuntime() ? 1 : 64),
	minUploadImageHeight: readPositiveIntegerConfigEnv("MIN_UPLOAD_IMAGE_HEIGHT", isTestRuntime() ? 1 : 64),
	// Hard ceiling on the pixel count of a single bulk-import merge product. Merge
	// stitches up to 50 sources into one canvas; without a bound a batch of large
	// pages can force sharp to allocate a multi-gigapixel RGBA buffer and tie up
	// the backend. 268M px (~16k×16k) leaves headroom over the largest legitimate
	// webtoon strip while rejecting pathological compositions before allocation.
	maxMergeOutputPixels: readPositiveIntegerConfigEnv("MAX_MERGE_OUTPUT_PIXELS", 268_000_000),
	maxJsonBodySizeBytes: parseInt(process.env.MAX_JSON_BODY_SIZE_KB || "1024", 10) * 1024,
	allowedOrigins: resolveAllowedOrigins(),
	workerUrl: process.env.WORKER_URL || "http://localhost:8001",
	storageDriver: (process.env.STORAGE_DRIVER || "local") as StorageDriver,
	localStorageRoot: process.env.LOCAL_STORAGE_ROOT || DATA_DIR,
	r2: {
		accountId: process.env.R2_ACCOUNT_ID || "",
		bucket: process.env.R2_BUCKET || "",
		endpoint: process.env.R2_ENDPOINT || "",
		accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
		secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
		publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || "",
	},
	openai: {
		apiKey: process.env.OPENAI_API_KEY || "",
		imageModel: readOpenAiImageModelEnv(),
		imageDefaultQuality: readImageQualityEnv("OPENAI_IMAGE_DEFAULT_QUALITY", "low"),
		imageRequestTimeoutMs: parseInt(process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS || "300000", 10),
		imageMaxResultBytes: readPositiveIntegerConfigEnv("OPENAI_IMAGE_MAX_RESULT_MB", 25) * 1024 * 1024,
		moderationModel: process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest",
	},
	authSessionStore: (process.env.AUTH_SESSION_STORE || (isTestRuntime() ? "file" : process.env.REDIS_URL ? "redis" : "file")) as "file" | "redis",
	authSessionRedisKeyPrefix: process.env.AUTH_SESSION_REDIS_KEY_PREFIX || "manga-editor:auth",
	oauthRedirectBase: process.env.OAUTH_REDIRECT_BASE || defaultOAuthRedirectBase(),
	appUrl: process.env.APP_URL || process.env.FRONTEND_URL || "http://localhost:5173",
	googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
	googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
	githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
	githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
	lineLoginChannelId: process.env.LINE_LOGIN_CHANNEL_ID || "",
	lineLoginChannelSecret: process.env.LINE_LOGIN_CHANNEL_SECRET || "",
	turnstile: readTurnstileRuntimeConfig(),
	authUserStore: (process.env.AUTH_USER_STORE || defaultDatabaseStoreMode()) as "file" | "postgres",
	uploadAuditStore: (process.env.UPLOAD_AUDIT_STORE || (isTestRuntime() ? "file" : process.env.DATABASE_URL ? "postgres" : "file")) as "file" | "postgres",
	// FILE-backed unless ASSET_REGISTRY_STORE=postgres is set explicitly. We do NOT
	// auto-switch on DATABASE_URL: existing assets.json is not backfilled by
	// migration 0021, and the postgres-authoritative read paths would otherwise
	// hide every pre-existing upload. See defaultAssetRegistryStoreMode.
	assetRegistryStore: defaultAssetRegistryStoreMode(),
	projectCatalogStore: (process.env.PROJECT_CATALOG_STORE || (isTestRuntime() ? "file" : process.env.DATABASE_URL ? "postgres" : "file")) as "file" | "postgres",
	projectCatalogFileFallbackEnabled: readBooleanConfigEnv("PROJECT_CATALOG_FILE_FALLBACK_ENABLED", defaultProjectCatalogFileFallbackEnabled()),
	// C5: when ON, the dedicated server-owned-collection mutation endpoints (tasks /
	// comments / review-decisions / workspace-messages / ai-markers / revisions /
	// version-reviews) REQUIRE the `x-project-base-state-hash` CAS baseline header and
	// reject a write that omits it with 428 — instead of defaulting to last-write-wins.
	// The browser client always seeds the baseline from the project GET, so this only
	// rejects a concurrency-blind caller. Defaults ON in production, OFF in dev/test so
	// the existing route suites (which don't all send the header) keep passing; set
	// PROJECT_BASELINE_HEADER_REQUIRED=true to exercise it locally.
	requireProjectBaselineHeaderEnabled: readBooleanConfigEnv("PROJECT_BASELINE_HEADER_REQUIRED", defaultApiHardeningEnabled()),
	// P0-2 (round-2): when ON, a page-scoped /save MUST carry the `x-edit-lock-id`
	// lease header. The fail-open in `rejectIfPageLeaseLost` (no header ⇒ allow)
	// reopens the takeover hole — a cross-user takeover writes NO project state, so
	// CAS alone cannot detect it, and an attacker/buggy client that simply OMITS the
	// header would slip a stale clobber through. With this flag a page-scoped save
	// (one that targets a specific page index, where a lease is expected) is rejected
	// 428 when the header is absent. Scoped to page-targeting saves so a legitimate
	// first-save-before-lease or a non-page-scoped save is never broken. Defaults ON
	// in production, OFF in dev/test (route suites don't all send the lease header);
	// set EDIT_LEASE_HEADER_REQUIRED=true to exercise it locally.
	requireEditLeaseHeaderEnabled: readBooleanConfigEnv("EDIT_LEASE_HEADER_REQUIRED", defaultApiHardeningEnabled()),
	usageLedgerStore: (process.env.USAGE_LEDGER_STORE || defaultDatabaseStoreMode()) as "file" | "postgres",
	billingStore: (process.env.BILLING_STORE || defaultDatabaseStoreMode()) as "file" | "postgres",
	billingProvider,
	dodo: {
		apiKey: dodoApiKey,
		webhookSecret: dodoWebhookSecret,
		environment: readDodoEnvironment(),
		productIds: readDodoProductIds(),
		returnBaseUrl: readDodoReturnBaseUrl(),
	},
	// Checkout/portal session settings consumed by routes/billing.ts (W2.2). The
	// real Dodo SDK is not wired in this wave, so `provider` stays "mock" unless
	// the validated `billingProvider` above resolves to "dodo"; the session
	// endpoints then return a clearly-labeled prototype URL instead of 404ing the
	// pricing/billing CTAs. `appBaseUrl` is the public origin those mock URLs
	// (and future real success/cancel return URLs) point back at.
	billing: {
		provider: (billingProvider === "dodo" ? "dodo" : "mock") as "mock" | "dodo",
		appBaseUrl: (process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || "http://localhost:5173").replace(/\/+$/, ""),
	},
	byoApiStore: (process.env.BYO_API_STORE || defaultDatabaseStoreMode()) as "file" | "postgres",
	byoMasterKey: process.env.BYO_MASTER_KEY || "",
	byoAddonPriceUsd: Number(process.env.BYO_ADDON_PRICE_USD || "149"),
	performanceMetricsStore: (process.env.PERFORMANCE_METRICS_STORE || defaultDatabaseStoreMode()) as "file" | "postgres",
	// Defensive cap on the single grouped workspace-window read that powers the
	// team-performance / leaderboard dashboard (PostgresPerformanceMetricsStore.
	// listWorkspaceWindowEvents). That query selects EVERY work_events row for a
	// workspace within [since, until] and groups + scores them in JS; on an active
	// workspace a multi-week window can fully materialize an unbounded row set per
	// dashboard load — a memory/latency cliff. This LIMIT bounds the read: the
	// window's NEWEST rows are kept (recent activity wins) and the slice is logged
	// when it truncates so an operator can raise the knob for a genuinely huge
	// workspace. The default is generous (50k) so normal workspaces are unaffected.
	performanceWindowEventLimit: readPositiveIntegerConfigEnv("PERF_WINDOW_EVENT_LIMIT", 50_000),
	// ── Customer support tickets ────────────────────────────────────
	// Where to route the "new ticket / customer replied" notification when a
	// ticket has no explicit assignee yet. SUPPORT_QUEUE_USER_ID is the user id
	// of the human/queue mailbox that owns the unassigned support inbox; left
	// blank in dev/file-mode so a local run never tries to notify a non-existent
	// queue user. SUPPORT_QUEUE_NAME is the human-readable queue label stored on
	// the ticket (assign(..., queue)) so the future staff inbox can group by it.
	support: {
		queueUserId: (process.env.SUPPORT_QUEUE_USER_ID || "").trim(),
		queueName: (process.env.SUPPORT_QUEUE_NAME || "general").trim() || "general",
		// Per-user+per-ip throttle on the customer ticket REST API. Opening a
		// ticket persists a ticket + first message AND fans out notifications
		// (in-app + email) to the requester and the support queue, so it must be
		// capped far tighter than the generic api:global limit (which an authed
		// user could otherwise spam at ~600/min). Replies are cheaper (one append
		// + at most one queue ping) so they get a looser cap. All three BLOCK
		// (429) when exceeded — no ticket/message is persisted and no notification
		// is fired on a throttled request.
		ticketCreatePerMinute: readPositiveIntegerConfigEnv("SUPPORT_TICKET_CREATE_PER_MINUTE", 3),
		ticketCreatePerHour: readPositiveIntegerConfigEnv("SUPPORT_TICKET_CREATE_PER_HOUR", 20),
		ticketReplyPerMinute: readPositiveIntegerConfigEnv("SUPPORT_TICKET_REPLY_PER_MINUTE", 10),
	},
	aiQueueProcessorEnabled: readBooleanConfigEnv("AI_QUEUE_PROCESSOR_ENABLED", true),
	aiQueueProcessorPollIntervalMs: readPositiveIntegerConfigEnv("AI_QUEUE_PROCESSOR_POLL_INTERVAL_MS", 1000),
	// ── Cron scheduler (Wave 2 W2.4) ────────────────────────────────
	// SCHEDULER_ENABLED defaults to true in production (the cron-worker container
	// is started intentionally) and false elsewhere so a local `bun start` does
	// not double-run jobs against a shared database. The cron-worker process
	// reads this via isSchedulerEnabled() at boot.
	schedulerEnabled: readBooleanConfigEnv("SCHEDULER_ENABLED", defaultApiHardeningEnabled()),
	schedulerPollIntervalMs: readPositiveIntegerConfigEnv("SCHEDULER_POLL_INTERVAL_MS", 60_000),
	auditRetentionDays: readPositiveIntegerConfigEnv("AUDIT_RETENTION_DAYS", 90),
	draftExportTtlHours: readPositiveIntegerConfigEnv("DRAFT_EXPORT_TTL_HOURS", 24),
	// GDPR right-to-erasure grace window (days). After this many days past a
	// SOFT-DELETE, the gdpr-erasure-sweep cron anonymizes the account's PII. The
	// default is 30 days (per gdpr.ts:6 / the account-delete flow); the exact legal
	// retention window is the operator's call after legal review, so it is
	// CONFIGURABLE here. Set GDPR_ERASURE_GRACE_DAYS to override. Kept independent
	// from ACCOUNT_DELETE_GRACE_PERIOD_MS (the per-request soft-delete window) so a
	// deployment can tune the sweep cadence without touching the user-facing undo
	// window — but they default to the SAME 30 days.
	gdprErasureGraceDays: readPositiveIntegerConfigEnv("GDPR_ERASURE_GRACE_DAYS", 30),
	// In-process export queue drainer (Wave 3 W3.10). Mirrors the AI queue
	// processor: enabled by default so an API-only deployment advances enqueued
	// export jobs queued -> done without an external runner.
	exportQueueProcessorEnabled: readBooleanConfigEnv("EXPORT_QUEUE_PROCESSOR_ENABLED", true),
	exportQueueProcessorPollIntervalMs: readPositiveIntegerConfigEnv("EXPORT_QUEUE_PROCESSOR_POLL_INTERVAL_MS", 2000),
	aiRequireAssetRegistryForAi: readBooleanConfigEnv("AI_REQUIRE_ASSET_REGISTRY_FOR_AI", defaultApiHardeningEnabled()),
	apiAuthRequired: readBooleanConfigEnv("API_AUTH_REQUIRED", defaultApiHardeningEnabled()),
	apiMutationAuthRequired: readBooleanConfigEnv("API_MUTATION_AUTH_REQUIRED", defaultApiHardeningEnabled()),
	// Auto-verify a freshly registered local account's email so a dev/file-mode
	// run (no mailer configured → a verification email can never be delivered) is
	// usable out of the box: without this the user is stuck at the
	// email_not_verified gate and cannot create a project or upload an image.
	// Defaults ON in any NON-PRODUCTION, non-test runtime so local dev sign-up is
	// usable WITHOUT the email-OTP step — the account is marked verified immediately.
	// Production (NODE_ENV=production → hardened) defaults OFF, enforcing the OTP
	// verification wall. The test runtime stays OFF so the verification-flow tests
	// still exercise the OTP path. Operators can force either way with
	// AUTH_AUTO_VERIFY_EMAIL — e.g. a staging box that wants to exercise the real OTP
	// flow sets AUTH_AUTO_VERIFY_EMAIL=false.
	authAutoVerifyEmail: readBooleanConfigEnv("AUTH_AUTO_VERIFY_EMAIL", !defaultApiHardeningEnabled() && !isTestRuntime()),
	// Legacy multi-tenant backward-compat hatch (Wave 0 W0.1). When true AND
	// apiAuthRequired is false, projects whose state has no userId AND no
	// workspaceId are accessible without a logged-in user — the original
	// pre-auth prototype posture. Default OFF: prod (apiAuthRequired=true) MUST
	// deny anonymous access, and dev defaults to the same denial unless the
	// operator explicitly opts back into the legacy path while phasing it out.
	allowLegacyAnonymousProjects: readBooleanConfigEnv("ALLOW_LEGACY_ANONYMOUS_PROJECTS", false),
	apiOriginGuardEnabled: readBooleanConfigEnv("API_ORIGIN_GUARD_ENABLED", defaultApiHardeningEnabled()),
	apiCsrfRequired: readBooleanConfigEnv("API_CSRF_REQUIRED", defaultApiHardeningEnabled()),
	csrfTokenTtlSeconds: parseInt(process.env.CSRF_TOKEN_TTL_SECONDS || "28800", 10),
	trustProxyHeaders: readBooleanConfigEnv("TRUST_PROXY_HEADERS", defaultProxyHeaderTrustEnabled()),
	// JWT Configuration
	jwtSecret: getJwtSecret(),
	jwtAccessTokenExpiry: parseInt(process.env.JWT_ACCESS_EXPIRY || "900", 10), // 15 minutes
	jwtRefreshTokenExpiry: parseInt(process.env.JWT_REFRESH_EXPIRY || "604800", 10), // 7 days
	// Password requirements
	passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || "8", 10),
	passwordRequireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE !== "false",
	passwordRequireLowercase: process.env.PASSWORD_REQUIRE_LOWERCASE !== "false",
	passwordRequireNumbers: process.env.PASSWORD_REQUIRE_NUMBERS !== "false",
	passwordRequireSpecialChars: process.env.PASSWORD_REQUIRE_SPECIAL !== "false",
	// ── Observability + secure-headers wiring (Wave 0 W0.2 / W4.4) ──
	// Sentry DSN is read directly by initSentry() in middleware/sentry.ts; we
	// surface it here so config.ts is the single source of truth for ops env vars.
	sentryDsn: process.env.SENTRY_DSN || "",
	// Sentry release tag for release-tracking / "introduced in" regression
	// markers. Prefer an explicit SENTRY_RELEASE (CI sets it to the deployed git
	// SHA), then GIT_SHA. initSentry() reads the same env directly; surfaced here
	// for the /admin observability view and so the precedence stays documented.
	sentryRelease: process.env.SENTRY_RELEASE || process.env.GIT_SHA || "",
	// Hosted metrics remote_write target (Grafana Cloud / Better Stack). Env-driven;
	// token is never logged (see describeMetricsRemoteWriteConfig).
	metricsRemoteWrite: readMetricsRemoteWriteConfig(),
	// Optional CSP report-uri target. When set, secure-headers will include a
	// report-uri directive so violations are forwarded to the operator's collector.
	cspReportUri: process.env.CSP_REPORT_URI || "",
	// Basic Auth credentials for the Prometheus /metrics scrape endpoint. Both
	// must be set in production; if either is missing in prod the /metrics route
	// fails closed (503) rather than silently exposing the scrape surface.
	metricsBasicAuthUser: process.env.METRICS_BASIC_AUTH_USER || "",
	metricsBasicAuthPass: process.env.METRICS_BASIC_AUTH_PASS || "",
	mailer: readMailerEnvConfig(),
	// AI support-agent cost / anti-abuse guardrails (rank1). The kill-switch lives
	// on AppConfig (runtime-toggleable); these are the env-tuned numeric limits the
	// rate-limit, per-ticket-cap, budget, and spam layers all read.
	ticketAiGuardrails: readTicketAiGuardrailsConfig(),
	// AI-support OWNER-OPS deterministic money-decision policy. Caps the AUTO tier
	// (decision-policy.ts) so the AI can only auto-execute an exact, gateway-verified
	// credit discrepancy within these bounds; everything else routes to the owner.
	supportDecisionPolicy: readSupportDecisionPolicyConfig(),
	// AI-support OWNER-OPS daily digest: when enabled, a scheduled job hook can
	// notify() the owner a once-a-day summary of autonomous support activity (the
	// owner-in-the-loop async safety net). The on-demand GET digest endpoint is
	// ALWAYS available; this flag only gates the proactive notification. Default OFF.
	supportOwnerDigestNotifyEnabled: readBooleanConfigEnv("SUPPORT_OWNER_DIGEST_NOTIFY_ENABLED", false),
} as const;

function readImageQualityEnv(name: string, fallback: AiImageQuality): AiImageQuality {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

// W4.7: the legacy reverse-engineered Python scraper worker is OFF by default in
// every environment (prod especially). It is an admin/dev-only escape hatch, so
// it is only ever reachable when AI_PYTHON_ENABLED is explicitly opted in. A typo
// or "false"/"0"/"off" keeps it disabled (fails closed to the official API path).
export function defaultAiPythonEnabled(): boolean {
	return false;
}

// W4.7: fail-closed gate for the dormant Python scraper worker. Unlike a generic
// boolean env reader, an env var that is *present but unrecognized* (e.g. a typo
// like "flase") MUST disable the worker rather than fall back to a persisted
// `aiPythonEnabled: true` from a prior dev/admin run — otherwise the typo would
// silently leave the legacy scraper enabled. Only an explicit truthy value
// (1/true/yes/on) turns it on; the persisted/default fallback is used solely when
// the env var is absent.
export function readAiPythonEnabledEnv(
	raw = process.env.AI_PYTHON_ENABLED,
	fallback = defaultAiPythonEnabled(),
): boolean {
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "") return fallback;
	// Present and non-empty: only explicit truthy values enable it; anything else
	// (false/0/off OR a typo) fails closed to disabled.
	return ["1", "true", "yes", "on"].includes(normalized);
}

// W4.7: which official provider the clean provider router prefers when a task
// type does not pin one. OpenAI is the default per the locked decision (OpenAI /
// OpenRouter are the only two official providers). A malformed value throws so a
// typo fails loudly instead of silently routing to the wrong provider.
export function readAiDefaultProviderEnv(
	raw = process.env.AI_DEFAULT_PROVIDER,
	fallback: AiOfficialProvider = "openai",
): AiOfficialProvider {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (normalized === "openai" || normalized === "openrouter") return normalized;
	throw new Error('AI_DEFAULT_PROVIDER must be "openai" or "openrouter"');
}
