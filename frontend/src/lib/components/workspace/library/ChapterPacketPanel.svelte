<!-- ChapterPacketPanel — the chapter operating surface on the chapter route
	(aria-label "แพ็กเกจงานตอน {chapter} {LANG}"): the packet hero header + single
	primary CTA, the pipeline panel, the per-page queue (delegated to
	WorkspaceChapterQueue exactly as before), the collapsible production detail with
	job lanes + review/QC commands, and the collaboration rail.

	Behavior + visuals preserved verbatim. All projectStore reads stay in the
	orchestrator: the loaded `project`, page summaries, job lanes, review commands,
	and every label are precomputed and handed in; this composite only renders and
	bubbles callbacks. The `.chapter-operating-layout` / `.chapter-collaboration-rail`
	/ `.chapter-packet-head` classes are preserved so the parent-class layout still
	applies. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { formatLangCode } from "$lib/project/language-display.ts";
	import type { ProjectState } from "$lib/types.js";
	import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
	import type {
		WorkspaceProjectBrowserChapter,
		WorkspaceProjectBrowserGroup,
		WorkspaceJobLane,
	} from "$lib/project/workspace-dashboard.js";
	import WorkspaceChapterQueue from "$lib/components/WorkspaceChapterQueue.svelte";
	import WorkspaceMetricGrid, { type MetricItem } from "$lib/components/WorkspaceMetricGrid.svelte";
	import WorkspacePipelinePanel, { type PipelineCard } from "$lib/components/WorkspacePipelinePanel.svelte";
	import AvatarStack from "$lib/components/ui/AvatarStack.svelte";
	import ProgressBar from "$lib/components/ui/ProgressBar.svelte";

	// A review command shaped for display (mirrors the orchestrator's ChapterReviewCommand).
	export interface PacketReviewCommand {
		id: string;
		label: string;
		count: number;
		detail: string;
		tone: "hot" | "warn" | "ready" | "idle";
		hasItem: boolean;
		target: string;
		editorActionLabel: string;
	}

	let {
		chapter,
		title = null,
		coverParams,
		coverFallbackLabel,
		teamLabel,
		selfDisplayName,
		selfInitial,
		teamInitials,
		workspaceMemberCount,
		progressPercent,
		blockedLabel,
		heroMetricCards,
		pipelineAriaLabel,
		pipelineCards,
		productionMetricCards,
		isSoloMode,
		activeChapterLoaded,
		loadingThisChapter,
		// Loaded per-page queue
		project,
		pageSummaries,
		selectedPageIndex,
		// Job lanes
		jobLanes,
		openLaneCount,
		doneCount,
		taskCount,
		laneStatusLabel,
		// Review commands
		reviewCommands,
		activityCommands,
		todayOpenTaskCount,
		todayReviewCount,
		todayCommentCount,
		// Callbacks
		onOpenEditor,
		onOpenWork,
		onOpenSettings,
		onOpenFocus,
		onOpenPipelineAction,
		onOpenPage,
		onLoadPacketMap,
		onLoadPacketWork,
		onOpenLaneFocus,
		onCopyLaneLink,
		onFocusReviewCommand,
		onOpenReviewCommandInEditor,
		onCoverLoad,
		onCoverError,
	}: {
		chapter: WorkspaceProjectBrowserChapter;
		title?: WorkspaceProjectBrowserGroup | null;
		coverParams: SignedAssetSrcParams | null;
		coverFallbackLabel: string;
		teamLabel: string;
		selfDisplayName: string;
		selfInitial: string;
		teamInitials: string[];
		workspaceMemberCount: number;
		progressPercent: number;
		blockedLabel: string;
		heroMetricCards: MetricItem[];
		pipelineAriaLabel: string;
		pipelineCards: PipelineCard[];
		productionMetricCards: MetricItem[];
		isSoloMode: boolean;
		activeChapterLoaded: boolean;
		loadingThisChapter: boolean;
		project: ProjectState | null;
		pageSummaries: PageWorkSummary[];
		selectedPageIndex: number | null;
		jobLanes: WorkspaceJobLane[];
		openLaneCount: number;
		doneCount: number;
		taskCount: number;
		laneStatusLabel: (lane: WorkspaceJobLane) => string;
		reviewCommands: PacketReviewCommand[];
		activityCommands: PacketReviewCommand[];
		todayOpenTaskCount: number;
		todayReviewCount: number;
		todayCommentCount: number;
		onOpenEditor: () => void;
		onOpenWork: () => void;
		onOpenSettings?: () => void;
		onOpenFocus: () => void;
		onOpenPipelineAction: () => void;
		onOpenPage: (pageIndex: number) => void;
		onLoadPacketMap: () => void;
		onLoadPacketWork: () => void;
		onOpenLaneFocus: (lane: WorkspaceJobLane) => void;
		onCopyLaneLink: (lane: WorkspaceJobLane) => void;
		onFocusReviewCommand: (id: string) => void;
		onOpenReviewCommandInEditor: (id: string) => void;
		onCoverLoad?: () => void;
		onCoverError?: () => void;
	} = $props();

	// Route the cover-load failure through signedAssetSrc's onFailed (called only
	// AFTER its token re-mint retry) instead of a raw <img onerror>, which aborts
	// the re-sign on the first error and leaves an expired token's cover broken.
	let coverParamsWithFail = $derived<SignedAssetSrcParams | null>(
		coverParams ? { ...coverParams, onFailed: () => onCoverError?.() } : null,
	);

	function countLabel(value: number, label: string): string {
		return `${value} ${label}`;
	}

	// `WorkspaceJobLane.label` is now the stable task-type CODE (equals `lane.id`);
	// localize it via the `taskType.*` namespace (byte-exact with the lane's former
	// raw Thai label) so the packet job-lane title/aria stay localized.
	function laneLabel(lane: WorkspaceJobLane): string {
		return $_(`taskType.${lane.id}`);
	}
</script>

<section
	class="chapter-work-packet w-full max-w-[1480px]"
	aria-label={$_("chapterPacket.packetAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}
>
	<div class="chapter-operating-layout grid items-start gap-3.5">
		<div class="chapter-operating-main grid min-w-0 gap-3">
			<header class="chapter-packet-head ws-panel-quiet grid gap-5 rounded-ws p-5">
				<div class="chapter-hero-cover h-[206px] w-[150px] overflow-hidden rounded-ws-card border border-ws-line/12 bg-ws-bg" aria-hidden="true">
				{#if title && coverParamsWithFail}
					<img
						use:signedAssetSrc={coverParamsWithFail}
						alt=""
						class="h-full w-full object-cover"
						onload={() => onCoverLoad?.()}
					/>
				{:else if title}
					<div class="chapter-cover-fallback grid h-full w-full place-items-center text-2xl font-black text-ws-accent">{coverFallbackLabel}</div>
				{:else}
					<div class="chapter-cover-fallback grid h-full w-full place-items-center text-2xl font-black text-ws-accent">CH</div>
				{/if}
			</div>
			<div class="chapter-hero-copy grid min-w-0 content-center gap-2.5">
				<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-black uppercase tracking-wider">
					<span class="inline-flex items-center gap-1 rounded-ws-ctrl border border-ws-cyan/30 bg-ws-cyan/15 px-1.5 py-0.5 text-ws-cyan">{$_("chapterPacket.chapterEyebrow")}</span>
					<span class="truncate normal-case text-ws-text/60">{title?.title ?? chapter.project.name}</span>
				</span>
				<h2 class="text-[clamp(26px,3.4vw,44px)] font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{chapter.chapterLabel}</h2>
				<p class="text-xs font-semibold leading-snug text-ws-text/70">
					{formatLangCode(chapter.project.targetLang)} · {$_("chapterPacket.pageCount", { values: { count: chapter.project.pageCount } })} ·
					{$_("chapterPacket.lastUpdated", { values: { date: chapter.project.updatedAt.slice(0, 10) } })}
				</p>
				<div class="chapter-live-team flex min-w-0 flex-wrap items-center gap-2.5" aria-label={$_("chapterPacket.workingTeamAria")}>
					<strong class="text-[11px] font-black text-ws-text/70">{teamLabel ? $_("chapterPacket.team") : $_("chapterPacket.ownedBy")}</strong>
					<span class="text-xs font-black text-ws-ink">{(teamLabel || selfDisplayName).toUpperCase()}</span>
					<AvatarStack
						size="sm"
						items={teamInitials.map((avatar) => ({ initial: avatar }))}
						extra={Math.max(0, workspaceMemberCount - 1)}
					/>
				</div>
				<div class="chapter-progress-line flex min-w-0 items-center gap-2.5" aria-label={$_("chapterPacket.progressAria", { values: { percent: progressPercent } })}>
					<span class="shrink-0 whitespace-nowrap text-[11px] font-black text-ws-text/70">{$_("chapterPacket.chapterProgress")}</span>
					<ProgressBar class="min-w-0 flex-1 max-w-[420px]" value={progressPercent} />
					<strong class="shrink-0 text-xs font-black text-ws-ink">{progressPercent}%</strong>
				</div>
			</div>
			<div class="chapter-hero-actions grid content-center gap-2.5">
				{#if blockedLabel}
					<span class="library-action-receipt ws-panel-quiet inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{blockedLabel}</span>
				{:else}
					<button
						type="button"
						class="primary ws-grad-primary inline-flex min-h-11 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3.5 text-xs font-black text-white transition hover:brightness-110"
						onclick={onOpenEditor}
					>
						{$_("chapterPacket.goToNextWork")}
					</button>
					<button
						type="button"
						class="ws-btn-ghost inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-text hover:border-ws-accent/40"
						onclick={onOpenWork}
					>
						{$_("chapterPacket.openEditMode")}
					</button>
				{/if}
				{#if onOpenSettings}
				<button type="button" class="icon-action ws-btn-ghost inline-flex h-11 w-11 items-center justify-center justify-self-end rounded-ws-ctrl text-ws-text hover:border-ws-accent/40" aria-label={$_("chapterPacket.chapterOptionsAria")} onclick={onOpenSettings}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-[18px] w-[18px] [stroke-width:2.4]" aria-hidden="true">
						<circle cx="5" cy="12" r="1.5"/>
						<circle cx="12" cy="12" r="1.5"/>
						<circle cx="19" cy="12" r="1.5"/>
					</svg>
				</button>
				{/if}
			</div>
				<div class="chapter-hero-metrics-slot">
					<WorkspaceMetricGrid
						ariaLabel={$_("chapterPacket.statusNumbersAria")}
						variant="hero"
						columns="five"
						metrics={heroMetricCards}
					/>
				</div>
			</header>
		<WorkspacePipelinePanel
			ariaLabel={pipelineAriaLabel}
			eyebrow={$_("chapterPacket.pipelineEyebrow")}
			title="SCRIPT / CLEAN / TL / TYPESET / QC / DONE"
			actionLabel={$_("chapterPacket.viewAll")}
			variant="chapter"
			cards={pipelineCards}
			onAction={onOpenPipelineAction}
		/>
	{#if activeChapterLoaded && pageSummaries.length > 0}
		<WorkspaceChapterQueue
			project={project}
			summaries={pageSummaries}
			selectedPageIndex={selectedPageIndex}
			variant="wide"
			onOpenPage={onOpenPage}
			onOpenWork={onOpenFocus}
			onOpenProjectPanel={onOpenWork}
		/>
	{:else if activeChapterLoaded && pageSummaries.length === 0}
			<div class="chapter-page-scan-receipt empty-pages grid grid-cols-1 items-center gap-2.5 rounded-ws border border-ws-rose/30 bg-ws-rose/[0.07] p-3 min-[761px]:grid-cols-[minmax(0,0.36fr)_auto_minmax(0,1fr)_auto]" aria-label={$_("chapterPacket.pageStatusAria", { values: { chapter: chapter.chapterLabel } })}>
			<span class="text-[10px] font-black uppercase tracking-wider text-ws-rose">{$_("chapterPacket.pagesInChapter")}</span>
			<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.noPageImages")}</strong>
			<small class="min-w-0 text-xs font-semibold leading-snug text-ws-text/60 [overflow-wrap:anywhere]">{$_("chapterPacket.noPageImagesDetail")}</small>
			{#if blockedLabel}
				<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70 min-[761px]:justify-self-end">{blockedLabel}</span>
			{:else}
				<button
					type="button"
					class="inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-rose/40 bg-ws-rose/15 px-3 text-xs font-black text-ws-ink transition hover:bg-ws-rose/25 min-[761px]:justify-self-end max-[760px]:w-full"
					onclick={onOpenEditor}
				>
					{$_("chapterPacket.addPageImagesToStart")}
				</button>
			{/if}
		</div>
	{:else if !activeChapterLoaded}
			<div class="chapter-page-scan-receipt grid grid-cols-1 items-center gap-2.5 rounded-ws border border-ws-accent/20 bg-ws-accent/[0.07] p-3 min-[761px]:grid-cols-[minmax(0,0.36fr)_auto_minmax(0,1fr)_auto]" aria-label={$_("chapterPacket.pageStatusAria", { values: { chapter: chapter.chapterLabel } })}>
				<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("chapterPacket.pagesInChapter")}</span>
				<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.pageCount", { values: { count: chapter.project.pageCount } })}</strong>
				{#if loadingThisChapter}
					<small class="min-w-0 text-xs font-semibold leading-snug text-ws-text/60 [overflow-wrap:anywhere]">{$_("chapterPacket.loadingPageMap")}</small>
				<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70 min-[761px]:justify-self-end">{$_("chapterPacket.openingChapter")}</span>
				{:else if blockedLabel}
					<small class="min-w-0 text-xs font-semibold leading-snug text-ws-text/60 [overflow-wrap:anywhere]">{$_("chapterPacket.openToSeePageMap")}</small>
					<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70 min-[761px]:justify-self-end">{blockedLabel}</span>
				{:else}
					<small class="min-w-0 text-xs font-semibold leading-snug text-ws-text/60 [overflow-wrap:anywhere]">{$_("chapterPacket.openToSeePageMap")}</small>
					<button
						type="button"
						class="inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/30 bg-ws-accent/15 px-3 text-xs font-black text-ws-accent transition hover:bg-ws-accent/25 min-[761px]:justify-self-end max-[760px]:w-full"
						onclick={onLoadPacketMap}
					>
						{$_("chapterPacket.loadPageMap")}
					</button>
				{/if}
			</div>
	{/if}
		<details class="chapter-production-detail group/prod grid rounded-ws border border-ws-line/12 bg-ws-surface2/35">
			<summary class="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-2.5 [&::-webkit-details-marker]:hidden">
			<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{isSoloMode ? $_("chapterPacket.moreDetail") : $_("chapterPacket.chapterWorkDetail")}</span>
			<strong class="min-w-0 text-xs font-black text-ws-text [overflow-wrap:anywhere]">
				{#if isSoloMode}
					{$_("chapterPacket.pageAndTextLayers", { values: { pages: chapter.project.pageCount, layers: chapter.project.textLayerCount } })}
				{:else}
					{$_("chapterPacket.openTaskAndComment", { values: { tasks: chapter.project.openTaskCount ?? 0, comments: chapter.project.openCommentCount ?? 0 } })}
				{/if}
			</strong>
			<!-- SENTINEL: CSS ::after{content} cannot call $_(); the open/closed toggle is CSS-only via group-open. Kept hardcoded Thai ("เปิดรายละเอียด"/"ซ่อน"). -->
			<span class="justify-self-end whitespace-nowrap rounded-full border border-ws-line/12 px-2 py-1 text-[10px] font-black text-ws-faint after:content-['เปิดรายละเอียด'] group-open/prod:after:content-['ซ่อน']"></span>
		</summary>
		<div class="chapter-production-body flex max-h-[clamp(320px,60vh,720px)] flex-col gap-3 overflow-y-auto px-2.5 pb-2.5">
				<WorkspaceMetricGrid
					ariaLabel={$_("chapterPacket.productionSummaryAria", { values: { chapter: chapter.chapterLabel } })}
					variant="compact"
					columns="four"
					metrics={productionMetricCards}
				/>

			{#if activeChapterLoaded && !isSoloMode}
				<!-- Accordion 2: Roles / Lanes -->
			<details class="chapter-accordion-section group/lanes overflow-hidden rounded-ws-card border border-ws-line/12 bg-ws-surface2/30 open:border-ws-blue/30">
				<summary class="chapter-accordion-summary flex cursor-pointer list-none items-center justify-between gap-2 bg-ws-surface2/25 px-4 py-3 text-[13px] font-extrabold text-ws-text [&::-webkit-details-marker]:hidden after:text-[10px] after:text-ws-faint after:content-['▼'] after:transition-transform group-open/lanes:after:rotate-180">
						<span>{$_("chapterPacket.roleHandoffStage")}</span>
						<small class="text-[11px] font-semibold text-ws-faint">{$_("chapterPacket.roleList")}</small>
					</summary>
					<div class="chapter-accordion-content flex flex-col gap-3 border-t border-ws-line/[0.08] p-4">
						<div class="chapter-job-lanes grid w-full grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 max-[980px]:grid-cols-2 max-[760px]:grid-cols-1" aria-label={$_("chapterPacket.lanesAria", { values: { chapter: chapter.chapterLabel } })}>
					<div class="chapter-job-summary grid min-w-0 content-center gap-1 rounded-ws-ctrl border border-ws-accent/15 bg-ws-accent/[0.08] p-2.5">
								<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{countLabel(openLaneCount, $_("chapterPacket.activeLanes"))} / {$_("chapterPacket.doneCount", { values: { done: doneCount, total: taskCount } })}</span>
								<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.handoffStage")}</strong>
							</div>
							{#each jobLanes as lane (lane.id)}
					<article class={`chapter-job-card flex min-w-0 items-center justify-between gap-2.5 rounded-ws-ctrl border p-2.5 max-[760px]:flex-col max-[760px]:items-stretch ${lane.openCount > 0 ? "attention border-ws-accent/25 bg-ws-accent/[0.07]" : "border-ws-line/12 bg-ws-surface2/50"}`} class:attention={lane.openCount > 0}>
									<div class="min-w-0">
										<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{laneLabel(lane)}</span>
										<strong class="mt-1 block text-sm font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{laneStatusLabel(lane)}</strong>
										<small class="mt-1 block text-xs font-semibold leading-snug text-ws-text/70">{lane.firstOpenTaskTitle ?? $_("chapterPacket.noOpenWork")}{lane.nextDueAt ? $_("chapterPacket.dueSuffix", { values: { date: lane.nextDueAt.slice(0, 10) } }) : ""}</small>
									</div>
									<div class="chapter-job-actions grid flex-none gap-1.5 max-[760px]:[&>button]:w-full">
										{#if lane.firstOpenTaskId}
											<button
												type="button"
							class="ws-btn-ghost inline-flex min-h-10 min-w-[68px] items-center justify-center rounded-ws-ctrl px-2.5 text-[11px] font-black text-ws-text"
												aria-label={$_("chapterPacket.openLaneReviewAria", { values: { lane: laneLabel(lane), chapter: chapter.chapterLabel } })}
												onclick={() => onOpenLaneFocus(lane)}
											>
												{$_("chapterPacket.openList")}
											</button>
											<button
												type="button"
							class="ws-btn-ghost inline-flex min-h-10 min-w-[68px] items-center justify-center rounded-ws-ctrl px-2.5 text-[11px] font-black text-ws-text"
												aria-label={$_("chapterPacket.copyLaneLinkAria", { values: { lane: laneLabel(lane), chapter: chapter.chapterLabel } })}
												onclick={() => onCopyLaneLink(lane)}
											>
												{$_("chapterPacket.copyLink")}
											</button>
										{:else}
						<span class="library-action-receipt ready inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-green/30 bg-ws-green/10 px-2.5 text-center text-[11px] font-black leading-tight text-ws-green">{$_("chapterPacket.noOpenItems")}</span>
										{/if}
									</div>
								</article>
							{/each}
						</div>
					</div>
				</details>
			{/if}

			{#if activeChapterLoaded}
				<!-- Accordion 3: QC & Review -->
			<details class="chapter-accordion-section group/qc overflow-hidden rounded-ws-card border border-ws-line/12 bg-ws-surface2/30 open:border-ws-blue/30">
				<summary class="chapter-accordion-summary flex cursor-pointer list-none items-center justify-between gap-2 bg-ws-surface2/25 px-4 py-3 text-[13px] font-extrabold text-ws-text [&::-webkit-details-marker]:hidden after:text-[10px] after:text-ws-faint after:content-['▼'] after:transition-transform group-open/qc:after:rotate-180">
						<span>{isSoloMode ? $_("chapterPacket.checkPoints") : $_("chapterPacket.reviewAndQc")}</span>
						<small class="text-[11px] font-semibold text-ws-faint">{$_("chapterPacket.reviewQcSub")}</small>
					</summary>
					<div class="chapter-accordion-content flex flex-col gap-3 border-t border-ws-line/[0.08] p-4">
						<div class="chapter-review-followup grid w-full grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 max-[980px]:grid-cols-2 max-[760px]:grid-cols-1" aria-label={$_("chapterPacket.reviewFollowupAria", { values: { chapter: chapter.chapterLabel } })}>
							{#each reviewCommands as command (command.id)}
					<article class={`chapter-review-card ${command.tone} flex items-center justify-between gap-2.5 rounded-ws-ctrl border px-2.5 py-2.5 max-[760px]:flex-col max-[760px]:items-stretch ${command.tone === "warn" ? "border-ws-amber/25 bg-ws-amber/[0.08]" : command.tone === "ready" ? "border-ws-blue/25 bg-ws-blue/[0.08]" : command.tone === "hot" ? "border-ws-rose/30 bg-ws-rose/[0.08]" : "border-ws-line/12 bg-ws-surface2/50 opacity-75"}`} role="group" aria-label={$_("chapterPacket.reviewCardAria", { values: { label: command.label, chapter: chapter.chapterLabel } })}>
									<div class="min-w-0">
										<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{command.label}</span>
										<strong class="mt-1 block text-[22px] font-black leading-none text-ws-ink">{command.count}</strong>
										<small class="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-ws-text/70">{command.target}</small>
									</div>
									<div class="chapter-review-actions grid flex-none gap-1.5 max-[760px]:grid-cols-2">
										{#if command.hasItem}
											<button
												type="button"
							class="ws-btn-ghost inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-ws-ctrl px-2.5 text-[11px] font-black text-ws-text"
												aria-label={$_("chapterPacket.openReviewWorkAria", { values: { label: command.label, chapter: chapter.chapterLabel } })}
												onclick={() => onFocusReviewCommand(command.id)}
											>
												{$_("chapterPacket.openList")}
											</button>
											<button
												type="button"
							class="ws-btn-ghost inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-ws-ctrl px-2.5 text-[11px] font-black text-ws-text"
												aria-label={$_("chapterPacket.editorActionAria", { values: { action: command.editorActionLabel, label: command.label, chapter: chapter.chapterLabel } })}
												onclick={() => onOpenReviewCommandInEditor(command.id)}
											>
												{command.editorActionLabel}
											</button>
										{:else}
						<span class="library-action-receipt ready inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-green/30 bg-ws-green/10 px-2.5 text-center text-[11px] font-black leading-tight text-ws-green max-[760px]:col-span-2">{$_("chapterPacket.noPendingItems")}</span>
										{/if}
									</div>
								</article>
							{/each}
						</div>
					</div>
				</details>
			{:else}
			<div class="chapter-packet-empty flex flex-col items-stretch justify-between gap-2.5 rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 p-2.5 sm:flex-row sm:items-center">
					{#if loadingThisChapter}
						<p class="text-xs font-semibold leading-snug text-ws-text/70">{isSoloMode ? $_("chapterPacket.loadingSoloStatus") : $_("chapterPacket.loadingTeamStatus")}</p>
					<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{$_("chapterPacket.openingChapter")}</span>
					{:else if blockedLabel}
						<p class="text-xs font-semibold leading-snug text-ws-text/70">{isSoloMode ? $_("chapterPacket.openOnceSoloStatus") : $_("chapterPacket.openOnceTeamStatus")}</p>
					<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{blockedLabel}</span>
					{:else}
						<p class="text-xs font-semibold leading-snug text-ws-text/70">{isSoloMode ? $_("chapterPacket.openOnceSoloStatus") : $_("chapterPacket.openOnceTeamStatus")}</p>
						<button
							type="button"
						class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text max-sm:w-full"
							onclick={onLoadPacketWork}
						>
							{$_("chapterPacket.loadChapterWork")}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</details>
		</div>
		<aside class="chapter-collaboration-rail grid min-w-0 content-start gap-3" aria-label={$_("chapterPacket.collaborationAria")}>
			<section class="ws-panel-quiet grid gap-3 rounded-ws p-3.5">
				<header class="flex items-center justify-between gap-3">
					<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.teamInChapter")}</strong>
					<span class="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-ws-surface2/70 px-2 text-[11px] font-black text-ws-text">{workspaceMemberCount || 1}</span>
				</header>
				<div class="chapter-live-list grid gap-2.5">
					<article class="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5">
						<i class="grid h-7 w-7 place-items-center rounded-full border border-ws-line/15 bg-ws-accent/15 text-[10px] font-black not-italic text-ws-accent">{selfInitial}</i>
						<span class="grid min-w-0 gap-0.5">
							<strong class="truncate text-xs font-black text-ws-ink">{selfDisplayName}</strong>
							<small class="truncate text-[10px] font-semibold text-ws-text/60">{$_("chapterPacket.you")}</small>
						</span>
					</article>
					{#if workspaceMemberCount > 1}
						<p class="border-t border-ws-line/12 pt-2.5 text-[10px] font-semibold leading-snug text-ws-faint">{$_("chapterPacket.moreMembers", { values: { count: workspaceMemberCount - 1 } })}</p>
					{:else}
						<p class="border-t border-ws-line/12 pt-2.5 text-[10px] font-semibold leading-snug text-ws-faint">{$_("chapterPacket.inviteTeam")}</p>
					{/if}
				</div>
			</section>
			<section class="ws-panel-quiet grid gap-3 rounded-ws p-3.5">
				<header class="flex items-center justify-between gap-3">
					<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.thingsToDecide")}</strong>
					<button type="button" class="ws-btn-ghost inline-flex min-h-10 items-center rounded-ws-ctrl px-2.5 text-[10px] font-black text-ws-blue" onclick={onOpenFocus}>{$_("chapterPacket.viewAll")}</button>
				</header>
				{#if activityCommands.length > 0}
					<div class="chapter-activity-list grid gap-2.5">
						{#each activityCommands as command (`activity-${command.id}`)}
							<article class="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5">
								<i class={`grid h-7 w-7 place-items-center rounded-full border border-ws-line/15 text-[10px] font-black not-italic ${command.tone === "hot" ? "bg-ws-rose/15 text-ws-rose" : command.tone === "warn" ? "bg-ws-amber/15 text-ws-amber" : "bg-ws-accent/15 text-ws-accent"}`}>{command.count}</i>
								<span class="grid min-w-0 gap-0.5">
									<strong class="truncate text-xs font-black text-ws-ink">{command.label}</strong>
									<small class="truncate text-[10px] font-semibold text-ws-text/60">{command.detail}</small>
								</span>
							</article>
						{/each}
					</div>
				{:else if activeChapterLoaded}
					<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-5 text-center text-[11px] font-semibold leading-snug text-ws-faint">{$_("chapterPacket.nothingToDecide")}</p>
				{:else}
					<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-5 text-center text-[11px] font-semibold leading-snug text-ws-faint">{$_("chapterPacket.openToSeeDecisions")}</p>
				{/if}
			</section>
			<section class="ws-panel-quiet grid gap-3 rounded-ws p-3.5">
				<header class="flex items-center justify-between gap-3">
					<strong class="text-sm font-black text-ws-ink">{$_("chapterPacket.workInChapter")}</strong>
					<button type="button" class="ws-btn-ghost inline-flex min-h-10 items-center rounded-ws-ctrl px-2.5 text-[10px] font-black text-ws-blue" onclick={onOpenWork}>{$_("chapterPacket.viewAll")}</button>
				</header>
				{#if todayOpenTaskCount + todayReviewCount + todayCommentCount > 0}
					<div class="chapter-today-list grid gap-2.5 text-[11px] font-semibold text-ws-text/80">
						{#if todayOpenTaskCount > 0}
							<article class="grid gap-1 border-l-[3px] border-l-ws-violet py-2.5 pl-3">
								<strong class="truncate text-xs font-black text-ws-ink">{$_("chapterPacket.openTaskItems", { values: { count: todayOpenTaskCount } })}</strong>
								<small class="truncate text-[10px] font-semibold text-ws-text/60">{title?.title ?? $_("chapterPacket.openChapter")} {chapter.chapterLabel}</small>
							</article>
						{/if}
						{#if todayReviewCount > 0}
							<article class="grid gap-1 border-l-[3px] border-l-ws-amber py-2.5 pl-3">
								<strong class="truncate text-xs font-black text-ws-ink">{$_("chapterPacket.awaitingReviewItems", { values: { count: todayReviewCount } })}</strong>
								<small class="truncate text-[10px] font-semibold text-ws-text/60">{title?.title ?? $_("chapterPacket.openChapter")} {chapter.chapterLabel}</small>
							</article>
						{/if}
						{#if todayCommentCount > 0}
							<article class="grid gap-1 border-l-[3px] border-l-ws-cyan py-2.5 pl-3">
								<strong class="truncate text-xs font-black text-ws-ink">{$_("chapterPacket.openCommentItems", { values: { count: todayCommentCount } })}</strong>
								<small class="truncate text-[10px] font-semibold text-ws-text/60">{title?.title ?? $_("chapterPacket.openChapter")} {chapter.chapterLabel}</small>
							</article>
						{/if}
					</div>
				{:else}
					<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-5 text-center text-[11px] font-semibold leading-snug text-ws-faint">{$_("chapterPacket.noPendingWorkInChapter")}</p>
				{/if}
			</section>
		</aside>
	</div>
</section>
