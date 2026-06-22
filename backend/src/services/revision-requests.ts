// Revision send-back service — the durable "reviewer returned this work to a
// worker as revision #X" record behind the RevisionSendBackDialog.
//
// A revision request lives on `ProjectState.revisionRequests` (file-mode parity
// is automatic; the Postgres mirror is the migration-safe additive table 0072).
// It is the SEND-BACK counterpart to a ReviewAssignment: a reviewer/lead finds
// problems and returns a slice of work to the WORKER who must fix it, stamped
// with an auto-incrementing per-project `revisionNumber` and a MANDATORY reason.
// The assigned worker is always notified (handled at the route; this module owns
// the data shape + transitions).

import { v4 as uuid } from "uuid";
import type {
	ProjectState,
	RevisionRequest,
	RevisionRequestStatus,
	WorkflowTaskPriority,
} from "../types/index.js";

/** Defensive cap mirroring MAX_REVIEW_ASSIGNMENTS — keeps the slice bounded. */
export const MAX_REVISION_REQUESTS = 300;

const VALID_STATUSES: ReadonlySet<RevisionRequestStatus> = new Set([
	"requested",
	"in_progress",
	"resubmitted",
	"accepted",
	"cancelled",
]);

/** Statuses that mean the revision is DONE (no longer blocks export / open work). */
const RESOLVED_STATUSES: ReadonlySet<RevisionRequestStatus> = new Set([
	"accepted",
	"cancelled",
]);

const VALID_PRIORITIES: ReadonlySet<WorkflowTaskPriority> = new Set(["normal", "high", "urgent"]);

/**
 * Result of validating a caller-supplied page scope against the project page
 * count. `kind: "whole"` ⇒ no scope (= whole chapter). `kind: "pages"` ⇒ a
 * non-empty in-range subset. `kind: "invalid"` ⇒ a scope WAS provided but every
 * index was out of range — the caller must reject (400) rather than silently
 * widening a narrow (intended) revision into a whole-chapter one. Mirrors the
 * review-assignment scope contract.
 */
export type RevisionScopeResult =
	| { kind: "whole" }
	| { kind: "pages"; pageIndexes: number[] }
	| { kind: "invalid" };

export function resolveRevisionScope(
	pageIndexes: number[] | undefined,
	pageCount: number,
): RevisionScopeResult {
	if (!Array.isArray(pageIndexes) || pageIndexes.length === 0) return { kind: "whole" };
	const seen = new Set<number>();
	for (const raw of pageIndexes) {
		if (!Number.isInteger(raw)) continue;
		if (raw < 0 || (pageCount > 0 && raw >= pageCount)) continue;
		seen.add(raw);
	}
	if (seen.size === 0) return { kind: "invalid" };
	return { kind: "pages", pageIndexes: Array.from(seen).sort((a, b) => a - b) };
}

function sanitizePageIndexes(pageIndexes: number[] | undefined, pageCount: number): number[] | undefined {
	const result = resolveRevisionScope(pageIndexes, pageCount);
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

/** Drop malformed rows + bound the slice. Idempotent — safe on every read. */
export function normalizeRevisionRequests(state: ProjectState): RevisionRequest[] {
	const raw = Array.isArray(state.revisionRequests) ? state.revisionRequests : [];
	const cleaned = raw
		.filter((entry): entry is RevisionRequest =>
			Boolean(entry)
			&& typeof entry.id === "string"
			&& typeof entry.assignedToUserId === "string"
			&& entry.assignedToUserId.trim().length > 0
			&& typeof entry.reason === "string"
			&& entry.reason.trim().length > 0
			&& typeof entry.revisionNumber === "number"
			&& Number.isFinite(entry.revisionNumber)
			&& VALID_STATUSES.has(entry.status))
		.slice(0, MAX_REVISION_REQUESTS);
	state.revisionRequests = cleaned;
	return state.revisionRequests;
}

/**
 * Next per-project revision number. Auto-increments off the HIGHEST existing
 * number (not the count), so a cancelled/deleted revision never recycles a number
 * — the sequence is monotonic and traceable ("Revision #1", "#2", …).
 */
export function nextRevisionNumber(requests: readonly RevisionRequest[]): number {
	let max = 0;
	for (const r of requests) {
		if (typeof r.revisionNumber === "number" && r.revisionNumber > max) max = r.revisionNumber;
	}
	return max + 1;
}

export interface CreateRevisionRequestInput {
	assignedToUserId: string;
	assignedToHandle?: string;
	reason: string;
	requestedBy: string;
	targetLang?: string;
	pageIndexes?: number[];
	sourceReviewDecisionId?: string;
	priority?: WorkflowTaskPriority;
	dueAt?: string;
}

export function createRevisionRequest(
	input: CreateRevisionRequestInput,
	revisionNumber: number,
	pageCount: number,
): RevisionRequest {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		revisionNumber,
		assignedToUserId: input.assignedToUserId.trim(),
		assignedToHandle: input.assignedToHandle?.trim() || undefined,
		reason: input.reason.trim(),
		requestedBy: input.requestedBy,
		targetLang: input.targetLang?.trim() || undefined,
		pageIndexes: sanitizePageIndexes(input.pageIndexes, pageCount),
		sourceReviewDecisionId: input.sourceReviewDecisionId?.trim() || undefined,
		status: "requested",
		dueAt: normalizeDueAt(input.dueAt),
		priority: normalizePriority(input.priority),
		createdAt: now,
		updatedAt: now,
	};
}

export interface UpdateRevisionRequestInput {
	status?: RevisionRequestStatus;
	reason?: string;
	pageIndexes?: number[];
	priority?: WorkflowTaskPriority;
	dueAt?: string | null;
	/** Actor resolving the revision — stamped on resolved/accepted/cancelled. */
	resolvedBy?: string;
}

export function updateRevisionRequest(
	revision: RevisionRequest,
	input: UpdateRevisionRequestInput,
	pageCount: number,
): RevisionRequest {
	const now = new Date().toISOString();
	const next: RevisionRequest = { ...revision, updatedAt: now };
	if (input.status && VALID_STATUSES.has(input.status)) {
		next.status = input.status;
		if (RESOLVED_STATUSES.has(input.status)) {
			next.resolvedAt = now;
			if (input.resolvedBy) next.resolvedBy = input.resolvedBy;
		}
	}
	if (input.reason !== undefined && input.reason.trim().length > 0) next.reason = input.reason.trim();
	if (input.pageIndexes !== undefined) next.pageIndexes = sanitizePageIndexes(input.pageIndexes, pageCount);
	if (input.priority !== undefined) next.priority = normalizePriority(input.priority);
	if (input.dueAt !== undefined) next.dueAt = input.dueAt === null ? undefined : normalizeDueAt(input.dueAt);
	return next;
}

/** True when the revision is still OPEN (blocks export / shows on the worker's queue). */
export function isRevisionOpen(revision: RevisionRequest): boolean {
	return !RESOLVED_STATUSES.has(revision.status);
}

/** Human label for a scope, used in activity + notification copy. */
export function describeRevisionScope(revision: RevisionRequest): string {
	const parts: string[] = [];
	if (revision.pageIndexes && revision.pageIndexes.length > 0) {
		const pages = revision.pageIndexes.map((index) => index + 1);
		parts.push(pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`);
	} else {
		parts.push("whole chapter");
	}
	if (revision.targetLang) parts.push(revision.targetLang.toUpperCase());
	return parts.join(" · ");
}
