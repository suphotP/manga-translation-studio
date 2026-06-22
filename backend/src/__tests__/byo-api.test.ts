import { beforeEach, describe, expect, test } from "bun:test";
import {
	ByoApiError,
	ByoApiService,
	FileByoApiStore,
	PostgresByoApiStore,
	defaultCsamCheck,
	type ByoApiDependencies,
	type ByoApiStore,
	type ByoProvider,
	type WorkspaceApiKeyRecord,
} from "../services/byo-api.js";
import type {
	AdminWorkspaceAccountPage,
	BillingStore,
	SetWorkspacePlanInput,
	WorkspaceAddonGrant,
	WorkspaceBillingAssignment,
	WorkspaceBillingStatus,
	ResolvedWorkspacePlan,
} from "../services/billing-store.js";
import type { WorkspacePlanId } from "../services/plans.js";

class FakeBillingStore implements BillingStore {
	private plans = new Map<string, { planId: WorkspacePlanId; status: WorkspaceBillingStatus }>();
	private grants: WorkspaceAddonGrant[] = [];

	async setWorkspacePlan(input: SetWorkspacePlanInput): Promise<WorkspaceBillingAssignment> {
		const now = new Date().toISOString();
		const status = input.status ?? "mock_active";
		this.plans.set(input.workspaceId, { planId: input.planId, status });
		return {
			workspaceId: input.workspaceId,
			planId: input.planId,
			status,
			createdAt: now,
			updatedAt: now,
		};
	}

	async getWorkspaceAssignment(workspaceId: string): Promise<WorkspaceBillingAssignment | null> {
		const plan = this.plans.get(workspaceId);
		if (!plan) return null;
		const now = new Date().toISOString();
		return { workspaceId, planId: plan.planId, status: plan.status, createdAt: now, updatedAt: now };
	}

	async resolveWorkspacePlan(workspaceId: string): Promise<ResolvedWorkspacePlan> {
		const plan = this.plans.get(workspaceId);
		if (!plan || plan.status === "cancelled" || plan.status === "past_due") {
			return { workspaceId, planId: "free", status: plan?.status ?? null, assigned: false };
		}
		return { workspaceId, planId: plan.planId, status: plan.status, assigned: true };
	}

	async listAssignments(): Promise<WorkspaceBillingAssignment[]> {
		return [];
	}

	async listWorkspaceAccounts(): Promise<AdminWorkspaceAccountPage> {
		return { workspaces: [], nextCursor: undefined, total: 0 };
	}

	async listActiveGrants(workspaceId: string): Promise<WorkspaceAddonGrant[]> {
		return this.grants.filter((grant) => grant.workspaceId === workspaceId && grant.status === "active");
	}

	grantByo(workspaceId: string, quantity = 1): void {
		const now = new Date().toISOString();
		this.grants.push({
			grantId: `grant-${workspaceId}-${quantity}`,
			workspaceId,
			addonId: "byo-api",
			quantity,
			aiCredits: 0,
			storageBytes: 0,
			seats: 0,
			teamJobs: 0,
			status: "active",
			source: "test",
			createdAt: now,
			updatedAt: now,
		});
	}
}

function okFetch(payload: unknown = { ok: true }): typeof fetch {
	return (async (url: RequestInfo | URL) => {
		const textUrl = String(url);
		if (textUrl.includes("/images/edits")) {
			return Response.json({
				data: [{ b64_json: Buffer.from("fake-image-result").toString("base64") }],
				usage: { input_tokens: 12, output_tokens: 4 },
			});
		}
		return Response.json(payload);
	}) as typeof fetch;
}

function createService(input: {
	billing?: FakeBillingStore;
	store?: ByoApiStore;
	fetchImpl?: typeof fetch;
	csamCheck?: ByoApiDependencies["csamCheck"];
} = {}): { service: ByoApiService; billing: FakeBillingStore; store: ByoApiStore } {
	const billing = input.billing ?? new FakeBillingStore();
	const store = input.store ?? new FileByoApiStore();
	const service = new ByoApiService({
		store,
		billing,
		fetchImpl: input.fetchImpl ?? okFetch(),
		csamCheck: input.csamCheck ?? (async () => undefined),
	});
	return { service, billing, store };
}

async function enableByo(billing: FakeBillingStore, workspaceId = "ws-studio"): Promise<void> {
	await billing.setWorkspacePlan({ workspaceId, planId: "studio", status: "active" });
	billing.grantByo(workspaceId);
}

describe("BYO API service", () => {
	beforeEach(() => {
		process.env.BYO_MASTER_KEY = "unit-test-master-key-32-bytes-minimum";
	});

	test("setKey requires Studio plus active BYO add-on entitlement", async () => {
		const { service, billing } = createService();
		await billing.setWorkspacePlan({ workspaceId: "ws-pro", planId: "pro", status: "active" });

		await expect(service.setKey("ws-pro", "openai", "sk-test-1234", "user-1")).rejects.toMatchObject({
			code: "byo_entitlement_required",
			status: 403,
		});

		await enableByo(billing);
		const key = await service.setKey("ws-studio", "openai", "sk-test-1234", "user-1");
		expect(key.provider).toBe("openai");
		expect(key.keyHint).toBe("1234");
	});

	test("encrypt/decrypt roundtrip never stores plaintext", async () => {
		const { service, billing, store } = createService();
		await enableByo(billing);

		const key = await service.setKey("ws-studio", "openrouter", "sk-or-secret-9876", "user-1");
		expect(key.encryptedKey.toString("utf8")).not.toContain("sk-or-secret-9876");
		await expect(service.getDecryptedKey("ws-studio", "openrouter")).resolves.toBe("sk-or-secret-9876");
		const active = await store.getActiveKey("ws-studio", "openrouter");
		expect(active?.keyHint).toBe("9876");
	});

	test("BYO image route still runs mandatory CSAM check", async () => {
		let csamCalls = 0;
		const { service, billing } = createService({
			csamCheck: async () => {
				csamCalls += 1;
				throw new ByoApiError("blocked", "byo_csam_blocked", 400);
			},
		});
		await enableByo(billing);
		await service.setKey("ws-studio", "openai", "sk-test-1234", "user-1");

		await expect(service.routeAIRequest({
			workspaceId: "ws-studio",
			provider: "openai",
			taskType: "image",
			model: "gpt-image-1",
			imageBuffer: Buffer.from("fake-png"),
			prompt: "policy text that BYO may skip",
		})).rejects.toMatchObject({ code: "byo_csam_blocked" });
		expect(csamCalls).toBe(1);
	});

	test("a BYO provider failure reports the HONEST client-resubmit-on-credits path (codex P1 #5)", async () => {
		// The provider call throws → routeAIRequest wraps it as
		// byo_provider_failed_switch_to_credits. The message must describe the REAL
		// switch (client resubmits on platform credits), NOT an automatic server switch
		// or a misleading "within 30 seconds" SLA — there is no automatic fallback.
		// Key verification must SUCCEED (so setKey stores the key); only the actual
		// image edit call fails, exercising the routeAIRequest failure wrap.
		const failingFetch: typeof fetch = (async (url: RequestInfo | URL) => {
			if (String(url).includes("/images/edits")) throw new Error("upstream BYO provider exploded");
			return Response.json({ ok: true, data: [{ id: "model" }] });
		}) as typeof fetch;
		const { service, billing } = createService({ fetchImpl: failingFetch });
		await enableByo(billing);
		await service.setKey("ws-studio", "openai", "sk-test-1234", "user-1");

		let thrown: unknown;
		try {
			await service.routeAIRequest({
				workspaceId: "ws-studio",
				provider: "openai",
				taskType: "image",
				model: "gpt-image-1",
				imageBuffer: Buffer.from("fake-png"),
				prompt: "clean the sound effect",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ByoApiError);
		expect((thrown as ByoApiError).code).toBe("byo_provider_failed_switch_to_credits");
		expect((thrown as ByoApiError).message).toContain("Resubmit on platform credits");
		// No false "within 30 seconds" automatic-switch promise.
		expect((thrown as ByoApiError).message).not.toContain("30 seconds");
	});

	test("modelsForTask is format-locked by provider and task type", () => {
		const { service } = createService();

		expect(service.modelsForTask("openai", "image")).toEqual(["gpt-image-1"]);
		expect(service.modelsForTask("openai", "text")).not.toContain("gpt-image-1");
		expect(service.modelsForTask("openrouter", "image")).toContain("openai/gpt-5.4-image-2");
		expect(() => service.modelsForTask("openai" as ByoProvider, "video" as never)).toThrow("Task must be image, text, or ocr");
	});

	test("successful BYO route logs usage events in our dashboard store", async () => {
		const { service, billing, store } = createService();
		await enableByo(billing);
		await service.setKey("ws-studio", "openai", "sk-test-1234", "user-1");

		const result = await service.routeAIRequest({
			workspaceId: "ws-studio",
			provider: "openai",
			taskType: "image",
			model: "gpt-image-1",
			imageBuffer: Buffer.from("fake-png"),
			prompt: "clean the sound effect",
		});

		expect(result.buffer?.toString()).toBe("fake-image-result");
		const usage = await store.listUsage("ws-studio");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			workspaceId: "ws-studio",
			provider: "openai",
			model: "gpt-image-1",
			taskType: "image",
		});
		expect(usage[0]!.tokensIn).toBeGreaterThan(0);
	});

	test("a zero-quantity BYO grant does not confer entitlement", async () => {
		// Regression: billing can leave an active grant with quantity 0 after a
		// subscription quantity change; quota code treats it as GREATEST(quantity, 0)
		// = 0, so it must not entitle the workspace to store/use BYO keys.
		const { service, billing } = createService();
		await billing.setWorkspacePlan({ workspaceId: "ws-zero", planId: "studio", status: "active" });
		billing.grantByo("ws-zero", 0);

		await expect(service.hasEntitlement("ws-zero")).resolves.toBe(false);
		await expect(service.setKey("ws-zero", "openai", "sk-test-1234", "user-1")).rejects.toMatchObject({
			code: "byo_entitlement_required",
			status: 403,
		});

		billing.grantByo("ws-zero", 1);
		await expect(service.hasEntitlement("ws-zero")).resolves.toBe(true);
	});

	test("keys can be revoked after the BYO entitlement ends", async () => {
		// Regression: removeKey must not require an active entitlement, otherwise a
		// cancelled add-on / downgrade leaves the stored key undeletable.
		const { service, billing, store } = createService();
		await enableByo(billing);
		await service.setKey("ws-studio", "openai", "sk-test-1234", "user-1");

		// Simulate the add-on being cancelled / downgrade away from Studio.
		await billing.setWorkspacePlan({ workspaceId: "ws-studio", planId: "studio", status: "cancelled" });
		await expect(service.hasEntitlement("ws-studio")).resolves.toBe(false);

		await expect(service.removeKey("ws-studio", "openai")).resolves.toBe(true);
		await expect(store.getActiveKey("ws-studio", "openai")).resolves.toBeNull();
	});

	test("CSAM moderation must be explicitly enabled (a disabled flag string is not enough)", async () => {
		// Regression: OPENAI_MODERATION_ENABLED=false is a truthy non-empty string,
		// so a plain truthiness check would let BYO image jobs skip mandatory CSAM
		// moderation. defaultCsamCheck must refuse unless the flag is explicitly on.
		const prevFlag = process.env.OPENAI_MODERATION_ENABLED;
		const prevKey = process.env.OPENAI_API_KEY;
		try {
			process.env.OPENAI_API_KEY = "sk-platform-key";
			process.env.OPENAI_MODERATION_ENABLED = "false";
			await expect(defaultCsamCheck({ imageBuffer: Buffer.from("x"), mimeType: "image/png" }))
				.rejects.toMatchObject({ code: "byo_csam_moderation_unconfigured", status: 503 });

			process.env.OPENAI_MODERATION_ENABLED = "0";
			await expect(defaultCsamCheck({ imageBuffer: Buffer.from("x"), mimeType: "image/png" }))
				.rejects.toMatchObject({ code: "byo_csam_moderation_unconfigured", status: 503 });

			process.env.OPENAI_MODERATION_ENABLED = "off";
			await expect(defaultCsamCheck({ imageBuffer: Buffer.from("x"), mimeType: "image/png" }))
				.rejects.toMatchObject({ code: "byo_csam_moderation_unconfigured", status: 503 });
		} finally {
			if (prevFlag === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = prevFlag;
			if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevKey;
		}
	});
});

// ---------------------------------------------------------------------------
// rank 16 (P1): BYO key rotation must be atomic. The store retires the active
// key then inserts the new one — a partial write (UPDATE commits, INSERT fails)
// would strand the workspace with ZERO active keys. These tests use an in-memory
// fake Postgres client that implements begin() with real snapshot/rollback and
// enforces the partial unique index (one active key per workspace+provider).
// ---------------------------------------------------------------------------

interface FakeApiKeyRow {
	id: string;
	workspace_id: string;
	provider: string;
	encrypted_key: Buffer;
	key_hint: string;
	added_by: string;
	created_at: string;
	last_used_at: string | null;
	disabled_at: string | null;
}

class FakeByoSqlClient {
	rows: FakeApiKeyRow[] = [];
	failNextInsert = false;

	// Native-style transaction: snapshot, run, and on throw restore the snapshot
	// (atomic rollback), exactly like Bun.SQL's begin().
	async begin<T>(fn: (tx: FakeByoSqlClient) => Promise<T>): Promise<T> {
		const snapshot = this.rows.map((row) => ({ ...row }));
		try {
			return await fn(this);
		} catch (error) {
			this.rows = snapshot;
			throw error;
		}
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const sql = query.replace(/\s+/g, " ").trim();

		if (sql.startsWith("UPDATE workspace_api_keys SET disabled_at = now()")) {
			const [workspaceId, provider] = params as string[];
			for (const row of this.rows) {
				if (row.workspace_id === workspaceId && row.provider === provider && !row.disabled_at) {
					row.disabled_at = new Date().toISOString();
				}
			}
			return [] as T[];
		}

		if (sql.startsWith("INSERT INTO workspace_api_keys")) {
			if (this.failNextInsert) {
				this.failNextInsert = false;
				throw new Error("simulated INSERT failure (e.g. connection drop mid-rotation)");
			}
			const [id, workspaceId, provider, encryptedKey, keyHint, addedBy, createdAt] = params as [
				string, string, string, Buffer, string, string, string,
			];
			// Enforce the partial unique index: at most one active row per (ws, provider).
			if (this.rows.some((r) => r.workspace_id === workspaceId && r.provider === provider && !r.disabled_at)) {
				const err = new Error("duplicate key value violates unique constraint \"workspace_api_keys_active_uniq\"");
				(err as { code?: string }).code = "23505";
				throw err;
			}
			const row: FakeApiKeyRow = {
				id, workspace_id: workspaceId, provider, encrypted_key: Buffer.from(encryptedKey),
				key_hint: keyHint, added_by: addedBy, created_at: createdAt, last_used_at: null, disabled_at: null,
			};
			this.rows.push(row);
			return [{ ...row }] as T[];
		}

		if (sql.includes("FROM workspace_api_keys") && sql.includes("disabled_at IS NULL") && sql.includes("provider = $2")) {
			const [workspaceId, provider] = params as string[];
			const active = this.rows
				.filter((r) => r.workspace_id === workspaceId && r.provider === provider && !r.disabled_at)
				.sort((a, b) => b.created_at.localeCompare(a.created_at));
			return active.slice(0, 1).map((r) => ({ ...r })) as T[];
		}

		throw new Error(`Unexpected SQL in FakeByoSqlClient: ${sql}`);
	}

	activeCount(workspaceId: string, provider: string): number {
		return this.rows.filter((r) => r.workspace_id === workspaceId && r.provider === provider && !r.disabled_at).length;
	}
}

function makeKeyRecord(overrides: Partial<WorkspaceApiKeyRecord> = {}): WorkspaceApiKeyRecord {
	return {
		id: overrides.id ?? `key-${Math.random().toString(36).slice(2)}`,
		workspaceId: overrides.workspaceId ?? "ws-studio",
		provider: overrides.provider ?? "openai",
		encryptedKey: overrides.encryptedKey ?? Buffer.from("enc"),
		keyHint: overrides.keyHint ?? "1234",
		addedBy: overrides.addedBy ?? "user-1",
		createdAt: overrides.createdAt ?? new Date().toISOString(),
	};
}

describe("PostgresByoApiStore.upsertKey atomic rotation (rank 16)", () => {
	test("a failed INSERT rolls back the disable so the PRIOR key stays active", async () => {
		const client = new FakeByoSqlClient();
		const store = new PostgresByoApiStore(client as never);

		const first = await store.upsertKey(makeKeyRecord({ id: "key-1", keyHint: "1111", createdAt: "2026-01-01T00:00:00.000Z" }));
		expect(client.activeCount("ws-studio", "openai")).toBe(1);

		// Rotation whose INSERT fails mid-transaction.
		client.failNextInsert = true;
		await expect(
			store.upsertKey(makeKeyRecord({ id: "key-2", keyHint: "2222", createdAt: "2026-02-01T00:00:00.000Z" })),
		).rejects.toThrow(/simulated INSERT failure/);

		// CRITICAL: the prior key is still the single active key — no zero-key window.
		expect(client.activeCount("ws-studio", "openai")).toBe(1);
		const active = await store.getActiveKey("ws-studio", "openai");
		expect(active?.id).toBe("key-1");
		expect(active?.keyHint).toBe("1111");
	});

	test("a successful rotation retires the old key and activates exactly the new one", async () => {
		const client = new FakeByoSqlClient();
		const store = new PostgresByoApiStore(client as never);

		await store.upsertKey(makeKeyRecord({ id: "key-1", keyHint: "1111", createdAt: "2026-01-01T00:00:00.000Z" }));
		const rotated = await store.upsertKey(makeKeyRecord({ id: "key-2", keyHint: "2222", createdAt: "2026-02-01T00:00:00.000Z" }));

		expect(rotated.id).toBe("key-2");
		expect(client.activeCount("ws-studio", "openai")).toBe(1);
		const active = await store.getActiveKey("ws-studio", "openai");
		expect(active?.id).toBe("key-2");
	});

	test("a concurrent unique-violation surfaces a clean 409, not an unhandled 500", async () => {
		const client = new FakeByoSqlClient();
		const store = new PostgresByoApiStore(client as never);
		// Seed an active row directly, then make the UPDATE a no-op so the INSERT
		// races into the partial unique index — exactly the concurrent-rotation case.
		client.rows.push({
			id: "key-existing", workspace_id: "ws-studio", provider: "openai",
			encrypted_key: Buffer.from("enc"), key_hint: "9999", added_by: "user-1",
			created_at: "2026-01-01T00:00:00.000Z", last_used_at: null, disabled_at: null,
		});
		// Override UPDATE to leave the active row in place (simulating a racing tx that
		// already re-inserted), so our INSERT collides on the partial unique index.
		const realUnsafe = client.unsafe.bind(client);
		client.unsafe = (async (query: string, params: unknown[] = []) => {
			if (query.replace(/\s+/g, " ").trim().startsWith("UPDATE workspace_api_keys SET disabled_at = now()")) {
				return [];
			}
			return realUnsafe(query, params);
		}) as typeof client.unsafe;

		await expect(
			store.upsertKey(makeKeyRecord({ id: "key-new", keyHint: "8888" })),
		).rejects.toMatchObject({ code: "byo_key_rotation_conflict", status: 409 });
	});
});
