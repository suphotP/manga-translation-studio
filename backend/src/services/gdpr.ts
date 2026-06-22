// W2.6 — GDPR (Data Subject Rights) service layer.
//
// Three concerns live here:
//   1. Consent capture (cookie banner + future TOS prompts) → consent_events.
//   2. "Download my data" exports → account_export_jobs + signed artifact URL.
//   3. "Delete my account" soft-delete + 30-day grace window + hard-delete cron.
//
// The store mirrors the file|postgres pattern used by upload-audit, billing,
// and project-catalog: an in-memory store for local prototype + tests, a
// Postgres-backed store when DATABASE_URL is wired up. Routes only ever touch
// the abstract interface so swapping is free.

import { getSharedBunSql } from "./sql-pool.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { isProjectTombstonedIn, isValidProjectId, safePath } from "../utils/security.js";
import type { ProjectCatalogStore, ProjectVersionRecord } from "./project-catalog.js";
import type { AuthTokenKind, AuthFlowTokenStore } from "./password-reset.js";
import type { SupportTicketStore } from "./support-tickets.js";
import { isCustomerVisibleAuthorKind } from "./support-tickets.js";
import type { NotificationPreferenceStore } from "./notification-preferences.js";
import type { ProjectState } from "../types/index.js";

// ── Consent ───────────────────────────────────────────────────────

export interface ConsentCategories {
	necessary: boolean;
	functional: boolean;
	analytics: boolean;
	marketing: boolean;
	[extra: string]: boolean;
}

export interface ConsentEvent {
	id: string;
	userId: string | null;
	consentType: string;
	categories: Record<string, boolean>;
	grantedAt: string;
	ipAddress: string | null;
	userAgent: string | null;
	policyVersion: string;
	deviceId: string | null;
}

export interface RecordConsentInput {
	userId?: string | null;
	consentType: string;
	categories: Record<string, boolean>;
	ipAddress?: string | null;
	userAgent?: string | null;
	policyVersion: string;
	deviceId?: string | null;
}

// ── Account export ────────────────────────────────────────────────

export type ExportJobStatus = "queued" | "processing" | "ready" | "failed" | "expired";

export interface AccountExportJob {
	id: string;
	userId: string;
	status: ExportJobStatus;
	zipUrl: string | null;
	failureReason: string | null;
	bytes: number | null;
	expiresAt: string | null;
	createdAt: string;
	completedAt: string | null;
}

// ── Soft-delete ───────────────────────────────────────────────────

export interface SoftDeleteSnapshot {
	userId: string;
	deletedAt: string;
	deleteGraceUntil: string;
	originalEmail: string;
	redactedEmail: string;
}

/**
 * Outcome of purging one soft-deleted user. `purged: false` means there was
 * nothing to do (already anonymized, never soft-deleted, the user no longer
 * exists, or the deletion markers no longer match the context the candidate was
 * selected with) — that is the idempotent path, not an error.
 */
export interface PurgeResult {
	userId: string;
	purged: boolean;
	/** The tombstone email written in place of the original, when a purge happened. */
	tombstoneEmail?: string;
	reason?: "not_soft_deleted" | "already_anonymized" | "user_missing" | "markers_changed";
}

/**
 * Deletion context a candidate was selected with, re-checked ATOMICALLY at purge
 * time so a restore-then-redelete (or any marker change) between the sweep's
 * listing and the purge cannot erase a user who is now inside a FRESH undo
 * window. All three gates must STILL hold against the live row:
 *   * `deletedAt` — the exact soft-delete timestamp the candidate carried (a
 *     restore-then-redelete produces a DIFFERENT timestamp, so this CAS misses);
 *   * `graceUntilAtOrBefore` — the per-row undo window must be at/below this
 *     instant (the sweep's `now`); a fresh future grace fails it;
 *   * `deletedAtOrBefore` — the configured legal-retention cutoff; a row newer
 *     than this is still inside the retention window.
 * When the markers no longer match, the purge is SKIPPED (no write) and reported
 * as `markers_changed`.
 */
export interface PurgeDeletionContext {
	/** The soft-delete timestamp (ISO) the candidate was listed with. */
	deletedAt: string;
	/** Per-row undo window must be <= this instant (ISO) — the sweep's `now`. */
	graceUntilAtOrBefore: string;
	/** Configured legal-retention cutoff: deletedAt must be <= this instant (ISO). */
	deletedAtOrBefore: string;
}

export interface GdprErasureSweepResult {
	/** When true, no destructive writes were issued — only the candidate count. */
	dryRun: boolean;
	/** Soft-deletes whose grace window has expired at `now`. */
	candidates: number;
	/** Users actually anonymized this run (0 on a dry-run, and idempotently 0 on re-runs). */
	purged: number;
	/** Candidates skipped because a prior run already anonymized them. */
	alreadyAnonymized: number;
	/** Candidates that failed to purge (logged, left for the next sweep). */
	errors: number;
	/** The user ids anonymized this run, for the audit/log line. */
	purgedUserIds: string[];
}

// ── Admin audit / impersonation ───────────────────────────────────

export interface AdminAuditEntry {
	id: string;
	adminUserId: string;
	/**
	 * Platform role of the acting admin at the time of the action (owner / admin /
	 * support / accountant / …). Captured so the back-office audit log answers
	 * "who, in what capacity, did this" without re-resolving the user — and so a
	 * later role change does not rewrite history. Nullable for legacy rows written
	 * before this column existed and for synthetic/system actors with no role.
	 */
	actorRole: string | null;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface ImpersonationEvent {
	id: string;
	adminUserId: string;
	impersonatedUserId: string;
	reason: string | null;
	startedAt: string;
	endedAt: string | null;
}

// ── Store interface ───────────────────────────────────────────────

export interface GdprStore {
	recordConsent(input: RecordConsentInput): Promise<ConsentEvent>;
	listConsentEvents(userId: string, options?: { limit?: number }): Promise<ConsentEvent[]>;

	createExportJob(userId: string): Promise<AccountExportJob>;
	getExportJob(jobId: string): Promise<AccountExportJob | null>;
	listExportJobs(userId: string): Promise<AccountExportJob[]>;
	updateExportJob(jobId: string, patch: Partial<Pick<AccountExportJob, "status" | "zipUrl" | "failureReason" | "bytes" | "expiresAt" | "completedAt">>): Promise<AccountExportJob | null>;

	softDeleteUser(userId: string, options: { gracePeriodMs: number }): Promise<SoftDeleteSnapshot | null>;
	restoreUser(userId: string): Promise<boolean>;
	listExpiredSoftDeletes(now?: Date): Promise<Array<{ userId: string; deleteGraceUntil: string }>>;
	listPendingSoftDeletes(): Promise<Array<{ userId: string; deletedAt: string; deleteGraceUntil: string }>>;
	/**
	 * Targeted pending-soft-delete lookup for ONE user (PK point lookup). The /restore
	 * endpoint must use this instead of listPendingSoftDeletes()+find(): /restore runs BEFORE
	 * the token check, so loading the entire platform-wide soft-delete set per request is both
	 * O(all-deletes) and an unauthenticated amplification vector. Returns null if not pending.
	 */
	getPendingSoftDelete(userId: string): Promise<{ userId: string; deletedAt: string; deleteGraceUntil: string } | null>;
	/**
	 * GDPR right-to-erasure: irreversibly anonymize a single soft-deleted user's
	 * PII (email → tombstone, name → redacted, drop password + linked SSO
	 * identities, bump token-validity so sessions die) and stop tracking them as
	 * pending-deletion. MUST be idempotent — a second call on an already-purged
	 * user is a no-op that returns `purged: false`.
	 *
	 * RACE SAFETY: when `expected` is supplied, the store re-checks the deletion
	 * markers ATOMICALLY at purge time (CAS on `deleted_at` = the listed timestamp
	 * AND `delete_grace_until` <= the sweep's `now` AND `deleted_at` <= the
	 * retention cutoff) and only anonymizes if ALL still hold. This bars a
	 * restore-then-redelete between the sweep's listing and the purge from erasing
	 * a user who is now inside a FRESH undo window — the markers no longer match,
	 * so the purge is SKIPPED (`markers_changed`, no write). Omitting `expected`
	 * preserves the legacy "purge if currently soft-deleted" behaviour.
	 */
	purgeSoftDeletedUser(userId: string, expected?: PurgeDeletionContext): Promise<PurgeResult>;

	startImpersonation(adminUserId: string, impersonatedUserId: string, reason: string | null): Promise<ImpersonationEvent>;
	endImpersonation(id: string): Promise<ImpersonationEvent | null>;
	listImpersonations(options?: { adminUserId?: string; targetUserId?: string; limit?: number }): Promise<ImpersonationEvent[]>;

	recordAdminAudit(input: { adminUserId: string; action: string; actorRole?: string | null; targetKind?: string | null; targetId?: string | null; detail?: Record<string, unknown> }): Promise<AdminAuditEntry>;
	listAdminAudit(options?: { adminUserId?: string; action?: string; actorRole?: string; targetKind?: string; targetId?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }): Promise<{ entries: AdminAuditEntry[]; total: number }>;
}

// ── In-memory + JSON file store ───────────────────────────────────

interface GdprSnapshot {
	consents: ConsentEvent[];
	exports: AccountExportJob[];
	softDeletes: Record<string, SoftDeleteSnapshot>;
	impersonations: ImpersonationEvent[];
	adminAudit: AdminAuditEntry[];
}

const DEFAULT_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the acting admin's platform role for an audit row. Callers that
 * already know the role (and pass it explicitly) win; otherwise we look the
 * user up so EVERY audit row captures a role even though the existing
 * audit-write callers in the admin routes only pass `adminUserId`. Best-effort:
 * a missing user or a load failure records `null` rather than dropping the audit
 * entry — losing the audit row would be worse than losing the role label.
 */
async function resolveActorRole(adminUserId: string, explicit?: string | null): Promise<string | null> {
	if (explicit !== undefined && explicit !== null) {
		const trimmed = String(explicit).trim();
		if (trimmed) return trimmed;
	}
	try {
		const { authUserStore } = await import("./auth-users.js");
		const user = await authUserStore.load(adminUserId);
		return user?.role ?? null;
	} catch {
		return null;
	}
}

/**
 * Stable tombstone email written when a soft-deleted account is hard-anonymized.
 * DISTINCT from the soft-delete alias (`deleted+<id>@redacted.invalid`): the
 * different prefix is the idempotency marker — `isAnonymizedTombstoneEmail`
 * recognizes it so a second purge of the same row is a no-op.
 */
function purgeTombstoneEmail(userId: string): string {
	return `purged+${userId}@redacted.invalid`;
}

function isAnonymizedTombstoneEmail(email: string | null | undefined): boolean {
	return typeof email === "string" && email.startsWith("purged+") && email.endsWith("@redacted.invalid");
}

/**
 * Thrown by {@link GdprStore.restoreUser} when the per-account undo window
 * (`deleteGraceUntil`) is missing/invalid or has already elapsed. Restoring an
 * account after grace expiry violates the retention contract: the row is a live
 * purge candidate and may be anonymized by the sweeper at any moment. The route
 * maps this to HTTP 410 (Gone). This is a DEFENSE-IN-DEPTH gate — the route also
 * checks grace before calling restoreUser — so the window can never be reopened
 * by a future caller that forgets the route-level guard.
 */
export class RestoreGraceExpiredError extends Error {
	constructor(message = "Restore grace window has expired") {
		super(message);
		this.name = "RestoreGraceExpiredError";
	}
}

/**
 * Is the soft-delete undo window still OPEN at `now`? Returns false (grace
 * expired / unusable) when `deleteGraceUntil` is missing, unparseable, or at/
 * before `now`. Centralizes the retention-contract check shared by the restore
 * route and both store backends so they cannot drift apart.
 */
function isRestoreGraceValid(deleteGraceUntil: string | null | undefined, now: number = Date.now()): boolean {
	if (!deleteGraceUntil) return false;
	const graceMs = Date.parse(deleteGraceUntil);
	if (Number.isNaN(graceMs)) return false;
	return graceMs > now;
}

/**
 * P1a race guard (file-mode): does the live soft-delete snapshot STILL satisfy
 * the deletion context the sweep selected this candidate with? All three gates
 * must hold:
 *   * `deletedAt` matches EXACTLY — a restore-then-redelete stamps a new
 *     timestamp, so the candidate's old timestamp no longer matches;
 *   * the per-row undo window (`deleteGraceUntil`) is at/below the sweep's `now`
 *     — a fresh future grace fails it;
 *   * `deletedAt` is at/below the configured retention cutoff.
 * Timestamps are normalized ISO-8601 (UTC, ms precision) on both sides, so a
 * lexicographic compare is also chronological; we compare epoch millis to be
 * robust to any precision/offset drift.
 */
function softDeleteMarkersStillMatch(snapshot: SoftDeleteSnapshot, expected: PurgeDeletionContext): boolean {
	const liveDeletedAt = Date.parse(snapshot.deletedAt);
	const expectedDeletedAt = Date.parse(expected.deletedAt);
	const liveGraceUntil = Date.parse(snapshot.deleteGraceUntil);
	const graceCutoff = Date.parse(expected.graceUntilAtOrBefore);
	const retentionCutoff = Date.parse(expected.deletedAtOrBefore);
	if ([liveDeletedAt, expectedDeletedAt, liveGraceUntil, graceCutoff, retentionCutoff].some(Number.isNaN)) {
		// Unparseable markers → fail closed (do NOT purge): a malformed timestamp
		// must never be treated as "still expired".
		return false;
	}
	return (
		liveDeletedAt === expectedDeletedAt
		&& liveGraceUntil <= graceCutoff
		&& liveDeletedAt <= retentionCutoff
	);
}

export const GDPR_ERASED_DISPLAY_NAME = "ผู้ใช้ที่ถูกลบ";
export const GDPR_ERASED_IDENTITY = "deleted-user";

const PROJECT_STATE_ERASURE_PROJECT_BATCH_CAP = 1000;
const PROJECT_VERSION_ERASURE_BATCH_CAP = 1000;
const VERSION_FILE_ID_RE = /^[0-9TZA-Za-z_-]+\.json$/;

export interface ProjectStatePiiAnonymizeStats {
	chapterTeamMembers: number;
	chapterTeamInviters: number;
	commentAuthors: number;
	activityActors: number;
	reviewDecisionActors: number;
	workspaceMessageAuthors: number;
	versionAuthors: number;
	versionReviewActors: number;
	revisionRequestActors: number;
	structuredAssignees: number;
	ownerIds: number;
	mentionRefs: number;
}

export interface ProjectStatePiiSweepStats extends ProjectStatePiiAnonymizeStats {
	mode: "file" | "postgres";
	projectsScanned: number;
	projectsChanged: number;
	projectCommentsChanged: number;
	reviewDecisionRowsChanged: number;
	versionReviewRowsChanged: number;
	pendingInviteRowsDeleted: number;
	pendingInviteRowsUpdated: number;
	ownerRowsChanged: number;
	taskAssigneeRowsChanged: number;
	reviewAssignmentRowsChanged: number;
	revisionRequestRowsChanged: number;
	mentionRowsChanged: number;
	versionsScanned: number;
	versionsChanged: number;
	truncated: boolean;
	changedProjectIds: string[];
}

interface ErasedProjectIdentity {
	userId: string;
	email: string | null;
	emailMatches: Set<string>;
}

interface ProjectVersionPiiRow {
	version_id: string;
	project_id: string;
	metadata: unknown;
	state: unknown;
}

function emptyProjectStatePiiAnonymizeStats(): ProjectStatePiiAnonymizeStats {
	return {
		chapterTeamMembers: 0,
		chapterTeamInviters: 0,
		commentAuthors: 0,
		activityActors: 0,
		reviewDecisionActors: 0,
		workspaceMessageAuthors: 0,
		versionAuthors: 0,
		versionReviewActors: 0,
		revisionRequestActors: 0,
		structuredAssignees: 0,
		ownerIds: 0,
		mentionRefs: 0,
	};
}

function emptyProjectStatePiiSweepStats(mode: ProjectStatePiiSweepStats["mode"]): ProjectStatePiiSweepStats {
	return {
		mode,
		...emptyProjectStatePiiAnonymizeStats(),
		projectsScanned: 0,
		projectsChanged: 0,
		projectCommentsChanged: 0,
		reviewDecisionRowsChanged: 0,
		versionReviewRowsChanged: 0,
		pendingInviteRowsDeleted: 0,
		pendingInviteRowsUpdated: 0,
		ownerRowsChanged: 0,
		taskAssigneeRowsChanged: 0,
		reviewAssignmentRowsChanged: 0,
		revisionRequestRowsChanged: 0,
		mentionRowsChanged: 0,
		versionsScanned: 0,
		versionsChanged: 0,
		truncated: false,
		changedProjectIds: [],
	};
}

function addProjectStatePiiStats(target: ProjectStatePiiAnonymizeStats, source: ProjectStatePiiAnonymizeStats): void {
	target.chapterTeamMembers += source.chapterTeamMembers;
	target.chapterTeamInviters += source.chapterTeamInviters;
	target.commentAuthors += source.commentAuthors;
	target.activityActors += source.activityActors;
	target.reviewDecisionActors += source.reviewDecisionActors;
	target.workspaceMessageAuthors += source.workspaceMessageAuthors;
	target.versionAuthors += source.versionAuthors;
	target.versionReviewActors += source.versionReviewActors;
	target.revisionRequestActors += source.revisionRequestActors;
	target.structuredAssignees += source.structuredAssignees;
	target.ownerIds += source.ownerIds;
	target.mentionRefs += source.mentionRefs;
}

function buildErasedProjectIdentity(userId: string, originalEmail: string | null | undefined): ErasedProjectIdentity {
	const id = userId.trim();
	const emailMatches = new Set<string>();
	const addEmail = (value: string | null | undefined) => {
		const normalized = value?.trim().toLowerCase();
		if (normalized) emailMatches.add(normalized);
	};
	addEmail(originalEmail);
	// Soft-delete aliases still contain the user id. Treat them as erased identity
	// material too so old snapshots cannot keep a redacted-but-linkable value.
	addEmail(`deleted+${id}@redacted.invalid`);
	addEmail(purgeTombstoneEmail(id));
	return { userId: id, email: originalEmail?.trim() || null, emailMatches };
}

function matchesErasedProjectIdentity(value: unknown, identity: ErasedProjectIdentity): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim();
	if (!normalized) return false;
	if (normalized === identity.userId) return true;
	return identity.emailMatches.has(normalized.toLowerCase());
}

function anonymizeIdentityField<T extends Record<string, unknown>>(
	target: T,
	key: keyof T,
	identity: ErasedProjectIdentity,
	replacement = GDPR_ERASED_IDENTITY,
): boolean {
	if (!matchesErasedProjectIdentity(target[key], identity)) return false;
	target[key] = replacement as T[keyof T];
	return true;
}

function projectStatePiiStatsChanged(stats: ProjectStatePiiAnonymizeStats): boolean {
	return stats.chapterTeamMembers > 0
		|| stats.chapterTeamInviters > 0
		|| stats.commentAuthors > 0
		|| stats.activityActors > 0
		|| stats.reviewDecisionActors > 0
		|| stats.workspaceMessageAuthors > 0
		|| stats.versionAuthors > 0
		|| stats.versionReviewActors > 0
		|| stats.revisionRequestActors > 0
		|| stats.structuredAssignees > 0
		|| stats.ownerIds > 0
		|| stats.mentionRefs > 0;
}

/**
 * Scrub identity fields that are server-authored snapshots of an erased account.
 * We intentionally leave free-text bodies/messages untouched: those can contain
 * project work from multiple collaborators and need a separate content-redaction
 * policy, while these fields are deterministic account attribution.
 */
export function anonymizeProjectStatePiiForErasedUser(
	state: ProjectState,
	userId: string,
	originalEmail?: string | null,
): ProjectStatePiiAnonymizeStats {
	const identity = buildErasedProjectIdentity(userId, originalEmail);
	const stats = emptyProjectStatePiiAnonymizeStats();

	// Top-level creator/owner snapshot (review #599 r2 P1): `state.userId` is the
	// raw account id and survives in current_state plus every version snapshot.
	// It can be the ONLY identity present, so it must register as a change or the
	// sweep would find the project and then skip the write entirely.
	if (anonymizeIdentityField(state as unknown as Record<string, unknown>, "userId", identity)) {
		stats.ownerIds += 1;
	}

	if (Array.isArray(state.chapterTeam)) {
		for (const member of state.chapterTeam) {
			const memberMatches = matchesErasedProjectIdentity(member.userId, identity)
				|| matchesErasedProjectIdentity(member.email, identity)
				|| matchesErasedProjectIdentity(member.displayName, identity);
			if (memberMatches) {
				member.userId = GDPR_ERASED_IDENTITY;
				member.email = GDPR_ERASED_IDENTITY;
				member.displayName = GDPR_ERASED_DISPLAY_NAME;
				stats.chapterTeamMembers += 1;
			}
			if (matchesErasedProjectIdentity(member.invitedBy, identity)) {
				member.invitedBy = GDPR_ERASED_IDENTITY;
				stats.chapterTeamInviters += 1;
			}
		}
	}

	if (Array.isArray(state.comments)) {
		for (const comment of state.comments) {
			if (anonymizeIdentityField(comment as unknown as Record<string, unknown>, "author", identity)) {
				stats.commentAuthors += 1;
			}
			// Structured mention lists keep raw user ids (review #599 P1). Rewrites
			// are COUNTED (r2 P1): a mention-only match must still mark the state
			// changed or the caller skips the write.
			if (Array.isArray(comment.mentions)) {
				comment.mentions = comment.mentions.map((m) => {
					if (!matchesErasedProjectIdentity(m, identity)) return m;
					stats.mentionRefs += 1;
					return GDPR_ERASED_IDENTITY;
				});
			}
		}
	}

	// Structured assignee/mention identity fields (review #599 P1): the erased
	// user must vanish from task/review queues, not just from display strings.
	if (Array.isArray(state.reviewAssignments)) {
		for (const assignment of state.reviewAssignments) {
			const record = assignment as unknown as Record<string, unknown>;
			let changed = false;
			changed = anonymizeIdentityField(record, "assigneeUserId", identity) || changed;
			changed = anonymizeIdentityField(record, "assigneeHandle", identity) || changed;
			// Actor snapshots (review #599 r2 P2): the erased user may have CREATED
			// or CANCELLED the assignment without being its assignee.
			changed = anonymizeIdentityField(record, "assignedBy", identity) || changed;
			changed = anonymizeIdentityField(record, "cancelledBy", identity) || changed;
			if (changed) stats.structuredAssignees += 1;
		}
	}
	if (Array.isArray(state.revisionRequests)) {
		for (const request of state.revisionRequests) {
			const record = request as unknown as Record<string, unknown>;
			let changed = false;
			changed = anonymizeIdentityField(record, "assignedToUserId", identity) || changed;
			changed = anonymizeIdentityField(record, "assignedToHandle", identity) || changed;
			if (changed) stats.structuredAssignees += 1;
		}
	}
	if (Array.isArray(state.tasks)) {
		for (const task of state.tasks) {
			if (anonymizeIdentityField(task as unknown as Record<string, unknown>, "assignee", identity)) stats.structuredAssignees += 1;
		}
	}
	// (Workspace feed items also carry mentions but are DERIVED from these lists
	// at read time — see buildWorkspaceFeed — so they are never persisted here.)
	for (const list of [state.workspaceMessages, state.versionReviewRequests] as Array<Array<{ mentions?: string[] }> | undefined>) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (Array.isArray(item.mentions)) {
				item.mentions = item.mentions.map((m) => {
					if (!matchesErasedProjectIdentity(m, identity)) return m;
					stats.mentionRefs += 1;
					return GDPR_ERASED_IDENTITY;
				});
			}
		}
	}

	if (Array.isArray(state.activityLog)) {
		for (const event of state.activityLog) {
			if (anonymizeIdentityField(event as unknown as Record<string, unknown>, "actor", identity)) {
				stats.activityActors += 1;
			}
		}
	}

	if (Array.isArray(state.reviewDecisions)) {
		for (const decision of state.reviewDecisions) {
			if (anonymizeIdentityField(decision as unknown as Record<string, unknown>, "actor", identity)) {
				stats.reviewDecisionActors += 1;
			}
		}
	}

	if (Array.isArray(state.workspaceMessages)) {
		for (const message of state.workspaceMessages) {
			if (anonymizeIdentityField(message as unknown as Record<string, unknown>, "author", identity)) {
				stats.workspaceMessageAuthors += 1;
			}
		}
	}

	if (Array.isArray(state.versionReviewRequests)) {
		for (const request of state.versionReviewRequests) {
			let changed = false;
			changed = anonymizeIdentityField(request as unknown as Record<string, unknown>, "requester", identity) || changed;
			changed = anonymizeIdentityField(request as unknown as Record<string, unknown>, "reviewer", identity) || changed;
			if (changed) stats.versionReviewActors += 1;
		}
	}

	if (Array.isArray(state.revisionRequests)) {
		for (const request of state.revisionRequests) {
			let changed = false;
			changed = anonymizeIdentityField(request as unknown as Record<string, unknown>, "requestedBy", identity) || changed;
			changed = anonymizeIdentityField(request as unknown as Record<string, unknown>, "resolvedBy", identity) || changed;
			if (changed) stats.revisionRequestActors += 1;
		}
	}

	return stats;
}

function anonymizeProjectVersionRecordPii(
	record: ProjectVersionRecord,
	userId: string,
	originalEmail?: string | null,
): { changed: boolean; stateStats: ProjectStatePiiAnonymizeStats; metadataAuthorChanged: boolean } {
	const identity = buildErasedProjectIdentity(userId, originalEmail);
	const metadataAuthorChanged = anonymizeIdentityField(
		record.metadata as unknown as Record<string, unknown>,
		"author",
		identity,
	);
	const stateStats = anonymizeProjectStatePiiForErasedUser(record.state, userId, originalEmail);
	return {
		changed: metadataAuthorChanged || projectStatePiiStatsChanged(stateStats),
		stateStats,
		metadataAuthorChanged,
	};
}

function parseJsonbObject<T>(value: unknown): T | null {
	if (!value) return null;
	if (typeof value === "object") return value as T;
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed as T : null;
	} catch {
		return null;
	}
}

function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function projectStateMatchesErasedIdentity(state: ProjectState, userId: string, originalEmail?: string | null): boolean {
	const identity = buildErasedProjectIdentity(userId, originalEmail);
	const serialized = JSON.stringify(state).toLowerCase();
	if (serialized.includes(identity.userId.toLowerCase())) return true;
	for (const email of identity.emailMatches) {
		if (serialized.includes(email)) return true;
	}
	return false;
}

function projectStateFilePath(projectsDir: string, projectId: string): string {
	return safePath(projectsDir, projectId, "state.json");
}

function projectVersionsDir(projectsDir: string, projectId: string): string {
	return safePath(projectsDir, projectId, "versions");
}

function logProjectStatePiiSweep(userId: string, stats: ProjectStatePiiSweepStats): void {
	console.info("[gdpr] erasure: project-state PII sweep", {
		userId,
		mode: stats.mode,
		projectsScanned: stats.projectsScanned,
		projectsChanged: stats.projectsChanged,
		projectCommentsChanged: stats.projectCommentsChanged,
		reviewDecisionRowsChanged: stats.reviewDecisionRowsChanged,
		versionReviewRowsChanged: stats.versionReviewRowsChanged,
		pendingInviteRowsDeleted: stats.pendingInviteRowsDeleted,
		pendingInviteRowsUpdated: stats.pendingInviteRowsUpdated,
		ownerRowsChanged: stats.ownerRowsChanged,
		taskAssigneeRowsChanged: stats.taskAssigneeRowsChanged,
		reviewAssignmentRowsChanged: stats.reviewAssignmentRowsChanged,
		revisionRequestRowsChanged: stats.revisionRequestRowsChanged,
		mentionRowsChanged: stats.mentionRowsChanged,
		versionsScanned: stats.versionsScanned,
		versionsChanged: stats.versionsChanged,
		versionAuthors: stats.versionAuthors,
		truncated: stats.truncated,
	});
}

function sweepFileProjectStatePiiForErasedUserSync(
	userId: string,
	originalEmail: string | null | undefined,
	projectsDir: string = join(DATA_DIR, "projects"),
): ProjectStatePiiSweepStats {
	const stats = emptyProjectStatePiiSweepStats("file");
	if (!existsSync(projectsDir)) return stats;
	for (const projectId of readdirSync(projectsDir)) {
		if (!isValidProjectId(projectId)) continue;
		if (isProjectTombstonedIn(projectsDir, projectId)) continue;
		const statePath = projectStateFilePath(projectsDir, projectId);
		if (!existsSync(statePath)) continue;
		let state: ProjectState | null = null;
		try {
			state = readJsonFile<ProjectState>(statePath);
		} catch (error) {
			console.warn(`[gdpr] erasure: failed to read project state ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!state) continue;
		stats.projectsScanned += 1;
		if (projectStateMatchesErasedIdentity(state, userId, originalEmail)) {
			const stateStats = anonymizeProjectStatePiiForErasedUser(state, userId, originalEmail);
			if (projectStatePiiStatsChanged(stateStats)) {
				addProjectStatePiiStats(stats, stateStats);
				writeFileAtomic(statePath, JSON.stringify(state));
				stats.projectsChanged += 1;
				stats.changedProjectIds.push(projectId);
			}
		}
		sweepFileProjectVersionPiiForErasedUserSync(projectsDir, projectId, userId, originalEmail, stats);
	}
	return stats;
}

function sweepFileProjectVersionPiiForErasedUserSync(
	projectsDir: string,
	projectId: string,
	userId: string,
	originalEmail: string | null | undefined,
	stats: ProjectStatePiiSweepStats,
): void {
	const versionsDir = projectVersionsDir(projectsDir, projectId);
	if (!existsSync(versionsDir)) return;
	for (const file of readdirSync(versionsDir)) {
		if (!VERSION_FILE_ID_RE.test(file)) continue;
		const versionPath = safePath(versionsDir, file);
		let record: ProjectVersionRecord | null = null;
		try {
			record = readJsonFile<ProjectVersionRecord>(versionPath);
		} catch (error) {
			console.warn(`[gdpr] erasure: failed to read project version ${projectId}/${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!record?.metadata || !record.state) continue;
		stats.versionsScanned += 1;
		const result = anonymizeProjectVersionRecordPii(record, userId, originalEmail);
		if (!result.changed) continue;
		addProjectStatePiiStats(stats, result.stateStats);
		if (result.metadataAuthorChanged) stats.versionAuthors += 1;
		writeFileAtomic(versionPath, JSON.stringify(record));
		stats.versionsChanged += 1;
	}
}

async function syncPendingInviteIndexAfterFileSweep(stats: ProjectStatePiiSweepStats, projectsDir: string): Promise<void> {
	if (stats.changedProjectIds.length === 0) return;
	const { derivePendingInviteEntries, pendingInviteIndexStore } = await import("./pending-invite-index.js");
	for (const projectId of stats.changedProjectIds) {
		try {
			const state = readJsonFile<ProjectState>(projectStateFilePath(projectsDir, projectId));
			if (state) await pendingInviteIndexStore.syncProject(projectId, derivePendingInviteEntries(state));
		} catch (error) {
			console.warn(`[gdpr] erasure: pending-invite index sync failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export async function sweepFileProjectStatePiiForErasedUser(
	userId: string,
	originalEmail?: string | null,
	options: { projectsDir?: string; syncPendingInviteIndex?: boolean } = {},
): Promise<ProjectStatePiiSweepStats> {
	const projectsDir = options.projectsDir ?? join(DATA_DIR, "projects");
	const stats = sweepFileProjectStatePiiForErasedUserSync(userId, originalEmail, projectsDir);
	if (options.syncPendingInviteIndex ?? true) {
		await syncPendingInviteIndexAfterFileSweep(stats, projectsDir);
	}
	logProjectStatePiiSweep(userId, stats);
	return stats;
}

async function purgeProjectStatePiiOnClient(
	tx: GdprSqlClient,
	userId: string,
	originalEmail: string | null,
): Promise<ProjectStatePiiSweepStats> {
	const stats = emptyProjectStatePiiSweepStats("postgres");
	const chapterTeamUserNeedle = JSON.stringify([{ userId }]);
	const chapterTeamEmailNeedle = originalEmail ? JSON.stringify([{ email: originalEmail.trim().toLowerCase() }]) : null;
	const userIdLike = `%${escapeSqlLike(userId)}%`;
	const emailLike = originalEmail ? `%${escapeSqlLike(originalEmail.trim().toLowerCase())}%` : null;
	const projectRows = await tx.unsafe<{ project_id: string; current_state: unknown }>(`
		SELECT project_id, current_state
		FROM projects
		WHERE deleted_at IS NULL
		  AND current_state IS NOT NULL
		  AND (
			current_state->'chapterTeam' @> $1::text::jsonb
			OR ($2::text IS NOT NULL AND current_state->'chapterTeam' @> $2::text::jsonb)
			OR current_state::text LIKE $3 ESCAPE '\\'
			OR ($4::text IS NOT NULL AND lower(current_state::text) LIKE lower($4) ESCAPE '\\')
		  )
		ORDER BY updated_at DESC, project_id DESC
		LIMIT $5
		FOR UPDATE
	`, [chapterTeamUserNeedle, chapterTeamEmailNeedle, userIdLike, emailLike, PROJECT_STATE_ERASURE_PROJECT_BATCH_CAP + 1]);
	if (projectRows.length > PROJECT_STATE_ERASURE_PROJECT_BATCH_CAP) {
		// Batch is FULL — the caller loops (processed rows stop matching the
		// needles, so the next SELECT returns the remainder). Flag it so the
		// outer loop knows to go again; a purge must never commit partial
		// coverage silently (review #599 P1).
		stats.truncated = true;
		projectRows.length = PROJECT_STATE_ERASURE_PROJECT_BATCH_CAP;
	}
	const changedProjectIds: string[] = [];
	for (const row of projectRows) {
		stats.projectsScanned += 1;
		const state = parseJsonbObject<ProjectState>(row.current_state);
		if (!state) continue;
		const stateStats = anonymizeProjectStatePiiForErasedUser(state, userId, originalEmail);
		if (!projectStatePiiStatsChanged(stateStats)) continue;
		addProjectStatePiiStats(stats, stateStats);
		await tx.unsafe(`
			UPDATE projects
			SET current_state = $2::text::jsonb,
				updated_at = now()
			WHERE project_id = $1
		`, [row.project_id, JSON.stringify(state)]);
		stats.projectsChanged += 1;
		changedProjectIds.push(row.project_id);
		stats.changedProjectIds.push(row.project_id);
	}
	if (changedProjectIds.length > 0) {
		await updatePostgresProjectDerivedPiiRows(tx, changedProjectIds, userId, originalEmail, stats);
	}
	// Runs UNGATED on changedProjectIds (review #599 r2 P1): these normalized
	// rows are keyed by the raw account id directly, so they must be scrubbed
	// even when every matching current_state was already rewritten by an earlier
	// (partial) pass and the needle SELECT above returns nothing.
	await scrubNormalizedProjectIdentityRowsOnClient(tx, userId, originalEmail, stats);
	await sweepPostgresProjectVersionPiiForErasedUser(tx, userId, originalEmail, stats);
	logProjectStatePiiSweep(userId, stats);
	return stats;
}

async function updatePostgresProjectDerivedPiiRows(
	tx: GdprSqlClient,
	projectIds: string[],
	userId: string,
	originalEmail: string | null,
	stats: ProjectStatePiiSweepStats,
): Promise<void> {
	const projectPlaceholders = projectIds.map((_, index) => `$${index + 3}`).join(", ");
	const commentRows = await tx.unsafe<{ comment_id: string }>(`
		UPDATE project_comments
		SET author_user_id = $1,
			metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{author}', to_jsonb($1::text), true),
			updated_at = now()
		WHERE project_id IN (${projectPlaceholders})
		  AND (
			author_user_id = $2
			OR metadata->>'author' = $2
			OR (
				$${projectIds.length + 3}::text IS NOT NULL
				AND (
					lower(author_user_id) = lower($${projectIds.length + 3})
					OR lower(metadata->>'author') = lower($${projectIds.length + 3})
				)
			)
		  )
		RETURNING comment_id
	`, [GDPR_ERASED_IDENTITY, userId, ...projectIds, originalEmail]);
	stats.projectCommentsChanged += commentRows.length;
	const decisionRows = await tx.unsafe<{ review_decision_id: string }>(`
		UPDATE project_review_decisions
		SET actor_user_id = $1,
			metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{actor}', to_jsonb($1::text), true),
			updated_at = now()
		WHERE project_id IN (${projectPlaceholders})
		  AND (
			actor_user_id = $2
			OR metadata->>'actor' = $2
			OR (
				$${projectIds.length + 3}::text IS NOT NULL
				AND (
					lower(actor_user_id) = lower($${projectIds.length + 3})
					OR lower(metadata->>'actor') = lower($${projectIds.length + 3})
				)
			)
		  )
		RETURNING review_decision_id
	`, [GDPR_ERASED_IDENTITY, userId, ...projectIds, originalEmail]);
	stats.reviewDecisionRowsChanged += decisionRows.length;
	const requesterRows = await tx.unsafe<{ version_review_id: string }>(`
		UPDATE project_version_reviews
		SET requester_user_id = $1,
			metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{requester}', to_jsonb($1::text), true),
			updated_at = now()
		WHERE project_id IN (${projectPlaceholders})
		  AND (
			requester_user_id = $2
			OR metadata->>'requester' = $2
			OR (
				$${projectIds.length + 3}::text IS NOT NULL
				AND (
					lower(requester_user_id) = lower($${projectIds.length + 3})
					OR lower(metadata->>'requester') = lower($${projectIds.length + 3})
				)
			)
		  )
		RETURNING version_review_id
	`, [GDPR_ERASED_IDENTITY, userId, ...projectIds, originalEmail]);
	const reviewerRows = await tx.unsafe<{ version_review_id: string }>(`
		UPDATE project_version_reviews
		SET reviewer_user_id = $1,
			metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{reviewer}', to_jsonb($1::text), true),
			updated_at = now()
		WHERE project_id IN (${projectPlaceholders})
		  AND (
			reviewer_user_id = $2
			OR metadata->>'reviewer' = $2
			OR (
				$${projectIds.length + 3}::text IS NOT NULL
				AND (
					lower(reviewer_user_id) = lower($${projectIds.length + 3})
					OR lower(metadata->>'reviewer') = lower($${projectIds.length + 3})
				)
			)
		  )
		RETURNING version_review_id
	`, [GDPR_ERASED_IDENTITY, userId, ...projectIds, originalEmail]);
	stats.versionReviewRowsChanged += new Set([...requesterRows, ...reviewerRows].map((row) => row.version_review_id)).size;
	if (originalEmail) {
		const deletePlaceholders = projectIds.map((_, index) => `$${index + 1}`).join(", ");
		const deletedInvites = await tx.unsafe<{ member_id: string }>(`
			DELETE FROM project_pending_invites
			WHERE project_id IN (${deletePlaceholders})
			  AND lower(invitee_email) = lower($${projectIds.length + 1})
			RETURNING member_id
		`, [...projectIds, originalEmail]);
		stats.pendingInviteRowsDeleted += deletedInvites.length;
	}
	const inviteUpdatePlaceholders = projectIds.map((_, index) => `$${index + 2}`).join(", ");
	const updatedInvites = await tx.unsafe<{ member_id: string }>(`
		UPDATE project_pending_invites
		SET invited_by = $1,
			updated_at = now()
		WHERE project_id IN (${inviteUpdatePlaceholders})
		  AND invited_by = $${projectIds.length + 2}
		RETURNING member_id
	`, [GDPR_ERASED_IDENTITY, ...projectIds, userId]);
	stats.pendingInviteRowsUpdated += updatedInvites.length;
}

/**
 * Scrub the NORMALIZED Postgres mirrors that hold the erased account id as a
 * plain column or text[] element (review #599 r2 P1): `projects.owner_user_id`,
 * task/review/revision queue assignees + their actor snapshots, and the
 * `mentions` arrays on comments/version reviews. These drive queue/index
 * queries, so leaving them raw keeps the erased user resolvable even after
 * every JSON state blob is clean. Global (not project-scoped) on purpose — the
 * account id is unique, each statement is idempotent, and project-scoping
 * would miss rows whose JSON was already rewritten by an earlier partial pass.
 * Mirrors the JSON anonymizer's replacement values exactly so the normalized
 * rows never diverge from the state they were derived from.
 */
async function scrubNormalizedProjectIdentityRowsOnClient(
	tx: GdprSqlClient,
	userId: string,
	originalEmail: string | null,
	stats: ProjectStatePiiSweepStats,
): Promise<void> {
	const ownerRows = await tx.unsafe<{ project_id: string }>(`
		UPDATE projects
		SET owner_user_id = $1,
			updated_at = now()
		WHERE owner_user_id = $2
		RETURNING project_id
	`, [GDPR_ERASED_IDENTITY, userId]);
	stats.ownerRowsChanged += ownerRows.length;
	const taskRows = await tx.unsafe<{ task_id: string }>(`
		UPDATE project_tasks
		SET assignee_user_id = $1,
			updated_at = now()
		WHERE assignee_user_id = $2
		RETURNING task_id
	`, [GDPR_ERASED_IDENTITY, userId]);
	stats.taskAssigneeRowsChanged += taskRows.length;
	// Handles are best-effort display snapshots and may hold the user's EMAIL,
	// so they get the same id-or-email match the JSON anonymizer applies.
	const assignmentRows = await tx.unsafe<{ assignment_id: string }>(`
		UPDATE project_review_assignments
		SET assignee_user_id = CASE WHEN assignee_user_id = $2 THEN $1 ELSE assignee_user_id END,
			assignee_handle = CASE WHEN assignee_handle = $2 OR ($3::text IS NOT NULL AND lower(assignee_handle) = lower($3)) THEN $1 ELSE assignee_handle END,
			assigned_by = CASE WHEN assigned_by = $2 OR ($3::text IS NOT NULL AND lower(assigned_by) = lower($3)) THEN $1 ELSE assigned_by END,
			cancelled_by = CASE WHEN cancelled_by = $2 OR ($3::text IS NOT NULL AND lower(cancelled_by) = lower($3)) THEN $1 ELSE cancelled_by END,
			updated_at = now()
		WHERE assignee_user_id = $2
		   OR assignee_handle = $2 OR ($3::text IS NOT NULL AND lower(assignee_handle) = lower($3))
		   OR assigned_by = $2 OR ($3::text IS NOT NULL AND lower(assigned_by) = lower($3))
		   OR cancelled_by = $2 OR ($3::text IS NOT NULL AND lower(cancelled_by) = lower($3))
		RETURNING assignment_id
	`, [GDPR_ERASED_IDENTITY, userId, originalEmail]);
	stats.reviewAssignmentRowsChanged += assignmentRows.length;
	const revisionRows = await tx.unsafe<{ revision_id: string }>(`
		UPDATE project_revision_requests
		SET assigned_to_user_id = CASE WHEN assigned_to_user_id = $2 THEN $1 ELSE assigned_to_user_id END,
			assigned_to_handle = CASE WHEN assigned_to_handle = $2 OR ($3::text IS NOT NULL AND lower(assigned_to_handle) = lower($3)) THEN $1 ELSE assigned_to_handle END,
			requested_by = CASE WHEN requested_by = $2 OR ($3::text IS NOT NULL AND lower(requested_by) = lower($3)) THEN $1 ELSE requested_by END,
			resolved_by = CASE WHEN resolved_by = $2 OR ($3::text IS NOT NULL AND lower(resolved_by) = lower($3)) THEN $1 ELSE resolved_by END,
			updated_at = now()
		WHERE assigned_to_user_id = $2
		   OR assigned_to_handle = $2 OR ($3::text IS NOT NULL AND lower(assigned_to_handle) = lower($3))
		   OR requested_by = $2 OR ($3::text IS NOT NULL AND lower(requested_by) = lower($3))
		   OR resolved_by = $2 OR ($3::text IS NOT NULL AND lower(resolved_by) = lower($3))
		RETURNING revision_id
	`, [GDPR_ERASED_IDENTITY, userId, originalEmail]);
	stats.revisionRequestRowsChanged += revisionRows.length;
	// text[] mention columns: rebuild the array element-by-element so an email
	// mention matches case-insensitively, preserving order via WITH ORDINALITY.
	const commentMentionRows = await tx.unsafe<{ comment_id: string }>(`
		UPDATE project_comments
		SET mentions = (
				SELECT array_agg(CASE WHEN u.m = $2 OR ($3::text IS NOT NULL AND lower(u.m) = lower($3)) THEN $1 ELSE u.m END ORDER BY u.ord)
				FROM unnest(mentions) WITH ORDINALITY AS u(m, ord)
			),
			updated_at = now()
		WHERE EXISTS (
			SELECT 1 FROM unnest(mentions) AS m
			WHERE m = $2 OR ($3::text IS NOT NULL AND lower(m) = lower($3))
		)
		RETURNING comment_id
	`, [GDPR_ERASED_IDENTITY, userId, originalEmail]);
	stats.mentionRowsChanged += commentMentionRows.length;
	const versionReviewMentionRows = await tx.unsafe<{ version_review_id: string }>(`
		UPDATE project_version_reviews
		SET mentions = (
				SELECT array_agg(CASE WHEN u.m = $2 OR ($3::text IS NOT NULL AND lower(u.m) = lower($3)) THEN $1 ELSE u.m END ORDER BY u.ord)
				FROM unnest(mentions) WITH ORDINALITY AS u(m, ord)
			),
			updated_at = now()
		WHERE EXISTS (
			SELECT 1 FROM unnest(mentions) AS m
			WHERE m = $2 OR ($3::text IS NOT NULL AND lower(m) = lower($3))
		)
		RETURNING version_review_id
	`, [GDPR_ERASED_IDENTITY, userId, originalEmail]);
	stats.mentionRowsChanged += versionReviewMentionRows.length;
}

async function sweepPostgresProjectVersionPiiForErasedUser(
	tx: GdprSqlClient,
	userId: string,
	originalEmail: string | null,
	stats: ProjectStatePiiSweepStats,
): Promise<void> {
	const userIdLike = `%${escapeSqlLike(userId)}%`;
	const emailLike = originalEmail ? `%${escapeSqlLike(originalEmail.trim().toLowerCase())}%` : null;
	const versionRows = await tx.unsafe<ProjectVersionPiiRow>(`
		SELECT version_id, project_id, metadata, state
		FROM project_versions
		WHERE metadata::text LIKE $1 ESCAPE '\\'
		   OR state::text LIKE $1 ESCAPE '\\'
		   OR ($2::text IS NOT NULL AND lower(metadata::text) LIKE lower($2) ESCAPE '\\')
		   OR ($2::text IS NOT NULL AND lower(state::text) LIKE lower($2) ESCAPE '\\')
		ORDER BY created_at DESC, version_id DESC
		LIMIT $3
		FOR UPDATE
	`, [userIdLike, emailLike, PROJECT_VERSION_ERASURE_BATCH_CAP + 1]);
	if (versionRows.length > PROJECT_VERSION_ERASURE_BATCH_CAP) {
		stats.truncated = true;
		versionRows.length = PROJECT_VERSION_ERASURE_BATCH_CAP;
	}
	for (const row of versionRows) {
		stats.versionsScanned += 1;
		const metadata = parseJsonbObject<ProjectVersionRecord["metadata"]>(row.metadata);
		const state = parseJsonbObject<ProjectState>(row.state);
		if (!metadata || !state) continue;
		const record: ProjectVersionRecord = { metadata, state };
		const result = anonymizeProjectVersionRecordPii(record, userId, originalEmail);
		if (!result.changed) continue;
		addProjectStatePiiStats(stats, result.stateStats);
		if (result.metadataAuthorChanged) stats.versionAuthors += 1;
		await tx.unsafe(`
			UPDATE project_versions
			SET metadata = $3::text::jsonb,
				state = $4::text::jsonb
			WHERE project_id = $1
			  AND version_id = $2
		`, [row.project_id, row.version_id, JSON.stringify(record.metadata), JSON.stringify(record.state)]);
		stats.versionsChanged += 1;
	}
}

/**
 * The PII columns the right-to-erasure purge irreversibly scrubs (identical in
 * both store backends): email → stable tombstone (frees + redacts the address),
 * name → "[deleted user]", passwordHash/password_hash → empty (no credential can
 * authenticate), external SSO identities + external subject → dropped,
 * email_verified → false, isActive stays false, tokensValidFromMs bumped so any
 * lingering access JWT is rejected.
 *
 * File-mode applies these inline in MemoryGdprStore.purgeSoftDeletedUser (so the
 * read can be separated from the destructive write for the P2 synchronous
 * re-check); Postgres applies them via the transaction-scoped helper below.
 *
 * `scrubAuthUserPiiOnClient` runs the scrub via direct SQL on the SUPPLIED client
 * so it executes on the SAME connection/transaction as the soft-delete-marker CAS
 * — that is what makes the Postgres purge atomic (going through the auth-user
 * store would use a DIFFERENT connection and so could not share a txn, leaving a
 * crash window where markers are cleared but PII remains). It also writes
 * email_normalized so the original address is freed and the UNIQUE index holds.
 * The caller does the SSO-identity DELETE (kept explicit at the call site so the
 * atomic unit is obvious). Idempotent: a row that is already a purge tombstone
 * returns `alreadyAnonymized` without rewriting it.
 */
async function scrubAuthUserPiiOnClient(
	tx: GdprSqlClient,
	userId: string,
): Promise<{ changed: boolean; tombstoneEmail: string; alreadyAnonymized: boolean; userMissing: boolean; originalEmail: string | null }> {
	const tombstoneEmail = purgeTombstoneEmail(userId);
	// `deletion_original_email` holds the subject's REAL original email, stashed at
	// soft-delete time BEFORE `email` was redacted to the `deleted+<id>` alias. We
	// derive the invite-erasure key from it — NOT from the live `email`, which is
	// already the redacted alias by purge time (invites to the original address
	// would otherwise be missed and left as PII). Fall back to a non-redacted live
	// email for rows soft-deleted before this column existed.
	const existing = await tx.unsafe<{ email: string; deletion_original_email: string | null }>(
		`SELECT email, deletion_original_email FROM auth_users WHERE user_id = $1 LIMIT 1`,
		[userId],
	);
	const row = existing[0];
	if (!row) return { changed: false, tombstoneEmail, alreadyAnonymized: false, userMissing: true, originalEmail: null };
	if (isAnonymizedTombstoneEmail(row.email)) {
		return { changed: false, tombstoneEmail, alreadyAnonymized: true, userMissing: false, originalEmail: null };
	}
	const stashedOriginal = typeof row.deletion_original_email === "string" && row.deletion_original_email.length > 0
		? row.deletion_original_email
		: null;
	// Legacy fallback: pre-stash rows whose live email was never redacted (e.g.
	// soft-deleted before this column shipped, or via a path that left the original
	// in place) still carry their original address in `email`.
	const originalEmail = stashedOriginal
		?? (isAnonymizedTombstoneEmail(row.email) ? null : (row.email.startsWith("deleted+") ? null : row.email));
	await tx.unsafe(`
		UPDATE auth_users
		SET email = $2,
			email_normalized = $2,
			name = '[deleted user]',
			password_hash = '',
			is_active = false,
			email_verified = false,
			external_subject = NULL,
			deletion_original_email = NULL,
			tokens_valid_from_ms = $3,
			updated_at = now()
		WHERE user_id = $1
	`, [userId, tombstoneEmail, Date.now()]);
	return { changed: true, tombstoneEmail, alreadyAnonymized: false, userMissing: false, originalEmail };
}

/**
 * P1 erasure-completeness: scrub the PII the right-to-erasure subject left in the
 * ANCILLARY tables — the consent log, workspace invites, the notification inbox,
 * support-ticket messages, and workspace memberships. Runs on the SUPPLIED tx
 * client so it commits ATOMICALLY with the auth_users scrub above: a crash before
 * COMMIT rolls the WHOLE purge back, the soft-delete markers stay set, and the next
 * sweep re-selects the user. Each statement is idempotent (a second purge matches
 * zero rows once the PII is gone) so re-runs are safe.
 *
 * What it removes and why:
 *   * consent_events — null `ip_address` + `user_agent` (the only direct PII; the
 *     row itself is the compliance record of consent and is kept, anonymized).
 *   * workspace_invites — replace the clear-text invitee `email` with a tombstone
 *     for invites addressed to the subject's ORIGINAL email (passed in, since the
 *     auth row is already tombstoned by the time this runs).
 *   * notifications — DELETE the subject's inbox (titles/bodies can quote PII and
 *     are entirely the subject's personal data).
 *   * support_ticket_messages — anonymize the BODY of messages the subject authored
 *     (the thread is kept for the other party / audit, but the free-text PII is
 *     scrubbed).
 *   * support_tickets.subject — the ticket SUBJECT is user free-text (it can quote
 *     PII, e.g. "Refund for jane@x.com"), so anonymize the subject of tickets the
 *     subject opened. The row is kept (audit / the agent thread), only the PII text
 *     is scrubbed.
 *   * workspace_members — DELETE the subject's memberships so no orphaned row points
 *     at the erased user id.
 *   * password_resets / email_verification_tokens — DELETE the subject's rows. These
 *     hold token_hash + ip_address (+ user_agent on resets) and ONLY cascade on a
 *     HARD delete of auth_users, which the purge never does (it tombstones the row),
 *     so without an explicit delete the token PII would survive erasure forever.
 *   * projects.current_state / project_versions — anonymize server-authored
 *     identity snapshots (chapter team, comment authors, activity actors, version
 *     authors) so historical ProjectState JSON cannot preserve the erased account.
 *   * auth_login_failures — DELETE the subject's brute-force log rows. They store the
 *     RAW login email + ip and are keyed by email (no user_id), so we match the
 *     subject's ORIGINAL email case-insensitively. This is account-security PII tied
 *     to the erased identity; once the account is gone the retention basis lapses.
 *     CRITICAL: bound the delete to `failure_at <= softDeletedAt` (the subject's
 *     soft-delete instant). Because soft-delete frees the normalized email for
 *     REUSE, a LATER account can register the same email and accrue its OWN
 *     failure/lockout rows; those are stamped AFTER this subject was soft-deleted,
 *     so the time bound leaves the live account's brute-force evidence intact and
 *     only erases the rows that belonged to the erased identity. When the
 *     soft-delete timestamp is unavailable (legacy callers), fall back to the
 *     unbounded delete rather than skip — the worst case then matches the prior
 *     behaviour.
 */
async function purgeAncillaryPiiOnClient(
	tx: GdprSqlClient,
	userId: string,
	originalEmail: string | null,
	softDeletedAt: Date | string | null,
): Promise<void> {
	await tx.unsafe(
		`UPDATE consent_events SET ip_address = NULL, user_agent = NULL WHERE user_id = $1 AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)`,
		[userId],
	);
	if (originalEmail && !isAnonymizedTombstoneEmail(originalEmail)) {
		// workspace_invites stores the invitee email lowercased (see acceptInvite's
		// `email !== input.email.trim().toLowerCase()` check), so match case-insensitively.
		await tx.unsafe(
			`UPDATE workspace_invites SET email = $2 WHERE lower(email) = lower($1)`,
			[originalEmail, purgeTombstoneEmail(userId)],
		);
		// auth_login_failures is keyed by the RAW login email (no user_id column), so we
		// can only reach the subject's rows via their original email. Match
		// case-insensitively (the tracker stores normalizeEmail() = lowercased).
		// TIME BOUND (P1): only delete rows stamped AT/BEFORE the subject's soft-delete
		// instant. Soft-delete frees the normalized email for reuse, so a LATER active
		// account can own the same email and accrue its OWN lockout rows (all stamped
		// AFTER this instant); the bound preserves that live account's brute-force
		// evidence and erases only the rows that belonged to the erased identity.
		await tx.unsafe(
			`DELETE FROM auth_login_failures
			 WHERE lower(email) = lower($1)
			   AND ($2::timestamptz IS NULL OR failure_at <= $2::timestamptz)`,
			[originalEmail, softDeletedAt],
		);
	}
	await tx.unsafe(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
	await tx.unsafe(
		`UPDATE support_ticket_messages SET body = '[deleted user message]' WHERE author_user_id = $1 AND body <> '[deleted user message]'`,
		[userId],
	);
	await tx.unsafe(
		`UPDATE support_tickets SET subject = '[deleted user ticket]' WHERE requester_user_id = $1 AND subject <> '[deleted user ticket]'`,
		[userId],
	);
	await tx.unsafe(`DELETE FROM workspace_members WHERE user_id = $1`, [userId]);
	// Auth-flow tokens cascade ONLY on a hard auth_users delete; the purge tombstones
	// (never deletes) the row, so we MUST drop these explicitly or the token_hash +
	// ip_address (+ user_agent) survive erasure. Keyed by user_id.
	await tx.unsafe(`DELETE FROM password_resets WHERE user_id = $1`, [userId]);
	await tx.unsafe(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
	// Loop until the sweep drains: each pass rewrites matched rows, so the
	// needles stop matching them and the next SELECT returns the remainder.
	// A bounded number of passes guards a pathological needle that never stops
	// matching (e.g. placeholder collides) — then we ABORT the purge instead of
	// committing partial coverage (review #599 P1: fail closed on truncation).
	for (let pass = 0; ; pass++) {
		const sweepStats = await purgeProjectStatePiiOnClient(tx, userId, originalEmail);
		if (!sweepStats.truncated) break;
		if (pass >= 50) {
			throw new Error("GDPR project-state sweep did not converge after 50 batches; aborting purge so no partial erasure is committed");
		}
	}
}

/**
 * File-mode counterpart to `purgeAncillaryPiiOnClient`: erase the PII the subject
 * left in the OTHER in-memory/file stores (workspace invites + memberships,
 * notification inbox, support-ticket messages + subjects, auth-flow tokens). Each
 * store exposes a narrow `erasePiiForUser`/`eraseForUser` hook so the GDPR purge
 * does not need to reach into their internals. Best-effort + idempotent — any store
 * failure is logged, not fatal, and a re-run matches nothing once the PII is
 * already gone. (Postgres erases the same data atomically inside the purge
 * transaction.)
 *
 * NOTE on auth_login_failures: that brute-force log is backed ONLY by Postgres /
 * Redis (there is no file store), so the postgres purge transaction is the only
 * place that can scrub it; file-mode has no such rows to erase here.
 */
async function eraseAncillaryPiiInMemoryStores(userId: string, originalEmail: string | null): Promise<void> {
	const erase = async (label: string, fn: () => Promise<void> | void) => {
		try {
			await fn();
		} catch (error) {
			console.warn(`[gdpr] erasure: ${label} PII scrub failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	await erase("notifications", async () => {
		const { notificationStore } = await import("./notifications.js");
		await notificationStore.erasePiiForUser?.(userId);
	});
	await erase("support-tickets", async () => {
		const { supportTicketStore } = await import("./support-tickets.js");
		await supportTicketStore.erasePiiForUser?.(userId);
	});
	await erase("workspace-access", async () => {
		const { workspaceAccessStore } = await import("./workspace-access.js");
		await workspaceAccessStore.erasePiiForUser?.(userId, originalEmail ?? undefined);
	});
	await erase("auth-flow-tokens", async () => {
		// Password-reset + email-verification tokens carry token_hash + ip_address
		// (+ user_agent). The file store keys them by userId, so erase by id.
		const { authFlowTokenStore } = await import("./password-reset.js");
		await authFlowTokenStore.eraseForUser?.(userId);
	});
}

export class MemoryGdprStore implements GdprStore {
	private readonly consents: ConsentEvent[] = [];
	private readonly exports = new Map<string, AccountExportJob>();
	private readonly softDeletes = new Map<string, SoftDeleteSnapshot>();
	private readonly impersonations: ImpersonationEvent[] = [];
	private readonly adminAudit: AdminAuditEntry[] = [];

	private readonly snapshotPath?: string;

	constructor(options: { snapshotPath?: string } = {}) {
		if (options.snapshotPath) {
			this.snapshotPath = options.snapshotPath;
			this.restore();
		}
	}

	async recordConsent(input: RecordConsentInput): Promise<ConsentEvent> {
		const event: ConsentEvent = {
			id: randomUUID(),
			userId: input.userId ?? null,
			consentType: input.consentType,
			categories: { ...input.categories },
			grantedAt: new Date().toISOString(),
			ipAddress: input.ipAddress ?? null,
			userAgent: input.userAgent ?? null,
			policyVersion: input.policyVersion,
			deviceId: input.deviceId ?? null,
		};
		this.consents.push(event);
		this.persist();
		return event;
	}

	async listConsentEvents(userId: string, options: { limit?: number } = {}): Promise<ConsentEvent[]> {
		const limit = options.limit ?? 100;
		return this.consents
			.filter((event) => event.userId === userId)
			.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
			.slice(0, limit);
	}

	async createExportJob(userId: string): Promise<AccountExportJob> {
		const job: AccountExportJob = {
			id: randomUUID(),
			userId,
			status: "queued",
			zipUrl: null,
			failureReason: null,
			bytes: null,
			expiresAt: null,
			createdAt: new Date().toISOString(),
			completedAt: null,
		};
		this.exports.set(job.id, job);
		this.persist();
		return job;
	}

	async getExportJob(jobId: string): Promise<AccountExportJob | null> {
		return this.exports.get(jobId) ?? null;
	}

	async listExportJobs(userId: string): Promise<AccountExportJob[]> {
		return [...this.exports.values()]
			.filter((job) => job.userId === userId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async updateExportJob(jobId: string, patch: Partial<AccountExportJob>): Promise<AccountExportJob | null> {
		const current = this.exports.get(jobId);
		if (!current) return null;
		const next = { ...current, ...patch };
		this.exports.set(jobId, next);
		this.persist();
		return next;
	}

	async softDeleteUser(userId: string, options: { gracePeriodMs: number }): Promise<SoftDeleteSnapshot | null> {
		const existing = this.softDeletes.get(userId);
		if (existing) return existing;
		const { authUserStore } = await import("./auth-users.js");
		const user = await authUserStore.load(userId);
		if (!user) return null;
		const now = new Date();
		const graceUntil = new Date(now.getTime() + options.gracePeriodMs);
		const snapshot: SoftDeleteSnapshot = {
			userId,
			deletedAt: now.toISOString(),
			deleteGraceUntil: graceUntil.toISOString(),
			originalEmail: user.email,
			redactedEmail: `deleted+${userId}@redacted.invalid`,
		};
		// SECURITY (fail-closed): disabling the account must run through the SAME
		// atomic, owner-protected mutation the admin routes use. A self-service
		// DELETE /api/account by the platform's last active owner would otherwise
		// drop the active-owner count to zero and lock everyone out permanently.
		// updateProtectingLastOwner re-checks the live owner population inside its
		// critical section / transaction and throws LastPlatformOwnerError when this
		// disable would orphan the platform. We do the guarded write FIRST and only
		// record the soft-delete snapshot on success, so a blocked last-owner delete
		// leaves the row fully intact (role=owner, isActive=true, original email) —
		// no scramble, no pending-deletion bookkeeping. The route maps the thrown
		// error to 403. Non-owners, and owners while another active owner remains,
		// are unaffected and delete exactly as before.
		//
		// Rewrites the live row so the email is freed for re-registration and the
		// account is disabled even before hard-delete runs. We never restore the
		// original email on undo (cf. restoreUser) — the user gets a redacted alias
		// because the original email could already be in use elsewhere.
		await authUserStore.updateProtectingLastOwner(userId, { email: snapshot.redactedEmail, isActive: false });
		this.softDeletes.set(userId, snapshot);
		this.persist();
		return snapshot;
	}

	async restoreUser(userId: string): Promise<boolean> {
		const snapshot = this.softDeletes.get(userId);
		if (!snapshot) return false;
		// DEFENSE IN DEPTH (retention contract): never reactivate an account once
		// its undo window has elapsed. Past grace the row is a live purge candidate;
		// reviving it would resurrect data we promised to erase. Throw so any caller
		// that skipped the route-level grace check still fails closed (route → 410).
		if (!isRestoreGraceValid(snapshot.deleteGraceUntil)) {
			throw new RestoreGraceExpiredError();
		}
		const { authUserStore } = await import("./auth-users.js");
		// Best-effort restore: re-enable the account but leave email as the
		// redacted alias if the original is no longer free. The user re-sets it
		// via /api/auth/change-email after login.
		const existingWithOriginal = await authUserStore.findByEmail(snapshot.originalEmail);
		const canReclaimEmail = !existingWithOriginal || existingWithOriginal.id === userId;
		await authUserStore.update(userId, {
			isActive: true,
			email: canReclaimEmail ? snapshot.originalEmail : snapshot.redactedEmail,
		});
		this.softDeletes.delete(userId);
		this.persist();
		return true;
	}

	async listExpiredSoftDeletes(now: Date = new Date()): Promise<Array<{ userId: string; deleteGraceUntil: string }>> {
		const cutoff = now.toISOString();
		return [...this.softDeletes.values()]
			.filter((entry) => entry.deleteGraceUntil <= cutoff)
			.map((entry) => ({ userId: entry.userId, deleteGraceUntil: entry.deleteGraceUntil }));
	}

	async listPendingSoftDeletes(): Promise<Array<{ userId: string; deletedAt: string; deleteGraceUntil: string }>> {
		return [...this.softDeletes.values()].map((entry) => ({
			userId: entry.userId,
			deletedAt: entry.deletedAt,
			deleteGraceUntil: entry.deleteGraceUntil,
		}));
	}

	async getPendingSoftDelete(userId: string): Promise<{ userId: string; deletedAt: string; deleteGraceUntil: string } | null> {
		const entry = this.softDeletes.get(userId);
		return entry
			? { userId: entry.userId, deletedAt: entry.deletedAt, deleteGraceUntil: entry.deleteGraceUntil }
			: null;
	}

	async purgeSoftDeletedUser(userId: string, expected?: PurgeDeletionContext): Promise<PurgeResult> {
		const snapshot = this.softDeletes.get(userId);
		// Not (or no longer) tracked as pending → already purged/restored → no-op.
		if (!snapshot) {
			// The auth row may still carry the tombstone from a prior purge whose
			// snapshot was already cleared; report that honestly for idempotency.
			const { authUserStore } = await import("./auth-users.js");
			const user = await authUserStore.load(userId);
			if (!user) return { userId, purged: false, reason: "user_missing" };
			if (isAnonymizedTombstoneEmail(user.email)) return { userId, purged: false, reason: "already_anonymized" };
			return { userId, purged: false, reason: "not_soft_deleted" };
		}
		// RACE GUARD (P1a): re-check the deletion markers against the context the
		// candidate was selected with. JS is single-threaded between the await-free
		// `softDeletes.get` above and these comparisons, so a concurrent restore
		// (which deletes the snapshot) or restore-then-redelete (which writes a NEW
		// snapshot with a fresh deletedAt + future grace) cannot slip a still-in-
		// undo-window row past this check. If ANY gate no longer holds, SKIP — no
		// purge, no error.
		if (expected && !softDeleteMarkersStillMatch(snapshot, expected)) {
			return { userId, purged: false, reason: "markers_changed" };
		}
		// P2 (await-interleave): the destructive PII write awaits (load → save), which
		// YIELDS the event loop. A concurrent restore (deletes the snapshot) or
		// restore-then-redelete (writes a FRESH snapshot now inside a NEW undo window)
		// can land in that window. The OLD code did the marker check, THEN awaited the
		// scrub, THEN deleted the snapshot + persisted — so an interleaved redelete's
		// FRESH marker was both scrubbed and removed.
		//
		// Fix (per the "scrub into a local, re-check + persist synchronously" model):
		//   1. Read-only load the auth row (await) and BUILD the scrubbed row into a
		//      local — NO DB write yet, so this await window touches nothing.
		//   2. RE-VERIFY the markers SYNCHRONOUSLY against the captured `expected`
		//      context, then delete the pending-deletion snapshot + persist, with NO
		//      await between the re-check and that mutation. If a restore/redelete
		//      slipped into the load await, the snapshot is gone or carries a fresh
		//      window → ABORT (no scrub, no marker delete), report markers_changed.
		//   3. Only AFTER the snapshot (the sweep-selection marker) is removed under a
		//      matching context do we commit the scrubbed row.
		const { authUserStore } = await import("./auth-users.js");
		const user = await authUserStore.load(userId);
		const tombstoneEmail = purgeTombstoneEmail(userId);
		const scrubbedUser = user
			? {
				...user,
				email: tombstoneEmail,
				name: "[deleted user]",
				passwordHash: "",
				isActive: false,
				emailVerified: false,
				externalSubject: undefined,
				externalIdentities: [],
				tokensValidFromMs: Date.now(),
				updatedAt: new Date().toISOString(),
			}
			: null;
		// ── SYNCHRONOUS authoritative re-check + marker persist (no await) ──
		const liveSnapshot = this.softDeletes.get(userId);
		if (!liveSnapshot) {
			// Restored / already purged during the load await → snapshot already gone.
			if (user && isAnonymizedTombstoneEmail(user.email)) return { userId, purged: false, reason: "already_anonymized" };
			return { userId, purged: false, reason: "not_soft_deleted" };
		}
		if (expected && !softDeleteMarkersStillMatch(liveSnapshot, expected)) {
			// Restore-then-redelete during the load await stamped a FRESH undo window →
			// abort without scrubbing PII or removing the fresh marker.
			return { userId, purged: false, reason: "markers_changed" };
		}
		if (!user || !scrubbedUser) {
			this.softDeletes.delete(userId);
			this.persist();
			return { userId, purged: false, reason: "user_missing" };
		}
		if (isAnonymizedTombstoneEmail(user.email)) {
			this.softDeletes.delete(userId);
			this.persist();
			return { userId, purged: false, reason: "already_anonymized" };
		}
		// File-mode has no DB transaction to fold ProjectState JSON into. Run the
		// atomic state-file scrub before removing the purge marker, while the original
		// email snapshot is still available for email-only invites/comments.
		const projectPiiSweep = sweepFileProjectStatePiiForErasedUserSync(userId, liveSnapshot.originalEmail ?? null);
		// Markers still match. Remove the pending-deletion marker FIRST (synchronously,
		// right after the re-check) so a redelete during the PII save below can only
		// create a NEW snapshot a later sweep handles — it cannot retroactively cancel
		// this purge or have its fresh marker silently deleted.
		this.softDeletes.delete(userId);
		// Scrub the consent-log PII (IP / user-agent) the subject left in THIS store,
		// synchronously, before persisting — the consent record itself stays as the
		// compliance proof, anonymized.
		for (const event of this.consents) {
			if (event.userId === userId && (event.ipAddress !== null || event.userAgent !== null)) {
				event.ipAddress = null;
				event.userAgent = null;
			}
		}
		this.persist();
		// ── end synchronous section; commit the already-built scrub ──
		await authUserStore.save(scrubbedUser);
		// Erase the PII the subject left in the ancillary stores (invite emails,
		// notification inbox, support messages, memberships). Best-effort in file
		// mode — Postgres does this atomically in one transaction. A failure here is
		// logged but does not un-anonymize the auth row (already committed above).
		//
		// P1 (GDPR erasure-completeness): invite erasure keys off the subject's REAL
		// ORIGINAL email. The live auth row was ALREADY redacted to the soft-delete
		// alias (`deleted+<id>@redacted.invalid`) at delete time, so `user.email` here
		// is the alias, NOT the address invites were sent to. Pass the original email
		// captured in the (re-verified) soft-delete snapshot BEFORE the redaction
		// rewrite, so invites addressed to the actual original email are anonymized —
		// not left as PII.
		const originalEmail = liveSnapshot.originalEmail ?? null;
		await eraseAncillaryPiiInMemoryStores(userId, originalEmail);
		await syncPendingInviteIndexAfterFileSweep(projectPiiSweep, join(DATA_DIR, "projects"));
		logProjectStatePiiSweep(userId, projectPiiSweep);
		return { userId, purged: true, tombstoneEmail };
	}

	async startImpersonation(adminUserId: string, impersonatedUserId: string, reason: string | null): Promise<ImpersonationEvent> {
		const event: ImpersonationEvent = {
			id: randomUUID(),
			adminUserId,
			impersonatedUserId,
			reason,
			startedAt: new Date().toISOString(),
			endedAt: null,
		};
		this.impersonations.push(event);
		this.persist();
		return event;
	}

	async endImpersonation(id: string): Promise<ImpersonationEvent | null> {
		const event = this.impersonations.find((entry) => entry.id === id);
		if (!event || event.endedAt) return event ?? null;
		event.endedAt = new Date().toISOString();
		this.persist();
		return event;
	}

	async listImpersonations(options: { adminUserId?: string; targetUserId?: string; limit?: number } = {}): Promise<ImpersonationEvent[]> {
		const limit = options.limit ?? 100;
		return this.impersonations
			.filter((event) => {
				if (options.adminUserId && event.adminUserId !== options.adminUserId) return false;
				if (options.targetUserId && event.impersonatedUserId !== options.targetUserId) return false;
				return true;
			})
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, limit);
	}

	async recordAdminAudit(input: { adminUserId: string; action: string; actorRole?: string | null; targetKind?: string | null; targetId?: string | null; detail?: Record<string, unknown> }): Promise<AdminAuditEntry> {
		const actorRole = await resolveActorRole(input.adminUserId, input.actorRole);
		const entry: AdminAuditEntry = {
			id: randomUUID(),
			adminUserId: input.adminUserId,
			actorRole,
			action: input.action,
			targetKind: input.targetKind ?? null,
			targetId: input.targetId ?? null,
			detail: input.detail ?? {},
			createdAt: new Date().toISOString(),
		};
		this.adminAudit.push(entry);
		this.persist();
		return entry;
	}

	async listAdminAudit(options: { adminUserId?: string; action?: string; actorRole?: string; targetKind?: string; targetId?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number } = {}): Promise<{ entries: AdminAuditEntry[]; total: number }> {
		const limit = options.limit ?? 50;
		const offset = options.offset ?? 0;
		const filtered = this.adminAudit
			.filter((entry) => {
				if (options.adminUserId && entry.adminUserId !== options.adminUserId) return false;
				if (options.action && entry.action !== options.action) return false;
				if (options.actorRole && entry.actorRole !== options.actorRole) return false;
				if (options.targetKind && entry.targetKind !== options.targetKind) return false;
				if (options.targetId && entry.targetId !== options.targetId) return false;
				if (options.fromDate) {
					const entryTime = new Date(entry.createdAt).getTime();
					const fromTime = new Date(options.fromDate).getTime();
					if (!isNaN(fromTime) && entryTime < fromTime) return false;
				}
				if (options.toDate) {
					const entryTime = new Date(entry.createdAt).getTime();
					const toTime = new Date(options.toDate).getTime();
					if (!isNaN(toTime) && entryTime > toTime) return false;
				}
				return true;
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return {
			entries: filtered.slice(offset, offset + limit),
			total: filtered.length,
		};
	}

	private persist(): void {
		if (!this.snapshotPath) return;
		try {
			mkdirSync(join(this.snapshotPath, ".."), { recursive: true });
			const snapshot: GdprSnapshot = {
				consents: this.consents,
				exports: [...this.exports.values()],
				softDeletes: Object.fromEntries(this.softDeletes.entries()),
				impersonations: this.impersonations,
				adminAudit: this.adminAudit,
			};
			writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2));
		} catch {
			// Persistence is best-effort for the file store. Production uses Postgres.
		}
	}

	private restore(): void {
		if (!this.snapshotPath || !existsSync(this.snapshotPath)) return;
		try {
			const snapshot = readJsonFile<GdprSnapshot>(this.snapshotPath);
			this.consents.push(...(snapshot.consents ?? []));
			for (const job of snapshot.exports ?? []) this.exports.set(job.id, job);
			for (const [id, entry] of Object.entries(snapshot.softDeletes ?? {})) this.softDeletes.set(id, entry);
			this.impersonations.push(...(snapshot.impersonations ?? []));
			// Old snapshots predate actor_role; default to null so the in-memory shape
			// matches AdminAuditEntry without inventing a role for legacy rows.
			for (const entry of snapshot.adminAudit ?? []) {
				this.adminAudit.push({ ...entry, actorRole: entry.actorRole ?? null });
			}
		} catch {
			// Corrupt snapshot — start fresh.
		}
	}
}

// ── Postgres store ────────────────────────────────────────────────

/**
 * Minimal SQL client seam mirroring the other Postgres stores
 * (support-tickets, auth-users). Accepting either a DATABASE_URL string or an
 * injected client lets tests drive the store against a real Postgres connection
 * (or a fake) without opening a fresh pool per call.
 */
export interface GdprSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	/**
	 * Run `fn` inside ONE database transaction. Bun.SQL exposes this natively; an
	 * injected test/fake client may omit it, in which case `runGdprTransaction`
	 * falls back to explicit BEGIN/COMMIT/ROLLBACK. Used to make the right-to-erasure
	 * purge atomic (clear soft-delete markers + scrub PII + drop SSO identities in a
	 * single all-or-nothing commit) so a crash mid-purge cannot leave a row that is
	 * no longer soft-deleted yet still carries PII.
	 */
	begin?<T>(fn: (transaction: GdprSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

/**
 * Run `fn` inside a DB transaction. Mirrors auth-users' `runTransaction`: delegate
 * to the client's native `begin` (Bun.SQL transactions) when present, otherwise
 * drive BEGIN/COMMIT/ROLLBACK explicitly so any GdprSqlClient — including a plain
 * `unsafe`-only fake — stays all-or-nothing. On any throw the work ROLLS BACK.
 */
async function runGdprTransaction<T>(
	client: GdprSqlClient,
	fn: (transaction: GdprSqlClient) => Promise<T>,
): Promise<T> {
	if (client.begin) return client.begin(fn);
	await client.unsafe("BEGIN");
	try {
		const result = await fn(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		await client.unsafe("ROLLBACK");
		throw error;
	}
}

// Test seam for the Postgres JSONB path. Production reaches the same helper from
// purgeAncillaryPiiOnClient inside the erasure transaction.
export async function sweepPostgresProjectStatePiiForErasedUser(
	client: GdprSqlClient,
	userId: string,
	originalEmail?: string | null,
): Promise<ProjectStatePiiSweepStats> {
	return purgeProjectStatePiiOnClient(client, userId, originalEmail ?? null);
}

// ── Row shapes (snake_case) → domain mappers ──────────────────────

interface ConsentRow {
	id: string;
	user_id: string | null;
	consent_type: string;
	categories: Record<string, boolean> | string | null;
	granted_at: Date | string;
	ip_address: string | null;
	user_agent: string | null;
	policy_version: string;
	device_id: string | null;
}

interface ExportJobRow {
	id: string;
	user_id: string;
	status: string;
	zip_url: string | null;
	failure_reason: string | null;
	bytes: number | string | null;
	expires_at: Date | string | null;
	created_at: Date | string;
	completed_at: Date | string | null;
}

interface ImpersonationRow {
	id: string;
	admin_user_id: string;
	impersonated_user_id: string;
	reason: string | null;
	started_at: Date | string;
	ended_at: Date | string | null;
}

interface AdminAuditRow {
	id: string;
	admin_user_id: string;
	actor_role: string | null;
	action: string;
	target_kind: string | null;
	target_id: string | null;
	detail: Record<string, unknown> | string | null;
	created_at: Date | string;
}

interface SoftDeleteRow {
	user_id: string;
	deleted_at: Date | string | null;
	delete_grace_until: Date | string | null;
}

function pgIso(value: Date | string | null | undefined): string {
	if (value instanceof Date) return value.toISOString();
	if (value === null || value === undefined) return new Date().toISOString();
	// timestamptz comes back as a string in some driver configs; normalize to ISO.
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function pgIsoOrNull(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return pgIso(value);
}

function pgJson(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
	if (value === null || value === undefined) return {};
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	return value;
}

function mapConsentRow(row: ConsentRow): ConsentEvent {
	return {
		id: row.id,
		userId: row.user_id ?? null,
		consentType: row.consent_type,
		categories: pgJson(row.categories) as Record<string, boolean>,
		grantedAt: pgIso(row.granted_at),
		ipAddress: row.ip_address ?? null,
		userAgent: row.user_agent ?? null,
		policyVersion: row.policy_version,
		deviceId: row.device_id ?? null,
	};
}

function mapExportRow(row: ExportJobRow): AccountExportJob {
	return {
		id: row.id,
		userId: row.user_id,
		status: row.status as ExportJobStatus,
		zipUrl: row.zip_url ?? null,
		failureReason: row.failure_reason ?? null,
		bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
		expiresAt: pgIsoOrNull(row.expires_at),
		createdAt: pgIso(row.created_at),
		completedAt: pgIsoOrNull(row.completed_at),
	};
}

function mapImpersonationRow(row: ImpersonationRow): ImpersonationEvent {
	return {
		id: row.id,
		adminUserId: row.admin_user_id,
		impersonatedUserId: row.impersonated_user_id,
		reason: row.reason ?? null,
		startedAt: pgIso(row.started_at),
		endedAt: pgIsoOrNull(row.ended_at),
	};
}

function mapAdminAuditRow(row: AdminAuditRow): AdminAuditEntry {
	return {
		id: row.id,
		adminUserId: row.admin_user_id,
		actorRole: row.actor_role ?? null,
		action: row.action,
		targetKind: row.target_kind ?? null,
		targetId: row.target_id ?? null,
		detail: pgJson(row.detail),
		createdAt: pgIso(row.created_at),
	};
}

const CONSENT_COLUMNS = `id, user_id, consent_type, categories, granted_at, ip_address, user_agent, policy_version, device_id`;
const EXPORT_COLUMNS = `id, user_id, status, zip_url, failure_reason, bytes, expires_at, created_at, completed_at`;
const IMPERSONATION_COLUMNS = `id, admin_user_id, impersonated_user_id, reason, started_at, ended_at`;
const ADMIN_AUDIT_COLUMNS = `id, admin_user_id, actor_role, action, target_kind, target_id, detail, created_at`;

/**
 * Postgres-backed GDPR / back-office store. Reads/writes the consent_events,
 * account_export_jobs, impersonation_events, and admin_audit tables (created in
 * migration 0044, extended with actor_role in 0057) plus the auth_users
 * soft-delete columns. Durable across restarts — that is the whole point: the
 * admin audit trail and impersonation log MUST survive a process bounce, which
 * MemoryGdprStore cannot guarantee.
 *
 * Soft-delete goes through authUserStore.updateProtectingLastOwner exactly like
 * MemoryGdprStore, so the last active platform owner cannot self-delete and
 * orphan the platform — the owner-guard lives in the auth store transaction and
 * is preserved on this path too.
 *
 * SCALAR BINDS ONLY: Bun.SQL cannot bind a JS array as a single $n::text[]
 * parameter, so no `= ANY($n::text[])` appears here. Every filter is a scalar
 * `column = $n` predicate.
 */
export class PostgresGdprStore implements GdprStore {
	private readonly client: GdprSqlClient;

	constructor(databaseUrlOrClient: string | GdprSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PostgresGdprStore requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as GdprSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async recordConsent(input: RecordConsentInput): Promise<ConsentEvent> {
		const rows = await this.client.unsafe<ConsentRow>(`
			INSERT INTO consent_events (id, user_id, consent_type, categories, ip_address, user_agent, policy_version, device_id)
			VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8)
			RETURNING ${CONSENT_COLUMNS}
		`, [
			randomUUID(),
			input.userId ?? null,
			input.consentType,
			JSON.stringify(input.categories ?? {}),
			input.ipAddress ?? null,
			input.userAgent ?? null,
			input.policyVersion,
			input.deviceId ?? null,
		]);
		const row = rows[0];
		if (!row) throw new Error("consent_events INSERT did not return a row");
		return mapConsentRow(row);
	}

	async listConsentEvents(userId: string, options: { limit?: number } = {}): Promise<ConsentEvent[]> {
		const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 1000));
		const rows = await this.client.unsafe<ConsentRow>(`
			SELECT ${CONSENT_COLUMNS}
			FROM consent_events
			WHERE user_id = $1
			ORDER BY granted_at DESC, id DESC
			LIMIT $2
		`, [userId, limit]);
		return rows.map(mapConsentRow);
	}

	async createExportJob(userId: string): Promise<AccountExportJob> {
		const rows = await this.client.unsafe<ExportJobRow>(`
			INSERT INTO account_export_jobs (id, user_id, status)
			VALUES ($1, $2, 'queued')
			RETURNING ${EXPORT_COLUMNS}
		`, [randomUUID(), userId]);
		const row = rows[0];
		if (!row) throw new Error("account_export_jobs INSERT did not return a row");
		return mapExportRow(row);
	}

	async getExportJob(jobId: string): Promise<AccountExportJob | null> {
		const rows = await this.client.unsafe<ExportJobRow>(`
			SELECT ${EXPORT_COLUMNS} FROM account_export_jobs WHERE id = $1
		`, [jobId]);
		return rows[0] ? mapExportRow(rows[0]) : null;
	}

	async listExportJobs(userId: string): Promise<AccountExportJob[]> {
		const rows = await this.client.unsafe<ExportJobRow>(`
			SELECT ${EXPORT_COLUMNS}
			FROM account_export_jobs
			WHERE user_id = $1
			ORDER BY created_at DESC, id DESC
		`, [userId]);
		return rows.map(mapExportRow);
	}

	async updateExportJob(jobId: string, patch: Partial<Pick<AccountExportJob, "status" | "zipUrl" | "failureReason" | "bytes" | "expiresAt" | "completedAt">>): Promise<AccountExportJob | null> {
		const sets: string[] = [];
		const params: unknown[] = [jobId];
		const push = (column: string, value: unknown) => {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		};
		if (patch.status !== undefined) push("status", patch.status);
		if (patch.zipUrl !== undefined) push("zip_url", patch.zipUrl);
		if (patch.failureReason !== undefined) push("failure_reason", patch.failureReason);
		if (patch.bytes !== undefined) push("bytes", patch.bytes);
		if (patch.expiresAt !== undefined) push("expires_at", patch.expiresAt);
		if (patch.completedAt !== undefined) push("completed_at", patch.completedAt);
		if (sets.length === 0) return this.getExportJob(jobId);
		const rows = await this.client.unsafe<ExportJobRow>(`
			UPDATE account_export_jobs
			SET ${sets.join(", ")}
			WHERE id = $1
			RETURNING ${EXPORT_COLUMNS}
		`, params);
		return rows[0] ? mapExportRow(rows[0]) : null;
	}

	async softDeleteUser(userId: string, options: { gracePeriodMs: number }): Promise<SoftDeleteSnapshot | null> {
		// Idempotent: a row already pending deletion returns its existing snapshot.
		const existingRows = await this.client.unsafe<SoftDeleteRow>(`
			SELECT user_id, deleted_at, delete_grace_until
			FROM auth_users
			WHERE user_id = $1 AND deleted_at IS NOT NULL
		`, [userId]);
		const existing = existingRows[0];
		const { authUserStore } = await import("./auth-users.js");
		const user = await authUserStore.load(userId);
		if (!user) return null;
		if (existing) {
			return {
				userId,
				deletedAt: pgIso(existing.deleted_at),
				deleteGraceUntil: pgIso(existing.delete_grace_until),
				originalEmail: user.email,
				redactedEmail: user.email,
			};
		}
		const now = new Date();
		const graceUntil = new Date(now.getTime() + options.gracePeriodMs);
		const snapshot: SoftDeleteSnapshot = {
			userId,
			deletedAt: now.toISOString(),
			deleteGraceUntil: graceUntil.toISOString(),
			originalEmail: user.email,
			redactedEmail: `deleted+${userId}@redacted.invalid`,
		};
		// SECURITY (fail-closed): the disabling write MUST run through the same
		// owner-protected, atomic mutation the admin routes use. A self-service
		// delete by the platform's last active owner would otherwise orphan the
		// platform. updateProtectingLastOwner re-checks the live owner population
		// inside its transaction and throws LastPlatformOwnerError when this would
		// drop the active-owner count to zero. We do the guarded write FIRST and
		// only stamp deleted_at / delete_grace_until on success, so a blocked
		// last-owner delete leaves the row fully intact (role=owner, isActive=true,
		// original email) — no scramble, no pending-deletion bookkeeping. The route
		// maps the thrown error to 403.
		await authUserStore.updateProtectingLastOwner(userId, { email: snapshot.redactedEmail, isActive: false });
		// P1 (GDPR erasure-completeness): stash the REAL original email captured
		// BEFORE the redaction rewrite above. The anonymizing purge keys invite
		// erasure off this address; by purge time the live `email` is the redacted
		// alias, so without this stash invites addressed to the original email are
		// never matched. The purge transaction reads then NULLs this column atomically.
		await this.client.unsafe(`
			UPDATE auth_users
			SET deleted_at = $2, delete_grace_until = $3, deletion_original_email = $4
			WHERE user_id = $1
		`, [userId, snapshot.deletedAt, snapshot.deleteGraceUntil, snapshot.originalEmail]);
		return snapshot;
	}

	async restoreUser(userId: string): Promise<boolean> {
		const rows = await this.client.unsafe<SoftDeleteRow>(`
			SELECT user_id, deleted_at, delete_grace_until
			FROM auth_users
			WHERE user_id = $1 AND deleted_at IS NOT NULL
		`, [userId]);
		if (!rows[0]) return false;
		// DEFENSE IN DEPTH (retention contract): reject restore once the per-row
		// undo window has elapsed (or is missing/invalid). Mirrors the file-mode
		// store + the route's 410 gate so an expired-grace account can never be
		// reactivated, even by a caller that skipped the route-level check.
		if (!isRestoreGraceValid(pgIsoOrNull(rows[0].delete_grace_until))) {
			throw new RestoreGraceExpiredError();
		}
		const { authUserStore } = await import("./auth-users.js");
		// Re-enable the account; the user re-sets their email via change-email after
		// login (the original may already be taken, so we leave the redacted alias).
		await authUserStore.update(userId, { isActive: true });
		// Clear the stashed original email too (data minimization): once restored the
		// row is no longer a purge candidate, so the stash has no further purpose.
		await this.client.unsafe(`
			UPDATE auth_users
			SET deleted_at = NULL, delete_grace_until = NULL, deletion_original_email = NULL
			WHERE user_id = $1
		`, [userId]);
		return true;
	}

	async listExpiredSoftDeletes(now: Date = new Date()): Promise<Array<{ userId: string; deleteGraceUntil: string }>> {
		const rows = await this.client.unsafe<SoftDeleteRow>(`
			SELECT user_id, deleted_at, delete_grace_until
			FROM auth_users
			WHERE deleted_at IS NOT NULL
			  AND delete_grace_until IS NOT NULL
			  AND delete_grace_until <= $1
			ORDER BY delete_grace_until ASC
		`, [now.toISOString()]);
		return rows.map((row) => ({ userId: row.user_id, deleteGraceUntil: pgIso(row.delete_grace_until) }));
	}

	async listPendingSoftDeletes(): Promise<Array<{ userId: string; deletedAt: string; deleteGraceUntil: string }>> {
		const rows = await this.client.unsafe<SoftDeleteRow>(`
			SELECT user_id, deleted_at, delete_grace_until
			FROM auth_users
			WHERE deleted_at IS NOT NULL
			ORDER BY deleted_at DESC
		`);
		return rows.map((row) => ({
			userId: row.user_id,
			deletedAt: pgIso(row.deleted_at),
			deleteGraceUntil: pgIso(row.delete_grace_until),
		}));
	}

	async getPendingSoftDelete(userId: string): Promise<{ userId: string; deletedAt: string; deleteGraceUntil: string } | null> {
		const id = userId.trim();
		if (!id) return null;
		// PK point lookup (user_id is the auth_users primary key) — O(1) regardless of how
		// many soft-deletes exist, so an unauthenticated /restore probe can't force a full scan.
		const rows = await this.client.unsafe<SoftDeleteRow>(`
			SELECT user_id, deleted_at, delete_grace_until
			FROM auth_users
			WHERE user_id = $1 AND deleted_at IS NOT NULL
		`, [id]);
		const row = rows[0];
		return row
			? { userId: row.user_id, deletedAt: pgIso(row.deleted_at), deleteGraceUntil: pgIso(row.delete_grace_until) }
			: null;
	}

	async purgeSoftDeletedUser(userId: string, expected?: PurgeDeletionContext): Promise<PurgeResult> {
		// ATOMIC PURGE (P1 erasure-completeness): the marker CAS, the PII scrub, and
		// the SSO-identity DELETE all run in ONE transaction. Previously the CAS
		// committed on its own and the scrub + identity-delete followed as SEPARATE
		// statements — a crash after the CAS commit but before the scrub left a row
		// that is no longer soft-deleted (so no sweep ever re-selects it) yet still
		// carries PII forever. Wrapping the three in a single all-or-nothing commit
		// closes that hole: if any later statement throws (or the process dies before
		// COMMIT), the whole txn ROLLS BACK, `deleted_at` stays set, and the next
		// sweep re-selects + retries the user. The CAS is the FIRST statement so the
		// race guard is preserved inside the txn.
		const txResult = await runGdprTransaction<
			| { kind: "claimed"; scrub: Awaited<ReturnType<typeof scrubAuthUserPiiOnClient>> }
			| { kind: "not_claimed" }
		>(this.client, async (tx) => {
			// ATOMIC CLAIM (P1a, race guard): clear the pending-deletion markers in ONE
			// conditional UPDATE that re-checks every deletion gate against the LIVE
			// row. The row is claimed only if it is still pending AND — when the sweep
			// passed the selection context — `deleted_at` still equals the exact
			// timestamp the candidate was listed with, `delete_grace_until` is still
			// at/below the sweep's `now`, and `deleted_at` is still at/below the
			// configured retention cutoff. A restore (clears deleted_at) or
			// restore-then-redelete (writes a NEW deleted_at + a future
			// delete_grace_until) between the sweep's listing and this statement fails
			// the CAS and is NOT erased. The same statement that authorizes the purge
			// also clears the markers, so two concurrent sweeps cannot both claim the
			// same row (one UPDATE wins, the other matches zero rows). `RETURNING`
			// tells us whether we won the claim.
			// CTE so we can both clear the markers AND return the soft-delete instant
			// the row carried BEFORE we nulled it: a plain UPDATE … RETURNING deleted_at
			// would yield the post-UPDATE value (NULL). `prev` snapshots the pre-update
			// timestamp under the same row lock the UPDATE takes, so it is the exact
			// instant the claim matched. We need it to time-bound the auth_login_failures
			// purge (email is reusable after soft-delete; a later account's lockout rows
			// are stamped after this instant and must survive).
			const claimed = await tx.unsafe<SoftDeleteRow & { prev_deleted_at: Date | string | null }>(`
				WITH prev AS (
					SELECT user_id, deleted_at AS prev_deleted_at FROM auth_users WHERE user_id = $1
				),
				upd AS (
					UPDATE auth_users
					SET deleted_at = NULL, delete_grace_until = NULL
					WHERE user_id = $1
					  AND deleted_at IS NOT NULL
					  AND ($2::timestamptz IS NULL OR deleted_at = $2::timestamptz)
					  AND ($3::timestamptz IS NULL OR delete_grace_until <= $3::timestamptz)
					  AND ($4::timestamptz IS NULL OR deleted_at <= $4::timestamptz)
					RETURNING user_id, deleted_at, delete_grace_until
				)
				SELECT upd.user_id, upd.deleted_at, upd.delete_grace_until, prev.prev_deleted_at
				FROM upd JOIN prev USING (user_id)
			`, [
				userId,
				expected?.deletedAt ?? null,
				expected?.graceUntilAtOrBefore ?? null,
				expected?.deletedAtOrBefore ?? null,
			]);
			if (!claimed[0]) {
				// Lost / no claim → make NO writes; commit a no-op and disambiguate the
				// reason below with reads. (No marker was cleared, so nothing to undo.)
				return { kind: "not_claimed" } as const;
			}
			// We hold the claim. Scrub the PII and drop SSO identities on the SAME
			// transaction client so the whole purge commits atomically with the CAS.
			const scrub = await scrubAuthUserPiiOnClient(tx, userId);
			await tx.unsafe(`DELETE FROM auth_external_identities WHERE user_id = $1`, [userId]);
			// Erase the PII the subject left in the ancillary tables (consent IP/UA,
			// invite emails, notifications, support messages, memberships) in the SAME
			// transaction, so the right-to-erasure is complete and atomic.
			await purgeAncillaryPiiOnClient(tx, userId, scrub.originalEmail, claimed[0].prev_deleted_at);
			return { kind: "claimed", scrub } as const;
		});

		if (txResult.kind === "not_claimed") {
			// We did not claim the row. Disambiguate the no-op for the caller's
			// idempotency/race accounting (the transaction made no writes).
			const rows = await this.client.unsafe<SoftDeleteRow>(`
				SELECT user_id, deleted_at, delete_grace_until
				FROM auth_users
				WHERE user_id = $1
			`, [userId]);
			const row = rows[0];
			if (!row) return { userId, purged: false, reason: "user_missing" };
			if (!row.deleted_at) {
				// No longer pending: restored, or already purged. A leftover tombstone
				// from a prior purge reports `already_anonymized` for idempotency.
				const { authUserStore } = await import("./auth-users.js");
				const user = await authUserStore.load(userId);
				if (user && isAnonymizedTombstoneEmail(user.email)) return { userId, purged: false, reason: "already_anonymized" };
				return { userId, purged: false, reason: "not_soft_deleted" };
			}
			// Still pending, but the deletion markers no longer match the selection
			// context — e.g. a restore-then-redelete stamped a fresh future grace.
			// Skip (no purge) so we never erase a user inside a NEW undo window.
			return { userId, purged: false, reason: "markers_changed" };
		}

		const result = txResult.scrub;
		if (result.userMissing) return { userId, purged: false, reason: "user_missing" };
		if (result.alreadyAnonymized) return { userId, purged: false, reason: "already_anonymized" };
		return { userId, purged: true, tombstoneEmail: result.tombstoneEmail };
	}

	async startImpersonation(adminUserId: string, impersonatedUserId: string, reason: string | null): Promise<ImpersonationEvent> {
		const rows = await this.client.unsafe<ImpersonationRow>(`
			INSERT INTO impersonation_events (id, admin_user_id, impersonated_user_id, reason)
			VALUES ($1, $2, $3, $4)
			RETURNING ${IMPERSONATION_COLUMNS}
		`, [randomUUID(), adminUserId, impersonatedUserId, reason]);
		const row = rows[0];
		if (!row) throw new Error("impersonation_events INSERT did not return a row");
		return mapImpersonationRow(row);
	}

	async endImpersonation(id: string): Promise<ImpersonationEvent | null> {
		// Only stamp ended_at if it is still open; an already-closed event is
		// returned unchanged so the close is idempotent.
		const rows = await this.client.unsafe<ImpersonationRow>(`
			UPDATE impersonation_events
			SET ended_at = now()
			WHERE id = $1 AND ended_at IS NULL
			RETURNING ${IMPERSONATION_COLUMNS}
		`, [id]);
		if (rows[0]) return mapImpersonationRow(rows[0]);
		const existing = await this.client.unsafe<ImpersonationRow>(`
			SELECT ${IMPERSONATION_COLUMNS} FROM impersonation_events WHERE id = $1
		`, [id]);
		return existing[0] ? mapImpersonationRow(existing[0]) : null;
	}

	async listImpersonations(options: { adminUserId?: string; targetUserId?: string; limit?: number } = {}): Promise<ImpersonationEvent[]> {
		const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 1000));
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (options.adminUserId) {
			params.push(options.adminUserId);
			conditions.push(`admin_user_id = $${params.length}`);
		}
		if (options.targetUserId) {
			params.push(options.targetUserId);
			conditions.push(`impersonated_user_id = $${params.length}`);
		}
		params.push(limit);
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = await this.client.unsafe<ImpersonationRow>(`
			SELECT ${IMPERSONATION_COLUMNS}
			FROM impersonation_events
			${where}
			ORDER BY started_at DESC, id DESC
			LIMIT $${params.length}
		`, params);
		return rows.map(mapImpersonationRow);
	}

	async recordAdminAudit(input: { adminUserId: string; action: string; actorRole?: string | null; targetKind?: string | null; targetId?: string | null; detail?: Record<string, unknown> }): Promise<AdminAuditEntry> {
		const actorRole = await resolveActorRole(input.adminUserId, input.actorRole);
		const rows = await this.client.unsafe<AdminAuditRow>(`
			INSERT INTO admin_audit (id, admin_user_id, actor_role, action, target_kind, target_id, detail)
			VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)
			RETURNING ${ADMIN_AUDIT_COLUMNS}
		`, [
			randomUUID(),
			input.adminUserId,
			actorRole,
			input.action,
			input.targetKind ?? null,
			input.targetId ?? null,
			JSON.stringify(input.detail ?? {}),
		]);
		const row = rows[0];
		if (!row) throw new Error("admin_audit INSERT did not return a row");
		return mapAdminAuditRow(row);
	}

	async listAdminAudit(options: { adminUserId?: string; action?: string; actorRole?: string; targetKind?: string; targetId?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number } = {}): Promise<{ entries: AdminAuditEntry[]; total: number }> {
		const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 1000));
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		const conditions: string[] = [];
		const params: unknown[] = [];
		const addEq = (column: string, value: string | undefined) => {
			if (!value) return;
			params.push(value);
			conditions.push(`${column} = $${params.length}`);
		};
		addEq("admin_user_id", options.adminUserId);
		addEq("action", options.action);
		addEq("actor_role", options.actorRole);
		addEq("target_kind", options.targetKind);
		addEq("target_id", options.targetId);
		// Bind date bounds with an explicit ::timestamptz cast. Callers (the admin
		// routes) validate+normalize these to canonical UTC ISO before they reach
		// here, so the cast always succeeds; the explicit cast keeps the comparison
		// against the timestamptz `created_at` column unambiguous and avoids relying
		// on implicit text→timestamptz coercion.
		if (options.fromDate) {
			params.push(options.fromDate);
			conditions.push(`created_at >= $${params.length}::timestamptz`);
		}
		if (options.toDate) {
			params.push(options.toDate);
			conditions.push(`created_at <= $${params.length}::timestamptz`);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		// One bounded COUNT for an honest total, then the page. Same filters on both.
		const countRows = await this.client.unsafe<{ count: string | number }>(`
			SELECT COUNT(*)::bigint AS count FROM admin_audit ${where}
		`, params);
		const total = Number(countRows[0]?.count ?? 0);

		params.push(limit);
		const limitParam = params.length;
		params.push(offset);
		const offsetParam = params.length;
		const rows = await this.client.unsafe<AdminAuditRow>(`
			SELECT ${ADMIN_AUDIT_COLUMNS}
			FROM admin_audit
			${where}
			ORDER BY created_at DESC, id DESC
			LIMIT $${limitParam} OFFSET $${offsetParam}
		`, params);
		return { entries: rows.map(mapAdminAuditRow), total };
	}
}

// ── Signed download URL ───────────────────────────────────────────

// Reuse the existing asset signing posture rather than a new secret: derive the
// HMAC key from JWT_SECRET so we don't add another env var. This is a separate
// signing scope so a leaked asset token cannot be replayed as a GDPR export
// token.
const EXPORT_SIGNING_SCOPE = "gdpr-export-v1";

export function signExportUrl(jobId: string, expiresAt: number, secret = serverConfig.jwtSecret): string {
	const payload = `${EXPORT_SIGNING_SCOPE}:${jobId}:${expiresAt}`;
	return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyExportSignature(jobId: string, expiresAt: number, signature: string, secret = serverConfig.jwtSecret): boolean {
	const expected = signExportUrl(jobId, expiresAt, secret);
	if (expected.length !== signature.length) return false;
	try {
		return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
	} catch {
		return false;
	}
}

export function buildSignedExportUrl(jobId: string, options: { ttlMs?: number; baseUrl?: string } = {}): { url: string; expiresAt: number } {
	const ttl = options.ttlMs ?? DEFAULT_EXPORT_TTL_MS;
	const expiresAt = Date.now() + ttl;
	const signature = signExportUrl(jobId, expiresAt);
	const base = options.baseUrl ?? "/api/account/export";
	const url = `${base}/${jobId}/download?expires=${expiresAt}&signature=${signature}`;
	return { url, expiresAt };
}

// ── Bundle gathering (GDPR Art. 20 data portability) ──────────────

/**
 * Hard bounds on the export walk so a huge account cannot OOM the process or
 * produce an unbounded artifact. GDPR portability requires the user's data, not
 * an unbounded dump of every collaborator's activity, so paginating to these
 * caps is both safe and compliant. The bundle records `*Truncated` flags when a
 * cap is hit so the recipient knows the listing is partial (they can request a
 * follow-up export, and an operator can raise the cap for a specific subject).
 */
const EXPORT_MAX_PROJECTS = 1000;
const EXPORT_PROJECT_PAGE_SIZE = 200;
const EXPORT_MAX_COMMENTS_PER_PROJECT = 500;
const EXPORT_MAX_AUDIT_EVENTS = 2000;
const EXPORT_AUDIT_PAGE_SIZE = 500;
const EXPORT_MAX_CONSENT_EVENTS = 1000;
const EXPORT_MAX_EXPORT_JOBS = 200;
const EXPORT_MAX_SUPPORT_TICKETS = 500;
const EXPORT_MAX_MESSAGES_PER_TICKET = 200;
const EXPORT_TICKET_PAGE_SIZE = 100;

interface ExportProjectEntry {
	projectId: string;
	workspaceId: string | null;
	name: string;
	sourceLang: string | null;
	targetLang: string;
	targetLangs: string[];
	createdAt: string;
	updatedAt: string;
	storyTitle: string | null;
	chapterLabel: string | null;
	pageCount: number;
	textLayerCount: number;
	assetMetadata: { coverImageId: string | null; coverOriginalName: string | null };
}

interface ExportCommentEntry {
	id: string;
	projectId: string;
	pageIndex: number;
	layerId: string | null;
	status: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

interface ExportAuditEntry {
	id: string;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

interface ExportConsentEntry {
	id: string;
	consentType: string;
	categories: Record<string, boolean>;
	grantedAt: string;
	ipAddress: string | null;
	userAgent: string | null;
	policyVersion: string;
	deviceId: string | null;
}

interface ExportExportJobEntry {
	id: string;
	status: ExportJobStatus;
	bytes: number | null;
	expiresAt: string | null;
	createdAt: string;
	completedAt: string | null;
	failureReason: string | null;
}

interface ExportSupportTicketEntry {
	id: string;
	subject: string;
	status: string;
	priority: string;
	category: string;
	workspaceId: string | null;
	createdAt: string;
	updatedAt: string;
	messages: Array<{
		id: string;
		authorKind: string;
		authorUserId: string | null;
		body: string;
		createdAt: string;
	}>;
}

/**
 * Security / auth records the subject is entitled to (Art. 15). We deliberately
 * OMIT the `token_hash` (a credential, not the subject's personal data — exporting
 * it would be a needless secret leak) and report only the token's lifecycle +
 * origin metadata.
 */
interface ExportAuthTokenEntry {
	id: string;
	kind: AuthTokenKind;
	createdAt: string;
	expiresAt: string;
	usedAt: string | null;
	ipAddress: string | null;
	userAgent: string | null;
}

/**
 * Walk the user's REAL data into a portable bundle (GDPR Art. 20).
 *
 * What we include and why:
 *   * profile — the auth_users row (identity the request is about).
 *   * projects — projects the user owns/can access, via the project catalog
 *     scoped by `userId` (the catalog already enforces owner/membership/scope,
 *     so this never leaks a project the subject cannot see). Metadata + counts
 *     only; we never inline raw image bytes.
 *   * comments — the subject's OWN authored comments/notes across those projects
 *     (filtered by author = userId). A collaborator's comments stay out — they
 *     are someone else's personal data.
 *   * auditEvents — back-office admin_audit rows that TARGET this user
 *     (target_kind=user, target_id=userId): the record of admin actions taken on
 *     the account, which the subject is entitled to see.
 *   * assetMetadata — per-project asset metadata + counts (cover id / original
 *     filename / page+layer counts), NOT the binary assets themselves.
 *
 * The walk is BOUNDED: at most EXPORT_MAX_PROJECTS projects (paged), a per-project
 * comment cap, and a global audit cap, so a pathological account cannot OOM or
 * produce an unbounded artifact. Best-effort per source: a failure gathering one
 * slice degrades that slice (and is flagged) rather than failing the whole export
 * — a partial portability bundle is better than none.
 */
export interface BuildAccountExportBundleOptions {
	/** Override the project catalog source (tests inject a temp-dir-backed store). */
	catalog?: ProjectCatalogStore | null;
	/**
	 * Override the GDPR store the audit / consent / export-job walks read from
	 * (defaults to the singleton). The subject's consent history + account-export
	 * jobs both live on this store.
	 */
	store?: GdprStore;
	/** Override the support-ticket store (tests inject a temp-dir-backed store). */
	supportTickets?: SupportTicketStore | null;
	/** Override the notification-preference store. */
	notificationPreferences?: NotificationPreferenceStore | null;
	/** Override the auth-flow token store (password-reset + email-verification). */
	authFlowTokens?: AuthFlowTokenStore | null;
}

export async function buildAccountExportBundle(
	userId: string,
	options: BuildAccountExportBundleOptions = {},
): Promise<{ filename: string; payload: string; bytes: number }> {
	const { authUserStore } = await import("./auth-users.js");
	const user = await authUserStore.load(userId);
	const auditStore = options.store ?? gdprStore;

	const projects: ExportProjectEntry[] = [];
	const assetMetadata: Array<ExportProjectEntry["assetMetadata"] & { projectId: string }> = [];
	const comments: ExportCommentEntry[] = [];
	let projectsTruncated = false;
	let commentsTruncated = false;

	const projectCatalogStore = options.catalog !== undefined
		? options.catalog
		: (await import("./project-catalog.js")).projectCatalogStore;
	// In a "none" catalog mode there is no project source to walk; the bundle still
	// ships profile + audit. (file/postgres modes return a real store.)
	if (projectCatalogStore) try {
		let cursor: string | undefined;
		// Page the catalog (scoped to this user) until we hit the project cap or run
		// out of pages — never load the whole catalog into memory at once.
		walk: while (projects.length < EXPORT_MAX_PROJECTS) {
			const page = await projectCatalogStore.listProjectSummaryPage({
				userId,
				// SECURITY (P1b): the export must include ONLY projects GENUINELY tied to
				// this subject — never the ownerless anonymous/legacy rows that the
				// default summary scope exposes to any caller. Membership-scoped
				// workspace projects the subject truly belongs to still surface.
				excludeOwnerlessPersonal: true,
				limit: Math.min(EXPORT_PROJECT_PAGE_SIZE, EXPORT_MAX_PROJECTS - projects.length),
				cursor,
			});
			for (const summary of page.projects) {
				if (projects.length >= EXPORT_MAX_PROJECTS) {
					projectsTruncated = true;
					break walk;
				}
				const projectAssetMetadata = {
					coverImageId: summary.coverImageId ?? null,
					coverOriginalName: summary.coverOriginalName ?? null,
				};
				projects.push({
					projectId: summary.projectId,
					workspaceId: summary.workspaceId ?? null,
					name: summary.name,
					sourceLang: summary.sourceLang ?? null,
					targetLang: summary.targetLang,
					targetLangs: summary.targetLangs,
					createdAt: summary.createdAt,
					updatedAt: summary.updatedAt,
					storyTitle: summary.storyTitle ?? null,
					chapterLabel: summary.chapterLabel ?? null,
					pageCount: summary.pageCount,
					textLayerCount: summary.textLayerCount,
					assetMetadata: projectAssetMetadata,
				});
				assetMetadata.push({ projectId: summary.projectId, ...projectAssetMetadata });
			}
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}

		// Gather the subject's OWN comments per accessible project (bounded per
		// project). The catalog comment listing filters by author at the source.
		for (const project of projects) {
			let commentCursor: string | undefined;
			let perProject = 0;
			while (perProject < EXPORT_MAX_COMMENTS_PER_PROJECT) {
				const page = await projectCatalogStore.listProjectComments({
					projectId: project.projectId,
					author: userId,
					limit: Math.min(EXPORT_PROJECT_PAGE_SIZE, EXPORT_MAX_COMMENTS_PER_PROJECT - perProject),
					cursor: commentCursor,
				});
				for (const comment of page.comments) {
					comments.push({
						id: comment.id,
						projectId: project.projectId,
						pageIndex: comment.pageIndex,
						layerId: comment.layerId ?? null,
						status: comment.status,
						body: comment.body,
						createdAt: comment.createdAt,
						updatedAt: comment.updatedAt,
					});
					perProject += 1;
				}
				if (!page.nextCursor) break;
				if (perProject >= EXPORT_MAX_COMMENTS_PER_PROJECT) {
					commentsTruncated = true;
					break;
				}
				commentCursor = page.nextCursor;
			}
		}
	} catch (error) {
		// A catalog failure degrades the project/comment slices rather than failing
		// the whole export — the subject still gets their profile + audit trail.
		console.warn(`[gdpr] export bundle: project/comment walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const auditEvents: ExportAuditEntry[] = [];
	let auditTruncated = false;
	try {
		// admin_audit rows that TARGET this user (admin actions on their account).
		let offset = 0;
		while (auditEvents.length < EXPORT_MAX_AUDIT_EVENTS) {
			const page = await auditStore.listAdminAudit({
				targetKind: "user",
				targetId: userId,
				limit: Math.min(EXPORT_AUDIT_PAGE_SIZE, EXPORT_MAX_AUDIT_EVENTS - auditEvents.length),
				offset,
			});
			for (const entry of page.entries) {
				auditEvents.push({
					id: entry.id,
					action: entry.action,
					targetKind: entry.targetKind,
					targetId: entry.targetId,
					detail: entry.detail,
					createdAt: entry.createdAt,
				});
			}
			offset += page.entries.length;
			if (page.entries.length === 0 || offset >= page.total) break;
			if (auditEvents.length >= EXPORT_MAX_AUDIT_EVENTS) {
				auditTruncated = true;
				break;
			}
		}
	} catch (error) {
		console.warn(`[gdpr] export bundle: audit walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	// ── Consent history (the subject's own consent records) ──
	const consentEvents: ExportConsentEntry[] = [];
	let consentTruncated = false;
	try {
		const events = await auditStore.listConsentEvents(userId, { limit: EXPORT_MAX_CONSENT_EVENTS });
		for (const event of events) {
			consentEvents.push({
				id: event.id,
				consentType: event.consentType,
				categories: event.categories,
				grantedAt: event.grantedAt,
				ipAddress: event.ipAddress,
				userAgent: event.userAgent,
				policyVersion: event.policyVersion,
				deviceId: event.deviceId,
			});
		}
		if (consentEvents.length >= EXPORT_MAX_CONSENT_EVENTS) consentTruncated = true;
	} catch (error) {
		console.warn(`[gdpr] export bundle: consent walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	// ── Account export jobs (the subject's own portability requests) ──
	const exportJobs: ExportExportJobEntry[] = [];
	let exportJobsTruncated = false;
	try {
		const jobs = await auditStore.listExportJobs(userId);
		for (const job of jobs) {
			if (exportJobs.length >= EXPORT_MAX_EXPORT_JOBS) {
				exportJobsTruncated = true;
				break;
			}
			exportJobs.push({
				id: job.id,
				status: job.status,
				bytes: job.bytes,
				expiresAt: job.expiresAt,
				createdAt: job.createdAt,
				completedAt: job.completedAt,
				failureReason: job.failureReason,
			});
		}
	} catch (error) {
		console.warn(`[gdpr] export bundle: export-job walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	// ── Notification preferences (the subject's per-type/channel matrix) ──
	let notificationPreferences: unknown = null;
	try {
		const prefStore = options.notificationPreferences !== undefined
			? options.notificationPreferences
			: (await import("./notification-preferences.js")).notificationPreferenceStore;
		if (prefStore) notificationPreferences = await prefStore.getForUser(userId);
	} catch (error) {
		console.warn(`[gdpr] export bundle: notification-preference read failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	// ── Support tickets the subject opened, with their thread messages ──
	const supportTickets: ExportSupportTicketEntry[] = [];
	let supportTicketsTruncated = false;
	try {
		const ticketStore = options.supportTickets !== undefined
			? options.supportTickets
			: (await import("./support-tickets.js")).supportTicketStore;
		if (ticketStore) {
			let beforeId: string | undefined;
			walkTickets: while (supportTickets.length < EXPORT_MAX_SUPPORT_TICKETS) {
				const page = await ticketStore.listTickets({
					requesterUserId: userId,
					limit: Math.min(EXPORT_TICKET_PAGE_SIZE, EXPORT_MAX_SUPPORT_TICKETS - supportTickets.length),
					beforeId,
				});
				for (const ticket of page.items) {
					if (supportTickets.length >= EXPORT_MAX_SUPPORT_TICKETS) {
						supportTicketsTruncated = true;
						break walkTickets;
					}
					const messages: ExportSupportTicketEntry["messages"] = [];
					let afterId: string | undefined;
					while (messages.length < EXPORT_MAX_MESSAGES_PER_TICKET) {
						const msgPage = await ticketStore.listMessages(ticket.id, {
							limit: Math.min(EXPORT_TICKET_PAGE_SIZE, EXPORT_MAX_MESSAGES_PER_TICKET - messages.length),
							afterId,
						});
						for (const message of msgPage.items) {
							// Staff-only INTERNAL notes (author_kind="internal") must NEVER
							// reach the customer — the customer thread route filters them out
							// with this same predicate (routes/support-tickets.ts), and the
							// portability export is just as customer-facing, so apply it here
							// too. Skipping a page item does not advance truncation; the page
							// cursor still walks past it via afterId.
							if (!isCustomerVisibleAuthorKind(message.authorKind)) continue;
							messages.push({
								id: message.id,
								authorKind: message.authorKind,
								authorUserId: message.authorUserId ?? null,
								body: message.body,
								createdAt: message.createdAt,
							});
						}
						if (!msgPage.hasMore || !msgPage.nextCursor) break;
						afterId = msgPage.nextCursor;
					}
					supportTickets.push({
						id: ticket.id,
						subject: ticket.subject,
						status: ticket.status,
						priority: ticket.priority,
						category: ticket.category,
						workspaceId: ticket.workspaceId ?? null,
						createdAt: ticket.createdAt,
						updatedAt: ticket.updatedAt,
						messages,
					});
				}
				if (!page.hasMore || !page.nextCursor) break;
				beforeId = page.nextCursor;
			}
		}
	} catch (error) {
		console.warn(`[gdpr] export bundle: support-ticket walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	// ── Security / auth records: password-reset + email-verification tokens ──
	// (token_hash is a credential and is deliberately NOT exported — only lifecycle
	// + origin metadata, which IS the subject's personal data.)
	const authFlowTokens: ExportAuthTokenEntry[] = [];
	try {
		const tokenStore = options.authFlowTokens !== undefined
			? options.authFlowTokens
			: (await import("./password-reset.js")).authFlowTokenStore;
		if (tokenStore) {
			const tokens = await tokenStore.listForUser(userId, { limit: 1000 });
			for (const token of tokens) {
				authFlowTokens.push({
					id: token.id,
					kind: token.kind,
					createdAt: token.createdAt,
					expiresAt: token.expiresAt,
					usedAt: token.usedAt,
					ipAddress: token.ipAddress ?? null,
					userAgent: token.userAgent ?? null,
				});
			}
		}
	} catch (error) {
		console.warn(`[gdpr] export bundle: auth-token walk failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const bundle = {
		exportedAt: new Date().toISOString(),
		userId,
		profile: user
			? {
					id: user.id,
					email: user.email,
					name: user.name,
					role: user.role,
					createdAt: user.createdAt,
					lastLogin: user.lastLogin ?? null,
				}
			: null,
		projects,
		comments,
		auditEvents,
		assetMetadata,
		consentEvents,
		exportJobs,
		notificationPreferences,
		supportTickets,
		// Lifecycle/origin metadata of the subject's auth-flow tokens. The secret
		// token_hash is intentionally excluded (it is a credential, not portable PII).
		securityRecords: {
			authFlowTokens,
		},
		// Honest signal that one or more listings hit their cap. Keeps the top-level
		// download contract fixed (the arrays are always present) while telling the
		// recipient the export is partial.
		truncated: {
			projects: projectsTruncated,
			comments: commentsTruncated,
			auditEvents: auditTruncated,
			consentEvents: consentTruncated,
			exportJobs: exportJobsTruncated,
			supportTickets: supportTicketsTruncated,
		},
		counts: {
			projects: projects.length,
			comments: comments.length,
			auditEvents: auditEvents.length,
			assetMetadata: assetMetadata.length,
			consentEvents: consentEvents.length,
			exportJobs: exportJobs.length,
			supportTickets: supportTickets.length,
			authFlowTokens: authFlowTokens.length,
		},
	};
	const payload = JSON.stringify(bundle, null, 2);
	return {
		filename: `account-export-${userId}.json`,
		payload,
		bytes: Buffer.byteLength(payload, "utf8"),
	};
}

// ── GDPR right-to-erasure sweep ───────────────────────────────────

/** Hard cap on users anonymized in a single sweep run, so one cron tick stays bounded. */
const ERASURE_SWEEP_BATCH_CAP = 500;

/** Default legal retention window before erasure (days). Matches gdpr.ts:6 / the account-delete flow. */
export const DEFAULT_GDPR_ERASURE_GRACE_DAYS = 30;

export interface GdprErasureSweepOptions {
	store?: GdprStore;
	/** Evaluation instant for the grace-window cutoff (tests inject a fixed/advanced clock). */
	now?: Date;
	/** Count candidates only; issue NO destructive writes. */
	dryRun?: boolean;
	/** Max users to anonymize this run (defaults to ERASURE_SWEEP_BATCH_CAP). */
	batchCap?: number;
	/** Synthetic actor id stamped on the audit entry for the sweep. */
	actorUserId?: string;
	/**
	 * CONFIGURABLE legal retention window. The sweep only anonymizes a soft-deleted
	 * user once `deletedAt` is older than `now - graceDays`. This is the operator's
	 * single knob for the retention period (default 30 days, sourced from
	 * serverConfig.gdprErasureGraceDays at the cron call site). It is applied on
	 * TOP of the per-row `delete_grace_until` — a user is erased only when BOTH the
	 * deletion-time grace AND this configured window have elapsed — so raising the
	 * config window can never erase someone earlier than their own undo window, and
	 * lowering it can never erase someone still inside their undo window.
	 */
	graceDays?: number;
}

/**
 * Enforce GDPR right-to-erasure: find SOFT-DELETED users whose grace window has
 * already expired and irreversibly anonymize each one's PII.
 *
 * The candidate gate is doubly safe. `listExpiredSoftDeletes(now)` already returns
 * only rows with `delete_grace_until <= now` (the per-row undo window stamped at
 * deletion). On top of that we require `deletedAt <= now - graceDays`, the
 * CONFIGURABLE legal-retention window. A user is erased only when BOTH have
 * elapsed, so neither knob can erase someone still inside their undo window and an
 * active (never-soft-deleted) user is never a candidate at all.
 *
 * SAFETY:
 *   * Idempotent — a user already anonymized by a prior run reports
 *     `alreadyAnonymized` and is not re-written; a re-run purges nothing new.
 *   * Never touches active users — only the past-grace soft-delete set.
 *   * `dryRun` returns the candidate count with zero writes (cheap pre-flight).
 *   * Bounded — at most `batchCap` purges per run; the rest roll to the next tick.
 *   * Per-user failures are logged and counted, not fatal: one bad row does not
 *     block erasure of the others.
 *   * Records ONE `admin_audit` row summarizing what was purged (right-to-erasure
 *     must itself be auditable).
 */
export async function runGdprErasureSweep(options: GdprErasureSweepOptions = {}): Promise<GdprErasureSweepResult> {
	const store = options.store ?? gdprStore;
	const now = options.now ?? new Date();
	const dryRun = options.dryRun ?? false;
	const batchCap = Math.max(1, Math.min(Math.floor(options.batchCap ?? ERASURE_SWEEP_BATCH_CAP), ERASURE_SWEEP_BATCH_CAP));
	const actorUserId = options.actorUserId ?? "system:gdpr-erasure-sweep";
	const graceDays = Number.isFinite(options.graceDays) && (options.graceDays ?? 0) > 0
		? Math.floor(options.graceDays as number)
		: DEFAULT_GDPR_ERASURE_GRACE_DAYS;

	// Configured legal-retention cutoff: a soft-delete must be at least this old.
	const retentionCutoffMs = now.getTime() - graceDays * 24 * 60 * 60 * 1000;
	// Per-row undo-window gate (delete_grace_until <= now) AND the configured
	// legal-retention gate (deletedAt <= retention cutoff). We intersect the
	// expired set with the pending set's deletedAt so both conditions must hold.
	const expiredIds = new Set((await store.listExpiredSoftDeletes(now)).map((entry) => entry.userId));
	const pending = await store.listPendingSoftDeletes();
	const expired = pending.filter((entry) =>
		expiredIds.has(entry.userId)
		&& new Date(entry.deletedAt).getTime() <= retentionCutoffMs,
	);
	const candidates = expired.length;
	const result: GdprErasureSweepResult = {
		dryRun,
		candidates,
		purged: 0,
		alreadyAnonymized: 0,
		errors: 0,
		purgedUserIds: [],
	};
	if (dryRun || candidates === 0) return result;

	// Re-check gates ATOMICALLY at purge time, not just `deleted_at != null`. We
	// pass the EXACT context this candidate was selected with (the deletedAt it was
	// listed with, the per-row grace gate = the sweep's `now`, and the configured
	// retention cutoff). The store only anonymizes if all three STILL hold, so a
	// restore-then-redelete between listing and purge — which gives the row a fresh
	// future grace — is skipped (`markers_changed`), never erased.
	const retentionCutoffIso = new Date(retentionCutoffMs).toISOString();
	const nowIso = now.toISOString();
	for (const entry of expired.slice(0, batchCap)) {
		try {
			const outcome = await store.purgeSoftDeletedUser(entry.userId, {
				deletedAt: entry.deletedAt,
				graceUntilAtOrBefore: nowIso,
				deletedAtOrBefore: retentionCutoffIso,
			});
			if (outcome.purged) {
				result.purged += 1;
				result.purgedUserIds.push(entry.userId);
			} else if (outcome.reason === "already_anonymized") {
				result.alreadyAnonymized += 1;
			}
			// "not_soft_deleted" / "user_missing" / "markers_changed" between listing
			// and purge (a concurrent restore, force-delete, or restore-then-redelete)
			// is a benign no-op, not an error.
		} catch (error) {
			result.errors += 1;
			console.warn(`[gdpr] erasure sweep: failed to purge ${entry.userId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Audit the run (best-effort — losing the audit row must not fail the purge that
	// already happened). Only write when something actually changed.
	if (result.purged > 0 || result.errors > 0) {
		try {
			await store.recordAdminAudit({
				adminUserId: actorUserId,
				actorRole: "system",
				action: "gdpr.erasure.sweep",
				targetKind: "user",
				targetId: result.purgedUserIds.length === 1 ? result.purgedUserIds[0] : null,
				detail: {
					candidates: result.candidates,
					purged: result.purged,
					alreadyAnonymized: result.alreadyAnonymized,
					errors: result.errors,
					purgedUserIds: result.purgedUserIds,
					cutoff: now.toISOString(),
				},
			});
		} catch (error) {
			console.warn(`[gdpr] erasure sweep: failed to write audit row: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return result;
}

// ── Default store ────────────────────────────────────────────────

/**
 * Resolve which backing store to use, mirroring the auth-users / support-tickets
 * gating. The GDPR admin audit + impersonation log is back-office data that MUST
 * be durable, so it follows the SAME selection as the auth user store: when
 * AUTH_USER_STORE=postgres (the production posture, set whenever DATABASE_URL is
 * wired up in a non-test runtime), use Postgres; otherwise the in-memory + JSON
 * snapshot store used by the local prototype and tests.
 */
function resolveGdprStoreMode(): "memory" | "postgres" {
	return serverConfig.authUserStore === "postgres" ? "postgres" : "memory";
}

export function createGdprStore(): GdprStore {
	if (resolveGdprStoreMode() === "postgres") {
		return new PostgresGdprStore();
	}
	// We keep the JSON snapshot path next to the existing data dir so prototype
	// runs survive restarts even without Postgres.
	return new MemoryGdprStore({
		snapshotPath: join(DATA_DIR, "gdpr", "snapshot.json"),
	});
}

export const gdprStore: GdprStore = createGdprStore();

export function createMemoryGdprStore(): GdprStore {
	return new MemoryGdprStore();
}

// Useful for tests that need a deterministic signed URL.
export const _exportSigningDefaults = {
	DEFAULT_EXPORT_TTL_MS,
	EXPORT_SIGNING_SCOPE,
};

export function generateExportSecret(): string {
	// Used by future deployments that want a dedicated signing secret distinct
	// from JWT_SECRET. Not wired into config yet but lives here so cron jobs
	// and admin tooling can call it.
	return randomBytes(32).toString("hex");
}
