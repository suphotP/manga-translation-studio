-- AI-support: allow staff-only INTERNAL notes on a ticket thread.
--
-- The human staff/agent endpoints (routes/support-tickets.ts, /api/support/agent)
-- let an agent leave an `internal` note: visible to staff, NEVER shown to the
-- customer (the customer-facing thread read path filters author_kind='internal'
-- out). The original 0053 CHECK only allowed customer/agent/ai/system.
--
-- author_kind was intentionally text+CHECK (NOT a Postgres enum) precisely so the
-- value set is extensible with a plain DROP/ADD CONSTRAINT migration — the
-- migration runner wraps each migration in a transaction, so `ALTER TYPE ... ADD
-- VALUE` would be impossible here. We re-create the named CHECK so the constraint
-- is idempotent across re-runs.

ALTER TABLE support_ticket_messages
	DROP CONSTRAINT IF EXISTS support_ticket_messages_author_kind_check;

ALTER TABLE support_ticket_messages
	ADD CONSTRAINT support_ticket_messages_author_kind_check
	CHECK (author_kind IN ('customer', 'agent', 'ai', 'system', 'internal'));
