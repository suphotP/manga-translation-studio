<!-- AddLanguageTrackDialog — manage a project's per-language tracks.

	Wraps the shared ui/Dialog atom. Lists the active Language Tracks, lets the
	user add a new track (POST /project/:id/languages) and remove a non-primary
	track (DELETE …/:language) through the gated, server-owned track API.

	Track changes are server-owned: on success we re-open the project via the
	store's public openProject() so projectStore.targetLangs reflects the new set
	(no project.svelte.ts fields added; the store re-syncs the active track).

	Honest failures: scope-denied (403), duplicate (409) and the primary/last-track
	refusals are surfaced as inline messages, never silently swallowed. ws-* tokens,
	Svelte 5 runes. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import * as api from "$lib/api/client.ts";
	import { ApiError } from "$lib/api/client.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";

	let {
		open,
		onClose,
	}: {
		open: boolean;
		onClose: () => void;
	} = $props();

	let tracks = $derived(projectStore.targetLangs);
	// The primary track is always first (listTracks guarantees the default leads).
	let primaryLang = $derived(tracks[0] ?? projectStore.activeTargetLang);

	let newLang = $state("");
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	/** The track currently being removed, so we can show per-row progress. */
	let removingLang = $state<string | null>(null);

	let normalizedNew = $derived(newLang.trim().toLowerCase());
	let isDuplicateLocally = $derived(
		normalizedNew.length > 0 && tracks.some((lang) => lang.toLowerCase() === normalizedNew),
	);
	let canSubmit = $derived(
		!busy
		&& normalizedNew.length >= 1
		&& normalizedNew.length <= 10
		&& !isDuplicateLocally,
	);

	function trackLabel(lang: string): string {
		return lang.trim().toUpperCase() || lang;
	}

	function describeError(error: unknown, fallback: string): string {
		if (error instanceof ApiError) {
			switch (error.code) {
				case "language_track_exists":
					return $_("addLanguageTrack.errExists");
				case "workspace_language_track_scope_denied":
					return $_("addLanguageTrack.errScopeDenied");
				case "cannot_remove_primary_language_track":
					return $_("addLanguageTrack.errCannotRemovePrimary");
				case "cannot_remove_last_language_track":
					return $_("addLanguageTrack.errCannotRemoveLast");
				case "workspace_language_track_store_unavailable":
					return $_("addLanguageTrack.errStoreUnavailable");
			}
			if (error.status === 403) return $_("addLanguageTrack.errForbidden");
			if (error.status === 404) return $_("addLanguageTrack.errNotFound");
			if (error.message) return error.message;
		}
		return fallback;
	}

	async function refreshTracks(): Promise<void> {
		const projectId = projectStore.project?.projectId;
		if (!projectId) return;
		// Re-open via the store's public API so targetLangs / the active track
		// re-sync from the server-owned set (we never mutate project.svelte.ts).
		await projectStore.openProject(projectId);
	}

	async function addTrack(): Promise<void> {
		const projectId = projectStore.project?.projectId;
		if (!projectId || !canSubmit) return;
		const language = normalizedNew;
		busy = true;
		errorMsg = null;
		try {
			await api.addProjectLanguage(projectId, language);
			await refreshTracks();
			newLang = "";
		} catch (error) {
			errorMsg = describeError(error, $_("addLanguageTrack.errAddFailed"));
		} finally {
			busy = false;
		}
	}

	async function removeTrack(language: string): Promise<void> {
		const projectId = projectStore.project?.projectId;
		if (!projectId || busy || language === primaryLang) return;
		busy = true;
		removingLang = language;
		errorMsg = null;
		try {
			await api.removeProjectLanguage(projectId, language);
			await refreshTracks();
		} catch (error) {
			errorMsg = describeError(error, $_("addLanguageTrack.errRemoveFailed"));
		} finally {
			busy = false;
			removingLang = null;
		}
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		void addTrack();
	}

	function requestClose(): void {
		if (busy) return;
		errorMsg = null;
		newLang = "";
		onClose();
	}
</script>

<Dialog
	{open}
	onClose={requestClose}
	{busy}
	ariaLabelledby="lang-track-dialog-title"
	ariaDescribedby="lang-track-dialog-copy"
	closeLabel={$_("addLanguageTrack.closeLabel")}
	size="sm"
	panelClass="lang-track-panel"
>
	{#snippet header()}
		<header class="lang-track-header">
			<p class="lang-track-kicker">{$_("addLanguageTrack.kicker")}</p>
			<h2 id="lang-track-dialog-title">{$_("addLanguageTrack.title")}</h2>
		</header>
	{/snippet}

	<p id="lang-track-dialog-copy" class="lang-track-copy">
		{$_("addLanguageTrack.copy")}
	</p>

	<ul class="lang-track-rows" aria-label={$_("addLanguageTrack.rowsAria")}>
		{#each tracks as lang (lang)}
			<li class="lang-track-row">
				<span class="lang-track-code">{trackLabel(lang)}</span>
				{#if lang === primaryLang}
					<span class="lang-track-primary">{$_("addLanguageTrack.primary")}</span>
				{:else}
					<button
						type="button"
						class="lang-track-remove"
						disabled={busy}
						aria-label={$_("addLanguageTrack.removeAria", { values: { label: trackLabel(lang) } })}
						onclick={() => removeTrack(lang)}
					>
						{removingLang === lang ? $_("addLanguageTrack.removing") : $_("addLanguageTrack.remove")}
					</button>
				{/if}
			</li>
		{/each}
	</ul>

	<form class="lang-track-add" onsubmit={handleSubmit}>
		<label class="lang-track-field">
			<span class="lang-track-field-label">{$_("addLanguageTrack.addLabel")}</span>
			<input
				type="text"
				class="lang-track-input"
				placeholder={$_("addLanguageTrack.addPlaceholder")}
				maxlength="10"
				autocomplete="off"
				spellcheck="false"
				disabled={busy}
				bind:value={newLang}
				aria-label={$_("addLanguageTrack.newCodeAria")}
				aria-invalid={isDuplicateLocally}
			/>
		</label>
		<button type="submit" class="ws-dialog-btn ws-dialog-btn-primary lang-track-add-btn" disabled={!canSubmit}>
			{$_("addLanguageTrack.addButton")}
		</button>
	</form>

	{#if isDuplicateLocally}
		<p class="lang-track-hint">{$_("addLanguageTrack.duplicateHint")}</p>
	{/if}
	{#if errorMsg}
		<p class="lang-track-error" role="alert">{errorMsg}</p>
	{/if}

	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ws-dialog-btn" disabled={busy} onclick={requestClose}>
			{$_("addLanguageTrack.done")}
		</button>
	{/snippet}
</Dialog>

<style>
	:global(.ws-dialog-panel.lang-track-panel .ws-dialog-body) {
		display: grid;
		gap: 14px;
		align-content: start;
	}

	.lang-track-header {
		padding: 18px 64px 14px 18px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.lang-track-kicker {
		margin: 0 0 4px;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 20px;
		font-weight: 800;
		line-height: 1.25;
	}

	.lang-track-copy {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.45;
	}

	.lang-track-rows {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.lang-track-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, var(--color-ws-bg));
	}

	.lang-track-code {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.lang-track-primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 28px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 32%, var(--ws-hair));
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-green) 11%, var(--color-ws-surface));
		color: var(--color-ws-green);
		font-size: 11px;
		font-weight: 800;
	}

	.lang-track-remove {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 38%, var(--ws-hair));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, var(--color-ws-surface));
		color: var(--color-ws-rose);
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease;
	}

	.lang-track-remove:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-rose) 16%, var(--color-ws-surface));
		border-color: color-mix(in srgb, var(--color-ws-rose) 54%, var(--ws-hair-strong));
	}

	.lang-track-remove:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.lang-track-add {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	.lang-track-field {
		display: grid;
		gap: 4px;
		flex: 1 1 auto;
		min-width: 0;
	}

	.lang-track-field-label {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 700;
	}

	.lang-track-input {
		width: 100%;
		min-height: 40px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, var(--color-ws-bg));
		color: var(--color-ws-ink);
		font-size: 13px;
	}

	.lang-track-input:focus-visible {
		outline: none;
		border-color: var(--color-ws-accent);
		box-shadow: var(--ws-focus-ring);
	}

	.lang-track-add-btn {
		flex: 0 0 auto;
		white-space: nowrap;
	}

	.lang-track-hint {
		margin: 0;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 30%, var(--ws-hair));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
		color: var(--color-ws-amber);
		font-size: 12px;
	}

	.lang-track-error {
		margin: 0;
		padding: 8px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 40%, var(--ws-hair));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		color: var(--color-ws-rose);
		font-size: 12px;
		line-height: 1.4;
	}
</style>
