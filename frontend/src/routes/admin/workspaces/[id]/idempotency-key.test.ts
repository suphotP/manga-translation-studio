// P1 money-safety: the admin grant/refund idempotency key must be STABLE across
// failed retries (so a committed-but-errored request dedupes on the backend and
// never double-mints / double-refunds) and only rotate after a confirmed
// success or an explicit reset. These tests pin that lifecycle and simulate the
// exact double-money scenario codex flagged on PR #301.

import { describe, it, expect, vi } from "vitest";
import { IdempotencyKeyHolder, nextKeyAfterSubmit } from "./idempotency-key.ts";

// Deterministic key generator: sequential ids instead of random UUIDs.
function seqGen(prefix = "k"): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

describe("IdempotencyKeyHolder", () => {
	it("mints a key on construction and keeps it stable until rotate()", () => {
		const h = new IdempotencyKeyHolder(seqGen());
		expect(h.current).toBe("k-1");
		// Reading many times (e.g. multiple retries) never changes the key.
		expect(h.current).toBe("k-1");
		expect(h.current).toBe("k-1");
	});

	it("rotate() advances to a fresh key (independent next attempt)", () => {
		const h = new IdempotencyKeyHolder(seqGen());
		expect(h.current).toBe("k-1");
		expect(h.rotate()).toBe("k-2");
		expect(h.current).toBe("k-2");
	});

	it("grant and refund holders are independent", () => {
		const grant = new IdempotencyKeyHolder(seqGen("grant"));
		const refund = new IdempotencyKeyHolder(seqGen("refund"));
		grant.rotate();
		expect(grant.current).toBe("grant-2");
		// Refund untouched by grant activity.
		expect(refund.current).toBe("refund-1");
	});
});

describe("nextKeyAfterSubmit", () => {
	const gen = () => "FRESH";
	it("keeps the SAME key after a failure (retry must dedupe)", () => {
		expect(nextKeyAfterSubmit("used-key", false, gen)).toBe("used-key");
	});
	it("rotates to a FRESH key after a confirmed success", () => {
		expect(nextKeyAfterSubmit("used-key", true, gen)).toBe("FRESH");
	});
});

// ── End-to-end simulation of the component's submit loop ─────────────────────
// We model the exact P1: the server COMMITS the grant, then the network drops so
// the client sees an error. The operator retries the same form. We assert the
// backend (a key-dedupe ledger like credits.ts) is asked with the SAME key both
// times → it returns the existing grant → no double-mint.

type Grant = { key: string; amount: number };

/** Fake key-based ledger mirroring credits.ts dedupe-on-idempotencyKey. */
function makeLedger() {
	const grants: Grant[] = [];
	return {
		grants,
		grant(key: string, amount: number): Grant {
			const existing = grants.find((g) => g.key === key);
			if (existing) return existing; // dedupe: no second mint
			const g = { key, amount };
			grants.push(g);
			return g;
		},
		minted: () => grants.length,
	};
}

/** Mirror of the component's submitGrant key lifecycle (sync, test-only). */
function makeGrantForm(gen: () => string) {
	const holder = new IdempotencyKeyHolder(gen);
	return {
		keyForSubmit: () => holder.current,
		onSuccess: () => holder.rotate(),
		// onFailure: intentionally does NOTHING to the key.
		onReset: () => holder.rotate(),
	};
}

describe("committed-but-errored retry never double-mints (grant)", () => {
	it("reuses the key on retry → ledger dedupes → balance unchanged", () => {
		const ledger = makeLedger();
		const form = makeGrantForm(seqGen());

		// Attempt #1: server COMMITS the grant...
		const key1 = form.keyForSubmit();
		ledger.grant(key1, 50); // committed on the server
		// ...but the client sees a network error → form.onFailure (key kept).
		// (no onSuccess call)

		expect(ledger.minted()).toBe(1);

		// Attempt #2: operator retries the SAME form. Same key flows through.
		const key2 = form.keyForSubmit();
		expect(key2).toBe(key1); // <-- the fix: stable key across the retry
		const result = ledger.grant(key2, 50);
		expect(result.amount).toBe(50);

		// No double-mint: still exactly one grant, balance unchanged.
		expect(ledger.minted()).toBe(1);
	});

	it("a NEW grant after a confirmed success uses a FRESH key (independent mint)", () => {
		const ledger = makeLedger();
		const form = makeGrantForm(seqGen());

		const key1 = form.keyForSubmit();
		ledger.grant(key1, 50);
		form.onSuccess(); // confirmed → rotate

		const key2 = form.keyForSubmit();
		expect(key2).not.toBe(key1);
		ledger.grant(key2, 20);

		// Two genuinely-distinct grants minted.
		expect(ledger.minted()).toBe(2);
	});

	it("an explicit reset rotates the key (abandoned attempt won't collide)", () => {
		const form = makeGrantForm(seqGen());
		const k1 = form.keyForSubmit();
		form.onReset();
		expect(form.keyForSubmit()).not.toBe(k1);
	});
});

describe("committed-but-errored retry never double-refunds (refund)", () => {
	// Same shape as grant; refund backend (dodo.service.ts) also dedupes by key.
	it("reuses the key on retry → no second refund row", () => {
		const ledger = makeLedger();
		const form = makeGrantForm(seqGen("refund"));

		const key1 = form.keyForSubmit();
		ledger.grant(key1, 999); // server committed the refund row
		// client error → key kept

		const key2 = form.keyForSubmit();
		expect(key2).toBe(key1);
		ledger.grant(key2, 999);

		expect(ledger.minted()).toBe(1); // single refund, no double money-out
	});
});

describe("default generator uses crypto.randomUUID", () => {
	it("produces distinct keys per holder by default", () => {
		const spy = vi
			.spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("uuid-a-0000-0000-0000-000000000000")
			.mockReturnValueOnce("uuid-b-0000-0000-0000-000000000000");
		const a = new IdempotencyKeyHolder();
		const b = new IdempotencyKeyHolder();
		expect(a.current).not.toBe(b.current);
		spy.mockRestore();
	});
});
