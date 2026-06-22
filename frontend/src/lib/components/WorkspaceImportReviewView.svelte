<script lang="ts">
	import { buildWorkspaceHref } from "$lib/navigation/workspace-routes.js";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { pageImageRelinkOrderFallbackCancelMessage } from "$lib/project/page-relink-confirmation.js";
	import { buildChapterDashboard } from "$lib/project/chapter-dashboard.js";
	import {
		resolveVisiblePageLayerCount,
		summarizePageBatch,
		summarizePageWork,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { resolvePageAssetLabelText, resolvePageAssetSignalText } from "$lib/project/page-work-copy-i18n.js";
	import { _ } from "$lib/i18n";
	import type { ProjectState } from "$lib/types.js";
	import ImportEmptyState from "./workspace/import-review/ImportEmptyState.svelte";
	import ImportPageRow from "./workspace/import-review/ImportPageRow.svelte";
	import WorkspacePageHeader from "./ui/WorkspacePageHeader.svelte";
	import WorkspaceTopUtilityBar from "./WorkspaceTopUtilityBar.svelte";
	import SectionBand from "./ui/SectionBand.svelte";
	import StatTile from "./ui/StatTile.svelte";

	type ImportStepState = "done" | "active" | "todo";

	interface ImportStep {
		id: string;
		index: number;
		label: string;
		detail: string;
		state: ImportStepState;
	}

	let pageSummaries = $derived(buildPageSummaries(projectStore.project));
	let chapterBatchSummary = $derived(summarizePageBatch(pageSummaries));
	let chapterDashboard = $derived(buildChapterDashboard(pageSummaries, chapterBatchSummary));
	let emptyPageCount = $derived(pageSummaries.filter((summary) => summary.layerCount === 0).length);
	let importedPageCount = $derived(pageSummaries.filter((summary) => summary.layerCount > 0).length);
	let unmatchedPageCount = $derived(pageSummaries.filter((summary) =>
		summary.assetIntegrity
		&& summary.assetIntegrity.status !== "ready").length);
	let firstImportedPageIndex = $derived(pageSummaries.find((summary) => summary.layerCount > 0)?.pageIndex ?? projectStore.project?.currentPage ?? 0);
	let reviewTargetCount = $derived(
		chapterBatchSummary.commentCount
			+ chapterBatchSummary.aiAttentionCount
			+ chapterDashboard.signals.qcErrors
			+ chapterDashboard.signals.qcWarnings,
	);
	let importScopeReceipt = $derived(projectStore.project
		? $_("importReview.scopeReceipt", { values: { lang: projectStore.project.targetLang.toUpperCase(), count: projectStore.project.pages.length } })
		: $_("importReview.openChapterFirst"));
	let importSteps = $derived(buildImportSteps());

	function buildPageSummaries(project: ProjectState | null): PageWorkSummary[] {
		if (!project) return [];
		const qcIssues = projectStore.qcReport.issues;
		return project.pages.map((page, index) => summarizePageWork({
			page,
			pageIndex: index,
			layerCount: resolveVisiblePageLayerCount(
				page,
				project.currentPage === index,
				editorStore.textLayers.length,
				editorStore.hasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(index),
			qcIssues,
			tasks: projectStore.tasks,
			comments: projectStore.comments,
			aiReviewMarkers: projectStore.aiReviewMarkers,
			reviewDecisions: projectStore.reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		}));
	}

	// 5-step import flow (spec §4): เลือกไฟล์ → จับคู่หน้า → พรีวิวเลเยอร์ข้อความ →
	// Import → ตรวจหลัง Import. The active step advances as the chapter gains pages,
	// draft layers, and clears its review targets — purely a progress affordance, no
	// behavior change to the import pipeline.
	function buildImportSteps(): ImportStep[] {
		const project = projectStore.project;
		const hasChapter = Boolean(project);
		const hasPages = (project?.pages.length ?? 0) > 0;
		const hasDraftLayers = importedPageCount > 0;
		const reviewClear = hasDraftLayers && reviewTargetCount === 0;

		// Which step is "now": pick the first incomplete step.
		let activeId: string;
		if (!hasChapter) activeId = "select";
		else if (!hasDraftLayers) activeId = "select";
		else if (reviewTargetCount > 0) activeId = "review";
		else activeId = "review";

		const completed = new Set<string>();
		if (hasPages) completed.add("select");
		if (hasDraftLayers) {
			completed.add("match");
			completed.add("preview");
			completed.add("apply");
		}
		if (reviewClear) completed.add("review");

		const defs: Array<{ id: string; label: string; detail: string }> = [
			{ id: "select", label: $_("importReview.stepSelectLabel"), detail: $_("importReview.stepSelectDetail") },
			{ id: "match", label: $_("importReview.stepMatchLabel"), detail: $_("importReview.stepMatchDetail") },
			{ id: "preview", label: $_("importReview.stepPreviewLabel"), detail: $_("importReview.stepPreviewDetail") },
			{ id: "apply", label: $_("importReview.stepApplyLabel"), detail: $_("importReview.stepApplyDetail") },
			{ id: "review", label: $_("importReview.stepReviewLabel"), detail: $_("importReview.stepReviewDetail") },
		];

		return defs.map((def, index) => ({
			id: def.id,
			index: index + 1,
			label: def.label,
			detail: def.detail,
			state: completed.has(def.id) ? "done" : def.id === activeId ? "active" : "todo",
		}));
	}

	function openLibrary(): void {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
	}

	function openPages(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages();
		queueWorkspaceNavigation({ view: "pages", projectId: projectStore.project.projectId });
	}

	function openCanvas(pageIndex = projectStore.project?.currentPage ?? 0): void {
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project?.projectId,
			pageIndex,
		});
	}

	function primaryReviewTargetActionLabel(): string {
		if (importedPageCount > 0) return $_("importReview.reviewFirstTextPage");
		return $_("importReview.openPageNumber", { values: { n: (projectStore.project?.currentPage ?? 0) + 1 } });
	}

	async function openPage(pageIndex: number): Promise<void> {
		if (!projectStore.project) return;
		const opened = await projectStore.goToPage(pageIndex, editorStore.editor);
		if (!opened) return;
		editorStore.refreshTextLayers();
		openCanvas(pageIndex);
	}

	function importReviewHref(): string | null {
		if (!projectStore.project) return null;
		return buildWorkspaceHref({
			view: "import",
			projectId: projectStore.project.projectId,
		});
	}

	function absoluteWorkspaceLink(href: string): string {
		if (typeof window === "undefined") return href;
		return new URL(href, window.location.origin).toString();
	}

	async function copyImportLink(): Promise<void> {
		const href = importReviewHref();
		if (!href) return;
		const link = absoluteWorkspaceLink(href);
		if (!navigator.clipboard?.writeText) {
			projectStore.setStatusMsg($_("importReview.importLinkStatus", { values: { link } }));
			return;
		}
		try {
			await navigator.clipboard.writeText(link);
			projectStore.setStatusMsg($_("importReview.importLinkCopied"));
		} catch {
			projectStore.setStatusMsg($_("importReview.importLinkStatus", { values: { link } }));
		}
	}

	async function startJsonImport(): Promise<void> {
		if (!projectStore.project) return;
		const activeEditor = editorStore.hasImage ? editorStore.editor : undefined;
		await projectStore.importJson(activeEditor);
	}

	function openBulkImport(): void {
		if (!projectStore.project) return;
		editorUiStore.openBulkImport();
	}

	function relinkPage(summary: PageWorkSummary): void {
		if (!projectStore.project) return;
		const layerId = summary.assetIntegrity?.issueKind === "image-layer" ? summary.assetIntegrity.layerId : null;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			if (layerId) {
				void projectStore.replacePageImageLayerAsset(summary.pageIndex, layerId, file, editorStore.editor);
			} else {
				void projectStore.replacePageImage(summary.pageIndex, file, editorStore.editor);
			}
		};
		input.click();
	}

	function relinkMatchingPageImages(): void {
		if (!projectStore.project) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.multiple = true;
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
			const preview = projectStore.getMatchingPageImageRelinkPreview(files);
			const confirmed = await pageRelinkConfirmationStore.confirmOrderFallback(preview);
			if (!confirmed) {
				projectStore.setStatusMsg(pageImageRelinkOrderFallbackCancelMessage);
				return;
			}
			void projectStore.replaceMatchingPageImages(files, editorStore.editor, {
				allowOrderFallback: preview.requiresOrderConfirmation,
			});
		};
		input.click();
	}

	function assetNeedsRecovery(summary: PageWorkSummary): boolean {
		return summary.assetIntegrity?.status === "missing"
			|| summary.assetIntegrity?.status === "failed"
			|| summary.assetIntegrity?.status === "blocked";
	}

	function pageSignal(summary: PageWorkSummary): string {
		const signals: string[] = [];
		if (summary.assetIntegrity && summary.assetIntegrity.status !== "ready") {
			signals.push(resolvePageAssetSignalText(summary.assetIntegrity.status, summary.assetIntegrity.label, $_));
		}
		if (summary.layerCount > 0) signals.push($_("importReview.signalTextLayers", { values: { count: summary.layerCount } }));
		if (summary.openCommentCount > 0) signals.push($_("importReview.signalNotes", { values: { count: summary.openCommentCount } }));
		if (summary.taskOpenCount > 0) signals.push($_("importReview.signalTasks", { values: { count: summary.taskOpenCount } }));
		if (summary.aiAttentionCount > 0) signals.push($_("importReview.signalAiResults", { values: { count: summary.aiAttentionCount } }));
		if (summary.qcErrorCount + summary.qcWarningCount > 0) {
			signals.push($_("importReview.signalQc", { values: { count: summary.qcErrorCount + summary.qcWarningCount } }));
		}
		return signals.length ? signals.join(" / ") : $_("importReview.signalNoImportedText");
	}

	function assetIntegrityLabel(summary: PageWorkSummary): string {
		if (!summary.assetIntegrity) return "";
		return resolvePageAssetLabelText(summary.assetIntegrity, $_);
	}

	function pageImportStatus(summary: PageWorkSummary): string {
		if (summary.exportReady) return $_("importReview.statusExportReady");
		if (summary.status === "blocked") return $_("importReview.statusExportBlocked");
		if (summary.status === "review") return $_("importReview.statusNeedsReview");
		if (summary.status === "empty") return $_("importReview.statusNoText");
		return $_("importReview.statusInProgress");
	}

	function pageImportReviewHint(summary: PageWorkSummary): string {
		if (summary.layerCount > 0) return $_("importReview.hintHasDraftLayer");
		if (summary.assetIntegrity && summary.assetIntegrity.status !== "ready") return $_("importReview.hintRecoverImage");
		return $_("importReview.hintWaitingImport");
	}

	function pageDisplayTitle(summary: PageWorkSummary): string {
		return $_("importReview.pageTitle", { values: { n: summary.pageNumber } });
	}

	function pageReviewActionLabel(summary: PageWorkSummary): string {
		return $_("importReview.reviewPageNumber", { values: { n: summary.pageNumber } });
	}
</script>

{#if editorUiStore.workspaceView === "import"}
	<section class="ws-surface workspace-import-shell" aria-label={$_("importReview.shellAria")}>
		<div class="ws-surface-inner">
			<WorkspaceTopUtilityBar />
			<WorkspacePageHeader
				eyebrow={$_("importReview.headerEyebrow")}
				title={projectStore.project?.name ?? $_("importReview.headerTitlePlaceholder")}
				subtitle={projectStore.project
					? $_("importReview.headerSubtitle", { values: { lang: projectStore.project.targetLang.toUpperCase(), count: projectStore.project.pages.length, imported: importedPageCount } })
					: $_("importReview.headerSubtitlePlaceholder")}
			>
				{#snippet actions()}
					<button type="button" class="import-action ws-btn-ghost" onclick={openLibrary}>{$_("importReview.selectChapter")}</button>
					{#if projectStore.project}
						<a class="import-action ws-btn-ghost" href="/tools/import-json">{$_("importReview.jsonGuide")}</a>
						<button type="button" class="import-action ws-btn-ghost" onclick={relinkMatchingPageImages}>{$_("importReview.matchImages")}</button>
						<button type="button" class="import-action import-action-primary ws-grad-primary" onclick={() => void startJsonImport()}>{$_("importReview.importJson")}</button>
					{:else}
						<span class="import-action import-receipt ws-panel-quiet">{$_("importReview.openChapterFirst")}</span>
					{/if}
				{/snippet}
			</WorkspacePageHeader>

			<!-- STATUS STRIP — Pages · Mapped · Unmatched · Draft layers · Needs review -->
			<div class="import-status-strip" aria-label={$_("importReview.statusStripAria")}>
				<StatTile label={$_("importReview.statHcPages")} value={chapterDashboard.totalPages} />
				<StatTile label={$_("importReview.statHasText")} value={importedPageCount} tone={importedPageCount > 0 ? "green" : "neutral"} />
				<StatTile label={$_("importReview.statUnmatched")} value={unmatchedPageCount} tone={unmatchedPageCount > 0 ? "rose" : "neutral"} />
				<StatTile label={$_("importReview.statTextLayers")} value={chapterBatchSummary.layerCount} tone={chapterBatchSummary.layerCount > 0 ? "violet" : "neutral"} />
				<StatTile label={$_("importReview.statNeedsReview")} value={reviewTargetCount} tone={reviewTargetCount > 0 ? "amber" : "neutral"} />
			</div>

			<!-- MISMATCH BANNER (spec §4) — only when filenames don't line up -->
			{#if projectStore.project && unmatchedPageCount > 0}
				<div class="import-mismatch" role="note">
					<span class="import-mismatch-dot" aria-hidden="true"></span>
					<div class="min-w-0">
						<strong>{$_("importReview.mismatchTitle")}</strong>
						<small>{$_("importReview.mismatchDetail", { values: { count: unmatchedPageCount } })}</small>
					</div>
					<button type="button" class="import-action ws-btn-ghost" onclick={relinkMatchingPageImages}>{$_("importReview.reviewMatching")}</button>
				</div>
			{/if}

			<!-- STEPPER — เลือกไฟล์ → จับคู่หน้า → พรีวิวเลเยอร์ข้อความ → Import → ตรวจหลัง Import -->
			<section aria-label={$_("importReview.stepperAria")}>
				<SectionBand title={$_("importReview.stepperTitle")} subtitle={$_("importReview.stepperSubtitle")} />
				<ol class="import-steps">
					{#each importSteps as step (step.id)}
						<li class={`import-step is-${step.state}`}>
							<span class="import-step-index" aria-hidden="true">
								{#if step.state === "done"}✓{:else}{step.index}{/if}
							</span>
							<span class="import-step-copy">
								<strong>{step.label}</strong>
								<small>{step.detail}</small>
							</span>
						</li>
					{/each}
				</ol>
			</section>

			<!-- COMMAND PANEL — primary import actions, solid violet primary -->
			<section class="import-command ws-panel" aria-label={$_("importReview.commandAria")}>
				<div class="command-copy">
					<span class="command-eyebrow">{$_("importReview.commandEyebrow")}</span>
					<strong>{$_("importReview.commandTitle")}</strong>
					<small>
						{#if projectStore.project}
							{$_("importReview.commandSummary", { values: { total: projectStore.project.pages.length, imported: importedPageCount, empty: emptyPageCount } })}
						{:else}
							{$_("importReview.headerSubtitlePlaceholder")}
						{/if}
					</small>
				</div>
				<div class="command-actions">
					{#if projectStore.project}
						<span class="command-scope" aria-label={$_("importReview.commandScopeAria")}>{importScopeReceipt}</span>
						<button type="button" class="import-action import-action-primary ws-grad-primary" onclick={() => void startJsonImport()}>{$_("importReview.importJson")}</button>
						<button type="button" class="import-action ws-btn-ghost" onclick={openBulkImport}>{$_("importReview.bulkImport")}</button>
						<button type="button" class="import-action ws-btn-ghost" onclick={() => void copyImportLink()}>{$_("importReview.copyLink")}</button>
						<button type="button" class="import-action ws-btn-ghost" onclick={openPages}>{$_("importReview.reviewPages")}</button>
					{:else}
						<span class="import-action import-receipt ws-panel-quiet">{$_("importReview.openChapterFirst")}</span>
					{/if}
				</div>
			</section>

			<!-- PAGE ROWS — secondary, below the main workflow (spec §4) -->
			<section class="target-review ws-panel-quiet" aria-label={$_("importReview.targetReviewAria")}>
				<SectionBand title={$_("importReview.pagesInChapterTitle")} subtitle={$_("importReview.pagesInChapterSubtitle")}>
					{#snippet action()}
						{#if projectStore.project}
							<button type="button" class="import-action ws-btn-ghost" onclick={() => void openPage(firstImportedPageIndex)}>
								{primaryReviewTargetActionLabel()}
							</button>
						{:else}
							<span class="import-action import-receipt ws-panel-quiet">{$_("importReview.openChapterToReview")}</span>
						{/if}
					{/snippet}
				</SectionBand>

				{#if !projectStore.project}
					<ImportEmptyState message={$_("importReview.emptyOpenLibrary")} />
				{:else if !pageSummaries.length}
					<ImportEmptyState message={$_("importReview.emptyNoPageImages")} />
				{:else}
					<div class="target-list">
						{#each pageSummaries as summary (summary.pageIndex)}
							<ImportPageRow
								{summary}
								active={summary.pageIndex === projectStore.project.currentPage}
								title={pageDisplayTitle(summary)}
								hint={pageImportReviewHint(summary)}
								status={pageImportStatus(summary)}
								assetLabel={assetIntegrityLabel(summary)}
								signal={pageSignal(summary)}
								actionLabel={pageReviewActionLabel(summary)}
								needsRecovery={assetNeedsRecovery(summary)}
								recoveryLabel={summary.assetIntegrity?.issueKind === "image-layer" ? $_("importReview.recoverExtraImage") : $_("importReview.recoverImage")}
								onOpen={() => void openPage(summary.pageIndex)}
								onRelink={() => relinkPage(summary)}
							/>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</section>
{/if}

<style>
	/* The surface frame (position / scroll / violet wash / typeface) + the centered
	   1200px content column come from the shared `.ws-surface` + `.ws-surface-inner`
	   utilities in app.css, so Import lines up pixel-for-pixel with Dashboard /
	   Library / Pages. The header, status strip, section bands and primary button all
	   reuse the shared workspace atoms + tokens (WorkspacePageHeader, StatTile,
	   SectionBand, .ws-panel*, .ws-btn-ghost, .ws-grad-primary) — solid violet primary, no teal/green
	   washes, no violet→blue gradient. This overlays above other surfaces, so it keeps
	   its own stacking context. */
	.workspace-import-shell {
		z-index: 49;
	}

	.import-action {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 14px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 800;
		line-height: 1.2;
		text-align: center;
		text-decoration: none;
		transition: border-color 0.14s ease, filter 0.14s ease;
	}
	.import-action-primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
	}
	.import-action-primary:hover {
		filter: brightness(1.06);
	}
	.import-receipt {
		cursor: default;
		opacity: 0.7;
	}

	/* ── Status strip — five quiet metric tiles (StatTile) ── */
	.import-status-strip {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 10px;
	}

	/* ── Mismatch banner (violet/amber, spec §4) ── */
	.import-mismatch {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		border-radius: var(--radius-ws-card);
		background: linear-gradient(
			100deg,
			color-mix(in srgb, var(--color-ws-accent) 10%, transparent),
			color-mix(in srgb, var(--color-ws-amber) 10%, transparent)
		);
	}
	.import-mismatch-dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-ws-amber);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}
	.import-mismatch strong {
		display: block;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
	}
	.import-mismatch small {
		display: block;
		margin-top: 2px;
		color: var(--color-ws-text);
		font-size: 12px;
		line-height: 1.35;
	}
	.import-mismatch .import-action {
		flex: none;
		margin-left: auto;
	}

	/* ── Stepper — active step gets a violet border + subtle violet surface ── */
	.import-steps {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 10px;
		margin: 12px 0 0;
		padding: 0;
		list-style: none;
	}
	.import-step {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}
	.import-step-index {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		color: var(--color-ws-faint);
		font-size: 12px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}
	.import-step-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.import-step-copy strong {
		color: var(--color-ws-text);
		font-size: 12.5px;
		font-weight: 800;
		line-height: 1.2;
	}
	.import-step-copy small {
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 600;
		line-height: 1.35;
	}
	.import-step.is-active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
	}
	.import-step.is-active .import-step-index {
		border-color: transparent;
		background: var(--color-ws-accent);
		color: var(--color-ws-ink);
	}
	.import-step.is-active .import-step-copy strong {
		color: var(--color-ws-ink);
	}
	.import-step.is-done .import-step-index {
		border-color: color-mix(in srgb, var(--color-ws-green) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 15%, transparent);
		color: var(--color-ws-green);
	}
	.import-step.is-done .import-step-copy strong {
		color: var(--color-ws-ink);
	}

	/* ── Command panel — quiet panel, solid violet primary (no teal wash) ── */
	.import-command {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 14px;
		padding: 14px 16px;
		border-radius: var(--radius-ws-card);
	}
	.command-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.command-eyebrow {
		color: var(--color-ws-violet);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.command-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.command-copy small {
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.35;
	}
	.command-actions {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.command-scope {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 800;
		line-height: 1.2;
		text-align: center;
	}

	/* ── Page-rows section ── */
	.target-review {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border-radius: var(--radius-ws-card);
	}
	.target-list {
		display: grid;
		gap: 8px;
	}

	/* Per-row article + empty state styles live in
	   ./workspace/import-review/ImportPageRow.svelte and ImportEmptyState.svelte. */

	@media (max-width: 860px) {
		.import-status-strip {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.import-steps {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.import-command {
			grid-template-columns: 1fr;
		}
		.command-actions {
			width: 100%;
		}
		.command-actions .import-action {
			flex: 1 1 130px;
		}
		.command-scope {
			width: 100%;
		}
	}

	@media (max-width: 560px) {
		/* Clear the mobile top bar so the eyebrow + chapter title aren't clipped
			under it. The shell sits at the top of the viewport on phones, so add
			safe top spacing on the centered content column. */
		.workspace-import-shell .ws-surface-inner {
			padding-top: max(20px, env(safe-area-inset-top, 0px));
		}
		.import-status-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.import-steps {
			grid-template-columns: 1fr;
		}
		.import-mismatch {
			flex-wrap: wrap;
		}
		.import-mismatch .import-action {
			width: 100%;
			margin-left: 0;
		}
	}
</style>
