<!-- StatusBar: bottom bar with project info and AI status -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editLeaseStore } from "$lib/stores/edit-lease.svelte.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import { editorUiStore, type WorkspaceView } from "$lib/stores/editor-ui.svelte.ts";
	import {
		resolveVisiblePageLayerCount,
		summarizePageWork,
	} from "$lib/project/page-work-summary.js";
	import { resolvePageSignalLabel } from "$lib/project/page-work-copy-i18n.js";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import type {
		AiReviewMarker,
		PageReviewDecision,
		ProjectComment,
		ProjectState,
		WorkflowTask,
	} from "$lib/types.js";

	let savedAtTime = $derived(projectStore.lastSavedAt
		? new Date(projectStore.lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: null);
	let saveChipText = $derived(
		projectStore.saveSyncStatus === "error" && projectStore.saveErrorKind === "brush"
			? $_("statusBar.saveChipBrushUnsaved")
			: projectStore.saveSyncStatus === "error"
			? $_("statusBar.saveChipError", { values: { message: projectStore.saveErrorMessage ?? $_("statusBar.saveErrorRetry") } })
			: projectStore.saveSyncStatus === "saved" && savedAtTime
			? `${projectStore.saveSyncLabel} ${savedAtTime}`
			: projectStore.saveSyncStatus === "saving"
			? `${projectStore.saveSyncLabel}…`
			: projectStore.saveSyncLabel,
	);
	let saveRecoveryLabel = $derived(projectStore.saveErrorKind === "conflict"
		? $_("statusBar.recoveryConflict")
		: projectStore.saveErrorKind === "brush"
			? editorStore.brushTarget.kind === "image-layer" ? $_("statusBar.recoveryOpenLayer") : $_("statusBar.recoveryOpenBrush")
			: $_("statusBar.recoveryRetry"));
	let saveRecoveryAriaLabel = $derived(projectStore.saveErrorKind === "conflict"
		? $_("statusBar.recoveryConflictAria")
		: projectStore.saveErrorKind === "brush"
			? editorStore.brushTarget.kind === "image-layer"
				? $_("statusBar.recoveryLayerAria")
				: $_("statusBar.recoveryBrushAria")
			: $_("statusBar.recoveryRetryAria"));
	// The "old work retained, new project NOT opened" status is rendered by the
	// WorkspaceShell save-recovery card, so the StatusBar suppresses its own retry
	// button. Matched on the stable `prev_work_present` code (was a brittle
	// startsWith/includes on the rendered Thai).
	let saveRecoveryHandledByWorkspaceCard = $derived(
		projectStore.statusMsgCode === "prev_work_present",
	);
	let currentPageSummary = $derived.by(() => buildCurrentPageSummary(
		projectStore.project,
		projectStore.tasks,
		projectStore.comments,
		projectStore.aiReviewMarkers,
		projectStore.reviewDecisions,
		projectStore.qcReport.issues,
		editorStore.textLayers.length,
		editorStore.hasImage,
	));
	// With no project open, the idle "open a folder to start" status (stable code
	// `open_folder_to_start`) is replaced by the workspace-specific empty copy.
	// Matched on the code (was a Set of the rendered EN/TH idle strings).
	let statusText = $derived(projectStore.project || projectStore.statusMsgCode !== "open_folder_to_start"
		? safeProjectStatusText()
		: emptyWorkspaceStatus(editorUiStore.workspaceView));
	let displayStatusText = $derived(formatStatusText(statusText));
	let displayProjectName = $derived(projectStore.project ? $_("statusBar.projectName", { values: { name: projectStore.project.name } }) : "");
	let showLockFallbackChip = $derived(Boolean(projectStore.project) && editLeaseStore.status === "unavailable");
	let pendingReloadConfirmation = $state(false);
	let conflictReloadBusy = $state(false);
	let conflictReloadError = $state<string | null>(null);

	onMount(() => {
		const handleConflictReloadRequest = () => {
			if (projectStore.project && projectStore.saveErrorKind === "conflict") {
				conflictReloadError = null;
				pendingReloadConfirmation = true;
			}
		};
		window.addEventListener("manga-editor:request-conflict-reload", handleConflictReloadRequest);
		return () => window.removeEventListener("manga-editor:request-conflict-reload", handleConflictReloadRequest);
	});

	function formatStatusText(value: string): string {
		const pageMatch = /^Page (\d+) \/ (\d+)$/u.exec(value.trim());
		if (pageMatch) return $_("statusBar.pageProgress", { values: { current: pageMatch[1], total: pageMatch[2] } });
		return value;
	}

	function buildCurrentPageSummary(
		project: ProjectState | null,
		tasks: WorkflowTask[],
		comments: ProjectComment[],
		aiReviewMarkers: AiReviewMarker[],
		reviewDecisions: PageReviewDecision[],
		qcIssues: QcIssue[],
		currentEditorTextLayerCount: number,
		currentEditorHasImage: boolean,
	) {
		if (!project) return null;
		const pageIndex = project.currentPage;
		const page = project.pages[pageIndex];
		if (!page) return null;
		return summarizePageWork({
			page,
			pageIndex,
			layerCount: resolveVisiblePageLayerCount(
				page,
				true,
				currentEditorTextLayerCount,
				currentEditorHasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(pageIndex),
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		});
	}

	function safeProjectStatusText(): string {
		const status = projectStore.statusMsg;
		const primarySignal = currentPageSummary?.primarySignal;
		if (
			primarySignal
			&& !currentPageSummary?.exportReady
			// SENTINEL (untranslatable): a Thai-range regex value-match against the
			// rendered status string, produced in stores/project.svelte.ts /
			// project/page-operations.ts ("…พร้อม Export…"). NOT convertible to a stable
			// code: the regex matches a "พร้อม Export" SUBSTRING present in only SOME of
			// the export statuses assigned here (the single-page failure fallback reason,
			// the debug status), not the "Export ยังไม่พร้อม" gate/credit messages — so a
			// single `export_readiness` code would over-match and change behavior. The
			// status TEXT it scans is the deferred 274-producer cluster (#492), so the
			// regex literal stays Thai by necessity until that text is localized.
			&& (/พร้อม\s*Export/u.test(status) || /Export พร้อม/u.test(status))
		) {
			return $_("statusBar.exportNotReady", { values: { label: resolvePageSignalLabel(primarySignal, $_) } });
		}
		return status;
	}

	function emptyWorkspaceStatus(view: WorkspaceView): string {
		const labels: Record<WorkspaceView, string> = {
			dashboard: $_("statusBar.emptyDashboard"),
			tasks: $_("statusBar.emptyTasks"),
			inbox: $_("statusBar.emptyInbox"),
			library: $_("statusBar.emptyLibrary"),
			pages: $_("statusBar.emptyPages"),
			work: $_("statusBar.emptyWork"),
			import: $_("statusBar.emptyImport"),
			review: $_("statusBar.emptyReview"),
			editor: $_("statusBar.emptyEditor"),
			settings: $_("statusBar.emptySettings"),
			reports: $_("statusBar.emptyReports"),
		};
		return labels[view] ?? "";
	}

	function recoverSaveFailure(): void {
		if (projectStore.saveErrorKind === "conflict") {
			if (!projectStore.project) return;
			conflictReloadError = null;
			pendingReloadConfirmation = true;
			return;
		}
		if (projectStore.saveErrorKind === "brush") {
			editorStore.setTool("brush");
			editorUiStore.setRightPanelMode(editorStore.brushTarget.kind === "image-layer" ? "layers" : "ai");
			return;
		}
		void projectStore.saveCurrentPage(editorStore.editor);
	}

	function cancelReloadConfirmation(): void {
		if (conflictReloadBusy) return;
		pendingReloadConfirmation = false;
		conflictReloadError = null;
	}

	async function reloadProjectWithRecoveryCopy(): Promise<void> {
		if (!projectStore.project) {
			pendingReloadConfirmation = false;
			return;
		}
		conflictReloadBusy = true;
		conflictReloadError = null;
		try {
			const opened = await projectStore.reloadProjectAfterConflict(editorStore.editor, {
				createRecoveryCopy: true,
			});
			if (opened) pendingReloadConfirmation = false;
		} catch (error) {
			conflictReloadError = error instanceof Error ? error.message : $_("statusBar.reloadFailed");
		} finally {
			conflictReloadBusy = false;
		}
	}

	async function reloadProjectWithoutRecoveryCopy(): Promise<void> {
		if (!projectStore.project) {
			pendingReloadConfirmation = false;
			return;
		}
		conflictReloadBusy = true;
		conflictReloadError = null;
		try {
			const opened = await projectStore.reloadProjectAfterConflict(editorStore.editor, {
				createRecoveryCopy: false,
			});
			if (opened) pendingReloadConfirmation = false;
		} catch (error) {
			conflictReloadError = error instanceof Error ? error.message : $_("statusBar.reloadFailed");
		} finally {
			conflictReloadBusy = false;
		}
	}

	async function downloadLocalConflictCopy(): Promise<void> {
		await projectStore.downloadLocalConflictCopy(editorStore.editor);
	}
</script>

<div
	class="status-bar ws-panel-quiet flex items-center justify-between px-4"
	role="status"
	aria-label={$_("statusBar.barAria")}
	aria-live="polite"
>
	<span class="status-main" title={aiJobsStore.aiStatus || displayStatusText}>
		{#if aiJobsStore.aiStatus}
			<span class="status-ai-label">AI</span>{aiJobsStore.aiStatus}
		{:else}
			{displayStatusText}
		{/if}
	</span>
	<div class="status-meta flex items-center gap-4">
		{#if projectStore.project}
			<span class={`status-save-chip ${projectStore.saveSyncStatus}`} title={projectStore.saveSyncDetail}>
				{saveChipText}
			</span>
			{#if projectStore.saveSyncStatus === "error" && !saveRecoveryHandledByWorkspaceCard}
				<button
					type="button"
					class="status-retry-save ws-btn-ghost"
					aria-label={saveRecoveryAriaLabel}
					onclick={recoverSaveFailure}
				>
					{saveRecoveryLabel}
				</button>
			{/if}
			{#if showLockFallbackChip}
				<span class="status-lock-chip unavailable" title={$_("statusBar.lockSoloFallbackTitle")}>
					{$_("statusBar.lockSoloFallback")}
				</span>
			{/if}
		{/if}
		<span class="status-zoom">
			{Math.round(editorStore.zoomLevel * 100)}%
		</span>
		<span class="status-project-name" title={displayProjectName}>{displayProjectName}</span>
	</div>
</div>

{#if pendingReloadConfirmation && projectStore.project}
	<div class="reload-confirmation-backdrop" role="presentation">
		<div
			class="reload-confirmation-dialog ws-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="reload-confirmation-title"
			aria-describedby="reload-confirmation-description"
			tabindex="-1"
			use:dialogFocus={{ onEscape: cancelReloadConfirmation, busy: conflictReloadBusy }}
		>
			<div class="reload-confirmation-copy">
				<span>{$_("statusBar.reloadEyebrow")}</span>
				<h3 id="reload-confirmation-title">{$_("statusBar.reloadTitle")}</h3>
				<p id="reload-confirmation-description">
					{$_("statusBar.reloadDescription")}
				</p>
			</div>
			<div class="reload-confirmation-meta ws-panel-quiet">
				<strong>{projectStore.project.name}</strong>
				<small>{projectStore.saveErrorMessage ?? $_("statusBar.reloadMetaFallback")}</small>
			</div>
			{#if conflictReloadError}
				<div class="reload-confirmation-error" role="alert">{conflictReloadError}</div>
			{/if}
			{#if conflictReloadBusy}
				<div class="reload-confirmation-busy ws-panel-quiet" role="status">{$_("statusBar.reloadBusy")}</div>
			{:else}
				<div class="reload-confirmation-actions">
					<button type="button" class="primary ws-grad-primary" onclick={() => void reloadProjectWithRecoveryCopy()}>
						{$_("statusBar.reloadKeepCopy")}
					</button>
					<button type="button" class="ws-btn-ghost" onclick={cancelReloadConfirmation}>{$_("statusBar.reloadBackToTab")}</button>
					<button type="button" class="ws-btn-ghost" onclick={() => void downloadLocalConflictCopy()}>{$_("statusBar.reloadDownloadJson")}</button>
				</div>
				<details class="reload-destructive-details">
					<summary>{$_("statusBar.reloadRiskyOption")}</summary>
					<button type="button" class="danger ws-btn-ghost" onclick={() => void reloadProjectWithoutRecoveryCopy()}>
						{$_("statusBar.reloadWithoutCopy")}
					</button>
				</details>
			{/if}
		</div>
	</div>
{/if}

<style>
	.status-bar {
		gap: 10px;
		height: 100%;
		min-width: 0;
		/* ws-panel-quiet supplies a 4-sided border; the bar keeps top-only */
		border: 0;
		border-top: 1px solid var(--ws-hair);
		background: var(--color-ws-bg);
		color: var(--color-ws-text);
		font-family: var(--font-ws-sans);
		font-size: 11px;
	}

	.status-main {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status-ai-label {
		margin-right: 6px;
		color: var(--color-ws-cyan);
		font-weight: 900;
	}

	.status-meta {
		min-width: 0;
		flex: 0 1 auto;
		justify-content: flex-end;
	}

	.status-project-name {
		min-width: 0;
		max-width: min(260px, 30vw);
		overflow: hidden;
		color: var(--color-ws-text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status-zoom {
		color: var(--color-ws-faint);
		font-variant-numeric: tabular-nums;
	}

	.status-save-chip {
		display: inline-flex;
		align-items: center;
		max-width: 260px;
		min-height: 24px;
		overflow: hidden;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status-save-chip.saved {
		border-color: color-mix(in srgb, var(--color-ws-green) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 14%, transparent);
		color: color-mix(in srgb, var(--color-ws-green) 78%, var(--color-ws-ink));
	}

	.status-save-chip.saving {
		border-color: color-mix(in srgb, var(--color-ws-cyan) 48%, transparent);
		background: color-mix(in srgb, var(--color-ws-cyan) 14%, transparent);
		color: color-mix(in srgb, var(--color-ws-cyan) 70%, var(--color-ws-ink));
	}

	.status-save-chip.unsaved {
		border-color: color-mix(in srgb, var(--color-ws-amber) 44%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 13%, transparent);
		color: color-mix(in srgb, var(--color-ws-amber) 74%, var(--color-ws-ink));
	}

	.status-save-chip.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 52%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 15%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
	}

	.status-lock-chip {
		display: inline-flex;
		align-items: center;
		max-width: 250px;
		min-height: 24px;
		overflow: hidden;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		font-size: 10px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status-lock-chip.unavailable {
		border-color: color-mix(in srgb, var(--color-ws-amber) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 13%, transparent);
		color: color-mix(in srgb, var(--color-ws-amber) 74%, var(--color-ws-ink));
	}

	.status-retry-save {
		min-height: 40px;
		padding: 0 12px;
		border-color: color-mix(in srgb, var(--color-ws-rose) 50%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 58%, var(--color-ws-ink));
		font-size: 11px;
		font-weight: 850;
		cursor: pointer;
	}

	.status-retry-save:hover {
		border-color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-line));
		background: color-mix(in srgb, var(--color-ws-rose) 20%, transparent);
	}

	.reload-confirmation-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: color-mix(in srgb, var(--color-ws-bg) 76%, transparent);
		backdrop-filter: blur(10px);
	}

	.reload-confirmation-dialog {
		display: grid;
		width: min(440px, 100%);
		gap: 14px;
		padding: 18px;
		border-color: color-mix(in srgb, var(--color-ws-rose) 32%, var(--ws-hair));
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 3%, transparent) inset,
			0 24px 72px -34px color-mix(in srgb, var(--color-ws-bg) 94%, transparent);
		color: var(--color-ws-ink);
	}

	.reload-confirmation-copy {
		display: grid;
		gap: 6px;
	}

	.reload-confirmation-copy span {
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
		font-size: 11px;
		font-weight: 880;
	}

	.reload-confirmation-copy h3,
	.reload-confirmation-copy p {
		margin: 0;
	}

	.reload-confirmation-copy h3 {
		font-size: 18px;
		font-weight: 900;
		line-height: 1.2;
	}

	.reload-confirmation-copy p {
		color: var(--color-ws-text);
		font-size: 13px;
		font-weight: 700;
		line-height: 1.45;
	}

	.reload-confirmation-meta {
		display: grid;
		gap: 3px;
		padding: 10px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
	}

	.reload-confirmation-meta strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reload-confirmation-meta small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 720;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reload-confirmation-actions {
		display: grid;
		grid-template-columns: minmax(0, 1.35fr) repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.reload-confirmation-error {
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-rose) 11%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 62%, var(--color-ws-ink));
		font-size: 12px;
		font-weight: 760;
	}

	.reload-confirmation-actions button {
		min-height: 40px;
		padding: 0 14px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		font-weight: 850;
	}

	.reload-confirmation-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, var(--ws-hair));
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
	}

	.reload-confirmation-busy {
		display: flex;
		align-items: center;
		min-height: 40px;
		padding: 0 14px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-cyan) 34%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-cyan) 10%, transparent);
		color: color-mix(in srgb, var(--color-ws-cyan) 72%, var(--color-ws-ink));
		font-size: 12px;
		font-weight: 850;
	}

	.reload-destructive-details {
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 22%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-rose) 7%, transparent);
	}

	.reload-destructive-details summary {
		min-height: 38px;
		padding: 9px 10px;
		color: color-mix(in srgb, var(--color-ws-rose) 60%, var(--color-ws-ink));
		cursor: pointer;
		font-size: 12px;
		font-weight: 820;
		list-style: none;
	}

	.reload-destructive-details summary::-webkit-details-marker {
		display: none;
	}

	.reload-destructive-details .danger {
		width: calc(100% - 16px);
		min-height: 40px;
		margin: 0 8px 8px;
		border-color: color-mix(in srgb, var(--color-ws-rose) 36%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 60%, var(--color-ws-ink));
		font-family: inherit;
		font-size: 12px;
		font-weight: 850;
	}

	@media (min-width: 901px) and (max-width: 1040px) {
		.status-retry-save {
			padding-inline: 12px;
		}
	}
</style>
