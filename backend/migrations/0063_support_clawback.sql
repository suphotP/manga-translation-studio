-- AI-support OWNER-OPS: grant CLAWBACK — reverse an erroneous auto/owner-approved grant.
--
-- A clawback REVERSES a previously-executed goodwill credit grant (an AI auto-grant
-- that turned out to be erroneous, or an owner-approved grant). It deducts the
-- granted credits back out via the credits service (clamped to the unspent
-- remainder — the balance model never represents debt), is OWNER-gated, IDEMPOTENT
-- (a grant is clawed back at most once), and AUDITED as actor="owner".
--
-- We REUSE the existing support_decisions record (migration 0060) rather than a new
-- table: the clawback is just a new TERMINAL lifecycle state on the SAME decision
-- row whose grant is being reversed. This extends the `decision` CHECK with
-- 'clawed_back'. CHECK (not a Postgres enum) so the value set extends with a plain
-- DROP/ADD CONSTRAINT inside the migration's transaction (an ALTER TYPE ... ADD
-- VALUE cannot run in a transaction, which is why 0060 chose text+CHECK).
--
-- The clawback's reversal details (the reason, the credits reversed, and any
-- already-spent / unrecoverable remainder) are stored in the row's existing `params`
-- jsonb under a `clawback` key, and the reversal ref is stamped onto `executed_ref`
-- semantics by the store, so NO new column is required.
--
-- Migration number: 0062 (credit_coupon_user_scoped_idempotency) is the latest
-- merged; 0061 (tm_pgvector) is taken; this lands as 0063.

ALTER TABLE support_decisions
	DROP CONSTRAINT IF EXISTS support_decisions_decision_check;

ALTER TABLE support_decisions
	ADD CONSTRAINT support_decisions_decision_check
	CHECK (decision IN (
		'auto_approved',
		'owner_pending',
		'owner_approved',
		'owner_denied',
		'denied',
		'clawed_back'
	));
