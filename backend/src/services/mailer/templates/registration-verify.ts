import { escapeHtml, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface RegistrationVerifyData extends TemplateBaseData {
	user: MailUser;
	/** Six-digit one-time code the user types into the verification screen. */
	code: string;
	/** Minutes until the code expires (rendered in the email copy). */
	expiresMinutes: number;
}

export default function registrationVerify(data: RegistrationVerifyData): RenderedTemplate {
	const locale = data.locale || "en";
	const subject = "Your Comic Workspace verification code";
	const title = "Verify your account";
	const code = escapeHtml(data.code);
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 20px">Enter this code on the verification screen to finish setting up your Comic Workspace account:</p>
<p style="margin:0 0 20px;text-align:center">
  <span style="display:inline-block;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;padding:14px 22px;border-radius:12px;background:#f3f4f6;color:#111827">${code}</span>
</p>
<p style="margin:0 0 20px;color:#6b7280;font-size:13px">This code expires in ${data.expiresMinutes} minutes. If you did not create this account, you can ignore this email.</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "registration-verify", locale, preheader: "Your Comic Workspace verification code.", title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "registration-verify", locale, title, lines: [`Hi ${data.user.name},`, `Your verification code is: ${data.code}`, `This code expires in ${data.expiresMinutes} minutes.`, "If you did not create this account, you can ignore this email."], appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
