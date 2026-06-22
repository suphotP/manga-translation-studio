<script lang="ts">
	import { locale, _, setLocale } from "$lib/i18n";
	import { LANGUAGE_OPTIONS as languages } from "$lib/i18n/languageOptions";

	let isOpen = $state(false);

	function selectLanguage(code: string) {
		setLocale(code);
		isOpen = false;
	}

	function getCurrentLanguage() {
		return languages.find((lang) => lang.code === $locale) || languages[0];
	}
</script>

<div class="language-switcher" class:open={isOpen}>
	<button class="lang-btn" onclick={() => isOpen = !isOpen} aria-label={$_("languageSwitcher.selectLanguage")}>
		<span class="flag">{getCurrentLanguage().flag}</span>
		<span class="lang-code">{getCurrentLanguage().code.toUpperCase()}</span>
		<span class="arrow">{isOpen ? "▾" : "▸"}</span>
	</button>

	{#if isOpen}
		<div class="lang-dropdown">
			{#each languages as lang (lang.code)}
				<button
					class="lang-option"
					class:selected={lang.code === $locale}
					onclick={() => selectLanguage(lang.code)}
				>
					<span class="flag">{lang.flag}</span>
					<span class="lang-name">{lang.name}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.language-switcher {
		position: relative;
		display: inline-block;
	}

	.lang-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 40px;
		padding: 4px 8px;
		background: var(--editor-surface);
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		color: var(--editor-text);
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.lang-btn:hover {
		background: var(--editor-hover);
	}

	.flag {
		font-size: 14px;
	}

	.lang-code {
		font-weight: 500;
	}

	.arrow {
		font-size: 10px;
		color: var(--editor-text-dim);
	}

	.lang-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		background: var(--editor-surface);
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		min-width: 140px;
		z-index: 1000;
	}

	.lang-option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 40px;
		padding: 8px 12px;
		background: transparent;
		border: none;
		color: var(--editor-text);
		font-size: 13px;
		cursor: pointer;
		transition: background 0.1s;
	}

	.lang-option:hover {
		background: var(--editor-hover);
	}

	.lang-option.selected {
		background: var(--editor-accent);
		color: white;
	}

	.lang-name {
		flex: 1;
		text-align: left;
	}
</style>
