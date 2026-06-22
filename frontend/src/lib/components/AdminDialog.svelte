<!-- AdminDialog — settings modal, pure UI. ws design system + shared Dialog atom (W3.4). -->
<script lang="ts">
	import { adminStore } from "$lib/stores/admin.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { _ } from "$lib/i18n";
	import Dialog from "$lib/components/ui/Dialog.svelte";

	let canManageSettings = $derived(authStore.can("manage:settings"));
</script>

<Dialog open={adminStore.showDialog} onClose={() => adminStore.close()} title={$_("adminDialog.title")} size="sm">
	{#if !canManageSettings}
		<section class="admin-locked-panel" aria-label={$_("adminDialog.lockedLabel")}>
			<strong>{$_("adminDialog.lockedTitle")}</strong>
			<p>{adminStore.saveMessage || $_("adminDialog.lockedBody")}</p>
			<small>{$_("adminDialog.lockedHint")}</small>
		</section>
	{:else}
		{#if adminStore.saveMessage}
			<div
				class="admin-alert"
				class:admin-alert-success={!adminStore.saveError}
				class:admin-alert-error={adminStore.saveError}
				role="status"
			>
				<span>{adminStore.saveMessage}</span>
			</div>
		{/if}
		<label class="admin-toggle-row">
			<input type="checkbox" class="admin-toggle"
				checked={adminStore.config.chatgptEnabled}
				onchange={() => adminStore.updateField("chatgptEnabled", !adminStore.config.chatgptEnabled)}
			/>
			<span>{$_("adminDialog.chatgptPrimary")}</span>
		</label>
		<label class="admin-toggle-row">
			<input type="checkbox" class="admin-toggle"
				checked={adminStore.config.openrouterEnabled}
				onchange={() => adminStore.updateField("openrouterEnabled", !adminStore.config.openrouterEnabled)}
			/>
			<span>{$_("adminDialog.openrouterFallback")}</span>
		</label>
		<label class="admin-field">
			<span class="admin-field-label">{$_("adminDialog.openrouterApiKey")}</span>
			<input
				id="or-api-key"
				type="password"
				class="admin-input"
				placeholder={$_("adminDialog.openrouterApiKeyPlaceholder")}
				value={adminStore.config.openrouterApiKey}
				oninput={(e) => adminStore.updateField("openrouterApiKey", (e.target as HTMLInputElement).value)}
			/>
		</label>
	{/if}

	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ws-dialog-btn admin-action" onclick={() => adminStore.close()}>{$_("adminDialog.cancel")}</button>
		{#if canManageSettings}
			{#if adminStore.isSaving}
				<span class="ws-dialog-btn ws-dialog-btn-primary ws-dialog-receipt admin-action" aria-label={$_("adminDialog.savingStatusLabel")}>
					<span class="spinner-xs"></span>
					{$_("adminDialog.saving")}
				</span>
			{:else}
				<button type="button" class="ws-dialog-btn ws-dialog-btn-primary admin-action" onclick={() => void adminStore.save()}>
					{$_("adminDialog.save")}
				</button>
			{/if}
		{/if}
	{/snippet}
</Dialog>

<style>
	.spinner-xs {
		display: inline-block;
		width: 12px;
		height: 12px;
		margin-right: 6px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.admin-alert {
		display: flex;
		align-items: center;
		min-height: 44px;
		margin-bottom: 14px;
		padding: 10px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-text);
		font-size: 13px;
	}

	.admin-alert-success {
		border-color: rgba(52, 211, 153, 0.42);
		background: rgba(52, 211, 153, 0.1);
		color: #b9f5dd;
	}

	.admin-alert-error {
		border-color: rgba(251, 113, 133, 0.45);
		background: rgba(251, 113, 133, 0.12);
		color: #ffd0d8;
	}

	.admin-toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		margin-bottom: 8px;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
	}

	.admin-toggle {
		flex: 0 0 auto;
		width: 44px;
		height: 24px;
		min-height: 24px;
		appearance: none;
		border-radius: 999px;
		border: 1px solid var(--ws-hair-strong);
		background: rgba(255, 255, 255, 0.06);
		cursor: pointer;
		position: relative;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.admin-toggle::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #cfcfdb;
		transition: transform 0.15s ease, background 0.15s ease;
	}

	.admin-toggle:checked {
		border-color: rgba(124, 92, 255, 0.6);
		background: linear-gradient(100deg, #8b5cf6 0%, #d946ef 100%);
	}

	.admin-toggle:checked::after {
		transform: translateX(20px);
		background: #fff;
	}

	.admin-toggle:focus-visible {
		outline: 2px solid rgba(124, 92, 255, 0.6);
		outline-offset: 2px;
	}

	.admin-field {
		display: grid;
		gap: 6px;
		margin-top: 6px;
	}

	.admin-field-label {
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 700;
	}

	.admin-input {
		width: 100%;
		min-height: 42px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(4, 7, 12, 0.6);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
	}

	.admin-input:focus {
		outline: none;
		border-color: rgba(124, 92, 255, 0.6);
		box-shadow: 0 0 0 1px rgba(124, 92, 255, 0.3);
	}

	.admin-locked-panel {
		display: grid;
		gap: 8px;
		padding: 16px;
		border: 1px solid rgba(124, 92, 255, 0.24);
		border-radius: var(--radius-ws-ctrl, 10px);
		background:
			linear-gradient(135deg, rgba(124, 92, 255, 0.12), rgba(217, 70, 239, 0.06)),
			rgba(20, 20, 27, 0.78);
	}

	.admin-locked-panel strong {
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 800;
	}

	.admin-locked-panel p,
	.admin-locked-panel small {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 12px;
		line-height: 1.45;
	}

	.admin-action {
		min-height: 42px;
	}
</style>
