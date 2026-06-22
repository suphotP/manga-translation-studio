// W2.6 — Cookie/policy consent capture.
//
// One POST endpoint, deliberately small. Frontend writes here every time the
// user accepts/declines categories or the policy_version bumps. The endpoint
// is open (no auth required) because consent must be recordable for
// anonymous visitors too — we tag the row with userId when a session exists.

import { Hono } from "hono";
import { z } from "zod/v4";
import { getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import { readJsonBody } from "../utils/request-body.js";
import { gdprStore, type GdprStore } from "../services/gdpr.js";

const CONSENT_COOKIE_NAME = "consent_v";
const CONSENT_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // one year — re-prompt happens via policy_version bump.

const categoriesSchema = z.object({
	necessary: z.literal(true).optional(), // optional because the frontend may omit it; we coerce to true regardless
	functional: z.boolean(),
	analytics: z.boolean(),
	marketing: z.boolean(),
}).strict();

const consentSchema = z.object({
	categories: categoriesSchema,
	policyVersion: z.string().trim().min(1).max(64),
	consentType: z.string().trim().min(1).max(64).optional(),
	deviceId: z.string().trim().min(1).max(120).optional(),
}).strict();

export interface ConsentRouterDeps {
	store?: GdprStore;
}

export function createConsentRouter(deps: ConsentRouterDeps = {}): Hono {
	const router = new Hono();
	const store = deps.store ?? gdprStore;

	router.use("*", optionalAuth);

	router.post("/events", async (c) => {
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = consentSchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		const user = getAuthUser(c);
		// Spoof-resistant client IP for the consent audit trail. Use the
		// trusted-proxy-aware helper rather than reading x-forwarded-for /
		// x-real-ip raw: those headers are client-controlled and are only honoured
		// when proxy trust is explicitly enabled (serverConfig.trustProxyHeaders).
		// When trust is off this resolves to the real socket address; when on it
		// takes only the FIRST (leftmost) forwarded hop. Reading the headers raw
		// would let any caller forge an arbitrary IP into the GDPR consent record.
		const ip = getTrustedClientIp(c) ?? null;
		const userAgent = c.req.header("user-agent") ?? null;
		const categories = {
			necessary: true, // always recorded as true: this is the legal baseline.
			functional: parsed.data.categories.functional,
			analytics: parsed.data.categories.analytics,
			marketing: parsed.data.categories.marketing,
		};
		const event = await store.recordConsent({
			userId: user?.userId ?? null,
			consentType: parsed.data.consentType ?? "cookie",
			categories,
			ipAddress: ip,
			userAgent,
			policyVersion: parsed.data.policyVersion,
			deviceId: parsed.data.deviceId ?? null,
		});
		// Mirror the consent into a cookie so the SSR layer can read it without a
		// round trip. HttpOnly stays OFF (per spec) so the frontend banner can
		// inspect it; SameSite=Lax + Secure in production keeps it from leaking.
		const cookieValue = encodeURIComponent(JSON.stringify({
			policyVersion: parsed.data.policyVersion,
			categories,
			recordedAt: event.grantedAt,
		}));
		const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
		c.header(
			"Set-Cookie",
			`${CONSENT_COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${CONSENT_COOKIE_MAX_AGE}; SameSite=Lax${secureFlag}`,
		);
		return c.json({ ok: true, event });
	});

	// GET my consent history. Useful for the privacy-center page where users can
	// see what they previously accepted.
	router.get("/events", async (c) => {
		const user = getAuthUser(c);
		if (!user) return c.json({ events: [] });
		const events = await store.listConsentEvents(user.userId);
		return c.json({ events });
	});

	return router;
}

export const consent = createConsentRouter();
