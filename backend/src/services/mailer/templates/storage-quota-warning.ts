import { escapeHtml, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface StorageQuotaWarningData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	usedPct: number;
	manageUrl: string;
}

export default function storageQuotaWarning(data: StorageQuotaWarningData): RenderedTemplate {
	const locale = data.locale || "en";
	const subject = `${data.workspaceName} storage is ${data.usedPct}% used`;
	const title = "Storage quota warning";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 20px">${escapeHtml(data.workspaceName)} has used ${escapeHtml(data.usedPct)}% of its storage quota. Review storage before uploads or exports are blocked.</p>
<p style="margin:0">${renderButton("Manage storage", data.manageUrl, data.appUrl)}</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "storage-quota-warning", locale, preheader: `${data.workspaceName} storage quota warning.`, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "storage-quota-warning", locale, title, lines: [`Hi ${data.user.name},`, `${data.workspaceName} has used ${data.usedPct}% of its storage quota.`, "Review storage before uploads or exports are blocked."], actionLabel: "Manage storage", actionUrl: data.manageUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
