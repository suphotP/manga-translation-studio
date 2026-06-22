// Frontend mirror of the backend password policy (backend/src/services/auth.service.ts
// `validatePassword` + backend/src/config.ts defaults). Keeping this in sync lets the
// signup/reset forms explain *which* rule failed before submit, instead of letting the
// user hit a generic "registration failed" after a 400 from the server.
//
// The backend enables all four character-class rules unless explicitly opted out via
// PASSWORD_REQUIRE_* env vars, and defaults the minimum length to 8. The frontend has no
// access to the backend env, so we encode the default policy here.

/** Default minimum length — mirrors backend `passwordMinLength` (PASSWORD_MIN_LENGTH || 8). */
export const PASSWORD_MIN_LENGTH = 8;

/** Default maximum length — mirrors backend `PASSWORD_MAX_LENGTH || 128`. */
export const PASSWORD_MAX_LENGTH = 128;

/** Same special-character class the backend `validatePassword` accepts. */
const SPECIAL_CHAR_RE = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;

/** Stable rule id — the localized label lives in the UI layer (`passwordPolicy.rule_<id>`). */
export type PasswordRuleId = "length" | "maxlength" | "uppercase" | "lowercase" | "number" | "special";

export interface PasswordRule {
	/** Stable id; consumers map it to a localized label via `passwordPolicy.rule_<id>`. */
	id: PasswordRuleId;
	/** Whether the current password satisfies this rule. */
	ok: boolean;
}

export interface PasswordPolicyResult {
	valid: boolean;
	/** Echoed back so the `length` rule label can interpolate the exact minimum. */
	minLength: number;
	/** Echoed back so the `maxlength` rule label can interpolate the exact maximum. */
	maxLength: number;
	rules: PasswordRule[];
	/** Id of the first unmet rule (for an inline form error), or null when valid. */
	firstUnmetRuleId: PasswordRuleId | null;
}

/**
 * Evaluate a password against the (default) backend policy.
 *
 * Locale-neutral by design: this is a framework-agnostic module that cannot call the
 * i18n store, so it returns stable rule IDs (not Thai labels). The UI layer maps each
 * id to a localized string via the `passwordPolicy.*` catalog — mirroring the backend's
 * "return a code, the frontend localizes" contract.
 *
 * @param password the candidate password
 * @param minLength override the minimum length (defaults to backend default)
 * @param maxLength override the maximum length (defaults to backend default)
 */
export function evaluatePassword(password: string, minLength: number = PASSWORD_MIN_LENGTH, maxLength: number = PASSWORD_MAX_LENGTH): PasswordPolicyResult {
	const rules: PasswordRule[] = [
		{ id: "length", ok: password.length >= minLength },
		{ id: "maxlength", ok: password.length <= maxLength },
		{ id: "uppercase", ok: /[A-Z]/.test(password) },
		{ id: "lowercase", ok: /[a-z]/.test(password) },
		{ id: "number", ok: /\d/.test(password) },
		{ id: "special", ok: SPECIAL_CHAR_RE.test(password) },
	];
	const firstUnmet = rules.find((r) => !r.ok);
	return {
		valid: rules.every((r) => r.ok),
		minLength,
		maxLength,
		rules,
		firstUnmetRuleId: firstUnmet ? firstUnmet.id : null,
	};
}
