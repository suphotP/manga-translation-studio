import { describe, expect, it } from "vitest";
import {
	AI_PROVIDER_GENERIC_ERROR,
	aiErrorCopy,
	aiErrorDetailLeaksInternal,
	formatAiAutoApplyFailed,
	formatAiCancelBackendFailed,
	formatAiCancelledStatus,
	formatAiCoverSelectionRequired,
	formatAiJobProviderFailure,
	formatAiJobStartFailure,
	formatAiProviderStartFailure,
	formatAiMarkerCreatePending,
	formatAiMarkerRerunNoProject,
	formatAiMarkerRerunPageMissing,
	formatAiMarkerRerunQueued,
	formatAiMarkerRerunRegionTooSmall,
	formatAiMarkerRerunStaleImage,
	formatAiMarkerRerunWrongPage,
	formatAiMissingResultFailure,
	formatAiNeedsReviewStatus,
	formatAiStatusFailed,
	formatAiStatusRetry,
	formatAiStatusRetryDetail,
	redactAiSecrets,
	sanitizeAiErrorDetail,
	sanitizeAiMarkerError,
} from "$lib/project/ai-job-copy.js";

describe("AI job copy", () => {
	it("formats provider start and failure states as recovery copy", () => {
		// "provider disabled" carries the "provider" keyword → friendly retry copy.
		expect(formatAiJobStartFailure(new Error("provider disabled"))).toBe("สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");
		// formatAiJobStartFailure wraps OUR OWN pre-submit app errors (a failed
		// save / invalid selection) — these are safe to show, so an uncategorised
		// secret-free start error shows its detail.
		expect(formatAiJobStartFailure(new Error("selection too small"))).toBe("AI ยังไม่เริ่ม: selection too small");
		// formatAiJobProviderFailure is ALLOWLIST-only (provider text feeds
		// job.error): known categories map to friendly copy …
		expect(formatAiJobProviderFailure("quota exceeded")).toBe("AI ยังรันไม่ได้: เครดิตหรือโควตาไม่พอ");
		expect(formatAiJobProviderFailure("image cleanup provider returned 503")).toBe("สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");
		// … and ANYTHING unrecognised collapses to the single generic fallback
		// (NOT the raw provider text). This is the allowlist flip.
		expect(formatAiJobProviderFailure("foobar gibberish detail")).toBe(AI_PROVIDER_GENERIC_ERROR);
		expect(formatAiJobProviderFailure(new Error("something weird happened"))).toBe(AI_PROVIDER_GENERIC_ERROR);
		// The dedicated provider start-failure formatter is allowlist-only too.
		expect(formatAiProviderStartFailure(new Error("unexpected upstream blob"))).toBe(AI_PROVIDER_GENERIC_ERROR);
		expect(formatAiProviderStartFailure("provider returned 502")).toBe("สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");
		expect(formatAiMissingResultFailure()).toBe("AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์");
	});

	it("NEVER leaks an API key or prompt in user-facing AI error copy", () => {
		// Simulate the real OpenAI 401 body that previously surfaced the key.
		const leak = new Error(
			"OpenAI image edit error 401 (invalid_api_key): Incorrect API key provided: sk-proj-abc123DEF456ghi789jkl2VAA. You can find your API key at https://platform.openai.com.",
		);
		const startMsg = formatAiJobStartFailure(leak);
		const providerMsg = formatAiJobProviderFailure(leak);
		for (const msg of [startMsg, providerMsg]) {
			expect(msg).not.toContain("sk-");
			expect(msg).not.toContain("Incorrect API key");
			expect(msg).not.toContain("invalid_api_key");
		}
		// 401/auth maps to the friendly "key not configured" line.
		expect(startMsg).toContain("ตั้งค่าคีย์ไม่ถูกต้อง");
		expect(providerMsg).toContain("ตั้งค่าคีย์ไม่ถูกต้อง");

		// A prompt-bearing failure must not echo the prompt text. With the
		// allowlist, an unrecognised prompt dump collapses to the generic message.
		const promptLeak = new Error("Failed. System prompt: You are a manga translator. Translate this dialogue to Thai: ...");
		const promptMsg = formatAiJobProviderFailure(promptLeak);
		expect(promptMsg).not.toContain("You are a");
		expect(promptMsg).not.toContain("Translate this");
		expect(promptMsg).not.toContain("System prompt");
		expect(promptMsg).toBe(AI_PROVIDER_GENERIC_ERROR);
	});

	it("ALLOWLIST: arbitrary/unrecognised provider text NEVER renders verbatim (provider/marker paths)", () => {
		// The whole point of the allowlist flip: instead of chasing leak SHAPES in
		// a denylist, EVERY provider/marker error maps to a known friendly CATEGORY
		// message OR the single generic fallback — and NONE echoes the raw input.
		// These role-dumps / prompt dumps / key bodies previously slipped through.
		const leakInputs = [
			"User: Render the speech bubble faithfully",
			"Assistant: Clean the panel and keep the lettering",
			"System: You are a professional manhwa translator",
			"Prompt: Describe the scene then output a cleaned image",
			"Input prompt: <full prompt body here>",
			"Incorrect API key provided: sk-proj-ABCdef0123456789ghijkl2VAA",
			"Authorization: Bearer sk-or-v1-secrettokenvalue123456",
			'{"prompt":"you are a translator","key":"sk-proj-xyz"}',
			"foobar gibberish",
			"provider returned 503",
			"some totally unexpected upstream payload nobody enumerated",
		];
		// Every allowed output is one of the fixed category messages or the generic.
		const ALLOWED_OUTPUTS = new Set<string>([
			"บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ",
			"AI ยังรันไม่ได้: เครดิตหรือโควตาไม่พอ",
			"ภาพหรือคำสั่งนี้ติดการตรวจเนื้อหา ปรับแล้วลองใหม่อีกครั้ง",
			"AI กำลังถูกใช้งานหนาแน่น รอสักครู่แล้วลองใหม่อีกครั้ง",
			"สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง",
			AI_PROVIDER_GENERIC_ERROR,
		]);
		// Substrings that prove a verbatim passthrough — none may appear in output.
		const FORBIDDEN_FRAGMENTS = [
			"sk-",
			"Bearer",
			"User:",
			"Assistant:",
			"System:",
			"Prompt:",
			"Input prompt",
			"Incorrect API key",
			"Render the speech bubble",
			"Clean the panel",
			"professional manhwa translator",
			"Describe the scene",
			"full prompt body",
			"you are a translator",
			"foobar",
			"upstream payload",
		];
		for (const input of leakInputs) {
			// Funnel through EVERY provider/marker display path.
			const outputs = [
				formatAiJobProviderFailure(input),
				formatAiProviderStartFailure(input),
				sanitizeAiMarkerError(input),
				aiErrorCopy(input),
				formatAiNeedsReviewStatus(input),
			];
			for (const out of outputs) {
				// (1) Output is always an allowed category/generic message.
				expect(ALLOWED_OUTPUTS.has(out), `unexpected output "${out}" for input "${input}"`).toBe(true);
				// (2) Output never contains a verbatim fragment of the raw input.
				for (const fragment of FORBIDDEN_FRAGMENTS) {
					expect(out, `leaked "${fragment}" for input "${input}"`).not.toContain(fragment);
				}
			}
		}

		// Known categories are still mapped (belt-and-suspenders on the allowlist).
		expect(sanitizeAiMarkerError("Incorrect API key provided: sk-proj-leak")).toBe(
			"บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ",
		);
		expect(aiErrorCopy("quota exceeded")).toBe("AI ยังรันไม่ได้: เครดิตหรือโควตาไม่พอ");
		expect(formatAiJobProviderFailure("rate limit hit (429)")).toBe(
			"AI กำลังถูกใช้งานหนาแน่น รอสักครู่แล้วลองใหม่อีกครั้ง",
		);
		expect(formatAiNeedsReviewStatus("content_policy violation")).toBe(
			"ภาพหรือคำสั่งนี้ติดการตรวจเนื้อหา ปรับแล้วลองใหม่อีกครั้ง",
		);
		// Empty inputs keep their friendly empty fallbacks (NOT the generic error).
		expect(formatAiNeedsReviewStatus(undefined)).toBe("คำสั่งนี้ต้องตรวจเนื้อหาก่อนรัน AI");
		expect(sanitizeAiMarkerError("")).toBe("");
		expect(aiErrorCopy(undefined)).toBe("รัน AI ไม่สำเร็จ เพิ่มโน้ตแก้หรือขอรันใหม่");
	});

	it("detects + redacts secret-shaped detail", () => {
		expect(aiErrorDetailLeaksInternal("Incorrect API key provided: sk-proj-xyz")).toBe(true);
		expect(aiErrorDetailLeaksInternal("Authorization: Bearer abcdef123456")).toBe(true);
		expect(aiErrorDetailLeaksInternal("provider returned 503")).toBe(false);
		expect(redactAiSecrets("key is sk-proj-abc123def456")).not.toContain("sk-proj");
		// A safe detail is shown verbatim (scrubbed + capped); a leaky one is dropped.
		expect(sanitizeAiErrorDetail("provider returned 503", "fallback")).toBe("provider returned 503");
		expect(sanitizeAiErrorDetail("api key sk-proj-leak", "fallback")).toBe("fallback");
	});

	it("detects GENERIC prompt-dump shapes the keyword markers miss", () => {
		// Codex P1: a provider/backend error shaped like `Prompt: <body>` or
		// `Input prompt: <body>` carries the full prompt but matches none of the
		// keyword markers ("system prompt"/"you are a"/"translate this"). These
		// must be flagged as leaky so they're never rendered verbatim.
		expect(aiErrorDetailLeaksInternal("Prompt: Render the speech bubble faithfully and keep tone.")).toBe(true);
		expect(aiErrorDetailLeaksInternal("Input prompt: Describe the scene then output JSON.")).toBe(true);
		expect(aiErrorDetailLeaksInternal("Full prompt: produce a clean panel")).toBe(true);
		expect(aiErrorDetailLeaksInternal("Request prompt: do the thing")).toBe(true);
		expect(aiErrorDetailLeaksInternal("System: You are a manga translator")).toBe(true);
		expect(aiErrorDetailLeaksInternal("provider error. Prompt: dump here")).toBe(true);
		// Do NOT over-mask harmless short messages that merely mention "prompt":
		expect(aiErrorDetailLeaksInternal("Prompt was too long, please shorten")).toBe(false);
		expect(aiErrorDetailLeaksInternal("your prompt was rejected")).toBe(false);
		expect(aiErrorDetailLeaksInternal("prompt")).toBe(false);
		expect(aiErrorDetailLeaksInternal("provider returned 503")).toBe(false);
	});

	it("sanitizes a STORED marker error before display", () => {
		expect(sanitizeAiMarkerError(undefined)).toBe("");
		expect(sanitizeAiMarkerError("")).toBe("");
		expect(sanitizeAiMarkerError("provider returned 503")).toBe("สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");
		const leaked = sanitizeAiMarkerError("Incorrect API key provided: sk-proj-leak2VAA");
		expect(leaked).not.toContain("sk-");
		expect(leaked).toContain("ตั้งค่าคีย์ไม่ถูกต้อง");
	});

	it("aiErrorCopy sanitizes a persisted marker error (re-leak guard)", () => {
		// Regression: an OLD local aiErrorCopy() only filtered strings matching
		// provider|failed|error|... so the real OpenAI 401 body
		// ("Incorrect API key provided: sk-proj-…") fell through and re-leaked the
		// key after a reload. aiErrorCopy now funnels through the
		// strong sanitizer so the raw key/prompt can NEVER reach the DOM.
		const leaked = aiErrorCopy(
			"Incorrect API key provided: sk-proj-ABCDEFghijkl0123456789mnop2VAA. You can find your API key at https://platform.openai.com.",
		);
		expect(leaked).not.toContain("sk-");
		expect(leaked.toLowerCase()).not.toContain("api key");
		expect(leaked.toLowerCase()).not.toContain("incorrect api key");
		// Auth/key misconfig maps to the friendly admin-facing line.
		expect(leaked).toContain("ตั้งค่าคีย์ไม่ถูกต้อง");

		// Empty / whitespace input falls back to the friendly recovery line.
		expect(aiErrorCopy(undefined)).toBe("รัน AI ไม่สำเร็จ เพิ่มโน้ตแก้หรือขอรันใหม่");
		expect(aiErrorCopy("   ")).toBe("รัน AI ไม่สำเร็จ เพิ่มโน้ตแก้หรือขอรันใหม่");

		// A known provider failure still becomes friendly copy.
		expect(aiErrorCopy("provider returned 503")).toBe("สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");

		// A prompt-bearing failure must not echo the prompt text.
		const promptLeak = aiErrorCopy("System prompt: You are a manga translator. Translate this dialogue: ...");
		expect(promptLeak).not.toContain("You are a");
		expect(promptLeak).not.toContain("Translate this");
		expect(promptLeak).not.toContain("System prompt");
	});

	it("aiErrorCopy drops GENERIC prompt-dump shapes the keyword markers miss (Codex P1)", () => {
		// A persisted marker.error shaped like `Prompt: <full prompt>` does NOT
		// hit any keyword marker, so the old path rendered the full prompt body
		// verbatim. It must now collapse to the friendly generic recovery line.
		const promptDump = aiErrorCopy(
			"Prompt: You are a professional manhwa translator. TASK: translate every speech bubble to Thai and keep honorifics.",
		);
		expect(promptDump).not.toContain("You are a");
		expect(promptDump).not.toContain("professional manhwa translator");
		expect(promptDump).not.toContain("TASK:");
		expect(promptDump).not.toContain("Prompt:");
		// Detected as a leak → friendly generic message, NOT the prompt body.
		expect(promptDump).toBe("เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)");

		const inputPromptDump = aiErrorCopy("Input prompt: <Describe the panel then output a cleaned image>");
		expect(inputPromptDump).not.toContain("Describe the panel");
		expect(inputPromptDump).not.toContain("Input prompt");
		expect(inputPromptDump).toBe("เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)");

		// ALLOWLIST: we no longer try to decide whether a message is "harmless"
		// enough to show verbatim. ANY unrecognised provider text — even a benign
		// "Prompt was too long" — collapses to the generic message. There is no
		// over-masking trade-off anymore because no raw provider text ever renders.
		expect(aiErrorCopy("Prompt was too long, please shorten")).toBe("เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)");
	});

	it("formats needs_review without leaking", () => {
		expect(formatAiNeedsReviewStatus(undefined)).toBe("คำสั่งนี้ต้องตรวจเนื้อหาก่อนรัน AI");
		expect(formatAiNeedsReviewStatus("Prompt flagged: sk-proj-leak")).not.toContain("sk-");
	});

	it("formats polling, cancellation, and auto-apply failures", () => {
		expect(formatAiStatusRetry(2, 3)).toBe("เช็กสถานะ AI สะดุด กำลังลองใหม่ 2/3");
		expect(formatAiStatusRetryDetail(new Error("network down"), 2, 3)).toBe("เช็กสถานะ AI สะดุด (2/3): network down");
		expect(formatAiStatusFailed(new Error("network down"))).toBe("เช็กสถานะ AI ไม่สำเร็จ: network down");
		expect(formatAiCancelledStatus("user cancelled")).toBe("AI ถูกยกเลิก: user cancelled");
		expect(formatAiCancelBackendFailed(new Error("timeout"))).toBe("ยกเลิก AI ฝั่ง backend ไม่สำเร็จ: timeout");
		expect(formatAiAutoApplyFailed(new Error("image missing"))).toBe("AI สร้างรูปแล้ว แต่ใส่ลงหน้าไม่สำเร็จ: image missing");
		expect(formatAiMarkerCreatePending()).toBe("AI กำลังทำงาน แต่ยังสร้างรายการผล AI ไม่สำเร็จ");
	});

	it("formats AI selection and marker rerun recovery states", () => {
		expect(formatAiCoverSelectionRequired()).toBe("ลาก selection ด้วยเครื่องมือ AI Cover ก่อนรัน");
		expect(formatAiMarkerRerunNoProject()).toBe("เปิดงานก่อนรันผล AI อีกครั้ง");
		expect(formatAiMarkerRerunPageMissing(3)).toBe("ไม่พบหน้า 3 สำหรับรัน AI อีกครั้ง");
		expect(formatAiMarkerRerunStaleImage()).toBe("ผล AI นี้ผูกกับรูปเวอร์ชันเก่า; เปิดรูปหน้าที่ตรงกันหรือรันพื้นที่ใหม่อีกครั้ง");
		expect(formatAiMarkerRerunWrongPage(2)).toBe("เปิดหน้า 2 ก่อนรันผล AI นี้อีกครั้ง");
		expect(formatAiMarkerRerunRegionTooSmall()).toBe("พื้นที่ผล AI เล็กเกินไปสำหรับรันอีกครั้ง");
		expect(formatAiMarkerRerunQueued(1)).toBe("ส่งคำขอรัน AI หน้า 1 เข้าคิวแล้ว");
	});
});
