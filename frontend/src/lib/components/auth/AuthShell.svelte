<script lang="ts">
	import type { Snippet } from "svelte";
	import { _ } from "$lib/i18n";
	import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";

	interface Props {
		/** Eyebrow text above the title (e.g. "Comic Workspace"). */
		eyebrow?: string;
		/** Page title rendered above the card. */
		title?: string;
		/** Supporting copy under the title. */
		subtitle?: string;
		/** Form content rendered inside the card. */
		children: Snippet;
		/** Optional footer slot (e.g. "Don't have an account? Sign up"). */
		footer?: Snippet;
	}

	let {
		eyebrow = "Comic Workspace",
		title = "Sign in",
		subtitle,
		children,
		footer,
	}: Props = $props();
</script>

<div class="auth-shell ws-sans">
	<a class="auth-skip" href="#auth-card">{$_("authShell.skipToForm")}</a>

	<header class="auth-brand" aria-label="Comic Workspace">
		<span class="auth-mark" aria-hidden="true">CW</span>
		<span class="auth-brand-text">{eyebrow}</span>
		<!-- Guests can't reach Settings, so the language picker must also live on
		     the auth surface (codex P2: locale switching outside auth). -->
		<span class="auth-lang"><LanguageSwitcher /></span>
	</header>

	<main class="auth-stage">
		<section class="auth-card ws-panel" id="auth-card" aria-labelledby="auth-card-title">
			<header class="auth-card-head">
				<h1 id="auth-card-title">{title}</h1>
				{#if subtitle}
					<p>{subtitle}</p>
				{/if}
			</header>
			<div class="auth-card-body">
				{@render children()}
			</div>
		</section>

		{#if footer}
			<footer class="auth-foot">
				{@render footer()}
			</footer>
		{/if}
	</main>

	<aside class="auth-side" aria-hidden="true">
		<div class="auth-side-grad"></div>
		<div class="auth-side-blob auth-side-blob-a"></div>
		<div class="auth-side-blob auth-side-blob-b"></div>
	</aside>
</div>

<style>
	.auth-shell {
		position: relative;
		display: grid;
		/* `min-height` (not a fixed height) lets the shell grow past the viewport
		   on short/mobile screens; combined with `overflow-y: auto` below this
		   keeps the submit button and footer reachable instead of clipping the
		   bottom of tall cards (signup/reset + password checklist). */
		min-height: 100dvh;
		grid-template-rows: auto 1fr;
		padding: 24px clamp(20px, 4vw, 48px) 32px;
		background:
			radial-gradient(1200px 600px at 80% -10%, color-mix(in srgb, var(--color-ws-violet) 16%, transparent), transparent 60%),
			radial-gradient(1000px 600px at -10% 110%, color-mix(in srgb, var(--color-ws-cyan) 10%, transparent), transparent 55%),
			var(--color-ws-bg);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		/* Only clip the horizontal axis (decorative side blobs); allow vertical
		   scroll so the form is never cut off on short viewports. */
		overflow-x: hidden;
		overflow-y: auto;
		isolation: isolate;
	}

	.auth-skip {
		position: absolute;
		left: 12px;
		top: 12px;
		padding: 6px 12px;
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		opacity: 0;
		pointer-events: none;
		transform: translateY(-8px);
		transition: opacity 0.15s ease, transform 0.15s ease;
		z-index: 4;
	}
	.auth-skip:focus-visible {
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0);
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.auth-brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		justify-self: center;
		padding: 8px 14px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		border: 1px solid var(--ws-hair);
		font-weight: 700;
		font-size: 13px;
		letter-spacing: 0.02em;
		color: var(--color-ws-ink);
		/* The language-switcher dropdown lives in this header and must paint ABOVE
		   .auth-stage (z2 flex item, later in DOM — equal z let the card swallow
		   every option click, so the picker looked dead). `position: relative`
		   makes the z-index real outside flex/grid layouts; 3 beats the stage's 2
		   and stays under the skip-link's 4. */
		position: relative;
		z-index: 3;
	}
	.auth-mark {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: calc(var(--radius-ws-ctrl) - 4px);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		font-size: 10px;
		font-weight: 900;
		color: var(--color-ws-ink);
	}
	.auth-brand-text {
		color: var(--color-ws-ink);
	}

	.auth-stage {
		display: flex;
		flex-direction: column;
		/* `center` keeps the card vertically centred on tall screens, but a flex
		   column lets it overflow naturally (and scroll via .auth-shell) on short
		   screens instead of being clipped by a fixed `1fr` track. */
		justify-content: center;
		align-items: center;
		gap: 20px;
		/* Reserve a little breathing room so the centred card never butts against
		   the shell padding when it does scroll. */
		padding-block: 8px;
		z-index: 2;
	}

	.auth-card {
		width: 100%;
		max-width: 420px;
		padding: 28px clamp(20px, 4vw, 32px) 24px;
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 96%, transparent);
		border: 1px solid var(--ws-hair);
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset,
			0 24px 70px -36px color-mix(in srgb, var(--color-ws-bg) 92%, transparent);
		backdrop-filter: blur(6px);
	}

	.auth-card-head {
		display: grid;
		gap: 6px;
		margin-bottom: 20px;
	}
	.auth-card-head h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 800;
		letter-spacing: -0.01em;
		color: var(--color-ws-ink);
	}
	.auth-card-head p {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--color-ws-text);
	}

	.auth-card-body {
		display: grid;
		gap: 14px;
	}

	.auth-foot {
		font-size: 13px;
		color: var(--color-ws-text);
		text-align: center;
	}
	.auth-foot :global(a) {
		color: var(--color-ws-ink);
		font-weight: 600;
		text-decoration: none;
		border-bottom: 1px dashed color-mix(in srgb, var(--color-ws-line) 32%, transparent);
	}
	.auth-foot :global(a:hover) {
		border-bottom-color: var(--color-ws-accent);
		color: var(--color-ws-accent);
	}

	/* Decorative side glow — purely visual, hidden from a11y tree. */
	.auth-side {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		opacity: 0.8;
	}
	.auth-side-grad {
		position: absolute;
		inset: 0;
		background: radial-gradient(800px 360px at 50% 100%, color-mix(in srgb, var(--color-ws-accent) 8%, transparent), transparent 60%);
	}
	.auth-side-blob {
		position: absolute;
		filter: blur(80px);
		opacity: 0.55;
		border-radius: 999px;
	}
	.auth-side-blob-a {
		top: -120px;
		right: -120px;
		width: 360px;
		height: 360px;
		background: color-mix(in srgb, var(--color-ws-violet) 35%, transparent);
	}
	.auth-side-blob-b {
		bottom: -180px;
		left: -120px;
		width: 360px;
		height: 360px;
		background: color-mix(in srgb, var(--color-ws-cyan) 22%, transparent);
	}

	/* Light theme opt-in. The app ships dark-first (`<html data-theme="dark">`);
	   when a user flips to light we tone the surfaces up but keep the same layout. */
	:global(html[data-theme="light"]) .auth-shell {
		background:
			radial-gradient(1200px 600px at 80% -10%, color-mix(in srgb, var(--color-ws-violet) 8%, transparent), transparent 60%),
			color-mix(in srgb, var(--color-ws-ink) 96%, var(--color-ws-bg));
		color: var(--color-ws-bg);
	}
	:global(html[data-theme="light"]) .auth-card {
		background: var(--color-ws-ink);
		border-color: color-mix(in srgb, var(--color-ws-bg) 10%, transparent);
		box-shadow: 0 18px 50px -30px color-mix(in srgb, var(--color-ws-bg) 22%, transparent);
	}
	:global(html[data-theme="light"]) .auth-card-head h1 { color: var(--color-ws-bg); }
	:global(html[data-theme="light"]) .auth-card-head p { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .auth-brand {
		background: color-mix(in srgb, var(--color-ws-bg) 5%, transparent);
		border-color: color-mix(in srgb, var(--color-ws-bg) 10%, transparent);
		color: var(--color-ws-bg);
	}
	:global(html[data-theme="light"]) .auth-foot { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }

	.auth-lang {
		margin-left: auto;
	}
</style>
