// Series-level duty resolution. A story_role_assignments row says "this member
// holds this duty on EVERY chapter of the story, including future ones"; this
// module resolves that claim against ONE chapter's ProjectState at read time so
// nothing ever has to be backfilled when chapters are created.
//
// Override semantics: an ACTIVE chapter-team membership (state.chapterTeam) is
// the chapter-level assignment and WINS over the series-level duty on conflict —
// including a chapter `guest` role, which yields no duty at all. A member with
// no chapter-team row falls back to their series duty (if any).

import type { ProjectState, WorkflowTaskType } from "../types/index.js";
import { getChapterTeam } from "./chapter-team.js";
import type { StoryAssignmentRole, StoryRoleAssignmentRecord } from "./workspace-access.js";

/** Map a duty role to the workflow task type it owns. `guest`/unknown → null (no duty). */
export function taskTypeForDutyRole(role: string | undefined): WorkflowTaskType | null {
	switch (role) {
		case "translator": return "translate";
		case "cleaner": return "clean";
		case "typesetter": return "typeset";
		case "qc": return "review";
		default: return null;
	}
}

/**
 * Index a member's series assignments by storyId for O(1) per-chapter
 * resolution. A member may hold SEVERAL duties on one story (multi-duty,
 * migration 0088), so each story maps to the SET of roles they hold there.
 */
export function indexStoryRolesByStoryId(assignments: readonly StoryRoleAssignmentRecord[]): Map<string, Set<StoryAssignmentRole>> {
	const byStoryId = new Map<string, Set<StoryAssignmentRole>>();
	for (const assignment of assignments) {
		const existing = byStoryId.get(assignment.storyId);
		if (existing) existing.add(assignment.role);
		else byStoryId.set(assignment.storyId, new Set([assignment.role]));
	}
	return byStoryId;
}

/**
 * The workflow task types `viewerUserId` holds duty for in THIS chapter.
 * An unassigned open task of a duty type belongs in the member's work inbox;
 * an explicit task assignee always wins over duty inference (the caller checks
 * the assignee first).
 */
export function resolveViewerDutyTaskTypes(
	state: ProjectState,
	storyRoleByStoryId: ReadonlyMap<string, ReadonlySet<StoryAssignmentRole>>,
	viewerUserId: string | undefined,
): Set<WorkflowTaskType> {
	const duties = new Set<WorkflowTaskType>();
	const userId = viewerUserId?.trim();
	if (!userId) return duties;
	// Chapter-level overrides series-level: an active chapter-team row decides
	// the member's duty here outright (guest → none), series duty is ignored.
	const chapterMember = getChapterTeam(state).find((member) => member.status === "active" && member.userId === userId);
	if (chapterMember) {
		const type = taskTypeForDutyRole(chapterMember.role);
		if (type) duties.add(type);
		return duties;
	}
	const storyId = state.storyId?.trim();
	if (storyId) {
		// Multi-duty: a member can hold several series roles on this story —
		// every one of them contributes its task type to the inbox.
		for (const role of storyRoleByStoryId.get(storyId) ?? []) {
			const type = taskTypeForDutyRole(role);
			if (type) duties.add(type);
		}
	}
	return duties;
}
