import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "crypto";
import { Hono } from "hono";
import { auth, setAuthEmailSenderForTesting, flushPendingAuthEmails } from "../routes/auth.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
	comparePassword,
	createUser,
	deleteUser,
	findUserByEmail,
	generateTokens,
	loadUser,
	markEmailVerified,
	resetPasswordForUser,
	updateUser,
	verifyRefreshToken,
} from "../services/auth.service.js";
import {
	authFlowTokenStore,
	hashAuthFlowToken,
	mintToken,
	mintEmailOtp,
	storeMintedToken,
	type AuthTokenKind,
} from "../services/password-reset.js";
import * as mailer from "../services/mailer.js";
import type { SendResult } from "../services/mailer.js";
import { serverConfig } from "../config.js";

// Minimal successful SendResult the injected test mailer returns. The auth flow
// never inspects the result (success vs failure is signalled by resolve/reject),
// so this only needs to satisfy the AuthEmailSender return type.
function sentResult(): SendResult {
	return { success: true, provider: "null", status: "sent", retryable: false };
}

// A RETURNED (not thrown) provider failure: the mailer resolves with success:false
// on a Resend permanent/retryable error. The auth flow must detect this via the
// SendResult, not only via a thrown exception.
function failedResult(): SendResult {
	return { success: false, provider: "resend", status: "permanent_failure", retryable: false, error: "domain_not_verified", statusCode: 403 };
}

const testRunId = randomUUID();
let testCounter = 0;
const originalAuthAutoVerifyEmail = serverConfig.authAutoVerifyEmail;

describe("auth flow completion", () => {
	beforeEach(() => {
		testCounter += 1;
		mock.restore();
		serverConfig.authAutoVerifyEmail = false;
	});

	afterEach(async () => {
		mock.restore();
		serverConfig.authAutoVerifyEmail = originalAuthAutoVerifyEmail;
		setAuthEmailSenderForTesting();
		for (const suffix of ["known", "mailfail", "reset", "expired", "used", "verify", "verified", "register", "registerfail", "regreturnfail", "resendreturnfail", "consume", "stale", "rebind", "rebind-new"]) {
			const user = await findUserByEmail(testEmail(suffix));
			if (user) await deleteUser(user.id);
		}
	});

	test("forgot-password with unknown email returns 200 without enumeration", async () => {
		const sendSpy = spyOn(mailer, "sendTransactionalEmail");
		const response = await postJson("/forgot-password", { email: testEmail("unknown") }, { "x-real-ip": testClientIp() });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		await flushPendingAuthEmails();
		expect(sendSpy).not.toHaveBeenCalled();
	});

	test("forgot-password with known email stores a reset row and sends mail", async () => {
		const { user } = await createUser({
			email: testEmail("known"),
			password: "StrongP@ss123",
			name: "Known User",
		});
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);

		const response = await postJson("/forgot-password", { email: testEmail("known").toUpperCase() }, { "x-real-ip": testClientIp() });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		// The reset email is dispatched off the response critical path; flush it.
		await flushPendingAuthEmails();
		const rows = await authFlowTokenStore.list("password_reset");
		expect(rows.some((row) => row.userId === user.id && !row.usedAt)).toBe(true);
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(sendMock.mock.calls[0]![0]).toBe("password-reset");
		expect(sendMock.mock.calls[0]![1]).toMatchObject({
			user: expect.objectContaining({ id: user.id, email: testEmail("known") }),
		});
		expect(String((sendMock.mock.calls[0]![1] as any).resetUrl)).toContain("/reset-password?token=");
	});

	test("forgot-password preserves non-enumerating response when mail delivery fails", async () => {
		const { user } = await createUser({
			email: testEmail("mailfail"),
			password: "StrongP@ss123",
			name: "Mail Fail User",
		});
		const sendMock = mock(async () => {
			throw new Error("resend unavailable");
		});
		setAuthEmailSenderForTesting(sendMock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		const response = await postJson("/forgot-password", { email: testEmail("mailfail") }, { "x-real-ip": testClientIp() });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		await flushPendingAuthEmails();
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("[auth] password reset email delivery failed", expect.objectContaining({
			userId: user.id,
			email: testEmail("mailfail"),
		}));
	});

	test("register generates an email verification token and sends verification mail", async () => {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);

		const response = await postJson("/register", {
			email: testEmail("register"),
			password: "StrongP@ss123",
			name: "Register User",
		});

		expect(response.status).toBe(201);
		const user = await findUserByEmail(testEmail("register"));
		expect(user).toBeDefined();
		const rows = await authFlowTokenStore.list("email_verify");
		expect(rows.some((row) => row.userId === user!.id && !row.usedAt)).toBe(true);
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(sendMock.mock.calls[0]![0]).toBe("registration-verify");
		const verifyPayload = sendMock.mock.calls[0]![1] as any;
		expect(verifyPayload.code).toMatch(/^\d{6}$/);
		expect(verifyPayload.expiresMinutes).toBeGreaterThan(0);
		// The OTP flow does not email a magic-link token any more.
		expect(verifyPayload.verifyUrl).toBeUndefined();
	});

	test("register returns recoverable success when verification email delivery fails", async () => {
		const sendMock = mock(async () => {
			throw new Error("resend unavailable");
		});
		setAuthEmailSenderForTesting(sendMock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		const response = await postJson("/register", {
			email: testEmail("registerfail"),
			password: "StrongP@ss123",
			name: "Register Fail User",
		});

		expect(response.status).toBe(201);
		const body = await response.json() as any;
		expect(body.user).toMatchObject({
			email: testEmail("registerfail"),
			verificationEmailSendFailed: true,
		});
		expect(typeof body.tokens.accessToken).toBe("string");
		expect(body.verificationEmail).toEqual({
			sendFailed: true,
			resendPath: "/api/auth/resend-verification",
		});
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("[auth] registration verification email delivery failed", expect.objectContaining({
			email: testEmail("registerfail"),
		}));
		expect((await findUserByEmail(testEmail("registerfail")))?.verificationEmailSendFailed).toBe(true);
	});

	test("register surfaces sendFailed when the mailer RETURNS success:false (no throw)", async () => {
		// Regression: the mailer reports a Resend permanent failure by RESOLVING with
		// success:false, not by throwing. Previously register only treated a thrown
		// exception as a failure, so a returned failure responded sendFailed:false and
		// the user was told the email was coming when it never sent.
		const sendMock = mock(async () => failedResult());
		setAuthEmailSenderForTesting(sendMock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		const response = await postJson("/register", {
			email: testEmail("regreturnfail"),
			password: "StrongP@ss123",
			name: "Register Return Fail User",
		});

		expect(response.status).toBe(201);
		const body = await response.json() as any;
		expect(body.user).toMatchObject({
			email: testEmail("regreturnfail"),
			verificationEmailSendFailed: true,
		});
		expect(body.verificationEmail).toEqual({
			sendFailed: true,
			resendPath: "/api/auth/resend-verification",
		});
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("[auth] registration verification email delivery failed", expect.objectContaining({
			email: testEmail("regreturnfail"),
		}));
		expect((await findUserByEmail(testEmail("regreturnfail")))?.verificationEmailSendFailed).toBe(true);
	});

	test("resend-verification surfaces sendFailed and keeps the flag when the mailer RETURNS success:false", async () => {
		// Regression companion: resend-verification previously always returned
		// { ok: true } and CLEARED the failed flag regardless of the send outcome. A
		// returned failure must now report sendFailed:true (502) and KEEP the account
		// flagged for retry.
		const sendMock = mock(async () => failedResult());
		setAuthEmailSenderForTesting(sendMock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const { user } = await createUser({
			email: testEmail("resendreturnfail"),
			password: "StrongP@ss123",
			name: "Resend Return Fail User",
		});
		await updateUser(user.id, { verificationEmailSendFailed: true });
		const tokens = await generateTokens({ id: user.id, email: user.email, role: user.role });

		const response = await auth.request("/resend-verification", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.accessToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ ok: false, sendFailed: true });
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("[auth] resend verification email delivery failed", expect.objectContaining({
			email: testEmail("resendreturnfail"),
		}));
		// Flag stays set — the email never went out, so the account remains flagged.
		expect((await loadUser(user.id))?.verificationEmailSendFailed).toBe(true);
	});

	test("reset-password with valid token updates password, uses token, and invalidates sessions", async () => {
		const { user } = await createUser({
			email: testEmail("reset"),
			password: "StrongP@ss123",
			name: "Reset User",
		});
		const fullUser = await findUserByEmail(testEmail("reset"));
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);
		expect(await verifyRefreshToken(tokens.refreshToken)).toBe(user.id);
		const minted = await mintToken(user.id, "password_reset");
		const record = await storeMintedToken({
			userId: user.id,
			kind: "password_reset",
			tokenHash: minted.hash,
			expiresAt: minted.expiresAt,
		});

		const response = await postJson("/reset-password", {
			token: minted.token,
			newPassword: "NewStrongP@ss123",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		const updatedUser = await loadUser(user.id);
		expect(updatedUser).toBeDefined();
		expect(await comparePassword("NewStrongP@ss123", updatedUser!.passwordHash)).toBe(true);
		const usedRecord = (await authFlowTokenStore.list("password_reset")).find((row) => row.tokenHash === record.tokenHash);
		expect(typeof usedRecord?.usedAt).toBe("string");
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
	});

	test("reset-password invalidates all other outstanding reset tokens for the user", async () => {
		// User requested two resets (e.g. clicked "forgot password" twice). Using the
		// first link must burn the second so an older valid link cannot re-change the password.
		const { user } = await createUser({
			email: testEmail("reset"),
			password: "StrongP@ss123",
			name: "Double Reset User",
		});

		const tokenA = await mintToken(user.id, "password_reset");
		await storeMintedToken({ userId: user.id, kind: "password_reset", tokenHash: tokenA.hash, expiresAt: tokenA.expiresAt });
		const tokenB = await mintToken(user.id, "password_reset");
		await storeMintedToken({ userId: user.id, kind: "password_reset", tokenHash: tokenB.hash, expiresAt: tokenB.expiresAt });

		const useA = await postJson("/reset-password", { token: tokenA.token, newPassword: "FirstStrongP@ss123" });
		expect(useA.status).toBe(200);

		// Token B was minted before the reset and never used, but must now be rejected.
		const useB = await postJson("/reset-password", { token: tokenB.token, newPassword: "AttackerStrongP@ss123" });
		expect(useB.status).toBe(400);
		expect(await useB.json()).toMatchObject({ code: "already_used" });

		// The attacker-supplied password must NOT have taken effect.
		const updatedUser = await loadUser(user.id);
		expect(await comparePassword("FirstStrongP@ss123", updatedUser!.passwordHash)).toBe(true);
		expect(await comparePassword("AttackerStrongP@ss123", updatedUser!.passwordHash)).toBe(false);

		// Token B's row is now marked used.
		const rowB = (await authFlowTokenStore.list("password_reset")).find((row) => row.tokenHash === tokenB.hash);
		expect(typeof rowB?.usedAt).toBe("string");
	});

	test("reset-password consumes a valid token before applying password changes", async () => {
		const { user, token } = await createDirectToken("consume", "password_reset");

		const firstResponse = await postJson("/reset-password", {
			token,
			newPassword: "FirstStrongP@ss123",
		});
		const secondResponse = await postJson("/reset-password", {
			token,
			newPassword: "SecondStrongP@ss123",
		});

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(400);
		expect(await secondResponse.json()).toMatchObject({ code: "already_used" });
		const updatedUser = await loadUser(user.id);
		expect(updatedUser).toBeDefined();
		expect(await comparePassword("FirstStrongP@ss123", updatedUser!.passwordHash)).toBe(true);
		expect(await comparePassword("SecondStrongP@ss123", updatedUser!.passwordHash)).toBe(false);
	});

	test("reset-password rejects weak passwords without consuming the token", async () => {
		const { user, token, tokenHash } = await createDirectToken("consume", "password_reset");

		const weakResponse = await postJson("/reset-password", {
			token,
			newPassword: "abcdefgh",
		});
		expect(weakResponse.status).toBe(400);
		expect(await weakResponse.json()).toMatchObject({ code: "weak_password" });
		const afterWeakRecord = (await authFlowTokenStore.list("password_reset")).find((row) => row.tokenHash === tokenHash);
		expect(afterWeakRecord?.usedAt).toBeNull();
		const retryResponse = await postJson("/reset-password", {
			token,
			newPassword: "RecoveredStrongP@ss123",
		});
		expect(retryResponse.status).toBe(200);
		expect(await comparePassword("RecoveredStrongP@ss123", (await loadUser(user.id))!.passwordHash)).toBe(true);
	});

	test("reset-password with expired token returns expired", async () => {
		const { token } = await createDirectToken("expired", "password_reset", {
			expiresAt: new Date(Date.now() - 60_000),
		});

		const response = await postJson("/reset-password", {
			token,
			newPassword: "NewStrongP@ss123",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "expired" });
	});

	test("reset-password with used token returns already_used", async () => {
		const { token } = await createDirectToken("used", "password_reset", {
			usedAt: new Date().toISOString(),
		});

		const response = await postJson("/reset-password", {
			token,
			newPassword: "NewStrongP@ss123",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "already_used" });
	});

	test("verify-email with valid token marks the user verified", async () => {
		const { user, token } = await createDirectToken("verify", "email_verify");

		const response = await postJson("/verify-email", { token });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			verified: true,
			user: {
				id: user.id,
				email: testEmail("verify"),
				emailVerified: true,
			},
		});
		expect((await loadUser(user.id))?.emailVerified).toBe(true);
	});

	test("resend-verification when already verified returns already_verified", async () => {
		const { user } = await createUser({
			email: testEmail("verified"),
			password: "StrongP@ss123",
			name: "Verified User",
		});
		await markEmailVerified(user.id);
		const tokens = await generateTokens({ id: user.id, email: user.email, role: user.role });

		const response = await auth.request("/resend-verification", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.accessToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "already_verified" });
	});

	test("resend-verification clears stale failed-send flag after successful mail", async () => {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const { user } = await createUser({
			email: testEmail("registerfail"),
			password: "StrongP@ss123",
			name: "Resend Recovery User",
		});
		await updateUser(user.id, { verificationEmailSendFailed: true });
		const tokens = await generateTokens({ id: user.id, email: user.email, role: user.role });

		const response = await auth.request("/resend-verification", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.accessToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, sendFailed: false });
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect((await loadUser(user.id))?.verificationEmailSendFailed).toBe(false);
	});

	test("forgot-password per-email budget never locks the victim out (no 429), only suppresses extra sends", async () => {
		// An attacker (or the owner retrying) hitting the same email past the per-email
		// budget must NOT cause a 429 — that would let any unauthenticated caller burn
		// a victim's recovery budget. The response stays a uniform 200; over budget we
		// silently skip the actual send instead of failing the request.
		const { user } = await createUser({
			email: testEmail("known"),
			password: "StrongP@ss123",
			name: "Budget User",
		});
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);

		const ip = testClientIp();
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			statuses.push((await postJson("/forgot-password", { email: testEmail("known") }, { "x-real-ip": ip })).status);
		}
		await flushPendingAuthEmails();

		// Every response is 200 — recovery is never blocked for the real owner.
		expect(statuses).toEqual([200, 200, 200, 200, 200]);
		// But only the first AUTH_FLOW_RATE_LIMIT_MAX (3) requests actually send mail.
		expect(sendMock).toHaveBeenCalledTimes(3);
		expect(user.id).toBeTruthy();
	});

	test("forgot-password returns 429 only when the per-IP abuse cap is exceeded", async () => {
		// The per-IP cap bounds how many distinct targets one source can burn; it does
		// not target a specific victim, so a hard 429 here is safe.
		const ip = "198.51.100.7";
		const statuses: number[] = [];
		for (let i = 0; i < 22; i++) {
			const email = `ipcap-${testRunId}-${testCounter}-${i}@example.com`;
			statuses.push((await postJson("/forgot-password", { email }, { "x-real-ip": ip })).status);
		}
		await flushPendingAuthEmails();

		// First 20 (FORGOT_PASSWORD_IP_RATE_LIMIT) pass, the rest are 429.
		expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
		expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
	});

	test("access tokens issued before a password reset are rejected", async () => {
		const { user } = await createUser({
			email: testEmail("stale"),
			password: "StrongP@ss123",
			name: "Stale Token User",
		});
		// Token minted before the reset; iat is "now". Wait past the 1s rounding
		// window so the reset watermark lands strictly after this token's iat.
		const tokens = await generateTokens({ id: user.id, email: user.email, role: user.role });
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Recover the account (new password), which must invalidate prior access tokens.
		const changed = await resetPasswordForUser(user.id, "FreshP@ss456");
		expect(changed).toBe(true);

		const probe = new Hono();
		probe.get("/probe", authMiddleware, (c) => c.json({ ok: true }));
		const response = await probe.request("/probe", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("revoked") });
	});

	test("access tokens re-issued right after a reset are NOT rejected by the watermark", async () => {
		const { user } = await createUser({
			email: testEmail("consume"),
			password: "StrongP@ss123",
			name: "Relogin User",
		});

		// Recover the account, then immediately mint a fresh token (simulating the
		// user logging in again in the same second). Future-dating the watermark
		// would 401 this valid token until the next second; it must stay usable.
		expect(await resetPasswordForUser(user.id, "FreshP@ss456")).toBe(true);
		const fresh = await generateTokens({ id: user.id, email: user.email, role: user.role });

		const probe = new Hono();
		probe.get("/probe", authMiddleware, (c) => c.json({ ok: true }));
		const response = await probe.request("/probe", {
			headers: { Authorization: `Bearer ${fresh.accessToken}` },
		});
		expect(response.status).toBe(200);
	});

	test("admin email change clears verification and invalidates prior access tokens", async () => {
		const { user } = await createUser({
			email: testEmail("rebind"),
			password: "StrongP@ss123",
			name: "Rebind User",
		});
		await markEmailVerified(user.id);
		const tokens = await generateTokens({ id: user.id, email: user.email, role: user.role });
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Pre-change refresh token must be valid before the rebind.
		expect(await verifyRefreshToken(tokens.refreshToken)).toBe(user.id);

		const updated = await updateUser(user.id, { email: testEmail("rebind").replace("rebind", "rebind-new") });
		expect(updated?.emailVerified).toBe(false);

		const reloaded = await loadUser(user.id);
		expect(reloaded?.emailVerified).toBe(false);

		const probe = new Hono();
		probe.get("/probe", authMiddleware, (c) => c.json({ ok: true }));
		const response = await probe.request("/probe", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(response.status).toBe(401);

		// The pre-change refresh session must be revoked too, so a client holding it
		// cannot mint fresh tokens for the account after the email rebind.
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
	});

	test("admin email change invalidates outstanding email_verify tokens", async () => {
		const { user } = await createUser({
			email: testEmail("rebind"),
			password: "StrongP@ss123",
			name: "Rebind Verify User",
		});
		// A verification link was already issued for the OLD address.
		const verifyToken = await mintToken(user.id, "email_verify");
		await storeMintedToken({ userId: user.id, kind: "email_verify", tokenHash: verifyToken.hash, expiresAt: verifyToken.expiresAt });

		// Admin changes the email to a new, unconfirmed address.
		const updated = await updateUser(user.id, { email: testEmail("rebind-new") });
		expect(updated?.emailVerified).toBe(false);

		// The stale link issued for the old mailbox must no longer verify the new one.
		const response = await postJson("/verify-email", { token: verifyToken.token });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "already_used" });
		expect((await loadUser(user.id))?.emailVerified).toBe(false);
	});

	test("transactional mailer logs metadata without token-bearing URLs", async () => {
		const logSpy = spyOn(console, "log").mockImplementation(() => {});

		await mailer.sendTransactionalEmail("password-reset", {
			user: { email: "safe-log@example.com", name: "Safe Log" },
			resetUrl: "https://app.example/reset-password?token=secret-reset-token",
			expiresAt: new Date(),
		});
		await mailer.sendTransactionalEmail("registration-verify", {
			user: { email: "safe-log@example.com", name: "Safe Log" },
			code: "424242",
			expiresMinutes: 15,
		});

		const logged = JSON.stringify(logSpy.mock.calls);
		expect(logged).toContain("safe-log@example.com");
		expect(logged).not.toContain("secret-reset-token");
		// The OTP code itself must never land in logs by default (MAILER_LOG_BODY off).
		expect(logged).not.toContain("424242");
		expect(logged).not.toContain("resetUrl");
	});
});

describe("email OTP verification", () => {
	const otpRunId = randomUUID();
	let otpCounter = 0;
	// Distinct client IP per /register call so the new per-IP signup cap (a
	// process-wide 24h counter) does not bleed across tests. The dedicated cap test
	// below uses a fixed IP of its own.
	let otpIpCounter = 0;
	function otpIp(): string {
		return `198.51.100.${(otpIpCounter++ % 250) + 1}`;
	}
	const createdUserIds: string[] = [];
	const originalAutoVerify = serverConfig.authAutoVerifyEmail;

	beforeEach(() => {
		otpCounter += 1;
		mock.restore();
		serverConfig.authAutoVerifyEmail = false;
	});

	afterEach(async () => {
		mock.restore();
		setAuthEmailSenderForTesting();
		serverConfig.authAutoVerifyEmail = originalAutoVerify;
		while (createdUserIds.length) {
			const id = createdUserIds.pop()!;
			await deleteUser(id).catch(() => {});
		}
	});

	function otpEmail(suffix: string): string {
		return `otp-${otpRunId}-${otpCounter}-${suffix}@example.com`;
	}

	function bearer(token: string): Record<string, string> {
		return { Authorization: `Bearer ${token}` };
	}

	// Register a fresh user and capture the 6-digit code from the mocked sender plus
	// the access token from the response — the same pair a real client would hold.
	async function registerForOtp(suffix: string): Promise<{ token: string; code: string; userId: string }> {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const res = await postJson("/register", { email: otpEmail(suffix), password: "StrongP@ss123", name: `${suffix} User` }, { "x-real-ip": otpIp() });
		expect(res.status).toBe(201);
		const body = await res.json() as any;
		createdUserIds.push(body.user.id);
		return { token: body.tokens.accessToken, code: String((sendMock.mock.calls[0]![1] as any).code), userId: body.user.id };
	}

	test("the correct code verifies the signed-in user", async () => {
		const { token, code, userId } = await registerForOtp("ok");
		expect((await loadUser(userId))?.emailVerified).toBe(false);
		const res = await postJson("/verify-otp", { code }, bearer(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ verified: true, user: { id: userId, emailVerified: true } });
		expect((await loadUser(userId))?.emailVerified).toBe(true);
	});

	test("a wrong code does not verify the account", async () => {
		const { token, code, userId } = await registerForOtp("wrong");
		const wrong = code === "000000" ? "111111" : "000000";
		const res = await postJson("/verify-otp", { code: wrong }, bearer(token));
		expect(res.status).toBe(400);
		expect((await loadUser(userId))?.emailVerified).toBe(false);
	});

	test("a code is session-scoped — user A's code cannot verify user B", async () => {
		const a = await registerForOtp("scopea");
		const b = await registerForOtp("scopeb");
		// Submit A's real code while authenticated as B: B's tokens never match it.
		const res = await postJson("/verify-otp", { code: a.code }, bearer(b.token));
		expect(res.status).toBe(400);
		expect((await loadUser(b.userId))?.emailVerified).toBe(false);
		// A is untouched and can still redeem its own code.
		expect((await postJson("/verify-otp", { code: a.code }, bearer(a.token))).status).toBe(200);
	});

	test("brute-force attempts are rate-limited per user", async () => {
		const { token, code } = await registerForOtp("brute");
		const wrong = code === "000000" ? "111111" : "000000";
		// First VERIFY_OTP_RATE_LIMIT_MAX (8) wrong guesses are checked (400); the next
		// trips the limiter (429) before the code is even consulted.
		for (let i = 0; i < 8; i++) {
			expect((await postJson("/verify-otp", { code: wrong }, bearer(token))).status).toBe(400);
		}
		const limited = await postJson("/verify-otp", { code: wrong }, bearer(token));
		expect(limited.status).toBe(429);
		expect((await limited.json() as any).code).toBe("rate_limited");
	});

	test("a resent code restores a fresh attempt budget after the limit", async () => {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const res = await postJson("/register", { email: otpEmail("recover"), password: "StrongP@ss123", name: "Recover User" });
		const body = await res.json() as any;
		createdUserIds.push(body.user.id);
		const token = body.tokens.accessToken;
		const code1 = String((sendMock.mock.calls[0]![1] as any).code);
		const wrong = code1 === "000000" ? "111111" : "000000";
		// Exhaust the budget on the first generation.
		for (let i = 0; i < 8; i++) expect((await postJson("/verify-otp", { code: wrong }, bearer(token))).status).toBe(400);
		expect((await postJson("/verify-otp", { code: wrong }, bearer(token))).status).toBe(429);
		// Resend mints a NEW generation, which carries its own fresh budget.
		expect((await postJson("/resend-verification", {}, bearer(token))).status).toBe(200);
		const code2 = String((sendMock.mock.calls[1]![1] as any).code);
		expect((await postJson("/verify-otp", { code: code2 }, bearer(token))).status).toBe(200);
	});

	test("a failed resend does not burn the previously delivered code", async () => {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const res = await postJson("/register", { email: otpEmail("noburn"), password: "StrongP@ss123", name: "NoBurn User" });
		const body = await res.json() as any;
		createdUserIds.push(body.user.id);
		const token = body.tokens.accessToken;
		const code1 = String((sendMock.mock.calls[0]![1] as any).code);
		// The resend attempt fails to deliver…
		const failMock = mock(async () => { throw new Error("provider down"); });
		setAuthEmailSenderForTesting(failMock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		expect((await postJson("/resend-verification", {}, bearer(token))).status).toBe(502);
		warnSpy.mockRestore();
		// …so the originally delivered code must still verify (not burned).
		expect((await postJson("/verify-otp", { code: code1 }, bearer(token))).status).toBe(200);
	});

	test("only the newest delivered code verifies — a successful resend supersedes the prior code", async () => {
		// Anti-abuse: an attacker must not be able to resend to grow a pool of guessable codes.
		// verifyEmailOtp accepts ONLY the newest live code, so an earlier one stops verifying —
		// without ever marking it used (no concurrency race with an in-flight resend email).
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const res = await postJson("/register", { email: otpEmail("newest"), password: "StrongP@ss123", name: "Newest User" });
		const body = await res.json() as any;
		createdUserIds.push(body.user.id);
		const token = body.tokens.accessToken;
		const code1 = String((sendMock.mock.calls[0]![1] as any).code);
		// No artificial delay: register + resend here run within the same millisecond (fast
		// in-memory mailer), which is exactly the tie case — the monotonic createdAt stamp must
		// still order the resent code AFTER the register code so the latest one wins.
		expect((await postJson("/resend-verification", {}, bearer(token))).status).toBe(200);
		const code2 = String((sendMock.mock.calls[1]![1] as any).code);
		if (code1 === code2) return; // 1-in-1e6 collision: the "two distinct codes" premise fails.
		// The superseded code no longer verifies; only one code is ever guessable.
		expect((await postJson("/verify-otp", { code: code1 }, bearer(token))).status).toBe(400);
		expect((await loadUser(body.user.id))?.emailVerified).toBe(false);
		// The freshly delivered code still verifies.
		expect((await postJson("/verify-otp", { code: code2 }, bearer(token))).status).toBe(200);
	});

	test("verifying an already-verified account is idempotent", async () => {
		const { token, code, userId } = await registerForOtp("idem");
		expect((await postJson("/verify-otp", { code }, bearer(token))).status).toBe(200);
		const again = await postJson("/verify-otp", { code }, bearer(token));
		expect(again.status).toBe(200);
		expect(await again.json()).toMatchObject({ verified: true });
		expect((await loadUser(userId))?.emailVerified).toBe(true);
	});

	test("an expired code is rejected", async () => {
		const { user } = await createUser({ email: otpEmail("exp"), password: "StrongP@ss123", name: "Exp User" });
		createdUserIds.push(user.id);
		const tokens = await generateTokens(user, { provider: "local" });
		const minted = mintEmailOtp(user.id, new Date(Date.now() - 60 * 60_000)); // expired an hour ago
		await storeMintedToken({ userId: user.id, kind: "email_verify", tokenHash: minted.hash, expiresAt: minted.expiresAt });
		const res = await postJson("/verify-otp", { code: minted.code }, bearer(tokens.accessToken));
		expect(res.status).toBe(400);
		expect((await loadUser(user.id))?.emailVerified).toBe(false);
	});

	test("verify-otp requires authentication", async () => {
		expect((await postJson("/verify-otp", { code: "123456" })).status).toBe(401);
	});

	test("the public verify-email endpoint cannot redeem an OTP (no brute-force oracle)", async () => {
		const { token, code, userId } = await registerForOtp("oracle");
		// What an attacker would POST to the unauthenticated, unthrottled global
		// endpoint to try to reproduce the OTP hash. The HMAC keying defeats it.
		const forged = `email_otp:${userId}:${code}`;
		const res = await postJson("/verify-email", { token: forged });
		expect(res.status).toBe(400);
		expect((await loadUser(userId))?.emailVerified).toBe(false);
		// The legitimate session-scoped path still verifies with the same code.
		expect((await postJson("/verify-otp", { code }, bearer(token))).status).toBe(200);
	});

	test("public sign-up is capped per IP", async () => {
		const sendMock = mock(async () => sentResult());
		setAuthEmailSenderForTesting(sendMock);
		const ip = "203.0.113.250"; // dedicated to this test
		// REGISTER_IP_RATE_LIMIT default = 30: the first 30 from one IP succeed, the 31st is 429.
		const CAP = 30;
		for (let i = 0; i < CAP; i++) {
			const r = await postJson("/register", { email: otpEmail(`cap${i}`), password: "StrongP@ss123", name: `Cap ${i}` }, { "x-real-ip": ip });
			expect(r.status).toBe(201);
			createdUserIds.push((await r.json() as any).user.id);
		}
		const over = await postJson("/register", { email: otpEmail("capover"), password: "StrongP@ss123", name: "Cap Over" }, { "x-real-ip": ip });
		expect(over.status).toBe(429);
		expect((await over.json() as any).code).toBe("rate_limited");
		// A different IP is unaffected by this IP's exhausted budget.
		const other = await postJson("/register", { email: otpEmail("capother"), password: "StrongP@ss123", name: "Cap Other" }, { "x-real-ip": "203.0.113.251" });
		expect(other.status).toBe(201);
		createdUserIds.push((await other.json() as any).user.id);
	});

	test("registering a taken email returns 409 with code email_taken", async () => {
		const email = otpEmail("dup409");
		const first = await postJson("/register", { email, password: "StrongP@ss123", name: "First" }, { "x-real-ip": "203.0.113.40" });
		expect(first.status).toBe(201);
		createdUserIds.push((await first.json() as any).user.id);
		// Same email again → a CONFLICT, not a generic 400, with a machine-readable code so the
		// client branches on status/code (not the English message).
		const dup = await postJson("/register", { email, password: "StrongP@ss123", name: "Second" }, { "x-real-ip": "203.0.113.41" });
		expect(dup.status).toBe(409);
		expect((await dup.json() as any).code).toBe("email_taken");
	});
});

async function createDirectToken(
	suffix: string,
	kind: AuthTokenKind,
	options: { expiresAt?: Date; usedAt?: string | null } = {},
): Promise<{ user: Awaited<ReturnType<typeof createUser>>["user"]; token: string; tokenHash: string }> {
	const { user } = await createUser({
		email: testEmail(suffix),
		password: "StrongP@ss123",
		name: `${suffix} User`,
	});
	const token = randomBytes(32).toString("hex");
	const tokenHash = hashAuthFlowToken(token);
	await authFlowTokenStore.create({
		id: randomUUID(),
		tokenHash,
		userId: user.id,
		kind,
		expiresAt: (options.expiresAt ?? new Date(Date.now() + 60 * 60_000)).toISOString(),
		usedAt: options.usedAt ?? null,
		createdAt: new Date().toISOString(),
		ipAddress: "127.0.0.1",
		userAgent: "auth-flow-test",
	});
	return { user, token, tokenHash };
}

function testEmail(suffix: string): string {
	return `auth-flow-${testRunId}-${testCounter}-${suffix}@example.com`;
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return Promise.resolve(auth.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	}));
}

// Distinct, valid client IP per test so the per-IP forgot-password budget (which
// is process-wide, 24h window) does not bleed across tests. trustProxyHeaders is
// on in the test runtime, so x-real-ip becomes the trusted client IP.
function testClientIp(): string {
	const n = testCounter % 250 + 1;
	return `203.0.113.${n}`;
}
