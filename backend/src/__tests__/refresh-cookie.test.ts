import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { decode } from "jsonwebtoken";
import { createUser, findUserByEmail, generateTokens, verifyRefreshToken } from "../services/auth.service.js";
import { auth } from "../routes/auth.js";
import { serverConfig } from "../config.js";

const testRunId = randomUUID();

describe("refresh token cookie flow", () => {
	beforeEach(() => {
		process.env.NODE_ENV = "test";
	});

	afterEach(() => {
		delete process.env.NODE_ENV;
	});

	test("login issues httpOnly Secure SameSite=Lax refresh cookie and still returns refresh token for legacy clients", async () => {
		const email = `${testRunId}-login-cookie@example.com`;
		await createUser({ email, password: "StrongP@ss123", name: "Cookie User" });

		const response = await auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "StrongP@ss123" }),
		});

		expect(response.status).toBe(200);
		const body = await response.json() as { tokens: { accessToken?: string; refreshToken?: string } };
		expect(body.tokens.accessToken).toBeDefined();
		expect(body.tokens.refreshToken).toBeDefined();
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("mews_refresh=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Path=/api/auth");
		expect(setCookie).toContain("Max-Age=604800");
	});

	test("refresh reads refresh cookie, rotates it, and honors the configured access token expiry", async () => {
		const email = `${testRunId}-refresh-cookie@example.com`;
		await createUser({ email, password: "StrongP@ss123", name: "Refresh Cookie User" });
		const fullUser = await findUserByEmail(email);
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);

		const response = await auth.request("/refresh", {
			method: "POST",
			headers: { Cookie: `mews_refresh=${tokens.refreshToken}` },
		});

		expect(response.status).toBe(200);
		const body = await response.json() as { tokens: { accessToken?: string; refreshToken?: string } };
		expect(body.tokens.accessToken).toBeDefined();
		const decodedAccess = decode(body.tokens.accessToken!) as { iat?: number; exp?: number } | null;
		expect(decodedAccess?.iat).toBeDefined();
		expect(decodedAccess?.exp).toBeDefined();
		expect(decodedAccess!.exp! - decodedAccess!.iat!).toBe(serverConfig.jwtAccessTokenExpiry);
		expect(body.tokens.refreshToken).toBeDefined();
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("mews_refresh=");
		const nextRefresh = extractCookieValue(setCookie, "mews_refresh");
		expect(nextRefresh).toBeDefined();
		expect(await verifyRefreshToken(nextRefresh!)).toBe(fullUser!.id);
	});

	test("refresh accepts body refresh token even when the request also has bearer auth", async () => {
		const email = `${testRunId}-refresh-body-bearer@example.com`;
		await createUser({ email, password: "StrongP@ss123", name: "Refresh Body User" });
		const fullUser = await findUserByEmail(email);
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);

		const response = await auth.request("/refresh", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${tokens.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ refreshToken: tokens.refreshToken }),
		});

		expect(response.status).toBe(200);
		const body = await response.json() as { tokens: { accessToken?: string; refreshToken?: string } };
		expect(body.tokens.accessToken).toBeDefined();
		expect(body.tokens.refreshToken).toBeDefined();
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
	});

	test("logout-cookie revokes and clears refresh cookie", async () => {
		const email = `${testRunId}-logout-cookie@example.com`;
		await createUser({ email, password: "StrongP@ss123", name: "Logout Cookie User" });
		const fullUser = await findUserByEmail(email);
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);

		const response = await auth.request("/logout-cookie", {
			method: "POST",
			headers: { Cookie: `mews_refresh=${tokens.refreshToken}` },
		});

		expect(response.status).toBe(200);
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("mews_refresh=");
		expect(setCookie).toContain("Max-Age=0");
		expect(setCookie).toContain("Path=/api/auth");
	});
});

function extractCookieValue(setCookie: string, name: string): string | undefined {
	const prefix = `${name}=`;
	const part = setCookie.split(";").find((item) => item.trim().startsWith(prefix));
	return part?.trim().slice(prefix.length);
}
