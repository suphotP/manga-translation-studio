<script lang="ts">
	import { _ } from "$lib/i18n";

	// $_ returns the key itself on a miss / before init, so fall back to the
	// English source string in that case (keys live in all 5 locale files).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const acceptedKeys = $derived([
		t("tools.acceptedKey0", "pageIndex: 0-based page number"),
		t("tools.acceptedKey1", "targetPageIndex: the page in the job that should receive the chosen JSON page"),
		t("tools.acceptedKey2", "sourcePageIndex/sourcePageNumber: pick one JSON page from a large file"),
		t("tools.acceptedKey3", "sourceImagePath/sourceImageName: pick one source image from a large JSON"),
		t("tools.acceptedKey4", "pageNumber or page: 1-based page number"),
		t("tools.acceptedKey5", "imageId, imageName, fileName, filename: match the page/image by exact match"),
		t("tools.acceptedKey6", "image_path, imagePath, path: match safely from the filename tail"),
		t("tools.acceptedKey7", "a top-level pageIndex or image_path can be a fallback for entries/items"),
	]);

	const supportedFields = $derived([
		t("tools.supportedField0", "entries or items: the list of text regions to import"),
		t("tools.supportedField1", "translated_text, translation, thai, targetText"),
		t("tools.supportedField2", "original_text, sourceText, source_text, text"),
		t("tools.supportedField3", "bbox: [x, y, width, height]"),
		t("tools.supportedField4", "box: [x1, y1, x2, y2]"),
		t("tools.supportedField5", "category or cat: dialogue, sfx, credit, note"),
		t("tools.supportedField6", "confidence: a value from 0 to 1"),
		t("tools.supportedField7", "rotation or angle: degrees"),
		t("tools.supportedField8", "protected: true for a credit or note that shouldn't be edited"),
	]);

	const importChecks = $derived([
		t("tools.importCheck0", "Use the source image's pixels for bbox, not the preview or browser CSS pixels"),
		t("tools.importCheck1", "Use pageIndex/pageNumber when you know the page order in the chapter"),
		t("tools.importCheck2", "Use imageName/fileName/image_path when importing a long chapter from an image folder"),
		t("tools.importCheck3", "If importing a single image from a whole-chapter JSON, choose the page in the JSON and match it to the current image"),
		t("tools.importCheck4", "If the image identifier doesn't match the open job, that entry is skipped"),
		t("tools.importCheck5", "Always double-check the import, since bbox from external OCR/AI is a draft position"),
	]);

	const quickSteps = $derived([
		{
			step: "1",
			title: t("tools.step1Title", "Choose a chapter"),
			detail: t("tools.step1Detail", "Open the library and pick the title, language, and chapter that should receive the text"),
		},
		{
			step: "2",
			title: t("tools.step2Title", "Import JSON"),
			detail: t("tools.step2Detail", "Drop or choose a JSON file; the system matches pages and creates draft text layers"),
		},
		{
			step: "3",
			title: t("tools.step3Title", "Review on the page"),
			detail: t("tools.step3Detail", "Check bbox, text, credits, and AI/QC results before exporting"),
		},
	]);

	// Illustrative JSON snippets shown in <pre> blocks. The bracketed VALUES are
	// localized sample content (so a JA/KO/… reader sees an example in their
	// language); the JSON FIELD NAMES stay ASCII because they are the literal
	// import schema. $derived so the samples re-render when the locale changes.
	const sampleSourceText = $derived(t("tools.sampleSourceText", "Source text"));
	const sampleTranslatedText = $derived(t("tools.sampleTranslatedText", "Translation"));
	const sampleSfxSource = $derived(t("tools.sampleSfxSource", "SFX source"));
	const sampleSfxTranslation = $derived(t("tools.sampleSfxTranslation", "SFX translation"));

	const example = $derived(`{
  "version": 1,
  "entries": [
    {
      "image_path": "chapter-01/page-003.webp",
      "bbox": [148, 220, 310, 96],
      "original_text": "${sampleSourceText}",
      "translated_text": "${sampleTranslatedText}",
      "category": "dialogue",
      "confidence": 0.92
    },
    {
      "pageNumber": 4,
      "box": [80, 130, 260, 210],
      "text": "${sampleSfxSource}",
      "translation": "${sampleSfxTranslation}",
      "category": "sfx",
      "rotation": -8
    }
  ]
}`);

	const p104Example = $derived(`{
  "entries": [
    {
      "image_path": "C:\\\\manga-work\\\\p104\\\\image-003.webp",
      "bbox": [72, 118, 310, 96],
      "original_text": "${sampleSourceText}",
      "translated_text": "${sampleTranslatedText}",
      "category": "dialogue"
    },
    {
      "fileName": "image-004.webp",
      "bbox": [140, 420, 260, 120],
      "text": "${sampleSfxSource}",
      "targetText": "${sampleSfxTranslation}",
      "cat": "sfx",
      "rotation": -6
    }
  ]
}`);

	const partialChapterExample = $derived(`{
  "targetPageIndex": 0,
  "sourcePageNumber": 5,
  "entries": [
    {
      "pageNumber": 5,
      "bbox": [72, 118, 310, 96],
      "original_text": "${sampleSourceText}",
      "translated_text": "${sampleTranslatedText}",
      "category": "dialogue"
    }
  ]
}`);
</script>

<svelte:head>
	<title>{t("tools.importMeta", "JSON import guide")} - Manga Editor</title>
</svelte:head>

<main class="guide-shell ws-sans">
	<header class="guide-header">
		<a href="/tools" class="back-link ws-btn-ghost">&lt; {t("tools.importBack", "Tools")}</a>
		<div>
			<p class="eyebrow">{t("tools.importEyebrow", "Import rules")}</p>
			<h1>{t("tools.importTitle", "Import JSON as editable text layers")}</h1>
			<p class="summary">
				{t("tools.importSummary", "Use this format when OCR, an AI layout tool, or an external translation team sends draft text positions. Imported text layers are an editable starting point, not a final result to trust right away.")}
			</p>
			<div class="hero-actions" aria-label={t("tools.importHeroAria", "JSON import shortcuts")}>
				<a class="primary-action ws-grad-primary" href="/library">{t("tools.importChooseChapter", "Choose a chapter to import")}</a>
				<a class="ws-btn-ghost" href="#json-example">{t("tools.importViewExample", "See a JSON example")}</a>
			</div>
		</div>
	</header>

	<section class="workflow-strip" aria-label={t("tools.importStepsAria", "JSON import steps")}>
		{#each quickSteps as item (item.step)}
			<article class="ws-panel">
				<span>{item.step}</span>
				<div>
					<h2>{item.title}</h2>
					<p>{item.detail}</p>
				</div>
			</article>
		{/each}
	</section>

	<section class="guide-grid">
		<article class="guide-panel primary ws-panel">
			<p class="eyebrow">{t("tools.importKeyRuleEyebrow", "Key rule")}</p>
			<h2>{t("tools.importKeyRuleTitle", "Use source-image coordinates and let the system build a draft layer")}</h2>
			<p>
				{t("tools.importKeyRuleBody", "Good JSON must say clearly which page the text is on, and bbox must be measured from the source image's pixels. If the system can't match a page, that entry is skipped to avoid placing it on the wrong page.")}
			</p>
			<div class="coordinate-grid compact">
				<div>
					<strong>{t("tools.coordBbox", "bbox")}</strong>
					<span>{t("tools.coordBboxVal", "[x, y, width, height]")}</span>
				</div>
				<div>
					<strong>{t("tools.coordBox", "box")}</strong>
					<span>{t("tools.coordBoxVal", "[x1, y1, x2, y2]")}</span>
				</div>
			</div>
		</article>

		<details class="guide-panel ws-panel">
			<summary>
				<span>{t("tools.matchSummarySpan", "Page-matching rules")}</span>
				<strong>{t("tools.matchSummaryStrong", "Field order the system uses")}</strong>
				<span class="toggle-pill ws-panel-quiet"><span class="open-label">{t("tools.detailsOpen", "Open")}</span><span class="close-label">{t("tools.detailsClose", "Close")}</span></span>
			</summary>
			<ol>
				{#each acceptedKeys as item (item)}
					<li>{item}</li>
				{/each}
			</ol>
		</details>

		<details class="guide-panel ws-panel">
			<summary>
				<span>{t("tools.fieldsSummarySpan", "Supported fields")}</span>
				<strong>{t("tools.fieldsSummaryStrong", "Text, bbox, category, credit")}</strong>
				<span class="toggle-pill ws-panel-quiet"><span class="open-label">{t("tools.detailsOpen", "Open")}</span><span class="close-label">{t("tools.detailsClose", "Close")}</span></span>
			</summary>
			<ul class="field-list">
				{#each supportedFields as field (field)}
					<li>{field}</li>
				{/each}
			</ul>
		</details>

		<article class="guide-panel warning ws-panel">
			<h2>{t("tools.draftPolicyTitle", "Draft layer policy")}</h2>
			<p>
				{t("tools.draftPolicyBody1", "bbox from OCR/AI can be off, so Manga Editor imports text as a movable, resizable layer with conservative auto-fit so you can fix position, font, and wording fast.")}
			</p>
			<p>
				{@html t("tools.draftPolicyBody2", "Credit layers should use {protectedCode}. A protected credit stays visible but is treated as attribution content that shouldn't be edited by accident.").replace("{protectedCode}", "<code>protected: true</code>")}
			</p>
		</article>

		<details class="guide-panel ws-panel" open>
			<summary>
				<span>{t("tools.checksSummarySpan", "Pre-import checks")}</span>
				<strong>{t("tools.checksSummaryStrong", "Keep text off the wrong page")}</strong>
				<span class="toggle-pill ws-panel-quiet"><span class="open-label">{t("tools.detailsOpen", "Open")}</span><span class="close-label">{t("tools.detailsClose", "Close")}</span></span>
			</summary>
			<ul class="field-list">
				{#each importChecks as check (check)}
					<li>{check}</li>
				{/each}
			</ul>
		</details>
	</section>

	<section id="json-example" class="example-section ws-panel">
		<div>
			<p class="eyebrow">{t("tools.exampleEyebrow", "Recommended format")}</p>
			<h2>{t("tools.exampleTitle", "Multi-page JSON example")}</h2>
		</div>
		<pre class="ws-panel-quiet"><code>{example}</code></pre>
	</section>

	<section class="example-section ws-panel">
		<div>
			<p class="eyebrow">{t("tools.folderEyebrow", "Import from a folder")}</p>
			<h2>{t("tools.folderTitle", "Path and filename example from Windows")}</h2>
			<p>
				{t("tools.folderBody", "The importer only compares the safe filename tail, so paths from a local tool still match pages in the project without trusting the whole directory.")}
			</p>
		</div>
		<pre class="ws-panel-quiet"><code>{p104Example}</code></pre>
	</section>

	<section class="example-section ws-panel">
		<div>
				<p class="eyebrow">{t("tools.partialEyebrow", "Some pages in a chapter")}</p>
				<h2>{t("tools.partialTitle", "Match page 5 in the JSON to a single uploaded image")}</h2>
				<p>
					{t("tools.partialBody", "If the job has fewer images than the JSON file, the page editor asks which page in the JSON should map to the current image. The fields below let a script state this mapping directly.")}
				</p>
		</div>
		<pre class="ws-panel-quiet"><code>{partialChapterExample}</code></pre>
	</section>
</main>

<style>
	.guide-shell {
		min-height: 100vh;
		background:
			radial-gradient(900px 420px at 78% -8%, color-mix(in srgb, var(--color-ws-accent) 10%, transparent), transparent 60%),
			var(--color-ws-bg);
		color: var(--color-ws-ink);
		padding: 32px;
		font-family: var(--font-ws-sans);
	}

	.guide-header {
		display: grid;
		grid-template-columns: 160px minmax(0, 880px);
		gap: 32px;
		align-items: start;
		max-width: 1180px;
		margin: 0 auto 28px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 13px;
		font-weight: 800;
		padding: 0 12px;
		text-decoration: none;
	}

	.hero-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 18px;
	}

	.hero-actions a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		padding: 0 16px;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
		text-decoration: none;
	}

	.hero-actions .primary-action {
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		color: var(--color-ws-ink);
	}

	.back-link:hover {
		color: var(--color-ws-ink);
	}

	.eyebrow {
		margin: 0 0 8px;
		color: var(--color-ws-amber);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin-top: 0;
	}

	h1 {
		max-width: 760px;
		margin-bottom: 12px;
		font-size: 34px;
		font-weight: 900;
		line-height: 1.08;
		letter-spacing: 0;
	}

	h2 {
		margin-bottom: 10px;
		font-size: 15px;
		font-weight: 800;
		letter-spacing: 0;
	}

	.summary,
	.guide-panel p,
	.example-section p,
	.workflow-strip p {
		color: var(--color-ws-text);
		font-size: 14px;
		line-height: 1.6;
	}

	.workflow-strip {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		max-width: 1180px;
		margin: 0 auto 12px;
	}

	.workflow-strip article {
		display: grid;
		grid-template-columns: 38px minmax(0, 1fr);
		gap: 12px;
		align-items: start;
		border-radius: var(--radius-ws-card);
		padding: 16px;
	}

	.workflow-strip span {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
	}

	.workflow-strip h2 {
		margin-bottom: 4px;
	}

	.workflow-strip p {
		margin-bottom: 0;
		font-size: 13px;
	}

	.guide-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		max-width: 1180px;
		margin: 0 auto;
	}

	.guide-panel,
	.example-section {
		border-radius: var(--radius-ws-card);
		padding: 18px;
	}

	.guide-panel.primary {
		grid-row: span 2;
	}

	.guide-panel.warning {
		border-color: color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface) 88%, var(--color-ws-amber) 12%);
	}

	details.guide-panel {
		padding: 0;
	}

	details.guide-panel summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		min-height: 58px;
		padding: 14px 18px;
		cursor: pointer;
		list-style: none;
	}

	details.guide-panel summary::-webkit-details-marker {
		display: none;
	}

	details.guide-panel summary span {
		color: var(--color-ws-cyan);
		font-size: 12px;
		font-weight: 800;
	}

	details.guide-panel summary strong {
		color: var(--color-ws-ink);
		font-size: 14px;
	}

	details.guide-panel summary .toggle-pill {
		flex: 0 0 auto;
		border-radius: 999px;
		padding: 5px 10px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 800;
	}

	/* The pill shows "open" when collapsed and "close" when expanded. */
	details.guide-panel summary .toggle-pill .close-label {
		display: none;
	}

	details.guide-panel[open] summary .toggle-pill .open-label {
		display: none;
	}

	details.guide-panel[open] summary .toggle-pill .close-label {
		display: inline;
	}

	details.guide-panel[open] summary .toggle-pill {
		color: var(--color-ws-ink);
		border-color: color-mix(in srgb, var(--color-ws-accent) 38%, transparent);
	}

	details.guide-panel[open] {
		padding-bottom: 16px;
	}

	details.guide-panel[open] summary {
		border-bottom: 1px solid var(--ws-hair);
		margin-bottom: 14px;
	}

	details.guide-panel ol,
	details.guide-panel .field-list {
		padding-right: 18px;
	}

	ol,
	.field-list {
		margin: 0;
		padding-left: 20px;
		color: var(--color-ws-ink);
		font-size: 13px;
		line-height: 1.7;
	}

	.coordinate-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		margin-top: 14px;
	}

	.coordinate-grid.compact {
		margin-top: 16px;
	}

	.coordinate-grid div {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		padding: 12px;
		background: var(--color-ws-bg);
	}

	.coordinate-grid strong,
	.coordinate-grid span {
		display: block;
		font-size: 12px;
	}

	.coordinate-grid span {
		margin-top: 4px;
		color: var(--color-ws-text);
	}

	code {
		color: var(--color-ws-amber);
	}

	.example-section {
		display: grid;
		grid-template-columns: 260px minmax(0, 1fr);
		gap: 18px;
		max-width: 1180px;
		margin: 12px auto 0;
	}

	pre {
		overflow: auto;
		margin: 0;
		border-radius: var(--radius-ws-ctrl);
		padding: 14px;
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.55;
	}

	.back-link:focus-visible,
	.hero-actions a:focus-visible,
	details.guide-panel summary:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	@media (max-width: 860px) {
		.guide-shell {
			padding: 20px;
		}

		.guide-header,
		.example-section {
			grid-template-columns: 1fr;
			gap: 14px;
		}

		.workflow-strip,
		.guide-grid,
		.coordinate-grid {
			grid-template-columns: 1fr;
		}

		h1 {
			font-size: 26px;
		}
	}
</style>
