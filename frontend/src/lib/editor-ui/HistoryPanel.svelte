<script lang="ts">
	import { _ } from "$lib/i18n";

	export interface HistoryEntry {
		id: string;
		label: string;
		at: Date | number | string;
	}

	interface HistoryPanelProps {
		entries?: readonly HistoryEntry[];
		currentIndex?: number;
		// A prop-level clock keeps previews/tests deterministic while production falls back to real time.
		now?: Date | number | string;
		class?: string;
		onJump: (index: number) => void;
	}

	let {
		entries = [],
		currentIndex = -1,
		now,
		class: klass = "",
		onJump,
	}: HistoryPanelProps = $props();

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let resolvedNow = $derived(toTimestamp(now) ?? Date.now());
	let hasValidCurrent = $derived(currentIndex >= 0 && currentIndex < entries.length);
	// back can reach -1 (the pre-edit baseline row, codex P2); an OUT-OF-RANGE
	// index still fails closed.
	let canGoBack = $derived(currentIndex > -1 && currentIndex < entries.length);
	let canGoForward = $derived(
		entries.length > 0 && currentIndex >= -1 && currentIndex < entries.length - 1,
	);
	let currentLabel = $derived(hasValidCurrent ? entries[currentIndex]?.label : msg("historyPanel.noCurrent", "ยังไม่มีจุดปัจจุบัน"));

	function jumpTo(index: number): void {
		// History navigation must fail closed because the real editor stack can change between renders.
		if (index < -1 || index >= entries.length || index === currentIndex) return;
		onJump(index);
	}

	function toTimestamp(value: Date | number | string | undefined): number | null {
		if (value === undefined) return null;
		const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	function formatRelativeTime(value: Date | number | string): string {
		const timestamp = toTimestamp(value);
		if (timestamp === null) return msg("historyPanel.timeUnknown", "เวลาไม่ชัดเจน");

		const elapsedMs = Math.max(0, resolvedNow - timestamp);
		const seconds = Math.floor(elapsedMs / 1000);
		if (seconds < 45) return msg("historyPanel.justNow", "เมื่อสักครู่");

		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return msg("historyPanel.minutesAgo", "{n} นาทีที่แล้ว").replace("{n}", String(minutes));

		const hours = Math.floor(minutes / 60);
		if (hours < 24) return msg("historyPanel.hoursAgo", "{n} ชั่วโมงที่แล้ว").replace("{n}", String(hours));

		const days = Math.floor(hours / 24);
		if (days < 30) return msg("historyPanel.daysAgo", "{n} วันที่แล้ว").replace("{n}", String(days));

		const months = Math.floor(days / 30);
		if (months < 12) return msg("historyPanel.monthsAgo", "{n} เดือนที่แล้ว").replace("{n}", String(months));

		return msg("historyPanel.yearsAgo", "{n} ปีที่แล้ว").replace("{n}", String(Math.floor(months / 12)));
	}
</script>

<section class={`ws-history-panel ${klass}`} aria-label={msg("historyPanel.panelAria", "ประวัติการแก้ไข")}>
	<header class="ws-history-header">
		<div class="ws-history-title-block">
			<span class="ws-history-kicker">{msg("historyPanel.kicker", "ประวัติ")}</span>
			<strong>{currentLabel}</strong>
		</div>
		<span class="ws-history-count">{msg("historyPanel.count", "{n} รายการ").replace("{n}", String(entries.length))}</span>
	</header>

	<div class="ws-history-nav" aria-label={msg("historyPanel.navAria", "นำทางประวัติ")}>
		<button
			type="button"
			class="ws-history-nav-button"
			disabled={!canGoBack}
			onclick={() => jumpTo(currentIndex - 1)}
		>
			{msg("historyPanel.back", "ย้อนกลับ")}
		</button>
		<button
			type="button"
			class="ws-history-nav-button"
			disabled={!canGoForward}
			onclick={() => jumpTo(currentIndex + 1)}
		>
			{msg("historyPanel.forward", "เดินหน้า")}
		</button>
	</div>

	{#if entries.length === 0}
		<p class="ws-history-empty">{msg("historyPanel.empty", "ยังไม่มีประวัติการแก้ไข")}</p>
	{:else}
		<ol class="ws-history-list" aria-label={msg("historyPanel.listAria", "รายการประวัติ")}>
			<li class={{ "ws-history-item": true, current: currentIndex === -1 }}>
				<button
					type="button"
					class="ws-history-row"
					aria-current={currentIndex === -1 ? "step" : undefined}
					aria-label={msg("historyPanel.baselineAria", "กลับไปจุดเริ่มต้นก่อนแก้ไข")}
					disabled={currentIndex === -1}
					onclick={() => jumpTo(-1)}
				>
					<span class="ws-history-marker" aria-hidden="true"></span>
					<span class="ws-history-copy">
						<span class="ws-history-label">{msg("historyPanel.baseline", "จุดเริ่มต้น (ก่อนแก้ไข)")}</span>
					</span>
					{#if currentIndex === -1}
						<span class="ws-history-current">{msg("historyPanel.current", "ปัจจุบัน")}</span>
					{/if}
				</button>
			</li>
			{#each entries as entry, index (entry.id)}
				{@const isCurrent = index === currentIndex}
				<li class={{ "ws-history-item": true, current: isCurrent }}>
					<button
						type="button"
						class="ws-history-row"
						aria-current={isCurrent ? "step" : undefined}
						aria-label={msg("historyPanel.jumpAria", "ไปยังประวัติ {n}: {label}").replace("{n}", String(index + 1)).replace("{label}", entry.label)}
						disabled={isCurrent}
						onclick={() => jumpTo(index)}
					>
						<span class="ws-history-marker" aria-hidden="true"></span>
						<span class="ws-history-copy">
							<span class="ws-history-label">{entry.label}</span>
							<time class="ws-history-time" datetime={String(entry.at)}>
								{formatRelativeTime(entry.at)}
							</time>
						</span>
						{#if isCurrent}
							<span class="ws-history-current">{msg("historyPanel.current", "ปัจจุบัน")}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.ws-history-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		color: var(--color-ws-ink);
	}

	.ws-history-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}

	.ws-history-title-block {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.ws-history-kicker,
	.ws-history-count,
	.ws-history-time,
	.ws-history-current {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 800;
		line-height: 1.25;
	}

	.ws-history-kicker,
	.ws-history-count,
	.ws-history-current {
		text-transform: uppercase;
	}

	.ws-history-title-block strong {
		overflow-wrap: anywhere;
		color: var(--color-ws-ink);
		font-size: 14px;
		line-height: 1.25;
	}

	.ws-history-count {
		flex: 0 0 auto;
		padding: 3px 7px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	.ws-history-nav {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.ws-history-nav-button,
	.ws-history-row {
		appearance: none;
		border: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
	}

	.ws-history-nav-button {
		min-height: 32px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 12px;
		font-weight: 850;
	}

	.ws-history-nav-button:hover:not(:disabled),
	.ws-history-row:hover:not(:disabled) {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
	}

	.ws-history-nav-button:disabled,
	.ws-history-row:disabled {
		color: var(--color-ws-faint);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.ws-history-nav-button:focus-visible,
	.ws-history-row:focus-visible {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 2px;
	}

	.ws-history-empty {
		margin: 0;
		padding: 14px 10px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 12px;
		text-align: center;
	}

	.ws-history-list {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ws-history-item {
		min-width: 0;
	}

	.ws-history-row {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 8px 10px;
		border-radius: var(--radius-ws-ctrl);
		text-align: left;
	}

	.ws-history-marker {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-ws-faint);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	.ws-history-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.ws-history-label {
		overflow-wrap: anywhere;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
		line-height: 1.25;
	}

	.ws-history-item.current .ws-history-row {
		border-color: color-mix(in srgb, var(--color-ws-accent) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 15%, transparent);
		opacity: 1;
	}

	.ws-history-item.current .ws-history-marker {
		background: var(--color-ws-accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
	}

	.ws-history-current {
		padding: 2px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-accent);
	}
</style>
