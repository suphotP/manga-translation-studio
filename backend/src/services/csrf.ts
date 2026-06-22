import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { serverConfig } from "../config.js";

const TOKEN_PREFIX = "mews_csrf";

export function createCsrfToken(userId = "anonymous", now = Date.now()): string {
	const issuedAt = Math.floor(now / 1000);
	const nonce = randomBytes(18).toString("base64url");
	const signature = signCsrfPayload(userId, issuedAt, nonce);
	return `${TOKEN_PREFIX}.${issuedAt}.${nonce}.${signature}`;
}

export function verifyCsrfToken(token: string | undefined, userId = "anonymous", now = Date.now()): boolean {
	if (!token) return false;
	const parts = token.split(".");
	if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return false;
	const [, issuedAtRaw, nonce, signature] = parts;
	if (issuedAtRaw === undefined || !nonce || !signature) return false;
	const issuedAt = Number.parseInt(issuedAtRaw, 10);
	if (!Number.isFinite(issuedAt)) return false;
	const ageSeconds = Math.floor(now / 1000) - issuedAt;
	if (ageSeconds < 0 || ageSeconds > serverConfig.csrfTokenTtlSeconds) return false;
	const expected = signCsrfPayload(userId, issuedAt, nonce);
	return timingSafeBase64UrlEqual(signature, expected);
}

function signCsrfPayload(userId: string, issuedAt: number, nonce: string): string {
	return createHmac("sha256", `${serverConfig.jwtSecret}:csrf`)
		.update(`${userId}:${issuedAt}:${nonce}`)
		.digest("base64url");
}

function timingSafeBase64UrlEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}
