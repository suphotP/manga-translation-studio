// Storage copy-on-write asset surface (W2.8).
//
// Wires the {@link StorageCowService} into a small HTTP surface:
//
//   - POST   /api/assets/upload                       — writeBlob (dedupe + quota)
//   - POST   /api/assets/:id/promote                  — admin/QC only
//   - DELETE /api/assets/:id/versions/:versionId      — drop one version
//
// The 402 quota_frozen body comes from {@link QuotaFrozenError} so the client
// can render the "delete or promote to free space" prompt from a single model
// regardless of which writer surface tripped the freeze.

import { Hono } from "hono";
import sharp from "sharp";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serverConfig } from "../config.js";
import { getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import {
	QuotaFrozenError,
	getSharedStorageCowService,
	StorageCowAuthorizationError,
	type AssetAccountKind,
} from "../services/storage-cow.js";
import {
	UploadedImageDecodeError,
	UploadedImageTooLargeError,
	buildModerationDerivativePlan,
	createSha256,
	executeModerationTilePlan,
	getUploadImagePixelCeiling,
	storageStatusForModerationResult,
	validateUploadedImageBuffer,
} from "../services/assets.js";
import {
	buildDenylistLookupFailClosedResult,
	buildKnownBlockedShaAssetResult,
	lookupKnownBlockedSha256,
	mandatoryCsamScreenBuffer,
} from "../services/moderation.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import type { AssetModerationResult } from "../types/index.js";
import { isPlatformAdmin, type JWTPayload } from "../types/auth.js";

const assets = new Hono();
assets.use("*", optionalAuth);

function requireAdminOrQc(user: JWTPayload | undefined): Response | null {
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	// QC = editor; platform admin role inherits. owner is a strict superset of
	// admin, so isPlatformAdmin() admits owner wherever admin is admitted. A viewer
	// cannot ship a working copy to master because doing so transfers bytes off
	// their user account onto the workspace ledger — that is a quota-carrying
	// decision, not a read.
	if (!isPlatformAdmin(user.role) && user.role !== "editor") {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}
	return null;
}

function quotaFrozenResponse(error: QuotaFrozenError, fallbackSuggestion: "delete" | "upgrade"): Response {
	return Response.json({
		error: "Storage quota frozen",
		code: "quota_frozen",
		account_kind: error.accountKind,
		account_id: error.accountId,
		used_bytes: error.usedBytes,
		limit_bytes: error.limitBytes,
		usedPct: error.limitBytes > 0
			? Math.round((error.usedBytes / error.limitBytes) * 10000) / 100
			: 0,
		top_5_largest_assets: error.top5LargestAssets,
		// `delete` is offered to user accounts (they can free their own working
		// copies); workspaces are told to `upgrade` instead because deleting a
		// shipped master asset is rarely the right answer at the freeze line.
		suggested_action: error.accountKind === "user" ? "delete" : fallbackSuggestion,
	}, { status: 402 });
}

function isAssetAccountKind(value: unknown): value is AssetAccountKind {
	return value === "workspace" || value === "user";
}

interface UploadRequestBody {
	accountKind?: unknown;
	accountId?: unknown;
	assetId?: unknown;
	mimeType?: unknown;
	bufferBase64?: unknown;
	parentVersionId?: unknown;
	asWorkingCopy?: unknown;
}

// The CoW upload surface is the durable blob store for IMAGE assets. Every real
// caller (the image-upload path's CoW writes) sends image/png|jpeg|webp — the only
// types the rest of the pipeline (sharp decode, moderation, thumbnails) can handle.
// A declared type with NO validation story (fonts, zips, octet-stream, …) is
// REJECTED rather than written verbatim, so a writer cannot smuggle an arbitrary
// blob (or a spoofed MIME) past the image safety gates the /api/images upload path
// enforces. The map's value is the canonical sharp metadata `format` for that MIME,
// used to cross-check the DECLARED type against the DECODED magic bytes.
const SUPPORTED_IMAGE_MIME_TO_SHARP_FORMAT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/webp": "webp",
};

const SUPPORTED_IMAGE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

function uploadAssetIdExtension(assetId: string): string | undefined {
	const normalized = assetId.trim().toLowerCase();
	const lastDot = normalized.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === normalized.length - 1) return undefined;
	const extension = normalized.slice(lastDot + 1);
	return /^[a-z0-9]+$/.test(extension) ? extension : undefined;
}

/**
 * Outcome of {@link validateUploadAssetBuffer}: either OK (validated, safe to
 * writeBlob) or a typed rejection the route turns into the proper HTTP response.
 * Mirrors the /api/images upload path's gates so the two writer surfaces agree.
 */
type UploadAssetValidation =
	| { ok: true; moderation: AssetModerationResult }
	| { ok: false; status: ContentfulStatusCode; body: { error: string; code: string; [k: string]: unknown } };

/** Signature of the mandatory CSAM screen — injectable so tests can spy/fake it. */
export type CsamScreen = typeof mandatoryCsamScreenBuffer;

/** Signature of the tile-plan executor — injectable so tests can spy/fake it. */
export type TileScreen = typeof executeModerationTilePlan;

/**
 * Bring a CoW asset upload to PARITY with POST /api/images/:projectId/upload before
 * the blob is ever written. In the SAME order the image path uses:
 *
 *   1. type-family gate — only the supported image MIMEs are accepted; any other
 *      declared type is rejected (400 unsupported_asset_type) instead of stored raw.
 *   2. validateUploadedImageBuffer — sharp header decode (magic-byte/"is it really an
 *      image" check) + the per-image pixel CEILING (decompression-bomb guard: a ≤1MB
 *      body declaring hundreds of megapixels is rejected from its header, 413).
 *   3. declared-vs-actual MIME — the decoded sharp `format` MUST match the declared
 *      mimeType (400 mime_type_mismatch) so a PNG mislabeled image/webp can't slip a
 *      spoofed content-type into the content-addressed store.
 *   4. known-CSAM-sha denylist (TRI-STATE, fail-closed) — compute the buffer's
 *      sha256 and consult {@link lookupKnownBlockedSha256} BEFORE any provider call,
 *      exactly as the /api/images upload path does (images.ts ~L1542). A `blocked`
 *      sha is HARD-BLOCKED (403) regardless of provider availability — a confirmed
 *      CSAM hash can never be re-admitted even while the soft toggle is off; a
 *      `lookup-error` (DB down) FAILS CLOSED (held for review) rather than proceeding
 *      as "not denylisted".
 *   5. mandatoryCsamScreenBuffer — the fail-closed CSAM screen every other upload
 *      path enforces, called WITH the same sha256 so a confirmed block SEEDS the
 *      denylist (images.ts ~L1556). A `blocked` verdict rejects the upload (403)
 *      BEFORE writeBlob. A fail-closed `needs_review` (provider error/outage/no key,
 *      or the denylist-lookup failure above) is NOT rejected — it returns `ok: true`
 *      with the verdict threaded, mirroring the image path, which PERSISTS such an
 *      asset but QUARANTINES it (the route hands the verdict to writeBlob, which sets
 *      the asset record's storage_status to `quarantined` — withheld from serving AND
 *      export — instead of leaving unscreened bytes durably stored with no record).
 *      Blanket-rejecting on a provider outage would break uploads platform-wide; the
 *      image path's persist-with-quarantine is the precedent we follow.
 *   6. tile moderation (FINDING 2) — the overview in (5) screens ONE downscaled
 *      whole-image derivative, which dilutes a small unsafe region on a very tall
 *      webtoon page below threshold; a tall CoW upload could otherwise pass here that
 *      /api/images would block. After (5), run buildModerationDerivativePlan +
 *      executeModerationTilePlan against the FULL-resolution source exactly as
 *      images.ts does, aggregating fail-closed. The plan only emits tiles for tall/
 *      large images, so short uploads incur no extra provider cost. A blocked tile
 *      rejects (403); a needs_review/fail-closed tile threads through to quarantine.
 *
 * `screen` defaults to the real mandatory (overview) screen and `tileScreen` to the
 * real tile executor; tests inject deterministic fakes.
 */
export async function validateUploadAssetBuffer(input: {
	buffer: Buffer;
	mimeType: string;
	assetId: string;
	workspaceId: string;
	ipAddress?: string;
	userAgent?: string;
	screen?: CsamScreen;
	tileScreen?: TileScreen;
}): Promise<UploadAssetValidation> {
	const expectedFormat = SUPPORTED_IMAGE_MIME_TO_SHARP_FORMAT[input.mimeType];
	if (!expectedFormat) {
		return {
			ok: false,
			status: 400,
			body: {
				error: `Unsupported asset type '${input.mimeType}'. Only ${Object.keys(SUPPORTED_IMAGE_MIME_TO_SHARP_FORMAT).join(", ")} are accepted.`,
				code: "unsupported_asset_type",
			},
		};
	}

	const assetExtension = uploadAssetIdExtension(input.assetId);
	const extensionMimeType = assetExtension ? SUPPORTED_IMAGE_EXTENSION_TO_MIME_TYPE[assetExtension] : undefined;
	if (assetExtension && !extensionMimeType) {
		return {
			ok: false,
			status: 400,
			body: {
				error: `Unsupported asset extension '.${assetExtension}'. Only ${Object.keys(SUPPORTED_IMAGE_EXTENSION_TO_MIME_TYPE).join(", ")} are accepted.`,
				code: "unsupported_asset_extension",
				extension: assetExtension,
			},
		};
	}
	if (extensionMimeType && extensionMimeType !== input.mimeType) {
		// Asset ids are often internal UUIDs with no suffix, so no-extension ids stay
		// legal. But when a caller does provide an image-looking suffix, it must agree
		// with the declared MIME before we spend a decode or moderation call.
		return {
			ok: false,
			status: 400,
			body: {
				error: `Asset extension '.${assetExtension}' does not match declared mimeType '${input.mimeType}'.`,
				code: "asset_extension_mismatch",
				extension: assetExtension,
				declaredMimeType: input.mimeType,
				expectedMimeType: extensionMimeType,
			},
		};
	}

	// (2) magic-byte decode + pixel-ceiling / decompression-bomb guard.
	let actualFormat: string | undefined;
	let dimensions: { width: number; height: number } | undefined;
	try {
		// validateUploadedImageBuffer runs sharp().metadata(): it proves the buffer
		// decodes (magic-byte/"is it really an image" check) and enforces the per-image
		// pixel CEILING (decompression-bomb guard) — throwing on either failure. The
		// returned dimensions feed the tile plan below (a tall webtoon page must be
		// screened by tiles, not just the diluted overview — parity with /api/images).
		dimensions = await validateUploadedImageBuffer(input.buffer, input.assetId);
		// Re-read the decoded format (header only, cheap) as the authoritative magic-byte
		// signal for the declared-vs-actual cross-check below.
		actualFormat = (await sharp(input.buffer).metadata()).format;
	} catch (error) {
		if (error instanceof UploadedImageTooLargeError) {
			const ceiling = getUploadImagePixelCeiling();
			return {
				ok: false,
				status: 413,
				body: {
					error: "Uploaded image exceeds the maximum accepted dimensions",
					code: "image_dimensions_too_large",
					width: error.width,
					height: error.height,
					maxWidth: ceiling.maxWidth,
					maxHeight: ceiling.maxHeight,
					maxMegapixels: Math.round(ceiling.maxPixels / 1_000_000),
				},
			};
		}
		if (error instanceof UploadedImageDecodeError) {
			return {
				ok: false,
				status: 400,
				body: { error: "Uploaded asset is not a decodable image", code: "image_not_decodable" },
			};
		}
		throw error;
	}

	// (3) the decoded magic-byte format MUST match the client's declared MIME.
	if (actualFormat !== expectedFormat) {
		return {
			ok: false,
			status: 400,
			body: {
				error: `Declared mimeType '${input.mimeType}' does not match the actual image bytes (${actualFormat ?? "unknown"}).`,
				code: "mime_type_mismatch",
				declaredMimeType: input.mimeType,
				actualFormat: actualFormat ?? null,
			},
		};
	}

	// (4) known-CSAM-sha denylist (TRI-STATE, fail-closed) — runs BEFORE any
	// provider call, exactly as the /api/images upload path does (images.ts ~L1542).
	// The CoW write layer hashes the same bytes with createSha256 (hex sha256, the
	// encoding csam_blocks stores), so we reuse it here for the lookup AND pass it
	// into the screen below so a confirmed block seeds the denylist.
	const sha256 = createSha256(input.buffer);
	const denylist = await lookupKnownBlockedSha256(sha256);
	if (denylist === "blocked") {
		// A confirmed CSAM hash: hard-block regardless of provider availability, with
		// NO provider call. Mirrors images.ts throwing UploadModerationBlockedError on
		// a `blocked` denylist hit before mandatoryCsamScreenBuffer ever runs.
		return {
			ok: false,
			status: 403,
			body: {
				error: "Uploaded asset blocked by mandatory safety policy",
				code: "moderation_blocked",
				moderation: buildKnownBlockedShaAssetResult(sha256),
			},
		};
	}
	if (denylist === "lookup-error") {
		// Denylist store down: an exact known-bad re-upload must never depend on
		// provider rediscovery, so hold for review (fail-closed) WITHOUT calling the
		// provider — the asset is persisted-but-quarantined by the route. Mirrors
		// images.ts using buildDenylistLookupFailClosedResult() on a lookup error.
		return { ok: true, moderation: buildDenylistLookupFailClosedResult() };
	}

	// (5) mandatory CSAM screen — fail-closed; pass the SAME sha256 so a confirmed
	// block seeds the denylist (csam_blocks) exactly as the image path does. A hard
	// block rejects before writeBlob; a fail-closed `needs_review` is NOT rejected —
	// it returns ok:true with the verdict threaded so the route PERSISTS the asset
	// but QUARANTINES it (writeBlob sets storage_status from this verdict), matching
	// the image path's choice (a blanket reject on a provider outage would break
	// uploads platform-wide).
	const screen = input.screen ?? mandatoryCsamScreenBuffer;
	const overview = await screen(input.buffer, input.mimeType, input.workspaceId, {
		assetId: input.assetId,
		sha256,
		ipAddress: input.ipAddress,
		userAgent: input.userAgent,
	});
	if (overview.status === "blocked") {
		return {
			ok: false,
			status: 403,
			body: {
				error: "Uploaded asset blocked by mandatory safety policy",
				code: "moderation_blocked",
				moderation: overview,
			},
		};
	}

	// (6) TILE MODERATION (FINDING 2): the overview above screens ONE downscaled
	// whole-image derivative, which can dilute a small unsafe region below threshold
	// on a very tall webtoon page — so a tall CoW upload could pass here that
	// /api/images would block. Reuse the EXACT SAME aggregation images.ts runs after
	// its overview screen (images.ts ~L1593): build the derivative plan and execute
	// the planned tiles against the FULL-resolution source, aggregating fail-closed
	// (any blocked tile → block; any needs_review/fail-closed tile → needs_review).
	// The plan builder only emits tiles for tall/large images, so a short page returns
	// the overview verdict unchanged at no extra provider cost — same as images. Each
	// tile is screened through moderateImageBuffer (the mandatory CSAM screen + the
	// known-CSAM-sha denylist), so no tall region is left unscreened.
	const tileScreen = input.tileScreen ?? executeModerationTilePlan;
	const moderation = dimensions
		? await tileScreen(input.buffer, input.mimeType, buildModerationDerivativePlan(dimensions), overview, {
			workspaceId: input.workspaceId,
			assetId: input.assetId,
			ipAddress: input.ipAddress,
			userAgent: input.userAgent,
		})
		: overview;
	if (moderation.status === "blocked") {
		// A blocked tile rejects the upload BEFORE writeBlob, exactly as the overview
		// hard-block does (parity with images.ts, which throws UploadModerationBlockedError
		// on a blocked tile aggregate).
		return {
			ok: false,
			status: 403,
			body: {
				error: "Uploaded asset blocked by mandatory safety policy",
				code: "moderation_blocked",
				moderation,
			},
		};
	}

	return { ok: true, moderation };
}

assets.post("/upload", async (c) => {
	// requesterUserId comes from the JWT, NOT the body — letting the client pass
	// it would let an unauthenticated caller forge a working_copy that bills
	// some other user's quota.
	const user = getAuthUser(c) as JWTPayload | undefined;
	const body = await c.req.json().catch(() => ({})) as UploadRequestBody;

	if (!isAssetAccountKind(body.accountKind)) {
		return c.json({ error: "accountKind must be 'workspace' or 'user'", code: "invalid_account_kind" }, 400);
	}
	const accountKind = body.accountKind;
	const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
	const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : "";
	const bufferBase64 = typeof body.bufferBase64 === "string" ? body.bufferBase64 : "";
	if (!accountId) return c.json({ error: "accountId is required", code: "invalid_account_id" }, 400);
	if (!assetId) return c.json({ error: "assetId is required", code: "invalid_asset_id" }, 400);
	if (!mimeType) return c.json({ error: "mimeType is required", code: "invalid_mime_type" }, 400);
	if (!bufferBase64) return c.json({ error: "bufferBase64 is required", code: "invalid_buffer" }, 400);

	// Reject oversized payloads BEFORE decoding base64 (Codex P2: "Validate upload
	// size before decoding base64"). This endpoint is optional-auth, so without a
	// pre-decode guard an unauthenticated/unauthorized caller could force the
	// backend to allocate an arbitrarily large `Buffer` just by sending a huge JSON
	// string — an avoidable memory/CPU DoS. Base64 inflates bytes by ~4/3, so the
	// encoded string is at most ~4/3 of the decoded size; gate on the encoded
	// length to bound the allocation up front. Mirrors the per-file MB limit the
	// multipart image upload path enforces.
	const maxUploadBytes = serverConfig.maxUploadSize * 1024 * 1024;
	const maxEncodedLength = Math.ceil(maxUploadBytes / 3) * 4;
	if (bufferBase64.length > maxEncodedLength) {
		return c.json({
			error: `Upload exceeds ${serverConfig.maxUploadSize}MB limit`,
			code: "upload_too_large",
		}, 413);
	}

	let buffer: Buffer;
	try {
		buffer = Buffer.from(bufferBase64, "base64");
	} catch {
		return c.json({ error: "bufferBase64 is not valid base64", code: "invalid_buffer" }, 400);
	}
	if (buffer.byteLength > maxUploadBytes) {
		return c.json({
			error: `Upload exceeds ${serverConfig.maxUploadSize}MB limit`,
			code: "upload_too_large",
		}, 413);
	}
	if (buffer.byteLength === 0) {
		return c.json({ error: "decoded buffer is empty", code: "invalid_buffer" }, 400);
	}

	const asWorkingCopy = typeof body.asWorkingCopy === "boolean" ? body.asWorkingCopy : accountKind === "user";
	if (asWorkingCopy && !user?.userId) {
		return c.json({ error: "working_copy upload requires authentication", code: "unauthorized" }, 401);
	}
		// Fast-path error before the service performs the authoritative asset/workspace
		// check below. Direct uploads never charge bytes to another user's ledger.
		if (accountKind === "user" && user && user.userId !== accountId) {
			return c.json({ error: "cannot upload to another user's storage account", code: "forbidden" }, 403);
		}

		const parentVersionId = typeof body.parentVersionId === "string" && body.parentVersionId.trim()
			? body.parentVersionId.trim()
			: undefined;

		try {
			const service = getSharedStorageCowService();
			// Authoritative write authorization FIRST: an unauthorized caller must be
			// rejected by the cheap access check before we spend a sharp decode or a
			// PAID moderation call on their bytes (codex P1 — a rejected request could
			// otherwise burn OpenAI moderation quota using an arbitrary workspace id).
			// It returns the resolved write context (the asset's OWNING workspace id),
			// loaded while it already held the asset record — see workspaceId threading
			// below (FINDING 2).
			const authorization = await service.assertCanWriteAsset({
				assetId,
				accountKind,
				accountId,
				requesterUserId: user?.userId,
				requesterRole: user?.role,
				asWorkingCopy,
			});
			// CHEAP PRE-MODERATION QUOTA/FREEZE GATE (FINDING 1): an authorized-but-
			// frozen / already-over-limit account otherwise passes the access check
			// above, BURNS the PAID moderation call inside validateUploadAssetBuffer,
			// and only THEN has writeBlob's authoritative quota gate throw
			// QuotaFrozenError — wasting an OpenAI call on bytes we will refuse to
			// store. /api/images already checks quota BEFORE moderation; this mirrors
			// that ordering. This precheck is a READ-ONLY COST GATE: it does not lock,
			// reserve, or charge. The authoritative, race-safe freeze/limit check
			// STAYS inside writeBlob (assertQuotaAllowance, under the quota-row lock
			// with the exact byte charge), so a freeze applied during the moderation
			// window — or a charge that crosses the line — is still rejected there.
			// Gate the SAME ledger writeBlob charges: it bills (accountKind, accountId)
			// from the body (a user upload is fixed to the requester's own account by
			// the forbidden-cross-user check above), so the precheck reads that account.
			await service.assertAccountNotFrozen(accountKind, accountId);
			// CHEAP PARENT-VERSION PREFLIGHT (round-5 FINDING 3): a bad parentVersionId
			// (malformed uuid, missing, or belonging to ANOTHER asset/tenant) must 400
			// BEFORE we spend a sharp decode or a PAID moderation call in
			// validateUploadAssetBuffer. The authoritative re-check STAYS inside
			// writeBlob (under the write transaction, where the parent could have been
			// deleted in the meantime); this is a read-only hoist of the same query so
			// the common bad-input case is rejected up front with zero screen/tile work.
			if (parentVersionId) {
				await service.assertParentVersionWritable(parentVersionId, assetId);
			}
			// PARITY with POST /api/images/:projectId/upload: validate the image bytes
			// (magic-byte decode + pixel-bomb ceiling + declared-vs-actual MIME) and run
			// the MANDATORY fail-closed CSAM screen BEFORE the durable blob is written.
			// Without this, a writer could store a decompression bomb (≤1MB body →
			// hundreds of MP on later decode) or bypass the moderation gate every
			// image-upload path enforces.
			//
			// MODERATION WORKSPACE ATTRIBUTION (FINDING 2): a workspace-account upload
			// bills the workspace ledger, so accountId IS the workspace. But a
			// user-account WORKING-COPY upload of a WORKSPACE asset has accountKind
			// "user" — yet assertCanWriteAsset just RESOLVED the asset's owning
			// workspace. Threading that resolved workspaceId preserves the workspace's
			// BYO soft-policy bypass + correct CSAM audit attribution that an empty
			// workspaceId would lose. Fall back to the old accountKind-based logic only
			// when the resolution has none (a personal/workspace-less project).
			const moderationWorkspaceId = authorization.workspaceId
				?? (accountKind === "workspace" ? accountId : "");
			const validation = await validateUploadAssetBuffer({
				buffer,
				mimeType,
				assetId,
				workspaceId: moderationWorkspaceId,
				ipAddress: getTrustedClientIp(c),
				userAgent: c.req.header("user-agent") ?? undefined,
			});
			if (!validation.ok) {
				return c.json(validation.body, validation.status);
			}
			const result = await service.writeBlob({
				buffer,
				mimeType,
				accountKind,
				accountId,
				assetId,
				requesterUserId: asWorkingCopy ? user?.userId : undefined,
				parentVersionId,
				// Thread the moderation verdict so the durable asset record carries the
				// review/quarantine state (parity with /api/images): a fail-closed
				// `needs_review` (provider outage / no key / denylist-lookup failure)
				// QUARANTINES the asset — withheld from serving AND export — instead of
				// leaving unscreened bytes durably stored with no record. A `passed`
				// verdict releases it as before.
				moderation: validation.moderation,
			});
		return c.json({
			version_id: result.version_id,
			sha256: result.sha256,
			bytes_charged: result.bytes_charged,
			branch: asWorkingCopy ? "working_copy" : "master",
			// Surface the moderation verdict + derived storage state so the client can
			// render the review banner / know the asset is quarantined (parity with the
			// /api/images upload response). A fail-closed `needs_review` is persisted but
			// `quarantined` (withheld from serving AND export) until re-moderation.
			moderation: validation.moderation,
			storageStatus: storageStatusForModerationResult(validation.moderation),
		});
		} catch (error) {
			if (error instanceof StorageCowAuthorizationError) {
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			if (error instanceof QuotaFrozenError) {
				return quotaFrozenResponse(error, "upgrade");
			}
		throw error;
	}
});

assets.post("/:id/promote", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	const authError = requireAdminOrQc(user);
	if (authError) return authError;

	const body = await c.req.json().catch(() => ({})) as { workspaceId?: string; versionId?: string };
	const workspaceId = body.workspaceId?.trim();
	if (!workspaceId) {
		return c.json({ error: "workspaceId is required", code: "workspace_id_required" }, 400);
	}
	// The route param is the asset/version identifier the client has. We accept
	// both `:id` as the version_id (default for back-compat) and a body
	// `versionId` override so a future asset-scoped promote can use the asset
	// id in the path and target a specific version in the body.
	const versionId = body.versionId?.trim() || c.req.param("id");

	try {
		await getSharedStorageCowService().promoteToMaster({
			versionId,
			workspaceId,
			approverUserId: user!.userId,
			});
			return c.json({ ok: true, versionId, workspaceId });
		} catch (error) {
			if (error instanceof StorageCowAuthorizationError) {
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			if (error instanceof QuotaFrozenError) {
				return quotaFrozenResponse(error, "upgrade");
			}
			throw error;
		}
	});

assets.delete("/:id/versions/:versionId", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const versionId = c.req.param("versionId");
	if (!versionId) {
		return c.json({ error: "versionId is required", code: "version_id_required" }, 400);
	}

	// Fine-grained authorization (only the version owner or workspace admin can
	// delete a master version) is enforced inside the cow service against the
	// stored account_kind/account_id; here we only require an authenticated
	// caller so the deleterUserId is real.
	try {
		await getSharedStorageCowService().deleteVersion({
			versionId,
			deleterUserId: user.userId,
			deleterRole: user.role,
		});
		return c.json({ ok: true, versionId });
	} catch (error) {
		if (error instanceof StorageCowAuthorizationError) {
			return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
		}
		throw error;
	}
});

export { assets };
