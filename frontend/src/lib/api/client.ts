// API client for backend communication

import type {
	ActivityEvent,
	AiReviewMarker,
	AiReviewMarkerStatus,
	AiTier,
	ChapterTeamMember,
	ChapterTeamRole,
	ProductionMode,
	WorkspaceContact,
	WorkspaceContactRelationship,
	PageReviewDecision,
	PageReviewDecisionStatus,
	ReviewAssignment,
	ReviewAssignmentStatus,
	RevisionRequest,
	RevisionRequestStatus,
	ProjectComment,
	ProjectState,
	ReviewAnnotation,
	VersionReviewRequest,
	VersionReviewStatus,
	WorkflowTask,
	WorkflowTaskPriority,
	WorkflowTaskStatus,
	WorkflowTaskType,
	WorkspaceFeedItem,
	WorkspaceMessage,
		AdminConfig,
		ExportArtifact,
		ExportProfileId,
		ExportRun,
	} from "$lib/types.js";
import { config } from "$lib/config.js";
import { safeFormat } from "$lib/i18n/safeLocale.ts";
import { workspaceSuspension } from "$lib/stores/workspace-suspension.svelte.ts";

const BASE = config.apiBase;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
let apiAccessToken: string | null = null;

interface RequestOptions extends RequestInit {
	timeoutMs?: number;
	/** Internal: set on the single post-refresh retry to prevent a refresh loop. */
	__isRetry?: boolean;
	/**
	 * Optional fetch implementation. A SvelteKit `load` passes its event `fetch`
	 * here so the request is tracked by the framework instead of emitting the
	 * "Loading … using window.fetch" SSR/hydration warning. Defaults to the
	 * global `fetch` when omitted.
	 */
	fetchImpl?: typeof fetch;
}

export interface ApiErrorDetails {
	status: number;
	statusText: string;
	code?: string;
	retryAfter?: number;
	body?: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly code?: string;
	readonly retryAfter?: number;
	readonly body?: unknown;

	constructor(message: string, details: ApiErrorDetails) {
		super(message);
		this.name = "ApiError";
		this.status = details.status;
		this.statusText = details.statusText;
		this.code = details.code;
		this.retryAfter = details.retryAfter;
		this.body = details.body;
	}
}

export function setApiAccessToken(token: string | null | undefined): void {
	const nextToken = token?.trim() || null;
	// Security: when the bearer identity changes (login / account switch /
	// refresh rotation), any signed asset tokens minted under the previous
	// identity must NOT be reusable. Clear the asset-token cache + inflight map
	// so the next <img> re-mints under the new identity. (clearAssetTokenCache
	// is a hoisted function declaration defined later in this file.)
	if (nextToken !== apiAccessToken) {
		clearAssetTokenCache();
	}
	apiAccessToken = nextToken;
}

export function clearApiAccessToken(): void {
	apiAccessToken = null;
	// Security: logout must drop cached signed asset tokens so a later session
	// in the same SPA tab cannot reuse the previous user's minted tokens.
	clearAssetTokenCache();
}

// ── Transparent access-token refresh on 401 ─────────────────────────────────
//
// The JWT access token has a short TTL (~15 min). Without this, every API call
// after expiry 401s and the app looks broken until a manual reload. The auth
// store registers a refresh handler here; when `apiFetch` sees a 401 on a
// non-auth route it runs ONE refresh (shared via a single-flight guard so a
// burst of concurrent 401s triggers a single refresh, not a storm), then
// retries the original request once with the freshly-minted token.
//
// The handler returns the new access token on success, or null when the refresh
// token is invalid/expired (the handler is responsible for clearing the session
// in that case — we must NOT loop). Dependency injection (rather than importing
// the auth store) keeps this module free of a circular import: auth.svelte.ts
// imports the client, so the client cannot import it back.

export type AuthRefreshHandler = () => Promise<string | null>;

let authRefreshHandler: AuthRefreshHandler | null = null;
// Single-flight: concurrent 401s share one in-flight refresh promise.
let refreshInFlight: Promise<string | null> | null = null;
// Monotonic "refresh epoch", bumped each time a refresh SUCCEEDS. A request
// captures the epoch before it is sent; if a 401 comes back but the epoch has
// since advanced, the access token was already refreshed by another request
// while this one was in flight — so we retry with the fresh token directly
// instead of triggering a redundant refresh. This is what collapses a burst of
// requests that were all sent with the SAME stale token (and therefore all 401
// at staggered times) down to exactly ONE refresh, rather than one per 401 that
// happens to arrive after the previous refresh already resolved.
let refreshEpoch = 0;

export function setAuthRefreshHandler(handler: AuthRefreshHandler | null): void {
	authRefreshHandler = handler;
}

// Ensure the access token has been refreshed since `sentEpoch`. If another
// request already refreshed in that window, this resolves to the current token
// without a network call. Otherwise it runs the registered handler, sharing a
// single in-flight call so simultaneous 401s do not fan out into a refresh
// storm. Resolves to the new access token, or null when no handler is
// registered or the refresh failed.
function ensureRefreshedSince(sentEpoch: number): Promise<string | null> {
	if (!authRefreshHandler) return Promise.resolve(null);
	// A refresh already completed after this request was sent → token is fresh.
	if (refreshEpoch > sentEpoch) return Promise.resolve(apiAccessToken);
	if (refreshInFlight) return refreshInFlight;
	const handler = authRefreshHandler;
	refreshInFlight = (async () => {
		try {
			const token = await handler();
			// Only advance the epoch on a genuine success so a failed refresh does
			// not make later 401s believe the token is fresh.
			if (token) refreshEpoch += 1;
			return token;
		} catch {
			return null;
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

// Auth endpoints must never trigger refresh-on-401: refreshing the refresh
// endpoint itself would loop, and login/register/logout 401s are real
// credential failures the caller needs to see, not transient token expiry.
function isAuthRoute(input: RequestInfo | URL): boolean {
	let url: string;
	if (typeof input === "string") url = input;
	else if (input instanceof URL) url = input.href;
	else url = input.url;
	return url.includes("/auth/");
}

// Test-only: reset the refresh handler + single-flight/epoch state between cases.
export function __resetAuthRefreshForTests(): void {
	authRefreshHandler = null;
	refreshInFlight = null;
	refreshEpoch = 0;
}

function withApiAuthHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
	if (!apiAccessToken) return headers;
	const nextHeaders = new Headers(headers);
	if (!nextHeaders.has("Authorization")) {
		nextHeaders.set("Authorization", `Bearer ${apiAccessToken}`);
	}
	return nextHeaders;
}

// Issue a single fetch with this module's auth header attached, wiring up the
// per-request timeout + caller abort signal. The Authorization header is read
// from `apiAccessToken` at call time, so a retry after a refresh automatically
// carries the new token. `init.fetchImpl` lets a SvelteKit `load` thread its
// event `fetch` through so the call is not flagged as a stray `window.fetch`.
async function performFetch(input: RequestInfo | URL, init: RequestOptions): Promise<Response> {
	const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, __isRetry: _isRetry, fetchImpl, ...requestInit } = init;
	const doFetch = fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
	const abortRequest = () => controller.abort();

	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", abortRequest, { once: true });
		}
	}

	try {
		return await doFetch(input, {
			...requestInit,
			headers: withApiAuthHeaders(requestInit.headers),
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw new Error("Request timed out or was cancelled");
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", abortRequest);
		globalThis.clearTimeout(timeout);
	}
}

async function apiFetch(input: RequestInfo | URL, init: RequestOptions = {}): Promise<Response> {
	// Snapshot the refresh epoch BEFORE sending so a 401 can tell whether the
	// token was already refreshed by a sibling request while this one was in
	// flight (→ retry directly) versus genuinely needing a fresh refresh.
	const sentEpoch = refreshEpoch;
	const res = await performFetch(input, init);

	// Transparent refresh-on-401. Only attempt when: the access token actually
	// expired (401), a refresh handler is registered, this is not an auth route
	// (refreshing /auth/* would loop), and we are not already retrying. The
	// original request body is reused as-is — a mutation that 401'd never reached
	// the handler (auth runs before the route), so replaying it after a fresh
	// token cannot double-apply.
	if (res.status !== 401 || init.__isRetry || !authRefreshHandler || isAuthRoute(input)) {
		return res;
	}

	const newToken = await ensureRefreshedSince(sentEpoch);
	// Refresh failed (refresh token invalid/expired): the handler already cleared
	// the session. Return the original 401 so the caller surfaces it — do NOT
	// loop or retry.
	if (!newToken) return res;

	// Drain the original 401 body so the underlying connection can be reused.
	try {
		await res.body?.cancel();
	} catch {
		// ignore — some environments lack a cancelable body
	}

	return performFetch(input, { ...init, __isRetry: true });
}

// Build the shared ApiError from a raw (status, statusText, body, Retry-After)
// tuple. Used by both the fetch-based handleResponse and the XHR upload path so
// they surface identical localized errors (413 oversize, quota codes, etc.).
function buildApiError(
	status: number,
	statusText: string,
	rawBody: string,
	retryAfterHeader: string | null,
): ApiError {
	let errorBody: any = undefined;
	let fallbackMessage = `API Error: ${status} ${statusText}`;
	if (rawBody) {
		try {
			errorBody = JSON.parse(rawBody);
			fallbackMessage = typeof errorBody?.error === "string" ? errorBody.error : fallbackMessage;
		} catch {
			fallbackMessage = rawBody;
		}
	}
	const retryAfter = parseRetryAfter(errorBody?.retryAfter, retryAfterHeader);
	// Workspace FREEZE reflection: a verified refund/chargeback (or admin suspension)
	// makes EVERY mutating request 403 with code `workspace_suspended`. Mirror that into
	// the suspension store so the dashboard shows the restore banner + disables editing.
	// The 403 itself is the hard gate; this only reflects it in the UI.
	if (status === 403 && errorBody?.code === "workspace_suspended") {
		workspaceSuspension.markSuspended(typeof errorBody?.reason === "string" ? errorBody.reason : null);
	}
	return new ApiError(formatApiErrorMessage({
		status,
		code: errorBody?.code,
		error: fallbackMessage,
		reason: errorBody?.reason,
		retryAfter,
		body: errorBody,
	}), {
		status,
		statusText,
		code: typeof errorBody?.code === "string" ? errorBody.code : undefined,
		retryAfter,
		body: errorBody ?? rawBody,
	});
}

// Helper function to handle API responses with proper error handling
async function handleResponse<T>(res: Response): Promise<T> {
	const rawBody = await res.text();

	if (!res.ok) {
		throw buildApiError(res.status, res.statusText, rawBody, res.headers.get("Retry-After"));
	}

	if (!rawBody) {
		return undefined as T;
	}

	try {
		return JSON.parse(rawBody) as T;
	} catch {
		throw new Error("Invalid JSON response from API");
	}
}

function parseRetryAfter(bodyValue: unknown, headerValue: string | null): number | undefined {
	const raw = bodyValue ?? headerValue;
	if (raw === undefined || raw === null || raw === "") return undefined;
	const parsed = Number.parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ── Optimistic-concurrency (CAS) baseline for server-owned project collections ──
//
// The dedicated mutation endpoints (tasks / comments / review-decisions /
// workspace-messages) gate on an OPTIONAL `x-project-base-state-hash` header: the
// full project-state hash the client last observed. The server compares it to the
// freshly-loaded state and returns 409 `project_save_conflict` on drift (and re-
// verifies atomically under a per-project lock before writing). For that guard to
// actually fire — instead of staying dormant, silently last-write-wins — the client
// MUST send the header. The server stamps the CURRENT hash on every GET + mutation
// response as `x-project-state-hash`; we cache the latest per projectId here and
// echo it back as the baseline on the next mutation, refreshing + retrying once on a
// 409 so a genuine concurrent change is reconciled rather than clobbered.
const projectStateBaseHashes = new Map<string, string>();

/** Capture the server's current full-state hash from any project response. */
function rememberProjectStateHash(projectId: string, res: Response): void {
	const hash = res.headers.get("x-project-state-hash");
	if (hash) projectStateBaseHashes.set(projectId, hash);
}

/** The last observed full-state hash for a project, if any (the CAS baseline). */
export function getProjectStateBaseHash(projectId: string): string | undefined {
	return projectStateBaseHashes.get(projectId);
}

/** Test/seam helper: forget a cached baseline (e.g. on closing a project). */
export function clearProjectStateBaseHash(projectId: string): void {
	projectStateBaseHashes.delete(projectId);
}

function isProjectSaveConflict(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && error.code === "project_save_conflict";
}

// Run a server-owned-collection mutation with the CAS baseline header attached, and
// on a 409 `project_save_conflict`, refresh the baseline from the server and retry
// ONCE. `perform(baseHash)` issues the actual request (it sets the header from
// `baseHash`) and must return the raw Response so we can capture the fresh hash.
// `parse` turns the successful Response into the typed payload. A mutation with no
// cached baseline sends no header (the server preserves prior last-write-wins for
// that single call), so a first-touch caller is never blocked.
async function mutateWithProjectCas<T>(
	projectId: string,
	perform: (baseHash: string | undefined) => Promise<Response>,
	parse: (res: Response) => Promise<T>,
): Promise<T> {
	const attempt = async (baseHash: string | undefined): Promise<Response> => {
		const res = await perform(baseHash);
		rememberProjectStateHash(projectId, res);
		return res;
	};
	let res = await attempt(projectStateBaseHashes.get(projectId));
	if (res.status === 409 || res.status === 428) {
		// Peek the body to confirm it is a CAS conflict (409 drift) OR a missing-baseline
		// rejection (428, server now REQUIRES the header — C5) without consuming the
		// stream the caller's parser needs. Clone first. Both are resolved the same way:
		// refresh the authoritative baseline from a fresh GET, then retry once.
		let isConflict = false;
		try {
			const probe = await res.clone().json();
			isConflict = probe?.code === "project_save_conflict" || probe?.code === "project_baseline_required";
		} catch {
			isConflict = false;
		}
		if (isConflict) {
			// Refresh the baseline from the authoritative full state, then retry once.
			try {
				await loadProject(projectId);
			} catch {
				// If the refetch fails, fall through and let the original 409 surface.
			}
			res = await attempt(projectStateBaseHashes.get(projectId));
		}
	}
	return parse(res);
}

function withProjectBaseStateHashHeader(baseHash: string | undefined, headers: Record<string, string> = {}): Record<string, string> {
	return baseHash ? { ...headers, "X-Project-Base-State-Hash": baseHash } : { ...headers };
}

function parseContentDispositionFilename(value: string | null): string | undefined {
	if (!value) return undefined;
	const starMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
	if (starMatch?.[1]) {
		try {
			return decodeURIComponent(starMatch[1].trim());
		} catch {
			return starMatch[1].trim();
		}
	}
	const quotedMatch = value.match(/filename="([^"]+)"/i);
	if (quotedMatch?.[1]) return quotedMatch[1].trim();
	const plainMatch = value.match(/filename=([^;]+)/i);
	return plainMatch?.[1]?.trim();
}

// Localized "try again in N" copy for the active locale. The minute/second
// granularity is preserved (sub-minute waits show seconds; longer waits show
// rounded-up minutes), but the wording follows the user's language instead of
// being hardcoded Thai.
function formatRetryAfter(seconds: number | undefined): string {
	if (!seconds) return safeFormat("apiError.retryAfterGeneric", {}, "Please try again shortly.");
	if (seconds < 60) {
		return safeFormat("apiError.retryAfterSeconds", { seconds }, `Try again in ${seconds}s.`);
	}
	const minutes = Math.ceil(seconds / 60);
	return safeFormat("apiError.retryAfterMinutes", { minutes }, `Try again in ${minutes} min.`);
}

// Friendly, actionable guidance for an oversize upload (a 413: a single file over
// the per-file cap, or the cumulative per-batch byte cap). Shared by the API-error
// formatter, the project store status path, and ChapterSetupDialog so every upload
// surface shows the same localized message instead of a raw English 413 string.
export const UPLOAD_TOO_LARGE_MESSAGE =
	"ไฟล์รวมกันใหญ่เกินไป — อัปโหลดทีละน้อยลง หรือย่อขนาด/บีบอัดรูปก่อน แล้วลองอีกครั้ง";

// Coded errors that ride a 413 but are NOT oversize-upload failures — they carry
// their own actionable message (e.g. a full workspace storage quota, an over-size
// pixel dimension, or a per-chapter image/byte cap) and must keep it instead of
// being shadowed by the generic upload-too-large guidance.
const NON_UPLOAD_SIZE_413_CODES = new Set([
	"storage_quota_exceeded",
	"image_dimensions_too_large",
	"chapter_image_limit_exceeded",
	"chapter_original_bytes_limit_exceeded",
]);

// True when an error is an oversize-upload failure: the explicit batch-cap code, a
// network/timeout that fired while shipping a huge batch, or a bare 413 (per-file or
// cumulative cap). A bare 413 only counts when its code is absent or itself an
// upload-size code — coded quota 413s (e.g. storage_quota_exceeded) are EXCLUDED so
// they keep their own message. Callers use this to swap in {@link UPLOAD_TOO_LARGE_MESSAGE}.
export function isUploadTooLargeError(error: unknown): boolean {
	// Unwrap a batch-failure wrapper (ImageUploadBatchError carries the original
	// ApiError on `.cause`) so a 413 is still recognized when it's annotated with a
	// page span. Defined in upload-batches.ts; matched structurally to avoid a cycle.
	if (error && typeof error === "object" && !(error instanceof ApiError) && "cause" in error) {
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof ApiError) error = cause;
	}
	if (!(error instanceof ApiError)) return false;
	if (error.code === "upload_batch_size_exceeded") return true;
	if (error.status === 0) return true;
	if (error.status === 413) {
		// Exclude known coded 413s that own a more specific message.
		return !(typeof error.code === "string" && NON_UPLOAD_SIZE_413_CODES.has(error.code));
	}
	return false;
}

// Maps a STABLE backend error code (and, where present, its `reason`) to a
// localized message in the user's active locale via the `apiError.*` catalog.
// The backend keeps returning a structured `{ error, code, reason }` body; the
// frontend no longer renders hardcoded Thai literals or leaks the backend's raw
// English `error` for codes we understand. Unknown/uncoded errors still fall
// back to the backend message (last resort) so nothing is swallowed silently.
export function formatApiErrorMessage(input: {
	status: number;
	code?: unknown;
	error: string;
	reason?: unknown;
	retryAfter?: number;
	body?: unknown;
}): string {
	const code = typeof input.code === "string" ? input.code : "";
	const retry = formatRetryAfter(input.retryAfter);
	const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
	const num = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	switch (code) {
		case "rate_limit_exceeded":
			return safeFormat("apiError.rateLimitExceeded", { retry }, `${input.error}. ${retry}`);
		case "rate_limit_store_unavailable":
			return safeFormat("apiError.rateLimitStoreUnavailable", { retry }, `${input.error}. ${retry}`);
		case "ai_queue_capacity_exceeded":
			return safeFormat(
				"apiError.aiQueueCapacityExceeded",
				{ retry, reason: queueReasonSuffix(input.reason) },
				`${input.error}. ${retry}`,
			);
		case "ai_queue_draining":
			return safeFormat("apiError.aiQueueDraining", { retry }, `${input.error}. ${retry}`);
		case "storage_quota_exceeded":
			return safeFormat("apiError.storageQuotaExceeded", {}, input.error);
		case "usage_quota_exceeded":
			return safeFormat(
				"apiError.usageQuotaExceeded",
				{ reason: usageQuotaReasonSuffix(input.reason) },
				input.error,
			);
		case "asset_egress_limit_exceeded":
			return safeFormat("apiError.assetEgressLimitExceeded", { retry }, `${input.error}. ${retry}`);
		case "asset_access_token_required":
			return safeFormat("apiError.assetAccessTokenRequired", {}, input.error);
		case "upload_batch_size_exceeded":
			return UPLOAD_TOO_LARGE_MESSAGE;
		case "image_dimensions_too_small":
			return safeFormat(
				"apiError.imageDimensionsTooSmall",
				{ minWidth: num(body.minWidth, 64), minHeight: num(body.minHeight, 64) },
				input.error,
			);
		case "image_dimensions_too_large":
			return safeFormat(
				"apiError.imageDimensionsTooLarge",
				{
					maxWidth: num(body.maxWidth, 0),
					maxHeight: num(body.maxHeight, 0),
					maxMegapixels: num(body.maxMegapixels, 0),
				},
				input.error,
			);
		case "image_not_decodable":
			return safeFormat("apiError.imageNotDecodable", {}, input.error);
		case "chapter_image_limit_exceeded":
			return safeFormat(
				"apiError.chapterImageLimitExceeded",
				{ limit: num(body.limitImages, 0) },
				input.error,
			);
		case "chapter_original_bytes_limit_exceeded":
			return safeFormat("apiError.chapterOriginalBytesLimitExceeded", {}, input.error);
		case "weak_password":
			return safeFormat(
				"apiError.weakPassword",
				{ reason: passwordRuleSuffix(input) },
				input.error,
			);
		case "invalid_credentials":
			return safeFormat("apiError.invalidCredentials", {}, input.error);
		case "account_disabled":
			return safeFormat("apiError.accountDisabled", {}, input.error);
		default:
			if (input.status === 429) {
				return safeFormat("apiError.generic429", { retry }, `${input.error}. ${retry}`);
			}
			if (input.status === 503) return `${input.error}. ${retry}`;
			// A 413 (per-file too big or the cumulative batch cap) otherwise surfaces
			// the backend's raw English string; show actionable localized guidance.
			if (input.status === 413) return UPLOAD_TOO_LARGE_MESSAGE;
			// Generic localization: any backend code with a matching `apiError.<camelCode>`
			// catalog key renders localized WITHOUT needing its own `case` above. The
			// explicit cases stay only where bespoke token shaping is required (queue/quota/
			// password reasons). `safeFormat` falls through active-locale → en → the raw
			// backend English, so an unknown/uncoded error still surfaces the backend
			// message (nothing swallowed). Scalar body fields are forwarded so simple
			// `{token}` keys interpolate when the backend supplies the field.
			//
			// IMPORTANT: only add an `apiError.*` key for codes whose backend `error` is a
			// STATIC message (e.g. project_not_found, unauthorized — every "Unauthorized"
			// variant just means "sign in"). Codes whose `error` carries dynamic, per-request
			// actionable detail must NOT get a generic key, or this would replace that detail
			// with generic copy — e.g. invalid_work_state_transition ("Transition X requires a
			// comment") or forbidden ("member performance is visible to leads and admins only",
			// "cannot upload to another user's storage account"). Leave those keyless so the
			// backend text survives until a precise `case` arm (or a more specific code) can
			// localize while preserving the detail.
			if (code) {
				const values: Record<string, string | number> = { retry };
				for (const [k, v] of Object.entries(body)) {
					if (typeof v === "string" || typeof v === "number") values[k] = v;
				}
				return safeFormat(`apiError.${snakeToCamelCode(code)}`, values, input.error);
			}
			return input.error;
	}
}

// Backend error codes are snake_case; the `apiError.*` catalog keys are camelCase.
// `project_not_found` → `projectNotFound`. Pure/total: a code with no underscores
// (or already camel) passes through unchanged.
export function snakeToCamelCode(code: string): string {
	return code.replace(/_([a-z0-9])/g, (_match, c: string) => c.toUpperCase());
}

// Backend `reason` code → localized usage-quota suffix (includes its own
// leading separator so it slots straight into `{reason}`). Empty when absent.
function usageQuotaReasonSuffix(reason: unknown): string {
	if (typeof reason !== "string") return "";
	const keyByReason: Record<string, string> = {
		daily_ai_credit_limit: "apiError.usageReason.dailyAiCredit",
		monthly_ai_credit_limit: "apiError.usageReason.monthlyAiCredit",
		daily_upload_bytes_limit: "apiError.usageReason.dailyUploadBytes",
		monthly_upload_bytes_limit: "apiError.usageReason.monthlyUploadBytes",
		daily_export_bytes_limit: "apiError.usageReason.dailyExportBytes",
		monthly_export_bytes_limit: "apiError.usageReason.monthlyExportBytes",
	};
	const key = keyByReason[reason];
	return key ? safeFormat(key, {}, "") : "";
}

// Backend `reason` code → localized AI-queue suffix. Empty when absent.
function queueReasonSuffix(reason: unknown): string {
	if (typeof reason !== "string") return "";
	const keyByReason: Record<string, string> = {
		global_open_limit: "apiError.queueReason.globalOpen",
		global_pending_limit: "apiError.queueReason.globalPending",
		project_open_limit: "apiError.queueReason.projectOpen",
		project_pending_limit: "apiError.queueReason.projectPending",
		tier_open_limit: "apiError.queueReason.tierOpen",
		project_reserved_budget_limit: "apiError.queueReason.projectReservedBudget",
	};
	const key = keyByReason[reason];
	return key ? safeFormat(key, {}, "") : "";
}

// Stable password-rule reason codes (from the backend `validatePassword`
// `codes` field, surfaced via `reason`) → localized rule copy. Accepts either a
// single code string or an array of codes (`reason` / `reasons`), joined into
// one readable sentence. Falls back to empty so the generic weakPassword copy
// still renders.
function passwordRuleSuffix(input: { reason?: unknown; body?: unknown }): string {
	const codes = collectPasswordRuleCodes(input);
	if (codes.length === 0) return "";
	const keyByCode: Record<string, string> = {
		password_min_length: "apiError.passwordRule.minLength",
		password_require_uppercase: "apiError.passwordRule.uppercase",
		password_require_lowercase: "apiError.passwordRule.lowercase",
		password_require_number: "apiError.passwordRule.number",
		password_require_special: "apiError.passwordRule.special",
	};
	const parts: string[] = [];
	for (const code of codes) {
		const key = keyByCode[code];
		if (key) parts.push(safeFormat(key, { count: passwordMinLengthFromBody(input) }, ""));
	}
	return parts.filter(Boolean).join(" ");
}

function collectPasswordRuleCodes(input: { reason?: unknown }): string[] {
	const r = input.reason;
	if (typeof r === "string") return [r];
	if (Array.isArray(r)) return r.filter((x): x is string => typeof x === "string");
	if (r && typeof r === "object" && Array.isArray((r as { codes?: unknown }).codes)) {
		return ((r as { codes: unknown[] }).codes).filter((x): x is string => typeof x === "string");
	}
	return [];
}

// The configured minimum length, if the backend surfaced it alongside the
// rule codes; defaults to 8 (the product floor) so the message is never blank.
function passwordMinLengthFromBody(input: { reason?: unknown }): number {
	const r = input.reason;
	if (r && typeof r === "object" && typeof (r as { minLength?: unknown }).minLength === "number") {
		return (r as { minLength: number }).minLength;
	}
	return 8;
}

export type WorkspaceAccessRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceStudioRole = "owner" | "admin" | "team_lead" | "translator" | "cleaner" | "typesetter" | "qc" | "guest";
// Platform roles — mirrors backend UserRole (backend/src/types/auth.ts). These
// gate the back-office; owner/admin/support/accountant reach /admin, while
// editor/viewer are ordinary app roles with no back-office access.
export type AuthUserRole = "owner" | "admin" | "support" | "accountant" | "editor" | "viewer";
export type AuthIdentityProvider = "local" | "auth0" | "oidc" | "saml" | "google" | "github" | "line";
export type AuthUserLocale = "th" | "en" | "id" | "ms";

export interface AuthUser {
	id: string;
	email: string;
	name: string;
	role: AuthUserRole;
	authProvider?: AuthIdentityProvider;
	externalSubject?: string;
	emailVerified?: boolean;
	verificationEmailSendFailed?: boolean;
	locale?: AuthUserLocale;
	isActive: boolean;
	createdAt?: string;
	updatedAt?: string;
	lastLogin?: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

export interface AuthResponse {
	user: AuthUser;
	tokens: AuthTokens;
	verificationEmail?: {
		sendFailed: boolean;
		resendPath: string;
	};
}

export type WorkspaceApiRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface WorkspaceScope {
	projectIds?: string[];
	chapterIds?: string[];
	pageIndexes?: number[];
	languages?: string[];
	taskTypes?: string[];
	assetPurposes?: string[];
	aiCreditPolicy?: "workspace" | "job_scoped" | "none";
}

export interface WorkspaceRecord {
	workspaceId: string;
	name: string;
	planId: string;
	storageIncludedBytes: number;
	storageExtraBytes: number;
	createdAt: string;
	updatedAt: string;
	memberRole?: WorkspaceApiRole;
	memberScope?: WorkspaceScope;
}

export interface WorkspaceMemberRecord {
	workspaceId: string;
	userId: string;
	role: WorkspaceApiRole;
	/**
	 * Workflow/studio role the UI derives capabilities from (W2.2). Distinct from
	 * the coarse access `role`; the backend returns it on member records (see
	 * workspace-access.ts) and consumers like the work board / pages views read
	 * `currentWorkspaceMember.memberStudioRole`.
	 */
	memberStudioRole: WorkspaceStudioRole;
	scope: WorkspaceScope;
	invitedByUserId?: string;
	createdAt: string;
	updatedAt: string;
	disabledAt?: string;
	/** Present while the member is "finished" (viewer seat with a restore pointer). */
	finishedFrom?: { role: WorkspaceApiRole; memberStudioRole?: WorkspaceStudioRole; finishedAt: string };
	/** Display name resolved server-side (issue #2). Absent ⇒ fall back to userId. */
	displayName?: string;
	/** Member email — only present for a full-scope manager (workspace-level PII). */
	email?: string;
}

export interface WorkspaceInviteRecord {
	inviteId: string;
	workspaceId: string;
	email: string;
	role: Exclude<WorkspaceApiRole, "owner">;
	scope: WorkspaceScope;
	status: WorkspaceInviteStatus;
	invitedByUserId: string;
	acceptedByUserId?: string;
	expiresAt: string;
	acceptedAt?: string;
	revokedAt?: string;
	createdAt: string;
	updatedAt: string;
	inviteToken?: string;
}

function withListParams(path: string, input: { cursor?: string; limit?: number; role?: WorkspaceApiRole } = {}): string {
	const params = new URLSearchParams();
	if (input.cursor) params.set("cursor", input.cursor);
	if (input.limit) params.set("limit", String(input.limit));
	if (input.role) params.set("role", input.role);
	const query = params.toString();
	return query ? `${path}?${query}` : path;
}

async function collectCursorPages<T>(
	fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
	maxPages = 50,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await fetchPage(cursor);
		items.push(...page.items);
		cursor = page.nextCursor;
		pages += 1;
		if (pages >= maxPages && cursor) {
			// Safety ceiling (issue #9b P1): this drainer fans out to members /
			// workspaces / invites. Without a cap, a pathological roster would fire
			// thousands of serial requests and render an unbounded list — hanging the
			// tab. Stop at ~maxPages*pageSize items; surfaces that genuinely need the
			// full set must paginate their UI rather than pre-draining everything.
			console.warn(`[api] collectCursorPages hit the ${maxPages}-page ceiling (~${items.length} items); stopping the drain.`);
			break;
		}
	} while (cursor);
	return items;
}

export async function login(email: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
	const res = await apiFetch(`${BASE}/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password, ...(turnstileToken ? { "cf-turnstile-response": turnstileToken } : {}) }),
	});
	return handleResponse(res);
}

export async function registerUser(input: {
	email: string;
	password: string;
	name: string;
	role?: AuthUserRole;
}, turnstileToken?: string): Promise<AuthResponse> {
	const res = await apiFetch(`${BASE}/auth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...input, ...(turnstileToken ? { "cf-turnstile-response": turnstileToken } : {}) }),
	});
	return handleResponse(res);
}

export async function refreshAuthSession(refreshToken: string): Promise<AuthResponse> {
	const res = await apiFetch(`${BASE}/auth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken }),
	});
	return handleResponse(res);
}

/**
 * Hardened SSO callback path: exchange the single-use, short-lived `sso_code`
 * from the redirect fragment for the real tokens via a POST (JSON body), so the
 * access/refresh tokens are NEVER placed in the URL fragment. The backend also
 * re-affirms the httpOnly auth cookies on this response.
 */
export async function exchangeSsoCode(code: string): Promise<AuthResponse> {
	const res = await apiFetch(`${BASE}/auth/sso/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	return handleResponse(res);
}

export async function getCurrentUser(fetchImpl?: typeof fetch): Promise<AuthUser> {
	const res = await apiFetch(`${BASE}/auth/me`, fetchImpl ? { fetchImpl } : {});
	return handleResponse(res);
}

export async function logout(refreshToken: string): Promise<void> {
	const res = await apiFetch(`${BASE}/auth/logout`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken }),
	});
	await handleResponse(res);
}

/**
 * Self-service: update the signed-in user's own profile preferences (PATCH /auth/me).
 * Email changes need a verified flow, so they are not exposed here.
 * Returns the updated user (no password hash).
 */
export async function updateMyProfile(input: { name?: string; locale?: AuthUserLocale }): Promise<AuthUser> {
	const body: { name?: string; locale?: AuthUserLocale } = {};
	if (input.name !== undefined) body.name = input.name;
	if (input.locale !== undefined) body.locale = input.locale;
	const res = await apiFetch(`${BASE}/auth/me`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return handleResponse(res);
}

/**
 * Change the signed-in user's password. Requires the current password; the
 * backend revokes all other sessions on success, so the caller should treat the
 * active session as needing a re-login.
 */
export async function changeMyPassword(input: { oldPassword: string; newPassword: string }): Promise<{ message: string }> {
	const res = await apiFetch(`${BASE}/auth/change-password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

// ── forgot/reset/verify password + email verification flows ───────────
// These call the merged W1.3 auth-flow backend routes (`/auth/forgot-password`,
// `/reset-password`, `/verify-email`, `/resend-verification` — PR #76, see
// backend/src/routes/auth.ts). Because the backend contract now exists, the
// `config.authRecoveryEnabled` flag defaults ON; it remains a kill-switch so an
// operator can disable the self-serve recovery UI without a redeploy, in which
// case these throw a clear, typed error and the UI shows a "not available yet"
// state instead of a misleading generic failure.
//
// `forgotPassword` is intentionally tolerant of "user not found" responses to
// avoid account enumeration — the backend returns ok regardless of whether the
// email exists.

export class AuthRecoveryUnavailableError extends Error {
	readonly code = "AUTH_RECOVERY_UNAVAILABLE";
	constructor(flow: string) {
		super(`Auth recovery flow "${flow}" is currently disabled.`);
		this.name = "AuthRecoveryUnavailableError";
	}
}

function assertRecoveryEnabled(flow: string): void {
	if (!config.authRecoveryEnabled) {
		throw new AuthRecoveryUnavailableError(flow);
	}
}

export interface ForgotPasswordResult {
	ok: boolean;
	message?: string;
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResult> {
	assertRecoveryEnabled("forgot-password");
	const res = await apiFetch(`${BASE}/auth/forgot-password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});
	return handleResponse(res);
}

export interface ResetPasswordResult {
	ok: boolean;
	message?: string;
}

export async function resetPassword(token: string, newPassword: string): Promise<ResetPasswordResult> {
	assertRecoveryEnabled("reset-password");
	const res = await apiFetch(`${BASE}/auth/reset-password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, newPassword }),
	});
	return handleResponse(res);
}

export interface VerifyEmailResult {
	verified: true;
	user: Pick<AuthUser, "id" | "email" | "emailVerified">;
}

export async function verifyEmail(token: string): Promise<VerifyEmailResult> {
	assertRecoveryEnabled("verify-email");
	const res = await apiFetch(`${BASE}/auth/verify-email`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	return handleResponse(res);
}

/**
 * Verify the signed-in user's email by redeeming the 6-digit OTP they were emailed.
 * Identity is the session bearer token — the code is never paired with an email in
 * the request body — so a caller can only ever verify their own account.
 */
export async function verifyOtp(code: string): Promise<VerifyEmailResult> {
	const res = await apiFetch(`${BASE}/auth/verify-otp`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	return handleResponse(res);
}

export interface ResendVerificationResult {
	ok: true;
}

/**
 * Resend the verification email for the signed-in user. Exposed under two
 * names: `resendVerificationEmail` (account-menu callers) and the shorter
 * `resendVerification` alias used by the W1.4 auth-shell surfaces.
 */
export async function resendVerificationEmail(turnstileToken?: string): Promise<ResendVerificationResult> {
	assertRecoveryEnabled("resend-verification");
	const res = await apiFetch(`${BASE}/auth/resend-verification`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(turnstileToken ? { "cf-turnstile-response": turnstileToken } : {}),
	});
	return handleResponse(res);
}

export const resendVerification = resendVerificationEmail;

export async function getWorkspaces(options: { cursor?: string; limit?: number; role?: WorkspaceApiRole } = {}): Promise<{
	workspaces: WorkspaceRecord[];
	nextCursor?: string;
}> {
	const url = withListParams(`${BASE}/workspaces`, options);
	const res = await apiFetch(url);
	return handleResponse(res);
}

export async function getAllWorkspaces(): Promise<WorkspaceRecord[]> {
	return collectCursorPages(async (cursor) => {
		const page = await getWorkspaces({ cursor, limit: 100 });
		return { items: page.workspaces, nextCursor: page.nextCursor };
	});
}

// --- Workspace-home aggregate -------------------------------------------------
// Cross-project dashboard data: My-Work / attention / activity / AI jobs /
// pipeline, fanned across every project the member can see and merged
// server-side. This is INDEPENDENT of whichever single chapter is open in the
// editor — it is what lets the dashboard show honest aggregated work with no
// project open. Shape mirrors backend/src/services/workspace-home.ts.

export interface WorkspaceHomeProjectRef {
	projectId: string;
	projectName: string;
	storyId?: string;
	storyTitle?: string;
	chapterLabel?: string;
	targetLang?: string;
}

export interface WorkspaceHomeTask extends WorkspaceHomeProjectRef {
	id: string;
	type: WorkflowTaskType;
	status: WorkflowTaskStatus;
	priority: WorkflowTaskPriority;
	title: string;
	pageIndex: number;
	assignee?: string;
	dueAt?: string;
	dueState?: "overdue" | "soon" | "scheduled";
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceHomeFeedItem extends WorkspaceFeedItem, WorkspaceHomeProjectRef {}

export interface WorkspaceHomeAiJob extends WorkspaceHomeProjectRef {
	id: string;
	markerId: string;
	jobId: string;
	pageIndex: number;
	status: string;
	tier: string;
	updatedAt: string;
	error?: string;
}

export interface WorkspacePipelineStageCounts {
	stage: WorkflowTaskType;
	todo: number;
	doing: number;
	review: number;
	done: number;
	total: number;
	open: number;
}

export interface WorkspaceHomeCounts {
	projects: number;
	myOpenTasks: number;
	attention: number;
	aiJobs: number;
	dueToday: number;
	overdue: number;
	openTasks: number;
}

// Stable, WORKSPACE-scoped hero project ("resume where you left off"): the
// most-recently-updated project the member can see, derived server-side from the
// aggregate's own inputs — NOT from whichever single chapter is open in the
// editor. This is what keeps the dashboard hero identical across opening/closing
// a chapter. `null` when the workspace has no projects (honest empty hero).
export interface WorkspaceHomeRecentProject extends WorkspaceHomeProjectRef {
	sourceLang?: string;
	pageCount: number;
	updatedAt: string;
	// Honest localization progress (share of pages whose latest review decision is
	// `approved`). `hasProgress` gates the meter so the hero shows an honest
	// "unknown" state instead of a fabricated percentage.
	progressPercent: number;
	hasProgress: boolean;
	// Cover identity for the hero, sourced from the aggregate's OWN project state
	// (not the open chapter). The hero builds its thumbnail URL from projectId +
	// coverImageId so the cover is stable across chapter open/close.
	coverImageId?: string;
	coverOriginalName?: string;
}

export interface WorkspaceHomeAggregate {
	workspaceId: string;
	generatedAt: string;
	myTasks: WorkspaceHomeTask[];
	attention: WorkspaceHomeFeedItem[];
	activity: WorkspaceHomeFeedItem[];
	aiJobs: WorkspaceHomeAiJob[];
	pipelineByStage: WorkspacePipelineStageCounts[];
	dueToday: WorkspaceHomeTask[];
	counts: WorkspaceHomeCounts;
	// Distinct target-language codes across every visible project (sorted, upper-cased).
	// Workspace-scoped so the dashboard's "target languages" metric is independent of
	// the open chapter. Empty for an empty workspace.
	targetLangs: string[];
	recentProject: WorkspaceHomeRecentProject | null;
}

export async function getWorkspaceHome(workspaceId: string): Promise<WorkspaceHomeAggregate> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/home`);
	return handleResponse(res);
}

export async function createWorkspace(input: { name: string; plan?: string }): Promise<{ workspace: WorkspaceRecord }> {
	const res = await apiFetch(`${BASE}/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: input.name }),
	});
	return handleResponse(res);
}

export async function getWorkspace(workspaceId: string): Promise<{
	workspace: WorkspaceRecord;
	member: WorkspaceMemberRecord;
}> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}`);
	return handleResponse(res);
}

export async function patchWorkspace(workspaceId: string, patch: { name?: string }): Promise<{ workspace: WorkspaceRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	return handleResponse(res);
}

export async function getWorkspaceMembers(workspaceId: string, options: { cursor?: string; limit?: number; role?: WorkspaceApiRole } = {}): Promise<{
	members: WorkspaceMemberRecord[];
	nextCursor?: string;
}> {
	const url = withListParams(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members`, options);
	const res = await apiFetch(url);
	return handleResponse(res);
}

export async function getAllWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
	return collectCursorPages(async (cursor) => {
		const page = await getWorkspaceMembers(workspaceId, { cursor, limit: 100 });
		return { items: page.members, nextCursor: page.nextCursor };
	});
}

export async function updateWorkspaceMemberRole(
	workspaceId: string,
	userId: string,
	input: { role: WorkspaceApiRole; scope?: WorkspaceScope },
): Promise<{ member: WorkspaceMemberRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
		method: "DELETE",
	});
	return handleResponse(res);
}

export async function finishWorkspaceMember(workspaceId: string, userId: string): Promise<{ member: WorkspaceMemberRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/finish`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function reopenWorkspaceMember(workspaceId: string, userId: string): Promise<{ member: WorkspaceMemberRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/reopen`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function leaveWorkspace(workspaceId: string): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/me/leave`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function addWorkspaceMember(
	workspaceId: string,
	input: { email: string; role: Exclude<WorkspaceApiRole, "owner">; scope?: WorkspaceScope; ttlSeconds?: number },
): Promise<{ invite: WorkspaceInviteRecord; inviteEmailSendFailed?: boolean }> {
	return createInvite(workspaceId, input);
}

// ── Series-level duty assignments ────────────────────────────────────────────
// A story assignment gives a member a recurring duty on EVERY chapter of the
// story (incl. future ones, resolved server-side at read time). Chapter-level
// roles (the chapter team) override these on conflict.

export type StoryAssignmentRole = "translator" | "cleaner" | "typesetter" | "qc";

export interface StoryRoleAssignment {
	workspaceId: string;
	storyId: string;
	userId: string;
	role: StoryAssignmentRole;
	assignedBy?: string;
	createdAt: string;
	updatedAt: string;
	/** Best-effort display enrichment supplied by the server. */
	displayName?: string;
	email?: string;
}

/** Assignable member (id + display handles); present only for managers. */
export interface StoryAssignmentCandidate {
	userId: string;
	name?: string | null;
	email?: string | null;
}

export async function listStoryAssignments(workspaceId: string, storyId?: string): Promise<{
	assignments: StoryRoleAssignment[];
	candidates?: StoryAssignmentCandidate[];
}> {
	const params = new URLSearchParams();
	if (storyId) params.set("storyId", storyId);
	const query = params.toString();
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/story-assignments${query ? `?${query}` : ""}`);
	return handleResponse(res);
}

export async function upsertStoryAssignment(
	workspaceId: string,
	input: { storyId: string; userId: string; role: StoryAssignmentRole; storyTitle?: string },
): Promise<{ assignment: StoryRoleAssignment }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/story-assignments`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function upsertStoryAssignments(
	workspaceId: string,
	input: { storyIds: string[]; userId: string; role: StoryAssignmentRole; storyTitle?: string },
): Promise<{ assignments: StoryRoleAssignment[]; changedCount: number }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/story-assignments/bulk`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function removeStoryAssignment(workspaceId: string, storyId: string, userId: string, role?: StoryAssignmentRole): Promise<{ ok: boolean; removed: boolean }> {
	// `role` removes ONE duty (multi-duty); omitted ⇒ clears every duty the member holds on the story.
	const query = role ? `?role=${encodeURIComponent(role)}` : "";
	const res = await apiFetch(
		`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/story-assignments/${encodeURIComponent(storyId)}/${encodeURIComponent(userId)}${query}`,
		{ method: "DELETE" },
	);
	return handleResponse(res);
}

export async function listWorkspaceInvites(workspaceId: string, options: { cursor?: string; limit?: number } = {}): Promise<{
	invites: WorkspaceInviteRecord[];
	nextCursor?: string;
}> {
	const url = withListParams(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/invites`, options);
	const res = await apiFetch(url);
	return handleResponse(res);
}

export async function getAllWorkspaceInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]> {
	return collectCursorPages(async (cursor) => {
		const page = await listWorkspaceInvites(workspaceId, { cursor, limit: 100 });
		return { items: page.invites, nextCursor: page.nextCursor };
	});
}

export async function createInvite(
	workspaceId: string,
	input: { email: string; role: Exclude<WorkspaceApiRole, "owner">; scope?: WorkspaceScope; ttlSeconds?: number },
): Promise<{ invite: WorkspaceInviteRecord; inviteEmailSendFailed?: boolean }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function cancelInvite(workspaceId: string, inviteId: string): Promise<{ invite: WorkspaceInviteRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`, {
		method: "DELETE",
	});
	return handleResponse(res);
}

export async function acceptInvite(inviteId: string, inviteToken: string): Promise<{ member: WorkspaceMemberRecord }> {
	const res = await apiFetch(`${BASE}/workspaces/invites/${encodeURIComponent(inviteId)}/accept`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ inviteToken }),
	});
	return handleResponse(res);
}

export type SsoProvider = "google" | "github" | "line";

/**
 * Full URL of the backend SSO redirect endpoint. The endpoint responds with a
 * 302 to the provider, so callers must navigate the browser to it (set
 * `window.location.href`) rather than fetch it — a fetch cannot follow the
 * cross-origin provider redirect and would not set the OAuth state/PKCE cookies.
 */
export function ssoStartUrl(provider: SsoProvider): string {
	return `${BASE}/auth/sso/${encodeURIComponent(provider)}/start`;
}

export interface SsoProviderInfo {
	id: SsoProvider;
	name: string;
	enabled: boolean;
}

/**
 * Public endpoint listing which SSO providers the backend actually has
 * credentials for. The UI uses it to render only configured providers' buttons
 * (e.g. hide LINE when its channel id/secret are unset). No auth required.
 */
export async function fetchSsoProviders(): Promise<SsoProviderInfo[]> {
	const res = await apiFetch(`${BASE}/auth/sso/providers`);
	const body = await handleResponse<{ providers?: SsoProviderInfo[] }>(res);
	return Array.isArray(body.providers) ? body.providers : [];
}

export interface SsoLinkConfirmResult {
	status: "linked";
	user: AuthUser;
	tokens: AuthTokens;
}

export async function confirmSsoLink(input: {
	linkIntentToken: string;
	currentPassword?: string;
}): Promise<SsoLinkConfirmResult> {
	const body: Record<string, string> = { link_intent_token: input.linkIntentToken };
	if (input.currentPassword) body.currentPassword = input.currentPassword;
	const res = await apiFetch(`${BASE}/auth/sso/link/confirm`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return handleResponse(res);
}

export interface ProjectIdentityMetadata {
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	sourceLang?: string;
	readingDirection?: import("$lib/project/reading-direction.js").ReadingDirection;
	// Stamp the project with the workspace it belongs to so it surfaces in the
	// workspace dashboard / home aggregate (hero, pipeline, my-tasks). Omitted ⇒
	// a personal/legacy project (the backend treats an absent workspaceId as the
	// owner's personal space). The backend membership-checks this value before
	// stamping it, so passing a workspace the caller isn't a member of is rejected.
	workspaceId?: string;
	// Chapter-level Team/Solo selection + invite-at-creation. Absent ⇒ Solo /
	// owner-only. `initialInvites` are added to the new chapter's roster; a bad
	// invite is non-fatal (the chapter still creates) and surfaces in `inviteFailures`.
	productionMode?: ProductionMode;
	initialInvites?: ChapterTeamInviteInput[];
}

export interface ChapterTeamInviteInput {
	/** Invite by UID (the product user id) OR email — exactly one is required. */
	userId?: string;
	email?: string;
	displayName?: string;
	role: ChapterTeamRole;
}

export interface CreateProjectResult {
	projectId: string;
	inviteFailures?: Array<{ index: number; code: string; message: string }>;
}

export async function createProject(
	name: string,
	lang = "th",
	metadata: ProjectIdentityMetadata = {},
): Promise<CreateProjectResult> {
	const res = await apiFetch(`${BASE}/project/new`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, lang, ...metadata }),
	});
	return handleResponse(res);
}

// ── Chapter team (Team/Solo + invites) ───────────────────────────────────────
export interface ChapterTeamView {
	productionMode: ProductionMode;
	team: ChapterTeamMember[];
	maxMembers: number;
}

export async function getChapterTeam(projectId: string): Promise<ChapterTeamView> {
	const res = await apiFetch(`${BASE}/project/${encodeURIComponent(projectId)}/team`);
	return handleResponse(res);
}

export async function inviteChapterTeamMember(
	projectId: string,
	input: ChapterTeamInviteInput,
): Promise<{ member: ChapterTeamMember; productionMode: ProductionMode }> {
	const res = await apiFetch(`${BASE}/project/${encodeURIComponent(projectId)}/team/invites`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function updateChapterTeam(
	projectId: string,
	input: { productionMode?: ProductionMode; updateMemberId?: string; role?: ChapterTeamRole },
): Promise<{ productionMode: ProductionMode; team: ChapterTeamMember[] }> {
	const res = await apiFetch(`${BASE}/project/${encodeURIComponent(projectId)}/team`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function removeChapterTeamMember(
	projectId: string,
	memberId: string,
): Promise<{ ok: boolean; productionMode: ProductionMode }> {
	const res = await apiFetch(`${BASE}/project/${encodeURIComponent(projectId)}/team/${encodeURIComponent(memberId)}`, {
		method: "DELETE",
	});
	return handleResponse(res);
}

// A pending chapter-team invite addressed to the CURRENT user's verified email.
// Returned only for the caller's own verified address; the invitee accepts via
// acceptChapterTeamInvite() to gain access to the chapter.
export interface MyChapterTeamInvite {
	projectId: string;
	chapterLabel: string;
	storyTitle?: string;
	role: ChapterTeamRole;
	invitedByName?: string;
	invitedAt: string;
}

export async function listMyChapterTeamInvites(): Promise<{ invites: MyChapterTeamInvite[] }> {
	const res = await apiFetch(`${BASE}/project/my/invites`);
	return handleResponse(res);
}

export async function acceptChapterTeamInvite(
	projectId: string,
): Promise<{ member: ChapterTeamMember; productionMode: ProductionMode }> {
	const res = await apiFetch(`${BASE}/project/${encodeURIComponent(projectId)}/team/accept`, {
		method: "POST",
	});
	return handleResponse(res);
}

// ── Workspace contacts (friends / followers) ─────────────────────────────────
export async function listContacts(): Promise<{ contacts: WorkspaceContact[]; roles: ChapterTeamRole[] }> {
	const res = await apiFetch(`${BASE}/contacts`);
	return handleResponse(res);
}

export async function addContact(input: {
	contactUserId?: string;
	email?: string;
	displayName?: string;
	relationship?: WorkspaceContactRelationship;
	suggestedRole?: ChapterTeamRole;
}): Promise<{ contact: WorkspaceContact }> {
	const res = await apiFetch(`${BASE}/contacts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function deleteContact(contactId: string): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/contacts/${encodeURIComponent(contactId)}`, { method: "DELETE" });
	return handleResponse(res);
}

export async function resolveContactInviteTarget(contactId: string): Promise<{ target: ChapterTeamInviteInput }> {
	const res = await apiFetch(`${BASE}/contacts/${encodeURIComponent(contactId)}/invite-target`, { method: "POST" });
	return handleResponse(res);
}

export async function loadProject(projectId: string): Promise<ProjectState> {
	const res = await apiFetch(`${BASE}/project/${projectId}`);
	rememberProjectStateHash(projectId, res);
	return handleResponse(res);
}

/** Server response for the gated language-track add/remove endpoints (#221). */
export interface LanguageTrackMutationResult {
	projectId: string;
	targetLang: string;
	targetLangs: string[];
}

/**
 * Add a per-language track to a project (POST /project/:id/languages).
 *
 * The track set is server-owned: changes only go through this gated endpoint, not
 * the general save path. Surfaces a typed {@link ApiError} on failure — notably
 * `language_track_exists` (409 duplicate) and `workspace_language_track_scope_denied`
 * (403 scope-denied), which callers map to honest inline messages.
 */
export async function addProjectLanguage(
	projectId: string,
	language: string,
): Promise<LanguageTrackMutationResult> {
	const res = await apiFetch(`${BASE}/project/${projectId}/languages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ language }),
	});
	return handleResponse(res);
}

/**
 * Remove a non-primary per-language track (DELETE /project/:id/languages/:language).
 *
 * The server refuses to remove the primary track (`cannot_remove_primary_language_track`)
 * or the last remaining track (`cannot_remove_last_language_track`), and enforces the
 * same scope check as add (`workspace_language_track_scope_denied`, 403).
 */
export async function removeProjectLanguage(
	projectId: string,
	language: string,
): Promise<LanguageTrackMutationResult> {
	const res = await apiFetch(`${BASE}/project/${projectId}/languages/${encodeURIComponent(language)}`, {
		method: "DELETE",
	});
	return handleResponse(res);
}

export interface StoryRenameResult {
	projectId: string;
	storyId?: string;
	storyTitle: string;
}

/**
 * Rename a story by updating one chapter project's `storyTitle`
 * (PATCH /project/:id/story). The stable `storyId` (#244) is preserved by the
 * server, so the `/library/<storyId>-<slug>` URL keeps resolving. A whole-story
 * rename is the caller iterating this over every chapter project in the story.
 */
export async function renameProjectStory(
	projectId: string,
	storyTitle: string,
): Promise<StoryRenameResult> {
	const res = await apiFetch(`${BASE}/project/${projectId}/story`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ storyTitle }),
	});
	return handleResponse(res);
}

export interface ProjectDeleteResult {
	ok: boolean;
	deleted?: boolean;
	projectId: string;
}

/**
 * Permanently delete a single chapter project (DELETE /project/:id) — its
 * catalog rows and on-disk assets. Irreversible. Deleting a whole STORY is the
 * caller iterating this over every chapter project under the story's `storyId`.
 * The server requires a confirmation body echoing the exact story title (the
 * same value the type-to-confirm dialog collects) and rejects a blind delete with
 * 400, so the destructive op is enforced server-side, not just in the UI.
 * Surfaces a typed {@link ApiError} on 400/403/404 so callers show an honest message.
 */
export async function deleteProject(projectId: string, confirmStoryTitle: string): Promise<ProjectDeleteResult> {
	const res = await apiFetch(`${BASE}/project/${projectId}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirmStoryTitle }),
	});
	return handleResponse(res);
}

export interface ProjectSummary {
	projectId: string;
	/**
	 * The workspace this project belongs to, when it is a WORKSPACE project. Absent
	 * for personal/legacy (unfiled) projects. Used to namespace story grouping so
	 * two workspaces that happen to share a `storyId` never merge into one shelf.
	 */
	workspaceId?: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	readingDirection?: import("$lib/project/reading-direction.js").ReadingDirection;
	coverImageId?: string;
	coverOriginalName?: string;
	sourceLang?: string;
	/**
	 * The project's DEFAULT target-language track. Always present; for a
	 * single-language / legacy project (no `targetLangs`) it is the only track.
	 */
	targetLang: string;
	/**
	 * Per-language model (PR-6+): the full set of Language Tracks this single
	 * project carries. Absent for single-language / legacy projects — treat as
	 * `[targetLang]`. When present and longer than one, the project surfaces
	 * MULTIPLE languages on the dashboard even though it is one project row
	 * (no sibling-per-language workaround needed).
	 */
	targetLangs?: string[];
	pageCount: number;
	textLayerCount: number;
	taskCount?: number;
	openTaskCount?: number;
	reviewTaskCount?: number;
	commentCount?: number;
	openCommentCount?: number;
}

/**
 * List the projects visible to the caller. When `workspaceId` is given, the
 * server bounds the listing to THAT workspace (and enforces the caller's
 * membership), so the Library shows only the current workspace's projects and
 * story shelves never merge across workspaces. Omitted → the legacy
 * user-ownership listing (back-compat).
 */
export async function listProjects(workspaceId?: string): Promise<{ projects: ProjectSummary[] }> {
	const trimmed = workspaceId?.trim();
	const base = trimmed
		? `${BASE}/project?workspaceId=${encodeURIComponent(trimmed)}`
		: `${BASE}/project`;
	// The backend paginates this list (LIMIT ~100 + cursor). Previously we read only
	// the FIRST page and dropped `nextCursor`, so a workspace with >100 chapters was
	// silently truncated to the newest 100 everywhere it feeds (library shelf,
	// chapter board, search). Follow the cursor — but BOUNDED (not the unbounded
	// drainer) so a pathological catalog can't hang the tab; beyond the ceiling the
	// library needs real UI pagination (issue #9b P2).
	const MAX_PAGES = 10; // ~1,000 projects — covers realistic teams
	const projects: ProjectSummary[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const url = cursor
			? `${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`
			: base;
		const res = await apiFetch(url);
		const page = await handleResponse<{ projects: ProjectSummary[]; nextCursor?: string }>(res);
		if (page.projects?.length) projects.push(...page.projects);
		cursor = page.nextCursor;
		pages += 1;
		if (pages >= MAX_PAGES && cursor) {
			console.warn(`[api] listProjects hit the ${MAX_PAGES}-page ceiling (~${projects.length} projects); library may be truncated — add UI pagination for very large catalogs.`);
			break;
		}
	} while (cursor);
	return { projects };
}

// Server-authoritative sub-collections that are mutated ONLY through dedicated
// endpoints (workflow/comments/ai-markers/review-decisions/review-assignments/
// revisions/workspace-feed/exports/chapter-team). The general `/save` writer
// ignores these on the request body and keeps its persisted copy (remapping
// page-linked records server-side on a page reorder). We also STRIP them from the
// save body here as belt-and-suspenders, so a stale hydrated client copy can never
// reach the writer even if the backend guard regressed — a general save must never
// drop a concurrent dedicated change.
//
// This MUST list every collection the backend `/save` handler force-overrides
// from persisted state (`body.x = state.x` in `backend/src/routes/project.ts`).
// Previously `reviewAssignments`, `revisionRequests`, and `chapterTeam` were
// missing here, so a stale tab's empty arrays still reached the writer — harmless
// only because the backend re-overrides them, but the belt-and-suspenders intent
// (survive a backend guard regression) was broken for exactly the newest, most
// review-critical collections.
const REMOTE_OWNED_SAVE_KEYS = [
	"tasks",
	"activityLog",
	"comments",
	"aiReviewMarkers",
	"reviewDecisions",
	"reviewAssignments",
	"revisionRequests",
	"workspaceMessages",
	"versionReviewRequests",
	"exportRuns",
	"chapterTeam",
] as const;

export async function saveProject(
	projectId: string,
	state: ProjectState,
	options: { baseFingerprint?: string | null; editLockId?: string | null; editClientId?: string | null; pageScoped?: boolean } = {},
): Promise<void> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (options.baseFingerprint) {
		headers.set("X-Project-Base-Fingerprint", options.baseFingerprint);
	}
	// C1: send the page lease this save was made under so the backend can reject a
	// displaced/expired holder's in-flight save (which still has a matching CAS
	// baseline) and steer it into the recovery-draft flow instead of clobbering the
	// new holder. Omitted when no lease is held (file-mode / lock service down) — the
	// server then falls back to CAS-only, exactly as before.
	if (options.editLockId) {
		headers.set("X-Edit-Lock-Id", options.editLockId);
		if (options.editClientId) headers.set("X-Edit-Client-Id", options.editClientId);
	}
	// P0-2: mark this as a page-scoped save (a page is open / a lease is expected) so the
	// backend's prod require-lease-header gate can REJECT a page save that omits the lease
	// header (an attacker/buggy displaced client otherwise dodges the lease check, and a
	// no-state-write takeover is invisible to CAS). Honest page edits always also carry
	// X-Edit-Lock-Id above; this marker stays set across a takeover so the gate still
	// fires for a displaced save attempt.
	if (options.pageScoped) {
		headers.set("X-Edit-Page-Scoped", "1");
	}
	const payload: Record<string, unknown> = { ...state };
	for (const key of REMOTE_OWNED_SAVE_KEYS) {
		delete payload[key];
	}
	const res = await apiFetch(`${BASE}/project/${projectId}/save`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	await handleResponse(res);
}

export async function uploadExportArtifact(
	projectId: string,
	runId: string,
	filename: string,
	artifact: Blob,
): Promise<{ artifact: ExportArtifact; exportRun?: ExportRun; storageQuota?: StorageQuotaSummary }> {
	const formData = new FormData();
	formData.append("filename", filename);
	formData.append("artifact", artifact, filename);
	const res = await apiFetch(`${BASE}/project/${projectId}/exports/${encodeURIComponent(runId)}/artifact`, {
		method: "POST",
		body: formData,
		timeoutMs: 120000,
	});
	return handleResponse(res);
}

export async function downloadExportArtifact(
	projectId: string,
	runId: string,
): Promise<{ blob: Blob; filename: string }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/exports/${encodeURIComponent(runId)}/artifact`, {
		timeoutMs: 120000,
	});
	if (!res.ok) {
		await handleResponse(res);
		throw new Error("Could not download export artifact");
	}
	const filename = parseContentDispositionFilename(res.headers.get("Content-Disposition")) || "chapter-export.zip";
	return {
		blob: await res.blob(),
		filename,
	};
}

export async function deleteExportArtifact(
	projectId: string,
	runId: string,
): Promise<{ ok: boolean; deleted?: boolean; exportRun?: ExportRun; storageQuota?: StorageQuotaSummary }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/exports/${encodeURIComponent(runId)}/artifact`, {
		method: "DELETE",
		timeoutMs: 120000,
	});
	return handleResponse(res);
}

export async function applyAiResultToPage(
	projectId: string,
	pageIndex: number,
	resultImageId: string,
): Promise<{
	page: ProjectState["pages"][number];
	pageIndex: number;
	activityLog?: ActivityEvent[];
	version?: ProjectVersion;
}> {
	const res = await apiFetch(`${BASE}/project/${projectId}/pages/${pageIndex}/ai-result`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ resultImageId }),
	});
	return handleResponse(res);
}

export interface ProjectImageAssetSummary {
	assetId: string;
	imageId: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	storageDriver: string;
	storageKey: string;
	width: number;
	height: number;
	storageStatus: string;
	moderationStatus: string;
	derivativeCount: number;
	/**
	 * Who/what produced this asset. `source === "ai_job"` marks an AI-generated
	 * image; everything else (human upload, system, anonymous) is an upload. The
	 * server includes this on the per-project asset listing serializer.
	 */
	uploadedBy?: { source?: "human" | "ai_job" | "system" | "anonymous" } & Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface StorageQuotaSummary {
	projectId: string;
	workspaceId: string;
	enforced: boolean;
	usedBytes: number;
	originalBytes: number;
	derivativeBytes: number;
	exportArtifactBytes: number;
	pendingBytes: number;
	includedBytes: number;
	extraBytes: number;
	limitBytes: number;
	remainingBytes: number;
	percentUsed: number;
	assetCount: number;
	derivativeCount: number;
	exportArtifactCount: number;
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
		purpose: string;
		requests: number;
		bytes: number;
	}>;
	byAsset: Array<{
		imageId: string;
		requests: number;
		bytes: number;
	}>;
}

export interface UploadImagesResult {
	imageIds: string[];
	assets?: ProjectImageAssetSummary[];
	usage?: WorkspaceUsageSummary;
	storageQuota?: StorageQuotaSummary;
}

/**
 * Upload chapter-page images. When `onProgress` is supplied AND XMLHttpRequest is
 * available (browser), the request runs over XHR so real upload-progress events
 * stream a 0..1 fraction — letting the dialog animate a live bar per batch.
 * Without `onProgress` (or in SSR/tests, where XHR is absent) it falls back to the
 * exact same fetch path as before, so the response shape and behavior are
 * unchanged. The 401-refresh transparency only applies to the fetch path; uploads
 * carry the current token and surface a normal error on the rare expiry.
 */
export async function uploadImages(
	projectId: string,
	files: File[],
	onProgress?: (fraction: number) => void,
	/**
	 * Optional per-upload asset metadata (Phase A non-destructive edits). When
	 * present it is sent as a `metadata` form field so the backend can tag the asset
	 * (e.g. `assetKind: "image-edit-mask"` for tiny bubble-clean mask ROIs). The
	 * upload route ignores unknown form fields, so this is safe/best-effort and never
	 * breaks the existing master-upload path.
	 */
	metadata?: Record<string, unknown>,
): Promise<UploadImagesResult> {
	const fd = new FormData();
	for (const f of files) fd.append("images", f);
	if (metadata && Object.keys(metadata).length > 0) fd.append("metadata", JSON.stringify(metadata));
	const url = `${BASE}/images/${projectId}/upload`;
	if (onProgress && typeof XMLHttpRequest !== "undefined") {
		return uploadImagesViaXhr(url, fd, onProgress);
	}
	const res = await apiFetch(url, { method: "POST", body: fd, timeoutMs: 120000 });
	return handleResponse(res);
}

const UPLOAD_XHR_TIMEOUT_MS = 120000;
// Server-side merge/split (sharp stitch/slice on a whole batch) can legitimately
// run longer than a plain upload, so the transform path gets a generous bound.
const UPLOAD_TRANSFORM_XHR_TIMEOUT_MS = 600000;

function uploadImagesViaXhr(
	url: string,
	body: FormData,
	onProgress: (fraction: number) => void,
	timeoutMs: number = UPLOAD_XHR_TIMEOUT_MS,
	extraHeaders?: Record<string, string>,
): Promise<UploadImagesResult> {
	return new Promise<UploadImagesResult>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", url, true);
		xhr.timeout = timeoutMs;
		// Mirror the fetch path's auth header. withApiAuthHeaders returns a Headers
		// (or the original init) — read the Authorization off a Headers view of it.
		const authHeaders = new Headers(withApiAuthHeaders(undefined));
		const authorization = authHeaders.get("Authorization");
		if (authorization) xhr.setRequestHeader("Authorization", authorization);
		// Extra request headers (e.g. the keep-mode batch Idempotency-Key) so a
		// lost-response retry of the SAME batch is de-duped server-side.
		if (extraHeaders) {
			for (const [name, value] of Object.entries(extraHeaders)) {
				if (value) xhr.setRequestHeader(name, value);
			}
		}
		xhr.responseType = "text";

		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) {
				onProgress(event.loaded / event.total);
			}
		};
		// Bytes are fully sent → flip to indeterminate-ish full while the server
		// processes (dedupe/moderation), so the bar doesn't appear stalled.
		xhr.upload.onload = () => onProgress(1);

		xhr.onload = () => {
			const rawBody = xhr.responseText ?? "";
			if (xhr.status >= 200 && xhr.status < 300) {
				if (!rawBody) {
					resolve(undefined as unknown as UploadImagesResult);
					return;
				}
				try {
					resolve(JSON.parse(rawBody) as UploadImagesResult);
				} catch {
					reject(new Error("Invalid JSON response from API"));
				}
				return;
			}
			reject(buildApiError(
				xhr.status,
				xhr.statusText,
				rawBody,
				xhr.getResponseHeader("Retry-After"),
			));
		};
		xhr.onerror = () => reject(new Error("Upload failed: network error"));
		xhr.ontimeout = () => reject(new Error("Request timed out or was cancelled"));
		xhr.send(body);
	});
}

export type BulkImportMode = "keep" | "merge" | "split";

export interface BulkImportTransformOptions {
	/** Source-file order to apply before transform (indices into `files`). */
	order?: number[];
	/** Images per stitched page when mode === "merge". */
	perPage?: number;
	/** Tall-image split threshold (px) when mode === "split". */
	splitThreshold?: number;
}

/**
 * Wave 3 W3.16: bulk import with server-side merge/split. Sends the ordered
 * source images plus the chosen transform to /upload-transform; the server
 * stitches (merge), slices (split), or passes through (keep), SHA-dedupes, and
 * returns the produced page imageIds + assets like a normal upload.
 */
export async function uploadImagesTransformed(
	projectId: string,
	files: File[],
	mode: BulkImportMode,
	options: BulkImportTransformOptions = {},
	/**
	 * When supplied AND XHR is available, the request streams real 0..1 upload-byte
	 * progress (so the bulk-import dialog can animate a live bar) and is NOT bounded
	 * by the old 180s fetch timeout — a large merge/split that legitimately takes
	 * longer than 3 minutes no longer fails spuriously. Without it (SSR/tests) it
	 * falls back to the same fetch path, with the timeout RAISED to 10 minutes so a
	 * non-browser caller of a big transform isn't killed at 180s either.
	 */
	onProgress?: (fraction: number) => void,
	/**
	 * Stable per-batch idempotency key (keep-mode only). Sent as `Idempotency-Key`.
	 * The backend commits the WHOLE batch before responding; if the response is lost
	 * (XHR onerror/ontimeout) the client retries the SAME batch with the SAME key, and
	 * the server replays the original committed result instead of re-committing —
	 * preventing duplicate/orphaned assets. Stable ACROSS retries of one batch.
	 */
	idempotencyKey?: string,
): Promise<UploadImagesResult> {
	const fd = new FormData();
	fd.append("mode", mode);
	for (const f of files) fd.append("images", f);
	if (options.order) fd.append("order", JSON.stringify(options.order));
	if (mode === "merge" && typeof options.perPage === "number") {
		fd.append("perPage", String(options.perPage));
	}
	if (mode === "split" && typeof options.splitThreshold === "number") {
		fd.append("splitThreshold", String(options.splitThreshold));
	}
	const url = `${BASE}/images/${projectId}/upload-transform`;
	const idempotencyHeaders = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
	if (onProgress && typeof XMLHttpRequest !== "undefined") {
		return uploadImagesViaXhr(url, fd, onProgress, UPLOAD_TRANSFORM_XHR_TIMEOUT_MS, idempotencyHeaders);
	}
	const res = await apiFetch(url, {
		method: "POST",
		body: fd,
		timeoutMs: UPLOAD_TRANSFORM_XHR_TIMEOUT_MS,
		headers: idempotencyHeaders,
	});
	return handleResponse(res);
}

/**
 * First-page-only asset listing for "recent files" surfaces (#14d): the server
 * returns assets newest-first, so one bounded page is the latest N — unlike
 * {@link listProjectImageAssets} which drains EVERY page (fine for a full
 * asset-browser, pathological for a panel on a 500-page chapter).
 */
export async function listRecentProjectImageAssets(
	projectId: string,
	limit = 12,
): Promise<ProjectImageAssetSummary[]> {
	const params = new URLSearchParams();
	params.set("limit", String(Math.max(1, Math.min(100, limit))));
	const res = await apiFetch(`${BASE}/images/${projectId}/assets?${params.toString()}`);
	const page = await handleResponse<{ assets: ProjectImageAssetSummary[] }>(res);
	return page.assets ?? [];
}

export async function listProjectImageAssets(projectId: string): Promise<{
	assets: ProjectImageAssetSummary[];
	storageQuota?: StorageQuotaSummary;
}> {
	const assets: ProjectImageAssetSummary[] = [];
	let storageQuota: StorageQuotaSummary | undefined;
	let cursor: string | undefined;
	do {
		const params = new URLSearchParams();
		if (cursor) params.set("cursor", cursor);
		const query = params.toString();
		const res = await apiFetch(`${BASE}/images/${projectId}/assets${query ? `?${query}` : ""}`);
		const page = await handleResponse<{
			assets: ProjectImageAssetSummary[];
			storageQuota?: StorageQuotaSummary;
			nextCursor?: string;
		}>(res);
		assets.push(...page.assets);
		storageQuota = page.storageQuota ?? storageQuota;
		cursor = page.nextCursor;
	} while (cursor);
	return { assets, storageQuota };
}

export async function getProjectStorageUsage(projectId: string): Promise<{ storageQuota: StorageQuotaSummary }> {
	const res = await apiFetch(`${BASE}/images/${projectId}/storage-usage`);
	return handleResponse(res);
}

// ── Workspace storage-management ("Asset Library") ───────────────────────────
//
// A workspace-scoped storage-housekeeping surface: list every asset across the
// workspace's projects with bytes + project + kind, per-project + workspace
// totals, drill-in + kind filters and biggest-first sort; then delete the ones
// you don't need (reference-safe). Backed by /api/storage.

export type StorageAssetKind = "uploaded" | "ai-generated";
export type StorageAssetSort = "size" | "recent" | "name";

export interface WorkspaceStorageAsset {
	assetId: string;
	imageId: string;
	projectId: string;
	projectName: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	derivativeBytes: number;
	width: number;
	height: number;
	kind: StorageAssetKind;
	storageStatus: string;
	moderationStatus: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceStorageProjectTotal {
	projectId: string;
	projectName: string;
	assetCount: number;
	originalBytes: number;
	derivativeBytes: number;
}

export interface WorkspaceStorageTotals {
	assetCount: number;
	originalBytes: number;
	derivativeBytes: number;
	totalBytes: number;
	projectCount: number;
}

export interface WorkspaceStorageListResult {
	workspaceId: string;
	sort: StorageAssetSort;
	kind: StorageAssetKind | null;
	projectId: string | null;
	assets: WorkspaceStorageAsset[];
	projects: WorkspaceStorageProjectTotal[];
	totals: WorkspaceStorageTotals;
}

export async function listWorkspaceStorageAssets(
	workspaceId: string,
	options: { projectId?: string; kind?: StorageAssetKind; sort?: StorageAssetSort } = {},
): Promise<WorkspaceStorageListResult> {
	const params = new URLSearchParams();
	if (options.projectId) params.set("projectId", options.projectId);
	if (options.kind) params.set("kind", options.kind);
	if (options.sort) params.set("sort", options.sort);
	const query = params.toString();
	const res = await apiFetch(`${BASE}/storage/workspaces/${encodeURIComponent(workspaceId)}/assets${query ? `?${query}` : ""}`);
	return handleResponse(res);
}

export interface DeleteStorageAssetResult {
	ok: boolean;
	projectId: string;
	imageId: string;
	freedBytes: number;
	objectDeleted: boolean;
	wasReferenced: boolean;
	referencedByPages: number[];
	/** Refreshed project storage quota after the delete (for space-used totals). */
	storageQuota?: StorageQuotaSummary;
}

/**
 * Delete one asset from storage + the registry, freeing the space. Reference-safe:
 * if the asset is still referenced by a live page the backend returns 409 (an
 * {@link ApiError} with code `asset_referenced` whose body carries
 * `referencedByPages`) UNLESS `force` is set — so the caller can warn first.
 */
export async function deleteWorkspaceStorageAsset(
	projectId: string,
	imageId: string,
	options: { force?: boolean } = {},
): Promise<DeleteStorageAssetResult> {
	const query = options.force ? "?force=true" : "";
	const res = await apiFetch(`${BASE}/storage/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(imageId)}${query}`, {
		method: "DELETE",
	});
	return handleResponse(res);
}

export async function getProjectEgressUsage(projectId: string): Promise<{ egress: ProjectEgressSummary }> {
	const res = await apiFetch(`${BASE}/images/${projectId}/egress-usage`);
	return handleResponse(res);
}

export interface UsageWindowSummary {
	periodKey: string;
	aiCapturedThb: number;
	aiActiveReservedThb: number;
	aiCommittedThb: number;
	uploadBytes: number;
	exportBytes: number;
	moderationImages: number;
	limits: {
		aiCreditThb: number;
		uploadBytes: number;
		exportBytes: number;
	};
	remaining: {
		aiCreditThb: number | null;
		uploadBytes: number | null;
		exportBytes: number | null;
	};
	percentUsed: {
		aiCredit: number | null;
		uploadBytes: number | null;
		exportBytes: number | null;
	};
}

export interface WorkspaceUsageSummary {
	workspaceId: string;
	projectId: string;
	planId: string;
	enforced: boolean;
	daily: UsageWindowSummary;
	monthly: UsageWindowSummary;
	eventCount: number;
	// True iff eventCount hit the server-side display cap (WORKSPACE_EVENT_COUNT_CAP):
	// the value is a floor, so render it as "100000+" rather than an exact "100000".
	eventCountCapped: boolean;
}

export interface ExportUsageInput {
	bytes: number;
	pageIndexes?: number[];
	pageCount?: number;
	filename?: string;
	exportKind?: "single-page" | "batch-zip";
	targetProfile?: ExportProfileId;
	idempotencyKey?: string;
	// The export run this record bills for — lets the server bill the run's real
	// artifact size (run-scoped accounting) instead of clamping to the largest
	// artifact in the project.
	exportRunId?: string;
	metadata?: Record<string, unknown>;
}

export async function getProjectUsage(projectId: string): Promise<{ usage: WorkspaceUsageSummary }> {
	const res = await apiFetch(`${BASE}/usage/${projectId}`);
	return handleResponse(res);
}

export async function recordExportUsage(projectId: string, input: ExportUsageInput): Promise<{
	ok: boolean;
	eventId: string;
	usage: WorkspaceUsageSummary;
}> {
	const res = await apiFetch(`${BASE}/usage/${projectId}/export`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export function imageUrl(projectId: string, imageId: string): string {
	return `${BASE}/images/${projectId}/${imageId}`;
}

// True when `url` points at our backend API and therefore must carry the auth
// header. Covers both the proxied default ("/api/...") and an explicit absolute
// VITE_API_BASE. Network requests issued by Fabric (`FabricImage.fromURL`) do not
// attach the Authorization header, so persisted-asset GETs would 401; callers
// route these through `fetchAuthedObjectUrl` instead.
export function isApiAssetUrl(url: string): boolean {
	if (!url) return false;
	if (url.startsWith("data:") || url.startsWith("blob:")) return false;
	if (url.startsWith(`${BASE}/`) || url === BASE) return true;
	// Absolute URL whose path begins with the API base (e.g. when BASE is "/api").
	if (BASE.startsWith("/")) {
		try {
			const parsed = new URL(url, typeof location !== "undefined" ? location.href : undefined);
			return parsed.pathname === BASE || parsed.pathname.startsWith(`${BASE}/`);
		} catch {
			return false;
		}
	}
	return false;
}

// Fetch an authenticated asset (e.g. `/api/images/:projectId/:imageId`) using the
// stored access token and return a same-origin `blob:` object URL. The blob URL is
// untainted, so a canvas that draws it can still call `toDataURL()` for export.
// Callers MUST revoke the returned URL (URL.revokeObjectURL) once the image has
// loaded to avoid leaking object URLs.
export async function fetchAuthedObjectUrl(url: string, init: RequestOptions = {}): Promise<string> {
	return (await fetchAuthedObjectUrlWithBlob(url, init)).objectUrl;
}

// Same as `fetchAuthedObjectUrl` but also returns the underlying `Blob`, so the
// caller can read the real delivered byte size (e.g. to meter a single-page
// export of a persisted asset). The caller MUST revoke `objectUrl`.
export async function fetchAuthedObjectUrlWithBlob(
	url: string,
	init: RequestOptions = {},
): Promise<{ objectUrl: string; blob: Blob }> {
	const res = await apiFetch(url, init);
	if (!res.ok) {
		await handleResponse(res);
		throw new Error(`Could not load image (${res.status})`);
	}
	const blob = await res.blob();
	return { objectUrl: URL.createObjectURL(blob), blob };
}

// Minimal shape of the Fabric image factory we depend on, so this module never
// has to statically import `fabric` (kept lazy / out of the API client bundle).
interface FabricImageNamespace {
	FabricImage: { fromURL(url: string, options?: Record<string, unknown>): Promise<unknown> };
}

// Load a URL into a Fabric image, attaching auth for backend asset URLs. Backend
// asset URLs (`/api/images/...`) need the Authorization header, which Fabric's
// own `FabricImage.fromURL` does NOT attach — so a persisted asset loaded that
// way would 401 and never render (and, for a remote origin, taint the canvas so
// `toDataURL()` export throws). For those URLs we fetch the bytes with the
// access token, wrap them in a same-origin `blob:` object URL (untainted), load
// that, then revoke it. blob:/data: URLs pass straight through unchanged. Used
// by both the live editor and the batch/page export compositor so the two paths
// stay consistent.
export async function loadAuthedFabricImage(
	fabric: FabricImageNamespace,
	url: string,
	options?: Record<string, unknown>,
): Promise<unknown> {
	if (!isApiAssetUrl(url)) {
		return fabric.FabricImage.fromURL(url, options);
	}
	const objectUrl = await fetchAuthedObjectUrl(url);
	try {
		return await fabric.FabricImage.fromURL(objectUrl, options);
	} finally {
		try {
			URL.revokeObjectURL(objectUrl);
		} catch {
			// ignore — environments without URL.revokeObjectURL (tests)
		}
	}
}

/**
 * Raised when an EXPORT-purpose asset fetch cannot obtain an `export`-scoped signed
 * token for an API asset. The export render path FAILS CLOSED in this case rather
 * than falling back to the editor_preview (Bearer-header) load: the server's
 * export-purpose serve gate (moderation must be `passed`) is the authoritative
 * content-safety check, so an asset that cannot mint an export token (it is
 * `needs_review` / `quarantined` / `blocked` / has no passing record) MUST NOT be
 * fetchable for an export render. Letting it through editor_preview would put a
 * non-`passed` asset into a client-built ZIP/single-page export — the exact
 * CSAM-export hole codex flagged (P1-A).
 */
export class ExportAssetNotAuthorizedError extends Error {
	readonly projectId: string;
	readonly imageId: string;
	constructor(projectId: string, imageId: string) {
		super(`Asset ${projectId}/${imageId} is not authorized for export`);
		this.name = "ExportAssetNotAuthorizedError";
		this.projectId = projectId;
		this.imageId = imageId;
	}
}

/**
 * Load a URL into a Fabric image for an EXPORT render, with the SERVER as the
 * authoritative content-safety gate (codex P1-A).
 *
 * For a backend asset URL this mints an `export`-purpose signed token and fetches
 * the bytes THROUGH it, so the server's image serve gate runs the STRICTER export
 * bar (moderation must be `passed`; a `needs_review` / `quarantined` / `blocked`
 * asset, or one with no passing asset record, is denied). The client-side export
 * gate stays in place for fast feedback (defense-in-depth), but THIS is the real
 * enforcement: a non-`passed` asset cannot be fetched for an export render, so it
 * cannot enter a client-built ZIP / single-page export.
 *
 * FAIL-CLOSED: if an `export` token cannot be minted for an API asset (the access
 * token route 401/403s for a non-`passed` asset, or the asset has no passing
 * record), this THROWS {@link ExportAssetNotAuthorizedError} instead of falling
 * back to the editor_preview (Bearer) load — never letting a non-`passed` asset
 * slip into an export. Non-API URLs (local blob:/data: previews, test resolver
 * URLs) pass straight through unchanged.
 */
export async function loadExportFabricImage(
	fabric: FabricImageNamespace,
	projectId: string,
	imageId: string,
	url: string,
	options?: Record<string, unknown>,
): Promise<unknown> {
	// Local previews / non-backend URLs are not gated by the server (there is no
	// server asset to fetch); render them as-is.
	if (!isApiAssetUrl(url)) {
		return fabric.FabricImage.fromURL(url, options);
	}
	// Mint an EXPORT-purpose token. The access-token route only issues one for an
	// export-ready (`passed`) asset, so a successful mint already proves the asset
	// cleared the export bar server-side. forceRefresh so a stale editor_preview-era
	// cache entry can't shadow a now-revoked export grant.
	const signedUrl = await signedAssetUrl(url, projectId, imageId, "export");
	// signedAssetUrl returns the URL UNCHANGED when no token could be minted. For an
	// API asset that means the export grant was denied — fail closed (do NOT fetch via
	// the Bearer editor_preview path, which would bypass the export gate).
	if (signedUrl === url) {
		throw new ExportAssetNotAuthorizedError(projectId, imageId);
	}
	const objectUrl = await fetchAuthedObjectUrl(signedUrl);
	try {
		return await fabric.FabricImage.fromURL(objectUrl, options);
	} finally {
		try {
			URL.revokeObjectURL(objectUrl);
		} catch {
			// ignore — environments without URL.revokeObjectURL (tests)
		}
	}
}

export type ThumbnailFit = "cover" | "inside";

export function thumbnailUrl(
	projectId: string,
	imageId: string,
	width = 192,
	height = 288,
	fit: ThumbnailFit = "cover",
): string {
	const params = new URLSearchParams({
		width: String(width),
		height: String(height),
	});
	// `inside` requests the uncropped, aspect-preserving downscale (webtoon strip
	// preview); default `cover` is the small fixed-aspect card thumbnail.
	if (fit === "inside") params.set("fit", "inside");
	return `${BASE}/images/${projectId}/${imageId}/thumbnail?${params.toString()}`;
}

// Build params for a column-width, RETINA-crisp, UNCROPPED webtoon strip preview.
// Returns a `thumbnail`-purpose signed-asset descriptor whose URL is the lightweight
// `fit=inside` derivative (~150-250KB WebP) instead of the multi-MB full editor_preview
// image — the strip mounts several of these while scrolling, so the size/decode saving
// is what keeps a heavy real-manga chapter smooth. `columnWidthCss` is the rendered
// CSS column width; we scale by devicePixelRatio (capped) so retina stays sharp.
export const STRIP_PREVIEW_MAX_WIDTH = 1600;

export function stripPreviewThumbnailUrl(projectId: string, imageId: string, columnWidthCss: number): string {
	const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
	const cssWidth = columnWidthCss > 0 ? columnWidthCss : 900;
	// Round up to a few stable buckets so we don't mint a unique derivative per pixel
	// of column width (which would defeat caching as the panel resizes).
	const target = Math.min(STRIP_PREVIEW_MAX_WIDTH, Math.ceil((cssWidth * Math.min(dpr, 2)) / 100) * 100);
	const width = Math.max(200, target);
	// Height max is just a safety ceiling for `inside`; pass a tall bound so webtoon
	// pages keep full aspect (the backend clamps to its own inside max).
	return thumbnailUrl(projectId, imageId, width, width * 4, "inside");
}

// ── Signed asset tokens for browser <img src> ───────────────────────────────
//
// A browser `<img src>` (covers, page-navigator thumbnails, layer/asset
// previews) cannot attach an `Authorization: Bearer` header, so a bare
// `/api/images/.../thumbnail` URL 401s for an owned project. The backend mints
// short-lived, HMAC-signed asset tokens scoped to (projectId, imageId, purpose)
// via the authed `GET /images/:projectId/:imageId/access-token` route; a
// `?assetToken=` query param then authorizes the `<img>` load without a header.
//
// We cache tokens per (projectId, imageId, purpose) and reuse them until shortly
// before expiry so a thumbnail grid mints O(unique images) tokens, not one per
// cell per render. In-flight mints are de-duplicated so a burst of identical
// requests issues a single network call.

export type AssetAccessPurpose = "thumbnail" | "original" | "editor_preview" | "export" | "ai_output";

interface AssetAccessTokenResponse {
	token: string;
	purpose: AssetAccessPurpose;
	expiresAt?: string;
	signedPath?: string;
	signedUrl?: string;
	signedCdnUrl?: string;
}

interface CachedAssetToken {
	token: string;
	// epoch ms after which we proactively re-mint (slightly before real expiry)
	refreshAfter: number;
}

const assetTokenCache = new Map<string, CachedAssetToken>();
const assetTokenInflight = new Map<string, Promise<string | null>>();
// Per-mint identity sentinels paralleling assetTokenInflight. The mint's finally
// block matches against its own sentinel (not the promise object) so it only
// retracts its OWN inflight entry — never a newer mint that re-registered the
// same key after a cache clear.
const assetTokenInflightTags = new Map<string, symbol>();
// Monotonic cache "generation" / epoch. Bumped by clearAssetTokenCache() on
// every login / account switch / logout. An in-flight mint started under one
// identity captures the generation BEFORE its await; if a clear bumps the
// generation while the mint is pending, the resolved token is NOT persisted to
// the (now different-identity) cache — closing the race where user A's pending
// mint repopulates the cache after a switch to user B and leaks A's signed
// token to a later B lookup.
let assetTokenCacheGeneration = 0;

// Re-mint this many ms before the token's real expiry so an in-flight <img>
// load never races a token that expires mid-request.
const ASSET_TOKEN_RENEW_SKEW_MS = 30_000;
// Fallback lifetime when the backend omits expiresAt (defensive; the route
// always returns it). Kept short so a stale token cannot linger.
const ASSET_TOKEN_FALLBACK_TTL_MS = 120_000;
// Hard cap on cached tokens so a long-lived SPA session browsing many assets
// cannot grow the cache without bound. Map preserves insertion order, so the
// oldest (least-recently-inserted) entry is evicted first when over cap.
const ASSET_TOKEN_CACHE_MAX = 256;

function assetTokenCacheKey(projectId: string, imageId: string, purpose: AssetAccessPurpose): string {
	return `${projectId} ${imageId} ${purpose}`;
}

// Clear all cached + inflight signed asset tokens. Declared as a function
// declaration (not a const arrow) so it hoists above setApiAccessToken /
// clearApiAccessToken, which call it when the bearer identity changes.
function clearAssetTokenCache(): void {
	assetTokenCache.clear();
	assetTokenInflight.clear();
	assetTokenInflightTags.clear();
	// Bump the generation so any mint currently awaiting the network (started
	// under the previous identity) sees a changed generation when it resolves
	// and refuses to write its token back into the now-cleared cache.
	assetTokenCacheGeneration++;
}

// Insert/refresh a cache entry with an LRU-ish bound: sweep expired entries
// opportunistically, then evict the oldest entry while over the cap. Deleting
// the key before set keeps Map insertion order == recency on re-insert.
function setAssetTokenCacheEntry(key: string, entry: CachedAssetToken): void {
	const now = Date.now();
	for (const [existingKey, existing] of assetTokenCache) {
		if (existing.refreshAfter <= now) assetTokenCache.delete(existingKey);
	}
	assetTokenCache.delete(key);
	assetTokenCache.set(key, entry);
	while (assetTokenCache.size > ASSET_TOKEN_CACHE_MAX) {
		const oldest = assetTokenCache.keys().next().value;
		if (oldest === undefined) break;
		assetTokenCache.delete(oldest);
	}
}

// Resolve a (cached) signed asset token for the given asset+purpose. Returns
// null when minting fails (e.g. not the owner, asset not servable) so callers
// can fall back to their placeholder. `forceRefresh` bypasses the cache (used
// when a signed <img> load 401s because its token expired).
export async function getAssetAccessToken(
	projectId: string,
	imageId: string,
	purpose: AssetAccessPurpose = "thumbnail",
	forceRefresh = false,
): Promise<string | null> {
	if (!projectId || !imageId) return null;
	const key = assetTokenCacheKey(projectId, imageId, purpose);

	if (!forceRefresh) {
		const cached = assetTokenCache.get(key);
		if (cached && cached.refreshAfter > Date.now()) {
			// LRU-on-hit: bump recency so a frequently-read old entry survives
			// cap-pressure eviction (Map insertion order == recency).
			assetTokenCache.delete(key);
			assetTokenCache.set(key, cached);
			return cached.token;
		}
		const inflight = assetTokenInflight.get(key);
		if (inflight) return inflight;
	} else {
		assetTokenCache.delete(key);
	}

	// Capture the cache generation BEFORE awaiting the network. If a login /
	// account switch / logout clears the cache (bumping the generation) while
	// this mint is pending, we must NOT write the resolved token back into the
	// new-identity cache. This caller still gets its own freshly-minted token
	// (so A's own in-flight call resolves), but the token is never persisted
	// for a later (user-B) lookup — closing the cross-identity leak.
	const generation = assetTokenCacheGeneration;
	// Unique sentinel for THIS mint. The finally block retracts our inflight entry
	// only if the map still holds this exact sentinel — comparing against a stable
	// token (not the promise itself) keeps TS's control-flow analysis happy while
	// preserving the "don't clobber a newer B mint" guarantee.
	const inflightTag = Symbol("asset-token-inflight");
	const request = (async (): Promise<string | null> => {
		try {
			const params = new URLSearchParams({ purpose });
			const res = await apiFetch(
				`${BASE}/images/${projectId}/${imageId}/access-token?${params.toString()}`,
			);
			if (!res.ok) return null;
			const body = (await res.json()) as AssetAccessTokenResponse;
			if (!body?.token) return null;
			// Drop the cache write entirely if the identity changed mid-mint.
			if (generation === assetTokenCacheGeneration) {
				const expiryMs = body.expiresAt ? Date.parse(body.expiresAt) : NaN;
				const refreshAfter = Number.isFinite(expiryMs)
					? expiryMs - ASSET_TOKEN_RENEW_SKEW_MS
					: Date.now() + ASSET_TOKEN_FALLBACK_TTL_MS;
				setAssetTokenCacheEntry(key, { token: body.token, refreshAfter });
			}
			return body.token;
		} catch {
			return null;
		} finally {
			// Only retract OUR inflight entry, and only if no clear happened
			// since we started: a clear already emptied the map (and may have
			// let a newer B mint register the same key), so blindly deleting
			// here could clobber B's fresh inflight promise. If the generation
			// changed, the clear already cleaned up — skipping is safe and
			// cannot leak (the map was emptied). We match on the per-mint sentinel
			// stored alongside the inflight promise.
			if (
				generation === assetTokenCacheGeneration &&
				assetTokenInflightTags.get(key) === inflightTag
			) {
				assetTokenInflight.delete(key);
				assetTokenInflightTags.delete(key);
			}
		}
	})();

	assetTokenInflight.set(key, request);
	assetTokenInflightTags.set(key, inflightTag);
	return request;
}

// Append a freshly-resolved `assetToken` to a bare API asset URL so a browser
// `<img src>` can load it without an Authorization header. Returns the original
// URL unchanged when no token can be minted (the route 401s → onerror fallback
// fires the component's placeholder, same as before).
export async function signedAssetUrl(
	url: string,
	projectId: string,
	imageId: string,
	purpose: AssetAccessPurpose,
	forceRefresh = false,
): Promise<string> {
	// Local blob:/data: previews and non-API URLs need no token — return as-is.
	if (!isApiAssetUrl(url)) return url;
	const token = await getAssetAccessToken(projectId, imageId, purpose, forceRefresh);
	if (!token) return url;
	const separator = url.includes("?") ? "&" : "?";
	return `${url}${separator}assetToken=${encodeURIComponent(token)}`;
}

// Resolve a signed thumbnail `<img src>` for the given asset.
export function signedThumbnailUrl(
	projectId: string,
	imageId: string,
	width = 192,
	height = 288,
	forceRefresh = false,
): Promise<string> {
	return signedAssetUrl(thumbnailUrl(projectId, imageId, width, height), projectId, imageId, "thumbnail", forceRefresh);
}

// Signed, UNCROPPED (fit=inside, #251) downscaled thumbnail for the storage
// library grid: aspect-preserving so portrait manga pages aren't cropped, and a
// lightweight derivative (not the multi-MB original) so a wall of thumbnails
// stays smooth. `height` is just a tall safety ceiling for `inside`.
export function signedInsideThumbnailUrl(
	projectId: string,
	imageId: string,
	width = 320,
	forceRefresh = false,
): Promise<string> {
	return signedAssetUrl(thumbnailUrl(projectId, imageId, width, width * 4, "inside"), projectId, imageId, "thumbnail", forceRefresh);
}

// Resolve a signed full-image `<img src>` (cover/preview that renders via a
// plain <img>, not the editor's authed blob path). Defaults to editor_preview
// scope, which the image route accepts alongside original/export/ai_output.
export function signedImageUrl(
	projectId: string,
	imageId: string,
	purpose: AssetAccessPurpose = "editor_preview",
	forceRefresh = false,
): Promise<string> {
	return signedAssetUrl(imageUrl(projectId, imageId), projectId, imageId, purpose, forceRefresh);
}

// Drop a cached token (e.g. after a signed <img> still 401s) so the next render
// re-mints. Used by the signedAsset Svelte action's onerror path.
export function invalidateAssetToken(projectId: string, imageId: string, purpose: AssetAccessPurpose): void {
	assetTokenCache.delete(assetTokenCacheKey(projectId, imageId, purpose));
}

// Test-only: clear the whole token cache between cases.
export function __clearAssetTokenCacheForTests(): void {
	clearAssetTokenCache();
}

export interface AiJobSubmissionResult {
	jobId: string;
	// The internal system/template prompt is NO LONGER returned by the backend
	// (leak-safe — it must never reach the client). Optional purely for back-compat
	// with any cached/in-flight response shape; new responses omit it. Never display
	// or persist it.
	prompt?: string;
	tier?: "budget-clean" | "clean-pro" | "sfx-pro";
	costEstimate?: {
		tier: "budget-clean" | "clean-pro" | "sfx-pro";
		providerHint: string;
		currency: "THB";
		/** Quality-flat user-facing credit cost of the op (Low=1, Medium=9, High=36). */
		creditUnits?: number;
		quality?: "low" | "medium" | "high";
		outputSize?: string;
		megapixels: number;
		estimatedThb: number;
		reserveThb: number;
		pricingVersion: string;
	};
	creditReservation?: {
		status: "reserved" | "captured" | "released";
		amountThb: number;
		currency: "THB";
		createdAt: number;
		settledAt?: number;
		reason?: string;
	};
}

export async function submitAiJob(opts: {
	projectId: string;
	imageId: string;
	crop: { x: number; y: number; w: number; h: number };
	lang: string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	tier?: "budget-clean" | "clean-pro" | "sfx-pro";
	quality?: "low" | "medium" | "high";
	idempotencyKey?: string;
}): Promise<AiJobSubmissionResult> {
	const { idempotencyKey, ...payload } = opts;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Project-Id": opts.projectId,
		"X-AI-Tier": opts.tier ?? "sfx-pro",
	};
	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}
	const res = await apiFetch(`${BASE}/ai/translate`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	const result = await handleResponse<AiJobSubmissionResult & { error?: string; code?: string; reason?: string }>(res);
	if (!result?.jobId) {
		throw new ApiError(result?.error || "AI job was not queued", {
			status: res.status,
			statusText: res.statusText,
			code: result?.code,
			body: result,
		});
	}
	return result;
}

export async function getAiStatus(jobId: string): Promise<{
	status: string;
	tier?: "budget-clean" | "clean-pro" | "sfx-pro";
	costEstimate?: AiJobSubmissionResult["costEstimate"];
	creditReservation?: AiJobSubmissionResult["creditReservation"];
	resultImageId?: string;
	error?: string;
}> {
	const res = await apiFetch(`${BASE}/ai/status/${jobId}`, { timeoutMs: 15000 });
	return handleResponse(res);
}

export async function cancelAiJob(jobId: string): Promise<{
	ok: boolean;
	status: string;
	tier?: "budget-clean" | "clean-pro" | "sfx-pro";
	costEstimate?: AiJobSubmissionResult["costEstimate"];
	creditReservation?: AiJobSubmissionResult["creditReservation"];
	error?: string;
}> {
	const res = await apiFetch(`${BASE}/ai/status/${jobId}/cancel`, {
		method: "POST",
		timeoutMs: 15000,
	});
	return handleResponse(res);
}

export interface AiTierCapability {
	id: AiTier;
	label: string;
	provider: string;
	quality?: "low" | "medium" | "high";
	available: boolean;
	reason: string | null;
	detail: string;
}

export interface AiCapabilitiesPlan {
	scope: "project";
	projectId?: string;
	id: string;
	name: string;
	/** Qualities the workspace plan permits (free = ["low"], studio = all three). */
	allowedAiQualities: ("low" | "medium" | "high")[];
}

export async function getAiCapabilities(options: { projectId?: string; lang?: string; quality?: "low" | "medium" | "high" } = {}): Promise<{ planScoped?: boolean; plan?: AiCapabilitiesPlan | null; tiers: AiTierCapability[] }> {
	const params = new URLSearchParams();
	if (options.projectId) params.set("projectId", options.projectId);
	if (options.lang) params.set("lang", options.lang);
	// Send the SELECTED quality so the tier availability/lock the panel renders
	// matches the quality generate will actually charge (no 402 surprise).
	if (options.quality) params.set("quality", options.quality);
	const query = params.toString();
	const res = await apiFetch(`${BASE}/ai/capabilities${query ? `?${query}` : ""}`, { timeoutMs: 10000 });
	return handleResponse(res);
}

export interface TranslationImportPayload {
	version?: number;
	/**
	 * Target Language Track the import materializes into (Stream C). Omitted /
	 * default-lang imports write the flat `page.textLayers`; a non-default lang
	 * writes `languageOutputs[lang]` so the translation lands on its own track.
	 */
	lang?: string;
	pageIndex?: number;
	targetPageIndex?: number;
	sourcePageIndex?: number;
	sourcePageNumber?: number;
	sourcePage?: number;
	sourceImagePath?: string;
	sourceImageName?: string;
	sourceFileName?: string;
	image_path?: string;
	mappings?: Array<{
		targetPageIndex: number;
		sourcePageIndex?: number;
		sourcePageNumber?: number;
		sourceImagePath?: string;
		sourceImageName?: string;
		sourceFileName?: string;
	}>;
	entries?: any[];
	items?: any[];
}

export interface TranslationImportResult {
	imported: number;
	skipped?: number;
	skippedByReason?: Record<string, number>;
	orderMapped?: number;
	orderMappedPaths?: string[];
	sourceFiltered?: number;
	sourceMapped?: {
		targetPageIndex: number;
		sourcePageIndex?: number;
		sourcePageNumber?: number;
		sourceImage?: string;
		ignoredEntries: number;
	};
	sourceMappings?: Array<{
		targetPageIndex: number;
		sourcePageIndex?: number;
		sourcePageNumber?: number;
		sourceImage?: string;
		ignoredEntries: number;
		imported: number;
	}>;
	pages?: Array<{
		pageIndex: number;
		imageId: string;
		imageName: string;
		originalName?: string;
		imported: number;
	}>;
	version?: ProjectVersion;
}

export interface ProjectVersion {
	versionId: string;
	projectId: string;
	name: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	source: "save" | "import-json" | "restore" | "manual";
	/** User-supplied label for a named ("manual") snapshot. */
	label?: string;
	/** Identity of the author who created this version. */
	author?: string;
	createdAt: string;
	pageCount: number;
	textLayerCount: number;
	stateHash?: string;
}

export interface ProjectVersionStateSummary {
	name: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	pageCount: number;
	textLayerCount: number;
	pages: Array<{
		pageIndex: number;
		imageId: string;
		imageName: string;
		originalName?: string;
		textLayerCount: number;
	}>;
}

export interface ProjectVersionDetail {
	version: ProjectVersion;
	diff: {
		current: ProjectVersionStateSummary;
		snapshot: ProjectVersionStateSummary;
		pageDelta: number;
		textLayerDelta: number;
		changedPages: Array<{
			pageIndex: number;
			label: string;
			currentTextLayerCount: number;
			snapshotTextLayerCount: number;
		}>;
		changedPageCount: number;
	};
	reviews: VersionReviewRequest[];
}

// W3.9: visual diff between two arbitrary versions of the same project.
export type VersionLayerKind = "text" | "image";
export type VersionLayerChangeType = "added" | "removed" | "moved" | "edited" | "restyled";

export interface VersionLayerDiff {
	layerId: string;
	kind: VersionLayerKind;
	name?: string;
	changes: VersionLayerChangeType[];
	textBefore?: string;
	textAfter?: string;
}

export interface VersionPageDiff {
	pageIndex: number;
	label: string;
	status: "added" | "removed" | "changed" | "unchanged";
	baseImageId?: string;
	targetImageId?: string;
	imageChanged: boolean;
	baseTextLayerCount: number;
	targetTextLayerCount: number;
	baseImageLayerCount: number;
	targetImageLayerCount: number;
	/** Phase C — non-destructive edit-layer counts (bubble-clean/brush/heal/clone). */
	baseEditLayerCount?: number;
	targetEditLayerCount?: number;
	layers: VersionLayerDiff[];
}

export interface VersionDiffStateSummary {
	name: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	pageCount: number;
	textLayerCount: number;
	/** Phase C — total non-destructive image edits across the project. */
	editLayerCount?: number;
	pages: Array<{
		pageIndex: number;
		imageId: string;
		imageName: string;
		originalName?: string;
		textLayerCount: number;
		imageLayerCount: number;
		editLayerCount?: number;
	}>;
}

export interface VersionComparison {
	baseVersion: ProjectVersion | null;
	targetVersion: ProjectVersion;
	diff: {
		base: VersionDiffStateSummary;
		target: VersionDiffStateSummary;
		pageDelta: number;
		textLayerDelta: number;
		imageLayerDelta: number;
		/** Phase C — target − base count of non-destructive image edits. */
		editLayerDelta?: number;
		addedPageCount: number;
		removedPageCount: number;
		changedPageCount: number;
		pages: VersionPageDiff[];
	};
}

export interface VersionRestoreScope {
	pageIndex?: number;
	layerId?: string;
}

export interface VersionRestoreResult {
	ok: boolean;
	restoredVersionId: string;
	scope: "project" | "page" | "layer";
	restoredPageIndex?: number;
	restoredLayerId?: string;
	restoredLayerKind?: VersionLayerKind;
}

export interface VersionReviewCreateInput {
	body?: string;
}

export interface VersionReviewUpdateInput {
	status: VersionReviewStatus;
	body?: string;
}

export async function importTranslations(
	projectId: string,
	payloadOrEntries: TranslationImportPayload | any[]
): Promise<TranslationImportResult> {
	const payload = Array.isArray(payloadOrEntries) ? { entries: payloadOrEntries } : payloadOrEntries;
	const res = await apiFetch(`${BASE}/project/${projectId}/import-json`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return handleResponse(res);
}

export async function getProjectVersions(projectId: string): Promise<{ versions: ProjectVersion[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/versions`);
	return handleResponse(res);
}

export async function createNamedProjectVersion(
	projectId: string,
	label: string,
): Promise<{ version: ProjectVersion }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/versions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ label }),
	});
	return handleResponse(res);
}

export async function getProjectVersionDetail(projectId: string, versionId: string): Promise<ProjectVersionDetail> {
	const res = await apiFetch(`${BASE}/project/${projectId}/versions/${versionId}`);
	return handleResponse(res);
}

/**
 * W3.9: compare two snapshots of a project. `targetVersionId` is required;
 * omit `baseVersionId` to diff the target against the live current state.
 */
export async function compareProjectVersions(
	projectId: string,
	targetVersionId: string,
	baseVersionId?: string,
): Promise<VersionComparison> {
	const params = new URLSearchParams({ target: targetVersionId });
	if (baseVersionId) params.set("base", baseVersionId);
	const res = await apiFetch(`${BASE}/project/${projectId}/versions/compare?${params.toString()}`);
	return handleResponse(res);
}

export async function createVersionReview(
	projectId: string,
	versionId: string,
	input: VersionReviewCreateInput
): Promise<{
	review: VersionReviewRequest;
	reviews: VersionReviewRequest[];
	activityLog: ActivityEvent[];
	items: WorkspaceFeedItem[];
	version?: ProjectVersion;
}> {
	// P1-3: send the CAS baseline header + retry-on-conflict (the server now wraps this
	// route in commitProjectStateWithCas and, in prod, REQUIRES the baseline header).
	return mutateWithProjectCas<{
		review: VersionReviewRequest;
		reviews: VersionReviewRequest[];
		activityLog: ActivityEvent[];
		items: WorkspaceFeedItem[];
		version?: ProjectVersion;
	}>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/versions/${versionId}/reviews`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function updateVersionReview(
	projectId: string,
	versionId: string,
	reviewId: string,
	input: VersionReviewUpdateInput
): Promise<{
	review: VersionReviewRequest;
	reviews: VersionReviewRequest[];
	activityLog: ActivityEvent[];
	items: WorkspaceFeedItem[];
	version?: ProjectVersion;
}> {
	// P1-3: send the CAS baseline header + retry-on-conflict (see createVersionReview).
	return mutateWithProjectCas<{
		review: VersionReviewRequest;
		reviews: VersionReviewRequest[];
		activityLog: ActivityEvent[];
		items: WorkspaceFeedItem[];
		version?: ProjectVersion;
	}>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/versions/${versionId}/reviews/${reviewId}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function getProjectWorkflow(projectId: string): Promise<{ tasks: WorkflowTask[]; activityLog: ActivityEvent[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/workflow`);
	return handleResponse(res);
}

export interface WorkflowTaskUpdate {
	status?: WorkflowTaskStatus;
	assignee?: string | null;
	priority?: WorkflowTaskPriority;
	dueAt?: string | null;
}

export interface WorkflowTaskBulkUpdate extends WorkflowTaskUpdate {
	taskIds: string[];
}

export async function updateProjectTask(
	projectId: string,
	taskId: string,
	update: WorkflowTaskUpdate
): Promise<{ task: WorkflowTask; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(update),
		}),
		handleResponse,
	);
}

export async function bulkUpdateProjectTasks(
	projectId: string,
	update: WorkflowTaskBulkUpdate
): Promise<{
	tasks: WorkflowTask[];
	activityLog: ActivityEvent[];
	changedCount: number;
	missingTaskIds: string[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/tasks/bulk`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(update),
		}),
		handleResponse,
	);
}

export async function updateTaskStatus(
	projectId: string,
	taskId: string,
	status: WorkflowTaskStatus,
	assignee?: string
): Promise<{ task: WorkflowTask; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	return updateProjectTask(projectId, taskId, { status, assignee });
}

// ── Soft presence (Collab v1) ───────────────────────────────────
// Best-effort "X is editing" signal — informational only, never blocks editing.
// Backed by an in-memory TTL store on the server (works in file-mode, no DB).

export type PresenceScope = "page" | "task";

// Identity-minimal by design: the server exposes only a non-PII display handle
// for someone who is present, never their raw userId/email (see the backend
// presence service). The badge renders `name` + a count, nothing else.
export interface PresenceEntry {
	name: string;
	scope: PresenceScope;
	scopeId: string;
	ageSec: number;
}

export interface PresenceHeartbeatInput {
	projectId: string;
	scope: PresenceScope;
	scopeId: string;
	/** File-mode / simulated identity. Ignored by the server when a JWT is present. */
	userId?: string;
	name?: string;
}

export async function sendPresenceHeartbeat(
	input: PresenceHeartbeatInput
): Promise<{ ok: boolean; lastSeen: number; others: PresenceEntry[] }> {
	const res = await apiFetch(`${BASE}/presence/heartbeat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function listPresence(input: {
	projectId: string;
	scope: PresenceScope;
	scopeId: string;
	userId?: string;
}): Promise<{ others: PresenceEntry[] }> {
	const params = new URLSearchParams({
		projectId: input.projectId,
		scope: input.scope,
		scopeId: input.scopeId,
	});
	if (input.userId) params.set("userId", input.userId);
	const res = await apiFetch(`${BASE}/presence?${params.toString()}`, { method: "GET" });
	return handleResponse(res);
}

export async function clearPresence(input: {
	projectId: string;
	scope: PresenceScope;
	scopeId: string;
	userId?: string;
}): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/presence/clear`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export interface ProjectCommentCreateInput {
	pageIndex: number;
	layerId?: string;
	region?: { x: number; y: number; w: number; h: number };
	annotation?: ReviewAnnotation;
	body: string;
}

export interface ProjectCommentUpdateInput {
	body?: string;
	status?: "open" | "resolved";
}

export async function getProjectComments(projectId: string): Promise<{ comments: ProjectComment[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/comments`);
	return handleResponse(res);
}

export async function createProjectComment(
	projectId: string,
	input: ProjectCommentCreateInput
): Promise<{ comment: ProjectComment; comments: ProjectComment[]; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/comments`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function updateProjectComment(
	projectId: string,
	commentId: string,
	input: ProjectCommentUpdateInput
): Promise<{ comment: ProjectComment; comments: ProjectComment[]; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/comments/${commentId}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export interface PageReviewDecisionCreateInput {
	pageIndex: number;
	status: PageReviewDecisionStatus;
	body?: string;
}

export async function getProjectReviewDecisions(projectId: string): Promise<{ decisions: PageReviewDecision[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/review-decisions`);
	return handleResponse(res);
}

export async function createProjectReviewDecision(
	projectId: string,
	input: PageReviewDecisionCreateInput
): Promise<{
	decision: PageReviewDecision;
	decisions: PageReviewDecision[];
	tasks: WorkflowTask[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/review-decisions`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export interface ReviewAssignmentCreateInput {
	assigneeUserId: string;
	targetLang?: string;
	pageIndexes?: number[];
	priority?: WorkflowTaskPriority;
	dueAt?: string;
	instructions?: string;
}

export async function listProjectReviewAssignments(projectId: string): Promise<{ assignments: ReviewAssignment[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/review-assignments`);
	return handleResponse(res);
}

export async function createProjectReviewAssignment(
	projectId: string,
	input: ReviewAssignmentCreateInput,
): Promise<{
	assignment: ReviewAssignment;
	assignments: ReviewAssignment[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/review-assignments`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function updateProjectReviewAssignment(
	projectId: string,
	assignmentId: string,
	input: { status?: ReviewAssignmentStatus; targetLang?: string; pageIndexes?: number[]; priority?: WorkflowTaskPriority; dueAt?: string | null; instructions?: string },
): Promise<{
	assignment: ReviewAssignment;
	assignments: ReviewAssignment[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/review-assignments/${encodeURIComponent(assignmentId)}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function cancelProjectReviewAssignment(
	projectId: string,
	assignmentId: string,
	reason: string,
): Promise<{
	assignment: ReviewAssignment;
	assignments: ReviewAssignment[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
	notified: boolean;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/review-assignments/${encodeURIComponent(assignmentId)}/cancel`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify({ reason }),
		}),
		handleResponse,
	);
}

// ── Revision send-back ──────────────────────────────────────────────────────

export interface RevisionRequestCreateInput {
	assignedToUserId: string;
	reason: string;
	targetLang?: string;
	pageIndexes?: number[];
	sourceReviewDecisionId?: string;
	priority?: WorkflowTaskPriority;
	dueAt?: string;
}

export async function listProjectRevisions(projectId: string): Promise<{ revisions: RevisionRequest[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/revisions`);
	return handleResponse(res);
}

export async function createProjectRevision(
	projectId: string,
	input: RevisionRequestCreateInput,
): Promise<{
	revision: RevisionRequest;
	revisions: RevisionRequest[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
	notified: boolean;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/revisions`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function updateProjectRevision(
	projectId: string,
	revisionId: string,
	input: { status?: RevisionRequestStatus; reason?: string; pageIndexes?: number[]; priority?: WorkflowTaskPriority; dueAt?: string | null },
): Promise<{
	revision: RevisionRequest;
	revisions: RevisionRequest[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/revisions/${encodeURIComponent(revisionId)}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export interface WorkspaceMessageCreateInput {
	pageIndex?: number;
	body: string;
	linkedTaskId?: string;
	linkedCommentId?: string;
	region?: { x: number; y: number; w: number; h: number };
}

export async function getWorkspaceFeed(projectId: string): Promise<{
	items: WorkspaceFeedItem[];
	messages: WorkspaceMessage[];
	activityLog: ActivityEvent[];
}> {
	const res = await apiFetch(`${BASE}/project/${projectId}/workspace-feed`);
	return handleResponse(res);
}

export async function createWorkspaceMessage(
	projectId: string,
	input: WorkspaceMessageCreateInput
): Promise<{
	message: WorkspaceMessage;
	messages: WorkspaceMessage[];
	items: WorkspaceFeedItem[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	return mutateWithProjectCas(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/workspace-messages`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export interface AiReviewMarkerCreateInput {
	jobId: string;
	pageIndex: number;
	imageId: string;
	region: { x: number; y: number; w: number; h: number };
	status?: AiReviewMarkerStatus;
	tier: AiTier;
	providerHint?: string;
	// The internal system/template prompt is intentionally NOT part of the marker
	// (leak-safe — never persisted or served). Only the user's own `customPrompt`.
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	costEstimate?: AiJobSubmissionResult["costEstimate"];
	creditReservation?: AiJobSubmissionResult["creditReservation"];
	resultImageId?: string;
	error?: string;
	assignee?: string;
	linkedCommentIds?: string[];
	linkedTaskIds?: string[];
	sourceMarkerId?: string;
	rerunIdempotencyKey?: string;
}

export interface AiReviewMarkerUpdateInput {
	status?: AiReviewMarkerStatus;
	providerHint?: string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	costEstimate?: AiJobSubmissionResult["costEstimate"];
	creditReservation?: AiJobSubmissionResult["creditReservation"];
	resultImageId?: string;
	error?: string;
	assignee?: string | null;
	linkedCommentIds?: string[];
	linkedTaskIds?: string[];
	sourceMarkerId?: string;
	rerunIdempotencyKey?: string;
}

export interface AiReviewMarkerRerunResult extends AiJobSubmissionResult {
	reused: boolean;
	marker: AiReviewMarker;
	markers: AiReviewMarker[];
	tasks?: WorkflowTask[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}

export async function getAiReviewMarkers(projectId: string): Promise<{ markers: AiReviewMarker[] }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/ai-markers`);
	return handleResponse(res);
}

/**
 * Durably reconcile markers stuck in `processing` against their AI jobs' terminal
 * result. Recovers a finished result whose client poll loop closed mid-gen (the
 * user navigated away during a minutes-long gen) so the marker reaches a terminal
 * ready/failed state WITHOUT a live poll. Returns the refreshed markers plus which
 * ones self-healed. (The GET route also reconciles on read; this is the proactive
 * call used on AI-panel mount.)
 */
export async function reconcileAiReviewMarkers(
	projectId: string,
): Promise<{ markers: AiReviewMarker[]; reconciled: string[]; changed: boolean }> {
	const res = await apiFetch(`${BASE}/project/${projectId}/ai-markers/reconcile`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function createAiReviewMarker(
	projectId: string,
	input: AiReviewMarkerCreateInput
): Promise<{ marker: AiReviewMarker; markers: AiReviewMarker[]; tasks?: WorkflowTask[]; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	// P1-3: send the CAS baseline header + retry-on-conflict (the server now wraps this
	// route in commitProjectStateWithCas and, in prod, REQUIRES the baseline header).
	return mutateWithProjectCas<{ marker: AiReviewMarker; markers: AiReviewMarker[]; tasks?: WorkflowTask[]; activityLog: ActivityEvent[]; version?: ProjectVersion }>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/ai-markers`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function rerunAiReviewMarker(
	projectId: string,
	markerId: string,
	input: { lang?: string } = {},
	idempotencyKey?: string,
	tier: AiTier = "sfx-pro",
): Promise<AiReviewMarkerRerunResult> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Project-Id": projectId,
		"X-AI-Tier": tier,
	};
	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}
	const res = await apiFetch(`${BASE}/project/${projectId}/ai-markers/${markerId}/rerun`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export interface AiReviewMarkerRetryResult extends AiReviewMarkerRerunResult {
	sourceMarker: AiReviewMarker;
}

// Retry-with-prompt: re-submit the AI job for a marker using a reviewer-edited
// prompt. The composed prompt still passes the backend moderation gate, and the
// source marker transitions to the "retrying" (retry_requested) state.
export async function retryAiReviewMarker(
	projectId: string,
	markerId: string,
	input: { lang?: string; promptOverride?: string } = {},
	idempotencyKey?: string,
	tier: AiTier = "sfx-pro",
): Promise<AiReviewMarkerRetryResult> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Project-Id": projectId,
		"X-AI-Tier": tier,
	};
	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}
	const res = await apiFetch(`${BASE}/project/${projectId}/ai-markers/${markerId}/retry`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

export async function updateAiReviewMarker(
	projectId: string,
	markerId: string,
	input: AiReviewMarkerUpdateInput
): Promise<{ marker: AiReviewMarker; markers: AiReviewMarker[]; tasks?: WorkflowTask[]; activityLog: ActivityEvent[]; version?: ProjectVersion }> {
	// P1-3: send the CAS baseline header + retry-on-conflict (see createAiReviewMarker).
	return mutateWithProjectCas<{ marker: AiReviewMarker; markers: AiReviewMarker[]; tasks?: WorkflowTask[]; activityLog: ActivityEvent[]; version?: ProjectVersion }>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/ai-markers/${markerId}`, {
			method: "PATCH",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function createAiReviewMarkerComment(
	projectId: string,
	markerId: string,
	input: { body?: string }
): Promise<{
	marker: AiReviewMarker;
	comment: ProjectComment;
	markers: AiReviewMarker[];
	comments: ProjectComment[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	// P1-3: send the CAS baseline header + retry-on-conflict (see createAiReviewMarker).
	return mutateWithProjectCas<{
		marker: AiReviewMarker;
		comment: ProjectComment;
		markers: AiReviewMarker[];
		comments: ProjectComment[];
		activityLog: ActivityEvent[];
		version?: ProjectVersion;
	}>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/ai-markers/${markerId}/comments`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

export async function linkAiReviewMarkerReviewTask(
	projectId: string,
	markerId: string,
	input: { assignee?: string | null } = {}
): Promise<{
	marker: AiReviewMarker;
	task: WorkflowTask;
	markers: AiReviewMarker[];
	tasks: WorkflowTask[];
	activityLog: ActivityEvent[];
	version?: ProjectVersion;
}> {
	// P1-3: send the CAS baseline header + retry-on-conflict (see createAiReviewMarker).
	return mutateWithProjectCas<{
		marker: AiReviewMarker;
		task: WorkflowTask;
		markers: AiReviewMarker[];
		tasks: WorkflowTask[];
		activityLog: ActivityEvent[];
		version?: ProjectVersion;
	}>(
		projectId,
		(baseHash) => apiFetch(`${BASE}/project/${projectId}/ai-markers/${markerId}/review-task`, {
			method: "POST",
			headers: withProjectBaseStateHashHeader(baseHash, { "Content-Type": "application/json" }),
			body: JSON.stringify(input),
		}),
		handleResponse,
	);
}

/**
 * Restore a project version. With no `scope` this reverts the whole project
 * (legacy behaviour). W3.9: pass `{ pageIndex }` to restore a single page, or
 * `{ pageIndex, layerId }` to restore one text/image layer, leaving everything
 * outside the scope untouched.
 */
export async function restoreProjectVersion(
	projectId: string,
	versionId: string,
	scope?: VersionRestoreScope,
): Promise<VersionRestoreResult> {
	const hasScope = scope && (scope.pageIndex !== undefined || scope.layerId !== undefined);
	const res = await apiFetch(`${BASE}/project/${projectId}/versions/${versionId}/restore`, {
		method: "POST",
		...(hasScope
			? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope) }
			: {}),
	});
	return handleResponse(res);
}

// ── Text QA (typo / spacing checker) ──────────────────────────

export type TextQaIssueType = "typo" | "spacing" | "grammar" | "punctuation";

export interface TextQaIssue {
	start: number;
	end: number;
	type: TextQaIssueType;
	message: string;
	suggestion: string;
}

export interface TextQaQuotaSummary {
	usedChars: number;
	limitChars: number;
	remainingChars: number;
	resetAt: number;
	planId: string;
}

export interface TextQaCheckResult {
	issues: TextQaIssue[];
	cached: boolean;
	model: string;
	lang: string;
	quota: TextQaQuotaSummary;
}

export interface CheckTextQaOptions {
	/** Bill the check against this project's workspace plan (paid → bigger budget). */
	projectId?: string;
	/** Abort signal so superseded checks (newer keystroke / language switch) cancel. */
	signal?: AbortSignal;
}

export async function checkTextQa(text: string, lang: string, options: CheckTextQaOptions = {}): Promise<TextQaCheckResult> {
	const res = await apiFetch(`${BASE}/text-qa/check`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, lang, projectId: options.projectId }),
		timeoutMs: 25000,
		signal: options.signal,
	});
	return handleResponse(res);
}

export async function getTextQaQuota(): Promise<{ enabled: boolean; quota: TextQaQuotaSummary }> {
	const res = await apiFetch(`${BASE}/text-qa/quota`, { timeoutMs: 10000 });
	return handleResponse(res);
}

export async function getAdminConfig(): Promise<AdminConfig> {
	const res = await apiFetch(`${BASE}/ai/admin/config`);
	return handleResponse(res);
}

export async function updateAdminConfig(config: Partial<AdminConfig>): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/ai/admin/config`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(config),
	});
	return handleResponse(res);
}

// ── Notifications (Wave 2 W2.5) ────────────────────────────────

export type NotificationType =
	| "comment_new"
	| "comment_reply"
	| "ai_job_complete"
	| "ai_job_failed"
	| "chapter_submitted"
	| "chapter_approved"
	| "chapter_rejected"
	| "invite_received"
	| "quota_warning_80pct"
	| "quota_frozen"
	| "payment_succeeded"
	| "payment_failed"
	| "team_member_joined"
	| "task_assigned"
	| "work_assigned"
	| "editing_taken_over"
	| "ticket_opened"
	| "ticket_replied"
	| "ticket_escalated"
	| "ticket_resolved";

export type NotificationCategory = "tasks" | "support" | "billing" | "system";

export interface NotificationPayload {
	id: string;
	userId: string;
	workspaceId?: string;
	type: NotificationType;
	title: string;
	body?: string;
	linkUrl?: string;
	metadata?: Record<string, unknown>;
	readAt?: string;
	createdAt: string;
	category: NotificationCategory;
}

export interface NotificationListResponse {
	items: NotificationPayload[];
	hasMore: boolean;
	nextCursor?: string;
}

export async function listNotifications(options: { limit?: number; before?: string; unreadOnly?: boolean } = {}): Promise<NotificationListResponse> {
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", String(options.limit));
	if (options.before) params.set("before", options.before);
	if (options.unreadOnly) params.set("unread_only", "true");
	const query = params.toString();
	const res = await apiFetch(`${BASE}/notifications${query ? `?${query}` : ""}`);
	return handleResponse(res);
}

export async function getUnreadNotificationCount(): Promise<{ count: number }> {
	const res = await apiFetch(`${BASE}/notifications/unread-count`);
	return handleResponse(res);
}

export async function markNotificationRead(id: string): Promise<{ notification: NotificationPayload }> {
	const res = await apiFetch(`${BASE}/notifications/${encodeURIComponent(id)}/read`, {
		method: "POST",
	});
	return handleResponse(res);
}

// ── Notification preferences (per-type × per-channel toggles, PR #168) ──────
//
// The backend models preferences as a SPARSE opt-out matrix: a stored row only
// exists where a user explicitly overrode a coded default. `GET /preferences`
// returns the merged effective matrix plus the coded defaults so the settings
// UI can drive itself entirely from the server response (no hardcoded taxonomy)
// and render a "reset to defaults" affordance. `PUT /preferences` upserts a
// batch of explicit overrides and echoes the recomputed matrix.

/** The two delivery channels every notification type can flow through. */
export type NotificationChannel = "email" | "in_app";

/** Per-channel on/off for a single notification type. */
export interface NotificationChannelPrefs {
	email: boolean;
	in_app: boolean;
}

/**
 * Effective preference matrix for the current user: `values[type][channel]` is
 * the effective boolean (defaults merged with the user's overrides) and
 * `defaults[type][channel]` is the coded default so the UI can show which cells
 * diverge + offer "reset to defaults". `types`/`channels` are the server's
 * authoritative taxonomy — render from these, not a local list.
 */
export interface NotificationPreferences {
	types: NotificationType[];
	channels: NotificationChannel[];
	values: Record<string, NotificationChannelPrefs>;
	defaults: Record<string, NotificationChannelPrefs>;
}

/** One explicit (type, channel) override to upsert. */
export interface NotificationPreferenceUpdate {
	type: NotificationType;
	channel: NotificationChannel;
	enabled: boolean;
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
	const res = await apiFetch(`${BASE}/notifications/preferences`);
	return handleResponse(res);
}

export async function updateNotificationPreferences(
	updates: NotificationPreferenceUpdate[],
): Promise<{ updated: number; preferences: NotificationPreferences }> {
	const res = await apiFetch(`${BASE}/notifications/preferences`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ updates }),
	});
	return handleResponse(res);
}

// ---------------------------------------------------------------------------
// Billing + Usage (Wave 2 W2.2)
//
// Surfaces the catalog/plan/checkout/portal endpoints from the Dodo Payments
// backend (PR #74) and the workspace usage dashboard endpoint that already
// existed. Used by the public `/pricing` page, the in-workspace billing
// settings page, and the usage page.
// ---------------------------------------------------------------------------

/** Internal workspace plan id surfaced by the backend catalog. */
export type WorkspacePlanId = "free" | "creator" | "pro" | "studio" | "studio_plus";

/**
 * The plan keys the Dodo CHECKOUT backend accepts (backend/src/routes/billing-dodo.ts
 * `checkoutSchema`). These are the Dodo product-catalog keys, NOT the public display
 * keys: the Dodo catalog keys the entry tier as "starter", which maps to the internal
 * "creator" plan (DODO_TO_INTERNAL_PLAN in backend/src/services/dodo.service.ts).
 */
export type DodoPlanKey = "starter" | "pro" | "studio" | "studio_plus";
export type DodoBillingCycle = "monthly" | "yearly";
export type DodoAddonKey = "byo_api";

/**
 * The public DISPLAY plan keys a paid pricing card can check out with — mirrors the
 * non-free `WorkspacePlanId`s (services/plans.ts: "creator"/"pro"/"studio"). These are
 * what the pricing cards carry, so checkout callers stay 1:1 with the public catalog.
 */
export type PublicCheckoutPlanKey = Exclude<WorkspacePlanId, "free">;

/**
 * Display-key → Dodo-CHECKOUT-key map applied at the checkout boundary. The pricing
 * cards advertise the public display keys ("creator"/"pro"/"studio"), but the Dodo
 * checkout backend only accepts its product-catalog keys ("starter"/"pro"/"studio"/
 * "studio_plus"). Only the entry tier differs (display "creator" → Dodo "starter",
 * the SAME Dodo product/charge — see DODO_TO_INTERNAL_PLAN). This does NOT change what
 * is charged; it only reconciles the key the backend validator (checkoutSchema) accepts
 * so a display rename can never 400 checkout again.
 */
const DISPLAY_TO_DODO_CHECKOUT_PLAN: Record<PublicCheckoutPlanKey, DodoPlanKey> = {
	creator: "starter",
	pro: "pro",
	studio: "studio",
	studio_plus: "studio_plus",
};

/** Map a public display plan key to the Dodo checkout key the backend validator accepts. */
export function toDodoCheckoutPlanKey(planKey: PublicCheckoutPlanKey): DodoPlanKey {
	return DISPLAY_TO_DODO_CHECKOUT_PLAN[planKey];
}

export interface BillingPlanRecord {
	id: WorkspacePlanId;
	name: string;
	priceUsdMonthly: number;
	includedStorageBytes: number;
	monthlyAiCredits: number;
	maxSeatsIncluded: number;
	joinableTeamStories?: number;
	creatableTeamStories?: number;
	activeTeamJobs?: number;
	maxAiQueueOpenJobs?: number;
	maxAiQueuePendingJobs?: number;
	allowedAiQualities?: ("low" | "medium" | "high")[];
	addons?: {
		aiCredits: boolean;
		storage: boolean;
		seats: boolean;
		teamJobs: boolean;
	};
}

export interface BillingAddonRecord {
	id: string;
	kind: "ai_credits" | "storage" | "seat" | "team_jobs";
	name: string;
	priceUsd: number;
	billingInterval: "one_time" | "monthly";
	units: number;
	unitLabel: string;
	minPlanId: WorkspacePlanId;
	active: boolean;
	aiCredits?: number;
	storageBytes?: number;
	seats?: number;
	teamJobs?: number;
	metadata?: Record<string, unknown>;
}

export interface BillingCatalogResponse {
	plans: BillingPlanRecord[];
}

export interface BillingAssignmentRecord {
	workspaceId: string;
	planId: WorkspacePlanId;
	status: "mock_active" | "trialing" | "active" | "past_due" | "cancelled";
	billingEmail?: string | null;
	createdAt?: string;
	updatedAt?: string;
	currentPeriodEnd?: string | null;
	cycle?: DodoBillingCycle;
}

export interface BillingAddonGrant {
	grantId: string;
	workspaceId: string;
	addonId: string;
	kind: BillingAddonRecord["kind"];
	startsAt?: string;
	expiresAt?: string | null;
	status: "active" | "expired" | "cancelled";
}

export interface WorkspaceBillingState {
	workspaceId: string;
	planId: WorkspacePlanId;
	assigned: boolean;
	plan: BillingPlanRecord;
	assignment: BillingAssignmentRecord | null;
	grants: BillingAddonGrant[];
}

export interface BillingCheckoutInput {
	workspaceId: string;
	/**
	 * The PUBLIC display plan key the card carries ("creator"/"pro"/"studio"). It is
	 * translated to the Dodo checkout key the backend accepts inside
	 * `startDodoCheckoutSession` (see `toDodoCheckoutPlanKey`), so callers never have to
	 * know the Dodo "starter" alias and a display rename can't break checkout.
	 */
	planKey: PublicCheckoutPlanKey;
	cycle: DodoBillingCycle;
	addons?: DodoAddonKey[];
}

export interface BillingCheckoutResult {
	checkout_url: string;
	session_id: string;
}

export interface BillingPortalResult {
	portal_url: string;
}

export interface BillingInvoiceRecord {
	invoiceId: string;
	number?: string;
	amountCents: number;
	currency: string;
	status: "paid" | "open" | "void" | "uncollectible" | string;
	createdAt: string;
	dueAt?: string | null;
	hostedUrl?: string | null;
	pdfUrl?: string | null;
	description?: string;
}

export interface BillingInvoiceListResult {
	invoices: BillingInvoiceRecord[];
	/** Backend may indicate that invoice history must be viewed through the Dodo customer portal. */
	availability: "available" | "portal_only" | "unavailable";
}

export async function getBillingCatalog(): Promise<BillingCatalogResponse> {
	const res = await apiFetch(`${BASE}/billing/plans`);
	return handleResponse(res);
}

export async function getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingState> {
	const res = await apiFetch(`${BASE}/billing/${encodeURIComponent(workspaceId)}`);
	return handleResponse(res);
}

export async function startDodoCheckoutSession(input: BillingCheckoutInput): Promise<BillingCheckoutResult> {
	const res = await apiFetch(`${BASE}/billing/${encodeURIComponent(input.workspaceId)}/checkout-session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			// Translate the public display key ("creator") to the Dodo checkout key the
			// backend validator accepts ("starter") — same product/charge, no 400.
			plan_key: toDodoCheckoutPlanKey(input.planKey),
			billing_cycle: input.cycle,
			addons: input.addons ?? [],
		}),
	});
	return handleResponse(res);
}

export async function openDodoPortalSession(workspaceId: string): Promise<BillingPortalResult> {
	const res = await apiFetch(`${BASE}/billing/${encodeURIComponent(workspaceId)}/portal-session`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
	const res = await apiFetch(`${BASE}/notifications/mark-all-read`, {
		method: "POST",
	});
	return handleResponse(res);
}

export async function getWorkspaceBillingInvoices(workspaceId: string): Promise<BillingInvoiceListResult> {
	// PR #74 does not yet expose an invoice list endpoint; Dodo invoice history is
	// fetched through the customer portal. We probe the optional endpoint and
	// fall back to a portal-only signal instead of throwing.
	try {
		const res = await apiFetch(`${BASE}/billing/${encodeURIComponent(workspaceId)}/invoices`);
		if (res.status === 404) {
			return { invoices: [], availability: "portal_only" };
		}
		return await handleResponse<BillingInvoiceListResult>(res);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return { invoices: [], availability: "portal_only" };
		}
		throw error;
	}
}

// --- Usage dashboard ------------------------------------------------------

export interface UsageDashboardWindow {
	periodKey: string;
	aiCapturedThb: number;
	aiActiveReservedThb: number;
	aiCommittedThb: number;
	uploadBytes: number;
	exportBytes: number;
	moderationImages: number;
	limits: { aiCreditThb: number; uploadBytes: number; exportBytes: number };
	remaining: { aiCreditThb: number | null; uploadBytes: number | null; exportBytes: number | null };
}

export interface UsageDashboardStorage {
	usedBytes: number;
	originalBytes: number;
	derivativeBytes: number;
	exportArtifactBytes: number;
	reservedBytes: number;
	projectedBytes: number;
	limitBytes: number;
	includedBytes: number;
	extraBytes: number;
	remainingBytes: number;
	percentUsed: number;
	enforced: boolean;
}

export interface UsageDashboardEgressProject {
	projectId: string;
	totalRequests: number;
	totalBytes: number;
	limitBytes: number;
	remainingBytes: number;
	enforced: boolean;
}

export interface UsageDashboardEgress {
	windowMs: number;
	totalRequests: number;
	totalBytes: number;
	limitBytes: number;
	remainingBytes: number;
	enforced: boolean;
	perProjectEnforced: boolean;
	projects: UsageDashboardEgressProject[];
}

export interface UsageDashboardMember {
	userId: string;
	role: string;
	disabled: boolean;
	aiCommittedThb: number;
	uploadBytes: number;
	exportBytes: number;
}

export interface UsageDashboardPlan {
	id: string;
	name: string;
	monthlyAiCredits: number;
	includedStorageBytes: number;
	maxSeatsIncluded: number;
}

export interface UsageDashboard {
	workspaceId: string;
	scope: "postgres" | "filesystem";
	enforced: boolean;
	plan: UsageDashboardPlan;
	projectIds: string[];
	projectCount: number;
	totals: {
		daily: UsageDashboardWindow;
		monthly: UsageDashboardWindow;
		eventCount: number;
		// True iff eventCount hit the server-side display cap: render as "100000+".
		eventCountCapped: boolean;
	};
	storage: UsageDashboardStorage;
	egress: UsageDashboardEgress;
	memberAttribution: "unattributed";
	members: {
		count: number;
		breakdown: UsageDashboardMember[];
		unattributed: { aiCommittedThb: number; uploadBytes: number; exportBytes: number };
	};
}

export async function getWorkspaceUsageDashboard(workspaceId: string): Promise<{ dashboard: UsageDashboard }> {
	const res = await apiFetch(`${BASE}/usage/workspace/${encodeURIComponent(workspaceId)}/dashboard`);
	return handleResponse(res);
}

// ── Performance intelligence (W2.15) — read models ────────────────────────────
//
// Mirrors backend/src/services/performance-intelligence.ts. The dashboard
// analytics section reads the ANONYMIZED workspace aggregate (`getPerfWorkspaceAggregate`,
// visible to every member) for real per-dimension performance medians + ROI; it
// is NOT a fabricated series. ROI/aggregate are real computed values derived from
// recorded work events, so a workspace with no recorded events honestly returns
// zeros.

export type PerfDimensionKey =
	| "throughput"
	| "quality"
	| "consistency"
	| "ai_leverage"
	| "collaboration";

export interface PerfRoiMetrics {
	tmHits: number;
	aiCaughtIssues: number;
	timeSavedMinutes: number;
	timeSavedHours: number;
	moneySavedUsd: number;
	hourlyRateUsd: number;
}

export interface PerfWorkspaceAggregate {
	workspaceId: string;
	periodStart: string;
	memberCount: number;
	medianComposite: number;
	dimensionMedians: Record<PerfDimensionKey, number>;
	roi: PerfRoiMetrics;
	computedAt: string;
	/**
	 * True when the backend window scan hit PERF_WINDOW_EVENT_LIMIT and dropped the
	 * OLDEST in-window events: the medians/ROI above then cover only the most recent
	 * `windowEventLimit` events, not the full period. Additive — older clients that
	 * don't read it simply keep rendering the (recent-only) numbers. Optional so a
	 * legacy payload without the field is treated as "not truncated".
	 */
	windowTruncated?: boolean;
	/** The event cap applied to the scan; the "showing the latest N events" count. */
	windowEventLimit?: number;
}

// GET /api/perf/workspace — anonymized workspace performance aggregate. Visible to
// every workspace member (read_workspace), so it is safe to load from the shared
// dashboard. Returns medians + ROI, never per-member identities.
export async function getPerfWorkspaceAggregate(
	workspaceId: string,
	options: { periodWeeks?: number } = {},
): Promise<{ aggregate: PerfWorkspaceAggregate }> {
	const params = new URLSearchParams({ workspaceId });
	if (options.periodWeeks !== undefined) params.set("periodWeeks", String(options.periodWeeks));
	const res = await apiFetch(`${BASE}/perf/workspace?${params.toString()}`);
	return handleResponse(res);
}

// ── Chapter export-gate readiness (W3.11) ─────────────────────────────────────

export type ExportBlockerType =
	| "untranslated_text"
	| "unresolved_ai_marker"
	| "open_qc_comment"
	| "workflow_not_approved"
	| "moderation_not_passed"
	| "no_pages";

export interface ExportBlockerPageRef {
	pageIndex: number;
	pageNumber: number;
	imageId?: string;
	count: number;
	detail?: string;
}

export interface ExportBlockerGroup {
	type: ExportBlockerType;
	label: string;
	count: number;
	pages: ExportBlockerPageRef[];
}

export interface ExportReadinessPageBlocker {
	type: ExportBlockerType;
	label: string;
	count: number;
	detail?: string;
}

export interface ExportReadinessPage {
	pageIndex: number;
	pageNumber: number;
	imageId?: string;
	ready: boolean;
	blockers: ExportReadinessPageBlocker[];
}

export interface ChapterExportReadiness {
	chapterId: string;
	projectId: string;
	workspaceId?: string;
	pageCount: number;
	readyPageCount: number;
	blockedPageCount: number;
	canExport: boolean;
	blockers: ExportBlockerGroup[];
	pages: ExportReadinessPage[];
}

/**
 * Server-authoritative export-gate readiness for a chapter: every blocker type
 * aggregated across all pages with per-page jump targets + an overall canExport
 * flag (W3.11). chapterId == projectId in this model.
 */
export async function getChapterExportReadiness(chapterId: string): Promise<{ readiness: ChapterExportReadiness }> {
	const res = await apiFetch(`${BASE}/export/${encodeURIComponent(chapterId)}/readiness`);
	return handleResponse(res);
}

// ---------------------------------------------------------------------------
// Customer support tickets
//
// The REQUESTER side of the support system: a logged-in user opens, lists,
// reads, replies to, and closes THEIR OWN tickets. The gpt-5.5 support agent
// posts replies with authorKind="ai"; a human staff member posts "agent".
// All endpoints are auth-only + customer-scoped (a ticket owned by someone
// else returns 404). The create/reply endpoints 429 when spammed — callers
// should surface ApiError.retryAfter as a friendly "slow down" message.
//
// IMPORTANT: message bodies (incl. AI + human content) must be rendered as
// TEXT, never {@html} — they are untrusted user/model output.
// ---------------------------------------------------------------------------

export type SupportTicketStatus = "open" | "pending" | "escalated" | "resolved" | "closed";
export type SupportTicketCategory = "billing" | "technical" | "abuse" | "account" | "general";
export type SupportMessageAuthorKind = "customer" | "agent" | "ai" | "system";

export interface SupportTicket {
	id: string;
	requesterUserId: string;
	workspaceId?: string;
	subject: string;
	status: SupportTicketStatus;
	priority: "low" | "normal" | "high" | "urgent";
	category: SupportTicketCategory;
	assigneeUserId?: string;
	queue?: string;
	aiMessageCount: number;
	aiTokensSpent: number;
	lastProcessedMessageId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SupportTicketMessage {
	id: string;
	ticketId: string;
	authorKind: SupportMessageAuthorKind;
	authorUserId?: string;
	body: string;
	tokens?: number;
	createdAt: string;
}

export interface SupportTicketListResponse {
	items: SupportTicket[];
	hasMore: boolean;
	nextCursor?: string;
}

export interface SupportTicketThreadResponse {
	ticket: SupportTicket;
	messages: SupportTicketMessage[];
}

/** Categories surfaced in the "new ticket" form (mirrors the backend enum). */
export const SUPPORT_TICKET_CATEGORIES: readonly SupportTicketCategory[] = [
	"general",
	"technical",
	"billing",
	"account",
	"abuse",
];

export async function listSupportTickets(options: { limit?: number; before?: string } = {}): Promise<SupportTicketListResponse> {
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", String(options.limit));
	if (options.before) params.set("before", options.before);
	const query = params.toString();
	const res = await apiFetch(`${BASE}/support/tickets${query ? `?${query}` : ""}`);
	return handleResponse(res);
}

export async function createSupportTicket(input: {
	subject: string;
	body: string;
	category?: SupportTicketCategory;
}): Promise<{ ticket: SupportTicket; message: SupportTicketMessage | null }> {
	const res = await apiFetch(`${BASE}/support/tickets`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			subject: input.subject,
			body: input.body,
			...(input.category ? { category: input.category } : {}),
		}),
	});
	return handleResponse(res);
}

export async function getSupportTicketThread(ticketId: string): Promise<SupportTicketThreadResponse> {
	const res = await apiFetch(`${BASE}/support/tickets/${encodeURIComponent(ticketId)}`);
	return handleResponse(res);
}

export async function replyToSupportTicket(ticketId: string, body: string): Promise<{ ticket: SupportTicket; message: SupportTicketMessage }> {
	const res = await apiFetch(`${BASE}/support/tickets/${encodeURIComponent(ticketId)}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	return handleResponse(res);
}

export async function closeSupportTicket(ticketId: string): Promise<{ ticket: SupportTicket }> {
	const res = await apiFetch(`${BASE}/support/tickets/${encodeURIComponent(ticketId)}/close`, {
		method: "POST",
	});
	return handleResponse(res);
}

// ---------------------------------------------------------------------------
// Account · Privacy & Data (GDPR self-service — W2.6)
//
// Wires the data-subject-rights endpoints in backend/src/routes/account.ts so an
// EU user can exercise portability (export) and erasure (soft-delete + 30-day
// restore grace) from the UI. The signed download route is public (it verifies
// its own HMAC + expiry from the query string), so the download link works even
// in a logged-out tab — we just open it.
// ---------------------------------------------------------------------------

/** Lifecycle of a "download my data" export request, mirrored from the backend. */
export type AccountExportStatus = "queued" | "processing" | "ready" | "failed" | "expired";

export interface AccountExportJob {
	id: string;
	userId: string;
	status: AccountExportStatus;
	/** Signed, expiring download URL — only populated once `status === "ready"`. */
	zipUrl: string | null;
	failureReason: string | null;
	bytes: number | null;
	expiresAt: string | null;
	createdAt: string;
	completedAt: string | null;
}

/** Confirmation returned after scheduling account deletion. */
export interface AccountDeleteResult {
	ok: boolean;
	deletedAt: string;
	/** ISO timestamp until which the account can still be restored. */
	deleteGraceUntil: string;
	restoreUrl: string;
}

/**
 * Request a fresh data snapshot. The backend de-dupes: if a job is already
 * queued/processing it returns that one (200) instead of creating a second
 * (202). Either way the caller just gets the job back.
 */
export async function requestAccountExport(): Promise<{ job: AccountExportJob; message?: string }> {
	const res = await apiFetch(`${BASE}/account/export`, { method: "POST" });
	return handleResponse(res);
}

/** History of my export requests, newest first (backend ordering). */
export async function listAccountExports(): Promise<{ jobs: AccountExportJob[] }> {
	const res = await apiFetch(`${BASE}/account/export`);
	return handleResponse(res);
}

/**
 * Open the signed download link for a ready export. The URL already carries its
 * own signature + expiry and the route is public, so we resolve it against the
 * current origin and open it — no auth header, no fetch/blob round-trip. Returns
 * the resolved URL (useful for tests / rendering as an <a href>).
 */
export function downloadAccountExport(job: Pick<AccountExportJob, "zipUrl">): string | null {
	if (!job.zipUrl) return null;
	// zipUrl is a relative "/api/account/export/:id/download?expires=…&signature=…".
	// Resolve against the origin so it is openable from any page.
	const url =
		typeof window !== "undefined" && window.location
			? new URL(job.zipUrl, window.location.origin).toString()
			: job.zipUrl;
	if (typeof window !== "undefined" && typeof window.open === "function") {
		window.open(url, "_blank", "noopener,noreferrer");
	}
	return url;
}

/**
 * Soft-delete the current account. The server keeps the data for a grace window
 * (default 30 days) before a cron hard-deletes it, and revokes all sessions so
 * the user must restore before signing in again.
 */
export async function deleteMyAccount(reason?: string): Promise<AccountDeleteResult> {
	const trimmed = reason?.trim();
	const res = await apiFetch(`${BASE}/account`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
	});
	return handleResponse(res);
}

/** Undo a soft-delete within the grace window (uses the active session). */
export async function restoreMyAccount(): Promise<{ ok: boolean }> {
	const res = await apiFetch(`${BASE}/account/restore`, { method: "POST" });
	return handleResponse(res);
}

/**
 * Undo a soft-delete from an email-style restore link, using the signed
 * `?user=…&token=…` proof instead of a session. Backs the `/account/restore`
 * page so a logged-out user can restore within the grace window straight from the
 * confirmation link. The backend's POST /account/restore is public for exactly
 * this case (it verifies the HMAC token).
 */
export async function restoreAccountWithToken(userId: string, token: string): Promise<{ ok: boolean }> {
	const params = new URLSearchParams({ user: userId, token });
	const res = await apiFetch(`${BASE}/account/restore?${params.toString()}`, { method: "POST" });
	return handleResponse(res);
}

// =====================================================================================
// REGION: STAFF SUPPORT TICKET MANAGEMENT (appended — separate from the error-formatter
// region above to minimize merge conflict with the agent that owns it). a16 #6.
//
// Wraps the backend STAFF ticket surface at /api/support/agent/* (RBAC-gated:
// SUPPORT_READ for reads, SUPPORT_ADJUST for mutations). Distinct from the
// customer methods above: staff see ALL tickets and the FULL thread INCLUDING
// internal notes (author_kind="internal"). These methods are the missing API
// client the staff console needs; the full console UI is intentionally minimal
// (see SupportAgentConsole.svelte) — flagged for product follow-up.
// =====================================================================================

/** Author kinds on the STAFF thread — adds the staff-only "internal" note kind. */
export type StaffSupportMessageAuthorKind = SupportMessageAuthorKind | "internal";

/** A message on the STAFF thread (internal notes included). */
export interface StaffSupportTicketMessage extends Omit<SupportTicketMessage, "authorKind"> {
	authorKind: StaffSupportMessageAuthorKind;
}

export interface StaffSupportTicketListResponse {
	items: SupportTicket[];
	hasMore: boolean;
	nextCursor?: string;
}

export interface StaffSupportTicketThreadResponse {
	ticket: SupportTicket;
	messages: StaffSupportTicketMessage[];
}

export interface StaffTicketListOptions {
	limit?: number;
	before?: string;
	status?: SupportTicketStatus;
	assignee?: string;
	queue?: string;
}

/** GET /api/support/agent/tickets — the staff inbox (all tickets, filterable). */
export async function listStaffSupportTickets(options: StaffTicketListOptions = {}): Promise<StaffSupportTicketListResponse> {
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", String(options.limit));
	if (options.before) params.set("before", options.before);
	if (options.status) params.set("status", options.status);
	if (options.assignee) params.set("assignee", options.assignee);
	if (options.queue) params.set("queue", options.queue);
	const query = params.toString();
	const res = await apiFetch(`${BASE}/support/agent/tickets${query ? `?${query}` : ""}`);
	return handleResponse(res);
}

/** GET /api/support/agent/tickets/:id — full ticket + thread (internal notes included). */
export async function getStaffSupportTicketThread(ticketId: string): Promise<StaffSupportTicketThreadResponse> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}`);
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/assign — assign to a staff member and/or queue. */
export async function assignStaffSupportTicket(
	ticketId: string,
	input: { assigneeUserId?: string; queue?: string },
): Promise<{ ticket: SupportTicket }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/assign`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/reply — staff reply (visible to the customer). */
export async function replyStaffSupportTicket(ticketId: string, body: string): Promise<{ ticket: SupportTicket; message: StaffSupportTicketMessage }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/reply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/internal-note — staff-only note (never shown to the customer). */
export async function addStaffSupportInternalNote(ticketId: string, body: string): Promise<{ ticket: SupportTicket; message: StaffSupportTicketMessage }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/internal-note`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/escalate — escalate to a department. */
export async function escalateStaffSupportTicket(
	ticketId: string,
	input: { department: string; reason?: string },
): Promise<{ ticket: SupportTicket }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/escalate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/resolve — mark the ticket resolved. */
export async function resolveStaffSupportTicket(ticketId: string): Promise<{ ticket: SupportTicket }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/resolve`, {
		method: "POST",
	});
	return handleResponse(res);
}

/** POST /api/support/agent/tickets/:id/close — mark the ticket closed. */
export async function closeStaffSupportTicket(ticketId: string): Promise<{ ticket: SupportTicket }> {
	const res = await apiFetch(`${BASE}/support/agent/tickets/${encodeURIComponent(ticketId)}/close`, {
		method: "POST",
	});
	return handleResponse(res);
}

// ─────────────────────────── Work locks (soft leases) ───────────────────────
//
// Concurrent-edit Phase 1: page/scope soft leases. The lease STEERS users before
// they overlap; CAS remains the final net on save. acquire/extend/release map
// to /api/locks/*. The `client_id` distinguishes the SAME user's two tabs so a
// second tab is steered (lock_same_user_conflict → offer take-over) rather than
// silently inheriting and clobbering the first tab's lease.

export type WorkLockScopeName = "page" | "object" | "layer" | "chapter";

export interface AcquireWorkLockInput {
	scope: WorkLockScopeName;
	scopeId: string;
	projectId?: string;
	chapterId?: string;
	pageId?: string;
	workspaceId?: string;
	durationMin?: number;
	clientId?: string;
	/** Steal a lease held by THIS user's other tab. Never overrides another user. */
	takeover?: boolean;
}

export interface WorkLockHandle {
	lockId: string;
	expiresAt: string;
	clientId?: string;
}

/** POST /api/locks/acquire — acquire (or heartbeat) a soft lease on a scope. */
export async function acquireWorkLock(input: AcquireWorkLockInput): Promise<WorkLockHandle> {
	const res = await apiFetch(`${BASE}/locks/acquire`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			scope: input.scope,
			scope_id: input.scopeId,
			project_id: input.projectId,
			chapter_id: input.chapterId,
			page_id: input.pageId,
			workspace_id: input.workspaceId,
			duration_min: input.durationMin,
			client_id: input.clientId,
			takeover: input.takeover || undefined,
		}),
	});
	const data = await handleResponse<{ lock_id: string; expires_at: string; client_id?: string }>(res);
	return { lockId: data.lock_id, expiresAt: data.expires_at, clientId: data.client_id };
}

/** POST /api/locks/:id/extend — renew a held lease (heartbeat). */
export async function extendWorkLock(lockId: string, durationMin?: number): Promise<WorkLockHandle> {
	const res = await apiFetch(`${BASE}/locks/${encodeURIComponent(lockId)}/extend`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ duration_min: durationMin }),
	});
	const data = await handleResponse<{ lock_id: string; expires_at: string }>(res);
	return { lockId: data.lock_id, expiresAt: data.expires_at };
}

/** POST /api/locks/:id/release — release a held lease (edit-end / page-switch / close). */
export async function releaseWorkLock(lockId: string): Promise<void> {
	const res = await apiFetch(`${BASE}/locks/${encodeURIComponent(lockId)}/release`, {
		method: "POST",
	});
	await handleResponse(res);
}
