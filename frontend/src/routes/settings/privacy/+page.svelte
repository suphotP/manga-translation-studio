<!-- /settings/privacy — GDPR self-service (W2.6).
     Lets an EU user exercise their data-subject rights without contacting support:
       • Export my data  → POST/GET /api/account/export (+ signed download link)
       • Delete my account → DELETE /api/account (soft-delete + 30-day grace)
       • Restore → POST /api/account/restore while still within the grace window
     This is legal-sensitive copy: every visible string is localised and the
     destructive action is gated behind an explicit type-to-confirm step. No fake
     data — history/states reflect exactly what the backend returns. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import {
		requestAccountExport,
		listAccountExports,
		downloadAccountExport,
		deleteMyAccount,
		restoreMyAccount,
		restoreAccountWithToken,
		type AccountExportJob,
		type AccountExportStatus,
		type AccountDeleteResult,
	} from "$lib/api/client.ts";

	// Localise via svelte-i18n with an explicit English fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// ── State ──────────────────────────────────────────────────────────────────
	let authReady = $state(false);

	// Export history.
	let jobs = $state<AccountExportJob[]>([]);
	let loadingJobs = $state(true);
	let jobsError = $state<string | null>(null);
	let requesting = $state(false);

	// Account deletion.
	let deleteResult = $state<AccountDeleteResult | null>(null);
	let confirmOpen = $state(false);
	let confirmText = $state("");
	let deleteReason = $state("");
	let deleting = $state(false);
	let restoring = $state(false);

	// A job is mid-flight on the server; we poll while any are.
	let hasInflight = $derived(
		jobs.some((j) => j.status === "queued" || j.status === "processing"),
	);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	// The literal the user must type to arm the delete button. Localised so the
	// confirmation reads naturally in every language.
	let confirmWord = $derived(t("privacy.delete.confirmWord", "DELETE"));
	let confirmArmed = $derived(
		confirmText.trim().toUpperCase() === confirmWord.trim().toUpperCase(),
	);

	onMount(() => {
		// On a hard reload / direct link nothing else restores the session, so do
		// it here before the protected loads (otherwise the backend 401s).
		let cancelled = false;
		(async () => {
			await authStore.init();
			if (cancelled) return;
			authReady = true;
			await loadJobs();
		})();
		return () => {
			cancelled = true;
			if (pollTimer) clearTimeout(pollTimer);
		};
	});

	// Re-arm the poll whenever the in-flight state flips on.
	$effect(() => {
		if (hasInflight && !pollTimer) {
			pollTimer = setTimeout(() => {
				pollTimer = null;
				void loadJobs({ silent: true });
			}, 4000);
		}
	});

	async function loadJobs(opts: { silent?: boolean } = {}): Promise<void> {
		if (!opts.silent) loadingJobs = true;
		jobsError = null;
		try {
			const result = await listAccountExports();
			jobs = result.jobs;
		} catch (error) {
			jobsError =
				error instanceof Error
					? error.message
					: t("privacy.export.loadError", "Couldn't load your export history.");
		} finally {
			loadingJobs = false;
		}
	}

	async function onRequestExport(): Promise<void> {
		if (requesting) return;
		requesting = true;
		try {
			const { job } = await requestAccountExport();
			// Merge the returned job into history (the backend may return an
			// already-in-flight job rather than a new one).
			const existing = jobs.findIndex((j) => j.id === job.id);
			if (existing >= 0) jobs[existing] = job;
			else jobs = [job, ...jobs];
			toastsStore.success({
				title: t("privacy.export.requestedTitle", "Export requested"),
				body: t(
					"privacy.export.requestedBody",
					"We're preparing your data. You'll be able to download it here once it's ready.",
				),
			});
			// Pull the authoritative history so statuses stay honest.
			await loadJobs({ silent: true });
		} catch (error) {
			toastsStore.error({
				title: t("privacy.export.requestErrorTitle", "Couldn't start the export"),
				body:
					error instanceof Error
						? error.message
						: t("common.tryAgainSoon", "Please try again in a moment."),
			});
		} finally {
			requesting = false;
		}
	}

	function onDownload(job: AccountExportJob): void {
		if (job.status !== "ready" || !job.zipUrl) return;
		const url = downloadAccountExport(job);
		if (!url) {
			toastsStore.error({
				title: t("privacy.export.downloadErrorTitle", "Download unavailable"),
				body: t(
					"privacy.export.downloadErrorBody",
					"This download link is no longer valid. Request a fresh export.",
				),
			});
		}
	}

	function openConfirm(): void {
		confirmOpen = true;
		confirmText = "";
	}
	function cancelConfirm(): void {
		confirmOpen = false;
		confirmText = "";
		deleteReason = "";
	}

	async function onDeleteAccount(): Promise<void> {
		if (deleting || !confirmArmed) return;
		deleting = true;
		try {
			deleteResult = await deleteMyAccount(deleteReason);
			confirmOpen = false;
			confirmText = "";
			toastsStore.warn({
				title: t("privacy.delete.scheduledTitle", "Account scheduled for deletion"),
				body: t(
					"privacy.delete.scheduledBody",
					"Your account is now closed. You can restore it during the grace window below.",
				),
				durationMs: 0,
			});
		} catch (error) {
			toastsStore.error({
				title: t("privacy.delete.errorTitle", "Couldn't delete your account"),
				body:
					error instanceof Error
						? error.message
						: t("common.tryAgainSoon", "Please try again in a moment."),
			});
		} finally {
			deleting = false;
		}
	}

	// Parse the signed `?user=…&token=…` proof out of the delete response's
	// restoreUrl. Deleting the account REVOKES every session and clears the stored
	// access token (the post-delete 401 → failed refresh wipes it), so a
	// session-based restore from this page would send no credentials and fail with
	// "Missing user". The signed token is exactly the credential that survives
	// that — use it as the primary restore path, mirroring the email-link
	// /account/restore page.
	function parseRestoreProof(url: string | null | undefined): { user: string; token: string } | null {
		if (!url) return null;
		try {
			const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : url;
			const params = new URLSearchParams(qs);
			const user = params.get("user");
			const token = params.get("token");
			if (user && token) return { user, token };
		} catch {
			// fall through to the session-based path
		}
		return null;
	}

	async function onRestore(): Promise<void> {
		if (restoring) return;
		restoring = true;
		try {
			// Prefer the signed restore proof from the delete response (survives the
			// revoked session); fall back to the session-based restore only if the
			// proof is missing (e.g. an older delete result without a restoreUrl).
			const proof = parseRestoreProof(deleteResult?.restoreUrl);
			const { ok } = proof
				? await restoreAccountWithToken(proof.user, proof.token)
				: await restoreMyAccount();
			if (ok) {
				deleteResult = null;
				deleteReason = "";
				toastsStore.success({
					title: t("privacy.restore.successTitle", "Account restored"),
					body: t(
						"privacy.restore.successBody",
						"Welcome back — your account is active again. Please sign in to continue.",
					),
				});
				// Deleting revoked every session, so even after a successful restore
				// this tab has no valid token. Clear any stale local session and send
				// the user to sign in rather than leaving them on a page that 401s.
				await authStore.logout().catch(() => undefined);
				await goto("/login");
			} else {
				toastsStore.error({
					title: t("privacy.restore.errorTitle", "Couldn't restore your account"),
					body: t(
						"privacy.restore.expiredBody",
						"The grace window may have passed. Please contact support.",
					),
				});
			}
		} catch (error) {
			toastsStore.error({
				title: t("privacy.restore.errorTitle", "Couldn't restore your account"),
				body:
					error instanceof Error
						? error.message
						: t("common.tryAgainSoon", "Please try again in a moment."),
			});
		} finally {
			restoring = false;
		}
	}

	// ── Presentation helpers ─────────────────────────────────────────────────
	function statusLabel(status: AccountExportStatus): string {
		switch (status) {
			case "queued":
				return t("privacy.export.status.queued", "Queued");
			case "processing":
				return t("privacy.export.status.processing", "Preparing…");
			case "ready":
				return t("privacy.export.status.ready", "Ready");
			case "failed":
				return t("privacy.export.status.failed", "Failed");
			case "expired":
				return t("privacy.export.status.expired", "Expired");
			default:
				return status;
		}
	}

	function formatDate(iso: string | null): string {
		if (!iso) return "—";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		try {
			return new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(d);
		} catch {
			return d.toISOString();
		}
	}

	function formatBytes(bytes: number | null): string | null {
		if (bytes == null || !Number.isFinite(bytes)) return null;
		if (bytes < 1024) return `${bytes} B`;
		const units = ["KB", "MB", "GB"];
		let value = bytes / 1024;
		let i = 0;
		while (value >= 1024 && i < units.length - 1) {
			value /= 1024;
			i++;
		}
		return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
	}
</script>

<svelte:head>
	<title>{t("privacy.title", "Privacy & Data")} · Settings</title>
</svelte:head>

<div class="settings-page">
	<header class="settings-head">
		<p class="eyebrow">{t("privacy.eyebrow", "Account · Settings")}</p>
		<h1>{t("privacy.title", "Privacy & Data")}</h1>
		<p>
			{t(
				"privacy.intro",
				"Exercise your data rights directly: download a copy of everything we hold about you, or close your account. These tools are self-service and take effect immediately.",
			)}
		</p>
	</header>

	<!-- ── Export my data ─────────────────────────────────────────────── -->
	<section class="card ws-panel" aria-labelledby="privacy-export-heading">
		<header class="card-head">
			<h2 id="privacy-export-heading">{t("privacy.export.heading", "Export my data")}</h2>
			<p>
				{t(
					"privacy.export.blurb",
					"Request a machine-readable copy of your account data — profile, projects, and activity. We'll prepare it in the background; download links expire for your security.",
				)}
			</p>
		</header>

		<div class="card-actions">
			<button
				type="button"
				class="btn btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
				onclick={() => void onRequestExport()}
				disabled={requesting || !authReady}
			>
				{requesting
					? t("privacy.export.requesting", "Requesting…")
					: t("privacy.export.requestButton", "Request data export")}
			</button>
			{#if hasInflight}
				<span class="hint" aria-live="polite">
					{t("privacy.export.inflightHint", "An export is being prepared — this can take a few minutes.")}
				</span>
			{/if}
		</div>

		<div class="history">
			<h3 class="history-title">{t("privacy.export.historyTitle", "Export history")}</h3>
			{#if loadingJobs}
				<div class="state-card ws-panel-quiet" aria-busy="true">
					{t("privacy.export.loading", "Loading your export history…")}
				</div>
			{:else if jobsError}
				<div class="error-banner" role="alert">
					<span>{jobsError}</span>
					<button type="button" class="btn ws-dialog-btn ws-btn-ghost" onclick={() => void loadJobs()}>
						{t("common.retry", "Try again")}
					</button>
				</div>
			{:else if jobs.length === 0}
				<div class="state-card ws-panel-quiet">
					{t("privacy.export.empty", "You haven't requested any data exports yet.")}
				</div>
			{:else}
				<ul class="job-list ws-panel-quiet" data-testid="export-history">
					{#each jobs as job (job.id)}
						{@const size = formatBytes(job.bytes)}
						<li class="job-row">
							<div class="job-main">
								<span class="status-badge" data-status={job.status}>
									{statusLabel(job.status)}
								</span>
								<div class="job-meta">
									<span class="job-date">{formatDate(job.createdAt)}</span>
									{#if size}<span class="job-size">{size}</span>{/if}
								</div>
							</div>
							<div class="job-trail">
								{#if job.status === "ready"}
									<button
										type="button"
										class="btn btn-small ws-dialog-btn ws-btn-ghost"
										onclick={() => onDownload(job)}
									>
										{t("privacy.export.download", "Download")}
									</button>
									{#if job.expiresAt}
										<span class="job-expiry">
											{t("privacy.export.expiresPrefix", "Expires")}
											{formatDate(job.expiresAt)}
										</span>
									{/if}
								{:else if job.status === "failed"}
									<span class="job-failed">
										{job.failureReason ?? t("privacy.export.status.failed", "Failed")}
									</span>
								{:else if job.status === "expired"}
									<span class="job-expiry">
										{t("privacy.export.expiredHint", "Download link expired")}
									</span>
								{:else}
									<span class="job-pending" aria-live="polite">
										{t("privacy.export.preparing", "Preparing…")}
									</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<!-- ── Restore (only while within the grace window) ──────────────────── -->
	{#if deleteResult}
		<section class="card card-restore ws-panel" aria-labelledby="privacy-restore-heading">
			<header class="card-head">
				<h2 id="privacy-restore-heading">{t("privacy.restore.heading", "Restore my account")}</h2>
				<p>
					{t(
						"privacy.restore.blurb",
						"Your account is scheduled for deletion but can still be restored until",
					)}
					<strong class="grace-until">{formatDate(deleteResult.deleteGraceUntil)}</strong>.
				</p>
			</header>
			<div class="card-actions">
				<button
					type="button"
					class="btn btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
					onclick={() => void onRestore()}
					disabled={restoring}
				>
					{restoring
						? t("privacy.restore.restoring", "Restoring…")
						: t("privacy.restore.button", "Restore my account")}
				</button>
			</div>
		</section>
	{/if}

	<!-- ── Delete my account ─────────────────────────────────────────────── -->
	{#if !deleteResult}
		<section class="card card-danger ws-panel" aria-labelledby="privacy-delete-heading">
			<header class="card-head">
				<h2 id="privacy-delete-heading">{t("privacy.delete.heading", "Delete my account")}</h2>
				<p>
					{t(
						"privacy.delete.blurb",
						"Closing your account signs you out everywhere and removes access immediately.",
					)}
				</p>
				<ul class="danger-points">
					<li>
						{t(
							"privacy.delete.point.grace",
							"We keep your data for a 30-day grace window in case you change your mind, then permanently erase it.",
						)}
					</li>
					<li>
						{t(
							"privacy.delete.point.sessions",
							"All active sessions are revoked — you'll need to restore your account before signing in again.",
						)}
					</li>
					<li>
						{t(
							"privacy.delete.point.permanent",
							"After the grace window, deletion is permanent and cannot be undone.",
						)}
					</li>
				</ul>
			</header>

			{#if !confirmOpen}
				<div class="card-actions">
					<button type="button" class="btn btn-danger ws-dialog-btn" onclick={openConfirm}>
						{t("privacy.delete.startButton", "Delete my account")}
					</button>
				</div>
			{:else}
				<div class="confirm-box" data-testid="delete-confirm">
					<label class="field">
						<span class="field-label">
							{t("privacy.delete.reasonLabel", "Reason for leaving (optional)")}
						</span>
						<textarea
							class="field-input"
							rows="2"
							maxlength="2000"
							bind:value={deleteReason}
							placeholder={t(
								"privacy.delete.reasonPlaceholder",
								"Help us improve — what made you leave?",
							)}
						></textarea>
					</label>

					<label class="field">
						<span class="field-label">
							{t("privacy.delete.confirmPrompt", "Type {word} to confirm").replace(
								"{word}",
								confirmWord,
							)}
						</span>
						<input
							class="field-input"
							type="text"
							autocomplete="off"
							bind:value={confirmText}
							aria-label={t("privacy.delete.confirmAria", "Type the confirmation word")}
						/>
					</label>

					<div class="confirm-actions">
						<button type="button" class="btn ws-dialog-btn ws-btn-ghost" onclick={cancelConfirm} disabled={deleting}>
							{t("common.cancel", "Cancel")}
						</button>
						<button
							type="button"
							class="btn btn-danger ws-dialog-btn"
							onclick={() => void onDeleteAccount()}
							disabled={!confirmArmed || deleting}
						>
							{deleting
								? t("privacy.delete.deleting", "Deleting…")
								: t("privacy.delete.confirmButton", "Permanently delete my account")}
						</button>
					</div>
				</div>
			{/if}
		</section>
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
		max-width: 640px;
	}
	.card {
		margin-bottom: 24px;
		border-radius: var(--radius-ws-card);
		padding: 22px 24px;
	}
	.card-danger {
		border-color: color-mix(in srgb, var(--color-ws-rose) 36%, var(--ws-hair));
		background: color-mix(in srgb, var(--color-ws-rose) 5%, var(--color-ws-surface));
	}
	.card-restore {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--ws-hair));
		background: color-mix(in srgb, var(--color-ws-accent) 9%, var(--color-ws-surface));
	}
	.card-head h2 {
		margin: 0 0 6px;
		font-size: 18px;
		font-weight: 800;
	}
	.card-head p {
		margin: 0;
		font-size: 13.5px;
		color: var(--color-ws-text);
		max-width: 620px;
	}
	.danger-points {
		margin: 14px 0 0;
		padding-left: 18px;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.55;
	}
	.danger-points li {
		margin-bottom: 4px;
	}
	.card-actions {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 18px;
	}
	.hint {
		font-size: 12.5px;
		color: var(--color-ws-text);
	}
	.btn {
		min-height: 38px;
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn-primary {
		border-color: transparent;
		color: var(--color-ws-ink);
	}
	.btn-danger {
		background: color-mix(in srgb, var(--color-ws-rose) 16%, var(--color-ws-surface));
		border-color: color-mix(in srgb, var(--color-ws-rose) 52%, var(--ws-hair));
		color: color-mix(in srgb, var(--color-ws-rose) 76%, var(--color-ws-ink));
	}
	.btn-danger:not(:disabled):hover {
		background: color-mix(in srgb, var(--color-ws-rose) 24%, var(--color-ws-surface));
	}
	.btn-small {
		min-height: 36px;
		padding: 0 12px;
		font-size: 12.5px;
	}
	.history {
		margin-top: 24px;
	}
	.history-title {
		font-size: 12.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-ws-text);
		margin: 0 0 12px;
	}
	.state-card {
		padding: 20px;
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-text);
		font-size: 13.5px;
	}
	.error-banner {
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
	.job-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-radius: var(--radius-ws-card);
		overflow: hidden;
	}
	.job-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		padding: 14px 16px;
		border-bottom: 1px solid var(--ws-hair);
	}
	.job-row:last-child {
		border-bottom: 0;
	}
	.job-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.job-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.job-date {
		font-size: 13px;
		color: var(--color-ws-ink);
	}
	.job-size {
		font-size: 11.5px;
		color: var(--color-ws-text);
	}
	.job-trail {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.job-expiry,
	.job-pending {
		font-size: 12px;
		color: var(--color-ws-text);
	}
	.job-failed {
		font-size: 12px;
		color: var(--color-ws-rose);
		max-width: 280px;
	}
	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 22px;
		padding: 0 10px;
		border-radius: 9999px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: var(--color-ws-surface2);
		color: var(--color-ws-text);
		white-space: nowrap;
	}
	.status-badge[data-status="ready"] {
		background: color-mix(in srgb, var(--color-ws-green) 16%, var(--color-ws-surface));
		color: var(--color-ws-green);
	}
	.status-badge[data-status="failed"],
	.status-badge[data-status="expired"] {
		background: color-mix(in srgb, var(--color-ws-rose) 16%, var(--color-ws-surface));
		color: var(--color-ws-rose);
	}
	.status-badge[data-status="processing"],
	.status-badge[data-status="queued"] {
		background: color-mix(in srgb, var(--color-ws-accent) 16%, var(--color-ws-surface));
		color: var(--color-ws-violet);
	}
	.grace-until {
		color: var(--color-ws-ink);
	}
	.confirm-box {
		margin-top: 18px;
		padding: 18px;
		border-radius: var(--radius-ws-card);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 42%, var(--ws-hair));
		background: color-mix(in srgb, var(--color-ws-rose) 7%, var(--color-ws-surface));
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--color-ws-ink);
	}
	.field-input {
		width: 100%;
		padding: 9px 12px;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair-strong);
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
		font-size: 13.5px;
		font-family: inherit;
		resize: vertical;
	}
	.field-input:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}
	.confirm-actions {
		display: flex;
		gap: 12px;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	@media (max-width: 520px) {
		.job-row {
			align-items: flex-start;
		}
	}
</style>
