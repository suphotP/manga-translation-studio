import { describe, expect, test } from "bun:test";
import { createProjectComment, extractProjectCommentMentions, resolveCommentMentions } from "../services/comments.js";

describe("project comments", () => {
	test("extracts unique mentions from review comment bodies", () => {
		expect(extractProjectCommentMentions("Please check @reviewer and @qa-team, not email a@b.com. @reviewer")).toEqual([
			"reviewer",
			"qa-team",
		]);
	});

	test("created comments persist mention metadata", () => {
		const comment = createProjectComment({
			pageIndex: 0,
			body: "Need redraw check from @typesetter",
		});

		expect(comment.mentions).toEqual(["typesetter"]);
	});
});

describe("resolveCommentMentions (P1.6)", () => {
	const candidates = [
		{ userId: "u-alice", name: "Alice Reviewer", email: "alice@studio.com" },
		{ userId: "u-bob", name: "Bob Cleaner", email: "bobby@studio.com" },
		{ userId: "u-author", name: "Author Person", email: "author@studio.com" },
	];

	test("resolves a handle to the matching member's userId by email local-part", () => {
		expect(resolveCommentMentions({ mentions: ["alice"], candidates })).toEqual(["u-alice"]);
		// email local-part differs from name → matched by the email handle
		expect(resolveCommentMentions({ mentions: ["bobby"], candidates })).toEqual(["u-bob"]);
	});

	test("resolves a handle by first-name token (case-insensitive) and de-dupes", () => {
		expect(resolveCommentMentions({ mentions: ["Bob", "bob"], candidates })).toEqual(["u-bob"]);
	});

	test("skips the comment author (no self-notify)", () => {
		expect(resolveCommentMentions({ mentions: ["author", "alice"], candidates, authorUserId: "u-author" }))
			.toEqual(["u-alice"]);
	});

	test("ignores handles that match no workspace member (tenant-scoped: no global lookup)", () => {
		// `intruder` is not a member of this workspace's candidate list → never resolves,
		// even if such a user exists in another tenant.
		expect(resolveCommentMentions({ mentions: ["intruder", "alice"], candidates })).toEqual(["u-alice"]);
	});

	test("returns [] when there are no mentions or no candidates", () => {
		expect(resolveCommentMentions({ mentions: [], candidates })).toEqual([]);
		expect(resolveCommentMentions({ mentions: ["alice"], candidates: [] })).toEqual([]);
	});
});
