<!-- /billing/mock-portal — Wave 2 W2.2.
     Landing page for the MOCK Dodo customer portal session. The backend returns
     a URL here (provider="mock") while the real Dodo portal is out of scope, so
     Manage subscription / invoice-portal / cancel CTAs resolve to an honest
     prototype page instead of a 404. No subscription state is changed here. -->
<script lang="ts">
	import { page } from "$app/state";
	import { _ } from "$lib/i18n";

	let workspace = $derived(page.url.searchParams.get("workspace") ?? "");
</script>

<svelte:head>
	<title>{$_("billing.mockPortal.pageTitleTab")}</title>
</svelte:head>

<div class="mock-page">
	<div class="mock-card">
		<p class="eyebrow">{$_("billing.mockPortal.eyebrow")}</p>
		<h1>{$_("billing.mockPortal.heading")}</h1>
		<p class="lead">{$_("billing.mockPortal.lead")}</p>
		{#if workspace}
			<p class="ws">{$_("billing.mockPortal.workspaceLabel")}: <span class="mono">{workspace}</span></p>
		{/if}
		<div class="actions">
			<a class="btn btn-primary" href="/settings/billing">{$_("billing.mockPortal.backToBilling")}</a>
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
	.ws {
		font-size: 13px;
		color: var(--color-ws-text, #9a9aa8);
		margin: 0;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		color: var(--color-ws-ink, #ececf2);
	}
	.actions {
		display: flex;
		gap: 8px;
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
