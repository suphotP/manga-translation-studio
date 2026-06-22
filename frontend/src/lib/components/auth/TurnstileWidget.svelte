<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { config } from "$lib/config.ts";
	import { loadTurnstileScript } from "$lib/auth/turnstile.ts";
	import { _ } from "$lib/i18n";

	interface Props {
		/** Must match the backend expectedAction (auth_register / auth_login / auth_resend_verification). */
		action: string;
		/** Bindable: the solved Turnstile response token (empty until solved). */
		token?: string;
		/** Called when the challenge errors so the parent can surface a message. */
		onError?: () => void;
	}
	let { action, token = $bindable(""), onError }: Props = $props();

	const siteKey = config.turnstileSiteKey;
	let container: HTMLDivElement | null = $state(null);
	let widgetId: string | null = null;
	let failed = $state(false);

	/** Re-challenge after a single-use token was spent (e.g. a 403 on submit). */
	export function reset(): void {
		token = "";
		if (widgetId !== null && typeof window !== "undefined" && window.turnstile) {
			window.turnstile.reset(widgetId);
		}
	}

	onMount(() => {
		if (!siteKey) return; // Turnstile off → render nothing, no gating.
		void (async () => {
			try {
				await loadTurnstileScript();
				if (!container || !window.turnstile) return;
				widgetId = window.turnstile.render(container, {
					sitekey: siteKey,
					action,
					callback: (value: string) => { token = value; failed = false; },
					"error-callback": () => { token = ""; failed = true; onError?.(); },
					"expired-callback": () => { token = ""; },
				});
			} catch {
				failed = true;
				onError?.();
			}
		})();
	});

	onDestroy(() => {
		if (widgetId !== null && typeof window !== "undefined" && window.turnstile) {
			try { window.turnstile.remove(widgetId); } catch { /* already gone */ }
		}
		// Clear the bound token on unmount. A Turnstile response is single-use, but
		// persistent surfaces (AuthModal / AuthAccountMenu) unmount this widget after a
		// successful auth or close and later REMOUNT it in the same SPA session. Without
		// this, the parent's bound token stays truthy across the remount, so its
		// `disabled={!token}` submit re-enables with an already-spent token and the next
		// login/register sends it — a guaranteed timeout-or-duplicate 403. Reset to ""
		// so the next mount starts disabled until a fresh solve.
		token = "";
	});
</script>

{#if siteKey}
	<div class="turnstile-widget">
		<div bind:this={container}></div>
		{#if failed}
			<p class="turnstile-error" role="alert">{$_("turnstileWidget.loadFailed")}</p>
		{/if}
	</div>
{/if}

<style>
	.turnstile-widget {
		margin: 4px 0 12px;
	}
	.turnstile-error {
		margin: 6px 0 0;
		font-size: 12.5px;
		color: var(--color-ws-rose);
	}
</style>
