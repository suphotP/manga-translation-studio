-- Credit-coupon redemption idempotency is scoped to the redeeming user.
--
-- The original index used (coupon_id, idempotency_key), which made two different
-- users collide if they submitted the same client idempotency string. Keep
-- per_user_limit in service logic, but make DB-level retry dedup match the runtime
-- identity: (coupon_id, user_id, idempotency_key).

DROP INDEX IF EXISTS credit_coupon_redemptions_idem_idx;

CREATE UNIQUE INDEX IF NOT EXISTS credit_coupon_redemptions_idem_idx
	ON credit_coupon_redemptions (coupon_id, user_id, idempotency_key);
