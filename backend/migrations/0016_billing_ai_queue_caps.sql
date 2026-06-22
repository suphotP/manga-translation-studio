ALTER TABLE billing_plans
	ADD COLUMN IF NOT EXISTS max_ai_queue_open_jobs integer NOT NULL DEFAULT 5,
	ADD COLUMN IF NOT EXISTS max_ai_queue_pending_jobs integer NOT NULL DEFAULT 5;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'billing_plans_ai_queue_caps_positive_check'
	) THEN
		ALTER TABLE billing_plans
			ADD CONSTRAINT billing_plans_ai_queue_caps_positive_check
			CHECK (max_ai_queue_open_jobs > 0 AND max_ai_queue_pending_jobs > 0) NOT VALID;
	END IF;
END $$;

UPDATE billing_plans
SET
	max_ai_queue_open_jobs = plan_caps.max_ai_queue_open_jobs,
	max_ai_queue_pending_jobs = plan_caps.max_ai_queue_pending_jobs,
	metadata = jsonb_set(
		jsonb_set(metadata, '{maxAiQueueOpenJobs}', to_jsonb(plan_caps.max_ai_queue_open_jobs), true),
		'{maxAiQueuePendingJobs}', to_jsonb(plan_caps.max_ai_queue_pending_jobs),
		true
	),
	updated_at = now()
FROM (
	VALUES
		('free', 5, 5),
		('creator', 15, 10),
		('pro', 40, 25),
		('studio', 120, 80)
) AS plan_caps(plan_id, max_ai_queue_open_jobs, max_ai_queue_pending_jobs)
WHERE billing_plans.plan_id = plan_caps.plan_id;
