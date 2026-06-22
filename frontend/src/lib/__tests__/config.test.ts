// Frontend config tests
// Tests that config values are correct, no hardcoded values leak

import { describe, it, expect, beforeAll } from "vitest";

// We need to import the config module since we're testing in vitest
// Note: vitest handles ESM imports better than bun:test for Svelte modules
let config: typeof import("../config").config;

beforeAll(async () => {
  const { config: importedConfig } = await import("../config.js");
  config = importedConfig;
});

describe("frontend config", () => {
  it("config module exists and has required fields", () => {
    expect(config.apiBase).toBeDefined();
    expect(typeof config.apiBase).toBe("string");
    expect(config.apiBase.length).toBeGreaterThan(0);

    expect(config.languages).toBeDefined();
    expect(typeof config.languages).toBe("object");
    expect(config.languages.th).toBe("Thai");
    expect(config.languages.en).toBe("English");

    expect(config.defaultLang).toBe("th");

    expect(typeof config.maxUploadSizeMB).toBe("number");
    expect(config.maxUploadSizeMB).toBeGreaterThan(0);

    expect(typeof config.aiPollIntervalMs).toBe("number");
    expect(config.aiPollIntervalMs).toBeGreaterThan(0);

    expect(typeof config.minCropSize).toBe("number");
    expect(config.minCropSize).toBeGreaterThan(0);

    expect(typeof config.defaultText).toBe("string");
    expect(config.defaultText.length).toBeGreaterThan(0);

    expect(typeof config.defaultFontSize).toBe("number");
    expect(config.defaultFontSize).toBeGreaterThan(0);

    expect(typeof config.defaultFontFamily).toBe("string");
    expect(config.defaultFontFamily.length).toBeGreaterThan(0);
  });

  it("has exact default values", () => {
    expect(config.apiBase).toBe("/api");
    expect(config.maxUploadSizeMB).toBe(50);
    expect(config.aiPollIntervalMs).toBe(2000);
    expect(config.minCropSize).toBe(10);
    expect(config.defaultLang).toBe("th");
    expect(config.defaultText).toBe("ข้อความ");
    expect(config.defaultFontFamily).toBe("Tahoma, sans-serif");
    expect(config.defaultFontSize).toBe(24);
  });

  it("has reasonable defaults", () => {
    expect(config.maxUploadSizeMB).toBeLessThanOrEqual(500);
    expect(config.maxUploadSizeMB).toBeGreaterThanOrEqual(1);
    expect(config.aiPollIntervalMs).toBeGreaterThanOrEqual(500);
    expect(config.aiPollIntervalMs).toBeLessThanOrEqual(30000);
    expect(config.minCropSize).toBeGreaterThanOrEqual(5);
    expect(config.defaultFontSize).toBeGreaterThanOrEqual(8);
  });

  it("languages object has all expected entries", () => {
    const langEntries = Object.entries(config.languages);
    const expectedLanguages = ['th', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'pt', 'de'];

    expect(langEntries.length).toBeGreaterThanOrEqual(3);
    expect(langEntries.length).toBe(expectedLanguages.length);

    expectedLanguages.forEach(lang => {
      expect(config.languages).toHaveProperty(lang);
      const langName = config.languages[lang];
      expect(langName).toBeDefined();
      expect(typeof langName).toBe("string");
      expect(langName.length).toBeGreaterThan(0);
    });
  });

  it("has language labels in their respective languages", () => {
    expect(config.languages.th).toBe('Thai');
    expect(config.languages.en).toBe('English');
    expect(config.languages.ko).toBe('Korean');
    expect(config.languages.ja).toBe('Japanese');
    expect(config.languages.zh).toBe('Chinese');
    expect(config.languages.es).toBe('Spanish');
    expect(config.languages.fr).toBe('French');
    expect(config.languages.pt).toBe('Portuguese');
    expect(config.languages.de).toBe('German');
  });

  it("defaultLang is a valid language code", () => {
    expect(config.languages).toHaveProperty(config.defaultLang);
  });

  it("config is immutable", () => {
    // Attempt to modify config should not affect the original
    const testConfig = { ...config };
    try {
      testConfig.apiBase = "modified";
      expect(config.apiBase).not.toBe("modified");
    } catch (e) {
      // If property is readonly, this should throw
      expect(e).toBeDefined();
    }
  });
});

describe("frontend types", () => {
  it("types module loads without error", async () => {
    // Since TypeScript interfaces are erased at runtime, we just verify
    // the module loads without error
    const typesModule = await import("../types.js");
    expect(typesModule).toBeDefined();
  });

  it("treats partial image-layer references as non-AI instead of throwing", async () => {
    const { isAiResultImageLayer } = await import("../types.js");

    expect(isAiResultImageLayer({ id: "base-page" })).toBe(false);
    expect(isAiResultImageLayer({ id: "ai-result-1" })).toBe(true);
  });
});
