-- Revenue persistence layer.
--
-- Until now the Dodo payment.succeeded / invoice.paid / refund / dispute
-- webhooks only overwrote a single metadata string on workspace_billing_accounts;
-- the raw JSON sat in dodo_webhook_events.payload but amount/currency/date were
-- never extracted. That made MRR / revenue timeseries / a transactions list /
-- accounting CSV unbuildable.
--
-- payment_transactions is the source of truth for ALL dollar reports: one row per
-- money-movement event (a payment, a refund, or a chargeback/dispute). Amounts are
-- stored in MINOR UNITS (e.g. cents) as bigint exactly as Dodo emits them
-- (Payment.total_amount, Refund.amount are "smallest denomination of the currency";
-- Dispute.amount is a decimal string of the major-unit amount and is converted to
-- minor units on ingest). Each row is keyed for idempotent upsert on the Dodo id so
-- a re-delivered webhook (or a re-run backfill) can never double-count revenue.

CREATE TABLE IF NOT EXISTS payment_transactions (
	id text PRIMARY KEY,
	-- Workspace this money movement belongs to. Nullable: a webhook may arrive
	-- before the workspace link is resolvable (out-of-order delivery), and we still
	-- want to persist the amount rather than drop it. NOT a FK so an unlinked
	-- transaction is never lost if the workspace row is missing/deleted.
	workspace_id text,
	-- The Dodo payment id. For a payment row this is the charge; for a refund/dispute
	-- it is the payment the refund/dispute is against (so reports can join them).
	dodo_payment_id text,
	dodo_invoice_id text,
	-- The Dodo refund id (refund rows) or dispute id (dispute rows). Combined with
	-- `kind` this gives the per-event idempotency key (see dodo_event_id unique idx).
	dodo_event_ref text,
	-- The webhook-id of the Dodo delivery that produced this row, for traceability /
	-- idempotency against re-delivery. Unique so the same delivery cannot insert twice.
	dodo_event_id text,
	-- payment | refund | dispute. CHECK keeps the enum honest.
	kind text NOT NULL,
	-- Money in MINOR UNITS (cents). Positive for payments; refunds/disputes are
	-- stored as NEGATIVE so a plain SUM(amount_cents) nets correctly.
	amount_cents bigint NOT NULL DEFAULT 0,
	-- Tax portion in minor units (payments only; nullable elsewhere).
	tax_cents bigint,
	currency text,
	-- Provider status string (succeeded | refunded | opened | won | lost | ...).
	status text,
	plan_id text,
	billing_cycle text,
	-- When the money movement actually occurred (Dodo created_at), NOT when we
	-- recorded it. Reports group/timeseries on this.
	occurred_at timestamptz NOT NULL DEFAULT now(),
	-- The raw Dodo event subject for audit / re-derivation.
	raw jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_kind_check'
	) THEN
		ALTER TABLE payment_transactions
			ADD CONSTRAINT payment_transactions_kind_check
			CHECK (kind IN ('payment', 'refund', 'dispute'));
	END IF;
END $$;

-- Per-event idempotency: a given Dodo delivery (webhook-id) records at most one
-- transaction. NON-PARTIAL so `ON CONFLICT (dodo_event_id)` can infer it; NULL
-- event ids are still distinct under standard SQL NULL semantics, so legacy /
-- backfilled rows without an event id never collide.
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_dodo_event_id_key
	ON payment_transactions(dodo_event_id);

-- Logical idempotency: a given money movement (a specific payment, refund, or
-- dispute) is one row regardless of how many deliveries reference it. Backfill and
-- the live record path both upsert on this so they converge on the same row.
-- NON-PARTIAL so `ON CONFLICT (kind, dodo_event_ref)` can infer it; rows with a
-- NULL dodo_event_ref are distinct (standard SQL NULL semantics) so they never
-- collide on this index.
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_kind_ref_key
	ON payment_transactions(kind, dodo_event_ref);

-- Reports scan by workspace + time (transactions list, per-workspace revenue).
CREATE INDEX IF NOT EXISTS payment_transactions_workspace_time_idx
	ON payment_transactions(workspace_id, occurred_at DESC);

-- Global timeseries / CSV export scan by time.
CREATE INDEX IF NOT EXISTS payment_transactions_occurred_idx
	ON payment_transactions(occurred_at DESC);

-- Revenue-by-plan grouping.
CREATE INDEX IF NOT EXISTS payment_transactions_plan_time_idx
	ON payment_transactions(plan_id, occurred_at DESC)
	WHERE plan_id IS NOT NULL;

-- Dispute reporting needs the disputed amount, which 0028 chargeback_disputes
-- never captured. Add it in minor units + currency (idempotent / safe to re-run).
ALTER TABLE chargeback_disputes
	ADD COLUMN IF NOT EXISTS amount_cents bigint;

ALTER TABLE chargeback_disputes
	ADD COLUMN IF NOT EXISTS currency text;
