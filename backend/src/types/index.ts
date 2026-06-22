// Shared types for backend

export type JobStatus =
	| "pending"
	| "policy_checking"
	| "waiting_credit"
	| "processing"
	| "retrying"
	| "done"
	| "error"
	| "cancelled"
	| "blocked"
	| "needs_review";

export type AssetModerationStatus = "pending" | "passed" | "blocked" | "needs_review";
export type AssetStorageStatus = "quarantined" | "released" | "blocked";
export type AssetDerivativePurpose =
	| "thumbnail"
	| "editor_preview"
	| "moderation_overview"
	| "moderation_tile"
	| "ai_tile"
	| "export_preview";

// Internal provider-tier ROUTING/REPORTING identifiers (provider hints, kill-switch
// keys, /api/ai/capabilities labels). These are NOT the model ids sent to the
// vendor: the actual OpenAI image model is governed by OPENAI_IMAGE_MODELS in
// services/ai-providers/openai-models.ts (currently `gpt-image-1`). The "-2"/"-image-2"
// suffixes are stable tier labels persisted in configs and exposed over the API, so
// they are kept verbatim even though the OpenAI image model id is `gpt-image-1`.
export type ProviderId =
	| "python-worker"
	| "openai-gpt-image-2"
	| "openrouter-gpt-5.4-image-2"
	| "byo-openai"
	| "byo-openrouter"
	| "gemini-flash-lite"
	| "gemini-2.5-flash-image"
	| "gemini-3.1-flash-image-preview";

export type AiTier = "budget-clean" | "clean-pro" | "sfx-pro";
export type AiImageQuality = "low" | "medium" | "high";
export type SfxProviderMode = "auto" | "openai-gpt-image-2" | "python-worker" | "gpt-5.4-image-2" | "disabled";
export type StorageDriver = "local" | "r2";

export interface AiCostEstimate {
	tier: AiTier;
	providerHint: ProviderId;
	currency: "THB";
	quality?: AiImageQuality;
	outputSize?: `${number}x${number}`;
	creditUnits?: number;
	megapixels: number;
	imageInputTokens?: number;
	textInputTokens?: number;
	estimatedImageInputUsd?: number;
	estimatedTextInputUsd?: number;
	estimatedOutputUsd?: number;
	estimatedUsd?: number;
	estimatedThb: number;
	reserveThb: number;
	pricingVersion: string;
}

export interface CreditReservation {
	status: "reserved" | "captured" | "released";
	amountThb: number;
	reservedAmountThb?: number;
	currency: "THB";
	createdAt: number;
	settledAt?: number;
	reason?: string;
}

/**
 * Records the personal/shareable credit-bucket debit applied at AI submission so
 * the queue can re-charge the buckets when a refunded job is retried.
 *
 * `consumedCredits` is the amount debited from the personal/shareable credit
 * buckets, denominated in CREDIT UNITS (the size-flat 1/9/36 per-op price from
 * QUALITY_CREDIT_UNITS), NOT in THB. The credit buckets are granted in credit
 * units (coupons/SKUs grant `aiCredits` counts; plans grant `monthlyAiCredits`),
 * so the per-op charge MUST be the credit-unit price the UI quotes — never the
 * THB reserve, which would over-charge the count-denominated bucket ~2-5×. The
 * separate USAGE-LEDGER reservation (reserveThb) stays THB-denominated; the two
 * ledgers are distinct. A flat per-op credit price has no "reserve padding", so
 * the whole consumedCredits is the final charge (refunded in full only when the
 * job fails / is reused / parked, via releaseConsumptionsByRef keyed on jobId).
 */
export interface AiJobCreditConsumption {
	workspaceId: string;
	userId: string;
	/**
	 * Amount debited from the personal/shareable buckets, in CREDIT UNITS (the
	 * size-flat 1/9/36 per-op price). Set for all jobs submitted on/after the
	 * size-flat deploy. Optional because LEGACY pre-deploy jobs (see `consumedThb`)
	 * recorded their debit in THB instead and have this absent.
	 */
	consumedCredits?: number;
	/**
	 * LEGACY back-compat ONLY. Jobs submitted BEFORE the size-flat credit-unit
	 * deploy recorded their bucket debit in THB (the padded usage-ledger reserve),
	 * not in credit units, and have `consumedThb` set with `consumedCredits` absent.
	 * In-flight pre-deploy jobs MUST settle on their ORIGINAL THB basis (re-charge
	 * the same THB amount on retry; refund the unused reserve padding on capture) so
	 * they neither double-charge nor under-bill. Remove this field once the
	 * pre-deploy in-flight queue has fully drained.
	 */
	consumedThb?: number;
}

export type AiReviewMarkerStatus =
	| "processing"
	| "needs_review"
	| "accepted"
	| "rejected"
	| "retry_requested"
	| "applied"
	| "failed";

export interface AiReviewMarker {
	id: string;
	jobId: string;
	pageIndex: number;
	imageId: string;
	region: { x: number; y: number; w: number; h: number };
	status: AiReviewMarkerStatus;
	tier: AiTier;
	providerHint?: ProviderId | string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	costEstimate?: AiCostEstimate;
	creditReservation?: CreditReservation;
	resultImageId?: string;
	error?: string;
	assignee?: string;
	linkedCommentIds?: string[];
	linkedTaskIds?: string[];
	sourceMarkerId?: string;
	rerunIdempotencyKey?: string;
	/**
	 * Target language this AI result belongs to (Stream C, additive — Shape B).
	 * Mirrors the frontend `AiReviewMarker.targetLang`. Absent on legacy/single-
	 * language markers, which map to the project's default `ProjectState.targetLang`.
	 * Two markers on the same page/region for different languages therefore live in
	 * distinct buckets (distinct `targetLang`) and never overwrite each other.
	 */
	targetLang?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Per-step checkpoint for in-flight job continuity (W4.9). Records the last
 * completed durable step of an AI job so a worker restart (rolling/zero-downtime
 * deploy) can RESUME the job from where it left off instead of re-running the
 * expensive, non-idempotent steps. Crucially, once the provider has returned an
 * image we persist that image as a side-artifact and record its id here, so a
 * resume reuses it rather than calling (and re-charging) the provider again.
 *
 * Steps are ordered: moderated < provider_succeeded < output_stored.
 */
export type AiJobCheckpointStep = "moderated" | "provider_succeeded" | "output_stored";

export interface AiJobCheckpoint {
	step: AiJobCheckpointStep;
	/**
	 * Object-storage imageId of the raw provider result persisted after a
	 * successful provider call, so a resume can skip the provider call entirely.
	 * Present once `step` has reached `provider_succeeded`.
	 */
	providerResultImageId?: string;
	/** Provider that produced the checkpointed result (for event/audit fidelity). */
	provider?: ProviderId;
	updatedAt: number;
}

/**
 * The minimal view of a (possibly evicted) terminal AI job that the read-time
 * AI-review-marker self-heal needs (see reconcileProcessingAiReviewMarkers):
 * a full live AiJob satisfies it structurally, and the queue can reconstruct
 * it from a compact TerminalJobProjection long after the full job row was
 * evicted by retention — so markers never stick in `processing` just because
 * history was trimmed.
 */
export interface AiJobMarkerView {
	status: AiJob["status"];
	resultImageId?: string;
	error?: string;
	costEstimate?: AiCostEstimate;
	creditReservation?: CreditReservation;
}

export interface AiJob {
	readonly jobId: string;
	readonly projectId: string;
	readonly imageId: string;
	readonly crop: { x: number; y: number; w: number; h: number };
	/**
	 * Target language for this AI job. It is folded into the idempotency key (see
	 * `resolveAiSubmitIdempotency`) so re-running the same crop/prompt for a DIFFERENT
	 * language is correctly de-duped per-language (NOT collapsed into one job). When a
	 * job is persisted to Postgres it maps to the `ai_jobs.target_lang` column added in
	 * migration 0065 (the migration backfills legacy rows from `metadata->>'lang'`).
	 */
	readonly lang: string;
	readonly prompt: string;
	readonly tier: AiTier;
	readonly quality?: AiImageQuality;
	readonly costEstimate?: AiCostEstimate;
	creditReservation?: CreditReservation;
	creditConsumption?: AiJobCreditConsumption;
	// Per-step resume checkpoint (W4.9). Survives a worker restart so an in-flight
	// AI job continues from its last completed step rather than re-calling the
	// provider / re-charging credits.
	checkpoint?: AiJobCheckpoint;
	// True when the job was admitted on the BYO (bring-your-own-API-key) path:
	// no workspace credit was reserved and platform prompt moderation was skipped
	// because the workspace's own provider key handles the request. The processor
	// MUST NOT fall back to a platform provider for such a job (that would consume
	// platform credits with no reservation and no prior moderation), and retries
	// must keep the no-credit path instead of reserving workspace credits.
	byoQueued?: boolean;
	status: JobStatus;
	idempotencyKey?: string;
	retryOfJobId?: string;
	provider?: ProviderId;
	// Server-resolved provider + model the job ACTUALLY dispatched to, persisted when
	// a provider call succeeds (W4.7 routing). Deterministic + server-owned: a resume
	// reports the real provider/model, and the asset-library / audit trail records
	// exactly which provider/model produced the output (not just the static tier hint).
	// `resolvedProvider` is the ProviderId (official / BYO / legacy worker);
	// `resolvedModel` is the model id the adapter used.
	resolvedProvider?: ProviderId;
	resolvedModel?: string;
	attempts?: number;
	processorId?: string;
	leaseExpiresAt?: number;
	heartbeatAt?: number;
	resultImageId?: string;
	error?: string;
	retryable?: boolean;
	failureCode?: string;
	retryAfterSeconds?: number;
	readonly createdAt: number;
	updatedAt: number;
}

// Official AI provider used by the clean provider router (W4.7). The
// reverse-engineered Python scraper worker is NOT a provider here — it is a
// legacy dev-only path gated behind aiPythonEnabled.
export type AiOfficialProvider = "openai" | "openrouter";

export interface AppConfig {
	openrouterEnabled: boolean;
	openrouterApiKey: string;
	openaiImagesEnabled: boolean;
	openaiImageModel: string;
	openaiImageDefaultQuality: AiImageQuality;
	chatgptEnabled: boolean;
	primaryBackend: "chatgpt" | "openrouter";
	providerKillSwitches: Partial<Record<ProviderId, boolean>>;
	sfxProviderMode: SfxProviderMode;
	promptModerationEnabled: boolean;
	imageModerationEnabled: boolean;
	// W4.7: the official-API provider router (OpenAI/OpenRouter) is the DEFAULT
	// path. The Python scraper worker is dormant unless aiPythonEnabled is true
	// (dev/admin-only). aiDefaultProvider selects which official provider the
	// clean abstraction prefers when a tier does not pin one explicitly.
	aiPythonEnabled: boolean;
	aiDefaultProvider: AiOfficialProvider;
	// AI support-agent master kill-switch. Default ON (true). The operator can
	// flip it at runtime via /api/ai/admin/config exactly like providerKillSwitches.
	// When false (env AI_SUPPORT_KILL_SWITCH=true → aiSupportEnabled=false), every
	// new/replied support ticket routes to the human queue and the gpt-5.5 agent is
	// NEVER called. This is the cheapest, hardest guardrail in front of LLM spend.
	aiSupportEnabled: boolean;
	// Which official provider/model the support agent uses. Validated fail-fast at
	// load (like OPENAI_IMAGE_MODEL) against the provider's text model allow-list so
	// a typo'd model can never silently break (or worse, run) every ticket reply.
	supportAgentProvider: AiOfficialProvider;
	supportAgentModel: string;
}

export interface AiJobEvent {
	readonly jobId: string;
	readonly type: string;
	readonly message: string;
	readonly createdAt: number;
	readonly metadata?: Record<string, unknown>;
}

export interface AssetModerationResult {
	status: AssetModerationStatus;
	provider: string;
	checkedAt: string;
	reason?: string;
	categories?: Record<string, number>;
	rulesetVersion?: string;
	/**
	 * Distinguishes a PROVIDER-FAILURE fail-closed `needs_review` (the mandatory
	 * CSAM/safety check could not run — provider outage/timeout/no key/denylist
	 * lookup error) from a genuine provider-SUCCEEDED borderline `needs_review`
	 * (mid-confidence soft warning).
	 *
	 * - Genuine borderline `needs_review` (failClosed unset): the asset passed the
	 *   mandatory policy, so it stays `released` (in-editor servable with a review
	 *   marker) but is NEVER exportable (export requires `passed`).
	 * - Fail-closed `needs_review` (failClosed === true): the mandatory check never
	 *   produced a verdict, so the asset is QUARANTINED — withheld from serving AND
	 *   export — until it is re-moderated or admin-reviewed. It is intentionally NOT
	 *   `blocked` (which is legal-weight and non-approvable) so a transient provider
	 *   outage stays recoverable.
	 */
	failClosed?: boolean;
}

export interface AssetDerivative {
	id: string;
	purpose: AssetDerivativePurpose;
	status: "planned" | "ready" | "failed";
	width: number;
	height: number;
	sourceRect: { x: number; y: number; w: number; h: number };
	scale: number;
	overlapPx?: number;
	storageKey?: string;
	sizeBytes?: number;
	/**
	 * Output encoding of a rendered derivative (e.g. `"webp"`). Persisted at
	 * GENERATION time alongside `width`/`height` so a cache HIT can return the
	 * derivative's dimensions WITHOUT re-decoding the already-rendered bytes on the
	 * request thread. Optional: legacy records written before this field fall back
	 * to a one-time decode (which then backfills it).
	 */
	format?: string;
	createdAt: string;
}

export interface AssetRecord {
	assetId: string;
	projectId: string;
	imageId: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	storageDriver: StorageDriver;
	storageKey: string;
	width: number;
	height: number;
	storageStatus: AssetStorageStatus;
	moderation: AssetModerationResult;
	derivatives: AssetDerivative[];
	uploadedBy?: AssetActor;
	uploadAuditId?: string;
	/**
	 * Free-form provenance/discovery metadata persisted alongside the asset (the
	 * `metadata` JSONB column in Postgres mode, inline in the file-mode JSON index).
	 * AI-generated outputs carry `assetKind: "ai-generated"` plus an `ai` block
	 * (jobId, sourceImageId, provider, tier, crop) so the asset library can surface
	 * and trace generated assets. Optional — uploads may omit it.
	 */
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface AssetActor {
	source: "human" | "ai_job" | "system" | "anonymous";
	userId?: string;
	email?: string;
	role?: string;
	name?: string;
}

export interface TranslationEntry {
	image_path: string;
	box?: [number, number, number, number];
	translated_text: string;
	index?: number;
}

export type CreditPolicy = "optional" | "required";
export type ProductionMode = "solo" | "team";

// Chapter-level (per-project) team membership. Stored on ProjectState JSON so it
// rides the existing dual file/Postgres-catalog path with NO new migration, and
// existing chapters default to Solo / owner-only (an absent `chapterTeam` is an
// empty roster). A member is either a resolved platform user (`userId`) or a
// pending email invite (`email`), mirroring the workspace invite model.
export type ChapterTeamRole = "translator" | "cleaner" | "typesetter" | "qc" | "guest";
export type ChapterTeamMemberStatus = "active" | "pending";

export interface ChapterTeamMember {
	// Stable id for the membership row (so the same person can be re-invited after
	// removal without colliding). Distinct from `userId`.
	id: string;
	// Resolved platform user id (the product "UID"), when known. A pending EMAIL
	// invite for a not-yet-resolved user has no `userId` until they accept/exist.
	userId?: string;
	// Email invite target / contact email. Present for an email invite; may also be
	// present alongside `userId` for display.
	email?: string;
	// Display name snapshot at invite time (best-effort, for the roster UI).
	displayName?: string;
	role: ChapterTeamRole;
	status: ChapterTeamMemberStatus;
	// Who added this member (actor userId). The chapter owner is added implicitly.
	invitedBy?: string;
	createdAt: string;
}

// Lightweight "friends / followers" contact for fast re-invite. NOT an access
// grant — purely an address-book row scoped to one user (the owner). Persisted in
// its own store (file JSON / Postgres table), separate from ProjectState.
export type WorkspaceContactRelationship = "friend" | "follower" | "recent_collaborator";

export interface WorkspaceContact {
	id: string;
	// The contact-book OWNER (the user these contacts belong to).
	ownerUserId: string;
	// The contact's resolved platform user id (UID), when known.
	contactUserId?: string;
	email?: string;
	displayName?: string;
	relationship: WorkspaceContactRelationship;
	// Suggested chapter-team role for one-click re-invite.
	suggestedRole?: ChapterTeamRole;
	createdAt: string;
	updatedAt: string;
}

// Per-chapter reading direction (W3.19). Stored on project state JSON; no DB migration needed.
//   rtl = manga (right-to-left), ltr = manhua/western, vertical = webtoon scroll.
export type ReadingDirection = "rtl" | "ltr" | "vertical";

export interface ProjectState {
	projectId: string;
	workspaceId?: string;
	userId: string;
	name: string;
	createdAt: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	readingDirection?: ReadingDirection;
	coverImageId?: string;
	coverOriginalName?: string;
	pages: PageState[];
	currentPage: number;
	sourceLang?: string;
	targetLang: string;
	targetLangs?: string[];
	creditPolicy?: CreditPolicy;
	productionMode?: ProductionMode;
	// Chapter-level team roster (per-project). Absent ⇒ Solo / owner-only. Rides the
	// dual file/Postgres-catalog path with the rest of ProjectState (no migration).
	chapterTeam?: ChapterTeamMember[];
	textStylePresets?: TextStylePreset[];
	creditPresets?: CreditPreset[];
	tasks?: WorkflowTask[];
	activityLog?: ActivityEvent[];
	comments?: ProjectComment[];
	aiReviewMarkers?: AiReviewMarker[];
	reviewDecisions?: PageReviewDecision[];
	reviewAssignments?: ReviewAssignment[];
	revisionRequests?: RevisionRequest[];
	workspaceMessages?: WorkspaceMessage[];
	versionReviewRequests?: VersionReviewRequest[];
	exportRuns?: ExportRun[];
}

export type ExportRunKind = "single-page" | "batch-zip";
export type ExportRunStatus = "done" | "error";
export type ExportProfileId = "draft-internal" | "public-export";

export interface ExportRun {
	id: string;
	kind: ExportRunKind;
	status: ExportRunStatus;
	targetProfile?: ExportProfileId;
	filename: string;
	pageIndexes: number[];
	pageCount: number;
	bytes?: number;
	artifact?: ExportArtifact;
	artifactError?: string;
	message: string;
	error?: string;
	// Durable client-side export metering markers (see frontend ExportRun). The
	// server only round-trips these; metering itself is recorded via
	// POST /usage/:projectId/export.
	meteringPending?: boolean;
	meteringRecordedAt?: string;
	meteringInput?: ExportMeteringInput;
	createdAt: string;
	completedAt: string;
}

export interface ExportMeteringInput {
	bytes: number;
	pageIndexes?: number[];
	pageCount?: number;
	filename?: string;
	exportKind?: "single-page" | "batch-zip";
	targetProfile?: ExportProfileId;
	idempotencyKey: string;
	exportRunId?: string;
	metadata?: Record<string, unknown>;
}

export interface ExportArtifact {
	exportId: string;
	storageDriver: StorageDriver;
	storageKey: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: string;
}

export type WorkflowTaskType = "translate" | "clean" | "typeset" | "review";
export type WorkflowTaskStatus = "todo" | "doing" | "review" | "done";
export type WorkflowTaskPriority = "normal" | "high" | "urgent";

export interface WorkflowTask {
	id: string;
	type: WorkflowTaskType;
	status: WorkflowTaskStatus;
	priority: WorkflowTaskPriority;
	pageIndex: number;
	pageImageId?: string;
	layerId?: string;
	title: string;
	assignee?: string;
	dueAt?: string;
	/**
	 * Target language this task is scoped to (Shape B, additive — mirrors the
	 * frontend `WorkflowTask.targetLang` and `project_tasks.target_lang`). Set for
	 * language-scoped work (translate / typeset / review) to the project's default
	 * target track (`ProjectState.targetLang`). Cleaning tasks are language-agnostic
	 * (the cleaned raster is shared across every target language) so they
	 * intentionally leave this absent. Absent ⇒ the project's default target lang.
	 */
	targetLang?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ActivityEvent {
	id: string;
	type:
		| "project_created"
		| "project_saved"
		| "project_opened"
		| "import_json"
		| "version_restored"
		| "task_updated"
		| "comment_added"
		| "comment_updated"
		| "comment_resolved"
		| "ai_marker_created"
		| "ai_marker_updated"
		| "review_decision_added"
		| "export_artifact_removed"
		| "language_track_added"
		| "language_track_removed"
		| "story_renamed"
		| "workspace_message_added"
		| "version_review_requested"
		| "version_review_updated"
		| "team_member_added"
		| "team_member_updated"
		| "team_member_removed"
		| "review_assigned"
		| "review_cancelled"
		| "revision_requested"
		| "revision_resolved";
	/**
	 * Pre-rendered human message. Kept as the BACKWARD-COMPATIBLE fallback for
	 * older stored events and clients that don't understand `messageKey`. New
	 * emitters also set `messageKey`/`messageParams` so the frontend can render a
	 * localized template in the viewer's locale instead of this baked-in string.
	 */
	message: string;
	/**
	 * Stable i18n message key (e.g. `activity.commentAdded`) the frontend renders
	 * with `messageParams` in the active locale. Optional + additive: when absent,
	 * the frontend uses `message`. Page-number params are stored 1-based ready for
	 * display.
	 */
	messageKey?: string;
	messageParams?: Record<string, string | number>;
	actor: string;
	createdAt: string;
	pageIndex?: number;
	taskId?: string;
	metadata?: Record<string, unknown>;
}

export type ProjectCommentStatus = "open" | "resolved";

export type ReviewAnnotationShape = "pin" | "circle" | "rect" | "freehand";

/**
 * A lightweight on-page review mark (circle/freehand/rect/pin) drawn in the
 * review reader. Stored ON the comment (not a separate task). Coordinates are
 * NORMALIZED (0..1) to the page image so they overlay at any render scale.
 * Mirrors the frontend `ReviewAnnotation`.
 */
export interface ReviewAnnotation {
	shape: ReviewAnnotationShape;
	x: number;
	y: number;
	w: number;
	h: number;
	points?: { x: number; y: number }[];
	color?: string;
}

export interface ProjectComment {
	id: string;
	pageIndex: number;
	layerId?: string;
	region?: { x: number; y: number; w: number; h: number };
	annotation?: ReviewAnnotation;
	body: string;
	author: string;
	mentions?: string[];
	status: ProjectCommentStatus;
	createdAt: string;
	updatedAt: string;
}

export type PageReviewDecisionStatus = "approved" | "changes_requested";

export interface PageReviewDecision {
	id: string;
	pageIndex: number;
	status: PageReviewDecisionStatus;
	body?: string;
	actor: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Review assignment — a lead/owner hands a slice of review work (whole chapter,
 * a page range, and/or a language track) to a specific reviewer. Distinct from a
 * `WorkflowTask` (which is per-page lane state): an assignment is the durable
 * "who owns this review, and what scope" record that the AssignReviewPanel +
 * CancelReviewDialog operate on. Additive on `ProjectState.reviewAssignments`, so
 * file-mode parity is automatic and the Postgres mirror is migration-safe.
 */
export type ReviewAssignmentStatus =
	| "assigned"
	| "in_review"
	| "submitted"
	| "cancelled";

export interface ReviewAssignment {
	id: string;
	/** Reviewer this work is assigned to (workspace-member user id). */
	assigneeUserId: string;
	/** Display handle/name snapshot for the rail badge (best-effort, may be stale). */
	assigneeHandle?: string;
	/** Language track this review covers. Absent ⇒ the project's default target lang. */
	targetLang?: string;
	/**
	 * Page indexes (0-based) this review covers. Empty/absent ⇒ the WHOLE chapter.
	 */
	pageIndexes?: number[];
	status: ReviewAssignmentStatus;
	/** Actor (email/userId) who created/assigned this review. */
	assignedBy: string;
	dueAt?: string;
	priority?: WorkflowTaskPriority;
	instructions?: string;
	/** Reason captured when the assignment is cancelled (mandatory on cancel). */
	cancelReason?: string;
	cancelledBy?: string;
	cancelledAt?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Revision send-back — a reviewer/lead returns work to a WORKER as "revision #X"
 * with a mandatory reason. Distinct from a `ReviewAssignment` (which hands review
 * work TO a reviewer): a revision request sends work BACK to the person who must
 * FIX it. The `revisionNumber` auto-increments per project (1, 2, 3 …) so a team
 * has traceability ("Revision #2"). The assigned worker is ALWAYS notified
 * (in-app mandatory + best-effort email) — the send-back can never be silent.
 *
 * Additive on `ProjectState.revisionRequests`, so file-mode parity is automatic
 * and the Postgres mirror (migration 0072) is migration-safe.
 */
export type RevisionRequestStatus =
	| "requested"
	| "in_progress"
	| "resubmitted"
	| "accepted"
	| "cancelled";

export interface RevisionRequest {
	id: string;
	/** Auto-incrementing per-project revision number (1-based). */
	revisionNumber: number;
	/** Worker this revision is sent BACK to (must fix it). */
	assignedToUserId: string;
	/** Display handle/name snapshot for the badge (best-effort, may be stale). */
	assignedToHandle?: string;
	/** Mandatory reason the work is being sent back. */
	reason: string;
	/** Actor (email/userId) who requested the revision (reviewer/lead). */
	requestedBy: string;
	/** Language track this revision covers. Absent ⇒ the project's default target lang. */
	targetLang?: string;
	/** Page indexes (0-based) this revision covers. Empty/absent ⇒ the WHOLE chapter. */
	pageIndexes?: number[];
	/** Optional source review decision this revision was raised from. */
	sourceReviewDecisionId?: string;
	status: RevisionRequestStatus;
	dueAt?: string;
	priority?: WorkflowTaskPriority;
	/** Set when the revision is resolved (accepted / resubmitted / cancelled). */
	resolvedBy?: string;
	resolvedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceMessage {
	id: string;
	pageIndex?: number;
	body: string;
	author: string;
	mentions?: string[];
	linkedTaskId?: string;
	linkedCommentId?: string;
	region?: { x: number; y: number; w: number; h: number };
	createdAt: string;
	updatedAt: string;
}

export type VersionReviewStatus = "open" | "approved" | "changes_requested";

export interface VersionReviewRequest {
	id: string;
	versionId: string;
	status: VersionReviewStatus;
	/** Original request description from the requester. Never overwritten by a decision. */
	body?: string;
	requester: string;
	reviewer?: string;
	/** Reviewer's note attached when a decision (approve / changes-requested) is recorded. */
	decisionNote?: string;
	mentions?: string[];
	createdAt: string;
	updatedAt: string;
	decidedAt?: string;
}

export type WorkspaceFeedItemKind =
	| "message"
	| "activity"
	| "comment"
	| "review_decision"
	| "version_review"
	| "task"
	| "ai_marker"
	| "export_run";

export interface WorkspaceFeedItem {
	id: string;
	kind: WorkspaceFeedItemKind;
	sourceId: string;
	pageIndex?: number;
	versionId?: string;
	title: string;
	detail: string;
	/**
	 * Optional localized-title key + params (mirrors `ActivityEvent.messageKey`).
	 * Only set for `activity` items that carry a structured key; the frontend
	 * renders the template in the viewer's locale and falls back to `title`.
	 */
	titleKey?: string;
	titleParams?: Record<string, string | number>;
	actor?: string;
	createdAt: string;
	status?: string;
	severity?: "error" | "warning" | "info";
	priority?: WorkflowTaskPriority;
	dueAt?: string;
	dueState?: "overdue" | "soon" | "scheduled";
	mentions?: string[];
}

export type TextLayerSourceCategory = "dialogue" | "narration" | "sfx" | "sign" | "title" | "credit" | "logo" | "page_number" | "other";

export interface TranslationScriptSlot {
	id: string;
	label: string;
	x: number;
	y: number;
	category?: Exclude<TextLayerSourceCategory, "credit" | "logo" | "page_number">;
	sourceText?: string;
	translatedText: string;
	note?: string;
	updatedAt?: string;
	updatedBy?: string;
}

export type PageTranslationHandoffStatus = "draft" | "translated" | "needs_translation";

export interface PageTranslationHandoff {
	status: PageTranslationHandoffStatus;
	updatedAt: string;
	updatedBy?: string;
	note?: string;
}

export type PageCleaningHandoffStatus = "raw" | "clean_ready" | "needs_clean";
export type PageCleaningProofKind = "brush-edited-layer" | "no-clean-needed";
export type TypesetCleanRecheckStatus = "pending" | "verified" | "needs_adjustment";

export interface PageCleaningHandoff {
	status: PageCleaningHandoffStatus;
	updatedAt: string;
	updatedBy?: string;
	note?: string;
	proofKind?: PageCleaningProofKind;
	proofLayerId?: string;
	proofLabel?: string;
	typesetRecheckStatus?: TypesetCleanRecheckStatus;
	typesetRecheckUpdatedAt?: string;
	typesetRecheckUpdatedBy?: string;
}

export type PageQcHandoffStatus = "pending" | "ready" | "needs_fix";

export interface PageQcHandoff {
	status: PageQcHandoffStatus;
	updatedAt: string;
	updatedBy?: string;
	note?: string;
}

/**
 * Per-language "Language Track" slice of a page (Stream C, additive — Shape B).
 * Mirrors the frontend `PageLanguageOutput`. Translation/typeset/QC output is
 * per-language so it lives here, keyed by target language. Cleaning is deliberately
 * ABSENT — the cleaned raster is shared across all target languages, so
 * `PageState.cleaningHandoff` stays project/source-level and is never duplicated here.
 */
export interface PageLanguageOutput {
	textLayers: TextLayerData[];
	translationScriptSlots?: TranslationScriptSlot[];
	translationHandoff?: PageTranslationHandoff;
	qcHandoff?: PageQcHandoff;
}

export interface PageState {
	imageId: string;
	imageName: string;
	originalName?: string;
	textLayers: TextLayerData[];
	translationScriptSlots?: TranslationScriptSlot[];
	translationHandoff?: PageTranslationHandoff;
	cleaningHandoff?: PageCleaningHandoff;
	qcHandoff?: PageQcHandoff;
	/**
	 * Per-language output buckets keyed by target language code (Stream C, additive).
	 * Absent on legacy/single-language pages — those render the flat fields above as
	 * the project's default-language track. Cleaning is intentionally NOT keyed here
	 * (shared raster). See `project-catalog` `pageLanguageOutput()` for the backfill
	 * accessor that treats an absent bucket as the default track.
	 */
	languageOutputs?: Record<string, PageLanguageOutput>;
	imageLayers?: ImageLayerData[];
	edits?: { imageId: string };
	/**
	 * Non-destructive image edit stack (Phase A — bubble-clean). Each entry stores
	 * tiny edit DATA (a small mask asset + fill + bbox) composited over the ORIGINAL
	 * page image at export, instead of baking a full new page PNG. SHARED at the
	 * page level (not per-language) in Phase A. The legacy `edits.imageId` baked
	 * path is kept as a render fallback (baked first, then these layers on top).
	 */
	imageEditLayers?: ImageEditLayerData[];
	pendingAiJobs: AiJobInfo[];
	coverRect: { x: number; y: number; w: number; h: number } | null;
}

export type ImageEditLayerKind =
	| "fill-mask"
	| "patch"
	| "clone"
	| "healing"
	| "bubble-clean"
	| "flatten-cache";

export interface FillMaskPayload {
	type: "fill-mask";
	/** Asset id of the alpha-only ROI mask (metadata.assetKind = "image-edit-mask"). */
	maskAssetId: string;
	maskEncoding: "png-alpha";
	fill: { r: number; g: number; b: number; a: number };
}

/** Phase B — soft/sampled brush stroke: a small RGBA ROI asset composited at bbox. */
export interface PatchPayload {
	type: "patch";
	patchAssetId: string;
	patchEncoding: "png-rgba";
}

/** Phase B — healing-brush: realized healed ROI asset + mask + algorithm metadata. */
export interface HealingPayload {
	type: "healing";
	maskAssetId: string;
	realizedPatchAssetId: string;
	patchEncoding: "png-rgba";
	algorithm: "telea";
	algorithmVersion: string;
}

/** Phase B — clone-stamp: realized cloned ROI asset + source metadata. */
export interface ClonePayload {
	type: "clone";
	maskAssetId: string;
	realizedPatchAssetId: string;
	patchEncoding: "png-rgba";
	sourceImageId: string;
	sourceBbox: { x: number; y: number; w: number; h: number };
	offset: { dx: number; dy: number };
}

export type ImageEditLayerPayload =
	| FillMaskPayload
	| PatchPayload
	| HealingPayload
	| ClonePayload;

export interface ImageEditLayerData {
	id: string;
	name?: string;
	kind: ImageEditLayerKind;
	target: "page-background";
	targetLang?: string;
	visible: boolean;
	locked?: boolean;
	opacity: number;
	sourceImageId: string;
	bbox: { x: number; y: number; w: number; h: number };
	payload: ImageEditLayerPayload;
	index: number;
	tool: {
		id: "brush" | "healing-brush" | "clone-stamp" | "bubble-clean" | "background-edit";
		params?: Record<string, unknown>;
	};
	createdAt: string;
	updatedAt?: string;
}

export type ImageLayerRole = "reference" | "overlay" | "credit";
export type ImageLayerBlendMode = "normal" | "multiply" | "screen" | "overlay" | "soft-light";

export interface ImageLayerData {
	id: string;
	name?: string;
	imageId: string;
	imageName: string;
	restoreImageId?: string;
	originalName?: string;
	sourceW?: number;
	sourceH?: number;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	opacity: number;
	flipX?: boolean;
	flipY?: boolean;
	visible?: boolean;
	locked?: boolean;
	index: number;
	zIndex?: number;
	role?: ImageLayerRole;
	blendMode?: ImageLayerBlendMode;
}

export interface TextLayerData {
	id: string;
	name?: string;
	text: string;
	sourceText?: string;
	sourceCategory?: TextLayerSourceCategory;
	sourceProvider?: string;
	confidence?: number;
	protected?: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	fontSize: number;
	fontFamily?: string;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	alignment: "left" | "center" | "right";
	visible?: boolean;
	locked?: boolean;
	index: number;
	zIndex?: number;
	effects?: Record<string, unknown>;
}

export interface TextStylePreset {
	id: string;
	name: string;
	builtIn?: boolean;
	style: Partial<Pick<TextLayerData, "fontSize" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "alignment" | "effects">>;
}

export type CreditPlacement = "top" | "bottom" | "left" | "right";

export interface CreditPreset {
	id: string;
	name: string;
	builtIn?: boolean;
	text: string;
	placement: CreditPlacement;
	offset: number;
	style: Partial<Pick<TextLayerData, "fontSize" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "alignment" | "effects">>;
}

export interface AiJobInfo {
	jobId: string;
	crop: { x: number; y: number; w: number; h: number };
	status: JobStatus;
	resultImageId?: string;
	error?: string;
}
