<!--
  Shared layout for in-app marketing/legal pages (Terms, Privacy, About).
  Lightweight, no workspace chrome. Provides a consistent header, readable
  content column, and a footer with legal links + a "Cookie settings" re-open
  link that dispatches the global event the CookieConsent banner listens for.
-->
<script lang="ts">
	let { children } = $props();

	function openCookieSettings() {
		window.dispatchEvent(new CustomEvent("comic-workspace:open-cookie-settings"));
	}
</script>

<div class="legal-shell">
	<header class="legal-header">
		<a class="legal-brand" href="/about">
			<span class="legal-mark" aria-hidden="true">◆</span>
			<span>Comic Workspace</span>
		</a>
		<nav class="legal-nav" aria-label="Marketing and legal navigation">
			<a href="/about">About</a>
			<a href="/terms">Terms</a>
			<a href="/privacy">Privacy</a>
			<a class="legal-cta" href="/dashboard">Open workspace</a>
		</nav>
	</header>

	<main class="legal-main">
		{@render children()}
	</main>

	<footer class="legal-footer">
		<div class="legal-footer-inner">
			<p class="legal-copy">© {new Date().getFullYear()} Comic Workspace. All rights reserved.</p>
			<nav class="legal-footer-links" aria-label="Footer">
				<a href="/terms">Terms of Service</a>
				<a href="/privacy">Privacy Policy</a>
				<button type="button" class="legal-cookie-link" onclick={openCookieSettings}>
					Cookie settings
				</button>
			</nav>
		</div>
	</footer>
</div>

<style>
	.legal-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background:
			radial-gradient(circle at 8% 0%, rgba(124, 92, 255, 0.12), transparent 42%),
			radial-gradient(circle at 92% 6%, rgba(34, 211, 238, 0.1), transparent 42%),
			#0b0b0f;
		color: #ececf2;
		font-family: "Inter", "Noto Sans Thai", system-ui, -apple-system, sans-serif;
	}

	.legal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 18px clamp(16px, 5vw, 48px);
		border-bottom: 1px solid rgba(255, 255, 255, 0.07);
		flex-wrap: wrap;
	}

	.legal-brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 700;
		font-size: 15px;
		color: #ececf2;
		text-decoration: none;
	}

	.legal-mark {
		color: #8b5cf6;
	}

	.legal-nav {
		display: flex;
		align-items: center;
		gap: clamp(12px, 2.5vw, 24px);
		font-size: 13.5px;
		flex-wrap: wrap;
	}

	.legal-nav a {
		color: #9a9aa8;
		text-decoration: none;
	}

	.legal-nav a:hover {
		color: #ececf2;
	}

	.legal-cta {
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 10px;
		padding: 7px 14px;
		color: #ececf2 !important;
		background: rgba(255, 255, 255, 0.06);
	}

	.legal-main {
		flex: 1;
		width: 100%;
		max-width: 880px;
		margin: 0 auto;
		padding: clamp(24px, 5vw, 56px) clamp(16px, 5vw, 48px);
	}

	.legal-footer {
		border-top: 1px solid rgba(255, 255, 255, 0.07);
		padding: 22px clamp(16px, 5vw, 48px);
	}

	.legal-footer-inner {
		max-width: 880px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.legal-copy {
		margin: 0;
		font-size: 12.5px;
		color: #6b6b78;
	}

	.legal-footer-links {
		display: flex;
		align-items: center;
		gap: 18px;
		font-size: 12.5px;
		flex-wrap: wrap;
	}

	.legal-footer-links a,
	.legal-cookie-link {
		color: #9a9aa8;
		text-decoration: none;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}

	.legal-footer-links a:hover,
	.legal-cookie-link:hover {
		color: #ececf2;
	}

	.legal-cookie-link:focus-visible,
	.legal-footer-links a:focus-visible {
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}
</style>
