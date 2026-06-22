// Canonical page lock id — the SINGLE source of truth for the (scope=page)
// lock subject id shared by EVERY producer and consumer of a page soft-lease.
//
// Why this exists: the lease store ACQUIRES a page lock and the presence UI
// (LockOwnerIndicator) + multi-page gate (editor store) LOOK IT UP. If the
// acquire id and the lookup id disagree by even one separator the new lease is
// invisible to the old UI and never blocks a second editor. The backend already
// keys page locks on this exact shape (`${projectId}:page:${pageIndex}`, see
// backend/src/routes/locks.ts resolveLockSubject → page_id), so this is also the
// scopeId carried on the SSE lock_acquired/lock_released events the locks store
// matches on. Derive the id ONLY through this helper so acquire == lookup, always.
export function pageLockId(projectId: string, pageIndex: number): string {
	return `${projectId}:page:${pageIndex}`;
}
