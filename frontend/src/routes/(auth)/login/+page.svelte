<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import AuthShell from "$lib/components/auth/AuthShell.svelte";
	import AuthLoginForm from "$lib/components/auth/AuthLoginForm.svelte";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { _ } from "$lib/i18n";

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const REDIRECT_COOKIE = "manga-editor.auth.intent.v1";

	function readIntent(): string | null {
		const url = $page.url;
		const queryRedirect = url.searchParams.get("redirect");
		if (queryRedirect && queryRedirect.startsWith("/") && !queryRedirect.startsWith("//")) {
			return queryRedirect;
		}
		if (typeof document !== "undefined") {
			const cookieMatch = document.cookie
				.split(";")
				.map((s) => s.trim())
				.find((c) => c.startsWith(`${REDIRECT_COOKIE}=`));
			if (cookieMatch) {
				const value = decodeURIComponent(cookieMatch.slice(REDIRECT_COOKIE.length + 1));
				if (value.startsWith("/") && !value.startsWith("//")) return value;
			}
		}
		return null;
	}

	function clearIntentCookie(): void {
		if (typeof document === "undefined") return;
		document.cookie = `${REDIRECT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
	}

	onMount(() => {
		void (async () => {
			await authStore.init();
			if (authStore.isAuthenticated) {
				const intent = readIntent() ?? "/";
				clearIntentCookie();
				await goto(intent, { replaceState: true });
			}
		})();
	});

	function onSuccess(): void {
		const intent = readIntent() ?? "/";
		clearIntentCookie();
		void goto(intent, { replaceState: true });
	}
</script>

<svelte:head>
	<title>{msg("auth.routes.loginMetaTitle", "เข้าใช้งาน · Comic Workspace")}</title>
</svelte:head>

<AuthShell
	eyebrow="Comic Workspace"
	title={msg("auth.loginTitle", "เข้าใช้งาน")}
	subtitle={msg("auth.loginSubtitle", "ใช้บัญชีเดียวกับทีมเพื่อซิงก์งาน เครดิต และสิทธิ์เข้าถึง")}
>
	<AuthLoginForm {onSuccess} />

	{#snippet footer()}
		{msg("auth.routes.loginFooterPrompt", "ยังไม่มีบัญชี?")} <a href="/signup">{msg("auth.routes.loginFooterLink", "สร้างบัญชีฟรี")}</a>
	{/snippet}
</AuthShell>
