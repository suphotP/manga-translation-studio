import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { auth } from "../routes/auth.js";
import {
	createUser,
	deleteUser,
	findUserByEmail,
	generateTokens,
	loadUser,
	PASSWORD_MAX_LENGTH,
	validatePassword,
} from "../services/auth.service.js";

const AUTH_EMAIL_MAX_LENGTH = 254;
const testRunId = randomUUID();
const createdEmails = new Set<string>();

describe("auth input caps", () => {
	afterEach(async () => {
		for (const email of createdEmails) {
			const user = await findUserByEmail(email);
			if (user) await deleteUser(user.id);
		}
		createdEmails.clear();
	});

	test("rejects 255-character emails with validation_failed before storage/index work", async () => {
		const email = emailOfLength(AUTH_EMAIL_MAX_LENGTH + 1);

		const response = await postJson("/register", {
			email,
			password: strongPasswordOfLength(32),
			name: "Too Long Email",
		});

		expect(response.status).toBe(400);
		const body = await response.json() as ValidationFailedBody;
		expect(body.code).toBe("validation_failed");
		expectTooBigIssue(body, "email", AUTH_EMAIL_MAX_LENGTH);
	});

	test("rejects multi-kilobyte emails with 400 validation_failed instead of a server error", async () => {
		const email = emailOfLength(3_072);

		const response = await postJson("/login", {
			email,
			password: strongPasswordOfLength(32),
		});

		expect(response.status).toBe(400);
		const body = await response.json() as ValidationFailedBody;
		expect(body.code).toBe("validation_failed");
		expect(body.details.some((issue) => issue.path.join(".") === "email")).toBe(true);
	});

	test("rejects oversized emails on forgot-password and admin update schemas", async () => {
		const email = emailOfLength(AUTH_EMAIL_MAX_LENGTH + 1);
		const forgot = await postJson("/forgot-password", { email });

		expect(forgot.status).toBe(400);
		expectTooBigIssue(await forgot.json() as ValidationFailedBody, "email", AUTH_EMAIL_MAX_LENGTH);

		const { token, targetEmail } = await createAdminAndTarget("admin-email-cap");
		const admin = await auth.request(`/users/${encodeURIComponent((await findUserByEmail(targetEmail))!.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ email }),
		});

		expect(admin.status).toBe(400);
		const body = await admin.json() as ValidationFailedBody;
		expect(body.code).toBe("validation_failed");
		expectTooBigIssue(body, "email", AUTH_EMAIL_MAX_LENGTH);
		expect((await findUserByEmail(targetEmail))?.email).toBe(targetEmail);
	});

	test("rejects 129-character passwords with a localizable max-length rule code", async () => {
		const password = strongPasswordOfLength(PASSWORD_MAX_LENGTH + 1);
		const validation = validatePassword(password);

		expect(validation.valid).toBe(false);
		expect(validation.codes).toContain("password_max_length");

		const response = await postJson("/register", {
			email: uniqueEmail("password-too-long"),
			password,
			name: "Too Long Password",
		});

		expect(response.status).toBe(400);
		const body = await response.json() as ValidationFailedBody;
		expect(body.code).toBe("validation_failed");
		const issue = expectTooBigIssue(body, "password", PASSWORD_MAX_LENGTH);
		expect(issue.message).toBe("password_max_length");
	});

	test("rejects oversized passwords on change, reset, and SSO link-confirm schemas", async () => {
		const password = strongPasswordOfLength(PASSWORD_MAX_LENGTH + 1);
		const { token } = await createAuthedUser("change-password-cap");

		const change = await postJson("/change-password", {
			oldPassword: strongPasswordOfLength(32),
			newPassword: password,
		}, { Authorization: `Bearer ${token}` });
		expect(change.status).toBe(400);
		expect((expectTooBigIssue(await change.json() as ValidationFailedBody, "newPassword", PASSWORD_MAX_LENGTH)).message).toBe("password_max_length");

		const reset = await postJson("/reset-password", {
			token: "r".repeat(32),
			newPassword: password,
		});
		expect(reset.status).toBe(400);
		expect((expectTooBigIssue(await reset.json() as ValidationFailedBody, "newPassword", PASSWORD_MAX_LENGTH)).message).toBe("password_max_length");

		// SSO link-confirm's currentPassword VERIFIES an existing credential, so it
		// uses the generous verify-side bound (1024) — a pre-cap long password must
		// not be locked out of linking (review #587 P2). Only the DoS ceiling rejects.
		const link = await postJson("/sso/link/confirm", {
			link_intent_token: "intent",
			currentPassword: strongPasswordOfLength(1025),
		});
		expect(link.status).toBe(400);
		expect((expectTooBigIssue(await link.json() as ValidationFailedBody, "currentPassword", 1024)).message).toBe("password_max_length");
	});

	test("login + change-password CURRENT fields accept legacy >128-char passwords (verify-side bound)", async () => {
		// An account that registered before the 128 cap must still be able to LOG IN
		// and to supply its old password when changing it — only the 1024 DoS
		// ceiling applies on verification fields (review #587 P2).
		const legacy = strongPasswordOfLength(PASSWORD_MAX_LENGTH + 64);
		const login = await postJson("/login", { email: "legacy-cap@example.com", password: legacy });
		// 401 (unknown credentials) — NOT 400 validation_failed.
		expect(login.status).toBe(401);

		const { token } = await createAuthedUser("legacy-old-password");
		const change = await postJson("/change-password", {
			oldPassword: legacy,
			newPassword: strongPasswordOfLength(32),
		}, { Authorization: `Bearer ${token}` });
		// Wrong old password → 400/401 from the credential CHECK, never a zod
		// too_big on oldPassword.
		const body = await change.json() as ValidationFailedBody & { code?: string };
		expect(JSON.stringify(body)).not.toContain("too_big");
	});

	test("accepts boundary email 254 and password 128 through registration validation", async () => {
		const email = emailOfLength(AUTH_EMAIL_MAX_LENGTH);
		const password = strongPasswordOfLength(PASSWORD_MAX_LENGTH);
		createdEmails.add(email);

		expect(validatePassword(password).valid).toBe(true);

		const response = await postJson("/register", {
			email,
			password,
			name: "Boundary User",
		}, { "x-real-ip": "203.0.113.201" });

		expect(response.status).toBe(201);
		const body = await response.json() as { user: { email: string } };
		expect(body.user.email).toBe(email);
		expect((await findUserByEmail(email))?.email).toBe(email);
	});
});

type ValidationIssue = {
	code: string;
	path: Array<string | number>;
	message: string;
	maximum?: number;
};

type ValidationFailedBody = {
	code: "validation_failed";
	details: ValidationIssue[];
};

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return Promise.resolve(auth.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	}));
}

function uniqueEmail(tag: string): string {
	const email = `auth-cap-${tag}-${randomUUID()}-${testRunId}@example.com`;
	createdEmails.add(email);
	return email;
}

function emailOfLength(length: number): string {
	const local = "a".repeat(64);
	const domainLength = length - local.length - 1;
	if (domainLength < 2) throw new Error(`Cannot build an email of length ${length}`);

	const labels: string[] = [];
	let remaining = domainLength;
	let labelIndex = 0;
	while (remaining > 63) {
		labels.push(String.fromCharCode(98 + (labelIndex % 24)).repeat(63));
		remaining -= 64; // label plus separator dot
		labelIndex += 1;
	}
	labels.push("z".repeat(remaining));

	const email = `${local}@${labels.join(".")}`;
	expect(email.length).toBe(length);
	return email;
}

function strongPasswordOfLength(length: number): string {
	const prefix = "Aa1!";
	if (length < prefix.length) throw new Error(`Password length must be at least ${prefix.length}`);
	return `${prefix}${"x".repeat(length - prefix.length)}`;
}

function expectTooBigIssue(body: ValidationFailedBody, field: string, maximum: number): ValidationIssue {
	const issue = body.details.find((candidate) => candidate.path.join(".") === field && candidate.code === "too_big");
	expect(issue).toBeDefined();
	expect(issue?.maximum).toBe(maximum);
	return issue!;
}

async function createAuthedUser(tag: string): Promise<{ token: string }> {
	const email = uniqueEmail(tag);
	const { user } = await createUser({
		email,
		password: strongPasswordOfLength(32),
		name: "Authed User",
		role: "editor",
	});
	const full = await loadUser(user.id);
	const tokens = await generateTokens(full!);
	return { token: tokens.accessToken };
}

async function createAdminAndTarget(tag: string): Promise<{ token: string; targetEmail: string }> {
	const adminEmail = uniqueEmail(`${tag}-admin`);
	const { user: admin } = await createUser({
		email: adminEmail,
		password: strongPasswordOfLength(32),
		name: "Admin User",
		role: "admin",
	});
	const targetEmail = uniqueEmail(`${tag}-target`);
	await createUser({
		email: targetEmail,
		password: strongPasswordOfLength(32),
		name: "Target User",
		role: "editor",
	});
	const full = await loadUser(admin.id);
	const tokens = await generateTokens(full!);
	return { token: tokens.accessToken, targetEmail };
}
