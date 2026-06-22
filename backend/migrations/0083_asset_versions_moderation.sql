-- Per-version moderation state for the storage copy-on-write surface.
--
-- WHY: writeBlob() persisted the moderation verdict ONLY onto the shared
-- asset_records row (keyed by asset id), even for WORKING-COPY writes. Because a
-- working copy and the live master share one asset_records row, a fail-closed
-- outage on a user's draft QUARANTINED THE LIVE MASTER for everyone, and a passed
-- draft could flip a previously-quarantined master back to released. The verdict
-- must be scoped to what the write actually produced.
--
-- asset_records already carries record-level moderation/storage_status (0021 +
-- 0047). asset_versions (0033) had NO moderation columns, so a per-version verdict
-- had nowhere to live. We add nullable columns here: a WORKING-COPY write records
-- its verdict on the VERSION row (the asset_records master status is left intact),
-- and the record status only changes on a MASTER write (or on promote of a clean
-- version). NULL = a legacy version written before this column existed (treated as
-- "no version-level verdict"; the record status still governs the master).
ALTER TABLE asset_versions
	ADD COLUMN IF NOT EXISTS moderation_status text,
	ADD COLUMN IF NOT EXISTS storage_status text,
	ADD COLUMN IF NOT EXISTS moderation_provider text,
	ADD COLUMN IF NOT EXISTS moderation_reason text,
	ADD COLUMN IF NOT EXISTS moderation_detail jsonb,
	ADD COLUMN IF NOT EXISTS moderation_checked_at timestamptz,
	ADD COLUMN IF NOT EXISTS moderation_ruleset_version text;
