import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
	GDPR_ERASED_DISPLAY_NAME,
	GDPR_ERASED_IDENTITY,
	sweepFileProjectStatePiiForErasedUser,
	sweepPostgresProjectStatePiiForErasedUser,
	type GdprSqlClient,
} from "../services/gdpr.js";
import type { ProjectState } from "../types/index.js";
import type { ProjectVersionRecord } from "../services/project-catalog.js";

const VICTIM_ID = "user-delete-me";
const VICTIM_EMAIL = "victim@example.com";
const OTHER_ID = "user-keep-me";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ONLY_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MENTION_ONLY_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function projectState(projectId = PROJECT_ID): ProjectState {
	return {
		projectId,
		userId: "owner-user",
		name: "GDPR Erasure Chapter",
		createdAt: "2026-06-01T00:00:00.000Z",
		pages: [{ imageId: "page-1.png", imageName: "page-1.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
		currentPage: 0,
		targetLang: "th",
		chapterTeam: [
			{
				id: "member-victim",
				userId: VICTIM_ID,
				email: VICTIM_EMAIL,
				displayName: "Victim Name",
				role: "translator",
				status: "active",
				invitedBy: "owner-user",
				createdAt: "2026-06-01T00:00:00.000Z",
			},
			{
				id: "member-pending-victim",
				email: "VICTIM@example.com",
				displayName: "victim@example.com",
				role: "qc",
				status: "pending",
				invitedBy: "owner-user",
				createdAt: "2026-06-01T00:01:00.000Z",
			},
			{
				id: "member-other",
				userId: OTHER_ID,
				email: "other@example.com",
				displayName: "Other User",
				role: "typesetter",
				status: "active",
				invitedBy: VICTIM_ID,
				createdAt: "2026-06-01T00:02:00.000Z",
			},
		],
		comments: [
			{ id: "comment-victim", pageIndex: 0, body: "victim note", author: VICTIM_EMAIL, status: "open", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "comment-other", pageIndex: 0, body: "other note", author: "other@example.com", mentions: [VICTIM_ID, OTHER_ID], status: "open", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		],
		activityLog: [
			{ id: "activity-victim", type: "comment_added", message: "Comment", actor: VICTIM_ID, createdAt: "2026-06-01T00:00:00.000Z" },
			{ id: "activity-other", type: "comment_added", message: "Comment", actor: OTHER_ID, createdAt: "2026-06-01T00:00:00.000Z" },
		],
		reviewDecisions: [
			{ id: "review-victim", pageIndex: 0, status: "approved", actor: VICTIM_EMAIL, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "review-other", pageIndex: 0, status: "changes_requested", actor: OTHER_ID, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		],
		reviewAssignments: [
			{
				id: "assignment-victim",
				assigneeUserId: VICTIM_ID,
				assigneeHandle: VICTIM_EMAIL,
				status: "assigned",
				assignedBy: OTHER_ID,
				createdAt: "2026-06-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
			{
				id: "assignment-victim-actor",
				assigneeUserId: OTHER_ID,
				status: "cancelled",
				assignedBy: VICTIM_ID,
				cancelledBy: VICTIM_EMAIL,
				createdAt: "2026-06-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		],
		revisionRequests: [
			{
				id: "revision-victim",
				revisionNumber: 1,
				assignedToUserId: VICTIM_ID,
				assignedToHandle: VICTIM_EMAIL,
				reason: "fix typesetting",
				requestedBy: OTHER_ID,
				status: "requested",
				createdAt: "2026-06-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		],
		tasks: [
			{ id: "task-victim", pageIndex: 0, type: "translate", title: "Translate page", assignee: VICTIM_ID, status: "todo", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "task-other", pageIndex: 0, type: "qc", title: "QC page", assignee: OTHER_ID, status: "todo", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		],
		workspaceMessages: [
			{ id: "message-victim", body: "handoff", author: VICTIM_ID, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "message-other", body: "handoff", author: OTHER_ID, mentions: [VICTIM_EMAIL], createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		],
		versionReviewRequests: [
			{ id: "version-review-victim", versionId: "v1", status: "open", requester: VICTIM_ID, reviewer: VICTIM_EMAIL, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "version-review-other", versionId: "v2", status: "open", requester: OTHER_ID, reviewer: "other@example.com", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		],
	} as unknown as ProjectState;
}

function versionRecord(): ProjectVersionRecord {
	return {
		metadata: {
			versionId: "2026-06-01T00-00-00-000Z_version",
			projectId: PROJECT_ID,
			name: "Saved Version",
			source: "save",
			author: VICTIM_EMAIL,
			createdAt: "2026-06-01T00:00:00.000Z",
			pageCount: 1,
			textLayerCount: 0,
		},
		state: projectState(PROJECT_ID),
	};
}

function writeProjectState(projectsDir: string, state: ProjectState): void {
	const projectDir = join(projectsDir, state.projectId);
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify(state));
}

function readProjectState(projectsDir: string, projectId: string): ProjectState {
	return JSON.parse(readFileSync(join(projectsDir, projectId, "state.json"), "utf8")) as ProjectState;
}

describe("GDPR project-state erasure sweep", () => {
	it("anonymizes file-mode ProjectState identity snapshots and leaves other users untouched", async () => {
		const projectsDir = mkdtempSync(join(tmpdir(), "gdpr-project-state-"));
		const state = projectState();
		writeProjectState(projectsDir, state);
		const versionsDir = join(projectsDir, PROJECT_ID, "versions");
		mkdirSync(versionsDir, { recursive: true });
		writeFileSync(join(versionsDir, "2026-06-01T00-00-00-000Z_version.json"), JSON.stringify(versionRecord()));

		const result = await sweepFileProjectStatePiiForErasedUser(VICTIM_ID, VICTIM_EMAIL, {
			projectsDir,
			syncPendingInviteIndex: false,
		});

		expect(result.projectsScanned).toBe(1);
		expect(result.projectsChanged).toBe(1);
		expect(result.versionsChanged).toBe(1);

		const scrubbed = readProjectState(projectsDir, PROJECT_ID);
		expect(scrubbed.chapterTeam?.[0]).toMatchObject({
			userId: GDPR_ERASED_IDENTITY,
			email: GDPR_ERASED_IDENTITY,
			displayName: GDPR_ERASED_DISPLAY_NAME,
		});
		expect(scrubbed.chapterTeam?.[1]).toMatchObject({
			userId: GDPR_ERASED_IDENTITY,
			email: GDPR_ERASED_IDENTITY,
			displayName: GDPR_ERASED_DISPLAY_NAME,
		});
		expect(scrubbed.chapterTeam?.[2]).toMatchObject({
			userId: OTHER_ID,
			email: "other@example.com",
			displayName: "Other User",
			invitedBy: GDPR_ERASED_IDENTITY,
		});
		expect(scrubbed.comments?.find((comment) => comment.id === "comment-victim")?.author).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.comments?.find((comment) => comment.id === "comment-other")?.author).toBe("other@example.com");
		expect(scrubbed.comments?.find((comment) => comment.id === "comment-other")?.mentions).toEqual([GDPR_ERASED_IDENTITY, OTHER_ID]);
		expect(scrubbed.activityLog?.find((event) => event.id === "activity-victim")?.actor).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.activityLog?.find((event) => event.id === "activity-other")?.actor).toBe(OTHER_ID);
		expect(scrubbed.reviewDecisions?.find((decision) => decision.id === "review-victim")?.actor).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.reviewAssignments?.find((assignment) => assignment.id === "assignment-victim")).toMatchObject({
			assigneeUserId: GDPR_ERASED_IDENTITY,
			assigneeHandle: GDPR_ERASED_IDENTITY,
			assignedBy: OTHER_ID,
		});
		expect(scrubbed.reviewAssignments?.find((assignment) => assignment.id === "assignment-victim-actor")).toMatchObject({
			assigneeUserId: OTHER_ID,
			assignedBy: GDPR_ERASED_IDENTITY,
			cancelledBy: GDPR_ERASED_IDENTITY,
		});
		expect(scrubbed.revisionRequests?.find((request) => request.id === "revision-victim")).toMatchObject({
			assignedToUserId: GDPR_ERASED_IDENTITY,
			assignedToHandle: GDPR_ERASED_IDENTITY,
			requestedBy: OTHER_ID,
		});
		expect(scrubbed.tasks?.find((task) => task.id === "task-victim")?.assignee).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.tasks?.find((task) => task.id === "task-other")?.assignee).toBe(OTHER_ID);
		expect(scrubbed.workspaceMessages?.find((message) => message.id === "message-victim")?.author).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.workspaceMessages?.find((message) => message.id === "message-other")?.mentions).toEqual([GDPR_ERASED_IDENTITY]);
		expect(scrubbed.versionReviewRequests?.find((request) => request.id === "version-review-victim")?.requester).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbed.versionReviewRequests?.find((request) => request.id === "version-review-other")?.requester).toBe(OTHER_ID);

		const scrubbedVersion = JSON.parse(
			readFileSync(join(versionsDir, "2026-06-01T00-00-00-000Z_version.json"), "utf8"),
		) as ProjectVersionRecord;
		expect(scrubbedVersion.metadata.author).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbedVersion.state.comments?.find((comment) => comment.id === "comment-victim")?.author).toBe(GDPR_ERASED_IDENTITY);
		expect(scrubbedVersion.state.comments?.find((comment) => comment.id === "comment-other")?.author).toBe("other@example.com");
	});

	it("scrubs the top-level owner id even when it is the ONLY identity in the state", async () => {
		const projectsDir = mkdtempSync(join(tmpdir(), "gdpr-owner-only-"));
		const state = {
			projectId: OWNER_ONLY_PROJECT_ID,
			userId: VICTIM_ID,
			name: "Owner Only",
			createdAt: "2026-06-01T00:00:00.000Z",
			pages: [],
			currentPage: 0,
			targetLang: "th",
		} as unknown as ProjectState;
		writeProjectState(projectsDir, state);

		const result = await sweepFileProjectStatePiiForErasedUser(VICTIM_ID, VICTIM_EMAIL, {
			projectsDir,
			syncPendingInviteIndex: false,
		});

		expect(result.projectsChanged).toBe(1);
		expect(result.ownerIds).toBe(1);
		expect(readProjectState(projectsDir, OWNER_ONLY_PROJECT_ID).userId).toBe(GDPR_ERASED_IDENTITY);
	});

	it("treats a mention-only match as a change and rewrites it", async () => {
		const projectsDir = mkdtempSync(join(tmpdir(), "gdpr-mention-only-"));
		const state = {
			projectId: MENTION_ONLY_PROJECT_ID,
			userId: "owner-user",
			name: "Mention Only",
			createdAt: "2026-06-01T00:00:00.000Z",
			pages: [],
			currentPage: 0,
			targetLang: "th",
			comments: [
				{ id: "comment-mention", pageIndex: 0, body: "ping", author: "other@example.com", mentions: [VICTIM_EMAIL], status: "open", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
			],
		} as unknown as ProjectState;
		writeProjectState(projectsDir, state);

		const result = await sweepFileProjectStatePiiForErasedUser(VICTIM_ID, VICTIM_EMAIL, {
			projectsDir,
			syncPendingInviteIndex: false,
		});

		expect(result.projectsChanged).toBe(1);
		expect(result.mentionRefs).toBe(1);
		const scrubbed = readProjectState(projectsDir, MENTION_ONLY_PROJECT_ID);
		expect(scrubbed.comments?.[0]?.mentions).toEqual([GDPR_ERASED_IDENTITY]);
	});

	it("uses the Postgres current_state JSONB path and updates derived + normalized rows", async () => {
		const queries: string[] = [];
		let updatedProjectState: ProjectState | undefined;
		let updatedVersionRecord: ProjectVersionRecord | undefined;
		const pgProject = { project_id: PROJECT_ID, current_state: projectState() };
		const pgVersion = {
			version_id: "version-1",
			project_id: PROJECT_ID,
			metadata: versionRecord().metadata,
			state: versionRecord().state,
		};
		const client: GdprSqlClient = {
			async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
				queries.push(query);
				if (query.includes("SELECT project_id, current_state")) {
					return [pgProject] as T[];
				}
				if (query.includes("SET owner_user_id")) {
					return [{ project_id: PROJECT_ID }] as T[];
				}
				if (query.includes("UPDATE projects")) {
					updatedProjectState = JSON.parse(String(params[1])) as ProjectState;
					return [] as T[];
				}
				if (query.includes("UPDATE project_tasks")) {
					return [{ task_id: "task-victim" }] as T[];
				}
				if (query.includes("UPDATE project_review_assignments")) {
					return [{ assignment_id: "assignment-victim" }, { assignment_id: "assignment-victim-actor" }] as T[];
				}
				if (query.includes("UPDATE project_revision_requests")) {
					return [{ revision_id: "revision-victim" }] as T[];
				}
				if (query.includes("UPDATE project_comments") && query.includes("SET mentions")) {
					return [{ comment_id: "comment-other" }] as T[];
				}
				if (query.includes("UPDATE project_comments")) {
					return [{ comment_id: "comment-victim" }] as T[];
				}
				if (query.includes("UPDATE project_review_decisions")) {
					return [{ review_decision_id: "review-victim" }] as T[];
				}
				if (query.includes("UPDATE project_version_reviews") && query.includes("SET mentions")) {
					return [{ version_review_id: "version-review-mention" }] as T[];
				}
				if (query.includes("UPDATE project_version_reviews")) {
					return [{ version_review_id: "version-review-victim" }] as T[];
				}
				if (query.includes("DELETE FROM project_pending_invites")) {
					return [{ member_id: "member-pending-victim" }] as T[];
				}
				if (query.includes("UPDATE project_pending_invites")) {
					return [{ member_id: "member-other" }] as T[];
				}
				if (query.includes("SELECT version_id, project_id, metadata, state")) {
					return [pgVersion] as T[];
				}
				if (query.includes("UPDATE project_versions")) {
					updatedVersionRecord = {
						metadata: JSON.parse(String(params[2])) as ProjectVersionRecord["metadata"],
						state: JSON.parse(String(params[3])) as ProjectState,
					};
					return [] as T[];
				}
				return [] as T[];
			},
		};

		const result = await sweepPostgresProjectStatePiiForErasedUser(client, VICTIM_ID, VICTIM_EMAIL);

		expect(queries.some((query) => query.includes("current_state->'chapterTeam' @>"))).toBe(true);
		expect(queries.some((query) => query.includes("author_user_id"))).toBe(true);
		expect(queries.some((query) => query.includes("actor_user_id"))).toBe(true);
		expect(queries.some((query) => query.includes("SET owner_user_id"))).toBe(true);
		expect(queries.some((query) => query.includes("UPDATE project_tasks"))).toBe(true);
		expect(queries.some((query) => query.includes("UPDATE project_review_assignments"))).toBe(true);
		expect(queries.some((query) => query.includes("UPDATE project_revision_requests"))).toBe(true);
		expect(result.projectsChanged).toBe(1);
		expect(result.projectCommentsChanged).toBe(1);
		expect(result.reviewDecisionRowsChanged).toBe(1);
		expect(result.versionReviewRowsChanged).toBe(1);
		expect(result.pendingInviteRowsDeleted).toBe(1);
		expect(result.pendingInviteRowsUpdated).toBe(1);
		expect(result.ownerRowsChanged).toBe(1);
		expect(result.taskAssigneeRowsChanged).toBe(1);
		expect(result.reviewAssignmentRowsChanged).toBe(2);
		expect(result.revisionRequestRowsChanged).toBe(1);
		expect(result.mentionRowsChanged).toBe(2);
		expect(result.versionsChanged).toBe(1);

		expect(updatedProjectState?.chapterTeam?.[0]?.userId).toBe(GDPR_ERASED_IDENTITY);
		expect(updatedProjectState?.chapterTeam?.[0]?.email).toBe(GDPR_ERASED_IDENTITY);
		expect(updatedProjectState?.chapterTeam?.[0]?.displayName).toBe(GDPR_ERASED_DISPLAY_NAME);
		expect(updatedProjectState?.comments?.find((comment) => comment.id === "comment-victim")?.author).toBe(GDPR_ERASED_IDENTITY);
		expect(updatedProjectState?.comments?.find((comment) => comment.id === "comment-other")?.author).toBe("other@example.com");
		expect(updatedVersionRecord?.metadata.author).toBe(GDPR_ERASED_IDENTITY);
		expect(updatedVersionRecord?.state.activityLog?.find((event) => event.id === "activity-victim")?.actor).toBe(GDPR_ERASED_IDENTITY);
		expect(updatedProjectState?.chapterTeam?.[2]?.userId).toBe(OTHER_ID);
	});
});
