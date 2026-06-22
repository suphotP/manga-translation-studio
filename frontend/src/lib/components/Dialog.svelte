<!-- Dialog — shared accessible modal helpers.

	Many editor/admin/auth modals already ship bespoke markup + styling and only
	declare `role="dialog"`/`aria-modal` WITHOUT real focus management, so keyboard
	and screen-reader users get stuck (focus escapes behind the blocking dialog,
	Escape is ignored, focus is never restored to the opener). Migrating each to the
	`ui/Dialog.svelte` panel shell would rewrite their styling, which we must NOT do.

	This file exposes a headless `dialogFocus` Svelte action (from `<script module>`)
	carrying the SAME battle-tested behavior as `ui/Dialog.svelte`:
	  - move initial focus to the first control on open (unless autoFocus=false),
	  - trap Tab/Shift+Tab inside the dialog,
	  - pull focus back when it escapes to a background element,
	  - close on Escape (unless dismissible=false or busy),
	  - make background siblings `inert` + aria-hidden and swallow background clicks,
	  - restore focus to the opener on close.

	Apply it to the DIALOG PANEL element (the `role="dialog"` node), passing the
	caller's close handler + flags. Markup, classes, and styling are untouched.

	`use:dialogFocus={{ active, onEscape, dismissible, busy, autoFocus }}`

	The component default export renders nothing on its own; callers import the
	action: `import { dialogFocus } from "$lib/components/Dialog.svelte"`. -->
<script module lang="ts">
	export interface DialogFocusOptions {
		/** When false the trap is inert (e.g. the dialog is conditionally rendered
			but the caller toggles a flag); defaults to true. */
		active?: boolean;
		/** Called when the user presses Escape (and dismissal is allowed). */
		onEscape?: () => void;
		/** When false, Escape does not dismiss (focus trap stays active). */
		dismissible?: boolean;
		/** When true, dismissal is blocked (e.g. a save/recovery in flight). */
		busy?: boolean;
		/** When false the caller owns initial focus; the Tab trap still applies. */
		autoFocus?: boolean;
	}

	function getFocusableControls(root: HTMLElement): HTMLElement[] {
		const controls = root.querySelectorAll<HTMLElement>(
			"a[href], button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1']), [contenteditable='true']",
		);
		return Array.from(controls).filter((control) => {
			const disabled = "disabled" in control && Boolean((control as HTMLButtonElement).disabled);
			const style = window.getComputedStyle(control);
			return (
				!disabled
				&& control.getAttribute("aria-hidden") !== "true"
				&& control.tabIndex >= 0
				&& style.display !== "none"
				&& style.visibility !== "hidden"
			);
		});
	}

	function focusFirstControl(root: HTMLElement): void {
		const [first] = getFocusableControls(root);
		(first ?? root).focus();
	}

	function keepTabInside(root: HTMLElement, event: KeyboardEvent): void {
		const controls = getFocusableControls(root);
		if (!controls.length) {
			event.preventDefault();
			root.focus();
			return;
		}
		const first = controls[0];
		const last = controls[controls.length - 1];
		const active = document.activeElement;
		if (event.shiftKey) {
			if (active === first || !root.contains(active)) {
				event.preventDefault();
				last.focus();
			}
			return;
		}
		if (active === last || !root.contains(active)) {
			event.preventDefault();
			first.focus();
		}
	}

	function applyBackgroundOwnership(root: HTMLElement): () => void {
		const controlled: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
		const candidates: HTMLElement[] = [];
		const addCandidate = (element: HTMLElement): void => {
			if (!candidates.includes(element)) candidates.push(element);
		};

		// The dialog panel may be nested (its own backdrop/layer wrapper). Walk up to
		// the body and neutralize every top-level sibling that does NOT contain the
		// dialog, plus the dialog's own immediate siblings, mirroring ui/Dialog.
		if (root.parentElement) {
			for (const sibling of Array.from(root.parentElement.children)) {
				if (sibling instanceof HTMLElement && !sibling.contains(root)) addCandidate(sibling);
			}
		}
		if (document.body) {
			for (const child of Array.from(document.body.children)) {
				if (child instanceof HTMLElement && !child.contains(root)) addCandidate(child);
			}
		}

		for (const element of candidates) {
			if (["SCRIPT", "STYLE"].includes(element.tagName)) continue;
			controlled.push({
				element,
				inert: Boolean(element.inert),
				ariaHidden: element.getAttribute("aria-hidden"),
			});
			element.inert = true;
			element.setAttribute("aria-hidden", "true");
		}

		return () => {
			for (const item of controlled) {
				item.element.inert = item.inert;
				if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
				else item.element.setAttribute("aria-hidden", item.ariaHidden);
			}
		};
	}

	/**
	 * Svelte action: traps focus, manages Escape, neutralizes the background, and
	 * restores focus to the opener — applied to a bespoke dialog panel element so
	 * its existing markup/styling are preserved. Mirrors `ui/Dialog.svelte`.
	 */
	export function dialogFocus(node: HTMLElement, options: DialogFocusOptions = {}) {
		let current: DialogFocusOptions = options;
		let cleanup: (() => void) | null = null;

		const canDismiss = (): boolean => current.dismissible !== false && !current.busy;

		function activate(): void {
			if (cleanup) return;
			const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			const releaseBackground = applyBackgroundOwnership(node);
			const focusFrame = current.autoFocus === false ? 0 : requestAnimationFrame(() => focusFirstControl(node));

			function handleKeydown(event: KeyboardEvent): void {
				if (event.key === "Escape") {
					if (!canDismiss()) return;
					event.preventDefault();
					current.onEscape?.();
					return;
				}
				if (event.key === "Tab") keepTabInside(node, event);
			}

			function handleFocusIn(event: FocusEvent): void {
				const target = event.target;
				if (target instanceof Node && node.contains(target)) return;
				focusFirstControl(node);
			}

			function blockBackgroundClick(event: MouseEvent): void {
				const target = event.target;
				if (target instanceof Node && node.contains(target)) return;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}

			document.addEventListener("keydown", handleKeydown, true);
			document.addEventListener("focusin", handleFocusIn, true);
			document.addEventListener("click", blockBackgroundClick, true);

			cleanup = () => {
				cleanup = null;
				cancelAnimationFrame(focusFrame);
				document.removeEventListener("keydown", handleKeydown, true);
				document.removeEventListener("focusin", handleFocusIn, true);
				document.removeEventListener("click", blockBackgroundClick, true);
				releaseBackground();
				// Restore focus to the opener once the background is interactive again.
				if (previousFocus?.isConnected && !previousFocus.inert) {
					requestAnimationFrame(() => previousFocus.focus());
				}
			};
		}

		function sync(): void {
			if (current.active === false) cleanup?.();
			else activate();
		}

		sync();

		return {
			update(next: DialogFocusOptions = {}) {
				current = next;
				sync();
			},
			destroy() {
				cleanup?.();
			},
		};
	}
</script>
