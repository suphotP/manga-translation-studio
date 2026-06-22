// Wave 2 W2.5 — Notifications service.
//
// Backs the topbar bell + the workspace notification panel with a real,
// durable, user-scoped notification feed. Mirrors the file|postgres pattern
// used by billing-store / upload-audit / project-catalog so local prototype
// runs keep working without DATABASE_URL while production reads/writes the
// 0041 migration tables (later: type column converted to text+CHECK in 0054).
//
// Layered shape:
//   - `NotificationStore` is the storage interface (create, list, mark read,
//     mark-all read, unread-count).
//   - `FileNotificationStore` is the in-memory + JSON snapshot used in tests
//     and the prototype local backend.
//   - `PostgresNotificationStore` is the production path, writing the
//     `notifications` table from 0041 (type is text+CHECK after 0054).
//   - `createNotificationStore()` picks one based on `NOTIFICATIONS_STORE` /
//     `DATABASE_URL`.
//
// The route uses these helpers via the exported `notificationStore` singleton
// and `createNotificationStore()` for tests that need an isolated instance.

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { pushArrayLiteral } from "./pg-array.js";

/**
 * Notification taxonomy — the single source of truth, kept in sync with the
 * `notifications_type_check` CHECK constraint in migration 0054.
 *
 * Historically these values lived in a Postgres enum (defined in 0041, despite
 * old comments calling it the "0028 enum"). 0054 converts that column to
 * text + CHECK precisely so new types can be added here with a one-line CHECK
 * swap instead of an impossible-in-a-transaction `ALTER TYPE ... ADD VALUE`.
 */
export const NOTIFICATION_TYPES = [
	"comment_new",
	"comment_reply",
	"ai_job_complete",
	"ai_job_failed",
	"chapter_submitted",
	"chapter_approved",
	"chapter_rejected",
	"invite_received",
	"quota_warning_80pct",
	"quota_frozen",
	"payment_succeeded",
	"payment_failed",
	"team_member_joined",
	"task_assigned",
	"work_assigned",
	"review_cancelled",
	"revision_requested",
	"editing_taken_over",
	"ticket_opened",
	"ticket_replied",
	"ticket_escalated",
	"ticket_resolved",
	"account_export_ready",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * High-level grouping the frontend tab filter uses (All / Tasks / Billing /
 * System). Kept in the service so the bucket math is consistent between the
 * panel, the full /notifications page and the unread-by-bucket metric.
 */
export type NotificationCategory = "tasks" | "support" | "billing" | "system";

const TYPE_CATEGORY: Record<NotificationType, NotificationCategory> = {
	comment_new: "tasks",
	comment_reply: "tasks",
	ai_job_complete: "tasks",
	ai_job_failed: "tasks",
	chapter_submitted: "tasks",
	chapter_approved: "tasks",
	chapter_rejected: "tasks",
	task_assigned: "tasks",
	work_assigned: "tasks",
	review_cancelled: "tasks",
	revision_requested: "tasks",
	editing_taken_over: "tasks",
	invite_received: "system",
	quota_warning_80pct: "billing",
	quota_frozen: "billing",
	payment_succeeded: "billing",
	payment_failed: "billing",
	team_member_joined: "system",
	ticket_opened: "support",
	ticket_replied: "support",
	ticket_escalated: "support",
	ticket_resolved: "support",
	account_export_ready: "system",
};

export function categoryForNotificationType(type: NotificationType): NotificationCategory {
	return TYPE_CATEGORY[type] ?? "system";
}

export function isNotificationType(value: unknown): value is NotificationType {
	return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export interface NotificationRecord {
	id: string;
	userId: string;
	workspaceId?: string;
	type: NotificationType;
	title: string;
	body?: string;
	linkUrl?: string;
	metadata: Record<string, unknown>;
	readAt?: string;
	createdAt: string;
}

export interface CreateNotificationInput {
	userId: string;
	workspaceId?: string;
	type: NotificationType;
	title: string;
	body?: string;
	linkUrl?: string;
	metadata?: Record<string, unknown>;
	/**
	 * Optional DURABLE in-app dedupe key. When set, `create()` is a no-op (returns the
	 * already-stored row) if a notification for the SAME (userId, dedupeKey) already
	 * exists. Used to collapse two webhook deliveries for the SAME charge (Dodo
	 * payment.succeeded + invoice.paid) into ONE in-app receipt row, and to fire a
	 * quota threshold notice at most once per workspace+period+tier even when the
	 * pre-reservation usage snapshot was unavailable. The key is persisted in
	 * `metadata.__dedupeKey` so the guard survives a restart (file mode) / is queryable
	 * (postgres). NOT a privacy field — it never surfaces in the rendered notification.
	 */
	dedupeKey?: string;
}

/** Internal metadata field that carries the durable dedupe key (see CreateNotificationInput.dedupeKey). */
export const NOTIFICATION_DEDUPE_METADATA_KEY = "__dedupeKey";

export interface ListNotificationsOptions {
	/** Hard cap: how many rows to return. Coerced to [1, 100]; default 20. */
	limit?: number;
	/**
	 * Cursor: return rows STRICTLY OLDER than the row whose id is `beforeId`.
	 * Tie-broken on created_at, then id, so paging is deterministic when two
	 * notifications share a timestamp.
	 */
	beforeId?: string;
	/** When true, restrict to unread (read_at IS NULL). */
	unreadOnly?: boolean;
}

export interface NotificationPage {
	items: NotificationRecord[];
	/** Id of the last item — caller passes it back as `beforeId` for the next page. */
	nextCursor?: string;
	hasMore: boolean;
}

export class NotificationStoreError extends Error {
	constructor(message: string, readonly code = "notification_store_error") {
		super(message);
		this.name = "NotificationStoreError";
	}
}

export interface NotificationStore {
	create(input: CreateNotificationInput): Promise<NotificationRecord>;
	/**
	 * Look up an existing notification for this (userId, dedupeKey), or null. Used by the
	 * dispatcher to skip a duplicate in-app row (and its realtime fan-out) BEFORE calling
	 * create(); create() still enforces the durable guard as the authoritative backstop.
	 */
	findByDedupeKey(userId: string, dedupeKey: string): Promise<NotificationRecord | null>;
	listForUser(userId: string, options?: ListNotificationsOptions): Promise<NotificationPage>;
	/**
	 * Read a single notification owned by `userId` WITHOUT mutating it. Returns null
	 * when the id does not exist or belongs to another user. Used to check
	 * membership/visibility BEFORE a read-mutation so a notification for a workspace
	 * the user has left is never mutated then 404'd (a16 re-review P1 #2).
	 */
	getForUser(userId: string, notificationId: string): Promise<NotificationRecord | null>;
	markRead(userId: string, notificationId: string): Promise<NotificationRecord | null>;
	markAllRead(userId: string): Promise<number>;
	/**
	 * Mark a SPECIFIC set of the user's unread notifications read (by id). Used by
	 * mark-all-read once it has been scoped to the recipient's CURRENT workspace
	 * memberships, so notifications in a workspace the user has LEFT are never
	 * mutated (a16 re-review P1 #2). Returns the count actually flipped unread→read.
	 */
	markReadByIds(userId: string, notificationIds: string[]): Promise<number>;
	unreadCount(userId: string): Promise<number>;
	/**
	 * GDPR right-to-erasure: delete every notification addressed to this user.
	 * Titles/bodies are entirely the subject's personal data, so the whole inbox is
	 * dropped. Idempotent — a re-run on an already-empty inbox is a no-op.
	 */
	erasePiiForUser(userId: string): Promise<number>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function coerceLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit ?? Number.NaN)) return DEFAULT_LIMIT;
	const value = Math.floor(Number(limit));
	if (value <= 0) return DEFAULT_LIMIT;
	return Math.min(value, MAX_LIMIT);
}

function validateCreateInput(input: CreateNotificationInput): CreateNotificationInput {
	const userId = input.userId?.trim();
	if (!userId) {
		throw new NotificationStoreError("userId is required", "notification_invalid_user");
	}
	if (!isNotificationType(input.type)) {
		throw new NotificationStoreError(`Unknown notification type '${String(input.type)}'`, "notification_unknown_type");
	}
	const title = input.title?.trim();
	if (!title) {
		throw new NotificationStoreError("title is required", "notification_invalid_title");
	}
	const dedupeKey = input.dedupeKey?.trim() || undefined;
	const metadata: Record<string, unknown> =
		input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {};
	// Stamp the durable dedupe key into metadata so the once-only guard survives a
	// restart (file mode) and is queryable (postgres). Reserved key, never user-facing.
	if (dedupeKey) metadata[NOTIFICATION_DEDUPE_METADATA_KEY] = dedupeKey;
	return {
		userId,
		workspaceId: input.workspaceId?.trim() || undefined,
		type: input.type,
		title,
		body: input.body?.trim() || undefined,
		linkUrl: input.linkUrl?.trim() || undefined,
		metadata,
		dedupeKey,
	};
}

/**
 * In-memory notification store with optional JSON snapshot persistence.
 * Used in tests and the file/prototype runtime. Sorted by (createdAt, id) DESC
 * to match the Postgres store and keep the panel head deterministic.
 */
export class FileNotificationStore implements NotificationStore {
	private readonly notifications: NotificationRecord[] = [];

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async create(input: CreateNotificationInput): Promise<NotificationRecord> {
		const validated = validateCreateInput(input);
		// Durable once-only guard: if this (userId, dedupeKey) was already written, return
		// the existing row instead of inserting a second one (collapses a same-charge
		// succeeded+invoice pair / a re-fired quota tier into ONE in-app row).
		if (validated.dedupeKey) {
			const existing = this.notifications.find(
				(entry) =>
					entry.userId === validated.userId
					&& entry.metadata?.[NOTIFICATION_DEDUPE_METADATA_KEY] === validated.dedupeKey,
			);
			if (existing) return { ...existing };
		}
		const now = new Date().toISOString();
		const record: NotificationRecord = {
			id: uuid(),
			userId: validated.userId,
			workspaceId: validated.workspaceId,
			type: validated.type,
			title: validated.title,
			body: validated.body,
			linkUrl: validated.linkUrl,
			metadata: validated.metadata ?? {},
			readAt: undefined,
			createdAt: now,
		};
		this.notifications.unshift(record);
		try {
			this.persist();
		} catch (error) {
			this.notifications.shift();
			throw error;
		}
		return { ...record };
	}

	async listForUser(userId: string, options: ListNotificationsOptions = {}): Promise<NotificationPage> {
		const normalized = userId.trim();
		if (!normalized) return { items: [], hasMore: false };
		const limit = coerceLimit(options.limit);
		const beforeCursor = options.beforeId ? this.findCursor(normalized, options.beforeId) : null;
		const filtered = this.notifications
			.filter((entry) => entry.userId === normalized)
			.filter((entry) => (options.unreadOnly ? !entry.readAt : true))
			.sort(compareDesc);
		// Resolve the keyset start position. We must NOT depend on the cursor row
		// still being present in `filtered`: under `unreadOnly`, the cursor row may
		// have been marked read since the previous page loaded, so an id lookup
		// would miss it and restart from the first page (duplicate results). Match
		// the Postgres keyset instead — start at the first filtered row STRICTLY
		// OLDER than the cursor's (createdAt, id), regardless of read state.
		let startIndex = 0;
		if (beforeCursor) {
			const cursorIndex = filtered.findIndex((entry) => entry.id === beforeCursor.id);
			if (cursorIndex >= 0) {
				startIndex = cursorIndex + 1;
			} else {
				const olderIndex = filtered.findIndex((entry) => compareDesc(entry, beforeCursor) > 0);
				startIndex = olderIndex >= 0 ? olderIndex : filtered.length;
			}
		}
		const slice = startIndex > 0 ? filtered.slice(startIndex, startIndex + limit) : filtered.slice(0, limit);
		const items = slice.map((entry) => ({ ...entry }));
		const hasMore = filtered.length > startIndex + items.length;
		return {
			items,
			hasMore,
			nextCursor: items.at(-1)?.id,
		};
	}

	async getForUser(userId: string, notificationId: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const normalizedId = notificationId.trim();
		if (!normalizedUser || !normalizedId) return null;
		const target = this.notifications.find((entry) => entry.id === normalizedId && entry.userId === normalizedUser);
		return target ? { ...target } : null;
	}

	async findByDedupeKey(userId: string, dedupeKey: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const key = dedupeKey.trim();
		if (!normalizedUser || !key) return null;
		const target = this.notifications.find(
			(entry) => entry.userId === normalizedUser && entry.metadata?.[NOTIFICATION_DEDUPE_METADATA_KEY] === key,
		);
		return target ? { ...target } : null;
	}

	async markRead(userId: string, notificationId: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const normalizedId = notificationId.trim();
		if (!normalizedUser || !normalizedId) return null;
		const target = this.notifications.find((entry) => entry.id === normalizedId && entry.userId === normalizedUser);
		if (!target) return null;
		if (target.readAt) return { ...target };
		const previous = target.readAt;
		target.readAt = new Date().toISOString();
		try {
			this.persist();
		} catch (error) {
			target.readAt = previous;
			throw error;
		}
		return { ...target };
	}

	async markAllRead(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const now = new Date().toISOString();
		const snapshot = this.notifications.map((entry) => entry.readAt);
		let updated = 0;
		for (const entry of this.notifications) {
			if (entry.userId === normalized && !entry.readAt) {
				entry.readAt = now;
				updated += 1;
			}
		}
		if (updated === 0) return 0;
		try {
			this.persist();
		} catch (error) {
			for (let i = 0; i < this.notifications.length; i += 1) {
				const entry = this.notifications[i];
				if (entry) entry.readAt = snapshot[i];
			}
			throw error;
		}
		return updated;
	}

	async markReadByIds(userId: string, notificationIds: string[]): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const ids = new Set(notificationIds.map((id) => id.trim()).filter(Boolean));
		if (ids.size === 0) return 0;
		const now = new Date().toISOString();
		const snapshot = this.notifications.map((entry) => entry.readAt);
		let updated = 0;
		for (const entry of this.notifications) {
			if (entry.userId === normalized && !entry.readAt && ids.has(entry.id)) {
				entry.readAt = now;
				updated += 1;
			}
		}
		if (updated === 0) return 0;
		try {
			this.persist();
		} catch (error) {
			for (let i = 0; i < this.notifications.length; i += 1) {
				const entry = this.notifications[i];
				if (entry) entry.readAt = snapshot[i];
			}
			throw error;
		}
		return updated;
	}

	async unreadCount(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		let count = 0;
		for (const entry of this.notifications) {
			if (entry.userId === normalized && !entry.readAt) count += 1;
		}
		return count;
	}

	async erasePiiForUser(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const before = this.notifications.length;
		const kept = this.notifications.filter((entry) => entry.userId !== normalized);
		const removed = before - kept.length;
		if (removed === 0) return 0;
		this.notifications.length = 0;
		this.notifications.push(...kept);
		this.persist();
		return removed;
	}

	private findCursor(userId: string, beforeId: string): NotificationRecord | null {
		return this.notifications.find((entry) => entry.id === beforeId && entry.userId === userId) ?? null;
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ notifications?: NotificationRecord[] }>(this.persistPath);
			if (Array.isArray(snapshot.notifications)) {
				for (const entry of snapshot.notifications) {
					if (isNotificationRecord(entry)) {
						this.notifications.push(entry);
					}
				}
				this.notifications.sort(compareDesc);
			}
		} catch (error) {
			console.warn(`[NotificationStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ notifications: this.notifications }, null, 2));
	}
}

interface NotificationSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface NotificationRow {
	id: string;
	user_id: string;
	workspace_id: string | null;
	type: string;
	title: string;
	body: string | null;
	link_url: string | null;
	metadata: Record<string, unknown> | null;
	read_at: Date | string | null;
	created_at: Date | string;
}

function mapRow(row: NotificationRow): NotificationRecord {
	return {
		id: row.id,
		userId: row.user_id,
		workspaceId: row.workspace_id ?? undefined,
		type: (isNotificationType(row.type) ? row.type : "comment_new") as NotificationType,
		title: row.title,
		body: row.body ?? undefined,
		linkUrl: row.link_url ?? undefined,
		metadata: normalizeRowMetadata(row.metadata),
		readAt: toIso(row.read_at) ?? undefined,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
	};
}

/**
 * Read-side heal for rows written by the pre-`::text::jsonb` insert (the
 * Bun.SQL double-encoding bug stored metadata as a jsonb STRING — see
 * migration 0085): a string payload that parses to an object is unwrapped so
 * the in-app localization keys (titleKey/bodyKey) keep working even before
 * the heal migration runs.
 */
function normalizeRowMetadata(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {/* fall through */}
	}
	return {};
}

function toIso(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text || undefined;
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505). Used by
 * PostgresNotificationStore.create to treat a concurrent dedupe-key double-insert
 * (caught by the partial UNIQUE index from migration 0080) as "already exists" and
 * resolve it to the row that won, collapsing the race to ONE row.
 */
function isUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	if (code === "23505") return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message.includes("notifications_user_dedupe_key_uniq");
}

/**
 * Postgres-backed notification store. Reads/writes the `notifications` table
 * created by migration 0041 (type column converted to text+CHECK in 0054).
 * Pagination uses a (created_at, id) keyset cursor
 * (no OFFSET) so older pages stay cheap as a user accumulates history.
 */
export class PostgresNotificationStore implements NotificationStore {
	private readonly client: NotificationSqlClient;

	constructor(databaseUrlOrClient: string | NotificationSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new NotificationStoreError("NOTIFICATIONS_STORE=postgres requires DATABASE_URL", "notification_store_unconfigured");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as NotificationSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async create(input: CreateNotificationInput): Promise<NotificationRecord> {
		const validated = validateCreateInput(input);
		const params = [
			validated.userId,
			validated.workspaceId ?? null,
			validated.type,
			validated.title,
			validated.body ?? null,
			validated.linkUrl ?? null,
			JSON.stringify(validated.metadata ?? {}),
		];
		if (validated.dedupeKey) {
			// Durable once-only guard. The INSERT only fires when no existing row for this
			// (user_id, metadata.__dedupeKey) is present, so a same-charge succeeded+invoice
			// pair / a re-fired quota tier yields exactly ONE row. The guard runs inside the
			// same statement (WHERE NOT EXISTS) so two concurrent deliveries serialize on the
			// row; if the INSERT was skipped we SELECT and return the row that won.
			params.push(validated.dedupeKey);
			const keyParam = params.length;
			// Durable once-only guard. The WHERE NOT EXISTS pre-check collapses the common
			// (sequential) replay. Under CONCURRENCY (two webhook workers post-commit) READ
			// COMMITTED lets both pass NOT EXISTS, so the UNIQUE PARTIAL INDEX on
			// (user_id, metadata->>'__dedupeKey') is the AUTHORITATIVE backstop: the second
			// INSERT raises 23505 (unique_violation), which we treat as "already exists" and
			// resolve by SELECTing the row that won — collapsing the race to exactly ONE row.
			let inserted: NotificationRow[] = [];
			try {
				inserted = await this.client.unsafe<NotificationRow>(`
					INSERT INTO notifications (user_id, workspace_id, type, title, body, link_url, metadata)
					SELECT $1, $2, $3, $4, $5, $6, COALESCE($7::text::jsonb, '{}'::jsonb)
					WHERE NOT EXISTS (
						SELECT 1 FROM notifications
						WHERE user_id = $1 AND metadata->>'${NOTIFICATION_DEDUPE_METADATA_KEY}' = $${keyParam}
					)
					RETURNING id, user_id, workspace_id, type, title, body, link_url, metadata, read_at, created_at
				`, params);
			} catch (error) {
				if (!isUniqueViolation(error)) throw error;
				// A concurrent insert won the unique index — fall through to the SELECT below.
			}
			if (inserted[0]) return mapRow(inserted[0]);
			const existing = await this.client.unsafe<NotificationRow>(`
				SELECT id, user_id, workspace_id, type::text AS type, title, body, link_url, metadata, read_at, created_at
				FROM notifications
				WHERE user_id = $1 AND metadata->>'${NOTIFICATION_DEDUPE_METADATA_KEY}' = $2
				ORDER BY created_at ASC, id ASC
				LIMIT 1
			`, [validated.userId, validated.dedupeKey]);
			if (existing[0]) return mapRow(existing[0]);
			throw new NotificationStoreError("Failed to persist notification", "notification_create_failed");
		}
		const rows = await this.client.unsafe<NotificationRow>(`
			INSERT INTO notifications (user_id, workspace_id, type, title, body, link_url, metadata)
			VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text::jsonb, '{}'::jsonb))
			RETURNING id, user_id, workspace_id, type, title, body, link_url, metadata, read_at, created_at
		`, params);
		const row = rows[0];
		if (!row) {
			throw new NotificationStoreError("Failed to persist notification", "notification_create_failed");
		}
		return mapRow(row);
	}

	async listForUser(userId: string, options: ListNotificationsOptions = {}): Promise<NotificationPage> {
		const normalized = userId.trim();
		if (!normalized) return { items: [], hasMore: false };
		const limit = coerceLimit(options.limit);
		const params: unknown[] = [normalized];
		const conditions: string[] = ["user_id = $1"];
		if (options.unreadOnly) {
			conditions.push("read_at IS NULL");
		}
		if (options.beforeId) {
			// Resolve the cursor row's (created_at, id) so the keyset is exact even
			// if two rows share a timestamp. Using a single roundtrip query: the
			// cursor lookup is embedded as a subselect.
			params.push(options.beforeId, normalized);
			const cursorParam = params.length - 1;
			conditions.push(`(
				created_at,
				id
			) < (
				SELECT created_at, id FROM notifications WHERE id = $${cursorParam}::uuid AND user_id = $${cursorParam + 1}
			)`);
		}
		params.push(limit + 1);
		const limitParam = params.length;
		const rows = await this.client.unsafe<NotificationRow>(`
			SELECT id, user_id, workspace_id, type::text AS type, title, body, link_url, metadata, read_at, created_at
			FROM notifications
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, id DESC
			LIMIT $${limitParam}
		`, params);
		const hasMore = rows.length > limit;
		const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRow);
		return {
			items,
			hasMore,
			nextCursor: items.at(-1)?.id,
		};
	}

	async getForUser(userId: string, notificationId: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const normalizedId = notificationId.trim();
		if (!normalizedUser || !normalizedId) return null;
		const rows = await this.client.unsafe<NotificationRow>(`
			SELECT id, user_id, workspace_id, type::text AS type, title, body, link_url, metadata, read_at, created_at
			FROM notifications
			WHERE id = $1::uuid AND user_id = $2
		`, [normalizedId, normalizedUser]);
		const row = rows[0];
		return row ? mapRow(row) : null;
	}

	async findByDedupeKey(userId: string, dedupeKey: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const key = dedupeKey.trim();
		if (!normalizedUser || !key) return null;
		const rows = await this.client.unsafe<NotificationRow>(`
			SELECT id, user_id, workspace_id, type::text AS type, title, body, link_url, metadata, read_at, created_at
			FROM notifications
			WHERE user_id = $1 AND metadata->>'${NOTIFICATION_DEDUPE_METADATA_KEY}' = $2
			ORDER BY created_at ASC, id ASC
			LIMIT 1
		`, [normalizedUser, key]);
		const row = rows[0];
		return row ? mapRow(row) : null;
	}

	async markRead(userId: string, notificationId: string): Promise<NotificationRecord | null> {
		const normalizedUser = userId.trim();
		const normalizedId = notificationId.trim();
		if (!normalizedUser || !normalizedId) return null;
		const rows = await this.client.unsafe<NotificationRow>(`
			UPDATE notifications
			SET read_at = COALESCE(read_at, now())
			WHERE id = $1::uuid AND user_id = $2
			RETURNING id, user_id, workspace_id, type::text AS type, title, body, link_url, metadata, read_at, created_at
		`, [normalizedId, normalizedUser]);
		const row = rows[0];
		return row ? mapRow(row) : null;
	}

	async markAllRead(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const rows = await this.client.unsafe<{ count: number | string }>(`
			WITH updated AS (
				UPDATE notifications
				SET read_at = now()
				WHERE user_id = $1 AND read_at IS NULL
				RETURNING 1
			)
			SELECT COUNT(*)::int AS count FROM updated
		`, [normalized]);
		const value = rows[0]?.count;
		return typeof value === "number" ? value : Number(value) || 0;
	}

	async markReadByIds(userId: string, notificationIds: string[]): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const ids = Array.from(new Set(notificationIds.map((id) => id.trim()).filter(Boolean)));
		if (ids.length === 0) return 0;
		// Scope BOTH to the owner AND the explicit id allow-list so a notification in a
		// workspace the caller has left (excluded from the id list by the route) is
		// never touched (a16 re-review P1 #2).
		//
		// The id allow-list MUST be built with the scalar-bind ARRAY[...] helper, NOT
		// `id = ANY($n::uuid[])` with a JS array: Bun.SQL serializes a JS array param as
		// the bare text `a,b` (not `{a,b}`), so the `= ANY($n::uuid[])` form throws
		// `malformed array literal` against real Postgres — silently breaking
		// mark-all-read in prod while passing every mock-client test. pushArrayLiteral
		// pushes each id as its own scalar param and emits `ARRAY[$2,$3,...]::uuid[]`.
		const params: unknown[] = [normalized];
		const idArraySql = pushArrayLiteral(params, ids, "uuid");
		const rows = await this.client.unsafe<{ count: number | string }>(`
			WITH updated AS (
				UPDATE notifications
				SET read_at = now()
				WHERE user_id = $1 AND read_at IS NULL AND id = ANY(${idArraySql})
				RETURNING 1
			)
			SELECT COUNT(*)::int AS count FROM updated
		`, params);
		const value = rows[0]?.count;
		return typeof value === "number" ? value : Number(value) || 0;
	}

	async unreadCount(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		const rows = await this.client.unsafe<{ count: number | string }>(`
			SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL
		`, [normalized]);
		const value = rows[0]?.count;
		return typeof value === "number" ? value : Number(value) || 0;
	}

	async erasePiiForUser(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		// Production purges this atomically inside the GDPR transaction; this
		// standalone path keeps the interface honest for any caller that erases the
		// notification inbox on its own connection.
		const rows = await this.client.unsafe<{ count: number | string }>(`
			WITH deleted AS (
				DELETE FROM notifications WHERE user_id = $1 RETURNING 1
			)
			SELECT COUNT(*)::int AS count FROM deleted
		`, [normalized]);
		const value = rows[0]?.count;
		return typeof value === "number" ? value : Number(value) || 0;
	}
}

function compareDesc(a: NotificationRecord, b: NotificationRecord): number {
	const cmp = b.createdAt.localeCompare(a.createdAt);
	return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
}

function isNotificationRecord(value: unknown): value is NotificationRecord {
	const record = value as Partial<NotificationRecord>;
	return Boolean(
		record
		&& typeof record.id === "string"
		&& typeof record.userId === "string"
		&& typeof record.title === "string"
		&& typeof record.createdAt === "string"
		&& isNotificationType(record.type),
	);
}

/** Resolve which backing store to use, mirroring billing-store's pattern. */
function resolveStoreMode(): "file" | "postgres" {
	const override = process.env.NOTIFICATIONS_STORE?.trim().toLowerCase();
	if (override === "postgres") return "postgres";
	if (override === "file") return "file";
	// Default: piggyback on the same gating logic as billing/usage — Postgres
	// when DATABASE_URL is set in a non-test runtime. We treat
	// `serverConfig.billingStore === "postgres"` as the signal that this
	// runtime has DATABASE_URL + non-test, to stay consistent with the rest of
	// the Postgres-backed services without re-implementing the env probe.
	return serverConfig.billingStore === "postgres" ? "postgres" : "file";
}

export function createNotificationStore(): NotificationStore {
	if (resolveStoreMode() === "postgres") {
		return new PostgresNotificationStore();
	}
	return new FileNotificationStore(join(DATA_DIR, "notifications.json"));
}

export const notificationStore: NotificationStore = createNotificationStore();
