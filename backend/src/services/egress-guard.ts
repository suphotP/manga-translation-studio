// Route-level egress guard helpers.
//
// These Context-returning wrappers translate the egress-accounting service's
// reserve / record / abuse-throttle primitives into HTTP responses with the
// project's established fail-open (observe) / fail-closed (enforce) posture.
// They were originally private to routes/images.ts; they live here so EVERY
// byte-serving path (image serve, export object download, export-run artifact
// download) meters + abuse-throttles identically instead of one path being
// unmetered. A new served-bytes endpoint should call these, never re-implement
// the posture.

import type { Context } from "hono";
import {
	EgressAbuseThrottleError,
	EgressAccountingUnavailableError,
	EgressLimitExceededError,
	type AssetEgressRecordInput,
	assertProjectEgressNotThrottled,
	readEgressAbuseConfig,
	readEgressConfig,
	recordAssetEgressWithAllowance,
	releaseProjectEgressReservation,
	reserveProjectEgressForRead,
} from "./egress-accounting.js";

export type EgressGuardScope = "asset_read" | "token_issuance";

// Record the served bytes against the project's egress allowance, translating an
// over-cap / accounting-outage into the matching HTTP response. Returns null when
// the read is allowed to proceed.
export async function recordEgressWithAllowanceOrResponse(c: Context, input: AssetEgressRecordInput): Promise<Response | null> {
	try {
		await recordAssetEgressWithAllowance(input);
		return null;
	} catch (error) {
		if (error instanceof EgressLimitExceededError) {
			return c.json({
				error: "Asset egress limit exceeded",
				code: "asset_egress_limit_exceeded",
				attemptedBytes: error.attemptedBytes,
				egress: error.summary,
			}, 429);
		}
		if (error instanceof EgressAccountingUnavailableError) {
			console.error("[egress-guard] asset egress accounting unavailable", { projectId: input.projectId, operation: error.operation, error: error.cause });
			return c.json({
				error: "Asset egress accounting unavailable",
				code: "asset_egress_accounting_unavailable",
			}, 503);
		}
		const config = readEgressConfig();
		console.error("[egress-guard] asset egress allowance record failed", { projectId: input.projectId, imageId: input.imageId, error });
		if (config.enforced && config.limitBytes > 0) {
			return c.json({
				error: "Asset egress accounting unavailable",
				code: "asset_egress_accounting_unavailable",
			}, 503);
		}
		return null;
	}
}

export function buildEgressAbuseThrottleResponse(c: Context, error: EgressAbuseThrottleError): Response {
	return c.json({
		error: "Asset egress throttled due to abuse burst",
		code: "asset_egress_abuse_throttled",
		scope: error.scope,
		egressAbuse: error.decision,
	}, 429, {
		"Retry-After": String(error.decision.retryAfterSeconds),
	});
}

// Fail-closed fallback for an unexpected throttle-evaluation error. The service
// layer already converts config errors and accounting outages into throttle
// decisions (observe → fail-open, enforce → fail-closed), so reaching here is
// unexpected. If abuse enforcement is even potentially configured we must NOT
// turn the error into a successful read — that would silently disable the
// production shutoff. Surface 503 in that case; otherwise (abuse disabled) let
// the request proceed.
export function abuseEvaluationFailureResponse(c: Context, projectId: string, scope: string, error: unknown): Response | null {
	console.error("[egress-guard] asset egress abuse evaluation failed", { projectId, scope, error });
	let abuseConfigured = false;
	try {
		abuseConfigured = readEgressAbuseConfig().enabled;
	} catch {
		// Config itself is invalid while potentially enabled — treat as configured
		// so we fail closed rather than open.
		abuseConfigured = (process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES?.trim().length ?? 0) > 0;
	}
	if (abuseConfigured) {
		return c.json({
			error: "Asset egress accounting unavailable",
			code: "asset_egress_accounting_unavailable",
		}, 503);
	}
	return null;
}

// Read-only abuse-burst gate (no bytes served yet). Enforce mode returns 429 with
// Retry-After once the project crosses the egress threshold; observe mode never
// blocks and returns null.
export async function assertEgressNotThrottledOrResponse(c: Context, projectId: string, scope: EgressGuardScope): Promise<Response | null> {
	try {
		await assertProjectEgressNotThrottled(projectId, scope);
		return null;
	} catch (error) {
		if (error instanceof EgressAbuseThrottleError) {
			return buildEgressAbuseThrottleResponse(c, error);
		}
		return abuseEvaluationFailureResponse(c, projectId, scope, error);
	}
}

// Atomic abuse-burst gate for byte-serving reads: reserves the bytes this read is
// about to serve against the abuse window BEFORE returning them, closing the
// concurrent-burst hole where parallel reads all pass a stale pre-read check and
// then each serve. Returns a 429 in enforce mode once the reservation trips the
// threshold; observe mode never blocks. Bytes reserved here must be recorded with
// `skipAbuseReservation: true` to avoid double count.
export async function reserveEgressForReadOrResponse(c: Context, projectId: string, projectedBytes: number, scope: EgressGuardScope): Promise<Response | null> {
	try {
		await reserveProjectEgressForRead(projectId, projectedBytes, scope);
		return null;
	} catch (error) {
		if (error instanceof EgressAbuseThrottleError) {
			return buildEgressAbuseThrottleResponse(c, error);
		}
		return abuseEvaluationFailureResponse(c, projectId, scope, error);
	}
}

// Roll back an abuse-window reservation for a read that reserved bytes but is NOT
// being served (the normal egress cap rejected it). Best-effort: the rejection
// response has already been produced, so a failed rollback is swallowed by the
// service layer and must never override that response.
export async function releaseEgressReservationBestEffort(projectId: string, projectedBytes: number): Promise<void> {
	await releaseProjectEgressReservation(projectId, projectedBytes);
}
