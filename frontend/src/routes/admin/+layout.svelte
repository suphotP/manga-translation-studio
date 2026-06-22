<!--
Admin layout — auth gate + side nav, driven by GET /api/admin/me.

The gate is in the layout (not a load fn) so we can render a friendly
"signing you in" placeholder while we fetch the caller's back-office
permissions, and a clear "no access" panel when the user is signed in but the
backend grants them no admin:access. The nav is rendered PURELY from the
`sections` the backend returns, so the visible navigation always matches the
single server-side ROLE_PERMISSIONS map (no backend/frontend drift). The
backend remains authoritative on every route; this UI gating is
defense-in-depth.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { getAdminMe, setAdminApiToken, type AdminMe } from "$lib/api/admin.ts";

	let { children } = $props();

	let ready = $state(false);
	let me = $state<AdminMe | null>(null);
	let loadError = $state(false);

	function t(key: string, fallback: string, values?: Record<string, string | number>): string {
		const value = $_(key, values ? { values } : undefined);
		return value && value !== key ? value : fallback;
	}

	async function loadAdminMe() {
		loadError = false;
		try {
			me = await getAdminMe();
		} catch {
			// A 403 (no admin:access) or any failure means "no back-office access".
			me = null;
			loadError = true;
		}
	}

	onMount(async () => {
		await authStore.init();
		setAdminApiToken(authStore.accessToken);
		// Anonymous users go to the front door. We keep the intended path in the
		// query so the login form can bounce them back.
		if (!authStore.user) {
			ready = true;
			goto(`/?next=${encodeURIComponent(page.url.pathname)}`);
			return;
		}
		await loadAdminMe();
		ready = true;
	});

	// Keep the admin client in sync if the access token refreshes during a
	// long-lived admin session.
	$effect(() => {
		setAdminApiToken(authStore.accessToken);
	});

	// Nav comes straight from the backend's permission-filtered section list.
	const navItems = $derived(me?.sections ?? []);
	const hasAccess = $derived(Boolean(me?.permissions.includes("admin:access")));
	// Brand link goes to the first section the role can see (always Workspaces for
	// any back-office role today, but resilient if that changes).
	const homeHref = $derived(navItems[0]?.href ?? "/admin/workspaces");
</script>

<svelte:head>
	<title>Admin · Comic Workspace</title>
</svelte:head>

<div class="admin-shell">
	<aside class="admin-side">
		<a class="admin-brand" href={homeHref}>
			<span class="admin-brand-dot" aria-hidden="true"></span>
			<span class="admin-brand-text">
				<strong>Admin</strong>
				<small>Comic Workspace</small>
			</span>
		</a>
		<nav class="admin-nav" aria-label="Admin sections">
			{#each navItems as item (item.id)}
				<a
					class="admin-nav-link"
					href={item.href}
					data-active={page.url.pathname.startsWith(item.href)}
				>
					{item.label}
				</a>
			{/each}
		</nav>
		<footer class="admin-side-foot">
			<a href="/" class="admin-back-link">&larr; {t("adminLayout.backWorkspace", "Back to Workspace")}</a>
		</footer>
	</aside>

	<main class="admin-main">
		{#if !ready}
			<div class="admin-loading">{t("adminLayout.loadingPermissions", "Checking your admin permissions…")}</div>
		{:else if !authStore.user}
			<div class="admin-loading">{t("adminLayout.redirectingSignIn", "Taking you to sign in…")}</div>
		{:else if !hasAccess}
			<section class="admin-denied ws-panel">
				<strong>{t("adminLayout.deniedTitle", "This area is for back-office staff only.")}</strong>
				<p>
					{t("adminLayout.deniedBodyPrefix", "Account")} <code>{authStore.user.email}</code>
					{t("adminLayout.deniedBodyRole", " has role")} <code>{me?.role ?? authStore.role}</code>
					{t("adminLayout.deniedBodySuffix", " and cannot access /admin. Contact the Owner or an Admin for more access.")}
				</p>
				{#if loadError}
					<p class="admin-denied-hint">{t("adminLayout.deniedHint", "If you should have access, refresh or sign in again.")}</p>
				{/if}
				<a class="admin-link" href="/">{t("adminLayout.backHome", "Back home")}</a>
			</section>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<style>
	:global(body) {
		background: var(--color-ws-bg);
	}
	.admin-shell {
		display: grid;
		grid-template-columns: 248px 1fr;
		min-height: 100vh;
		color: color-mix(in srgb, var(--color-ws-ink) 86%, transparent);
	}
	.admin-side {
		background: var(--color-ws-surface);
		border-right: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		display: flex;
		flex-direction: column;
		padding: 18px 14px;
	}
	.admin-brand {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: inherit;
		margin-bottom: 18px;
		padding: 6px 8px;
	}
	.admin-brand-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-rose) 100%);
		display: inline-block;
	}
	.admin-brand-text {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}
	.admin-brand-text strong {
		font-size: 14px;
		color: var(--color-ws-ink);
	}
	.admin-brand-text small {
		font-size: 11px;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
	}
	.admin-nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.admin-nav-link {
		min-height: 36px;
		display: flex;
		align-items: center;
		padding: 9px 10px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 13px;
		text-decoration: none;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
		transition: background 0.14s ease, color 0.14s ease;
	}
	.admin-nav-link:hover {
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		color: var(--color-ws-ink);
	}
	.admin-nav-link[data-active="true"] {
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-accent) 18%, transparent), color-mix(in srgb, var(--color-ws-rose) 7%, transparent));
		color: var(--color-ws-ink);
	}
	.admin-side-foot {
		margin-top: auto;
		padding: 10px 8px;
	}
	.admin-back-link {
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		text-decoration: none;
	}
	.admin-back-link:hover {
		color: var(--color-ws-ink);
	}
	.admin-main {
		padding: 24px 28px;
		min-width: 0;
	}

	/* ── Mobile: the owner approves from their phone (owner-inbox is mobile-first).
	   The fixed 248px sidebar would crush the content on a narrow screen, so below
	   860px the shell stacks: the side rail becomes a compact horizontal top bar
	   with a scrollable nav, and the main column gets the full width. ── */
	@media (max-width: 860px) {
		.admin-shell {
			/* minmax(0, 1fr) lets the single column shrink below its content's
			   min-content width, so a wide child (long id / nav) scrolls inside its
			   own box instead of stretching the whole grid past the viewport. */
			grid-template-columns: minmax(0, 1fr);
		}
		.admin-side {
			border-right: none;
			border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
			padding: 10px 12px;
			gap: 8px;
		}
		.admin-brand {
			margin-bottom: 4px;
		}
		.admin-nav {
			flex-direction: row;
			flex-wrap: nowrap;
			overflow-x: auto;
			gap: 4px;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: none;
		}
		.admin-nav::-webkit-scrollbar { display: none; }
		.admin-nav-link {
			min-height: 36px;
			display: flex;
			align-items: center;
			white-space: nowrap;
			flex: 0 0 auto;
			padding: 8px 12px;
		}
		.admin-side-foot {
			display: none; /* the "back to workspace" link is redundant on mobile chrome */
		}
		.admin-main {
			padding: 16px 14px;
		}
	}
	.admin-loading {
		padding: 64px 0;
		text-align: center;
		color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent);
		font-size: 13px;
	}
	.admin-denied {
		max-width: 520px;
		margin: 64px auto;
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 24px 26px;
		text-align: left;
	}
	.admin-denied strong {
		color: var(--color-ws-ink);
		display: block;
		font-size: 15px;
		margin-bottom: 6px;
	}
	.admin-denied p {
		margin: 0 0 14px;
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
		font-size: 13px;
		line-height: 1.6;
	}
	.admin-denied code {
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		padding: 1px 6px;
		border-radius: 4px;
	}
	.admin-denied-hint {
		font-size: 12px;
		color: color-mix(in srgb, var(--color-ws-ink) 50%, transparent);
	}
	.admin-link {
		color: var(--color-ws-violet);
		text-decoration: none;
		font-size: 13px;
	}
</style>
