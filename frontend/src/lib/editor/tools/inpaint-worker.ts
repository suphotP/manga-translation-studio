// Rec #2 — OpenCV.js Telea inpaint, OFF the main thread.
//
// This module is the Web Worker entry point. The main thread (via
// `inpaint-worker-client.ts`) posts the ROI's RGBA pixels + a single-channel heal
// mask + the inpaint radius + the self-hosted OpenCV.js url; the worker loads
// OpenCV.js INSIDE the worker (so the ~10 MB wasm parse + the Telea solve never
// touch the UI thread), runs the SAME region inpaint the synchronous path used,
// and transfers the healed RGBA buffer back (zero-copy via a transferable
// ArrayBuffer).
//
// IMPORTANT — this is a CLASSIC worker (spawned with `{ type: "classic" }`), NOT
// a module worker. OpenCV.js is a UMD/classic global script, so the only way to
// load it inside a worker is `self.importScripts(url)` — which is ILLEGAL inside
// a module worker (throws "Module scripts don't support importScripts()"). The
// previous build spawned this as `{ type: "module" }` (forced in part by a
// top-level ESM `import` here) AND called `importScripts`, so loading ALWAYS
// threw, the worker was torn down, and every heal silently fell back to the
// SYNCHRONOUS main-thread path — freezing the UI for tens of seconds. To keep
// this a clean classic script we take the OpenCV url from the FIRST message
// (no top-level ESM import that could pull in DOM-only loader code or flip the
// worker to module mode).
//
// Design notes:
//  - Only the ROI is shipped in/out (the caller already crops to the mask bbox +
//    margin in `healing-brush-tool.ts`), so the per-message payload is tiny.
//  - OpenCV is loaded with `importScripts` from the SAME self-hosted url the
//    main-thread loader uses, and is single-flight inside the worker so repeated
//    strokes reuse the one initialised `cv`.
//  - The worker never imports DOM helpers; it does the RGBA→RGB→inpaint→RGBA math
//    directly on typed arrays (identical to `inpaintTelea`).

/// <reference lib="webworker" />

interface InpaintRequest {
	id: number;
	rgba: ArrayBuffer; // ROI pixels, length = width*height*4
	width: number;
	height: number;
	mask: ArrayBuffer; // single-channel ROI mask, length = width*height (>0 = heal)
	radius: number;
	/** Absolute, self-hosted OpenCV.js url to `importScripts` inside the worker. */
	opencvUrl: string;
}

interface InpaintSuccess {
	id: number;
	ok: true;
	rgba: ArrayBuffer; // healed ROI pixels, transferred back
}

interface InpaintFailure {
	id: number;
	ok: false;
	error: string;
}

// Loose `cv` typing — the worker only touches a handful of OpenCV symbols.
type Cv = Record<string, any>;

declare const cv: Cv | undefined;

let cvPromise: Promise<Cv> | null = null;

/**
 * Settle our promise with the ready OpenCV module WITHOUT triggering Promise
 * thenable-assimilation.
 *
 * THE SECOND P1 BUG (this PR): the OpenCV.js Emscripten `Module` is a *thenable
 * that resolves with ITSELF* (the resolved value is still the same thenable). If
 * you `resolve(module)` or `Promise.resolve(module)` directly, the Promise spec
 * recursively assimilates it — it keeps calling `module.then(...)`, which resolves
 * with the still-thenable module again, FOREVER — so the awaiting promise NEVER
 * settles and the worker hangs (looks identical to a wedged worker). This is why,
 * even after spawning a classic worker, the heal still fell back to the main
 * thread via the timeout. Fix: neutralise `.then` on the ready module before
 * resolving so the resolution value is a plain (non-thenable) object. Downstream
 * only uses `cv.Mat` / `cv.inpaint` / etc., never `cv.then`.
 */
function settleReady(resolve: (cv: Cv) => void, module: Cv): void {
	try {
		(module as any).then = undefined;
	} catch {
		/* frozen module — fall through; resolve below still works if not thenable */
	}
	(globalThis as any).cv = module;
	resolve(module);
}

/**
 * Lazily `importScripts` OpenCV.js inside the worker; single-flight + ready-awaited.
 * `url` is the self-hosted OpenCV.js url resolved on the main thread (so it is
 * origin-absolute and equally valid against the worker's own base URL).
 */
function loadOpenCvInWorker(url: string): Promise<Cv> {
	const existing = (globalThis as any).cv as Cv | undefined;
	if (existing?.Mat) return Promise.resolve(existing);
	if (cvPromise) return cvPromise;

	cvPromise = new Promise<Cv>((resolve, reject) => {
		try {
			// `importScripts` is synchronous and CLASSIC-WORKER-ONLY; it attaches the
			// `cv` global (which may be a thenable Module that resolves once the wasm
			// runtime is initialised). Legal here because this worker is classic.
			(self as unknown as WorkerGlobalScope).importScripts(url);
			const loaded = (globalThis as any).cv as Cv | undefined;
			if (!loaded) {
				reject(new Error("OpenCV.js loaded in worker but `cv` global is missing"));
				return;
			}
			if (typeof (loaded as any).then === "function") {
				// Use the module's own thenable to WAIT for wasm init, but settle with a
				// de-thenable'd module (see settleReady) so we don't assimilate forever.
				(loaded as any).then((ready: Cv) => settleReady(resolve, ready ?? loaded));
			} else if (typeof loaded.Mat === "function") {
				resolve(loaded);
			} else {
				loaded.onRuntimeInitialized = () => settleReady(resolve, loaded);
			}
		} catch (err) {
			cvPromise = null; // allow retry after a failure
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
	return cvPromise;
}

/** OpenCV inpaint wants a strict 0/255 mask. */
function binarize(mask: Uint8Array): Uint8Array {
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) out[i] = mask[i] > 0 ? 255 : 0;
	return out;
}

/**
 * Run Telea inpaint on the ROI. Mirrors `inpaintTelea` exactly so a worker heal and
 * a main-thread heal reconstruct identical pixels within the region. All Mats are
 * released (OpenCV.js wasm-heap leak guard).
 */
function inpaintRoi(cvMod: Cv, rgba: Uint8ClampedArray, width: number, height: number, mask: Uint8Array, radius: number): Uint8ClampedArray {
	const srcImage = { data: rgba, width, height } as ImageData;
	const rgbaMat = cvMod.matFromImageData(srcImage);
	const rgb = new cvMod.Mat();
	const maskMat = cvMod.matFromArray(height, width, cvMod.CV_8UC1, binarize(mask));
	const dst = new cvMod.Mat();
	try {
		cvMod.cvtColor(rgbaMat, rgb, cvMod.COLOR_RGBA2RGB);
		cvMod.inpaint(rgb, maskMat, dst, Math.max(1, radius), cvMod.INPAINT_TELEA);
		const out = new Uint8ClampedArray(rgba); // copy (keeps original alpha)
		const d = dst.data as Uint8Array; // length = width*height*3
		const n = width * height;
		for (let i = 0; i < n; i++) {
			const o = i * 4;
			const t = i * 3;
			out[o] = d[t];
			out[o + 1] = d[t + 1];
			out[o + 2] = d[t + 2];
		}
		return out;
	} finally {
		rgbaMat.delete();
		rgb.delete();
		maskMat.delete();
		dst.delete();
	}
}

self.onmessage = (event: MessageEvent<InpaintRequest>) => {
	const { id, rgba, width, height, mask, radius, opencvUrl } = event.data ?? ({} as InpaintRequest);
	void (async () => {
		try {
			if (!opencvUrl) throw new Error("inpaint worker: missing OpenCV.js url in request");
			const cvMod = await loadOpenCvInWorker(opencvUrl);
			const healed = inpaintRoi(
				cvMod,
				new Uint8ClampedArray(rgba),
				width,
				height,
				new Uint8Array(mask),
				radius,
			);
			// `healed` is allocated here as a plain Uint8ClampedArray, so its backing
			// store is always an ArrayBuffer (never a SharedArrayBuffer).
			const buffer = healed.buffer as ArrayBuffer;
			const msg: InpaintSuccess = { id, ok: true, rgba: buffer };
			(self as unknown as Worker).postMessage(msg, [buffer]);
		} catch (err) {
			const msg: InpaintFailure = {
				id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
			(self as unknown as Worker).postMessage(msg);
		}
	})();
};

export type { InpaintRequest, InpaintSuccess, InpaintFailure };
