<!-- LanguagePicker — searchable language combobox atom.

	A flexible target/source language selector for the chapter-setup flow and any
	other surface that needs to pick an ISO-ish language code. Shows a curated list
	of common comic languages (name + native + flag) but ALSO accepts a free-form
	code so the catalogue is never a hard wall — the app's Language Track model
	supports adding more languages later.

	Pure-ish atom: owns only its open/search UI state. The selected value is owned
	by the caller via `value` + `onChange`. Styled with ws-* tokens. -->
<script lang="ts" module>
	export interface LanguageOption {
		code: string;
		name: string;
		native?: string;
		flag?: string;
	}

	// Curated common comic/scanlation languages. Not exhaustive on purpose — a
	// free-typed code is always accepted, and tracks can be added later.
	// SENTINEL: each `native` is that language's own autonym (ไทย / 日本語 / 한국어 …),
	// shown in its own script regardless of the UI locale — NOT translatable UI text.
	export const COMMON_LANGUAGES: readonly LanguageOption[] = [
		{ code: "th", name: "Thai", native: "ไทย", flag: "🇹🇭" },
		{ code: "en", name: "English", native: "English", flag: "🇬🇧" },
		{ code: "ja", name: "Japanese", native: "日本語", flag: "🇯🇵" },
		{ code: "ko", name: "Korean", native: "한국어", flag: "🇰🇷" },
		{ code: "zh", name: "Chinese", native: "中文", flag: "🇨🇳" },
		{ code: "zh-Hant", name: "Chinese (Traditional)", native: "繁體中文", flag: "🇹🇼" },
		{ code: "vi", name: "Vietnamese", native: "Tiếng Việt", flag: "🇻🇳" },
		{ code: "id", name: "Indonesian", native: "Bahasa Indonesia", flag: "🇮🇩" },
		{ code: "es", name: "Spanish", native: "Español", flag: "🇪🇸" },
		{ code: "pt", name: "Portuguese", native: "Português", flag: "🇵🇹" },
		{ code: "pt-BR", name: "Portuguese (Brazil)", native: "Português (BR)", flag: "🇧🇷" },
		{ code: "fr", name: "French", native: "Français", flag: "🇫🇷" },
		{ code: "de", name: "German", native: "Deutsch", flag: "🇩🇪" },
		{ code: "it", name: "Italian", native: "Italiano", flag: "🇮🇹" },
		{ code: "ru", name: "Russian", native: "Русский", flag: "🇷🇺" },
		{ code: "ar", name: "Arabic", native: "العربية", flag: "🇸🇦" },
		{ code: "tr", name: "Turkish", native: "Türkçe", flag: "🇹🇷" },
	];

	export function languageOptionForCode(code: string): LanguageOption {
		const normalized = code.trim();
		const match = COMMON_LANGUAGES.find(
			(option) => option.code.toLowerCase() === normalized.toLowerCase(),
		);
		return match ?? { code: normalized, name: normalized.toUpperCase() };
	}
</script>

<script lang="ts">
	import { _ } from "$lib/i18n";

	let {
		value,
		onChange,
		id,
		ariaLabel,
		placeholder = undefined,
		invalid = false,
		describedby,
	}: {
		value: string;
		onChange: (code: string) => void;
		id?: string;
		ariaLabel?: string;
		placeholder?: string;
		invalid?: boolean;
		describedby?: string;
	} = $props();

	let open = $state(false);
	let query = $state("");
	let rootEl: HTMLDivElement | null = $state(null);
	let inputEl: HTMLInputElement | null = $state(null);
	let activeIndex = $state(0);

	// Stable per-instance prefix so multiple LanguagePickers on one page (e.g. a
	// source + target pair) never collide on option ids / aria-activedescendant.
	const instanceId = `lang-picker-${Math.random().toString(36).slice(2, 9)}`;
	const listId = `${instanceId}-list`;
	const optionId = (index: number) => `${instanceId}-option-${index}`;

	// Fall back to the localized search placeholder when the caller doesn't pass one.
	let effectivePlaceholder = $derived(placeholder ?? $_("languagePicker.searchPlaceholder"));

	let selected = $derived(languageOptionForCode(value));

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return COMMON_LANGUAGES;
		return COMMON_LANGUAGES.filter((option) =>
			option.code.toLowerCase().includes(q)
			|| option.name.toLowerCase().includes(q)
			|| (option.native?.toLowerCase().includes(q) ?? false),
		);
	});

	// Whether the typed query is a brand-new code not already in the curated list.
	let customCode = $derived.by(() => {
		const q = query.trim();
		if (!q) return "";
		const exists = COMMON_LANGUAGES.some((o) => o.code.toLowerCase() === q.toLowerCase());
		return exists ? "" : q;
	});

	// The custom-code row (when present) sits at index === filtered.length, so the
	// total navigable option count is the filtered list plus that optional row.
	let optionCount = $derived(filtered.length + (customCode ? 1 : 0));
	// Only expose aria-activedescendant when the active index actually points at a
	// rendered option — otherwise screen readers would chase a dangling id.
	let hasActiveOption = $derived(optionCount > 0 && activeIndex < optionCount);

	function openList(): void {
		open = true;
		query = "";
		activeIndex = 0;
		requestAnimationFrame(() => inputEl?.focus());
	}

	function closeList(): void {
		open = false;
		query = "";
	}

	function pick(code: string): void {
		const normalized = code.trim();
		if (!normalized) return;
		onChange(normalized);
		closeList();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (!open) {
			if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
				event.preventDefault();
				openList();
			}
			return;
		}
		const total = filtered.length + (customCode ? 1 : 0);
		if (event.key === "Escape") {
			event.preventDefault();
			closeList();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			activeIndex = total ? (activeIndex + 1) % total : 0;
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			activeIndex = total ? (activeIndex - 1 + total) % total : 0;
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (customCode && activeIndex === filtered.length) {
				pick(customCode);
			} else if (filtered[activeIndex]) {
				pick(filtered[activeIndex].code);
			} else if (customCode) {
				pick(customCode);
			}
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (!open || !rootEl) return;
		if (!rootEl.contains(event.target as Node)) closeList();
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="lang-picker" bind:this={rootEl}>
	<button
		type="button"
		{id}
		class="lang-picker-trigger"
		class:invalid={invalid}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={ariaLabel}
		data-invalid={invalid || undefined}
		aria-describedby={describedby}
		onclick={() => (open ? closeList() : openList())}
		onkeydown={onKeydown}
	>
		<span class="lang-picker-current">
			{#if selected.flag}<span class="lang-picker-flag" aria-hidden="true">{selected.flag}</span>{/if}
			<strong>{selected.name}</strong>
			<span class="lang-picker-code">{selected.code.toUpperCase()}</span>
		</span>
		<span class="lang-picker-caret" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<div class="lang-picker-pop" role="dialog" aria-label={ariaLabel}>
			<input
				bind:this={inputEl}
				bind:value={query}
				type="text"
				class="lang-picker-search"
				placeholder={effectivePlaceholder}
				autocomplete="off"
				spellcheck="false"
				role="combobox"
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={hasActiveOption ? optionId(activeIndex) : undefined}
				onkeydown={onKeydown}
				oninput={() => (activeIndex = 0)}
			/>
			<ul id={listId} class="lang-picker-list" role="listbox" aria-label={ariaLabel}>
				{#each filtered as option, index (option.code)}
					<li>
						<button
							type="button"
							id={optionId(index)}
							role="option"
							aria-selected={option.code.toLowerCase() === value.toLowerCase()}
							class="lang-picker-option"
							class:active={index === activeIndex}
							onmouseenter={() => (activeIndex = index)}
							onclick={() => pick(option.code)}
						>
							{#if option.flag}<span class="lang-picker-flag" aria-hidden="true">{option.flag}</span>{/if}
							<span class="lang-picker-option-name">{option.name}</span>
							{#if option.native}<span class="lang-picker-native">{option.native}</span>{/if}
							<span class="lang-picker-code">{option.code.toUpperCase()}</span>
						</button>
					</li>
				{/each}
				{#if customCode}
					<li>
						<button
							type="button"
							id={optionId(filtered.length)}
							role="option"
							aria-selected="false"
							class="lang-picker-option lang-picker-custom"
							class:active={activeIndex === filtered.length}
							onmouseenter={() => (activeIndex = filtered.length)}
							onclick={() => pick(customCode)}
						>
							<span class="lang-picker-flag" aria-hidden="true">＋</span>
							<span class="lang-picker-option-name">{$_("languagePicker.useCode", { values: { code: customCode } })}</span>
							<span class="lang-picker-code">{customCode.toUpperCase()}</span>
						</button>
					</li>
				{/if}
				{#if !filtered.length && !customCode}
					<li class="lang-picker-empty">{$_("languagePicker.empty")}</li>
				{/if}
			</ul>
			<p class="lang-picker-hint">{$_("languagePicker.hint")}</p>
		</div>
	{/if}
</div>

<style>
	.lang-picker {
		position: relative;
		width: 100%;
	}

	.lang-picker-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-height: 42px;
		padding: 8px 12px;
		border: 1px solid var(--ws-hair-strong, rgba(166, 183, 220, 0.28));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(4, 7, 12, 0.86);
		color: var(--color-ws-ink, #e2e8f0);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.lang-picker-trigger:hover {
		border-color: rgba(124, 92, 255, 0.45);
	}

	.lang-picker-trigger:focus-visible {
		outline: none;
		border-color: rgba(124, 92, 255, 0.6);
		box-shadow: 0 0 0 2px rgba(124, 92, 255, 0.25);
	}

	.lang-picker-trigger.invalid {
		border-color: rgba(248, 113, 113, 0.58);
		background: rgba(69, 10, 10, 0.36);
		box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.18);
	}

	.lang-picker-current {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.lang-picker-current strong {
		overflow: hidden;
		color: var(--color-ws-ink, #e2e8f0);
		font-size: 13px;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lang-picker-flag {
		font-size: 16px;
		line-height: 1;
	}

	.lang-picker-code {
		flex: 0 0 auto;
		padding: 1px 6px;
		border-radius: 5px;
		background: rgba(124, 92, 255, 0.16);
		color: #cbb9ff;
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0.04em;
	}

	.lang-picker-caret {
		color: var(--editor-text-muted, #94a3b8);
		font-size: 11px;
	}

	.lang-picker-pop {
		position: absolute;
		z-index: 40;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		display: grid;
		gap: 8px;
		padding: 8px;
		border: 1px solid rgba(124, 92, 255, 0.3);
		border-radius: 12px;
		background: rgba(10, 13, 20, 0.98);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
	}

	.lang-picker-search {
		width: 100%;
		min-height: 38px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair-strong, rgba(166, 183, 220, 0.28));
		border-radius: 8px;
		background: rgba(4, 7, 12, 0.9);
		color: var(--color-ws-ink, #e2e8f0);
		font: inherit;
		font-size: 13px;
	}

	.lang-picker-search:focus-visible {
		outline: none;
		border-color: rgba(124, 92, 255, 0.55);
		box-shadow: 0 0 0 2px rgba(124, 92, 255, 0.22);
	}

	.lang-picker-list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		max-height: 230px;
		overflow-y: auto;
		list-style: none;
		scrollbar-width: thin;
	}

	.lang-picker-option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		color: var(--color-ws-ink, #e2e8f0);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		text-align: left;
	}

	.lang-picker-option.active,
	.lang-picker-option[aria-selected="true"] {
		border-color: rgba(124, 92, 255, 0.4);
		background: rgba(124, 92, 255, 0.14);
	}

	.lang-picker-option-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-weight: 750;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lang-picker-native {
		flex: 0 0 auto;
		color: var(--editor-text-muted, #94a3b8);
		font-size: 11px;
		font-weight: 600;
	}

	.lang-picker-custom .lang-picker-option-name {
		color: #cbb9ff;
		font-weight: 800;
	}

	.lang-picker-empty {
		padding: 10px;
		color: var(--editor-text-muted, #94a3b8);
		font-size: 12px;
		text-align: center;
	}

	.lang-picker-hint {
		margin: 0;
		padding: 0 4px;
		color: var(--editor-text-muted, #94a3b8);
		font-size: 11px;
		font-weight: 650;
		line-height: 1.4;
	}
</style>
