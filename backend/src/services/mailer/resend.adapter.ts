import { Resend } from "resend";
import type { MailerEnvConfig } from "../../config.js";
import { normalizeEmailMessage, type EmailMessage, type Mailer, type SendResult } from "../mailer.js";

function sanitizeHeaderKey(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tag";
}

function buildTagHeaders(tags: EmailMessage["tags"]): Record<string, string> {
	if (!tags?.length) return {};
	const headers: Record<string, string> = {
		"X-Comic-Workspace-Tags": tags.map((tag) => `${tag.name}:${tag.value}`).join(","),
	};
	for (const tag of tags) {
		headers[`X-Comic-Workspace-Tag-${sanitizeHeaderKey(tag.name)}`] = tag.value;
	}
	return headers;
}

// Resend's native `tags` field only accepts ASCII letters, digits, `_`, and
// `-`, capped at 256 chars per name/value. Callers attach arbitrary metadata
// (workspace names like `Moon Studio`, entity keys containing `/`, etc.), which
// Resend would reject as a permanent validation failure. We already carry the
// full, unmodified metadata in the X-Comic-Workspace-Tag* headers, so here we
// only forward tags whose name and value are already provider-safe and drop the
// rest rather than mangling them.
const RESEND_TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function buildResendTags(tags: EmailMessage["tags"]): Array<{ name: string; value: string }> | undefined {
	if (!tags?.length) return undefined;
	const safe = tags
		.filter((tag) => RESEND_TAG_PATTERN.test(tag.name) && RESEND_TAG_PATTERN.test(tag.value))
		.map((tag) => ({ name: tag.name, value: tag.value }));
	return safe.length ? safe : undefined;
}

function isRetryableResendError(statusCode: number | null | undefined, name: string | undefined): boolean {
	if (statusCode === null || statusCode === undefined) return true;
	if (statusCode === 429 || statusCode >= 500) return true;
	return name === "rate_limit_exceeded"
		|| name === "internal_server_error"
		|| name === "application_error"
		|| name === "concurrent_idempotent_requests";
}

export class ResendMailer implements Mailer {
	private readonly resend: Resend;

	constructor(private readonly config: MailerEnvConfig) {
		if (!config.resendApiKey) {
			throw new Error("RESEND_API_KEY is required when MAILER_PROVIDER=resend");
		}
		this.resend = new Resend(config.resendApiKey);
	}

	async send(message: EmailMessage): Promise<SendResult> {
		const normalized = normalizeEmailMessage(message, this.config);
		let response: Awaited<ReturnType<Resend["emails"]["send"]>>;
		try {
			response = await this.resend.emails.send({
				to: normalized.to,
				from: normalized.from,
				replyTo: normalized.replyTo,
				subject: normalized.subject,
				html: normalized.html,
				text: normalized.text,
				tags: buildResendTags(normalized.tags),
				headers: buildTagHeaders(normalized.tags),
			}, {
				idempotencyKey: normalized.idempotencyKey,
			});
		} catch (error) {
			// The Resend SDK normally resolves with { data, error }, but a transport
			// failure (DNS/TLS error, connection reset, fetch timeout) rejects the
			// promise. Map it to a retryable failure so transient outages are queued
			// for retry instead of crashing the transactional-email workflow.
			return {
				success: false,
				provider: "resend",
				status: "retryable_failure",
				retryable: true,
				error: error instanceof Error ? error.message : "Resend transport error",
				statusCode: null,
			};
		}

		if (response.error) {
			const retryable = isRetryableResendError(response.error.statusCode, response.error.name);
			return {
				success: false,
				provider: "resend",
				status: retryable ? "retryable_failure" : "permanent_failure",
				retryable,
				error: response.error.message,
				statusCode: response.error.statusCode,
			};
		}

		// Defensive: Resend should return either error or data, but a malformed
		// success response without a message id is treated as retryable rather
		// than throwing an unhandled TypeError on `response.data.id`.
		if (!response.data?.id) {
			return {
				success: false,
				provider: "resend",
				status: "retryable_failure",
				retryable: true,
				error: "Resend returned no message id",
				statusCode: null,
			};
		}

		return {
			success: true,
			provider: "resend",
			status: "sent",
			messageId: response.data.id,
			retryable: false,
			statusCode: 200,
		};
	}
}
