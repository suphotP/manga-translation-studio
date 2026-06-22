import aiQuotaWarning, { type AiQuotaWarningData } from "./ai-quota-warning.js";
import billingReceipt, { type BillingReceiptData } from "./billing-receipt.js";
import notificationGeneric, { type NotificationGenericData } from "./notification-generic.js";
import passwordReset, { type PasswordResetData } from "./password-reset.js";
import paymentFailed, { type PaymentFailedData } from "./payment-failed.js";
import planDowngradeWarning, { type PlanDowngradeWarningData } from "./plan-downgrade-warning.js";
import registrationVerify, { type RegistrationVerifyData } from "./registration-verify.js";
import storageQuotaWarning, { type StorageQuotaWarningData } from "./storage-quota-warning.js";
import weeklyDigest, { type WeeklyDigestData } from "./weekly-digest.js";
import workspaceInvite, { type WorkspaceInviteData } from "./workspace-invite.js";
import type { MailUser, RenderedTemplate } from "./shared.js";

export type TransactionalTemplateName =
	| "registration-verify"
	| "password-reset"
	| "workspace-invite"
	| "billing-receipt"
	| "payment-failed"
	| "plan-downgrade-warning"
	| "storage-quota-warning"
	| "ai-quota-warning"
	| "weekly-digest"
	| "notification-generic";

export interface TransactionalTemplateDataMap {
	"registration-verify": RegistrationVerifyData;
	"password-reset": PasswordResetData;
	"workspace-invite": WorkspaceInviteData;
	"billing-receipt": BillingReceiptData;
	"payment-failed": PaymentFailedData;
	"plan-downgrade-warning": PlanDowngradeWarningData;
	"storage-quota-warning": StorageQuotaWarningData;
	"ai-quota-warning": AiQuotaWarningData;
	"weekly-digest": WeeklyDigestData;
	"notification-generic": NotificationGenericData;
}

export type TransactionalTemplateData<Name extends TransactionalTemplateName> = TransactionalTemplateDataMap[Name];

export const transactionalTemplates: {
	[Name in TransactionalTemplateName]: (data: TransactionalTemplateDataMap[Name]) => RenderedTemplate;
} = {
	"registration-verify": registrationVerify,
	"password-reset": passwordReset,
	"workspace-invite": workspaceInvite,
	"billing-receipt": billingReceipt,
	"payment-failed": paymentFailed,
	"plan-downgrade-warning": planDowngradeWarning,
	"storage-quota-warning": storageQuotaWarning,
	"ai-quota-warning": aiQuotaWarning,
	"weekly-digest": weeklyDigest,
	"notification-generic": notificationGeneric,
};

export const transactionalTemplateNames = Object.keys(transactionalTemplates) as TransactionalTemplateName[];

export function renderTransactionalTemplate<Name extends TransactionalTemplateName>(
	name: Name,
	data: TransactionalTemplateData<Name>,
): RenderedTemplate {
	return transactionalTemplates[name](data as never);
}

export function resolveTransactionalRecipient<Name extends TransactionalTemplateName>(name: Name, data: TransactionalTemplateData<Name>): string {
	const source = name === "workspace-invite"
		? (data as WorkspaceInviteData).invitee
		: (data as { user: MailUser }).user;
	return source.email;
}

export type {
	AiQuotaWarningData,
	BillingReceiptData,
	NotificationGenericData,
	PasswordResetData,
	PaymentFailedData,
	PlanDowngradeWarningData,
	RegistrationVerifyData,
	StorageQuotaWarningData,
	WeeklyDigestData,
	WorkspaceInviteData,
};
