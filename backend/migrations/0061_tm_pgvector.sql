-- DB backlog #9: Translation Memory (TM) pgvector semantic/fuzzy search.
--
-- This migration adds a native pgvector column + an approximate-nearest-neighbor
-- index ALONGSIDE the existing jsonb `embedding` column from 0038. It is purely
-- ADDITIVE: the jsonb embedding + in-service cosine ranking remains the source of
-- truth and the only code path that runs when pgvector is unavailable. The native
-- vector column lets the search "ORDER BY embedding_vec <=> query LIMIT k" inside
-- Postgres (scaling past the in-service "stream every candidate and rank" path)
-- when the deployment provisions pgvector AND the semantic flag is on.
--
-- ── NO-OP-SAFE / graceful degradation ───────────────────────────────────────
-- The migration runner applies each migration inside a SINGLE transaction. A bare
-- `CREATE EXTENSION vector` against a Postgres that does NOT ship pgvector would
-- raise and ABORT the whole transaction (and every later statement), breaking the
-- migration runner on file-mode / vanilla-Postgres deployments. To stay
-- transaction-safe everywhere, ALL pgvector DDL is wrapped in a single PL/pgSQL
-- DO block that:
--   1. tries CREATE EXTENSION IF NOT EXISTS vector,
--   2. on ANY failure (extension not installed / insufficient privilege) RAISES a
--      NOTICE and RETURNS — leaving the transaction intact so the row in
--      schema_migrations is still recorded and later migrations still run,
--   3. only then adds the vector column + ivfflat cosine index.
-- The exception is caught WITHIN the DO block's own subtransaction, so a failed
-- CREATE EXTENSION does not poison the outer migration transaction.
--
-- When pgvector is absent the app degrades to the existing 0038 jsonb + service
-- cosine path automatically: the service probes for the column/extension at
-- runtime and only uses the native vector path when it actually exists AND
-- TM_SEMANTIC_ENABLED is on. The dimension (1536) matches OpenAI
-- text-embedding-3-small, the model pinned by TM_EMBEDDING_MODEL.
DO $$
BEGIN
	-- Try to make the pgvector extension available. Wrapped so a deployment
	-- without the extension (file-mode, plain Postgres) does not abort the
	-- migration transaction — it just skips the native-vector enhancement.
	BEGIN
		CREATE EXTENSION IF NOT EXISTS vector;
	EXCEPTION WHEN OTHERS THEN
		RAISE NOTICE 'pgvector extension unavailable (%); skipping TM native-vector column. TM semantic search will fall back to the jsonb + in-service cosine path.', SQLERRM;
		RETURN;
	END;

	-- Native vector column for the cached source embedding. 1536 dims =
	-- text-embedding-3-small. Nullable + no default: existing rows keep using the
	-- jsonb embedding until/unless they are backfilled, and the service handles a
	-- NULL native vector by falling back to the jsonb cosine path for that row.
	ALTER TABLE tm_entries ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);

	-- Approximate-nearest-neighbor cosine index. ivfflat (not hnsw) so the index
	-- builds inside the migration transaction without the larger build-memory of
	-- hnsw; cosine ops (vector_cosine_ops) because TM ranks by cosine similarity
	-- (1 - cosine_distance). lists=100 is a sane default for the small-to-medium
	-- per-workspace TM; it can be retuned out-of-band. Partial index over the rows
	-- that actually have a native vector keeps the index lean during rollout.
	CREATE INDEX IF NOT EXISTS tm_entries_embedding_vec_cosine_idx
		ON tm_entries USING ivfflat (embedding_vec vector_cosine_ops)
		WITH (lists = 100)
		WHERE embedding_vec IS NOT NULL;
END
$$;
