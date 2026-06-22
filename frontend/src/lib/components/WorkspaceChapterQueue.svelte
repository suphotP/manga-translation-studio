<script lang="ts">
	import { _ } from "$lib/i18n";
	import { thumbnailUrl as buildThumbnailUrl } from "$lib/api/client.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { buildWorkspaceHref } from "$lib/navigation/workspace-routes.js";
	import {
		chapterQueueAssignees,
		chapterQueueSignals,
		getChapterQueueLeadPage,
		getChapterQueueStats,
		pageMatchesChapterQueueFilter,
		selectChapterQueuePages,
		type ChapterQueueAssignee,
		type ChapterQueueFilter,
	} from "$lib/project/chapter-queue.js";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { resolvePageStatusText, resolvePageSignalLabel, resolvePageSignalDetail } from "$lib/project/page-work-copy-i18n.js";
	import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
	import type { Page, ProjectState } from "$lib/types.js";
	import StatusPill, { type StatusTone } from "$lib/components/ui/StatusPill.svelte";
	import ProgressBar, { type ProgressTone } from "$lib/components/ui/ProgressBar.svelte";

	interface Props {
		project: ProjectState | null;
		summaries: PageWorkSummary[];
		selectedPageIndex: number | null;
		variant?: "compact" | "wide";
		onOpenPage: (pageIndex: number) => void | Promise<void>;
		onOpenWork: () => void;
		onOpenProjectPanel: () => void;
	}

	let {
		project,
		summaries,
		selectedPageIndex,
		variant = "compact",
		onOpenPage,
		onOpenWork,
		onOpenProjectPanel,
	}: Props = $props();

	let queueRoot = $state<HTMLElement>();
	let thumbnailFailures = $state<Record<string, boolean>>({});
	let stats = $derived(getChapterQueueStats(summaries));
	let leadPage = $derived(getChapterQueueLeadPage(summaries));
	// Default filter tab: "all" only when nothing needs attention, else "attention".
	let initialFilter = $derived<ChapterQueueFilter>(stats.totalPages > 0 && stats.attentionPages === 0 ? "all" : "attention");

	// Declarative view spec. The active tab latches to `initialFilter` at first
	// render (matching the old onMount-once default) and only changes when the
	// creator picks a tab; `searchQuery` mirrors the search box.
	let pickedFilter = $state<ChapterQueueFilter | null>(null);
	let searchQuery = $state("");
	let activeFilter = $derived<ChapterQueueFilter>(pickedFilter ?? initialFilter);

	// Latch the default once so later summary changes don't silently re-pick the
	// tab out from under the creator (the imperative version applied it on mount).
	$effect(() => {
		if (pickedFilter === null) pickedFilter = initialFilter;
	});

	// Single source of truth for which cards show: filter tab + search query,
	// derived from the pure chapter-queue module (no DOM mutation). The base
	// haystack carries the raw producer status/next-action codes; searchExtras
	// appends the LOCALIZED text this queue actually renders so typing the
	// visible status (e.g. "รอรีวิวผล") keeps matching in every locale.
	let selection = $derived(selectChapterQueuePages(summaries, {
		filter: activeFilter,
		search: searchQuery,
		searchExtras: (summary) => resolvePageStatusText(summary.statusLabel, $_, summary.statusLabel),
	}));
	let filteredPages = $derived(selection.filtered);
	let visiblePages = $derived(selection.visible);
	let visiblePageIndexes = $derived(new Set(visiblePages.map((summary) => summary.pageIndex)));
	let normalizedSearch = $derived(searchQuery.trim());
	let firstVisibleIndex = $derived(visiblePages[0]?.pageIndex ?? null);

	let coverSummary = $derived(leadPage ?? summaries[0] ?? null);
	let coverUrl = $derived(getThumbnailUrl(coverSummary, 320, 460));
	let coverParams = $derived(getThumbnailParams(coverSummary, 320, 460));

	function selectFilter(filter: ChapterQueueFilter): void {
		pickedFilter = filter;
		if (queueRoot) queueRoot.dataset.lastQueueAction = `filter:${filter}`;
	}

	function handleSearchInput(event: Event): void {
		const target = event.currentTarget;
		if (target instanceof HTMLInputElement) searchQuery = target.value;
	}

	// Reactively keep the data hooks the imperative path used to write, so any
	// external probes / debugging that read these attributes keep working, and
	// scroll the first match into view when a search narrows the list.
	$effect(() => {
		const root = queueRoot;
		if (!root) return;
		root.dataset.queueMounted = "true";
		root.dataset.queueFilter = activeFilter;
		root.dataset.queueSearch = searchQuery;
		root.dataset.queueVisibleCount = String(visiblePages.length);
		root.dataset.queueFilteredCount = String(filteredPages.length);
	});

	$effect(() => {
		// Depend on the visible set + query so this re-runs when search changes.
		const targetIndex = firstVisibleIndex;
		if (!normalizedSearch || targetIndex === null) return;
		const root = queueRoot;
		if (!root) return;
		const firstCard = root.querySelector<HTMLElement>(`[data-queue-card="page"][data-queue-page-index="${targetIndex}"]`);
		if (!firstCard) return;
		requestAnimationFrame(() => firstCard.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
	});

	function getPage(summary: PageWorkSummary | null): Page | null {
		if (!project || !summary) return null;
		return project.pages[summary.pageIndex] ?? null;
	}

	function getThumbnailKey(summary: PageWorkSummary | null): string | null {
		const page = getPage(summary);
		const imageId = getPagePreviewImageId(page ?? undefined);
		if (!project || !summary || !imageId) return null;
		return `${project.projectId}:${summary.pageIndex}:${imageId}`;
	}

	function getThumbnailUrl(summary: PageWorkSummary | null, width: number, height: number): string | null {
		const page = getPage(summary);
		const imageId = getPagePreviewImageId(page ?? undefined);
		const key = getThumbnailKey(summary);
		if (!project || !imageId || !key || thumbnailFailures[key]) return null;
		return buildThumbnailUrl(project.projectId, imageId, width, height);
	}

	// Asset identity for a queue thumbnail/cover <img> so signedAssetSrc can attach
	// a signed assetToken (a browser <img> has no Bearer header → 401).
	function getThumbnailParams(summary: PageWorkSummary | null, width: number, height: number): SignedAssetSrcParams | null {
		const page = getPage(summary);
		const imageId = getPagePreviewImageId(page ?? undefined);
		const url = getThumbnailUrl(summary, width, height);
		if (!project || !imageId || !url) return null;
		return {
			projectId: project.projectId,
			imageId,
			url,
			purpose: "thumbnail",
			// Mark failed only AFTER signedAssetSrc exhausts its token re-mint retry,
			// not on a raw <img onerror> (which aborts the re-sign on the first error,
			// leaving an expired-token thumbnail permanently broken).
			onFailed: () => markThumbnailFailed(summary),
		};
	}

	function markThumbnailFailed(summary: PageWorkSummary | null): void {
		const key = getThumbnailKey(summary);
		if (!key) return;
		thumbnailFailures = { ...thumbnailFailures, [key]: true };
	}

	function clearThumbnailFailure(summary: PageWorkSummary | null): void {
		const key = getThumbnailKey(summary);
		if (!key || !thumbnailFailures[key]) return;
		const nextFailures = { ...thumbnailFailures };
		delete nextFailures[key];
		thumbnailFailures = nextFailures;
	}

	function statusTone(summary: PageWorkSummary): string {
		if (summary.status === "blocked") return "blocked";
		if (summary.status === "review") return "review";
		if (summary.status === "ready") return "ready";
		return "working";
	}

	function statusToneCopy(summary: PageWorkSummary): string {
		if (summary.status === "blocked") return $_("chapterQueue.blocked");
		if (summary.status === "review") return $_("chapterQueue.reviewing");
		if (summary.status === "ready") return $_("pageWork.status.ready");
		return $_("pageWork.statusWorking");
	}

	// Structured production signals → the localized "{n} overdue / {n} notes / …"
	// line, or the "no blockers" copy when empty.
	function signalLabel(summary: PageWorkSummary): string {
		const signals = chapterQueueSignals(summary);
		if (!signals.length) return $_("chapterQueueSignal.none");
		return signals.map((signal) => $_(`chapterQueueSignal.${signal.code}`, { values: { n: signal.count } })).join(" / ");
	}

	// Structured assignee tokens → the localized assignee line, or "no assignee".
	function assigneeLabel(summary: PageWorkSummary): string {
		const tokens = chapterQueueAssignees(summary.assignees);
		if (!tokens.length) return $_("chapterQueueSignal.noAssignee");
		return tokens.map(assigneeTokenText).join(", ");
	}

	function assigneeTokenText(token: ChapterQueueAssignee): string {
		return "handle" in token ? token.handle : $_(`chapterQueueSignal.${token.code}`);
	}

	// Status, not coaching: cards show WHERE the page is, never "do this next"
	// instructions (prescriptive guidance is QC's job).
	function pageStatusText(summary: PageWorkSummary): string {
		return resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"));
	}

	function queueHeadingTitle(): string {
		if (!project) return $_("chapterQueue.headingSelectNext");
		if (stats.attentionPages > 0 && leadPage) return $_("chapterQueue.headingContinue", { values: { n: leadPage.pageNumber } });
		return $_("chapterQueue.headingViewAll");
	}

	function emptyFilterCopy(filter: ChapterQueueFilter = initialFilter): string {
		if (filter === "attention") return $_("chapterQueue.emptyAttention");
		if (filter === "blocked") return $_("chapterQueue.emptyBlocked");
		if (filter === "review") return $_("chapterQueue.emptyReview");
		if (filter === "tasks") return $_("chapterQueue.emptyTasks");
		if (filter === "ready") return $_("chapterQueue.emptyReady");
		return $_("chapterQueue.emptyAll");
	}

	// Empty-state copy: a search miss names the query, otherwise it explains the
	// empty filter tab — matching the old imperative empty-state text exactly.
	let emptyStateCopy = $derived(
		normalizedSearch ? $_("chapterQueue.emptyNoSearch", { values: { query: normalizedSearch } }) : emptyFilterCopy(activeFilter),
	);

	function pageMapLabel(summary: PageWorkSummary): string {
		return $_("chapterQueue.openPageMap", {
			values: {
				n: summary.pageNumber,
				status: resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback")),
				signals: signalLabel(summary),
			},
		});
	}

	function pageDisplayTitle(summary: PageWorkSummary): string {
		return $_("chapterQueue.pageN", { values: { n: summary.pageNumber } });
	}

	function pageEditorHref(summary: PageWorkSummary): string {
		return project
			? buildWorkspaceHref({ view: "editor", projectId: project.projectId, pageIndex: summary.pageIndex })
			: "#";
	}

	function openQueuePage(event: MouseEvent, pageIndex: number): void {
		// Preserve native open-in-new-tab/window shortcuts: only intercept a plain
		// left-click. Middle-click, Cmd/Ctrl-click and Shift-click fall through to the
		// browser so the <a href> opens the editor in a new tab/window as expected.
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		if (queueRoot) {
			queueRoot.dataset.lastQueueAction = `page:${pageIndex}`;
		}
		void onOpenPage(pageIndex);
	}

	type WorkflowStep = "raw" | "clean" | "translated" | "typeset" | "QC" | "export";

	function getPageWorkflowStep(summary: PageWorkSummary): WorkflowStep {
		const page = getPage(summary);
		if (!page) return "raw";
		if (summary.exportReady || page.qcHandoff?.status === "ready") {
			return "export";
		}
		if (
			page.qcHandoff?.status === "pending" ||
			page.qcHandoff?.status === "needs_fix" ||
			summary.qcErrorCount > 0 ||
			summary.openCommentCount > 0
		) {
			return "QC";
		}
		if (summary.layerCount > 0) {
			return "typeset";
		}
		if (
			page.translationHandoff?.status === "translated" ||
			(page.translationScriptSlots && page.translationScriptSlots.length > 0)
		) {
			return "translated";
		}
		if (page.cleaningHandoff?.status === "clean_ready") {
			return "clean";
		}
		return "raw";
	}

	function workflowStepLabel(step: WorkflowStep): string {
		if (step === "export") return $_("chapterQueue.stepExport");
		if (step === "QC") return $_("chapterQueue.stepQc");
		if (step === "typeset") return $_("chapterQueue.stepTypeset");
		if (step === "translated") return $_("chapterQueue.stepTranslated");
		if (step === "clean") return $_("chapterQueue.stepClean");
		return $_("chapterQueue.stepRaw");
	}

	function pageProgress(summary: PageWorkSummary): number {
		if (summary.exportReady) return 100;
		if (summary.status === "review") return 78;
		if (summary.status === "blocked") return 34;
		if (summary.layerCount > 0) return 64;
		if (summary.taskOpenCount > 0) return 48;
		return Math.max(12, Math.min(42, summary.pageNumber * 8));
	}

	function dueCopy(summary: PageWorkSummary): string {
		if (summary.overdueTaskCount > 0) return $_("chapterQueue.dueOverdue");
		if (summary.nextDueAt) return summary.nextDueAt.slice(0, 10);
		return summary.status === "review" ? $_("chapterQueue.dueReview") : $_("chapterQueue.dueNone");
	}

	function qcStateCopy(summary: PageWorkSummary): string {
		if (summary.qcErrorCount > 0) return "QC Blocked";
		if (summary.qcWarningCount > 0) return "QC Warning";
		if (summary.status === "review") return "Review";
		if (summary.exportReady) return "QC Clear";
		return "Todo";
	}

	type WorkflowStepTheme = { badge: string; bar: ProgressTone };

	function statusPillTone(summary: PageWorkSummary): StatusTone {
		if (summary.status === "blocked") return "late";
		if (summary.status === "review") return "review";
		if (summary.status === "ready") return "done";
		return "active";
	}

	function nextCardBorder(summary: PageWorkSummary): string {
		if (summary.status === "blocked") return "border-ws-rose/35";
		if (summary.status === "review") return "border-ws-amber/35";
		if (summary.status === "ready") return "border-ws-green/35";
		return "border-ws-violet/25";
	}

	function mapDotClass(summary: PageWorkSummary): string {
		if (summary.status === "blocked") return "border-ws-rose/40 bg-ws-rose/10 text-ws-rose";
		if (summary.status === "review") return "border-ws-amber/40 bg-ws-amber/10 text-ws-amber";
		if (summary.status === "ready") return "border-ws-green/40 bg-ws-green/10 text-ws-green";
		return "border-ws-violet/30 bg-ws-violet/10 text-ws-text/80";
	}

	function progressTone(summary: PageWorkSummary): ProgressTone {
		if (summary.status === "blocked") return "rose";
		if (summary.status === "review") return "amber";
		if (summary.exportReady) return "green";
		return "cyan";
	}

	const STEP_THEME: Record<WorkflowStep, WorkflowStepTheme> = {
		raw: { badge: "border-ws-line/25 bg-ws-surface2/70 text-ws-text/80", bar: "cyan" },
		clean: { badge: "border-ws-cyan/30 bg-ws-cyan/15 text-ws-cyan", bar: "cyan" },
		translated: { badge: "border-ws-blue/30 bg-ws-blue/15 text-ws-blue", bar: "cyan" },
		typeset: { badge: "border-ws-violet/30 bg-ws-violet/15 text-ws-violet", bar: "violet" },
		QC: { badge: "border-ws-amber/30 bg-ws-amber/15 text-ws-amber", bar: "amber" },
		export: { badge: "border-ws-green/30 bg-ws-green/15 text-ws-green", bar: "green" },
	};
</script>

<section
	bind:this={queueRoot}
	class="chapter-queue ws-panel rounded-ws p-4"
	class:wide={variant === "wide"}
	aria-label={$_("chapterQueue.sectionAria")}
>
	<div class="queue-heading mb-3 flex items-center justify-between gap-3">
		<div class="min-w-0">
			<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("chapterQueue.eyebrow")}</span>
			<h3 class="mt-0.5 text-[17px] font-extrabold leading-tight text-ws-ink">{queueHeadingTitle()}</h3>
		</div>
		<div class="queue-actions flex flex-wrap justify-end gap-2">
			{#if project}
				<button
					type="button"
					data-queue-action="project"
					onclick={() => { if (queueRoot) queueRoot.dataset.lastQueueAction = "project"; onOpenProjectPanel(); }}
					class="ws-btn-ghost inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-extrabold text-ws-text"
				>{$_("chapterQueue.reviewWork")}</button>
				{#if stats.attentionPages > 0}
					<button
						type="button"
						data-queue-action="work"
						onclick={() => { if (queueRoot) queueRoot.dataset.lastQueueAction = "work"; onOpenWork(); }}
						class="ws-grad-primary inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3.5 text-xs font-extrabold text-ws-bg transition hover:brightness-110"
					>
						{$_("chapterQueue.seePending")}
					</button>
				{:else}
					<span class="inline-flex min-h-10 items-center justify-center rounded-lg border border-ws-green/30 bg-ws-green/10 px-3 text-center text-xs font-black leading-tight text-ws-green">{$_("chapterQueue.noPending")}</span>
				{/if}
			{:else}
				<span class="inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-line/15 bg-ws-surface2/60 px-3 text-center text-xs font-black leading-tight text-ws-text/70">{$_("chapterQueue.openChapterFirst")}</span>
			{/if}
		</div>
	</div>

	{#if !project}
		<div class="empty-state flex min-h-[74px] items-center justify-center rounded-ws-card border border-dashed border-ws-line/15 bg-ws-surface2/40 px-3 text-center text-xs leading-snug text-ws-faint">{$_("chapterQueue.openWorkspaceHint")}</div>
	{:else}
		<div class={`chapter-layout grid gap-3 ${variant === "wide" ? "grid-cols-1" : "grid-cols-1 md:grid-cols-[178px_minmax(0,1fr)]"}`}>
			{#if variant !== "wide"}
				<div class="cover-pane grid min-w-0 content-start gap-2.5" aria-label={$_("chapterQueue.coverStatusAria")}>
					<div class="cover-frame flex h-[236px] items-center justify-center overflow-hidden rounded-ws border border-ws-line/12 bg-ws-bg">
						{#if coverUrl && coverParams}
							<img
								use:signedAssetSrc={coverParams}
								alt=""
								class="h-full w-full object-contain"
								onload={() => clearThumbnailFailure(coverSummary)}
							/>
						{:else}
							<div class="cover-fallback flex h-[124px] w-[86px] items-center justify-center rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 text-base font-black text-ws-faint">
								<span>{coverSummary ? `P${coverSummary.pageNumber}` : $_("chapterQueue.coverFallback")}</span>
							</div>
						{/if}
					</div>
					<div class="cover-meta grid min-w-0 gap-1">
						<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{project.targetLang.toUpperCase()}</span>
						<strong class="truncate text-sm font-extrabold text-ws-ink">{project.name}</strong>
						<small class="text-[11px] leading-snug text-ws-faint">
							{$_("chapterQueue.coverSummary", { values: { ready: stats.readyPages, total: stats.totalPages, attention: stats.attentionPages, tasks: stats.openTasks } })}
						</small>
					</div>
				</div>
			{/if}

			<div class="queue-pane grid min-w-0 gap-2.5">
				{#if leadPage}
					<div
						class={`chapter-next-card ${statusTone(leadPage)} grid grid-cols-1 items-center gap-3 rounded-xl border bg-ws-surface2/70 p-2.5 sm:grid-cols-[minmax(0,1fr)_auto] ${nextCardBorder(leadPage)}`}
						role="region"
						aria-label={$_("chapterQueue.nextWorkAria")}
					>
						<div class="grid min-w-0 gap-1">
							<span class="text-[10px] font-black uppercase tracking-wider text-ws-violet">{$_("chapterQueue.nextWork")}</span>
							<strong class="text-[15px] font-black text-ws-ink">{$_("chapterQueue.pageN", { values: { n: leadPage.pageNumber } })}</strong>
							<small class="truncate text-xs leading-snug text-ws-text/70">
								{resolvePageSignalLabel(leadPage.primarySignal, $_)} / {resolvePageSignalDetail(leadPage.primarySignal, $_) || pageStatusText(leadPage)}
							</small>
						</div>
						<button
							type="button"
							aria-label={$_("chapterQueue.openPageNAction", { values: { n: leadPage.pageNumber, action: pageStatusText(leadPage) } })}
							data-queue-page-index={leadPage.pageIndex}
							onclick={(event) => openQueuePage(event, leadPage.pageIndex)}
							class="inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/40 bg-ws-accent/15 px-3.5 text-xs font-black text-ws-accent transition hover:border-ws-accent/70 hover:bg-ws-accent/25 max-sm:w-full"
						>
							{$_("chapterQueue.openPageN", { values: { n: leadPage.pageNumber } })}
						</button>
					</div>
				{/if}

				<div class="queue-stats flex flex-wrap gap-2" aria-label={$_("chapterQueue.statsAria")}>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.blockedPages}</strong> {$_("chapterQueue.blocked")}</span>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.reviewPages}</strong> {$_("chapterQueue.reviewing")}</span>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.taskPages}</strong> {$_("chapterQueue.pagesWithWork")}</span>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.overduePages}</strong> {$_("chapterQueue.overdue")}</span>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.openComments}</strong> {$_("chapterQueue.notes")}</span>
					<span class="rounded-full border border-ws-line/12 bg-ws-surface2/55 px-2.5 py-1.5 text-[11px] font-bold text-ws-text/80"><strong class="font-black text-ws-ink">{stats.aiAttention}</strong> {$_("chapterQueue.aiResults")}</span>
				</div>

				<div class="queue-tabs ws-panel-quiet flex flex-wrap gap-1.5 rounded-ws-card p-1" aria-label={$_("chapterQueue.filtersAria")}>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "attention"} aria-pressed={activeFilter === "attention"} data-queue-filter="attention" onclick={() => selectFilter("attention")}>
						{$_("chapterQueue.tabAttention")}
					</button>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "blocked"} aria-pressed={activeFilter === "blocked"} data-queue-filter="blocked" onclick={() => selectFilter("blocked")}>
						{$_("chapterQueue.tabBlocked")}
					</button>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "review"} aria-pressed={activeFilter === "review"} data-queue-filter="review" onclick={() => selectFilter("review")}>
					{$_("chapterQueue.tabReview")}
					</button>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "tasks"} aria-pressed={activeFilter === "tasks"} data-queue-filter="tasks" onclick={() => selectFilter("tasks")}>
						{$_("chapterQueue.tabTasks")}
					</button>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "ready"} aria-pressed={activeFilter === "ready"} data-queue-filter="ready" onclick={() => selectFilter("ready")}>
						{$_("chapterQueue.tabReady")}
					</button>
					<button type="button" class="queue-tab ws-btn-ghost min-h-10 min-w-10 rounded-ws-ctrl px-2.5 text-[11px] font-extrabold text-ws-text" class:active={activeFilter === "all"} aria-pressed={activeFilter === "all"} data-queue-filter="all" onclick={() => selectFilter("all")}>
						{$_("chapterQueue.tabAll")}
					</button>
				</div>

				<div class="queue-search-row grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
					<label class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-xl border border-ws-line/15 bg-ws-bg/60">
						<span class="inline-flex min-h-10 items-center whitespace-nowrap border-r border-ws-line/12 px-2.5 text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("chapterQueue.searchLabel")}</span>
						<input
							type="search"
							data-queue-search="pages"
							value={searchQuery}
							oninput={handleSearchInput}
							onkeyup={handleSearchInput}
							placeholder={$_("chapterQueue.searchPlaceholder")}
							aria-label={$_("chapterQueue.searchAria")}
							class="min-h-10 min-w-0 border-0 bg-transparent px-3 text-xs font-semibold text-ws-text outline-none placeholder:text-ws-text/40"
						/>
					</label>
					<span class="queue-search-count inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-ws-card border border-ws-line/15 bg-ws-surface2/50 px-2.5 text-[11px] font-black text-ws-text/80 max-sm:justify-start" data-queue-search-count aria-live="polite">
						{$_("chapterQueue.searchCount", { values: { visible: visiblePages.length, total: filteredPages.length } })}
					</span>
				</div>

			<div class="chapter-map flex gap-1.5 overflow-x-auto px-px pb-1.5 pt-0.5 [scrollbar-width:thin]" aria-label={$_("chapterQueue.mapAria")}>
					{#each summaries as summary (summary.pageIndex)}
						<button
							type="button"
							class={`map-dot inline-flex h-10 w-10 min-h-10 min-w-10 flex-none items-center justify-center rounded-ws-ctrl border text-[10px] font-black transition ${mapDotClass(summary)} ${summary.pageIndex === selectedPageIndex ? "active !border-ws-accent/60 !bg-ws-accent/25 !text-ws-ink" : "hover:border-ws-accent/50 hover:bg-ws-surface2/70"}`}
							class:active={summary.pageIndex === selectedPageIndex}
							aria-label={pageMapLabel(summary)}
							title={pageMapLabel(summary)}
							data-queue-page-index={summary.pageIndex}
							onclick={(event) => openQueuePage(event, summary.pageIndex)}
						>
							<span>{summary.pageNumber}</span>
						</button>
					{/each}
				</div>

				<div class="empty-state compact flex min-h-[62px] items-center justify-center rounded-ws-card border border-dashed border-ws-line/15 bg-ws-surface2/40 px-3 text-center text-xs leading-snug text-ws-faint" data-queue-empty hidden={visiblePages.length > 0}>{emptyStateCopy}</div>
				<div
					class={`page-queue-list grid p-1 [scrollbar-width:thin] ${variant === "wide" ? "max-h-[min(58vh,720px)] grid-cols-1 gap-0 overflow-auto rounded-ws border border-ws-line/12 bg-ws-bg/60 !p-0" : "max-h-[410px] grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3 overflow-y-auto"}`}
					aria-label={$_("chapterQueue.listAria")}
				>
						{#each summaries as summary (summary.pageIndex)}
							{@const thumbUrl = getThumbnailUrl(summary, 160, 240)}
							{@const thumbParams = getThumbnailParams(summary, 160, 240)}
							{@const step = getPageWorkflowStep(summary)}
							<a
								href={pageEditorHref(summary)}
								class={`page-card group relative cursor-pointer font-sans no-underline transition ${
									variant === "wide"
										? "grid grid-cols-[58px_minmax(190px,1.25fr)_minmax(105px,0.58fr)_minmax(120px,0.6fr)_minmax(112px,0.55fr)_minmax(160px,0.75fr)] items-center gap-3.5 border-b border-ws-line/12 bg-ws-surface2/40 px-3 py-2.5 max-[980px]:grid-cols-[52px_minmax(0,1fr)_minmax(96px,auto)] hover:bg-ws-surface2/70"
										: "flex flex-col gap-2 rounded-ws-card border border-ws-line/12 bg-ws-surface2/50 p-2 hover:-translate-y-0.5 hover:border-ws-accent/40 hover:bg-ws-surface2/70"
								} ${summary.pageIndex === selectedPageIndex ? (variant === "wide" ? "active !border-ws-accent/30 !bg-ws-accent/10 ring-1 ring-ws-accent/30" : "active !border-ws-accent !bg-ws-surface2/90 ring-2 ring-ws-accent/30") : ""}`}
								class:active={summary.pageIndex === selectedPageIndex}
								hidden={!visiblePageIndexes.has(summary.pageIndex)}
								aria-label={$_("chapterQueue.pageCardAria", { values: { n: summary.pageNumber, name: summary.name || $_("chapterQueue.pageNoName"), step: workflowStepLabel(step) } })}
								aria-current={summary.pageIndex === selectedPageIndex ? "page" : undefined}
								data-queue-card="page"
								data-queue-attention={pageMatchesChapterQueueFilter(summary, "attention")}
								data-queue-blocked={pageMatchesChapterQueueFilter(summary, "blocked")}
								data-queue-review={pageMatchesChapterQueueFilter(summary, "review")}
								data-queue-tasks={pageMatchesChapterQueueFilter(summary, "tasks")}
								data-queue-ready={pageMatchesChapterQueueFilter(summary, "ready")}
								data-queue-page-index={summary.pageIndex}
								onclick={(event) => openQueuePage(event, summary.pageIndex)}
							>
								<div class={`page-card-thumb-container relative flex items-center justify-center overflow-hidden rounded-lg border border-ws-line/12 bg-ws-surface ${variant === "wide" ? "h-[54px] w-11" : "aspect-[2/3] w-full"}`}>
									{#if thumbUrl && thumbParams}
										<img
											use:signedAssetSrc={thumbParams}
											alt=""
											class="h-full w-full object-cover"
											onload={() => clearThumbnailFailure(summary)}
										/>
									{:else}
										<div class="page-card-fallback-gfx absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-ws-surface2 to-ws-bg">
											<span class="gfx-bg-lines absolute inset-0 bg-ws-line/5 opacity-50"></span>
											<span class="gfx-logo grid place-items-center text-ws-faint" aria-hidden="true">
												<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-[18px] w-[18px] [stroke-width:2]">
													<rect x="4" y="3" width="16" height="18" rx="2"/>
													<path d="M8 7h8M8 11h8M8 15h5"/>
												</svg>
											</span>
											<strong class="text-[13px] font-black tracking-wide text-ws-faint">P{summary.pageNumber}</strong>
										</div>
									{/if}
									<span class="page-num-badge absolute left-1.5 top-1.5 rounded border border-ws-line/12 bg-ws-bg/80 px-1.5 py-0.5 text-[9px] font-black text-ws-text">P{summary.pageNumber}</span>
									<span class={`page-step-badge step-${step} absolute right-1.5 top-1.5 rounded border px-1.5 py-0.5 text-[9px] font-black ${STEP_THEME[step].badge}`}>
										{workflowStepLabel(step)}
									</span>
								</div>

								<div class="page-card-meta flex min-w-0 flex-col gap-1">
									<strong class="page-card-title truncate text-xs font-extrabold text-ws-ink" title={summary.name}>{pageDisplayTitle(summary)}</strong>
									<span class="page-card-action truncate text-[10px] font-bold text-ws-faint" title={pageStatusText(summary)}>{pageStatusText(summary)}</span>
									<span class="page-card-assignee truncate text-[9px] font-semibold text-ws-text/50" title={assigneeLabel(summary)}>
										{assigneeLabel(summary)}
									</span>
								</div>

								<!-- The wide-variant row is a 6-column grid, but below 980px it collapses to a
								     3-column layout (thumb / meta / indicators). Hide the status, progress and
								     deadline cells there so the remaining cells stay on ONE aligned row instead
								     of wrapping/clipping. The narrow card variant keeps them in its own flow. -->
								<div class={`page-card-status grid min-w-0 gap-1.5 ${variant === "wide" ? "max-[980px]:hidden" : ""}`}>
									<StatusPill label={statusToneCopy(summary)} tone={statusPillTone(summary)} class="w-fit" />
									<small class="truncate text-[10px] font-bold text-ws-faint">{qcStateCopy(summary)}</small>
								</div>

								<div class={`page-card-progress-cell grid min-w-0 gap-1.5 ${variant === "wide" ? "max-[980px]:hidden" : ""}`}>
									<strong class="text-xs font-black text-ws-ink">{pageProgress(summary)}%</strong>
									<ProgressBar value={pageProgress(summary)} tone={progressTone(summary)} />
								</div>

								<div class={`page-card-deadline-cell grid min-w-0 gap-1.5 ${variant === "wide" ? "max-[980px]:hidden" : ""}`}>
									<strong class="text-xs font-black text-ws-ink">{dueCopy(summary)}</strong>
									<small class="truncate text-[10px] font-bold text-ws-faint">{summary.priorityLabel}</small>
								</div>

								<div class={`page-card-indicators mt-0.5 flex flex-wrap gap-1 ${variant === "wide" ? "justify-end !mt-0" : ""}`}>
									<span class="indicator-badge comment inline-flex min-h-6 items-center gap-0.5 rounded-md border border-ws-blue/25 bg-ws-blue/15 px-1.5 text-[9px] font-extrabold text-ws-blue" title={$_("chapterQueue.openNotesTitle", { values: { n: summary.openCommentCount } })}>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-3 w-3 [stroke-width:2.2]" aria-hidden="true">
											<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>
										</svg>
										{summary.openCommentCount}
									</span>
									<span class={`indicator-badge inline-flex min-h-6 items-center gap-0.5 rounded-md border px-1.5 text-[9px] font-extrabold ${summary.qcErrorCount > 0 ? "qc-error border-ws-rose/25 bg-ws-rose/15 text-ws-rose" : "qc-ok border-ws-cyan/25 bg-ws-cyan/15 text-ws-cyan"}`} title={$_("chapterQueue.qcTitle", { values: { n: summary.qcErrorCount + summary.qcWarningCount } })}>
										QC {summary.qcErrorCount + summary.qcWarningCount}
									</span>
									<span class="indicator-badge ai inline-flex min-h-6 items-center gap-0.5 rounded-md border border-ws-violet/25 bg-ws-violet/15 px-1.5 text-[9px] font-extrabold text-ws-violet" title={$_("chapterQueue.aiTitle", { values: { n: summary.aiAttentionCount } })}>
										AI {summary.aiAttentionCount}
									</span>
								</div>
							</a>
						{/each}
					</div>
			</div>
		</div>
	{/if}
</section>

<style>
	/* The reactive filter/search derives the `hidden` attribute on cards and the
	   empty state. The Tailwind display utilities above (grid/flex) would otherwise
	   win, so force the native `hidden` semantics for these hooks. */
	.page-card[hidden],
	.empty-state[hidden] {
		display: none;
	}

	/* Keep clicks resolving to the page-card anchor itself (preserves the original
	   delegated-click / onclick target behavior across the card's inner content). */
	.page-card * {
		pointer-events: none;
	}

	.page-card:focus-visible {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 2px;
	}

	/* Active filter highlight. The `active` class is bound reactively to the
	   selected filter tab, so the selected-state styling is keyed off the class
	   here rather than baked into the Tailwind template literal. */
	.queue-tab.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 15%, transparent);
		color: var(--color-ws-ink);
	}
</style>
