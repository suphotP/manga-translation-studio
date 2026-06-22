// Workspace FREEZE (suspension) reflection store.
//
// The backend is the HARD gate: a frozen workspace (verified refund/chargeback, or
// an admin suspension) returns 403 `workspace_suspended` on EVERY mutating request.
// This store is the UI REFLECTION of that gate — it flips on the moment ANY API call
// returns that code (wired in api/client.ts:buildApiError) so the dashboard can show a
// prominent restore banner and disable edit/create controls. The 403 remains the real
// enforcement; this store only mirrors it (it can never grant access).
class WorkspaceSuspensionStore {
	/** True once a `workspace_suspended` 403 has been observed this session. */
	suspended = $state(false);
	/** The reason the backend reported, if any: 'payment_refund' | 'chargeback' | 'admin'. */
	reason = $state<string | null>(null);

	/** Called by the API client when a 403 carries code `workspace_suspended`. */
	markSuspended(reason?: string | null): void {
		this.suspended = true;
		if (typeof reason === "string" && reason) this.reason = reason;
	}

	/**
	 * Clear the reflected state — call after a successful re-payment / admin unfreeze,
	 * or on workspace switch, so a recovered workspace stops showing the banner. The
	 * next mutating request re-asserts the truth (it will 403 again if still frozen).
	 */
	clear(): void {
		this.suspended = false;
		this.reason = null;
	}
}

export const workspaceSuspension = new WorkspaceSuspensionStore();
