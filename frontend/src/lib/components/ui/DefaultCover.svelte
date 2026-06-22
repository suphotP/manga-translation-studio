<!-- DefaultCover - deterministic placeholder cover art for titles/chapters with no
	uploaded image. Pure inline SVG + CSS gradients (no external images). A `seed`
	string is hashed to pick one of 8 on-brand dark variants, so the same title
	always renders the same cover while different titles vary.

	Usage:
	  <DefaultCover seed={title} ratio="portrait" title={title} />
	  <DefaultCover seed={series.id} ratio="wide" />            // hero banner
	  <DefaultCover seed={chapter.id} ratio="square" />         // thumbnail
-->
<script lang="ts">
	export type CoverRatio = "portrait" | "wide" | "square";

	let {
		seed,
		ratio = "portrait",
		title = "",
		class: klass = "",
	}: {
		seed: string;
		ratio?: CoverRatio;
		title?: string;
		class?: string;
	} = $props();

	// Stable unique id per instance so multiple covers on one page never share
	// (and clobber) each other's gradient/clip <defs>.
	const uid = $props.id();

	// The 8 abstract motifs. Each is a self-contained dark composition cohesive
	// with the violet/magenta ws palette but with deliberately varied hues.
	const VARIANTS = [
		"moonrise",
		"mountains",
		"city-night",
		"waves",
		"spotlight",
		"crimson-bloom",
		"aurora",
		"starfield",
	] as const;

	// Deterministic, well-distributed string hash (FNV-1a 32-bit).
	function hash(str: string): number {
		let h = 0x811c9dc5;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	}

	let h = $derived(hash(seed ?? ""));
	let variant = $derived(VARIANTS[h % VARIANTS.length]);
	// A second, decorrelated roll for subtle within-variant accent shifts.
	let accentRoll = $derived(((h >>> 5) % 3) as 0 | 1 | 2);

	const ratioClass: Record<CoverRatio, string> = {
		portrait: "aspect-[3/4]",
		wide: "aspect-[16/9]",
		square: "aspect-square",
	};

	// Accent hue trio per variant — picked by accentRoll so two same-variant covers
	// still read as distinct without breaking the palette.
	const accents: Record<(typeof VARIANTS)[number], [string, string, string]> = {
		moonrise: ["#FDE68A", "#C4B5FD", "#F0ABFC"],
		mountains: ["#22D3EE", "#34D399", "#8FB8FF"],
		"city-night": ["#22D3EE", "#D946EF", "#FB7185"],
		waves: ["#22D3EE", "#34D399", "#8FB8FF"],
		spotlight: ["#7C5CFF", "#22D3EE", "#F0ABFC"],
		"crimson-bloom": ["#FB7185", "#FBBF24", "#F0ABFC"],
		aurora: ["#34D399", "#22D3EE", "#8B5CF6"],
		starfield: ["#C4B5FD", "#8FB8FF", "#F0ABFC"],
	};
	let accent = $derived(accents[variant][accentRoll]);
</script>

<div
	class={`relative isolate w-full overflow-hidden ${ratioClass[ratio]} ${klass}`}
	role="img"
	aria-label={title ? `${title} cover art` : "Placeholder cover art"}
>
	<svg
		viewBox="0 0 320 426"
		preserveAspectRatio="xMidYMid slice"
		class="absolute inset-0 h-full w-full"
		aria-hidden="true"
	>
		<defs>
			<!-- Per-variant background gradients -->
			<linearGradient id={`${uid}-bg-moonrise`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#1b1140" />
				<stop offset="0.55" stop-color="#3b1d63" />
				<stop offset="1" stop-color="#0d1b3a" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-mountains`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0d2540" />
				<stop offset="0.6" stop-color="#13294d" />
				<stop offset="1" stop-color="#101428" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-city`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0a0f24" />
				<stop offset="0.55" stop-color="#231347" />
				<stop offset="1" stop-color="#06060f" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-waves`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0c2a3a" />
				<stop offset="0.6" stop-color="#103a4d" />
				<stop offset="1" stop-color="#0a1320" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-spotlight`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#10131f" />
				<stop offset="0.55" stop-color="#1a1d3a" />
				<stop offset="1" stop-color="#06080f" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-crimson`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#3a0f1f" />
				<stop offset="0.6" stop-color="#511426" />
				<stop offset="1" stop-color="#1a0a14" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-aurora`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0a1b2e" />
				<stop offset="0.55" stop-color="#13303a" />
				<stop offset="1" stop-color="#0b1424" />
			</linearGradient>
			<linearGradient id={`${uid}-bg-starfield`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#161235" />
				<stop offset="0.6" stop-color="#1f1a44" />
				<stop offset="1" stop-color="#0a0916" />
			</linearGradient>

			<!-- Soft radial glows reused across motifs -->
			<radialGradient id={`${uid}-glow`} cx="0.5" cy="0.4" r="0.6">
				<stop offset="0" stop-color={accent} stop-opacity="0.5" />
				<stop offset="1" stop-color={accent} stop-opacity="0" />
			</radialGradient>
			<radialGradient id={`${uid}-moon`} cx="0.72" cy="0.3" r="0.5">
				<stop offset="0" stop-color={accent} />
				<stop offset="1" stop-color={accent} stop-opacity="0" />
			</radialGradient>
			<!-- Bottom vignette so an overlaid title always stays legible -->
			<linearGradient id={`${uid}-vignette`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0.55" stop-color="#05050c" stop-opacity="0" />
				<stop offset="1" stop-color="#05050c" stop-opacity="0.6" />
			</linearGradient>
		</defs>

		{#if variant === "moonrise"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-moonrise)`} />
			<circle cx="232" cy="120" r="74" fill={`url(#${uid}-moon)`} />
			<circle cx="232" cy="120" r="30" fill={accent} opacity="0.95" />
			<g fill="#ffffff" opacity="0.8">
				<circle cx="40" cy="64" r="1.6" /><circle cx="80" cy="40" r="1.1" />
				<circle cx="120" cy="80" r="1" /><circle cx="44" cy="150" r="1.1" />
				<circle cx="96" cy="170" r="1.3" /><circle cx="276" cy="230" r="1.2" />
				<circle cx="150" cy="48" r="0.9" /><circle cx="300" cy="96" r="1" />
			</g>
			<path d="M0 426 L0 300 q70 -42 160 0 q90 42 160 0 L320 426 Z" fill="#0a0a14" opacity="0.9" />
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "mountains"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-mountains)`} />
			<circle cx="232" cy="104" r="40" fill={accent} opacity="0.45" />
			<circle cx="232" cy="104" r="40" fill="none" stroke={accent} stroke-width="1.5" opacity="0.7" />
			<path d="M-10 360 L70 200 L130 300 L200 150 L280 290 L330 210 L330 426 L-10 426 Z" fill={accent} opacity="0.22" />
			<path d="M-10 426 L110 250 L200 360 L300 220 L330 300 L330 426 Z" fill="#06070f" opacity="0.6" />
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "city-night"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-city)`} />
			<g opacity="0.85">
				<rect x="34" y="180" width="22" height="246" fill="#0c1226" />
				<rect x="64" y="140" width="26" height="286" fill="#0a1020" />
				<rect x="98" y="210" width="20" height="216" fill="#0c1226" />
				<rect x="200" y="160" width="26" height="266" fill="#0a1020" />
				<rect x="234" y="220" width="18" height="206" fill="#0c1226" />
				<rect x="262" y="150" width="28" height="276" fill="#0a1020" />
			</g>
			<g opacity="0.9">
				<rect x="40" y="60" width="3" height="120" fill={accents[variant][0]} />
				<rect x="80" y="40" width="3" height="120" fill={accents[variant][1]} />
				<rect x="120" y="76" width="3" height="120" fill={accents[variant][2]} />
				<rect x="206" y="50" width="3" height="120" fill={accents[variant][1]} />
				<rect x="244" y="70" width="3" height="100" fill={accents[variant][0]} />
				<rect x="282" y="44" width="3" height="120" fill={accents[variant][2]} />
			</g>
			<g fill={accent} opacity="0.9">
				<rect x="46" y="200" width="4" height="4" /><rect x="74" y="240" width="4" height="4" />
				<rect x="208" y="200" width="4" height="4" /><rect x="270" y="260" width="4" height="4" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "waves"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-waves)`} />
			<circle cx="236" cy="110" r="26" fill={accents[variant][2]} opacity="0.6" />
			<g stroke={accent} stroke-width="2.5" fill="none" opacity="0.45" stroke-linecap="round">
				<path d="M-10 230 q40 -28 80 0 t80 0 t80 0 t80 0 t80 0" />
				<path d="M-10 268 q40 -28 80 0 t80 0 t80 0 t80 0 t80 0" />
				<path d="M-10 306 q40 -28 80 0 t80 0 t80 0 t80 0 t80 0" />
				<path d="M-10 344 q40 -28 80 0 t80 0 t80 0 t80 0 t80 0" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "spotlight"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-spotlight)`} />
			<rect width="320" height="426" fill={`url(#${uid}-glow)`} />
			<path d="M160 0 L96 426 L224 426 Z" fill={accent} opacity="0.16" />
			<circle cx="160" cy="150" r="46" fill={accent} opacity="0.28" />
			<circle cx="160" cy="150" r="46" fill="none" stroke={accent} stroke-width="1.5" opacity="0.6" />
			<g fill="#ffffff" opacity="0.7">
				<circle cx="60" cy="90" r="1.3" /><circle cx="264" cy="110" r="1.3" />
				<circle cx="44" cy="220" r="1" /><circle cx="288" cy="250" r="1" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "crimson-bloom"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-crimson)`} />
			<g transform="translate(160 190)">
				<path d="M0 70 C-46 18 -46 -30 0 -22 C46 -30 46 18 0 70 Z" fill={accent} opacity="0.5" />
				<path d="M0 70 C-46 18 -46 -30 0 -22 C46 -30 46 18 0 70 Z" fill="none" stroke={accent} stroke-width="1.5" opacity="0.8" />
				<path d="M0 60 C-30 26 -30 -14 0 -8 C30 -14 30 26 0 60 Z" fill={accents[variant][2]} opacity="0.4" transform="rotate(45)" />
			</g>
			<g fill={accents[variant][1]} opacity="0.7">
				<circle cx="60" cy="80" r="2" /><circle cx="256" cy="64" r="1.6" />
				<circle cx="284" cy="210" r="2" /><circle cx="44" cy="230" r="1.6" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else if variant === "aurora"}
			<rect width="320" height="426" fill={`url(#${uid}-bg-aurora)`} />
			<g fill="none" stroke-linecap="round" opacity="0.55">
				<path d="M-20 180 q90 -90 170 -20 q90 70 190 -10" stroke={accents[variant][0]} stroke-width="26" opacity="0.35" />
				<path d="M-20 230 q90 -70 170 0 q90 60 190 -20" stroke={accents[variant][1]} stroke-width="20" opacity="0.4" />
				<path d="M-20 280 q90 -50 170 10 q90 50 190 -10" stroke={accents[variant][2]} stroke-width="14" opacity="0.45" />
			</g>
			<g fill="#ffffff" opacity="0.75">
				<circle cx="48" cy="70" r="1.2" /><circle cx="110" cy="50" r="1" />
				<circle cx="250" cy="80" r="1.2" /><circle cx="300" cy="56" r="1" />
				<circle cx="70" cy="360" r="1" /><circle cx="260" cy="380" r="1.1" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{:else}
			<!-- starfield -->
			<rect width="320" height="426" fill={`url(#${uid}-bg-starfield)`} />
			<circle cx="160" cy="170" r="120" fill={`url(#${uid}-glow)`} />
			<g fill="#ffffff">
				<circle cx="40" cy="60" r="1.6" opacity="0.9" /><circle cx="92" cy="40" r="1" opacity="0.7" />
				<circle cx="150" cy="70" r="1.3" opacity="0.85" /><circle cx="210" cy="44" r="1" opacity="0.7" />
				<circle cx="272" cy="74" r="1.5" opacity="0.9" /><circle cx="300" cy="120" r="1.1" opacity="0.75" />
				<circle cx="36" cy="150" r="1.2" opacity="0.8" /><circle cx="120" cy="180" r="1" opacity="0.65" />
				<circle cx="248" cy="200" r="1.4" opacity="0.85" /><circle cx="60" cy="250" r="1" opacity="0.7" />
				<circle cx="188" cy="280" r="1.2" opacity="0.8" /><circle cx="284" cy="300" r="1" opacity="0.65" />
				<circle cx="100" cy="330" r="1.3" opacity="0.8" /><circle cx="220" cy="360" r="1" opacity="0.7" />
			</g>
			<g fill={accent} opacity="0.9">
				<path d="M160 96 l4 18 18 4 -18 4 -4 18 -4 -18 -18 -4 18 -4 z" />
			</g>
			<rect width="320" height="426" fill={`url(#${uid}-vignette)`} />
		{/if}

		<!-- micro-gloss highlight (matches the mockups' .gloss) -->
		<path d="M0 0 L320 0 L320 180 Z" fill="#ffffff" opacity="0.06" />
	</svg>

	{#if title}
		<div class="absolute inset-x-0 bottom-0 z-10 p-3">
			<p class="ws-sans line-clamp-2 text-[13px] font-semibold leading-tight text-white/95 drop-shadow">
				{title}
			</p>
		</div>
	{/if}
</div>
