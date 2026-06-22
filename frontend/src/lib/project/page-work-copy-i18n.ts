// UI-side resolvers for the page-work-copy helper codes.
//
// `page-work-copy.ts` is framework-agnostic and returns STABLE CODES (a
// `PageWorkLabel` discriminated union, or a plain code string). These thin
// resolvers turn a code into a localized string via the svelte-i18n formatter,
// so every consumer shares one mapping instead of re-implementing it. Pass the
// component's reactive `$_` formatter as `t`.

import {
	pageStatusCopy,
	pageNextActionCopy,
	pageAssetLabelCopy,
	pageAssetSignalCopy,
	pageAssetRecoveryTitle,
	pageAssetRecoveryAction,
	type PageWorkLabel,
} from "$lib/project/page-work-copy.js";
import type { PageWorkPrimarySignal } from "$lib/project/page-work-summary.js";
import { resolveQcIssueMessage } from "$lib/project/qc-checks-i18n.js";
import type { PageAssetIntegrity, PageAssetIntegrityStatus } from "$lib/project/page-assets.js";

// The svelte-i18n message formatter shape we actually use here. Mirrors
// svelte-i18n's `MessageFormatter`: the interpolation `values` are scalars
// (string/number/boolean/Date), not arbitrary `unknown`.
type InterpolationValue = string | number | boolean | Date | null | undefined;
type Translate = (key: string, options?: { values?: Record<string, InterpolationValue> }) => string;

function resolveLabel(label: PageWorkLabel | null, t: Translate, ns: string, fallback: string): string {
	if (!label) return fallback;
	return "code" in label ? t(`${ns}.${label.code}`) : label.text;
}

/** Localized status pill text, with a caller-supplied fallback for the empty value. */
export function resolvePageStatusText(value: string | null | undefined, t: Translate, fallback: string): string {
	return resolveLabel(pageStatusCopy(value), t, "pageWork.status", fallback);
}

/** Localized next-action text, with a caller-supplied fallback for the empty value. */
export function resolvePageNextActionText(value: string | null | undefined, t: Translate, fallback: string): string {
	return resolveLabel(pageNextActionCopy(value), t, "pageWork.nextAction", fallback);
}

/** Localized asset label, defaulting to the generic "image status" copy. */
export function resolvePageAssetLabelText(asset: Pick<PageAssetIntegrity, "label"> | null | undefined, t: Translate): string {
	return resolveLabel(pageAssetLabelCopy(asset), t, "pageWork.asset", t("pageWork.assetDefaultLabel"));
}

/** Localized asset signal copy (falls back through the asset label dictionary). */
export function resolvePageAssetSignalText(status: PageAssetIntegrityStatus, label: string, t: Translate): string {
	return resolveLabel(pageAssetSignalCopy(status, label), t, "pageWork.assetSignal", t("pageWork.assetDefaultLabel"));
}

/** Localized asset-recovery card title. */
export function resolvePageAssetRecoveryTitle(asset: Pick<PageAssetIntegrity, "status" | "issueKind">, t: Translate): string {
	return t(`pageWork.recoveryTitle.${pageAssetRecoveryTitle(asset)}`);
}

/** Localized asset-recovery card action hint. */
export function resolvePageAssetRecoveryAction(asset: Pick<PageAssetIntegrity, "status" | "issueKind">, t: Translate): string {
	return t(`pageWork.recoveryAction.${pageAssetRecoveryAction(asset)}`);
}

/**
 * Localized primary-signal headline. The signal now carries a stable `labelCode`
 * (+ optional `labelValues` counts) instead of a pre-built Thai string, so this
 * resolves it via `$_("pageSignal.<labelCode>", { values })`.
 */
export function resolvePageSignalLabel(
	signal: Pick<PageWorkPrimarySignal, "labelCode" | "labelValues">,
	t: Translate,
): string {
	return t(`pageSignal.${signal.labelCode}`, { values: signal.labelValues });
}

/**
 * The localized primary-signal DETAIL line. When the signal's detail is a QC
 * issue (`detailQc` present) it is localized via `resolveQcIssueMessage`;
 * otherwise the raw free-text `detail` (comment body / task title / marker label /
 * asset detail) passes through unchanged. Replaces consumers reading the
 * formerly-Thai `signal.detail` straight from a QC message.
 */
export function resolvePageSignalDetail(
	signal: Pick<PageWorkPrimarySignal, "detail" | "detailQc">,
	t: Translate,
): string {
	if (signal.detailQc) return resolveQcIssueMessage(signal.detailQc, t);
	return signal.detail;
}
