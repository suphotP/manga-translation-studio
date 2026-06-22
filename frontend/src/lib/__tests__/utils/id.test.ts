import { describe, it, expect, afterEach, vi } from "vitest";
import { safeRandomId, safeRandomIdWithPrefix } from "$lib/utils/id.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("safeRandomId", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses native crypto.randomUUID when available", () => {
		const spy = vi.spyOn(globalThis.crypto, "randomUUID");
		const id = safeRandomId();
		expect(spy).toHaveBeenCalled();
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("does NOT throw and returns a valid v4 uuid when randomUUID is undefined (insecure context)", () => {
		// Simulate an insecure context: randomUUID missing, getRandomValues present.
		vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
			throw new TypeError("randomUUID is not a function");
		});

		let id = "";
		expect(() => {
			id = safeRandomId();
		}).not.toThrow();
		expect(id).toMatch(UUID_RE);
	});

	it("falls back to getRandomValues-based RFC4122 v4 with correct version/variant bits", () => {
		(globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID = undefined;
		const id = safeRandomId();
		expect(id).toMatch(UUID_RE);
		// version nibble is '4'
		expect(id[14]).toBe("4");
		// variant nibble is one of 8,9,a,b
		expect("89ab").toContain(id[19]);
	});

	it("uses a timestamp+counter fallback (no throw) when no Web Crypto exists", () => {
		const original = globalThis.crypto;
		try {
			// @ts-expect-error — intentionally remove crypto to exercise last resort
			delete globalThis.crypto;
			let a = "";
			let b = "";
			expect(() => {
				a = safeRandomId();
				b = safeRandomId();
			}).not.toThrow();
			expect(a).toMatch(/^id-/);
			expect(b).toMatch(/^id-/);
			// monotonic counter keeps them distinct
			expect(a).not.toBe(b);
		} finally {
			Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
		}
	});

	it("returns unique ids across many calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i += 1) ids.add(safeRandomId());
		expect(ids.size).toBe(1000);
	});

	it("prefixes ids", () => {
		expect(safeRandomIdWithPrefix("tab-")).toMatch(/^tab-/);
	});
});
