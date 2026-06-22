import { getSharedBunSql } from "./sql-pool.js";
import { createHash } from "crypto";
import { objectStorage, type ObjectStorage, type StoredObject } from "./storage.js";
import { HttpError } from "../utils/http-error.js";
import { storageStatusForModerationResult } from "./assets.js";
import type { AssetModerationResult } from "../types/index.js";

export type AssetAccountKind = "workspace" | "user";
export type AssetVersionBranch = "master" | "working_copy";

/**
 * Default per-tick cap for {@link StorageCowService.gcOrphanBlobs}. The orphan
 * sweep is driven by the sequential cron runner (one job at a time), so an
 * unbounded scan of every `ref_count = 0` blob would both spike memory and
 * delay every later job on a large backlog. We instead reclaim at most this many
 * orphans per tick and stay resumable — the next scheduled run continues from
 * the remaining orphans. Override with `ORPHAN_BLOB_GC_BATCH`.
 */
export const DEFAULT_ORPHAN_BLOB_GC_BATCH = 500;

function readOrphanBlobGcBatch(): number {
	const raw = process.env.ORPHAN_BLOB_GC_BATCH?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_ORPHAN_BLOB_GC_BATCH;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : DEFAULT_ORPHAN_BLOB_GC_BATCH;
}

export interface GcOrphanBlobsResult {
	/** Number of orphan blobs (rows + objects) actually reclaimed this tick. */
	reclaimed: number;
	/**
	 * True when this run hit the batch cap, i.e. there may be more orphans to
	 * reclaim on the next tick. The sweep is resumable: deleted rows are gone, so
	 * the next run's bounded scan naturally continues with what is left.
	 */
	hasMore: boolean;
}

export interface StorageCowSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: StorageCowSqlClient) => Promise<T>): Promise<T>;
}

export interface WriteBlobInput {
	buffer: Buffer;
	mimeType: string;
	accountKind: AssetAccountKind;
	accountId: string;
	assetId: string;
	requesterUserId?: string;
	parentVersionId?: string;
	/**
	 * Optional moderation verdict for THIS write. When supplied, the verdict is
	 * persisted onto the VERSION row inserted by this write IN THE SAME TRANSACTION,
	 * so the per-version review/quarantine state always commits atomically with the
	 * bytes it describes.
	 *
	 * SCOPING (the round-3 fix): asset_records is SHARED by an asset's master and
	 * all its working copies, so applying the verdict to the record on EVERY write
	 * let a working-copy outage quarantine the live master for everyone (and a
	 * passed draft un-quarantine it). The RECORD-level moderation/storage_status is
	 * therefore only updated for a MASTER write (no {@link WriteBlobInput.requesterUserId}).
	 * A WORKING-COPY write records the verdict on the version ONLY; the master's
	 * record status is left untouched, and that fail-closed version is gated at
	 * {@link StorageCowService.promoteToMaster} (a quarantined/blocked version cannot
	 * be promoted) — the only path by which a working copy's bytes become the served
	 * master.
	 *
	 * A provider-failure fail-closed `needs_review` (`failClosed === true`) derives
	 * storage_status `quarantined` via {@link storageStatusForModerationResult}. The
	 * /api/images path persists the record-level verdict through its own asset_records
	 * flow and passes NO moderation here, so it is unaffected. Omitted ⇒ the version's
	 * moderation columns stay NULL and the record is left untouched (back-compat for
	 * non-image-safety callers).
	 */
	moderation?: AssetModerationResult;
}

export interface WriteBlobResult {
	version_id: string;
	sha256: string;
	bytes_charged: number;
	storedObject: StoredObject;
}

export interface PromoteToMasterInput {
	versionId: string;
	workspaceId: string;
	approverUserId: string;
}

export interface DeleteVersionInput {
	versionId: string;
	deleterUserId?: string;
	deleterRole?: string;
	skipAuthorizationForSystemCleanup?: boolean;
}

/**
 * Resolved write-authorization context returned by
 * {@link StorageCowService.assertCanWriteAsset}. `assertCanWriteAsset` already
 * loads the asset record (incl. its workspace membership) to authorize the write,
 * so it returns the asset's OWNING workspace id here rather than discarding it.
 * The route threads this into the moderation calls so a user-account working-copy
 * upload of a WORKSPACE asset attributes its CSAM audit + BYO soft-policy to the
 * owning workspace (FINDING 2). Undefined for a personal (workspace-less) project.
 */
export interface AssetWriteAuthorization {
	workspaceId?: string;
}

export interface QuotaLargestAsset {
	name: string;
	size: number;
	kind: AssetAccountKind;
	asset_id: string;
}

export interface QuotaState {
	used: number;
	limit: number;
	frozen: boolean;
	top_5_largest: QuotaLargestAsset[];
}

export class QuotaFrozenError extends Error {
	readonly accountKind: AssetAccountKind;
	readonly accountId: string;
	readonly usedBytes: number;
	readonly limitBytes: number;
	readonly top5LargestAssets: QuotaLargestAsset[];

	constructor(input: {
		accountKind: AssetAccountKind;
		accountId: string;
		usedBytes: number;
		limitBytes: number;
		top5LargestAssets: QuotaLargestAsset[];
	}) {
		super(`Storage quota frozen for ${input.accountKind}:${input.accountId}`);
		this.name = "QuotaFrozenError";
		this.accountKind = input.accountKind;
		this.accountId = input.accountId;
		this.usedBytes = input.usedBytes;
		this.limitBytes = input.limitBytes;
		this.top5LargestAssets = input.top5LargestAssets;
	}
}

export class StorageCowAuthorizationError extends Error {
	constructor(message: string, readonly status = 403, readonly code = "storage_cow_forbidden") {
		super(message);
		this.name = "StorageCowAuthorizationError";
	}
}

interface ContentBlobRow {
	byte_size?: number | string | null;
	storage_driver?: string | null;
	storage_key?: string | null;
	ref_count?: number | string | null;
}

/**
 * The minimal per-version accounting captured BEFORE an asset's registry row is
 * deleted, so {@link StorageCowService.releaseCapturedAssetCowStorage} can run
 * the ref/quota release after the cascade has removed the live `asset_versions`.
 */
export interface CapturedCowVersion {
	sha: Buffer;
	accountKind: AssetAccountKind;
	accountId: string;
	size: number;
}

interface VersionRow {
	version_id: string;
	asset_id: string;
	sha256: Buffer | string;
	branch?: AssetVersionBranch;
	account_kind: AssetAccountKind;
	account_id: string;
	asset_project_id?: string | null;
	asset_workspace_id?: string | null;
	project_workspace_id?: string | null;
	project_user_id?: string | null;
	ref_count?: number | string;
	byte_size?: number | string;
	storage_key?: string;
	storage_driver?: string;
	moderation_status?: string | null;
	storage_status?: string | null;
	moderation_provider?: string | null;
	moderation_reason?: string | null;
	moderation_detail?: unknown;
	moderation_checked_at?: Date | string | null;
	moderation_ruleset_version?: string | null;
}

interface QuotaRow {
	used_bytes: number | string;
	limit_bytes: number | string;
	frozen_at?: Date | string | null;
}

interface LargestAssetRow {
	name?: string | null;
	size?: number | string | null;
	kind?: AssetAccountKind | null;
	asset_id?: string | null;
}

interface AssetAccessRow {
	asset_id: string;
	project_id?: string | null;
	workspace_id?: string | null;
	project_workspace_id?: string | null;
	project_user_id?: string | null;
	member_role?: string | null;
}

const DEFAULT_USER_STORAGE_LIMIT_BYTES = 1073741824;
const DEFAULT_WORKSPACE_STORAGE_LIMIT_BYTES = 1073741824;

// Shape guard for a uuid before it hits a `::uuid` cast. A non-uuid parentVersionId
// would otherwise throw an opaque Postgres cast error (a 500) instead of a 400.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function sha256Hex(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function shaBuffer(hex: string): Buffer {
	return Buffer.from(hex, "hex");
}

function normalizeSha(value: Buffer | string): string {
	return Buffer.isBuffer(value) ? value.toString("hex") : String(value).replace(/^\\x/, "");
}

function toNumber(value: number | string | null | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

async function runTransaction<T>(client: StorageCowSqlClient, fn: (transaction: StorageCowSqlClient) => Promise<T>): Promise<T> {
	if (client.begin) return client.begin(fn);
	await client.unsafe("BEGIN ISOLATION LEVEL SERIALIZABLE");
	try {
		const result = await fn(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		await client.unsafe("ROLLBACK");
		throw error;
	}
}

/**
 * Resolves the plan/pack-derived EFFECTIVE storage limit (bytes) for an account,
 * or `null` to fall back to the account row's stored `limit_bytes`. The CoW write
 * gate consults this so its limit equals the project-keyed storage-quota limit
 * for the same workspace (S1) instead of the hardcoded 1 GiB row default. User
 * accounts have no plan model, so the default resolver returns `null` for them.
 */
export type CowEffectiveLimitResolver = (accountKind: AssetAccountKind, accountId: string) => Promise<number | null>;

/**
 * Default resolver: workspace accounts resolve through the SAME plan/pack-derived
 * computation as storage-quota (lazy-imported to avoid a module cycle); user
 * accounts keep their stored row limit (no plan model). Resolution failures are
 * swallowed and fall back to the stored limit so a transient catalog error never
 * blocks an otherwise-allowed write — the freeze-on-true-overage net still holds.
 */
const defaultCowEffectiveLimitResolver: CowEffectiveLimitResolver = async (accountKind, accountId) => {
	if (accountKind !== "workspace") return null;
	try {
		const { resolveWorkspaceEffectiveStorageLimitBytes } = await import("./storage-quota.js");
		return await resolveWorkspaceEffectiveStorageLimitBytes(accountId);
	} catch (error) {
		console.warn("[storage-cow] failed to resolve plan-derived storage limit; using stored row limit", {
			accountKind,
			accountId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
};

export class StorageCowService {
	private readonly client: StorageCowSqlClient;
	private readonly storage: ObjectStorage;
	private readonly resolveEffectiveLimit: CowEffectiveLimitResolver;

	constructor(input: { client: StorageCowSqlClient; storage?: ObjectStorage; limitResolver?: CowEffectiveLimitResolver }) {
		this.client = input.client;
		this.storage = input.storage ?? objectStorage;
		this.resolveEffectiveLimit = input.limitResolver ?? defaultCowEffectiveLimitResolver;
	}

	async writeBlob(input: WriteBlobInput): Promise<WriteBlobResult> {
		const sha256 = sha256Hex(input.buffer);
		const sha = shaBuffer(sha256);
		const byteSize = input.buffer.byteLength;

		const result = await runTransaction(this.client, async (tx) => {
			// LOCK ORDERING (deadlock-safety): every write path acquires the
			// content_blobs row BEFORE the account quota row.
			//   * writeBlob: getContentBlobForUpdate (blob) -> ensureQuotaRowForUpdate (quota)
			//   * promoteToMaster / deleteVersion: getVersionForUpdate (FOR UPDATE OF
			//     ... content_blobs) -> reclaim/assertQuotaAllowance (quota)
			// If writeBlob locked quota-then-blob (its earlier order) while
			// promote/delete lock blob-then-quota, two concurrent transactions
			// touching the same blob+account could deadlock. Locking the blob first
			// everywhere removes that cycle.
			const existing = await this.getContentBlobForUpdate(tx, sha);

			// Now lock the quota row. Locking it up front (creating the row first
			// for a brand-new account) still serializes two parallel first uploads
			// of different SHAs: without a real row to FOR UPDATE-lock they would
			// both read used=0, both pass the limit check, and both add bytes
			// (Codex P1: "Lock new user quota rows before charging"). The blob lock
			// taken just above does not weaken that — distinct SHAs lock distinct
			// blob rows, so the quota row remains the serialization point.
			await this.ensureQuotaRowForUpdate(tx, input.accountKind, input.accountId);

			// Decide whether the content-addressed object must actually be
			// materialized. A row can exist while no `content/<sha>` object does
			// — e.g. 0034 backfilled a legacy `asset_records.storage_key` such as
			// `projects/<id>/images/<id>`. Treating that as "already stored" and
			// skipping putContentBlob would make the new upload 404 forever
			// (Codex P1: "Preserve content for duplicate legacy uploads").
			const contentKey = `content/${sha256}`;
			const existingKeyIsContentAddressed = existing?.storage_key === contentKey;
			const contentObjectPresent = existingKeyIsContentAddressed
				? await this.storage.hasContentBlob({ sha256 })
				: false;
			const needsObjectWrite = !contentObjectPresent;

			// FK ORDERING (Codex P1: "Create content_blobs before FK-backed rows"):
			// asset_versions.sha256 and asset_refs.sha256 are IMMEDIATE (non-
			// deferrable) FKs to content_blobs(sha256) in 0033. So the content_blobs
			// row MUST exist before we insert the version/ref rows, otherwise a
			// brand-new unique SHA fails with a foreign-key violation and CoW
			// uploads are broken on a migrated DB. We therefore reserve/bump the
			// content_blobs row HERE — its storage_key is the deterministic
			// content/<sha> location (or the existing row's key, which the object
			// write below materializes/re-points). The external object write is
			// deferred until AFTER this transaction COMMITS (see COMMIT-BEFORE-
			// OBJECT below); if any in-transaction step throws, the whole
			// transaction (including this reserved blob row + its ref_count bump)
			// rolls back, so no orphan content_blobs row or object leaks.
			const blobStorageKey = existing?.storage_key && !needsObjectWrite ? existing.storage_key : contentKey;
			const blobStorageDriver = existing?.storage_driver && !needsObjectWrite
				? existing.storage_driver
				: this.storage.driver;
			await this.upsertContentBlob(tx, {
				sha,
				byteSize,
				mimeType: input.mimeType,
				storageDriver: blobStorageDriver,
				storageKey: blobStorageKey,
			});

			// PARENT VERSION TENANCY (Codex P2: "Validate parent versions belong to
			// the same asset"). The DB only enforces that parent_version_id is SOME
			// valid version via the self-referential FK; it does NOT enforce that the
			// parent belongs to THIS asset. Without this check an authorized writer
			// could chain a new version onto a version from another asset/workspace,
			// creating a cross-tenant version graph and blocking deletion of that
			// foreign parent through the self-referential FK. Reject up front.
			if (input.parentVersionId) {
				await this.assertParentVersionMatchesAsset(tx, input.parentVersionId, input.assetId);
			}

			// A WORKING-COPY write carries requesterUserId; a MASTER write does not.
			const isMasterWrite = !input.requesterUserId;
			const versionId = await this.insertAssetVersion(tx, {
				assetId: input.assetId,
				parentVersionId: input.parentVersionId,
				sha,
				branch: isMasterWrite ? "master" : "working_copy",
				accountKind: input.accountKind,
				accountId: input.accountId,
				requesterUserId: input.requesterUserId,
				// Persist the verdict on the VERSION row regardless of branch, so the
				// per-version review/quarantine state commits atomically with its bytes.
				moderation: input.moderation,
			});
			// MODERATION PERSIST — VERSION-SCOPED ONLY (round-5 fix).
			//
			// INVARIANT: asset_records' moderation columns describe asset_records' OWN
			// blob pointer (sha256 / storage_key) — never a different blob. writeBlob
			// does NOT move that pointer. The ONLY writer of asset_records.sha256 /
			// storage_key is recordUploadedAsset → PostgresAssetStore.write
			// (services/assets.ts), which sets the pointer AND the verdict together in
			// one atomic upsert from the same AssetRecord. The served/exported master is
			// resolved from asset_records.sha256/storage_key, NOT from the version graph.
			//
			// A MASTER writeBlob here inserts a NEW version (new sha) but leaves the
			// record's pointer untouched. Previously it ALSO wrote the new verdict onto
			// the record (applyAssetModeration). That decoupled the verdict from the
			// pointer: if the record still pointed at an OLD quarantined master and this
			// new upload passed, the record flipped to `released` while still serving the
			// OLD UNSAFE bytes (round-5 FINDING 1). So we record the verdict on the
			// VERSION row only (above) and never touch the record from writeBlob. The
			// record's verdict keeps describing the blob the record actually points at,
			// and a working copy's fail-closed verdict still blocks it from reaching the
			// served master because promote refuses a quarantined/blocked version.
			const accountRefCount = await this.upsertAssetRef(tx, input.accountKind, input.accountId, sha);
			// Account-level dedupe only: if THIS account already references these
			// bytes, it pays zero (a working_copy and its master would both ref
			// the same SHA against the same user). If a DIFFERENT account also
			// has bytes pooled at the same SHA, this account still pays. The
			// returned ref_count comes from the atomic INSERT/ON CONFLICT write,
			// so concurrent first-writers for the same account+SHA cannot both
			// decide to charge.
			const bytesCharged = accountRefCount === 1 ? byteSize : 0;

			// Run the freeze/limit gate BEFORE the commit (and therefore before the
			// post-commit object write). If this throws, the transaction rolls back
			// (undoing the reserved blob row, version, and ref above) and no
			// `content/<sha>` object is ever written, so gcOrphanBlobs() never has
			// to chase an untracked blob and a frozen account cannot fill the object
			// store with 402'd writes (Codex P1: "Check quota before writing new
			// content blobs"). The allowance check runs on every write (even
			// zero-charge dedupes) so a hard freeze still rejects new versions.
			await this.assertQuotaAllowance(tx, input.accountKind, input.accountId, bytesCharged);

			if (bytesCharged > 0) {
				await this.incrementQuotaUsage(tx, input.accountKind, input.accountId, bytesCharged);
			}

			// COMMIT-BEFORE-OBJECT (Codex P1: "Blob-before-commit orphan window").
			// We DO NOT write the physical content/<sha> object inside the
			// transaction. Materializing it here (before COMMIT) means that if the
			// COMMIT — or the incrementQuotaUsage above — then fails and rolls back,
			// the object is left in storage while EVERY DB row (content_blobs,
			// asset_versions, asset_refs) is gone. That object is then both
			// UNTRACKED and UNACCOUNTED: gcOrphanBlobs() only reclaims blobs that
			// HAVE a content_blobs row at ref_count=0, so a row-less object leaks
			// forever and mis-accounts storage.
			//
			// Instead we commit the DB ledger first (the content_blobs row is
			// already reserved above, pointing at the deterministic content/<sha>
			// key with ref_count>=1) and return the object-write decision. The
			// caller materializes the object AFTER the commit succeeds. Because the
			// object is content-addressed the write is idempotent + crash-safe:
			//   * If the post-commit object write fails, the committed row STILL
			//     exists with ref_count>=1, so GC never evicts it and a retry (or a
			//     reconciler) can re-materialize the same bytes harmlessly. The
			//     failure degrades to a recoverable "row present, object missing"
			//     state — NOT an untracked/unaccounted orphan.
			//   * A concurrent writer that legitimately references the same SHA
			//     holds its own committed ref under the blob-row lock, so the
			//     ref_count stays >0 and its blob is never deleted.
			return { versionId, bytesCharged, needsObjectWrite };
		});

		// Materialize the content-addressed object ONLY after the DB ledger has
		// committed. On a brand-new / legacy-backfilled SHA this writes the bytes;
		// on a true dedupe (object already present) it is skipped. A failure here
		// surfaces to the caller but cannot orphan storage: the committed
		// content_blobs row keeps the bytes tracked + accounted for GC/retry.
		const storedObject: StoredObject = result.needsObjectWrite
			? await this.storage.putContentBlob({ sha256, buffer: input.buffer })
			: { driver: this.storage.driver, key: `content/${sha256}` };

		return {
			version_id: result.versionId,
			sha256,
			bytes_charged: result.bytesCharged,
			storedObject,
		};
	}

	async promoteToMaster(input: PromoteToMasterInput): Promise<void> {
		await runTransaction(this.client, async (tx) => {
			const version = await this.getVersionForUpdate(tx, input.versionId);
			// CLIENT-ADDRESSABLE: `versionId` comes straight from the promote route
			// (`:id` path param or body `versionId`), so a bad/missing id is a caller
			// mistake, not a server invariant. The route catches only
			// StorageCowAuthorizationError/QuotaFrozenError and rethrows everything
			// else, so a plain Error here escaped to the global handler as a generic
			// 500 (it used to be a 404 under the old substring heuristic). Throw a
			// typed HttpError so globalErrorHandler renders the intended 404 + a
			// stable code the frontend can branch on.
			if (!version) throw new HttpError(`Asset version ${input.versionId} not found`, 404, "asset_version_not_found");
			await this.assertCanMutateWorkspaceVersion(tx, version, input.workspaceId, input.approverUserId);

			// MODERATION GATE (round-3 fix): a working-copy verdict is recorded on the
			// VERSION, not the shared asset_records master. Promote is the ONLY path that
			// turns a working copy into the served master, so it is where the
			// version-level safety state must be honored. A version whose per-version
			// storage_status is `quarantined` (fail-closed needs_review) or `blocked`
			// must NOT be promoted unscreened/over-the-line onto the live master. Reject
			// with a clear code so the caller can re-moderate / admin-review first.
			// (Legacy versions predating migration 0083 carry NULL → not gated.)
			//
			// INVARIANT (round-5 FINDING 2): promote does NOT propagate the version's
			// verdict onto the asset_records row. asset_records' moderation columns must
			// describe asset_records' OWN blob pointer (sha256 / storage_key), and promote
			// NEVER moves that pointer — markVersionMaster / the UPDATE below only flip the
			// asset_versions branch + ledger account. The served master is resolved from
			// asset_records.sha256/storage_key, which is written ONLY by recordUploadedAsset
			// (services/assets.ts), pointer + verdict together. Propagating the version's
			// verdict here would flip the record to `released` while the record still points
			// at a DIFFERENT (possibly quarantined) blob — the exact decoupling FINDING 2
			// flags. So this gate is BLOCK-ONLY: it refuses an unsafe promote but leaves the
			// record verdict untouched, keeping it bound to the blob the record points at.
			const versionStorageStatus = version.storage_status ?? undefined;
			if (versionStorageStatus === "blocked") {
				throw new StorageCowAuthorizationError(
					"Cannot promote a blocked version; it failed mandatory safety policy",
					409,
					"version_moderation_blocked",
				);
			}
			if (versionStorageStatus === "quarantined") {
				throw new StorageCowAuthorizationError(
					"Cannot promote a quarantined version; re-moderate it before promoting to master",
					409,
					"version_moderation_quarantined",
				);
			}

			// Resolve the MASTER storage ledger this version is promoted onto.
			// Workspace projects ship to the workspace billing account. PERSONAL
			// projects (no workspace) have no workspace_billing_accounts row, so
			// routing them to account_kind='workspace' made incrementQuotaUsage
			// throw "Workspace billing account <projectId> was not created before
			// storage charge" (QA-squad BUG 3). For a personal project the user
			// account IS the project ledger, so master content stays on the owning
			// user account — mirroring resolveCowAccount() for master uploads.
			const assetWorkspaceId = version.asset_workspace_id?.trim() || version.project_workspace_id?.trim();
			const target: { kind: AssetAccountKind; id: string } = assetWorkspaceId
				? { kind: "workspace", id: assetWorkspaceId }
				: { kind: "user", id: version.project_user_id?.trim() || version.account_id };

			// Already at its master destination (workspace master, or a personal
			// master already attributed to the owning user): just flip the branch.
			if (version.account_kind === target.kind && version.account_id === target.id) {
				await this.markVersionMaster(tx, input.versionId);
				return;
			}

			const sha = typeof version.sha256 === "string" ? shaBuffer(normalizeSha(version.sha256)) : version.sha256;
			const size = toNumber(version.byte_size);
			await this.decrementAssetRef(tx, version.account_kind, version.account_id, sha);
			await this.reclaimQuotaIfUnreferenced(tx, version.account_kind, version.account_id, sha, size);
			const targetRefCount = await this.upsertAssetRef(tx, target.kind, target.id, sha);
			if (targetRefCount === 1) {
				await this.assertQuotaAllowance(tx, target.kind, target.id, size);
				await this.incrementQuotaUsage(tx, target.kind, target.id, size);
			}
			await tx.unsafe(`
				UPDATE asset_versions
				SET branch = 'master',
					account_kind = $2::asset_account_kind,
					account_id = $3
				WHERE version_id = $1::uuid
			`, [input.versionId, target.kind, target.id]);
		});
	}

	async deleteVersion(input: DeleteVersionInput): Promise<void> {
		await runTransaction(this.client, async (tx) => {
			const version = await this.getVersionForUpdate(tx, input.versionId);
			if (!version) return;
			if (!input.skipAuthorizationForSystemCleanup) {
				await this.assertCanDeleteVersion(tx, version, input.deleterUserId, input.deleterRole);
				// ACTIVE MASTER GUARD (Codex P2: "Do not delete the active master
				// version alone"). The asset_records row + page metadata still point
				// at this content/<sha> object, but deleting the version decrements
				// the blob ref_count and lets gcOrphanBlobs() reclaim the object —
				// after which every image read finds the asset metadata and then 404s
				// on the missing blob. We therefore refuse to drop a master version
				// while it is the asset's last remaining master through this endpoint;
				// the caller must delete the asset record (cascades the version) or
				// promote a replacement first. System cleanup (rolling back a brand-
				// new upload, which also removes the asset record) is exempt above.
				if (version.branch === "master") {
					const remainingMasters = await this.countOtherMasterVersions(tx, version.asset_id, input.versionId);
					if (remainingMasters === 0) {
						throw new StorageCowAuthorizationError(
							"Cannot delete the asset's only master version; delete the asset instead",
							409,
							"active_master_version",
						);
					}
				}
			}
			const sha = typeof version.sha256 === "string" ? shaBuffer(normalizeSha(version.sha256)) : version.sha256;
			const size = toNumber(version.byte_size);
			await tx.unsafe("DELETE FROM asset_versions WHERE version_id = $1::uuid", [input.versionId]);
			await this.releaseVersionStorage(tx, version.account_kind, version.account_id, sha, size);
		});
	}

	/**
	 * Decrement the per-account asset_ref + the content_blobs ref_count for one
	 * deleted version and reclaim that account's quota when it holds no further
	 * reference to the blob. Factored out of {@link deleteVersion} so the
	 * project-delete sweep ({@link deleteAssetsForProject}) reclaims storage with
	 * the IDENTICAL accounting (CoW-safe: the blob row only drops to ref_count=0
	 * once NO account/version references it; gcOrphanBlobs then frees the object).
	 * The caller must already have removed the asset_versions row.
	 */
	private async releaseVersionStorage(
		client: StorageCowSqlClient,
		accountKind: AssetAccountKind,
		accountId: string,
		sha: Buffer,
		size: number,
	): Promise<void> {
		await this.decrementAssetRef(client, accountKind, accountId, sha);
		await this.reclaimQuotaIfUnreferenced(client, accountKind, accountId, sha, size);
		await client.unsafe(`
			UPDATE content_blobs
			SET ref_count = GREATEST(0, ref_count - 1),
				last_referenced_at = now()
			WHERE sha256 = $1
		`, [sha]);
	}

	/**
	 * Reclaim ALL CoW storage owned by a project when the project is deleted.
	 *
	 * Project delete (routes/project.ts) tombstones + drops the project tree +
	 * catalog row, but `asset_records` has NO FK to `projects` (migration 0021)
	 * so the CoW ledger is left untouched: the project's asset_records +
	 * asset_versions survive, every content_blobs ref_count stays inflated (so
	 * gcOrphanBlobs never sees them at ref_count=0), and the workspace/user
	 * storage quota is never given back — an unbounded quota + object leak.
	 *
	 * This sweeps the project's assets atomically:
	 *   1. Lock + read every version under the project (FOR UPDATE on the version
	 *      + blob rows, so a concurrent write/promote/delete serializes).
	 *   2. For each version: drop the asset_versions row, decrement its account
	 *      ref + the blob ref_count, and reclaim quota when the account no longer
	 *      references the blob — the same accounting as deleteVersion.
	 *   3. Delete the project's asset_records rows (asset_versions already gone;
	 *      the ON DELETE CASCADE would otherwise drop versions WITHOUT the
	 *      ref-count/quota accounting, which is exactly the leak).
	 *
	 * CoW-safe: a blob still referenced by ANOTHER project/account keeps a
	 * positive ref_count and is preserved; only blobs that reach ref_count=0 are
	 * later freed by gcOrphanBlobs(). Idempotent: a project with no CoW rows (the
	 * common file-mode / legacy case) is a no-op. Returns the number of versions
	 * released so the caller can log/verify.
	 */
	async deleteAssetsForProject(projectId: string): Promise<number> {
		const trimmed = projectId.trim();
		if (!trimmed) return 0;
		return runTransaction(this.client, async (tx) => {
			const versions = await tx.unsafe<VersionRow>(`
				SELECT asset_versions.version_id,
					asset_versions.sha256,
					asset_versions.account_kind,
					asset_versions.account_id,
					content_blobs.byte_size
				FROM asset_versions
				JOIN content_blobs ON content_blobs.sha256 = asset_versions.sha256
				JOIN asset_records ON asset_records.id = asset_versions.asset_id
				WHERE asset_records.project_id = $1
				FOR UPDATE OF asset_versions, content_blobs
			`, [trimmed]);

			for (const version of versions) {
				const sha = typeof version.sha256 === "string"
					? shaBuffer(normalizeSha(version.sha256))
					: version.sha256;
				const size = toNumber(version.byte_size);
				await tx.unsafe("DELETE FROM asset_versions WHERE version_id = $1::uuid", [version.version_id]);
				await this.releaseVersionStorage(tx, version.account_kind, version.account_id, sha, size);
			}

			// Remove the project's asset_records now that their versions are gone.
			// (Deleting them first would CASCADE the versions WITHOUT the ref-count
			// + quota accounting above — the very leak this method closes.)
			await tx.unsafe("DELETE FROM asset_records WHERE project_id = $1", [trimmed]);

			return versions.length;
		});
	}

	/**
	 * Reclaim the CoW storage owned by a SINGLE asset_record (project_id +
	 * asset_id) when that asset is deleted directly. Mirrors
	 * {@link deleteAssetsForProject} scoped to one asset: it drops the asset's
	 * versions WITH the ref-count/quota accounting so the underlying content blob
	 * is freed (by the orphan-blob GC) once nothing else references it and the
	 * account quota is given back.
	 *
	 * Unlike the project sweep it does NOT delete the `asset_records` row — the
	 * asset-delete route owns that (so its object-delete-failure rollback can
	 * restore the record). The route's subsequent asset_records delete cascades
	 * the (now already removed) versions harmlessly. Idempotent + CoW-safe: a
	 * blob another account still references keeps a positive ref_count. Returns
	 * the number of versions released.
	 */
	async deleteAssetCowStorage(projectId: string, assetId: string): Promise<number> {
		const project = projectId.trim();
		const asset = assetId.trim();
		if (!project || !asset) return 0;
		return runTransaction(this.client, async (tx) => {
			const versions = await tx.unsafe<VersionRow>(`
				SELECT asset_versions.version_id,
					asset_versions.sha256,
					asset_versions.account_kind,
					asset_versions.account_id,
					content_blobs.byte_size
				FROM asset_versions
				JOIN content_blobs ON content_blobs.sha256 = asset_versions.sha256
				JOIN asset_records ON asset_records.id = asset_versions.asset_id
				WHERE asset_records.project_id = $1
					AND asset_records.asset_id = $2
				FOR UPDATE OF asset_versions, content_blobs
			`, [project, asset]);

			for (const version of versions) {
				const sha = typeof version.sha256 === "string"
					? shaBuffer(normalizeSha(version.sha256))
					: version.sha256;
				const size = toNumber(version.byte_size);
				await tx.unsafe("DELETE FROM asset_versions WHERE version_id = $1::uuid", [version.version_id]);
				await this.releaseVersionStorage(tx, version.account_kind, version.account_id, sha, size);
			}
			return versions.length;
		});
	}

	/**
	 * Read (without mutating) the CoW version accounting for one asset so the
	 * caller can release it AFTER the authoritative `asset_records` delete.
	 *
	 * {@link deleteAssetCowStorage} releases-then-deletes inside one transaction,
	 * which requires the `asset_records` row (and its cascaded `asset_versions`)
	 * to STILL exist. The asset-delete route, however, must delete the registry
	 * row atomically first (single-winner gate + object-delete rollback). If the
	 * route released CoW accounting before that delete and the delete then failed,
	 * the row would survive with its blob ref_count/quota already released — and
	 * the orphan-blob GC could evict a blob that live reads still resolve. To keep
	 * the failure modes safe we split the operation: capture the accounting here
	 * (a pure read), let the route delete the record, then release with
	 * {@link releaseCapturedAssetCowStorage} ONLY when the record delete won. A
	 * release failure then degrades to a GC-recoverable ref_count leak (the same
	 * best-effort failure mode the route already documents); a record-delete
	 * failure releases nothing, leaving registry + accounting consistent.
	 */
	async captureAssetCowVersions(projectId: string, assetId: string): Promise<CapturedCowVersion[]> {
		const project = projectId.trim();
		const asset = assetId.trim();
		if (!project || !asset) return [];
		const versions = await this.client.unsafe<VersionRow>(`
			SELECT asset_versions.version_id,
				asset_versions.sha256,
				asset_versions.account_kind,
				asset_versions.account_id,
				content_blobs.byte_size
			FROM asset_versions
			JOIN content_blobs ON content_blobs.sha256 = asset_versions.sha256
			JOIN asset_records ON asset_records.id = asset_versions.asset_id
			WHERE asset_records.project_id = $1
				AND asset_records.asset_id = $2
		`, [project, asset]);
		return versions.map((version) => ({
			sha: typeof version.sha256 === "string" ? shaBuffer(normalizeSha(version.sha256)) : version.sha256,
			accountKind: version.account_kind,
			accountId: version.account_id,
			size: toNumber(version.byte_size),
		}));
	}

	/**
	 * Release the per-account ref/quota + content_blobs ref_count for versions
	 * captured by {@link captureAssetCowVersions}, AFTER the asset's registry row
	 * (and its cascaded `asset_versions`) has been removed. Runs the identical
	 * {@link releaseVersionStorage} accounting as the in-place delete, just keyed
	 * off captured data rather than live rows. The caller MUST only invoke this
	 * when it actually won the `asset_records` delete, so a single asset delete
	 * releases each blob reference exactly once (no double-decrement under
	 * concurrent deletes — the loser gets a 404 and releases nothing). Returns the
	 * number of versions released.
	 */
	async releaseCapturedAssetCowStorage(captured: CapturedCowVersion[]): Promise<number> {
		if (!captured.length) return 0;
		return runTransaction(this.client, async (tx) => {
			for (const version of captured) {
				await this.releaseVersionStorage(tx, version.accountKind, version.accountId, version.sha, version.size);
			}
			return captured.length;
		});
	}

	async gcOrphanBlobs(options: { limit?: number } = {}): Promise<GcOrphanBlobsResult> {
		// BOUNDED per tick: the cron runner is sequential, so an unbounded scan of
		// every `ref_count = 0` blob would spike memory and delay every later job
		// on a large orphan backlog. We cap the candidate scan with a LIMIT and
		// stay resumable — the next scheduled run continues with whatever orphans
		// remain (deleted rows are gone, so a fresh bounded scan picks up the rest).
		const rawLimit = options.limit ?? readOrphanBlobGcBatch();
		const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
			? rawLimit
			: DEFAULT_ORPHAN_BLOB_GC_BATCH;

		// Collect orphan candidates WITHOUT deleting them yet. The actual delete
		// (DB row + storage object) happens per-sha inside a transaction that
		// re-locks the row and re-checks ref_count, so a concurrent writeBlob that
		// re-references the SHA cannot be evicted from object storage.
		const candidates = await this.client.unsafe<{ sha256: Buffer | string }>(`
			SELECT sha256 FROM content_blobs WHERE ref_count = 0 LIMIT $1
		`, [limit]);

		let deleted = 0;
		for (const candidate of candidates) {
			const sha = typeof candidate.sha256 === "string"
				? shaBuffer(normalizeSha(candidate.sha256))
				: candidate.sha256;
			// Per-blob transaction. We FOR UPDATE-lock the content_blobs row and
			// re-verify ref_count = 0 INSIDE the same lock writeBlob contends on
			// (getContentBlobForUpdate). This closes the GC-vs-writeBlob race:
			//
			//   * If a concurrent writeBlob already re-inserted/incremented the row
			//     (ref_count > 0), our locked re-read sees it and we skip BOTH the
			//     storage delete and the row delete — the live blob is preserved.
			//   * If writeBlob is mid-flight, it blocks on this row lock until we
			//     commit the delete, then its own getContentBlobForUpdate returns
			//     empty and it re-materializes the content/<sha> object. No data
			//     loss either way.
			//
			// Crucially the storage.deleteContentBlob runs only after the locked
			// re-check confirms the orphan is still unreferenced, and the DB row +
			// storage object are removed atomically under the same lock.
			// Isolate each blob's reclaim: a failure on ONE sha (e.g. an R2 delete
			// timeout now that storage ops are bounded, #4 G, or a transient PG/lock
			// error) must not abort the whole batch and starve every later orphan.
			// Log + skip the failed sha and continue; the row survives (txn rolls
			// back) so the next tick retries it. Ordering inside the txn is unchanged.
			try {
				const didDelete = await runTransaction(this.client, async (tx) => {
					const locked = await this.getContentBlobForUpdateWithRefCount(tx, sha);
					// Row vanished (another gc pass) or got re-referenced — leave it.
					if (!locked || toNumber(locked.ref_count) !== 0) return false;
					await tx.unsafe("DELETE FROM content_blobs WHERE sha256 = $1 AND ref_count = 0", [sha]);
					await this.storage.deleteContentBlob({ sha256: normalizeSha(sha) });
					return true;
				});
				if (didDelete) deleted += 1;
			} catch (error) {
				console.warn(`[storage-cow] Orphan blob GC failed for one sha; skipping and retrying next tick: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// If we filled the batch, more orphans may remain for the next tick. (A
		// re-referenced candidate that we skipped also counts toward the cap, so a
		// full candidate page reliably signals "run again" without an extra scan.)
		return { reclaimed: deleted, hasMore: candidates.length >= limit };
	}

	async getQuotaState(accountKind: AssetAccountKind, accountId: string): Promise<QuotaState> {
		const quota = await this.readQuota(this.client, accountKind, accountId);
		return {
			used: quota.used,
			limit: quota.limit,
			frozen: quota.frozen,
			top_5_largest: await this.getTopLargestAssets(this.client, accountKind, accountId),
		};
	}

	async assertCanWriteAsset(input: {
		assetId: string;
		accountKind: AssetAccountKind;
		accountId: string;
		requesterUserId?: string;
		requesterRole?: string;
		asWorkingCopy: boolean;
	}): Promise<AssetWriteAuthorization> {
		return runTransaction(this.client, async (tx) => {
			if (!input.requesterUserId) {
				throw new StorageCowAuthorizationError("Asset upload requires authentication", 401, "unauthorized");
			}
			const asset = await this.getAssetAccessRow(tx, input.assetId, input.requesterUserId);
			if (!asset) {
				throw new StorageCowAuthorizationError("Asset not found", 404, "asset_not_found");
			}
			// The asset's OWNING workspace, resolved from the asset record (or its
			// project) while we already hold the row. Returned to the caller so a
			// user-account working-copy upload of a WORKSPACE asset can attribute its
			// moderation/CSAM-audit calls to that workspace (FINDING 2) instead of
			// passing an empty workspaceId that loses BYO soft-policy bypass + audit
			// attribution. Undefined for a personal (workspace-less) project.
			const resolvedWorkspaceId = asset.workspace_id?.trim() || asset.project_workspace_id?.trim() || undefined;
			if (input.accountKind === "user") {
				if (input.accountId !== input.requesterUserId) {
					throw new StorageCowAuthorizationError("Cannot upload to another user's storage account");
				}
				if (!input.asWorkingCopy) {
					throw new StorageCowAuthorizationError("User-account direct uploads must be working copies");
				}
				// A WORKSPACE asset never forks onto a member's personal ledger
				// (product decision 2026-06-13): every byte a seat member writes
				// against a workspace project pools on the workspace account, like
				// the master upload paths already do. Reject instead of silently
				// re-routing so the caller's ledger expectation cannot diverge.
				if (resolvedWorkspaceId) {
					throw new StorageCowAuthorizationError(
						"Workspace assets pool on the workspace storage account — per-member working copies are not allowed",
						403,
						"workspace_asset_user_account_forbidden",
					);
				}
				await this.assertAssetProjectAccess(asset, input.requesterUserId, input.requesterRole);
				return { workspaceId: resolvedWorkspaceId };
			}
			if (resolvedWorkspaceId) {
				if (input.accountId !== resolvedWorkspaceId) {
					throw new StorageCowAuthorizationError("Workspace account does not own this asset");
				}
				if (roleCanMutateWorkspace(asset.member_role)) return { workspaceId: resolvedWorkspaceId };
				throw new StorageCowAuthorizationError("Forbidden: missing workspace write access");
			}
			if (input.accountId !== asset.project_id) {
				throw new StorageCowAuthorizationError("Storage account does not own this asset");
			}
			await this.assertAssetProjectAccess(asset, input.requesterUserId, input.requesterRole);
			return { workspaceId: resolvedWorkspaceId };
		});
	}

	/**
	 * Cheap READ-ONLY freeze/over-limit precheck (FINDING 1). The route calls this
	 * BETWEEN {@link assertCanWriteAsset} and the PAID moderation gate so an
	 * authorized-but-frozen / already-over-limit account is rejected with
	 * {@link QuotaFrozenError} BEFORE it can burn an OpenAI moderation call whose
	 * bytes {@link writeBlob} would then refuse to store anyway.
	 *
	 * This is a COST GATE ONLY — it reads the account's quota row (frozen flag)
	 * WITHOUT locking, reserving, or charging anything. The authoritative,
	 * race-safe gate stays inside {@link writeBlob} ({@link assertQuotaAllowance},
	 * which runs under the FOR UPDATE quota-row lock with the exact byte charge):
	 * a write that slips past this read-only precheck (e.g. a freeze applied in
	 * the moderation window) is still rejected there.
	 *
	 * Deliberately FROZEN-ONLY — no `used >= limit` clause: the authoritative
	 * check is `used + bytesCharged > limit`, and a same-account DEDUPE upload
	 * charges ZERO bytes, so an account exactly at its line may still legally
	 * create deduplicated versions (codex P2). Pre-rejecting on `used >= limit`
	 * would block those valid zero-charge writes. The cost tradeoff: an
	 * over-limit-but-unfrozen account uploading NON-dedupe bytes burns one
	 * moderation call before writeBlob rejects it — bounded, and no worse than
	 * the pre-precheck behavior for that narrow case.
	 */
	async assertAccountNotFrozen(accountKind: AssetAccountKind, accountId: string): Promise<void> {
		const quota = await this.readQuota(this.client, accountKind, accountId);
		if (quota.frozen) {
			throw new QuotaFrozenError({
				accountKind,
				accountId,
				usedBytes: quota.used,
				limitBytes: quota.limit,
				top5LargestAssets: await this.getTopLargestAssets(this.client, accountKind, accountId),
			});
		}
	}

	/**
	 * Admin: hard-freeze a storage account. Writes are rejected with
	 * {@link QuotaFrozenError} immediately, regardless of remaining quota — used
	 * by the abuse/cost guardrails when a tenant trips a soft cap before billing
	 * resolves it. Reads + promote + delete still work so the user can free space.
	 */
	async freezeAccount(accountKind: AssetAccountKind, accountId: string): Promise<void> {
		if (accountKind === "workspace") {
			await this.client.unsafe(`
				INSERT INTO workspace_billing_accounts (
					workspace_id,
					plan_id,
					status,
					storage_used_bytes,
					storage_limit_bytes,
					storage_frozen_at
				)
				SELECT workspace_id, 'free', 'mock_active', 0, $2, now()
				FROM workspaces
				WHERE workspace_id = $1
				ON CONFLICT (workspace_id) DO UPDATE SET
					storage_frozen_at = COALESCE(workspace_billing_accounts.storage_frozen_at, EXCLUDED.storage_frozen_at)
			`, [accountId, DEFAULT_WORKSPACE_STORAGE_LIMIT_BYTES]);
			return;
		}
		await this.client.unsafe(`
			INSERT INTO user_storage_accounts (user_id, used_bytes, limit_bytes, plan_tier, frozen_at)
			VALUES ($1, 0, $2, 'free', now())
			ON CONFLICT (user_id) DO UPDATE SET
				frozen_at = COALESCE(user_storage_accounts.frozen_at, EXCLUDED.frozen_at)
		`, [accountId, DEFAULT_USER_STORAGE_LIMIT_BYTES]);
	}

	/**
	 * Admin: clear the freeze marker. Quota math still applies after unfreeze;
	 * if `used_bytes >= limit_bytes` the next write trips QuotaFrozenError again
	 * via the limit check.
	 */
	async unfreezeAccount(accountKind: AssetAccountKind, accountId: string): Promise<void> {
		if (accountKind === "workspace") {
			await this.client.unsafe(`
				UPDATE workspace_billing_accounts
				SET storage_frozen_at = NULL
				WHERE workspace_id = $1
			`, [accountId]);
			return;
		}
		await this.client.unsafe(`
			UPDATE user_storage_accounts
			SET frozen_at = NULL
			WHERE user_id = $1
		`, [accountId]);
	}

	private async getContentBlobForUpdate(client: StorageCowSqlClient, sha: Buffer): Promise<ContentBlobRow | undefined> {
		const rows = await client.unsafe<ContentBlobRow>(`
			SELECT byte_size, storage_driver, storage_key, ref_count
			FROM content_blobs
			WHERE sha256 = $1
			FOR UPDATE
		`, [sha]);
		return rows[0];
	}

	// gc-side alias: identical row lock + ref_count read used by gcOrphanBlobs to
	// re-verify a candidate is still unreferenced before deleting it. Sharing the
	// same FOR UPDATE query is what serializes gc against a concurrent writeBlob.
	private async getContentBlobForUpdateWithRefCount(client: StorageCowSqlClient, sha: Buffer): Promise<ContentBlobRow | undefined> {
		return this.getContentBlobForUpdate(client, sha);
	}

	private async upsertContentBlob(
		client: StorageCowSqlClient,
		input: { sha: Buffer; byteSize: number; mimeType: string; storageDriver: string; storageKey: string },
	): Promise<void> {
		await client.unsafe(`
			INSERT INTO content_blobs (
				sha256,
				byte_size,
				mime_type,
				storage_driver,
				storage_key,
				ref_count,
				first_seen_at,
				last_referenced_at
			)
			VALUES ($1, $2, $3, $4, $5, 1, now(), now())
			ON CONFLICT (sha256) DO UPDATE SET
				ref_count = content_blobs.ref_count + 1,
				last_referenced_at = now(),
				-- Re-point the blob row at the materialized content-addressed
				-- object. A legacy/backfilled row may carry a project-scoped key
				-- (projects/<id>/images/<id>); once writeBlob has put the real
				-- content/<sha> object we must persist that key/driver so reads
				-- resolve, otherwise the duplicate upload 404s.
				storage_driver = EXCLUDED.storage_driver,
				storage_key = EXCLUDED.storage_key,
				byte_size = EXCLUDED.byte_size,
				mime_type = EXCLUDED.mime_type
		`, [input.sha, input.byteSize, input.mimeType, input.storageDriver, input.storageKey]);
	}

	/**
	 * READ-ONLY parent-version tenancy/UUID preflight (round-5 FINDING 3). Callable
	 * by the route BEFORE the paid moderation / sharp work so a bad parentVersionId
	 * 400s without burning a provider call or a decode. It runs the SAME check
	 * writeBlob performs internally — which STAYS as the authoritative gate inside
	 * the write transaction (the parent could be deleted between this preflight and
	 * the committed insert). This wrapper just hoists the cheap query out front; it
	 * does not lock or write anything.
	 */
	async assertParentVersionWritable(parentVersionId: string, assetId: string): Promise<void> {
		await this.assertParentVersionMatchesAsset(this.client, parentVersionId, assetId);
	}

	private async assertParentVersionMatchesAsset(
		client: StorageCowSqlClient,
		parentVersionId: string,
		assetId: string,
	): Promise<void> {
		// Reject a malformed parentVersionId with a clean 400 BEFORE the `$1::uuid`
		// cast below would throw an opaque DB error (surfacing as a 500). The column
		// is a uuid, so a non-uuid string can never match a real parent anyway.
		if (!UUID_RE.test(parentVersionId)) {
			throw new StorageCowAuthorizationError(
				"Parent version id is not a valid identifier",
				400,
				"parent_version_invalid",
			);
		}
		const rows = await client.unsafe<{ asset_id?: string }>(`
			SELECT asset_id
			FROM asset_versions
			WHERE version_id = $1::uuid
			LIMIT 1
		`, [parentVersionId]);
		const parentAssetId = rows[0]?.asset_id;
		if (!parentAssetId) {
			throw new StorageCowAuthorizationError("Parent version not found", 404, "parent_version_not_found");
		}
		if (parentAssetId !== assetId) {
			throw new StorageCowAuthorizationError(
				"Parent version belongs to a different asset",
				400,
				"parent_version_asset_mismatch",
			);
		}
	}

	private async insertAssetVersion(
		client: StorageCowSqlClient,
		input: {
			assetId: string;
			parentVersionId?: string;
			sha: Buffer;
			branch: AssetVersionBranch;
			accountKind: AssetAccountKind;
			accountId: string;
			requesterUserId?: string;
			moderation?: AssetModerationResult;
		},
	): Promise<string> {
		// Per-version moderation columns (migration 0083). NULL ⇒ no verdict threaded
		// (back-compat / non-image-safety callers); a threaded verdict derives the
		// per-version storage_status the same way the record does, so a fail-closed
		// `needs_review` quarantines THIS version (and blocks its promote) without
		// touching the shared asset_records master status.
		const moderation = input.moderation;
		const rows = await client.unsafe<{ version_id: string }>(`
			INSERT INTO asset_versions (
				asset_id,
				parent_version_id,
				sha256,
				branch,
				account_kind,
				account_id,
				created_by_user_id,
				moderation_status,
				storage_status,
				moderation_provider,
				moderation_reason,
				moderation_detail,
				moderation_checked_at,
				moderation_ruleset_version
			)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb, $13, $14)
			RETURNING version_id
		`, [
			input.assetId,
			input.parentVersionId ?? null,
			input.sha,
			input.branch,
			input.accountKind,
			input.accountId,
			input.requesterUserId ?? null,
			moderation?.status ?? null,
			moderation ? storageStatusForModerationResult(moderation) : null,
			moderation?.provider ?? null,
			moderation?.reason ?? null,
			moderation ? JSON.stringify(moderation.categories ?? {}) : null,
			moderation?.checkedAt ?? null,
			moderation?.rulesetVersion ?? null,
		]);
		const versionId = rows[0]?.version_id;
		if (!versionId) throw new Error("Failed to insert asset version");
		return versionId;
	}

	private async upsertAssetRef(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, sha: Buffer): Promise<number> {
		const rows = await client.unsafe<{ ref_count?: number | string }>(`
			INSERT INTO asset_refs (account_kind, account_id, sha256, ref_count, added_at)
			VALUES ($1::asset_account_kind, $2, $3, 1, now())
			ON CONFLICT (account_kind, account_id, sha256) DO UPDATE SET
				ref_count = asset_refs.ref_count + 1
			RETURNING ref_count
		`, [accountKind, accountId, sha]);
		return toNumber(rows[0]?.ref_count);
	}

	private async getAccountRefCount(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, sha: Buffer): Promise<number> {
		const rows = await client.unsafe<{ ref_count?: number | string }>(`
			SELECT ref_count
			FROM asset_refs
			WHERE account_kind = $1::asset_account_kind
				AND account_id = $2
				AND sha256 = $3
			FOR UPDATE
		`, [accountKind, accountId, sha]);
		return toNumber(rows[0]?.ref_count);
	}

	private async decrementAssetRef(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, sha: Buffer): Promise<void> {
		await client.unsafe(`
			UPDATE asset_refs
			SET ref_count = GREATEST(0, ref_count - 1)
			WHERE account_kind = $1::asset_account_kind
				AND account_id = $2
				AND sha256 = $3
		`, [accountKind, accountId, sha]);
		await client.unsafe(`
			DELETE FROM asset_refs
			WHERE account_kind = $1::asset_account_kind
				AND account_id = $2
				AND sha256 = $3
				AND ref_count = 0
		`, [accountKind, accountId, sha]);
	}

	private async readQuota(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string): Promise<{ used: number; limit: number; frozen: boolean }> {
		if (accountKind === "workspace") {
			await this.ensureWorkspaceQuotaRow(client, accountId);
			const rows = await client.unsafe<QuotaRow>(`
				SELECT storage_used_bytes AS used_bytes,
					storage_limit_bytes AS limit_bytes,
					storage_frozen_at AS frozen_at
				FROM workspace_billing_accounts
				WHERE workspace_id = $1
				FOR UPDATE
			`, [accountId]);
			const row = rows[0];
			const rowLimit = toNumber(row?.limit_bytes) || DEFAULT_WORKSPACE_STORAGE_LIMIT_BYTES;
			return {
				used: toNumber(row?.used_bytes),
				limit: await this.effectiveLimit(accountKind, accountId, rowLimit),
				frozen: Boolean(row?.frozen_at),
			};
		}
		await this.ensureUserQuotaRow(client, accountId);
		const rows = await client.unsafe<QuotaRow>(`
			SELECT used_bytes, limit_bytes, frozen_at
			FROM user_storage_accounts
			WHERE user_id = $1
			FOR UPDATE
		`, [accountId]);
		const row = rows[0];
		const rowLimit = toNumber(row?.limit_bytes) || DEFAULT_USER_STORAGE_LIMIT_BYTES;
		return {
			used: toNumber(row?.used_bytes),
			limit: await this.effectiveLimit(accountKind, accountId, rowLimit),
			frozen: Boolean(row?.frozen_at),
		};
	}

	/**
	 * Reconcile the account's stored `limit_bytes` with the plan/pack-derived limit
	 * (S1). Nothing ever writes a non-default limit into the quota rows, so the row
	 * value is effectively the hardcoded 1 GiB default; the plan-derived limit is
	 * the single source of truth shared with storage-quota. We take the MAX so an
	 * explicitly-raised row limit is never silently lowered, while the default row
	 * is raised to the customer's actual plan/pack quota. When no plan resolves
	 * (unknown workspace / file-mode without a record) we keep the stored limit.
	 */
	private async effectiveLimit(accountKind: AssetAccountKind, accountId: string, rowLimit: number): Promise<number> {
		const resolved = await this.resolveEffectiveLimit(accountKind, accountId);
		if (resolved === null || !Number.isFinite(resolved) || resolved <= 0) return rowLimit;
		return Math.max(rowLimit, resolved);
	}

	private async assertQuotaAllowance(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, bytes: number): Promise<void> {
		const quota = await this.readQuota(client, accountKind, accountId);
		if (quota.frozen || quota.used + bytes > quota.limit) {
			throw new QuotaFrozenError({
				accountKind,
				accountId,
				usedBytes: quota.used,
				limitBytes: quota.limit,
				top5LargestAssets: await this.getTopLargestAssets(client, accountKind, accountId),
			});
		}
	}

	private async incrementQuotaUsage(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, bytes: number): Promise<void> {
		if (accountKind === "workspace") {
			await this.ensureWorkspaceQuotaRow(client, accountId);
			const rows = await client.unsafe<{ workspace_id?: string }>(`
				UPDATE workspace_billing_accounts
				SET storage_used_bytes = storage_used_bytes + $2
				WHERE workspace_id = $1
				RETURNING workspace_id
			`, [accountId, bytes]);
			if (!rows[0]) {
				throw new Error(`Workspace billing account ${accountId} was not created before storage charge`);
			}
			return;
		}
		await client.unsafe(`
			INSERT INTO user_storage_accounts (user_id, used_bytes, limit_bytes, plan_tier)
			VALUES ($1, $2, $3, 'free')
			ON CONFLICT (user_id) DO UPDATE SET
				used_bytes = user_storage_accounts.used_bytes + EXCLUDED.used_bytes
		`, [accountId, bytes, DEFAULT_USER_STORAGE_LIMIT_BYTES]);
	}

	private async decrementQuotaUsage(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string, bytes: number): Promise<void> {
		if (bytes <= 0) return;
		if (accountKind === "workspace") {
			await this.ensureWorkspaceQuotaRow(client, accountId);
			await client.unsafe(`
				UPDATE workspace_billing_accounts
				SET storage_used_bytes = GREATEST(0, storage_used_bytes - $2)
				WHERE workspace_id = $1
			`, [accountId, bytes]);
			return;
		}
		await client.unsafe(`
			UPDATE user_storage_accounts
			SET used_bytes = GREATEST(0, used_bytes - $2)
			WHERE user_id = $1
		`, [accountId, bytes]);
	}

	private async reclaimQuotaIfUnreferenced(
		client: StorageCowSqlClient,
		accountKind: AssetAccountKind,
		accountId: string,
		sha: Buffer,
		bytes: number,
	): Promise<void> {
		const remaining = await this.getAccountRefCount(client, accountKind, accountId, sha);
		if (remaining === 0) {
			await this.decrementQuotaUsage(client, accountKind, accountId, bytes);
		}
	}

	private async getVersionForUpdate(client: StorageCowSqlClient, versionId: string): Promise<VersionRow | undefined> {
		const rows = await client.unsafe<VersionRow>(`
			SELECT asset_versions.version_id,
				asset_versions.asset_id,
				asset_versions.sha256,
				asset_versions.branch,
				asset_versions.account_kind,
				asset_versions.account_id,
				asset_versions.moderation_status,
				asset_versions.storage_status,
				asset_versions.moderation_provider,
				asset_versions.moderation_reason,
				asset_versions.moderation_detail,
				asset_versions.moderation_checked_at,
				asset_versions.moderation_ruleset_version,
				asset_records.project_id AS asset_project_id,
				asset_records.workspace_id AS asset_workspace_id,
				projects.workspace_id AS project_workspace_id,
				projects.owner_user_id AS project_user_id,
				content_blobs.byte_size,
				content_blobs.storage_driver,
				content_blobs.storage_key
			FROM asset_versions
			JOIN content_blobs ON content_blobs.sha256 = asset_versions.sha256
			JOIN asset_records ON asset_records.id = asset_versions.asset_id
			LEFT JOIN projects ON projects.project_id = asset_records.project_id
			WHERE asset_versions.version_id = $1::uuid
			FOR UPDATE OF asset_versions, content_blobs
		`, [versionId]);
		return rows[0];
	}

	private async countOtherMasterVersions(client: StorageCowSqlClient, assetId: string, excludeVersionId: string): Promise<number> {
		const rows = await client.unsafe<{ count?: number | string }>(`
			SELECT COUNT(*) AS count
			FROM asset_versions
			WHERE asset_id = $1::uuid
				AND branch = 'master'
				AND version_id <> $2::uuid
		`, [assetId, excludeVersionId]);
		return toNumber(rows[0]?.count);
	}

	private async ensureWorkspaceQuotaRow(client: StorageCowSqlClient, workspaceId: string): Promise<void> {
		await client.unsafe(`
			INSERT INTO workspace_billing_accounts (
				workspace_id,
				plan_id,
				status,
				storage_used_bytes,
				storage_limit_bytes
			)
			SELECT workspace_id, 'free', 'mock_active', 0, $2
			FROM workspaces
			WHERE workspace_id = $1
			ON CONFLICT (workspace_id) DO NOTHING
		`, [workspaceId, DEFAULT_WORKSPACE_STORAGE_LIMIT_BYTES]);
	}

	private async ensureUserQuotaRow(client: StorageCowSqlClient, userId: string): Promise<void> {
		// Gate on auth_users existence so a stray/display read never trips the
		// user_storage_accounts -> auth_users FK by inserting a row for a
		// non-existent user (mirrors ensureWorkspaceQuotaRow's workspaces guard).
		await client.unsafe(`
			INSERT INTO user_storage_accounts (user_id, used_bytes, limit_bytes, plan_tier)
			SELECT user_id, 0, $2, 'free'
			FROM auth_users
			WHERE user_id = $1
			ON CONFLICT (user_id) DO NOTHING
		`, [userId, DEFAULT_USER_STORAGE_LIMIT_BYTES]);
	}

	/**
	 * Create (if missing) and then row-lock the account's quota row so the
	 * subsequent allowance read sees a real row under FOR UPDATE. Concurrent
	 * first writers for the same account therefore serialize on this row instead
	 * of both observing used=0 and both passing the limit gate.
	 */
	private async ensureQuotaRowForUpdate(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string): Promise<void> {
		if (accountKind === "workspace") {
			await this.ensureWorkspaceQuotaRow(client, accountId);
			await client.unsafe(`
				SELECT 1 FROM workspace_billing_accounts WHERE workspace_id = $1 FOR UPDATE
			`, [accountId]);
			return;
		}
		await this.ensureUserQuotaRow(client, accountId);
		await client.unsafe(`
			SELECT 1 FROM user_storage_accounts WHERE user_id = $1 FOR UPDATE
		`, [accountId]);
	}

	private async getAssetAccessRow(client: StorageCowSqlClient, assetId: string, userId: string): Promise<AssetAccessRow | undefined> {
		const rows = await client.unsafe<AssetAccessRow>(`
			SELECT asset_records.id AS asset_id,
				asset_records.project_id,
				asset_records.workspace_id,
				projects.workspace_id AS project_workspace_id,
				projects.owner_user_id AS project_user_id,
				workspace_members.role AS member_role
			FROM asset_records
			LEFT JOIN projects ON projects.project_id = asset_records.project_id
			LEFT JOIN workspace_members
				ON workspace_members.workspace_id = COALESCE(asset_records.workspace_id, projects.workspace_id)
				AND workspace_members.user_id = $2
				AND workspace_members.disabled_at IS NULL
			WHERE asset_records.id = $1::uuid
			LIMIT 1
		`, [assetId, userId]);
		return rows[0];
	}

	private async assertCanMutateWorkspaceVersion(
		client: StorageCowSqlClient,
		version: VersionRow,
		workspaceId: string,
		userId: string,
	): Promise<void> {
		const assetWorkspaceId = version.asset_workspace_id?.trim() || version.project_workspace_id?.trim();
		if (assetWorkspaceId && assetWorkspaceId !== workspaceId) {
			throw new StorageCowAuthorizationError("Version does not belong to the requested workspace");
		}
		if (!assetWorkspaceId && version.asset_project_id !== workspaceId) {
			throw new StorageCowAuthorizationError("Version does not belong to the requested account");
		}
		if (assetWorkspaceId) {
			await this.assertWorkspaceMemberCanMutate(client, assetWorkspaceId, userId);
			return;
		}
		if (version.project_user_id && version.project_user_id !== userId) {
			throw new StorageCowAuthorizationError("Forbidden: cannot mutate another user's project asset");
		}
	}

	private async assertCanDeleteVersion(
		client: StorageCowSqlClient,
		version: VersionRow,
		userId: string | undefined,
		role: string | undefined,
	): Promise<void> {
		if (!userId) {
			throw new StorageCowAuthorizationError("Version delete requires authentication", 401, "unauthorized");
		}
		// owner is a strict superset of the platform admin role, so a literal
		// role === "admin" would wrongly exclude owner from the admin bypass.
		if (role === "owner" || role === "admin") return;
		if (version.account_kind === "user") {
			if (version.account_id === userId) return;
			throw new StorageCowAuthorizationError("Cannot delete another user's asset version");
		}
		const assetWorkspaceId = version.asset_workspace_id?.trim() || version.project_workspace_id?.trim();
		if (assetWorkspaceId) {
			await this.assertWorkspaceMemberCanMutate(client, assetWorkspaceId, userId);
			return;
		}
		if (version.project_user_id && version.project_user_id === userId) return;
		throw new StorageCowAuthorizationError("Forbidden: missing project asset delete access");
	}

	private async assertWorkspaceMemberCanMutate(client: StorageCowSqlClient, workspaceId: string, userId: string): Promise<void> {
		const rows = await client.unsafe<{ role?: string | null }>(`
			SELECT role
			FROM workspace_members
			WHERE workspace_id = $1
				AND user_id = $2
				AND disabled_at IS NULL
			LIMIT 1
		`, [workspaceId, userId]);
		if (!roleCanMutateWorkspace(rows[0]?.role)) {
			throw new StorageCowAuthorizationError("Forbidden: missing workspace write access");
		}
	}

	private async assertAssetProjectAccess(asset: AssetAccessRow, userId: string, role: string | undefined): Promise<void> {
		if (asset.workspace_id?.trim() || asset.project_workspace_id?.trim()) {
			if (roleCanMutateWorkspace(asset.member_role)) return;
			throw new StorageCowAuthorizationError("Forbidden: missing workspace write access");
		}
		// owner is a strict superset of the platform admin role — admit it wherever
		// the literal admin bypass applies.
		if (role === "owner" || role === "admin") return;
		if (asset.project_user_id && asset.project_user_id === userId) return;
		throw new StorageCowAuthorizationError("Forbidden: missing project asset access");
	}

	private async markVersionMaster(client: StorageCowSqlClient, versionId: string): Promise<void> {
		await client.unsafe("UPDATE asset_versions SET branch = 'master' WHERE version_id = $1::uuid", [versionId]);
	}

	private async getTopLargestAssets(client: StorageCowSqlClient, accountKind: AssetAccountKind, accountId: string): Promise<QuotaLargestAsset[]> {
		const rows = await client.unsafe<LargestAssetRow>(`
			SELECT COALESCE(asset_records.original_name, asset_records.asset_id) AS name,
				content_blobs.byte_size AS size,
				asset_versions.account_kind AS kind,
				asset_records.asset_id AS asset_id
			FROM asset_versions
			JOIN content_blobs ON content_blobs.sha256 = asset_versions.sha256
			JOIN asset_records ON asset_records.id = asset_versions.asset_id
			WHERE asset_versions.account_kind = $1
				AND asset_versions.account_id = $2
			ORDER BY content_blobs.byte_size DESC, asset_versions.created_at DESC
			LIMIT 5
		`, [accountKind, accountId]);
		return rows.map((row) => ({
			name: row.name ?? "asset",
			size: toNumber(row.size),
			kind: row.kind ?? accountKind,
			asset_id: row.asset_id ?? "",
		}));
	}
}

function roleCanMutateWorkspace(role: string | null | undefined): boolean {
	return role === "owner" || role === "admin" || role === "editor";
}

// Module-level shared service + SQL client. The HTTP routes used to construct a
// fresh `getSharedBunSql(...)` pool per request and never closed it, leaking idle
// Postgres connections until `max_connections` was hit (Codex P1: "Reuse SQL
// clients instead of leaking pools"). Mirroring the other DB-backed services
// (auth-users, billing-store, project-catalog, …) we memoize one pool/service
// for the process lifetime and hand the same instance to every request.
let sharedStorageCowService: StorageCowService | undefined;
let sharedStorageCowDatabaseUrl: string | undefined;

/**
 * Test seam: inject a fake shared service so route tests can exercise paths
 * that now run AFTER the authoritative write check (codex P1 reordering)
 * without a DATABASE_URL. Mirrors the other *ForTesting setters.
 */
export function setSharedStorageCowServiceForTesting(service: StorageCowService | null): void {
	sharedStorageCowServiceForTesting = service;
}

let sharedStorageCowServiceForTesting: StorageCowService | null = null;

export function getSharedStorageCowService(): StorageCowService {
	if (sharedStorageCowServiceForTesting) return sharedStorageCowServiceForTesting;
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required for storage CoW routes");
	}
	// Rebuild only if the DATABASE_URL actually changes (e.g. between test
	// runs); otherwise reuse the cached pool so connections do not accumulate.
	if (!sharedStorageCowService || sharedStorageCowDatabaseUrl !== databaseUrl) {
		sharedStorageCowService = new StorageCowService({
			client: getSharedBunSql(databaseUrl) as unknown as StorageCowSqlClient,
		});
		sharedStorageCowDatabaseUrl = databaseUrl;
	}
	return sharedStorageCowService;
}
