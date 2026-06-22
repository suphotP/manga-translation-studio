CREATE TABLE IF NOT EXISTS billing_plans (
	plan_id text PRIMARY KEY,
	name text NOT NULL,
	price_usd_monthly numeric(12, 2) NOT NULL DEFAULT 0,
	included_storage_bytes bigint NOT NULL DEFAULT 0,
	monthly_ai_credits integer NOT NULL DEFAULT 0,
	joinable_team_stories integer NOT NULL DEFAULT 0,
	creatable_team_stories integer NOT NULL DEFAULT 0,
	active_team_jobs integer NOT NULL DEFAULT 0,
	max_seats_included integer NOT NULL DEFAULT 1,
	allowed_ai_qualities jsonb NOT NULL DEFAULT '[]'::jsonb,
	addons jsonb NOT NULL DEFAULT '{}'::jsonb,
	status text NOT NULL DEFAULT 'active',
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'billing_plans_status_check'
	) THEN
		ALTER TABLE billing_plans
			ADD CONSTRAINT billing_plans_status_check
			CHECK (status IN ('active', 'draft', 'retired')) NOT VALID;
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing_addon_products (
	addon_id text PRIMARY KEY,
	kind text NOT NULL,
	name text NOT NULL,
	price_usd numeric(12, 2) NOT NULL DEFAULT 0,
	billing_interval text NOT NULL,
	units integer NOT NULL DEFAULT 0,
	unit_label text NOT NULL,
	min_plan_id text REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
	ai_credits integer NOT NULL DEFAULT 0,
	storage_bytes bigint NOT NULL DEFAULT 0,
	seats integer NOT NULL DEFAULT 0,
	team_jobs integer NOT NULL DEFAULT 0,
	active boolean NOT NULL DEFAULT true,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'billing_addon_products_kind_check'
	) THEN
		ALTER TABLE billing_addon_products
			ADD CONSTRAINT billing_addon_products_kind_check
			CHECK (kind IN ('ai_credits', 'storage', 'seat', 'team_jobs')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'billing_addon_products_interval_check'
	) THEN
		ALTER TABLE billing_addon_products
			ADD CONSTRAINT billing_addon_products_interval_check
			CHECK (billing_interval IN ('one_time', 'monthly')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS billing_addon_products_kind_active_idx
	ON billing_addon_products(kind, active, price_usd);

CREATE TABLE IF NOT EXISTS workspace_billing_accounts (
	workspace_id text PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	plan_id text NOT NULL REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
	status text NOT NULL DEFAULT 'mock_active',
	billing_email text,
	current_period_start timestamptz,
	current_period_end timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_billing_accounts_status_check'
	) THEN
		ALTER TABLE workspace_billing_accounts
			ADD CONSTRAINT workspace_billing_accounts_status_check
			CHECK (status IN ('mock_active', 'trialing', 'active', 'past_due', 'cancelled')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_billing_accounts_plan_status_idx
	ON workspace_billing_accounts(plan_id, status);

CREATE TABLE IF NOT EXISTS workspace_addon_grants (
	grant_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	addon_id text NOT NULL REFERENCES billing_addon_products(addon_id) ON DELETE RESTRICT,
	quantity integer NOT NULL DEFAULT 1,
	ai_credits integer NOT NULL DEFAULT 0,
	storage_bytes bigint NOT NULL DEFAULT 0,
	seats integer NOT NULL DEFAULT 0,
	team_jobs integer NOT NULL DEFAULT 0,
	status text NOT NULL DEFAULT 'active',
	source text NOT NULL DEFAULT 'mock',
	expires_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_addon_grants_status_check'
	) THEN
		ALTER TABLE workspace_addon_grants
			ADD CONSTRAINT workspace_addon_grants_status_check
			CHECK (status IN ('active', 'expired', 'revoked')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_addon_grants_workspace_status_idx
	ON workspace_addon_grants(workspace_id, status, created_at DESC);

INSERT INTO billing_plans (
	plan_id,
	name,
	price_usd_monthly,
	included_storage_bytes,
	monthly_ai_credits,
	joinable_team_stories,
	creatable_team_stories,
	active_team_jobs,
	max_seats_included,
	allowed_ai_qualities,
	addons,
	status,
	metadata,
	updated_at
) VALUES
	('free', 'Free', 0, 2147483648, 5, 1, 0, 0, 1, '["low"]'::jsonb, '{"aiCredits":false,"storage":false,"seats":false,"teamJobs":false}'::jsonb, 'active', '{}'::jsonb, now()),
	('creator', 'Creator', 8, 5368709120, 60, 5, 5, 5, 1, '["low","medium"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":true}'::jsonb, 'active', '{}'::jsonb, now()),
	('pro', 'Pro', 19, 26843545600, 220, 20, 20, 20, 3, '["low","medium","high"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":true}'::jsonb, 'active', '{}'::jsonb, now()),
	('studio', 'Studio', 49, 107374182400, 700, 100, 100, 100, 10, '["low","medium","high"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":true}'::jsonb, 'active', '{}'::jsonb, now())
ON CONFLICT (plan_id) DO UPDATE SET
	name = EXCLUDED.name,
	price_usd_monthly = EXCLUDED.price_usd_monthly,
	included_storage_bytes = EXCLUDED.included_storage_bytes,
	monthly_ai_credits = EXCLUDED.monthly_ai_credits,
	joinable_team_stories = EXCLUDED.joinable_team_stories,
	creatable_team_stories = EXCLUDED.creatable_team_stories,
	active_team_jobs = EXCLUDED.active_team_jobs,
	max_seats_included = EXCLUDED.max_seats_included,
	allowed_ai_qualities = EXCLUDED.allowed_ai_qualities,
	addons = EXCLUDED.addons,
	status = EXCLUDED.status,
	metadata = EXCLUDED.metadata,
	updated_at = now();

INSERT INTO billing_addon_products (
	addon_id,
	kind,
	name,
	price_usd,
	billing_interval,
	units,
	unit_label,
	min_plan_id,
	ai_credits,
	storage_bytes,
	seats,
	team_jobs,
	active,
	metadata,
	updated_at
) VALUES
	('credits-50', 'ai_credits', '50 AI credits', 4, 'one_time', 50, 'credits', 'creator', 50, 0, 0, 0, true, '{}'::jsonb, now()),
	('credits-200', 'ai_credits', '200 AI credits', 14, 'one_time', 200, 'credits', 'creator', 200, 0, 0, 0, true, '{}'::jsonb, now()),
	('storage-25gb', 'storage', '25 GB storage', 3, 'monthly', 25, 'GB', 'creator', 0, 26843545600, 0, 0, true, '{}'::jsonb, now()),
	('storage-100gb', 'storage', '100 GB storage', 9, 'monthly', 100, 'GB', 'pro', 0, 107374182400, 0, 0, true, '{}'::jsonb, now()),
	('seat-1', 'seat', 'Extra seat', 5, 'monthly', 1, 'seat', 'creator', 0, 0, 1, 0, true, '{}'::jsonb, now()),
	('team-jobs-10', 'team_jobs', '10 active team jobs', 6, 'monthly', 10, 'team jobs', 'creator', 0, 0, 0, 10, true, '{}'::jsonb, now())
ON CONFLICT (addon_id) DO UPDATE SET
	kind = EXCLUDED.kind,
	name = EXCLUDED.name,
	price_usd = EXCLUDED.price_usd,
	billing_interval = EXCLUDED.billing_interval,
	units = EXCLUDED.units,
	unit_label = EXCLUDED.unit_label,
	min_plan_id = EXCLUDED.min_plan_id,
	ai_credits = EXCLUDED.ai_credits,
	storage_bytes = EXCLUDED.storage_bytes,
	seats = EXCLUDED.seats,
	team_jobs = EXCLUDED.team_jobs,
	active = EXCLUDED.active,
	metadata = EXCLUDED.metadata,
	updated_at = now();
