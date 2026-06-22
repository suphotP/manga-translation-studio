import type { TextLayer } from "$lib/types.js";

const DEFAULT_LINE_HEIGHT = 1.12;
const HEIGHT_OVERFLOW_TOLERANCE = 1.18;
const WIDTH_OVERFLOW_TOLERANCE = 1.08;

interface EstimatedTextLine {
	width: number;
}

export interface TextLayerFitEstimate {
	fits: boolean;
	lineCount: number;
	estimatedWidth: number;
	estimatedHeight: number;
	availableWidth: number;
	availableHeight: number;
}

function graphemes(value: string): string[] {
	return Array.from(value);
}

function glyphWeight(char: string): number {
	if (/\s/u.test(char)) return 0.34;
	if (/[.,:;'"!?()[\]{}|/\\`~_-]/u.test(char)) return 0.36;
	if (/[0-9]/u.test(char)) return 0.52;
	if (/[A-Z]/u.test(char)) return 0.64;
	if (/[a-z]/u.test(char)) return 0.54;
	if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(char)) return 0.98;
	if (/[\u0e00-\u0e7f]/u.test(char)) return 0.64;
	return 0.7;
}

function estimateGlyphWidth(char: string, fontSize: number): number {
	return glyphWeight(char) * fontSize;
}

function wrapTextToEstimatedLines(text: string, availableWidth: number, fontSize: number): EstimatedTextLine[] {
	const sourceLines = text.split(/\r?\n/u);
	const lines: EstimatedTextLine[] = [];

	for (const sourceLine of sourceLines) {
		let currentWidth = 0;
		const units = graphemes(sourceLine);

		if (units.length === 0) {
			lines.push({ width: 0 });
			continue;
		}

		for (const unit of units) {
			const unitWidth = estimateGlyphWidth(unit, fontSize);
			if (currentWidth > 0 && currentWidth + unitWidth > availableWidth) {
				lines.push({ width: currentWidth });
				currentWidth = unitWidth;
			} else {
				currentWidth += unitWidth;
			}
		}

		lines.push({ width: currentWidth });
	}

	return lines.length ? lines : [{ width: 0 }];
}

export function estimateTextLayerFit(layer: TextLayer): TextLayerFitEstimate {
	const text = (layer.text ?? "").trim();
	const fontSize = Number.isFinite(layer.fontSize) ? Math.max(1, layer.fontSize) : 24;
	const strokeWidth = Math.max(0, layer.effects?.stroke?.enabled ? layer.effects.stroke.width : (layer.strokeWidth ?? 0));
	const boxWidth = Number.isFinite(layer.w) ? Math.max(0, layer.w) : 0;
	const boxHeight = Number.isFinite(layer.h) ? Math.max(0, layer.h) : 0;
	const availableWidth = Math.max(1, boxWidth - strokeWidth * 2);
	const availableHeight = Math.max(1, boxHeight - strokeWidth * 2);

	if (!text || availableWidth <= 1 || availableHeight <= 1) {
		return {
			fits: true,
			lineCount: 0,
			estimatedWidth: 0,
			estimatedHeight: 0,
			availableWidth,
			availableHeight,
		};
	}

	const lines = wrapTextToEstimatedLines(text, availableWidth, fontSize);
	const estimatedWidth = Math.max(...lines.map((line) => line.width));
	const estimatedHeight = lines.length * fontSize * DEFAULT_LINE_HEIGHT + strokeWidth * 2;
	const fits = (
		estimatedWidth <= boxWidth * WIDTH_OVERFLOW_TOLERANCE
		&& estimatedHeight <= boxHeight * HEIGHT_OVERFLOW_TOLERANCE
	);

	return {
		fits,
		lineCount: lines.length,
		estimatedWidth,
		estimatedHeight,
		availableWidth,
		availableHeight,
	};
}
