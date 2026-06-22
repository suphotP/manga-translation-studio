-- AI-support: payment reconciliation audit trail.
--
-- The gpt-5.5 support agent's grant_credit tool can RESOLVE a confirmed
-- "paid-but-not-credited" discrepancy by minting goodwill credits bounded to the
-- discrepancy amount. Every such decision — whether it granted, did nothing, or
-- flagged the case for a human — is recorded here so the action is AUDITED and,
-- critically, IDEMPOTENT: the unique idempotency_key stops the same
-- ticket/discrepancy from ever double-granting (a retried agent loop, a
-- re-triggered /ai-respond, or a webhook double-send all converge on one row).
--
-- Posture mirrors support_tickets (0053) / payment_transactions (0052):
--   * No hard FK to users (file-mode users live only as JSON on disk); user_id is
--     plain text. ticket_id references support_tickets so a deleted ticket nulls it.
--   * action is text + CHECK (not a Postgres enum) so the value set can be extended
--     with a plain ALTER ... DROP/ADD CONSTRAINT, never an impossible-in-a-transaction
--     ALTER TYPE ... ADD VALUE (the migration runner wraps each migration in a txn).
--   * Amounts are MINOR UNITS (cents) integers, matching payment_transactions.
--
-- Migration number: 0054 (notification_preferences) is the latest merged; this
-- AI-support feature lands as 0058 (per the work spec, reserving 0055-0057).

CREATE TABLE IF NOT EXISTS payment_reconciliations (
	id text PRIMARY KEY,
	user_id text NOT NULL,
	ticket_id text REFERENCES support_tickets(id) ON DELETE SET NULL,
	-- The discrepancy the agent detected: how many minor units the customer paid
	-- but did NOT receive credits for. >= 0; 0 means "no discrepancy found".
	detected_discrepancy_cents bigint NOT NULL DEFAULT 0,
	currency text,
	-- What the agent actually did about it.
	--   none               — no discrepancy → nothing granted.
	--   granted            — the discrepancy was confirmed + bounded → credits minted.
	--   flagged_for_human  — a discrepancy may exist but the agent could not safely
	--                        confirm/bound it → escalated for human approval (no grant).
	action text NOT NULL DEFAULT 'none'
		CHECK (action IN ('none', 'granted', 'flagged_for_human')),
	-- How many minor units were actually granted (0 unless action='granted').
	granted_cents bigint NOT NULL DEFAULT 0,
	-- Who took the action: the AI agent or a human operator.
	actor text NOT NULL DEFAULT 'ai'
		CHECK (actor IN ('ai', 'human')),
	-- IDEMPOTENCY: at most one reconciliation row per logical (ticket, discrepancy)
	-- decision. A retried agent loop reuses the same key and the unique index turns
	-- the second INSERT into a conflict (the store treats it as already-handled),
	-- so the same discrepancy can NEVER be granted twice.
	idempotency_key text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Enforce single-grant-per-decision. UNIQUE (not just an index) so a concurrent
-- double-trigger races to one winner at the database layer.
CREATE UNIQUE INDEX IF NOT EXISTS payment_reconciliations_idem_idx
	ON payment_reconciliations (idempotency_key);

-- Customer history lookup: every reconciliation decision for a user, newest first.
CREATE INDEX IF NOT EXISTS payment_reconciliations_user_idx
	ON payment_reconciliations (user_id, created_at DESC, id DESC);
