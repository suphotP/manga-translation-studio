// P1 money-safety (admin SUPPORT console): the grant + refund idempotency keys
// on /admin/support must be STABLE across failed retries so a committed-but-
// errored grant/refund dedupes on the backend (credits.ts grant dedupe,
// dodo.service refund dedupe) and never DOUBLE-MINTS / DOUBLE-REFUNDS from the
// support console — and rotate to a fresh key ONLY on confirmed success or on a
// fresh form open.
//
// The page (+page.svelte) holds one IdempotencyKeyHolder per money form and:
//   * openGrant()/openRefund()  → rotate()  (fresh attempt = fresh key)
//   * submit success            → rotate()  (next attempt is independent)
//   * submit failure            → key UNCHANGED (the retry must dedupe)
//   * submit                    → sends holder.current
// These tests model that exact lifecycle deterministically (the helper's pure
// core is covered by workspaces/[id]/idempotency-key.test.ts; here we pin the
// SUPPORT console's wiring of open/success/failure → key behaviour).

import { describe, it, expect } from "vitest";
import { IdempotencyKeyHolder } from "../workspaces/[id]/idempotency-key.ts";

// Deterministic key generator (sequential ids instead of random UUIDs).
function seqGen(prefix = "k"): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

// Fake key-deduped money ledger mirroring credits.ts grant dedupe /
// dodo.service refund dedupe: a repeated key returns the existing row, never a
// second money-out.
function makeLedger() {
	const rows: { key: string; amount: number }[] = [];
	return {
		commit(key: string, amount: number) {
			const existing = rows.find((r) => r.key === key);
			if (existing) return existing; // dedupe → no second mint/refund
			const r = { key, amount };
			rows.push(r);
			return r;
		},
		count: () => rows.length,
	};
}

// Mirror of the SUPPORT console's per-form key lifecycle. openForm() rotates
// (fresh attempt), submit reads .current, success rotates, failure is a no-op.
function makeSupportForm(gen: () => string) {
	const holder = new IdempotencyKeyHolder(gen);
	return {
		openForm: () => holder.rotate(), // openGrant()/openRefund()
		keyForSubmit: () => holder.current, // idempotencyKey: holder.current
		onSuccess: () => holder.rotate(), // confirmed success → rotate
		// onFailure: intentionally a NO-OP (key kept so the retry dedupes).
	};
}

describe("support console grant — committed-but-errored retry never double-mints", () => {
	it("server commits the grant, client errors, operator retries SAME form → one mint", () => {
		const ledger = makeLedger();
		const grant = makeSupportForm(seqGen("grant"));

		// Operator opens the grant modal and submits +50.
		grant.openForm();
		const key1 = grant.keyForSubmit();
		ledger.commit(key1, 50); // server COMMITS the grant…
		// …then the network drops and the client sees a timeout/5xx → failure
		// path runs: it does NOT rotate the key (modal stays open).

		expect(ledger.count()).toBe(1);

		// Operator clicks submit again on the still-open form. Same key flows.
		const key2 = grant.keyForSubmit();
		expect(key2).toBe(key1); // the fix: stable key across the retry
		ledger.commit(key2, 50);

		// Backend dedupe → still exactly one grant. No double-mint.
		expect(ledger.count()).toBe(1);
	});

	it("a NEW grant after a confirmed success uses a FRESH key (independent mint)", () => {
		const ledger = makeLedger();
		const grant = makeSupportForm(seqGen("grant"));

		grant.openForm();
		const key1 = grant.keyForSubmit();
		ledger.commit(key1, 50);
		grant.onSuccess(); // confirmed success → rotate

		// Operator re-opens the modal for a genuinely-new grant.
		grant.openForm();
		const key2 = grant.keyForSubmit();
		expect(key2).not.toBe(key1);
		ledger.commit(key2, 20);

		expect(ledger.count()).toBe(2); // two distinct, intended mints
	});

	it("re-opening the modal (explicit reset) rotates the key", () => {
		const grant = makeSupportForm(seqGen("grant"));
		grant.openForm();
		const k1 = grant.keyForSubmit();
		grant.openForm(); // fresh open
		expect(grant.keyForSubmit()).not.toBe(k1);
	});
});

describe("support console refund — committed-but-errored retry never double-refunds", () => {
	it("server commits the refund row, client errors, retry SAME form → one refund", () => {
		const ledger = makeLedger();
		const refund = makeSupportForm(seqGen("refund"));

		refund.openForm();
		const key1 = refund.keyForSubmit();
		ledger.commit(key1, 999); // server committed the refund (money OUT)
		// client error → key kept (modal stays open)

		const key2 = refund.keyForSubmit();
		expect(key2).toBe(key1);
		ledger.commit(key2, 999);

		expect(ledger.count()).toBe(1); // single refund, no double money-out
	});

	it("a NEW refund after success uses a fresh key", () => {
		const ledger = makeLedger();
		const refund = makeSupportForm(seqGen("refund"));

		refund.openForm();
		const key1 = refund.keyForSubmit();
		ledger.commit(key1, 999);
		refund.onSuccess();

		refund.openForm();
		const key2 = refund.keyForSubmit();
		expect(key2).not.toBe(key1);
		ledger.commit(key2, 500);

		expect(ledger.count()).toBe(2);
	});
});

describe("grant and refund hold INDEPENDENT keys", () => {
	it("rotating the grant key never touches the refund key", () => {
		const grant = makeSupportForm(seqGen("grant"));
		const refund = makeSupportForm(seqGen("refund"));
		grant.openForm();
		const grantKey = grant.keyForSubmit();
		const refundKey = refund.keyForSubmit();

		grant.openForm(); // churn the grant key
		grant.onSuccess();
		expect(grant.keyForSubmit()).not.toBe(grantKey);
		// Refund key untouched by all the grant activity.
		expect(refund.keyForSubmit()).toBe(refundKey);
	});
});
