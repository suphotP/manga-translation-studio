<!-- StoryChapterBoard — the chapter list of a story hub (aria-label
	"ตอนทั้งหมดของ {title}"). Composes ui/ChapterRow for each visible chapter,
	plus the add-chapter / assigned-queue header and the pager. All chapter row
	props are precomputed by the orchestrator (which owns the projectStore reads
	and the role/progress derivation) and handed in as a `rows` view-model array. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceProjectBrowserGroup, WorkspaceProjectBrowserChapter } from "$lib/project/workspace-dashboard.js";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import SectionBand from "$lib/components/ui/SectionBand.svelte";
	import ChapterRow, {
		type ChapterLangProgress,
		type ChapterRoleBadge,
		type ChapterRowCount,
	} from "$lib/components/ui/ChapterRow.svelte";

	export interface StoryChapterRowView {
		chapter: WorkspaceProjectBrowserChapter;
		label: string;
		title: string;
		langs: ChapterLangProgress[];
		roles: ChapterRoleBadge[];
		revised: boolean;
		due: string;
		dueLate: boolean;
		counts: ChapterRowCount[];
		active: boolean;
	}

	let {
		title,
		isAssignedMode,
		assignedRoleLabel,
		assignedRoleChapterCount,
		rows,
		emptyLabel,
		showPager,
		pageNumbers,
		effectivePage,
		pageCount,
		rangeStart,
		rangeEnd,
		totalChapters,
		onAddChapter,
		onSelectChapter,
		onSetPage,
	}: {
		title: WorkspaceProjectBrowserGroup;
		isAssignedMode: boolean;
		assignedRoleLabel: string;
		assignedRoleChapterCount: number;
		rows: StoryChapterRowView[];
		emptyLabel: string;
		showPager: boolean;
		pageNumbers: number[];
		effectivePage: number;
		pageCount: number;
		rangeStart: number;
		rangeEnd: number;
		totalChapters: number;
		/** Absent ⇒ the viewer cannot shape the catalog (owner/admin-only); hide the button. */
		onAddChapter?: () => void;
		onSelectChapter: (projectId: string) => void;
		onSetPage: (page: number) => void;
	} = $props();
</script>

<section class="story-chapter-board ws-panel-quiet min-w-0 rounded-ws p-4" aria-label={$_("storyChapterBoard.allChaptersOf", { values: { title: title.title } })}>
	<SectionBand title={$_("storyChapterBoard.chaptersTitle")} subtitle="chapters" class="mb-3">
		{#snippet action()}
			<div class="flex flex-wrap items-center gap-2">
				{#if isAssignedMode}
					<span class="inline-flex items-center gap-1.5 rounded-ws-ctrl border border-ws-violet/25 bg-ws-violet/10 px-2.5 py-1 text-[11px] font-medium text-ws-violet"><span class="ws-dot bg-ws-violet"></span>{$_("storyChapterBoard.queue")} {assignedRoleLabel} · <NumberValue value={assignedRoleChapterCount} /> {$_("storyChapterBoard.chaptersUnit")}</span>
				{:else if onAddChapter}
					<button type="button" class="ws-btn-ghost inline-flex min-h-9 items-center gap-1.5 rounded-ws-ctrl px-3 text-[11px] font-semibold text-ws-accent" onclick={onAddChapter}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
						{$_("storyChapterBoard.addChapter")}
					</button>
				{/if}
			</div>
		{/snippet}
	</SectionBand>
	<div class="story-chapter-table grid gap-1.5">
		{#each rows as row (row.chapter.project.projectId)}
			<ChapterRow
				label={row.label}
				title={row.title}
				langs={row.langs}
				roles={row.roles}
				revised={row.revised}
				due={row.due}
				dueLate={row.dueLate}
				counts={row.counts}
				class={row.active ? "!border-ws-accent/40 !bg-ws-accent/[0.08]" : ""}
				onclick={() => onSelectChapter(row.chapter.project.projectId)}
			/>
		{:else}
			<div class="rounded-ws-card border border-ws-line/12 bg-ws-surface2/25 px-4 py-8 text-center text-[12.5px] text-ws-faint">
				{emptyLabel}
			</div>
		{/each}
	</div>
	{#if showPager}
		<nav class="story-chapter-pagination mt-3 flex flex-wrap items-center justify-end gap-2" aria-label={$_("storyChapterBoard.pagerLabel", { values: { title: title.title } })}>
			<button
				type="button"
				class="ws-btn-ghost inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text disabled:cursor-not-allowed disabled:opacity-45"
				disabled={effectivePage <= 1}
				onclick={() => onSetPage(Math.max(1, effectivePage - 1))}
			>
				{$_("storyChapterBoard.prev")}
			</button>
			{#each pageNumbers as pageNumber (pageNumber)}
				<button
					type="button"
					class={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl border px-3 text-[11px] font-black transition ${pageNumber === effectivePage ? "active border-ws-accent/45 bg-ws-accent/15 text-ws-accent" : "ws-btn-ghost text-ws-text"}`}
					class:active={pageNumber === effectivePage}
					aria-current={pageNumber === effectivePage ? "page" : undefined}
					onclick={() => onSetPage(pageNumber)}
				>
					{pageNumber}
				</button>
			{/each}
			<button
				type="button"
				class="ws-btn-ghost inline-flex min-h-10 min-w-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text disabled:cursor-not-allowed disabled:opacity-45"
				disabled={effectivePage >= pageCount}
				onclick={() => onSetPage(Math.min(pageCount, effectivePage + 1))}
			>
				{$_("storyChapterBoard.next")}
			</button>
			<span class="text-[11px] font-semibold text-ws-text/60">
				{rangeStart}-{rangeEnd}
				/ {totalChapters} {$_("storyChapterBoard.chaptersUnit")}
			</span>
		</nav>
	{/if}
</section>
