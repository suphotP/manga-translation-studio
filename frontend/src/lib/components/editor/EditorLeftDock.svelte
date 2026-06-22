<!-- EditorLeftDock — Photopea-style vertical tool dock.
	W3.1: reads tools from the ToolRegistry (so W3.13 can register the 8 image
	tools here), groups them with separators, shows tooltips + keyboard-shortcut
	hints, and highlights the active dock tool.

	Engine-safe: activation is delegated through a ToolActivationContext built
	from editorStore/editorUiStore. This component never reaches into Fabric. -->
<script lang="ts">
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { _ } from "$lib/i18n";
	import { TOOL_ICONS, toolIconPath } from "$lib/editor-ui/tool-icons";
	import {
		dockToolIdForEngineTool,
		isImageEditToolId,
		toolRegistry,
		type ToolActivationContext,
		type ToolDefinition,
		type ToolId,
	} from "$lib/editor/tool-registry.svelte.js";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";

	// Duty-filtered palette (2026-06-13): each member sees only the tools of
	// their duty on the OPEN chapter — คนคลีนเห็นชุดคลีน คนลงคำเห็นชุดตัวอักษร.
	// Chapter-team override → studio role → account role; backend still
	// authorizes every mutation, this only stops advertising foreign duties.
	let dutyCapabilities = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	let groups = $derived(
		toolRegistry.grouped()
			.map((bucket) => ({
				...bucket,
				tools: bucket.tools.filter((def) => !def.capability || dutyCapabilities[def.capability]),
			}))
			.filter((bucket) => bucket.tools.length > 0),
	);
	// If the duty filter hides the currently-active tool (e.g. a translator
	// arriving with brush persisted), fall back to the universal select tool.
	$effect(() => {
		const visible = new Set(groups.flatMap((bucket) => bucket.tools.map((def) => def.id)));
		if (!visible.has(activeToolId)) {
			const selectDef = toolRegistry.get("select");
			if (selectDef) activate(selectDef);
		}
	});
	// The Fabric engine tool is the source of truth. The dock highlight follows it,
	// but the engine "cover" tool is shared by crop + AI, so when the engine tool
	// still matches the dock's chosen tool we keep that disambiguated id (e.g. keep
	// "crop" highlighted instead of snapping back to "cover"). This keeps keyboard
	// shortcuts (V/T/B) and programmatic tool changes in sync with the dock.
	let activeToolId = $derived.by<ToolId>(() => {
		// W3.13: an active image-edit suite tool always wins — it runs on the
		// "select" engine tool but is the real selection in the dock.
		if (editorStore.activeImageTool) {
			return editorStore.activeImageTool;
		}
		const dockTool = editorUiStore.activeDockTool;
		const dockDef = toolRegistry.get(dockTool);
		if (dockDef && dockDef.engineTool === editorStore.currentTool) {
			return dockTool;
		}
		return dockToolIdForEngineTool(editorStore.currentTool);
	});
	// Contextual tools (delete / rotate) appear when EITHER a text layer OR an
	// image layer is selected (the keyboard-Delete handles both — the dock must too).
	let hasTextSelection = $derived(Boolean(editorStore.selectedLayer));
	let hasImageSelection = $derived(Boolean(editorStore.selectedImageLayer));
	let hasSelection = $derived(hasTextSelection || hasImageSelection);

	// Mirror the keyboard-Delete branch: delete the selected text layer, else the
	// selected image layer. Without this the dock Delete only ever removed text.
	function deleteSelectedLayer(): void {
		if (editorStore.selectedLayer) {
			editorStore.deleteTextLayer();
		} else if (editorStore.selectedImageLayer) {
			editorStore.deleteImageLayer();
		}
	}

	// Keep the canonical dock tool synced when the engine tool changes from outside
	// the dock (keyboard shortcuts like V/T/B, Esc-to-select, brush activation).
	// Crop/AI both drive "cover", so we only re-sync when the stored dock tool no
	// longer maps to the live engine tool, preserving the crop/AI disambiguation.
	$effect(() => {
		const engineTool = editorStore.currentTool;
		const activeImageTool = editorStore.activeImageTool;
		const dockDef = toolRegistry.get(editorUiStore.activeDockTool);
		// W3.13: while an image-edit tool owns the pointer, mirror it into the dock
		// state and stop — the suite (not the engine tool) is the source of truth.
		if (activeImageTool) {
			if (editorUiStore.activeDockTool !== activeImageTool) {
				editorUiStore.setActiveDockTool(activeImageTool);
			}
			return;
		}
		// No image tool active: a stale image-tool dock id must fall back to the
		// resolved engine tool (e.g. Esc left the suite → snap back to "select").
		const dockIsStaleImageTool = isImageEditToolId(editorUiStore.activeDockTool);
		if (!dockIsStaleImageTool && dockDef && dockDef.engineTool === engineTool) return;
		const resolved = dockToolIdForEngineTool(engineTool);
		if (resolved !== editorUiStore.activeDockTool) {
			editorUiStore.setActiveDockTool(resolved);
		}
	});

	function activationContext(): ToolActivationContext {
		return {
			setEngineTool: (tool) => editorStore.setTool(tool),
			setRightPanelMode: (mode) => editorUiStore.setRightPanelMode(mode),
			startTextPlacement: () => editorStore.startTextPlacement(),
			activateImageTool: (id) => editorStore.setImageTool(id),
		};
	}

	function activate(def: ToolDefinition): void {
		editorUiStore.setActiveDockTool(def.id);
		const ctx = activationContext();
		if (def.onActivate) {
			def.onActivate(ctx);
		} else {
			ctx.setEngineTool(def.engineTool);
		}
	}

	function dockToolIconPath(id: ToolId): string | null {
		return TOOL_ICONS[id] ? toolIconPath(id) : null;
	}
</script>

<nav class="editor-left-dock" aria-label={$_("editorLeftDock.navLabel")}>
	{#each groups as bucket, groupIndex (bucket.group)}
		{#if groupIndex > 0}
			<div class="dock-separator" role="separator"></div>
		{/if}
		<div class="dock-group" role="group">
			{#each bucket.tools as def (def.id)}
				{@const iconPath = dockToolIconPath(def.id)}
				<button
					type="button"
					class="dock-tool"
					class:active={activeToolId === def.id}
					aria-pressed={activeToolId === def.id}
					aria-label={def.title}
					title={def.shortcut ? `${def.title} (${def.shortcut})` : def.title}
					onclick={() => activate(def)}
				>
					<span class="dock-tool-icon" aria-hidden="true">
						{#if iconPath}
							<svg viewBox="0 0 24 24" focusable="false">
								<path d={iconPath}></path>
							</svg>
						{:else}
							{def.icon}
						{/if}
					</span>
					<span class="dock-tool-label">{def.label}</span>
					{#if def.shortcut}
						<span class="dock-tool-shortcut" aria-hidden="true">{def.shortcut}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/each}

	{#if hasSelection}
		<div class="dock-separator" role="separator"></div>
		<div class="dock-group" role="group" aria-label={$_("editorLeftDock.selectionGroupLabel")}>
			<button
				type="button"
				class="dock-tool dock-tool-danger"
				onclick={deleteSelectedLayer}
				aria-label={hasTextSelection ? $_("editorLeftDock.deleteTextLabel") : $_("editorLeftDock.deleteImageLabel")}
				title={hasTextSelection ? $_("editorLeftDock.deleteTextTitle") : $_("editorLeftDock.deleteImageTitle")}
			>
				<span class="dock-tool-icon" aria-hidden="true">×</span>
				<span class="dock-tool-label">{$_("editorLeftDock.delete")}</span>
			</button>
			{#if hasTextSelection}
				<button
					type="button"
					class="dock-tool"
					onclick={() => editorStore.rotateText()}
					aria-label={$_("editorLeftDock.rotateLabel")}
					title={$_("editorLeftDock.rotateTitle")}
				>
					<span class="dock-tool-icon" aria-hidden="true">↻</span>
					<span class="dock-tool-label">{$_("editorLeftDock.rotate")}</span>
				</button>
			{/if}
		</div>
	{/if}
</nav>

<style>
	.editor-left-dock {
		display: flex;
		height: 100%;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 8px 0;
		border-right: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface);
		overflow-y: auto;
		scrollbar-width: none;
	}

	.editor-left-dock::-webkit-scrollbar {
		display: none;
	}

	.dock-group {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		width: 100%;
	}

	.dock-separator {
		width: 28px;
		height: 1px;
		margin: 2px 0;
		background: var(--ws-hair);
		flex: 0 0 auto;
	}

	.dock-tool {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: 46px;
		height: 48px;
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		color: color-mix(in srgb, var(--color-ws-ink) 74%, transparent);
		cursor: pointer;
		font-family: inherit;
		transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
	}

	.dock-tool:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 8%, transparent);
		color: var(--color-ws-ink);
	}

	.dock-tool.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: linear-gradient(180deg, color-mix(in srgb, var(--color-ws-accent) 22%, transparent), color-mix(in srgb, var(--color-ws-accent) 12%, transparent));
		box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		color: var(--color-ws-ink);
	}

	.dock-tool-danger:hover {
		border-color: color-mix(in srgb, var(--color-ws-rose) 44%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 13%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 28%, var(--color-ws-ink) 72%);
	}

	.dock-tool-icon {
		display: grid;
		width: 16px;
		height: 16px;
		place-items: center;
		font-size: 16px;
		font-weight: 900;
		line-height: 1;
	}

	.dock-tool-icon svg {
		display: block;
		width: 16px;
		height: 16px;
		fill: none;
		stroke: color-mix(in srgb, var(--color-ws-ink) 76%, transparent);
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.9;
	}

	.dock-tool:hover .dock-tool-icon svg,
	.dock-tool.active .dock-tool-icon svg {
		stroke: var(--color-ws-ink);
	}

	.dock-tool-label {
		display: block;
		max-width: 42px;
		overflow: hidden;
		/* Token alpha keeps the small dock labels readable on the dark ws surface. */
		color: color-mix(in srgb, var(--color-ws-ink) 62%, transparent);
		font-size: 9px;
		font-weight: 760;
		line-height: 1;
		text-align: center;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dock-tool.active .dock-tool-label {
		color: color-mix(in srgb, var(--color-ws-ink) 82%, transparent);
	}

	.dock-tool-shortcut {
		position: absolute;
		top: 3px;
		right: 4px;
		font-size: 8px;
		font-weight: 800;
		/* Token alpha keeps keyboard hints visible without competing with labels. */
		color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent);
		letter-spacing: 0.3px;
	}

	.dock-tool.active .dock-tool-shortcut,
	.dock-tool:hover .dock-tool-shortcut {
		color: color-mix(in srgb, var(--color-ws-accent) 80%, var(--color-ws-ink) 20%);
	}

	/* ── Mobile tool dock (≤640px) ───────────────────────────────────────────
	   The dock lives in its own grid column, so it never overlaps the canvas or
	   top bar — but keep it from eating the narrow phone canvas: fit the tools to
	   the ~56px mobile column, hide the keyboard-shortcut badges (no keyboard on a
	   phone) + the per-tool labels, and let it scroll vertically within the column.
	   Tap targets stay ≥40px. Desktop is untouched (this only fires on phones). */
	@media (max-width: 640px) {
		.editor-left-dock {
			gap: 4px;
			padding: 6px 0;
		}

		.dock-tool {
			width: 44px;
			height: 44px;
			gap: 1px;
		}

		.dock-tool-icon {
			width: 15px;
			height: 15px;
			font-size: 15px;
		}

		.dock-tool-icon svg {
			width: 15px;
			height: 15px;
		}

		.dock-tool-label {
			display: none;
		}

		.dock-tool-shortcut {
			display: none;
		}

		.dock-separator {
			width: 22px;
		}
	}
</style>
