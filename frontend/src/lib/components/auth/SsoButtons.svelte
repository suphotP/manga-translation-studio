<script lang="ts">
	import { onMount } from "svelte";
	import { ssoStartUrl, type SsoProvider } from "$lib/api/client.ts";
	import { ssoProvidersStore } from "$lib/stores/sso-providers.svelte.ts";
	import { _ } from "$lib/i18n";

	interface Props {
		/** Optional divider label. Hidden when no providers render. */
		dividerLabel?: string;
		/** "login" tweaks the verb on the button label; "register" for sign-up. */
		mode?: "login" | "register";
		disabled?: boolean;
	}

	let { dividerLabel = undefined, mode = "login", disabled = false }: Props = $props();

	// Localized divider label (falls back to the SSO divider copy when the caller
	// omits it) and the per-mode provider verb. Derived so they re-render on a
	// locale change.
	let effectiveDividerLabel = $derived(dividerLabel ?? $_("ssoButtons.divider"));
	let providerVerb = $derived<Record<"login" | "register", string>>({
		login: $_("ssoButtons.verbLogin"),
		register: $_("ssoButtons.verbRegister"),
	});

	let enabled = $derived(ssoProvidersStore.enabled);

	onMount(() => {
		void ssoProvidersStore.load();
	});

	function start(provider: SsoProvider): void {
		if (disabled || typeof window === "undefined") return;
		// The backend /start endpoint 302s to the provider and sets the OAuth
		// state/PKCE cookies, so we must navigate (not fetch).
		window.location.href = ssoStartUrl(provider);
	}
</script>

{#if enabled.length > 0}
	{#if effectiveDividerLabel}
		<div class="sso-divider" role="separator" aria-label={effectiveDividerLabel}>
			<span>{effectiveDividerLabel}</span>
		</div>
	{/if}
	<div class="sso-buttons">
		{#each enabled as provider (provider.id)}
			<button
				type="button"
				class="sso-button"
				data-provider={provider.id}
				onclick={() => start(provider.id)}
				{disabled}
			>
				<span class="sso-icon" aria-hidden="true">
					{#if provider.id === "google"}
						<svg viewBox="0 0 18 18" width="18" height="18">
							<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.88 2.68-6.62z"/>
							<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
							<path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3.02-2.32z"/>
							<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.59C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.02 2.32C4.68 5.16 6.66 3.58 9 3.58z"/>
						</svg>
					{:else if provider.id === "github"}
						<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
							<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
						</svg>
					{:else if provider.id === "line"}
						<svg viewBox="0 0 24 24" width="18" height="18" fill="#06C755">
							<path d="M19.36 10.94c0-3.93-3.94-7.13-8.78-7.13S1.8 7.01 1.8 10.94c0 3.52 3.12 6.47 7.34 7.03.29.06.68.19.78.43.09.22.06.56.03.78l-.13.76c-.04.22-.18.88.77.48s5.13-3.02 7-5.17c1.29-1.42 1.9-2.86 1.9-4.32z"/>
						</svg>
					{/if}
				</span>
				<span class="sso-label">{providerVerb[mode]} {provider.name}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.sso-divider {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 4px 0;
		color: var(--color-ws-faint);
		font-size: 12px;
		font-weight: 700;
	}

	.sso-divider::before,
	.sso-divider::after {
		content: "";
		flex: 1;
		height: 1px;
		background: var(--ws-hair-strong);
	}

	.sso-buttons {
		display: grid;
		gap: 8px;
	}

	.sso-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 16px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 52%, transparent);
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition: border-color 0.14s ease, background 0.14s ease;
	}

	.sso-button:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-ws-line) 24%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface2) 88%, transparent);
	}

	.sso-button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.sso-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	:global(html[data-theme="light"]) .sso-button {
		background: var(--color-ws-ink);
		border-color: color-mix(in srgb, var(--color-ws-bg) 14%, transparent);
		color: var(--color-ws-bg);
	}

	:global(html[data-theme="light"]) .sso-button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-ink) 96%, var(--color-ws-bg));
		border-color: color-mix(in srgb, var(--color-ws-bg) 24%, transparent);
	}
</style>
