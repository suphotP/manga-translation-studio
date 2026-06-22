// VERIFICATION (PR #192 Codex P1 ×2): exercises the REAL PostgresTmStore against a
// live pgvector Postgres (mocked/deterministic embeddings) to prove the two fixes:
//
//   BUG 1 — TM_SEMANTIC_ENABLED on + no OPENAI_API_KEY must NOT throw; the
//           embedding-free literal-exact path still returns the exact match.
//   BUG 2 — native pgvector search is ADDITIVE: a row with NULL embedding_vec
//           (unbackfilled — migration 0061 adds the column with no backfill) that
//           is an EXACT match is NOT hidden by the native path's
//           `embedding_vec IS NOT NULL` filter, and exact ALWAYS wins over fuzzy.
//
// Gated on TEST_DATABASE_URL (skipped without it) — a pgvector-capable Postgres:
//   docker run -d --name tm-pgvector-test -e POSTGRES_PASSWORD=testpw \
//     -e POSTGRES_DB=tmtest -p 55432:5432 pgvector/pgvector:pg16
//   DATABASE_URL=postgres://postgres:testpw@127.0.0.1:55432/tmtest \
//     bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:testpw@127.0.0.1:55432/tmtest \
//     bun test src/__tests__/translation-memory.real-pg.test.ts

import { describe, test, expect } from "bun:test";
import {
	PostgresTmStore,
	TranslationMemoryService,
	TM_EMBEDDING_DIMENSIONS,
	embedWithOpenAi,
	type TmEmbedder,
} from "../services/translation-memory.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

// Deterministic 1536-dim embedder: the signal sits in the first few dims
// (curated phrases reused from the unit suite) with zero padding, so cosine
// direction is predictable and the native dimension gate (== 1536) is satisfied.
function wideEmbedder(): TmEmbedder {
	const base: Record<string, number[]> = {
		"hello world": [1, 0, 0, 0],
		"hello, world!": [0.98, 0.02, 0, 0], // ~exact band vs "hello world"
		"hi planet": [1, 0.45, 0, 0], // ~suggestion band vs "hello world"
		goodbye: [0, 0, 1, 0], // orthogonal → dropped
	};
	return async (text: string) => {
		const head = base[text.toLowerCase()] ?? [0, 0, 0, 1];
		const vec = new Array<number>(TM_EMBEDDING_DIMENSIONS).fill(0);
		for (let i = 0; i < head.length; i++) vec[i] = head[i]!;
		return vec;
	};
}

describeReal("TranslationMemory native pgvector tier (real pgvector Postgres)", () => {
	const baseEntry = { sourceLang: "en", targetLang: "ja", targetText: "こんにちは世界" };

	function freshWorkspace(): string {
		return `tm-real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	test("(d) native fuzzy works for backfilled rows: exact wins, near is a suggestion", async () => {
		const ws = freshWorkspace();
		const store = new PostgresTmStore(TEST_DATABASE_URL as string);
		const service = new TranslationMemoryService({ store, embedder: wideEmbedder(), semanticEnabled: true });

		await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hello world", targetText: "exact" });
		await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hi planet", targetText: "near" });
		await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "goodbye", targetText: "unrelated" });

		const results = await service.search({ workspaceId: ws, sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		expect(results.map((r) => r.targetText)).toEqual(["exact", "near"]);
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBe(1); // literal-exact tier forces score 1.0
		expect(results[1]?.matchKind).toBe("suggestion");
		expect(results[1]!.score).toBeGreaterThan(0);
	});

	test("(REGRESSION) an unbackfilled NULL-embedding_vec COSINE-SUGGESTION row (NOT a literal match) still returns when flag + pgvector are present", async () => {
		const ws = freshWorkspace();
		const raw = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const store = new PostgresTmStore(raw as unknown as ConstructorParameters<typeof PostgresTmStore>[0]);
		const service = new TranslationMemoryService({ store, embedder: wideEmbedder(), semanticEnabled: true });

		// "hi planet" is a SUGGESTION-band cosine match for "hello world" but NOT a
		// literal source_text match. Strip its native vector to simulate an OLD row
		// (migration 0061 adds embedding_vec with no backfill). It is invisible to the
		// native `embedding_vec IS NOT NULL` path; before the fix it vanished once the
		// flag + pgvector existed. The jsonb listCandidates cosine tier must still find it.
		const sug = await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hi planet", targetText: "unbackfilled-suggestion" });
		await raw.unsafe(`UPDATE tm_entries SET embedding_vec = NULL WHERE id = $1`, [sug.id]);

		// Sanity: the native vector path cannot see the unbackfilled row.
		const nativeOnly = await store.semanticSearch(ws, "en", "ja", await wideEmbedder()("hello world"), 10);
		expect(nativeOnly).not.toBeNull();
		expect(nativeOnly!.some((m) => m.entry.id === sug.id)).toBe(false);

		// Full search: the row is recovered via the jsonb cosine tier as a suggestion.
		const results = await service.search({ workspaceId: ws, sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(results.map((r) => r.targetText)).toEqual(["unbackfilled-suggestion"]);
		expect(results[0]?.matchKind).toBe("suggestion");
		expect(results.filter((r) => r.id === sug.id)).toHaveLength(1);

		await raw.close?.();
	});

	test("(e) dedupe by id: a backfilled row present in BOTH native + jsonb appears once (best score)", async () => {
		const ws = freshWorkspace();
		const store = new PostgresTmStore(TEST_DATABASE_URL as string);
		const service = new TranslationMemoryService({ store, embedder: wideEmbedder(), semanticEnabled: true });

		// A single backfilled suggestion row surfaces via the native pgvector tier AND
		// the always-on jsonb cosine tier. The merge must dedupe by id → one result.
		await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hi planet", targetText: "dup-suggestion" });
		const results = await service.search({ workspaceId: ws, sourceText: "hello world", sourceLang: "en", targetLang: "ja" });

		expect(results).toHaveLength(1);
		expect(results[0]?.targetText).toBe("dup-suggestion");
		expect(results[0]?.matchKind).toBe("suggestion");
	});

	test("(b)+(c) an unbackfilled NULL-embedding_vec EXACT row still returns and wins (not hidden by native)", async () => {
		const ws = freshWorkspace();
		const raw = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const store = new PostgresTmStore(raw as unknown as ConstructorParameters<typeof PostgresTmStore>[0]);
		const service = new TranslationMemoryService({ store, embedder: wideEmbedder(), semanticEnabled: true });

		// A backfilled fuzzy row (has embedding_vec) and a literal-exact row that we
		// then strip of its native vector to simulate an old/unbackfilled row.
		await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hi planet", targetText: "near-backfilled" });
		const exact = await service.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hello world", targetText: "exact-unbackfilled" });
		await raw.unsafe(`UPDATE tm_entries SET embedding_vec = NULL WHERE id = $1`, [exact.id]);

		// Sanity: the unbackfilled exact row is INVISIBLE to the native vector path.
		const nativeOnly = await store.semanticSearch(ws, "en", "ja", await wideEmbedder()("hello world"), 10);
		expect(nativeOnly).not.toBeNull();
		expect(nativeOnly!.some((m) => m.entry.id === exact.id)).toBe(false);

		// Full search: the literal-exact tier surfaces the unbackfilled row AND it wins.
		const results = await service.search({ workspaceId: ws, sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
		expect(results[0]?.targetText).toBe("exact-unbackfilled");
		expect(results[0]?.matchKind).toBe("exact");
		expect(results[0]?.score).toBe(1);
		// The exact row appears exactly once (deduped from any fuzzy self-match).
		expect(results.filter((r) => r.id === exact.id)).toHaveLength(1);

		await raw.close?.();
	});

	test("(a) flag ON + no OPENAI_API_KEY → no throw, the literal-exact match still returns", async () => {
		const ws = freshWorkspace();
		const raw = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const store = new PostgresTmStore(raw as unknown as ConstructorParameters<typeof PostgresTmStore>[0]);

		// Seed with a working embedder so the row exists (and is backfilled).
		const seed = new TranslationMemoryService({ store, embedder: wideEmbedder(), semanticEnabled: true });
		await seed.addEntry({ ...baseEntry, workspaceId: ws, sourceText: "hello world", targetText: "no-key-exact" });

		const previousKey = process.env.OPENAI_API_KEY;
		try {
			delete process.env.OPENAI_API_KEY; // simulate a deployment with no key
			// DEFAULT embedder (embedWithOpenAi) — would 503 without a key. The service
			// must skip the embed and still return the literal-exact match (no throw).
			const service = new TranslationMemoryService({ store, embedder: embedWithOpenAi, semanticEnabled: true });
			const results = await service.search({ workspaceId: ws, sourceText: "hello world", sourceLang: "en", targetLang: "ja" });
			expect(results).toHaveLength(1);
			expect(results[0]?.targetText).toBe("no-key-exact");
			expect(results[0]?.matchKind).toBe("exact");
			expect(results[0]?.score).toBe(1);
		} finally {
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
			await raw.close?.();
		}
	});
});
