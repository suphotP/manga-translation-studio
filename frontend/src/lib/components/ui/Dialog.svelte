<!-- Dialog — shared modal atom for the ws design system (W3.4).

	Behavior-preserving chrome extracted from ChapterSetupDialog so every editor
	dialog/picker shares one focus-trap + scrim + header/body/footer shell:
	  - role="dialog" (or alertdialog) + aria-modal, labelled by an internal title
	    or a caller-supplied `ariaLabel`
	  - focus moves to the first control on open, is trapped on Tab/Shift+Tab,
	    and is restored to the opener on close
	  - Escape closes (unless `dismissible={false}` or `busy`)
	  - background siblings are made `inert` + aria-hidden, and outside clicks are
	    swallowed while open
	  - backdrop click closes (unless `dismissible={false}` or `busy`)

	Purely presentational/a11y: all state + decision logic stays in the caller,
	which toggles `open` and reacts to `onClose`. ws-* tokens only. -->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { _ } from "$lib/i18n";

	let {
		open,
		onClose,
		ariaLabel,
		ariaLabelledby,
		ariaDescribedby,
		role = "dialog",
		eyebrow = "",
		title = "",
		description = "",
		dismissible = true,
		busy = false,
		autoFocus = true,
		showClose = true,
		closeLabel = undefined,
		size = "md",
		titleId = "ws-dialog-title",
		descriptionId = "ws-dialog-desc",
		class: klass = "",
		panelClass = "",
		header,
		children,
		footer,
	}: {
		/** When true the modal is mounted, trapped, and visible. */
		open: boolean;
		/** Called when the user dismisses via Escape, backdrop, or the close button. */
		onClose: () => void;
		/** aria-label for the dialog when there is no visible `title`. */
		ariaLabel?: string;
		/** id of a visible heading to label the dialog (custom-header case). */
		ariaLabelledby?: string;
		/** id of body copy to describe the dialog (custom-header case, when no `description` prop). */
		ariaDescribedby?: string;
		/** "dialog" for general modals, "alertdialog" for confirmations. */
		role?: "dialog" | "alertdialog";
		eyebrow?: string;
		title?: string;
		description?: string;
		/** When false, Escape/backdrop/close-button do not dismiss. */
		dismissible?: boolean;
		/** When true, dismissal is blocked (e.g. a save in flight). */
		busy?: boolean;
		/** When false, the caller owns initial focus (Tab trap still active). */
		autoFocus?: boolean;
		/** Show the top-right close button in the default header. */
		showClose?: boolean;
		closeLabel?: string;
		size?: "sm" | "md" | "lg" | "xl";
		titleId?: string;
		descriptionId?: string;
		class?: string;
		panelClass?: string;
		/** Replaces the default eyebrow/title/description/close header. */
		header?: Snippet;
		/** Dialog body. */
		children: Snippet;
		/** Footer actions, rendered in the sticky footer row. */
		footer?: Snippet;
	} = $props();

	// Localized fallback for the close-button label when the caller omits one.
	let effectiveCloseLabel = $derived(closeLabel ?? $_("dialog.close"));

	let dialogElement: HTMLDivElement | null = $state(null);
	let modalLayer: HTMLDivElement | null = $state(null);

	const sizeWidth: Record<string, string> = {
		sm: "min(420px, calc(100vw - 32px))",
		md: "min(760px, calc(100vw - 32px))",
		lg: "min(1040px, calc(100vw - 32px))",
		xl: "min(1200px, calc(100vw - 32px))",
	};

	function canDismiss(): boolean {
		return dismissible && !busy;
	}

	function requestClose(): void {
		if (!canDismiss()) return;
		onClose();
	}

	$effect(() => {
		if (!open || !dialogElement) return;

		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const releaseBackgroundOwnership = applyBackgroundModalOwnership();
		const focusFrame = autoFocus ? requestAnimationFrame(() => focusFirstDialogControl()) : 0;

		// The panel is a fixed header/body/footer frame: only `.ws-dialog-body`
		// is meant to scroll. On small screens, focusing (or the browser auto-
		// revealing) a control deep in the body can scroll the `overflow:hidden`
		// PANEL itself — pushing the pinned header/footer off-screen with no way
		// to scroll back. Pin the panel's own scroll to the top so the header and
		// footer stay visible; the body keeps its own internal overflow:auto.
		const panel = dialogElement;
		function pinPanelScroll(): void {
			if (panel.scrollTop !== 0) panel.scrollTop = 0;
			if (panel.scrollLeft !== 0) panel.scrollLeft = 0;
		}
		panel.addEventListener("scroll", pinPanelScroll, { passive: true });

		// A second Dialog opened ON TOP of this one (e.g. a confirmation nested inside
		// a panel) renders its own `.ws-dialog-layer`. This Dialog must then YIELD: its
		// document-level guards (Escape, focus-trap, background-click block) must not
		// steal events that belong to the dialog stacked above it — otherwise the lower
		// dialog's capture-phase `blockBackgroundClick` swallows clicks to the upper
		// dialog's own buttons (a real "nested dialog is dead" bug). `eventInForeignDialog`
		// is true when the event targets a DIFFERENT dialog layer than this one's.
		function eventInForeignDialog(target: EventTarget | null): boolean {
			if (!(target instanceof Node)) return false;
			if (modalLayer?.contains(target)) return false;
			const layer = target instanceof Element
				? target.closest(".ws-dialog-layer")
				: target.parentElement?.closest(".ws-dialog-layer") ?? null;
			return Boolean(layer) && layer !== modalLayer;
		}

		function handleDocumentKeydown(event: KeyboardEvent): void {
			// Defer to a dialog stacked above this one (it owns the keyboard).
			if (eventInForeignDialog(event.target)) return;
			if (event.key === "Escape") {
				if (!canDismiss()) return;
				event.preventDefault();
				requestClose();
				return;
			}
			if (event.key === "Tab") {
				keepTabFocusInsideDialog(event);
			}
		}

		function handleDocumentFocusIn(event: FocusEvent): void {
			const target = event.target;
			if (target instanceof Node && dialogElement?.contains(target)) return;
			// Don't pull focus back when it moved into a dialog stacked above this one.
			if (eventInForeignDialog(target)) return;
			focusFirstDialogControl();
		}

		function blockBackgroundClick(event: MouseEvent): void {
			const target = event.target;
			if (target instanceof Node && modalLayer?.contains(target)) return;
			// A click inside ANOTHER dialog layer (one stacked above this dialog) is NOT
			// a background click — let it through so the upper dialog's controls work.
			if (eventInForeignDialog(target)) return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		}

		document.addEventListener("keydown", handleDocumentKeydown, true);
		document.addEventListener("focusin", handleDocumentFocusIn, true);
		document.addEventListener("click", blockBackgroundClick, true);

		return () => {
			cancelAnimationFrame(focusFrame);
			panel.removeEventListener("scroll", pinPanelScroll);
			document.removeEventListener("keydown", handleDocumentKeydown, true);
			document.removeEventListener("focusin", handleDocumentFocusIn, true);
			document.removeEventListener("click", blockBackgroundClick, true);
			releaseBackgroundOwnership();
			// Restore focus to the opener once the background is interactive again.
			if (previousFocus?.isConnected && !previousFocus.inert) {
				requestAnimationFrame(() => previousFocus.focus());
			}
		};
	});

	function getFocusableDialogControls(): HTMLElement[] {
		if (!dialogElement) return [];
		const controls = dialogElement.querySelectorAll<HTMLElement>(
			"a[href], button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1']), [contenteditable='true']",
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

	function focusFirstDialogControl(): void {
		const [firstControl] = getFocusableDialogControls();
		(firstControl ?? dialogElement)?.focus();
	}

	function keepTabFocusInsideDialog(event: KeyboardEvent): void {
		const controls = getFocusableDialogControls();
		if (!controls.length) {
			event.preventDefault();
			dialogElement?.focus();
			return;
		}
		const firstControl = controls[0];
		const lastControl = controls[controls.length - 1];
		const activeElement = document.activeElement;
		if (event.shiftKey) {
			if (activeElement === firstControl || !dialogElement?.contains(activeElement)) {
				event.preventDefault();
				lastControl.focus();
			}
			return;
		}
		if (activeElement === lastControl || !dialogElement?.contains(activeElement)) {
			event.preventDefault();
			firstControl.focus();
		}
	}

	function applyBackgroundModalOwnership(): () => void {
		const controlledElements: Array<{
			element: HTMLElement;
			inert: boolean;
			ariaHidden: string | null;
		}> = [];
		const candidates: HTMLElement[] = [];

		function addCandidate(element: HTMLElement): void {
			if (!candidates.includes(element)) candidates.push(element);
		}

		if (modalLayer?.parentElement) {
			for (const sibling of Array.from(modalLayer.parentElement.children)) {
				if (sibling instanceof HTMLElement && sibling !== modalLayer) addCandidate(sibling);
			}
		}
		if (document.body && modalLayer) {
			for (const child of Array.from(document.body.children)) {
				if (child instanceof HTMLElement && child !== modalLayer && !child.contains(modalLayer)) {
					addCandidate(child);
				}
			}
		}

		for (const element of candidates) {
			if (["SCRIPT", "STYLE"].includes(element.tagName)) continue;
			controlledElements.push({
				element,
				inert: Boolean(element.inert),
				ariaHidden: element.getAttribute("aria-hidden"),
			});
			element.inert = true;
			element.setAttribute("aria-hidden", "true");
		}

		return () => {
			for (const item of controlledElements) {
				item.element.inert = item.inert;
				if (item.ariaHidden === null) {
					item.element.removeAttribute("aria-hidden");
				} else {
					item.element.setAttribute("aria-hidden", item.ariaHidden);
				}
			}
		};
	}

	function onBackdropClick(): void {
		requestClose();
	}
</script>

{#if open}
	<div class={`ws-dialog-layer ${klass}`} bind:this={modalLayer}>
		<div class="ws-dialog-backdrop" role="presentation" onclick={onBackdropClick}></div>
		<div
			class={`ws-dialog-panel ws-panel ws-sans ${panelClass}`}
			style={`--ws-dialog-w: ${sizeWidth[size] ?? sizeWidth.md};`}
			{role}
			aria-modal="true"
			aria-label={title || ariaLabelledby ? undefined : ariaLabel}
			aria-labelledby={title ? titleId : ariaLabelledby}
			aria-describedby={description ? descriptionId : ariaDescribedby}
			tabindex="-1"
			bind:this={dialogElement}
		>
			{#if header}
				{@render header()}
			{:else if eyebrow || title || description}
				<header class="ws-dialog-header">
					<div class="ws-dialog-heading">
						{#if eyebrow}<span class="ws-dialog-eyebrow">{eyebrow}</span>{/if}
						{#if title}<h2 id={titleId} class="ws-dialog-title">{title}</h2>{/if}
						{#if description}<p id={descriptionId} class="ws-dialog-desc">{description}</p>{/if}
					</div>
				</header>
			{/if}

			<div class="ws-dialog-body">
				{@render children()}
			</div>

			{#if footer}
				<footer class="ws-dialog-footer">
					{@render footer()}
				</footer>
			{/if}

			<!-- Rendered last so the first body control receives initial focus and the
				close button sits at the end of the tab order; positioned into the
				header corner via CSS. -->
			{#if showClose && dismissible}
				<button
					type="button"
					class="ws-dialog-close"
					aria-label={effectiveCloseLabel}
					onclick={requestClose}
					disabled={busy}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
						<path d="M6 6 18 18M18 6 6 18" />
					</svg>
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* A modal Dialog must sit ABOVE the cookie-consent banner (z-index 2000) and
	   the onboarding-tour overlay (z-index 1900) — otherwise the banner covers the
	   chapter-setup dialog and steals its clicks. Backdrop 2100 / panel 2101. */
	.ws-dialog-layer {
		position: fixed;
		inset: 0;
		z-index: 2100;
		pointer-events: none;
	}

	.ws-dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2100;
		background: rgba(6, 8, 14, 0.7);
		backdrop-filter: blur(12px);
		pointer-events: auto;
	}

	.ws-dialog-panel {
		position: fixed;
		z-index: 2101;
		top: 50%;
		left: 50%;
		display: flex;
		flex-direction: column;
		width: var(--ws-dialog-w, min(760px, calc(100vw - 32px)));
		max-height: calc(100vh - 48px);
		overflow: hidden;
		transform: translate(-50%, -50%);
		border-radius: var(--radius-ws-card, 12px);
		background: #15151d;
		color: var(--color-ws-ink);
		box-shadow: 0 28px 80px -24px rgba(0, 0, 0, 0.8), 0 1px 0 rgba(255, 255, 255, 0.03) inset;
		pointer-events: auto;
	}

	.ws-dialog-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		/* trailing padding-right reserves room for the absolutely-positioned close button */
		padding: 18px 64px 14px 18px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.ws-dialog-heading {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.ws-dialog-eyebrow {
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.ws-dialog-title {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 22px;
		font-weight: 800;
		line-height: 1.12;
	}

	.ws-dialog-desc {
		margin: 0;
		max-width: 64ch;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.5;
	}

	.ws-dialog-close {
		position: absolute;
		top: 14px;
		right: 14px;
		z-index: 2;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.03);
		color: var(--color-ws-text);
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.ws-dialog-close:hover {
		border-color: var(--ws-hair-strong);
		background: rgba(255, 255, 255, 0.06);
		color: var(--color-ws-ink);
	}

	.ws-dialog-close:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.ws-dialog-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		padding: 18px;
		scrollbar-width: thin;
	}

	.ws-dialog-footer {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		padding: 14px 18px;
		border-top: 1px solid var(--ws-hair);
	}

	@media (max-width: 760px) {
		.ws-dialog-title {
			font-size: 19px;
		}

		.ws-dialog-footer {
			flex-direction: column-reverse;
			align-items: stretch;
		}
	}
</style>
