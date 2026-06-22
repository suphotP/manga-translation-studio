import { describe, expect, test } from "bun:test";
import {
	QuotaFrozenError,
	StorageCowService,
	StorageCowAuthorizationError,
	sha256Hex,
	type AssetAccountKind,
	type StorageCowSqlClient,
} from "../services/storage-cow.js";
import type { ContentBlobInput, ContentBlobReadInput, ObjectStorage, StoredObject } from "../services/storage.js";
import type { AssetModerationResult } from "../types/index.js";

const PASSED_VERDICT: AssetModerationResult = { status: "passed", provider: "test", checkedAt: "2026-06-10T00:00:00.000Z" };
const FAIL_CLOSED_VERDICT: AssetModerationResult = { status: "needs_review", provider: "test", checkedAt: "2026-06-10T00:00:00.000Z", failClosed: true };
const BLOCKED_VERDICT: AssetModerationResult = { status: "blocked", provider: "test", checkedAt: "2026-06-10T00:00:00.000Z", reason: "csam" };

class FakeContentStorage implements Pick<ObjectStorage, "driver" | "putContentBlob" | "hasContentBlob" | "deleteContentBlob"> {
	readonly driver = "local" as const;
	readonly blobs = new Set<string>();
	putCalls = 0;
	// When set, the NEXT putContentBlob throws (then the flag clears). Used to
	// simulate a post-commit object-write failure so the test can assert the
	// committed content_blobs row keeps the bytes tracked for GC/retry.
	failNextPut = false;

	async putContentBlob(input: ContentBlobInput): Promise<StoredObject> {
		if (this.failNextPut) {
			this.failNextPut = false;
			throw new Error("simulated object-store write failure");
		}
		this.putCalls += 1;
		this.blobs.add(input.sha256);
		return { driver: this.driver, key: `content/${input.sha256}` };
	}

	hasContentBlob(input: ContentBlobReadInput): boolean {
		return this.blobs.has(input.sha256);
	}

	async deleteContentBlob(input: ContentBlobReadInput): Promise<boolean> {
		return this.blobs.delete(input.sha256);
	}
}

interface FakeBlob {
	sha256: string;
	byteSize: number;
	mimeType: string;
	storageDriver: string;
	storageKey: string;
	refCount: number;
}

interface FakeVersion {
	versionId: string;
	assetId: string;
	sha256: string;
	branch: "master" | "working_copy";
	accountKind: AssetAccountKind;
	accountId: string;
	// Per-version moderation state (migration 0083). NULL when no verdict was threaded.
	moderationStatus?: string | null;
	storageStatus?: string | null;
}

class FakeCowClient implements StorageCowSqlClient {
	readonly blobs = new Map<string, FakeBlob>();
	readonly versions = new Map<string, FakeVersion>();
	readonly refs = new Map<string, number>();
	readonly quota = new Map<string, { used: number; limit: number; frozen?: boolean }>();
	readonly assetRecords = new Map<string, {
		asset_id: string;
		original_name: string;
		project_id?: string;
		workspace_id?: string;
		project_workspace_id?: string;
		project_user_id?: string;
		// Personal (workspace-less) project: suppress the workspace-1 fallback so
		// the join surfaces NULL workspace ids, exercising the personal-promote
		// path. project_user_id then drives ownership/quota routing.
		personal?: boolean;
		// Record-level moderation/storage state (asset_records). Seed a master's
		// status so tests can assert a working-copy write never mutates it.
		storage_status?: string;
		moderation_status?: string;
	}>();
	readonly workspaceMembers = new Map<string, string>();
	readonly ensuredWorkspaceQuotaRows = new Set<string>();
	readonly ensuredUserQuotaRows = new Set<string>();
	readonly queryLog: string[] = [];
	versionSequence = 0;

	async begin<T>(fn: (transaction: StorageCowSqlClient) => Promise<T>): Promise<T> {
		// Snapshot the mutable state so a thrown callback rolls back like a real
		// transaction. Without this, rows inserted before a mid-transaction throw
		// (e.g. the asset_versions/asset_refs writes that precede the quota gate)
		// would leak into the fake's maps and mask rollback regressions.
		const snapshot = {
			blobs: new Map([...this.blobs].map(([k, v]) => [k, { ...v }])),
			versions: new Map([...this.versions].map(([k, v]) => [k, { ...v }])),
			refs: new Map(this.refs),
			quota: new Map([...this.quota].map(([k, v]) => [k, { ...v }])),
			versionSequence: this.versionSequence,
		};
		try {
			return await fn(this);
		} catch (error) {
			this.blobs.clear();
			for (const [k, v] of snapshot.blobs) this.blobs.set(k, v);
			this.versions.clear();
			for (const [k, v] of snapshot.versions) this.versions.set(k, v);
			this.refs.clear();
			for (const [k, v] of snapshot.refs) this.refs.set(k, v);
			this.quota.clear();
			for (const [k, v] of snapshot.quota) this.quota.set(k, v);
			this.versionSequence = snapshot.versionSequence;
			throw error;
		}
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();
		this.queryLog.push(normalized);
		if (normalized.includes("FROM content_blobs") && normalized.includes("FOR UPDATE") && !normalized.includes("JOIN")) {
			const blob = this.blobs.get(this.hex(params[0]));
			return (blob ? [{
				byte_size: blob.byteSize,
				storage_driver: blob.storageDriver,
				storage_key: blob.storageKey,
				ref_count: blob.refCount,
			}] : []) as T[];
		}
		// gcOrphanBlobs candidate scan: collect (without deleting) every blob row
		// whose ref_count has dropped to zero. The actual eviction happens per-sha
		// under a re-locked re-check in the DELETE ... AND ref_count = 0 branch.
		if (normalized.startsWith("SELECT sha256 FROM content_blobs WHERE ref_count = 0")) {
			// BOUNDED scan: honor the LIMIT $1 the per-tick batch cap passes so the
			// fake matches the real SELECT … LIMIT semantics (resumability test).
			const limit = normalized.includes("LIMIT $1") ? Number(params[0]) : Infinity;
			return [...this.blobs.values()]
				.filter((blob) => blob.refCount === 0)
				.slice(0, Number.isFinite(limit) ? limit : undefined)
				.map((blob) => ({ sha256: Buffer.from(blob.sha256, "hex") })) as T[];
		}
		if (normalized.startsWith("INSERT INTO content_blobs")) {
			const sha = this.hex(params[0]);
			const existing = this.blobs.get(sha);
			if (existing) {
				existing.refCount += 1;
				// Mirror the ON CONFLICT DO UPDATE that re-points a backfilled
				// row at the freshly materialized content/<sha> object.
				existing.byteSize = Number(params[1]);
				existing.mimeType = String(params[2]);
				existing.storageDriver = String(params[3]);
				existing.storageKey = String(params[4]);
			} else {
				this.blobs.set(sha, {
					sha256: sha,
					byteSize: Number(params[1]),
					mimeType: String(params[2]),
					storageDriver: String(params[3]),
					storageKey: String(params[4]),
					refCount: 1,
				});
			}
			return [] as T[];
		}
		if (normalized.includes("FROM asset_refs") && normalized.includes("FOR UPDATE")) {
			const count = this.refs.get(this.refKey(params[0] as AssetAccountKind, String(params[1]), this.hex(params[2]))) ?? 0;
			return (count > 0 ? [{ ref_count: count }] : []) as T[];
		}
		// assertParentVersionMatchesAsset: resolve a parent version's asset_id so
		// the service can reject cross-asset parent chains before inserting.
		if (normalized.startsWith("SELECT asset_id FROM asset_versions WHERE version_id")) {
			const version = this.versions.get(String(params[0]));
			return (version ? [{ asset_id: version.assetId }] : []) as T[];
		}
		// countOtherMasterVersions: how many OTHER master versions the asset still
		// has, so deleteVersion can refuse to drop the asset's last master.
		if (normalized.startsWith("SELECT COUNT(*) AS count FROM asset_versions")) {
			const assetId = String(params[0]);
			const excludeVersionId = String(params[1]);
			const count = [...this.versions.values()].filter(
				(version) => version.assetId === assetId && version.branch === "master" && version.versionId !== excludeVersionId,
			).length;
			return [{ count }] as T[];
		}
		if (normalized.startsWith("INSERT INTO asset_versions")) {
			const versionId = `00000000-0000-4000-8000-${String(++this.versionSequence).padStart(12, "0")}`;
			this.versions.set(versionId, {
				versionId,
				assetId: String(params[0]),
				sha256: this.hex(params[2]),
				branch: params[3] as "master" | "working_copy",
				accountKind: params[4] as AssetAccountKind,
				accountId: String(params[5]),
				// Per-version moderation columns (0083): $8 moderation_status, $9 storage_status.
				moderationStatus: (params[7] as string | null) ?? null,
				storageStatus: (params[8] as string | null) ?? null,
			});
			return [{ version_id: versionId }] as T[];
		}
			if (normalized.startsWith("INSERT INTO asset_refs")) {
				const key = this.refKey(params[0] as AssetAccountKind, String(params[1]), this.hex(params[2]));
				const refCount = (this.refs.get(key) ?? 0) + 1;
				this.refs.set(key, refCount);
				return [{ ref_count: refCount }] as T[];
			}
			if (normalized.startsWith("INSERT INTO workspace_billing_accounts")) {
				const key = `workspace:${String(params[0])}`;
				const quota = this.quota.get(key) ?? { used: 0, limit: Number(params[1]) || 1073741824 };
				if (normalized.includes("storage_frozen_at")) quota.frozen = true;
				this.quota.set(key, quota);
				this.ensuredWorkspaceQuotaRows.add(String(params[0]));
				return [] as T[];
			}
			// Row-lock probes added by ensureQuotaRowForUpdate. They select a
			// constant under FOR UPDATE purely to serialize concurrent first
			// writers on the (now-existing) quota row; the fake just acknowledges.
			if (normalized.startsWith("SELECT 1 FROM workspace_billing_accounts") && normalized.includes("FOR UPDATE")) {
				return [{ "?column?": 1 }] as T[];
			}
			if (normalized.startsWith("SELECT 1 FROM user_storage_accounts") && normalized.includes("FOR UPDATE")) {
				return [{ "?column?": 1 }] as T[];
			}
			// ensureUserQuotaRow: create a zeroed row for a real user if absent.
			if (normalized.startsWith("INSERT INTO user_storage_accounts") && normalized.includes("FROM auth_users")) {
				const key = `user:${String(params[0])}`;
				this.ensuredUserQuotaRows.add(String(params[0]));
				if (!this.quota.has(key)) {
					this.quota.set(key, { used: 0, limit: Number(params[1]) || 1073741824 });
				}
				return [] as T[];
			}
			if (normalized.includes("FROM workspace_billing_accounts") && normalized.includes("FOR UPDATE")) {
				return this.quotaRows("workspace", String(params[0])) as T[];
		}
		if (normalized.includes("FROM user_storage_accounts") && normalized.includes("FOR UPDATE")) {
			return this.quotaRows("user", String(params[0])) as T[];
		}
			if (normalized.startsWith("UPDATE workspace_billing_accounts") && normalized.includes("storage_used_bytes = storage_used_bytes +")) {
				this.addQuota("workspace", String(params[0]), Number(params[1]));
				return [{ workspace_id: String(params[0]) }] as T[];
		}
		if (normalized.startsWith("INSERT INTO user_storage_accounts") && normalized.includes("ON CONFLICT (user_id) DO UPDATE SET used_bytes")) {
			this.addQuota("user", String(params[0]), Number(params[1]));
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO user_storage_accounts") && normalized.includes("frozen_at")) {
			const key = `user:${String(params[0])}`;
			const quota = this.quota.get(key) ?? { used: 0, limit: 1073741824 };
			quota.frozen = true;
			this.quota.set(key, quota);
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts") && normalized.includes("storage_frozen_at = now()")) {
			const key = `workspace:${String(params[0])}`;
			const quota = this.quota.get(key) ?? { used: 0, limit: 1073741824 };
			quota.frozen = true;
			this.quota.set(key, quota);
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts") && normalized.includes("storage_frozen_at = NULL")) {
			const key = `workspace:${String(params[0])}`;
			const quota = this.quota.get(key);
			if (quota) quota.frozen = false;
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE user_storage_accounts") && normalized.includes("frozen_at = NULL")) {
			const key = `user:${String(params[0])}`;
			const quota = this.quota.get(key);
			if (quota) quota.frozen = false;
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts") && normalized.includes("GREATEST(0, storage_used_bytes -")) {
			this.addQuota("workspace", String(params[0]), -Number(params[1]));
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE user_storage_accounts") && normalized.includes("GREATEST(0, used_bytes -")) {
			this.addQuota("user", String(params[0]), -Number(params[1]));
			return [] as T[];
		}
			// deleteAssetsForProject / deleteAssetCowStorage: project- (and
			// optionally asset-) scoped sweep over a project's versions.
			if (normalized.includes("FROM asset_versions")
				&& normalized.includes("JOIN content_blobs")
				&& normalized.includes("WHERE asset_records.project_id = $1")) {
				const projectId = String(params[0]);
				const assetIdFilter = normalized.includes("AND asset_records.asset_id = $2")
					? String(params[1])
					: undefined;
				return [...this.versions.values()]
					.filter((version) => {
						const record = this.assetRecords.get(version.assetId);
						if ((record?.project_id ?? "project-1") !== projectId) return false;
						if (assetIdFilter !== undefined && (record?.asset_id ?? version.assetId) !== assetIdFilter) return false;
						return true;
					})
					.map((version) => ({
						version_id: version.versionId,
						sha256: Buffer.from(version.sha256, "hex"),
						account_kind: version.accountKind,
						account_id: version.accountId,
						byte_size: this.blobs.get(version.sha256)?.byteSize ?? 0,
					})) as T[];
			}
			// applyAssetModeration / applyAssetModerationFromVersion: persist the
			// record-level moderation/storage_status keyed by the asset_records.id uuid.
			if (normalized.startsWith("UPDATE asset_records") && normalized.includes("storage_status =")) {
				const record = this.assetRecords.get(String(params[0]));
				if (record) {
					record.storage_status = String(params[1]);
					record.moderation_status = String(params[2]);
				}
				return [] as T[];
			}
			// deleteAssetsForProject's final asset_records cleanup.
			if (normalized.startsWith("DELETE FROM asset_records WHERE project_id = $1")) {
				const projectId = String(params[0]);
				for (const [id, record] of [...this.assetRecords]) {
					if ((record.project_id ?? "project-1") === projectId) this.assetRecords.delete(id);
				}
				return [] as T[];
			}
			if (normalized.includes("FROM asset_versions") && normalized.includes("JOIN content_blobs") && normalized.includes("FOR UPDATE")) {
				const version = this.versions.get(String(params[0]));
				if (!version) return [] as T[];
				const blob = this.blobs.get(version.sha256)!;
				const record = this.assetRecords.get(version.assetId);
				return [{
					version_id: version.versionId,
					asset_id: version.assetId,
					sha256: Buffer.from(version.sha256, "hex"),
					branch: version.branch,
					account_kind: version.accountKind,
					account_id: version.accountId,
					moderation_status: version.moderationStatus ?? null,
					storage_status: version.storageStatus ?? null,
					moderation_provider: null,
					moderation_reason: null,
					moderation_detail: null,
					moderation_checked_at: null,
					moderation_ruleset_version: null,
					asset_project_id: record?.project_id ?? "project-1",
					asset_workspace_id: record?.personal ? null : (record?.workspace_id ?? "workspace-1"),
					project_workspace_id: record?.personal ? null : (record?.project_workspace_id ?? record?.workspace_id ?? "workspace-1"),
					project_user_id: record?.project_user_id ?? "owner-1",
					byte_size: blob.byteSize,
					storage_driver: blob.storageDriver,
					storage_key: blob.storageKey,
				}] as T[];
			}
			if (normalized.startsWith("SELECT asset_records.id AS asset_id")) {
				const record = this.assetRecords.get(String(params[0]));
				if (!record) return [] as T[];
				const workspaceId = record.workspace_id ?? record.project_workspace_id;
				return [{
					asset_id: String(params[0]),
					project_id: record.project_id ?? "project-1",
					workspace_id: record.workspace_id ?? null,
					project_workspace_id: record.project_workspace_id ?? record.workspace_id ?? null,
					project_user_id: record.project_user_id ?? "owner-1",
					member_role: workspaceId ? this.workspaceMembers.get(`${workspaceId}:${String(params[1])}`) ?? null : null,
				}] as T[];
			}
			if (normalized.startsWith("SELECT role FROM workspace_members")) {
				const role = this.workspaceMembers.get(`${String(params[0])}:${String(params[1])}`);
				return (role ? [{ role }] : []) as T[];
			}
		if (normalized.startsWith("UPDATE asset_refs")) {
			const key = this.refKey(params[0] as AssetAccountKind, String(params[1]), this.hex(params[2]));
			this.refs.set(key, Math.max(0, (this.refs.get(key) ?? 0) - 1));
			return [] as T[];
		}
		if (normalized.startsWith("DELETE FROM asset_refs")) {
			const key = this.refKey(params[0] as AssetAccountKind, String(params[1]), this.hex(params[2]));
			if ((this.refs.get(key) ?? 0) === 0) this.refs.delete(key);
			return [] as T[];
		}
		// promoteToMaster's attribution transfer: branch -> master and re-point the
		// version at the resolved target account (workspace OR, for a personal
		// project, the owning user account). account_kind/account_id are now bound
		// params ($2/$3) instead of a hardcoded 'workspace'.
		if (normalized.startsWith("UPDATE asset_versions") && normalized.includes("account_kind = $2::asset_account_kind")) {
			const version = this.versions.get(String(params[0]));
			if (version) {
				version.branch = "master";
				version.accountKind = params[1] as AssetAccountKind;
				version.accountId = String(params[2]);
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE asset_versions SET branch = 'master'")) {
			const version = this.versions.get(String(params[0]));
			if (version) version.branch = "master";
			return [] as T[];
		}
		if (normalized.startsWith("DELETE FROM asset_versions")) {
			this.versions.delete(String(params[0]));
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE content_blobs")) {
			const blob = this.blobs.get(this.hex(params[0]));
			if (blob) blob.refCount = Math.max(0, blob.refCount - 1);
			return [] as T[];
		}
		// gcOrphanBlobs eviction: delete a single re-locked, re-verified orphan by
		// sha. The AND ref_count = 0 guard mirrors the production query so a row
		// re-referenced after the candidate scan is never dropped.
		if (normalized.startsWith("DELETE FROM content_blobs") && normalized.includes("WHERE sha256 = $1 AND ref_count = 0")) {
			const sha = this.hex(params[0]);
			const blob = this.blobs.get(sha);
			if (blob && blob.refCount === 0) {
				this.blobs.delete(sha);
				return [] as T[];
			}
			return [] as T[];
		}
		if (normalized.includes("ORDER BY content_blobs.byte_size DESC")) {
			const accountKind = params[0] as AssetAccountKind;
			const accountId = String(params[1]);
			return [...this.versions.values()]
				.filter((version) => version.accountKind === accountKind && version.accountId === accountId)
				.map((version) => {
					const record = this.assetRecords.get(version.assetId);
					return {
						name: record?.original_name ?? version.assetId,
						size: this.blobs.get(version.sha256)?.byteSize ?? 0,
						kind: accountKind,
						asset_id: record?.asset_id ?? version.assetId,
					};
				})
				.sort((left, right) => right.size - left.size)
				.slice(0, 5) as T[];
		}
		throw new Error(`Unhandled fake query: ${normalized}`);
	}

	private quotaRows(kind: AssetAccountKind, accountId: string): Array<Record<string, unknown>> {
		const quota = this.quota.get(`${kind}:${accountId}`) ?? { used: 0, limit: 1073741824 };
		return [{
			used_bytes: quota.used,
			limit_bytes: quota.limit,
			frozen_at: quota.frozen ? "2026-06-02T00:00:00.000Z" : null,
		}];
	}

	private addQuota(kind: AssetAccountKind, accountId: string, bytes: number): void {
		const key = `${kind}:${accountId}`;
		const quota = this.quota.get(key) ?? { used: 0, limit: 1073741824 };
		quota.used = Math.max(0, quota.used + bytes);
		this.quota.set(key, quota);
	}

	private refKey(kind: AssetAccountKind, accountId: string, sha: string): string {
		return `${kind}:${accountId}:${sha}`;
	}

	private hex(value: unknown): string {
		if (Buffer.isBuffer(value)) return value.toString("hex");
		return String(value).replace(/^\\x/, "");
	}
}

const ASSET_A = "00000000-0000-4000-8000-0000000000aa";
const ASSET_B = "00000000-0000-4000-8000-0000000000bb";

function createHarness() {
	const client = new FakeCowClient();
	client.assetRecords.set(ASSET_A, { asset_id: "page-a.png", original_name: "Page A", project_id: "project-1", workspace_id: "workspace-1", project_user_id: "owner-1" });
	client.assetRecords.set(ASSET_B, { asset_id: "page-b.png", original_name: "Page B", project_id: "project-1", workspace_id: "workspace-1", project_user_id: "owner-1" });
	client.workspaceMembers.set("workspace-1:admin-1", "admin");
	client.workspaceMembers.set("workspace-1:editor-1", "editor");
	client.workspaceMembers.set("workspace-1:viewer-1", "viewer");
	const storage = new FakeContentStorage();
	return { client, storage, service: new StorageCowService({ client, storage: storage as unknown as ObjectStorage }) };
}

describe("storage CoW service", () => {
	test("writeBlob new SHA inserts content, version, refs, and charges bytes", async () => {
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("new-content");
		const result = await service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		});

		expect(result.sha256).toBe(sha256Hex(buffer));
		expect(result.bytes_charged).toBe(buffer.byteLength);
		expect(client.blobs.get(result.sha256)?.refCount).toBe(1);
		expect(client.versions.get(result.version_id)).toEqual(expect.objectContaining({ assetId: ASSET_A, branch: "master" }));
		expect(client.refs.get(`workspace:workspace-1:${result.sha256}`)).toBe(1);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
		expect(client.ensuredWorkspaceQuotaRows.has("workspace-1")).toBe(true);
		expect(storage.blobs.has(result.sha256)).toBe(true);
	});

	test("writeBlob existing SHA increments refs and charges zero bytes", async () => {
		const { client, service } = createHarness();
		const buffer = Buffer.from("same-content");
		const first = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		const second = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_B });

		expect(second.sha256).toBe(first.sha256);
		expect(second.bytes_charged).toBe(0);
		expect(client.blobs.get(first.sha256)?.refCount).toBe(2);
		expect(client.refs.get(`workspace:workspace-1:${first.sha256}`)).toBe(2);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
	});

	test("writeBlob charges from atomic asset_refs upsert so an existing account ref is not double-counted", async () => {
		const { client, service } = createHarness();
		const buffer = Buffer.from("atomic-account-ref");
		const sha = sha256Hex(buffer);
		client.refs.set(`workspace:workspace-1:${sha}`, 1);
		client.blobs.set(sha, { sha256: sha, byteSize: buffer.byteLength, mimeType: "image/png", storageDriver: "local", storageKey: `content/${sha}`, refCount: 1 });
		client.quota.set("workspace:workspace-1", { used: buffer.byteLength, limit: 1073741824 });

		const result = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });

		expect(result.bytes_charged).toBe(0);
		expect(client.refs.get(`workspace:workspace-1:${sha}`)).toBe(2);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
	});

	test("writeBlob over user quota throws QuotaFrozenError with top 5 assets", async () => {
		const { client, service } = createHarness();
		client.quota.set("user:user-1", { used: 0, limit: 10 });
		await service.writeBlob({ buffer: Buffer.from("old"), mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_A });

		await expect(service.writeBlob({
			buffer: Buffer.from("too-large"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_B,
		})).rejects.toBeInstanceOf(QuotaFrozenError);
	});

	// S1 regression: the CoW write gate must honor the PLAN-derived effective limit
	// (resolved from the same source storage-quota uses), not the hardcoded 1 GiB
	// row default that nothing ever writes a higher value into. A paid workspace
	// whose plan grants >1 GiB must be able to write PAST 1 GiB through the gate.
	test("writeBlob honors the plan-derived effective limit so a >1GiB workspace can write past 1GiB (S1)", async () => {
		const ONE_GIB = 1073741824;
		const client = new FakeCowClient();
		client.assetRecords.set(ASSET_A, { asset_id: "page-a.png", original_name: "Page A", project_id: "project-1", workspace_id: "workspace-1", project_user_id: "owner-1" });
		const storage = new FakeContentStorage();
		// Plan grants 5 GiB; the stored row limit stays the default 1 GiB (nothing
		// ever syncs it). The injected resolver mirrors resolveWorkspaceEffectiveStorageLimitBytes.
		const service = new StorageCowService({
			client,
			storage: storage as unknown as ObjectStorage,
			limitResolver: async (kind, id) => (kind === "workspace" && id === "workspace-1" ? 5 * ONE_GIB : null),
		});
		// Already 1 GiB used (at the OLD hardcoded ceiling). A new write would be
		// rejected by the old gate but must pass now.
		client.quota.set("workspace:workspace-1", { used: ONE_GIB, limit: ONE_GIB });

		const result = await service.writeBlob({
			buffer: Buffer.from("past-one-gib"),
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		});

		expect(result.bytes_charged).toBe(Buffer.from("past-one-gib").byteLength);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(ONE_GIB + Buffer.from("past-one-gib").byteLength);
		// getQuotaState (the /api/quota source) must report the plan limit, not 1 GiB.
		const state = await service.getQuotaState("workspace", "workspace-1");
		expect(state.limit).toBe(5 * ONE_GIB);
	});

	// S1 regression: still freeze on a TRUE overage of the plan limit (only the
	// limit value was wrong; the freeze-on-overage behavior must be preserved).
	test("writeBlob still rejects past the plan-derived limit (S1 keeps freeze-on-true-overage)", async () => {
		const ONE_GIB = 1073741824;
		const client = new FakeCowClient();
		client.assetRecords.set(ASSET_A, { asset_id: "page-a.png", original_name: "Page A", project_id: "project-1", workspace_id: "workspace-1", project_user_id: "owner-1" });
		const storage = new FakeContentStorage();
		const service = new StorageCowService({
			client,
			storage: storage as unknown as ObjectStorage,
			limitResolver: async () => 2 * ONE_GIB,
		});
		client.quota.set("workspace:workspace-1", { used: 2 * ONE_GIB, limit: ONE_GIB });

		await expect(service.writeBlob({
			buffer: Buffer.from("over-plan"),
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		})).rejects.toBeInstanceOf(QuotaFrozenError);
	});

	// S1 regression: when no plan resolves (resolver returns null) keep the stored
	// row limit so file-mode / unknown workspaces are unaffected.
	test("writeBlob falls back to the stored row limit when no plan resolves (S1)", async () => {
		const ONE_GIB = 1073741824;
		const client = new FakeCowClient();
		client.assetRecords.set(ASSET_A, { asset_id: "page-a.png", original_name: "Page A", project_id: "project-1", workspace_id: "workspace-1", project_user_id: "owner-1" });
		const storage = new FakeContentStorage();
		const service = new StorageCowService({
			client,
			storage: storage as unknown as ObjectStorage,
			limitResolver: async () => null,
		});
		client.quota.set("workspace:workspace-1", { used: ONE_GIB, limit: ONE_GIB });

		await expect(service.writeBlob({
			buffer: Buffer.from("no-plan-over"),
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		})).rejects.toBeInstanceOf(QuotaFrozenError);
	});

	test("writeBlob accepts a parentVersionId that belongs to the same asset", async () => {
		const { client, service } = createHarness();
		const parent = await service.writeBlob({ buffer: Buffer.from("parent-content"), mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_A });

		const child = await service.writeBlob({
			buffer: Buffer.from("child-content"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			parentVersionId: parent.version_id,
		});

		expect(client.versions.get(child.version_id)).toBeDefined();
	});

	test("writeBlob rejects a parentVersionId from a different asset (Codex P2 'Validate parent versions belong to the same asset')", async () => {
		const { client, service } = createHarness();
		// Parent version is created on ASSET_B; chaining it onto ASSET_A would
		// build a cross-asset/cross-tenant version graph.
		const foreignParent = await service.writeBlob({ buffer: Buffer.from("foreign-parent"), mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_B });

		await expect(service.writeBlob({
			buffer: Buffer.from("cross-asset-child"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			parentVersionId: foreignParent.version_id,
		})).rejects.toMatchObject({ code: "parent_version_asset_mismatch", status: 400 });

		// The rejected write left no new version/blob/ref behind (transaction rolled back).
		expect(client.versions.size).toBe(1);
	});

	test("writeBlob rejects a parentVersionId that does not exist", async () => {
		const { service } = createHarness();
		await expect(service.writeBlob({
			buffer: Buffer.from("orphan-parent-child"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			parentVersionId: "00000000-0000-4000-8000-000000009999",
		})).rejects.toMatchObject({ code: "parent_version_not_found", status: 404 });
	});

	test("promoteToMaster transfers attribution from user to workspace", async () => {
		const { client, service } = createHarness();
		const buffer = Buffer.from("working-copy");
		const result = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_A });

		await service.promoteToMaster({ versionId: result.version_id, workspaceId: "workspace-1", approverUserId: "admin-1" });

		expect(client.refs.get(`user:user-1:${result.sha256}`)).toBeUndefined();
		expect(client.refs.get(`workspace:workspace-1:${result.sha256}`)).toBe(1);
		expect(client.quota.get("user:user-1")?.used).toBe(0);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
		expect(client.versions.get(result.version_id)).toEqual(expect.objectContaining({ branch: "master", accountKind: "workspace", accountId: "workspace-1" }));
	});

	test("promoteToMaster rejects a workspace that does not own the version asset", async () => {
		const { client, service } = createHarness();
		client.workspaceMembers.set("workspace-2:admin-1", "admin");
		const result = await service.writeBlob({
			buffer: Buffer.from("wrong-workspace"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
		});

		await expect(service.promoteToMaster({
			versionId: result.version_id,
			workspaceId: "workspace-2",
			approverUserId: "admin-1",
		})).rejects.toBeInstanceOf(StorageCowAuthorizationError);
	});

	test("deleteVersion releases account quota when last ref is removed", async () => {
		const { client, service } = createHarness();
		const buffer = Buffer.from("delete-me");
		// A working_copy (requesterUserId set) is freely deletable; the active-master
		// guard only blocks dropping an asset's sole MASTER version.
		const result = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_A });

		await service.deleteVersion({ versionId: result.version_id, deleterUserId: "user-1" });

		expect(client.refs.get(`user:user-1:${result.sha256}`)).toBeUndefined();
		expect(client.quota.get("user:user-1")?.used).toBe(0);
		expect(client.blobs.get(result.sha256)?.refCount).toBe(0);
	});

	test("deleteVersion refuses to drop the asset's only master version (Codex P2 'Do not delete the active master version alone')", async () => {
		const { client, service } = createHarness();
		const buffer = Buffer.from("sole-master");
		// Master upload (no requesterUserId) for a workspace asset.
		const result = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });

		// User-facing delete of the only master is rejected so asset_records does
		// not end up pointing at a GC-reclaimed content blob.
		await expect(service.deleteVersion({ versionId: result.version_id, deleterUserId: "admin-1", deleterRole: "admin" }))
			.rejects.toMatchObject({ code: "active_master_version", status: 409 });

		// Version + refs + blob remain intact after the rejected delete.
		expect(client.versions.get(result.version_id)).toBeDefined();
		expect(client.refs.get(`workspace:workspace-1:${result.sha256}`)).toBe(1);
		expect(client.blobs.get(result.sha256)?.refCount).toBe(1);

		// System cleanup (rolling back a just-created upload) is exempt: it removes
		// the asset record too, so dropping the master is safe.
		await service.deleteVersion({ versionId: result.version_id, skipAuthorizationForSystemCleanup: true });
		expect(client.versions.get(result.version_id)).toBeUndefined();
	});

	test("deleteVersion allows dropping a master when another master remains", async () => {
		const { client, service } = createHarness();
		// Two distinct master versions on the same asset (different SHAs).
		const first = await service.writeBlob({ buffer: Buffer.from("master-one"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		await service.writeBlob({ buffer: Buffer.from("master-two"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });

		await service.deleteVersion({ versionId: first.version_id, deleterUserId: "admin-1", deleterRole: "admin" });
		expect(client.versions.get(first.version_id)).toBeUndefined();
	});

	test("deleteVersion rejects another user's working copy", async () => {
		const { service } = createHarness();
		const result = await service.writeBlob({
			buffer: Buffer.from("private-working-copy"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
		});

		await expect(service.deleteVersion({
			versionId: result.version_id,
			deleterUserId: "user-2",
			deleterRole: "editor",
		})).rejects.toBeInstanceOf(StorageCowAuthorizationError);
	});

	test("assertCanWriteAsset requires authenticated ownership or workspace editor access", async () => {
		const { service } = createHarness();

		await expect(service.assertCanWriteAsset({
			assetId: ASSET_A,
			accountKind: "workspace",
			accountId: "workspace-1",
			asWorkingCopy: false,
		})).rejects.toBeInstanceOf(StorageCowAuthorizationError);

		await expect(service.assertCanWriteAsset({
			assetId: ASSET_A,
			accountKind: "workspace",
			accountId: "workspace-1",
			requesterUserId: "viewer-1",
			requesterRole: "editor",
			asWorkingCopy: false,
		})).rejects.toBeInstanceOf(StorageCowAuthorizationError);

		// Authorized: resolves with the asset's owning workspace context (FINDING 2)
		// — the route threads this resolved workspaceId into moderation.
		// Authorized: resolves with the asset's owning workspace context (FINDING 2)
		// — the route threads this resolved workspaceId into moderation.
		await expect(service.assertCanWriteAsset({
			assetId: ASSET_A,
			accountKind: "workspace",
			accountId: "workspace-1",
			requesterUserId: "editor-1",
			requesterRole: "editor",
			asWorkingCopy: false,
		})).resolves.toEqual({ workspaceId: "workspace-1" });
	});

	test("assertCanWriteAsset REJECTS a USER working-copy upload of a workspace asset — bytes pool on the workspace (2026-06-13)", async () => {
		// Product decision: a seat member working on a workspace project must
		// always consume the workspace owner's pooled storage. A per-member
		// user-account fork of a WORKSPACE asset is therefore refused outright
		// (the old flow returned the resolved workspace and billed the member).
		const { service } = createHarness();
		await expect(service.assertCanWriteAsset({
			assetId: ASSET_A,
			accountKind: "user",
			accountId: "editor-1",
			requesterUserId: "editor-1",
			requesterRole: "editor",
			asWorkingCopy: true,
		})).rejects.toMatchObject({ code: "workspace_asset_user_account_forbidden", status: 403 });
	});

	test("assertCanWriteAsset returns no workspace for a personal (workspace-less) project asset (FINDING 2 fallback)", async () => {
		// A personal project has no owning workspace, so the resolution is undefined
		// and the route falls back to its accountKind-based workspaceId logic.
		const client = new FakeCowClient();
		client.assetRecords.set(ASSET_A, {
			asset_id: "page-a.png",
			original_name: "Page A",
			project_id: "personal-project",
			project_user_id: "solo-1",
			personal: true,
		});
		const storage = new FakeContentStorage();
		const service = new StorageCowService({ client, storage: storage as unknown as ObjectStorage });
		const authorization = await service.assertCanWriteAsset({
			assetId: ASSET_A,
			accountKind: "user",
			accountId: "solo-1",
			requesterUserId: "solo-1",
			requesterRole: "editor",
			asWorkingCopy: true,
		});
		expect(authorization).toEqual({ workspaceId: undefined });
	});

	test("assertAccountNotFrozen rejects ONLY a frozen account — at-limit accounts pass (dedupe charges zero bytes)", async () => {
		const { client, service } = createHarness();

		// Frozen flag set → reject (the admin abuse hard-freeze) regardless of math.
		client.quota.set("user:user-frozen", { used: 0, limit: 1073741824, frozen: true });
		await expect(service.assertAccountNotFrozen("user", "user-frozen"))
			.rejects.toBeInstanceOf(QuotaFrozenError);

		// AT the limit but NOT frozen → PASSES the precheck (codex P2): the
		// authoritative gate is `used + bytesCharged > limit`, and a same-account
		// dedupe upload charges ZERO bytes — pre-rejecting on `used >= limit`
		// would block those valid writes. Non-dedupe bytes are still rejected by
		// assertQuotaAllowance inside writeBlob.
		client.quota.set("user:user-full", { used: 1024, limit: 1024 });
		await expect(service.assertAccountNotFrozen("user", "user-full"))
			.resolves.toBeUndefined();

		// Headroom + not frozen → passes (no exception).
		client.quota.set("workspace:workspace-1", { used: 0, limit: 1073741824 });
		await expect(service.assertAccountNotFrozen("workspace", "workspace-1"))
			.resolves.toBeUndefined();
	});

	test("assertAccountNotFrozen is READ-ONLY: it neither charges nor freezes the account", async () => {
		// The precheck is a cost gate only — the authoritative reserve stays in
		// writeBlob. Reading a healthy account must not mutate its used bytes.
		const { client, service } = createHarness();
		client.quota.set("user:user-ro", { used: 500, limit: 1073741824 });
		await service.assertAccountNotFrozen("user", "user-ro");
		expect(client.quota.get("user:user-ro")).toEqual({ used: 500, limit: 1073741824 });
	});

	test("writeBlob existing SHA different account opens a new asset_refs row and charges the new account", async () => {
		// Dedupe is per-account: when a second account references bytes the pool
		// already knows about, the global blob ref_count climbs, but the new
		// account's asset_refs row is fresh and must be charged the full byte
		// size — workspaces don't get a free pass on bytes another workspace
		// already paid for.
		const { client, service } = createHarness();
		const buffer = Buffer.from("shared-bytes");

		const first = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		const second = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-2", assetId: ASSET_B });

		expect(second.sha256).toBe(first.sha256);
		// global blob ref count climbs even though account-level dedupe would be zero.
		expect(client.blobs.get(first.sha256)?.refCount).toBe(2);
		// the second workspace pays the full byte cost — it never saw these bytes before.
		expect(second.bytes_charged).toBe(buffer.byteLength);
		expect(client.refs.get(`workspace:workspace-1:${first.sha256}`)).toBe(1);
		expect(client.refs.get(`workspace:workspace-2:${first.sha256}`)).toBe(1);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
		expect(client.quota.get("workspace:workspace-2")?.used).toBe(buffer.byteLength);
	});

	test("promoteToMaster preserves other accounts still referencing the same blob", async () => {
		// Promote transfers attribution for THIS version only. Another account
		// that has its own asset_refs row pointing at the same SHA must keep
		// working — its ref isn't touched, its quota isn't refunded, its blob
		// remains served. This is the moat: a translator promoting their fork
		// can't accidentally evict another translator's working copy.
		const { client, service } = createHarness();
		const buffer = Buffer.from("shared-working-copy");

		const userOne = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "user", accountId: "user-1", requesterUserId: "user-1", assetId: ASSET_A });
		const userTwo = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "user", accountId: "user-2", requesterUserId: "user-2", assetId: ASSET_B });

		// Both users hold their own ref + charge.
		expect(client.refs.get(`user:user-1:${userOne.sha256}`)).toBe(1);
		expect(client.refs.get(`user:user-2:${userTwo.sha256}`)).toBe(1);
		expect(client.quota.get("user:user-1")?.used).toBe(buffer.byteLength);
		expect(client.quota.get("user:user-2")?.used).toBe(buffer.byteLength);

		await service.promoteToMaster({ versionId: userOne.version_id, workspaceId: "workspace-1", approverUserId: "admin-1" });

		// user-1's ref is released, but user-2's is intact.
		expect(client.refs.get(`user:user-1:${userOne.sha256}`)).toBeUndefined();
		expect(client.refs.get(`user:user-2:${userTwo.sha256}`)).toBe(1);
		expect(client.quota.get("user:user-1")?.used).toBe(0);
		// user-2 still pays for their working copy — promote didn't refund them.
		expect(client.quota.get("user:user-2")?.used).toBe(buffer.byteLength);
		// workspace picks up the bytes.
		expect(client.refs.get(`workspace:workspace-1:${userOne.sha256}`)).toBe(1);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
		// Blob remains live (user-2 still referencing).
		expect(client.blobs.get(userOne.sha256)?.refCount).toBeGreaterThanOrEqual(1);
	});

	test("freezeAccount blocks new writes; unfreezeAccount restores them", async () => {
		// Admin freeze is the abuse-cost escape hatch from
		// project-saas-roadmap-safety-queue: a tenant under investigation can be
		// frozen even when their quota math says they have headroom. The freeze
		// must reject NEW writes (quota_frozen) but leave reads + delete + promote
		// alone so the operator can resolve the situation.
		const { client, service } = createHarness();
		client.quota.set("user:user-99", { used: 0, limit: 1024 });

		await service.freezeAccount("user", "user-99");

		await expect(service.writeBlob({
			buffer: Buffer.from("any-bytes"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-99",
			requesterUserId: "user-99",
			assetId: ASSET_A,
		})).rejects.toBeInstanceOf(QuotaFrozenError);

		await service.unfreezeAccount("user", "user-99");
		const result = await service.writeBlob({
			buffer: Buffer.from("after-thaw"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-99",
			requesterUserId: "user-99",
			assetId: ASSET_A,
		});
		expect(result.bytes_charged).toBeGreaterThan(0);
	});

	test("gcOrphanBlobs deletes content blobs with zero ref_count", async () => {
		const { client, storage, service } = createHarness();
		const sha = sha256Hex(Buffer.from("orphan"));
		client.blobs.set(sha, { sha256: sha, byteSize: 6, mimeType: "image/png", storageDriver: "local", storageKey: `content/${sha}`, refCount: 0 });
		storage.blobs.add(sha);

		const { reclaimed } = await service.gcOrphanBlobs();

		expect(reclaimed).toBe(1);
		expect(client.blobs.has(sha)).toBe(false);
		expect(storage.blobs.has(sha)).toBe(false);
	});

	test("writeBlob on a frozen account rejects BEFORE writing the object (no orphan blob) — Codex P1 'Check quota before writing new content blobs'", async () => {
		// Regression: putContentBlob used to run before the freeze/limit gate, so
		// a frozen account writing a brand-new SHA filled the object store with an
		// untracked blob (no content_blobs row -> gcOrphanBlobs can never reclaim
		// it) while still 402-ing the caller. The allowance check must run first.
		const { client, storage, service } = createHarness();
		client.quota.set("user:user-frozen", { used: 0, limit: 1073741824, frozen: true });
		const buffer = Buffer.from("frozen-new-sha");
		const sha = sha256Hex(buffer);

		await expect(service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-frozen",
			requesterUserId: "user-frozen",
			assetId: ASSET_A,
		})).rejects.toBeInstanceOf(QuotaFrozenError);

		// The external object write never happened, so there is no orphan to GC.
		expect(storage.putCalls).toBe(0);
		expect(storage.blobs.has(sha)).toBe(false);
		// And no content_blobs / asset_refs / version rows leaked from the rollback.
		expect(client.blobs.has(sha)).toBe(false);
		expect(client.refs.get(`user:user-frozen:${sha}`)).toBeUndefined();
	});

	test("writeBlob locks a brand-new user quota row before charging — Codex P1 'Lock new user quota rows before charging'", async () => {
		// Regression: a first-ever upload for a user with no user_storage_accounts
		// row read no row and locked nothing, so two parallel first writers could
		// both see used=0 and both pass the limit gate. ensureQuotaRowForUpdate now
		// creates + FOR UPDATE-locks the row before the allowance read.
		const { client, service } = createHarness();
		const buffer = Buffer.from("first-ever-user-upload");

		await service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-fresh",
			requesterUserId: "user-fresh",
			assetId: ASSET_A,
		});

		// The quota row was materialized for the (real) user...
		expect(client.ensuredUserQuotaRows.has("user-fresh")).toBe(true);
		// ...and a FOR UPDATE lock was taken on it BEFORE the allowance read so
		// concurrent first writers serialize. Assert ordering via the query log.
		const lockIdx = client.queryLog.findIndex((q) => q.startsWith("SELECT 1 FROM user_storage_accounts") && q.includes("FOR UPDATE"));
		const allowanceReadIdx = client.queryLog.findIndex((q) => q.includes("FROM user_storage_accounts") && q.includes("FOR UPDATE") && !q.startsWith("SELECT 1"));
		expect(lockIdx).toBeGreaterThanOrEqual(0);
		expect(allowanceReadIdx).toBeGreaterThan(lockIdx);
		expect(client.quota.get("user:user-fresh")?.used).toBe(buffer.byteLength);
	});

	test("writeBlob materializes the content object for a backfilled legacy storage_key — Codex P1 'Preserve content for duplicate legacy uploads'", async () => {
		// Regression: 0034 backfills content_blobs from legacy asset_records and may
		// carry a project-scoped storage_key (projects/<id>/images/<id>) with NO
		// content/<sha> object on disk. A duplicate upload of that SHA used to treat
		// the row as "already stored", skip putContentBlob, and 404 forever. We must
		// detect the missing content object, write it, and re-point the blob row.
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("legacy-backfilled-content");
		const sha = sha256Hex(buffer);
		// Backfilled row: ref_count seeded by 0035, legacy project-scoped key, and
		// crucially NO content/<sha> object materialized in storage.
		client.blobs.set(sha, {
			sha256: sha,
			byteSize: buffer.byteLength,
			mimeType: "image/png",
			storageDriver: "local",
			storageKey: "projects/project-1/images/page-a.png",
			refCount: 1,
		});
		client.refs.set(`workspace:workspace-1:${sha}`, 1);
		client.quota.set("workspace:workspace-1", { used: buffer.byteLength, limit: 1073741824 });
		expect(storage.blobs.has(sha)).toBe(false);

		const result = await service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_B,
		});

		// The content-addressed object was actually materialized this time...
		expect(storage.putCalls).toBe(1);
		expect(storage.blobs.has(sha)).toBe(true);
		// ...and the blob row was re-pointed at content/<sha> so reads resolve.
		expect(client.blobs.get(sha)?.storageKey).toBe(`content/${sha}`);
		expect(result.storedObject.key).toBe(`content/${sha}`);
	});

	test("writeBlob does NOT re-write the object when a content/<sha> blob is already materialized", async () => {
		// Complement to the legacy-backfill case: when the row already points at
		// content/<sha> AND the object exists, the duplicate upload must skip the
		// external write (true dedupe) and still account the new ref correctly.
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("already-materialized-content");
		const sha = sha256Hex(buffer);
		client.blobs.set(sha, {
			sha256: sha,
			byteSize: buffer.byteLength,
			mimeType: "image/png",
			storageDriver: "local",
			storageKey: `content/${sha}`,
			refCount: 1,
		});
		client.refs.set(`workspace:workspace-1:${sha}`, 1);
		client.quota.set("workspace:workspace-1", { used: buffer.byteLength, limit: 1073741824 });
		storage.blobs.add(sha);

		await service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_B,
		});

		// No external write — the object was already present.
		expect(storage.putCalls).toBe(0);
		// Same-account dedupe: ref climbs, bytes charged stays zero.
		expect(client.refs.get(`workspace:workspace-1:${sha}`)).toBe(2);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
	});

	test("gcOrphanBlobs does NOT orphan a blob a concurrent writeBlob re-references after the candidate scan — QA-squad BUG 1 (GC race)", async () => {
		// Race window: gcOrphanBlobs() selects sha as an orphan candidate
		// (ref_count = 0). BEFORE gc evicts it, a concurrent writeBlob re-inserts
		// the same SHA (ref_count -> 1) and the content/<sha> object is (still)
		// live. The OLD gc deleted the storage object unconditionally based on the
		// stale candidate snapshot, leaving a DB row that claims ref_count = 1 while
		// the object on disk is gone -> data loss. The fixed gc re-locks the row and
		// re-checks ref_count = 0 INSIDE the per-blob transaction, so it must SKIP
		// the eviction once the blob has been re-referenced.
		const { client, storage, service } = createHarness();
		const sha = sha256Hex(Buffer.from("contended-orphan"));
		client.blobs.set(sha, {
			sha256: sha,
			byteSize: 16,
			mimeType: "image/png",
			storageDriver: "local",
			storageKey: `content/${sha}`,
			refCount: 0,
		});
		storage.blobs.add(sha);

		// Simulate the concurrent writeBlob re-insert: the instant gc runs the
		// candidate scan, bump ref_count to 1 so gc's later re-locked re-check
		// observes a now-live blob (exactly what FOR UPDATE would surface once the
		// concurrent transaction commits).
		const rawUnsafe = client.unsafe.bind(client);
		let reReferenced = false;
		client.unsafe = (async (query: string, params: unknown[] = []) => {
			const result = await rawUnsafe(query, params);
			const normalized = query.replace(/\s+/g, " ").trim();
			if (!reReferenced && normalized.startsWith("SELECT sha256 FROM content_blobs WHERE ref_count = 0")) {
				reReferenced = true;
				const blob = client.blobs.get(sha);
				if (blob) blob.refCount = 1; // concurrent writeBlob re-referenced it
			}
			return result;
		}) as typeof client.unsafe;

		const { reclaimed } = await service.gcOrphanBlobs();

		// gc skipped the eviction: nothing was deleted...
		expect(reclaimed).toBe(0);
		// ...the content object survives (NOT orphaned)...
		expect(storage.blobs.has(sha)).toBe(true);
		// ...and the re-referenced DB row is intact, ref_count consistent with disk.
		expect(client.blobs.get(sha)?.refCount).toBe(1);
	});

	test("gcOrphanBlobs evicts an orphan that stays unreferenced through the locked re-check", async () => {
		// Control for the race test: when no concurrent writer re-references the
		// candidate, the locked re-check still sees ref_count = 0 and the blob is
		// removed from BOTH the DB and object storage.
		const { client, storage, service } = createHarness();
		const sha = sha256Hex(Buffer.from("stable-orphan"));
		client.blobs.set(sha, {
			sha256: sha,
			byteSize: 9,
			mimeType: "image/png",
			storageDriver: "local",
			storageKey: `content/${sha}`,
			refCount: 0,
		});
		storage.blobs.add(sha);

		const { reclaimed } = await service.gcOrphanBlobs();

		expect(reclaimed).toBe(1);
		expect(client.blobs.has(sha)).toBe(false);
		expect(storage.blobs.has(sha)).toBe(false);
	});

	test("gcOrphanBlobs is BOUNDED per tick (respects the batch limit) and RESUMABLE across ticks — codex availability fix", async () => {
		// A large orphan backlog must not be reclaimed in one unbounded pass (memory
		// spike + monopolizes the sequential cron runner). With a small batch cap the
		// sweep reclaims at most `limit` orphans per call, reports hasMore, and the
		// next call continues with what is left.
		const { client, storage, service } = createHarness();
		const total = 7;
		const shas: string[] = [];
		for (let i = 0; i < total; i += 1) {
			const sha = sha256Hex(Buffer.from(`orphan-${i}`));
			shas.push(sha);
			client.blobs.set(sha, { sha256: sha, byteSize: 4, mimeType: "image/png", storageDriver: "local", storageKey: `content/${sha}`, refCount: 0 });
			storage.blobs.add(sha);
		}

		// First tick: capped at 3, more remain.
		const first = await service.gcOrphanBlobs({ limit: 3 });
		expect(first.reclaimed).toBe(3);
		expect(first.hasMore).toBe(true);
		// Only 3 candidates were SELECTed (bounded scan, not the whole backlog).
		const firstScan = client.queryLog.filter((q) => q.startsWith("SELECT sha256 FROM content_blobs WHERE ref_count = 0"));
		expect(firstScan.length).toBe(1);
		expect(client.blobs.size).toBe(total - 3);

		// Second tick resumes with the next batch.
		const second = await service.gcOrphanBlobs({ limit: 3 });
		expect(second.reclaimed).toBe(3);
		expect(second.hasMore).toBe(true);
		expect(client.blobs.size).toBe(total - 6);

		// Final tick drains the remainder; under the cap, so no more remain.
		const third = await service.gcOrphanBlobs({ limit: 3 });
		expect(third.reclaimed).toBe(1);
		expect(third.hasMore).toBe(false);
		expect(client.blobs.size).toBe(0);
		for (const sha of shas) expect(storage.blobs.has(sha)).toBe(false);
	});

	test("promoteToMaster on a PERSONAL project keeps bytes on the owner's user account (no phantom workspace) — QA-squad BUG 3", async () => {
		// Regression: promoteToMaster hardcoded account_kind='workspace' and routed
		// the charge through ensureWorkspaceQuotaRow, which only materializes a row
		// for an EXISTING workspaces entry. A personal (workspace-less) project has
		// none, so incrementQuotaUsage threw "Workspace billing account <projectId>
		// was not created before storage charge" and promote crashed. Personal
		// promotion must instead keep the master bytes on the project owner's user
		// account (the user account IS the project ledger).
		const PERSONAL_ASSET = "00000000-0000-4000-8000-0000000000cc";
		const { client, service } = createHarness();
		client.assetRecords.set(PERSONAL_ASSET, {
			asset_id: "solo-page.png",
			original_name: "Solo Page",
			project_id: "solo-project-1",
			project_user_id: "solo-owner",
			personal: true,
		});

		// Solo translator uploads a working copy onto their own user account.
		const wc = await service.writeBlob({
			buffer: Buffer.from("solo-working-copy"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "solo-owner",
			requesterUserId: "solo-owner",
			assetId: PERSONAL_ASSET,
		});
		const sha = wc.sha256;
		expect(client.refs.get(`user:solo-owner:${sha}`)).toBe(1);
		const ownerUsedBefore = client.quota.get("user:solo-owner")?.used;

		// Personal promote passes the PROJECT id as the "workspaceId" param (as the
		// route/authorization model expects for workspace-less assets) and the
		// owner as approver. This must NOT throw, and must NOT create a workspace
		// ledger for the project id.
		await service.promoteToMaster({
			versionId: wc.version_id,
			workspaceId: "solo-project-1",
			approverUserId: "solo-owner",
		});

		// Version is now master, still attributed to the owning user account.
		expect(client.versions.get(wc.version_id)).toEqual(
			expect.objectContaining({ branch: "master", accountKind: "user", accountId: "solo-owner" }),
		);
		// Bytes stayed on the user ledger — no transfer, no phantom workspace row.
		expect(client.refs.get(`user:solo-owner:${sha}`)).toBe(1);
		expect(client.quota.get("user:solo-owner")?.used).toBe(ownerUsedBefore);
		expect(client.quota.has("workspace:solo-project-1")).toBe(false);
		expect(client.ensuredWorkspaceQuotaRows.has("solo-project-1")).toBe(false);
	});

	test("deleteAssetsForProject frees the project's assets + reclaims quota (storage leak fix)", async () => {
		const { client, service } = createHarness();
		const a = await service.writeBlob({ buffer: Buffer.from("proj-asset-a"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		const b = await service.writeBlob({ buffer: Buffer.from("proj-asset-b"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_B });
		const usedBefore = client.quota.get("workspace:workspace-1")?.used ?? 0;
		expect(usedBefore).toBe(Buffer.byteLength("proj-asset-a") + Buffer.byteLength("proj-asset-b"));

		const released = await service.deleteAssetsForProject("project-1");

		expect(released).toBe(2);
		// Versions, account refs, and content_blobs ref_counts all dropped.
		expect(client.versions.get(a.version_id)).toBeUndefined();
		expect(client.versions.get(b.version_id)).toBeUndefined();
		expect(client.refs.get(`workspace:workspace-1:${a.sha256}`)).toBeUndefined();
		expect(client.refs.get(`workspace:workspace-1:${b.sha256}`)).toBeUndefined();
		expect(client.blobs.get(a.sha256)?.refCount).toBe(0);
		expect(client.blobs.get(b.sha256)?.refCount).toBe(0);
		// Quota fully reclaimed; asset_records removed.
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(0);
		expect(client.assetRecords.has(ASSET_A)).toBe(false);
		expect(client.assetRecords.has(ASSET_B)).toBe(false);
	});

	test("deleteAssetsForProject does NOT free a CoW blob another project still references (CoW-safe)", async () => {
		const { client, service } = createHarness();
		// A second project shares the SAME content via dedupe (same SHA, different
		// asset record in another project + account).
		const SHARED_ASSET = "00000000-0000-4000-8000-0000000000cc";
		client.assetRecords.set(SHARED_ASSET, { asset_id: "shared.png", original_name: "Shared", project_id: "project-2", workspace_id: "workspace-2", project_user_id: "owner-2" });
		const shared = Buffer.from("shared-dedup-content");
		const inP1 = await service.writeBlob({ buffer: shared, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		await service.writeBlob({ buffer: shared, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-2", assetId: SHARED_ASSET });
		expect(client.blobs.get(inP1.sha256)?.refCount).toBe(2);

		// Delete project-1: its reference drops, but the blob stays alive for project-2.
		const released = await service.deleteAssetsForProject("project-1");

		expect(released).toBe(1);
		expect(client.blobs.get(inP1.sha256)?.refCount).toBe(1); // still referenced
		expect(client.refs.get(`workspace:workspace-1:${inP1.sha256}`)).toBeUndefined();
		expect(client.refs.get(`workspace:workspace-2:${inP1.sha256}`)).toBe(1);
		// workspace-2 quota untouched; workspace-1 fully reclaimed.
		expect(client.quota.get("workspace:workspace-2")?.used).toBe(shared.byteLength);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(0);
	});

	test("deleteAssetsForProject is a no-op for a project with no CoW assets (idempotent)", async () => {
		const { service } = createHarness();
		expect(await service.deleteAssetsForProject("project-without-assets")).toBe(0);
		expect(await service.deleteAssetsForProject("")).toBe(0);
	});

	test("deleteAssetCowStorage decrements ref-count + reclaims quota for one asset (direct asset delete)", async () => {
		const { client, service } = createHarness();
		const a = await service.writeBlob({ buffer: Buffer.from("single-asset-a"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		const b = await service.writeBlob({ buffer: Buffer.from("single-asset-b"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_B });
		const bUsed = Buffer.byteLength("single-asset-b");

		// Delete only asset A (by its asset_records.asset_id = "page-a.png").
		const released = await service.deleteAssetCowStorage("project-1", "page-a.png");

		expect(released).toBe(1);
		expect(client.versions.get(a.version_id)).toBeUndefined();
		expect(client.blobs.get(a.sha256)?.refCount).toBe(0);
		expect(client.refs.get(`workspace:workspace-1:${a.sha256}`)).toBeUndefined();
		// Asset B is untouched; quota now reflects only B.
		expect(client.versions.get(b.version_id)).toBeDefined();
		expect(client.blobs.get(b.sha256)?.refCount).toBe(1);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(bUsed);
		// Unlike the project sweep, the asset_records row is left for the route to delete.
		expect(client.assetRecords.has(ASSET_A)).toBe(true);
	});

	test("gcOrphanBlobs reclaims the blob left at ref_count=0 after deleteAssetsForProject (end-to-end leak fix)", async () => {
		const { client, storage, service } = createHarness();
		const a = await service.writeBlob({ buffer: Buffer.from("end-to-end-orphan"), mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		expect(storage.blobs.has(a.sha256)).toBe(true);

		await service.deleteAssetsForProject("project-1");
		expect(client.blobs.get(a.sha256)?.refCount).toBe(0);
		// Object still present until the GC sweep runs.
		expect(storage.blobs.has(a.sha256)).toBe(true);

		const freed = await service.gcOrphanBlobs();
		expect(freed.reclaimed).toBe(1);
		expect(client.blobs.has(a.sha256)).toBe(false);
		expect(storage.blobs.has(a.sha256)).toBe(false);
		// Idempotent: a second sweep frees nothing.
		expect((await service.gcOrphanBlobs()).reclaimed).toBe(0);
	});

	test("writeBlob does NOT write the content object until the DB ledger commits — no untracked blob on a failed commit (Codex P1 'blob-before-commit orphan window')", async () => {
		// Regression: putContentBlob used to run INSIDE the transaction, before the
		// COMMIT. If the commit (or the quota-increment just before it) then failed
		// and rolled back, the content/<sha> object was left in storage while EVERY
		// DB row (content_blobs, asset_versions, asset_refs) was gone — an UNTRACKED,
		// UNACCOUNTED orphan that gcOrphanBlobs (which only reclaims ref_count=0 rows
		// that EXIST) can never reclaim. The object write must happen AFTER commit.
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("commit-fails-after-ledger");
		const sha = sha256Hex(buffer);

		// Inject a failure on the in-transaction quota-increment write. This is the
		// last DB statement before COMMIT, so it stands in for a commit-time DB
		// failure: the transaction rolls back and putContentBlob must never run.
		const rawUnsafe = client.unsafe.bind(client);
		client.unsafe = (async (query: string, params: unknown[] = []) => {
			const normalized = query.replace(/\s+/g, " ").trim();
			if (normalized.startsWith("INSERT INTO user_storage_accounts") && normalized.includes("ON CONFLICT (user_id) DO UPDATE SET used_bytes")) {
				throw new Error("simulated commit-path DB failure");
			}
			return rawUnsafe(query, params);
		}) as typeof client.unsafe;

		await expect(service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
		})).rejects.toThrow("simulated commit-path DB failure");

		// The object was NEVER written (it is deferred until after a successful
		// commit), so there is no untracked content/<sha> object to leak...
		expect(storage.putCalls).toBe(0);
		expect(storage.blobs.has(sha)).toBe(false);
		// ...and the rolled-back transaction left no DB rows behind either, so there
		// is nothing inconsistent for GC to reconcile.
		expect(client.blobs.has(sha)).toBe(false);
		expect(client.refs.get(`user:user-1:${sha}`)).toBeUndefined();
		expect([...client.versions.values()].some((v) => v.sha256 === sha)).toBe(false);
	});

	test("writeBlob keeps the committed content_blobs row tracked when the post-commit object write fails (GC/retry can reconcile, never an untracked orphan)", async () => {
		// With the object write moved AFTER commit, a failure of that write leaves a
		// committed content_blobs row (ref_count>=1) whose object is missing. That is
		// a RECOVERABLE "row present, object absent" state: the row keeps the bytes
		// tracked + accounted, GC will not evict it (ref_count>0), and a content-
		// addressed retry re-materializes the exact same bytes harmlessly. Crucially
		// it is NOT an untracked/unaccounted orphan.
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("post-commit-object-write-fails");
		const sha = sha256Hex(buffer);
		storage.failNextPut = true;

		await expect(service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		})).rejects.toThrow("simulated object-store write failure");

		// The DB ledger committed: the blob row exists, references the bytes, and is
		// accounted in quota — so the bytes are TRACKED even though the object write
		// failed. (This is the recoverable state, not a silent orphan.)
		expect(client.blobs.get(sha)?.refCount).toBe(1);
		expect(client.refs.get(`workspace:workspace-1:${sha}`)).toBe(1);
		expect(client.quota.get("workspace:workspace-1")?.used).toBe(buffer.byteLength);
		// The object itself is (transiently) missing, awaiting a retry.
		expect(storage.blobs.has(sha)).toBe(false);

		// GC must NOT evict the row (ref_count>0), so a retry can reconcile it.
		expect((await service.gcOrphanBlobs()).reclaimed).toBe(0);
		expect(client.blobs.has(sha)).toBe(true);

		// A retry of the SAME bytes (now an account-level dedupe) re-materializes the
		// content-addressed object harmlessly and resolves the missing-object state.
		await service.writeBlob({
			buffer,
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1",
			assetId: ASSET_A,
		});
		expect(storage.blobs.has(sha)).toBe(true);
	});

	test("writeBlob never deletes a blob a concurrent writer legitimately references for the same SHA (dedup correctness preserved)", async () => {
		// The orphan-window fix must not regress dedup: two accounts writing the same
		// SHA each hold their own committed ref under the blob-row lock, the global
		// content_blobs.ref_count stays >0, and neither write's object is deleted.
		const { client, storage, service } = createHarness();
		const buffer = Buffer.from("concurrent-shared-sha");
		const sha = sha256Hex(buffer);

		const first = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-1", assetId: ASSET_A });
		// Second account references the same already-materialized SHA (true dedupe):
		// no new object write, but a fresh ref + global ref_count bump.
		const second = await service.writeBlob({ buffer, mimeType: "image/png", accountKind: "workspace", accountId: "workspace-2", assetId: ASSET_B });

		expect(second.sha256).toBe(first.sha256);
		expect(storage.putCalls).toBe(1); // object materialized once, reused on dedupe
		expect(client.blobs.get(sha)?.refCount).toBe(2);
		expect(client.refs.get(`workspace:workspace-1:${sha}`)).toBe(1);
		expect(client.refs.get(`workspace:workspace-2:${sha}`)).toBe(1);
		// The shared object is live and is NOT a GC candidate while referenced.
		expect(storage.blobs.has(sha)).toBe(true);
		expect((await service.gcOrphanBlobs()).reclaimed).toBe(0);
		expect(storage.blobs.has(sha)).toBe(true);
	});

	// ── round-3 FINDING 1: per-version moderation scoping ──────────────────────

	test("writeBlob WORKING-COPY fail-closed quarantines the VERSION, never the shared master record", async () => {
		// Regression: writeBlob applied the verdict to the SHARED asset_records row even
		// for a working-copy write. A fail-closed outage on a user's DRAFT then
		// QUARANTINED the live master for everyone. The verdict must land on the version
		// only; the record (master) status must be left untouched.
		const { client, service } = createHarness();
		// The shared master record is currently released.
		client.assetRecords.get(ASSET_A)!.storage_status = "released";
		client.assetRecords.get(ASSET_A)!.moderation_status = "passed";

		const wc = await service.writeBlob({
			buffer: Buffer.from("draft-with-outage"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1", // → working_copy
			assetId: ASSET_A,
			moderation: FAIL_CLOSED_VERDICT,
		});

		// The VERSION carries the fail-closed quarantine state...
		const version = client.versions.get(wc.version_id)!;
		expect(version.branch).toBe("working_copy");
		expect(version.storageStatus).toBe("quarantined");
		expect(version.moderationStatus).toBe("needs_review");
		// ...while the SHARED master record is untouched (still released for everyone).
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("released");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("passed");
	});

	test("writeBlob MASTER fail-closed quarantines the VERSION ONLY — never the record's verdict (round-5 FINDING 1)", async () => {
		// Round-5: a MASTER writeBlob inserts a NEW version (new sha) but does NOT move
		// the asset_records blob pointer (sha256/storage_key) — only recordUploadedAsset
		// does, pointer+verdict together. So writeBlob must NOT write the record's
		// verdict either: doing so would flip the record to a verdict computed for the
		// NEW blob while the record still points at the OLD blob. Concretely, if the
		// record's OLD master is quarantined and this new master upload PASSES, the
		// record must stay quarantined (its pointer still names the old unsafe bytes) —
		// it must NOT become released. The verdict lands on the VERSION row only.
		const { client, service } = createHarness();
		// Record currently quarantined (its pointer names an OLD unsafe master blob).
		client.assetRecords.get(ASSET_A)!.storage_status = "quarantined";
		client.assetRecords.get(ASSET_A)!.moderation_status = "needs_review";

		// (a) A passing master write must NOT release the record (would release OLD bytes).
		const passing = await service.writeBlob({
			buffer: Buffer.from("master-passing-new-bytes"),
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1", // no requesterUserId → master
			assetId: ASSET_A,
			moderation: PASSED_VERDICT,
		});
		expect(client.versions.get(passing.version_id)!.branch).toBe("master");
		expect(client.versions.get(passing.version_id)!.storageStatus).toBe("released");
		// The OLD-bytes record verdict is UNTOUCHED — old unsafe bytes do NOT become released.
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("quarantined");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("needs_review");

		// (b) Complement: a fail-closed master write quarantines its VERSION but still
		// leaves the record verdict alone (it binds to the record's own pointer).
		client.assetRecords.get(ASSET_A)!.storage_status = "released";
		client.assetRecords.get(ASSET_A)!.moderation_status = "passed";
		const master = await service.writeBlob({
			buffer: Buffer.from("master-with-outage"),
			mimeType: "image/png",
			accountKind: "workspace",
			accountId: "workspace-1", // no requesterUserId → master
			assetId: ASSET_A,
			moderation: FAIL_CLOSED_VERDICT,
		});

		expect(client.versions.get(master.version_id)!.branch).toBe("master");
		// Version carries the quarantine; record verdict stays bound to the record's pointer.
		expect(client.versions.get(master.version_id)!.storageStatus).toBe("quarantined");
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("released");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("passed");
	});

	test("a PASSED working-copy draft does NOT flip a previously-quarantined master back to released", async () => {
		// The other half of the bug: a passed draft used to un-quarantine the shared
		// master. With the verdict scoped to the version, a quarantined master stays
		// quarantined until a MASTER write / promote clears it.
		const { client, service } = createHarness();
		client.assetRecords.get(ASSET_A)!.storage_status = "quarantined";
		client.assetRecords.get(ASSET_A)!.moderation_status = "needs_review";

		const wc = await service.writeBlob({
			buffer: Buffer.from("clean-draft"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			moderation: PASSED_VERDICT,
		});

		expect(client.versions.get(wc.version_id)!.storageStatus).toBe("released");
		// The master record is NOT flipped back to released by the passed draft.
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("quarantined");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("needs_review");
	});

	test("promoteToMaster REFUSES a quarantined version (version_moderation_quarantined 409)", async () => {
		const { client, service } = createHarness();
		const wc = await service.writeBlob({
			buffer: Buffer.from("quarantined-draft"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			moderation: FAIL_CLOSED_VERDICT,
		});
		expect(client.versions.get(wc.version_id)!.storageStatus).toBe("quarantined");

		await expect(service.promoteToMaster({
			versionId: wc.version_id,
			workspaceId: "workspace-1",
			approverUserId: "admin-1",
		})).rejects.toMatchObject({ code: "version_moderation_quarantined", status: 409 });

		// The version was NOT promoted (still a working copy) and the master record is untouched.
		expect(client.versions.get(wc.version_id)!.branch).toBe("working_copy");
	});

	test("promoteToMaster REFUSES a blocked version (version_moderation_blocked 409)", async () => {
		const { client, service } = createHarness();
		const wc = await service.writeBlob({
			buffer: Buffer.from("blocked-draft"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			moderation: BLOCKED_VERDICT,
		});
		expect(client.versions.get(wc.version_id)!.storageStatus).toBe("blocked");

		await expect(service.promoteToMaster({
			versionId: wc.version_id,
			workspaceId: "workspace-1",
			approverUserId: "admin-1",
		})).rejects.toMatchObject({ code: "version_moderation_blocked", status: 409 });

		expect(client.versions.get(wc.version_id)!.branch).toBe("working_copy");
	});

	test("promoteToMaster of a CLEAN version does NOT propagate its verdict onto the record (round-5 FINDING 2)", async () => {
		// Round-5 invariant: asset_records' moderation columns describe asset_records'
		// OWN blob pointer (sha256/storage_key) — never a different blob. Promote moves
		// the asset_versions BRANCH/ledger, but it NEVER moves the record's pointer
		// (only recordUploadedAsset does, pointer+verdict together). So promote must NOT
		// write the record's verdict: propagating the promoted version's `passed` here
		// while the record still points at a DIFFERENT (quarantined) blob would release
		// bytes the record does not name. Promote is BLOCK-ONLY — it refuses an unsafe
		// version but leaves the record verdict bound to the blob the record points at.
		const { client, service } = createHarness();
		// The shared master record was previously quarantined (e.g. an earlier outage).
		client.assetRecords.get(ASSET_A)!.storage_status = "quarantined";
		client.assetRecords.get(ASSET_A)!.moderation_status = "needs_review";

		const wc = await service.writeBlob({
			buffer: Buffer.from("clean-promotable-draft"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
			moderation: PASSED_VERDICT,
		});

		await service.promoteToMaster({ versionId: wc.version_id, workspaceId: "workspace-1", approverUserId: "admin-1" });

		expect(client.versions.get(wc.version_id)!.branch).toBe("master");
		// The record verdict is UNTOUCHED — promote did not move the pointer, so it must
		// not flip the verdict. It stays bound to the blob the record actually names.
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("quarantined");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("needs_review");
	});

	test("promoteToMaster leaves the record's verdict intact for a legacy (NULL-verdict) version too", async () => {
		// Same invariant from the other direction: a version predating migration 0083
		// carries no per-version verdict, and promote must leave the record alone — as it
		// now does for EVERY version, clean or legacy, since it never writes the record.
		const { client, service } = createHarness();
		client.assetRecords.get(ASSET_A)!.storage_status = "released";
		client.assetRecords.get(ASSET_A)!.moderation_status = "passed";
		// Working copy written WITHOUT a threaded verdict (legacy/back-compat path).
		const wc = await service.writeBlob({
			buffer: Buffer.from("legacy-no-verdict-draft"),
			mimeType: "image/png",
			accountKind: "user",
			accountId: "user-1",
			requesterUserId: "user-1",
			assetId: ASSET_A,
		});
		expect(client.versions.get(wc.version_id)!.storageStatus).toBeNull();

		await service.promoteToMaster({ versionId: wc.version_id, workspaceId: "workspace-1", approverUserId: "admin-1" });

		expect(client.versions.get(wc.version_id)!.branch).toBe("master");
		// Record unchanged.
		expect(client.assetRecords.get(ASSET_A)!.storage_status).toBe("released");
		expect(client.assetRecords.get(ASSET_A)!.moderation_status).toBe("passed");
	});
});
