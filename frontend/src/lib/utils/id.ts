/**
 * Insecure-context-safe RFC4122 v4 id generation.
 *
 * `crypto.randomUUID()` is ONLY defined in secure contexts (https / localhost).
 * On plain http, inside older webviews, and in some embedded/in-app browsers it
 * is `undefined`, so calling it directly throws and breaks the editor at the
 * point of use (adding a text layer, snapshotting history, etc.).
 *
 * `safeRandomId()` prefers the native UUID, then falls back to a
 * `crypto.getRandomValues`-based RFC4122 v4 string (still cryptographically
 * strong), and only as a LAST resort uses a timestamp + monotonic counter +
 * Math.random tail. The fallbacks keep the same shape and uniqueness guarantees
 * needed for layer/object ids, so id-equality and dedup logic stay correct.
 */

let fallbackCounter = 0;

const HEX: string[] = [];
for (let i = 0; i < 256; i += 1) {
	HEX.push((i + 0x100).toString(16).slice(1));
}

function getCrypto(): Crypto | undefined {
	if (typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined") {
		return globalThis.crypto as Crypto;
	}
	if (typeof crypto !== "undefined") {
		return crypto as Crypto;
	}
	return undefined;
}

/**
 * RFC4122 v4 uuid built from 16 random bytes. Used when `randomUUID` is missing
 * but `getRandomValues` exists (the common insecure-context case).
 */
function uuidFromRandomBytes(bytes: Uint8Array): string {
	// Per RFC4122 §4.4: set version (4) and variant (10xx) bits.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	return (
		HEX[bytes[0]] + HEX[bytes[1]] + HEX[bytes[2]] + HEX[bytes[3]] +
		"-" +
		HEX[bytes[4]] + HEX[bytes[5]] +
		"-" +
		HEX[bytes[6]] + HEX[bytes[7]] +
		"-" +
		HEX[bytes[8]] + HEX[bytes[9]] +
		"-" +
		HEX[bytes[10]] + HEX[bytes[11]] + HEX[bytes[12]] + HEX[bytes[13]] + HEX[bytes[14]] + HEX[bytes[15]]
	);
}

/**
 * Last-resort id when no Web Crypto is available at all. NOT cryptographically
 * strong, but unique within a session: monotonic counter + high-res-ish time +
 * a random tail keep collisions effectively impossible for editor object ids.
 */
function timestampFallbackId(): string {
	fallbackCounter = (fallbackCounter + 1) % 0xffffffff;
	const time = Date.now().toString(16).padStart(12, "0");
	const counter = fallbackCounter.toString(16).padStart(8, "0");
	const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
	return `id-${time}-${counter}-${rand}`;
}

/**
 * Return a unique id, using the strongest source available in this context.
 */
export function safeRandomId(): string {
	const c = getCrypto();

	if (c && typeof c.randomUUID === "function") {
		try {
			return c.randomUUID();
		} catch {
			// fall through to getRandomValues / timestamp fallback
		}
	}

	if (c && typeof c.getRandomValues === "function") {
		try {
			const bytes = new Uint8Array(16);
			c.getRandomValues(bytes);
			return uuidFromRandomBytes(bytes);
		} catch {
			// fall through to timestamp fallback
		}
	}

	return timestampFallbackId();
}

/** Convenience: a prefixed id (e.g. `tab-…`, `job-…`). */
export function safeRandomIdWithPrefix(prefix: string): string {
	return `${prefix}${safeRandomId()}`;
}
