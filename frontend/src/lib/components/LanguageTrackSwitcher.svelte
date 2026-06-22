<!-- LanguageTrackSwitcher — per-language track picker for the editor path bar.

	Surfaces the project's active Language Tracks (projectStore.targetLangs) and
	lets the user switch the active track (projectStore.setTargetLang). A Language
	Track is the pair (projectId, targetLang); switching changes which target
	language is being edited/previewed.

	Honest degenerate states:
	  - 0 / 1 track → renders a single static badge (no chooser, no add affordance
	    unless `canManage` is on), so single-language projects look unchanged.
	  - multi-track → a compact segmented chooser, active track highlighted.

	The add/remove dialog lives in AddLanguageTrackDialog.svelte; this component
	only opens it. ws-* tokens, Svelte 5 runes, no store fields added. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { projectStore } from "$lib/stores/project.svelte.ts";

	let {
		canManage = false,
		onManage,
		class: klass = "",
	}: {
		/** When true, show the "manage tracks" affordance (opens the add/remove dialog). */
		canManage?: boolean;
		/** Called when the user asks to manage tracks (add/remove a language). */
		onManage?: () => void;
		class?: string;
	} = $props();

	let tracks = $derived(projectStore.targetLangs);
	let activeLang = $derived(projectStore.activeTargetLang);
	let isMultiTrack = $derived(tracks.length > 1);

	function trackLabel(lang: string): string {
		return lang.trim().toUpperCase() || lang;
	}

	function selectTrack(lang: string): void {
		if (lang === activeLang) return;
		// The store resolves the live editor itself (registered by the editor store) so
		// it can flush in-flight edits to the current track and reload the canvas text
		// to the newly selected track. Keeping this call arg-light preserves the
		// component contract (no editor coupling in the path bar).
		projectStore.setTargetLang(lang);
	}
</script>

{#if isMultiTrack}
	<div class={`lang-track-switcher ${klass}`} role="group" aria-label={$_("languageTrackSwitcher.groupLabel")}>
		<div class="lang-track-list">
			{#each tracks as lang (lang)}
				<button
					type="button"
					class="lang-track-chip"
					class:active={lang === activeLang}
					aria-pressed={lang === activeLang}
					aria-label={$_("languageTrackSwitcher.switchTo", { values: { lang: trackLabel(lang) } })}
					onclick={() => selectTrack(lang)}
				>
					{trackLabel(lang)}
				</button>
			{/each}
		</div>
		{#if canManage && onManage}
			<button
				type="button"
				class="lang-track-manage"
				aria-label={$_("languageTrackSwitcher.manageLabel")}
				title={$_("languageTrackSwitcher.manageTitle")}
				onclick={() => onManage?.()}
			>
				+
			</button>
		{/if}
	</div>
{:else}
	<!-- Single-language / legacy project: a static badge so the bar looks unchanged. -->
	<div class={`lang-track-switcher single ${klass}`} aria-label={$_("languageTrackSwitcher.targetLabel")}>
		<span class="lang-track-badge">{trackLabel(activeLang)}</span>
		{#if canManage && onManage}
			<button
				type="button"
				class="lang-track-manage"
				aria-label={$_("languageTrackSwitcher.addLabel")}
				title={$_("languageTrackSwitcher.addLabel")}
				onclick={() => onManage?.()}
			>
				+
			</button>
		{/if}
	</div>
{/if}

<style>
	.lang-track-switcher {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.lang-track-list {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.03);
	}

	.lang-track-chip {
		appearance: none;
		padding: 2px 7px;
		border: 1px solid transparent;
		border-radius: 7px;
		background: transparent;
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 900;
		letter-spacing: 0.5px;
		text-transform: uppercase;
		cursor: pointer;
		transition: color 0.12s ease, background 0.12s ease, border-color 0.12s ease;
	}

	.lang-track-chip:hover {
		color: var(--color-ws-ink);
		background: rgba(255, 255, 255, 0.05);
	}

	.lang-track-chip.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 40%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
		color: var(--color-ws-accent);
		cursor: default;
	}

	.lang-track-chip:focus-visible,
	.lang-track-manage:focus-visible {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 1px;
	}

	.lang-track-badge {
		padding: 2px 6px;
		border: 1px solid rgba(96, 165, 250, 0.3);
		border-radius: 4px;
		background: rgba(96, 165, 250, 0.1);
		color: #60a5fa;
		font-size: 9px;
		font-weight: 900;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.lang-track-manage {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--ws-hair);
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.03);
		color: var(--color-ws-text);
		font-size: 13px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		transition: color 0.12s ease, background 0.12s ease, border-color 0.12s ease;
	}

	.lang-track-manage:hover {
		color: var(--color-ws-ink);
		border-color: var(--ws-hair-strong);
		background: rgba(255, 255, 255, 0.06);
	}
</style>
