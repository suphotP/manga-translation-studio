// Regression guard for the SECOND P1 bug: OpenCV.js's Emscripten `Module` is a
// thenable that resolves with ITSELF (the resolution value is still the same
// thenable). If the loader does `resolve(module)` / `Promise.resolve(module)`
// directly, the Promise spec recursively assimilates it — calling `module.then`
// forever — so the awaiting promise NEVER settles and the heal hangs (the worker
// then "times out" and falls back to the synchronous main thread). The loader
// must de-thenable the module before resolving.
//
// This test installs a fake self-thenable `cv` and a fake <script> whose `onload`
// fires synchronously, then asserts `loadOpenCv()` actually RESOLVES (bounded).
// Before the fix this hangs (and the test times out).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadOpenCv, __resetOpenCvLoaderForTests } from "$lib/editor/tools/opencv-loader.ts";

// A fake OpenCV Module that is a self-thenable: `.then(cb)` invokes cb with the
// SAME object (which is still thenable) — exactly OpenCV.js's footgun.
function makeSelfThenableCv() {
	const cv: any = {
		Mat: function () {},
		matFromImageData: () => ({}),
	};
	cv.then = (onFulfilled: (m: any) => void) => {
		// resolve with itself (still has `.then`) on a microtask, like Emscripten.
		queueMicrotask(() => onFulfilled(cv));
		return cv;
	};
	return cv;
}

describe("opencv-loader resolves a self-thenable Module (P1 assimilation hang guard)", () => {
	let realCreateElement: typeof document.createElement;
	let realAppendChild: typeof document.head.appendChild;
	let scriptEl: any;

	beforeEach(() => {
		__resetOpenCvLoaderForTests();
		(globalThis as any).cv = undefined;
		// Fake the cached-read path away so it goes through the fetch+inject path.
		vi.stubGlobal("indexedDB", undefined);
		// Fetch returns some source text (content irrelevant — we fake the eval).
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, text: async () => "/* opencv */" })),
		);
		realCreateElement = document.createElement.bind(document);
		realAppendChild = document.head.appendChild.bind(document.head);
		// When the loader creates the <script> and appends it, install the fake
		// self-thenable cv global and synchronously fire onload — emulating the
		// browser finishing the (blob) script load.
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			if (tag === "script") {
				scriptEl = { src: "", async: false, onload: null as null | (() => void), onerror: null };
				return scriptEl;
			}
			return realCreateElement(tag);
		}) as any);
		vi.spyOn(document.head, "appendChild").mockImplementation(((node: any) => {
			if (node === scriptEl) {
				(globalThis as any).cv = makeSelfThenableCv();
				queueMicrotask(() => scriptEl.onload?.());
				return node;
			}
			return realAppendChild(node);
		}) as any);
		// URL.createObjectURL isn't in jsdom by default.
		if (typeof URL.createObjectURL !== "function") {
			(URL as any).createObjectURL = () => "blob:fake";
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		__resetOpenCvLoaderForTests();
		(globalThis as any).cv = undefined;
	});

	it("settles (does not hang) when cv is a self-thenable Module", async () => {
		// If the loader assimilated the thenable, this await would never settle and
		// the test would hit vitest's timeout. We additionally race a short timer so
		// a regression fails FAST and loud instead of as an opaque suite timeout.
		const cv = await Promise.race([
			loadOpenCv(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("loadOpenCv hung on a self-thenable cv (assimilation regression)")), 2000),
			),
		]);
		expect((cv as any).Mat).toBeTypeOf("function");
		// And the resolved module must no longer be thenable (de-thenable'd).
		expect(typeof (cv as any).then).not.toBe("function");
	});
});
