import { describe, expect, it } from "vitest";
import { healRegion, type BoundsRect, type ImageDataLike } from "$lib/editor-tools/healing-patch.ts";

function makeImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			const [r, g, b, a] = pixel(x, y);
			data[offset] = r;
			data[offset + 1] = g;
			data[offset + 2] = b;
			data[offset + 3] = a;
		}
	}
	return { width, height, data };
}

function rectMask(width: number, height: number, rect: BoundsRect): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = rect.y; y < rect.y + rect.height; y++) {
		for (let x = rect.x; x < rect.x + rect.width; x++) mask[y * width + x] = 255;
	}
	return mask;
}

function maskIndices(mask: Uint8Array): number[] {
	const indices: number[] = [];
	for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) indices.push(i);
	return indices;
}

function contextRingIndices(mask: Uint8Array, width: number, height: number, bounds: BoundsRect, radius: number): number[] {
	const indices: number[] = [];
	const x0 = Math.max(0, bounds.x - radius);
	const y0 = Math.max(0, bounds.y - radius);
	const x1 = Math.min(width - 1, bounds.x + bounds.width + radius - 1);
	const y1 = Math.min(height - 1, bounds.y + bounds.height + radius - 1);
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const i = y * width + x;
			if (mask[i] !== 0) continue;
			indices.push(i);
		}
	}
	return indices;
}

function lumaAt(image: ImageDataLike, pixelIndex: number): number {
	const offset = pixelIndex * 4;
	return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}

function histogram(image: ImageDataLike, indices: number[]): [number, number, number] {
	const bins: [number, number, number] = [0, 0, 0];
	for (const index of indices) {
		const y = lumaAt(image, index);
		if (y < 85) bins[0] += 1;
		else if (y > 170) bins[2] += 1;
		else bins[1] += 1;
	}
	const total = Math.max(1, indices.length);
	return [bins[0] / total, bins[1] / total, bins[2] / total];
}

function histogramDistance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

describe("healRegion smooth fill", () => {
	it("continues a punched gradient through the masked region with low error", () => {
		const width = 80;
		const height = 52;
		const image = makeImage(width, height, (x, y) => {
			const value = 32 + x * 1.9 + y * 0.65;
			return [value, value + 4, value + 8, 255];
		});
		const expected = image.data.slice();
		const bounds = { x: 30, y: 18, width: 18, height: 14 };
		const mask = rectMask(width, height, bounds);
		const beforeDamaged = image.data.slice();
		for (const pixelIndex of maskIndices(mask)) {
			const offset = pixelIndex * 4;
			image.data[offset] = 245;
			image.data[offset + 1] = 245;
			image.data[offset + 2] = 245;
		}

		const result = healRegion(image, mask, { method: "smooth" });

		expect(result.applied).toEqual(bounds);
		let absoluteError = 0;
		let samples = 0;
		for (const pixelIndex of maskIndices(mask)) {
			const offset = pixelIndex * 4;
			for (let channel = 0; channel < 3; channel++) {
				absoluteError += Math.abs(image.data[offset + channel] - expected[offset + channel]);
				samples += 1;
			}
		}
		expect(absoluteError / samples).toBeLessThan(1.6);

		for (let i = 0; i < mask.length; i++) {
			if (mask[i] !== 0) continue;
			const offset = i * 4;
			expect([...image.data.slice(offset, offset + 4)]).toEqual([...beforeDamaged.slice(offset, offset + 4)]);
		}
	});
});

describe("healRegion texture fill", () => {
	it("uses auto texture mode on screentone dots and keeps the filled histogram close to the surrounding ring", () => {
		const width = 72;
		const height = 72;
		const image = makeImage(width, height, (x, y) => {
			const dot = x % 6 <= 1 && y % 6 <= 1;
			const value = dot ? 28 : 228;
			return [value, value, value, 255];
		});
		const bounds = { x: 24, y: 22, width: 24, height: 24 };
		const mask = rectMask(width, height, bounds);
		const surrounding = histogram(image, contextRingIndices(mask, width, height, bounds, 8));
		for (const pixelIndex of maskIndices(mask)) {
			const offset = pixelIndex * 4;
			image.data[offset] = 128;
			image.data[offset + 1] = 128;
			image.data[offset + 2] = 128;
		}

		const result = healRegion(image, mask, {
			method: "auto",
			textureSeed: 0x51f15e,
			texturePatchSize: 7,
			contextRadius: 12,
		});

		expect(result.applied).toEqual(bounds);
		const filled = histogram(image, maskIndices(mask));
		expect(histogramDistance(filled, surrounding)).toBeLessThan(0.22);
		expect(filled[1]).toBeLessThan(0.08);
	});
});

describe("healRegion edge cases", () => {
	it("returns null and preserves data for an empty mask", () => {
		const image = makeImage(6, 5, (x, y) => [x * 10, y * 10, 30, 255]);
		const before = image.data.slice();

		const result = healRegion(image, new Uint8Array(6 * 5));

		expect(result.applied).toBeNull();
		expect([...image.data]).toEqual([...before]);
	});

	it("returns null when the whole image is masked and no surrounding context exists", () => {
		const image = makeImage(4, 4, () => [80, 90, 100, 255]);
		const before = image.data.slice();
		const result = healRegion(image, new Uint8Array(4 * 4).fill(255), { method: "texture" });

		expect(result.applied).toBeNull();
		expect([...image.data]).toEqual([...before]);
	});

	it("throws on mismatched mask or RGBA buffer sizes", () => {
		const image = makeImage(3, 3, () => [0, 0, 0, 255]);
		expect(() => healRegion(image, new Uint8Array(8))).toThrow(RangeError);
		expect(() =>
			healRegion({ width: 3, height: 3, data: new Uint8ClampedArray(3 * 3 * 3) }, new Uint8Array(9)),
		).toThrow(RangeError);
	});

	it("heals a one-pixel edge mask without touching unrelated pixels", () => {
		const image = makeImage(5, 5, (x, y) => [80 + x * 8 + y * 3, 82 + x * 8 + y * 3, 84 + x * 8 + y * 3, 255]);
		const before = image.data.slice();
		const mask = new Uint8Array(25);
		mask[0] = 255;
		image.data[0] = 255;
		image.data[1] = 0;
		image.data[2] = 255;

		const result = healRegion(image, mask, { method: "smooth", smoothIterations: 32 });

		expect(result.applied).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(Math.abs(image.data[0] - before[0])).toBeLessThan(18);
		for (let i = 1; i < mask.length; i++) {
			const offset = i * 4;
			expect([...image.data.slice(offset, offset + 4)]).toEqual([...before.slice(offset, offset + 4)]);
		}
	});
});
