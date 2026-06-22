<script lang="ts">
	import { _ } from "$lib/i18n";
	import { EASY_MODE_RECIPES, getToolHelp, type EasyModeId, type EasyModeRecipe } from "$lib/editor/tool-help.js";
	import {
		toolRegistry,
		type ToolDefinition,
		type ToolId,
	} from "$lib/editor/tool-registry.svelte.js";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { currentDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { activateEasyModeRecipe, activateEasyModeToolDef } from "$lib/editor/easy-mode-activator.ts";

	let selectedMode = $state<EasyModeId | null>(null);

	// #E3: show only the recipes whose DUTY the viewer holds. The dock already filters on
	// resolveDutyCapabilities; EasyMode used to ignore duty and offer tools the worker
	// cannot use (and the backend rejects). Recipes without a mapping stay visible.
	const RECIPE_CAP: Record<string, "canClean" | "canTranslate" | "canTypeset"> = {
		clean: "canClean",
		translate: "canTranslate",
		typeset: "canTypeset",
	};
	let visibleRecipes = $derived(
		EASY_MODE_RECIPES.filter((recipe) => {
			const cap = RECIPE_CAP[recipe.id];
			return !cap || currentDutyCapabilities()[cap];
		}),
	);

	let activeModeId = $derived.by<EasyModeId | null>(() => {
		// The LIVE dock tool decides, with two refinements:
		// 1) tools shared by several recipes (text/select live in both Translate
		//    and Typeset) keep the USER'S clicked tab when it also matches —
		//    plain find() always snapped back to the first recipe (codex P2);
		// 2) a tool outside any recipe falls back to the clicked tab so the
		//    panel doesn't go blank, while real tool switches still re-resolve
		//    (codex P3 from the earlier round).
		const activeTool = editorUiStore.activeDockTool;
		const matching = visibleRecipes.filter((recipe) => recipe.toolIds.includes(activeTool));
		// nothing matches the live tool: keep the chosen recipe if still visible, else the sole/first allowed one.
		if (matching.length === 0) return (selectedMode && visibleRecipes.some((r) => r.id === selectedMode)) ? selectedMode : (visibleRecipes[0]?.id ?? null);
		if (selectedMode && matching.some((recipe) => recipe.id === selectedMode)) return selectedMode;
		return matching[0]!.id;
	});
	let activeRecipe = $derived(
		activeModeId ? visibleRecipes.find((recipe) => recipe.id === activeModeId) ?? null : null,
	);

	function recipeText(recipe: EasyModeRecipe, field: "label" | "shortLabel" | "detail"): string {
		return msg(`easyMode.recipe.${recipe.id}.${field}`, recipe[field]);
	}

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	function activateTool(def: ToolDefinition): void {
		// Delegates to the shared activator so the manual panel and the open-page
		// auto-arm path stay byte-for-byte identical.
		activateEasyModeToolDef(def);
	}

	function activateMode(recipe: EasyModeRecipe): void {
		selectedMode = recipe.id;
		activateEasyModeRecipe(recipe);
	}

	function activateModeTool(recipe: EasyModeRecipe, toolId: ToolId): void {
		selectedMode = recipe.id;
		editorUiStore.setRightPanelMode(recipe.rightPanelMode);
		const def = toolRegistry.get(toolId);
		if (!def) {
			projectStore.setStatusMsg(`Easy Mode: missing tool ${toolId}`);
			return;
		}
		activateTool(def);
		projectStore.setStatusMsg(`Easy Mode: ${recipeText(recipe, "label")} - ${def.label}`);
	}

	function toolButtonTitle(def: ToolDefinition): string {
		return getToolHelp(def.id)?.easyModeHint ?? def.title;
	}
</script>

<section class="easy-mode-panel" aria-label={msg("easyMode.title", "โหมดงานง่าย")}>
	<div class="easy-mode-tabs">
		{#each visibleRecipes as recipe (recipe.id)}
			<button
				type="button"
				class="easy-mode-tab"
				class:active={activeModeId === recipe.id}
				aria-pressed={activeModeId === recipe.id}
				aria-label={`${recipeText(recipe, "label")}: ${recipeText(recipe, "detail")}`}
				title={recipeText(recipe, "detail")}
				onclick={() => activateMode(recipe)}
			>
				<strong>{recipeText(recipe, "shortLabel")}</strong>
			</button>
		{/each}
	</div>

	{#if activeRecipe}
		<div class="easy-mode-tools" aria-label={`${activeRecipe.label}: ${$_("easyMode.suitableTools")}`}>
			{#each activeRecipe.toolIds as toolId (toolId)}
				{@const def = toolRegistry.get(toolId)}
				{#if def}
					<button
						type="button"
						class="easy-tool"
						class:active={editorUiStore.activeDockTool === def.id}
						aria-label={`${activeRecipe.label}: ${def.title}`}
						title={toolButtonTitle(def)}
						onclick={() => activateModeTool(activeRecipe, def.id)}
					>
						<span aria-hidden="true">{def.icon} {def.label}</span>
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	.easy-mode-panel {
		display: flex;
		width: 100%;
		flex: 0 0 auto;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		padding: 6px 0;
		border-right: 1px solid var(--editor-border);
		border-bottom: 1px solid var(--editor-border);
		background: var(--editor-surface);
	}

	.easy-mode-tabs,
	.easy-mode-tools {
		display: flex;
		width: 100%;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.easy-mode-tools {
		padding-top: 5px;
		border-top: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	.easy-mode-tab,
	.easy-tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 46px;
		min-width: 40px;
		min-height: 34px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
		color: rgba(251, 247, 255, 0.74);
		cursor: pointer;
		font-family: inherit;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0;
		transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
	}

	.easy-mode-tab:hover,
	.easy-tool:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.easy-mode-tab.active,
	.easy-tool.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
		background: linear-gradient(180deg, color-mix(in srgb, var(--color-ws-accent) 22%, transparent), color-mix(in srgb, var(--color-ws-accent) 12%, transparent));
		color: var(--color-ws-ink, #ececf2);
	}

	.easy-mode-tab strong,
	.easy-tool span {
		display: block;
		max-width: 40px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.easy-tool {
		min-height: 30px;
		color: rgba(251, 247, 255, 0.62);
		font-size: 10px;
	}

	@media (max-width: 640px) {
		.easy-mode-panel {
			gap: 4px;
			padding: 5px 0;
		}

		.easy-mode-tab,
		.easy-tool {
			width: 44px;
			min-height: 36px;
		}

		.easy-tool {
			min-height: 32px;
		}
	}
</style>
