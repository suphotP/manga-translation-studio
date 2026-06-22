<script lang="ts">
	import AuthShell from "$lib/components/auth/AuthShell.svelte";
	import AuthForgotForm from "$lib/components/auth/AuthForgotForm.svelte";
	import { _ } from "$lib/i18n";

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<svelte:head>
	<title>{msg("auth.routes.forgotMetaTitle", "ลืมรหัสผ่าน · Comic Workspace")}</title>
</svelte:head>

<AuthShell
	eyebrow="Comic Workspace"
	title={msg("auth.forgotTitle", "ลืมรหัสผ่าน")}
	subtitle={msg("auth.forgotSubtitle", "ใส่อีเมลของบัญชี เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้")}
>
	<AuthForgotForm />

	{#snippet footer()}
		{msg("auth.routes.forgotFooterPrompt", "นึกออกแล้ว?")} <a href="/login">{msg("auth.signIn", "เข้าใช้งาน")}</a>
	{/snippet}
</AuthShell>
