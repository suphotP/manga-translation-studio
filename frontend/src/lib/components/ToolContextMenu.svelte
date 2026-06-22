<script lang="ts">
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import {
		toolRegistry,
		type ToolDefinition,
		type ToolId,
		type ImageEditToolId,
		isImageEditToolId,
		dockToolIdForEngineTool
	} from "$lib/editor/tool-registry.svelte.js";
	import { _ } from "$lib/i18n/index.js";
	import { config } from "$lib/config.js";
	import { onMount } from "svelte";

	// Props
	let { x, y, onClose } = $props<{
		x: number;
		y: number;
		onClose: () => void;
	}>();

	let menuEl = $state<HTMLDivElement>();
	let menuWidth = $state(260);
	let menuHeight = $state(320);

	// Detect active tool ID (logical dock ID)
	let activeToolId = $derived.by<ToolId>(() => {
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

	// Get active tool definition
	let activeToolDef = $derived(toolRegistry.get(activeToolId));

	// Calculate clamped coordinates to ensure menu is fully inside viewport
	let clampedX = $derived(
		Math.max(10, Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - menuWidth - 10))
	);
	let clampedY = $derived(
		Math.max(10, Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - menuHeight - 10))
	);

	// All registered tools for quick tool switching
	// Duty filter (2026-06-13): the right-click quick-switch must not advertise
	// foreign-duty tools — same predicate as the left dock.
	let dutyCaps = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	let allTools = $derived(toolRegistry.list().filter((def) => !def.capability || dutyCaps[def.capability]));

	// Update width/height when menu is mounted or changes content
	$effect(() => {
		if (menuEl) {
			menuWidth = menuEl.offsetWidth;
			menuHeight = menuEl.offsetHeight;
		}
	});

	// Setup event listeners for closing
	onMount(() => {
		// Focus the menu container on mount so keyboard events work
		menuEl?.focus();

		function handleOutsideClick(e: MouseEvent) {
			if (menuEl && !menuEl.contains(e.target as Node)) {
				onClose();
			}
		}

		function handleGlobalKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		}

		document.addEventListener("mousedown", handleOutsideClick);
		document.addEventListener("keydown", handleGlobalKeyDown);

		return () => {
			document.removeEventListener("mousedown", handleOutsideClick);
			document.removeEventListener("keydown", handleGlobalKeyDown);
		};
	});

	// Contextual triggers
	let isBrushTool = $derived(activeToolId === "brush");
	let isHealingBrush = $derived(activeToolId === "healing-brush");
	let isCloneStamp = $derived(activeToolId === "clone-stamp");
	let isMagicWand = $derived(activeToolId === "magic-wand");
	let isColorRange = $derived(activeToolId === "color-range");
	let isRefineEdge = $derived(activeToolId === "refine-edge");
	let isCropTool = $derived(activeToolId === "crop");

	// Activate a tool from the quick-switch grid
	function selectTool(def: ToolDefinition) {
		editorUiStore.setActiveDockTool(def.id);
		const ctx = {
			setEngineTool: (tool: any) => editorStore.setTool(tool),
			setRightPanelMode: (mode: any) => editorUiStore.setRightPanelMode(mode),
			startTextPlacement: () => editorStore.startTextPlacement(),
			activateImageTool: (id: any) => editorStore.setImageTool(id),
		};

		if (def.onActivate) {
			def.onActivate(ctx);
		} else {
			ctx.setEngineTool(def.engineTool);
		}
	}

	// Tool setting handlers (re-use store setters)
	function handleBrushSizeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushSize(Number(target.value));
	}

	function handleBrushHardnessChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushHardness(Number(target.value));
	}

	function handleBrushOpacityChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushOpacity(Number(target.value));
	}

	function handleImageBrushSizeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolBrushSize(Number(target.value));
	}

	function handleImageHardnessChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolHardness(Number(target.value));
	}

	function handleImageOpacityChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolOpacity(Number(target.value));
	}

	function handleToleranceChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolTolerance(Number(target.value));
	}

	function handleInpaintRadiusChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setImageToolInpaintRadius(Number(target.value));
	}

	// Crop aspect ratios
	const aspectRatios = config.canvas.defaultAspectRatios;
	function selectAspectRatio(label: string) {
		editorStore.selectedAspectRatio = label;
		const ratio = aspectRatios[label];
		editorStore.setAspectRatio(ratio ?? null);
	}
</script>

<div
	bind:this={menuEl}
	class="tool-context-menu ws-sans ws-panel"
	style="left: {clampedX}px; top: {clampedY}px;"
	tabindex="-1"
	role="menu"
	aria-label={$_("toolContextMenu.title")}
>
	<!-- Title / Header -->
	<div class="menu-header">
		<span class="active-icon" aria-hidden="true">{activeToolDef?.icon ?? "⚙"}</span>
		<div class="title-wrap">
			<span class="menu-subtitle">{$_("toolContextMenu.title")}</span>
			<strong class="menu-title">
				{#if activeToolId === "select"}
					{$_("toolContextMenu.toolSelect")}
				{:else if activeToolId === "crop"}
					{$_("toolContextMenu.toolCrop")}
				{:else if activeToolId === "text"}
					{$_("toolContextMenu.toolText")}
				{:else if activeToolId === "brush"}
					{$_("toolContextMenu.toolBrush")}
				{:else if activeToolId === "marquee"}
					{$_("toolContextMenu.toolMarquee")}
				{:else if activeToolId === "lasso"}
					{$_("toolContextMenu.toolLasso")}
				{:else if activeToolId === "polygon-lasso"}
					{$_("toolContextMenu.toolPolyLasso")}
				{:else if activeToolId === "magic-wand"}
					{$_("toolContextMenu.toolMagicWand")}
				{:else if activeToolId === "color-range"}
					{$_("toolContextMenu.toolColorRange")}
				{:else if activeToolId === "refine-edge"}
					{$_("toolContextMenu.toolRefineEdge")}
				{:else if activeToolId === "healing-brush"}
					{$_("toolContextMenu.toolHealingBrush")}
				{:else if activeToolId === "clone-stamp"}
					{$_("toolContextMenu.toolCloneStamp")}
				{:else if activeToolId === "cover"}
					{$_("toolContextMenu.toolCover")}
				{:else}
					{activeToolDef?.label || activeToolId}
				{/if}
			</strong>
		</div>
	</div>

	<div class="menu-content">
		<!-- Active Tool Options -->
		{#if isBrushTool}
			<!-- Size -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushSize")}</span>
					<strong>{editorStore.brushSize} px</strong>
				</div>
				<input
					type="range"
					aria-label={$_("toolContextMenu.brushSize")}
					min="5"
					max="100"
					step="1"
					value={editorStore.brushSize}
					oninput={handleBrushSizeChange}
				/>
			</div>

			<!-- Hardness -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushHardness")}</span>
					<strong>{editorStore.brushHardness}%</strong>
				</div>
				<input
					type="range"
					aria-label={$_("toolContextMenu.brushHardness")}
					min="0"
					max="100"
					step="1"
					value={editorStore.brushHardness}
					oninput={handleBrushHardnessChange}
				/>
			</div>

			<!-- Opacity -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushOpacity")}</span>
					<strong>{editorStore.brushOpacity}%</strong>
				</div>
				<input
					type="range"
					aria-label={$_("toolContextMenu.brushOpacity")}
					min="0"
					max="100"
					step="1"
					value={editorStore.brushOpacity}
					oninput={handleBrushOpacityChange}
				/>
			</div>

			<!-- Brush Mode -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushMode")}</span>
				</div>
				<div class="toggle-buttons">
					<button
						type="button"
						class="toggle-btn ws-btn-ghost"
						class:active={editorStore.brushMode === "erase"}
						onclick={() => editorStore.setBrushMode("erase")}
					>
						{$_("toolContextMenu.modeErase")}
					</button>
					{#if editorStore.brushTarget.canRestore}
						<button
							type="button"
							class="toggle-btn ws-btn-ghost"
							class:active={editorStore.brushMode === "restore"}
							onclick={() => editorStore.setBrushMode("restore")}
						>
							{$_("toolContextMenu.modeRestore")}
						</button>
					{/if}
				</div>
			</div>

		{:else if isHealingBrush}
			<!-- Size -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushSize")}</span>
					<strong>{editorStore.imageToolBrushSize} px</strong>
				</div>
				<input
					type="range"
					min="1"
					max="200"
					step="1"
					aria-label={$_("toolContextMenu.brushSize")}
					value={editorStore.imageToolBrushSize}
					oninput={handleImageBrushSizeChange}
				/>
			</div>

			<!-- Respect Selection -->
			<div class="control-group checkbox-group">
				<label class="checkbox-label">
					<input
						type="checkbox"
						checked={editorStore.imageToolRespectSelection}
						onchange={(e) => editorStore.setImageToolRespectSelection(e.currentTarget.checked)}
					/>
					<span>{$_("toolContextMenu.respectSelection")}</span>
				</label>
			</div>

			<!-- Inpaint Radius -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.inpaintRadius")}</span>
					<strong>{editorStore.imageToolInpaintRadius} px</strong>
				</div>
				<input
					type="range"
					min="1"
					max="10"
					step="1"
					aria-label={$_("toolContextMenu.inpaintRadius")}
					value={editorStore.imageToolInpaintRadius}
					oninput={handleInpaintRadiusChange}
				/>
			</div>

		{:else if isCloneStamp}
			<!-- Size -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushSize")}</span>
					<strong>{editorStore.imageToolBrushSize} px</strong>
				</div>
				<input
					type="range"
					min="1"
					max="200"
					step="1"
					aria-label={$_("toolContextMenu.brushSize")}
					value={editorStore.imageToolBrushSize}
					oninput={handleImageBrushSizeChange}
				/>
			</div>

			<!-- Hardness -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushHardness")}</span>
					<strong>{editorStore.imageToolHardness}%</strong>
				</div>
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					aria-label={$_("toolContextMenu.brushHardness")}
					value={editorStore.imageToolHardness}
					oninput={handleImageHardnessChange}
				/>
			</div>

			<!-- Opacity -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.brushOpacity")}</span>
					<strong>{editorStore.imageToolOpacity}%</strong>
				</div>
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					aria-label={$_("toolContextMenu.brushOpacity")}
					value={editorStore.imageToolOpacity}
					oninput={handleImageOpacityChange}
				/>
			</div>

		{:else if isMagicWand || isColorRange}
			<!-- Tolerance -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.tolerance")}</span>
					<strong>{editorStore.imageToolTolerance}</strong>
				</div>
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					aria-label={$_("toolContextMenu.tolerance")}
					value={editorStore.imageToolTolerance}
					oninput={handleToleranceChange}
				/>
			</div>

		{:else if isRefineEdge}
			<!-- Refine actions -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.actions")}</span>
				</div>
				<div class="action-buttons-grid">
					<button
						type="button"
						class="action-btn ws-btn-ghost"
						onclick={() => editorStore.refineSelectionEdge("grow", 2)}
					>
						{$_("toolContextMenu.growEdge")} (+2px)
					</button>
					<button
						type="button"
						class="action-btn ws-btn-ghost"
						onclick={() => editorStore.refineSelectionEdge("contract", 2)}
					>
						{$_("toolContextMenu.contractEdge")} (-2px)
					</button>
					<button
						type="button"
						class="action-btn ws-btn-ghost"
						onclick={() => editorStore.refineSelectionEdge("feather", 2)}
					>
						{$_("toolContextMenu.featherEdge")} (2px)
					</button>
				</div>
			</div>

		{:else if isCropTool}
			<!-- Crop aspect ratios -->
			<div class="control-group">
				<div class="control-label">
					<span>{$_("toolContextMenu.aspectRatio")}</span>
				</div>
				<div class="ratio-select-grid">
					{#each Object.keys(aspectRatios) as ratioLabel (ratioLabel)}
						<button
							type="button"
							class="ratio-btn ws-btn-ghost"
							class:active={editorStore.selectedAspectRatio === ratioLabel}
							onclick={() => selectAspectRatio(ratioLabel)}
						>
							{ratioLabel}
						</button>
					{/each}
				</div>
			</div>

		{:else}
			<!-- Minimal/empty options message -->
			<div class="no-options-msg">
				{$_("toolContextMenu.noOptions")}
			</div>
		{/if}
	</div>

	<div class="menu-divider" role="separator"></div>

	<!-- Quick Switch Grid -->
	<div class="quick-switch-section">
		<span class="section-label">{$_("toolContextMenu.quickSwitch")}</span>
		<div class="tool-grid">
			{#each allTools as tool (tool.id)}
				<button
					type="button"
					class="grid-tool-btn ws-btn-ghost"
					class:active={activeToolId === tool.id}
					onclick={() => selectTool(tool)}
					title={
						tool.id === "select" ? $_("toolContextMenu.toolSelect") :
						tool.id === "crop" ? $_("toolContextMenu.toolCrop") :
						tool.id === "text" ? $_("toolContextMenu.toolText") :
						tool.id === "brush" ? $_("toolContextMenu.toolBrush") :
						tool.id === "marquee" ? $_("toolContextMenu.toolMarquee") :
						tool.id === "lasso" ? $_("toolContextMenu.toolLasso") :
						tool.id === "polygon-lasso" ? $_("toolContextMenu.toolPolyLasso") :
						tool.id === "magic-wand" ? $_("toolContextMenu.toolMagicWand") :
						tool.id === "color-range" ? $_("toolContextMenu.toolColorRange") :
						tool.id === "refine-edge" ? $_("toolContextMenu.toolRefineEdge") :
						tool.id === "healing-brush" ? $_("toolContextMenu.toolHealingBrush") :
						tool.id === "clone-stamp" ? $_("toolContextMenu.toolCloneStamp") :
						tool.id === "cover" ? $_("toolContextMenu.toolCover") :
						tool.title
					}
				>
					<span class="tool-icon" aria-hidden="true">{tool.icon}</span>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.tool-context-menu {
		position: fixed;
		z-index: 9999;
		display: flex;
		flex-direction: column;
		width: 260px;
		background: color-mix(in srgb, var(--color-ws-surface) 92%, transparent);
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 4%, transparent) inset, 0 14px 40px -24px color-mix(in srgb, var(--color-ws-bg) 94%, transparent);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		overflow: hidden;
		user-select: none;
		outline: none;
		animation: scaleIn 0.12s cubic-bezier(0.16, 1, 0.3, 1) forwards;
		transform-origin: top left;
	}

	@keyframes scaleIn {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.menu-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		border-bottom: 1px solid var(--ws-hair);
	}

	.active-icon {
		font-size: 18px;
		color: var(--color-ws-accent);
	}

	.title-wrap {
		display: flex;
		flex-direction: column;
	}

	.menu-subtitle {
		font-size: 10px;
		color: var(--color-ws-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.menu-title {
		font-size: 13px;
		font-weight: 700;
	}

	.menu-content {
		padding: 12px 14px;
		max-height: 240px;
		overflow-y: auto;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}

	.control-group:last-child {
		margin-bottom: 0;
	}

	.control-label {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		color: var(--color-ws-text);
	}

	.control-label strong {
		color: var(--color-ws-blue);
	}

	input[type="range"] {
		width: 100%;
		height: 36px;
		background: transparent;
		border-radius: var(--radius-ws-ctrl);
		outline: none;
		-webkit-appearance: none;
		appearance: none;
	}

	input[type="range"]::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair-strong);
	}

	input[type="range"]::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair-strong);
	}

	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 999px;
		background: var(--color-ws-accent);
		cursor: pointer;
		margin-top: -4px;
		transition: transform 0.1s ease;
	}

	input[type="range"]::-webkit-slider-thumb:hover {
		transform: scale(1.2);
	}

	.toggle-buttons {
		display: flex;
		gap: 6px;
	}

	.toggle-btn {
		flex: 1;
		min-height: 36px;
		padding: 0 10px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.toggle-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-ink);
	}

	.toggle-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 56%, transparent);
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-violet) 78%, var(--color-ws-surface2)), color-mix(in srgb, var(--color-ws-accent) 78%, var(--color-ws-surface2)));
		color: var(--color-ws-ink);
	}

	.checkbox-group {
		flex-direction: row;
		align-items: center;
		padding: 4px 0;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		font-size: 11px;
		color: var(--color-ws-text);
	}

	.checkbox-label input {
		accent-color: var(--color-ws-accent);
		cursor: pointer;
	}

	.action-buttons-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 6px;
	}

	.action-btn {
		min-height: 36px;
		padding: 0 10px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: var(--color-ws-text);
		text-align: left;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.action-btn:hover {
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		color: var(--color-ws-ink);
	}

	.ratio-select-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 6px;
		max-height: 120px;
		overflow-y: auto;
	}

	.ratio-btn {
		min-height: 36px;
		padding: 0 8px;
		font-size: 10px;
		font-weight: 600;
		text-align: center;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.ratio-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-ink);
	}

	.ratio-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 56%, transparent);
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-violet) 78%, var(--color-ws-surface2)), color-mix(in srgb, var(--color-ws-accent) 78%, var(--color-ws-surface2)));
		color: var(--color-ws-ink);
	}

	.no-options-msg {
		font-size: 11px;
		color: var(--color-ws-faint);
		text-align: center;
		padding: 12px 0;
		font-style: italic;
	}

	.menu-divider {
		height: 1px;
		background: var(--ws-hair);
	}

	.quick-switch-section {
		padding: 10px 14px 14px;
		background: color-mix(in srgb, var(--color-ws-bg) 28%, transparent);
	}

	.section-label {
		display: block;
		font-size: 9px;
		font-weight: 700;
		color: var(--color-ws-faint);
		text-transform: uppercase;
		margin-bottom: 8px;
		letter-spacing: 0.05em;
	}

	.tool-grid {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 6px;
	}

	.grid-tool-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 36px;
		font-size: 14px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 38%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.grid-tool-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		border-color: var(--ws-hair-strong);
		color: var(--color-ws-ink);
	}

	.grid-tool-btn.active {
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		color: var(--color-ws-ink);
		box-shadow: 0 8px 18px -12px color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
	}
</style>
