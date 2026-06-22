import { v4 as uuid } from "uuid";
import type { ProjectComment, ProjectState, ReviewAnnotation } from "../types/index.js";

export const MAX_PROJECT_COMMENTS = 500;
export const MAX_PROJECT_COMMENT_MENTIONS = 20;

/** Like {@link normalizeProjectComments} but returns TRUE iff it changed `state.comments`.
 *  Compares only the (capped, small) comments array before/after — equivalent to a whole-state
 *  hash diff for this normalizer, without stringify+hashing the multi-MB project. */
export function normalizeProjectCommentsChanged(state: ProjectState): boolean {
	const prev = JSON.stringify(state.comments);
	const comments = Array.isArray(state.comments) ? state.comments : [];
	state.comments = comments.slice(0, MAX_PROJECT_COMMENTS).map((comment) => ({
		...comment,
		mentions: Array.isArray(comment.mentions)
			? comment.mentions.slice(0, MAX_PROJECT_COMMENT_MENTIONS)
			: extractProjectCommentMentions(comment.body),
	}));
	return JSON.stringify(state.comments) !== prev;
}

export function normalizeProjectComments(state: ProjectState): ProjectComment[] {
	normalizeProjectCommentsChanged(state);
	return state.comments;
}

export function extractProjectCommentMentions(body: string): string[] {
	const mentions: string[] = [];
	const seen = new Set<string>();
	const mentionPattern = /(^|[^\p{L}\p{N}._-])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,31})/gu;
	for (const match of body.matchAll(mentionPattern)) {
		const mention = match[2]?.replace(/[._-]+$/u, "");
		if (!mention) continue;
		const key = mention.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		mentions.push(mention);
		if (mentions.length >= MAX_PROJECT_COMMENT_MENTIONS) break;
	}
	return mentions;
}

/**
 * A workspace member candidate the mention resolver can match a `@handle` against.
 * `name` and `email` are the two human-facing identifiers a mention handle could
 * reference; `userId` is what we ultimately notify. Built by the caller from the
 * workspace membership + the auth-user store (the resolver itself stays pure and
 * store-agnostic so it is trivially unit-testable and can never reach across
 * tenants — it only ever sees the members the caller scoped to ONE workspace).
 */
export interface MentionCandidate {
	userId: string;
	name?: string | null;
	email?: string | null;
}

/**
 * Resolve bare `@handle` mention strings to workspace-member user IDs.
 *
 * Tenant safety: the caller passes ONLY members of the comment's own workspace as
 * `candidates`, so a `@handle` can never resolve to a user outside that workspace
 * even if the handle collides with another tenant's member — there is no global
 * lookup here. A handle matches a candidate when it equals (case-insensitively):
 *   - the email local-part (before `@`), or
 *   - the full name with whitespace removed, or
 *   - the name's first token.
 * The author is skipped (you never notify yourself for your own mention) and the
 * result is de-duplicated, preserving first-seen order. Returns the matched
 * member user IDs.
 */
export function resolveCommentMentions(input: {
	mentions: string[];
	candidates: MentionCandidate[];
	authorUserId?: string;
}): string[] {
	const { mentions, candidates, authorUserId } = input;
	if (mentions.length === 0 || candidates.length === 0) return [];

	// Build a handle → userId index from the workspace members. Multiple aliases
	// (email local-part / collapsed name / first name) all map to the same member.
	const handleToUserId = new Map<string, string>();
	const indexHandle = (handle: string | undefined | null, userId: string): void => {
		const key = handle?.trim().toLowerCase();
		if (!key) return;
		// First writer wins so a more specific alias isn't clobbered; collisions across
		// members are inherently ambiguous, and keeping the first keeps behavior stable.
		if (!handleToUserId.has(key)) handleToUserId.set(key, userId);
	};
	for (const candidate of candidates) {
		const email = candidate.email?.trim();
		if (email) indexHandle(email.split("@")[0], candidate.userId);
		const name = candidate.name?.trim();
		if (name) {
			indexHandle(name.replace(/\s+/gu, ""), candidate.userId);
			indexHandle(name.split(/\s+/u)[0], candidate.userId);
		}
	}

	const resolved: string[] = [];
	const seen = new Set<string>();
	for (const mention of mentions) {
		const userId = handleToUserId.get(mention.trim().toLowerCase());
		if (!userId) continue;
		if (authorUserId && userId === authorUserId) continue; // never self-notify
		if (seen.has(userId)) continue;
		seen.add(userId);
		resolved.push(userId);
	}
	return resolved;
}

export function createProjectComment(input: {
	pageIndex: number;
	layerId?: string;
	region?: { x: number; y: number; w: number; h: number };
	annotation?: ReviewAnnotation;
	body: string;
	author?: string;
}): ProjectComment {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		pageIndex: input.pageIndex,
		layerId: input.layerId,
		region: input.region,
		annotation: input.annotation,
		body: input.body,
		author: input.author ?? "local-user",
		mentions: extractProjectCommentMentions(input.body),
		status: "open",
		createdAt: now,
		updatedAt: now,
	};
}
