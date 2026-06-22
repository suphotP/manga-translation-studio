<!-- RoleBadge - work-role pill with a leading dot. Maps a work role to its Thai label
	and brand color; an optional `state` tints the pill for done/active/blocked/todo.
	Roles + colors mirror WorkspacePagesView / WorkspaceLibraryView role handling. -->
<script lang="ts">
	import { _ } from "$lib/i18n";

	export type WorkRole = "qc" | "translate" | "typeset" | "clean" | "review";
	export type RoleState = "todo" | "active" | "done" | "blocked";

	let {
		role,
		state = "active",
		class: klass = "",
	}: {
		role: WorkRole;
		state?: RoleState;
		class?: string;
	} = $props();

	// Localized role labels (QC stays the ASCII product term). Derived so the
	// badge re-renders on a locale change.
	let labels = $derived<Record<WorkRole, string>>({
		qc: "QC",
		translate: $_("roleBadge.translate"),
		typeset: $_("roleBadge.typeset"),
		clean: $_("roleBadge.clean"),
		review: $_("roleBadge.review"),
	});

	// Per-role accent used for the active/idle tint (translate=cyan, qc=amber, else violet).
	const roleTone: Record<WorkRole, string> = {
		clean: "violet",
		translate: "cyan",
		typeset: "violet",
		qc: "amber",
		review: "violet",
	};

	const stateClass: Record<RoleState, (tone: string) => string> = {
		done: () => "border-ws-green/20 bg-ws-green/10 text-ws-green",
		blocked: () => "border-ws-rose/20 bg-ws-rose/10 text-ws-rose",
		active: (tone) =>
			tone === "cyan"
				? "border-ws-cyan/20 bg-ws-cyan/10 text-ws-cyan"
				: tone === "amber"
					? "border-ws-amber/20 bg-ws-amber/10 text-ws-amber"
					: "border-ws-violet/25 bg-ws-violet/10 text-ws-violet",
		todo: () => "border-ws-line/[0.07] bg-white/5 text-ws-faint",
	};

	const dotClass: Record<RoleState, (tone: string) => string> = {
		done: () => "bg-ws-green",
		blocked: () => "bg-ws-rose",
		active: (tone) => (tone === "cyan" ? "bg-ws-cyan" : tone === "amber" ? "bg-ws-amber" : "bg-ws-violet"),
		todo: () => "bg-ws-faint",
	};

	let tone = $derived(roleTone[role]);
	let pillClass = $derived(stateClass[state](tone));
	let dot = $derived(dotClass[state](tone));
</script>

<span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${pillClass} ${klass}`}>
	<span class={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}></span>
	{labels[role]}
</span>
