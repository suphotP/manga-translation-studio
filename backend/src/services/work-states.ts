// W2.10: Workflow state machine for chapter/page subjects.
//
// Linear pipeline: draft -> in_progress -> submitted -> in_qc -> approved -> released.
// Rejected from in_qc bounces back to in_progress. Admins/Owners can force any
// transition; every transition is logged with the actor role and a forced flag
// so the audit history records "who/when/from->to/why".

import { getSharedBunSql } from "./sql-pool.js";
import { RedisClient } from "bun";
import { randomUUID } from "crypto";
import { pushArrayLiteral } from "./pg-array.js";
import type { WorkLockScope, WorkLockStore } from "./work-locks.js";

export type WorkSubjectKind = "chapter" | "page";
export type WorkStateValue = "draft" | "in_progress" | "submitted" | "in_qc" | "approved" | "released" | "rejected";

// Eight production roles, distinct from workspace-access roles
// (owner/admin/editor/viewer). The work role is what gates state transitions:
// QC can only approve/reject, Translator/Cleaner/Typesetter can only claim and
// submit, Team Lead orchestrates, Owner/Admin can force anything (audited).
// "guest" exists for read-only / external contributor visibility and cannot
// drive transitions on its own.
export type WorkActorRole =
	| "owner"
	| "admin"
	| "team_lead"
	| "translator"
	| "cleaner"
	| "typesetter"
	| "qc"
	| "guest";

export interface WorkStateRecord {
	id: string;
	subjectKind: WorkSubjectKind;
	subjectId: string;
	state: WorkStateValue;
	assigneeUserId?: string;
	dueAt?: string;
	comment?: string;
	transitionedBy?: string;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkStateTransitionRecord {
	id: string;
	subjectKind: WorkSubjectKind;
	subjectId: string;
	fromState: WorkStateValue;
	toState: WorkStateValue;
	comment?: string;
	userId: string;
	role?: WorkActorRole;
	forced: boolean;
	createdAt: string;
}

export interface TransitionInput {
	subjectKind: WorkSubjectKind;
	subjectId: string;
	toState: WorkStateValue;
	actorUserId: string;
	actorRole: WorkActorRole;
	comment?: string;
	assigneeUserId?: string;
	dueAt?: string;
	// Honored only when actorRole is owner/admin. Audit log records forced=true.
	force?: boolean;
	now?: Date;
}

export interface WorkStateEventPublisher {
	publish(channel: string, payload: Record<string, unknown>): Promise<void>;
}

export class NoopWorkStateEventPublisher implements WorkStateEventPublisher {
	async publish(): Promise<void> {}
}

export class RedisWorkStateEventPublisher implements WorkStateEventPublisher {
	private readonly client: RedisClient;
	constructor(url = process.env.REDIS_URL) {
		this.client = url?.trim() ? new RedisClient(url) : new RedisClient();
	}
	async publish(channel: string, payload: Record<string, unknown>): Promise<void> {
		await this.client.send("PUBLISH", [channel, JSON.stringify(payload)]);
	}
}

export interface WorkStateSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: WorkStateSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

export interface WorkStateStore {
	getWorkState(subjectKind: WorkSubjectKind, subjectId: string): Promise<WorkStateRecord | null>;
	/**
	 * Batch read of many subjects of the SAME kind in a single query, so callers
	 * that need every page's state at once (e.g. the export-gate readiness
	 * checklist) avoid an N+1 fan-out. Returns only the subjects that have a row;
	 * the order is not guaranteed, so callers should key by subjectId.
	 */
	getWorkStatesForSubjects(subjectKind: WorkSubjectKind, subjectIds: string[]): Promise<WorkStateRecord[]>;
	transitionWorkState(input: TransitionInput): Promise<WorkStateRecord>;
	listTransitionHistory(subjectKind: WorkSubjectKind, subjectId: string, options?: { limit?: number }): Promise<WorkStateTransitionRecord[]>;
}

export class WorkStatePermissionError extends Error {
	constructor(message = "Forbidden: role cannot perform workflow transition") {
		super(message);
	}
}

export class WorkStateTransitionError extends Error {
	constructor(message = "Invalid workflow transition") {
		super(message);
	}
}

/**
 * Optimistic-concurrency conflict: the row's state changed between read and the
 * guarded UPDATE, so the transition could not be recorded. Distinct from a plain
 * invalid transition because the client should RETRY (409 Conflict), not treat it
 * as a permanent bad request (400). Extends WorkStateTransitionError so any existing
 * `instanceof WorkStateTransitionError` handler still catches it; the route checks
 * this subclass FIRST to map it to 409.
 */
export class WorkStateConflictError extends WorkStateTransitionError {
	constructor(message = "Workflow state changed before the transition could be recorded") {
		super(message);
	}
}

const WORK_STATES = new Set<WorkStateValue>(["draft", "in_progress", "submitted", "in_qc", "approved", "released", "rejected"]);
const SUBJECT_KINDS = new Set<WorkSubjectKind>(["chapter", "page"]);

const ALLOWED_TRANSITIONS: Record<WorkStateValue, WorkStateValue[]> = {
	draft: ["in_progress"],
	in_progress: ["submitted"],
	submitted: ["in_qc", "rejected"],
	in_qc: ["approved", "rejected"],
	approved: ["released"],
	released: [],
	rejected: ["in_progress"],
};

// Role gate per to_state per the W2.10 spec. Owner/Admin pass everywhere via
// isAdminRole(); guests can never transition (read-only). Team Lead can push
// work through every stage as the orchestrator.
const ROLE_GATE: Record<WorkStateValue, WorkActorRole[]> = {
	draft: [],
	in_progress: ["team_lead", "translator", "cleaner", "typesetter"],
	submitted: ["team_lead", "translator", "cleaner", "typesetter"],
	in_qc: ["team_lead", "qc"],
	approved: ["qc"],
	rejected: ["qc"],
	released: ["team_lead"],
};

// Reject from in_qc REQUIRES a comment so QC explains the bounce; the bounce
// itself is a separate transition (in_progress) the assignee performs after.
const TRANSITIONS_REQUIRING_COMMENT = new Set<string>(["in_qc->rejected", "submitted->rejected"]);

export interface WorkStateStoreOptions {
	locks?: WorkLockStore;
	publisher?: WorkStateEventPublisher;
	workspaceIdFor?: (record: WorkStateRecord, client: WorkStateSqlClient) => string | undefined | Promise<string | undefined>;
}

export class PostgresWorkStateStore implements WorkStateStore {
	private readonly client: WorkStateSqlClient;
	private readonly locks?: WorkLockStore;
	private readonly publisher: WorkStateEventPublisher;
	private readonly workspaceIdFor: (record: WorkStateRecord, client: WorkStateSqlClient) => string | undefined | Promise<string | undefined>;

	constructor(databaseUrlOrClient: string | WorkStateSqlClient = process.env.DATABASE_URL ?? "", options: WorkStateStoreOptions = {}) {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) throw new Error("Work state store requires DATABASE_URL");
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as WorkStateSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
		this.locks = options.locks;
		this.publisher = options.publisher ?? createWorkStateEventPublisher();
		this.workspaceIdFor = options.workspaceIdFor ?? (() => undefined);
	}

	async getWorkState(subjectKind: WorkSubjectKind, subjectId: string): Promise<WorkStateRecord | null> {
		assertSubjectKind(subjectKind);
		const rows = await this.client.unsafe<WorkStateRow>(`
			SELECT id, subject_kind, subject_id, state, assignee_user_id, due_at, comment, transitioned_by, created_by, created_at, updated_at
			FROM work_states
			WHERE subject_kind = $1
				AND subject_id = $2
			LIMIT 1
		`, [subjectKind, requireNonEmpty(subjectId, "subject_id")]);
		return rows[0] ? mapWorkStateRow(rows[0]) : null;
	}

	async getWorkStatesForSubjects(subjectKind: WorkSubjectKind, subjectIds: string[]): Promise<WorkStateRecord[]> {
		assertSubjectKind(subjectKind);
		const normalized = [...new Set(subjectIds.map((id) => id.trim()).filter((id) => id.length > 0))];
		if (normalized.length === 0) return [];
		// Single query with an ANY(ARRAY[...]) array predicate — no per-subject
		// round-trip. Each subject_id is bound as its own scalar param because
		// Bun.SQL cannot bind a JS array for $n::text[] (it serializes the array
		// as a malformed literal). $1 is subjectKind; the ids start at $2.
		const params: unknown[] = [subjectKind];
		const rows = await this.client.unsafe<WorkStateRow>(`
			SELECT id, subject_kind, subject_id, state, assignee_user_id, due_at, comment, transitioned_by, created_by, created_at, updated_at
			FROM work_states
			WHERE subject_kind = $1
				AND subject_id = ANY(${pushArrayLiteral(params, normalized, "text")})
		`, params);
		return rows.map(mapWorkStateRow);
	}

	async listTransitionHistory(subjectKind: WorkSubjectKind, subjectId: string, options: { limit?: number } = {}): Promise<WorkStateTransitionRecord[]> {
		assertSubjectKind(subjectKind);
		const normalizedSubjectId = requireNonEmpty(subjectId, "subject_id");
		const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
		const rows = await this.client.unsafe<WorkStateTransitionRow>(`
			SELECT id, subject_kind, subject_id, from_state, to_state, comment, user_id, role, forced, created_at
			FROM work_state_transitions
			WHERE subject_kind = $1
				AND subject_id = $2
			ORDER BY created_at DESC, id DESC
			LIMIT $3
		`, [subjectKind, normalizedSubjectId, limit]);
		return rows.map(mapWorkStateTransitionRow);
	}

	async transitionWorkState(input: TransitionInput): Promise<WorkStateRecord> {
		assertSubjectKind(input.subjectKind);
		assertWorkState(input.toState);
		const now = input.now ?? new Date();
		const subjectId = requireNonEmpty(input.subjectId, "subject_id");
		const actorUserId = requireNonEmpty(input.actorUserId, "actor_user_id");
		const force = Boolean(input.force && isAdminRole(input.actorRole));

		const next = await this.transaction(async (client) => {
			const current = await getOrCreateState(client, {
				subjectKind: input.subjectKind,
				subjectId,
				createdBy: actorUserId,
				now,
			});
			validateTransition({
				fromState: current.state,
				toState: input.toState,
				actorRole: input.actorRole,
				force,
				comment: input.comment,
			});

			const rows = await client.unsafe<WorkStateRow>(`
				UPDATE work_states
				SET state = $3,
					assignee_user_id = COALESCE($4, assignee_user_id),
					due_at = COALESCE($5::timestamptz, due_at),
					comment = $6,
					transitioned_by = $7,
					updated_at = $8::timestamptz
				WHERE subject_kind = $1
					AND subject_id = $2
					AND state = $9
				RETURNING id, subject_kind, subject_id, state, assignee_user_id, due_at, comment, transitioned_by, created_by, created_at, updated_at
			`, [
				input.subjectKind,
				subjectId,
				input.toState,
				optionalString(input.assigneeUserId),
				optionalString(input.dueAt),
				optionalString(input.comment),
				actorUserId,
				now.toISOString(),
				current.state,
			]);
			if (!rows[0]) {
				throw new WorkStateConflictError(`Workflow state changed before ${current.state} -> ${input.toState} could be recorded`);
			}
			await client.unsafe(`
				INSERT INTO work_state_transitions (
					id, subject_kind, subject_id, from_state, to_state, comment, user_id, role, forced, created_at
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
			`, [
				randomUUID(),
				input.subjectKind,
				subjectId,
				current.state,
				input.toState,
				optionalString(input.comment),
				actorUserId,
				input.actorRole,
				force,
				now.toISOString(),
			]);
			return mapWorkStateRow(rows[0]);
		});

		await this.runSideEffects(next, input, force, now);
		return next;
	}

	private async runSideEffects(next: WorkStateRecord, input: TransitionInput, forced: boolean, now: Date): Promise<void> {
		try {
			if (input.toState === "submitted") {
				await this.locks?.releaseLocksForSubject(input.subjectKind, input.subjectId, input.actorUserId, {
					reason: "workflow_submit",
					now,
				});
			}
			if (input.toState === "rejected") {
				await this.locks?.releaseLocksForSubject(input.subjectKind, input.subjectId, input.actorUserId, {
					reason: "workflow_reject",
					now,
				});
			}
		} catch (error) {
			console.warn("[work-states] post-commit lock release failed", error);
		}
		try {
			const workspaceId = await this.workspaceIdFor(next, this.client);
			if (workspaceId) {
				await this.publisher.publish(`ws:work-states:${workspaceId}`, {
					type: "transition",
					subject_kind: next.subjectKind,
					subject_id: next.subjectId,
					to_state: next.state,
					user_id: input.actorUserId,
					role: input.actorRole,
					comment: input.comment,
					forced,
				});
			}
		} catch (error) {
			console.warn("[work-states] post-commit publish failed", error);
		}
	}

	private async transaction<T>(fn: (client: WorkStateSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) return this.client.begin(fn);
		return fn(this.client);
	}
}

export class InMemoryWorkStateStore implements WorkStateStore {
	private readonly states = new Map<string, WorkStateRecord>();
	private readonly history: WorkStateTransitionRecord[] = [];
	private readonly locks?: WorkLockStore;

	constructor(options: WorkStateStoreOptions | WorkLockStore | undefined = undefined) {
		// Tolerate the bare-WorkLockStore constructor signature for backward
		// compatibility with earlier callers.
		if (options && typeof (options as WorkLockStore).acquireLock === "function") {
			this.locks = options as WorkLockStore;
		} else {
			this.locks = (options as WorkStateStoreOptions | undefined)?.locks;
		}
	}

	async getWorkState(subjectKind: WorkSubjectKind, subjectId: string): Promise<WorkStateRecord | null> {
		const record = this.states.get(stateKey(subjectKind, subjectId));
		return record ? { ...record } : null;
	}

	async getWorkStatesForSubjects(subjectKind: WorkSubjectKind, subjectIds: string[]): Promise<WorkStateRecord[]> {
		assertSubjectKind(subjectKind);
		const out: WorkStateRecord[] = [];
		for (const subjectId of new Set(subjectIds.map((id) => id.trim()).filter((id) => id.length > 0))) {
			const record = this.states.get(stateKey(subjectKind, subjectId));
			if (record) out.push({ ...record });
		}
		return out;
	}

	async transitionWorkState(input: TransitionInput): Promise<WorkStateRecord> {
		assertSubjectKind(input.subjectKind);
		assertWorkState(input.toState);
		const now = input.now ?? new Date();
		const key = stateKey(input.subjectKind, input.subjectId);
		const current = this.states.get(key) ?? {
			id: randomUUID(),
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			state: "draft" as WorkStateValue,
			createdBy: input.actorUserId,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		};
		const force = Boolean(input.force && isAdminRole(input.actorRole));
		validateTransition({
			fromState: current.state,
			toState: input.toState,
			actorRole: input.actorRole,
			force,
			comment: input.comment,
		});
		const previousState = current.state;
		const next: WorkStateRecord = {
			...current,
			state: input.toState,
			assigneeUserId: input.assigneeUserId ?? current.assigneeUserId,
			dueAt: input.dueAt ?? current.dueAt,
			comment: input.comment ?? current.comment,
			transitionedBy: input.actorUserId,
			updatedAt: now.toISOString(),
		};
		this.states.set(key, next);
		this.history.push({
			id: randomUUID(),
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			fromState: previousState,
			toState: input.toState,
			comment: input.comment,
			userId: input.actorUserId,
			role: input.actorRole,
			forced: force,
			createdAt: now.toISOString(),
		});
		if (input.toState === "submitted" || input.toState === "rejected") {
			const reason = input.toState === "submitted" ? "workflow_submit" : "workflow_reject";
			// Release every lock the actor holds on the subject. For a chapter
			// submit this means every page/object/layer/chapter lock whose
			// chapter_id matches the subject — releaseLocksForSubject handles
			// both forms via the (subjectKind, subjectId) tuple.
			await this.locks?.releaseLocksForSubject(input.subjectKind, input.subjectId, input.actorUserId, {
				reason,
				now,
			});
		}
		return { ...next };
	}

	async listTransitionHistory(subjectKind: WorkSubjectKind, subjectId: string, options: { limit?: number } = {}): Promise<WorkStateTransitionRecord[]> {
		const filtered = this.history.filter((entry) => entry.subjectKind === subjectKind && entry.subjectId === subjectId);
		filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
		const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
		return filtered.slice(0, limit).map((entry) => ({ ...entry }));
	}
}

function lockScopeForSubject(kind: WorkSubjectKind): WorkLockScope {
	return kind === "chapter" ? "chapter" : "page";
}

interface WorkStateRow {
	id: string;
	subject_kind: string;
	subject_id: string;
	state: string;
	assignee_user_id?: string | null;
	due_at?: Date | string | null;
	comment?: string | null;
	transitioned_by?: string | null;
	created_by: string;
	created_at: Date | string;
	updated_at: Date | string;
}

interface WorkStateTransitionRow {
	id: string;
	subject_kind: string;
	subject_id: string;
	from_state: string;
	to_state: string;
	comment?: string | null;
	user_id: string;
	role?: string | null;
	forced: boolean;
	created_at: Date | string;
}

function validateTransition(input: { fromState: WorkStateValue; toState: WorkStateValue; actorRole: WorkActorRole; force: boolean; comment?: string }): void {
	if (input.force) {
		// Admin force still requires the comment when QC rejects, because
		// "rejected with no reason" is meaningless downstream. The state
		// machine itself stays linear.
		assertCommentIfRequired(input.fromState, input.toState, input.comment);
		return;
	}
	if (!ALLOWED_TRANSITIONS[input.fromState].includes(input.toState)) {
		throw new WorkStateTransitionError(`Invalid workflow transition ${input.fromState} -> ${input.toState}`);
	}
	if (!roleCanTransition(input.actorRole, input.toState)) {
		throw new WorkStatePermissionError();
	}
	assertCommentIfRequired(input.fromState, input.toState, input.comment);
}

function assertCommentIfRequired(fromState: WorkStateValue, toState: WorkStateValue, comment: string | undefined): void {
	if (TRANSITIONS_REQUIRING_COMMENT.has(`${fromState}->${toState}`) && !(comment && comment.trim())) {
		throw new WorkStateTransitionError(`Transition ${fromState} -> ${toState} requires a comment`);
	}
}

/**
 * Canonical work-state subject id for a project page. Matches the
 * `${projectId}:page:${pageIndex}` form the project catalog persists, so a
 * work-state read for a page resolves the same row the catalog wrote.
 */
export function pageWorkSubjectId(projectId: string, pageIndex: number): string {
	return `${projectId}:page:${pageIndex}`;
}

export function roleCanTransition(role: WorkActorRole, toState: WorkStateValue): boolean {
	if (isAdminRole(role)) return true;
	return ROLE_GATE[toState]?.includes(role) ?? false;
}

async function getOrCreateState(client: WorkStateSqlClient, input: { subjectKind: WorkSubjectKind; subjectId: string; createdBy: string; now: Date }): Promise<WorkStateRecord> {
	const rows = await client.unsafe<WorkStateRow>(`
		INSERT INTO work_states (id, subject_kind, subject_id, state, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, 'draft', $4, $5::timestamptz, $5::timestamptz)
		ON CONFLICT (subject_kind, subject_id) DO UPDATE SET updated_at = work_states.updated_at
		RETURNING id, subject_kind, subject_id, state, assignee_user_id, due_at, created_by, created_at, updated_at
	`, [randomUUID(), input.subjectKind, input.subjectId, input.createdBy, input.now.toISOString()]);
	return mapWorkStateRow(requireRow(rows, "work state"));
}

function mapWorkStateRow(row: WorkStateRow): WorkStateRecord {
	return {
		id: row.id,
		subjectKind: row.subject_kind as WorkSubjectKind,
		subjectId: row.subject_id,
		state: row.state as WorkStateValue,
		assigneeUserId: row.assignee_user_id ?? undefined,
		dueAt: row.due_at ? toIso(row.due_at) : undefined,
		comment: row.comment ?? undefined,
		transitionedBy: row.transitioned_by ?? undefined,
		createdBy: row.created_by,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

function mapWorkStateTransitionRow(row: WorkStateTransitionRow): WorkStateTransitionRecord {
	return {
		id: row.id,
		subjectKind: row.subject_kind as WorkSubjectKind,
		subjectId: row.subject_id,
		fromState: row.from_state as WorkStateValue,
		toState: row.to_state as WorkStateValue,
		comment: row.comment ?? undefined,
		userId: row.user_id,
		role: (row.role as WorkActorRole | null) ?? undefined,
		forced: Boolean(row.forced),
		createdAt: toIso(row.created_at),
	};
}

function stateKey(subjectKind: WorkSubjectKind, subjectId: string): string {
	return `${subjectKind}:${subjectId}`;
}

function assertSubjectKind(subjectKind: WorkSubjectKind): void {
	if (!SUBJECT_KINDS.has(subjectKind)) throw new Error("Invalid work state subject kind");
}

function assertWorkState(state: WorkStateValue): void {
	if (!WORK_STATES.has(state)) throw new Error("Invalid work state");
}

function isAdminRole(role: WorkActorRole): boolean {
	return role === "owner" || role === "admin";
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

function createWorkStateEventPublisher(): WorkStateEventPublisher {
	if (!process.env.REDIS_URL?.trim()) return new NoopWorkStateEventPublisher();
	return new RedisWorkStateEventPublisher();
}

export async function resolveWorkspaceIdForWorkStateRecord(record: WorkStateRecord, client: WorkStateSqlClient): Promise<string | undefined> {
	try {
		if (record.subjectKind === "page") {
			const rows = await client.unsafe<{ workspace_id?: string | null }>(`
				SELECT projects.workspace_id
				FROM project_pages
				INNER JOIN projects ON projects.project_id = project_pages.project_id
				WHERE project_pages.page_id = $1
				LIMIT 1
			`, [record.subjectId]);
			const workspaceId = rows[0]?.workspace_id?.trim();
			if (workspaceId) return workspaceId;
			const projectId = projectIdFromPageSubject(record.subjectId);
			if (projectId) return resolveProjectWorkspaceId(projectId, client);
			return undefined;
		}
		return resolveProjectWorkspaceId(record.subjectId, client);
	} catch {
		return undefined;
	}
}

async function resolveProjectWorkspaceId(projectId: string, client: WorkStateSqlClient): Promise<string | undefined> {
	const rows = await client.unsafe<{ workspace_id?: string | null }>(`
		SELECT workspace_id
		FROM projects
		WHERE project_id = $1
		LIMIT 1
	`, [projectId]);
	return rows[0]?.workspace_id?.trim() || undefined;
}

function projectIdFromPageSubject(subjectId: string): string | undefined {
	const marker = ":page:";
	const markerIndex = subjectId.indexOf(marker);
	if (markerIndex <= 0) return undefined;
	return subjectId.slice(0, markerIndex);
}

export function createWorkStateStore(options: WorkStateStoreOptions = {}): WorkStateStore | null {
	if (!process.env.DATABASE_URL?.trim()) return null;
	return new PostgresWorkStateStore(process.env.DATABASE_URL, options);
}

export const workStateStore = createWorkStateStore();
