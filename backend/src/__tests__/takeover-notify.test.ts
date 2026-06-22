// #415 takeover-notify robustness: a cross-user page takeover MUST always attempt
// the mandatory in-app "editing_taken_over" notice for the displaced holder. The
// holder edits the SAME page/project as the taker, so the workspace is identical —
// when the displaced holder's stored lock row lacks a workspace_id (an older lock
// or a state-fallback acquire path), notifyDisplacedHolder falls back to the taker's
// resolved subject workspace instead of silently skipping. We only skip when no
// workspace can be resolved at all.

import { describe, expect, test } from "bun:test";
import { notifyDisplacedHolder } from "../routes/locks.js";
import type { TakenOverHolder } from "../services/work-locks.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import type { JWTPayload } from "../types/auth.js";

const taker: JWTPayload = {
	userId: "user-taker",
	email: "taker@example.com",
	role: "editor",
};

function holder(overrides: Partial<TakenOverHolder> = {}): TakenOverHolder {
	return {
		userId: "user-holder",
		scope: "page",
		scopeId: "project-1:page:0",
		projectId: "project-1",
		chapterId: "project-1",
		pageId: "project-1:page:0",
		crossUser: true,
		...overrides,
	};
}

function recordingNotify(): { calls: NotifyInput[]; fn: (input: NotifyInput) => Promise<NotifyResult> } {
	const calls: NotifyInput[] = [];
	return {
		calls,
		fn: async (input: NotifyInput): Promise<NotifyResult> => {
			calls.push(input);
			return { inAppDelivered: true, emailAttempted: false, skipped: [] };
		},
	};
}

describe("notifyDisplacedHolder (takeover notify)", () => {
	test("writes the mandatory in-app notice using the holder's own workspaceId", async () => {
		const notify = recordingNotify();
		await notifyDisplacedHolder(
			holder({ workspaceId: "ws-holder" }),
			taker,
			"ws-fallback",
			notify.fn,
		);
		expect(notify.calls).toHaveLength(1);
		const input = notify.calls[0]!;
		expect(input.type).toBe("editing_taken_over");
		expect(input.userId).toBe("user-holder");
		expect(input.workspaceId).toBe("ws-holder");
		expect(input.mandatoryInApp).toBe(true);
		// page 0 → "page 1" in the human label.
		expect(input.title).toContain("page 1");
		expect(input.metadata?.takenOverBy).toBe("user-taker");
	});

	test("falls back to the taker's subject workspace when the holder row lacks one", async () => {
		const notify = recordingNotify();
		await notifyDisplacedHolder(
			holder({ workspaceId: undefined }),
			taker,
			"ws-fallback",
			notify.fn,
		);
		// MUST NOT silently skip — the notice is still written, addressed via the
		// taker's resolved subject workspace (same page/project ⇒ same workspace).
		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]!.workspaceId).toBe("ws-fallback");
		expect(notify.calls[0]!.userId).toBe("user-holder");
	});

	test("skips only when no workspace can be resolved at all", async () => {
		const notify = recordingNotify();
		await notifyDisplacedHolder(
			holder({ workspaceId: undefined }),
			taker,
			undefined,
			notify.fn,
		);
		expect(notify.calls).toHaveLength(0);
	});

	test("skips when the holder has no userId (cannot address the per-user channel)", async () => {
		const notify = recordingNotify();
		await notifyDisplacedHolder(
			holder({ userId: "", workspaceId: "ws-holder" }),
			taker,
			"ws-fallback",
			notify.fn,
		);
		expect(notify.calls).toHaveLength(0);
	});
});
