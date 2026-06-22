// Guards the generic `apiError.*` localization fallback in client.ts.
//
// Before this, only codes with an explicit `case` in formatApiErrorMessage's
// switch were localized; every other coded error rendered the backend's raw
// English. The generic default-branch fallback now localizes ANY backend code
// that has a matching `apiError.<camelCode>` catalog key — without a bespoke
// case — while still falling back to the raw backend message for unknown codes.

import { describe, it, expect, beforeEach } from "vitest";

import { formatApiErrorMessage, snakeToCamelCode } from "../api/client.js";
import en from "../i18n/locales/en.json";
import th from "../i18n/locales/th.json";

function setLocale(locale: string): void {
	window.localStorage.setItem("manga-editor-locale", locale);
}

describe("snakeToCamelCode", () => {
	it("maps snake_case backend codes to camelCase catalog keys", () => {
		expect(snakeToCamelCode("project_not_found")).toBe("projectNotFound");
		expect(snakeToCamelCode("ai_job_not_cancellable")).toBe("aiJobNotCancellable");
		expect(snakeToCamelCode("oauth_pkce_missing")).toBe("oauthPkceMissing");
	});

	it("passes single-word and already-camel codes through unchanged", () => {
		expect(snakeToCamelCode("forbidden")).toBe("forbidden");
		expect(snakeToCamelCode("")).toBe("");
	});
});

describe("formatApiErrorMessage generic localization", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("localizes a coded error that has only a catalog key (no explicit case) — en", () => {
		setLocale("en");
		const msg = formatApiErrorMessage({ status: 404, code: "project_not_found", error: "Project not found" });
		expect(msg).toBe(en.apiError.projectNotFound);
	});

	it("localizes the same code in the active locale — th", () => {
		setLocale("th");
		const msg = formatApiErrorMessage({ status: 404, code: "project_not_found", error: "Project not found" });
		expect(msg).toBe(th.apiError.projectNotFound);
	});

	it("falls back to the raw backend English for an unknown/uncoded error (nothing swallowed)", () => {
		setLocale("en");
		const raw = "Some brand new server error";
		expect(formatApiErrorMessage({ status: 400, code: "totally_unknown_code_xyz", error: raw })).toBe(raw);
		expect(formatApiErrorMessage({ status: 400, error: raw })).toBe(raw);
	});

	it("follows the browser locale (not the Thai default) when no locale is persisted", () => {
		// beforeEach already cleared localStorage — no explicit choice. jsdom's
		// navigator.language is en-US, so the formatter must resolve to en, matching
		// what i18n/index.ts shows the app, rather than defaulting to Thai.
		const msg = formatApiErrorMessage({ status: 404, code: "project_not_found", error: "Project not found" });
		expect(msg).toBe(en.apiError.projectNotFound);
		expect(msg).not.toBe(th.apiError.projectNotFound);
	});

	it("does not regress explicit-case codes (switch arm wins over generic fallback)", () => {
		setLocale("en");
		const msg = formatApiErrorMessage({ status: 401, code: "invalid_credentials", error: "bad" });
		expect(msg).toBe(en.apiError.invalidCredentials);
	});

	it("localizes the 428 missing-baseline rejection via the generic catalog key — en", () => {
		setLocale("en");
		// Backend /save 428 with code project_baseline_required (missing
		// x-project-base-fingerprint under the prod gate). snakeToCamelCode maps it to
		// apiError.projectBaselineRequired, so no explicit case arm is needed.
		expect(snakeToCamelCode("project_baseline_required")).toBe("projectBaselineRequired");
		const msg = formatApiErrorMessage({
			status: 428,
			code: "project_baseline_required",
			error: "Missing concurrency baseline header (x-project-base-fingerprint)",
		});
		expect(msg).toBe(en.apiError.projectBaselineRequired);
		// The raw English backend string must NOT leak through.
		expect(msg).not.toContain("x-project-base-fingerprint");
	});

	it("localizes the 428 missing-baseline rejection in the active locale — th", () => {
		setLocale("th");
		const msg = formatApiErrorMessage({
			status: 428,
			code: "project_baseline_required",
			error: "Missing concurrency baseline header (x-project-base-fingerprint)",
		});
		expect(msg).toBe(th.apiError.projectBaselineRequired);
		expect(msg).not.toBe(en.apiError.projectBaselineRequired);
	});

	it("forwards scalar body fields so simple {token} keys can interpolate", () => {
		setLocale("en");
		// `unauthorized` has no token, but the path must not throw when body carries fields.
		const msg = formatApiErrorMessage({
			status: 401,
			code: "unauthorized",
			error: "Unauthorized",
			body: { error: "Unauthorized", code: "unauthorized", extra: 7 },
		});
		expect(msg).toBe(en.apiError.unauthorized);
	});
});
