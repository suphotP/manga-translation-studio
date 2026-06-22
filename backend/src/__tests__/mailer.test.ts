import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MailerEnvConfig } from "../config.js";
import { defaultMailerProvider, readMailerProviderEnv } from "../config.js";
import { deriveTextFromHtml, getMailer, sendTransactionalEmail } from "../services/mailer.js";
import { NullMailer } from "../services/mailer/null.adapter.js";
import { ResendMailer } from "../services/mailer/resend.adapter.js";
import {
	renderTransactionalTemplate,
	transactionalTemplateNames,
	type TransactionalTemplateDataMap,
	type TransactionalTemplateName,
} from "../services/mailer/templates/index.js";

const originalFetch = globalThis.fetch;

const baseConfig: MailerEnvConfig = {
	provider: "null",
	resendApiKey: "re_test",
	resendDomain: "send.example.com",
	from: "Comic Workspace <hello@send.example.com>",
	replyTo: "support@example.com",
	appUrl: "https://app.example.com",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("mailer config", () => {
	test("defaults to null outside production and resend in production", () => {
		expect(defaultMailerProvider("development")).toBe("null");
		expect(defaultMailerProvider("test")).toBe("null");
		expect(defaultMailerProvider("production")).toBe("resend");
		expect(readMailerProviderEnv("resend", "development")).toBe("resend");
		expect(readMailerProviderEnv("null", "production")).toBe("null");
		expect(() => readMailerProviderEnv("smtp", "development")).toThrow('MAILER_PROVIDER must be "resend" or "null"');
	});
});

describe("NullMailer", () => {
	test("returns success and logs the skipped send", async () => {
		const logs: unknown[][] = [];
		const consoleSpy = mock((...args: unknown[]) => logs.push(args));
		const originalLog = console.log;
		console.log = consoleSpy;

		try {
			const result = await new NullMailer(baseConfig).send({
				to: "reader@example.com",
				subject: "Hello",
				html: "<p>Hello reader</p>",
				tags: [{ name: "template", value: "test" }],
			});

			expect(result).toMatchObject({ success: true, provider: "null", status: "sent", retryable: false });
			expect(logs).toHaveLength(1);
			expect(logs[0]?.[0]).toBe("[mailer:null] transactional email skipped");
			expect(logs[0]?.[1]).toMatchObject({
				to: "reader@example.com",
				from: baseConfig.from,
				replyTo: baseConfig.replyTo,
				subject: "Hello",
			});
		} finally {
			console.log = originalLog;
		}
	});
});

describe("ResendMailer", () => {
	test("sends the expected request body and idempotency header", async () => {
		const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown>; headers: Headers }> = [];
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
			calls.push({ url: String(input), init: init || {}, body, headers });
			return new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as unknown as typeof fetch;

		const result = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: ["reader@example.com", "owner@example.com"],
			subject: "Receipt",
			html: "<p>Paid</p>",
			replyTo: "billing@example.com",
			tags: [
				{ name: "template", value: "billing-receipt" },
				{ name: "workspace", value: "ws_1" },
			],
			idempotencyKey: "receipt_ws_1_invoice_9",
		});

		expect(result).toMatchObject({ success: true, provider: "resend", status: "sent", messageId: "email_123" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.resend.com/emails");
		expect(calls[0]?.headers.get("Authorization")).toBe("Bearer re_test");
		expect(calls[0]?.headers.get("Idempotency-Key")).toBe("receipt_ws_1_invoice_9");
		expect(calls[0]?.body).toMatchObject({
			to: ["reader@example.com", "owner@example.com"],
			from: baseConfig.from,
			reply_to: "billing@example.com",
			subject: "Receipt",
			html: "<p>Paid</p>",
			text: "Paid",
			tags: [
				{ name: "template", value: "billing-receipt" },
				{ name: "workspace", value: "ws_1" },
			],
			headers: {
				"X-Comic-Workspace-Tags": "template:billing-receipt,workspace:ws_1",
				"X-Comic-Workspace-Tag-template": "billing-receipt",
				"X-Comic-Workspace-Tag-workspace": "ws_1",
			},
		});
	});

	test("maps 4xx errors to permanent failure and 5xx/rate limit to retryable failure", async () => {
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			name: "validation_error",
			message: "Bad recipient",
			statusCode: 400,
		}), { status: 400 })) as unknown as typeof fetch;

		const permanent = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "bad@example.com",
			subject: "Bad",
			html: "<p>Bad</p>",
		});
		expect(permanent).toMatchObject({ success: false, status: "permanent_failure", retryable: false, statusCode: 400 });

		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			name: "rate_limit_exceeded",
			message: "Too many requests",
			statusCode: 429,
		}), { status: 429 })) as unknown as typeof fetch;

		const retryable = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "ok@example.com",
			subject: "Retry",
			html: "<p>Retry</p>",
		});
		expect(retryable).toMatchObject({ success: false, status: "retryable_failure", retryable: true, statusCode: 429 });
	});

	test("maps concurrent idempotent requests to retryable failure", async () => {
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			name: "concurrent_idempotent_requests",
			message: "Concurrent idempotent requests are in flight",
			statusCode: 409,
		}), { status: 409 })) as unknown as typeof fetch;

		const result = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "reader@example.com",
			subject: "Retry later",
			html: "<p>Retry later</p>",
			idempotencyKey: "reset_user_1",
		});

		expect(result).toMatchObject({ success: false, status: "retryable_failure", retryable: true, statusCode: 409 });
	});

	test("maps transport failures (DNS/TLS/timeout) to retryable failure", async () => {
		// The Resend SDK internally catches fetch rejections and resolves with an
		// { error: { name: "application_error", statusCode: null } } envelope rather
		// than rejecting. Either way the adapter must surface a retryable failure so
		// transient outages are queued for retry instead of crashing the workflow.
		globalThis.fetch = mock(async () => {
			throw new TypeError("fetch failed: ECONNRESET");
		}) as unknown as typeof fetch;

		const result = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "reader@example.com",
			subject: "Network down",
			html: "<p>Network down</p>",
		});

		expect(result).toMatchObject({
			success: false,
			provider: "resend",
			status: "retryable_failure",
			retryable: true,
			statusCode: null,
		});
		expect(result.error).toBeTruthy();
	});

	test("maps a raw SDK promise rejection to retryable failure (defensive catch)", async () => {
		// Guards against SDK versions/paths that reject instead of returning an
		// error envelope; the try/catch must still produce a retryable result.
		const throwingMailer = new ResendMailer({ ...baseConfig, provider: "resend" });
		(throwingMailer as unknown as { resend: { emails: { send: () => Promise<never> } } }).resend = {
			emails: {
				send: async () => {
					throw new Error("socket hang up");
				},
			},
		};

		const result = await throwingMailer.send({
			to: "reader@example.com",
			subject: "Reset",
			html: "<p>Reset</p>",
		});

		expect(result).toMatchObject({
			success: false,
			status: "retryable_failure",
			retryable: true,
			statusCode: null,
			error: "socket hang up",
		});
	});

	test("drops Resend-invalid native tags while keeping safe ones and header metadata", async () => {
		const calls: Array<{ body: Record<string, unknown> }> = [];
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			calls.push({ body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
			return new Response(JSON.stringify({ id: "email_tags" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as unknown as typeof fetch;

		const result = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "reader@example.com",
			subject: "Tags",
			html: "<p>Tags</p>",
			tags: [
				{ name: "template", value: "workspace-invite" },
				{ name: "workspace", value: "Moon Studio" }, // space -> invalid for native tags
				{ name: "entity", value: "chapter/12" }, // slash -> invalid for native tags
			],
		});

		expect(result).toMatchObject({ success: true, status: "sent", messageId: "email_tags" });
		// Only the provider-safe tag is forwarded to Resend's native tags field.
		expect(calls[0]?.body.tags).toEqual([{ name: "template", value: "workspace-invite" }]);
		// The full metadata (including the unsafe values) is still preserved in headers.
		expect(calls[0]?.body.headers).toMatchObject({
			"X-Comic-Workspace-Tags": "template:workspace-invite,workspace:Moon Studio,entity:chapter/12",
			"X-Comic-Workspace-Tag-template": "workspace-invite",
			"X-Comic-Workspace-Tag-workspace": "Moon Studio",
			"X-Comic-Workspace-Tag-entity": "chapter/12",
		});
	});

	test("omits the native tags field entirely when no tag is provider-safe", async () => {
		const calls: Array<{ body: Record<string, unknown> }> = [];
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			calls.push({ body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
			return new Response(JSON.stringify({ id: "email_no_tags" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as unknown as typeof fetch;

		await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "reader@example.com",
			subject: "Tags",
			html: "<p>Tags</p>",
			tags: [{ name: "workspace name", value: "Moon Studio" }],
		});

		expect(calls[0]?.body.tags).toBeUndefined();
	});

	test("treats a success response without a message id as retryable failure", async () => {
		globalThis.fetch = mock(async () => new Response(JSON.stringify({}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		const result = await new ResendMailer({ ...baseConfig, provider: "resend" }).send({
			to: "reader@example.com",
			subject: "No id",
			html: "<p>No id</p>",
		});

		expect(result).toMatchObject({ success: false, status: "retryable_failure", retryable: true });
		expect(result.messageId).toBeUndefined();
	});
});

describe("transactional templates", () => {
	test.each(transactionalTemplateNames)("renders %s without nonexistent default footer routes", (name) => {
		const rendered = renderTransactionalTemplate(name, sampleData[name] as never);

		expect(rendered.subject.length).toBeGreaterThan(5);
		expect(rendered.html).toContain("<!doctype html>");
		expect(rendered.html).toContain("Comic Workspace");
		expect(rendered.html).not.toContain("https://app.example.com/email/view/");
		expect(rendered.html).not.toContain("https://app.example.com/settings/notifications");
		expect(rendered.text.length).toBeGreaterThan(20);
		expect(rendered.text).not.toContain("View in browser: https://app.example.com/email/view/");
		expect(rendered.text).not.toContain("Unsubscribe: https://app.example.com/settings/notifications");
	});

	test("localizes the payment-failed dunning email per locale with plural day copy", () => {
		const base = {
			user: sampleUser,
			workspaceName: "Moon Studio",
			retryUrl: "https://app.example.com/billing/retry",
		};

		// English: subject + body localized, plural day form ("days" for 7).
		const en = renderTransactionalTemplate("payment-failed", { ...base, locale: "en", daysUntilDowngrade: 7 });
		expect(en.subject).toBe("Payment failed for Moon Studio");
		expect(en.html).toContain("within 7 days");
		expect(en.text).toContain("within 7 days");

		// English singular form for 1 day (Intl.PluralRules "one").
		const enOne = renderTransactionalTemplate("payment-failed", { ...base, locale: "en", daysUntilDowngrade: 1 });
		expect(enOne.html).toContain("within 1 day");
		expect(enOne.html).not.toContain("within 1 days");

		// Thai: localized subject/body, no English leakage.
		const th = renderTransactionalTemplate("payment-failed", { ...base, locale: "th", daysUntilDowngrade: 7 });
		expect(th.subject).toContain("Moon Studio");
		expect(th.subject).not.toContain("Payment failed");
		expect(th.html).toContain("Moon Studio");
		expect(th.html).not.toContain("Update payment");
		expect(th.html).toContain("7 วัน");

		// Arabic: localized + uses an Arabic plural category form for 3.
		const ar = renderTransactionalTemplate("payment-failed", { ...base, locale: "ar", daysUntilDowngrade: 3 });
		expect(ar.subject).toContain("Moon Studio");
		expect(ar.html).not.toContain("Update payment");
		expect(ar.html).toContain("3 أيام");

		// Unknown locale falls back to English copy.
		const fallback = renderTransactionalTemplate("payment-failed", { ...base, locale: "de", daysUntilDowngrade: 5 });
		expect(fallback.subject).toBe("Payment failed for Moon Studio");
		expect(fallback.html).toContain("within 5 days");
	});

	test("localizes the plan-downgrade-warning email per locale", () => {
		const base = {
			user: sampleUser,
			workspaceName: "Moon Studio",
			currentPlan: "Studio",
			downgradeOn: "2026-06-09T00:00:00.000Z",
			restoreUrl: "https://app.example.com/billing/restore",
		};
		const en = renderTransactionalTemplate("plan-downgrade-warning", { ...base, locale: "en" });
		expect(en.subject).toBe("Moon Studio will downgrade soon");
		expect(en.html).toContain("Restore plan");

		const ja = renderTransactionalTemplate("plan-downgrade-warning", { ...base, locale: "ja" });
		expect(ja.subject).toContain("Moon Studio");
		expect(ja.html).not.toContain("will downgrade soon");
		expect(ja.html).not.toContain("Restore plan");
	});

	test("renders caller-provided footer URLs when explicitly supplied", () => {
		const rendered = renderTransactionalTemplate("weekly-digest", {
			...sampleData["weekly-digest"],
			viewInBrowserUrl: "/email/messages/msg_1",
			unsubscribeUrl: "/settings/notifications?workspace=ws_1",
		});

		expect(rendered.html).toContain("https://app.example.com/email/messages/msg_1");
		expect(rendered.html).toContain("https://app.example.com/settings/notifications?workspace=ws_1");
		expect(rendered.text).toContain("View in browser: https://app.example.com/email/messages/msg_1");
		expect(rendered.text).toContain("Unsubscribe: https://app.example.com/settings/notifications?workspace=ws_1");
	});

	test("sendTransactionalEmail renders and sends through the active mailer", async () => {
		const sent: unknown[] = [];
		const mailer = {
			send: mock(async (message: unknown) => {
				sent.push(message);
				return { success: true, provider: "null" as const, status: "sent" as const, retryable: false };
			}),
		};

		const result = await sendTransactionalEmail("password-reset", sampleData["password-reset"], "en", {
			mailer,
			config: baseConfig,
			idempotencyKey: "reset_user_1",
		});

		expect(result.success).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: "reader@example.com",
			subject: "Reset your Comic Workspace password",
			idempotencyKey: "reset_user_1",
			tags: [
				{ name: "template", value: "password-reset" },
				{ name: "locale", value: "en" },
			],
		});
	});

	test("sendTransactionalEmail uses injected appUrl for relative template links", async () => {
		const sent: Array<{ html: string; text: string }> = [];
		const mailer = {
			send: mock(async (message: { html: string; text?: string }) => {
				sent.push({ html: message.html, text: message.text || "" });
				return { success: true, provider: "null" as const, status: "sent" as const, retryable: false };
			}),
		};

		const result = await sendTransactionalEmail("password-reset", {
			...sampleData["password-reset"],
			resetUrl: "/reset?token=abc",
			viewInBrowserUrl: "/email/messages/msg_1",
		}, "en", {
			mailer,
			config: { ...baseConfig, appUrl: "https://staging.example.com/" },
		});

		expect(result.success).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.html).toContain("https://staging.example.com/reset?token=abc");
		expect(sent[0]?.html).toContain("https://staging.example.com/email/messages/msg_1");
		expect(sent[0]?.text).toContain("Reset password: https://staging.example.com/reset?token=abc");
		expect(sent[0]?.text).toContain("View in browser: https://staging.example.com/email/messages/msg_1");
	});
});

describe("mailer helpers", () => {
	test("deriveTextFromHtml produces a plain text fallback", () => {
		expect(deriveTextFromHtml("<h1>Hello</h1><p>Tom &amp; Jerry</p>")).toBe("Hello\nTom & Jerry");
	});

	test("getMailer returns the requested adapter", () => {
		expect(getMailer({ ...baseConfig, provider: "null" })).toBeInstanceOf(NullMailer);
		expect(getMailer({ ...baseConfig, provider: "resend" })).toBeInstanceOf(ResendMailer);
	});
});

const sampleUser = { name: "Reader One", email: "reader@example.com" };

const sampleData: { [Name in TransactionalTemplateName]: TransactionalTemplateDataMap[Name] } = {
	"registration-verify": {
		locale: "en",
		user: sampleUser,
		verifyUrl: "https://app.example.com/verify?token=abc",
	},
	"password-reset": {
		locale: "en",
		user: sampleUser,
		resetUrl: "https://app.example.com/reset?token=abc",
		expiresAt: "2026-06-02T12:00:00.000Z",
	},
	"workspace-invite": {
		locale: "en",
		invitee: sampleUser,
		workspaceName: "Moon Studio",
		inviterName: "Mina",
		acceptUrl: "https://app.example.com/invites/inv_1",
		expiresAt: "2026-06-03T12:00:00.000Z",
	},
	"billing-receipt": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		planName: "Studio",
		amount: 49,
		currency: "USD",
		invoiceUrl: "https://app.example.com/billing/invoices/inv_1",
		periodStart: "2026-06-01T00:00:00.000Z",
		periodEnd: "2026-06-30T23:59:59.000Z",
	},
	"payment-failed": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		retryUrl: "https://app.example.com/billing/retry",
		daysUntilDowngrade: 7,
	},
	"plan-downgrade-warning": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		currentPlan: "Studio",
		downgradeOn: "2026-06-09T00:00:00.000Z",
		restoreUrl: "https://app.example.com/billing/restore",
	},
	"storage-quota-warning": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		usedPct: 90,
		manageUrl: "https://app.example.com/billing/storage",
	},
	"ai-quota-warning": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		usedPct: 85,
		topupUrl: "https://app.example.com/billing/credits",
	},
	"weekly-digest": {
		locale: "en",
		user: sampleUser,
		workspaceName: "Moon Studio",
		summary: "12 pages completed\n3 review comments resolved",
		dashboardUrl: "https://app.example.com/dashboard",
	},
	"notification-generic": {
		locale: "en",
		user: sampleUser,
		subject: "You were assigned QC work",
		heading: "New work assignment",
		body: "Chapter 12 is now in QC and assigned to you.",
		actionLabel: "Open work",
		actionUrl: "https://app.example.com/projects/p_1/work",
	},
};
