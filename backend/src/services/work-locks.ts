import { getSharedBunSql } from "./sql-pool.js";
import { RedisClient } from "bun";
import { randomUUID } from "crypto";
import { publishRealtimeEvent, type RealtimeEventKind } from "./realtime-bus.js";

export type WorkLockScope = "page" | "object" | "layer" | "chapter";

export interface WorkLockRecord {
	lockId: string;
	scope: WorkLockScope;
	scopeId: string;
	ownerUserId: string;
	/**
	 * Opaque per-tab/session identity of the holder. Lets the SAME user's two
	 * tabs be told apart so a second tab cannot silently inherit + clobber the
	 * first tab's lease. Optional for legacy callers (treated as one anonymous
	 * tab).
	 */
	clientId?: string;
	projectId?: string;
	chapterId?: string;
	pageId?: string;
	workspaceId?: string;
	acquiredAt: string;
	expiresAt: string;
	releasedAt?: string;
	releasedBy?: string;
	releaseReason?: string;
}

export interface AcquireLockOptions {
	/** Per-tab/session identity of the acquirer (see WorkLockRecord.clientId). */
	clientId?: string;
	/**
	 * When the active lock is held by the SAME user from a DIFFERENT tab, an
	 * ordinary acquire raises {@link SameUserLockConflictError}. Passing
	 * `takeover: true` instead steals the lease: the old tab's lock is released
	 * (reason `taken_over`) and a fresh lock is minted for the new tab.
	 *
	 * For a DIFFERENT-user holder, takeover is refused by default (stays a hard
	 * {@link LockConflictError}). Cross-user takeover is only performed when the
	 * caller ALSO passes {@link allowCrossUserTakeover} — which the lock route sets
	 * only after it has confirmed the requester has edit access to the same page.
	 * The displaced holder is returned via {@link AcquireLockResult.taken_over_from}
	 * so the caller can notify them; CAS on save then steers their stale write into
	 * the recovery-draft flow rather than a silent clobber.
	 */
	takeover?: boolean;
	/**
	 * Authorize stealing a DIFFERENT user's lease (see {@link takeover}). MUST only
	 * be set after the caller has verified the requester may edit the same subject.
	 * Without it a different-user conflict always throws {@link LockConflictError}.
	 */
	allowCrossUserTakeover?: boolean;
	projectId?: string;
	chapterId?: string;
	pageId?: string;
	workspaceId?: string;
	now?: Date;
}

export interface ReleaseLockOptions {
	force?: boolean;
	reason?: string;
	now?: Date;
}

/**
 * The displaced holder when an acquire performed a takeover (same-user other tab
 * OR an authorized cross-user takeover). Surfaced so the route can notify them.
 */
export interface TakenOverHolder {
	userId: string;
	clientId?: string;
	scope: WorkLockScope;
	scopeId: string;
	projectId?: string;
	chapterId?: string;
	pageId?: string;
	workspaceId?: string;
	/** True when the displaced holder is a DIFFERENT user (cross-user takeover). */
	crossUser: boolean;
}

export interface AcquireLockResult {
	lock_id: string;
	expires_at: string;
	client_id?: string;
	/** Present only when this acquire stole an active lease from a holder. */
	taken_over_from?: TakenOverHolder;
}

export interface WorkLockSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: WorkLockSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

export interface WorkLockEventPublisher {
	publish(channel: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * Result of inspecting whether a caller still holds a specific lock, used by the
 * save path to reject a displaced/expired holder's in-flight write (C1). Unlike
 * {@link WorkLockStore.getLock} this reads the lock row EVEN IF it has been
 * released, so the save path can distinguish "you were taken over" from "never
 * existed" and steer the stale write into the recovery-draft flow instead of
 * silently clobbering the new holder.
 */
export type LockHoldState =
	/** Lock id is unknown to the store (never existed / pruned). */
	| { status: "not_found" }
	/** The caller still actively holds this lock (right user + right tab + not expired). */
	| { status: "held" }
	/** The lock was released — surfaces the release reason (`taken_over`, `auto_expired`, …). */
	| { status: "released"; reason?: string; ownerUserId: string }
	/** The lock is active but held by a DIFFERENT user/tab than the caller (re-minted after takeover). */
	| { status: "held_by_other"; ownerUserId: string; clientId?: string }
	/** The lock's TTL elapsed without an explicit release row yet. */
	| { status: "expired"; ownerUserId: string };

export interface WorkLockStore {
	acquireLock(scope: WorkLockScope, scopeId: string, userId: string, durationMin?: number, options?: AcquireLockOptions): Promise<AcquireLockResult>;
	/**
	 * Inspect whether `userId`/`clientId` still holds `lockId` (C1 save-path guard).
	 * Reads released rows too so the caller can tell a takeover/expiry apart from a
	 * genuinely unknown id. Never throws for a missing lock — returns `not_found`.
	 */
	inspectLockHold(lockId: string, userId: string, clientId?: string, options?: { now?: Date }): Promise<LockHoldState>;
	releaseLock(lockId: string, requesterUserId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord>;
	extendLock(lockId: string, requesterUserId: string, durationMin?: number, options?: { now?: Date }): Promise<{ lock_id: string; expires_at: string }>;
	getLock(lockId: string, options?: { now?: Date }): Promise<WorkLockRecord | null>;
	listLocksForChapter(chapterId: string, options?: { now?: Date }): Promise<WorkLockRecord[]>;
	releaseLocksForSubject(subjectKind: "chapter" | "page", subjectId: string, requesterUserId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord[]>;
	releaseLocksForUser(userId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord[]>;
	releaseAllByUser(userId: string, scope?: WorkLockScope, scopeId?: string, options?: ReleaseLockOptions): Promise<WorkLockRecord[]>;
	/**
	 * Release every live lock this user holds INSIDE one workspace — used when a
	 * member is removed so their leases don't pin pages for the TTL (10 min)
	 * while locks they hold in OTHER workspaces stay untouched.
	 */
	releaseAllByUserInWorkspace(userId: string, workspaceId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord[]>;
	forceReleaseLock(lockId: string, adminUserId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord>;
	forceReleaseByAdmin(lockId: string, adminUserId: string, options?: ReleaseLockOptions): Promise<WorkLockRecord>;
	sweepExpiredLocks(now?: Date): Promise<number>;
}

export class LockConflictError extends Error {
	constructor(readonly conflict: { held_by_user_id: string; expires_at: string }) {
		super("Work lock is already held");
	}
}

/**
 * Raised when the active lock is held by the SAME user but a DIFFERENT tab
 * (client id). Distinct from {@link LockConflictError} so the UI can offer a
 * "you're already editing this in another tab — continue here?" takeover
 * affordance instead of a generic "someone else is editing" block. Resolve by
 * re-acquiring with `takeover: true`.
 */
export class SameUserLockConflictError extends Error {
	constructor(readonly conflict: { held_by_user_id: string; held_by_client_id?: string; expires_at: string; lock_id: string }) {
		super("Work lock is already held by another tab of the same user");
	}
}

export class LockPermissionError extends Error {
	constructor(message = "Forbidden: lock is owned by another user") {
		super(message);
	}
}

export class LockNotFoundError extends Error {
	constructor(message = "Work lock not found") {
		super(message);
	}
}

const DEFAULT_DURATION_MIN = 10;
const MAX_DURATION_MIN = 60;
const VALID_SCOPES = new Set<WorkLockScope>(["page", "object", "layer", "chapter"]);

// Shared column lists so every read/insert returns the full row including the
// per-tab client_id. Keeping them in one place avoids one query forgetting the
// column and silently dropping tab identity.
const LOCK_RETURNING_COLUMNS = "lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason";
const LOCK_SELECT_COLUMNS = `SELECT ${LOCK_RETURNING_COLUMNS}`;

export class NoopWorkLockEventPublisher implements WorkLockEventPublisher {
	async publish(): Promise<void> {}
}

export class RedisWorkLockEventPublisher implements WorkLockEventPublisher {
	private readonly client: RedisClient;

	constructor(url = process.env.REDIS_URL) {
		this.client = url?.trim() ? new RedisClient(url) : new RedisClient();
	}

	async publish(channel: string, payload: Record<string, unknown>): Promise<void> {
		await this.client.send("PUBLISH", [channel, JSON.stringify(payload)]);
	}
}

export class PostgresWorkLockStore implements WorkLockStore {
	private readonly client: WorkLockSqlClient;
	private readonly publisher: WorkLockEventPublisher;

	constructor(databaseUrlOrClient: string | WorkLockSqlClient = process.env.DATABASE_URL ?? "", publisher: WorkLockEventPublisher = createWorkLockEventPublisher()) {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) throw new Error("Work lock store requires DATABASE_URL");
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as WorkLockSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
		this.publisher = publisher;
	}

	async acquireLock(scope: WorkLockScope, scopeId: string, userId: string, durationMin = DEFAULT_DURATION_MIN, options: AcquireLockOptions = {}): Promise<AcquireLockResult> {
		assertValidScope(scope);
		const normalizedScopeId = requireNonEmpty(scopeId, "scope_id");
		const normalizedUserId = requireNonEmpty(userId, "user_id");
		const normalizedClientId = optionalString(options.clientId);
		const now = options.now ?? new Date();
		const expiresAt = addMinutes(now, normalizeDurationMin(durationMin));

		const result = await this.transaction(async (client) => {
			// Free this scope's partial-unique slot if its current holder's lease expired,
			// so the INSERT below (or the conflict SELECT) sees the scope as available.
			await releaseExpiredLocksForScope(client, scope, normalizedScopeId, now);
			const existingRows = await client.unsafe<WorkLockRow>(`${LOCK_SELECT_COLUMNS}
				FROM work_locks
				WHERE scope = $1
					AND scope_id = $2
					AND released_at IS NULL
					AND auto_release_at > $3::timestamptz
				LIMIT 1
			`, [scope, normalizedScopeId, now.toISOString()]);
			const existing = existingRows[0];
			if (existing) {
				const conflict = this.resolveExistingHolder(existing, normalizedUserId, normalizedClientId);
				if (conflict === "same_tab") {
					// Same user, same tab: idempotent heartbeat. Refresh the expiry so a
					// re-acquire also extends the lease (the client re-acquires on focus).
					const refreshedRows = await client.unsafe<WorkLockRow>(`
						UPDATE work_locks SET auto_release_at = $2::timestamptz
						WHERE lock_id = $1 AND released_at IS NULL
						RETURNING ${LOCK_RETURNING_COLUMNS}
					`, [existing.lock_id, expiresAt.toISOString()]);
					return { record: mapWorkLockRow(refreshedRows[0] ?? existing), acquired: false };
				}
				if (conflict === "same_user_other_tab") {
					if (!options.takeover) {
						throw new SameUserLockConflictError({
							held_by_user_id: existing.owner_user_id,
							held_by_client_id: existing.client_id ?? undefined,
							expires_at: toIso(existing.auto_release_at),
							lock_id: existing.lock_id,
						});
					}
					return await this.takeoverAndInsert(client, existing, { scope, scopeId: normalizedScopeId, userId: normalizedUserId, clientId: normalizedClientId, now, expiresAt, options }, false);
				}
				// Different user. Refuse unless the caller explicitly authorized a
				// cross-user takeover (the route only does so after confirming the
				// requester has edit access to the same page).
				if (!(options.takeover && options.allowCrossUserTakeover)) {
					throw new LockConflictError({
						held_by_user_id: existing.owner_user_id,
						expires_at: toIso(existing.auto_release_at),
					});
				}
				return await this.takeoverAndInsert(client, existing, { scope, scopeId: normalizedScopeId, userId: normalizedUserId, clientId: normalizedClientId, now, expiresAt, options }, true);
			}

			return await this.insertLock(client, { scope, scopeId: normalizedScopeId, userId: normalizedUserId, clientId: normalizedClientId, now, expiresAt, options });
		});

		if (result.takenOver) await this.publishLockEvent("released", result.takenOver, { requester_user_id: normalizedUserId, reason: "taken_over" });
		if (result.acquired) await this.publishLockEvent("acquired", result.record);
		return {
			lock_id: result.record.lockId,
			expires_at: result.record.expiresAt,
			client_id: result.record.clientId,
			taken_over_from: result.takenOver ? toTakenOverHolder(result.takenOver, result.crossUser ?? false) : undefined,
		};
	}

	/**
	 * Release the holder's active lock (reason `taken_over`) and mint a fresh one
	 * for the acquirer. Shared by same-user-other-tab and authorized cross-user
	 * takeover. The transaction makes release+insert atomic so two takers can't
	 * both win the page.
	 */
	private async takeoverAndInsert(
		client: WorkLockSqlClient,
		existing: WorkLockRow,
		input: { scope: WorkLockScope; scopeId: string; userId: string; clientId: string | null; now: Date; expiresAt: Date; options: AcquireLockOptions },
		crossUser: boolean,
	): Promise<{ record: WorkLockRecord; acquired: boolean; takenOver?: WorkLockRecord; crossUser: boolean }> {
		await client.unsafe(`
			UPDATE work_locks SET released_at = $2::timestamptz, released_by = $3, release_reason = 'taken_over'
			WHERE lock_id = $1 AND released_at IS NULL
		`, [existing.lock_id, input.now.toISOString(), input.userId]);
		const takenOver = mapWorkLockRow({ ...existing, released_at: input.now.toISOString(), released_by: input.userId, release_reason: "taken_over" });
		const inserted = await this.insertLock(client, input, takenOver);
		return { ...inserted, crossUser };
	}

	private resolveExistingHolder(existing: WorkLockRow, userId: string, clientId: string | null): "same_tab" | "same_user_other_tab" | "other_user" {
		if (existing.owner_user_id !== userId) return "other_user";
		// Same user. A null/absent client id on either side is treated as the same
		// anonymous tab so legacy callers keep their idempotent re-acquire.
		const existingClient = existing.client_id ?? null;
		if (!existingClient || !clientId) return "same_tab";
		return existingClient === clientId ? "same_tab" : "same_user_other_tab";
	}

	private async insertLock(
		client: WorkLockSqlClient,
		input: { scope: WorkLockScope; scopeId: string; userId: string; clientId: string | null; now: Date; expiresAt: Date; options: AcquireLockOptions },
		takenOver?: WorkLockRecord,
	): Promise<{ record: WorkLockRecord; acquired: boolean; takenOver?: WorkLockRecord; crossUser?: boolean }> {
		const { scope, scopeId, userId, clientId, now, expiresAt, options } = input;
		try {
			const lockId = randomUUID();
			const rows = await client.unsafe<WorkLockRow>(`
				INSERT INTO work_locks (
					lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id,
					acquired_at, auto_release_at, released_at, released_by, release_reason
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, NULL, NULL, NULL)
				RETURNING ${LOCK_RETURNING_COLUMNS}
			`, [
				lockId,
				scope,
				scopeId,
				userId,
				clientId,
				optionalString(options.projectId),
				optionalString(options.chapterId),
				optionalString(options.pageId),
				optionalString(options.workspaceId),
				now.toISOString(),
				expiresAt.toISOString(),
			]);
			return { record: mapWorkLockRow(requireRow(rows, "work lock")), acquired: true, takenOver };
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			const racedRows = await client.unsafe<WorkLockRow>(`${LOCK_SELECT_COLUMNS}
				FROM work_locks
				WHERE scope = $1
					AND scope_id = $2
					AND released_at IS NULL
					AND auto_release_at > $3::timestamptz
				LIMIT 1
			`, [scope, scopeId, now.toISOString()]);
			const raced = racedRows[0];
			if (raced) {
				const conflict = this.resolveExistingHolder(raced, userId, clientId);
				if (conflict === "same_tab") return { record: mapWorkLockRow(raced), acquired: false, takenOver };
				if (conflict === "same_user_other_tab") {
					throw new SameUserLockConflictError({
						held_by_user_id: raced.owner_user_id,
						held_by_client_id: raced.client_id ?? undefined,
						expires_at: toIso(raced.auto_release_at),
						lock_id: raced.lock_id,
					});
				}
				throw new LockConflictError({
					held_by_user_id: raced.owner_user_id,
					expires_at: toIso(raced.auto_release_at),
				});
			}
			throw error;
		}
	}

	async releaseLock(lockId: string, requesterUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		const normalizedLockId = requireNonEmpty(lockId, "lock_id");
		const normalizedRequester = requireNonEmpty(requesterUserId, "requester_user_id");
		const now = options.now ?? new Date();
		const reason = options.reason ?? (options.force ? "admin_force_release" : "released");
		const record = await this.transaction(async (client) => {
			// No eager expiry sweep: releasing an already-expired lock is harmless (the
			// scope is already free for re-acquire), and the owner's release marks it
			// released the same way the in-memory store does.
			const existing = await getLockById(client, normalizedLockId);
			if (!existing) throw new LockNotFoundError();
			if (!options.force && existing.ownerUserId !== normalizedRequester) throw new LockPermissionError();
			if (existing.releasedAt) return existing;
			const rows = await client.unsafe<WorkLockRow>(`
				UPDATE work_locks
				SET released_at = $2::timestamptz,
					released_by = $3,
					release_reason = $4
				WHERE lock_id = $1
				RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
			`, [normalizedLockId, now.toISOString(), normalizedRequester, reason]);
			return mapWorkLockRow(requireRow(rows, "work lock"));
		});
		await this.publishLockEvent("released", record, { requester_user_id: normalizedRequester, reason, forced: Boolean(options.force) });
		return record;
	}

	async forceReleaseByAdmin(lockId: string, adminUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		return this.releaseLock(lockId, adminUserId, { ...options, force: true, reason: options.reason ?? "admin_force_release" });
	}

	async forceReleaseLock(lockId: string, adminUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		return this.forceReleaseByAdmin(lockId, adminUserId, options);
	}

	async extendLock(lockId: string, requesterUserId: string, durationMin = DEFAULT_DURATION_MIN, options: { now?: Date } = {}): Promise<{ lock_id: string; expires_at: string }> {
		const normalizedLockId = requireNonEmpty(lockId, "lock_id");
		const normalizedRequester = requireNonEmpty(requesterUserId, "requester_user_id");
		const now = options.now ?? new Date();
		const expiresAt = addMinutes(now, normalizeDurationMin(durationMin));
		const record = await this.transaction(async (client) => {
			// No eager expiry sweep. An EXPIRED lease must not be extendable (the scope
			// may already be free for someone else), so reject it up front by time, and
			// the UPDATE re-checks `auto_release_at > now` so it cannot resurrect a lease
			// that expired between the read and the write.
			const existing = await getLockById(client, normalizedLockId);
			if (!existing || existing.releasedAt || Date.parse(existing.expiresAt) <= now.getTime()) {
				throw new LockNotFoundError("Active work lock not found");
			}
			if (existing.ownerUserId !== normalizedRequester) throw new LockPermissionError();
			const rows = await client.unsafe<WorkLockRow>(`
				UPDATE work_locks
				SET auto_release_at = $2::timestamptz
				WHERE lock_id = $1
					AND released_at IS NULL
					AND auto_release_at > $3::timestamptz
				RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
			`, [normalizedLockId, expiresAt.toISOString(), now.toISOString()]);
			return mapWorkLockRow(requireRow(rows, "work lock"));
		});
		await this.publishLockEvent("extended", record);
		return { lock_id: record.lockId, expires_at: record.expiresAt };
	}

	async getLock(lockId: string, options: { now?: Date } = {}): Promise<WorkLockRecord | null> {
		const normalizedLockId = requireNonEmpty(lockId, "lock_id");
		const now = options.now ?? new Date();
		// Time-aware read: an expired lease counts as not-held without a write. (Physical
		// release of the expired row is deferred to re-acquire or the sweep cron.)
		const existing = await getLockById(this.client, normalizedLockId);
		if (!existing || existing.releasedAt || Date.parse(existing.expiresAt) <= now.getTime()) return null;
		return existing;
	}

	async inspectLockHold(lockId: string, userId: string, clientId?: string, options: { now?: Date } = {}): Promise<LockHoldState> {
		const normalizedLockId = requireNonEmpty(lockId, "lock_id");
		const normalizedUserId = requireNonEmpty(userId, "user_id");
		const normalizedClientId = optionalString(clientId);
		const now = options.now ?? new Date();
		// No eager expiry sweep: evaluateLockHold() already classifies an expired lease as
		// "expired" from auto_release_at vs now. Read the row WITHOUT filtering on
		// released_at so a taken-over lease (released row) is reported as such instead of
		// looking identical to a never-existing id.
		const record = await getLockById(this.client, normalizedLockId);
		return evaluateLockHold(record, normalizedUserId, normalizedClientId, now);
	}

	async listLocksForChapter(chapterId: string, options: { now?: Date } = {}): Promise<WorkLockRecord[]> {
		const normalizedChapterId = requireNonEmpty(chapterId, "chapter_id");
		const now = options.now ?? new Date();
		// No eager expiry sweep: the query itself excludes expired leases via
		// `auto_release_at > now`, so the listing is already correct without a write.
		const rows = await this.client.unsafe<WorkLockRow>(`
			SELECT lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
			FROM work_locks
			WHERE (chapter_id = $1 OR (scope = 'chapter' AND scope_id = $1))
				AND released_at IS NULL
				AND auto_release_at > $2::timestamptz
			ORDER BY acquired_at ASC, lock_id ASC
		`, [normalizedChapterId, now.toISOString()]);
		return rows.map(mapWorkLockRow);
	}

	async releaseLocksForSubject(subjectKind: "chapter" | "page", subjectId: string, requesterUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		const normalizedSubjectId = requireNonEmpty(subjectId, "subject_id");
		const normalizedRequester = requireNonEmpty(requesterUserId, "requester_user_id");
		const now = options.now ?? new Date();
		const reason = options.reason ?? "workflow_transition";
		const rows = await this.client.unsafe<WorkLockRow>(`
			UPDATE work_locks
			SET released_at = $4::timestamptz,
				released_by = $1,
				release_reason = $5
			WHERE owner_user_id = $1
				AND released_at IS NULL
				AND (
					($2 = 'chapter' AND (chapter_id = $3 OR (scope = 'chapter' AND scope_id = $3)))
					OR (
						$2 = 'page'
						AND (
							-- Match page locks by their canonical scope id OR by the
							-- recorded page_id, so a page lock acquired by image id
							-- (scope_id = imageId, page_id = canonical subject id) is
							-- still released on submit rather than stranded until timeout.
							(scope = 'page' AND (scope_id = $3 OR page_id = $3))
							OR (scope IN ('object', 'layer') AND page_id = $3)
						)
					)
				)
			RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
		`, [normalizedRequester, subjectKind, normalizedSubjectId, now.toISOString(), reason]);
		const records = rows.map(mapWorkLockRow);
		for (const record of records) await this.publishLockEvent("released", record, { requester_user_id: normalizedRequester, reason });
		return records;
	}

	async releaseAllByUser(userId: string, scope?: WorkLockScope, scopeId?: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		const normalizedUserId = requireNonEmpty(userId, "user_id");
		const now = options.now ?? new Date();
		const reason = options.reason ?? (scope ? "workflow_transition" : "user_logout");
		if (scope) assertValidScope(scope);
		const normalizedScopeId = scopeId ? requireNonEmpty(scopeId, "scope_id") : null;
		const rows = await this.client.unsafe<WorkLockRow>(`
			UPDATE work_locks
			SET released_at = $2::timestamptz,
				released_by = $1,
				release_reason = $3
			WHERE owner_user_id = $1
				AND released_at IS NULL
				AND ($4::text IS NULL OR scope = $4)
				AND ($5::text IS NULL OR scope_id = $5)
			RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
		`, [normalizedUserId, now.toISOString(), reason, scope ?? null, normalizedScopeId]);
		const records = rows.map(mapWorkLockRow);
		for (const record of records) await this.publishLockEvent("released", record, { requester_user_id: normalizedUserId, reason });
		return records;
	}

	async releaseLocksForUser(userId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		return this.releaseAllByUser(userId, undefined, undefined, options);
	}

	async releaseAllByUserInWorkspace(userId: string, workspaceId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		const normalizedUserId = requireNonEmpty(userId, "user_id");
		const normalizedWorkspaceId = requireNonEmpty(workspaceId, "workspace_id");
		const now = options.now ?? new Date();
		const reason = options.reason ?? "member_removed";
		const rows = await this.client.unsafe<WorkLockRow>(`
			UPDATE work_locks
			SET released_at = $2::timestamptz,
				released_by = $1,
				release_reason = $3
			WHERE owner_user_id = $1
				AND workspace_id = $4
				AND released_at IS NULL
			RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
		`, [normalizedUserId, now.toISOString(), reason, normalizedWorkspaceId]);
		const records = rows.map(mapWorkLockRow);
		for (const record of records) await this.publishLockEvent("released", record, { requester_user_id: normalizedUserId, reason });
		return records;
	}

	async sweepExpiredLocks(now: Date = new Date()): Promise<number> {
		const rows = await this.client.unsafe<WorkLockRow>(`
			UPDATE work_locks
			SET released_at = auto_release_at,
				released_by = 'system',
				release_reason = 'auto_expired'
			WHERE released_at IS NULL
				AND auto_release_at <= $1::timestamptz
			RETURNING lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
		`, [now.toISOString()]);
		const records = rows.map(mapWorkLockRow);
		for (const record of records) await this.publishLockEvent("released", record, { requester_user_id: "system", reason: "auto_expired" });
		return records.length;
	}

	private async transaction<T>(fn: (client: WorkLockSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) return this.client.begin(fn);
		return fn(this.client);
	}

	private async publishLockEvent(type: "acquired" | "extended" | "released", record: WorkLockRecord, extra: Record<string, unknown> = {}): Promise<void> {
		if (!record.workspaceId) return;
		// Best-effort: the lock row is already committed by the time we publish, so
		// a Redis PUBLISH outage must not surface as an acquire/extend/release
		// failure. That would tell the client acquisition failed while the lock is
		// in fact held, blocking collaborators until expiry. Realtime listeners
		// reconcile via the lock APIs, so a dropped event is recoverable.
		try {
			await this.publisher.publish(`ws:locks:${record.workspaceId}`, {
				type,
				lock: record,
				...extra,
			});
		} catch (error) {
			console.warn("[work-locks] lock event publish failed", error);
		}

		// Bridge the lock change onto the workspace SSE bus the frontend actually
		// listens to. The raw `ws:locks:*` Redis channel above is a low-level
		// fan-out that nothing subscribes to over SSE; the browser locks store keys
		// off realtimeStore "lock_acquired"/"lock_released" events, so without this
		// real lock changes never reach the UI overlay. `extended` re-asserts the
		// lock (new expiry) and is surfaced as an acquire so the indicator refreshes.
		// Also best-effort — publishRealtimeEvent already swallows its own errors.
		const sseKind: RealtimeEventKind = type === "released" ? "lock_released" : "lock_acquired";
		await publishRealtimeEvent(record.workspaceId, sseKind, {
			lockId: record.lockId,
			scope: record.scope,
			scopeId: record.scopeId,
			owner: record.ownerUserId,
			// Surface the holder's tab id so a client can tell whether an incoming
			// lock_acquired is its OWN tab (ignore) or another tab/user (steer).
			clientId: record.clientId,
			projectId: record.projectId,
			expiresAt: record.expiresAt,
		});
	}
}

export class InMemoryWorkLockStore implements WorkLockStore {
	private readonly locks = new Map<string, WorkLockRecord>();

	async acquireLock(scope: WorkLockScope, scopeId: string, userId: string, durationMin = DEFAULT_DURATION_MIN, options: AcquireLockOptions = {}): Promise<AcquireLockResult> {
		assertValidScope(scope);
		const now = options.now ?? new Date();
		const clientId = optionalString(options.clientId) ?? undefined;
		this.releaseExpired(now);
		const active = [...this.locks.values()].find((lock) => lock.scope === scope && lock.scopeId === scopeId && !lock.releasedAt && Date.parse(lock.expiresAt) > now.getTime());
		let takenOverFrom: TakenOverHolder | undefined;
		if (active) {
			if (active.ownerUserId === userId) {
				// Same user. Same tab (or either side anonymous): idempotent + refresh
				// the expiry. Different tab: same-user-tab conflict unless takeover.
				const sameTab = !active.clientId || !clientId || active.clientId === clientId;
				if (sameTab) {
					active.expiresAt = addMinutes(now, normalizeDurationMin(durationMin)).toISOString();
					return { lock_id: active.lockId, expires_at: active.expiresAt, client_id: active.clientId };
				}
				if (!options.takeover) {
					throw new SameUserLockConflictError({
						held_by_user_id: active.ownerUserId,
						held_by_client_id: active.clientId,
						expires_at: active.expiresAt,
						lock_id: active.lockId,
					});
				}
				active.releasedAt = now.toISOString();
				active.releasedBy = userId;
				active.releaseReason = "taken_over";
				takenOverFrom = toTakenOverHolder({ ...active }, false);
			} else {
				// Different user: refuse unless an authorized cross-user takeover.
				if (!(options.takeover && options.allowCrossUserTakeover)) {
					throw new LockConflictError({ held_by_user_id: active.ownerUserId, expires_at: active.expiresAt });
				}
				active.releasedAt = now.toISOString();
				active.releasedBy = userId;
				active.releaseReason = "taken_over";
				takenOverFrom = toTakenOverHolder({ ...active }, true);
			}
		}
		const acquiredAt = now.toISOString();
		const expiresAt = addMinutes(now, normalizeDurationMin(durationMin)).toISOString();
		const lock: WorkLockRecord = {
			lockId: randomUUID(),
			scope,
			scopeId,
			ownerUserId: userId,
			clientId,
			projectId: options.projectId,
			chapterId: options.chapterId,
			pageId: options.pageId,
			workspaceId: options.workspaceId,
			acquiredAt,
			expiresAt,
		};
		this.locks.set(lock.lockId, lock);
		return { lock_id: lock.lockId, expires_at: lock.expiresAt, client_id: lock.clientId, taken_over_from: takenOverFrom };
	}

	async releaseLock(lockId: string, requesterUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		const lock = this.locks.get(lockId);
		if (!lock) throw new LockNotFoundError();
		if (!options.force && lock.ownerUserId !== requesterUserId) throw new LockPermissionError();
		if (!lock.releasedAt) {
			lock.releasedAt = (options.now ?? new Date()).toISOString();
			lock.releasedBy = requesterUserId;
			lock.releaseReason = options.reason ?? (options.force ? "admin_force_release" : "released");
		}
		return { ...lock };
	}

	async forceReleaseByAdmin(lockId: string, adminUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		return this.releaseLock(lockId, adminUserId, { ...options, force: true, reason: options.reason ?? "admin_force_release" });
	}

	async forceReleaseLock(lockId: string, adminUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord> {
		return this.forceReleaseByAdmin(lockId, adminUserId, options);
	}

	async extendLock(lockId: string, requesterUserId: string, durationMin = DEFAULT_DURATION_MIN, options: { now?: Date } = {}): Promise<{ lock_id: string; expires_at: string }> {
		const now = options.now ?? new Date();
		this.releaseExpired(now);
		const lock = this.locks.get(lockId);
		if (!lock || lock.releasedAt) throw new LockNotFoundError("Active work lock not found");
		if (lock.ownerUserId !== requesterUserId) throw new LockPermissionError();
		lock.expiresAt = addMinutes(now, normalizeDurationMin(durationMin)).toISOString();
		return { lock_id: lock.lockId, expires_at: lock.expiresAt };
	}

	async getLock(lockId: string, options: { now?: Date } = {}): Promise<WorkLockRecord | null> {
		const now = options.now ?? new Date();
		this.releaseExpired(now);
		const lock = this.locks.get(lockId);
		if (!lock || lock.releasedAt || Date.parse(lock.expiresAt) <= now.getTime()) return null;
		return { ...lock };
	}

	async inspectLockHold(lockId: string, userId: string, clientId?: string, options: { now?: Date } = {}): Promise<LockHoldState> {
		const normalizedUserId = requireNonEmpty(userId, "user_id");
		const normalizedClientId = optionalString(clientId);
		const now = options.now ?? new Date();
		this.releaseExpired(now);
		const lock = this.locks.get(requireNonEmpty(lockId, "lock_id"));
		return evaluateLockHold(lock ? { ...lock } : null, normalizedUserId, normalizedClientId, now);
	}

	async listLocksForChapter(chapterId: string, options: { now?: Date } = {}): Promise<WorkLockRecord[]> {
		const now = options.now ?? new Date();
		this.releaseExpired(now);
		return [...this.locks.values()]
			.filter((lock) => (lock.chapterId === chapterId || (lock.scope === "chapter" && lock.scopeId === chapterId)) && !lock.releasedAt && Date.parse(lock.expiresAt) > now.getTime())
			.map((lock) => ({ ...lock }));
	}

	async releaseLocksForSubject(subjectKind: "chapter" | "page", subjectId: string, requesterUserId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		const now = options.now ?? new Date();
		const released: WorkLockRecord[] = [];
		for (const lock of this.locks.values()) {
			const matchesSubject = subjectKind === "chapter"
				? lock.chapterId === subjectId || (lock.scope === "chapter" && lock.scopeId === subjectId)
				// Page locks match by canonical scope id OR recorded page_id so an
				// image-id-keyed page lock is released on submit, not stranded.
				: (lock.scope === "page" && (lock.scopeId === subjectId || lock.pageId === subjectId)) || (isPageChildLock(lock) && lock.pageId === subjectId);
			if (lock.ownerUserId === requesterUserId && matchesSubject && !lock.releasedAt) {
				lock.releasedAt = now.toISOString();
				lock.releasedBy = requesterUserId;
				lock.releaseReason = options.reason ?? "workflow_transition";
				released.push({ ...lock });
			}
		}
		return released;
	}

	async releaseAllByUser(userId: string, scope?: WorkLockScope, scopeId?: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		if (scope) assertValidScope(scope);
		const now = options.now ?? new Date();
		const released: WorkLockRecord[] = [];
		for (const lock of this.locks.values()) {
			if (lock.ownerUserId !== userId || lock.releasedAt) continue;
			if (scope && lock.scope !== scope) continue;
			if (scopeId && lock.scopeId !== scopeId) continue;
			lock.releasedAt = now.toISOString();
			lock.releasedBy = userId;
			lock.releaseReason = options.reason ?? (scope ? "workflow_transition" : "user_logout");
			released.push({ ...lock });
		}
		return released;
	}

	async releaseLocksForUser(userId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		return this.releaseAllByUser(userId, undefined, undefined, options);
	}

	async releaseAllByUserInWorkspace(userId: string, workspaceId: string, options: ReleaseLockOptions = {}): Promise<WorkLockRecord[]> {
		const now = options.now ?? new Date();
		const reason = options.reason ?? "member_removed";
		const released: WorkLockRecord[] = [];
		for (const lock of this.locks.values()) {
			if (lock.releasedAt || lock.ownerUserId !== userId || lock.workspaceId !== workspaceId) continue;
			lock.releasedAt = now.toISOString();
			lock.releasedBy = userId;
			lock.releaseReason = reason;
			released.push({ ...lock });
		}
		return released;
	}

	async sweepExpiredLocks(now: Date = new Date()): Promise<number> {
		let count = 0;
		for (const lock of this.locks.values()) {
			if (!lock.releasedAt && Date.parse(lock.expiresAt) <= now.getTime()) {
				lock.releasedAt = lock.expiresAt;
				lock.releasedBy = "system";
				lock.releaseReason = "auto_expired";
				count += 1;
			}
		}
		return count;
	}

	private releaseExpired(now: Date): void {
		for (const lock of this.locks.values()) {
			if (!lock.releasedAt && Date.parse(lock.expiresAt) <= now.getTime()) {
				lock.releasedAt = lock.expiresAt;
				lock.releasedBy = "system";
				lock.releaseReason = "auto_expired";
			}
		}
	}
}

interface WorkLockRow {
	lock_id: string;
	scope: string;
	scope_id: string;
	owner_user_id: string;
	client_id?: string | null;
	project_id?: string | null;
	chapter_id?: string | null;
	page_id?: string | null;
	workspace_id?: string | null;
	acquired_at: Date | string;
	auto_release_at: Date | string;
	released_at?: Date | string | null;
	released_by?: string | null;
	release_reason?: string | null;
}

// Release ONLY the expired lock(s) for a single scope. acquireLock calls this before
// INSERT so an expired-but-unreleased row (which still occupies the partial-unique
// `work_locks_active_scope_idx` slot because released_at IS NULL) cannot cause a 23505.
// Indexed by (scope, scope_id), so it replaces the old per-operation FULL-TABLE expiry
// sweep that ran on every acquire/release/extend/read. Reads/extends now use time-aware
// predicates instead, and wholesale cleanup of expired rows across ALL scopes is handled
// off the request path by the `expired-work-lock-sweep` cron (see cron-scheduler.ts).
async function releaseExpiredLocksForScope(client: WorkLockSqlClient, scope: WorkLockScope, scopeId: string, now: Date): Promise<void> {
	await client.unsafe(`
		UPDATE work_locks
		SET released_at = auto_release_at,
			released_by = 'system',
			release_reason = 'auto_expired'
		WHERE scope = $1
			AND scope_id = $2
			AND released_at IS NULL
			AND auto_release_at <= $3::timestamptz
	`, [scope, scopeId, now.toISOString()]);
}

async function getLockById(client: WorkLockSqlClient, lockId: string): Promise<WorkLockRecord | null> {
	const rows = await client.unsafe<WorkLockRow>(`
		SELECT lock_id, scope, scope_id, owner_user_id, client_id, project_id, chapter_id, page_id, workspace_id, acquired_at, auto_release_at, released_at, released_by, release_reason
		FROM work_locks
		WHERE lock_id = $1
		LIMIT 1
	`, [lockId]);
	return rows[0] ? mapWorkLockRow(rows[0]) : null;
}

/**
 * Pure decision: does `userId`/`clientId` still hold `record`? Shared by both
 * stores so the Postgres + in-memory paths agree byte-for-byte. A null/absent
 * clientId on EITHER side is treated as the same anonymous tab (same rule as
 * {@link PostgresWorkLockStore.resolveExistingHolder}) so a legacy client that
 * does not send a tab id is not falsely told it was taken over.
 */
function evaluateLockHold(record: WorkLockRecord | null, userId: string, clientId: string | null, now: Date): LockHoldState {
	if (!record) return { status: "not_found" };
	if (record.releasedAt) {
		return { status: "released", reason: record.releaseReason, ownerUserId: record.ownerUserId };
	}
	if (Date.parse(record.expiresAt) <= now.getTime()) {
		return { status: "expired", ownerUserId: record.ownerUserId };
	}
	const sameUser = record.ownerUserId === userId;
	const recordClient = record.clientId ?? null;
	const sameTab = !recordClient || !clientId || recordClient === clientId;
	if (sameUser && sameTab) return { status: "held" };
	return { status: "held_by_other", ownerUserId: record.ownerUserId, clientId: record.clientId };
}

function toTakenOverHolder(record: WorkLockRecord, crossUser: boolean): TakenOverHolder {
	return {
		userId: record.ownerUserId,
		clientId: record.clientId,
		scope: record.scope,
		scopeId: record.scopeId,
		projectId: record.projectId,
		chapterId: record.chapterId,
		pageId: record.pageId,
		workspaceId: record.workspaceId,
		crossUser,
	};
}

function mapWorkLockRow(row: WorkLockRow): WorkLockRecord {
	return {
		lockId: row.lock_id,
		scope: row.scope as WorkLockScope,
		scopeId: row.scope_id,
		ownerUserId: row.owner_user_id,
		clientId: row.client_id ?? undefined,
		projectId: row.project_id ?? undefined,
		chapterId: row.chapter_id ?? undefined,
		pageId: row.page_id ?? undefined,
		workspaceId: row.workspace_id ?? undefined,
		acquiredAt: toIso(row.acquired_at),
		expiresAt: toIso(row.auto_release_at),
		releasedAt: row.released_at ? toIso(row.released_at) : undefined,
		releasedBy: row.released_by ?? undefined,
		releaseReason: row.release_reason ?? undefined,
	};
}

function createWorkLockEventPublisher(): WorkLockEventPublisher {
	if (!process.env.REDIS_URL?.trim()) return new NoopWorkLockEventPublisher();
	return new RedisWorkLockEventPublisher();
}

function assertValidScope(scope: WorkLockScope): void {
	if (!VALID_SCOPES.has(scope)) throw new Error("Invalid lock scope");
}

function normalizeDurationMin(durationMin: number): number {
	if (!Number.isFinite(durationMin) || durationMin <= 0) return DEFAULT_DURATION_MIN;
	return Math.min(Math.ceil(durationMin), MAX_DURATION_MIN);
}

function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60 * 1000);
}

function requireNonEmpty(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

function optionalString(value: string | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireRow<T>(rows: T[], label: string): T {
	const row = rows[0];
	if (!row) throw new Error(`${label} not found`);
	return row;
}

function isUniqueViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as Error & { code?: unknown }).code;
	if (code === "23505") return true;
	return error.message.includes("work_locks_active_scope_idx") || error.message.toLowerCase().includes("unique");
}

function isPageChildLock(lock: WorkLockRecord): boolean {
	return lock.scope === "object" || lock.scope === "layer";
}

export function createWorkLockStore(): WorkLockStore | null {
	if (!process.env.DATABASE_URL?.trim()) return null;
	return new PostgresWorkLockStore();
}

export const workLockStore = createWorkLockStore();
