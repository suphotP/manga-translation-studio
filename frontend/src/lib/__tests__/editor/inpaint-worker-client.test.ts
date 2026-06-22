// Rec #2 — off-thread inpaint client: ROI bbox math + worker-unavailable fallback.
//
// In jsdom (no real Worker), `inpaintRegion` must transparently fall back to the
// synchronous main-thread inpaint (`loadOpenCv` + `inpaintTelea`) and return a
// healed ROI of the SAME dimensions as the input — so heal keeps working in
// test/SSR and the ROI result matches what the worker would have produced.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	computeMaskBounds,
	cropMaskRegion,
	makeImageData,
	type PixelRegion,
} from "$lib/editor/tools/raster.ts";

// Capture the args handed to the synchronous fallback so we can assert the client
// routed through it (not the worker) and passed the ROI buffers verbatim.
const inpaintTeleaSpy = vi.fn(
	(_cv: unknown, src: ImageData, _mask: Uint8ClampedArray, _radius: number) => {
		// Return a distinct buffer (mark the first pixel) so we can prove the client
		// surfaces the fallback's output, not the input.
		const out = new Uint8ClampedArray(src.data);
		out[0] = 42;
		return makeImageData(out, src.width, src.height);
	},
);

vi.mock("$lib/editor/tools/opencv-loader.ts", () => ({
	loadOpenCv: () => Promise.resolve({ __stub: true }),
	OPENCV_CDN_URL: "https://example.test/opencv.js",
}));
vi.mock("$lib/editor/tools/opencv-source.ts", () => ({
	OPENCV_VERSION: "4.10.0-release.1",
	OPENCV_VENDOR_PATH: "vendor/opencv/opencv-4.10.0-release.1.js",
	resolveOpenCvUrl: () => "https://example.test/vendor/opencv/opencv-4.10.0-release.1.js",
}));
vi.mock("$lib/editor/tools/inpaint.ts", () => ({
	inpaintTelea: (cv: unknown, src: ImageData, mask: Uint8ClampedArray, radius: number) =>
		inpaintTeleaSpy(cv, src, mask, radius),
}));

import {
	inpaintRegion,
	warmupInpaintWorker,
	INPAINT_WORKER_TYPE,
	__inpaintWorkerActiveForTests,
	__resetInpaintWorkerForTests,
	__setInpaintWorkerTimeoutForTests,
	__inpaintWorkerUsableForTests,
	teardownInpaintWorker,
} from "$lib/editor/tools/inpaint-worker-client.ts";

beforeEach(() => {
	inpaintTeleaSpy.mockClear();
	__resetInpaintWorkerForTests();
});

function makeOpaqueRoi(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number],
): ImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y);
			const o = (y * width + x) * 4;
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
		}
	}
	return makeImageData(data, width, height);
}

function makeBlockMask(width: number, height: number, x0: number, y0: number, size: number): Uint8ClampedArray {
	const mask = new Uint8ClampedArray(width * height);
	for (let y = y0; y < y0 + size; y++) {
		for (let x = x0; x < x0 + size; x++) mask[y * width + x] = 255;
	}
	return mask;
}

function makeGradientRoi(width: number, height: number): ImageData {
	return makeOpaqueRoi(width, height, (x, y) => [
		Math.min(255, 30 + x * 9),
		Math.min(255, 20 + y * 7),
		Math.min(255, 40 + x * 4 + y * 3),
	]);
}

describe("ROI bounding-box math (rec #1 — bounded compute the worker receives)", () => {
	it("computes a tight bbox + clamps padding to the image edges", () => {
		const w = 12;
		const h = 12;
		const mask = new Uint8ClampedArray(w * h);
		// Paint two pixels near opposite corners so the bbox spans the dabs.
		mask[1 * w + 1] = 255; // (1,1)
		mask[9 * w + 8] = 255; // (8,9)
		const region = computeMaskBounds(mask, w, h, 3);
		// minX=1,minY=1,maxX=8,maxY=9 → padded by 3 and clamped to [0,w-1]/[0,h-1].
		expect(region).toEqual({ x: 0, y: 0, width: 12, height: 12 });

		const tight = computeMaskBounds(mask, w, h, 0);
		expect(tight).toEqual({ x: 1, y: 1, width: 8, height: 9 });
	});

	it("cropMaskRegion extracts exactly the bbox sub-rectangle", () => {
		const w = 8;
		const mask = new Uint8ClampedArray(w * 8);
		for (let y = 2; y <= 4; y++) for (let x = 3; x <= 5; x++) mask[y * w + x] = 255;
		const region = computeMaskBounds(mask, w, 8, 0)!;
		expect(region).toEqual({ x: 3, y: 2, width: 3, height: 3 });
		const cropped = cropMaskRegion(mask, w, region);
		expect(cropped.length).toBe(9);
		for (let i = 0; i < cropped.length; i++) expect(cropped[i]).toBe(255);
	});
});

describe("inpaintRegion fallback (no real Worker in jsdom)", () => {
	it("fast-fills a uniform ring immediately while preserving the masked source alpha", async () => {
		const w = 24;
		const h = 24;
		const roi = makeOpaqueRoi(w, h, () => [238, 239, 240]);
		const mask = makeBlockMask(w, h, 8, 8, 8);
		for (let y = 8; y < 16; y++) {
			for (let x = 8; x < 16; x++) {
				const o = (y * w + x) * 4;
				roi.data[o] = 12;
				roi.data[o + 1] = 18;
				roi.data[o + 2] = 24;
				roi.data[o + 3] = 48 + ((x + y) % 5) * 32;
			}
		}
		const original = new Uint8ClampedArray(roi.data);

		const healed = await inpaintRegion(roi, mask, 7);

		expect(inpaintTeleaSpy).not.toHaveBeenCalled();
		for (let i = 0; i < mask.length; i++) {
			const o = i * 4;
			if (mask[i] > 0) {
				expect(healed.data[o]).toBe(238);
				expect(healed.data[o + 1]).toBe(239);
				expect(healed.data[o + 2]).toBe(240);
				expect(healed.data[o + 3]).toBe(original[o + 3]);
			} else {
				expect(Array.from(healed.data.slice(o, o + 4))).toEqual(Array.from(original.slice(o, o + 4)));
			}
		}
		// The input ROI must NOT be mutated in place: healing-brush-tool reuses it
		// AFTER the await as the pre-heal baseline for the instant-preview patch.
		expect(Array.from(roi.data)).toEqual(Array.from(original));
	});

	it("fast-fills a white manga bubble from a near-uniform surrounding ring without Telea", async () => {
		const w = 24;
		const h = 24;
		const roi = makeOpaqueRoi(w, h, () => [255, 255, 255]);
		const mask = makeBlockMask(w, h, 8, 8, 8);
		for (let y = 8; y < 16; y++) {
			for (let x = 8; x < 16; x++) {
				const o = (y * w + x) * 4;
				roi.data[o] = 12;
				roi.data[o + 1] = 12;
				roi.data[o + 2] = 12;
			}
		}

		const healed = await inpaintRegion(roi, mask, 7);

		expect(inpaintTeleaSpy).not.toHaveBeenCalled();
		expect(healed.width).toBe(w);
		expect(healed.height).toBe(h);
		for (let i = 0; i < healed.data.length; i += 4) {
			expect(healed.data[i]).toBe(255);
			expect(healed.data[i + 1]).toBe(255);
			expect(healed.data[i + 2]).toBe(255);
			expect(healed.data[i + 3]).toBe(255);
		}
	});

	it("does not fast-fill a gradient background; it falls through to the Telea path", async () => {
		const w = 24;
		const h = 24;
		const roi = makeGradientRoi(w, h);
		const mask = makeBlockMask(w, h, 8, 8, 8);

		const healed = await inpaintRegion(roi, mask, 4);

		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(1);
		expect(healed.data[0]).toBe(42);
	});

	it("does not fast-fill a multi-color ring; it falls through to the Telea path", async () => {
		const w = 24;
		const h = 24;
		const roi = makeOpaqueRoi(w, h, (x) => (x < w / 2 ? [24, 24, 24] : [232, 232, 232]));
		const mask = makeBlockMask(w, h, 8, 8, 8);

		const healed = await inpaintRegion(roi, mask, 4);

		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(1);
		expect(healed.data[0]).toBe(42);
	});

	it("falls back when the mask has no surrounding ring to sample", async () => {
		const w = 8;
		const h = 8;
		const roi = makeOpaqueRoi(w, h, () => [255, 255, 255]);
		const mask = new Uint8ClampedArray(w * h).fill(255);

		const healed = await inpaintRegion(roi, mask, 3);

		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(1);
		expect(healed.data[0]).toBe(42);
	});

	it("uses the synchronous main-thread inpaint and returns a same-size healed ROI", async () => {
		const w = 6;
		const h = 5;
		const roi = makeGradientRoi(w, h);
		const mask = new Uint8ClampedArray(w * h);
		mask[2 * w + 2] = 255;

		const healed = await inpaintRegion(roi, mask, 3);

		// Fell back to the synchronous path (no worker spawned in jsdom).
		expect(__inpaintWorkerActiveForTests()).toBe(false);
		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(1);
		// The healed ROI has the SAME dimensions as the input ROI.
		expect(healed.width).toBe(w);
		expect(healed.height).toBe(h);
		// And it surfaces the fallback's output (marked first pixel), not the input.
		expect(healed.data[0]).toBe(42);
		// The radius + mask were forwarded to the solver unchanged.
		const [, , forwardedMask, forwardedRadius] = inpaintTeleaSpy.mock.calls[0];
		expect(forwardedRadius).toBe(3);
		expect((forwardedMask as Uint8ClampedArray)[2 * w + 2]).toBe(255);
	});

	it("passes the inpaint radius through to the solver", async () => {
		const roi = makeImageData(new Uint8ClampedArray(4 * 4 * 4).fill(0), 4, 4);
		await inpaintRegion(roi, new Uint8ClampedArray(16), 7);
		expect(inpaintTeleaSpy.mock.calls[0][3]).toBe(7);
	});
});

describe("PixelRegion typing sanity", () => {
	it("region width/height are positive integers for a non-empty mask", () => {
		const mask = new Uint8ClampedArray(10 * 10);
		mask[55] = 255;
		const region = computeMaskBounds(mask, 10, 10, 1) as PixelRegion;
		expect(region.width).toBeGreaterThan(0);
		expect(region.height).toBeGreaterThan(0);
		expect(Number.isInteger(region.width)).toBe(true);
	});
});

// Hard invariant, asserted INDEPENDENTLY of any Worker stub / jsdom skip: the
// worker MUST be classic because it loads OpenCV via `importScripts`, which is
// illegal in a module worker. This single assertion would have caught the prior
// "module worker + importScripts" regression even though the suite skips the real
// worker under jsdom — the exact CI blind spot that let the freeze ship.
describe("inpaint worker type invariant", () => {
	it("is classic (importScripts requires a classic worker)", () => {
		expect(INPAINT_WORKER_TYPE).toBe("classic");
	});
});

// PR #264 P1 DEADLOCK regression — a WEDGED worker (spawns but never posts back, e.g.
// OpenCV's onRuntimeInitialized never fires) must NOT leave `inpaintRegion()` pending
// forever. The bounded timeout has to fire, settle the heal via the synchronous
// main-thread fallback, and disable the dead worker so later strokes skip it. Without
// this the registry's `commitInFlight` would stay non-null forever and every gated
// nav/save/export path would block permanently.
describe("inpaintRegion bounded timeout → sync fallback (PR #264 P1 deadlock)", () => {
	afterEach(() => {
		// If a warmup promise never settles (the regression mode), an in-test
		// finally never runs — restore here so fake timers cannot leak into the
		// rest of the file.
		vi.useRealTimers();
	});

	// A Worker constructor whose instances spawn fine but NEVER reply — models OpenCV
	// init-hang inside the worker. We capture the instance so a test could resolve it,
	// but for the deadlock case we just never do.
	class SilentWorker {
		onmessage: ((e: MessageEvent) => void) | null = null;
		onerror: ((e: ErrorEvent) => void) | null = null;
		postMessageCount = 0;
		terminated = false;
		lastRequest: unknown = null;
		postMessage(req?: unknown, _transfer?: unknown): void {
			this.postMessageCount += 1; // ...and then nothing ever comes back.
			this.lastRequest = req;
		}
		terminate(): void {
			this.terminated = true;
		}
	}

	let realWorker: typeof globalThis.Worker | undefined;
	let realUA: PropertyDescriptor | undefined;
	let lastInstance: SilentWorker | null = null;
	let lastSpawnOptions: WorkerOptions | undefined;

	beforeEach(() => {
		// Make canUseWorker() return true in jsdom: strip the "jsdom" UA marker and
		// install a Worker constructor that spawns our silent stub.
		realWorker = globalThis.Worker;
		realUA = Object.getOwnPropertyDescriptor(navigator, "userAgent");
		Object.defineProperty(navigator, "userAgent", {
			value: "test-runner (not-j-s-d-o-m)",
			configurable: true,
		});
		lastInstance = null;
		lastSpawnOptions = undefined;
		// Replace the global Worker with our silent stub for this suite. Capture the
		// spawn options so a test can assert the worker `type` (regression guard).
		globalThis.Worker = function (_url: string | URL, options?: WorkerOptions) {
			lastSpawnOptions = options;
			lastInstance = new SilentWorker();
			return lastInstance as unknown as Worker;
		} as unknown as typeof globalThis.Worker;
		// Short timeout so the case runs fast (production default is 10s).
		__setInpaintWorkerTimeoutForTests(20);
	});

	afterEach(() => {
		__resetInpaintWorkerForTests();
		if (realWorker === undefined) {
			// @ts-expect-error — restore absence of the global.
			delete globalThis.Worker;
		} else {
			globalThis.Worker = realWorker;
		}
		if (realUA) Object.defineProperty(navigator, "userAgent", realUA);
	});

	it("a wedged worker times out and the heal STILL completes via the sync fallback (bounded)", async () => {
		const w = 6;
		const h = 5;
		const roi = makeGradientRoi(w, h);
		const mask = new Uint8ClampedArray(w * h);
		mask[2 * w + 2] = 255;

		// The worker spawns and is handed the stroke, but it never replies. The promise
		// MUST still settle (within the timeout) via the synchronous fallback.
		const healed = await inpaintRegion(roi, mask, 3);

		// It spawned the worker and posted to it...
		expect(lastInstance).not.toBeNull();
		expect(lastInstance!.postMessageCount).toBe(1);
		// ...then the timeout fired → fell back to the sync solver → returned a result.
		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(1);
		expect(healed.width).toBe(w);
		expect(healed.height).toBe(h);
		expect(healed.data[0]).toBe(42); // fallback's marked output, not a dead stroke
		// The wedged worker was torn down + disabled for the rest of the session.
		expect(lastInstance!.terminated).toBe(true);
		expect(__inpaintWorkerActiveForTests()).toBe(false);
		expect(__inpaintWorkerUsableForTests()).toBe(false);
	});

	it("after a hang, subsequent strokes go STRAIGHT to the sync path (no re-spawn, no re-hang)", async () => {
		const roi = makeImageData(new Uint8ClampedArray(4 * 4 * 4).fill(0), 4, 4);
		const mask = new Uint8ClampedArray(16);

		// First stroke wedges + disables the worker.
		await inpaintRegion(roi, mask, 2);
		const firstInstance = lastInstance;
		expect(firstInstance).not.toBeNull();
		lastInstance = null;

		// Second stroke must NOT spawn a new worker — it goes straight to sync, so it
		// returns immediately (no second timeout wait) and never re-hangs.
		const healed = await inpaintRegion(roi, mask, 2);
		expect(lastInstance).toBeNull(); // no new worker spawned
		expect(healed.data[0]).toBe(42);
		expect(inpaintTeleaSpy).toHaveBeenCalledTimes(2);
	});

	it("a HEALTHY worker (replies) resolves from the worker, never the sync fallback", async () => {
		// Override the stub to reply on the next tick with the ROI echoed back, marking
		// pixel[1] so we can prove the worker's output (not the sync fallback) surfaced.
		// Echo back the SAME request id we were posted (ids are a module-global counter).
		globalThis.Worker = function () {
			const inst = new SilentWorker();
			inst.postMessage = function (raw?: unknown) {
				inst.postMessageCount += 1;
				const req = raw as { id: number; width: number; height: number };
				queueMicrotask(() => {
					const out = new Uint8ClampedArray(req.width * req.height * 4);
					out[1] = 7;
					inst.onmessage?.({
						data: { id: req.id, ok: true, rgba: out.buffer },
					} as MessageEvent);
				});
			};
			lastInstance = inst;
			return inst as unknown as Worker;
		} as unknown as typeof globalThis.Worker;

		const w = 6;
		const h = 5;
		const roi = makeImageData(new Uint8ClampedArray(w * h * 4), w, h);
		const healed = await inpaintRegion(roi, new Uint8ClampedArray(w * h), 3);

		expect(__inpaintWorkerActiveForTests()).toBe(true); // worker kept (healthy)
		expect(__inpaintWorkerUsableForTests()).toBe(true);
		expect(inpaintTeleaSpy).not.toHaveBeenCalled(); // resolved from the worker
		expect(healed.width).toBe(w);
		expect(healed.data[1]).toBe(7); // worker's output surfaced
	});

	it("warmup timeout is non-fatal and keeps the worker usable", async () => {
		vi.useFakeTimers();
		try {
			const warmup = warmupInpaintWorker();

			await vi.advanceTimersByTimeAsync(120_000);

			await expect(warmup).resolves.toBeUndefined();
			expect(lastInstance).not.toBeNull();
			expect(lastInstance!.postMessageCount).toBe(1);
			expect(lastInstance!.terminated).toBe(false);
			expect(__inpaintWorkerActiveForTests()).toBe(true);
			expect(__inpaintWorkerUsableForTests()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("posts worker requests in order and resolves queued replies by request id", async () => {
		type PostedInpaintRequest = { id: number; width: number; height: number; radius: number };
		class QueueWorker extends SilentWorker {
			requests: PostedInpaintRequest[] = [];

			override postMessage(raw?: unknown, _transfer?: unknown): void {
				this.postMessageCount += 1;
				this.lastRequest = raw;
				this.requests.push(raw as PostedInpaintRequest);
			}

			reply(index: number, marker: number): void {
				const req = this.requests[index];
				if (!req) throw new Error(`missing queued inpaint request at index ${index}`);
				const out = new Uint8ClampedArray(req.width * req.height * 4);
				out[0] = marker;
				this.onmessage?.({
					data: { id: req.id, ok: true, rgba: out.buffer },
				} as MessageEvent);
			}
		}
		let queuedWorker: QueueWorker | null = null;
		globalThis.Worker = function () {
			queuedWorker = new QueueWorker();
			lastInstance = queuedWorker;
			return queuedWorker as unknown as Worker;
		} as unknown as typeof globalThis.Worker;
		__setInpaintWorkerTimeoutForTests(1_000);
		const first = inpaintRegion(
			makeImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2),
			new Uint8ClampedArray(4),
			11,
		);
		const second = inpaintRegion(
			makeImageData(new Uint8ClampedArray(3 * 3 * 4), 3, 3),
			new Uint8ClampedArray(9),
			22,
		);

		expect(queuedWorker).not.toBeNull();
		expect(queuedWorker!.requests.map((req) => req.radius)).toEqual([11, 22]);

		queuedWorker!.reply(1, 202);
		queuedWorker!.reply(0, 101);
		const [firstHealed, secondHealed] = await Promise.all([first, second]);

		expect(firstHealed.data[0]).toBe(101);
		expect(secondHealed.data[0]).toBe(202);
		expect(inpaintTeleaSpy).not.toHaveBeenCalled();
	});

	// THE CI BLIND-SPOT REGRESSION GUARD. The prior bug shipped because the worker
	// was spawned as a MODULE worker while it loaded OpenCV via `importScripts`
	// (classic-only) — an illegal combination that ALWAYS threw at runtime, so every
	// heal silently fell back to the synchronous main-thread path (UI freeze). The
	// jsdom UA guard made the suite skip the worker entirely, so CI never caught it.
	// These assertions fail if the worker's spawn type ever drifts back to "module"
	// (which is incompatible with the importScripts load mechanism) or if the request
	// stops carrying the self-hosted OpenCV url the worker needs to importScripts.
	describe("worker spawn-type / load-mechanism consistency (CI blind-spot guard)", () => {
		it("spawns a CLASSIC worker (importScripts is illegal in a module worker)", async () => {
			const roi = makeImageData(new Uint8ClampedArray(4 * 4 * 4), 4, 4);
			void inpaintRegion(roi, new Uint8ClampedArray(16), 2); // triggers ensureWorker()
			// The exported constant the client spawns with must be classic...
			expect(INPAINT_WORKER_TYPE).toBe("classic");
			expect(INPAINT_WORKER_TYPE).not.toBe("module");
			// ...and the actual spawn must use it (not module).
			await Promise.resolve();
			expect(lastSpawnOptions?.type).toBe("classic");
		});

		it("passes the self-hosted OpenCV url into the worker so it can importScripts", async () => {
			const roi = makeImageData(new Uint8ClampedArray(4 * 4 * 4), 4, 4);
			void inpaintRegion(roi, new Uint8ClampedArray(16), 2);
			await Promise.resolve();
			expect(lastInstance).not.toBeNull();
			const req = lastInstance!.lastRequest as { opencvUrl?: string };
			expect(typeof req.opencvUrl).toBe("string");
			expect(req.opencvUrl).toContain("vendor/opencv/");
			// And it must NOT be a runtime CDN dependency (self-hosted on our origin).
			expect(req.opencvUrl).not.toContain("cdn.jsdelivr.net");
		});
	});
});
