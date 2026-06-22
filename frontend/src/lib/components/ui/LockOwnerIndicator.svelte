<!--
	LockOwnerIndicator — workspace lock presence atom (W2.7 Phase 1).

	Renders an "X is editing …" pill when the locksStore (fed by SSE
	lock_acquired/lock_released events) reports an active lock for the given
	(scope, scopeId) tuple.

	Used by:
	  - PageNavigator (overlay on locked page rows)
	  - Canvas overlay layer (locked subjects on the editing surface)

	Phase-1 contract:
	  - Read-only presence indicator. Acquiring/releasing the lock is handled by
	    the work-locks routes (PR #85 — not yet landed). This atom only reflects
	    state pushed via SSE.
	  - Hidden when no lock matches the (scope, scopeId).
	  - Compact "remaining time" hint when expiresAt is known.
-->
<script lang="ts">
	import { locksStore } from "$lib/stores/locks.svelte.ts";
	import { _ } from "$lib/i18n";
	import Avatar, { type AvatarTone } from "./Avatar.svelte";

	let {
		scope,
		scopeId,
		variant = "pill",
		class: klass = "",
	}: {
		scope: string;
		scopeId: string;
		variant?: "pill" | "overlay";
		class?: string;
	} = $props();

	// Make sure the SSE → store wiring is live on first mount. Idempotent — the
	// store guards against double-wiring.
	$effect(() => {
		locksStore.wireToRealtime();
	});

	let lock = $derived(locksStore.getByScope(scope, scopeId));
	let ownerLabel = $derived(lock?.owner?.trim() || $_("lockOwnerIndicator.team"));
	let ownerInitial = $derived(ownerLabel.charAt(0).toUpperCase());

	let tone = $derived<AvatarTone>(pickTone(ownerLabel));

	let remainingCopy = $derived(formatRemaining(lock?.expiresAt));

	function pickTone(name: string): AvatarTone {
		// Deterministic so the same owner gets the same swatch across renders.
		const tones: AvatarTone[] = ["cyan", "violet", "green", "amber", "rose", "blue"];
		if (!name) return "neutral";
		let hash = 0;
		for (let index = 0; index < name.length; index += 1) {
			hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
		}
		return tones[hash % tones.length] ?? "cyan";
	}

	function formatRemaining(expiresAt: number | undefined): string {
		if (!expiresAt || !Number.isFinite(expiresAt)) return "";
		const ms = expiresAt - Date.now();
		if (ms <= 0) return $_("lockOwnerIndicator.expired");
		const minutes = Math.round(ms / 60_000);
		if (minutes < 1) return $_("lockOwnerIndicator.seconds", { values: { n: Math.max(1, Math.round(ms / 1000)) } });
		if (minutes < 60) return $_("lockOwnerIndicator.minutes", { values: { n: minutes } });
		const hours = Math.round(minutes / 60);
		return $_("lockOwnerIndicator.hours", { values: { n: hours } });
	}
</script>

{#if lock}
	<span
		class={`lock-owner-indicator lock-owner-indicator--${variant} ${klass}`}
		role="status"
		title={remainingCopy
			? $_("lockOwnerIndicator.titleWithTtl", { values: { owner: ownerLabel, scope, scopeId, ttl: remainingCopy } })
			: $_("lockOwnerIndicator.title", { values: { owner: ownerLabel, scope, scopeId } })}
	>
		<Avatar name={ownerLabel} initial={ownerInitial} size="xs" {tone} ring={false} />
		<span class="lock-owner-indicator__name">{ownerLabel}</span>
		<span class="lock-owner-indicator__verb">{$_("lockOwnerIndicator.verb")}</span>
		{#if remainingCopy}
			<span class="lock-owner-indicator__ttl">{remainingCopy}</span>
		{/if}
	</span>
{/if}

<style>
	.lock-owner-indicator {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(34, 211, 238, 0.08);
		color: #ececf2;
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		white-space: nowrap;
	}

	.lock-owner-indicator__name {
		font-weight: 700;
	}

	.lock-owner-indicator__verb {
		color: rgba(236, 236, 242, 0.72);
		font-weight: 500;
	}

	.lock-owner-indicator__ttl {
		padding: 1px 6px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.07);
		color: rgba(236, 236, 242, 0.78);
		font-size: 10px;
		font-weight: 600;
	}

	.lock-owner-indicator--overlay {
		position: absolute;
		top: 6px;
		left: 6px;
		z-index: 4;
		background: rgba(11, 11, 15, 0.78);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
	}
</style>
