-- Wave 3 W3.6: Translation Memory (TM).
--
-- Stores per-workspace translation pairs (source -> target) plus a cached
-- embedding of the source text so the TM can be searched with vector-fuzzy
-- cosine similarity. Embeddings are computed once at write time
-- (text-embedding-3-small) and cached here; reads NEVER re-embed stored
-- entries — only the incoming query is embedded — to keep embedding cost
-- bounded.
--
-- Embeddings are stored as a JSON float array (jsonb) rather than a pgvector
-- column: the deployment does not provision the pgvector extension, and the
-- candidate set per workspace/lang-pair is small enough that exact cosine in
-- the service layer is sufficient for the prototype. This mirrors the jsonb
-- posture used across the rest of the schema (scope, metadata, derivatives).
--
-- No hard FK to workspaces/projects: like asset_records (0021) and
-- upload_audit_events (0003), the TM is its own source of truth and a
-- referenced workspace/project row may live outside this table. workspace_id
-- is required (isolation key); project_id is nullable and best-effort.
CREATE TABLE IF NOT EXISTS tm_entries (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	source_text text NOT NULL,
	source_lang text NOT NULL,
	target_text text NOT NULL,
	target_lang text NOT NULL,
	-- Cached embedding of source_text as a JSON array of floats.
	embedding jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Identifier of the embedding model used, so a future model swap can be
	-- detected without re-reading every row's vector dimensionality.
	embedding_model text,
	context_note text,
	created_by text,
	project_id text,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- TM search is always scoped by workspace + the source/target language pair.
CREATE INDEX IF NOT EXISTS tm_entries_workspace_langs_idx
	ON tm_entries(workspace_id, source_lang, target_lang);

-- Newest-first listing within a workspace (tie-broken by id for stable order).
CREATE INDEX IF NOT EXISTS tm_entries_workspace_created_id_idx
	ON tm_entries(workspace_id, created_at DESC, id DESC);
