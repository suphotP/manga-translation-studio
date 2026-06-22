<!--
  /account/restore?user=…&token=… — email-link restore page for a soft-deleted
  account. The DELETE /api/account flow emails (or surfaces) a restore link of this
  exact shape; the backend's POST /api/account/restore is public for this case and
  verifies the signed HMAC token, so a LOGGED-OUT user can undo their deletion
  within the grace window straight from the link. Without this page the link 404s.

  If the link is opened without a token (or it's invalid) we still let the user fall
  back to the in-app restore in Settings → Privacy & Data while signed in.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import * as api from "$lib/api/client.ts";
	import { ApiError } from "$lib/api/client.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { _ } from "$lib/i18n";

	// Localise via svelte-i18n with an explicit English fallback ($_ returns the key
	// itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	type RestoreStatus = "checking" | "restoring" | "restored" | "error";

	let userId = $derived(page.url.searchParams.get("user") ?? "");
	let token = $derived(page.url.searchParams.get("token") ?? "");
	let status = $state<RestoreStatus>("checking");
	let errorMessage = $state<string | null>(null);
	// One-shot guard so a re-render / auth refresh can't fire a duplicate restore.
	let attempted = false;

	onMount(() => {
		void authStore.init().catch(() => undefined);
		void restoreNow();
	});

	async function restoreNow(): Promise<void> {
		if (attempted) return;
		if (!userId || !token) {
			status = "error";
			errorMessage = t(
				"restore.missingLink",
				"This restore link is incomplete — it's missing the user or token.",
			);
			return;
		}
		attempted = true;
		status = "restoring";
		errorMessage = null;
		try {
			const { ok } = await api.restoreAccountWithToken(userId, token);
			if (ok) {
				status = "restored";
			} else {
				status = "error";
				errorMessage = t(
					"restore.expired",
					"This account could not be restored — the grace window may have passed. Please contact support.",
				);
			}
		} catch (error) {
			status = "error";
			if (error instanceof ApiError) {
				errorMessage = error.message;
			} else if (error instanceof Error) {
				errorMessage = error.message;
			} else {
				errorMessage = t("restore.failed", "Restore failed. Please try again.");
			}
		}
	}

	function retry(): void {
		attempted = false;
		errorMessage = null;
		void restoreNow();
	}

	function goToSignIn(): void {
		void goto("/login");
	}

	function goToPrivacy(): void {
		void goto("/settings/privacy");
	}
</script>

<svelte:head>
	<title>{t("restore.pageTitle", "Restore my account")} - Comic Workspace</title>
</svelte:head>

<main class="restore-account" aria-label={t("restore.pageTitle", "Restore my account")}>
	<section class="restore-card">
		<p class="restore-eyebrow">{t("restore.eyebrow", "Account recovery")}</p>
		<h1>{t("restore.heading", "Restore my account")}</h1>

		{#if status === "checking" || status === "restoring"}
			<p class="restore-body">{t("restore.inProgress", "Restoring your account…")}</p>
		{:else if status === "restored"}
			<p class="restore-body restore-ok">
				{t("restore.success", "Your account has been restored. You can sign in again.")}
			</p>
			<button type="button" class="restore-action" onclick={goToSignIn}>
				{t("restore.signIn", "Go to sign in")}
			</button>
		{:else if status === "error"}
			<p class="restore-body restore-error">
				{errorMessage ?? t("restore.failed", "Restore failed. Please try again.")}
			</p>
			<div class="restore-actions">
				<button type="button" class="restore-action" onclick={retry}>
					{t("restore.retry", "Try again")}
				</button>
				<button type="button" class="restore-action ghost" onclick={goToPrivacy}>
					{t("restore.openSettings", "Open Privacy & Data settings")}
				</button>
			</div>
		{/if}
	</section>
</main>

<style>
	.restore-account {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px;
		background: var(--color-ws-bg, #0b0f16);
		color: var(--color-ws-text, #b8c1d6);
	}

	.restore-card {
		width: min(440px, 100%);
		background: var(--color-ws-surface, #131a26);
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: 16px;
		padding: 32px;
		text-align: center;
	}

	.restore-eyebrow {
		margin: 0 0 8px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ws-faint, #8A8A98);
	}

	.restore-card h1 {
		margin: 0 0 16px;
		font-size: 22px;
		color: var(--color-ws-ink, #ECECF2);
	}

	.restore-body {
		margin: 0 0 20px;
		line-height: 1.5;
	}

	.restore-ok {
		color: var(--color-ws-green, #34D399);
	}

	.restore-error {
		color: var(--color-ws-rose, #FB7185);
	}

	.restore-actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.restore-action {
		appearance: none;
		border: 1px solid var(--color-ws-accent, #3b82f6);
		background: var(--color-ws-accent, #3b82f6);
		color: #fff;
		border-radius: 10px;
		padding: 10px 16px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}

	.restore-action.ghost {
		background: transparent;
		color: var(--color-ws-text, #b8c1d6);
		border-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
	}
</style>
