ALTER TABLE workspaces
	ADD COLUMN IF NOT EXISTS chargeback_pending boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS workspace_billing_customers (
	workspace_id text PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	dodo_customer_id text UNIQUE NOT NULL,
	dodo_subscription_id text,
	dodo_payment_method_id text,
	status text NOT NULL DEFAULT 'active',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_billing_customers_status_check'
	) THEN
		ALTER TABLE workspace_billing_customers
			ADD CONSTRAINT workspace_billing_customers_status_check
			CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'chargeback_pending')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_billing_customers_subscription_idx
	ON workspace_billing_customers(dodo_subscription_id)
	WHERE dodo_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dodo_webhook_events (
	id text PRIMARY KEY,
	type text NOT NULL,
	payload jsonb NOT NULL,
	received_at timestamptz NOT NULL DEFAULT now(),
	processed_at timestamptz,
	error text
);

CREATE INDEX IF NOT EXISTS dodo_webhook_events_type_received_idx
	ON dodo_webhook_events(type, received_at DESC);

CREATE TABLE IF NOT EXISTS chargeback_disputes (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	dodo_dispute_id text UNIQUE NOT NULL,
	reason text,
	status text NOT NULL,
	evidence_submitted_at timestamptz,
	resolved_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chargeback_disputes_workspace_status_idx
	ON chargeback_disputes(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS refund_events (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	dodo_refund_id text UNIQUE NOT NULL,
	amount numeric(12, 2),
	currency text,
	reason text,
	initiated_by text,
	initiated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_events_workspace_time_idx
	ON refund_events(workspace_id, initiated_at DESC);

CREATE TABLE IF NOT EXISTS goodwill_credit_grants (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	user_id text,
	amount_type text NOT NULL,
	amount numeric(12, 2) NOT NULL,
	reason text,
	granted_by text,
	granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goodwill_credit_grants_workspace_time_idx
	ON goodwill_credit_grants(workspace_id, granted_at DESC);
