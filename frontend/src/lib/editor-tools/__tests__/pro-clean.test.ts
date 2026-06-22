import { describe, expect, it } from "vitest";
import { proClean, type ProCleanImageDataLike, type ProCleanResult } from "../pro-clean.ts";

const W = 256;
const H = 256;
const MASK = { x0: 98, y0: 92, x1: 158, y1: 150 };
type Rgb = [number, number, number];

interface Fixture {
	image: ProCleanImageDataLike;
	original: Uint8ClampedArray;
	mask: Uint8Array;
}

function runTimed(name: string, fn: () => ProCleanResult): ProCleanResult {
	const start = performance.now();
	const result = fn();
	const ms = performance.now() - start;
	const label = `[pro-clean benchmark] ${name}: ${ms.toFixed(2)}ms`;
	if (ms > 80) console.warn(`${label} (soft target exceeded)`);
	else console.info(label);
	expect(ms).toBeLessThan(500);
	return result;
}

function makeMask(): Uint8Array {
	const mask = new Uint8Array(W * H);
	for (let y = MASK.y0; y <= MASK.y1; y++) {
		for (let x = MASK.x0; x <= MASK.x1; x++) mask[y * W + x] = 255;
	}
	return mask;
}

function makeFixture(fill: (x: number, y: number) => Rgb): Fixture {
	const original = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const [r, g, b] = fill(x, y);
			setRgb(original, x, y, r, g, b);
		}
	}
	const mask = makeMask();
	const data = new Uint8ClampedArray(original);
	paintSfxNoise(data, mask);
	return { image: { data, width: W, height: H }, original, mask };
}

function setRgb(data: Uint8ClampedArray, x: number, y: number, r: number, g: number, b: number): void {
	setRgbAt(data, W, x, y, r, g, b);
}

function setRgbAt(data: Uint8ClampedArray, width: number, x: number, y: number, r: number, g: number, b: number): void {
	const o = (y * width + x) * 4;
	data[o] = r;
	data[o + 1] = g;
	data[o + 2] = b;
	data[o + 3] = 255;
}

function makeImage(width: number, height: number, fill: (x: number, y: number) => Rgb): ProCleanImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = fill(x, y);
			setRgbAt(data, width, x, y, r, g, b);
		}
	}
	return { data, width, height };
}

function makeRectMask(width: number, height: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) mask[y * width + x] = 255;
	}
	return mask;
}

function makeFullMask(width: number, height: number): Uint8Array {
	const mask = new Uint8Array(width * height);
	mask.fill(255);
	return mask;
}

function paintSfxNoise(data: Uint8ClampedArray, mask: Uint8Array): void {
	for (let y = MASK.y0; y <= MASK.y1; y++) {
		for (let x = MASK.x0; x <= MASK.x1; x++) {
			const idx = y * W + x;
			if (mask[idx] === 0) continue;
			const stripe = (x + y * 2) % 17 < 8;
			const block = x > MASK.x0 + 12 && x < MASK.x1 - 10 && y > MASK.y0 + 14 && y < MASK.y1 - 12;
			const v = stripe || block ? 18 : 248;
			setRgb(data, x, y, v, v, v);
		}
	}
}

function luma(data: Uint8ClampedArray, idx: number): number {
	const o = idx * 4;
	return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
}

function meanAbsErrorInMask(a: Uint8ClampedArray, b: Uint8ClampedArray, mask: Uint8Array): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] === 0) continue;
		const o = i * 4;
		sum += Math.abs(a[o] - b[o]);
		sum += Math.abs(a[o + 1] - b[o + 1]);
		sum += Math.abs(a[o + 2] - b[o + 2]);
		n += 3;
	}
	return sum / Math.max(1, n);
}

function meanAbsErrorInSizedMask(a: Uint8ClampedArray, b: Uint8ClampedArray, mask: Uint8Array): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] === 0) continue;
		const o = i * 4;
		sum += Math.abs(a[o] - b[o]);
		sum += Math.abs(a[o + 1] - b[o + 1]);
		sum += Math.abs(a[o + 2] - b[o + 2]);
		n += 3;
	}
	return sum / Math.max(1, n);
}

function firstByteDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	if (a.length !== b.length) return Math.min(a.length, b.length);
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

function meanBoundaryLumaGap(data: Uint8ClampedArray, mask: Uint8Array, width: number, height: number): number {
	let sum = 0;
	let n = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if (mask[idx] === 0) continue;
			const here = luma(data, idx);
			const neighbors = [
				x > 0 ? idx - 1 : -1,
				x + 1 < width ? idx + 1 : -1,
				y > 0 ? idx - width : -1,
				y + 1 < height ? idx + width : -1,
			];
			for (const neighbor of neighbors) {
				if (neighbor < 0 || mask[neighbor] > 0) continue;
				sum += Math.abs(here - luma(data, neighbor));
				n++;
			}
		}
	}
	return sum / Math.max(1, n);
}

function lumaStdInMask(data: Uint8ClampedArray, mask: Uint8Array): number {
	let sum = 0;
	let sumSq = 0;
	let n = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] === 0) continue;
		const v = luma(data, i);
		sum += v;
		sumSq += v * v;
		n++;
	}
	const mean = sum / Math.max(1, n);
	return Math.sqrt(Math.max(0, sumSq / Math.max(1, n) - mean * mean));
}

function darkRatioInMask(data: Uint8ClampedArray, mask: Uint8Array, threshold: number): number {
	let dark = 0;
	let n = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] === 0) continue;
		if (luma(data, i) < threshold) dark++;
		n++;
	}
	return dark / Math.max(1, n);
}

describe("proClean", () => {
	it("is byte-for-byte deterministic for PatchMatch when reused with the same seed", () => {
		const fixture = makeFixture((x, y) => {
			const dot = ((x + 2) % 9 - 4) ** 2 + ((y + 5) % 9 - 4) ** 2 <= 7;
			const hatch = (x + y * 3) % 23 < 3;
			const tone = dot || hatch ? 58 : 228;
			return [tone, tone, tone];
		});
		const options = { strategy: "screentone" as const, seed: 0x51eed, patchMatchIterations: 4 };

		const first = runTimed("patchmatch deterministic first 256x256", () => proClean(fixture.image, fixture.mask, options));
		const second = runTimed("patchmatch deterministic second 256x256", () => proClean(fixture.image, fixture.mask, options));

		expect(first.strategy).toBe("screentone");
		expect(second.strategy).toBe("screentone");
		expect(firstByteDifference(first.imageData.data, second.imageData.data)).toBe(-1);
		expect(firstByteDifference(first.imageData.data, fixture.image.data as Uint8ClampedArray)).toBeGreaterThanOrEqual(0);
	});

	it("classifies flat paper and fills the mask with the boundary median", () => {
		const fixture = makeFixture(() => [242, 240, 236]);
		const result = runTimed("flat 256x256", () => proClean(fixture.image, fixture.mask, { seed: 10 }));

		expect(result.strategy).toBe("flat");
		expect(result.backgroundStrategy).toBe("flat");
		expect(result.classification.sampleCount).toBeGreaterThan(0);
		expect(meanAbsErrorInMask(result.imageData.data, fixture.original, fixture.mask)).toBeLessThan(1);
		expect(luma(result.imageData.data, 126 * W + 126)).toBeGreaterThan(235);
	});

	it("classifies a smooth gradient and reconstructs it with bounded Jacobi diffusion", () => {
		const fixture = makeFixture((x, y) => [
			Math.round(78 + x * 0.45),
			Math.round(102 + y * 0.28),
			Math.round(142 + x * 0.12 + y * 0.06),
		]);
		const result = runTimed("gradient 256x256", () => proClean(fixture.image, fixture.mask, { seed: 11 }));

		expect(result.strategy).toBe("gradient");
		expect(result.backgroundStrategy).toBe("gradient");
		expect(result.classification.gradientStrength).toBeGreaterThan(8);
		expect(meanAbsErrorInMask(result.imageData.data, fixture.original, fixture.mask)).toBeLessThan(9);
	});

	it("keeps gradient fills visually continuous at the mask boundary", () => {
		const fixture = makeFixture((x, y) => [
			Math.round(64 + x * 0.5),
			Math.round(86 + y * 0.34),
			Math.round(118 + x * 0.16 + y * 0.08),
		]);
		const result = runTimed("gradient seam 256x256", () => proClean(fixture.image, fixture.mask, {
			seed: 0x67ad,
			diffusionIterations: 64,
		}));

		expect(result.strategy).toBe("gradient");
		expect(meanBoundaryLumaGap(result.imageData.data, fixture.mask, W, H)).toBeLessThan(4);
		expect(meanAbsErrorInMask(result.imageData.data, fixture.original, fixture.mask)).toBeLessThan(8);
	});

	it("classifies screentone and preserves dot texture instead of flattening to gray", () => {
		const fixture = makeFixture((x, y) => {
			const cx = (x % 8) - 3.5;
			const cy = (y % 8) - 3.5;
			const dot = cx * cx + cy * cy <= 5;
			const tone = dot ? 72 : 238;
			return [tone, tone, tone];
		});
		const result = runTimed("screentone 256x256", () => proClean(fixture.image, fixture.mask, {
			seed: 12,
			patchMatchIterations: 3,
		}));

		expect(result.strategy).toBe("screentone");
		expect(result.backgroundStrategy).toBe("screentone");
		expect(result.classification.edgeEnergy).toBeGreaterThan(15);
		expect(lumaStdInMask(result.imageData.data, fixture.mask)).toBeGreaterThan(35);
		expect(darkRatioInMask(result.imageData.data, fixture.mask, 120)).toBeGreaterThan(0.08);
	});

	it("reconstructs a synthetic screentone dot field without erasing the dot cadence", () => {
		const fixture = makeFixture((x, y) => {
			const dotX = ((x + 3) % 8) - 3.5;
			const dotY = ((y + 1) % 8) - 3.5;
			const dot = dotX * dotX + dotY * dotY <= 5;
			const tone = dot ? 36 : 242;
			return [tone, tone, tone];
		});
		const result = runTimed("synthetic screentone 256x256", () => proClean(fixture.image, fixture.mask, {
			strategy: "screentone",
			seed: 0x7104,
			patchMatchIterations: 4,
		}));
		const darkRatio = darkRatioInMask(result.imageData.data, fixture.mask, 110);

		expect(result.strategy).toBe("screentone");
		expect(lumaStdInMask(result.imageData.data, fixture.mask)).toBeGreaterThan(30);
		expect(darkRatio).toBeGreaterThan(0.08);
		expect(darkRatio).toBeLessThan(0.4);
	});

	it("detects a crossing manga line and continues it through the cleaned mask", () => {
		const fixture = makeFixture((x, y) => {
			const onLine = Math.abs(y - x) <= 1;
			return onLine ? [18, 18, 18] : [246, 244, 240];
		});
		const result = runTimed("line 256x256", () => proClean(fixture.image, fixture.mask, { seed: 13 }));

		expect(result.strategy).toBe("line");
		expect(result.backgroundStrategy).toBe("flat");
		expect(result.classification.lineDetected).toBe(true);
		let lineDark = 0;
		let lineTotal = 0;
		for (let x = MASK.x0 + 8; x <= MASK.x1 - 8; x++) {
			const idx = x * W + x;
			if (fixture.mask[idx] === 0) continue;
			if (luma(result.imageData.data, idx) < 80) lineDark++;
			lineTotal++;
		}
		expect(lineDark / Math.max(1, lineTotal)).toBeGreaterThan(0.85);
		expect(luma(result.imageData.data, 128 * W + 118)).toBeGreaterThan(225);
	});

	it("cleans a mask touching the image edge without changing unmasked pixels", () => {
		const width = 96;
		const height = 80;
		const image = makeImage(width, height, (x, y) => {
			const dot = (x % 7 - 3) ** 2 + (y % 7 - 3) ** 2 <= 4;
			const base = dot ? 80 : 236;
			return [base, base, base];
		});
		const original = new Uint8ClampedArray(image.data);
		const mask = makeRectMask(width, height, 0, 18, 24, 54);
		for (let y = 18; y <= 54; y++) {
			for (let x = 0; x <= 24; x++) {
				const stripe = (x * 2 + y) % 13 < 6;
				const v = stripe ? 12 : 252;
				setRgbAt(image.data as Uint8ClampedArray, width, x, y, v, v, v);
			}
		}
		const result = runTimed("edge mask screentone 96x80", () => proClean(image, mask, {
			strategy: "screentone",
			seed: 0xed9e,
			patchMatchIterations: 3,
		}));

		expect(result.strategy).toBe("screentone");
		expect(result.bounds).toEqual({ x: 0, y: 18, width: 25, height: 37 });
		for (let i = 0; i < mask.length; i++) {
			if (mask[i] > 0) continue;
			const o = i * 4;
			expect([...result.imageData.data.slice(o, o + 4)]).toEqual([...original.slice(o, o + 4)]);
		}
		expect(meanAbsErrorInSizedMask(result.imageData.data, original, mask)).toBeLessThan(120);
	});

	it("handles a full-image mask by falling back cleanly when no source ring exists", () => {
		const width = 24;
		const height = 18;
		const image = makeImage(width, height, () => [255, 255, 255]);
		const result = proClean(image, makeFullMask(width, height), { seed: 0xf011 });

		expect(result.strategy).toBe("flat");
		expect(result.bounds).toEqual({ x: 0, y: 0, width, height });
		expect(result.classification.sampleCount).toBe(0);
		expect(result.limitations).toContain("No source ring pixels were available; used white median fallback.");
		expect(firstByteDifference(result.imageData.data, image.data as Uint8ClampedArray)).toBe(-1);
	});

	it("keeps a one-color image exactly the same color inside the cleaned mask", () => {
		const width = 80;
		const height = 72;
		const image = makeImage(width, height, () => [137, 151, 166]);
		const original = new Uint8ClampedArray(image.data);
		const mask = makeRectMask(width, height, 20, 17, 56, 51);
		const result = proClean(image, mask, { seed: 0x5011d });

		expect(result.strategy).toBe("flat");
		expect(meanAbsErrorInSizedMask(result.imageData.data, original, mask)).toBe(0);
		expect(firstByteDifference(result.imageData.data, original)).toBe(-1);
	});

	it("returns an unchanged copy for an empty mask", () => {
		const data = new Uint8ClampedArray(W * H * 4);
		for (let i = 0; i < W * H; i++) {
			const o = i * 4;
			data[o] = 1;
			data[o + 1] = 2;
			data[o + 2] = 3;
			data[o + 3] = 255;
		}
		const result = proClean({ data, width: W, height: H }, new Uint8Array(W * H));

		expect(result.strategy).toBe("none");
		expect(result.bounds).toBeNull();
		expect([...result.imageData.data.slice(0, 12)]).toEqual([...data.slice(0, 12)]);
		expect(result.imageData.data).not.toBe(data);
	});

	it("throws on a mask with the wrong dimensions", () => {
		const fixture = makeFixture(() => [255, 255, 255]);
		expect(() => proClean(fixture.image, new Uint8Array(12))).toThrow(/mask length/);
	});

	it("records a limitation when forced line continuation has no anchors", () => {
		const fixture = makeFixture(() => [244, 244, 244]);
		const result = proClean(fixture.image, fixture.mask, { strategy: "line", seed: 14 });

		expect(result.strategy).toBe("screentone");
		expect(result.limitations.some((item) => item.includes("Line continuation"))).toBe(true);
		expect(meanAbsErrorInMask(result.imageData.data, fixture.original, fixture.mask)).toBeLessThan(2);
	});
});
