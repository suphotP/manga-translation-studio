import { readMailerEnvConfig } from "../../../config.js";

export interface MailUser {
	name: string;
	email: string;
}

export interface TemplateBaseData {
	locale?: string;
	appUrl?: string;
	viewInBrowserUrl?: string;
	unsubscribeUrl?: string;
}

export interface RenderedTemplate {
	subject: string;
	html: string;
	text: string;
}

export function escapeHtml(value: string | number | Date): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function absoluteAppUrl(path: string, appUrl = readMailerEnvConfig().appUrl): string {
	const base = appUrl.replace(/\/+$/, "");
	if (/^https?:\/\//i.test(path)) return path;
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function formatDate(value: string | Date, locale = "en"): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatMoney(amount: number, currency: string, locale = "en"): string {
	return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export function renderButton(label: string, url: string, appUrl?: string): string {
	const href = escapeHtml(absoluteAppUrl(url, appUrl));
	return `<a href="${href}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">${escapeHtml(label)}</a>`;
}

export function renderLayout(options: {
	templateId: string;
	locale?: string;
	preheader: string;
	title: string;
	body: string;
	appUrl?: string;
	viewInBrowserUrl?: string;
	unsubscribeUrl?: string;
}): string {
	const locale = options.locale || "en";
	const viewUrl = options.viewInBrowserUrl ? absoluteAppUrl(options.viewInBrowserUrl, options.appUrl) : undefined;
	const unsubscribeUrl = options.unsubscribeUrl ? absoluteAppUrl(options.unsubscribeUrl, options.appUrl) : undefined;
	const footerRows = [
		viewUrl ? `View this email in your browser: <a href="${escapeHtml(viewUrl)}" style="color:#2563eb">${escapeHtml(viewUrl)}</a>` : undefined,
		unsubscribeUrl ? `Manage email preferences or unsubscribe: <a href="${escapeHtml(unsubscribeUrl)}" style="color:#2563eb">${escapeHtml(unsubscribeUrl)}</a>` : undefined,
	].filter((row): row is string => row !== undefined);
	const footer = footerRows.length > 0 ? `
          <tr>
            <td style="padding:20px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
              ${footerRows.map((row, index) => `<p style="margin:0${index < footerRows.length - 1 ? " 0 8px" : ""}">${row}</p>`).join("\n              ")}
            </td>
          </tr>` : "";
	return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;background:#f6f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;line-height:1.5">
  <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(options.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb;padding:24px 0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #e5e7eb">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40px;height:40px;background:#111827;color:#ffffff;border-radius:8px;text-align:center;font-weight:800;font-size:14px">CW</td>
                  <td style="padding-left:12px">
                    <div style="font-size:18px;font-weight:800;color:#111827">Comic Workspace</div>
                    <div style="font-size:12px;color:#6b7280">Manga localization production workspace</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px">
              <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#111827">${escapeHtml(options.title)}</h1>
              ${options.body}
            </td>
          </tr>
${footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderText(options: {
	title: string;
	lines: Array<string | undefined | null>;
	actionLabel?: string;
	actionUrl?: string;
	viewInBrowserUrl?: string;
	unsubscribeUrl?: string;
	templateId: string;
	locale?: string;
	appUrl?: string;
}): string {
	const body = [
		options.title,
		"",
		...options.lines.filter((line): line is string => Boolean(line)),
		options.actionLabel && options.actionUrl ? "" : undefined,
		options.actionLabel && options.actionUrl ? `${options.actionLabel}: ${absoluteAppUrl(options.actionUrl, options.appUrl)}` : undefined,
		options.viewInBrowserUrl || options.unsubscribeUrl ? "" : undefined,
		options.viewInBrowserUrl ? `View in browser: ${absoluteAppUrl(options.viewInBrowserUrl, options.appUrl)}` : undefined,
		options.unsubscribeUrl ? `Unsubscribe: ${absoluteAppUrl(options.unsubscribeUrl, options.appUrl)}` : undefined,
	].filter((line): line is string => line !== undefined);
	return body.join("\n");
}
