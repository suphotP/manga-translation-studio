import { escapeHtml, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

/**
 * Generic transactional notification email. The central notify() dispatcher
 * renders every notification's email through this template, so adding a new
 * notification type never requires a new bespoke email template — just a
 * registry entry (title/body/CTA come from the notify() payload).
 */
export interface NotificationGenericData extends TemplateBaseData {
	user: MailUser;
	subject: string;
	heading: string;
	body: string;
	actionLabel?: string;
	actionUrl?: string;
}

export default function notificationGeneric(data: NotificationGenericData): RenderedTemplate {
	const locale = data.locale || "en";
	const subject = data.subject;
	const title = data.heading;
	const greeting = data.user.name ? `<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>` : "";
	const cta = data.actionLabel && data.actionUrl
		? `<p style="margin:0">${renderButton(data.actionLabel, data.actionUrl, data.appUrl)}</p>`
		: "";
	const body = `${greeting}
<p style="margin:0 0 20px">${escapeHtml(data.body)}</p>
${cta}`;
	return {
		subject,
		html: renderLayout({
			templateId: "notification-generic",
			locale,
			preheader: data.body.slice(0, 140),
			title,
			body,
			appUrl: data.appUrl,
			viewInBrowserUrl: data.viewInBrowserUrl,
			unsubscribeUrl: data.unsubscribeUrl,
		}),
		text: renderText({
			templateId: "notification-generic",
			locale,
			title,
			lines: [data.user.name ? `Hi ${data.user.name},` : undefined, data.body],
			actionLabel: data.actionLabel,
			actionUrl: data.actionUrl,
			appUrl: data.appUrl,
			viewInBrowserUrl: data.viewInBrowserUrl,
			unsubscribeUrl: data.unsubscribeUrl,
		}),
	};
}
