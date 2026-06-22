import { escapeHtml, formatDate, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface WorkspaceInviteData extends TemplateBaseData {
	invitee: MailUser;
	workspaceName: string;
	inviterName: string;
	acceptUrl: string;
	expiresAt: string | Date;
}

export default function workspaceInvite(data: WorkspaceInviteData): RenderedTemplate {
	const locale = data.locale || "en";
	const expires = formatDate(data.expiresAt, locale);
	const subject = `${data.inviterName} invited you to ${data.workspaceName}`;
	const title = "Workspace invitation";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.invitee.name)},</p>
<p style="margin:0 0 20px">${escapeHtml(data.inviterName)} invited you to join ${escapeHtml(data.workspaceName)} in Comic Workspace. This invite expires at ${escapeHtml(expires)}.</p>
<p style="margin:0 0 20px">${renderButton("Accept invitation", data.acceptUrl, data.appUrl)}</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "workspace-invite", locale, preheader: `Join ${data.workspaceName} in Comic Workspace.`, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "workspace-invite", locale, title, lines: [`Hi ${data.invitee.name},`, `${data.inviterName} invited you to join ${data.workspaceName} in Comic Workspace.`, `This invite expires at ${expires}.`], actionLabel: "Accept invitation", actionUrl: data.acceptUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
