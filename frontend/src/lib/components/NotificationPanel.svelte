<!--
	NotificationPanel — Wave 2 W2.5 slide-in inbox.

	Mounted once at the workspace shell level and toggled from the topbar bell.
	Shows the current user's notifications, grouped by relative date (Today /
	Yesterday / Last 7 days / Earlier), with a tab filter and "mark all read".
-->
<script lang="ts">
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { notificationsStore } from "$lib/stores/notifications.svelte.ts";
	import { iconForType, iconSvgForType } from "$lib/components/notification-icons.ts";
	import { localizedNotificationTitle, localizedNotificationBody } from "$lib/components/notification-localize.ts";
	import PendingInvitesPanel from "$lib/components/PendingInvitesPanel.svelte";
	import {
		type NotificationCategory,
		type NotificationPayload,
	} from "$lib/api/client.ts";

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		open = false,
		onClose,
	}: {
		open?: boolean;
		onClose?: () => void;
	} = $props();

	type TabFilter = "all" | "unread" | "tasks" | "support" | "billing" | "system";

	let activeTab = $state<TabFilter>("all");

	let panelRef = $state<HTMLElement | null>(null);

	// Category tabs narrow client-side (no server param), so a tab can have zero
	// matches in the cached pages while more remain on the server. The effect
	// below auto-pages to find matches, but that MUST be bounded: without a cap a
	// category the user has none of would page the entire history one request at a
	// time (an unbounded serial waterfall → rate-limit risk). Scan at most a few
	// extra pages per tab selection, then stop and let the user load more by hand.
	const AUTO_SCAN_MAX_PAGES = 3;
	let autoScanned = $state(0);

	$effect(() => {
		if (open) {
			// The store filter is a singleton shared with the /notifications page.
			// That page may have left it on "unread"; reset to the panel's default
			// All view so reopening the panel doesn't silently hide read items.
			activeTab = "all";
			autoScanned = 0;
			// setFilter("all") reloads when the filter actually changed; when it was
			// already "all" we still refresh so the panel opens with current data.
			if (notificationsStore.filter === "all") {
				void notificationsStore.load();
			} else {
				void notificationsStore.setFilter("all");
			}
		}
	});

	function selectTab(tab: TabFilter): void {
		activeTab = tab;
		// Reset the auto-scan budget so a fresh tab gets its own bounded scan.
		autoScanned = 0;
		// The Unread tab is server-backed so it can page past the cached first
		// page; every other tab lists all notifications (category narrowing stays
		// client-side, but we keep loading while hasMore is true — see below).
		void notificationsStore.setFilter(tab === "unread" ? "unread" : "all");
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") onClose?.();
	}

	// Pending chapter-team invites are rendered by the shared PendingInvitesPanel
	// (also used on the Library home); it owns the fetch + accept flow and only
	// reloads while this surface is `open`.

	// Real focus trap: this panel declares role="dialog" + aria-modal, so keyboard
	// focus must stay inside it while open and return to the opener on close. The
	// panel stays mounted (it slides via CSS transform), so the trap is scoped to
	// the open state instead of mount/unmount.
	function getFocusablePanelControls(): HTMLElement[] {
		if (!panelRef) return [];
		const controls = panelRef.querySelectorAll<HTMLElement>(
			"a[href], button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])",
		);
		return Array.from(controls).filter((control) => {
			const disabled = "disabled" in control && Boolean((control as HTMLButtonElement).disabled);
			const style = window.getComputedStyle(control);
			return !disabled
				&& control.getAttribute("aria-hidden") !== "true"
				&& control.tabIndex >= 0
				&& style.display !== "none"
				&& style.visibility !== "hidden";
		});
	}

	$effect(() => {
		if (!open || !panelRef) return;

		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const focusFrame = requestAnimationFrame(() => {
			const [first] = getFocusablePanelControls();
			(first ?? panelRef)?.focus();
		});

		function handleTrapKeydown(event: KeyboardEvent): void {
			if (event.key !== "Tab") return;
			const controls = getFocusablePanelControls();
			if (!controls.length) {
				event.preventDefault();
				panelRef?.focus();
				return;
			}
			const first = controls[0];
			const last = controls[controls.length - 1];
			const active = document.activeElement;
			if (event.shiftKey) {
				if (active === first || !panelRef?.contains(active)) {
					event.preventDefault();
					last.focus();
				}
			} else if (active === last || !panelRef?.contains(active)) {
				event.preventDefault();
				first.focus();
			}
		}

		function handleTrapFocusIn(event: FocusEvent): void {
			const target = event.target;
			if (target instanceof Node && panelRef?.contains(target)) return;
			const [first] = getFocusablePanelControls();
			(first ?? panelRef)?.focus();
		}

		document.addEventListener("keydown", handleTrapKeydown, true);
		document.addEventListener("focusin", handleTrapFocusIn, true);

		return () => {
			cancelAnimationFrame(focusFrame);
			document.removeEventListener("keydown", handleTrapKeydown, true);
			document.removeEventListener("focusin", handleTrapFocusIn, true);
			if (previousFocus?.isConnected && !previousFocus.inert) {
				requestAnimationFrame(() => previousFocus.focus());
			}
		};
	});

	let filteredItems = $derived(filterItems(notificationsStore.items, activeTab));
	let grouped = $derived(groupByRelativeDate(filteredItems));
	let unreadByCategory = $derived(notificationsStore.unreadByCategory);

	// Category unread tallies are computed from the CACHED pages only (the server
	// has no per-category filter yet), so they can understate the true total when
	// more pages remain. Render them with a trailing "+" in that case so the badge
	// reads as "at least N" instead of falsely claiming to be the final count. The
	// Unread tab uses the server-authoritative total, so it never needs the "+".
	function categoryBadge(count: number): string {
		if (count <= 0) return "";
		return notificationsStore.hasMore ? `${count}+` : `${count}`;
	}

	// A tab may have zero matches in the cached pages while more pages remain on
	// the server. This happens for the client-side category tabs, and also for
	// the Unread tab once the cached unread rows are individually marked read
	// (they stay in `items` with a readAt, so `filteredItems` empties out while
	// hasMore is still true). Auto-fetch the next page instead of falsely
	// declaring the tab empty (which would also hide the load-more controls) —
	// but only up to AUTO_SCAN_MAX_PAGES so an empty category never waterfalls
	// the whole history one serial request at a time.
	$effect(() => {
		if (!open) return;
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
		if (diff < hour) return t("notifications.panelRelative.minutes", "{count} นาที").replace("{count}", String(Math.floor(diff / minute)));
		if (diff < day) return t("notifications.panelRelative.hours", "{count} ชั่วโมง").replace("{count}", String(Math.floor(diff / hour)));
		if (diff < 7 * day) return t("notifications.panelRelative.days", "{count} วัน").replace("{count}", String(Math.floor(diff / day)));
		return new Date(ts).toLocaleDateString();
	}

	// Rows with a destination render as real <a href> so Cmd/Ctrl/middle-click
	// "open in new tab" works. For a plain click we keep SPA navigation: mark
	// read, close the panel, and goto() — but for a modified click we let the
	// browser take the native anchor behaviour (and still mark read).
	function isModifiedClick(event: MouseEvent): boolean {
		return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1;
	}

	async function handleLinkClick(event: MouseEvent, entry: NotificationPayload): Promise<void> {
		if (isModifiedClick(event)) {
			// Native open-in-new-tab; mark read without hijacking the navigation.
			void notificationsStore.markRead(entry.id).catch(() => {});
			return;
		}
		event.preventDefault();
		await notificationsStore.markRead(entry.id).catch(() => {});
		if (entry.linkUrl) {
			onClose?.();
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

	function handleScroll(event: Event): void {
		const target = event.currentTarget as HTMLElement;
		const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
		if (remaining < 96 && notificationsStore.hasMore && !notificationsStore.loadingMore) {
			void notificationsStore.loadMore();
		}
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

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<button
		type="button"
		class="ws-notification-backdrop"
		aria-label={t("notifications.panel.closeAria", "ปิดการแจ้งเตือน")}
		onclick={() => onClose?.()}
	></button>
{/if}

<div
	bind:this={panelRef}
	class="ws-notification-panel"
	class:open
	inert={!open}
	aria-hidden={!open}
	tabindex="-1"
	aria-label={t("notifications.panel.dialogAria", "แผงการแจ้งเตือน")}
	aria-modal={open}
	role="dialog"
>
	<header class="ws-notification-header">
		<div>
			<h2>{t("notifications.panel.heading", "การแจ้งเตือน")}</h2>
			<p>{t("notifications.panel.unreadCount", "{count} รายการที่ยังไม่ได้อ่าน").replace("{count}", String(notificationsStore.unreadCount))}</p>
		</div>
		<div class="ws-notification-header-actions">
			<button
				type="button"
				class="ws-notification-mark-all ws-btn-ghost"
				onclick={handleMarkAll}
				disabled={notificationsStore.unreadCount === 0}
			>
				{t("notifications.markAll", "อ่านทั้งหมด")}
			</button>
			<button
				type="button"
				class="ws-notification-close ws-btn-ghost"
				aria-label={t("common.close", "ปิด")}
				onclick={() => onClose?.()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
					<path d="M6 6l12 12M18 6 6 18"/>
				</svg>
			</button>
		</div>
	</header>

	<nav class="ws-notification-tabs" aria-label={t("notifications.filterAria", "กรองการแจ้งเตือนตามประเภท")}>
		{#each [
			{ id: "all", label: t("notifications.tab.all", "ทั้งหมด"), badge: "" },
			{ id: "unread", label: t("notifications.tab.unread", "ยังไม่อ่าน"), badge: notificationsStore.unreadCount > 0 ? String(notificationsStore.unreadCount) : "" },
			{ id: "tasks", label: categoryLabel("tasks"), badge: categoryBadge(unreadByCategory.tasks) },
			{ id: "support", label: categoryLabel("support"), badge: categoryBadge(unreadByCategory.support) },
			{ id: "billing", label: categoryLabel("billing"), badge: categoryBadge(unreadByCategory.billing) },
			{ id: "system", label: categoryLabel("system"), badge: categoryBadge(unreadByCategory.system) },
		] as tab (tab.id)}
			<button
				type="button"
				class="ws-notification-tab"
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

	<div class="ws-notification-body" onscroll={handleScroll}>
		<PendingInvitesPanel variant="notification" active={open} onBeforeNavigate={() => onClose?.()} />
		{#if notificationsStore.loading && notificationsStore.items.length === 0}
			<div class="ws-notification-state">
				<div class="ws-notification-spinner" aria-hidden="true"></div>
				<p>{t("notifications.loading", "กำลังโหลดการแจ้งเตือน...")}</p>
			</div>
		{:else if notificationsStore.error && notificationsStore.items.length === 0}
			<!-- Initial load failed with nothing cached: surface the failure + a
			     retry instead of falling through to a misleading empty state. -->
			<div class="ws-notification-state ws-notification-error">
				<strong>{t("notifications.loadError", "โหลดไม่สำเร็จ")}</strong>
				<small>{notificationsStore.error}</small>
				<button
					type="button"
					class="ws-notification-load-more ws-btn-ghost"
					onclick={() => void notificationsStore.load()}
				>{t("common.retry", "ลองอีกครั้ง")}</button>
			</div>
		{:else if filteredItems.length === 0 && (notificationsStore.loadingMore || (notificationsStore.hasMore && activeTab !== "all"))}
			<!-- No matches in the cached pages yet, but more remain on the server.
			     Surface progress / a way to keep paging instead of a false empty. -->
			<div class="ws-notification-state">
				{#if notificationsStore.loadingMore}
					<div class="ws-notification-spinner" aria-hidden="true"></div>
					<p>{t("notifications.searching", "กำลังค้นหาการแจ้งเตือน...")}</p>
				{:else}
					<button
						type="button"
						class="ws-notification-load-more ws-btn-ghost"
						onclick={() => { autoScanned = 0; void notificationsStore.loadMore(); }}
					>{t("notifications.loadMoreToSearch", "โหลดเพิ่มเพื่อค้นหา")}</button>
				{/if}
			</div>
		{:else if filteredItems.length === 0}
			<div class="ws-notification-state ws-notification-empty">
				<svg viewBox="0 0 96 96" fill="none" aria-hidden="true">
					<circle cx="48" cy="48" r="40" stroke="currentColor" stroke-opacity="0.18" stroke-width="2"/>
					<path d="M30 56h36M30 44h22M30 32h28" stroke="currentColor" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round"/>
				</svg>
				<strong>{t("notifications.empty", "ไม่มีการแจ้งเตือน")}</strong>
				<small>{activeTab === "unread" ? t("notifications.panel.emptyUnread", "อ่านทั้งหมดแล้ว") : t("notifications.panel.emptyBox", "ยังไม่มีอะไรในกล่องนี้ — ลองทำงานต่อแล้วกลับมาดู")}</small>
			</div>
		{:else}
			{#each grouped as section (section.key)}
				<section class="ws-notification-section" aria-label={section.label}>
					<h3>{section.label}</h3>
					<ul>
						{#each section.items as entry (entry.id)}
							<li class="ws-notification-item" class:unread={!entry.readAt}>
								{#if entry.linkUrl}
									<a
										href={entry.linkUrl}
										class="ws-notification-item-link"
										onclick={(event) => void handleLinkClick(event, entry)}
									>
										<span class="ws-notification-item-icon" data-icon={iconForType(entry.type)} aria-hidden="true">
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">{@html iconSvgForType(entry.type)}</svg>
										</span>
										<span class="ws-notification-item-body">
											<span class="ws-notification-item-title">{localizedNotificationTitle(entry, $_)}</span>
									{#if localizedNotificationBody(entry, $_)}
										<span class="ws-notification-item-detail">{localizedNotificationBody(entry, $_)}</span>
											{/if}
											<span class="ws-notification-item-meta">
												<em>{categoryLabel(entry.category)}</em>
												<time>{relativeTime(entry.createdAt)}</time>
											</span>
										</span>
										{#if !entry.readAt}
											<span class="ws-notification-unread-dot" aria-label={t("notifications.unreadDot", "ยังไม่ได้อ่าน")}></span>
										{/if}
									</a>
								{:else}
									<button
										type="button"
										class="ws-notification-item-link"
										onclick={() => void handleItemClick(entry)}
									>
										<span class="ws-notification-item-icon" data-icon={iconForType(entry.type)} aria-hidden="true">
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">{@html iconSvgForType(entry.type)}</svg>
										</span>
										<span class="ws-notification-item-body">
											<span class="ws-notification-item-title">{localizedNotificationTitle(entry, $_)}</span>
									{#if localizedNotificationBody(entry, $_)}
										<span class="ws-notification-item-detail">{localizedNotificationBody(entry, $_)}</span>
											{/if}
											<span class="ws-notification-item-meta">
												<em>{categoryLabel(entry.category)}</em>
												<time>{relativeTime(entry.createdAt)}</time>
											</span>
										</span>
										{#if !entry.readAt}
											<span class="ws-notification-unread-dot" aria-label={t("notifications.unreadDot", "ยังไม่ได้อ่าน")}></span>
										{/if}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
			{#if notificationsStore.loadingMore}
				<div class="ws-notification-loading-more">
					<div class="ws-notification-spinner small" aria-hidden="true"></div>
					<span>{t("notifications.loadingMore", "กำลังโหลดเพิ่ม...")}</span>
				</div>
			{:else if notificationsStore.hasMore}
				<button
					type="button"
					class="ws-notification-load-more ws-btn-ghost"
					onclick={() => void notificationsStore.loadMore()}
				>{t("notifications.loadMore", "โหลดเพิ่มเติม")}</button>
			{/if}
		{/if}
	</div>

	<footer class="ws-notification-footer">
		<a href="/notifications" onclick={() => onClose?.()}>{t("notifications.panel.viewAll", "ดูทั้งหมดในหน้าเต็ม")}</a>
	</footer>
</div>

<style>
	.ws-notification-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 62%, transparent);
		border: 0;
		cursor: pointer;
		z-index: 998;
	}

	.ws-notification-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(420px, 92vw);
		display: flex;
		flex-direction: column;
		background: color-mix(in srgb, var(--color-ws-surface) 96%, var(--color-ws-bg));
		border-left: 1px solid var(--ws-hair);
		box-shadow: -18px 0 40px -18px color-mix(in srgb, var(--color-ws-bg) 88%, transparent);
		transform: translateX(100%);
		/* visibility flips AFTER the slide-out so audits/AT see a closed panel as
		   genuinely hidden (no off-canvas geometry noise) while the animation
		   still plays — R2-10. */
		visibility: hidden;
		transition: transform 0.22s ease, visibility 0s linear 0.22s;
		z-index: 999;
		font-family: var(--font-ws-sans, system-ui, sans-serif);
		color: var(--color-ws-ink);
	}

	.ws-notification-panel.open {
		transform: translateX(0);
		visibility: visible;
		transition: transform 0.22s ease, visibility 0s;
	}

	.ws-notification-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 12px;
		padding: 18px 18px 14px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.ws-notification-header h2 {
		font-size: 15px;
		font-weight: 700;
		margin: 0;
	}

	.ws-notification-header p {
		font-size: 12px;
		color: var(--color-ws-faint);
		margin: 4px 0 0;
	}

	.ws-notification-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ws-notification-mark-all {
		font-size: 12px;
		min-height: 36px;
		font-weight: 700;
		color: var(--color-ws-accent);
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 0 12px;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease;
	}

	.ws-notification-mark-all:hover:not([disabled]) {
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
	}

	.ws-notification-mark-all[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ws-notification-close {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-text);
		cursor: pointer;
	}

	.ws-notification-close svg {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}

	.ws-notification-tabs {
		display: flex;
		gap: 4px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--ws-hair);
		overflow-x: auto;
	}

	.ws-notification-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 6px 10px;
		border-radius: 999px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-ws-text);
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
	}

	.ws-notification-tab:hover {
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: var(--color-ws-ink);
	}

	.ws-notification-tab.active {
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		border-color: color-mix(in srgb, var(--color-ws-accent) 45%, transparent);
		color: var(--color-ws-ink);
	}

	.ws-notification-tab small {
		min-width: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.ws-notification-body {
		flex: 1;
		overflow-y: auto;
		padding: 10px 0 18px;
	}

	.ws-notification-section h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-ws-faint);
		padding: 14px 18px 6px;
		margin: 0;
		font-weight: 800;
	}

	.ws-notification-section ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.ws-notification-item {
		border-bottom: 1px solid var(--ws-hair);
	}

	.ws-notification-item-link {
		display: grid;
		grid-template-columns: 36px 1fr auto;
		gap: 12px;
		width: 100%;
		padding: 12px 18px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background 0.14s ease;
	}

	.ws-notification-item-link:hover {
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	.ws-notification-item-icon {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--color-ws-ink));
	}

	.ws-notification-item-icon svg {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}

	.ws-notification-item-icon[data-icon="ai-fail"],
	.ws-notification-item-icon[data-icon="payment-fail"],
	.ws-notification-item-icon[data-icon="reject"],
	.ws-notification-item-icon[data-icon="quota"] {
		background: color-mix(in srgb, var(--color-ws-rose) 16%, transparent);
		color: var(--color-ws-rose);
	}

	.ws-notification-item-icon[data-icon="approve"],
	.ws-notification-item-icon[data-icon="payment-ok"],
	.ws-notification-item-icon[data-icon="ai-success"] {
		background: color-mix(in srgb, var(--color-ws-green) 16%, transparent);
		color: var(--color-ws-green);
	}

	.ws-notification-item-icon[data-icon="team"],
	.ws-notification-item-icon[data-icon="invite"] {
		background: color-mix(in srgb, var(--color-ws-cyan) 16%, transparent);
		color: var(--color-ws-cyan);
	}

	.ws-notification-item-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.ws-notification-item-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-ws-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.ws-notification-item.unread .ws-notification-item-title {
		color: var(--color-ws-ink);
	}

	.ws-notification-item-detail {
		font-size: 12px;
		color: var(--color-ws-text);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.ws-notification-item-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--color-ws-faint);
	}

	.ws-notification-item-meta em {
		font-style: normal;
		padding: 2px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		color: var(--color-ws-text);
	}

	.ws-notification-unread-dot {
		align-self: center;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-ws-accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ws-accent) 20%, transparent);
	}

	.ws-notification-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 48px 24px;
		color: var(--color-ws-text);
		text-align: center;
	}

	.ws-notification-empty svg {
		width: 96px;
		height: 96px;
		color: var(--color-ws-faint);
	}

	.ws-notification-empty strong {
		font-size: 14px;
		color: var(--color-ws-ink);
	}

	.ws-notification-empty small {
		font-size: 12px;
		color: var(--color-ws-faint);
	}

	.ws-notification-error strong {
		font-size: 14px;
		color: var(--color-ws-rose);
	}

	.ws-notification-error small {
		font-size: 12px;
		color: var(--color-ws-faint);
	}

	.ws-notification-spinner {
		width: 22px;
		height: 22px;
		border: 2px solid color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		border-top-color: var(--color-ws-accent);
		border-radius: 999px;
		animation: ws-noti-spin 0.8s linear infinite;
	}

	.ws-notification-spinner.small {
		width: 14px;
		height: 14px;
		border-width: 2px;
	}

	@keyframes ws-noti-spin {
		to { transform: rotate(360deg); }
	}

	.ws-notification-loading-more,
	.ws-notification-load-more {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 8px;
		padding: 16px;
		color: var(--color-ws-text);
		font-size: 12px;
	}

	.ws-notification-load-more {
		background: transparent;
		min-height: 40px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		margin: 12px 18px;
		cursor: pointer;
	}

	.ws-notification-load-more:hover {
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.ws-notification-footer {
		padding: 14px 18px;
		border-top: 1px solid var(--ws-hair);
		font-size: 12px;
	}

	.ws-notification-footer a {
		color: var(--color-ws-accent);
		text-decoration: none;
	}

	.ws-notification-footer a:hover {
		text-decoration: underline;
	}
</style>
