import type { TextLayer } from "$lib/types.js";

export interface ResolvedTextLayerShadow {
	color: string;
	offsetX: number;
	offsetY: number;
	blur: number;
}

export interface ResolvedTextLayerPass {
	fill: string;
	stroke: string;
	strokeWidth: number;
	offsetX: number;
	offsetY: number;
	opacity: number;
	shadow: ResolvedTextLayerShadow | null;
}

export interface ResolvedTextLayerEffectStyle {
	stroke: string;
	strokeWidth: number;
	shadow: ResolvedTextLayerShadow | null;
	shadows: ResolvedTextLayerShadow[];
	passes: ResolvedTextLayerPass[];
}

export function clampEffectNumber(value: unknown, min: number, max: number, fallback: number): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.max(min, Math.min(max, numeric));
}

export function colorWithEffectOpacity(color: unknown, opacityPercent: unknown): string {
	const alpha = clampEffectNumber(opacityPercent, 0, 100, 100) / 100;
	if (typeof color !== "string") return `rgba(0, 0, 0, ${alpha})`;
	const normalized = color.trim();
	const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!hex) return normalized;
	const fullHex = hex[1].length === 3
		? hex[1].split("").map((part) => `${part}${part}`).join("")
		: hex[1];
	const r = Number.parseInt(fullHex.slice(0, 2), 16);
	const g = Number.parseInt(fullHex.slice(2, 4), 16);
	const b = Number.parseInt(fullHex.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function resolveTextLayerEffectStyle(
	layer: TextLayer,
	defaultStroke: string,
	baseStrokeWidth: number,
): ResolvedTextLayerEffectStyle {
	const effectStroke = layer.effects?.stroke?.enabled ? layer.effects.stroke : null;
	const stroke = effectStroke?.color || layer.stroke || defaultStroke;
	const strokeWidth = effectStroke
		? clampEffectNumber(effectStroke.width, 0, 24, baseStrokeWidth)
		: baseStrokeWidth;
	const dropShadow = layer.effects?.dropShadow?.enabled ? layer.effects.dropShadow : null;
	const outerGlow = layer.effects?.outerGlow?.enabled ? layer.effects.outerGlow : null;
	const shadows: ResolvedTextLayerShadow[] = [];
	const passes: ResolvedTextLayerPass[] = [];

	for (const pass of layer.effects?.passes ?? []) {
		if (!pass?.enabled) continue;
		passes.push({
			fill: pass.fill || layer.fill || "transparent",
			stroke: pass.stroke || stroke,
			strokeWidth: clampEffectNumber(pass.strokeWidth, 0, 64, strokeWidth),
			offsetX: clampEffectNumber(pass.offsetX, -80, 80, 0),
			offsetY: clampEffectNumber(pass.offsetY, -80, 80, 0),
			opacity: clampEffectNumber(pass.opacity, 0, 100, 100) / 100,
			shadow: null,
		});
	}

	if (outerGlow) {
		shadows.push({
			color: colorWithEffectOpacity(outerGlow.color, outerGlow.opacity),
			offsetX: 0,
			offsetY: 0,
			blur: clampEffectNumber(outerGlow.blur, 0, 120, 0),
		});
	}

	for (const accent of layer.effects?.accentShadows ?? []) {
		if (!accent?.enabled) continue;
		shadows.push({
			color: colorWithEffectOpacity(accent.color, accent.opacity),
			offsetX: clampEffectNumber(accent.offsetX, -80, 80, 0),
			offsetY: clampEffectNumber(accent.offsetY, -80, 80, 0),
			blur: clampEffectNumber(accent.blur, 0, 120, 0),
		});
	}

	if (dropShadow) {
		shadows.push({
			color: colorWithEffectOpacity(dropShadow.color, dropShadow.opacity),
			offsetX: clampEffectNumber(dropShadow.offsetX, -80, 80, 0),
			offsetY: clampEffectNumber(dropShadow.offsetY, -80, 80, 0),
			blur: clampEffectNumber(dropShadow.blur, 0, 120, 0),
		});
	}

	return {
		stroke,
		strokeWidth,
		shadow: shadows.at(-1) ?? null,
		shadows,
		passes,
	};
}
