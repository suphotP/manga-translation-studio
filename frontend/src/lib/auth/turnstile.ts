// Cloudflare Turnstile loader + minimal typings. The explicit-render api.js is
// fetched ONCE, on demand (only when an auth form actually needs the widget), so
// non-auth pages never pull the external script. A failed load rejects so the caller
// can decide how to degrade.

export interface TurnstileApi {
	render(el: HTMLElement, opts: Record<string, unknown>): string;
	reset(id?: string): void;
	remove(id?: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loadPromise: Promise<void> | null = null;

export function loadTurnstileScript(): Promise<void> {
	if (typeof window === "undefined") return Promise.resolve();
	if (window.turnstile) return Promise.resolve();
	if (loadPromise) return loadPromise;
	loadPromise = new Promise<void>((resolve, reject) => {
		// On failure, REMOVE the offending <script> before clearing loadPromise so a later
		// retry creates a FRESH tag instead of re-attaching listeners to an already-failed
		// element (whose load/error events never fire again — that would leave the promise,
		// and the auth forms, hung until a full page refresh).
		const fail = (el: Element | null) => {
			el?.parentNode?.removeChild(el);
			loadPromise = null;
			reject(new Error("Failed to load the Turnstile script"));
		};
		const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
		if (existing) {
			existing.addEventListener("load", () => resolve());
			existing.addEventListener("error", () => fail(existing));
			if (window.turnstile) resolve();
			return;
		}
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.addEventListener("load", () => resolve());
		script.addEventListener("error", () => fail(script));
		document.head.appendChild(script);
	});
	return loadPromise;
}
