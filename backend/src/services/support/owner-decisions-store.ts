// AI-support OWNER-OPS — owner-decision / proposal record store.
//
// Durable record of every structured ActionProposal the support AI makes and the
// deterministic gate's verdict over SERVER-VERIFIED data (decision-policy.ts).
// Backs migration 0060's `support_decisions` table. Responsibilities:
//   1. AUDIT — one row per proposal: the action, the structured params, the
//      code-computed verified evidence, the gate's verdict + machine reason, who
//      decided, and (once executed) the executed_ref + sanctioned amount.
//   2. IDEMPOTENCY — a unique idempotency_key (per proposal) so the SAME proposal
//      can never double-execute. createDecision() is insert-if-absent; a key
//      already present returns the existing row WITHOUT a second side effect.
//      State transitions (markExecuted/markOwnerApproved/…) are guarded so a
//      retried owner-approve never grants twice.
//   3. VELOCITY + CIRCUIT — code-counted, idempotent aggregates over executed AUTO
//      grants: per-user day/month counts (velocity caps) and a window volume
//      (circuit-breaker). Counters derive from the durable rows, so they are
//      atomic with the single-row insert and never drift.
//
// Mirrors the file|postgres dual-store shape of payment-reconciliations-store.ts
// so local/test runs work without DATABASE_URL.

import { getSharedBunSql } from "../sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../../config.js";
import { readJsonFile } from "../../utils/json-file.js";
import {
	SUPPORT_DECISION_ACTIONS,
	type SupportDecisionAction,
} from "./decision-policy.js";

export const SUPPORT_DECISION_STATES = [
	"auto_approved",
	"owner_pending",
	"owner_approved",
	"owner_denied",
	"denied",
	// Terminal: a previously-executed grant (auto_approved / owner_approved) was
	// REVERSED by an owner clawback. The reversal details live in params.clawback.
	"clawed_back",
] as const;
export type SupportDecisionState = (typeof SUPPORT_DECISION_STATES)[number];

export interface SupportDecisionRecord {
	id: string;
	ticketId?: string;
	userId: string;
	action: SupportDecisionAction;
	/** The structured proposal params (e.g. { amount, reason }). */
	params: Record<string, unknown>;
	/** The server-VERIFIED evidence the gate decided over (never customer words). */
	evidence: Record<string, unknown>;
	recommendation?: string;
	decision: SupportDecisionState;
	/** Stable machine reason code from the gate. */
	reason?: string;
	/** 'ai' for auto/deny; 'owner:<userId>' once an owner acts. */
	decidedBy: string;
	/** Side-effect ref once executed (grant id / refund tx / plan assignment). */
	executedRef?: string;
	/** Sanctioned amount, MINOR UNITS (cents). */
	amountCents: number;
	currency?: string;
	idempotencyKey: string;
	createdAt: string;
	decidedAt?: string;
}

export interface CreateDecisionInput {
	ticketId?: string;
	userId: string;
	action: SupportDecisionAction;
	params?: Record<string, unknown>;
	evidence?: Record<string, unknown>;
	recommendation?: string;
	decision: SupportDecisionState;
	reason?: string;
	decidedBy?: string;
	executedRef?: string;
	amountCents?: number;
	currency?: string;
	/** Defaults to `decision:<ticketId>:<action>` so one proposal per ticket+action. */
	idempotencyKey?: string;
}

export interface CreateDecisionResult {
	record: SupportDecisionRecord;
	/** False when an existing row was returned (idempotent no-op) — do NOT execute again. */
	created: boolean;
}

/** Per-user auto-grant velocity over the trailing windows (code-counted). */
export interface AutoGrantVelocity {
	dayCount: number;
	monthCount: number;
}

/** Window-wide AUTO-grant volume for the circuit-breaker (code-counted). */
export interface AutoGrantWindowVolume {
	windowCount: number;
	windowCents: number;
}

export class OwnerDecisionStoreError extends Error {
	constructor(message: string, readonly code = "owner_decision_store_error") {
		super(message);
		this.name = "OwnerDecisionStoreError";
	}
}

export interface OwnerDecisionStore {
	/** Insert-if-absent on the idempotency key. created=false ⇒ already handled. */
	createDecision(input: CreateDecisionInput): Promise<CreateDecisionResult>;
	getById(id: string): Promise<SupportDecisionRecord | null>;
	getByIdempotencyKey(key: string): Promise<SupportDecisionRecord | null>;
	/** Pending owner-review cases, oldest first (the owner queue). */
	listPending(limit?: number): Promise<SupportDecisionRecord[]>;
	listByUser(userId: string, limit?: number): Promise<SupportDecisionRecord[]>;
	/**
	 * Transition a row to a TERMINAL decided state, guarded so it only applies from a
	 * transition-able prior state. Returns the updated row, or null when the row is
	 * absent or already in a terminal state (so a retried owner-approve never
	 * re-executes). `from` constrains the allowed prior state(s).
	 */
	settleDecision(input: {
		id: string;
		from: SupportDecisionState | SupportDecisionState[];
		to: Extract<SupportDecisionState, "auto_approved" | "owner_approved" | "owner_denied">;
		decidedBy: string;
		executedRef?: string;
		amountCents?: number;
		currency?: string;
		reason?: string;
	}): Promise<SupportDecisionRecord | null>;
	/** Per-user EXECUTED auto-grant counts over the trailing day + month windows. */
	getAutoGrantVelocity(userId: string, now?: () => number): Promise<AutoGrantVelocity>;
	/** EXECUTED auto-grant volume across ALL users in the breaker window. */
	getAutoGrantWindowVolume(windowSeconds: number, now?: () => number): Promise<AutoGrantWindowVolume>;
	/**
	 * CLAW BACK an executed grant — ATOMIC, single-attempt, no intermediate state.
	 *
	 * ONE guarded transaction does everything: the CAS transition to `clawed_back`,
	 * the write of the FINAL reversal amounts (reason / grant ref / timestamp /
	 * reversed+unrecoverable credits) into params.clawback, AND — only for the winner,
	 * inside the same transaction — the audit side effect. It is the SINGLE winner-gate:
	 *   * The guarded UPDATE matches only an EXECUTED grant (auto_approved/owner_approved),
	 *     so under concurrency EXACTLY ONE caller's UPDATE matches and wins; the row is
	 *     never observable in a half-done "pending-finalize" state (state + amounts land
	 *     in the SAME statement).
	 *   * Only the winner runs `audit`; it runs INSIDE the transaction BEFORE commit, so
	 *     if it throws the whole transition rolls back (the row stays not-clawed-back) —
	 *     there is nothing to revert and a retry is just a fresh attempt. A committed
	 *     clawed_back row therefore ALWAYS carries its amounts AND has an audit row.
	 *   * A loser / duplicate (row already clawed_back) matches 0 rows: `won` is false and
	 *     the already-committed row is returned read-only — no audit, no mutation.
	 *
	 * Returns { won, record }: won=true ⇒ this call performed the transition (+audit);
	 * won=false ⇒ read-only no-op (record is the already-clawed_back row, or null when
	 * the row is absent / not an eligible executed grant).
	 */
	clawbackDecision(input: {
		id: string;
		decidedBy: string;
		reversal: ClawbackReversal;
		/**
		 * Runs ONLY for the winner, INSIDE the atomic transition, BEFORE commit. If it
		 * throws, the transition rolls back so the row never moves to clawed_back without
		 * a durable audit. Omit it only in tests that assert the lower-level transition.
		 */
		audit?: () => Promise<void>;
	}): Promise<{ won: boolean; record: SupportDecisionRecord | null }>;
	/** All decisions created within [startMs, endMs) — the per-day digest window. */
	listByCreatedWindow(startMs: number, endMs: number, limit?: number): Promise<SupportDecisionRecord[]>;
}

/**
 * The recorded outcome of a credit-grant reversal, persisted on params.clawback in
 * the SAME atomic UPDATE that moves the row to clawed_back (no separate intent/finalize
 * phases — the row is never observable carrying only a partial reversal).
 */
export interface ClawbackReversal {
	/** Why the owner clawed the grant back (audit + canned record). */
	reason: string;
	/** The credits-service reversal ref (grant id that was reversed). */
	reversalRef: string;
	/** When the clawback transition was recorded. */
	clawedBackAt: string;
	/** Credits actually deducted back (clamped to the unspent remainder). */
	reversedCredits: number;
	/** Credits the customer already spent and could NOT be recovered. */
	unrecoverableCredits: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

function clampCents(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function normalizeCreate(input: CreateDecisionInput): Omit<SupportDecisionRecord, "id" | "createdAt"> & { createdAt?: string } {
	const userId = input.userId?.trim();
	if (!userId) throw new OwnerDecisionStoreError("userId is required", "decision_invalid_user");
	if (!(SUPPORT_DECISION_ACTIONS as readonly string[]).includes(input.action)) {
		throw new OwnerDecisionStoreError(`invalid action '${String(input.action)}'`, "decision_invalid_action");
	}
	if (!(SUPPORT_DECISION_STATES as readonly string[]).includes(input.decision)) {
		throw new OwnerDecisionStoreError(`invalid decision '${String(input.decision)}'`, "decision_invalid_state");
	}
	const ticketId = input.ticketId?.trim() || undefined;
	const idempotencyKey = input.idempotencyKey?.trim()
		|| (ticketId ? `decision:${ticketId}:${input.action}` : `decision:user:${userId}:${uuid()}`);
	const decidedTerminal = input.decision !== "owner_pending";
	return {
		ticketId,
		userId,
		action: input.action,
		params: isPlainObject(input.params) ? input.params : {},
		evidence: isPlainObject(input.evidence) ? input.evidence : {},
		recommendation: input.recommendation?.slice(0, 2000),
		decision: input.decision,
		reason: input.reason?.slice(0, 200),
		decidedBy: input.decidedBy?.trim() || "ai",
		executedRef: input.executedRef?.trim() || undefined,
		amountCents: clampCents(input.amountCents),
		currency: input.currency?.trim()?.toUpperCase() || undefined,
		idempotencyKey,
		decidedAt: decidedTerminal ? undefined : undefined,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTerminal(state: SupportDecisionState): boolean {
	return state !== "owner_pending";
}

// ── File store (tests + file/prototype runtime) ─────────────────────────────────

export class FileOwnerDecisionStore implements OwnerDecisionStore {
	private readonly records: SupportDecisionRecord[] = [];
	private readonly byKey = new Map<string, SupportDecisionRecord>();
	private readonly byId = new Map<string, SupportDecisionRecord>();
	private readonly clawbackClaims = new Map<string, Promise<void>>();

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async createDecision(input: CreateDecisionInput): Promise<CreateDecisionResult> {
		const n = normalizeCreate(input);
		const existing = this.byKey.get(n.idempotencyKey);
		if (existing) return { record: { ...existing }, created: false };
		const nowIso = new Date().toISOString();
		const record: SupportDecisionRecord = {
			id: uuid(),
			...n,
			createdAt: nowIso,
			// Terminal verdicts (auto/deny) are decided at creation time.
			decidedAt: isTerminal(n.decision) ? nowIso : undefined,
		};
		this.records.push(record);
		this.byKey.set(record.idempotencyKey, record);
		this.byId.set(record.id, record);
		try {
			this.persist();
		} catch (error) {
			this.records.pop();
			this.byKey.delete(record.idempotencyKey);
			this.byId.delete(record.id);
			throw error;
		}
		return { record: { ...record }, created: true };
	}

	async getById(id: string): Promise<SupportDecisionRecord | null> {
		const found = this.byId.get(id?.trim());
		return found ? { ...found } : null;
	}

	async getByIdempotencyKey(key: string): Promise<SupportDecisionRecord | null> {
		const found = this.byKey.get(key?.trim());
		return found ? { ...found } : null;
	}

	async listPending(limit = 100): Promise<SupportDecisionRecord[]> {
		return this.records
			.filter((r) => r.decision === "owner_pending")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.slice(0, Math.max(1, limit))
			.map((r) => ({ ...r }));
	}

	async listByUser(userId: string, limit = 100): Promise<SupportDecisionRecord[]> {
		const id = userId?.trim();
		if (!id) return [];
		return this.records
			.filter((r) => r.userId === id)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
			.slice(0, Math.max(1, limit))
			.map((r) => ({ ...r }));
	}

	async settleDecision(input: {
		id: string;
		from: SupportDecisionState | SupportDecisionState[];
		to: Extract<SupportDecisionState, "auto_approved" | "owner_approved" | "owner_denied">;
		decidedBy: string;
		executedRef?: string;
		amountCents?: number;
		currency?: string;
		reason?: string;
	}): Promise<SupportDecisionRecord | null> {
		const row = this.byId.get(input.id?.trim());
		if (!row) return null;
		const allowed = Array.isArray(input.from) ? input.from : [input.from];
		if (!allowed.includes(row.decision)) return null; // already settled / wrong state → no-op
		row.decision = input.to;
		row.decidedBy = input.decidedBy?.trim() || row.decidedBy;
		if (input.executedRef !== undefined) row.executedRef = input.executedRef.trim() || undefined;
		if (input.amountCents !== undefined) row.amountCents = clampCents(input.amountCents);
		if (input.currency !== undefined) row.currency = input.currency.trim().toUpperCase() || undefined;
		if (input.reason !== undefined) row.reason = input.reason.slice(0, 200);
		row.decidedAt = new Date().toISOString();
		this.persist();
		return { ...row };
	}

	async getAutoGrantVelocity(userId: string, now: () => number = Date.now): Promise<AutoGrantVelocity> {
		const id = userId?.trim();
		if (!id) return { dayCount: 0, monthCount: 0 };
		const nowMs = now();
		let dayCount = 0;
		let monthCount = 0;
		for (const r of this.records) {
			if (r.userId !== id || r.decision !== "auto_approved" || r.action !== "grant_credit") continue;
			if (!r.executedRef) continue; // only EXECUTED grants count toward velocity
			const ageMs = nowMs - Date.parse(r.createdAt);
			if (ageMs < 0) continue;
			if (ageMs <= DAY_MS) dayCount += 1;
			if (ageMs <= MONTH_MS) monthCount += 1;
		}
		return { dayCount, monthCount };
	}

	async getAutoGrantWindowVolume(windowSeconds: number, now: () => number = Date.now): Promise<AutoGrantWindowVolume> {
		const windowMs = Math.max(1, windowSeconds) * 1000;
		const nowMs = now();
		let windowCount = 0;
		let windowCents = 0;
		for (const r of this.records) {
			if (r.decision !== "auto_approved" || r.action !== "grant_credit" || !r.executedRef) continue;
			const ageMs = nowMs - Date.parse(r.createdAt);
			if (ageMs < 0 || ageMs > windowMs) continue;
			windowCount += 1;
			windowCents += clampCents(r.amountCents);
		}
		return { windowCount, windowCents };
	}

	async clawbackDecision(input: {
		id: string;
		decidedBy: string;
		reversal: ClawbackReversal;
		audit?: () => Promise<void>;
	}): Promise<{ won: boolean; record: SupportDecisionRecord | null }> {
		const id = input.id.trim();
		const activeClaim = this.clawbackClaims.get(id);
		if (activeClaim) {
			await activeClaim;
			const current = this.byId.get(id);
			return { won: false, record: current ? { ...current } : null };
		}
		const row = this.byId.get(id);
		if (!row) return { won: false, record: null };
		// READ-ONLY no-op when the row is not an eligible executed grant: a duplicate /
		// loser (already clawed_back) returns the committed row; a non-grant / non-executed
		// row returns it as-is with won=false. Only an EXECUTED grant can win the transition.
		if (row.action !== "grant_credit"
			|| (row.decision !== "auto_approved" && row.decision !== "owner_approved")) {
			return { won: false, record: { ...row } };
		}
		// WINNER GATE (single event loop = atomic): claim privately before any await, but
		// keep the readable row in its prior executed state until the audit succeeds. A
		// concurrent caller waits for the claim to settle, then reads only the committed
		// outcome; if the audit throws, waiters fail with the same error and the row was
		// never exposed as clawed_back.
		const priorDecision = row.decision;
		const priorDecidedBy = row.decidedBy;
		const priorParams = row.params;
		const priorDecidedAt = row.decidedAt;
		let resolveClaim!: () => void;
		let rejectClaim!: (error: unknown) => void;
		const claim = new Promise<void>((resolve, reject) => {
			resolveClaim = resolve;
			rejectClaim = reject;
		});
		claim.catch(() => undefined);
		this.clawbackClaims.set(id, claim);
		try {
			if (input.audit) await input.audit();
			// Audit succeeded → COMMIT the readable transition + amounts with no await gap
			// between the flip and the synchronous file persistence.
			row.decision = "clawed_back";
			row.decidedBy = input.decidedBy?.trim() || row.decidedBy;
			row.params = { ...row.params, clawback: { ...input.reversal } };
			row.decidedAt = new Date().toISOString();
			this.persist();
			resolveClaim();
			return { won: true, record: { ...row } };
		} catch (error) {
			// If synchronous persistence failed after the audit, restore the readable row.
			// If the audit failed, these assignments are no-ops because the row never moved.
			row.decision = priorDecision;
			row.decidedBy = priorDecidedBy;
			row.params = priorParams;
			row.decidedAt = priorDecidedAt;
			rejectClaim(error);
			throw error;
		} finally {
			this.clawbackClaims.delete(id);
		}
	}

	async listByCreatedWindow(startMs: number, endMs: number, limit = 5000): Promise<SupportDecisionRecord[]> {
		return this.records
			.filter((r) => {
				const t = Date.parse(r.createdAt);
				return Number.isFinite(t) && t >= startMs && t < endMs;
			})
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.slice(0, Math.max(1, limit))
			.map((r) => ({ ...r }));
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ records?: SupportDecisionRecord[] }>(this.persistPath);
			if (Array.isArray(snapshot.records)) {
				for (const entry of snapshot.records) {
					if (isDecisionRecord(entry)) {
						this.records.push(entry);
						this.byKey.set(entry.idempotencyKey, entry);
						this.byId.set(entry.id, entry);
					}
				}
			}
		} catch (error) {
			console.warn(`[OwnerDecisionStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ records: this.records }, null, 2));
	}
}

// ── Postgres store ──────────────────────────────────────────────────────────────

export interface DecisionSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	/** Bun.SQL transaction helper. When present, the atomic clawback runs inside it. */
	begin?<T>(fn: (tx: DecisionSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface DecisionRow {
	id: string;
	ticket_id: string | null;
	user_id: string;
	action: string;
	params: unknown;
	evidence: unknown;
	recommendation: string | null;
	decision: string;
	reason: string | null;
	decided_by: string;
	executed_ref: string | null;
	amount_cents: number | string;
	currency: string | null;
	idempotency_key: string;
	created_at: Date | string;
	decided_at: Date | string | null;
}

function toInt(value: number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.floor(n) : 0;
}

function parseJson(value: unknown): Record<string, unknown> {
	if (isPlainObject(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return isPlainObject(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

function toIso(value: Date | string | null): string | undefined {
	if (value === null || value === undefined) return undefined;
	return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapRow(row: DecisionRow): SupportDecisionRecord {
	return {
		id: row.id,
		ticketId: row.ticket_id ?? undefined,
		userId: row.user_id,
		action: (SUPPORT_DECISION_ACTIONS as readonly string[]).includes(row.action) ? (row.action as SupportDecisionAction) : "other",
		params: parseJson(row.params),
		evidence: parseJson(row.evidence),
		recommendation: row.recommendation ?? undefined,
		decision: (SUPPORT_DECISION_STATES as readonly string[]).includes(row.decision) ? (row.decision as SupportDecisionState) : "owner_pending",
		reason: row.reason ?? undefined,
		decidedBy: row.decided_by,
		executedRef: row.executed_ref ?? undefined,
		amountCents: toInt(row.amount_cents),
		currency: row.currency ?? undefined,
		idempotencyKey: row.idempotency_key,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
		decidedAt: toIso(row.decided_at),
	};
}

const COLUMNS = `id, ticket_id, user_id, action, params, evidence, recommendation, decision, reason, decided_by, executed_ref, amount_cents, currency, idempotency_key, created_at, decided_at`;

export class PostgresOwnerDecisionStore implements OwnerDecisionStore {
	private readonly client: DecisionSqlClient;

	constructor(databaseUrlOrClient: string | DecisionSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new OwnerDecisionStoreError(
					"OwnerDecisionStore postgres mode requires DATABASE_URL",
					"owner_decision_store_unconfigured",
				);
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as DecisionSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async createDecision(input: CreateDecisionInput): Promise<CreateDecisionResult> {
		const n = normalizeCreate(input);
		const decidedAt = isTerminal(n.decision) ? new Date() : null;
		const rows = await this.client.unsafe<DecisionRow>(`
			INSERT INTO support_decisions
				(id, ticket_id, user_id, action, params, evidence, recommendation, decision, reason, decided_by, executed_ref, amount_cents, currency, idempotency_key, decided_at)
			VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			ON CONFLICT (idempotency_key) DO NOTHING
			RETURNING ${COLUMNS}
		`, [
			uuid(),
			n.ticketId ?? null,
			n.userId,
			n.action,
			JSON.stringify(n.params),
			JSON.stringify(n.evidence),
			n.recommendation ?? null,
			n.decision,
			n.reason ?? null,
			n.decidedBy,
			n.executedRef ?? null,
			n.amountCents,
			n.currency ?? null,
			n.idempotencyKey,
			decidedAt,
		]);
		const inserted = rows[0];
		if (inserted) return { record: mapRow(inserted), created: true };
		const existing = await this.getByIdempotencyKey(n.idempotencyKey);
		if (!existing) {
			throw new OwnerDecisionStoreError("Decision conflict but no existing row found", "owner_decision_conflict");
		}
		return { record: existing, created: false };
	}

	async getById(id: string): Promise<SupportDecisionRecord | null> {
		const key = id?.trim();
		if (!key) return null;
		const rows = await this.client.unsafe<DecisionRow>(`SELECT ${COLUMNS} FROM support_decisions WHERE id = $1 LIMIT 1`, [key]);
		return rows[0] ? mapRow(rows[0]) : null;
	}

	async getByIdempotencyKey(key: string): Promise<SupportDecisionRecord | null> {
		const k = key?.trim();
		if (!k) return null;
		const rows = await this.client.unsafe<DecisionRow>(`SELECT ${COLUMNS} FROM support_decisions WHERE idempotency_key = $1 LIMIT 1`, [k]);
		return rows[0] ? mapRow(rows[0]) : null;
	}

	async listPending(limit = 100): Promise<SupportDecisionRecord[]> {
		const rows = await this.client.unsafe<DecisionRow>(`
			SELECT ${COLUMNS} FROM support_decisions
			WHERE decision = 'owner_pending'
			ORDER BY created_at ASC, id ASC
			LIMIT $1
		`, [Math.max(1, limit)]);
		return rows.map(mapRow);
	}

	async listByUser(userId: string, limit = 100): Promise<SupportDecisionRecord[]> {
		const id = userId?.trim();
		if (!id) return [];
		const rows = await this.client.unsafe<DecisionRow>(`
			SELECT ${COLUMNS} FROM support_decisions
			WHERE user_id = $1
			ORDER BY created_at DESC, id DESC
			LIMIT $2
		`, [id, Math.max(1, limit)]);
		return rows.map(mapRow);
	}

	async settleDecision(input: {
		id: string;
		from: SupportDecisionState | SupportDecisionState[];
		to: Extract<SupportDecisionState, "auto_approved" | "owner_approved" | "owner_denied">;
		decidedBy: string;
		executedRef?: string;
		amountCents?: number;
		currency?: string;
		reason?: string;
	}): Promise<SupportDecisionRecord | null> {
		const id = input.id?.trim();
		if (!id) return null;
		const allowed = Array.isArray(input.from) ? input.from : [input.from];
		// Bun.SQL.unsafe cannot bind a JS array for `= ANY($n::text[])`, so render an
		// `ANY(ARRAY[$a,$b,...]::text[])` literal with one placeholder per allowed state.
		// Guarded UPDATE: only transitions from an allowed prior state, so a retried
		// owner-approve is a no-op (row already terminal → 0 rows updated).
		const params: unknown[] = [
			id,
			input.to,
			input.decidedBy?.trim() || "owner",
			input.executedRef?.trim() ?? null,
			input.amountCents === undefined ? null : clampCents(input.amountCents),
			input.currency === undefined ? null : (input.currency.trim().toUpperCase() || null),
			input.reason === undefined ? null : input.reason.slice(0, 200),
		];
		const allowedPlaceholders = allowed.map((state) => {
			params.push(state);
			return `$${params.length}`;
		}).join(", ");
		const rows = await this.client.unsafe<DecisionRow>(`
			UPDATE support_decisions
			SET decision = $2,
				decided_by = $3,
				executed_ref = COALESCE($4, executed_ref),
				amount_cents = COALESCE($5, amount_cents),
				currency = COALESCE($6, currency),
				reason = COALESCE($7, reason),
				decided_at = now()
			WHERE id = $1 AND decision = ANY(ARRAY[${allowedPlaceholders}]::text[])
			RETURNING ${COLUMNS}
		`, params);
		return rows[0] ? mapRow(rows[0]) : null;
	}

	async getAutoGrantVelocity(userId: string, now: () => number = Date.now): Promise<AutoGrantVelocity> {
		const id = userId?.trim();
		if (!id) return { dayCount: 0, monthCount: 0 };
		const nowMs = now();
		const dayStart = new Date(nowMs - DAY_MS);
		const monthStart = new Date(nowMs - MONTH_MS);
		const rows = await this.client.unsafe<{ day_count: string | number; month_count: string | number }>(`
			SELECT
				COUNT(*) FILTER (WHERE created_at >= $2) AS day_count,
				COUNT(*) FILTER (WHERE created_at >= $3) AS month_count
			FROM support_decisions
			WHERE user_id = $1
				AND decision = 'auto_approved'
				AND action = 'grant_credit'
				AND executed_ref IS NOT NULL
		`, [id, dayStart, monthStart]);
		return { dayCount: toInt(rows[0]?.day_count), monthCount: toInt(rows[0]?.month_count) };
	}

	async getAutoGrantWindowVolume(windowSeconds: number, now: () => number = Date.now): Promise<AutoGrantWindowVolume> {
		const windowStart = new Date(now() - Math.max(1, windowSeconds) * 1000);
		const rows = await this.client.unsafe<{ window_count: string | number; window_cents: string | number | null }>(`
			SELECT COUNT(*) AS window_count, COALESCE(SUM(amount_cents), 0) AS window_cents
			FROM support_decisions
			WHERE decision = 'auto_approved'
				AND action = 'grant_credit'
				AND executed_ref IS NOT NULL
				AND created_at >= $1
		`, [windowStart]);
		return { windowCount: toInt(rows[0]?.window_count), windowCents: toInt(rows[0]?.window_cents) };
	}

	async clawbackDecision(input: {
		id: string;
		decidedBy: string;
		reversal: ClawbackReversal;
		audit?: () => Promise<void>;
	}): Promise<{ won: boolean; record: SupportDecisionRecord | null }> {
		const id = input.id?.trim();
		if (!id) return { won: false, record: null };
		// Merge the FINAL reversal record into params in CODE. We read the current params
		// via the normal path so parseJson() un-wraps the double-encoded jsonb scalar this
		// store writes (symmetric with createDecision), avoiding the server-side
		// scalar-concat footgun.
		const current = await this.getById(id);
		if (!current) return { won: false, record: null };
		if (current.action !== "grant_credit"
			|| (current.decision !== "auto_approved" && current.decision !== "owner_approved")) {
			// Not an eligible executed grant (already clawed_back, or never executed) →
			// READ-ONLY no-op. A duplicate / loser gets the already-committed row back.
			return { won: false, record: current };
		}
		const mergedParams = { ...current.params, clawback: { ...input.reversal } };
		const decidedBy = input.decidedBy?.trim() || "owner";

		// ── ONE ATOMIC TRANSACTION: CAS → clawed_back + final amounts, then (winner-only)
		// the audit — all-or-nothing. The guarded UPDATE is the SINGLE winner-gate: the
		// DB row-lock serializes concurrent callers, so EXACTLY ONE matches the
		// auto_approved/owner_approved guard and writes both the state and the amounts in
		// the SAME statement (no observable pending-finalize). Only that winner runs the
		// audit, INSIDE the transaction, BEFORE commit; if it throws, the whole transition
		// rolls back (the row stays not-clawed-back) — nothing to revert, and a retry is a
		// clean fresh attempt. A committed clawed_back row therefore ALWAYS carries its
		// amounts AND has an audit row.
		const run = async (tx: DecisionSqlClient): Promise<{ won: boolean; record: SupportDecisionRecord | null }> => {
			const rows = await tx.unsafe<DecisionRow>(`
				UPDATE support_decisions
				SET decision = 'clawed_back',
					decided_by = $2,
					params = $3::text::jsonb,
					decided_at = now()
				WHERE id = $1
					AND action = 'grant_credit'
					AND decision IN ('auto_approved', 'owner_approved')
				RETURNING ${COLUMNS}
			`, [id, decidedBy, JSON.stringify(mergedParams)]);
			const won = rows[0];
			if (!won) {
				// Lost the race (a concurrent winner already committed clawed_back) → read-only.
				return { won: false, record: await this.getById(id) };
			}
			// Winner: run the audit inside the txn; a throw rolls back the UPDATE above.
			if (input.audit) await input.audit();
			return { won: true, record: mapRow(won) };
		};
		if (this.client.begin) return this.client.begin(run);
		return run(this.client);
	}

	async listByCreatedWindow(startMs: number, endMs: number, limit = 5000): Promise<SupportDecisionRecord[]> {
		const rows = await this.client.unsafe<DecisionRow>(`
			SELECT ${COLUMNS} FROM support_decisions
			WHERE created_at >= to_timestamp($1::double precision / 1000.0)
				AND created_at < to_timestamp($2::double precision / 1000.0)
			ORDER BY created_at ASC, id ASC
			LIMIT $3
		`, [startMs, endMs, Math.max(1, limit)]);
		return rows.map(mapRow);
	}
}

function isDecisionRecord(value: unknown): value is SupportDecisionRecord {
	const r = value as Partial<SupportDecisionRecord>;
	return Boolean(
		r
		&& typeof r.id === "string"
		&& typeof r.userId === "string"
		&& typeof r.idempotencyKey === "string"
		&& typeof r.createdAt === "string",
	);
}

export function createOwnerDecisionStore(): OwnerDecisionStore {
	if (serverConfig.billingStore === "postgres") {
		return new PostgresOwnerDecisionStore();
	}
	return new FileOwnerDecisionStore(join(DATA_DIR, "support-decisions.json"));
}

export const ownerDecisionStore: OwnerDecisionStore = createOwnerDecisionStore();
