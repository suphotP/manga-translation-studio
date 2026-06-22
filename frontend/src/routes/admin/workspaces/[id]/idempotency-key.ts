// Money-safe idempotency-key lifecycle for the admin grant/refund forms.
//
// WHY THIS EXISTS (P1 money bug): the backend dedupes a credit grant
// (credits.ts) and a refund (dodo.service.ts) by idempotencyKey ALONE. If the
// server committed the mint/refund but the client saw a network/timeout/5xx
// error, the operator re-submits the same form. If each submit minted a brand-
// new key (the old `crypto.randomUUID()` per submit), the backend could NOT
// recognise the retry → it minted/refunded AGAIN → double money-out.
//
// The fix is a STABLE key per logical attempt:
//   * one key is held for the open form,
//   * it is REUSED on every retry after a failure (so a possibly-committed
//     request dedupes on the backend),
//   * it is ROTATED to a fresh key ONLY after a confirmed success (so the next,
//     genuinely-new attempt is independent) or on an explicit form reset.
//
// This module is the pure, framework-free core of that lifecycle so it can be
// unit-tested deterministically (the component wires it to Svelte $state).

export type KeyGen = () => string;

const defaultGen: KeyGen = () => crypto.randomUUID();

/**
 * A single persisted idempotency key whose value only changes on `rotate()`.
 * Construct one per form (grant + refund get independent holders).
 */
export class IdempotencyKeyHolder {
	#key: string;
	#gen: KeyGen;

	constructor(gen: KeyGen = defaultGen) {
		this.#gen = gen;
		this.#key = gen();
	}

	/** The stable key for the current attempt. Safe to read on every retry. */
	get current(): string {
		return this.#key;
	}

	/**
	 * Mint a fresh key for the NEXT, independent attempt. Call ONLY after a
	 * confirmed success or an explicit form reset — never on a failed submit.
	 */
	rotate(): string {
		this.#key = this.#gen();
		return this.#key;
	}
}

/**
 * Pure state-transition the component drives. Given the key used for a submit
 * and whether the server CONFIRMED success, returns the key the form should
 * carry next:
 *   - success  → a fresh key (rotate; next attempt is independent)
 *   - failure  → the SAME key (so a retry dedupes a possibly-committed request)
 *
 * `gen` is injectable for deterministic tests.
 */
export function nextKeyAfterSubmit(
	usedKey: string,
	confirmedSuccess: boolean,
	gen: KeyGen = defaultGen,
): string {
	return confirmedSuccess ? gen() : usedKey;
}
