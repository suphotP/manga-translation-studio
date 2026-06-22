-- Workspace contacts ("friends / followers"): a lightweight per-user address book
-- for fast re-invite into chapter teams. NOT an access grant — purely a lookup
-- row scoped to one owner. Additive/migration-safe: no existing table is touched.
CREATE TABLE IF NOT EXISTS workspace_contacts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	owner_user_id text NOT NULL,
	contact_user_id text,
	email text,
	display_name text,
	relationship text NOT NULL DEFAULT 'friend',
	suggested_role text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	-- A contact must be addressable by at least one of UID / email so it can become
	-- an invite.
	CONSTRAINT workspace_contacts_target_present CHECK (
		contact_user_id IS NOT NULL OR email IS NOT NULL
	)
);

-- List/lookup by owner (the only access path: a user only ever reads their own book).
CREATE INDEX IF NOT EXISTS workspace_contacts_owner_idx
	ON workspace_contacts (owner_user_id, updated_at DESC, id DESC);

-- Dedupe target: one row per (owner, contact target). COALESCE-on-empty so the
-- expression matches the store's ON CONFLICT clause (a NULL UID and a NULL email
-- collapse to '' for uniqueness), preventing duplicate contacts for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_contacts_owner_target_uniq
	ON workspace_contacts (owner_user_id, COALESCE(contact_user_id, ''), COALESCE(email, ''));
