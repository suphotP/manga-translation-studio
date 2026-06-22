// AI-support — payment reconciliation audit store.
//
// Durable record of every reconciliation decision the gpt-5.5 support agent (or a
// human) makes about a "paid-but-not-credited" discrepancy. Backs migration 0058's
// `payment_reconciliations` table. Two responsibilities:
//   1. AUDIT — one row per decision (none / granted / flagged_for_human), with the
//      detected discrepancy, what was actually granted, and who acted.
//   2. IDEMPOTENCY — a unique idempotency_key (per ticket+discrepancy) so the SAME
//      discrepancy can never be granted twice. recordDecision() is insert-if-absent:
//      a key already present returns the existing row WITHOUT a second grant, which
//      is what makes grant_credit safe under a retried agent loop / re-trigger.
//
// Mirrors the file|postgres dual-store shape of support-tickets.ts /
// payment-transactions-store.ts so local/test runs work without DATABASE_URL.

import { getSharedBunSql } from "../sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../../config.js";
import { readJsonFile } from "../../utils/json-file.js";

export const RECONCILIATION_ACTIONS = ["none", "granted", "flagged_for_human"] as const;
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

export const RECONCILIATION_ACTORS = ["ai", "human"] as const;
export type ReconciliationActor = (typeof RECONCILIATION_ACTORS)[number];

export interface PaymentReconciliationRecord {
	id: string;
	userId: string;
	ticketId?: string;
	detectedDiscrepancyCents: number;
	currency?: string;
	action: ReconciliationAction;
	grantedCents: number;
	actor: ReconciliationActor;
	idempotencyKey: string;
	createdAt: string;
}

export interface RecordReconciliationInput {
	userId: string;
	ticketId?: string;
	detectedDiscrepancyCents: number;
	currency?: string;
	action: ReconciliationAction;
	grantedCents?: number;
	actor?: ReconciliationActor;
	/**
	 * Idempotency key. Defaults to `recon:<ticketId>` so a given ticket can only ever
	 * resolve ONE discrepancy (a re-triggered agent loop reuses the same key and gets
	 * the existing row back instead of granting again). Callers wanting a finer grain
	 * (e.g. one per detected discrepancy hash) may pass an explicit key.
	 */
	idempotencyKey?: string;
}

export interface RecordReconciliationResult {
	record: PaymentReconciliationRecord;
	/** False when an existing row was returned (idempotent no-op) — the caller must NOT grant again. */
	created: boolean;
}

export class PaymentReconciliationStoreError extends Error {
	constructor(message: string, readonly code = "payment_reconciliation_store_error") {
		super(message);
		this.name = "PaymentReconciliationStoreError";
	}
}

export interface PaymentReconciliationStore {
	/** Insert-if-absent on the idempotency key. created=false ⇒ already handled, do NOT grant again. */
	recordDecision(input: RecordReconciliationInput): Promise<RecordReconciliationResult>;
	/** The existing decision for an idempotency key, or null. */
	getByIdempotencyKey(idempotencyKey: string): Promise<PaymentReconciliationRecord | null>;
	/** All decisions for a user, newest first (audit / customer-360). */
	listByUser(userId: string): Promise<PaymentReconciliationRecord[]>;
}

function clampCents(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function normalizeInput(input: RecordReconciliationInput): {
	userId: string;
	ticketId?: string;
	detectedDiscrepancyCents: number;
	currency?: string;
	action: ReconciliationAction;
	grantedCents: number;
	actor: ReconciliationActor;
	idempotencyKey: string;
} {
	const userId = input.userId?.trim();
	if (!userId) throw new PaymentReconciliationStoreError("userId is required", "reconciliation_invalid_user");
	const action = (RECONCILIATION_ACTIONS as readonly string[]).includes(input.action) ? input.action : "none";
	const actor = input.actor && (RECONCILIATION_ACTORS as readonly string[]).includes(input.actor) ? input.actor : "ai";
	const ticketId = input.ticketId?.trim() || undefined;
	const idempotencyKey = input.idempotencyKey?.trim()
		|| (ticketId ? `recon:${ticketId}` : `recon:user:${userId}:${uuid()}`);
	return {
		userId,
		ticketId,
		detectedDiscrepancyCents: clampCents(input.detectedDiscrepancyCents),
		currency: input.currency?.trim()?.toUpperCase() || undefined,
		action,
		// granted_cents is only meaningful for a 'granted' action; force 0 otherwise so
		// an audit reader can trust the column without cross-checking the action.
		grantedCents: action === "granted" ? clampCents(input.grantedCents) : 0,
		actor,
		idempotencyKey,
	};
}

/** In-memory + JSON-snapshot store (tests + file/prototype runtime). */
export class FilePaymentReconciliationStore implements PaymentReconciliationStore {
	private readonly records: PaymentReconciliationRecord[] = [];
	private readonly byKey = new Map<string, PaymentReconciliationRecord>();

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async recordDecision(input: RecordReconciliationInput): Promise<RecordReconciliationResult> {
		const normalized = normalizeInput(input);
		const existing = this.byKey.get(normalized.idempotencyKey);
		if (existing) return { record: { ...existing }, created: false };
		const record: PaymentReconciliationRecord = {
			id: uuid(),
			userId: normalized.userId,
			ticketId: normalized.ticketId,
			detectedDiscrepancyCents: normalized.detectedDiscrepancyCents,
			currency: normalized.currency,
			action: normalized.action,
			grantedCents: normalized.grantedCents,
			actor: normalized.actor,
			idempotencyKey: normalized.idempotencyKey,
			createdAt: new Date().toISOString(),
		};
		this.records.push(record);
		this.byKey.set(record.idempotencyKey, record);
		try {
			this.persist();
		} catch (error) {
			this.records.pop();
			this.byKey.delete(record.idempotencyKey);
			throw error;
		}
		return { record: { ...record }, created: true };
	}

	async getByIdempotencyKey(idempotencyKey: string): Promise<PaymentReconciliationRecord | null> {
		const key = idempotencyKey?.trim();
		if (!key) return null;
		const found = this.byKey.get(key);
		return found ? { ...found } : null;
	}

	async listByUser(userId: string): Promise<PaymentReconciliationRecord[]> {
		const id = userId?.trim();
		if (!id) return [];
		return this.records
			.filter((r) => r.userId === id)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
			.map((r) => ({ ...r }));
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ records?: PaymentReconciliationRecord[] }>(this.persistPath);
			if (Array.isArray(snapshot.records)) {
				for (const entry of snapshot.records) {
					if (isReconciliationRecord(entry)) {
						this.records.push(entry);
						this.byKey.set(entry.idempotencyKey, entry);
					}
				}
			}
		} catch (error) {
			console.warn(`[PaymentReconciliationStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ records: this.records }, null, 2));
	}
}

export interface ReconciliationSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface ReconciliationRow {
	id: string;
	user_id: string;
	ticket_id: string | null;
	detected_discrepancy_cents: number | string;
	currency: string | null;
	action: string;
	granted_cents: number | string;
	actor: string;
	idempotency_key: string;
	created_at: Date | string;
}

function toInt(value: number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.floor(n) : 0;
}

function mapRow(row: ReconciliationRow): PaymentReconciliationRecord {
	return {
		id: row.id,
		userId: row.user_id,
		ticketId: row.ticket_id ?? undefined,
		detectedDiscrepancyCents: toInt(row.detected_discrepancy_cents),
		currency: row.currency ?? undefined,
		action: (RECONCILIATION_ACTIONS as readonly string[]).includes(row.action) ? (row.action as ReconciliationAction) : "none",
		grantedCents: toInt(row.granted_cents),
		actor: (RECONCILIATION_ACTORS as readonly string[]).includes(row.actor) ? (row.actor as ReconciliationActor) : "ai",
		idempotencyKey: row.idempotency_key,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString(),
	};
}

const COLUMNS = `id, user_id, ticket_id, detected_discrepancy_cents, currency, action, granted_cents, actor, idempotency_key, created_at`;

/**
 * Postgres store. The INSERT ... ON CONFLICT (idempotency_key) DO NOTHING is the
 * single-grant guarantee at the DATABASE layer: two concurrent agent loops racing
 * the same ticket both attempt the insert, exactly one wins, and the loser reads the
 * winner's row back via getByIdempotencyKey — so the discrepancy is granted once.
 */
export class PostgresPaymentReconciliationStore implements PaymentReconciliationStore {
	private readonly client: ReconciliationSqlClient;

	constructor(databaseUrlOrClient: string | ReconciliationSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new PaymentReconciliationStoreError(
					"PaymentReconciliationStore postgres mode requires DATABASE_URL",
					"payment_reconciliation_store_unconfigured",
				);
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as ReconciliationSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async recordDecision(input: RecordReconciliationInput): Promise<RecordReconciliationResult> {
		const n = normalizeInput(input);
		const rows = await this.client.unsafe<ReconciliationRow>(`
			INSERT INTO payment_reconciliations
				(id, user_id, ticket_id, detected_discrepancy_cents, currency, action, granted_cents, actor, idempotency_key)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (idempotency_key) DO NOTHING
			RETURNING ${COLUMNS}
		`, [
			uuid(),
			n.userId,
			n.ticketId ?? null,
			n.detectedDiscrepancyCents,
			n.currency ?? null,
			n.action,
			n.grantedCents,
			n.actor,
			n.idempotencyKey,
		]);
		const inserted = rows[0];
		if (inserted) return { record: mapRow(inserted), created: true };
		// Conflict: the row already exists (a prior decision for this key). Return it
		// so the caller treats this as already-handled (idempotent — no second grant).
		const existing = await this.getByIdempotencyKey(n.idempotencyKey);
		if (!existing) {
			throw new PaymentReconciliationStoreError("Reconciliation conflict but no existing row found", "payment_reconciliation_conflict");
		}
		return { record: existing, created: false };
	}

	async getByIdempotencyKey(idempotencyKey: string): Promise<PaymentReconciliationRecord | null> {
		const key = idempotencyKey?.trim();
		if (!key) return null;
		const rows = await this.client.unsafe<ReconciliationRow>(`
			SELECT ${COLUMNS} FROM payment_reconciliations WHERE idempotency_key = $1 LIMIT 1
		`, [key]);
		return rows[0] ? mapRow(rows[0]) : null;
	}

	async listByUser(userId: string): Promise<PaymentReconciliationRecord[]> {
		const id = userId?.trim();
		if (!id) return [];
		const rows = await this.client.unsafe<ReconciliationRow>(`
			SELECT ${COLUMNS} FROM payment_reconciliations
			WHERE user_id = $1
			ORDER BY created_at DESC, id DESC
		`, [id]);
		return rows.map(mapRow);
	}
}

function isReconciliationRecord(value: unknown): value is PaymentReconciliationRecord {
	const r = value as Partial<PaymentReconciliationRecord>;
	return Boolean(
		r
		&& typeof r.id === "string"
		&& typeof r.userId === "string"
		&& typeof r.idempotencyKey === "string"
		&& typeof r.createdAt === "string",
	);
}

export function createPaymentReconciliationStore(): PaymentReconciliationStore {
	if (serverConfig.billingStore === "postgres") {
		return new PostgresPaymentReconciliationStore();
	}
	return new FilePaymentReconciliationStore(join(DATA_DIR, "payment-reconciliations.json"));
}

export const paymentReconciliationStore: PaymentReconciliationStore = createPaymentReconciliationStore();
