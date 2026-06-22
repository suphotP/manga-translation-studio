<!--
	CommandPalette — Cmd/Ctrl+K fuzzy command launcher.

	Keyboard-driven and focus-trapped: open with Cmd/Ctrl+K, filter by typing,
	move with Arrow Up/Down (+ Home/End), run with Enter, dismiss with Esc.
	Implemented as an aria modal dialog wrapping a combobox + aria-listbox so
	screen readers announce the active option via aria-activedescendant.
-->
<script lang="ts">
	import { tick } from "svelte";
	import { invalidateAll } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import {
		searchCommands,
		sectionLabel,
		type Command,
		type CommandMatch,
		type CommandSection,
	} from "$lib/commands/command-registry.ts";
	import { buildWorkspaceCommands, openProjectChapter } from "$lib/commands/workspace-commands.ts";
	import {
		buildProjectJumpCommands,
		projectJumpStore,
	} from "$lib/commands/project-jump-source.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";
	import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";

	// Localise via svelte-i18n with an explicit fallback (the app default is Thai).
	// `$_` returns the key itself on a miss, so guard against that.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// Cross-project / cross-chapter jump rows, derived from the FULL project
	// listing the async `project-jump-source` lazily fetches. Kept as a separate
	// reactive source so they slot into the synchronous command builder the
	// moment the listing resolves — without re-opening the palette.
	function buildJumpRows(): Command[] {
		return buildProjectJumpCommands(projectJumpStore.projects, {
			t: msg,
			currentProjectId: projectStore.project?.projectId ?? null,
			// Reuse the exact navigation the recent-project rows use, so jumping
			// from anywhere lands on the editor (pages present) or library (none).
			onJump: (projectId) => openProjectChapter(projectId),
		});
	}

	// The live command set, fully localised, plus host-only actions (sign out)
	// the pure builder cannot own without importing SvelteKit navigation.
	function buildLiveCommands(): Command[] {
		return buildWorkspaceCommands({
			t: msg,
			projectJumpRows: buildJumpRows(),
			signOut: async () => {
				await authStore.signOut();
				await invalidateAll();
			},
			// Wire the palette's "Keyboard shortcuts" action to the global help
			// modal (the registry exposed this as an optional host hook).
			openShortcutsHelp: () => shortcutsHelpStore.openHelp(),
		});
	}

	let {
		// Override the command source in tests; defaults to the live workspace set.
		buildCommands = buildLiveCommands,
	} = $props<{ buildCommands?: () => Command[] }>();

	let query = $state("");
	let activeIndex = $state(0);
	let commands = $state<Command[]>([]);
	let inputEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLUListElement>();
	let dialogEl = $state<HTMLDivElement>();
	let previouslyFocused: HTMLElement | null = null;

	// Visibility lives in a shared store so the top-bar "⌘K" affordance (and any
	// future launcher) can open the palette without grabbing this instance.
	let open = $derived(commandPaletteStore.open);

	const listboxId = "command-palette-listbox";
	const optionId = (index: number) => `command-palette-option-${index}`;

	const sectionTranslator = (section: CommandSection): string =>
		msg(`commandPalette.section.${section}`, sectionLabel(section));

	let matches = $derived<CommandMatch[]>(searchCommands(commands, query));

	// Honest status for the cross-project jump listing, shown as a small footer
	// note so the user knows whether more jump targets are still loading (vs the
	// list simply being complete). Empty string = nothing to announce.
	let jumpStatusNote = $derived.by<string>(() => {
		if (projectJumpStore.status === "loading") {
			return msg("commandPalette.jumpLoading", "กำลังโหลดเรื่อง/ตอนทั้งหมด…");
		}
		if (projectJumpStore.status === "error") {
			return msg("commandPalette.jumpError", "โหลดรายการเรื่อง/ตอนไม่สำเร็จ");
		}
		return "";
	});

	function clampActive() {
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

	export function openPalette(): void {
		if (open) return;
		previouslyFocused = (document.activeElement as HTMLElement) ?? null;
		commandPaletteStore.openPalette();
	}

	export function closePalette(): void {
		if (!open) return;
		commandPaletteStore.closePalette();
	}

	// React to the store opening (from Cmd+K, the top-bar button, or a test):
	// reset the query, trap focus on the search field, and lazily fetch the full
	// project listing so cross-project / cross-chapter jump rows become available.
	// Centralising setup here means every open path — exported method, store
	// mutation, keyboard shortcut — behaves identically.
	$effect(() => {
		if (!open) {
			query = "";
			return;
		}
		query = "";
		activeIndex = 0;
		// Lazy, cached: only the first open (per session) actually fetches; the
		// rebuild effect below slots the rows in when the listing resolves.
		void projectJumpStore.ensureLoaded();
		void (async () => {
			await tick();
			inputEl?.focus();
		})();
	});

	// Rebuild the localised command set while the palette is open. Re-runs both
	// on open AND whenever the jump listing resolves (its `projects`/`status` are
	// read through `buildCommands`), so freshly fetched cross-project rows appear
	// without the user re-opening the palette. `buildCommands` is the test seam.
	$effect(() => {
		if (!open) return;
		// Touch the reactive jump state so this effect re-runs when it changes.
		void projectJumpStore.projects;
		void projectJumpStore.status;
		commands = buildCommands();
	});

	// Restore focus to wherever the user was when the palette closes.
	$effect(() => {
		if (open) return;
		previouslyFocused?.focus?.();
		previouslyFocused = null;
	});

	function runMatch(index: number): void {
		const match = matches[index];
		if (!match) return;
		closePalette();
		void match.command.run();
	}

	function moveActive(delta: number): void {
		if (matches.length === 0) return;
		activeIndex = (activeIndex + delta + matches.length) % matches.length;
		scrollActiveIntoView();
	}

	async function scrollActiveIntoView(): Promise<void> {
		await tick();
		const node = listEl?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
		node?.scrollIntoView?.({ block: "nearest" });
	}

	function onGlobalKeydown(event: KeyboardEvent): void {
		// The Cmd/Ctrl+K chord is intentionally a global accelerator: because it
		// always carries a modifier it never collides with plain typing, so we let
		// it fire even while a text field / textarea / contenteditable is focused
		// (matching Linear/VSCode). A bare key would need an input guard; this does
		// not. We do skip when other modifiers (Alt/Shift) are held to avoid
		// hijacking app/browser combos that happen to include K.
		const isPaletteKey =
			(event.metaKey || event.ctrlKey)
			&& !event.altKey
			&& !event.shiftKey
			&& (event.key === "k" || event.key === "K");
		if (isPaletteKey) {
			event.preventDefault();
			if (open) closePalette();
			else openPalette();
		}
	}

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closePalette();
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
		closePalette();
	}
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#if open}
	<!-- Backdrop is a mouse-only convenience; Escape (handled on the dialog) is
	     the keyboard path, so the backdrop stays a non-interactive presentation
	     layer to avoid a redundant tab stop. -->
	<div class="command-palette-backdrop" role="presentation" onclick={onBackdropClick}></div>
	<div
		class="command-palette ws-panel"
		bind:this={dialogEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label={msg("commandPalette.dialogLabel", "แถบคำสั่งด่วน (Command Palette)")}
		onkeydown={onDialogKeydown}
	>
		<div class="command-palette-search">
			<svg class="command-palette-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
				<circle cx="11" cy="11" r="7" />
				<path d="m21 21-4.3-4.3" />
			</svg>
			<input
				bind:this={inputEl}
				bind:value={query}
				class="command-palette-input"
				type="text"
				role="combobox"
				aria-expanded="true"
				aria-controls={listboxId}
				aria-autocomplete="list"
				aria-activedescendant={matches.length ? optionId(activeIndex) : undefined}
				aria-label={msg("commandPalette.searchLabel", "ค้นหาคำสั่ง")}
				placeholder={msg("commandPalette.placeholder", "พิมพ์เพื่อค้นหาคำสั่ง…")}
				autocomplete="off"
				spellcheck="false"
			/>
			<kbd class="command-palette-kbd">Esc</kbd>
		</div>

		<ul
			bind:this={listEl}
			id={listboxId}
			class="command-palette-list"
			role="listbox"
			aria-label={msg("commandPalette.resultsLabel", "ผลคำสั่ง")}
		>
			{#each matches as match, index (match.command.id)}
				{@const showHeader = index === 0 || matches[index - 1].command.section !== match.command.section}
				{#if showHeader}
					<li class="command-palette-section" role="presentation">
						{sectionLabel(match.command.section, sectionTranslator)}
					</li>
				{/if}
				<!-- A `role="option"` element must NOT contain a separately-interactive
				     descendant (e.g. a <button>), so the row itself is the option:
				     keyboard activation flows through the dialog's Enter handler
				     (aria-activedescendant pattern, focus stays on the input) and the
				     mouse path uses this option's own click handler. Keyboard activation
				     is therefore intentionally NOT on the option (it is not a tab stop);
				     Enter is dispatched centrally on the dialog. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id={optionId(index)}
					data-option-index={index}
					class="command-palette-option command-palette-option-row"
					class:active={index === activeIndex}
					role="option"
					aria-selected={index === activeIndex}
					onclick={() => runMatch(index)}
					onmousemove={() => (activeIndex = index)}
				>
					<span class="command-palette-option-text">
						<span class="command-palette-option-title">{match.command.title}</span>
						{#if match.command.subtitle}
							<span class="command-palette-option-subtitle">{match.command.subtitle}</span>
						{/if}
					</span>
					{#if match.command.shortcut}
						<kbd class="command-palette-kbd">{match.command.shortcut}</kbd>
					{/if}
				</li>
			{:else}
				<li class="command-palette-empty" role="presentation">
					{msg("commandPalette.empty", "ไม่พบคำสั่งที่ตรงกับ")} “{query}”
				</li>
			{/each}
		</ul>

		{#if jumpStatusNote}
			<!-- aria-live so screen readers hear when the cross-project jump
			     listing finishes loading (or fails), since rows then change. -->
			<div class="command-palette-footer" role="status" aria-live="polite">
				{jumpStatusNote}
			</div>
		{/if}
	</div>
{/if}

<style>
	.command-palette-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2000;
		border: 0;
		padding: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		backdrop-filter: blur(2px);
		cursor: default;
	}

	.command-palette {
		position: fixed;
		left: 50%;
		top: 14vh;
		z-index: 2001;
		display: flex;
		flex-direction: column;
		width: min(640px, calc(100vw - 32px));
		max-height: min(64vh, 560px);
		transform: translateX(-50%);
		overflow: hidden;
		border-radius: var(--radius-ws-card, 12px);
		color: var(--color-ws-ink);
	}

	.command-palette-search {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.command-palette-search-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		stroke-width: 1.8;
		color: var(--color-ws-faint);
	}

	.command-palette-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--color-ws-ink);
		font-size: 15px;
		outline: none;
	}

	.command-palette-input::placeholder {
		color: var(--color-ws-faint);
	}

	.command-palette-kbd {
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

	.command-palette-list {
		flex: 1;
		min-height: 0;
		margin: 0;
		padding: 6px;
		list-style: none;
		overflow-y: auto;
	}

	.command-palette-section {
		padding: 10px 10px 4px;
		color: var(--color-ws-faint);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.command-palette-option {
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.command-palette-option.active {
		background: linear-gradient(
			100deg,
			color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			color-mix(in srgb, var(--color-ws-cyan) 10%, transparent)
		);
	}

	/* The row itself is the `role="option"` target (no nested <button>), so it
	   carries the former button's flex layout, sizing, and pointer affordance. */
	.command-palette-option-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 44px;
		padding: 8px 12px;
		border: 0;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.command-palette-option-text {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
	}

	.command-palette-option-title {
		overflow: hidden;
		font-size: 13.5px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-palette-option-subtitle {
		overflow: hidden;
		color: var(--color-ws-faint);
		font-size: 11.5px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-palette-empty {
		padding: 22px 12px;
		color: var(--color-ws-faint);
		font-size: 13px;
		text-align: center;
	}

	.command-palette-footer {
		flex-shrink: 0;
		padding: 8px 16px;
		border-top: 1px solid var(--ws-hair);
		color: var(--color-ws-faint);
		font-size: 11.5px;
	}

	@media (prefers-reduced-motion: reduce) {
		.command-palette-backdrop {
			backdrop-filter: none;
		}
	}
</style>
