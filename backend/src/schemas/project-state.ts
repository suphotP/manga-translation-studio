// Strict-but-bounded validation for the full project-save body (POST /:id/save)
// and the per-row JSON-import entry (POST /:id/import-json).
//
// Design rules (see PR "Validation: strict ProjectState save + ..."):
//   * The save body is the WHOLE ProjectState a client can persist verbatim, so a
//     missing bound here is a real durability/abuse hole (NaN/Infinity geometry,
//     negative sizes, multi-megabyte text, unbounded arrays). We REJECT those with
//     a 400 instead of writing them to disk.
//   * BUT the editor reloads the full normalized GET response and re-saves it, so
//     the schema must accept every field a legitimate save round-trips today.
//     Where a sub-object's exact shape is server-owned and/or still evolving
//     (handoffs, server-owned collections that /save discards and rebuilds from the
//     persisted state anyway), we keep the object PERMISSIVE (`.loose()` keeps
//     unknown keys) but still cap array sizes / string lengths so an oversized
//     payload can't slip through a permissive branch.
//   * Geometry-bearing layer objects (text/image layers) are the real attack
//     surface, so their coordinates/sizes are validated finite + in-range and
//     their text/string fields are length-capped.
import { z } from "zod/v4";

// ── Bounds ───────────────────────────────────────────────────────────────────
// Image-space coordinate limit. Webtoon strips can be tens of thousands of px
// tall and layers may sit partly off-canvas, so this is deliberately generous
// (1e6 px) — it only exists to reject absurd / non-finite geometry, not to clamp
// legitimate large pages.
export const MAX_COORD = 1_000_000;
export const MIN_COORD = -MAX_COORD;
// Sizes (w/h) must be positive and finite. Same generous upper bound.
export const MAX_SIZE = 1_000_000;

export const MAX_PAGES = 5_000;
export const MAX_LAYERS_PER_PAGE = 5_000;
export const MAX_TEXT_LAYER_TEXT = 20_000;
export const MAX_NAME_LEN = 1_000;
export const MAX_ID_LEN = 400;
export const MAX_FONT_SIZE = 5_000;
export const MAX_SCRIPT_SLOTS_PER_PAGE = 5_000;
export const MAX_LANGUAGE_OUTPUTS = 200;
// Server-owned collections are discarded + rebuilt by /save, but still bound them
// so a save can't be used to ship a giant array through the permissive branch.
export const MAX_SERVER_COLLECTION = 50_000;
export const MAX_PRESETS = 2_000;
export const MAX_TARGET_LANGS = 200;

// Total raw save-body size cap (a backstop above all per-field bounds). The prod
// node server runs with BODY_SIZE_LIMIT=Infinity, so this is the only guard on the
// overall payload size. 64 MiB is far above any legitimate project state.
export const MAX_SAVE_BODY_BYTES = 64 * 1024 * 1024;

// Import (per-row) bounds.
export const MAX_IMPORT_TEXT = 20_000;
// bbox/box coordinates live in source-image space — same generous finite bound.
export const MAX_IMPORT_COORD = 1_000_000;

// ── Reusable primitives ────────────────────────────────────────────────────────
const finiteCoord = z.number().finite().min(MIN_COORD).max(MAX_COORD);
const finiteSize = z.number().finite().min(0).max(MAX_SIZE);
const shortId = z.string().max(MAX_ID_LEN);
const shortName = z.string().max(MAX_NAME_LEN);

// ── Scalar field validators (audit #323 follow-up) ────────────────────────────
// These four scalars were previously plain finite numbers, accepting nonsensical
// values (opacity=2, negative page/layer index, absurd rotation). We tighten them
// to the range the editor legitimately produces, chosen from the real ProjectState
// types + test fixtures so no legitimate save round-trips to a 400:
//
//   * opacity — an alpha MULTIPLIER. The frontend clamps it to [0,1] everywhere
//     (`Math.max(0, Math.min(1, …))` in editor.svelte.ts / canvas/editor.ts), so
//     a value outside [0,1] is never legitimate and mis-renders export/canvas.
//   * index — a per-page layer position derived from array length/offset
//     (`page.textLayers.length`, `startIndex + i`, …): always a NON-NEGATIVE
//     INTEGER, bounded by the per-page layer cap. Negatives / floats are invalid.
//   * currentPage — a 0-based page pointer into `pages`: a non-negative integer,
//     bounded by MAX_PAGES. (Kept generously at the page cap rather than the
//     current array length, since the save body's `pages` length is validated
//     separately and a transient pointer past the end must not 400 a save.)
//   * rotation — a Fabric `angle` (degrees). The editor does NOT normalize OR
//     clamp it: the image-layer Inspector writes arbitrary user-entered angles
//     straight into `angle`, and accumulated/cross-boundary spins are legitimate
//     serialized state. So we only require FINITE (NaN/Infinity excluded) — a
//     magnitude bound would wrongly 400 a real save (e.g. a user-typed 4000°).
const layerOpacity = z.number().finite().min(0).max(1);
const layerIndex = z.number().int().min(0).max(MAX_LAYERS_PER_PAGE);
const rotationDeg = z.number().finite();

// ── Bounded catch-all for unknown / additive fields ──────────────────────────────
// The permissive object branches below must KEEP unknown keys (so an additive
// frontend field never breaks a legitimate save), but `.loose()` passed them
// through UNBOUNDED — a malicious save could persist a multi-megabyte string, a
// giant array, or a deeply-nested structure under a key the schema doesn't model
// (a real DoS / storage-abuse hole, since the prod node server runs with
// BODY_SIZE_LIMIT=Infinity). Instead we accept ANY JSON value for unknown keys but
// cap string length, array length, and nesting DEPTH. Built eagerly to a finite
// depth (beyond it only scalars are allowed) so the validator itself can't be made
// to recurse without bound by a depth-bomb payload.
const MAX_UNKNOWN_STRING = 200_000;
const MAX_UNKNOWN_ARRAY = 50_000;
const MAX_UNKNOWN_DEPTH = 16;
// Cap object BREADTH too: without it an unknown value could be an object with
// millions of short keys (the string/array/depth bounds don't catch that).
const MAX_UNKNOWN_KEYS = 10_000;

function buildBoundedUnknown(depth: number): z.ZodType {
	const scalar = z.union([
		z.string().max(MAX_UNKNOWN_STRING),
		z.number().finite(),
		z.boolean(),
		z.null(),
	]);
	if (depth <= 0) return scalar;
	const child = buildBoundedUnknown(depth - 1);
	return z.union([
		z.string().max(MAX_UNKNOWN_STRING),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(child).max(MAX_UNKNOWN_ARRAY),
		z.record(z.string().max(MAX_ID_LEN), child).refine(
			(obj) => Object.keys(obj).length <= MAX_UNKNOWN_KEYS,
			{ message: `Too many object keys (max ${MAX_UNKNOWN_KEYS})` },
		),
	]);
}

// A single shared instance reused as the `.catchall(...)` of every permissive
// object, so unknown keys are bounded everywhere.
export const boundedUnknownValue = buildBoundedUnknown(MAX_UNKNOWN_DEPTH);

// A bounded rect (x/y/w/h). Used by coverRect / regions. Permissive on extra keys
// is unnecessary here — the shape is fixed — but we keep it loose-tolerant by only
// validating the four numeric fields strictly.
const rectSchema = z.object({
	x: finiteCoord,
	y: finiteCoord,
	w: finiteSize,
	h: finiteSize,
}).catchall(boundedUnknownValue);

// ── Text layer ─────────────────────────────────────────────────────────────────
// The real geometry/size attack surface. Coordinates finite + in-range, sizes
// non-negative + bounded, text length-capped. Unknown keys are KEPT (`.loose()`)
// so an additive frontend field never breaks a legitimate save, but the bounded
// fields above are enforced.
const textLayerSchema = z.object({
	id: shortId,
	name: shortName.optional(),
	text: z.string().max(MAX_TEXT_LAYER_TEXT),
	sourceText: z.string().max(MAX_TEXT_LAYER_TEXT).optional(),
	x: finiteCoord,
	y: finiteCoord,
	w: finiteSize,
	h: finiteSize,
	rotation: rotationDeg,
	opacity: layerOpacity.optional(),
	fontSize: z.number().finite().min(0).max(MAX_FONT_SIZE),
	index: layerIndex,
}).catchall(boundedUnknownValue);

// ── Image layer ─────────────────────────────────────────────────────────────────
const imageLayerSchema = z.object({
	id: shortId,
	imageId: shortId,
	imageName: shortName,
	x: finiteCoord,
	y: finiteCoord,
	w: finiteSize,
	h: finiteSize,
	rotation: rotationDeg,
	opacity: layerOpacity,
	index: layerIndex,
}).catchall(boundedUnknownValue);

// ── Image edit layer (Phase A — non-destructive bubble-clean) ────────────────────
// A tiny non-destructive edit: a small mask asset id + a fill colour + the bbox it
// covers, composited over the ORIGINAL page image instead of baking a full new PNG.
// Geometry-bearing (bbox) so coordinates/sizes are validated; the channel bytes are
// 0..255 RGBA. Unknown keys kept-but-bounded so later phases (patch/clone/healing)
// extend the payload without a migration.
const colorByte = z.number().finite().min(0).max(255);
const fillMaskPayloadSchema = z.object({
	type: z.literal("fill-mask"),
	maskAssetId: shortId,
	maskEncoding: z.literal("png-alpha"),
	fill: z.object({ r: colorByte, g: colorByte, b: colorByte, a: colorByte }).catchall(boundedUnknownValue),
}).catchall(boundedUnknownValue);

// Phase B — soft/sampled brush stroke: a small RGBA ROI asset composited at bbox.
const patchPayloadSchema = z.object({
	type: z.literal("patch"),
	patchAssetId: shortId,
	patchEncoding: z.literal("png-rgba"),
}).catchall(boundedUnknownValue);

// Phase B — healing-brush: realized healed ROI asset + mask + algorithm metadata.
const healingPayloadSchema = z.object({
	type: z.literal("healing"),
	maskAssetId: shortId,
	realizedPatchAssetId: shortId,
	patchEncoding: z.literal("png-rgba"),
	algorithm: z.string().max(MAX_ID_LEN),
	algorithmVersion: z.string().max(MAX_ID_LEN),
}).catchall(boundedUnknownValue);

// Phase B — clone-stamp: realized cloned ROI asset + source metadata.
const cloneOffsetSchema = z.object({
	dx: finiteCoord,
	dy: finiteCoord,
}).catchall(boundedUnknownValue);
const sourceBboxSchema = z.object({
	x: finiteCoord,
	y: finiteCoord,
	w: finiteSize,
	h: finiteSize,
}).catchall(boundedUnknownValue);
const clonePayloadSchema = z.object({
	type: z.literal("clone"),
	maskAssetId: shortId,
	realizedPatchAssetId: shortId,
	patchEncoding: z.literal("png-rgba"),
	sourceImageId: shortId,
	sourceBbox: sourceBboxSchema,
	offset: cloneOffsetSchema,
}).catchall(boundedUnknownValue);

// Discriminated union of every edit-layer payload. A `.catchall` keeps unknown keys
// bounded so a future payload field is additive without a migration.
const editLayerPayloadSchema = z.discriminatedUnion("type", [
	fillMaskPayloadSchema,
	patchPayloadSchema,
	healingPayloadSchema,
	clonePayloadSchema,
]);

// P2 EXPORT-PARITY — an edit-layer bbox is the NATIVE page-pixel rectangle the mask
// covers, so x/y MUST be ≥ 0 (the mask maps onto on-page pixels). The frontend
// compositor draws the mask AT bbox.x/y and clips anything off the left/top edge,
// while the backend (export-edit-layers.ts `roundNonNegative`) CLAMPS left/top to 0
// — i.e. it SHIFTS the pixels right/down instead of clipping. A negative x/y would
// therefore export DIFFERENTLY on the two paths (clipped vs shifted). Rejecting
// negative x/y here makes that impossible, so client + server stay byte-aligned.
// (w/h use the shared finiteSize, which is already ≥ 0.)
const nonNegativeCoord = z.number().finite().min(0).max(MAX_COORD);
const editBboxSchema = z.object({
	x: nonNegativeCoord,
	y: nonNegativeCoord,
	w: finiteSize,
	h: finiteSize,
}).catchall(boundedUnknownValue);

const imageEditLayerSchema = z.object({
	id: shortId,
	name: shortName.optional(),
	kind: z.string().max(MAX_ID_LEN),
	target: z.string().max(MAX_ID_LEN),
	targetLang: z.string().max(MAX_ID_LEN).optional(),
	visible: z.boolean(),
	locked: z.boolean().optional(),
	opacity: layerOpacity,
	sourceImageId: shortId,
	bbox: editBboxSchema,
	payload: editLayerPayloadSchema,
	index: layerIndex,
	tool: z.object({ id: z.string().max(MAX_ID_LEN) }).catchall(boundedUnknownValue),
	createdAt: z.string().max(MAX_ID_LEN),
	updatedAt: z.string().max(MAX_ID_LEN).optional(),
}).catchall(boundedUnknownValue);

// ── Per-language output bucket ───────────────────────────────────────────────────
// Both textLayers AND imageLayers are real per-language fields the client/backend
// export read (languageOutputs[lang].imageLayers), so the tightened layer scalars
// must cover them here too — otherwise image-layer opacity/rotation/index would slip
// through the permissive catchall unvalidated.
const languageOutputSchema = z.object({
	textLayers: z.array(textLayerSchema).max(MAX_LAYERS_PER_PAGE),
	imageLayers: z.array(imageLayerSchema).max(MAX_LAYERS_PER_PAGE).optional(),
}).catchall(boundedUnknownValue);

// ── Page ─────────────────────────────────────────────────────────────────────────
// Geometry-bearing arrays are validated per-element; handoff / script-slot
// sub-objects stay permissive (server-owned shape, still evolving) but are array-
// and length-bounded. coverRect is a bounded rect | null.
const pageSchema = z.object({
	imageId: shortId,
	imageName: shortName,
	textLayers: z.array(textLayerSchema).max(MAX_LAYERS_PER_PAGE),
	imageLayers: z.array(imageLayerSchema).max(MAX_LAYERS_PER_PAGE).optional(),
	imageEditLayers: z.array(imageEditLayerSchema).max(MAX_LAYERS_PER_PAGE).optional(),
	translationScriptSlots: z.array(boundedUnknownValue).max(MAX_SCRIPT_SLOTS_PER_PAGE).optional(),
	languageOutputs: z.record(z.string().max(MAX_ID_LEN), languageOutputSchema)
		.refine((map) => Object.keys(map).length <= MAX_LANGUAGE_OUTPUTS, {
			message: `Too many language outputs (max ${MAX_LANGUAGE_OUTPUTS})`,
		})
		.optional(),
	coverRect: z.union([rectSchema, z.null()]).optional(),
}).catchall(boundedUnknownValue);

// ── Full project state (save body) ──────────────────────────────────────────────
// Strictly validates the geometry-bearing `pages` array and bounds the top-level
// arrays / strings; keeps unknown top-level keys (`.loose()`) so additive
// ProjectState fields never break a legitimate save. Server-owned collections
// (tasks/activityLog/comments/...) are discarded and rebuilt from the persisted
// state by the /save handler, so we only bound their size here, not their shape.
const boundedServerArray = z.array(boundedUnknownValue).max(MAX_SERVER_COLLECTION).optional();

export const projectStateSaveSchema = z.object({
	projectId: shortId,
	userId: shortId.optional(),
	workspaceId: shortId.optional(),
	name: shortName.optional(),
	pages: z.array(pageSchema).max(MAX_PAGES),
	// `currentPage` is part of ProjectState but legitimate minimal save bodies omit
	// it (the handler tolerates that), so it is optional-but-bounded here. It is a
	// 0-based page pointer: a non-negative integer bounded by the page cap.
	currentPage: z.number().int().min(0).max(MAX_PAGES).optional(),
	targetLang: z.string().max(MAX_ID_LEN).optional(),
	targetLangs: z.array(z.string().max(MAX_ID_LEN)).max(MAX_TARGET_LANGS).optional(),
	textStylePresets: z.array(boundedUnknownValue).max(MAX_PRESETS).optional(),
	creditPresets: z.array(boundedUnknownValue).max(MAX_PRESETS).optional(),
	tasks: boundedServerArray,
	activityLog: boundedServerArray,
	comments: boundedServerArray,
	aiReviewMarkers: boundedServerArray,
	reviewDecisions: boundedServerArray,
	workspaceMessages: boundedServerArray,
	versionReviewRequests: boundedServerArray,
	exportRuns: boundedServerArray,
}).catchall(boundedUnknownValue);

// ── JSON-import per-row entry ────────────────────────────────────────────────────
// One bad row must not 500 the whole import, so the endpoint parses each row with
// `.safeParse` and skips failures with a reason. This schema bounds the text
// length and requires finite + upper-bounded bbox/box so a malicious row can't
// persist a multi-megabyte string or an absurd / NaN coordinate. Unknown keys are
// kept (imports carry many provider-specific aliases consumed downstream).
const importCoord = z.number().finite().min(-MAX_IMPORT_COORD).max(MAX_IMPORT_COORD);
const boundedString = z.string().max(MAX_IMPORT_TEXT);

export const importEntrySchema = z.object({
	// Text aliases — any may carry the (length-capped) string.
	translated_text: boundedString.optional(),
	translation: boundedString.optional(),
	thai: boundedString.optional(),
	targetText: boundedString.optional(),
	original_text: boundedString.optional(),
	sourceText: boundedString.optional(),
	source_text: boundedString.optional(),
	text: boundedString.optional(),
	// Geometry: 4-tuples of finite, in-range coordinates.
	bbox: z.array(importCoord).max(8).optional(),
	box: z.array(importCoord).max(8).optional(),
}).catchall(boundedUnknownValue);

export type ImportEntryValidation =
	| { ok: true; entry: Record<string, unknown> }
	| { ok: false; reason: "invalid_entry" };

// Validate a single import row. Non-objects and rows that violate the bounds above
// (oversized text, non-finite / out-of-range bbox) are reported as invalid_entry so
// the caller can skip + count them without failing the whole import.
export function validateImportEntry(entry: unknown): ImportEntryValidation {
	const parsed = importEntrySchema.safeParse(entry);
	if (!parsed.success) return { ok: false, reason: "invalid_entry" };
	return { ok: true, entry: parsed.data as Record<string, unknown> };
}
