<!-- StorageStatTile — one headline metric in the storage-library summary strip
     (workspace total bytes, asset count, project count). A small, single-purpose
     atom reused across the strip so every tile lines up. ws-* tokens only. -->
<script lang="ts">
	let {
		label,
		value,
		sub = "",
		tone = "default",
	}: {
		label: string;
		value: string;
		sub?: string;
		tone?: "default" | "accent";
	} = $props();
</script>

<div class="stat-tile" class:accent={tone === "accent"}>
	<span class="stat-label">{label}</span>
	<strong class="stat-value">{value}</strong>
	{#if sub}<span class="stat-sub">{sub}</span>{/if}
</div>

<style>
	.stat-tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 16px 18px;
		border-radius: var(--radius-ws-card, 12px);
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.08));
		background: rgba(255, 255, 255, 0.025);
		min-width: 0;
	}
	.stat-tile.accent {
		border-color: rgba(124, 92, 255, 0.3);
		background: linear-gradient(100deg, rgba(124, 92, 255, 0.12), rgba(217, 70, 239, 0.05));
	}
	.stat-label {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ws-text, #9a9aa8);
	}
	.stat-value {
		font-size: clamp(20px, 2.4vw, 26px);
		font-weight: 700;
		line-height: 1.1;
		color: var(--color-ws-ink, #ececf2);
		letter-spacing: -0.01em;
	}
	.stat-sub {
		font-size: 12px;
		color: var(--color-ws-faint, #6b6b78);
	}
</style>
