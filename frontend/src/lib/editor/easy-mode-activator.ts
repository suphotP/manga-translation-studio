// Shared Easy-Mode recipe activation.
//
// The activation logic used to live privately inside EasyModePanel.svelte. It is
// extracted here so the page-open flow can ARM the matching recipe programmatically —
// when a worker opens a page they're about to clean/translate/typeset, the editor lands
// on the right tool + panel instead of a generic default. EasyModePanel delegates to the
// same functions so the manual and automatic paths can never drift apart.

import { EASY_MODE_RECIPES, type EasyModeId, type EasyModeRecipe } from "$lib/editor/tool-help.js";
import {
	toolRegistry,
	type ToolActivationContext,
	type ToolDefinition,
} from "$lib/editor/tool-registry.svelte.js";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { currentDutyCapabilities } from "$lib/editor/duty-profile.ts";

// Capability each recipe requires; recipes without a mapping are always allowed. Mirrors
// EasyModePanel's RECIPE_CAP — the dock and the panel already gate on these.
const RECIPE_CAP: Record<string, "canClean" | "canTranslate" | "canTypeset"> = {
	clean: "canClean",
	translate: "canTranslate",
	typeset: "canTypeset",
};

function activationContext(): ToolActivationContext {
	return {
		setEngineTool: (tool) => editorStore.setTool(tool),
		setRightPanelMode: (mode) => editorUiStore.setRightPanelMode(mode),
		startTextPlacement: () => editorStore.startTextPlacement(),
		activateImageTool: (id) => editorStore.setImageTool(id),
	};
}

/** Activate a single dock tool, running its onActivate hook (or the engine-tool default). */
export function activateEasyModeToolDef(def: ToolDefinition): void {
	editorUiStore.setActiveDockTool(def.id);
	const ctx = activationContext();
	if (def.onActivate) {
		def.onActivate(ctx);
	} else {
		ctx.setEngineTool(def.engineTool);
	}
}

/** Activate a full recipe (right-panel mode + primary tool + status). False if the primary tool is missing. */
export function activateEasyModeRecipe(recipe: EasyModeRecipe): boolean {
	editorUiStore.setRightPanelMode(recipe.rightPanelMode);
	const primary = toolRegistry.get(recipe.primaryToolId);
	if (!primary) {
		projectStore.setStatusMsg(`Easy Mode: missing tool ${recipe.primaryToolId}`);
		return false;
	}
	activateEasyModeToolDef(primary);
	projectStore.setStatusMsg(recipe.statusMessage);
	return true;
}

/** True when the viewer's resolved duty allows this recipe. */
export function canUseEasyModeRecipe(recipeId: EasyModeId): boolean {
	const cap = RECIPE_CAP[recipeId];
	return !cap || currentDutyCapabilities()[cap];
}

/**
 * Auto-arm a recipe by id when opening a page. No-op (returns false) when the recipe is
 * unknown or the viewer lacks the duty capability — never arm a tool the backend would
 * reject, and never surprise a manager who isn't doing that duty.
 */
export function armEasyModeRecipeById(recipeId: EasyModeId): boolean {
	if (!canUseEasyModeRecipe(recipeId)) return false;
	const recipe = EASY_MODE_RECIPES.find((r) => r.id === recipeId);
	if (!recipe) return false;
	return activateEasyModeRecipe(recipe);
}
