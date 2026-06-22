<script lang="ts">
	import { _ } from "$lib/i18n";
	import type {
		AdjustmentsToolOptions,
		PartialAdjustmentsToolOptions,
	} from "$lib/editor/tools/adjustments-tool.ts";

	type Props = {
		options: AdjustmentsToolOptions;
		canApply: boolean;
		busy?: boolean;
		setOptions: (next: PartialAdjustmentsToolOptions, shouldPreview?: boolean) => boolean;
		preview: (next?: PartialAdjustmentsToolOptions) => boolean;
		commit: () => Promise<boolean> | boolean;
		cancel: () => boolean;
	};

	let {
		options,
		canApply,
		busy = false,
		setOptions,
		preview,
		commit,
		cancel,
	}: Props = $props();

	const NEUTRAL_OPTIONS: PartialAdjustmentsToolOptions = {
		brightness: 0,
		contrast: 0,
		levels: {
			inBlack: 0,
			inWhite: 255,
			gamma: 1,
			outBlack: 0,
			outWhite: 255,
		},
		hsl: {
			hue: 0,
			saturation: 0,
			lightness: 0,
		},
	};

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let statusMessage = $state(msg("adjustments.statusLive", "พรีวิวสด"));
	let isCommitting = $state(false);
	let actionBusy = $derived(busy || isCommitting);
	let levelBlackMax = $derived(Math.max(0, Math.min(254, options.levels.inWhite - 1)));
	let levelWhiteMin = $derived(Math.min(255, Math.max(1, options.levels.inBlack + 1)));

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function readRange(event: Event): number {
		const input = event.currentTarget as HTMLInputElement;
		return input.valueAsNumber;
	}

	function applyOptions(next: PartialAdjustmentsToolOptions): void {
		if (!canApply || actionBusy) return;
		const updated = setOptions(next, false);
		const previewed = updated && preview();
		statusMessage = previewed ? msg("adjustments.statusPreviewed", "พรีวิวแล้ว") : msg("adjustments.statusPreviewFailed", "ยังพรีวิวไม่ได้");
	}

	function setBrightness(event: Event): void {
		applyOptions({ brightness: Math.round(clamp(readRange(event), -100, 100)) });
	}

	function setContrast(event: Event): void {
		applyOptions({ contrast: Math.round(clamp(readRange(event), -100, 100)) });
	}

	function setLevelBlack(event: Event): void {
		applyOptions({
			levels: {
				inBlack: Math.round(clamp(readRange(event), 0, levelBlackMax)),
			},
		});
	}

	function setLevelWhite(event: Event): void {
		applyOptions({
			levels: {
				inWhite: Math.round(clamp(readRange(event), levelWhiteMin, 255)),
			},
		});
	}

	function setLevelGamma(event: Event): void {
		applyOptions({
			levels: {
				gamma: Math.round(clamp(readRange(event), 0.1, 3) * 100) / 100,
			},
		});
	}

	function setSaturation(event: Event): void {
		applyOptions({
			hsl: {
				saturation: Math.round(clamp(readRange(event), -100, 100)),
			},
		});
	}

	async function commitPreview(): Promise<void> {
		if (!canApply || actionBusy) return;
		isCommitting = true;
		statusMessage = msg("adjustments.statusSaving", "กำลังบันทึก");
		try {
			const committed = await commit();
			statusMessage = committed ? msg("adjustments.statusSaved", "บันทึกแล้ว") : msg("adjustments.statusNothing", "ไม่มีค่าที่ต้องบันทึก");
		} catch {
			statusMessage = msg("adjustments.statusSaveFailed", "บันทึกไม่สำเร็จ");
		} finally {
			isCommitting = false;
		}
	}

	function cancelPreview(): void {
		if (!canApply || actionBusy) return;
		const canceled = cancel();
		statusMessage = canceled ? msg("adjustments.statusCanceled", "ยกเลิกพรีวิวแล้ว") : msg("adjustments.statusNoPreview", "ไม่มีพรีวิวค้าง");
	}

	function resetPreview(): void {
		if (!canApply || actionBusy) return;
		setOptions(NEUTRAL_OPTIONS, false);
		preview();
		statusMessage = msg("adjustments.statusReset", "รีเซ็ตแล้ว");
	}

	function signed(value: number): string {
		if (value > 0) return `+${value}`;
		return `${value}`;
	}
</script>

<section class="adjustments-panel" aria-label={msg("adjustments.title", "ปรับแสงสี")} aria-busy={actionBusy}>
	<span class="adjustments-badge">◑ {msg("adjustments.title", "ปรับแสงสี")}</span>

	{#if canApply}
		<div class="adjustments-controls" role="group" aria-label="Adjustments sliders">
			<label class="adjustment-control">
				<span>{msg("adjustments.brightness", "สว่าง")}</span>
				<input
					type="range"
					min="-100"
					max="100"
					step="1"
					value={options.brightness}
					aria-label="Brightness"
					oninput={setBrightness}
				/>
				<output>{signed(options.brightness)}</output>
			</label>

			<label class="adjustment-control">
				<span>{msg("adjustments.contrast", "คอนทราสต์")}</span>
				<input
					type="range"
					min="-100"
					max="100"
					step="1"
					value={options.contrast}
					aria-label="Contrast"
					oninput={setContrast}
				/>
				<output>{signed(options.contrast)}</output>
			</label>

			<label class="adjustment-control">
				<span>{msg("adjustments.black", "ดำ")}</span>
				<input
					type="range"
					min="0"
					max={levelBlackMax}
					step="1"
					value={Math.min(options.levels.inBlack, levelBlackMax)}
					aria-label="Levels black point"
					oninput={setLevelBlack}
				/>
				<output>{options.levels.inBlack}</output>
			</label>

			<label class="adjustment-control">
				<span>{msg("adjustments.white", "ขาว")}</span>
				<input
					type="range"
					min={levelWhiteMin}
					max="255"
					step="1"
					value={Math.max(options.levels.inWhite, levelWhiteMin)}
					aria-label="Levels white point"
					oninput={setLevelWhite}
				/>
				<output>{options.levels.inWhite}</output>
			</label>

			<label class="adjustment-control gamma-control">
				<span>{msg("adjustments.gamma", "แกมมา")}</span>
				<input
					type="range"
					min="0.1"
					max="3"
					step="0.05"
					value={options.levels.gamma}
					aria-label="Levels gamma"
					oninput={setLevelGamma}
				/>
				<output>{options.levels.gamma.toFixed(2)}</output>
			</label>

			<label class="adjustment-control">
				<span>{msg("adjustments.saturation", "สีสด")}</span>
				<input
					type="range"
					min="-100"
					max="100"
					step="1"
					value={options.hsl.saturation}
					aria-label="Saturation"
					oninput={setSaturation}
				/>
				<output>{signed(options.hsl.saturation)}%</output>
			</label>
		</div>

		<div class="adjustments-actions" aria-label="Adjustments actions">
			<button type="button" class="panel-action primary" onclick={commitPreview}>
				{msg("adjustments.save", "บันทึก")}
			</button>
			<button type="button" class="panel-action" onclick={cancelPreview}>
				{msg("adjustments.cancel", "ยกเลิก")}
			</button>
			<button type="button" class="panel-action" onclick={resetPreview}>
				{msg("adjustments.reset", "รีเซ็ต")}
			</button>
			<span class="adjustments-status" role="status">{statusMessage}</span>
		</div>
	{:else}
		<span class="adjustments-empty" role="status">
			{msg("adjustments.needImage", "เปิดหน้าที่มีรูปก่อนใช้ปรับแสงสี")}
		</span>
	{/if}
</section>

<style>
	.adjustments-panel {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		height: 100%;
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}

	.adjustments-badge,
	.adjustments-empty,
	.adjustments-status {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		border-radius: var(--radius-ws-ctrl);
		white-space: nowrap;
		font-size: 11px;
		font-weight: 800;
	}

	.adjustments-badge {
		flex: 0 0 auto;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-accent);
	}

	.adjustments-controls {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.adjustment-control {
		display: inline-grid;
		grid-template-columns: auto 96px minmax(38px, auto);
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, var(--color-ws-bg));
		color: var(--color-ws-text);
	}

	.gamma-control {
		grid-template-columns: auto 86px minmax(44px, auto);
	}

	.adjustment-control span {
		font-size: 11px;
		font-weight: 800;
		white-space: nowrap;
	}

	.adjustment-control input {
		width: 100%;
		min-width: 0;
		accent-color: var(--color-ws-accent);
	}

	.adjustment-control input:focus-visible,
	.panel-action:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.adjustment-control output {
		min-width: 0;
		text-align: right;
		font-size: 11px;
		font-weight: 850;
		color: var(--color-ws-ink);
		white-space: nowrap;
	}

	.adjustments-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
	}

	.panel-action {
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--color-ws-surface2);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
	}

	.panel-action:hover {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, var(--color-ws-accent));
	}

	.panel-action.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}

	.adjustments-status {
		max-width: 120px;
		padding: 0 8px;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--color-ws-faint);
	}

	.adjustments-empty {
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		background: var(--color-ws-surface2);
		color: var(--color-ws-faint);
	}
</style>
