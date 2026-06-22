// Workspace contacts ("friends / followers") store — a lightweight per-user
// address book for fast re-invite into chapter teams. NOT an access grant: a
// contact row only makes someone easy to FIND when inviting; access is still
// granted exclusively through the chapter-team invite + accept flow.
//
// Dual backing store mirroring notifications.ts / billing-store.ts:
//   - File mode (prototype / self-host without Postgres): a single JSON snapshot
//     under DATA_DIR.
//   - Postgres mode: the `workspace_contacts` table (migration 0070).
// The store is selected the same way as notifications (NOTIFICATIONS_STORE-style
// override, else the billing-store Postgres signal).

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";

import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import type { ChapterTeamRole, WorkspaceContact, WorkspaceContactRelationship } from "../types/index.js";

export class WorkspaceContactError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(message: string, code: string, status = 400) {
		super(message);
		this.name = "WorkspaceContactError";
		this.code = code;
		this.status = status;
	}
}

export const CHAPTER_TEAM_ROLES: readonly ChapterTeamRole[] = [
	"translator",
	"cleaner",
	"typesetter",
	"qc",
	"guest",
];
const CONTACT_RELATIONSHIPS: readonly WorkspaceContactRelationship[] = [
	"friend",
	"follower",
	"recent_collaborator",
];

// Hard cap on a single user's contact book so the file snapshot / a list query
// can never grow unbounded.
export const MAX_CONTACTS_PER_USER = 1000;

export interface CreateContactInput {
	ownerUserId: string;
	contactUserId?: string;
	email?: string;
	displayName?: string;
	relationship?: WorkspaceContactRelationship;
	suggestedRole?: ChapterTeamRole;
}

export interface WorkspaceContactStore {
	listForOwner(ownerUserId: string): Promise<WorkspaceContact[]>;
	create(input: CreateContactInput): Promise<WorkspaceContact>;
	delete(ownerUserId: string, contactId: string): Promise<boolean>;
	getForOwner(ownerUserId: string, contactId: string): Promise<WorkspaceContact | null>;
}

function normalizeRelationship(value: unknown): WorkspaceContactRelationship {
	return CONTACT_RELATIONSHIPS.includes(value as WorkspaceContactRelationship)
		? (value as WorkspaceContactRelationship)
		: "friend";
}

function normalizeSuggestedRole(value: unknown): ChapterTeamRole | undefined {
	return CHAPTER_TEAM_ROLES.includes(value as ChapterTeamRole)
		? (value as ChapterTeamRole)
		: undefined;
}

function validateCreateInput(input: CreateContactInput): CreateContactInput {
	const ownerUserId = input.ownerUserId?.trim();
	if (!ownerUserId) {
		throw new WorkspaceContactError("ownerUserId is required", "contact_invalid_owner");
	}
	const contactUserId = input.contactUserId?.trim() || undefined;
	const email = input.email?.trim().toLowerCase() || undefined;
	if (!contactUserId && !email) {
		// A contact must be addressable somehow (UID or email) — otherwise it can
		// never be turned into an invite.
		throw new WorkspaceContactError("A contact needs a UID or an email", "contact_no_target");
	}
	return {
		ownerUserId,
		contactUserId,
		email,
		displayName: input.displayName?.trim() || undefined,
		relationship: normalizeRelationship(input.relationship),
		suggestedRole: normalizeSuggestedRole(input.suggestedRole),
	};
}

/** True when two contacts address the SAME person (for dedupe). */
function sameTarget(a: { contactUserId?: string; email?: string }, b: { contactUserId?: string; email?: string }): boolean {
	if (a.contactUserId && b.contactUserId && a.contactUserId === b.contactUserId) return true;
	if (a.email && b.email && a.email === b.email) return true;
	return false;
}

// ── File store ────────────────────────────────────────────────────────────────
export class FileWorkspaceContactStore implements WorkspaceContactStore {
	private contacts: WorkspaceContact[] = [];

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const data = readJsonFile<WorkspaceContact[]>(this.persistPath);
			if (Array.isArray(data)) this.contacts = data;
		} catch {
			this.contacts = [];
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify(this.contacts, null, 2));
	}

	async listForOwner(ownerUserId: string): Promise<WorkspaceContact[]> {
		const owner = ownerUserId.trim();
		if (!owner) return [];
		return this.contacts
			.filter((contact) => contact.ownerUserId === owner)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map((contact) => ({ ...contact }));
	}

	async getForOwner(ownerUserId: string, contactId: string): Promise<WorkspaceContact | null> {
		const owner = ownerUserId.trim();
		const id = contactId.trim();
		const found = this.contacts.find((contact) => contact.ownerUserId === owner && contact.id === id);
		return found ? { ...found } : null;
	}

	async create(input: CreateContactInput): Promise<WorkspaceContact> {
		const validated = validateCreateInput(input);
		const now = new Date().toISOString();
		// Upsert-by-target: re-adding the same person refreshes the existing row
		// instead of duplicating it.
		const existing = this.contacts.find(
			(contact) => contact.ownerUserId === validated.ownerUserId && sameTarget(contact, validated),
		);
		if (existing) {
			existing.contactUserId = validated.contactUserId ?? existing.contactUserId;
			existing.email = validated.email ?? existing.email;
			existing.displayName = validated.displayName ?? existing.displayName;
			existing.relationship = validated.relationship ?? existing.relationship;
			existing.suggestedRole = validated.suggestedRole ?? existing.suggestedRole;
			existing.updatedAt = now;
			this.persist();
			return { ...existing };
		}
		const ownerCount = this.contacts.filter((contact) => contact.ownerUserId === validated.ownerUserId).length;
		if (ownerCount >= MAX_CONTACTS_PER_USER) {
			throw new WorkspaceContactError("Contact book is full", "contact_limit_reached", 409);
		}
		const record: WorkspaceContact = {
			id: uuid(),
			ownerUserId: validated.ownerUserId,
			contactUserId: validated.contactUserId,
			email: validated.email,
			displayName: validated.displayName,
			relationship: validated.relationship ?? "friend",
			suggestedRole: validated.suggestedRole,
			createdAt: now,
			updatedAt: now,
		};
		this.contacts.push(record);
		this.persist();
		return { ...record };
	}

	async delete(ownerUserId: string, contactId: string): Promise<boolean> {
		const owner = ownerUserId.trim();
		const id = contactId.trim();
		const before = this.contacts.length;
		this.contacts = this.contacts.filter(
			(contact) => !(contact.ownerUserId === owner && contact.id === id),
		);
		const removed = this.contacts.length < before;
		if (removed) this.persist();
		return removed;
	}
}

// ── Postgres store ──────────────────────────────────────────────────────────────
export interface ContactSqlClient {
	unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: ContactSqlClient) => Promise<T>): Promise<T>;
}

interface ContactRow {
	id: string;
	owner_user_id: string;
	contact_user_id: string | null;
	email: string | null;
	display_name: string | null;
	relationship: string;
	suggested_role: string | null;
	created_at: string | Date;
	updated_at: string | Date;
}

function mapRow(row: ContactRow): WorkspaceContact {
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		contactUserId: row.contact_user_id ?? undefined,
		email: row.email ?? undefined,
		displayName: row.display_name ?? undefined,
		relationship: normalizeRelationship(row.relationship),
		suggestedRole: normalizeSuggestedRole(row.suggested_role),
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

export class PostgresWorkspaceContactStore implements WorkspaceContactStore {
	private readonly client: ContactSqlClient;

	constructor(databaseUrlOrClient: string | ContactSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new WorkspaceContactError("Postgres contact store requires DATABASE_URL", "contact_store_unconfigured", 503);
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as ContactSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async listForOwner(ownerUserId: string): Promise<WorkspaceContact[]> {
		const owner = ownerUserId.trim();
		if (!owner) return [];
		const rows = await this.client.unsafe<ContactRow>(`
			SELECT id, owner_user_id, contact_user_id, email, display_name, relationship, suggested_role, created_at, updated_at
			FROM workspace_contacts
			WHERE owner_user_id = $1
			ORDER BY updated_at DESC, id DESC
			LIMIT ${MAX_CONTACTS_PER_USER}
		`, [owner]);
		return rows.map(mapRow);
	}

	async getForOwner(ownerUserId: string, contactId: string): Promise<WorkspaceContact | null> {
		const owner = ownerUserId.trim();
		const id = contactId.trim();
		if (!owner || !id) return null;
		const rows = await this.client.unsafe<ContactRow>(`
			SELECT id, owner_user_id, contact_user_id, email, display_name, relationship, suggested_role, created_at, updated_at
			FROM workspace_contacts
			WHERE owner_user_id = $1 AND id = $2::uuid
		`, [owner, id]);
		return rows[0] ? mapRow(rows[0]) : null;
	}

	async create(input: CreateContactInput): Promise<WorkspaceContact> {
		const validated = validateCreateInput(input);

		// ATOMIC cap enforcement (codex #388 P2). The dedupe-probe → count → INSERT
		// sequence below is a read-then-write race: two parallel UNIQUE inserts at
		// MAX-1 could each probe (miss), each read count=MAX-1, and each INSERT —
		// blowing past the cap. File mode is effectively serialized in-process;
		// Postgres is not. So we run the whole sequence inside ONE transaction and
		// take a per-owner advisory lock first, serializing concurrent create() calls
		// for the SAME owner across connections. Different owners never contend.
		return this.transaction(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`workspace_contact:${validated.ownerUserId}`]);
			return this.createLocked(tx, validated);
		});
	}

	/**
	 * Cap-enforced create body. MUST run inside transaction() under the per-owner
	 * advisory lock so the dedupe-probe + count + insert are atomic w.r.t. other
	 * create() calls for the same owner.
	 */
	private async createLocked(client: ContactSqlClient, validated: CreateContactInput): Promise<WorkspaceContact> {
		// Dedupe by UID **OR** email — EXACT parity with file mode's sameTarget(). The
		// composite unique index (owner, COALESCE(uid,''), COALESCE(email,'')) treats a
		// pending `(owner,'',email)` row and a later `(owner,uid,email)` row as DISTINCT
		// keys, so a plain ON CONFLICT upsert would NOT collapse them → a duplicate row
		// for the same person + a cap-counting bypass (codex P2). So we resolve the
		// existing row ourselves with an OR match, then UPDATE it (merging targets) or
		// INSERT a new one. The unique index remains a backstop against a concurrent
		// double-insert of the identical key.
		const existingRows = await client.unsafe<ContactRow>(`
			SELECT id, owner_user_id, contact_user_id, email, display_name, relationship, suggested_role, created_at, updated_at
			FROM workspace_contacts
			WHERE owner_user_id = $1
				AND (
					($2::text IS NOT NULL AND contact_user_id = $2)
					OR ($3::text IS NOT NULL AND email = $3)
				)
			ORDER BY updated_at DESC, id DESC
			LIMIT 1
		`, [validated.ownerUserId, validated.contactUserId ?? null, validated.email ?? null]);
		const existing = existingRows[0];

		if (existing) {
			// Re-add of an EXISTING target: merge + refresh in place (NOT capped — no new
			// row is created), mirroring the file store's upsert-by-target.
			const rows = await client.unsafe<ContactRow>(`
				UPDATE workspace_contacts SET
					contact_user_id = COALESCE($2, contact_user_id),
					email = COALESCE($3, email),
					display_name = COALESCE($4, display_name),
					relationship = $5,
					suggested_role = COALESCE($6, suggested_role),
					updated_at = now()
				WHERE id = $1
				RETURNING id, owner_user_id, contact_user_id, email, display_name, relationship, suggested_role, created_at, updated_at
			`, [
				existing.id,
				validated.contactUserId ?? null,
				validated.email ?? null,
				validated.displayName ?? null,
				validated.relationship ?? "friend",
				validated.suggestedRole ?? null,
			]);
			const row = rows[0];
			if (!row) throw new WorkspaceContactError("Failed to persist contact", "contact_create_failed", 500);
			return mapRow(row);
		}

		// Genuinely NEW target: enforce the per-owner cap (parity with file mode, which
		// rejects at MAX_CONTACTS_PER_USER). The OR-dedupe above already counts this row
		// against the cap because a duplicate-by-UID-or-email never reaches here.
		const countRows = await client.unsafe<{ count: number | string }>(`
			SELECT count(*)::int AS count FROM workspace_contacts WHERE owner_user_id = $1
		`, [validated.ownerUserId]);
		const ownerCount = Number(countRows[0]?.count ?? 0);
		if (ownerCount >= MAX_CONTACTS_PER_USER) {
			throw new WorkspaceContactError("Contact book is full", "contact_limit_reached", 409);
		}

		const rows = await client.unsafe<ContactRow>(`
			INSERT INTO workspace_contacts
				(owner_user_id, contact_user_id, email, display_name, relationship, suggested_role)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (owner_user_id, COALESCE(contact_user_id, ''), COALESCE(email, ''))
			DO UPDATE SET
				contact_user_id = COALESCE(EXCLUDED.contact_user_id, workspace_contacts.contact_user_id),
				email = COALESCE(EXCLUDED.email, workspace_contacts.email),
				display_name = COALESCE(EXCLUDED.display_name, workspace_contacts.display_name),
				relationship = EXCLUDED.relationship,
				suggested_role = COALESCE(EXCLUDED.suggested_role, workspace_contacts.suggested_role),
				updated_at = now()
			RETURNING id, owner_user_id, contact_user_id, email, display_name, relationship, suggested_role, created_at, updated_at
		`, [
			validated.ownerUserId,
			validated.contactUserId ?? null,
			validated.email ?? null,
			validated.displayName ?? null,
			validated.relationship ?? "friend",
			validated.suggestedRole ?? null,
		]);
		const row = rows[0];
		if (!row) throw new WorkspaceContactError("Failed to persist contact", "contact_create_failed", 500);
		return mapRow(row);
	}

	async delete(ownerUserId: string, contactId: string): Promise<boolean> {
		const owner = ownerUserId.trim();
		const id = contactId.trim();
		if (!owner || !id) return false;
		const rows = await this.client.unsafe<{ id: string }>(`
			DELETE FROM workspace_contacts
			WHERE owner_user_id = $1 AND id = $2::uuid
			RETURNING id
		`, [owner, id]);
		return rows.length > 0;
	}

	// Run `fn` inside a single transaction. Prefers the driver's native begin()
	// (Bun.SQL exposes it) so the advisory lock + count + insert share ONE
	// connection — pg_advisory_xact_lock is connection-scoped and auto-released on
	// commit/rollback. Falls back to manual BEGIN/COMMIT/ROLLBACK for clients
	// without begin(). Mirrors PostgresWorkspaceAccessStore.transaction().
	private async transaction<T>(fn: (client: ContactSqlClient) => Promise<T>): Promise<T> {
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

function resolveStoreMode(): "file" | "postgres" {
	const override = process.env.WORKSPACE_CONTACTS_STORE?.trim().toLowerCase();
	if (override === "postgres") return "postgres";
	if (override === "file") return "file";
	return serverConfig.billingStore === "postgres" ? "postgres" : "file";
}

export function createWorkspaceContactStore(): WorkspaceContactStore {
	if (resolveStoreMode() === "postgres") {
		return new PostgresWorkspaceContactStore();
	}
	return new FileWorkspaceContactStore(join(DATA_DIR, "workspace-contacts.json"));
}

export const workspaceContactStore: WorkspaceContactStore = createWorkspaceContactStore();
