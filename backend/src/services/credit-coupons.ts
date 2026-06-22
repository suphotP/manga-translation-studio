// Back-office: internal redeemable credit-coupon store + redeem logic.
//
// These are INTERNAL promo codes that grant spendable credits through the
// existing credits service — distinct from Dodo discount coupons (a percentage
// off a Dodo invoice, which never touch this module).
//
// Dual-store (File | Postgres), cloned from the proven support-tickets.ts shape:
//   - `CreditCouponStore` is the storage interface.
//   - `FileCreditCouponStore` is the in-memory + JSON snapshot used in tests and
//     the file/prototype runtime.
//   - `PostgresCreditCouponStore` writes credit_coupons + credit_coupon_redemptions
//     (migration 0055).
//   - `createCreditCouponStore()` picks one via CREDIT_COUPONS_STORE / DATABASE_URL,
//     mirroring support-tickets / billing-store gating.
//
// Redemption is IDEMPOTENT and RACE-SAFE:
//   - A (coupon, user, idempotency_key) unique index makes a retried redeem converge
//     on that user's existing row instead of reserving twice, without letting another
//     user's same client key collide.
//   - per_user_limit is enforced by counting the user's prior redemptions inside
//     the SAME transaction as the insert (the coupon row is SELECT ... FOR UPDATE
//     locked first, so concurrent redeems serialize).
//   - max_redemptions is enforced by an INSERT ... SELECT guarded on
//     COUNT(redemptions) < cap, so two concurrent redeems can't exceed the cap.
//
// reserveRedemption() ONLY reserves the row; it does NOT mint credits — the credit
// grant lives in a separate (file-backed) credits service that cannot join this
// Postgres transaction. The redeem ROUTE therefore mints the grant AFTER the
// reservation and writes the grant id back with attachGrantId(). A reservation whose
// grant_id is still NULL means the grant did not finish (the process died between the
// two steps); the route detects this on retry — reserveRedemption returns the existing
// row via the idempotency key, the route sees grantId == undefined, and it COMPLETES
// the grant idempotently (keyed on the redemption id). So a redemption is never left
// "consumed with no credits", and the grant can never be minted twice.
//
// SCALAR binds only — no Bun JS-array `= ANY($n::text[])`. (No array predicates
// are needed here, but the discipline is noted.)

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomBytes, randomUUID } from "crypto";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import type { CreditClass } from "./credits.js";

export const CREDIT_COUPON_STATUSES = ["active", "disabled"] as const;
export type CreditCouponStatus = (typeof CREDIT_COUPON_STATUSES)[number];

export function isCreditCouponStatus(value: unknown): value is CreditCouponStatus {
	return typeof value === "string" && (CREDIT_COUPON_STATUSES as readonly string[]).includes(value);
}

export interface CreditCouponRecord {
	id: string;
	code: string;
	creditAmount: number;
	creditClass: CreditClass;
	maxRedemptions: number | null;
	perUserLimit: number;
	expiresAt?: string;
	status: CreditCouponStatus;
	createdBy: string;
	note?: string;
	createdAt: string;
	updatedAt: string;
	/** Live total redemptions (populated by list/get for the admin dashboard). */
	redemptionCount?: number;
}

export interface CreditCouponRedemptionRecord {
	id: string;
	couponId: string;
	userId: string;
	workspaceId: string;
	grantId?: string;
	creditAmount: number;
	idempotencyKey: string;
	createdAt: string;
}

export interface CreateCreditCouponInput {
	/** Optional explicit code; uppercased + validated. Omitted → generated. */
	code?: string;
	creditAmount: number;
	creditClass?: CreditClass;
	maxRedemptions?: number | null;
	perUserLimit?: number;
	expiresAt?: string;
	createdBy: string;
	note?: string;
}

export interface RedeemInput {
	code: string;
	userId: string;
	workspaceId: string;
	/**
	 * Stable per-attempt key so a retried redeem never grants twice. The route
	 * derives a default (coupon+user) when the client omits one, so the common
	 * "one redemption per user" case is idempotent without client cooperation.
	 */
	idempotencyKey?: string;
	now?: Date;
}

export type RedeemOutcome =
	| { status: "redeemed"; coupon: CreditCouponRecord; redemption: CreditCouponRedemptionRecord; alreadyRedeemed: false }
	| { status: "already_redeemed"; coupon: CreditCouponRecord; redemption: CreditCouponRedemptionRecord; alreadyRedeemed: true };

export class CreditCouponError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "credit_coupon_error") {
		super(message);
		this.name = "CreditCouponError";
	}
}

// Code rules: 4..32 chars, uppercase A-Z 0-9 plus '-'. Generated codes avoid
// ambiguous chars (0/O, 1/I) so they are safe to read aloud / print.
const CODE_RE = /^[A-Z0-9-]{4,32}$/;
const GEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GEN_LENGTH = 12;

export function normalizeCouponCode(raw: string): string {
	const code = String(raw ?? "").trim().toUpperCase();
	if (!code) throw new CreditCouponError("Coupon code is required", 400, "coupon_code_required");
	if (!CODE_RE.test(code)) {
		throw new CreditCouponError(
			"Coupon code must be 4-32 chars of A-Z, 0-9 or '-'",
			400,
			"coupon_code_malformed",
		);
	}
	return code;
}

export function generateCouponCode(): string {
	const bytes = randomBytes(GEN_LENGTH);
	let out = "";
	for (let i = 0; i < GEN_LENGTH; i++) {
		out += GEN_ALPHABET[bytes[i]! % GEN_ALPHABET.length];
	}
	return out;
}

function normalizeCreditAmount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new CreditCouponError("creditAmount must be a positive integer", 400, "invalid_credit_amount");
	}
	if (n > 10_000_000) {
		throw new CreditCouponError("creditAmount is too large", 400, "credit_amount_too_large");
	}
	return n;
}

function normalizeMaxRedemptions(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new CreditCouponError("maxRedemptions must be a positive integer when set", 400, "invalid_max_redemptions");
	}
	return n;
}

function normalizePerUserLimit(value: unknown): number {
	if (value === undefined || value === null) return 1;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
		throw new CreditCouponError("perUserLimit must be an integer >= 1", 400, "invalid_per_user_limit");
	}
	return n;
}

function normalizeExpiresAt(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const time = Date.parse(String(value));
	if (!Number.isFinite(time)) {
		throw new CreditCouponError("expiresAt must be an ISO timestamp", 400, "invalid_expires_at");
	}
	return new Date(time).toISOString();
}

function normalizeCreditClass(value: unknown): CreditClass {
	if (value === undefined || value === null) return "personal";
	if (value === "personal" || value === "shareable") return value;
	throw new CreditCouponError("creditClass must be 'personal' or 'shareable'", 400, "invalid_credit_class");
}

function validateCreate(input: CreateCreditCouponInput): {
	code: string | undefined;
	creditAmount: number;
	creditClass: CreditClass;
	maxRedemptions: number | null;
	perUserLimit: number;
	expiresAt: string | undefined;
	createdBy: string;
	note: string | undefined;
} {
	const createdBy = String(input.createdBy ?? "").trim();
	if (!createdBy) throw new CreditCouponError("createdBy is required", 400, "missing_created_by");
	const code = input.code === undefined || input.code === null || input.code === ""
		? undefined
		: normalizeCouponCode(input.code);
	return {
		code,
		creditAmount: normalizeCreditAmount(input.creditAmount),
		creditClass: normalizeCreditClass(input.creditClass),
		maxRedemptions: normalizeMaxRedemptions(input.maxRedemptions),
		perUserLimit: normalizePerUserLimit(input.perUserLimit),
		expiresAt: normalizeExpiresAt(input.expiresAt),
		createdBy: createdBy.slice(0, 300),
		note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : undefined,
	};
}

/** A coupon is redeemable when active and not past its expiry. */
export function isCouponRedeemable(coupon: CreditCouponRecord, now: Date): { ok: true } | { ok: false; error: CreditCouponError } {
	if (coupon.status !== "active") {
		return { ok: false, error: new CreditCouponError("Coupon is not active", 409, "coupon_disabled") };
	}
	if (coupon.expiresAt && Date.parse(coupon.expiresAt) <= now.getTime()) {
		return { ok: false, error: new CreditCouponError("Coupon has expired", 410, "coupon_expired") };
	}
	return { ok: true };
}

export interface CreditCouponStore {
	createCoupon(input: CreateCreditCouponInput): Promise<CreditCouponRecord>;
	listCoupons(options?: { limit?: number }): Promise<CreditCouponRecord[]>;
	getCouponById(id: string): Promise<CreditCouponRecord | null>;
	getCouponByCode(code: string): Promise<CreditCouponRecord | null>;
	disableCoupon(id: string): Promise<CreditCouponRecord | null>;
	/**
	 * Idempotently reserve a redemption for (coupon, user). Returns the redemption
	 * row + whether it already existed (a retry/double-redeem). Enforces expiry,
	 * status, per_user_limit, and max_redemptions transactionally. Does NOT grant
	 * credits — the caller grants via the credits service and then records the
	 * grant id with `attachGrantId`. Throws CreditCouponError on policy violations.
	 */
	reserveRedemption(input: {
		code: string;
		userId: string;
		workspaceId: string;
		idempotencyKey: string;
		now: Date;
	}): Promise<RedeemOutcome>;
	/** Backfill the credits-service grant id onto a freshly-reserved redemption. */
	attachGrantId(redemptionId: string, grantId: string): Promise<void>;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function coerceLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit ?? Number.NaN)) return DEFAULT_LIST_LIMIT;
	const value = Math.floor(Number(limit));
	if (value <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(value, MAX_LIST_LIMIT);
}

// ── File / in-memory store ─────────────────────────────────────────

export class FileCreditCouponStore implements CreditCouponStore {
	private coupons: CreditCouponRecord[] = [];
	private redemptions: CreditCouponRedemptionRecord[] = [];

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async createCoupon(input: CreateCreditCouponInput): Promise<CreditCouponRecord> {
		const v = validateCreate(input);
		const code = v.code ?? this.generateUniqueCode();
		if (this.coupons.some((c) => c.code === code)) {
			throw new CreditCouponError("Coupon code already exists", 409, "coupon_code_conflict");
		}
		const now = new Date().toISOString();
		const record: CreditCouponRecord = {
			id: randomUUID(),
			code,
			creditAmount: v.creditAmount,
			creditClass: v.creditClass,
			maxRedemptions: v.maxRedemptions,
			perUserLimit: v.perUserLimit,
			expiresAt: v.expiresAt,
			status: "active",
			createdBy: v.createdBy,
			note: v.note,
			createdAt: now,
			updatedAt: now,
		};
		this.coupons.unshift(record);
		this.persist();
		return this.withCount(record);
	}

	private generateUniqueCode(): string {
		for (let i = 0; i < 8; i++) {
			const code = generateCouponCode();
			if (!this.coupons.some((c) => c.code === code)) return code;
		}
		throw new CreditCouponError("Failed to generate a unique coupon code", 500, "coupon_code_generation_failed");
	}

	async listCoupons(options: { limit?: number } = {}): Promise<CreditCouponRecord[]> {
		const limit = coerceLimit(options.limit);
		return this.coupons
			.slice()
			.sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
			.slice(0, limit)
			.map((c) => this.withCount(c));
	}

	async getCouponById(id: string): Promise<CreditCouponRecord | null> {
		const found = this.coupons.find((c) => c.id === id.trim());
		return found ? this.withCount(found) : null;
	}

	async getCouponByCode(code: string): Promise<CreditCouponRecord | null> {
		const normalized = code.trim().toUpperCase();
		const found = this.coupons.find((c) => c.code === normalized);
		return found ? this.withCount(found) : null;
	}

	async disableCoupon(id: string): Promise<CreditCouponRecord | null> {
		const coupon = this.coupons.find((c) => c.id === id.trim());
		if (!coupon) return null;
		coupon.status = "disabled";
		coupon.updatedAt = new Date().toISOString();
		this.persist();
		return this.withCount(coupon);
	}

	async reserveRedemption(input: {
		code: string;
		userId: string;
		workspaceId: string;
		idempotencyKey: string;
		now: Date;
	}): Promise<RedeemOutcome> {
		const code = input.code.trim().toUpperCase();
		const userId = input.userId.trim();
		const workspaceId = input.workspaceId.trim();
		const coupon = this.coupons.find((c) => c.code === code);
		if (!coupon) throw new CreditCouponError("Coupon not found", 404, "coupon_not_found");

		// Idempotency: a retry by the same user with the same key returns the
		// existing redemption. Different users may legitimately send the same client
		// key, so userId is part of the dedup identity.
		const existingByKey = this.redemptions.find(
			(r) => r.couponId === coupon.id && r.userId === userId && r.idempotencyKey === input.idempotencyKey,
		);
		if (existingByKey) {
			return { status: "already_redeemed", coupon: this.withCount(coupon), redemption: { ...existingByKey }, alreadyRedeemed: true };
		}

		const redeemable = isCouponRedeemable(coupon, input.now);
		if (!redeemable.ok) throw redeemable.error;

		const userRedemptions = this.redemptions.filter((r) => r.couponId === coupon.id && r.userId === userId).length;
		if (userRedemptions >= coupon.perUserLimit) {
			throw new CreditCouponError("Per-user redemption limit reached", 409, "per_user_limit_reached");
		}
		const totalRedemptions = this.redemptions.filter((r) => r.couponId === coupon.id).length;
		if (coupon.maxRedemptions !== null && totalRedemptions >= coupon.maxRedemptions) {
			throw new CreditCouponError("Coupon redemption limit reached", 409, "max_redemptions_reached");
		}

		const redemption: CreditCouponRedemptionRecord = {
			id: randomUUID(),
			couponId: coupon.id,
			userId,
			workspaceId,
			creditAmount: coupon.creditAmount,
			idempotencyKey: input.idempotencyKey,
			createdAt: input.now.toISOString(),
		};
		this.redemptions.push(redemption);
		this.persist();
		return { status: "redeemed", coupon: this.withCount(coupon), redemption: { ...redemption }, alreadyRedeemed: false };
	}

	async attachGrantId(redemptionId: string, grantId: string): Promise<void> {
		const redemption = this.redemptions.find((r) => r.id === redemptionId);
		if (!redemption) return;
		redemption.grantId = grantId;
		this.persist();
	}

	private withCount(coupon: CreditCouponRecord): CreditCouponRecord {
		const redemptionCount = this.redemptions.filter((r) => r.couponId === coupon.id).length;
		return { ...coupon, redemptionCount };
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ coupons?: CreditCouponRecord[]; redemptions?: CreditCouponRedemptionRecord[] }>(this.persistPath);
			this.coupons = Array.isArray(snapshot.coupons) ? snapshot.coupons : [];
			this.redemptions = Array.isArray(snapshot.redemptions) ? snapshot.redemptions : [];
		} catch (error) {
			console.warn(`[CreditCouponStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ coupons: this.coupons, redemptions: this.redemptions }, null, 2));
	}

	resetForTests(): void {
		this.coupons = [];
		this.redemptions = [];
		this.persist();
	}
}

// ── Postgres store ─────────────────────────────────────────────────

export interface CreditCouponSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: CreditCouponSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface CouponRow {
	id: string;
	code: string;
	credit_amount: number | string;
	credit_class: string;
	max_redemptions: number | string | null;
	per_user_limit: number | string;
	expires_at: Date | string | null;
	status: string;
	created_by: string;
	note: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	redemption_count?: number | string | null;
}

interface RedemptionRow {
	id: string;
	coupon_id: string;
	user_id: string;
	workspace_id: string;
	grant_id: string | null;
	credit_amount: number | string;
	idempotency_key: string;
	created_at: Date | string;
}

function toIso(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text || undefined;
}

function toInt(value: number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.floor(n) : 0;
}

function mapCouponRow(row: CouponRow): CreditCouponRecord {
	return {
		id: row.id,
		code: row.code,
		creditAmount: toInt(row.credit_amount),
		creditClass: (row.credit_class === "shareable" ? "shareable" : "personal") as CreditClass,
		maxRedemptions: row.max_redemptions === null || row.max_redemptions === undefined ? null : toInt(row.max_redemptions),
		perUserLimit: toInt(row.per_user_limit) || 1,
		expiresAt: toIso(row.expires_at),
		status: (isCreditCouponStatus(row.status) ? row.status : "active") as CreditCouponStatus,
		createdBy: row.created_by,
		note: row.note ?? undefined,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
		updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
		redemptionCount: row.redemption_count === undefined || row.redemption_count === null ? undefined : toInt(row.redemption_count),
	};
}

function mapRedemptionRow(row: RedemptionRow): CreditCouponRedemptionRecord {
	return {
		id: row.id,
		couponId: row.coupon_id,
		userId: row.user_id,
		workspaceId: row.workspace_id,
		grantId: row.grant_id ?? undefined,
		creditAmount: toInt(row.credit_amount),
		idempotencyKey: row.idempotency_key,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
	};
}

const COUPON_COLUMNS = `id, code, credit_amount, credit_class, max_redemptions, per_user_limit,
	expires_at, status, created_by, note, created_at, updated_at`;

const REDEMPTION_COLUMNS = `id, coupon_id, user_id, workspace_id, grant_id, credit_amount, idempotency_key, created_at`;

export class PostgresCreditCouponStore implements CreditCouponStore {
	private readonly client: CreditCouponSqlClient;

	constructor(databaseUrlOrClient: string | CreditCouponSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new CreditCouponError("CREDIT_COUPONS_STORE=postgres requires DATABASE_URL", 503, "credit_coupon_store_unconfigured");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as CreditCouponSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async createCoupon(input: CreateCreditCouponInput): Promise<CreditCouponRecord> {
		const v = validateCreate(input);
		const now = new Date();
		// Generate-and-retry on unique-code conflict for the auto-generated path.
		const attempts = v.code ? 1 : 8;
		let lastError: unknown;
		for (let i = 0; i < attempts; i++) {
			const code = v.code ?? generateCouponCode();
			try {
				const rows = await this.client.unsafe<CouponRow>(`
					INSERT INTO credit_coupons
						(id, code, credit_amount, credit_class, max_redemptions, per_user_limit, expires_at, status, created_by, note, created_at, updated_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10)
					RETURNING ${COUPON_COLUMNS}
				`, [
					randomUUID(),
					code,
					v.creditAmount,
					v.creditClass,
					v.maxRedemptions,
					v.perUserLimit,
					v.expiresAt ?? null,
					v.createdBy,
					v.note ?? null,
					now.toISOString(),
				]);
				const row = rows[0];
				if (!row) throw new CreditCouponError("Failed to persist coupon", 500, "coupon_create_failed");
				return { ...mapCouponRow(row), redemptionCount: 0 };
			} catch (error) {
				lastError = error;
				if (isUniqueViolation(error)) {
					if (v.code) throw new CreditCouponError("Coupon code already exists", 409, "coupon_code_conflict");
					continue; // generated collision — retry with a new code
				}
				throw error;
			}
		}
		throw lastError instanceof Error ? lastError : new CreditCouponError("Failed to create coupon", 500, "coupon_create_failed");
	}

	async listCoupons(options: { limit?: number } = {}): Promise<CreditCouponRecord[]> {
		const limit = coerceLimit(options.limit);
		const rows = await this.client.unsafe<CouponRow>(`
			SELECT ${COUPON_COLUMNS},
				(SELECT COUNT(*) FROM credit_coupon_redemptions r WHERE r.coupon_id = credit_coupons.id) AS redemption_count
			FROM credit_coupons
			ORDER BY created_at DESC, id DESC
			LIMIT $1
		`, [limit]);
		return rows.map(mapCouponRow);
	}

	async getCouponById(id: string): Promise<CreditCouponRecord | null> {
		const rows = await this.client.unsafe<CouponRow>(`
			SELECT ${COUPON_COLUMNS},
				(SELECT COUNT(*) FROM credit_coupon_redemptions r WHERE r.coupon_id = credit_coupons.id) AS redemption_count
			FROM credit_coupons WHERE id = $1
		`, [id.trim()]);
		const row = rows[0];
		return row ? mapCouponRow(row) : null;
	}

	async getCouponByCode(code: string): Promise<CreditCouponRecord | null> {
		const rows = await this.client.unsafe<CouponRow>(`
			SELECT ${COUPON_COLUMNS},
				(SELECT COUNT(*) FROM credit_coupon_redemptions r WHERE r.coupon_id = credit_coupons.id) AS redemption_count
			FROM credit_coupons WHERE code = $1
		`, [code.trim().toUpperCase()]);
		const row = rows[0];
		return row ? mapCouponRow(row) : null;
	}

	async disableCoupon(id: string): Promise<CreditCouponRecord | null> {
		const rows = await this.client.unsafe<CouponRow>(`
			UPDATE credit_coupons SET status = 'disabled', updated_at = now()
			WHERE id = $1
			RETURNING ${COUPON_COLUMNS},
				(SELECT COUNT(*) FROM credit_coupon_redemptions r WHERE r.coupon_id = credit_coupons.id) AS redemption_count
		`, [id.trim()]);
		const row = rows[0];
		return row ? mapCouponRow(row) : null;
	}

	async reserveRedemption(input: {
		code: string;
		userId: string;
		workspaceId: string;
		idempotencyKey: string;
		now: Date;
	}): Promise<RedeemOutcome> {
		const code = input.code.trim().toUpperCase();
		const userId = input.userId.trim();
		const workspaceId = input.workspaceId.trim();

		const run = async (tx: CreditCouponSqlClient): Promise<RedeemOutcome> => {
			// Lock the coupon row so concurrent redeems serialize on max_redemptions.
			const couponRows = await tx.unsafe<CouponRow>(`
				SELECT ${COUPON_COLUMNS} FROM credit_coupons WHERE code = $1 FOR UPDATE
			`, [code]);
			const couponRow = couponRows[0];
			if (!couponRow) throw new CreditCouponError("Coupon not found", 404, "coupon_not_found");
			const coupon = mapCouponRow(couponRow);

			// Idempotency: a retry by the same user with the same key converges on the
			// existing row. The user_id predicate prevents cross-user client-key
			// collisions from blocking or redirecting another user's redemption.
			const existing = await tx.unsafe<RedemptionRow>(`
				SELECT ${REDEMPTION_COLUMNS} FROM credit_coupon_redemptions
				WHERE coupon_id = $1 AND user_id = $2 AND idempotency_key = $3
			`, [coupon.id, userId, input.idempotencyKey]);
			if (existing[0]) {
				return { status: "already_redeemed", coupon: await this.couponWithCount(tx, coupon), redemption: mapRedemptionRow(existing[0]), alreadyRedeemed: true };
			}

			const redeemable = isCouponRedeemable(coupon, input.now);
			if (!redeemable.ok) throw redeemable.error;

			const userCountRows = await tx.unsafe<{ count: number | string }>(`
				SELECT COUNT(*) AS count FROM credit_coupon_redemptions WHERE coupon_id = $1 AND user_id = $2
			`, [coupon.id, userId]);
			if (toInt(userCountRows[0]?.count) >= coupon.perUserLimit) {
				throw new CreditCouponError("Per-user redemption limit reached", 409, "per_user_limit_reached");
			}

			// Insert guarded on the total cap so two concurrent redeems can't exceed
			// max_redemptions. The WHERE evaluates against the (FOR UPDATE-locked)
			// coupon's current redemption count; a NULL cap means unlimited.
			const redemptionId = randomUUID();
			const inserted = await tx.unsafe<RedemptionRow>(`
				INSERT INTO credit_coupon_redemptions
					(id, coupon_id, user_id, workspace_id, credit_amount, idempotency_key, created_at)
				SELECT $1, $2, $3, $4, $5, $6, $7
				WHERE (
					SELECT max_redemptions FROM credit_coupons WHERE id = $2
				) IS NULL
				OR (
					SELECT COUNT(*) FROM credit_coupon_redemptions WHERE coupon_id = $2
				) < (
					SELECT max_redemptions FROM credit_coupons WHERE id = $2
				)
				RETURNING ${REDEMPTION_COLUMNS}
			`, [redemptionId, coupon.id, userId, workspaceId, coupon.creditAmount, input.idempotencyKey, input.now.toISOString()]);
			if (!inserted[0]) {
				throw new CreditCouponError("Coupon redemption limit reached", 409, "max_redemptions_reached");
			}
			return { status: "redeemed", coupon: await this.couponWithCount(tx, coupon), redemption: mapRedemptionRow(inserted[0]), alreadyRedeemed: false };
		};

		if (this.client.begin) return this.client.begin(run);
		return run(this.client);
	}

	private async couponWithCount(tx: CreditCouponSqlClient, coupon: CreditCouponRecord): Promise<CreditCouponRecord> {
		const rows = await tx.unsafe<{ count: number | string }>(`
			SELECT COUNT(*) AS count FROM credit_coupon_redemptions WHERE coupon_id = $1
		`, [coupon.id]);
		return { ...coupon, redemptionCount: toInt(rows[0]?.count) };
	}

	async attachGrantId(redemptionId: string, grantId: string): Promise<void> {
		await this.client.unsafe(`
			UPDATE credit_coupon_redemptions SET grant_id = $2 WHERE id = $1
		`, [redemptionId, grantId]);
	}
}

function isUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	if (code === "23505") return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && /duplicate key value|unique constraint/i.test(message);
}

// ── Store factory ──────────────────────────────────────────────────

function resolveStoreMode(): "file" | "postgres" {
	const override = process.env.CREDIT_COUPONS_STORE?.trim().toLowerCase();
	if (override === "postgres") return "postgres";
	if (override === "file") return "file";
	return serverConfig.billingStore === "postgres" ? "postgres" : "file";
}

export function createCreditCouponStore(): CreditCouponStore {
	if (resolveStoreMode() === "postgres") {
		return new PostgresCreditCouponStore();
	}
	return new FileCreditCouponStore(join(DATA_DIR, "credit-coupons.json"));
}

export const creditCouponStore: CreditCouponStore = createCreditCouponStore();
