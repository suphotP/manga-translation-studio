<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import AuthShell from "$lib/components/auth/AuthShell.svelte";
	import AuthVerifyState from "$lib/components/auth/AuthVerifyState.svelte";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { _ } from "$lib/i18n";

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// Backward compatibility: an outstanding `/verify-email?token=...` magic link is
	// redeemed by AuthVerifyState itself, so we hand the token through.
	let token = $derived($page.url.searchParams.get("token") ?? "");

	onMount(() => {
		void (async () => {
			await authStore.init();
			// A magic link verifies on its own and may be opened while logged out — let
			// AuthVerifyState handle it without an auth redirect. The OTP form, by
			// contrast, needs a signed-in session; already-verified users skip ahead.
			if (token) return;
			if (!authStore.isAuthenticated) {
				await goto("/login", { replaceState: true });
			} else if (authStore.currentUser?.emailVerified) {
				await goto("/onboarding", { replaceState: true });
			}
		})();
	});
</script>

<svelte:head>
	<title>{msg("auth.routes.verifyMetaTitle", "ยืนยันอีเมล · Comic Workspace")}</title>
</svelte:head>

<AuthShell
	eyebrow="Comic Workspace"
	title={msg("auth.routes.verifyTitle", "ยืนยันอีเมล")}
	subtitle={msg("auth.routes.verifyOtpSubtitle", "กรอกรหัส 6 หลักที่เราส่งไปทางอีเมลเพื่อยืนยันบัญชี")}
>
	<AuthVerifyState {token} />
</AuthShell>
