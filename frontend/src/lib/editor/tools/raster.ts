// Image-edit suite v1 (W3.13) — shared rasterisation helpers.
//
// These pure-ish helpers bridge the tools and the canvas:
//  - sample the page background into a full image-space ImageData buffer,
//  - rasterise vector selection geometry (polygons, freehand paths, rects) into
//    a single-channel mask via an offscreen 2D context,
//  - composite a healed/cloned RGBA patch back into the full background and
//    produce a data URL the editor host can commit as a new working copy.
//
// All inputs/outputs are in IMAGE-SPACE (native pixel coordinates).

import type { ImagePoint } from "./types.js";

/**
 * Construct an ImageData from a single-channel-backed Uint8ClampedArray.
 * Centralised so the lib-version `ArrayBufferLike`/`ArrayBuffer` overload quirk
 * (also hit by the project's zip-writer) is handled in exactly one place.
 */
export function makeImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
	return new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height);
}

/** Create an offscreen canvas, preferring OffscreenCanvas where available. */
export function createWorkCanvas(width: number, height: number): HTMLCanvasElement {
	const canvas =
		typeof document !== "undefined"
			? document.createElement("canvas")
			: ({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement);
	canvas.width = Math.max(1, Math.floor(width));
	canvas.height = Math.max(1, Math.floor(height));
	return canvas;
}

/**
 * Draw the page background bitmap into a canvas at native pixel resolution and
 * return its ImageData. `source` is the Fabric image element in scene units; we
 * draw it 1:1 into an image-space buffer.
 */
export function readSourceImageData(
	source: CanvasImageSource | null,
	width: number,
	height: number,
): ImageData | null {
	if (!source) return null;
	const canvas = createWorkCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(source, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}

// FREEZE FIX (#6 / Fix C): the full-page draw + getImageData is a synchronous
// GPU→CPU readback + ~W·H·4 byte alloc (~48 MB on a 12 MP page) that blocks the
// main thread for hundreds of ms — paid on EVERY click of the whole-page clean
// tools (bubble-clean, etc.). The source raster does NOT change between clicks on
// the same page (cleans add non-destructive edit-LAYER overlays; the underlying
// source element is untouched), and the host bumps `getImageEpoch()` on any real
// source change (page nav / AI-result swap). So we cache the last read keyed by
// the epoch + dimensions and reuse it across clicks. Single entry is enough — a
// user edits one page at a time, and the epoch is a host-global monotonic counter
// so a hit always means the same source. Callers MUST treat the result as
// READ-ONLY (copy before mutating) — bubble-clean already does.
let cachedSourceRead:
	| { epoch: number; width: number; height: number; data: ImageData }
	| null = null;

export function readSourceImageDataCached(
	source: CanvasImageSource | null,
	width: number,
	height: number,
	epoch: number | undefined,
): ImageData | null {
	if (
		epoch !== undefined &&
		cachedSourceRead &&
		cachedSourceRead.epoch === epoch &&
		cachedSourceRead.width === width &&
		cachedSourceRead.height === height
	) {
		return cachedSourceRead.data;
	}
	const data = readSourceImageData(source, width, height);
	if (data && epoch !== undefined) {
		cachedSourceRead = { epoch, width, height, data };
	} else {
		cachedSourceRead = null;
	}
	return data;
}

/** Drop the cached source read (e.g. on teardown). Epoch keying already handles
 *  page/source changes; this is a belt-and-suspenders manual invalidation. */
export function invalidateSourceImageDataCache(): void {
	cachedSourceRead = null;
}

/** A native-pixel rectangle (top-left + size). Used for region-local tool work. */
export interface PixelRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Bounding box of the non-zero pixels in a single-channel mask, expanded by
 * `margin` and clamped to the image. Returns null when the mask is empty. Used so
 * heal/clone process only the STROKE REGION (+ margin) instead of the full 12 MP
 * page — the per-stroke compute is then proportional to the painted area.
 */
export function computeMaskBounds(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	margin = 0,
): PixelRegion | null {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (mask[row + x] > 0) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	const x0 = Math.max(0, minX - margin);
	const y0 = Math.max(0, minY - margin);
	const x1 = Math.min(width - 1, maxX + margin);
	const y1 = Math.min(height - 1, maxY + margin);
	return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Union of two regions (one may be null). Used to merge clone dest bboxes. */
export function unionRegion(a: PixelRegion | null, b: PixelRegion | null): PixelRegion | null {
	if (!a) return b;
	if (!b) return a;
	const x0 = Math.min(a.x, b.x);
	const y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.width, b.x + b.width);
	const y1 = Math.max(a.y + a.height, b.y + b.height);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Draw only a sub-rectangle of the page background into a native-resolution
 * buffer and return its ImageData. Far cheaper than {@link readSourceImageData}
 * for a small stroke region (the getImageData cost scales with region area).
 */
export function readSourceImageRegion(
	source: CanvasImageSource | null,
	region: PixelRegion,
	fullWidth: number,
	fullHeight: number,
): ImageData | null {
	if (!source) return null;
	const canvas = createWorkCanvas(region.width, region.height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	// Draw the full source positioned so the region's top-left maps to (0,0); the
	// small canvas crops it to the region.
	ctx.drawImage(source, -region.x, -region.y, fullWidth, fullHeight);
	return ctx.getImageData(0, 0, region.width, region.height);
}

/**
 * Slice a sub-rectangle of a full-image RGBA {@link ImageData} into a region-sized
 * ImageData (row-major copy). Used to recover the ORIGINAL pixels of a stroke region
 * for a revert when a non-destructive commit fails (no DOM/canvas needed).
 */
export function sliceImageDataRegion(base: ImageData, region: PixelRegion): ImageData {
	const out = new Uint8ClampedArray(region.width * region.height * 4);
	const src = base.data;
	for (let y = 0; y < region.height; y++) {
		const sy = region.y + y;
		for (let x = 0; x < region.width; x++) {
			const sx = region.x + x;
			const si = (sy * base.width + sx) * 4;
			const oi = (y * region.width + x) * 4;
			out[oi] = src[si];
			out[oi + 1] = src[si + 1];
			out[oi + 2] = src[si + 2];
			out[oi + 3] = src[si + 3];
		}
	}
	return makeImageData(out, region.width, region.height);
}

/** Crop a single-channel full-image mask down to `region` (row-major copy). */
export function cropMaskRegion(
	mask: Uint8ClampedArray,
	width: number,
	region: PixelRegion,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(region.width * region.height);
	for (let y = 0; y < region.height; y++) {
		const srcRow = (region.y + y) * width + region.x;
		const dstRow = y * region.width;
		for (let x = 0; x < region.width; x++) out[dstRow + x] = mask[srcRow + x];
	}
	return out;
}

/**
 * Pure-JS even-odd scanline polygon fill. Used as a deterministic fallback when
 * no functional 2D canvas context is available (e.g. headless CI without
 * node-canvas), so polygon/lasso rasterisation stays correct everywhere.
 * Pixel centres (x+0.5, y+0.5) are tested against the edge spans, matching the
 * even-odd interior the canvas path would produce.
 */
function scanlineFillPolygon(points: ImagePoint[], width: number, height: number, out: Uint8ClampedArray): void {
	const n = points.length;
	for (let y = 0; y < height; y++) {
		const yc = y + 0.5;
		const xs: number[] = [];
		for (let i = 0, j = n - 1; i < n; j = i++) {
			const yi = points[i].y;
			const yj = points[j].y;
			if (yi <= yc ? yj > yc : yj <= yc) {
				const t = (yc - yi) / (yj - yi);
				xs.push(points[i].x + t * (points[j].x - points[i].x));
			}
		}
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
			const x1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
			const row = y * width;
			for (let x = x0; x <= x1; x++) out[row + x] = 255;
		}
	}
}

/**
 * Rasterise a closed polygon (image-space points) into a single-channel mask of
 * the given dimensions. Prefers the 2D context's even-odd fill (fast, matches
 * Photoshop's polygon lasso for concave/self-intersecting shapes), and falls
 * back to a pure-JS scanline fill when no functional 2D context is available.
 */
export function rasterizePolygon(points: ImagePoint[], width: number, height: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height);
	if (points.length < 3) return out;
	const canvas = createWorkCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (ctx) {
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "#fff";
		ctx.beginPath();
		ctx.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
		ctx.closePath();
		ctx.fill("evenodd");
		const data = ctx.getImageData(0, 0, width, height).data;
		let any = false;
		for (let i = 0; i < out.length; i++) {
			const a = data[i * 4 + 3]; // alpha channel
			out[i] = a;
			if (a > 0) any = true;
		}
		// A degenerate/no-op canvas (headless context without raster backend)
		// returns an all-zero buffer; fall back to the pure-JS scanline fill so
		// the mask is correct regardless of the runtime canvas implementation.
		if (any) return out;
		out.fill(0);
	}
	scanlineFillPolygon(points, width, height, out);
	return out;
}

/**
 * Rasterise a freehand stroke (lasso) into a 1-bit mask. The path is filled as a
 * closed region (implicit close between last and first point).
 */
export function rasterizeFreehand(points: ImagePoint[], width: number, height: number): Uint8ClampedArray {
	return rasterizePolygon(points, width, height);
}

/** Rasterise an axis-aligned rectangle (image-space) into a single-channel mask. */
export function rasterizeRect(
	x: number,
	y: number,
	w: number,
	h: number,
	width: number,
	height: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height);
	const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
	const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
	const x1 = Math.min(width, Math.ceil(Math.max(x, x + w)));
	const y1 = Math.min(height, Math.ceil(Math.max(y, y + h)));
	for (let yy = y0; yy < y1; yy++) {
		const row = yy * width;
		for (let xx = x0; xx < x1; xx++) out[row + xx] = 255;
	}
	return out;
}

/** Stamp a soft round brush (alpha falloff) into a single-channel mask in place. */
export function stampSoftBrush(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	cx: number,
	cy: number,
	radius: number,
	hardness = 0.5,
	intensity = 255,
): void {
	if (radius <= 0) return;
	const r = Math.ceil(radius);
	const inner = radius * Math.min(Math.max(hardness, 0), 1);
	const x0 = Math.max(0, Math.floor(cx - r));
	const y0 = Math.max(0, Math.floor(cy - r));
	const x1 = Math.min(width - 1, Math.ceil(cx + r));
	const y1 = Math.min(height - 1, Math.ceil(cy + r));
	for (let yy = y0; yy <= y1; yy++) {
		for (let xx = x0; xx <= x1; xx++) {
			const d = Math.hypot(xx - cx, yy - cy);
			if (d > radius) continue;
			let a = 1;
			if (d > inner && radius > inner) a = 1 - (d - inner) / (radius - inner);
			const v = Math.round(a * intensity);
			const idx = yy * width + xx;
			if (v > mask[idx]) mask[idx] = v;
		}
	}
}

/**
 * Composite an RGBA patch into the full background ImageData, blending per the
 * mask alpha so feathered selections fade smoothly. `patch` and `mask` are full
 * image-space buffers (same dims as `base`).
 */
export function compositeMasked(
	base: ImageData,
	patch: Uint8ClampedArray,
	mask: Uint8ClampedArray,
): ImageData {
	const { width, height } = base;
	const out = makeImageData(new Uint8ClampedArray(base.data), width, height);
	const d = out.data;
	const n = width * height;
	for (let i = 0; i < n; i++) {
		const a = mask[i] / 255;
		if (a <= 0) continue;
		const o = i * 4;
		d[o] = d[o] * (1 - a) + patch[o] * a;
		d[o + 1] = d[o + 1] * (1 - a) + patch[o + 1] * a;
		d[o + 2] = d[o + 2] * (1 - a) + patch[o + 2] * a;
		// keep base alpha
	}
	return out;
}

/**
 * Composite a sub-REGION of an RGBA patch over the base, returning a small
 * ImageData sized to `region` (its top-left maps to region.x/region.y in image
 * space). `base`, `patch`, and `mask` are FULL image-space buffers; only the
 * region is read/written, so the per-stroke composite cost scales with the
 * painted area, not the whole page.
 */
export function compositeMaskedRegion(
	base: ImageData,
	patch: Uint8ClampedArray,
	mask: Uint8ClampedArray,
	region: PixelRegion,
): ImageData {
	const { width } = base;
	const baseData = base.data;
	const out = new Uint8ClampedArray(region.width * region.height * 4);
	for (let y = 0; y < region.height; y++) {
		const sy = region.y + y;
		for (let x = 0; x < region.width; x++) {
			const sx = region.x + x;
			const si = sy * width + sx; // single-channel index into mask
			const so = si * 4; // RGBA index into base/patch
			const oo = (y * region.width + x) * 4;
			const a = mask[si] / 255;
			if (a <= 0) {
				out[oo] = baseData[so];
				out[oo + 1] = baseData[so + 1];
				out[oo + 2] = baseData[so + 2];
				out[oo + 3] = baseData[so + 3];
				continue;
			}
			out[oo] = baseData[so] * (1 - a) + patch[so] * a;
			out[oo + 1] = baseData[so + 1] * (1 - a) + patch[so + 1] * a;
			out[oo + 2] = baseData[so + 2] * (1 - a) + patch[so + 2] * a;
			out[oo + 3] = baseData[so + 3];
		}
	}
	return makeImageData(out, region.width, region.height);
}

/** Render an ImageData buffer to a PNG data URL the editor can commit. */
export function imageDataToDataUrl(image: ImageData): string {
	const canvas = createWorkCanvas(image.width, image.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	ctx.putImageData(image, 0, 0);
	return canvas.toDataURL("image/png");
}

/**
 * Encode a canvas to a PNG blob WITHOUT blocking the main thread.
 *
 * `canvas.toDataURL()` runs the PNG encoder synchronously on the UI thread — on
 * a full-resolution manga page (e.g. 3000×4000 = 12 MP) that single call can
 * freeze the page for hundreds of milliseconds to seconds, which is exactly the
 * "เว็บค้าง" the heal/brush/clone tools were hitting on every stroke commit.
 *
 * `OffscreenCanvas.convertToBlob()` / `HTMLCanvasElement.toBlob()` hand the
 * encode to the browser's internal encoder (off the JS main thread), so the UI
 * stays responsive — the user can still scroll/cancel while the PNG is written.
 *
 * Returns a `blob:` object URL (accepted by the persistence layer just like a
 * `data:` URL). The caller owns the URL lifetime; the editor revokes it after
 * the working copy is loaded.
 */
export async function canvasToBlobUrl(
	canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<string> {
	const blob = await canvasToPngBlob(canvas);
	if (!blob) return "";
	return URL.createObjectURL(blob);
}

/** Async PNG-encode an ImageData buffer to a `blob:` URL (non-blocking). */
export async function imageDataToBlobUrl(image: ImageData): Promise<string> {
	const canvas = createWorkCanvas(image.width, image.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	ctx.putImageData(image, 0, 0);
	return canvasToBlobUrl(canvas);
}

/** Encode a canvas to a PNG Blob off the main thread, with sync fallbacks. */
export async function canvasToPngBlob(
	canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Blob | null> {
	// OffscreenCanvas (worker-thread encode where supported).
	const offscreen = canvas as OffscreenCanvas;
	if (typeof offscreen.convertToBlob === "function") {
		try {
			return await offscreen.convertToBlob({ type: "image/png" });
		} catch {
			// fall through to the HTMLCanvasElement path
		}
	}
	const htmlCanvas = canvas as HTMLCanvasElement;
	if (typeof htmlCanvas.toBlob === "function") {
		return await new Promise<Blob | null>((resolve) => {
			htmlCanvas.toBlob((blob) => resolve(blob), "image/png");
		});
	}
	// Last-resort fallback (jsdom/headless): synchronous data URL → Blob. This
	// path only runs where async encoding is unavailable, never in the browser.
	if (typeof htmlCanvas.toDataURL === "function") {
		const dataUrl = htmlCanvas.toDataURL("image/png");
		return dataUrlToBlob(dataUrl);
	}
	return null;
}

/**
 * Async PNG-encode a canvas to a `data:` URL WITHOUT a synchronous main-thread
 * encode. The PNG bytes are produced via the off-thread blob encoder, then read
 * into a data URL with FileReader. Use this where the resulting URL must outlive
 * a single load (e.g. undo/redo history) and so cannot be a revocable `blob:`
 * URL. Still far cheaper for the UI thread than `canvas.toDataURL()`.
 */
export async function canvasToDataUrlAsync(
	canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<string> {
	const blob = await canvasToPngBlob(canvas);
	if (!blob) return "";
	if (typeof FileReader === "function") {
		return await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
			reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
			reader.readAsDataURL(blob);
		});
	}
	// Headless fallback.
	const htmlCanvas = canvas as HTMLCanvasElement;
	return typeof htmlCanvas.toDataURL === "function" ? htmlCanvas.toDataURL("image/png") : "";
}

function dataUrlToBlob(dataUrl: string): Blob | null {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
	if (!match) return null;
	const mime = match[1] || "image/png";
	const isBase64 = !!match[2];
	const payload = match[3] ?? "";
	if (!isBase64) {
		return new Blob([decodeURIComponent(payload)], { type: mime });
	}
	if (typeof atob !== "function") return null;
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}
