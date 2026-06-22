<!-- Tools index page - standalone quick tools -->
<script lang="ts">
	import ToolCard from "$lib/components/tools/ToolCard.svelte";
	import { _ } from "$lib/i18n";

	// $_ returns the key itself on a miss / before init, so fall back to the
	// English source string in that case (keys live in all 5 locale files).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<svelte:head>
	<title>{t("tools.metaHub", "Quick tools")} - Manga Editor</title>
</svelte:head>

<div class="tools-page ws-sans">
	<header class="tools-header">
		<a class="back-link ws-btn-ghost" href="/">&lt; {t("tools.hubBack", "Home")}</a>
		<div>
			<p class="eyebrow">{t("tools.hubEyebrow", "Short tasks")}</p>
			<h1>{t("tools.hubTitle", "Quick tools")}</h1>
			<p>{t("tools.hubIntro", "Use these for a single task — try a translation, clean an image, or prep JSON without setting up a full project.")}</p>
		</div>
		<a class="library-link ws-grad-primary" href="/library">{t("tools.hubLibraryLink", "Open full work in the library")}</a>
	</header>

	<section class="tools-note ws-panel-quiet" aria-label={t("tools.hubNoteAria", "How to choose a tool")}>
		<strong>{t("tools.hubNoteStrong", "Pick a shortcut when you have a single file or want a fast test.")}</strong>
		<span>{t("tools.hubNoteSpan", "For long chapters, multiple languages, or credits/QC, start from the library instead.")}</span>
	</section>

	<div class="tools-grid">
		<ToolCard
			title={t("tools.cardTranslateTitle", "Quick translate")}
			description={t("tools.cardTranslateDesc", "Upload, crop, and translate a manga page fast without setting up a project")}
			icon={t("tools.cardTranslateIcon", "Translate")}
			href="/tools/translate"
			color="var(--color-ws-blue)"
		/>
		<ToolCard
			title={t("tools.cardCleanTitle", "Quick clean")}
			description={t("tools.cardCleanDesc", "Remove dust, scan marks, or stray bits on a manga page with a brush")}
			icon={t("tools.cardCleanIcon", "Clean")}
			href="/tools/clean"
			color="var(--color-ws-green)"
		/>
		<ToolCard
			title={t("tools.cardImportTitle", "JSON import guide")}
			description={t("tools.cardImportDesc", "Pick a chapter, prep bbox, and bring OCR/layout JSON in as editable text layers")}
			icon={t("tools.cardImportIcon", "JSON")}
			href="/tools/import-json"
			color="var(--color-ws-amber)"
		/>
	</div>
</div>

<style>
	.tools-page {
		min-height: 100vh;
		background:
			radial-gradient(900px 420px at 76% -8%, color-mix(in srgb, var(--color-ws-accent) 10%, transparent), transparent 60%),
			var(--color-ws-bg);
		color: var(--color-ws-ink);
		padding: 32px;
		font-family: var(--font-ws-sans);
	}

	.tools-header {
		display: grid;
		grid-template-columns: 140px minmax(0, 1fr) auto;
		gap: 24px;
		align-items: start;
		max-width: 1040px;
		margin: 0 auto 18px;
	}

	.back-link,
	.library-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
		text-decoration: none;
	}

	.back-link {
		justify-content: flex-start;
		color: var(--color-ws-text);
		padding: 0 12px;
	}

	.library-link {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		padding: 0 16px;
		color: var(--color-ws-ink);
	}

	.eyebrow {
		margin: 0 0 8px;
		color: var(--color-ws-violet);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.tools-header h1 {
		margin: 0 0 8px;
		color: var(--color-ws-ink);
		font-size: 34px;
		font-weight: 900;
		line-height: 1.08;
	}

	.tools-header p {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 14px;
		line-height: 1.55;
	}

	.tools-note {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		align-items: center;
		max-width: 1040px;
		margin: 0 auto 18px;
		border-radius: var(--radius-ws-card);
		padding: 14px 16px;
	}

	.tools-note strong {
		color: var(--color-ws-ink);
		font-size: 14px;
	}

	.tools-note span {
		color: var(--color-ws-text);
		font-size: 13px;
	}

	.tools-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 16px;
		max-width: 1040px;
		margin: 0 auto;
	}

	.tools-grid :global(.tool-card) {
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: none;
	}

	.tools-grid :global(.tool-card:hover) {
		background: var(--color-ws-surface2);
		box-shadow: none;
		transform: translateY(-1px);
	}

	.tools-grid :global(.tool-icon) {
		border: 1px solid color-mix(in srgb, var(--card-color) 34%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--card-color) 16%, transparent);
	}

	.tools-grid :global(.tool-title) {
		color: var(--color-ws-ink);
		font-weight: 800;
	}

	.tools-grid :global(.tool-description) {
		color: var(--color-ws-text);
	}

	@media (max-width: 640px) {
		.tools-page {
			padding: 24px 16px;
		}

		.tools-header h1 {
			font-size: 24px;
		}

		.tools-header {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		.back-link,
		.library-link {
			justify-content: center;
			width: 100%;
		}

		.tools-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
