<script lang="ts">
	import { _ } from "$lib/i18n";
	import { evaluatePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordRule } from "$lib/auth/password-policy.ts";

	interface Props {
		password: string;
		/** Minimum length required by backend policy (default matches the backend default). */
		minLength?: number;
		/** Maximum length accepted by backend policy (default matches the backend default). */
		maxLength?: number;
	}

	let { password, minLength = PASSWORD_MIN_LENGTH, maxLength = PASSWORD_MAX_LENGTH }: Props = $props();

	// Localized strength labels keyed by score (1..4); index 0 is the empty state.
	const STRENGTH_KEYS = ["", "strengthWeak", "strengthFair", "strengthGood", "strengthStrong"] as const;

	function scorePassword(pw: string, min: number, max: number): { score: 0 | 1 | 2 | 3 | 4; checks: PasswordRule[] } {
		// Reuse the shared policy so the meter, the inline error, and the backend stay in lockstep.
		const checks = evaluatePassword(pw, min, max).rules;
		const passed = checks.filter((c) => c.ok).length;
		// score 0 = empty, then scale 1..4 RELATIVE to the live rule count: "Strong"
		// requires EVERY rule to pass (a fixed `passed > 4` threshold went stale the
		// moment the maxlength rule made it 6 rules — a blocked password could read
		// Strong; review #587 r2). Anything missing a rule caps at Good.
		let score: 0 | 1 | 2 | 3 | 4 = 0;
		if (pw.length === 0) score = 0;
		else if (passed >= checks.length) score = 4;
		else if (passed >= checks.length - 2) score = 3;
		else if (passed >= 2) score = 2;
		else score = 1;
		return { score, checks };
	}

	let result = $derived(scorePassword(password, minLength, maxLength));
	// Rule labels live in the i18n catalog keyed by the stable rule id; length rules
	// interpolate the active minimum/maximum.
	function ruleLabel(id: PasswordRule["id"]): string {
		return $_(`passwordPolicy.rule_${id}`, { values: { n: id === "maxlength" ? maxLength : minLength } });
	}
</script>

<div class="pw-meter" aria-live="polite">
	<div class="pw-track" aria-hidden="true">
		{#each [1, 2, 3, 4] as i (i)}
			<span class="pw-pip" class:active={result.score >= i} data-level={result.score}></span>
		{/each}
	</div>
	{#if result.score > 0}
		<div class="pw-summary">
			<span class="pw-label">{$_("passwordPolicy.strengthLabel", { values: { strength: $_(`passwordPolicy.${STRENGTH_KEYS[result.score]}`) } })}</span>
		</div>
	{/if}
	<ul class="pw-checks">
		{#each result.checks as check (check.id)}
			<li class:ok={check.ok}>
				<span aria-hidden="true">{check.ok ? "✓" : "•"}</span>
				{ruleLabel(check.id)}
			</li>
		{/each}
	</ul>
</div>

<style>
	.pw-meter {
		display: grid;
		gap: 6px;
	}
	.pw-track {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 4px;
	}
	.pw-pip {
		height: 4px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 78%, transparent);
	}
	.pw-pip.active[data-level="1"] { background: var(--color-ws-rose); }
	.pw-pip.active[data-level="2"] { background: var(--color-ws-amber); }
	.pw-pip.active[data-level="3"] { background: var(--color-ws-cyan); }
	.pw-pip.active[data-level="4"] { background: var(--color-ws-green); }

	.pw-summary {
		font-size: 11.5px;
		color: var(--color-ws-text);
	}
	.pw-label {
		font-weight: 600;
	}

	.pw-checks {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px 12px;
		margin: 2px 0 0;
		padding: 0;
		list-style: none;
		font-size: 11.5px;
		color: var(--color-ws-faint);
	}
	.pw-checks li {
		display: inline-flex;
		gap: 6px;
		align-items: center;
	}
	.pw-checks li.ok {
		color: color-mix(in srgb, var(--color-ws-green) 72%, var(--color-ws-ink));
	}
	.pw-checks li span {
		display: inline-grid;
		place-items: center;
		width: 14px;
		height: 14px;
		font-size: 10px;
		font-weight: 800;
	}

	:global(html[data-theme="light"]) .pw-pip { background: color-mix(in srgb, var(--color-ws-bg) 10%, transparent); }
	:global(html[data-theme="light"]) .pw-summary { color: color-mix(in srgb, var(--color-ws-bg) 58%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .pw-checks { color: color-mix(in srgb, var(--color-ws-bg) 48%, var(--color-ws-text)); }
	:global(html[data-theme="light"]) .pw-checks li.ok { color: color-mix(in srgb, var(--color-ws-green) 68%, var(--color-ws-bg)); }
</style>
