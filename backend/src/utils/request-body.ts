import type { Context } from "hono";
import { RequestBodyLimitError } from "../middleware/security-guards.js";

export async function readJsonBody(c: Context): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
	try {
		return { ok: true, data: await c.req.json() };
	} catch (error) {
		// A body that STREAMS past MAX_JSON_BODY_SIZE_KB without an oversized
		// Content-Length is rejected mid-read: requestSizeGuard's withBodyLimit
		// wrapper calls `controller.error(new RequestBodyLimitError(...))`, so the
		// limit surfaces as a thrown RequestBodyLimitError *inside* this very
		// `c.req.json()` call. Mapping it to the generic 400 invalid_json here would
		// swallow the size signal and rob requestSizeGuard / globalErrorHandler of
		// the chance to emit the intended 413. Rethrow it so it propagates to that
		// 413 branch; only genuine JSON syntax errors fall through to the 400 below.
		if (error instanceof RequestBodyLimitError) throw error;
		return { ok: false, response: c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400) };
	}
}

/**
 * Read an optional JSON body, tolerating empty/missing bodies.
 *
 * Returns `{}` when the request carries no body (e.g. a bare `POST` that relies
 * on cookies instead of a JSON payload), while still rejecting a body that is
 * present but malformed. Used by flows that accept credentials from either the
 * request body or httpOnly cookies.
 */
export async function readOptionalJsonBody(c: Context): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; response: Response }> {
	const raw = await c.req.text();
	if (!raw.trim()) {
		return { ok: true, data: {} };
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return { ok: true, data: parsed as Record<string, unknown> };
		}
		return { ok: true, data: {} };
	} catch {
		return { ok: false, response: c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400) };
	}
}
