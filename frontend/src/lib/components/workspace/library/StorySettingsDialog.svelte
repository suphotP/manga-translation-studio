<!-- StorySettingsDialog — "ตั้งค่าเรื่อง" modal for the selected story.
	Real story-level settings: edit the story TITLE (persisted across all of the
	story's chapter projects via onRename; the stable storyId is preserved server
	side), manage SERIES-LEVEL DUTY ASSIGNMENTS (a member holds a recurring duty
	on every chapter of the story incl. future ones; chapter-team roles override
	on conflict — the dialog owns these API calls itself since they are
	self-contained reads/writes keyed on workspaceId+storyId), and permanently
	DELETE the story (type-to-confirm, irreversible, via onDelete). Workflow rows
	stay honest read-only placeholders. The caller owns `open`, the rename/delete
	API calls, and the post-action refresh/navigation. -->
<script lang="ts">
	import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";
	import { _ } from "$lib/i18n";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import {
		createInvite,
		listStoryAssignments,
		removeStoryAssignment,
		upsertStoryAssignments,
		type StoryAssignmentCandidate,
		type StoryAssignmentRole,
		type StoryRoleAssignment,
		type WorkspaceApiRole,
	} from "$lib/api/client";
	import { canUseBackendProjectEndpoints } from "$lib/stores/project.svelte.ts";

	const ASSIGNMENT_ROLES: readonly StoryAssignmentRole[] = ["translator", "cleaner", "typesetter", "qc"];

	let {
		open,
		title,
		selfDisplayName,
		workspaceName = "",
		workspaceId = null,
		deadlineLabel,
		canManage,
		onRename,
		onDelete,
		onClose,
	}: {
		open: boolean;
		title: WorkspaceProjectBrowserGroup;
		selfDisplayName: string;
		workspaceName?: string;
		/** Workspace context for the series-duty assignment API. Null hides the section. */
		workspaceId?: string | null;
		deadlineLabel: string;
		/** Whether the current user may rename/delete this story. */
		canManage: boolean;
		/** Persist a new story title across the story's chapter projects. Rejects on failure. */
		onRename: (nextTitle: string) => Promise<void>;
		/** Permanently delete the story (all its chapter projects). Rejects on failure. */
		onDelete: () => Promise<void>;
		onClose: () => void;
	} = $props();

	// ── Title edit state ───────────────────────────────────────────
	let titleDraft = $state("");
	let savingTitle = $state(false);
	let titleError = $state<string | null>(null);
	let titleSaved = $state(false);
	let titleSavedTimer: ReturnType<typeof setTimeout> | null = null;

	// Re-seed all form state on a FRESH open or when the dialog is reused for a
	// DIFFERENT story (storyId changes), so a previous edit/error/confirm never
	// leaks across. A successful rename mutates `title.title` (same story) — that
	// must NOT clobber the in-progress draft or the "saved" confirmation, so we key
	// the reset on the stable storyId, not the title text.
	let lastInitKey = $state<string | null>(null);
	$effect(() => {
		if (!open) {
			lastInitKey = null;
			return;
		}
		const key = title.storyId || title.id;
		if (lastInitKey === key) return;
		lastInitKey = key;
		titleDraft = title.title;
		titleError = null;
		titleSaved = false;
		deleteConfirmText = "";
		deleteError = null;
		deletingStory = false;
		confirmingDelete = false;
		assignments = [];
		candidates = [];
		canAssignDuties = false;
		assignmentsError = null;
		assignReceipt = null;
		assignDraftUserId = "";
		assignDraftRole = "translator";
		assignBusy = false;
		inviteEmail = "";
		inviteRole = "editor";
		inviteChapterScope = "all";
		inviteBusy = false;
		inviteError = null;
		inviteLink = null;
		void loadAssignments(key);
	});

	// ── Scoped invite (เชิญผู้ช่วยเฉพาะตอน/เรื่องนี้) ─────────────────
	// Invite a helper LIMITED to this story (or one chapter), so their whole
	// library / sidebar / inbox shows only that scope. Reuses the workspace
	// invite API with a projectIds scope; gated on the same manage rights as duties.
	let inviteEmail = $state("");
	let inviteRole = $state<Exclude<WorkspaceApiRole, "owner">>("editor");
	// "all" = every chapter of the story; otherwise a single chapter's projectId.
	let inviteChapterScope = $state<string>("all");
	let inviteBusy = $state(false);
	let inviteError = $state<string | null>(null);
	let inviteLink = $state<string | null>(null);

	// Backend-addressable chapters of this story (local-only projects can't be scoped).
	let invitableChapters = $derived(
		title.chapters.filter((chapter) => canUseBackendProjectEndpoints(chapter.project.projectId)),
	);
	let storyProjectIds = $derived(invitableChapters.map((chapter) => chapter.project.projectId));

	async function sendScopedInvite(): Promise<void> {
		const email = inviteEmail.trim();
		if (!workspaceId || !email || inviteBusy) return;
		// Guard a stale single-chapter selection (the chapter may have been removed
		// while the dialog stayed open) so we never mint a dangling invite.
		if (inviteChapterScope !== "all" && !storyProjectIds.includes(inviteChapterScope)) {
			inviteChapterScope = "all";
			inviteError = $_("storySettings.inviteNoChapters");
			return;
		}
		const projectIds = inviteChapterScope === "all" ? storyProjectIds : [inviteChapterScope];
		if (projectIds.length === 0) {
			inviteError = $_("storySettings.inviteNoChapters");
			return;
		}
		inviteBusy = true;
		inviteError = null;
		inviteLink = null;
		try {
			const { invite } = await createInvite(workspaceId, {
				email,
				role: inviteRole,
				scope: { projectIds },
			});
			if (invite.inviteToken && typeof window !== "undefined") {
				inviteLink = `${window.location.origin}/invite/${encodeURIComponent(invite.inviteId)}?token=${encodeURIComponent(invite.inviteToken)}`;
			}
			inviteEmail = "";
		} catch (error) {
			inviteError = error instanceof Error ? error.message : $_("storySettings.inviteFailed");
		} finally {
			inviteBusy = false;
		}
	}

	async function copyInviteLink(): Promise<void> {
		if (!inviteLink || typeof navigator === "undefined" || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(inviteLink);
		} catch {
			/* best-effort: the readonly input is selectable as a fallback */
		}
	}

	// ── Series-duty assignments ────────────────────────────────────
	let assignments = $state<StoryRoleAssignment[]>([]);
	let candidates = $state<StoryAssignmentCandidate[]>([]);
	// Duty mutation rights are SERVER-driven: the GET returns `candidates` only
	// when the caller passes the same manage_members + workspace-wide-scope gate
	// the PUT/DELETE enforce. The `canManage` prop (story rename/delete rights)
	// is a DIFFERENT permission and must not unlock duty controls — an editor
	// who can rename stories would otherwise get dropdowns that always 403.
	let canAssignDuties = $state(false);
	let assignmentsStatus = $state<"idle" | "loading" | "ready" | "error">("idle");
	let assignmentsError = $state<string | null>(null);
	let assignReceipt = $state<string | null>(null);
	let assignDraftUserId = $state("");
	let assignDraftRole = $state<StoryAssignmentRole>("translator");
	let assignBusy = $state(false);

	// The storyId the duty API is keyed on. Chapters minted before story ids
	// existed group under a synthetic id — those still resolve (the group id IS
	// the storyId the projects carry).
	let assignmentStoryId = $derived(title.storyId || title.id);

	function candidateLabel(candidate: StoryAssignmentCandidate): string {
		return candidate.name?.trim() || candidate.email?.trim() || candidate.userId;
	}

	function assignmentScopeLabel(): string {
		return $_("storySettings.assignScopeAllChapters", { values: { count: chapterCountLabel } });
	}

	// Members not yet assigned on this story — what the "add" picker offers.
	let unassignedCandidates = $derived(
		candidates.filter((candidate) => !assignments.some((entry) => entry.userId === candidate.userId)),
	);

	// Multi-duty: one member can hold SEVERAL roles on a story, so the roster is
	// grouped by member with a chip per held duty. `assignments` is the flat row
	// list (one row per held duty); this collapses it per member, preserving the
	// grafted display fields from whichever row carries them.
	interface DutyRosterEntry {
		userId: string;
		displayName: string;
		email?: string;
		roles: Set<StoryAssignmentRole>;
	}
	let dutyRoster = $derived.by<DutyRosterEntry[]>(() => {
		const byUser = new Map<string, DutyRosterEntry>();
		for (const entry of assignments) {
			let group = byUser.get(entry.userId);
			if (!group) {
				group = { userId: entry.userId, displayName: assignmentDisplayName(entry), email: entry.email, roles: new Set() };
				byUser.set(entry.userId, group);
			}
			group.roles.add(entry.role);
			if (entry.displayName?.trim()) group.displayName = entry.displayName.trim();
			if (entry.email?.trim()) group.email = entry.email.trim();
		}
		return [...byUser.values()];
	});

	async function loadAssignments(initKey: string): Promise<void> {
		if (!workspaceId) return;
		assignmentsStatus = "loading";
		assignmentsError = null;
		try {
			const result = await listStoryAssignments(workspaceId, assignmentStoryId);
			// A slow response for a PREVIOUS story must not clobber the current one.
			if (lastInitKey !== initKey) return;
			assignments = result.assignments;
			candidates = result.candidates ?? [];
			canAssignDuties = result.candidates !== undefined;
			assignmentsStatus = "ready";
		} catch {
			if (lastInitKey !== initKey) return;
			assignmentsStatus = "error";
			assignmentsError = $_("storySettings.assignLoadFailed");
		}
	}

	async function addAssignment(): Promise<void> {
		if (!workspaceId || !assignDraftUserId || assignBusy) return;
		assignBusy = true;
		assignmentsError = null;
		assignReceipt = null;
		try {
			const { assignments: savedAssignments } = await upsertStoryAssignments(workspaceId, {
				storyIds: [assignmentStoryId],
				userId: assignDraftUserId,
				role: assignDraftRole,
				storyTitle: title.title,
			});
			const assignment = savedAssignments[0];
			if (!assignment) throw new Error($_("storySettings.assignSaveFailed"));
			// The PUT response is the bare record — graft the picked candidate's
			// display fields so the roster never falls back to the raw userId.
			const picked = candidates.find((candidate) => candidate.userId === assignment.userId);
			const displayed = { ...assignment, displayName: picked?.name ?? undefined, email: picked?.email ?? undefined };
			assignments = [displayed, ...assignments.filter((entry) => entry.userId !== assignment.userId)];
			assignDraftUserId = "";
			assignReceipt = $_("storySettings.assignSavedAllChapters", { values: { count: chapterCountLabel } });
		} catch (error) {
			assignmentsError = error instanceof Error ? error.message : $_("storySettings.assignSaveFailed");
		} finally {
			assignBusy = false;
		}
	}

	// Toggle one duty for a member: add it (upsert) if absent, remove it if held.
	// A member can hold several duties at once (multi-duty).
	async function toggleDuty(member: DutyRosterEntry, role: StoryAssignmentRole): Promise<void> {
		if (!workspaceId || assignBusy) return;
		assignBusy = true;
		assignmentsError = null;
		assignReceipt = null;
		const has = member.roles.has(role);
		try {
			if (has) {
				await removeStoryAssignment(workspaceId, assignmentStoryId, member.userId, role);
				assignments = assignments.filter((existing) => !(existing.userId === member.userId && existing.role === role));
				assignReceipt = $_("storySettings.assignUpdatedAllChapters", { values: { count: chapterCountLabel } });
			} else {
				const { assignments: savedAssignments } = await upsertStoryAssignments(workspaceId, {
					storyIds: [assignmentStoryId],
					userId: member.userId,
					role,
					storyTitle: title.title,
				});
				const assignment = savedAssignments[0];
				if (!assignment) throw new Error($_("storySettings.assignSaveFailed"));
				const displayed = { ...assignment, displayName: member.displayName, email: member.email };
				assignments = [...assignments.filter((existing) => !(existing.userId === member.userId && existing.role === role)), displayed];
				assignReceipt = $_("storySettings.assignUpdatedAllChapters", { values: { count: chapterCountLabel } });
			}
		} catch (error) {
			assignmentsError = error instanceof Error ? error.message : $_("storySettings.assignSaveFailed");
		} finally {
			assignBusy = false;
		}
	}

	// Remove ALL of a member's duties on this story (the row's × button).
	async function removeMemberDuties(member: DutyRosterEntry): Promise<void> {
		if (!workspaceId || assignBusy) return;
		assignBusy = true;
		assignmentsError = null;
		assignReceipt = null;
		try {
			await removeStoryAssignment(workspaceId, assignmentStoryId, member.userId);
			assignments = assignments.filter((existing) => existing.userId !== member.userId);
			assignReceipt = $_("storySettings.assignRemovedAllChapters", { values: { count: chapterCountLabel } });
		} catch (error) {
			assignmentsError = error instanceof Error ? error.message : $_("storySettings.assignSaveFailed");
		} finally {
			assignBusy = false;
		}
	}

	function assignmentDisplayName(entry: StoryRoleAssignment): string {
		return entry.displayName?.trim() || entry.email?.trim() || entry.userId;
	}

	let trimmedTitleDraft = $derived(titleDraft.trim());
	let titleChanged = $derived(trimmedTitleDraft.length > 0 && trimmedTitleDraft !== title.title);
	let canSaveTitle = $derived(canManage && titleChanged && !savingTitle);
	let chapterCountLabel = $derived($_("storySettings.chapterCount", { values: { n: title.chapterCount } }));

	async function saveTitle(): Promise<void> {
		if (!canSaveTitle) return;
		savingTitle = true;
		titleError = null;
		titleSaved = false;
		try {
			await onRename(trimmedTitleDraft);
			titleSaved = true;
			if (titleSavedTimer) clearTimeout(titleSavedTimer);
			titleSavedTimer = setTimeout(() => (titleSaved = false), 2600);
		} catch (error) {
			titleError = error instanceof Error ? error.message : $_("storySettings.renameFailed");
		} finally {
			savingTitle = false;
		}
	}

	function onTitleKeydown(event: KeyboardEvent): void {
		if (event.key === "Enter") {
			event.preventDefault();
			void saveTitle();
		}
	}

	// ── Delete state ───────────────────────────────────────────────
	let confirmingDelete = $state(false);
	let deleteConfirmText = $state("");
	let deletingStory = $state(false);
	let deleteError = $state<string | null>(null);

	// Hard type-to-confirm: the user must type the exact story title to enable
	// the irreversible delete. This naming makes clear WHAT is being destroyed.
	let deleteConfirmed = $derived(deleteConfirmText.trim() === title.title.trim());
	let canDelete = $derived(canManage && deleteConfirmed && !deletingStory);

	function startDeleteConfirm(): void {
		if (!canManage) return;
		confirmingDelete = true;
		deleteConfirmText = "";
		deleteError = null;
	}

	function cancelDeleteConfirm(): void {
		confirmingDelete = false;
		deleteConfirmText = "";
		deleteError = null;
	}

	async function confirmDelete(): Promise<void> {
		if (!canDelete) return;
		deletingStory = true;
		deleteError = null;
		try {
			await onDelete();
			// Parent closes/navigates on success; nothing more to do here.
		} catch (error) {
			deleteError = error instanceof Error ? error.message : $_("storySettings.deleteFailed");
			deletingStory = false;
		}
	}
</script>

{#if open}
	<div class="story-settings-layer fixed inset-0 z-[80] grid place-items-center p-6 max-[760px]:place-items-end max-[760px]:p-3" role="presentation">
		<button
			type="button"
			class="story-settings-backdrop absolute inset-0 cursor-default border-0 bg-ws-bg/75 backdrop-blur-lg"
			aria-label={$_("storySettings.closeBackdropAria")}
			onclick={onClose}
		></button>
		<div
			class="story-settings-dialog ws-panel relative z-[1] grid max-h-[min(760px,calc(100vh-48px))] w-[min(980px,100%)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-ws max-[760px]:max-h-[calc(100vh-24px)]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="story-settings-title"
			tabindex="-1"
			use:dialogFocus={{ onEscape: onClose, busy: savingTitle || deletingStory }}
		>
			<header class="flex items-center justify-between gap-4 border-b border-ws-line/12 p-5">
				<div>
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storySettings.eyebrow")}</span>
					<h2 id="story-settings-title" class="mt-1 text-2xl font-black leading-tight text-ws-ink">{title.title}</h2>
					<p class="mt-1.5 text-xs font-semibold text-ws-text/70">{$_("storySettings.subtitle")}</p>
				</div>
				<button type="button" class="ws-btn-ghost inline-flex h-10 w-10 items-center justify-center rounded-ws-ctrl text-ws-text" aria-label={$_("storySettings.closeButtonAria")} onclick={onClose}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-[18px] w-[18px] [stroke-width:2.4]" aria-hidden="true">
						<path d="M6 6l12 12M18 6 6 18"/>
					</svg>
				</button>
			</header>
			<!-- Keep rows content-sized so dense story metadata scrolls instead of clipping into the next card. -->
			<div class="story-settings-grid grid min-h-0 auto-rows-max grid-cols-1 items-start gap-3 overflow-x-hidden overflow-y-auto p-5 min-[1120px]:grid-cols-2">
				<article class="grid min-h-0 min-w-0 content-start gap-3 rounded-ws-card border border-ws-line/12 bg-ws-surface2/40 p-4">
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storySettings.storyInfo")}</span>
					<label class="grid gap-1.5 text-xs font-semibold leading-snug text-ws-text/80">
						{$_("storySettings.titleLabel")}
						<input
							type="text"
							bind:value={titleDraft}
							onkeydown={onTitleKeydown}
							readonly={!canManage}
							maxlength="200"
							aria-label={$_("storySettings.titleLabel")}
							class="min-h-10 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-3 text-xs text-ws-ink focus:border-ws-accent focus:outline-none read-only:opacity-70"
						/>
					</label>
					{#if canManage}
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								disabled={!canSaveTitle}
								onclick={saveTitle}
								class="ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3 text-[11px] font-black text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
							>
								{savingTitle ? $_("storySettings.saving") : $_("storySettings.saveTitle")}
							</button>
							{#if titleChanged && !savingTitle}
								<button
									type="button"
									onclick={() => { titleDraft = title.title; titleError = null; }}
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text"
								>
									{$_("storySettings.cancel")}
								</button>
							{/if}
							{#if titleSaved}
								<span class="text-[11px] font-bold text-ws-green" role="status">{$_("storySettings.savedAppliesAll", { values: { count: chapterCountLabel } })}</span>
							{/if}
						</div>
						{#if titleError}
							<p class="text-[11px] font-semibold text-ws-rose" role="alert">{titleError}</p>
						{:else}
							<p class="text-[10px] font-semibold text-ws-text/55">{$_("storySettings.renameHint")}</p>
						{/if}
					{:else}
						<p class="text-[10px] font-semibold text-ws-text/55">{$_("storySettings.noRenamePermission")}</p>
					{/if}
					<label class="grid gap-1.5 text-xs font-semibold leading-snug text-ws-text/80">
						{$_("storySettings.languageLabel")}
					<input type="text" value={title.targetLangs.map((lang) => lang.toUpperCase()).join(", ") || $_("storySettings.notSet")} readonly class="min-h-10 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-3 text-xs text-ws-ink opacity-70" />
					</label>
					<label class="grid gap-1.5 text-xs font-semibold leading-snug text-ws-text/80">
						{$_("storySettings.deadlineLabel")}
					<input type="text" value={deadlineLabel} readonly class="min-h-10 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-3 text-xs text-ws-ink opacity-70" />
					</label>
				</article>
				<article class="grid min-h-0 min-w-0 content-start gap-3 rounded-ws-card border border-ws-line/12 bg-ws-surface2/40 p-4">
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storySettings.workflowSection")}</span>
					<label class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs font-semibold leading-snug text-ws-text/80"><input type="checkbox" checked disabled class="h-4 w-4 accent-ws-accent" /> {$_("storySettings.workflowPipeline")}</label>
					<label class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs font-semibold leading-snug text-ws-text/80"><input type="checkbox" checked disabled class="h-4 w-4 accent-ws-accent" /> {$_("storySettings.workflowQcBeforeExport")}</label>
					<label class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs font-semibold leading-snug text-ws-text/80"><input type="checkbox" disabled class="h-4 w-4 accent-ws-accent" /> {$_("storySettings.workflowAutoAssign")}</label>
				</article>
				<article class="grid min-h-0 min-w-0 content-start gap-3 rounded-ws-card border border-ws-line/12 bg-ws-surface2/40 p-4">
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storySettings.teamSection")}</span>
					<p class="text-[10px] font-semibold leading-relaxed text-ws-text/55">{$_("storySettings.assignBlurb")}</p>
					<p class="inline-flex w-fit items-center rounded-ws-ctrl border border-ws-accent/25 bg-ws-accent/10 px-2.5 py-1 text-[10px] font-black text-ws-accent">{assignmentScopeLabel()}</p>
					{#if !workspaceId}
						<p class="text-[11px] font-semibold text-ws-text/55">{$_("storySettings.assignUnavailable")}</p>
					{:else if assignmentsStatus === "loading" || assignmentsStatus === "idle"}
						<p class="text-[11px] font-semibold text-ws-text/55" role="status">{$_("storySettings.assignLoading")}</p>
					{:else if assignmentsStatus === "error"}
						<p class="text-[11px] font-semibold text-ws-rose" role="alert">{assignmentsError}</p>
					{:else}
						{#if dutyRoster.length === 0}
							<p class="text-[11px] font-semibold text-ws-text/55">{$_("storySettings.assignEmpty")}</p>
						{:else}
							<ul class="grid gap-1.5">
								{#each dutyRoster as member (member.userId)}
								<li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-ws-ctrl border border-ws-line/12 bg-ws-bg/40 px-2.5 py-1.5">
										<span class="truncate text-xs font-semibold text-ws-ink" title={member.displayName}>{member.displayName}</span>
										{#if canAssignDuties}
											<div class="flex items-center gap-1">
												<div class="flex flex-wrap gap-1" role="group" aria-label={$_("storySettings.assignRoleAria", { values: { name: member.displayName } })}>
													{#each ASSIGNMENT_ROLES as role (role)}
														{@const active = member.roles.has(role)}
														<button
															type="button"
															disabled={assignBusy}
															aria-pressed={active}
															onclick={() => void toggleDuty(member, role)}
															class={`min-h-8 rounded-ws-ctrl border px-2 text-[10.5px] font-bold transition disabled:opacity-50 ${active ? "border-ws-accent bg-ws-accent/20 text-ws-accent" : "border-ws-line/15 bg-ws-bg/60 text-ws-text/70 hover:text-ws-ink"}`}
														>
															{$_(`chapterTeam.role.${role}`)}
														</button>
													{/each}
												</div>
												<button
													type="button"
													disabled={assignBusy}
													aria-label={$_("storySettings.assignRemoveAria", { values: { name: member.displayName } })}
													onclick={() => void removeMemberDuties(member)}
												class="inline-flex h-8 w-8 items-center justify-center rounded-ws-ctrl border border-ws-line/15 bg-ws-surface2/60 text-ws-text transition hover:bg-ws-rose/20 hover:text-ws-rose disabled:opacity-50"
												>
													<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-3.5 w-3.5 [stroke-width:2.4]" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
												</button>
											</div>
										{:else}
											<span class="text-[11px] font-bold text-ws-text/75">{[...member.roles].map((role) => $_(`chapterTeam.role.${role}`)).join(" · ")}</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
						{#if canAssignDuties && candidates.length > 0}
							<div class="grid grid-cols-1 items-end gap-2 min-[520px]:grid-cols-[minmax(0,1fr)_minmax(112px,auto)_auto]">
								<label class="grid gap-1 text-[10px] font-semibold text-ws-text/70">
									{$_("storySettings.assignMemberLabel")}
									<select
										bind:value={assignDraftUserId}
										disabled={assignBusy}
									class="min-h-9 min-w-0 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-1.5 text-[11px] font-semibold text-ws-ink focus:border-ws-accent focus:outline-none disabled:opacity-50"
									>
										<option value="">{$_("storySettings.assignMemberPlaceholder")}</option>
										{#each unassignedCandidates as candidate (candidate.userId)}
											<option value={candidate.userId}>{candidateLabel(candidate)}</option>
										{/each}
									</select>
								</label>
								<label class="grid gap-1 text-[10px] font-semibold text-ws-text/70">
									{$_("storySettings.assignRoleLabel")}
									<select
										bind:value={assignDraftRole}
										disabled={assignBusy}
									class="min-h-9 min-w-0 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-1.5 text-[11px] font-semibold text-ws-ink focus:border-ws-accent focus:outline-none disabled:opacity-50"
									>
										{#each ASSIGNMENT_ROLES as role (role)}
											<option value={role}>{$_(`chapterTeam.role.${role}`)}</option>
										{/each}
									</select>
								</label>
								<button
									type="button"
									disabled={!assignDraftUserId || assignBusy}
									onclick={() => void addAssignment()}
								class="ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3 text-[11px] font-black text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
								>
									{title.chapterCount > 1 ? $_("storySettings.assignAddAllChapters") : $_("storySettings.assignAdd")}
								</button>
							</div>
						{/if}
						{#if assignmentsError && assignmentsStatus === "ready"}
							<p class="text-[11px] font-semibold text-ws-rose" role="alert">{assignmentsError}</p>
						{:else if assignReceipt}
							<p class="text-[11px] font-bold text-ws-green" role="status">{assignReceipt}</p>
						{/if}
					{/if}
				</article>
			{#if workspaceId && canAssignDuties}
				<article class="grid min-h-0 min-w-0 content-start gap-2.5 rounded-ws-card border border-ws-line/12 bg-ws-bg/40 p-4">
					<div class="grid gap-0.5">
						<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("storySettings.inviteEyebrow")}</span>
						<p class="text-[10px] font-semibold leading-relaxed text-ws-text/55">{$_("storySettings.inviteBlurb")}</p>
					</div>
					<div class="grid grid-cols-1 items-end gap-2 min-[560px]:grid-cols-[minmax(0,1.4fr)_minmax(120px,auto)_minmax(120px,auto)]">
						<label class="grid gap-1 text-[10px] font-semibold text-ws-text/70">
							{$_("storySettings.inviteEmailLabel")}
							<input
								type="email"
								bind:value={inviteEmail}
								disabled={inviteBusy}
								placeholder={$_("storySettings.inviteEmailPlaceholder")}
								class="min-h-9 min-w-0 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-2 text-[11px] font-semibold text-ws-ink focus:border-ws-accent focus:outline-none disabled:opacity-50"
							/>
						</label>
						<label class="grid gap-1 text-[10px] font-semibold text-ws-text/70">
							{$_("storySettings.inviteScopeLabel")}
							<select
								bind:value={inviteChapterScope}
								disabled={inviteBusy}
								class="min-h-9 min-w-0 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-1.5 text-[11px] font-semibold text-ws-ink focus:border-ws-accent focus:outline-none disabled:opacity-50"
							>
								<option value="all">{$_("storySettings.inviteScopeAll")}</option>
								{#each invitableChapters as chapter (chapter.project.projectId)}
									<option value={chapter.project.projectId}>{chapter.chapterLabel}</option>
								{/each}
							</select>
						</label>
						<label class="grid gap-1 text-[10px] font-semibold text-ws-text/70">
							{$_("storySettings.inviteRoleLabel")}
							<select
								bind:value={inviteRole}
								disabled={inviteBusy}
								class="min-h-9 min-w-0 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-1.5 text-[11px] font-semibold text-ws-ink focus:border-ws-accent focus:outline-none disabled:opacity-50"
							>
								<option value="editor">{$_("storySettings.inviteRoleEditor")}</option>
								<option value="viewer">{$_("storySettings.inviteRoleViewer")}</option>
							</select>
						</label>
					</div>
					<button
						type="button"
						disabled={!inviteEmail.trim() || inviteBusy}
						onclick={() => void sendScopedInvite()}
						class="ws-grad-primary inline-flex min-h-10 w-fit items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3.5 text-[11px] font-black text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
					>
						{inviteBusy ? $_("storySettings.inviteSending") : $_("storySettings.inviteSend")}
					</button>
					{#if inviteError}
						<p class="text-[11px] font-semibold text-ws-rose" role="alert">{inviteError}</p>
					{/if}
					{#if inviteLink}
						<div class="grid gap-1 rounded-ws-ctrl border border-ws-accent/25 bg-ws-accent/[0.06] p-2.5">
							<span class="text-[10px] font-bold text-ws-accent">{$_("storySettings.inviteLinkTitle")}</span>
							<div class="flex items-center gap-1.5">
								<input readonly value={inviteLink} class="min-h-8 min-w-0 flex-1 rounded-ws-ctrl border border-ws-line/15 bg-ws-bg/60 px-2 text-[10.5px] text-ws-text" />
								<button type="button" onclick={() => void copyInviteLink()} class="min-h-8 rounded-ws-ctrl border border-ws-line/15 bg-ws-surface2/60 px-2.5 text-[10.5px] font-bold text-ws-ink transition hover:bg-ws-accent/15">{$_("storySettings.inviteCopy")}</button>
							</div>
						</div>
					{/if}
				</article>
			{/if}
			<article class="danger grid min-h-0 min-w-0 content-start gap-3 rounded-ws-card border border-ws-rose/25 bg-ws-rose/[0.08] p-4">
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-rose">Danger zone</span>
					{#if !canManage}
						<p class="text-xs leading-relaxed text-ws-rose/80">{$_("storySettings.noDeletePermission")}</p>
					{:else if !confirmingDelete}
						<p class="text-xs leading-relaxed text-ws-rose/80">{$_("storySettings.deleteWarning", { values: { count: chapterCountLabel } })}</p>
						<div class="flex flex-wrap gap-2">
							<button
								type="button"
								onclick={startDeleteConfirm}
							class="danger-action inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-rose/45 bg-ws-rose/20 px-3.5 text-xs font-black text-ws-rose transition hover:bg-ws-rose/30"
							>
								{$_("storySettings.deleteThisStory")}
							</button>
						</div>
					{:else}
						<p class="text-xs font-semibold leading-relaxed text-ws-rose">
							{$_("storySettings.deleteConfirmWarning", { values: { title: title.title, count: chapterCountLabel } })}
						</p>
						<label class="grid gap-1.5 text-[11px] font-semibold leading-snug text-ws-rose/90">
							{$_("storySettings.typeTitlePrefix")} <span class="font-black">"{title.title}"</span> {$_("storySettings.typeTitleSuffix")}
							<input
								type="text"
								bind:value={deleteConfirmText}
								autocomplete="off"
								aria-label={$_("storySettings.confirmDeleteInputAria")}
							class="min-h-10 rounded-ws-ctrl border border-ws-rose/45 bg-ws-bg/60 px-3 text-xs text-ws-ink focus:border-ws-rose focus:outline-none"
							/>
						</label>
						{#if deleteError}
							<p class="text-[11px] font-semibold text-ws-rose" role="alert">{deleteError}</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<button
								type="button"
								disabled={!canDelete}
								onclick={confirmDelete}
							class="danger-action inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-rose/60 bg-ws-rose px-3.5 text-xs font-black text-white transition hover:bg-ws-rose/90 disabled:cursor-not-allowed disabled:opacity-45"
							>
								{deletingStory ? $_("storySettings.deleting") : $_("storySettings.deletePermanent")}
							</button>
							<button
								type="button"
								disabled={deletingStory}
								onclick={cancelDeleteConfirm}
							class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-text disabled:opacity-45"
							>
								{$_("storySettings.cancel")}
							</button>
						</div>
					{/if}
				</article>
			</div>
			<footer class="flex items-center justify-between gap-4 border-t border-ws-line/12 bg-ws-bg/40 p-5">
			<button type="button" class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-text" onclick={onClose}>{$_("storySettings.close")}</button>
			<button type="button" class="primary ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3.5 text-xs font-black text-white transition hover:brightness-110" onclick={onClose}>{$_("storySettings.done")}</button>
			</footer>
		</div>
	</div>
{/if}
