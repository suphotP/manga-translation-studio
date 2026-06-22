// AI-support — the trigger that fires the gpt-5.5 agent after a customer message.
//
// Two entry points:
//   maybeTriggerSupportAgent(...) — the FIRE-AND-FORGET hook the customer-reply flow
//     calls after a customer addMessage. It returns immediately so the HTTP request
//     stays fast: the agent runs detached (awaited inside a .catch so an error never
//     becomes an unhandled rejection). It is gated on the kill-switch (aiSupportEnabled)
//     so a disabled agent costs nothing.
//   triggerSupportAgentNow(...) — the AWAITED variant the explicit
//     POST /ai-respond endpoint uses so it can report the outcome to the caller.
//
// Both ultimately call runSupportAgent, which itself runs the MANDATORY admission
// gate before any model call. The kill-switch check here is a cheap early-out; the
// agent re-checks the full guardrail ladder.

import { loadConfig } from "../../config.js";
import { runSupportAgent, type RunSupportAgentInput, type SupportAgentResult } from "./ai-agent.js";

/** True when the operator kill-switch leaves the agent enabled. Fail-closed on a read error. */
export function isSupportAgentEnabled(): boolean {
	try {
		return loadConfig().aiSupportEnabled;
	} catch {
		return false;
	}
}

/**
 * Fire the agent without blocking the caller. No-op when the kill-switch is off. The
 * agent run is fully detached and self-contained (never throws to the caller); we
 * still .catch the promise so a rejection can never surface as an unhandled rejection.
 */
export function maybeTriggerSupportAgent(input: RunSupportAgentInput): void {
	if (!isSupportAgentEnabled()) return;
	runSupportAgent(input).catch((error) => {
		console.warn(`[support-agent] detached run failed for ${input.ticketId}: ${error instanceof Error ? error.message : String(error)}`);
	});
}

/**
 * Awaited variant for the explicit re-trigger endpoint. Returns a typed result (or a
 * `disabled` result when the kill-switch is off) so the route can respond accordingly.
 */
export async function triggerSupportAgentNow(input: RunSupportAgentInput): Promise<SupportAgentResult> {
	if (!isSupportAgentEnabled()) {
		return { kind: "disabled", tokensSpent: 0, detail: "AI support is disabled by the operator kill-switch." };
	}
	return runSupportAgent(input);
}
