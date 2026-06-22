<!--
	Notifications full-page browser — Wave 2 W2.5.

	Standalone surface for "show me everything". Reuses the same
	notifications store as the topbar bell + NotificationPanel so the unread
	count and items stay in sync.

	The page lives outside the (workspace) group so it does NOT mount the
	editor shell — this is a focused inbox, not the workspace dashboard.
-->
<script lang="ts">
	import { goto } from "$app/navigation";
	import { onMount, onDestroy } from "svelte";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { notificationsStore } from "$lib/stores/notifications.svelte.ts";
	import { iconForType, iconSvgForType } from "$lib/components/notification-icons.ts";
	import { localizedNotificationTitle, localizedNotificationBody } from "$lib/components/notification-localize.ts";
	import type { NotificationCategory, NotificationPayload } from "$lib/api/client.ts";

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	type TabFilter = "all" | "unread" | "tasks" | "support" | "billing" | "system";

	let activeTab = $state<TabFilter>("all");
	let scrollContainer = $state<HTMLElement | null>(null);
	let authReady = $state(false);

	// Category tabs narrow client-side (no server param), so a tab can have zero
	// matches in the cached pages while more remain on the server. The effect
	// below auto-pages to find matches, but bounded: without a cap a category the
	// user has none of would page the whole history one request at a time (an
	// unbounded serial waterfall → rate-limit risk). Scan at most a few pages per
	// tab selection, then stop and surface a manual "load more" affordance.
	const AUTO_SCAN_MAX_PAGES = 3;
	let autoScanned = $state(0);

	// This page can be opened directly or refreshed without the workspace shell
	// mounting, so the auth session may still be in its default anonymous state.
	// Restore the persisted session first, then load the feed once it resolves.
	onMount(() => {
		void authStore.init().finally(() => {
			authReady = true;
			if (authStore.isAuthenticated) {
				void notificationsStore.load();
			}
		});
	});

	onDestroy(() => {
		// We do NOT stop polling here — the workspace shell owns that lifecycle
		// and the user may navigate back to a workspace surface that still
		// depends on the badge count.
		//
		// We DO reset the shared store filter back to "all": this page may have
		// left it on "unread", and the workspace NotificationPanel opens on its
		// All tab. Without this reset, the panel's first load() would still send
		// unread_only=true and hide read notifications until the user re-toggled.
		if (notificationsStore.filter !== "all") {
			notificationsStore.filter = "all";
		}
	});

	function selectTab(tab: TabFilter): void {
		activeTab = tab;
		// Reset the auto-scan budget so a fresh tab gets its own bounded scan.
		autoScanned = 0;
		// The Unread tab is server-backed so it can page past the cached first
		// page; the other tabs list everything (category narrowing stays
		// client-side, but we keep loading while hasMore — see effect below).
		void notificationsStore.setFilter(tab === "unread" ? "unread" : "all");
	}

	let filteredItems = $derived(filterItems(notificationsStore.items, activeTab));
	let grouped = $derived(groupByRelativeDate(filteredItems));
	let unreadByCategory = $derived(notificationsStore.unreadByCategory);
	let totalShown = $derived(filteredItems.length);

	// Category unread tallies come from the CACHED pages only (no server-side
	// category filter yet), so they can understate the real total while more
	// pages remain. Render with a trailing "+" in that case so the badge reads as
	// "at least N". The Unread tab uses the server-authoritative total, so it is
	// exact and never gets a "+". The All tab likewise shows loaded count +.
	function partialBadge(count: number): string {
		if (count <= 0) return "";
		return notificationsStore.hasMore ? `${count}+` : `${count}`;
	}

	// The header summary's "total" is the count of LOADED rows; more may remain on
	// the server until everything is paged in. Show "N+" while hasMore so it never
	// claims a final total it cannot know without fetching every page.
	let loadedTotalLabel = $derived(
		notificationsStore.hasMore ? `${notificationsStore.items.length}+` : `${notificationsStore.items.length}`,
	);

	// A tab may have zero matches in the cached pages while more remain on the
	// server — the client-side category tabs, and the Unread tab once cached
	// unread rows are individually marked read. Keep paging instead of falsely
	// declaring the tab empty (which also hides the load-more controls) — but
	// only up to AUTO_SCAN_MAX_PAGES so an empty category never waterfalls the
	// whole history one serial request at a time.
	$effect(() => {
		if (!authReady || !authStore.isAuthenticated) return;
		if (activeTab === "all") return;
		if (filteredItems.length > 0) return;
		if (autoScanned >= AUTO_SCAN_MAX_PAGES) return;
		if (notificationsStore.hasMore && !notificationsStore.loadingMore && !notificationsStore.loading) {
			autoScanned += 1;
			void notificationsStore.loadMore();
		}
	});

	function filterItems(items: NotificationPayload[], tab: TabFilter): NotificationPayload[] {
		if (tab === "all") return items;
		if (tab === "unread") return items.filter((entry) => !entry.readAt);
		return items.filter((entry) => entry.category === tab);
	}

	interface GroupedSection {
		key: "today" | "yesterday" | "lastWeek" | "earlier";
		label: string;
		items: NotificationPayload[];
	}

	function groupByRelativeDate(items: NotificationPayload[]): GroupedSection[] {
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
		const startOfLastWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
		const buckets: Record<GroupedSection["key"], NotificationPayload[]> = {
			today: [],
			yesterday: [],
			lastWeek: [],
			earlier: [],
		};
		for (const entry of items) {
			const ts = new Date(entry.createdAt).getTime();
			if (Number.isNaN(ts)) {
				buckets.earlier.push(entry);
			} else if (ts >= startOfToday) {
				buckets.today.push(entry);
			} else if (ts >= startOfYesterday) {
				buckets.yesterday.push(entry);
			} else if (ts >= startOfLastWeek) {
				buckets.lastWeek.push(entry);
			} else {
				buckets.earlier.push(entry);
			}
		}
		return [
			{ key: "today" as const, label: t("notifications.group.today", "วันนี้"), items: buckets.today },
			{ key: "yesterday" as const, label: t("notifications.group.yesterday", "เมื่อวาน"), items: buckets.yesterday },
			{ key: "lastWeek" as const, label: t("notifications.group.lastWeek", "7 วันที่ผ่านมา"), items: buckets.lastWeek },
			{ key: "earlier" as const, label: t("notifications.group.earlier", "ก่อนหน้านี้"), items: buckets.earlier },
		].filter((section) => section.items.length > 0);
	}

	function relativeTime(createdAt: string): string {
		const ts = new Date(createdAt).getTime();
		if (Number.isNaN(ts)) return "";
		const diff = Math.max(0, Date.now() - ts);
		const minute = 60_000;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (diff < minute) return t("notifications.relative.justNow", "เมื่อสักครู่");
		if (diff < hour) return t("notifications.relative.minutes", "{count} นาทีที่แล้ว").replace("{count}", String(Math.floor(diff / minute)));
		if (diff < day) return t("notifications.relative.hours", "{count} ชั่วโมงที่แล้ว").replace("{count}", String(Math.floor(diff / hour)));
		if (diff < 7 * day) return t("notifications.relative.days", "{count} วันที่แล้ว").replace("{count}", String(Math.floor(diff / day)));
		return new Date(ts).toLocaleString();
	}

	// Rows with a destination render as real <a href> so Cmd/Ctrl/middle-click
	// "open in new tab" works. A plain click keeps SPA navigation (mark read +
	// goto); a modified click takes the native anchor behaviour (still marked read).
	function isModifiedClick(event: MouseEvent): boolean {
		return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1;
	}

	async function handleLinkClick(event: MouseEvent, entry: NotificationPayload): Promise<void> {
		if (isModifiedClick(event)) {
			void notificationsStore.markRead(entry.id).catch(() => {});
			return;
		}
		event.preventDefault();
		await notificationsStore.markRead(entry.id).catch(() => {});
		if (entry.linkUrl) {
			void goto(entry.linkUrl);
		}
	}

	// Rows WITHOUT a destination just mark themselves read (rendered as a button).
	async function handleItemClick(entry: NotificationPayload): Promise<void> {
		await notificationsStore.markRead(entry.id).catch(() => {});
	}

	async function handleMarkAll(): Promise<void> {
		await notificationsStore.markAllRead().catch(() => {});
	}

	function maybeLoadMore(): void {
		if (!authReady || !authStore.isAuthenticated) return;
		if (!notificationsStore.hasMore || notificationsStore.loadingMore) return;
		void notificationsStore.loadMore();
	}

	// Infinite scroll on the body CONTAINER. On desktop the container is the
	// scroller (max-height: 72vh; overflow-y: auto) so this fires.
	function handleScroll(event: Event): void {
		const target = event.currentTarget as HTMLElement;
		const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
		if (remaining < 160) maybeLoadMore();
	}

	// On mobile (<=720px) the container drops its max-height (overflow no longer
	// applies) so the WINDOW scrolls and the container's onscroll never fires.
	// Mirror the same near-bottom check against the document so infinite scroll
	// keeps working there. Harmless on desktop: the document doesn't scroll while
	// the inner container does, so this stays far from the bottom and no-ops.
	function handleWindowScroll(): void {
		if (typeof document === "undefined") return;
		const doc = document.documentElement;
		const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
		if (remaining < 160) maybeLoadMore();
	}

	function categoryLabel(category: NotificationCategory): string {
		switch (category) {
			case "tasks":
				return t("notifications.category.tasks", "งาน");
			case "support":
				return t("notifications.category.support", "ซัพพอร์ต");
			case "billing":
				return t("notifications.category.billing", "บิล/เครดิต");
			case "system":
				return t("notifications.category.system", "ระบบ");
			default:
				return t("notifications.category.system", "ระบบ");
		}
	}
</script>

<svelte:head>
	<title>{t("notifications.pageTitle", "การแจ้งเตือนทั้งหมด")} - Comic Workspace</title>
</svelte:head>

<!-- On mobile the inner container stops scrolling (max-height: none), so the
     window scrolls instead — listen here so infinite scroll still works. -->
<svelte:window onscroll={handleWindowScroll} />

<div class="notifications-page">
	<header class="notifications-page-header">
		<a class="back-link" href="/dashboard">&lt; {t("notifications.backHome", "กลับหน้าแรก")}</a>
		<div class="notifications-page-title">
			<p class="eyebrow">{t("notifications.eyebrow", "กล่องข้อความ")}</p>
			<h1>{t("notifications.heading", "การแจ้งเตือนทั้งหมด")}</h1>
			<p>
				{#if notificationsStore.unreadCount > 0}
					{t("notifications.summaryUnread", "{unread} รายการยังไม่ได้อ่าน · ทั้งหมด {total} รายการ")
						.replace("{unread}", String(notificationsStore.unreadCount))
						.replace("{total}", loadedTotalLabel)}
				{:else}
					{t("notifications.summaryAllRead", "ทั้งหมด {total} รายการ · อ่านครบแล้ว")
						.replace("{total}", loadedTotalLabel)}
				{/if}
			</p>
		</div>
		<button
			type="button"
			class="mark-all"
			onclick={handleMarkAll}
			disabled={notificationsStore.unreadCount === 0}
		>{t("notifications.markAll", "อ่านทั้งหมด")}</button>
	</header>

	<nav class="notifications-page-tabs" aria-label={t("notifications.filterAria", "กรองการแจ้งเตือนตามประเภท")}>
		{#each [
			{ id: "all", label: t("notifications.tab.all", "ทั้งหมด"), badge: partialBadge(notificationsStore.items.length) },
			{ id: "unread", label: t("notifications.tab.unread", "ยังไม่อ่าน"), badge: notificationsStore.unreadCount > 0 ? String(notificationsStore.unreadCount) : "" },
			{ id: "tasks", label: categoryLabel("tasks"), badge: partialBadge(unreadByCategory.tasks) },
			{ id: "support", label: categoryLabel("support"), badge: partialBadge(unreadByCategory.support) },
			{ id: "billing", label: categoryLabel("billing"), badge: partialBadge(unreadByCategory.billing) },
			{ id: "system", label: categoryLabel("system"), badge: partialBadge(unreadByCategory.system) },
		] as tab (tab.id)}
			<button
				type="button"
				class="notifications-page-tab"
				class:active={activeTab === tab.id}
				onclick={() => selectTab(tab.id as TabFilter)}
			>
				<span>{tab.label}</span>
				{#if tab.badge}
					<small>{tab.badge}</small>
				{/if}
			</button>
		{/each}
	</nav>

	<div class="notifications-page-body" bind:this={scrollContainer} onscroll={handleScroll}>
		{#if !authReady}
			<div class="state">
				<div class="spinner" aria-hidden="true"></div>
				<p>{t("notifications.preparing", "กำลังเตรียมข้อมูล...")}</p>
			</div>
		{:else if !authStore.isAuthenticated}
			<div class="state empty">
				<strong>{t("notifications.signInTitle", "เข้าสู่ระบบเพื่อดูการแจ้งเตือน")}</strong>
				<small>{t("notifications.signInBody", "การแจ้งเตือนจะถูกจัดเก็บไว้ตามบัญชีผู้ใช้")}</small>
				<a class="sign-in-cta" href="/login?redirect=/notifications">{t("notifications.signInCta", "เข้าสู่ระบบ")}</a>
			</div>
		{:else if notificationsStore.loading && notificationsStore.items.length === 0}
			<div class="state">
				<div class="spinner" aria-hidden="true"></div>
				<p>{t("notifications.loading", "กำลังโหลดการแจ้งเตือน...")}</p>
			</div>
		{:else if notificationsStore.error}
			<div class="state error">
				<strong>{t("notifications.loadError", "โหลดไม่สำเร็จ")}</strong>
				<small>{notificationsStore.error}</small>
				<button type="button" onclick={() => void notificationsStore.load()}>{t("common.retry", "ลองอีกครั้ง")}</button>
			</div>
		{:else if totalShown === 0 && (notificationsStore.loadingMore || (notificationsStore.hasMore && activeTab !== "all"))}
			<!-- No matches cached yet but more pages remain on the server. -->
			<div class="state">
				{#if notificationsStore.loadingMore}
					<div class="spinner" aria-hidden="true"></div>
					<p>{t("notifications.searching", "กำลังค้นหาการแจ้งเตือน...")}</p>
				{:else}
					<button type="button" class="load-more" onclick={() => { autoScanned = 0; void notificationsStore.loadMore(); }}>{t("notifications.loadMoreToSearch", "โหลดเพิ่มเพื่อค้นหา")}</button>
				{/if}
			</div>
		{:else if totalShown === 0}
			<div class="state empty">
				<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">
					<circle cx="48" cy="48" r="40" stroke="currentColor" stroke-opacity="0.18" stroke-width="2"/>
					<path d="M30 56h36M30 44h22M30 32h28" stroke="currentColor" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round"/>
				</svg>
				<strong>{t("notifications.empty", "ไม่มีการแจ้งเตือน")}</strong>
				<small>{activeTab === "unread" ? t("notifications.emptyUnread", "อ่านทั้งหมดแล้ว — ดีมาก") : t("notifications.emptyBox", "ยังไม่มีรายการในกล่องนี้")}</small>
			</div>
		{:else}
			{#each grouped as section (section.key)}
				<section class="notifications-section" aria-label={section.label}>
					<h3>{section.label}</h3>
					<ul>
						{#each section.items as entry (entry.id)}
							<li class="notification-row" class:unread={!entry.readAt}>
								{#if entry.linkUrl}
									<a href={entry.linkUrl} class="notification-row-link" onclick={(event) => void handleLinkClick(event, entry)}>
										<span class="row-icon" data-icon={iconForType(entry.type)} aria-hidden="true">
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">{@html iconSvgForType(entry.type)}</svg>
										</span>
										<span class="row-content">
											<span class="row-title">{localizedNotificationTitle(entry, $_)}</span>
											{#if localizedNotificationBody(entry, $_)}
												<span class="row-body">{localizedNotificationBody(entry, $_)}</span>
											{/if}
											<span class="row-meta">
												<em>{categoryLabel(entry.category)}</em>
												<time>{relativeTime(entry.createdAt)}</time>
											</span>
										</span>
										{#if !entry.readAt}
											<span class="unread-dot" aria-label={t("notifications.unreadDot", "ยังไม่ได้อ่าน")}></span>
										{/if}
									</a>
								{:else}
									<button type="button" class="notification-row-link" onclick={() => void handleItemClick(entry)}>
										<span class="row-icon" data-icon={iconForType(entry.type)} aria-hidden="true">
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">{@html iconSvgForType(entry.type)}</svg>
										</span>
										<span class="row-content">
											<span class="row-title">{localizedNotificationTitle(entry, $_)}</span>
											{#if localizedNotificationBody(entry, $_)}
												<span class="row-body">{localizedNotificationBody(entry, $_)}</span>
											{/if}
											<span class="row-meta">
												<em>{categoryLabel(entry.category)}</em>
												<time>{relativeTime(entry.createdAt)}</time>
											</span>
										</span>
										{#if !entry.readAt}
											<span class="unread-dot" aria-label={t("notifications.unreadDot", "ยังไม่ได้อ่าน")}></span>
										{/if}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
			{#if notificationsStore.loadingMore}
				<div class="load-state">
					<div class="spinner small" aria-hidden="true"></div>
					<span>{t("notifications.loadingMore", "กำลังโหลดเพิ่ม...")}</span>
				</div>
			{:else if notificationsStore.hasMore}
				<button
					type="button"
					class="load-more"
					onclick={() => void notificationsStore.loadMore()}
				>{t("notifications.loadMore", "โหลดเพิ่มเติม")}</button>
			{:else if notificationsStore.items.length > 0}
				<p class="end-of-list">{t("notifications.endOfList", "หมดรายการแล้ว")}</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.notifications-page {
		min-height: 100vh;
		background: var(--color-ws-bg, #0b0b0f);
		color: var(--color-ws-ink, #ececf2);
		padding: 32px 24px 64px;
		font-family: var(--font-ws-sans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
	}

	.notifications-page-header {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr) auto;
		gap: 24px;
		align-items: start;
		max-width: 880px;
		margin: 0 auto 24px;
	}

	.back-link {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 13px;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		min-height: 36px;
	}

	.back-link:hover {
		color: var(--color-ws-ink, #ececf2);
	}

	.notifications-page-title .eyebrow {
		margin: 0 0 6px;
		color: #c4b5fd;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.notifications-page-title h1 {
		margin: 0 0 6px;
		font-size: 26px;
		font-weight: 700;
		color: var(--color-ws-ink, #ececf2);
	}

	.notifications-page-title p {
		margin: 0;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 13px;
	}

	.mark-all {
		justify-self: end;
		padding: 8px 14px;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-ws-accent, #7c5cff);
		background: rgba(124, 92, 255, 0.12);
		border: 1px solid rgba(124, 92, 255, 0.42);
		border-radius: 8px;
		cursor: pointer;
		transition: background 0.14s ease;
	}

	.mark-all:hover:not([disabled]) {
		background: rgba(124, 92, 255, 0.2);
	}

	.mark-all[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.notifications-page-tabs {
		display: flex;
		gap: 6px;
		max-width: 880px;
		margin: 0 auto 12px;
		overflow-x: auto;
		padding-bottom: 8px;
	}

	.notifications-page-tab {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px 14px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.02);
		color: var(--color-ws-text, #9a9aa8);
		font-size: 13px;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.notifications-page-tab:hover {
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-ink, #ececf2);
	}

	.notifications-page-tab.active {
		background: rgba(124, 92, 255, 0.16);
		border-color: rgba(124, 92, 255, 0.45);
		color: var(--color-ws-ink, #ececf2);
	}

	.notifications-page-tab small {
		min-width: 20px;
		padding: 0 6px;
		border-radius: 999px;
		background: rgba(124, 92, 255, 0.35);
		color: #fff;
		font-size: 11px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.notifications-page-body {
		max-width: 880px;
		margin: 0 auto;
		border-radius: 14px;
		background: rgba(15, 15, 22, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.06);
		max-height: 72vh;
		overflow-y: auto;
	}

	.notifications-section h3 {
		margin: 0;
		padding: 16px 22px 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-ws-faint, #6b6b78);
	}

	.notifications-section ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.notification-row {
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
	}

	.notification-row-link {
		display: grid;
		grid-template-columns: 40px 1fr auto;
		gap: 14px;
		width: 100%;
		padding: 14px 22px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background 0.14s ease;
	}

	.notification-row-link:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.row-icon {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border-radius: 10px;
		background: rgba(124, 92, 255, 0.16);
		color: #c4b5fd;
	}

	.row-icon svg {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}

	.row-icon[data-icon="ai-fail"],
	.row-icon[data-icon="payment-fail"],
	.row-icon[data-icon="reject"],
	.row-icon[data-icon="quota"] {
		background: rgba(251, 113, 133, 0.16);
		color: #fda4af;
	}

	.row-icon[data-icon="approve"],
	.row-icon[data-icon="payment-ok"],
	.row-icon[data-icon="ai-success"] {
		background: rgba(74, 222, 128, 0.16);
		color: #86efac;
	}

	.row-icon[data-icon="team"],
	.row-icon[data-icon="invite"] {
		background: rgba(34, 211, 238, 0.16);
		color: #67e8f9;
	}

	.row-content {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.row-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-ws-ink, #ececf2);
	}

	.notification-row.unread .row-title {
		color: #fff;
	}

	.row-body {
		font-size: 12.5px;
		color: var(--color-ws-text, #9a9aa8);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.row-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--color-ws-faint, #6b6b78);
	}

	.row-meta em {
		font-style: normal;
		padding: 2px 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-text, #9a9aa8);
	}

	.unread-dot {
		align-self: center;
		width: 9px;
		height: 9px;
		border-radius: 999px;
		background: #7c5cff;
		box-shadow: 0 0 0 3px rgba(124, 92, 255, 0.22);
	}

	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 64px 28px;
		text-align: center;
		color: var(--color-ws-text, #9a9aa8);
	}

	.state.empty strong {
		font-size: 15px;
		color: var(--color-ws-ink, #ececf2);
	}

	.state.empty small,
	.state.error small {
		font-size: 12px;
		color: var(--color-ws-faint, #6b6b78);
	}

	.sign-in-cta {
		margin-top: 8px;
		padding: 8px 18px;
		font-size: 13px;
		font-weight: 600;
		border-radius: 8px;
		text-decoration: none;
		color: #fff;
		background: var(--color-ws-accent, #7c5cff);
		transition: filter 0.14s ease;
	}

	.sign-in-cta:hover {
		filter: brightness(1.08);
	}

	.state.error strong {
		font-size: 14px;
		color: #fda4af;
	}

	.state.error button {
		margin-top: 8px;
		padding: 6px 12px;
		font-size: 12px;
		border-radius: 8px;
		border: 1px solid rgba(124, 92, 255, 0.4);
		background: transparent;
		color: var(--color-ws-accent, #7c5cff);
		cursor: pointer;
	}

	.state.empty svg {
		width: 96px;
		height: 96px;
		color: var(--color-ws-faint, #6b6b78);
	}

	.spinner {
		width: 24px;
		height: 24px;
		border: 2px solid rgba(124, 92, 255, 0.4);
		border-top-color: #7c5cff;
		border-radius: 999px;
		animation: spin 0.8s linear infinite;
	}

	.spinner.small {
		width: 14px;
		height: 14px;
		border-width: 2px;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.load-state,
	.load-more,
	.end-of-list {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 8px;
		padding: 18px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 12px;
	}

	.load-more {
		background: transparent;
		border: 1px dashed rgba(255, 255, 255, 0.16);
		border-radius: 8px;
		margin: 14px 22px;
		cursor: pointer;
		font-weight: 600;
	}

	.load-more:hover {
		background: rgba(255, 255, 255, 0.04);
	}

	.end-of-list {
		color: var(--color-ws-faint, #6b6b78);
		font-style: italic;
	}

	@media (max-width: 720px) {
		.notifications-page {
			padding: 24px 12px 48px;
		}

		.notifications-page-header {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		.mark-all {
			justify-self: start;
		}

		/*
		 * Keep the body a bounded, internally-scrolling container on mobile.
		 * The app shell locks <html>/<body> to 100vh with overflow:hidden (for
		 * the canvas editor), so the WINDOW cannot scroll here — dropping the
		 * container's max-height (the old `none`) left the overflowing list with
		 * NO scroller at all, breaking infinite scroll. A dynamic-viewport cap
		 * (minus the header + tabs above it) restores in-container scrolling, so
		 * the container's onscroll keeps driving loadMore on mobile too.
		 */
		.notifications-page-body {
			max-height: calc(100dvh - 200px);
		}
	}

	/*
	 * Phone tab strip: the category tabs overflow the viewport and used to scroll
	 * with no hint that more tabs exist off-screen. Give a visible affordance —
	 * an always-shown slim scrollbar plus a right-edge fade mask that signals
	 * "scroll for more". The mask is only applied at phone width so the desktop
	 * strip (which fits) stays crisp to the edge.
	 */
	@media (max-width: 480px) {
		.notifications-page-tabs {
			/* finger-safe: wrap into rows instead of a thin horizontal scroller */
			flex-wrap: wrap;
			overflow-x: visible;
			scrollbar-width: thin;
			scrollbar-color: rgba(124, 92, 255, 0.5) transparent;
			-webkit-overflow-scrolling: touch;
			/* wrap layout needs no edge fade — it would dim the wrapped rows */
		}

		.notifications-page-tabs::-webkit-scrollbar {
			height: 4px;
		}

		.notifications-page-tabs::-webkit-scrollbar-thumb {
			border-radius: 999px;
			background: rgba(124, 92, 255, 0.5);
		}

		.notifications-page-tabs::-webkit-scrollbar-track {
			background: transparent;
		}
	}
</style>
