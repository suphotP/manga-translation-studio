import { readMailerEnvConfig, type MailerEnvConfig, type MailerProvider } from "../config.js";
import { NullMailer } from "./mailer/null.adapter.js";
import { ResendMailer } from "./mailer/resend.adapter.js";
import { renderTransactionalTemplate, resolveTransactionalRecipient, type TransactionalTemplateData, type TransactionalTemplateName } from "./mailer/templates/index.js";

export interface EmailTag {
	name: string;
	value: string;
}

export interface EmailMessage {
	to: string | string[];
	from?: string;
	replyTo?: string;
	subject: string;
	html: string;
	text?: string;
	tags?: EmailTag[];
	idempotencyKey?: string;
}

export type SendStatus = "sent" | "permanent_failure" | "retryable_failure";

export interface SendResult {
	success: boolean;
	provider: MailerProvider;
	status: SendStatus;
	messageId?: string;
	retryable: boolean;
	error?: string;
	statusCode?: number | null;
}

export interface Mailer {
	send(message: EmailMessage): Promise<SendResult>;
}

export function deriveTextFromHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export function normalizeEmailMessage(message: EmailMessage, config: MailerEnvConfig = readMailerEnvConfig()): Required<Pick<EmailMessage, "from" | "replyTo" | "text">> & EmailMessage {
	return {
		...message,
		from: message.from || config.from,
		replyTo: message.replyTo || config.replyTo,
		text: message.text || deriveTextFromHtml(message.html),
	};
}

export function getMailer(config: MailerEnvConfig = readMailerEnvConfig()): Mailer {
	if (config.provider === "resend") return new ResendMailer(config);
	return new NullMailer(config);
}

export async function sendTransactionalEmail<Name extends TransactionalTemplateName>(
	template: Name,
	data: TransactionalTemplateData<Name>,
	locale = "en",
	options: { mailer?: Mailer; config?: MailerEnvConfig; idempotencyKey?: string; tags?: EmailTag[] } = {},
): Promise<SendResult> {
	const config = options.config || readMailerEnvConfig();
	const rendered = renderTransactionalTemplate(template, { ...data, locale, appUrl: config.appUrl } as TransactionalTemplateData<Name>);
	const tags: EmailTag[] = [
		{ name: "template", value: template },
		{ name: "locale", value: locale },
		...(options.tags || []),
	];
	const mailer = options.mailer || getMailer(config);

	return mailer.send({
		to: resolveTransactionalRecipient(template, data),
		subject: rendered.subject,
		html: rendered.html,
		text: rendered.text,
		tags,
		idempotencyKey: options.idempotencyKey,
	});
}
