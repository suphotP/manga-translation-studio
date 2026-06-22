<!-- /settings/profile — account management (display name + password).
     The signed-in user can rename their account and change their password from
     here. Email is shown read-only (changing it needs a verified flow we don't
     expose yet — see PATCH /auth/me name-only). Every string is localised and
     every action has honest loading / success / error states. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { _, locale, setLocale } from "$lib/i18n";
	import { LANGUAGE_OPTIONS } from "$lib/i18n/languageOptions";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";

	// Localise via svelte-i18n with an explicit English fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// ── State ──────────────────────────────────────────────────────────────────
	let authReady = $state(false);

	// Display name.
	let displayName = $state("");
	let savingName = $state(false);
	let nameError = $state<string | null>(null);
	// The name as it stands on the server, so we can disable Save when unchanged.
	let serverName = $derived(authStore.user?.name ?? "");
	let nameDirty = $derived(displayName.trim() !== serverName && displayName.trim().length > 0);

	// Password.
	let currentPassword = $state("");
	let newPassword = $state("");
	let confirmPassword = $state("");
	let savingPassword = $state(false);
	let passwordError = $state<string | null>(null);

	let passwordTooShort = $derived(newPassword.length > 0 && newPassword.length < 8);
	let passwordMismatch = $derived(
		confirmPassword.length > 0 && newPassword !== confirmPassword,
	);
	let passwordFormValid = $derived(
		currentPassword.length > 0 &&
			newPassword.length >= 8 &&
			newPassword === confirmPassword,
	);

	let userEmail = $derived(authStore.user?.email ?? "");

	onMount(() => {
		// On a hard reload / direct link nothing else restores the session, so do
		// it here before reading the user (otherwise the form is empty).
		let cancelled = false;
		(async () => {
			await authStore.init();
			if (cancelled) return;
			authReady = true;
			displayName = authStore.user?.name ?? "";
		})();
		return () => {
			cancelled = true;
		};
	});

	async function onSaveName(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (savingName || !nameDirty) return;
		nameError = null;
		savingName = true;
		try {
			await authStore.updateDisplayName(displayName);
			// Reflect the canonical (trimmed) value the server stored.
			displayName = authStore.user?.name ?? displayName.trim();
			toastsStore.success({
				title: t("profile.name.savedTitle", "Display name updated"),
				body: t("profile.name.savedBody", "Your new name now shows across the workspace."),
			});
		} catch (error) {
			nameError =
				error instanceof Error
					? error.message
					: t("profile.name.error", "Couldn't update your name. Please try again.");
		} finally {
			savingName = false;
		}
	}

	async function onChangePassword(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (savingPassword || !passwordFormValid) return;
		passwordError = null;
		savingPassword = true;
		try {
			await authStore.changePassword(currentPassword, newPassword);
			currentPassword = "";
			newPassword = "";
			confirmPassword = "";
			toastsStore.success({
				title: t("profile.password.savedTitle", "Password changed"),
				body: t(
					"profile.password.savedBody",
					"Your password was updated. Other sessions have been signed out.",
				),
			});
		} catch (error) {
			passwordError =
				error instanceof Error
					? error.message
					: t("profile.password.error", "Couldn't change your password. Please try again.");
		} finally {
			savingPassword = false;
		}
	}
</script>

<svelte:head>
	<title>{t("profile.title", "Profile")} · Settings</title>
</svelte:head>

<div class="settings-page">
	<header class="settings-head">
		<p class="eyebrow">{t("profile.eyebrow", "Account · Settings")}</p>
		<h1>{t("profile.title", "Profile")}</h1>
		<p>
			{t(
				"profile.intro",
				"Manage how you appear across the workspace and keep your account secure.",
			)}
		</p>
	</header>

	{#if !authReady}
		<div class="state-card ws-panel-quiet" aria-busy="true">
			{t("profile.loading", "Loading your account…")}
		</div>
	{:else if !authStore.isAuthenticated}
		<div class="state-card ws-panel-quiet">
			{t("profile.signInRequired", "Sign in to manage your account.")}
		</div>
	{:else}
		<!-- ── Display name ─────────────────────────────────────────────── -->
		<section class="card ws-panel" aria-labelledby="profile-name-heading">
			<header class="card-head">
				<h2 id="profile-name-heading">{t("profile.name.heading", "Display name")}</h2>
				<p>
					{t(
						"profile.name.blurb",
						"This is the name teammates see in activity, comments and the account menu.",
					)}
				</p>
			</header>

			<form class="card-form" onsubmit={onSaveName}>
				<label class="field">
					<span class="field-label">{t("profile.name.label", "Display name")}</span>
					<input
						class="field-input"
						type="text"
						maxlength="200"
						autocomplete="name"
						bind:value={displayName}
						readonly={savingName}
						aria-invalid={nameError ? "true" : undefined}
						data-testid="display-name-input"
					/>
				</label>
				{#if nameError}
					<p class="field-error" role="alert">{nameError}</p>
				{/if}
				<div class="card-actions">
					<button
						type="submit"
						class="btn btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
						disabled={savingName || !nameDirty}
						data-testid="save-name"
					>
						{savingName
							? t("profile.name.saving", "Saving…")
							: t("profile.name.save", "Save name")}
					</button>
				</div>
			</form>
		</section>

		<!-- ── Email (read-only) ─────────────────────────────────────────── -->
		<section class="card ws-panel" aria-labelledby="profile-email-heading">
			<header class="card-head">
				<h2 id="profile-email-heading">{t("profile.email.heading", "Email")}</h2>
				<p>{t("profile.email.blurb", "Your sign-in address.")}</p>
			</header>
			<label class="field">
				<span class="field-label">{t("profile.email.label", "Email address")}</span>
				<input
					class="field-input"
					type="email"
					value={userEmail}
					readonly
					aria-readonly="true"
					data-testid="email-readonly"
				/>
			</label>
			<p class="field-note">
				{t(
					"profile.email.note",
					"Email changes aren't self-service yet — contact support if you need to change it.",
				)}
			</p>
		</section>

		<!-- ── Language ──────────────────────────────────────────────────── -->
		<!-- The UI language applies SITE-WIDE (every page localises through the same
		     svelte-i18n locale) and persists in localStorage across sessions. Names
		     are autonyms (each language in its own script) — not translatable copy. -->
		<section class="card ws-panel" aria-labelledby="profile-language-heading">
			<header class="card-head">
				<h2 id="profile-language-heading">{t("profile.language.heading", "Language")}</h2>
				<p>{t("profile.language.blurb", "Applies to the whole app, on every page.")}</p>
			</header>
			<div class="lang-options" role="radiogroup" aria-labelledby="profile-language-heading">
				{#each LANGUAGE_OPTIONS as lang (lang.code)}
					<button
						type="button"
						class="lang-option ws-btn-ghost"
						class:selected={$locale === lang.code}
						role="radio"
						aria-checked={$locale === lang.code}
						onclick={() => setLocale(lang.code)}
					>
						<span class="lang-flag" aria-hidden="true">{lang.flag}</span>
						<span class="lang-name">{lang.name}</span>
						{#if $locale === lang.code}<span class="lang-check" aria-hidden="true">✓</span>{/if}
					</button>
				{/each}
			</div>
		</section>

		<!-- ── Change password ───────────────────────────────────────────── -->
		<section class="card ws-panel" aria-labelledby="profile-password-heading">
			<header class="card-head">
				<h2 id="profile-password-heading">{t("profile.password.heading", "Change password")}</h2>
				<p>
					{t(
						"profile.password.blurb",
						"Enter your current password, then choose a new one. We'll sign out your other sessions.",
					)}
				</p>
			</header>

			<form class="card-form" onsubmit={onChangePassword}>
				<label class="field">
					<span class="field-label">{t("profile.password.current", "Current password")}</span>
					<input
						class="field-input"
						type="password"
						autocomplete="current-password"
						bind:value={currentPassword}
						readonly={savingPassword}
						data-testid="current-password"
					/>
				</label>

				<label class="field">
					<span class="field-label">{t("profile.password.new", "New password")}</span>
					<input
						class="field-input"
						type="password"
						autocomplete="new-password"
						minlength="8"
						bind:value={newPassword}
						readonly={savingPassword}
						aria-invalid={passwordTooShort ? "true" : undefined}
						data-testid="new-password"
					/>
					{#if passwordTooShort}
						<span class="field-hint-error">
							{t("profile.password.tooShort", "Use at least 8 characters.")}
						</span>
					{:else}
						<span class="field-hint">{t("profile.password.hint", "At least 8 characters.")}</span>
					{/if}
				</label>

				<label class="field">
					<span class="field-label">{t("profile.password.confirm", "Confirm new password")}</span>
					<input
						class="field-input"
						type="password"
						autocomplete="new-password"
						bind:value={confirmPassword}
						readonly={savingPassword}
						aria-invalid={passwordMismatch ? "true" : undefined}
						data-testid="confirm-password"
					/>
					{#if passwordMismatch}
						<span class="field-hint-error">
							{t("profile.password.mismatch", "Passwords don't match.")}
						</span>
					{/if}
				</label>

				{#if passwordError}
					<p class="field-error" role="alert">{passwordError}</p>
				{/if}

				<div class="card-actions">
					<button
						type="submit"
						class="btn btn-primary ws-dialog-btn ws-dialog-btn-primary ws-grad-primary"
						disabled={savingPassword || !passwordFormValid}
						data-testid="save-password"
					>
						{savingPassword
							? t("profile.password.saving", "Changing…")
							: t("profile.password.save", "Change password")}
					</button>
				</div>
			</form>
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
	.card-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-top: 18px;
		max-width: 420px;
	}
	.card-actions {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field-label {
		font-size: 12.5px;
		font-weight: 700;
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
	}
	.field-input:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}
	.field-input[readonly] {
		opacity: 0.72;
		cursor: default;
	}
	.field-input[aria-invalid="true"] {
		border-color: color-mix(in srgb, var(--color-ws-rose) 70%, var(--ws-hair-strong));
	}
	.field-hint {
		font-size: 11.5px;
		color: var(--color-ws-text);
	}
	.field-hint-error {
		font-size: 11.5px;
		color: var(--color-ws-rose);
	}
	.field-note {
		margin: 12px 0 0;
		font-size: 12px;
		color: var(--color-ws-text);
		max-width: 420px;
	}
	.field-error {
		margin: 0;
		font-size: 12.5px;
		color: var(--color-ws-rose);
	}
	.state-card {
		padding: 20px;
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-text);
		font-size: 13.5px;
	}
	.btn {
		min-height: 38px;
		color: var(--color-ws-ink);
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn-primary {
		border-color: transparent;
		color: var(--color-ws-ink);
	}

	/* ── Language card ── */
	.lang-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.lang-option {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.9rem;
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.lang-option:hover {
		border-color: var(--ws-hair-strong);
	}
	.lang-option.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 54%, var(--ws-hair-strong));
		background: color-mix(in srgb, var(--color-ws-accent) 16%, var(--color-ws-surface));
	}
	.lang-flag {
		font-size: 1.1rem;
	}
	.lang-check {
		font-weight: 700;
		color: var(--color-ws-violet);
	}
</style>
