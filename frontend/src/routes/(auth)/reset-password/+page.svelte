<script lang="ts">
	import { page } from "$app/stores";
	import AuthShell from "$lib/components/auth/AuthShell.svelte";
	import AuthResetForm from "$lib/components/auth/AuthResetForm.svelte";
	import { _ } from "$lib/i18n";

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let token = $derived($page.url.searchParams.get("token") ?? "");
</script>

<svelte:head>
	<title>{msg("auth.routes.resetMetaTitle", "ตั้งรหัสผ่านใหม่ · Comic Workspace")}</title>
</svelte:head>

<AuthShell
	eyebrow="Comic Workspace"
	title={msg("auth.routes.resetTitle", "ตั้งรหัสผ่านใหม่")}
	subtitle={msg("auth.routes.resetSubtitle", "เลือกรหัสผ่านที่จำได้แต่เดาไม่ออก ความยาวอย่างน้อย 8 ตัวอักษร")}
>
	<AuthResetForm {token} />

	{#snippet footer()}
		{msg("auth.routes.resetFooterPrompt", "นึกออกแล้ว?")} <a href="/login">{msg("auth.signIn", "เข้าใช้งาน")}</a>
	{/snippet}
</AuthShell>
