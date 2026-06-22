<!--
CancelReviewDialog — cancel/reject a review assignment with a MANDATORY reason.

The reviewer may already have started the work, so cancelling is NOT silent: the
reason is required (the confirm CTA stays disabled until non-empty) and the
backend ALWAYS notifies the affected reviewer in-app (mandatory), with email as
a pref-gated best-effort add-on. This dialog only collects the reason + confirms;
the store/route own the notify guarantee.

Violet ws-* tokens, reuses the shared Dialog atom.
-->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import { _ } from "$lib/i18n";
	import type { ReviewAssignment } from "$lib/types.js";

	function msg(key: string, fallback: string, vars?: Record<string, string | number>): string {
		const value = vars ? $_(key, { values: vars }) : $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		open,
		assignment,
		busy = false,
		onClose,
		onConfirm,
	}: {
		open: boolean;
		assignment: ReviewAssignment | null;
		busy?: boolean;
		onClose: () => void;
		onConfirm: (reason: string) => void;
	} = $props();

	let reason = $state("");

	// Reset the field whenever a different assignment is targeted / reopened.
	$effect(() => {
		void assignment?.id;
		void open;
		reason = "";
	});

	const canConfirm = $derived(reason.trim().length > 0 && !busy);
	const who = $derived(assignment?.assigneeHandle || assignment?.assigneeUserId || "");
</script>

<Dialog
	{open}
	{onClose}
	role="alertdialog"
	size="sm"
	busy={busy}
	title={msg("review.cancelTitle", "Cancel this review")}
	description={msg("review.cancelWarning", "The reviewer may have already started — they will be notified immediately.")}
>
	<div class="rcd-body">
		{#if who}
			<p class="rcd-target">
				{msg("review.cancelTarget", "Reviewer: {name}", { name: who })}
			</p>
		{/if}
		<label class="rcd-label" for="rcd-reason">{msg("review.cancelReasonLabel", "Reason (required)")}</label>
		<textarea
			id="rcd-reason"
			class="rcd-textarea"
			rows="3"
			bind:value={reason}
			disabled={busy}
			placeholder={msg("review.cancelReasonPlaceholder", "Why is this review being cancelled?")}
		></textarea>
		<p class="rcd-notify">{msg("review.cancelNotifyNotice", "We will notify {name} in-app (and by email if enabled).", { name: who })}</p>
	</div>

	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ws-dialog-btn" disabled={busy} onclick={onClose}>
			{msg("review.cancelDialogKeep", "Keep assignment")}
		</button>
		<button
			type="button"
			class="ws-dialog-btn ws-dialog-btn-danger"
			disabled={!canConfirm}
			onclick={() => onConfirm(reason.trim())}
		>
			{busy ? msg("review.decisionSaving", "Saving…") : msg("review.cancelConfirm", "Cancel & notify reviewer")}
		</button>
	{/snippet}
</Dialog>

<style>
	.rcd-body {
		display: grid;
		gap: 10px;
	}

	.rcd-target {
		margin: 0;
		font-size: 13px;
		font-weight: 700;
		color: var(--color-ws-ink);
	}

	.rcd-label {
		font-size: 11px;
		font-weight: 750;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}

	.rcd-textarea {
		width: 100%;
		resize: vertical;
		min-height: 64px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
	}

	.rcd-textarea:focus {
		outline: none;
		border-color: var(--color-ws-accent);
	}

	.rcd-notify {
		margin: 0;
		font-size: 12px;
		color: var(--color-ws-accent);
	}
</style>
