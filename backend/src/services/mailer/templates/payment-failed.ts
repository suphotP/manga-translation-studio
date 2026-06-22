import { escapeHtml, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";
import { paymentFailedCopy, paymentFailedTitle, resolveMailLocale } from "./mail-i18n.js";

export interface PaymentFailedData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	retryUrl: string;
	daysUntilDowngrade: number;
}

export default function paymentFailed(data: PaymentFailedData): RenderedTemplate {
	const locale = data.locale || "en";
	const mailLocale = resolveMailLocale(data.locale);
	// HTML copy interpolates already-escaped user-controlled values so the
	// localized template drops straight into markup; text copy uses raw values.
	// `daysUntilDowngrade` uses Intl.PluralRules inside the catalog.
	const htmlCopy = paymentFailedCopy(mailLocale, {
		userName: escapeHtml(data.user.name),
		workspaceName: escapeHtml(data.workspaceName),
		daysUntilDowngrade: data.daysUntilDowngrade,
	});
	const textCopy = paymentFailedCopy(mailLocale, {
		userName: data.user.name,
		workspaceName: data.workspaceName,
		daysUntilDowngrade: data.daysUntilDowngrade,
	});
	const title = paymentFailedTitle(mailLocale);
	const body = `
<p style="margin:0 0 16px">${htmlCopy.greeting}</p>
<p style="margin:0 0 20px">${htmlCopy.body}</p>
<p style="margin:0">${renderButton(htmlCopy.cta, data.retryUrl, data.appUrl)}</p>`;
	return {
		subject: textCopy.subject,
		html: renderLayout({ templateId: "payment-failed", locale, preheader: htmlCopy.preheader, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "payment-failed", locale, title, lines: [textCopy.greeting, textCopy.body], actionLabel: textCopy.cta, actionUrl: data.retryUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
