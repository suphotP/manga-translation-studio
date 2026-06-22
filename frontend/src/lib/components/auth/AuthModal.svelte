<!-- AuthModal — in-context login / register / forgot-password overlay (W-auth-modal).

	A single polished modal with a segmented mode switch so users can sign in,
	create an account, or request a password reset WITHOUT a full page navigation
	to the (auth) routes (which stay intact as the canonical deep-link path).

	Built on the shared `Dialog` atom, so it inherits the house a11y chrome:
	role="dialog" + aria-modal, focus-trap on Tab/Shift+Tab, Escape to close,
	inert/aria-hidden background, backdrop-click + focus restore to the opener.
	On a narrow viewport it presents as a full-screen sheet (see `.auth-modal-*`).

	Reuses the existing session logic via `authStore` (login / signup / forgot
	password) and the existing form atoms (`SsoButtons`, `PasswordStrengthMeter`,
	`auth-shared.css`, `evaluatePassword`) — it does NOT own auth state itself, so
	a successful flow lights up the app's already-authenticated session. -->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import SsoButtons from "$lib/components/auth/SsoButtons.svelte";
	import TurnstileWidget from "$lib/components/auth/TurnstileWidget.svelte";
	import PasswordStrengthMeter from "$lib/components/auth/PasswordStrengthMeter.svelte";
	import { _ } from "$lib/i18n";
	import { evaluatePassword } from "$lib/auth/password-policy.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { authUiStore, type AuthModalMode } from "$lib/stores/auth-ui.svelte.ts";
	import { config } from "$lib/config.ts";
	// Load the shared auth atom styles globally (unscoped). Importing them via a
	// scoped style @import would scope these shared classes to this component and
	// make Svelte flag the atoms only used by sub-states as "unused"; a JS import
	// keeps them global with no behavior change (same pattern as the signup route).
	import "$lib/components/auth/auth-shared.css";

	const recoveryEnabled = config.authRecoveryEnabled;

	// Localize via svelte-i18n with an explicit Thai fallback so TH (the default
	// locale) is unchanged and other locales resolve their translation.
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// Mode mirrors the store so external triggers can deep-link to a tab; we still
	// own the live field state locally.
	let mode = $derived(authUiStore.mode);

	// Shared field state. `email` is intentionally NOT reset on mode switch so a
	// typed address carries between Sign in / Create account / Forgot password.
	let email = $state("");
	let name = $state("");
	let password = $state("");
	let confirm = $state("");
	let agreed = $state(false);
	let showPassword = $state(false);

	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let turnstileToken = $state("");
	let turnstileRef = $state<{ reset: () => void } | null>(null);
	const turnstileRequired = Boolean(config.turnstileSiteKey);
	const EMAIL_MAX_LENGTH = 254;
	const NAME_MAX_LENGTH = 200;

	// {#key mode} remounts the widget with a different action on login↔register switch.
	// Clear any token solved for the previous mode so it can't be submitted as a
	// wrong-action token (which the backend 403s). Runs only on mode change.
	$effect(() => {
		void mode;
		turnstileToken = "";
	});
	// Forgot-password confirmation (kept generic to avoid account enumeration).
	let forgotSubmitted = $state(false);

	let mismatch = $derived(confirm.length > 0 && confirm !== password);
	let passwordPolicy = $derived(evaluatePassword(password));
	let nameOk = $derived(name.trim().length > 0 && name.length <= NAME_MAX_LENGTH);
	let emailTooLong = $derived(email.length > EMAIL_MAX_LENGTH);
	let nameTooLong = $derived(name.length > NAME_MAX_LENGTH);
	let emailOk = $derived(!emailTooLong && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
	let passwordOk = $derived(passwordPolicy.valid);
	let confirmOk = $derived(confirm.length > 0 && confirm === password);
	let displayError = $derived(formErrorKey ? $_(formErrorKey) : formError);

	// The forgot-password confirmation embeds the (user-controlled) email; split
	// the localized string on the {email} token so the email renders as a bold
	// *text* node (never HTML), with the rest of the copy localized.
	let forgotSentParts = $derived(
		msg(
			"auth.forgotSentTo",
			"ถ้ามีบัญชีที่ผูกกับ {email} เราจะส่งลิงก์รีเซ็ตรหัสผ่านไปให้ภายในไม่กี่นาที",
		).split("{email}"),
	);

	// Tab definitions carry the i18n key only; labels are resolved reactively in
	// the template via msg() so they re-localize on locale change. The Thai
	// default still applies because `auth.tab*` exists in th.json and th is the
	// i18n fallbackLocale.
	const TABS: ReadonlyArray<{ id: AuthModalMode; key: string }> = recoveryEnabled
		? [
			{ id: "login", key: "auth.tabLogin" },
			{ id: "register", key: "auth.tabRegister" },
			{ id: "forgot", key: "auth.tabForgot" },
		]
		: [
			{ id: "login", key: "auth.tabLogin" },
			{ id: "register", key: "auth.tabRegister" },
		];

	let head = $derived.by(() => {
		const HEAD: Record<AuthModalMode, { title: string; subtitle: string; cta: string; busyCta: string }> = {
			login: {
				title: msg("auth.loginTitle", "เข้าใช้งาน"),
				subtitle: msg("auth.loginSubtitle", "ใช้บัญชีเดียวกับทีมเพื่อซิงก์งาน เครดิต และสิทธิ์เข้าถึง"),
				cta: msg("auth.loginCta", "เข้าใช้งาน"),
				busyCta: msg("auth.loginBusyCta", "กำลังเข้าใช้งาน"),
			},
			register: {
				title: msg("auth.registerTitle", "สร้างบัญชี"),
				subtitle: msg("auth.registerSubtitle", "ใช้บัญชีเดียวกันกับทีมเพื่อซิงก์งาน คอมเมนต์ และเครดิต AI"),
				cta: msg("auth.registerCta", "สร้างบัญชี"),
				busyCta: msg("auth.registerBusyCta", "กำลังสร้างบัญชี"),
			},
			forgot: {
				title: msg("auth.forgotTitle", "ลืมรหัสผ่าน"),
				subtitle: msg("auth.forgotSubtitle", "ใส่อีเมลของบัญชี เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้"),
				cta: msg("auth.forgotCta", "ส่งลิงก์รีเซ็ต"),
				busyCta: msg("auth.forgotBusyCta", "กำลังส่งคำขอ"),
			},
		};
		return HEAD[mode];
	});

	function switchMode(next: AuthModalMode): void {
		if (busy || next === mode) return;
		authUiStore.setMode(next);
		// Reset transient state but keep `email` so the typed address carries over.
		formError = null;
		formErrorKey = null;
		forgotSubmitted = false;
		password = "";
		confirm = "";
	}

	// Roving-tabindex arrow navigation for the WAI-ARIA tablist: only the active
	// tab is in the tab order; Left/Right (and Home/End) move + activate the
	// neighbour and focus it.
	function handleTablistKeydown(event: KeyboardEvent): void {
		if (busy) return;
		const currentIndex = TABS.findIndex((tab) => tab.id === mode);
		if (currentIndex < 0) return;
		let nextIndex = currentIndex;
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown":
				nextIndex = (currentIndex + 1) % TABS.length;
				break;
			case "ArrowLeft":
			case "ArrowUp":
				nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = TABS.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const next = TABS[nextIndex];
		switchMode(next.id);
		const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
		tabs[nextIndex]?.focus();
	}

	function close(): void {
		if (busy) return;
		resetFields();
		authUiStore.close();
	}

	function resetFields(): void {
		// Drop secrets + transient UI; keep nothing sensitive mounted after close.
		password = "";
		confirm = "";
		name = "";
		agreed = false;
		showPassword = false;
		busy = false;
		formError = null;
		formErrorKey = null;
		forgotSubmitted = false;
	}

	function handleAuthenticatedSuccess(): void {
		const cb = authUiStore.onAuthenticated;
		resetFields();
		authUiStore.close();
		cb?.();
	}

	async function handleLogin(): Promise<void> {
		if (emailTooLong) {
			formError = $_("auth.emailTooLong");
			return;
		}
		if (turnstileRequired && !turnstileToken) {
			formError = msg("auth.turnstileRequired", "กรุณายืนยันว่าคุณไม่ใช่บอท");
			return;
		}
		busy = true;
		try {
			await authStore.login(email.trim(), password, turnstileToken || undefined);
			handleAuthenticatedSuccess();
		} catch {
			formErrorKey = authStore.errorKey ?? "auth.errors.loginFailed";
			turnstileRef?.reset();
		} finally {
			busy = false;
		}
	}

	async function handleRegister(): Promise<void> {
		if (emailTooLong) {
			formError = $_("auth.emailTooLong");
			return;
		}
		if (nameTooLong) {
			formError = $_("auth.nameTooLong");
			return;
		}
		const policy = evaluatePassword(password);
		if (!policy.valid) {
			formError = policy.firstUnmetRuleId
				? $_("passwordPolicy.firstError", { values: { rule: $_(`passwordPolicy.rule_${policy.firstUnmetRuleId}`, { values: { n: policy.firstUnmetRuleId === "maxlength" ? policy.maxLength : policy.minLength } }) } })
				: msg("auth.passwordWeak", "รหัสผ่านยังไม่ผ่านเงื่อนไขความปลอดภัย");
			return;
		}
		if (password !== confirm) {
			formError = msg("auth.passwordMismatch", "รหัสผ่านยืนยันไม่ตรงกัน");
			return;
		}
		if (!agreed) {
			formError = msg("auth.mustAgree", "กรุณายอมรับเงื่อนไขการใช้งานก่อนสร้างบัญชี");
			return;
		}
		if (turnstileRequired && !turnstileToken) {
			formError = msg("auth.turnstileRequired", "กรุณายืนยันว่าคุณไม่ใช่บอท");
			return;
		}

		busy = true;
		try {
			// authStore.signup registers AND sets the session (auto sign-in), matching
			// the (auth)/signup route behaviour.
			await authStore.signup({ email: email.trim(), password, name: name.trim(), turnstileToken: turnstileToken || undefined });
			handleAuthenticatedSuccess();
		} catch {
			formErrorKey = authStore.errorKey ?? "auth.errors.registerFailed";
			turnstileRef?.reset();
		} finally {
			busy = false;
		}
	}

	async function handleForgot(): Promise<void> {
		if (emailTooLong) {
			formError = $_("auth.emailTooLong");
			return;
		}
		busy = true;
		try {
			await authStore.forgotPassword(email.trim());
			forgotSubmitted = true;
		} catch {
			// Always show the generic confirmation (no account enumeration) but keep
			// an inline alert so a real server failure is still visible.
			forgotSubmitted = true;
			formErrorKey = authStore.errorKey ?? "auth.errors.forgotFailed";
		} finally {
			busy = false;
		}
	}

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		if (mode === "login") await handleLogin();
		else if (mode === "register") await handleRegister();
		else await handleForgot();
	}
</script>

<Dialog
	open={authUiStore.open}
	onClose={close}
	size="sm"
	busy={busy}
	autoFocus={false}
	panelClass="auth-modal-panel"
	ariaLabelledby="auth-modal-title"
	ariaDescribedby="auth-modal-desc"
>
	{#snippet header()}
		<header class="auth-modal-head">
			<div class="auth-modal-brand">
				<span class="auth-modal-mark" aria-hidden="true">CW</span>
				<span class="auth-modal-eyebrow">Comic Workspace</span>
			</div>
			<h2 id="auth-modal-title" class="auth-modal-title">{head.title}</h2>
			<p id="auth-modal-desc" class="auth-modal-subtitle">{head.subtitle}</p>

			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="auth-modal-tabs" role="tablist" aria-label={msg("auth.ariaTablist", "โหมดบัญชี")} tabindex="-1" onkeydown={handleTablistKeydown}>
				{#each TABS as tab (tab.id)}
					<button
						type="button"
						role="tab"
						class="auth-modal-tab"
						class:active={mode === tab.id}
						aria-selected={mode === tab.id}
						tabindex={mode === tab.id ? 0 : -1}
						disabled={busy}
						onclick={() => switchMode(tab.id)}
					>
						{msg(tab.key, tab.key)}
					</button>
				{/each}
			</div>
		</header>
	{/snippet}

	{#if mode === "forgot"}
		{#if !recoveryEnabled}
			<div class="auth-form">
				<div class="auth-alert auth-alert-info" role="status">
					{msg("auth.recoveryDisabled", "การรีเซ็ตรหัสผ่านด้วยตัวเองยังไม่เปิดให้บริการในตอนนี้ หากเข้าใช้งานไม่ได้ กรุณาติดต่อผู้ดูแลทีมเพื่อรีเซ็ตให้")}
				</div>
				<button type="button" class="auth-action-link" onclick={() => switchMode("login")}>
					{msg("auth.backToLogin", "กลับไปหน้าเข้าใช้งาน")}
				</button>
			</div>
		{:else if forgotSubmitted}
			<div class="auth-form">
				<div class="auth-alert auth-alert-success" role="status">
					{forgotSentParts[0]}<strong>{email}</strong>{forgotSentParts[1] ?? ""}
				</div>
				{#if displayError}
					<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
				{/if}
				<p class="auth-field-help">
					{msg("auth.checkSpam", "ไม่เห็นอีเมล? ลองเช็กโฟลเดอร์ spam หรือลองส่งอีกครั้งภายใน 1 นาที")}
				</p>
				<div class="auth-row">
					<button type="button" class="auth-action-link" onclick={() => switchMode("login")}>
						{msg("auth.backToLogin", "กลับไปหน้าเข้าใช้งาน")}
					</button>
					<button
						type="button"
						class="auth-action-link"
						onclick={() => { forgotSubmitted = false; formError = null; formErrorKey = null; }}
					>
						{msg("auth.resend", "ส่งอีกครั้ง")}
					</button>
				</div>
			</div>
		{:else}
			<form class="auth-form" onsubmit={handleSubmit} novalidate>
				{#if displayError}
					<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
				{/if}
				<p class="auth-field-help">{msg("auth.forgotHelp", "กรอกอีเมลของบัญชี เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้")}</p>

				<label class="auth-field" for="auth-modal-forgot-email">
					<span class="auth-field-label">{msg("auth.email", "อีเมล")}</span>
					<div class="auth-field-control">
						<input
							class="auth-input"
							id="auth-modal-forgot-email"
							type="email"
							autocomplete="email"
							maxlength={EMAIL_MAX_LENGTH}
							required
							bind:value={email}
							disabled={busy}
						/>
					</div>
				</label>

				<button type="submit" class="auth-submit" disabled={busy || email.trim().length === 0}>
					{#if busy}
						<span class="auth-submit-spinner" aria-hidden="true"></span>
						{head.busyCta}
					{:else}
						{head.cta}
					{/if}
				</button>
			</form>
		{/if}
	{:else}
		<form class="auth-form" onsubmit={handleSubmit} novalidate>
			{#if displayError}
				<div class="auth-alert auth-alert-error" role="alert">{displayError}</div>
			{/if}

			{#if mode === "register"}
				<label class="auth-field" for="auth-modal-name">
					<span class="auth-field-label">{msg("auth.displayName", "ชื่อที่จะแสดงในทีม")} <span class="auth-required" class:auth-required-ok={nameOk} aria-hidden="true">{nameOk ? "✓" : "*"}</span></span>
					<div class="auth-field-control">
						<input
							class="auth-input"
							id="auth-modal-name"
							type="text"
							autocomplete="name"
							aria-label={msg("auth.displayName", "ชื่อที่จะแสดงในทีม")}
							placeholder={msg("auth.namePlaceholder", "ไม่ระบุก็ได้ — ใช้ส่วนต้น email")}
							maxlength={NAME_MAX_LENGTH}
							required
							aria-invalid={nameTooLong}
							bind:value={name}
							disabled={busy}
						/>
					</div>
					{#if nameTooLong}
						<span class="auth-field-error">{$_("auth.nameTooLong")}</span>
					{/if}
				</label>
			{/if}

			<label class="auth-field" for="auth-modal-email">
				<span class="auth-field-label">{msg("auth.email", "อีเมล")} <span class="auth-required" class:auth-required-ok={emailOk} aria-hidden="true">{emailOk ? "✓" : "*"}</span></span>
				<div class="auth-field-control">
					<input
						class="auth-input"
						id="auth-modal-email"
						type="email"
						autocomplete="email"
						aria-label={msg("auth.email", "อีเมล")}
						maxlength={EMAIL_MAX_LENGTH}
						required
						aria-invalid={emailTooLong}
						bind:value={email}
						disabled={busy}
					/>
				</div>
				{#if emailTooLong}
					<span class="auth-field-error">{$_("auth.emailTooLong")}</span>
				{/if}
			</label>

			<label class="auth-field" for="auth-modal-password">
				<span class="auth-field-label">{msg("auth.password", "รหัสผ่าน")} {#if mode === "register"}<span class="auth-required" class:auth-required-ok={passwordOk} aria-hidden="true">{passwordOk ? "✓" : "*"}</span>{/if}</span>
				<div class="auth-field-control">
					<input
						class="auth-input"
						id="auth-modal-password"
						type={showPassword ? "text" : "password"}
						autocomplete={mode === "login" ? "current-password" : "new-password"}
						aria-label={msg("auth.password", "รหัสผ่าน")}
						minlength="8"
								required
						bind:value={password}
						disabled={busy}
					/>
					<button
						type="button"
						class="auth-field-suffix"
						aria-pressed={showPassword}
						aria-label={showPassword ? msg("auth.hidePassword", "ซ่อนรหัสผ่าน") : msg("auth.showPassword", "แสดงรหัสผ่าน")}
						onclick={() => (showPassword = !showPassword)}
						tabindex="-1"
					>
						{showPassword ? msg("auth.hide", "ซ่อน") : msg("auth.show", "แสดง")}
					</button>
				</div>
				{#if mode === "register"}
					<PasswordStrengthMeter {password} />
				{/if}
			</label>

			{#if mode === "register"}
				<label class="auth-field" for="auth-modal-confirm">
					<span class="auth-field-label">{msg("auth.confirmPassword", "ยืนยันรหัสผ่าน")} <span class="auth-required" class:auth-required-ok={confirmOk} aria-hidden="true">{confirmOk ? "✓" : "*"}</span></span>
					<div class="auth-field-control">
						<input
							class="auth-input"
							id="auth-modal-confirm"
							type={showPassword ? "text" : "password"}
							autocomplete="new-password"
							aria-label={msg("auth.confirmPassword", "ยืนยันรหัสผ่าน")}
							minlength="8"
										required
							aria-invalid={mismatch}
							bind:value={confirm}
							disabled={busy}
						/>
					</div>
					{#if mismatch}
						<span class="auth-field-error">{msg("auth.passwordMismatch", "รหัสผ่านยืนยันไม่ตรงกัน")}</span>
					{/if}
				</label>

				<label class="auth-check">
					<input type="checkbox" bind:checked={agreed} disabled={busy} />
					<span>
						{msg("auth.agreePrefix", "ยอมรับ")}
						<a href="/terms" target="_blank" rel="noopener">{msg("auth.termsLink", "เงื่อนไขการใช้งาน")}</a>
						{msg("auth.agreeAnd", "และ")}
						<a href="/privacy" target="_blank" rel="noopener">{msg("auth.privacyLink", "นโยบายความเป็นส่วนตัว")}</a>
					</span>
				</label>
			{/if}

			{#if mode === "login"}
				<div class="auth-row">
					{#if recoveryEnabled}
						<button type="button" class="auth-link-btn" onclick={() => switchMode("forgot")}>
							{msg("auth.forgotPasswordLink", "ลืมรหัสผ่าน?")}
						</button>
					{:else}
						<span></span>
					{/if}
					<button type="button" class="auth-link-btn" onclick={() => switchMode("register")}>
						{msg("auth.createAccount", "สร้างบัญชี")}
					</button>
				</div>
			{/if}

			{#key mode}
				<TurnstileWidget action={mode === "register" ? "auth_register" : "auth_login"} bind:token={turnstileToken} bind:this={turnstileRef} />
			{/key}

			<button type="submit" class="auth-submit" disabled={busy || (turnstileRequired && !turnstileToken)}>
				{#if busy}
					<span class="auth-submit-spinner" aria-hidden="true"></span>
					{head.busyCta}
				{:else}
					{head.cta}
				{/if}
			</button>

			<SsoButtons
				mode={mode === "register" ? "register" : "login"}
				disabled={busy}
				dividerLabel={mode === "register" ? msg("auth.ssoDividerRegister", "หรือสมัครด้วย") : msg("auth.ssoDividerLogin", "หรือเข้าใช้งานด้วย")}
			/>

			<div class="auth-row auth-row-foot">
				{#if mode === "login"}
					<span>{msg("auth.noAccount", "ยังไม่มีบัญชี?")}</span>
					<button type="button" class="auth-link-btn" onclick={() => switchMode("register")}>
						{msg("auth.createFree", "สร้างบัญชีฟรี")}
					</button>
				{:else}
					<span>{msg("auth.hasAccount", "มีบัญชีอยู่แล้ว?")}</span>
					<button type="button" class="auth-link-btn" onclick={() => switchMode("login")}>
						{msg("auth.signIn", "เข้าใช้งาน")}
					</button>
				{/if}
			</div>
		</form>
	{/if}
</Dialog>

<style>
	/* Header chrome: own brand, title, subtitle, and the segmented mode switch. */
	:global(.auth-modal-panel) {
		--ws-dialog-w: min(440px, calc(100vw - 32px));
	}

	.auth-modal-head {
		display: grid;
		gap: 8px;
		padding: 20px 56px 14px 20px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.auth-modal-brand {
		display: inline-flex;
		align-items: center;
		gap: 9px;
	}

	.auth-modal-mark {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: calc(var(--radius-ws-ctrl) - 4px);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 900;
	}

	.auth-modal-eyebrow {
		color: var(--color-ws-faint);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.02em;
	}

	.auth-modal-title {
		margin: 2px 0 0;
		color: var(--color-ws-ink);
		font-size: 21px;
		font-weight: 800;
		letter-spacing: -0.01em;
		line-height: 1.15;
	}

	.auth-modal-subtitle {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.5;
	}

	.auth-modal-tabs {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 4px;
		margin-top: 8px;
		padding: 4px;
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 52%, transparent);
		border: 1px solid var(--ws-hair);
	}

	.auth-modal-tab {
		min-height: 36px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		color: var(--color-ws-text);
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 800;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease;
	}

	.auth-modal-tab:hover:not(:disabled):not(.active) {
		color: var(--color-ws-ink);
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, transparent);
	}

	.auth-modal-tab.active {
		color: var(--color-ws-ink);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		box-shadow: 0 12px 28px -20px color-mix(in srgb, var(--color-ws-accent) 86%, transparent);
	}

	.auth-modal-tab:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* In-flow text-link buttons (forgot / switch-mode), styled like `.auth-row a`
	   so they read as links but stay real buttons (no navigation). */
	.auth-link-btn {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-ws-text);
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 700;
		cursor: pointer;
		border-bottom: 1px dashed color-mix(in srgb, var(--color-ws-line) 24%, transparent);
		line-height: 1.3;
	}

	.auth-link-btn:hover {
		color: var(--color-ws-ink);
		border-bottom-color: var(--color-ws-accent);
	}

	.auth-row-foot {
		justify-content: center;
		gap: 6px;
		color: var(--color-ws-text);
	}

	/* Mobile: present as a bottom-anchored full-width sheet rather than a tiny
	   centred card. Targets the Dialog atom's panel via the passed panelClass. */
	@media (max-width: 540px) {
		:global(.ws-dialog-panel.auth-modal-panel) {
			top: auto;
			bottom: 0;
			left: 0;
			right: 0;
			width: 100%;
			max-width: 100%;
			max-height: 94vh;
			transform: none;
			border-radius: var(--radius-ws-card) var(--radius-ws-card) 0 0;
		}

		.auth-modal-head {
			padding: 18px 52px 12px 18px;
		}

		.auth-modal-title {
			font-size: 19px;
		}
	}

	/* Light-theme parity with the rest of the auth surfaces. */
	:global(html[data-theme="light"]) .auth-modal-head {
		border-bottom-color: color-mix(in srgb, var(--color-ws-bg) 10%, transparent);
	}
	:global(html[data-theme="light"]) .auth-modal-title { color: var(--color-ws-bg); }
	:global(html[data-theme="light"]) .auth-modal-subtitle { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .auth-modal-eyebrow { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .auth-modal-tabs {
		background: color-mix(in srgb, var(--color-ws-bg) 5%, transparent);
		border-color: color-mix(in srgb, var(--color-ws-bg) 10%, transparent);
	}
	:global(html[data-theme="light"]) .auth-modal-tab { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .auth-modal-tab:hover:not(:disabled):not(.active) {
		color: var(--color-ws-bg);
		background: color-mix(in srgb, var(--color-ws-bg) 5%, transparent);
	}
	:global(html[data-theme="light"]) .auth-link-btn { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
</style>
