<!-- LibraryFilterBar — the "ปรับมุมมองคลัง" toolbar above the cover-card shelf:
	search, status filter, my-role tab, sort, and the grid/list view-mode toggle.
	Pure presentation; all option lists/labels/state come from the orchestrator,
	which keeps the projectStore-derived counts. Visuals preserved verbatim. -->
<script lang="ts">
	import { _ } from "$lib/i18n";

	type LibraryHomeTab = "all" | "solo" | "team" | "urgent" | "deadline" | "assigned" | "review";
	type LibraryHomeFilter = "all" | "attention" | "active" | "ready" | "setup";
	type LibraryHomeSort = "latest" | "attention" | "progress";
	type LibraryProjectViewMode = "grid" | "list";

	let {
		searchQuery = $bindable(""),
		homeFilter = $bindable<LibraryHomeFilter>("all"),
		homeTab = $bindable<LibraryHomeTab>("all"),
		homeSort = $bindable<LibraryHomeSort>("latest"),
		viewMode = $bindable<LibraryProjectViewMode>("grid"),
		tabs,
		tabCount,
	}: {
		searchQuery?: string;
		homeFilter?: LibraryHomeFilter;
		homeTab?: LibraryHomeTab;
		homeSort?: LibraryHomeSort;
		viewMode?: LibraryProjectViewMode;
		tabs: readonly { id: LibraryHomeTab; label: string; counted?: boolean }[];
		tabCount: (tab: LibraryHomeTab) => number;
	} = $props();
</script>

<section class="ws-panel rounded-ws p-3" aria-label={$_("libraryFilterBar.toolbarLabel")}>
	<div class="library-filter-row flex flex-wrap items-center gap-2.5">
		<div class="flex h-9 min-w-[180px] flex-1 items-center gap-2.5 rounded-ws-ctrl ws-panel-quiet px-3">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" class="shrink-0 text-ws-faint" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.6" /><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
			<input
				type="search"
				bind:value={searchQuery}
				placeholder={$_("libraryFilterBar.searchPlaceholder")}
				aria-label={$_("libraryFilterBar.searchAriaLabel")}
				class="min-w-0 flex-1 bg-transparent text-[13px] text-ws-ink outline-none placeholder:text-ws-faint"
			/>
		</div>

		<label class="flex h-9 shrink-0 items-center gap-2 rounded-ws-ctrl ws-btn-ghost px-3 text-[12.5px] text-ws-text">
			<span class="ws-dot bg-ws-cyan"></span>
			<span class="text-ws-ink">{$_("libraryFilterBar.status")}</span>
			<select bind:value={homeFilter} class="cursor-pointer bg-transparent text-[12.5px] font-medium text-ws-text outline-none [&>option]:bg-ws-surface2">
				<option value="all">{$_("libraryFilterBar.statusAll")}</option>
				<option value="attention">{$_("libraryFilterBar.statusAttention")}</option>
				<option value="active">{$_("libraryFilterBar.statusActive")}</option>
				<option value="ready">{$_("libraryFilterBar.statusReady")}</option>
				<option value="setup">{$_("libraryFilterBar.statusSetup")}</option>
			</select>
		</label>

		<label class="flex h-9 shrink-0 items-center gap-2 rounded-ws-ctrl ws-btn-ghost px-3 text-[12.5px] text-ws-text">
			<span class="text-ws-ink">{$_("libraryFilterBar.myRole")}</span>
			<select bind:value={homeTab} class="cursor-pointer bg-transparent text-[12.5px] font-medium text-ws-text outline-none [&>option]:bg-ws-surface2">
				{#each tabs as tab (tab.id)}
					<option value={tab.id}>{tab.label}{tab.counted ? ` (${tabCount(tab.id)})` : ""}</option>
				{/each}
			</select>
		</label>

		<label class="flex h-9 shrink-0 items-center gap-2 rounded-ws-ctrl ws-btn-ghost px-3 text-[12.5px] text-ws-text">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" class="text-ws-faint" aria-hidden="true"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			<span class="text-ws-ink">{$_("libraryFilterBar.sort")}</span>
			<select bind:value={homeSort} class="cursor-pointer bg-transparent text-[12.5px] font-medium text-ws-text outline-none [&>option]:bg-ws-surface2">
				<option value="latest">{$_("libraryFilterBar.sortLatest")}</option>
				<option value="attention">{$_("libraryFilterBar.sortAttention")}</option>
				<option value="progress">{$_("libraryFilterBar.sortProgress")}</option>
			</select>
		</label>

		<div class="ml-auto flex shrink-0 items-center gap-1 rounded-ws-ctrl ws-panel-quiet p-0.5">
			<button
				type="button"
				aria-label={$_("libraryFilterBar.viewGrid")}
				class={`flex h-9 w-9 items-center justify-center rounded-ws-ctrl transition ${viewMode === "grid" ? "bg-ws-surface2 text-ws-ink" : "text-ws-faint hover:bg-ws-surface2/60 hover:text-ws-ink"}`}
				onclick={() => viewMode = "grid"}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" /><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" /><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" /><rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" /></svg>
			</button>
			<button
				type="button"
				aria-label={$_("libraryFilterBar.viewList")}
				class={`flex h-9 w-9 items-center justify-center rounded-ws-ctrl transition ${viewMode === "list" ? "bg-ws-surface2 text-ws-ink" : "text-ws-faint hover:bg-ws-surface2/60 hover:text-ws-ink"}`}
				onclick={() => viewMode = "list"}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
			</button>
		</div>
	</div>
</section>
