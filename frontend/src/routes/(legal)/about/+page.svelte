<script lang="ts">
	const features = [
		{
			title: "Role-based collaboration",
			body: "Translate, clean, typeset, QC and review in clearly scoped lanes — each teammate sees only the work that is theirs.",
		},
		{
			title: "AI-assisted, human-controlled",
			body: "Translation suggestions, text detection and cleanup speed up the grind; you review every result before it ships.",
		},
		{
			title: "Per-language pipelines",
			body: "Run a title in several target languages at once, with per-language progress, preview and export.",
		},
		{
			title: "A real editor when you need it",
			body: "A Fabric-based canvas for page, text and brush work — opened only when there is page-level work to do.",
		},
	];
</script>

<svelte:head>
	<title>Comic Workspace — collaborative manga &amp; webtoon translation</title>
	<meta
		name="description"
		content="Comic Workspace is a collaborative workspace for translating, cleaning, typesetting and reviewing manga, manhwa and webtoons — with AI assistance you stay in control of."
	/>
</svelte:head>

<section class="about-hero">
	<p class="about-eyebrow">Manga · Manhwa · Manhua · Webtoon</p>
	<h1>The collaborative workspace for comic translation.</h1>
	<p class="about-lede">
		Bring translators, cleaners, typesetters and reviewers into one place. Keep every chapter, language and task
		on one clear path — with AI assistance that you stay in control of.
	</p>
	<div class="about-cta">
		<a class="about-btn about-btn-primary" href="/dashboard">Open the workspace</a>
		<a class="about-btn about-btn-ghost" href="/terms">Read the terms</a>
	</div>
</section>

<section class="about-features" aria-label="What Comic Workspace does">
	{#each features as feature (feature.title)}
		<div class="about-feature">
			<h2>{feature.title}</h2>
			<p>{feature.body}</p>
		</div>
	{/each}
</section>

<section class="about-foot-note">
	<p>
		Looking for the product? <a href="/dashboard">Jump straight into your workspace</a>. By using Comic
		Workspace you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.
	</p>
</section>

<style>
	.about-hero {
		text-align: center;
		padding: clamp(12px, 4vw, 36px) 0 clamp(28px, 5vw, 48px);
	}

	.about-eyebrow {
		font-size: 12.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #8b5cf6;
		margin: 0 0 14px;
	}

	.about-hero h1 {
		font-size: clamp(30px, 6vw, 46px);
		font-weight: 800;
		letter-spacing: -0.02em;
		line-height: 1.08;
		margin: 0 auto 16px;
		max-width: 14ch;
	}

	.about-lede {
		font-size: clamp(15px, 2.4vw, 17px);
		line-height: 1.6;
		color: #9a9aa8;
		max-width: 56ch;
		margin: 0 auto;
	}

	.about-cta {
		display: flex;
		gap: 12px;
		justify-content: center;
		flex-wrap: wrap;
		margin-top: 26px;
	}

	.about-btn {
		min-height: 46px;
		display: inline-flex;
		align-items: center;
		padding: 0 22px;
		border-radius: 12px;
		font-size: 14.5px;
		font-weight: 600;
		text-decoration: none;
		border: 1px solid transparent;
	}

	.about-btn-primary {
		background: linear-gradient(135deg, #8b5cf6, #d946ef);
		color: #fff;
	}

	.about-btn-ghost {
		border-color: rgba(255, 255, 255, 0.16);
		background: rgba(255, 255, 255, 0.06);
		color: #ececf2;
	}

	.about-btn:focus-visible {
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}

	.about-features {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 16px;
		margin-top: 8px;
	}

	.about-feature {
		border: 1px solid rgba(255, 255, 255, 0.07);
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.02);
		padding: 20px;
	}

	.about-feature h2 {
		font-size: 16px;
		font-weight: 700;
		color: #ececf2;
		margin: 0 0 8px;
	}

	.about-feature p {
		font-size: 13.5px;
		line-height: 1.55;
		color: #9a9aa8;
		margin: 0;
	}

	.about-foot-note {
		margin-top: 36px;
		text-align: center;
		font-size: 13px;
		color: #6b6b78;
	}

	.about-foot-note a {
		color: #8fb8ff;
		text-decoration: underline;
	}
</style>
