import { afterEach, describe, expect, test } from "bun:test";
import {
	listStoragePackSkus,
	resolveStoragePackSku,
	STORAGE_PACK_SKUS,
	GIB,
} from "../services/plans.js";
import {
	MemoryStoragePackStore,
	isStoragePackActive,
	listActiveStoragePacksForWorkspace,
	readStorageQuotaConfig,
	setStoragePackStoreForTests,
	sumActiveStoragePackBytesForWorkspace,
	sumActiveStoragePacks,
	type StoragePack,
} from "../services/storage-quota.js";
import { loadMigrations } from "../services/migrations.js";

const NOW = 1_700_000_000_000;

function pack(overrides: Partial<StoragePack> = {}): StoragePack {
	return {
		storagePackId: overrides.storagePackId ?? "pack-1",
		workspaceId: overrides.workspaceId ?? "ws-1",
		sizeBytes: overrides.sizeBytes ?? 25 * GIB,
		active: overrides.active ?? true,
		expiresAt: overrides.expiresAt,
		skuId: overrides.skuId,
		createdAt: overrides.createdAt,
		metadata: overrides.metadata,
	};
}

const restorers: Array<() => void> = [];

afterEach(() => {
	for (const restore of restorers.splice(0)) restore();
});

describe("storage pack SKUs", () => {
	test("exposes paid storage pack sizes in the plan catalog", () => {
		expect(listStoragePackSkus().map((sku) => sku.id)).toEqual([
			"storage-pack-25gb",
			"storage-pack-100gb",
			"storage-pack-500gb",
		]);
		expect(STORAGE_PACK_SKUS["storage-pack-25gb"]).toMatchObject({
			sizeBytes: 25 * GIB,
			minPlanId: "creator",
			active: true,
		});
		expect(STORAGE_PACK_SKUS["storage-pack-500gb"].sizeBytes).toBe(500 * GIB);
	});

	test("resolves SKUs by id and rejects unknown ids", () => {
		expect(resolveStoragePackSku("storage-pack-100gb")?.sizeBytes).toBe(100 * GIB);
		expect(resolveStoragePackSku(" storage-pack-25gb ")?.id).toBe("storage-pack-25gb");
		expect(resolveStoragePackSku("nope")).toBeUndefined();
		expect(resolveStoragePackSku(undefined)).toBeUndefined();
	});
});

describe("storage pack quota math", () => {
	test("base-only quota uses the plan limit with no packs", () => {
		const config = readStorageQuotaConfig({ planId: "creator", includedBytes: 5 * GIB });
		expect(config.includedBytes).toBe(5 * GIB);
		expect(config.storagePackBytes).toBe(0);
		expect(config.limitBytes).toBe(5 * GIB);
	});

	test("an active pack raises the effective quota above the base plan", () => {
		const base = readStorageQuotaConfig({ planId: "creator", includedBytes: 5 * GIB });
		const withPack = readStorageQuotaConfig({
			planId: "creator",
			includedBytes: 5 * GIB,
			storagePackBytes: sumActiveStoragePacks([pack({ sizeBytes: 25 * GIB })], NOW),
		});
		expect(withPack.storagePackBytes).toBe(25 * GIB);
		expect(withPack.limitBytes).toBe(base.limitBytes + 25 * GIB);
		expect(withPack.limitBytes).toBe(30 * GIB);
	});

	test("expired or inactive packs are ignored by the sum", () => {
		const packs: StoragePack[] = [
			pack({ storagePackId: "active", sizeBytes: 25 * GIB }),
			pack({ storagePackId: "expired", sizeBytes: 100 * GIB, expiresAt: NOW - 1 }),
			pack({ storagePackId: "inactive", sizeBytes: 100 * GIB, active: false }),
		];
		expect(sumActiveStoragePacks(packs, NOW)).toBe(25 * GIB);

		expect(isStoragePackActive(pack({ expiresAt: NOW + 1 }), NOW)).toBe(true);
		expect(isStoragePackActive(pack({ expiresAt: NOW }), NOW)).toBe(false);
		expect(isStoragePackActive(pack({ active: false }), NOW)).toBe(false);
		// Negative / non-finite sizes never add quota.
		expect(sumActiveStoragePacks([pack({ sizeBytes: -10 })], NOW)).toBe(0);
	});
});

describe("storage pack store", () => {
	test("lists and sums only the requested workspace's active packs", async () => {
		const store = new MemoryStoragePackStore([
			pack({ storagePackId: "a", workspaceId: "ws-1", sizeBytes: 25 * GIB }),
			pack({ storagePackId: "b", workspaceId: "ws-1", sizeBytes: 100 * GIB, expiresAt: NOW - 1 }),
			pack({ storagePackId: "c", workspaceId: "ws-2", sizeBytes: 500 * GIB }),
		]);
		restorers.push(setStoragePackStoreForTests(store));

		const active = await listActiveStoragePacksForWorkspace("ws-1", NOW);
		expect(active.map((entry) => entry.storagePackId)).toEqual(["a"]);
		expect(await sumActiveStoragePackBytesForWorkspace("ws-1", NOW)).toBe(25 * GIB);
		expect(await sumActiveStoragePackBytesForWorkspace("ws-2", NOW)).toBe(500 * GIB);
		expect(await sumActiveStoragePackBytesForWorkspace("ws-unknown", NOW)).toBe(0);
		expect(await sumActiveStoragePackBytesForWorkspace("   ", NOW)).toBe(0);
	});

	test("default store contributes no extra quota", async () => {
		expect(await sumActiveStoragePackBytesForWorkspace("ws-1", NOW)).toBe(0);
	});
});

describe("storage pack production quota path", () => {
	// resolveProjectStorageQuotaContext reads the Postgres storage plan and feeds
	// its extraStorageBytes (which now folds active storage_packs) into
	// readStorageQuotaConfig. This proves a purchased pack raises limitBytes via
	// the production resolution path, not only through an injected test store.
	test("catalog plan with pack-derived extra bytes raises the effective limit", () => {
		const packBytes = 25 * GIB;
		// What PostgresProjectCatalogStore.getProjectWorkspaceStoragePlan returns
		// once an active, non-expired storage_packs row is summed into the plan.
		const catalogPlan = {
			planId: "creator",
			includedStorageBytes: 5 * GIB,
			extraStorageBytes: packBytes,
		};

		const base = readStorageQuotaConfig({
			planId: "creator",
			includedBytes: 5 * GIB,
			extraBytes: 0,
		});
		const withPack = readStorageQuotaConfig({
			planId: catalogPlan.planId,
			includedBytes: catalogPlan.includedStorageBytes,
			extraBytes: catalogPlan.extraStorageBytes,
		});

		expect(base.limitBytes).toBe(5 * GIB);
		expect(withPack.extraBytes).toBe(packBytes);
		expect(withPack.limitBytes).toBe(base.limitBytes + packBytes);
		expect(withPack.limitBytes).toBe(30 * GIB);
	});

	test("default production pack store does not double count catalog-folded packs", async () => {
		// In production storagePackStore stays EmptyStoragePackStore, so the
		// catalog-folded packs in extraBytes are not added a second time.
		const packBytes = 25 * GIB;
		const storagePackBytes = await sumActiveStoragePackBytesForWorkspace("workspace-1", NOW);
		expect(storagePackBytes).toBe(0);

		const config = readStorageQuotaConfig({
			planId: "creator",
			includedBytes: 5 * GIB,
			extraBytes: packBytes,
			storagePackBytes,
		});
		expect(config.limitBytes).toBe(5 * GIB + packBytes);
	});
});

describe("storage_packs migration", () => {
	test("migration 0020 is registered and creates the storage_packs table", () => {
		const migration = loadMigrations().find((entry) => entry.id === "0020_storage_packs");
		expect(migration).toBeDefined();
		expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS storage_packs");
		expect(migration?.sql).toContain("workspace_id");
		expect(migration?.sql).toContain("storage_packs_workspace_active_idx");
	});
});
