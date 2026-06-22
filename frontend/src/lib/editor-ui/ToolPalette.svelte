<script lang="ts">
	export interface ToolPaletteTool {
		id: string;
		label: string;
		icon: string;
		kbd?: string | null;
		group: string;
	}

	interface ToolGroup {
		group: string;
		tools: readonly ToolPaletteTool[];
	}

	interface Props {
		tools: readonly ToolPaletteTool[];
		activeId: string | null;
		onPick: (id: string) => void;
		ariaLabel?: string;
	}

	let {
		tools,
		activeId,
		onPick,
		ariaLabel = "แถบเครื่องมือแก้หน้า",
	}: Props = $props();

	// Preserve caller order while splitting only when the group changes.
	let groupedTools = $derived.by<ToolGroup[]>(() => {
		const groups: ToolGroup[] = [];
		for (const tool of tools) {
			const groupName = tool.group.trim() || "ทั่วไป";
			const previous = groups.at(-1);
			if (previous?.group === groupName) {
				groups[groups.length - 1] = {
					group: previous.group,
					tools: [...previous.tools, tool],
				};
				continue;
			}
			groups.push({ group: groupName, tools: [tool] });
		}
		return groups;
	});

	function shortcutFor(tool: ToolPaletteTool): string {
		return tool.kbd?.trim() ?? "";
	}

	function tooltipFor(tool: ToolPaletteTool): string {
		const shortcut = shortcutFor(tool);
		return shortcut ? `${tool.label} (${shortcut})` : tool.label;
	}

	function groupLabel(group: string): string {
		return group === "ทั่วไป" ? "กลุ่มเครื่องมือทั่วไป" : `กลุ่มเครื่องมือ ${group}`;
	}
</script>

<div class="tool-palette" role="toolbar" aria-orientation="vertical" aria-label={ariaLabel}>
	{#if groupedTools.length === 0}
		<span class="sr-only" role="status">ไม่มีเครื่องมือในแถบนี้</span>
	{:else}
		{#each groupedTools as bucket, groupIndex (bucket.group + groupIndex)}
			{#if groupIndex > 0}
				<div class="tool-separator" role="separator" aria-orientation="horizontal"></div>
			{/if}
			<div class="tool-group" role="group" aria-label={groupLabel(bucket.group)}>
				{#each bucket.tools as tool (tool.id)}
					{@const shortcut = shortcutFor(tool)}
					{@const isActive = activeId === tool.id}
					<button
						type="button"
						class="tool-button"
						class:active={isActive}
						aria-label={tool.label}
						aria-pressed={isActive}
						aria-keyshortcuts={shortcut || undefined}
						title={tooltipFor(tool)}
						data-tool-id={tool.id}
						data-tool-group={bucket.group}
						onclick={() => onPick(tool.id)}
					>
						<span class="tool-icon" aria-hidden="true">
							<svg viewBox="0 0 24 24" focusable="false">
								<path d={tool.icon}></path>
							</svg>
						</span>
						{#if shortcut}
							<span class="tool-kbd" aria-hidden="true">{shortcut}</span>
						{/if}
					</button>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.tool-palette {
		display: flex;
		width: 44px;
		min-width: 44px;
		max-width: 44px;
		height: 100%;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 8px 0;
		border-right: 1px solid var(--ws-hair);
		background: var(--color-ws-surface);
		color: var(--color-ws-text);
		font-family: var(--font-ws-sans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
		overflow-y: auto;
		scrollbar-width: none;
	}

	.tool-palette::-webkit-scrollbar {
		display: none;
	}

	.tool-group {
		display: flex;
		width: 100%;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.tool-separator {
		width: 28px;
		height: 1px;
		flex: 0 0 auto;
		background: var(--ws-hair-strong);
	}

	.tool-button {
		position: relative;
		display: inline-flex;
		width: 40px;
		min-width: 40px;
		height: 42px;
		min-height: 42px;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font: inherit;
		transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
	}

	.tool-button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink);
	}

	.tool-button:focus-visible {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 2px;
	}

	.tool-button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 68%, transparent);
		background:
			linear-gradient(180deg,
				color-mix(in srgb, var(--color-ws-accent) 26%, transparent),
				color-mix(in srgb, var(--color-ws-accent) 14%, transparent)
			);
		box-shadow:
			inset 3px 0 0 var(--color-ws-accent),
			0 0 0 1px color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-ink);
	}

	.tool-icon {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
	}

	.tool-icon svg {
		display: block;
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.9;
	}

	.tool-kbd {
		position: absolute;
		top: 3px;
		right: 4px;
		max-width: 24px;
		overflow: hidden;
		color: color-mix(in srgb, var(--color-ws-ink) 58%, transparent);
		font-size: 8px;
		font-weight: 800;
		line-height: 1;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tool-button.active .tool-kbd,
	.tool-button:hover .tool-kbd {
		color: color-mix(in srgb, var(--color-ws-accent) 72%, var(--color-ws-ink) 28%);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		border: 0;
		white-space: nowrap;
	}
</style>
