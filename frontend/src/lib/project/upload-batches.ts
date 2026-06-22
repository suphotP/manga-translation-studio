import type { UploadImagesResult } from "$lib/api/client.js";

/**
 * Files-per-batch for chapter-page uploads. Kept deliberately MODEST (not the
 * old 80) so a typical chapter makes several requests instead of one opaque
 * megarequest — that lets the dialog show real, advancing per-page progress
 * (uploadedFiles climbs batch-by-batch) and keeps each request small enough that
 * the byte-level `onProgress` animates smoothly. Order is unaffected: batches are
 * concatenated back in selection order, so the produced project is identical.
 */
export const DEFAULT_IMAGE_UPLOAD_BATCH_SIZE = 12;

/**
 * Cumulative bytes allowed per upload request. The backend rejects a batch
 * whose files sum over `MAX_UPLOAD_BATCH_SIZE_MB` (default 500MB) with a 413
 * (`images.ts` ~:1067). Batching by file COUNT alone ignored that cap, so a
 * folder of large scans could pack 80 files well over 500MB → 413 + rollback.
 * We keep a safety margin under the server cap (multipart overhead + the cover
 * upload that may ride along) so the client never trips the limit first.
 */
export const DEFAULT_IMAGE_UPLOAD_BATCH_MAX_BYTES = 450 * 1024 * 1024;

export interface ImageUploadBatchProgress {
	batchIndex: number;
	batchCount: number;
	fileCount: number;
	totalFiles: number;
	/** Files already uploaded by PRIOR batches (this batch not yet counted). */
	uploadedBeforeBatch: number;
}

/**
 * Mid-flight byte progress for the CURRENT batch, so the dialog bar animates
 * smoothly within a batch (not just on batch boundaries). `fraction` is the
 * batch's own 0..1 upload completion; `uploadedFilesEstimate` blends it with the
 * already-finished batches into a fractional uploaded-files count for the bar.
 */
export interface ImageUploadByteProgress {
	batchIndex: number;
	batchCount: number;
	fileCount: number;
	totalFiles: number;
	uploadedBeforeBatch: number;
	/** 0..1 upload completion of the current batch's bytes. */
	fraction: number;
	/** uploadedBeforeBatch + fraction * fileCount, clamped to totalFiles. */
	uploadedFilesEstimate: number;
}

/** Per-batch upload fn; the second arg streams byte progress for THIS batch. */
export type UploadBatchFn = (
	files: File[],
	onProgress?: (fraction: number) => void,
	/**
	 * Stable per-batch idempotency key (UUID). Kept CONSTANT across retries of the
	 * SAME batch, so a commit whose response was lost (network drop/timeout AFTER the
	 * server committed) is replayed server-side on retry — no duplicate/orphaned
	 * assets. Wired to the keep-mode transform endpoint's `Idempotency-Key` header.
	 */
	batchKey?: string,
) => Promise<UploadImagesResult>;

/** A new opaque batch idempotency key, stable for one batch across its retries. */
function newBatchKey(): string {
	return globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The pages a batched upload has ALREADY durably committed to the backend, so a
 * caller can either RESUME from here (skip these files, don't re-upload/re-meter)
 * or CLEAN UP these committed assets after an abort. `committedFiles` is the count
 * of leading selection files whose upload succeeded; `imageIds`/`assets` are their
 * committed results in selection order.
 */
export interface ImageUploadProgressState {
	/** Committed imageIds so far, in selection order. */
	imageIds: string[];
	/** Committed asset summaries so far, in selection order. */
	assets: NonNullable<UploadImagesResult["assets"]>;
	/** Count of leading selection files already committed (== imageIds.length). */
	committedFiles: number;
	/** Latest usage/storage snapshot from the last committed batch, if any. */
	usage?: UploadImagesResult["usage"];
	storageQuota?: UploadImagesResult["storageQuota"];
	/**
	 * Per-batch idempotency keys for the WHOLE planned batch sequence (index-aligned
	 * to `planUploadBatches`), carried forward so a retry reuses the SAME key for each
	 * batch — including the batch that FAILED. This is what closes the lost-response
	 * window: if that batch's commit actually succeeded server-side, re-sending its
	 * original key replays the committed result instead of duplicating it. Stashed on
	 * {@link ImageUploadBatchError.committed} and fed back via {@link ImageUploadBatchOptions.resume}.
	 */
	batchKeys?: string[];
}

/**
 * A batch-upload failure annotated with WHICH pages failed (1-based, inclusive)
 * so the dialog can tell the user the exact page span that stalled instead of a
 * silent generic error. Wraps the original cause (e.g. a 413 ApiError) and keeps
 * its message so existing friendly-error mapping still applies.
 *
 * It ALSO carries the {@link ImageUploadProgressState} of everything committed
 * BEFORE the failure. That is the whole atomicity fix: splitting one 80-page
 * request into smaller batches made a late-batch failure leave earlier batches
 * already committed (+ metered) server-side. Surfacing the committed span lets the
 * caller either resume the upload (skip committed pages on retry → no double-upload
 * / double-metering) or clean those assets up, instead of silently orphaning them.
 */
export class ImageUploadBatchError extends Error {
	readonly fromPage: number;
	readonly toPage: number;
	readonly cause: unknown;
	readonly committed: ImageUploadProgressState;

	constructor(fromPage: number, toPage: number, cause: unknown, committed: ImageUploadProgressState) {
		const causeMessage = cause instanceof Error ? cause.message : String(cause);
		super(causeMessage);
		this.name = "ImageUploadBatchError";
		this.fromPage = fromPage;
		this.toPage = toPage;
		this.cause = cause;
		this.committed = committed;
	}
}

export interface ImageUploadBatchOptions {
	/** Hard cap on files-per-batch. */
	batchSize?: number;
	/** Hard cap on cumulative bytes-per-batch (defaults to the backend-safe size). */
	maxBatchBytes?: number;
	onBatchStart?: (progress: ImageUploadBatchProgress) => void;
	/** Streamed byte-level progress while a batch is uploading. */
	onBatchProgress?: (progress: ImageUploadByteProgress) => void;
	/**
	 * RESUME a previously-interrupted batched upload of the SAME `files`. The
	 * leading `resume.committedFiles` files are skipped (NOT re-uploaded, so they
	 * are NOT re-metered) and `resume.imageIds`/`resume.assets` are prepended to the
	 * result so the produced project is byte-identical to an uninterrupted run.
	 * Callers obtain this from a prior {@link ImageUploadBatchError.committed}. The
	 * committed prefix must align to a batch boundary (it always does, because every
	 * batch commits atomically), and `committedFiles` must be ≤ `files.length`. Its
	 * `batchKeys` are reused so each batch keeps a STABLE idempotency key across the
	 * retry, closing the lost-response window on the batch that actually failed.
	 */
	resume?: ImageUploadProgressState;
}

/**
 * Split `files` into batches that respect BOTH a file-count cap and a cumulative
 * byte cap. A new batch starts whenever adding the next file would exceed either
 * limit; a single file larger than the byte cap still gets its own batch (the
 * backend then rejects it with a clear per-file size error rather than us
 * silently dropping it).
 */
export function planUploadBatches(
	files: File[],
	batchSize: number,
	maxBatchBytes: number,
): File[][] {
	const batches: File[][] = [];
	let current: File[] = [];
	let currentBytes = 0;

	for (const file of files) {
		const size = file.size ?? 0;
		const overCount = current.length >= batchSize;
		const overBytes = current.length > 0 && currentBytes + size > maxBatchBytes;
		if (overCount || overBytes) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(file);
		currentBytes += size;
	}
	if (current.length) batches.push(current);
	return batches;
}

export async function uploadImagesInBatches(
	files: File[],
	uploadBatch: UploadBatchFn,
	options: ImageUploadBatchOptions = {},
): Promise<UploadImagesResult> {
	const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_IMAGE_UPLOAD_BATCH_SIZE));
	const maxBatchBytes = Math.max(
		1,
		Math.floor(options.maxBatchBytes ?? DEFAULT_IMAGE_UPLOAD_BATCH_MAX_BYTES),
	);
	const batches = planUploadBatches(files, batchSize, maxBatchBytes);
	const batchCount = batches.length;

	// Per-batch idempotency keys, index-aligned to the planned batch sequence. On a
	// resume of the SAME selection the plan is identical (same files → same batches),
	// so reusing the stashed keys gives each batch a STABLE key across retries. The
	// FAILED batch's key is reused too, which is what de-dupes a commit whose response
	// was lost: re-sending its original key makes the server replay the committed
	// result. Any missing/short key array is back-filled with fresh keys.
	const resumeBatchKeys = options.resume?.batchKeys ?? [];
	const batchKeys: string[] = batches.map((_, index) => resumeBatchKeys[index] ?? newBatchKey());

	// On RESUME, pre-seed the committed prefix and skip the batches that already
	// uploaded. The committed prefix always aligns to a batch boundary because every
	// batch commits atomically (a batch either fully succeeds and is recorded in
	// `committed`, or it threw and nothing in it was committed). We still defensively
	// clamp `committedFiles` to the total so a stale/garbled resume can't skip past
	// the end. Seeded ids/assets are COPIED so we never mutate the caller's record.
	const committedFiles = Math.max(0, Math.min(options.resume?.committedFiles ?? 0, files.length));
	const imageIds: string[] = [...(options.resume?.imageIds ?? [])];
	const assets: NonNullable<UploadImagesResult["assets"]> = [...(options.resume?.assets ?? [])];
	let usage: UploadImagesResult["usage"] = options.resume?.usage;
	let storageQuota: UploadImagesResult["storageQuota"] = options.resume?.storageQuota;

	let uploadedFiles = committedFiles;
	let resumeSkip = committedFiles;
	for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
		const batch = batches[batchIndex];
		// Skip whole batches whose files were already committed in a prior attempt.
		// Batches map 1:1 to commit units, so a committed prefix consumes leading
		// batches entirely; we never split a batch across the resume boundary.
		if (resumeSkip >= batch.length) {
			resumeSkip -= batch.length;
			continue;
		}
		options.onBatchStart?.({
			batchIndex,
			batchCount,
			fileCount: batch.length,
			totalFiles: files.length,
			uploadedBeforeBatch: uploadedFiles,
		});
		const reportByteProgress = options.onBatchProgress
			? (fraction: number) => {
				const clamped = Math.max(0, Math.min(1, fraction));
				options.onBatchProgress?.({
					batchIndex,
					batchCount,
					fileCount: batch.length,
					totalFiles: files.length,
					uploadedBeforeBatch: uploadedFiles,
					fraction: clamped,
					uploadedFilesEstimate: Math.min(
						files.length,
						uploadedFiles + clamped * batch.length,
					),
				});
			}
			: undefined;
		let result: UploadImagesResult;
		try {
			result = await uploadBatch(batch, reportByteProgress, batchKeys[batchIndex]);
		} catch (error) {
			// Annotate with the 1-based page span of THIS batch so the dialog can name
			// exactly which pages failed. Preserves the original cause + message. Also
			// carry everything committed BEFORE this batch so the caller can resume
			// (skip these on retry) or clean them up — no orphaned, re-metered pages.
			// `batchKeys` (incl. the failed batch's key) rides along so the retry reuses
			// the SAME key per batch → a lost-response commit replays instead of dup'ing.
			throw new ImageUploadBatchError(
				uploadedFiles + 1,
				uploadedFiles + batch.length,
				error,
				{
					imageIds: [...imageIds],
					assets: [...assets],
					committedFiles: uploadedFiles,
					usage,
					storageQuota,
					batchKeys: [...batchKeys],
				},
			);
		}
		imageIds.push(...result.imageIds);
		if (result.assets?.length) assets.push(...result.assets);
		usage = result.usage;
		storageQuota = result.storageQuota;
		uploadedFiles += batch.length;
	}

	return {
		imageIds,
		assets,
		usage,
		storageQuota,
	};
}
