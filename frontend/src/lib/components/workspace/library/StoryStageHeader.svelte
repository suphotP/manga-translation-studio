<!-- StoryStageHeader — the story hero (aria-label "เรื่องที่เลือก {title}"): cover +
	breadcrumb path, the title row with its single primary CTA + "ทางเลือกเรื่อง",
	the honest team/progress row, per-language progress cards, the story KPI grid,
	the language picker, the active-language command strip, and (on a chapter route)
	the chapter rail aside.

	Behavior + visuals preserved verbatim. The orchestrator owns every projectStore
	read: language card/button view-models and all labels are precomputed and handed
	in; this composite renders + bubbles callbacks. The `.library-title-stage`,
	`.stage-cover`, `.stage-copy`, `.story-hero-team`, `.story-kpis`, etc. classes are
	preserved so the parent-class story-dashboard layout still applies. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { formatLangCode } from "$lib/project/language-display.ts";
	import type {
		WorkspaceProjectBrowserChapter,
		WorkspaceProjectBrowserGroup,
		WorkspaceProjectLanguageSummary,
	} from "$lib/project/workspace-dashboard.js";
	import AvatarStack from "$lib/components/ui/AvatarStack.svelte";
	import ProgressBar from "$lib/components/ui/ProgressBar.svelte";
	import WorkspaceMetricGrid, { type MetricItem } from "$lib/components/WorkspaceMetricGrid.svelte";

	export interface LanguageProgressCardView {
		summary: WorkspaceProjectLanguageSummary;
		pct: number;
		primary: boolean;
		fillGradient: string;
	}
	export interface LanguageButtonView {
		summary: WorkspaceProjectLanguageSummary;
		active: boolean;
		attention: boolean;
		label: string;
	}

	let {
		title,
		chapterDetailIntent,
		activeStageChapter = null,
		hasCover,
		coverParams,
		coverFallbackLabel,
		selectedLanguage,
		selectedChapterLabel,
		activeChapterNextActionLabel = "",
		latestChapterLabel = "",
		primaryActionChapter = null,
		primaryActionLabel,
		primaryActionBlockedLabel,
		editorActionLabelForPrimary,
		teamLabel,
		selfDisplayName,
		selfInitial,
		selfAvatarInitials,
		workspaceMemberCount,
		progressPercent,
		isAssignedMode,
		sourceLang,
		languageProgressCards,
		storyMetricCards,
		storyMetricCardsCompact,
		languageButtons,
		// Active-language command strip
		languageCommand = null,
		// Chapter rail
		chapterRail = null,
		// Callbacks
		onOpenPrimaryEditor,
		onSelectPrimaryChapter,
		onOpenSettings,
		onSelectLanguage,
		onOpenLanguageEditor,
		onOpenLanguagePages,
		onOpenLanguageWork,
		onSelectRailChapter,
		onCoverLoad,
		onCoverError,
		titleProgressLabel,
	}: {
		title: WorkspaceProjectBrowserGroup;
		chapterDetailIntent: boolean;
		activeStageChapter?: WorkspaceProjectBrowserChapter | null;
		hasCover: boolean;
		coverParams: SignedAssetSrcParams | null;
		coverFallbackLabel: string;
		selectedLanguage: string | null;
		selectedChapterLabel: string;
		activeChapterNextActionLabel?: string;
		latestChapterLabel?: string;
		primaryActionChapter?: WorkspaceProjectBrowserChapter | null;
		primaryActionLabel: string;
		primaryActionBlockedLabel: string;
		editorActionLabelForPrimary: string;
		teamLabel: string;
		selfDisplayName: string;
		selfInitial: string;
		selfAvatarInitials: string[];
		workspaceMemberCount: number;
		progressPercent: number;
		isAssignedMode: boolean;
		sourceLang: string;
		languageProgressCards: LanguageProgressCardView[];
		storyMetricCards: MetricItem[];
		storyMetricCardsCompact: MetricItem[];
		languageButtons: LanguageButtonView[];
		languageCommand?: {
			summary: WorkspaceProjectLanguageSummary;
			chapter: WorkspaceProjectBrowserChapter;
			chaptersCountLabel: string;
			pageCountLabel: string;
			blockedLabel: string;
			editorActionLabel: string;
			pagesActionLabel: string;
			workActionLabel: string;
		} | null;
		chapterRail?: {
			chapters: WorkspaceProjectBrowserChapter[];
			rowLeadLabel: (chapter: WorkspaceProjectBrowserChapter) => string;
			nextActionChipLabel: (chapter: WorkspaceProjectBrowserChapter) => string;
			ariaLabel: (chapter: WorkspaceProjectBrowserChapter) => string;
			stateLabel: (chapter: WorkspaceProjectBrowserChapter) => string;
			openStateChipLabel: (chapter: WorkspaceProjectBrowserChapter) => string;
		} | null;
		onOpenPrimaryEditor: () => void;
		onSelectPrimaryChapter: () => void;
		onOpenSettings?: () => void;
		onSelectLanguage: (lang: string) => void;
		onOpenLanguageEditor: (lang: string) => void;
		onOpenLanguagePages: (lang: string) => void;
		onOpenLanguageWork: (lang: string) => void;
		onSelectRailChapter: (projectId: string) => void;
		onCoverLoad?: () => void;
		onCoverError?: () => void;
		titleProgressLabel: string;
	} = $props();

	// Route the cover-load failure through signedAssetSrc's onFailed (called only
	// AFTER its token re-mint retry is exhausted) instead of a raw <img onerror>,
	// which fires on the first error and aborts the re-sign — leaving an expired
	// token's cover permanently broken.
	let coverParamsWithFail = $derived<SignedAssetSrcParams | null>(
		coverParams ? { ...coverParams, onFailed: () => onCoverError?.() } : null,
	);
</script>

<section
	class="library-title-stage ws-panel-quiet w-full max-w-[1480px] rounded-ws text-ws-text"
	class:single-chapter={title.chapters.length <= 1}
	class:empty-cover={!hasCover}
	aria-label={$_("storyStageHeader.ariaSelectedStory", { values: { title: title.title } })}
>
	<div class="stage-cover relative aspect-[0.74] w-full overflow-hidden rounded-ws-card border border-ws-line/12 bg-ws-bg" class:empty-cover={!hasCover} aria-label={$_("storyStageHeader.ariaCover", { values: { title: title.title } })}>
		{#if coverParamsWithFail}
			<img
				use:signedAssetSrc={coverParamsWithFail}
				alt={title.coverOriginalName ?? $_("storyStageHeader.coverAlt", { values: { title: title.title } })}
				loading="lazy"
				class="h-full w-full object-cover"
				onload={() => onCoverLoad?.()}
			/>
		{:else}
			<div class="stage-cover-fallback absolute inset-0 grid grid-rows-[1fr_auto] items-end bg-ws-surface2 p-3 pl-5.5" aria-label={$_("storyStageHeader.ariaCoverFallback", { values: { title: title.title } })}>
				<span class="stage-spine absolute bottom-3 left-1.5 top-3 flex items-center text-[7px] font-black text-ws-text/40 [text-orientation:mixed] [writing-mode:vertical-rl]">{$_("storyStageHeader.story")}</span>
				<strong class="relative z-[1] inline-flex h-[38px] w-12 items-center justify-center rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/50 text-xl font-black text-ws-ink">{coverFallbackLabel}</strong>
				<small class="relative z-[1] mt-2.5 line-clamp-3 text-[11px] font-black leading-tight text-ws-text/90">{title.title}</small>
			</div>
		{/if}
	</div>

	<div class="stage-copy grid min-w-0 gap-3">
		<div class="stage-path flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-bold text-ws-faint" aria-label={$_("storyStageHeader.ariaPath")}>
				<span class="min-w-0 truncate rounded-full border border-ws-line/12 bg-ws-surface2/50 px-1.5 py-1">{$_("storyStageHeader.story")}</span>
				<strong class="min-w-0 truncate rounded-full border border-ws-line/12 bg-ws-surface2/50 px-1.5 py-1 text-ws-text">{title.title}</strong>
				<em class="min-w-0 truncate rounded-full border border-ws-line/12 bg-ws-surface2/50 px-1.5 py-1 not-italic text-ws-amber">{formatLangCode(selectedLanguage) || $_("storyStageHeader.language")}</em>
				<em class="min-w-0 truncate rounded-full border border-ws-line/12 bg-ws-surface2/50 px-1.5 py-1 not-italic text-ws-amber">{selectedChapterLabel}</em>
				{#if activeStageChapter}
					<em class="stage-status min-w-0 truncate rounded-full border border-ws-line/12 bg-ws-surface2/50 px-1.5 py-1 not-italic text-ws-amber">{activeChapterNextActionLabel}</em>
				{/if}
			</div>
		<div class="stage-title-row grid min-w-0 grid-cols-1 items-start justify-between gap-4.5">
			<div class="min-w-0">
				<span class="stage-eyebrow text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storyStageHeader.eyebrow")}</span>
				<h2 class="text-[clamp(22px,3.1vw,40px)] font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{title.title}</h2>
				<p class="mt-1.5 text-[11px] font-semibold leading-snug text-ws-text/70">
					{$_("storyStageHeader.chapterPageCount", { values: { chapters: title.chapterCount, pages: title.totalPages } })} /
					{title.targetLangs.map((lang) => formatLangCode(lang)).join(", ") || $_("storyStageHeader.noLanguage")}
					{latestChapterLabel ? $_("storyStageHeader.latestSuffix", { values: { label: latestChapterLabel } }) : ""}
				</p>
			</div>
			<div class="title-stage-actions flex flex-none flex-wrap items-start justify-end gap-2">
				{#if chapterDetailIntent && !activeStageChapter}
					{#if primaryActionChapter}
						{#if primaryActionBlockedLabel}
							<span class="library-action-receipt ws-panel-quiet inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-4 text-center text-xs font-black leading-tight text-ws-text/70">{primaryActionBlockedLabel}</span>
						{:else}
							<button
								type="button"
								class="primary ws-grad-primary inline-flex min-h-11 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-4 text-xs font-black text-white transition hover:brightness-110"
								onclick={onOpenPrimaryEditor}
							>
								{editorActionLabelForPrimary}
							</button>
						{/if}
					{/if}
				{:else if !chapterDetailIntent}
					{#if primaryActionChapter}
						{#if primaryActionBlockedLabel}
							<span class="library-action-receipt ws-panel-quiet inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-4 text-center text-xs font-black leading-tight text-ws-text/70">{primaryActionBlockedLabel}</span>
						{:else}
							<button
								type="button"
								class="primary ws-grad-primary inline-flex min-h-11 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-4 text-xs font-black text-white transition hover:brightness-110"
								onclick={onSelectPrimaryChapter}
							>
								{primaryActionLabel}
							</button>
						{/if}
					{/if}
				{/if}
				{#if onOpenSettings}
				<button
					type="button"
					class="title-secondary-actions ws-btn-ghost inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-4 text-xs font-black leading-tight text-ws-text hover:border-ws-accent/40"
					aria-haspopup="dialog"
					onclick={onOpenSettings}
				>
					{$_("storyStageHeader.storyOptions")}
				</button>
				{/if}
			</div>
		</div>
		{#if !chapterDetailIntent}
			<div class="story-hero-team grid w-full min-w-0 max-w-[540px] grid-cols-[auto_auto_minmax(40px,1fr)_auto] items-center gap-2.5" aria-label={$_("storyStageHeader.ariaTeamProgress", { values: { title: title.title } })}>
				<div class="flex min-w-0 items-center gap-2 text-[11px] font-bold text-ws-faint">
					<span>{teamLabel ? $_("storyStageHeader.team") : $_("storyStageHeader.maintainedBy")}</span>
					<strong class="truncate text-xs font-black text-ws-ink">{teamLabel || selfDisplayName}</strong>
				</div>
				<AvatarStack
					class="story-avatar-stack"
					size="sm"
					items={selfAvatarInitials.map((initial) => ({ initial }))}
					extra={Math.max(0, workspaceMemberCount - 1)}
				/>
				<ProgressBar
					class="story-hero-progress"
					value={progressPercent}
					ariaLabel={$_("storyStageHeader.ariaOverallProgress", { values: { percent: progressPercent } })}
				/>
				<small class="text-xs font-black text-ws-text">{progressPercent}%</small>
			</div>
				{#if languageProgressCards.length > 0}
					<div class="stage-lang-progress flex flex-wrap gap-2.5" aria-label={$_("storyStageHeader.ariaLangProgress", { values: { title: title.title } })}>
						{#each languageProgressCards as card (card.summary.lang)}
							<div class="min-w-[150px] flex-1 rounded-ws-card ws-panel-quiet p-3">
								<div class="mb-2 flex items-center justify-between">
								<span class={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] ${card.primary ? "border-ws-cyan/20 bg-ws-cyan/10 text-ws-cyan" : "border-ws-line/[0.07] bg-ws-surface2/50 text-ws-text"}`}>{formatLangCode(sourceLang)} → {formatLangCode(card.summary.lang)}</span>
									<span class={`text-[12px] font-semibold tabular-nums ${card.primary ? "text-ws-ink" : "text-ws-text"}`}>{card.pct}%</span>
								</div>
								<div class="ws-track h-1.5"><div class="ws-fill" style={`width:${card.pct}%; background:${card.fillGradient}`}></div></div>
								<p class="mt-1.5 text-[10.5px] text-ws-faint tabular-nums">{$_("storyStageHeader.cardChapterPage", { values: { chapters: card.summary.chapterCount, totalChapters: title.chapterCount, pages: card.summary.pageCount } })}{card.summary.openTasks ? $_("storyStageHeader.cardOpenSuffix", { values: { open: card.summary.openTasks } }) : ""}</p>
							</div>
						{/each}
						{#if !isAssignedMode}
							{#if onOpenSettings}
							<button type="button" class="ws-btn-ghost flex h-11 w-11 shrink-0 items-center justify-center rounded-ws-ctrl text-ws-faint" aria-label={$_("storyStageHeader.ariaAddLanguage")} onclick={onOpenSettings}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
							</button>
							{/if}
						{/if}
					</div>
				{/if}
				<div class="story-hero-roles flex items-center gap-1.5 text-[11px] text-ws-faint">
					<span class="flex items-center gap-1"><span class="ws-dot bg-ws-green"></span>{$_("storyStageHeader.roleClean")}</span>
					<span class="flex items-center gap-1"><span class="ws-dot bg-ws-cyan"></span>{$_("storyStageHeader.roleTranslate")}</span>
					<span class="flex items-center gap-1"><span class="ws-dot bg-ws-violet"></span>{$_("storyStageHeader.roleTypeset")}</span>
					<span class="flex items-center gap-1"><span class="ws-dot bg-ws-amber"></span>QC</span>
					<span class="flex items-center gap-1 text-ws-faint"><span class="ws-dot bg-ws-faint"></span>{$_("storyStageHeader.roleReview")}</span>
				</div>
				<div class="story-kpis">
					<WorkspaceMetricGrid
						ariaLabel={$_("storyStageHeader.ariaStorySummary", { values: { title: title.title } })}
						variant="story"
						columns="five"
						metrics={storyMetricCards}
					/>
				</div>
			{:else}
				<!-- SENTINEL: after:content-['เปิด'] / group-open:after:content-['ปิด'] is a
				     Tailwind CSS ::after pseudo-element content; Thai inside a class attribute
				     cannot be routed through $_() (same residual as ChapterPacketPanel). -->
				<details class="stage-detail-drawer group rounded-ws border border-ws-line/12 bg-ws-surface2/35 px-2.5 py-2" aria-label={$_("storyStageHeader.ariaStorySummary", { values: { title: title.title } })}>
					<summary class="grid min-h-11 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 [&::-webkit-details-marker]:hidden">
						<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storyStageHeader.storyDetails")}</span>
						<strong class="truncate text-xs font-black text-ws-text">{$_("storyStageHeader.chapterPageCount", { values: { chapters: title.chapterCount, pages: title.totalPages } })}</strong>
						<span class="text-[11px] font-black text-ws-faint after:content-['เปิด'] group-open:after:content-['ปิด']"></span>
					</summary>
					<WorkspaceMetricGrid
						ariaLabel={$_("storyStageHeader.ariaStorySummary", { values: { title: title.title } })}
						variant="compact"
						columns="four"
						metrics={storyMetricCardsCompact}
					/>
				</details>
			{/if}
		{#if languageButtons.length > 0}
			<div class="stage-languages flex min-w-0 flex-wrap gap-1.5" aria-label={$_("storyStageHeader.ariaLanguages", { values: { title: title.title } })}>
				{#each languageButtons as button (button.summary.lang)}
					<button
							type="button"
						class={`stage-language-button max-w-full min-h-10 truncate rounded-ws-ctrl border px-2 py-1.5 text-[10px] font-black leading-tight transition ${
								button.active
									? "active border-ws-accent/40 bg-ws-accent/15 text-ws-accent"
									: button.attention
										? "attention border-ws-amber/30 bg-ws-amber/10 text-ws-amber hover:border-ws-amber/45"
									: "border-ws-line/15 bg-ws-surface2/50 text-ws-text/70 hover:border-ws-accent/40 hover:bg-ws-surface2/70"
							}`}
							class:active={button.active}
							class:attention={button.attention}
							aria-label={$_("storyStageHeader.ariaOpenLanguage", { values: { lang: formatLangCode(button.summary.lang), title: title.title } })}
							onclick={() => onSelectLanguage(button.summary.lang)}
						>
							{button.label}
						</button>
					{/each}
				</div>
			{/if}
			{#if languageCommand}
				<section class="language-command flex min-w-0 flex-col items-stretch justify-between gap-3 rounded-ws border border-ws-accent/30 bg-ws-accent/[0.06] p-2.5 sm:flex-row sm:items-center" aria-label={$_("storyStageHeader.ariaLanguageRoute", { values: { lang: formatLangCode(languageCommand.summary.lang) } })}>
					<div class="grid min-w-0 gap-0.5">
						<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storyStageHeader.language")}</span>
					<strong class="text-[22px] font-black leading-none text-ws-ink">{formatLangCode(languageCommand.summary.lang)}</strong>
					<small class="text-[11px] font-semibold leading-snug text-ws-text/70">
						{languageCommand.chaptersCountLabel} / {languageCommand.pageCountLabel} /
						{$_("storyStageHeader.openTasksReview", { values: { open: languageCommand.summary.openTasks, review: languageCommand.summary.reviewTasks } })}
					</small>
				</div>
					<div class="language-command-actions flex flex-none flex-wrap items-center justify-end gap-1.5 max-sm:[&>button]:flex-1">
						{#if languageCommand.blockedLabel}
							<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{languageCommand.blockedLabel}</span>
						{:else}
							<button
								type="button"
								class="primary ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3 text-xs font-black text-white transition hover:brightness-110"
								aria-label={$_("storyStageHeader.ariaEditorAction", { values: { action: languageCommand.editorActionLabel, lang: formatLangCode(languageCommand.summary.lang) } })}
								onclick={() => onOpenLanguageEditor(languageCommand.summary.lang)}
							>
								{languageCommand.editorActionLabel}
							</button>
							<details class="language-secondary-actions group relative grid gap-2 open:rounded-ws-card open:border open:border-ws-line/12 open:bg-ws-surface2/60 open:p-2">
								<summary class="ws-btn-ghost inline-flex min-h-10 cursor-pointer list-none items-center justify-center whitespace-nowrap rounded-ws-ctrl px-3 text-xs font-bold text-ws-text group-open:border-ws-accent/30 group-open:bg-ws-accent/10 [&::-webkit-details-marker]:hidden">{$_("storyStageHeader.languageOptions", { values: { lang: formatLangCode(languageCommand.summary.lang) } })}</summary>
								<button
									type="button"
									aria-label={$_("storyStageHeader.ariaOpenLanguagePages", { values: { lang: formatLangCode(languageCommand.summary.lang) } })}
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text"
									onclick={() => onOpenLanguagePages(languageCommand.summary.lang)}
								>
									{languageCommand.pagesActionLabel}
								</button>
								<button
									type="button"
									aria-label={$_("storyStageHeader.ariaOpenLanguageWork", { values: { lang: formatLangCode(languageCommand.summary.lang) } })}
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text"
									onclick={() => onOpenLanguageWork(languageCommand.summary.lang)}
								>
									{languageCommand.workActionLabel}
								</button>
							</details>
						{/if}
					</div>
				</section>
			{/if}
	<p class="stage-progress mt-1.5 text-xs font-semibold leading-snug text-ws-text/70">{titleProgressLabel}</p>
</div>

{#if chapterRail}
	<aside class="stage-chapters flex min-w-0 flex-col gap-2 rounded-ws border border-ws-line/12 bg-ws-surface2/35 p-2.5" aria-label={$_("storyStageHeader.ariaChapterList", { values: { title: title.title } })}>
		<div class="stage-chapters-head flex items-center justify-between gap-2">
			<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storyStageHeader.chapters")}</span>
			<small class="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-ws-surface2/70 text-[10px] font-black text-ws-text">{chapterRail.chapters.length}</small>
			</div>
			<div class="stage-chapter-list grid max-h-[min(344px,calc(100vh-330px))] gap-1.5 overflow-auto pr-0.5">
				{#each chapterRail.chapters as chapter (chapter.project.projectId)}
					<button
						type="button"
					class={`grid min-h-11 min-w-0 grid-cols-[42px_minmax(0,1fr)_minmax(64px,auto)] items-center gap-2 rounded-ws-ctrl border p-1.5 text-left transition ${chapter.project.projectId === activeStageChapter?.project.projectId ? "active border-ws-accent/40 bg-ws-accent/15" : "border-ws-line/12 bg-ws-surface2/25 hover:border-ws-accent/40 hover:bg-ws-surface2/60"}`}
						class:active={chapter.project.projectId === activeStageChapter?.project.projectId}
						aria-label={chapterRail.ariaLabel(chapter)}
						onclick={() => onSelectRailChapter(chapter.project.projectId)}
					>
						<span class="col-span-full truncate text-[11px] font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{chapterRail.rowLeadLabel(chapter)}</span>
						<strong class="justify-self-start truncate rounded-full bg-ws-blue/15 px-1.5 py-0.5 text-[10px] font-black text-ws-blue">{formatLangCode(chapter.project.targetLang)}</strong>
						<small class="truncate text-[10px] font-semibold text-ws-faint">{chapterRail.nextActionChipLabel(chapter)}</small>
					<em class={`state-${chapter.workState} justify-self-end truncate rounded-full border px-1.5 py-0.5 text-[10px] font-black not-italic ${chapter.workState === "attention" ? "border-ws-amber/25 bg-ws-amber/10 text-ws-amber" : chapter.workState === "review" ? "border-ws-blue/25 bg-ws-blue/10 text-ws-blue" : chapter.workState === "active" ? "border-ws-green/20 bg-ws-green/10 text-ws-green" : "border-ws-line/15 bg-ws-surface2/60 text-ws-text/80"}`}>{chapterRail.stateLabel(chapter)}</em>
						<small class="open-state col-span-2 truncate text-[10px] font-bold text-ws-accent">{chapterRail.openStateChipLabel(chapter)}</small>
					</button>
				{/each}
			</div>
		</aside>
	{/if}
</section>
