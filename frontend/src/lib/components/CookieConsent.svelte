<!--
  CookieConsent — granular GDPR/CCPA/PDPA consent banner.

  Shows on first visit until a choice is persisted. Three categories:
    - necessary  (always on, locked)
    - analytics  (opt-in)
    - marketing  (opt-in)

  Re-openable from the footer "Cookie settings" link via the global
  `comic-workspace:open-cookie-settings` event, so the choice can be revised.
-->
<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { _ } from "$lib/i18n";
	import { config } from "$lib/config.js";
	import {
		DEFAULT_COOKIE_CONSENT,
		acceptAllConsent,
		loadConsent,
		rejectNonEssentialConsent,
		saveConsent,
		shouldPromptForConsent,
		type CookieConsent,
	} from "$lib/consent/cookie-consent";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let open = $state(false);
	let showDetails = $state(false);
	let modalActive = $state(false);
	// Working copy of the toggles while the banner is open.
	let choice = $state<CookieConsent>({ ...DEFAULT_COOKIE_CONSENT });

	let dialogEl = $state<HTMLDivElement>();
	let lastFocused: HTMLElement | null = null;
	let modalObserver: MutationObserver | null = null;

	function openBanner(withDetails: boolean) {
		const stored = loadConsent();
		choice = stored
			? { necessary: true, analytics: stored.analytics, marketing: stored.marketing }
			: { ...DEFAULT_COOKIE_CONSENT };
		showDetails = withDetails;
		lastFocused = (document.activeElement as HTMLElement) ?? null;
		open = true;
	}

	// Mirror the local choice to the backend GDPR audit trail (W2.6
	// /consent/events). Fire-and-forget: the banner never blocks on the network,
	// but the server keeps a durable, timestamped record per spec. The backend
	// also expects a `functional` category — we map "necessary" onto it so the
	// always-on baseline is recorded truthfully.
	function recordConsentServerSide(consent: CookieConsent) {
		if (typeof fetch === "undefined") return;
		try {
			void fetch(`${config.apiBase}/consent/events`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					categories: {
						necessary: true,
						functional: true,
						analytics: consent.analytics,
						marketing: consent.marketing,
					},
					policyVersion: config.consentPolicyVersion ?? "2026-06-01",
					consentType: "cookie",
				}),
			}).catch((cause) => console.warn("[CookieConsent] audit capture failed", cause));
		} catch (cause) {
			console.warn("[CookieConsent] audit capture failed", cause);
		}
	}

	function persistAndClose(consent: CookieConsent) {
		saveConsent(consent);
		recordConsentServerSide(consent);
		open = false;
		showDetails = false;
		lastFocused?.focus?.();
		// Signal so deferred first-visit UI (e.g. the onboarding tour) can start
		// only after the consent dialog is out of the way — avoids overlapping
		// modals fighting for focus on a brand-new visitor's first load.
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("comic-workspace:cookie-consent-saved"));
		}
	}

	function acceptAll() {
		persistAndClose(acceptAllConsent());
	}

	function rejectAll() {
		persistAndClose(rejectNonEssentialConsent());
	}

	function savePreferences() {
		persistAndClose({ necessary: true, analytics: choice.analytics, marketing: choice.marketing });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!open) return;
		// While a foreground aria-modal dialog owns the screen (the banner is
		// visually deferred), its keys must NOT fall through to the banner —
		// Escape in the save-conflict dialog was persisting reject-all
		// (codex P2). defaultPrevented covers dialogs that already consumed it.
		if (modalActive || event.defaultPrevented) return;
		if (event.key === "Escape") {
			// Escape = decline non-essential (privacy-preserving default).
			event.preventDefault();
			rejectAll();
			return;
		}
		if (event.key === "Tab" && dialogEl) {
			const focusables = dialogEl.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
			);
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}

	function handleReopen() {
		openBanner(true);
	}

	function updateModalActive() {
		if (typeof document === "undefined") return;
		modalActive = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
	}

	onMount(() => {
		if (shouldPromptForConsent()) openBanner(false);
		updateModalActive();
		if (typeof MutationObserver !== "undefined") {
			modalObserver = new MutationObserver(updateModalActive);
			modalObserver.observe(document.body, {
				attributes: true,
				attributeFilter: ["aria-modal", "role"],
				childList: true,
				subtree: true,
			});
		}
		window.addEventListener("comic-workspace:open-cookie-settings", handleReopen);
	});

	onDestroy(() => {
		modalObserver?.disconnect();
		modalObserver = null;
		if (typeof window !== "undefined") {
			window.removeEventListener("comic-workspace:open-cookie-settings", handleReopen);
		}
	});

	$effect(() => {
		// Move focus into the banner once it opens for keyboard/AT users.
		if (open && !modalActive && dialogEl) {
			const target = dialogEl.querySelector<HTMLElement>("button");
			target?.focus();
		}
	});

	// Reserve real layout space for the banner while it is shown so it never
	// obscures page content (e.g. the dashboard pipeline/notifications panels or
	// any bottom controls underneath it). The banner itself stays a fixed overlay
	// — but we mark <body> with `cc-consent-open` and publish the banner's live
	// height into `--cc-banner-height`. Global CSS then turns that into bottom
	// padding/scroll-padding on the workspace scroll surfaces AND normal
	// document-scroll pages, so the last row of content is always reachable and
	// fully visible. On dismiss the class + variable are cleared, releasing every
	// bit of the reserved space. A ResizeObserver keeps the reserve in sync as the
	// card wraps/grows responsively (Customize expands it; narrow widths stack the
	// buttons), so the space tracks the banner at desktop, iPad and phone widths.
	$effect(() => {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		const body = document.body;
		if (!open || !dialogEl) {
			body.classList.remove("cc-consent-open");
			root.style.removeProperty("--cc-banner-height");
			return;
		}
		const el = dialogEl;
		const apply = () => {
			// 16px is the .cc-root padding around the card (top + bottom gutter on
			// phones); offsetHeight already includes the card's own box, so the
			// reserve = card height + that outer gutter so nothing peeks under it.
			root.style.setProperty("--cc-banner-height", `${Math.ceil(el.offsetHeight) + 32}px`);
		};
		apply();
		body.classList.add("cc-consent-open");
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
		ro?.observe(el);
		return () => {
			ro?.disconnect();
			body.classList.remove("cc-consent-open");
			root.style.removeProperty("--cc-banner-height");
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div
		class={`cc-root${modalActive ? " cc-root--modal-deferred" : ""}`}
		role="region"
		aria-label={t("cookieConsent.aria", "Cookie consent")}
		aria-hidden={modalActive ? "true" : undefined}
	>
		<div
			class="cc-card ws-panel"
			bind:this={dialogEl}
			role="dialog"
			aria-modal="false"
			aria-labelledby="cc-title"
			aria-describedby="cc-desc"
		>
			<div class="cc-head">
				<h2 id="cc-title">{t("cookieConsent.title", "We value your privacy")}</h2>
				<p id="cc-desc">
					{t(
						"cookieConsent.intro",
						"We use cookies to run the workspace, remember your choices, and — only if you allow it — measure usage and improve the product. You can change this any time from “Cookie settings”.",
					)}
				</p>
			</div>

			{#if showDetails}
				<div class="cc-categories">
					<label class="cc-cat cc-cat-locked">
						<input type="checkbox" checked disabled aria-describedby="cc-necessary-desc" />
						<span class="cc-cat-text">
							<strong>{t("cookieConsent.necessary.title", "Strictly necessary")}</strong>
							<small id="cc-necessary-desc">
								{t(
									"cookieConsent.necessary.body",
									"Required for sign-in, security and saving your work. Always on.",
								)}
							</small>
						</span>
						<span class="cc-always">{t("cookieConsent.alwaysOn", "Always on")}</span>
					</label>

					<label class="cc-cat">
						<input type="checkbox" bind:checked={choice.analytics} aria-describedby="cc-analytics-desc" />
						<span class="cc-cat-text">
							<strong>{t("cookieConsent.analytics.title", "Analytics")}</strong>
							<small id="cc-analytics-desc">
								{t(
									"cookieConsent.analytics.body",
									"Anonymous, aggregated usage so we know which features help and which to fix.",
								)}
							</small>
						</span>
					</label>

					<label class="cc-cat">
						<input type="checkbox" bind:checked={choice.marketing} aria-describedby="cc-marketing-desc" />
						<span class="cc-cat-text">
							<strong>{t("cookieConsent.marketing.title", "Marketing")}</strong>
							<small id="cc-marketing-desc">
								{t(
									"cookieConsent.marketing.body",
									"Lets us measure campaigns and show you relevant updates. Off by default.",
								)}
							</small>
						</span>
					</label>
				</div>
			{/if}

			<div class="cc-actions">
				{#if showDetails}
					<button type="button" class="cc-btn cc-btn-primary ws-grad-primary" onclick={savePreferences}>
						{t("cookieConsent.save", "Save preferences")}
					</button>
				{:else}
					<button type="button" class="cc-btn cc-btn-ghost ws-btn-ghost" onclick={() => (showDetails = true)}>
						{t("cookieConsent.customize", "Customize")}
					</button>
				{/if}
				<button type="button" class="cc-btn cc-btn-ghost ws-btn-ghost" onclick={rejectAll}>
					{t("cookieConsent.reject", "Reject non-essential")}
				</button>
				<button type="button" class="cc-btn cc-btn-primary ws-grad-primary" onclick={acceptAll}>
					{t("cookieConsent.acceptAll", "Accept all")}
				</button>
			</div>

			<p class="cc-links">
				<a href="/privacy">{t("cookieConsent.privacyLink", "Privacy Policy")}</a>
				<span aria-hidden="true">·</span>
				<a href="/terms">{t("cookieConsent.termsLink", "Terms")}</a>
			</p>
		</div>
	</div>
{/if}

<style>
	.cc-root {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 2000;
		display: flex;
		justify-content: center;
		padding: 16px;
		pointer-events: none;
	}

	.cc-root--modal-deferred {
		z-index: 70;
	}

	.cc-card {
		pointer-events: auto;
		width: min(640px, 100%);
		border-radius: var(--radius-ws-card, 12px);
		backdrop-filter: blur(12px);
		color: var(--color-ws-ink);
		padding: 20px;
	}

	.cc-root--modal-deferred .cc-card {
		pointer-events: none;
		opacity: 0.52;
		transform: translateY(8px);
	}

	.cc-head h2 {
		margin: 0 0 6px;
		font-size: 16px;
		font-weight: 700;
	}

	.cc-head p {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--color-ws-text);
	}

	.cc-categories {
		display: grid;
		gap: 10px;
		margin: 16px 0;
	}

	.cc-cat {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 12px;
		align-items: start;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		padding: 12px;
		cursor: pointer;
	}

	.cc-cat-locked {
		cursor: default;
		opacity: 0.85;
	}

	.cc-cat input {
		margin-top: 2px;
		width: 18px;
		height: 18px;
		accent-color: var(--color-ws-accent);
	}

	.cc-cat-text strong {
		display: block;
		font-size: 13.5px;
		font-weight: 700;
	}

	.cc-cat-text small {
		display: block;
		margin-top: 3px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-ws-text);
	}

	.cc-always {
		align-self: center;
		font-size: 11px;
		font-weight: 600;
		color: var(--color-ws-accent);
		white-space: nowrap;
	}

	.cc-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.cc-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 0 16px;
		border-radius: var(--radius-ws-ctrl, 10px);
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
		border: 1px solid transparent;
		transition: filter 0.14s ease, border-color 0.14s ease;
	}

	.cc-btn-ghost {
		color: var(--color-ws-ink);
		/* scoped .cc-btn's transparent border out-specifies global .ws-btn-ghost */
		border-color: var(--ws-hair);
	}

	.cc-btn-primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		color: var(--color-ws-ink);
	}

	.cc-btn-primary:hover {
		filter: brightness(1.08);
	}

	.cc-btn:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.cc-links {
		margin: 12px 0 0;
		font-size: 12px;
		color: var(--color-ws-faint);
		text-align: center;
	}

	.cc-links a {
		color: var(--color-ws-blue);
		text-decoration: underline;
	}

	@media (max-width: 560px) {
		.cc-actions {
			justify-content: stretch;
		}

		.cc-btn {
			flex: 1 1 140px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.cc-card {
			animation: cc-rise 180ms ease-out;
		}
	}

	@keyframes cc-rise {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
