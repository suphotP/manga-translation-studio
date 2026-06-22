import type { MailerEnvConfig } from "../../config.js";
import { normalizeEmailMessage, type EmailMessage, type Mailer, type SendResult } from "../mailer.js";

export class NullMailer implements Mailer {
	constructor(private readonly config: MailerEnvConfig) {}

	async send(message: EmailMessage): Promise<SendResult> {
		const normalized = normalizeEmailMessage(message, this.config);
		console.log("[mailer:null] transactional email skipped", {
			to: normalized.to,
			from: normalized.from,
			replyTo: normalized.replyTo,
			subject: normalized.subject,
			tags: normalized.tags,
			idempotencyKey: normalized.idempotencyKey,
		});
		// Opt-in local preview: with no real mailer wired, print the plain-text body so
		// devs can read OTP codes / reset links from the console. OFF by default and
		// strictly env-gated, so production never logs email contents.
		if (process.env.MAILER_LOG_BODY === "true") {
			console.log("[mailer:null] body (MAILER_LOG_BODY)", { to: normalized.to, text: normalized.text });
		}
		return {
			success: true,
			provider: "null",
			status: "sent",
			messageId: `null_${Date.now()}`,
			retryable: false,
		};
	}
}
