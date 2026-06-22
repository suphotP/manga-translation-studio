// Thai word wrap — char-level wrapping (Thai has no spaces between words)

export function wrapThaiText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	fontSize: number,
	fontFamily: string
): string[] {
	ctx.font = `${fontSize}px "${fontFamily}"`;

	const lines: string[] = [];
	let currentLine = "";

	for (const char of text) {
		const testLine = currentLine + char;
		const metrics = ctx.measureText(testLine);

		if (metrics.width > maxWidth && currentLine.length > 0) {
			lines.push(currentLine);
			currentLine = char;
		} else {
			currentLine = testLine;
		}
	}

	if (currentLine) lines.push(currentLine);
	return lines;
}

// Binary search for best font size that fits text in box
export function findBestFontSize(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxHeight: number,
	fontFamily: string,
	lineHeight = 1.3
): number {
	let lo = 8;
	let hi = 300;

	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		ctx.font = `${mid}px "${fontFamily}"`;

		const lines = wrapThaiText(ctx, text, maxWidth, mid, fontFamily);
		const totalHeight = lines.length * mid * lineHeight;

		if (totalHeight <= maxHeight && lines.every((l) => ctx.measureText(l).width <= maxWidth)) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}

	return lo;
}
