import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import {
	applyPendingMigrations,
	getMigrationStatus,
	loadMigrations,
	type MigrationSqlClient,
} from "../services/migrations.js";

class FakeMigrationClient implements MigrationSqlClient {
	readonly queries: Array<{ query: string; params?: unknown[] }> = [];
	readonly appliedRows: Array<Record<string, unknown>> = [];
	lockAvailable = true;
	releaseCount = 0;

	async unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> {
		this.queries.push({ query, params });
		const normalized = query.trim().toUpperCase();
		if (normalized.startsWith("SELECT PG_TRY_ADVISORY_LOCK")) {
			return [{ locked: this.lockAvailable }] as T[];
		}
		if (normalized.startsWith("SELECT PG_ADVISORY_UNLOCK")) {
			return [{ unlocked: true }] as T[];
		}
		if (normalized.startsWith("SELECT")) {
			return this.appliedRows as T[];
		}
		if (normalized.startsWith("INSERT INTO SCHEMA_MIGRATIONS")) {
			this.appliedRows.push({
				id: params?.[0],
				name: params?.[1],
				checksum: params?.[2],
				execution_ms: params?.[3],
				applied_at: "2026-05-13T00:00:00.000Z",
			});
		}
		return [] as T[];
	}

	async begin<T>(fn: (transaction: MigrationSqlClient) => Promise<T>): Promise<T> {
		this.queries.push({ query: "BEGIN" });
		try {
			const result = await fn(this);
			this.queries.push({ query: "COMMIT" });
			return result;
		} catch (error) {
			this.queries.push({ query: "ROLLBACK" });
			throw error;
		}
	}

	async release(): Promise<void> {
		this.releaseCount += 1;
	}
}

class ReservingMigrationClient extends FakeMigrationClient {
	readonly reservedClient = new FakeMigrationClient();

	async reserve(): Promise<MigrationSqlClient & { release?(): void | Promise<void> }> {
		this.queries.push({ query: "RESERVE" });
		return this.reservedClient;
	}
}

describe("database migrations", () => {
	test("loads sorted SQL migrations with deterministic checksums", () => {
		const directory = createTempMigrationDir({
			"0002_add_usage_events.sql": "SELECT 2;",
			"0001_expand_workspace_foundation.sql": "SELECT 1;",
		});
		try {
			const migrations = loadMigrations(directory);

			expect(migrations.map((migration) => migration.id)).toEqual([
				"0001_expand_workspace_foundation",
				"0002_add_usage_events",
			]);
			expect(migrations[0].checksum).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("billing catalog migration creates plans, add-ons, accounts, and grants", () => {
		const migration = loadMigrations().find((item) => item.id === "0006_billing_plan_catalog");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS billing_plans");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS billing_addon_products");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS workspace_billing_accounts");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS workspace_addon_grants");
		expect(migration!.sql).toContain("'free'");
		expect(migration!.sql).toContain("'creator'");
		expect(migration!.sql).toContain("'credits-50'");
		expect(migration!.sql).toContain("'storage-25gb'");
		expect(migration!.sql).toContain("'seat-1'");
	});

	test("billing AI queue cap migration records launch plan limits", () => {
		const migration = loadMigrations().find((item) => item.id === "0016_billing_ai_queue_caps");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS max_ai_queue_open_jobs");
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS max_ai_queue_pending_jobs");
		expect(migration!.sql).toContain("billing_plans_ai_queue_caps_positive_check");
		expect(migration!.sql).toContain("('free', 5, 5)");
		expect(migration!.sql).toContain("('studio', 120, 80)");
	});

	test("Dodo billing migration creates customer, webhook, dispute, refund, and goodwill tables", () => {
		const migration = loadMigrations().find((item) => item.id === "0028_dodo_billing");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS chargeback_pending");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS workspace_billing_customers");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS dodo_webhook_events");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS chargeback_disputes");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS refund_events");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS goodwill_credit_grants");
	});

	test("BYO API migration creates encrypted workspace keys and usage events", () => {
		const migration = loadMigrations().find((item) => item.id === "0049_byo_api_keys");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS workspace_api_keys");
		expect(migration!.sql).toContain("encrypted_key bytea NOT NULL");
		expect(migration!.sql).toContain("CHECK (provider IN ('openai', 'openrouter'))");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS byo_usage_events");
		expect(migration!.sql).toContain("'byo-api'");
		expect(migration!.sql).toContain("'byo_api'");
	});

	test("project current state migration adds a Postgres state anchor", () => {
		const migration = loadMigrations().find((item) => item.id === "0017_project_current_state");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS current_state jsonb");
		expect(migration!.sql).toContain("projects_current_state_updated_idx");
		expect(migration!.sql).toContain("WHERE deleted_at IS NULL AND current_state IS NOT NULL");
	});

	test("work locks and states migration adds lock TTLs and workflow state machine tables", () => {
		const migration = loadMigrations().find((item) => item.id === "0037_work_locks_states");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS work_locks");
		expect(migration!.sql).toContain("'page', 'object', 'layer', 'chapter'");
		expect(migration!.sql).toContain("page_id text");
		expect(migration!.sql).toContain("work_locks_page_active_idx");
		expect(migration!.sql).toContain("work_locks_active_scope_idx");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS work_states");
		expect(migration!.sql).toContain("state IN ('draft', 'in_progress', 'submitted', 'in_qc', 'approved', 'released', 'rejected')");
		expect(migration!.sql).toContain("CONSTRAINT work_states_subject_unique UNIQUE (subject_kind, subject_id)");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS work_state_transitions");
	});

	test("usage ledger migration adds unit accounting and lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0007_usage_ledger_units_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS amount_units bigint");
		expect(migration!.sql).toContain("usage_events_workspace_subject_kind_idx");
	});

	test("auth users migration creates indexed Postgres auth storage", () => {
		const migration = loadMigrations().find((item) => item.id === "0008_auth_users");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS auth_users");
		expect(migration!.sql).toContain("email_normalized text NOT NULL UNIQUE");
		expect(migration!.sql).toContain("auth_users_external_identity_idx");
		expect(migration!.sql).toContain("auth_users_active_role_idx");
	});

	test("auth users locale migration adds a constrained UI preference column", () => {
		const migration = loadMigrations().find((item) => item.id === "0086_auth_users_locale");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS locale text");
		expect(migration!.sql).toContain("auth_users_locale_supported_check");
		expect(migration!.sql).toContain("locale IS NULL OR locale IN ('th', 'en', 'id', 'ms')");
	});

	test("auth flow migration creates reset and verification token tables", () => {
		const migration = loadMigrations().find((item) => item.id === "0029_password_resets_email_verifications");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS password_resets");
		expect(migration!.sql).toContain("token_hash text NOT NULL UNIQUE");
		expect(migration!.sql).toContain("user_id text NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS email_verification_tokens");
		expect(migration!.sql).toContain("password_resets_active_expiry_idx");
		expect(migration!.sql).toContain("email_verification_tokens_active_expiry_idx");
	});

	test("oauth sessions migration adds multi-provider identities and link intents", () => {
		const migration = loadMigrations().find((item) => item.id === "0046_oauth_sessions");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS auth_external_identities");
		expect(migration!.sql).toContain("PRIMARY KEY (provider, provider_user_id)");
		expect(migration!.sql).toContain("INSERT INTO auth_external_identities");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS oauth_link_intent_tokens");
		expect(migration!.sql).toContain("token_hash text NOT NULL UNIQUE");
		expect(migration!.sql).toContain("oauth_link_intent_tokens_user_active_idx");
	});

	test("workspace role scope migration adds scale-focused lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0009_workspace_role_scope_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("workspace_members_workspace_role_updated_idx");
		expect(migration!.sql).toContain("workspace_members_scope_gin_idx");
		expect(migration!.sql).toContain("workspace_invites_workspace_status_expires_idx");
		expect(migration!.sql).toContain("workspace_invites_scope_gin_idx");
	});

	test("project catalog query migration adds task and feedback lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0010_project_catalog_query_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("project_tasks_project_updated_idx");
		expect(migration!.sql).toContain("project_tasks_project_status_updated_idx");
		expect(migration!.sql).toContain("project_tasks_project_type_updated_idx");
		expect(migration!.sql).toContain("project_tasks_project_assignee_updated_idx");
		expect(migration!.sql).toContain("project_tasks_project_page_updated_idx");
		expect(migration!.sql).toContain("project_comments_project_updated_idx");
		expect(migration!.sql).toContain("project_comments_project_page_updated_idx");
		expect(migration!.sql).toContain("project_comments_project_layer_updated_idx");
		expect(migration!.sql).toContain("project_comments_project_author_updated_idx");
		expect(migration!.sql).toContain("project_review_decisions_project_updated_idx");
		expect(migration!.sql).toContain("project_review_decisions_project_status_updated_idx");
		expect(migration!.sql).toContain("project_review_decisions_project_actor_updated_idx");
	});

	test("per-language tracks migration adds nullable language anchors and lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0065_per_language_tracks");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS target_locales text[]");
		expect(migration!.sql).toContain("SET target_locales = ARRAY[target_locale]::text[]");
		expect(migration!.sql).toContain("ADD COLUMN IF NOT EXISTS target_lang text");
		expect(migration!.sql).toContain("SET target_lang = NULLIF(metadata->>'lang', '')");
		expect(migration!.sql).toContain("ai_jobs_project_target_lang_status_idx");
		expect(migration!.sql).toContain("SET target_lang = NULLIF(params->>'targetLang', '')");
		expect(migration!.sql).toContain("export_jobs_project_target_lang_created_idx");
		expect(migration!.sql).toContain("project_tasks_project_target_lang_status_idx");
		expect(migration!.sql).not.toContain("jsonb_set");
	});

	test("upload audit query migration adds actor and image lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0011_upload_audit_query_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("upload_audit_project_created_id_idx");
		expect(migration!.sql).toContain("upload_audit_project_source_created_idx");
		expect(migration!.sql).toContain("upload_audit_project_actor_created_idx");
		expect(migration!.sql).toContain("upload_audit_project_image_created_idx");
	});

	test("usage event query migration adds cursor and summary lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0012_usage_event_query_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("usage_events_workspace_created_idx");
		expect(migration!.sql).toContain("usage_events_workspace_kind_created_idx");
		expect(migration!.sql).toContain("usage_events_workspace_project_created_idx");
		expect(migration!.sql).toContain("usage_events_workspace_subject_created_idx");
		expect(migration!.sql).toContain("usage_events_workspace_ai_credit_subject_idx");
	});

	test("workspace access pagination migration adds list cursor indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0013_workspace_access_pagination_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("workspaces_updated_id_idx");
		expect(migration!.sql).toContain("workspace_members_user_workspace_idx");
		expect(migration!.sql).toContain("workspace_members_user_updated_idx");
		expect(migration!.sql).toContain("workspace_members_workspace_updated_idx");
		expect(migration!.sql).toContain("workspace_invites_workspace_created_id_idx");
	});

	test("storage quota workspace migration adds active project lookup indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0014_storage_quota_workspace_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("projects_workspace_project_active_idx");
		expect(migration!.sql).toContain("ON projects(workspace_id, project_id)");
		expect(migration!.sql).toContain("WHERE deleted_at IS NULL");
	});

	test("storage CoW migrations add content blobs, versions, refs, and staged backfills", () => {
		const migrations = loadMigrations();
		const create = migrations.find((item) => item.id === "0033_storage_cow");
		const blobs = migrations.find((item) => item.id === "0034_storage_cow_backfill_blobs");
		const refs = migrations.find((item) => item.id === "0035_storage_cow_backfill_refs");
		const drop = migrations.find((item) => item.id === "0036_storage_cow_drop_asset_physical_columns");
		const contract = readFileSync(join(import.meta.dir, "..", "..", "migrations-contract", "0036_storage_cow_drop_asset_physical_columns.contract.sql"), "utf-8");

		expect(create).toBeDefined();
		expect(create!.sql).toContain("CREATE TABLE IF NOT EXISTS content_blobs");
		expect(create!.sql).toContain("CREATE TABLE IF NOT EXISTS asset_versions");
		expect(create!.sql).toContain("CREATE TABLE IF NOT EXISTS asset_refs");
		expect(create!.sql).toContain("CREATE TABLE IF NOT EXISTS user_storage_accounts");
		expect(create!.sql).toContain("storage_used_bytes");
		expect(create!.sql).toContain("storage_limit_bytes");
		expect(blobs!.sql).toContain("INSERT INTO content_blobs");
		expect(blobs!.sql).toContain("INSERT INTO asset_versions");
		expect(refs!.sql).toContain("INSERT INTO asset_refs");
		expect(create!.sql).toContain("REFERENCES asset_records(id) ON DELETE CASCADE");
		expect(drop).toBeUndefined();
		expect(contract).toContain("allow_storage_cow_contract");
		expect(contract).toContain("Refusing destructive storage CoW contract migration");
		expect(contract).toContain("DROP COLUMN IF EXISTS sha256");
		expect(contract).toContain("DROP COLUMN IF EXISTS storage_key");
	});

	test("credit sharing migration creates grants, allocations, and append-only ledger tables", () => {
		const migration = loadMigrations().find((item) => item.id === "0045_credit_sharing");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS credit_grants");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS credit_allocations");
		expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS credit_ledger");
		expect(migration!.sql).toContain("credit_class IN ('shareable', 'personal')");
		expect(migration!.sql).toContain("allocated_to_scope IN ('member', 'page', 'chapter')");
		expect(migration!.sql).toContain("credit_ledger_workspace_user_class_created_idx");
	});

	test("workspace audit query migration adds cursor and filter indexes", () => {
		const migration = loadMigrations().find((item) => item.id === "0015_workspace_audit_query_indexes");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain("audit_events_workspace_created_id_idx");
		expect(migration!.sql).toContain("audit_events_workspace_action_created_idx");
		expect(migration!.sql).toContain("audit_events_workspace_entity_created_idx");
		expect(migration!.sql).toContain("ON audit_events(workspace_id, entity_type, created_at DESC, audit_event_id DESC)");
		expect(migration!.sql).toContain("audit_events_workspace_actor_created_idx");
	});

	test("perf index migration adds the batched optimization indexes idempotently", () => {
		const migration = loadMigrations().find((item) => item.id === "0051_perf_indexes");

		expect(migration).toBeDefined();
		// rank 1 (P0): unscoped reservation-workspace lookup on the AI-settle hot path.
		expect(migration!.sql).toContain("usage_events_subject_project_reserved_idx");
		expect(migration!.sql).toContain("ON usage_events(subject_id, project_id, created_at DESC)");
		expect(migration!.sql).toContain("WHERE kind = 'ai_credit_reserved'");
		// rank 2 (P0): keyset backing for the admin user list ordered by lower(name).
		expect(migration!.sql).toContain("auth_users_lower_name_id_idx");
		expect(migration!.sql).toContain("ON auth_users(lower(name), user_id)");
		// rank 3/9 (P1): covering index that bounds the TM keyset candidate scan.
		expect(migration!.sql).toContain("tm_entries_workspace_langs_created_id_idx");
		expect(migration!.sql).toContain("ON tm_entries(workspace_id, source_lang, target_lang, created_at, id)");
		// rank 10 (P2): non-partial keyset index for the global dashboard feed.
		expect(migration!.sql).toContain("projects_updated_id_active_idx");
		expect(migration!.sql).toContain("ON projects(updated_at DESC, project_id DESC)");
		expect(migration!.sql).toContain("WHERE deleted_at IS NULL");
		// rank 11 (P2): expression index for refund/dispute webhook payment lookups.
		expect(migration!.sql).toContain("workspace_billing_accounts_dodo_payment_id_idx");
		expect(migration!.sql).toContain("ON workspace_billing_accounts((metadata->>'dodo_payment_id'))");
		// rank 12 (P3): cron sweeps + admin sorts.
		expect(migration!.sql).toContain("audit_events_created_idx");
		expect(migration!.sql).toContain("usage_events_reserved_created_idx");
		expect(migration!.sql).toContain("auth_sessions_expires_idx");
		expect(migration!.sql).toContain("storage_packs_active_expires_idx");
		expect(migration!.sql).toContain("workspace_invites_expires_idx");
		expect(migration!.sql).toContain("workspace_billing_accounts_updated_id_idx");
		// rank 23 (P3): version dedupe lookup.
		expect(migration!.sql).toContain("project_versions_project_state_hash_idx");
		expect(migration!.sql).toContain("ON project_versions(project_id, state_hash)");

		// Index-only + idempotent: every executable statement is a
		// CREATE INDEX IF NOT EXISTS — nothing destructive (no DROP / ALTER /
		// DELETE / UPDATE / INSERT) and no bare CREATE INDEX that could fail on
		// re-apply. We assert against the comment-stripped code so the query
		// descriptions in the SQL comments (which mention DELETE/UPDATE/etc.) do
		// not trip the checks.
		const codeOnly = migration!.sql
			.split("\n")
			.filter((line) => !line.trim().startsWith("--"))
			.join("\n");
		const statements = codeOnly
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean);
		expect(statements.length).toBe(12);
		for (const statement of statements) {
			expect(statement.startsWith("CREATE INDEX IF NOT EXISTS")).toBe(true);
		}
		expect(codeOnly).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b/);
		expect(codeOnly).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
		// CONCURRENTLY is illegal inside the runner's per-migration transaction.
		expect(codeOnly).not.toContain("CONCURRENTLY");
	});

	test("revision number unique migration adds the parity-hardening index idempotently", () => {
		const migration = loadMigrations().find((item) => item.id === "0074_revision_number_unique");

		expect(migration).toBeDefined();
		expect(migration!.sql).toContain(
			"CREATE UNIQUE INDEX IF NOT EXISTS project_revision_requests_project_number_key",
		);
		expect(migration!.sql).toContain("ON project_revision_requests(project_id, revision_number)");

		// Index-only + idempotent: no destructive or non-idempotent statements.
		const codeOnly = migration!.sql
			.split("\n")
			.filter((line) => !line.trim().startsWith("--"))
			.join("\n");
		expect(codeOnly).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b/);
		expect(codeOnly).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
		expect(codeOnly).not.toContain("CONCURRENTLY");
	});

	test("admin content subquery migration adds the two correlated-subquery indexes idempotently", () => {
		const migration = loadMigrations().find(
			(item) => item.id === "0082_admin_content_subquery_indexes",
		);

		expect(migration).toBeDefined();
		// csam_block_count semi-join had no asset_id index at all (seqscan per project row).
		expect(migration!.sql).toContain(
			"CREATE INDEX IF NOT EXISTS csam_blocks_asset_id_idx",
		);
		expect(migration!.sql).toContain("ON csam_blocks(asset_id)");
		// flagged_asset_count: partial on project_id over the non-passed rows only, matching
		// the subquery predicate exactly so the count is a small index-only scan.
		expect(migration!.sql).toContain(
			"CREATE INDEX IF NOT EXISTS asset_records_project_flagged_idx",
		);
		expect(migration!.sql).toContain("ON asset_records(project_id)");
		expect(migration!.sql).toContain("WHERE moderation_status <> 'passed'");

		// Index-only + idempotent: no destructive or non-idempotent statements.
		const codeOnly = migration!.sql
			.split("\n")
			.filter((line) => !line.trim().startsWith("--"))
			.join("\n");
		expect(codeOnly).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b/);
		expect(codeOnly).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
		expect(codeOnly).not.toContain("CONCURRENTLY");
	});

	test("applies pending migrations transactionally and records checksums", async () => {
		const directory = createTempMigrationDir({
			"0001_expand_workspace_foundation.sql": "CREATE TABLE workspaces (workspace_id text PRIMARY KEY);",
		});
		try {
			const client = new FakeMigrationClient();
			const migrations = loadMigrations(directory);
			const applied = await applyPendingMigrations({
				client,
				migrations,
				now: createClock([1000, 1042]),
			});

			expect(applied).toHaveLength(1);
			expect(applied[0].executionMs).toBe(42);
			expect(client.queries.map((entry) => entry.query.trim().split(/\s+/)[0])).toContain("BEGIN");
			expect(client.queries.some((entry) => entry.query.includes("pg_try_advisory_lock"))).toBe(true);
			expect(client.queries.some((entry) => entry.query.includes("pg_advisory_unlock"))).toBe(true);
			expect(client.appliedRows[0]).toEqual(expect.objectContaining({
				id: "0001_expand_workspace_foundation",
				name: "expand workspace foundation",
				execution_ms: 42,
			}));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to apply when an applied migration checksum changed", async () => {
		const directory = createTempMigrationDir({
			"0001_expand_workspace_foundation.sql": "SELECT 1;",
		});
		try {
			const client = new FakeMigrationClient();
			client.appliedRows.push({
				id: "0001_expand_workspace_foundation",
				name: "expand workspace foundation",
				checksum: "different",
				execution_ms: 1,
				applied_at: "2026-05-13T00:00:00.000Z",
			});
			const migrations = loadMigrations(directory);

			const status = await getMigrationStatus({ client, migrations });
			expect(status[0].state).toBe("changed");
			await expect(applyPendingMigrations({ client, migrations })).rejects.toThrow("append-only");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to run when another migration runner holds the advisory lock", async () => {
		const directory = createTempMigrationDir({
			"0001_expand_workspace_foundation.sql": "SELECT 1;",
		});
		try {
			const client = new FakeMigrationClient();
			client.lockAvailable = false;
			const migrations = loadMigrations(directory);

			await expect(applyPendingMigrations({ client, migrations })).rejects.toThrow("Another migration runner");
			expect(client.queries.some((entry) => entry.query.includes("schema_migrations"))).toBe(false);
			expect(client.queries.some((entry) => entry.query.includes("pg_advisory_unlock"))).toBe(false);
			expect(client.releaseCount).toBe(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("uses a reserved connection for session-level migration locks", async () => {
		const directory = createTempMigrationDir({
			"0001_expand_workspace_foundation.sql": "SELECT 1;",
		});
		try {
			const client = new ReservingMigrationClient();
			const migrations = loadMigrations(directory);

			await applyPendingMigrations({ client, migrations });

			expect(client.queries.map((entry) => entry.query)).toEqual(["RESERVE"]);
			expect(client.reservedClient.queries.some((entry) => entry.query.includes("pg_try_advisory_lock"))).toBe(true);
			expect(client.reservedClient.queries.some((entry) => entry.query.includes("pg_advisory_unlock"))).toBe(true);
			expect(client.reservedClient.releaseCount).toBe(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function createTempMigrationDir(files: Record<string, string>): string {
	const directory = mkdtempSync(join(tmpdir(), "manga-migrations-"));
	for (const [fileName, contents] of Object.entries(files)) {
		writeFileSync(join(directory, fileName), contents);
	}
	return directory;
}

function createClock(values: number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}
