// Monitoring utilities — helper functions for tracking business metrics
// Integrate these into your services and routes for comprehensive observability

import { getSharedBunSql } from "./sql-pool.js";
import {
	aiJobDuration,
	aiJobErrors,
	imageUploadSize,
	imageUploadDuration,
	totalImagesProcessed,
	activeProjects,
	trackAiJobError,
	trackImageUploadError,
} from "../middleware/index.js";
import { RedisClient } from "bun";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { loadConfig, PROJECTS_DIR } from "../config.js";
import { isValidProjectId, isProjectTombstonedIn } from "../utils/security.js";
import type { AppConfig, ProviderId } from "../types/index.js";
import { createMigrationClient, getMigrationStatus, loadMigrations, type MigrationSqlClient } from "./migrations.js";
import { objectStorage, type ObjectStorage } from "./storage.js";

// ── AI Job Monitoring ───────────────────────────────────────────

export function trackAiJobStart(jobId: string) {
	const start = Date.now();
	return {
		end: (status: "done" | "error", error?: string) => {
			const duration = (Date.now() - start) / 1000;
			aiJobDuration.observe({ status }, duration);

			if (status === "error" && error) {
				aiJobErrors.inc({ error_type: categorizeError(error) });
				trackAiJobError(jobId, error);
			}
		},
	};
}

export function categorizeError(error: string): string {
	if (error.includes("timeout") || error.includes("ETIMEDOUT")) return "timeout";
	if (error.includes("network") || error.includes("ECONNREFUSED")) return "network";
	if (error.includes("rate limit") || error.includes("429")) return "rate_limit";
	if (error.includes("validation") || error.includes("invalid")) return "validation";
	if (error.includes("auth") || error.includes("unauthorized")) return "auth";
	return "unknown";
}

// ── Image Upload Monitoring ────────────────────────────────────

export function trackImageUpload(fileSize: number) {
	const start = Date.now();
	imageUploadSize.observe(fileSize);

	return {
		end: (error?: string) => {
			const duration = (Date.now() - start) / 1000;
			imageUploadDuration.observe(duration);

			if (error) {
				trackImageUploadError("upload", error);
			} else {
				totalImagesProcessed.inc();
			}
		},
	};
}

// ── Project Metrics ────────────────────────────────────────────

export function updateProjectMetrics() {
	// Count active projects
	try {
		if (existsSync(PROJECTS_DIR)) {
			// Count only real project dirs (UUID names) — skip bookkeeping dirs like
			// the deletion-tombstone store (.tombstones) so the metric stays accurate.
			// Also skip tombstoned ids whose dir survived a partial rmSync so a
			// logically-deleted project never inflates the active-project gauge.
			const projects = readdirSync(PROJECTS_DIR).filter(
				(entry) => isValidProjectId(entry) && !isProjectTombstonedIn(PROJECTS_DIR, entry),
			);
			activeProjects.set(projects.length);
		}
	} catch (error) {
		console.error("[Monitoring] Failed to update project metrics:", error);
	}
}

// Update project metrics every minute
if (typeof setInterval !== "undefined") {
	setInterval(updateProjectMetrics, 60_000);
}

// ── Health Check Metrics ───────────────────────────────────────

export interface HealthStatus {
	healthy: boolean;
	checks: Record<string, { healthy: boolean; message?: string }>;
}

export interface DatabaseReadinessClient {
	unsafe<T = Record<string, unknown>>(query: string): Promise<T[]>;
	close?(): Promise<void> | void;
}

export function shouldRequireRedisReadiness(env: Record<string, string | undefined> = process.env): boolean {
	return shouldRequireRateLimitRedis(env)
		|| shouldRequireAutoRedisStore(env, "ASSET_EGRESS_STORE", ["memory"])
		|| shouldRequireAutoRedisStore(env, "AUTH_SESSION_STORE", ["file"])
		|| shouldRequireAutoRedisStore(env, "AI_QUEUE_STORE", ["file", "memory"])
		|| shouldRequireAutoRedisStore(env, "STORAGE_QUOTA_RESERVATION_STORE", ["memory"]);
}

function shouldRequireRateLimitRedis(env: Record<string, string | undefined>): boolean {
	const selectedStore = readStoreMode(env, "RATE_LIMIT_STORE");
	return selectedStore === "redis" || (selectedStore !== "memory" && hasRedisUrl(env));
}

function shouldRequireAutoRedisStore(env: Record<string, string | undefined>, key: string, localModes: string[]): boolean {
	const selectedStore = readStoreMode(env, key);
	if (selectedStore === "redis") return true;
	if (localModes.includes(selectedStore)) return false;
	if (selectedStore && selectedStore !== "auto") return false;
	return hasRedisUrl(env);
}

function readStoreMode(env: Record<string, string | undefined>, key: string): string {
	return (env[key] ?? "").trim().toLowerCase();
}

function hasRedisUrl(env: Record<string, string | undefined>): boolean {
	return Boolean(env.REDIS_URL?.trim());
}

export function shouldRequireDatabaseReadiness(env: Record<string, string | undefined> = process.env): boolean {
	return env.READINESS_DATABASE_DISABLED !== "true" && Boolean(env.DATABASE_URL?.trim());
}

export function shouldRequireMigrationReadiness(env: Record<string, string | undefined> = process.env): boolean {
	return shouldRequireDatabaseReadiness(env) && env.READINESS_REQUIRE_MIGRATIONS === "true";
}

export function shouldRequireObjectStorageReadiness(env: Record<string, string | undefined> = process.env): boolean {
	if (env.READINESS_OBJECT_STORAGE_DISABLED === "true") return false;
	const driver = (env.STORAGE_DRIVER || "local").trim().toLowerCase();
	return driver === "r2" || env.READINESS_REQUIRE_OBJECT_STORAGE === "true";
}

export function shouldRequireWorkerReadiness(
	env: Record<string, string | undefined> = process.env,
	config: WorkerReadinessConfig = loadConfig(),
): boolean {
	if (env.READINESS_WORKER_DISABLED === "true") return false;
	if (env.READINESS_REQUIRE_WORKER === "true") return true;
	if (config.sfxProviderMode === "python-worker") return canUseWorkerProvider(config);
	if (config.sfxProviderMode !== "auto") return false;
	return canUseWorkerProvider(config) && !canUseOpenAiImageProvider(env, config) && !canUseOpenRouterProvider(config);
}

type WorkerReadinessConfig = Pick<AppConfig,
	| "sfxProviderMode"
	| "openaiImagesEnabled"
	| "openrouterEnabled"
	| "openrouterApiKey"
	| "chatgptEnabled"
	| "aiPythonEnabled"
	| "providerKillSwitches"
>;

function isProviderDisabled(config: Pick<WorkerReadinessConfig, "providerKillSwitches">, provider: ProviderId): boolean {
	return config.providerKillSwitches?.[provider] === true;
}

function canUseWorkerProvider(config: WorkerReadinessConfig): boolean {
	// W4.7: aiPythonEnabled is authoritative for whether the dormant Python worker
	// can run (see provider-controls.canUseSfxProvider). Mirror it here so /readyz
	// does not require a worker that production routing has already excluded — e.g.
	// a persisted sfxProviderMode of "auto"/"python-worker" with AI_PYTHON_ENABLED
	// left false must NOT make readiness depend on the down/dormant worker.
	return config.aiPythonEnabled && config.chatgptEnabled && !isProviderDisabled(config, "python-worker");
}

function canUseOpenAiImageProvider(env: Record<string, string | undefined>, config: WorkerReadinessConfig): boolean {
	return config.openaiImagesEnabled
		&& Boolean(env.OPENAI_API_KEY?.trim())
		&& !isProviderDisabled(config, "openai-gpt-image-2");
}

function canUseOpenRouterProvider(config: WorkerReadinessConfig): boolean {
	return config.openrouterEnabled
		&& Boolean(config.openrouterApiKey?.trim())
		&& !isProviderDisabled(config, "openrouter-gpt-5.4-image-2");
}

export async function performHealthChecks(): Promise<HealthStatus> {
	const checks: Record<string, { healthy: boolean; message?: string }> = {};

	// Check data directory
	checks.data_directory = {
		healthy: existsSync(PROJECTS_DIR),
		message: existsSync(PROJECTS_DIR) ? `${PROJECTS_DIR}` : "Data directory not found",
	};

	if (shouldRequireWorkerReadiness()) {
		try {
			const workerUrl = process.env.WORKER_URL || "http://localhost:8001";
			const response = await fetch(`${workerUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			checks.worker = {
				healthy: response.ok,
				message: response.ok ? "Worker responding" : `Status ${response.status}`,
			};
		} catch {
			checks.worker = {
				healthy: false,
				message: "Worker unreachable",
			};
		}
	}

	if (shouldRequireRedisReadiness()) {
		checks.redis = await checkRedisReadiness();
	}

	if (shouldRequireDatabaseReadiness()) {
		checks.database = await checkDatabaseReadiness();
	}

	if (shouldRequireMigrationReadiness()) {
		checks.migrations = await checkMigrationReadiness();
	}

	if (shouldRequireObjectStorageReadiness()) {
		checks.object_storage = await checkObjectStorageReadiness();
	}

	// Check memory usage. Bun/V8 heap totals can be lower than current heap usage during
	// small dev runs, so readiness should watch process RSS against a deploy budget.
	const memUsage = process.memoryUsage();
	const rssMB = memUsage.rss / 1024 / 1024;
	const maxRssMB = Number.parseInt(process.env.READINESS_MAX_RSS_MB || "1536", 10);
	checks.memory = {
		healthy: rssMB < maxRssMB,
		message: `${rssMB.toFixed(0)}MB / ${maxRssMB}MB RSS`,
	};

	return {
		healthy: Object.values(checks).every((c) => c.healthy),
		checks,
	};
}

async function checkRedisReadiness(): Promise<{ healthy: boolean; message?: string }> {
	const timeoutMs = Number.parseInt(process.env.READINESS_REDIS_TIMEOUT_MS || "1000", 10);
	const url = process.env.REDIS_URL;
	const client = url?.trim() ? new RedisClient(url) : new RedisClient();
	try {
		const response = await withTimeout(client.send("PING", []), timeoutMs);
		const ok = String(response).toUpperCase() === "PONG";
		return {
			healthy: ok,
			message: ok ? "Redis responding" : `Unexpected Redis response: ${String(response)}`,
		};
	} catch (error) {
		return {
			healthy: false,
			message: error instanceof Error ? error.message : "Redis unreachable",
		};
	} finally {
		client.close();
	}
}

export async function checkDatabaseReadiness(options: {
	client?: DatabaseReadinessClient;
	databaseUrl?: string;
	timeoutMs?: number;
} = {}): Promise<{ healthy: boolean; message?: string }> {
	const timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.READINESS_DATABASE_TIMEOUT_MS || "1000", 10);
	let client = options.client;
	try {
		client ??= createDatabaseReadinessClient(options.databaseUrl);
		const rows = await withTimeout(client.unsafe<{ ok: number | string }>("SELECT 1 AS ok"), timeoutMs);
		const ok = String(rows[0]?.ok) === "1";
		return {
			healthy: ok,
			message: ok ? "Database responding" : "Unexpected database response",
		};
	} catch (error) {
		return {
			healthy: false,
			message: error instanceof Error ? error.message : "Database unreachable",
		};
	}
	// No close: the self-created client is the process-wide SHARED pool now —
	// closing it would kill every Postgres-backed store. Injected test clients
	// own their lifecycle either way; per-probe pool churn is gone as a bonus.
}

export async function checkMigrationReadiness(options: {
	client?: MigrationSqlClient;
	timeoutMs?: number;
} = {}): Promise<{ healthy: boolean; message?: string }> {
	const timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.READINESS_DATABASE_TIMEOUT_MS || "1000", 10);
	let client = options.client;
	try {
		client ??= createMigrationClient();
		const status = await withTimeout(getMigrationStatus({
			client,
			migrations: loadMigrations(),
			ensureTable: false,
		}), timeoutMs);
		const pending = status.filter((entry) => entry.state === "pending").length;
		const unsafe = status.filter((entry) => entry.state === "changed" || entry.state === "missing").length;
		if (unsafe > 0) {
			return { healthy: false, message: `${unsafe} unsafe migration history issue(s)` };
		}
		if (pending > 0) {
			return { healthy: false, message: `${pending} pending migration(s)` };
		}
		return { healthy: true, message: "Database migrations applied" };
	} catch (error) {
		return {
			healthy: false,
			message: error instanceof Error ? error.message : "Migration readiness unavailable",
		};
	} finally {
		if (!options.client) {
			await client?.close?.();
		}
	}
}

export async function checkObjectStorageReadiness(options: {
	storage?: Pick<ObjectStorage, "driver" | "putProjectImage" | "getProjectImage" | "hasProjectImage" | "deleteProjectImage">;
	timeoutMs?: number;
} = {}): Promise<{ healthy: boolean; message?: string }> {
	const timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.READINESS_OBJECT_STORAGE_TIMEOUT_MS || "1000", 10);
	const storage = options.storage ?? objectStorage;
	if (storage.driver !== "r2") {
		return checkLocalObjectStorageReadiness(storage, timeoutMs);
	}

	const probe = {
		projectId: "__readiness__",
		imageId: `probe-${randomUUID()}.png`,
	};
	const probeBuffer = Buffer.from("ok");
	let needsCleanup = false;
	try {
		await writeObjectStorageReadinessProbe(storage, probe, probeBuffer, timeoutMs);
		needsCleanup = true;
		const exists = await withTimeout(Promise.resolve(storage.hasProjectImage(probe)), timeoutMs);
		if (!exists) {
			return {
				healthy: false,
				message: `${storage.driver} object storage write probe was not readable`,
			};
		}
		const readBuffer = await withTimeout(storage.getProjectImage(probe), timeoutMs);
		if (!readBuffer || !readBuffer.equals(probeBuffer)) {
			return {
				healthy: false,
				message: `${storage.driver} object storage read probe returned unexpected content`,
			};
		}
		const deleted = await withTimeout(storage.deleteProjectImage(probe), timeoutMs);
		needsCleanup = !deleted;
		if (!deleted) {
			return {
				healthy: false,
				message: `${storage.driver} object storage delete probe did not remove sentinel`,
			};
		}
		return {
			healthy: true,
			message: `${storage.driver} object storage read/write/delete responding`,
		};
	} catch (error) {
		return {
			healthy: false,
			message: error instanceof Error ? error.message : "Object storage unreachable",
		};
	} finally {
		if (needsCleanup) {
			try {
				await withTimeout(storage.deleteProjectImage(probe), timeoutMs);
			} catch (cleanupError) {
				console.warn("[readiness] failed to clean up object storage probe", {
					driver: storage.driver,
					projectId: probe.projectId,
					imageId: probe.imageId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			}
		}
	}
}

async function checkLocalObjectStorageReadiness(
	storage: Pick<ObjectStorage, "driver" | "hasProjectImage">,
	timeoutMs: number,
): Promise<{ healthy: boolean; message?: string }> {
	try {
		await withTimeout(Promise.resolve(storage.hasProjectImage({
			projectId: "__readiness__",
			imageId: "probe.png",
		})), timeoutMs);
		return {
			healthy: true,
			message: `${storage.driver} object storage responding`,
		};
	} catch (error) {
		return {
			healthy: false,
			message: error instanceof Error ? error.message : "Object storage unreachable",
		};
	}
}

async function writeObjectStorageReadinessProbe(
	storage: Pick<ObjectStorage, "driver" | "putProjectImage" | "deleteProjectImage">,
	probe: { projectId: string; imageId: string },
	buffer: Buffer,
	timeoutMs: number,
): Promise<void> {
	const writePromise = storage.putProjectImage({
		...probe,
		buffer,
	});
	try {
		await withTimeout(writePromise, timeoutMs);
	} catch (error) {
		if (isReadinessTimeout(error)) {
			void writePromise
				.then(() => cleanupObjectStorageProbe(storage, probe, timeoutMs))
				.catch(() => undefined);
		}
		throw error;
	}
}

async function cleanupObjectStorageProbe(
	storage: Pick<ObjectStorage, "driver" | "deleteProjectImage">,
	probe: { projectId: string; imageId: string },
	timeoutMs: number,
): Promise<void> {
	try {
		await withTimeout(storage.deleteProjectImage(probe), timeoutMs);
	} catch (cleanupError) {
		console.warn("[readiness] failed to clean up object storage probe", {
			driver: storage.driver,
			projectId: probe.projectId,
			imageId: probe.imageId,
			error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
		});
	}
}

function isReadinessTimeout(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Timed out after ");
}

function createDatabaseReadinessClient(databaseUrl = process.env.DATABASE_URL): DatabaseReadinessClient {
	if (!databaseUrl?.trim()) {
		throw new Error("DATABASE_URL is not configured");
	}
	return getSharedBunSql(databaseUrl) as unknown as DatabaseReadinessClient;
}

/**
 * Race a promise against a timeout so a hung dependency call ALWAYS settles
 * (issue #4): every reject-time fallback in the codebase is silently defeated
 * under a slow flap because a hang never reaches the `catch`. Exported so the
 * hot DB/Redis/R2/Dodo paths can bound their network ops with it.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
