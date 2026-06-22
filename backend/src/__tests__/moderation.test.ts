import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	createLocalImageModerationPass,
	moderateImage,
	moderateMultimodal,
	moderatePrompt,
	moderatePromptLocal,
	moderationResultIsConfirmedBlock,
	PostgresCsamBlockAuditStore,
	resetModerationCacheForTests,
	setCsamAuditStoreForTests,
	setModerationBillingStoreForTests,
	setModerationCacheForTests,
	toAssetModerationResult,
	type ModerationAuditRecord,
	type CsamBlockAuditStore,
} from "../services/moderation.js";
import type { ModerationResult } from "../services/moderation.js";
import type { AdminWorkspaceAccountPage, BillingStore, ResolvedWorkspacePlan, WorkspaceAddonGrant, WorkspaceBillingAssignment } from "../services/billing-store.js";

const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalFailOpen = process.env.OPENAI_MODERATION_FAIL_OPEN;
const originalRuleset = process.env.OPENAI_MODERATION_RULESET_VERSION;
const originalThresholds = process.env.OPENAI_MODERATION_THRESHOLDS_JSON;

class MemoryCsamAuditStore implements CsamBlockAuditStore {
	records: ModerationAuditRecord[] = [];

	async append(record: ModerationAuditRecord): Promise<void> {
		this.records.push(record);
	}

	async hasBlockedSha256(sha256: string): Promise<boolean> {
		const target = sha256.trim();
		if (!target) return false;
		return this.records.some((record) => record.sha256?.trim() === target);
	}
}

class FakeBillingStore implements BillingStore {
	constructor(
		private readonly planId: ResolvedWorkspacePlan["planId"] = "free",
		private readonly grants: WorkspaceAddonGrant[] = [],
	) {}

	async setWorkspacePlan(): Promise<WorkspaceBillingAssignment> {
		throw new Error("not used");
	}

	async getWorkspaceAssignment(): Promise<WorkspaceBillingAssignment | null> {
		return null;
	}

	async resolveWorkspacePlan(workspaceId: string): Promise<ResolvedWorkspacePlan> {
		return {
			workspaceId,
			planId: this.planId,
			status: "mock_active",
			assigned: true,
		};
	}

	async listAssignments(): Promise<WorkspaceBillingAssignment[]> {
		return [];
	}

	async listWorkspaceAccounts(): Promise<AdminWorkspaceAccountPage> {
		return { workspaces: [], nextCursor: undefined, total: 0 };
	}

	async listActiveGrants(): Promise<WorkspaceAddonGrant[]> {
		return this.grants;
	}
}

beforeEach(() => {
	process.env.OPENAI_API_KEY = "sk-test";
	process.env.OPENAI_MODERATION_FAIL_OPEN = "false";
	process.env.OPENAI_MODERATION_RULESET_VERSION = "test";
	delete process.env.OPENAI_MODERATION_THRESHOLDS_JSON;
	// Clear the env toggle override so config-driven toggle-OFF tests are not
	// defeated by a value leaked from another test file in the same process.
	delete process.env.OPENAI_MODERATION_ENABLED;
	resetModerationCacheForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenAiKey;
	if (originalFailOpen === undefined) delete process.env.OPENAI_MODERATION_FAIL_OPEN;
	else process.env.OPENAI_MODERATION_FAIL_OPEN = originalFailOpen;
	if (originalRuleset === undefined) delete process.env.OPENAI_MODERATION_RULESET_VERSION;
	else process.env.OPENAI_MODERATION_RULESET_VERSION = originalRuleset;
	if (originalThresholds === undefined) delete process.env.OPENAI_MODERATION_THRESHOLDS_JSON;
	else process.env.OPENAI_MODERATION_THRESHOLDS_JSON = originalThresholds;
	setModerationBillingStoreForTests(new FakeBillingStore())();
	resetModerationCacheForTests();
});

describe("moderation baseline", () => {
	test("passes normal localization prompts locally", () => {
		const result = moderatePromptLocal("Translate this manga panel into Thai and keep the layout.");
		expect(result.status).toBe("passed");
		expect(result.provider).toBe("local-development-rules");
	});

	test("blocks empty prompts locally", () => {
		const result = moderatePromptLocal("   ");
		expect(result.status).toBe("blocked");
	});

	test("marks risky prompts for review locally", () => {
		const result = moderatePromptLocal("remove watermark and make this explicit");
		expect(result.status).toBe("needs_review");
	});

	test("creates local image moderation pass records", () => {
		const result = createLocalImageModerationPass();
		expect(result.status).toBe("passed");
		expect(result.checkedAt).toBeTruthy();
	});
});

describe("OpenAI omni moderation gate", () => {
	test("clean shonen panel returns allow", async () => {
		mockOpenAiModeration({ violence: 0.04, "violence/graphic": 0.02, sexual: 0.01 });

		const result = await moderateImage("https://r2.example/panel.jpg", "ws-clean");

		expect(result.decision).toBe("allow");
		expect(result.provider).toBe("openai_omni");
		expect(result.cached).toBe(false);
	});

	test("flagged shonen violence returns warn instead of hard block", async () => {
		mockOpenAiModeration({ violence: 0.4, "violence/graphic": 0.7 }, { flagged: true });

		const result = await moderateImage("https://r2.example/shonen-fight.jpg", "ws-warn");

		expect(result.decision).toBe("warn");
		expect(result.reason).toBe("violence/graphic");
	});

	test("sexual minors text threshold returns block", async () => {
		mockOpenAiModeration({ "sexual/minors": 0.4, sexual: 0.1 });

		const result = await moderatePrompt("Panel text from a school scene", "ws-block");

		expect(result.decision).toBe("block");
		expect(result.status).toBe("block");
		expect(result.reason).toBe("sexual/minors");
	});

	test("CSAM score returns csam_block and writes audit row", async () => {
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.2 });
		try {
			const result = await moderateMultimodal({ imageUrl: "https://r2.example/bad.jpg" }, "ws-csam", {
				assetId: "asset-1",
				sha256: "sha",
				ipAddress: "127.0.0.1",
				userAgent: "test",
			});

			expect(result.decision).toBe("block");
			expect(result.status).toBe("csam_block");
			expect(audit.records).toHaveLength(1);
			expect(audit.records[0]).toMatchObject({
				assetId: "asset-1",
				sha256: "sha",
				workspaceId: "ws-csam",
			});
		} finally {
			restoreAudit();
		}
	});

	test("cached CSAM verdicts still write audit rows for each request", async () => {
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		let fetchCalls = 0;
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.2 }, { onFetch: () => fetchCalls++ });
		try {
			await moderateMultimodal({ imageUrl: "https://r2.example/repeat-bad.jpg" }, "ws-csam-repeat", {
				assetId: "asset-first",
				sha256: "sha-first",
				ipAddress: "127.0.0.1",
				userAgent: "first",
			});
			const second = await moderateMultimodal({ imageUrl: "https://r2.example/repeat-bad.jpg" }, "ws-csam-repeat", {
				assetId: "asset-second",
				sha256: "sha-second",
				ipAddress: "127.0.0.2",
				userAgent: "second",
			});

			expect(second.cached).toBe(true);
			expect(fetchCalls).toBe(1);
			expect(audit.records).toHaveLength(2);
			expect(audit.records[1]).toMatchObject({
				assetId: "asset-second",
				sha256: "sha-second",
				ipAddress: "127.0.0.2",
				userAgent: "second",
				workspaceId: "ws-csam-repeat",
			});
		} finally {
			restoreAudit();
		}
	});

	test("cache outages degrade to provider call instead of failing the moderation request", async () => {
		// Regression (codex): a transient cache outage must NOT make the cache a hard
		// dependency. A throwing get() degrades to a miss (provider still runs) and a
		// throwing set() is swallowed (verdict still returned).
		let getCalls = 0;
		let setCalls = 0;
		const restoreCache = setModerationCacheForTests({
			async get(): Promise<ModerationResult | undefined> {
				getCalls++;
				throw new Error("redis get unavailable");
			},
			async set(): Promise<void> {
				setCalls++;
				throw new Error("redis set unavailable");
			},
		});
		let fetchCalls = 0;
		mockOpenAiModeration({ violence: 0.04, sexual: 0.01 }, { onFetch: () => fetchCalls++ });
		try {
			const result = await moderateImage("https://r2.example/cache-outage.jpg", "ws-cache-outage");
			expect(result.decision).toBe("allow");
			expect(result.provider).toBe("openai_omni");
			// Provider was still consulted despite the cache being down on both get+set.
			expect(getCalls).toBe(1);
			expect(setCalls).toBe(1);
			expect(fetchCalls).toBe(1);
		} finally {
			restoreCache();
		}
	});

	test("CSAM audit store persists durable postgres rows", async () => {
		const queries: Array<{ query: string; params?: unknown[] }> = [];
		const store = new PostgresCsamBlockAuditStore({
			unsafe: async (query, params) => {
				queries.push({ query, params });
				return [];
			},
		});

		await store.append({
			assetId: "asset-2",
			sha256: "sha-2",
			scores: { "sexual/minors": 0.92 },
			blockedAt: "2026-06-02T00:00:00.000Z",
			ipAddress: "203.0.113.7",
			userAgent: "test-agent",
			workspaceId: "ws-audit",
			reason: "sexual/minors",
		});

		expect(queries).toHaveLength(1);
		expect(queries[0].query).toContain("INSERT INTO csam_blocks");
		expect(queries[0].params).toEqual([
			"asset-2",
			"sha-2",
			JSON.stringify({ "sexual/minors": 0.92, reason: "sexual/minors" }),
			"2026-06-02T00:00:00.000Z",
			"203.0.113.7",
			"test-agent",
			"ws-audit",
		]);
	});

	test("image sexual score is conservatively CSAM-blocked with explicit audit warning", async () => {
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		mockOpenAiModeration({ sexual: 0.72, "sexual/minors": 0.01 });
		try {
			const result = await moderateMultimodal({ imageUrl: "https://r2.example/sexual-image.jpg" }, "ws-image-csam", {
				assetId: "asset-image",
				sha256: "sha-image",
			});

			expect(result.decision).toBe("block");
			expect(result.status).toBe("csam_block");
			expect(result.reason).toContain("conservative CSAM safety threshold");
			expect(result.scores["csam_image_conservative_block"]).toBe(1);
			expect(result.scores["csam_image_minor_presence_unconfirmed"]).toBe(1);
			expect(audit.records).toHaveLength(1);
			expect(audit.records[0].scores["csam_image_minor_presence_unconfirmed"]).toBe(1);
		} finally {
			restoreAudit();
		}
	});

	test("BYO Studio bypasses normal flagged policy but not CSAM", async () => {
		const restoreBilling = setModerationBillingStoreForTests(new FakeBillingStore("studio", [{
			grantId: "grant-1",
			workspaceId: "ws-byo",
			addonId: "byo-openai-api",
			quantity: 1,
			aiCredits: 0,
			storageBytes: 0,
			seats: 0,
			teamJobs: 0,
			status: "active",
			source: "test",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}]));
		try {
			mockOpenAiModeration({ violence: 0.95 }, { flagged: true });
			const soft = await moderateImage("https://r2.example/flagged.jpg", "ws-byo");
			expect(soft.decision).toBe("allow");
			expect(soft.bypassed).toBe(true);

			resetModerationCacheForTests();
			mockOpenAiModeration({ "sexual/minors": 0.8 }, { flagged: true });
			const csam = await moderateImage("https://r2.example/csam.jpg", "ws-byo");
			expect(csam.decision).toBe("block");
			expect(csam.status).toBe("csam_block");
		} finally {
			restoreBilling();
		}
	});

	test("local prompt warnings still run OpenAI CSAM moderation", async () => {
		let fetchCalls = 0;
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.1 }, { onFetch: () => fetchCalls++ });

		const result = await moderatePrompt("make this school scene explicit", "ws-local-warn-csam");

		expect(fetchCalls).toBe(1);
		expect(result.decision).toBe("block");
		expect(result.status).toBe("csam_block");
	});

	test("local prompt warnings remain needs_review when OpenAI allows", async () => {
		let fetchCalls = 0;
		mockOpenAiModeration({ sexual: 0.01, "sexual/minors": 0.01 }, { onFetch: () => fetchCalls++ });

		const result = await moderatePrompt("remove watermark from this panel", "ws-local-warn");

		expect(fetchCalls).toBe(1);
		expect(result.decision).toBe("warn");
		expect(result.scores.localHighRiskPrompt).toBe(1);
	});

	// Regression (codex #77): a multimodal crop check (text + image) must still run
	// the local text safety policy. Previously the local check was gated on
	// `!imageUrl`, so "remove watermark" / "make ... explicit" silently under-enforced
	// whenever the provider allowed the multimodal request.
	test("multimodal (text+image) still applies local text safety policy", async () => {
		mockOpenAiModeration({ sexual: 0.01, "sexual/minors": 0.01 });

		const result = await moderateMultimodal(
			{ text: "remove watermark from this panel", imageUrl: "https://r2.example/benign.jpg" },
			"ws-local-warn-multimodal",
		);

		expect(result.decision).toBe("warn");
		expect(result.scores.localHighRiskPrompt).toBe(1);
	});

	test("cache hit second call returns cached true and avoids fetch", async () => {
		let fetchCalls = 0;
		mockOpenAiModeration({ sexual: 0.01 }, { onFetch: () => fetchCalls++ });

		const first = await moderatePrompt("Translate safely", "ws-cache");
		const second = await moderatePrompt("Translate safely", "ws-cache");

		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(fetchCalls).toBe(1);
	});

	test("cache key scopes verdicts by workspace and threshold policy", async () => {
		let fetchCalls = 0;
		mockOpenAiModeration({ sexual: 0.01 }, { onFetch: () => fetchCalls++ });

		const first = await moderatePrompt("Translate safely", "ws-cache-a");
		const second = await moderatePrompt("Translate safely", "ws-cache-a");
		const third = await moderatePrompt("Translate safely", "ws-cache-b");
		process.env.OPENAI_MODERATION_THRESHOLDS_JSON = JSON.stringify({
			text: { harassment: 0.2 },
		});
		const fourth = await moderatePrompt("Translate safely", "ws-cache-a");

		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(third.cached).toBe(false);
		expect(fourth.cached).toBe(false);
		expect(fetchCalls).toBe(3);
	});

	// Regression (codex #11): a sexual *text* score paired with a benign crop must
	// not be escalated into an image CSAM legal-hold. The conservative image CSAM
	// block only applies when OpenAI attributes the sexual category to the image.
	test("text+image sexual score attributed to TEXT is not image-CSAM-blocked", async () => {
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		mockOpenAiModeration(
			{ sexual: 0.9, "sexual/minors": 0.01, harassment: 0.1 },
			{ appliedInputTypes: { sexual: ["text"] } },
		);
		try {
			const result = await moderateMultimodal(
				{ text: "explicit adult prose", imageUrl: "https://r2.example/benign-crop.jpg" },
				"ws-text-sexual",
				{ assetId: "asset-x", sha256: "sha-x" },
			);

			expect(result.status).not.toBe("csam_block");
			expect(audit.records).toHaveLength(0);
		} finally {
			restoreAudit();
		}
	});

	test("text+image sexual score attributed to IMAGE is conservatively CSAM-blocked", async () => {
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		mockOpenAiModeration(
			{ sexual: 0.9, "sexual/minors": 0.01 },
			{ appliedInputTypes: { sexual: ["image"] } },
		);
		try {
			const result = await moderateMultimodal(
				{ text: "translate this", imageUrl: "https://r2.example/explicit-crop.jpg" },
				"ws-image-sexual",
				{ assetId: "asset-y", sha256: "sha-y" },
			);

			expect(result.status).toBe("csam_block");
			expect(audit.records).toHaveLength(1);
		} finally {
			restoreAudit();
		}
	});

	// Regression (codex #5): the AI-output path moderates inside moderateImageBuffer
	// with no precomputed result, so it must thread assetId/sha256 into the CSAM
	// audit row instead of leaving legal-hold fields null.
	test("moderateImageBuffer forwards audit context into CSAM blocks", async () => {
		const { moderateImageBuffer } = await import("../services/moderation.js");
		const audit = new MemoryCsamAuditStore();
		const restoreAudit = setCsamAuditStoreForTests(audit);
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.2 });
		try {
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-ai-output", {
				assetId: "result_job-123.png",
				sha256: "ai-output-sha",
				ipAddress: "10.0.0.9",
				userAgent: "ai-job",
			});

			expect(result.status).toBe("blocked");
			expect(audit.records).toHaveLength(1);
			expect(audit.records[0]).toMatchObject({
				assetId: "result_job-123.png",
				sha256: "ai-output-sha",
				workspaceId: "ws-ai-output",
			});
		} finally {
			restoreAudit();
		}
	});

	// Regression (codex #4): an image-only `sexual/minors` score between the soft
	// text threshold (0.2) and the hard CSAM cutoff (0.5) must be hard-blocked by
	// the same minors policy used for text — never softened to warn/allow.
	test("image-only sexual/minors between soft and hard threshold is hard-blocked", async () => {
		mockOpenAiModeration({ "sexual/minors": 0.35, sexual: 0.1 });

		const result = await moderateImage("https://r2.example/minors-borderline.jpg", "ws-image-minors");

		expect(result.decision).toBe("block");
		expect(result.status).toBe("block");
		expect(result.reason).toBe("sexual/minors");
	});

	test("image-only sexual/minors minors block is NOT BYO-bypassable", async () => {
		const restoreBilling = setModerationBillingStoreForTests(new FakeBillingStore("studio", [{
			grantId: "grant-byo",
			workspaceId: "ws-byo-minors",
			addonId: "byo-openai-api",
			quantity: 1,
			aiCredits: 0,
			storageBytes: 0,
			seats: 0,
			teamJobs: 0,
			status: "active",
			source: "test",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}]));
		try {
			mockOpenAiModeration({ "sexual/minors": 0.35, sexual: 0.1 }, { flagged: true });
			const result = await moderateImage("https://r2.example/minors-byo.jpg", "ws-byo-minors");
			expect(result.decision).toBe("block");
			expect(result.bypassed).toBeUndefined();
		} finally {
			restoreBilling();
		}
	});

	// Regression (codex #10): the BYO soft-policy bypass entitlement is part of the
	// cache identity. A workspace that loses BYO must not keep receiving a cached
	// bypassed `allow`; one that gains BYO must not keep receiving a cached `warn`.
	test("changing BYO bypass entitlement invalidates the cached soft verdict", async () => {
		let fetchCalls = 0;
		mockOpenAiModeration({ violence: 0.95 }, { flagged: true, onFetch: () => fetchCalls++ });

		// 1) Without BYO: soft warn.
		const restoreNoByo = setModerationBillingStoreForTests(new FakeBillingStore("free", []));
		const warned = await moderateImage("https://r2.example/flagged-cache.jpg", "ws-byo-toggle");
		restoreNoByo();
		expect(warned.decision).toBe("warn");
		expect(warned.cached).toBe(false);
		expect(fetchCalls).toBe(1);

		// 2) Same content+workspace but now WITH BYO: must re-evaluate (cache miss)
		// and bypass to allow, not return the cached warn.
		const restoreByo = setModerationBillingStoreForTests(new FakeBillingStore("studio", [{
			grantId: "grant-toggle",
			workspaceId: "ws-byo-toggle",
			addonId: "byo-openai-api",
			quantity: 1,
			aiCredits: 0,
			storageBytes: 0,
			seats: 0,
			teamJobs: 0,
			status: "active",
			source: "test",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}]));
		try {
			const bypassed = await moderateImage("https://r2.example/flagged-cache.jpg", "ws-byo-toggle");
			expect(bypassed.decision).toBe("allow");
			expect(bypassed.bypassed).toBe(true);
			expect(bypassed.cached).toBe(false);
			expect(fetchCalls).toBe(2);
		} finally {
			restoreByo();
		}
	});

	test("does not cache transient OpenAI moderation failures", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (!url.startsWith("https://api.openai.com/v1/moderations")) {
				return originalFetch(input);
			}
			fetchCalls++;
			if (fetchCalls === 1) {
				throw new Error("transient moderation outage");
			}
			return new Response(JSON.stringify({
				id: "modr-test",
				model: "omni-moderation-latest",
				results: [{
					flagged: false,
					categories: { sexual: false },
					category_scores: { sexual: 0.01 },
					category_applied_input_types: {},
				}],
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const first = await moderatePrompt("Translate safely after outage", "ws-outage");
		const second = await moderatePrompt("Translate safely after outage", "ws-outage");

		expect(first.decision).toBe("block");
		expect(first.error).toContain("transient moderation outage");
		expect(second.decision).toBe("allow");
		expect(second.cached).toBe(false);
		expect(fetchCalls).toBe(2);
	});
});

// SECURITY: `toAssetModerationResult` is the single normalization seam between
// the raw moderation verdict (status `allow|warn|block|csam_block`) and the
// asset-facing status (`passed|needs_review|blocked`) that drives `storageStatus`
// quarantine. A hard block — plain `block` OR the legal-weight `csam_block` —
// MUST normalize to `"blocked"` so a CSAM/extreme verdict can never reach
// `recordUploadedAsset` as a releasable status. These tests pin that invariant
// on EVERY decision/status combination, including the direct `csam_block` path.
describe("toAssetModerationResult normalization (CSAM quarantine invariant)", () => {
	function rawResult(overrides: Partial<ModerationResult>): ModerationResult {
		return {
			decision: "allow",
			categories: {},
			scores: {},
			cached: false,
			ruleset_version: "1.0",
			provider: "openai_omni",
			checkedAt: "2026-06-05T00:00:00.000Z",
			...overrides,
		};
	}

	test("csam_block (raw status, block decision) normalizes to blocked", () => {
		const asset = toAssetModerationResult(rawResult({ decision: "block", status: "csam_block", reason: "sexual/minors" }));
		expect(asset.status).toBe("blocked");
	});

	test("csam_block normalizes to blocked even if the decision were ever mislabeled", () => {
		// Defense-in-depth: a raw `csam_block` status MUST quarantine regardless of
		// the accompanying decision field. Hard-coded illegal-content invariant.
		const asset = toAssetModerationResult(rawResult({ decision: "allow", status: "csam_block" }));
		expect(asset.status).toBe("blocked");
	});

	test("plain block normalizes to blocked", () => {
		const asset = toAssetModerationResult(rawResult({ decision: "block", status: "block", reason: "sexual/minors" }));
		expect(asset.status).toBe("blocked");
	});

	test("allow normalizes to passed (released)", () => {
		const asset = toAssetModerationResult(rawResult({ decision: "allow", status: "allow" }));
		expect(asset.status).toBe("passed");
	});

	test("warn / needs_review normalizes to needs_review (released with review marker)", () => {
		const asset = toAssetModerationResult(rawResult({ decision: "warn", status: "warn", reason: "violence/graphic" }));
		expect(asset.status).toBe("needs_review");
	});

	test("a bypassed (BYO) soft allow stays released, never blocked", () => {
		const asset = toAssetModerationResult(rawResult({ decision: "allow", status: "allow", bypassed: true }));
		expect(asset.status).toBe("passed");
	});
});

// SECURITY (codex P0-1): a PROVIDER FAILURE/timeout on the MANDATORY CSAM screen
// must FAIL CLOSED — the asset is QUARANTINED (not servable, not exportable), NOT
// treated as a servable borderline `needs_review`. A genuine provider-SUCCEEDED
// borderline `needs_review` stays released (in-editor servable, export-gated to
// `passed`). The `failClosed` marker carries the distinction onto the storage
// status.
describe("mandatory CSAM provider-failure fails closed (quarantined, not servable)", () => {
	beforeEach(() => {
		process.env.NODE_ENV = "production";
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true"; // even with fail-open ON
	});
	afterEach(() => {
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
	});

	test("no-provider mandatory screen → needs_review WITH failClosed (provider failure)", async () => {
		const { mandatoryCsamScreenBuffer } = await import("../services/moderation.js");
		const restoreKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const result = await mandatoryCsamScreenBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-failclosed");
			expect(result.status).toBe("needs_review");
			expect(result.failClosed).toBe(true);
		} finally {
			if (restoreKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = restoreKey;
		}
	});

	test("storageStatusForModerationResult QUARANTINES a failClosed needs_review, RELEASES a genuine one", async () => {
		const { storageStatusForModerationResult } = await import("../services/assets.js");
		const now = new Date().toISOString();
		const failClosed = { status: "needs_review" as const, provider: "test", checkedAt: now, failClosed: true };
		const genuineBorderline = { status: "needs_review" as const, provider: "test", checkedAt: now };
		const blocked = { status: "blocked" as const, provider: "test", checkedAt: now };
		const passed = { status: "passed" as const, provider: "test", checkedAt: now };
		expect(storageStatusForModerationResult(failClosed)).toBe("quarantined");
		expect(storageStatusForModerationResult(genuineBorderline)).toBe("released");
		expect(storageStatusForModerationResult(blocked)).toBe("blocked");
		expect(storageStatusForModerationResult(passed)).toBe("released");
		expect(storageStatusForModerationResult(undefined)).toBe("blocked");
	});

	test("denylist-lookup-failure fail-closed result is marked failClosed (quarantined)", async () => {
		const { buildDenylistLookupFailClosedResult } = await import("../services/moderation.js");
		const { storageStatusForModerationResult } = await import("../services/assets.js");
		const result = buildDenylistLookupFailClosedResult();
		expect(result.status).toBe("needs_review");
		expect(result.failClosed).toBe(true);
		expect(storageStatusForModerationResult(result)).toBe("quarantined");
	});
});

// `moderationResultIsConfirmedBlock` is the discriminator the mandatory CSAM
// screen uses to decide whether an error-carrying result is a CONFIRMED block
// (keep blocked) or a provider-failure fallback (fail closed to needs_review).
// Pinning the truth table prevents a future refactor from re-introducing the
// round-3 leak (confirmed csam_block + audit error → needs_review → released).
describe("moderationResultIsConfirmedBlock discriminator", () => {
	function rawResult(overrides: Partial<ModerationResult>): ModerationResult {
		return {
			decision: "allow",
			categories: {},
			scores: {},
			cached: false,
			ruleset_version: "1.0",
			provider: "openai_omni",
			checkedAt: "2026-06-05T00:00:00.000Z",
			...overrides,
		};
	}

	test("csam_block WITH an audit-write error is still a confirmed block", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "block", status: "csam_block", error: "csam_audit_write_failed: db down" }))).toBe(true);
	});

	test("csam_block without error is a confirmed block", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "block", status: "csam_block" }))).toBe(true);
	});

	test("error-FREE plain block (e.g. minors-policy hard block) is a confirmed block", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "block", status: "block" }))).toBe(true);
	});

	test("provider-failure fallback (bare block WITH error) is NOT confirmed", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "block", status: "block", error: "OpenAI moderation failed" }))).toBe(false);
	});

	test("fail-open allow WITH error is NOT confirmed", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "allow", status: "allow", error: "OpenAI moderation failed; fail-open is enabled" }))).toBe(false);
	});

	test("warn and allow are NOT confirmed blocks", () => {
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "warn", status: "warn" }))).toBe(false);
		expect(moderationResultIsConfirmedBlock(rawResult({ decision: "allow", status: "allow" }))).toBe(false);
	});
});

// The SOFT (policy) kill switch only toggles soft/policy moderation. The MANDATORY
// CSAM screen is split out and must still run when the toggle is off. With a
// provider key present, disabling the soft toggle does NOT local-pass: the
// mandatory screen calls the provider and a flagged image becomes needs_review.
// The local-pass dev escape applies ONLY when the provider is unconfigured AND the
// runtime is non-production (the default in tests).
describe("image moderation kill switch (mandatory CSAM still runs)", () => {
	test("soft toggle off + NO provider key (non-prod) → local pass without calling OpenAI", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { moderateImageBuffer, imageModerationEnabled } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		const originalKey = process.env.OPENAI_API_KEY;
		let fetchCalls = 0;
		mockOpenAiModeration({ violence: 0.99 }, { flagged: true, onFetch: () => fetchCalls++ });
		try {
			delete process.env.OPENAI_API_KEY; // provider unconfigured → dev escape applies
			saveConfig({ ...originalConfig, imageModerationEnabled: false });
			expect(imageModerationEnabled()).toBe(false);

			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-killswitch");

			expect(result.status).toBe("passed");
			expect(result.provider).toBe("local-development-rules");
			expect(fetchCalls).toBe(0);
		} finally {
			if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalKey;
			saveConfig(originalConfig);
		}
	});

	test("soft toggle OFF but provider available → mandatory screen still runs (flagged image NOT local-passed)", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { moderateImageBuffer, imageModerationEnabled } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		let fetchCalls = 0;
		// A real PNG header so the bounded derivative encodes and the provider is hit.
		mockOpenAiModeration({ violence: 0.99, "violence/graphic": 0.9 }, { flagged: true, onFetch: () => fetchCalls++ });
		try {
			saveConfig({ ...originalConfig, imageModerationEnabled: false });
			expect(imageModerationEnabled()).toBe(false);

			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-killswitch-mandatory");

			// The mandatory screen consulted the provider — NOT a blanket local pass.
			expect(fetchCalls).toBeGreaterThan(0);
			expect(result.status).not.toBe("passed");
			expect(result.provider).toBe("openai_omni");
		} finally {
			saveConfig(originalConfig);
		}
	});

	test("soft toggle OFF: a CSAM-flagged image is STILL blocked (mandatory fails closed)", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { moderateImageBuffer, imageModerationEnabled } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.2 }, { flagged: true });
		try {
			saveConfig({ ...originalConfig, imageModerationEnabled: false });
			expect(imageModerationEnabled()).toBe(false);

			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-csam-killswitch", {
				assetId: "asset-killswitch",
				sha256: "sha-csam-killswitch",
			});

			expect(result.status).toBe("blocked");
		} finally {
			saveConfig(originalConfig);
		}
	});

	test("soft toggle OFF + production + no provider key → fail closed (needs_review), never local pass", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { mandatoryCsamScreenBuffer } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		const originalKey = process.env.OPENAI_API_KEY;
		const originalNodeEnv = process.env.NODE_ENV;
		try {
			delete process.env.OPENAI_API_KEY;
			process.env.NODE_ENV = "production";
			saveConfig({ ...originalConfig, imageModerationEnabled: false });

			const result = await mandatoryCsamScreenBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-prod-noprovider");

			// Production with no provider must NOT release an unscreened image.
			expect(result.status).toBe("needs_review");
		} finally {
			if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalKey;
			if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = originalNodeEnv;
			saveConfig(originalConfig);
		}
	});

	test("known-CSAM sha is hard-blocked on re-upload BEFORE any provider call", async () => {
		const { moderateImageBuffer } = await import("../services/moderation.js");
		const audit = new MemoryCsamAuditStore();
		await audit.append({
			sha256: "sha-known-bad",
			scores: { "sexual/minors": 0.9 },
			blockedAt: new Date().toISOString(),
		});
		const restoreAudit = setCsamAuditStoreForTests(audit);
		let fetchCalls = 0;
		mockOpenAiModeration({ violence: 0.0 }, { onFetch: () => fetchCalls++ });
		try {
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-known-bad", {
				assetId: "asset-known-bad",
				sha256: "sha-known-bad",
			});
			expect(result.status).toBe("blocked");
			expect(fetchCalls).toBe(0); // denylist short-circuits before the provider
		} finally {
			restoreAudit();
		}
	});

	// FIX #2 (codex re-review): OPENAI_MODERATION_FAIL_OPEN may only relax SOFT
	// policy — it must NEVER turn a mandatory/CSAM provider ERROR into `passed`.
	// With the toggle ON, fail-open ON, and the provider THROWING, the asset-upload /
	// AI-output path (`moderateImageBuffer`) must fail closed (needs_review).
	test("FIX #2: FAIL_OPEN cannot make a mandatory provider error pass (toggle ON, provider throws)", async () => {
		const { moderateImageBuffer } = await import("../services/moderation.js");
		process.env.OPENAI_MODERATION_ENABLED = "true";
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true";
		globalThis.fetch = (async () => {
			throw new Error("simulated provider outage");
		}) as typeof fetch;
		try {
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-failopen", {
				assetId: "fail-open.png",
				sha256: "fail-open-sha",
			});
			expect(result.status).toBe("needs_review");
			expect(result.status).not.toBe("passed");
		} finally {
			delete process.env.OPENAI_MODERATION_ENABLED;
		}
	});

	// FIX #2: same guarantee on a non-OK provider HTTP status (the other
	// provider-error path inside moderateMultimodal).
	test("FIX #2: FAIL_OPEN cannot make a mandatory provider 500 pass", async () => {
		const { moderateImageBuffer } = await import("../services/moderation.js");
		process.env.OPENAI_MODERATION_ENABLED = "true";
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("https://api.openai.com/v1/moderations")) {
				return new Response("upstream error", { status: 500 });
			}
			return originalFetch(input);
		}) as typeof fetch;
		try {
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-failopen-500", {
				assetId: "fail-open-500.png",
				sha256: "fail-open-500-sha",
			});
			expect(result.status).toBe("needs_review");
		} finally {
			delete process.env.OPENAI_MODERATION_ENABLED;
		}
	});

	// upload-pipeline-reliability P1: a HUNG moderation provider must not block the
	// upload commit loop forever. The bounded AbortController turns a stall into a
	// thrown AbortError → moderateMultimodal's existing fail-CLOSED path → the
	// mandatory CSAM screen holds it as needs_review. We mock a fetch that NEVER
	// resolves on its own and only rejects when the request signal aborts, with a
	// tiny timeout, and assert the call returns a fail-closed needs_review WITHIN the
	// bound (it would otherwise hang the test).
	test("upload-pipeline P1: a hung moderation provider times out → fail-closed needs_review (policy unchanged)", async () => {
		const { moderateImageBuffer, moderationProviderTimeoutMs } = await import("../services/moderation.js");
		process.env.OPENAI_MODERATION_ENABLED = "true";
		// fail-open ON proves the timeout still fails CLOSED (policy unchanged: a
		// provider error on the mandatory screen never passes/fails-open).
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true";
		process.env.OPENAI_MODERATION_TIMEOUT_MS = "50";
		let aborted = false;
		globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("https://api.openai.com/v1/moderations")) {
				// Hang until aborted: resolve never, reject only on the abort signal so the
				// bounded timeout is the ONLY thing that can settle this request.
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						signal.addEventListener("abort", () => {
							aborted = true;
							const err = new Error("aborted");
							err.name = "AbortError";
							reject(err);
						});
					}
				});
			}
			return originalFetch(input as Parameters<typeof fetch>[0]);
		}) as typeof fetch;
		try {
			expect(moderationProviderTimeoutMs()).toBe(50);
			const start = Date.now();
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-mod-timeout", {
				assetId: "mod-timeout.png",
				sha256: "mod-timeout-sha",
			});
			const elapsed = Date.now() - start;
			expect(aborted).toBe(true);
			expect(result.status).toBe("needs_review");
			expect(result.status).not.toBe("passed");
			// Bounded: settles well within a small multiple of the 50ms timeout, not
			// indefinitely.
			expect(elapsed).toBeLessThan(5000);
		} finally {
			delete process.env.OPENAI_MODERATION_ENABLED;
			delete process.env.OPENAI_MODERATION_TIMEOUT_MS;
		}
	});

	// FIX #3 (codex re-review): a known-CSAM-sha denylist LOOKUP failure must fail
	// closed (needs_review), not collapse to "not denylisted" and proceed into the
	// provider/local-pass path. An exact known-bad re-upload must never depend on
	// provider rediscovery.
	test("FIX #3: denylist lookup error fails closed (returns needs_review, not passed)", async () => {
		const { moderateImageBuffer, lookupKnownBlockedSha256 } = await import("../services/moderation.js");
		const throwingStore: CsamBlockAuditStore = {
			async append() {},
			async hasBlockedSha256() {
				throw new Error("simulated denylist DB outage");
			},
		};
		const restoreAudit = setCsamAuditStoreForTests(throwingStore);
		// The provider WOULD pass this benign image, proving the fail-closed verdict
		// comes from the denylist lookup error, not the provider.
		mockOpenAiModeration({ sexual: 0.01 });
		try {
			expect(await lookupKnownBlockedSha256("error-sha")).toBe("lookup-error");
			const result = await moderateImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", "ws-denylist-err", {
				assetId: "denylist-err.png",
				sha256: "error-sha",
			});
			expect(result.status).toBe("needs_review");
			expect(result.status).not.toBe("passed");
		} finally {
			restoreAudit();
		}
	});

	// FIX #4 (codex round-3 re-review): a CONFIRMED mandatory CSAM block must stay
	// `blocked` even when the CSAM AUDIT WRITE fails. `evaluateOpenAiResult` preserves
	// the `csam_block` verdict and attaches `error = "csam_audit_write_failed: ..."`;
	// `mandatoryCsamScreenBuffer` must NOT treat that error as a provider failure and
	// downgrade to `needs_review` (which would RELEASE the image and let admin approve
	// flip it to passed). Soft toggle OFF + fail-open ON + denylist not-found is the
	// exact reported leak path.
	test("FIX #4: confirmed CSAM block + audit-write failure stays BLOCKED (not downgraded to needs_review)", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { moderateImageBuffer, mandatoryCsamScreenBuffer, imageModerationEnabled } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		// Audit store: append() throws (write failure), hasBlockedSha256() reports the
		// sha is NOT on the denylist — so the denylist short-circuit does NOT fire and
		// the verdict must come from the mandatory provider screen alone.
		const failingAudit: CsamBlockAuditStore = {
			async append() {
				throw new Error("simulated CSAM audit DB outage");
			},
			async hasBlockedSha256() {
				return false;
			},
		};
		const restoreAudit = setCsamAuditStoreForTests(failingAudit);
		// Maximize the leak pressure: fail-open ON (would relax soft policy) + soft
		// toggle OFF. The provider returns a real CSAM verdict.
		process.env.OPENAI_MODERATION_FAIL_OPEN = "true";
		mockOpenAiModeration({ "sexual/minors": 0.8, sexual: 0.2 }, { flagged: true });
		try {
			saveConfig({ ...originalConfig, imageModerationEnabled: false });
			expect(imageModerationEnabled()).toBe(false);

			// The mandatory screen alone must return a confirmed BLOCK, never needs_review.
			const mandatory = await mandatoryCsamScreenBuffer(
				Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				"image/png",
				"ws-csam-auditfail",
				{ assetId: "asset-auditfail", sha256: "sha-csam-auditfail" },
			);
			expect(mandatory.status).toBe("blocked");
			expect(mandatory.status).not.toBe("needs_review");
			expect(mandatory.status).not.toBe("passed");

			// End-to-end: the upload path returns blocked → storageStatus quarantines it.
			const result = await moderateImageBuffer(
				Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				"image/png",
				"ws-csam-auditfail",
				{ assetId: "asset-auditfail-2", sha256: "sha-csam-auditfail-2" },
			);
			expect(result.status).toBe("blocked");
		} finally {
			restoreAudit();
			saveConfig(originalConfig);
		}
	});

	// FIX #4 sibling: a genuine PROVIDER failure (no real verdict) must still fail
	// closed to `needs_review` — the audit-write-preservation must NOT accidentally
	// hard-block a benign upload on a mere provider outage. fail-closed `block`
	// fallback carries an `error` and a bare `block` status, so it is NOT confirmed.
	test("FIX #4 sibling: provider failure with NO verdict still fails closed to needs_review", async () => {
		const { mandatoryCsamScreenBuffer } = await import("../services/moderation.js");
		process.env.OPENAI_MODERATION_FAIL_OPEN = "false";
		globalThis.fetch = (async () => {
			throw new Error("simulated provider outage (no verdict)");
		}) as typeof fetch;
		const result = await mandatoryCsamScreenBuffer(
			Buffer.from([0x89, 0x50, 0x4e, 0x47]),
			"image/png",
			"ws-provider-outage",
			{ assetId: "asset-outage", sha256: "sha-outage" },
		);
		expect(result.status).toBe("needs_review");
		expect(result.status).not.toBe("blocked");
		expect(result.status).not.toBe("passed");
	});

	// Regression (codex #77): the documented OPENAI_MODERATION_ENABLED env switch
	// must override the saved config so an outage / staged-rollout deployment can
	// disable image moderation without mutating data/config.json.
	test("OPENAI_MODERATION_ENABLED env overrides the saved config value", async () => {
		const { loadConfig, saveConfig } = await import("../config.js");
		const { imageModerationEnabled } = await import("../services/moderation.js");
		const originalConfig = loadConfig();
		try {
			saveConfig({ ...originalConfig, imageModerationEnabled: true });
			process.env.OPENAI_MODERATION_ENABLED = "false";
			expect(imageModerationEnabled()).toBe(false);
			process.env.OPENAI_MODERATION_ENABLED = "true";
			saveConfig({ ...originalConfig, imageModerationEnabled: false });
			expect(imageModerationEnabled()).toBe(true);
		} finally {
			delete process.env.OPENAI_MODERATION_ENABLED;
			saveConfig(originalConfig);
		}
	});
});

function mockOpenAiModeration(
	scores: Record<string, number>,
	options: {
		flagged?: boolean;
		onFetch?: () => void;
		appliedInputTypes?: Record<string, Array<"text" | "image">>;
	} = {},
): void {
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.startsWith("https://api.openai.com/v1/moderations")) {
			return originalFetch(input, init);
		}
		options.onFetch?.();
		const categories = Object.fromEntries(Object.entries(scores).map(([category, score]) => [category, score > 0.5]));
		return new Response(JSON.stringify({
			id: "modr-test",
			model: "omni-moderation-latest",
			results: [{
				flagged: options.flagged ?? false,
				categories,
				category_scores: scores,
				category_applied_input_types: options.appliedInputTypes ?? {},
			}],
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}
