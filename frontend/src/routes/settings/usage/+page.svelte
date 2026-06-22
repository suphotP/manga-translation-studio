<!-- /(workspace)/settings/usage — Wave 2 W2.2.
     Reads the workspace usage dashboard from /api/usage/workspace/:id/dashboard
     and exposes storage / AI credit / per-member usage with a simple SVG trend
     chart. Polls every 60 seconds while mounted. -->
<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { billingStore } from "$lib/stores/billing.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import {
		usageStore,
		formatBytes,
		thbToCredits,
		formatCreditsCompact,
		USAGE_THRESHOLDS,
	} from "$lib/stores/usage.svelte.ts";
	import ProgressBar from "$lib/components/ui/ProgressBar.svelte";
	import PlanBadge from "$lib/components/ui/PlanBadge.svelte";
	import CreditAmount from "$lib/components/ui/CreditAmount.svelte";

	// Localise via svelte-i18n with an explicit English fallback ($_ returns the
	// key itself on a miss / before init, so guard against that). Mirrors the
	// settings/privacy page's helper.
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let wsId = $derived(billingStore.currentWorkspaceId);
	let stopPolling: (() => void) | null = null;
	let authReady = $state(false);

	onMount(async () => {
		// Restore the saved session before any protected usage/billing load runs;
		// on a hard reload nothing else mounts AuthAccountMenu to do it. Idempotent.
		await authStore.init();
		authReady = true;
		void billingStore.loadCatalog();
		void billingStore.loadSubscription();
		// Load the workspace member list so the per-member usage rows can resolve
		// userIds to display names instead of showing raw UUIDs. Admin-gated; a
		// non-admin viewer's expected 403 is swallowed (silent) and the rows fall
		// back to email / a short id.
		if (wsId) void workspacesStore.listMembers(wsId, { silent: true }).catch(() => undefined);
		if (wsId) stopPolling = usageStore.startPolling(wsId);
	});

	$effect(() => {
		if (!authReady) return;
		if (stopPolling) stopPolling();
		stopPolling = wsId ? usageStore.startPolling(wsId) : null;
	});

	onDestroy(() => {
		stopPolling?.();
	});

	let storage = $derived(usageStore.storage);
	let ai = $derived(usageStore.ai);
	let dailyAi = $derived(usageStore.dailyAi);
	let members = $derived(usageStore.members);
	let storageTone = $derived<"green" | "amber" | "rose">(
		usageStore.storageBand === "frozen"
			? "rose"
			: usageStore.storageBand === "warning"
				? "amber"
				: "green",
	);
	let aiTone = $derived<"cyan" | "amber" | "rose">(
		usageStore.isAiAtLimit ? "rose" : usageStore.isAiNearLimit ? "amber" : "cyan",
	);

	// AI usage/limits are user-facing CREDITS, not baht. The backend windows are
	// THB-denominated, so convert with the canonical plan rate (display-only) —
	// matches the dashboard hero + top-bar credit meter. ฿ is reserved for genuine
	// real-money/billing surfaces; this page has none.
	let aiCommittedCredits = $derived(thbToCredits(ai?.aiCommittedThb));
	let aiReservedCredits = $derived(thbToCredits(ai?.aiActiveReservedThb));
	let aiRemainingCredits = $derived(thbToCredits(ai?.remaining.aiCreditThb));
	let aiLimitThb = $derived(ai?.limits.aiCreditThb ?? 0);
	let aiLimitCredits = $derived(thbToCredits(aiLimitThb));
	let dailyAiCommittedCredits = $derived(thbToCredits(dailyAi?.aiCommittedThb));

	// Remaining-countdown display (issue #3): the meters lead with what's LEFT and
	// the bars DEPLETE. `null` remaining ⇒ unlimited (no cap configured). Gate on a
	// live dashboard so the AI hero doesn't flash "ไม่จำกัด" before usage loads
	// (pre-load aiLimitThb is 0, which would otherwise read as uncapped).
	let hasLiveAi = $derived(Boolean(usageStore.dashboard));
	let aiUnlimited = $derived(hasLiveAi && (usageStore.aiRemainingThb === null || aiLimitThb <= 0));
	let aiRemainingPct = $derived(Math.max(0, 100 - usageStore.aiPct));
	let storageRemainingPct = $derived(Math.max(0, 100 - usageStore.storagePct));

	function memberLabel(role: string): string {
		const map: Record<string, string> = {
			owner: t("usage.roleOwner", "Owner"),
			admin: t("usage.roleAdmin", "Admin"),
			editor: t("usage.roleEditor", "Editor"),
			viewer: t("usage.roleViewer", "Viewer"),
		};
		return map[role] ?? role;
	}

	// Resolve a member's userId to a human label. The /members API only exposes
	// the signed-in user's own name/email (profile fields aren't returned for
	// other members yet), so we use authStore for self and fall back to a short
	// id slice for everyone else — never the full raw UUID. Mirrors the resolver
	// used in WorkspaceMembersPanel.
	function memberName(userId: string): string {
		if (userId === authStore.user?.id) {
			return authStore.user?.name || authStore.user?.email || shortId(userId);
		}
		return shortId(userId);
	}

	function shortId(userId: string): string {
		if (!userId) return "—";
		return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
	}
</script>

<svelte:head>
	<title>Usage · Workspace Settings</title>
</svelte:head>

<div class="usage-page">
	<header class="usage-head">
		<p class="eyebrow">{t("usage.eyebrow", "Workspace · Usage")}</p>
		<h1>{t("usage.title", "Usage this month")}</h1>
		<p>
			{t("usage.introBefore", "Storage, AI credits, traffic and per-member usage —")}
			{t("usage.introAfter", "data refreshes automatically every")}
			{USAGE_THRESHOLDS.refreshIntervalMs / 1000}
			{t("usage.introSecondsUnit", "seconds")}
		</p>
	</header>

	{#if !wsId}
		<div class="usage-warning">
			{t("usage.noWorkspace", "No workspace selected — open the dashboard to pick a workspace first.")}
		</div>
	{:else}
		{#if usageStore.error}
			<div class="usage-error" role="alert">{usageStore.error}</div>
		{/if}

		{#if usageStore.isStorageFrozen}
			<div class="usage-banner banner-frozen">
				{t("usage.storageFrozen", "Storage is full and locked — delete unneeded files or buy an extra storage pack.")}
			</div>
		{:else if usageStore.storageBand === "warning"}
			<div class="usage-banner banner-warn">
				{t("usage.storageWarnBefore", "Storage quota is almost full (")}{usageStore.storagePct.toFixed(1)}%{t(
					"usage.storageWarnAfter",
					") — add a storage pack before it reaches 95%.",
				)}
			</div>
		{/if}

		{#if usageStore.isAiAtLimit}
			<div class="usage-banner banner-frozen">
				{t("usage.aiFrozen", "AI credits are used up this month — new AI jobs will queue until you top up.")}
			</div>
		{:else if usageStore.isAiNearLimit}
			<div class="usage-banner banner-warn">
				{t("usage.aiWarnBefore", "AI credits are almost gone (")}{usageStore.aiPct.toFixed(1)}%{t(
					"usage.aiWarnAfter",
					") — buy a credit pack on the Billing page.",
				)}
			</div>
		{/if}

		<section class="hero-card ws-panel">
			<div class="hero-card-head">
				<!-- Badge + name resolve from the SAME plan that drives the AI-credit
				     allowance in the hero bars below (usageStore.resolvedPlan*), so the
				     badge can never say "Free" while the cap shows Studio's 700. Falls
				     back to the billing assignment until usage loads. -->
				<PlanBadge plan={usageStore.resolvedPlanKey ?? billingStore.publicPlanKey ?? "free"} size="md" />
				<div>
					<h2>{usageStore.resolvedPlanName ?? billingStore.currentPlan?.name ?? "Free"}</h2>
					<p>{usageStore.plan?.name ?? t("usage.noPlanData", "No plan data yet")}</p>
				</div>
			</div>
			<div class="hero-bars">
				<div class="hero-bar">
					<header>
						<span>{t("usage.storageLabel", "Storage")}</span>
						<!-- Lead with what's LEFT (issue #3): the headline counts DOWN. -->
						<strong>
							{t("usage.remainingPrefix", "เหลือ")} {formatBytes(storage?.remainingBytes)}
							<span class="of-limit">/ {formatBytes(storage?.limitBytes)}</span>
						</strong>
					</header>
					<ProgressBar
						value={storageRemainingPct}
						tone={storageTone}
						ariaLabel={t("usage.storageLabel", "Storage")}
					/>
					<small class="meta">
						{t("usage.usedPrefix", "ใช้ไป")} {formatBytes(storage?.usedBytes)} ·
						{t("usage.storageProjected", "projected")} {formatBytes(storage?.projectedBytes)}
					</small>
				</div>

				<div class="hero-bar">
					<header>
						<span>{t("usage.aiCreditsMonth", "AI credits (month)")}</span>
						<strong class="credit-pair">
							{#if aiUnlimited}
								<span>{t("usage.unlimited", "ไม่จำกัด")}</span>
							{:else}
								<span class="remaining-word">{t("usage.remainingPrefix", "เหลือ")}</span>
								<CreditAmount credits={aiRemainingCredits} size="md" tone="ink" />
								<span class="credit-sep">/ {aiLimitThb > 0 ? formatCreditsCompact(aiLimitCredits) : "—"} credits</span>
							{/if}
						</strong>
					</header>
					<ProgressBar
						value={aiUnlimited ? 100 : aiRemainingPct}
						tone={aiTone}
						ariaLabel={t("usage.aiCreditsMonth", "AI credits (month)")}
					/>
					<small class="meta credit-meta">
						{t("usage.usedPrefix", "ใช้ไป")} <CreditAmount credits={aiCommittedCredits} size="xs" tone="faint" showLabel /> ·
						{t("usage.aiReserved", "reserved")} <CreditAmount credits={aiReservedCredits} size="xs" tone="faint" showLabel />
					</small>
				</div>
			</div>
		</section>

		<section class="trend-card ws-panel" aria-label={t("usage.trendAria", "AI usage summary")}>
			<header>
				<h3>{t("usage.trendTitle", "AI credit usage")}</h3>
				<small>{t("usage.trendPeriodBefore", "Billing period")} {ai?.periodKey ?? "—"}</small>
			</header>
			<div class="trend-aggregate">
				<div class="agg-cell ws-panel-quiet">
					<span>{t("usage.trendToday", "Today")}</span>
					<strong><CreditAmount credits={dailyAiCommittedCredits} size="md" tone="ink" showLabel /></strong>
				</div>
				<div class="agg-cell ws-panel-quiet">
					<span>{t("usage.trendThisMonth", "This month")}</span>
					<strong><CreditAmount credits={aiCommittedCredits} size="md" tone="ink" showLabel /></strong>
				</div>
				<div class="agg-cell ws-panel-quiet">
					<span>{t("usage.trendReserved", "Reserved")}</span>
					<strong><CreditAmount credits={aiReservedCredits} size="md" tone="ink" showLabel /></strong>
				</div>
				<div class="agg-cell ws-panel-quiet">
					<span>{t("usage.trendRemaining", "Remaining in period")}</span>
					<strong><CreditAmount credits={aiRemainingCredits} size="md" tone="ink" showLabel /></strong>
				</div>
			</div>
			<p class="trend-note">
				{t(
					"usage.trendNote",
					"A historical daily-usage chart appears once the backend has collected enough daily data — for now this shows only today's and the current period's real totals.",
				)}
			</p>
		</section>

		<section class="members-card ws-panel" aria-label={t("usage.membersAria", "Usage by member")}>
			<header>
				<h3>{t("usage.membersTitle", "Members (Top 10)")}</h3>
				<small>
					{t(
						"usage.membersSubtitle",
						'Per-member usage isn\'t linked in the ledger yet — totals appear in the "Whole workspace" row.',
					)}
				</small>
			</header>
			<!-- The 5-column table can be wider than a phone viewport; an overflow-x
			     wrapper keeps the table scrollable on its own without forcing the
			     whole page into horizontal scroll at 390px. -->
			<div class="members-table-scroll">
				<table>
					<thead>
						<tr>
							<th>{t("usage.colMember", "Member")}</th>
							<th>{t("usage.colRole", "Role")}</th>
							<th>{t("usage.colAi", "AI")}</th>
							<th>{t("usage.colUpload", "Upload")}</th>
							<th>{t("usage.colExport", "Export")}</th>
						</tr>
					</thead>
					<tbody>
						<tr class="row-workspace">
							<td>{t("usage.rowWorkspace", "Whole workspace")}</td>
							<td>—</td>
							<td><CreditAmount credits={thbToCredits(usageStore.dashboard?.members.unattributed.aiCommittedThb)} size="sm" tone="cyan" showLabel /></td>
							<td>{formatBytes(usageStore.dashboard?.members.unattributed.uploadBytes)}</td>
							<td>{formatBytes(usageStore.dashboard?.members.unattributed.exportBytes)}</td>
						</tr>
						{#each members as member (member.userId)}
							<tr>
								<td>{memberName(member.userId)}</td>
								<td>{memberLabel(member.role)}</td>
								<td><CreditAmount credits={thbToCredits(member.aiCommittedThb)} size="sm" tone="ink" showLabel /></td>
								<td>{formatBytes(member.uploadBytes)}</td>
								<td>{formatBytes(member.exportBytes)}</td>
							</tr>
						{/each}
						{#if members.length === 0}
							<tr>
								<td colspan="5" class="muted">{t("usage.membersEmpty", "No usage in this period yet")}</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>

<style>
	.usage-page {
		max-width: 1080px;
		margin: 0 auto;
		padding: 48px clamp(16px, 4vw, 56px) 96px;
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		display: grid;
		/* Explicit minmax(0, 1fr) column: an implicit `auto` track sizes to the
		   widest child's MAX-content (e.g. the nested auto-fit hero-bars want
		   multiple 260px columns), which inflated the whole page past a 390px
		   phone viewport. Pinning to minmax(0, 1fr) keeps it within the box. */
		grid-template-columns: minmax(0, 1fr);
		width: 100%;
		box-sizing: border-box;
		gap: 24px;
	}
	.usage-head h1 {
		margin: 0 0 6px;
		font-size: 30px;
		font-weight: 800;
	}
	.usage-head p {
		color: var(--color-ws-text);
		font-size: 13.5px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-ws-violet);
		font-size: 11px;
		margin: 0 0 6px;
	}
	.usage-warning {
		padding: 14px 16px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-amber) 72%, var(--color-ws-ink));
		font-size: 13px;
	}
	.usage-error {
		padding: 12px 16px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
		font-size: 13px;
	}
	.usage-banner {
		padding: 12px 16px;
		border-radius: var(--radius-ws-card);
		font-size: 13px;
		font-weight: 700;
	}
	.banner-warn {
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		color: color-mix(in srgb, var(--color-ws-amber) 72%, var(--color-ws-ink));
	}
	.banner-frozen {
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 48%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
	}
	.hero-card {
		border-radius: var(--radius-ws-card);
		padding: 26px;
		display: grid;
		gap: 24px;
	}
	.hero-card-head {
		display: flex;
		gap: 14px;
		align-items: center;
	}
	.hero-card-head h2 {
		margin: 0;
		font-size: 22px;
		font-weight: 800;
	}
	.hero-card-head p {
		color: var(--color-ws-text);
		font-size: 12.5px;
	}
	.hero-bars {
		display: grid;
		gap: 18px;
		/* min(260px, 100%) so a single bar can shrink below 260px on a phone
		   instead of forcing the card (and page) wider than the viewport. */
		grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
	}
	.hero-bar header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 13px;
		margin-bottom: 8px;
	}
	.hero-bar header span {
		color: var(--color-ws-text);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: 11px;
	}
	.hero-bar header strong {
		font-size: 13px;
	}
	.credit-pair {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
	}
	.credit-sep {
		color: var(--color-ws-faint);
		font-weight: 500;
	}
	.meta {
		display: block;
		margin-top: 6px;
		color: var(--color-ws-faint);
		font-size: 11.5px;
	}
	.credit-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.trend-card {
		border-radius: var(--radius-ws-card);
		padding: 22px;
	}
	.trend-card header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 8px;
	}
	.trend-card h3 {
		margin: 0;
		font-size: 15px;
	}
	.trend-card small {
		color: var(--color-ws-faint);
		font-size: 11px;
	}
	.trend-aggregate {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr));
		gap: 12px;
		margin-top: 4px;
	}
	.agg-cell {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		border-radius: var(--radius-ws-card);
	}
	.agg-cell span {
		color: var(--color-ws-text);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 10.5px;
	}
	.agg-cell strong {
		font-size: 18px;
		font-weight: 800;
	}
	.trend-note {
		margin: 14px 0 0;
		color: var(--color-ws-faint);
		font-size: 11.5px;
	}
	.members-card {
		border-radius: var(--radius-ws-card);
		padding: 22px;
	}
	.members-card header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 12px;
	}
	.members-card h3 {
		margin: 0;
		font-size: 15px;
	}
	.members-card small {
		color: var(--color-ws-faint);
		font-size: 11px;
	}
	/* Let the wide 5-column table scroll within its own box on narrow phones
	   (≈390px) instead of pushing the page into horizontal scroll. */
	.members-table-scroll {
		min-width: 0;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	thead th {
		text-align: left;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 10.5px;
		color: var(--color-ws-text);
		border-bottom: 1px solid var(--ws-hair);
		padding: 8px 10px;
	}
	tbody td {
		padding: 10px;
		font-size: 13px;
		border-bottom: 1px solid var(--ws-hair);
	}
	.row-workspace td {
		color: var(--color-ws-violet);
		font-weight: 600;
	}
	.muted {
		color: var(--color-ws-faint);
		text-align: center;
		padding: 20px 0;
	}
</style>
