<!--
	SearchModal — global "/" content search.

	Finds the user's real projects/chapters (and other workspaces) and jumps to
	them. Distinct from the ⌘K command palette (which runs *actions*): this finds
	*content*. It shares the palette's accessibility model — an aria modal dialog
	wrapping a combobox + aria-listbox, focus-trapped, with aria-activedescendant
	so screen readers announce the active option — and the same keys: type to
	filter, Arrow Up/Down (+ Home/End) to move, Enter to navigate, Esc to dismiss.

	Open with "/" (when not typing) or the top-bar search affordance; both flip
	the shared `searchStore`, so the modal never needs a component handle.
-->
<script lang="ts">
	import { tick } from "svelte";
	import { _ } from "$lib/i18n";
	import {
		buildSearchIndex,
		searchResults,
		type SearchResult,
		type SearchResultMatch,
	} from "$lib/search/search-index.ts";
	import { searchStore } from "$lib/stores/search.svelte.ts";
	import { isAppModalOpen } from "$lib/a11y/modal-guard.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";

	// Localise via svelte-i18n with an explicit fallback (app default is Thai).
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		// Override the result source in tests; defaults to the live workspace data.
		buildResults = buildLiveResults,
		// Override navigation in tests so we don't touch the router.
		onNavigate = navigateToResult,
	} = $props<{
		buildResults?: () => SearchResult[];
		onNavigate?: (result: SearchResult) => void | Promise<void>;
	}>();

	function buildLiveResults(): SearchResult[] {
		return buildSearchIndex({
			projects: projectStore.recentProjects,
			workspaces: workspacesStore.workspaces,
			currentWorkspaceId: workspacesStore.currentWorkspaceId,
			labels: {
				chapter: msg("search.badgeChapter", "Chapter"),
				workspace: msg("search.badgeWorkspace", "Workspace"),
				chapterNumberPrefix: msg("search.chapterNumberPrefix", "ตอนที่"),
			},
		});
	}

	/** Jump to a result. Chapters open the project (editor when it has pages,
	 *  else library); workspaces switch the active workspace. Mirrors the
	 *  command palette's openProjectChapter so the two entry points agree. */
	async function navigateToResult(result: SearchResult): Promise<void> {
		if (result.kind === "workspace") {
			await workspacesStore.switchTo(result.targetId);
			return;
		}
		const opened = await projectStore.openProject(result.targetId, editorStore.editor);
		if (opened === false) return;
		const project = projectStore.project;
		if (!project || !project.pages.length) {
			editorUiStore.openLibrary();
			queueWorkspaceNavigation({ view: "library" });
			return;
		}
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: project.projectId,
			pageIndex: project.currentPage,
		});
	}

	let query = $state("");
	let activeIndex = $state(0);
	let results = $state<SearchResult[]>([]);
	let inputEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLUListElement>();
	let dialogEl = $state<HTMLDivElement>();
	let previouslyFocused: HTMLElement | null = null;

	let open = $derived(searchStore.open);

	const listboxId = "search-modal-listbox";
	const optionId = (index: number) => `search-modal-option-${index}`;

	let matches = $derived<SearchResultMatch[]>(searchResults(results, query));

	function clampActive(): void {
		if (matches.length === 0) {
			activeIndex = 0;
			return;
		}
		if (activeIndex > matches.length - 1) activeIndex = matches.length - 1;
		if (activeIndex < 0) activeIndex = 0;
	}

	$effect(() => {
		// Keep the active row valid whenever the filtered set shrinks.
		void matches;
		clampActive();
	});

	// React to the store opening (from "/", the top-bar field, or a test):
	// rebuild the index, reset the query, and trap focus on the search field.
	$effect(() => {
		if (!open) {
			query = "";
			return;
		}
		previouslyFocused = (document.activeElement as HTMLElement) ?? null;
		results = buildResults();
		query = "";
		activeIndex = 0;
		void (async () => {
			await tick();
			inputEl?.focus();
		})();
	});

	// Restore focus to wherever the user was when the modal closes.
	$effect(() => {
		if (open) return;
		previouslyFocused?.focus?.();
		previouslyFocused = null;
	});

	function closeSearch(): void {
		searchStore.closeSearch();
	}

	function runMatch(index: number): void {
		const match = matches[index];
		if (!match) return;
		closeSearch();
		void onNavigate(match.result);
	}

	function moveActive(delta: number): void {
		if (matches.length === 0) return;
		activeIndex = (activeIndex + delta + matches.length) % matches.length;
		void scrollActiveIntoView();
	}

	async function scrollActiveIntoView(): Promise<void> {
		await tick();
		const node = listEl?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
		node?.scrollIntoView?.({ block: "nearest" });
	}

	// "/" is a bare-key accelerator, so we MUST NOT fire while the user is typing
	// into a field (input/textarea/contenteditable) or holding a modifier — that
	// would hijack a literal slash. ⌘K is handled by the palette; we never grab it.
	function isTypingTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		return el.isContentEditable === true;
	}

	function onGlobalKeydown(event: KeyboardEvent): void {
		if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
			return;
		}
		if (open) return;
		if (isTypingTarget(event.target)) return;
		// Don't stack a second aria-modal dialog: if another app modal (e.g. the
		// ShortcutsHelp "?" dialog or the command palette) is already open, let it
		// keep focus. Escape closes the top one first; "/" works once nothing else
		// is up. We still preventDefault so a literal "/" doesn't leak through.
		if (isAppModalOpen()) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		searchStore.openSearch();
	}

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeSearch();
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			activeIndex = 0;
			void scrollActiveIntoView();
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			activeIndex = Math.max(0, matches.length - 1);
			void scrollActiveIntoView();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			runMatch(activeIndex);
			return;
		}
		if (event.key === "Tab") {
			// Single-stop focus trap: keep focus on the search field.
			event.preventDefault();
			inputEl?.focus();
		}
	}

	function onBackdropClick(): void {
		closeSearch();
	}
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#if open}
	<div class="search-modal-backdrop" role="presentation" onclick={onBackdropClick}></div>
	<div
		class="search-modal ws-panel"
		bind:this={dialogEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label={msg("search.dialogLabel", "ค้นหาเรื่อง ตอน และเวิร์กสเปซ")}
		onkeydown={onDialogKeydown}
	>
		<div class="search-modal-search">
			<svg class="search-modal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
				<circle cx="11" cy="11" r="7" />
				<path d="m21 21-4.3-4.3" />
			</svg>
			<input
				bind:this={inputEl}
				bind:value={query}
				class="search-modal-input"
				type="text"
				role="combobox"
				aria-expanded="true"
				aria-controls={listboxId}
				aria-autocomplete="list"
				aria-activedescendant={matches.length ? optionId(activeIndex) : undefined}
				aria-label={msg("search.inputLabel", "ค้นหา")}
				placeholder={msg("search.placeholder", "ค้นหาเรื่อง ตอน หรือเวิร์กสเปซ…")}
				autocomplete="off"
				spellcheck="false"
			/>
			<kbd class="search-modal-kbd">Esc</kbd>
		</div>

		<ul
			bind:this={listEl}
			id={listboxId}
			class="search-modal-list"
			role="listbox"
			aria-label={msg("search.resultsLabel", "ผลการค้นหา")}
		>
			{#each matches as match, index (match.result.id)}
				<!-- The row itself is the option: a nested interactive <button>
				     inside role="option" is invalid ARIA. Keyboard selection runs
				     through the combobox (aria-activedescendant + dialog Arrow/Enter
				     handlers); the mouse path lives here (click to run, move to
				     activate). The list never takes DOM focus, so no tabindex. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- Keyboard activation is the combobox's job (Enter on the dialog runs
				     the active option via aria-activedescendant); a per-row keydown
				     would be the wrong pattern for an APG combobox+listbox. -->
				<li
					id={optionId(index)}
					data-option-index={index}
					class="search-modal-option"
					class:active={index === activeIndex}
					role="option"
					aria-selected={index === activeIndex}
					onclick={() => runMatch(index)}
					onmousemove={() => (activeIndex = index)}
				>
					<span class="search-modal-badge" data-kind={match.result.kind}>{match.result.badge}</span>
					<span class="search-modal-option-text">
						<span class="search-modal-option-title">{match.result.title}</span>
						{#if match.result.subtitle}
							<span class="search-modal-option-subtitle">{match.result.subtitle}</span>
						{/if}
					</span>
				</li>
			{:else}
				<li class="search-modal-empty" role="presentation">
					{#if query.trim()}
						{msg("search.empty", "ไม่พบผลลัพธ์สำหรับ")} “{query}”
					{:else}
						{msg("search.emptyState", "ยังไม่มีเรื่องหรือตอน เริ่มสร้างเรื่องใหม่ได้เลย")}
					{/if}
				</li>
			{/each}
		</ul>

		<div class="search-modal-foot" aria-hidden="true">
			<span><kbd class="search-modal-kbd">↑</kbd><kbd class="search-modal-kbd">↓</kbd> {msg("search.hintMove", "เลื่อน")}</span>
			<span><kbd class="search-modal-kbd">Enter</kbd> {msg("search.hintOpen", "เปิด")}</span>
			<span><kbd class="search-modal-kbd">Esc</kbd> {msg("search.hintClose", "ปิด")}</span>
		</div>
	</div>
{/if}

<style>
	.search-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2000;
		border: 0;
		padding: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		backdrop-filter: blur(2px);
		cursor: default;
	}

	.search-modal {
		position: fixed;
		left: 50%;
		top: 14vh;
		z-index: 2001;
		display: flex;
		flex-direction: column;
		width: min(640px, calc(100vw - 32px));
		max-height: min(68vh, 600px);
		transform: translateX(-50%);
		overflow: hidden;
		border-radius: var(--radius-ws-card, 12px);
		color: var(--color-ws-ink);
	}

	.search-modal-search {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.search-modal-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		stroke-width: 1.8;
		color: var(--color-ws-faint);
	}

	.search-modal-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--color-ws-ink);
		font-size: 15px;
		outline: none;
	}

	.search-modal-input::placeholder {
		color: var(--color-ws-faint);
	}

	.search-modal-kbd {
		flex-shrink: 0;
		padding: 2px 7px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 700;
		font-family: inherit;
	}

	.search-modal-list {
		flex: 1;
		min-height: 0;
		margin: 0;
		padding: 6px;
		list-style: none;
		overflow-y: auto;
	}

	.search-modal-option {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 8px 12px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.search-modal-option.active {
		background: linear-gradient(
			100deg,
			color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			color-mix(in srgb, var(--color-ws-cyan) 10%, transparent)
		);
	}

	.search-modal-badge {
		flex-shrink: 0;
		min-width: 64px;
		padding: 3px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-align: center;
		text-transform: uppercase;
	}

	.search-modal-badge[data-kind="chapter"] {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--color-ws-ink));
	}

	.search-modal-badge[data-kind="workspace"] {
		border-color: color-mix(in srgb, var(--color-ws-cyan) 45%, transparent);
		background: color-mix(in srgb, var(--color-ws-cyan) 12%, transparent);
		color: var(--color-ws-cyan);
	}

	.search-modal-option-text {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
	}

	.search-modal-option-title {
		overflow: hidden;
		font-size: 13.5px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-modal-option-subtitle {
		overflow: hidden;
		color: var(--color-ws-faint);
		font-size: 11.5px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-modal-empty {
		padding: 28px 12px;
		color: var(--color-ws-faint);
		font-size: 13px;
		text-align: center;
	}

	.search-modal-foot {
		display: flex;
		gap: 16px;
		padding: 9px 14px;
		border-top: 1px solid var(--ws-hair);
		color: var(--color-ws-faint);
		font-size: 11px;
	}

	.search-modal-foot span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	@media (prefers-reduced-motion: reduce) {
		.search-modal-backdrop {
			backdrop-filter: none;
		}
	}
</style>
