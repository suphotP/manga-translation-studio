// Shared types for manga editor web

export interface TextLayer {
	id: string;
	name?: string;
	text: string;
	sourceText?: string;
	sourceCategory?: "dialogue" | "narration" | "sfx" | "sign" | "title" | "credit" | "logo" | "page_number" | "other";
	sourceProvider?: string;
	confidence?: number;
	protected?: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	opacity?: number;
	fontSize: number;
	charSpacing?: number;
	skewX?: number;
	skewY?: number;
	fontFamily?: string;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	alignment: "left" | "center" | "right";
	visible?: boolean;
	locked?: boolean;
	index: number;
	zIndex?: number;
	effects?: TextLayerEffects;
}

export type ImageLayerRole = "reference" | "overlay" | "credit";
export type ImageLayerBlendMode = "normal" | "multiply" | "screen" | "overlay" | "soft-light";

export interface ImageLayer {
	id: string;
	name?: string;
	imageId: string;
	imageName: string;
	restoreImageId?: string;
	originalName?: string;
	sourceW?: number;
	sourceH?: number;
	// Optional sub-rectangle of the SOURCE image (in source-image pixels) to
	// display. When set, only this region of `imageId` is drawn (scaled to
	// w x h), instead of the whole image. Used for AI results, whose stored
	// image is a FULL-PAGE composite but must paint back only over the crop
	// region. Absent => whole image (back-compat for every existing layer).
	sourceCrop?: { x: number; y: number; w: number; h: number };
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
	aiMarkerId?: string;
}

export function isAiResultImageLayer(layer: Partial<Pick<ImageLayer, "id" | "imageName" | "originalName">> | null | undefined): boolean {
	return Boolean(layer && (
		layer.id?.startsWith("ai-result-")
		|| layer.imageName?.toLowerCase().includes("ai-result")
		|| layer.originalName?.toLowerCase().includes("ผล ai")
	));
}

/**
 * Non-destructive image edit layer (Phase A — bubble-clean). Instead of baking a
 * full new page PNG per edit, each edit is stored as tiny DATA: a small mask asset
 * ROI + a fill colour + the bbox it covers. The compositor (live editor + export)
 * paints the mask over the ORIGINAL page image, so the source `page.imageId` stays
 * intact (AI markers keep referencing it) and storage doesn't balloon.
 *
 * Phase A ships ONLY `kind: "bubble-clean"` with a `fill-mask` payload. The full
 * union (`patch`/`clone`/`healing`/`flatten-cache`) is reserved for later phases —
 * keep this shape additive so those phases extend it without a migration.
 */
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
	/** How the mask asset is encoded. Phase A: a single-channel-in-alpha PNG. */
	maskEncoding: "png-alpha";
	/** Solid fill painted where the mask alpha is set (sampled paper or white). */
	fill: { r: number; g: number; b: number; a: number };
}

/**
 * Phase B — a soft/sampled brush stroke that paints arbitrary RGBA pixels (not a
 * solid fill). The painted ROI is stored as a small RGBA PNG asset composited at the
 * layer bbox over the original background. Deterministically replayable (the pixels
 * ARE the stored asset), so no separate "realized" copy is needed.
 */
export interface PatchPayload {
	type: "patch";
	/** Asset id of the painted ROI (metadata.assetKind = "image-edit-patch"). */
	patchAssetId: string;
	patchEncoding: "png-rgba";
}

/**
 * Phase B — Telea/OpenCV healing-brush result. The healed pixels are NOT
 * deterministically replayable across worker/OpenCV versions, so we store the
 * REALIZED healed ROI as an RGBA PNG asset (`realizedPatchAssetId`) plus the mask
 * (for provenance / future recompute) and algorithm metadata.
 */
export interface HealingPayload {
	type: "healing";
	/** Asset id of the alpha-only stroke mask (provenance / future recompute). */
	maskAssetId: string;
	/** Asset id of the REALIZED healed ROI (RGBA PNG) — what export composites. */
	realizedPatchAssetId: string;
	patchEncoding: "png-rgba";
	algorithm: "telea";
	algorithmVersion: string;
}

/**
 * Phase B — clone-stamp result. We keep the source metadata (sourceImageId,
 * sourceBbox, offset) for provenance + future recompute, but composite the REALIZED
 * cloned ROI asset (`realizedPatchAssetId`) so export is deterministic regardless of
 * later edits to the source region.
 */
export interface ClonePayload {
	type: "clone";
	/** Asset id of the stroke mask (alpha coverage). */
	maskAssetId: string;
	/** Asset id of the REALIZED cloned ROI (RGBA PNG) — what export composites. */
	realizedPatchAssetId: string;
	patchEncoding: "png-rgba";
	/** Image the clone source pixels were sampled from. */
	sourceImageId: string;
	/** Source region (native page pixels) the pixels were copied from. */
	sourceBbox: { x: number; y: number; w: number; h: number };
	/** dest - source offset, in native page pixels. */
	offset: { dx: number; dy: number };
}

/** Phase B — the union of edit-layer payloads. */
export type ImageEditLayerPayload =
	| FillMaskPayload
	| PatchPayload
	| HealingPayload
	| ClonePayload;

/**
 * Phase B — the realized-patch commit input a paint tool hands the editor host (and
 * the host forwards to the store) for brush/healing/clone. The realized ROI PNG is
 * the durable export source; `mask` (for healing/clone) and the metadata are stored
 * for provenance. The host fills in `sourceImageId`/`index`/timestamps.
 */
export interface ImageEditLayerPatchCommitInput {
	/** Which tool kind produced the edit — selects the payload shape. */
	kind: "patch" | "healing" | "clone";
	/** The REALIZED ROI as an RGBA PNG blob (painted/healed/cloned pixels at bbox). */
	patchPng: Blob;
	/** Optional alpha-only stroke mask PNG (healing/clone provenance). */
	maskPng?: Blob;
	/** Image-space bbox the realized patch covers (native page pixels). */
	region: { x: number; y: number; width: number; height: number };
	/** Tool id + params recorded on the layer. */
	tool: { id: "brush" | "healing-brush" | "clone-stamp" | "background-edit"; params?: Record<string, unknown> };
	/** Healing-only metadata. */
	algorithm?: "telea";
	algorithmVersion?: string;
	/** Clone-only source metadata. */
	sourceBbox?: { x: number; y: number; w: number; h: number };
	offset?: { dx: number; dy: number };
}

export interface ImageEditLayer {
	id: string;
	name?: string;
	kind: ImageEditLayerKind;
	/** Phase A edits target the shared page background raster. */
	target: "page-background";
	/** Cleaning is SHARED across languages in Phase A, so this is absent. Reserved. */
	targetLang?: string;
	visible: boolean;
	locked?: boolean;
	opacity: number;
	/** Original page image this edit composites over. Keeps `page.imageId` intact. */
	sourceImageId: string;
	/** Image-space bounding box (native page pixels) the edit covers. */
	bbox: { x: number; y: number; w: number; h: number };
	/** The edit payload (Phase A: fill-mask; Phase B adds patch/healing/clone). */
	payload: ImageEditLayerPayload;
	/** Stack position (lower paints first). */
	index: number;
	/** The tool that produced the edit. Phase A: bubble-clean. */
	tool: {
		id: "brush" | "healing-brush" | "clone-stamp" | "bubble-clean" | "background-edit";
		params?: Record<string, unknown>;
	};
	createdAt: string;
	updatedAt?: string;
}

export type ImageLayerAlignment = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
export type ImageLayerBulkAction = "show-all" | "hide-all" | "lock-all" | "unlock-all";
export type ImageLayerTransformPreset = "fit-page" | "fill-width" | "fill-height" | "source-aspect" | "reset-rotation" | "reset-transform";

export interface TextLayerEffects {
	stroke?: {
		enabled: boolean;
		color: string;
		width: number;
	};
	outerGlow?: {
		enabled: boolean;
		color: string;
		blur: number;
		opacity: number;
	};
	dropShadow?: {
		enabled: boolean;
		offsetX: number;
		offsetY: number;
		blur: number;
		opacity: number;
		color: string;
	};
	accentShadows?: Array<{
		enabled: boolean;
		offsetX: number;
		offsetY: number;
		blur: number;
		opacity: number;
		color: string;
	}>;
	passes?: Array<{
		enabled: boolean;
		fill?: string;
		stroke?: string;
		strokeWidth?: number;
		offsetX: number;
		offsetY: number;
		opacity: number;
	}>;
}

export type TextStylePresetStyle = Partial<Pick<
	TextLayer,
	"fontSize" | "charSpacing" | "skewX" | "skewY" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "opacity" | "alignment" | "effects"
>>;

export interface TextStylePreset {
	id: string;
	name: string;
	builtIn?: boolean;
	promptTags?: string[];
	style: TextStylePresetStyle;
}

export type CreditPlacement = "top" | "bottom" | "left" | "right";
export type CreditApplyScope = "current" | "all" | "chapter-edges";

export interface CreditPreset {
	id: string;
	name: string;
	builtIn?: boolean;
	text: string;
	placement: CreditPlacement;
	offset: number;
	style: TextStylePresetStyle;
}

export type AiTier = "budget-clean" | "clean-pro" | "sfx-pro";

export interface AiCostEstimate {
	tier: AiTier;
	providerHint: string;
	currency: "THB";
	/** Quality-flat user-facing credit cost of the op (Low=1, Medium=9, High=36). */
	creditUnits?: number;
	quality?: "low" | "medium" | "high";
	outputSize?: string;
	megapixels: number;
	estimatedThb: number;
	reserveThb: number;
	pricingVersion: string;
}

export interface CreditReservation {
	status: "reserved" | "captured" | "released";
	amountThb: number;
	currency: "THB";
	createdAt: number;
	settledAt?: number;
	reason?: string;
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
	providerHint?: string;
	// NOTE: the internal system/template prompt is intentionally NOT part of the
	// marker — the backend never persists or serves it (leak-safe). Only the user's
	// own instruction is exposed, as `customPrompt`.
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
	 * Target language this AI result belongs to (Shape B, additive). Absent = the
	 * project's default target language (`ProjectState.targetLang`).
	 */
	targetLang?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TranslationScriptSlot {
	id: string;
	label: string;
	x: number;
	y: number;
	category?: "dialogue" | "narration" | "sfx" | "sign" | "title" | "other";
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
 * Per-language "Language Track" slice of a page (Shape B, additive).
 *
 * A Language Track is the pair (projectId, targetLang). Translation, typeset and
 * QC work is per-language, so the language-scoped buckets live here. Cleaning is
 * deliberately ABSENT: the cleaned raster is shared across all target languages,
 * so `Page.cleaningHandoff` stays project/source-level and is never duplicated here.
 *
 * Existing single-language data never populates `Page.languageOutputs`; the legacy
 * flat `Page.textLayers` / `translationScriptSlots` / handoffs are treated as the
 * project's default-language track via `pageOutput()` in `project/language-tracks.ts`.
 */
export interface PageLanguageOutput {
	textLayers: TextLayer[];
	translationScriptSlots?: TranslationScriptSlot[];
	translationHandoff?: PageTranslationHandoff;
	qcHandoff?: PageQcHandoff;
}

export interface Page {
	imageId: string;
	imageName: string;
	originalName?: string;
	textLayers: TextLayer[];
	translationScriptSlots?: TranslationScriptSlot[];
	translationHandoff?: PageTranslationHandoff;
	cleaningHandoff?: PageCleaningHandoff;
	qcHandoff?: PageQcHandoff;
	/**
	 * Per-language output buckets keyed by target language code (Shape B, additive).
	 * Absent on legacy/single-language pages — those render the flat fields above as
	 * the default-language track. Cleaning is intentionally NOT keyed here (shared raster).
	 */
	languageOutputs?: Record<string, PageLanguageOutput>;
	imageLayers?: ImageLayer[];
	edits?: { imageId: string };
	/**
	 * Non-destructive image edit stack (Phase A — bubble-clean). Each entry stores
	 * tiny edit DATA (mask asset + fill + bbox) composited over the ORIGINAL page
	 * image, instead of baking a full new page PNG into `edits.imageId`. SHARED at
	 * the page level (not per-language) in Phase A. The legacy `edits.imageId` baked
	 * path is kept as a render fallback (baked first, then these layers on top).
	 */
	imageEditLayers?: ImageEditLayer[];
	pendingAiJobs: AiJobInfo[];
	coverRect: { x: number; y: number; w: number; h: number } | null;
	/**
	 * W3.15 — long-page (webtoon) guardrails. Internal cut fractions (0..1) that
	 * split a single stitched long page image into logical sub-pages. Each value
	 * is the boundary between two stitched source pages as a fraction of image
	 * height. Empty / absent means the image is a single page. Editing tools are
	 * clipped to the active sub-page unless cross-page (multi-page) mode is on.
	 */
	pageBoundaries?: number[];
}

export interface AiJobInfo {
	jobId: string;
	crop: { x: number; y: number; w: number; h: number };
	status: "pending" | "processing" | "done" | "error" | "cancelled" | "blocked" | "needs_review";
	resultImageId?: string;
	error?: string;
}

export type CreditPolicy = "optional" | "required";
export type ExportProfileId = "draft-internal" | "public-export";
export type ProductionMode = "solo" | "team";

// Chapter-level team roster (per-project). Mirrors the backend ChapterTeamMember.
export type ChapterTeamRole = "translator" | "cleaner" | "typesetter" | "qc" | "guest";
export type ChapterTeamMemberStatus = "active" | "pending";
export interface ChapterTeamMember {
	id: string;
	userId?: string;
	email?: string;
	displayName?: string;
	role: ChapterTeamRole;
	status: ChapterTeamMemberStatus;
	invitedBy?: string;
	createdAt: string;
}

export type WorkspaceContactRelationship = "friend" | "follower" | "recent_collaborator";
export interface WorkspaceContact {
	id: string;
	ownerUserId: string;
	contactUserId?: string;
	email?: string;
	displayName?: string;
	relationship: WorkspaceContactRelationship;
	suggestedRole?: ChapterTeamRole;
	createdAt: string;
	updatedAt: string;
}

export type { ReadingDirection } from "./project/reading-direction.js";
import type { ReadingDirection } from "./project/reading-direction.js";

export interface ProjectState {
	projectId: string;
	/**
	 * Workspace this project belongs to. Real backend projects carry this; legacy
	 * file-mode / debug prototype projects may omit it (the realtime client then
	 * falls back to the shared "default" channel). Used to scope the SSE stream so
	 * the bell, locks, and live updates receive events for the active workspace.
	 */
	workspaceId?: string;
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
	pages: Page[];
	currentPage: number;
	sourceLang?: string;
	/**
	 * Default target language for the project. Always present (single-language model).
	 * In the per-language model this is also the implicit default track when
	 * `targetLangs` / `activeTargetLang` are absent.
	 */
	targetLang: string;
	/**
	 * Active "Language Tracks" for this project (Shape B, additive). Absent on
	 * single-language / legacy projects — treat as `[targetLang]`. The first/default
	 * track is the project's `targetLang`.
	 */
	targetLangs?: string[];
	/**
	 * Currently selected target language in the UI (Shape B, additive). Absent =
	 * `targetLang`. Used to scope per-language editing/preview/export to one track.
	 */
	activeTargetLang?: string;
	creditPolicy?: CreditPolicy;
	productionMode?: ProductionMode;
	// Chapter-level team roster. Absent ⇒ Solo / owner-only. Server-owned (mutated
	// only through the dedicated /:id/team endpoints).
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

export interface ExportRun {
	id: string;
	kind: ExportRunKind;
	status: ExportRunStatus;
	targetProfile?: ExportProfileId;
	/**
	 * Target language this export run produced (Shape B, additive). Absent = the
	 * project's default target language (`ProjectState.targetLang`).
	 */
	targetLang?: string;
	filename: string;
	pageIndexes: number[];
	pageCount: number;
	bytes?: number;
	artifact?: ExportArtifact;
	artifactError?: string;
	message: string;
	error?: string;
	failedPageIndex?: number;
	failedPageNumber?: number;
	/**
	 * Best-effort, IN-SESSION client-side export metering (client-ZIP path). A
	 * successful client-ZIP export delivers the file FIRST, then records usage via
	 * `POST /usage/:id/export`. If that record fails (network/429/409), the usage
	 * would otherwise be silently dropped. We stash the exact, idempotent record
	 * payload on the in-memory run and flag it pending; a later reconcile pass within
	 * the session replays it (reusing the same idempotency key, so a retry never
	 * double-counts). `meteringRecordedAt` marks a run already metered so reconcile
	 * skips it.
	 *
	 * NOT reload-durable: `exportRuns` is a server-owned collection (stripped on save),
	 * so a pending client-ZIP marker does not survive a page reload. Reload-durable,
	 * server-VERIFIED metering is owned by the server export pipeline (#316); client-ZIP
	 * bytes are unverifiable server-side and are metered best-effort only.
	 */
	meteringPending?: boolean;
	meteringRecordedAt?: string;
	meteringInput?: ExportMeteringInput;
	createdAt: string;
	completedAt: string;
}

/**
 * The exact payload replayed to `POST /usage/:projectId/export` for a pending
 * export run. Persisted on the run so a reconcile retry is byte-for-byte
 * identical and idempotent (same `idempotencyKey`).
 */
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
	storageDriver: string;
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
	 * Target language this task is scoped to (Shape B, additive). Absent = the
	 * project's default target language (`ProjectState.targetLang`). Cleaning tasks
	 * are language-agnostic (shared raster) and conventionally leave this absent.
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
		| "story_renamed"
		| "workspace_message_added"
		| "version_review_requested"
		| "version_review_updated"
		| "review_assigned"
		| "review_cancelled";
	message: string;
	actor: string;
	createdAt: string;
	pageIndex?: number;
	taskId?: string;
	metadata?: Record<string, unknown>;
}

export type ProjectCommentStatus = "open" | "resolved";

export type ReviewAnnotationShape = "pin" | "circle" | "rect" | "freehand";

/**
 * A lightweight review mark drawn directly on a page in the read-only review
 * reader (circle / freehand / rectangle / pin-comment). It is stored ON the
 * existing {@link ProjectComment} — NOT as a separate heavy task — so a reviewer
 * marking an issue just adds an anchored comment. All coordinates are NORMALIZED
 * to the page image (0..1 of width/height) so the mark overlays correctly on any
 * scale, including the downscaled preview the reader renders.
 */
export interface ReviewAnnotation {
	shape: ReviewAnnotationShape;
	/** Normalized bounding box (0..1) — anchor for pin/circle/rect and freehand bounds. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Freehand stroke as normalized (0..1) points. Present only for `shape === "freehand"`. */
	points?: { x: number; y: number }[];
	/** Optional stroke colour (hex). Defaults applied by the renderer when absent. */
	color?: string;
}

export interface ProjectComment {
	id: string;
	pageIndex: number;
	layerId?: string;
	region?: { x: number; y: number; w: number; h: number };
	/** Optional on-page review mark (circle/freehand/rect/pin) for the review reader. */
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

export type ReviewAssignmentStatus = "assigned" | "in_review" | "submitted" | "cancelled";

export interface ReviewAssignment {
	id: string;
	assigneeUserId: string;
	assigneeHandle?: string;
	targetLang?: string;
	pageIndexes?: number[];
	status: ReviewAssignmentStatus;
	assignedBy: string;
	dueAt?: string;
	priority?: WorkflowTaskPriority;
	instructions?: string;
	cancelReason?: string;
	cancelledBy?: string;
	cancelledAt?: string;
	createdAt: string;
	updatedAt: string;
}

export type RevisionRequestStatus =
	| "requested"
	| "in_progress"
	| "resubmitted"
	| "accepted"
	| "cancelled";

export interface RevisionRequest {
	id: string;
	revisionNumber: number;
	assignedToUserId: string;
	assignedToHandle?: string;
	reason: string;
	requestedBy: string;
	targetLang?: string;
	pageIndexes?: number[];
	sourceReviewDecisionId?: string;
	status: RevisionRequestStatus;
	dueAt?: string;
	priority?: WorkflowTaskPriority;
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
	body?: string;
	requester: string;
	reviewer?: string;
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
	 * Optional localized-title key + params for `activity` feed items. When the
	 * backend supplies these, the dashboard renders the template in the active
	 * locale; otherwise it falls back to `title` (back-compatible).
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

export interface AdminConfig {
	openrouterEnabled: boolean;
	openrouterApiKey: string;
	chatgptEnabled: boolean;
	primaryBackend: "chatgpt" | "openrouter";
}

export type Tool = "select" | "cover" | "brush" | "text";
export type AspectRatioKey = "Fit Width" | "1:1 Square" | "2:3 Tall" | "3:2 Wide" | "4:3" | "3:4" | "16:9 Wide" | "9:16 Tall";
