// Shared Bun.SQL pool registry.
//
// Every Postgres-backed store/service used to construct its OWN `new Bun.SQL(url)`
// — 40+ module-level pools at ~10 connections each, which exhausted Postgres
// (`sorry, too many clients already`, default max_connections=100) the moment
// enough subsystems had seen traffic. One process now holds ONE pool per
// distinct connection string, sized explicitly.
//
// Rules for callers:
//  - NEVER call .close() on a pool obtained here — it is shared by the whole
//    process. Standalone scripts / the migrations CLI that legitimately close
//    their client keep constructing private `new Bun.SQL(...)` instances.
//  - Constructor-injected fake clients in tests are unaffected; only the
//    "default: build from DATABASE_URL" paths route through here.

const pools = new Map<string, Bun.SQL>();

/** Per-pool connection cap. One shared pool serves the whole process, so this
 *  bounds the process's Postgres footprint (default 20; override for prod). */
function poolMax(): number {
	const parsed = Number.parseInt(process.env.PG_POOL_MAX || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

export function getSharedBunSql(databaseUrl: string = process.env.DATABASE_URL ?? ""): Bun.SQL {
	const url = databaseUrl.trim();
	if (!url) {
		throw new Error("DATABASE_URL is required for a Postgres-backed store");
	}
	let pool = pools.get(url);
	if (!pool) {
		pool = new Bun.SQL(url, { max: poolMax() });
		pools.set(url, pool);
	}
	return pool;
}

/** Test-only: drop cached pools (closing them) so suites can re-point DATABASE_URL. */
export async function resetSharedBunSqlForTesting(): Promise<void> {
	const closing = Array.from(pools.values());
	pools.clear();
	await Promise.all(closing.map(async (pool) => {
		try {
			await pool.close();
		} catch {/* already closed */}
	}));
}
