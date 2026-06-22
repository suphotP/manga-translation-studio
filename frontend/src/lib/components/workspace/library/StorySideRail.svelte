<!-- StorySideRail — the right rail of the story command center (aria-label
	"ทีมและกิจกรรมของ {title}"): the honest team panel (self + real member count),
	an empty activity feed, and today's work signals. The orchestrator owns the
	projectStore-derived counts; this is pure presentation. The `.story-side-rail`
	class is preserved so the parent-class sticky layout still applies. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";

	let {
		title,
		isAssignedMode,
		workspaceMemberCount,
		selfDisplayName,
		selfInitial,
	}: {
		title: WorkspaceProjectBrowserGroup;
		isAssignedMode: boolean;
		workspaceMemberCount: number;
		selfDisplayName: string;
		selfInitial: string;
	} = $props();
</script>

<aside class="story-side-rail grid min-w-0 content-start gap-3.5" aria-label={$_("storySideRail.regionAria", { values: { title: title.title } })}>
	{#if !isAssignedMode}
	<section class="ws-panel-quiet rounded-ws p-4">
		<header class="mb-3 flex items-center justify-between gap-3">
			<h3 class="text-[15px] font-extrabold text-ws-ink">{$_("storySideRail.teamHeading")}</h3>
			<span class="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-ws-surface2/70 px-2 text-[11px] font-black text-ws-text">{workspaceMemberCount || 1}</span>
		</header>
		<div class="story-team-row grid grid-cols-[32px_minmax(0,1fr)] items-center gap-2 py-2.5">
			<span class="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-ws-accent/15 text-[11px] font-black text-ws-accent">{selfInitial}</span>
			<div class="min-w-0">
				<strong class="block truncate text-[11px] font-black text-ws-ink">{selfDisplayName}</strong>
				<small class="block truncate text-[10px] font-semibold leading-snug text-ws-text/60">{$_("storySideRail.you")}</small>
			</div>
		</div>
		{#if workspaceMemberCount > 1}
			<p class="border-t border-ws-line/12 pt-2.5 text-[10px] font-semibold leading-snug text-ws-faint">{$_("storySideRail.moreMembers", { values: { n: workspaceMemberCount - 1 } })}</p>
		{:else}
			<p class="border-t border-ws-line/12 pt-2.5 text-[10px] font-semibold leading-snug text-ws-faint">{$_("storySideRail.inviteTeam")}</p>
		{/if}
	</section>
	{/if}
	<section class="ws-panel-quiet rounded-ws p-4">
		<header class="mb-3 flex items-center justify-between gap-3">
			<h3 class="text-[15px] font-extrabold text-ws-ink">{$_("storySideRail.activityHeading")}</h3>
		</header>
		<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-5 text-center text-[11px] font-semibold leading-snug text-ws-faint">
			{$_("storySideRail.activityEmpty1")}<br />{$_("storySideRail.activityEmpty2")}
		</p>
	</section>
	<section class="ws-panel-quiet rounded-ws p-4">
		<header class="mb-3 flex items-center justify-between gap-3">
			<h3 class="text-[15px] font-extrabold text-ws-ink">{$_("storySideRail.todayHeading")}</h3>
		</header>
		{#if title.openTasks + title.reviewTasks + title.openComments > 0}
			<div class="grid gap-1.5 text-[11px] font-semibold text-ws-text/80">
				{#if title.openTasks > 0}<div class="flex items-center gap-2"><span class="ws-dot bg-ws-violet"></span>{$_("storySideRail.openTasks", { values: { n: title.openTasks } })}</div>{/if}
				{#if title.reviewTasks > 0}<div class="flex items-center gap-2"><span class="ws-dot bg-ws-amber"></span>{$_("storySideRail.reviewTasks", { values: { n: title.reviewTasks } })}</div>{/if}
				{#if title.openComments > 0}<div class="flex items-center gap-2"><span class="ws-dot bg-ws-cyan"></span>{$_("storySideRail.openComments", { values: { n: title.openComments } })}</div>{/if}
			</div>
		{:else}
			<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-5 text-center text-[11px] font-semibold leading-snug text-ws-faint">
				{$_("storySideRail.noPendingWork")}
			</p>
		{/if}
	</section>
</aside>
