import { summarizeAssetUsageByWorkspace, type WorkspaceAssetUsage } from "./assets.js";
import { PROJECTS_DIR } from "../config.js";
import { resolveWorkspacePlan } from "./plans.js";
import { resolveWorkspacePlanIdForProject } from "./billing-store.js";
import { projectCatalogStore } from "./project-catalog.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";
import { readdirSync } from "fs";
import { randomUUID } from "crypto";
import { RedisClient } from "bun";
import type { ProjectState } from "../types/index.js";

export interface StorageQuotaConfig {
	enforced: boolean;
	includedBytes: number;
	extraBytes: number;
	storagePackBytes: number;
	limitBytes: number;
}

export interface StorageQuotaConfigOptions {
	planId?: string;
	includedBytes?: number;
	extraBytes?: number;
	storagePackBytes?: number;
}

export interface StorageQuotaSummary {
	projectId: string;
	workspaceId: string;
	enforced: boolean;
	usedBytes: number;
	originalBytes: number;
	derivativeBytes: number;
	exportArtifactBytes: number;
	pendingBytes: number;
	reservedBytes: number;
	includedBytes: number;
	extraBytes: number;
	storagePackBytes: number;
	limitBytes: number;
	projectedBytes: number;
	remainingBytes: number;
	percentUsed: number;
	assetCount: number;
	derivativeCount: number;
	exportArtifactCount: number;
	activeReservationCount: number;
	scope?: "project" | "workspace";
	projectUsage?: StorageQuotaUsageBreakdown;
}

export interface StorageQuotaUsageBreakdown {
	usedBytes: number;
	originalBytes: number;
	derivativeBytes: number;
	exportArtifactBytes: number;
	pendingBytes: number;
	assetCount: number;
	derivativeCount: number;
	exportArtifactCount: number;
}

export interface StorageQuotaSummaryOptions {
	reservedBytes?: number;
	activeReservationCount?: number;
	workspaceId?: string;
	workspaceProjectIds?: string[];
}

export interface StorageQuotaAssertionOptions {
	reservationStore?: Pick<StorageQuotaReservationStore, "listActive">;
	now?: number;
}

export interface StorageQuotaReservation {
	reservationId: string;
	projectId: string;
	workspaceId: string;
	bytes: number;
	reason: string;
	createdAt: number;
	expiresAt: number;
	metadata?: Record<string, unknown>;
}

export interface StorageQuotaReservationInput {
	projectId: string;
	workspaceId?: string;
	bytes: number;
	reason: string;
	ttlMs?: number;
	metadata?: Record<string, unknown>;
	now?: number;
}

export interface StorageQuotaReservationResult {
	reservation: StorageQuotaReservation;
	summary: StorageQuotaSummary;
}

export interface StorageQuotaReservationReleaseResult {
	released: boolean;
	error?: string;
}

export interface StorageQuotaReservationStore {
	reserve(input: StorageQuotaReservationInput): Promise<StorageQuotaReservationResult>;
	release(projectId: string, reservationId: string): Promise<boolean>;
	listActive(workspaceId: string, now?: number): Promise<StorageQuotaReservation[]>;
}

export interface StoragePack {
	storagePackId: string;
	workspaceId: string;
	skuId?: string;
	sizeBytes: number;
	active: boolean;
	expiresAt?: number;
	createdAt?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Source of active paid storage packs for a workspace. Implementations resolve
 * packs that are active and not yet expired; the quota math sums their sizes
 * onto the base plan quota. Purchasing/billing remains out of scope.
 */
export interface StoragePackStore {
	listActive(workspaceId: string, now?: number): Promise<StoragePack[]>;
}

export class StorageQuotaExceededError extends Error {
	readonly summary: StorageQuotaSummary;
	readonly attemptedBytes: number;
	readonly reason: string;

	constructor(summary: StorageQuotaSummary, attemptedBytes: number, reason: string) {
		super("Storage quota exceeded");
		this.name = "StorageQuotaExceededError";
		this.summary = summary;
		this.attemptedBytes = attemptedBytes;
		this.reason = reason;
	}
}

const DEFAULT_INCLUDED_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Default store with no packs. In the Postgres production path the
 * `storage_packs` table is already folded into the workspace storage plan's
 * `extraStorageBytes` by `PostgresProjectCatalogStore.getProjectWorkspaceStoragePlan`,
 * so the effective quota reflects active packs without this global store. This
 * store is the safe fallback for the file-backed path and tests, and a custom
 * `StoragePackStore` can still be injected via `setStoragePackStoreForTests`.
 */
export class EmptyStoragePackStore implements StoragePackStore {
	async listActive(): Promise<StoragePack[]> {
		return [];
	}
}

/** In-memory store for tests and prototype usage. */
export class MemoryStoragePackStore implements StoragePackStore {
	private readonly packs: StoragePack[];

	constructor(packs: StoragePack[] = []) {
		this.packs = packs;
	}

	async listActive(workspaceId: string, now = Date.now()): Promise<StoragePack[]> {
		return this.packs.filter((pack) => pack.workspaceId === workspaceId && isStoragePackActive(pack, now));
	}
}

export let storagePackStore: StoragePackStore = new EmptyStoragePackStore();

export function setStoragePackStoreForTests(store: StoragePackStore): () => void {
	const previous = storagePackStore;
	storagePackStore = store;
	return () => {
		storagePackStore = previous;
	};
}

/** True when a pack is active and not yet expired. */
export function isStoragePackActive(pack: StoragePack, now = Date.now()): boolean {
	if (!pack.active) return false;
	if (typeof pack.expiresAt === "number" && Number.isFinite(pack.expiresAt) && pack.expiresAt <= now) return false;
	return true;
}

/** Sum the byte sizes of active, non-expired packs. */
export function sumActiveStoragePacks(packs: StoragePack[], now = Date.now()): number {
	return packs.reduce((total, pack) => (isStoragePackActive(pack, now) ? total + safeByteCount(pack.sizeBytes) : total), 0);
}

/** List active, non-expired storage packs for a workspace via the configured store. */
export async function listActiveStoragePacksForWorkspace(workspaceId: string, now = Date.now()): Promise<StoragePack[]> {
	const normalized = workspaceId.trim();
	if (!normalized) return [];
	const packs = await storagePackStore.listActive(normalized, now);
	return packs.filter((pack) => isStoragePackActive(pack, now));
}

/** Total active storage pack bytes raising a workspace's effective quota. */
export async function sumActiveStoragePackBytesForWorkspace(workspaceId: string, now = Date.now()): Promise<number> {
	const packs = await listActiveStoragePacksForWorkspace(workspaceId, now);
	return sumActiveStoragePacks(packs, now);
}

export function readStorageQuotaConfig(options: StorageQuotaConfigOptions = {}): StorageQuotaConfig {
	const plan = resolveWorkspacePlan(options.planId);
	const explicitIncludedBytes = readOptionalByteCount(options.includedBytes);
	const planIncludedBytes = explicitIncludedBytes ?? readOptionalByteCount(plan.includedStorageBytes) ?? DEFAULT_INCLUDED_STORAGE_BYTES;
	const planExtraBytes = safeByteCount(options.extraBytes);
	const includedBytes = readIncludedStorageBytesEnv(planIncludedBytes);
	const extraBytes = readExtraStorageBytesEnv(planExtraBytes);
	const storagePackBytes = safeByteCount(options.storagePackBytes);
	// effectiveQuota = basePlanQuota (included + env extra) + sum(active, non-expired storage packs)
	const limitBytes = includedBytes + extraBytes + storagePackBytes;
	return {
		enforced: readBooleanEnv("WORKSPACE_STORAGE_QUOTA_ENFORCED", true),
		includedBytes,
		extraBytes,
		storagePackBytes,
		limitBytes,
	};
}

/**
 * Resolve the plan/pack-derived EFFECTIVE storage limit (bytes) for a WORKSPACE,
 * using the exact same included + extra (addon grants + active storage packs)
 * computation as the project-keyed quota path. The CoW write gate consults this
 * so the two quota subsystems agree on the limit instead of the CoW gate falling
 * back to the hardcoded 1 GiB row default (S1).
 *
 * Returns `null` when no plan can be resolved for the workspace (unknown
 * workspace / file mode with no record), so the caller can keep the row's stored
 * limit. The included-storage env override (WORKSPACE_STORAGE_INCLUDED_BYTES) and
 * the active in-memory pack store are honored exactly as readStorageQuotaConfig does.
 */
export async function resolveWorkspaceEffectiveStorageLimitBytes(workspaceId: string): Promise<number | null> {
	const normalized = workspaceId.trim();
	if (!normalized) return null;
	const plan = await projectCatalogStore?.getWorkspaceStoragePlan(normalized);
	if (!plan) return null;
	// In Postgres production, active storage_packs + addon grants are already folded
	// into plan.extraStorageBytes by getWorkspaceStoragePlan, so the default
	// EmptyStoragePackStore returns 0 here and packs are not double counted. An
	// injected store (tests) adds on top via storagePackBytes — mirroring
	// resolveProjectStorageQuotaContext.
	const storagePackBytes = await sumActiveStoragePackBytesForWorkspace(normalized);
	const config = readStorageQuotaConfig({
		planId: plan.planId ?? "free",
		includedBytes: plan.includedStorageBytes,
		extraBytes: plan.extraStorageBytes,
		storagePackBytes,
	});
	return config.limitBytes;
}

export async function summarizeProjectStorageQuota(projectId: string, pendingBytes = 0, options: StorageQuotaSummaryOptions = {}): Promise<StorageQuotaSummary> {
	const config = readStorageQuotaConfig();
	return summarizeProjectStorageQuotaWithConfig(projectId, config, pendingBytes, options, options.workspaceId ?? projectId);
}

export async function summarizeProjectStorageQuotaForBilling(projectId: string, pendingBytes = 0, options: StorageQuotaSummaryOptions = {}): Promise<StorageQuotaSummary> {
	const context = await resolveProjectStorageQuotaContext(projectId);
	return summarizeProjectStorageQuotaWithConfig(projectId, context.config, pendingBytes, {
		...options,
		workspaceProjectIds: options.workspaceProjectIds ?? context.projectIds,
	}, context.workspaceId);
}

export async function summarizeProjectStorageQuotaForProjectView(projectId: string, pendingBytes = 0): Promise<StorageQuotaSummary> {
	const context = await resolveProjectStorageQuotaContext(projectId);
	const activeReservations = await storageQuotaReservationStore.listActive(context.workspaceId);
	const reservedBytes = sumReservationBytes(activeReservations);
	const projectIds = normalizeWorkspaceProjectIds(projectId, context.projectIds);
	// Fetch the workspace asset usage ONCE and serve both the workspace-scoped
	// summary and the single-project breakdown from the same result set. This
	// removes the prior double aggregate (one workspace + one single-project call)
	// on the hottest read/upload path.
	const usage = await summarizeAssetUsageByWorkspace(context.workspaceId, projectIds);
	const workspaceSummary = buildStorageQuotaSummary(projectId, context.workspaceId, projectIds, usage, context.config, pendingBytes, {
		workspaceProjectIds: projectIds,
		reservedBytes,
		activeReservationCount: activeReservations.length,
	});
	const projectSummary = buildStorageQuotaSummary(projectId, context.workspaceId, [projectId], usage, context.config, pendingBytes, {
		workspaceProjectIds: [projectId],
	});
	return {
		...workspaceSummary,
		scope: "workspace",
		projectUsage: toStorageQuotaUsageBreakdown(projectSummary),
	};
}

async function summarizeProjectStorageQuotaWithConfig(
	projectId: string,
	config: StorageQuotaConfig,
	pendingBytes = 0,
	options: StorageQuotaSummaryOptions = {},
	workspaceId = projectId,
): Promise<StorageQuotaSummary> {
	const projectIds = normalizeWorkspaceProjectIds(projectId, options.workspaceProjectIds);
	// ONE aggregate over asset_records (Postgres: a single grouped query backed by
	// the project/workspace index; file mode: per-project on-disk reads), instead
	// of one list query per project + a JS reduce. This is the hot read/upload
	// path, so the prior N+1 is collapsed to a single round trip.
	const usage = await summarizeAssetUsageByWorkspace(workspaceId, projectIds);
	return buildStorageQuotaSummary(projectId, workspaceId, projectIds, usage, config, pendingBytes, options);
}

/**
 * Build a storage quota summary from a pre-aggregated per-project usage map. The
 * usage map is fetched ONCE per workspace (see {@link summarizeAssetUsageByWorkspace})
 * and reused for both the workspace-scoped summary and the single-project
 * breakdown, so the project-view path no longer issues a second asset aggregate.
 * Export artifacts are summed from local state.json (no DB table), unchanged.
 */
function buildStorageQuotaSummary(
	projectId: string,
	workspaceId: string,
	projectIds: string[],
	usage: WorkspaceAssetUsage,
	config: StorageQuotaConfig,
	pendingBytes: number,
	options: StorageQuotaSummaryOptions,
): StorageQuotaSummary {
	let originalBytes = 0;
	let derivativeBytes = 0;
	let derivativeCount = 0;
	let assetCount = 0;
	for (const activeProjectId of projectIds) {
		const projectUsage = usage.get(activeProjectId);
		if (!projectUsage) continue;
		originalBytes += projectUsage.originalBytes;
		derivativeBytes += projectUsage.derivativeBytes;
		derivativeCount += projectUsage.derivativeCount;
		assetCount += projectUsage.assetCount;
	}
	const exportArtifacts = projectIds.flatMap((activeProjectId) => listExportArtifacts(activeProjectId));
	const exportArtifactBytes = exportArtifacts.reduce((total, artifact) => total + safeByteCount(artifact.sizeBytes), 0);
	const usedBytes = originalBytes + derivativeBytes + exportArtifactBytes;
	const normalizedPendingBytes = Math.max(0, pendingBytes);
	const reservedBytes = safeByteCount(options.reservedBytes);
	const activeReservationCount = Math.max(0, Math.trunc(options.activeReservationCount ?? 0));
	const projectedBytes = usedBytes + normalizedPendingBytes + reservedBytes;
	const remainingBytes = Math.max(0, config.limitBytes - projectedBytes);
	const percentUsed = config.limitBytes > 0 ? Math.min(999, Math.round((projectedBytes / config.limitBytes) * 10000) / 100) : 0;

	return {
		projectId,
		workspaceId,
		enforced: config.enforced,
		usedBytes,
		originalBytes,
		derivativeBytes,
		exportArtifactBytes,
		pendingBytes: normalizedPendingBytes,
		reservedBytes,
		includedBytes: config.includedBytes,
		extraBytes: config.extraBytes,
		storagePackBytes: config.storagePackBytes,
		limitBytes: config.limitBytes,
		projectedBytes,
		remainingBytes,
		percentUsed,
		assetCount,
		derivativeCount,
		exportArtifactCount: exportArtifacts.length,
		activeReservationCount,
	};
}

function toStorageQuotaUsageBreakdown(summary: StorageQuotaSummary): StorageQuotaUsageBreakdown {
	return {
		usedBytes: summary.usedBytes,
		originalBytes: summary.originalBytes,
		derivativeBytes: summary.derivativeBytes,
		exportArtifactBytes: summary.exportArtifactBytes,
		pendingBytes: summary.pendingBytes,
		assetCount: summary.assetCount,
		derivativeCount: summary.derivativeCount,
		exportArtifactCount: summary.exportArtifactCount,
	};
}

async function resolveProjectStorageQuotaContext(projectId: string, workspaceIdOverride?: string): Promise<{ workspaceId: string; config: StorageQuotaConfig; projectIds: string[] }> {
	const catalogPlan = await projectCatalogStore?.getProjectWorkspaceStoragePlan(projectId);
	if (catalogPlan) {
		const workspaceId = workspaceIdOverride?.trim() || catalogPlan.workspaceId;
		const projectIds = normalizeWorkspaceProjectIds(projectId, catalogPlan.projectIds);
		// In Postgres production, active `storage_packs` are already summed into
		// catalogPlan.extraStorageBytes by getProjectWorkspaceStoragePlan, so the
		// default EmptyStoragePackStore returns 0 here and packs are not double
		// counted. An injected store (tests) adds on top via storagePackBytes.
		const storagePackBytes = await sumActiveStoragePackBytesForWorkspace(workspaceId);
		const config = readStorageQuotaConfig({
			planId: catalogPlan.planId ?? "free",
			includedBytes: catalogPlan.includedStorageBytes,
			extraBytes: catalogPlan.extraStorageBytes,
			storagePackBytes,
		});
		return { workspaceId, config, projectIds };
	}

	const fileContext = resolveFileProjectStorageQuotaContext(projectId, workspaceIdOverride);
	const storagePackBytes = await sumActiveStoragePackBytesForWorkspace(fileContext.workspaceId);
	// File mode (no Postgres catalog): route plan resolution through the billing
	// store so a plan assigned via PUT /api/billing/:workspaceId/plan raises the
	// workspace's included-storage quota. The resolver falls back to the
	// WORKSPACE_PLAN_ID env default when nothing is assigned, preserving prior
	// behaviour. (The Postgres path resolves the plan via the catalog join above.)
	const planId = await resolveWorkspacePlanIdForProject(projectId, { workspaceId: fileContext.workspaceId });
	const config = readStorageQuotaConfig({ planId, storagePackBytes });
	return { workspaceId: fileContext.workspaceId, config, projectIds: fileContext.projectIds };
}

function resolveFileProjectStorageQuotaContext(projectId: string, workspaceIdOverride?: string): { workspaceId: string; projectIds: string[] } {
	const currentState = readProjectStateForStorage(projectId);
	const workspaceId = workspaceIdOverride?.trim() || currentState?.workspaceId?.trim() || projectId;
	if (!workspaceId || workspaceId === projectId) {
		return { workspaceId: projectId, projectIds: [projectId] };
	}

	const projectIds = new Set<string>([projectId]);
	try {
		for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidateProjectId = entry.name.trim();
			if (!candidateProjectId || candidateProjectId === projectId) continue;
			const state = readProjectStateForStorage(candidateProjectId);
			if (state?.workspaceId?.trim() === workspaceId) {
				projectIds.add(candidateProjectId);
			}
		}
	} catch {
		return { workspaceId, projectIds: [projectId] };
	}

	return { workspaceId, projectIds: [...projectIds].sort() };
}

function readProjectStateForStorage(projectId: string): Pick<ProjectState, "workspaceId"> | null {
	// Tombstone-aware: a permanently-deleted project (even one whose state.json
	// survived a partial rmSync) must not count toward a workspace's storage quota
	// nor be enumerated into the workspace's project set.
	return readProjectStateFileGuarded<ProjectState>(projectId);
}

export async function assertProjectStorageQuota(
	projectId: string,
	pendingBytes: number,
	reason: string,
	options: StorageQuotaAssertionOptions = {},
): Promise<StorageQuotaSummary> {
	const reservationStore = options.reservationStore ?? storageQuotaReservationStore;
	const context = await resolveProjectStorageQuotaContext(projectId);
	const activeReservations = await reservationStore.listActive(context.workspaceId, options.now);
	const summary = await summarizeProjectStorageQuotaWithConfig(projectId, context.config, pendingBytes, {
		workspaceProjectIds: context.projectIds,
		reservedBytes: sumReservationBytes(activeReservations),
		activeReservationCount: activeReservations.length,
	}, context.workspaceId);
	if (summary.enforced && summary.projectedBytes > summary.limitBytes) {
		throw new StorageQuotaExceededError(summary, pendingBytes, reason);
	}
	return summary;
}

export class MemoryStorageQuotaReservationStore implements StorageQuotaReservationStore {
	private readonly reservations = new Map<string, StorageQuotaReservation>();

	async reserve(input: StorageQuotaReservationInput): Promise<StorageQuotaReservationResult> {
		const now = input.now ?? Date.now();
		this.prune(now);
		const context = await resolveProjectStorageQuotaContext(input.projectId, input.workspaceId);
		const active = this.activeForWorkspace(context.workspaceId, now);
		const bytes = safeByteCount(input.bytes);
		const summary = await summarizeProjectStorageQuotaWithConfig(input.projectId, context.config, bytes, {
			workspaceProjectIds: context.projectIds,
			reservedBytes: sumReservationBytes(active),
			activeReservationCount: active.length,
		}, context.workspaceId);
		if (summary.enforced && summary.projectedBytes > summary.limitBytes) {
			throw new StorageQuotaExceededError(summary, bytes, input.reason);
		}
		const reservation = createStorageReservation({ ...input, workspaceId: context.workspaceId }, bytes, now);
		this.reservations.set(reservation.reservationId, reservation);
		return { reservation, summary };
	}

	async release(_projectId: string, reservationId: string): Promise<boolean> {
		return this.reservations.delete(reservationId);
	}

	async listActive(workspaceId: string, now = Date.now()): Promise<StorageQuotaReservation[]> {
		this.prune(now);
		return this.activeForWorkspace(workspaceId, now);
	}

	private activeForWorkspace(workspaceId: string, now: number): StorageQuotaReservation[] {
		return [...this.reservations.values()].filter((reservation) => reservation.workspaceId === workspaceId && reservation.expiresAt > now);
	}

	private prune(now: number): void {
		for (const [reservationId, reservation] of this.reservations.entries()) {
			if (reservation.expiresAt <= now) {
				this.reservations.delete(reservationId);
			}
		}
	}
}

export class RedisStorageQuotaReservationStore implements StorageQuotaReservationStore {
	private readonly client: RedisClient;
	private readonly reservationsKey: string;
	private readonly lockKey: string;

	constructor(url = process.env.REDIS_URL, keyPrefix = process.env.STORAGE_QUOTA_REDIS_KEY_PREFIX || "manga-editor:storage-quota") {
		this.client = url?.trim() ? new RedisClient(url) : new RedisClient();
		this.reservationsKey = `${keyPrefix}:reservations`;
		this.lockKey = `${keyPrefix}:lock`;
	}

	async reserve(input: StorageQuotaReservationInput): Promise<StorageQuotaReservationResult> {
		return this.withMutationLock(async (lockToken) => {
			const now = input.now ?? Date.now();
			const all = await this.readReservations();
			await this.deleteExpired(all, now);
			const context = await resolveProjectStorageQuotaContext(input.projectId, input.workspaceId);
			const active = all.filter((reservation) => reservation.workspaceId === context.workspaceId && reservation.expiresAt > now);
			const bytes = safeByteCount(input.bytes);
			const summary = await summarizeProjectStorageQuotaWithConfig(input.projectId, context.config, bytes, {
				workspaceProjectIds: context.projectIds,
				reservedBytes: sumReservationBytes(active),
				activeReservationCount: active.length,
			}, context.workspaceId);
			if (summary.enforced && summary.projectedBytes > summary.limitBytes) {
				throw new StorageQuotaExceededError(summary, bytes, input.reason);
			}
			const reservation = createStorageReservation({ ...input, workspaceId: context.workspaceId }, bytes, now);
			await this.writeReservationUnderLock(lockToken, reservation);
			return { reservation, summary };
		});
	}

	async release(_projectId: string, reservationId: string): Promise<boolean> {
		const deleted = await this.client.send("HDEL", [this.reservationsKey, reservationId]);
		return Number(deleted) > 0;
	}

	async listActive(workspaceId: string, now = Date.now()): Promise<StorageQuotaReservation[]> {
		const all = await this.readReservations();
		await this.deleteExpired(all, now);
		return all.filter((reservation) => reservation.workspaceId === workspaceId && reservation.expiresAt > now);
	}

	private async withMutationLock<T>(operation: (lockToken: string) => Promise<T>): Promise<T> {
		const token = randomUUID();
		const deadline = Date.now() + readPositiveIntegerEnv("STORAGE_QUOTA_REDIS_LOCK_WAIT_MS", 5000);
		const ttlMs = readPositiveIntegerEnv("STORAGE_QUOTA_REDIS_LOCK_TTL_MS", 10000);
		const renewEveryMs = Math.max(100, Math.floor(ttlMs / 3));

		while (Date.now() < deadline) {
			const acquired = await this.client.send("SET", [this.lockKey, token, "NX", "PX", String(ttlMs)]);
			if (String(acquired).toUpperCase() === "OK") {
				let renewTimer: ReturnType<typeof setInterval> | undefined;
				renewTimer = setInterval(() => {
					this.renewLock(token, ttlMs).catch((error) => {
						console.warn("[storage-quota] failed to renew Redis reservation lock", {
							error: error instanceof Error ? error.message : String(error),
						});
					});
				}, renewEveryMs);
				try {
					return await operation(token);
				} finally {
					if (renewTimer) clearInterval(renewTimer);
					await this.releaseLockBestEffort(token);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("Timed out waiting for Redis storage quota reservation lock");
	}

	private async writeReservationUnderLock(token: string, reservation: StorageQuotaReservation): Promise<void> {
		const written = await this.client.send("EVAL", [
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) else return -1 end",
			"2",
			this.lockKey,
			this.reservationsKey,
			token,
			reservation.reservationId,
			JSON.stringify(reservation),
		]);
		if (Number(written) < 0) {
			throw new Error("Lost Redis storage quota reservation lock before writing reservation");
		}
	}

	private async renewLock(token: string, ttlMs: number): Promise<void> {
		const renewed = await this.client.send("EVAL", [
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
			"1",
			this.lockKey,
			token,
			String(ttlMs),
		]);
		if (Number(renewed) <= 0) {
			throw new Error("Lost Redis storage quota reservation lock during renewal");
		}
	}

	private async releaseLockBestEffort(token: string): Promise<void> {
		try {
			await this.releaseLock(token);
		} catch (error) {
			console.warn("[storage-quota] failed to release Redis reservation lock", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async releaseLock(token: string): Promise<void> {
		await this.client.send("EVAL", [
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
			"1",
			this.lockKey,
			token,
		]);
	}

	private async deleteExpired(reservations: StorageQuotaReservation[], now: number): Promise<void> {
		const expiredIds = reservations
			.filter((reservation) => reservation.expiresAt <= now)
			.map((reservation) => reservation.reservationId);
		if (expiredIds.length > 0) {
			await this.client.send("HDEL", [this.reservationsKey, ...expiredIds]);
		}
	}

	private async readReservations(): Promise<StorageQuotaReservation[]> {
		const raw = await this.client.send("HGETALL", [this.reservationsKey]);
		const values = parseRedisHashValues(raw);
		return values
			.map((value) => parseReservation(value))
			.filter((reservation): reservation is StorageQuotaReservation => Boolean(reservation));
	}
}

export let storageQuotaReservationStore = createStorageQuotaReservationStore();

export function setStorageQuotaReservationStoreForTests(store: StorageQuotaReservationStore): () => void {
	const previous = storageQuotaReservationStore;
	storageQuotaReservationStore = store;
	return () => {
		storageQuotaReservationStore = previous;
	};
}

export function reserveProjectStorageQuota(input: StorageQuotaReservationInput): Promise<StorageQuotaReservationResult> {
	return storageQuotaReservationStore.reserve(input);
}

export async function listActiveProjectStorageQuotaReservations(projectId: string, now = Date.now()): Promise<StorageQuotaReservation[]> {
	const context = await resolveProjectStorageQuotaContext(projectId);
	const active = await storageQuotaReservationStore.listActive(context.workspaceId, now);
	return active.filter((reservation) => reservation.projectId === projectId);
}

export function releaseProjectStorageQuotaReservation(projectId: string, reservationId: string): Promise<boolean> {
	return storageQuotaReservationStore.release(projectId, reservationId);
}

export async function releaseProjectStorageQuotaReservationBestEffort(
	projectId: string,
	reservationId: string,
	context: Record<string, unknown> = {},
): Promise<StorageQuotaReservationReleaseResult> {
	try {
		return { released: await releaseProjectStorageQuotaReservation(projectId, reservationId) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn("[storage-quota] failed to release reservation", {
			projectId,
			reservationId,
			...context,
			error: message,
		});
		return { released: false, error: message };
	}
}

function listExportArtifacts(projectId: string): NonNullable<NonNullable<ProjectState["exportRuns"]>[number]["artifact"]>[] {
	// Tombstone-aware: a permanently-deleted project's stale export artifacts must
	// not be re-summed into storage usage.
	const state = readProjectStateFileGuarded<ProjectState>(projectId);
	if (!state) return [];
	return (state.exportRuns ?? [])
		.map((run) => run.artifact)
		.filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
}

function safeByteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function readOptionalByteCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value);
}

function createStorageReservation(input: StorageQuotaReservationInput, bytes: number, now: number): StorageQuotaReservation {
	const ttlMs = normalizeTtlMs(input.ttlMs);
	return {
		reservationId: randomUUID(),
		projectId: input.projectId,
		workspaceId: input.workspaceId?.trim() || input.projectId,
		bytes,
		reason: input.reason,
		createdAt: now,
		expiresAt: now + ttlMs,
		metadata: input.metadata,
	};
}

function createStorageQuotaReservationStore(): StorageQuotaReservationStore {
	const mode = (process.env.STORAGE_QUOTA_RESERVATION_STORE || (process.env.REDIS_URL ? "redis" : "memory")).trim().toLowerCase();
	if (mode === "redis") return new RedisStorageQuotaReservationStore();
	return new MemoryStorageQuotaReservationStore();
}

function normalizeTtlMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return readPositiveIntegerEnv("STORAGE_QUOTA_RESERVATION_TTL_MS", 15 * 60 * 1000);
	}
	return Math.max(1000, Math.min(Math.round(value), 60 * 60 * 1000));
}

function sumReservationBytes(reservations: StorageQuotaReservation[]): number {
	return reservations.reduce((total, reservation) => total + safeByteCount(reservation.bytes), 0);
}

function normalizeWorkspaceProjectIds(projectId: string, projectIds: string[] | undefined): string[] {
	const ids = new Set<string>();
	ids.add(projectId);
	for (const activeProjectId of projectIds ?? []) {
		const normalized = activeProjectId.trim();
		if (normalized) ids.add(normalized);
	}
	return [...ids];
}

function parseRedisHashValues(raw: unknown): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		const values: string[] = [];
		for (let index = 1; index < raw.length; index += 2) {
			if (raw[index] !== undefined) values.push(String(raw[index]));
		}
		return values;
	}
	if (typeof raw === "object") {
		return Object.values(raw as Record<string, unknown>).map((value) => String(value));
	}
	return [];
}

function parseReservation(value: string): StorageQuotaReservation | null {
	try {
		const parsed = JSON.parse(value) as Partial<StorageQuotaReservation>;
		if (
			typeof parsed.reservationId === "string"
			&& typeof parsed.projectId === "string"
			&& typeof parsed.workspaceId === "string"
			&& typeof parsed.bytes === "number"
			&& typeof parsed.reason === "string"
			&& typeof parsed.createdAt === "number"
			&& typeof parsed.expiresAt === "number"
		) {
			return parsed as StorageQuotaReservation;
		}
		return null;
	} catch {
		return null;
	}
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readIncludedStorageBytesEnv(fallback: number): number {
	const raw = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	// Docker's legacy default is the free tier; billable workspace plans should still apply.
	return parsed === DEFAULT_INCLUDED_STORAGE_BYTES && fallback !== DEFAULT_INCLUDED_STORAGE_BYTES ? fallback : parsed;
}

function readExtraStorageBytesEnv(fallback: number): number {
	const raw = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed === 0 && fallback > 0 ? fallback : parsed;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
