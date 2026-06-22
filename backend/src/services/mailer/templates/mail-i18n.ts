// Backend transactional-email message catalog.
//
// Transactional templates used to render English-only subjects/bodies even
// though they accepted a `locale`. This catalog localizes the dunning emails
// (payment-failed + plan-downgrade-warning) for the locales the frontend
// supports (th/en/ko/ja/zh/ar), with `Intl.PluralRules` for day/count copy and
// a safe English fallback for any unknown locale.
//
// Keep this catalog small and template-scoped: each template owns a `subject`
// + `lines` builder so its copy stays self-documenting. Interpolation is done
// with explicit named params (no positional surprises).

/** Locales with full mail translations; everything else falls back to en. */
export const MAIL_LOCALES = ["en", "th", "ko", "ja", "zh", "ar"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

const DEFAULT_MAIL_LOCALE: MailLocale = "en";

/** Normalize an arbitrary `locale` to a supported mail locale (primary tag). */
export function resolveMailLocale(locale: string | undefined): MailLocale {
	if (!locale) return DEFAULT_MAIL_LOCALE;
	const primary = locale.toLowerCase().split("-")[0] ?? "";
	return (MAIL_LOCALES as readonly string[]).includes(primary)
		? (primary as MailLocale)
		: DEFAULT_MAIL_LOCALE;
}

/**
 * Pluralize `count` days for `locale` using Intl.PluralRules, choosing the
 * matching CLDR category form from the provided map. Locales without plural
 * distinction (th/ko/ja/zh) supply a single `other` form. English supplies
 * `one`/`other`; Arabic supplies the full Arabic category set.
 */
function pluralDays(
	locale: MailLocale,
	count: number,
	forms: Partial<Record<Intl.LDMLPluralRule, string>>,
): string {
	let category: Intl.LDMLPluralRule = "other";
	try {
		category = new Intl.PluralRules(locale).select(count);
	} catch {
		category = "other";
	}
	const form = forms[category] ?? forms.other ?? "";
	return form.replace("{count}", String(count));
}

// ── payment-failed ──────────────────────────────────────────────────────────

interface PaymentFailedCopy {
	subject: string;
	preheader: string;
	greeting: string;
	body: string;
	cta: string;
}

export function paymentFailedCopy(
	locale: MailLocale,
	params: { userName: string; workspaceName: string; daysUntilDowngrade: number },
): PaymentFailedCopy {
	const { userName, workspaceName, daysUntilDowngrade: days } = params;
	const within = (forms: Partial<Record<Intl.LDMLPluralRule, string>>) =>
		pluralDays(locale, days, forms);
	switch (locale) {
		case "th":
			return {
				subject: `การชำระเงินล้มเหลวสำหรับ ${workspaceName}`,
				preheader: `การชำระเงินสำหรับ ${workspaceName} ล้มเหลว`,
				greeting: `สวัสดี ${userName},`,
				body: `เราไม่สามารถดำเนินการชำระเงินสำหรับ ${workspaceName} ได้ โปรดอัปเดตการชำระเงินภายใน ${within({ other: "{count} วัน" })} เพื่อหลีกเลี่ยงการลดระดับแผน`,
				cta: "อัปเดตการชำระเงิน",
			};
		case "ko":
			return {
				subject: `${workspaceName}의 결제에 실패했습니다`,
				preheader: `${workspaceName}의 결제에 실패했습니다.`,
				greeting: `${userName}님, 안녕하세요,`,
				body: `${workspaceName}의 결제를 처리할 수 없습니다. 요금제 강등을 피하려면 ${within({ other: "{count}일" })} 이내에 결제 정보를 업데이트하세요.`,
				cta: "결제 업데이트",
			};
		case "ja":
			return {
				subject: `${workspaceName} の支払いに失敗しました`,
				preheader: `${workspaceName} の支払いに失敗しました。`,
				greeting: `${userName} 様、`,
				body: `${workspaceName} の支払いを処理できませんでした。プランのダウングレードを避けるため、${within({ other: "{count}日" })}以内に支払い情報を更新してください。`,
				cta: "支払いを更新",
			};
		case "zh":
			return {
				subject: `${workspaceName} 的付款失败`,
				preheader: `${workspaceName} 的付款失败。`,
				greeting: `${userName}，您好，`,
				body: `我们无法为 ${workspaceName} 处理付款。请在 ${within({ other: "{count} 天" })}内更新付款方式，以免套餐被降级。`,
				cta: "更新付款方式",
			};
		case "ar":
			return {
				subject: `فشل الدفع لـ ${workspaceName}`,
				preheader: `فشل الدفع لـ ${workspaceName}.`,
				greeting: `مرحبًا ${userName}،`,
				body: `تعذّر علينا معالجة الدفع لـ ${workspaceName}. حدِّث بيانات الدفع خلال ${within({
					zero: "{count} يوم",
					one: "يوم واحد",
					two: "يومين",
					few: "{count} أيام",
					many: "{count} يومًا",
					other: "{count} يوم",
				})} لتجنّب خفض الخطة.`,
				cta: "تحديث الدفع",
			};
		case "en":
		default:
			return {
				subject: `Payment failed for ${workspaceName}`,
				preheader: `Payment failed for ${workspaceName}.`,
				greeting: `Hi ${userName},`,
				body: `We could not process payment for ${workspaceName}. Update payment within ${within({ one: "{count} day", other: "{count} days" })} to avoid a plan downgrade.`,
				cta: "Update payment",
			};
	}
}

// ── plan-downgrade-warning ──────────────────────────────────────────────────

interface PlanDowngradeCopy {
	subject: string;
	preheader: string;
	title: string;
	greeting: string;
	body: string;
	textBody: string;
	textScheduled: string;
	cta: string;
}

export function planDowngradeCopy(
	locale: MailLocale,
	params: { userName: string; workspaceName: string; currentPlan: string; downgradeOn: string },
): PlanDowngradeCopy {
	const { userName, workspaceName, currentPlan, downgradeOn } = params;
	switch (locale) {
		case "th":
			return {
				subject: `${workspaceName} จะถูกลดระดับแผนเร็ว ๆ นี้`,
				preheader: `${workspaceName} จะถูกลดระดับแผนเร็ว ๆ นี้`,
				title: "คำเตือนการลดระดับแผน",
				greeting: `สวัสดี ${userName},`,
				body: `${workspaceName} กำลังใช้แผน ${currentPlan} และมีกำหนดลดระดับในวันที่ ${downgradeOn}`,
				textBody: `${workspaceName} กำลังใช้แผน ${currentPlan}`,
				textScheduled: `กำหนดลดระดับ: ${downgradeOn}`,
				cta: "กู้คืนแผน",
			};
		case "ko":
			return {
				subject: `${workspaceName}이(가) 곧 강등됩니다`,
				preheader: `${workspaceName}이(가) 곧 강등됩니다.`,
				title: "요금제 강등 경고",
				greeting: `${userName}님, 안녕하세요,`,
				body: `${workspaceName}은(는) 현재 ${currentPlan} 요금제이며 ${downgradeOn}에 강등될 예정입니다.`,
				textBody: `${workspaceName}은(는) 현재 ${currentPlan} 요금제입니다.`,
				textScheduled: `강등 예정일: ${downgradeOn}`,
				cta: "요금제 복원",
			};
		case "ja":
			return {
				subject: `${workspaceName} はまもなくダウングレードされます`,
				preheader: `${workspaceName} はまもなくダウングレードされます。`,
				title: "プランのダウングレード警告",
				greeting: `${userName} 様、`,
				body: `${workspaceName} は現在 ${currentPlan} プランで、${downgradeOn} にダウングレードが予定されています。`,
				textBody: `${workspaceName} は現在 ${currentPlan} プランです。`,
				textScheduled: `ダウングレード予定: ${downgradeOn}`,
				cta: "プランを復元",
			};
		case "zh":
			return {
				subject: `${workspaceName} 即将降级`,
				preheader: `${workspaceName} 即将降级。`,
				title: "套餐降级警告",
				greeting: `${userName}，您好，`,
				body: `${workspaceName} 当前使用 ${currentPlan} 套餐，计划于 ${downgradeOn} 降级。`,
				textBody: `${workspaceName} 当前使用 ${currentPlan} 套餐。`,
				textScheduled: `计划降级时间：${downgradeOn}`,
				cta: "恢复套餐",
			};
		case "ar":
			return {
				subject: `سيتم خفض خطة ${workspaceName} قريبًا`,
				preheader: `سيتم خفض خطة ${workspaceName} قريبًا.`,
				title: "تحذير خفض الخطة",
				greeting: `مرحبًا ${userName}،`,
				body: `يستخدم ${workspaceName} حاليًا خطة ${currentPlan} ومن المقرر خفضها في ${downgradeOn}.`,
				textBody: `يستخدم ${workspaceName} حاليًا خطة ${currentPlan}.`,
				textScheduled: `موعد الخفض المقرر: ${downgradeOn}`,
				cta: "استعادة الخطة",
			};
		case "en":
		default:
			return {
				subject: `${workspaceName} will downgrade soon`,
				preheader: `${workspaceName} will downgrade soon.`,
				title: "Plan downgrade warning",
				greeting: `Hi ${userName},`,
				body: `${workspaceName} is currently on ${currentPlan} and is scheduled to downgrade on ${downgradeOn}.`,
				textBody: `${workspaceName} is currently on ${currentPlan}.`,
				textScheduled: `Scheduled downgrade: ${downgradeOn}`,
				cta: "Restore plan",
			};
	}
}

/** Localized title for the payment-failed template (used as the H1 + text title). */
export function paymentFailedTitle(locale: MailLocale): string {
	switch (locale) {
		case "th": return "การชำระเงินล้มเหลว";
		case "ko": return "결제 실패";
		case "ja": return "支払いに失敗しました";
		case "zh": return "付款失败";
		case "ar": return "فشل الدفع";
		case "en":
		default: return "Payment failed";
	}
}
