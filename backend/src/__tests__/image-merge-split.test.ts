import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
	clampPerPage,
	clampSplitThreshold,
	groupForMerge,
	ImageTransformError,
	mergeImagesVertically,
	splitTallImage,
	DEFAULT_MERGE_PER_PAGE,
	MAX_MERGE_PER_PAGE,
	MIN_MERGE_PER_PAGE,
} from "../services/image-merge-split.js";

async function makeImage(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: color,
		},
	})
		.png()
		.toBuffer();
}

async function dims(buffer: Buffer): Promise<{ width: number; height: number }> {
	const meta = await sharp(buffer).metadata();
	return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("clampPerPage", () => {
	test("clamps below minimum and uses default for invalid input", () => {
		expect(clampPerPage(1)).toBe(MIN_MERGE_PER_PAGE);
		expect(clampPerPage(0)).toBe(MIN_MERGE_PER_PAGE);
		expect(clampPerPage(Number.NaN)).toBe(DEFAULT_MERGE_PER_PAGE);
		expect(clampPerPage(undefined)).toBe(DEFAULT_MERGE_PER_PAGE);
	});

	test("clamps above maximum and rounds", () => {
		expect(clampPerPage(9999)).toBe(MAX_MERGE_PER_PAGE);
		expect(clampPerPage(2.6)).toBe(3);
	});
});

describe("clampSplitThreshold", () => {
	test("defaults for invalid input and floors at 256", () => {
		expect(clampSplitThreshold(undefined)).toBe(5000);
		expect(clampSplitThreshold(0)).toBe(5000);
		expect(clampSplitThreshold(-10)).toBe(5000);
		expect(clampSplitThreshold(10)).toBe(256);
		expect(clampSplitThreshold(6000)).toBe(6000);
	});
});

describe("groupForMerge", () => {
	test("groups in order with remainder in final group", () => {
		expect(groupForMerge([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
	});

	test("clamps perPage when grouping", () => {
		// perPage=1 clamps to MIN (2)
		expect(groupForMerge([1, 2, 3], 1)).toEqual([[1, 2], [3]]);
	});
});

describe("mergeImagesVertically", () => {
	test("stitches images vertically at the median source width", async () => {
		const a = await makeImage(100, 60, { r: 255, g: 0, b: 0 });
		const b = await makeImage(80, 40, { r: 0, g: 255, b: 0 });
		const c = await makeImage(120, 60, { r: 0, g: 0, b: 255 });
		const result = await mergeImagesVertically([a, b, c]);
		// Median width is 100. The narrower image scales 80->100 (40->50);
		// the wider image scales 120->100 (60->50). Total height = 60 + 50 + 50.
		expect(result.width).toBe(100);
		expect(result.height).toBe(160);
		expect(result.sourceCount).toBe(3);
		const out = await dims(result.buffer);
		expect(out).toEqual({ width: 100, height: 160 });
	});

	test("uses the rounded average median width for an even number of sources", async () => {
		const a = await makeImage(80, 40, { r: 255, g: 0, b: 0 });
		const b = await makeImage(121, 60, { r: 0, g: 255, b: 0 });
		const result = await mergeImagesVertically([a, b]);
		// Median width for [80, 121] is 100.5, rounded to the nearest pixel.
		expect(result.width).toBe(101);
		expect(result.height).toBe(101);
		expect(result.sourceCount).toBe(2);
		const out = await dims(result.buffer);
		expect(out).toEqual({ width: 101, height: 101 });
	});

	test("single image is normalized to PNG and returned unchanged in dimensions", async () => {
		const a = await makeImage(120, 90, { r: 10, g: 20, b: 30 });
		const result = await mergeImagesVertically([a]);
		expect(result.width).toBe(120);
		expect(result.height).toBe(90);
		expect(result.sourceCount).toBe(1);
	});

	test("preserves vertical order (top pixel = first image color)", async () => {
		const top = await makeImage(40, 40, { r: 255, g: 0, b: 0 });
		const bottom = await makeImage(40, 40, { r: 0, g: 0, b: 255 });
		const result = await mergeImagesVertically([top, bottom]);
		const raw = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
		const channels = raw.info.channels;
		// Pixel at (0,0) is from the first (red) image.
		expect(raw.data[0]).toBeGreaterThan(200);
		expect(raw.data[2]).toBeLessThan(60);
		// Pixel near the bottom is from the second (blue) image.
		const lastRowStart = (result.height - 1) * result.width * channels;
		expect(raw.data[lastRowStart + 2]).toBeGreaterThan(200);
		expect(raw.data[lastRowStart]).toBeLessThan(60);
	});

	test("throws on empty input", async () => {
		await expect(mergeImagesVertically([])).rejects.toBeInstanceOf(ImageTransformError);
	});

	test("throws on undecodable input", async () => {
		await expect(mergeImagesVertically([Buffer.from("not an image")])).rejects.toBeInstanceOf(ImageTransformError);
	});

	test("rejects a merged canvas that would exceed the pixel ceiling before compositing", async () => {
		const a = await makeImage(100, 60, { r: 255, g: 0, b: 0 });
		const b = await makeImage(100, 60, { r: 0, g: 255, b: 0 });
		// Combined canvas is 100 × 120 = 12,000px; cap below that must reject.
		await expect(mergeImagesVertically([a, b], { maxOutputPixels: 10_000 })).rejects.toBeInstanceOf(ImageTransformError);
	});

	test("rejects an oversized single image before normalizing", async () => {
		const a = await makeImage(200, 200, { r: 0, g: 0, b: 0 });
		await expect(mergeImagesVertically([a], { maxOutputPixels: 10_000 })).rejects.toBeInstanceOf(ImageTransformError);
	});

	test("allows a merge within the pixel ceiling", async () => {
		const a = await makeImage(100, 60, { r: 255, g: 0, b: 0 });
		const b = await makeImage(100, 60, { r: 0, g: 255, b: 0 });
		const result = await mergeImagesVertically([a, b], { maxOutputPixels: 1_000_000 });
		expect(result.height).toBe(120);
	});
});

describe("splitTallImage", () => {
	test("returns single chunk when within threshold", async () => {
		const img = await makeImage(50, 400, { r: 0, g: 0, b: 0 });
		const chunks = await splitTallImage(img, { thresholdPx: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].height).toBe(400);
		expect(chunks[0].chunkIndex).toBe(0);
		expect(chunks[0].sourceY).toBe(0);
	});

	test("splits tall image into chunks with remainder in last chunk", async () => {
		const img = await makeImage(50, 1200, { r: 0, g: 0, b: 0 });
		const chunks = await splitTallImage(img, { thresholdPx: 500, maxChunkHeight: 500 });
		// 1200 / 500 -> 500, 500, 200
		expect(chunks.map((c) => c.height)).toEqual([500, 500, 200]);
		expect(chunks.map((c) => c.sourceY)).toEqual([0, 500, 1000]);
		expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
		for (const chunk of chunks) {
			const out = await dims(chunk.buffer);
			expect(out.width).toBe(50);
		}
	});

	test("total sliced height equals source height", async () => {
		const img = await makeImage(30, 1051, { r: 1, g: 2, b: 3 });
		const chunks = await splitTallImage(img, { thresholdPx: 400, maxChunkHeight: 400 });
		const total = chunks.reduce((sum, c) => sum + c.height, 0);
		expect(total).toBe(1051);
	});

	test("folds a too-small trailing remainder into the previous chunk", async () => {
		// 1020px at 500px chunks would naively be 500/500/20. With a 64px minimum,
		// the 20px runt must merge into the prior chunk -> 500/520, never a 20px page.
		const img = await makeImage(50, 1020, { r: 0, g: 0, b: 0 });
		const chunks = await splitTallImage(img, { thresholdPx: 500, maxChunkHeight: 500, minChunkHeight: 64 });
		expect(chunks.map((c) => c.height)).toEqual([500, 520]);
		expect(chunks.map((c) => c.sourceY)).toEqual([0, 500]);
		const total = chunks.reduce((sum, c) => sum + c.height, 0);
		expect(total).toBe(1020);
		for (const chunk of chunks) {
			expect(chunk.height).toBeGreaterThanOrEqual(64);
		}
	});

	test("keeps a healthy remainder as its own chunk", async () => {
		const img = await makeImage(50, 1200, { r: 0, g: 0, b: 0 });
		const chunks = await splitTallImage(img, { thresholdPx: 500, maxChunkHeight: 500, minChunkHeight: 64 });
		// 200px remainder is above the minimum, so it stays a standalone page.
		expect(chunks.map((c) => c.height)).toEqual([500, 500, 200]);
	});

	test("throws on undecodable input", async () => {
		await expect(splitTallImage(Buffer.from("nope"))).rejects.toBeInstanceOf(ImageTransformError);
	});

	test("clamps an oversized splitThreshold to the per-page ceiling instead of decoding the whole source", async () => {
		// DoS-guard regression test: a client sends a tall split source with a huge
		// splitThreshold so the height <= threshold branch would otherwise decode/
		// encode the WHOLE source in one buffer before per-page validation can 413 it.
		// With a pixelCeiling supplied, splitTallImage must clamp the effective chunk
		// height to the per-page ceiling and CHUNK the source — never produce a single
		// oversized chunk. We use a modest 200x2000 (0.4MP) source with a 0.05MP / 600px
		// ceiling as a stand-in for the real 1000x200000 / 60MP attack so the test stays
		// fast, but the code path (clamp-before-decode) is identical.
		const img = await makeImage(200, 2000, { r: 9, g: 9, b: 9 });
		const ceiling = { maxHeight: 600, maxPixels: 50_000 }; // 50_000/200 = 250px MP-cap
		const chunks = await splitTallImage(img, {
			thresholdPx: 99_999,
			maxChunkHeight: 99_999,
			minChunkHeight: 1,
			pixelCeiling: ceiling,
		});
		// More than one chunk -> the whole source was NOT decoded in a single buffer.
		expect(chunks.length).toBeGreaterThan(1);
		const total = chunks.reduce((sum, c) => sum + c.height, 0);
		expect(total).toBe(2000);
		for (const chunk of chunks) {
			// Every produced chunk respects BOTH the per-page height and MP caps.
			expect(chunk.height).toBeLessThanOrEqual(ceiling.maxHeight);
			expect(chunk.width * chunk.height).toBeLessThanOrEqual(ceiling.maxPixels);
		}
	});

	test("a real 800x40000 webtoon strip still imports and chunks under the per-page ceiling", async () => {
		// PR #332's webtoon import-and-split must keep working: a tall strip is accepted
		// (against the split-source ceiling, upstream) and chunked into per-page-bounded
		// pieces using the default threshold, with the per-page ceiling as the safety net.
		const { getUploadImagePixelCeiling, validateUploadedImageBuffer } = await import("../services/assets.js");
		const pageCeiling = getUploadImagePixelCeiling();
		const img = await makeImage(800, 40000, { r: 3, g: 4, b: 5 });
		const chunks = await splitTallImage(img, {
			thresholdPx: 5000,
			maxChunkHeight: 5000,
			minChunkHeight: 64,
			pixelCeiling: { maxHeight: pageCeiling.maxHeight, maxPixels: pageCeiling.maxPixels },
		});
		// 40000 / 5000 -> eight even 5000px chunks.
		expect(chunks).toHaveLength(8);
		const total = chunks.reduce((sum, c) => sum + c.height, 0);
		expect(total).toBe(40000);
		for (const chunk of chunks) {
			expect(chunk.height).toBeLessThanOrEqual(pageCeiling.maxHeight);
			expect(chunk.width * chunk.height).toBeLessThanOrEqual(pageCeiling.maxPixels);
			const out = await validateUploadedImageBuffer(chunk.buffer, "chunk.png");
			expect(out.width).toBe(800);
		}
	});

	test("a folded runt tail still respects the per-page MP ceiling", async () => {
		// When the trailing remainder is below minChunkHeight it is absorbed into the
		// prior chunk; the per-page clamp reserves headroom so the merged chunk never
		// exceeds the ceiling. 1010px source, ceiling chunk-height 250px, min 64px.
		const img = await makeImage(200, 1010, { r: 1, g: 1, b: 1 });
		const ceiling = { maxHeight: 600, maxPixels: 50_000 }; // 250px raw cap
		const chunks = await splitTallImage(img, {
			thresholdPx: 99_999,
			maxChunkHeight: 99_999,
			minChunkHeight: 64,
			pixelCeiling: ceiling,
		});
		const total = chunks.reduce((sum, c) => sum + c.height, 0);
		expect(total).toBe(1010);
		for (const chunk of chunks) {
			expect(chunk.width * chunk.height).toBeLessThanOrEqual(ceiling.maxPixels);
			expect(chunk.height).toBeGreaterThanOrEqual(64);
		}
	});

	test("split chunks of a tall webtoon strip each pass the per-page upload ceiling", async () => {
		// A 800x12000 (9.6 MP) strip is a stand-in for a long webtoon source. Split at
		// the default 5000px threshold -> chunks <= 5000px tall. Each chunk must be
		// accepted by the normal per-page validateUploadedImageBuffer (the /upload-
		// transform split path validates every produced chunk against this ceiling),
		// proving the looser SOURCE admission never yields oversized pages.
		const { validateUploadedImageBuffer, getUploadImagePixelCeiling } = await import("../services/assets.js");
		const img = await makeImage(800, 12000, { r: 5, g: 6, b: 7 });
		const chunks = await splitTallImage(img, { thresholdPx: 5000, maxChunkHeight: 5000 });
		expect(chunks.map((c) => c.height)).toEqual([5000, 5000, 2000]);
		const pageCeiling = getUploadImagePixelCeiling();
		for (const chunk of chunks) {
			expect(chunk.height).toBeLessThanOrEqual(pageCeiling.maxHeight);
			expect(chunk.width).toBeLessThanOrEqual(pageCeiling.maxWidth);
			const out = await validateUploadedImageBuffer(chunk.buffer, "chunk.png");
			expect(out.width).toBe(800);
			expect(out.height).toBe(chunk.height);
		}
	});
});
