import type { CreditPolicy, ExportProfileId, ExportRun } from "$lib/types.js";
import { _ } from "$lib/i18n";
import { get } from "svelte/store";

export type ExportGateHoldReason = "required credit missing";

export interface ExportProfileCopy {
	id: ExportProfileId;
	shortLabel: string;
	policyLabel: string;
	statusLabel: string;
}

interface LocalizedCopy {
	key: string;
	fallback: string;
}

interface ExportProfileCopyDefinition {
	id: ExportProfileId;
	shortLabel: LocalizedCopy;
	policyLabel: LocalizedCopy;
	statusLabel: LocalizedCopy;
}

function interpolateFallback(fallback: string, values?: Record<string, string | number>): string {
	if (!values) return fallback;
	return Object.entries(values).reduce(
		(text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
		fallback,
	);
}

function t(key: string, fallback: string, values?: Record<string, string | number>): string {
	try {
		const translate = get(_);
		const value = translate(key, values ? { values } : undefined);
		if (value && value !== key) return value;
	} catch {
		// Locale may be unavailable in isolated unit tests; fall back below.
	}
	return interpolateFallback(fallback, values);
}

function createExportProfileCopy(definition: ExportProfileCopyDefinition): ExportProfileCopy {
	return {
		id: definition.id,
		get shortLabel() {
			return t(definition.shortLabel.key, definition.shortLabel.fallback);
		},
		get policyLabel() {
			return t(definition.policyLabel.key, definition.policyLabel.fallback);
		},
		get statusLabel() {
			return t(definition.statusLabel.key, definition.statusLabel.fallback);
		},
	};
}

const DRAFT_INTERNAL_EXPORT_PROFILE_DEFINITION: ExportProfileCopyDefinition = {
	id: "draft-internal",
	shortLabel: { key: "exportProfiles.draftInternal.shortLabel", fallback: "ร่าง/ภายใน" },
	policyLabel: { key: "exportProfiles.draftInternal.policyLabel", fallback: "ร่าง/ภายใน ไม่บังคับ" },
	statusLabel: { key: "exportProfiles.draftInternal.statusLabel", fallback: "ร่าง/ภายใน ไม่บังคับ" },
};

const PUBLIC_EXPORT_PROFILE_DEFINITION: ExportProfileCopyDefinition = {
	id: "public-export",
	shortLabel: { key: "exportProfiles.publicExport.shortLabel", fallback: "เผยแพร่/ส่งออก" },
	policyLabel: { key: "exportProfiles.publicExport.policyLabel", fallback: "เผยแพร่/ส่งออก ต้องมี" },
	statusLabel: { key: "exportProfiles.publicExport.statusLabel", fallback: "ส่งออกต้องมีเครดิต" },
};

export const DRAFT_INTERNAL_EXPORT_PROFILE: ExportProfileCopy = createExportProfileCopy(
	DRAFT_INTERNAL_EXPORT_PROFILE_DEFINITION,
);
export const PUBLIC_EXPORT_PROFILE: ExportProfileCopy = createExportProfileCopy(
	PUBLIC_EXPORT_PROFILE_DEFINITION,
);

export function exportProfileForCreditPolicy(policy: CreditPolicy | undefined): ExportProfileCopy {
	return policy === "required" ? PUBLIC_EXPORT_PROFILE : DRAFT_INTERNAL_EXPORT_PROFILE;
}

export function normalizeExportProfileId(value: unknown): ExportProfileId | undefined {
	return value === DRAFT_INTERNAL_EXPORT_PROFILE.id || value === PUBLIC_EXPORT_PROFILE.id
		? value
		: undefined;
}

export function exportProfileLabel(profileId: ExportProfileId | undefined): string {
	if (profileId === DRAFT_INTERNAL_EXPORT_PROFILE.id) return DRAFT_INTERNAL_EXPORT_PROFILE.shortLabel;
	if (profileId === PUBLIC_EXPORT_PROFILE.id) return PUBLIC_EXPORT_PROFILE.shortLabel;
	return "";
}

export function exportRunTargetProfileLabel(run: Pick<ExportRun, "targetProfile">): string {
	return exportProfileLabel(run.targetProfile);
}

export function exportTargetLabelForCreditPolicy(policy: CreditPolicy | undefined): string {
	return exportProfileForCreditPolicy(policy).shortLabel;
}

export function exportPolicyControlLabel(policy: CreditPolicy): string {
	return exportProfileForCreditPolicy(policy).policyLabel;
}

export function exportCreditSummaryPolicyLabel(policy: CreditPolicy | undefined): string {
	return exportProfileForCreditPolicy(policy).statusLabel;
}

export function exportCreditPolicyStatusMessage(policy: CreditPolicy): string {
	return policy === "required"
		? t(
			"exportProfiles.status.required",
			"ตั้งเครดิตเป็นเงื่อนไขสำหรับ {profile} แล้ว",
			{ profile: PUBLIC_EXPORT_PROFILE.shortLabel },
		)
		: t(
			"exportProfiles.status.optional",
			"ตั้งเครดิตเป็น {profile} ไม่บล็อกการส่งกลับแล้ว",
			{ profile: DRAFT_INTERNAL_EXPORT_PROFILE.shortLabel },
		);
}

export function requiredCreditMissingHoldReason(): ExportGateHoldReason {
	return "required credit missing";
}

export function requiredCreditMissingMessage(): string {
	return t(
		"exportProfiles.requiredCredit.missingMessage",
		"ส่งออกยังไม่พร้อม: {profile} ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้",
		{ profile: PUBLIC_EXPORT_PROFILE.shortLabel },
	);
}

export function requiredCreditGateDetail(): string {
	return t(
		"exportProfiles.requiredCredit.gateDetail",
		"{draftProfile} ยังตรวจหน้าได้ต่อ แต่เป้าส่งออก {publicProfile} ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้",
		{
			draftProfile: DRAFT_INTERNAL_EXPORT_PROFILE.shortLabel,
			publicProfile: PUBLIC_EXPORT_PROFILE.shortLabel,
		},
	);
}

export function workboardCreditPolicyDetail(policy: CreditPolicy | undefined, chapterCreditCount: number): string {
	if (policy === "required" && chapterCreditCount === 0) {
		return t(
			"exportProfiles.workboard.requiredMissing",
			"เป้าส่งออก {profile}: ต้องเพิ่มเครดิตอย่างน้อย 1 รายการก่อนส่งกลับโปรเจกต์หลัก",
			{ profile: PUBLIC_EXPORT_PROFILE.shortLabel },
		);
	}
	if (policy === "required") {
		return t(
			"exportProfiles.workboard.requiredReady",
			"เป้าส่งออก {profile} มีเครดิตแล้ว ส่งกลับโปรเจกต์หลักได้",
			{ profile: PUBLIC_EXPORT_PROFILE.shortLabel },
		);
	}
	return t(
		"exportProfiles.workboard.optional",
		"เป้าส่งออก {profile}: ไม่มีเครดิตก็ไม่บล็อกส่งกลับ แต่ QC ยังเปิดเครื่องมือเครดิตได้",
		{ profile: DRAFT_INTERNAL_EXPORT_PROFILE.shortLabel },
	);
}

export function batchExportActionTargetLabel(policy: CreditPolicy | undefined): string {
	return policy === "required"
		? PUBLIC_EXPORT_PROFILE.shortLabel
		: t("exportProfiles.batchExportZip", "ส่งออก ZIP");
}

export function exportRetryActionLabel(run: ExportRun): string {
	return run.kind === "batch-zip"
		? t("exportProfiles.retryZip", "ทำ ZIP ใหม่")
		: t("exportProfiles.retryPng", "ทำ PNG ใหม่");
}
