<script lang="ts">
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { config } from "$lib/config.ts";
	import { _ } from "$lib/i18n";
	import SsoButtons from "./SsoButtons.svelte";
	import TurnstileWidget from "./TurnstileWidget.svelte";
	import "./auth-shared.css";

	interface Props {
		/** Where to send the user on successful sign-in. */
		onSuccess?: () => void;
	}

	let { onSuccess }: Props = $props();

	const recoveryEnabled = config.authRecoveryEnabled;
	const turnstileRequired = Boolean(config.turnstileSiteKey);

	let email = $state("");
	let password = $state("");
	let showPassword = $state(false);
	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let turnstileToken = $state("");
	let turnstileRef = $state<{ reset: () => void } | null>(null);
	const EMAIL_MAX_LENGTH = 254;
	let displayError = $derived(formErrorKey ? $_(formErrorKey) : formError);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		if (turnstileRequired && !turnstileToken) {
			formError = $_("authLogin.botCheck");
			return;
		}
		busy = true;
		try {
			await authStore.login(email.trim(), password, turnstileToken || undefined);
			onSuccess?.();
		} catch {
			formErrorKey = authStore.errorKey ?? "auth.errors.loginFailed";
			// Single-use token spent — re-challenge for the next attempt.
			turnstileRef?.reset();
		} finally {
			busy = false;
		}
	}
</script>

<form class="auth-form" onsubmit={handleSubmit} novalidate>
	{#if displayError}
		<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
	{/if}

	<label class="auth-field" for="auth-login-email">
		<span class="auth-field-label">{$_("auth.email")}</span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-login-email"
				type="email"
				autocomplete="email"
				maxlength={EMAIL_MAX_LENGTH}
				required
				bind:value={email}
				disabled={busy}
			/>
		</div>
	</label>

	<label class="auth-field" for="auth-login-password">
		<span class="auth-field-label">{$_("auth.password")}</span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-login-password"
				type={showPassword ? "text" : "password"}
				autocomplete="current-password"
				required
				minlength="8"
				bind:value={password}
				disabled={busy}
			/>
			<button
				type="button"
				class="auth-field-suffix"
				aria-pressed={showPassword}
				aria-label={showPassword ? $_("auth.hidePassword") : $_("auth.showPassword")}
				onclick={() => (showPassword = !showPassword)}
				tabindex="-1"
			>
				{showPassword ? $_("auth.hide") : $_("auth.show")}
			</button>
		</div>
	</label>

	<div class="auth-row">
		{#if recoveryEnabled}
			<a href="/forgot-password">{$_("auth.forgotPasswordLink")}</a>
		{:else}
			<span></span>
		{/if}
		<a href="/signup">{$_("auth.createAccount")}</a>
	</div>

	<TurnstileWidget action="auth_login" bind:token={turnstileToken} bind:this={turnstileRef} />

	<button type="submit" class="auth-submit" disabled={busy || (turnstileRequired && !turnstileToken)}>
		{#if busy}
			<span class="auth-submit-spinner" aria-hidden="true"></span>
			{$_("auth.loginBusyCta")}
		{:else}
			{$_("auth.loginCta")}
		{/if}
	</button>

	<SsoButtons mode="login" disabled={busy} dividerLabel={$_("auth.ssoDividerLogin")} />
</form>
