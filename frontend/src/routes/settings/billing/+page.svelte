<!-- /(workspace)/settings/billing — Wave 2 W2.2.
     Reads the current Dodo-backed subscription, links to the portal for
     manage/upgrade/downgrade, lists invoices when the backend exposes them
     (otherwise points users at the customer portal), and exposes the BYO
     add-on toggle gated on Studio. -->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { permissions } from "$lib/stores/permissions.svelte.ts";
	import {
		billingStore,
		PUBLIC_PRICING_CARDS,
		BYO_ADDON_USD_PER_MONTH,
		type PublicPlanCard,
		type PublicPlanKey,
	} from "$lib/stores/billing.svelte.ts";
	import { usageStore } from "$lib/stores/usage.svelte.ts";
	import PlanBadge from "$lib/components/ui/PlanBadge.svelte";

	// Localise via svelte-i18n with an explicit fallback ($_ returns the key
	// itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let wsId = $derived(billingStore.currentWorkspaceId);
	let cycle = $state<"monthly" | "yearly">("monthly");
	let cancelDoubleConfirm = $state(false);
	let opError = $state<string | null>(null);
	let actionInFlight = $state<string | null>(null);
	let authReady = $state(false);

	// --- load guard -----------------------------------------------------------
	// The per-workspace loads (subscription/invoices/usage) MUST fire exactly once
	// per workspace id, and again ONLY when the workspace genuinely changes.
	//
	// Before this guard the page self-DoS'd: the `$effect` below read `wsId`
	// (= billingStore.currentWorkspaceId) and called loaders that WRITE store
	// state — loadSubscription() calls setCurrentWorkspaceId(), and the loaders
	// flip subscription/invoices/usage state the page reads — so the effect
	// re-ran after every load → an unbounded request loop (200-400 calls in ~3s)
	// that 429-stormed the backend. We break the cycle two ways:
	//   1. `loadedWsId` tracks the last workspace we kicked loads for, so a load
	//      fires only on a NEW id (never re-fires for the same workspace).
	//   2. the loader calls run inside `untrack(...)`, so the effect does NOT take
	//      a reactive dependency on whatever the loaders mutate.
	// onMount no longer duplicates the per-workspace loads — it only restores auth
	// and loads the (workspace-agnostic) catalog; the guarded effect owns the
	// initial per-workspace load and any later workspace-switch reload.
	let loadedWsId = $state<string | null>(null);

	function loadForWorkspace(id: string): void {
		void billingStore.loadSubscription(id);
		void billingStore.loadInvoices(id);
		// Load the usage dashboard so the plan badge/name resolve from the SAME
		// effective plan that drives the credit allowance everywhere else — keeps
		// this page's tier badge consistent with the dashboard/top-bar.
		void usageStore.load(id);
	}

	onMount(async () => {
		// On a hard reload / direct link no workspace chrome mounts AuthAccountMenu,
		// so the saved session has never been restored and apiAccessToken is null.
		// Restore auth BEFORE the protected billing loads run, otherwise the backend
		// 401s a logged-in user. init() is idempotent.
		await authStore.init();
		authReady = true;
		void billingStore.loadCatalog();
		// NOTE: the per-workspace loads are owned by the guarded $effect below —
		// flipping authReady re-runs it and (re)loads for the current workspace
		// exactly once. Duplicating them here is what caused the double-load.
	});

	$effect(() => {
		// React to the initial mount AND a runtime workspace switch (the id swaps at
		// runtime). Reading wsId/authReady here is the ONLY reactive dependency; the
		// actual loads are untracked + guarded so they fire once per workspace and
		// never re-trigger this effect.
		if (!authReady || !wsId) return;
		const id = wsId;
		untrack(() => {
			if (loadedWsId === id) return; // already loaded this workspace — no-op.
			loadedWsId = id;
			loadForWorkspace(id);
		});
	});

	const publicCards = PUBLIC_PRICING_CARDS;

	async function handleManage(): Promise<void> {
		opError = null;
		actionInFlight = "portal";
		try {
			await billingStore.openPortal();
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.portal", "Couldn't open the portal");
		} finally {
			actionInFlight = null;
		}
	}

	async function handleUpgrade(card: PublicPlanCard): Promise<void> {
		opError = null;
		if (!wsId) {
			opError = t("billing.error.noWorkspace", "No workspace selected");
			return;
		}
		if (card.key === "free") {
			await goto("/pricing");
			return;
		}
		actionInFlight = card.key;
		try {
			await billingStore.startCheckout({
				workspaceId: wsId,
				// `free` is handled above; the remaining display keys (creator/pro/studio)
				// are translated to Dodo checkout keys inside startDodoCheckoutSession.
				planKey: card.key as Exclude<PublicPlanKey, "free">,
				cycle,
			});
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.checkout", "Couldn't start checkout");
		} finally {
			actionInFlight = null;
		}
	}

	// BYO is RETIRED from sale (2026-06-12 owner decision — provider-ban and
	// moderation liability). Legacy subscribers keep a portal-only management
	// card below; there is no purchase path and the backend rejects byo_api.
	async function handleByoManage(): Promise<void> {
		opError = null;
		if (!wsId) return;
		actionInFlight = "byo_api";
		try {
			await billingStore.openPortal();
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.byo", "Couldn't open the portal");
		} finally {
			actionInFlight = null;
		}
	}

	async function handleStoragePack(): Promise<void> {
		opError = null;
		if (!wsId) return;
		actionInFlight = "storage_pack";
		try {
			// Storage packs are purchased through the portal until a dedicated
			// add-on checkout endpoint lands.
			await billingStore.openPortal();
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.portal", "Couldn't open the portal");
		} finally {
			actionInFlight = null;
		}
	}

	async function handleAiCreditPack(): Promise<void> {
		opError = null;
		if (!wsId) return;
		actionInFlight = "ai_pack";
		try {
			await billingStore.openPortal();
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.portal", "Couldn't open the portal");
		} finally {
			actionInFlight = null;
		}
	}

	async function handleCancel(): Promise<void> {
		opError = null;
		if (!cancelDoubleConfirm) {
			cancelDoubleConfirm = true;
			return;
		}
		actionInFlight = "cancel";
		try {
			// Cancellation lives in the Dodo customer portal.
			await billingStore.openPortal();
		} catch (error) {
			opError = error instanceof Error ? error.message : t("billing.error.portal", "Couldn't open the portal");
		} finally {
			actionInFlight = null;
		}
	}

	let publicKey = $derived(billingStore.publicPlanKey ?? "free");
	let isOnStudio = $derived(publicKey === "studio");

	// --- honest failed-load state (P2) ----------------------------------------
	// When the subscription load FAILS we must NOT downgrade a paying customer to
	// a misleading "Free / no subscription". A failed load is detected by: a load
	// was attempted (loadedWsId set), it is no longer in flight, the store carries
	// an error, AND no subscription resolved. In that case:
	//   - if the usage dashboard resolved a plan, fall back to THAT (the #274
	//     single-source-of-truth pattern — same plan the credit allowance uses);
	//   - otherwise show an error/retry banner and an "unknown" tier, never "Free".
	let subscriptionFailed = $derived(
		Boolean(loadedWsId) &&
			!billingStore.subscriptionLoading &&
			billingStore.subscription === null &&
			Boolean(billingStore.error),
	);
	// Did the usage dashboard give us a real (non-billing-derived) plan to trust?
	let usagePlanResolved = $derived(Boolean(usageStore.resolvedPlanKey));
	// Show the can't-determine-plan banner only when BOTH sources failed to give a
	// trustworthy plan — i.e. the subscription errored AND usage didn't resolve one.
	let planLoadError = $derived(subscriptionFailed && !usagePlanResolved);

	// The DISPLAYED tier (badge + name) prefers the effective plan resolved by the
	// usage dashboard — the same source that drives the credit allowance — so this
	// page's badge agrees with the dashboard/top-bar. (`publicKey`/`isOnStudio`
	// stay on the billing assignment, which is what gates the BYO add-on.)
	// On a hard error with no resolved plan we render an explicit "unknown" badge
	// rather than silently downgrading the customer to "free".
	let displayPlanKey = $derived(
		usageStore.resolvedPlanKey ?? (subscriptionFailed ? "free" : publicKey),
	);
	let displayPlanName = $derived(
		usageStore.resolvedPlanName ??
			billingStore.currentPlan?.name ??
			(subscriptionFailed
				? t("billing.plan.unknown", "Plan unavailable")
				: t("billing.plan.free", "Free")),
	);
	let assignment = $derived(billingStore.subscription?.assignment ?? null);
	let cancelLabel = $derived(
		cancelDoubleConfirm
			? t("billing.cancel.confirm", "Confirm · opens the portal to cancel")
			: t("billing.cancel.action", "Cancel subscription"),
	);

	function retryLoad(): void {
		const id = wsId;
		if (!id) return;
		billingStore.error = null;
		loadForWorkspace(id);
	}

	function formatStatus(status: string | null | undefined): string {
		switch (status) {
			case "active":
				return t("billing.status.active", "Active");
			case "mock_active":
				return t("billing.status.mockActive", "Active (mock)");
			case "trialing":
				return t("billing.status.trialing", "Trialing");
			case "past_due":
				return t("billing.status.pastDue", "Past due");
			case "cancelled":
				return t("billing.status.cancelled", "Cancelled");
			default:
				return status ?? t("billing.status.unknown", "Unknown");
		}
	}

	function formatDate(value: string | null | undefined): string {
		if (!value) return "—";
		try {
			const localeTag = ($_("billing.dateLocale") || "en-US").trim();
			return new Date(value).toLocaleDateString(
				localeTag && localeTag !== "billing.dateLocale" ? localeTag : "en-US",
				{
					year: "numeric",
					month: "short",
					day: "numeric",
				},
			);
		} catch {
			return value;
		}
	}

	function formatCurrency(cents: number, currency: string): string {
		const value = cents / 100;
		try {
			return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
		} catch {
			return `${currency.toUpperCase()} ${value.toFixed(2)}`;
		}
	}
</script>

<svelte:head>
	<title>{t("billing.pageTitle", "Billing · Workspace Settings")}</title>
</svelte:head>

<div class="settings-page">
	<header class="settings-head">
		<p class="eyebrow">{t("billing.eyebrow", "Workspace · Settings")}</p>
		<h1>{t("billing.heading", "Billing")}</h1>
		<p>
			{t(
				"billing.intro",
				"Manage your plan, invoices, the BYO API key add-on, and buy Storage / AI credit packs for this workspace.",
			)}
		</p>
	</header>

	{#if !wsId}
		<div class="settings-warning">
			{t(
				"billing.noWorkspace",
				"No workspace selected — open the dashboard to pick a workspace first.",
			)}
		</div>
	{:else}
		{#if opError}
			<div class="settings-error" role="alert">{opError}</div>
		{/if}

		{#if planLoadError}
			<div class="settings-error" role="alert">
				<span>
					{t(
						"billing.loadError",
						"Couldn't load your subscription. Your plan is shown as unavailable until this reloads — it has NOT changed.",
					)}
				</span>
				<button type="button" class="settings-btn ws-dialog-btn ws-btn-ghost" onclick={() => retryLoad()}>
					{t("billing.retry", "Retry")}
				</button>
			</div>
		{/if}

		<section class="plan-card ws-panel">
			<div class="plan-card-head">
				{#if planLoadError}
					<!-- Both sources failed to give a trustworthy plan: render a neutral
					     "unknown" chip, NEVER a "Free" badge — silently downgrading a
					     paying customer to Free is a billing-correctness bug. The heading
					     beside it reads "Plan unavailable". -->
					<span class="plan-unknown-badge" title={displayPlanName}>—</span>
				{:else}
					<PlanBadge plan={displayPlanKey} size="md" />
				{/if}
				<div>
					<h2>{displayPlanName}</h2>
					<p>
						{#if billingStore.subscriptionLoading}
							{t("billing.loading", "Loading…")}
						{:else if assignment}
							{t("billing.statusLabel", "Status")}: {formatStatus(assignment.status)} ·
							{t("billing.renews", "Renews")}: {formatDate(assignment.currentPeriodEnd ?? assignment.updatedAt)}
						{:else if planLoadError}
							{t("billing.planUnavailable", "Plan could not be loaded — retry above.")}
						{:else}
							{t("billing.noSubscription", "No subscription yet")}
						{/if}
					</p>
				</div>
			</div>
			<div class="plan-card-actions">
				{#if permissions.canManageBilling}
				<button
					type="button"
					class="settings-btn settings-btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
					onclick={() => void handleManage()}
					disabled={!billingStore.canManageBilling || billingStore.portalInFlight}
				>
					{actionInFlight === "portal"
						? t("billing.opening", "Opening…")
						: t("billing.manage", "Manage subscription")}
				</button>
				{/if}
				<a class="settings-btn ws-dialog-btn ws-btn-ghost" href="/pricing" target="_blank" rel="noopener">
					{t("billing.comparePlans", "Compare plans")}
				</a>
			</div>
			{#if billingStore.isPastDue}
				<p class="plan-card-flag flag-warn">
					{t(
						"billing.pastDueFlag",
						"Payment past due — open Manage subscription to update your card now.",
					)}
				</p>
			{:else if billingStore.isTrialActive}
				<p class="plan-card-flag flag-trial">{t("billing.trialFlag", "Trial in progress")}</p>
			{/if}
		</section>

		{#if permissions.canManageBilling}
		<section class="upgrade-grid" aria-label={t("billing.changePlanAria", "Change plan")}>
			<header class="section-head">
				<h3>{t("billing.changePlanTitle", "Change / upgrade plan")}</h3>
				<div class="cycle-toggle ws-panel-quiet" role="tablist">
					<button
						type="button"
						class="ws-seg"
						role="tab"
						class:active={cycle === "monthly"}
						aria-selected={cycle === "monthly"}
						onclick={() => (cycle = "monthly")}
					>
						{t("billing.cycle.monthly", "Monthly")}
					</button>
					<button
						type="button"
						class="ws-seg"
						role="tab"
						class:active={cycle === "yearly"}
						aria-selected={cycle === "yearly"}
						onclick={() => (cycle = "yearly")}
					>
						{t("billing.cycle.yearly", "Yearly · 20% off")}
					</button>
				</div>
			</header>
			<div class="upgrade-cards">
				{#each publicCards as card (card.key)}
					{@const current = publicKey === card.key}
					<button
						type="button"
						class="upgrade-card ws-panel-quiet ws-row-hover"
						class:upgrade-current={current}
						disabled={current || actionInFlight === card.key}
						onclick={() => void handleUpgrade(card)}
					>
						<PlanBadge plan={card.key} size="xs" />
						<strong>{card.name}</strong>
						<small>
							{#if card.key === "free"}
								$0
							{:else if cycle === "yearly"}
								${Math.round(card.yearlyUsd / 12)} {t("billing.perMonthBilledYearly", "/ mo · billed yearly")}
							{:else}
								${card.monthlyUsd} {t("billing.perMonth", "/ mo")}
							{/if}
						</small>
						<span>
							{current
								? t("billing.currentPlan", "Current plan")
								: card.ctaIntent === "contact_sales"
									? t("billing.contactSales", "Contact sales")
									: t("billing.choosePlan", "Choose this plan")}
						</span>
					</button>
				{/each}
			</div>
		</section>
		{/if}

		{#if permissions.canManageBilling}
		<section class="addon-grid" aria-label={t("billing.addonsAria", "Add-ons")}>
			{#if billingStore.hasBYOAddOn}
				<!-- Legacy-only: BYO is retired from sale; existing subscribers manage
				     or cancel it through the customer portal. -->
				<article class="addon-card ws-panel">
					<header>
						<p class="eyebrow">{t("billing.addon.label", "Add-on")}</p>
						<h3>{t("billing.byo.title", "BYO API key")}</h3>
						<p>{t("billing.byo.retiredBlurb", "This add-on is no longer offered. Your existing subscription keeps working — manage or cancel it in the portal.")}</p>
					</header>
					<div class="addon-body">
						<strong>${BYO_ADDON_USD_PER_MONTH}<small>{t("billing.perMonthShort", "/mo")}</small></strong>
						<button
							type="button"
							class="settings-btn ws-dialog-btn ws-btn-ghost"
							disabled={actionInFlight === "byo_api"}
							onclick={() => void handleByoManage()}
						>
							{t("billing.byo.activeManage", "Active · manage in portal")}
						</button>
					</div>
				</article>
			{/if}

			<article class="addon-card ws-panel">
				<header>
					<p class="eyebrow">{t("billing.storage.label", "Storage pack")}</p>
					<h3>{t("billing.storage.title", "Add storage")}</h3>
					<p>{t("billing.storage.blurb", "Buy monthly storage when a workspace nears its cap, without upgrading the whole plan.")}</p>
				</header>
				<div class="addon-body">
					<strong>{t("billing.storage.from", "From")} $3<small>/25GB</small></strong>
					<button
						type="button"
						class="settings-btn ws-dialog-btn ws-btn-ghost"
						disabled={actionInFlight === "storage_pack"}
						onclick={() => void handleStoragePack()}
					>
						{t("billing.storage.cta", "Choose a storage pack")}
					</button>
				</div>
			</article>

			<article class="addon-card ws-panel">
				<header>
					<p class="eyebrow">{t("billing.aiPack.label", "AI credit pack")}</p>
					<h3>{t("billing.aiPack.title", "One-time credits")}</h3>
					<p>{t("billing.aiPack.blurb", "Top-up credits for a heavier month — no recurring charge.")}</p>
				</header>
				<div class="addon-body">
					<strong>$29<small> · 50K ops</small></strong>
					<button
						type="button"
						class="settings-btn ws-dialog-btn ws-btn-ghost"
						disabled={actionInFlight === "ai_pack"}
						onclick={() => void handleAiCreditPack()}
					>
						{t("billing.aiPack.cta", "Buy a credit pack")}
					</button>
				</div>
			</article>
		</section>
		{/if}

		<section class="invoice-section ws-panel" aria-label={t("billing.invoicesAria", "Invoices")}>
			<h3>{t("billing.invoices.title", "Invoice history")}</h3>
			{#if billingStore.invoicesLoading}
				<p class="muted">{t("billing.loading", "Loading…")}</p>
			{:else if billingStore.invoicesAvailability === "portal_only"}
				<div class="invoice-empty">
					<p>{t("billing.invoices.portalHint", "Invoices and payment history are in the Dodo portal.")}</p>
					{#if permissions.canManageBilling}
					<button
						type="button"
						class="settings-btn settings-btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
						onclick={() => void handleManage()}
						disabled={!billingStore.canManageBilling}
					>
						{t("billing.invoices.openPortal", "Open invoice portal")}
					</button>
					{/if}
				</div>
			{:else if billingStore.invoicesAvailability === "unavailable"}
				<p class="muted">{t("billing.invoices.unavailable", "Couldn't load invoices — open the portal to view them.")}</p>
			{:else if billingStore.invoices.length === 0}
				<p class="muted">{t("billing.invoices.empty", "No invoices in the current billing period.")}</p>
			{:else}
				<table class="invoice-table">
					<thead>
						<tr>
							<th>{t("billing.invoices.col.date", "Date")}</th>
							<th>{t("billing.invoices.col.number", "Invoice no.")}</th>
							<th>{t("billing.invoices.col.amount", "Amount")}</th>
							<th>{t("billing.invoices.col.status", "Status")}</th>
							<th>{t("billing.invoices.col.invoice", "Invoice")}</th>
						</tr>
					</thead>
					<tbody>
						{#each billingStore.invoices as inv (inv.invoiceId)}
							<tr>
								<td>{formatDate(inv.createdAt)}</td>
								<td>{inv.number ?? inv.invoiceId}</td>
								<td>{formatCurrency(inv.amountCents, inv.currency)}</td>
								<td>{inv.status}</td>
								<td>
									{#if inv.pdfUrl}
										<a href={inv.pdfUrl} target="_blank" rel="noopener">PDF</a>
									{:else if inv.hostedUrl}
										<a href={inv.hostedUrl} target="_blank" rel="noopener">{t("billing.invoices.open", "Open")}</a>
									{:else}
										—
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		{#if permissions.canManageBilling}
		<section class="cancel-section" aria-label={t("billing.cancelAria", "Cancel subscription")}>
			<button
				type="button"
				class="cancel-link"
				onclick={() => void handleCancel()}
				disabled={!billingStore.canManageBilling || actionInFlight === "cancel"}
				aria-describedby="cancel-help"
			>
				{cancelLabel}
			</button>
			<small id="cancel-help">
				{t(
					"billing.cancel.help",
					"After cancelling you keep access until the end of the current billing period — we'll send you to the Dodo portal to confirm.",
				)}
			</small>
		</section>
		{/if}
	{/if}
</div>

<style>
	.settings-page {
		max-width: 1080px;
		margin: 0 auto;
		padding: 48px clamp(16px, 4vw, 56px) 96px;
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}
	.settings-head {
		margin-bottom: 32px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-ws-violet);
		font-size: 11px;
		margin: 0 0 6px;
	}
	.settings-head h1 {
		font-size: 32px;
		font-weight: 800;
		margin: 0 0 8px;
	}
	.settings-head p {
		color: var(--color-ws-text);
		font-size: 14px;
	}
	.settings-warning {
		padding: 14px 16px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-amber) 72%, var(--color-ws-ink));
		font-size: 13px;
	}
	.settings-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 16px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
		font-size: 13px;
		margin-bottom: 16px;
	}
	.plan-card {
		border-radius: var(--radius-ws-card);
		padding: 24px;
		display: grid;
		gap: 16px;
		margin-bottom: 28px;
	}
	.plan-card-head {
		display: flex;
		align-items: flex-start;
		gap: 16px;
	}
	.plan-card-head h2 {
		margin: 6px 0 4px;
		font-size: 22px;
		font-weight: 800;
	}
	.plan-card-head p {
		font-size: 13px;
		color: var(--color-ws-text);
	}
	.plan-unknown-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 26px;
		min-height: 26px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface2);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
	}
	.plan-card-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.plan-card-flag {
		padding: 8px 12px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 12.5px;
		font-weight: 700;
	}
	.plan-card-flag.flag-warn {
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 35%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, var(--color-ws-surface));
		color: var(--color-ws-rose);
	}
	.plan-card-flag.flag-trial {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, var(--color-ws-surface));
		color: var(--color-ws-violet);
	}
	.settings-btn {
		min-height: 38px;
		text-decoration: none;
	}
	.settings-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.settings-btn-primary {
		border-color: transparent;
		color: var(--color-ws-ink);
	}
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}
	.section-head h3 {
		margin: 0;
		font-size: 16px;
	}
	.cycle-toggle {
		display: inline-flex;
		gap: 4px;
		padding: 4px;
		border-radius: var(--radius-ws-card);
	}
	.cycle-toggle button {
		min-height: 36px;
		background: transparent;
		border: 0;
		padding: 6px 14px;
		border-radius: var(--radius-ws-ctrl);
		cursor: pointer;
		font-size: 12px;
		font-weight: 700;
	}
	.cycle-toggle button.active {
		background: color-mix(in srgb, var(--color-ws-accent) 24%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}
	.upgrade-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: 10px;
		margin-bottom: 32px;
	}
	.upgrade-card {
		display: grid;
		gap: 6px;
		padding: 14px 14px 16px;
		min-height: 136px;
		border-radius: var(--radius-ws-card);
		text-align: left;
		cursor: pointer;
		color: var(--color-ws-ink);
	}
	.upgrade-card strong {
		font-size: 15px;
	}
	.upgrade-card small {
		color: var(--color-ws-text);
		font-size: 12px;
	}
	.upgrade-card span {
		color: var(--color-ws-violet);
		font-size: 12px;
		font-weight: 700;
	}
	.upgrade-card:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--ws-hair-strong));
	}
	.upgrade-current {
		border-color: color-mix(in srgb, var(--color-ws-accent) 54%, var(--ws-hair-strong));
		background: color-mix(in srgb, var(--color-ws-accent) 14%, var(--color-ws-surface));
	}
	.addon-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 12px;
		margin-bottom: 32px;
	}
	.addon-card {
		display: grid;
		gap: 14px;
		padding: 18px;
		border-radius: var(--radius-ws-card);
	}
	.addon-card h3 {
		margin: 4px 0 4px;
		font-size: 16px;
	}
	.addon-card p {
		color: var(--color-ws-text);
		font-size: 12.5px;
	}
	.addon-body {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.addon-body strong {
		font-size: 20px;
		font-weight: 800;
	}
	.addon-body strong small {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-ws-text);
	}
	.invoice-section {
		padding: 20px;
		border-radius: var(--radius-ws-card);
		margin-bottom: 28px;
	}
	.invoice-section h3 {
		margin: 0 0 12px;
		font-size: 16px;
	}
	.invoice-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.invoice-table th,
	.invoice-table td {
		border-bottom: 1px solid var(--ws-hair);
		padding: 10px 12px;
		text-align: left;
		color: var(--color-ws-ink);
	}
	.invoice-table th {
		color: var(--color-ws-text);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 11px;
	}
	.invoice-table a {
		color: var(--color-ws-violet);
		text-decoration: none;
		font-weight: 600;
	}
	.invoice-empty {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 18px;
		border-radius: var(--radius-ws-card);
		border: 1px dashed var(--ws-hair-strong);
		background: var(--color-ws-surface2);
	}
	.invoice-empty p {
		color: var(--color-ws-text);
		font-size: 13px;
	}
	.muted {
		color: var(--color-ws-text);
		font-size: 12.5px;
	}
	.cancel-section {
		display: grid;
		gap: 4px;
		justify-content: flex-end;
		text-align: right;
	}
	.cancel-link {
		background: transparent;
		border: 0;
		color: var(--color-ws-text);
		min-height: 36px;
		padding: 0 4px;
		font-size: 12.5px;
		text-decoration: underline;
		cursor: pointer;
	}
	.cancel-link:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.cancel-section small {
		color: var(--color-ws-faint);
		font-size: 11px;
	}
</style>
