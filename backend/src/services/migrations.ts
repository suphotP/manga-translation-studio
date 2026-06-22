import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";

export interface MigrationSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: MigrationSqlClient) => Promise<T>): Promise<T>;
	reserve?(): Promise<MigrationSqlClient & { release?(): void | Promise<void> }>;
	release?(): void | Promise<void>;
	close?(): Promise<void> | void;
}

export interface Migration {
	id: string;
	name: string;
	fileName: string;
	filePath: string;
	sql: string;
	checksum: string;
}

export interface AppliedMigration {
	id: string;
	name: string;
	checksum: string;
	appliedAt: string;
	executionMs: number;
}

export type MigrationState = "applied" | "pending" | "changed" | "missing";

export interface MigrationStatusEntry {
	id: string;
	name: string;
	state: MigrationState;
	checksum: string | null;
	appliedChecksum: string | null;
	appliedAt: string | null;
	migration?: Migration;
}

export interface ApplyMigrationResult {
	migration: Migration;
	executionMs: number;
}

const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9_]+$/;
const MIGRATION_ADVISORY_LOCK_KEY = 42424201;
const DEFAULT_MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	id text PRIMARY KEY,
	name text NOT NULL,
	checksum text NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	execution_ms integer NOT NULL DEFAULT 0
);
`;

interface AppliedMigrationRow {
	id: string;
	name: string;
	checksum: string;
	applied_at: Date | string;
	execution_ms: number | string;
}

export function defaultMigrationsDir(): string {
	return join(import.meta.dir, "..", "..", "migrations");
}

export function createMigrationClient(databaseUrl = process.env.DATABASE_URL): MigrationSqlClient {
	if (!databaseUrl?.trim()) {
		throw new Error("DATABASE_URL is required to run database migrations");
	}
	return new Bun.SQL(databaseUrl) as unknown as MigrationSqlClient;
}

export function loadMigrations(directory = defaultMigrationsDir()): Migration[] {
	if (!existsSync(directory)) return [];

	const seen = new Set<string>();
	return readdirSync(directory)
		.filter((fileName) => fileName.endsWith(".sql"))
		.sort((left, right) => left.localeCompare(right))
		.map((fileName) => {
			const id = basename(fileName, ".sql");
			if (!MIGRATION_ID_PATTERN.test(id)) {
				throw new Error(`Invalid migration filename "${fileName}". Expected 0001_descriptive_name.sql`);
			}
			if (seen.has(id)) {
				throw new Error(`Duplicate migration id "${id}"`);
			}
			seen.add(id);

			const filePath = join(directory, fileName);
			const sql = normalizeSql(readFileSync(filePath, "utf-8"));
			return {
				id,
				name: id.replace(/^\d+_/, "").replaceAll("_", " "),
				fileName,
				filePath,
				sql,
				checksum: checksumSql(sql),
			};
		});
}

export async function getMigrationStatus(input: {
	client: MigrationSqlClient;
	migrations?: Migration[];
	ensureTable?: boolean;
}): Promise<MigrationStatusEntry[]> {
	if (input.ensureTable ?? true) {
		await ensureMigrationTable(input.client);
	}
	const migrations = input.migrations ?? loadMigrations();
	const applied = await listAppliedMigrations(input.client);
	const appliedById = new Map(applied.map((migration) => [migration.id, migration]));
	const localById = new Map(migrations.map((migration) => [migration.id, migration]));

	const localStatus = migrations.map((migration): MigrationStatusEntry => {
		const appliedMigration = appliedById.get(migration.id);
		if (!appliedMigration) {
			return {
				id: migration.id,
				name: migration.name,
				state: "pending",
				checksum: migration.checksum,
				appliedChecksum: null,
				appliedAt: null,
				migration,
			};
		}

		const state: MigrationState = appliedMigration.checksum === migration.checksum ? "applied" : "changed";
		return {
			id: migration.id,
			name: migration.name,
			state,
			checksum: migration.checksum,
			appliedChecksum: appliedMigration.checksum,
			appliedAt: appliedMigration.appliedAt,
			migration,
		};
	});

	const missingStatus = applied
		.filter((migration) => !localById.has(migration.id))
		.map((migration): MigrationStatusEntry => ({
			id: migration.id,
			name: migration.name,
			state: "missing",
			checksum: null,
			appliedChecksum: migration.checksum,
			appliedAt: migration.appliedAt,
		}));

	return [...localStatus, ...missingStatus].sort((left, right) => left.id.localeCompare(right.id));
}

export async function applyPendingMigrations(input: {
	client: MigrationSqlClient;
	migrations?: Migration[];
	now?: () => number;
}): Promise<ApplyMigrationResult[]> {
	const clock = input.now ?? Date.now;
	const client = await reserveMigrationClient(input.client);
	let locked = false;

	try {
		locked = await acquireMigrationLock(client);
		if (!locked) {
			throw new Error("Another migration runner is already active; refusing to run migrations concurrently");
		}

		const status = await getMigrationStatus({ client, migrations: input.migrations });
		const unsafeStatus = status.filter((entry) => entry.state === "changed" || entry.state === "missing");
		if (unsafeStatus.length > 0) {
			const details = unsafeStatus.map((entry) => `${entry.id}:${entry.state}`).join(", ");
			throw new Error(`Refusing to run migrations because applied history is not append-only: ${details}`);
		}

		const pending = status
			.filter((entry): entry is MigrationStatusEntry & { migration: Migration } => entry.state === "pending" && Boolean(entry.migration))
			.map((entry) => entry.migration);
		const results: ApplyMigrationResult[] = [];

		for (const migration of pending) {
			results.push(await applyMigration(client, migration, clock));
		}

		return results;
	} finally {
		try {
			if (locked) {
				await releaseMigrationLock(client);
			}
		} finally {
			await client.release?.();
		}
	}
}

async function ensureMigrationTable(client: MigrationSqlClient): Promise<void> {
	await client.unsafe(DEFAULT_MIGRATION_TABLE_SQL);
}

async function listAppliedMigrations(client: MigrationSqlClient): Promise<AppliedMigration[]> {
	const rows = await client.unsafe<AppliedMigrationRow>(`
		SELECT id, name, checksum, applied_at, execution_ms
		FROM schema_migrations
		ORDER BY id ASC
	`);
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		checksum: row.checksum,
		appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
		executionMs: Number(row.execution_ms),
	}));
}

async function reserveMigrationClient(client: MigrationSqlClient): Promise<MigrationSqlClient> {
	return client.reserve ? client.reserve() : client;
}

async function acquireMigrationLock(client: MigrationSqlClient): Promise<boolean> {
	const rows = await client.unsafe<{ locked: boolean | string | number }>(
		"SELECT pg_try_advisory_lock($1) AS locked",
		[MIGRATION_ADVISORY_LOCK_KEY],
	);
	return rows.some((row) => row.locked === true || row.locked === "t" || row.locked === "true" || row.locked === 1);
}

async function releaseMigrationLock(client: MigrationSqlClient): Promise<void> {
	await client.unsafe("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
}

async function applyMigration(client: MigrationSqlClient, migration: Migration, now: () => number): Promise<ApplyMigrationResult> {
	const startedAt = now();
	const run = async (transaction: MigrationSqlClient): Promise<ApplyMigrationResult> => {
		await transaction.unsafe(migration.sql);
		const executionMs = Math.max(0, now() - startedAt);
		await transaction.unsafe(`
			INSERT INTO schema_migrations (id, name, checksum, execution_ms)
			VALUES ($1, $2, $3, $4)
		`, [migration.id, migration.name, migration.checksum, executionMs]);
		return { migration, executionMs };
	};

	if (client.begin) {
		return client.begin(run);
	}

	await client.unsafe("BEGIN");
	try {
		const result = await run(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		await client.unsafe("ROLLBACK");
		throw error;
	}
}

function normalizeSql(sql: string): string {
	const normalized = sql.replace(/\r\n/g, "\n").trim();
	return normalized ? `${normalized}\n` : "";
}

function checksumSql(sql: string): string {
	return createHash("sha256").update(normalizeSql(sql)).digest("hex");
}
