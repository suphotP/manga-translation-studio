// Svelte action that loads an authenticated backend asset into a plain `<img>`
// by attaching a short-lived signed `assetToken` query param.
//
// WHY: a browser `<img src>` cannot send an `Authorization: Bearer` header, so a
// bare `/api/images/.../thumbnail` (or `/images/:projectId/:imageId`) URL 401s
// for an owned project. The backend mints HMAC-signed, per-(project,image,
// purpose), short-lived tokens via the authed `/access-token` route; appending
// `?assetToken=<token>` authorizes the load without a header. This action wraps
// that flow so callers keep writing `<img use:signedAssetSrc={{...}}>` instead of
// awaiting a token per cell.
//
// COMPOSES with existing placeholder fallbacks: the component still attaches its
// own `onerror` (P{n} / placeholder). This action only intercepts the FIRST
// `error` to retry once with a freshly-minted token (covers token expiry); if
// the retry also fails it stops touching `src`, so the browser's `error` event
// reaches the component handler exactly as before. Setting `params` to a falsy
// `imageId` clears `src` (component renders its placeholder branch).

import {
	invalidateAssetToken,
	signedAssetUrl,
	type AssetAccessPurpose,
} from "$lib/api/client.js";

export interface SignedAssetSrcParams {
	projectId: string;
	imageId: string;
	/** Bare API asset URL to sign (e.g. api.thumbnailUrl(...) or api.imageUrl(...)). */
	url: string;
	/** Token scope; defaults to "thumbnail". */
	purpose?: AssetAccessPurpose;
	/**
	 * Called once the load has DEFINITIVELY failed — i.e. after the action's own
	 * single token re-mint/retry has been exhausted (or when the very first error
	 * was a bare-URL load with no token to retry). Components should flip to their
	 * placeholder branch from HERE, not from the raw `<img onerror>`, so they don't
	 * unmount the element mid-retry and abort the re-mint.
	 */
	onFailed?: () => void;
}

interface SignedAssetState {
	params: SignedAssetSrcParams | null | undefined;
	loadId: number;
	retried: boolean;
	// Whether the URL currently on the element carries an assetToken. Only then
	// is an `error` plausibly a token-expiry worth one silent re-mint; a bare URL
	// (mint failed) error is a real load failure → let it reach the component's
	// placeholder onerror immediately (no retry).
	hasToken: boolean;
	// Lazy gating: until the element scrolls near the viewport we DON'T mint a
	// token or set `src`. On a 100-cover library grid this turns 100 eager
	// token-mints + fetches + decodes on first paint into only the handful that
	// are actually visible; the rest mint as they scroll in.
	visible: boolean;
	onError: () => void;
}

// `loading="lazy"` only defers the browser FETCH of an already-set `src`; it does
// nothing about our authed token-mint round-trip, which would still fire for every
// off-screen card. So we gate the whole apply() behind an IntersectionObserver
// with a generous rootMargin (mint slightly before the card enters the viewport so
// it's ready by the time it's visible). When IntersectionObserver is unavailable
// (jsdom/tests/old engines) we fall back to eager behavior.
const LAZY_ROOT_MARGIN = "600px";

function sameTarget(a: SignedAssetSrcParams, b: SignedAssetSrcParams): boolean {
	return a.projectId === b.projectId
		&& a.imageId === b.imageId
		&& a.url === b.url
		&& (a.purpose ?? "thumbnail") === (b.purpose ?? "thumbnail");
}

export function signedAssetSrc(node: HTMLImageElement, params: SignedAssetSrcParams | null | undefined) {
	const supportsLazy = typeof IntersectionObserver !== "undefined";
	const state: SignedAssetState = {
		params,
		loadId: 0,
		retried: false,
		hasToken: false,
		// Without IntersectionObserver (tests/old engines) behave eagerly so nothing
		// regresses; with it, start hidden and let the observer flip us visible.
		visible: !supportsLazy,
		onError: () => {},
	};

	async function apply(forceRefresh: boolean) {
		const current = state.params;
		const loadId = ++state.loadId;
		if (!current || !current.projectId || !current.imageId || !current.url) {
			// No asset: leave it to the component's placeholder branch.
			node.removeAttribute("src");
			return;
		}
		// Off-screen: defer the token mint + src until the observer reveals us. The
		// pending params are already on state, so revealing re-runs apply().
		if (!state.visible) {
			node.removeAttribute("src");
			return;
		}
		const signed = await signedAssetUrl(
			current.url,
			current.projectId,
			current.imageId,
			current.purpose ?? "thumbnail",
			forceRefresh,
		);
		// A newer params update superseded this load; drop the stale result.
		if (loadId !== state.loadId) return;
		state.hasToken = signed.includes("assetToken=");
		node.src = signed;
	}

	state.onError = () => {
		const current = state.params;
		if (!current) return;
		// Only re-mint once, and only when a token was actually attached. A bare-URL
		// error, or an error after the retry already ran, is a genuine load failure →
		// notify the component (it flips to its placeholder branch) instead of leaving
		// it to the raw onerror, which would unmount mid-retry and abort the re-mint.
		if (state.retried || !state.hasToken) {
			current.onFailed?.();
			return;
		}
		state.retried = true;
		// Token may have expired between mint and load — drop it and re-sign once.
		invalidateAssetToken(current.projectId, current.imageId, current.purpose ?? "thumbnail");
		void apply(true);
	};

	node.addEventListener("error", state.onError);

	// Lazy reveal: mint + load only once the card is near the viewport. Disconnect
	// after the first reveal — once we've started loading, the element stays loaded.
	let observer: IntersectionObserver | null = null;
	if (supportsLazy) {
		observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer?.disconnect();
				observer = null;
				if (state.visible) return;
				state.visible = true;
				void apply(false);
			},
			{ rootMargin: LAZY_ROOT_MARGIN },
		);
		observer.observe(node);
	}

	void apply(false);

	return {
		update(next: SignedAssetSrcParams | null | undefined) {
			const prev = state.params;
			state.params = next;
			// Only re-fetch when the target actually changed (avoids re-minting on
			// unrelated reactive updates / re-renders).
			if (prev && next && sameTarget(prev, next)) return;
			state.retried = false;
			void apply(false);
		},
		destroy() {
			node.removeEventListener("error", state.onError);
			observer?.disconnect();
			observer = null;
			state.loadId++;
		},
	};
}
