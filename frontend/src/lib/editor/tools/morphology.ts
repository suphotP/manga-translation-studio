// Tool 6 (core) — mask morphology: Grow / Contract / Feather / Refine Edge.
//
// Two implementations:
//   1. Pure JS (default, testable headless) — separable box dilate/erode +
//      separable Gaussian-ish blur on the mask alpha.
//   2. OpenCV.js morphologyEx + GaussianBlur (used when cv is already loaded),
//      faster + matches Photoshop's "Refine Edge" math more closely.
//
// All operate on a single-channel image-space mask (Uint8ClampedArray).

import { isOpenCvReady, loadOpenCv, type OpenCvModule } from "./opencv-loader.js";

export type MorphologyOp = "grow" | "contract" | "feather";

/** Pure-JS binary dilate by `radius` px (chebyshev/square structuring element). */
export function dilateMask(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray {
	return morphPass(mask, width, height, radius, true);
}

/** Pure-JS binary erode by `radius` px. */
export function erodeMask(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray {
	return morphPass(mask, width, height, radius, false);
}

// Separable square-kernel morphology. dilate => max over window; erode => min.
function morphPass(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
	dilate: boolean,
): Uint8ClampedArray {
	const r = Math.max(0, Math.round(radius));
	if (r === 0) return mask.slice();
	const tmp = new Uint8ClampedArray(width * height);
	const out = new Uint8ClampedArray(width * height);
	const pick = dilate ? Math.max : Math.min;
	// Horizontal pass
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			let v = dilate ? 0 : 255;
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(width - 1, x + r);
			for (let xx = x0; xx <= x1; xx++) v = pick(v, mask[row + xx]);
			tmp[row + x] = v;
		}
	}
	// Vertical pass
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let v = dilate ? 0 : 255;
			const y0 = Math.max(0, y - r);
			const y1 = Math.min(height - 1, y + r);
			for (let yy = y0; yy <= y1; yy++) v = pick(v, tmp[yy * width + x]);
			out[y * width + x] = v;
		}
	}
	return out;
}

/** Pure-JS separable box blur (Feather) applied `passes` times to approximate Gaussian. */
export function featherMask(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
	passes = 3,
): Uint8ClampedArray {
	const r = Math.max(0, Math.round(radius));
	if (r === 0) return mask.slice();
	let src = mask.slice();
	const tmp = new Uint8ClampedArray(width * height);
	const win = r * 2 + 1;
	for (let p = 0; p < passes; p++) {
		// Horizontal
		for (let y = 0; y < height; y++) {
			const row = y * width;
			let sum = 0;
			for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, width - 1)];
			for (let x = 0; x < width; x++) {
				tmp[row + x] = Math.round(sum / win);
				const add = src[row + clamp(x + r + 1, 0, width - 1)];
				const sub = src[row + clamp(x - r, 0, width - 1)];
				sum += add - sub;
			}
		}
		// Vertical
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, height - 1) * width + x];
			for (let y = 0; y < height; y++) {
				src[y * width + x] = Math.round(sum / win);
				const add = tmp[clamp(y + r + 1, 0, height - 1) * width + x];
				const sub = tmp[clamp(y - r, 0, height - 1) * width + x];
				sum += add - sub;
			}
		}
	}
	return src;
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Apply a morphology op to a mask. Uses OpenCV when already loaded, else pure JS.
 * `feather` always runs a JS/cv blur after grow/contract for the "Refine Edge"
 * combination. `radius` is in image pixels.
 */
export function applyMorphology(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	op: MorphologyOp,
	radius: number,
	cv?: OpenCvModule,
): Uint8ClampedArray {
	if (cv?.Mat) return applyMorphologyCv(mask, width, height, op, radius, cv);
	switch (op) {
		case "grow":
			return dilateMask(mask, width, height, radius);
		case "contract":
			return erodeMask(mask, width, height, radius);
		case "feather":
			return featherMask(mask, width, height, radius);
	}
}

function applyMorphologyCv(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	op: MorphologyOp,
	radius: number,
	cv: OpenCvModule,
): Uint8ClampedArray {
	const r = Math.max(1, Math.round(radius));
	const src = cv.matFromArray(height, width, cv.CV_8UC1, mask);
	const dst = new cv.Mat();
	try {
		if (op === "feather") {
			const k = r * 2 + 1;
			cv.GaussianBlur(src, dst, new cv.Size(k, k), 0, 0);
		} else {
			const ksize = new cv.Size(r * 2 + 1, r * 2 + 1);
			const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, ksize);
			const morphOp = op === "grow" ? cv.MORPH_DILATE : cv.MORPH_ERODE;
			cv.morphologyEx(src, dst, morphOp, kernel);
			kernel.delete();
		}
		const out = new Uint8ClampedArray(width * height);
		out.set(dst.data.subarray(0, width * height));
		return out;
	} finally {
		src.delete();
		dst.delete();
	}
}

/** Ensure OpenCV is available for accelerated morphology (used by the tool). */
export async function ensureMorphologyBackend(): Promise<OpenCvModule | undefined> {
	if (isOpenCvReady()) return loadOpenCv();
	try {
		return await loadOpenCv();
	} catch {
		return undefined; // graceful: pure-JS fallback handles it
	}
}
