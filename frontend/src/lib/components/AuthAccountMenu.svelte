<script lang="ts">
	import { onMount } from "svelte";
	import { invalidateAll, goto } from "$app/navigation";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { ssoStartUrl, type SsoProvider } from "$lib/api/client.ts";
	import SsoButtons from "$lib/components/auth/SsoButtons.svelte";
	import TurnstileWidget from "$lib/components/auth/TurnstileWidget.svelte";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import { config } from "$lib/config.ts";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	const SSO_PROVIDERS: readonly SsoProvider[] = ["google", "github", "line"];

	function isSsoProvider(value: string): value is SsoProvider {
		return (SSO_PROVIDERS as readonly string[]).includes(value);
	}

	type Mode = "choice" | "login" | "register";

	let open = $state(false);
	// The account trigger lives in the workspace header; the popover used to be an
	// `position:absolute; z-index:1300` child of `.account-menu`. On surfaces like
	// the dashboard, a sibling hero card (`position:relative` with `z-index`'d
	// children) creates a stacking context that paints OVER the popover, making
	// Logout + lower items unclickable (elementFromPoint returned the hero, not the
	// button). We now render the popover `position:fixed`, anchored to the
	// trigger's measured viewport rect, with a z-index above all workspace chrome —
	// so it escapes every surface's stacking context and is fully clickable
	// everywhere (dashboard AND library). `position:fixed` is positioned relative
	// to the viewport here because no header ancestor establishes a transform/
	// filter/will-change containing block (only backdrop-filter, which does not).
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let popoverPos = $state<{ top: number; right: number } | null>(null);

	function measurePopover(): void {
		if (typeof window === "undefined" || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		popoverPos = {
			top: rect.bottom + 8,
			// Right-align the popover to the trigger, expressed as a distance from
			// the viewport's right edge so it stays anchored on resize/scroll.
			right: Math.max(12, window.innerWidth - rect.right),
		};
	}

	$effect(() => {
		if (!open || typeof window === "undefined") return;
		measurePopover();
		const onReflow = () => measurePopover();
		window.addEventListener("resize", onReflow);
		// Capture-phase scroll catches scrolling in any nested container, so the
		// fixed popover tracks the trigger when the page or a panel scrolls.
		window.addEventListener("scroll", onReflow, true);
		return () => {
			window.removeEventListener("resize", onReflow);
			window.removeEventListener("scroll", onReflow, true);
		};
	});

	// Re-parent the popover layer to <body> so it escapes ANY ancestor that might
	// establish a stacking context OR a fixed-positioning containing block
	// (transform/filter/will-change/backdrop-filter on the header chain). Combined
	// with the viewport-anchored fixed coords above, this makes Logout reliably the
	// top-most element under the pointer on every surface. The moved node keeps its
	// Svelte scope-hash class, so the scoped styles below still apply.
	function portalToBody(node: HTMLElement) {
		if (typeof document === "undefined") return;
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}

	let mode = $state<Mode>("choice");
	let email = $state("");
	let password = $state("");
	let name = $state("");
	let busy = $state(false);
	let formError = $state<string | null>(null);
	let formErrorKey = $state<string | null>(null);
	let resendBusy = $state(false);
	let resendNotice = $state<string | null>(null);
	let resendNoticeKey = $state<string | null>(null);
	let turnstileToken = $state("");
	let turnstileRef = $state<{ reset: () => void } | null>(null);
	// When Turnstile is enabled this inline login/register must also supply a token, or the
	// backend 403s with bot_protection_failed — the same gate the dedicated auth pages use.
	const turnstileRequired = Boolean(config.turnstileSiteKey);

	// Clear any token solved for the previous mode on login↔register switch so it can't be
	// submitted as a wrong-action token (which the backend rejects). The {#key mode} block
	// remounts the widget with the new action. Runs only on mode change.
	$effect(() => {
		void mode;
		turnstileToken = "";
	});

	// Surface the verification banner when the signed-in user has not verified
	// their email yet, or when their initial verification email failed to send.
	let needsVerification = $derived(
		Boolean(authStore.user) && authStore.user?.emailVerified !== true
	);

	async function resendVerification(): Promise<void> {
		if (resendBusy) return;
		resendBusy = true;
		resendNotice = null;
		resendNoticeKey = null;
		try {
			if (turnstileRequired) {
				// Turnstile on: the menu has no widget to supply a token, so an inline resend
				// would 403. Send the user to /verify-email, which renders the widget + OTP entry.
				open = false;
				await goto("/verify-email");
				return;
			}
			// Turnstile off (the default): keep the one-click resend — no token needed.
			await authStore.resendVerification();
			resendNotice = msg("account.resendSent", "ส่งอีเมลยืนยันอีกครั้งแล้ว ตรวจสอบกล่องจดหมาย");
		} catch {
			resendNoticeKey = authStore.errorKey ?? "auth.errors.resendFailed";
		} finally {
			resendBusy = false;
		}
	}

	let linkPassword = $state("");
	let linkBusy = $state(false);
	let pendingSsoLink = $derived(authStore.pendingSsoLink);
	let formDisplayError = $derived(formErrorKey ? $_(formErrorKey) : formError);
	let resendNoticeText = $derived(resendNoticeKey ? $_(resendNoticeKey) : resendNotice);

	let roleLabel = $derived(authStore.role ? authStore.role[0].toUpperCase() + authStore.role.slice(1) : msg("account.roleFallback", "ผู้ใช้"));
	let accountMeta = $derived(
		authStore.status === "checking"
			? msg("account.statusChecking", "กำลังเช็ก")
			: authStore.user
				? authStore.user.name || authStore.user.email
				: msg("account.localWork", "งานบนเครื่องนี้")
	);

	onMount(() => {
		void authStore.init();
	});

	async function submitAuth(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		formError = null;
		formErrorKey = null;
		if (turnstileRequired && !turnstileToken) {
			formError = msg("account.turnstileRequired", "กรุณายืนยันว่าคุณไม่ใช่บอท");
			return;
		}
		busy = true;
		try {
			if (mode === "login") {
				await authStore.signIn(email, password, turnstileToken || undefined);
			} else {
				await authStore.register({ email, password, name: name.trim() || email.split("@")[0] || "Editor" }, turnstileToken || undefined);
			}
			password = "";
			open = false;
		} catch {
			formErrorKey = authStore.errorKey ?? (mode === "login" ? "auth.errors.loginFailed" : "auth.errors.registerFailed");
			// A single-use token is now spent; reset so the user can re-solve and retry.
			turnstileRef?.reset();
		} finally {
			busy = false;
		}
	}

	async function signOut(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await authStore.signOut();
			open = false;
			// The session token is now cleared, but SvelteKit does not re-run a
			// route's `load` just because a store changed. Re-run every `load`
			// (including the `(workspace)` route guard in `+layout.ts`) so a user
			// sitting on a guarded workspace route is bounced to `/login`
			// immediately instead of keeping the protected UI until the next
			// navigation/reload. On the unguarded legacy `/` shell this is a
			// harmless re-validation.
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	async function confirmSsoLink(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (linkBusy) return;
		linkBusy = true;
		try {
			const ok = await authStore.confirmPendingSsoLink(linkPassword || undefined);
			if (ok) {
				linkPassword = "";
				open = false;
			}
		} finally {
			linkBusy = false;
		}
	}

	function dismissSsoLink(): void {
		linkPassword = "";
		authStore.dismissPendingSsoLink();
	}

	// Begin the provider redirect so an SSO-only user can authenticate with their
	// existing provider in this tab before confirming the session-based link. The
	// pending link intent is persisted in the auth store, so it survives the
	// round-trip and the confirm step resumes on return.
	function startSsoSignIn(provider: string): void {
		if (typeof window === "undefined" || !isSsoProvider(provider)) return;
		window.location.href = ssoStartUrl(provider);
	}
</script>

{#if pendingSsoLink}
	<div class="sso-link-backdrop" role="presentation">
		<div
			class="sso-link-modal"
			role="dialog"
			aria-modal="true"
			aria-label={msg("account.ariaSsoLinkModal", "ยืนยันการเชื่อมบัญชี SSO")}
			aria-describedby="sso-link-sub"
			tabindex="-1"
			use:dialogFocus={{ onEscape: dismissSsoLink, busy: linkBusy }}
		>
			<header class="sso-link-head">
				<strong>{$_("account.ssoLinkTitle", { values: { provider: pendingSsoLink.provider.toUpperCase() } })}</strong>
				<small id="sso-link-sub">{$_("account.ssoLinkSub", { values: { email: pendingSsoLink.email, provider: pendingSsoLink.provider.toUpperCase() } })}</small>
			</header>
			<form class="auth-form" onsubmit={confirmSsoLink}>
				{#if pendingSsoLink.method === "password"}
					<label>
						<span>{msg("account.ssoLinkExistingPassword", "รหัสผ่านบัญชีเดิม")}</span>
						<input
							bind:value={linkPassword}
							type="password"
							autocomplete="current-password"
							required
							readonly={linkBusy}
						/>
					</label>
				{:else}
					<p class="sso-link-note">
						{msg("account.ssoLinkNote", "บัญชีนี้เข้าสู่ระบบด้วย SSO กรุณาเข้าสู่ระบบด้วยผู้ให้บริการเดิมในแท็บนี้ก่อน แล้วกดยืนยันเพื่อเชื่อมบัญชี")}
					</p>
					{#if isSsoProvider(pendingSsoLink.provider)}
						<button
							type="button"
							class="menu-action sso-start-button"
							onclick={() => startSsoSignIn(pendingSsoLink.provider)}
							disabled={linkBusy}
						>
							{$_("account.ssoLinkSignIn", { values: { provider: pendingSsoLink.provider.toUpperCase() } })}
						</button>
					{/if}
				{/if}
				{#if authStore.ssoLinkErrorKey}
					<p class="auth-error">{$_(authStore.ssoLinkErrorKey)}</p>
				{/if}
				<div class="sso-link-actions">
					{#if linkBusy}
						<span class="menu-action menu-action-receipt" aria-label={msg("account.ariaSsoLinkStatus", "สถานะการเชื่อมบัญชี")}>{msg("account.ssoLinking", "กำลังเชื่อมบัญชี")}</span>
					{:else}
						<button type="submit" class="menu-action">{msg("account.ssoLinkConfirm", "ยืนยันเชื่อมบัญชี")}</button>
					{/if}
					<button type="button" class="mode-switch" onclick={dismissSsoLink} disabled={linkBusy}>
						{msg("account.ssoLinkCancel", "ยกเลิก")}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<div class="account-menu">
	<button
		bind:this={triggerEl}
		type="button"
		class="account-trigger"
		class:active={open}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={$_("account.ariaTrigger", { values: { role: roleLabel, meta: accountMeta } })}
		onclick={() => open = !open}
	>
		<span class="account-mark">{authStore.role ? authStore.role.slice(0, 2).toUpperCase() : "ME"}</span>
		<span class="account-copy">
			<strong>{roleLabel}</strong>
			<small>{accountMeta}</small>
		</span>
	</button>

	{#if open}
		<div class="account-popover-layer" use:portalToBody>
		<button
			type="button"
			class="account-backdrop"
			aria-label={msg("account.ariaClose", "ปิดเมนูบัญชี")}
			onclick={() => open = false}
		></button>
		<div
			class="account-popover"
			role="menu"
			aria-label={msg("account.ariaMenu", "บัญชีและสิทธิ์")}
			style={popoverPos ? `top:${popoverPos.top}px;right:${popoverPos.right}px` : undefined}
		>
			{#if authStore.isAuthenticated && authStore.user}
				<header class="account-card">
					<span>{authStore.user.name}</span>
					<strong>{authStore.user.email}</strong>
					<small>{$_("account.permRole", { values: { role: roleLabel } })}</small>
				</header>
				{#if needsVerification}
					<div class="verify-banner" role="status">
						<div class="verify-copy">
							<strong>{msg("account.verifyTitle", "ยังไม่ได้ยืนยันอีเมล")}</strong>
							<small>
								{authStore.user?.verificationEmailSendFailed
									? msg("account.verifyFailedCopy", "อีเมลยืนยันส่งไม่สำเร็จ ส่งใหม่เพื่อปลดล็อกการสร้างเวิร์กสเปซ/โปรเจกต์")
									: msg("account.verifyCopy", "ยืนยันอีเมลเพื่อปลดล็อกการสร้างเวิร์กสเปซ/โปรเจกต์")}
							</small>
						</div>
						{#if resendBusy}
							<span class="menu-action menu-action-receipt" aria-label={msg("account.ariaResendStatus", "สถานะส่งอีเมลยืนยัน")}>
								{msg("account.resending", "กำลังส่ง")}
							</span>
						{:else}
							<button type="button" class="menu-action verify-action" onclick={resendVerification}>
								{msg("account.resendAction", "ส่งอีเมลยืนยันอีกครั้ง")}
							</button>
						{/if}
						{#if resendNoticeText}
							<p class="verify-notice">{resendNoticeText}</p>
						{/if}
					</div>
				{/if}
				<a
					class="menu-action menu-link"
					role="menuitem"
					href="/settings/profile"
					onclick={() => open = false}
				>
					{msg("account.editProfile", "Edit profile")}
				</a>
				{#if authStore.can("manage:settings")}
					<a
						class="menu-action menu-link"
						role="menuitem"
						href="/admin"
						onclick={() => open = false}
					>
						{msg("account.adminConsole", "Admin console")}
					</a>
				{/if}
				{#if busy}
					<span class="menu-action menu-action-receipt danger" aria-label={msg("account.ariaSignoutStatus", "สถานะออกจากระบบ")}>
						{msg("account.signingOut", "กำลังออกจากระบบ")}
					</span>
				{:else}
					<button type="button" class="menu-action danger" onclick={signOut}>
						{msg("account.signOut", "ออกจากระบบ")}
					</button>
				{/if}
				{:else}
					<header class="auth-intent-card">
						<strong>{mode === "register" ? msg("account.intentRegisterTitle", "สร้างเวิร์กสเปซ") : msg("account.intentLoginTitle", "ผูกบัญชีเพื่อซิงก์งาน")}</strong>
						<small>{mode === "register" ? msg("account.intentRegisterCopy", "ใช้บัญชีเดียวกับเวิร์กสเปซเพื่อเก็บงาน, เครดิต และสิทธิ์ทีม") : msg("account.intentLoginCopy", "งานบนเครื่องนี้ยังใช้งานต่อได้ บัญชีช่วยซิงก์งาน เครดิต และทีม")}</small>
					</header>
					{#if mode === "choice"}
						<div class="auth-choice-grid" aria-label={msg("account.ariaChoose", "เลือกวิธีเข้าใช้งาน")}>
							<button type="button" class="menu-action" onclick={() => mode = "login"}>
								{msg("account.signIn", "เข้าใช้งาน")}
							</button>
							<button type="button" class="mode-switch" onclick={() => mode = "register"}>
								{msg("account.createAccount", "สร้างบัญชี")}
							</button>
						</div>
						<SsoButtons mode="login" dividerLabel={msg("account.ssoDivider", "หรือเข้าใช้งานด้วย")} />
					{:else}
						<form class="auth-form" onsubmit={submitAuth}>
							{#if mode === "register"}
								<label>
									<span>{msg("account.displayName", "ชื่อที่แสดง")}</span>
									<input bind:value={name} autocomplete="name" readonly={busy} />
								</label>
							{/if}
							<label>
								<span>{msg("account.email", "อีเมล")}</span>
								<input bind:value={email} type="email" autocomplete="email" required readonly={busy} />
							</label>
							<label>
								<span>{msg("account.password", "รหัสผ่าน")}</span>
								<input
									bind:value={password}
									type="password"
									autocomplete={mode === "login" ? "current-password" : "new-password"}
									minlength="8"
									required
									readonly={busy}
								/>
							</label>
							{#if formDisplayError || authStore.errorKey}
								<p class="auth-error">{formDisplayError ?? (authStore.errorKey ? $_(authStore.errorKey) : "")}</p>
							{/if}
							{#key mode}
								<TurnstileWidget action={mode === "register" ? "auth_register" : "auth_login"} bind:token={turnstileToken} bind:this={turnstileRef} />
							{/key}
							{#if busy}
								<span class="menu-action menu-action-receipt" aria-label={msg("account.ariaFormStatus", "สถานะบัญชี")}>
									{msg("account.working", "กำลังทำงาน")}
								</span>
							{:else}
								<button type="submit" class="menu-action" disabled={turnstileRequired && !turnstileToken}>
									{mode === "login" ? msg("account.signIn", "เข้าใช้งาน") : msg("account.intentRegisterTitle", "สร้างเวิร์กสเปซ")}
								</button>
							{/if}
						</form>
						<button
							type="button"
							class="mode-switch"
							onclick={() => mode = mode === "login" ? "register" : "login"}
						>
							{mode === "login" ? msg("account.createAccount", "สร้างบัญชี") : msg("account.backToLogin", "กลับไปเข้าใช้งาน")}
						</button>
						{#if mode === "login"}
							<a class="auth-forgot-link" href="/forgot-password">{msg("account.forgotPassword", "ลืมรหัสผ่าน?")}</a>
						{/if}
					{/if}
				{/if}
		</div>
		</div>
	{/if}
</div>

<style>
	.account-menu {
		position: relative;
		display: inline-flex;
		flex: 0 0 auto;
	}

	.account-trigger {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 40px;
		max-width: 150px;
		padding: 4px 9px 4px 5px;
		border: 1px solid rgba(143, 184, 255, 0.16);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.035);
		color: var(--editor-text);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
	}

	.account-trigger:hover,
	.account-trigger.active {
		border-color: rgba(143, 184, 255, 0.34);
		background: rgba(76, 124, 198, 0.15);
	}

	.account-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 23px;
		height: 23px;
		border-radius: 6px;
		background: rgba(93, 210, 184, 0.16);
		color: #b7f4e8;
		font-size: 10px;
		font-weight: 900;
	}

	.account-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		line-height: 1;
	}

	.account-copy strong,
	.account-copy small {
		max-width: 92px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account-copy strong {
		font-size: 11px;
		font-weight: 850;
	}

	.account-copy small {
		color: var(--editor-text-muted);
		font-size: 9px;
		font-weight: 760;
	}

	.account-popover-layer {
		/* Portaled to <body>; a non-rendering wrapper whose fixed children
		   (backdrop + popover) position themselves against the viewport. */
		display: contents;
	}

	.account-popover {
		/* Fixed + viewport-anchored (top/right set inline from the trigger rect) so
		   the popover escapes every surface's stacking context and stays top-most.
		   Falls back to a sensible top-right anchor before the first measure. */
		position: fixed;
		top: 56px;
		right: 12px;
		z-index: 2147483000;
		display: grid;
		width: min(330px, calc(100vw - 24px));
		gap: 10px;
		padding: 10px;
		border: 1px solid rgba(143, 184, 255, 0.22);
		border-radius: 10px;
		background: #14171d;
		box-shadow: 0 20px 48px rgba(0, 0, 0, 0.42);
		isolation: isolate;
	}

	.account-backdrop {
		position: fixed;
		inset: 56px 0 0;
		z-index: 2147482999;
		min-width: 0;
		min-height: 0;
		padding: 0;
		border: 0;
		background: rgba(3, 6, 12, 0.42);
		backdrop-filter: blur(1.5px);
		cursor: default;
	}

	.account-card {
		display: grid;
		gap: 3px;
		padding: 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: #1b2029;
	}

	.account-card span,
	.account-card strong,
	.account-card small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account-card span {
		color: var(--editor-text);
		font-size: 12px;
		font-weight: 850;
	}

	.account-card strong {
		color: var(--editor-text-muted);
		font-size: 11px;
		font-weight: 760;
	}

	.account-card small {
		color: #9bc7ff;
		font-size: 10px;
		font-weight: 850;
		text-transform: uppercase;
	}

		.verify-banner {
			display: grid;
			gap: 8px;
			padding: 10px;
			border: 1px solid rgba(255, 196, 124, 0.3);
			border-radius: 8px;
			background: rgba(255, 196, 124, 0.08);
		}

		.verify-copy {
			display: grid;
			gap: 2px;
		}

		.verify-copy strong {
			color: #ffd9a8;
			font-size: 11px;
			font-weight: 900;
		}

		.verify-copy small {
			color: var(--editor-text-muted);
			font-size: 10px;
			font-weight: 720;
			line-height: 1.35;
		}

		.verify-action {
			border-color: rgba(255, 196, 124, 0.4);
			background: rgba(255, 196, 124, 0.14);
			color: #ffe6c7;
		}

		.verify-action:hover {
			background: rgba(255, 196, 124, 0.22);
		}

		.verify-notice {
			margin: 0;
			color: #cfe9d8;
			font-size: 10px;
			line-height: 1.35;
		}

		.auth-intent-card {
			display: grid;
			gap: 3px;
			padding: 10px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 8px;
			background: #181d25;
		}

		.auth-intent-card strong {
			color: var(--editor-text);
			font-size: 12px;
			font-weight: 850;
		}

		.auth-intent-card small {
			color: var(--editor-text-muted);
			font-size: 10px;
			font-weight: 720;
			line-height: 1.35;
		}

		.menu-action {
			min-height: 40px;
			border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--editor-text-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		font-weight: 850;
			letter-spacing: 0;
		}

		.auth-form {
			display: grid;
		gap: 8px;
	}

	.auth-choice-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.auth-form label {
		display: grid;
		gap: 4px;
	}

	.auth-form label span {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 850;
		text-transform: uppercase;
	}

	.auth-form input {
		min-width: 0;
		height: 40px;
		padding: 0 9px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 7px;
		background: #080b10;
		color: var(--editor-text);
		font: inherit;
		font-size: 12px;
	}

	.auth-form input:focus {
		border-color: rgba(143, 184, 255, 0.42);
		outline: none;
	}

	.auth-error {
		margin: 0;
		color: #ffb4a8;
		font-size: 11px;
		line-height: 1.35;
	}

	.menu-action {
		border-color: rgba(93, 210, 184, 0.28);
		background: rgba(93, 210, 184, 0.12);
		color: #d8fff8;
	}

	.menu-action:not(.menu-action-receipt):hover {
		background: rgba(93, 210, 184, 0.18);
	}

	.menu-action.danger {
		border-color: rgba(255, 139, 124, 0.28);
		background: rgba(255, 139, 124, 0.1);
		color: #ffd7d1;
	}

	.menu-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		text-decoration: none;
	}

	.menu-link:hover {
		background: rgba(93, 210, 184, 0.18);
	}

		.menu-action-receipt {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: default;
			opacity: 0.66;
		}

		.menu-action-receipt:hover {
			background: rgba(93, 210, 184, 0.12);
		}

		.menu-action-receipt.danger:hover {
			background: rgba(255, 139, 124, 0.1);
		}

		.auth-form input[readonly] {
			cursor: default;
			opacity: 0.72;
		}

		.mode-switch {
			min-height: 40px;
			border: 1px solid rgba(143, 184, 255, 0.16);
			border-radius: 6px;
			background: rgba(143, 184, 255, 0.06);
			color: var(--editor-text);
			cursor: pointer;
			font-family: inherit;
			font-size: 11px;
			font-weight: 850;
		}

		.mode-switch:hover {
			border-color: rgba(143, 184, 255, 0.34);
			background: rgba(143, 184, 255, 0.1);
		}

		.auth-forgot-link {
			justify-self: center;
			color: var(--editor-text-muted);
			font-size: 10px;
			font-weight: 760;
			text-decoration: underline;
		}

		.auth-forgot-link:hover {
			color: #9bc7ff;
		}

	.sso-link-backdrop {
		position: fixed;
		inset: 0;
		/* Above the account popover (which is now near the top of the stacking
		   range) so the SSO account-link consent modal always sits on top. */
		z-index: 2147483001;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgba(3, 6, 12, 0.62);
		backdrop-filter: blur(2px);
	}

	.sso-link-modal {
		display: grid;
		width: min(380px, calc(100vw - 32px));
		gap: 12px;
		padding: 16px;
		border: 1px solid rgba(143, 184, 255, 0.24);
		border-radius: 12px;
		background: #14171d;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
	}

	.sso-link-head {
		display: grid;
		gap: 4px;
	}

	.sso-link-head strong {
		color: var(--editor-text);
		font-size: 14px;
		font-weight: 850;
	}

	.sso-link-head small {
		color: var(--editor-text-muted);
		font-size: 11px;
		font-weight: 720;
		line-height: 1.4;
	}

	.sso-link-note {
		margin: 0;
		color: var(--editor-text-muted);
		font-size: 11px;
		line-height: 1.45;
	}

	.sso-link-actions {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px;
	}

	.sso-start-button {
		justify-self: stretch;
		text-align: center;
	}

	@media (max-width: 1180px) {
		.account-copy small {
			display: none;
		}

		.account-trigger {
			max-width: 88px;
			padding-right: 7px;
		}
	}
</style>
