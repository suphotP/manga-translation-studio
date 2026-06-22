-- AI-support OWNER-OPS: deterministic money-decision records + owner-review queue.
--
-- The support AI is only the conversational/evidence SHELL. It PROPOSES a
-- structured action; a deterministic gate (services/support/decision-policy.ts)
-- decides over SERVER-VERIFIED data whether the proposal auto-executes, must go
-- to the OWNER, or is denied. Every such decision lands here so the money path is
-- AUDITED end-to-end and, critically, IDEMPOTENT: a unique idempotency_key stops
-- the same proposal from ever double-executing (a retried agent loop, a
-- re-triggered /ai-respond, or a double owner-approve all converge on one row).
--
-- Posture mirrors payment_reconciliations (0058) / support_tickets (0053):
--   * No hard FK to users (file-mode users live only as JSON on disk); user_id is
--     plain text. ticket_id references support_tickets so a deleted ticket nulls it.
--   * action / decision are text + CHECK (NOT a Postgres enum) so the value set
--     can be extended with a plain ALTER ... DROP/ADD CONSTRAINT, never an
--     impossible-in-a-transaction ALTER TYPE ... ADD VALUE (the migration runner
--     wraps each migration in a txn).
--   * Money amounts are MINOR UNITS (cents) integers, matching payment_transactions.
--   * params / evidence are jsonb (the structured proposal + the code-computed,
--     gateway-verified evidence the gate decided over — never the customer's words).
--
-- Migration number: 0059 (support_internal_notes) is the latest merged; this
-- owner-ops feature lands as 0060 (0058/0059 already taken).

CREATE TABLE IF NOT EXISTS support_decisions (
	id text PRIMARY KEY,
	-- The ticket + requester the proposal was made for.
	ticket_id text REFERENCES support_tickets(id) ON DELETE SET NULL,
	user_id text NOT NULL,
	-- The action the AI PROPOSED. Money actions (grant_credit/refund/plan_change)
	-- can never auto-execute except an exact verified grant within caps.
	action text NOT NULL
		CHECK (action IN ('grant_credit', 'refund', 'plan_change', 'resend_verification', 'password_reset_link', 'other')),
	-- The structured proposal params (e.g. {amount, reason}) — bounded by the agent.
	params jsonb NOT NULL DEFAULT '{}'::jsonb,
	-- The SERVER-VERIFIED evidence the deterministic gate decided over: the
	-- code-computed reconciliation discrepancy, succeeded-payment flag, and opaque
	-- server-side refs. NEVER the customer's message text or the model's free-text.
	evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
	-- The AI's recommendation string (human-readable; advisory only — the gate, not
	-- this text, decides money).
	recommendation text,
	-- The lifecycle state of this decision:
	--   auto_approved   — the gate AUTO-approved an exact verified grant within caps
	--                     → executed immediately as actor 'support-ai-auto'.
	--   owner_pending   — routed to the OWNER; awaiting a one-tap approve/deny/modify.
	--   owner_approved  — the owner approved → executed as actor 'owner'.
	--   owner_denied    — the owner denied → NOTHING executed.
	--   denied          — the gate DENIED (out-of-policy) → NOTHING executed, AI explains.
	decision text NOT NULL
		CHECK (decision IN ('auto_approved', 'owner_pending', 'owner_approved', 'owner_denied', 'denied')),
	-- Stable machine reason code from the deterministic gate (audit, never free text).
	reason text,
	-- Who decided: 'ai' for the auto/deny verdicts, 'owner:<userId>' once an owner acts.
	decided_by text NOT NULL DEFAULT 'ai',
	-- Reference to the executed side effect (credit grant id / refund tx id / plan
	-- assignment), once executed. NULL until execution.
	executed_ref text,
	-- Money amounts in MINOR UNITS (cents), per the #162 money model. amount_cents is
	-- what the gate sanctioned; currency is the verified currency.
	amount_cents bigint NOT NULL DEFAULT 0,
	currency text,
	-- IDEMPOTENCY: at most one decision row per logical proposal. A retried agent
	-- loop / re-trigger reuses the same key and the unique index turns the second
	-- INSERT into a conflict (the store treats it as already-handled), so a proposal
	-- can NEVER double-execute.
	idempotency_key text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	decided_at timestamptz
);

-- Enforce single-execution-per-proposal. UNIQUE (not just an index) so a
-- concurrent double-trigger races to one winner at the database layer.
CREATE UNIQUE INDEX IF NOT EXISTS support_decisions_idem_idx
	ON support_decisions (idempotency_key);

-- Owner-review queue lookup: pending cases the owner must act on, oldest first.
CREATE INDEX IF NOT EXISTS support_decisions_pending_idx
	ON support_decisions (decision, created_at, id)
	WHERE decision = 'owner_pending';

-- Per-user history + auto-grant velocity windows.
CREATE INDEX IF NOT EXISTS support_decisions_user_idx
	ON support_decisions (user_id, created_at DESC, id DESC);

-- Circuit-breaker window scan over executed AUTO grants.
CREATE INDEX IF NOT EXISTS support_decisions_auto_window_idx
	ON support_decisions (decision, action, created_at)
	WHERE decision = 'auto_approved';
