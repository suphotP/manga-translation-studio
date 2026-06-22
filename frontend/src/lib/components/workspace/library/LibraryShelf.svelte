<!-- LibraryShelf — the manga cover-card shelf shown on the library-home route
	(aria-label "คลังการ์ตูนทั้งหมด"). Composes the page heading + create CTA,
	LibraryFilterBar, and the in-progress / completed title grids built from
	LibraryTitleCard. All grouping/sorting/filtering and projectStore reads stay in
	the orchestrator, which hands in precomputed card view-models. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import SectionBand from "$lib/components/ui/SectionBand.svelte";
	import LibraryFilterBar from "./LibraryFilterBar.svelte";
	import LibraryTitleCard from "./LibraryTitleCard.svelte";

	type LibraryHomeTab = "all" | "solo" | "team" | "urgent" | "deadline" | "assigned" | "review";
	type LibraryHomeFilter = "all" | "attention" | "active" | "ready" | "setup";
	type LibraryHomeSort = "latest" | "attention" | "progress";
	type LibraryProjectViewMode = "grid" | "list";

	type CoverStatusTone = "violet" | "amber" | "cyan" | "green" | "rose" | "faint";
	export interface LibraryTitleCardView {
		title: WorkspaceProjectBrowserGroup;
		tone: CoverStatusTone;
		progress: number;
		extra: number;
		coverUrl: string | null;
		statusLabel: string;
		dotToneClass: string;
		chapterLabel: string;
		languagePairs: import("$lib/components/ui/LanguageCoverageChips.svelte").LanguagePair[];
		progressGradient: string;
		avatarInitials: string[];
		relativeUpdate: string;
	}

	let {
		storyCount,
		languageCount,
		activeChapterCount,
		searchQuery = $bindable(""),
		homeFilter = $bindable<LibraryHomeFilter>("all"),
		homeTab = $bindable<LibraryHomeTab>("all"),
		homeSort = $bindable<LibraryHomeSort>("latest"),
		viewMode = $bindable<LibraryProjectViewMode>("grid"),
		tabs,
		tabCount,
		filteredCount,
		inProgress,
		completed,
		onCreate,
		onSelectTitle,
		onResetFilters,
	}: {
		storyCount: number;
		languageCount: number;
		activeChapterCount: number;
		searchQuery?: string;
		homeFilter?: LibraryHomeFilter;
		homeTab?: LibraryHomeTab;
		homeSort?: LibraryHomeSort;
		viewMode?: LibraryProjectViewMode;
		tabs: readonly { id: LibraryHomeTab; label: string; counted?: boolean }[];
		tabCount: (tab: LibraryHomeTab) => number;
		filteredCount: number;
		inProgress: LibraryTitleCardView[];
		completed: LibraryTitleCardView[];
		/** Absent ⇒ viewer cannot create stories (owner/admin-only); hide the CTA. */
		onCreate?: () => void;
		onSelectTitle: (titleKey: string) => void;
		onResetFilters: () => void;
	} = $props();

	let gridClass = $derived(
		viewMode === "list" ? "grid-cols-1" : "[grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]",
	);
	let isList = $derived(viewMode === "list");
</script>

<section class="library-overview grid w-full max-w-[1280px] gap-7 @container" aria-label={$_("libraryShelf.regionLabel")}>
	<!-- PAGE HEADING -->
	<header class="library-overview-head flex flex-wrap items-end justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-[clamp(20px,2.4vw,26px)] font-semibold leading-tight tracking-tight text-ws-ink [overflow-wrap:anywhere]">{$_("libraryShelf.headingAll")} <span class="ws-text-grad">·</span> {$_("libraryShelf.headingScope")}</h1>
			<p class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] text-ws-text">
				<NumberValue value={storyCount} class="font-medium text-ws-ink" /> {$_("libraryShelf.summaryStoriesSuffix")} ·
				<NumberValue value={languageCount} class="text-ws-cyan" /> {$_("libraryShelf.summaryLanguagesSuffix")} ·
				<NumberValue value={activeChapterCount} class="text-ws-amber" /> {$_("libraryShelf.summaryActiveChaptersSuffix")}
			</p>
		</div>
		{#if onCreate}
			<button
				type="button"
				class="ws-grad-primary relative inline-flex h-10 shrink-0 items-center gap-2 rounded-ws-ctrl border border-ws-accent/35 px-5 text-[14px] font-semibold text-white transition hover:brightness-110"
				onclick={onCreate}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="relative" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
				<span class="relative">{$_("libraryShelf.createImport")}</span>
			</button>
		{/if}
	</header>

	<!-- FILTER + TOOLBAR -->
	<LibraryFilterBar
		bind:searchQuery={searchQuery}
		bind:homeFilter={homeFilter}
		bind:homeTab={homeTab}
		bind:homeSort={homeSort}
		bind:viewMode={viewMode}
		tabs={tabs}
		tabCount={tabCount}
	/>

	{#if filteredCount === 0}
		<div class="library-no-results ws-panel-quiet grid justify-items-start gap-2 rounded-ws border-dashed border-ws-line/24 p-5 text-ws-text">
			<strong class="font-semibold text-ws-ink">{$_("libraryShelf.noResultsTitle")}</strong>
			<span class="text-xs text-ws-faint">{$_("libraryShelf.noResultsHint")}</span>
			<button type="button" onclick={onResetFilters} class="ws-btn-ghost mt-1 inline-flex min-h-10 items-center rounded-ws-ctrl px-3 text-xs font-semibold text-ws-accent">{$_("libraryShelf.clearFilters")}</button>
		</div>
	{/if}

	{#if inProgress.length > 0}
		<section aria-label={$_("libraryShelf.inProgressRegion")}>
			<SectionBand title={$_("libraryShelf.inProgressTitle")} subtitle={$_("libraryShelf.inProgressSubtitle")} class="mb-3.5">
				{#snippet action()}
					<span class="flex items-center gap-1 text-[12px] font-normal text-ws-faint"><NumberValue value={inProgress.length} /> {$_("libraryShelf.storiesUnit")}</span>
				{/snippet}
			</SectionBand>
			<div class={`grid gap-4 ${gridClass}`}>
				{#each inProgress as view (view.title.id)}
					<LibraryTitleCard
						title={view.title}
						done={false}
						isList={isList}
						tone={view.tone}
						progress={view.progress}
						extra={view.extra}
						coverUrl={view.coverUrl}
						statusLabel={view.statusLabel}
						dotToneClass={view.dotToneClass}
						chapterLabel={view.chapterLabel}
						languagePairs={view.languagePairs}
						progressGradient={view.progressGradient}
						avatarInitials={view.avatarInitials}
						relativeUpdate={view.relativeUpdate}
						onOpen={() => onSelectTitle(view.title.id)}
					/>
				{/each}
			</div>
		</section>
	{/if}

	{#if completed.length > 0}
		<section class="pb-2" aria-label={$_("libraryShelf.completedRegion")}>
			<SectionBand title={$_("libraryShelf.completedTitle")} subtitle={$_("libraryShelf.completedSubtitle")} class="mb-3.5">
				{#snippet action()}
					<span class="flex items-center gap-1 text-[12px] font-normal text-ws-faint"><NumberValue value={completed.length} /> {$_("libraryShelf.storiesUnit")}</span>
				{/snippet}
			</SectionBand>
			<div class={`grid gap-4 ${gridClass}`}>
				{#each completed as view (view.title.id)}
					<LibraryTitleCard
						title={view.title}
						done={true}
						isList={isList}
						tone={view.tone}
						progress={view.progress}
						extra={view.extra}
						coverUrl={view.coverUrl}
						statusLabel={view.statusLabel}
						dotToneClass={view.dotToneClass}
						chapterLabel={view.chapterLabel}
						languagePairs={view.languagePairs}
						progressGradient={view.progressGradient}
						avatarInitials={view.avatarInitials}
						relativeUpdate={view.relativeUpdate}
						onOpen={() => onSelectTitle(view.title.id)}
					/>
				{/each}
			</div>
		</section>
	{/if}
</section>
