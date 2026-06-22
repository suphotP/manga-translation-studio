// Image-edit suite v1 (W3.13) — OpenCV.js lazy loader.
//
// OpenCV.js is ~10MB of wasm+glue. We do NOT bundle it into the JS chunk: it is
// fetched on first use of a tool that needs it (Spot Healing inpaint, Grow/
// Contract/Feather morphology) from a SELF-HOSTED static asset, and cached in
// IndexedDB so the second cold start is instant and offline-safe. We no longer
// depend on a public CDN at runtime (jsDelivr): a prod app must not have a core
// tool stall (or silently die) because an external CDN is slow or blocked.
//
// Loading is single-flight: concurrent callers share one promise. A 200ms
// skeleton hint is emitted via `onColdLoadStart` so W3.1's dock can show a
// shimmer only when the network/decode is actually slow.

import { OPENCV_VERSION, resolveOpenCvUrl } from "./opencv-source.js";

// Self-hosted URL of the pinned OpenCV.js build (served from `static/vendor/`).
// Kept exported under the historical `OPENCV_CDN_URL` name for callers, but it
// now points at our OWN origin, not jsDelivr.
const OPENCV_CDN_URL = resolveOpenCvUrl();
const IDB_NAME = "manga-editor-opencv";
const IDB_STORE = "blobs";
const IDB_KEY = `opencv-${OPENCV_VERSION}`;
const COLD_SKELETON_DELAY_MS = 200;

/** The subset of the cv namespace the suite touches (kept loose on purpose). */
export interface OpenCvModule {
	Mat: any;
	matFromImageData: (imageData: ImageData) => any;
	matFromArray: (rows: number, cols: number, type: number, array: ArrayLike<number>) => any;
	imread: (canvas: HTMLCanvasElement | string) => any;
	imshow: (canvas: HTMLCanvasElement | string, mat: any) => void;
	cvtColor: (src: any, dst: any, code: number, dstCn?: number) => void;
	morphologyEx: (src: any, dst: any, op: number, kernel: any, ...rest: any[]) => void;
	dilate: (src: any, dst: any, kernel: any, ...rest: any[]) => void;
	erode: (src: any, dst: any, kernel: any, ...rest: any[]) => void;
	GaussianBlur: (src: any, dst: any, ksize: any, sigmaX: number, ...rest: any[]) => void;
	getStructuringElement: (shape: number, ksize: any, ...rest: any[]) => any;
	inpaint: (src: any, mask: any, dst: any, radius: number, flags: number) => void;
	threshold: (src: any, dst: any, thresh: number, maxval: number, type: number) => number;
	Size: any;
	MORPH_DILATE: number;
	MORPH_ERODE: number;
	MORPH_RECT: number;
	MORPH_ELLIPSE: number;
	INPAINT_TELEA: number;
	INPAINT_NS: number;
	COLOR_RGBA2RGB: number;
	COLOR_RGB2GRAY: number;
	COLOR_RGBA2GRAY: number;
	CV_8U: number;
	CV_8UC1: number;
	THRESH_BINARY: number;
	onRuntimeInitialized?: () => void;
	[key: string]: any;
}

declare global {
	// eslint-disable-next-line no-var
	var cv: OpenCvModule | undefined;
}

export interface OpenCvLoadCallbacks {
	/** Fired once if the load is taking longer than the skeleton delay. */
	onColdLoadStart?: () => void;
	/** Fired when loading finishes (success or failure) to clear the skeleton. */
	onColdLoadEnd?: () => void;
}

let loadPromise: Promise<OpenCvModule> | null = null;

function isBrowser(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function openBlobDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
	});
}

async function readCachedScript(): Promise<string | null> {
	if (typeof indexedDB === "undefined") return null;
	try {
		const db = await openBlobDb();
		return await new Promise<string | null>((resolve) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
			req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
			req.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

async function writeCachedScript(source: string): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	try {
		const db = await openBlobDb();
		await new Promise<void>((resolve) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(source, IDB_KEY);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	} catch {
		/* best-effort cache */
	}
}

function evalOpenCvSource(source: string): Promise<OpenCvModule> {
	return new Promise((resolve, reject) => {
		try {
			// OpenCV.js attaches a `cv` global and calls onRuntimeInitialized once
			// the wasm runtime is ready. Inject via a blob script so the large
			// source is parsed off the main bundle.
			const blob = new Blob([source], { type: "text/javascript" });
			const url = URL.createObjectURL(blob);
			const script = document.createElement("script");
			script.src = url;
			script.async = true;
			script.onload = () => {
				const cv = (globalThis as any).cv as OpenCvModule | undefined;
				if (!cv) {
					reject(new Error("OpenCV.js loaded but `cv` global is missing"));
					return;
				}
				// Settle WITHOUT thenable-assimilation. OpenCV.js's Emscripten Module is
				// a thenable that resolves with ITSELF (still thenable); passing it to
				// `resolve()` makes the Promise spec recursively `.then` it forever, so
				// the await never settles (this hung the off-thread worker too — see
				// inpaint-worker.ts). Neutralise `.then` on the ready module first.
				const settle = (ready: OpenCvModule) => {
					try {
						(ready as any).then = undefined;
					} catch {
						/* frozen module — resolve still works once it's non-thenable */
					}
					(globalThis as any).cv = ready;
					resolve(ready);
				};
				// `cv` may be a thenable Module promise, or already initialised.
				if (typeof (cv as any).then === "function") {
					(cv as any).then((ready: OpenCvModule) => settle(ready ?? cv));
				} else if (typeof cv.Mat === "function") {
					resolve(cv);
				} else {
					cv.onRuntimeInitialized = () => settle(cv);
				}
			};
			script.onerror = () => reject(new Error("Failed to inject OpenCV.js"));
			document.head.appendChild(script);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/**
 * Lazily load (and IndexedDB-cache) OpenCV.js. Idempotent + single-flight.
 * Resolves with the ready `cv` module.
 */
export function loadOpenCv(callbacks: OpenCvLoadCallbacks = {}): Promise<OpenCvModule> {
	if (typeof globalThis !== "undefined" && (globalThis as any).cv?.Mat) {
		return Promise.resolve((globalThis as any).cv as OpenCvModule);
	}
	if (loadPromise) return loadPromise;
	if (!isBrowser()) {
		return Promise.reject(new Error("OpenCV.js can only load in a browser environment"));
	}

	loadPromise = (async () => {
		let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
		let skeletonShown = false;
		if (callbacks.onColdLoadStart) {
			skeletonTimer = setTimeout(() => {
				skeletonShown = true;
				callbacks.onColdLoadStart?.();
			}, COLD_SKELETON_DELAY_MS);
		}
		try {
			let source = await readCachedScript();
			if (!source) {
				const res = await fetch(OPENCV_CDN_URL);
				if (!res.ok) throw new Error(`OpenCV.js fetch failed: ${res.status}`);
				source = await res.text();
				void writeCachedScript(source);
			}
			const cv = await evalOpenCvSource(source);
			return cv;
		} catch (err) {
			loadPromise = null; // allow retry after a failure
			throw err;
		} finally {
			if (skeletonTimer) clearTimeout(skeletonTimer);
			if (skeletonShown) callbacks.onColdLoadEnd?.();
		}
	})();

	return loadPromise;
}

/** True if OpenCV is already initialised (lets tools skip the skeleton). */
export function isOpenCvReady(): boolean {
	return typeof globalThis !== "undefined" && !!(globalThis as any).cv?.Mat;
}

/** Test seam: clear the single-flight cache. */
export function __resetOpenCvLoaderForTests(): void {
	loadPromise = null;
}

export { OPENCV_CDN_URL, IDB_KEY as OPENCV_IDB_KEY };
