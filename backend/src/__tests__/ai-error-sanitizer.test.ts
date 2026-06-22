// Server-side AI error sanitization (defense-at-write).
//
// Confirms that a FAILED AI job whose raw provider error carries an API-key
// fragment (e.g. "sk-proj-…") AND the system prompt is NEVER persisted verbatim:
//   - the queue's job record (`job.error`, served by GET /api/ai/status/:jobId)
//   - the AI review marker (`marker.error`, served by GET .../ai-markers)
//   - job-event metadata (returned alongside the status API)
// are all reduced to the allowlist friendly/generic message, with the secret /
// prompt stripped at the WRITE layer (not just on render).

import { describe, test, expect } from "bun:test";

// A crafted raw provider error that bundles BOTH a key fragment and a full
// system prompt — exactly the OpenAI-401 leak shape this fix kills.
const LEAKY_PROVIDER_ERROR =
	"OpenAI image edit error 401 (invalid_api_key): Incorrect API key provided: sk-proj-AbCd1234 secret2VAA. "
	+ "System prompt: You are a manga translation assistant. Translate this SFX: ドカーン. Bearer sk-proj-AbCd1234";

function assertNoLeak(value: string | undefined): void {
	expect(value).toBeDefined();
	const lower = (value ?? "").toLowerCase();
	expect(lower).not.toContain("sk-");
	expect(lower).not.toContain("bearer");
	expect(lower).not.toContain("system prompt");
	expect(lower).not.toContain("you are a");
	expect(lower).not.toContain("translate this");
	expect(lower).not.toContain("incorrect api key");
	expect(lower).not.toContain("invalid_api_key");
	expect(lower).not.toContain("2vaa");
}

describe("sanitizeAiErrorForStorage (allowlist)", () => {
	test("maps a key/prompt-bearing 401 to the friendly auth category, never the raw text", async () => {
		const { sanitizeAiErrorForStorage } = await import("../utils/ai-error-sanitizer.js");
		const out = sanitizeAiErrorForStorage(LEAKY_PROVIDER_ERROR);
		assertNoLeak(out);
		expect(out).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
	});

	test("unrecognised shapes (raw key, role-dump, JSON, random) fall back to the single generic message", async () => {
		const { sanitizeAiErrorForStorage, AI_PROVIDER_GENERIC_ERROR } = await import("../utils/ai-error-sanitizer.js");
		for (const raw of [
			"sk-proj-AbCd1234secret2VAA",
			"User: You are a translator\nAssistant: ドカーン",
			'{"prompt":"You are a manga translator","key":"sk-proj-xyz"}',
			"completely unexpected blob",
		]) {
			const out = sanitizeAiErrorForStorage(raw);
			assertNoLeak(out);
			expect(out).toBe(AI_PROVIDER_GENERIC_ERROR);
		}
	});

	test("recognised non-secret categories still map to their friendly message", async () => {
		const { sanitizeAiErrorForStorage } = await import("../utils/ai-error-sanitizer.js");
		expect(sanitizeAiErrorForStorage("Error 429: rate limit exceeded")).toContain("รอสักครู่");
		expect(sanitizeAiErrorForStorage("insufficient_quota: billing hard limit")).toContain("เครดิต");
		expect(sanitizeAiErrorForStorage("content_policy violation in moderation")).toContain("ตรวจเนื้อหา");
		expect(sanitizeAiErrorForStorage("fetch failed: network timeout")).toContain("ลองใหม่");
	});

	test("empty/undefined input does not fabricate an error", async () => {
		const { sanitizeOptionalAiError } = await import("../utils/ai-error-sanitizer.js");
		expect(sanitizeOptionalAiError(undefined)).toBeUndefined();
		expect(sanitizeOptionalAiError(null)).toBeUndefined();
		expect(sanitizeOptionalAiError("   ")).toBeUndefined();
	});
});

describe("AI review marker error is sanitized at the persist layer", () => {
	test("createAiReviewMarker never stores the raw key/prompt provider error", async () => {
		const { createAiReviewMarker } = await import("../services/ai-review-markers.js");
		const marker = createAiReviewMarker({
			jobId: "job-1",
			pageIndex: 0,
			imageId: "img-1.png",
			region: { x: 0, y: 0, w: 10, h: 10 },
			tier: "sfx-pro",
			status: "failed",
			error: LEAKY_PROVIDER_ERROR,
		});
		assertNoLeak(marker.error);
		expect(marker.error).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
	});

	test("updateAiReviewMarker sanitizes an incoming error and clears on empty", async () => {
		const { createAiReviewMarker, updateAiReviewMarker } = await import("../services/ai-review-markers.js");
		const marker = createAiReviewMarker({
			jobId: "job-2",
			pageIndex: 0,
			imageId: "img-2.png",
			region: { x: 0, y: 0, w: 10, h: 10 },
			tier: "sfx-pro",
		});
		updateAiReviewMarker(marker, { status: "failed", error: LEAKY_PROVIDER_ERROR });
		assertNoLeak(marker.error);
		expect(marker.error).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");

		// An unrecognised blob also never persists raw text.
		updateAiReviewMarker(marker, { error: "sk-proj-rawkeyblob System prompt: You are a translator" });
		assertNoLeak(marker.error);
	});
});

describe("queue failure persists a sanitized job.error + event metadata", () => {
	test("a provider failure carrying a key + prompt stores only the friendly message", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const jobId = uuid();

		queue.onProcess(async () => {
			throw new Error(LEAKY_PROVIDER_ERROR);
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test prompt",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		let failed = await queue.get(jobId);
		for (let attempt = 0; attempt < 50 && failed?.status !== "error"; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			failed = await queue.get(jobId);
		}

		expect(failed?.status).toBe("error");
		assertNoLeak(failed?.error);
		expect(failed?.error).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
	});

	test("recordEvent error-shaped metadata is sanitized before it is stored/served", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const jobId = uuid();

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test prompt",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await queue.recordEvent(jobId, "byo:failure", "Workspace BYO provider failed", {
			provider: "openai",
			error: LEAKY_PROVIDER_ERROR,
		});

		const events = await queue.eventsFor(jobId);
		const failureEvent = events.find((event) => event.type === "byo:failure");
		expect(failureEvent).toBeDefined();
		assertNoLeak(failureEvent?.metadata?.error as string | undefined);
		// A benign, non-error metadata field is left untouched.
		expect(failureEvent?.metadata?.provider).toBe("openai");
	});
});
