<!-- /settings/members — the single, coherent member-management surface. Lives in
     the same settings-shell chrome as billing/usage/notifications/privacy (the
     +layout adds a Members tab). The legacy duplicate under the (workspace) route
     group rendered the whole WorkspaceShell here, which is why direct /settings/members
     visits looked dead — that route has been removed in favour of this one.

     On a hard reload / direct link nothing else restores the session or loads the
     workspace list (no WorkspaceSidebar mounts here), so we do both ourselves before
     rendering the shared panel. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import WorkspaceMembersPanel from "$lib/components/WorkspaceMembersPanel.svelte";

	// $_ returns the key itself on a miss / before init — fall back to Thai so the
	// header never leaks a raw English label into the Thai-default UI.
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	onMount(async () => {
		// Restore the stored session first (idempotent), then load workspaces for the
		// signed-in identity. syncWithAuth handles the anonymous → signed-in case and
		// dedups against an already-loaded user, so it is safe to call on every mount.
		await authStore.init();
		try {
			await workspacesStore.syncWithAuth(authStore.user?.id ?? null);
		} catch (error) {
			// Don't silently swallow a hard-reload / direct-link load failure: surface it on
			// the store so WorkspaceMembersPanel's existing status === "error" branch renders
			// (with the create affordance) instead of a dead/blank panel. loadInternal already
			// sets status/error on a fetch failure; this is a belt-and-braces guarantee for any
			// path that rejects without having flagged the store.
			if (workspacesStore.status !== "error") {
				workspacesStore.error = error instanceof Error ? error.message : String(error);
				workspacesStore.status = "error";
			}
		}
	});
</script>

<svelte:head>
	<title>{t("workspaceMembers.pageTitle", "สมาชิก")} · {t("settingsNav.sectionsAria", "ส่วนการตั้งค่า")}</title>
</svelte:head>

<div class="members-page">
	<header class="settings-head">
		<p class="eyebrow">{t("workspaceMembers.pageEyebrow", "Workspace · การตั้งค่า")}</p>
		<h1>{t("workspaceMembers.pageTitle", "สมาชิก")}</h1>
		<p>{t("workspaceMembers.pageIntro", "เชิญทีม จัดการบทบาท และดูคำเชิญที่รอตอบรับสำหรับ workspace นี้")}</p>
	</header>
	<WorkspaceMembersPanel />
</div>

<style>
	.members-page {
		max-width: 1080px;
		margin: 0 auto;
		padding: 48px clamp(16px, 4vw, 56px) 96px;
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}
	.settings-head {
		margin-bottom: 8px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-ws-violet);
		font-size: 11px;
		margin: 0 0 6px;
	}
	.settings-head h1 {
		font-size: 32px;
		font-weight: 800;
		margin: 0 0 8px;
	}
	.settings-head p {
		color: var(--color-ws-text);
		font-size: 14px;
	}
</style>
