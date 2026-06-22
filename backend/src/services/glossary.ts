import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";
import { GLOSSARY_DIR } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";

/**
 * Per-workspace translation glossary.
 *
 * Stores canonical `term -> translation` pairs scoped to a workspace and a
 * target language, optionally narrowed to a single pipeline role and/or a
 * single project. Powers inline translator suggestions: `lookup` returns the
 * subset of a workspace's glossary whose terms actually appear in a given run
 * of text.
 *
 * Mirrors the file|postgres seam used by auth, the asset registry, and the
 * usage ledger: a JSON-on-disk fallback when DATABASE_URL is unset, and a
 * Postgres store otherwise. `workspaceId` is the hard isolation boundary in
 * both modes — no read or write ever crosses workspaces.
 */

export const GLOSSARY_ROLE_SCOPES = ["translator", "cleaner", "typesetter", "qc"] as const;
export type GlossaryRoleScope = (typeof GLOSSARY_ROLE_SCOPES)[number];

export const MAX_GLOSSARY_TERM_LENGTH = 200;
export const MAX_GLOSSARY_TRANSLATION_LENGTH = 1000;
export const MAX_GLOSSARY_NOTES_LENGTH = 2000;
export const MAX_GLOSSARY_TARGET_LANG_LENGTH = 32;
/** Cap on terms scanned per `lookup` to keep inline matching bounded. */
export const MAX_GLOSSARY_LOOKUP_TEXT_LENGTH = 20000;

export interface GlossaryEntry {
	id: string;
	workspaceId: string;
	term: string;
	translation: string;
	targetLang: string;
	notes?: string;
	roleScope?: GlossaryRoleScope;
	projectId?: string;
	createdBy?: string;
	createdAt: string;
	updatedAt: string;
}

export interface GlossaryListFilter {
	targetLang?: string;
	roleScope?: GlossaryRoleScope;
	projectId?: string;
}

export interface GlossaryCreateInput {
	workspaceId: string;
	term: string;
	translation: string;
	targetLang: string;
	notes?: string;
	roleScope?: GlossaryRoleScope;
	projectId?: string;
	createdBy?: string;
}

export interface GlossaryUpdateInput {
	term?: string;
	translation?: string;
	targetLang?: string;
	notes?: string | null;
	roleScope?: GlossaryRoleScope | null;
	projectId?: string | null;
}

export interface GlossaryLookupOptions {
	roleScope?: GlossaryRoleScope;
	projectId?: string;
}

export interface GlossaryMatch {
	entry: GlossaryEntry;
	/** Number of occurrences of the term within the supplied text. */
	count: number;
}

export class GlossaryError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "glossary_error") {
		super(message);
	}
}

export interface GlossaryStore {
	list(workspaceId: string, filter?: GlossaryListFilter): Promise<GlossaryEntry[]>;
	get(workspaceId: string, id: string): Promise<GlossaryEntry | null>;
	create(input: GlossaryCreateInput): Promise<GlossaryEntry>;
	update(workspaceId: string, id: string, updates: GlossaryUpdateInput): Promise<GlossaryEntry | null>;
	delete(workspaceId: string, id: string): Promise<boolean>;
	lookup(workspaceId: string, text: string, targetLang: string, options?: GlossaryLookupOptions): Promise<GlossaryMatch[]>;
}

export interface GlossarySqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

export function isGlossaryRoleScope(value: unknown): value is GlossaryRoleScope {
	return typeof value === "string" && (GLOSSARY_ROLE_SCOPES as readonly string[]).includes(value);
}

function requireField(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") {
		throw new GlossaryError(`${field} is required`, 400, "glossary_invalid_input");
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new GlossaryError(`${field} is required`, 400, "glossary_invalid_input");
	}
	if (trimmed.length > max) {
		throw new GlossaryError(`${field} exceeds ${max} characters`, 400, "glossary_invalid_input");
	}
	return trimmed;
}

function normalizeOptional(value: unknown, field: string, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new GlossaryError(`${field} must be a string`, 400, "glossary_invalid_input");
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > max) {
		throw new GlossaryError(`${field} exceeds ${max} characters`, 400, "glossary_invalid_input");
	}
	return trimmed;
}

function normalizeRoleScopeInput(value: unknown): GlossaryRoleScope | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (!isGlossaryRoleScope(value)) {
		throw new GlossaryError("roleScope must be one of translator/cleaner/typesetter/qc", 400, "glossary_invalid_input");
	}
	return value;
}

function normalizeWorkspaceId(workspaceId: string): string {
	const trimmed = typeof workspaceId === "string" ? workspaceId.trim() : "";
	if (!trimmed) {
		throw new GlossaryError("workspaceId is required", 400, "glossary_invalid_input");
	}
	return trimmed;
}

function validateCreate(input: GlossaryCreateInput): GlossaryEntry {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		workspaceId: normalizeWorkspaceId(input.workspaceId),
		term: requireField(input.term, "term", MAX_GLOSSARY_TERM_LENGTH),
		translation: requireField(input.translation, "translation", MAX_GLOSSARY_TRANSLATION_LENGTH),
		targetLang: requireField(input.targetLang, "targetLang", MAX_GLOSSARY_TARGET_LANG_LENGTH),
		notes: normalizeOptional(input.notes, "notes", MAX_GLOSSARY_NOTES_LENGTH),
		roleScope: normalizeRoleScopeInput(input.roleScope),
		projectId: normalizeOptional(input.projectId, "projectId", 200),
		createdBy: normalizeOptional(input.createdBy, "createdBy", 200),
		createdAt: now,
		updatedAt: now,
	};
}

function applyUpdates(entry: GlossaryEntry, updates: GlossaryUpdateInput): GlossaryEntry {
	const next: GlossaryEntry = { ...entry };
	if (updates.term !== undefined) next.term = requireField(updates.term, "term", MAX_GLOSSARY_TERM_LENGTH);
	if (updates.translation !== undefined) {
		next.translation = requireField(updates.translation, "translation", MAX_GLOSSARY_TRANSLATION_LENGTH);
	}
	if (updates.targetLang !== undefined) {
		next.targetLang = requireField(updates.targetLang, "targetLang", MAX_GLOSSARY_TARGET_LANG_LENGTH);
	}
	if (updates.notes !== undefined) next.notes = normalizeOptional(updates.notes, "notes", MAX_GLOSSARY_NOTES_LENGTH);
	if (updates.roleScope !== undefined) next.roleScope = normalizeRoleScopeInput(updates.roleScope);
	if (updates.projectId !== undefined) next.projectId = normalizeOptional(updates.projectId, "projectId", 200);
	next.updatedAt = new Date().toISOString();
	return next;
}

// ---------------------------------------------------------------------------
// In-text matching (shared by both stores)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Counts occurrences of `term` inside `text`, case-insensitively.
 *
 * Latin/ASCII-word terms (e.g. "cat", "big boss") use word-boundary matching so
 * "cat" does not match inside "concatenate". Terms containing scripts that do
 * not separate words with spaces — CJK, Thai, etc. — and terms with punctuation
 * fall back to plain substring matching, because `\b`-style boundaries are
 * meaningless there and would wrongly drop a 猫 sitting between two kanji.
 */
export function countTermOccurrences(text: string, term: string): number {
	const trimmed = term.trim();
	if (!trimmed) return 0;
	const escaped = escapeRegExp(trimmed);
	// Word-boundary matching only when every character is a Latin letter (incl.
	// accented forms like "café"/"São"), digit, underscore, or internal space —
	// anything else (CJK/Thai scripts without word spacing, punctuation) is
	// matched as a substring, where `\b`-style boundaries are meaningless.
	const wordy = /^[\p{Script=Latin}0-9_]+(?: [\p{Script=Latin}0-9_]+)*$/u.test(trimmed);
	const pattern = wordy
		? new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu")
		: new RegExp(escaped, "giu");
	const matches = text.match(pattern);
	return matches ? matches.length : 0;
}

function filterByScope(entries: GlossaryEntry[], options?: GlossaryLookupOptions): GlossaryEntry[] {
	const role = options?.roleScope;
	const projectId = options?.projectId;
	return entries.filter((entry) => {
		// An entry narrowed to a role only applies when that role is requested.
		if (entry.roleScope && entry.roleScope !== role) return false;
		// An entry narrowed to a project only applies when that project is requested.
		if (entry.projectId && entry.projectId !== projectId) return false;
		return true;
	});
}

/**
 * The exact text the matcher scans: input truncated to the lookup cap. Shared by
 * both stores AND by the Postgres prefilter bind so the SQL `position()` filter
 * sees the identical haystack the JS matcher does — guaranteeing the SQL-bounded
 * candidate set is a faithful superset of the JS matches (never dropping a real
 * match).
 */
function lookupHaystack(text: string): string {
	return text.slice(0, MAX_GLOSSARY_LOOKUP_TEXT_LENGTH);
}

function matchEntriesInText(entries: GlossaryEntry[], haystack: string): GlossaryMatch[] {
	const matches: GlossaryMatch[] = [];
	for (const entry of entries) {
		const count = countTermOccurrences(haystack, entry.term);
		if (count > 0) matches.push({ entry, count });
	}
	// Longer terms first so multi-word phrases surface above their fragments.
	matches.sort((a, b) => b.entry.term.length - a.entry.term.length || a.entry.term.localeCompare(b.entry.term));
	return matches;
}

// ---------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------

export class FileGlossaryStore implements GlossaryStore {
	constructor(private readonly baseDir = GLOSSARY_DIR) {
		mkdirSync(this.baseDir, { recursive: true });
	}

	async list(workspaceId: string, filter: GlossaryListFilter = {}): Promise<GlossaryEntry[]> {
		const entries = this.readWorkspace(normalizeWorkspaceId(workspaceId));
		return entries
			.filter((entry) => {
				if (filter.targetLang && entry.targetLang !== filter.targetLang) return false;
				if (filter.roleScope && entry.roleScope !== filter.roleScope) return false;
				if (filter.projectId && entry.projectId !== filter.projectId) return false;
				return true;
			})
			.sort((a, b) => a.term.localeCompare(b.term) || a.targetLang.localeCompare(b.targetLang));
	}

	async get(workspaceId: string, id: string): Promise<GlossaryEntry | null> {
		const entries = this.readWorkspace(normalizeWorkspaceId(workspaceId));
		return entries.find((entry) => entry.id === id) ?? null;
	}

	async create(input: GlossaryCreateInput): Promise<GlossaryEntry> {
		const entry = validateCreate(input);
		const entries = this.readWorkspace(entry.workspaceId);
		const conflictIndex = entries.findIndex(
			(candidate) => candidate.term === entry.term && candidate.targetLang === entry.targetLang,
		);
		if (conflictIndex >= 0) {
			// Match Postgres ON CONFLICT (workspace_id, term, target_lang): upsert.
			const merged: GlossaryEntry = {
				...entry,
				id: entries[conflictIndex]!.id,
				createdAt: entries[conflictIndex]!.createdAt,
				createdBy: entries[conflictIndex]!.createdBy ?? entry.createdBy,
			};
			entries[conflictIndex] = merged;
			this.writeWorkspace(entry.workspaceId, entries);
			return merged;
		}
		entries.push(entry);
		this.writeWorkspace(entry.workspaceId, entries);
		return entry;
	}

	async update(workspaceId: string, id: string, updates: GlossaryUpdateInput): Promise<GlossaryEntry | null> {
		const ws = normalizeWorkspaceId(workspaceId);
		const entries = this.readWorkspace(ws);
		const index = entries.findIndex((entry) => entry.id === id);
		if (index < 0) return null;
		const next = applyUpdates(entries[index]!, updates);
		const conflict = entries.find(
			(entry) => entry.id !== id && entry.term === next.term && entry.targetLang === next.targetLang,
		);
		if (conflict) {
			throw new GlossaryError("Another glossary entry already uses this term for that language", 409, "glossary_conflict");
		}
		entries[index] = next;
		this.writeWorkspace(ws, entries);
		return next;
	}

	async delete(workspaceId: string, id: string): Promise<boolean> {
		const ws = normalizeWorkspaceId(workspaceId);
		const entries = this.readWorkspace(ws);
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length === entries.length) return false;
		this.writeWorkspace(ws, next);
		return true;
	}

	async lookup(
		workspaceId: string,
		text: string,
		targetLang: string,
		options?: GlossaryLookupOptions,
	): Promise<GlossaryMatch[]> {
		const lang = requireField(targetLang, "targetLang", MAX_GLOSSARY_TARGET_LANG_LENGTH);
		if (typeof text !== "string" || !text.trim()) return [];
		const haystack = lookupHaystack(text);
		const entries = this.readWorkspace(normalizeWorkspaceId(workspaceId)).filter((entry) => entry.targetLang === lang);
		return matchEntriesInText(filterByScope(entries, options), haystack);
	}

	private readWorkspace(workspaceId: string): GlossaryEntry[] {
		const filePath = this.workspacePath(workspaceId);
		if (!existsSync(filePath)) return [];
		let raw: unknown;
		try {
			raw = readJsonFile<unknown>(filePath);
		} catch (error) {
			// A malformed or temporarily unreadable file must NOT look like an empty
			// workspace: returning [] here would let the next create()/update()
			// overwrite the file and silently lose every existing entry. Surface the
			// failure instead so the file is preserved for recovery.
			throw new GlossaryError(
				`Glossary store for this workspace is unreadable (${(error as Error).message ?? "parse error"})`,
				503,
				"glossary_store_unreadable",
			);
		}
		if (!Array.isArray(raw)) {
			throw new GlossaryError(
				"Glossary store for this workspace is corrupt (expected a JSON array)",
				503,
				"glossary_store_unreadable",
			);
		}
		// Defensive: never let a tampered file leak another workspace's rows.
		return (raw as GlossaryEntry[]).filter((entry) => entry && entry.workspaceId === workspaceId);
	}

	private writeWorkspace(workspaceId: string, entries: GlossaryEntry[]): void {
		writeFileSync(this.workspacePath(workspaceId), JSON.stringify(entries, null, 2));
	}

	private workspacePath(workspaceId: string): string {
		// Encode the workspace id so it can never escape the glossary directory.
		return join(this.baseDir, `${encodeURIComponent(workspaceId)}.json`);
	}
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

interface GlossaryRow {
	id: string;
	workspace_id: string;
	term: string;
	translation: string;
	target_lang: string;
	notes: string | null;
	role_scope: string | null;
	project_id: string | null;
	created_by: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

const GLOSSARY_COLUMNS =
	"id, workspace_id, term, translation, target_lang, notes, role_scope, project_id, created_by, created_at, updated_at";

export class PostgresGlossaryStore implements GlossaryStore {
	private readonly client: GlossarySqlClient;

	constructor(databaseUrlOrClient: string | GlossarySqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PostgresGlossaryStore requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as GlossarySqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async list(workspaceId: string, filter: GlossaryListFilter = {}): Promise<GlossaryEntry[]> {
		const ws = normalizeWorkspaceId(workspaceId);
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [ws];
		if (filter.targetLang) {
			params.push(filter.targetLang);
			conditions.push(`target_lang = $${params.length}`);
		}
		if (filter.roleScope) {
			params.push(filter.roleScope);
			conditions.push(`role_scope = $${params.length}`);
		}
		if (filter.projectId) {
			params.push(filter.projectId);
			conditions.push(`project_id = $${params.length}`);
		}
		const rows = await this.client.unsafe<GlossaryRow>(
			`SELECT ${GLOSSARY_COLUMNS} FROM glossary_entries WHERE ${conditions.join(" AND ")} ORDER BY lower(term), target_lang`,
			params,
		);
		return rows.map(mapGlossaryRow);
	}

	async get(workspaceId: string, id: string): Promise<GlossaryEntry | null> {
		const ws = normalizeWorkspaceId(workspaceId);
		const rows = await this.client.unsafe<GlossaryRow>(
			`SELECT ${GLOSSARY_COLUMNS} FROM glossary_entries WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
			[ws, id],
		);
		return rows[0] ? mapGlossaryRow(rows[0]) : null;
	}

	async create(input: GlossaryCreateInput): Promise<GlossaryEntry> {
		const entry = validateCreate(input);
		const rows = await this.client.unsafe<GlossaryRow>(
			`INSERT INTO glossary_entries (${GLOSSARY_COLUMNS})
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				ON CONFLICT (workspace_id, term, target_lang) DO UPDATE SET
					translation = EXCLUDED.translation,
					notes = EXCLUDED.notes,
					role_scope = EXCLUDED.role_scope,
					project_id = EXCLUDED.project_id,
					updated_at = EXCLUDED.updated_at
				RETURNING ${GLOSSARY_COLUMNS}`,
			[
				entry.id,
				entry.workspaceId,
				entry.term,
				entry.translation,
				entry.targetLang,
				entry.notes ?? null,
				entry.roleScope ?? null,
				entry.projectId ?? null,
				entry.createdBy ?? null,
				entry.createdAt,
				entry.updatedAt,
			],
		);
		return mapGlossaryRow(rows[0]!);
	}

	async update(workspaceId: string, id: string, updates: GlossaryUpdateInput): Promise<GlossaryEntry | null> {
		const ws = normalizeWorkspaceId(workspaceId);
		const existing = await this.get(ws, id);
		if (!existing) return null;
		const next = applyUpdates(existing, updates);
		try {
			const rows = await this.client.unsafe<GlossaryRow>(
				`UPDATE glossary_entries SET
					term = $3, translation = $4, target_lang = $5, notes = $6,
					role_scope = $7, project_id = $8, updated_at = $9
				WHERE workspace_id = $1 AND id = $2
				RETURNING ${GLOSSARY_COLUMNS}`,
				[
					ws,
					id,
					next.term,
					next.translation,
					next.targetLang,
					next.notes ?? null,
					next.roleScope ?? null,
					next.projectId ?? null,
					next.updatedAt,
				],
			);
			return rows[0] ? mapGlossaryRow(rows[0]) : null;
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new GlossaryError("Another glossary entry already uses this term for that language", 409, "glossary_conflict");
			}
			throw error;
		}
	}

	async delete(workspaceId: string, id: string): Promise<boolean> {
		const ws = normalizeWorkspaceId(workspaceId);
		const rows = await this.client.unsafe<{ id: string }>(
			"DELETE FROM glossary_entries WHERE workspace_id = $1 AND id = $2 RETURNING id",
			[ws, id],
		);
		return rows.length > 0;
	}

	async lookup(
		workspaceId: string,
		text: string,
		targetLang: string,
		options?: GlossaryLookupOptions,
	): Promise<GlossaryMatch[]> {
		const ws = normalizeWorkspaceId(workspaceId);
		const lang = requireField(targetLang, "targetLang", MAX_GLOSSARY_TARGET_LANG_LENGTH);
		if (typeof text !== "string" || !text.trim()) return [];
		const haystack = lookupHaystack(text);
		// Bound the candidate set in SQL instead of loading the ENTIRE workspace+lang
		// glossary on every translation request. `position(lower(term) IN lower($3))`
		// returns only entries whose term is a case-insensitive substring of the
		// supplied text. Word-boundary/CJK matching is strictly *narrower* than
		// substring matching, so this prefilter is a faithful superset of the JS
		// matches: no real match can be excluded. The final word-boundary/CJK count
		// is still computed in JS so results are byte-for-byte identical to the file
		// store. $3 is the SAME truncated haystack the JS matcher scans (lookupHaystack)
		// so SQL and JS agree on what "appears in the text" means.
		//
		// The role/project SCOPE filter is pushed into SQL too (mirroring filterByScope):
		// an entry narrowed to a role/project only applies when that exact role/project is
		// requested; role-less / project-less entries always apply. Equality against a
		// NULL bind is never true in SQL, so when no role/project is requested only the
		// unscoped (NULL) rows survive — identical to filterByScope's `entry.roleScope &&
		// entry.roleScope !== role` test. Filtering scope in SQL is what makes the
		// substring prefilter a sufficient bound on its own: NO truncating LIMIT is
		// applied, so a real in-scope match can never be dropped by a row cap (the round-3
		// P1a regression). The substring/position() prefilter already bounds the result to
		// terms that actually substring-match the (truncated) input text — a naturally
		// small set, no full-glossary load — so the lookup remains memory-bounded without
		// a cap. workspace+lang equality stays index-served by
		// glossary_entries_workspace_lang_idx.
		const rows = await this.client.unsafe<GlossaryRow>(
			`SELECT ${GLOSSARY_COLUMNS} FROM glossary_entries
				WHERE workspace_id = $1 AND target_lang = $2
					AND position(lower(term) IN lower($3)) > 0
					AND (role_scope IS NULL OR role_scope = $4)
					AND (project_id IS NULL OR project_id = $5)
				ORDER BY length(term) DESC, lower(term)`,
			[ws, lang, haystack, options?.roleScope ?? null, options?.projectId ?? null],
		);
		// Compute the final word-boundary/CJK count in application code so the matching
		// logic is identical across both stores. The candidate set is already scoped to
		// one workspace+lang+role+project and prefiltered to substring-containing terms,
		// so filterByScope here is a no-op safety net (the SQL already enforced scope).
		return matchEntriesInText(filterByScope(rows.map(mapGlossaryRow), options), haystack);
	}
}

function mapGlossaryRow(row: GlossaryRow): GlossaryEntry {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		term: row.term,
		translation: row.translation,
		targetLang: row.target_lang,
		notes: row.notes ?? undefined,
		roleScope: isGlossaryRoleScope(row.role_scope) ? row.role_scope : undefined,
		projectId: row.project_id ?? undefined,
		createdBy: row.created_by ?? undefined,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

function isUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	if (code === "23505") return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message.includes("glossary_entries_workspace_term_lang_uniq");
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGlossaryStore(): GlossaryStore {
	if (process.env.DATABASE_URL?.trim()) {
		return new PostgresGlossaryStore();
	}
	return new FileGlossaryStore();
}

export const glossaryStore = createGlossaryStore();
