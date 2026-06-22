<!--
  OnboardingTour — first-visit guided spotlight for the workspace dashboard.

  Data-driven by ONBOARDING_TOUR_STEPS. Each step spotlights a
  `[data-tour="<target>"]` anchor (or shows a centered intro/outro card when the
  target is null). Fully keyboard driven: ←/→ navigate, Esc closes, focus is
  trapped in the tooltip. "Don't show again" persists via the tour-steps module.

  Auto-starts on first visit unless dismissed; can be replayed via the global
  `comic-workspace:start-onboarding-tour` event.
-->
<script lang="ts">
	import { onMount, onDestroy, tick } from "svelte";
	import { _ } from "$lib/i18n";
	import {
		ONBOARDING_TOUR_STEPS,
		dismissTour,
		shouldAutoStartTour,
		type TourStep,
	} from "$lib/onboarding/tour-steps";
	import { shouldPromptForConsent } from "$lib/consent/cookie-consent";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let active = $state(false);
	let stepIndex = $state(0);
	let dontShowAgain = $state(false);
	let spotlight = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	let tooltipEl = $state<HTMLDivElement>();
	let lastFocused: HTMLElement | null = null;

	const steps = ONBOARDING_TOUR_STEPS;
	let currentStep = $derived<TourStep>(steps[stepIndex]);
	let isFirst = $derived(stepIndex === 0);
	let isLast = $derived(stepIndex === steps.length - 1);

	function isVisible(el: HTMLElement): boolean {
		// `offsetParent === null` catches `display:none` ancestors (e.g. the
		// mobile-hidden search field); a zero-area rect catches collapsed nodes.
		if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	function findTarget(step: TourStep): HTMLElement | null {
		if (!step.target) return null;
		const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
		// Treat hidden targets (e.g. search field hidden under 980px) as missing so
		// we skip the step instead of spotlighting an off-screen zero-size node.
		if (el && !isVisible(el)) return null;
		return el;
	}

	/** Direction we're currently moving, so auto-skip of a hidden step continues that way. */
	let direction: 1 | -1 = 1;

	async function measure() {
		await tick();
		const step = currentStep;
		// Anchored step whose target is missing/hidden → skip it (don't strand the
		// user on a dimmed page with a tooltip pinned to nothing).
		if (step.target && !findTarget(step)) {
			const atEdge = direction === 1 ? isLast : isFirst;
			if (atEdge) {
				// No further step to fall back to: show a centered card instead of
				// a tooltip glued to the top-left corner.
				spotlight = null;
				return;
			}
			stepIndex += direction;
			await measure();
			return;
		}
		const el = findTarget(step);
		if (!el) {
			spotlight = null;
			return;
		}
		el.scrollIntoView({ block: "center", behavior: "auto" });
		await tick();
		const rect = el.getBoundingClientRect();
		const pad = 8;
		spotlight = {
			top: rect.top - pad,
			left: rect.left - pad,
			width: rect.width + pad * 2,
			height: rect.height + pad * 2,
		};
	}

	async function start() {
		stepIndex = 0;
		direction = 1;
		dontShowAgain = false;
		lastFocused = (document.activeElement as HTMLElement) ?? null;
		active = true;
		await measure();
	}

	function finish() {
		// First-visit-only: any exit (Done, Skip or Escape) persists the dismissal
		// so the tour never auto-reopens on later /dashboard visits. The checkbox
		// stays for explicitness, but completion alone is enough to stop re-prompts.
		dismissTour();
		active = false;
		spotlight = null;
		lastFocused?.focus?.();
	}

	async function next() {
		if (isLast) {
			finish();
			return;
		}
		direction = 1;
		stepIndex += 1;
		await measure();
	}

	async function prev() {
		if (isFirst) return;
		direction = -1;
		stepIndex -= 1;
		await measure();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!active) return;
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				finish();
				break;
			case "ArrowRight":
				event.preventDefault();
				void next();
				break;
			case "ArrowLeft":
				event.preventDefault();
				void prev();
				break;
			case "Tab":
				trapFocus(event);
				break;
		}
	}

	function trapFocus(event: KeyboardEvent) {
		if (!tooltipEl) return;
		const focusables = tooltipEl.querySelectorAll<HTMLElement>(
			'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const activeEl = document.activeElement;
		// Each step focuses the container itself (tabindex=-1). If the user tabs
		// straight away from there, keep focus inside the dialog instead of letting
		// it escape behind the modal: Shift-Tab → last control, Tab → first.
		if (activeEl === tooltipEl) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
			return;
		}
		if (event.shiftKey && activeEl === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && activeEl === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function handleResize() {
		if (active) void measure();
	}

	function handleStartEvent() {
		void start();
	}

	function autoStartWhenReady() {
		// Defer so the dashboard has painted its anchors first.
		requestAnimationFrame(() => requestAnimationFrame(() => void start()));
	}

	function handleConsentSaved() {
		window.removeEventListener("comic-workspace:cookie-consent-saved", handleConsentSaved);
		if (shouldAutoStartTour()) autoStartWhenReady();
	}

	onMount(() => {
		window.addEventListener("comic-workspace:start-onboarding-tour", handleStartEvent);
		if (!shouldAutoStartTour()) return;
		if (shouldPromptForConsent()) {
			// A brand-new visitor still has the cookie banner open. Both are dialogs
			// with global key handlers; starting now would stack two modals and steal
			// focus behind the banner. Wait until consent is saved, then auto-start.
			window.addEventListener("comic-workspace:cookie-consent-saved", handleConsentSaved);
			return;
		}
		autoStartWhenReady();
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("comic-workspace:start-onboarding-tour", handleStartEvent);
			window.removeEventListener("comic-workspace:cookie-consent-saved", handleConsentSaved);
		}
	});

	$effect(() => {
		// Focus the tooltip when a step renders so AT/keyboard users are oriented.
		if (active && tooltipEl) {
			void stepIndex; // re-run on step change
			tooltipEl.focus();
		}
	});

	// Tooltip position: centered for intro/outro, else near the spotlight.
	let tooltipStyle = $derived(computeTooltipStyle(spotlight, currentStep?.placement));

	function computeTooltipStyle(
		box: typeof spotlight,
		placement: TourStep["placement"] | undefined,
	): string {
		if (!box || placement === "center") {
			return "top:50%;left:50%;transform:translate(-50%,-50%);";
		}
		const gap = 14;
		const margin = 16;
		// Mirror the CSS width: min(340px, calc(100vw - 32px)).
		const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
		const vh = typeof window !== "undefined" ? window.innerHeight : 768;
		const tipW = Math.min(340, vw - 32);
		// Estimated tooltip height — enough to keep it on-screen vertically.
		const tipH = 280;

		let top: number;
		let left: number;
		let transform = "";
		switch (placement) {
			case "top":
				top = box.top - gap;
				left = box.left;
				transform = "translateY(-100%)";
				break;
			case "right":
				top = box.top;
				left = box.left + box.width + gap;
				break;
			case "left":
				top = box.top;
				left = box.left - gap;
				transform = "translateX(-100%)";
				break;
			case "bottom":
			default:
				top = box.top + box.height + gap;
				left = box.left;
				break;
		}

		// Clamp so the tooltip's rendered box stays within the viewport. Account
		// for the transforms (left/top placements shift the box up/left by 100%).
		if (transform.includes("translateX(-100%)")) {
			left = Math.max(margin + tipW, Math.min(left, vw - margin));
		} else {
			left = Math.max(margin, Math.min(left, vw - tipW - margin));
		}
		if (transform.includes("translateY(-100%)")) {
			top = Math.max(margin + tipH, Math.min(top, vh - margin));
		} else {
			top = Math.max(margin, Math.min(top, vh - tipH - margin));
		}

		const transformDecl = transform ? `transform:${transform};` : "";
		return `top:${top}px;left:${left}px;${transformDecl}`;
	}
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

{#if active}
	<!-- Backdrop with a cut-out spotlight. Clicking the backdrop advances. -->
	<div class="tour-overlay" role="presentation">
		{#if spotlight}
			<div
				class="tour-spotlight"
				style={`top:${spotlight.top}px;left:${spotlight.left}px;width:${spotlight.width}px;height:${spotlight.height}px;`}
			></div>
		{:else}
			<div class="tour-dim"></div>
		{/if}

		<div
			class="tour-tooltip"
			bind:this={tooltipEl}
			role="dialog"
			aria-modal="true"
			aria-labelledby="tour-title"
			aria-describedby="tour-body"
			tabindex="-1"
			style={tooltipStyle}
		>
			<div class="tour-progress" aria-hidden="true">
				{#each steps as step, i (step.id)}
					<span class:active={i === stepIndex}></span>
				{/each}
			</div>

			<h2 id="tour-title">{t(currentStep.titleKey, currentStep.titleFallback)}</h2>
			<p id="tour-body">{t(currentStep.bodyKey, currentStep.bodyFallback)}</p>

			<p class="tour-count" aria-live="polite">
				{t("onboardingTour.step", "Step")}
				{stepIndex + 1} / {steps.length}
			</p>

			<label class="tour-dont-show">
				<input type="checkbox" bind:checked={dontShowAgain} />
				{t("onboardingTour.dontShowAgain", "Don't show this again")}
			</label>

			<div class="tour-actions">
				<button type="button" class="tour-btn tour-btn-ghost" onclick={finish}>
					{t("onboardingTour.skip", "Skip")}
				</button>
				<div class="tour-nav">
					{#if !isFirst}
						<button type="button" class="tour-btn tour-btn-ghost" onclick={prev}>
							{t("onboardingTour.back", "Back")}
						</button>
					{/if}
					<button type="button" class="tour-btn tour-btn-primary" onclick={next}>
						{isLast ? t("onboardingTour.done", "Done") : t("onboardingTour.next", "Next")}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.tour-overlay {
		position: fixed;
		inset: 0;
		z-index: 1900;
	}

	.tour-dim {
		position: absolute;
		inset: 0;
		/* Lighter dim for the centered welcome/intro step so the dashboard stays
		   clearly visible BEHIND the card — a full-strength scrim over the already
		   dark workspace read as "everything disappeared" for first-run users. */
		background: rgba(5, 7, 12, 0.42);
	}

	/* Spotlight = a transparent box surrounded by a dimming shadow. Kept lighter
	   than the old 0.74 so the rest of the page is still legible while one element
	   is highlighted. */
	.tour-spotlight {
		position: absolute;
		border-radius: 14px;
		box-shadow: 0 0 0 9999px rgba(5, 7, 12, 0.58);
		outline: 2px solid rgba(124, 92, 255, 0.9);
		outline-offset: 2px;
		pointer-events: none;
	}

	.tour-tooltip {
		position: absolute;
		width: min(340px, calc(100vw - 32px));
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 14px;
		background: linear-gradient(135deg, rgba(28, 28, 38, 0.99), rgba(11, 11, 15, 0.99));
		box-shadow: 0 22px 56px rgba(0, 0, 0, 0.55);
		color: #ececf2;
		padding: 18px;
	}

	.tour-tooltip:focus {
		outline: none;
	}

	.tour-progress {
		display: flex;
		gap: 5px;
		margin-bottom: 12px;
	}

	.tour-progress span {
		width: 18px;
		height: 4px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.16);
	}

	.tour-progress span.active {
		background: linear-gradient(90deg, #8b5cf6, #d946ef);
	}

	.tour-tooltip h2 {
		margin: 0 0 6px;
		font-size: 15px;
		font-weight: 700;
	}

	.tour-tooltip p {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: #9a9aa8;
	}

	.tour-count {
		margin-top: 10px !important;
		font-size: 11px !important;
		color: #6b6b78 !important;
	}

	.tour-dont-show {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0 14px;
		font-size: 12px;
		color: #9a9aa8;
		cursor: pointer;
	}

	.tour-dont-show input {
		width: 16px;
		height: 16px;
		accent-color: #7c5cff;
	}

	.tour-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.tour-nav {
		display: flex;
		gap: 8px;
	}

	.tour-btn {
		min-height: 36px;
		padding: 0 14px;
		border-radius: 9px;
		font-size: 12.5px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
	}

	.tour-btn-ghost {
		border-color: rgba(255, 255, 255, 0.14);
		background: rgba(255, 255, 255, 0.06);
		color: #ececf2;
	}

	.tour-btn-primary {
		background: linear-gradient(135deg, #8b5cf6, #d946ef);
		color: #fff;
	}

	.tour-btn:focus-visible {
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: no-preference) {
		.tour-tooltip {
			animation: tour-pop 160ms ease-out;
		}
		.tour-spotlight {
			transition: top 200ms ease, left 200ms ease, width 200ms ease, height 200ms ease;
		}
	}

	@keyframes tour-pop {
		from {
			opacity: 0;
			transform-origin: top left;
		}
		to {
			opacity: 1;
		}
	}
</style>
