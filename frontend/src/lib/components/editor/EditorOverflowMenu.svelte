<!-- EditorOverflowMenu — a compact "⋯" popover used by the mobile editor chrome to
	tuck away non-essential controls (Open Folder, Commands, Settings, Solo/Team,
	account, language) so the top bar stays a single tidy row on phones.

	It is intentionally presentational + slot-driven: the Toolbar passes the real
	controls in as children so handlers/stores stay where they are. Hidden by CSS
	on desktop (the caller gates it behind a mobile container width), so it has zero
	effect on the existing desktop layout. -->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { _ } from "$lib/i18n";

	let {
		label = undefined,
		align = "end",
		children,
	}: {
		label?: string;
		align?: "start" | "end";
		children?: Snippet;
	} = $props();

	// Localized fallback for the overflow-trigger label when the caller omits one.
	let effectiveLabel = $derived(label ?? $_("editorOverflowMenu.more"));

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let toggleEl: HTMLButtonElement | undefined = $state();
	// The toolbar area clips overflow, so the popover is rendered position:fixed and
	// anchored to the toggle's viewport rect (escaping the clipped ancestor).
	let sheetTop = $state(0);
	let sheetRight = $state(10);

	function positionSheet(): void {
		if (!toggleEl) return;
		const r = toggleEl.getBoundingClientRect();
		sheetTop = Math.round(r.bottom + 8);
		sheetRight = Math.max(8, Math.round(window.innerWidth - r.right));
	}

	function toggle(): void {
		open = !open;
		if (open) positionSheet();
	}

	function close(): void {
		open = false;
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (!open) return;
		if (root && event.target instanceof Node && !root.contains(event.target)) {
			close();
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape" && open) {
			close();
		}
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onKeydown} />

<div class="editor-overflow" class:align-start={align === "start"} bind:this={root}>
	<button
		type="button"
		class="editor-overflow-toggle"
		class:active={open}
		data-testid="editor-overflow-toggle"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={effectiveLabel}
		title={effectiveLabel}
		bind:this={toggleEl}
		onclick={toggle}
	>
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<circle cx="5" cy="12" r="1.8" />
			<circle cx="12" cy="12" r="1.8" />
			<circle cx="19" cy="12" r="1.8" />
		</svg>
	</button>
	{#if open}
		<!-- Clicking any control inside should also close the sheet. -->
		<div
			class="editor-overflow-sheet"
			role="menu"
			aria-label={effectiveLabel}
			style={`top:${sheetTop}px;right:${sheetRight}px;`}
			onclick={close}
			onkeydown={() => {}}
			tabindex="-1"
		>
			{@render children?.()}
		</div>
	{/if}
</div>

<style>
	.editor-overflow {
		position: relative;
		display: none; /* desktop: hidden — only the mobile media query reveals it */
		align-items: center;
	}

	.editor-overflow-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		min-width: 40px;
		height: 40px;
		min-height: 40px;
		padding: 0;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.025);
		color: var(--color-ws-ink, #ececf2);
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.editor-overflow-toggle:hover,
	.editor-overflow-toggle.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
	}

	.editor-overflow-toggle svg {
		width: 20px;
		height: 20px;
		fill: currentColor;
	}

	.editor-overflow-sheet {
		position: fixed;
		top: 64px;
		right: 10px;
		z-index: 1400;
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 220px;
		max-width: min(86vw, 320px);
		max-height: 70vh;
		overflow-y: auto;
		padding: 12px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.1));
		border-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-surface, #15151D);
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 18px 44px -16px rgba(0, 0, 0, 0.7);
	}

	.editor-overflow.align-start .editor-overflow-sheet {
		right: auto;
		left: 0;
	}

	/* Lay the tucked-away controls out as full-width rows so they're easy to tap. */
	.editor-overflow-sheet :global(> *) {
		width: 100%;
		justify-content: flex-start;
	}

	/* Reveal the overflow trigger only on the narrow editor chrome. */
	@media (max-width: 640px) {
		.editor-overflow {
			display: inline-flex;
		}
	}
</style>
