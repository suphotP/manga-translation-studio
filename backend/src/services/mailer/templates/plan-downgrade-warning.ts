import { escapeHtml, formatDate, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";
import { planDowngradeCopy, resolveMailLocale } from "./mail-i18n.js";

export interface PlanDowngradeWarningData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	currentPlan: string;
	downgradeOn: string | Date;
	restoreUrl: string;
}

export default function planDowngradeWarning(data: PlanDowngradeWarningData): RenderedTemplate {
	const locale = data.locale || "en";
	const mailLocale = resolveMailLocale(data.locale);
	// The date is already locale-formatted via Intl.DateTimeFormat.
	const downgradeOn = formatDate(data.downgradeOn, locale);
	const htmlCopy = planDowngradeCopy(mailLocale, {
		userName: escapeHtml(data.user.name),
		workspaceName: escapeHtml(data.workspaceName),
		currentPlan: escapeHtml(data.currentPlan),
		downgradeOn: escapeHtml(downgradeOn),
	});
	const textCopy = planDowngradeCopy(mailLocale, {
		userName: data.user.name,
		workspaceName: data.workspaceName,
		currentPlan: data.currentPlan,
		downgradeOn,
	});
	const body = `
<p style="margin:0 0 16px">${htmlCopy.greeting}</p>
<p style="margin:0 0 20px">${htmlCopy.body}</p>
<p style="margin:0">${renderButton(htmlCopy.cta, data.restoreUrl, data.appUrl)}</p>`;
	return {
		subject: textCopy.subject,
		html: renderLayout({ templateId: "plan-downgrade-warning", locale, preheader: htmlCopy.preheader, title: htmlCopy.title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "plan-downgrade-warning", locale, title: textCopy.title, lines: [textCopy.greeting, textCopy.textBody, textCopy.textScheduled], actionLabel: textCopy.cta, actionUrl: data.restoreUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
