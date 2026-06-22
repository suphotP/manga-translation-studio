import { createHmac, timingSafeEqual } from "crypto";
import {
	defaultR2PresignedDeliveryEnabled,
	isR2FullyConfigured,
	r2PresignedDeliveryEnabled,
	readPositiveIntegerConfigValue,
	readR2EnvConfig,
	readR2PresignConfig,
	serverConfig,
} from "../config.js";
import {
	assertProjectEgressNotThrottled,
	type EgressAbuseDecision,
} from "./egress-accounting.js";

export type AssetAccessPurpose =
	| "original"
	| "thumbnail"
	| "editor_preview"
	| "export"
	| "ai_output";

export interface AssetAccessTokenPayload {
	projectId: string;
	imageId: string;
	purpose: AssetAccessPurpose;
	iat: number;
	exp: number;
	sub?: string;
}

export interface AssetAccessTokenInput {
	projectId: string;
	imageId: string;
	purpose: AssetAccessPurpose;
	subject?: string;
	ttlSeconds?: number;
	now?: number;
}

export interface AssetAccessVerificationInput {
	token: string | undefined;
	projectId: string;
	imageId: string;
	purposes: AssetAccessPurpose[];
	now?: number;
}

export interface AssetAccessVerificationResult {
	ok: boolean;
	reason?: "missing" | "malformed" | "bad_signature" | "expired" | "scope_mismatch";
	payload?: AssetAccessTokenPayload;
}

export interface AssetAccessConfig {
	enforced: boolean;
	defaultTtlSeconds: number;
	maxTtlSeconds: number;
}

export interface AssetDeliveryConfig {
	cdnProxyBaseUrl: string;
}

export interface SignedAssetDeliveryInput {
	origin: string;
	path: string;
	token: string;
}

export interface SignedAssetDeliveryUrls {
	signedPath: string;
	signedUrl: string;
	signedCdnUrl?: string;
	deliveryMode: "signed_proxy";
	cdnProxyConfigured: boolean;
}

export type AssetDeliveryMode = "signed_proxy" | "presigned_r2";

export interface PresignedR2Delivery {
	mode: "presigned_r2";
	url: string;
	expiresAt: number;
	ttlSeconds: number;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_TTL_SECONDS = 3600;

// Whether backend-issued signed delivery is actually wired up. Production
// auto-enforcement is gated on this so we never hard-break asset serving on a
// deployment where signing/R2 has not been configured yet (fail safe). Signed
// delivery is considered configured when R2 (the production private-bucket
// path) is the storage driver AND fully credentialed, OR an explicit asset
// signing secret has been provisioned for the through-backend signed path.
export function signedAssetDeliveryConfigured(
	storageDriver = process.env.STORAGE_DRIVER || "local",
	r2 = readR2EnvConfig(),
	signingSecret = process.env.ASSET_SIGNING_SECRET,
): boolean {
	if (storageDriver === "r2" && isR2FullyConfigured(r2)) return true;
	return Boolean(signingSecret && signingSecret.trim().length > 0);
}

// Signed-asset access enforcement is PURELY OPT-IN: the default is always OFF,
// even in production with R2 / a signing secret fully configured. Turning
// enforcement on (via ASSET_SIGNED_URLS_ENFORCED=true) makes bare
// `/api/images/:projectId/:imageId` and `/thumbnail` requests 401 unless they
// carry a valid signed asset token.
//
// PREREQUISITE (do not auto-enable): the frontend currently builds bare image /
// thumbnail URLs and never calls the `/access-token` route, so flipping
// enforcement on without a frontend slice that requests AND attaches signed
// tokens would 401 every image and wipe the workspace. Enforcement must stay
// off until that frontend slice ships (tracked as a follow-up). We therefore do
// NOT auto-enable in production; `signedAssetDeliveryConfigured` is retained
// only for the fail-safe observability warning below, not as an enabler.
export function defaultAssetAccessEnforcementEnabled(
	_nodeEnv = process.env.NODE_ENV,
	_deliveryConfigured = signedAssetDeliveryConfigured(),
): boolean {
	return false;
}

let observedUnenforcedProductionDelivery = false;

// Emit a one-time observability warning when running in production without an
// explicit ASSET_SIGNED_URLS_ENFORCED setting. Enforcement is opt-in (default
// OFF) even when signed delivery is configured, so this reminds operators that
// assets are being served unsigned and that enabling enforcement REQUIRES the
// frontend signed-URL slice (see defaultAssetAccessEnforcementEnabled).
// Idempotent so it does not spam logs.
export function observeUnenforcedProductionDelivery(
	nodeEnv = process.env.NODE_ENV,
	explicitOverride = readOptionalBooleanEnv("ASSET_SIGNED_URLS_ENFORCED"),
	deliveryConfigured = signedAssetDeliveryConfigured(),
): void {
	if (nodeEnv !== "production") return;
	if (explicitOverride !== undefined) return;
	if (observedUnenforcedProductionDelivery) return;
	observedUnenforcedProductionDelivery = true;
	const configuredNote = deliveryConfigured
		? "signed delivery is configured but enforcement is opt-in"
		: "signed delivery is not configured";
	console.warn(
		`[asset-access] production signed-asset enforcement is OFF (${configuredNote}). `
			+ "It is opt-in: set ASSET_SIGNED_URLS_ENFORCED=true to enable — but only after the "
			+ "frontend requests/attaches signed asset tokens, otherwise image requests will 401. "
			+ "Set ASSET_SIGNED_URLS_ENFORCED explicitly to silence this.",
	);
}

// Test-only reset for the one-time observability latch above.
export function resetUnenforcedProductionDeliveryObservation(): void {
	observedUnenforcedProductionDelivery = false;
}

export function readAssetAccessConfig(): AssetAccessConfig {
	const maxTtlSeconds = readPositiveIntegerEnv("ASSET_ACCESS_TOKEN_MAX_TTL_SECONDS", DEFAULT_MAX_TTL_SECONDS);
	const defaultTtlSeconds = Math.min(
		readPositiveIntegerEnv("ASSET_ACCESS_TOKEN_TTL_SECONDS", DEFAULT_TTL_SECONDS),
		maxTtlSeconds,
	);
	const explicit = readOptionalBooleanEnv("ASSET_SIGNED_URLS_ENFORCED");
	// Surface the fail-safe gap (production + no signed delivery configured + no
	// explicit flag) without hard-breaking serving.
	observeUnenforcedProductionDelivery(process.env.NODE_ENV, explicit);
	return {
		enforced: explicit ?? defaultAssetAccessEnforcementEnabled(),
		defaultTtlSeconds,
		maxTtlSeconds,
	};
}

export function signAssetAccessToken(input: AssetAccessTokenInput): string {
	const config = readAssetAccessConfig();
	const now = Math.floor((input.now ?? Date.now()) / 1000);
	const ttlSeconds = clampTtl(input.ttlSeconds ?? config.defaultTtlSeconds, config.maxTtlSeconds);
	const payload: AssetAccessTokenPayload = {
		projectId: input.projectId,
		imageId: input.imageId,
		purpose: input.purpose,
		iat: now,
		exp: now + ttlSeconds,
		...(input.subject ? { sub: input.subject } : {}),
	};
	const body = encodeJson(payload);
	const signature = signBody(body);
	return `${body}.${signature}`;
}

// Deny signed-asset token issuance for a project that has tripped the egress
// abuse-burst throttle. Enforce mode throws EgressAbuseThrottleError so the
// caller can refuse to mint a token until the window resets; observe mode and
// under-threshold projects resolve with the (non-throttled) decision and let
// issuance proceed. This is the token-issuance counterpart to the asset-read
// throttle in the image-serving path.
export function assertAssetTokenIssuanceAllowed(projectId: string, now = Date.now()): Promise<EgressAbuseDecision> {
	return assertProjectEgressNotThrottled(projectId, "token_issuance", now);
}

export function verifyAssetAccessToken(input: AssetAccessVerificationInput): AssetAccessVerificationResult {
	if (!input.token) {
		return { ok: false, reason: "missing" };
	}

	const [body, signature, extra] = input.token.split(".");
	if (!body || !signature || extra !== undefined) {
		return { ok: false, reason: "malformed" };
	}

	if (!safeEqual(signature, signBody(body))) {
		return { ok: false, reason: "bad_signature" };
	}

	const payload = decodeJson<AssetAccessTokenPayload>(body);
	if (!payload || !isAssetAccessTokenPayload(payload)) {
		return { ok: false, reason: "malformed" };
	}

	const now = Math.floor((input.now ?? Date.now()) / 1000);
	if (payload.exp <= now) {
		return { ok: false, reason: "expired", payload };
	}

	if (
		payload.projectId !== input.projectId ||
		payload.imageId !== input.imageId ||
		!input.purposes.includes(payload.purpose)
	) {
		return { ok: false, reason: "scope_mismatch", payload };
	}

	return { ok: true, payload };
}

export function extractAssetAccessToken(queryToken: string | undefined, authHeader: string | undefined, headerToken: string | undefined): string | undefined {
	if (queryToken?.trim()) return queryToken.trim();
	if (headerToken?.trim()) return headerToken.trim();
	if (authHeader?.startsWith("Asset ")) return authHeader.slice("Asset ".length).trim();
	return undefined;
}

export function buildSignedAssetPath(path: string, token: string): string {
	const separator = path.includes("?") ? "&" : "?";
	return `${path}${separator}assetToken=${encodeURIComponent(token)}`;
}

export function readAssetDeliveryConfig(): AssetDeliveryConfig {
	return {
		cdnProxyBaseUrl: normalizeBaseUrl(process.env.ASSET_CDN_PROXY_BASE_URL || ""),
	};
}

export function buildSignedAssetDeliveryUrls(input: SignedAssetDeliveryInput): SignedAssetDeliveryUrls {
	const signedPath = buildSignedAssetPath(input.path, input.token);
	const origin = normalizeBaseUrl(input.origin);
	const { cdnProxyBaseUrl } = readAssetDeliveryConfig();
	return {
		signedPath,
		signedUrl: `${origin}${signedPath}`,
		...(cdnProxyBaseUrl ? { signedCdnUrl: `${cdnProxyBaseUrl}${signedPath}` } : {}),
		deliveryMode: "signed_proxy",
		cdnProxyConfigured: Boolean(cdnProxyBaseUrl),
	};
}

// True when the image routes should hand clients a short-TTL presigned R2 URL
// instead of streaming bytes through the backend. Thin re-export of the config
// gate so route code depends on asset-access for all delivery-mode decisions.
export function presignedR2DeliveryEnabled(): boolean {
	return r2PresignedDeliveryEnabled();
}

export function defaultPresignedR2DeliveryEnabled(): boolean {
	return defaultR2PresignedDeliveryEnabled();
}

export interface ResolvePresignedR2DeliveryInput {
	// Presigner injected by the caller (the object-storage driver). Returning
	// undefined means presign is unavailable/failed → caller falls back to
	// through-backend delivery. Decoupled this way so asset-access has no
	// dependency on the storage module.
	presign: (expiresInSeconds: number) => string | undefined;
	ttlSeconds?: number;
	now?: number;
}

// Resolve a presigned-R2 delivery descriptor when presigned delivery is enabled
// and the injected presigner succeeds; otherwise undefined (→ through-backend
// fallback). The TTL is clamped to the configured presign bounds so a caller
// cannot request an unbounded-lifetime URL for a private object.
export function resolvePresignedR2Delivery(input: ResolvePresignedR2DeliveryInput): PresignedR2Delivery | undefined {
	if (!presignedR2DeliveryEnabled()) return undefined;
	const presignConfig = readR2PresignConfig();
	const ttlSeconds = clampTtl(input.ttlSeconds ?? presignConfig.defaultTtlSeconds, presignConfig.maxTtlSeconds);
	const url = input.presign(ttlSeconds);
	if (!url) return undefined;
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
	return {
		mode: "presigned_r2",
		url,
		ttlSeconds,
		expiresAt: nowSeconds + ttlSeconds,
	};
}

function clampTtl(value: number, maxTtlSeconds: number): number {
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_SECONDS;
	return Math.max(1, Math.min(Math.round(value), maxTtlSeconds));
}

function signBody(body: string): string {
	return createHmac("sha256", process.env.ASSET_SIGNING_SECRET || serverConfig.jwtSecret)
		.update(body)
		.digest("base64url");
}

function encodeJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function decodeJson<T>(body: string): T | null {
	try {
		return JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as T;
	} catch {
		return null;
	}
}

function isAssetAccessTokenPayload(value: AssetAccessTokenPayload): value is AssetAccessTokenPayload {
	return (
		typeof value.projectId === "string" &&
		typeof value.imageId === "string" &&
		typeof value.purpose === "string" &&
		typeof value.iat === "number" &&
		typeof value.exp === "number"
	);
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	return readPositiveIntegerConfigValue(process.env[name], fallback);
}

function readOptionalBooleanEnv(name: string): boolean | undefined {
	const raw = process.env[name];
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	throw new Error(`${name} must be true or false`);
}

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim();
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
