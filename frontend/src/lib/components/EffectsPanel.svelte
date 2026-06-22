<!-- EffectsPanel: text layer effects controls. -->
<script lang="ts">
	import type { TextLayer, TextLayerEffects } from "$lib/types.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { _ } from "$lib/i18n";

	let strokeEnabled = $state(false);
	let strokeColor = $state("#ffffff");
	let strokeWidth = $state(2);

	let glowEnabled = $state(false);
	let glowColor = $state("#ffcc00");
	let glowBlur = $state(10);
	let glowOpacity = $state(80);

	let shadowEnabled = $state(false);
	let shadowColor = $state("#000000");
	let shadowOffsetX = $state(3);
	let shadowOffsetY = $state(3);
	let shadowBlur = $state(5);
	let shadowOpacity = $state(50);
	let shapeSkewX = $state(0);
	let shapeSkewY = $state(0);
	let accentShadows = $state<NonNullable<TextLayerEffects["accentShadows"]>>([]);
	let effectPasses = $state<NonNullable<TextLayerEffects["passes"]>>([]);

	// Track previous layer to detect selection changes.
	let prevLayerId: string | undefined = $state(undefined);
	let prevLayerEffectSignature = $state("");
	let advancedOpen = $state(false);
	type EffectPresetId = "readable" | "dungeon" | "curse" | "haunt" | "scream" | "romance";
	let selectedPresetId = $state<EffectPresetId>("readable");
	let activeEffectCount = $derived([strokeEnabled, glowEnabled, shadowEnabled, accentShadows.length > 0, effectPasses.length > 0].filter(Boolean).length);
	let activeLightEffectLabel = $derived(glowEnabled && shadowEnabled ? $_("effectsPanel.lightGlowShadow") : shadowEnabled ? $_("effectsPanel.lightShadow") : glowEnabled ? $_("effectsPanel.lightGlow") : $_("effectsPanel.lightNone"));
	let effectSummaryLabel = $derived(activeEffectCount ? $_("effectsPanel.layersOpen", { values: { n: activeEffectCount } }) : $_("effectsPanel.noEffectsYet"));
	let previewText = $derived(editorStore.selectedLayer?.text?.trim() || "Aa");
	let previewFontFamily = $derived(cssPreviewFontFamily(editorStore.selectedLayer?.fontFamily));
	let previewFontSize = $derived(Math.round(boundedNumber(editorStore.selectedLayer?.fontSize, 18, 44, 32)));
	let previewLetterSpacing = $derived(`${Math.round(((editorStore.selectedLayer?.charSpacing ?? 0) / 1000) * previewFontSize * 10) / 10}px`);
	let previewSkewX = $derived(boundedNumber(editorStore.selectedLayer?.skewX ?? 0, -45, 45, 0));
	let previewSkewY = $derived(boundedNumber(editorStore.selectedLayer?.skewY ?? 0, -45, 45, 0));
	let safeStrokeMax = $derived(Math.max(1, Math.min(24, Math.round((editorStore.selectedLayer?.fontSize ?? 24) * 0.25))));
	let previewStrokeMax = $derived(Math.max(1, Math.round(previewFontSize * 0.14)));
	let previewPassStrokeMax = $derived(Math.max(1, Math.round(previewFontSize * 0.22)));
	function colorWithOpacity(color: string, opacity: number): string {
		const clampedOpacity = boundedNumber(opacity, 0, 100, 100) / 100;
		if (/^#[0-9a-f]{6}$/i.test(color)) {
			const r = Number.parseInt(color.slice(1, 3), 16);
			const g = Number.parseInt(color.slice(3, 5), 16);
			const b = Number.parseInt(color.slice(5, 7), 16);
			return `rgba(${r}, ${g}, ${b}, ${clampedOpacity})`;
		}
		return color;
	}

	let previewTextShadow = $derived([
		glowEnabled ? `0 0 ${boundedNumber(glowBlur, 0, 120, 10)}px ${colorWithOpacity(glowColor, glowOpacity)}` : "",
		...accentShadows
			.filter((entry) => entry.enabled)
			.slice(0, 4)
			.map((entry) => `${boundedNumber(entry.offsetX, -80, 80, 0)}px ${boundedNumber(entry.offsetY, -80, 80, 0)}px ${boundedNumber(entry.blur, 0, 120, 0)}px ${colorWithOpacity(entry.color ?? "#ffffff", entry.opacity ?? 100)}`),
		shadowEnabled ? `${boundedNumber(shadowOffsetX, -80, 80, 3)}px ${boundedNumber(shadowOffsetY, -80, 80, 3)}px ${boundedNumber(shadowBlur, 0, 120, 5)}px ${colorWithOpacity(shadowColor, shadowOpacity)}` : "",
	].filter(Boolean).join(", ") || "none");

	let previewPassStyles = $derived(effectPasses
		.filter((entry) => entry.enabled)
		.slice(0, 5)
		.map((entry) => [
			`color: ${entry.fill ?? editorStore.selectedLayer?.fill ?? "#f8fafc"}`,
			`font-family: ${previewFontFamily}`,
			`font-size: ${previewFontSize}px`,
			`letter-spacing: ${previewLetterSpacing}`,
			`opacity: ${boundedNumber(entry.opacity, 0, 100, 100) / 100}`,
			`transform: translate(${boundedNumber(entry.offsetX, -80, 80, 0)}px, ${boundedNumber(entry.offsetY, -80, 80, 0)}px) skew(${previewSkewX}deg, ${previewSkewY}deg)`,
			`-webkit-text-stroke: ${boundedNumber(entry.strokeWidth ?? 0, 0, previewPassStrokeMax, 0)}px ${entry.stroke ?? "transparent"}`,
			"text-shadow: none",
		].join("; ")));

	let previewStyle = $derived([
		`color: ${editorStore.selectedLayer?.fill ?? "#f8fafc"}`,
		`font-family: ${previewFontFamily}`,
		`font-size: ${previewFontSize}px`,
		`letter-spacing: ${previewLetterSpacing}`,
		`transform: skew(${previewSkewX}deg, ${previewSkewY}deg)`,
		`-webkit-text-stroke: ${strokeEnabled ? `${boundedNumber(strokeWidth, 0, previewStrokeMax, 2)}px ${strokeColor}` : `0 ${strokeColor}`}`,
		`text-shadow: ${previewTextShadow}`,
	].join("; "));

	const controlIds = {
		preset: "effect-preset",
		strokeColor: "effect-stroke-color",
		strokeWidth: "effect-stroke-width",
		glowColor: "effect-glow-color",
		glowBlur: "effect-glow-blur",
		glowOpacity: "effect-glow-opacity",
		shadowColor: "effect-shadow-color",
		shadowOffsetX: "effect-shadow-offset-x",
		shadowOffsetY: "effect-shadow-offset-y",
		shadowBlur: "effect-shadow-blur",
		shadowOpacity: "effect-shadow-opacity",
		shapeSkewX: "effect-shape-skew-x",
		shapeSkewY: "effect-shape-skew-y"
	};

	let effectPresetOptions: Array<{ id: EffectPresetId; label: string; detail: string }> = $derived([
		{ id: "readable", label: $_("effectsPanel.presetReadableLabel"), detail: $_("effectsPanel.presetReadableDetail") },
		{ id: "dungeon", label: $_("effectsPanel.presetDungeonLabel"), detail: $_("effectsPanel.presetDungeonDetail") },
		{ id: "curse", label: $_("effectsPanel.presetCurseLabel"), detail: $_("effectsPanel.presetCurseDetail") },
		{ id: "haunt", label: $_("effectsPanel.presetHauntLabel"), detail: $_("effectsPanel.presetHauntDetail") },
		{ id: "scream", label: $_("effectsPanel.presetScreamLabel"), detail: $_("effectsPanel.presetScreamDetail") },
		{ id: "romance", label: $_("effectsPanel.presetRomanceLabel"), detail: $_("effectsPanel.presetRomanceDetail") },
	]);
	let selectedPreset = $derived(effectPresetOptions.find((option) => option.id === selectedPresetId) ?? effectPresetOptions[0]);
	let selectedPresetLabel = $derived(selectedPreset?.label ?? $_("effectsPanel.presetReadableLabel"));
	let selectedPresetDetail = $derived(selectedPreset?.detail ?? "");

	// Watch for layer selection changes.
	$effect(() => {
		const layer = editorStore.selectedLayer;
		const currentId = layer?.id;
		const currentSignature = getLayerEffectSignature(layer);
		if (currentId !== prevLayerId || currentSignature !== prevLayerEffectSignature) {
			prevLayerId = currentId;
			prevLayerEffectSignature = currentSignature;
			loadFromLayer(layer);
		}
	});

	$effect(() => {
		const layer = editorStore.selectedLayer;
		if (!layer || layer.id !== prevLayerId || !strokeEnabled) return;
		syncStrokeControlsFromLayer(layer);
	});

	function loadFromLayer(layer: TextLayer | null) {
		if (!layer) {
			shapeSkewX = 0;
			shapeSkewY = 0;
			resetEffects();
			return;
		}
		shapeSkewX = boundedNumber(layer.skewX ?? 0, -45, 45, 0);
		shapeSkewY = boundedNumber(layer.skewY ?? 0, -45, 45, 0);
		const effects = layer.effects;
		if (effects) {
			strokeEnabled = effects.stroke?.enabled ?? false;
			strokeColor = effects.stroke?.color ?? layer.stroke ?? "#ffffff";
			strokeWidth = effects.stroke?.width ?? layer.strokeWidth ?? 2;

			shadowEnabled = effects.dropShadow?.enabled ?? false;
			glowEnabled = effects.outerGlow?.enabled ?? false;
			glowColor = effects.outerGlow?.color ?? "#ffcc00";
			glowBlur = effects.outerGlow?.blur ?? 10;
			glowOpacity = effects.outerGlow?.opacity ?? 80;

			shadowColor = effects.dropShadow?.color ?? "#000000";
			shadowOffsetX = effects.dropShadow?.offsetX ?? 3;
			shadowOffsetY = effects.dropShadow?.offsetY ?? 3;
			shadowBlur = effects.dropShadow?.blur ?? 5;
			shadowOpacity = effects.dropShadow?.opacity ?? 50;
			accentShadows = effects.accentShadows ? [...effects.accentShadows] : [];
			effectPasses = effects.passes ? [...effects.passes] : [];
		} else {
			resetEffects(layer);
		}
	}

	function resetEffects(layer: TextLayer | null = editorStore.selectedLayer) {
		strokeEnabled = false;
		strokeColor = layer?.stroke ?? "#ffffff";
		strokeWidth = layer?.strokeWidth ?? 2;

		glowEnabled = false;
		glowColor = "#ffcc00";
		glowBlur = 10;
		glowOpacity = 80;

		shadowEnabled = false;
		shadowColor = "#000000";
		shadowOffsetX = 3;
		shadowOffsetY = 3;
		shadowBlur = 5;
		shadowOpacity = 50;
		accentShadows = [];
		effectPasses = [];
	}

	function syncStrokeControlsFromLayer(layer: TextLayer): void {
		strokeColor = layer.stroke ?? layer.effects?.stroke?.color ?? strokeColor;
		strokeWidth = layer.strokeWidth ?? layer.effects?.stroke?.width ?? strokeWidth;
	}

	function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return fallback;
		return Math.max(min, Math.min(max, numeric));
	}

	function cssPreviewFontFamily(value: unknown): string {
		const fallback = `Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif`;
		if (typeof value !== "string" || !value.trim()) return fallback;
		const safeName = value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${safeName}", ${fallback}`;
	}

	function getLayerEffectSignature(layer: TextLayer | null): string {
		if (!layer) return "none";
		return JSON.stringify({
			id: layer.id,
			stroke: layer.stroke,
			strokeWidth: layer.strokeWidth,
			skewX: layer.skewX,
			skewY: layer.skewY,
			effects: layer.effects ?? null,
		});
	}

	function applyEffects() {
		if (!editorStore.selectedLayer) return;
		const effects: TextLayerEffects = {
			stroke: {
				enabled: strokeEnabled,
				color: strokeColor,
				width: boundedNumber(strokeWidth, 0, safeStrokeMax, 2)
			},
			outerGlow: {
				enabled: glowEnabled,
				color: glowColor,
				blur: boundedNumber(glowBlur, 0, 120, 10),
				opacity: boundedNumber(glowOpacity, 0, 100, 80)
			},
			dropShadow: {
				enabled: shadowEnabled,
				color: shadowColor,
				offsetX: boundedNumber(shadowOffsetX, -80, 80, 3),
				offsetY: boundedNumber(shadowOffsetY, -80, 80, 3),
				blur: boundedNumber(shadowBlur, 0, 120, 5),
				opacity: boundedNumber(shadowOpacity, 0, 100, 50)
			},
			accentShadows,
			passes: effectPasses,
		};
		editorStore.applyEffects(effects);
	}

	function applyNumberControl(
		event: Event,
		assign: (value: number) => void,
		min: number,
		max: number,
		fallback: number,
	): void {
		const input = event.currentTarget as HTMLInputElement;
		const value = boundedNumber(input.value, min, max, fallback);
		assign(value);
		applyEffects();
	}

	function applyShape() {
		if (!editorStore.selectedLayer) return;
		shapeSkewX = Math.round(boundedNumber(shapeSkewX, -45, 45, 0));
		shapeSkewY = Math.round(boundedNumber(shapeSkewY, -45, 45, 0));
		editorStore.applyTextStylePreset({ skewX: shapeSkewX, skewY: shapeSkewY });
	}

	function applyShapeNumberControl(
		event: Event,
		assign: (value: number) => void,
	): void {
		const input = event.currentTarget as HTMLInputElement;
		const value = Math.round(boundedNumber(input.value, -45, 45, 0));
		assign(value);
		applyShape();
	}

	function setLightMode(mode: "none" | "glow" | "shadow"): void {
		if (mode === "none") {
			glowEnabled = false;
			shadowEnabled = false;
		} else if (mode === "glow") {
			glowEnabled = !glowEnabled;
		} else {
			shadowEnabled = !shadowEnabled;
		}
		if (strokeEnabled && editorStore.selectedLayer) syncStrokeControlsFromLayer(editorStore.selectedLayer);
		applyEffects();
	}

	function applyPresetFill(fill: string, charSpacing = 0, skewX = 0, skewY = 0): void {
		shapeSkewX = skewX;
		shapeSkewY = skewY;
		editorStore.applyTextStylePreset({ fill, charSpacing, skewX, skewY });
	}

	function handleReset() {
		resetEffects();
		if (editorStore.selectedLayer) {
			editorStore.selectedLayer.effects = undefined;
			editorStore.applyEffects(null);
		}
	}

	function applyReadableStrokePreset() {
		applyPresetFill("#111827", 0, 0, 0);
		strokeEnabled = true;
		strokeColor = "#ffffff";
		strokeWidth = 4;
		glowEnabled = false;
		shadowEnabled = false;
		accentShadows = [];
		effectPasses = [];
		applyEffects();
	}

	function applyDungeonBluePreset() {
		applyPresetFill("#e0f7ff", 45, -8, 0);
		strokeEnabled = true;
		strokeColor = "#020617";
		strokeWidth = Math.max(4, Math.min(7, safeStrokeMax));
		glowEnabled = true;
		glowColor = "#22d3ee";
		glowBlur = 46;
		glowOpacity = 94;
		accentShadows = [
			{ enabled: true, color: "#67e8f9", offsetX: -8, offsetY: 0, blur: 14, opacity: 64 },
			{ enabled: true, color: "#1e3a8a", offsetX: 10, offsetY: 12, blur: 0, opacity: 88 },
		];
		effectPasses = [
			{ enabled: true, fill: "#1e3a8a", stroke: "#020617", strokeWidth: 8, offsetX: 12, offsetY: 14, opacity: 86 },
			{ enabled: true, fill: "#155e75", stroke: "#0f172a", strokeWidth: 4, offsetX: -7, offsetY: 7, opacity: 58 },
		];
		shadowEnabled = true;
		shadowColor = "#0f172a";
		shadowOffsetX = 5;
		shadowOffsetY = 6;
		shadowBlur = 0;
		shadowOpacity = 74;
		applyEffects();
	}

	function applyCursePurplePreset() {
		applyPresetFill("#f5d0fe", 130, 11, -3);
		strokeEnabled = true;
		strokeColor = "#2e1065";
		strokeWidth = Math.max(3, Math.min(6, safeStrokeMax));
		glowEnabled = true;
		glowColor = "#a855f7";
		glowBlur = 34;
		glowOpacity = 88;
		accentShadows = [
			{ enabled: true, color: "#581c87", offsetX: -10, offsetY: 8, blur: 0, opacity: 72 },
			{ enabled: true, color: "#e879f9", offsetX: 7, offsetY: -6, blur: 18, opacity: 58 },
		];
		effectPasses = [
			{ enabled: true, fill: "#4c1d95", stroke: "#1e1b4b", strokeWidth: 8, offsetX: -12, offsetY: 10, opacity: 74 },
		];
		shadowEnabled = false;
		applyEffects();
	}

	function applyHauntStretchPreset() {
		applyPresetFill("#fde7ff", 180, 18, -6);
		strokeEnabled = true;
		strokeColor = "#3b0764";
		strokeWidth = Math.max(3, Math.min(5, safeStrokeMax));
		glowEnabled = true;
		glowColor = "#c084fc";
		glowBlur = 42;
		glowOpacity = 86;
		accentShadows = [
			{ enabled: true, color: "#4c1d95", offsetX: -14, offsetY: 10, blur: 0, opacity: 74 },
			{ enabled: true, color: "#a21caf", offsetX: 12, offsetY: -8, blur: 18, opacity: 54 },
		];
		effectPasses = [
			{ enabled: true, fill: "#581c87", stroke: "#240046", strokeWidth: 7, offsetX: -16, offsetY: 11, opacity: 72 },
		];
		shadowEnabled = false;
		applyEffects();
	}

	function applyScreamRedPreset() {
		applyPresetFill("#fff1f2", -25, -14, 0);
		strokeEnabled = true;
		strokeColor = "#450a0a";
		strokeWidth = Math.max(5, Math.min(10, safeStrokeMax));
		glowEnabled = true;
		glowColor = "#fb7185";
		glowBlur = 18;
		glowOpacity = 78;
		accentShadows = [
			{ enabled: true, color: "#7f1d1d", offsetX: -9, offsetY: 8, blur: 0, opacity: 84 },
			{ enabled: true, color: "#dc2626", offsetX: 15, offsetY: 16, blur: 0, opacity: 70 },
			{ enabled: true, color: "#fecdd3", offsetX: -2, offsetY: -2, blur: 12, opacity: 46 },
		];
		effectPasses = [
			{ enabled: true, fill: "#7f1d1d", stroke: "#450a0a", strokeWidth: 10, offsetX: 14, offsetY: 16, opacity: 88 },
			{ enabled: true, fill: "#b91c1c", stroke: "#450a0a", strokeWidth: 7, offsetX: -10, offsetY: 11, opacity: 64 },
		];
		shadowEnabled = true;
		shadowColor = "#991b1b";
		shadowOffsetX = 9;
		shadowOffsetY = 10;
		shadowBlur = 0;
		shadowOpacity = 92;
		applyEffects();
	}

	function applyRomanceGoldPreset() {
		applyPresetFill("#fff7ed", 30, 5, 0);
		strokeEnabled = true;
		strokeColor = "#7c2d12";
		strokeWidth = Math.max(2, Math.min(4, safeStrokeMax));
		glowEnabled = true;
		glowColor = "#facc15";
		glowBlur = 28;
		glowOpacity = 72;
		accentShadows = [
			{ enabled: true, color: "#f97316", offsetX: 3, offsetY: 5, blur: 0, opacity: 46 },
			{ enabled: true, color: "#fde68a", offsetX: -4, offsetY: -3, blur: 16, opacity: 62 },
		];
		effectPasses = [
			{ enabled: true, fill: "#f59e0b", stroke: "#7c2d12", strokeWidth: 5, offsetX: 5, offsetY: 7, opacity: 46 },
		];
		shadowEnabled = false;
		applyEffects();
	}

	function applySelectedPreset() {
		switch (selectedPresetId) {
			case "dungeon":
				applyDungeonBluePreset();
				break;
			case "curse":
				applyCursePurplePreset();
				break;
			case "haunt":
				applyHauntStretchPreset();
				break;
			case "scream":
				applyScreamRedPreset();
				break;
			case "romance":
				applyRomanceGoldPreset();
				break;
			case "readable":
			default:
				applyReadableStrokePreset();
				break;
		}
	}

	function cycleSelectedPreset() {
		const currentIndex = effectPresetOptions.findIndex((option) => option.id === selectedPresetId);
		selectedPresetId = effectPresetOptions[(currentIndex + 1) % effectPresetOptions.length]?.id ?? "readable";
	}
</script>

<div class="effects-panel">
	<div class="effects-summary ws-panel" aria-label={$_("effectsPanel.statusLabel")}>
		<div class="effects-summary-copy">
			<strong>{$_("effectsPanel.title")}</strong>
			<small>{$_("effectsPanel.subtitle")}</small>
		</div>
		<span class="effects-summary-meter" class:active={activeEffectCount > 0}>{effectSummaryLabel}</span>
	</div>
	<div class="effect-preview ws-panel-quiet" aria-label={$_("effectsPanel.previewLabel")}>
		<div class="effect-preview-stack">
			{#each previewPassStyles as passStyle, index (index)}
				<span class="effect-preview-pass" style={passStyle} aria-hidden="true">{previewText}</span>
			{/each}
			<span class="effect-preview-main" style={previewStyle} title={previewText}>{previewText}</span>
		</div>
		<small>{$_("effectsPanel.previewCaption", { values: { light: activeLightEffectLabel } })}</small>
	</div>
	{#if activeEffectCount > 0}
		<div class="effect-chip-row" aria-label={$_("effectsPanel.activeEffectsLabel")}>
			<span class:active={strokeEnabled}>{$_("effectsPanel.chipStroke", { values: { value: strokeEnabled ? `${boundedNumber(strokeWidth, 0, safeStrokeMax, 2)}px` : $_("effectsPanel.off") } })}</span>
			<span class:active={glowEnabled}>{$_("effectsPanel.chipGlow", { values: { value: glowEnabled ? `${glowBlur}px / ${glowOpacity}%` : $_("effectsPanel.off") } })}</span>
			<span class:active={shadowEnabled}>{$_("effectsPanel.chipShadow", { values: { value: shadowEnabled ? `${shadowOffsetX}, ${shadowOffsetY}` : $_("effectsPanel.off") } })}</span>
			{#if effectPasses.length > 0}
				<span class="active">{$_("effectsPanel.chipBackLayers", { values: { n: effectPasses.length } })}</span>
			{/if}
			{#if accentShadows.length > 0}
				<span class="active">{$_("effectsPanel.chipAccentLight", { values: { n: accentShadows.length } })}</span>
			{/if}
		</div>
	{/if}
	<div class="effect-preset-row" aria-label={$_("effectsPanel.presetRowLabel")}>
		<button
			type="button"
			id={controlIds.preset}
			class="effect-preset-cycle ws-btn-ghost"
			onclick={cycleSelectedPreset}
			aria-label={$_("effectsPanel.cyclePresetLabel", { values: { preset: selectedPresetLabel } })}
		>
			<span>Preset</span>
			<strong>{selectedPresetLabel}</strong>
			<small>{selectedPresetDetail}</small>
		</button>
		<button type="button" class="effect-preset-apply ws-grad-primary" onclick={applySelectedPreset} aria-label={$_("effectsPanel.applyPresetLabel")}>
			{$_("effectsPanel.applyPreset")}
		</button>
	</div>
	<div class="effect-advanced ws-panel" class:open={advancedOpen}>
		<button
			type="button"
			class="effect-advanced-summary"
			aria-expanded={advancedOpen}
			onclick={() => advancedOpen = !advancedOpen}
		>
			<span>{$_("effectsPanel.fineTune")}</span>
			<small>{activeEffectCount > 0 ? effectSummaryLabel : $_("effectsPanel.fineTuneHint")}</small>
		</button>
	{#if advancedOpen}
	<div class="effect-group">
		<div class="effect-header">
			<span class="effect-title">
				{$_("effectsPanel.shapeTitle")}
				<small>{$_("effectsPanel.shapeSkewSummary", { values: { x: shapeSkewX, y: shapeSkewY } })}</small>
			</span>
			<button
				type="button"
				class="effect-mini-action ws-btn-ghost"
				onclick={() => {
					shapeSkewX = 0;
					shapeSkewY = 0;
					applyShape();
				}}
			>
				{$_("effectsPanel.resetShape")}
			</button>
		</div>
		<div class="effect-controls">
			<div class="effect-row">
				<label class="effect-label" for={controlIds.shapeSkewX}>{$_("effectsPanel.skewX")}</label>
				<input
					id={controlIds.shapeSkewX}
					type="range"
					min="-45"
					max="45"
					class="effect-slider"
					bind:value={shapeSkewX}
					oninput={applyShape}
				/>
				<input
					type="number"
					class="effect-number"
					name="effectShapeSkewX"
					min="-45"
					max="45"
					step="1"
					value={shapeSkewX}
					aria-label={$_("effectsPanel.skewXValueLabel")}
					oninput={(event) => applyShapeNumberControl(event, (value) => (shapeSkewX = value))}
				/>
				<span class="effect-value">°</span>
			</div>
			<div class="effect-row">
				<label class="effect-label" for={controlIds.shapeSkewY}>{$_("effectsPanel.skewY")}</label>
				<input
					id={controlIds.shapeSkewY}
					type="range"
					min="-45"
					max="45"
					class="effect-slider"
					bind:value={shapeSkewY}
					oninput={applyShape}
				/>
				<input
					type="number"
					class="effect-number"
					name="effectShapeSkewY"
					min="-45"
					max="45"
					step="1"
					value={shapeSkewY}
					aria-label={$_("effectsPanel.skewYValueLabel")}
					oninput={(event) => applyShapeNumberControl(event, (value) => (shapeSkewY = value))}
				/>
				<span class="effect-value">°</span>
			</div>
			<small class="effect-hint">{$_("effectsPanel.shapeHint")}</small>
		</div>
	</div>
	<div class="light-mode-row" role="group" aria-label={$_("effectsPanel.lightModeLabel")}>
		<button type="button" class="ws-btn-ghost" class:active={!glowEnabled && !shadowEnabled} aria-pressed={!glowEnabled && !shadowEnabled} onclick={() => setLightMode("none")}>
			{$_("effectsPanel.lightNone")}
		</button>
		<button type="button" class="ws-btn-ghost" class:active={glowEnabled} aria-pressed={glowEnabled} onclick={() => setLightMode("glow")}>
			{$_("effectsPanel.glow")}
		</button>
		<button type="button" class="ws-btn-ghost" class:active={shadowEnabled} aria-pressed={shadowEnabled} onclick={() => setLightMode("shadow")}>
			{$_("effectsPanel.shadow")}
		</button>
	</div>
	<div class="effect-group">
		<div class="effect-header">
			<span class="effect-title">
				{$_("effectsPanel.strokeTitle")}
				<small>{strokeEnabled ? `${boundedNumber(strokeWidth, 0, safeStrokeMax, 2)}px / ${strokeColor}` : $_("effectsPanel.disabled")}</small>
			</span>
			<button
				class="effect-toggle"
				class:active={strokeEnabled}
				onclick={() => {
					strokeEnabled = !strokeEnabled;
					applyEffects();
				}}
				aria-label={strokeEnabled ? $_("effectsPanel.strokeToggleOff") : $_("effectsPanel.strokeToggleOn")}
			></button>
		</div>
		{#if strokeEnabled}
			<div class="effect-controls">
				<div class="effect-row">
					<label class="effect-label" for={controlIds.strokeColor}>{$_("effectsPanel.color")}</label>
					<input
						id={controlIds.strokeColor}
						type="color"
						class="effect-color"
						bind:value={strokeColor}
						oninput={applyEffects}
					/>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.strokeWidth}>{$_("effectsPanel.width")}</label>
					<input
						id={controlIds.strokeWidth}
						type="range"
						min="1"
						max={safeStrokeMax}
						class="effect-slider"
						bind:value={strokeWidth}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectStrokeWidth"
						min="0"
						max={safeStrokeMax}
						step="1"
						value={boundedNumber(strokeWidth, 0, safeStrokeMax, 2)}
						aria-label={$_("effectsPanel.strokeWidthValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (strokeWidth = value), 0, safeStrokeMax, 2)}
					/>
					<span class="effect-value">px</span>
				</div>
				<small class="effect-hint">{$_("effectsPanel.strokeHint", { values: { max: safeStrokeMax } })}</small>
			</div>
		{/if}
	</div>

	<div class="effect-group">
		<div class="effect-header">
			<span class="effect-title">
				{$_("effectsPanel.glowTitle")}
				<small>{glowEnabled ? `${glowBlur}px / ${glowOpacity}%` : $_("effectsPanel.disabled")}</small>
			</span>
			<span class="effect-mode-status" class:active={glowEnabled}>{glowEnabled ? $_("effectsPanel.onStatus") : $_("effectsPanel.enableAbove")}</span>
		</div>
		{#if glowEnabled}
			<div class="effect-controls">
				<div class="effect-row">
					<label class="effect-label" for={controlIds.glowColor}>{$_("effectsPanel.color")}</label>
					<input
						id={controlIds.glowColor}
						type="color"
						class="effect-color"
						bind:value={glowColor}
						oninput={applyEffects}
					/>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.glowBlur}>{$_("effectsPanel.blur")}</label>
					<input
						id={controlIds.glowBlur}
						type="range"
						min="0"
						max="50"
						class="effect-slider"
						bind:value={glowBlur}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectGlowBlur"
						min="0"
						max="120"
						step="1"
						value={glowBlur}
						aria-label={$_("effectsPanel.glowBlurValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (glowBlur = value), 0, 120, 10)}
					/>
					<span class="effect-value">px</span>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.glowOpacity}>{$_("effectsPanel.opacity")}</label>
					<input
						id={controlIds.glowOpacity}
						type="range"
						min="0"
						max="100"
						class="effect-slider"
						bind:value={glowOpacity}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectGlowOpacity"
						min="0"
						max="100"
						step="1"
						value={glowOpacity}
						aria-label={$_("effectsPanel.glowOpacityValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (glowOpacity = value), 0, 100, 80)}
					/>
					<span class="effect-value">%</span>
				</div>
			</div>
		{/if}
	</div>

	<div class="effect-group">
		<div class="effect-header">
			<span class="effect-title">
				{$_("effectsPanel.shadowTitle")}
				<small>{shadowEnabled ? `X ${shadowOffsetX} / Y ${shadowOffsetY} / ${shadowOpacity}%` : $_("effectsPanel.disabled")}</small>
			</span>
			<span class="effect-mode-status" class:active={shadowEnabled}>{shadowEnabled ? $_("effectsPanel.onStatus") : $_("effectsPanel.enableAbove")}</span>
		</div>
		{#if shadowEnabled}
			<div class="effect-controls">
				<div class="effect-row">
					<label class="effect-label" for={controlIds.shadowColor}>{$_("effectsPanel.color")}</label>
					<input
						id={controlIds.shadowColor}
						type="color"
						class="effect-color"
						bind:value={shadowColor}
						oninput={applyEffects}
					/>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.shadowOffsetX}>{$_("effectsPanel.offsetX")}</label>
					<input
						id={controlIds.shadowOffsetX}
						type="range"
						min="-20"
						max="20"
						class="effect-slider"
						bind:value={shadowOffsetX}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectShadowOffsetX"
						min="-80"
						max="80"
						step="1"
						value={shadowOffsetX}
						aria-label={$_("effectsPanel.shadowOffsetXValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (shadowOffsetX = value), -80, 80, 3)}
					/>
					<span class="effect-value">px</span>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.shadowOffsetY}>{$_("effectsPanel.offsetY")}</label>
					<input
						id={controlIds.shadowOffsetY}
						type="range"
						min="-20"
						max="20"
						class="effect-slider"
						bind:value={shadowOffsetY}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectShadowOffsetY"
						min="-80"
						max="80"
						step="1"
						value={shadowOffsetY}
						aria-label={$_("effectsPanel.shadowOffsetYValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (shadowOffsetY = value), -80, 80, 3)}
					/>
					<span class="effect-value">px</span>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.shadowBlur}>{$_("effectsPanel.blur")}</label>
					<input
						id={controlIds.shadowBlur}
						type="range"
						min="0"
						max="50"
						class="effect-slider"
						bind:value={shadowBlur}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectShadowBlur"
						min="0"
						max="120"
						step="1"
						value={shadowBlur}
						aria-label={$_("effectsPanel.shadowBlurValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (shadowBlur = value), 0, 120, 5)}
					/>
					<span class="effect-value">px</span>
				</div>
				<div class="effect-row">
					<label class="effect-label" for={controlIds.shadowOpacity}>{$_("effectsPanel.opacity")}</label>
					<input
						id={controlIds.shadowOpacity}
						type="range"
						min="0"
						max="100"
						class="effect-slider"
						bind:value={shadowOpacity}
						oninput={applyEffects}
					/>
					<input
						type="number"
						class="effect-number"
						name="effectShadowOpacity"
						min="0"
						max="100"
						step="1"
						value={shadowOpacity}
						aria-label={$_("effectsPanel.shadowOpacityValueLabel")}
						oninput={(event) => applyNumberControl(event, (value) => (shadowOpacity = value), 0, 100, 50)}
					/>
					<span class="effect-value">%</span>
				</div>
			</div>
		{/if}
	</div>

	{#if activeEffectCount > 0}
		<button
			type="button"
			class="effects-reset-btn ws-btn-ghost"
			onclick={handleReset}
		>
			{$_("effectsPanel.resetAll")}
		</button>
		{/if}
	{/if}
	</div>
</div>

<style>
	.effects-panel {
		--fx-active: var(--color-ws-cyan);
		--fx-primary: var(--color-ws-accent);
		--fx-primary-2: var(--color-ws-violet);
		--fx-success: var(--color-ws-green);
		--fx-control-bg: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		--fx-control-bg-hover: color-mix(in srgb, var(--color-ws-surface2) 88%, transparent);
		--fx-active-bg: color-mix(in srgb, var(--fx-active) 13%, transparent);
		--fx-primary-bg: color-mix(in srgb, var(--fx-primary) 13%, transparent);
		--fx-ink-soft: color-mix(in srgb, var(--color-ws-ink) 82%, var(--color-ws-text));
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 4px 0;
	}

	.effects-summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 8px;
		border-color: color-mix(in srgb, var(--fx-active) 22%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--fx-active) 9%, transparent), color-mix(in srgb, var(--color-ws-ink) 3%, transparent)),
			var(--color-ws-surface);
	}

	.effects-summary-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.effects-summary-copy strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 820;
	}

	.effects-summary-copy small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 680;
	}

	.effects-summary-meter {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 780;
		white-space: nowrap;
	}

	.effects-summary-meter.active {
		border-color: color-mix(in srgb, var(--fx-active) 42%, transparent);
		background: var(--fx-active-bg);
		color: color-mix(in srgb, var(--fx-active) 78%, var(--color-ws-ink));
	}

	.effect-preview {
		display: grid;
		gap: 5px;
		min-width: 0;
		min-height: 100px;
		padding: 18px 12px 12px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background:
			radial-gradient(circle at top left, color-mix(in srgb, var(--fx-primary) 10%, transparent), transparent 60%),
			var(--color-ws-surface);
		overflow: hidden;
	}

	.effect-preview-stack {
		display: grid;
		align-items: center;
		justify-items: start;
		min-width: 0;
		min-height: 58px;
		padding: 4px 8px 8px 2px;
		overflow: visible;
	}

	.effect-preview-stack span {
		grid-area: 1 / 1;
		display: block;
		min-width: 0;
		overflow: visible;
		font-weight: 900;
		letter-spacing: 0;
		line-height: 1.02;
		overflow-wrap: anywhere;
		text-overflow: clip;
		white-space: normal;
		word-break: break-word;
	}

	.effect-preview-pass {
		pointer-events: none;
		user-select: none;
	}

	.effect-preview-main {
		position: relative;
		z-index: 1;
	}

	.effect-preview small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 720;
	}

	.effect-chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.effect-chip-row span {
		display: inline-flex;
		align-items: center;
		min-height: 26px;
		max-width: 100%;
		padding: 0 7px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 54%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 720;
	}

	.effect-chip-row span.active {
		border-color: color-mix(in srgb, var(--fx-primary) 38%, transparent);
		background: var(--fx-primary-bg);
		color: color-mix(in srgb, var(--color-ws-blue) 78%, var(--color-ws-ink));
	}

	.effect-advanced {
		display: grid;
		gap: 7px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.effect-advanced-summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 40px;
		padding: 7px 9px;
		border: 0;
		background: transparent;
		color: var(--color-ws-ink);
		cursor: pointer;
		font: inherit;
		font-size: 11px;
		font-weight: 850;
		list-style: none;
		text-align: left;
	}

	.effect-advanced-summary::after {
		content: "▾";
		grid-column: 2;
		grid-row: 1 / span 2;
		color: var(--color-ws-text);
		font-size: 10px;
		transition: transform 120ms ease;
	}

	.effect-advanced.open .effect-advanced-summary::after {
		transform: rotate(180deg);
	}

	.effect-advanced-summary span,
	.effect-advanced-summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.effect-advanced-summary small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
	}

	.effect-advanced.open {
		padding-bottom: 7px;
	}

	.effect-advanced.open > :not(.effect-advanced-summary) {
		margin-inline: 7px;
	}

	.effect-preset-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: end;
	}

	.effect-preset-cycle,
	.effect-preset-apply {
		min-height: 40px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 11px;
		font-weight: 760;
		letter-spacing: 0;
	}

	.effect-preset-cycle {
		display: grid;
		min-width: 0;
		gap: 2px;
		padding: 6px 10px;
		text-align: left;
		cursor: pointer;
	}

	.effect-preset-cycle span {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.effect-preset-cycle strong,
	.effect-preset-cycle small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.effect-preset-cycle strong {
		font-size: 11px;
		font-weight: 850;
	}

	.effect-preset-cycle small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 650;
	}

	.effect-preset-apply {
		min-width: 92px;
		padding: 0 12px;
		border-color: color-mix(in srgb, var(--fx-primary) 32%, transparent);
		cursor: pointer;
		box-shadow: 0 12px 28px -18px color-mix(in srgb, var(--fx-primary) 70%, transparent);
	}

	.effect-preset-cycle:hover,
	.effect-preset-apply:hover {
		border-color: color-mix(in srgb, var(--fx-active) 42%, transparent);
	}

	.effect-group {
		border-radius: var(--radius-ws-ctrl);
		overflow: hidden;
	}

	.light-mode-row {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 5px;
	}

	.light-mode-row button {
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 820;
		cursor: pointer;
	}

	.light-mode-row button.active {
		border-color: color-mix(in srgb, var(--fx-active) 46%, transparent);
		background: var(--fx-active-bg);
		color: color-mix(in srgb, var(--fx-active) 80%, var(--color-ws-ink));
	}

	.effect-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 0;
	}

	.effect-title {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 740;
	}

	.effect-title small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 620;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.effect-toggle {
		width: 52px;
		min-width: 52px;
		height: 40px;
		border-radius: var(--radius-ws-card);
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface2);
		cursor: pointer;
		position: relative;
		transition: all 0.15s ease;
	}

	.effect-toggle::after {
		content: "";
		position: absolute;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--color-ws-text);
		top: 9px;
		left: 9px;
		transition: all 0.15s ease;
	}

	.effect-toggle.active {
		background: var(--fx-primary);
		border-color: var(--fx-primary);
	}

	.effect-toggle.active::after {
		background: var(--color-ws-ink);
		left: calc(100% - 29px);
	}

	.effect-mode-status {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		white-space: nowrap;
	}

	.effect-mode-status.active {
		border-color: color-mix(in srgb, var(--fx-active) 42%, transparent);
		background: var(--fx-active-bg);
		color: color-mix(in srgb, var(--fx-active) 80%, var(--color-ws-ink));
	}

	.effect-mini-action {
		display: inline-flex;
		min-width: 92px;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 820;
		white-space: nowrap;
	}

	.effect-controls {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 4px 0;
	}

	.effect-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 40px;
	}

	.effect-label {
		color: var(--color-ws-text);
		font-size: 10px;
		min-width: 50px;
	}

	.effect-color {
		width: 40px;
		height: 40px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		cursor: pointer;
		padding: 0;
		background: var(--color-ws-surface2);
		flex: 0 0 auto;
	}

	.effect-slider {
		flex: 1;
		min-width: 0;
		height: 40px;
		-webkit-appearance: none;
		appearance: none;
		background: var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		outline: none;
	}

	.effect-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--fx-primary);
		cursor: pointer;
	}

	.effect-slider::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--fx-primary);
		cursor: pointer;
		border: none;
	}

	.effect-value {
		color: var(--color-ws-text);
		font-size: 10px;
		min-width: 16px;
		text-align: right;
	}

	.effect-hint {
		display: block;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 680;
		line-height: 1.35;
	}

	.effect-number {
		width: 58px;
		min-width: 58px;
		height: 40px;
		padding: 0 6px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: var(--fx-control-bg);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 720;
		text-align: right;
	}

	.effect-number:focus {
		border-color: color-mix(in srgb, var(--fx-primary) 60%, transparent);
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.effects-reset-btn {
		margin-top: 4px;
		padding: 6px 12px;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 11px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.effects-reset-btn:hover {
		background: var(--fx-control-bg-hover);
	}
</style>
