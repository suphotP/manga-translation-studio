// Chapter-level team roster logic. The roster lives on ProjectState
// (`state.chapterTeam`) so it rides the existing dual file/Postgres-catalog path
// with NO new migration; this module owns the validation + mutation helpers used
// by the dedicated /projects/:id/team endpoints.
//
// Invite targeting mirrors the workspace invite model:
//   - by UID  → resolve the platform user id (the product "UID") to a real user
//               and add them as an ACTIVE member (they already have an account).
//               The inviter already knows the UID, so this is NOT email enumeration.
//   - by email→ add a PENDING member that is NEVER resolved/linked to an account at
//               send time. A pending row carries ONLY the invited email (no userId,
//               no registration-derived displayName, status always "pending"),
//               whether or not the email maps to a registered user. The invitee's
//               access + identity materialize ONLY when THEY explicitly ACCEPT (see
//               acceptChapterTeamInvite). This closes the registration-enumeration
//               oracle: a roster/activity reader can never tell a registered email
//               apart from an unregistered one until the invitee opts in.
// Removing a member never touches their work — the route layer logs an activity
// event and (for workspace projects) leaves task reassignment to the existing
// task endpoints, matching the "reassign open work before remove" affordance.

import { v4 as uuid } from "uuid";
import { z } from "zod/v4";

import type {
	ChapterTeamMember,
	ChapterTeamRole,
	ProductionMode,
	ProjectState,
} from "../types/index.js";

export const CHAPTER_TEAM_ROLES: readonly ChapterTeamRole[] = [
	"translator",
	"cleaner",
	"typesetter",
	"qc",
	"guest",
];

// Hard cap on a chapter roster so a single project's team can never grow
// unbounded (and the ProjectState JSON stays small).
export const MAX_CHAPTER_TEAM_MEMBERS = 100;

// Anti-spam cap on OUTSTANDING (pending, email-only) invites per chapter. A pending
// invite triggers an outbound email, so an attacker could otherwise use the invite
// endpoint to fan out mail. Active members + accepted invites don't count toward this.
export const MAX_PENDING_CHAPTER_TEAM_INVITES = 50;

export class ChapterTeamError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(message: string, code: string, status = 400) {
		super(message);
		this.name = "ChapterTeamError";
		this.code = code;
		this.status = status;
	}
}

const chapterTeamRoleSchema = z.enum(["translator", "cleaner", "typesetter", "qc", "guest"]);

// Add a single member by UID or email. Exactly one targeting field is required;
// when a UID is supplied the route resolves it to a real user before persisting.
export const chapterTeamInviteSchema = z
	.object({
		userId: z.string().trim().min(1).max(200).optional(),
		email: z.string().trim().email().max(320).optional(),
		displayName: z.string().trim().min(1).max(200).optional(),
		role: chapterTeamRoleSchema.default("translator"),
	})
	.strict()
	.refine((value) => Boolean(value.userId) || Boolean(value.email), {
		message: "An invite needs a userId (UID) or an email",
		path: ["userId"],
	});

// PATCH the chapter team: switch production mode and/or update/remove a member's
// role. `removeUserId` removes a member (matched by userId or membership id).
export const chapterTeamPatchSchema = z
	.object({
		productionMode: z.enum(["solo", "team"]).optional(),
		updateMemberId: z.string().trim().min(1).max(200).optional(),
		role: chapterTeamRoleSchema.optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.productionMode !== undefined ||
			(value.updateMemberId !== undefined && value.role !== undefined),
		{ message: "Expected productionMode, or updateMemberId + role" },
	);

export interface ChapterTeamInviteInput {
	userId?: string;
	email?: string;
	displayName?: string;
	role: ChapterTeamRole;
}

export function getChapterTeam(state: ProjectState): ChapterTeamMember[] {
	return Array.isArray(state.chapterTeam) ? state.chapterTeam : [];
}

export function getProductionMode(state: ProjectState): ProductionMode {
	return state.productionMode === "team" ? "team" : "solo";
}

/**
 * True when this person is already on the roster. Matches on resolved UID OR a
 * (pending) email so re-inviting the same person is rejected on either target.
 */
function findExistingMember(
	team: ChapterTeamMember[],
	target: { userId?: string; email?: string },
): ChapterTeamMember | undefined {
	const email = target.email?.trim().toLowerCase();
	return team.find((member) => {
		if (target.userId && member.userId && member.userId === target.userId) return true;
		if (email && member.email && member.email.toLowerCase() === email) return true;
		return false;
	});
}

/**
 * Build a new roster member. `resolved` carries the fields resolved by the route
 * (e.g. a real userId/email/name for a UID invite). Throws a ChapterTeamError when
 * the person is already on the roster or the roster is full.
 */
export function buildChapterTeamMember(
	team: ChapterTeamMember[],
	input: ChapterTeamInviteInput,
	resolved: { userId?: string; email?: string; displayName?: string; status: ChapterTeamMember["status"] },
	invitedBy: string | undefined,
): ChapterTeamMember {
	const target = { userId: resolved.userId ?? input.userId, email: resolved.email ?? input.email };
	if (findExistingMember(team, target)) {
		throw new ChapterTeamError("That person is already on the chapter team", "chapter_team_member_exists", 409);
	}
	if (team.length >= MAX_CHAPTER_TEAM_MEMBERS) {
		throw new ChapterTeamError("Chapter team is full", "chapter_team_full", 409);
	}
	// Anti-spam: cap OUTSTANDING pending invites (each one emails a not-yet-registered
	// address). A new pending invite over the cap is rejected; active members are exempt.
	if (resolved.status === "pending") {
		const pendingCount = team.reduce((count, member) => count + (member.status === "pending" ? 1 : 0), 0);
		if (pendingCount >= MAX_PENDING_CHAPTER_TEAM_INVITES) {
			throw new ChapterTeamError("Too many pending invites for this chapter", "chapter_team_pending_invite_limit", 429);
		}
	}
	return {
		id: uuid(),
		userId: target.userId,
		email: target.email?.trim().toLowerCase(),
		displayName: resolved.displayName ?? input.displayName,
		role: input.role,
		status: resolved.status,
		invitedBy,
		createdAt: new Date().toISOString(),
	};
}

/** Find a member by membership id OR by resolved userId. */
export function resolveTeamMember(team: ChapterTeamMember[], idOrUserId: string): ChapterTeamMember | undefined {
	const needle = idOrUserId.trim();
	return team.find((member) => member.id === needle || member.userId === needle);
}

/**
 * True when `userId` is an ACTIVE chapter-team member of this project. Pending
 * (email-only, not-yet-resolved) invites are NOT active and grant no access. Used
 * by the project read/update access checks so an active team member can load+work
 * the chapter, mirroring the workspace membership model but scoped to one project.
 */
export function isActiveChapterTeamMember(state: ProjectState, userId: string | undefined): boolean {
	const id = userId?.trim();
	if (!id) return false;
	return getChapterTeam(state).some(
		(member) => member.status === "active" && member.userId === id,
	);
}

/**
 * Accept the FIRST matching PENDING email invite on this team for the accepting
 * user (matched by their verified email), linking it to their real userId and
 * flipping it ACTIVE. This is the ONLY place an email invite is resolved to an
 * account — at send time a pending email row is intentionally never linked, so the
 * roster/activity cannot leak whether the email maps to a registered user. Returns
 * the updated team + the now-active member, or null when there is no pending invite
 * for this email (so the caller can 404 without revealing roster contents).
 */
export function acceptChapterTeamInvite(
	state: ProjectState,
	acceptor: { userId: string; email: string; displayName?: string },
): { team: ChapterTeamMember[]; member: ChapterTeamMember } | null {
	const userId = acceptor.userId.trim();
	const email = acceptor.email.trim().toLowerCase();
	if (!userId || !email) return null;
	const team = getChapterTeam(state);
	// Already an active member (e.g. invited by UID or a prior accept) → nothing to do.
	const alreadyActive = team.find((member) => member.status === "active" && member.userId === userId);
	if (alreadyActive) return { team, member: alreadyActive };
	const index = team.findIndex(
		(member) => member.status === "pending" && !member.userId && member.email?.toLowerCase() === email,
	);
	if (index < 0) return null;
	const accepted: ChapterTeamMember = {
		...team[index]!,
		userId,
		// Keep the invited email; adopt the accepting user's display name (best-effort).
		displayName: acceptor.displayName ?? team[index]!.displayName,
		status: "active",
	};
	const nextTeam = [...team];
	nextTeam[index] = accepted;
	return { team: nextTeam, member: accepted };
}
