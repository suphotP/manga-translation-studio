// P1 (tile moderation): a long webtoon page is screened as ONE downscaled
// overview, which can dilute a small unsafe region below threshold. The stored
// tile plan must actually be EXECUTED and aggregated fail-closed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { buildModerationDerivativePlan, executeModerationTilePlan } from "../services/assets.js";
import { resetModerationCacheForTests } from "../services/moderation.js";
import type { AssetModerationResult } from "../types/index.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalFailOpen = process.env.OPENAI_MODERATION_FAIL_OPEN;
const originalModEnabled = process.env.OPENAI_MODERATION_ENABLED;

beforeEach(() => {
	process.env.OPENAI_API_KEY = "sk-test";
	process.env.OPENAI_MODERATION_FAIL_OPEN = "false";
	// Clear the env override so the toggle-OFF tests below are governed by the
	// saved config (saveConfig({imageModerationEnabled:false})), not a value leaked
	// from another test file run in the same process.
	delete process.env.OPENAI_MODERATION_ENABLED;
	resetModerationCacheForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalKey;
	if (originalFailOpen === undefined) delete process.env.OPENAI_MODERATION_FAIL_OPEN;
	else process.env.OPENAI_MODERATION_FAIL_OPEN = originalFailOpen;
	if (originalModEnabled === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
	else process.env.OPENAI_MODERATION_ENABLED = originalModEnabled;
});

function mockOpenAi(scores: Record<string, number>, flagged = false): void {
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.startsWith("https://api.openai.com/v1/moderations")) return originalFetch(input, init);
		const categories = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v > 0.5]));
		return new Response(JSON.stringify({
			id: "modr-test",
			model: "omni-moderation-latest",
			results: [{ flagged, categories, category_scores: scores, category_applied_input_types: {} }],
		}), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

// A tall webtoon-shaped page whose plan contains tiles (scaledHeight > tileHeight*1.5).
async function tallPage(width = 1024, height = 6000): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
}

const passedOverview: AssetModerationResult = {
	status: "passed",
	provider: "openai_omni",
	checkedAt: "2026-06-05T00:00:00.000Z",
	reason: "overview clean",
};

describe("executeModerationTilePlan", () => {
	test("the plan for a tall page contains moderation tiles", () => {
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		const tiles = plan.filter((d) => d.purpose === "moderation_tile");
		expect(tiles.length).toBeGreaterThan(0);
	});

	test("a CSAM-flagged tile escalates a passed overview to BLOCKED (no region unscreened)", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		mockOpenAi({ "sexual/minors": 0.9, sexual: 0.3 }, true);

		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile" });

		expect(result.status).toBe("blocked");
	});

	test("a warning tile escalates a passed overview to needs_review", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		mockOpenAi({ violence: 0.4, "violence/graphic": 0.9 }, true);

		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile" });

		expect(result.status).toBe("needs_review");
	});

	test("clean tiles keep the passed overview verdict", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		mockOpenAi({ violence: 0.01, sexual: 0.01 }, false);

		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile" });

		expect(result.status).toBe("passed");
	});

	// FIX #1 (codex re-review): with the soft moderation toggle OFF, every tile
	// region must STILL be screened by the mandatory CSAM screen. A CSAM-positive
	// tile on a tall webtoon page must hard-block even though soft policy is off.
	// The toggle is driven via the OPENAI_MODERATION_ENABLED env override (honored by
	// imageModerationEnabled()) to avoid disk/config coupling across the suite.
	test("toggle-OFF: a CSAM tile still BLOCKS via the mandatory screen", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		mockOpenAi({ "sexual/minors": 0.9, sexual: 0.3 }, true);
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile-off" });
		expect(result.status).toBe("blocked");
	});

	// FIX #2 (codex re-review): with the soft toggle OFF and the provider THROWING,
	// every tile fails closed to needs_review — NEVER passed — even with FAIL_OPEN.
	test("toggle-OFF + FAIL_OPEN + provider error: tiles fail closed to needs_review", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		process.env.OPENAI_MODERATION_ENABLED = "false";
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true";
		globalThis.fetch = (async () => { throw new Error("provider outage"); }) as typeof fetch;
		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile-failopen" });
		expect(result.status).toBe("needs_review");
		expect(result.status).not.toBe("passed");
	});

	test("a short page (no tiles) returns the overview unchanged without provider calls", async () => {
		const plan = buildModerationDerivativePlan({ width: 1024, height: 800 });
		let calls = 0;
		mockOpenAi({ "sexual/minors": 0.9 }, true);
		const wrapped = globalThis.fetch;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { calls++; return wrapped(...args); }) as typeof fetch;

		const buffer = await sharp({ create: { width: 1024, height: 800, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
		const result = await executeModerationTilePlan(buffer, "image/png", plan, passedOverview, { workspaceId: "ws-tile" });

		expect(result.status).toBe("passed");
		expect(calls).toBe(0);
	});

	test("an already-blocked overview short-circuits (terminal)", async () => {
		const buffer = await tallPage();
		const plan = buildModerationDerivativePlan({ width: 1024, height: 6000 });
		let calls = 0;
		mockOpenAi({ violence: 0.01 }, false);
		const wrapped = globalThis.fetch;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { calls++; return wrapped(...args); }) as typeof fetch;

		const blockedOverview: AssetModerationResult = { ...passedOverview, status: "blocked", reason: "overview blocked" };
		const result = await executeModerationTilePlan(buffer, "image/png", plan, blockedOverview, { workspaceId: "ws-tile" });

		expect(result.status).toBe("blocked");
		expect(calls).toBe(0);
	});
});
