<!-- /settings/notifications — flexible per-type × per-channel notification prefs.
     Drives entirely from the backend preferences matrix (PR #168):
       GET  /api/notifications/preferences → { types, channels, values, defaults }
       PUT  /api/notifications/preferences  { updates: [{type, channel, enabled}] }
     Toggling a cell PUTs that single override optimistically, reverting + toasting
     on error. "Reset to defaults" diffs every diverged cell back to its coded
     default in one batch PUT. Types are grouped by a local category map mirroring
     the backend TYPE_CATEGORY (the prefs endpoint returns the type list, not the
     category) so the grid reads as labelled sections rather than 19 flat rows. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import {
		getNotificationPreferences,
		updateNotificationPreferences,
		type NotificationPreferences,
		type NotificationChannel,
		type NotificationPreferenceUpdate,
		type NotificationType,
	} from "$lib/api/client.ts";

	// Localise via svelte-i18n; $_ resolves from the active-locale dictionary
	// (th.json is byte-exact, so TH is unchanged), returning the key itself only
	// on a miss / before init.
	function t(key: string): string {
		const value = $_(key);
		return value && value !== key ? value : key;
	}

	// ── Presentation taxonomy ────────────────────────────────────────────────
	// Category + i18n key per type. Mirrors backend TYPE_CATEGORY so the grid
	// can group; any type the server returns that we don't recognise still renders
	// (falls into "system") so a newly-added backend type is never silently hidden.
	type Category = "support" | "billing" | "work" | "system";

	const CATEGORY_ORDER: Category[] = ["work", "support", "billing", "system"];
	const CATEGORY_META: Record<Category, { titleKey: string; blurbKey: string }> = {
		work: {
			titleKey: "notificationSettings.category.work.title",
			blurbKey: "notificationSettings.category.work.blurb",
		},
		support: {
			titleKey: "notificationSettings.category.support.title",
			blurbKey: "notificationSettings.category.support.blurb",
		},
		billing: {
			titleKey: "notificationSettings.category.billing.title",
			blurbKey: "notificationSettings.category.billing.blurb",
		},
		system: {
			titleKey: "notificationSettings.category.system.title",
			blurbKey: "notificationSettings.category.system.blurb",
		},
	};

	function categoryTitle(category: Category): string {
		const meta = CATEGORY_META[category];
		return meta ? t(meta.titleKey) : category;
	}
	function categoryBlurb(category: Category): string | null {
		const meta = CATEGORY_META[category];
		return meta ? t(meta.blurbKey) : null;
	}

	const TYPE_META: Record<string, { category: Category; labelKey: string }> = {
		// Work / assignment
		task_assigned: { category: "work", labelKey: "notificationSettings.type.task_assigned" },
		work_assigned: { category: "work", labelKey: "notificationSettings.type.work_assigned" },
		chapter_submitted: { category: "work", labelKey: "notificationSettings.type.chapter_submitted" },
		chapter_approved: { category: "work", labelKey: "notificationSettings.type.chapter_approved" },
		chapter_rejected: { category: "work", labelKey: "notificationSettings.type.chapter_rejected" },
		comment_new: { category: "work", labelKey: "notificationSettings.type.comment_new" },
		comment_reply: { category: "work", labelKey: "notificationSettings.type.comment_reply" },
		ai_job_complete: { category: "work", labelKey: "notificationSettings.type.ai_job_complete" },
		ai_job_failed: { category: "work", labelKey: "notificationSettings.type.ai_job_failed" },
		editing_taken_over: { category: "work", labelKey: "notificationSettings.type.editing_taken_over" },
		// Support
		ticket_opened: { category: "support", labelKey: "notificationSettings.type.ticket_opened" },
		ticket_replied: { category: "support", labelKey: "notificationSettings.type.ticket_replied" },
		ticket_escalated: { category: "support", labelKey: "notificationSettings.type.ticket_escalated" },
		ticket_resolved: { category: "support", labelKey: "notificationSettings.type.ticket_resolved" },
		// Billing / quota
		payment_succeeded: { category: "billing", labelKey: "notificationSettings.type.payment_succeeded" },
		payment_failed: { category: "billing", labelKey: "notificationSettings.type.payment_failed" },
		quota_warning_80pct: { category: "billing", labelKey: "notificationSettings.type.quota_warning_80pct" },
		quota_frozen: { category: "billing", labelKey: "notificationSettings.type.quota_frozen" },
		// System / membership
		invite_received: { category: "system", labelKey: "notificationSettings.type.invite_received" },
		team_member_joined: { category: "system", labelKey: "notificationSettings.type.team_member_joined" },
	};

	function channelLabel(channel: NotificationChannel): string {
		if (channel === "in_app") return t("notificationSettings.channel.in_app");
		if (channel === "email") return t("notificationSettings.channel.email");
		return channel;
	}

	function metaFor(type: NotificationType): { category: Category; label: string } {
		const meta = TYPE_META[type];
		if (meta) return { category: meta.category, label: t(meta.labelKey) };
		return { category: "system", label: type };
	}

	// ── State ─────────────────────────────────────────────────────────────────
	let prefs = $state<NotificationPreferences | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let authReady = $state(false);
	// type::channel keys currently mid-PUT — disables that toggle so a double-tap
	// can't fire two conflicting writes.
	let pending = $state<Set<string>>(new Set());
	let resetting = $state(false);

	function cellKey(type: NotificationType, channel: NotificationChannel): string {
		return `${type}::${channel}`;
	}

	onMount(async () => {
		// On a hard reload / direct link nothing else restores the session, so do it
		// here before the protected prefs load (otherwise the backend 401s). Idempotent.
		await authStore.init();
		authReady = true;
		await load();
	});

	async function load(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			prefs = await getNotificationPreferences();
		} catch (error) {
			loadError = error instanceof Error ? error.message : t("notificationSettings.loadError");
		} finally {
			loading = false;
		}
	}

	// Grouped, ordered view of the server's type list.
	let groups = $derived.by(() => {
		if (!prefs) return [] as Array<{ category: Category; types: NotificationType[] }>;
		const byCategory = new Map<Category, NotificationType[]>();
		for (const type of prefs.types) {
			const { category } = metaFor(type);
			const list = byCategory.get(category) ?? [];
			list.push(type);
			byCategory.set(category, list);
		}
		const ordered: Array<{ category: Category; types: NotificationType[] }> = [];
		for (const category of CATEGORY_ORDER) {
			const types = byCategory.get(category);
			if (types && types.length > 0) ordered.push({ category, types });
		}
		// Any category not in CATEGORY_ORDER (future-proofing) appended at the end.
		for (const [category, types] of byCategory) {
			if (!CATEGORY_ORDER.includes(category) && types.length > 0) {
				ordered.push({ category, types });
			}
		}
		return ordered;
	});

	// True when at least one cell diverges from its coded default — gates the
	// "reset to defaults" affordance so it isn't offered when nothing to reset.
	let hasOverrides = $derived.by(() => {
		if (!prefs) return false;
		for (const type of prefs.types) {
			for (const channel of prefs.channels) {
				if (prefs.values[type]?.[channel] !== prefs.defaults[type]?.[channel]) return true;
			}
		}
		return false;
	});

	function isOn(type: NotificationType, channel: NotificationChannel): boolean {
		return prefs?.values[type]?.[channel] ?? false;
	}

	function isDefaultOverridden(type: NotificationType, channel: NotificationChannel): boolean {
		if (!prefs) return false;
		return prefs.values[type]?.[channel] !== prefs.defaults[type]?.[channel];
	}

	async function toggle(type: NotificationType, channel: NotificationChannel): Promise<void> {
		if (!prefs) return;
		const key = cellKey(type, channel);
		if (pending.has(key)) return;

		const next = !isOn(type, channel);

		// Optimistic flip.
		const snapshot = prefs.values[type] ? { ...prefs.values[type] } : { email: false, in_app: false };
		prefs.values[type] = { ...snapshot, [channel]: next };
		pending = new Set(pending).add(key);

		try {
			const result = await updateNotificationPreferences([{ type, channel, enabled: next }]);
			// Reconcile with the server's authoritative matrix.
			prefs = result.preferences;
		} catch (error) {
			// Revert the optimistic flip.
			if (prefs) prefs.values[type] = snapshot;
			toastsStore.error({
				title: t("notificationSettings.saveErrorTitle"),
				body: error instanceof Error ? error.message : t("notificationSettings.tryAgainSoon"),
			});
		} finally {
			const nextPending = new Set(pending);
			nextPending.delete(key);
			pending = nextPending;
		}
	}

	async function resetToDefaults(): Promise<void> {
		if (!prefs || resetting) return;
		// Diff every diverged cell back to its coded default in one batch.
		const updates: NotificationPreferenceUpdate[] = [];
		for (const type of prefs.types) {
			for (const channel of prefs.channels) {
				const current = prefs.values[type]?.[channel];
				const fallback = prefs.defaults[type]?.[channel];
				if (current !== fallback && fallback !== undefined) {
					updates.push({ type, channel, enabled: fallback });
				}
			}
		}
		if (updates.length === 0) return;

		resetting = true;
		const snapshot = prefs;
		try {
			const result = await updateNotificationPreferences(updates);
			prefs = result.preferences;
			toastsStore.success({ title: t("notificationSettings.resetSuccess") });
		} catch (error) {
			prefs = snapshot;
			toastsStore.error({
				title: t("notificationSettings.resetErrorTitle"),
				body: error instanceof Error ? error.message : t("notificationSettings.tryAgainSoon"),
			});
		} finally {
			resetting = false;
		}
	}
</script>

<svelte:head>
	<title>Notifications · Settings</title>
</svelte:head>

<div class="settings-page">
	<header class="settings-head">
		<p class="eyebrow">Account · Settings</p>
		<h1>{t("notificationSettings.title")}</h1>
		<p>
			{t("notificationSettings.intro")}
		</p>
	</header>

	{#if loading}
		<div class="state-card ws-panel-quiet" aria-busy="true">{t("notificationSettings.loading")}</div>
	{:else if loadError}
		<div class="settings-error" role="alert">
			<span>{loadError}</span>
			<button type="button" class="settings-btn ws-dialog-btn ws-btn-ghost" onclick={() => void load()}>{t("common.retry")}</button>
		</div>
	{:else if !prefs || prefs.types.length === 0}
		<div class="state-card ws-panel-quiet">{t("notificationSettings.empty")}</div>
	{:else}
		<div class="prefs-toolbar">
			<p class="prefs-legend">
				<span class="legend-dot"></span> {t("notificationSettings.legend")}
			</p>
			<button
				type="button"
				class="settings-btn ws-dialog-btn ws-btn-ghost"
				onclick={() => void resetToDefaults()}
				disabled={!hasOverrides || resetting}
			>
				{resetting ? t("notificationSettings.resetting") : t("notificationSettings.resetButton")}
			</button>
		</div>

		{#each groups as group (group.category)}
			{@const groupTitle = categoryTitle(group.category)}
			{@const groupBlurb = categoryBlurb(group.category)}
				<section class="pref-group ws-panel" aria-labelledby={`grp-${group.category}`}>
				<header class="pref-group-head">
					<h2 id={`grp-${group.category}`}>{groupTitle}</h2>
					{#if groupBlurb}
						<p>{groupBlurb}</p>
					{/if}
				</header>

				<div class="pref-table" role="table" aria-label={groupTitle}>
					<div class="pref-row pref-row-header" role="row">
						<span class="pref-type-cell" role="columnheader">{t("notificationSettings.columnType")}</span>
						{#each prefs.channels as channel (channel)}
							<span class="pref-channel-cell" role="columnheader">{channelLabel(channel)}</span>
						{/each}
					</div>

					{#each group.types as type (type)}
						{@const meta = metaFor(type)}
						<div class="pref-row" role="row">
							<span class="pref-type-cell" role="cell">
								<span class="pref-type-label">{meta.label}</span>
							</span>
							{#each prefs.channels as channel (channel)}
								{@const on = isOn(type, channel)}
								{@const busy = pending.has(cellKey(type, channel))}
								<span class="pref-channel-cell" role="cell">
									<button
										type="button"
										role="switch"
										aria-checked={on}
										aria-label={`${meta.label} · ${channelLabel(channel)}`}
										class="toggle"
										class:on
										class:overridden={isDefaultOverridden(type, channel)}
										disabled={busy}
										onclick={() => void toggle(type, channel)}
									>
										<span class="toggle-knob"></span>
									</button>
								</span>
							{/each}
						</div>
					{/each}
				</div>
			</section>
		{/each}
	{/if}
</div>

<style>
	.settings-page {
		max-width: 1080px;
		margin: 0 auto;
		padding: 48px clamp(16px, 4vw, 56px) 96px;
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}
	.settings-head {
		margin-bottom: 28px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-ws-violet);
		font-size: 11px;
		margin: 0 0 6px;
	}
	.settings-head h1 {
		font-size: 32px;
		font-weight: 800;
		margin: 0 0 8px;
	}
	.settings-head p {
		color: var(--color-ws-text);
		font-size: 14px;
		max-width: 620px;
	}
	.state-card {
		padding: 24px;
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-text);
		font-size: 14px;
	}
	.settings-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		padding: 14px 16px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface));
		color: color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-ink));
		font-size: 13px;
	}
	.settings-btn {
		min-height: 38px;
	}
	.settings-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.prefs-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 20px;
	}
	.prefs-legend {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 12px;
		color: var(--color-ws-text);
	}
	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-ws-violet);
		outline: 3px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
	}
	.pref-group {
		margin-bottom: 28px;
		border-radius: var(--radius-ws-card);
		overflow: hidden;
	}
	.pref-group-head {
		padding: 18px 20px 14px;
		border-bottom: 1px solid var(--ws-hair);
	}
	.pref-group-head h2 {
		margin: 0 0 4px;
		font-size: 16px;
	}
	.pref-group-head p {
		margin: 0;
		font-size: 12.5px;
		color: var(--color-ws-text);
	}
	.pref-table {
		display: flex;
		flex-direction: column;
	}
	.pref-row {
		display: grid;
		grid-template-columns: 1fr 96px 96px;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--ws-hair);
	}
	.pref-row:last-child {
		border-bottom: 0;
	}
	.pref-row-header {
		padding-top: 12px;
		padding-bottom: 12px;
		background: var(--color-ws-surface2);
	}
	.pref-row-header .pref-type-cell,
	.pref-row-header .pref-channel-cell {
		color: var(--color-ws-text);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 10.5px;
		font-weight: 700;
	}
	.pref-type-cell {
		min-width: 0;
	}
	.pref-type-label {
		font-size: 13.5px;
		color: var(--color-ws-ink);
	}
	.pref-channel-cell {
		display: flex;
		justify-content: center;
		align-items: center;
		text-align: center;
	}
	/* Accessible toggle switch. */
	.toggle {
		position: relative;
		width: 48px;
		height: 36px;
		border-radius: 9999px;
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-surface2);
		cursor: pointer;
		padding: 0;
		transition: background 0.16s ease, border-color 0.16s ease;
		flex-shrink: 0;
	}
	.toggle:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.toggle .toggle-knob {
		position: absolute;
		top: 5px;
		left: 5px;
		width: 24px;
		height: 24px;
		border-radius: 999px;
		background: var(--color-ws-faint);
		transition: transform 0.16s ease, background 0.16s ease;
	}
	.toggle.on {
		background: color-mix(in srgb, var(--color-ws-accent) 80%, var(--color-ws-surface2));
		border-color: transparent;
	}
	.toggle.on .toggle-knob {
		transform: translateX(14px);
		background: var(--color-ws-ink);
	}
	.toggle:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}
	/* Purple dot when the cell diverges from its coded default. */
	.toggle.overridden::after {
		content: "";
		position: absolute;
		top: -3px;
		right: -3px;
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: var(--color-ws-violet);
		outline: 2px solid var(--color-ws-bg);
	}
	@media (prefers-reduced-motion: reduce) {
		.toggle,
		.toggle .toggle-knob {
			transition: none;
		}
	}
	@media (max-width: 520px) {
		.pref-row {
			grid-template-columns: 1fr 64px 64px;
			padding-left: 14px;
			padding-right: 14px;
		}
	}
</style>
