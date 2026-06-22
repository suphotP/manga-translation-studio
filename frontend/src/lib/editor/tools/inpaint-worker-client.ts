// Rec #2 — main-thread client for the off-thread Telea inpaint worker.
//
// `inpaintRegion(roi, mask, radius)` returns the healed ROI ImageData. It runs the
// OpenCV solve in a Web Worker (so the UI thread never freezes during the inpaint),
// transferring the ROI pixel buffers in/out zero-copy. When Web Workers are
// unavailable (SSR / jsdom tests) or the worker errors, it transparently FALLS BACK
// to the existing synchronous main-thread path (`loadOpenCv` + `inpaintTelea`) so
// healing keeps working everywhere. The instant-apply composite (#255) is unchanged:
// the caller still composites the returned ROI straight onto the live canvas.
//
// CLASSIC-WORKER FIX (this PR) — the worker is spawned as `{ type: "classic" }`,
// NOT a module worker. OpenCV.js is a UMD/classic global, loadable inside a
// worker ONLY via `self.importScripts(url)`, which is ILLEGAL in a module worker
// ("Module scripts don't support importScripts()"). The previous build spawned a
// MODULE worker that then called `importScripts`, so OpenCV NEVER loaded off-
// thread: `loadOpenCvInWorker()` always threw, the worker was torn down, and
// every heal silently fell back to the SYNCHRONOUS main-thread path — freezing
// the whole app for tens of seconds on a large page. As a classic worker the
// `importScripts(self-hosted-opencv-url)` is legal and the solve genuinely runs
// off-thread. We resolve the self-hosted OpenCV url HERE (main thread, where
// `location` is reliable) and pass it into the worker in each request so the
// worker stays a pure dependency-free classic script.
//
// PR #264 P1 DEADLOCK fix — the worker round-trip is wrapped in a BOUNDED TIMEOUT.
// A healthy worker replies in well under a second; but if the worker is WEDGED (e.g.
// OpenCV's `onRuntimeInitialized` never fires, so `loadOpenCvInWorker()` never
// resolves and the worker never posts back), the un-timed `await postToWorker()`
// would NEVER settle. That keeps `ToolRegistry.commitInFlight` non-null forever, so
// every nav/save/export path that now (correctly) gates on the in-flight heal commit
// would BLOCK PERMANENTLY. The timeout guarantees `inpaintRegion()` ALWAYS settles in
// bounded time: it rejects the wedged round-trip, tears down + DISABLES the worker,
// and FALLS BACK to the synchronous main-thread `inpaintTelea()` so the heal still
// completes and the gate always releases. Once a worker has hung, the whole session
// stays on the sync path (no more re-hangs).

import { inpaintTelea } from "./inpaint.js";
import { loadOpenCv } from "./opencv-loader.js";
import { resolveOpenCvUrl } from "./opencv-source.js";
import { makeImageData } from "./raster.js";
import type { InpaintRequest, InpaintSuccess, InpaintFailure } from "./inpaint-worker.js";

interface PendingEntry {
	width: number;
	height: number;
	resolve: (img: ImageData) => void;
	reject: (err: Error) => void;
}

// Bound on a single worker round-trip (post → solve → post back). Generous enough to
// cover a cold OpenCV wasm init (~8 MB parse) + a Telea solve on a large ROI on a slow
// device, but small enough that a wedged worker (init-hang) can't block nav/save/
// export for more than this. On expiry we settle via the synchronous fallback.
const DEFAULT_WORKER_ROUNDTRIP_TIMEOUT_MS = 10_000;
let workerRoundtripTimeoutMs = DEFAULT_WORKER_ROUNDTRIP_TIMEOUT_MS;

const UNIFORM_RING_INNER_RADIUS = 4;
const UNIFORM_RING_OUTER_RADIUS = 8;
const UNIFORM_RING_TOLERANCE = 12;
const UNIFORM_RING_REQUIRED_FRACTION = 0.95;
const UNIFORM_RING_MIN_SAMPLES = 16;
const UNIFORM_RING_OFFSETS = buildRingOffsets(UNIFORM_RING_INNER_RADIUS, UNIFORM_RING_OUTER_RADIUS);

let worker: Worker | null = null;
let workerUsable = true; // flipped false after a spawn failure OR a hang so we stop retrying
let nextRequestId = 1;
const pending = new Map<number, PendingEntry>();

interface UniformRingFillResult {
	image: ImageData;
	samples: number;
	fraction: number;
	fill: { r: number; g: number; b: number; a: number };
}

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function roundMs(value: number): number {
	return Math.round(value * 10) / 10;
}

function isInpaintDebugEnabled(): boolean {
	const globalFlag = (globalThis as { __MANGA_HEALING_DEBUG__?: boolean }).__MANGA_HEALING_DEBUG__;
	if (globalFlag === true) return true;
	try {
		return typeof localStorage !== "undefined" && localStorage.getItem("manga:healing-debug") === "1";
	} catch {
		return false;
	}
}

function logInpaintPerf(stage: string, details: Record<string, unknown>): void {
	if (!isInpaintDebugEnabled() || typeof console === "undefined") return;
	console.debug("[healing-brush:perf]", stage, details);
}

function buildRingOffsets(innerRadius: number, outerRadius: number): Array<{ dx: number; dy: number }> {
	const offsets: Array<{ dx: number; dy: number }> = [];
	const innerSq = innerRadius * innerRadius;
	const outerSq = outerRadius * outerRadius;
	for (let dy = -outerRadius; dy <= outerRadius; dy++) {
		for (let dx = -outerRadius; dx <= outerRadius; dx++) {
			const d2 = dx * dx + dy * dy;
			if (d2 >= innerSq && d2 <= outerSq) offsets.push({ dx, dy });
		}
	}
	return offsets;
}

function isMaskBoundary(mask: Uint8ClampedArray, width: number, height: number, x: number, y: number): boolean {
	const idx = y * width + x;
	if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) return true;
	return mask[idx - 1] === 0 || mask[idx + 1] === 0 || mask[idx - width] === 0 || mask[idx + width] === 0;
}

function tryUniformRingFill(roi: ImageData, mask: Uint8ClampedArray): UniformRingFillResult | null {
	const width = roi.width;
	const height = roi.height;
	const pixels = width * height;
	if (mask.length !== pixels) return null;

	let maskCount = 0;
	for (let i = 0; i < pixels; i++) {
		if (mask[i] > 0) maskCount++;
	}
	if (maskCount === 0) return null;

	const ring = new Uint8Array(pixels);
	let ringCount = 0;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const idx = row + x;
			if (mask[idx] === 0 || !isMaskBoundary(mask, width, height, x, y)) continue;
			for (const offset of UNIFORM_RING_OFFSETS) {
				const rx = x + offset.dx;
				const ry = y + offset.dy;
				if (rx < 0 || ry < 0 || rx >= width || ry >= height) continue;
				const ri = ry * width + rx;
				if (mask[ri] > 0 || ring[ri] !== 0) continue;
				ring[ri] = 1;
				ringCount++;
			}
		}
	}
	if (ringCount < UNIFORM_RING_MIN_SAMPLES) return null;

	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	const data = roi.data;
	for (let i = 0; i < pixels; i++) {
		if (ring[i] === 0) continue;
		const o = i * 4;
		r += data[o];
		g += data[o + 1];
		b += data[o + 2];
		a += data[o + 3];
	}
	const fill = {
		r: Math.round(r / ringCount),
		g: Math.round(g / ringCount),
		b: Math.round(b / ringCount),
		a: Math.round(a / ringCount),
	};

	let withinTolerance = 0;
	for (let i = 0; i < pixels; i++) {
		if (ring[i] === 0) continue;
		const o = i * 4;
		const rgbDelta = Math.max(
			Math.abs(data[o] - fill.r),
			Math.abs(data[o + 1] - fill.g),
			Math.abs(data[o + 2] - fill.b),
		);
		if (rgbDelta <= UNIFORM_RING_TOLERANCE) withinTolerance++;
	}
	const fraction = withinTolerance / ringCount;
	if (fraction < UNIFORM_RING_REQUIRED_FRACTION) return null;

	const out = new Uint8ClampedArray(data);
	for (let i = 0; i < pixels; i++) {
		if (mask[i] === 0) continue;
		const o = i * 4;
		out[o] = fill.r;
		out[o + 1] = fill.g;
		out[o + 2] = fill.b;
		// Keep the SOURCE alpha untouched (parity with the Telea paths): the
		// fast fill replaces color only, so alpha-edged art / transparent PNG
		// pages never gain or lose opacity from a heal (codex P2).

	}
	return {
		image: makeImageData(out, width, height),
		samples: ringCount,
		fraction,
		fill,
	};
}

/** True when this runtime can spawn a classic Web Worker (browser, not SSR/jsdom). */
function canUseWorker(): boolean {
	if (
		!workerUsable ||
		typeof Worker === "undefined" ||
		typeof URL === "undefined" ||
		typeof document === "undefined" ||
		typeof window === "undefined"
	) {
		return false;
	}
	// jsdom (vitest) defines a Worker stub that cannot run our module script — it
	// would hang the promise. Detect it and stay on the synchronous fallback, which
	// is the path the suite tests assert against anyway.
	const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
	if (/jsdom/i.test(ua)) return false;
	return true;
}

/**
 * Worker spawn `type` MUST be "classic": the worker loads OpenCV.js via
 * `importScripts`, which is illegal in a module worker. Exported as a constant so
 * a regression test can assert the spawn type stays consistent with the
 * importScripts-based load mechanism (the CI blind spot that let the module-worker
 * regression ship — see inpaint-worker-client.test.ts).
 *
 * NOTE: the literal `"classic"` is ALSO hard-coded in the `new Worker(...)` call
 * below because Vite's worker-import-meta-url plugin statically parses the AST and
 * REQUIRES the `type` to be a string literal there (it rejects a variable). Keep
 * the two in lockstep; the test asserts this constant is "classic", and a
 * separate test asserts the actual spawn used "classic".
 */
export const INPAINT_WORKER_TYPE: WorkerType = "classic";

/** Lazily spawn the singleton inpaint worker (Vite bundles it via the URL form). */
function ensureWorker(): Worker | null {
	if (worker) return worker;
	if (!canUseWorker()) return null;
	try {
		// CLASSIC, not module — see the file header + INPAINT_WORKER_TYPE. A module
		// worker cannot `importScripts(opencv)`; that is exactly what silently broke
		// off-thread healing before (every heal fell back to the synchronous main
		// thread). Vite requires this `type` to be a string literal here.
		worker = new Worker(new URL("./inpaint-worker.ts", import.meta.url), {
			type: "classic",
		});
		worker.onmessage = (event: MessageEvent<InpaintSuccess | InpaintFailure>) => {
			const data = event.data;
			const entry = pending.get(data.id);
			if (!entry) return;
			pending.delete(data.id);
			if (data.ok) {
				// Reconstruct an ImageData around the transferred-back buffer (no copy).
				const healed = new Uint8ClampedArray(data.rgba);
				entry.resolve(makeImageData(healed, entry.width, entry.height));
			} else {
				entry.reject(new Error(data.error));
			}
		};
		worker.onerror = (event) => {
			// A worker-level error rejects all in-flight requests; callers then fall
			// back to the main-thread path. Tear the worker down so the next call can
			// re-spawn (or, if spawning is broken, give up and stay on the fallback).
			const err = new Error(event.message || "inpaint worker error");
			for (const [, entry] of pending) entry.reject(err);
			pending.clear();
			teardownInpaintWorker();
		};
	} catch (err) {
		// Spawn failed (CSP blocks blob/module workers, etc.) — never try again.
		workerUsable = false;
		worker = null;
		console.warn("[inpaint] worker spawn failed; using main-thread fallback:", err);
		return null;
	}
	return worker;
}

/**
 * Heal the ROI off the main thread. `roi` is the ROI's RGBA ImageData; `mask` is the
 * ROI-sized single-channel heal mask (>0 = heal); `radius` is the Telea neighbourhood
 * radius. Resolves with the healed ROI ImageData (same dimensions). Falls back to the
 * synchronous main-thread inpaint when no worker is available or the worker fails.
 */
/**
 * Idle warmup: spin the worker up and let its OpenCV runtime initialize WITHOUT
 * the normal roundtrip timeout poisoning `workerUsable` (a slow cold init keeps
 * going and serves the first real stroke). Resolves quietly either way.
 */
export async function warmupInpaintWorker(): Promise<void> {
	const active = ensureWorker();
	if (!active) return;
	const roi = new ImageData(new Uint8ClampedArray(4), 1, 1);
	try {
		await postToWorker(active, roi, new Uint8ClampedArray(1), 1, 1, 1, 120_000, false);
	} catch {
		/* warmup is best-effort — never poison, never surface */
	}
}

export async function inpaintRegion(
	roi: ImageData,
	mask: Uint8ClampedArray,
	radius: number,
): Promise<ImageData> {
	const totalStart = nowMs();
	const w = roi.width;
	const h = roi.height;

	// Test-only seam (PR #264 worker-race browser proof). The real worker uses
	// OpenCV.js wasm, which can't run in the offline headless QA sandbox; a Playwright
	// spec sets `globalThis.__inpaintRegionTestHook` to a function that returns the
	// healed ROI after a controllable delay, so the spec can deterministically hold the
	// solve "in flight" and drive a page-switch / teardown during it — exercising the
	// REAL heal-tool → registry → editor gate + epoch guard. No-op in production.
	const testHook = (globalThis as { __inpaintRegionTestHook?: (roi: ImageData) => Promise<ImageData> })
		.__inpaintRegionTestHook;
	if (typeof testHook === "function") {
		return testHook(roi);
	}

	const fallbackHook = (
		globalThis as { __inpaintSyncFallbackTestHook?: (roi: ImageData) => ImageData }
	).__inpaintSyncFallbackTestHook;
	const uniformStart = nowMs();
	// Browser timeout proofs install the sync fallback hook to exercise the REAL
	// worker timeout path. Do not let the manga-fast fill short-circuit those tests.
	const uniformFill = typeof fallbackHook === "function" ? null : tryUniformRingFill(roi, mask);
	const uniformMs = nowMs() - uniformStart;
	if (uniformFill) {
		logInpaintPerf("fast-uniform-fill", {
			width: w,
			height: h,
			radius,
			ringSamples: uniformFill.samples,
			uniformFraction: Math.round(uniformFill.fraction * 1000) / 1000,
			fill: uniformFill.fill,
			analyzeMs: roundMs(uniformMs),
			totalMs: roundMs(nowMs() - totalStart),
		});
		return uniformFill.image;
	}

	const active = ensureWorker();
	if (active) {
		const workerStart = nowMs();
		try {
			const healed = await postToWorker(active, roi, mask, radius, w, h);
			logInpaintPerf("worker-telea", {
				width: w,
				height: h,
				radius,
				fastPathAnalyzeMs: roundMs(uniformMs),
				workerMs: roundMs(nowMs() - workerStart),
				totalMs: roundMs(nowMs() - totalStart),
			});
			return healed;
		} catch (err) {
			// Worker path failed at runtime (error, postMessage throw, or — the P1 case
			// — a TIMEOUT because the worker wedged and never replied). Fall through to
			// the sync path so the user still gets a healed result (never a dead stroke)
			// AND `inpaintRegion()` always settles in bounded time so the nav/save/export
			// gate can never block forever. `postToWorker` already tore down + disabled
			// the worker on a timeout, so subsequent strokes go straight to sync (no
			// re-hang).
			console.warn("[inpaint] worker inpaint failed; using main-thread fallback:", err);
		}
	}

	// Synchronous main-thread fallback (SSR / jsdom / worker unavailable / errored / hung).
	// Test-only seam (PR #264 P1 browser proof): OpenCV.js can't load in the offline
	// headless QA sandbox, so the deadlock spec — which exercises the REAL worker spawn
	// → post → TIMEOUT → teardown → fall-through path above — supplies a deterministic
	// offline sync result here instead of loading wasm. No-op in production (the real
	// `loadOpenCv` + `inpaintTelea` path runs). This intentionally only replaces the
	// solver, NOT the timeout/teardown logic, so the proof tests the actual fix.
	if (typeof fallbackHook === "function") {
		return fallbackHook(roi);
	}
	const loadStart = nowMs();
	const cv = await loadOpenCv();
	const solveStart = nowMs();
	const healed = inpaintTelea(cv, roi, mask, radius);
	logInpaintPerf("main-thread-telea", {
		width: w,
		height: h,
		radius,
		fastPathAnalyzeMs: roundMs(uniformMs),
		loadOpenCvMs: roundMs(solveStart - loadStart),
		teleaMs: roundMs(nowMs() - solveStart),
		totalMs: roundMs(nowMs() - totalStart),
	});
	return healed;
}

/** Test seam: override the worker round-trip timeout (ms) at runtime (browser proof). */
export function __setInpaintWorkerTimeout(ms: number): void {
	workerRoundtripTimeoutMs = ms > 0 ? ms : DEFAULT_WORKER_ROUNDTRIP_TIMEOUT_MS;
}

/**
 * Post a request to the worker and wrap the round-trip in a promise (transferables).
 *
 * The round-trip is BOUNDED by a timeout (PR #264 P1): a healthy worker replies fast,
 * but a wedged worker (OpenCV init-hang → no reply ever) would otherwise leave this
 * promise — and the registry's `commitInFlight` — pending forever. On timeout we
 * reject this request, tear down + DISABLE the worker (so the rest of the session
 * uses the sync fallback instead of re-hanging on every stroke), and the caller's
 * catch routes to `inpaintTelea()` on the main thread. Net: this promise ALWAYS
 * settles within `timeoutMs` (worker success/error, postMessage throw, or timeout).
 */
function postToWorker(
	active: Worker,
	roi: ImageData,
	mask: Uint8ClampedArray,
	radius: number,
	width: number,
	height: number,
	timeoutMs: number = workerRoundtripTimeoutMs,
	// Warmup probes pass false: a SLOW cold OpenCV init must not poison
	// `workerUsable` for the whole session (codex P2) — the init keeps going
	// and the first real stroke benefits from it.
	poisonOnTimeout = true,
): Promise<ImageData> {
	const id = nextRequestId++;
	// Copy the ROI + mask into fresh buffers we can transfer (the source ImageData /
	// mask are reused by the caller's accumulators, so we must not detach them).
	const rgbaCopy = new Uint8ClampedArray(roi.data);
	const maskCopy = mask.slice();
	const request: InpaintRequest = {
		id,
		rgba: rgbaCopy.buffer,
		width,
		height,
		mask: maskCopy.buffer,
		radius,
		// Resolve the self-hosted OpenCV url on the MAIN thread (where `location`
		// is reliable) and hand it to the classic worker to `importScripts`.
		opencvUrl: resolveOpenCvUrl(),
	};
	return new Promise<ImageData>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		// Wrap settle handlers so the worker's onmessage/onerror (which look the entry
		// up by id) clear the timeout when they fire normally.
		const clearTimer = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};
		pending.set(id, {
			width,
			height,
			resolve: (img) => {
				clearTimer();
				resolve(img);
			},
			reject: (err) => {
				clearTimer();
				reject(err);
			},
		});
		try {
			active.postMessage(request, [rgbaCopy.buffer, maskCopy.buffer]);
		} catch (err) {
			clearTimer();
			pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		// Bounded timeout: if the worker hasn't replied in `timeoutMs`, treat it as
		// wedged. Reject THIS request and tear the worker down + disable it so the
		// caller falls back to the synchronous main-thread inpaint and future strokes
		// skip the dead worker entirely. (P1 deadlock fix.)
		timer = setTimeout(() => {
			timer = null;
			if (!pending.has(id)) return; // already settled by onmessage/onerror
			pending.delete(id);
			if (!poisonOnTimeout) {
				// Warmup probe: just stop waiting. The worker stays alive and keeps
				// initializing; its late reply for this id is ignored (not pending).
				reject(new Error(`inpaint warmup still initializing after ${timeoutMs}ms (non-fatal)`));
				return;
			}
			// Disable the worker for the rest of the session, then tear it down. Teardown
			// rejects any OTHER in-flight entries (they'll fall back too). Order matters:
			// flip `workerUsable` first so `ensureWorker()` can't re-spawn the wedged one.
			workerUsable = false;
			teardownInpaintWorker();
			reject(
				new Error(
					`inpaint worker timed out after ${timeoutMs}ms (wedged); using main-thread fallback`,
				),
			);
		}, timeoutMs);
	});
}

/** Terminate the worker (teardown / test seam). In-flight requests are rejected. */
export function teardownInpaintWorker(): void {
	if (worker) {
		try {
			worker.terminate();
		} catch {
			/* best-effort */
		}
	}
	worker = null;
	for (const [, entry] of pending) entry.reject(new Error("inpaint worker torn down"));
	pending.clear();
}

/** Test seam: report whether a worker is currently spawned. */
export function __inpaintWorkerActiveForTests(): boolean {
	return worker !== null;
}

/**
 * Test seam: fully reset the client's module state between cases — tears the worker
 * down AND re-enables it + restores the default round-trip timeout. (Production never
 * re-enables a worker that hung in-session; this is only for test isolation.)
 */
export function __resetInpaintWorkerForTests(): void {
	teardownInpaintWorker();
	workerUsable = true;
	workerRoundtripTimeoutMs = DEFAULT_WORKER_ROUNDTRIP_TIMEOUT_MS;
}

/** Test seam: shrink the worker round-trip timeout so timeout cases run fast. */
export function __setInpaintWorkerTimeoutForTests(ms: number): void {
	workerRoundtripTimeoutMs = ms;
}

/** Test seam: report whether the worker has been disabled (e.g. after a hang). */
export function __inpaintWorkerUsableForTests(): boolean {
	return workerUsable;
}
