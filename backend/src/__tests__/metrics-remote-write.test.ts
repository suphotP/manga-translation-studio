// Tests for the hosted-metrics remote_write config reader (Wave 4 W4.4).
//
// QA gates: env-driven (no hardcoded secrets), fails loudly on a half-wired
// target, never logs/echoes the token (describeMetricsRemoteWriteConfig is
// token-free).

import { describe, expect, test } from "bun:test";
import {
	describeMetricsRemoteWriteConfig,
	readMetricsRemoteWriteConfig,
} from "../config.js";
import { resolveSentryRelease } from "../middleware/sentry.js";

describe("readMetricsRemoteWriteConfig", () => {
	test("disabled when no URL is set", () => {
		const config = readMetricsRemoteWriteConfig({});
		expect(config.enabled).toBe(false);
		expect(config.url).toBe("");
		expect(config.token).toBe("");
		expect(config.username).toBe("");
	});

	test("enabled with a Grafana-Cloud-style basic-auth target", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "https://prometheus-prod.grafana.net/api/prom/push",
			METRICS_REMOTE_WRITE_USERNAME: "123456",
			METRICS_REMOTE_WRITE_TOKEN: "glc_secrettoken",
		});
		expect(config.enabled).toBe(true);
		expect(config.url).toBe("https://prometheus-prod.grafana.net/api/prom/push");
		expect(config.username).toBe("123456");
		expect(config.token).toBe("glc_secrettoken");
	});

	test("enabled with a Better-Stack-style bearer target (no username)", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "https://in.betterstack.com/metrics",
			METRICS_REMOTE_WRITE_TOKEN: "bs_sourcetoken",
		});
		expect(config.enabled).toBe(true);
		expect(config.username).toBe("");
		expect(describeMetricsRemoteWriteConfig(config).auth).toBe("bearer");
	});

	test("trims surrounding whitespace from env values", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "  https://example.com/push  ",
			METRICS_REMOTE_WRITE_TOKEN: "  tok  ",
		});
		expect(config.url).toBe("https://example.com/push");
		expect(config.token).toBe("tok");
	});

	test("throws when a token is set without a URL (half-wired)", () => {
		expect(() =>
			readMetricsRemoteWriteConfig({ METRICS_REMOTE_WRITE_TOKEN: "tok" }),
		).toThrow(/without METRICS_REMOTE_WRITE_URL/);
	});

	test("throws when a username is set without a URL (half-wired)", () => {
		expect(() =>
			readMetricsRemoteWriteConfig({ METRICS_REMOTE_WRITE_USERNAME: "123" }),
		).toThrow(/without METRICS_REMOTE_WRITE_URL/);
	});

	test("rejects a non-URL value", () => {
		expect(() =>
			readMetricsRemoteWriteConfig({ METRICS_REMOTE_WRITE_URL: "not a url" }),
		).toThrow(/absolute https URL/);
	});

	test("rejects plaintext http to a remote host (would leak the token)", () => {
		expect(() =>
			readMetricsRemoteWriteConfig({
				METRICS_REMOTE_WRITE_URL: "http://prometheus-prod.grafana.net/api/prom/push",
				METRICS_REMOTE_WRITE_TOKEN: "tok",
			}),
		).toThrow(/must use https/);
	});

	test("allows http only for a localhost test proxy", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "http://localhost:9090/api/v1/write",
		});
		expect(config.enabled).toBe(true);
	});

	test("rejects credentials embedded in the URL (would leak via the summary)", () => {
		expect(() =>
			readMetricsRemoteWriteConfig({
				METRICS_REMOTE_WRITE_URL: "https://user:token@prometheus-prod.grafana.net/api/prom/push",
			}),
		).toThrow(/must not embed credentials/);
		// password-only userinfo is rejected too.
		expect(() =>
			readMetricsRemoteWriteConfig({
				METRICS_REMOTE_WRITE_URL: "https://:secret@host.example/push",
			}),
		).toThrow(/must not embed credentials/);
	});
});

describe("describeMetricsRemoteWriteConfig", () => {
	test("never includes the token value", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "https://example.com/push",
			METRICS_REMOTE_WRITE_USERNAME: "123",
			METRICS_REMOTE_WRITE_TOKEN: "super-secret-token",
		});
		const described = describeMetricsRemoteWriteConfig(config);
		expect(JSON.stringify(described)).not.toContain("super-secret-token");
		expect(described).toEqual({
			enabled: true,
			url: "https://example.com/push",
			auth: "basic",
		});
	});

	test("reports auth=none when only a URL is set", () => {
		const config = readMetricsRemoteWriteConfig({
			METRICS_REMOTE_WRITE_URL: "https://example.com/push",
		});
		expect(describeMetricsRemoteWriteConfig(config).auth).toBe("none");
	});
});

describe("resolveSentryRelease", () => {
	test("prefers an explicit override over everything", () => {
		expect(
			resolveSentryRelease("override-sha", { SENTRY_RELEASE: "env-rel", GIT_SHA: "git-sha" }),
		).toBe("override-sha");
	});

	test("prefers SENTRY_RELEASE over GIT_SHA", () => {
		expect(
			resolveSentryRelease(undefined, { SENTRY_RELEASE: "env-rel", GIT_SHA: "git-sha" }),
		).toBe("env-rel");
	});

	test("falls back to GIT_SHA when SENTRY_RELEASE is unset", () => {
		expect(resolveSentryRelease(undefined, { GIT_SHA: "git-sha" })).toBe("git-sha");
	});

	test("falls back to npm_package_version, then the sentinel", () => {
		expect(resolveSentryRelease(undefined, { npm_package_version: "9.9.9" })).toBe("9.9.9");
		expect(resolveSentryRelease(undefined, {})).toBe("0.1.0");
	});

	test("ignores blank/whitespace-only values", () => {
		expect(
			resolveSentryRelease("   ", { SENTRY_RELEASE: "  ", GIT_SHA: "real-sha" }),
		).toBe("real-sha");
	});
});
