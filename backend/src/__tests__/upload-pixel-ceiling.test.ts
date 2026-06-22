import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
	getSplitSourcePixelCeiling,
	getUploadImagePixelCeiling,
	UploadedImageDecodeError,
	UploadedImageTooLargeError,
	validateUploadedImageBuffer,
} from "../services/assets.js";

// Build a small real image; the megapixel/width/height ceiling is driven by env
// overrides so the test never has to allocate a multi-gigapixel buffer.
async function makeImage(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

const ENV_KEYS = [
	"MAX_UPLOAD_IMAGE_WIDTH",
	"MAX_UPLOAD_IMAGE_HEIGHT",
	"MAX_UPLOAD_IMAGE_MEGAPIXELS",
	"MAX_UPLOAD_SPLIT_SOURCE_HEIGHT",
	"MAX_UPLOAD_SPLIT_SOURCE_MEGAPIXELS",
] as const;

describe("upload pixel ceiling (decompression-bomb DoS guard)", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	test("getUploadImagePixelCeiling defaults are generous (>= 30000px wide / >= 100000px tall / 60 MP)", () => {
		const ceiling = getUploadImagePixelCeiling();
		expect(ceiling.maxWidth).toBeGreaterThanOrEqual(30000);
		// Height cap must be tall enough for real webtoon strips (40000px+ is normal).
		expect(ceiling.maxHeight).toBeGreaterThanOrEqual(100000);
		expect(ceiling.maxPixels).toBeGreaterThanOrEqual(60_000_000);
	});

	test("a real narrow tall webtoon strip (800x40000, ~32 MP) is ACCEPTED at default ceiling", async () => {
		// 800 x 40000 = 32 MP, under the 60 MP cap and under the 100000px height cap.
		// This is the regression case: it was rejected purely on height under the old
		// 30000px default.
		const buf = await makeImage(800, 40000);
		const dims = await validateUploadedImageBuffer(buf, "webtoon.png");
		expect(dims).toEqual({ width: 800, height: 40000 });
	});

	test("a real megapixel bomb is still REJECTED even at the generous height default", async () => {
		// Simulate a 50000x50000 (2500 MP) bomb via a small MP override; the point is
		// the MP cap (not the height cap) catches it. Use a real square that trips a
		// low MP cap while staying under the height cap.
		process.env.MAX_UPLOAD_IMAGE_MEGAPIXELS = "1";
		const buf = await makeImage(2000, 2000); // 4 MP > 1 MP cap
		await expect(validateUploadedImageBuffer(buf, "bomb.png")).rejects.toBeInstanceOf(UploadedImageTooLargeError);
	});

	test("env overrides tune the ceiling (operator-configurable)", () => {
		process.env.MAX_UPLOAD_IMAGE_WIDTH = "1000";
		process.env.MAX_UPLOAD_IMAGE_HEIGHT = "2000";
		process.env.MAX_UPLOAD_IMAGE_MEGAPIXELS = "1";
		const ceiling = getUploadImagePixelCeiling();
		expect(ceiling).toEqual({ maxWidth: 1000, maxHeight: 2000, maxPixels: 1_000_000 });
	});

	test("a normal tall webtoon page (within ceiling) is accepted", async () => {
		// 1200 x 8000 = 9.6 MP, well under the 60 MP default — must pass.
		const buf = await makeImage(1200, 8000);
		const dims = await validateUploadedImageBuffer(buf, "page.png");
		expect(dims).toEqual({ width: 1200, height: 8000 });
	});

	test("an image over the megapixel cap is rejected with UploadedImageTooLargeError", async () => {
		// Drop the MP cap to ~0.5 MP so a modest 1000x1000 (1 MP) image trips it
		// without allocating a real bomb.
		process.env.MAX_UPLOAD_IMAGE_MEGAPIXELS = "0.5";
		const buf = await makeImage(1000, 1000);
		await expect(validateUploadedImageBuffer(buf, "bomb.png")).rejects.toBeInstanceOf(UploadedImageTooLargeError);
		try {
			await validateUploadedImageBuffer(buf, "bomb.png");
		} catch (error) {
			expect(error).toBeInstanceOf(UploadedImageTooLargeError);
			const e = error as UploadedImageTooLargeError;
			expect(e.width).toBe(1000);
			expect(e.height).toBe(1000);
			expect(e.megapixels).toBeCloseTo(1, 5);
		}
	});

	test("an image over the single-side WIDTH cap is rejected even when total MP is small", async () => {
		process.env.MAX_UPLOAD_IMAGE_WIDTH = "500";
		// 600 x 100 = 0.06 MP (tiny total) but width 600 > 500 cap → must reject.
		const buf = await makeImage(600, 100);
		await expect(validateUploadedImageBuffer(buf, "wide.png")).rejects.toBeInstanceOf(UploadedImageTooLargeError);
	});

	test("an image over the single-side HEIGHT cap is rejected even when total MP is small", async () => {
		process.env.MAX_UPLOAD_IMAGE_HEIGHT = "500";
		const buf = await makeImage(100, 600);
		await expect(validateUploadedImageBuffer(buf, "tall.png")).rejects.toBeInstanceOf(UploadedImageTooLargeError);
	});

	test("an exactly-at-ceiling image is accepted (boundary is inclusive)", async () => {
		process.env.MAX_UPLOAD_IMAGE_WIDTH = "1000";
		process.env.MAX_UPLOAD_IMAGE_HEIGHT = "1000";
		process.env.MAX_UPLOAD_IMAGE_MEGAPIXELS = "1";
		const buf = await makeImage(1000, 1000); // exactly 1 MP, exactly at side caps
		const dims = await validateUploadedImageBuffer(buf, "edge.png");
		expect(dims).toEqual({ width: 1000, height: 1000 });
	});

	test("a non-decodable buffer still throws the decode error (not the size error)", async () => {
		const garbage = Buffer.from("not an image at all", "utf8");
		await expect(validateUploadedImageBuffer(garbage, "junk.txt")).rejects.toBeInstanceOf(UploadedImageDecodeError);
	});

	test("an explicit ceiling argument overrides the default for validation", async () => {
		// 800 x 40000 (32 MP) would pass the default, but a tight per-page ceiling
		// rejects it on height — confirming the override param drives the check.
		const buf = await makeImage(800, 40000);
		const tight = { maxWidth: 30000, maxHeight: 30000, maxPixels: 60_000_000 };
		await expect(validateUploadedImageBuffer(buf, "strip.png", tight)).rejects.toBeInstanceOf(UploadedImageTooLargeError);
	});
});

describe("split-source pixel ceiling (looser admission for webtoon strips to be split)", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	test("defaults are taller + higher-MP than the per-page ceiling", () => {
		const page = getUploadImagePixelCeiling();
		const split = getSplitSourcePixelCeiling();
		expect(split.maxHeight).toBeGreaterThanOrEqual(page.maxHeight);
		expect(split.maxHeight).toBeGreaterThanOrEqual(200000);
		expect(split.maxPixels).toBeGreaterThanOrEqual(page.maxPixels);
		expect(split.maxPixels).toBeGreaterThanOrEqual(200_000_000);
		// Width is shared (a strip is narrow by definition).
		expect(split.maxWidth).toBe(page.maxWidth);
	});

	test("a very tall split-source strip the per-page ceiling would reject is accepted under the split ceiling", async () => {
		// 800 x 120000 = 96 MP: over the 60 MP per-page cap AND over the 100000px
		// per-page height cap, but under the split-source 200 MP / 200000px caps.
		const buf = await makeImage(800, 120000);
		await expect(validateUploadedImageBuffer(buf, "long.png")).rejects.toBeInstanceOf(UploadedImageTooLargeError);
		const dims = await validateUploadedImageBuffer(buf, "long.png", getSplitSourcePixelCeiling());
		expect(dims).toEqual({ width: 800, height: 120000 });
	});

	test("a real bomb is still rejected even under the looser split-source ceiling", async () => {
		// MP cap remains the bomb guard. The split MP cap is never lower than the
		// per-page cap (Math.max), so lower BOTH to prove the rejection path without
		// allocating a giant buffer.
		process.env.MAX_UPLOAD_IMAGE_MEGAPIXELS = "1";
		process.env.MAX_UPLOAD_SPLIT_SOURCE_MEGAPIXELS = "1";
		const buf = await makeImage(2000, 2000); // 4 MP > 1 MP split cap
		await expect(validateUploadedImageBuffer(buf, "bomb.png", getSplitSourcePixelCeiling())).rejects.toBeInstanceOf(
			UploadedImageTooLargeError,
		);
	});

	test("split-source height never drops below the per-page height cap", () => {
		process.env.MAX_UPLOAD_IMAGE_HEIGHT = "150000";
		process.env.MAX_UPLOAD_SPLIT_SOURCE_HEIGHT = "50000"; // intentionally below per-page
		const split = getSplitSourcePixelCeiling();
		expect(split.maxHeight).toBe(150000);
	});

	test("env overrides tune the split-source ceiling", () => {
		process.env.MAX_UPLOAD_SPLIT_SOURCE_HEIGHT = "300000";
		process.env.MAX_UPLOAD_SPLIT_SOURCE_MEGAPIXELS = "400";
		const split = getSplitSourcePixelCeiling();
		expect(split.maxHeight).toBe(300000);
		expect(split.maxPixels).toBe(400_000_000);
	});
});
