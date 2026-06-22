// ── Server-side AI error sanitizer (allowlist, defense-at-write) ──────────────
// Provider/internal AI errors can carry secrets and internal context that must
// NEVER be persisted or served over the API: an OpenAI 401 echoes the API key
// ("Incorrect API key provided: sk-proj-…2VAA") and a failure body can embed the
// full system/user translation PROMPT (or a role-dump like `User: …` /
// `Assistant: …`).
//
// The frontend already maps these to friendly category messages on render
// (frontend/src/lib/project/ai-job-copy.ts → resolveProviderErrorMessage), but
// that is render-time sanitization only: the RAW provider text was still being
// PERSISTED onto the AI review marker (`marker.error`) / the job record
// (`job.error`) / job-event metadata and SERVED over the markers + jobs APIs, so
// any client/role that can read that stored state saw the secret/prompt.
//
// This module is the server-side mirror of the FE contract: it is applied at the
// WRITE/persist layer so raw provider text never reaches storage or the API.
//
// ALLOWLIST MODEL (not denylist): we do NOT play whack-a-mole with leak SHAPES.
// Any text that comes from the AI PROVIDER / a persisted error is only ever
// stored as (a) one of the fixed friendly CATEGORY messages (auth/key,
// quota/credits, moderation, rate-limit, network/timeout/5xx) or (b) a single
// GENERIC fallback for ANYTHING unrecognised. Provider text is NEVER stored
// verbatim — not even redacted — so a brand-new leak shape (key, full prompt,
// `User:`/`Assistant:`/`System:` role-dump, JSON dump, …) can never reach
// storage or the API. The full technical detail stays in server logs only.

// The single generic fallback stored/returned for any unrecognised provider
// error. Mirrors the FE's AI_PROVIDER_GENERIC_ERROR copy so the stored value is
// already the friendly string even before the FE re-sanitizes it.
export const AI_PROVIDER_GENERIC_ERROR = "เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)";

function rawErrorText(error: unknown): string {
	if (typeof error === "string") return error.trim();
	if (error instanceof Error && typeof error.message === "string") return error.message.trim();
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message.trim();
	}
	return "";
}

/**
 * Map a raw provider/internal AI error to a fixed friendly CATEGORY message, or
 * null when the error is not a recognised category. Classification READS the raw
 * text (so it can still detect "sk-"/"api key"/401) but NEVER RETURNS it. Mirrors
 * the FE `mapKnownProviderFailure`.
 */
function mapKnownProviderFailure(raw: string): string | null {
	const lower = raw.toLowerCase();

	// Auth / key misconfiguration — the most sensitive case (a 401 echoes the key).
	if (
		lower.includes("401")
		|| lower.includes("invalid_api_key")
		|| lower.includes("incorrect api key")
		|| lower.includes("api key")
		|| lower.includes("api_key")
		|| lower.includes("unauthorized")
		|| lower.includes("authentication")
	) {
		return "บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ";
	}
	if (
		lower.includes("quota")
		|| lower.includes("insufficient_quota")
		|| lower.includes("billing")
		|| lower.includes("credit")
	) {
		return "AI ยังรันไม่ได้: เครดิตหรือโควตาไม่พอ";
	}
	if (
		lower.includes("moderation")
		|| lower.includes("content_policy")
		|| lower.includes("content policy")
		|| lower.includes("safety")
	) {
		return "ภาพหรือคำสั่งนี้ติดการตรวจเนื้อหา ปรับแล้วลองใหม่อีกครั้ง";
	}
	if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
		return "AI กำลังถูกใช้งานหนาแน่น รอสักครู่แล้วลองใหม่อีกครั้ง";
	}
	if (
		lower.includes("provider")
		|| lower.includes("503")
		|| lower.includes("502")
		|| lower.includes("504")
		|| lower.includes("500")
		|| lower.includes("network")
		|| lower.includes("timeout")
		|| lower.includes("timed out")
		|| lower.includes("fetch failed")
	) {
		return "สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง";
	}
	return null;
}

/**
 * ALLOWLIST resolver for ANY provider/internal AI error string at the persist
 * layer. Returns EXACTLY one of:
 *   (a) a fixed friendly CATEGORY message when the raw text matches a known
 *       provider-failure category, or
 *   (b) the single GENERIC fallback for ANYTHING else — including a raw key, a
 *       full prompt, a `User:`/`Assistant:`/`System:` role-dump, a JSON blob, or
 *       random `foobar`.
 *
 * It NEVER returns the raw/redacted provider text. Empty input returns the
 * provided `emptyFallback` (default: the generic message) so a caller can opt
 * into "" to clear an error field.
 */
export function sanitizeAiErrorForStorage(
	error: unknown,
	emptyFallback: string = AI_PROVIDER_GENERIC_ERROR,
): string {
	const raw = rawErrorText(error);
	if (!raw) return emptyFallback;
	const friendly = mapKnownProviderFailure(raw);
	if (friendly) return friendly;
	// Unrecognised → generic. We do NOT store raw or redacted provider text.
	return AI_PROVIDER_GENERIC_ERROR;
}

/**
 * Sanitize an optional stored error field (marker.error / job.error). Preserves
 * `undefined` (no error set) and empty/whitespace (cleared error) so we never
 * fabricate an error message onto a record that had none, while guaranteeing any
 * NON-empty value is the allowlisted friendly/generic string — never raw
 * provider text.
 */
export function sanitizeOptionalAiError(error: string | null | undefined): string | undefined {
	if (error === undefined || error === null) return undefined;
	if (!error.trim()) return undefined;
	return sanitizeAiErrorForStorage(error);
}

// Keys whose values, in job-event metadata, can carry a raw provider exception
// MESSAGE (e.g. `recordEvent(..., { error: err.message })`). These are
// sanitized in place before the event is persisted/served. We deliberately do
// NOT include `reason`: across the AI job/marker layer `reason` always holds a
// structured code (e.g. `shutdown_drain_timeout`, `job_retry`, `ai_output`) or a
// moderation category, never a raw provider exception string, so sanitizing it
// would clobber benign structured metadata.
const EVENT_METADATA_ERROR_KEYS = new Set(["error", "lastError", "providerError"]);

/**
 * Sanitize job-event metadata before it is stored/served. Any value under a key
 * that conventionally holds a provider error string is funnelled through the
 * allowlist resolver. Non-string values and unrelated keys are left untouched.
 * Returns a NEW object (does not mutate the caller's metadata).
 */
export function sanitizeAiEventMetadata(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!metadata) return metadata;
	let mutated = false;
	const next: Record<string, unknown> = { ...metadata };
	for (const key of Object.keys(next)) {
		if (!EVENT_METADATA_ERROR_KEYS.has(key)) continue;
		const value = next[key];
		if (typeof value !== "string" || !value.trim()) continue;
		const sanitized = sanitizeAiErrorForStorage(value);
		if (sanitized !== value) {
			next[key] = sanitized;
			mutated = true;
		}
	}
	return mutated ? next : metadata;
}
