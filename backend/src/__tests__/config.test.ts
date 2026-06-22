// Tests for config module

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

describe("Config", () => {
	test("loadConfig returns valid config with required fields", async () => {
		const { loadConfig } = await import("../config.js");
		const config = loadConfig();
		expect(config).toHaveProperty("openrouterEnabled");
		expect(config).toHaveProperty("openrouterApiKey");
		expect(config).toHaveProperty("openaiImagesEnabled");
		expect(config).toHaveProperty("openaiImageModel");
		expect(config).toHaveProperty("openaiImageDefaultQuality");
		expect(config).toHaveProperty("chatgptEnabled");
		expect(config).toHaveProperty("primaryBackend");
		expect(["chatgpt", "openrouter"]).toContain(config.primaryBackend);
	});

	test("loadConfig has correct defaults", async () => {
		const { loadConfig } = await import("../config.js");
		const config = loadConfig();
		// These are the expected defaults for a fresh install
		expect(typeof config.openrouterEnabled).toBe("boolean");
		expect(typeof config.openaiImagesEnabled).toBe("boolean");
		expect(config.openaiImageModel).toBe("gpt-image-1");
		expect(["low", "medium", "high"]).toContain(config.openaiImageDefaultQuality);
		expect(typeof config.chatgptEnabled).toBe("boolean");
	});

	test("OPENAI_IMAGE_MODEL validation: real model passes, bogus model fails fast, empty uses default", async () => {
		const { resolveOpenAiImageModel } = await import("../config.js");
		const { OPENAI_IMAGE_MODELS, DEFAULT_OPENAI_IMAGE_MODEL } =
			await import("../services/ai-providers/openai-models.js");

		// The real OpenAI image model (the `.env` value) must validate cleanly.
		expect(resolveOpenAiImageModel("gpt-image-1")).toBe("gpt-image-1");
		expect(resolveOpenAiImageModel("  gpt-image-1  ")).toBe("gpt-image-1");
		expect(OPENAI_IMAGE_MODELS).toContain("gpt-image-1");
		expect(DEFAULT_OPENAI_IMAGE_MODEL).toBe("gpt-image-1");

		// Empty/unset falls back to the supported default rather than throwing.
		expect(resolveOpenAiImageModel(undefined)).toBe("gpt-image-1");
		expect(resolveOpenAiImageModel("")).toBe("gpt-image-1");
		expect(resolveOpenAiImageModel("   ")).toBe("gpt-image-1");

		// A bogus/unsupported id (including the old fake `gpt-image-2`) fails fast
		// with a clear error naming the supported set.
		expect(() => resolveOpenAiImageModel("gpt-image-2")).toThrow(/not a supported OpenAI image model/);
		expect(() => resolveOpenAiImageModel("gpt-image-2")).toThrow(/gpt-image-1/);
		expect(() => resolveOpenAiImageModel("totally-made-up")).toThrow(/not a supported OpenAI image model/);
	});

	test("loadConfig reads config files written with a UTF-8 BOM", async () => {
		const { DATA_DIR, loadConfig } = await import("../config.js");
		const configPath = join(DATA_DIR, "config.json");
		const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

		try {
			writeFileSync(configPath, `\uFEFF${JSON.stringify({
				openrouterEnabled: true,
				primaryBackend: "openrouter",
			})}`);

			const config = loadConfig();
			expect(config.openrouterEnabled).toBe(true);
			expect(config.primaryBackend).toBe("openrouter");
			expect(config.chatgptEnabled).toBe(true);
		} finally {
			if (originalConfig === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfig);
			}
		}
	});

	test("serverConfig has valid port", async () => {
		const { serverConfig } = await import("../config.js");
		expect(serverConfig.port).toBeGreaterThan(0);
		expect(serverConfig.port).toBeLessThanOrEqual(65535);
		expect(typeof serverConfig.host).toBe("string");
		expect(serverConfig.maxUploadSize).toBeGreaterThan(0);
		expect(serverConfig.maxImagesPerUpload).toBeGreaterThan(0);
		expect(serverConfig.maxUploadBatchSizeBytes).toBeGreaterThan(0);
		expect(serverConfig.minUploadImageWidth).toBeGreaterThan(0);
		expect(serverConfig.minUploadImageHeight).toBeGreaterThan(0);
		expect(typeof serverConfig.projectCatalogFileFallbackEnabled).toBe("boolean");
		expect(typeof serverConfig.aiQueueProcessorEnabled).toBe("boolean");
		expect(serverConfig.aiQueueProcessorPollIntervalMs).toBeGreaterThan(0);
		expect(typeof serverConfig.aiRequireAssetRegistryForAi).toBe("boolean");
	});

	test("production API hardening defaults fail closed unless explicitly disabled", async () => {
		const { defaultApiHardeningEnabled, defaultProjectCatalogFileFallbackEnabled, defaultProxyHeaderTrustEnabled, readBooleanConfigValue, shouldRequireJwtSecret } = await import("../config.js");

		expect(defaultApiHardeningEnabled("production")).toBe(true);
		expect(defaultApiHardeningEnabled("development")).toBe(false);
		expect(defaultApiHardeningEnabled("test")).toBe(false);
		expect(defaultProjectCatalogFileFallbackEnabled("production")).toBe(false);
		expect(defaultProjectCatalogFileFallbackEnabled("development")).toBe(true);
		expect(defaultProjectCatalogFileFallbackEnabled("test")).toBe(true);
		expect(defaultProxyHeaderTrustEnabled(false)).toBe(false);
		expect(defaultProxyHeaderTrustEnabled(true)).toBe(true);
		expect(shouldRequireJwtSecret("production", "api")).toBe(true);
		expect(shouldRequireJwtSecret("production", "queue-worker")).toBe(true);
		expect(shouldRequireJwtSecret("production", "ai-queue-worker")).toBe(true);
		expect(shouldRequireJwtSecret("development", "api")).toBe(false);

		expect(readBooleanConfigValue(undefined, true)).toBe(true);
		expect(readBooleanConfigValue("", true)).toBe(true);
		expect(readBooleanConfigValue("false", true)).toBe(false);
		expect(readBooleanConfigValue("0", true)).toBe(false);
		expect(readBooleanConfigValue("true", false)).toBe(true);
		expect(readBooleanConfigValue("on", false)).toBe(true);
	});

	test("production provider secrets fail closed when selected providers require them", async () => {
		const { validateProductionRequiredSecrets } = await import("../config.js");

		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			BILLING_PROVIDER: "dodo",
		})).toThrow("DODO_API_KEY");
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			MAILER_PROVIDER: "resend",
		})).toThrow("RESEND_API_KEY");
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			STORAGE_DRIVER: "r2",
			R2_BUCKET: "bucket",
			R2_ACCESS_KEY_ID: "access",
			R2_SECRET_ACCESS_KEY: "secret",
		})).toThrow("R2_ENDPOINT or R2_ACCOUNT_ID");
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			ALLOWED_ORIGINS: "https://app.example.com",
			BILLING_PROVIDER: "dodo",
			DODO_API_KEY: "dodo-key",
			MAILER_PROVIDER: "resend",
			RESEND_API_KEY: "resend-key",
			STORAGE_DRIVER: "r2",
			R2_BUCKET: "bucket",
			R2_ENDPOINT: "https://r2.example.com",
			R2_ACCESS_KEY_ID: "access",
			R2_SECRET_ACCESS_KEY: "secret",
		})).not.toThrow();
	});

	test("production requires an explicit non-wildcard ALLOWED_ORIGINS", async () => {
		const { validateProductionRequiredSecrets } = await import("../config.js");

		// Unset in production → fail closed.
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
		})).toThrow("ALLOWED_ORIGINS");

		// A bare wildcard is rejected (would re-open the cross-origin surface).
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			ALLOWED_ORIGINS: "*",
		})).toThrow("ALLOWED_ORIGINS");

		// Explicit origin list is accepted.
		expect(() => validateProductionRequiredSecrets({
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
			ALLOWED_ORIGINS: "https://app.example.com,https://example.com",
		})).not.toThrow();

		// Outside production the requirement does not apply.
		expect(() => validateProductionRequiredSecrets({ NODE_ENV: "development" })).not.toThrow();
	});

	test("resolveAllowedOrigins never falls back to wildcard in production", async () => {
		const { resolveAllowedOrigins } = await import("../config.js");

		// Dev: unset → wildcard is fine.
		expect(resolveAllowedOrigins(undefined, "development")).toBe("*");
		expect(resolveAllowedOrigins("", "development")).toBe("*");
		// Production: unset → fail closed to an empty allow-list (no "*").
		expect(resolveAllowedOrigins(undefined, "production")).toBe("");
		expect(resolveAllowedOrigins("  ", "production")).toBe("");
		// Explicit value is always honored verbatim.
		expect(resolveAllowedOrigins("https://app.example.com", "production")).toBe("https://app.example.com");
		expect(resolveAllowedOrigins("https://app.example.com", "development")).toBe("https://app.example.com");
	});

	test("positive integer config parsing falls back instead of failing open", async () => {
		const { readPositiveIntegerConfigValue } = await import("../config.js");

		expect(readPositiveIntegerConfigValue("256", 1)).toBe(256);
		expect(readPositiveIntegerConfigValue(" 512 ", 1)).toBe(512);
		expect(readPositiveIntegerConfigValue(undefined, 7)).toBe(7);
		expect(readPositiveIntegerConfigValue("", 7)).toBe(7);
		expect(readPositiveIntegerConfigValue("0", 7)).toBe(7);
		expect(readPositiveIntegerConfigValue("-1", 7)).toBe(7);
		expect(readPositiveIntegerConfigValue("abc", 7)).toBe(7);
		expect(readPositiveIntegerConfigValue("1.5", 7)).toBe(7);
	});

	test("non-negative integer config parsing honors 0 but still rejects negatives/junk", async () => {
		const { readNonNegativeIntegerConfigValue } = await import("../config.js");

		// 0 is a LEGITIMATE value here (unlike the positive reader): "no AI" caps.
		expect(readNonNegativeIntegerConfigValue("0", 7)).toBe(0);
		expect(readNonNegativeIntegerConfigValue(" 0 ", 7)).toBe(0);
		expect(readNonNegativeIntegerConfigValue("256", 1)).toBe(256);
		expect(readNonNegativeIntegerConfigValue(" 512 ", 1)).toBe(512);
		// Empty/unset still falls back to the default (an operator who set nothing).
		expect(readNonNegativeIntegerConfigValue(undefined, 7)).toBe(7);
		expect(readNonNegativeIntegerConfigValue("", 7)).toBe(7);
		expect(readNonNegativeIntegerConfigValue("   ", 7)).toBe(7);
		// Negatives / non-integers / junk are rejected → safe default.
		expect(readNonNegativeIntegerConfigValue("-1", 7)).toBe(7);
		expect(readNonNegativeIntegerConfigValue("1.5", 7)).toBe(7);
		expect(readNonNegativeIntegerConfigValue("abc", 7)).toBe(7);
	});

	test("database-backed stores default to Postgres only outside tests", async () => {
		const { defaultDatabaseStoreMode } = await import("../config.js");

		expect(defaultDatabaseStoreMode("postgres://user:pass@localhost:5432/app", false)).toBe("postgres");
		expect(defaultDatabaseStoreMode("postgres://user:pass@localhost:5432/app", true)).toBe("file");
		expect(defaultDatabaseStoreMode("", false)).toBe("file");
		expect(defaultDatabaseStoreMode(undefined, false)).toBe("file");
	});

	test("asset registry stays file-backed unless ASSET_REGISTRY_STORE=postgres is set explicitly", async () => {
		const { defaultAssetRegistryStoreMode } = await import("../config.js");

		// Critically, it does NOT auto-switch on DATABASE_URL presence: migration
		// 0021 does not backfill existing assets.json, so auto-selecting Postgres
		// would hide every pre-existing upload until new uploads land.
		expect(defaultAssetRegistryStoreMode(undefined)).toBe("file");
		expect(defaultAssetRegistryStoreMode("")).toBe("file");
		expect(defaultAssetRegistryStoreMode("file")).toBe("file");
		// Only an explicit postgres opt-in selects Postgres.
		expect(defaultAssetRegistryStoreMode("postgres")).toBe("postgres");
		expect(defaultAssetRegistryStoreMode("  PostgreS  ")).toBe("postgres");
		// Unknown values fall back to file rather than failing open.
		expect(defaultAssetRegistryStoreMode("sqlite")).toBe("file");
	});

	// ── AI support guardrails config surface (rank1) ──────────────────────────

	test("AI support agent provider validates against official providers and fails fast on a bogus id", async () => {
		const { resolveSupportAgentProvider } = await import("../config.js");
		expect(resolveSupportAgentProvider(undefined)).toBe("openai");
		expect(resolveSupportAgentProvider("")).toBe("openai");
		expect(resolveSupportAgentProvider("openai")).toBe("openai");
		expect(resolveSupportAgentProvider("openrouter")).toBe("openrouter");
		expect(resolveSupportAgentProvider("  OpenAI  ")).toBe("openai");
		expect(() => resolveSupportAgentProvider("anthropic")).toThrow(/not a supported provider/);
		expect(() => resolveSupportAgentProvider("python-worker")).toThrow(/not a supported provider/);
	});

	test("SUPPORT_AGENT_MODEL validation: real model passes, bogus model fails fast like OPENAI_IMAGE_MODEL", async () => {
		const { resolveSupportAgentModel } = await import("../config.js");
		// The default gpt-5.5 is a supported OpenAI text model.
		expect(resolveSupportAgentModel("openai", undefined)).toBe("gpt-5.5");
		expect(resolveSupportAgentModel("openai", "")).toBe("gpt-5.5");
		expect(resolveSupportAgentModel("openai", "gpt-5.4")).toBe("gpt-5.4");
		expect(resolveSupportAgentModel("openai", "gpt-5.4-mini")).toBe("gpt-5.4-mini");
		// An image model or a typo is rejected (it is not a text model).
		expect(() => resolveSupportAgentModel("openai", "gpt-image-1")).toThrow(/not a supported/);
		expect(() => resolveSupportAgentModel("openai", "gpt-9000")).toThrow(/not a supported/);
		// OpenRouter has its own text allow-list.
		expect(resolveSupportAgentModel("openrouter", "openai/gpt-5.5")).toBe("openai/gpt-5.5");
		expect(() => resolveSupportAgentModel("openrouter", "gpt-5.5")).toThrow(/not a supported/);
	});

	test("AI support kill-switch is inverted, defaults ON, and a typo fails closed (disabled)", async () => {
		const { readAiSupportEnabled } = await import("../config.js");
		// Default ON when unset/blank.
		expect(readAiSupportEnabled(undefined)).toBe(true);
		expect(readAiSupportEnabled("")).toBe(true);
		// Kill-switch truthy → agent DISABLED (inverted).
		expect(readAiSupportEnabled("true")).toBe(false);
		expect(readAiSupportEnabled("1")).toBe(false);
		expect(readAiSupportEnabled("on")).toBe(false);
		// Explicit off → agent enabled.
		expect(readAiSupportEnabled("false")).toBe(true);
		expect(readAiSupportEnabled("0")).toBe(true);
		// A typo when the operator clearly tried to flip the switch fails CLOSED.
		expect(readAiSupportEnabled("tru")).toBe(false);
		expect(readAiSupportEnabled("flase")).toBe(false);
	});

	test("AI support kill-switch flips at runtime via the persisted config (admin toggle path)", async () => {
		const { DATA_DIR, loadConfig } = await import("../config.js");
		const configPath = join(DATA_DIR, "config.json");
		const originalConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
		const previousEnv = process.env.AI_SUPPORT_KILL_SWITCH;
		try {
			// No env override → persisted value wins (this is how /api/ai/admin/config
			// flips the agent off at runtime, exactly like providerKillSwitches).
			delete process.env.AI_SUPPORT_KILL_SWITCH;
			writeFileSync(configPath, JSON.stringify({ aiSupportEnabled: false }));
			expect(loadConfig().aiSupportEnabled).toBe(false);

			writeFileSync(configPath, JSON.stringify({ aiSupportEnabled: true }));
			expect(loadConfig().aiSupportEnabled).toBe(true);

			// Env override wins over a stale persisted value (cannot silently re-enable).
			process.env.AI_SUPPORT_KILL_SWITCH = "true"; // kill-switch ON → disabled
			expect(loadConfig().aiSupportEnabled).toBe(false);
		} finally {
			if (previousEnv === undefined) delete process.env.AI_SUPPORT_KILL_SWITCH;
			else process.env.AI_SUPPORT_KILL_SWITCH = previousEnv;
			if (originalConfig === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfig);
			}
		}
	});

	test("TICKET_AI_* guardrails config has safe defaults and is fully env-tunable", async () => {
		const { readTicketAiGuardrailsConfig } = await import("../config.js");
		const defaults = readTicketAiGuardrailsConfig({} as NodeJS.ProcessEnv);
		expect(defaults.msgPerMinute).toBe(4);
		expect(defaults.msgPerHour).toBe(30);
		expect(defaults.tokenUnitsPerMinute).toBe(120);
		expect(defaults.maxMessages).toBe(12);
		expect(defaults.maxTokens).toBe(40000);
		expect(defaults.monthlyBudgetThb).toBe(5000);
		expect(defaults.requireVerifiedEmail).toBe(true);
		expect(defaults.disposableEmailDomains).toContain("mailinator.com");

		const tuned = readTicketAiGuardrailsConfig({
			TICKET_AI_MSG_PER_MINUTE: "9",
			TICKET_AI_MAX_TOKENS: "1000",
			TICKET_AI_MONTHLY_BUDGET_THB: "0",
			TICKET_AI_REQUIRE_VERIFIED_EMAIL: "false",
			TICKET_AI_DISPOSABLE_EMAIL_DOMAINS: "evil.test, spam.example",
		} as unknown as NodeJS.ProcessEnv);
		expect(tuned.msgPerMinute).toBe(9);
		expect(tuned.maxTokens).toBe(1000);
		expect(tuned.monthlyBudgetThb).toBe(0); // 0 is a legit hard-stop budget.
		expect(tuned.requireVerifiedEmail).toBe(false);
		expect(tuned.disposableEmailDomains).toContain("evil.test");
		expect(tuned.disposableEmailDomains).toContain("spam.example");
		// Seed domains are still merged in.
		expect(tuned.disposableEmailDomains).toContain("mailinator.com");
	});

	test("BUG 2 (P2): malformed TICKET_AI_REQUIRE_VERIFIED_EMAIL fails CLOSED (gate stays ON)", async () => {
		const { readTicketAiGuardrailsConfig } = await import("../config.js");
		// A typo or garbage value must NOT silently disable a security/anti-abuse gate
		// whose safe state is ON. Only an explicit false-y token turns it off; anything
		// unparseable resolves to the SAFE value (require verified = true). The old
		// readBooleanConfigValue("treu", true) returned false — a fail-open hole.
		for (const malformed of ["treu", "garbage", "tru", "yess", "enabled", "maybe", "2"]) {
			const cfg = readTicketAiGuardrailsConfig({
				TICKET_AI_REQUIRE_VERIFIED_EMAIL: malformed,
			} as unknown as NodeJS.ProcessEnv);
			expect(cfg.requireVerifiedEmail).toBe(true);
		}
		// Explicit false-y tokens DO disable it (operator opt-out is honored).
		for (const off of ["false", "0", "no", "off", "FALSE", " Off "]) {
			const cfg = readTicketAiGuardrailsConfig({
				TICKET_AI_REQUIRE_VERIFIED_EMAIL: off,
			} as unknown as NodeJS.ProcessEnv);
			expect(cfg.requireVerifiedEmail).toBe(false);
		}
		// Explicit truthy tokens keep it ON; unset uses the safe default ON.
		for (const on of ["true", "1", "yes", "on", "TRUE"]) {
			const cfg = readTicketAiGuardrailsConfig({
				TICKET_AI_REQUIRE_VERIFIED_EMAIL: on,
			} as unknown as NodeJS.ProcessEnv);
			expect(cfg.requireVerifiedEmail).toBe(true);
		}
		expect(readTicketAiGuardrailsConfig({} as NodeJS.ProcessEnv).requireVerifiedEmail).toBe(true);
	});

	test("readSecurityBooleanConfigValue fails closed on malformed input, honors explicit toggles", async () => {
		const { readSecurityBooleanConfigValue } = await import("../config.js");
		// Safe-default ON flags: malformed/unset → ON; only explicit false-y → off.
		expect(readSecurityBooleanConfigValue(undefined, true)).toBe(true);
		expect(readSecurityBooleanConfigValue("", true)).toBe(true);
		expect(readSecurityBooleanConfigValue("treu", true)).toBe(true);
		expect(readSecurityBooleanConfigValue("garbage", true)).toBe(true);
		expect(readSecurityBooleanConfigValue("false", true)).toBe(false);
		expect(readSecurityBooleanConfigValue("off", true)).toBe(false);
		expect(readSecurityBooleanConfigValue("true", true)).toBe(true);
		// Safe-default OFF flags: malformed/unset → OFF; only explicit truthy → on.
		expect(readSecurityBooleanConfigValue("garbage", false)).toBe(false);
		expect(readSecurityBooleanConfigValue("true", false)).toBe(true);
	});

	test("TICKET_AI_MAX_MESSAGES=0 / TICKET_AI_MAX_TOKENS=0 mean 'no AI' (honored, not silently defaulted)", async () => {
		const { readTicketAiGuardrailsConfig } = await import("../config.js");
		// BUG 2 (P1): a per-ticket cap of 0 is a real hard-stop and MUST survive config
		// load (previously the positive-integer reader rejected 0 → fell back to 12 / 40000,
		// so an operator who set 0 still got 12 AI replies).
		const noAi = readTicketAiGuardrailsConfig({
			TICKET_AI_MAX_MESSAGES: "0",
			TICKET_AI_MAX_TOKENS: "0",
		} as unknown as NodeJS.ProcessEnv);
		expect(noAi.maxMessages).toBe(0);
		expect(noAi.maxTokens).toBe(0);

		// Negatives / junk are still rejected → safe defaults (never fail open to a
		// huge cap, never crash).
		const bad = readTicketAiGuardrailsConfig({
			TICKET_AI_MAX_MESSAGES: "-1",
			TICKET_AI_MAX_TOKENS: "nope",
		} as unknown as NodeJS.ProcessEnv);
		expect(bad.maxMessages).toBe(12);
		expect(bad.maxTokens).toBe(40000);
	});

	test("TICKET_AI_THB_PER_TOKEN parses a positive rate, rejects 0/negatives, defaults when unset", async () => {
		const { readTicketAiThbPerTokenEnv } = await import("../config.js");
		expect(readTicketAiThbPerTokenEnv("0.01")).toBe(0.01);
		expect(readTicketAiThbPerTokenEnv("  0.5  ")).toBe(0.5);
		// Default rate when unset/blank.
		expect(readTicketAiThbPerTokenEnv(undefined)).toBe(0.001);
		expect(readTicketAiThbPerTokenEnv("")).toBe(0.001);
		// A non-positive / junk rate falls back (a 0 rate would mean free spend).
		expect(readTicketAiThbPerTokenEnv("0")).toBe(0.001);
		expect(readTicketAiThbPerTokenEnv("-1")).toBe(0.001);
		expect(readTicketAiThbPerTokenEnv("abc")).toBe(0.001);
	});
});
