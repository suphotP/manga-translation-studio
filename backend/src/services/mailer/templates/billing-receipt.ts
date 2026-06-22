import { escapeHtml, formatDate, formatMoney, renderButton, renderLayout, renderText, type MailUser, type RenderedTemplate, type TemplateBaseData } from "./shared.js";

export interface BillingReceiptData extends TemplateBaseData {
	user: MailUser;
	workspaceName: string;
	planName: string;
	amount: number;
	currency: string;
	invoiceUrl: string;
	periodStart: string | Date;
	periodEnd: string | Date;
}

export default function billingReceipt(data: BillingReceiptData): RenderedTemplate {
	const locale = data.locale || "en";
	const amount = formatMoney(data.amount, data.currency, locale);
	const period = `${formatDate(data.periodStart, locale)} - ${formatDate(data.periodEnd, locale)}`;
	const subject = `Receipt for ${data.workspaceName}`;
	const title = "Billing receipt";
	const body = `
<p style="margin:0 0 16px">Hi ${escapeHtml(data.user.name)},</p>
<p style="margin:0 0 16px">We received your payment for ${escapeHtml(data.workspaceName)}.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:collapse">
  <tr><td style="padding:8px 0;color:#6b7280">Plan</td><td align="right" style="padding:8px 0">${escapeHtml(data.planName)}</td></tr>
  <tr><td style="padding:8px 0;color:#6b7280">Amount</td><td align="right" style="padding:8px 0">${escapeHtml(amount)}</td></tr>
  <tr><td style="padding:8px 0;color:#6b7280">Period</td><td align="right" style="padding:8px 0">${escapeHtml(period)}</td></tr>
</table>
<p style="margin:0">${renderButton("View invoice", data.invoiceUrl, data.appUrl)}</p>`;
	return {
		subject,
		html: renderLayout({ templateId: "billing-receipt", locale, preheader: `Receipt for ${data.workspaceName}.`, title, body, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
		text: renderText({ templateId: "billing-receipt", locale, title, lines: [`Hi ${data.user.name},`, `We received your payment for ${data.workspaceName}.`, `Plan: ${data.planName}`, `Amount: ${amount}`, `Period: ${period}`], actionLabel: "View invoice", actionUrl: data.invoiceUrl, appUrl: data.appUrl, viewInBrowserUrl: data.viewInBrowserUrl, unsubscribeUrl: data.unsubscribeUrl }),
	};
}
