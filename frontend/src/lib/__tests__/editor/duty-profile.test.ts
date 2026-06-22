import { describe, expect, it } from "vitest";

import { resolveDutyCapabilities, resolveDutyRoleKey } from "$lib/editor/duty-profile.ts";

const ME = { userId: "user-1", email: "Me@Example.com" };

describe("duty-profile resolution (chapter override → studio role → account role)", () => {
	it("falls back to the account role when no workspace/team context exists", () => {
		expect(resolveDutyRoleKey({ ...ME, accountRole: "editor", memberStudioRole: null, chapterTeam: null })).toBe("editor");
	});

	it("studio role wins over the account role", () => {
		expect(resolveDutyRoleKey({ ...ME, accountRole: "editor", memberStudioRole: "cleaner", chapterTeam: [] })).toBe("cleaner");
	});

	it("an ACTIVE chapter-team row overrides the studio role (matched by userId)", () => {
		expect(resolveDutyRoleKey({
			...ME,
			accountRole: "editor",
			memberStudioRole: "translator",
			chapterTeam: [{ userId: "user-1", role: "qc", status: "active" }],
		})).toBe("qc");
	});

	it("matches the chapter-team row by EMAIL case-insensitively", () => {
		expect(resolveDutyRoleKey({
			...ME,
			accountRole: "editor",
			memberStudioRole: "translator",
			chapterTeam: [{ email: "me@example.com", role: "typesetter", status: "active" }],
		})).toBe("typesetter");
	});

	it("ignores pending/removed chapter-team rows", () => {
		expect(resolveDutyRoleKey({
			...ME,
			accountRole: "editor",
			memberStudioRole: "translator",
			chapterTeam: [{ userId: "user-1", role: "qc", status: "pending" }],
		})).toBe("translator");
	});

	it("a guest override means NO duty on this chapter even for a studio translator", () => {
		const caps = resolveDutyCapabilities({
			...ME,
			accountRole: "editor",
			memberStudioRole: "translator",
			chapterTeam: [{ userId: "user-1", role: "guest", status: "active" }],
		});
		expect(caps.canTranslate).toBe(false);
		expect(caps.canClean).toBe(false);
		expect(caps.canTypeset).toBe(false);
	});

	it("cleaner duty: clean tools yes, text/translate no", () => {
		const caps = resolveDutyCapabilities({ ...ME, accountRole: "editor", memberStudioRole: "cleaner", chapterTeam: [] });
		expect(caps.canClean).toBe(true);
		expect(caps.canTypeset).toBe(false);
		expect(caps.canTranslate).toBe(false);
	});

	it("typesetter duty: text tools yes, clean no", () => {
		const caps = resolveDutyCapabilities({ ...ME, accountRole: "editor", memberStudioRole: "typesetter", chapterTeam: [] });
		expect(caps.canTypeset).toBe(true);
		expect(caps.canClean).toBe(false);
	});

	it("owner/team_lead keep the full palette", () => {
		for (const role of ["owner", "team_lead"] as const) {
			const caps = resolveDutyCapabilities({ ...ME, accountRole: "editor", memberStudioRole: role, chapterTeam: [] });
			expect(caps.canClean).toBe(true);
			expect(caps.canTypeset).toBe(true);
			expect(caps.canTranslate).toBe(true);
		}
	});

	it("anonymous resolves to no capabilities at all", () => {
		const caps = resolveDutyCapabilities({ userId: null, email: null, accountRole: null, memberStudioRole: null, chapterTeam: null });
		expect(Object.values(caps).every((flag) => flag === false)).toBe(true);
	});

	it("UNIONS series-level story-assignment roles on top of the studio role (multi-duty)", () => {
		// A member who is a workspace translator AND story-assigned as a typesetter
		// can do BOTH — the board/editor must let them claim translate and typeset.
		const caps = resolveDutyCapabilities({
			...ME, accountRole: "editor", memberStudioRole: "translator", chapterTeam: [],
			storyRoles: ["typesetter"],
		});
		expect(caps.canTranslate).toBe(true);
		expect(caps.canTypeset).toBe(true);
		expect(caps.canClean).toBe(false);
		expect(caps.canReviewQC).toBe(false);
	});

	it("a member with several story roles gets every one of those duties", () => {
		const caps = resolveDutyCapabilities({
			...ME, accountRole: "editor", memberStudioRole: "qc", chapterTeam: [],
			storyRoles: ["translator", "cleaner"],
		});
		expect(caps.canReviewQC).toBe(true); // studio role
		expect(caps.canTranslate).toBe(true); // story role
		expect(caps.canClean).toBe(true); // story role
		expect(caps.canTypeset).toBe(false);
	});

	it("a chapter-team override stays SINGLE-duty and ignores story roles (chapter > series)", () => {
		const caps = resolveDutyCapabilities({
			...ME, accountRole: "editor", memberStudioRole: "translator",
			chapterTeam: [{ userId: "user-1", role: "cleaner", status: "active" }],
			storyRoles: ["translator", "typesetter"],
		});
		expect(caps.canClean).toBe(true); // the chapter override
		expect(caps.canTranslate).toBe(false); // story roles ignored under an override
		expect(caps.canTypeset).toBe(false);
	});

	it("no story roles → unchanged single-studio-role behavior (no regression)", () => {
		const caps = resolveDutyCapabilities({ ...ME, accountRole: "editor", memberStudioRole: "translator", chapterTeam: [], storyRoles: [] });
		expect(caps.canTranslate).toBe(true);
		expect(caps.canClean).toBe(false);
		expect(caps.canTypeset).toBe(false);
		expect(caps.canReviewQC).toBe(false);
	});
});
