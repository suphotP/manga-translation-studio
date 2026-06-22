<script lang="ts">
	// Prominent banner shown when the current workspace is FROZEN by a verified
	// refund/chargeback (or an admin suspension). The backend 403
	// `workspace_suspended` is the hard gate; this banner is the UI reflection of the
	// `workspaceSuspension` store and links the owner to billing to restore access.
	import { _ } from "$lib/i18n";
	import { workspaceSuspension } from "$lib/stores/workspace-suspension.svelte.ts";

	interface Props {
		/** Where the "pay to restore" CTA navigates (defaults to the billing settings). */
		billingHref?: string;
	}
	let { billingHref = "/settings/billing" }: Props = $props();

	const reasonKey = $derived(
		workspaceSuspension.reason === "chargeback"
			? "billing.suspended.reasonChargeback"
			: workspaceSuspension.reason === "admin"
				? "billing.suspended.reasonAdmin"
				: "billing.suspended.reasonRefund",
	);
</script>

{#if workspaceSuspension.suspended}
	<div class="ws-suspended-banner" role="alert" aria-live="assertive">
		<div class="ws-suspended-banner__icon" aria-hidden="true">⚠️</div>
		<div class="ws-suspended-banner__body">
			<strong class="ws-suspended-banner__title">{$_("billing.suspended.title")}</strong>
			<p class="ws-suspended-banner__text">{$_(reasonKey)}</p>
		</div>
		<a class="ws-suspended-banner__cta" href={billingHref}>{$_("billing.suspended.cta")}</a>
	</div>
{/if}

<style>
	.ws-suspended-banner {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		margin: 0 0 1rem;
		border-radius: var(--radius-ws-card, 0.75rem);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 40%, var(--ws-hair));
		color: var(--color-ws-ink);
	}
	.ws-suspended-banner__icon {
		font-size: 1.25rem;
		line-height: 1;
	}
	.ws-suspended-banner__body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.ws-suspended-banner__title {
		display: block;
		font-weight: 700;
	}
	.ws-suspended-banner__text {
		margin: 0.15rem 0 0;
		font-size: 0.9rem;
		opacity: 0.9;
	}
	.ws-suspended-banner__cta {
		flex: 0 0 auto;
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-ws-ctrl, 0.5rem);
		background: var(--color-ws-rose);
		color: var(--color-ws-bg);
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}
	.ws-suspended-banner__cta:hover {
		background: color-mix(in srgb, var(--color-ws-rose) 85%, black);
	}
</style>
