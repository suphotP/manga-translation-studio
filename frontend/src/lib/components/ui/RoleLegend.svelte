<script lang="ts">
	import RoleBadge, { type WorkRole, type RoleState } from "./RoleBadge.svelte";

	let {
		roles = [],
		state,
		class: klass = "",
	}: {
		roles: WorkRole[];
		state?: RoleState;
		class?: string;
	} = $props();
</script>

<div class={`flex flex-wrap items-center gap-1.5 ${klass}`}>
	{#each roles as role (role)}
		<RoleBadge {role} {state} />
	{/each}
</div>
