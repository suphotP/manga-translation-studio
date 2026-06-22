// Workspace-home store — the KEYSTONE that decouples the workspace dashboard /
// My-Work / activity / pipeline widgets from whichever single chapter is open in
// the editor.
//
// It reads GET /api/workspaces/:id/home, a server-side aggregate fanned across
// EVERY project the member can see. This store is INTENTIONALLY independent of
// projectStore.project: opening a chapter changes the right-panel inspector, not
// this aggregate. The dashboard reads this slice FIRST; when it is empty the
// surface renders an honest empty state rather than a single open chapter's data
// (and never a mock).

import * as api from "$lib/api/client.ts";
import type {
	WorkspaceHomeAggregate,
	WorkspaceHomeAiJob,
	WorkspaceHomeFeedItem,
	WorkspaceHomeRecentProject,
	WorkspaceHomeTask,
	WorkspacePipelineStageCounts,
} from "$lib/api/client.ts";

const PIPELINE_STAGES = ["translate", "clean", "typeset", "review"] as const;

function emptyPipeline(): WorkspacePipelineStageCounts[] {
	return PIPELINE_STAGES.map((stage) => ({
		stage,
		todo: 0,
		doing: 0,
		review: 0,
		done: 0,
		total: 0,
		open: 0,
	}));
}

const EMPTY_COUNTS = {
	projects: 0,
	myOpenTasks: 0,
	attention: 0,
	aiJobs: 0,
	dueToday: 0,
	overdue: 0,
	openTasks: 0,
} as const;

class WorkspaceHomeStore {
	aggregate = $state<WorkspaceHomeAggregate | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	lastLoadedAt = $state<number | null>(null);
	currentWorkspaceId = $state<string | null>(null);

	private inflight: { workspaceId: string; promise: Promise<void> } | null = null;

	// --- derived: honest fallbacks so consumers never read mock or per-chapter data
	myTasks = $derived<WorkspaceHomeTask[]>(this.aggregate?.myTasks ?? []);
	attention = $derived<WorkspaceHomeFeedItem[]>(this.aggregate?.attention ?? []);
	activity = $derived<WorkspaceHomeFeedItem[]>(this.aggregate?.activity ?? []);
	aiJobs = $derived<WorkspaceHomeAiJob[]>(this.aggregate?.aiJobs ?? []);
	dueToday = $derived<WorkspaceHomeTask[]>(this.aggregate?.dueToday ?? []);
	pipelineByStage = $derived<WorkspacePipelineStageCounts[]>(this.aggregate?.pipelineByStage ?? emptyPipeline());
	counts = $derived(this.aggregate?.counts ?? EMPTY_COUNTS);
	// Distinct target-language codes across the whole workspace (sorted, upper-cased).
	// Workspace-scoped so the dashboard's "target languages" metric never changes when
	// a chapter is opened/closed. Empty until the aggregate loads or for an empty workspace.
	targetLangs = $derived<string[]>(this.aggregate?.targetLangs ?? []);
	// Stable, WORKSPACE-scoped hero project. Independent of projectStore.project so
	// the dashboard hero never changes when a chapter is opened/closed. null =
	// honest empty hero (no projects, or aggregate not loaded yet).
	recentProject = $derived<WorkspaceHomeRecentProject | null>(this.aggregate?.recentProject ?? null);

	/** True once a load has completed (success OR honest-empty) for the current workspace. */
	hasLoaded = $derived(this.aggregate !== null);
	/** True when the aggregate loaded but the member genuinely has no cross-project work. */
	isEmpty = $derived(this.aggregate !== null && this.aggregate.counts.projects === 0);

	async load(workspaceId?: string | null): Promise<void> {
		const wsId = workspaceId?.trim() || this.currentWorkspaceId?.trim();
		if (!wsId) {
			this.aggregate = null;
			this.currentWorkspaceId = null;
			return;
		}
		// Coalesce concurrent loads for the same workspace (the dashboard mount and a
		// sidebar/workspace-switch effect can both fire).
		if (this.inflight && this.inflight.workspaceId === wsId) {
			return this.inflight.promise;
		}
		// Switching workspaces: drop the previous aggregate immediately so a stale
		// workspace's My-Work never flashes under the new one.
		if (this.currentWorkspaceId && this.currentWorkspaceId !== wsId) {
			this.aggregate = null;
		}
		this.loading = true;
		this.error = null;
		this.currentWorkspaceId = wsId;
		const promise = (async () => {
			try {
				const result = await api.getWorkspaceHome(wsId);
				// Guard against a race where the workspace changed mid-flight.
				if (this.currentWorkspaceId !== wsId) return;
				this.aggregate = result;
				this.lastLoadedAt = Date.now();
			} catch (error) {
				if (this.currentWorkspaceId !== wsId) return;
				this.aggregate = null;
				this.lastLoadedAt = null;
				this.error = error instanceof Error ? error.message : "โหลดงานเวิร์กสเปซไม่สำเร็จ";
			} finally {
				if (this.currentWorkspaceId === wsId) this.loading = false;
				this.inflight = null;
			}
		})();
		this.inflight = { workspaceId: wsId, promise };
		return promise;
	}

	/** Drop all loaded state (logout / unauth / workspace teardown). */
	reset(): void {
		this.aggregate = null;
		this.loading = false;
		this.error = null;
		this.lastLoadedAt = null;
		this.currentWorkspaceId = null;
		this.inflight = null;
	}

	__resetForTesting(): void {
		this.reset();
	}
}

export const workspaceHomeStore = new WorkspaceHomeStore();
