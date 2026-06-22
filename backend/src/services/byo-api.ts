import { getSharedBunSql } from "./sql-pool.js";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";
import { billingStore, type BillingStore } from "./billing-store.js";
import { moderateImageBuffer } from "./moderation.js";
import { projectCatalogStore } from "./project-catalog.js";
import { editImageWithOpenAi, type OpenAiImageEditResult, type OpenAiImageSize } from "./openai-image.js";
import { DEFAULT_OPENAI_IMAGE_MODEL } from "./ai-providers/openai-models.js";
import { translateWithOpenRouterModel } from "./openrouter.js";
import type { ProjectState } from "../types/index.js";

export type ByoProvider = "openai" | "openrouter";
export type ByoTaskType = "image" | "text" | "ocr";

export const BYO_ADDON_ID = "byo-api";

export interface WorkspaceApiKeyRecord {
	id: string;
	workspaceId: string;
	provider: ByoProvider;
	encryptedKey: Buffer;
	keyHint: string;
	addedBy: string;
	createdAt: string;
	lastUsedAt?: string;
	disabledAt?: string;
}

export interface ByoUsageEvent {
	id: string;
	workspaceId: string;
	provider: ByoProvider;
	model: string;
	taskType: ByoTaskType;
	tokensIn: number;
	tokensOut: number;
	estCostUsd: number;
	createdAt: string;
}

export interface ByoApiStore {
	upsertKey(record: WorkspaceApiKeyRecord): Promise<WorkspaceApiKeyRecord>;
	getActiveKey(workspaceId: string, provider: ByoProvider): Promise<WorkspaceApiKeyRecord | null>;
	listActiveKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]>;
	disableKey(workspaceId: string, provider: ByoProvider): Promise<boolean>;
	markUsed(keyId: string): Promise<void>;
	recordUsage(event: ByoUsageEvent): Promise<ByoUsageEvent>;
	listUsage(workspaceId: string, limit?: number): Promise<ByoUsageEvent[]>;
}

export class ByoApiError extends Error {
	constructor(message: string, readonly code = "byo_api_error", readonly status = 400) {
		super(message);
		this.name = "ByoApiError";
	}
}

interface ByoSnapshot {
	keys: Array<Omit<WorkspaceApiKeyRecord, "encryptedKey"> & { encryptedKey: string }>;
	usage: ByoUsageEvent[];
}

export class FileByoApiStore implements ByoApiStore {
	private keys: WorkspaceApiKeyRecord[] = [];
	private usage: ByoUsageEvent[] = [];

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async upsertKey(record: WorkspaceApiKeyRecord): Promise<WorkspaceApiKeyRecord> {
		const now = new Date().toISOString();
		for (const key of this.keys) {
			if (key.workspaceId === record.workspaceId && key.provider === record.provider && !key.disabledAt) {
				key.disabledAt = now;
			}
		}
		this.keys.push({ ...record, encryptedKey: Buffer.from(record.encryptedKey) });
		this.persist();
		return { ...record, encryptedKey: Buffer.from(record.encryptedKey) };
	}

	async getActiveKey(workspaceId: string, provider: ByoProvider): Promise<WorkspaceApiKeyRecord | null> {
		const key = this.keys
			.filter((item) => item.workspaceId === workspaceId && item.provider === provider && !item.disabledAt)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		return key ? { ...key, encryptedKey: Buffer.from(key.encryptedKey) } : null;
	}

	async listActiveKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]> {
		return this.keys
			.filter((item) => item.workspaceId === workspaceId && !item.disabledAt)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((key) => ({ ...key, encryptedKey: Buffer.from(key.encryptedKey) }));
	}

	async disableKey(workspaceId: string, provider: ByoProvider): Promise<boolean> {
		const now = new Date().toISOString();
		let changed = false;
		for (const key of this.keys) {
			if (key.workspaceId === workspaceId && key.provider === provider && !key.disabledAt) {
				key.disabledAt = now;
				changed = true;
			}
		}
		if (changed) this.persist();
		return changed;
	}

	async markUsed(keyId: string): Promise<void> {
		const key = this.keys.find((item) => item.id === keyId);
		if (!key) return;
		key.lastUsedAt = new Date().toISOString();
		this.persist();
	}

	async recordUsage(event: ByoUsageEvent): Promise<ByoUsageEvent> {
		this.usage.push({ ...event });
		this.persist();
		return { ...event };
	}

	async listUsage(workspaceId: string, limit = 100): Promise<ByoUsageEvent[]> {
		return this.usage
			.filter((event) => event.workspaceId === workspaceId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, Math.max(1, Math.min(limit, 500)))
			.map((event) => ({ ...event }));
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<Partial<ByoSnapshot>>(this.persistPath);
			this.keys = Array.isArray(snapshot.keys)
				? snapshot.keys.map((key) => ({ ...key, encryptedKey: Buffer.from(key.encryptedKey, "base64") })).filter(isKeyRecord)
				: [];
			this.usage = Array.isArray(snapshot.usage) ? snapshot.usage.filter(isUsageEvent) : [];
		} catch (error) {
			console.warn(`[BYO] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		const snapshot: ByoSnapshot = {
			keys: this.keys.map((key) => ({ ...key, encryptedKey: key.encryptedKey.toString("base64") })),
			usage: this.usage,
		};
		writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

interface ByoSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: ByoSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

/**
 * Run `fn` inside a single transaction. Uses the driver's native `begin` when
 * available (Bun.SQL exposes it); otherwise falls back to explicit
 * BEGIN/COMMIT/ROLLBACK so injected test clients (and any minimal client) still
 * get atomicity. Mirrors `runTransaction` in storage-cow.ts.
 */
async function runByoTransaction<T>(client: ByoSqlClient, fn: (tx: ByoSqlClient) => Promise<T>): Promise<T> {
	if (client.begin) return client.begin(fn);
	await client.unsafe("BEGIN");
	try {
		const result = await fn(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.unsafe("ROLLBACK");
		} catch {
			// Surface the original failure; a rollback error must not mask it.
		}
		throw error;
	}
}

export class PostgresByoApiStore implements ByoApiStore {
	private readonly client: ByoSqlClient;

	constructor(databaseUrlOrClient: string | ByoSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) throw new ByoApiError("BYO_API_STORE=postgres requires DATABASE_URL", "byo_store_unconfigured", 500);
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as ByoSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async upsertKey(record: WorkspaceApiKeyRecord): Promise<WorkspaceApiKeyRecord> {
		// Rotation = retire the current active key, then insert the new one. These
		// MUST be atomic: a partial write (UPDATE commits, INSERT fails) would leave
		// the workspace with zero active keys, silently breaking every BYO request
		// until the customer re-adds a key. Wrap both in one transaction so a failed
		// INSERT rolls the disable back and the prior key stays active. The partial
		// unique index (migration 0049) — one active key per (workspace, provider) —
		// can also fire 23505 on a concurrent rotation racing the same row; surface
		// that as a clean 409 instead of an unhandled 500.
		try {
			return await runByoTransaction(this.client, async (tx) => {
				await tx.unsafe(`
					UPDATE workspace_api_keys
					SET disabled_at = now()
					WHERE workspace_id = $1 AND provider = $2 AND disabled_at IS NULL
				`, [record.workspaceId, record.provider]);
				const rows = await tx.unsafe<WorkspaceApiKeyRow>(`
					INSERT INTO workspace_api_keys (id, workspace_id, provider, encrypted_key, key_hint, added_by, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
					RETURNING id, workspace_id, provider, encrypted_key, key_hint, added_by, created_at, last_used_at, disabled_at
				`, [record.id, record.workspaceId, record.provider, record.encryptedKey, record.keyHint, record.addedBy, record.createdAt]);
				return mapKeyRow(rows[0]!);
			});
		} catch (error) {
			if (isByoUniqueViolation(error)) {
				throw new ByoApiError(
					"Another API key for this provider is being rotated; retry in a moment",
					"byo_key_rotation_conflict",
					409,
				);
			}
			throw error;
		}
	}

	async getActiveKey(workspaceId: string, provider: ByoProvider): Promise<WorkspaceApiKeyRecord | null> {
		const rows = await this.client.unsafe<WorkspaceApiKeyRow>(`
			SELECT id, workspace_id, provider, encrypted_key, key_hint, added_by, created_at, last_used_at, disabled_at
			FROM workspace_api_keys
			WHERE workspace_id = $1 AND provider = $2 AND disabled_at IS NULL
			ORDER BY created_at DESC
			LIMIT 1
		`, [workspaceId, provider]);
		return rows[0] ? mapKeyRow(rows[0]) : null;
	}

	async listActiveKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]> {
		const rows = await this.client.unsafe<WorkspaceApiKeyRow>(`
			SELECT id, workspace_id, provider, encrypted_key, key_hint, added_by, created_at, last_used_at, disabled_at
			FROM workspace_api_keys
			WHERE workspace_id = $1 AND disabled_at IS NULL
			ORDER BY created_at DESC
		`, [workspaceId]);
		return rows.map(mapKeyRow);
	}

	async disableKey(workspaceId: string, provider: ByoProvider): Promise<boolean> {
		const rows = await this.client.unsafe<{ id: string }>(`
			UPDATE workspace_api_keys
			SET disabled_at = now()
			WHERE workspace_id = $1 AND provider = $2 AND disabled_at IS NULL
			RETURNING id
		`, [workspaceId, provider]);
		return rows.length > 0;
	}

	async markUsed(keyId: string): Promise<void> {
		await this.client.unsafe("UPDATE workspace_api_keys SET last_used_at = now() WHERE id = $1", [keyId]);
	}

	async recordUsage(event: ByoUsageEvent): Promise<ByoUsageEvent> {
		const rows = await this.client.unsafe<ByoUsageEventRow>(`
			INSERT INTO byo_usage_events (id, workspace_id, provider, model, task_type, tokens_in, tokens_out, est_cost_usd, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
			RETURNING id, workspace_id, provider, model, task_type, tokens_in, tokens_out, est_cost_usd, created_at
		`, [event.id, event.workspaceId, event.provider, event.model, event.taskType, event.tokensIn, event.tokensOut, event.estCostUsd, event.createdAt]);
		return mapUsageRow(rows[0]!);
	}

	async listUsage(workspaceId: string, limit = 100): Promise<ByoUsageEvent[]> {
		const rows = await this.client.unsafe<ByoUsageEventRow>(`
			SELECT id, workspace_id, provider, model, task_type, tokens_in, tokens_out, est_cost_usd, created_at
			FROM byo_usage_events
			WHERE workspace_id = $1
			ORDER BY created_at DESC, id DESC
			LIMIT $2
		`, [workspaceId, Math.max(1, Math.min(limit, 500))]);
		return rows.map(mapUsageRow);
	}
}

export interface ByoApiDependencies {
	store?: ByoApiStore;
	billing?: BillingStore;
	fetchImpl?: typeof fetch;
	csamCheck?: (input: { workspaceId: string; provider: ByoProvider; imageBuffer: Buffer; mimeType: string }) => Promise<void>;
}

export class ByoApiService {
	constructor(private readonly deps: Required<ByoApiDependencies>) {}

	async hasEntitlement(workspaceId: string): Promise<boolean> {
		const resolved = await this.deps.billing.resolveWorkspacePlan(workspaceId);
		// BYO is retired from sale, but LEGACY grants stay serviceable. Accept
		// studio_plus too: pre-redesign Dodo studio_plus subs resolved to internal
		// "studio"+BYO, and the 2026-06-12 remap rewrites them to "studio_plus" on
		// the next trusted webhook — without this their paid BYO keys would 403
		// (review #586 r2 P1).
		if ((resolved.planId !== "studio" && resolved.planId !== "studio_plus") || !resolved.assigned) return false;
		const grants = await this.deps.billing.listActiveGrants(workspaceId);
		// Mirror the GREATEST(quantity, 0) treatment used by the quota code: a
		// zero- or negative-quantity grant (which billing can leave behind after a
		// subscription quantity change) confers no paid benefit, so it must not
		// entitle the workspace to store or use BYO keys.
		return grants.some((grant) => grant.addonId === BYO_ADDON_ID && grant.quantity > 0);
	}

	async setKey(workspaceId: string, provider: ByoProvider, plaintextKey: string, byUser: string): Promise<WorkspaceApiKeyRecord> {
		assertProvider(provider);
		const key = plaintextKey.trim();
		if (!key) throw new ByoApiError("API key is required", "byo_key_required", 400);
		await this.requireEntitlement(workspaceId);
		await verifyProviderKey(provider, key, this.deps.fetchImpl);
		const record: WorkspaceApiKeyRecord = {
			id: randomUUID(),
			workspaceId,
			provider,
			encryptedKey: envelopeEncrypt(key),
			keyHint: key.slice(-4),
			addedBy: byUser,
			createdAt: new Date().toISOString(),
		};
		return this.deps.store.upsertKey(record);
	}

	async getDecryptedKey(workspaceId: string, provider: ByoProvider): Promise<string | null> {
		assertProvider(provider);
		const record = await this.deps.store.getActiveKey(workspaceId, provider);
		return record ? envelopeDecrypt(record.encryptedKey) : null;
	}

	async listKeyHints(workspaceId: string): Promise<Array<Pick<WorkspaceApiKeyRecord, "provider" | "keyHint" | "createdAt" | "lastUsedAt">>> {
		const keys = await this.deps.store.listActiveKeys(workspaceId);
		return keys.map((key) => ({
			provider: key.provider,
			keyHint: key.keyHint,
			createdAt: key.createdAt,
			lastUsedAt: key.lastUsedAt,
		}));
	}

	async removeKey(workspaceId: string, provider: ByoProvider): Promise<boolean> {
		assertProvider(provider);
		// Intentionally NOT gated on requireEntitlement: revoking a stored customer
		// key must stay available even after the BYO add-on is cancelled or the
		// workspace downgrades from Studio. Otherwise the entitlement check would
		// strand the credential as undeletable until billing is restored. The route
		// still enforces update_workspace permission + workspace-wide scope.
		return this.deps.store.disableKey(workspaceId, provider);
	}

	modelsForTask(provider: ByoProvider, taskType: ByoTaskType): string[] {
		assertProvider(provider);
		assertTaskType(taskType);
		if (provider === "openai") {
			if (taskType === "image") return [DEFAULT_OPENAI_IMAGE_MODEL];
			return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
		}
		if (taskType === "image") return ["openai/gpt-5.4-image-2", "google/gemini-2.5-flash-image"];
		return ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-3.5-pro"];
	}

	async getWorkspaceByoProvider(workspaceId: string): Promise<ByoProvider | null> {
		if (!(await this.hasEntitlement(workspaceId))) return null;
		const keys = await this.deps.store.listActiveKeys(workspaceId);
		if (keys.some((key) => key.provider === "openai")) return "openai";
		if (keys.some((key) => key.provider === "openrouter")) return "openrouter";
		return null;
	}

	async routeAIRequest(input: {
		workspaceId: string;
		provider?: ByoProvider;
		model?: string;
		taskType: ByoTaskType;
		imageBuffer?: Buffer;
		prompt: string;
		mimeType?: string;
		filename?: string;
		quality?: "low" | "medium" | "high";
		size?: OpenAiImageSize;
	}): Promise<{ provider: ByoProvider; model: string; buffer?: Buffer; text?: string; usage?: unknown }> {
		assertTaskType(input.taskType);
		await this.requireEntitlement(input.workspaceId);
		const provider = input.provider ?? await this.getWorkspaceByoProvider(input.workspaceId);
		if (!provider) throw new ByoApiError("No active BYO API key is configured", "byo_key_missing", 409);
		assertProvider(provider);
		const record = await this.deps.store.getActiveKey(input.workspaceId, provider);
		if (!record) throw new ByoApiError("No active BYO API key is configured", "byo_key_missing", 409);
		const key = envelopeDecrypt(record.encryptedKey);
		const model = input.model || this.modelsForTask(provider, input.taskType)[0]!;
		if (!this.modelsForTask(provider, input.taskType).includes(model)) {
			throw new ByoApiError(`Model '${model}' is not available for ${input.taskType} tasks on ${provider}`, "byo_model_task_mismatch", 400);
		}
		if (input.taskType === "image" || input.taskType === "ocr") {
			if (!input.imageBuffer) throw new ByoApiError("Image buffer is required for image/OCR BYO tasks", "byo_image_required", 400);
			await this.deps.csamCheck({
				workspaceId: input.workspaceId,
				provider,
				imageBuffer: input.imageBuffer,
				mimeType: input.mimeType || "image/png",
			});
		}

		try {
			const result = await callByoProvider({
				provider,
				key,
				model,
				taskType: input.taskType,
				imageBuffer: input.imageBuffer,
				prompt: input.prompt,
				mimeType: input.mimeType,
				filename: input.filename,
				quality: input.quality,
				size: input.size,
				fetchImpl: this.deps.fetchImpl,
			});
			await this.deps.store.markUsed(record.id);
			await this.deps.store.recordUsage({
				id: randomUUID(),
				workspaceId: input.workspaceId,
				provider,
				model,
				taskType: input.taskType,
				tokensIn: estimateTokenCount(input.prompt),
				tokensOut: estimateOutputTokens(result),
				estCostUsd: estimateByoCostUsd(input.taskType),
				createdAt: new Date().toISOString(),
			});
			return { provider, model, ...result };
		} catch (error) {
			const byoError = new ByoApiError(
				// The "switch to credits" is a CLIENT resubmit on the platform path (which
				// re-runs prompt moderation + reserves credits), NOT an automatic server
				// switch — a BYO-queued job has no credit reservation to fall back onto.
				`BYO ${provider} request failed. Resubmit on platform credits to switch.`,
				"byo_provider_failed_switch_to_credits",
				409,
			);
			(byoError as Error & { cause?: unknown }).cause = error;
			throw byoError;
		}
	}

	async listUsage(workspaceId: string, limit?: number): Promise<ByoUsageEvent[]> {
		await this.requireEntitlement(workspaceId);
		return this.deps.store.listUsage(workspaceId, limit);
	}

	private async requireEntitlement(workspaceId: string): Promise<void> {
		if (await this.hasEntitlement(workspaceId)) return;
		throw new ByoApiError("Studio plan with BYO API add-on is required", "byo_entitlement_required", 403);
	}
}

export async function resolveWorkspaceIdForProject(projectId: string): Promise<string | null> {
	const state = await projectCatalogStore?.getProjectState(projectId);
	if (state?.workspaceId?.trim()) return state.workspaceId.trim();
	// Tombstone-aware: a permanently-deleted project must not have its stale
	// state.json resurrected to re-derive a workspace for BYO-API entitlement.
	const fileState = readProjectStateFileGuarded<Pick<ProjectState, "workspaceId">>(projectId);
	return fileState?.workspaceId?.trim() || null;
}

async function callByoProvider(input: {
	provider: ByoProvider;
	key: string;
	model: string;
	taskType: ByoTaskType;
	imageBuffer?: Buffer;
	prompt: string;
	mimeType?: string;
	filename?: string;
	quality?: "low" | "medium" | "high";
	size?: OpenAiImageSize;
	fetchImpl: typeof fetch;
}): Promise<{ buffer?: Buffer; text?: string; usage?: unknown }> {
	if (input.taskType === "image") {
		if (!input.imageBuffer) throw new Error("imageBuffer is required");
		if (input.provider === "openai") {
			const result: OpenAiImageEditResult = await editImageWithOpenAi({
				imageBuffer: input.imageBuffer,
				prompt: input.prompt,
				apiKey: input.key,
				mimeType: input.mimeType || "image/png",
				filename: input.filename || "crop.png",
				model: input.model,
				quality: input.quality,
				size: input.size,
				fetchImpl: input.fetchImpl,
			});
			return { buffer: result.buffer, usage: result.usage };
		}
		return { buffer: await translateWithOpenRouterModel(input.imageBuffer, input.prompt, input.key, input.model, input.fetchImpl) };
	}

	const endpoint = input.provider === "openai"
		? "https://api.openai.com/v1/responses"
		: "https://openrouter.ai/api/v1/chat/completions";
	const body = input.provider === "openai"
		? { model: input.model, input: input.prompt }
		: { model: input.model, messages: [{ role: "user", content: input.prompt }] };
	const response = await input.fetchImpl(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${input.key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${input.provider} text error ${response.status}: ${await response.text()}`);
	const payload = await response.json() as any;
	const text = input.provider === "openai"
		? payload.output_text || payload.output?.[0]?.content?.[0]?.text || ""
		: payload.choices?.[0]?.message?.content || "";
	return { text, usage: payload.usage };
}

async function verifyProviderKey(provider: ByoProvider, key: string, fetchImpl: typeof fetch): Promise<void> {
	const url = provider === "openai" ? "https://api.openai.com/v1/models" : "https://openrouter.ai/api/v1/key";
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ByoApiError(`BYO ${provider} key verification failed`, "byo_key_verification_failed", 400);
	}
}

function moderationFlagEnabled(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	// Treat the flag as enabled ONLY when explicitly opted in. A non-empty string
	// such as "false"/"0"/"off"/"no" is still truthy in JS, so a plain truthiness
	// check would let an operator who disabled moderation via this env flag run
	// BYO image jobs with no mandatory CSAM screening — which the BYO policy forbids.
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function defaultCsamCheck(input: { imageBuffer: Buffer; mimeType: string }): Promise<void> {
	if (!moderationFlagEnabled(process.env.OPENAI_MODERATION_ENABLED) || !process.env.OPENAI_API_KEY) {
		throw new ByoApiError("CSAM moderation must be enabled (OPENAI_MODERATION_ENABLED) before BYO API requests can run", "byo_csam_moderation_unconfigured", 503);
	}
	const result = await moderateImageBuffer(input.imageBuffer, input.mimeType);
	if (result.status === "blocked") {
		throw new ByoApiError("Image blocked by mandatory CSAM moderation", "byo_csam_blocked", 400);
	}
	const scores = result.categories || {};
	const sexualMinorScore = Number(scores["sexual/minors"] ?? scores.sexual_minors ?? 0);
	const extremeScore = Math.max(0, ...Object.entries(scores)
		.filter(([key]) => key.toLowerCase().includes("extreme"))
		.map(([, value]) => Number(value) || 0));
	if (sexualMinorScore > 0.01 || extremeScore >= 0.5) {
		throw new ByoApiError("Image blocked by mandatory CSAM moderation", "byo_csam_blocked", 400);
	}
	if (result.status === "needs_review") {
		throw new ByoApiError("Image needs CSAM review before BYO API processing", "byo_csam_needs_review", 409);
	}
}

interface EnvelopePayload {
	v: 1;
	alg: "aes-256-gcm";
	wrapAlg: "aes-256-gcm";
	iv: string;
	tag: string;
	wrappedDataKey: string;
	wrapIv: string;
	wrapTag: string;
	ciphertext: string;
}

function envelopeEncrypt(plaintext: string): Buffer {
	const masterKey = resolveMasterKey();
	const dataKey = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	const wrapIv = randomBytes(12);
	const wrapCipher = createCipheriv("aes-256-gcm", masterKey, wrapIv);
	const wrappedDataKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
	const payload: EnvelopePayload = {
		v: 1,
		alg: "aes-256-gcm",
		wrapAlg: "aes-256-gcm",
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		wrappedDataKey: wrappedDataKey.toString("base64"),
		wrapIv: wrapIv.toString("base64"),
		wrapTag: wrapCipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
	return Buffer.from(JSON.stringify(payload), "utf8");
}

function envelopeDecrypt(payloadBuffer: Buffer): string {
	const masterKey = resolveMasterKey();
	const payload = JSON.parse(payloadBuffer.toString("utf8")) as EnvelopePayload;
	if (payload.v !== 1 || payload.alg !== "aes-256-gcm" || payload.wrapAlg !== "aes-256-gcm") {
		throw new ByoApiError("Unsupported BYO key envelope", "byo_envelope_unsupported", 500);
	}
	const unwrap = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(payload.wrapIv, "base64"));
	unwrap.setAuthTag(Buffer.from(payload.wrapTag, "base64"));
	const dataKey = Buffer.concat([unwrap.update(Buffer.from(payload.wrappedDataKey, "base64")), unwrap.final()]);
	const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(payload.iv, "base64"));
	decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function resolveMasterKey(): Buffer {
	const raw = serverConfig.byoMasterKey || process.env.BYO_MASTER_KEY || (process.env.NODE_ENV === "test" ? "test-byo-master-key-do-not-use" : "");
	if (!raw) throw new ByoApiError("BYO_MASTER_KEY is required", "byo_master_key_required", 500);
	const base64 = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
	const decoded = Buffer.from(base64, "base64");
	if (raw.startsWith("base64:") && decoded.length === 32) return decoded;
	return createHash("sha256").update(raw).digest();
}

function createByoApiStore(): ByoApiStore {
	if (serverConfig.byoApiStore === "postgres") return new PostgresByoApiStore();
	return new FileByoApiStore(join(DATA_DIR, "byo-api.json"));
}

function assertProvider(provider: string): asserts provider is ByoProvider {
	if (provider !== "openai" && provider !== "openrouter") {
		throw new ByoApiError("Provider must be openai or openrouter", "byo_provider_invalid", 400);
	}
}

function assertTaskType(taskType: string): asserts taskType is ByoTaskType {
	if (taskType !== "image" && taskType !== "text" && taskType !== "ocr") {
		throw new ByoApiError("Task must be image, text, or ocr", "byo_task_invalid", 400);
	}
}

function isByoUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if ((error as { code?: unknown }).code === "23505") return true;
	const message = (error as { message?: unknown }).message;
	// Cover drivers that don't surface SQLSTATE on the error object.
	return typeof message === "string" && /unique constraint|duplicate key/i.test(message);
}

function isKeyRecord(value: WorkspaceApiKeyRecord): value is WorkspaceApiKeyRecord {
	return Boolean(value?.id && value.workspaceId && value.provider && Buffer.isBuffer(value.encryptedKey));
}

function isUsageEvent(value: unknown): value is ByoUsageEvent {
	const event = value as Partial<ByoUsageEvent>;
	return Boolean(event?.id && event.workspaceId && event.provider && event.model && event.taskType && event.createdAt);
}

function estimateTokenCount(text: string): number {
	return Math.ceil(Math.max(1, text.length) / 4);
}

function estimateOutputTokens(result: { buffer?: Buffer; text?: string }): number {
	if (result.text) return estimateTokenCount(result.text);
	if (result.buffer) return Math.ceil(result.buffer.byteLength / 1024);
	return 0;
}

function estimateByoCostUsd(taskType: ByoTaskType): number {
	return taskType === "image" ? 0.23 : 0.01;
}

interface WorkspaceApiKeyRow {
	id: string;
	workspace_id: string;
	provider: string;
	encrypted_key: Buffer | Uint8Array;
	key_hint: string;
	added_by: string;
	created_at: Date | string;
	last_used_at?: Date | string | null;
	disabled_at?: Date | string | null;
}

function mapKeyRow(row: WorkspaceApiKeyRow): WorkspaceApiKeyRecord {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		provider: row.provider as ByoProvider,
		encryptedKey: Buffer.from(row.encrypted_key),
		keyHint: row.key_hint,
		addedBy: row.added_by,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
		lastUsedAt: toIso(row.last_used_at),
		disabledAt: toIso(row.disabled_at),
	};
}

interface ByoUsageEventRow {
	id: string;
	workspace_id: string;
	provider: string;
	model: string;
	task_type: string;
	tokens_in: number | string;
	tokens_out: number | string;
	est_cost_usd: number | string;
	created_at: Date | string;
}

function mapUsageRow(row: ByoUsageEventRow): ByoUsageEvent {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		provider: row.provider as ByoProvider,
		model: row.model,
		taskType: row.task_type as ByoTaskType,
		tokensIn: Number(row.tokens_in) || 0,
		tokensOut: Number(row.tokens_out) || 0,
		estCostUsd: Number(row.est_cost_usd) || 0,
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
	};
}

function toIso(value: Date | string | null | undefined): string | undefined {
	if (!value) return undefined;
	return value instanceof Date ? value.toISOString() : String(value);
}

export const byoApiService = new ByoApiService({
	store: createByoApiStore(),
	billing: billingStore,
	fetchImpl: fetch,
	csamCheck: defaultCsamCheck,
});
