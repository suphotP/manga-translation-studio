-- Back-office: internal redeemable credit-coupons (ranks 9-11).
--
-- This is the INTERNAL credit-coupon store. It is intentionally separate from
-- Dodo discount coupons (those live entirely in Dodo and are managed via the
-- discounts API in dodo.service.ts) — a credit-coupon grants spendable AI/credit
-- balance through the existing credits service, NOT a percentage off a Dodo
-- invoice. So a credit-coupon never leaves our system.
--
-- Posture mirrors notifications (0041) / support_tickets (0053):
--   * No hard FK to users/workspaces — file-mode users/workspaces live only as
--     JSON on disk, so created_by / redeemed_by_user_id are plain text.
--   * status is text + CHECK, never a Postgres enum (the migration runner wraps
--     every migration in one transaction, so `ALTER TYPE ... ADD VALUE` would be
--     impossible later; text+CHECK lets us extend the value set with a plain
--     DROP/ADD CONSTRAINT migration).
--   * Credits are currency-agnostic internal "credits" (an integer count), so
--     there is no currency column — credit_amount is the number of credits the
--     coupon grants on redemption.
--
-- Two tables:
--   credit_coupons             — one row per coupon (code unique, credit_amount,
--                                max_redemptions, per_user_limit, expires_at,
--                                created_by, status).
--   credit_coupon_redemptions  — one row per successful redemption. Integrity is
--                                enforced by ONE unique index plus transactional
--                                guards (NOT by a (coupon_id, user_id) unique index —
--                                per_user_limit may be >1, which such an index would
--                                wrongly forbid):
--                                  * (coupon_id, idempotency_key) UNIQUE — a retried
--                                    redemption with the same key converges on the
--                                    existing row instead of reserving twice. This is
--                                    the only DB-level uniqueness guarantee.
--                                  * per_user_limit — counted inside the SAME
--                                    transaction (after SELECT ... FOR UPDATE locks
--                                    the coupon row) before inserting, so concurrent
--                                    redeems by one user serialize on the lock and
--                                    cannot exceed the per-user cap.
--                                  * max_redemptions — a conditional INSERT...SELECT
--                                    that only inserts while COUNT(redemptions) < cap,
--                                    inside the same FOR UPDATE transaction, so a race
--                                    cannot over-redeem.
--                                grant_id is filled AFTER the credits-service grant
--                                completes; a redemption with grant_id = NULL is a
--                                reservation whose grant has not finished, and the
--                                redeem route completes it idempotently on retry.

CREATE TABLE IF NOT EXISTS credit_coupons (
	id text PRIMARY KEY,
	-- Stored uppercased + unique. Codes are generated collision-resistant (or
	-- supplied by an admin and validated). Plain text per the project convention
	-- (Dodo discount codes are likewise plain) — these are low-value internal
	-- promo codes, not secrets, and admins must be able to read them back to share.
	code text NOT NULL UNIQUE,
	-- Number of internal credits granted on a single redemption. Positive integer.
	credit_amount integer NOT NULL CHECK (credit_amount > 0),
	-- The credit class the redemption grants. Mirrors credits.ts CreditClass.
	-- Redemption grants to the redeeming USER (ownerScope=user) so the credits are
	-- spendable; 'shareable' grants are owned by the user but pooled by workspace.
	credit_class text NOT NULL DEFAULT 'personal'
		CHECK (credit_class IN ('shareable', 'personal')),
	-- Total redemptions allowed across ALL users. NULL = unlimited.
	max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
	-- How many times a single user may redeem this coupon. Defaults to 1 (the
	-- typical "one per customer" promo). Must be >= 1.
	per_user_limit integer NOT NULL DEFAULT 1 CHECK (per_user_limit >= 1),
	-- Optional hard expiry. NULL = never expires.
	expires_at timestamptz,
	-- Lifecycle. 'active' coupons can be redeemed; 'disabled' ones are soft-killed
	-- by an admin and reject all redemptions while staying auditable.
	status text NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'disabled')),
	-- The admin (platform user id) who minted the coupon. Plain text (no FK).
	created_by text NOT NULL,
	-- Free-form admin note (campaign name etc.).
	note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Admin list: newest coupons first, id tie-break for deterministic ordering.
CREATE INDEX IF NOT EXISTS credit_coupons_created_idx
	ON credit_coupons (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS credit_coupon_redemptions (
	id text PRIMARY KEY,
	coupon_id text NOT NULL REFERENCES credit_coupons(id) ON DELETE CASCADE,
	-- The platform/app user who redeemed. Plain text (no FK — file-mode users).
	user_id text NOT NULL,
	-- The workspace the granted credits landed in (the user's active workspace at
	-- redemption time). Plain text — the credits service keys grants on workspace.
	workspace_id text NOT NULL,
	-- The credits service grant id produced by this redemption, for the audit trail.
	grant_id text,
	credit_amount integer NOT NULL,
	-- Caller-supplied (or derived) idempotency key. A retried redeem with the SAME
	-- key converges on the existing row instead of granting twice.
	idempotency_key text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- The ONLY uniqueness guarantee on this table: a retried redeem carrying the same
-- (coupon_id, idempotency_key) converges on the existing row instead of reserving
-- twice. We deliberately DO NOT add a (coupon_id, user_id) unique index: per_user_limit
-- can be >1, which such an index would wrongly forbid. The per-user cap (and the common
-- per_user_limit=1 "one per customer" case) is instead enforced transactionally in the
-- service — it counts this user's rows under SELECT ... FOR UPDATE on the coupon before
-- inserting. (The redeem route's default idempotency key is `${code}:${userId}`, so a
-- naive double-submit without an explicit key also collides on THIS index.)
CREATE UNIQUE INDEX IF NOT EXISTS credit_coupon_redemptions_idem_idx
	ON credit_coupon_redemptions (coupon_id, idempotency_key);

-- Count this user's redemptions of a coupon cheaply (per_user_limit enforcement)
-- and list a coupon's redemptions for stats.
CREATE INDEX IF NOT EXISTS credit_coupon_redemptions_coupon_user_idx
	ON credit_coupon_redemptions (coupon_id, user_id);
