<script lang="ts">
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { config } from "$lib/config.ts";
	import "./auth-shared.css";

	const recoveryEnabled = config.authRecoveryEnabled;

	let email = $state("");
	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let submitted = $state(false);
	const EMAIL_MAX_LENGTH = 254;

	// The forgot-password confirmation embeds the (user-controlled) email; split
	// the localized string on the {email} token so the email renders as a bold
	// *text* node (never HTML), with the rest of the copy localized.
	let forgotSentParts = $derived($_("auth.forgotSentTo").split("{email}"));
	let displayError = $derived(formErrorKey ? $_(formErrorKey) : formError);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		busy = true;
		try {
			await authStore.forgotPassword(email.trim());
			submitted = true;
		} catch {
			// Show the generic confirmation anyway to avoid account enumeration,
			// but keep an inline alert so people know something went wrong server-side.
			submitted = true;
			formErrorKey = authStore.errorKey ?? "auth.errors.forgotFailed";
		} finally {
			busy = false;
		}
	}
</script>

{#if !recoveryEnabled}
	<div class="auth-form">
		<div class="auth-alert auth-alert-info" role="status">
			{$_("auth.recoveryDisabled")}
		</div>
		<div class="auth-row">
			<a href="/login">{$_("auth.backToLogin")}</a>
			<a href="/signup">{$_("auth.createAccount")}</a>
		</div>
	</div>
{:else if submitted}
	<div class="auth-form">
		<div class="auth-alert auth-alert-success" role="status">
			{forgotSentParts[0]}<strong>{email}</strong>{forgotSentParts[1] ?? ""}
		</div>
		{#if displayError}
			<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
		{/if}
		<p class="auth-field-help">
			{$_("auth.checkSpam")}
		</p>
		<div class="auth-row">
			<a href="/login">{$_("auth.backToLogin")}</a>
			<button
				type="button"
				class="auth-action-link"
				onclick={() => { submitted = false; formError = null; formErrorKey = null; }}
			>
				{$_("auth.resend")}
			</button>
		</div>
	</div>
{:else}
	<form class="auth-form" onsubmit={handleSubmit} novalidate>
		{#if displayError}
			<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
		{/if}

		<p class="auth-field-help">
			{$_("auth.forgotHelp")}
		</p>

		<label class="auth-field" for="auth-forgot-email">
			<span class="auth-field-label">{$_("auth.email")}</span>
			<div class="auth-field-control">
				<input
					class="auth-input"
					id="auth-forgot-email"
					type="email"
					autocomplete="email"
					maxlength={EMAIL_MAX_LENGTH}
					required
					bind:value={email}
					disabled={busy}
				/>
			</div>
		</label>

		<button type="submit" class="auth-submit" disabled={busy || email.length === 0}>
			{#if busy}
				<span class="auth-submit-spinner" aria-hidden="true"></span>
				{$_("auth.forgotBusyCta")}
			{:else}
				{$_("auth.forgotCta")}
			{/if}
		</button>

		<div class="auth-row">
			<a href="/login">{$_("auth.backToLogin")}</a>
			<a href="/signup">{$_("auth.createAccount")}</a>
		</div>
	</form>
{/if}
