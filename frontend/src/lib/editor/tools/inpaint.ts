// Tool 7 (core) — OpenCV.js Telea inpaint wrapper.
//
// Given the source RGBA ImageData and a single-channel heal mask (>0 = heal),
// run cv.inpaint(Telea) and return a new RGBA ImageData with the masked region
// reconstructed from surrounding pixels. All Mats are released to avoid the
// classic OpenCV.js wasm-heap leak.

import type { OpenCvModule } from "./opencv-loader.js";
import { makeImageData } from "./raster.js";

/**
 * Inpaint the masked region of `source` using Telea's fast marching method.
 * `mask` is a full image-space single-channel buffer (0 = keep, >0 = heal).
 */
export function inpaintTelea(
	cv: OpenCvModule,
	source: ImageData,
	mask: Uint8ClampedArray,
	radius = 3,
): ImageData {
	const { width, height } = source;
	const rgba = cv.matFromImageData(source);
	const rgb = new cv.Mat();
	const maskMat = cv.matFromArray(height, width, cv.CV_8UC1, binarize(mask));
	const dst = new cv.Mat();
	try {
		cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
		cv.inpaint(rgb, maskMat, dst, Math.max(1, radius), cv.INPAINT_TELEA);
		// dst is 3-channel RGB; lift back to RGBA preserving original alpha.
		const out = new Uint8ClampedArray(source.data); // copy of source (keeps alpha)
		const d = dst.data; // length = width*height*3
		const n = width * height;
		for (let i = 0; i < n; i++) {
			const o = i * 4;
			const t = i * 3;
			out[o] = d[t];
			out[o + 1] = d[t + 1];
			out[o + 2] = d[t + 2];
		}
		return makeImageData(out, width, height);
	} finally {
		rgba.delete();
		rgb.delete();
		maskMat.delete();
		dst.delete();
	}
}

/** OpenCV inpaint wants a strict 0/255 mask. */
function binarize(mask: Uint8ClampedArray): Uint8ClampedArray {
	const out = new Uint8ClampedArray(mask.length);
	for (let i = 0; i < mask.length; i++) out[i] = mask[i] > 0 ? 255 : 0;
	return out;
}
