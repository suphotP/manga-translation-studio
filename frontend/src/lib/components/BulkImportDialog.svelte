<script lang="ts">
	// Wave 3 W3.16: Bulk image import + merge/split.
	// Drag a folder (or many files) -> choose Keep as-is / Merge N per page /
	// Auto-split tall (>5000px). Reorder the preview strip before commit. The
	// server stitches/slices via sharp and routes results through the asset pipeline.
	import type { BulkImportMode } from "$lib/api/client.ts";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import {
		formatUnsupportedImageFileSummary,
		isSupportedImageFile,
		orderProjectImageFiles,
		SUPPORTED_IMAGE_ACCEPT,
	} from "$lib/project/file-order.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { _ } from "$lib/i18n";

	type PreviewItem = { name: string; url: string };

	let mode = $state<BulkImportMode>("keep");
	let perPage = $state(3);
	let splitThreshold = $state(5000);
	let files = $state<File[]>([]);
	let previews = $state<PreviewItem[]>([]);
	let unsupportedSummary = $state("");
	let dragActive = $state(false);
	let busy = $state(false);
	let localError = $state("");
	let fileInput: HTMLInputElement | null = $state(null);
	let folderInput: HTMLInputElement | null = $state(null);

	let fileCount = $derived(files.length);
	// Count only files the server would actually import (PNG/JPG/WEBP). Gating the
	// submit button on this — not the raw file count — keeps "Import" disabled when
	// the selection has zero valid images (e.g. only a .txt), matching the store,
	// which filters via filterProjectImageFiles and would otherwise no-op.
	let importableCount = $derived(files.filter((file) => isSupportedImageFile(file)).length);
	let projectName = $derived(projectStore.project?.name ?? "");
	let estimatedPages = $derived(estimatePageCount());
	let canSubmit = $derived(!busy && importableCount > 0 && Boolean(projectStore.project));
	// Live import progress (batched keep mode advances per-batch; merge/split stream
	// the single request's byte fraction). Only shown while busy.
	let progress = $derived(busy ? projectStore.bulkImportProgress : null);
	let progressPct = $derived(
		progress && progress.totalFiles > 0
			? Math.max(0, Math.min(100, Math.round((progress.uploadedFiles / progress.totalFiles) * 100)))
			: 0,
	);

	function estimatePageCount(): number {
		if (!fileCount) return 0;
		if (mode === "merge") return Math.ceil(fileCount / Math.max(2, Math.min(50, Math.round(perPage))));
		// split is image-dependent (server decides), so show the source count as a floor.
		return fileCount;
	}

	$effect(() => {
		const urls: string[] = [];
		const next = files.slice(0, 60).map((file) => {
			const url = typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
				? URL.createObjectURL(file)
				: "";
			if (url) urls.push(url);
			return { name: file.name, url };
		}).filter((item) => item.url);
		previews = next;
		return () => {
			for (const url of urls) URL.revokeObjectURL?.(url);
		};
	});

	function setFiles(incoming: File[]): void {
		files = orderProjectImageFiles(incoming);
		unsupportedSummary = formatUnsupportedImageFileSummary(incoming);
		localError = "";
	}

	function onFilesChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		setFiles(Array.from(input.files ?? []));
	}

	// Recursively read a dropped directory (webkit entry API) so dragging a folder
	// of images works, not only multi-file selection.
	async function readEntry(entry: any): Promise<File[]> {
		if (!entry) return [];
		if (entry.isFile) {
			return new Promise<File[]>((resolve) => {
				entry.file((file: File) => resolve([file]), () => resolve([]));
			});
		}
		if (entry.isDirectory) {
			const reader = entry.createReader();
			const all: File[] = [];
			// readEntries returns in batches; keep reading until empty.
			const readBatch = (): Promise<any[]> => new Promise((resolve) => {
				reader.readEntries((entries: any[]) => resolve(entries), () => resolve([]));
			});
			let batch = await readBatch();
			while (batch.length) {
				for (const child of batch) {
					all.push(...(await readEntry(child)));
				}
				batch = await readBatch();
			}
			return all;
		}
		return [];
	}

	async function handleDrop(event: DragEvent): Promise<void> {
		event.preventDefault();
		event.stopPropagation();
		dragActive = false;
		const items = event.dataTransfer?.items;
		if (items && items.length && typeof (items[0] as any).webkitGetAsEntry === "function") {
			const collected: File[] = [];
			const entries = Array.from(items)
				.map((item) => (item as any).webkitGetAsEntry?.())
				.filter(Boolean);
			for (const entry of entries) {
				collected.push(...(await readEntry(entry)));
			}
			if (collected.length) {
				setFiles(collected.filter((file) => isSupportedImageFile(file) || true));
				return;
			}
		}
		const dropped = Array.from(event.dataTransfer?.files ?? []);
		if (dropped.length) setFiles(dropped);
	}

	function handleDrag(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		if (event.type === "dragenter" || event.type === "dragover") dragActive = true;
		else if (event.type === "dragleave") dragActive = false;
	}

	function move(index: number, direction: -1 | 1): void {
		const target = index + direction;
		if (target < 0 || target >= files.length) return;
		const next = [...files];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item);
		files = next;
	}

	function sortByName(direction: "asc" | "desc"): void {
		files = [...files].sort((a, b) => (direction === "asc"
			? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
			: b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" })));
	}

	function clearFiles(): void {
		files = [];
		unsupportedSummary = "";
	}

	function close(): void {
		if (busy) return;
		editorUiStore.closeBulkImport();
		files = [];
		previews = [];
		unsupportedSummary = "";
		localError = "";
		mode = "keep";
		dragActive = false;
	}

	async function commit(): Promise<void> {
		if (!projectStore.project) {
			localError = $_("bulkImport.errOpenChapter");
			return;
		}
		if (!importableCount) {
			localError = $_("bulkImport.errPickFirst");
			return;
		}
		busy = true;
		localError = "";
		try {
			const added = await projectStore.bulkImportPages(files, mode, editorStore.editor, {
				perPage: mode === "merge" ? Math.max(2, Math.min(50, Math.round(perPage))) : undefined,
				splitThreshold: mode === "split" ? Math.max(256, Math.round(splitThreshold)) : undefined,
			});
			if (added > 0) {
				// Clear busy BEFORE close(): close() guards itself with `if (busy) return`
				// (so a user cannot cancel/Escape mid-import). Leaving busy=true here
				// would make this success-path close() a no-op, stranding the dialog open
				// after a 200 — the user thinks it failed and re-imports, duplicating pages.
				busy = false;
				close();
				// bulkImportPages already navigated to the first imported page + set a
				// "Importแล้ว N หน้า" status, so the user lands on the imported work.
				return;
			}
			localError = projectStore.statusMsg || $_("bulkImport.errImportFailed");
		} catch (error) {
			localError = error instanceof Error ? error.message : $_("bulkImport.errImportFailed");
		} finally {
			busy = false;
		}
	}
</script>

{#if editorUiStore.bulkImportOpen}
	<div class="bi-layer">
		<div class="bi-backdrop" role="presentation" onclick={close}></div>
		<div
			class="bi-dialog ws-panel"
			role="dialog"
			aria-modal="true"
			aria-label={$_("bulkImport.dialogLabel")}
			tabindex="-1"
			use:dialogFocus={{ onEscape: close, busy }}
		>
			<header class="bi-head">
				<div>
					<span class="bi-eyebrow">{$_("bulkImport.eyebrow")}</span>
					<h2>{projectName ? $_("bulkImport.titleInto", { values: { count: fileCount, project: projectName } }) : $_("bulkImport.title", { values: { count: fileCount } })}</h2>
					<p>{$_("bulkImport.lede")}</p>
				</div>
				<button type="button" class="bi-close ws-btn-ghost" onclick={close} aria-label={$_("bulkImport.close")}>✕</button>
			</header>

			<div class="bi-body">
				<div
					class="bi-dropzone"
					class:drag-active={dragActive}
					role="button"
					tabindex="0"
					ondragenter={handleDrag}
					ondragover={handleDrag}
					ondragleave={handleDrag}
					ondrop={handleDrop}
					onclick={() => fileInput?.click()}
					onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput?.click(); }}
				>
					<input
						bind:this={fileInput}
						class="bi-hidden-input"
						type="file"
						accept={SUPPORTED_IMAGE_ACCEPT}
						multiple
						onchange={onFilesChange}
					/>
					<input
						bind:this={folderInput}
						class="bi-hidden-input"
						type="file"
						accept={SUPPORTED_IMAGE_ACCEPT}
						multiple
						webkitdirectory
						onchange={onFilesChange}
					/>
					<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
						<path d="M12 11v5" /><path d="M9.5 13.5 12 11l2.5 2.5" />
					</svg>
					<strong>{$_("bulkImport.dropzoneTitle")}</strong>
					<span>{$_("bulkImport.dropzoneOr")}</span>
					<div class="bi-pick-row">
						<button type="button" class="ws-btn-ghost" onclick={(e) => { e.stopPropagation(); folderInput?.click(); }}>{$_("bulkImport.pickFolder")}</button>
						<small>{$_("bulkImport.supportedFormats")}</small>
					</div>
				</div>

				{#if unsupportedSummary}
					<p class="bi-warn">{unsupportedSummary}</p>
				{/if}

				<fieldset class="bi-modes" aria-label={$_("bulkImport.modesLabel")}>
					<label class="bi-mode" class:on={mode === "keep"}>
						<input type="radio" name="bi-mode" value="keep" bind:group={mode} />
						<strong>{$_("bulkImport.modeKeepTitle")}</strong>
						<small>{$_("bulkImport.modeKeepDetail", { values: { count: fileCount || 0 } })}</small>
					</label>
					<label class="bi-mode" class:on={mode === "merge"}>
						<input type="radio" name="bi-mode" value="merge" bind:group={mode} />
						<strong>{$_("bulkImport.modeMergeTitle")}</strong>
						<small>{$_("bulkImport.modeMergeDetail")}</small>
						{#if mode === "merge"}
							<div class="bi-mode-control" role="group" aria-label={$_("bulkImport.perPageGroupLabel")}>
								<button type="button" onclick={() => (perPage = Math.max(2, perPage - 1))} aria-label={$_("bulkImport.decrease")}>−</button>
								<input type="number" min="2" max="50" bind:value={perPage} aria-label={$_("bulkImport.imagesPerPageLabel")} />
								<button type="button" onclick={() => (perPage = Math.min(50, perPage + 1))} aria-label={$_("bulkImport.increase")}>+</button>
								<span>{$_("bulkImport.approxPages", { values: { count: estimatedPages } })}</span>
							</div>
						{/if}
					</label>
					<label class="bi-mode" class:on={mode === "split"}>
						<input type="radio" name="bi-mode" value="split" bind:group={mode} />
						<strong>{$_("bulkImport.modeSplitTitle")}</strong>
						<small>{$_("bulkImport.modeSplitDetail")}</small>
						{#if mode === "split"}
							<div class="bi-mode-control" role="group" aria-label={$_("bulkImport.maxHeightGroupLabel")}>
								<input type="number" min="256" step="100" bind:value={splitThreshold} aria-label={$_("bulkImport.maxHeightLabel")} />
								<span>{$_("bulkImport.pxPerPage")}</span>
							</div>
						{/if}
					</label>
				</fieldset>

				{#if fileCount}
					<section class="bi-preview" aria-label={$_("bulkImport.previewLabel")}>
						<div class="bi-preview-head">
							<strong>{$_("bulkImport.imageCount", { values: { count: fileCount } })}</strong>
							<div class="bi-preview-actions">
								<button type="button" class="ws-btn-ghost" onclick={() => sortByName("asc")}>A→Z</button>
								<button type="button" class="ws-btn-ghost" onclick={() => sortByName("desc")}>Z→A</button>
								<button type="button" class="ws-btn-ghost danger" onclick={clearFiles}>{$_("bulkImport.clear")}</button>
							</div>
						</div>
						<div class="bi-strip">
							{#each previews as item, index (item.name + index)}
								<figure>
									<div class="bi-thumb">
										<img src={item.url} alt={$_("bulkImport.imageAlt", { values: { index: index + 1, name: item.name } })} />
										<div class="bi-arrows">
											<button type="button" disabled={index === 0} onclick={() => move(index, -1)} aria-label={$_("bulkImport.moveLeft")}>◀</button>
											<button type="button" disabled={index === files.length - 1} onclick={() => move(index, 1)} aria-label={$_("bulkImport.moveRight")}>▶</button>
										</div>
									</div>
									<figcaption><span class="bi-idx">{index + 1}</span><span title={item.name}>{item.name}</span></figcaption>
								</figure>
							{/each}
							{#if files.length > previews.length}
								<div class="bi-more"><span>+{files.length - previews.length}</span><small>{$_("bulkImport.moreImages")}</small></div>
							{/if}
						</div>
					</section>
				{/if}

				{#if busy && progress}
					<div class="bi-progress" role="status" aria-live="polite">
						<div class="bi-progress-head">
							<span>
								{projectStore.statusMsg || `${Math.min(Math.round(progress.uploadedFiles), progress.totalFiles)}/${progress.totalFiles}`}
							</span>
							<strong>{progressPct}%</strong>
						</div>
						<div
							class="bi-progress-track"
							role="progressbar"
							aria-valuemin="0"
							aria-valuemax="100"
							aria-valuenow={progressPct}
						>
							<div class="bi-progress-fill" style={`width:${progressPct}%`}></div>
						</div>
					</div>
				{/if}

				{#if localError}
					<p class="bi-error" role="alert">{localError}</p>
				{/if}
			</div>

			<footer class="bi-foot">
				<span class="bi-foot-hint">{busy ? $_("bulkImport.importingHint") : (fileCount ? $_("bulkImport.footSummary", { values: { count: fileCount, prefix: mode === "split" ? "≥" : "", pages: estimatedPages } }) : $_("bulkImport.noImagesYet"))}</span>
				<div class="bi-foot-actions">
					<button type="button" class="ws-btn-ghost" onclick={close} disabled={busy}>{$_("bulkImport.cancel")}</button>
					<button type="button" class="bi-primary" onclick={commit} disabled={!canSubmit}>
						{busy ? $_("bulkImport.importing") : $_("bulkImport.importBtn")}
					</button>
				</div>
			</footer>
		</div>
	</div>
{/if}

<style>
	.bi-layer {
		position: fixed;
		inset: 0;
		z-index: 1600;
	}

	.bi-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(2, 6, 12, 0.66);
		backdrop-filter: blur(12px);
	}

	.bi-dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		width: min(760px, calc(100vw - 32px));
		max-height: calc(100vh - 48px);
		border-radius: var(--radius-ws);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		overflow: hidden;
	}

	.bi-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 18px 14px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.bi-eyebrow {
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.02em;
	}

	.bi-head h2 {
		margin: 5px 0 4px;
		font-size: 21px;
		font-weight: 820;
		line-height: 1.12;
	}

	.bi-head p {
		margin: 0;
		max-width: 560px;
		color: var(--color-ws-text);
		font-size: 12.5px;
		line-height: 1.5;
	}

	.bi-close {
		flex: none;
		width: 34px;
		height: 34px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 13px;
		cursor: pointer;
	}

	.bi-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px 18px;
		overflow: auto;
	}

	.bi-dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 132px;
		padding: 18px;
		border: 2px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: rgba(255, 255, 255, 0.02);
		color: var(--color-ws-text);
		text-align: center;
		cursor: pointer;
		transition: border-color 0.16s ease, background 0.16s ease;
	}

	.bi-dropzone:hover,
	.bi-dropzone.drag-active {
		border-color: var(--color-ws-accent);
		background: rgba(124, 92, 255, 0.08);
		color: var(--color-ws-ink);
	}

	.bi-dropzone strong {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 800;
	}

	.bi-dropzone span {
		font-size: 12px;
	}

	.bi-pick-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}

	.bi-pick-row button {
		min-height: 34px;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 750;
		cursor: pointer;
	}

	.bi-pick-row small {
		color: var(--color-ws-faint);
		font-size: 11px;
	}

	.bi-hidden-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		opacity: 0;
		pointer-events: none;
	}

	.bi-warn {
		margin: 0;
		color: var(--color-ws-amber);
		font-size: 12px;
		font-weight: 720;
	}

	.bi-modes {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.bi-mode {
		display: grid;
		gap: 3px;
		align-content: start;
		padding: 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: rgba(255, 255, 255, 0.02);
		cursor: pointer;
		transition: border-color 0.16s ease, background 0.16s ease;
	}

	.bi-mode.on {
		border-color: rgba(124, 92, 255, 0.5);
		background: linear-gradient(100deg, rgba(124, 92, 255, 0.16), rgba(217, 70, 239, 0.08));
	}

	.bi-mode input[type="radio"] {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.bi-mode strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
	}

	.bi-mode small {
		color: var(--color-ws-text);
		font-size: 11.5px;
		line-height: 1.35;
	}

	.bi-mode-control {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		flex-wrap: wrap;
	}

	.bi-mode-control button {
		width: 30px;
		height: 30px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 800;
		cursor: pointer;
	}

	.bi-mode-control input {
		width: 56px;
		height: 30px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 8px;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
		text-align: center;
	}

	.bi-mode-control span {
		color: var(--color-ws-cyan);
		font-size: 11px;
		font-weight: 750;
	}

	.bi-preview {
		display: grid;
		gap: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: rgba(255, 255, 255, 0.02);
		padding: 12px;
	}

	.bi-preview-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.bi-preview-head strong {
		color: var(--color-ws-ink);
		font-size: 12.5px;
		font-weight: 820;
	}

	.bi-preview-actions {
		display: flex;
		gap: 6px;
	}

	.bi-preview-actions button {
		min-height: 32px;
		padding: 0 10px;
		border-radius: 8px;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 780;
		cursor: pointer;
	}

	.bi-preview-actions .danger {
		color: var(--color-ws-rose);
	}

	.bi-strip {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
		gap: 8px;
		max-height: 280px;
		overflow-y: auto;
		scrollbar-width: thin;
	}

	.bi-strip figure {
		display: flex;
		flex-direction: column;
		margin: 0;
		border: 1px solid var(--ws-hair);
		border-radius: 10px;
		background: var(--color-ws-bg);
		overflow: hidden;
	}

	.bi-thumb {
		position: relative;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		background: #020617;
	}

	.bi-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.bi-arrows {
		position: absolute;
		bottom: 4px;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		gap: 4px;
		opacity: 0;
		transition: opacity 0.16s ease;
	}

	.bi-strip figure:hover .bi-arrows {
		opacity: 1;
	}

	.bi-arrows button {
		width: 30px;
		height: 30px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		background: rgba(11, 11, 15, 0.85);
		color: var(--color-ws-ink);
		font-size: 9px;
		cursor: pointer;
	}

	.bi-arrows button:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.bi-strip figcaption {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		padding: 6px;
	}

	.bi-idx {
		flex: none;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
	}

	.bi-strip figcaption span:last-child {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-faint);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bi-more {
		display: grid;
		place-items: center;
		align-content: center;
		border: 1px solid var(--ws-hair);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.02);
		color: var(--color-ws-ink);
	}

	.bi-more span {
		font-size: 17px;
		font-weight: 900;
	}

	.bi-more small {
		color: var(--color-ws-faint);
		font-size: 10px;
	}

	.bi-progress {
		display: grid;
		gap: 6px;
	}

	.bi-progress-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 720;
	}

	.bi-progress-head strong {
		color: var(--color-ws-ink);
		font-size: 12.5px;
		font-weight: 850;
	}

	.bi-progress-track {
		height: 8px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
	}

	.bi-progress-fill {
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(100deg, #8b5cf6 0%, #d946ef 100%);
		transition: width 0.2s ease;
	}

	.bi-error {
		margin: 0;
		color: var(--color-ws-rose);
		font-size: 12.5px;
		font-weight: 780;
	}

	.bi-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 18px;
		border-top: 1px solid var(--ws-hair);
	}

	.bi-foot-hint {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 720;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bi-foot-actions {
		display: flex;
		flex: none;
		gap: 8px;
	}

	.bi-foot-actions button {
		min-height: 38px;
		padding: 0 14px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
		cursor: pointer;
	}

	.bi-primary {
		border: 1px solid rgba(124, 92, 255, 0.5);
		background: linear-gradient(100deg, #8b5cf6 0%, #d946ef 100%);
		color: #fff;
	}

	.bi-primary:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (max-width: 640px) {
		.bi-modes {
			grid-template-columns: 1fr;
		}

		.bi-strip {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
