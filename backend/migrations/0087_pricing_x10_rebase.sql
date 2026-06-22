-- 0087: pricing catalog redesign + ×10 credit rebase (owner-approved 2026-06-12).
--
-- One credit-unit is now 1/10th of its old value: a LOW image charges 10 units
-- (was 1), medium 90 (was 9), high 360 (was 36) — see cost-estimator.ts
-- QUALITY_CREDIT_UNITS and plans.ts THB_PER_CREDIT, which ship in the SAME
-- release as this migration. To keep every existing balance worth the same
-- amount of work/THB, all stored credit quantities multiply by 10 here.
--
-- This migration must run EXACTLY ONCE against pre-rebase data. The migration
-- runner records applied filenames, which is the idempotency guarantee; the
-- statements themselves are deliberately NOT self-healing (re-running would
-- ×100 balances), so never apply this file by hand outside the runner.

BEGIN;

-- ── 1. Rebase stored credit quantities (credits, not money) ─────────────────────
-- credit_grants.amount: granted credit buckets (plan_monthly/addon/goodwill/topup).
UPDATE credit_grants SET amount = amount * 10;

-- credit_ledger: every delta AND the denormalized running balance.
UPDATE credit_ledger SET delta = delta * 10, balance_after = balance_after * 10;

-- Per-member allocations carve credits out of a grant — same unit.
UPDATE credit_allocations SET amount = amount * 10;

-- Add-on purchase grants snapshot their credit quantity at purchase time.
UPDATE workspace_addon_grants SET ai_credits = ai_credits * 10 WHERE ai_credits <> 0;

-- Credit coupons grant a stored credit quantity on redeem — both the live
-- coupon definitions and the historical redemption records are credit-unit
-- amounts and must rebase with everything else (review #586 P2).
UPDATE credit_coupons SET credit_amount = credit_amount * 10;
UPDATE credit_coupon_redemptions SET credit_amount = credit_amount * 10;

-- NOTE: goodwill_credit_grants (0028) and refund_events.amount are MONEY
-- (numeric 12,2 amount_type/currency rows) and are intentionally untouched —
-- THB/USD values did not change, only the credit unit did.

-- ── 2. New plan catalog (DB rows are live: project-catalog joins billing_plans
--      for included_storage_bytes, and addon rows FK into billing_plans) ─────────
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
	-- 2 GiB / 10 GiB / 50 GiB / 200 GiB / 500 GiB
	('free',        'Free',    0,  2147483648,   100,   1,   1,   3,  2, '["low","medium"]'::jsonb,        '{"aiCredits":false,"storage":false,"seats":false,"teamJobs":false}'::jsonb, 'active', '{}'::jsonb, now()),
	('creator',     'Creator', 9,  10737418240,  1000,  5,   5,   5,  2, '["low","medium"]'::jsonb,        '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":false}'::jsonb,    'active', '{}'::jsonb, now()),
	('pro',         'Pro',     25, 53687091200,  4000,  20,  20,  20, 5, '["low","medium","high"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":false}'::jsonb,    'active', '{}'::jsonb, now()),
	('studio',      'Studio',  59, 214748364800, 11000, 100, 100, 100, 12, '["low","medium","high"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":false}'::jsonb,   'active', '{}'::jsonb, now()),
	('studio_plus', 'Studio+', 99, 536870912000, 22000, 250, 250, 250, 25, '["low","medium","high"]'::jsonb, '{"aiCredits":true,"storage":true,"seats":true,"teamJobs":false}'::jsonb,   'active', '{}'::jsonb, now())
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
	updated_at = now();

-- ── 3. Add-on catalog: new ×10 credit packs; retire legacy packs + the
--      never-enforced team-jobs dimension + BYO (liability decision) ────────────
INSERT INTO billing_addon_products (
	addon_id, kind, name, price_usd, billing_interval, units, unit_label,
	min_plan_id, ai_credits, storage_bytes, seats, team_jobs, active, metadata, updated_at
) VALUES
	('credits-500',   'ai_credits', '500 AI credits',    4,  'one_time', 500,   'credits', 'creator', 500,   0, 0, 0, true, '{}'::jsonb, now()),
	('credits-2000',  'ai_credits', '2,000 AI credits',  12, 'one_time', 2000,  'credits', 'creator', 2000,  0, 0, 0, true, '{}'::jsonb, now()),
	('credits-5000',  'ai_credits', '5,000 AI credits',  25, 'one_time', 5000,  'credits', 'creator', 5000,  0, 0, 0, true, '{}'::jsonb, now()),
	('credits-15000', 'ai_credits', '15,000 AI credits', 69, 'one_time', 15000, 'credits', 'pro',     15000, 0, 0, 0, true, '{}'::jsonb, now())
ON CONFLICT (addon_id) DO UPDATE SET
	name = EXCLUDED.name,
	price_usd = EXCLUDED.price_usd,
	units = EXCLUDED.units,
	unit_label = EXCLUDED.unit_label,
	min_plan_id = EXCLUDED.min_plan_id,
	ai_credits = EXCLUDED.ai_credits,
	active = EXCLUDED.active,
	updated_at = now();

-- Legacy pack DB rows also rebase their grant quantities (a replayed old
-- purchase must mint post-×10 units — mirrors the code catalog).
UPDATE billing_addon_products
SET ai_credits = ai_credits * 10, units = units * 10, updated_at = now()
WHERE addon_id IN ('credits-50', 'credits-200');

UPDATE billing_addon_products
SET active = false, updated_at = now()
WHERE addon_id IN ('credits-50', 'credits-200', 'team-jobs-10', 'byo-api');

COMMIT;
