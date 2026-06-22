import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	cancelReviewAssignment,
	createReviewAssignment,
	describeReviewAssignmentScope,
	normalizeReviewAssignments,
	resolveReviewAssignmentScope,
	updateReviewAssignment,
} from "../services/review-assignments.js";
import {
	FileNotificationPreferenceStore,
} from "../services/notification-preferences.js";
import { FileNotificationStore, NOTIFICATION_TYPES } from "../services/notifications.js";
import { notify } from "../services/notification-dispatch.js";
import type { SendResult } from "../services/mailer.js";
import type { ProjectState } from "../types/index.js";

const tempDirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "manga-review-assign-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeState(pageCount = 5): ProjectState {
	return {
		projectId: "p1",
		userId: "owner",
		name: "Chapter 1",
		createdAt: new Date().toISOString(),
		pages: Array.from({ length: pageCount }, () => ({})) as ProjectState["pages"],
		currentPage: 0,
		targetLang: "th",
	};
}

describe("review-assignment service", () => {
	test("createReviewAssignment defaults to 'assigned' and clamps page indexes", () => {
		const assignment = createReviewAssignment({
			assigneeUserId: "  reviewer-1  ",
			assigneeHandle: "Reviewer One",
			targetLang: "th",
			pageIndexes: [2, 2, 99, -1, 0],
			priority: "high",
			assignedBy: "lead@example.com",
		}, 5);
		expect(assignment.status).toBe("assigned");
		expect(assignment.assigneeUserId).toBe("reviewer-1");
		// 99 (out of range) + -1 dropped, dedup, sorted.
		expect(assignment.pageIndexes).toEqual([0, 2]);
		expect(assignment.priority).toBe("high");
		expect(assignment.id).toBeTruthy();
	});

	test("empty page indexes means whole chapter", () => {
		const assignment = createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead" }, 5);
		expect(assignment.pageIndexes).toBeUndefined();
		expect(describeReviewAssignmentScope(assignment)).toBe("whole chapter");
	});

	test("describeReviewAssignmentScope names a page + language", () => {
		const assignment = createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead", pageIndexes: [3], targetLang: "ja" }, 5);
		expect(describeReviewAssignmentScope(assignment)).toBe("page 4 · JA");
	});

	test("updateReviewAssignment transitions status", () => {
		const assignment = createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead" }, 5);
		const updated = updateReviewAssignment(assignment, { status: "in_review" }, 5);
		expect(updated.status).toBe("in_review");
		expect(updated.updatedAt >= assignment.updatedAt).toBe(true);
	});

	test("cancelReviewAssignment records a mandatory reason", () => {
		const assignment = createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead" }, 5);
		const cancelled = cancelReviewAssignment(assignment, { reason: "  duplicate work  ", cancelledBy: "lead@example.com" });
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.cancelReason).toBe("duplicate work");
		expect(cancelled.cancelledBy).toBe("lead@example.com");
		expect(cancelled.cancelledAt).toBeTruthy();
	});

	test("resolveReviewAssignmentScope: no pages = whole chapter (valid)", () => {
		expect(resolveReviewAssignmentScope(undefined, 5)).toEqual({ kind: "whole" });
		expect(resolveReviewAssignmentScope([], 5)).toEqual({ kind: "whole" });
	});

	test("resolveReviewAssignmentScope: in-range subset (deduped, sorted)", () => {
		expect(resolveReviewAssignmentScope([3, 1, 1, 0], 5)).toEqual({ kind: "pages", pageIndexes: [0, 1, 3] });
	});

	test("resolveReviewAssignmentScope: ALL out-of-range = invalid (does not widen)", () => {
		// The codex P1-3 case: a narrow scope whose pages are all out of range must
		// be reported as invalid so the route can 400 it, NOT silently widened.
		expect(resolveReviewAssignmentScope([999], 5)).toEqual({ kind: "invalid" });
		expect(resolveReviewAssignmentScope([-1, 7, 8], 5)).toEqual({ kind: "invalid" });
	});

	test("createReviewAssignment normalizes a dueAt with offset to canonical UTC ISO", () => {
		const assignment = createReviewAssignment({
			assigneeUserId: "r",
			assignedBy: "lead",
			dueAt: "2026-07-01T16:00:00+07:00",
		}, 5);
		expect(assignment.dueAt).toBe("2026-07-01T09:00:00.000Z");
	});

	test("updateReviewAssignment clears dueAt on null and normalizes on set", () => {
		const base = createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead", dueAt: "2026-07-01T09:00:00.000Z" }, 5);
		expect(updateReviewAssignment(base, { dueAt: null }, 5).dueAt).toBeUndefined();
		expect(updateReviewAssignment(base, { dueAt: "2026-08-02T12:30:00.000Z" }, 5).dueAt).toBe("2026-08-02T12:30:00.000Z");
	});

	test("normalizeReviewAssignments drops malformed rows", () => {
		const state = fakeState();
		state.reviewAssignments = [
			createReviewAssignment({ assigneeUserId: "r", assignedBy: "lead" }, 5),
			{ id: "bad", assigneeUserId: "", status: "assigned" } as never,
			{ id: "bad2", assigneeUserId: "x", status: "wat" } as never,
		];
		const cleaned = normalizeReviewAssignments(state);
		expect(cleaned).toHaveLength(1);
	});
});

describe("review_cancelled notification taxonomy", () => {
	test("review_cancelled is a known notification type", () => {
		expect((NOTIFICATION_TYPES as readonly string[]).includes("review_cancelled")).toBe(true);
	});

	test("cancelling fires in-app + email to the affected reviewer", async () => {
		const dir = tmp();
		const notifications = new FileNotificationStore(join(dir, "n.json"));
		const preferences = new FileNotificationPreferenceStore(join(dir, "p.json"));
		const sent: Array<{ template: string }> = [];
		const sendEmail = (async (template: string) => {
			sent.push({ template });
			return { success: true, provider: "null", status: "sent", messageId: "t", retryable: false } as SendResult;
		}) as never;

		const result = await notify(
			{
				userId: "reviewer-1",
				type: "review_cancelled",
				title: "lead@example.com cancelled your review",
				body: "whole chapter — duplicate work",
				workspaceId: "ws1",
				linkUrl: "/projects/p1/review",
			},
			{
				notificationStore: notifications,
				preferenceStore: preferences,
				sendEmail,
				userStore: { load: async () => ({ email: "reviewer@example.com", name: "Reviewer One" }) },
			},
		);

		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(true);
		expect(sent).toHaveLength(1);

		const page = await notifications.listForUser("reviewer-1");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.type).toBe("review_cancelled");
		expect(page.items[0]?.body).toContain("duplicate work");
	});

	test("mandatoryInApp writes the in-app notice even when the user disabled the in_app pref", async () => {
		const dir = tmp();
		const notifications = new FileNotificationStore(join(dir, "n.json"));
		const preferences = new FileNotificationPreferenceStore(join(dir, "p.json"));
		// Reviewer opted OUT of in-app review_cancelled — a normal notify would skip it.
		await preferences.setMany("reviewer-2", [{ type: "review_cancelled", channel: "in_app", enabled: false }]);

		// Sanity: without the mandatory flag the in-app row is suppressed by the pref.
		const suppressed = await notify(
			{ userId: "reviewer-2", type: "review_cancelled", title: "x", body: "y", workspaceId: "ws1" },
			{ notificationStore: notifications, preferenceStore: preferences, channels: ["in_app"] } as never,
		);
		expect(suppressed.inAppDelivered).toBe(false);

		// With mandatoryInApp the row is written REGARDLESS of the disabled pref.
		const forced = await notify(
			{ userId: "reviewer-2", type: "review_cancelled", title: "lead cancelled your review", body: "whole chapter — dup", workspaceId: "ws1", mandatoryInApp: true },
			{ notificationStore: notifications, preferenceStore: preferences, channels: ["in_app"] } as never,
		);
		expect(forced.inAppDelivered).toBe(true);

		const page = await notifications.listForUser("reviewer-2");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.type).toBe("review_cancelled");
	});
});
