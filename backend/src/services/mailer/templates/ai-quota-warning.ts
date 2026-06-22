import { escapeHtml, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface AiQuotaWarningData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	usedPct: number;
	topupUrl: string;
}

export default function aiQuotaWarning(data: AiQuotaWarningData): RenderedTemplate {
	const locale = data.locale || "en";
	const subject = `${data.workspaceName} AI quota is ${data.usedPct}% used`;
	const title = "AI quota warning";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 20px">${escapeHtml(data.workspaceName)} has used ${escapeHtml(data.usedPct)}% of its AI quota. Add credits before queued AI work is paused.</p>
<p style="margin:0">${renderButton("Add AI credits", data.topupUrl, data.appUrl)}</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "ai-quota-warning", locale, preheader: `${data.workspaceName} AI quota warning.`, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "ai-quota-warning", locale, title, lines: [`Hi ${data.user.name},`, `${data.workspaceName} has used ${data.usedPct}% of its AI quota.`, "Add credits before queued AI work is paused."], actionLabel: "Add AI credits", actionUrl: data.topupUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
