// Monitoring utilities tests

import { describe, it, expect, beforeEach } from "bun:test";
import {
	checkDatabaseReadiness,
	checkMigrationReadiness,
	checkObjectStorageReadiness,
	trackAiJobStart,
	trackImageUpload,
	categorizeError,
	shouldRequireDatabaseReadiness,
	shouldRequireMigrationReadiness,
	shouldRequireObjectStorageReadiness,
	shouldRequireRedisReadiness,
	shouldRequireWorkerReadiness,
	type DatabaseReadinessClient,
} from "../services/monitoring.js";
import { loadMigrations, type MigrationSqlClient } from "../services/migrations.js";
import { aiJobDuration, aiJobErrors, imageUploadSize, imageUploadDuration, totalImagesProcessed } from "../middleware/metrics.js";
import type { AppConfig } from "../types/index.js";

describe("Monitoring Utilities", () => {
	beforeEach(() => {
		aiJobDuration.reset();
		aiJobErrors.reset();
		imageUploadSize.reset();
		imageUploadDuration.reset();
		totalImagesProcessed.reset();
	});

	describe("categorizeError", () => {
		it("categorizes timeout errors", () => {
			expect(categorizeError("timeout occurred")).toBe("timeout");
			expect(categorizeError("ETIMEDOUT")).toBe("timeout");
		});

		it("categorizes network errors", () => {
			expect(categorizeError("network failure")).toBe("network");
			expect(categorizeError("ECONNREFUSED")).toBe("network");
		});

		it("categorizes rate limit errors", () => {
			expect(categorizeError("rate limit exceeded")).toBe("rate_limit");
			expect(categorizeError("429 Too Many Requests")).toBe("rate_limit");
		});

		it("categorizes validation errors", () => {
			expect(categorizeError("validation failed")).toBe("validation");
			expect(categorizeError("invalid input")).toBe("validation");
		});

		it("categorizes auth errors", () => {
			expect(categorizeError("auth failed")).toBe("auth");
			expect(categorizeError("unauthorized")).toBe("auth");
		});

		it("defaults to unknown for unrecognized errors", () => {
			expect(categorizeError("something went wrong")).toBe("unknown");
		});
	});

	describe("trackAiJobStart", () => {
		it("tracks successful AI job completion", async () => {
			const { end } = trackAiJobStart("test-job-id");
			end("done");

			const metric = await aiJobDuration.get();
			expect(metric.values.some(value => value.labels.status === "done")).toBe(true);
		});

		it("tracks failed AI job with error categorization", async () => {
			const { end } = trackAiJobStart("test-job-id");
			end("error", "timeout occurred");

			const durationMetric = await aiJobDuration.get();
			const errorMetric = await aiJobErrors.get();
			expect(durationMetric.values.some(value => value.labels.status === "error")).toBe(true);
			expect(errorMetric.values.some(value => value.labels.error_type === "timeout")).toBe(true);
		});
	});

	describe("trackImageUpload", () => {
		it("tracks successful image upload", async () => {
			const { end } = trackImageUpload(1024000);
			end();

			const sizeMetric = await imageUploadSize.get();
			const durationMetric = await imageUploadDuration.get();
			const processedMetric = await totalImagesProcessed.get();
			expect(sizeMetric.values.length).toBeGreaterThan(0);
			expect(durationMetric.values.length).toBeGreaterThan(0);
			expect(processedMetric.values.some(value => value.value === 1)).toBe(true);
		});

		it("tracks failed image upload", async () => {
			const { end } = trackImageUpload(1024000);
			end("upload failed");

			const sizeMetric = await imageUploadSize.get();
			const durationMetric = await imageUploadDuration.get();
			expect(sizeMetric.values.length).toBeGreaterThan(0);
			expect(durationMetric.values.length).toBeGreaterThan(0);
		});
	});

	describe("shouldRequireRedisReadiness", () => {
		it("requires Redis when the rate-limit store is explicitly redis", () => {
			expect(shouldRequireRedisReadiness({ RATE_LIMIT_STORE: "redis" })).toBe(true);
		});

		it("requires Redis when REDIS_URL is set and memory mode is not forced", () => {
			expect(shouldRequireRedisReadiness({ REDIS_URL: "redis://localhost:6379" })).toBe(true);
		});

		it("skips Redis readiness in forced memory mode", () => {
			expect(shouldRequireRedisReadiness({
				RATE_LIMIT_STORE: "memory",
				ASSET_EGRESS_STORE: "memory",
				AUTH_SESSION_STORE: "file",
				AI_QUEUE_STORE: "file",
				STORAGE_QUOTA_RESERVATION_STORE: "memory",
				REDIS_URL: "redis://localhost:6379",
			})).toBe(false);
		});

		it("requires Redis when asset egress accounting is explicitly redis", () => {
			expect(shouldRequireRedisReadiness({
				RATE_LIMIT_STORE: "memory",
				ASSET_EGRESS_STORE: "redis",
			})).toBe(true);
		});

		it("requires Redis when auth sessions are explicitly Redis-backed", () => {
			expect(shouldRequireRedisReadiness({
				RATE_LIMIT_STORE: "memory",
				ASSET_EGRESS_STORE: "memory",
				AUTH_SESSION_STORE: "redis",
			})).toBe(true);
		});

		it("requires Redis when AI queue snapshots are explicitly Redis-backed", () => {
			expect(shouldRequireRedisReadiness({
				RATE_LIMIT_STORE: "memory",
				ASSET_EGRESS_STORE: "memory",
				AUTH_SESSION_STORE: "file",
				AI_QUEUE_STORE: "redis",
			})).toBe(true);
		});

		it("requires Redis when storage quota reservations are explicitly Redis-backed", () => {
			expect(shouldRequireRedisReadiness({
				RATE_LIMIT_STORE: "memory",
				ASSET_EGRESS_STORE: "memory",
				AUTH_SESSION_STORE: "file",
				AI_QUEUE_STORE: "file",
				STORAGE_QUOTA_RESERVATION_STORE: "redis",
			})).toBe(true);
		});
	});

	describe("database readiness", () => {
		it("requires database readiness when DATABASE_URL is configured", () => {
			expect(shouldRequireDatabaseReadiness({ DATABASE_URL: "postgres://localhost/app" })).toBe(true);
		});

		it("skips database readiness without DATABASE_URL or with the emergency disable flag", () => {
			expect(shouldRequireDatabaseReadiness({})).toBe(false);
			expect(shouldRequireDatabaseReadiness({
				DATABASE_URL: "postgres://localhost/app",
				READINESS_DATABASE_DISABLED: "true",
			})).toBe(false);
		});

		it("pings the database with a bounded readiness query", async () => {
			const client = new FakeDatabaseReadinessClient([{ ok: 1 }]);

			const result = await checkDatabaseReadiness({ client, timeoutMs: 50 });

			expect(result).toEqual({ healthy: true, message: "Database responding" });
			expect(client.queries).toEqual(["SELECT 1 AS ok"]);
		});

		it("reports database readiness failures without throwing", async () => {
			const client = new FakeDatabaseReadinessClient([], new Error("db offline"));

			const result = await checkDatabaseReadiness({ client, timeoutMs: 50 });

			expect(result).toEqual({ healthy: false, message: "db offline" });
		});
	});

	describe("worker readiness", () => {
		it("does not require the Python worker for the OpenAI image provider mode", () => {
			expect(shouldRequireWorkerReadiness({}, workerReadinessConfig({ sfxProviderMode: "openai-gpt-image-2" }))).toBe(false);
		});

		it("requires the Python worker when the worker provider is explicitly selected", () => {
			expect(shouldRequireWorkerReadiness({}, workerReadinessConfig({ sfxProviderMode: "python-worker" }))).toBe(true);
		});

		it("requires the Python worker for auto mode only when it is the sole usable SFX provider", () => {
			expect(shouldRequireWorkerReadiness({}, workerReadinessConfig({ sfxProviderMode: "auto" }))).toBe(true);
			expect(shouldRequireWorkerReadiness(
				{ OPENAI_API_KEY: "sk-test" },
				workerReadinessConfig({ sfxProviderMode: "auto", openaiImagesEnabled: true }),
			)).toBe(false);
			expect(shouldRequireWorkerReadiness(
				{},
				workerReadinessConfig({ sfxProviderMode: "auto", openrouterEnabled: true, openrouterApiKey: "sk-or-test" }),
			)).toBe(false);
			expect(shouldRequireWorkerReadiness(
				{},
				workerReadinessConfig({ sfxProviderMode: "auto", chatgptEnabled: false }),
			)).toBe(false);
		});

		it("never requires the Python worker when AI_PYTHON_ENABLED is off, even if selected/sole", () => {
			// W4.7 fix: aiPythonEnabled is authoritative for whether the dormant worker
			// can run. With it off, a persisted sfxProviderMode of "python-worker" or
			// "auto" must NOT make /readyz depend on the down/dormant worker.
			expect(shouldRequireWorkerReadiness(
				{},
				workerReadinessConfig({ sfxProviderMode: "python-worker", aiPythonEnabled: false }),
			)).toBe(false);
			expect(shouldRequireWorkerReadiness(
				{},
				workerReadinessConfig({ sfxProviderMode: "auto", aiPythonEnabled: false }),
			)).toBe(false);
		});

		it("allows deployment env to force or disable worker readiness", () => {
			expect(shouldRequireWorkerReadiness(
				{ READINESS_REQUIRE_WORKER: "true" },
				workerReadinessConfig({ sfxProviderMode: "openai-gpt-image-2" }),
			)).toBe(true);
			expect(shouldRequireWorkerReadiness(
				{ READINESS_REQUIRE_WORKER: "true", READINESS_WORKER_DISABLED: "true" },
				workerReadinessConfig({ sfxProviderMode: "python-worker" }),
			)).toBe(false);
		});
	});

	describe("migration readiness", () => {
		it("requires migration readiness only when explicitly enabled with DATABASE_URL", () => {
			expect(shouldRequireMigrationReadiness({
				DATABASE_URL: "postgres://localhost/app",
				READINESS_REQUIRE_MIGRATIONS: "true",
			})).toBe(true);
			expect(shouldRequireMigrationReadiness({
				DATABASE_URL: "postgres://localhost/app",
			})).toBe(false);
			expect(shouldRequireMigrationReadiness({
				READINESS_REQUIRE_MIGRATIONS: "true",
			})).toBe(false);
		});

		it("passes when all local migrations are applied", async () => {
			const client = new FakeMigrationReadinessClient("applied");

			const result = await checkMigrationReadiness({ client, timeoutMs: 50 });

			expect(result).toEqual({ healthy: true, message: "Database migrations applied" });
		});

		it("fails when migrations are pending", async () => {
			const client = new FakeMigrationReadinessClient("empty");

			const result = await checkMigrationReadiness({ client, timeoutMs: 50 });

			expect(result.healthy).toBe(false);
			expect(result.message).toContain("pending migration");
		});
	});

	describe("object storage readiness", () => {
		it("requires object storage readiness for R2 or explicit readiness enforcement", () => {
			expect(shouldRequireObjectStorageReadiness({ STORAGE_DRIVER: "r2" })).toBe(true);
			expect(shouldRequireObjectStorageReadiness({ READINESS_REQUIRE_OBJECT_STORAGE: "true" })).toBe(true);
			expect(shouldRequireObjectStorageReadiness({ STORAGE_DRIVER: "local" })).toBe(false);
			expect(shouldRequireObjectStorageReadiness({
				STORAGE_DRIVER: "r2",
				READINESS_OBJECT_STORAGE_DISABLED: "true",
			})).toBe(false);
		});

		it("checks the object storage adapter with a bounded read/write/delete probe", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2");

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: true, message: "r2 object storage read/write/delete responding" });
			expect(storage.writes).toHaveLength(1);
			expect(storage.lookups).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
			expect(storage.reads).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
			expect(storage.deletes).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
		});

		it("fails object storage readiness when a write probe cannot be read back", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2", { readBuffer: null });

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: false, message: "r2 object storage read probe returned unexpected content" });
			expect(storage.writes).toHaveLength(1);
			expect(storage.deletes).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
		});

		it("fails object storage readiness when the write probe is not visible to HEAD", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2", { exists: false });

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: false, message: "r2 object storage write probe was not readable" });
			expect(storage.writes).toHaveLength(1);
			expect(storage.deletes).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
		});

		it("fails object storage readiness when a write probe cannot be deleted", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2", { deleteResult: false });

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: false, message: "r2 object storage delete probe did not remove sentinel" });
			expect(storage.deletes.length).toBeGreaterThanOrEqual(1);
		});

		it("reports object storage readiness failures without throwing", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2", { putError: new Error("r2 offline") });

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: false, message: "r2 offline" });
		});

		it("cleans up a write probe that completes after the readiness timeout", async () => {
			const storage = new FakeObjectStorageReadinessClient("r2", { putDelayMs: 20 });

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 1 });
			await wait(40);

			expect(result).toEqual({ healthy: false, message: "Timed out after 1ms" });
			expect(storage.writes).toHaveLength(1);
			expect(storage.deletes).toEqual([{
				projectId: storage.writes[0].projectId,
				imageId: storage.writes[0].imageId,
			}]);
		});

		it("does not write a local object storage probe when readiness is explicitly enforced", async () => {
			const storage = new FakeObjectStorageReadinessClient("local");

			const result = await checkObjectStorageReadiness({ storage, timeoutMs: 50 });

			expect(result).toEqual({ healthy: true, message: "local object storage responding" });
			expect(storage.writes).toHaveLength(0);
			expect(storage.lookups).toEqual([{ projectId: "__readiness__", imageId: "probe.png" }]);
			expect(storage.reads).toHaveLength(0);
			expect(storage.deletes).toHaveLength(0);
		});
	});
});

class FakeDatabaseReadinessClient implements DatabaseReadinessClient {
	readonly queries: string[] = [];

	constructor(
		private readonly rows: Array<Record<string, unknown>>,
		private readonly error?: Error,
	) {}

	async unsafe<T = Record<string, unknown>>(query: string): Promise<T[]> {
		this.queries.push(query);
		if (this.error) throw this.error;
		return this.rows as T[];
	}
}

function workerReadinessConfig(
	overrides: Partial<Pick<AppConfig,
		| "sfxProviderMode"
		| "openaiImagesEnabled"
		| "openrouterEnabled"
		| "openrouterApiKey"
		| "chatgptEnabled"
		| "aiPythonEnabled"
		| "providerKillSwitches"
	>> = {},
): Pick<AppConfig,
	| "sfxProviderMode"
	| "openaiImagesEnabled"
	| "openrouterEnabled"
	| "openrouterApiKey"
	| "chatgptEnabled"
	| "aiPythonEnabled"
	| "providerKillSwitches"
> {
	return {
		sfxProviderMode: "openai-gpt-image-2",
		openaiImagesEnabled: false,
		openrouterEnabled: false,
		openrouterApiKey: "",
		chatgptEnabled: true,
		// W4.7: the worker can only be required when the operator has opted into the
		// dormant Python path. These readiness fixtures default it on so the existing
		// "worker required" cases exercise the readiness gate itself; the
		// aiPythonEnabled-off case is asserted explicitly below.
		aiPythonEnabled: true,
		providerKillSwitches: {},
		...overrides,
	};
}

class FakeMigrationReadinessClient implements MigrationSqlClient {
	constructor(private readonly mode: "applied" | "empty") {}

	async unsafe<T = Record<string, unknown>>(query: string): Promise<T[]> {
		if (!query.toUpperCase().includes("FROM SCHEMA_MIGRATIONS")) {
			return [] as T[];
		}
		if (this.mode === "empty") {
			return [] as T[];
		}
		return loadMigrations().map((migration) => ({
			id: migration.id,
			name: migration.name,
			checksum: migration.checksum,
			applied_at: "2026-05-13T00:00:00.000Z",
			execution_ms: 1,
		})) as T[];
	}
}

class FakeObjectStorageReadinessClient {
	readonly writes: Array<{ projectId: string; imageId: string; buffer: Buffer }> = [];
	readonly lookups: Array<{ projectId: string; imageId: string }> = [];
	readonly reads: Array<{ projectId: string; imageId: string }> = [];
	readonly deletes: Array<{ projectId: string; imageId: string }> = [];

	constructor(
		readonly driver: "local" | "r2",
		private readonly options: {
			exists?: boolean;
			putError?: Error;
			putDelayMs?: number;
			existsError?: Error;
			readBuffer?: Buffer | null;
			readError?: Error;
			deleteResult?: boolean;
			deleteError?: Error;
		} = {},
	) {}

	async putProjectImage(input: { projectId: string; imageId: string; buffer: Buffer }): Promise<{ driver: "local" | "r2"; key: string }> {
		this.writes.push(input);
		if (this.options.putDelayMs) await wait(this.options.putDelayMs);
		if (this.options.putError) throw this.options.putError;
		return { driver: this.driver, key: `projects/${input.projectId}/images/${input.imageId}` };
	}

	async hasProjectImage(input: { projectId: string; imageId: string }): Promise<boolean> {
		this.lookups.push(input);
		if (this.options.existsError) throw this.options.existsError;
		return this.options.exists ?? true;
	}

	async getProjectImage(input: { projectId: string; imageId: string }): Promise<Buffer | undefined> {
		this.reads.push(input);
		if (this.options.readError) throw this.options.readError;
		if (this.options.readBuffer === null) return undefined;
		if (this.options.readBuffer) return this.options.readBuffer;
		return this.writes.find((write) => write.projectId === input.projectId && write.imageId === input.imageId)?.buffer;
	}

	async deleteProjectImage(input: { projectId: string; imageId: string }): Promise<boolean> {
		this.deletes.push(input);
		if (this.options.deleteError) throw this.options.deleteError;
		return this.options.deleteResult ?? true;
	}
}

async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
