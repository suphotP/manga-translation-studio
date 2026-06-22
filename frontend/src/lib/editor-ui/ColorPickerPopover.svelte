<script lang="ts">
	import { _ } from "$lib/i18n";

	interface Props {
		color: string;
		onPick: (hex: string) => void;
		recent: string[];
		open: boolean;
		onClose: () => void;
		label?: string;
		title?: string;
		ariaLabel?: string;
	}

	interface RgbColor {
		r: number;
		g: number;
		b: number;
	}

	interface HsvColor {
		h: number;
		s: number;
		v: number;
	}

		function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		color,
		onPick,
		recent,
		open,
		onClose,
		label = undefined,
		title = undefined,
		ariaLabel = undefined,
	}: Props = $props();

	const fallbackColor = rgbToHex({ r: 0, g: 0, b: 0 });
	const defaultBackgroundColor = rgbToHex({ r: 255, g: 255, b: 255 });

	let backgroundColor = $state(defaultBackgroundColor);

	let normalizedColor = $derived(normalizeHex(color) ?? fallbackColor);
	let hexDraft = $derived(normalizedColor);
	// Hue is INDEPENDENT state, not derived: grayscale hex (s=0 or v=0) carries
	// no hue information, so deriving hue from the color would silently discard
	// a hue-bar pick made while on black/white/gray (codex P2). The derived HSV
	// supplies s/v; `hueState` is updated by the hue bar and re-synced from the
	// color only when the color itself encodes a real hue.
	let derivedHsv = $derived(hexToHsv(normalizedColor));
	let hueState = $state(0);
	$effect(() => {
		if (derivedHsv.s > 0 && derivedHsv.v > 0) hueState = derivedHsv.h;
	});
	let currentHsv = $derived({ h: hueState, s: derivedHsv.s, v: derivedHsv.v });
	let validRecent = $derived.by(() => uniqueColors(recent));
	let svMarkerLeft = $derived(`${Math.round(currentHsv.s * 100)}%`);
	let svMarkerTop = $derived(`${Math.round((1 - currentHsv.v) * 100)}%`);
	let hueMarkerLeft = $derived(`${Math.round((currentHsv.h / 360) * 100)}%`);
	let hueLabel = $derived(`${Math.round(currentHsv.h)}°`);
	let svLabel = $derived(`S ${Math.round(currentHsv.s * 100)} V ${Math.round(currentHsv.v * 100)}`);

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function normalizeHex(input: string | undefined): string | null {
		if (!input) return null;
		const trimmed = input.trim();
		if (!trimmed) return null;
		const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
		if (/^#[0-9a-fA-F]{3}$/.test(withHash)) {
			const [, r, g, b] = withHash;
			return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
		}
		if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
			return withHash.toUpperCase();
		}
		return null;
	}

	function uniqueColors(colors: readonly string[]): string[] {
		const seen: string[] = [];
		const normalized: string[] = [];
		for (const entry of colors) {
			const hex = normalizeHex(entry);
			if (hex && !seen.includes(hex)) {
				seen.push(hex);
				normalized.push(hex);
			}
		}
		return normalized.slice(0, 10);
	}

	function hexToRgb(hex: string): RgbColor {
		const clean = hex.slice(1);
		return {
			r: parseInt(clean.slice(0, 2), 16),
			g: parseInt(clean.slice(2, 4), 16),
			b: parseInt(clean.slice(4, 6), 16),
		};
	}

	function rgbToHex({ r, g, b }: RgbColor): string {
		const toHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
	}

	function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
		const rn = r / 255;
		const gn = g / 255;
		const bn = b / 255;
		const max = Math.max(rn, gn, bn);
		const min = Math.min(rn, gn, bn);
		const delta = max - min;

		let h = 0;
		if (delta > 0) {
			if (max === rn) {
				h = 60 * (((gn - bn) / delta) % 6);
			} else if (max === gn) {
				h = 60 * ((bn - rn) / delta + 2);
			} else {
				h = 60 * ((rn - gn) / delta + 4);
			}
		}

		return {
			h: h < 0 ? h + 360 : h,
			s: max === 0 ? 0 : delta / max,
			v: max,
		};
	}

	function hsvToRgb({ h, s, v }: HsvColor): RgbColor {
		const hue = ((h % 360) + 360) % 360;
		const c = v * s;
		const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
		const m = v - c;

		let rn = 0;
		let gn = 0;
		let bn = 0;
		if (hue < 60) {
			rn = c;
			gn = x;
		} else if (hue < 120) {
			rn = x;
			gn = c;
		} else if (hue < 180) {
			gn = c;
			bn = x;
		} else if (hue < 240) {
			gn = x;
			bn = c;
		} else if (hue < 300) {
			rn = x;
			bn = c;
		} else {
			rn = c;
			bn = x;
		}

		return {
			r: (rn + m) * 255,
			g: (gn + m) * 255,
			b: (bn + m) * 255,
		};
	}

	function hexToHsv(hex: string): HsvColor {
		return rgbToHsv(hexToRgb(hex));
	}

	function hsvToHex(hsv: HsvColor): string {
		return rgbToHex(hsvToRgb(hsv));
	}

	function pick(nextHex: string): void {
		const normalized = normalizeHex(nextHex);
		if (!normalized) return;
		hexDraft = normalized;
		onPick(normalized);
	}

	function commitHex(): void {
		const normalized = normalizeHex(hexDraft);
		if (normalized) {
			pick(normalized);
			return;
		}
		hexDraft = normalizedColor;
	}

	function readPointerRatio(event: PointerEvent, axis: "x" | "y"): number {
		const element = event.currentTarget as HTMLElement;
		const rect = element.getBoundingClientRect();
		const size = axis === "x" ? rect.width : rect.height;
		const start = axis === "x" ? rect.left : rect.top;
		const point = axis === "x" ? event.clientX : event.clientY;
		if (size <= 0) return 0;
		return clamp((point - start) / size, 0, 1);
	}

	function updateSvFromPointer(event: PointerEvent): void {
		const s = readPointerRatio(event, "x");
		const v = 1 - readPointerRatio(event, "y");
		pick(hsvToHex({ h: currentHsv.h, s, v }));
	}

	function updateHueFromPointer(event: PointerEvent): void {
		const h = readPointerRatio(event, "x") * 360;
		// Remember the hue even when the resulting hex is still grayscale — the
		// next SV pick applies it instead of snapping back to red (h=0).
		hueState = h;
		pick(hsvToHex({ h, s: currentHsv.s, v: currentHsv.v }));
	}

	function startSvDrag(event: PointerEvent): void {
		event.preventDefault();
		(event.currentTarget as HTMLElement).focus();
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		updateSvFromPointer(event);
	}

	function startHueDrag(event: PointerEvent): void {
		event.preventDefault();
		(event.currentTarget as HTMLElement).focus();
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		updateHueFromPointer(event);
	}

	function continueSvDrag(event: PointerEvent): void {
		if (event.buttons === 1) updateSvFromPointer(event);
	}

	function continueHueDrag(event: PointerEvent): void {
		if (event.buttons === 1) updateHueFromPointer(event);
	}

	function adjustSv(event: KeyboardEvent): void {
		const step = event.shiftKey ? 0.1 : 0.02;
		let next = currentHsv;
		if (event.key === "ArrowRight") {
			next = { ...next, s: clamp(next.s + step, 0, 1) };
		} else if (event.key === "ArrowLeft") {
			next = { ...next, s: clamp(next.s - step, 0, 1) };
		} else if (event.key === "ArrowUp") {
			next = { ...next, v: clamp(next.v + step, 0, 1) };
		} else if (event.key === "ArrowDown") {
			next = { ...next, v: clamp(next.v - step, 0, 1) };
		} else {
			return;
		}
		event.preventDefault();
		pick(hsvToHex(next));
	}

	function adjustHue(event: KeyboardEvent): void {
		const step = event.shiftKey ? 15 : 5;
		let hue = currentHsv.h;
		if (event.key === "ArrowRight" || event.key === "ArrowUp") {
			hue += step;
		} else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
			hue -= step;
		} else if (event.key === "Home") {
			hue = 0;
		} else if (event.key === "End") {
			hue = 360;
		} else {
			return;
		}
		event.preventDefault();
		pick(hsvToHex({ ...currentHsv, h: ((hue % 360) + 360) % 360 }));
	}

	function swapForegroundBackground(): void {
		const previousForeground = normalizedColor;
		pick(backgroundColor);
		backgroundColor = previousForeground;
	}

	function handlePanelKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.stopPropagation();
			onClose();
		}
	}
</script>

{#if open}
	<div class="color-popover" role="dialog" aria-label={ariaLabel ?? msg("colorPicker.pickerAria", "ตัวเลือกสี")} tabindex="-1" onkeydown={handlePanelKeydown}>
		<header class="picker-header">
			<div>
				<p class="eyebrow">{label ?? msg("colorPicker.textLabel", "สีตัวอักษร")}</p>
				<h2>{title ?? msg("colorPicker.pick", "เลือกสี")}</h2>
			</div>
			<button type="button" class="icon-button" aria-label={msg("colorPicker.close", "ปิดตัวเลือกสี")} onclick={onClose}>×</button>
		</header>

		<div class="active-strip" aria-label={msg("colorPicker.activeStrip", "สีหน้าและสีหลัง")}>
			<div class="swatch-stack" aria-hidden="true">
				<span class="back-swatch" style:background-color={backgroundColor}></span>
				<span class="front-swatch" style:background-color={normalizedColor}></span>
			</div>
			<div class="active-copy">
				<span>{msg("colorPicker.current", "สีปัจจุบัน")}</span>
				<strong>{normalizedColor}</strong>
			</div>
			<button
				type="button"
				class="swap-button"
				aria-label={msg("colorPicker.swapAria", "สลับสีหน้าและสีหลัง สีหลัง {color}").replace("{color}", backgroundColor)}
				onclick={swapForegroundBackground}
			>
				⇄
			</button>
		</div>

		<div
			class="sv-square"
			role="slider"
			tabindex="0"
			aria-label={msg("colorPicker.svArea", "พื้นที่เลือกความสดและความสว่าง")}
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(currentHsv.s * 100)}
			aria-valuetext={svLabel}
			style={`--picker-hue:${currentHsv.h}; --sv-x:${svMarkerLeft}; --sv-y:${svMarkerTop};`}
			onpointerdown={startSvDrag}
			onpointermove={continueSvDrag}
			onkeydown={adjustSv}
		>
			<span class="sv-marker" aria-hidden="true"></span>
		</div>

		<div
			class="hue-slider"
			role="slider"
			tabindex="0"
			aria-label={msg("colorPicker.hueBar", "แถบเลือกเฉดสี")}
			aria-valuemin="0"
			aria-valuemax="360"
			aria-valuenow={Math.round(currentHsv.h)}
			aria-valuetext={hueLabel}
			style={`--hue-x:${hueMarkerLeft};`}
			onpointerdown={startHueDrag}
			onpointermove={continueHueDrag}
			onkeydown={adjustHue}
		>
			<span class="hue-marker" aria-hidden="true"></span>
		</div>

		<label class="hex-field">
			<span>{msg("colorPicker.hexValue", "ค่า Hex")}</span>
			<input
				type="text"
				bind:value={hexDraft}
				onblur={commitHex}
				onkeydown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commitHex();
					}
				}}
				aria-label={msg("colorPicker.hexValue", "ค่า Hex")}
				maxlength="7"
				spellcheck="false"
			/>
		</label>

		{#if validRecent.length > 0}
			<div class="recent-group">
				<span>{msg("colorPicker.recent", "สีล่าสุด")}</span>
				<div class="recent-grid" role="listbox" aria-label={msg("colorPicker.recent", "สีล่าสุด")}>
					{#each validRecent as recentColor (recentColor)}
						<button
							type="button"
							role="option"
							aria-label={`เลือกสี ${recentColor}`}
							aria-selected={recentColor === normalizedColor}
							class:active={recentColor === normalizedColor}
							style:background-color={recentColor}
							onclick={() => pick(recentColor)}
						></button>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.color-popover {
		width: min(300px, calc(100vw - 24px));
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 64%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 94%, var(--color-ws-bg) 6%);
		box-shadow: 0 20px 44px color-mix(in srgb, var(--color-ws-bg) 34%, transparent);
		color: var(--color-ws-ink);
	}

	.picker-header,
	.active-strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.picker-header {
		margin-bottom: 10px;
	}

	.eyebrow,
	.active-copy span,
	.hex-field span,
	.recent-group > span {
		margin: 0;
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0;
	}

	h2 {
		margin: 2px 0 0;
		font-size: 15px;
		line-height: 1.2;
	}

	.icon-button,
	.swap-button,
	.recent-grid button {
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		color: inherit;
		cursor: pointer;
		font: inherit;
		touch-action: manipulation;
	}

	.icon-button,
	.swap-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: 7px;
		font-size: 17px;
		font-weight: 800;
		line-height: 1;
	}

	.icon-button:hover,
	.icon-button:focus-visible,
	.swap-button:hover,
	.swap-button:focus-visible,
	.recent-grid button:hover,
	.recent-grid button:focus-visible {
		border-color: color-mix(in srgb, var(--color-ws-accent) 70%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		outline: none;
	}

	.active-strip {
		margin-bottom: 12px;
		padding: 9px;
		border: 1px solid var(--ws-hair);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.swatch-stack {
		position: relative;
		width: 40px;
		height: 34px;
		flex: 0 0 auto;
	}

	.back-swatch,
	.front-swatch {
		position: absolute;
		width: 25px;
		height: 25px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 42%, transparent);
		border-radius: 6px;
		box-shadow: 0 5px 14px color-mix(in srgb, var(--color-ws-bg) 28%, transparent);
	}

	.back-swatch {
		right: 0;
		bottom: 0;
	}

	.front-swatch {
		top: 0;
		left: 0;
	}

	.active-copy {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 2px;
	}

	.active-copy strong {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
		font-size: 13px;
		letter-spacing: 0;
	}

	.sv-square,
	.hue-slider {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--ws-hair-strong);
		cursor: crosshair;
		touch-action: none;
	}

	.sv-square:focus-visible,
	.hue-slider:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
		outline-offset: 2px;
	}

	.sv-square {
		height: 150px;
		border-radius: 8px;
		background:
			linear-gradient(to top, black, transparent),
			linear-gradient(to right, white, hsl(var(--picker-hue) 100% 50%));
	}

	.sv-marker,
	.hue-marker {
		position: absolute;
		display: block;
		border: 2px solid var(--color-ws-ink);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--color-ws-bg) 78%, transparent),
			0 6px 12px color-mix(in srgb, var(--color-ws-bg) 28%, transparent);
		pointer-events: none;
	}

	.sv-marker {
		left: var(--sv-x);
		top: var(--sv-y);
		width: 14px;
		height: 14px;
		border-radius: 999px;
		transform: translate(-50%, -50%);
	}

	.hue-slider {
		height: 22px;
		margin-top: 10px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			red 0%,
			yellow 16.67%,
			lime 33.33%,
			cyan 50%,
			blue 66.67%,
			magenta 83.33%,
			red 100%
		);
	}

	.hue-marker {
		left: var(--hue-x);
		top: 50%;
		width: 10px;
		height: 24px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 36%, transparent);
		transform: translate(-50%, -50%);
	}

	.hex-field {
		display: grid;
		gap: 5px;
		margin-top: 12px;
	}

	.hex-field input {
		height: 38px;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 64%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-bg) 34%, transparent);
		color: var(--color-ws-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
		font-size: 13px;
		letter-spacing: 0;
		outline: none;
		padding: 0 10px;
		text-transform: uppercase;
	}

	.hex-field input:focus {
		border-color: color-mix(in srgb, var(--color-ws-accent) 70%, transparent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-ws-accent) 20%, transparent);
	}

	.recent-group {
		display: grid;
		gap: 6px;
		margin-top: 12px;
	}

	.recent-grid {
		display: grid;
		grid-template-columns: repeat(10, minmax(0, 1fr));
		gap: 5px;
	}

	.recent-grid button {
		aspect-ratio: 1;
		min-height: 24px;
		border-radius: 6px;
	}

	.recent-grid button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 86%, var(--color-ws-ink) 14%);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
	}
</style>
