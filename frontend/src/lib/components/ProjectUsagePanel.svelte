<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { thbToCredits, formatCreditsCompact, creditUnitLabel } from "$lib/stores/usage.svelte.ts";
	import {
		getProjectEgressUsage,
		getProjectStorageUsage,
		getProjectUsage,
		type ProjectEgressSummary,
		type StorageQuotaSummary,
		type UsageWindowSummary,
		type WorkspaceUsageSummary,
	} from "$lib/api/client.js";

	interface Props {
		projectId: string | null;
		projectOpen: boolean;
		onReviewStoredExports?: () => void;
	}

	type UsageTone = "ok" | "warning" | "danger";
	const STORAGE_QUOTA_UPDATED_EVENT = "manga:storage-quota-updated";

	interface UsageFocus {
		tone: UsageTone;
		status: string;
		title: string;
		detail: string;
	}

	let { projectId, projectOpen, onReviewStoredExports }: Props = $props();

	let loading = $state(false);
	let error = $state("");
	let loadedProjectId = $state<string | null>(null);
	let usage = $state<WorkspaceUsageSummary | null>(null);
	let storageQuota = $state<StorageQuotaSummary | null>(null);
	let egress = $state<ProjectEgressSummary | null>(null);
	let usageLoaded = $derived(loadedProjectId === projectId && Boolean(usage && storageQuota && egress));
	let usageFocus = $derived(getUsageFocus());
	let hasStoredExports = $derived((storageQuota?.exportArtifactBytes ?? 0) > 0);
	let canRefreshUsage = $derived(projectOpen && Boolean(projectId) && !loading);
	let refreshUsageReceipt = $derived(getRefreshUsageReceipt());

	onMount(() => {
		if (projectOpen && projectId) {
			void refreshUsage(projectId);
		}
		const handleStorageQuotaUpdated = (event: Event) => {
			const detail = (event as CustomEvent<{ projectId?: string; storageQuota?: StorageQuotaSummary }>).detail;
			if (!detail?.projectId || !detail.storageQuota || detail.projectId !== projectId) return;
			storageQuota = detail.storageQuota;
			loadedProjectId = detail.projectId;
		};
		window.addEventListener(STORAGE_QUOTA_UPDATED_EVENT, handleStorageQuotaUpdated);
		return () => {
			window.removeEventListener(STORAGE_QUOTA_UPDATED_EVENT, handleStorageQuotaUpdated);
		};
	});

	async function refreshUsage(targetProjectId = projectId): Promise<void> {
		if (!projectOpen || !targetProjectId || loading) return;
		loading = true;
		error = "";
		try {
			const [usageResult, storageResult, egressResult] = await Promise.all([
				getProjectUsage(targetProjectId),
				getProjectStorageUsage(targetProjectId),
				getProjectEgressUsage(targetProjectId),
			]);
			if (projectId !== targetProjectId) return;
			usage = usageResult.usage;
			storageQuota = storageResult.storageQuota;
			egress = egressResult.egress;
			loadedProjectId = targetProjectId;
		} catch (caught) {
			if (projectId === targetProjectId) {
				error = formatUsageLoadError(caught);
			}
		} finally {
			loading = false;
		}
	}

	function formatUsageLoadError(caught: unknown): string {
		const fallback = $_("projectUsage.loadFailed");
		if (caught instanceof Error) {
			const detail = caught.message.trim();
			const status = (caught as { status?: unknown }).status;
			// SENTINEL: Thai-range character class detecting an already-Thai backend error
			// message (so it passes through verbatim). This is a code-level regex, not
			// user-facing UI text — cannot be routed through $_().
			if (/[ก-๙]/.test(detail)) return detail;
			if (typeof status === "number") return `${fallback} (${status})`;
			if (/failed to fetch|network|load failed/i.test(detail)) {
				return $_("projectUsage.loadFailedRetry", { values: { fallback } });
			}
		}
		return $_("projectUsage.loadFailedRetry", { values: { fallback } });
	}

	function getRefreshUsageReceipt(): string {
		if (loading) return $_("projectUsage.loading");
		if (!projectOpen) return $_("projectUsage.openWorkBeforeLoad");
		if (!projectId) return $_("projectUsage.noProjectId");
		return $_("projectUsage.cannotLoadYet");
	}

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
		const units = ["B", "KB", "MB", "GB", "TB"];
		let value = bytes;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex += 1;
		}
		const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
		return `${value.toFixed(precision)} ${units[unitIndex]}`;
	}

	function formatPercent(percent: number | null | undefined): string {
		if (percent === null || percent === undefined || !Number.isFinite(percent)) return $_("projectUsage.unlimited");
		return `${Math.min(999, Math.max(0, percent)).toFixed(percent >= 10 ? 0 : 1)}%`;
	}

	function formatWindowLabel(window: UsageWindowSummary | null, field: "ai" | "upload" | "export"): string {
		if (!window) return $_("projectUsage.numbersNotLoaded");
		if (field === "ai") {
			// User-facing AI usage is CREDITS, not baht (THB→credit is display-only).
			// Lead with what's LEFT (issue #3); `null`/no-cap remaining ⇒ unlimited.
			const hasCap = window.limits.aiCreditThb > 0 && window.remaining.aiCreditThb !== null;
			if (!hasCap) return $_("projectUsage.unlimited");
			const remaining = formatCreditsCompact(thbToCredits(window.remaining.aiCreditThb));
			const limit = formatCreditsCompact(thbToCredits(window.limits.aiCreditThb));
			return `${$_("projectUsage.remainingPrefix")} ${remaining} / ${limit} ${creditUnitLabel()}`;
		}
		const used = field === "upload" ? window.uploadBytes : window.exportBytes;
		const limit = field === "upload" ? window.limits.uploadBytes : window.limits.exportBytes;
		return `${formatBytes(used)} / ${limit > 0 ? formatBytes(limit) : $_("projectUsage.unlimited")}`;
	}

	function storageTone(summary: StorageQuotaSummary | null): UsageTone {
		const percent = summary?.percentUsed ?? 0;
		if (percent >= 95) return "danger";
		if (percent >= 80) return "warning";
		return "ok";
	}

	function egressTone(summary: ProjectEgressSummary | null): UsageTone {
		if (!summary?.limitBytes) return "ok";
		const usedPercent = summary.totalBytes / summary.limitBytes * 100;
		if (usedPercent >= 95) return "danger";
		if (usedPercent >= 80) return "warning";
		return "ok";
	}

	function windowTone(window: UsageWindowSummary | null): UsageTone {
		const percents = [
			window?.percentUsed.aiCredit,
			window?.percentUsed.uploadBytes,
			window?.percentUsed.exportBytes,
		].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		const maxPercent = Math.max(0, ...percents);
		if (maxPercent >= 95) return "danger";
		if (maxPercent >= 80) return "warning";
		return "ok";
	}

	function getTopEgressPurpose(summary: ProjectEgressSummary | null): string {
		const topPurpose = summary?.byPurpose.slice().sort((a, b) => b.bytes - a.bytes)[0];
		if (!topPurpose) return $_("projectUsage.noImageReads");
		const purposeLabels: Record<string, string> = {
			thumbnail: $_("projectUsage.purposeThumbnail"),
			original: $_("projectUsage.purposeOriginal"),
			editor_preview: $_("projectUsage.purposeEditorPreview"),
			export: "Export",
			ai_output: $_("projectUsage.purposeAiOutput"),
		};
		return `${purposeLabels[topPurpose.purpose] ?? topPurpose.purpose}: ${formatBytes(topPurpose.bytes)} / ${$_("projectUsage.timesCount", { values: { n: topPurpose.requests } })}`;
	}

	function formatEnforcement(enforced: boolean | undefined): string {
		return enforced ? $_("projectUsage.enforced") : $_("projectUsage.viewStatus");
	}

	function getUsageFocus(): UsageFocus {
		if (!projectOpen) {
			return {
				tone: "ok",
				status: $_("projectUsage.focusNotOpenStatus"),
				title: $_("projectUsage.focusNotOpenTitle"),
				detail: $_("projectUsage.focusNotOpenDetail"),
			};
		}
		if (error) {
			return {
				tone: "danger",
				status: $_("projectUsage.focusErrorStatus"),
				title: $_("projectUsage.focusErrorTitle"),
				detail: error,
			};
		}
		if (!usageLoaded) {
			return {
				tone: "ok",
				status: loading ? $_("projectUsage.loading") : $_("projectUsage.notLoadedYet"),
				title: $_("projectUsage.focusReadingTitle"),
				detail: $_("projectUsage.focusReadingDetail"),
			};
		}
		if (storageTone(storageQuota) !== "ok") {
			return {
				tone: storageTone(storageQuota),
				status: formatEnforcement(storageQuota?.enforced),
				title: storageTone(storageQuota) === "danger" ? $_("projectUsage.focusStorageNearFull") : $_("projectUsage.focusStorageTight"),
				detail: $_("projectUsage.focusStorageDetail", {
					values: {
						percent: formatPercent(storageQuota?.percentUsed),
						files: storageQuota?.assetCount ?? 0,
						zips: storageQuota?.exportArtifactCount ?? 0,
					},
				}),
			};
		}
		if (egressTone(egress) !== "ok") {
			return {
				tone: egressTone(egress),
				status: formatEnforcement(egress?.enforced),
				title: egressTone(egress) === "danger" ? $_("projectUsage.focusEgressNearLimit") : $_("projectUsage.focusEgressRising"),
				detail: $_("projectUsage.focusEgressDetail", { values: { top: getTopEgressPurpose(egress) } }),
			};
		}
		if (windowTone(usage?.monthly ?? null) !== "ok") {
			return {
				tone: windowTone(usage?.monthly ?? null),
				status: formatEnforcement(usage?.enforced),
				title: $_("projectUsage.focusMonthlyHighTitle"),
				detail: $_("projectUsage.focusMonthlyHighDetail", {
					values: {
						ai: formatWindowLabel(usage?.monthly ?? null, "ai"),
						upload: formatWindowLabel(usage?.monthly ?? null, "upload"),
					},
				}),
			};
		}
		return {
			tone: "ok",
			status: formatEnforcement(usage?.enforced),
			title: $_("projectUsage.focusNormalTitle"),
			detail: $_("projectUsage.focusNormalDetail"),
		};
	}
</script>

<div class="usage-panel">
	<div class="usage-toolbar">
		<div>
			<strong>{$_("projectUsage.workspaceUsage")}</strong>
			<small>{loadedProjectId === projectId ? $_("projectUsage.latestNumbers") : $_("projectUsage.notLoadedYet")}</small>
		</div>
		{#if canRefreshUsage}
			<button
				type="button"
				class="usage-refresh-btn"
				onclick={() => refreshUsage(projectId)}
			>
				{$_("projectUsage.reload")}
			</button>
		{:else}
			<span class="usage-refresh-receipt">{refreshUsageReceipt}</span>
		{/if}
	</div>

	{#if !projectOpen}
		<div class="empty-state">{$_("projectUsage.openWorkToCheck")}</div>
	{:else if error}
		<div class="usage-error">{error}</div>
	{:else}
		<section class={`usage-focus-card ${usageFocus.tone}`} aria-label={$_("projectUsage.focusRegionLabel")}>
			<div class="usage-focus-copy">
				<span>{usageFocus.status}</span>
				<strong>{usageFocus.title}</strong>
				<small>{usageFocus.detail}</small>
			</div>
			<div class="usage-focus-stats" aria-label={$_("projectUsage.focusStatsLabel")}>
				<div>
					<span>{$_("projectUsage.plan")}</span>
					<strong>{usage?.planId ?? "..."}</strong>
				</div>
				<div>
					<span>{$_("projectUsage.events")}</span>
					<strong>{usage?.eventCountCapped
						? $_("projectUsage.eventCountCapped", { values: { n: usage.eventCount } })
						: (usage?.eventCount ?? 0)}</strong>
				</div>
			</div>
		</section>
		<div class="usage-metrics" aria-label={$_("projectUsage.metricsLabel")}>
			<div class={`usage-metric ${storageTone(storageQuota)}`}>
				<span>{$_("projectUsage.storage")}</span>
				<!-- Lead with space LEFT (issue #3). -->
				<strong>{storageQuota ? `${$_("projectUsage.remainingPrefix")} ${formatBytes(storageQuota.remainingBytes)} / ${formatBytes(storageQuota.limitBytes)}` : $_("projectUsage.loadingDots")}</strong>
				<small>
					{storageQuota
						? $_("projectUsage.storageDetail", {
							values: {
								percent: formatPercent(storageQuota.percentUsed),
								original: formatBytes(storageQuota.originalBytes),
								derivative: formatBytes(storageQuota.derivativeBytes),
								export: formatBytes(storageQuota.exportArtifactBytes),
							},
						})
						: $_("projectUsage.storageDetailEmpty")}
				</small>
				{#if hasStoredExports}
					<div class="usage-storage-action">
						<small>{$_("projectUsage.storedZipHint", { values: { n: storageQuota?.exportArtifactCount ?? 0 } })}</small>
						{#if onReviewStoredExports}
							<button type="button" class="usage-cleanup-btn" onclick={onReviewStoredExports}>
								{$_("projectUsage.viewStoredZip")}
							</button>
						{/if}
					</div>
				{/if}
			</div>
			<div class="usage-metric">
				<span>{$_("projectUsage.thisMonth")}</span>
				<strong>{formatWindowLabel(usage?.monthly ?? null, "ai")}</strong>
				<small>
					{$_("projectUsage.monthlyDetail", {
						values: {
							upload: formatWindowLabel(usage?.monthly ?? null, "upload"),
							export: formatWindowLabel(usage?.monthly ?? null, "export"),
						},
					})}
				</small>
			</div>
			<div class={`usage-metric ${egressTone(egress)}`}>
				<span>{$_("projectUsage.imageReads")}</span>
				<strong>{egress ? `${formatBytes(egress.totalBytes)} / ${egress.limitBytes > 0 ? formatBytes(egress.limitBytes) : $_("projectUsage.unlimited")}` : $_("projectUsage.loadingDots")}</strong>
				<small>
					{egress
						? `${$_("projectUsage.timesCount", { values: { n: egress.totalRequests } })} / ${egress.enforced ? $_("projectUsage.enforced") : $_("projectUsage.viewStatus")} / ${getTopEgressPurpose(egress)}`
						: $_("projectUsage.egressDetailEmpty")}
				</small>
			</div>
		</div>
	{/if}
</div>

<style>
	.usage-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.usage-toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 64px;
		gap: 8px;
		align-items: center;
	}

	.usage-toolbar > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.usage-toolbar strong {
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
	}

	.usage-toolbar small,
	.usage-metric small,
	.empty-state {
		color: var(--editor-text-dim);
		font-size: 10px;
	}

	.usage-refresh-btn {
		min-height: 40px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 750;
		cursor: pointer;
	}

	.usage-refresh-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 48%, transparent);
		color: var(--editor-text);
	}

	.usage-refresh-receipt {
		display: grid;
		min-height: 40px;
		align-items: center;
		justify-items: center;
		padding: 0 8px;
		border: 1px dashed var(--editor-border);
		border-radius: 4px;
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 750;
		text-align: center;
	}

	.usage-metrics {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.usage-focus-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green, #34D399) 24%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 8%, transparent);
	}

	.usage-focus-card.warning {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, transparent);
	}

	.usage-focus-card.danger {
		border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 10%, transparent);
	}

	.usage-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.usage-focus-copy span,
	.usage-focus-stats span {
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 900;
	}

	.usage-focus-copy strong {
		color: var(--editor-text);
		font-size: 13px;
		font-weight: 850;
	}

	.usage-focus-copy small {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 720;
		line-height: 1.35;
	}

	.usage-focus-stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(48px, auto));
		gap: 5px;
	}

	.usage-focus-stats div {
		min-width: 48px;
		padding: 5px 6px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.045);
		text-align: center;
	}

	.usage-focus-stats strong {
		display: block;
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 850;
	}

	.usage-metric {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		border-left: 3px solid color-mix(in srgb, var(--color-ws-green, #34D399) 52%, transparent);
		background: rgba(255, 255, 255, 0.025);
	}

	.usage-metric.warning {
		border-left-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 68%, transparent);
	}

	.usage-metric.danger {
		border-left-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 75%, transparent);
	}

	.usage-metric span {
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 850;
	}

	.usage-metric strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-metric strong {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 800;
	}

	.usage-metric small {
		line-height: 1.35;
	}

	.usage-storage-action {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
		margin-top: 4px;
	}

	.usage-cleanup-btn {
		min-height: 40px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 38%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		color: var(--editor-text);
		font-size: 10px;
		font-weight: 800;
		cursor: pointer;
	}

	.usage-cleanup-btn:hover {
		border-color: rgba(196, 181, 253, 0.62);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
	}

	.usage-error {
		padding: 6px;
		border-left: 3px solid color-mix(in srgb, var(--color-ws-rose, #FB7185) 75%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 8%, transparent);
		color: var(--color-ws-rose, #FB7185);
		font-size: 10px;
		font-weight: 700;
	}

	@media (min-width: 901px) and (max-width: 1040px) {
		.usage-storage-action {
			grid-template-columns: 1fr;
		}

	}
</style>
