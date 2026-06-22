// Regression test for the consent audit-trail client-IP capture (routes/consent.ts).
//
// Before the fix the route recorded the raw x-forwarded-for / x-real-ip header,
// so any caller could forge an arbitrary IP (or a whole chain) into the GDPR
// consent record. The fix routes the IP through the trusted-proxy-aware
// getTrustedClientIp() helper, which — when proxy trust is enabled — takes only
// the FIRST (leftmost) forwarded hop and validates it as a real IP.
//
// In the test runtime proxy-header trust defaults ON (see defaultProxyHeaderTrustEnabled),
// so we assert the recorded IP is the leftmost hop only, never the spoofable later hops.

import { describe, expect, test } from "bun:test";
import { createConsentRouter } from "../routes/consent.js";
import type { GdprStore, RecordConsentInput } from "../services/gdpr.js";

interface Recorded {
	ipAddress: string | null;
}

function stubStore(captured: Recorded[]): GdprStore {
	return {
		async recordConsent(input: RecordConsentInput) {
			captured.push({ ipAddress: input.ipAddress ?? null });
			return {
				id: "evt-1",
				userId: input.userId ?? null,
				consentType: input.consentType,
				categories: input.categories,
				ipAddress: input.ipAddress ?? null,
				userAgent: input.userAgent ?? null,
				policyVersion: input.policyVersion,
				deviceId: input.deviceId ?? null,
				grantedAt: new Date().toISOString(),
			} as never;
		},
	} as unknown as GdprStore;
}

const VALID_BODY = JSON.stringify({
	categories: { functional: true, analytics: false, marketing: false },
	policyVersion: "v1",
});

async function postConsent(headers: Record<string, string>): Promise<Recorded[]> {
	const captured: Recorded[] = [];
	const router = createConsentRouter({ store: stubStore(captured) });
	const res = await router.request("/events", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: VALID_BODY,
	});
	expect(res.status).toBe(200);
	return captured;
}

describe("consent route — client-IP audit trail uses the first hop only", () => {
	test("records only the leftmost x-forwarded-for hop, never the spoofable later hops", async () => {
		const captured = await postConsent({
			"x-forwarded-for": "203.0.113.5, 10.0.0.1, 192.168.1.1",
		});
		expect(captured).toHaveLength(1);
		// Only the first hop is recorded — the later (attacker-appendable) hops are dropped.
		expect(captured[0]!.ipAddress).toBe("203.0.113.5");
		expect(captured[0]!.ipAddress).not.toContain("10.0.0.1");
		expect(captured[0]!.ipAddress).not.toContain(",");
	});

	test("a non-IP forwarded value is not stored verbatim (validated, not trusted)", async () => {
		const captured = await postConsent({
			"x-forwarded-for": "not-an-ip-address",
		});
		expect(captured).toHaveLength(1);
		// The garbage header is rejected by the IP validator → null (or socket addr),
		// never the raw spoofed string.
		expect(captured[0]!.ipAddress).not.toBe("not-an-ip-address");
	});
});
