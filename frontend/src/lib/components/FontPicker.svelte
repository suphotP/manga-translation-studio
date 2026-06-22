<!-- FontPicker — Dropdown with font preview and Google Fonts integration -->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { _ } from '$lib/i18n';

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	interface FontOption {
		name: string;
		family: string;
		category: string;
		googleFont?: string;
	}

	interface Props {
		selectedFont: string;
		onFontChange: (font: string) => void;
		disabled?: boolean;
	}

	let { selectedFont, onFontChange, disabled = false }: Props = $props();

	const fontOptions: FontOption[] = [
		// Thai fonts
		{ name: 'Sarabun', family: "'Sarabun', sans-serif", category: 'Thai', googleFont: 'Sarabun' },
		{ name: 'Prompt', family: "'Prompt', sans-serif", category: 'Thai', googleFont: 'Prompt' },
		{ name: 'Kanit', family: "'Kanit', sans-serif", category: 'Thai', googleFont: 'Kanit' },
		// English fonts
		{ name: 'Roboto', family: "'Roboto', sans-serif", category: 'English', googleFont: 'Roboto' },
		{ name: 'Open Sans', family: "'Open Sans', sans-serif", category: 'English', googleFont: 'Open Sans' },
		{ name: 'Montserrat', family: "'Montserrat', sans-serif", category: 'English', googleFont: 'Montserrat' },
		// Japanese fonts
		{ name: 'Noto Sans JP', family: "'Noto Sans JP', sans-serif", category: 'Japanese', googleFont: 'Noto Sans JP' },
		// Korean fonts
		{ name: 'Noto Sans KR', family: "'Noto Sans KR', sans-serif", category: 'Korean', googleFont: 'Noto Sans KR' },
		// Chinese fonts
		{ name: 'Noto Sans SC', family: "'Noto Sans SC', sans-serif", category: 'Chinese', googleFont: 'Noto Sans SC' },
		// Web-safe fallback fonts
		{ name: 'Arial', family: 'Arial, sans-serif', category: 'Web Safe' },
		{ name: 'Tahoma', family: 'Tahoma, sans-serif', category: 'Web Safe' },
		{ name: 'Verdana', family: 'Verdana, sans-serif', category: 'Web Safe' },
		{ name: 'Georgia', family: 'Georgia, serif', category: 'Web Safe' },
		{ name: 'Times New Roman', family: '"Times New Roman", serif', category: 'Web Safe' },
		{ name: 'Courier New', family: '"Courier New", monospace', category: 'Web Safe' },
	];

	let isOpen = $state(false);
	let loadedFonts = $state(new Set<string>());
	let activeIndex = $state(-1);
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let listboxEl = $state<HTMLDivElement | null>(null);

	const listboxId = `font-picker-listbox-${Math.random().toString(36).slice(2, 8)}`;

	// Group fonts by category
	const categories = $derived(fontOptions.reduce((acc, font) => {
		if (!acc[font.category]) {
			acc[font.category] = [];
		}
		acc[font.category].push(font);
		return acc;
	}, {} as Record<string, FontOption[]>));

	// Flat, render-order list of options so arrow keys move across categories.
	const flatOptions = $derived(
		Object.values(categories).reduce<FontOption[]>((acc, fonts) => acc.concat(fonts), []),
	);

	function optionId(index: number): string {
		return `${listboxId}-opt-${index}`;
	}

	onMount(() => {
		// Load Google Fonts dynamically
		loadGoogleFonts();
	});

	function loadGoogleFonts() {
		const googleFonts = fontOptions
			.filter(f => f.googleFont && !loadedFonts.has(f.googleFont!))
			.map(f => f.googleFont!);

		if (googleFonts.length === 0) return;

		// Create Google Fonts link
		const linkId = 'google-fonts-link';
		let link = document.getElementById(linkId) as HTMLLinkElement;

		if (!link) {
			link = document.createElement('link');
			link.id = linkId;
			link.rel = 'stylesheet';
			document.head.appendChild(link);
		}

		const fontsParam = googleFonts.map(f => `family=${f.replace(/ /g, '+')}:wght@400;700`).join('&');
		link.href = `https://fonts.googleapis.com/css2?${fontsParam}&display=swap`;

		googleFonts.forEach(font => loadedFonts.add(font));
	}

	function selectFont(font: FontOption) {
		if (disabled) return;
		onFontChange(font.family);
		closeDropdown(true);
	}

	function getCurrentFontName(): string {
		const font = fontOptions.find(f => f.family === selectedFont);
		return font?.name || selectedFont;
	}

	async function openDropdown(focusActive = true) {
		if (disabled || isOpen) return;
		isOpen = true;
		// Start the highlight on the current selection (or the first option).
		const selected = flatOptions.findIndex(f => f.family === selectedFont);
		activeIndex = selected >= 0 ? selected : 0;
		if (focusActive) {
			await tick();
			scrollActiveIntoView();
		}
	}

	function closeDropdown(returnFocus = false) {
		if (!isOpen) return;
		isOpen = false;
		activeIndex = -1;
		if (returnFocus) triggerEl?.focus();
	}

	function toggleDropdown() {
		if (isOpen) closeDropdown(true);
		else void openDropdown();
	}

	function scrollActiveIntoView() {
		if (activeIndex < 0 || !listboxEl) return;
		const id = optionId(activeIndex);
		const selector = typeof CSS !== 'undefined' && CSS.escape ? `#${CSS.escape(id)}` : `[id="${id}"]`;
		const el = listboxEl.querySelector<HTMLElement>(selector);
		el?.scrollIntoView?.({ block: 'nearest' });
	}

	function moveActive(delta: number) {
		if (flatOptions.length === 0) return;
		const next = activeIndex < 0
			? (delta > 0 ? 0 : flatOptions.length - 1)
			: (activeIndex + delta + flatOptions.length) % flatOptions.length;
		activeIndex = next;
		scrollActiveIntoView();
	}

	function handleTriggerKeydown(event: KeyboardEvent) {
		if (disabled) return;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				event.preventDefault();
				if (!isOpen) {
					void openDropdown();
				} else {
					moveActive(event.key === 'ArrowDown' ? 1 : -1);
				}
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (!isOpen) {
					void openDropdown();
				} else if (activeIndex >= 0) {
					selectFont(flatOptions[activeIndex]);
				}
				break;
			case 'Home':
				if (isOpen) { event.preventDefault(); activeIndex = 0; scrollActiveIntoView(); }
				break;
			case 'End':
				if (isOpen) { event.preventDefault(); activeIndex = flatOptions.length - 1; scrollActiveIntoView(); }
				break;
			case 'Escape':
				if (isOpen) { event.preventDefault(); closeDropdown(true); }
				break;
			case 'Tab':
				// Let focus leave naturally, but close the popup first.
				closeDropdown(false);
				break;
		}
	}
</script>

<svelte:window onclick={(e) => {
	if (!isOpen) return;
	const target = e.target as Node;
	if (triggerEl?.contains(target) || listboxEl?.contains(target)) return;
	closeDropdown(false);
}} />

<div class="font-picker-container">
	{#if disabled}
		<span class="font-picker-button font-picker-receipt" role="status" aria-label={t('fontPicker.readonlyAria', 'ฟอนต์อ่านอย่างเดียว')}>
			<span class="font-picker-preview" style="font-family: {selectedFont}">
				{getCurrentFontName()}
			</span>
			<span class="font-picker-readonly-note">{t('fontPicker.readonlyNote', 'อ่านอย่างเดียว')}</span>
		</span>
	{:else}
		<button
			bind:this={triggerEl}
			type="button"
			class="font-picker-button"
			role="combobox"
			aria-label={t('fontPicker.triggerAria', 'ฟอนต์: {font}').replace('{font}', getCurrentFontName())}
			aria-haspopup="listbox"
			aria-expanded={isOpen}
			aria-controls={listboxId}
			aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
			onclick={toggleDropdown}
			onkeydown={handleTriggerKeydown}
		>
			<span class="font-picker-preview" style="font-family: {selectedFont}">
				{getCurrentFontName()}
			</span>
			<span class="font-picker-arrow" aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
		</button>
	{/if}

	{#if isOpen}
		<div
			bind:this={listboxEl}
			id={listboxId}
			class="font-picker-dropdown"
			role="listbox"
			tabindex="-1"
			aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
		>
			{#each Object.entries(categories) as [category, fonts] (category)}
				<div class="font-category" role="group" aria-label={category}>
					<div class="font-category-header" aria-hidden="true">{category}</div>
					{#each fonts as font (font.family)}
						{@const index = flatOptions.indexOf(font)}
						<button
							type="button"
							id={optionId(index)}
							role="option"
							aria-selected={font.family === selectedFont}
							class="font-option"
							class:selected={font.family === selectedFont}
							class:active={index === activeIndex}
							style="font-family: {font.family}"
							tabindex="-1"
							onclick={() => selectFont(font)}
							onmousemove={() => { activeIndex = index; }}
						>
							{font.name}
						</button>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.font-picker-container {
		position: relative;
		width: 100%;
	}

	.font-picker-button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: 40px;
		padding: 7px 10px;
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(4, 7, 12, 0.6);
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		cursor: pointer;
		outline: none;
		transition: border-color 0.14s ease, background 0.14s ease;
	}

	button.font-picker-button:hover {
		border-color: rgba(124, 92, 255, 0.5);
		background: rgba(255, 255, 255, 0.04);
	}

	button.font-picker-button:focus-visible {
		border-color: rgba(124, 92, 255, 0.6);
		box-shadow: 0 0 0 1px rgba(124, 92, 255, 0.3);
	}

	.font-picker-receipt {
		opacity: 0.45;
		cursor: default;
	}

	.font-picker-preview {
		flex: 1;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.font-picker-arrow {
		margin-left: 8px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
	}

	.font-picker-readonly-note {
		margin-left: 8px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		white-space: nowrap;
	}

	.font-picker-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 1000;
		max-height: 280px;
		overflow-y: auto;
		background: #15151d;
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.11));
		border-radius: var(--radius-ws-ctrl, 10px);
		margin-top: 4px;
		box-shadow: 0 14px 40px -20px rgba(0, 0, 0, 0.9);
		scrollbar-width: thin;
	}

	.font-category {
		border-bottom: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	.font-category:last-child {
		border-bottom: none;
	}

	.font-category-header {
		padding: 6px 8px 4px;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-ws-accent, #7c5cff);
		background: rgba(255, 255, 255, 0.025);
	}

	.font-option {
		display: block;
		width: 100%;
		min-height: 40px;
		padding: 8px 10px;
		border: none;
		background: transparent;
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		outline: none;
	}

	.font-option:hover,
	.font-option.active {
		background: rgba(255, 255, 255, 0.05);
	}

	.font-option.active {
		box-shadow: inset 0 0 0 1px rgba(124, 92, 255, 0.5);
	}

	.font-option.selected {
		background: rgba(124, 92, 255, 0.18);
		color: #fff;
	}
</style>
