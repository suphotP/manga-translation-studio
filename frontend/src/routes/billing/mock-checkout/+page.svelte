<!-- /billing/mock-checkout — Wave 2 W2.2.
     Landing page for the MOCK Dodo checkout session. The backend returns a URL
     here (provider="mock") while the real Dodo checkout service is out of this
     wave's scope, so the pricing/billing CTAs resolve to an honest prototype
     page instead of a 404. It does NOT mark anything as paid — plan assignment
     stays a platform-internal operation until the real provider lands. -->
<script lang="ts">
	import { page } from "$app/state";
	import { _ } from "$lib/i18n";

	let params = $derived(page.url.searchParams);
	let plan = $derived(params.get("plan") ?? "—");
	let cycle = $derived(params.get("cycle") ?? "monthly");
	let addons = $derived(params.getAll("addon"));
	let workspace = $derived(params.get("workspace") ?? "");
</script>

<svelte:head>
	<title>{$_("billing.mockCheckout.pageTitleTab")}</title>
</svelte:head>

<div class="mock-page">
	<div class="mock-card">
		<p class="eyebrow">{$_("billing.mockCheckout.eyebrow")}</p>
		<h1>{$_("billing.mockCheckout.heading")}</h1>
		<p class="lead">{$_("billing.mockCheckout.lead")}</p>
		<dl class="summary">
			<div><dt>{$_("billing.mockCheckout.planLabel")}</dt><dd>{plan}</dd></div>
			<div>
				<dt>{$_("billing.mockCheckout.cycleLabel")}</dt>
				<dd>{cycle === "yearly" ? $_("billing.mockCheckout.cycleYearly") : $_("billing.mockCheckout.cycleMonthly")}</dd>
			</div>
			{#if addons.length}
				<div><dt>{$_("billing.mockCheckout.addonLabel")}</dt><dd>{addons.join(", ")}</dd></div>
			{/if}
			{#if workspace}
				<div><dt>{$_("billing.mockCheckout.workspaceLabel")}</dt><dd class="mono">{workspace}</dd></div>
			{/if}
		</dl>
		<div class="actions">
			<a class="btn btn-primary" href="/settings/billing">{$_("billing.mockCheckout.backToBilling")}</a>
			<a class="btn" href="/pricing">{$_("billing.mockCheckout.viewAllPlans")}</a>
		</div>
	</div>
</div>

<style>
	.mock-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 48px 16px;
		background: linear-gradient(180deg, #07070d 0%, #0f0f18 100%);
		color: var(--color-ws-ink, #ececf2);
		font-family: "Inter", "IBM Plex Sans Thai", system-ui, sans-serif;
	}
	.mock-card {
		width: min(520px, 100%);
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 18px;
		padding: 32px;
		display: grid;
		gap: 16px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-ws-accent, #7c5cff);
		font-size: 11px;
		margin: 0;
	}
	h1 {
		margin: 0;
		font-size: 26px;
	}
	.lead {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 14px;
		margin: 0;
	}
	.summary {
		display: grid;
		gap: 8px;
		margin: 8px 0 0;
	}
	.summary div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 13px;
	}
	.summary dt {
		color: var(--color-ws-text, #9a9aa8);
	}
	.summary dd {
		margin: 0;
		font-weight: 600;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		min-height: 38px;
		padding: 0 16px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.12);
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}
	.btn-primary {
		background: linear-gradient(135deg, #7c5cff 0%, #b197ff 100%);
		border-color: transparent;
		color: white;
	}
</style>
