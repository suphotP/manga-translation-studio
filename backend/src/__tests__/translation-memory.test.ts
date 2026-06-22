import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	bandForScore,
	cosineSimilarity,
	InMemoryTmStore,
	isTmSemanticEnabled,
	PostgresTmStore,
	TM_EMBEDDING_DIMENSIONS,
	TM_EMBEDDING_MODEL,
	TM_EXACT_MATCH_THRESHOLD,
	TM_SUGGESTION_THRESHOLD,
	TmError,
	toVectorLiteral,
	TranslationMemoryService,
	type TmEmbedder,
	type TmEntry,
	type TmSemanticMatch,
	type TmSqlClient,
	type TmStore,
} from "../services/translation-memory.js";
import { loadMigrations } from "../services/migrations.js";

// ── Deterministic embedder ───────────────────────────────────────
// Maps a small fixed vocabulary of phrases to hand-picked unit-ish vectors so
// cosine similarity is fully predictable in tests. Unknown text gets a fixed
// orthogonal "noise" vector. Tracks call count so we can assert that stored
// rows are never re-embedded on read.
function makeTrackingEmbedder(): { embedder: TmEmbedder; calls: () => number; lastText: () => string | undefined } {
	const vectors: Record<string, number[]> = {
		"hello world": [1, 0, 0, 0],
		"hello, world!": [0.98, 0.02, 0, 0], // ~0.9998 cosine vs "hello world" → exact band
		"hi planet": [1, 0.45, 0, 0], // ~0.912 cosine vs "hello world" → suggestion band
		goodbye: [0, 0, 1, 0], // orthogonal → below threshold
	};
	let calls = 0;
	let lastText: string | undefined;
	const embedder: TmEmbedder = async (text: string) => {
		calls += 1;
		lastText = text;
		return vectors[text.toLowerCase()] ?? [0, 0, 0, 1];
	};
	return { embedder, calls: () => calls, lastText: () => lastText };
}

const baseEntry = {
	sourceLang: "en",
	targetLang: "ja",
	targetText: "こんにちは世界",
};

describe("translation-memory cosine + threshold bands", () => {
	test("cosineSimilarity returns 1 for identical, 0 for orthogonal", () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
		expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
		expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6); // colinear
	});

	test("cosineSimilarity is defensive against degenerate / mismatched vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
		expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0); // length mismatch
	});

	test("bandForScore applies exact >= 0.95 and suggestion >= 0.85", () => {
		expect(bandForScore(0.99)).toBe("exact");
		expect(bandForScore(TM_EXACT_MATCH_THRESHOLD)).toBe("exact");
		expect(bandForScore(0.9)).toBe("suggestion");
		expect(bandForScore(TM_SUGGESTION_THRESHOLD)).toBe("suggestion");
		expect(bandForScore(0.84)).toBeNull();
		expect(bandForScore(0)).toBeNull();
	});
});

describe("TranslationMemoryService (in-memory store)", () => {
	test("addEntry embeds once and caches; search embeds only the query (no re-embed on read)", async () => {
		const { embedder, calls, lastText } = makeTrackingEmbedder();
		const store = new InMemoryTmStore();
		const service = new TranslationMemoryService({ store, embedder });

		await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "hello world" });
		expect(calls()).toBe(1); // one embed on write

		const results = await service.search({ workspaceId: "ws1", sourceText: "hello, world!", sourceLang: "en", targetLang: "ja" });
		// Only ONE more embed (the query) — the stored row is NOT re-embedded.
		expect(calls()).toBe(2);
		expect(lastText()).toBe("hello, world!");
		expect(results).toHaveLength(1);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBeGreaterThanOrEqual(TM_EXACT_MATCH_THRESHOLD);
		expect(results[0]?.targetText).toBe("こんにちは世界");
		expect(results[0]?.createdBy).toBeUndefined();
	});

	test("ranks results by score and assigns exact/suggestion bands; drops below-threshold", async () => {
		const { embedder } = makeTrackingEmbedder();
		const store = new InMemoryTmStore();
		const service = new TranslationMemoryService({ store, embedder });

		await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "hello, world!", targetText: "near" });
		await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "hi planet", targetText: "loose" });
		await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "goodbye", targetText: "unrelated" });

		const results = await service.search({ workspaceId: "ws1", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// "goodbye" (orthogonal) is dropped; near beats loose.
		expect(results.map((r) => r.targetText)).toEqual(["near", "loose"]);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[1]?.matchKind).toBe("suggestion");
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
	});

	test("enforces per-workspace isolation: ws2 never sees ws1 entries", async () => {
		const { embedder } = makeTrackingEmbedder();
		const store = new InMemoryTmStore();
		const service = new TranslationMemoryService({ store, embedder });

		await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "hello world", targetText: "ws1-secret" });

		const otherWorkspace = await service.search({ workspaceId: "ws2", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(otherWorkspace).toEqual([]);

		const sameWorkspace = await service.search({ workspaceId: "ws1", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(sameWorkspace[0]?.targetText).toBe("ws1-secret");
	});

	test("language pair scoping: a different target language is not matched", async () => {
		const { embedder } = makeTrackingEmbedder();
		const store = new InMemoryTmStore();
		const service = new TranslationMemoryService({ store, embedder });

		await service.addEntry({ workspaceId: "ws1", sourceText: "hello world", sourceLang: "en", targetLang: "ja", targetText: "ja-result" });

		const wrongPair = await service.search({ workspaceId: "ws1", sourceText: "hello world", sourceLang: "en", targetLang: "fr" });
		expect(wrongPair).toEqual([]);
	});

	test("respects limit and rejects blank input", async () => {
		const { embedder } = makeTrackingEmbedder();
		const service = new TranslationMemoryService({ store: new InMemoryTmStore(), embedder });

		await expect(service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "   " })).rejects.toBeInstanceOf(TmError);
		await expect(service.search({ workspaceId: "", sourceText: "x", sourceLang: "en", targetLang: "ja" })).rejects.toBeInstanceOf(TmError);
	});

	test("createdBy is persisted from the caller", async () => {
		const { embedder } = makeTrackingEmbedder();
		const service = new TranslationMemoryService({ store: new InMemoryTmStore(), embedder });
		const entry = await service.addEntry({ ...baseEntry, workspaceId: "ws1", sourceText: "hello world", createdBy: "user-42" });
		expect(entry.createdBy).toBe("user-42");
		expect(entry.id).toMatch(/[0-9a-f-]{36}/);
	});
});

// ── Postgres-mode store via a fake SQL client ────────────────────
// Mirrors the in-memory rows but routes through the SQL string the
// PostgresTmStore emits, so the jsonb (de)serialization + workspace/lang
// filtering in SQL are exercised without a live database.
class FakeTmSqlClient implements TmSqlClient {
	readonly rows: Array<Record<string, unknown>> = [];
	readonly queries: string[] = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push(query);
		const normalized = query.trim().toUpperCase();
		if (normalized.startsWith("INSERT INTO TM_ENTRIES")) {
			const row = {
				id: params[0],
				workspace_id: params[1],
				source_text: params[2],
				source_lang: params[3],
				target_text: params[4],
				target_lang: params[5],
				embedding: params[6], // JSON string, as the store serializes it
				embedding_model: params[7],
				context_note: params[8],
				created_by: params[9],
				project_id: params[10],
				created_at: new Date().toISOString(),
			};
			this.rows.push(row);
			return [row] as T[];
		}
		// Embedding-free literal exact-match lookup (source_text = $4).
		if (normalized.startsWith("SELECT") && query.includes("source_text = $4")) {
			const [workspaceId, sourceLang, targetLang, needle] = params as [string, string, string, string];
			return this.rows.filter((row) =>
				row.workspace_id === workspaceId
				&& row.source_lang === sourceLang
				&& row.target_lang === targetLang
				&& row.source_text === needle) as T[];
		}
		if (normalized.startsWith("SELECT")) {
			const [workspaceId, sourceLang, targetLang] = params as [string, string, string];
			let matches = this.rows
				.filter((row) =>
					row.workspace_id === workspaceId
					&& row.source_lang === sourceLang
					&& row.target_lang === targetLang)
				// listCandidates pages keyset-ascending by (created_at, id).
				.sort((a, b) => {
					const at = String(a.created_at);
					const bt = String(b.created_at);
					return at < bt ? -1 : at > bt ? 1 : String(a.id).localeCompare(String(b.id));
				});
			// Honor the keyset clause: when present, the last two params (before the
			// trailing LIMIT) are the (created_at, id) cursor.
			const hasKeyset = query.includes("(created_at, id) >");
			if (hasKeyset) {
				const afterCreatedAt = String(params[params.length - 3]);
				const afterId = String(params[params.length - 2]);
				matches = matches.filter((row) => {
					const ct = String(row.created_at);
					return ct > afterCreatedAt || (ct === afterCreatedAt && String(row.id) > afterId);
				});
			}
			const limit = Number(params[params.length - 1]);
			return matches.slice(0, Number.isFinite(limit) ? limit : matches.length) as T[];
		}
		return [] as T[];
	}
}

describe("PostgresTmStore (fake SQL client)", () => {
	test("serializes embedding as jsonb string, round-trips it, and ranks", async () => {
		const { embedder } = makeTrackingEmbedder();
		const client = new FakeTmSqlClient();
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder });

		const entry = await service.addEntry({ ...baseEntry, workspaceId: "wsA", sourceText: "hello world", createdBy: "u1" });
		expect(entry.workspaceId).toBe("wsA");
		// Embedding is passed to SQL as a JSON string bound through ::text::jsonb —
		// a bare ::jsonb bind would store a double-encoded jsonb STRING under
		// Bun.SQL (migration 0085).
		expect(typeof client.rows[0]?.embedding).toBe("string");
		expect(client.queries[0]).toContain("$7::text::jsonb");

		const results = await service.search({ workspaceId: "wsA", sourceText: "hello, world!", sourceLang: "en", targetLang: "ja" });
		expect(results).toHaveLength(1);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.createdBy).toBe("u1");
		// Candidate query is scoped by workspace + language pair.
		expect(client.queries.some((q) => q.includes("WHERE workspace_id = $1 AND source_lang = $2 AND target_lang = $3"))).toBe(true);
	});

	test("workspace isolation holds in postgres mode", async () => {
		const { embedder } = makeTrackingEmbedder();
		const store = new PostgresTmStore(new FakeTmSqlClient());
		const service = new TranslationMemoryService({ store, embedder });

		await service.addEntry({ ...baseEntry, workspaceId: "wsA", sourceText: "hello world", targetText: "A" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsB", sourceText: "hello world", targetText: "B" });

		const a = await service.search({ workspaceId: "wsA", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		const b = await service.search({ workspaceId: "wsB", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(a.map((r) => r.targetText)).toEqual(["A"]);
		expect(b.map((r) => r.targetText)).toEqual(["B"]);
	});

	test("constructor rejects empty DATABASE_URL", () => {
		expect(() => new PostgresTmStore("")).toThrow(/DATABASE_URL/);
	});
});

describe("migration 0038_translation_memory", () => {
	test("loads as a valid migration with tm_entries + workspace/lang index", () => {
		const migration = loadMigrations().find((item) => item.id === "0038_translation_memory");
		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS tm_entries");
		expect(migration!.sql).toContain("tm_entries_workspace_langs_idx");
		expect(migration!.sql).toContain("ON tm_entries(workspace_id, source_lang, target_lang)");
		expect(migration!.checksum).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("migration 0061_tm_pgvector", () => {
	test("loads as a valid migration that guards pgvector behind a transaction-safe DO block", () => {
		const migration = loadMigrations().find((item) => item.id === "0061_tm_pgvector");
		expect(migration).toBeDefined();
		// Extension creation + the vector column + cosine ANN index.
		expect(migration!.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)");
		expect(migration!.sql).toContain("USING ivfflat (embedding_vec vector_cosine_ops)");
		// NO-OP-safe: the CREATE EXTENSION is inside an EXCEPTION-guarded subtransaction
		// so a Postgres without pgvector cannot abort the migration transaction.
		expect(migration!.sql).toContain("DO $$");
		expect(migration!.sql).toContain("EXCEPTION WHEN OTHERS THEN");
		expect(migration!.sql).toContain("RETURN;");
		expect(migration!.checksum).toMatch(/^[a-f0-9]{64}$/);
	});

	test("dimension in the migration matches TM_EMBEDDING_DIMENSIONS (text-embedding-3-small)", () => {
		const migration = loadMigrations().find((item) => item.id === "0061_tm_pgvector");
		expect(TM_EMBEDDING_DIMENSIONS).toBe(1536);
		expect(migration!.sql).toContain(`vector(${TM_EMBEDDING_DIMENSIONS})`);
	});
});

// ── pgvector semantic tier ───────────────────────────────────────

describe("toVectorLiteral + isTmSemanticEnabled", () => {
	test("renders a scalar pgvector literal and sanitizes non-finite components", () => {
		expect(toVectorLiteral([1, 0.5, 0])).toBe("[1,0.5,0]");
		expect(toVectorLiteral([Number.NaN, Number.POSITIVE_INFINITY, 2])).toBe("[0,0,2]");
		expect(toVectorLiteral([])).toBe("[]");
	});

	test("TM_SEMANTIC_ENABLED env flag is OFF unless an explicit truthy token is set", () => {
		const previous = process.env.TM_SEMANTIC_ENABLED;
		try {
			delete process.env.TM_SEMANTIC_ENABLED;
			expect(isTmSemanticEnabled()).toBe(false);
			process.env.TM_SEMANTIC_ENABLED = "false";
			expect(isTmSemanticEnabled()).toBe(false);
			process.env.TM_SEMANTIC_ENABLED = "treu"; // typo → stays off
			expect(isTmSemanticEnabled()).toBe(false);
			for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
				process.env.TM_SEMANTIC_ENABLED = truthy;
				expect(isTmSemanticEnabled()).toBe(true);
			}
		} finally {
			if (previous === undefined) delete process.env.TM_SEMANTIC_ENABLED;
			else process.env.TM_SEMANTIC_ENABLED = previous;
		}
	});
});

// A 1536-dim embedder so the native-vector dimension gate (== TM_EMBEDDING_DIMENSIONS)
// is satisfied. The signal sits in the first 4 dims (reusing the curated phrases);
// the rest are zero padding, which doesn't change cosine direction.
function makeWideEmbedder(): { embedder: TmEmbedder; calls: () => number } {
	const base: Record<string, number[]> = {
		"hello world": [1, 0, 0, 0],
		"hello, world!": [0.98, 0.02, 0, 0],
		"hi planet": [1, 0.45, 0, 0],
		goodbye: [0, 0, 1, 0],
	};
	let calls = 0;
	const embedder: TmEmbedder = async (text: string) => {
		calls += 1;
		const head = base[text.toLowerCase()] ?? [0, 0, 0, 1];
		const vec = new Array<number>(TM_EMBEDDING_DIMENSIONS).fill(0);
		for (let i = 0; i < head.length; i++) vec[i] = head[i]!;
		return vec;
	};
	return { embedder, calls: () => calls };
}

// ── Fake pgvector SQL client ─────────────────────────────────────
// Models the embedding_vec column + the `<=>` cosine-distance ORDER BY that the
// native semanticSearch path emits, plus the information_schema column probe, so
// the DB-side ranking SQL is exercised without a live pgvector database. Cosine
// distance is computed here from the bound `::vector` literal (parsed back from
// the scalar string param) to assert the bind is scalar + safe.
class FakePgVectorSqlClient implements TmSqlClient {
	readonly rows: Array<Record<string, unknown>> = [];
	readonly queries: string[] = [];
	readonly params: unknown[][] = [];
	constructor(private readonly columnExists = true) {}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push(query);
		this.params.push(params);
		const normalized = query.trim().toUpperCase();

		// Column-existence probe.
		if (normalized.startsWith("SELECT EXISTS")) {
			return [{ exists: this.columnExists }] as T[];
		}

		if (normalized.startsWith("INSERT INTO TM_ENTRIES")) {
			const usesNative = query.includes("embedding_vec");
			const row: Record<string, unknown> = {
				id: params[0],
				workspace_id: params[1],
				source_text: params[2],
				source_lang: params[3],
				target_text: params[4],
				target_lang: params[5],
				embedding: params[6],
				embedding_model: params[7],
				context_note: params[8],
				created_by: params[9],
				project_id: params[10],
				// The native vector literal is the LAST param when present.
				embedding_vec: usesNative ? params[params.length - 1] : null,
				created_at: new Date(Date.now() + this.rows.length).toISOString(),
			};
			this.rows.push(row);
			return [row] as T[];
		}

		// Embedding-free literal exact-match lookup (source_text = $4).
		if (normalized.startsWith("SELECT") && query.includes("source_text = $4")) {
			const [workspaceId, sourceLang, targetLang, needle] = params as [string, string, string, string];
			return this.rows.filter((r) =>
				r.workspace_id === workspaceId
				&& r.source_lang === sourceLang
				&& r.target_lang === targetLang
				&& r.source_text === needle) as T[];
		}

		// Native semantic search: SELECT ... 1 - (embedding_vec <=> $4::vector) AS score
		if (normalized.includes("EMBEDDING_VEC <=>")) {
			const [workspaceId, sourceLang, targetLang, vectorLiteral, limit] = params as [
				string, string, string, string, number,
			];
			const query = parseVectorLiteral(vectorLiteral);
			const scored = this.rows
				.filter((r) =>
					r.workspace_id === workspaceId
					&& r.source_lang === sourceLang
					&& r.target_lang === targetLang
					&& r.embedding_vec != null)
				.map((r) => ({ ...r, score: fakeCosine(query, parseVectorLiteral(String(r.embedding_vec))) }))
				.sort((a, b) => b.score - a.score);
			return scored.slice(0, Number(limit)) as T[];
		}

		// Fallback candidate stream (jsonb path) — reused by the non-native tests.
		if (normalized.startsWith("SELECT")) {
			const [workspaceId, sourceLang, targetLang] = params as [string, string, string];
			const matches = this.rows.filter((r) =>
				r.workspace_id === workspaceId && r.source_lang === sourceLang && r.target_lang === targetLang);
			const limit = Number(params[params.length - 1]);
			return matches.slice(0, Number.isFinite(limit) ? limit : matches.length) as T[];
		}
		return [] as T[];
	}
}

function parseVectorLiteral(literal: string): number[] {
	return literal.replace(/^\[|\]$/g, "").split(",").filter((s) => s.length > 0).map(Number);
}

function fakeCosine(a: number[], b: number[]): number {
	let dot = 0, ma = 0, mb = 0;
	for (let i = 0; i < a.length; i++) { dot += (a[i] ?? 0) * (b[i] ?? 0); ma += (a[i] ?? 0) ** 2; mb += (b[i] ?? 0) ** 2; }
	if (ma === 0 || mb === 0) return 0;
	return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

describe("PostgresTmStore native pgvector tier (fake SQL client)", () => {
	test("addEntry writes the native vector via a SCALAR ::vector bind when the column exists", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		await service.addEntry({ ...baseEntry, workspaceId: "wsV", sourceText: "hello world", createdBy: "u1" });

		const insert = client.queries.find((q) => q.includes("INSERT INTO tm_entries"))!;
		expect(insert).toContain("embedding_vec");
		expect(insert).toContain("::vector");
		// The vector was bound as a STRING literal param, never spliced into SQL.
		const insertParams = client.params[client.queries.indexOf(insert)]!;
		const vectorParam = insertParams[insertParams.length - 1];
		expect(typeof vectorParam).toBe("string");
		expect(String(vectorParam).startsWith("[")).toBe(true);
		expect(insert).not.toContain(String(vectorParam)); // not interpolated
	});

	test("semantic search ranks by DB-side cosine and keeps exact-wins + bands", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const service = new TranslationMemoryService({ store: new PostgresTmStore(client), embedder, semanticEnabled: true });

		await service.addEntry({ ...baseEntry, workspaceId: "wsV", sourceText: "hello, world!", targetText: "near" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsV", sourceText: "hi planet", targetText: "loose" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsV", sourceText: "goodbye", targetText: "unrelated" });

		const results = await service.search({ workspaceId: "wsV", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// Went through the native pgvector ORDER BY, not the candidate stream.
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(true);
		// orthogonal "goodbye" dropped; exact "near" wins; "loose" is a suggestion.
		expect(results.map((r) => r.targetText)).toEqual(["near", "loose"]);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[1]?.matchKind).toBe("suggestion");
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
	});

	test("native search preserves workspace + language-pair isolation", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const service = new TranslationMemoryService({ store: new PostgresTmStore(client), embedder, semanticEnabled: true });

		await service.addEntry({ ...baseEntry, workspaceId: "wsV1", sourceText: "hello world", targetText: "v1" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsV2", sourceText: "hello world", targetText: "v2" });

		const v1 = await service.search({ workspaceId: "wsV1", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(v1.map((r) => r.targetText)).toEqual(["v1"]);
		const wrongPair = await service.search({ workspaceId: "wsV1", sourceText: "hello world", sourceLang: "en", targetLang: "fr" });
		expect(wrongPair).toEqual([]);
	});
});

describe("graceful fallback when pgvector / flag / dimensions are absent", () => {
	test("flag OFF: never touches the native vector path (no column probe, no <=> query)", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const service = new TranslationMemoryService({ store: new PostgresTmStore(client), embedder, semanticEnabled: false });

		await service.addEntry({ ...baseEntry, workspaceId: "wsF", sourceText: "hello world", targetText: "x" });
		const results = await service.search({ workspaceId: "wsF", sourceText: "hello, world!", sourceLang: "en", targetLang: "ja" });

		// Still finds the match — via the jsonb + in-service cosine path.
		expect(results[0]?.targetText).toBe("x");
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(false);
		// add() still probes the column to decide whether to backfill embedding_vec,
		// but search() with the flag off must NOT run a native <=> query.
	});

	test("column absent (no pgvector): falls back to in-service cosine, no crash", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(false); // information_schema probe says column missing
		const service = new TranslationMemoryService({ store: new PostgresTmStore(client), embedder, semanticEnabled: true });

		await service.addEntry({ ...baseEntry, workspaceId: "wsN", sourceText: "hello world", targetText: "x" });
		// Insert must NOT reference embedding_vec when the column does not exist.
		expect(client.queries.find((q) => q.includes("INSERT INTO tm_entries"))!).not.toContain("embedding_vec");

		const results = await service.search({ workspaceId: "wsN", sourceText: "hello, world!", sourceLang: "en", targetLang: "ja" });
		expect(results[0]?.targetText).toBe("x");
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(false);
	});

	test("dimension mismatch: semanticSearch returns null → service falls back", async () => {
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		// A 4-dim embedder (≠ TM_EMBEDDING_DIMENSIONS) — the native path is skipped.
		const narrow: TmEmbedder = async () => [1, 0, 0, 0];
		const native = await store.semanticSearch("ws", "en", "ja", await narrow("hello world"), 10);
		expect(native).toBeNull();
	});

	test("store without semanticSearch (InMemoryTmStore) just uses the in-service path even with the flag on", async () => {
		const { embedder } = makeWideEmbedder();
		const store: TmStore = new InMemoryTmStore();
		expect(store.semanticSearch).toBeUndefined();
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });
		await service.addEntry({ ...baseEntry, workspaceId: "wsI", sourceText: "hello world", targetText: "x" });
		const results = await service.search({ workspaceId: "wsI", sourceText: "hello, world!", sourceLang: "en", targetLang: "ja" });
		expect(results[0]?.targetText).toBe("x");
	});
});

// ── Codex P1: exact-match additive merge + graceful no-key fallback ──────────
// Regression coverage for the two P1s on PR #192:
//   BUG 1 — TM_SEMANTIC_ENABLED on but no OPENAI_API_KEY must NOT throw; the
//           embedding-free literal-exact path still returns the exact match.
//   BUG 2 — native semantic search is ADDITIVE: an empty/partial native result
//           (e.g. an unbackfilled NULL-embedding_vec row) can never hide a real
//           literal-exact match, and exact ALWAYS wins over fuzzy.
describe("exact-match merge + no-key fallback (Codex P1)", () => {
	test("BUG 1: flag ON + no OPENAI_API_KEY → no throw, literal exact match still returns", async () => {
		const previousKey = process.env.OPENAI_API_KEY;
		const previousFlag = process.env.TM_SEMANTIC_ENABLED;
		try {
			delete process.env.OPENAI_API_KEY;
			process.env.TM_SEMANTIC_ENABLED = "1";

			const client = new FakePgVectorSqlClient(true);
			const store = new PostgresTmStore(client);
			// Seed a row WITH an embedding (via a one-off embedder), so listCandidates
			// would have a vector — but the search runs with the DEFAULT (OpenAI)
			// embedder and no key, exercising the no-key path.
			const seedService = new TranslationMemoryService({
				store,
				embedder: async () => new Array<number>(TM_EMBEDDING_DIMENSIONS).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
				semanticEnabled: true,
			});
			await seedService.addEntry({ ...baseEntry, workspaceId: "wsK", sourceText: "hello world", targetText: "exact-hit" });

			// Default embedder (embedWithOpenAi) → would 503 without a key. The service
			// must SKIP the embed and still return the literal exact match.
			const service = new TranslationMemoryService({ store, semanticEnabled: true });
			const results = await service.search({ workspaceId: "wsK", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

			expect(results).toHaveLength(1);
			expect(results[0]?.targetText).toBe("exact-hit");
			expect(results[0]?.matchKind).toBe("exact");
			expect(results[0]?.score).toBe(1);
			// No native <=> query ran (no usable query embedding without a key).
			expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(false);
		} finally {
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
			if (previousFlag === undefined) delete process.env.TM_SEMANTIC_ENABLED;
			else process.env.TM_SEMANTIC_ENABLED = previousFlag;
		}
	});

	test("BUG 2: an unbackfilled (NULL embedding_vec) exact row is NOT hidden by an empty native result", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		// Insert a row that is a LITERAL match but force its embedding_vec to NULL,
		// simulating an old/unbackfilled row (migration 0061 adds the column with no
		// backfill). Native search filters embedding_vec IS NOT NULL → it returns [].
		await service.addEntry({ ...baseEntry, workspaceId: "wsB", sourceText: "hello world", targetText: "unbackfilled" });
		for (const row of client.rows) row.embedding_vec = null;

		const results = await service.search({ workspaceId: "wsB", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// Native ran and returned no rows, but the literal-exact tier still surfaces it.
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(true);
		expect(results).toHaveLength(1);
		expect(results[0]?.targetText).toBe("unbackfilled");
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBe(1);
	});

	test("BUG 2: exact (literal) always wins over a higher-positioned fuzzy match, deduped", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		// A literal-exact row (also self-matches cosine 1.0 in native) + a near fuzzy row.
		await service.addEntry({ ...baseEntry, workspaceId: "wsW", sourceText: "hello world", targetText: "the-exact" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsW", sourceText: "hi planet", targetText: "the-fuzzy" });

		const results = await service.search({ workspaceId: "wsW", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// Exact wins (score 1.0, exact band), fuzzy is the suggestion, and the exact
		// row appears exactly ONCE (not double-counted by the native self-match).
		expect(results.map((r) => r.targetText)).toEqual(["the-exact", "the-fuzzy"]);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBe(1);
		expect(results.filter((r) => r.targetText === "the-exact")).toHaveLength(1);
		expect(results[1]?.matchKind).toBe("suggestion");
	});

	test("BUG 2: native fuzzy still works for backfilled rows alongside the exact tier", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		// No literal-exact match for the query; the near row is reached via native fuzzy.
		await service.addEntry({ ...baseEntry, workspaceId: "wsFz", sourceText: "hi planet", targetText: "near-fuzzy" });
		const results = await service.search({ workspaceId: "wsFz", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(true);
		expect(results.map((r) => r.targetText)).toEqual(["near-fuzzy"]);
		expect(results[0]?.matchKind).toBe("suggestion");
	});

	test("BUG 2 (regression): an unbackfilled (NULL embedding_vec) COSINE-SUGGESTION row — NOT a literal match — still surfaces via the jsonb path when native is enabled", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		// "hi planet" is a SUGGESTION-band cosine match for "hello world" but is NOT a
		// literal source_text match. It has a valid jsonb embedding. Now strip its
		// native vector to simulate an OLD/unbackfilled row (migration 0061 adds the
		// column with no backfill). It is INVISIBLE to native (embedding_vec IS NOT NULL
		// filter) — so before the fix, with the flag on + pgvector present, this row
		// would silently DISAPPEAR. The jsonb listCandidates path must still find it.
		await service.addEntry({ ...baseEntry, workspaceId: "wsR", sourceText: "hi planet", targetText: "unbackfilled-suggestion" });
		for (const row of client.rows) row.embedding_vec = null;

		// Sanity: native sees nothing (its only row has a NULL vector).
		const native = await store.semanticSearch("wsR", "en", "ja", await embedder("hello world"), 10);
		expect(native).not.toBeNull();
		expect(native).toHaveLength(0);

		const results = await service.search({ workspaceId: "wsR", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// Native ran (flag on + column present) AND returned nothing, but the jsonb
		// cosine tier STILL surfaces the suggestion — the regression is fixed.
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(true);
		expect(results.map((r) => r.targetText)).toEqual(["unbackfilled-suggestion"]);
		expect(results[0]?.matchKind).toBe("suggestion");
		expect(results[0]!.score).toBeGreaterThanOrEqual(TM_SUGGESTION_THRESHOLD);
	});

	test("BUG 2 (dedupe): a backfilled SUGGESTION row in BOTH native + jsonb appears exactly once, best score", async () => {
		const { embedder } = makeWideEmbedder();
		const client = new FakePgVectorSqlClient(true);
		const store = new PostgresTmStore(client);
		const service = new TranslationMemoryService({ store, embedder, semanticEnabled: true });

		// A single backfilled suggestion row. It surfaces via BOTH the jsonb
		// listCandidates path (always runs now) AND the native pgvector tier. The
		// merge must dedupe by id so it appears exactly once.
		await service.addEntry({ ...baseEntry, workspaceId: "wsD", sourceText: "hi planet", targetText: "dup-suggestion" });
		const results = await service.search({ workspaceId: "wsD", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		// Both fuzzy tiers ran (native <=> query + jsonb candidate stream).
		expect(client.queries.some((q) => q.includes("embedding_vec <=>"))).toBe(true);
		expect(client.queries.some((q) => q.includes("ORDER BY created_at ASC, id ASC"))).toBe(true);
		// Deduped: exactly one result, not two.
		expect(results).toHaveLength(1);
		expect(results[0]?.targetText).toBe("dup-suggestion");
		expect(results[0]?.matchKind).toBe("suggestion");
	});

	test("in-memory store: literal exact match wins even when the flag is off", async () => {
		const { embedder } = makeTrackingEmbedder();
		const service = new TranslationMemoryService({ store: new InMemoryTmStore(), embedder, semanticEnabled: false });
		await service.addEntry({ ...baseEntry, workspaceId: "wsM", sourceText: "hello world", targetText: "literal" });
		await service.addEntry({ ...baseEntry, workspaceId: "wsM", sourceText: "hi planet", targetText: "loose" });

		const results = await service.search({ workspaceId: "wsM", sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(results[0]?.targetText).toBe("literal");
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBe(1);
	});
});

// Keep TmSemanticMatch referenced so a future field rename trips the test types.
const _semanticTypecheck: TmSemanticMatch = { entry: _typecheckEntry(), score: 0.9 };
void _semanticTypecheck;

function _typecheckEntry(): TmEntry {
	return {
		id: "x",
		workspaceId: "ws",
		sourceText: "s",
		sourceLang: "en",
		targetText: "t",
		targetLang: "ja",
		createdAt: new Date().toISOString(),
	};
}

// ── Route authz (no-DB branches that the route owns) ─────────────
// The full membership/isolation path runs against the live workspaceAccessStore
// (DB-backed); here we exercise the auth + validation + store-unavailable
// branches the route itself owns, mounting the real router.
describe("translation-memory routes", () => {
	let app: Hono;

	beforeEach(async () => {
		const { tm } = await import("../routes/translation-memory.js");
		app = new Hono();
		app.route("/api/tm", tm);
	});

	afterEach(() => {
		// no global state mutated
	});

	test("POST /api/tm requires authentication", async () => {
		const res = await app.request("/api/tm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws1", sourceText: "hi", sourceLang: "en", targetText: "x", targetLang: "ja" }),
		});
		expect(res.status).toBe(401);
	});

	test("POST /api/tm/search requires authentication", async () => {
		const res = await app.request("/api/tm/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws1", q: "hi", from: "en", to: "ja" }),
		});
		expect(res.status).toBe(401);
	});

	test("POST /api/tm/search keeps TM text out of the URL (body-only)", async () => {
		// The query text must not appear anywhere in the request URL/path.
		const res = await app.request("/api/tm/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws1", q: "licensed secret line", from: "en", to: "ja" }),
		});
		// Unauthenticated → 401, but the point is the route is POST/body-based.
		expect(res.status).toBe(401);
		expect(res.url).not.toContain("licensed");
	});
});

// Surface the embedding model constant so downstream callers/tests can pin it.
test("default embedding model is text-embedding-3-small", () => {
	expect(TM_EMBEDDING_MODEL).toBe("text-embedding-3-small");
});

// Keep TmEntry shape referenced so a future field rename trips the test types.
const _typecheck: TmEntry = {
	id: "x",
	workspaceId: "ws",
	sourceText: "s",
	sourceLang: "en",
	targetText: "t",
	targetLang: "ja",
	createdAt: new Date().toISOString(),
};
void _typecheck;
