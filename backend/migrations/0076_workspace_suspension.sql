-- Workspace FREEZE / suspension state for refund + chargeback clawback policy.
--
-- A verified Dodo refund / chargeback FREEZES the workspace: suspended_at is the
-- instant the freeze took effect and suspended_reason records WHY ('payment_refund'
-- | 'chargeback'). While suspended_at IS NOT NULL the access layer
-- (requirePermission) blocks EVERY mutating operation on the workspace + all its
-- projects for EVERYONE (owner + every member); read/view stays allowed. The freeze
-- is lifted (suspended_at → NULL) on a subsequent successful payment or by an
-- owner/admin back-office unfreeze. Nullable + default NULL = an unfrozen workspace.
ALTER TABLE workspaces
	ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
	ADD COLUMN IF NOT EXISTS suspended_reason text;

-- Partial index so the admin "suspended workspaces" view + the access read path can
-- find frozen workspaces without scanning the full registry.
CREATE INDEX IF NOT EXISTS workspaces_suspended_idx
	ON workspaces(suspended_at)
	WHERE suspended_at IS NOT NULL;
