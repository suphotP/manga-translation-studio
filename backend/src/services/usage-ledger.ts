import { getSharedBunSql } from "./sql-pool.js";
import { AsyncLocalStorage } from "async_hooks";
import { existsSync } from "fs";
import { join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { CENTS_PER_CREDIT, resolveWorkspacePlan } from "./plans.js";
import { dunningGraceActiveSql } from "./billing-store.js";
import type { ExportProfileId } from "../types/index.js";
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

/**
 * Request-scoped actor context for usage attribution.
 *
 * The actor user id is populated by the authenticated API layer (see
 * `routes/ai.ts`) from the verified session/JWT — it is NEVER read from a
 * client-supplied header, so it cannot be spoofed. AI credit ledger writes
 * fall back to this context when an explicit `actorUserId` is not supplied.
 */
const ledgerActorContext = new AsyncLocalStorage<{ actorUserId?: string }>();

/**
 * Run `fn` with the authenticated actor bound to the usage ledger context so
 * that AI credit reservations/capture/release recorded within attribute to
 * this user. Passing `undefined` runs without attribution (e.g. anonymous
 * prototype access).
 */
export function runWithLedgerActor<T>(actorUserId: string | undefined, fn: () => T): T {
	return ledgerActorContext.run({ actorUserId: normalizeActorUserId(actorUserId) }, fn);
}

/**
 * Read the authenticated actor bound to the current async context by
 * `runWithLedgerActor`, if any. Lets credit-consuming callers (e.g.
 * `submitAiJob`) derive the actor even when an explicit `actorUserId` was not
 * threaded through, so every submission path charges the new credit buckets.
 */
export function getLedgerActorUserId(): string | undefined {
	return ledgerActorContext.getStore()?.actorUserId;
}

/** Resolve the actor for a ledger write: explicit input wins, else the session context. */
function resolveLedgerActorUserId(explicit?: string): string | undefined {
	return normalizeActorUserId(explicit) ?? ledgerActorContext.getStore()?.actorUserId;
}

/**
 * Resolve the actor for a settlement (capture/release) write.
 *
 * Settlement runs in the queue worker, which may be woken by an unawaited
 * `processNext()` that inherited a DIFFERENT request's actor via async-local
 * context. To avoid mis-attributing user A's job to whoever happened to wake
 * the queue, the RESERVATION's recorded actor takes precedence over the
 * ambient context. Resolution order: explicit input (trusted internal callers)
 * → reservation actor → ambient session context (only when the reservation has
 * no recorded actor).
 */
function resolveSettlementActorUserId(explicit: string | undefined, reservationActorUserId: string | undefined): string | undefined {
	return normalizeActorUserId(explicit)
		?? normalizeActorUserId(reservationActorUserId)
		?? ledgerActorContext.getStore()?.actorUserId;
}

function normalizeActorUserId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 200) : undefined;
}

export type UsageEventKind =
	| "ai_credit_reserved"
	| "ai_credit_captured"
	| "ai_credit_released"
	| "upload_bytes_recorded"
	| "export_bytes_recorded"
	| "moderation_image_checked"
	// AI support-agent token spend (rank7). units=tokens, amountThb=tokens*rate.
	// Unlike the per-project credit kinds this feeds a GLOBAL cross-tenant monthly
	// budget meter (sumTicketAiTokensThb), not the per-project summarize().
	| "ticket_ai_tokens";

export interface UsageLedgerEvent {
	eventId: string;
	workspaceId: string;
	projectId: string;
	kind: UsageEventKind;
	subjectId: string;
	/** Authenticated user who triggered this usage, derived from the session (never spoofable). */
	actorUserId?: string;
	idempotencyKey?: string;
	amountThb?: number;
	bytes?: number;
	units?: number;
	createdAt: number;
	metadata?: Record<string, unknown>;
}

export interface UsageEventListOptions {
	limit?: number;
	cursor?: string;
	kind?: UsageEventKind;
	projectId?: string;
	subjectId?: string;
	actorUserId?: string;
}

export interface UsageEventPage {
	events: UsageLedgerEvent[];
	nextCursor?: string;
}

export interface UsagePlanConfig {
	planId: string;
	enforced: boolean;
	dailyAiCreditThb: number;
	monthlyAiCreditThb: number;
	dailyUploadBytes: number;
	monthlyUploadBytes: number;
	dailyExportBytes: number;
	monthlyExportBytes: number;
	maxEvents: number;
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
	// All-time count of workspace ledger events, CAPPED at WORKSPACE_EVENT_COUNT_CAP.
	// usage_events is the highest-volume append-only table (a row per AI reserve/
	// capture/release, upload, export, moderation, egress), so an exact unbounded
	// COUNT(*) is O(all-time rows) and its latency grows forever. eventCount is a
	// purely informational display value (an "events" badge — never read by any
	// quota/logic decision), so we stop counting at the cap: a value equal to the
	// cap means "at least this many" (render it with a "+" suffix). This bounds the
	// count query to O(cap) regardless of how large the workspace's ledger grows.
	eventCount: number;
	// True iff `eventCount` hit WORKSPACE_EVENT_COUNT_CAP, i.e. the real count is at
	// least the cap and the displayed value is a floor, not exact. Rides the JSON
	// contract so clients can render "100000+" instead of an exact-looking "100000".
	eventCountCapped: boolean;
}

/**
 * Upper bound for the displayed all-time `eventCount`. The exact COUNT(*) over the
 * append-only usage_events table grows without limit, but the value only feeds an
 * informational badge, so we bound the scan: the count query stops at the cap and
 * reports the cap as a "100000+" semantics ceiling. A consumer that sees
 * `eventCount === WORKSPACE_EVENT_COUNT_CAP` should treat it as "at least this many".
 */
export const WORKSPACE_EVENT_COUNT_CAP = 100_000;

/**
 * Apply the displayed-event-count cap to an exact count from an in-memory/filesystem
 * ledger (where the count is an array length, not a LIMITed query). Returns the value
 * clamped to the cap plus a `capped` flag, so the `{ eventCount, eventCountCapped }`
 * contract is identical whether the count came from Postgres (a LIMITed COUNT that
 * already stops at the cap) or from counting events in memory.
 */
function applyEventCountCap(exactCount: number): { eventCount: number; eventCountCapped: boolean } {
	const capped = exactCount >= WORKSPACE_EVENT_COUNT_CAP;
	return { eventCount: capped ? WORKSPACE_EVENT_COUNT_CAP : exactCount, eventCountCapped: capped };
}

export type UsageQuotaReason =
	| "daily_ai_credit_limit"
	| "monthly_ai_credit_limit"
	| "daily_upload_bytes_limit"
	| "monthly_upload_bytes_limit"
	| "daily_export_bytes_limit"
	| "monthly_export_bytes_limit";

export class UsageQuotaExceededError extends Error {
	readonly code = "usage_quota_exceeded";
	readonly reason: UsageQuotaReason;
	readonly summary: WorkspaceUsageSummary;
	readonly attempted: { amountThb?: number; bytes?: number };

	constructor(reason: UsageQuotaReason, summary: WorkspaceUsageSummary, attempted: { amountThb?: number; bytes?: number }) {
		super("Usage quota exceeded");
		this.name = "UsageQuotaExceededError";
		this.reason = reason;
		this.summary = summary;
		this.attempted = attempted;
	}
}

/**
 * Raised when an idempotency key is reused for a DIFFERENT usage kind than the
 * one it was first recorded under. Idempotency dedup is keyed on
 * `(workspaceId, idempotencyKey)` only, so a client-supplied export key that
 * collides with, say, an `ai_credit_reserved` key would otherwise return that
 * unrelated event and record 0 export bytes (silent quota under-count). We scope
 * dedup by kind and reject a mismatched-kind reuse loudly instead.
 */
export class UsageIdempotencyKindMismatchError extends Error {
	readonly code = "usage_idempotency_kind_mismatch";
	readonly idempotencyKey: string;
	readonly existingKind: UsageEventKind;
	readonly attemptedKind: UsageEventKind;

	constructor(idempotencyKey: string, existingKind: UsageEventKind, attemptedKind: UsageEventKind) {
		super(`Idempotency key already used for a different usage kind (${existingKind} != ${attemptedKind})`);
		this.name = "UsageIdempotencyKindMismatchError";
		this.idempotencyKey = idempotencyKey;
		this.existingKind = existingKind;
		this.attemptedKind = attemptedKind;
	}
}

interface UsageLedgerSnapshot {
	events: UsageLedgerEvent[];
}

interface AiReservationState {
	projectId: string;
	reservedAt: number;
	reservedThb: number;
	actorUserId?: string;
	capturedAt?: number;
	capturedThb?: number;
	releasedAt?: number;
}

interface UsageEventCursor {
	createdAt: number;
	eventId: string;
}

export interface AiCreditReserveInput {
	workspaceId?: string;
	projectId: string;
	jobId: string;
	amountThb: number;
	/** Authenticated actor; defaults to the session-scoped ledger actor when omitted. */
	actorUserId?: string;
	idempotencyKey?: string;
	metadata?: Record<string, unknown>;
	now?: number;
}

export interface AiCreditSettleInput {
	workspaceId?: string;
	projectId: string;
	jobId: string;
	status: "captured" | "released";
	amountThb?: number;
	/** Authenticated actor; defaults to the reservation's actor so capture/release stay attributed. */
	actorUserId?: string;
	reason?: string;
	now?: number;
}

export interface UploadUsageInput {
	workspaceId?: string;
	projectId: string;
	subjectId: string;
	bytes: number;
	idempotencyKey?: string;
	metadata?: Record<string, unknown>;
	now?: number;
}

export interface ExportUsageInput extends UploadUsageInput {
	pageIndexes?: number[];
	pageCount?: number;
	filename?: string;
	exportKind?: "single-page" | "batch-zip";
	targetProfile?: ExportProfileId;
	/**
	 * When explicitly `false`, record the export-bytes event WITHOUT the
	 * quota-exceeded throw — the bytes are always written, exceeding the limit as
	 * an overage. This is ONLY for the post-commit export-pipeline path, where the
	 * artifacts are already produced/committed and dropping accounting would lose
	 * money/usage. The pre-commit reservation gate (storage quota) and the manual
	 * export route keep enforcing (default/undefined = enforce). Idempotency is
	 * unchanged. Does NOT bypass enforcement for any other caller.
	 */
	enforce?: boolean;
}

export interface TicketAiTokenUsageInput {
	/** The support ticket the spend belongs to. */
	ticketId: string;
	/** The agent reply message id. (ticketId+messageId is the idempotency key.) */
	messageId: string;
	/** Real OpenAI token usage for the reply (prompt+completion). */
	tokens: number;
	/** THB per token; defaults to the configured support rate. */
	thbPerToken?: number;
	/** Authenticated actor (the ticket owner), for audit attribution. */
	actorUserId?: string;
	/**
	 * Optional originating workspace/project, recorded as audit METADATA only.
	 *
	 * IMPORTANT: this is NOT the storage scope. Support-agent spend is ALWAYS
	 * stored under the fixed synthetic `support` workspace/project so the
	 * `(workspace_id, idempotency_key)` uniqueness is GLOBAL on (ticketId,
	 * messageId) — a caller passing a different workspaceId can never split the
	 * idempotency and double-charge. Use these fields for attribution, not scoping.
	 */
	workspaceId?: string;
	projectId?: string;
	metadata?: Record<string, unknown>;
	now?: number;
}

// Synthetic scope for support-agent spend. It is a SINGLE FIXED shared scope so
// the events are easy to sum AND so the idempotency key is global on
// (ticketId, messageId): the caller cannot supply a workspaceId that splits the
// (workspace_id, idempotency_key) uniqueness and double-records the same reply.
// The budget meter is GLOBAL regardless (sumTicketAiTokensThb ignores workspace).
const SUPPORT_USAGE_WORKSPACE_ID = "support";
const SUPPORT_USAGE_PROJECT_ID = "support";

export interface UsageLedgerSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: UsageLedgerSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface UsageEventRow {
	event_id: string;
	workspace_id: string;
	project_id: string | null;
	kind: string;
	subject_id: string;
	actor_user_id?: string | null;
	idempotency_key?: string | null;
	amount_bytes?: number | string | null;
	amount_thb?: number | string | null;
	amount_units?: number | string | null;
	metadata?: unknown;
	created_at: Date | string;
}

interface UsageEventCountRow {
	event_count: number | string | bigint;
}

interface ProjectWorkspaceRow {
	workspace_id?: string | null;
}

interface WorkspaceUsagePlanRow {
	plan_id?: string | null;
	monthly_ai_credits?: number | string | null;
	addon_ai_credits?: number | string | null;
}

interface UsagePlanConfigOptions {
	monthlyAiCredits?: number;
	extraMonthlyAiCredits?: number;
}

export class UsageLedger {
	private readonly events: UsageLedgerEvent[] = [];

	constructor(private readonly persistPath: string) {
		this.load();
	}

	listEvents(): UsageLedgerEvent[] {
		return [...this.events];
	}

	listEventPage(workspaceId: string, options: UsageEventListOptions = {}): UsageEventPage {
		const limit = normalizeUsageEventLimit(options.limit);
		const cursor = decodeUsageEventCursor(options.cursor);
		const sorted = this.events
			.filter((event) => event.workspaceId === workspaceId)
			.filter((event) => !options.kind || event.kind === options.kind)
			.filter((event) => !options.projectId || event.projectId === options.projectId)
			.filter((event) => !options.subjectId || event.subjectId === options.subjectId)
			.filter((event) => !options.actorUserId || event.actorUserId === options.actorUserId)
			.sort(compareUsageEventOrder);
		const filtered = cursor ? sorted.filter((event) => usageEventSortsAfterCursor(event, cursor)) : sorted;
		const events = filtered.slice(0, limit);
		const lastEvent = events[events.length - 1];
		return {
			events,
			nextCursor: filtered.length > limit && lastEvent ? encodeUsageEventCursor(lastEvent) : undefined,
		};
	}

	summarize(workspaceId: string, projectId = workspaceId, now = Date.now(), config = readUsagePlanConfig()): WorkspaceUsageSummary {
		const states = this.buildAiReservationStates(workspaceId);
		const dailyStart = startOfUtcDay(now);
		const monthlyStart = startOfUtcMonth(now);
		const daily = this.summarizeWindow(workspaceId, dailyStart, formatUtcDayKey(now), states, {
			aiCreditThb: config.dailyAiCreditThb,
			uploadBytes: config.dailyUploadBytes,
			exportBytes: config.dailyExportBytes,
		});
		const monthly = this.summarizeWindow(workspaceId, monthlyStart, formatUtcMonthKey(now), states, {
			aiCreditThb: config.monthlyAiCreditThb,
			uploadBytes: config.monthlyUploadBytes,
			exportBytes: config.monthlyExportBytes,
		});

		return {
			workspaceId,
			projectId,
			planId: config.planId,
			enforced: config.enforced,
			daily,
			monthly,
			...applyEventCountCap(this.events.filter((event) => event.workspaceId === workspaceId).length),
		};
	}

	assertCanReserveAiCredit(input: AiCreditReserveInput, config = readUsagePlanConfig()): WorkspaceUsageSummary {
		const amountThb = safeAmount(input.amountThb);
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const summary = this.summarize(workspaceId, input.projectId, input.now, config);
		if (config.enforced) {
			assertThbLimit(summary, "daily_ai_credit_limit", summary.daily.aiCommittedThb + amountThb, summary.daily.limits.aiCreditThb, amountThb);
			assertThbLimit(summary, "monthly_ai_credit_limit", summary.monthly.aiCommittedThb + amountThb, summary.monthly.limits.aiCreditThb, amountThb);
		}
		return summary;
	}

	reserveAiCredit(input: AiCreditReserveInput, config = readUsagePlanConfig()): { event: UsageLedgerEvent; summary: WorkspaceUsageSummary } {
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const idempotencyKey = input.idempotencyKey ?? `ai-credit-reserve:${input.jobId}`;
		const existing = this.findEventByIdempotencyKey(workspaceId, idempotencyKey, "ai_credit_reserved");
		if (existing) {
			return {
				event: existing,
				summary: this.summarize(workspaceId, input.projectId, input.now, config),
			};
		}

		this.assertCanReserveAiCredit(input, config);
		const event = this.appendEvent({
			workspaceId,
			projectId: input.projectId,
			kind: "ai_credit_reserved",
			subjectId: input.jobId,
			actorUserId: resolveLedgerActorUserId(input.actorUserId),
			idempotencyKey,
			amountThb: safeAmount(input.amountThb),
			createdAt: input.now ?? Date.now(),
			metadata: input.metadata,
		}, config);
		return {
			event,
			summary: this.summarize(workspaceId, input.projectId, input.now, config),
		};
	}

	settleAiCredit(input: AiCreditSettleInput, config = readUsagePlanConfig()): UsageLedgerEvent | null {
		const explicitWorkspaceId = input.workspaceId?.trim();
		const workspaceId = explicitWorkspaceId
			|| this.findReservationWorkspaceId(input.jobId, input.projectId)
			|| resolveWorkspaceId(input.workspaceId, input.projectId);
		const existingTerminal = this.events.find((event) => (
			event.workspaceId === workspaceId
			&& event.subjectId === input.jobId
			&& (event.kind === "ai_credit_captured" || event.kind === "ai_credit_released")
		));
		if (existingTerminal) return existingTerminal;

		const state = this.buildAiReservationStates(workspaceId).get(input.jobId);
		const reservedThb = state?.reservedThb ?? safeAmount(input.amountThb);
		const settledThb = resolveAiSettlementAmount(input.status, input.amountThb, reservedThb);
		if (settledThb <= 0) return null;

		return this.appendEvent({
			workspaceId,
			projectId: input.projectId,
			kind: input.status === "captured" ? "ai_credit_captured" : "ai_credit_released",
			subjectId: input.jobId,
			actorUserId: resolveSettlementActorUserId(input.actorUserId, state?.actorUserId),
			idempotencyKey: `ai-credit-${input.status}:${input.jobId}`,
			amountThb: settledThb,
			createdAt: input.now ?? Date.now(),
			metadata: input.reason ? { reason: input.reason } : undefined,
		}, config);
	}

	private findReservationWorkspaceId(jobId: string, projectId: string): string | undefined {
		return [...this.events]
			.reverse()
			.find((event) => event.kind === "ai_credit_reserved" && event.subjectId === jobId && event.projectId === projectId)
			?.workspaceId;
	}

	assertCanRecordUpload(input: UploadUsageInput, config = readUsagePlanConfig()): WorkspaceUsageSummary {
		const bytes = safeBytes(input.bytes);
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const summary = this.summarize(workspaceId, input.projectId, input.now, config);
		if (config.enforced) {
			assertBytesLimit(summary, "daily_upload_bytes_limit", summary.daily.uploadBytes + bytes, summary.daily.limits.uploadBytes, bytes);
			assertBytesLimit(summary, "monthly_upload_bytes_limit", summary.monthly.uploadBytes + bytes, summary.monthly.limits.uploadBytes, bytes);
		}
		return summary;
	}

	recordUpload(input: UploadUsageInput, config = readUsagePlanConfig()): { event: UsageLedgerEvent; summary: WorkspaceUsageSummary } {
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const idempotencyKey = input.idempotencyKey ?? `upload-bytes:${input.subjectId}`;
		const existing = this.findEventByIdempotencyKey(workspaceId, idempotencyKey, "upload_bytes_recorded");
		if (existing) {
			return {
				event: existing,
				summary: this.summarize(workspaceId, input.projectId, input.now, config),
			};
		}

		this.assertCanRecordUpload(input, config);
		const event = this.appendEvent({
			workspaceId,
			projectId: input.projectId,
			kind: "upload_bytes_recorded",
			subjectId: input.subjectId,
			idempotencyKey,
			bytes: safeBytes(input.bytes),
			createdAt: input.now ?? Date.now(),
			metadata: input.metadata,
		}, config);
		return {
			event,
			summary: this.summarize(workspaceId, input.projectId, input.now, config),
		};
	}

	assertCanRecordExport(input: ExportUsageInput, config = readUsagePlanConfig()): WorkspaceUsageSummary {
		const bytes = safeBytes(input.bytes);
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const summary = this.summarize(workspaceId, input.projectId, input.now, config);
		if (config.enforced) {
			assertBytesLimit(summary, "daily_export_bytes_limit", summary.daily.exportBytes + bytes, summary.daily.limits.exportBytes, bytes);
			assertBytesLimit(summary, "monthly_export_bytes_limit", summary.monthly.exportBytes + bytes, summary.monthly.limits.exportBytes, bytes);
		}
		return summary;
	}

	recordExport(input: ExportUsageInput, config = readUsagePlanConfig()): { event: UsageLedgerEvent; summary: WorkspaceUsageSummary } {
		const workspaceId = resolveWorkspaceId(input.workspaceId, input.projectId);
		const idempotencyKey = input.idempotencyKey ?? `export-bytes:${input.subjectId}`;
		const existing = this.findEventByIdempotencyKey(workspaceId, idempotencyKey, "export_bytes_recorded");
		if (existing) {
			return {
				event: existing,
				summary: this.summarize(workspaceId, input.projectId, input.now, config),
			};
		}

		// enforce !== false keeps the quota throw for the reservation gate / manual
		// route; enforce === false (post-commit pipeline) records the overage.
		if (input.enforce !== false) this.assertCanRecordExport(input, config);
		const event = this.appendEvent({
			workspaceId,
			projectId: input.projectId,
			kind: "export_bytes_recorded",
			subjectId: input.subjectId,
			idempotencyKey,
			bytes: safeBytes(input.bytes),
			createdAt: input.now ?? Date.now(),
			metadata: {
				...input.metadata,
				pageIndexes: input.pageIndexes,
					pageCount: input.pageCount,
					filename: input.filename,
					exportKind: input.exportKind,
					targetProfile: input.targetProfile,
				},
		}, config);
		return {
			event,
			summary: this.summarize(workspaceId, input.projectId, input.now, config),
		};
	}

	/**
	 * Record AI support-agent token spend (rank7). Idempotent on
	 * `ticketId+messageId` GLOBALLY (the storage scope is the fixed synthetic
	 * `support` workspace, never the caller's), so a webhook retry / double-send —
	 * even under a different originating workspace — never double-charges the
	 * global budget. units=tokens, amountThb=tokens*rate. This event is NEVER part
	 * of the per-project summarize() — it is summed globally by sumTicketAiTokensThb().
	 *
	 * RECONCILE: if the same (ticketId, messageId) is re-recorded with a DIFFERENT
	 * amount (e.g. a corrected token count after a partial first write) we update
	 * the existing event to the new authoritative amount rather than silently
	 * keeping the stale/partial value (which would permanently under- or
	 * over-count the budget meter). The reconciliation is logged.
	 */
	recordTicketAiTokens(input: TicketAiTokenUsageInput, config = readUsagePlanConfig()): UsageLedgerEvent {
		const { workspaceId, projectId, idempotencyKey } = resolveTicketAiTokenScope(input);
		const { amountThb, units } = ticketAiTokenAmounts(input);
		const existing = this.findEventByIdempotencyKey(workspaceId, idempotencyKey, "ticket_ai_tokens");
		if (existing) {
			return this.reconcileTicketAiTokens(existing, amountThb, units);
		}
		return this.appendEvent({
			workspaceId,
			projectId,
			kind: "ticket_ai_tokens",
			subjectId: input.ticketId,
			actorUserId: resolveLedgerActorUserId(input.actorUserId),
			idempotencyKey,
			amountThb,
			units,
			createdAt: input.now ?? Date.now(),
			metadata: ticketAiMetadata(input),
		}, config);
	}

	// Reconcile an already-recorded ticket-AI-tokens event to the authoritative
	// amount when a retry carries a different value. Same-amount retries are a
	// no-op (true idempotency). Mutates in place + re-persists with rollback so a
	// persistence failure never leaves an in-memory amount the disk does not have.
	private reconcileTicketAiTokens(existing: UsageLedgerEvent, amountThb: number, units: number): UsageLedgerEvent {
		const sameAmount = roundCurrency(safeAmount(existing.amountThb)) === roundCurrency(amountThb)
			&& safeBytes(existing.units) === units;
		if (sameAmount) return existing;
		const prev = { amountThb: existing.amountThb, units: existing.units };
		existing.amountThb = amountThb;
		existing.units = units;
		try {
			this.persist();
		} catch (error) {
			existing.amountThb = prev.amountThb;
			existing.units = prev.units;
			throw error;
		}
		console.warn(`[UsageLedger] Reconciled ticket_ai_tokens ${existing.idempotencyKey}: amountThb ${prev.amountThb} -> ${amountThb}, units ${prev.units} -> ${units}`);
		return existing;
	}

	/**
	 * GLOBAL (cross-tenant) sum of support-agent THB spend since `startMs`. This is
	 * the hard monthly budget meter (Layer 3) and intentionally does NOT reuse the
	 * per-project summarize() — that one is keyed per workspace and would miss spend
	 * attributed to other synthetic support scopes.
	 */
	sumTicketAiTokensThb(startMs: number): number {
		return roundCurrency(this.events
			.filter((event) => event.kind === "ticket_ai_tokens" && event.createdAt >= startMs)
			.reduce((total, event) => total + safeAmount(event.amountThb), 0));
	}

	private appendEvent(input: Omit<UsageLedgerEvent, "eventId">, config: UsagePlanConfig): UsageLedgerEvent {
		const previousEvents = [...this.events];
		const event: UsageLedgerEvent = {
			...input,
			eventId: `${input.kind}:${input.workspaceId}:${input.subjectId}:${input.createdAt}:${this.events.length}`,
		};
		this.events.push(event);
		this.prune(config.maxEvents);
		try {
			this.persist();
		} catch (error) {
			this.events.splice(0, this.events.length, ...previousEvents);
			throw error;
		}
		return event;
	}

	private summarizeWindow(
		workspaceId: string,
		startMs: number,
		periodKey: string,
		aiStates: Map<string, AiReservationState>,
		limits: UsageWindowSummary["limits"],
	): UsageWindowSummary {
		const windowEvents = this.events.filter((event) => event.workspaceId === workspaceId && event.createdAt >= startMs);
		const aiCapturedThb = sumAmounts(windowEvents.filter((event) => event.kind === "ai_credit_captured"));
		const aiActiveReservedThb = sumActiveReserved(aiStates);
		const uploadBytes = sumBytes(windowEvents.filter((event) => event.kind === "upload_bytes_recorded"));
		const exportBytes = sumBytes(windowEvents.filter((event) => event.kind === "export_bytes_recorded"));
		const moderationImages = sumUnits(windowEvents.filter((event) => event.kind === "moderation_image_checked"));
		const aiCommittedThb = roundCurrency(aiCapturedThb + aiActiveReservedThb);

		return {
			periodKey,
			aiCapturedThb,
			aiActiveReservedThb,
			aiCommittedThb,
			uploadBytes,
			exportBytes,
			moderationImages,
			limits,
			remaining: {
				aiCreditThb: remainingValue(limits.aiCreditThb, aiCommittedThb),
				uploadBytes: remainingValue(limits.uploadBytes, uploadBytes),
				exportBytes: remainingValue(limits.exportBytes, exportBytes),
			},
			percentUsed: {
				aiCredit: percentUsed(aiCommittedThb, limits.aiCreditThb),
				uploadBytes: percentUsed(uploadBytes, limits.uploadBytes),
				exportBytes: percentUsed(exportBytes, limits.exportBytes),
			},
		};
	}

	private buildAiReservationStates(workspaceId: string): Map<string, AiReservationState> {
		const states = new Map<string, AiReservationState>();
		for (const event of this.events) {
			if (event.workspaceId !== workspaceId || !event.kind.startsWith("ai_credit_")) continue;
			const existing = states.get(event.subjectId) ?? {
				projectId: event.projectId,
				reservedAt: event.createdAt,
				reservedThb: 0,
			};
			if (event.kind === "ai_credit_reserved") {
				existing.reservedAt = event.createdAt;
				existing.reservedThb = safeAmount(event.amountThb);
				existing.actorUserId = event.actorUserId;
			} else if (event.kind === "ai_credit_captured") {
				existing.capturedAt = event.createdAt;
				existing.capturedThb = safeAmount(event.amountThb);
			} else if (event.kind === "ai_credit_released") {
				existing.releasedAt = event.createdAt;
			}
			states.set(event.subjectId, existing);
		}
		return states;
	}

	private findEventByIdempotencyKey(workspaceId: string, idempotencyKey: string, expectedKind?: UsageEventKind): UsageLedgerEvent | undefined {
		const match = this.events.find((event) => event.workspaceId === workspaceId && event.idempotencyKey === idempotencyKey);
		assertIdempotencyKindMatch(match, expectedKind, idempotencyKey);
		return match;
	}

	private prune(maxEvents: number): void {
		if (maxEvents <= 0 || this.events.length <= maxEvents) return;
		this.events.splice(0, this.events.length - maxEvents);
	}

	private load(): void {
		if (!existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<UsageLedgerSnapshot>(this.persistPath);
			if (Array.isArray(snapshot.events)) {
				this.events.splice(0, this.events.length, ...snapshot.events.filter(isUsageLedgerEvent));
			}
		} catch (error) {
			console.warn(`[UsageLedger] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		// Money state: route through the crash-safe atomic helper (temp + fsync +
		// rename) so a crash or full disk mid-write cannot truncate the usage ledger
		// — a partial file would be discarded by load() as malformed, silently losing
		// every reserved/captured credit event. writeFileAtomic ensures the parent
		// directory exists, so the prior explicit mkdirSync is no longer needed.
		writeFileAtomic(this.persistPath, JSON.stringify({ events: this.events }, null, 2));
	}
}

export class PostgresUsageLedger {
	private readonly client: UsageLedgerSqlClient;

	constructor(databaseUrlOrClient: string | UsageLedgerSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("USAGE_LEDGER_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as UsageLedgerSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async listEvents(workspaceId?: string): Promise<UsageLedgerEvent[]> {
		if (workspaceId?.trim()) {
			const rows = await this.client.unsafe<UsageEventRow>(`
				SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
				FROM usage_events
				WHERE workspace_id = $1
				ORDER BY created_at ASC
			`, [workspaceId.trim()]);
			return rows.map(mapUsageEventRow).filter(isUsageLedgerEvent);
		}
		const rows = await this.client.unsafe<UsageEventRow>(`
			SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
			FROM usage_events
			ORDER BY created_at ASC
		`);
		return rows.map(mapUsageEventRow).filter(isUsageLedgerEvent);
	}

	async listEventPage(workspaceId: string, options: UsageEventListOptions = {}): Promise<UsageEventPage> {
		const limit = normalizeUsageEventLimit(options.limit);
		const cursor = decodeUsageEventCursor(options.cursor);
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [workspaceId.trim()];
		if (options.kind) {
			params.push(options.kind);
			conditions.push(`kind = $${params.length}`);
		}
		if (options.projectId) {
			params.push(options.projectId);
			conditions.push(`project_id = $${params.length}`);
		}
		if (options.subjectId) {
			params.push(options.subjectId);
			conditions.push(`subject_id = $${params.length}`);
		}
		if (options.actorUserId) {
			params.push(options.actorUserId);
			conditions.push(`actor_user_id = $${params.length}`);
		}
		if (cursor) {
			params.push(new Date(cursor.createdAt).toISOString(), cursor.eventId);
			conditions.push(`(created_at < $${params.length - 1}::timestamptz OR (created_at = $${params.length - 1}::timestamptz AND event_id < $${params.length}))`);
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<UsageEventRow>(`
			SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
			FROM usage_events
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, event_id DESC
			LIMIT $${params.length}
		`, params);
		const events = rows.slice(0, limit).map(mapUsageEventRow).filter(isUsageLedgerEvent);
		const lastEvent = events[events.length - 1];
		return {
			events,
			nextCursor: rows.length > limit && lastEvent ? encodeUsageEventCursor(lastEvent) : undefined,
		};
	}

	async listProjectEventPage(projectId: string, options: UsageEventListOptions = {}): Promise<UsageEventPage> {
		const workspaceId = await this.resolveWorkspaceId(this.client, undefined, projectId);
		return this.listEventPage(workspaceId, { ...options, projectId });
	}

	async summarize(workspaceId: string, projectId = workspaceId, now = Date.now(), config?: UsagePlanConfig): Promise<WorkspaceUsageSummary> {
		// Pooled (non-transactional) read path: safe to issue the three independent
		// reads concurrently (rank13).
		return this.summarizeWithClient(this.client, workspaceId, projectId, now, config, true);
	}

	async summarizeProject(projectId: string, now = Date.now(), config?: UsagePlanConfig): Promise<WorkspaceUsageSummary> {
		const workspaceId = await this.resolveWorkspaceId(this.client, undefined, projectId);
		return this.summarizeWithClient(this.client, workspaceId, projectId, now, config, true);
	}

	async assertCanReserveAiCredit(input: AiCreditReserveInput, config?: UsagePlanConfig): Promise<WorkspaceUsageSummary> {
		const amountThb = safeAmount(input.amountThb);
		const workspaceId = await this.resolveWorkspaceId(this.client, input.workspaceId, input.projectId);
		const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(this.client, workspaceId, config, input.now);
		const summary = await this.summarize(workspaceId, input.projectId, input.now, resolvedConfig);
		if (resolvedConfig.enforced) {
			assertThbLimit(summary, "daily_ai_credit_limit", summary.daily.aiCommittedThb + amountThb, summary.daily.limits.aiCreditThb, amountThb);
			assertThbLimit(summary, "monthly_ai_credit_limit", summary.monthly.aiCommittedThb + amountThb, summary.monthly.limits.aiCreditThb, amountThb);
		}
		return summary;
	}

	async reserveAiCredit(input: AiCreditReserveInput, config?: UsagePlanConfig): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
		const idempotencyKey = input.idempotencyKey ?? `ai-credit-reserve:${input.jobId}`;
		return this.transaction(async (client) => {
			const workspaceId = await this.resolveWorkspaceId(client, input.workspaceId, input.projectId);
			await this.lockWorkspace(client, workspaceId);
			const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(client, workspaceId, config, input.now);
			const existing = await this.findEventByIdempotencyKey(client, workspaceId, idempotencyKey, "ai_credit_reserved");
			if (existing) {
				return {
					event: existing,
					summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
				};
			}

			const amountThb = safeAmount(input.amountThb);
			const summary = await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig);
			if (resolvedConfig.enforced) {
				assertThbLimit(summary, "daily_ai_credit_limit", summary.daily.aiCommittedThb + amountThb, summary.daily.limits.aiCreditThb, amountThb);
				assertThbLimit(summary, "monthly_ai_credit_limit", summary.monthly.aiCommittedThb + amountThb, summary.monthly.limits.aiCreditThb, amountThb);
			}
			const event = await this.insertEvent(client, {
				workspaceId,
				projectId: input.projectId,
				kind: "ai_credit_reserved",
				subjectId: input.jobId,
				actorUserId: resolveLedgerActorUserId(input.actorUserId),
				idempotencyKey,
				amountThb,
				createdAt: input.now ?? Date.now(),
				metadata: input.metadata,
			});
			return {
				event,
				summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
			};
		});
	}

	async settleAiCredit(input: AiCreditSettleInput, config?: UsagePlanConfig): Promise<UsageLedgerEvent | null> {
		return this.transaction(async (client) => {
			const workspaceId = await this.resolveSettlementWorkspaceId(client, input);
			await this.lockWorkspace(client, workspaceId);
			const existingTerminalEvent = await this.findAiCreditTerminalEvent(client, workspaceId, input.jobId);
			if (existingTerminalEvent) return existingTerminalEvent;
			const events = await this.loadSummaryEvents(client, workspaceId, input.now ?? Date.now());
			const existingTerminal = events.find((event) => (
				event.workspaceId === workspaceId
				&& event.subjectId === input.jobId
				&& (event.kind === "ai_credit_captured" || event.kind === "ai_credit_released")
			));
			if (existingTerminal) return existingTerminal;

			const state = buildAiReservationStatesFromEvents(events, workspaceId).get(input.jobId);
			const reservedThb = state?.reservedThb ?? safeAmount(input.amountThb);
			const settledThb = resolveAiSettlementAmount(input.status, input.amountThb, reservedThb);
			if (settledThb <= 0) return null;

			return this.insertEvent(client, {
				workspaceId,
				projectId: input.projectId,
				kind: input.status === "captured" ? "ai_credit_captured" : "ai_credit_released",
				subjectId: input.jobId,
				actorUserId: resolveSettlementActorUserId(input.actorUserId, state?.actorUserId),
				idempotencyKey: `ai-credit-${input.status}:${input.jobId}`,
				amountThb: settledThb,
				createdAt: input.now ?? Date.now(),
				metadata: input.reason ? { reason: input.reason } : undefined,
			});
		});
	}

	async assertCanRecordUpload(input: UploadUsageInput, config?: UsagePlanConfig): Promise<WorkspaceUsageSummary> {
		const bytes = safeBytes(input.bytes);
		const workspaceId = await this.resolveWorkspaceId(this.client, input.workspaceId, input.projectId);
		const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(this.client, workspaceId, config, input.now);
		const summary = await this.summarize(workspaceId, input.projectId, input.now, resolvedConfig);
		if (resolvedConfig.enforced) {
			assertBytesLimit(summary, "daily_upload_bytes_limit", summary.daily.uploadBytes + bytes, summary.daily.limits.uploadBytes, bytes);
			assertBytesLimit(summary, "monthly_upload_bytes_limit", summary.monthly.uploadBytes + bytes, summary.monthly.limits.uploadBytes, bytes);
		}
		return summary;
	}

	async recordUpload(input: UploadUsageInput, config?: UsagePlanConfig): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
		const idempotencyKey = input.idempotencyKey ?? `upload-bytes:${input.subjectId}`;
		return this.transaction(async (client) => {
			const workspaceId = await this.resolveWorkspaceId(client, input.workspaceId, input.projectId);
			await this.lockWorkspace(client, workspaceId);
			const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(client, workspaceId, config, input.now);
			const existing = await this.findEventByIdempotencyKey(client, workspaceId, idempotencyKey, "upload_bytes_recorded");
			if (existing) {
				return {
					event: existing,
					summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
				};
			}

			const bytes = safeBytes(input.bytes);
			const summary = await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig);
			if (resolvedConfig.enforced) {
				assertBytesLimit(summary, "daily_upload_bytes_limit", summary.daily.uploadBytes + bytes, summary.daily.limits.uploadBytes, bytes);
				assertBytesLimit(summary, "monthly_upload_bytes_limit", summary.monthly.uploadBytes + bytes, summary.monthly.limits.uploadBytes, bytes);
			}
			const event = await this.insertEvent(client, {
				workspaceId,
				projectId: input.projectId,
				kind: "upload_bytes_recorded",
				subjectId: input.subjectId,
				idempotencyKey,
				bytes,
				createdAt: input.now ?? Date.now(),
				metadata: input.metadata,
			});
			return {
				event,
				summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
			};
		});
	}

	async assertCanRecordExport(input: ExportUsageInput, config?: UsagePlanConfig): Promise<WorkspaceUsageSummary> {
		const bytes = safeBytes(input.bytes);
		const workspaceId = await this.resolveWorkspaceId(this.client, input.workspaceId, input.projectId);
		const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(this.client, workspaceId, config, input.now);
		const summary = await this.summarize(workspaceId, input.projectId, input.now, resolvedConfig);
		if (resolvedConfig.enforced) {
			assertBytesLimit(summary, "daily_export_bytes_limit", summary.daily.exportBytes + bytes, summary.daily.limits.exportBytes, bytes);
			assertBytesLimit(summary, "monthly_export_bytes_limit", summary.monthly.exportBytes + bytes, summary.monthly.limits.exportBytes, bytes);
		}
		return summary;
	}

	async recordExport(input: ExportUsageInput, config?: UsagePlanConfig): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
		const idempotencyKey = input.idempotencyKey ?? `export-bytes:${input.subjectId}`;
		return this.transaction(async (client) => {
			const workspaceId = await this.resolveWorkspaceId(client, input.workspaceId, input.projectId);
			await this.lockWorkspace(client, workspaceId);
			const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(client, workspaceId, config, input.now);
			const existing = await this.findEventByIdempotencyKey(client, workspaceId, idempotencyKey, "export_bytes_recorded");
			if (existing) {
				return {
					event: existing,
					summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
				};
			}

			const bytes = safeBytes(input.bytes);
			const summary = await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig);
			// enforce !== false keeps the quota throw; enforce === false (post-commit
			// pipeline) records the overage instead of dropping accounting.
			if (resolvedConfig.enforced && input.enforce !== false) {
				assertBytesLimit(summary, "daily_export_bytes_limit", summary.daily.exportBytes + bytes, summary.daily.limits.exportBytes, bytes);
				assertBytesLimit(summary, "monthly_export_bytes_limit", summary.monthly.exportBytes + bytes, summary.monthly.limits.exportBytes, bytes);
			}
			const event = await this.insertEvent(client, {
				workspaceId,
				projectId: input.projectId,
				kind: "export_bytes_recorded",
				subjectId: input.subjectId,
				idempotencyKey,
				bytes,
				createdAt: input.now ?? Date.now(),
				metadata: {
					...input.metadata,
					pageIndexes: input.pageIndexes,
					pageCount: input.pageCount,
					filename: input.filename,
					exportKind: input.exportKind,
					targetProfile: input.targetProfile,
				},
			});
			return {
				event,
				summary: await this.summarizeWithClient(client, workspaceId, input.projectId, input.now, resolvedConfig),
			};
		});
	}

	/**
	 * Record AI support-agent token spend (rank7), idempotent on ticketId+messageId
	 * GLOBALLY via the usage_events (workspace_id, idempotency_key) unique
	 * constraint — the storage scope is the FIXED synthetic `support` workspace
	 * (never the caller's), so the same reply under a different originating
	 * workspace can never split the key and double-record. See the File ledger twin.
	 *
	 * RECONCILE: a retry carrying a DIFFERENT amount for the same key UPDATEs the
	 * row to the new authoritative amount (not a silent no-op), so a corrected
	 * token count can never leave the global budget meter permanently under-counted.
	 * The whole thing runs under the per-workspace advisory lock so a concurrent
	 * retry can't race the read-then-reconcile.
	 */
	async recordTicketAiTokens(input: TicketAiTokenUsageInput, config?: UsagePlanConfig): Promise<UsageLedgerEvent> {
		void config;
		const { workspaceId, projectId, idempotencyKey } = resolveTicketAiTokenScope(input);
		const { amountThb, units } = ticketAiTokenAmounts(input);
		return this.transaction(async (client) => {
			await this.lockWorkspace(client, workspaceId);
			const existing = await this.findEventByIdempotencyKey(client, workspaceId, idempotencyKey, "ticket_ai_tokens");
			if (existing) {
				return this.reconcileTicketAiTokens(client, existing, amountThb, units);
			}
			return this.insertEvent(client, {
				workspaceId,
				projectId,
				kind: "ticket_ai_tokens",
				subjectId: input.ticketId,
				actorUserId: resolveLedgerActorUserId(input.actorUserId),
				idempotencyKey,
				amountThb,
				units,
				createdAt: input.now ?? Date.now(),
				metadata: ticketAiMetadata(input),
			});
		});
	}

	// Reconcile an already-persisted ticket-AI-tokens event to the authoritative
	// amount when a retry carries a different value. Same-amount retries are a
	// true no-op. Updates by event_id (the PK) so it targets exactly the matched row.
	private async reconcileTicketAiTokens(client: UsageLedgerSqlClient, existing: UsageLedgerEvent, amountThb: number, units: number): Promise<UsageLedgerEvent> {
		const sameAmount = roundCurrency(safeAmount(existing.amountThb)) === roundCurrency(amountThb)
			&& safeBytes(existing.units) === units;
		if (sameAmount) return existing;
		const rows = await client.unsafe<UsageEventRow>(`
			UPDATE usage_events
			SET amount_thb = $2, amount_units = $3
			WHERE event_id = $1
			RETURNING event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
		`, [existing.eventId, amountThb, units]);
		const row = rows[0];
		if (!row) return existing;
		console.warn(`[UsageLedger] Reconciled ticket_ai_tokens ${existing.idempotencyKey}: amountThb ${existing.amountThb} -> ${amountThb}, units ${existing.units} -> ${units}`);
		return mapUsageEventRow(row);
	}

	/**
	 * GLOBAL (cross-tenant) sum of support-agent THB spend since `startMs` — its OWN
	 * summed query, NOT the per-project summarize(). This is the hard budget meter.
	 */
	async sumTicketAiTokensThb(startMs: number): Promise<number> {
		const rows = await this.client.unsafe<{ total_thb: number | string | null }>(`
			SELECT COALESCE(SUM(amount_thb), 0) AS total_thb
			FROM usage_events
			WHERE kind = 'ticket_ai_tokens'
				AND created_at >= to_timestamp($1::double precision / 1000.0)
		`, [startMs]);
		return roundCurrency(safeAmount(toNumber(rows[0]?.total_thb)));
	}

	// `concurrent` runs the three independent reads (config resolution, the
	// bounded summary-event load, and the all-time event count) in parallel. It is
	// ONLY safe on a pooled connection: a transaction-reserved connection is a
	// single serial session, so transactional callers must leave it false and let
	// the reads run sequentially.
	private async summarizeWithClient(client: UsageLedgerSqlClient, workspaceId: string, projectId = workspaceId, now = Date.now(), config?: UsagePlanConfig, concurrent = false): Promise<WorkspaceUsageSummary> {
		// rank13: `eventCount` is the all-time workspace total (see
		// countWorkspaceEvents / the "counts all workspace ledger events" test), so
		// its semantics are unchanged — the only difference here is that, off the
		// transaction path, the unbounded COUNT no longer waits behind the bounded
		// event load: the three independent reads are issued together.
		if (concurrent) {
			const [resolvedConfig, events, eventCount] = await Promise.all([
				this.resolveWorkspaceUsagePlanConfig(client, workspaceId, config, now),
				this.loadSummaryEvents(client, workspaceId, now),
				this.countWorkspaceEvents(client, workspaceId),
			]);
			return {
				...summarizeUsageEvents(events, workspaceId, projectId, now, resolvedConfig),
				eventCount,
				eventCountCapped: eventCount >= WORKSPACE_EVENT_COUNT_CAP,
			};
		}
		const resolvedConfig = await this.resolveWorkspaceUsagePlanConfig(client, workspaceId, config, now);
		const events = await this.loadSummaryEvents(client, workspaceId, now);
		const summary = summarizeUsageEvents(events, workspaceId, projectId, now, resolvedConfig);
		const eventCount = await this.countWorkspaceEvents(client, workspaceId);
		return {
			...summary,
			eventCount,
			eventCountCapped: eventCount >= WORKSPACE_EVENT_COUNT_CAP,
		};
	}

	private async loadSummaryEvents(client: UsageLedgerSqlClient, workspaceId: string, now = Date.now()): Promise<UsageLedgerEvent[]> {
		const monthlyStart = startOfUtcMonth(now);
		const rows = await client.unsafe<UsageEventRow>(`
			SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
			FROM usage_events
			WHERE workspace_id = $1
				AND (
					created_at >= to_timestamp($2::double precision / 1000.0)
					OR (
						kind = 'ai_credit_reserved'
						AND NOT EXISTS (
							SELECT 1
							FROM usage_events terminal
							WHERE terminal.workspace_id = usage_events.workspace_id
								AND terminal.subject_id = usage_events.subject_id
								AND terminal.kind IN ('ai_credit_captured', 'ai_credit_released')
						)
					)
				)
			ORDER BY created_at ASC
		`, [workspaceId, monthlyStart]);
		return rows.map(mapUsageEventRow).filter(isUsageLedgerEvent);
	}

	private async findAiCreditTerminalEvent(client: UsageLedgerSqlClient, workspaceId: string, jobId: string): Promise<UsageLedgerEvent | null> {
		const rows = await client.unsafe<UsageEventRow>(`
			SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
			FROM usage_events
			WHERE workspace_id = $1
				AND subject_id = $2
				AND kind IN ('ai_credit_captured', 'ai_credit_released')
			ORDER BY created_at DESC, event_id DESC
			LIMIT 1
		`, [workspaceId, jobId]);
		const row = rows[0];
		if (!row) return null;
		const event = mapUsageEventRow(row);
		return isUsageLedgerEvent(event) ? event : null;
	}

	// Bounded all-time event count for the workspace. usage_events is the highest-
	// volume append-only table, so an exact `COUNT(*) WHERE workspace_id=$1` is
	// O(all-time rows) and its latency grows forever — yet the value only feeds an
	// informational "events" badge (never any quota/logic decision). We stop counting
	// at WORKSPACE_EVENT_COUNT_CAP by counting a LIMITed subquery, so the index scan
	// reads at most cap+1 rows regardless of how large the ledger grows. A returned
	// value equal to the cap means "at least this many" (rendered with a "+").
	private async countWorkspaceEvents(client: UsageLedgerSqlClient, workspaceId: string): Promise<number> {
		const rows = await client.unsafe<UsageEventCountRow>(`
			SELECT COUNT(*) AS event_count
			FROM (
				SELECT 1
				FROM usage_events
				WHERE workspace_id = $1
				LIMIT $2
			) capped
		`, [workspaceId, WORKSPACE_EVENT_COUNT_CAP]);
		return safeBytes(toNumber(rows[0]?.event_count));
	}

	private async findEventByIdempotencyKey(client: UsageLedgerSqlClient, workspaceId: string, idempotencyKey: string, expectedKind?: UsageEventKind): Promise<UsageLedgerEvent | null> {
		const rows = await client.unsafe<UsageEventRow>(`
			SELECT event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
			FROM usage_events
			WHERE workspace_id = $1 AND idempotency_key = $2
			LIMIT 1
		`, [workspaceId, idempotencyKey]);
		const event = rows[0] ? mapUsageEventRow(rows[0]) : null;
		assertIdempotencyKindMatch(event, expectedKind, idempotencyKey);
		return event;
	}

	private async insertEvent(client: UsageLedgerSqlClient, input: Omit<UsageLedgerEvent, "eventId">): Promise<UsageLedgerEvent> {
		await this.ensureUsageTarget(client, input.workspaceId, input.projectId);
		const eventId = `${input.kind}:${input.workspaceId}:${input.subjectId}:${input.createdAt}:${crypto.randomUUID()}`;
		const rows = await client.unsafe<UsageEventRow>(`
			INSERT INTO usage_events (
				event_id,
				workspace_id,
				project_id,
				kind,
				subject_id,
				idempotency_key,
				amount_bytes,
				amount_thb,
				amount_units,
				metadata,
				created_at,
				actor_user_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb, to_timestamp($11::double precision / 1000.0), $12)
			ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
				metadata = usage_events.metadata
			RETURNING event_id, workspace_id, project_id, kind, subject_id, actor_user_id, idempotency_key, amount_bytes, amount_thb, amount_units, metadata, created_at
		`, [
			eventId,
			input.workspaceId,
			input.projectId,
			input.kind,
			input.subjectId,
			input.idempotencyKey ?? null,
			input.bytes ?? null,
			input.amountThb ?? null,
			input.units ?? null,
			JSON.stringify(input.metadata ?? {}),
			input.createdAt,
			input.actorUserId ?? null,
		]);
		const row = rows[0];
		if (!row) throw new Error("usage_events INSERT did not return a row");
		return mapUsageEventRow(row);
	}

	private async ensureUsageTarget(client: UsageLedgerSqlClient, workspaceId: string, projectId: string): Promise<void> {
		await client.unsafe(`
			INSERT INTO workspaces (workspace_id, name, plan_id)
			VALUES ($1, $2, 'prototype')
			ON CONFLICT (workspace_id) DO NOTHING
		`, [workspaceId, `Legacy workspace ${projectId}`]);
		await client.unsafe(`
			INSERT INTO projects (project_id, workspace_id, title, metadata, deleted_at)
			VALUES ($1, $2, $3, $4::text::jsonb, now())
			ON CONFLICT (project_id) DO NOTHING
		`, [projectId, workspaceId, `Legacy project ${projectId}`, JSON.stringify({ usageLedgerPlaceholder: true })]);
	}

	private async lockWorkspace(client: UsageLedgerSqlClient, workspaceId: string): Promise<void> {
		await client.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`usage-ledger:${workspaceId}`]);
	}

	private async resolveWorkspaceId(client: UsageLedgerSqlClient, workspaceId: string | undefined, projectId: string): Promise<string> {
		const explicitWorkspaceId = workspaceId?.trim();
		if (explicitWorkspaceId) return explicitWorkspaceId;
		const rows = await client.unsafe<ProjectWorkspaceRow>(`
			SELECT workspace_id
			FROM projects
			WHERE project_id = $1 AND deleted_at IS NULL
			LIMIT 1
		`, [projectId]);
		const catalogWorkspaceId = rows[0]?.workspace_id?.trim();
		return catalogWorkspaceId || fallbackProjectWorkspaceId(projectId);
	}

	private async resolveSettlementWorkspaceId(client: UsageLedgerSqlClient, input: AiCreditSettleInput): Promise<string> {
		const explicitWorkspaceId = input.workspaceId?.trim();
		if (explicitWorkspaceId) return explicitWorkspaceId;
		const reservationWorkspaceId = await this.findReservationWorkspaceId(client, input.jobId, input.projectId);
		return reservationWorkspaceId || this.resolveWorkspaceId(client, undefined, input.projectId);
	}

	private async findReservationWorkspaceId(client: UsageLedgerSqlClient, jobId: string, projectId: string): Promise<string | undefined> {
		const rows = await client.unsafe<ProjectWorkspaceRow>(`
			SELECT workspace_id
			FROM usage_events
			WHERE subject_id = $1
				AND project_id = $2
				AND kind = 'ai_credit_reserved'
			ORDER BY created_at DESC
			LIMIT 1
		`, [jobId, projectId]);
		return rows[0]?.workspace_id?.trim() || undefined;
	}

	private async resolveWorkspaceUsagePlanConfig(client: UsageLedgerSqlClient, workspaceId: string, override?: UsagePlanConfig, now = Date.now()): Promise<UsagePlanConfig> {
		if (override) return override;
		const summaryTime = new Date(now);
		const monthlyStart = new Date(startOfUtcMonth(now));
		const nextMonthlyStart = new Date(Date.UTC(monthlyStart.getUTCFullYear(), monthlyStart.getUTCMonth() + 1, 1));
		const rows = await client.unsafe<WorkspaceUsagePlanRow>(`
			SELECT
				billing_plans.plan_id,
				billing_plans.monthly_ai_credits,
				COALESCE(SUM(
					CASE
						WHEN billing_addon_products.billing_interval = 'monthly' THEN
							workspace_addon_grants.ai_credits * GREATEST(workspace_addon_grants.quantity, 0)
						WHEN billing_addon_products.billing_interval = 'one_time'
							AND workspace_addon_grants.created_at >= $3::timestamptz
							AND workspace_addon_grants.created_at < $4::timestamptz THEN
							workspace_addon_grants.ai_credits * GREATEST(workspace_addon_grants.quantity, 0)
						ELSE 0
					END
				), 0) AS addon_ai_credits
			FROM workspaces
			LEFT JOIN workspace_billing_accounts
				ON workspace_billing_accounts.workspace_id = workspaces.workspace_id
				AND workspace_billing_accounts.status IN ('mock_active', 'trialing', 'active')
				AND ${dunningGraceActiveSql()}
			LEFT JOIN billing_plans
				ON billing_plans.plan_id = workspace_billing_accounts.plan_id
				AND billing_plans.status = 'active'
			LEFT JOIN workspace_addon_grants
				ON workspace_addon_grants.workspace_id = workspaces.workspace_id
				AND workspace_addon_grants.status = 'active'
				AND workspace_addon_grants.created_at <= $2::timestamptz
				AND (workspace_addon_grants.expires_at IS NULL OR workspace_addon_grants.expires_at > $2::timestamptz)
			LEFT JOIN billing_addon_products
				ON billing_addon_products.addon_id = workspace_addon_grants.addon_id
				AND billing_addon_products.kind = 'ai_credits'
			WHERE workspaces.workspace_id = $1
			GROUP BY billing_plans.plan_id, billing_plans.monthly_ai_credits
			LIMIT 1
		`, [workspaceId, summaryTime.toISOString(), monthlyStart.toISOString(), nextMonthlyStart.toISOString()]);
		const row = rows[0];
		if (!row) return readUsagePlanConfig("free");
		return readUsagePlanConfig(row.plan_id ?? "free", {
			monthlyAiCredits: toNumber(row?.monthly_ai_credits),
			extraMonthlyAiCredits: toNumber(row?.addon_ai_credits),
		});
	}

	private async transaction<T>(fn: (client: UsageLedgerSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) return this.client.begin(fn);
		await this.client.unsafe("BEGIN");
		try {
			const result = await fn(this.client);
			await this.client.unsafe("COMMIT");
			return result;
		} catch (error) {
			await this.client.unsafe("ROLLBACK");
			throw error;
		}
	}
}

function summarizeUsageEvents(events: UsageLedgerEvent[], workspaceId: string, projectId = workspaceId, now = Date.now(), config = readUsagePlanConfig()): WorkspaceUsageSummary {
	const states = buildAiReservationStatesFromEvents(events, workspaceId);
	const dailyStart = startOfUtcDay(now);
	const monthlyStart = startOfUtcMonth(now);
	const daily = summarizeWindowFromEvents(events, workspaceId, dailyStart, formatUtcDayKey(now), states, {
		aiCreditThb: config.dailyAiCreditThb,
		uploadBytes: config.dailyUploadBytes,
		exportBytes: config.dailyExportBytes,
	});
	const monthly = summarizeWindowFromEvents(events, workspaceId, monthlyStart, formatUtcMonthKey(now), states, {
		aiCreditThb: config.monthlyAiCreditThb,
		uploadBytes: config.monthlyUploadBytes,
		exportBytes: config.monthlyExportBytes,
	});

	return {
		workspaceId,
		projectId,
		planId: config.planId,
		enforced: config.enforced,
		daily,
		monthly,
		...applyEventCountCap(events.filter((event) => event.workspaceId === workspaceId).length),
	};
}

function summarizeWindowFromEvents(
	events: UsageLedgerEvent[],
	workspaceId: string,
	startMs: number,
	periodKey: string,
	aiStates: Map<string, AiReservationState>,
	limits: UsageWindowSummary["limits"],
): UsageWindowSummary {
	const windowEvents = events.filter((event) => event.workspaceId === workspaceId && event.createdAt >= startMs);
	const aiCapturedThb = sumAmounts(windowEvents.filter((event) => event.kind === "ai_credit_captured"));
	const aiActiveReservedThb = sumActiveReserved(aiStates);
	const uploadBytes = sumBytes(windowEvents.filter((event) => event.kind === "upload_bytes_recorded"));
	const exportBytes = sumBytes(windowEvents.filter((event) => event.kind === "export_bytes_recorded"));
	const moderationImages = sumUnits(windowEvents.filter((event) => event.kind === "moderation_image_checked"));
	const aiCommittedThb = roundCurrency(aiCapturedThb + aiActiveReservedThb);

	return {
		periodKey,
		aiCapturedThb,
		aiActiveReservedThb,
		aiCommittedThb,
		uploadBytes,
		exportBytes,
		moderationImages,
		limits,
		remaining: {
			aiCreditThb: remainingValue(limits.aiCreditThb, aiCommittedThb),
			uploadBytes: remainingValue(limits.uploadBytes, uploadBytes),
			exportBytes: remainingValue(limits.exportBytes, exportBytes),
		},
		percentUsed: {
			aiCredit: percentUsed(aiCommittedThb, limits.aiCreditThb),
			uploadBytes: percentUsed(uploadBytes, limits.uploadBytes),
			exportBytes: percentUsed(exportBytes, limits.exportBytes),
		},
	};
}

function buildAiReservationStatesFromEvents(events: UsageLedgerEvent[], workspaceId: string): Map<string, AiReservationState> {
	const states = new Map<string, AiReservationState>();
	for (const event of events) {
		if (event.workspaceId !== workspaceId || !event.kind.startsWith("ai_credit_")) continue;
		const existing = states.get(event.subjectId) ?? {
			projectId: event.projectId,
			reservedAt: event.createdAt,
			reservedThb: 0,
		};
		if (event.kind === "ai_credit_reserved") {
			existing.reservedAt = event.createdAt;
			existing.reservedThb = safeAmount(event.amountThb);
			existing.actorUserId = event.actorUserId;
		} else if (event.kind === "ai_credit_captured") {
			existing.capturedAt = event.createdAt;
			existing.capturedThb = safeAmount(event.amountThb);
		} else if (event.kind === "ai_credit_released") {
			existing.releasedAt = event.createdAt;
		}
		states.set(event.subjectId, existing);
	}
	return states;
}

export function isValidUsageEventCursor(cursor: string | undefined): boolean {
	if (!cursor?.trim()) return true;
	return decodeUsageEventCursor(cursor) !== null;
}

function normalizeUsageEventLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit) || !limit || limit <= 0) return 100;
	return Math.min(Math.trunc(limit), 500);
}

function encodeUsageEventCursor(event: UsageLedgerEvent): string {
	return Buffer.from(JSON.stringify({
		createdAt: event.createdAt,
		eventId: event.eventId,
	}), "utf8").toString("base64url");
}

function decodeUsageEventCursor(cursor: string | undefined): UsageEventCursor | null {
	if (!cursor?.trim()) return null;
	if (cursor.length > 700) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<UsageEventCursor>;
		if (typeof decoded.createdAt !== "number" || !Number.isFinite(decoded.createdAt)) return null;
		if (typeof decoded.eventId !== "string" || !decoded.eventId.trim()) return null;
		return {
			createdAt: decoded.createdAt,
			eventId: decoded.eventId,
		};
	} catch {
		return null;
	}
}

function usageEventSortsAfterCursor(event: UsageLedgerEvent, cursor: UsageEventCursor): boolean {
	return event.createdAt < cursor.createdAt
		|| (event.createdAt === cursor.createdAt && event.eventId < cursor.eventId);
}

function compareUsageEventOrder(a: UsageLedgerEvent, b: UsageLedgerEvent): number {
	return b.createdAt - a.createdAt || b.eventId.localeCompare(a.eventId);
}

function mapUsageEventRow(row: UsageEventRow): UsageLedgerEvent {
	const metadata = normalizeMetadata(row.metadata);
	return {
		eventId: row.event_id,
		workspaceId: row.workspace_id,
		projectId: row.project_id ?? row.workspace_id,
		kind: row.kind as UsageEventKind,
		subjectId: row.subject_id,
		actorUserId: normalizeActorUserId(row.actor_user_id),
		idempotencyKey: row.idempotency_key ?? undefined,
		amountThb: safeAmount(toNumber(row.amount_thb)),
		bytes: safeBytes(toNumber(row.amount_bytes)),
		units: safeBytes(toNumber(row.amount_units ?? metadata.units)),
		createdAt: toTimestamp(row.created_at),
		metadata,
	};
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toTimestamp(value: Date | string): number {
	return value instanceof Date ? value.getTime() : Date.parse(value);
}

function createUsageLedger() {
	if (serverConfig.usageLedgerStore === "postgres") {
		return new PostgresUsageLedger();
	}
	return new UsageLedger(join(DATA_DIR, "usage-ledger.json"));
}

export const usageLedger = createUsageLedger();

export function readUsagePlanConfig(planId = process.env.WORKSPACE_PLAN_ID, options: UsagePlanConfigOptions = {}): UsagePlanConfig {
	const plan = resolveWorkspacePlan(planId);
	const monthlyAiCredits = safeBytes(options.monthlyAiCredits ?? plan.monthlyAiCredits)
		+ safeBytes(options.extraMonthlyAiCredits);
	// Plan credits → THB monthly AI quota at the sale rate (CENTS_PER_CREDIT, the
	// single margin knob in plans.ts). Ceil-to-the-satang so the quota never rounds
	// a user's bundled credits DOWN below what they paid for.
	const defaultMonthlyAiCreditThb = Math.ceil(monthlyAiCredits * CENTS_PER_CREDIT) / 100;
	return {
		planId: plan.id,
		enforced: readBooleanEnv("USAGE_QUOTA_ENFORCED", true),
		dailyAiCreditThb: readLimitFloatEnv("USAGE_DAILY_AI_CREDIT_THB", 0),
		monthlyAiCreditThb: readMonthlyAiCreditLimitEnv(defaultMonthlyAiCreditThb),
		dailyUploadBytes: readLimitIntegerEnv("USAGE_DAILY_UPLOAD_BYTES", 0),
		monthlyUploadBytes: readLimitIntegerEnv("USAGE_MONTHLY_UPLOAD_BYTES", 0),
		dailyExportBytes: readLimitIntegerEnv("USAGE_DAILY_EXPORT_BYTES", 0),
		monthlyExportBytes: readLimitIntegerEnv("USAGE_MONTHLY_EXPORT_BYTES", 0),
		maxEvents: readPositiveIntegerEnv("USAGE_LEDGER_MAX_EVENTS", 20000),
	};
}

/**
 * Resolve the usage-plan config for a project in FILE mode by routing through
 * the billing store, so a plan assigned via PUT /api/billing/:workspaceId/plan
 * drives the monthly AI-credit limit instead of the WORKSPACE_PLAN_ID env
 * default. Returns undefined for the Postgres ledger, which resolves the plan
 * via its own workspace_billing_accounts join (`resolveWorkspaceUsagePlanConfig`)
 * — passing a config there would override that DB-derived plan.
 */
async function resolveFileUsagePlanConfigForProject(projectId: string, workspaceId?: string): Promise<UsagePlanConfig | undefined> {
	if (usageLedger instanceof PostgresUsageLedger) return undefined;
	const { resolveWorkspacePlanIdForProject } = await import("./billing-store.js");
	const planId = await resolveWorkspacePlanIdForProject(projectId, { workspaceId });
	return readUsagePlanConfig(planId);
}

export async function summarizeWorkspaceUsage(projectId: string, now = Date.now()): Promise<WorkspaceUsageSummary> {
	if (usageLedger instanceof PostgresUsageLedger) {
		return usageLedger.summarizeProject(projectId, now);
	}
	return usageLedger.summarize(projectId, projectId, now, await resolveFileUsagePlanConfigForProject(projectId));
}

export async function listProjectUsageEventPage(projectId: string, options: UsageEventListOptions = {}): Promise<UsageEventPage> {
	if (usageLedger instanceof PostgresUsageLedger) {
		return usageLedger.listProjectEventPage(projectId, options);
	}
	return usageLedger.listEventPage(projectId, { ...options, projectId });
}

export async function reserveAiCredit(input: AiCreditReserveInput): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.reserveAiCredit(input);
	return usageLedger.reserveAiCredit(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

export async function settleAiCreditReservation(input: AiCreditSettleInput): Promise<UsageLedgerEvent | null> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.settleAiCredit(input);
	return usageLedger.settleAiCredit(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

export async function assertUploadUsageAllowance(input: UploadUsageInput): Promise<WorkspaceUsageSummary> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.assertCanRecordUpload(input);
	return usageLedger.assertCanRecordUpload(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

export async function recordUploadUsage(input: UploadUsageInput): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.recordUpload(input);
	return usageLedger.recordUpload(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

export async function assertExportUsageAllowance(input: ExportUsageInput): Promise<WorkspaceUsageSummary> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.assertCanRecordExport(input);
	return usageLedger.assertCanRecordExport(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

export async function recordExportUsage(input: ExportUsageInput): Promise<{ event: UsageLedgerEvent; summary: WorkspaceUsageSummary }> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.recordExport(input);
	return usageLedger.recordExport(input, await resolveFileUsagePlanConfigForProject(input.projectId, input.workspaceId));
}

/**
 * Record AI support-agent token spend (rank7). File and Postgres ledgers share
 * the same idempotent semantics; the budget guard reads the GLOBAL monthly total
 * via sumTicketAiTokensThb(), never the per-project summarize().
 */
export async function recordTicketAiTokens(input: TicketAiTokenUsageInput): Promise<UsageLedgerEvent> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.recordTicketAiTokens(input);
	return usageLedger.recordTicketAiTokens(input);
}

/** GLOBAL (cross-tenant) monthly support-agent THB spend since `startMs`. */
export async function sumTicketAiTokensThb(startMs: number): Promise<number> {
	if (usageLedger instanceof PostgresUsageLedger) return usageLedger.sumTicketAiTokensThb(startMs);
	return usageLedger.sumTicketAiTokensThb(startMs);
}

/** First-of-the-current-UTC-month epoch ms — the budget meter window start. */
export function startOfCurrentUtcMonth(now = Date.now()): number {
	return startOfUtcMonth(now);
}

function resolveTicketAiTokenScope(input: TicketAiTokenUsageInput): { workspaceId: string; projectId: string; idempotencyKey: string } {
	return {
		// ALWAYS the fixed synthetic support scope — NEVER the caller's workspaceId.
		// This makes the (workspace_id, idempotency_key) uniqueness GLOBAL on
		// (ticketId, messageId), so the same reply recorded under a different
		// originating workspace can never bypass dedup and double-charge.
		workspaceId: SUPPORT_USAGE_WORKSPACE_ID,
		projectId: SUPPORT_USAGE_PROJECT_ID,
		// Idempotent per agent reply: a webhook retry / double-send reuses the same
		// (ticketId, messageId) and therefore never double-charges the budget.
		idempotencyKey: `ticket-ai-tokens:${input.ticketId}:${input.messageId}`,
	};
}

// Authoritative amount/units for a ticket-AI-tokens event, computed once and
// reused by both the initial write and the idempotent-reconcile path.
function ticketAiTokenAmounts(input: TicketAiTokenUsageInput): { amountThb: number; units: number } {
	return {
		amountThb: ticketAiAmountThb(input.tokens, input.thbPerToken),
		units: safeBytes(input.tokens),
	};
}

// Event metadata for ticket-AI-tokens spend. The caller's originating
// workspace/project are recorded here for AUDIT only — they are deliberately NOT
// the storage scope (see resolveTicketAiTokenScope), so they cannot affect
// idempotency. ticketId/messageId are always present for traceability.
function ticketAiMetadata(input: TicketAiTokenUsageInput): Record<string, unknown> {
	const meta: Record<string, unknown> = { ...input.metadata, ticketId: input.ticketId, messageId: input.messageId };
	const originWorkspaceId = input.workspaceId?.trim();
	const originProjectId = input.projectId?.trim();
	if (originWorkspaceId) meta.originWorkspaceId = originWorkspaceId;
	if (originProjectId) meta.originProjectId = originProjectId;
	return meta;
}

function ticketAiAmountThb(tokens: number, thbPerToken: number | undefined): number {
	const safeTokens = safeBytes(tokens);
	// Caller-supplied rate wins when present and valid; otherwise default to the
	// CONFIGURED support rate (TICKET_AI_THB_PER_TOKEN), not a hardcoded 0.001.
	// Using a fixed 0.001 here would UNDERCOUNT the global monthly budget meter
	// whenever an operator raised the rate, letting more real spend slip through.
	const configuredRate = serverConfig.ticketAiGuardrails.thbPerToken;
	const fallbackRate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : 0.001;
	const rate = typeof thbPerToken === "number" && Number.isFinite(thbPerToken) && thbPerToken > 0 ? thbPerToken : fallbackRate;
	return roundCurrency(safeTokens * rate);
}

function assertThbLimit(
	summary: WorkspaceUsageSummary,
	reason: Extract<UsageQuotaReason, "daily_ai_credit_limit" | "monthly_ai_credit_limit">,
	projectedThb: number,
	limitThb: number,
	attemptedThb: number,
): void {
	if (limitThb > 0 && projectedThb > limitThb) {
		throw new UsageQuotaExceededError(reason, summary, { amountThb: attemptedThb });
	}
}

function assertBytesLimit(
	summary: WorkspaceUsageSummary,
	reason: Extract<UsageQuotaReason, "daily_upload_bytes_limit" | "monthly_upload_bytes_limit" | "daily_export_bytes_limit" | "monthly_export_bytes_limit">,
	projectedBytes: number,
	limitBytes: number,
	attemptedBytes: number,
): void {
	if (limitBytes > 0 && projectedBytes > limitBytes) {
		throw new UsageQuotaExceededError(reason, summary, { bytes: attemptedBytes });
	}
}

// Guard against cross-kind idempotency-key reuse. A found event whose kind does
// not match the operation currently looking it up is NOT a valid dedup hit (it
// would silently record 0/wrong amounts for this kind), so reject loudly.
function assertIdempotencyKindMatch(event: UsageLedgerEvent | undefined | null, expectedKind: UsageEventKind | undefined, idempotencyKey: string): void {
	if (!event || !expectedKind) return;
	if (event.kind !== expectedKind) {
		throw new UsageIdempotencyKindMismatchError(idempotencyKey, event.kind, expectedKind);
	}
}

function resolveWorkspaceId(workspaceId: string | undefined, projectId: string): string {
	return workspaceId?.trim() || projectId;
}

function fallbackProjectWorkspaceId(projectId: string): string {
	return `project:${projectId}`;
}

function startOfUtcDay(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function formatUtcDayKey(now: number): string {
	return new Date(startOfUtcDay(now)).toISOString().slice(0, 10);
}

function formatUtcMonthKey(now: number): string {
	return new Date(startOfUtcMonth(now)).toISOString().slice(0, 7);
}

function sumAmounts(events: UsageLedgerEvent[]): number {
	return roundCurrency(events.reduce((total, event) => total + safeAmount(event.amountThb), 0));
}

function sumBytes(events: UsageLedgerEvent[]): number {
	return events.reduce((total, event) => total + safeBytes(event.bytes), 0);
}

function sumUnits(events: UsageLedgerEvent[]): number {
	return events.reduce((total, event) => total + safeBytes(event.units), 0);
}

function sumActiveReserved(states: Map<string, AiReservationState>): number {
	let total = 0;
	for (const state of states.values()) {
		if (state.reservedThb > 0 && !state.capturedAt && !state.releasedAt) {
			total += state.reservedThb;
		}
	}
	return roundCurrency(total);
}

function resolveAiSettlementAmount(status: "captured" | "released", requestedAmountThb: number | undefined, reservedThb: number): number {
	const safeReserved = safeAmount(reservedThb);
	if (status === "released") return safeReserved;
	const requested = requestedAmountThb === undefined ? safeReserved : safeAmount(requestedAmountThb);
	if (requested <= 0) return safeReserved;
	return safeReserved > 0 ? Math.min(requested, safeReserved) : requested;
}

function remainingValue(limit: number, used: number): number | null {
	return limit > 0 ? Math.max(0, roundCurrency(limit - used)) : null;
}

function percentUsed(used: number, limit: number): number | null {
	return limit > 0 ? Math.min(999, Math.round((used / limit) * 10000) / 100) : null;
}

function safeAmount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? roundCurrency(value) : 0;
}

function safeBytes(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function roundCurrency(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function readLimitFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readMonthlyAiCreditLimitEnv(fallback: number): number {
	const raw = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
	if (!raw) return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	// Docker's legacy default is 0; plan-backed billing should still apply.
	return parsed === 0 && fallback > 0 ? fallback : parsed;
}

function readLimitIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const parsed = readLimitIntegerEnv(name, fallback);
	return parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function isUsageLedgerEvent(value: unknown): value is UsageLedgerEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<UsageLedgerEvent>;
	return typeof event.eventId === "string"
		&& typeof event.workspaceId === "string"
		&& typeof event.projectId === "string"
		&& typeof event.kind === "string"
		&& typeof event.subjectId === "string"
		&& typeof event.createdAt === "number";
}
