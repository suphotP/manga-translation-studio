<!-- Public /pricing page — Wave 2 W2.2.
     Four-tier table (Free, Creator, Pro, Studio) mirroring the enforced backend
     plan catalog (backend/src/services/plans.ts), monthly/yearly toggle,
     add-on card, gated CTAs depending on auth/workspace state, and a pricing
     FAQ accordion. Tier data comes from PUBLIC_PRICING_CARDS, which is pinned
     1:1 to the backend catalog by the public-pricing-matches-backend test. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { authUiStore, type AuthModalMode } from "$lib/stores/auth-ui.svelte.ts";
	import {
		billingStore,
		PUBLIC_PRICING_CARDS,
		type PublicPlanCard,
		type PublicPlanKey,
	} from "$lib/stores/billing.svelte.ts";
	import PlanBadge from "$lib/components/ui/PlanBadge.svelte";
	import { dialogFocus } from "$lib/components/Dialog.svelte";

	// Keep fallbacks English so public pricing never leaks Thai before locale init.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	function memberCountLabel(count: number): string {
		if (count === 1) {
			const singular = msg("pricing.specMemberValue", "{count} member");
			return singular.replace("{count}", String(count));
		}
		return msg("pricing.specMembersValue", "{count} members").replace("{count}", String(count));
	}

	let cycle = $state<"monthly" | "yearly">("monthly");
	let showWorkspaceModal = $state(false);
	let activeError = $state<string | null>(null);
	let pendingPlanKey = $state<PublicPlanKey | null>(null);

	let cards = $derived(PUBLIC_PRICING_CARDS);
	let isAuthenticated = $derived(authStore.isAuthenticated);

	// In-context auth: open the modal instead of full-page navigating to the
	// (auth) routes. On success the public visitor lands in their workspace.
	function openAuth(mode: AuthModalMode): void {
		authUiStore.openAuthModal(mode, () => {
			void goto("/dashboard");
		});
	}

	// Restore the saved session before any CTA reads `authStore.isAuthenticated`.
	// On a hard reload of the public /pricing page no workspace chrome mounts
	// AuthAccountMenu, so without this a logged-in user's localStorage token is
	// never rehydrated and paid-plan clicks wrongly route to /signup instead of
	// starting checkout for their stored workspace. init() is idempotent.
	onMount(() => {
		void authStore.init().catch(() => undefined);
	});

	function priceFor(card: PublicPlanCard): { headline: string; sub: string } {
		if (card.key === "free") return { headline: "$0", sub: msg("pricing.subForever", "Forever") };
		if (cycle === "yearly") {
			const perMonth = Math.round(card.yearlyUsd / 12);
			return {
				headline: `$${perMonth}`,
				sub: msg("pricing.subBilledYearly", "Billed yearly at ${amount}").replace(
					"{amount}",
					card.yearlyUsd.toLocaleString(),
				),
			};
		}
		return { headline: `$${card.monthlyUsd}`, sub: msg("pricing.subPerMonth", "per month") };
	}

	async function handleCta(card: PublicPlanCard): Promise<void> {
		activeError = null;
		pendingPlanKey = card.key;
		try {
			if (card.ctaIntent === "free") {
				if (!authStore.isAuthenticated) {
					await goto(`/signup?intent=free`);
					return;
				}
				await goto(`/`);
				return;
			}
			if (card.ctaIntent === "contact_sales") {
				if (typeof window !== "undefined") {
					window.location.assign("mailto:sales@example.com?subject=Studio%20Plus%20inquiry");
				}
				return;
			}
			// checkout
			if (!authStore.isAuthenticated) {
				await goto(`/signup?intent=billing&plan=${card.key}&cycle=${cycle}`);
				return;
			}
			const wsId = billingStore.currentWorkspaceId;
			if (!wsId) {
				showWorkspaceModal = true;
				return;
			}
			await billingStore.startCheckout({
				workspaceId: wsId,
				planKey: card.key as Exclude<PublicPlanKey, "free">,
				cycle,
			});
		} catch (error) {
			activeError = error instanceof Error ? error.message : msg("pricing.checkoutFailed", "Could not start checkout");
		} finally {
			pendingPlanKey = null;
		}
	}

	// FAQ copy is locale-reactive: each entry resolves its i18n key with the
	// English fallback so a missing catalog entry never leaks another language.
	let FAQS = $derived<{ q: string; a: string }[]>([
		{
			q: msg("pricing.faq1q", "Do I need a credit card to start free?"),
			a: msg("pricing.faq1a", "No. Free starts a private workspace with 2 GB storage and 100 AI credits per month."),
		},
		{
			q: msg("pricing.faq2q", "How does the 20% yearly discount work?"),
			a: msg("pricing.faq2a", "Yearly prices are billed once per year through Dodo and average about 20% less per month than monthly billing."),
		},
		{
			q: msg("pricing.faq3q", "Can I change or cancel later?"),
			a: msg("pricing.faq3a", "Yes. Use Settings → Billing → Manage subscription. Canceled plans remain active until the current billing period ends."),
		},
		{
			q: msg("pricing.faq4q", "How do AI credits work?"),
			a: msg("pricing.faq4a", "Each AI image costs credits by quality: 10 for low, 90 for medium, 360 for high. Monthly plan credits reset each billing cycle; top-up packs never block your work mid-chapter."),
		},
		{
			q: msg("pricing.faq5q", "Need enterprise volume or white-label support?"),
			a: msg("pricing.faq5a", "Studio already supports larger teams. For white-label, custom domains, extra seats, SLA/DPA, or volume terms, contact sales@example.com."),
		},
		{
			q: msg("pricing.faq6q", "Why is the Free plan small?"),
			a: msg("pricing.faq6a", "Free is for trying a real workflow, not for free file hosting. The app warns before usage exceeds the included limits."),
		},
		{
			q: msg("pricing.faq7q", "What happens when AI credits run out?"),
			a: msg("pricing.faq7a", "New AI jobs are queued or blocked until more credits are available. Existing work remains editable, and one-time credit packs can add capacity."),
		},
		{
			q: msg("pricing.faq8q", "Where is data stored?"),
			a: msg("pricing.faq8a", "The frontend is served through a CDN, project files live in object storage, and database data is stored in Postgres in EU-west for GDPR-ready operations."),
		},
		{
			q: msg("pricing.faq9q", "Can I get receipts or invoices?"),
			a: msg("pricing.faq9a", "Yes. Receipts and payment history are available in the Dodo Payments portal from Manage subscription."),
		},
		{
			q: msg("pricing.faq10q", "Need a custom quote?"),
			a: msg("pricing.faq10a", "Contact sales@example.com for custom quotes, SSO, DPA, or procurement help."),
		},
	]);

	let openIndex = $state<number | null>(0);
	function toggleFaq(index: number): void {
		openIndex = openIndex === index ? null : index;
	}
</script>

<svelte:head>
	<title>{msg("pricing.metaTitle", "Pricing - Manga Editor")}</title>
	<meta
		name="description"
		content={msg("pricing.metaDescription", "Pricing for the manga/webtoon translation workspace: Free, Creator, Pro, Studio, and Studio+")}
	/>
</svelte:head>

<div class="pricing-page ws-sans">
	<header class="pricing-hero">
		<div class="pricing-topbar">
			<a class="back-link" href="/">&lt; {msg("pricing.backHome", "Back home")}</a>
			{#if !isAuthenticated}
				<div class="pricing-auth-cta">
					<button type="button" class="pricing-auth-signin ws-btn-ghost" onclick={() => openAuth("login")}>
						{msg("pricing.signIn", "Sign in")}
					</button>
					<button type="button" class="pricing-auth-start ws-grad-primary" onclick={() => openAuth("register")}>
						{msg("pricing.startFree", "Start free")}
					</button>
				</div>
			{/if}
		</div>
		<p class="eyebrow">{msg("pricing.eyebrow", "Pricing")}</p>
		<h1>{msg("pricing.heading", "Choose a plan by team size and workload")}</h1>
		<p class="lede">
			{msg("pricing.lede", "Start with Free for real production trials, then upgrade as your team or AI workload grows. No hidden fees, cancel anytime.")}
		</p>

		<div class="cycle-toggle" role="tablist" aria-label={msg("pricing.ariaCycle", "Billing cycle")}>
			<button
				type="button"
				role="tab"
				aria-selected={cycle === "monthly"}
				class:active={cycle === "monthly"}
				onclick={() => (cycle = "monthly")}
			>
				{msg("pricing.monthly", "Monthly")}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={cycle === "yearly"}
				class:active={cycle === "yearly"}
				onclick={() => (cycle = "yearly")}
			>
				{msg("pricing.yearly", "Yearly")} <small>{msg("pricing.save20", "Save 20%")}</small>
			</button>
		</div>
	</header>

	{#if activeError}
		<div class="pricing-error" role="alert">{activeError}</div>
	{/if}

	<section class="pricing-grid" aria-label={msg("pricing.ariaGrid", "Pricing plan table")}>
		{#each cards as card (card.key)}
			{@const price = priceFor(card)}
			<article class="pricing-card ws-panel" class:highlight={card.highlight}>
				{#if card.highlight}
					<span class="pricing-badge ws-grad-primary-soft">{msg("pricing.recommended", "Recommended")}</span>
				{/if}
				<header class="pricing-card-head">
					<PlanBadge plan={card.key} size="md" />
					<h2>{card.name}</h2>
					<p>{msg(card.taglineKey, "")}</p>
				</header>
				<div class="pricing-price">
					<strong>{price.headline}</strong>
					<small>{price.sub}</small>
				</div>
				<ul class="pricing-specs">
					<li><span>{msg("pricing.specStorage", "Storage")}</span><strong>{card.storageLabel}</strong></li>
					<li><span>{msg("pricing.specAi", "AI")}</span><strong>{msg("pricing.specAiValue", "{count} credits / month").replace("{count}", String(card.aiCredits))}</strong></li>
					<li><span>{msg("pricing.specMembers", "Members")}</span><strong>{memberCountLabel(card.members)}</strong></li>
				</ul>
				<ul class="pricing-features">
					{#each card.featureKeys as featKey (featKey)}
						<li>{msg(featKey, "")}</li>
					{/each}
				</ul>
				<button
					type="button"
					class={card.highlight ? "pricing-cta cta-primary ws-grad-primary" : "pricing-cta ws-btn-ghost"}
					data-plan-cta={card.key}
					disabled={pendingPlanKey === card.key || billingStore.checkoutInFlight}
					onclick={() => void handleCta(card)}
				>
					{pendingPlanKey === card.key ? msg("pricing.ctaOpening", "Opening checkout...") : msg(card.ctaKey, "")}
				</button>
			</article>
		{/each}
	</section>

	<section class="pricing-faq" aria-label={msg("pricing.ariaFaq", "Frequently asked questions")}>
		<h2>{msg("pricing.faqHeading", "Frequently asked questions")}</h2>
		<div class="faq-list">
			{#each FAQS as faq, i (faq.q)}
				<details open={openIndex === i}>
					<summary
						onclick={(event) => {
							event.preventDefault();
							toggleFaq(i);
						}}
					>
						<span>{faq.q}</span>
						<i aria-hidden="true">{openIndex === i ? "−" : "+"}</i>
					</summary>
					<p>{faq.a}</p>
				</details>
			{/each}
		</div>
	</section>
</div>

{#if showWorkspaceModal}
	<div class="ws-modal-backdrop" role="presentation">
		<div
			class="ws-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="create-ws-title"
			aria-describedby="create-ws-desc"
			tabindex="-1"
			use:dialogFocus={{ onEscape: () => (showWorkspaceModal = false) }}
		>
			<h3 id="create-ws-title">{msg("pricing.wsModalTitle", "Create a workspace first")}</h3>
			<p id="create-ws-desc">{msg("pricing.wsModalDesc", "You do not have a workspace eligible for checkout yet. Create a workspace, then return to choose a plan.")}</p>
			<div class="ws-modal-actions">
				<button type="button" class="pricing-cta ws-btn-ghost" onclick={() => (showWorkspaceModal = false)}>{msg("pricing.wsModalClose", "Close")}</button>
				<a class="pricing-cta cta-primary ws-grad-primary" href="/">{msg("pricing.wsModalCreate", "Create workspace")}</a>
			</div>
		</div>
	</div>
{/if}

<style>
	.pricing-page {
		min-height: 100vh;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
		padding: 56px clamp(20px, 6vw, 80px) 96px;
		font-family: var(--font-ws-sans);
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 12px;
		text-decoration: none;
	}
	.back-link:hover {
		color: var(--color-ws-ink);
	}
	.pricing-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.pricing-auth-cta {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.pricing-auth-signin,
	.pricing-auth-start {
		min-height: 38px;
		padding: 0 14px;
		border-radius: var(--radius-ws-ctrl);
		font-family: inherit;
		font-size: 13px;
		font-weight: 800;
		cursor: pointer;
		transition: filter 0.14s ease, background 0.14s ease, border-color 0.14s ease;
	}
	.pricing-auth-signin {
		color: var(--color-ws-ink);
	}
	.pricing-auth-signin:hover {
		color: var(--color-ws-ink);
	}
	.pricing-auth-start {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		color: var(--color-ws-ink);
	}
	.pricing-auth-start:hover {
		filter: brightness(1.08);
	}
	.eyebrow {
		text-transform: uppercase;
		font-size: 11px;
		font-weight: 800;
		color: var(--color-ws-accent);
		margin: 24px 0 8px;
	}
	.pricing-hero h1 {
		font-size: clamp(28px, 4vw, 44px);
		line-height: 1.15;
		font-weight: 700;
		margin: 0 0 12px;
	}
	.lede {
		color: var(--color-ws-text);
		max-width: 640px;
		font-size: 15px;
		margin-bottom: 28px;
	}
	.cycle-toggle {
		display: inline-flex;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}
	.cycle-toggle button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 8px 20px;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		border: 0;
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.cycle-toggle button small {
		color: var(--color-ws-amber);
		font-size: 11px;
	}
	.cycle-toggle button.active {
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
	}
	.pricing-error {
		margin: 16px 0;
		padding: 12px 16px;
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		color: var(--color-ws-rose);
		font-size: 13px;
	}
	.pricing-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 18px;
		margin: 40px 0 56px;
	}
	.pricing-card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 28px 22px 24px;
		border-radius: var(--radius-ws-card);
	}
	.pricing-card.highlight {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface));
	}
	.pricing-badge {
		position: absolute;
		top: 12px;
		right: 16px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 36%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 800;
		text-transform: uppercase;
		padding: 4px 10px;
		border-radius: var(--radius-ws-ctrl);
	}
	.pricing-card-head h2 {
		font-size: 20px;
		margin: 10px 0 6px;
	}
	.pricing-card-head p {
		font-size: 12px;
		color: var(--color-ws-text);
		min-height: 32px;
	}
	.pricing-price {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.pricing-price strong {
		font-size: 32px;
		font-weight: 800;
	}
	.pricing-price small {
		color: var(--color-ws-text);
		font-size: 12px;
	}
	.pricing-specs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	.pricing-specs li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 0;
		border-bottom: 1px dashed var(--ws-hair);
		color: var(--color-ws-text);
	}
	.pricing-specs strong {
		color: var(--color-ws-ink);
	}
	.pricing-features {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 6px;
		font-size: 12.5px;
		color: var(--color-ws-text);
		flex: 1;
	}
	.pricing-features li::before {
		content: "✓ ";
		color: var(--color-ws-green);
		font-weight: 800;
	}
	.pricing-cta {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		min-height: 44px;
		padding: 0 16px;
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-ink);
		border: 1px solid var(--ws-hair-strong);
		font-weight: 700;
		text-decoration: none;
		cursor: pointer;
		font-size: 14px;
	}
	.pricing-cta:hover {
		border-color: var(--ws-hair-strong);
	}
	.pricing-cta.cta-primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		color: var(--color-ws-ink);
	}
	.pricing-cta:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	@media (max-width: 720px) {
			}
	.pricing-faq h2 {
		margin: 0 0 18px;
		font-size: 24px;
	}
	.faq-list {
		display: grid;
		gap: 8px;
	}
	.faq-list details {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		padding: 14px 18px;
		background: var(--color-ws-surface);
	}
	.faq-list summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		min-height: 36px;
		cursor: pointer;
		font-weight: 600;
		font-size: 14.5px;
		list-style: none;
	}
	.faq-list summary::-webkit-details-marker {
		display: none;
	}
	.faq-list summary i {
		font-style: normal;
		color: var(--color-ws-accent);
		font-size: 18px;
	}
	.faq-list details[open] p {
		margin-top: 10px;
		color: var(--color-ws-text);
		font-size: 13.5px;
		line-height: 1.55;
	}
	.ws-modal-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
	}
	.ws-modal {
		max-width: 420px;
		background: var(--color-ws-surface);
		border-radius: var(--radius-ws-card);
		padding: 28px;
		border: 1px solid var(--ws-hair);
		display: grid;
		gap: 12px;
	}
	.ws-modal h3 {
		margin: 0;
		font-size: 20px;
	}
	.ws-modal p {
		color: var(--color-ws-text);
		font-size: 13px;
	}
	.ws-modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 8px;
	}
</style>
