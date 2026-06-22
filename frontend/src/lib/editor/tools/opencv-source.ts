// Single source of truth for the pinned OpenCV.js build + its self-hosted URL.
//
// We SELF-HOST OpenCV.js (vendored into `static/vendor/opencv/`) instead of
// fetching it from jsDelivr at runtime. A prod app must not depend on a public
// CDN being reachable for a core editing tool: a blocked/slow CDN used to stall
// the first heal by seconds and could silently kill it entirely. The vendored
// build is a single self-contained UMD file (the wasm is embedded as a base64
// data URI), so loading it works fully offline once the app's own assets serve.
//
// This module is intentionally tiny and DOM-free so BOTH the DOM loader
// (`opencv-loader.ts`) and the off-thread worker client can import it without
// pulling in browser-only APIs. The classic inpaint worker itself never imports
// this — it receives the resolved URL via its first message — so the worker
// stays a pure classic script (legal `importScripts`).

// @techstark/opencv-js publishes its 4.x line with `-release.N` suffixes (there
// is no plain `4.10.0` on npm). Keep this in lockstep with the vendored file
// name in `static/vendor/opencv/opencv-<version>.js`.
export const OPENCV_VERSION = "4.10.0-release.1";

/**
 * Path (relative to the app root) of the vendored OpenCV.js the editor serves.
 * SvelteKit serves everything under `static/` at the site root, so this resolves
 * to e.g. `/vendor/opencv/opencv-4.10.0-release.1.js`.
 */
export const OPENCV_VENDOR_PATH = `vendor/opencv/opencv-${OPENCV_VERSION}.js`;

/**
 * Resolve the self-hosted OpenCV.js URL for the current runtime. Honors a
 * SvelteKit `base` path when one is configured (e.g. served under a sub-path)
 * and returns an ABSOLUTE url (origin-qualified) so it is equally valid when
 * handed to `importScripts` inside a Web Worker, which has its own base URL.
 *
 * `base` defaults to `""` (root deploy). Pass `$app/paths`'s `base` from a
 * browser context to honor a sub-path deploy.
 */
export function resolveOpenCvUrl(base = ""): string {
	const prefix = base ? `${base.replace(/\/$/, "")}/` : "/";
	const path = `${prefix}${OPENCV_VENDOR_PATH}`;
	if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
		return new URL(path, location.origin).href;
	}
	return path;
}
