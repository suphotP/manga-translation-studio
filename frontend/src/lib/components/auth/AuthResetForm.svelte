<script lang="ts">
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { config } from "$lib/config.ts";
	import { evaluatePassword } from "$lib/auth/password-policy.ts";
	import PasswordStrengthMeter from "./PasswordStrengthMeter.svelte";
	import { _ } from "$lib/i18n";
	import "./auth-shared.css";

	interface Props {
		token: string;
		onSuccess?: () => void;
	}

	let { token, onSuccess }: Props = $props();

	const recoveryEnabled = config.authRecoveryEnabled;

	let password = $state("");
	let confirm = $state("");
	let showPassword = $state(false);
	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let done = $state(false);

	let mismatch = $derived(confirm.length > 0 && confirm !== password);
	let displayError = $derived(formErrorKey ? $_(formErrorKey) : formError);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		if (!token) {
			formError = $_("authReset.invalidLinkTokenMissing");
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
		busy = true;
		try {
			await authStore.resetPassword(token, password);
			done = true;
			onSuccess?.();
		} catch {
			formErrorKey = authStore.errorKey ?? "auth.errors.resetFailed";
		} finally {
			busy = false;
		}
	}
</script>

{#if !recoveryEnabled}
	<div class="auth-form">
		<div class="auth-alert auth-alert-info" role="status">
			{$_("authReset.recoveryDisabled")}
		</div>
		<a class="auth-submit" style="text-decoration:none;" href="/login">{$_("auth.backToLogin")}</a>
	</div>
{:else if done}
	<div class="auth-form">
		<div class="auth-alert auth-alert-success" role="status">
			{$_("authReset.doneMessage")}
		</div>
		<a class="auth-submit" style="text-decoration:none;" href="/login">{$_("auth.signIn")}</a>
	</div>
{:else}
	<form class="auth-form" onsubmit={handleSubmit} novalidate>
		{#if displayError}
			<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
		{/if}
		{#if !token}
			<div class="auth-alert auth-alert-error" role="alert">
				{$_("authReset.invalidLink")}
			</div>
		{/if}

		<label class="auth-field" for="auth-reset-password">
			<span class="auth-field-label">{$_("authReset.newPassword")}</span>
			<div class="auth-field-control">
				<input
					class="auth-input"
					id="auth-reset-password"
					type={showPassword ? "text" : "password"}
					autocomplete="new-password"
					minlength="8"
						required
					bind:value={password}
					disabled={busy || !token}
				/>
				<button
					type="button"
					class="auth-field-suffix"
					aria-pressed={showPassword}
					onclick={() => (showPassword = !showPassword)}
					tabindex="-1"
				>
					{showPassword ? $_("auth.hide") : $_("auth.show")}
				</button>
			</div>
			<PasswordStrengthMeter {password} />
		</label>

		<label class="auth-field" for="auth-reset-confirm">
			<span class="auth-field-label">{$_("authReset.confirmNewPassword")}</span>
			<div class="auth-field-control">
				<input
					class="auth-input"
					id="auth-reset-confirm"
					type={showPassword ? "text" : "password"}
					autocomplete="new-password"
					required
					minlength="8"
						aria-invalid={mismatch}
					bind:value={confirm}
					disabled={busy || !token}
				/>
			</div>
			{#if mismatch}
				<span class="auth-field-error">{$_("auth.passwordMismatch")}</span>
			{/if}
		</label>

		<button type="submit" class="auth-submit" disabled={busy || !token}>
			{#if busy}
				<span class="auth-submit-spinner" aria-hidden="true"></span>
				{$_("authReset.busy")}
			{:else}
				{$_("authReset.submit")}
			{/if}
		</button>

		<div class="auth-row">
			<a href="/login">{$_("auth.backToLogin")}</a>
			<a href="/forgot-password">{$_("authReset.requestNewLink")}</a>
		</div>
	</form>
{/if}
