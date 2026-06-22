-- Per-workspace translation glossary: canonical term -> translation pairs that
-- power inline translator suggestions and consistency checks. Each entry is
-- scoped to a workspace and a target language, optionally narrowed to a single
-- role (translator/cleaner/typesetter/qc) and/or a single project.
--
-- Mirrors the file|postgres toggle used by auth, the asset registry, the usage
-- ledger, and workspace access: when DATABASE_URL is unset the service falls
-- back to JSON-on-disk, so there is no hard FK to workspaces/projects here
-- (those rows may only exist as files in prototype mode). workspace_id is the
-- isolation boundary and is always required.
CREATE TABLE IF NOT EXISTS glossary_entries (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	term text NOT NULL,
	translation text NOT NULL,
	target_lang text NOT NULL,
	notes text,
	-- Optional role narrowing. NULL means the entry applies to every role.
	-- Values are constrained to the four pipeline roles.
	role_scope text,
	-- Optional project narrowing. NULL means workspace-wide.
	project_id text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_role_scope_check'
	) THEN
		ALTER TABLE glossary_entries
			ADD CONSTRAINT glossary_entries_role_scope_check
			CHECK (role_scope IS NULL OR role_scope IN ('translator', 'cleaner', 'typesetter', 'qc'))
			NOT VALID;
	END IF;
END $$;

-- A term has one canonical translation per workspace + target language. Re-using
-- the same term for another language is allowed; re-adding it for the same
-- language updates in place (ON CONFLICT in the store).
CREATE UNIQUE INDEX IF NOT EXISTS glossary_entries_workspace_term_lang_uniq
	ON glossary_entries(workspace_id, term, target_lang);

-- Lookup/list path: every read is scoped by workspace + target language.
CREATE INDEX IF NOT EXISTS glossary_entries_workspace_lang_idx
	ON glossary_entries(workspace_id, target_lang);
