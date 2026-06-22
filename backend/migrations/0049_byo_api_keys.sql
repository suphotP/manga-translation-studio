-- Wave 2 W2.12 — Studio BYO API add-on.
-- Customer keys are workspace-scoped and encrypted by envelope encryption in
-- the service before they reach this table. `encrypted_key` stores an opaque
-- byte payload containing encrypted data-key material plus ciphertext.

CREATE TABLE IF NOT EXISTS workspace_api_keys (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	provider text NOT NULL,
	encrypted_key bytea NOT NULL,
	key_hint text NOT NULL,
	added_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz,
	disabled_at timestamptz,
	CONSTRAINT workspace_api_keys_provider_check CHECK (provider IN ('openai', 'openrouter')),
	CONSTRAINT workspace_api_keys_key_hint_check CHECK (char_length(key_hint) <= 16)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_api_keys_active_provider_idx
	ON workspace_api_keys(workspace_id, provider)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_api_keys_workspace_created_idx
	ON workspace_api_keys(workspace_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS byo_usage_events (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	provider text NOT NULL,
	model text NOT NULL,
	task_type text NOT NULL,
	tokens_in bigint NOT NULL DEFAULT 0,
	tokens_out bigint NOT NULL DEFAULT 0,
	est_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT byo_usage_events_provider_check CHECK (provider IN ('openai', 'openrouter')),
	CONSTRAINT byo_usage_events_task_type_check CHECK (task_type IN ('image', 'text', 'ocr')),
	CONSTRAINT byo_usage_events_units_nonnegative_check CHECK (
		tokens_in >= 0 AND tokens_out >= 0 AND est_cost_usd >= 0
	)
);

CREATE INDEX IF NOT EXISTS byo_usage_events_workspace_created_idx
	ON byo_usage_events(workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS byo_usage_events_workspace_task_created_idx
	ON byo_usage_events(workspace_id, task_type, created_at DESC, id DESC);

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'billing_addon_products_kind_check'
	) THEN
		ALTER TABLE billing_addon_products
			DROP CONSTRAINT billing_addon_products_kind_check;
	END IF;

	ALTER TABLE billing_addon_products
		ADD CONSTRAINT billing_addon_products_kind_check
		CHECK (kind IN ('ai_credits', 'storage', 'seat', 'team_jobs', 'byo_api')) NOT VALID;
END $$;

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
) VALUES (
	'byo-api',
	'byo_api',
	'Bring your own API key',
	149,
	'monthly',
	1,
	'workspace',
	'studio',
	0,
	0,
	0,
	0,
	true,
	'{"providers":["openai","openrouter"],"scope":"workspace","policyModerationBypass":true,"csamModerationBypass":false}'::jsonb,
	now()
)
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
