<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import AuthShell from "$lib/components/auth/AuthShell.svelte";
	import AuthSignupForm from "$lib/components/auth/AuthSignupForm.svelte";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { config } from "$lib/config.ts";
	import { _ } from "$lib/i18n";
	// Load the shared auth atom styles as a global (unscoped) stylesheet, matching
	// the auth form components. Importing via a scoped <style> @import scopes these
	// shared classes to this page and makes Svelte flag the ones only used by the
	// form atoms as "unused"; a JS import keeps them global with no behavior change.
	import "$lib/components/auth/auth-shared.css";

	const recoveryEnabled = config.authRecoveryEnabled;

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let signedUp = $state(false);
	let resendNotice = $state<string | null>(null);
	let resendNoticeKey = $state<string | null>(null);
	let resendNoticeText = $derived(resendNoticeKey ? $_(resendNoticeKey) : resendNotice);

	async function handleResend(): Promise<void> {
		resendNotice = null;
		resendNoticeKey = null;
		try {
			await authStore.resendVerification();
			resendNotice = msg("auth.routes.signupResentNotice", "ส่งอีเมลยืนยันใหม่แล้ว ตรวจกล่องอีเมลของคุณ");
		} catch {
			resendNoticeKey = authStore.errorKey ?? "auth.errors.resendFailed";
		}
	}

	onMount(() => {
		void (async () => {
			await authStore.init();
			if (authStore.isAuthenticated && !signedUp) {
				await goto(postSignupDestination(), { replaceState: true });
			}
		})();
	});

	// Prod requires email verification → land the user straight on the OTP screen.
	// Dev auto-verifies at register, so they skip it and go to onboarding.
	function postSignupDestination(): string {
		return authStore.requiresEmailVerification ? "/verify-email" : "/onboarding";
	}

	async function onSuccess(): Promise<void> {
		signedUp = true;
		await goto(postSignupDestination(), { replaceState: true });
	}
</script>

<svelte:head>
	<title>{msg("auth.routes.signupMetaTitle", "สร้างบัญชี · Comic Workspace")}</title>
</svelte:head>

<AuthShell
	eyebrow="Comic Workspace"
	title={signedUp
		? (recoveryEnabled
			? msg("auth.routes.signupVerifyTitle", "ยืนยันอีเมลของคุณ")
			: msg("auth.routes.signupDoneTitle", "สร้างบัญชีสำเร็จ"))
		: msg("auth.registerTitle", "สร้างบัญชี")}
	subtitle={signedUp
		? (recoveryEnabled
			? msg("auth.routes.signupVerifySubtitle", "เราส่งลิงก์ยืนยันไปที่อีเมลของคุณแล้ว เปิดลิงก์ในอีเมลเพื่อปลดล็อกการใช้งานเต็มรูปแบบ")
			: msg("auth.routes.signupDoneSubtitle", "บัญชีของคุณพร้อมใช้งานแล้ว ไปต่อที่หน้าเริ่มต้นได้เลย"))
		: msg("auth.registerSubtitle", "ใช้บัญชีเดียวกันกับทีมเพื่อซิงก์งาน คอมเมนต์ และเครดิต AI")}
>
	{#if signedUp}
		<div style="display:grid; gap:14px;">
			<div class="auth-alert auth-alert-success" role="status">
				{#if recoveryEnabled}
					{msg("auth.routes.signupWelcomeVerify", "ยินดีต้อนรับ! ตรวจกล่องอีเมลของคุณเพื่อยืนยันบัญชี ถ้ายังไม่เห็น ลองดูในโฟลเดอร์ spam")}
				{:else}
					{msg("auth.routes.signupWelcomeDone", "ยินดีต้อนรับ! บัญชีของคุณพร้อมใช้งานแล้ว")}
				{/if}
			</div>
			<a href="/onboarding" class="auth-submit" style="text-decoration:none;">
				{msg("auth.routes.signupGoOnboarding", "ไปต่อที่หน้าเริ่มต้น")}
			</a>
			{#if recoveryEnabled}
				<button
					type="button"
					class="auth-action-link"
					onclick={handleResend}
				>
					{msg("auth.routes.signupResend", "ส่งอีเมลยืนยันใหม่")}
				</button>
				{#if resendNoticeText}
					<p class="auth-field-help" role="status">{resendNoticeText}</p>
				{/if}
			{/if}
		</div>
	{:else}
		<AuthSignupForm {onSuccess} />
	{/if}

	{#snippet footer()}
		{#if signedUp}
			{msg("auth.routes.signupTroubleFooter", "มีปัญหา?")} <a href="/login">{msg("auth.routes.signupBackToLogin", "กลับไปหน้าเข้าใช้งาน")}</a>
		{:else}
			{msg("auth.routes.signupHasAccount", "มีบัญชีอยู่แล้ว?")} <a href="/login">{msg("auth.signIn", "เข้าใช้งาน")}</a>
		{/if}
	{/snippet}
</AuthShell>
