<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { config } from "$lib/config.ts";
	import TurnstileWidget from "./TurnstileWidget.svelte";
	import OtpInput from "./OtpInput.svelte";
	import "./auth-shared.css";

	const recoveryEnabled = config.authRecoveryEnabled;
	const turnstileRequired = Boolean(config.turnstileSiteKey);

	interface Props {
		/** Optional pre-OTP magic-link token (`/verify-email?token=...`). Backward
		 *  compatibility: outstanding links still verify; an expired/used one falls
		 *  through to the numeric OTP form. */
		token?: string;
	}
	let { token = "" }: Props = $props();

	let linkPhase = $state<"idle" | "verifying" | "error">("idle");
	onMount(() => {
		if (token && recoveryEnabled) {
			linkPhase = "verifying";
			void redeemLink();
		}
	});
	async function redeemLink(): Promise<void> {
		try {
			await authStore.verifyEmail(token);
			await goto("/onboarding", { replaceState: true });
		} catch {
			// Expired/used link. The OTP fallback (submit + resend) needs a signed-in
			// session, so a logged-out visitor is sent to sign in rather than stranded on
			// a form that can only 401. A signed-in user drops to the OTP form instead.
			if (!authStore.isAuthenticated) {
				await goto("/login", { replaceState: true });
				return;
			}
			linkPhase = "error";
		}
	}

	let code = $state("");
	let submitting = $state(false);
	let resending = $state(false);
	let resendCooldown = $state(0);
	let error = $state<string | null>(null);
	let errorKey = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let turnstileToken = $state("");
	let turnstileRef = $state<{ reset: () => void } | null>(null);

	const email = $derived(authStore.currentUser?.email ?? "");
	const canSubmit = $derived(/^\d{6}$/.test(code) && !submitting);
	// Keep OTP email boundary spacing in markup; locale strings should not own it.
	const otpEmailBoundarySpace = " ";
	let displayError = $derived(errorKey ? $_(errorKey) : error);

	// 60s cooldown so a user can't hammer the (cost-bearing) resend email button.
	let cooldownTimer: ReturnType<typeof setInterval> | null = null;
	function startCooldown(seconds = 60): void {
		resendCooldown = seconds;
		if (cooldownTimer) clearInterval(cooldownTimer);
		cooldownTimer = setInterval(() => {
			resendCooldown -= 1;
			if (resendCooldown <= 0 && cooldownTimer) {
				clearInterval(cooldownTimer);
				cooldownTimer = null;
			}
		}, 1000);
	}
	onDestroy(() => {
		if (cooldownTimer) clearInterval(cooldownTimer);
	});

	async function submit(event?: Event): Promise<void> {
		event?.preventDefault();
		if (!canSubmit) return;
		submitting = true;
		error = null;
		errorKey = null;
		notice = null;
		try {
			await authStore.verifyOtp(code.trim());
			await goto("/onboarding", { replaceState: true });
		} catch {
			errorKey = authStore.errorKey ?? "auth.errors.otpFailed";
		} finally {
			submitting = false;
		}
	}

	async function resend(): Promise<void> {
		if (resending || resendCooldown > 0) return;
		if (turnstileRequired && !turnstileToken) {
			errorKey = null;
			error = $_("authVerify.turnstileResend");
			return;
		}
		resending = true;
		error = null;
		errorKey = null;
		notice = null;
		try {
			await authStore.resendVerification(turnstileToken || undefined);
			notice = $_("authVerify.resendSuccess");
			startCooldown(60);
		} catch {
			errorKey = authStore.errorKey ?? "auth.errors.resendFailed";
		} finally {
			resending = false;
			// Single-use token spent on the attempt — re-challenge for the next resend.
			turnstileRef?.reset();
		}
	}

	async function signOut(): Promise<void> {
		await authStore.logout();
		await goto("/login", { replaceState: true });
	}
</script>

<div class="auth-form" aria-live="polite">
	{#if !recoveryEnabled}
		<div class="auth-alert auth-alert-info" role="status">
			{$_("authVerify.recoveryDisabled")}
		</div>
		<div class="auth-row">
			<a href="/login">{$_("auth.backToLogin")}</a>
			<a href="/onboarding">{$_("authVerify.start")}</a>
		</div>
	{:else if linkPhase === "verifying"}
		<div class="auth-alert auth-alert-info">
			<span class="auth-submit-spinner" aria-hidden="true"></span>
			{$_("authVerify.verifyingLink")}
		</div>
	{:else}
		{#if linkPhase === "error"}
			<div class="auth-alert auth-alert-error" role="alert">
				{$_("authVerify.linkExpired")}
			</div>
		{/if}
		<p class="otp-help">
			{$_("authVerify.otpHelpPrefix").trimEnd()}{#if email}{otpEmailBoundarySpace}<strong>{email}</strong>{otpEmailBoundarySpace}{$_("authVerify.otpHelpSuffix").trimStart()}{:else}{$_("authVerify.otpHelpSuffix")}{/if}
		</p>
		<form class="otp-verify-form" onsubmit={submit}>
			<OtpInput
				bind:value={code}
				length={6}
				autofocus
				disabled={submitting}
				invalid={Boolean(displayError)}
				ariaLabel={$_("authVerify.otpAria")}
				onComplete={() => submit()}
			/>
			{#if displayError}
				<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
			{/if}
			{#if notice}
				<div class="auth-alert auth-alert-success" role="status">{notice}</div>
			{/if}
			<button type="submit" class="auth-submit" disabled={!canSubmit}>
				{#if submitting}<span class="auth-submit-spinner" aria-hidden="true"></span>{/if}
				{submitting ? $_("authVerify.submitting") : $_("authVerify.submit")}
			</button>
		</form>
		<!-- Turnstile gates the cost-bearing resend (a real email send), not the
		     session-scoped + rate-limited code entry above. -->
		<TurnstileWidget action="auth_resend_verification" bind:token={turnstileToken} bind:this={turnstileRef} />
		<div class="auth-row">
			<button type="button" class="auth-action-link" onclick={resend} disabled={resending || resendCooldown > 0 || (turnstileRequired && !turnstileToken)}>
				{resendCooldown > 0 ? $_("authVerify.resendCooldown", { values: { seconds: resendCooldown } }) : $_("authVerify.resendBtn")}
			</button>
			<button type="button" class="auth-action-link" onclick={signOut}>{$_("authVerify.signOut")}</button>
		</div>
	{/if}
</div>

<style>
	.otp-help {
		margin: 0 0 14px;
		font-size: 14px;
		line-height: 1.5;
		color: var(--color-ws-text);
	}
	/* Give the error / success alert breathing room from the submit button below it
	   (the OTP boxes already leave 14px above), so it never crams against the button. */
	.otp-verify-form .auth-alert {
		margin: 2px 0 14px;
	}
</style>
