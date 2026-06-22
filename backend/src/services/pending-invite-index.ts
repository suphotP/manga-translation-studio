// Pending chapter-team invite INDEX — the bounded, indexed replacement for the
// global disk scan GET /api/project/my/invites used to do (codex P1, PR #394).
//
// PROBLEM: the old endpoint called readdirSync(PROJECTS_DIR) and parsed up to 5000
// state.json files on EVERY request to find which chapters had a pending EMAIL
// invite addressed to the caller's verified email. That is event-loop-blocking read
// amplification (the per-IP rate limit doesn't bound the per-request scan cost), and
// it silently missed invites past the 5000-file cap.
//
// FIX: maintain a per-email index keyed by the NORMALIZED invitee email. Each entry
// is one pending email invite (projectId + role + inviter + chapter label + when).
// The index is rebuilt for a project on EVERY project state write (invite create,
// accept, remove/revoke all flow through writeProjectState → syncProject), so a
// pending invite appears on create and disappears on accept/remove. GET /my/invites
// then does an O(matches) point lookup by the caller's verified email — NO scan.
//
// Dual backing store mirroring workspace-contacts.ts / project-catalog.ts:
//   - File mode: a single JSON snapshot under DATA_DIR (a map projectId → entries[]),
//     loaded once with an in-memory email index for O(matches) lookup.
//   - Postgres mode: the `project_pending_invites` table (migration 0073), one row
//     per pending invite, looked up by the `project_pending_invites_email_idx`.
// The store mode tracks projectCatalogStore (the index is catalog-adjacent state).
//
// Security: an entry carries ONLY what the invitee needs to recognize + accept the
// invite. The lookup is keyed by the caller's authoritative VERIFIED email only, so
// it can never disclose roster contents or another user's invites.

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import type { ChapterTeamRole } from "../types/index.js";

// One indexed pending-invite entry. `inviteeEmail` is ALREADY normalized (trimmed +
// lowercased) so the lookup is a plain equality match.
export interface PendingInviteEntry {
	memberId: string;
	projectId: string;
	inviteeEmail: string;
	role: ChapterTeamRole;
	invitedBy?: string;
	chapterLabel?: string;
	storyTitle?: string;
	invitedAt: string;
}

export interface PendingInviteIndexStore {
	/**
	 * Replace ALL index entries for one project with the supplied set (the project's
	 * CURRENT pending email invites). This is set-replace, not append: an invite that
	 * was accepted/removed since the last sync simply isn't in `entries`, so its row
	 * is dropped. Idempotent — re-syncing the same set is a no-op-equivalent.
	 */
	syncProject(projectId: string, entries: PendingInviteEntry[]): Promise<void>;
	/** Drop every entry for a project (on hard project delete). */
	removeProject(projectId: string): Promise<void>;
	/**
	 * Bounded indexed lookup of every pending invite addressed to `email` (already
	 * normalized by the caller), newest first. NO global scan. `limit` caps the worst
	 * case for a pathological address invited to a huge number of chapters.
	 */
	listForEmail(email: string, limit?: number): Promise<PendingInviteEntry[]>;
}

// Hard cap on how many invites a single lookup returns — a defense bound so a
// pathological email invited to a huge number of chapters can't return an unbounded
// payload. Well above any realistic invitee fan-in.
export const MAX_PENDING_INVITES_PER_EMAIL = 500;

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function sanitizeEntry(projectId: string, entry: PendingInviteEntry): PendingInviteEntry | null {
	const memberId = entry.memberId?.trim();
	const inviteeEmail = normalizeEmail(entry.inviteeEmail ?? "");
	if (!memberId || !inviteeEmail) return null;
	return {
		memberId,
		projectId,
		inviteeEmail,
		role: entry.role,
		invitedBy: entry.invitedBy?.trim() || undefined,
		chapterLabel: entry.chapterLabel,
		storyTitle: entry.storyTitle,
		invitedAt: entry.invitedAt,
	};
}

// ── File store ────────────────────────────────────────────────────────────────
// Persists a map projectId → entries[]; an in-memory email index gives O(matches)
// lookups without re-parsing the snapshot per request.
export class FilePendingInviteIndexStore implements PendingInviteIndexStore {
	private byProject = new Map<string, PendingInviteEntry[]>();
	private byEmail = new Map<string, PendingInviteEntry[]>();

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const data = readJsonFile<Record<string, PendingInviteEntry[]>>(this.persistPath);
			if (data && typeof data === "object") {
				for (const [projectId, entries] of Object.entries(data)) {
					if (!Array.isArray(entries)) continue;
					const clean = entries
						.map((entry) => sanitizeEntry(projectId, entry))
						.filter((entry): entry is PendingInviteEntry => entry !== null);
					if (clean.length > 0) this.byProject.set(projectId, clean);
				}
			}
		} catch {
			this.byProject = new Map();
		}
		this.rebuildEmailIndex();
	}

	private rebuildEmailIndex(): void {
		this.byEmail = new Map();
		for (const entries of this.byProject.values()) {
			for (const entry of entries) {
				const bucket = this.byEmail.get(entry.inviteeEmail);
				if (bucket) bucket.push(entry);
				else this.byEmail.set(entry.inviteeEmail, [entry]);
			}
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		const snapshot: Record<string, PendingInviteEntry[]> = {};
		for (const [projectId, entries] of this.byProject) snapshot[projectId] = entries;
		writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2));
	}

	async syncProject(projectId: string, entries: PendingInviteEntry[]): Promise<void> {
		const id = projectId.trim();
		if (!id) return;
		const clean = entries
			.map((entry) => sanitizeEntry(id, entry))
			.filter((entry): entry is PendingInviteEntry => entry !== null);
		if (clean.length === 0) this.byProject.delete(id);
		else this.byProject.set(id, clean);
		this.rebuildEmailIndex();
		this.persist();
	}

	async removeProject(projectId: string): Promise<void> {
		const id = projectId.trim();
		if (!id || !this.byProject.has(id)) return;
		this.byProject.delete(id);
		this.rebuildEmailIndex();
		this.persist();
	}

	async listForEmail(email: string, limit = MAX_PENDING_INVITES_PER_EMAIL): Promise<PendingInviteEntry[]> {
		const normalized = normalizeEmail(email);
		if (!normalized) return [];
		const bucket = this.byEmail.get(normalized);
		if (!bucket || bucket.length === 0) return [];
		return [...bucket]
			.sort((a, b) => b.invitedAt.localeCompare(a.invitedAt))
			.slice(0, Math.max(0, limit))
			.map((entry) => ({ ...entry }));
	}
}

// ── Postgres store ──────────────────────────────────────────────────────────────
export interface PendingInviteSqlClient {
	unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: PendingInviteSqlClient) => Promise<T>): Promise<T>;
}

interface PendingInviteRow {
	member_id: string;
	project_id: string;
	invitee_email: string;
	role: string;
	invited_by: string | null;
	chapter_label: string | null;
	story_title: string | null;
	invited_at: string | Date;
}

function mapRow(row: PendingInviteRow): PendingInviteEntry {
	return {
		memberId: row.member_id,
		projectId: row.project_id,
		inviteeEmail: row.invitee_email,
		role: row.role as ChapterTeamRole,
		invitedBy: row.invited_by ?? undefined,
		chapterLabel: row.chapter_label ?? undefined,
		storyTitle: row.story_title ?? undefined,
		invitedAt: new Date(row.invited_at).toISOString(),
	};
}

export class PostgresPendingInviteIndexStore implements PendingInviteIndexStore {
	private readonly client: PendingInviteSqlClient;

	constructor(databaseUrlOrClient: string | PendingInviteSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PROJECT_CATALOG_STORE=postgres requires DATABASE_URL for the pending-invite index");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as PendingInviteSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async syncProject(projectId: string, entries: PendingInviteEntry[]): Promise<void> {
		const id = projectId.trim();
		if (!id) return;
		const clean = entries
			.map((entry) => sanitizeEntry(id, entry))
			.filter((entry): entry is PendingInviteEntry => entry !== null);
		await this.transaction(async (tx) => {
			// Set-replace: drop rows for members no longer pending, then upsert the
			// current set. Deleting the complement (NOT IN the kept ids) clears accepted /
			// removed invites without a separate per-member delete call.
			const keepIds = clean.map((entry) => entry.memberId);
			if (keepIds.length === 0) {
				await tx.unsafe(`DELETE FROM project_pending_invites WHERE project_id = $1`, [id]);
				return;
			}
			const placeholders = keepIds.map((_, index) => `$${index + 2}`).join(", ");
			await tx.unsafe(
				`DELETE FROM project_pending_invites WHERE project_id = $1 AND member_id NOT IN (${placeholders})`,
				[id, ...keepIds],
			);
			for (const entry of clean) {
				await tx.unsafe(`
					INSERT INTO project_pending_invites
						(member_id, project_id, invitee_email, role, invited_by, chapter_label, story_title, invited_at, updated_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
					ON CONFLICT (project_id, member_id) DO UPDATE SET
						invitee_email = EXCLUDED.invitee_email,
						role = EXCLUDED.role,
						invited_by = EXCLUDED.invited_by,
						chapter_label = EXCLUDED.chapter_label,
						story_title = EXCLUDED.story_title,
						invited_at = EXCLUDED.invited_at,
						updated_at = now()
				`, [
					entry.memberId,
					id,
					entry.inviteeEmail,
					entry.role,
					entry.invitedBy ?? null,
					entry.chapterLabel ?? null,
					entry.storyTitle ?? null,
					entry.invitedAt,
				]);
			}
		});
	}

	async removeProject(projectId: string): Promise<void> {
		const id = projectId.trim();
		if (!id) return;
		// The table FK is ON DELETE CASCADE, so a hard project-row delete already drops
		// these rows; this explicit call covers callers that delete the index ahead of
		// (or instead of) the catalog row, and is idempotent.
		await this.client.unsafe(`DELETE FROM project_pending_invites WHERE project_id = $1`, [id]);
	}

	async listForEmail(email: string, limit = MAX_PENDING_INVITES_PER_EMAIL): Promise<PendingInviteEntry[]> {
		const normalized = normalizeEmail(email);
		if (!normalized) return [];
		const cap = Math.max(0, Math.min(limit, MAX_PENDING_INVITES_PER_EMAIL));
		if (cap === 0) return [];
		const rows = await this.client.unsafe<PendingInviteRow>(`
			SELECT member_id, project_id, invitee_email, role, invited_by, chapter_label, story_title, invited_at
			FROM project_pending_invites
			WHERE invitee_email = $1
			ORDER BY invited_at DESC, member_id DESC
			LIMIT ${cap}
		`, [normalized]);
		return rows.map(mapRow);
	}

	private async transaction<T>(fn: (client: PendingInviteSqlClient) => Promise<T>): Promise<T> {
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

export function createPendingInviteIndexStore(): PendingInviteIndexStore {
	if (serverConfig.projectCatalogStore === "postgres") {
		return new PostgresPendingInviteIndexStore();
	}
	return new FilePendingInviteIndexStore(join(DATA_DIR, "pending-invite-index.json"));
}

export const pendingInviteIndexStore: PendingInviteIndexStore = createPendingInviteIndexStore();

/**
 * Derive the current pending email-invite index entries for a project from its
 * chapter team. A member is indexable IFF it is a pending, account-UNLINKED email
 * invite — EXACTLY the shape acceptChapterTeamInvite() claims and the old scan
 * matched. Active/linked rows are existing access (surfaced by the Library), not a
 * pending invite, so they are excluded; accepting or removing an invite drops it
 * from this derived set, which set-replace then prunes from the index.
 */
export function derivePendingInviteEntries(state: {
	projectId: string;
	chapterTeam?: Array<{
		id: string;
		userId?: string;
		email?: string;
		role: ChapterTeamRole;
		status: string;
		invitedBy?: string;
		createdAt: string;
	}>;
	chapterLabel?: string;
	storyTitle?: string;
	name?: string;
}): PendingInviteEntry[] {
	const team = Array.isArray(state.chapterTeam) ? state.chapterTeam : [];
	const chapterLabel = (state.chapterLabel ?? state.storyTitle ?? state.name ?? "a chapter").trim() || "a chapter";
	const entries: PendingInviteEntry[] = [];
	for (const member of team) {
		if (member.status !== "pending" || member.userId) continue;
		const email = member.email?.trim().toLowerCase();
		if (!email) continue;
		entries.push({
			memberId: member.id,
			projectId: state.projectId,
			inviteeEmail: email,
			role: member.role,
			invitedBy: member.invitedBy,
			chapterLabel,
			storyTitle: state.storyTitle,
			invitedAt: member.createdAt,
		});
	}
	return entries;
}
