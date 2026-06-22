// LEAK-SAFE (prompt class, sibling to #258/#278): the full internal AI SYSTEM
// PROMPT (the ~900-char `buildPrompt` output) must NEVER be persisted on an AI
// review marker or served over the markers API. A real-browser QA sweep found the
// whole system prompt stored on a SUCCESSFUL marker and returned over GET
// /ai-markers — exactly the leak class the owner's standing rule forbids.
//
// These tests lock the marker SERVICE boundary (the load-bearing fix): no matter
// what a caller / client passes, the internal `prompt` is dropped on create, on
// update, and scrubbed off any legacy state on normalize. The user's OWN
// instruction (`customPrompt`) is preserved — that is a legitimate product field.

import { describe, test, expect } from "bun:test";
import { v4 as uuid } from "uuid";
import type { AiReviewMarker, ProjectState } from "../types/index.js";
import {
	createAiReviewMarker,
	normalizeAiReviewMarkers,
	updateAiReviewMarker,
} from "../services/ai-review-markers.js";
import { buildPrompt } from "../prompt/builder.js";

// A realistic full system prompt — the exact thing that was leaking.
const SYSTEM_PROMPT = buildPrompt({ lang: "Thai", langCode: "th", translateSfx: true });

function baseInput(overrides: Partial<Parameters<typeof createAiReviewMarker>[0]> = {}) {
	return {
		jobId: uuid(),
		pageIndex: 0,
		imageId: "page-0.png",
		region: { x: 0, y: 0, w: 32, h: 32 },
		tier: "sfx-pro" as const,
		status: "needs_review" as const,
		...overrides,
	};
}

describe("AI review marker — internal system prompt is never persisted", () => {
	test("the full system prompt is sizeable (sanity: this is what was leaking)", () => {
		// Guards against the fixture silently degrading to a trivial string.
		expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
		expect(SYSTEM_PROMPT).toContain("Translate ALL text");
	});

	test("createAiReviewMarker DROPS the internal prompt but KEEPS the user's customPrompt", () => {
		const marker = createAiReviewMarker(baseInput({
			prompt: SYSTEM_PROMPT,
			customPrompt: "Keep the SFX punchy",
		}));

		// No `prompt` field at all on the created marker.
		expect((marker as Record<string, unknown>).prompt).toBeUndefined();
		expect("prompt" in (marker as Record<string, unknown>)).toBe(false);
		// The serialized marker carries NONE of the system-prompt text.
		expect(JSON.stringify(marker)).not.toContain("Translate ALL text");
		expect(JSON.stringify(marker)).not.toContain(SYSTEM_PROMPT);
		// The user's own instruction is preserved.
		expect(marker.customPrompt).toBe("Keep the SFX punchy");
	});

	test("updateAiReviewMarker can never write the internal prompt back onto a marker", () => {
		const marker = createAiReviewMarker(baseInput({ customPrompt: "user note" }));
		// Even a caller bypassing the type (legacy / `as any`) cannot smuggle it in.
		updateAiReviewMarker(marker, { prompt: SYSTEM_PROMPT } as never);

		expect((marker as Record<string, unknown>).prompt).toBeUndefined();
		expect(JSON.stringify(marker)).not.toContain("Translate ALL text");
		// The legitimate fields still update normally (no collateral damage).
		updateAiReviewMarker(marker, { status: "accepted", customPrompt: "edited note" });
		expect(marker.status).toBe("accepted");
		expect(marker.customPrompt).toBe("edited note");
	});

	test("normalizeAiReviewMarkers SCRUBS a legacy prompt already persisted in state.json", () => {
		// Simulate a marker persisted by the OLD code path with the system prompt baked in.
		const legacyMarker = {
			id: uuid(),
			jobId: uuid(),
			pageIndex: 0,
			imageId: "page-0.png",
			region: { x: 0, y: 0, w: 32, h: 32 },
			status: "needs_review",
			tier: "sfx-pro",
			prompt: SYSTEM_PROMPT, // the leak, persisted on disk
			customPrompt: "legacy user note",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as unknown as AiReviewMarker;
		const state = { aiReviewMarkers: [legacyMarker] } as unknown as ProjectState;

		const normalized = normalizeAiReviewMarkers(state);

		expect((normalized[0] as Record<string, unknown>).prompt).toBeUndefined();
		expect(JSON.stringify(normalized)).not.toContain("Translate ALL text");
		// customPrompt survives the scrub.
		expect(normalized[0]!.customPrompt).toBe("legacy user note");
	});
});
