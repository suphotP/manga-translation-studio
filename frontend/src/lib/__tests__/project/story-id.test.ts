import { describe, expect, it } from "vitest";
import {
	buildStorySlug,
	buildStoryTitleKey,
	findStoryGroupByTitleKey,
	generateStableStoryId,
	storyGroupKeyMatches,
	storyIdCollidesWith,
	storyIdFromTitleKey,
} from "$lib/project/story-id.js";

describe("stable story id helpers", () => {
	it("mints dash-free, URL-safe ids that do not collide", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 200; i += 1) {
			const id = generateStableStoryId();
			expect(id).toMatch(/^[0-9a-z]+$/);
			expect(id).not.toContain("-");
			ids.add(id);
		}
		// 200 random 10-char base36 ids should be unique in practice.
		expect(ids.size).toBe(200);
	});

	it("builds a hybrid <id>-<slug> segment with a cosmetic slug", () => {
		expect(buildStoryTitleKey("ab12cd34ef", "Glass Harbor")).toBe("ab12cd34ef-glass-harbor");
		// Id alone is valid when there is no title yet.
		expect(buildStoryTitleKey("ab12cd34ef", "")).toBe("ab12cd34ef");
		expect(buildStoryTitleKey("ab12cd34ef")).toBe("ab12cd34ef");
		// Legacy slug ids (already dashed) pass through unchanged so their URLs stay byte-identical.
		expect(buildStoryTitleKey("glass-harbor", "Glass Harbor")).toBe("glass-harbor");
	});

	it("extracts the stable id as the leading dash-free token", () => {
		expect(storyIdFromTitleKey("ab12cd34ef-glass-harbor")).toBe("ab12cd34ef");
		expect(storyIdFromTitleKey("ab12cd34ef")).toBe("ab12cd34ef");
		// Legacy slug id has no separate slug; its leading token is the slug head.
		expect(storyIdFromTitleKey("glass-harbor")).toBe("glass");
	});

	it("preserves a cosmetic slug for Thai and mixed titles", () => {
		expect(buildStorySlug("Moonlit Courier")).toBe("moonlit-courier");
		expect(buildStorySlug("เรื่องทดสอบ 12")).toBe("เรื่องทดสอบ-12");
		expect(buildStorySlug("   ")).toBe("");
	});

	it("matches a group by stable id with legacy full-segment fallback", () => {
		// New stable id: matches via the leading token, ignoring the cosmetic slug.
		expect(storyGroupKeyMatches("ab12cd34ef", "ab12cd34ef-glass-harbor")).toBe(true);
		// Same id, renamed slug — still resolves (rename-robust).
		expect(storyGroupKeyMatches("ab12cd34ef", "ab12cd34ef-new-name")).toBe(true);
		// Id alone resolves.
		expect(storyGroupKeyMatches("ab12cd34ef", "ab12cd34ef")).toBe(true);
		// Legacy slug-based id: the WHOLE segment must match the stored id.
		expect(storyGroupKeyMatches("glass-harbor", "glass-harbor")).toBe(true);
		// A different stable id must not collide.
		expect(storyGroupKeyMatches("zz99zz99zz", "ab12cd34ef-glass-harbor")).toBe(false);
		// A legacy id must not be matched merely by its leading token from a foreign segment.
		expect(storyGroupKeyMatches("glass-harbor", "glass")).toBe(false);
	});
});

describe("deterministic story resolution (findStoryGroupByTitleKey)", () => {
	const make = (storyId: string) => ({ storyId });

	it("resolves a new story by its leading token, ignoring the cosmetic slug", () => {
		const groups = [make("ab12cd34ef")];
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef-glass-harbor")?.storyId).toBe("ab12cd34ef");
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef-renamed")?.storyId).toBe("ab12cd34ef");
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef")?.storyId).toBe("ab12cd34ef");
	});

	it("returns undefined for a blank or unknown key", () => {
		const groups = [make("ab12cd34ef")];
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "")).toBeUndefined();
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, null)).toBeUndefined();
		expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "zz99zz99zz-other")).toBeUndefined();
	});

	it("the P1 collision case is order-INDEPENDENT: exact legacy match wins, new id stays reachable", () => {
		// A new dash-free id equals the LEADING TOKEN of a legacy dashed slug id.
		const legacy = make("ab12cd34ef-old"); // legacy slug-based id (dashed)
		const fresh = make("ab12cd34ef"); // new stable id whose token == legacy's leading token
		// Try BOTH group orders — resolution must not depend on .find() order.
		for (const groups of [[legacy, fresh], [fresh, legacy]]) {
			// The legacy story's full segment resolves to the LEGACY story (exact wins).
			expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef-old")?.storyId).toBe("ab12cd34ef-old");
			// The new story stays reachable via its bare id (exact) ...
			expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef")?.storyId).toBe("ab12cd34ef");
			// ... and via its own cosmetic slug (leading-token), never hijacked by the legacy story.
			expect(findStoryGroupByTitleKey(groups, (g) => g.storyId, "ab12cd34ef-new-name")?.storyId).toBe("ab12cd34ef");
		}
	});

	it("flags and avoids minting an id that collides with a known story id or legacy leading token", () => {
		expect(storyIdCollidesWith("ab12cd34ef", "ab12cd34ef")).toBe(true); // identical
		expect(storyIdCollidesWith("ab12cd34ef", "ab12cd34ef-old")).toBe(true); // == legacy leading token
		expect(storyIdCollidesWith("ab12cd34ef", "zz99zz99zz-old")).toBe(false); // unrelated
		expect(storyIdCollidesWith("", "ab12cd34ef")).toBe(false);
		// The guarded mint never returns an id colliding with the provided known set.
		const known = Array.from({ length: 50 }, () => generateStableStoryId());
		for (let i = 0; i < 100; i += 1) {
			const minted = generateStableStoryId(known);
			expect(known.some((id) => storyIdCollidesWith(minted, id))).toBe(false);
		}
	});
});
