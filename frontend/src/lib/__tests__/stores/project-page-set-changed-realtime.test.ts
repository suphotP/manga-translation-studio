import { beforeEach, describe, expect, it } from "vitest";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { realtimeStore, type RealtimeEvent } from "$lib/stores/realtime.svelte.ts";
import type { ProjectState } from "$lib/types.js";
import type { AuthUser } from "$lib/api/client.ts";

const PROJECT_ID = "project-page-set";

function authUser(id: string): AuthUser {
	return {
		id,
		email: `${id}@example.com`,
		name: id,
		role: "admin",
		emailVerified: true,
	} as AuthUser;
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: PROJECT_ID,
		workspaceId: "workspace-1",
		name: "Realtime chapter",
		createdAt: "2026-06-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		...overrides,
	};
}

function pageSetChanged(data: Record<string, unknown>): RealtimeEvent {
	return {
		id: "evt-page-set",
		kind: "page_set_changed",
		workspaceId: "workspace-1",
		emittedAt: 1_770_000_000_000,
		data,
	};
}

async function flushAsyncHandler(): Promise<void> {
	// the handler resolves authStore lazily (dynamic import) — let it settle.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function emit(event: RealtimeEvent): void {
	// @ts-expect-error reach the private dispatch for test injection
	realtimeStore.dispatch(event);
}

describe("ProjectStore page_set_changed realtime", () => {
	beforeEach(async () => {
		realtimeStore.__resetForTesting();
		projectStore.__resetForTesting();
		// Resets wipe the module-init subscription AND the wire-once guard state;
		// re-wire afterwards (the lazy import resolves the same store instances).
		(projectStore as unknown as { pageSetChangedRealtimeUnsub: null }).pageSetChangedRealtimeUnsub = null;
		await projectStore.wirePageSetChangedRealtime();
		authStore.__resetForTesting();
		authStore.__setSessionForTesting({
			user: authUser("user-me"),
			tokens: { accessToken: "access", refreshToken: "refresh" },
		});
		projectStore.__setProjectForTesting(project());
	});

	it("sets a page-set notice for another user's event on the open project", async () => {
		emit(pageSetChanged({ projectId: PROJECT_ID, changedBy: "user-other", pageCount: 3 }));
		await flushAsyncHandler();

		expect(projectStore.pageSetChangedNotice).toEqual({
			projectId: PROJECT_ID,
			changedBy: "user-other",
			pageCount: 3,
			receivedAt: 1_770_000_000_000,
		});
	});

	it("suppresses only this tab's own ECHO; another tab of the same account still sees the banner", async () => {
		// Tab that just performed its own page mutation → echo suppressed.
		(projectStore as unknown as { lastOwnPageSetMutationAt: number }).lastOwnPageSetMutationAt = Date.now();
		emit(pageSetChanged({ projectId: PROJECT_ID, changedBy: "user-me", pageCount: 2 }));
		await flushAsyncHandler();
		expect(projectStore.pageSetChangedNotice).toBeNull();

		// Same ACCOUNT, different tab (no recent own mutation here): the banner
		// MUST show — a user id is not an origin-tab id (review #594 P2).
		(projectStore as unknown as { lastOwnPageSetMutationAt: number }).lastOwnPageSetMutationAt = 0;
		emit(pageSetChanged({ projectId: PROJECT_ID, changedBy: "user-me", pageCount: 2 }));
		await flushAsyncHandler();
		expect(projectStore.pageSetChangedNotice).not.toBeNull();
	});

	it("ignores page-set events for a different project", async () => {
		emit(pageSetChanged({ projectId: "other-project", changedBy: "user-other", pageCount: 2 }));
		await flushAsyncHandler();

		expect(projectStore.pageSetChangedNotice).toBeNull();
	});

	it("falls back to the open project's page count when payload pageCount is malformed", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				{ imageId: "page-1.webp", imageName: "page-1.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
				{ imageId: "page-2.webp", imageName: "page-2.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
			],
		}));

		emit(pageSetChanged({ projectId: PROJECT_ID, changedBy: "user-other", pageCount: "two" }));
		await flushAsyncHandler();

		expect(projectStore.pageSetChangedNotice?.pageCount).toBe(2);
	});
});
