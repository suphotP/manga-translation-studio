<!--
	PendingInvitesPanel — the shared "pending chapter-team invites" list + accept flow.

	A pure email invite's in-app notification is unlinked at send time, so the only
	reliable way for the invited user to find + accept the chapter is this dedicated
	list of invites addressed to THEIR verified email (listMyChapterTeamInvites).
	This component owns the fetch / accept / per-invite outcome state so BOTH the
	notification bell panel and the Library home surface the same flow without
	duplicating logic — the only difference is the container chrome (`variant`).
-->
<script lang="ts">
	import { goto, invalidateAll } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { iconSvgForType } from "$lib/components/notification-icons.ts";
	import {
		listMyChapterTeamInvites,
		acceptChapterTeamInvite,
		ApiError,
		type MyChapterTeamInvite,
	} from "$lib/api/client.ts";

	// Localise via svelte-i18n with an explicit fallback ($_ returns the key
	// itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		variant = "notification",
		// When set (notification panel), reload only while the host surface is open
		// and run the host's close callback before navigating away.
		active = true,
		onBeforeNavigate,
	}: {
		variant?: "notification" | "banner";
		active?: boolean;
		onBeforeNavigate?: () => void;
	} = $props();

	type InviteOutcome = "accepted" | "alreadyAccepted" | "gone" | "failed";
	let pendingInvites = $state<MyChapterTeamInvite[]>([]);
	let acceptingProjectId = $state<string | null>(null);
	// Per-invite terminal state so we can show success/failure inline without
	// re-fetching the whole list (and keep the accepted row visible with an Open CTA).
	let inviteOutcomes = $state<Record<string, InviteOutcome>>({});

	async function loadInvites(): Promise<void> {
		try {
			const { invites } = await listMyChapterTeamInvites();
			pendingInvites = invites;
		} catch {
			// Best-effort: an invites fetch failure must never block the host surface.
			pendingInvites = [];
		}
	}

	async function handleAccept(invite: MyChapterTeamInvite): Promise<void> {
		if (acceptingProjectId) return;
		acceptingProjectId = invite.projectId;
		try {
			await acceptChapterTeamInvite(invite.projectId);
			inviteOutcomes = { ...inviteOutcomes, [invite.projectId]: "accepted" };
			// The project is now accessible — refresh any Library/dashboard data the
			// current route loaded so the newly-joined chapter appears.
			void invalidateAll();
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				// No matching pending invite (already accepted elsewhere, or revoked).
				inviteOutcomes = {
					...inviteOutcomes,
					[invite.projectId]: error.code === "chapter_team_no_pending_invite" ? "gone" : "failed",
				};
			} else {
				inviteOutcomes = { ...inviteOutcomes, [invite.projectId]: "failed" };
			}
		} finally {
			acceptingProjectId = null;
		}
	}

	function openChapter(projectId: string): void {
		onBeforeNavigate?.();
		void goto(`/projects/${encodeURIComponent(projectId)}`);
	}

	function roleLabel(role: MyChapterTeamInvite["role"]): string {
		return t(`notifications.invites.role.${role}`, role);
	}

	// Refetch whenever the host surface becomes active. For the always-on banner
	// (`active` stays true) this runs once on mount.
	$effect(() => {
		if (active) {
			inviteOutcomes = {};
			void loadInvites();
		}
	});
</script>

{#if pendingInvites.length > 0}
	<section
		class="ws-invite-section"
		class:banner={variant === "banner"}
		aria-label={t("notifications.invites.heading", "Pending invites")}
	>
		<h3>
			{t("notifications.invites.heading", "Pending invites")}
			{#if variant === "banner"}
				<small class="ws-invite-count">{pendingInvites.length}</small>
			{/if}
		</h3>
		<ul>
			{#each pendingInvites as invite (invite.projectId)}
				{@const outcome = inviteOutcomes[invite.projectId]}
				<li class="ws-invite-item">
					<span class="ws-invite-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">{@html iconSvgForType("invite_received")}</svg>
					</span>
					<span class="ws-invite-body">
						<span class="ws-invite-title">{invite.chapterLabel}</span>
						<span class="ws-invite-meta">
							<em>{t("notifications.invites.roleLabel", "as {role}").replace("{role}", roleLabel(invite.role))}</em>
							{#if invite.invitedByName}
								<small>{t("notifications.invites.invitedBy", "Invited by {name}").replace("{name}", invite.invitedByName)}</small>
							{/if}
						</span>
						{#if outcome === "accepted" || outcome === "alreadyAccepted"}
							<span class="ws-invite-status ok">
								{outcome === "accepted"
									? t("notifications.invites.accepted", "Joined — you can now open this chapter")
									: t("notifications.invites.alreadyAccepted", "You already have access")}
							</span>
						{:else if outcome === "gone"}
							<span class="ws-invite-status warn">{t("notifications.invites.gone", "This invite is no longer available")}</span>
						{:else if outcome === "failed"}
							<span class="ws-invite-status err">{t("notifications.invites.failed", "Couldn't accept the invite")}</span>
						{/if}
					</span>
					<span class="ws-invite-action">
						{#if outcome === "accepted"}
							<button type="button" class="ws-invite-open" onclick={() => openChapter(invite.projectId)}>
								{t("notifications.invites.open", "Open chapter")}
							</button>
						{:else if outcome === "gone"}
							<!-- terminal: no action -->
						{:else}
							<button
								type="button"
								class="ws-invite-accept"
								disabled={acceptingProjectId === invite.projectId}
								onclick={() => void handleAccept(invite)}
							>
								{acceptingProjectId === invite.projectId
									? t("notifications.invites.accepting", "Accepting…")
									: t("notifications.invites.accept", "Accept")}
							</button>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.ws-invite-section {
		margin: 4px 12px 10px;
		padding: 6px 0 2px;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
	}

	/* Banner variant (Library home): self-contained card, no bottom hairline. */
	.ws-invite-section.banner {
		margin: 0 0 16px;
		padding: 14px 16px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		border-radius: var(--radius-ws, 14px);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 6%, transparent);
	}

	.ws-invite-section h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-ws-accent, #7c5cff);
		padding: 6px 6px 8px;
		margin: 0;
		font-weight: 700;
	}

	.ws-invite-section.banner h3 {
		padding: 0 0 10px;
	}

	.ws-invite-count {
		min-width: 18px;
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 35%, transparent);
		color: #fff;
		font-size: 10px;
		line-height: 18px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.ws-invite-section ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ws-invite-item {
		display: grid;
		grid-template-columns: 32px 1fr auto;
		gap: 10px;
		align-items: center;
		padding: 10px 6px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, transparent);
	}

	.ws-invite-section.banner .ws-invite-item {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 5%, transparent);
		padding: 10px 12px;
	}

	.ws-invite-icon {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 9px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		color: #c4b5fd;
	}

	.ws-invite-icon svg {
		width: 15px;
		height: 15px;
		stroke-width: 1.8;
	}

	.ws-invite-body {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.ws-invite-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-ws-ink, #ececf2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ws-invite-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: var(--color-ws-faint, #6b6b78);
	}

	.ws-invite-meta em {
		font-style: normal;
		padding: 1px 7px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 20%, transparent);
		color: #c4b5fd;
	}

	.ws-invite-status {
		font-size: 11px;
		margin-top: 2px;
	}

	.ws-invite-status.ok {
		color: #86efac;
	}

	.ws-invite-status.warn {
		color: #fcd34d;
	}

	.ws-invite-status.err {
		color: #fda4af;
	}

	.ws-invite-accept,
	.ws-invite-open {
		font-size: 12px;
		font-weight: 600;
		border-radius: 8px;
		padding: 7px 12px;
		cursor: pointer;
		white-space: nowrap;
		transition: filter 0.14s ease, background 0.14s ease;
	}

	.ws-invite-accept {
		color: #fff;
		background: var(--color-ws-accent, #7c5cff);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 60%, transparent);
	}

	.ws-invite-accept:hover:not([disabled]) {
		filter: brightness(1.1);
	}

	.ws-invite-accept[disabled] {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ws-invite-open {
		color: var(--color-ws-accent, #7c5cff);
		background: transparent;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, transparent);
	}

	.ws-invite-open:hover {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
	}
</style>
