// Review assignment service — the durable "who owns this review, and what scope"
// record behind the AssignReviewPanel + CancelReviewDialog.
//
// An assignment lives on `ProjectState.reviewAssignments` (file-mode parity is
// automatic; the Postgres mirror is a migration-safe additive table). It is the
// counterpart to per-page WorkflowTask lane state: a lead/owner assigns a slice
// of review work (whole chapter, a page range, and/or a language track) to a
// specific reviewer; cancelling REQUIRES a reason and fires a mandatory
// notification to the affected reviewer (handled at the route, this module just
// owns the data shape + transitions).

import { v4 as uuid } from "uuid";
import type {
	ProjectState,
	ReviewAssignment,
	ReviewAssignmentStatus,
	WorkflowTaskPriority,
} from "../types/index.js";

/** Defensive cap mirroring MAX_PAGE_REVIEW_DECISIONS — keeps the slice bounded. */
export const MAX_REVIEW_ASSIGNMENTS = 300;

const VALID_STATUSES: ReadonlySet<ReviewAssignmentStatus> = new Set([
	"assigned",
	"in_review",
	"submitted",
	"cancelled",
]);

const VALID_PRIORITIES: ReadonlySet<WorkflowTaskPriority> = new Set(["normal", "high", "urgent"]);

/**
 * Result of validating a caller-supplied page scope against the project page
 * count. `kind: "whole"` means no scope was provided (= whole chapter, the
 * legitimate broad assignment). `kind: "pages"` is a non-empty in-range subset.
 * `kind: "invalid"` means a scope WAS provided but every index was out of range
 * — the caller must reject this (400) rather than silently widening a narrow
 * (intended) assignment into a whole-chapter one.
 */
export type ReviewAssignmentScopeResult =
	| { kind: "whole" }
	| { kind: "pages"; pageIndexes: number[] }
	| { kind: "invalid" };

export function resolveReviewAssignmentScope(
	pageIndexes: number[] | undefined,
	pageCount: number,
): ReviewAssignmentScopeResult {
	if (!Array.isArray(pageIndexes) || pageIndexes.length === 0) return { kind: "whole" };
	const seen = new Set<number>();
	for (const raw of pageIndexes) {
		if (!Number.isInteger(raw)) continue;
		if (raw < 0 || (pageCount > 0 && raw >= pageCount)) continue;
		seen.add(raw);
	}
	// A scope was explicitly provided but nothing survived range-validation: this
	// is a bad narrow assignment, NOT an implicit whole-chapter one. Reject it.
	if (seen.size === 0) return { kind: "invalid" };
	return { kind: "pages", pageIndexes: Array.from(seen).sort((a, b) => a - b) };
}

function sanitizePageIndexes(pageIndexes: number[] | undefined, pageCount: number): number[] | undefined {
	const result = resolveReviewAssignmentScope(pageIndexes, pageCount);
	return result.kind === "pages" ? result.pageIndexes : undefined;
}

/** Normalize a validated ISO datetime to canonical UTC ISO; drop unparseable. */
function normalizeDueAt(dueAt: string | undefined): string | undefined {
	if (!dueAt) return undefined;
	const parsed = new Date(dueAt);
	if (Number.isNaN(parsed.getTime())) return undefined;
	return parsed.toISOString();
}

function normalizePriority(priority: unknown): WorkflowTaskPriority | undefined {
	return typeof priority === "string" && VALID_PRIORITIES.has(priority as WorkflowTaskPriority)
		? (priority as WorkflowTaskPriority)
		: undefined;
}

/** Drop malformed rows + bound the slice. Idempotent — safe to call on every read. */
export function normalizeReviewAssignments(state: ProjectState): ReviewAssignment[] {
	const raw = Array.isArray(state.reviewAssignments) ? state.reviewAssignments : [];
	const cleaned = raw
		.filter((entry): entry is ReviewAssignment =>
			Boolean(entry)
			&& typeof entry.id === "string"
			&& typeof entry.assigneeUserId === "string"
			&& entry.assigneeUserId.trim().length > 0
			&& VALID_STATUSES.has(entry.status))
		.slice(0, MAX_REVIEW_ASSIGNMENTS);
	state.reviewAssignments = cleaned;
	return state.reviewAssignments;
}

export interface CreateReviewAssignmentInput {
	assigneeUserId: string;
	assigneeHandle?: string;
	targetLang?: string;
	pageIndexes?: number[];
	priority?: WorkflowTaskPriority;
	dueAt?: string;
	instructions?: string;
	assignedBy: string;
}

export function createReviewAssignment(input: CreateReviewAssignmentInput, pageCount: number): ReviewAssignment {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		assigneeUserId: input.assigneeUserId.trim(),
		assigneeHandle: input.assigneeHandle?.trim() || undefined,
		targetLang: input.targetLang?.trim() || undefined,
		pageIndexes: sanitizePageIndexes(input.pageIndexes, pageCount),
		status: "assigned",
		assignedBy: input.assignedBy,
		dueAt: normalizeDueAt(input.dueAt),
		priority: normalizePriority(input.priority),
		instructions: input.instructions?.trim() || undefined,
		createdAt: now,
		updatedAt: now,
	};
}

export interface UpdateReviewAssignmentInput {
	status?: ReviewAssignmentStatus;
	targetLang?: string;
	pageIndexes?: number[];
	priority?: WorkflowTaskPriority;
	dueAt?: string | null;
	instructions?: string;
}

export function updateReviewAssignment(
	assignment: ReviewAssignment,
	input: UpdateReviewAssignmentInput,
	pageCount: number,
): ReviewAssignment {
	const next: ReviewAssignment = { ...assignment, updatedAt: new Date().toISOString() };
	if (input.status && VALID_STATUSES.has(input.status)) next.status = input.status;
	if (input.targetLang !== undefined) next.targetLang = input.targetLang.trim() || undefined;
	if (input.pageIndexes !== undefined) next.pageIndexes = sanitizePageIndexes(input.pageIndexes, pageCount);
	if (input.priority !== undefined) next.priority = normalizePriority(input.priority);
	if (input.dueAt !== undefined) next.dueAt = input.dueAt === null ? undefined : normalizeDueAt(input.dueAt);
	if (input.instructions !== undefined) next.instructions = input.instructions.trim() || undefined;
	return next;
}

/**
 * Apply a CANCEL transition. The reason is mandatory (the caller enforces a
 * non-empty reason BEFORE calling, and the route enforces the mandatory notify),
 * so this never produces a cancelled assignment without a recorded reason.
 */
export function cancelReviewAssignment(
	assignment: ReviewAssignment,
	input: { reason: string; cancelledBy: string },
): ReviewAssignment {
	const now = new Date().toISOString();
	return {
		...assignment,
		status: "cancelled",
		cancelReason: input.reason.trim(),
		cancelledBy: input.cancelledBy,
		cancelledAt: now,
		updatedAt: now,
	};
}

/** Human label for a scope, used in activity + notification copy. */
export function describeReviewAssignmentScope(assignment: ReviewAssignment): string {
	const parts: string[] = [];
	if (assignment.pageIndexes && assignment.pageIndexes.length > 0) {
		const pages = assignment.pageIndexes.map((index) => index + 1);
		parts.push(pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`);
	} else {
		parts.push("whole chapter");
	}
	if (assignment.targetLang) parts.push(assignment.targetLang.toUpperCase());
	return parts.join(" · ");
}
