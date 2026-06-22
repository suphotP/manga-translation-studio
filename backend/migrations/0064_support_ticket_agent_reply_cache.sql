-- Cache whether a support ticket thread has ever received a human agent reply.
-- The column stays nullable for backward compatibility with file/runtime rows
-- that have not been backfilled yet; this migration backfills Postgres rows so
-- new clearly-AI-owned tickets can short-circuit without a messages read.

ALTER TABLE support_tickets
	ADD COLUMN IF NOT EXISTS has_agent_reply boolean;

UPDATE support_tickets AS t
SET has_agent_reply = true
WHERE has_agent_reply IS NULL
	AND EXISTS (
		SELECT 1
		FROM support_ticket_messages AS m
		WHERE m.ticket_id = t.id
			AND m.author_kind = 'agent'
	);

UPDATE support_tickets
SET has_agent_reply = false
WHERE has_agent_reply IS NULL;

ALTER TABLE support_tickets
	ALTER COLUMN has_agent_reply SET DEFAULT false;
