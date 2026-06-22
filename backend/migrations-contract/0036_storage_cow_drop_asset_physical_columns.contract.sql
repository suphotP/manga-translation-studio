-- Contract step: asset physical storage columns move to asset_versions +
-- content_blobs. This file intentionally lives outside backend/migrations so
-- loadMigrations()/applyPendingMigrations cannot run it during the W2.8 rollout.
--
-- Spec (project-saas-roadmap-safety-queue): "DON'T drop asset_records physical
-- columns in this PR — defer to W2.8b after data verified". Keep this contract
-- as an explicit runbook step for W2.8b, not as an automatic pending migration.

DO $$
BEGIN
	IF current_setting('manga.allow_storage_cow_contract', true) IS DISTINCT FROM 'true' THEN
		RAISE EXCEPTION 'Refusing destructive storage CoW contract migration: asset_records still mirrors the legacy physical columns. Re-run with SET LOCAL manga.allow_storage_cow_contract = ''true'' once 0033-0035 have been applied and verified, and the application has been switched to read from asset_versions/content_blobs.';
	END IF;
END $$;

DROP INDEX IF EXISTS asset_records_project_sha256_idx;

ALTER TABLE asset_records
	DROP COLUMN IF EXISTS sha256,
	DROP COLUMN IF EXISTS byte_size,
	DROP COLUMN IF EXISTS storage_driver,
	DROP COLUMN IF EXISTS storage_key,
	DROP COLUMN IF EXISTS storage_status;
