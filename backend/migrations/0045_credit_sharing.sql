CREATE TABLE IF NOT EXISTS credit_grants (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	owner_scope text NOT NULL,
	owner_id text NOT NULL,
	credit_class text NOT NULL,
	amount numeric(14, 4) NOT NULL,
	source text NOT NULL,
	expires_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_owner_scope_check'
	) THEN
		ALTER TABLE credit_grants
			ADD CONSTRAINT credit_grants_owner_scope_check
			CHECK (owner_scope IN ('workspace', 'user')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_credit_class_check'
	) THEN
		ALTER TABLE credit_grants
			ADD CONSTRAINT credit_grants_credit_class_check
			CHECK (credit_class IN ('shareable', 'personal')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_source_check'
	) THEN
		ALTER TABLE credit_grants
			ADD CONSTRAINT credit_grants_source_check
			CHECK (source IN ('plan_monthly', 'addon_purchase', 'goodwill', 'topup')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_amount_positive_check'
	) THEN
		ALTER TABLE credit_grants
			ADD CONSTRAINT credit_grants_amount_positive_check
			CHECK (amount > 0) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS credit_grants_workspace_class_owner_idx
	ON credit_grants(workspace_id, credit_class, owner_scope, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credit_grants_workspace_expires_idx
	ON credit_grants(workspace_id, expires_at)
	WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_allocations (
	id text PRIMARY KEY,
	grant_id text NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
	allocated_to_scope text NOT NULL,
	allocated_to_id text NOT NULL,
	amount numeric(14, 4) NOT NULL,
	allocated_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_allocations_scope_check'
	) THEN
		ALTER TABLE credit_allocations
			ADD CONSTRAINT credit_allocations_scope_check
			CHECK (allocated_to_scope IN ('member', 'page', 'chapter')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_allocations_amount_positive_check'
	) THEN
		ALTER TABLE credit_allocations
			ADD CONSTRAINT credit_allocations_amount_positive_check
			CHECK (amount > 0) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS credit_allocations_grant_active_idx
	ON credit_allocations(grant_id, created_at DESC)
	WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS credit_allocations_target_active_idx
	ON credit_allocations(allocated_to_scope, allocated_to_id, created_at DESC)
	WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS credit_allocations_allocator_day_idx
	ON credit_allocations(allocated_by, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	user_id text,
	credit_class text NOT NULL,
	delta numeric(14, 4) NOT NULL,
	balance_after numeric(14, 4) NOT NULL,
	reason text NOT NULL,
	ref_id text,
	created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_credit_class_check'
	) THEN
		ALTER TABLE credit_ledger
			ADD CONSTRAINT credit_ledger_credit_class_check
			CHECK (credit_class IN ('shareable', 'personal')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS credit_ledger_workspace_user_class_created_idx
	ON credit_ledger(workspace_id, user_id, credit_class, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS credit_ledger_workspace_ref_idx
	ON credit_ledger(workspace_id, ref_id)
	WHERE ref_id IS NOT NULL;
