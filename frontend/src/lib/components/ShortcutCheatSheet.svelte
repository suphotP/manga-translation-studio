<script lang="ts">
	import type { ShortcutGroup } from "$lib/shortcuts/shortcuts-catalog.ts";

	let {
		groups,
		keyJoinerLabel = defaultKeyJoinerLabel,
	}: {
		groups: ShortcutGroup[];
		keyJoinerLabel?: (joiner: "or" | "plus" | undefined) => string;
	} = $props();

	function defaultKeyJoinerLabel(joiner: "or" | "plus" | undefined): string {
		return joiner === "plus" ? "+" : "or";
	}
</script>

<div class="shortcuts-body">
	{#each groups as group (group.id)}
		<section class="shortcuts-group" aria-labelledby={`shortcuts-group-${group.id}`}>
			<h3 id={`shortcuts-group-${group.id}`} class="shortcuts-group-title">{group.title}</h3>
			<dl class="shortcuts-list">
				{#each group.entries as entry (entry.id)}
					<div class="shortcuts-row">
						<dt class="shortcuts-label">
							<span>{entry.label}</span>
							{#if entry.detail && entry.detail !== entry.label}
								<small>{entry.detail}</small>
							{/if}
						</dt>
						<dd class="shortcuts-keys">
							{#each entry.keys as key, ki (key)}
								{#if ki > 0}
									<span class="shortcuts-joiner" aria-hidden="true">{keyJoinerLabel(entry.joiner)}</span>
								{/if}
								<kbd class="shortcuts-kbd">{key}</kbd>
							{/each}
						</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/each}
</div>

<style>
	.shortcuts-body {
		display: grid;
		flex: 1;
		min-height: 0;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 28px;
		align-content: start;
		padding: 8px 18px 16px;
		overflow-y: auto;
	}

	.shortcuts-group {
		padding-top: 12px;
	}

	.shortcuts-group-title {
		margin: 0 0 6px;
		color: var(--color-ws-faint, #6b6b78);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.shortcuts-list {
		margin: 0;
	}

	.shortcuts-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 34px;
		padding: 4px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.shortcuts-label {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		font-size: 12.5px;
		color: var(--color-ws-ink, #ececf2);
	}

	.shortcuts-label small {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10.5px;
		font-weight: 500;
		line-height: 1.25;
	}

	.shortcuts-keys {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
		margin: 0;
	}

	.shortcuts-joiner {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 11px;
	}

	.shortcuts-kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		padding: 2px 7px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-text, #c4c4d0);
		font-size: 11px;
		font-weight: 600;
		font-family: inherit;
	}

	@media (max-width: 640px) {
		.shortcuts-body {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
