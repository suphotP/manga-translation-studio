<!--
	ChapterTeamManager — chapter-level Team/Solo selection + invite-by-email/UID +
	pick-from-contacts + editable roster. Reused in two modes:

	  - "draft":  used INSIDE the chapter-creation dialog before the project exists.
	              Mutations stay LOCAL (no API): the parent binds `mode` + `invites`
	              and sends them as `productionMode` / `initialInvites` on create.
	  - "manage": used AFTER creation (a project page / settings drawer). Mutations hit
	              the live /project/:id/team endpoints and refresh the roster.

	Violet workspace tokens (--color-ws-*) + the shared RoleBadge atom keep it on-brand.
-->
<script lang="ts">
	import { safeT } from "$lib/i18n/safeLocale";
	import RoleBadge, { type WorkRole } from "$lib/components/ui/RoleBadge.svelte";
	import * as api from "$lib/api/client.ts";
	import type { ChapterTeamInviteInput } from "$lib/api/client.ts";
	import type {
		ChapterTeamMember,
		ChapterTeamRole,
		ProductionMode,
		WorkspaceContact,
	} from "$lib/types.js";

	let {
		mode = "manage",
		projectId = undefined,
		// Two-way bound by the dialog in draft mode.
		productionMode = $bindable<ProductionMode>("solo"),
		invites = $bindable<ChapterTeamInviteInput[]>([]),
	}: {
		mode?: "draft" | "manage";
		projectId?: string;
		productionMode?: ProductionMode;
		invites?: ChapterTeamInviteInput[];
	} = $props();

	const ROLES: ChapterTeamRole[] = ["translator", "cleaner", "typesetter", "qc", "guest"];

	// Map a chapter-team role to the RoleBadge atom's vocabulary + a localized label.
	const ROLE_BADGE: Record<ChapterTeamRole, WorkRole> = {
		translator: "translate",
		cleaner: "clean",
		typesetter: "typeset",
		qc: "qc",
		guest: "review",
	};
	function roleLabel(role: ChapterTeamRole): string {
		return safeT(`chapterTeam.role.${role}`, role);
	}

	// ── Live (manage) roster state ──────────────────────────────────────────────
	let liveTeam = $state<ChapterTeamMember[]>([]);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state("");

	// ── Invite form state ───────────────────────────────────────────────────────
	let inviteBy = $state<"email" | "uid">("email");
	let inviteEmail = $state("");
	let inviteUid = $state("");
	let inviteRole = $state<ChapterTeamRole>("translator");

	// ── Contacts (friends/followers) picker ──────────────────────────────────────
	let contacts = $state<WorkspaceContact[]>([]);
	let contactsLoaded = $state(false);

	let isTeam = $derived(productionMode === "team");
	let seatSummary = $derived.by(() => {
		const members = mode === "draft" ? invites.length : liveTeam.length;
		const pending = mode === "draft"
			? invites.filter((i) => !i.userId).length
			: liveTeam.filter((m) => m.status === "pending").length;
		return { members, pending };
	});

	$effect(() => {
		if (mode === "manage" && projectId) void loadTeam();
	});

	async function loadTeam(): Promise<void> {
		if (!projectId) return;
		loading = true;
		error = "";
		try {
			const view = await api.getChapterTeam(projectId);
			liveTeam = view.team;
			productionMode = view.productionMode;
		} catch (e) {
			error = safeT("chapterTeam.loadFailed", "Could not load the chapter team.");
		} finally {
			loading = false;
		}
	}

	async function ensureContacts(): Promise<void> {
		if (contactsLoaded) return;
		try {
			const result = await api.listContacts();
			contacts = result.contacts;
		} catch {
			contacts = [];
		} finally {
			contactsLoaded = true;
		}
	}

	function contactLabel(contact: WorkspaceContact): string {
		return contact.displayName || contact.email || contact.contactUserId || "—";
	}

	async function setMode(next: ProductionMode): Promise<void> {
		if (productionMode === next) return;
		if (mode === "draft") {
			productionMode = next;
			return;
		}
		if (!projectId) return;
		busy = true;
		error = "";
		try {
			const res = await api.updateChapterTeam(projectId, { productionMode: next });
			productionMode = res.productionMode;
			liveTeam = res.team;
		} catch (e) {
			error = safeT("chapterTeam.updateFailed", "Could not update the chapter team.");
		} finally {
			busy = false;
		}
	}

	function buildInviteFromForm(): ChapterTeamInviteInput | null {
		if (inviteBy === "email") {
			const email = inviteEmail.trim();
			if (!email) return null;
			return { email, role: inviteRole };
		}
		const userId = inviteUid.trim();
		if (!userId) return null;
		return { userId, role: inviteRole };
	}

	function resetInviteForm(): void {
		inviteEmail = "";
		inviteUid = "";
	}

	async function addInvite(target?: ChapterTeamInviteInput): Promise<void> {
		const invite = target ?? buildInviteFromForm();
		if (!invite) {
			error = safeT("chapterTeam.needTarget", "Enter an email or a UID to invite.");
			return;
		}
		error = "";
		if (mode === "draft") {
			// Local dedupe by target so the same person isn't added twice in the draft.
			const dup = invites.some(
				(i) => (invite.userId && i.userId === invite.userId)
					|| (invite.email && i.email?.toLowerCase() === invite.email.toLowerCase()),
			);
			if (dup) {
				error = safeT("chapterTeam.alreadyAdded", "That person is already on the list.");
				return;
			}
			invites = [...invites, invite];
			if (productionMode === "solo") productionMode = "team";
			resetInviteForm();
			return;
		}
		if (!projectId) return;
		busy = true;
		try {
			const res = await api.inviteChapterTeamMember(projectId, invite);
			liveTeam = [...liveTeam, res.member];
			productionMode = res.productionMode;
			resetInviteForm();
		} catch (e: any) {
			error = e?.body?.error || e?.message || safeT("chapterTeam.inviteFailed", "Could not send the invite.");
		} finally {
			busy = false;
		}
	}

	async function inviteFromContact(contact: WorkspaceContact): Promise<void> {
		await addInvite({
			userId: contact.contactUserId,
			email: contact.email,
			displayName: contact.displayName,
			role: contact.suggestedRole ?? "translator",
		});
	}

	function removeDraftInvite(index: number): void {
		invites = invites.filter((_, i) => i !== index);
	}

	async function removeMember(member: ChapterTeamMember): Promise<void> {
		if (!projectId) return;
		busy = true;
		error = "";
		try {
			const res = await api.removeChapterTeamMember(projectId, member.id);
			liveTeam = liveTeam.filter((m) => m.id !== member.id);
			productionMode = res.productionMode;
		} catch (e) {
			error = safeT("chapterTeam.removeFailed", "Could not remove that member.");
		} finally {
			busy = false;
		}
	}

	async function changeRole(member: ChapterTeamMember, role: ChapterTeamRole): Promise<void> {
		if (!projectId || member.role === role) return;
		busy = true;
		error = "";
		try {
			const res = await api.updateChapterTeam(projectId, { updateMemberId: member.id, role });
			liveTeam = res.team;
		} catch (e) {
			error = safeT("chapterTeam.updateFailed", "Could not update the chapter team.");
		} finally {
			busy = false;
		}
	}

	function inviteLabel(invite: ChapterTeamInviteInput): string {
		return invite.displayName || invite.email || invite.userId || "—";
	}
</script>

<section class="chapter-team" aria-label={safeT("chapterTeam.title", "Chapter team")}>
	<div class="ct-mode" role="radiogroup" aria-label={safeT("chapterTeam.modeLabel", "Who works on this chapter?")}>
		<button
			type="button"
			class="ct-mode-card"
			class:active={!isTeam}
			role="radio"
			aria-checked={!isTeam}
			disabled={busy}
			onclick={() => setMode("solo")}
		>
			<strong>{safeT("chapterTeam.solo", "Solo")}</strong>
			<small>{safeT("chapterTeam.soloHelper", "I do every step myself")}</small>
		</button>
		<button
			type="button"
			class="ct-mode-card"
			class:active={isTeam}
			role="radio"
			aria-checked={isTeam}
			disabled={busy}
			onclick={() => setMode("team")}
		>
			<strong>{safeT("chapterTeam.team", "Team")}</strong>
			<small>{safeT("chapterTeam.teamHelper", "Split the work across the team")}</small>
		</button>
	</div>

	{#if isTeam}
		<div class="ct-panel">
			<div class="ct-invite">
				<div class="ct-invite-by" role="radiogroup" aria-label={safeT("chapterTeam.inviteBy", "Invite by")}>
					<button type="button" class:active={inviteBy === "email"} role="radio" aria-checked={inviteBy === "email"} onclick={() => (inviteBy = "email")}>
						{safeT("chapterTeam.byEmail", "Email")}
					</button>
					<button type="button" class:active={inviteBy === "uid"} role="radio" aria-checked={inviteBy === "uid"} onclick={() => (inviteBy = "uid")}>
						{safeT("chapterTeam.byUid", "UID")}
					</button>
				</div>
				<div class="ct-invite-row">
					{#if inviteBy === "email"}
						<input
							type="email"
							class="ct-input"
							placeholder={safeT("chapterTeam.emailPlaceholder", "name@example.com")}
							bind:value={inviteEmail}
							aria-label={safeT("chapterTeam.byEmail", "Email")}
						/>
					{:else}
						<input
							type="text"
							class="ct-input"
							placeholder={safeT("chapterTeam.uidPlaceholder", "User ID (UID)")}
							bind:value={inviteUid}
							aria-label={safeT("chapterTeam.byUid", "UID")}
						/>
					{/if}
					<select class="ct-input ct-role" bind:value={inviteRole} aria-label={safeT("chapterTeam.role.title", "Role")}>
						{#each ROLES as role (role)}
							<option value={role}>{roleLabel(role)}</option>
						{/each}
					</select>
					<button type="button" class="ct-add" disabled={busy} onclick={() => addInvite()}>
						{safeT("chapterTeam.add", "Add")}
					</button>
				</div>
				<button type="button" class="ct-contacts-toggle" onclick={ensureContacts}>
					{safeT("chapterTeam.fromContacts", "Friends / followers")}
				</button>
				{#if contactsLoaded}
					{#if contacts.length === 0}
						<p class="ct-empty">{safeT("chapterTeam.noContacts", "No saved contacts yet.")}</p>
					{:else}
						<ul class="ct-contact-list">
							{#each contacts as contact (contact.id)}
								<li>
									<span class="ct-contact-name">{contactLabel(contact)}</span>
									<button type="button" class="ct-contact-add" disabled={busy} onclick={() => inviteFromContact(contact)}>
										{safeT("chapterTeam.invite", "Invite")}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</div>

			{#if error}
				<p class="ct-error" role="alert">{error}</p>
			{/if}

			<div class="ct-roster" aria-live="polite">
				{#if mode === "manage" && loading}
					<p class="ct-empty">{safeT("chapterTeam.loading", "Loading team…")}</p>
				{:else if mode === "draft"}
					{#if invites.length === 0}
						<p class="ct-empty">{safeT("chapterTeam.noInvitesYet", "No invites yet — add people above.")}</p>
					{:else}
						<ul class="ct-member-list">
							{#each invites as invite, index (invite.userId ?? invite.email ?? index)}
								<li class="ct-member">
									<span class="ct-member-name">{inviteLabel(invite)}</span>
									<RoleBadge role={ROLE_BADGE[invite.role]} state={invite.userId ? "active" : "todo"} />
									<span class="ct-pending">{invite.userId ? safeT("chapterTeam.statusInvite", "will invite") : safeT("chapterTeam.statusEmail", "email invite")}</span>
									<button type="button" class="ct-remove" aria-label={safeT("chapterTeam.remove", "Remove")} onclick={() => removeDraftInvite(index)}>×</button>
								</li>
							{/each}
						</ul>
					{/if}
				{:else if liveTeam.length === 0}
					<p class="ct-empty">{safeT("chapterTeam.noMembers", "Only you on this chapter so far.")}</p>
				{:else}
					<ul class="ct-member-list">
						{#each liveTeam as member (member.id)}
							<li class="ct-member">
								<span class="ct-member-name">{member.displayName || member.email || member.userId}</span>
								<select
									class="ct-input ct-role-inline"
									value={member.role}
									disabled={busy}
									aria-label={safeT("chapterTeam.role.title", "Role")}
									onchange={(e) => changeRole(member, (e.currentTarget as HTMLSelectElement).value as ChapterTeamRole)}
								>
									{#each ROLES as role (role)}
										<option value={role}>{roleLabel(role)}</option>
									{/each}
								</select>
								{#if member.status === "pending"}
									<span class="ct-pending">{safeT("chapterTeam.pending", "pending")}</span>
								{/if}
								<button type="button" class="ct-remove" disabled={busy} aria-label={safeT("chapterTeam.remove", "Remove")} onclick={() => removeMember(member)}>×</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<p class="ct-summary">
				{safeT("chapterTeam.seatSummary", "{members} people · {pending} pending invite")
					.replace("{members}", String(seatSummary.members))
					.replace("{pending}", String(seatSummary.pending))}
			</p>
		</div>
	{/if}
</section>

<style>
	.chapter-team {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ct-mode {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.ct-mode-card {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.65rem 0.75rem;
		border-radius: 0.6rem;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 22%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 5%, transparent);
		text-align: left;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.ct-mode-card.active {
		border-color: var(--color-ws-accent, #7c5cff);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 14%, transparent);
	}
	.ct-mode-card strong { font-size: 0.9rem; }
	.ct-mode-card small { font-size: 0.72rem; opacity: 0.75; }
	.ct-panel {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.65rem;
		border-radius: 0.6rem;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
	}
	.ct-invite-by { display: inline-flex; gap: 0.25rem; }
	.ct-invite-by button {
		font-size: 0.72rem;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 20%, transparent);
		background: transparent;
		cursor: pointer;
	}
	.ct-invite-by button.active {
		background: var(--color-ws-accent, #7c5cff);
		color: #fff;
		border-color: var(--color-ws-accent, #7c5cff);
	}
	.ct-invite-row { display: flex; gap: 0.4rem; margin-top: 0.4rem; flex-wrap: wrap; }
	.ct-input {
		padding: 0.4rem 0.55rem;
		border-radius: 0.45rem;
		border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		background: transparent;
		color: inherit;
		font-size: 0.82rem;
	}
	.ct-invite-row .ct-input:first-of-type { flex: 1 1 12rem; }
	.ct-role { flex: 0 0 8rem; }
	.ct-add, .ct-contact-add, .ct-remove {
		border: none;
		border-radius: 0.45rem;
		background: var(--color-ws-accent, #7c5cff);
		color: #fff;
		padding: 0.4rem 0.7rem;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.ct-add:disabled, .ct-remove:disabled, .ct-contact-add:disabled { opacity: 0.5; cursor: default; }
	.ct-contacts-toggle {
		margin-top: 0.45rem;
		font-size: 0.74rem;
		background: none;
		border: none;
		color: var(--color-ws-accent, #7c5cff);
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.ct-contact-list, .ct-member-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
	.ct-contact-list li, .ct-member {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.45rem;
		border-radius: 0.45rem;
		background: color-mix(in srgb, currentColor 4%, transparent);
	}
	.ct-member-name, .ct-contact-name { flex: 1 1 auto; font-size: 0.82rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ct-role-inline { flex: 0 0 7rem; }
	.ct-remove { background: color-mix(in srgb, #ef4444 80%, transparent); padding: 0.15rem 0.5rem; line-height: 1; font-size: 1rem; }
	.ct-pending, .ct-empty, .ct-summary { font-size: 0.72rem; opacity: 0.7; }
	.ct-summary { margin: 0.2rem 0 0; }
	.ct-error { color: #ef4444; font-size: 0.76rem; margin: 0; }
</style>
