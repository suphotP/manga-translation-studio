// Frontend configuration — environment-aware, no hardcoded values
// All values can be overridden via environment variables at build time

interface AppConfig {
	/** Backend API base URL (proxied through Vite in dev) */
	apiBase: string;
	/**
	 * Whether the self-service account-recovery flows (forgot/reset password +
	 * email verification) are exposed in the UI. The backend routes
	 * (`/auth/forgot-password`, `/reset-password`, `/verify-email`,
	 * `/resend-verification`) now exist (PR #76), so this defaults to `true`.
	 * It stays a kill-switch: set VITE_AUTH_RECOVERY=false to hide the self-serve
	 * recovery UI (e.g. while triaging an email-delivery incident).
	 */
	authRecoveryEnabled: boolean;
	/**
	 * Cloudflare Turnstile site key (public). When non-empty, the auth forms render a
	 * Turnstile challenge and gate submit on a token; when empty (the default), no
	 * widget renders and submit is NOT gated — so leaving it unset is a clean
	 * Turnstile-off mode with no behaviour change. Build-time inlined (VITE_*).
	 */
	turnstileSiteKey: string;
	/** Supported languages for translation */
	languages: Record<string, string>;
	/** Default target language */
	defaultLang: string;
	/** Maximum file upload size in MB */
	maxUploadSizeMB: number;
	/** AI job polling interval in ms */
	aiPollIntervalMs: number;
	/** Minimum crop selection size in px */
	minCropSize: number;
	/** Default text for new text layers */
	defaultText: string;
	/** Default font family for text layers */
	defaultFontFamily: string;
	/** Default font size for new text layers */
	defaultFontSize: number;
	/** Canvas configuration */
	canvas: {
		maxWidth: number;
		defaultAspectRatios: Record<string, [number, number] | null>;
		minZoom: number;
		maxZoom: number;
	};
	/**
	 * Version stamp for the legal / cookie consent copy. Bumping this re-prompts
	 * everyone for fresh consent. Read from build-time env so legal/ops can roll
	 * a new policy version without touching code.
	 */
	consentPolicyVersion: string;
}

export const config: AppConfig = {
	apiBase: import.meta.env.VITE_API_BASE || "/api",
	authRecoveryEnabled: import.meta.env.VITE_AUTH_RECOVERY !== "false",
	turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "",
	languages: {
		th: "Thai",
		en: "English",
		ko: "Korean",
		ja: "Japanese",
		zh: "Chinese",
		es: "Spanish",
		fr: "French",
		pt: "Portuguese",
		de: "German",
	},
	defaultLang: "th",
	maxUploadSizeMB: 50,
	aiPollIntervalMs: 2000,
	minCropSize: 10,
	defaultText: "ข้อความ",
	defaultFontFamily: "Tahoma, sans-serif",
	defaultFontSize: 24,
	canvas: {
		maxWidth: 1024,
		defaultAspectRatios: {
			"Fit Width": null,
			"1:1 Square": [1, 1],
			"2:3 Tall": [2, 3],
			"3:2 Wide": [3, 2],
			"4:3": [4, 3],
			"3:4": [3, 4],
			"16:9 Wide": [16, 9],
			"9:16 Tall": [9, 16],
		},
		minZoom: 0.1,
		maxZoom: 20,
	},
	consentPolicyVersion: import.meta.env.VITE_CONSENT_POLICY_VERSION || "2026-06-01",
};
