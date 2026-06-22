<!--
  Segmented OTP input: `length` single-character boxes that behave like every modern
  one-time-code field. Types auto-advance, Backspace on an empty box steps back and clears
  the previous one, ⬅/➡/Home/End navigate, and a paste (or iOS one-time-code autofill into
  the first box) distributes its digits across the boxes. `value` is bindable (digits only,
  capped at `length`); `onComplete` fires when the last digit lands.
-->
<script lang="ts">
	import { _ } from "$lib/i18n";

	interface Props {
		/** Bindable combined code (digits only, length-capped). */
		value?: string;
		length?: number;
		disabled?: boolean;
		autofocus?: boolean;
		invalid?: boolean;
		ariaLabel?: string;
		/** Fired when all `length` digits are present (e.g. to auto-submit). */
		onComplete?: (code: string) => void;
	}
	let {
		value = $bindable(""),
		length = 6,
		disabled = false,
		autofocus = false,
		invalid = false,
		ariaLabel = undefined,
		onComplete,
	}: Props = $props();

	// Localized fallback for the group aria-label when the caller omits one.
	let effectiveAriaLabel = $derived(ariaLabel ?? $_("otpInput.ariaLabel"));

	let inputs = $state<HTMLInputElement[]>([]);
	// Per-box source of truth. A plain string can't represent an empty MIDDLE slot (joining
	// collapses it and shifts later digits left), so each box keeps its own char and `value`
	// is derived from them. This is what stops "1234" + correct-the-3 from scrambling.
	let digits = $state<string[]>(Array.from({ length }, (_, i) => value[i] ?? ""));

	// Resync when the PARENT changes value externally (reset / programmatic set). Guarded so it
	// never fights our own writes (after commitDigits, value === digits.join("")).
	$effect(() => {
		if (value !== digits.join("")) {
			digits = Array.from({ length }, (_, i) => value[i] ?? "");
		}
	});

	function commitDigits(next: string[]): void {
		digits = next;
		value = next.join("");
		if (next.every((d) => d !== "")) onComplete?.(value);
	}

	function focusBox(i: number): void {
		const el = inputs[Math.max(0, Math.min(length - 1, i))];
		if (el) {
			el.focus();
			el.select();
		}
	}

	/** Fill boxes with pasted/autofilled `raw`. A FULL-length code is the whole thing — write it
	 *  from box 0 over a cleared field regardless of which box was focused, so pasting a complete
	 *  code into a later box can't strand earlier digits or drop the tail. A shorter paste fills
	 *  from `start`, keeping the other boxes. */
	function distributeFrom(start: number, raw: string): void {
		const incoming = raw.replace(/\D/g, "");
		if (!incoming) return;
		const wholeCode = incoming.length >= length;
		const from = wholeCode ? 0 : start;
		const next = wholeCode ? Array.from({ length }, () => "") : digits.slice();
		let i = from;
		for (const d of incoming) {
			if (i >= length) break;
			next[i] = d;
			i += 1;
		}
		commitDigits(next);
		focusBox(Math.min(i, length - 1));
	}

	function handleInput(i: number, event: Event): void {
		const el = event.target as HTMLInputElement;
		const typed = el.value.replace(/\D/g, "");
		if (typed.length <= 1) {
			// Set THIS box only — empty slots stay put (no left-shift on a mid-box correction).
			const next = digits.slice();
			next[i] = typed; // "" on delete, one digit on type
			commitDigits(next);
			el.value = typed;
			if (typed && i < length - 1) focusBox(i + 1);
			return;
		}
		// More than one char reached a single box (paste into it, or fast IME) → distribute.
		distributeFrom(i, typed);
	}

	function handleKeydown(i: number, event: KeyboardEvent): void {
		switch (event.key) {
			case "Backspace":
				if (!digits[i] && i > 0) {
					// Already-empty box: step back and clear the previous digit.
					event.preventDefault();
					const next = digits.slice();
					next[i - 1] = "";
					commitDigits(next);
					focusBox(i - 1);
				}
				// A filled box: let the browser delete; handleInput clears digits[i] and we stay.
				break;
			case "ArrowLeft":
				if (i > 0) {
					event.preventDefault();
					focusBox(i - 1);
				}
				break;
			case "ArrowRight":
				if (i < length - 1) {
					event.preventDefault();
					focusBox(i + 1);
				}
				break;
			case "Home":
				event.preventDefault();
				focusBox(0);
				break;
			case "End":
				event.preventDefault();
				focusBox(length - 1);
				break;
		}
	}

	function handlePaste(i: number, event: ClipboardEvent): void {
		event.preventDefault();
		distributeFrom(i, event.clipboardData?.getData("text") ?? "");
	}

	$effect(() => {
		if (autofocus && inputs[0]) inputs[0].focus();
	});
</script>

<div class="otp-group" role="group" aria-label={effectiveAriaLabel}>
	{#each Array(length) as _cell, i (i)}
		<input
			bind:this={inputs[i]}
			class="otp-box"
			class:filled={Boolean(digits[i])}
			class:invalid
			type="text"
			inputmode="numeric"
			autocomplete={i === 0 ? "one-time-code" : "off"}
			maxlength={i === 0 ? length : 1}
			value={digits[i] ?? ""}
			{disabled}
			aria-label={$_("otpInput.digitAriaLabel", { values: { label: effectiveAriaLabel, n: i + 1 } })}
			oninput={(e) => handleInput(i, e)}
			onkeydown={(e) => handleKeydown(i, e)}
			onpaste={(e) => handlePaste(i, e)}
			onfocus={(e) => (e.target as HTMLInputElement).select()}
		/>
	{/each}
</div>

<style>
	.otp-group {
		display: flex;
		gap: 10px;
		justify-content: center;
		margin: 4px 0 14px;
	}
	.otp-box {
		width: 48px;
		height: 56px;
		padding: 0;
		text-align: center;
		font-size: 26px;
		font-weight: 650;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--color-ws-ink);
		background: color-mix(in srgb, var(--color-ws-surface2) 60%, transparent);
		border: 1.5px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		outline: none;
		caret-color: var(--color-ws-accent);
		transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
		-moz-appearance: textfield;
	}
	.otp-box::-webkit-outer-spin-button,
	.otp-box::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}
	.otp-box.filled {
		border-color: color-mix(in srgb, var(--color-ws-accent) 54%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface2) 84%, transparent);
	}
	.otp-box:focus {
		border-color: color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
		box-shadow: var(--ws-focus-ring);
	}
	.otp-box.invalid {
		border-color: var(--color-ws-rose);
	}
	.otp-box.invalid:focus {
		box-shadow: 0 0 0 2px var(--color-ws-bg), 0 0 0 4px color-mix(in srgb, var(--color-ws-rose) 70%, transparent);
	}
	.otp-box:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	@media (max-width: 420px) {
		.otp-group {
			gap: 7px;
		}
		.otp-box {
			width: 42px;
			height: 50px;
			font-size: 22px;
		}
	}
</style>
