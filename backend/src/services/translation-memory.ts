// Wave 3 W3.6: Translation Memory (TM) — vector-fuzzy matching.
//
// Stores per-workspace source->target translation pairs together with a cached
// embedding of the source text. Search embeds ONLY the incoming query and ranks
// stored entries by cosine similarity against their cached embeddings, so we
// never re-embed stored rows on read (embedding cost stays bounded to one call
// per write + one call per search).
//
// Persistence is Postgres-backed (jsonb embedding column). The TM API is
// workspace-scoped, and workspace membership/authz lives ONLY in Postgres
// (workspaceAccessStore is null without DATABASE_URL), so there is no safe
// no-DB API mode: the routes correctly return 503 when the access store is
// absent. The factory therefore REQUIRES DATABASE_URL rather than wiring an
// in-memory store that the routes could never reach (a dead fallback).
//
// InMemoryTmStore still exists as a test seam: tests inject it directly into
// TranslationMemoryService (bypassing the factory + the workspace-access guard)
// to exercise ranking/isolation deterministically without a live database.
//
// Per-workspace isolation is enforced in BOTH stores — every read/write is
// keyed by workspace_id and search results can never cross a workspace.

import { getSharedBunSql } from "./sql-pool.js";
import { randomUUID } from "crypto";

export const TM_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Embedding dimensionality for TM_EMBEDDING_MODEL (text-embedding-3-small = 1536).
 * Must match the `vector(N)` declared by migration 0061 — a row whose cached
 * embedding length differs (e.g. a future model swap) is NOT pushed into the
 * native pgvector column (it would error on the typed cast); it keeps using the
 * jsonb + in-service cosine path.
 */
export const TM_EMBEDDING_DIMENSIONS = 1536;

/** ≥ EXACT_MATCH_THRESHOLD → "exact" badge. */
export const TM_EXACT_MATCH_THRESHOLD = 0.95;
/** ≥ SUGGESTION_THRESHOLD (and < exact) → "suggestion". Below → dropped. */
export const TM_SUGGESTION_THRESHOLD = 0.85;

const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
/** Cap stored/queried source text so a single entry can't blow up embedding cost. */
export const TM_MAX_TEXT_LENGTH = 4000;

/** Page size used to stream the full workspace+lang TM into the ranker. */
export const TM_CANDIDATE_PAGE_SIZE = 1000;
/**
 * Absolute ceiling on how many candidates we will rank for a single search, as a
 * safety valve against an unbounded TM OOMing the ranker. This is intentionally
 * large (the whole language-pair TM is normally well under it); it is NOT a
 * "newest N" window — candidates are streamed oldest-or-newest deterministically
 * so older exact matches are never silently dropped before ranking.
 */
export const TM_MAX_RANKED_CANDIDATES = 50_000;

export type TmMatchKind = "exact" | "suggestion";

export interface TmEntry {
	id: string;
	workspaceId: string;
	sourceText: string;
	sourceLang: string;
	targetText: string;
	targetLang: string;
	contextNote?: string;
	createdBy?: string;
	projectId?: string;
	createdAt: string;
}

/** A TM entry returned from search, annotated with its similarity + band. */
export interface TmSearchResult extends TmEntry {
	score: number;
	matchKind: TmMatchKind;
}

export interface TmAddInput {
	workspaceId: string;
	sourceText: string;
	sourceLang: string;
	targetText: string;
	targetLang: string;
	contextNote?: string;
	createdBy?: string;
	projectId?: string;
}

export interface TmSearchInput {
	workspaceId: string;
	sourceText: string;
	sourceLang: string;
	targetLang: string;
	limit?: number;
}

/**
 * Embeds text into a float vector. Pluggable so tests can inject a deterministic
 * embedder without network access or an API key.
 */
export type TmEmbedder = (text: string) => Promise<number[]>;

/** A semantic-search hit: a TM entry plus its cosine similarity to the query. */
export interface TmSemanticMatch {
	entry: TmEntry;
	score: number;
}

export interface TmStore {
	/** Persist a TM entry plus its precomputed source embedding. */
	add(input: TmAddInput, embedding: number[], embeddingModel: string): Promise<TmEntry>;
	/**
	 * Literal source-text matches for a workspace + language pair. This path is
	 * EMBEDDING-FREE (a plain equality lookup on the normalized source text), so it
	 * is the only TM tier that works when no OpenAI key is configured — and it is
	 * the authoritative "exact" hit that must ALWAYS win over fuzzy/semantic
	 * scores. Matching is exact after the same trim/length normalization applied at
	 * write time so a search for "hello" reliably finds a stored "  hello  ". It is
	 * independent of embeddings, so an unbackfilled row (NULL embedding_vec) that is
	 * a literal match can never be hidden by an empty native-vector result.
	 */
	findExactMatches(workspaceId: string, sourceLang: string, targetLang: string, sourceText: string): Promise<TmEntry[]>;
	/**
	 * Return all candidate entries for a workspace + language pair, each with its
	 * cached embedding. Ranking is done in the service so the store stays simple
	 * and DB-agnostic (cosine in SQL would require pgvector).
	 */
	listCandidates(workspaceId: string, sourceLang: string, targetLang: string): Promise<Array<{ entry: TmEntry; embedding: number[] }>>;
	/**
	 * OPTIONAL native pgvector tier. When implemented AND available at runtime,
	 * pushes the cosine ranking into Postgres ("ORDER BY embedding_vec <=> query
	 * LIMIT k") instead of streaming every candidate into the service. Returns
	 * null when the native vector path is unavailable (extension/column absent, or
	 * the dimensions don't match) so the service can fall back to listCandidates.
	 * Implementations MUST bind the query vector as a scalar `::vector` literal.
	 */
	semanticSearch?(
		workspaceId: string,
		sourceLang: string,
		targetLang: string,
		queryEmbedding: number[],
		limit: number,
	): Promise<TmSemanticMatch[] | null>;
}

export class TmError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "tm_error") {
		super(message);
	}
}

// ── Cosine similarity ────────────────────────────────────────────

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is empty or
 * zero-magnitude (degenerate), and when lengths differ (mismatched models).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		magA += x * x;
		magB += y * y;
	}
	if (magA === 0 || magB === 0) return 0;
	return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function bandForScore(score: number): TmMatchKind | null {
	if (score >= TM_EXACT_MATCH_THRESHOLD) return "exact";
	if (score >= TM_SUGGESTION_THRESHOLD) return "suggestion";
	return null;
}

// ── pgvector semantic tier (additive, flag-gated) ────────────────

/**
 * Master switch for the native pgvector semantic search tier. Default OFF: the
 * native-vector path only ever runs when this is explicitly enabled AND the
 * pgvector extension + embedding_vec column actually exist (probed at runtime)
 * AND an OpenAI key is configured (so the query can be embedded). When any of
 * those is missing the service degrades to the existing jsonb + in-service
 * cosine path — no crash, no behavior change.
 */
export function isTmSemanticEnabled(): boolean {
	const raw = process.env.TM_SEMANTIC_ENABLED?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Render a float array as a pgvector text literal: `[0.1,0.2,...]`. The result is
 * bound as a SCALAR string parameter and cast with `$n::vector` in SQL — we never
 * splice values into the SQL text and never rely on Bun.SQL binding a JS array
 * (which it cannot do for typed-array casts). Non-finite components are coerced to
 * 0 so a stray NaN/Infinity can never produce an invalid literal.
 */
export function toVectorLiteral(vector: number[]): string {
	const parts = vector.map((value) => (Number.isFinite(value) ? value : 0));
	return `[${parts.join(",")}]`;
}

// ── OpenAI embedder ──────────────────────────────────────────────

export function isOpenAiEmbeddingEnabled(): boolean {
	return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/**
 * Default embedder: OpenAI text-embedding-3-small. Throws (rather than silently
 * returning a zero vector) when no API key is configured so callers can surface
 * a clear "TM embeddings unavailable" error instead of writing useless rows.
 */
export async function embedWithOpenAi(text: string): Promise<number[]> {
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) {
		throw new TmError("Translation memory embeddings require OPENAI_API_KEY", 503, "tm_embeddings_unavailable");
	}
	let response: Response;
	try {
		response = await fetch(OPENAI_EMBEDDINGS_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: TM_EMBEDDING_MODEL,
				input: text.slice(0, TM_MAX_TEXT_LENGTH),
			}),
		});
	} catch {
		// Transport-level failure (DNS, connection reset, OpenAI unreachable). Surface
		// as a TmError so the route returns 503 instead of a generic 500 crash.
		throw new TmError("OpenAI embeddings provider is unreachable", 503, "tm_embeddings_unavailable");
	}
	if (!response.ok) {
		// NOTE: never echo the API key; only the status + provider body (which does
		// not contain the key) is surfaced.
		const detail = await response.text().catch(() => "");
		throw new TmError(`OpenAI embeddings error ${response.status}: ${detail}`, 502, "tm_embeddings_error");
	}
	let payload: { data?: Array<{ embedding?: number[] }> };
	try {
		payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
	} catch {
		// Malformed/non-JSON provider response — treat as a provider error, not a crash.
		throw new TmError("OpenAI embeddings response was not valid JSON", 502, "tm_embeddings_error");
	}
	const embedding = payload.data?.[0]?.embedding;
	if (!Array.isArray(embedding) || embedding.length === 0) {
		throw new TmError("OpenAI embeddings response did not include a vector", 502, "tm_embeddings_error");
	}
	return embedding;
}

// ── In-memory store (file/no-DB fallback) ────────────────────────

export class InMemoryTmStore implements TmStore {
	private readonly rows: Array<{ entry: TmEntry; embedding: number[] }> = [];

	async add(input: TmAddInput, embedding: number[], _embeddingModel: string): Promise<TmEntry> {
		const entry: TmEntry = {
			id: randomUUID(),
			workspaceId: input.workspaceId,
			sourceText: input.sourceText,
			sourceLang: input.sourceLang,
			targetText: input.targetText,
			targetLang: input.targetLang,
			contextNote: input.contextNote,
			createdBy: input.createdBy,
			projectId: input.projectId,
			createdAt: new Date().toISOString(),
		};
		// Defensive copy so callers mutating the array later can't corrupt the cache.
		this.rows.push({ entry, embedding: [...embedding] });
		return entry;
	}

	async findExactMatches(workspaceId: string, sourceLang: string, targetLang: string, sourceText: string): Promise<TmEntry[]> {
		// Embedding-free literal lookup: workspace + language pair + exact source
		// text (after the same trim/length normalization used at write/search time).
		const needle = sourceText.trim().slice(0, TM_MAX_TEXT_LENGTH);
		return this.rows
			.filter((row) =>
				row.entry.workspaceId === workspaceId
				&& row.entry.sourceLang === sourceLang
				&& row.entry.targetLang === targetLang
				&& row.entry.sourceText === needle)
			.map((row) => ({ ...row.entry }));
	}

	async listCandidates(workspaceId: string, sourceLang: string, targetLang: string): Promise<Array<{ entry: TmEntry; embedding: number[] }>> {
		// Workspace isolation: only rows for this workspace + language pair.
		return this.rows
			.filter((row) =>
				row.entry.workspaceId === workspaceId
				&& row.entry.sourceLang === sourceLang
				&& row.entry.targetLang === targetLang)
			.map((row) => ({ entry: { ...row.entry }, embedding: [...row.embedding] }));
	}

	/** Test/inspection helper: total rows across all workspaces. */
	size(): number {
		return this.rows.length;
	}
}

// ── Postgres store ───────────────────────────────────────────────

export interface TmSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface TmRow {
	id: string;
	workspace_id: string;
	source_text: string;
	source_lang: string;
	target_text: string;
	target_lang: string;
	embedding?: unknown;
	context_note?: string | null;
	created_by?: string | null;
	project_id?: string | null;
	created_at: Date | string;
}

export class PostgresTmStore implements TmStore {
	private readonly client: TmSqlClient;
	/**
	 * Cached probe of whether the native pgvector column (migration 0061) exists.
	 * `undefined` = not yet probed; once resolved it is reused for the process
	 * lifetime so we never pay the catalog lookup per request. When false, every
	 * native-vector path no-ops and the store behaves exactly like the 0038 jsonb
	 * store. We never CACHE a transient/connection error as a definitive `false`.
	 */
	private nativeVectorAvailable: boolean | undefined;

	constructor(databaseUrlOrClient: string | TmSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("Translation memory store requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as TmSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	/**
	 * Returns true when the `tm_entries.embedding_vec` pgvector column exists.
	 * Probed once via the catalog and cached. Any failure (column absent → the
	 * query returns no rows; or the catalog probe itself errors) resolves to
	 * false → the store stays on the jsonb path. The probe is a pure read against
	 * information_schema with scalar binds, so it is safe in every Postgres.
	 */
	private async hasNativeVector(): Promise<boolean> {
		if (this.nativeVectorAvailable !== undefined) return this.nativeVectorAvailable;
		try {
			const rows = await this.client.unsafe<{ exists: boolean | string | number }>(`
				SELECT EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_name = 'tm_entries' AND column_name = 'embedding_vec'
				) AS exists
			`);
			const value = rows[0]?.exists;
			this.nativeVectorAvailable = value === true || value === "t" || value === "true" || value === 1;
		} catch {
			// Catalog probe failed (unexpected). Do NOT poison future calls with a
			// definitive false — leave it unprobed so a later, healthy call can retry.
			return false;
		}
		return this.nativeVectorAvailable;
	}

	async add(input: TmAddInput, embedding: number[], embeddingModel: string): Promise<TmEntry> {
		const id = randomUUID();
		// Mirror the cached embedding into the native pgvector column when the
		// column exists AND the dimensions match the declared vector(N). When the
		// column is absent (no pgvector) or the model swapped dimensions, we leave
		// embedding_vec NULL and the row simply uses the jsonb cosine path.
		const useNative = embedding.length === TM_EMBEDDING_DIMENSIONS && (await this.hasNativeVector());
		const vectorColumn = useNative ? ", embedding_vec" : "";
		const params: unknown[] = [
			id,
			input.workspaceId,
			input.sourceText,
			input.sourceLang,
			input.targetText,
			input.targetLang,
			JSON.stringify(embedding),
			embeddingModel,
			input.contextNote ?? null,
			input.createdBy ?? null,
			input.projectId ?? null,
		];
		// Scalar `::vector` bind: the literal is a STRING param, never spliced into SQL.
		let vectorValue = "";
		if (useNative) {
			params.push(toVectorLiteral(embedding));
			vectorValue = `, $${params.length}::vector`;
		}
		const rows = await this.client.unsafe<TmRow>(`
			INSERT INTO tm_entries (
				id, workspace_id, source_text, source_lang, target_text, target_lang,
				embedding, embedding_model, context_note, created_by, project_id${vectorColumn}, created_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11${vectorValue}, now())
			RETURNING id, workspace_id, source_text, source_lang, target_text, target_lang,
				embedding, context_note, created_by, project_id, created_at
		`, params);
		const row = rows[0];
		if (!row) throw new TmError("Failed to persist translation memory entry", 500, "tm_write_failed");
		return mapTmRow(row);
	}

	/**
	 * Embedding-free literal source-text lookup (workspace + language pair). Plain
	 * SQL equality on `source_text` with scalar binds — no pgvector, no jsonb, no
	 * embedding — so it works even when OPENAI_API_KEY is absent and regardless of
	 * whether a row's embedding_vec was ever backfilled. These are the authoritative
	 * "exact" hits the service forces to win over any fuzzy/semantic score.
	 */
	async findExactMatches(workspaceId: string, sourceLang: string, targetLang: string, sourceText: string): Promise<TmEntry[]> {
		const needle = sourceText.trim().slice(0, TM_MAX_TEXT_LENGTH);
		const rows = await this.client.unsafe<TmRow>(`
			SELECT id, workspace_id, source_text, source_lang, target_text, target_lang,
				embedding, context_note, created_by, project_id, created_at
			FROM tm_entries
			WHERE workspace_id = $1 AND source_lang = $2 AND target_lang = $3 AND source_text = $4
			ORDER BY created_at DESC, id DESC
		`, [workspaceId, sourceLang, targetLang, needle]);
		return rows.map((row) => mapTmRow(row));
	}

	/**
	 * Native pgvector cosine search. Returns null when the native column is
	 * unavailable; the service ALWAYS also runs listCandidates + in-service cosine,
	 * so a null result simply means native contributes nothing.
	 *
	 * Ranking: pgvector's `<=>` is cosine DISTANCE (0 = identical, 2 = opposite),
	 * so similarity = 1 - distance, matching `cosineSimilarity` exactly. We bind the
	 * query as ONE scalar `::vector` literal (no JS-array bind, no string splice)
	 * and only consider rows whose embedding_vec IS NOT NULL (NULL = not backfilled).
	 * Those NULL-vector rows are NOT lost: this tier is purely ADDITIVE. The service
	 * runs it on top of (a) the embedding-free literal-exact tier (findExactMatches)
	 * and (b) the jsonb listCandidates cosine path, which ALWAYS runs and covers
	 * every row incl. NULL embedding_vec — so an unbackfilled row that is a literal
	 * OR a jsonb-cosine match still surfaces. Workspace + language-pair isolation is
	 * enforced in the WHERE clause exactly like listCandidates.
	 */
	async semanticSearch(
		workspaceId: string,
		sourceLang: string,
		targetLang: string,
		queryEmbedding: number[],
		limit: number,
	): Promise<TmSemanticMatch[] | null> {
		if (queryEmbedding.length !== TM_EMBEDDING_DIMENSIONS) return null;
		if (!(await this.hasNativeVector())) return null;
		const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 50) : 10;
		const rows = await this.client.unsafe<TmRow & { score: number | string }>(`
			SELECT id, workspace_id, source_text, source_lang, target_text, target_lang,
				embedding, context_note, created_by, project_id, created_at,
				1 - (embedding_vec <=> $4::vector) AS score
			FROM tm_entries
			WHERE workspace_id = $1 AND source_lang = $2 AND target_lang = $3
				AND embedding_vec IS NOT NULL
			ORDER BY embedding_vec <=> $4::vector ASC
			LIMIT $5
		`, [workspaceId, sourceLang, targetLang, toVectorLiteral(queryEmbedding), safeLimit]);
		return rows.map((row) => ({ entry: mapTmRow(row), score: Number(row.score) }));
	}

	async listCandidates(workspaceId: string, sourceLang: string, targetLang: string): Promise<Array<{ entry: TmEntry; embedding: number[] }>> {
		// Workspace isolation enforced in the WHERE clause: results can never span
		// workspaces. We stream the FULL workspace+lang TM in deterministic
		// (created_at ASC, id ASC) keyset pages so the service can rank every
		// candidate — an older exact match is never dropped by a "newest N" window.
		// A high absolute ceiling (TM_MAX_RANKED_CANDIDATES) is the only bound, as a
		// safety valve against an unbounded TM OOMing the ranker.
		const candidates: Array<{ entry: TmEntry; embedding: number[] }> = [];
		let afterCreatedAt: string | null = null;
		let afterId: string | null = null;
		while (candidates.length < TM_MAX_RANKED_CANDIDATES) {
			const remaining = TM_MAX_RANKED_CANDIDATES - candidates.length;
			const pageSize = Math.min(TM_CANDIDATE_PAGE_SIZE, remaining);
			const params: unknown[] = [workspaceId, sourceLang, targetLang];
			let keyset = "";
			if (afterCreatedAt !== null && afterId !== null) {
				params.push(afterCreatedAt, afterId);
				keyset = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length})`;
			}
			params.push(pageSize);
			const rows = await this.client.unsafe<TmRow>(`
				SELECT id, workspace_id, source_text, source_lang, target_text, target_lang,
					embedding, context_note, created_by, project_id, created_at
				FROM tm_entries
				WHERE workspace_id = $1 AND source_lang = $2 AND target_lang = $3 ${keyset}
				ORDER BY created_at ASC, id ASC
				LIMIT $${params.length}
			`, params);
			if (rows.length === 0) break;
			for (const row of rows) {
				candidates.push({ entry: mapTmRow(row), embedding: parseEmbedding(row.embedding) });
			}
			const last = rows[rows.length - 1]!;
			afterCreatedAt = last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at);
			afterId = last.id;
			if (rows.length < pageSize) break;
		}
		return candidates;
	}
}

function mapTmRow(row: TmRow): TmEntry {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		sourceText: row.source_text,
		sourceLang: row.source_lang,
		targetText: row.target_text,
		targetLang: row.target_lang,
		contextNote: row.context_note ?? undefined,
		createdBy: row.created_by ?? undefined,
		projectId: row.project_id ?? undefined,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function parseEmbedding(value: unknown): number[] {
	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === "number" ? item : Number(item))).filter((item) => Number.isFinite(item));
	}
	if (typeof value === "string") {
		try {
			return parseEmbedding(JSON.parse(value));
		} catch {
			return [];
		}
	}
	return [];
}

// ── Service ──────────────────────────────────────────────────────

export class TranslationMemoryService {
	private readonly store: TmStore;
	private readonly embed: TmEmbedder;
	private readonly embeddingModel: string;
	/**
	 * Whether to TRY the native pgvector tier. Defaults to the TM_SEMANTIC_ENABLED
	 * env flag, overridable for tests. Even when true, the native path only runs if
	 * the store implements semanticSearch AND it reports the column is available
	 * (returns non-null); otherwise we transparently fall back to the in-service
	 * cosine path. The native path is an additive SCALABILITY tier — it produces the
	 * identical cosine scores + exact/suggestion bands as the fallback, so enabling
	 * it never changes which match wins, only how the ranking is computed.
	 */
	private readonly semanticEnabled: boolean;

	constructor(options: { store: TmStore; embedder?: TmEmbedder; embeddingModel?: string; semanticEnabled?: boolean }) {
		this.store = options.store;
		this.embed = options.embedder ?? embedWithOpenAi;
		this.embeddingModel = options.embeddingModel ?? TM_EMBEDDING_MODEL;
		this.semanticEnabled = options.semanticEnabled ?? isTmSemanticEnabled();
	}

	/**
	 * Add a TM entry. Embeds the source text ONCE here and caches the vector on
	 * the row; this is the only place an entry's embedding is ever computed.
	 */
	async addEntry(input: TmAddInput): Promise<TmEntry> {
		const normalized = normalizeAddInput(input);
		const embedding = await this.embed(normalized.sourceText);
		if (!Array.isArray(embedding) || embedding.length === 0) {
			throw new TmError("Failed to embed translation memory source text", 502, "tm_embeddings_error");
		}
		return this.store.add(normalized, embedding, this.embeddingModel);
	}

	/**
	 * Search the TM for a workspace + language pair. Returns highest-scoring matches
	 * first, dropping anything below the suggestion threshold.
	 *
	 * THREE tiers, UNIONed + deduped by id (exact always wins, highest score kept):
	 *  0. LITERAL exact source-text match (embedding-free) — a plain equality lookup.
	 *     ALWAYS runs, needs NO OpenAI key, surfaces unbackfilled (NULL-vector) rows
	 *     the native path can't see, and is forced to score 1.0 so it can never be
	 *     demoted or hidden by a fuzzy/semantic score. This is what makes search
	 *     degrade gracefully when no key is configured (it never throws).
	 *  1. JSONB in-service cosine: streams the full workspace+lang TM and ranks in
	 *     JS. The original, DB-agnostic fuzzy path; it covers EVERY row including
	 *     those with a NULL embedding_vec, so it ALWAYS runs whenever a query
	 *     embedding exists — it is NOT gated behind the native tier. (BUG 2 fix: a
	 *     native result must never SUPPRESS this path, only add to it.)
	 *  2. NATIVE pgvector tier (TM_SEMANTIC_ENABLED + extension/column present),
	 *     ADDITIVE on top of tier 1: Postgres does the cosine ordering
	 *     ("ORDER BY embedding_vec <=> query") for BACKFILLED rows and returns the
	 *     nearest k — the faster/scalable path at large TM sizes. Rows that also
	 *     surfaced via tier 1 are deduped in the merge (highest score kept).
	 * Tiers 1/2 require a query embedding; if embeddings are unavailable (no key /
	 * provider unreachable) they are skipped and tier 0 alone answers — search NEVER
	 * 503s just because semantic ranking can't run. All tiers apply the identical
	 * exact (>=0.95) / suggestion (>=0.85) bands.
	 */
	async search(input: TmSearchInput): Promise<TmSearchResult[]> {
		const workspaceId = requireTrimmed(input.workspaceId, "workspaceId");
		const sourceLang = requireTrimmed(input.sourceLang, "sourceLang");
		const targetLang = requireTrimmed(input.targetLang, "targetLang");
		const sourceText = requireTrimmed(input.sourceText, "sourceText").slice(0, TM_MAX_TEXT_LENGTH);
		const limit = normalizeLimit(input.limit);

		// ── Tier 0: literal exact source-text matches (embedding-free). ──────────
		// Always runs first and never needs the embedder, so it works with no
		// OPENAI_API_KEY and surfaces unbackfilled rows the native vector path can't
		// see. These are forced into the "exact" band (score 1.0) so they ALWAYS win
		// over any fuzzy/semantic score — fuzzy can never demote or hide a real
		// literal match. (BUG 2: native search is additive, not a replacement.)
		const exactEntries = await this.store.findExactMatches(workspaceId, sourceLang, targetLang, sourceText);
		const exactMatches: TmSearchResult[] = exactEntries.map((entry) => ({
			...entry,
			score: 1,
			matchKind: "exact" as const,
		}));
		const matchedIds = new Set(exactMatches.map((m) => m.id));

		// ── Embedding (best-effort). ─────────────────────────────────────────────
		// The fuzzy/semantic tiers need a query embedding, which requires OpenAI. If
		// the embedder is unavailable (no key) we DO NOT throw — we degrade to the
		// exact-only result above. (BUG 1: missing key falls back gracefully instead
		// of 503-ing the whole search.) We only attempt the embed when at least one
		// fuzzy tier could actually consume it.
		let queryEmbedding: number[] | null = null;
		// Skip the embed entirely when the default OpenAI embedder is in use and no
		// key is configured — it would only throw a 503. (BUG 1: check availability
		// BEFORE embedding.) A custom/injected embedder is always attempted.
		const embeddingPossible = this.embed !== embedWithOpenAi || isOpenAiEmbeddingEnabled();
		if (embeddingPossible) {
			try {
				const embedded = await this.embed(sourceText);
				if (Array.isArray(embedded) && embedded.length > 0) queryEmbedding = embedded;
			} catch (error) {
				// A provider/transport error must not sink the whole search: a
				// literal-exact result is still useful. If embeddings are simply
				// UNAVAILABLE (no key / provider unreachable) we always degrade to the
				// exact-only result. For other failures we degrade too when there is at
				// least one exact hit, but re-throw when there is nothing else to return
				// so a genuine provider error is still surfaced.
				const unavailable = error instanceof TmError && error.code === "tm_embeddings_unavailable";
				if (!unavailable && exactMatches.length === 0) throw error;
			}
		}

		// ── Fuzzy/semantic tiers (ADDITIVE, never a replacement). ────────────────
		// Without a usable query embedding we cannot rank by similarity at all, so
		// the exact-only result stands.
		//
		// CRITICAL (BUG 2 regression fix): the native pgvector tier ONLY ranks rows
		// whose embedding_vec IS NOT NULL. Migration 0061 adds that column WITHOUT a
		// backfill, so an OLD row that has a valid jsonb embedding but a NULL
		// embedding_vec is INVISIBLE to native. If native were treated as a
		// replacement for the jsonb path (run jsonb only when native returns null),
		// such a row's cosine suggestion/exact would silently DISAPPEAR the moment
		// TM_SEMANTIC_ENABLED + pgvector exist — a regression to existing TM fuzzy
		// behavior. So we ALWAYS run the jsonb listCandidates cosine path (it covers
		// ALL rows, incl. NULL embedding_vec) and the native tier merely ADDS the
		// (faster/scalable) backfilled-row results on top. Both feed one merge that
		// dedupes by id keeping the highest score, and literal-exact (1.0) always wins.
		const fuzzyMatches: TmSemanticMatch[] = [];
		if (queryEmbedding) {
			// (a) jsonb + in-service cosine over the FULL workspace+lang TM. The
			// original, DB-agnostic path; it is the ONLY tier that can see rows with a
			// NULL embedding_vec, so it must run regardless of whether native ran.
			const candidates = await this.store.listCandidates(workspaceId, sourceLang, targetLang);
			for (const candidate of candidates) {
				fuzzyMatches.push({ entry: candidate.entry, score: cosineSimilarity(queryEmbedding, candidate.embedding) });
			}
			// (b) Native pgvector tier (flag-gated, additive). Returns null when the
			// column/extension is absent or dimensions mismatch → contributes nothing
			// and the jsonb path above stands. When non-null it scales the cosine
			// ranking for BACKFILLED rows; the merge below dedupes any row that also
			// surfaced via jsonb, keeping the higher score.
			if (this.semanticEnabled && this.store.semanticSearch) {
				const native = await this.store.semanticSearch(workspaceId, sourceLang, targetLang, queryEmbedding, limit);
				if (native !== null) fuzzyMatches.push(...native);
			}
		}

		// Merge: exact matches always win; fuzzy fills in near-matches, deduped by id
		// so a row that surfaced via BOTH native and jsonb (or is also a literal match)
		// is not double-counted. We keep the HIGHEST score per id; the literal-exact,
		// score-1.0 copy always wins (it is seeded first and any fuzzy id collision is
		// skipped). Native + jsonb compute the same cosine, but float paths can differ
		// by an ULP, so keeping the max is the safe, deterministic dedupe.
		const ranked: TmSearchResult[] = [...exactMatches];
		const fuzzyById = new Map<string, TmSearchResult>();
		for (const match of fuzzyMatches) {
			if (matchedIds.has(match.entry.id)) continue; // a literal-exact hit already won this id
			const matchKind = bandForScore(match.score);
			if (!matchKind) continue;
			const existing = fuzzyById.get(match.entry.id);
			if (!existing || match.score > existing.score) {
				fuzzyById.set(match.entry.id, { ...match.entry, score: match.score, matchKind });
			}
		}
		ranked.push(...fuzzyById.values());
		ranked.sort((a, b) => (b.score - a.score) || b.createdAt.localeCompare(a.createdAt));
		return ranked.slice(0, limit);
	}
}

function normalizeAddInput(input: TmAddInput): TmAddInput {
	return {
		workspaceId: requireTrimmed(input.workspaceId, "workspaceId"),
		sourceText: requireTrimmed(input.sourceText, "sourceText").slice(0, TM_MAX_TEXT_LENGTH),
		sourceLang: requireTrimmed(input.sourceLang, "sourceLang"),
		targetText: requireTrimmed(input.targetText, "targetText").slice(0, TM_MAX_TEXT_LENGTH),
		targetLang: requireTrimmed(input.targetLang, "targetLang"),
		contextNote: input.contextNote?.trim() ? input.contextNote.trim().slice(0, 1000) : undefined,
		createdBy: input.createdBy?.trim() || undefined,
		projectId: input.projectId?.trim() || undefined,
	};
}

function requireTrimmed(value: string | undefined, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new TmError(`Missing required field: ${field}`, 400, "tm_invalid_input");
	return trimmed;
}

function normalizeLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit) || !limit || limit <= 0) return 10;
	return Math.min(Math.trunc(limit), 50);
}

// ── Factory + default service ────────────────────────────────────

/**
 * Build the production TM store. Requires DATABASE_URL: the TM API is
 * workspace-scoped and workspace authz only exists in Postgres, so there is no
 * reachable no-DB API mode. We do NOT silently fall back to InMemoryTmStore here
 * because the routes would 503 at the workspace-access guard before ever using
 * it — that would be a dead fallback. InMemoryTmStore is for tests, injected
 * directly into TranslationMemoryService.
 */
export function createTmStore(): TmStore {
	if (!process.env.DATABASE_URL?.trim()) {
		throw new TmError("Translation memory requires DATABASE_URL", 503, "tm_store_unavailable");
	}
	return new PostgresTmStore();
}

// Lazily constructed so importing this module (e.g. in tests, or in a no-DB
// prototype boot) never throws; the store is only built on first real use,
// which only happens once the route's workspace-access guard has passed (i.e.
// DATABASE_URL is set).
let translationMemoryService: TranslationMemoryService | null = null;

export function getTranslationMemoryService(): TranslationMemoryService {
	if (!translationMemoryService) {
		translationMemoryService = new TranslationMemoryService({ store: createTmStore() });
	}
	return translationMemoryService;
}

/** Test seam: swap the active service (e.g. in-memory store + fake embedder). */
export function setTranslationMemoryServiceForTests(service: TranslationMemoryService): () => void {
	const previous = translationMemoryService;
	translationMemoryService = service;
	return () => {
		translationMemoryService = previous;
	};
}
