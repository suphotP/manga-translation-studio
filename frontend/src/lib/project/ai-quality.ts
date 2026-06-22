// AI image quality — single source of truth for the editor quality selector.
//
// Mirrors the backend `AiImageQuality` enum (backend/src/types/index.ts) and the
// `QUALITY_CREDIT_UNITS` map (backend/src/services/cost-estimator.ts: Low=1 /
// Medium=9 / High=36, cost-proportional, SIZE-FLAT). The op cost a normal user
// sees is always in CREDITS (never baht) — these credit units feed the
// CreditAmount atom in the AI panel. Plan gating reads `allowedAiQualities`
// from the workspace plan (free = ["low"], studio = all three), surfaced via
// the /ai/capabilities response.

export type AiImageQuality = "low" | "medium" | "high";

export const AI_IMAGE_QUALITIES: readonly AiImageQuality[] = ["low", "medium", "high"];

/**
 * Credit cost per AI op for each quality. Must stay in lockstep with the backend
 * `QUALITY_CREDIT_UNITS` constant — the backend is the charging authority; this
 * map only lets the panel show the price before the user generates.
 */
export const QUALITY_CREDIT_UNITS: Record<AiImageQuality, number> = {
	low: 1,
	medium: 9,
	high: 36,
};

export interface AiQualityOption {
	id: AiImageQuality;
	/** Thai short label shown on the segmented control. */
	label: string;
	/** English label shown under the Thai one (the user asked for ต่ำ/กลาง/สูง). */
	subLabel: string;
	/** One-line description of the trade-off. */
	detail: string;
	/** Credit cost of one op at this quality. */
	creditUnits: number;
}

export const AI_QUALITY_OPTIONS: readonly AiQualityOption[] = [
	{ id: "low", label: "ต่ำ", subLabel: "Low", detail: "เร็ว ประหยัดเครดิตที่สุด", creditUnits: QUALITY_CREDIT_UNITS.low },
	{ id: "medium", label: "กลาง", subLabel: "Medium", detail: "สมดุลคุณภาพกับเครดิต", creditUnits: QUALITY_CREDIT_UNITS.medium },
	{ id: "high", label: "สูง", subLabel: "High", detail: "คมที่สุด ใช้เครดิตมากสุด", creditUnits: QUALITY_CREDIT_UNITS.high },
];

export const DEFAULT_AI_QUALITY: AiImageQuality = "medium";

/** Credit units for an op at the given quality. */
export function qualityCreditUnits(quality: AiImageQuality): number {
	return QUALITY_CREDIT_UNITS[quality];
}

/** Whether the workspace plan permits this quality. Undefined list = allow all (no plan scope yet). */
export function isQualityAllowed(quality: AiImageQuality, allowed: readonly AiImageQuality[] | undefined): boolean {
	if (!allowed || allowed.length === 0) return true;
	return allowed.includes(quality);
}

/**
 * Pick a usable quality given the plan's allowed set, preferring `preferred`
 * (usually the user's last/default choice), then the configured default, then
 * the highest allowed. Returns "low" as a final floor so the control always has
 * a valid selection.
 */
export function resolveUsableQuality(
	preferred: AiImageQuality,
	allowed: readonly AiImageQuality[] | undefined,
): AiImageQuality {
	if (isQualityAllowed(preferred, allowed)) return preferred;
	if (isQualityAllowed(DEFAULT_AI_QUALITY, allowed)) return DEFAULT_AI_QUALITY;
	// Fall back to the highest allowed quality (most capable the plan permits).
	for (const option of [...AI_QUALITY_OPTIONS].reverse()) {
		if (isQualityAllowed(option.id, allowed)) return option.id;
	}
	return "low";
}
