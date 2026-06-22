<script lang="ts">
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { evaluatePassword } from "$lib/auth/password-policy.ts";
	import PasswordStrengthMeter from "./PasswordStrengthMeter.svelte";
	import SsoButtons from "./SsoButtons.svelte";
	import TurnstileWidget from "./TurnstileWidget.svelte";
	import { config } from "$lib/config.ts";
	import { _ } from "$lib/i18n";
	import "./auth-shared.css";

	interface Props {
		onSuccess?: () => void;
	}

	let { onSuccess }: Props = $props();

	let email = $state("");
	let name = $state("");
	let password = $state("");
	let confirm = $state("");
	let agreed = $state(false);
	let showPassword = $state(false);
	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let turnstileToken = $state("");
	let turnstileRef = $state<{ reset: () => void } | null>(null);
	const turnstileRequired = Boolean(config.turnstileSiteKey);
	const EMAIL_MAX_LENGTH = 254;
	const NAME_MAX_LENGTH = 200;

	let mismatch = $derived(confirm.length > 0 && confirm !== password);
	let passwordPolicy = $derived(evaluatePassword(password));
	let nameOk = $derived(name.trim().length > 0 && name.length <= NAME_MAX_LENGTH);
	let emailTooLong = $derived(email.length > EMAIL_MAX_LENGTH);
	let nameTooLong = $derived(name.length > NAME_MAX_LENGTH);
	let emailOk = $derived(!emailTooLong && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
	let passwordOk = $derived(passwordPolicy.valid);
	let confirmOk = $derived(confirm.length > 0 && confirm === password);
	let displayError = $derived(formErrorKey ? $_(formErrorKey) : formError);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		if (emailTooLong) {
			formError = $_("auth.emailTooLong");
			return;
		}
		if (nameTooLong) {
			formError = $_("auth.nameTooLong");
			return;
		}

		const policy = evaluatePassword(password);
		if (!policy.valid) {
			formError = policy.firstUnmetRuleId
				? $_("passwordPolicy.firstError", { values: { rule: $_(`passwordPolicy.rule_${policy.firstUnmetRuleId}`, { values: { n: policy.firstUnmetRuleId === "maxlength" ? policy.maxLength : policy.minLength } }) } })
				: $_("auth.passwordWeak");
			return;
		}
		if (password !== confirm) {
			formError = $_("auth.passwordMismatch");
			return;
		}
		if (!agreed) {
			formError = $_("auth.mustAgree");
			return;
		}
		if (turnstileRequired && !turnstileToken) {
			formError = $_("authSignup.botCheck");
			return;
		}

		busy = true;
		try {
			await authStore.signup({ email: email.trim(), password, name: name.trim(), turnstileToken: turnstileToken || undefined });
			onSuccess?.();
		} catch {
			formErrorKey = authStore.errorKey ?? "auth.errors.registerFailed";
			// The Turnstile token is single-use; re-challenge for the next attempt.
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

	<label class="auth-field" for="auth-signup-name">
		<span class="auth-field-label">{$_("auth.displayName")} <span class="auth-required" class:auth-required-ok={nameOk} aria-hidden="true">{nameOk ? "✓" : "*"}</span></span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-signup-name"
				type="text"
				autocomplete="name"
				aria-label={$_("auth.displayName")}
				placeholder={$_("auth.namePlaceholder")}
				maxlength={NAME_MAX_LENGTH}
				required
				aria-invalid={nameTooLong}
				bind:value={name}
				disabled={busy}
			/>
		</div>
		{#if nameTooLong}
			<span class="auth-field-error">{$_("auth.nameTooLong")}</span>
		{/if}
	</label>

	<label class="auth-field" for="auth-signup-email">
		<span class="auth-field-label">{$_("auth.email")} <span class="auth-required" class:auth-required-ok={emailOk} aria-hidden="true">{emailOk ? "✓" : "*"}</span></span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-signup-email"
				type="email"
				autocomplete="email"
				aria-label={$_("auth.email")}
				maxlength={EMAIL_MAX_LENGTH}
				required
				aria-invalid={emailTooLong}
				bind:value={email}
				disabled={busy}
			/>
		</div>
		{#if emailTooLong}
			<span class="auth-field-error">{$_("auth.emailTooLong")}</span>
		{/if}
	</label>

	<label class="auth-field" for="auth-signup-password">
		<span class="auth-field-label">{$_("auth.password")} <span class="auth-required" class:auth-required-ok={passwordOk} aria-hidden="true">{passwordOk ? "✓" : "*"}</span></span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-signup-password"
				type={showPassword ? "text" : "password"}
				autocomplete="new-password"
				aria-label={$_("auth.password")}
				minlength="8"
				required
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
		<PasswordStrengthMeter {password} />
	</label>

	<label class="auth-field" for="auth-signup-confirm">
		<span class="auth-field-label">{$_("auth.confirmPassword")} <span class="auth-required" class:auth-required-ok={confirmOk} aria-hidden="true">{confirmOk ? "✓" : "*"}</span></span>
		<div class="auth-field-control">
			<input
				class="auth-input"
				id="auth-signup-confirm"
				type={showPassword ? "text" : "password"}
				autocomplete="new-password"
				aria-label={$_("auth.confirmPassword")}
				minlength="8"
				required
				aria-invalid={mismatch}
				bind:value={confirm}
				disabled={busy}
			/>
		</div>
		{#if mismatch}
			<span class="auth-field-error">{$_("auth.passwordMismatch")}</span>
		{/if}
	</label>

	<label class="auth-check">
		<input type="checkbox" bind:checked={agreed} disabled={busy} />
		<span>
			{$_("auth.agreePrefix")}
			<a href="/terms" target="_blank" rel="noopener">{$_("auth.termsLink")}</a>
			{$_("auth.agreeAnd")}
			<a href="/privacy" target="_blank" rel="noopener">{$_("auth.privacyLink")}</a>
		</span>
	</label>

	<TurnstileWidget action="auth_register" bind:token={turnstileToken} bind:this={turnstileRef} />

	<button type="submit" class="auth-submit" disabled={busy || (turnstileRequired && !turnstileToken)}>
		{#if busy}
			<span class="auth-submit-spinner" aria-hidden="true"></span>
			{$_("auth.registerBusyCta")}
		{:else}
			{$_("auth.registerCta")}
		{/if}
	</button>

	<SsoButtons mode="register" disabled={busy} dividerLabel={$_("auth.ssoDividerRegister")} />

	<div class="auth-row">
		<span>{$_("auth.hasAccount")}</span>
		<a href="/login">{$_("auth.signIn")}</a>
	</div>
</form>
