<!--
	PageLeaseBanner — concurrent-edit Phase 1 presence steering.

	When the page open in the editor is already leased by SOMEONE ELSE (another
	user) or by THIS user's OTHER tab, show a non-blocking banner that explains
	who is editing and offers a choice — View only / Take over (or Continue here
	for the same-user case) — instead of letting the user do work that would later
	hit a save conflict. The lease has already STEERED them here; CAS on save is
	still the final net.

	Reads editLeaseStore (status + conflict). Hidden when the lease is held by this
	tab, idle, or the lock service is unavailable (in which case the user just
	edits and CAS guards the save).
-->
<script lang="ts">
	import { _ } from "svelte-i18n";
	import { editLeaseStore } from "$lib/stores/edit-lease.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

	let dismissedToView = $state(false);

	let status = $derived(editLeaseStore.status);
	let conflict = $derived(editLeaseStore.conflict);
	let visible = $derived(
		!dismissedToView && (status === "held-by-other" || status === "held-by-self-tab"),
	);
	let isSelfTab = $derived(status === "held-by-self-tab");
	// C2/C3: this tab's lease was STOLEN mid-edit. Show a non-dismissible read-only
	// notice (a recovery draft was already snapshotted by the project store).
	let takenOver = $derived(status === "taken-over");

	// The lease only carries the holder's userId. Resolve it to a human name via the
	// loaded workspace members (displayName, else a visible email); NEVER surface the
	// raw UUID — fall back to a generic "someone" label when the holder isn't known.
	let ownerName = $derived.by(() => {
		const id = conflict?.heldByUserId?.trim();
		if (!id) return $_("collab.lease.someone");
		const member = workspacesStore.members.find((m) => m.userId === id);
		const label = member?.displayName?.trim() || member?.email?.trim();
		return label || $_("collab.lease.someone");
	});

	// Reset the local "view only" dismissal whenever the steering target changes
	// (e.g. the user navigated to a different contested page).
	$effect(() => {
		// Touch the keys so the effect re-runs on change.
		void status;
		void conflict?.lockId;
		dismissedToView = false;
	});

	async function takeOver(): Promise<void> {
		await editLeaseStore.takeOver();
	}

	function viewOnly(): void {
		dismissedToView = true;
	}
</script>

{#if takenOver}
	<div class="page-lease-banner page-lease-banner--takenover" role="alert" aria-live="assertive">
		<div class="page-lease-banner__text">
			<strong class="page-lease-banner__title">{$_("collab.lease.takenOverTitle")}</strong>
			<span class="page-lease-banner__body">{$_("collab.lease.takenOverBody")}</span>
		</div>
	</div>
{:else if visible}
	<div class="page-lease-banner" role="alert" aria-live="assertive">
		<div class="page-lease-banner__text">
			<strong class="page-lease-banner__title">
				{#if isSelfTab}
					{$_("collab.lease.heldBySelfTitle")}
				{:else}
					{$_("collab.lease.heldByOtherTitle", { values: { name: ownerName } })}
				{/if}
			</strong>
			<span class="page-lease-banner__body">
				{#if isSelfTab}
					{$_("collab.lease.heldBySelfBody")}
				{:else}
					{$_("collab.lease.heldByOtherBody")}
				{/if}
			</span>
		</div>
		<div class="page-lease-banner__actions">
			{#if !isSelfTab}
				<button type="button" class="page-lease-banner__btn ghost" onclick={viewOnly}>
					{$_("collab.lease.view")}
				</button>
			{/if}
			<button type="button" class="page-lease-banner__btn primary" onclick={takeOver}>
				{isSelfTab ? $_("collab.lease.continueHere") : $_("collab.lease.takeOver")}
			</button>
		</div>
	</div>
{/if}

<style>
	.page-lease-banner {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 16px;
		max-width: min(560px, calc(100% - 24px));
		padding: 10px 14px;
		border-radius: 12px;
		border: 1px solid rgba(251, 191, 36, 0.4);
		background: rgba(20, 16, 8, 0.92);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
		color: #f4f2ea;
	}

	.page-lease-banner--takenover {
		border-color: rgba(248, 113, 113, 0.5);
		background: rgba(24, 10, 10, 0.94);
	}

	.page-lease-banner__text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.page-lease-banner__title {
		font-size: 13px;
		font-weight: 700;
	}

	.page-lease-banner__body {
		font-size: 12px;
		color: rgba(244, 242, 234, 0.74);
	}

	.page-lease-banner__actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	.page-lease-banner__btn {
		padding: 6px 12px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		white-space: nowrap;
	}

	.page-lease-banner__btn.ghost {
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(255, 255, 255, 0.16);
		color: #f4f2ea;
	}

	.page-lease-banner__btn.primary {
		background: #fbbf24;
		color: #1a1505;
	}

	.page-lease-banner__btn:hover {
		filter: brightness(1.08);
	}
</style>
