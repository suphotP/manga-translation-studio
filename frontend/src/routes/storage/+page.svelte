<!-- /storage — Workspace Storage Library (asset/storage management).

     Owner need: "a place to store images that I can FILTER (which images eat the
     most space, which project), drill in, and DELETE to reclaim space." This
     surface lists every asset across the workspace's projects with per-image
     bytes + per-project + workspace totals, biggest-first by default, filterable
     by project + kind; drilling into a project lets you delete images. Delete is
     reference-safe: an asset still on a live page warns + requires explicit
     confirmation before it is removed from storage.

     Standalone surface (outside the editor shell) using the shared `.ws-surface`
     frame + WorkspacePageHeader so it matches the app. Nav entry wired separately
     (link target: /storage). -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import * as api from "$lib/api/client.ts";
	import { ApiError } from "$lib/api/client.ts";
	import type {
		WorkspaceStorageAsset,
		WorkspaceStorageListResult,
		StorageAssetKind,
		StorageAssetSort,
	} from "$lib/api/client.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import { formatBytes } from "$lib/stores/usage.svelte.ts";
	import WorkspacePageHeader from "$lib/components/ui/WorkspacePageHeader.svelte";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import StorageStatTile from "$lib/components/storage/StorageStatTile.svelte";
	import StorageAssetCard from "$lib/components/storage/StorageAssetCard.svelte";

	// Localise via svelte-i18n with a Thai fallback ($_ returns the key itself on
	// a miss / before init, so guard against that).
	function t(key: string, fallback: string, params?: Record<string, string | number>): string {
		const value = $_(key, params ? { values: params } : undefined);
		return value && value !== key ? value : fallback;
	}

	let ready = $state(false);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let data = $state<WorkspaceStorageListResult | null>(null);

	// Filters / sort.
	let projectFilter = $state<string>(""); // "" = all projects
	let kindFilter = $state<"" | StorageAssetKind>("");
	let sort = $state<StorageAssetSort>("size");

	// Delete confirmation state.
	let pendingDelete = $state<WorkspaceStorageAsset | null>(null);
	let pendingReferencedPages = $state<number[] | null>(null);
	let deletingId = $state<string | null>(null);

	let workspaceId = $derived(workspacesStore.currentWorkspace?.workspaceId ?? null);

	async function refresh() {
		if (!workspaceId) return;
		loading = true;
		loadError = null;
		try {
			data = await api.listWorkspaceStorageAssets(workspaceId, {
				projectId: projectFilter || undefined,
				kind: kindFilter || undefined,
				sort,
			});
		} catch (error) {
			loadError = error instanceof Error ? error.message : t("storage.loadFailed", "โหลดคลังรูปไม่สำเร็จ");
			data = null;
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await authStore.init();
		await workspacesStore.load();
		ready = true;
		await refresh();
	});

	// Re-fetch whenever the workspace or any filter/sort changes (after mount).
	$effect(() => {
		// Touch the reactive deps so the effect re-runs on change.
		void workspaceId;
		void projectFilter;
		void kindFilter;
		void sort;
		if (ready) void refresh();
	});

	function requestDelete(asset: WorkspaceStorageAsset) {
		pendingDelete = asset;
		pendingReferencedPages = null;
	}

	function closeDialog() {
		if (deletingId) return;
		pendingDelete = null;
		pendingReferencedPages = null;
	}

	async function confirmDelete(force: boolean) {
		const asset = pendingDelete;
		if (!asset) return;
		deletingId = asset.assetId;
		try {
			const result = await api.deleteWorkspaceStorageAsset(asset.projectId, asset.imageId, { force });
			toastsStore.success({
				title: t("storage.deleted", "ลบรูปแล้ว"),
				body: t("storage.deletedBody", `คืนพื้นที่ ${formatBytes(result.freedBytes)}`, { bytes: formatBytes(result.freedBytes) }),
			});
			pendingDelete = null;
			pendingReferencedPages = null;
			await refresh();
		} catch (error) {
			// Reference-safety: the backend refuses (409) an asset still on a live page
			// unless forced — surface the warning + referencing pages so the owner can
			// confirm a forced delete.
			if (error instanceof ApiError && error.status === 409) {
				const body = error.body as { referencedByPages?: number[] } | undefined;
				pendingReferencedPages = body?.referencedByPages ?? [];
			} else {
				toastsStore.error({
					title: t("storage.deleteFailed", "ลบไม่สำเร็จ"),
					body: error instanceof Error ? error.message : t("storage.genericError", "เกิดข้อผิดพลาด"),
				});
			}
		} finally {
			deletingId = null;
		}
	}

	let totals = $derived(data?.totals ?? null);
	let projects = $derived(data?.projects ?? []);
	let assets = $derived(data?.assets ?? []);
	let scopedToProject = $derived(Boolean(projectFilter));
	let busyDeleting = $derived(Boolean(deletingId));
</script>

<svelte:head>
	<title>{t("storage.pageTitle", "คลังเก็บรูป - Comic Workspace")}</title>
</svelte:head>

<div class="ws-surface">
	<div class="ws-surface-inner">
		<a class="storage-back" href="/dashboard">{t("storage.back", "< กลับ workspace")}</a>

		<WorkspacePageHeader
			eyebrow={t("storage.eyebrow", "Storage")}
			title={t("storage.title", "คลังเก็บรูป")}
			subtitle={t("storage.subtitle", "ดูว่ารูปไหนกินพื้นที่เยอะ อยู่โปรเจคไหน แล้วลบรูปที่ไม่ใช้เพื่อคืนพื้นที่")}
		>
			{#snippet actions()}
				<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={() => refresh()} disabled={loading}>
					{loading ? t("storage.refreshing", "กำลังโหลด…") : t("storage.refresh", "รีเฟรช")}
				</button>
			{/snippet}
		</WorkspacePageHeader>

		{#if !ready}
			<p class="storage-empty">{t("storage.preparing", "กำลังเตรียมข้อมูล…")}</p>
		{:else if !workspaceId}
			<p class="storage-empty">{t("storage.noWorkspace", "ยังไม่มี workspace")}</p>
		{:else if loadError}
			<div class="storage-error" role="alert">
				<p>{loadError}</p>
				<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={() => refresh()}>{t("storage.retry", "ลองใหม่")}</button>
			</div>
		{:else}
			<!-- Summary strip: workspace totals. -->
			<section class="stat-strip ws-auto-grid" style="--ws-min: 200px" aria-label={t("storage.summaryAria", "สรุปพื้นที่จัดเก็บ")}>
				<StorageStatTile
					label={t("storage.totalSpace", "พื้นที่รวม")}
					value={formatBytes(totals?.totalBytes ?? 0)}
					sub={t("storage.totalSpaceSub", "ต้นฉบับ + ตัวอย่างย่อ")}
					tone="accent"
				/>
				<StorageStatTile label={t("storage.originals", "ต้นฉบับ")} value={formatBytes(totals?.originalBytes ?? 0)} />
				<StorageStatTile label={t("storage.imageCount", "จำนวนรูป")} value={String(totals?.assetCount ?? 0)} />
				<StorageStatTile label={t("storage.projects", "โปรเจค")} value={String(totals?.projectCount ?? 0)} />
			</section>

			<!-- Filter / sort bar. -->
			<section class="storage-filters" aria-label={t("storage.filtersAria", "ตัวกรอง")}>
				<label class="storage-field">
					<span>{t("storage.filterProject", "โปรเจค")}</span>
					<select bind:value={projectFilter}>
						<option value="">{t("storage.filterAllProjects", "ทุกโปรเจค")}</option>
						{#each projects as project (project.projectId)}
							<option value={project.projectId}>
								{project.projectName} · {formatBytes(project.originalBytes + project.derivativeBytes)}
							</option>
						{/each}
					</select>
				</label>
				<label class="storage-field">
					<span>{t("storage.filterKind", "ชนิด")}</span>
					<select bind:value={kindFilter}>
						<option value="">{t("storage.filterKindAll", "ทั้งหมด")}</option>
						<option value="uploaded">{t("storage.kindUploaded", "อัปโหลด")}</option>
						<option value="ai-generated">{t("storage.kindAiGenerated", "สร้างด้วย AI")}</option>
					</select>
				</label>
				<label class="storage-field">
					<span>{t("storage.sortBy", "เรียงตาม")}</span>
					<select bind:value={sort}>
						<option value="size">{t("storage.sortSize", "พื้นที่มากสุด")}</option>
						<option value="recent">{t("storage.sortRecent", "ล่าสุด")}</option>
						<option value="name">{t("storage.sortName", "ชื่อไฟล์")}</option>
					</select>
				</label>
				<span class="storage-count">{t("storage.assetCount", `${assets.length} รูป`, { count: assets.length })}</span>
			</section>

			<!-- Per-project totals (only in the "all projects" view, so the owner sees
			     which project eats the most space before drilling in). -->
			{#if !scopedToProject && projects.length > 0}
				<section class="project-totals ws-panel" aria-label={t("storage.perProjectAria", "พื้นที่ต่อโปรเจค")}>
					{#each projects as project (project.projectId)}
						<button
							type="button"
							class="project-total-row ws-row-hover"
							onclick={() => (projectFilter = project.projectId)}
						>
							<span class="project-total-name">{project.projectName}</span>
							<span class="project-total-meta">{t("storage.projectImages", `${project.assetCount} รูป`, { count: project.assetCount })}</span>
							<strong class="project-total-bytes">{formatBytes(project.originalBytes + project.derivativeBytes)}</strong>
						</button>
					{/each}
				</section>
			{/if}

			<!-- Asset grid. -->
			{#if assets.length === 0}
				<p class="storage-empty">
					{scopedToProject || kindFilter ? t("storage.emptyFiltered", "ไม่มีรูปตรงกับตัวกรอง") : t("storage.emptyNone", "ยังไม่มีรูปในคลัง — อัปโหลดรูปเข้าโปรเจคก่อน")}
				</p>
			{:else}
				<section class="asset-grid ws-auto-grid" style="--ws-min: 180px" aria-label={t("storage.assetListAria", "รายการรูป")}>
					{#each assets as asset (asset.assetId + asset.projectId)}
						<StorageAssetCard
							{asset}
							showProject={!scopedToProject}
							deleting={deletingId === asset.assetId}
							onDelete={requestDelete}
						/>
					{/each}
				</section>
			{/if}
		{/if}
	</div>
</div>

<!-- Delete confirmation (modal discipline: a focused confirm, not an inline prompt). -->
<Dialog
	open={Boolean(pendingDelete)}
	onClose={closeDialog}
	role="alertdialog"
	dismissible={!busyDeleting}
	busy={busyDeleting}
	eyebrow={t("storage.deleteEyebrow", "ลบรูป")}
	title={t("storage.deleteTitle", "ลบรูปนี้?")}
	size="sm"
>
	{#if pendingDelete}
		<p class="confirm-line">
			<strong>{pendingDelete.originalName}</strong>
			· {formatBytes(pendingDelete.sizeBytes + pendingDelete.derivativeBytes)}
		</p>
		<p class="confirm-line dim">{t("storage.deleteProject", `โปรเจค: ${pendingDelete.projectName}`, { project: pendingDelete.projectName })}</p>
		{#if pendingReferencedPages && pendingReferencedPages.length > 0}
			<p class="confirm-warning" role="alert">
				{t("storage.deleteReferenced", `⚠️ รูปนี้ยังถูกใช้อยู่ในหน้า ${pendingReferencedPages.join(", ")} การลบจะทำให้หน้าดังกล่าวไม่มีรูป — ยืนยันเพื่อลบทั้งที่ยังถูกใช้งาน`, { pages: pendingReferencedPages.join(", ") })}
			</p>
		{:else}
			<p class="confirm-line dim">{t("storage.deleteIrreversible", "การลบจะนำรูปออกจากที่จัดเก็บและคืนพื้นที่ทันที (ย้อนกลับไม่ได้)")}</p>
		{/if}
	{/if}
	{#snippet footer()}
		<button type="button" class="ws-dialog-btn ws-btn-ghost" onclick={closeDialog} disabled={busyDeleting}>{t("storage.cancel", "ยกเลิก")}</button>
		{#if pendingReferencedPages && pendingReferencedPages.length > 0}
			<button type="button" class="ws-dialog-btn ws-dialog-btn-danger" onclick={() => confirmDelete(true)} disabled={busyDeleting}>
				{busyDeleting ? t("storage.deleteForceBusy", "กำลังลบ…") : t("storage.deleteForce", "ลบทั้งที่ยังใช้งาน")}
			</button>
		{:else}
			<button type="button" class="ws-dialog-btn ws-dialog-btn-danger" onclick={() => confirmDelete(false)} disabled={busyDeleting}>
				{busyDeleting ? t("storage.deleteBusy", "กำลังลบ…") : t("storage.delete", "ลบ")}
			</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.storage-back {
		color: var(--color-ws-text);
		text-decoration: none;
		font-size: 13px;
		font-weight: 700;
	}
	.storage-back:hover {
		color: var(--color-ws-ink);
	}
	.stat-strip {
		gap: 12px;
	}
	.storage-filters {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 14px;
	}
	@media (max-width: 480px) {
		.storage-field {
			flex: 1 1 100%;
			min-width: 0;
		}
		.storage-field select {
			width: 100%;
			min-width: 0;
		}
	}
	.storage-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12px;
		font-weight: 700;
		color: var(--color-ws-text);
	}
	.storage-field select {
		min-height: 40px;
		min-width: 180px;
		/* never wider than the phone viewport; long project names ellipsize */
		max-width: min(100%, calc(100vw - 48px));
		text-overflow: ellipsis;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		background: var(--color-ws-surface);
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 13px;
	}
	.storage-field select:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}
	.storage-count {
		margin-left: auto;
		font-size: 13px;
		font-weight: 700;
		color: var(--color-ws-text);
	}
	.project-totals {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-ws-card);
		overflow: hidden;
	}
	.project-total-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 16px;
		border: none;
		border-bottom: 1px solid var(--ws-hair);
		background: transparent;
		color: var(--color-ws-ink);
		font-family: inherit;
		text-align: left;
		cursor: pointer;
		min-height: 44px;
	}
	.project-total-row:last-child {
		border-bottom: none;
	}
	.project-total-name {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 14px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.project-total-meta {
		flex: none;
		font-size: 12px;
		color: var(--color-ws-faint);
	}
	.project-total-bytes {
		flex: none;
		font-size: 14px;
		font-weight: 800;
		color: var(--color-ws-ink);
	}
	.asset-grid {
		gap: 14px;
	}
	.storage-empty {
		padding: 40px 0;
		text-align: center;
		color: var(--color-ws-faint);
		font-size: 14px;
	}
	.storage-error {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		padding: 20px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-rose) 70%, var(--color-ws-ink));
	}
	.confirm-line {
		margin: 0 0 6px;
		font-size: 14px;
		color: var(--color-ws-ink);
	}
	.confirm-line.dim {
		color: var(--color-ws-text);
		font-size: 13px;
	}
	.confirm-warning {
		margin: 10px 0 0;
		padding: 10px 12px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-amber) 72%, var(--color-ws-ink));
		font-size: 13px;
		line-height: 1.45;
	}
</style>
