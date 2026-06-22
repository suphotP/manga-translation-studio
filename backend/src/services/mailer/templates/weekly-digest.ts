import { escapeHtml, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface WeeklyDigestData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	summary: string;
	dashboardUrl: string;
}

export default function weeklyDigest(data: WeeklyDigestData): RenderedTemplate {
	const locale = data.locale || "en";
	const subject = `${data.workspaceName} weekly digest`;
	const title = "Weekly workspace digest";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 20px;white-space:pre-line">${escapeHtml(data.summary)}</p>
<p style="margin:0">${renderButton("Open dashboard", data.dashboardUrl, data.appUrl)}</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "weekly-digest", locale, preheader: `${data.workspaceName} weekly digest.`, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "weekly-digest", locale, title, lines: [`Hi ${data.user.name},`, data.summary], actionLabel: "Open dashboard", actionUrl: data.dashboardUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
