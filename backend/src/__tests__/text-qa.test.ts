// Tests for the text-QA service (typo / spacing checker). Mocks the OpenAI
// gpt-4o-mini chat completions endpoint, exercises caching, the per-user daily
// character budget, structured-output sanitization, and provider error mapping.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	checkTextQa,
	sanitizeIssues,
	normalizeTextQaLang,
	resolveTextQaDailyLimit,
	buildTextQaQuotaSummary,
	setTextQaStoreForTests,
	TextQaQuotaExceededError,
	TextQaProviderError,
	utcDayKey,
	type TextQaIssue,
	type TextQaStore,
} from "../services/text-qa.js";

function makeMemoryStore(): TextQaStore & { _cache: Map<string, TextQaIssue[]>; _counters: Map<string, number> } {
	const cache = new Map<string, TextQaIssue[]>();
	const counters = new Map<string, number>();
	return {
		_cache: cache,
		_counters: counters,
		async getCached(key) {
			return cache.get(key) ?? null;
		},
		async setCached(key, issues) {
			cache.set(key, issues);
		},
		async incrementDaily(userId, dayKey, chars) {
			const k = `${userId}:${dayKey}`;
			const next = (counters.get(k) ?? 0) + chars;
			counters.set(k, next);
			return next;
		},
		async getDaily(userId, dayKey) {
			return counters.get(`${userId}:${dayKey}`) ?? 0;
		},
	};
}

function mockProviderResponse(issues: unknown): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: JSON.stringify({ issues }) } }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("normalizeTextQaLang", () => {
	test("accepts supported langs and falls back to en", () => {
		expect(normalizeTextQaLang("th")).toBe("th");
		expect(normalizeTextQaLang("JA")).toBe("ja");
		expect(normalizeTextQaLang("zh-CN")).toBe("zh");
		expect(normalizeTextQaLang("ko_KR")).toBe("ko");
		expect(normalizeTextQaLang("fr")).toBe("en");
		expect(normalizeTextQaLang(undefined)).toBe("en");
	});
});

describe("sanitizeIssues", () => {
	test("drops out-of-range, invalid-type, and overlapping issues", () => {
		const result = sanitizeIssues(
			[
				{ start: 0, end: 3, type: "typo", message: "a", suggestion: "x" },
				{ start: 2, end: 5, type: "spacing", message: "overlaps", suggestion: " " }, // overlaps prev
				{ start: 5, end: 4, type: "typo", message: "bad range", suggestion: "" }, // start>=end
				{ start: 5, end: 8, type: "bogus", message: "bad type", suggestion: "" }, // bad type
				{ start: 5, end: 100, type: "grammar", message: "oob", suggestion: "" }, // end>len
				{ start: 6, end: 9, type: "punctuation", message: "ok", suggestion: "." },
			],
			10,
		);
		expect(result).toEqual([
			{ start: 0, end: 3, type: "typo", message: "a", suggestion: "x" },
			{ start: 6, end: 9, type: "punctuation", message: "ok", suggestion: "." },
		]);
	});

	test("returns empty for non-array input", () => {
		expect(sanitizeIssues(null, 10)).toEqual([]);
		expect(sanitizeIssues("nope", 10)).toEqual([]);
	});
});

describe("resolveTextQaDailyLimit", () => {
	test("free tier gets the base budget; paid tiers get more", () => {
		const free = resolveTextQaDailyLimit("free");
		const pro = resolveTextQaDailyLimit("pro");
		expect(free).toBeGreaterThan(0);
		expect(pro).toBeGreaterThan(free);
	});
});

describe("checkTextQa", () => {
	const origFetch = globalThis.fetch;
	const prevKey = process.env.OPENAI_API_KEY;
	let restoreStore: () => void;

	beforeEach(() => {
		process.env.OPENAI_API_KEY = "sk-test";
		restoreStore = setTextQaStoreForTests(makeMemoryStore());
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
		restoreStore();
		if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prevKey;
	});

	test("empty text returns no issues without calling the provider", async () => {
		let called = false;
		globalThis.fetch = mock(async () => {
			called = true;
			return mockProviderResponse([]);
		}) as any;
		const result = await checkTextQa({ text: "   ", lang: "th", userId: "u1" });
		expect(result.issues).toEqual([]);
		expect(result.cached).toBe(true);
		expect(result.charsCharged).toBe(0);
		expect(called).toBe(false);
	});

	test("calls gpt-4o-mini with structured output and temperature 0", async () => {
		let capturedBody: any;
		globalThis.fetch = mock(async (_url: string, opts: any) => {
			capturedBody = JSON.parse(opts.body);
			return mockProviderResponse([
				{ start: 0, end: 4, type: "typo", message: "สะกดผิด", suggestion: "สวัสดี" },
			]);
		}) as any;

		const result = await checkTextQa({ text: "สวัสดร", lang: "th", userId: "u1" });
		expect(capturedBody.model).toBe("gpt-4o-mini");
		expect(capturedBody.temperature).toBe(0);
		expect(capturedBody.response_format.type).toBe("json_schema");
		expect(capturedBody.response_format.json_schema.name).toBe("text_qa_issues");
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].type).toBe("typo");
		expect(result.cached).toBe(false);
		expect(result.charsCharged).toBe("สวัสดร".length);
	});

	test("identical text is served from cache without a second provider call", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls += 1;
			return mockProviderResponse([{ start: 0, end: 2, type: "spacing", message: "เว้นวรรค", suggestion: " " }]);
		}) as any;

		const first = await checkTextQa({ text: "hello world", lang: "en", userId: "u1" });
		const second = await checkTextQa({ text: "hello world", lang: "en", userId: "u1" });
		expect(calls).toBe(1);
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(second.charsCharged).toBe(0);
	});

	test("different lang for same text is a distinct cache entry", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls += 1;
			return mockProviderResponse([]);
		}) as any;
		await checkTextQa({ text: "ok", lang: "en", userId: "u1" });
		await checkTextQa({ text: "ok", lang: "th", userId: "u1" });
		expect(calls).toBe(2);
	});

	test("enforces the daily character budget with a 402-style error", async () => {
		process.env.WORKSPACE_PLAN_ID = "free";
		const limit = resolveTextQaDailyLimit("free");
		globalThis.fetch = mock(async () => mockProviderResponse([])) as any;

		// Pre-charge to just under the limit via the store, then submit text that
		// pushes over.
		const store = makeMemoryStore();
		const restore = setTextQaStoreForTests(store);
		try {
			const day = utcDayKey();
			await store.incrementDaily("heavy", day, limit - 1);
			await expect(
				checkTextQa({ text: "this is more than one char", lang: "en", userId: "heavy", planId: "free" }),
			).rejects.toBeInstanceOf(TextQaQuotaExceededError);
		} finally {
			restore();
			delete process.env.WORKSPACE_PLAN_ID;
		}
	});

	test("rolls back the increment when a request is rejected over the daily limit", async () => {
		process.env.WORKSPACE_PLAN_ID = "free";
		const limit = resolveTextQaDailyLimit("free");
		globalThis.fetch = mock(async () => mockProviderResponse([])) as any;
		const store = makeMemoryStore();
		const restore = setTextQaStoreForTests(store);
		try {
			const day = utcDayKey();
			const startUsed = limit - 1;
			await store.incrementDaily("heavy", day, startUsed);
			const err = await checkTextQa({
				text: "this is more than one char",
				lang: "en",
				userId: "heavy",
				planId: "free",
			}).catch((e) => e);
			expect(err).toBeInstanceOf(TextQaQuotaExceededError);
			// The rejected request makes no provider call, so its characters must be
			// refunded — the stored counter must NOT stay inflated past the limit.
			const used = await store.getDaily("heavy", day);
			expect(used).toBe(startUsed);
			expect((err as TextQaQuotaExceededError).summary.usedChars).toBe(startUsed);
		} finally {
			restore();
			delete process.env.WORKSPACE_PLAN_ID;
		}
	});

	test("maps a provider timeout / network rejection to a retryable provider error and refunds", async () => {
		const store = makeMemoryStore();
		const restore = setTextQaStoreForTests(store);
		try {
			globalThis.fetch = mock(async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			}) as any;
			const err = await checkTextQa({ text: "needs check", lang: "en", userId: "u-timeout" }).catch((e) => e);
			expect(err).toBeInstanceOf(TextQaProviderError);
			expect((err as TextQaProviderError).retryable).toBe(true);
			expect((err as TextQaProviderError).statusCode).toBe(502);
			const used = await store.getDaily("u-timeout", utcDayKey());
			expect(used).toBe(0); // charge refunded after the failed call
		} finally {
			restore();
		}
	});

	test("refunds the charge when the provider fails", async () => {
		const store = makeMemoryStore();
		const restore = setTextQaStoreForTests(store);
		try {
			globalThis.fetch = mock(async () => new Response("boom", { status: 500 })) as any;
			await expect(
				checkTextQa({ text: "needs check", lang: "en", userId: "u2" }),
			).rejects.toBeInstanceOf(TextQaProviderError);
			const used = await store.getDaily("u2", utcDayKey());
			expect(used).toBe(0); // charge was refunded
		} finally {
			restore();
		}
	});

	test("rejects text that exceeds the max length", async () => {
		process.env.TEXT_QA_MAX_TEXT_CHARS = "10";
		try {
			await expect(
				checkTextQa({ text: "this text is definitely longer than ten", lang: "en", userId: "u3" }),
			).rejects.toBeInstanceOf(TextQaProviderError);
		} finally {
			delete process.env.TEXT_QA_MAX_TEXT_CHARS;
		}
	});

	test("throws when OPENAI_API_KEY is missing", async () => {
		delete process.env.OPENAI_API_KEY;
		await expect(
			checkTextQa({ text: "check me", lang: "en", userId: "u4" }),
		).rejects.toBeInstanceOf(TextQaProviderError);
	});
});

describe("buildTextQaQuotaSummary", () => {
	test("reports used / remaining / reset", async () => {
		const store = makeMemoryStore();
		const restore = setTextQaStoreForTests(store);
		try {
			await store.incrementDaily("u5", utcDayKey(), 123);
			const summary = await buildTextQaQuotaSummary({ userId: "u5", planId: "free" });
			expect(summary.usedChars).toBe(123);
			expect(summary.limitChars).toBeGreaterThan(0);
			expect(summary.remainingChars).toBe(summary.limitChars - 123);
			expect(summary.resetAt).toBeGreaterThan(Date.now());
		} finally {
			restore();
		}
	});
});
