// signedAssetSrc action — token re-mint retry on an expired-token <img> error.
//
// P1 broken-images guard. Components used to put a raw `onerror` on the SIGNED
// <img>, flipping straight to a placeholder on the FIRST error — which unmounted
// the element mid-retry and aborted the action's token re-mint, so an expired
// token left the image permanently broken. The fix routes failure through the
// action's `onFailed`, which fires ONLY after the single re-mint retry is also
// exhausted. These tests assert that retry path runs (and that a bare-URL error
// fails fast with no retry).

import { describe, it, expect, vi, beforeEach } from "vitest";

const signedAssetUrl = vi.fn();
const invalidateAssetToken = vi.fn();

vi.mock("$lib/api/client.js", () => ({
	signedAssetUrl: (...args: unknown[]) => signedAssetUrl(...args),
	invalidateAssetToken: (...args: unknown[]) => invalidateAssetToken(...args),
}));

import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";

const params = (overrides: Partial<SignedAssetSrcParams> = {}): SignedAssetSrcParams => ({
	projectId: "proj-1",
	imageId: "img-1",
	url: "/api/images/proj-1/img-1/thumbnail",
	purpose: "thumbnail",
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	// IntersectionObserver is unavailable in jsdom → the action behaves eagerly
	// (mints + sets src immediately), which is exactly what we want to drive.
});

/** Flush the action's async apply() microtasks. */
async function flush() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("signedAssetSrc token re-mint retry", () => {
	it("re-mints a fresh token once when a tokened <img> errors (expired-token recovery)", async () => {
		signedAssetUrl
			.mockResolvedValueOnce("/api/images/proj-1/img-1/thumbnail?assetToken=stale")
			.mockResolvedValueOnce("/api/images/proj-1/img-1/thumbnail?assetToken=fresh");
		const onFailed = vi.fn();
		const img = document.createElement("img");

		const handle = signedAssetSrc(img, params({ onFailed }));
		await flush();
		expect(img.getAttribute("src")).toContain("assetToken=stale");

		// The token expired between mint and load → the browser fires `error`.
		img.dispatchEvent(new Event("error"));
		await flush();

		// The action invalidated the stale token and re-signed with forceRefresh=true.
		expect(invalidateAssetToken).toHaveBeenCalledWith("proj-1", "img-1", "thumbnail");
		expect(signedAssetUrl).toHaveBeenLastCalledWith(
			"/api/images/proj-1/img-1/thumbnail",
			"proj-1",
			"img-1",
			"thumbnail",
			true,
		);
		expect(img.getAttribute("src")).toContain("assetToken=fresh");
		// Not failed yet — the retry is in play (the bug was failing here immediately).
		expect(onFailed).not.toHaveBeenCalled();

		handle.destroy();
	});

	it("calls onFailed only AFTER the retry is also exhausted (single re-mint, then give up)", async () => {
		signedAssetUrl
			.mockResolvedValueOnce("/api/images/proj-1/img-1/thumbnail?assetToken=stale")
			.mockResolvedValueOnce("/api/images/proj-1/img-1/thumbnail?assetToken=fresh");
		const onFailed = vi.fn();
		const img = document.createElement("img");

		const handle = signedAssetSrc(img, params({ onFailed }));
		await flush();

		// First error → re-mint (no onFailed yet).
		img.dispatchEvent(new Event("error"));
		await flush();
		expect(onFailed).not.toHaveBeenCalled();
		expect(signedAssetUrl).toHaveBeenCalledTimes(2);

		// Second error (the refreshed token also failed) → now give up via onFailed.
		img.dispatchEvent(new Event("error"));
		await flush();
		expect(onFailed).toHaveBeenCalledTimes(1);
		// No third mint — the retry budget is one.
		expect(signedAssetUrl).toHaveBeenCalledTimes(2);

		handle.destroy();
	});

	it("a bare-URL (no token) error fails fast with no retry", async () => {
		// Mint failed → a bare URL on src. An error there is a genuine load failure,
		// not a token expiry, so the action must NOT re-mint; it notifies onFailed.
		signedAssetUrl.mockResolvedValue("/api/images/proj-1/img-1/thumbnail");
		const onFailed = vi.fn();
		const img = document.createElement("img");

		const handle = signedAssetSrc(img, params({ onFailed }));
		await flush();

		img.dispatchEvent(new Event("error"));
		await flush();

		expect(invalidateAssetToken).not.toHaveBeenCalled();
		expect(onFailed).toHaveBeenCalledTimes(1);
		// Only the initial mint — no retry for a tokenless URL.
		expect(signedAssetUrl).toHaveBeenCalledTimes(1);

		handle.destroy();
	});
});
