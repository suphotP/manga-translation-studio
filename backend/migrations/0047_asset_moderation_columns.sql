-- W1.6 moderation hardening: asset_records already carries moderation status,
-- provider, reason, detail, and checked_at from 0021. Add the ruleset version
-- for cache busting / audit explainability, and register the Studio BYO API
-- add-on product used to bypass soft policy warnings while preserving CSAM
-- hard-blocks.

ALTER TABLE asset_records
	ADD COLUMN IF NOT EXISTS moderation_ruleset_version text;

CREATE INDEX IF NOT EXISTS asset_records_workspace_moderation_idx
	ON asset_records(workspace_id, moderation_status, moderation_checked_at DESC)
	WHERE workspace_id IS NOT NULL;

INSERT INTO billing_addon_products (
	addon_id,
	kind,
	name,
	price_usd,
	billing_interval,
	units,
	unit_label,
	min_plan_id,
	active,
	metadata,
	created_at,
	updated_at
)
VALUES (
	'byo-openai-api',
	'team_jobs',
	'Bring your own OpenAI API key',
	0,
	'monthly',
	1,
	'workspace',
	'studio',
	true,
	'{"feature":"byo_openai_api","moderationSoftBypass":true}'::jsonb,
	now(),
	now()
)
ON CONFLICT (addon_id) DO UPDATE SET
	name = EXCLUDED.name,
	min_plan_id = EXCLUDED.min_plan_id,
	active = EXCLUDED.active,
	metadata = EXCLUDED.metadata,
	updated_at = now();
