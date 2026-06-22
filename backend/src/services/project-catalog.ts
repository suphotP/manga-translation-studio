import { getSharedBunSql } from "./sql-pool.js";
import { Buffer } from "buffer";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { isProjectTombstonedIn, isValidProjectId, safePath } from "../utils/security.js";
import type {
	AiReviewMarker,
	PageLanguageOutput,
	PageReviewDecision,
	PageState,
	ProjectComment,
	ProjectState,
	ReadingDirection,
	ReviewAnnotation,
	VersionReviewRequest,
	WorkflowTask,
} from "../types/index.js";
import { normalizeAssigneeHandle } from "./assignees.js";
import { dunningGraceActiveSql } from "./billing-store.js";
import { pushArrayLiteral } from "./pg-array.js";
import { normalizeScope, workspaceScopeAllows, isFineGrainedScope, workspaceAccessStore } from "./workspace-access.js";
import type { WorkspaceAccessStore, WorkspaceScope, WorkspaceScopeCheck } from "./workspace-access.js";

export interface ProjectVersionMetadata {
	versionId: string;
	projectId: string;
	name: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	source: "save" | "import-json" | "restore" | "manual";
	/** User-supplied label for a named ("manual") snapshot. */
	label?: string;
	/** Identity (email/userId) of the author who created this version. */
	author?: string;
	createdAt: string;
	pageCount: number;
	textLayerCount: number;
	stateHash?: string;
}

export interface ProjectSummary {
	projectId: string;
	workspaceId?: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	readingDirection?: ReadingDirection;
	coverImageId?: string;
	coverOriginalName?: string;
	sourceLang?: string;
	targetLang: string;
	targetLangs: string[];
	pageCount: number;
	textLayerCount: number;
	taskCount: number;
	openTaskCount: number;
	reviewTaskCount: number;
	commentCount: number;
	openCommentCount: number;
}

export interface ProjectWorkspacePlan {
	projectId: string;
	workspaceId: string;
	planId: string;
}

export interface ProjectWorkspaceStoragePlan extends ProjectWorkspacePlan {
	includedStorageBytes?: number;
	extraStorageBytes: number;
	projectIds: string[];
}

/**
 * Workspace-keyed sibling of {@link ProjectWorkspaceStoragePlan}. The CoW write
 * gate operates on a workspace_id (not a project id), so it resolves the
 * plan/pack-derived effective storage limit through this shape — the SAME
 * included + extra (addon grants + active storage packs) computation the
 * project-keyed quota uses — so the two quota subsystems agree on the limit.
 */
export interface WorkspaceStoragePlan {
	workspaceId: string;
	planId: string;
	includedStorageBytes?: number;
	extraStorageBytes: number;
}

export interface ProjectPageSummary {
	projectId: string;
	pageId: string;
	pageIndex: number;
	imageId?: string;
	status: string;
	revisionId?: string;
	imageName?: string;
	originalName?: string;
	textLayerCount: number;
	imageLayerCount: number;
	pendingAiJobCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface ProjectCatalogListOptions {
	userId?: string;
	limit?: number;
	cursor?: string;
	/**
	 * Restrict the listing to a single workspace AT THE SOURCE (SQL WHERE /
	 * in-memory filter). This is a real bound on work done — not a post-filter —
	 * so a caller paging within one workspace never scans the user's projects in
	 * OTHER workspaces. Used by the workspace-home aggregate, which must never
	 * page a user's entire cross-workspace project space to fill one dashboard.
	 */
	workspaceId?: string;
	/**
	 * SECURITY (GDPR export — P1b): exclude OWNERLESS anonymous/legacy personal
	 * projects from the listing. The default summary scope intentionally exposes
	 * `owner_user_id IS NULL` personal rows to any caller (the local-prototype /
	 * imported-without-owner case), but a subject's data-portability export must
	 * NEVER leak OTHER people's ownerless projects. When true, only projects
	 * GENUINELY tied to `userId` surface: personal projects with
	 * `owner_user_id = userId` (file-mode: `state.userId === userId`) and workspace
	 * projects the user is a real, non-disabled, in-scope member of. Ownerless
	 * anonymous personal rows are dropped. Requires `userId`.
	 */
	excludeOwnerlessPersonal?: boolean;
}

export interface ProjectSummaryPage {
	projects: ProjectSummary[];
	nextCursor?: string;
}

export function normalizeTargetLangs(input: {
	targetLang?: string | null;
	targetLangs?: readonly unknown[] | null;
	fallback?: string;
}): string[] {
	const seen = new Set<string>();
	const languages: string[] = [];
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const language = value.trim();
		if (!language || seen.has(language)) return;
		seen.add(language);
		languages.push(language);
	};
	if (Array.isArray(input.targetLangs)) {
		for (const language of input.targetLangs) add(language);
	}
	add(input.targetLang);
	if (languages.length === 0) add(input.fallback ?? "th");
	return languages.length > 0 ? languages : ["th"];
}

function normalizeProjectStateTargetLangs(state: ProjectState): string[] {
	const targetLangs = normalizeTargetLangs({
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
	state.targetLangs = targetLangs;
	state.targetLang = targetLangs[0] ?? "th";
	return targetLangs;
}

export interface ProjectVersionListOptions {
	projectId: string;
	limit?: number;
	cursor?: string;
}

export interface ProjectVersionPage {
	versions: ProjectVersionMetadata[];
	nextCursor?: string;
}

export interface ProjectVersionRecord {
	metadata: ProjectVersionMetadata;
	state: ProjectState;
}

export interface ProjectPageListOptions {
	projectId: string;
	limit?: number;
	cursor?: string;
	status?: string;
	pageIndex?: number;
}

export interface ProjectPageSummaryPage {
	pages: ProjectPageSummary[];
	nextCursor?: string;
}

export interface ProjectTaskListOptions {
	projectId: string;
	limit?: number;
	cursor?: string;
	status?: WorkflowTask["status"];
	type?: WorkflowTask["type"];
	assignee?: string;
	pageIndex?: number;
}

export interface ProjectTaskPage {
	tasks: WorkflowTask[];
	nextCursor?: string;
}

export interface ProjectCommentListOptions {
	projectId: string;
	limit?: number;
	cursor?: string;
	status?: ProjectComment["status"];
	pageIndex?: number;
	layerId?: string;
	author?: string;
}

export interface ProjectCommentPage {
	comments: ProjectComment[];
	nextCursor?: string;
}

export interface ProjectReviewDecisionListOptions {
	projectId: string;
	limit?: number;
	cursor?: string;
	status?: PageReviewDecision["status"];
	pageIndex?: number;
	actor?: string;
}

export interface ProjectReviewDecisionPage {
	decisions: PageReviewDecision[];
	nextCursor?: string;
}

export interface ProjectAccessCheck extends WorkspaceScopeCheck {
	projectId: string;
	userId: string;
	permission: string;
}

/**
 * Per-task scope check reused against a single resolved access context. Mirrors
 * the fields of `ProjectAccessCheck` that vary across tasks in a bulk operation
 * (page index, task type, language, resource kind) without re-resolving the
 * caller's workspace membership/role/scope each time.
 */
export type ResolvedProjectAccessCheck = WorkspaceScopeCheck;

/**
 * A caller's project access resolved ONCE (membership/role/scope looked up a
 * single time), exposing an in-memory `allows()` evaluator so that bulk
 * operations can authorize many tasks without issuing one membership query per
 * task. The semantics of `allows()` are identical to a single `canAccessProject`
 * call with the same scope-check fields — it does not weaken any access rule.
 */
export interface ProjectAccessContext {
	/** True when the caller has at least baseline access (role/permission) to the project. */
	readonly canAccessBaseline: boolean;
	/** Evaluate a per-resource scope check in-memory against the resolved context. */
	allows(check?: ResolvedProjectAccessCheck): boolean;
}

/**
 * Authoritative ownership of a story key (`storyId`) across the WHOLE catalog —
 * NOT scoped to any one caller's visible-project list. Used by the create-project
 * gate to decide whether a client-supplied `storyId` may be reused (adding a
 * chapter) or must be rejected (it belongs to a different workspace/owner, which
 * the Library would silently merge). Resolved via an UNCAPPED, indexed point
 * lookup so a caller who can see > N projects can never reuse a foreign storyId
 * that a capped visible-list scan would miss.
 */
export interface StoryIdOwnership {
	/** True when ANY non-deleted project carries this storyId. */
	exists: boolean;
	/** Distinct workspaceIds of WORKSPACE projects bearing this storyId. */
	workspaceIds: string[];
	/** Distinct owner user ids of PERSONAL (workspaceless) projects bearing this storyId. */
	ownerUserIds: string[];
	/**
	 * True when at least one PERSONAL project bearing this storyId has NO owner
	 * (legacy/anonymous, owner_user_id unset) — these are ownerless and not anchored
	 * to any authenticated owner scope.
	 */
	hasOwnerlessPersonal: boolean;
}

export interface ProjectCatalogStore {
	upsertProjectState(state: ProjectState, options?: { updatedAt?: string }): Promise<void>;
	recordProjectVersion(metadata: ProjectVersionMetadata, state: ProjectState): Promise<void>;
	deleteProjectVersions(projectId: string, versionIds: string[]): Promise<void>;
	/**
	 * Hard-delete a project and all of its catalog rows. Child rows (pages, tasks,
	 * comments, review decisions, versions, version reviews) cascade via the
	 * schema's `ON DELETE CASCADE` foreign keys, so this removes the single
	 * `projects` row. Idempotent: deleting a missing project is a no-op.
	 */
	deleteProject(projectId: string): Promise<void>;
	canAccessProject(input: ProjectAccessCheck): Promise<boolean>;
	/**
	 * Resolve the caller's access to a project ONCE (single membership/role/scope
	 * lookup) and return an in-memory evaluator. Bulk paths use this to authorize
	 * many tasks in O(1) store reads instead of O(n) `canAccessProject` calls.
	 * Returns null when the project does not exist.
	 */
	resolveProjectAccessContext(input: {
		projectId: string;
		userId: string;
		permission: string;
	}): Promise<ProjectAccessContext | null>;
	findExistingProjectIds(projectIds: string[]): Promise<Set<string>>;
	getProjectWorkspacePlan(projectId: string): Promise<ProjectWorkspacePlan | null>;
	getProjectWorkspaceStoragePlan(projectId: string): Promise<ProjectWorkspaceStoragePlan | null>;
	getWorkspaceStoragePlan(workspaceId: string): Promise<WorkspaceStoragePlan | null>;
	// UNSCOPED: returns every non-deleted project id for the workspace regardless
	// of any caller's per-member scope. Used by the workspace usage dashboard,
	// which is authorized at the workspace level, so a scope-restricted member must
	// still see complete workspace totals.
	listProjectIdsForWorkspace(workspaceId: string): Promise<string[]>;
	getProjectState(projectId: string): Promise<ProjectState | null>;
	/**
	 * Batched display-name lookup: projectId → title. `projects.title` is kept in sync
	 * with `state.name` on every save (upsert sets `title = EXCLUDED.title`), so callers
	 * that only need the LABEL can use this instead of deserializing each project's full
	 * (multi-MB) `current_state`. Missing / deleted / untitled ids are simply omitted.
	 */
	getProjectTitlesByIds(projectIds: string[]): Promise<Map<string, string>>;
	/**
	 * AUTHORITATIVE, UNCAPPED resolution of which workspace(s)/owner(s) a `storyId`
	 * currently belongs to, across every non-deleted project (not just a caller's
	 * visible list). The create-project gate uses this to classify a client-supplied
	 * storyId without scanning a capped visible-project page, so a foreign storyId can
	 * never slip past a scan cap. Returns `exists: false` (empty arrays) when no
	 * project carries the storyId.
	 */
	resolveStoryIdOwnership(storyId: string): Promise<StoryIdOwnership>;
	listProjectSummaryPage(options?: ProjectCatalogListOptions): Promise<ProjectSummaryPage>;
	listProjectSummaries(options?: ProjectCatalogListOptions): Promise<ProjectSummary[]>;
	listProjectVersions(options: ProjectVersionListOptions): Promise<ProjectVersionPage>;
	getProjectVersion(projectId: string, versionId: string): Promise<ProjectVersionRecord | null>;
	listProjectPages(options: ProjectPageListOptions): Promise<ProjectPageSummaryPage>;
	listProjectTasks(options: ProjectTaskListOptions): Promise<ProjectTaskPage>;
	listProjectComments(options: ProjectCommentListOptions): Promise<ProjectCommentPage>;
	listProjectReviewDecisions(options: ProjectReviewDecisionListOptions): Promise<ProjectReviewDecisionPage>;
}

export interface ProjectCatalogSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: ProjectCatalogSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface ProjectSummaryRow {
	project_id: string;
	workspace_id?: string;
	title: string;
	source_locale?: string | null;
	target_locale?: string | null;
	target_locales?: unknown;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

interface ProjectCurrentStateRow {
	current_state?: unknown;
}

interface ProjectVersionRow {
	version_id: string;
	project_id: string;
	name: string;
	source: string;
	state_hash?: string | null;
	page_count: number;
	text_layer_count: number;
	metadata?: unknown;
	state?: unknown;
	created_at: Date | string;
}

interface ProjectPageRow {
	page_id: string;
	project_id: string;
	page_index: number;
	image_id?: string | null;
	status: string;
	revision_id?: string | null;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

interface ProjectTaskRow {
	task_id: string;
	project_id: string;
	page_index: number;
	type: string;
	status: string;
	priority: string;
	title: string;
	assignee_user_id?: string | null;
	layer_id?: string | null;
	due_at?: Date | string | null;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

interface ProjectCommentRow {
	comment_id: string;
	project_id: string;
	page_index: number;
	layer_id?: string | null;
	status: string;
	body: string;
	author_user_id?: string | null;
	mentions?: string[] | null;
	region?: unknown;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

interface ProjectReviewDecisionRow {
	review_decision_id: string;
	project_id: string;
	page_index: number;
	status: string;
	body?: string | null;
	actor_user_id?: string | null;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

export class PostgresProjectCatalogStore implements ProjectCatalogStore {
	private readonly client: ProjectCatalogSqlClient;
	// Deletion tombstones live on disk under PROJECTS_DIR/.tombstones/<id> — the
	// delete route writes the tombstone FIRST (before disk + catalog), regardless of
	// catalog mode. So even in Postgres mode every project-data read consults this
	// dir to refuse a tombstoned id whose `projects` row may linger because the
	// catalog DELETE failed (or a stale replica still has it as deleted_at IS NULL).
	// This is the central, store-level resurrection guard — see `isTombstoned`.
	private readonly projectsDir: string;

	constructor(
		databaseUrlOrClient: string | ProjectCatalogSqlClient = process.env.DATABASE_URL ?? "",
		projectsDir: string = join(DATA_DIR, "projects"),
	) {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PROJECT_CATALOG_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as ProjectCatalogSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
		this.projectsDir = projectsDir;
	}

	/**
	 * Central resurrection guard: true when `projectId` has an on-disk deletion
	 * tombstone. The delete route writes the tombstone BEFORE the catalog DELETE,
	 * so a tombstoned id must NEVER be served by a catalog read even if the
	 * `projects` row lingers (catalog DELETE failed, or a stale replica). Every
	 * project-data read method funnels through this so one check covers all callers.
	 */
	private isTombstoned(projectId: string): boolean {
		return isProjectTombstonedIn(this.projectsDir, projectId);
	}

	async upsertProjectState(state: ProjectState, options: { updatedAt?: string } = {}): Promise<void> {
		const updatedAt = options.updatedAt ?? new Date().toISOString();
		await this.transaction(async (client) => {
			await upsertProjectCatalogRows(client, state, updatedAt);
			await syncProjectPages(client, state, updatedAt);
			await syncProjectTasks(client, state, updatedAt);
			await syncProjectComments(client, state, updatedAt);
			await syncProjectReviewDecisions(client, state, updatedAt);
			await syncProjectReviewAssignments(client, state, updatedAt);
			await syncProjectRevisionRequests(client, state, updatedAt);
			await syncProjectVersionReviews(client, state, updatedAt);
		});
	}

	async recordProjectVersion(metadata: ProjectVersionMetadata, state: ProjectState): Promise<void> {
		await this.client.unsafe(`
			INSERT INTO project_versions (
				version_id,
				project_id,
				name,
				source,
				state_hash,
				page_count,
				text_layer_count,
				metadata,
				state,
				created_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10)
			ON CONFLICT (version_id) DO UPDATE SET
				name = EXCLUDED.name,
				source = EXCLUDED.source,
				state_hash = EXCLUDED.state_hash,
				page_count = EXCLUDED.page_count,
				text_layer_count = EXCLUDED.text_layer_count,
				metadata = EXCLUDED.metadata,
				state = EXCLUDED.state,
				created_at = EXCLUDED.created_at
		`, [
			metadata.versionId,
			metadata.projectId,
			metadata.name,
			metadata.source,
			metadata.stateHash ?? null,
			metadata.pageCount,
			metadata.textLayerCount,
			JSON.stringify(metadata),
			JSON.stringify(state),
			metadata.createdAt,
		]);
	}

	async deleteProjectVersions(projectId: string, versionIds: string[]): Promise<void> {
		const ids = [...new Set(versionIds.map((versionId) => versionId.trim()).filter(Boolean))];
		if (ids.length === 0) return;
		const placeholders = ids.map((_, index) => `$${index + 2}`).join(", ");
		await this.client.unsafe(`
			DELETE FROM project_versions
			WHERE project_id = $1
				AND version_id IN (${placeholders})
		`, [projectId, ...ids]);
	}

	async deleteProject(projectId: string): Promise<void> {
		const id = projectId.trim();
		if (!id) return;
		// ATOMIC + durable (no resurrection in Postgres mode):
		//  - This is a HARD delete (DELETE FROM, not a soft `deleted_at` set), so a
		//    successful run leaves NO row at all — there is no `deleted_at IS NULL`
		//    lingering row for a reader to re-derive the project from.
		//  - It is a SINGLE statement, so Postgres applies it all-or-nothing: the row
		//    (and every child row via ON DELETE CASCADE) is removed together, or — on
		//    any error — the statement ROLLS BACK and the row is left fully intact.
		//    There is no committed half-state. The delete route turns a thrown error
		//    into a 500 (the on-disk tombstone is already written first), so the worst
		//    case is "tombstone written, catalog row untouched" — and the central
		//    `isTombstoned` guard refuses that lingering row on every read anyway.
		// Child rows (pages, tasks, comments, review decisions, versions, version
		// reviews, assets, ai_jobs) drop via ON DELETE CASCADE; usage/audit events
		// are retained with project_id set NULL by the schema for accounting.
		await this.client.unsafe(`DELETE FROM projects WHERE project_id = $1`, [id]);
	}

	async listProjectVersions(options: ProjectVersionListOptions): Promise<ProjectVersionPage> {
		const projectId = options.projectId.trim();
		if (!projectId || this.isTombstoned(projectId)) return { versions: [] };
		const limit = normalizeListLimit(options.limit);
		const cursor = decodeProjectVersionCursor(options.cursor);
		const rows = await this.client.unsafe<ProjectVersionRow>(`
			SELECT
				version_id,
				project_id,
				name,
				source,
				state_hash,
				page_count,
				text_layer_count,
				metadata,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
			FROM project_versions
			WHERE project_id = $1
				AND (
					$2::timestamptz IS NULL
					OR (created_at, version_id) < ($2::timestamptz, $3::text)
				)
			ORDER BY created_at DESC, version_id DESC
			LIMIT $4
		`, [
			projectId,
			cursor?.createdAt ?? null,
			cursor?.versionId ?? null,
			limit + 1,
		]);
		const versions = rows.map(mapProjectVersionRow);
		const pageVersions = versions.slice(0, limit);
		const lastVersion = pageVersions[pageVersions.length - 1];
		return {
			versions: pageVersions,
			nextCursor: versions.length > limit && lastVersion ? encodeProjectVersionCursor(lastVersion) : undefined,
		};
	}

	async getProjectVersion(projectId: string, versionId: string): Promise<ProjectVersionRecord | null> {
		const id = projectId.trim();
		const version = versionId.trim();
		if (!id || !version || this.isTombstoned(id)) return null;
		const rows = await this.client.unsafe<ProjectVersionRow>(`
			SELECT
				version_id,
				project_id,
				name,
				source,
				state_hash,
				page_count,
				text_layer_count,
				metadata,
				state,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
			FROM project_versions
			WHERE project_id = $1
				AND version_id = $2
			LIMIT 1
		`, [id, version]);
		return rows[0] ? mapProjectVersionRecordRow(rows[0]) : null;
	}

	async listProjectPages(options: ProjectPageListOptions): Promise<ProjectPageSummaryPage> {
		const projectId = options.projectId.trim();
		if (!projectId || this.isTombstoned(projectId)) return { pages: [] };
		const limit = normalizeListLimit(options.limit);
		const cursor = decodeProjectPageCursor(options.cursor);
		const status = options.status?.trim() || null;
		const pageIndex = typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex)
			? options.pageIndex
			: null;
		const rows = await this.client.unsafe<ProjectPageRow>(`
			SELECT page_id, project_id, page_index, image_id, status, revision_id, metadata, created_at, updated_at
			FROM project_pages
			WHERE project_id = $1
				AND ($2::text IS NULL OR status = $2)
				AND ($3::integer IS NULL OR page_index > $3::integer)
				AND ($4::integer IS NULL OR page_index = $4::integer)
			ORDER BY page_index ASC
			LIMIT $5
		`, [
			projectId,
			status,
			cursor?.pageIndex ?? null,
			pageIndex,
			limit + 1,
		]);
		const pages = rows.map(mapProjectPageRow);
		const pageSummaries = pages.slice(0, limit);
		const lastPage = pageSummaries[pageSummaries.length - 1];
		return {
			pages: pageSummaries,
			nextCursor: pages.length > limit && lastPage ? encodeProjectPageCursor(lastPage) : undefined,
		};
	}

	async listProjectTasks(options: ProjectTaskListOptions): Promise<ProjectTaskPage> {
		const projectId = options.projectId.trim();
		if (!projectId || this.isTombstoned(projectId)) return { tasks: [] };
		const limit = normalizeListLimit(options.limit);
		const cursor = decodeProjectTaskCursor(options.cursor);
		const conditions = ["project_id = $1"];
		const params: unknown[] = [projectId];
		const addParam = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		const status = options.status?.trim();
		if (status) conditions.push(`status = ${addParam(status)}`);
		const type = options.type?.trim();
		if (type) conditions.push(`type = ${addParam(type)}`);
		const assignee = normalizeAssigneeHandle(options.assignee);
		if (assignee) conditions.push(`assignee_user_id = ${addParam(assignee)}`);
		if (typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex)) {
			conditions.push(`page_index = ${addParam(options.pageIndex)}`);
		}
		if (cursor) {
			const updatedAtParam = addParam(cursor.updatedAt);
			const taskIdParam = addParam(cursor.taskId);
			conditions.push(`(updated_at, task_id) < (${updatedAtParam}::timestamptz, ${taskIdParam}::text)`);
		}
		const limitParam = addParam(limit + 1);
		const rows = await this.client.unsafe<ProjectTaskRow>(`
			SELECT task_id, project_id, page_index, type, status, priority, title, assignee_user_id, layer_id, due_at, metadata, created_at, updated_at
			FROM project_tasks
			WHERE ${conditions.join("\n\t\t\t\tAND ")}
			ORDER BY updated_at DESC, task_id DESC
			LIMIT ${limitParam}
		`, params);
		const tasks = rows.map(mapProjectTaskRow);
		const pageTasks = tasks.slice(0, limit);
		const lastTask = pageTasks[pageTasks.length - 1];
		return {
			tasks: pageTasks,
			nextCursor: tasks.length > limit && lastTask ? encodeProjectTaskCursor(lastTask) : undefined,
		};
	}

	async listProjectComments(options: ProjectCommentListOptions): Promise<ProjectCommentPage> {
		const projectId = options.projectId.trim();
		if (!projectId || this.isTombstoned(projectId)) return { comments: [] };
		const limit = normalizeListLimit(options.limit);
		const cursor = decodeProjectCommentCursor(options.cursor);
		const conditions = ["project_id = $1"];
		const params: unknown[] = [projectId];
		const addParam = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		const status = options.status?.trim();
		if (status) conditions.push(`status = ${addParam(status)}`);
		if (typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex)) {
			conditions.push(`page_index = ${addParam(options.pageIndex)}`);
		}
		const layerId = options.layerId?.trim();
		if (layerId) conditions.push(`layer_id = ${addParam(layerId)}`);
		const author = options.author?.trim();
		if (author) conditions.push(`author_user_id = ${addParam(author)}`);
		if (cursor) {
			const updatedAtParam = addParam(cursor.updatedAt);
			const commentIdParam = addParam(cursor.commentId);
			conditions.push(`(updated_at, comment_id) < (${updatedAtParam}::timestamptz, ${commentIdParam}::text)`);
		}
		const limitParam = addParam(limit + 1);
		const rows = await this.client.unsafe<ProjectCommentRow>(`
			SELECT comment_id, project_id, page_index, layer_id, status, body, author_user_id, mentions, region, metadata, created_at, updated_at
			FROM project_comments
			WHERE ${conditions.join("\n\t\t\t\tAND ")}
			ORDER BY updated_at DESC, comment_id DESC
			LIMIT ${limitParam}
		`, params);
		const comments = rows.map(mapProjectCommentRow);
		const pageComments = comments.slice(0, limit);
		const lastComment = pageComments[pageComments.length - 1];
		return {
			comments: pageComments,
			nextCursor: comments.length > limit && lastComment ? encodeProjectCommentCursor(lastComment) : undefined,
		};
	}

	async listProjectReviewDecisions(options: ProjectReviewDecisionListOptions): Promise<ProjectReviewDecisionPage> {
		const projectId = options.projectId.trim();
		if (!projectId || this.isTombstoned(projectId)) return { decisions: [] };
		const limit = normalizeListLimit(options.limit);
		const cursor = decodeProjectReviewDecisionCursor(options.cursor);
		const conditions = ["project_id = $1"];
		const params: unknown[] = [projectId];
		const addParam = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		const status = options.status?.trim();
		if (status) conditions.push(`status = ${addParam(status)}`);
		if (typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex)) {
			conditions.push(`page_index = ${addParam(options.pageIndex)}`);
		}
		const actor = options.actor?.trim();
		if (actor) conditions.push(`actor_user_id = ${addParam(actor)}`);
		if (cursor) {
			const updatedAtParam = addParam(cursor.updatedAt);
			const reviewDecisionIdParam = addParam(cursor.reviewDecisionId);
			conditions.push(`(updated_at, review_decision_id) < (${updatedAtParam}::timestamptz, ${reviewDecisionIdParam}::text)`);
		}
		const limitParam = addParam(limit + 1);
		const rows = await this.client.unsafe<ProjectReviewDecisionRow>(`
			SELECT review_decision_id, project_id, page_index, status, body, actor_user_id, metadata, created_at, updated_at
			FROM project_review_decisions
			WHERE ${conditions.join("\n\t\t\t\tAND ")}
			ORDER BY updated_at DESC, review_decision_id DESC
			LIMIT ${limitParam}
		`, params);
		const decisions = rows.map(mapProjectReviewDecisionRow);
		const pageDecisions = decisions.slice(0, limit);
		const lastDecision = pageDecisions[pageDecisions.length - 1];
		return {
			decisions: pageDecisions,
			nextCursor: decisions.length > limit && lastDecision ? encodeProjectReviewDecisionCursor(lastDecision) : undefined,
		};
	}

	async canAccessProject(input: ProjectAccessCheck): Promise<boolean> {
		const context = await this.resolveProjectAccessContext(input);
		if (!context) return false;
		return context.allows(input);
	}

	async resolveProjectAccessContext(input: {
		projectId: string;
		userId: string;
		permission: string;
	}): Promise<ProjectAccessContext | null> {
		// Resurrection guard: a tombstoned id resolves to "no project" → null, so a
		// lingering row can't grant access to a deleted project.
		if (this.isTombstoned(input.projectId.trim())) return null;
		// Single membership/role/scope read — shared across every per-task check in
		// a bulk operation (O(1) instead of O(n)).
		// Join the owning workspace's `suspended_at` so the CENTRAL freeze gate (a
		// verified refund/chargeback or admin suspension) is enforced for EVERY
		// catalog-authorized mutating route, not just requirePermission. A frozen
		// workspace denies mutating permissions for everyone; reads still pass.
		const rows = await this.client.unsafe<{ role: string; scope?: unknown; target_locale?: string | null; suspended_at?: Date | string | null }>(`
			SELECT workspace_members.role, workspace_members.scope, projects.target_locale, workspaces.suspended_at
			FROM projects
			INNER JOIN workspace_members ON workspace_members.workspace_id = projects.workspace_id
			INNER JOIN workspaces ON workspaces.workspace_id = projects.workspace_id
			WHERE projects.project_id = $1
				AND projects.deleted_at IS NULL
				AND workspace_members.user_id = $2
				AND workspace_members.disabled_at IS NULL
			LIMIT 1
		`, [input.projectId, input.userId]);
		const member = rows[0];
		// Matches the original `Boolean(member && …)` guard: no membership row → deny.
		if (!member) return DENIED_PROJECT_ACCESS_CONTEXT;
		return buildWorkspaceProjectAccessContext({
			role: member.role,
			scope: normalizeScope(member.scope),
			permission: input.permission,
			projectId: input.projectId,
			defaultLanguage: member.target_locale ?? undefined,
			workspaceSuspended: Boolean(member.suspended_at),
		});
	}

	async listProjectIdsForWorkspace(workspaceId: string): Promise<string[]> {
		const normalizedWorkspaceId = workspaceId.trim();
		if (!normalizedWorkspaceId) return [];
		const rows = await this.client.unsafe<{ project_id: string }>(`
			SELECT project_id
			FROM projects
			WHERE workspace_id = $1
				AND deleted_at IS NULL
			ORDER BY project_id ASC
		`, [normalizedWorkspaceId]);
		return rows
			.map((row) => row.project_id?.trim())
			.filter((projectId): projectId is string => Boolean(projectId))
			// Resurrection guard: drop any tombstoned id whose row lingers, so a
			// failed catalog DELETE can't re-surface a deleted project in workspace
			// scans (usage dashboard, storage breakdown, etc.).
			.filter((projectId) => !this.isTombstoned(projectId));
	}

	async getProjectWorkspacePlan(projectId: string): Promise<ProjectWorkspacePlan | null> {
		const normalizedProjectId = projectId.trim();
		if (!normalizedProjectId) return null;
		// Resurrection guard: a tombstoned id has no plan even if its row lingers.
		if (this.isTombstoned(normalizedProjectId)) return null;
		const rows = await this.client.unsafe<{ project_id: string; workspace_id: string; plan_id?: string | null }>(`
			SELECT projects.project_id, projects.workspace_id, workspace_billing_accounts.plan_id
			FROM projects
			LEFT JOIN workspace_billing_accounts
				ON workspace_billing_accounts.workspace_id = projects.workspace_id
				AND workspace_billing_accounts.status IN ('mock_active', 'trialing', 'active')
				AND ${dunningGraceActiveSql()}
			WHERE projects.project_id = $1
				AND projects.deleted_at IS NULL
			LIMIT 1
		`, [normalizedProjectId]);
		const row = rows[0];
		return row?.plan_id
			? {
				projectId: row.project_id,
				workspaceId: row.workspace_id,
				planId: row.plan_id,
			}
			: null;
	}

	async getProjectWorkspaceStoragePlan(projectId: string): Promise<ProjectWorkspaceStoragePlan | null> {
		const normalizedProjectId = projectId.trim();
		if (!normalizedProjectId) return null;
		// Resurrection guard: a tombstoned id has no storage plan even if it lingers.
		if (this.isTombstoned(normalizedProjectId)) return null;
		const rows = await this.client.unsafe<{
			project_id: string;
			workspace_id: string;
			plan_id: string;
			included_storage_bytes?: number | string | null;
			extra_storage_bytes?: number | string | null;
			project_ids?: unknown;
		}>(`
			SELECT
				projects.project_id,
				projects.workspace_id,
				COALESCE(billing_plans.plan_id, 'free') AS plan_id,
				billing_plans.included_storage_bytes,
				(
					COALESCE(SUM(workspace_addon_grants.storage_bytes * GREATEST(workspace_addon_grants.quantity, 0)), 0)
					+ COALESCE((
						SELECT SUM(GREATEST(storage_packs.pack_size_bytes, 0))
						FROM storage_packs
						WHERE storage_packs.workspace_id = projects.workspace_id
							AND storage_packs.active = true
							AND (storage_packs.expires_at IS NULL OR storage_packs.expires_at > now())
					), 0)
				) AS extra_storage_bytes,
				ARRAY(
					SELECT workspace_projects.project_id
					FROM projects AS workspace_projects
					WHERE workspace_projects.workspace_id = projects.workspace_id
						AND workspace_projects.deleted_at IS NULL
					ORDER BY workspace_projects.project_id ASC
				) AS project_ids
			FROM projects
			INNER JOIN workspaces ON workspaces.workspace_id = projects.workspace_id
			LEFT JOIN workspace_billing_accounts
				ON workspace_billing_accounts.workspace_id = workspaces.workspace_id
				AND workspace_billing_accounts.status IN ('mock_active', 'trialing', 'active')
				AND ${dunningGraceActiveSql()}
			LEFT JOIN billing_plans
				ON billing_plans.plan_id = workspace_billing_accounts.plan_id
				AND billing_plans.status = 'active'
			LEFT JOIN workspace_addon_grants
				ON workspace_addon_grants.workspace_id = workspaces.workspace_id
				AND workspace_addon_grants.status = 'active'
				AND (workspace_addon_grants.expires_at IS NULL OR workspace_addon_grants.expires_at > now())
			WHERE projects.project_id = $1
				AND projects.deleted_at IS NULL
			GROUP BY projects.project_id, projects.workspace_id, COALESCE(billing_plans.plan_id, 'free'), billing_plans.included_storage_bytes
			LIMIT 1
		`, [normalizedProjectId]);
		const row = rows[0];
		if (!row) return null;
		// Resurrection guard: drop any tombstoned id from the workspace project list
		// (a lingering row could otherwise inflate the storage-quota denominator).
		const projectIds = toStringArray(row.project_ids, [row.project_id])
			.filter((id) => !this.isTombstoned(id));
		return {
			projectId: row.project_id,
			workspaceId: row.workspace_id,
			planId: row.plan_id,
			includedStorageBytes: toNumber(row.included_storage_bytes),
			extraStorageBytes: toNumber(row.extra_storage_bytes) ?? 0,
			projectIds: projectIds.length > 0 ? projectIds : [row.project_id],
		};
	}

	async getWorkspaceStoragePlan(workspaceId: string): Promise<WorkspaceStoragePlan | null> {
		const normalizedWorkspaceId = workspaceId.trim();
		if (!normalizedWorkspaceId) return null;
		// Workspace-keyed mirror of getProjectWorkspaceStoragePlan: the in-effect
		// plan's included storage plus addon grants + active storage packs. The CoW
		// write gate uses this so its effective limit equals the project-keyed
		// storage-quota limit for the SAME workspace.
		const rows = await this.client.unsafe<{
			workspace_id: string;
			plan_id: string;
			included_storage_bytes?: number | string | null;
			extra_storage_bytes?: number | string | null;
		}>(`
			SELECT
				workspaces.workspace_id,
				COALESCE(billing_plans.plan_id, 'free') AS plan_id,
				billing_plans.included_storage_bytes,
				(
					COALESCE(SUM(workspace_addon_grants.storage_bytes * GREATEST(workspace_addon_grants.quantity, 0)), 0)
					+ COALESCE((
						SELECT SUM(GREATEST(storage_packs.pack_size_bytes, 0))
						FROM storage_packs
						WHERE storage_packs.workspace_id = workspaces.workspace_id
							AND storage_packs.active = true
							AND (storage_packs.expires_at IS NULL OR storage_packs.expires_at > now())
					), 0)
				) AS extra_storage_bytes
			FROM workspaces
			LEFT JOIN workspace_billing_accounts
				ON workspace_billing_accounts.workspace_id = workspaces.workspace_id
				AND workspace_billing_accounts.status IN ('mock_active', 'trialing', 'active')
				AND ${dunningGraceActiveSql()}
			LEFT JOIN billing_plans
				ON billing_plans.plan_id = workspace_billing_accounts.plan_id
				AND billing_plans.status = 'active'
			LEFT JOIN workspace_addon_grants
				ON workspace_addon_grants.workspace_id = workspaces.workspace_id
				AND workspace_addon_grants.status = 'active'
				AND (workspace_addon_grants.expires_at IS NULL OR workspace_addon_grants.expires_at > now())
			WHERE workspaces.workspace_id = $1
			GROUP BY workspaces.workspace_id, COALESCE(billing_plans.plan_id, 'free'), billing_plans.included_storage_bytes
			LIMIT 1
		`, [normalizedWorkspaceId]);
		const row = rows[0];
		if (!row) return null;
		return {
			workspaceId: row.workspace_id,
			planId: row.plan_id,
			includedStorageBytes: toNumber(row.included_storage_bytes),
			extraStorageBytes: toNumber(row.extra_storage_bytes) ?? 0,
		};
	}

	async listProjectSummaryPage(options: ProjectCatalogListOptions = {}): Promise<ProjectSummaryPage> {
		const limit = normalizeListLimit(options.limit);
		const userId = options.userId?.trim() || null;
		const workspaceId = options.workspaceId?.trim() || null;
		// P1b: when set, suppress the ownerless-anonymous personal branch so a GDPR
		// export cannot leak other people's legacy/imported (owner_user_id IS NULL)
		// projects. Bound as a SQL param ($6) rather than string-built so it stays a
		// real source filter.
		const excludeOwnerlessPersonal = options.excludeOwnerlessPersonal === true;
		const cursor = decodeProjectSummaryCursor(options.cursor);
		const rows = await this.client.unsafe<ProjectSummaryRow>(`
			SELECT
				project_id,
				workspace_id,
				title,
				source_locale,
				target_locale,
				target_locales,
				metadata,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
				to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
			FROM projects
			WHERE deleted_at IS NULL
				AND (
					$2::timestamptz IS NULL
					OR (projects.updated_at, projects.project_id) < ($2::timestamptz, $3::text)
				)
				-- Workspace bound applied AT THE SOURCE so paging within one
				-- workspace never scans projects in the caller's other workspaces.
				AND ($5::text IS NULL OR projects.workspace_id = $5::text)
				AND (
					(NOT $6::boolean AND owner_user_id IS NULL AND NOT (projects.metadata ? 'workspaceId'))
					OR ($1::text IS NOT NULL AND (
						(owner_user_id = $1 AND NOT (projects.metadata ? 'workspaceId'))
						OR EXISTS (
							SELECT 1
							FROM workspace_members
							CROSS JOIN LATERAL (
								SELECT CASE
									WHEN jsonb_typeof(workspace_members.scope) = 'object' THEN workspace_members.scope
									WHEN jsonb_typeof(workspace_members.scope) = 'string' THEN (workspace_members.scope #>> '{}')::jsonb
									ELSE '{}'::jsonb
								END AS scope
							) AS workspace_member_scope
							WHERE workspace_members.workspace_id = projects.workspace_id
								AND workspace_members.user_id = $1
								AND workspace_members.disabled_at IS NULL
								AND (
									NOT (workspace_member_scope.scope ? 'projectIds')
									OR jsonb_typeof(workspace_member_scope.scope->'projectIds') <> 'array'
									OR jsonb_array_length(workspace_member_scope.scope->'projectIds') = 0
									OR (workspace_member_scope.scope->'projectIds') ? projects.project_id
								)
									AND (
										NOT (workspace_member_scope.scope ? 'languages')
										OR jsonb_typeof(workspace_member_scope.scope->'languages') <> 'array'
										OR jsonb_array_length(workspace_member_scope.scope->'languages') = 0
										OR EXISTS (
											SELECT 1
											FROM unnest(COALESCE(projects.target_locales, ARRAY[projects.target_locale]::text[])) AS project_language(language)
											WHERE project_language.language IS NOT NULL
												AND (workspace_member_scope.scope->'languages') ? project_language.language
										)
									)
									AND (
										NOT (workspace_member_scope.scope ? 'chapterIds')
										OR jsonb_typeof(workspace_member_scope.scope->'chapterIds') <> 'array'
										OR jsonb_array_length(workspace_member_scope.scope->'chapterIds') = 0
										-- A chapter is represented by the project row in the catalog, so
										-- chapter-scoped members may see only the chapter/project ids they hold.
										OR (workspace_member_scope.scope->'chapterIds') ? projects.project_id
									)
									AND (
										NOT (workspace_member_scope.scope ? 'pageIndexes')
										OR jsonb_typeof(workspace_member_scope.scope->'pageIndexes') <> 'array'
										OR jsonb_array_length(workspace_member_scope.scope->'pageIndexes') = 0
										-- Page scope is safe for the library only after a project/chapter
										-- bound has already limited which catalog rows can surface.
										OR (
											jsonb_typeof(workspace_member_scope.scope->'projectIds') = 'array'
											AND jsonb_array_length(workspace_member_scope.scope->'projectIds') > 0
										)
										OR (
											jsonb_typeof(workspace_member_scope.scope->'chapterIds') = 'array'
											AND jsonb_array_length(workspace_member_scope.scope->'chapterIds') > 0
										)
									)
									-- taskTypes/assetPurposes scope gates work and asset operations, not
									-- whether a contributor can see the workspace chapter list.
							)
						))
					)
			ORDER BY projects.updated_at DESC, projects.project_id DESC
			LIMIT $4
		`, [
			userId,
			cursor?.updatedAt ?? null,
			cursor?.projectId ?? null,
			limit + 1,
			workspaceId,
			excludeOwnerlessPersonal,
		]);
		// Resurrection guard: drop tombstoned ids whose `deleted_at IS NULL` row
		// lingered after a failed catalog DELETE, mirroring the file store (whose
		// readState already refuses them before pagination). Filtering before the
		// page slice keeps cursor semantics intact (a rare partial-delete edge may
		// yield a slightly short page, never a resurrected one).
		const summaries = rows.map(mapProjectSummaryRow).filter((summary) => !this.isTombstoned(summary.projectId));
		const projects = summaries.slice(0, limit);
		const lastProject = projects[projects.length - 1];
		return {
			projects,
			nextCursor: summaries.length > limit && lastProject ? encodeProjectSummaryCursor(lastProject) : undefined,
		};
	}

	async listProjectSummaries(options: ProjectCatalogListOptions = {}): Promise<ProjectSummary[]> {
		return (await this.listProjectSummaryPage(options)).projects;
	}

	async findExistingProjectIds(projectIds: string[]): Promise<Set<string>> {
		const ids = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
		if (ids.length === 0) return new Set();
		// Scalar ARRAY[] binds: Bun.SQL cannot bind a JS array for $n::text[]
		// (it serializes ["a","b"] as the malformed literal "a,b").
		const params: unknown[] = [];
		const rows = await this.client.unsafe<{ project_id: string }>(`
			SELECT project_id
			FROM projects
			WHERE deleted_at IS NULL
				AND project_id = ANY(${pushArrayLiteral(params, ids, "text")})
		`, params);
		// Resurrection guard: a tombstoned id does NOT "exist" even if its row
		// lingers, so an existence probe can't re-validate a deleted project id.
		return new Set(rows.map((row) => row.project_id).filter((id) => !this.isTombstoned(id)));
	}

	async getProjectState(projectId: string): Promise<ProjectState | null> {
		const id = projectId.trim();
		if (!id) return null;
		// Resurrection guard: a tombstoned id is never served even if a lingering
		// `deleted_at IS NULL` row survived a failed catalog DELETE.
		if (this.isTombstoned(id)) return null;
		const rows = await this.client.unsafe<ProjectCurrentStateRow>(`
			SELECT current_state
			FROM projects
			WHERE project_id = $1
				AND deleted_at IS NULL
		`, [id]);
		return parseProjectCurrentState(rows[0]?.current_state);
	}

	async getProjectTitlesByIds(projectIds: string[]): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		// De-dupe + drop blanks/tombstones; preserve the original id as the map key.
		const ids = Array.from(new Set(projectIds.map((id) => id.trim()).filter((id) => id && !this.isTombstoned(id))));
		if (ids.length === 0) return result;
		// Positional IN list (this codebase doesn't use array→ANY binding); ids are bound
		// as params, placeholders are index-generated, so neither is injectable.
		const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
		const rows = await this.client.unsafe<{ project_id: string; title: string | null }>(`
			SELECT project_id, title
			FROM projects
			WHERE project_id IN (${placeholders})
				AND deleted_at IS NULL
		`, ids);
		for (const row of rows) {
			if (typeof row.title === "string" && row.title) result.set(row.project_id, row.title);
		}
		return result;
	}

	async resolveStoryIdOwnership(storyId: string): Promise<StoryIdOwnership> {
		const id = storyId.trim();
		if (!id) return emptyStoryIdOwnership();
		// UNCAPPED, indexed point lookup on metadata->>'storyId' (projects_story_id_idx,
		// migration 0069) — every non-deleted project bearing this storyId, regardless of
		// who can see it, so the create gate classifies ownership authoritatively instead
		// of scanning a capped, caller-visible list.
		const rows = await this.client.unsafe<{
			project_id: string;
			workspace_id: string | null;
			owner_user_id: string | null;
			metadata: unknown;
		}>(`
			SELECT project_id, workspace_id, owner_user_id, metadata
			FROM projects
			WHERE deleted_at IS NULL
				AND metadata->>'storyId' = $1
		`, [id]);
		const ownership = emptyStoryIdOwnership();
		const workspaceIds = new Set<string>();
		const ownerUserIds = new Set<string>();
		for (const row of rows) {
			// Resurrection guard: a tombstoned id whose `deleted_at IS NULL` row lingered
			// after a failed catalog DELETE must not anchor ownership.
			if (this.isTombstoned(row.project_id)) continue;
			const metadata = normalizeRecord(row.metadata);
			// `workspace_id` is non-null for EVERY row (a personal project is stored under a
			// synthetic per-user workspace), so distinguish a true WORKSPACE project from a
			// PERSONAL one by the explicit metadata.workspaceId marker — the same signal
			// hasExplicitWorkspaceId / mapProjectSummaryRow use.
			const explicitWorkspaceId = readOptionalString(metadata.workspaceId);
			if (explicitWorkspaceId) {
				ownership.exists = true;
				workspaceIds.add(explicitWorkspaceId);
				continue;
			}
			ownership.exists = true;
			const ownerUserId = readOptionalString(row.owner_user_id ?? undefined);
			if (ownerUserId) {
				ownerUserIds.add(ownerUserId);
			} else {
				ownership.hasOwnerlessPersonal = true;
			}
		}
		ownership.workspaceIds = [...workspaceIds];
		ownership.ownerUserIds = [...ownerUserIds];
		return ownership;
	}

	private async transaction<T>(fn: (client: ProjectCatalogSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) {
			return this.client.begin(fn);
		}
		await this.client.unsafe("BEGIN");
		try {
			const result = await fn(this.client);
			await this.client.unsafe("COMMIT");
			return result;
		} catch (error) {
			await this.client.unsafe("ROLLBACK");
			throw error;
		}
	}
}

function workspaceRoleCanProjectPermission(role: string, permission: string): boolean {
	if (role === "owner" || role === "admin") return true;
	if (role === "editor") {
		return ["read:project", "update:project", "generate:ai", "export:project", "import:project"].includes(permission);
	}
	if (role === "viewer") {
		// Viewer = view-only free seat (no export) — mirrors workspace-access
		// ROLE_PERMISSIONS so the catalog-path export gates agree with the API ones.
		return permission === "read:project";
	}
	return false;
}

// Project-level READ permissions — the ONLY checks that stay allowed while the
// owning workspace is FROZEN (verified refund/chargeback or admin suspension).
// Everything else (update/generate:ai/comment/review/assignment/revision/import
// AND export — export writes artifacts + records billable usage) is a MUTATING
// project permission and is denied for EVERYONE (owner + members + chapter-team)
// while suspended. We match BOTH naming conventions in use across routes (colon
// `read:project` and underscore `read_project`) so no caller's spelling slips a
// mutating op past the freeze. An EMPTY permission (legacy unscoped check) is
// treated as read-equivalent and is NOT blocked here.
const READ_PROJECT_PERMISSIONS: ReadonlySet<string> = new Set<string>([
	"",
	"read:project",
	"read_project",
]);

/**
 * True when `permission` MUTATES project/workspace state and therefore must be
 * blocked while the owning workspace is frozen. Default-deny: anything that is not
 * an explicit read permission is treated as mutating. This is the single source of
 * truth for the catalog-path freeze gate, so adding a new mutating permission can
 * never accidentally bypass the freeze.
 */
export function isMutatingProjectPermission(permission: string | undefined): boolean {
	return !READ_PROJECT_PERMISSIONS.has((permission ?? "").trim());
}

function isFineGrainedProjectWideAccess(
	permission: string,
	scope: ReturnType<typeof normalizeScope>,
	check: WorkspaceScopeCheck,
): boolean {
	if (!["read:project", "update:project", "import:project", "generate:ai", "export:project"].includes(permission)) return false;
	// READ relaxation for OPERATIONAL scopes (review #598 P2, pairs with the
	// library-listing change): taskTypes/assetPurposes gate WHAT WORK a member
	// may perform, not WHICH PROJECTS they may look at — a cleaner scoped to
	// taskTypes:["clean"] must be able to OPEN the chapters the library now
	// lists for them. Structural scopes (chapterIds/pageIndexes) keep gating
	// reads, and every non-read permission still enforces task/asset scope.
	// The relaxation applies ONLY to generic project opens: a read that targets
	// a TASK or ASSET resource without proving its type/purpose stays gated —
	// otherwise scoped users could read task/asset resources outside their
	// scope by omitting the context (review #598 r2 P1).
	const genericProjectRead = permission === "read:project"
		&& check.resourceKind !== "task"
		&& check.resourceKind !== "asset";
	return (hasScopeList(scope.chapterIds) && check.chapterId === undefined)
		|| (hasScopeList(scope.pageIndexes) && check.pageIndex === undefined)
		|| (!genericProjectRead && hasScopeList(scope.taskTypes) && check.taskType === undefined && !canRelaxTaskTypeScopeForPageContext(permission, check))
		|| (!genericProjectRead && hasScopeList(scope.assetPurposes) && check.assetPurpose === undefined);
}

// Collaboration resources that are NOT task-typed: a comment, a chat message, or a
// review note attached to a PAGE. A `taskTypes` scope restriction (e.g. a cleaner
// scoped to `taskTypes:["clean"]`) gates which WORKFLOW TASKS a member may touch —
// it must NOT gate whether they can read/post these page-attached collaboration
// resources, which carry no task type at all. Page/chapter/language scope is still
// enforced (the relaxation only drops the task-type list, see
// relaxTaskTypeScopeForPageContext), so an out-of-scope page is still denied.
const TASK_TYPE_RELAXABLE_RESOURCE_KINDS = new Set(["comment", "message", "review"]);

function canRelaxTaskTypeScopeForPageContext(permission: string, check: WorkspaceScopeCheck): boolean {
	if (check.taskType !== undefined) return false;
	if (check.pageIndex === undefined && check.chapterId === undefined) return false;
	// Reads of any non-task resource in a page/chapter context relax the task-type
	// scope (legacy behaviour). WRITES (update:project) relax ONLY for the explicit
	// non-task collaboration resources above — a TASK write still requires a matching
	// task type, and an unspecified-resourceKind update is NOT relaxed.
	if (permission === "read:project") return check.resourceKind !== "task";
	if (permission === "update:project") {
		return check.resourceKind !== undefined && TASK_TYPE_RELAXABLE_RESOURCE_KINDS.has(check.resourceKind);
	}
	return false;
}

function relaxTaskTypeScopeForPageContext(
	permission: string,
	scope: ReturnType<typeof normalizeScope>,
	check: WorkspaceScopeCheck,
): ReturnType<typeof normalizeScope> {
	if (!hasScopeList(scope.taskTypes) || !canRelaxTaskTypeScopeForPageContext(permission, check)) return scope;
	return { ...scope, taskTypes: undefined };
}

function hasScopeList(value: unknown[] | undefined): boolean {
	return Array.isArray(value) && value.length > 0;
}

/**
 * A context that denies every access check. Used when a project has no resolvable
 * membership (caller is not a non-disabled member, or project/state missing).
 */
const DENIED_PROJECT_ACCESS_CONTEXT: ProjectAccessContext = {
	canAccessBaseline: false,
	allows: () => false,
};

/**
 * True for the shared singleton returned when a caller has NO access to a project
 * (no membership row, disabled member). `resolveProjectAccessContext` returns this
 * exact object (by reference) rather than `null` for a denied workspace member, so
 * routes that want to fall through to an ALTERNATE grant (e.g. a chapter-team
 * member who is not a workspace member) can distinguish a hard denial from a
 * scoped-but-present member context, instead of mis-treating a scoped member as
 * denied. A scoped member's context is a DIFFERENT object whose `allows()` honors
 * its scope.
 */
export function isProjectAccessFullyDenied(context: ProjectAccessContext | null): boolean {
	return context === DENIED_PROJECT_ACCESS_CONTEXT;
}

/**
 * A context that allows every access check. Used for personal (non-workspace)
 * projects where the resolved owner has unrestricted, unscoped access — matching
 * the personal-project branch of `canAccessProject`.
 */
const ALLOWED_PROJECT_ACCESS_CONTEXT: ProjectAccessContext = {
	canAccessBaseline: true,
	allows: () => true,
};

/**
 * Build the in-memory access evaluator for a workspace member whose role/scope
 * have already been resolved once. The returned `allows(check)` reproduces EXACTLY
 * the scope-evaluation tail of `canAccessProject` for a workspace project, so a
 * bulk caller gets identical per-task decisions without re-querying membership.
 *
 * `permission` and `role` are fixed for the whole context (one operation, one
 * caller). The per-task fields (pageIndex/taskType/language/resourceKind) flow in
 * through `check`. The default project language fallback is applied per check just
 * as the single-call path does (`input.language ?? defaultLanguage`).
 */
function buildWorkspaceProjectAccessContext(input: {
	role: string;
	scope: WorkspaceScope;
	permission: string;
	projectId: string;
	defaultLanguage: string | undefined;
	/**
	 * When true, the owning workspace is FROZEN (verified refund/chargeback or admin
	 * suspension). Every MUTATING project permission is denied for EVERYONE (owner +
	 * members), regardless of role/scope; READ permissions still pass. This is the
	 * CENTRAL freeze gate that covers every catalog-authorized mutating route.
	 */
	workspaceSuspended?: boolean;
}): ProjectAccessContext {
	const { role, scope, permission, projectId, defaultLanguage, workspaceSuspended } = input;
	const roleAllowsPermission = workspaceRoleCanProjectPermission(role, permission);
	const aiCreditAllows = permission !== "generate:ai" || scope.aiCreditPolicy !== "none";
	// FREEZE gate: a suspended workspace blocks every mutating permission for
	// everyone; reads pass. Applied to the baseline so canAccessProject() and the
	// bulk allows() evaluator are BOTH covered identically.
	const notFrozenForThisPermission = !(workspaceSuspended && isMutatingProjectPermission(permission));
	const baseline = roleAllowsPermission && aiCreditAllows && notFrozenForThisPermission;
	return {
		canAccessBaseline: baseline,
		allows(check: ResolvedProjectAccessCheck = {}): boolean {
			if (!baseline) return false;
			// A whole-project mutation (full ProjectState save / full version restore)
			// writes shared, non-language project state in addition to every language
			// track, so it demands TRULY project-wide (unscoped) access. A member with
			// ANY fine-grained scope restriction — including a `scope.languages` set
			// that currently covers every track — is NOT project-wide and is rejected
			// here, before the per-resource scope check. An unscoped owner/editor has
			// no restriction and passes unchanged.
			if (check.requireProjectWide && isFineGrainedScope(scope)) return false;
			const language = check.language ?? defaultLanguage ?? undefined;
			const scopeCheck: WorkspaceScopeCheck = {
				projectId,
				chapterId: check.chapterId,
				pageIndex: check.pageIndex,
				language,
				taskType: check.taskType,
				assetPurpose: check.assetPurpose,
				resourceKind: check.resourceKind,
			};
			const effectiveScope = relaxTaskTypeScopeForPageContext(permission, scope, scopeCheck);
			return !isFineGrainedProjectWideAccess(permission, scope, scopeCheck)
				&& (!hasScopeList(scope.languages) || language !== undefined)
				&& workspaceScopeAllows(effectiveScope, scopeCheck);
		},
	};
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
	if (Array.isArray(value)) {
		const values = value
			.map((item) => String(item).trim())
			.filter(Boolean);
		return values.length > 0 ? values : fallback;
	}
	if (typeof value === "string" && value.trim()) {
		const raw = value.trim();
		const values = raw.startsWith("{") && raw.endsWith("}")
			? raw.slice(1, -1).split(",")
			: raw.split(",");
		const parsed = values.map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
		return parsed.length > 0 ? parsed : fallback;
	}
	return fallback;
}

export function mergeProjectSummaries(
	catalogSummaries: ProjectSummary[],
	fileSummaries: ProjectSummary[],
	limit?: number,
): ProjectSummary[] {
	const merged = new Map<string, ProjectSummary>();
	for (const summary of fileSummaries) {
		merged.set(summary.projectId, normalizeProjectSummaryTimestamps(summary));
	}
	for (const summary of catalogSummaries) {
		merged.set(summary.projectId, normalizeProjectSummaryTimestamps(summary));
	}
	const sorted = [...merged.values()].sort(compareProjectSummaryOrder);
	return limit === undefined ? sorted : sorted.slice(0, normalizeListLimit(limit));
}

export function paginateProjectSummaries(
	summaries: ProjectSummary[],
	options: Pick<ProjectCatalogListOptions, "cursor" | "limit"> = {},
): ProjectSummaryPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectSummaryCursor(options.cursor);
	const sorted = summaries.map(normalizeProjectSummaryTimestamps).sort(compareProjectSummaryOrder);
	const filtered = cursor ? sorted.filter((summary) => projectSummarySortsAfterCursor(summary, cursor)) : sorted;
	const projects = filtered.slice(0, limit);
	const lastProject = projects[projects.length - 1];
	return {
		projects,
		nextCursor: filtered.length > limit && lastProject ? encodeProjectSummaryCursor(lastProject) : undefined,
	};
}

export function paginateProjectVersions(
	versions: ProjectVersionMetadata[],
	options: Pick<ProjectVersionListOptions, "cursor" | "limit"> = {},
): ProjectVersionPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectVersionCursor(options.cursor);
	const sorted = versions.map(normalizeProjectVersionTimestamp)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.versionId.localeCompare(a.versionId));
	const filtered = cursor ? sorted.filter((version) => projectVersionSortsAfterCursor(version, cursor)) : sorted;
	const pageVersions = filtered.slice(0, limit);
	const lastVersion = pageVersions[pageVersions.length - 1];
	return {
		versions: pageVersions,
		nextCursor: filtered.length > limit && lastVersion ? encodeProjectVersionCursor(lastVersion) : undefined,
	};
}

export function mergeProjectVersions(catalogVersions: ProjectVersionMetadata[], fileVersions: ProjectVersionMetadata[]): ProjectVersionMetadata[] {
	const mergedById = new Map<string, ProjectVersionMetadata>();
	for (const version of fileVersions.map(normalizeProjectVersionTimestamp)) mergedById.set(version.versionId, version);
	for (const version of catalogVersions.map(normalizeProjectVersionTimestamp)) mergedById.set(version.versionId, version);
	return [...mergedById.values()]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.versionId.localeCompare(a.versionId));
}

export function summarizeProjectPages(state: ProjectState): ProjectPageSummary[] {
	return state.pages.map((page, pageIndex) => ({
		projectId: state.projectId,
		pageId: pageIdFor(state.projectId, pageIndex),
		pageIndex,
		imageId: page.imageId,
		status: resolvePageStatus(page),
		revisionId: page.edits?.imageId,
		imageName: page.imageName,
		originalName: page.originalName,
		textLayerCount: page.textLayers?.length ?? 0,
		imageLayerCount: page.imageLayers?.length ?? 0,
		pendingAiJobCount: page.pendingAiJobs?.length ?? 0,
		createdAt: state.createdAt,
		updatedAt: page.qcHandoff?.updatedAt
			?? page.cleaningHandoff?.updatedAt
			?? page.translationHandoff?.updatedAt
			?? state.createdAt,
	}));
}

/**
 * Resolve the project's default target-language bucket key (Stream C, per-language
 * tracks). Lowercased to match the bucket key that `normalizeAiReviewMarkers` /
 * `createAiReviewMarker` apply to `AiReviewMarker.targetLang`, so a legacy marker
 * (no `targetLang`) and a marker explicitly tagged with the project default land in
 * the SAME bucket. Falls back to "th" to mirror `normalizeProjectStateTargetLangs`.
 */
export function resolveProjectDefaultLang(state: Pick<ProjectState, "targetLang" | "targetLangs">): string {
	const [first] = normalizeTargetLangs({
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
	return (first ?? "th").trim().toLowerCase() || "th";
}

/**
 * The bucket key for a single AI review marker: its own `targetLang` (already
 * normalized to lowercase by `normalizeAiReviewMarkers`) when present, otherwise the
 * project's default-language track. Legacy markers persisted before per-language
 * tracks therefore map to the default and never collide with an explicitly-tagged
 * marker for a different language.
 */
export function resolveAiReviewMarkerLang(
	marker: Pick<AiReviewMarker, "targetLang">,
	defaultLang: string,
): string {
	const lang = typeof marker.targetLang === "string" ? marker.targetLang.trim().toLowerCase() : "";
	return lang || defaultLang;
}

/**
 * Group the project's AI review markers into per-language buckets keyed by target
 * language. Two markers on the same page/region but different `targetLang` live in
 * distinct buckets (and never overwrite each other); legacy markers fold into the
 * project default. The grouping is read-only and preserves array order within a
 * bucket. Reuse `state.aiReviewMarkers` after `normalizeAiReviewMarkers` so bucket
 * keys are already lowercased.
 */
export function groupAiReviewMarkersByLang(state: ProjectState): Record<string, AiReviewMarker[]> {
	const defaultLang = resolveProjectDefaultLang(state);
	const buckets: Record<string, AiReviewMarker[]> = {};
	for (const marker of state.aiReviewMarkers ?? []) {
		const lang = resolveAiReviewMarkerLang(marker, defaultLang);
		(buckets[lang] ??= []).push(marker);
	}
	return buckets;
}

/**
 * Read the AI review markers belonging to one language bucket. An undefined/empty
 * `lang` (or a `lang` equal to the project default) returns the default-track markers
 * PLUS any legacy markers without an explicit `targetLang` — they share that bucket.
 */
export function aiReviewMarkersForLang(state: ProjectState, lang?: string): AiReviewMarker[] {
	const defaultLang = resolveProjectDefaultLang(state);
	const wanted = (typeof lang === "string" && lang.trim() ? lang.trim().toLowerCase() : defaultLang);
	return (state.aiReviewMarkers ?? []).filter((marker) => resolveAiReviewMarkerLang(marker, defaultLang) === wanted);
}

/**
 * Read the per-language output bucket for a page (Stream C). When the page has no
 * `languageOutputs` entry for the requested language (legacy/single-language pages,
 * or the project default track), the page's flat translation/typeset/QC fields are
 * returned as that language's output. Cleaning is intentionally NOT part of this
 * slice — the cleaned raster is shared across all target languages.
 */
export function pageLanguageOutput(
	page: PageState,
	lang: string,
	defaultLang: string,
): PageLanguageOutput {
	const wanted = lang.trim().toLowerCase() || defaultLang;
	const bucket = page.languageOutputs?.[wanted] ?? page.languageOutputs?.[lang];
	if (bucket) return bucket;
	// Default/legacy track: project's default language reads the flat page fields.
	if (wanted === defaultLang) {
		return {
			textLayers: Array.isArray(page.textLayers) ? page.textLayers : [],
			translationScriptSlots: page.translationScriptSlots,
			translationHandoff: page.translationHandoff,
			qcHandoff: page.qcHandoff,
		};
	}
	// A non-default language with no stored bucket has no output yet.
	return { textLayers: [] };
}

export function paginateProjectPages(
	pages: ProjectPageSummary[],
	options: Pick<ProjectPageListOptions, "cursor" | "limit" | "status" | "pageIndex"> = {},
): ProjectPageSummaryPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectPageCursor(options.cursor);
	const status = options.status?.trim();
	const pageIndex = typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex)
		? options.pageIndex
		: undefined;
	const sorted = [...pages]
		.filter((page) => !status || page.status === status)
		.filter((page) => pageIndex === undefined || page.pageIndex === pageIndex)
		.sort((a, b) => a.pageIndex - b.pageIndex);
	const filtered = cursor ? sorted.filter((page) => page.pageIndex > cursor.pageIndex) : sorted;
	const pageSummaries = filtered.slice(0, limit);
	const lastPage = pageSummaries[pageSummaries.length - 1];
	return {
		pages: pageSummaries,
		nextCursor: filtered.length > limit && lastPage ? encodeProjectPageCursor(lastPage) : undefined,
	};
}

export function mergeProjectPageSummaries(catalogPages: ProjectPageSummary[], filePages: ProjectPageSummary[]): ProjectPageSummary[] {
	const mergedByIndex = new Map<number, ProjectPageSummary>();
	for (const page of catalogPages) mergedByIndex.set(page.pageIndex, page);
	for (const page of filePages) mergedByIndex.set(page.pageIndex, page);
	return [...mergedByIndex.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

export function paginateProjectTasks(
	tasks: WorkflowTask[],
	options: Pick<ProjectTaskListOptions, "cursor" | "limit" | "status" | "type" | "assignee" | "pageIndex"> = {},
): ProjectTaskPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectTaskCursor(options.cursor);
	const status = options.status?.trim();
	const type = options.type?.trim();
	const assignee = normalizeAssigneeHandle(options.assignee);
	const pageIndex = typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex) ? options.pageIndex : undefined;
	const sorted = [...tasks]
		.filter((task) => !status || task.status === status)
		.filter((task) => !type || task.type === type)
		.filter((task) => !assignee || task.assignee === assignee)
		.filter((task) => pageIndex === undefined || task.pageIndex === pageIndex)
		.sort(compareProjectTaskOrder);
	const filtered = cursor ? sorted.filter((task) => projectTaskSortsAfterCursor(task, cursor)) : sorted;
	const pageTasks = filtered.slice(0, limit);
	const lastTask = pageTasks[pageTasks.length - 1];
	return {
		tasks: pageTasks,
		nextCursor: filtered.length > limit && lastTask ? encodeProjectTaskCursor(lastTask) : undefined,
	};
}

export function paginateProjectComments(
	comments: ProjectComment[],
	options: Pick<ProjectCommentListOptions, "cursor" | "limit" | "status" | "pageIndex" | "layerId" | "author"> = {},
): ProjectCommentPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectCommentCursor(options.cursor);
	const status = options.status?.trim();
	const layerId = options.layerId?.trim();
	const author = options.author?.trim();
	const pageIndex = typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex) ? options.pageIndex : undefined;
	const sorted = [...comments]
		.filter((comment) => !status || comment.status === status)
		.filter((comment) => pageIndex === undefined || comment.pageIndex === pageIndex)
		.filter((comment) => !layerId || comment.layerId === layerId)
		.filter((comment) => !author || comment.author === author)
		.sort(compareProjectCommentOrder);
	const filtered = cursor ? sorted.filter((comment) => projectCommentSortsAfterCursor(comment, cursor)) : sorted;
	const pageComments = filtered.slice(0, limit);
	const lastComment = pageComments[pageComments.length - 1];
	return {
		comments: pageComments,
		nextCursor: filtered.length > limit && lastComment ? encodeProjectCommentCursor(lastComment) : undefined,
	};
}

export function paginateProjectReviewDecisions(
	decisions: PageReviewDecision[],
	options: Pick<ProjectReviewDecisionListOptions, "cursor" | "limit" | "status" | "pageIndex" | "actor"> = {},
): ProjectReviewDecisionPage {
	const limit = normalizeListLimit(options.limit);
	const cursor = decodeProjectReviewDecisionCursor(options.cursor);
	const status = options.status?.trim();
	const actor = options.actor?.trim();
	const pageIndex = typeof options.pageIndex === "number" && Number.isInteger(options.pageIndex) ? options.pageIndex : undefined;
	const sorted = [...decisions]
		.filter((decision) => !status || decision.status === status)
		.filter((decision) => pageIndex === undefined || decision.pageIndex === pageIndex)
		.filter((decision) => !actor || decision.actor === actor)
		.sort(compareProjectReviewDecisionOrder);
	const filtered = cursor ? sorted.filter((decision) => projectReviewDecisionSortsAfterCursor(decision, cursor)) : sorted;
	const pageDecisions = filtered.slice(0, limit);
	const lastDecision = pageDecisions[pageDecisions.length - 1];
	return {
		decisions: pageDecisions,
		nextCursor: filtered.length > limit && lastDecision ? encodeProjectReviewDecisionCursor(lastDecision) : undefined,
	};
}

function emptyStoryIdOwnership(): StoryIdOwnership {
	return { exists: false, workspaceIds: [], ownerUserIds: [], hasOwnerlessPersonal: false };
}

/**
 * Build a {@link ProjectSummary} directly from an on-disk {@link ProjectState}.
 * Mirrors the per-file summary the project route already derives so the file
 * catalog store and the Postgres store agree on the summary shape.
 */
function buildProjectSummaryFromState(state: ProjectState, updatedAt: string): ProjectSummary {
	const targetLangs = normalizeTargetLangs({
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
	return {
		projectId: state.projectId,
		workspaceId: hasExplicitWorkspaceId(state) ? state.workspaceId : undefined,
		name: state.name,
		createdAt: state.createdAt,
		updatedAt,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterNumber: state.chapterNumber,
		chapterTitle: state.chapterTitle,
		chapterLabel: state.chapterLabel,
		readingDirection: state.readingDirection,
		...getProjectCoverSummary(state),
		sourceLang: state.sourceLang ?? "ja",
		targetLang: targetLangs[0] ?? "th",
		targetLangs,
		pageCount: state.pages.length,
		textLayerCount: countTextLayers(state),
		taskCount: state.tasks?.length ?? 0,
		openTaskCount: countOpenTasks(state),
		reviewTaskCount: countOpenReviewTasks(state),
		commentCount: state.comments?.length ?? 0,
		openCommentCount: countOpenComments(state),
	};
}

/**
 * File-backed {@link ProjectCatalogStore} for file-mode (no Postgres / no
 * DATABASE_URL). Mirrors the {@link FileWorkspaceAccessStore} fallback added in
 * PR #132 for workspace access: it implements the SAME interface so the route
 * layer keeps the Postgres store non-null and stops returning
 * `503 workspace_project_store_unavailable` when creating a project inside a
 * workspace.
 *
 * Project state and versions are already persisted to disk by the project route
 * (`writeProjectState` -> `PROJECTS_DIR/<id>/state.json`,
 * `PROJECTS_DIR/<id>/versions/<versionId>.json`). This store reads from those
 * files for all catalog queries; the Postgres-only catalog SYNC operations
 * (`upsertProjectState`, `recordProjectVersion`, `deleteProjectVersions`) are
 * therefore no-ops here -- the filesystem is the source of truth, the same way
 * the FileWorkspaceAccessStore treats Postgres-only invite mutations.
 *
 * Workspace membership/scope for access checks comes from the file-backed
 * {@link WorkspaceAccessStore}, so role- and language-scoped permissions match
 * the Postgres path.
 */
export class FileProjectCatalogStore implements ProjectCatalogStore {
	constructor(
		private readonly projectsDir: string = join(DATA_DIR, "projects"),
		private readonly accessStore: WorkspaceAccessStore = workspaceAccessStore,
	) {}

	// --- Postgres-only catalog sync: no-ops in file-mode (files are the source of truth). ---

	async upsertProjectState(): Promise<void> {
		// State is persisted to disk by the route's writeProjectState; nothing to mirror.
	}

	async recordProjectVersion(): Promise<void> {
		// Versions are persisted to disk by the route's createProjectVersion.
	}

	async deleteProjectVersions(): Promise<void> {
		// Version pruning unlinks the on-disk version files directly in the route.
	}

	async deleteProject(): Promise<void> {
		// The route removes the on-disk project tree (state, versions, assets); the
		// file catalog has no separate rows to drop.
	}

	async getProjectState(projectId: string): Promise<ProjectState | null> {
		return this.readState(projectId);
	}

	async getProjectTitlesByIds(projectIds: string[]): Promise<Map<string, string>> {
		// File mode is dev/self-host (small scale): resolve each name via readState.
		const result = new Map<string, string>();
		for (const projectId of projectIds) {
			const state = await this.readState(projectId);
			if (state?.name) result.set(projectId, state.name);
		}
		return result;
	}

	async resolveStoryIdOwnership(storyId: string): Promise<StoryIdOwnership> {
		const id = storyId.trim();
		const ownership = emptyStoryIdOwnership();
		if (!id) return ownership;
		const workspaceIds = new Set<string>();
		const ownerUserIds = new Set<string>();
		// UNCAPPED authoritative scan: every non-tombstoned project state on disk
		// (allProjectStates already funnels through readState's tombstone chokepoint),
		// across ALL owners/workspaces — NOT a caller-visible page — so a foreign
		// storyId can never slip past a scan cap.
		for (const { state } of this.allProjectStates()) {
			if (state.storyId !== id) continue;
			ownership.exists = true;
			if (hasExplicitWorkspaceId(state)) {
				workspaceIds.add(resolveWorkspaceId(state));
			} else if (state.userId) {
				ownerUserIds.add(state.userId);
			} else {
				ownership.hasOwnerlessPersonal = true;
			}
		}
		ownership.workspaceIds = [...workspaceIds];
		ownership.ownerUserIds = [...ownerUserIds];
		return ownership;
	}

	async findExistingProjectIds(projectIds: string[]): Promise<Set<string>> {
		const ids = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
		const existing = new Set<string>();
		for (const id of ids) {
			if (this.readState(id)) existing.add(id);
		}
		return existing;
	}

	async listProjectIdsForWorkspace(workspaceId: string): Promise<string[]> {
		const normalized = workspaceId.trim();
		if (!normalized) return [];
		return this.allProjectStates()
			.filter((entry) => resolveWorkspaceId(entry.state) === normalized)
			.map((entry) => entry.state.projectId)
			.sort((a, b) => a.localeCompare(b));
	}

	async listProjectSummaryPage(options: ProjectCatalogListOptions = {}): Promise<ProjectSummaryPage> {
		const userId = options.userId?.trim() || undefined;
		const workspaceId = options.workspaceId?.trim() || undefined;

		// When a workspace + page cap are given the source is BOUNDED like Postgres:
		// instead of reading & parsing EVERY project's state.json up front, we order
		// candidate dirs by their state.json mtime (a cheap stat, no JSON parse),
		// then read state lazily in that order and stop as soon as we have enough
		// matching, after-the-cursor summaries to fill the page. An empty/sparse
		// target workspace therefore never forces a full-disk scan + parse.
		// P1b: a GDPR export passes excludeOwnerlessPersonal so ownerless anonymous
		// legacy rows (state.userId unset) do NOT leak into the subject's bundle.
		const excludeOwnerlessPersonal = options.excludeOwnerlessPersonal === true;
		if (workspaceId) {
			return this.listWorkspaceSummaryPageBounded(workspaceId, userId, options);
		}

		const summaries: ProjectSummary[] = [];
		for (const entry of this.allProjectStates()) {
			if (!(await this.userCanSeeProjectSummary(entry.state, userId, excludeOwnerlessPersonal))) continue;
			summaries.push(buildProjectSummaryFromState(entry.state, entry.updatedAt));
		}
		return paginateProjectSummaries(summaries, { cursor: options.cursor, limit: options.limit });
	}

	/**
	 * Bounded, workspace-scoped summary page for file mode. Mirrors the Postgres
	 * `WHERE workspaceId = $` + `ORDER BY updated_at DESC, project_id DESC` +
	 * `LIMIT`: we sort candidates by the SAME key the final pagination uses
	 * (state.json mtime DESC, then projectId/dir DESC — the dir name IS the
	 * projectId), read state lazily in that order, and stop once we have
	 * `limit + 1` summaries that match the workspace, are visible to the user, and
	 * sort after the cursor. The `+ 1` lets `paginateProjectSummaries` decide
	 * `nextCursor` without us reading the rest of the disk.
	 */
	private async listWorkspaceSummaryPageBounded(
		workspaceId: string,
		userId: string | undefined,
		options: ProjectCatalogListOptions,
	): Promise<ProjectSummaryPage> {
		const cursor = decodeProjectSummaryCursor(options.cursor);
		const limit = normalizeListLimit(options.limit);
		// Candidate dirs ordered by the page's sort key — mtime DESC, projectId DESC —
		// using only a cheap stat per dir (no state.json parse yet).
		const candidates = this.candidateStatesByRecency();

		const collected: ProjectSummary[] = [];
		for (const candidate of candidates) {
			// We can stop once we hold enough post-cursor matches to fill the page AND
			// prove whether a next page exists: limit + 1. Because candidates are in
			// the final sort order, every later candidate sorts after these, so it can
			// only ever land beyond the page boundary we already have.
			if (collected.length > limit) break;
			const state = this.readState(candidate.projectId);
			if (!state) continue;
			// Workspace bound at the source — never inspect another workspace's data.
			if (resolveWorkspaceId(state) !== workspaceId) continue;
			if (!(await this.userCanSeeProjectSummary(state, userId, options.excludeOwnerlessPersonal === true))) continue;
			const summary = normalizeProjectSummaryTimestamps(
				buildProjectSummaryFromState(state, candidate.updatedAt),
			);
			// Skip rows the cursor has already paged past so the early-out counter only
			// reflects rows that can actually appear on (or just after) this page.
			if (cursor && !projectSummarySortsAfterCursor(summary, cursor)) continue;
			collected.push(summary);
		}

		// `collected` is already in final order and pre-filtered to post-cursor rows,
		// but reuse the canonical paginator so cursor/limit/nextCursor semantics stay
		// identical to the unbounded path.
		return paginateProjectSummaries(collected, { cursor: options.cursor, limit: options.limit });
	}

	/**
	 * Project dirs ordered the way a summary page is sorted (state.json mtime DESC,
	 * then projectId DESC), discovered with a cheap stat per dir — NO JSON parse.
	 * Lets the bounded workspace listing read full state for only the dirs it
	 * actually needs.
	 */
	private candidateStatesByRecency(): Array<{ projectId: string; updatedAt: string }> {
		if (!existsSync(this.projectsDir)) return [];
		const candidates: Array<{ projectId: string; updatedAt: string }> = [];
		for (const dir of readdirSync(this.projectsDir)) {
			if (!isValidProjectId(dir)) continue;
			const statePath = safePath(this.projectsDir, dir, "state.json");
			let updatedAt: string;
			try {
				updatedAt = statSync(statePath).mtime.toISOString();
			} catch {
				// No readable state.json => not a real project dir; skip without a parse.
				continue;
			}
			candidates.push({ projectId: dir, updatedAt: normalizeTimestampPrecision(updatedAt) });
		}
		return candidates.sort(
			(a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.projectId.localeCompare(a.projectId),
		);
	}

	async listProjectSummaries(options: ProjectCatalogListOptions = {}): Promise<ProjectSummary[]> {
		return (await this.listProjectSummaryPage(options)).projects;
	}

	async listProjectVersions(options: ProjectVersionListOptions): Promise<ProjectVersionPage> {
		const projectId = options.projectId.trim();
		// Tombstone guard: version files normally vanish with the project dir on
		// delete, but if a partial delete left them, a tombstoned id must still
		// serve no versions (consistent with readState's chokepoint).
		if (isProjectTombstonedIn(this.projectsDir, projectId)) return { versions: [] };
		const versions = this.readVersionMetadata(projectId);
		return paginateProjectVersions(versions, { cursor: options.cursor, limit: options.limit });
	}

	async getProjectVersion(projectId: string, versionId: string): Promise<ProjectVersionRecord | null> {
		const id = projectId.trim();
		const version = versionId.trim();
		if (!isValidProjectId(id) || !VERSION_FILE_ID_RE.test(version)) return null;
		if (isProjectTombstonedIn(this.projectsDir, id)) return null;
		const versionPath = safePath(this.projectsDir, id, "versions", `${version}.json`);
		if (!existsSync(versionPath)) return null;
		try {
			const raw = readJsonFile<{ metadata?: ProjectVersionMetadata; state?: ProjectState }>(versionPath);
			if (!raw.metadata || !raw.state) return null;
			return { metadata: raw.metadata, state: raw.state };
		} catch (error) {
			console.warn(`[FileProjectCatalogStore] Failed to read version ${version} for ${id}: ${error}`);
			return null;
		}
	}

	async listProjectPages(options: ProjectPageListOptions): Promise<ProjectPageSummaryPage> {
		const state = this.readState(options.projectId.trim());
		if (!state) return { pages: [] };
		return paginateProjectPages(summarizeProjectPages(state), {
			cursor: options.cursor,
			limit: options.limit,
			status: options.status,
			pageIndex: options.pageIndex,
		});
	}

	async listProjectTasks(options: ProjectTaskListOptions): Promise<ProjectTaskPage> {
		const state = this.readState(options.projectId.trim());
		if (!state) return { tasks: [] };
		return paginateProjectTasks(state.tasks ?? [], {
			cursor: options.cursor,
			limit: options.limit,
			status: options.status,
			type: options.type,
			assignee: options.assignee,
			pageIndex: options.pageIndex,
		});
	}

	async listProjectComments(options: ProjectCommentListOptions): Promise<ProjectCommentPage> {
		const state = this.readState(options.projectId.trim());
		if (!state) return { comments: [] };
		return paginateProjectComments(state.comments ?? [], {
			cursor: options.cursor,
			limit: options.limit,
			status: options.status,
			pageIndex: options.pageIndex,
			layerId: options.layerId,
			author: options.author,
		});
	}

	async listProjectReviewDecisions(options: ProjectReviewDecisionListOptions): Promise<ProjectReviewDecisionPage> {
		const state = this.readState(options.projectId.trim());
		if (!state) return { decisions: [] };
		return paginateProjectReviewDecisions(state.reviewDecisions ?? [], {
			cursor: options.cursor,
			limit: options.limit,
			status: options.status,
			pageIndex: options.pageIndex,
			actor: options.actor,
		});
	}

	async canAccessProject(input: ProjectAccessCheck): Promise<boolean> {
		const context = await this.resolveProjectAccessContext(input);
		if (!context) return false;
		return context.allows(input);
	}

	async resolveProjectAccessContext(input: {
		projectId: string;
		userId: string;
		permission: string;
	}): Promise<ProjectAccessContext | null> {
		const state = this.readState(input.projectId.trim());
		if (!state) return null;

		// Personal (no explicit workspaceId) projects: the owning user -- or any
		// caller in legacy anonymous file-mode (empty userId) -- can access without
		// scope restrictions.
		if (!hasExplicitWorkspaceId(state)) {
			const allowed = !state.userId || state.userId === input.userId;
			return allowed ? ALLOWED_PROJECT_ACCESS_CONTEXT : DENIED_PROJECT_ACCESS_CONTEXT;
		}

		// Single membership read — shared across every per-task check in a bulk op.
		const workspaceId = resolveWorkspaceId(state);
		const member = await this.accessStore.getMember(workspaceId, input.userId);
		if (!member || member.disabledAt) return DENIED_PROJECT_ACCESS_CONTEXT;

		// CENTRAL freeze gate (mirror of the Postgres store): a suspended workspace
		// denies every mutating permission for everyone; reads still pass.
		const workspace = await this.accessStore.getWorkspace(workspaceId);

		return buildWorkspaceProjectAccessContext({
			role: member.role,
			scope: normalizeScope(member.scope),
			permission: input.permission,
			projectId: input.projectId,
			defaultLanguage: state.targetLang ?? undefined,
			workspaceSuspended: Boolean(workspace?.suspendedAt),
		});
	}

	async getProjectWorkspacePlan(projectId: string): Promise<ProjectWorkspacePlan | null> {
		const state = this.readState(projectId.trim());
		if (!state || !hasExplicitWorkspaceId(state)) return null;
		const workspaceId = resolveWorkspaceId(state);
		const workspace = await this.accessStore.getWorkspace(workspaceId);
		if (!workspace) return null;
		return { projectId: state.projectId, workspaceId, planId: workspace.planId };
	}

	async getProjectWorkspaceStoragePlan(projectId: string): Promise<ProjectWorkspaceStoragePlan | null> {
		const state = this.readState(projectId.trim());
		if (!state || !hasExplicitWorkspaceId(state)) return null;
		const workspaceId = resolveWorkspaceId(state);
		const workspace = await this.accessStore.getWorkspace(workspaceId);
		if (!workspace) return null;
		const projectIds = await this.listProjectIdsForWorkspace(workspaceId);
		return {
			projectId: state.projectId,
			workspaceId,
			planId: workspace.planId,
			includedStorageBytes: workspace.storageIncludedBytes || undefined,
			extraStorageBytes: workspace.storageExtraBytes || 0,
			projectIds: projectIds.length > 0 ? projectIds : [state.projectId],
		};
	}

	async getWorkspaceStoragePlan(workspaceId: string): Promise<WorkspaceStoragePlan | null> {
		const normalizedWorkspaceId = workspaceId.trim();
		if (!normalizedWorkspaceId) return null;
		const workspace = await this.accessStore.getWorkspace(normalizedWorkspaceId);
		if (!workspace) return null;
		return {
			workspaceId: normalizedWorkspaceId,
			planId: workspace.planId,
			includedStorageBytes: workspace.storageIncludedBytes || undefined,
			extraStorageBytes: workspace.storageExtraBytes || 0,
		};
	}

	private readState(projectId: string): ProjectState | null {
		if (!isValidProjectId(projectId)) return null;
		// A permanently-deleted project must stay deleted everywhere the file catalog
		// surfaces it (single read, summary list, existence check), even if a stale
		// state.json survived a partial delete. Honor the deletion tombstone here, the
		// single chokepoint all file-catalog reads funnel through.
		if (isProjectTombstonedIn(this.projectsDir, projectId)) return null;
		const statePath = safePath(this.projectsDir, projectId, "state.json");
		if (!existsSync(statePath)) return null;
		try {
			return readJsonFile<ProjectState>(statePath);
		} catch (error) {
			console.warn(`[FileProjectCatalogStore] Failed to read state for ${projectId}: ${error}`);
			return null;
		}
	}

	private allProjectStates(): Array<{ state: ProjectState; updatedAt: string }> {
		if (!existsSync(this.projectsDir)) return [];
		const entries: Array<{ state: ProjectState; updatedAt: string }> = [];
		for (const dir of readdirSync(this.projectsDir)) {
			if (!isValidProjectId(dir)) continue;
			const state = this.readState(dir);
			if (!state) continue;
			const statePath = safePath(this.projectsDir, dir, "state.json");
			let updatedAt = state.createdAt;
			try {
				updatedAt = statSync(statePath).mtime.toISOString();
			} catch {
				/* fall back to createdAt */
			}
			entries.push({ state, updatedAt });
		}
		return entries;
	}

	private readVersionMetadata(projectId: string): ProjectVersionMetadata[] {
		if (!isValidProjectId(projectId)) return [];
		const versionsDir = safePath(this.projectsDir, projectId, "versions");
		if (!existsSync(versionsDir)) return [];
		const versions: ProjectVersionMetadata[] = [];
		for (const file of readdirSync(versionsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = readJsonFile<{ metadata?: ProjectVersionMetadata }>(safePath(versionsDir, file));
				if (raw.metadata?.versionId) versions.push(raw.metadata);
			} catch (error) {
				console.warn(`[FileProjectCatalogStore] Failed to read version file ${file} for ${projectId}: ${error}`);
			}
		}
		return versions;
	}

	/**
	 * Mirror of PostgresProjectCatalogStore.listProjectSummaryPage's visibility
	 * filter: personal projects belong to their owner (and anonymous file-mode);
	 * workspace projects are visible to non-disabled members whose scope (when set)
	 * covers the project id and the project's target language.
	 *
	 * `excludeOwnerlessPersonal` (P1b): when true, an ownerless anonymous personal
	 * project (`state.userId` unset) is NOT visible — only a personal project
	 * GENUINELY owned by `userId` is. Used by the GDPR export so a subject's bundle
	 * never leaks other people's legacy/imported ownerless projects.
	 */
	private async userCanSeeProjectSummary(
		state: ProjectState,
		userId: string | undefined,
		excludeOwnerlessPersonal = false,
	): Promise<boolean> {
		if (!hasExplicitWorkspaceId(state)) {
			if (!state.userId) return !excludeOwnerlessPersonal;
			return userId !== undefined && state.userId === userId;
		}
		if (!userId) return false;
		const member = await this.accessStore.getMember(resolveWorkspaceId(state), userId);
		if (!member || member.disabledAt) return false;
		const scope = normalizeScope(member.scope);
		return projectSummaryVisibleToScope(scope, state);
	}
}

/**
 * Summary-list scope gate matching the Postgres listProjectSummaryPage SQL:
 * a scoped member only sees projects covered by their projectIds/chapterIds
 * scope and, when a languages scope is set, projects whose target language is
 * in scope. taskTypes/assetPurposes intentionally do not narrow summary
 * visibility: they describe which work lanes/assets can be touched after the
 * chapter is opened. pageIndexes can ride along only after a project/chapter
 * scope has already bounded the catalog rows; page-only scope cannot surface a
 * whole-project summary safely.
 */
function projectSummaryVisibleToScope(scope: WorkspaceScope, state: ProjectState): boolean {
	if (hasScopeList(scope.projectIds) && !scope.projectIds!.includes(state.projectId)) return false;
	if (hasScopeList(scope.chapterIds) && !scope.chapterIds!.includes(state.projectId)) return false;
	const targetLangs = normalizeTargetLangs({ targetLang: state.targetLang, targetLangs: state.targetLangs });
	if (hasScopeList(scope.languages) && !targetLangs.some((language) => scope.languages!.includes(language))) return false;
	if (hasScopeList(scope.pageIndexes) && !hasScopeList(scope.projectIds) && !hasScopeList(scope.chapterIds)) return false;
	return true;
}

const VERSION_FILE_ID_RE = /^[0-9TZA-Za-z_-]+$/;

export function createProjectCatalogStore(): ProjectCatalogStore | null {
	if (serverConfig.projectCatalogStore === "postgres") return new PostgresProjectCatalogStore();
	if (serverConfig.projectCatalogStore === "file") return new FileProjectCatalogStore();
	return null;
}

export const projectCatalogStore = createProjectCatalogStore();


// Postgres caps a single statement at 65535 bind parameters. Each batched upsert
// below binds N columns per row (scalar placeholders — Bun's `unsafe` cannot bind
// array params, so the unnest($1::type[]) form is unavailable here), so the rows
// per statement must satisfy rows * columns <= 65535. We chunk well under that and
// also keep statements from growing pathologically large for a giant save. The
// widest table is project_tasks at 14 columns; 1000 rows * 14 = 14000 params, a
// safe margin. But rows are not fixed-width: a text[] column (e.g. comment/version
// mentions) binds one param PER element, so a single row with a huge mentions
// array — or many such rows — can blow the ceiling well before the row count cap.
// chunkRowsByParams therefore caps BOTH the row count AND the running param total.
// Each chunk is its own INSERT issued inside the same upsertProjectState
// transaction, so atomicity is preserved.
const UPSERT_CHUNK_SIZE = 1000;
// Safe per-statement bind-parameter budget, comfortably under Postgres' 65535
// ceiling to leave headroom for the conflict-target/SET clause (those use
// EXCLUDED, not binds, but we stay conservative).
const UPSERT_PARAM_BUDGET = 60_000;
// Max scalar binds per DELETE statement in deleteMissingRows (one id = one bind),
// kept under the 65535 ceiling. The DELETE prunes by the COMPLEMENT (ids present
// in the DB but absent from the active set), and each chunked DELETE is a real,
// independent statement, so the cap bounds total binds even for huge saves.
const DELETE_PARAM_BUDGET = 30_000;

function chunkRows<T>(rows: T[], size: number): T[][] {
	if (rows.length <= size) return [rows];
	const chunks: T[][] = [];
	for (let index = 0; index < rows.length; index += size) {
		chunks.push(rows.slice(index, index + size));
	}
	return chunks;
}

/**
 * Splits rows into chunks bounded by BOTH a row count cap and a bind-parameter
 * budget. `paramsFor(row)` returns the number of positional binds that row will
 * consume in the batched INSERT (fixed scalar columns + one per text[] element).
 * A new chunk starts before the running param total would exceed `paramBudget`,
 * or once the chunk hits `rowCap`. A single row that alone exceeds the budget
 * still lands in its own chunk (it cannot be split further; if it is genuinely
 * over Postgres' hard ceiling that is a data problem, not a chunking one).
 */
function chunkRowsByParams<T>(
	rows: T[],
	paramsFor: (row: T) => number,
	rowCap: number,
	paramBudget: number,
): T[][] {
	if (rows.length === 0) return [];
	const chunks: T[][] = [];
	let current: T[] = [];
	let currentParams = 0;
	for (const row of rows) {
		const rowParams = paramsFor(row);
		const wouldOverflow = current.length > 0 && (current.length >= rowCap || currentParams + rowParams > paramBudget);
		if (wouldOverflow) {
			chunks.push(current);
			current = [];
			currentParams = 0;
		}
		current.push(row);
		currentParams += rowParams;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Dedupes rows by a stable conflict key, keeping the LAST occurrence (matching
 * the old per-row INSERT loop's silent last-wins). A single multi-row INSERT ...
 * ON CONFLICT DO UPDATE throws "ON CONFLICT DO UPDATE command cannot affect row a
 * second time" if the same conflict key appears twice in one VALUES batch, so we
 * collapse duplicates before building the batch. Order of the surviving rows is
 * preserved by first appearance so chunk boundaries stay deterministic.
 */
function dedupeByConflictKey<T>(rows: T[], keyFor: (row: T) => string): T[] {
	const indexByKey = new Map<string, number>();
	const result: T[] = [];
	for (const row of rows) {
		const key = keyFor(row);
		const existing = indexByKey.get(key);
		if (existing === undefined) {
			indexByKey.set(key, result.length);
			result.push(row);
		} else {
			result[existing] = row; // last-wins, in the slot of first appearance
		}
	}
	return result;
}

/** Counts the positional binds a column list will consume (text[] = N binds). */
function countColumnParams(columns: ColumnValue[]): number {
	let total = 0;
	for (const column of columns) {
		total += column.kind === "textArray" ? column.values.length : 1;
	}
	return total;
}

// A column in a batched VALUES row. `scalar(value, cast?)` binds one positional
// parameter (Bun's `unsafe` only supports scalar binds). `textArray(values)`
// renders ARRAY[$a,$b,...]::text[] for a text[] column — one scalar bind per
// element — so a text[] (e.g. mentions) persists as a real array instead of
// routing through jsonb_array_elements_text on a scalar bind, which Bun's
// JSON-encoding of string params breaks.
type ColumnValue =
	| { kind: "scalar"; value: unknown; cast?: string }
	| { kind: "textArray"; values: string[] }
	| { kind: "intArray"; values: number[] };

function scalar(value: unknown, cast?: string): ColumnValue {
	return { kind: "scalar", value, cast };
}

function jsonbColumn(value: unknown): ColumnValue {
	// `::text::jsonb`, NOT `::jsonb`: Bun.SQL serializes a pre-stringified JS
	// string bound to a jsonb-typed placeholder as a jsonb STRING SCALAR
	// (double-encoded), so `column->>'key'` reads and jsonb indexes silently
	// miss. Binding as text first makes the ::jsonb cast PARSE the JSON
	// document, storing a real object. Migration 0085 heals rows written
	// before this fix.
	return { kind: "scalar", value: JSON.stringify(value), cast: "text::jsonb" };
}

function textArrayColumn(values: string[]): ColumnValue {
	return { kind: "textArray", values };
}

// Postgres integer[] column. Like textArrayColumn, binds each element as its OWN
// scalar param inside an ARRAY[...] literal — Bun.SQL.unsafe CANNOT bind a JS
// array param (it serializes `[1,2]` to the malformed literal `1,2`, not `{1,2}`),
// so a single `$1::integer[]` bind is a silent prod bug.
function intArrayColumn(values: number[]): ColumnValue {
	return { kind: "intArray", values: values.filter((value) => Number.isInteger(value)) };
}

/**
 * Builds the VALUES tuples for a multi-row INSERT plus the flattened bind list.
 * `columnsFor` returns the columns for one row, in INSERT column order. Each
 * scalar column consumes exactly one positional bind; a text[] column consumes
 * one bind per element. The persisted result matches the previous per-row
 * INSERTs — only the round-trip count changes (N statements collapse into 1).
 */
function buildMultiRowValues<T>(
	rows: T[],
	columnsFor: (row: T) => ColumnValue[],
): { clause: string; params: unknown[] } {
	const params: unknown[] = [];
	const bind = (value: unknown): string => {
		params.push(value);
		return `$${params.length}`;
	};
	const tuples = rows.map((row) => {
		const rendered = columnsFor(row).map((column) => {
			if (column.kind === "textArray") {
				if (column.values.length === 0) return "ARRAY[]::text[]";
				return `ARRAY[${column.values.map((value) => bind(value)).join(", ")}]::text[]`;
			}
			if (column.kind === "intArray") {
				if (column.values.length === 0) return "ARRAY[]::integer[]";
				return `ARRAY[${column.values.map((value) => bind(value)).join(", ")}]::integer[]`;
			}
			const placeholder = bind(column.value);
			return column.cast ? `${placeholder}::${column.cast}` : placeholder;
		});
		return `(${rendered.join(", ")})`;
	});
	return { clause: tuples.join(", "), params };
}

async function upsertProjectCatalogRows(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const targetLangs = normalizeProjectStateTargetLangs(state);
	const workspaceId = resolveWorkspaceId(state);
	const metadata = buildProjectMetadata(state);
	const explicitWorkspaceId = hasExplicitWorkspaceId(state);
	await client.unsafe(`
		INSERT INTO workspaces (workspace_id, name, plan_id, created_at, updated_at)
		VALUES ($1, $2, 'prototype', $3, $4)
		ON CONFLICT (workspace_id) DO UPDATE SET
			name = CASE WHEN $5::boolean THEN workspaces.name ELSE EXCLUDED.name END,
			updated_at = EXCLUDED.updated_at
	`, [
		workspaceId,
		resolveWorkspaceName(state),
		state.createdAt,
		updatedAt,
		explicitWorkspaceId,
	]);

	if (state.userId && !explicitWorkspaceId) {
		await client.unsafe(`
			INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, created_at, updated_at)
			VALUES ($1, $2, 'owner', 'owner', $3, $4)
			ON CONFLICT (workspace_id, user_id) DO UPDATE SET
				role = EXCLUDED.role,
				member_studio_role = EXCLUDED.member_studio_role,
				updated_at = EXCLUDED.updated_at
		`, [workspaceId, state.userId, state.createdAt, updatedAt]);
	}

	const insertProjectParams = buildInsertProjectParams(state, workspaceId, explicitWorkspaceId, metadata, updatedAt);
	await client.unsafe(`
		INSERT INTO projects (
			project_id,
			workspace_id,
			owner_user_id,
			title,
			source_locale,
			target_locale,
			target_locales,
			metadata,
			current_state,
			created_at,
			updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, ${pushArrayLiteral(insertProjectParams, targetLangs, "text")}, $7::text::jsonb, $8::text::jsonb, $9, $10)
		ON CONFLICT (project_id) DO UPDATE SET
			workspace_id = EXCLUDED.workspace_id,
			owner_user_id = EXCLUDED.owner_user_id,
			title = EXCLUDED.title,
			source_locale = EXCLUDED.source_locale,
			target_locale = EXCLUDED.target_locale,
			target_locales = EXCLUDED.target_locales,
			metadata = EXCLUDED.metadata,
			current_state = EXCLUDED.current_state,
			updated_at = EXCLUDED.updated_at,
			deleted_at = NULL
	`, insertProjectParams);
}

function buildInsertProjectParams(state: ProjectState, workspaceId: string, explicitWorkspaceId: boolean, metadata: Record<string, unknown>, updatedAt: string): unknown[] {
	return [
		state.projectId,
		workspaceId,
		explicitWorkspaceId ? null : state.userId || null,
		state.name,
		state.sourceLang || "ja",
		state.targetLang || null,
		JSON.stringify(metadata),
		JSON.stringify(state),
		state.createdAt,
		updatedAt,
	];
}

async function syncProjectPages(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	await deleteMissingRows(client, "project_pages", "page_index", state.projectId, state.pages.map((_, index) => index));
	if (state.pages.length === 0) return;
	const allRows = state.pages.map((page, pageIndex) => ({ page, pageIndex }));
	// page_index is the in-array position so it is inherently unique; dedupe is a
	// no-op here but keeps every sync function consistent and guards against a
	// future caller passing pre-built rows. Conflict key: (project_id, page_index).
	const rows = dedupeByConflictKey(allRows, ({ pageIndex }) => String(pageIndex));
	const columnsFor = ({ page, pageIndex }: { page: typeof state.pages[number]; pageIndex: number }): ColumnValue[] => [
		scalar(pageIdFor(state.projectId, pageIndex)),
		scalar(state.projectId),
		scalar(pageIndex),
		scalar(page.imageId),
		scalar(resolvePageStatus(page)),
		scalar(page.edits?.imageId ?? null),
		jsonbColumn({
			imageName: page.imageName,
			originalName: page.originalName,
			textLayerCount: page.textLayers?.length ?? 0,
			imageLayerCount: page.imageLayers?.length ?? 0,
			pendingAiJobCount: page.pendingAiJobs?.length ?? 0,
			translationHandoff: page.translationHandoff,
			cleaningHandoff: page.cleaningHandoff,
			qcHandoff: page.qcHandoff,
		}),
		scalar(state.createdAt),
		scalar(updatedAt),
	];
	const chunks = chunkRowsByParams(rows, (row) => countColumnParams(columnsFor(row)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		// One multi-row INSERT per chunk: O(1) round-trips per table per save instead
		// of one per row (was the worst write amplifier on every 5s autosave).
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_pages (
				page_id,
				project_id,
				page_index,
				image_id,
				status,
				revision_id,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, page_index) DO UPDATE SET
				image_id = EXCLUDED.image_id,
				status = EXCLUDED.status,
				revision_id = EXCLUDED.revision_id,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectTasks(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const tasks = dedupeByConflictKey(state.tasks ?? [], (task) => task.id);
	await deleteMissingRows(client, "project_tasks", "task_id", state.projectId, tasks.map((task) => task.id));
	if (tasks.length === 0) return;
	const columnsFor = (task: typeof tasks[number]): ColumnValue[] => [
		scalar(task.id),
		scalar(state.projectId),
		scalar(pageIdForOptional(state, task.pageIndex)),
		scalar(task.pageIndex),
		scalar(task.type),
		scalar(task.status),
		scalar(task.priority),
		scalar(task.title),
		scalar(task.assignee ?? null),
		scalar(task.layerId ?? null),
		scalar(task.dueAt ?? null),
		jsonbColumn(task),
		scalar(task.createdAt),
		scalar(task.updatedAt || updatedAt),
	];
	const chunks = chunkRowsByParams(tasks, (task) => countColumnParams(columnsFor(task)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_tasks (
				task_id,
				project_id,
				page_id,
				page_index,
				type,
				status,
				priority,
				title,
				assignee_user_id,
				layer_id,
				due_at,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, task_id) DO UPDATE SET
				page_id = EXCLUDED.page_id,
				page_index = EXCLUDED.page_index,
				type = EXCLUDED.type,
				status = EXCLUDED.status,
				priority = EXCLUDED.priority,
				title = EXCLUDED.title,
				assignee_user_id = EXCLUDED.assignee_user_id,
				layer_id = EXCLUDED.layer_id,
				due_at = EXCLUDED.due_at,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectComments(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const comments = dedupeByConflictKey(state.comments ?? [], (comment) => comment.id);
	await deleteMissingRows(client, "project_comments", "comment_id", state.projectId, comments.map((comment) => comment.id));
	if (comments.length === 0) return;
	const columnsFor = (comment: typeof comments[number]): ColumnValue[] => [
		scalar(comment.id),
		scalar(state.projectId),
		scalar(pageIdForOptional(state, comment.pageIndex)),
		scalar(comment.pageIndex),
		scalar(comment.layerId ?? null),
		scalar(comment.status),
		scalar(comment.body),
		scalar(comment.author || null),
		textArrayColumn(comment.mentions ?? []),
		jsonbColumn(comment.region ?? null),
		jsonbColumn(comment),
		scalar(comment.createdAt),
		scalar(comment.updatedAt || updatedAt),
	];
	const chunks = chunkRowsByParams(comments, (comment) => countColumnParams(columnsFor(comment)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_comments (
				comment_id,
				project_id,
				page_id,
				page_index,
				layer_id,
				status,
				body,
				author_user_id,
				mentions,
				region,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, comment_id) DO UPDATE SET
				page_id = EXCLUDED.page_id,
				page_index = EXCLUDED.page_index,
				layer_id = EXCLUDED.layer_id,
				status = EXCLUDED.status,
				body = EXCLUDED.body,
				author_user_id = EXCLUDED.author_user_id,
				mentions = EXCLUDED.mentions,
				region = EXCLUDED.region,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectReviewDecisions(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const decisions = dedupeByConflictKey(state.reviewDecisions ?? [], (decision) => decision.id);
	await deleteMissingRows(client, "project_review_decisions", "review_decision_id", state.projectId, decisions.map((decision) => decision.id));
	if (decisions.length === 0) return;
	const columnsFor = (decision: typeof decisions[number]): ColumnValue[] => [
		scalar(decision.id),
		scalar(state.projectId),
		scalar(pageIdForOptional(state, decision.pageIndex)),
		scalar(decision.pageIndex),
		scalar(decision.status),
		scalar(decision.body ?? null),
		scalar(decision.actor || null),
		jsonbColumn(decision),
		scalar(decision.createdAt),
		scalar(decision.updatedAt || updatedAt),
	];
	const chunks = chunkRowsByParams(decisions, (decision) => countColumnParams(columnsFor(decision)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_review_decisions (
				review_decision_id,
				project_id,
				page_id,
				page_index,
				status,
				body,
				actor_user_id,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, review_decision_id) DO UPDATE SET
				page_id = EXCLUDED.page_id,
				page_index = EXCLUDED.page_index,
				status = EXCLUDED.status,
				body = EXCLUDED.body,
				actor_user_id = EXCLUDED.actor_user_id,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectReviewAssignments(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const assignments = dedupeByConflictKey(state.reviewAssignments ?? [], (assignment) => assignment.id);
	await deleteMissingRows(client, "project_review_assignments", "assignment_id", state.projectId, assignments.map((assignment) => assignment.id));
	if (assignments.length === 0) return;
	const columnsFor = (assignment: typeof assignments[number]): ColumnValue[] => [
		scalar(assignment.id),
		scalar(state.projectId),
		scalar(assignment.assigneeUserId),
		scalar(assignment.assigneeHandle ?? null),
		scalar(assignment.targetLang ?? null),
		intArrayColumn(assignment.pageIndexes ?? []),
		scalar(assignment.status),
		scalar(assignment.priority ?? null),
		scalar(assignment.assignedBy || null),
		scalar(assignment.dueAt ?? null),
		scalar(assignment.instructions ?? null),
		scalar(assignment.cancelReason ?? null),
		scalar(assignment.cancelledBy ?? null),
		scalar(assignment.cancelledAt ?? null),
		jsonbColumn(assignment),
		scalar(assignment.createdAt),
		scalar(assignment.updatedAt || updatedAt),
	];
	const chunks = chunkRowsByParams(assignments, (assignment) => countColumnParams(columnsFor(assignment)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_review_assignments (
				assignment_id,
				project_id,
				assignee_user_id,
				assignee_handle,
				target_lang,
				page_indexes,
				status,
				priority,
				assigned_by,
				due_at,
				instructions,
				cancel_reason,
				cancelled_by,
				cancelled_at,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, assignment_id) DO UPDATE SET
				assignee_user_id = EXCLUDED.assignee_user_id,
				assignee_handle = EXCLUDED.assignee_handle,
				target_lang = EXCLUDED.target_lang,
				page_indexes = EXCLUDED.page_indexes,
				status = EXCLUDED.status,
				priority = EXCLUDED.priority,
				assigned_by = EXCLUDED.assigned_by,
				due_at = EXCLUDED.due_at,
				instructions = EXCLUDED.instructions,
				cancel_reason = EXCLUDED.cancel_reason,
				cancelled_by = EXCLUDED.cancelled_by,
				cancelled_at = EXCLUDED.cancelled_at,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectRevisionRequests(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	const revisions = dedupeByConflictKey(state.revisionRequests ?? [], (revision) => revision.id);
	await deleteMissingRows(client, "project_revision_requests", "revision_id", state.projectId, revisions.map((revision) => revision.id));
	if (revisions.length === 0) return;
	const columnsFor = (revision: typeof revisions[number]): ColumnValue[] => [
		scalar(revision.id),
		scalar(state.projectId),
		scalar(revision.revisionNumber),
		scalar(revision.assignedToUserId),
		scalar(revision.assignedToHandle ?? null),
		scalar(revision.reason),
		scalar(revision.requestedBy || null),
		scalar(revision.targetLang ?? null),
		intArrayColumn(revision.pageIndexes ?? []),
		scalar(revision.sourceReviewDecisionId ?? null),
		scalar(revision.status),
		scalar(revision.priority ?? null),
		scalar(revision.dueAt ?? null),
		scalar(revision.resolvedBy ?? null),
		scalar(revision.resolvedAt ?? null),
		jsonbColumn(revision),
		scalar(revision.createdAt),
		scalar(revision.updatedAt || updatedAt),
	];
	const chunks = chunkRowsByParams(revisions, (revision) => countColumnParams(columnsFor(revision)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_revision_requests (
				revision_id,
				project_id,
				revision_number,
				assigned_to_user_id,
				assigned_to_handle,
				reason,
				requested_by,
				target_lang,
				page_indexes,
				source_review_decision_id,
				status,
				priority,
				due_at,
				resolved_by,
				resolved_at,
				metadata,
				created_at,
				updated_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, revision_id) DO UPDATE SET
				revision_number = EXCLUDED.revision_number,
				assigned_to_user_id = EXCLUDED.assigned_to_user_id,
				assigned_to_handle = EXCLUDED.assigned_to_handle,
				reason = EXCLUDED.reason,
				requested_by = EXCLUDED.requested_by,
				target_lang = EXCLUDED.target_lang,
				page_indexes = EXCLUDED.page_indexes,
				source_review_decision_id = EXCLUDED.source_review_decision_id,
				status = EXCLUDED.status,
				priority = EXCLUDED.priority,
				due_at = EXCLUDED.due_at,
				resolved_by = EXCLUDED.resolved_by,
				resolved_at = EXCLUDED.resolved_at,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, params);
	}
}

async function syncProjectVersionReviews(client: ProjectCatalogSqlClient, state: ProjectState, updatedAt: string): Promise<void> {
	// Conflict key is (project_id, version_review_id) = review.id, NOT version_id.
	const reviews = dedupeByConflictKey(state.versionReviewRequests ?? [], (review) => review.id);
	await deleteMissingRows(client, "project_version_reviews", "version_review_id", state.projectId, reviews.map((review) => review.id));
	if (reviews.length === 0) return;
	const columnsFor = (review: typeof reviews[number]): ColumnValue[] => [
		scalar(review.id),
		scalar(review.versionId),
		scalar(state.projectId),
		scalar(review.status),
		scalar(review.body ?? null),
		scalar(review.requester || null),
		scalar(review.reviewer ?? null),
		textArrayColumn(review.mentions ?? []),
		jsonbColumn(review),
		scalar(review.createdAt),
		scalar(review.updatedAt || updatedAt),
		scalar(review.decidedAt ?? null),
	];
	const chunks = chunkRowsByParams(reviews, (review) => countColumnParams(columnsFor(review)), UPSERT_CHUNK_SIZE, UPSERT_PARAM_BUDGET);
	for (const chunk of chunks) {
		const { clause, params } = buildMultiRowValues(chunk, columnsFor);
		await client.unsafe(`
			INSERT INTO project_version_reviews (
				version_review_id,
				version_id,
				project_id,
				status,
				body,
				requester_user_id,
				reviewer_user_id,
				mentions,
				metadata,
				created_at,
				updated_at,
				decided_at
			)
			VALUES ${clause}
			ON CONFLICT (project_id, version_review_id) DO UPDATE SET
				version_id = EXCLUDED.version_id,
				status = EXCLUDED.status,
				body = EXCLUDED.body,
				requester_user_id = EXCLUDED.requester_user_id,
				reviewer_user_id = EXCLUDED.reviewer_user_id,
				mentions = EXCLUDED.mentions,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at,
				decided_at = EXCLUDED.decided_at
		`, params);
	}
}

async function deleteMissingRows(
	client: ProjectCatalogSqlClient,
	tableName: string,
	idColumn: string,
	projectId: string,
	activeIds: Array<string | number>,
): Promise<void> {
	if (activeIds.length === 0) {
		await client.unsafe(`DELETE FROM ${tableName} WHERE project_id = $1`, [projectId]);
		return;
	}
	// Prune rows whose id is NOT in the active set. A naive NOT IN over the whole
	// active set is unbounded: with >65k active ids the single statement exceeds
	// Postgres' 65535 bind-parameter ceiling. A multi-statement NOT IN cannot be
	// split safely either — "DELETE NOT IN chunk1" then "DELETE NOT IN chunk2"
	// deletes rows that ARE in chunk2 during the first pass (the intersection
	// trap). So we delete by the COMPLEMENT instead: read the project's existing
	// ids, compute in memory which of them are absent from the active set, and
	// DELETE exactly those by id list, chunked by bind count. This preserves the
	// exact "delete the rows no longer present" semantics, is bounded regardless of
	// active-set size, and stays inside the surrounding transaction. Bun's `unsafe`
	// cannot bind array params (it serialises a JS array into a malformed literal),
	// so we keep scalar placeholders.
	const activeKeys = new Set(activeIds.map((id) => String(id)));
	const existing = await client.unsafe<Record<string, string | number>>(
		`SELECT ${idColumn} AS id FROM ${tableName} WHERE project_id = $1`,
		[projectId],
	);
	const staleIds = existing
		.map((row) => row.id)
		.filter((id) => !activeKeys.has(String(id)));
	if (staleIds.length === 0) return;
	for (const idChunk of chunkRows(staleIds, DELETE_PARAM_BUDGET)) {
		const params: unknown[] = [projectId];
		const placeholders = idChunk.map((id) => {
			params.push(id);
			return `$${params.length}`;
		});
		await client.unsafe(
			`DELETE FROM ${tableName} WHERE project_id = $1 AND ${idColumn} IN (${placeholders.join(", ")})`,
			params,
		);
	}
}

function buildProjectMetadata(state: ProjectState): Record<string, unknown> {
	const targetLangs = normalizeTargetLangs({ targetLang: state.targetLang, targetLangs: state.targetLangs });
	return {
		workspaceId: state.workspaceId,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterNumber: state.chapterNumber,
		chapterTitle: state.chapterTitle,
		chapterLabel: state.chapterLabel,
		readingDirection: state.readingDirection,
		...getProjectCoverSummary(state),
		sourceLang: state.sourceLang || "ja",
		targetLang: targetLangs[0] ?? "th",
		targetLangs,
		currentPage: state.currentPage,
		pageCount: state.pages.length,
		textLayerCount: countTextLayers(state),
		taskCount: state.tasks?.length ?? 0,
		openTaskCount: countOpenTasks(state),
		reviewTaskCount: countOpenReviewTasks(state),
		commentCount: state.comments?.length ?? 0,
		openCommentCount: countOpenComments(state),
		aiReviewMarkerCount: state.aiReviewMarkers?.length ?? 0,
		versionReviewRequestCount: state.versionReviewRequests?.length ?? 0,
		exportRunCount: state.exportRuns?.length ?? 0,
		productionMode: state.productionMode,
		creditPolicy: state.creditPolicy,
	};
}

function mapProjectSummaryRow(row: ProjectSummaryRow): ProjectSummary {
	const metadata = normalizeRecord(row.metadata);
	const targetLangs = normalizeTargetLangs({
		targetLang: readOptionalString(row.target_locale) ?? readOptionalString(metadata.targetLang),
		targetLangs: toStringArray(row.target_locales, toStringArray(metadata.targetLangs, [])),
	});
	return {
		projectId: row.project_id,
		workspaceId: readOptionalString(row.workspace_id),
		name: row.title,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
		storyId: readOptionalString(metadata.storyId),
		storyTitle: readOptionalString(metadata.storyTitle),
		chapterNumber: readOptionalString(metadata.chapterNumber),
		chapterTitle: readOptionalString(metadata.chapterTitle),
		chapterLabel: readOptionalString(metadata.chapterLabel),
		readingDirection: readReadingDirection(metadata.readingDirection),
		coverImageId: readOptionalString(metadata.coverImageId),
		coverOriginalName: readOptionalString(metadata.coverOriginalName),
		sourceLang: readOptionalString(row.source_locale) ?? readOptionalString(metadata.sourceLang) ?? "ja",
		targetLang: targetLangs[0] ?? "th",
		targetLangs,
		pageCount: readOptionalNumber(metadata.pageCount),
		textLayerCount: readOptionalNumber(metadata.textLayerCount),
		taskCount: readOptionalNumber(metadata.taskCount),
		openTaskCount: readOptionalNumber(metadata.openTaskCount),
		reviewTaskCount: readOptionalNumber(metadata.reviewTaskCount),
		commentCount: readOptionalNumber(metadata.commentCount),
		openCommentCount: readOptionalNumber(metadata.openCommentCount),
	};
}

function mapProjectPageRow(row: ProjectPageRow): ProjectPageSummary {
	const metadata = normalizeRecord(row.metadata);
	return {
		projectId: row.project_id,
		pageId: row.page_id,
		pageIndex: row.page_index,
		imageId: readOptionalString(row.image_id),
		status: row.status,
		revisionId: readOptionalString(row.revision_id),
		imageName: readOptionalString(metadata.imageName),
		originalName: readOptionalString(metadata.originalName),
		textLayerCount: readOptionalNumber(metadata.textLayerCount),
		imageLayerCount: readOptionalNumber(metadata.imageLayerCount),
		pendingAiJobCount: readOptionalNumber(metadata.pendingAiJobCount),
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function mapProjectTaskRow(row: ProjectTaskRow): WorkflowTask {
	const metadata = normalizeRecord(row.metadata);
	return {
		id: readOptionalString(metadata.id) ?? row.task_id,
		type: readWorkflowTaskType(row.type) ?? readWorkflowTaskType(metadata.type) ?? "translate",
		status: readWorkflowTaskStatus(row.status) ?? readWorkflowTaskStatus(metadata.status) ?? "todo",
		priority: readWorkflowTaskPriority(row.priority) ?? readWorkflowTaskPriority(metadata.priority) ?? "normal",
		pageIndex: row.page_index,
		pageImageId: readOptionalString(metadata.pageImageId),
		layerId: readOptionalString(row.layer_id) ?? readOptionalString(metadata.layerId),
		title: row.title,
		assignee: normalizeAssigneeHandle(readOptionalString(row.assignee_user_id) ?? readOptionalString(metadata.assignee)),
		dueAt: toOptionalIsoString(row.due_at) ?? readOptionalString(metadata.dueAt),
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function mapProjectCommentRow(row: ProjectCommentRow): ProjectComment {
	const metadata = normalizeRecord(row.metadata);
	const rowMentions = readStringArray(row.mentions);
	const annotation = readReviewAnnotation(metadata.annotation);
	return {
		id: readOptionalString(metadata.id) ?? row.comment_id,
		pageIndex: row.page_index,
		layerId: readOptionalString(row.layer_id) ?? readOptionalString(metadata.layerId),
		region: readCommentRegion(row.region) ?? readCommentRegion(metadata.region),
		...(annotation ? { annotation } : {}),
		body: row.body,
		author: readOptionalString(row.author_user_id) ?? readOptionalString(metadata.author) ?? "local-user",
		mentions: rowMentions.length > 0 ? rowMentions : readStringArray(metadata.mentions),
		status: readProjectCommentStatus(row.status) ?? readProjectCommentStatus(metadata.status) ?? "open",
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function mapProjectReviewDecisionRow(row: ProjectReviewDecisionRow): PageReviewDecision {
	const metadata = normalizeRecord(row.metadata);
	return {
		id: readOptionalString(metadata.id) ?? row.review_decision_id,
		pageIndex: row.page_index,
		status: readPageReviewDecisionStatus(row.status) ?? readPageReviewDecisionStatus(metadata.status) ?? "changes_requested",
		body: readOptionalString(row.body) ?? readOptionalString(metadata.body),
		actor: readOptionalString(row.actor_user_id) ?? readOptionalString(metadata.actor) ?? "local-user",
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function mapProjectVersionRow(row: ProjectVersionRow): ProjectVersionMetadata {
	const metadata = normalizeRecord(row.metadata);
	return {
		versionId: readOptionalString(metadata.versionId) ?? row.version_id,
		projectId: readOptionalString(metadata.projectId) ?? row.project_id,
		name: readOptionalString(metadata.name) ?? row.name,
		storyId: readOptionalString(metadata.storyId),
		storyTitle: readOptionalString(metadata.storyTitle),
		chapterNumber: readOptionalString(metadata.chapterNumber),
		chapterTitle: readOptionalString(metadata.chapterTitle),
		chapterLabel: readOptionalString(metadata.chapterLabel),
		source: readProjectVersionSource(metadata.source) ?? readProjectVersionSource(row.source) ?? "save",
		label: readOptionalString(metadata.label),
		author: readOptionalString(metadata.author),
		createdAt: normalizeTimestampPrecision(readOptionalString(metadata.createdAt) ?? toIsoString(row.created_at)),
		pageCount: readOptionalNumber(metadata.pageCount) || readOptionalNumber(row.page_count),
		textLayerCount: readOptionalNumber(metadata.textLayerCount) || readOptionalNumber(row.text_layer_count),
		stateHash: readOptionalString(metadata.stateHash) ?? readOptionalString(row.state_hash),
	};
}

function mapProjectVersionRecordRow(row: ProjectVersionRow): ProjectVersionRecord | null {
	const state = parseProjectCurrentState(row.state);
	if (!state) return null;
	return {
		metadata: mapProjectVersionRow(row),
		state,
	};
}

function readProjectVersionSource(value: unknown): ProjectVersionMetadata["source"] | undefined {
	return value === "save" || value === "import-json" || value === "restore" || value === "manual" ? value : undefined;
}

function resolveWorkspaceId(state: ProjectState): string {
	if (state.workspaceId?.trim()) return state.workspaceId.trim();
	return state.userId ? `personal:${state.userId}` : `project:${state.projectId}`;
}

function hasExplicitWorkspaceId(state: ProjectState): boolean {
	return Boolean(state.workspaceId?.trim());
}

function resolveWorkspaceName(state: ProjectState): string {
	if (state.storyTitle) return state.storyTitle;
	return state.name ? `${state.name} workspace` : `Project ${state.projectId.slice(0, 8)}`;
}

function pageIdFor(projectId: string, pageIndex: number): string {
	return `${projectId}:page:${pageIndex}`;
}

function pageIdForOptional(state: ProjectState, pageIndex: number): string | null {
	return state.pages[pageIndex] ? pageIdFor(state.projectId, pageIndex) : null;
}

function resolvePageStatus(page: ProjectState["pages"][number]): string {
	if (page.qcHandoff?.status === "ready") return "review_ready";
	if (page.qcHandoff?.status === "needs_fix") return "needs_fix";
	if (page.cleaningHandoff?.status === "needs_clean") return "needs_clean";
	if (page.cleaningHandoff?.status === "clean_ready") return "cleaned";
	if (page.translationHandoff?.status === "needs_translation") return "needs_translation";
	if (page.translationHandoff?.status === "translated") return "translated";
	return "draft";
}

function getProjectCoverSummary(state: ProjectState): Pick<ProjectSummary, "coverImageId" | "coverOriginalName"> {
	const firstPage = state.pages[0];
	const coverImageId = state.coverImageId ?? firstPage?.edits?.imageId ?? firstPage?.imageId;
	const coverOriginalName = state.coverOriginalName ?? firstPage?.originalName;
	return coverImageId ? { coverImageId, coverOriginalName } : {};
}

function countTextLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.textLayers?.length ?? 0), 0);
}

function countOpenTasks(state: ProjectState): number {
	return (state.tasks ?? []).filter((task: WorkflowTask) => task.status !== "done").length;
}

function countOpenReviewTasks(state: ProjectState): number {
	return (state.tasks ?? []).filter((task: WorkflowTask) => task.type === "review" && task.status !== "done").length;
}

function countOpenComments(state: ProjectState): number {
	return (state.comments ?? []).filter((comment: ProjectComment) => comment.status !== "resolved").length;
}

function normalizeListLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(500, Math.trunc(limit)));
}

function normalizeRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			return normalizeRecord(JSON.parse(value));
		} catch {
			return {};
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function parseProjectCurrentState(value: unknown): ProjectState | null {
	const candidate = typeof value === "string" ? parseJsonRecord(value) : normalizeRecord(value);
	if (
		typeof candidate.projectId === "string"
		&& typeof candidate.userId === "string"
		&& typeof candidate.name === "string"
		&& typeof candidate.createdAt === "string"
		&& Array.isArray(candidate.pages)
		&& typeof candidate.currentPage === "number"
		&& typeof candidate.targetLang === "string"
	) {
		return candidate as unknown as ProjectState;
	}
	return null;
}

function parseJsonRecord(value: string): Record<string, unknown> {
	try {
		return normalizeRecord(JSON.parse(value));
	} catch {
		return {};
	}
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function readReadingDirection(value: unknown): ReadingDirection | undefined {
	return value === "rtl" || value === "ltr" || value === "vertical" ? value : undefined;
}

function readOptionalNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readWorkflowTaskType(value: unknown): WorkflowTask["type"] | undefined {
	return value === "translate" || value === "clean" || value === "typeset" || value === "review" ? value : undefined;
}

function readWorkflowTaskStatus(value: unknown): WorkflowTask["status"] | undefined {
	return value === "todo" || value === "doing" || value === "review" || value === "done" ? value : undefined;
}

function readWorkflowTaskPriority(value: unknown): WorkflowTask["priority"] | undefined {
	return value === "normal" || value === "high" || value === "urgent" ? value : undefined;
}

function readProjectCommentStatus(value: unknown): ProjectComment["status"] | undefined {
	return value === "open" || value === "resolved" ? value : undefined;
}

function readPageReviewDecisionStatus(value: unknown): PageReviewDecision["status"] | undefined {
	return value === "approved" || value === "changes_requested" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readCommentRegion(value: unknown): ProjectComment["region"] | undefined {
	const region = normalizeRecord(value);
	const x = Number(region.x);
	const y = Number(region.y);
	const w = Number(region.w);
	const h = Number(region.h);
	if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return undefined;
	return { x, y, w, h };
}

// Restore an on-page review mark from a comment's metadata blob (the catalog
// store round-trips the whole comment object through `metadata`). Coordinates are
// normalized (0..1) to the page image; we keep it permissive (clamp not enforced
// here — the write-side schema already bounded it) but validate the shape/finite
// numbers so a corrupt row degrades to "no annotation" rather than throwing.
function readReviewAnnotation(value: unknown): ReviewAnnotation | undefined {
	const record = normalizeRecord(value);
	const shape = record.shape;
	if (shape !== "pin" && shape !== "circle" && shape !== "rect" && shape !== "freehand") return undefined;
	const x = Number(record.x);
	const y = Number(record.y);
	const w = Number(record.w);
	const h = Number(record.h);
	if (![x, y, w, h].every(Number.isFinite)) return undefined;
	const annotation: ReviewAnnotation = { shape, x, y, w, h };
	if (Array.isArray(record.points)) {
		const points = record.points
			.map((point) => normalizeRecord(point))
			.map((point) => ({ x: Number(point.x), y: Number(point.y) }))
			.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
		if (points.length > 0) annotation.points = points;
	}
	if (typeof record.color === "string" && record.color.trim()) annotation.color = record.color;
	return annotation;
}

function toOptionalIsoString(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	return toIsoString(value);
}

function toIsoString(value: Date | string): string {
	return normalizeTimestampPrecision(value);
}

interface ProjectSummaryCursor {
	updatedAt: string;
	projectId: string;
}

export class InvalidProjectSummaryCursorError extends Error {
	constructor() {
		super("Invalid project summary cursor");
		this.name = "InvalidProjectSummaryCursorError";
	}
}

export class InvalidProjectVersionCursorError extends Error {
	constructor() {
		super("Invalid project version cursor");
		this.name = "InvalidProjectVersionCursorError";
	}
}

export class InvalidProjectTaskCursorError extends Error {
	constructor() {
		super("Invalid project task cursor");
		this.name = "InvalidProjectTaskCursorError";
	}
}

export class InvalidProjectCommentCursorError extends Error {
	constructor() {
		super("Invalid project comment cursor");
		this.name = "InvalidProjectCommentCursorError";
	}
}

export class InvalidProjectReviewDecisionCursorError extends Error {
	constructor() {
		super("Invalid project review decision cursor");
		this.name = "InvalidProjectReviewDecisionCursorError";
	}
}

function encodeProjectSummaryCursor(summary: ProjectSummary): string {
	return Buffer.from(JSON.stringify({
		updatedAt: summary.updatedAt,
		projectId: summary.projectId,
	}), "utf8").toString("base64url");
}

function decodeProjectSummaryCursor(cursor: string | undefined): ProjectSummaryCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectSummaryCursor>;
		if (typeof decoded.updatedAt !== "string" || typeof decoded.projectId !== "string") throw new InvalidProjectSummaryCursorError();
		if (Number.isNaN(new Date(decoded.updatedAt).getTime()) || !decoded.projectId.trim()) throw new InvalidProjectSummaryCursorError();
		return {
			updatedAt: normalizeTimestampPrecision(decoded.updatedAt),
			projectId: decoded.projectId,
		};
	} catch (error) {
		if (error instanceof InvalidProjectSummaryCursorError) throw error;
		throw new InvalidProjectSummaryCursorError();
	}
}

function projectSummarySortsAfterCursor(summary: ProjectSummary, cursor: ProjectSummaryCursor): boolean {
	return summary.updatedAt < cursor.updatedAt
		|| (summary.updatedAt === cursor.updatedAt && summary.projectId < cursor.projectId);
}

function compareProjectSummaryOrder(a: ProjectSummary, b: ProjectSummary): number {
	return b.updatedAt.localeCompare(a.updatedAt) || b.projectId.localeCompare(a.projectId);
}

function normalizeProjectSummaryTimestamps(summary: ProjectSummary): ProjectSummary {
	return {
		...summary,
		createdAt: normalizeTimestampPrecision(summary.createdAt),
		updatedAt: normalizeTimestampPrecision(summary.updatedAt),
	};
}

function normalizeProjectVersionTimestamp(version: ProjectVersionMetadata): ProjectVersionMetadata {
	return {
		...version,
		createdAt: normalizeTimestampPrecision(version.createdAt),
	};
}

function normalizeTimestampPrecision(value: Date | string): string {
	if (value instanceof Date) {
		return value.toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
	}
	const trimmed = String(value).trim();
	const match = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|\+00:?00|-00:?00)?$/);
	if (match) {
		const fraction = (match[2] ?? "0").slice(0, 6).padEnd(6, "0");
		return `${match[1]}.${fraction}Z`;
	}
	const parsed = new Date(trimmed);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
	}
	return trimmed;
}

interface ProjectPageCursor {
	pageIndex: number;
}

export class InvalidProjectPageCursorError extends Error {
	constructor() {
		super("Invalid project page cursor");
		this.name = "InvalidProjectPageCursorError";
	}
}

function encodeProjectPageCursor(page: ProjectPageSummary): string {
	return Buffer.from(JSON.stringify({
		pageIndex: page.pageIndex,
	}), "utf8").toString("base64url");
}

function decodeProjectPageCursor(cursor: string | undefined): ProjectPageCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectPageCursor>;
		if (typeof decoded.pageIndex !== "number"
			|| !Number.isInteger(decoded.pageIndex)
			|| decoded.pageIndex < 0
			|| decoded.pageIndex > 2147483647) {
			throw new InvalidProjectPageCursorError();
		}
		return { pageIndex: decoded.pageIndex };
	} catch (error) {
		if (error instanceof InvalidProjectPageCursorError) throw error;
		throw new InvalidProjectPageCursorError();
	}
}

interface ProjectTaskCursor {
	updatedAt: string;
	taskId: string;
}

function encodeProjectTaskCursor(task: WorkflowTask): string {
	return Buffer.from(JSON.stringify({
		updatedAt: task.updatedAt,
		taskId: task.id,
	}), "utf8").toString("base64url");
}

function decodeProjectTaskCursor(cursor: string | undefined): ProjectTaskCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectTaskCursor>;
		if (typeof decoded.updatedAt !== "string" || typeof decoded.taskId !== "string") throw new InvalidProjectTaskCursorError();
		if (Number.isNaN(new Date(decoded.updatedAt).getTime()) || !decoded.taskId.trim()) throw new InvalidProjectTaskCursorError();
		return {
			updatedAt: normalizeTimestampPrecision(decoded.updatedAt),
			taskId: decoded.taskId,
		};
	} catch (error) {
		if (error instanceof InvalidProjectTaskCursorError) throw error;
		throw new InvalidProjectTaskCursorError();
	}
}

function projectTaskSortsAfterCursor(task: WorkflowTask, cursor: ProjectTaskCursor): boolean {
	return task.updatedAt < cursor.updatedAt
		|| (task.updatedAt === cursor.updatedAt && task.id < cursor.taskId);
}

function compareProjectTaskOrder(a: WorkflowTask, b: WorkflowTask): number {
	return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

interface ProjectCommentCursor {
	updatedAt: string;
	commentId: string;
}

function encodeProjectCommentCursor(comment: ProjectComment): string {
	return Buffer.from(JSON.stringify({
		updatedAt: comment.updatedAt,
		commentId: comment.id,
	}), "utf8").toString("base64url");
}

function decodeProjectCommentCursor(cursor: string | undefined): ProjectCommentCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectCommentCursor>;
		if (typeof decoded.updatedAt !== "string" || typeof decoded.commentId !== "string") throw new InvalidProjectCommentCursorError();
		if (Number.isNaN(new Date(decoded.updatedAt).getTime()) || !decoded.commentId.trim()) throw new InvalidProjectCommentCursorError();
		return {
			updatedAt: normalizeTimestampPrecision(decoded.updatedAt),
			commentId: decoded.commentId,
		};
	} catch (error) {
		if (error instanceof InvalidProjectCommentCursorError) throw error;
		throw new InvalidProjectCommentCursorError();
	}
}

function projectCommentSortsAfterCursor(comment: ProjectComment, cursor: ProjectCommentCursor): boolean {
	return comment.updatedAt < cursor.updatedAt
		|| (comment.updatedAt === cursor.updatedAt && comment.id < cursor.commentId);
}

function compareProjectCommentOrder(a: ProjectComment, b: ProjectComment): number {
	return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

interface ProjectReviewDecisionCursor {
	updatedAt: string;
	reviewDecisionId: string;
}

function encodeProjectReviewDecisionCursor(decision: PageReviewDecision): string {
	return Buffer.from(JSON.stringify({
		updatedAt: decision.updatedAt,
		reviewDecisionId: decision.id,
	}), "utf8").toString("base64url");
}

function decodeProjectReviewDecisionCursor(cursor: string | undefined): ProjectReviewDecisionCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectReviewDecisionCursor>;
		if (typeof decoded.updatedAt !== "string" || typeof decoded.reviewDecisionId !== "string") throw new InvalidProjectReviewDecisionCursorError();
		if (Number.isNaN(new Date(decoded.updatedAt).getTime()) || !decoded.reviewDecisionId.trim()) throw new InvalidProjectReviewDecisionCursorError();
		return {
			updatedAt: normalizeTimestampPrecision(decoded.updatedAt),
			reviewDecisionId: decoded.reviewDecisionId,
		};
	} catch (error) {
		if (error instanceof InvalidProjectReviewDecisionCursorError) throw error;
		throw new InvalidProjectReviewDecisionCursorError();
	}
}

function projectReviewDecisionSortsAfterCursor(decision: PageReviewDecision, cursor: ProjectReviewDecisionCursor): boolean {
	return decision.updatedAt < cursor.updatedAt
		|| (decision.updatedAt === cursor.updatedAt && decision.id < cursor.reviewDecisionId);
}

function compareProjectReviewDecisionOrder(a: PageReviewDecision, b: PageReviewDecision): number {
	return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

interface ProjectVersionCursor {
	createdAt: string;
	versionId: string;
}

function encodeProjectVersionCursor(version: ProjectVersionMetadata): string {
	return Buffer.from(JSON.stringify({
		createdAt: version.createdAt,
		versionId: version.versionId,
	}), "utf8").toString("base64url");
}

function decodeProjectVersionCursor(cursor: string | undefined): ProjectVersionCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<ProjectVersionCursor>;
		if (typeof decoded.createdAt !== "string" || typeof decoded.versionId !== "string") throw new InvalidProjectVersionCursorError();
		if (Number.isNaN(new Date(decoded.createdAt).getTime()) || !decoded.versionId.trim()) throw new InvalidProjectVersionCursorError();
		return {
			createdAt: normalizeTimestampPrecision(decoded.createdAt),
			versionId: decoded.versionId,
		};
	} catch (error) {
		if (error instanceof InvalidProjectVersionCursorError) throw error;
		throw new InvalidProjectVersionCursorError();
	}
}

function projectVersionSortsAfterCursor(version: ProjectVersionMetadata, cursor: ProjectVersionCursor): boolean {
	return version.createdAt < cursor.createdAt
		|| (version.createdAt === cursor.createdAt && version.versionId < cursor.versionId);
}

// ===== ADMIN CONTENT (rank 17-18) =====
//
// Back-office content management: a CROSS-TENANT project browser + moderation
// queue + audited admin flag / hide (soft-delete) for owner/admin/support.
//
// This section is purely ADDITIVE — it does NOT touch any existing
// ProjectCatalogStore method or its visibility rules. The normal app catalog is
// per-member scoped (a member only sees their own workspace's projects); this
// surface is the OPPOSITE: a platform admin sees EVERY workspace's projects,
// gated at the HTTP layer by admin:content.read / admin:content.moderate. It is
// metadata-only — never asset bytes.
//
// Storage:
//   * Postgres: the admin flag/hide state lives in the projects.admin_* columns
//     added by migration 0056 (distinct from the user-facing projects.deleted_at
//     soft-delete and from the asset_records moderation pipeline). Moderation-queue
//     items reuse asset_records.moderation_* (0021/0047) + csam_blocks (0048).
//   * File mode (prototype / no DATABASE_URL): projects are read by scanning the
//     on-disk state files (same primitives FileProjectCatalogStore uses); the
//     admin flag/hide state is kept in a small sidecar JSON
//     (DATA_DIR/admin-content-moderation.json) so admin actions never mutate the
//     project state files themselves.

export interface AdminContentModerationFlags {
	/** Whether a platform admin has flagged this project for attention. */
	adminFlagged: boolean;
	adminFlaggedAt: string | null;
	adminFlaggedBy: string | null;
	adminFlagReason: string | null;
	/** Whether a platform admin has hidden (soft-deleted) this project. */
	adminHidden: boolean;
	adminHiddenAt: string | null;
	adminHiddenBy: string | null;
	adminHideReason: string | null;
}

export interface AdminContentProjectRow extends AdminContentModerationFlags {
	projectId: string;
	workspaceId: string | null;
	workspaceName: string | null;
	ownerUserId: string | null;
	title: string;
	/** Derived lifecycle status surfaced to the admin browser. */
	status: "active" | "admin_hidden" | "user_deleted";
	sourceLang: string | null;
	targetLang: string | null;
	pageCount: number;
	assetCount: number;
	/** Count of assets whose moderation pipeline verdict is not "allowed". */
	flaggedAssetCount: number;
	/** Count of mandatory CSAM/extreme hard-blocks recorded for this project. */
	csamBlockCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface AdminContentListOptions {
	limit?: number;
	cursor?: string;
	/** Free-text search over project title / id / workspace id. */
	search?: string;
	/** Lifecycle filter. "all" includes user-deleted; default excludes them. */
	status?: "active" | "admin_hidden" | "all";
	/** When true, only projects an admin has flagged. */
	flagged?: boolean;
	/** When true, only projects an admin has hidden. */
	hidden?: boolean;
}

export interface AdminContentProjectPage {
	projects: AdminContentProjectRow[];
	nextCursor?: string;
}

export interface AdminContentProjectDetail extends AdminContentProjectRow {
	/** Bounded recent pages (metadata only — no asset bytes). */
	pages: ProjectPageSummary[];
	/** Bounded recent flagged assets for this project. */
	flaggedAssets: AdminModerationQueueItem[];
}

export interface AdminModerationQueueItem {
	source: "asset" | "csam_block";
	assetId: string | null;
	projectId: string | null;
	workspaceId: string | null;
	moderationStatus: string | null;
	moderationProvider: string | null;
	moderationReason: string | null;
	/** Bucketed moderation scores / categories — metadata only, no bytes. */
	detail: Record<string, unknown>;
	occurredAt: string;
}

export interface AdminModerationQueueOptions {
	limit?: number;
	cursor?: string;
	/** Restrict to a single source kind; default returns both. */
	source?: "asset" | "csam_block";
}

export interface AdminModerationQueuePage {
	items: AdminModerationQueueItem[];
	nextCursor?: string;
}

export interface AdminContentFlagInput {
	projectId: string;
	adminUserId: string;
	flagged: boolean;
	reason?: string | null;
}

export interface AdminContentHideInput {
	projectId: string;
	adminUserId: string;
	hidden: boolean;
	reason?: string | null;
}

export interface AdminContentStore {
	listProjects(options?: AdminContentListOptions): Promise<AdminContentProjectPage>;
	getProject(projectId: string): Promise<AdminContentProjectDetail | null>;
	listModerationQueue(options?: AdminModerationQueueOptions): Promise<AdminModerationQueuePage>;
	/** Toggle the admin flag. Returns the updated row, or null if the project is unknown. */
	setProjectFlag(input: AdminContentFlagInput): Promise<AdminContentProjectRow | null>;
	/** Toggle the admin hide (soft-delete). Returns the updated row, or null if unknown. */
	setProjectHidden(input: AdminContentHideInput): Promise<AdminContentProjectRow | null>;
}

// ── Admin content cursors (keyset, stable) ────────────────────────
// Project browser orders by updated_at DESC, project_id DESC — same tie-break as
// the normal catalog so paging is stable under concurrent writes.
interface AdminContentProjectCursor {
	updatedAt: string;
	projectId: string;
}

export class InvalidAdminContentCursorError extends Error {
	constructor(message = "Invalid admin content cursor") {
		super(message);
		this.name = "InvalidAdminContentCursorError";
	}
}

function encodeAdminContentProjectCursor(row: { updatedAt: string; projectId: string }): string {
	return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt, projectId: row.projectId }), "utf8").toString("base64url");
}

function decodeAdminContentProjectCursor(cursor: string | undefined): AdminContentProjectCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<AdminContentProjectCursor>;
		if (typeof decoded.updatedAt !== "string" || typeof decoded.projectId !== "string") throw new InvalidAdminContentCursorError();
		if (Number.isNaN(new Date(decoded.updatedAt).getTime()) || !decoded.projectId.trim()) throw new InvalidAdminContentCursorError();
		return { updatedAt: decoded.updatedAt, projectId: decoded.projectId };
	} catch (error) {
		if (error instanceof InvalidAdminContentCursorError) throw error;
		throw new InvalidAdminContentCursorError();
	}
}

// Moderation queue orders by occurred_at DESC, id DESC.
interface AdminModerationQueueCursor {
	occurredAt: string;
	id: string;
}

function encodeAdminModerationCursor(occurredAt: string, id: string): string {
	return Buffer.from(JSON.stringify({ occurredAt, id }), "utf8").toString("base64url");
}

function decodeAdminModerationCursor(cursor: string | undefined): AdminModerationQueueCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<AdminModerationQueueCursor>;
		if (typeof decoded.occurredAt !== "string" || typeof decoded.id !== "string") throw new InvalidAdminContentCursorError();
		if (Number.isNaN(new Date(decoded.occurredAt).getTime()) || !decoded.id.trim()) throw new InvalidAdminContentCursorError();
		return { occurredAt: decoded.occurredAt, id: decoded.id };
	} catch (error) {
		if (error instanceof InvalidAdminContentCursorError) throw error;
		throw new InvalidAdminContentCursorError();
	}
}

function normalizeAdminContentLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 50;
	return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function deriveAdminContentStatus(flags: { adminHidden: boolean; userDeleted: boolean }): AdminContentProjectRow["status"] {
	if (flags.userDeleted) return "user_deleted";
	if (flags.adminHidden) return "admin_hidden";
	return "active";
}

interface AdminContentProjectRowDb {
	project_id: string;
	workspace_id: string | null;
	workspace_name: string | null;
	owner_user_id: string | null;
	title: string;
	source_locale: string | null;
	target_locale: string | null;
	deleted_at: Date | string | null;
	admin_flagged_at: Date | string | null;
	admin_flagged_by: string | null;
	admin_flag_reason: string | null;
	admin_hidden_at: Date | string | null;
	admin_hidden_by: string | null;
	admin_hide_reason: string | null;
	created_at: string;
	updated_at: string;
	page_count: number | string | null;
	asset_count: number | string | null;
	flagged_asset_count: number | string | null;
	csam_block_count: number | string | null;
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text ? text : null;
}

function intOrZero(value: number | string | null | undefined): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function mapAdminContentProjectRow(row: AdminContentProjectRowDb): AdminContentProjectRow {
	const adminFlaggedAt = toIsoOrNull(row.admin_flagged_at);
	const adminHiddenAt = toIsoOrNull(row.admin_hidden_at);
	const userDeleted = toIsoOrNull(row.deleted_at) !== null;
	const adminHidden = adminHiddenAt !== null;
	return {
		projectId: row.project_id,
		workspaceId: row.workspace_id ?? null,
		workspaceName: row.workspace_name ?? null,
		ownerUserId: row.owner_user_id ?? null,
		title: row.title,
		status: deriveAdminContentStatus({ adminHidden, userDeleted }),
		sourceLang: row.source_locale ?? null,
		targetLang: row.target_locale ?? null,
		pageCount: intOrZero(row.page_count),
		assetCount: intOrZero(row.asset_count),
		flaggedAssetCount: intOrZero(row.flagged_asset_count),
		csamBlockCount: intOrZero(row.csam_block_count),
		adminFlagged: adminFlaggedAt !== null,
		adminFlaggedAt,
		adminFlaggedBy: row.admin_flagged_by ?? null,
		adminFlagReason: row.admin_flag_reason ?? null,
		adminHidden,
		adminHiddenAt,
		adminHiddenBy: row.admin_hidden_by ?? null,
		adminHideReason: row.admin_hide_reason ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Postgres-backed admin content store. Cross-tenant: NO workspace/member filter —
 * the HTTP layer's admin:content.* gate is the sole authorization. Every query is
 * keyset-paginated and uses scalar binds only (no Bun JS-array binds).
 */
export class PostgresAdminContentStore implements AdminContentStore {
	private readonly client: ProjectCatalogSqlClient;

	constructor(databaseUrlOrClient: string | ProjectCatalogSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PostgresAdminContentStore requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as ProjectCatalogSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async listProjects(options: AdminContentListOptions = {}): Promise<AdminContentProjectPage> {
		const limit = normalizeAdminContentLimit(options.limit);
		const cursor = decodeAdminContentProjectCursor(options.cursor);
		const statusFilter = options.status ?? "active";
		const params: unknown[] = [];
		const add = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		const conditions: string[] = [];
		// "active" hides user-deleted; "admin_hidden" only admin-hidden; "all" everything.
		if (statusFilter === "active") {
			conditions.push("projects.deleted_at IS NULL");
		} else if (statusFilter === "admin_hidden") {
			conditions.push("projects.admin_hidden_at IS NOT NULL");
			conditions.push("projects.deleted_at IS NULL");
		}
		if (options.flagged) conditions.push("projects.admin_flagged_at IS NOT NULL");
		if (options.hidden) conditions.push("projects.admin_hidden_at IS NOT NULL");
		const search = options.search?.trim();
		if (search) {
			// SECURITY: escape LIKE metacharacters (\ % _) so an admin search of "%" or "_"
			// matches a LITERAL char instead of "anything" — an unescaped "%" forced a
			// cross-tenant full-pattern scan (DoS), and it also makes substring search behave
			// as users expect (literal, not wildcard). The term is bound via add() (no SQL
			// injection); ESCAPE '\' tells Postgres which char un-wildcards % and _.
			const escaped = search.toLowerCase().replace(/[\\%_]/g, "\\$&");
			const term = add(`%${escaped}%`);
			conditions.push(`(lower(projects.title) LIKE ${term} ESCAPE '\\' OR lower(projects.project_id) LIKE ${term} ESCAPE '\\' OR lower(COALESCE(projects.workspace_id, '')) LIKE ${term} ESCAPE '\\')`);
		}
		if (cursor) {
			const updatedAtParam = add(cursor.updatedAt);
			const projectIdParam = add(cursor.projectId);
			conditions.push(`(projects.updated_at, projects.project_id) < (${updatedAtParam}::timestamptz, ${projectIdParam}::text)`);
		}
		const limitParam = add(limit + 1);
		const where = conditions.length > 0 ? `WHERE ${conditions.join("\n\t\t\t\tAND ")}` : "";
		const rows = await this.client.unsafe<AdminContentProjectRowDb>(`
			SELECT
				projects.project_id,
				projects.workspace_id,
				workspaces.name AS workspace_name,
				projects.owner_user_id,
				projects.title,
				projects.source_locale,
				projects.target_locale,
				projects.deleted_at,
				projects.admin_flagged_at,
				projects.admin_flagged_by,
				projects.admin_flag_reason,
				projects.admin_hidden_at,
				projects.admin_hidden_by,
				projects.admin_hide_reason,
				to_char(projects.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
				to_char(projects.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
				(SELECT count(*) FROM project_pages WHERE project_pages.project_id = projects.project_id) AS page_count,
				(SELECT count(*) FROM asset_records WHERE asset_records.project_id = projects.project_id) AS asset_count,
				(SELECT count(*) FROM asset_records WHERE asset_records.project_id = projects.project_id AND asset_records.moderation_status <> 'passed') AS flagged_asset_count,
				(SELECT count(*) FROM csam_blocks WHERE csam_blocks.asset_id IN (
					SELECT asset_id FROM asset_records WHERE asset_records.project_id = projects.project_id
				)) AS csam_block_count
			FROM projects
			LEFT JOIN workspaces ON workspaces.workspace_id = projects.workspace_id
			${where}
			ORDER BY projects.updated_at DESC, projects.project_id DESC
			LIMIT ${limitParam}
		`, params);
		const mapped = rows.map(mapAdminContentProjectRow);
		const projects = mapped.slice(0, limit);
		const last = projects[projects.length - 1];
		return {
			projects,
			nextCursor: mapped.length > limit && last ? encodeAdminContentProjectCursor(last) : undefined,
		};
	}

	// Detail + flag/hide mutations are scoped to LIVE projects only
	// (deleted_at IS NULL). A user soft-deleted project is hidden + immutable
	// through the admin content surface: getProject returns null (→ route 404) and
	// the flag/hide UPDATEs no-op so a re-read returns null too. There is no
	// retention/legal bypass path — only the explicit status="all" LIST view
	// surfaces deleted rows for audit, and even then their detail/mutations 404.
	async getProject(projectId: string): Promise<AdminContentProjectDetail | null> {
		const id = projectId.trim();
		if (!id) return null;
		const rows = await this.client.unsafe<AdminContentProjectRowDb>(`
			SELECT
				projects.project_id,
				projects.workspace_id,
				workspaces.name AS workspace_name,
				projects.owner_user_id,
				projects.title,
				projects.source_locale,
				projects.target_locale,
				projects.deleted_at,
				projects.admin_flagged_at,
				projects.admin_flagged_by,
				projects.admin_flag_reason,
				projects.admin_hidden_at,
				projects.admin_hidden_by,
				projects.admin_hide_reason,
				to_char(projects.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
				to_char(projects.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
				(SELECT count(*) FROM project_pages WHERE project_pages.project_id = projects.project_id) AS page_count,
				(SELECT count(*) FROM asset_records WHERE asset_records.project_id = projects.project_id) AS asset_count,
				(SELECT count(*) FROM asset_records WHERE asset_records.project_id = projects.project_id AND asset_records.moderation_status <> 'passed') AS flagged_asset_count,
				(SELECT count(*) FROM csam_blocks WHERE csam_blocks.asset_id IN (
					SELECT asset_id FROM asset_records WHERE asset_records.project_id = projects.project_id
				)) AS csam_block_count
			FROM projects
			LEFT JOIN workspaces ON workspaces.workspace_id = projects.workspace_id
			WHERE projects.project_id = $1
				AND projects.deleted_at IS NULL
			LIMIT 1
		`, [id]);
		const row = rows[0];
		if (!row) return null;
		const base = mapAdminContentProjectRow(row);
		const pageRows = await this.client.unsafe<ProjectPageRow>(`
			SELECT page_id, project_id, page_index, image_id, status, revision_id, metadata, created_at, updated_at
			FROM project_pages
			WHERE project_id = $1
			ORDER BY page_index ASC
			LIMIT 50
		`, [id]);
		const flaggedAssetRows = await this.client.unsafe<AdminAssetModerationRow>(`
			SELECT asset_id, project_id, workspace_id, moderation_status, moderation_provider, moderation_reason, moderation_detail,
				to_char(COALESCE(moderation_checked_at, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
			FROM asset_records
			WHERE project_id = $1
				AND moderation_status <> 'passed'
			ORDER BY COALESCE(moderation_checked_at, updated_at) DESC, asset_id DESC
			LIMIT 50
		`, [id]);
		return {
			...base,
			pages: pageRows.map(mapProjectPageRow),
			flaggedAssets: flaggedAssetRows.map(mapAdminAssetModerationRow),
		};
	}

	async listModerationQueue(options: AdminModerationQueueOptions = {}): Promise<AdminModerationQueuePage> {
		const limit = normalizeAdminContentLimit(options.limit);
		const cursor = decodeAdminModerationCursor(options.cursor);
		// Two underlying sources (flagged assets + CSAM hard-blocks) are unioned and
		// ordered by occurred_at DESC, id DESC. We over-fetch then trim for the cursor.
		const params: unknown[] = [];
		const add = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		// Canonical asset moderation statuses are pending|passed|blocked|needs_review
		// (types/index.ts). The "flagged / needs-attention" queue is every NON-passed
		// asset — using `<> 'allowed'` (a status that does not exist) matched EVERY
		// asset, flooding the admin queue with passed content.
		const assetCond: string[] = ["asset_records.moderation_status <> 'passed'"];
		const cursorClause = (occurredCol: string, idCol: string): string => {
			if (!cursor) return "TRUE";
			const occurredParam = add(cursor.occurredAt);
			const idParam = add(cursor.id);
			return `(${occurredCol}, ${idCol}) < (${occurredParam}::timestamptz, ${idParam}::text)`;
		};
		const wantAsset = options.source !== "csam_block";
		const wantCsam = options.source !== "asset";
		const unionParts: string[] = [];
		if (wantAsset) {
			const occurred = "COALESCE(asset_records.moderation_checked_at, asset_records.updated_at)";
			unionParts.push(`
				SELECT
					'asset' AS source,
					asset_records.asset_id,
					asset_records.project_id,
					asset_records.workspace_id,
					asset_records.moderation_status,
					asset_records.moderation_provider,
					asset_records.moderation_reason,
					asset_records.moderation_detail AS detail,
					to_char(${occurred} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
					asset_records.asset_id AS id
				FROM asset_records
				WHERE ${assetCond.join(" AND ")}
					AND ${cursorClause(occurred, "asset_records.asset_id")}
			`);
		}
		if (wantCsam) {
			unionParts.push(`
				SELECT
					'csam_block' AS source,
					csam_blocks.asset_id,
					NULL::text AS project_id,
					csam_blocks.workspace_id,
					'blocked'::text AS moderation_status,
					'csam'::text AS moderation_provider,
					'mandatory_block'::text AS moderation_reason,
					csam_blocks.scores AS detail,
					to_char(csam_blocks.blocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
					csam_blocks.id::text AS id
				FROM csam_blocks
				WHERE ${cursorClause("csam_blocks.blocked_at", "csam_blocks.id::text")}
			`);
		}
		if (unionParts.length === 0) return { items: [] };
		const limitParam = add(limit + 1);
		const rows = await this.client.unsafe<AdminModerationQueueRow>(`
			SELECT * FROM (
				${unionParts.join("\n\t\t\t\tUNION ALL\n")}
			) AS moderation_queue
			ORDER BY occurred_at DESC, id DESC
			LIMIT ${limitParam}
		`, params);
		const mapped = rows.map(mapAdminModerationQueueRow);
		const items = mapped.slice(0, limit);
		const last = rows[items.length - 1];
		return {
			items,
			nextCursor: mapped.length > limit && last ? encodeAdminModerationCursor(last.occurred_at, last.id) : undefined,
		};
	}

	async setProjectFlag(input: AdminContentFlagInput): Promise<AdminContentProjectRow | null> {
		const id = input.projectId.trim();
		if (!id) return null;
		if (input.flagged) {
			await this.client.unsafe(`
				UPDATE projects
				SET admin_flagged_at = now(), admin_flagged_by = $2, admin_flag_reason = $3, updated_at = now()
				WHERE project_id = $1
					AND deleted_at IS NULL
			`, [id, input.adminUserId, input.reason ?? null]);
		} else {
			await this.client.unsafe(`
				UPDATE projects
				SET admin_flagged_at = NULL, admin_flagged_by = NULL, admin_flag_reason = NULL, updated_at = now()
				WHERE project_id = $1
					AND deleted_at IS NULL
			`, [id]);
		}
		const detail = await this.getProject(id);
		return detail ? toAdminContentProjectRow(detail) : null;
	}

	async setProjectHidden(input: AdminContentHideInput): Promise<AdminContentProjectRow | null> {
		const id = input.projectId.trim();
		if (!id) return null;
		if (input.hidden) {
			await this.client.unsafe(`
				UPDATE projects
				SET admin_hidden_at = now(), admin_hidden_by = $2, admin_hide_reason = $3, updated_at = now()
				WHERE project_id = $1
					AND deleted_at IS NULL
			`, [id, input.adminUserId, input.reason ?? null]);
		} else {
			await this.client.unsafe(`
				UPDATE projects
				SET admin_hidden_at = NULL, admin_hidden_by = NULL, admin_hide_reason = NULL, updated_at = now()
				WHERE project_id = $1
					AND deleted_at IS NULL
			`, [id]);
		}
		const detail = await this.getProject(id);
		return detail ? toAdminContentProjectRow(detail) : null;
	}
}

interface AdminAssetModerationRow {
	asset_id: string | null;
	project_id: string | null;
	workspace_id: string | null;
	moderation_status: string | null;
	moderation_provider: string | null;
	moderation_reason: string | null;
	moderation_detail: Record<string, unknown> | string | null;
	occurred_at: string;
}

interface AdminModerationQueueRow extends AdminAssetModerationRow {
	source: string;
	detail: Record<string, unknown> | string | null;
	id: string;
}

function coerceDetail(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	if (typeof value === "string" && value.trim()) {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			/* fall through */
		}
	}
	return {};
}

function mapAdminAssetModerationRow(row: AdminAssetModerationRow): AdminModerationQueueItem {
	return {
		source: "asset",
		assetId: row.asset_id ?? null,
		projectId: row.project_id ?? null,
		workspaceId: row.workspace_id ?? null,
		moderationStatus: row.moderation_status ?? null,
		moderationProvider: row.moderation_provider ?? null,
		moderationReason: row.moderation_reason ?? null,
		detail: coerceDetail(row.moderation_detail),
		occurredAt: row.occurred_at,
	};
}

function mapAdminModerationQueueRow(row: AdminModerationQueueRow): AdminModerationQueueItem {
	return {
		source: row.source === "csam_block" ? "csam_block" : "asset",
		assetId: row.asset_id ?? null,
		projectId: row.project_id ?? null,
		workspaceId: row.workspace_id ?? null,
		moderationStatus: row.moderation_status ?? null,
		moderationProvider: row.moderation_provider ?? null,
		moderationReason: row.moderation_reason ?? null,
		detail: coerceDetail(row.detail),
		occurredAt: row.occurred_at,
	};
}

function toAdminContentProjectRow(detail: AdminContentProjectDetail): AdminContentProjectRow {
	const { pages: _pages, flaggedAssets: _flaggedAssets, ...row } = detail;
	void _pages;
	void _flaggedAssets;
	return row;
}

// ── File-mode admin content store ─────────────────────────────────
// Cross-tenant browser by scanning on-disk project state files. The admin
// flag/hide state lives in a sidecar JSON so admin actions never mutate the
// project state files. Asset moderation / CSAM data are Postgres-only features,
// so the file-mode moderation queue is derived from per-state pending/blocked
// signals when present and is otherwise empty.

interface AdminContentSidecarEntry {
	flaggedAt?: string;
	flaggedBy?: string;
	flagReason?: string;
	hiddenAt?: string;
	hiddenBy?: string;
	hideReason?: string;
}

type AdminContentSidecar = Record<string, AdminContentSidecarEntry>;

export class FileAdminContentStore implements AdminContentStore {
	constructor(
		private readonly projectsDir: string = join(DATA_DIR, "projects"),
		private readonly sidecarPath: string = join(DATA_DIR, "admin-content-moderation.json"),
		private readonly accessStore: WorkspaceAccessStore = workspaceAccessStore,
	) {}

	async listProjects(options: AdminContentListOptions = {}): Promise<AdminContentProjectPage> {
		const limit = normalizeAdminContentLimit(options.limit);
		const cursor = decodeAdminContentProjectCursor(options.cursor);
		const sidecar = this.readSidecar();
		const statusFilter = options.status ?? "active";
		const search = options.search?.trim().toLowerCase();
		const rows: AdminContentProjectRow[] = [];
		for (const entry of this.allProjectStates()) {
			// A state with no usable projectId can't be addressed or sorted — skip it
			// rather than let a single corrupt/legacy file 500 the god-view browser.
			if (typeof entry.state?.projectId !== "string" || !entry.state.projectId.trim()) continue;
			let row: AdminContentProjectRow;
			try {
				row = await this.buildRow(entry.state, entry.updatedAt, sidecar);
			} catch (error) {
				// One malformed/legacy on-disk state must not 500 the whole god-view
				// browser — skip it (Postgres has no equivalent since rows are typed).
				console.warn(`[FileAdminContentStore] Skipping unreadable project ${entry.state?.projectId}: ${error}`);
				continue;
			}
			// File-mode has no user_deleted lifecycle, so "active" shows everything
			// (incl. admin-hidden, which an admin must see to unhide). Only the explicit
			// "admin_hidden" filter narrows the list.
			if (statusFilter === "admin_hidden" && !row.adminHidden) continue;
			if (options.flagged && !row.adminFlagged) continue;
			if (options.hidden && !row.adminHidden) continue;
			if (search) {
				const haystack = `${row.title} ${row.projectId} ${row.workspaceId ?? ""}`.toLowerCase();
				if (!haystack.includes(search)) continue;
			}
			rows.push(row);
		}
		rows.sort((a, b) => (b.updatedAt.localeCompare(a.updatedAt)) || b.projectId.localeCompare(a.projectId));
		const filtered = cursor
			? rows.filter((row) => row.updatedAt < cursor.updatedAt || (row.updatedAt === cursor.updatedAt && row.projectId < cursor.projectId))
			: rows;
		const projects = filtered.slice(0, limit);
		const last = projects[projects.length - 1];
		return {
			projects,
			nextCursor: filtered.length > limit && last ? encodeAdminContentProjectCursor(last) : undefined,
		};
	}

	async getProject(projectId: string): Promise<AdminContentProjectDetail | null> {
		const state = this.readState(projectId.trim());
		if (!state) return null;
		const sidecar = this.readSidecar();
		const statePath = safePath(this.projectsDir, state.projectId, "state.json");
		let updatedAt = state.createdAt;
		try {
			updatedAt = statSync(statePath).mtime.toISOString();
		} catch { /* fall back */ }
		const base = await this.buildRow(state, updatedAt, sidecar);
		// Tolerate partial/legacy states with no pages array (mirrors buildRow).
		const pages = Array.isArray(state.pages) ? summarizeProjectPages(state).slice(0, 50) : [];
		return {
			...base,
			pages,
			flaggedAssets: [],
		};
	}

	async listModerationQueue(): Promise<AdminModerationQueuePage> {
		// Asset moderation + CSAM blocks are Postgres-only data; file-mode has no
		// asset_records / csam_blocks table to read from.
		return { items: [] };
	}

	async setProjectFlag(input: AdminContentFlagInput): Promise<AdminContentProjectRow | null> {
		const state = this.readState(input.projectId.trim());
		if (!state) return null;
		const sidecar = this.readSidecar();
		const entry = sidecar[state.projectId] ?? {};
		if (input.flagged) {
			entry.flaggedAt = new Date().toISOString();
			entry.flaggedBy = input.adminUserId;
			entry.flagReason = input.reason ?? undefined;
		} else {
			delete entry.flaggedAt;
			delete entry.flaggedBy;
			delete entry.flagReason;
		}
		sidecar[state.projectId] = entry;
		this.writeSidecar(sidecar);
		const detail = await this.getProject(state.projectId);
		return detail ? toAdminContentProjectRow(detail) : null;
	}

	async setProjectHidden(input: AdminContentHideInput): Promise<AdminContentProjectRow | null> {
		const state = this.readState(input.projectId.trim());
		if (!state) return null;
		const sidecar = this.readSidecar();
		const entry = sidecar[state.projectId] ?? {};
		if (input.hidden) {
			entry.hiddenAt = new Date().toISOString();
			entry.hiddenBy = input.adminUserId;
			entry.hideReason = input.reason ?? undefined;
		} else {
			delete entry.hiddenAt;
			delete entry.hiddenBy;
			delete entry.hideReason;
		}
		sidecar[state.projectId] = entry;
		this.writeSidecar(sidecar);
		const detail = await this.getProject(state.projectId);
		return detail ? toAdminContentProjectRow(detail) : null;
	}

	private async buildRow(state: ProjectState, updatedAt: string, sidecar: AdminContentSidecar): Promise<AdminContentProjectRow> {
		const entry = sidecar[state.projectId] ?? {};
		const workspaceId = hasExplicitWorkspaceId(state) ? resolveWorkspaceId(state) : null;
		let workspaceName: string | null = null;
		if (workspaceId) {
			const workspace = await this.accessStore.getWorkspace(workspaceId).catch(() => null);
			workspaceName = workspace?.name ?? null;
		}
		const adminFlagged = Boolean(entry.flaggedAt);
		const adminHidden = Boolean(entry.hiddenAt);
		// A god-view scan must tolerate partial/legacy on-disk states (e.g. a project
		// written before a field existed): default missing arrays rather than throw,
		// so one malformed project never 500s the whole cross-tenant browser.
		const pageCount = Array.isArray(state.pages) ? state.pages.length : 0;
		return {
			projectId: state.projectId,
			workspaceId,
			workspaceName,
			ownerUserId: state.userId ?? null,
			title: state.name,
			status: deriveAdminContentStatus({ adminHidden, userDeleted: false }),
			sourceLang: state.sourceLang ?? null,
			targetLang: state.targetLang ?? null,
			pageCount,
			assetCount: pageCount,
			flaggedAssetCount: 0,
			csamBlockCount: 0,
			adminFlagged,
			adminFlaggedAt: entry.flaggedAt ?? null,
			adminFlaggedBy: entry.flaggedBy ?? null,
			adminFlagReason: entry.flagReason ?? null,
			adminHidden,
			adminHiddenAt: entry.hiddenAt ?? null,
			adminHiddenBy: entry.hiddenBy ?? null,
			adminHideReason: entry.hideReason ?? null,
			createdAt: state.createdAt,
			updatedAt,
		};
	}

	private readState(projectId: string): ProjectState | null {
		if (!isValidProjectId(projectId)) return null;
		// A permanently-deleted project must stay deleted in the god-view content
		// browser too (single read AND the cross-tenant dir scan via allProjectStates),
		// even if a stale state.json survived a partial rmSync. Honor the deletion
		// tombstone FIRST — the single chokepoint all admin-content reads funnel
		// through — mirroring FileProjectCatalogStore.readState.
		if (isProjectTombstonedIn(this.projectsDir, projectId)) return null;
		const statePath = safePath(this.projectsDir, projectId, "state.json");
		if (!existsSync(statePath)) return null;
		try {
			return readJsonFile<ProjectState>(statePath);
		} catch {
			return null;
		}
	}

	private allProjectStates(): Array<{ state: ProjectState; updatedAt: string }> {
		if (!existsSync(this.projectsDir)) return [];
		const entries: Array<{ state: ProjectState; updatedAt: string }> = [];
		for (const dir of readdirSync(this.projectsDir)) {
			if (!isValidProjectId(dir)) continue;
			// readState honors the tombstone, so a tombstoned dir with a stale
			// state.json returns null here and is skipped from the god-view list.
			const state = this.readState(dir);
			if (!state) continue;
			const statePath = safePath(this.projectsDir, dir, "state.json");
			let updatedAt = state.createdAt;
			try {
				updatedAt = statSync(statePath).mtime.toISOString();
			} catch { /* fall back */ }
			entries.push({ state, updatedAt });
		}
		return entries;
	}

	private readSidecar(): AdminContentSidecar {
		if (!existsSync(this.sidecarPath)) return {};
		try {
			return readJsonFile<AdminContentSidecar>(this.sidecarPath) ?? {};
		} catch {
			return {};
		}
	}

	private writeSidecar(sidecar: AdminContentSidecar): void {
		try {
			mkdirSync(join(this.sidecarPath, ".."), { recursive: true });
			writeFileSync(this.sidecarPath, JSON.stringify(sidecar, null, 2));
		} catch {
			// Best-effort, mirroring the GdprStore file persistence posture.
		}
	}
}

export function createAdminContentStore(): AdminContentStore {
	if (serverConfig.projectCatalogStore === "postgres") return new PostgresAdminContentStore();
	return new FileAdminContentStore();
}

export const adminContentStore: AdminContentStore = createAdminContentStore();
