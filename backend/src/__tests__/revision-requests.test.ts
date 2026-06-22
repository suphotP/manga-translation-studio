import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	createRevisionRequest,
	describeRevisionScope,
	isRevisionOpen,
	nextRevisionNumber,
	normalizeRevisionRequests,
	resolveRevisionScope,
	updateRevisionRequest,
} from "../services/revision-requests.js";
import { FileNotificationPreferenceStore } from "../services/notification-preferences.js";
import { FileNotificationStore, NOTIFICATION_TYPES } from "../services/notifications.js";
import { notify } from "../services/notification-dispatch.js";
import type { SendResult } from "../services/mailer.js";
import type { ProjectState, RevisionRequest } from "../types/index.js";

const tempDirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "manga-revision-"));
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

describe("revision-request service", () => {
	test("createRevisionRequest defaults to 'requested', stamps number + reason, clamps pages", () => {
		const revision = createRevisionRequest({
			assignedToUserId: "  worker-1  ",
			assignedToHandle: "Worker One",
			reason: "  fix bubble placement  ",
			requestedBy: "lead@example.com",
			targetLang: "th",
			pageIndexes: [2, 2, 99, -1, 0],
			priority: "high",
		}, 1, 5);
		expect(revision.status).toBe("requested");
		expect(revision.revisionNumber).toBe(1);
		expect(revision.assignedToUserId).toBe("worker-1");
		expect(revision.reason).toBe("fix bubble placement");
		// 99 (out of range) + -1 dropped, dedup, sorted.
		expect(revision.pageIndexes).toEqual([0, 2]);
		expect(revision.priority).toBe("high");
		expect(revision.id).toBeTruthy();
	});

	test("nextRevisionNumber increments off the HIGHEST existing number (monotonic)", () => {
		expect(nextRevisionNumber([])).toBe(1);
		const r1 = createRevisionRequest({ assignedToUserId: "w", reason: "a", requestedBy: "l" }, 1, 5);
		const r2 = createRevisionRequest({ assignedToUserId: "w", reason: "b", requestedBy: "l" }, 2, 5);
		expect(nextRevisionNumber([r1, r2])).toBe(3);
		// A cancelled #2 must NOT recycle — still increments off the max.
		r2.status = "cancelled";
		expect(nextRevisionNumber([r1, r2])).toBe(3);
	});

	test("empty page indexes means whole chapter", () => {
		const revision = createRevisionRequest({ assignedToUserId: "w", reason: "x", requestedBy: "l" }, 1, 5);
		expect(revision.pageIndexes).toBeUndefined();
		expect(describeRevisionScope(revision)).toBe("whole chapter");
	});

	test("describeRevisionScope names a page + language", () => {
		const revision = createRevisionRequest({ assignedToUserId: "w", reason: "x", requestedBy: "l", pageIndexes: [3], targetLang: "ja" }, 2, 5);
		expect(describeRevisionScope(revision)).toBe("page 4 · JA");
	});

	test("updateRevisionRequest transitions status + stamps resolution on accept", () => {
		const revision = createRevisionRequest({ assignedToUserId: "w", reason: "x", requestedBy: "l" }, 1, 5);
		const progressing = updateRevisionRequest(revision, { status: "in_progress" }, 5);
		expect(progressing.status).toBe("in_progress");
		expect(progressing.resolvedAt).toBeUndefined();
		const accepted = updateRevisionRequest(progressing, { status: "accepted", resolvedBy: "lead@example.com" }, 5);
		expect(accepted.status).toBe("accepted");
		expect(accepted.resolvedAt).toBeTruthy();
		expect(accepted.resolvedBy).toBe("lead@example.com");
		expect(isRevisionOpen(accepted)).toBe(false);
		expect(isRevisionOpen(progressing)).toBe(true);
	});

	test("resolveRevisionScope: no pages = whole chapter (valid)", () => {
		expect(resolveRevisionScope(undefined, 5)).toEqual({ kind: "whole" });
		expect(resolveRevisionScope([], 5)).toEqual({ kind: "whole" });
	});

	test("resolveRevisionScope: in-range subset (deduped, sorted)", () => {
		expect(resolveRevisionScope([3, 1, 1, 0], 5)).toEqual({ kind: "pages", pageIndexes: [0, 1, 3] });
	});

	test("resolveRevisionScope: ALL out-of-range = invalid (does not widen)", () => {
		expect(resolveRevisionScope([999], 5)).toEqual({ kind: "invalid" });
		expect(resolveRevisionScope([-1, 7, 8], 5)).toEqual({ kind: "invalid" });
	});

	test("createRevisionRequest normalizes a dueAt with offset to canonical UTC ISO", () => {
		const revision = createRevisionRequest({ assignedToUserId: "w", reason: "x", requestedBy: "l", dueAt: "2026-07-01T16:00:00+07:00" }, 1, 5);
		expect(revision.dueAt).toBe("2026-07-01T09:00:00.000Z");
	});

	test("normalizeRevisionRequests drops malformed rows (no reason / number / bad status)", () => {
		const state = fakeState();
		state.revisionRequests = [
			createRevisionRequest({ assignedToUserId: "w", reason: "ok", requestedBy: "l" }, 1, 5),
			{ id: "bad", assignedToUserId: "", reason: "x", revisionNumber: 1, status: "requested" } as never,
			{ id: "bad2", assignedToUserId: "x", reason: "", revisionNumber: 1, status: "requested" } as never,
			{ id: "bad3", assignedToUserId: "x", reason: "y", revisionNumber: 2, status: "wat" } as never,
		];
		const cleaned = normalizeRevisionRequests(state);
		expect(cleaned).toHaveLength(1);
	});
});

describe("revision_requested notification taxonomy", () => {
	test("revision_requested is a known notification type", () => {
		expect((NOTIFICATION_TYPES as readonly string[]).includes("revision_requested")).toBe(true);
	});

	test("sending back fires in-app + email to the assigned worker", async () => {
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
				userId: "worker-1",
				type: "revision_requested",
				title: "lead@example.com sent work back — Revision #2",
				body: "page 12 — fix bubble placement",
				workspaceId: "ws1",
				linkUrl: "/projects/p1",
				mandatoryInApp: true,
			},
			{
				notificationStore: notifications,
				preferenceStore: preferences,
				sendEmail,
				userStore: { load: async () => ({ email: "worker@example.com", name: "Worker One" }) },
			},
		);

		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(true);
		expect(sent).toHaveLength(1);

		const page = await notifications.listForUser("worker-1");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.type).toBe("revision_requested");
		expect(page.items[0]?.body).toContain("fix bubble placement");
	});

	test("mandatoryInApp writes the notice even when the worker disabled the in_app pref", async () => {
		const dir = tmp();
		const notifications = new FileNotificationStore(join(dir, "n.json"));
		const preferences = new FileNotificationPreferenceStore(join(dir, "p.json"));
		await preferences.setMany("worker-2", [{ type: "revision_requested", channel: "in_app", enabled: false }]);

		const suppressed = await notify(
			{ userId: "worker-2", type: "revision_requested", title: "x", body: "y", workspaceId: "ws1" },
			{ notificationStore: notifications, preferenceStore: preferences, channels: ["in_app"] } as never,
		);
		expect(suppressed.inAppDelivered).toBe(false);

		const forced = await notify(
			{ userId: "worker-2", type: "revision_requested", title: "lead sent work back", body: "whole chapter — dup", workspaceId: "ws1", mandatoryInApp: true },
			{ notificationStore: notifications, preferenceStore: preferences, channels: ["in_app"] } as never,
		);
		expect(forced.inAppDelivered).toBe(true);

		const page = await notifications.listForUser("worker-2");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.type).toBe("revision_requested");
	});
});

// Type-shape sanity: RevisionRequest is wired onto ProjectState.
const _shapeCheck: RevisionRequest[] = [];
void _shapeCheck;
