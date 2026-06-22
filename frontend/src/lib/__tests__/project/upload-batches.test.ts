import { describe, expect, it, vi } from "vitest";
import { ImageUploadBatchError, uploadImagesInBatches } from "$lib/project/upload-batches.js";

function file(name: string): File {
	return new File(["x"], name, { type: "image/png" });
}

describe("uploadImagesInBatches", () => {
	it("uploads large selections in stable ordered batches", async () => {
		const files = Array.from({ length: 7 }, (_, index) => file(`page-${index + 1}.png`));
		const starts: string[][] = [];
		const uploadBatch = vi.fn(async (batch: File[]) => {
			starts.push(batch.map((item) => item.name));
			return {
				imageIds: batch.map((item) => `${item.name}.id`),
				assets: batch.map((item) => ({
					assetId: `${item.name}.asset`,
					imageId: `${item.name}.id`,
					originalName: item.name,
					mimeType: item.type,
					sizeBytes: item.size,
					sha256: item.name,
					storageDriver: "local",
					storageKey: item.name,
					storageStatus: "ready",
					moderationStatus: "passed",
					derivativeCount: 0,
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				})),
			};
		});

		const result = await uploadImagesInBatches(files, uploadBatch, { batchSize: 3 });

		expect(uploadBatch).toHaveBeenCalledTimes(3);
		expect(starts).toEqual([
			["page-1.png", "page-2.png", "page-3.png"],
			["page-4.png", "page-5.png", "page-6.png"],
			["page-7.png"],
		]);
		expect(result.imageIds).toEqual(files.map((item) => `${item.name}.id`));
		expect(result.assets?.map((asset) => asset.originalName)).toEqual(files.map((item) => item.name));
	});

	it("reports batch progress before each upload", async () => {
		const progress = vi.fn();
		await uploadImagesInBatches(
			[file("a.png"), file("b.png"), file("c.png")],
			async (batch) => ({ imageIds: batch.map((item) => item.name) }),
			{ batchSize: 2, onBatchStart: progress },
		);

		expect(progress).toHaveBeenCalledWith({
			batchIndex: 0,
			batchCount: 2,
			fileCount: 2,
			totalFiles: 3,
			uploadedBeforeBatch: 0,
		});
		expect(progress).toHaveBeenCalledWith({
			batchIndex: 1,
			batchCount: 2,
			fileCount: 1,
			totalFiles: 3,
			uploadedBeforeBatch: 2,
		});
	});

	it("starts a new batch when cumulative bytes exceed the byte cap", async () => {
		// Three 4-byte files with a 9-byte cap → [a,b] (8B) then [c].
		const big = (name: string) => new File(["aaaa"], name, { type: "image/png" });
		const starts: string[][] = [];
		await uploadImagesInBatches(
			[big("a.png"), big("b.png"), big("c.png")],
			async (batch) => {
				starts.push(batch.map((f) => f.name));
				return { imageIds: batch.map((f) => f.name) };
			},
			{ batchSize: 80, maxBatchBytes: 9 },
		);
		expect(starts).toEqual([["a.png", "b.png"], ["c.png"]]);
	});

	it("streams byte progress into an advancing uploaded-files estimate", async () => {
		const estimates: number[] = [];
		await uploadImagesInBatches(
			[file("a.png"), file("b.png"), file("c.png"), file("d.png")],
			async (batch, onProgress) => {
				// Simulate two byte-progress ticks per request (50% then 100%).
				onProgress?.(0.5);
				onProgress?.(1);
				return { imageIds: batch.map((item) => item.name) };
			},
			{
				batchSize: 2,
				onBatchProgress: ({ uploadedFilesEstimate }) => estimates.push(uploadedFilesEstimate),
			},
		);

		// Batch 0 (files a,b): 0 + 0.5*2 = 1, then 0 + 1*2 = 2.
		// Batch 1 (files c,d): 2 + 0.5*2 = 3, then 2 + 1*2 = 4.
		expect(estimates).toEqual([1, 2, 3, 4]);
		// Estimate is monotonic non-decreasing and never exceeds the total.
		for (let i = 1; i < estimates.length; i += 1) {
			expect(estimates[i]).toBeGreaterThanOrEqual(estimates[i - 1]);
		}
		expect(Math.max(...estimates)).toBeLessThanOrEqual(4);
	});

	it("clamps a byte-progress fraction outside 0..1", async () => {
		const fractions: number[] = [];
		await uploadImagesInBatches(
			[file("a.png")],
			async (batch, onProgress) => {
				onProgress?.(-0.5);
				onProgress?.(1.7);
				return { imageIds: batch.map((item) => item.name) };
			},
			{ batchSize: 1, onBatchProgress: ({ fraction }) => fractions.push(fraction) },
		);
		expect(fractions).toEqual([0, 1]);
	});

	it("wraps a failed batch with the 1-based page span that failed", async () => {
		const boom = new Error("server exploded");
		const error = await uploadImagesInBatches(
			[file("a.png"), file("b.png"), file("c.png"), file("d.png"), file("e.png")],
			async (batch) => {
				// Fail on the SECOND batch (pages 3..4 of 5).
				if (batch[0].name === "c.png") throw boom;
				return { imageIds: batch.map((item) => item.name) };
			},
			{ batchSize: 2 },
		).catch((e) => e);

		expect(error).toBeInstanceOf(ImageUploadBatchError);
		expect(error.fromPage).toBe(3);
		expect(error.toPage).toBe(4);
		expect(error.cause).toBe(boom);
		expect(error.message).toBe("server exploded");
		// The committed prefix (batch 1 = pages 1..2) is surfaced so the caller can
		// resume or clean it up instead of orphaning those already-metered pages.
		expect(error.committed.committedFiles).toBe(2);
		expect(error.committed.imageIds).toEqual(["a.png", "b.png"]);
	});

	it("resumes from the committed prefix without re-uploading committed pages", async () => {
		const files = [
			file("a.png"),
			file("b.png"),
			file("c.png"),
			file("d.png"),
			file("e.png"),
		];
		// First attempt: fail on the 2nd batch (pages c,d).
		const firstAttemptBatches: string[][] = [];
		const error = await uploadImagesInBatches(
			files,
			async (batch) => {
				firstAttemptBatches.push(batch.map((item) => item.name));
				if (batch[0].name === "c.png") throw new Error("boom");
				return { imageIds: batch.map((item) => `${item.name}.id`) };
			},
			{ batchSize: 2 },
		).catch((e) => e);
		expect(error).toBeInstanceOf(ImageUploadBatchError);
		expect(firstAttemptBatches).toEqual([["a.png", "b.png"], ["c.png", "d.png"]]);
		expect(error.committed.committedFiles).toBe(2);

		// Retry resuming from the committed prefix: committed pages a,b must NOT be
		// re-uploaded (no double-metering); only c,d,e are sent this time.
		const retryBatches: string[][] = [];
		const result = await uploadImagesInBatches(
			files,
			async (batch) => {
				retryBatches.push(batch.map((item) => item.name));
				return { imageIds: batch.map((item) => `${item.name}.id`) };
			},
			{ batchSize: 2, resume: error.committed },
		);
		expect(retryBatches).toEqual([["c.png", "d.png"], ["e.png"]]);
		// The produced result is identical to an uninterrupted run (full ordered set).
		expect(result.imageIds).toEqual(files.map((item) => `${item.name}.id`));
	});

	it("does not re-fire onBatchStart for already-committed batches on resume", async () => {
		const files = [file("a.png"), file("b.png"), file("c.png"), file("d.png")];
		const starts: number[] = [];
		await uploadImagesInBatches(
			files,
			async (batch) => ({ imageIds: batch.map((item) => `${item.name}.id`) }),
			{
				batchSize: 2,
				resume: {
					imageIds: ["a.png.id", "b.png.id"],
					assets: [],
					committedFiles: 2,
				},
				onBatchStart: ({ batchIndex }) => starts.push(batchIndex),
			},
		);
		// Only the not-yet-committed batch (index 1) starts.
		expect(starts).toEqual([1]);
	});

	it("passes a stable per-batch idempotency key that is REUSED on resume", async () => {
		const files = [
			file("a.png"),
			file("b.png"),
			file("c.png"),
			file("d.png"),
			file("e.png"),
		];
		// First attempt: capture each batch's key; fail on the 2nd batch (pages c,d) —
		// AS IF its commit succeeded server-side but the response was lost.
		const firstKeys: Array<string | undefined> = [];
		const error = await uploadImagesInBatches(
			files,
			async (batch, _onProgress, batchKey) => {
				firstKeys.push(batchKey);
				if (batch[0].name === "c.png") throw new Error("lost response after commit");
				return { imageIds: batch.map((item) => `${item.name}.id`) };
			},
			{ batchSize: 2 },
		).catch((e) => e);
		expect(error).toBeInstanceOf(ImageUploadBatchError);
		// A key per ATTEMPTED batch (committed b1 + failed b2), both defined + unique.
		expect(firstKeys.length).toBe(2);
		expect(firstKeys[0]).toBeTruthy();
		expect(firstKeys[1]).toBeTruthy();
		expect(firstKeys[0]).not.toBe(firstKeys[1]);
		// The full planned key set rides along on the error for resume.
		expect(error.committed.batchKeys?.length).toBe(3);

		// Retry resuming from the committed prefix: the FAILED batch (pages c,d) must be
		// re-sent with the SAME key as the first attempt, so the server can replay its
		// (possibly lost-but-committed) result instead of duplicating it.
		const retryKeys: Array<string | undefined> = [];
		await uploadImagesInBatches(
			files,
			async (batch, _onProgress, batchKey) => {
				retryKeys.push(batchKey);
				return { imageIds: batch.map((item) => `${item.name}.id`) };
			},
			{ batchSize: 2, resume: error.committed },
		);
		// Retry sends the not-yet-committed batches: [c,d] then [e]. The [c,d] key MUST
		// equal the failed-batch key from attempt 1 (stable across retries of that batch).
		expect(retryKeys.length).toBe(2);
		expect(retryKeys[0]).toBe(firstKeys[1]);
		// The trailing [e] batch gets the same planned key it had in attempt 1's plan.
		expect(retryKeys[1]).toBe(error.committed.batchKeys?.[2]);
	});

	it("keeps a single oversized file in its own batch", async () => {
		const starts: string[][] = [];
		await uploadImagesInBatches(
			[new File(["aaaaaaaaaa"], "huge.png", { type: "image/png" })],
			async (batch) => {
				starts.push(batch.map((f) => f.name));
				return { imageIds: batch.map((f) => f.name) };
			},
			{ batchSize: 80, maxBatchBytes: 4 },
		);
		expect(starts).toEqual([["huge.png"]]);
	});
});
