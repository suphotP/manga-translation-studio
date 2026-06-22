import { escapeHtml, formatDate, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface PasswordResetData extends TemplateBaseData {
	user: MailUser;
	resetUrl: string;
	expiresAt: string | Date;
}

export default function passwordReset(data: PasswordResetData): RenderedTemplate {
	const locale = data.locale || "en";
	const expires = formatDate(data.expiresAt, locale);
	const subject = "Reset your Comic Workspace password";
	const title = "Reset your password";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 20px">Use this secure link to reset your password. The link expires at ${escapeHtml(expires)}.</p>
<p style="margin:0 0 20px">${renderButton("Reset password", data.resetUrl, data.appUrl)}</p>
<p style="margin:0;color:#6b7280;font-size:13px">If you did not request a reset, you can ignore this email.</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "password-reset", locale, preheader: "Reset your Comic Workspace password.", title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "password-reset", locale, title, lines: [`Hi ${data.user.name},`, `Use this secure link to reset your password. The link expires at ${expires}.`, "If you did not request a reset, you can ignore this email."], actionLabel: "Reset password", actionUrl: data.resetUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
