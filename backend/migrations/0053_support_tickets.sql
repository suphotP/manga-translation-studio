-- AI-support: durable support tickets + their message threads.
--
-- This backs the customer support inbox + the gpt-5.5 support agent. It follows
-- the same posture as notifications (0041) / project_tasks (0004):
--   * No hard FK to users (file-mode workspaces/users live only as JSON on disk),
--     nullable workspace_id text with ON DELETE SET NULL when the workspace row
--     does exist in Postgres mode.
--   * status/priority/category/author_kind are text + CHECK, NOT a Postgres enum.
--     The migration runner wraps every migration in a transaction
--     (migrations.ts client.begin(run)), so `ALTER TYPE ... ADD VALUE` is
--     impossible later; text+CHECK (the project_tasks precedent) lets us extend
--     the value set with a plain ALTER ... DROP/ADD CONSTRAINT migration.
--
-- IMPORTANT migration number: 0051 (perf_indexes) is merged and 0052 (revenue
-- payment_transactions) is in-flight, so this lands as 0053.
--
-- Two tables:
--   support_tickets          — one row per ticket, carries the agent
--                              single-flight + cost counters used by the
--                              guardrails (ai_message_count / ai_tokens_spent /
--                              last_processed_message_id).
--   support_ticket_messages  — the thread; one row per message, author_kind
--                              distinguishes customer / agent / ai / system.

CREATE TABLE IF NOT EXISTS support_tickets (
	id text PRIMARY KEY,
	requester_user_id text NOT NULL,
	workspace_id text REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
	subject text NOT NULL,
	status text NOT NULL DEFAULT 'open'
		CHECK (status IN ('open', 'pending', 'escalated', 'resolved', 'closed')),
	priority text NOT NULL DEFAULT 'normal'
		CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
	category text NOT NULL DEFAULT 'general'
		CHECK (category IN ('billing', 'technical', 'abuse', 'account', 'general')),
	assignee_user_id text,
	queue text,
	-- Agent cost/anti-abuse counters. Cumulative per ticket; the guardrails read
	-- these BEFORE each model call to enforce the per-ticket lifetime caps.
	ai_message_count integer NOT NULL DEFAULT 0,
	ai_tokens_spent bigint NOT NULL DEFAULT 0,
	-- Single-flight / idempotency marker: the id of the last customer message the
	-- agent has already processed, so concurrent double-sends / webhook retries
	-- cannot spawn two agent loops or two replies for the same trigger.
	last_processed_message_id text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Customer "my tickets" list: requester-scoped, newest first. id is tie-broken
-- DESC so the keyset cursor (before=<id>) is deterministic when two tickets
-- share an updated_at.
CREATE INDEX IF NOT EXISTS support_tickets_requester_idx
	ON support_tickets (requester_user_id, updated_at DESC, id DESC);

-- Staff inbox / triage: filter by status, newest activity first.
CREATE INDEX IF NOT EXISTS support_tickets_status_idx
	ON support_tickets (status, updated_at DESC, id DESC);

-- Assignee work queue: open work for one agent, newest activity first.
CREATE INDEX IF NOT EXISTS support_tickets_assignee_idx
	ON support_tickets (assignee_user_id, updated_at DESC, id DESC)
	WHERE assignee_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_ticket_messages (
	id text PRIMARY KEY,
	ticket_id text NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
	author_kind text NOT NULL
		CHECK (author_kind IN ('customer', 'agent', 'ai', 'system')),
	author_user_id text,
	body text NOT NULL,
	tokens integer,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- The thread read path: all messages for a ticket, oldest first. id is tie-broken
-- ASC so paging is deterministic when two messages share a created_at.
CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx
	ON support_ticket_messages (ticket_id, created_at ASC, id ASC);
