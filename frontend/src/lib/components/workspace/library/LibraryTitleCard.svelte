<!-- LibraryTitleCard — one cover card on the manga shelf (extracted verbatim from
	WorkspaceLibraryView's `coverCard` snippet). Renders a CoverCard with the signed
	asset identity, status chips, language coverage, a progress track, and the
	open/review/comment counts + avatar footer. All projectStore-derived values are
	precomputed by the orchestrator and handed in as a flat view-model; this stays a
	pure presentation atom. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";
	import type { LanguagePair } from "$lib/components/ui/LanguageCoverageChips.svelte";
	import CoverCard from "$lib/components/ui/CoverCard.svelte";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import LanguageCoverageChips from "$lib/components/ui/LanguageCoverageChips.svelte";
	import AvatarStack from "$lib/components/ui/AvatarStack.svelte";

	type CoverStatusTone = "violet" | "amber" | "cyan" | "green" | "rose" | "faint";

	let {
		title,
		done,
		isList,
		tone,
		progress,
		extra,
		coverUrl,
		statusLabel,
		dotToneClass,
		chapterLabel,
		languagePairs,
		progressGradient,
		avatarInitials,
		relativeUpdate,
		onOpen,
	}: {
		title: WorkspaceProjectBrowserGroup;
		done: boolean;
		isList: boolean;
		tone: CoverStatusTone;
		progress: number;
		extra: number;
		coverUrl: string | null;
		statusLabel: string;
		dotToneClass: string;
		chapterLabel: string;
		languagePairs: LanguagePair[];
		progressGradient: string;
		avatarInitials: string[];
		relativeUpdate: string;
		onOpen: () => void;
	} = $props();
</script>

<button
	type="button"
	class={`cover-card ws-panel ws-row-hover flex flex-col overflow-hidden rounded-ws text-left ${isList ? "@xl:flex-row" : ""}`}
	aria-label={$_("libraryTitleCard.openTitle", { values: { title: title.title } })}
	onclick={onOpen}
>
	<div class={`relative shrink-0 ${isList ? "@xl:w-[168px]" : ""}`}>
		<CoverCard
			seed={title.id}
			imageUrl={coverUrl ?? ""}
			assetProjectId={title.coverProjectId ?? ""}
			assetImageId={title.coverImageId ?? ""}
			assetPurpose="thumbnail"
			ratio="wide"
			class="border-b border-ws-line/[0.07]"
		/>
		<span class="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full border border-ws-line/12 bg-ws-bg/75 px-2 py-0.5 text-[10.5px] font-medium text-ws-ink backdrop-blur">
			<span class={`ws-dot ${done ? "bg-ws-ink" : dotToneClass}`}></span> {statusLabel}
		</span>
		{#if title.attentionChapterCount > 0 && !done}
				<span class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full border border-ws-rose/25 bg-ws-rose/80 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">
					<span class="ws-dot bg-ws-ink"></span> <NumberValue value={title.attentionChapterCount} /> {$_("libraryTitleCard.urgent")}
			</span>
		{:else if title.targetLangs.length > 4 && !done}
			<span class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full border border-ws-line/12 bg-ws-bg/75 px-1.5 py-0.5 text-[10.5px] font-medium text-ws-ink backdrop-blur">
				<span class="ws-dot bg-ws-cyan"></span> <NumberValue value={title.targetLangs.length} /> {$_("libraryTitleCard.languages")}
			</span>
		{/if}
	</div>

	<div class="flex flex-1 flex-col gap-3 p-4">
		<div class="min-w-0">
			<p class="truncate text-[14.5px] font-semibold leading-tight text-ws-ink" title={title.title}>{title.title}</p>
			<p class="mt-0.5 flex items-center gap-1 truncate text-[12px] text-ws-faint">{chapterLabel} · <NumberValue value={title.chapterCount} /> {$_("libraryTitleCard.chaptersUnit")}</p>
		</div>

		<LanguageCoverageChips pairs={languagePairs} />

		<div class="flex items-center justify-between gap-2 text-[11.5px]">
			<span class="truncate text-ws-text">{$_("libraryTitleCard.latest")} <span class="font-medium text-ws-ink">{chapterLabel}</span></span>
			<span class={`inline-flex shrink-0 items-center gap-1.5 ${tone === "amber" ? "text-ws-amber" : tone === "green" ? "text-ws-green" : tone === "cyan" ? "text-ws-cyan" : tone === "faint" ? "text-ws-faint" : "text-ws-violet"}`}><span class={`ws-dot ${dotToneClass}`}></span>{statusLabel}</span>
		</div>

		<div>
			<div class="mb-1.5 flex items-center justify-between text-[10.5px]">
				<span class="text-ws-faint">{$_("libraryTitleCard.totalProgress")}</span>
				<NumberValue value={progress} suffix="%" compact={false} class={`font-medium ${done ? "text-ws-green" : "text-ws-ink"}`} />
			</div>
			<div class="ws-track h-1.5"><div class="ws-fill" style={`width:${progress}%; background:${progressGradient}`}></div></div>
		</div>

		<div class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-ws-line/[0.07] pt-3">
			<div class="flex min-w-0 items-center gap-2.5 text-[11px]">
				{#if done}
						<span class="inline-flex items-center gap-1.5 text-ws-faint">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v9M12 13l-3.5-3.5M12 13l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M5 16v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg> {$_("libraryTitleCard.zipReady")}
					</span>
				{:else}
					<span class="inline-flex items-center gap-1 text-ws-violet" title={$_("libraryTitleCard.openTasksTitle")}><span class="ws-dot bg-ws-violet"></span><NumberValue value={title.openTasks} /></span>
					<span class="inline-flex items-center gap-1 text-ws-amber" title={$_("libraryTitleCard.reviewTasksTitle")}><span class="ws-dot bg-ws-amber"></span><NumberValue value={title.reviewTasks} /></span>
					<span class="inline-flex items-center gap-1 text-ws-cyan" title={$_("libraryTitleCard.commentsTitle")}><span class="ws-dot bg-ws-cyan"></span><NumberValue value={title.openComments} /></span>
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<AvatarStack size="xs" items={avatarInitials.map((initial) => ({ initial }))} extra={extra} />
				<span class="text-[10.5px] text-ws-faint">{relativeUpdate}</span>
			</div>
		</div>
	</div>
</button>
