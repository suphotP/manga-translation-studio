// Shared dispute-resolution logic for the revenue layer.
//
// The live webhook path (dodo.service.ts `resolveChargeback`) and the historical
// backfill (backfill-payment-transactions.ts) BOTH have to decide, for a Dodo
// dispute event, whether it OPENS a chargeback (negative revenue row), RESOLVES it
// favorably (a +reversal row that nets the deduction back to the payment), or is a
// real LOSS (no reversal). Duplicating that classification in two places is exactly
// how live + backfill drift apart, so it lives here as ONE source of truth that both
// import. The dispute amount→cents conversion is currency-aware via `minorUnitsFor`
// so a JPY/zero-decimal dispute isn't inflated 100x.

import { majorDecimalToCents, minorUnitsFor, normalizeCents } from "./money.js";

// Chargeback OPEN events — record a NEGATIVE dispute revenue row.
export const DISPUTE_OPEN_EVENTS = new Set([
	"payment.chargeback.created",
	"dispute.opened",
	"dispute.created",
	"dispute.needs_response",
	"dispute.under_review",
	"dispute.challenged",
]);

// Resolution events — Dodo closes the dispute (won/lost/accepted/cancelled/expired,
// or the generic payment.chargeback.resolved whose outcome lives in its status).
export const DISPUTE_RESOLVED_EVENTS = new Set([
	"dispute.won",
	"dispute.lost",
	"dispute.accepted",
	"dispute.cancelled",
	"dispute.canceled",
	"dispute.expired",
	"payment.chargeback.resolved",
]);

// Resolution outcomes that keep the charge GONE (terminal loss): no reversal, the
// negative dispute row stays. Everything else favorable (won/cancelled/expired)
// reverses.
export const DISPUTE_LOST_EVENTS = new Set([
	"dispute.lost",
	"dispute.accepted",
]);

/** Derive a dispute status string from the event type suffix (canonicalizing the US spelling). */
export function eventTypeToDisputeStatus(eventType: string): string {
	const suffix = eventType.split(".").pop() ?? eventType;
	return suffix === "canceled" ? "cancelled" : suffix;
}

// A dispute status string names a FAVORABLE (merchant-kept-the-money) outcome. Used
// only to disambiguate the generic `payment.chargeback.resolved` event, whose
// win/loss outcome lives in its status rather than the event type. Anything not
// explicitly favorable (lost/charge_refunded/unknown/empty) is treated as a loss so
// we never credit revenue back on an ambiguous resolution.
export function isFavorableDisputeStatus(status: string | null | undefined): boolean {
	if (!status) return false;
	const normalized = status.trim().toLowerCase();
	return (
		normalized === "won"
		|| normalized === "win"
		|| normalized === "reversed"
		|| normalized === "cancelled"
		|| normalized === "canceled"
		|| normalized === "expired"
	);
}

/**
 * Decide whether a RESOLUTION event is a terminal LOSS (revenue stays deducted, no
 * reversal). Fail-closed: an explicit lost/accepted event type is always lost; the
 * generic `payment.chargeback.resolved` is lost unless its status is explicitly
 * favorable (so an unknown/empty status never credits money back). Explicit
 * won/cancelled/expired event types are never lost.
 *
 * This is the SAME predicate the live path and the backfill use, so a resolution can
 * never be reversed in one path and not the other.
 */
export function isLostDisputeResolution(eventType: string, resolvedStatus: string | null | undefined): boolean {
	return (
		DISPUTE_LOST_EVENTS.has(eventType)
		|| (eventType === "payment.chargeback.resolved" && !isFavorableDisputeStatus(resolvedStatus))
	);
}

// Dodo Dispute.amount is documented as a STRING of the MAJOR-unit amount (e.g.
// "19.99"), unlike payment amounts which are minor-unit integers. Prefer an explicit
// minor-unit field if present, else parse the decimal string to cents DECIMAL-SAFELY
// and CURRENCY-AWARELY (no `Number(x) * 100` float multiply, and JPY "1900" → 1900
// not 190000). Returns an integer cents STRING (positive magnitude) or null when no
// amount is present.
export function readDisputeMinorUnits(
	subject: Record<string, unknown>,
	readMinorUnits: (source: Record<string, unknown>, keys: string[]) => string | undefined,
	currency: string | null | undefined,
): string | null {
	// An explicit minor-unit field is already integer cents — read it as-is.
	const minor = readMinorUnits(subject, ["amount_cents", "amountMinor", "total_amount"]);
	if (minor !== undefined) return normalizeCents(minor);
	const minorDigits = minorUnitsFor(currency);
	const raw = subject.amount;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		// A numeric `amount` here is ambiguous; Dodo documents disputes as decimal
		// (major-unit) strings, so treat a bare number as a major-unit decimal.
		return majorDecimalToCents(raw, minorDigits);
	}
	if (typeof raw === "string" && raw.trim()) {
		return majorDecimalToCents(raw, minorDigits);
	}
	return null;
}
