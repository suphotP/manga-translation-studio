// Wave 3 W3.10: server-side export pipeline + signed URLs.
//
// !! NOT the user-facing CANONICAL deliverable export. !!
// The export users actually download (chapter ZIP + single page) is rendered
// 100% in the BROWSER from the live Fabric canvas — see
// `frontend/src/lib/project/page-export.ts` (`exportPagesToZip`) and the editor's
// `exportMergedImageDataUrl`. That client render is pixel-accurate to the editor
// (real fonts, strokes, glows, drop-shadows, blend modes). Its bytes are uploaded
// verbatim as the durable artifact via POST /project/:id/exports/:runId/artifact
// (stored as-is, never re-rendered) and re-served on download/retry. NO frontend
// surface calls this server pipeline (no `POST /api/export` caller; the only
// `ExportRunKind`s are "single-page" | "batch-zip", both Fabric).
//
// This pipeline renders TEXT with a simplistic SVG path that does NOT match the
// editor, so it must NEVER become the bytes a user downloads as "the export".
// It exists only for server-side web-optimized DERIVATIVES (jpeg/webp/avif,
// webtoon split, downscaled reader variants) behind the API. If you ever wire a
// user-facing export to this pipeline, you reintroduce the SVG/Fabric mismatch
// Option A removed — render client-side (page-export.ts) and upload those bytes.
//
// Produces web-optimized derivatives of a project's pages on the server and
// hands the client a short-TTL signed URL to download the result, instead of
// shipping full-res originals to the browser. The SOURCE IS NEVER MODIFIED:
// every transform reads the original via objectStorage.getProjectImage and
// writes a brand-new object under an `exports/` key (objectStorage.putProjectExport).
//
// Job lifecycle (persisted in export_jobs): queued -> processing -> done | error.
// A standalone async processor (runDueExportJobs / processExportJob) drains the
// queue; there is no coupling to the AI JobQueue, whose AiJob shape and credit
// reservations are AI-specific.

import { getSharedBunSql } from "./sql-pool.js";
import { randomUUID } from "crypto";
import sharp from "sharp";
import type { ImageLayerData, PageState, ProjectState, TextLayerData } from "../types/index.js";
import { objectStorage, type ObjectStorage } from "./storage.js";
import { compositeImageLayers, type ExportImageLayerPlan, type ImageLayerReadinessAssert } from "./export-image-layers.js";
import { compositeEditLayers, type ExportEditLayerPlan } from "./export-edit-layers.js";
import { getAssetRecordAuthoritative, isNeverGrandfatherImageId } from "./assets.js";
import {
	reserveProjectStorageQuota,
	releaseProjectStorageQuotaReservationBestEffort,
	type StorageQuotaReservation,
} from "./storage-quota.js";
import { recordExportUsage } from "./usage-ledger.js";
import { clampSplitThreshold } from "./image-merge-split.js";

// ── Presets ───────────────────────────────────────────────────────────────

export type ExportPreset = "master" | "web_reader" | "webtoon_split" | "mobile" | "webp_avif";

export const EXPORT_PRESETS: readonly ExportPreset[] = [
	"master",
	"web_reader",
	"webtoon_split",
	"mobile",
	"webp_avif",
] as const;

export function isExportPreset(value: unknown): value is ExportPreset {
	return typeof value === "string" && (EXPORT_PRESETS as readonly string[]).includes(value);
}

export type ExportFormat = "original" | "jpeg" | "webp" | "avif";

export interface ExportPresetConfig {
	preset: ExportPreset;
	/** Max output width in px; undefined = keep source width. */
	maxWidth?: number;
	/** Output encoder; "original" copies the source bytes untouched. */
	format: ExportFormat;
	/** Encoder quality 1-100 (ignored for "original"). */
	quality?: number;
	/**
	 * For webtoon_split: slice a tall page into vertical chunks of these pixel
	 * heights (after any width resize) and emit a manifest.json describing them.
	 */
	sliceHeights?: number[];
}

// Built-in preset definitions. Kept pure + exported so routes/tests can read the
// canonical config without constructing a job.
const PRESET_CONFIGS: Record<ExportPreset, ExportPresetConfig> = {
	// Master = untouched full-res original. No resize, no re-encode.
	master: { preset: "master", format: "original" },
	// Web reader = max-width 1200, JPEG q85.
	web_reader: { preset: "web_reader", maxWidth: 1200, format: "jpeg", quality: 85 },
	// Webtoon split = slice tall pages into 1500/2000/3000px chunks + manifest.
	webtoon_split: { preset: "webtoon_split", format: "jpeg", quality: 85, sliceHeights: [1500, 2000, 3000] },
	// Mobile = max-width 720, JPEG q75.
	mobile: { preset: "mobile", maxWidth: 720, format: "jpeg", quality: 75 },
	// Modern formats = WebP/AVIF. AVIF gives the smallest files at equal quality.
	webp_avif: { preset: "webp_avif", maxWidth: 1600, format: "avif", quality: 60 },
};

export function getExportPresetConfig(preset: ExportPreset): ExportPresetConfig {
	return PRESET_CONFIGS[preset];
}

// ── DoS / admission limits ───────────────────────────────────────────────────
// All read from env at call time (operator-tunable, test-overridable) with
// generous defaults that never bite a real manga/webtoon export.

function readPositiveIntLimitEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Minimum accepted webtoon slice/chunk height (px). A client override of a tiny
// height (e.g. sliceHeights: [1]) would otherwise make sliceTall loop a page into
// height/1 outputs — a cheap way to explode one page into tens of thousands of
// Sharp encodes. Any configured slice height below this floor is clamped UP.
// 200px is far below any real webtoon chunk (1500-3000) yet bounds the loop.
export function minExportSliceHeight(): number {
	return readPositiveIntLimitEnv("EXPORT_MIN_SLICE_HEIGHT", 200);
}

// Hard cap on the number of slice outputs a SINGLE source page may produce. Even
// after the min-slice-height clamp, a pathological (legitimately huge) page could
// still produce many chunks; this bounds the per-page output count so one page can
// never balloon the job. 400 slices × the min height already covers a 80k px page.
export function maxExportOutputsPerPage(): number {
	return readPositiveIntLimitEnv("EXPORT_MAX_OUTPUTS_PER_PAGE", 400);
}

// Hard ceiling on the TOTAL output pixels a single export job may render before we
// begin Sharp decode/encode work. Estimated up-front from page count × per-page
// source pixels (capped by any width resize), so a job whose outputs would clearly
// OOM the box is rejected BEFORE the expensive sequential render/write loop starts.
// 4 Gpx ≈ 500 pages × 8 MP, generous for a real chapter export while stopping a
// 500×(huge-bomb) job up front. (The per-image upload pixel ceiling already bounds
// each source, so this is the job-level aggregate guard.)
export function maxExportJobTotalPixels(): number {
	const raw = process.env.MAX_EXPORT_JOB_MEGAPIXELS;
	const fallback = 4000; // 4000 MP = 4 Gpx
	const parsed = raw ? Number(raw) : NaN;
	const mp = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	return Math.round(mp * 1_000_000);
}

/**
 * Thrown when a job's estimated total output pixel budget exceeds
 * {@link maxExportJobTotalPixels} BEFORE the render loop allocates any Sharp
 * buffers. Carries the estimate so the processor can record an actionable,
 * non-leaking job error instead of OOM-ing mid-render.
 */
export class ExportJobTooLargeError extends Error {
	readonly estimatedPixels: number;
	readonly maxPixels: number;

	constructor(estimatedPixels: number, maxPixels: number) {
		super(`Export job exceeds the maximum total output size (estimated ${Math.round(estimatedPixels / 1_000_000)} MP > ${Math.round(maxPixels / 1_000_000)} MP limit)`);
		this.name = "ExportJobTooLargeError";
		this.estimatedPixels = estimatedPixels;
		this.maxPixels = maxPixels;
	}
}

export function listExportPresetConfigs(): ExportPresetConfig[] {
	return EXPORT_PRESETS.map((preset) => PRESET_CONFIGS[preset]);
}

// ── Job model ───────────────────────────────────────────────────────────────

export type ExportJobStatus = "queued" | "processing" | "done" | "error";

export interface ExportJob {
	id: string;
	workspaceId?: string;
	projectId: string;
	chapterId?: string;
	requestedBy?: string;
	targetLang?: string;
	preset: ExportPreset;
	status: ExportJobStatus;
	resultKey?: string;
	resultSignedUrl?: string;
	error?: string;
	params: Record<string, unknown>;
	createdAt: string;
	completedAt?: string;
}

export interface EnqueueExportJobInput {
	workspaceId?: string;
	projectId: string;
	chapterId?: string;
	requestedBy?: string;
	/** The RESOLVED track persisted on the job (request value, or the project default when omitted). */
	targetLang?: string;
	/**
	 * The RAW caller-supplied track, before defaulting, used only to decide whether
	 * the request is an EXPLICIT non-default track. When omitted, falls back to
	 * `targetLang`. Lets the enqueue guard reject a missing explicit language without
	 * confusing it with the omitted/default case.
	 */
	requestedTargetLang?: string;
	preset: ExportPreset;
	/** Image ids (page sources) to render. The processor never mutates them. */
	imageIds: string[];
	/** Optional project state lets the queue persist per-page language render plans. */
	state?: ProjectState;
	/** Optional per-request overrides merged over the preset config. */
	params?: Record<string, unknown>;
}

export class ExportJobNotFoundError extends Error {
	constructor(readonly jobId: string) {
		super(`Export job ${jobId} not found`);
		this.name = "ExportJobNotFoundError";
	}
}

// ── Store ─────────────────────────────────────────────────────────────────

export interface ExportJobStoreSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

export interface ExportJobStore {
	create(job: ExportJob): Promise<ExportJob>;
	get(id: string): Promise<ExportJob | undefined>;
	/** Scope a read to a workspace so cross-tenant ids never resolve. */
	getForWorkspace(id: string, workspaceId: string | undefined): Promise<ExportJob | undefined>;
	update(id: string, patch: Partial<ExportJob>): Promise<ExportJob | undefined>;
	/**
	 * Atomically move one queued job to processing and return it, so concurrent
	 * processors never pick up the same job. Returns undefined when the queue is
	 * empty.
	 */
	claimNextQueued(): Promise<ExportJob | undefined>;
	/**
	 * Enumerate `done` jobs whose export-bytes metering is durably stuck
	 * (`params.usageMeteringPending === true`) so the drainer can retry the
	 * (idempotent) record and clear the marker. Best-effort reconciliation only.
	 */
	listPendingUsageMetering(): Promise<ExportJob[]>;
}

interface ExportJobRow {
	id: string;
	workspace_id?: string | null;
	project_id: string;
	chapter_id?: string | null;
	requested_by?: string | null;
	target_lang?: string | null;
	preset: string;
	status: string;
	result_key?: string | null;
	result_signed_url?: string | null;
	error?: string | null;
	params?: unknown;
	created_at: Date | string;
	completed_at?: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	return value instanceof Date ? value.toISOString() : String(value);
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return {};
}

function mapRow(row: ExportJobRow): ExportJob {
	return {
		id: row.id,
		workspaceId: row.workspace_id ?? undefined,
		projectId: row.project_id,
		chapterId: row.chapter_id ?? undefined,
		requestedBy: row.requested_by ?? undefined,
		targetLang: row.target_lang ?? undefined,
		preset: row.preset as ExportPreset,
		status: row.status as ExportJobStatus,
		resultKey: row.result_key ?? undefined,
		resultSignedUrl: row.result_signed_url ?? undefined,
		error: row.error ?? undefined,
		params: parseJsonColumn(row.params),
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
		completedAt: toIso(row.completed_at),
	};
}

const EXPORT_JOB_COLUMNS = `
	id,
	workspace_id,
	project_id,
	chapter_id,
	requested_by,
	target_lang,
	preset,
	status,
	result_key,
	result_signed_url,
	error,
	params,
	created_at,
	completed_at
`.trim();

/**
 * In-memory store used in file/prototype mode and unit tests. Concurrency-safe
 * for the single-process prototype: claimNextQueued flips status synchronously.
 */
export class MemoryExportJobStore implements ExportJobStore {
	private readonly jobs = new Map<string, ExportJob>();

	async create(job: ExportJob): Promise<ExportJob> {
		this.jobs.set(job.id, { ...job });
		return { ...job };
	}

	async get(id: string): Promise<ExportJob | undefined> {
		const job = this.jobs.get(id);
		return job ? { ...job } : undefined;
	}

	async getForWorkspace(id: string, workspaceId: string | undefined): Promise<ExportJob | undefined> {
		const job = await this.get(id);
		if (!job) return undefined;
		// A workspace-scoped read must not resolve another tenant's job. When the
		// caller has no workspace context (anonymous prototype), only jobs that are
		// likewise unscoped are visible.
		if ((job.workspaceId ?? undefined) !== (workspaceId ?? undefined)) return undefined;
		return job;
	}

	async update(id: string, patch: Partial<ExportJob>): Promise<ExportJob | undefined> {
		const existing = this.jobs.get(id);
		if (!existing) return undefined;
		const next = { ...existing, ...patch, id: existing.id };
		this.jobs.set(id, next);
		return { ...next };
	}

	async claimNextQueued(): Promise<ExportJob | undefined> {
		const queued = [...this.jobs.values()]
			.filter((job) => job.status === "queued")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
		if (!queued) return undefined;
		const claimed = { ...queued, status: "processing" as const };
		this.jobs.set(claimed.id, claimed);
		return { ...claimed };
	}

	async listPendingUsageMetering(): Promise<ExportJob[]> {
		return [...this.jobs.values()]
			.filter((job) => job.status === "done" && job.params?.usageMeteringPending === true)
			.map((job) => ({ ...job }));
	}
}

export class PostgresExportJobStore implements ExportJobStore {
	private readonly client: ExportJobStoreSqlClient;

	constructor(client?: ExportJobStoreSqlClient, databaseUrl = process.env.DATABASE_URL) {
		if (client) {
			this.client = client;
			return;
		}
		if (!databaseUrl?.trim()) {
			throw new Error("PostgresExportJobStore requires DATABASE_URL");
		}
		this.client = getSharedBunSql(databaseUrl) as unknown as ExportJobStoreSqlClient;
	}

	async create(job: ExportJob): Promise<ExportJob> {
		await this.client.unsafe(`
			INSERT INTO export_jobs (
				id, workspace_id, project_id, chapter_id, requested_by, target_lang,
				preset, status, result_key, result_signed_url, error, params, created_at, completed_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb, $13, $14)
		`, [
			job.id,
			job.workspaceId ?? null,
			job.projectId,
			job.chapterId ?? null,
			job.requestedBy ?? null,
			job.targetLang ?? null,
			job.preset,
			job.status,
			job.resultKey ?? null,
			job.resultSignedUrl ?? null,
			job.error ?? null,
			JSON.stringify(job.params ?? {}),
			job.createdAt,
			job.completedAt ?? null,
		]);
		return job;
	}

	async get(id: string): Promise<ExportJob | undefined> {
		const rows = await this.client.unsafe<ExportJobRow>(`
			SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs WHERE id = $1 LIMIT 1
		`, [id]);
		return rows[0] ? mapRow(rows[0]) : undefined;
	}

	async getForWorkspace(id: string, workspaceId: string | undefined): Promise<ExportJob | undefined> {
		// Push the workspace predicate into SQL so a cross-tenant id never returns a
		// row. NULL workspace_id (anonymous prototype) is only visible to a likewise
		// unscoped caller.
		const rows = workspaceId
			? await this.client.unsafe<ExportJobRow>(`
				SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs WHERE id = $1 AND workspace_id = $2 LIMIT 1
			`, [id, workspaceId])
			: await this.client.unsafe<ExportJobRow>(`
				SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs WHERE id = $1 AND workspace_id IS NULL LIMIT 1
			`, [id]);
		return rows[0] ? mapRow(rows[0]) : undefined;
	}

	async update(id: string, patch: Partial<ExportJob>): Promise<ExportJob | undefined> {
		const sets: string[] = [];
		const params: unknown[] = [id];
		let next = 2;
		const push = (column: string, value: unknown, cast = "") => {
			sets.push(`${column} = $${next}${cast}`);
			params.push(value);
			next += 1;
		};
		if ("status" in patch) push("status", patch.status);
		if ("resultKey" in patch) push("result_key", patch.resultKey ?? null);
		if ("resultSignedUrl" in patch) push("result_signed_url", patch.resultSignedUrl ?? null);
		if ("error" in patch) push("error", patch.error ?? null);
		if ("targetLang" in patch) push("target_lang", patch.targetLang ?? null);
		if ("params" in patch) push("params", JSON.stringify(patch.params ?? {}), "::text::jsonb");
		if ("completedAt" in patch) push("completed_at", patch.completedAt ?? null);
		if (sets.length === 0) return this.get(id);
		const rows = await this.client.unsafe<ExportJobRow>(`
			UPDATE export_jobs SET ${sets.join(", ")} WHERE id = $1 RETURNING ${EXPORT_JOB_COLUMNS}
		`, params);
		return rows[0] ? mapRow(rows[0]) : undefined;
	}

	async claimNextQueued(): Promise<ExportJob | undefined> {
		// SKIP LOCKED makes concurrent processors claim distinct jobs without
		// blocking each other; the subquery + UPDATE...RETURNING flips exactly one
		// queued row to processing atomically.
		const rows = await this.client.unsafe<ExportJobRow>(`
			UPDATE export_jobs SET status = 'processing'
			WHERE id = (
				SELECT id FROM export_jobs
				WHERE status = 'queued'
				ORDER BY created_at ASC, id ASC
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			)
			RETURNING ${EXPORT_JOB_COLUMNS}
		`);
		return rows[0] ? mapRow(rows[0]) : undefined;
	}

	async listPendingUsageMetering(): Promise<ExportJob[]> {
		const rows = await this.client.unsafe<ExportJobRow>(`
			SELECT ${EXPORT_JOB_COLUMNS} FROM export_jobs
			WHERE status = 'done' AND (params->>'usageMeteringPending')::boolean IS TRUE
			ORDER BY created_at ASC, id ASC
		`);
		return rows.map(mapRow);
	}
}

/**
 * Choose the export job store. Export jobs are server-side queue state that must
 * survive a restart for clients to poll a queued/completed job, so — unlike the
 * asset registry, which deliberately defaults to file mode even with a database —
 * any DATABASE_URL deployment persists jobs to Postgres. The in-memory store
 * backs only the genuine no-database prototype (and tests). An explicit
 * EXPORT_JOB_STORE=memory|postgres override wins for ops/testing.
 */
function createExportJobStore(): ExportJobStore {
	const override = process.env.EXPORT_JOB_STORE?.trim().toLowerCase();
	if (override === "memory") return new MemoryExportJobStore();
	if (override === "postgres" && process.env.DATABASE_URL?.trim()) {
		return new PostgresExportJobStore();
	}
	if (process.env.DATABASE_URL?.trim()) {
		return new PostgresExportJobStore();
	}
	return new MemoryExportJobStore();
}

export let exportJobStore: ExportJobStore = createExportJobStore();

/** Test seam: swap the active store (mirrors setAssetStoreForTests). */
export function setExportJobStoreForTests(store: ExportJobStore): () => void {
	const previous = exportJobStore;
	exportJobStore = store;
	return () => {
		exportJobStore = previous;
	};
}

// ── Signed URLs ─────────────────────────────────────────────────────────────

// Default 15 min: long enough for a download to start, short enough that a
// leaked URL is useless quickly. Capped so an override can't mint a long-lived URL.
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;
const MAX_SIGNED_URL_TTL_SECONDS = 60 * 60;

export function resolveSignedUrlTtlSeconds(override?: number): number {
	const fromEnv = Number.parseInt(process.env.EXPORT_SIGNED_URL_TTL_SECONDS ?? "", 10);
	const base = Number.isFinite(override) && (override ?? 0) > 0
		? Math.trunc(override as number)
		: Number.isFinite(fromEnv) && fromEnv > 0
			? fromEnv
			: DEFAULT_SIGNED_URL_TTL_SECONDS;
	return Math.max(1, Math.min(MAX_SIGNED_URL_TTL_SECONDS, base));
}

/**
 * Mint a short-TTL signed download URL for a completed export object. Returns
 * undefined when the storage driver cannot presign (local disk), signalling the
 * caller to fall back to a through-backend download route. Never throws on a
 * presign failure (the underlying storage already swallows + logs it).
 */
export function signExportUrl(
	projectId: string,
	exportId: string,
	options: { ttlSeconds?: number; storage?: ObjectStorage } = {},
): string | undefined {
	const storage = options.storage ?? objectStorage;
	return storage.presignProjectObject({
		projectId,
		objectId: exportId,
		kind: "export",
		expiresInSeconds: resolveSignedUrlTtlSeconds(options.ttlSeconds),
		method: "GET",
	});
}

// ── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueOptions {
	store?: ExportJobStore;
	now?: () => Date;
}

export async function enqueueExportJob(input: EnqueueExportJobInput, options: EnqueueOptions = {}): Promise<ExportJob> {
	if (!isExportPreset(input.preset)) {
		throw new Error(`Unknown export preset: ${String(input.preset)}`);
	}
	const imageIds = (input.imageIds ?? []).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
	if (imageIds.length === 0) {
		throw new Error("enqueueExportJob requires at least one source imageId");
	}
	// Guard: an EXPLICIT non-default language track must have a per-page output for
	// every requested page. Otherwise the render plan would silently fall back to
	// the source/legacy page and export the WRONG language while the job reports
	// the requested one. The omitted/default case is never flagged here.
	const requestedTrack = input.requestedTargetLang ?? input.targetLang;
	const missingLanguagePages = findMissingLanguageOutputImageIds(input.state, imageIds, requestedTrack);
	if (missingLanguagePages.length > 0) {
		throw new MissingLanguageOutputError(requestedTrack!.trim(), missingLanguagePages);
	}
	const store = options.store ?? exportJobStore;
	const now = (options.now ?? (() => new Date()))();
	const config = getExportPresetConfig(input.preset);
	const job: ExportJob = {
		id: randomUUID(),
		workspaceId: input.workspaceId,
		projectId: input.projectId,
		chapterId: input.chapterId,
		requestedBy: input.requestedBy,
		targetLang: input.targetLang,
		preset: input.preset,
		status: "queued",
		// Persist the resolved render plan + the (immutable) source image ids so the
		// processor is self-contained and a job is auditable after the fact.
		params: {
			...config,
			...input.params,
			imageIds,
			targetLang: input.targetLang,
			renderPlans: buildLanguageRenderPlans(input.state, imageIds, input.targetLang),
		},
		createdAt: now.toISOString(),
	};
	return store.create(job);
}

// ── Image transform ───────────────────────────────────────────────────────

export interface ExportOutput {
	/** Storage key suffix (objectId) under the project's exports/ namespace. */
	objectId: string;
	buffer: Buffer;
	contentType: string;
	width: number;
	height: number;
	sizeBytes: number;
	/** Source image id this output derives from (never mutated). */
	sourceImageId: string;
	/** Slice index for webtoon_split outputs. */
	sliceIndex?: number;
}

interface ExportRenderPlan {
	sourceImageId: string;
	renderImageId: string;
	textLayers?: TextLayerData[];
	/**
	 * Visible placed image layers (reference images, AI-result images, pasted/placed
	 * layers) to composite over the background in z-order, matching the client export
	 * (frontend/src/lib/project/page-export.ts). Resolved + z-ordered at enqueue time
	 * so the processor is self-contained. Absent/empty => no image layers (text-only
	 * page, byte-identical to the pre-parity behavior).
	 */
	imageLayers?: ExportImageLayerPlan[];
	/**
	 * Phase A non-destructive edit layers (bubble-clean fill-masks) to composite over
	 * the background BEFORE image/text layers, matching the client export + live
	 * editor. Resolved + ordered at enqueue time so the processor is self-contained.
	 * Absent/empty => no edit layers (byte-identical to the pre-Phase-A behavior).
	 */
	editLayers?: ExportEditLayerPlan[];
}

export interface ExportManifestEntry {
	objectId: string;
	sourceImageId: string;
	sliceIndex?: number;
	width: number;
	height: number;
	sizeBytes: number;
	contentType: string;
}

function contentTypeFor(format: ExportFormat, fallback: string): string {
	switch (format) {
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "avif": return "image/avif";
		case "original": return fallback;
	}
}

function extensionFor(format: ExportFormat): string {
	switch (format) {
		case "jpeg": return "jpg";
		case "webp": return "webp";
		case "avif": return "avif";
		case "original": return "bin";
	}
}

/**
 * Map a Sharp metadata `format` (the DECODED image type of the bytes we are about
 * to write) to a sensible file extension. Used by the master/original preset so a
 * raw copy keeps the TRUE source extension (png/jpg/webp/…) and a composited
 * (text/layer) master is named `.png` (its actual encoded type), rather than the
 * old always-`.bin`. Falls back to `.bin` only when the format is unknown.
 */
function extensionForSharpFormat(format: string | undefined): string {
	switch (format) {
		case "jpeg": return "jpg";
		case "jpg": return "jpg";
		case "png": return "png";
		case "webp": return "webp";
		case "avif": return "avif";
		case "gif": return "gif";
		case "tiff": return "tiff";
		case "heif": return "heif";
		case undefined:
		case "":
			return "bin";
		default:
			// A recognized-but-unmapped sharp format string is still a better extension
			// than ".bin"; only the truly-unknown case falls back.
			return /^[a-z0-9]{1,8}$/i.test(format) ? format.toLowerCase() : "bin";
	}
}

function encodeWith(pipeline: sharp.Sharp, config: ExportPresetConfig): sharp.Sharp {
	const quality = config.quality ?? 82;
	switch (config.format) {
		case "jpeg": return pipeline.jpeg({ quality, mozjpeg: true });
		case "webp": return pipeline.webp({ quality });
		case "avif": return pipeline.avif({ quality });
		case "original": return pipeline;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readTextLayers(value: unknown): TextLayerData[] | undefined {
	return Array.isArray(value) ? value.filter((layer): layer is TextLayerData => isRecord(layer)) : undefined;
}

function languageOutputForPage(page: PageState, targetLang: string | undefined): Record<string, unknown> | undefined {
	if (!targetLang) return undefined;
	const outputs = (page as unknown as { languageOutputs?: unknown }).languageOutputs;
	if (!isRecord(outputs)) return undefined;
	const output = outputs[targetLang];
	return isRecord(output) ? output : undefined;
}

/** Whether a single page carries a `languageOutputs[targetLang]` record. */
export function languageOutputPresentForPage(page: PageState, targetLang: string | undefined): boolean {
	return Boolean(languageOutputForPage(page, targetLang));
}

/**
 * Whether `requested` names an EXPLICIT, non-default language track. The common
 * single-language / default case (omitted, or equal to the project default) is
 * NOT explicit, so it keeps the legacy source path byte-identical. A request is
 * explicit only when the caller passed a non-empty track that DIFFERS from the
 * project default — i.e. a genuine "export the other language" ask.
 */
export function isExplicitLanguageTrack(state: ProjectState | undefined, requested: string | undefined): boolean {
	const track = requested?.trim();
	if (!track) return false;
	const projectDefault = typeof state?.targetLang === "string" ? state.targetLang.trim() : "";
	return track !== projectDefault;
}

/**
 * For an EXPLICIT non-default language track, find the requested source image ids
 * whose page carries no `languageOutputs[track]`. Silently rendering those from
 * the source/legacy page would export the WRONG language while the API reports
 * the requested one, so callers must turn this into a hard error (enqueue) or a
 * readiness blocker. Returns [] for the omitted/default case (never blocks it).
 */
export function findMissingLanguageOutputImageIds(
	state: ProjectState | undefined,
	imageIds: string[],
	requested: string | undefined,
): string[] {
	const track = requested?.trim();
	if (!track || !state || !isExplicitLanguageTrack(state, requested)) return [];
	const byImageId = new Map<string, PageState>();
	for (const page of Array.isArray(state.pages) ? state.pages : []) {
		if (typeof page.imageId === "string" && page.imageId.length > 0) {
			byImageId.set(page.imageId, page);
		}
	}
	const missing: string[] = [];
	for (const imageId of imageIds) {
		const page = byImageId.get(imageId);
		// A page we can't resolve, or one with no output for this track, would fall
		// back to source — flag it as missing for this language.
		if (!page || !languageOutputForPage(page, track)) {
			missing.push(imageId);
		}
	}
	return missing;
}

/** Raised by enqueueExportJob when an explicit, non-default language track is missing on some requested pages. */
export class MissingLanguageOutputError extends Error {
	constructor(readonly targetLang: string, readonly imageIds: string[]) {
		super(
			`No "${targetLang}" language output for ${imageIds.length} requested page${imageIds.length === 1 ? "" : "s"}: ${imageIds.join(", ")}`,
		);
		this.name = "MissingLanguageOutputError";
	}
}

function readImageLayers(value: unknown): ImageLayerData[] | undefined {
	return Array.isArray(value) ? value.filter((layer): layer is ImageLayerData => isRecord(layer)) : undefined;
}

function readSourceCrop(value: unknown): ExportImageLayerPlan["sourceCrop"] | undefined {
	if (!isRecord(value)) return undefined;
	const { x, y, w, h } = value as Record<string, unknown>;
	if ([x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
		return { x: x as number, y: y as number, w: w as number, h: h as number };
	}
	return undefined;
}

const IMAGE_LAYER_BLEND_MODES: readonly ExportImageLayerPlan["blendMode"][] = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"soft-light",
];

function readBlendMode(value: unknown): ExportImageLayerPlan["blendMode"] {
	return typeof value === "string" && (IMAGE_LAYER_BLEND_MODES as readonly string[]).includes(value)
		? (value as ExportImageLayerPlan["blendMode"])
		: "normal";
}

/**
 * Resolve a page's VISIBLE image layers for a target language, z-ordered, into the
 * minimal export-plan shape. Mirrors the client `buildPageExportLayerStack` image
 * rules exactly: the per-language `languageOutputs[track].imageLayers` overrides the
 * flat `page.imageLayers` when present (same override pattern the readiness gate
 * uses via `pageForTargetLang`); only `visible !== false` layers are kept; each
 * layer's z-order key is `layer.zIndex ?? arrayIndex` (image-before-text is handled
 * by compositing image layers below the text pass). Returns [] when the page has no
 * visible image layers (text-only page).
 */
export function resolveExportImageLayers(
	page: PageState,
	targetLang: string | undefined,
): ExportImageLayerPlan[] {
	const langOutput = languageOutputForPage(page, targetLang);
	const langLayers = langOutput ? readImageLayers((langOutput as Record<string, unknown>).imageLayers) : undefined;
	const layers = langLayers ?? (Array.isArray(page.imageLayers) ? page.imageLayers : []);
	return layers
		.map((layer, index) => ({ layer, zIndex: typeof layer.zIndex === "number" && Number.isFinite(layer.zIndex) ? layer.zIndex : index }))
		.filter(({ layer }) => layer.visible !== false && typeof layer.imageId === "string" && layer.imageId.trim().length > 0)
		.sort((a, b) => a.zIndex - b.zIndex)
		.map(({ layer, zIndex }): ExportImageLayerPlan => ({
			id: layer.id,
			imageId: layer.imageId,
			x: layer.x,
			y: layer.y,
			w: layer.w,
			h: layer.h,
			rotation: layer.rotation,
			opacity: layer.opacity,
			flipX: layer.flipX,
			flipY: layer.flipY,
			blendMode: readBlendMode(layer.blendMode),
			// `sourceCrop` is set on AI-result layers but is not (yet) declared on the
			// backend `ImageLayerData` type; read it defensively off the raw record so a
			// cropped AI result paints back only over its region, like the client.
			sourceCrop: readSourceCrop((layer as unknown as Record<string, unknown>).sourceCrop),
			zIndex,
		}));
}

function readEditFill(value: unknown): ExportEditLayerPlan["fill"] | undefined {
	if (!isRecord(value)) return undefined;
	const { r, g, b, a } = value as Record<string, unknown>;
	if ([r, g, b].every((n) => typeof n === "number" && Number.isFinite(n))) {
		return {
			r: r as number,
			g: g as number,
			b: b as number,
			a: typeof a === "number" && Number.isFinite(a) ? (a as number) : 255,
		};
	}
	return undefined;
}

function readEditBbox(value: unknown): ExportEditLayerPlan["bbox"] | undefined {
	if (!isRecord(value)) return undefined;
	const { x, y, w, h } = value as Record<string, unknown>;
	if ([x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
		return { x: x as number, y: y as number, w: w as number, h: h as number };
	}
	return undefined;
}

/**
 * Resolve a page's VISIBLE non-destructive `fill-mask` edit layers (bubble-clean),
 * in index order, into the minimal export-plan shape. SHARED at the page level in
 * Phase A (cleaning is not per-language), so this reads the flat
 * `page.imageEditLayers`. Only `visible !== false` fill-mask layers with a real mask
 * asset + a usable bbox are kept. Returns [] when the page has no edit layers.
 */
export function resolveExportEditLayers(page: PageState): ExportEditLayerPlan[] {
	const raw = (page as unknown as { imageEditLayers?: unknown }).imageEditLayers;
	if (!Array.isArray(raw)) return [];
	const out: ExportEditLayerPlan[] = [];
	raw.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		if (entry.visible === false) return;
		const payload = entry.payload;
		if (!isRecord(payload)) return;
		const bbox = readEditBbox(entry.bbox);
		if (!bbox || bbox.w <= 0 || bbox.h <= 0) return;
		const opacity = typeof entry.opacity === "number" && Number.isFinite(entry.opacity) ? entry.opacity : 1;
		const idx = typeof entry.index === "number" && Number.isFinite(entry.index) ? entry.index : index;
		if (payload.type === "fill-mask") {
			const maskAssetId = readString(payload.maskAssetId);
			const fill = readEditFill(payload.fill);
			if (!maskAssetId || !fill) return;
			out.push({ id: readString(entry.id), kind: "fill-mask", maskAssetId, fill, bbox, opacity, index: idx });
		} else if (payload.type === "patch" || payload.type === "healing" || payload.type === "clone") {
			// Phase B — composite the REALIZED RGBA ROI asset verbatim. `patch` carries
			// `patchAssetId`; `healing`/`clone` carry `realizedPatchAssetId`. The `fill` is
			// unused (kept as a 0-alpha placeholder so the plan shape stays uniform).
			const realizedAssetId =
				payload.type === "patch" ? readString(payload.patchAssetId) : readString(payload.realizedPatchAssetId);
			if (!realizedAssetId) return;
			out.push({
				id: readString(entry.id),
				kind: payload.type,
				maskAssetId: realizedAssetId,
				fill: { r: 0, g: 0, b: 0, a: 0 },
				bbox,
				opacity,
				index: idx,
			});
		}
	});
	return out.sort((a, b) => a.index - b.index);
}

/**
 * The pre-filter length of the image-layer source array the client uses as the
 * text z-index FALLBACK base. The client (page-export.ts) bases a no-zIndex text
 * layer's z on `page.imageLayers.length` taken BEFORE the visible/validity filter,
 * and resolves image layers through the same per-language override as
 * {@link resolveExportImageLayers}. We must use the SAME pre-filter count (not the
 * post-filter `ExportImageLayerPlan[].length`), or a hidden/invalid image layer
 * would shrink the base and let fallback text sort BELOW a visible image whose own
 * fallback index (assigned pre-filter) exceeds the shrunken base.
 */
function exportImageLayerSourceCount(page: PageState, targetLang: string | undefined): number {
	const langOutput = languageOutputForPage(page, targetLang);
	const langLayers = langOutput ? readImageLayers((langOutput as Record<string, unknown>).imageLayers) : undefined;
	const layers = langLayers ?? (Array.isArray(page.imageLayers) ? page.imageLayers : []);
	return layers.length;
}

/**
 * Export-specific, defense-in-depth readiness assert for ONE composited layer
 * asset, mirroring `assertAssetReadyForAiAuthoritative` (assets.ts). A REGISTERED
 * asset must be storage-`released` AND moderation-`passed`, else this throws so the
 * export job FAILS — we never silently composite unmoderated/blocked content, and
 * never silently drop a layer the user placed. A legacy/unregistered asset (no
 * durable record) is allowed through for prototype compatibility (same as the AI
 * guard with `requireRegistry:false`). This holds even if PR #320's route-level
 * readiness gate is bypassed on a direct/reprocess enqueue.
 */
async function assertExportLayerAssetReadyDefault(projectId: string, imageId: string): Promise<void> {
	// HARD DENY any internal pre-moderation object (`aijob_provider_*` /
	// NEVER_GRANDFATHER_*) BEFORE any storage read, regardless of registration. The
	// raw provider checkpoint is written before moderation runs, so it has no asset
	// record and would otherwise slip through the unregistered "prototype
	// compatibility" branch below — the exact CSAM export bypass (a member points a
	// per-language `typesetImageId`/edited bg at `aijob_provider_<jobId>.png`). This
	// applies to BOTH the render background and any placed layer.
	if (isNeverGrandfatherImageId(imageId)) {
		throw new Error(`Export asset ${imageId} is an internal pre-moderation object and is not exportable`);
	}
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) return; // legacy/unregistered: prototype compatibility
	if (asset.storageStatus !== "released") {
		throw new Error(`Export layer asset ${imageId} is not released (storageStatus=${asset.storageStatus})`);
	}
	if (asset.moderation.status !== "passed") {
		throw new Error(`Export layer asset ${imageId} moderation status is ${asset.moderation.status}`);
	}
}

let exportLayerReadinessAssert: (projectId: string, imageId: string) => Promise<void> = assertExportLayerAssetReadyDefault;

/** Test seam: swap the per-layer export-readiness assert (e.g. to simulate a blocked asset). */
export function setExportLayerReadinessAssertForTests(
	assert: (projectId: string, imageId: string) => Promise<void>,
): () => void {
	const previous = exportLayerReadinessAssert;
	exportLayerReadinessAssert = assert;
	return () => {
		exportLayerReadinessAssert = previous;
	};
}

function languageRenderImageId(output: Record<string, unknown> | undefined): string | undefined {
	if (!output) return undefined;
	const direct = readString(output.typesetImageId)
		?? readString(output.exportImageId)
		?? readString(output.renderedImageId)
		?? readString(output.imageId);
	if (direct) return direct;
	const edits = output.edits;
	return isRecord(edits) ? readString(edits.imageId) : undefined;
}

/**
 * Resolve the BACKGROUND image id to render+moderate for a page in a given track,
 * mirroring the client export background (`page-export.ts:308`,
 * `page.edits?.imageId || page.imageId`) AND the readiness chain:
 *   1. the per-language output's typeset/export/edit image id (when a bucket exists);
 *   2. the page's flat EDITED/cleaned background `page.edits?.imageId`;
 *   3. the canonical source `page.imageId`.
 * Step 2 is the load-bearing fix: a default/legacy page with a registered (possibly
 * BLOCKED) `page.edits.imageId` must render+assert THAT edited background, not the
 * original source — so the processor's `exportLayerReadinessAssert(plan.renderImageId)`
 * fails the job closed instead of silently exporting the un-edited/unmoderated source.
 *
 * P1-d (docs/specs/non-destructive-edit-layers.md) — MIXED legacy `edits.imageId` +
 * `imageEditLayers` is INTENTIONAL and DATA-SAFE: base = baked `edits.imageId` when
 * present (a LEGACY page whose pixels were already destructively baked — those pixels
 * are unrecoverable, so we can't render "original + stack" for it), else `page.imageId`
 * (a NEW non-destructive page). The `imageEditLayers[]` stack then composites ON TOP of
 * whichever base, identically in the live editor (`project.svelte.ts` setImageEditLayers
 * over the page background) + the client export (`page-export.ts`) + this pipeline. Do
 * NOT drop the baked pixels for legacy pages.
 */
function pageRenderImageId(page: PageState, output: Record<string, unknown> | undefined): string {
	return languageRenderImageId(output)
		?? readString(page.edits?.imageId)
		?? page.imageId;
}

/**
 * Resolve the text layers to EXPORT for a page in a given track, mirroring the
 * client `resolveExportTextLayers` / `trackTextLayers` + `pageOutput`
 * (page-export.ts) EXACTLY:
 *   - omitted/default-legacy track (no `languageOutputs[track]` bucket) => flat
 *     `page.textLayers` (the client's `lang === undefined` / `legacyTrackView`
 *     backfill — a legacy page whose only text IS the flat field still exports it);
 *   - an EXPLICIT bucket `languageOutputs[track]` => that bucket's own
 *     `textLayers ?? []` with NO flat fallback. The client `pageOutput` returns the
 *     explicit bucket as-is, so `trackTextLayers` is `bucket.textLayers ?? []`. A
 *     MATERIALIZED track with `textLayers: []` (or missing) therefore renders NO
 *     text — never leaking the flat/default/source text into a per-language output.
 */
function resolveRenderTextLayers(page: PageState, targetLang: string | undefined): TextLayerData[] | undefined {
	const output = languageOutputForPage(page, targetLang);
	if (output) {
		// Explicit per-language bucket: use ITS text only (empty/missing => no text).
		// Mirrors client `trackTextLayers` (`bucket.textLayers ?? []`, no flat fallback).
		return readTextLayers(output.textLayers) ?? [];
	}
	// No per-language bucket (omitted/default-legacy track): fall back to the flat
	// page text (matches the client's `lang === undefined` / `legacyTrackView` path).
	return readTextLayers(page.textLayers);
}

export function buildLanguageRenderPlans(
	state: ProjectState | undefined,
	imageIds: string[],
	targetLang: string | undefined,
): ExportRenderPlan[] | undefined {
	// NOTE: unlike the old guard (which returned undefined whenever targetLang was
	// omitted), we build plans even for the default/legacy/single-language case so
	// the flat `page.textLayers` are rendered server-side too (parity with the
	// client ZIP). The `plans.some(...)` check at the end still collapses a truly
	// text-and-layer-free export back to undefined (byte-identical legacy path).
	if (!state) return undefined;
	const byImageId = new Map<string, PageState>();
	for (const page of Array.isArray(state.pages) ? state.pages : []) {
		if (typeof page.imageId === "string" && page.imageId.length > 0) {
			byImageId.set(page.imageId, page);
		}
	}
	const plans = imageIds.map((sourceImageId): ExportRenderPlan => {
		const page = byImageId.get(sourceImageId);
		const output = page ? languageOutputForPage(page, targetLang) : undefined;
		// Flat-text fallback: a default/legacy/single-language page (no
		// languageOutputs[track].textLayers) renders its flat `page.textLayers`.
		const rawTextLayers = page ? resolveRenderTextLayers(page, targetLang) : undefined;
		// Visible placed image layers (parity with the client export). Resolved through
		// the SAME per-language override pattern as text/typeset so a materialized track
		// exports its own layers; a flat/legacy page exports page.imageLayers.
		const imageLayers = page ? resolveExportImageLayers(page, targetLang) : [];
		// Phase A non-destructive edit layers (bubble-clean) — SHARED at page level.
		const editLayers = page ? resolveExportEditLayers(page) : [];
		// Resolve each text layer's export z-index HERE (at plan build), baking the
		// client's exact fallback into the persisted plan: a text layer without an
		// explicit finite zIndex falls back to `imageLayerSourceCount + <its index in
		// the full text array>` (NOT layer.index, and NOT a post-filter image count).
		// This keeps interleave order correct + identical across the initial render and
		// any reprocess, and removes any compose-time dependence on a filtered count.
		const baseCount = page ? exportImageLayerSourceCount(page, targetLang) : 0;
		const textLayers = (rawTextLayers ?? []).map((layer, index) => (
			typeof layer.zIndex === "number" && Number.isFinite(layer.zIndex)
				? layer
				: { ...layer, zIndex: baseCount + index }
		));
		return {
			sourceImageId,
			// Background = per-language output id -> flat page.edits.imageId -> page.imageId
			// (parity with the client + readiness). A page is found by its canonical
			// `imageId` (sourceImageId), so when no page matches we fall back to the
			// requested id itself.
			renderImageId: page ? pageRenderImageId(page, output) : sourceImageId,
			textLayers: textLayers.length > 0 ? textLayers : undefined,
			imageLayers: imageLayers.length > 0 ? imageLayers : undefined,
			editLayers: editLayers.length > 0 ? editLayers : undefined,
		};
	});
	return plans.some((plan) => (
		plan.renderImageId !== plan.sourceImageId
		|| (plan.textLayers?.length ?? 0) > 0
		|| (plan.imageLayers?.length ?? 0) > 0
		|| (plan.editLayers?.length ?? 0) > 0
	))
		? plans
		: undefined;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function svgTextAnchor(alignment: TextLayerData["alignment"] | undefined): "start" | "middle" | "end" {
	if (alignment === "center") return "middle";
	if (alignment === "right") return "end";
	return "start";
}

function textLayerX(layer: TextLayerData): number {
	if (layer.alignment === "center") return layer.x + layer.w / 2;
	if (layer.alignment === "right") return layer.x + layer.w;
	return layer.x;
}

function visibleTextLayers(textLayers: TextLayerData[] | undefined): TextLayerData[] {
	return (textLayers ?? [])
		.filter((layer) => layer.visible !== false && typeof layer.text === "string" && layer.text.trim().length > 0);
}

/**
 * Composite a page's image + text layers in ONE interleaved z-order matching the
 * client export EXACTLY. The client builds a single combined stack of image+text
 * entries and sorts by `zIndex - zIndex || (image ? -1 : 1)` (equal z => image
 * paints first, i.e. UNDER text), then renders in that order. The server
 * historically did two fixed passes (ALL images, then ALL text), which diverged
 * whenever a text layer's z sat BELOW an image layer's z.
 *
 * To preserve the existing byte-for-byte guarantees we group the interleaved stack
 * into CONTIGUOUS runs of the same kind and reuse the existing batched compositors:
 * a single image run => one `compositeImageLayers` (identical to before), a single
 * text run => one `composeTextLayers` SVG pass (identical to before). The common
 * cases — text-only, layer-only, and "all text above all images" — collapse to the
 * exact same one/two passes as the pre-interleave pipeline, so their output is
 * unchanged. Only genuinely interleaved pages split into more runs.
 */
async function composeLayeredPage(
	sourceBuffer: Buffer,
	imageLayers: ExportImageLayerPlan[] | undefined,
	textLayers: TextLayerData[] | undefined,
	resolveLayerAsset: (imageId: string) => Promise<Buffer | undefined>,
	assertLayerReady: ImageLayerReadinessAssert | undefined,
	editLayers?: ExportEditLayerPlan[] | undefined,
	/**
	 * P1 (codex audit) — fail-closed posture for missing/unreadable layer assets.
	 * `true` (publish/durable, the DEFAULT): a visible image OR edit layer whose
	 * asset can't be composited FAILS the job (never silently dropped). `false`
	 * (draft/internal preview): record + flag the skip instead. Either way, a
	 * blocked/pending/unreleased asset still fails via the readiness assert.
	 */
	failOnSkipped: boolean = true,
): Promise<{ buffer: Buffer; skipped: { id?: string; imageId: string; reason: string }[] }> {
	const skippedAll: { id?: string; imageId: string; reason: string }[] = [];

	// Phase A — composite NON-DESTRUCTIVE edit layers (bubble-clean fill-masks) FIRST,
	// directly over the background, BEFORE any image/text layers (parity with the
	// client export + live editor). A blocked/pending mask asset throws and fails the
	// job; for publish, a missing/unreadable one ALSO fails (failOnSkipped); a draft
	// preview records + flags the skip. Mask bytes are read via the SAME authoritative
	// storage path as the background.
	let baseBuffer = sourceBuffer;
	if ((editLayers ?? []).length > 0) {
		const edited = await compositeEditLayers(baseBuffer, editLayers, resolveLayerAsset, {
			assertReady: assertLayerReady ? (id) => assertLayerReady(id) : undefined,
			failOnSkipped,
		});
		baseBuffer = edited.buffer;
		for (const s of edited.skipped) {
			skippedAll.push({ id: s.id, imageId: s.maskAssetId, reason: `edit-layer: ${s.reason}` });
		}
	}

	const visibleImages = (imageLayers ?? []).filter((layer) => layer && layer.imageId);

	// Common path: no image layers => the existing single text pass (byte-identical
	// for text-only pages and the legacy master copy when there is no text either).
	if (visibleImages.length === 0) {
		const buffer = await composeTextLayers(baseBuffer, textLayers);
		return { buffer, skipped: skippedAll };
	}

	// Build the SAME interleaved stack the client sorts: image-before-text on a z tie.
	type Entry =
		| { kind: "image"; z: number; layer: ExportImageLayerPlan }
		| { kind: "text"; z: number; layer: TextLayerData };
	// Text z-order matches the client EXACTLY: buildLanguageRenderPlans already
	// RESOLVED each text layer's zIndex (a no-zIndex layer was baked to
	// `imageLayerSourceCount + <full-array index>`, the client's fallback), so we read
	// `layer.zIndex` directly here — no compose-time fallback that could depend on the
	// post-filter image count. Image layers likewise carry a resolved zIndex from
	// resolveExportImageLayers. The defensive `?? 0` only covers a layer that somehow
	// reached compositing without a resolved z.
	const textEntries: Entry[] = (textLayers ?? [])
		.filter((layer) => layer.visible !== false && typeof layer.text === "string" && layer.text.trim().length > 0)
		.map((layer): Entry => ({
			kind: "text",
			z: typeof layer.zIndex === "number" && Number.isFinite(layer.zIndex) ? layer.zIndex : 0,
			layer,
		}));
	const entries: Entry[] = [
		...visibleImages.map((layer): Entry => ({ kind: "image", z: layer.zIndex ?? 0, layer })),
		...textEntries,
	];
	// Stable, client-matching comparator: ascending z, image wins an equal-z tie.
	entries.sort((a, b) => (a.z - b.z) || (a.kind === "image" ? -1 : 1));

	// Group contiguous same-kind entries into runs so each run is composited by the
	// existing batched compositor (preserving the single-pass byte output for the
	// "all images then all text" and "text-only" cases).
	const skipped: { id?: string; imageId: string; reason: string }[] = [...skippedAll];
	let buffer = baseBuffer;
	let i = 0;
	while (i < entries.length) {
		const kind = entries[i]!.kind;
		let j = i;
		while (j < entries.length && entries[j]!.kind === kind) j += 1;
		const run = entries.slice(i, j);
		if (kind === "image") {
			const layers = run.map((e) => (e as Extract<Entry, { kind: "image" }>).layer);
			const result = await compositeImageLayers(buffer, layers, resolveLayerAsset, { assertReady: assertLayerReady, failOnSkipped });
			buffer = result.buffer;
			skipped.push(...result.skipped);
		} else {
			const layers = run.map((e) => (e as Extract<Entry, { kind: "text" }>).layer);
			buffer = await composeTextLayers(buffer, layers);
		}
		i = j;
	}
	return { buffer, skipped };
}

async function composeTextLayers(sourceBuffer: Buffer, textLayers: TextLayerData[] | undefined): Promise<Buffer> {
	const visibleLayers = visibleTextLayers(textLayers);
	if (visibleLayers.length === 0) return sourceBuffer;
	const meta = await sharp(sourceBuffer).metadata();
	const width = meta.width ?? 0;
	const height = meta.height ?? 0;
	if (width <= 0 || height <= 0) return sourceBuffer;

	const ordered = [...visibleLayers].sort((a, b) => (a.zIndex ?? a.index ?? 0) - (b.zIndex ?? b.index ?? 0));
	const nodes = ordered.map((layer) => {
		const x = textLayerX(layer);
		const y = layer.y + layer.fontSize;
		const fontSize = Math.max(1, Number.isFinite(layer.fontSize) ? layer.fontSize : 16);
		const fill = escapeXml(layer.fill ?? "#111111");
		const stroke = layer.stroke ? ` stroke="${escapeXml(layer.stroke)}" stroke-width="${Math.max(0, layer.strokeWidth ?? 0)}"` : "";
		const anchor = svgTextAnchor(layer.alignment);
		const fontFamily = escapeXml(layer.fontFamily ?? "Arial, sans-serif");
		const transform = layer.rotation
			? ` transform="rotate(${layer.rotation} ${x} ${y})"`
			: "";
		return `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${fontSize}" fill="${fill}" text-anchor="${anchor}"${stroke}${transform}>${escapeXml(layer.text)}</text>`;
	}).join("");
	const svg = Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${nodes}</svg>`);
	return sharp(sourceBuffer).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
}

/**
 * Render the configured outputs for a single source image WITHOUT touching the
 * source. `sourceBuffer` is the immutable original; all sharp pipelines start a
 * fresh instance from it and never write back to the source key.
 */
export async function renderExportForImage(
	sourceImageId: string,
	sourceBuffer: Buffer,
	config: ExportPresetConfig,
	exportId: string,
): Promise<ExportOutput[]> {
	const outputs: ExportOutput[] = [];
	for await (const output of renderExportOutputsForImage(sourceImageId, sourceBuffer, config, exportId)) {
		outputs.push(output);
	}
	return outputs;
}

async function* renderExportOutputsForImage(
	sourceImageId: string,
	sourceBuffer: Buffer,
	config: ExportPresetConfig,
	exportId: string,
): AsyncGenerator<ExportOutput> {
	const baseObjectId = `${exportId}/${sanitizeId(sourceImageId)}`;

	// Master = byte-for-byte copy of the original. We deliberately do not decode
	// or re-encode, so a master export is a faithful, lossless artifact.
	if (config.format === "original") {
		const meta = await sharp(sourceBuffer).metadata().catch(() => ({} as sharp.Metadata));
		// Preserve the TRUE source extension for a raw copy (png/jpg/webp/…). A
		// composited master (text/layer pass) arrives here already encoded as PNG, so
		// its metadata format is "png" and it is named ".png" — never the old ".bin".
		yield {
			objectId: `${baseObjectId}.${extensionForSharpFormat(meta.format)}`,
			buffer: sourceBuffer,
			contentType: meta.format ? `image/${meta.format}` : "application/octet-stream",
			width: meta.width ?? 0,
			height: meta.height ?? 0,
			sizeBytes: sourceBuffer.byteLength,
			sourceImageId,
		};
		return;
	}

	// Resize first (cap width, never enlarge), then optionally slice tall webtoon
	// pages, then encode each piece.
	const resizedBuffer = config.maxWidth
		? await sharp(sourceBuffer)
			.resize({ width: config.maxWidth, withoutEnlargement: true })
			.toBuffer()
		: sourceBuffer;

	const ext = extensionFor(config.format);
	const ct = contentTypeFor(config.format, "application/octet-stream");

	if (config.sliceHeights && config.sliceHeights.length > 0) {
		yield* sliceTallOutputs(resizedBuffer, config, sourceImageId, baseObjectId, ext, ct);
		return;
	}

	const encoded = await encodeWith(sharp(resizedBuffer), config).toBuffer();
	const meta = await sharp(encoded).metadata().catch(() => ({} as sharp.Metadata));
	yield {
		objectId: `${baseObjectId}.${ext}`,
		buffer: encoded,
		contentType: ct,
		width: meta.width ?? 0,
		height: meta.height ?? 0,
		sizeBytes: encoded.byteLength,
		sourceImageId,
	};
}

async function* sliceTallOutputs(
	resizedBuffer: Buffer,
	config: ExportPresetConfig,
	sourceImageId: string,
	baseObjectId: string,
	ext: string,
	contentType: string,
): AsyncGenerator<ExportOutput> {
	const meta = await sharp(resizedBuffer).metadata();
	const width = meta.width ?? 0;
	const height = meta.height ?? 0;
	if (width <= 0 || height <= 0) {
		throw new Error(`webtoon_split source ${sourceImageId} has no decodable dimensions`);
	}
	// Pick the largest configured chunk height that does not exceed the page, so a
	// short page produces a single slice instead of many tiny ones.
	const sorted = [...config.sliceHeights!].filter((h) => h > 0).sort((a, b) => a - b);
	const picked = sorted.find((h) => h >= height) ?? sorted[sorted.length - 1] ?? height;
	// Defense-in-depth DoS clamp (resolveEffectiveConfig already floors client slice
	// heights, but sliceTall is exported/independently callable): never slice below
	// the min height, and cap the per-page output count so one page can never explode
	// into an unbounded number of Sharp encodes even if a pathological height slips in.
	const minSlice = minExportSliceHeight();
	const maxOutputs = maxExportOutputsPerPage();
	const sliceHeight = Math.max(minSlice, picked, Math.ceil(height / maxOutputs));

	let sliceIndex = 0;
	for (let top = 0; top < height; top += sliceHeight) {
		const chunkHeight = Math.min(sliceHeight, height - top);
		const buffer = await encodeWith(
			sharp(resizedBuffer).extract({ left: 0, top, width, height: chunkHeight }),
			config,
		).toBuffer();
		yield {
			objectId: `${baseObjectId}.${String(sliceIndex).padStart(4, "0")}.${ext}`,
			buffer,
			contentType,
			width,
			height: chunkHeight,
			sizeBytes: buffer.byteLength,
			sourceImageId,
			sliceIndex,
		};
		sliceIndex += 1;
	}
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-z0-9._-]/gi, "_");
}

// ── Processor ─────────────────────────────────────────────────────────────

export interface ProcessExportJobOptions {
	store?: ExportJobStore;
	storage?: ObjectStorage;
	signedUrlTtlSeconds?: number;
	now?: () => Date;
}

export interface ProcessExportJobResult {
	job: ExportJob;
	outputs: ExportManifestEntry[];
	signedUrl?: string;
}

function manifestEntryFromOutput(output: ExportOutput): ExportManifestEntry {
	return {
		objectId: output.objectId,
		sourceImageId: output.sourceImageId,
		sliceIndex: output.sliceIndex,
		width: output.width,
		height: output.height,
		sizeBytes: output.sizeBytes,
		contentType: output.contentType,
	};
}

async function reserveExportObjectStorageQuota(
	job: ExportJob,
	bytes: number,
	metadata: Record<string, unknown>,
): Promise<StorageQuotaReservation | undefined> {
	if (bytes <= 0) return undefined;
	const result = await reserveProjectStorageQuota({
		projectId: job.projectId,
		bytes,
		reason: "export_pipeline",
		metadata: {
			exportJobId: job.id,
			preset: job.preset,
			targetLang: job.targetLang,
			...metadata,
		},
	});
	return result.reservation;
}

async function releaseExportStorageQuotaReservationsBestEffort(
	job: ExportJob,
	reservations: StorageQuotaReservation[],
	phase: "after_commit" | "rollback",
): Promise<void> {
	for (const reservation of reservations) {
		await releaseProjectStorageQuotaReservationBestEffort(job.projectId, reservation.reservationId, {
			reason: "export_pipeline",
			phase,
			exportJobId: job.id,
		});
	}
}

/**
 * Run a single export job to completion: read each source image (READ-ONLY),
 * render the preset's outputs, persist them under exports/, write a manifest,
 * mint a signed URL, and mark the job done. Any failure transitions the job to
 * `error` with the message (never the raw object/secret) and rethrows for the
 * caller's visibility.
 */
export async function processExportJob(jobId: string, options: ProcessExportJobOptions = {}): Promise<ProcessExportJobResult> {
	const store = options.store ?? exportJobStore;
	const storage = options.storage ?? objectStorage;
	const now = options.now ?? (() => new Date());

	const job = await store.get(jobId);
	if (!job) throw new ExportJobNotFoundError(jobId);

	try {
		if (!isExportPreset(job.preset)) {
			throw new Error(`Unknown export preset: ${String(job.preset)}`);
		}
		// Honor the per-request overrides persisted at enqueue time (maxWidth,
		// quality, format, sliceHeights) layered over the built-in preset, so a job
		// renders with the same settings reported in its params.
		const config = resolveEffectiveConfig(job.preset, job.params);
		const renderPlans = readRenderPlans(job.params);
		if (renderPlans.length === 0) {
			throw new Error("Export job has no source imageIds");
		}

		// P1 (codex audit) — PUBLISH vs DRAFT posture for missing/unreadable layer
		// assets. A PUBLISH/durable export (the default) must FAIL CLOSED on a visible
		// image/edit layer whose asset can't be composited, so it never silently ships
		// an artifact missing a user-placed layer. Only an explicit draft/internal
		// preview (`params.draft === true`) is allowed to skip + FLAG instead. A
		// blocked/pending/unreleased asset still fails via the readiness assert in
		// EITHER profile (unmoderated content never leaks, even on a draft).
		const isDraftProfile = isDraftExportProfile(job.params);
		const failOnMissingLayer = !isDraftProfile;

		// ── PREFLIGHT pixel-budget gate (runs BEFORE the Sharp render/write loop) ──
		// Estimate the total OUTPUT pixels this job would decode/encode by reading each
		// source's HEADER dimensions only (sharp().metadata() — no full decode), applying
		// any width-resize cap, and summing. If the estimate exceeds the per-job ceiling
		// we FAIL the job here, before the sequential output loop allocates its first
		// full-resolution Sharp buffer — so a 500-page × (huge) job is rejected up front
		// instead of OOM-ing the box mid-render (the per-image upload ceiling bounds each
		// source; this is the job-level aggregate guard). A header that can't be read
		// contributes 0 (the loop's real decode will surface a genuine error), so this
		// never falsely rejects.
		const maxJobPixels = maxExportJobTotalPixels();
		let estimatedPixels = 0;
		for (const plan of renderPlans) {
			// SECURITY (deny-before-ANY-read): the render loop below already asserts the
			// background before reading it, but this preflight estimator reads the source
			// HEADER first — so without this gate a laundered pre-moderation object
			// (`aijob_provider_*`) would be fetched into process memory during estimation,
			// before the render-loop deny ever runs. Run the SAME fail-closed assert here so
			// no never-grandfather / blocked / unreleased background reaches storage at all,
			// even on a direct/reprocess enqueue that bypassed the route readiness gate.
			await exportLayerReadinessAssert(job.projectId, plan.renderImageId);
			const sourceBuffer = await storage.getProjectImage({ projectId: job.projectId, imageId: plan.renderImageId });
			if (!sourceBuffer) continue; // real "not found" is surfaced by the render loop below
			const meta = await sharp(sourceBuffer).metadata().catch(() => ({} as sharp.Metadata));
			const srcW = meta.width ?? 0;
			const srcH = meta.height ?? 0;
			if (srcW <= 0 || srcH <= 0) continue;
			// Mirror renderExportForImage's resize: cap width (never enlarge), scale height.
			const outW = config.maxWidth ? Math.min(srcW, config.maxWidth) : srcW;
			const outH = config.maxWidth && srcW > config.maxWidth
				? Math.round(srcH * (config.maxWidth / srcW))
				: srcH;
			estimatedPixels += outW * outH;
			if (estimatedPixels > maxJobPixels) {
				throw new ExportJobTooLargeError(estimatedPixels, maxJobPixels);
			}
		}

		// Honest missing-layer accounting (DRAFT profile only). A PUBLISH export
		// (default) FAILS CLOSED on a missing/unreadable visible layer, so this list is
		// empty for publish. An explicit draft/internal preview (`params.draft`) is the
		// only profile allowed to SKIP a genuinely MISSING/unreadable asset — and even
		// then it is recorded here so the result surfaces a notice instead of silently
		// completing as if nothing was dropped. A BLOCKED/pending asset throws and fails
		// the job upstream (readiness assert) in EITHER profile.
		const skippedLayers: Array<{ sourceImageId: string; id?: string; imageId: string; reason: string }> = [];
		// The number of SOURCE pages rendered (one per plan), recorded separately from the
		// produced-output count so webtoon_split (many slices per page) does not overstate
		// the page count in usage metering.
		const sourcePageCount = renderPlans.length;
		const manifestObjectId = `${job.id}/manifest.json`;
		const manifest: ExportManifestEntry[] = [];
		const reservations: StorageQuotaReservation[] = [];
		// Rolling AGGREGATE output reservation (codex P2): a single reservation
		// always covers every output byte written so far, re-reserved (fresh TTL)
		// on each output. Per-output reservations expired after
		// STORAGE_QUOTA_RESERVATION_TTL_MS, so an export running longer than the
		// TTL stopped counting its earlier outputs and could finish over quota.
		let aggregateOutputReservation: StorageQuotaReservation | undefined;
		let reservedOutputBytes = 0;
		let totalBytes = 0;
		let primaryKey: string | undefined;
		const writtenObjectIds: string[] = [];
		try {
			for (const plan of renderPlans) {
				// FAIL CLOSED on the BACKGROUND (source OR edited/typeset background, whichever
				// the plan resolved as renderImageId): a registered-but-BLOCKED/pending/unreleased
				// background asset must FAIL the export job, never silently composite into the
				// artifact. The default assert ALSO HARD-DENIES any internal pre-moderation id
				// (`aijob_provider_*`) before any read — so laundering a raw provider checkpoint
				// into a per-language `typesetImageId`/edited background FAILS the job rather than
				// compositing unmoderated (potential CSAM) bytes, even if a route-level readiness
				// check is bypassed on a direct/reprocess enqueue. Mirrors the per-layer gate
				// (registered => released + passed; legacy/unregistered => allowed for prototype
				// compatibility) for source/edited/layer assets alike.
				await exportLayerReadinessAssert(job.projectId, plan.renderImageId);
				// READ-ONLY: fetch the immutable original. We never call put*/delete* on
				// the source key.
				const sourceBuffer = await storage.getProjectImage({ projectId: job.projectId, imageId: plan.renderImageId });
				if (!sourceBuffer) {
					throw new Error(`Source image ${plan.renderImageId} not found for project ${job.projectId}`);
				}
				// Export parity: composite visible placed image layers (reference/AI-result/
				// pasted) AND text in ONE interleaved z-order, matching the client export's
				// combined stack (frontend page-export.ts). Layer asset bytes are read via the
				// SAME authoritative storage path as the background (never client-supplied).
				// Defense-in-depth: each visible layer asset is asserted registered + released
				// + moderation-passed BEFORE its bytes are read — a blocked/pending layer FAILS
				// the job (never silently composited, never silently dropped). A merely
				// missing/unreadable (but registry-clean) layer is skipped + logged, matching
				// the client's per-layer honesty. A page with no image layers reduces to the
				// single text pass, so text-only pages stay byte-identical to before.
				const layered = await composeLayeredPage(
					sourceBuffer,
					plan.imageLayers,
					plan.textLayers,
					(layerImageId) => storage.getProjectImage({ projectId: job.projectId, imageId: layerImageId }),
					(layerImageId) => exportLayerReadinessAssert(job.projectId, layerImageId),
					plan.editLayers,
					failOnMissingLayer,
				);
				if (layered.skipped.length > 0) {
					console.warn(`[export-pipeline] Export ${job.id} page ${plan.sourceImageId}: skipped ${layered.skipped.length} unrenderable image layer(s): ${layered.skipped.map((s) => `${s.id ?? s.imageId} (${s.reason})`).join(", ")}`);
					for (const s of layered.skipped) {
						skippedLayers.push({ sourceImageId: plan.sourceImageId, id: s.id, imageId: s.imageId, reason: s.reason });
					}
				}

				// Render and commit one output at a time instead of collecting every page/
				// slice buffer in `rendered[]`. This caps live export artifact memory at the
				// current Sharp output buffer (plus the current page composite) while keeping
				// the public job API and manifest shape unchanged.
				for await (const output of renderExportOutputsForImage(plan.sourceImageId, layered.buffer, config, job.id)) {
					if (output.buffer.byteLength > 0) {
						if (aggregateOutputReservation) {
							// Release the superseded aggregate BEFORE re-reserving the new
							// running total: the reserve-side quota check counts active
							// reservations, so holding both would transiently double-count
							// and spuriously fail a near-limit export.
							const superseded = aggregateOutputReservation;
							aggregateOutputReservation = undefined;
							let release = await releaseProjectStorageQuotaReservationBestEffort(
								job.projectId,
								superseded.reservationId,
								{ reason: "export_pipeline", phase: "rolled_up", exportJobId: job.id },
							);
							if (!release.released) {
								// One immediate retry for a transient hiccup before accepting
								// the conservative path below (codex P2 r2).
								release = await releaseProjectStorageQuotaReservationBestEffort(
									job.projectId,
									superseded.reservationId,
									{ reason: "export_pipeline", phase: "rolled_up_retry", exportJobId: job.id },
								);
							}
							if (release.released) {
								const index = reservations.indexOf(superseded);
								if (index !== -1) reservations.splice(index, 1);
							}
							// On a failed release the reservation STAYS in `reservations`
							// so after_commit/rollback still frees it (or it lapses at
							// TTL). The new aggregate below then over-covers transiently —
							// conservative: may reject a near-limit export, never
							// undercounts written bytes.
						}
						const reservation = await reserveExportObjectStorageQuota(job, reservedOutputBytes + output.buffer.byteLength, {
							objectId: output.objectId,
							sourceImageId: output.sourceImageId,
							sliceIndex: output.sliceIndex,
							aggregate: true,
							coveredOutputCount: writtenObjectIds.length + 1,
						});
						if (reservation) {
							reservations.push(reservation);
							aggregateOutputReservation = reservation;
							reservedOutputBytes += output.buffer.byteLength;
						}
					}
					const stored = await storage.putProjectExport({
						projectId: job.projectId,
						exportId: output.objectId,
						buffer: output.buffer,
					});
					writtenObjectIds.push(output.objectId);
					primaryKey ??= stored.key;
					manifest.push(manifestEntryFromOutput(output));
					totalBytes += output.buffer.byteLength;
				}
			}

			const manifestBuffer = Buffer.from(JSON.stringify({
				exportId: job.id,
				projectId: job.projectId,
				targetLang: job.targetLang,
				preset: job.preset,
				outputs: manifest,
				// Honest partial-export notice: any visible image layer whose asset was
				// missing/unreadable (and therefore dropped from the composite) is listed
				// here so the result is not silently wrong. An empty/absent list means a
				// fully-composited export. (A BLOCKED layer never reaches here — it fails the
				// job upstream via the readiness assert.)
				...(skippedLayers.length > 0 ? { skippedLayers } : {}),
				generatedAt: now().toISOString(),
			}, null, 2), "utf8");

			const manifestReservation = await reserveExportObjectStorageQuota(job, manifestBuffer.byteLength, {
				objectId: manifestObjectId,
				outputCount: manifest.length,
			});
			if (manifestReservation) reservations.push(manifestReservation);
			// Persist a manifest.json describing every produced object so a multi-output
			// (webtoon_split / multi-page) export is downloadable as a set.
			const manifestStored = await storage.putProjectExport({
				projectId: job.projectId,
				exportId: manifestObjectId,
				buffer: manifestBuffer,
			});
			writtenObjectIds.push(manifestObjectId);
			totalBytes += manifestBuffer.byteLength;

			// For a single-output export, sign the output itself; otherwise sign the
			// manifest so the client can discover every object. Returns undefined on a
			// non-presigning (local disk) driver — the client then falls back to the
			// through-backend GET /api/export/:id/objects/* download route.
			const signTargetObjectId = manifest.length === 1 ? manifest[0]!.objectId : manifestObjectId;
			const signedUrl = signExportUrl(job.projectId, signTargetObjectId, {
				ttlSeconds: options.signedUrlTtlSeconds,
				storage,
			});

			const resultKey = manifest.length === 1 ? primaryKey ?? manifestStored.key : manifestStored.key;
			const updated = await store.update(job.id, {
				status: "done",
				resultKey,
				resultSignedUrl: signedUrl,
				completedAt: now().toISOString(),
				params: {
					...job.params,
					manifestObjectId,
					outputCount: manifest.length,
					// SOURCE page count (one per render plan) recorded separately from the
					// produced-output/slice count so webtoon_split doesn't overstate pages.
					sourcePageCount,
					outputs: manifest,
					// Honest missing-layer notice on the job itself (mirrors the manifest +
					// the client ZIP's partial honesty). Absent when nothing was dropped.
					...(skippedLayers.length > 0 ? { skippedLayers } : {}),
				},
			});

			// Best-effort release once the objects are committed: the bytes now count
			// against real usage, so the transient reservation can be freed.
			await releaseExportStorageQuotaReservationsBestEffort(job, reservations, "after_commit");

			// Charge the workspace's export-bytes quota from the SERVER-derived size of
			// the artifacts we actually produced (`totalBytes` = every rendered page/
			// slice + the manifest), NOT a client-supplied number. Without this the
			// server export pipeline wrote outputs but never billed export usage, so
			// pipeline exports were effectively free. Idempotent on the export job id
			// (a reprocess reuses the same key and does not double-charge) and
			// best-effort: an already-committed export must not be failed by a transient
			// usage-ledger hiccup.
			// Export is FREE (product decision 2026-06-13): no billable usage is
			// recorded — exporting never costs credits or counts against a quota.
			// (Storage reservation for the artifact + the freeze gate stay; only the
			// `export_bytes_recorded` meter is dropped.) `totalBytes`/`sourcePageCount`
			// remain computed for logging/manifest, just not metered.
			void totalBytes;

			return { job: updated ?? { ...job, status: "done", resultKey, resultSignedUrl: signedUrl }, outputs: manifest, signedUrl };
		} catch (error) {
			// Compensating cleanup on a render/quota/write failure: best-effort DELETE
			// every object we already wrote so a half-done job leaves no orphan private
			// objects in the exports/ namespace. Runs BEFORE reservation release + rethrow.
			if (writtenObjectIds.length > 0) {
				await deleteWrittenExportObjectsBestEffort(storage, job.projectId, job.id, writtenObjectIds);
			}
			await releaseExportStorageQuotaReservationsBestEffort(job, reservations, "rollback");
			throw error;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failed = await store.update(job.id, {
			status: "error",
			error: message,
			completedAt: now().toISOString(),
		});
		// Re-throw so a standalone processor / caller can observe the failure; the
		// job row already records the error for status reads.
		void failed;
		throw error;
	}
}

/**
 * Best-effort compensating delete of the export objects already written by a job
 * whose write loop then failed mid-way. Each delete is isolated (one failing
 * delete must not abort the rest) and the original error is always rethrown by the
 * caller — this is cleanup only, never a success path. Prevents orphan private
 * objects leaking into the exports/ namespace on a partial-write failure.
 */
async function deleteWrittenExportObjectsBestEffort(
	storage: ObjectStorage,
	projectId: string,
	jobId: string,
	objectIds: string[],
): Promise<void> {
	for (const objectId of objectIds) {
		try {
			await storage.deleteProjectExport({ projectId, exportId: objectId });
		} catch (cleanupError) {
			console.warn(`[export-pipeline] Export ${jobId} cleanup: failed to delete orphan object ${objectId}: ${cleanupError}`);
		}
	}
}

export interface ExportUsageMeterInput {
	projectId: string;
	exportJobId: string;
	bytes: number;
	preset: string;
	targetLang?: string;
	/** Produced object/slice count (used to classify single-page vs batch-zip). */
	outputCount: number;
	/**
	 * SOURCE page count (one per render plan). Billed as `pageCount` so webtoon_split
	 * (many slices per source page) does not overstate the metered page count. Falls
	 * back to `outputCount` when absent (older callers / reconcile of a legacy row).
	 */
	sourcePageCount?: number;
}

/** Max inline attempts to absorb a transient ledger blip before going durable. */
const EXPORT_USAGE_RECORD_ATTEMPTS = 3;

/**
 * Single idempotent ledger write for a completed pipeline export. Keyed on
 * `export-job:${jobId}` so any retry/reconcile dedupes to the original record and
 * NEVER double-charges. `enforce: false` records the bytes even past quota (the
 * artifacts are already committed — enforcement is the pre-commit storage-
 * reservation gate, not this post-commit accounting), so a quota-exceeded result
 * is recorded as an overage rather than dropped. Throws on a genuine ledger
 * failure so the caller can retry / mark the job metering-pending.
 */
async function recordPipelineExportUsageDefault(input: ExportUsageMeterInput): Promise<void> {
	// Omit workspaceId so the ledger resolves the scope exactly like the manual
	// POST /api/usage/:projectId/export route does (projectId in file mode, the
	// real workspace via the projects table in Postgres) — keeping pipeline-billed
	// export bytes visible in the SAME per-project usage summary/read path.
	await recordExportUsage({
		projectId: input.projectId,
		subjectId: `export-job:${input.exportJobId}`,
		bytes: input.bytes,
		idempotencyKey: `export-job:${input.exportJobId}`,
		// Bill SOURCE pages, not produced slices (webtoon_split makes many slices per
		// page). Fall back to the output count only when the source count is absent.
		pageCount: input.sourcePageCount ?? input.outputCount,
		exportKind: input.outputCount > 1 ? "batch-zip" : "single-page",
		// Post-commit accounting must never be discarded over quota: record the
		// overage instead. (The pre-commit reservation gate still enforces.)
		enforce: false,
		metadata: {
			exportJobId: input.exportJobId,
			preset: input.preset,
			targetLang: input.targetLang,
			source: "export_pipeline",
		},
	});
}

// Indirection so the retry/pending/reconcile logic can be exercised against a
// controllable (e.g. transiently-failing) recorder in tests without touching the
// real ledger singleton. Mirrors setExportJobStoreForTests.
let pipelineExportUsageRecorder: (input: ExportUsageMeterInput) => Promise<void> = recordPipelineExportUsageDefault;

async function recordPipelineExportUsageOnce(input: ExportUsageMeterInput): Promise<void> {
	await pipelineExportUsageRecorder(input);
}

/** Test seam: swap the export-usage recorder (e.g. to simulate ledger failures). */
export function setPipelineExportUsageRecorderForTests(
	recorder: (input: ExportUsageMeterInput) => Promise<void>,
): () => void {
	const previous = pipelineExportUsageRecorder;
	pipelineExportUsageRecorder = recorder;
	return () => {
		pipelineExportUsageRecorder = previous;
	};
}

/**
 * Charge export-bytes usage for a completed pipeline export from the
 * SERVER-derived artifact total. The export objects are already committed and the
 * job already marked done, so a transient usage-ledger failure must NOT roll back
 * or fail the export. Instead:
 *   1. retry the (idempotent) record a few times to absorb transient blips;
 *   2. if it still fails, persist a durable `params.usageMeteringPending` marker
 *      (plus the bytes/output-count) so the meter is retryable + visible and is
 *      reconciled on a later drain pass — never silently lost.
 * On success the pending marker is cleared and `usageMetered = true` is recorded.
 * A quota-exceeded result is NOT a failure here (recordPipelineExportUsageOnce
 * uses enforce:false), so the bytes are always recorded as an overage.
 */
async function recordExportUsageBestEffort(store: ExportJobStore, job: ExportJob, input: ExportUsageMeterInput): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= EXPORT_USAGE_RECORD_ATTEMPTS; attempt += 1) {
		try {
			await recordPipelineExportUsageOnce(input);
			await clearExportUsageMeteringPending(store, job, input);
			return;
		} catch (error) {
			lastError = error;
			console.warn(`[export-pipeline] Export ${input.exportJobId} usage record attempt ${attempt}/${EXPORT_USAGE_RECORD_ATTEMPTS} failed: ${error}`);
		}
	}
	// Durable, retryable, visible: leave a marker the drainer reconciles later.
	await markExportUsageMeteringPending(store, job, input, lastError);
}

/** Persist `usageMeteringPending` so a stranded meter survives + is reconcilable. */
async function markExportUsageMeteringPending(store: ExportJobStore, job: ExportJob, input: ExportUsageMeterInput, lastError: unknown): Promise<void> {
	try {
		const latest = (await store.get(job.id)) ?? job;
		await store.update(job.id, {
			params: {
				...latest.params,
				usageMeteringPending: true,
				usageMetered: false,
				usageMeteringBytes: input.bytes,
				usageMeteringOutputCount: input.outputCount,
				usageMeteringSourcePageCount: input.sourcePageCount,
			},
		});
		console.warn(`[export-pipeline] Export ${input.exportJobId} usage metering left PENDING after ${EXPORT_USAGE_RECORD_ATTEMPTS} attempts (${input.bytes} bytes); will reconcile on a later drain. Last error: ${lastError}`);
	} catch (error) {
		// Even the marker write failed — log loudly; the bytes are unaccounted but
		// the committed artifacts are untouched. Do not throw (job is already done).
		console.error(`[export-pipeline] Export ${input.exportJobId} usage metering FAILED and the pending marker could not be persisted: ${error}`);
	}
}

/** Clear any pending marker and record success once the meter is written. */
async function clearExportUsageMeteringPending(store: ExportJobStore, job: ExportJob, input: ExportUsageMeterInput): Promise<void> {
	try {
		const latest = (await store.get(job.id)) ?? job;
		// Only write if there is something to change, to avoid a needless update.
		if (latest.params?.usageMetered === true && latest.params?.usageMeteringPending !== true) return;
		await store.update(job.id, {
			params: {
				...latest.params,
				usageMetered: true,
				usageMeteringPending: false,
			},
		});
	} catch (error) {
		// The bytes are recorded (idempotently); only the success marker failed. A
		// stale pending marker would just trigger one extra idempotent reconcile.
		console.warn(`[export-pipeline] Export ${input.exportJobId} usage recorded but the success marker could not be persisted: ${error}`);
	}
}

/**
 * Reconcile export jobs whose export-bytes metering was left durably pending by
 * `recordExportUsageBestEffort` (a persistent ledger blip at completion time).
 * Finds `done` jobs with `params.usageMeteringPending === true` and re-invokes the
 * idempotent record (keyed `export-job:${id}`), clearing the marker on success so
 * a retry/reconcile NEVER double-charges. Best-effort: a reconcile failure is
 * logged and must not break job processing.
 */
export async function reconcilePendingExportUsage(store: ExportJobStore = exportJobStore): Promise<string[]> {
	let pending: ExportJob[];
	try {
		pending = await store.listPendingUsageMetering();
	} catch (error) {
		console.warn(`[export-pipeline] Could not list pending-usage export jobs to reconcile: ${error}`);
		return [];
	}
	const reconciled: string[] = [];
	for (const job of pending) {
		const bytes = readNumber(job.params.usageMeteringBytes) ?? 0;
		const outputCount = readNumber(job.params.usageMeteringOutputCount) ?? readNumber(job.params.outputCount) ?? 1;
		const sourcePageCount = readNumber(job.params.usageMeteringSourcePageCount) ?? readNumber(job.params.sourcePageCount);
		if (bytes <= 0) {
			// Nothing billable was ever pending — just clear the stale marker.
			await clearExportUsageMeteringPending(store, job, { projectId: job.projectId, exportJobId: job.id, bytes: 0, preset: job.preset, targetLang: job.targetLang, outputCount });
			reconciled.push(job.id);
			continue;
		}
		const input: ExportUsageMeterInput = {
			projectId: job.projectId,
			exportJobId: job.id,
			bytes,
			preset: job.preset,
			targetLang: job.targetLang,
			outputCount,
			sourcePageCount,
		};
		try {
			await recordPipelineExportUsageOnce(input);
			await clearExportUsageMeteringPending(store, job, input);
			reconciled.push(job.id);
		} catch (error) {
			console.warn(`[export-pipeline] Reconcile of pending usage for export ${job.id} failed; will retry next pass: ${error}`);
		}
	}
	return reconciled;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether a job is an explicit DRAFT/INTERNAL export profile, persisted as
 * `params.draft === true` at enqueue time. A draft export is allowed to SKIP +
 * FLAG a visible layer whose asset is missing/unreadable (best-effort preview),
 * whereas a PUBLISH export (the default — absent/false flag) FAILS CLOSED so it
 * never silently ships an artifact missing a user-placed layer. Either profile
 * still fails on a blocked/pending/unreleased asset via the readiness assert, so a
 * draft preview can never leak unmoderated content. Accepts the boolean `true` or
 * the string "true" (defensive against a JSON round-trip of an external caller).
 */
export function isDraftExportProfile(params: Record<string, unknown>): boolean {
	const value = params?.draft;
	return value === true || value === "true";
}

function readImageIds(params: Record<string, unknown>): string[] {
	const raw = params.imageIds;
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function readNumberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the persisted image-layer plans back into `ExportImageLayerPlan[]`,
 * dropping any entry without a usable imageId + target box. Mirrors the safe,
 * field-by-field re-read used for text layers so a stored job can never be coerced
 * into compositing garbage.
 */
function readExportImageLayerPlans(value: unknown): ExportImageLayerPlan[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const plans = value
		.filter(isRecord)
		.map((raw, index): ExportImageLayerPlan | undefined => {
			const imageId = readString(raw.imageId);
			const w = readNumberValue(raw.w);
			const h = readNumberValue(raw.h);
			if (!imageId || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
			return {
				id: readString(raw.id),
				imageId,
				x: readNumberValue(raw.x) ?? 0,
				y: readNumberValue(raw.y) ?? 0,
				w,
				h,
				rotation: readNumberValue(raw.rotation),
				opacity: readNumberValue(raw.opacity),
				flipX: raw.flipX === true,
				flipY: raw.flipY === true,
				blendMode: readBlendMode(raw.blendMode),
				sourceCrop: readSourceCrop(raw.sourceCrop),
				zIndex: readNumberValue(raw.zIndex) ?? index,
			};
		})
		.filter((plan): plan is ExportImageLayerPlan => plan !== undefined);
	return plans.length > 0 ? plans : undefined;
}

/**
 * Parse persisted fill-mask edit-layer plans back into `ExportEditLayerPlan[]`,
 * dropping any entry without a usable mask asset + fill + positive bbox. Mirrors the
 * safe field-by-field re-read used for image/text layers.
 */
function readExportEditLayerPlans(value: unknown): ExportEditLayerPlan[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const plans = value
		.filter(isRecord)
		.map((raw, index): ExportEditLayerPlan | undefined => {
			const maskAssetId = readString(raw.maskAssetId);
			const bbox = readEditBbox(raw.bbox);
			if (!maskAssetId || !bbox || bbox.w <= 0 || bbox.h <= 0) return undefined;
			const rawKind = readString(raw.kind);
			const kind: ExportEditLayerPlan["kind"] =
				rawKind === "patch" || rawKind === "healing" || rawKind === "clone" || rawKind === "fill-mask"
					? rawKind
					: "fill-mask";
			// fill-mask needs a real fill; Phase B kinds ignore it (placeholder).
			const fill = readEditFill(raw.fill) ?? { r: 0, g: 0, b: 0, a: 0 };
			if (kind === "fill-mask" && !readEditFill(raw.fill)) return undefined;
			return {
				id: readString(raw.id),
				kind,
				maskAssetId,
				fill,
				bbox,
				opacity: typeof raw.opacity === "number" && Number.isFinite(raw.opacity) ? raw.opacity : 1,
				index: typeof raw.index === "number" && Number.isFinite(raw.index) ? raw.index : index,
			};
		})
		.filter((plan): plan is ExportEditLayerPlan => plan !== undefined);
	return plans.length > 0 ? plans : undefined;
}

function readRenderPlans(params: Record<string, unknown>): ExportRenderPlan[] {
	const rawPlans = params.renderPlans;
	if (Array.isArray(rawPlans)) {
		const plans = rawPlans
			.filter(isRecord)
			.map((plan): ExportRenderPlan | undefined => {
				const sourceImageId = readString(plan.sourceImageId);
				const renderImageId = readString(plan.renderImageId) ?? sourceImageId;
				if (!sourceImageId || !renderImageId) return undefined;
				return {
					sourceImageId,
					renderImageId,
					textLayers: readTextLayers(plan.textLayers),
					imageLayers: readExportImageLayerPlans(plan.imageLayers),
					editLayers: readExportEditLayerPlans(plan.editLayers),
				};
			})
			.filter((plan): plan is ExportRenderPlan => plan !== undefined);
		if (plans.length > 0) return plans;
	}
	return readImageIds(params).map((imageId) => ({ sourceImageId: imageId, renderImageId: imageId }));
}

const ALLOWED_FORMATS: readonly ExportFormat[] = ["original", "jpeg", "webp", "avif"];

function clampExportSliceHeight(value: number): number {
	// Reuse the upload-transform split clamp so user-facing "height per piece"
	// behaves like import-time tall-image splitting while still honoring the
	// export pipeline's tighter per-job safety ceiling.
	return Math.min(Math.max(clampSplitThreshold(value), minExportSliceHeight()), 20000);
}

function readHeightSplitOverride(value: unknown): number | undefined {
	if (!isRecord(value) || value.mode !== "height") return undefined;
	const heightPerPiece = value.heightPerPiece;
	if (typeof heightPerPiece !== "number" || !Number.isFinite(heightPerPiece) || heightPerPiece <= 0) {
		return undefined;
	}
	return clampExportSliceHeight(heightPerPiece);
}

/**
 * Build the effective render config for a job: start from the built-in preset and
 * apply only the safe, recognized override fields that were persisted in
 * `params` at enqueue time. Unknown/malformed values are ignored so a stored job
 * can never be coerced into an unsafe transform, and the preset identity is
 * preserved.
 */
export function resolveEffectiveConfig(preset: ExportPreset, params: Record<string, unknown>): ExportPresetConfig {
	const base = getExportPresetConfig(preset);
	const config: ExportPresetConfig = { ...base };

	const maxWidth = params.maxWidth;
	if (typeof maxWidth === "number" && Number.isFinite(maxWidth) && maxWidth > 0) {
		config.maxWidth = Math.min(Math.trunc(maxWidth), 10000);
	}

	const quality = params.quality;
	if (typeof quality === "number" && Number.isFinite(quality)) {
		config.quality = Math.max(1, Math.min(100, Math.trunc(quality)));
	}

	const format = params.format;
	if (typeof format === "string" && (ALLOWED_FORMATS as readonly string[]).includes(format)) {
		config.format = format as ExportFormat;
	}

	const sliceHeights = params.sliceHeights;
	if (Array.isArray(sliceHeights)) {
		// Clamp every client-supplied slice height into [minSlice, 20000]. The MIN
		// floor is the DoS guard: without it, a tiny height (e.g. [1]) makes sliceTall
		// loop one page into height/1 outputs — tens of thousands of Sharp encodes from
		// a single request. Clamping UP keeps a tall webtoon export working while
		// bounding the per-page output count.
		const minSlice = minExportSliceHeight();
		const heights = sliceHeights
			.filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h > 0)
			.map((h) => Math.min(Math.max(Math.trunc(h), minSlice), 20000));
		if (heights.length > 0) config.sliceHeights = heights;
	}

	const heightSplit = readHeightSplitOverride(params.split);
	if (heightSplit !== undefined) {
		// New explicit split contract wins over legacy sliceHeights when both are
		// present; it represents the user's current "height per exported piece" choice.
		config.sliceHeights = [heightSplit];
	}

	return config;
}

/**
 * Standalone async drainer: claim and process queued jobs until the queue is
 * empty (or `max` is reached). Returns the processed job ids. Each job's failure
 * is isolated so one bad job does not stop the batch.
 */
export async function runDueExportJobs(options: ProcessExportJobOptions & { max?: number } = {}): Promise<string[]> {
	const store = options.store ?? exportJobStore;
	const max = options.max ?? 50;
	const processed: string[] = [];
	// First retry any export whose post-commit usage metering was left durably
	// pending by an earlier failed completion. Best-effort: a reconcile failure
	// must never stop the drain from processing the queue.
	try {
		await reconcilePendingExportUsage(store);
	} catch (error) {
		console.error(`[ExportPipeline] Pending-usage reconcile pass failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (let i = 0; i < max; i += 1) {
		const claimed = await store.claimNextQueued();
		if (!claimed) break;
		processed.push(claimed.id);
		try {
			await processExportJob(claimed.id, options);
		} catch (error) {
			console.error(`[ExportPipeline] Job ${claimed.id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return processed;
}

export interface ExportQueueProcessorOptions extends ProcessExportJobOptions {
	pollIntervalMs?: number;
	max?: number;
}

/**
 * Start an in-process drainer that periodically claims and runs due export jobs,
 * so `POST /api/export` -> queued is actually advanced to done in an API-only
 * deployment (no external runner required). Returns a stop() to clear the timer
 * on shutdown. A drain pass is never allowed to overlap itself.
 */
export function startExportQueueProcessor(options: ExportQueueProcessorOptions = {}): () => void {
	const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2000);
	let running = false;
	let stopped = false;
	const timer = setInterval(() => {
		if (running || stopped) return;
		running = true;
		void runDueExportJobs(options)
			.catch((error) => {
				console.error(`[ExportPipeline] Drain pass failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				running = false;
			});
	}, pollIntervalMs);
	// Don't keep the event loop alive solely for the drainer.
	if (typeof timer.unref === "function") timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
