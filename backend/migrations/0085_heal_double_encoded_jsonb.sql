-- 0085 — Heal double-encoded jsonb documents.
--
-- Bun.SQL serializes a pre-JSON.stringify'd STRING bound to a `$N::jsonb`
-- placeholder as a jsonb STRING SCALAR (double-encoded). Every write site that
-- stringified its document was affected; the damage that matters most:
--   * notifications.metadata        — `metadata->>'__dedupeKey'` dedupe guard +
--                                     partial unique index (0080) never matched,
--                                     and the in-app i18n keys were unreadable.
--   * projects.metadata             — `metadata->>'storyId'` (0069 index) and
--                                     `metadata ? 'workspaceId'` returned nothing.
--   * workspace_billing_accounts.metadata — `metadata->>'dodo_payment_id'`
--                                     (0051/0092) + dunning reads + the
--                                     deferred_addon_grants ledger.
--   * export_jobs.params            — `params->>'usageMeteringPending'`/'targetLang'.
-- The writes are fixed in code (::text::jsonb); this migration repairs rows
-- written before the fix: a jsonb string that itself contains a JSON document
-- is unwrapped via (col #>> '{}')::jsonb.
--
-- workspace_billing_accounts.metadata needs one extra shape: `metadata || $N`
-- merges against a string scalar degrade to jsonb ARRAYS (PG wraps non-object
-- operands), accumulating one stringified-or-object patch per element. Those
-- arrays are folded back into a single object, later elements overriding
-- earlier keys (jsonb_object_agg keeps the last value per key), preserving the
-- merge order the `||` writes intended.

-- Duplicate-notification collapse MUST run before the unwrap: while metadata
-- was a string scalar, metadata->>'__dedupeKey' was NULL, so the partial
-- unique dedupe index never saw those rows and true duplicates accumulated.
-- Unwrapping would make them visible to the index in one step and abort the
-- migration with a unique violation on exactly the rows it is healing. Keep
-- the OLDEST row per (user_id, dedupe key) — original first-write-wins
-- semantics — and drop the rest. Keys are extracted shape-aware so a broken
-- string row also collides correctly against a healthy post-fix object row.
WITH keyed AS (
	SELECT id, user_id,
		CASE jsonb_typeof(metadata)
			WHEN 'string' THEN ((metadata #>> '{}')::jsonb ->> '__dedupeKey')
			ELSE metadata ->> '__dedupeKey'
		END AS dedupe_key,
		created_at
	FROM notifications
),
ranked AS (
	SELECT id, row_number() OVER (
		PARTITION BY user_id, dedupe_key
		ORDER BY created_at ASC, id ASC
	) AS rn
	FROM keyed
	WHERE dedupe_key IS NOT NULL
)
DELETE FROM notifications WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Generic string-scalar unwrap. Guarded per row by jsonb_typeof so already
-- healthy objects/arrays are untouched; a string that fails to parse as JSON
-- would abort the transaction, but every value here was produced by
-- JSON.stringify and is well-formed by construction.
UPDATE notifications SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE projects SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE projects SET current_state = (current_state #>> '{}')::jsonb WHERE jsonb_typeof(current_state) = 'string';
UPDATE export_jobs SET params = (params #>> '{}')::jsonb WHERE jsonb_typeof(params) = 'string';
UPDATE export_presets SET config = (config #>> '{}')::jsonb WHERE jsonb_typeof(config) = 'string';
UPDATE workspace_billing_accounts SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';

-- Billing metadata array fold (see header). Elements are either stringified
-- documents (pre-fix patches) or real objects (post-fix patches appended onto
-- an already-degraded array) — unwrap strings, merge objects in array order.
UPDATE workspace_billing_accounts
SET metadata = COALESCE((
	-- ORDER BY inside the aggregate is what makes "later patch wins": with
	-- duplicate keys jsonb_object_agg keeps the LAST input row, and without an
	-- explicit order the input sequence is unspecified — a stale payment/status
	-- value could otherwise resurrect over a newer one.
	SELECT jsonb_object_agg(kv.key, kv.value ORDER BY entries.ord)
	FROM (
		SELECT entry.elem, entry.ord
		FROM jsonb_array_elements(workspace_billing_accounts.metadata) WITH ORDINALITY AS entry(elem, ord)
	) AS entries,
	LATERAL jsonb_each(
		CASE jsonb_typeof(entries.elem)
			WHEN 'string' THEN (entries.elem #>> '{}')::jsonb
			WHEN 'object' THEN entries.elem
			ELSE '{}'::jsonb
		END
	) AS kv(key, value)
), '{}'::jsonb)
WHERE jsonb_typeof(metadata) = 'array';

-- Lower-traffic tables: read back via SELECT-then-JS today, but heal them too
-- so any future SQL operator/index reads real objects (and JS readers stop
-- seeing double-encoded strings).
UPDATE project_versions SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_versions SET state = (state #>> '{}')::jsonb WHERE jsonb_typeof(state) = 'string';
UPDATE project_pages SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_tasks SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_comments SET region = (region #>> '{}')::jsonb WHERE jsonb_typeof(region) = 'string';
UPDATE project_comments SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_review_decisions SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_review_assignments SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_revision_requests SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE project_version_reviews SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE usage_events SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE upload_audit_events SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE work_events SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE dodo_webhook_events SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
UPDATE storage_packs SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE support_decisions SET params = (params #>> '{}')::jsonb WHERE jsonb_typeof(params) = 'string';
UPDATE support_decisions SET evidence = (evidence #>> '{}')::jsonb WHERE jsonb_typeof(evidence) = 'string';
UPDATE consent_events SET categories = (categories #>> '{}')::jsonb WHERE jsonb_typeof(categories) = 'string';
UPDATE admin_audit SET detail = (detail #>> '{}')::jsonb WHERE jsonb_typeof(detail) = 'string';
UPDATE asset_versions SET moderation_detail = (moderation_detail #>> '{}')::jsonb WHERE jsonb_typeof(moderation_detail) = 'string';
UPDATE asset_records SET moderation_detail = (moderation_detail #>> '{}')::jsonb WHERE jsonb_typeof(moderation_detail) = 'string';
UPDATE asset_records SET derivatives = (derivatives #>> '{}')::jsonb WHERE jsonb_typeof(derivatives) = 'string';
UPDATE asset_records SET uploaded_by = (uploaded_by #>> '{}')::jsonb WHERE jsonb_typeof(uploaded_by) = 'string';
UPDATE asset_records SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
UPDATE tm_entries SET embedding = (embedding #>> '{}')::jsonb WHERE jsonb_typeof(embedding) = 'string';
UPDATE csam_blocks SET scores = (scores #>> '{}')::jsonb WHERE jsonb_typeof(scores) = 'string';
