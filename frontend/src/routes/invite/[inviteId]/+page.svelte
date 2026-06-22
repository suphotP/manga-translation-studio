<!--
  /invite/[inviteId]?token=… — recipient-facing accept page for the one-time invite link
  copied from Workspace settings. The backend stores only a hash of the token and returns
  the raw token exactly once, so the link is the only way to deliver an acceptable invite
  while there is no mailer. This page reads the token from the query string, requires the
  recipient to be signed in (acceptInvite is an authed endpoint), accepts the invite, then
  drops them into the joined workspace.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { _ } from "$lib/i18n";
	import * as api from "$lib/api/client.ts";
	import { ApiError } from "$lib/api/client.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import AuthAccountMenu from "$lib/components/AuthAccountMenu.svelte";

	type AcceptStatus = "checking" | "need_auth" | "accepting" | "accepted" | "error";

	let inviteId = $derived(page.params.inviteId ?? "");
	let token = $derived(page.url.searchParams.get("token") ?? "");
	let status = $state<AcceptStatus>("checking");
	let errorMessage = $state<string | null>(null);
	let joinedWorkspaceId = $state<string | null>(null);
	// One-shot guard: the reactive accept attempt fires once auth resolves; this keeps a
	// re-render (or auth refresh) from issuing a duplicate accept for the same link.
	let attempted = false;

	onMount(() => {
		void authStore.init().catch(() => undefined);
	});

	async function acceptNow(): Promise<void> {
		if (attempted) return;
		if (!inviteId || !token) {
			status = "error";
			errorMessage = $_("invitePage.errorIncompleteLink");
			return;
		}
		attempted = true;
		status = "accepting";
		errorMessage = null;
		try {
			const { member } = await api.acceptInvite(inviteId, token);
			joinedWorkspaceId = member.workspaceId;
			status = "accepted";
			// Force a fresh /workspaces fetch (not syncWithAuth, which would short-circuit
			// for this already-loaded account) so the newly joined workspace is actually
			// pulled in, THEN switch to it — otherwise switchTo writes an id absent from the
			// list and currentWorkspace falls back to a stale/empty selection.
			await workspacesStore.refresh().catch(() => undefined);
			await workspacesStore.switchTo(member.workspaceId).catch(() => undefined);
		} catch (error) {
			status = "error";
			if (error instanceof ApiError) {
				errorMessage = error.message;
			} else if (error instanceof Error) {
				errorMessage = error.message;
			} else {
				errorMessage = $_("invitePage.errorAcceptRetry");
			}
		}
	}

	// Drive the accept flow from the auth state. While auth is still restoring a stored
	// session we wait; once authenticated we auto-accept; if anonymous we ask the recipient
	// to sign in first (and accept automatically once they do).
	$effect(() => {
		const authStatus = authStore.status;
		if (status === "accepting" || status === "accepted") return;
		if (authStatus === "checking") {
			status = "checking";
			return;
		}
		if (authStore.isAuthenticated) {
			void acceptNow();
		} else if (status !== "error") {
			status = "need_auth";
		}
	});

	function retry(): void {
		attempted = false;
		errorMessage = null;
		if (authStore.isAuthenticated) void acceptNow();
		else status = "need_auth";
	}

	function goToWorkspace(): void {
		void goto("/dashboard");
	}
</script>

<svelte:head>
	<title>{$_("invitePage.docTitle")}</title>
</svelte:head>

<main class="invite-accept" aria-label={$_("invitePage.ariaLabel")}>
	<section class="invite-card">
		<p class="invite-eyebrow">Workspace invite</p>
		<h1>{$_("invitePage.heading")}</h1>

		{#if status === "checking"}
			<p class="invite-body">{$_("invitePage.checking")}</p>
		{:else if status === "need_auth"}
			<p class="invite-body">
				{$_("invitePage.needAuth")}
			</p>
			<div class="invite-auth">
				<AuthAccountMenu />
			</div>
		{:else if status === "accepting"}
			<p class="invite-body">{$_("invitePage.accepting")}</p>
		{:else if status === "accepted"}
			<p class="invite-body invite-ok">{$_("invitePage.accepted")}</p>
			<button type="button" class="invite-action" onclick={goToWorkspace}>{$_("invitePage.goToWorkspace")}</button>
		{:else if status === "error"}
			<p class="invite-body invite-error">{errorMessage ?? $_("invitePage.errorGeneric")}</p>
			<div class="invite-actions">
				{#if authStore.isAuthenticated}
					<button type="button" class="invite-action" onclick={retry}>{$_("invitePage.retry")}</button>
				{:else}
					<div class="invite-auth"><AuthAccountMenu /></div>
				{/if}
				<button type="button" class="invite-action ghost" onclick={goToWorkspace}>{$_("invitePage.goHome")}</button>
			</div>
		{/if}
	</section>
</main>

<style>
	.invite-accept {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px;
		background: var(--color-ws-bg, #0b0f16);
		color: var(--color-ws-text, #b8c1d6);
	}

	.invite-card {
		width: min(460px, 100%);
		display: grid;
		gap: 12px;
		padding: clamp(20px, 4vw, 34px);
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 14%, transparent);
		border-radius: 12px;
		background: var(--color-ws-surface, #15151D);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
	}

	.invite-eyebrow {
		margin: 0;
		color: var(--color-ws-accent, #8fb8ff);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		color: var(--color-ws-ink, #fbf7ff);
		font-size: clamp(22px, 3vw, 30px);
		line-height: 1.1;
	}

	.invite-body {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
	}

	.invite-ok {
		color: var(--color-ws-accent, #7c5cff);
		font-weight: 800;
	}

	.invite-error {
		color: var(--color-ws-rose, #ff6b99);
		font-weight: 700;
	}

	.invite-auth {
		display: flex;
		justify-content: flex-start;
	}

	.invite-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.invite-action {
		min-height: 40px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 16px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
		color: var(--color-ws-accent, #7c5cff);
		font-size: 12px;
		font-weight: 900;
		cursor: pointer;
	}

	.invite-action.ghost {
		border-color: color-mix(in srgb, var(--color-ws-line, #a6b7dc) 14%, transparent);
		background: rgba(255, 255, 255, 0.045);
		color: var(--color-ws-ink, #fbf7ff);
	}
</style>
