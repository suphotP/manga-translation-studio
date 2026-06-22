// Text QA — background typo / spacing / grammar / punctuation checker for
// translated text layers. Uses OpenAI gpt-4o-mini with structured JSON output
// (response_format json_schema, temperature 0) and a strict "catch real errors,
// low false-positive" prompt. Results are cached by sha256(text+lang) so the
// same text is never re-checked, and every user gets a free daily character
// budget (almost free: gpt-4o-mini is ~$0.15/1M input tokens).
//
// Storage follows the project's dual-mode convention: Redis when REDIS_URL /
// TEXT_QA_STORE=redis is configured, otherwise an in-process Map (prototype /
// tests). The cache holds results for 30 days; the quota counter resets daily.

import { createHash } from "crypto";
import { RedisClient } from "bun";
import { readPositiveIntegerConfigValue } from "../config.js";
import { resolveWorkspacePlan, type WorkspacePlanId } from "./plans.js";

// ── Public types ───────────────────────────────────────────────

export type TextQaIssueType = "typo" | "spacing" | "grammar" | "punctuation";

export interface TextQaIssue {
	/** Inclusive start index into the original text (UTF-16 code units). */
	start: number;
	/** Exclusive end index into the original text. */
	end: number;
	type: TextQaIssueType;
	/** Short human-readable explanation in the text's language. */
	message: string;
	/** Suggested replacement for [start, end). Empty string = delete. */
	suggestion: string;
}

export interface TextQaResult {
	issues: TextQaIssue[];
	/** True when this result was served from cache (no provider call, no quota). */
	cached: boolean;
	model: string;
	lang: string;
	/** Characters counted against the daily budget for this request (0 if cached). */
	charsCharged: number;
}

export interface TextQaQuotaSummary {
	usedChars: number;
	limitChars: number;
	remainingChars: number;
	resetAt: number;
	planId: string;
}

export class TextQaQuotaExceededError extends Error {
	readonly code = "text_qa_quota_exceeded";
	readonly summary: TextQaQuotaSummary;
	readonly attemptedChars: number;
	constructor(summary: TextQaQuotaSummary, attemptedChars: number) {
		super("Daily text-QA character budget exceeded");
		this.name = "TextQaQuotaExceededError";
		this.summary = summary;
		this.attemptedChars = attemptedChars;
	}
}

export class TextQaProviderError extends Error {
	readonly statusCode: number;
	readonly retryable: boolean;
	constructor(statusCode: number, message: string, retryable: boolean) {
		super(`Text-QA provider error ${statusCode}: ${message}`);
		this.name = "TextQaProviderError";
		this.statusCode = statusCode;
		this.retryable = retryable;
	}
}

// ── Supported languages (mirrors editor i18n locales) ──────────

const SUPPORTED_LANGS = ["th", "en", "ja", "ko", "zh"] as const;
export type TextQaLang = (typeof SUPPORTED_LANGS)[number];

const LANG_LABELS: Record<TextQaLang, string> = {
	th: "Thai",
	en: "English",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese",
};

export function normalizeTextQaLang(lang: string | undefined): TextQaLang {
	const value = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
	return (SUPPORTED_LANGS as readonly string[]).includes(value) ? (value as TextQaLang) : "en";
}

// ── Config ─────────────────────────────────────────────────────

const DEFAULT_FREE_DAILY_CHARS = 50_000;
const DEFAULT_MAX_TEXT_CHARS = 4_000;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const PROVIDER_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// Per-plan multiplier on the base free daily budget. Free tier already gets the
// full base budget ("free daily char quota for all tiers"); paid tiers get more
// so heavy typesetters never hit the wall. Multipliers stay generous because
// the per-char cost is negligible.
const PLAN_BUDGET_MULTIPLIER: Record<WorkspacePlanId, number> = {
	free: 1,
	creator: 4,
	pro: 12,
	studio: 40,
};

function baseFreeDailyChars(): number {
	return readPositiveIntegerConfigValue(process.env.TEXT_QA_FREE_DAILY_CHARS, DEFAULT_FREE_DAILY_CHARS);
}

function maxTextChars(): number {
	return readPositiveIntegerConfigValue(process.env.TEXT_QA_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
}

export function resolveTextQaDailyLimit(planId = process.env.WORKSPACE_PLAN_ID): number {
	const plan = resolveWorkspacePlan(planId);
	const multiplier = PLAN_BUDGET_MULTIPLIER[plan.id] ?? 1;
	return baseFreeDailyChars() * multiplier;
}

function textQaEnabled(): boolean {
	return Boolean(process.env.OPENAI_API_KEY);
}

// ── Storage abstraction (cache + daily quota counter) ──────────

export interface TextQaStore {
	getCached(key: string): Promise<TextQaIssue[] | null>;
	setCached(key: string, issues: TextQaIssue[]): Promise<void>;
	/** Atomically add `chars` to today's counter and return the new total. */
	incrementDaily(userId: string, dayKey: string, chars: number): Promise<number>;
	getDaily(userId: string, dayKey: string): Promise<number>;
}

class MemoryTextQaStore implements TextQaStore {
	private readonly cache = new Map<string, { issues: TextQaIssue[]; expiresAt: number }>();
	private readonly counters = new Map<string, number>();

	async getCached(key: string): Promise<TextQaIssue[] | null> {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}
		return entry.issues;
	}

	async setCached(key: string, issues: TextQaIssue[]): Promise<void> {
		this.cache.set(key, { issues, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
	}

	async incrementDaily(userId: string, dayKey: string, chars: number): Promise<number> {
		const counterKey = `${userId}:${dayKey}`;
		const next = (this.counters.get(counterKey) ?? 0) + chars;
		this.counters.set(counterKey, next);
		return next;
	}

	async getDaily(userId: string, dayKey: string): Promise<number> {
		return this.counters.get(`${userId}:${dayKey}`) ?? 0;
	}

	clear(): void {
		this.cache.clear();
		this.counters.clear();
	}
}

interface RedisLikeClient {
	send(command: string, args: string[]): Promise<unknown>;
}

class RedisTextQaStore implements TextQaStore {
	private readonly client: RedisLikeClient;
	private readonly keyPrefix: string;

	constructor(url: string | undefined, keyPrefix: string, client?: RedisLikeClient) {
		this.client = client ?? ((url?.trim() ? new RedisClient(url) : new RedisClient()) as unknown as RedisLikeClient);
		this.keyPrefix = keyPrefix;
	}

	async getCached(key: string): Promise<TextQaIssue[] | null> {
		const raw = await this.client.send("GET", [this.cacheKey(key)]);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(String(raw));
			return Array.isArray(parsed) ? (parsed as TextQaIssue[]) : null;
		} catch {
			return null;
		}
	}

	async setCached(key: string, issues: TextQaIssue[]): Promise<void> {
		await this.client.send("SET", [this.cacheKey(key), JSON.stringify(issues), "EX", String(CACHE_TTL_SECONDS)]);
	}

	async incrementDaily(userId: string, dayKey: string, chars: number): Promise<number> {
		const redisKey = this.counterKey(userId, dayKey);
		const total = parseRedisInteger(await this.client.send("INCRBY", [redisKey, String(chars)]));
		// Expire a little after the UTC day rolls over so counters self-clean.
		await this.client.send("EXPIRE", [redisKey, String(48 * 60 * 60)]);
		return total;
	}

	async getDaily(userId: string, dayKey: string): Promise<number> {
		const raw = await this.client.send("GET", [this.counterKey(userId, dayKey)]);
		return raw ? parseRedisInteger(raw) : 0;
	}

	private cacheKey(key: string): string {
		return `${this.keyPrefix}:cache:${key}`;
	}

	private counterKey(userId: string, dayKey: string): string {
		return `${this.keyPrefix}:quota:${userId}:${dayKey}`;
	}
}

function parseRedisInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function selectTextQaStore(): TextQaStore {
	const selected = (process.env.TEXT_QA_STORE ?? "").trim().toLowerCase();
	const redisUrl = process.env.REDIS_URL;
	const isTest = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";
	const useRedis = !isTest && (selected === "redis" || (selected !== "memory" && Boolean(redisUrl)));
	if (!useRedis) return new MemoryTextQaStore();
	return new RedisTextQaStore(redisUrl, process.env.TEXT_QA_REDIS_KEY_PREFIX || "manga-editor:text-qa");
}

let store: TextQaStore = selectTextQaStore();

/** Test hook: swap the backing store and return a restore function. */
export function setTextQaStoreForTests(next: TextQaStore): () => void {
	const previous = store;
	store = next;
	return () => {
		store = previous;
	};
}

// ── Cache key + day key ────────────────────────────────────────

function cacheKeyFor(text: string, lang: TextQaLang): string {
	return createHash("sha256").update(`${lang} ${text}`).digest("hex");
}

export function utcDayKey(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function nextUtcMidnight(now = Date.now()): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

// ── Prompt (strict: "โหด ห้ามกาก") ────────────────────────────

function buildSystemPrompt(lang: TextQaLang): string {
	const label = LANG_LABELS[lang];
	return [
		`You are a STRICT, expert proofreader for ${label} (lang code "${lang}") text used in manga / webtoon translation typesetting.`,
		"Audit the text for REAL errors only, in these categories:",
		'- "typo": misspellings, wrong/duplicated/missing characters, obvious wrong-word.',
		`- "spacing": incorrect word spacing (เว้นวรรค for Thai), missing or extra spaces, spaces in front of punctuation. For ${label}, apply that language's real spacing rules.`,
		'- "grammar": clearly wrong grammar, particle, conjugation, or agreement.',
		'- "punctuation": wrong/missing/duplicated punctuation marks.',
		"",
		"HARD RULES (be tough, but DO NOT invent problems):",
		"- Flag ONLY errors you are confident are real. Prefer FALSE NEGATIVES over FALSE POSITIVES. If unsure, do not flag.",
		"- Never flag valid stylistic choices, slang, onomatopoeia/SFX, proper nouns, names, brand names, or intentional informal speech common in comics.",
		"- Never rewrite meaning or translate. Suggestions must be minimal local fixes only.",
		"- start/end are 0-based offsets into the EXACT original text counted in UTF-16 code units (the same units JavaScript String.length and String.slice use). Count every character including spaces and newlines; a character outside the Basic Multilingual Plane (e.g. an emoji 😀) counts as 2 code units. end is exclusive and must cover only the smallest span that needs fixing.",
		'- "suggestion" is the replacement string for [start, end). Use an empty string to delete the span.',
		'- "message" is a very short reason written in ' + label + ".",
		"- Return issues sorted by start ascending, non-overlapping. If there are no real errors, return an empty list.",
	].join("\n");
}

const RESPONSE_JSON_SCHEMA = {
	name: "text_qa_issues",
	strict: true,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["issues"],
		properties: {
			issues: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["start", "end", "type", "message", "suggestion"],
					properties: {
						start: { type: "integer", minimum: 0 },
						end: { type: "integer", minimum: 0 },
						type: { type: "string", enum: ["typo", "spacing", "grammar", "punctuation"] },
						message: { type: "string" },
						suggestion: { type: "string" },
					},
				},
			},
		},
	},
} as const;

// ── Provider call ──────────────────────────────────────────────

interface ProviderCallResult {
	issues: TextQaIssue[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function callTextQaProvider(text: string, lang: TextQaLang): Promise<ProviderCallResult> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new TextQaProviderError(500, "OPENAI_API_KEY is not configured", false);

	const body = {
		model: MODEL,
		temperature: 0,
		messages: [
			{ role: "system", content: buildSystemPrompt(lang) },
			{ role: "user", content: text },
		],
		response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA },
	};

	const timeoutMs = readPositiveIntegerConfigValue(process.env.TEXT_QA_REQUEST_TIMEOUT_MS, 20_000);
	let response: Response;
	try {
		response = await fetch(PROVIDER_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		// fetch rejects (no Response) on request timeout / aborted signal / DNS or
		// connection failure. These are transient provider/network problems, so
		// surface them as retryable provider errors (502 + Retry-After) instead of
		// letting a raw DOMException fall through to the generic 500 handler.
		const isTimeout = error instanceof DOMException
			&& (error.name === "TimeoutError" || error.name === "AbortError");
		const detail = error instanceof Error ? error.message : "network error";
		throw new TextQaProviderError(
			502,
			isTimeout ? `Provider request timed out after ${timeoutMs}ms` : `Provider request failed: ${sanitize(detail)}`,
			true,
		);
	}

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		throw new TextQaProviderError(response.status, sanitize(errText), retryable);
	}

	const payload = (await response.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: ProviderCallResult["usage"];
	};
	const content = payload.choices?.[0]?.message?.content;
	if (!content) throw new TextQaProviderError(502, "Provider returned no content", true);

	let parsed: { issues?: unknown };
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new TextQaProviderError(502, "Provider returned non-JSON content", true);
	}

	return {
		issues: sanitizeIssues(parsed.issues, text.length),
		usage: payload.usage,
	};
}

function sanitize(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 300) || "request failed";
}

// Defensively validate / clamp provider output so a misbehaving model can never
// produce out-of-range offsets, overlaps, or junk types.
export function sanitizeIssues(raw: unknown, textLength: number): TextQaIssue[] {
	if (!Array.isArray(raw)) return [];
	const validTypes = new Set<TextQaIssueType>(["typo", "spacing", "grammar", "punctuation"]);
	const out: TextQaIssue[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		const start = Number(candidate.start);
		const end = Number(candidate.end);
		const type = candidate.type;
		if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
		if (start < 0 || end > textLength || start >= end) continue;
		if (typeof type !== "string" || !validTypes.has(type as TextQaIssueType)) continue;
		const message = typeof candidate.message === "string" ? candidate.message.slice(0, 200) : "";
		const suggestion = typeof candidate.suggestion === "string" ? candidate.suggestion.slice(0, 500) : "";
		out.push({ start, end, type: type as TextQaIssueType, message, suggestion });
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	// Drop overlapping issues (keep the earliest); inline underline ranges must
	// not overlap or rendering offsets break.
	const nonOverlapping: TextQaIssue[] = [];
	let lastEnd = -1;
	for (const issue of out) {
		if (issue.start < lastEnd) continue;
		nonOverlapping.push(issue);
		lastEnd = issue.end;
	}
	return nonOverlapping;
}

// ── Public API ─────────────────────────────────────────────────

export interface CheckTextQaInput {
	text: string;
	lang: string;
	/** Authenticated user id; quota is per-user. Anonymous → "anonymous". */
	userId?: string;
	planId?: string;
	now?: number;
}

export async function buildTextQaQuotaSummary(input: { userId?: string; planId?: string; now?: number } = {}): Promise<TextQaQuotaSummary> {
	const userId = (input.userId || "anonymous").trim() || "anonymous";
	const now = input.now ?? Date.now();
	const limitChars = resolveTextQaDailyLimit(input.planId);
	const usedChars = await store.getDaily(userId, utcDayKey(now));
	return {
		usedChars,
		limitChars,
		remainingChars: Math.max(0, limitChars - usedChars),
		resetAt: nextUtcMidnight(now),
		planId: resolveWorkspacePlan(input.planId).id,
	};
}

export function isTextQaConfigured(): boolean {
	return textQaEnabled();
}

export async function checkTextQa(input: CheckTextQaInput): Promise<TextQaResult> {
	const lang = normalizeTextQaLang(input.lang);
	const text = input.text;
	const now = input.now ?? Date.now();

	// Empty / whitespace-only text never has issues and never costs anything.
	if (!text.trim()) {
		return { issues: [], cached: true, model: MODEL, lang, charsCharged: 0 };
	}
	if (text.length > maxTextChars()) {
		throw new TextQaProviderError(413, `Text exceeds ${maxTextChars()} character limit`, false);
	}
	if (!textQaEnabled()) {
		throw new TextQaProviderError(503, "Text-QA is not configured (OPENAI_API_KEY missing)", false);
	}

	const cacheKey = cacheKeyFor(text, lang);
	const cached = await store.getCached(cacheKey);
	if (cached) {
		return { issues: cached, cached: true, model: MODEL, lang, charsCharged: 0 };
	}

	// Quota: charge characters BEFORE the provider call so concurrent requests
	// can't both slip past the budget. The cache hit above means identical text
	// is free, so we only charge for genuinely new checks.
	const userId = (input.userId || "anonymous").trim() || "anonymous";
	const limitChars = resolveTextQaDailyLimit(input.planId);
	const dayKey = utcDayKey(now);
	const charsToCharge = text.length;
	const newTotal = await store.incrementDaily(userId, dayKey, charsToCharge);
	if (newTotal > limitChars) {
		// Roll back the just-added characters: this request is rejected and makes
		// no provider call, so it must not consume any of the daily budget. Without
		// the refund the stored counter stays inflated and the user loses quota
		// (and summaries report usage above the limit) for failed over-limit checks.
		const usedChars = newTotal - charsToCharge;
		await store.incrementDaily(userId, dayKey, -charsToCharge);
		const summary: TextQaQuotaSummary = {
			usedChars,
			limitChars,
			remainingChars: Math.max(0, limitChars - usedChars),
			resetAt: nextUtcMidnight(now),
			planId: resolveWorkspacePlan(input.planId).id,
		};
		throw new TextQaQuotaExceededError(summary, charsToCharge);
	}

	let result: ProviderCallResult;
	try {
		result = await callTextQaProvider(text, lang);
	} catch (error) {
		// On provider failure, refund the charge — the user got no result.
		await store.incrementDaily(userId, dayKey, -charsToCharge);
		throw error;
	}

	await store.setCached(cacheKey, result.issues);

	console.log(`[text-qa] user=${userId} lang=${lang} chars=${charsToCharge} issues=${result.issues.length} tokens=${result.usage?.total_tokens ?? "?"}`);

	return {
		issues: result.issues,
		cached: false,
		model: MODEL,
		lang,
		charsCharged: charsToCharge,
	};
}
