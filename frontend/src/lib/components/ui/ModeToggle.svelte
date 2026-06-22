<!-- ModeToggle - ทีม/หัวหน้า vs งานของฉัน segmented control. Reads/writes the shared
	editorUiStore.workspaceTeamMode via setWorkspaceTeamMode, styled with .ws-seg. -->
<script lang="ts">
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { canUseLeadView, effectiveTeamMode } from "$lib/stores/workspace-team-mode.ts";
	import { _ } from "$lib/i18n";

	let {
		subtitle = "",
		class: klass = "",
	}: {
		subtitle?: string;
		class?: string;
	} = $props();

	let canLead = $derived(canUseLeadView());
	let isLead = $derived(effectiveTeamMode() === "lead");

	function set(next: "lead" | "assigned"): void {
		editorUiStore.setWorkspaceTeamMode(next);
	}
</script>

<div class={`flex items-center gap-2.5 ${klass}`}>
	<div class="ws-panel-quiet inline-flex items-center gap-1 rounded-ws-ctrl p-0.5" role="tablist" aria-label={$_("modeToggle.viewModeLabel")}>
		{#if canLead}
		<button
			type="button"
			role="tab"
			aria-selected={isLead}
			class={`ws-seg rounded-[7px] px-3 py-1 text-[11px] font-medium ${isLead ? "ws-seg-on" : ""}`}
			onclick={() => set("lead")}
		>
			{$_("modeToggle.teamLead")}
		</button>
		{/if}
		<button
			type="button"
			role="tab"
			aria-selected={!isLead}
			class={`ws-seg rounded-[7px] px-3 py-1 text-[11px] font-medium ${!isLead ? "ws-seg-on" : ""}`}
			onclick={() => set("assigned")}
		>
			{$_("modeToggle.myWork")}
		</button>
	</div>
	{#if subtitle}<span class="text-[11px] text-ws-faint">{subtitle}</span>{/if}
</div>
