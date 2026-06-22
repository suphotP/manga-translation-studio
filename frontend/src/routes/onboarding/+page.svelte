<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { dismissTour } from "$lib/onboarding/tour-steps";

	const TOUR_STORAGE_KEY = "manga-editor.onboarding.tour.v1";

	// Per-step i18n key triples; the localized title/body/hint resolve reactively
	// in markup via $_(). Step 1's title/body keep "Dashboard", step 2 "Library /
	// Story / Chapter", step 3 "Editor / AI" as product terms inside the copy.
	const stepKeys = [
		{
			title: "onboarding.step1.title",
			body: "onboarding.step1.body",
			hint: "onboarding.step1.hint",
		},
		{
			title: "onboarding.step2.title",
			body: "onboarding.step2.body",
			hint: "onboarding.step2.hint",
		},
		{
			title: "onboarding.step3.title",
			body: "onboarding.step3.body",
			hint: "onboarding.step3.hint",
		},
	];
	const stepCount = stepKeys.length;

	let stepIndex = $state(0);
	let busy = $state(false);

	onMount(() => {
		void authStore.init();
	});

	function next(): void {
		if (stepIndex < stepCount - 1) stepIndex += 1;
		else complete();
	}

	function back(): void {
		if (stepIndex > 0) stepIndex -= 1;
	}

	async function complete(destination: string = "/"): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			if (typeof localStorage !== "undefined") {
				localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ done: true, at: new Date().toISOString() }));
			}
			// Unify first-run: finishing this full-page tour also dismisses the
			// dashboard spotlight (OnboardingTour) so the new user isn't onboarded
			// twice — and the spotlight can't swallow their first "create chapter".
			dismissTour();
			await goto(destination, { replaceState: true });
		} finally {
			busy = false;
		}
	}

	async function skip(): Promise<void> {
		await complete();
	}

	// Every exit from onboarding MUST route through complete() so onboarding is
	// marked done + the dashboard spotlight is dismissed before we navigate.
	// The quick links were plain anchors that bypassed this, letting a user leave
	// onboarding un-finished and get double-onboarded on the dashboard.
	async function go(event: MouseEvent, destination: string): Promise<void> {
		event.preventDefault();
		await complete(destination);
	}
</script>

<svelte:head>
	<title>{$_("onboarding.docTitle")}</title>
</svelte:head>

<div class="onb-shell ws-sans">
	<header class="onb-brand">
		<span class="onb-mark ws-grad-primary" aria-hidden="true">CW</span>
		<span>Comic Workspace</span>
		<button type="button" class="onb-skip ws-btn-ghost" onclick={skip} disabled={busy}>{$_("onboarding.skipTour")}</button>
	</header>

	<main class="onb-stage">
		<section class="onb-card ws-panel rounded-ws-card" aria-labelledby="onb-title">
			<div class="onb-progress" role="progressbar" aria-valuemin="1" aria-valuemax={stepCount} aria-valuenow={stepIndex + 1}>
				{#each stepKeys as step, i (i)}
					<span class="onb-dot" class:active={i === stepIndex} class:done={i < stepIndex}></span>
				{/each}
			</div>

			<header class="onb-head">
				<small>{$_("onboarding.stepCounter", { values: { current: stepIndex + 1, total: stepCount } })}</small>
				<h1 id="onb-title">{$_(stepKeys[stepIndex].title)}</h1>
				<p>{$_(stepKeys[stepIndex].body)}</p>
			</header>

			<div class="onb-hint ws-grad-primary-soft">
				<span class="onb-hint-tag">{$_("onboarding.hintTag")}</span>
				<span>{$_(stepKeys[stepIndex].hint)}</span>
			</div>

			<footer class="onb-foot">
				<button type="button" class="onb-back ws-btn-ghost" onclick={back} disabled={busy || stepIndex === 0}>
					{$_("onboarding.back")}
				</button>
				<button type="button" class="onb-next ws-grad-primary" onclick={next} disabled={busy}>
					{stepIndex === stepCount - 1 ? $_("onboarding.start") : $_("onboarding.next")}
				</button>
			</footer>
		</section>

		<aside class="onb-cta ws-panel-quiet rounded-ws-card" aria-label="Quick links">
			<h2>{$_("onboarding.quickStartHeading")}</h2>
			<ul>
				<li><a class="ws-btn-ghost" href="/dashboard" onclick={(e) => go(e, "/dashboard")}>{$_("onboarding.openDashboard")}</a></li>
				<li><a class="ws-btn-ghost" href="/library" onclick={(e) => go(e, "/library")}>{$_("onboarding.openLibrary")}</a></li>
				<li><a class="ws-btn-ghost" href="/storage" onclick={(e) => go(e, "/storage")}>{$_("onboarding.openStorage")}</a></li>
			</ul>
			<p class="onb-cta-help">
				{$_("onboarding.signedInAs", { values: { email: authStore.currentUser?.email ?? $_("onboarding.userFallback") } })}
			</p>
		</aside>
	</main>
</div>

<style>
	.onb-shell {
		display: grid;
		grid-template-rows: auto 1fr;
		min-height: 100dvh;
		padding: 24px clamp(20px, 4vw, 48px) 32px;
		background:
			radial-gradient(1200px 600px at 80% -10%, color-mix(in srgb, var(--color-ws-accent) 16%, transparent), transparent 60%),
			var(--color-ws-bg);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}

	.onb-brand {
		display: flex;
		gap: 10px;
		align-items: center;
		font-weight: 700;
		font-size: 13px;
	}
	.onb-mark {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 10px;
		font-weight: 900;
		color: var(--color-ws-ink);
	}
	.onb-skip {
		margin-left: auto;
		min-height: 36px;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-family: inherit;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	.onb-skip:hover { color: var(--color-ws-ink); }
	.onb-shell :focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.onb-stage {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 18px;
		align-content: center;
		justify-content: center;
		justify-items: center;
		/* Cap and center the single column on small/medium screens so the card
		   doesn't stretch edge-to-edge. */
		max-width: 520px;
		width: 100%;
		margin-inline: auto;
		padding-top: clamp(24px, 6vh, 64px);
	}

	@media (min-width: 920px) {
		.onb-stage {
			/* Center the two columns as a balanced block instead of left-packing
			   them against a wide-monitor void. */
			grid-template-columns: minmax(0, 480px) minmax(0, 320px);
			max-width: 818px;
			align-items: stretch;
			justify-items: stretch;
		}
	}

	.onb-card {
		width: 100%;
		padding: 28px clamp(20px, 4vw, 32px);
		display: grid;
		gap: 18px;
	}

	.onb-progress {
		display: flex;
		gap: 6px;
	}
	.onb-dot {
		flex: 1;
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair);
	}
	.onb-dot.done { background: color-mix(in srgb, var(--color-ws-green) 72%, transparent); }
	.onb-dot.active { background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent)); }

	.onb-head {
		display: grid;
		gap: 6px;
	}
	.onb-head small {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}
	.onb-head h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.onb-head p {
		margin: 0;
		font-size: 14px;
		line-height: 1.6;
		color: var(--color-ws-text);
	}

	.onb-hint {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px;
		align-items: center;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-ink);
		font-size: 13px;
		line-height: 1.45;
	}
	.onb-hint-tag {
		padding: 2px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.onb-foot {
		display: flex;
		gap: 10px;
		justify-content: space-between;
		align-items: center;
	}
	.onb-back, .onb-next {
		min-height: 42px;
		padding: 0 16px;
		border-radius: var(--radius-ws-ctrl);
		font-family: inherit;
		font-size: 13.5px;
		font-weight: 700;
		cursor: pointer;
	}
	.onb-back {
		color: var(--color-ws-text);
	}
	.onb-back:hover:not(:disabled) { color: var(--color-ws-ink); border-color: var(--ws-hair-strong); }
	.onb-back:disabled { opacity: 0.4; cursor: not-allowed; }

	.onb-next {
		border: 0;
		color: var(--color-ws-ink);
	}
	.onb-next:hover:not(:disabled) { filter: brightness(1.08); }
	.onb-next:disabled { opacity: 0.6; cursor: not-allowed; }

	.onb-cta {
		padding: 20px;
		display: grid;
		gap: 10px;
		align-self: center;
	}
	.onb-cta h2 {
		margin: 0;
		font-size: 13px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-ws-text);
	}
	.onb-cta ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.onb-cta a {
		display: block;
		min-height: 36px;
		padding: 9px 12px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		text-decoration: none;
		font-size: 13.5px;
		font-weight: 600;
		line-height: 1.35;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.onb-cta a:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
	}
	.onb-cta-help {
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--color-ws-faint);
	}
</style>
