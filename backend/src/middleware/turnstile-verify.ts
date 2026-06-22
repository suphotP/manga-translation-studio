import { RedisClient } from "bun";
import { createHash } from "crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { serverConfig } from "../config.js";
import { getTrustedClientIp } from "../utils/client-ip.js";

export interface TurnstileTokenCache {
	get(tokenHash: string): Promise<boolean> | boolean;
	set(tokenHash: string, ttlSeconds: number): Promise<void> | void;
}

export type TurnstileFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TurnstileVerifyOptions {
	enabled?: boolean;
	secretKey?: string;
	verifyUrl?: string;
	cache?: TurnstileTokenCache;
	fetchFn?: TurnstileFetch;
	expectedAction?: string;
	allowedHostnames?: string[];
	verifyTimeoutMs?: number;
}

interface TurnstileSiteVerifyResponse {
	success: boolean;
	"error-codes"?: string[];
	challenge_ts?: string;
	hostname?: string;
	action?: string;
	cdata?: string;
}

interface RedisTurnstileClient {
	send(command: string, args: string[]): unknown | Promise<unknown>;
	close?(): void;
}

const USED_TOKEN_TTL_SECONDS = 300;

export function turnstileVerify(options: TurnstileVerifyOptions = {}): MiddlewareHandler {
	const enabled = options.enabled ?? serverConfig.turnstile.enabled;
	const secretKey = options.secretKey ?? serverConfig.turnstile.secretKey;
	const verifyUrl = options.verifyUrl ?? serverConfig.turnstile.verifyUrl;
	const fetchFn = options.fetchFn ?? fetch;
	const cache = options.cache ?? createDefaultTurnstileTokenCache();
	const expectedAction = options.expectedAction;
	const allowedHostnames = options.allowedHostnames ?? serverConfig.turnstile.allowedHostnames;
	const verifyTimeoutMs = options.verifyTimeoutMs ?? serverConfig.turnstile.verifyTimeoutMs;

	return async (c: Context, next: Next) => {
		if (!enabled) {
			await next();
			return;
		}

		if (!secretKey) {
			return botProtectionFailed(c, ["missing-input-secret"]);
		}

		const token = await readTurnstileResponseToken(c);
		if (!token) {
			return botProtectionFailed(c, ["missing-input-response"]);
		}

		const tokenHash = hashTurnstileToken(token);
		if (await cache.get(tokenHash)) {
			return botProtectionFailed(c, ["timeout-or-duplicate"]);
		}

		const verification = await verifyTurnstileToken({
			fetchFn,
			secretKey,
			token,
			verifyUrl,
			remoteIp: getTrustedClientIp(c),
			expectedAction,
			allowedHostnames,
			timeoutMs: verifyTimeoutMs,
		});

		// Only record the token as used once Cloudflare Siteverify actually
		// answered (success or a definitive failure). On a transient outage —
		// timeout / network error — Cloudflare never confirmed nor consumed the
		// still-valid token, so caching it here would reject an immediate retry
		// locally as `timeout-or-duplicate` and never re-reach Siteverify.
		if (verification.reachedSiteverify) {
			await cache.set(tokenHash, USED_TOKEN_TTL_SECONDS);
		}

		if (!verification.success) {
			return botProtectionFailed(c, verification.codes);
		}

		await next();
	};
}

export class MemoryTurnstileTokenCache implements TurnstileTokenCache {
	private readonly entries = new Map<string, number>();

	get(tokenHash: string): boolean {
		const expiresAt = this.entries.get(tokenHash);
		if (!expiresAt) return false;
		if (Date.now() >= expiresAt) {
			this.entries.delete(tokenHash);
			return false;
		}
		return true;
	}

	set(tokenHash: string, ttlSeconds: number): void {
		this.entries.set(tokenHash, Date.now() + ttlSeconds * 1000);
	}

	clear(): void {
		this.entries.clear();
	}
}

export class RedisTurnstileTokenCache implements TurnstileTokenCache {
	private readonly client: RedisTurnstileClient;
	private readonly keyPrefix: string;

	constructor(options: { url?: string; keyPrefix?: string; client?: RedisTurnstileClient } = {}) {
		this.client = options.client ?? createRedisClient(options.url);
		this.keyPrefix = options.keyPrefix ?? serverConfig.turnstile.tokenCacheKeyPrefix;
	}

	async get(tokenHash: string): Promise<boolean> {
		try {
			return Boolean(await this.client.send("GET", [this.key(tokenHash)]));
		} catch {
			return false;
		}
	}

	async set(tokenHash: string, ttlSeconds: number): Promise<void> {
		try {
			await this.client.send("SET", [this.key(tokenHash), "1", "EX", String(ttlSeconds)]);
		} catch {
			// Token replay tracking is a secondary defense. If Redis is unavailable,
			// keep the primary Siteverify result authoritative for this request.
		}
	}

	close(): void {
		this.client.close?.();
	}

	private key(tokenHash: string): string {
		return `${this.keyPrefix}:used:${tokenHash}`;
	}
}

async function verifyTurnstileToken(input: {
	fetchFn: TurnstileFetch;
	verifyUrl: string;
	secretKey: string;
	token: string;
	remoteIp?: string;
	expectedAction?: string;
	allowedHostnames: string[];
	timeoutMs: number;
}): Promise<
	| { success: true; reachedSiteverify: true }
	| { success: false; reachedSiteverify: boolean; codes: string[] }
> {
	const body = new URLSearchParams();
	body.set("secret", input.secretKey);
	body.set("response", input.token);
	if (input.remoteIp) body.set("remoteip", input.remoteIp);

	try {
		const response = await input.fetchFn(input.verifyUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(input.timeoutMs),
		});
		const payload = await response.json() as TurnstileSiteVerifyResponse;
		if (response.ok && payload.success) {
			const validationCodes = validateTurnstileSiteVerifyPayload(payload, input);
			if (validationCodes.length > 0) return { success: false, reachedSiteverify: true, codes: validationCodes };
			return { success: true, reachedSiteverify: true };
		}
		return { success: false, reachedSiteverify: true, codes: normalizeErrorCodes(payload["error-codes"]) };
	} catch {
		// Timeout / network failure: Cloudflare was never reached, so the token is
		// not consumed and the caller must NOT mark it used (allow a retry).
		return { success: false, reachedSiteverify: false, codes: ["siteverify_unavailable"] };
	}
}

async function readTurnstileResponseToken(c: Context): Promise<string | null> {
	const headerToken = normalizeTurnstileToken(c.req.header("cf-turnstile-response"))
		?? normalizeTurnstileToken(c.req.header("x-turnstile-token"));
	if (headerToken) return headerToken;

	const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
	if (contentType.includes("application/json")) {
		return readTurnstileJsonToken(c);
	}
	if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
		return readTurnstileFormToken(c);
	}
	return null;
}

async function readTurnstileJsonToken(c: Context): Promise<string | null> {
	try {
		const data = await c.req.raw.clone().json() as Record<string, unknown>;
		return normalizeTurnstileToken(data["cf-turnstile-response"]);
	} catch {
		return null;
	}
}

async function readTurnstileFormToken(c: Context): Promise<string | null> {
	try {
		const data = await c.req.raw.clone().formData();
		return normalizeTurnstileToken(data.get("cf-turnstile-response"));
	} catch {
		return null;
	}
}

function normalizeTurnstileToken(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function botProtectionFailed(c: Context, codes: string[]): Response {
	return c.json({ error: "bot_protection_failed", codes }, 403);
}

function hashTurnstileToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function validateTurnstileSiteVerifyPayload(
	payload: TurnstileSiteVerifyResponse,
	expected: { expectedAction?: string; allowedHostnames: string[] },
): string[] {
	const codes: string[] = [];
	if (expected.expectedAction && payload.action !== expected.expectedAction) {
		codes.push("invalid-action");
	}
	if (expected.allowedHostnames.length > 0 && !payload.hostname) {
		codes.push("missing-hostname");
	} else if (payload.hostname && !expected.allowedHostnames.includes(payload.hostname)) {
		codes.push("invalid-hostname");
	}
	return codes;
}

function normalizeErrorCodes(codes: string[] | undefined): string[] {
	return codes && codes.length > 0 ? codes : ["invalid-input-response"];
}

function createDefaultTurnstileTokenCache(): TurnstileTokenCache {
	if (!process.env.REDIS_URL) return defaultMemoryCache;
	defaultRedisCache ??= new RedisTurnstileTokenCache({ url: process.env.REDIS_URL });
	return defaultRedisCache;
}

function createRedisClient(url: string | undefined): RedisTurnstileClient {
	if (url?.trim()) return new RedisClient(url) as unknown as RedisTurnstileClient;
	return new RedisClient() as unknown as RedisTurnstileClient;
}

const defaultMemoryCache = new MemoryTurnstileTokenCache();
let defaultRedisCache: RedisTurnstileTokenCache | null | undefined;
