/**
 * Shared HTTP-ish error contract for the global `app.onError` handler.
 *
 * Historically the global handler derived the response status by SUBSTRING-
 * matching the error message ("not found" → 404, "invalid"/"traversal" → 400,
 * else 500). That was broken in both directions: internal errors whose message
 * happened to contain a magic word leaked their status AND their raw message to
 * clients (e.g. "Redis AI queue snapshot is invalid: …" → 400 leaking Redis
 * internals), while genuine client errors without a magic word collapsed to a
 * generic 500. None of those bodies carried a `code`, so the frontend error
 * layer (which keys off `{ error, code }`) could not localize or branch.
 *
 * The fix is typed-error mapping: a thrown error that opts in to this contract
 * carries an explicit HTTP `status` and a stable machine-readable `code`. The
 * onError handler renders exactly `{ error: err.message, code: err.code }` with
 * `err.status`. Everything else collapses to a generic 500 with NO leaked
 * message.
 *
 * `isHttpishError` duck-types the contract so the existing typed errors
 * (WorkspaceAccessError, ByoApiError, DodoBillingError, …) qualify without a
 * shared base class or an import cycle. `HttpError` is the generic class for the
 * "no existing class fits" case.
 */

export interface HttpishError {
	readonly status: number;
	readonly code: string;
	readonly message: string;
}

/**
 * Generic typed error for routes/services that need an explicit client-facing
 * status + code but have no domain-specific error class.
 */
export class HttpError extends Error implements HttpishError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/**
 * True when `err` carries the HTTP-ish contract: a numeric `status` that is a
 * valid HTTP status code and a non-empty string `code`. Duck-typed so existing
 * typed errors qualify without sharing a base class.
 */
export function isHttpishError(err: unknown): err is HttpishError {
	if (!(err instanceof Error)) return false;
	const candidate = err as { status?: unknown; code?: unknown };
	return (
		typeof candidate.status === "number" &&
		Number.isInteger(candidate.status) &&
		candidate.status >= 400 &&
		candidate.status <= 599 &&
		typeof candidate.code === "string" &&
		candidate.code.length > 0
	);
}
